/* Record view — capture, live transcript, save.
 *
 * The live session is module state, not view state, so switching to Library
 * mid-meeting does not stop the recording. The session emits a single
 * `summary:session` window event whenever anything changes and the mounted
 * view re-renders from that, which keeps the two decoupled across remounts.
 */

import { el, fmtClock, fmtDate, haptic, icon } from '../util.js';
import { banner, confirmSheet, sheet, toast } from '../ui.js';
import { Recorder, isSupported as recorderSupported } from '../recorder.js';
import { Transcriber, assignSpeakers, mergeSegments, isSupported as asrSupported } from '../asr.js';
import { getSettings } from '../settings.js';
import {
  appendLiveChunk, assembleLiveAudio, beginLiveSession, clearLiveSession, getLiveSession,
  isQuotaError, newMeeting, requestPersistence, saveAudio, saveMeeting, updateLiveSession,
} from '../db.js';
import { analyzeMeeting, hasKey } from '../ai.js';
import { analyzeLocally } from '../local-summary.js';

const LEVEL_BARS = 72;

/** How often the live session row is refreshed with the current duration. */
const HEARTBEAT_MS = 5000;

let session = null;
let levels = new Array(LEVEL_BARS).fill(0);
let source = 'mic';

const emit = () => window.dispatchEvent(new CustomEvent('summary:session'));

export function isRecording() {
  return Boolean(session) && (session.recorder.state === 'recording' || session.recorder.state === 'paused');
}

/* ------------------------------------------------------------- session -- */

/**
 * Serialise persistence behind one promise chain. Writes from a one-second
 * timeslice would otherwise interleave, and stopping needs a single thing to
 * await before it can assemble the file from what landed.
 */
function queueWrite(work) {
  if (!session) return Promise.resolve();
  session.writes = session.writes.then(work).catch((err) => handleWriteError(err));
  return session.writes;
}

/**
 * A failed write must not cost the user the meeting. Running out of storage
 * drops the audio and keeps transcribing; anything else is reported once.
 */
async function handleWriteError(err) {
  if (!session || session.audioDropped) return;
  if (isQuotaError(err)) {
    session.audioDropped = true;
    session.keepAudio = false;
    session.recorder.dropAudio();
    await updateLiveSession({ audioDropped: true, keepAudio: false }).catch(() => {});
    toast('This device is out of storage. Audio recording stopped — the transcript is still being saved.', 'err', 6000);
  } else {
    console.error('live session write failed', err);
    toast(`Could not save part of the recording: ${err?.message || err}`, 'err');
  }
}

function persistChunk({ blob, index }) {
  if (!session || !session.keepAudio || session.audioDropped) return;
  const { meetingId } = session;
  queueWrite(async () => {
    await appendLiveChunk(meetingId, index, blob);
    await updateLiveSession({ chunkCount: index + 1, durationMs: session?.recorder.elapsed() ?? 0 });
  });
}

async function startSession() {
  const prefs = getSettings();
  const wantAudio = prefs.captureMode !== 'transcript' && recorderSupported();
  const wantText = prefs.captureMode !== 'audio' && asrSupported();

  const recorder = new Recorder();
  session = {
    recorder,
    transcriber: null,
    meetingId: crypto.randomUUID ? crypto.randomUUID() : `m${Date.now()}`,
    segments: [],
    interim: '',
    listening: false,
    source,
    language: prefs.language,
    keepAudio: wantAudio && prefs.keepAudio,
    audioDropped: false,
    writes: Promise.resolve(),
    heartbeat: 0,
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

  // Everything below is written as it is captured. If this tab is killed —
  // which Android does to backgrounded tabs without warning — the next launch
  // finds the session and offers it back.
  try {
    await beginLiveSession({
      meetingId: session.meetingId,
      source: session.source,
      language: session.language,
      mimeType: recorder.mimeType,
      keepAudio: session.keepAudio,
    });
  } catch (err) {
    toast(`Could not prepare storage: ${err?.message || err}. Recording anyway, but it will not survive a crash.`, 'err');
  }

  recorder.addEventListener('level', (e) => {
    levels.push(e.detail);
    levels.shift();
  });
  recorder.addEventListener('statechange', emit);
  recorder.addEventListener('chunk', (e) => persistChunk(e.detail));

  session.heartbeat = setInterval(() => {
    if (!session || session.recorder.state !== 'recording') return;
    queueWrite(() => updateLiveSession({ durationMs: session.recorder.elapsed() }));
  }, HEARTBEAT_MS);

  if (wantText) {
    const transcriber = new Transcriber({ clock: () => recorder.elapsed(), lang: session.language });
    transcriber.addEventListener('final', (e) => {
      session.segments.push(e.detail);
      session.interim = '';
      queueWrite(() => updateLiveSession({
        segments: session.segments,
        durationMs: session.recorder.elapsed(),
      }));
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
  clearInterval(session.heartbeat);
  session = null;
  levels = new Array(LEVEL_BARS).fill(0);
  emit();
  await clearLiveSession().catch(() => {});
  toast('Recording discarded.');
}

/** Stop, persist, and hand the new meeting id back to the caller. */
async function stopAndSave() {
  if (!session) return null;
  const active = session;
  active.transcriber?.stop();
  clearInterval(active.heartbeat);
  const { durationMs, mimeType } = await active.recorder.stop();

  // Let a trailing final recognition result land before freezing the text.
  await new Promise((resolve) => { setTimeout(resolve, 350); });

  const segments = active.segments.slice();
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

  // Every chunk write must land before the file is assembled from them.
  await active.writes.catch(() => {});

  const meeting = await finalize({
    meetingId: active.meetingId,
    durationMs,
    mimeType,
    source: active.source,
    language: active.language,
    segments,
    keepAudio: active.keepAudio && !active.audioDropped,
  });

  session = null;
  levels = new Array(LEVEL_BARS).fill(0);
  emit();
  if (meeting) haptic([10, 30, 10]);
  return meeting;
}

/**
 * Turn a finished — or recovered — session into a saved meeting. Shared by the
 * normal stop path and by recovery so both produce identical records.
 */
async function finalize({ meetingId, durationMs, mimeType, source, language, segments, keepAudio, recovered = false }) {
  const prefs = getSettings();
  let text = segments;
  if (prefs.autoSpeakers) text = assignSpeakers(text, prefs.speakerGapMs);
  text = mergeSegments(text);

  let blob = null;
  if (keepAudio) blob = await assembleLiveAudio(meetingId, mimeType).catch(() => null);

  if (!text.length && !blob) {
    await clearLiveSession().catch(() => {});
    toast('Nothing was captured, so nothing was saved.', 'err');
    return null;
  }

  const meeting = newMeeting({
    id: meetingId,
    durationMs,
    source,
    language,
    segments: text,
    hasAudio: Boolean(blob),
    audioType: blob?.type || '',
    audioSize: blob?.size || 0,
    recovered,
  });

  try {
    if (blob) await saveAudio(meeting.id, blob);
    await saveMeeting(meeting);
  } catch (err) {
    if (isQuotaError(err) && blob) {
      // Keep the words even when the audio will not fit.
      try {
        await saveMeeting({ ...meeting, hasAudio: false, audioType: '', audioSize: 0 });
        await clearLiveSession().catch(() => {});
        toast('Not enough storage for the audio — the transcript and notes were saved.', 'err', 6000);
        return { ...meeting, hasAudio: false };
      } catch { /* fall through to the generic failure below */ }
    }
    toast(`Could not save the recording: ${err?.message || err}`, 'err');
    return null;
  }

  await clearLiveSession().catch(() => {});
  return meeting;
}

/**
 * An interrupted recording left behind by a killed tab, if there is one and it
 * captured anything worth keeping.
 */
export async function pendingRecovery() {
  if (session) return null;
  const live = await getLiveSession().catch(() => null);
  if (!live) return null;
  if (!live.segments?.length && !live.chunkCount) {
    await clearLiveSession().catch(() => {});
    return null;
  }
  return live;
}

/** Rebuild an interrupted recording into a saved meeting. */
export function recoverSession(live) {
  return finalize({
    meetingId: live.meetingId,
    durationMs: live.durationMs || 0,
    mimeType: live.mimeType,
    source: live.source || 'mic',
    language: live.language || 'en-US',
    segments: live.segments || [],
    keepAudio: Boolean(live.keepAudio) && !live.audioDropped && Boolean(live.chunkCount),
    recovered: true,
  });
}

export function discardRecovery() {
  return clearLiveSession();
}

/* ---------------------------------------------------------------- view -- */

export function mount(root, ctx) {
  const canRecord = recorderSupported();
  const canTranscribe = asrSupported();

  const status = el('div', { class: 'rec-status' });
  const timer = el('div', { class: 'timer' }, '00:00');
  const canvas = el('canvas', { class: 'viz', width: 720, height: 168, 'aria-hidden': 'true' });
  const transcriptBox = el('div', { class: 'live-transcript', 'aria-live': 'polite', 'aria-label': 'Live transcript' });
  const hintLine = el('p', { class: 'tiny faint center flush' });

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
      if (!await offerRecovery(ctx, { allowLater: false })) return;
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
    el('div', { class: 'stack w-full' }, sourceChips, callHint, transcriptBox));

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
  offerRecovery(ctx);

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
const analysisRuns = new Map();

/** Cancel an in-flight analysis for one meeting, if there is one. */
export function cancelAnalysis(meetingId) {
  const controller = analysisRuns.get(meetingId);
  if (!controller) return false;
  controller.abort();
  analysisRuns.delete(meetingId);
  return true;
}

export async function runAnalysis(meeting, { force = false } = {}) {
  if (!force && !getSettings().autoAnalyze) return;
  if (!meeting.segments?.length) return;
  if (analysisRuns.has(meeting.id)) return;

  const announce = (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail: { id: meeting.id, ...detail } }));

  if (!hasKey()) {
    const analysis = analyzeLocally(meeting);
    await saveMeeting({ ...meeting, analysis });
    announce('summary:analysis-done', { local: true });
    return;
  }

  const controller = new AbortController();
  analysisRuns.set(meeting.id, controller);
  announce('summary:analysis-start');
  try {
    const analysis = await analyzeMeeting(meeting, {
      signal: controller.signal,
      onProgress: (stage, pct) => announce('summary:analysis-progress', { stage, pct }),
      onRetry: ({ attempt, of, waitMs }) => announce('summary:analysis-progress', {
        stage: `Connection problem — retrying (${attempt} of ${of}) in ${Math.round(waitMs / 1000)}s`,
        pct: 0.1,
      }),
    });
    await saveMeeting({ ...meeting, analysis });
    announce('summary:analysis-done', { local: false });
  } catch (err) {
    if (err?.name === 'AbortError') announce('summary:analysis-cancelled');
    else announce('summary:analysis-error', { message: err?.message || String(err) });
  } finally {
    analysisRuns.delete(meeting.id);
  }
}

/* ------------------------------------------------------------ recovery -- */

let recoveryOffered = false;

/**
 * Resolve an interrupted recording. On mount the user may defer; before a new
 * recording they may not, because starting one replaces the stored session and
 * deferring twice would silently destroy the earlier meeting.
 *
 * @returns {Promise<boolean>} true when nothing is left pending.
 */
async function offerRecovery(ctx, { allowLater = true } = {}) {
  if (session) return true;
  if (allowLater && recoveryOffered) return true;
  const live = await pendingRecovery();
  if (!live) return true;
  recoveryOffered = true;

  const words = (live.segments || []).reduce((n, seg) => n + seg.text.split(/\s+/).length, 0);
  const captured = [
    fmtClock(live.durationMs || 0),
    live.chunkCount ? 'audio' : null,
    words ? `${words} words` : null,
  ].filter(Boolean).join(' · ');

  const choice = await sheet((close) => el('div', { class: 'stack' },
    el('h2', {}, 'Unsaved recording found'),
    el('p', { class: 'small muted flush' },
      `A recording from ${fmtDate(live.startedAt)} was interrupted before it could be saved — the tab was closed or the phone reclaimed it. ${captured} was captured.`),
    el('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => close('recover') },
      icon('refresh'), 'Recover it'),
    el('button', { class: 'btn btn-danger btn-block', type: 'button', onclick: () => close('discard') },
      icon('trash'), 'Discard it'),
    allowLater
      ? el('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: () => close('later') }, 'Decide later')
      : null), { dismissible: false });

  if (choice === 'recover') {
    const meeting = await recoverSession(live);
    if (meeting) {
      toast('Recording recovered.', 'ok');
      ctx.go(`#/meeting/${meeting.id}`);
      runAnalysis(meeting);
    }
    return true;
  }
  if (choice === 'discard') {
    await discardRecovery();
    toast('Unsaved recording discarded.');
    return true;
  }
  return false;
}
