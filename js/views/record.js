/* Record view — capture, live transcript, save.
 *
 * The live session is module state, not view state, so switching to Library
 * mid-meeting does not stop the recording. The session emits a single
 * `summary:session` window event whenever anything changes and the mounted
 * view re-renders from that, which keeps the two decoupled across remounts.
 */

import { el, fmtClock, haptic, icon } from '../util.js';
import { banner, confirmSheet, toast } from '../ui.js';
import { Recorder, isSupported as recorderSupported } from '../recorder.js';
import { Transcriber, assignSpeakers, mergeSegments, isSupported as asrSupported } from '../asr.js';
import { getSettings } from '../settings.js';
import { newMeeting, saveAudio, saveMeeting, requestPersistence } from '../db.js';
import { analyzeMeeting, hasKey } from '../ai.js';
import { analyzeLocally } from '../local-summary.js';

const LEVEL_BARS = 72;

let session = null;
let levels = new Array(LEVEL_BARS).fill(0);
let source = 'mic';

const emit = () => window.dispatchEvent(new CustomEvent('summary:session'));

export function isRecording() {
  return Boolean(session) && (session.recorder.state === 'recording' || session.recorder.state === 'paused');
}

/* ------------------------------------------------------------- session -- */

async function startSession() {
  const prefs = getSettings();
  const wantAudio = prefs.captureMode !== 'transcript' && recorderSupported();
  const wantText = prefs.captureMode !== 'audio' && asrSupported();

  const recorder = new Recorder();
  session = {
    recorder,
    transcriber: null,
    segments: [],
    interim: '',
    listening: false,
    source,
    language: prefs.language,
    error: '',
  };

  try {
    await recorder.start({ captureAudio: wantAudio });
  } catch (err) {
    session = null;
    emit();
    const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
    toast(denied
      ? 'Microphone access was denied. Allow it in the browser site settings and try again.'
      : `Could not start the microphone: ${err?.message || err}`, 'err');
    return;
  }

  requestPersistence();
  haptic([12, 40, 12]);

  recorder.addEventListener('level', (e) => {
    levels.push(e.detail);
    levels.shift();
  });
  recorder.addEventListener('statechange', emit);

  if (wantText) {
    const transcriber = new Transcriber({ clock: () => recorder.elapsed(), lang: session.language });
    transcriber.addEventListener('final', (e) => {
      session.segments.push(e.detail);
      session.interim = '';
      emit();
    });
    transcriber.addEventListener('interim', (e) => {
      session.interim = e.detail;
      emit();
    });
    transcriber.addEventListener('statechange', (e) => {
      session.listening = e.detail.listening;
      emit();
    });
    transcriber.addEventListener('error', (e) => {
      toast(e.detail.message, e.detail.fatal ? 'err' : '');
    });
    transcriber.start();
    session.transcriber = transcriber;
  } else if (!asrSupported() && prefs.captureMode !== 'audio') {
    toast('Live transcription needs Chrome. Recording audio only.', '');
  }

  emit();
}

function togglePause() {
  if (!session) return;
  if (session.recorder.state === 'recording') {
    session.recorder.pause();
    session.transcriber?.pause();
  } else if (session.recorder.state === 'paused') {
    session.recorder.resume();
    session.transcriber?.resume();
  }
  haptic();
  emit();
}

async function discardSession() {
  if (!session) return;
  const ok = await confirmSheet({
    title: 'Discard this recording?',
    body: 'The audio and transcript will be deleted. This cannot be undone.',
    confirmLabel: 'Discard',
    danger: true,
  });
  if (!ok || !session) return;
  session.transcriber?.stop();
  session.recorder.cancel();
  session = null;
  levels = new Array(LEVEL_BARS).fill(0);
  emit();
  toast('Recording discarded.');
}

/** Stop, persist, and hand the new meeting id back to the caller. */
async function stopAndSave() {
  if (!session) return null;
  const active = session;
  active.transcriber?.stop();
  const { blob, durationMs } = await active.recorder.stop();

  // Let a trailing final recognition result land before freezing the text.
  await new Promise((resolve) => setTimeout(resolve, 350));

  let segments = active.segments.slice();
  if (active.interim) {
    segments.push({
      id: `tail-${Date.now()}`,
      start: Math.max(0, durationMs - 1500),
      end: durationMs,
      text: active.interim,
      confidence: null,
      speaker: null,
    });
  }

  const prefs = getSettings();
  if (prefs.autoSpeakers) segments = assignSpeakers(segments, prefs.speakerGapMs);
  segments = mergeSegments(segments);

  if (!segments.length && !blob) {
    session = null;
    levels = new Array(LEVEL_BARS).fill(0);
    emit();
    toast('Nothing was captured, so nothing was saved.', 'err');
    return null;
  }

  const keepAudio = Boolean(blob) && prefs.keepAudio;
  const meeting = newMeeting({
    durationMs,
    source: active.source,
    language: active.language,
    segments,
    hasAudio: keepAudio,
    audioType: keepAudio ? blob.type : '',
    audioSize: keepAudio ? blob.size : 0,
  });

  try {
    if (keepAudio) await saveAudio(meeting.id, blob);
    await saveMeeting(meeting);
  } catch (err) {
    toast(`Could not save the recording: ${err?.message || err}`, 'err');
    return null;
  }

  session = null;
  levels = new Array(LEVEL_BARS).fill(0);
  emit();
  haptic([10, 30, 10]);
  return meeting;
}

/* ---------------------------------------------------------------- view -- */

export function mount(root, ctx) {
  const canRecord = recorderSupported();
  const canTranscribe = asrSupported();

  const status = el('div', { class: 'rec-status' });
  const timer = el('div', { class: 'timer' }, '00:00');
  const canvas = el('canvas', { class: 'viz', width: 720, height: 168, 'aria-hidden': 'true' });
  const transcriptBox = el('div', { class: 'live-transcript', 'aria-live': 'polite', 'aria-label': 'Live transcript' });
  const hintLine = el('p', { class: 'tiny faint center', style: 'margin:0' });

  const recBtn = el('button', { class: 'rec-btn', type: 'button', 'aria-label': 'Start recording', dataset: { state: 'idle' } });
  const leftBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Pause', hidden: true }, icon('pause'));
  const rightBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Discard', hidden: true }, icon('trash'));

  const sourceChips = el('div', { class: 'mode-chips', role: 'group', 'aria-label': 'What are you recording?' });
  const callHint = el('div', {});

  function renderSourceChips() {
    const options = [['mic', 'In person'], ['call', 'Phone call']];
    sourceChips.replaceChildren(...options.map(([value, label]) => el('button', {
      class: 'mode-chip',
      type: 'button',
      'aria-pressed': String(source === value),
      onclick: () => {
        if (isRecording()) return;
        source = value;
        renderSourceChips();
        renderCallHint();
        haptic();
      },
    }, label)));
  }

  function renderCallHint() {
    callHint.replaceChildren(source === 'call'
      ? banner('Android does not let a web app tap the call audio stream. Put the call on speakerphone so the microphone picks up both sides, and check the recording laws that apply to you and the other party.')
      : '');
  }

  function renderTranscript() {
    const segments = session?.segments || [];
    if (!segments.length && !session?.interim) {
      transcriptBox.replaceChildren(el('p', { class: 'live-line faint' },
        session ? 'Listening…' : 'Your words will appear here as you speak.'));
      return;
    }
    const lines = segments.slice(-60).map((seg) => el('p', { class: 'live-line' },
      seg.speaker ? el('span', { class: 'who' }, seg.speaker.replace('S', 'Speaker ')) : null,
      seg.text));
    if (session?.interim) lines.push(el('p', { class: 'live-line interim' }, session.interim));
    transcriptBox.replaceChildren(...lines);
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
  }

  function refresh() {
    const state = session?.recorder.state || 'idle';
    const live = state === 'recording' || state === 'paused';
    recBtn.dataset.state = live ? 'recording' : 'idle';
    recBtn.setAttribute('aria-label', live ? 'Stop and save' : 'Start recording');
    leftBtn.hidden = !live;
    rightBtn.hidden = !live;
    leftBtn.replaceChildren(icon(state === 'paused' ? 'play' : 'pause'));
    leftBtn.setAttribute('aria-label', state === 'paused' ? 'Resume' : 'Pause');
    sourceChips.querySelectorAll('button').forEach((b) => { b.disabled = live; });

    const pills = [];
    if (state === 'recording') pills.push(el('span', { class: 'pill pill-live' }, 'Recording'));
    else if (state === 'paused') pills.push(el('span', { class: 'pill' }, 'Paused'));
    else pills.push(el('span', { class: 'pill' }, 'Ready'));
    if (session?.transcriber) {
      pills.push(el('span', { class: session.listening ? 'pill pill-ok' : 'pill' },
        session.listening ? 'Transcribing' : 'Reconnecting…'));
    }
    status.replaceChildren(...pills);

    hintLine.textContent = live
      ? 'Tap the square to stop and save.'
      : (getSettings().captureMode === 'transcript'
        ? 'Transcript only — no audio file will be kept.'
        : 'Tap to start. Keep the screen on for the best transcript.');
  }

  /* ------------------------------------------------------- visualiser */

  const ctx2d = canvas.getContext('2d');
  let rafId = 0;
  function draw() {
    rafId = requestAnimationFrame(draw);
    const { width, height } = canvas;
    ctx2d.clearRect(0, 0, width, height);
    const mid = height / 2;
    const barW = width / levels.length;
    const gradient = ctx2d.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, '#7c5cff');
    gradient.addColorStop(1, '#22d3ee');
    ctx2d.fillStyle = gradient;

    // Silence reads better as one continuous baseline than as a row of dots.
    if (levels.every((v) => v < 0.02)) {
      ctx2d.globalAlpha = 0.45;
      ctx2d.fillRect(barW * 0.22, mid - 1, width - barW * 0.44, 2);
      ctx2d.globalAlpha = 1;
      return;
    }

    for (let i = 0; i < levels.length; i += 1) {
      const h = Math.max(3, levels[i] * (height * 0.82));
      const x = i * barW + barW * 0.22;
      const w = barW * 0.56;
      const y = mid - h / 2;
      ctx2d.beginPath();
      if (ctx2d.roundRect) ctx2d.roundRect(x, y, w, h, Math.min(w / 2, 4));
      else ctx2d.rect(x, y, w, h);
      ctx2d.fill();
    }
  }

  const tickId = setInterval(() => {
    timer.textContent = session ? fmtClock(session.recorder.elapsed()) : '00:00';
  }, 200);

  /* ------------------------------------------------------------ wiring */

  recBtn.addEventListener('click', async () => {
    if (isRecording()) {
      recBtn.disabled = true;
      const meeting = await stopAndSave();
      recBtn.disabled = false;
      if (meeting) {
        ctx.go(`#/meeting/${meeting.id}`);
        runAnalysis(meeting);
      }
    } else {
      await startSession();
    }
  });
  leftBtn.addEventListener('click', togglePause);
  rightBtn.addEventListener('click', discardSession);

  const onSession = () => {
    refresh();
    renderTranscript();
  };
  window.addEventListener('summary:session', onSession);

  const onVisibility = () => {
    if (document.visibilityState === 'visible') session?.recorder.refreshWakeLock();
  };
  document.addEventListener('visibilitychange', onVisibility);

  /* ----------------------------------------------------------- compose */

  renderSourceChips();
  renderCallHint();

  const view = el('div', { class: 'recorder' },
    status,
    timer,
    canvas,
    el('div', { class: 'rec-controls' }, leftBtn, recBtn, rightBtn),
    hintLine,
    el('div', { class: 'stack', style: 'width:100%' }, sourceChips, callHint, transcriptBox));

  if (!canRecord && !canTranscribe) {
    view.prepend(banner('This browser supports neither audio recording nor speech recognition. Chrome on Android is the target.', { kind: 'banner-danger' }));
  } else if (!canTranscribe) {
    view.prepend(banner('Live transcription is not available in this browser. Audio is still recorded — Chrome gives you live text.'));
  }

  root.replaceChildren(view);
  draw();
  refresh();
  renderTranscript();
  timer.textContent = session ? fmtClock(session.recorder.elapsed()) : '00:00';

  return () => {
    cancelAnimationFrame(rafId);
    clearInterval(tickId);
    window.removeEventListener('summary:session', onSession);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/* ------------------------------------------------------------ analysis -- */

/**
 * Analyse a saved meeting in the background. Progress is broadcast as window
 * events so the detail view can show it whether or not it was mounted when
 * the run started.
 */
export async function runAnalysis(meeting, { force = false } = {}) {
  if (!force && !getSettings().autoAnalyze) return;
  if (!meeting.segments?.length) return;

  const announce = (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail: { id: meeting.id, ...detail } }));

  if (!hasKey()) {
    const analysis = analyzeLocally(meeting);
    await saveMeeting({ ...meeting, analysis });
    announce('summary:analysis-done', { local: true });
    return;
  }

  announce('summary:analysis-start');
  try {
    const analysis = await analyzeMeeting(meeting, {
      onProgress: (stage, pct) => announce('summary:analysis-progress', { stage, pct }),
    });
    await saveMeeting({ ...meeting, analysis });
    announce('summary:analysis-done', { local: false });
  } catch (err) {
    announce('summary:analysis-error', { message: err?.message || String(err) });
  }
}
