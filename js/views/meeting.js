/* Meeting detail — summary, transcript with synced playback, actions, Q&A. */

import { el, fmtClock, fmtDate, fmtDuration, haptic, icon } from '../util.js';
import { banner, confirmSheet, emptyState, promptSheet, sheet, toast } from '../ui.js';
import { deleteMeeting, getAudio, getMeeting, saveMeeting } from '../db.js';
import { askAboutMeeting, hasKey } from '../ai.js';
import { analyzeLocally } from '../local-summary.js';
import { assignSpeakers } from '../asr.js';
import { getSettings } from '../settings.js';
import { runAnalysis } from './record.js';
import {
  baseFilename, canShare, copyToClipboard, displayTitle, downloadAudio, downloadText,
  shareMeeting, toJson, toMarkdown, toPlainText,
} from '../export.js';

const TABS = [
  ['summary', 'Summary'],
  ['transcript', 'Transcript'],
  ['actions', 'Actions'],
  ['ask', 'Ask'],
];

export function mount(root, ctx, params) {
  const id = params.id;
  let meeting = null;
  let tab = 'summary';
  let audioUrl = null;
  let analysisState = null;   // { stage, pct } while a run is in flight
  let editMode = false;

  const body = el('div', {});
  const audio = el('audio', { preload: 'metadata' });

  /* ------------------------------------------------------------ helpers */

  async function persist(patch) {
    meeting = await saveMeeting({ ...meeting, ...patch });
    window.dispatchEvent(new CustomEvent('summary:meeting-changed', { detail: { id } }));
  }

  function speakerLabel(seg) {
    if (!seg.speaker) return '';
    return (meeting.speakers || {})[seg.speaker] || seg.speaker.replace('S', 'Speaker ');
  }

  /* ------------------------------------------------------------- topbar */

  function syncTopbar() {
    ctx.setTopbar({
      title: meeting ? displayTitle(meeting) : 'Recording',
      back: '#/library',
      actions: meeting ? [
        {
          icon: 'star',
          label: meeting.starred ? 'Remove star' : 'Star',
          active: meeting.starred,
          onClick: async () => {
            await persist({ starred: !meeting.starred });
            haptic();
            syncTopbar();
          },
        },
        { icon: 'share', label: 'Share and export', onClick: openExportSheet },
        { icon: 'edit', label: 'More', onClick: openMoreSheet },
      ] : [],
    });
  }

  /* -------------------------------------------------------------- sheets */

  function openExportSheet() {
    sheet((close) => el('div', { class: 'stack' },
      el('h2', {}, 'Share & export'),
      canShare() ? el('button', {
        class: 'btn btn-primary btn-block',
        type: 'button',
        onclick: async () => {
          close();
          try {
            await shareMeeting(meeting);
          } catch (err) {
            if (err?.name !== 'AbortError') toast('Sharing was not possible on this device.', 'err');
          }
        },
      }, icon('share'), 'Share notes') : null,
      meeting.hasAudio && canShare() ? el('button', {
        class: 'btn btn-block',
        type: 'button',
        onclick: async () => {
          close();
          try {
            await shareMeeting(meeting, { withAudio: true });
          } catch (err) {
            if (err?.name !== 'AbortError') toast('This device cannot share the audio file.', 'err');
          }
        },
      }, 'Share notes + audio') : null,
      el('button', {
        class: 'btn btn-block',
        type: 'button',
        onclick: async () => {
          close();
          const ok = await copyToClipboard(toMarkdown(meeting));
          toast(ok ? 'Notes copied as Markdown.' : 'Could not copy.', ok ? 'ok' : 'err');
        },
      }, icon('copy'), 'Copy as Markdown'),
      el('button', {
        class: 'btn btn-block',
        type: 'button',
        onclick: () => {
          close();
          downloadText(toMarkdown(meeting), `${baseFilename(meeting)}.md`);
        },
      }, icon('doc'), 'Download .md'),
      el('button', {
        class: 'btn btn-block',
        type: 'button',
        onclick: () => {
          close();
          downloadText(toPlainText(meeting), `${baseFilename(meeting)}.txt`, 'text/plain');
        },
      }, 'Download .txt'),
      el('button', {
        class: 'btn btn-block',
        type: 'button',
        onclick: () => {
          close();
          downloadText(toJson(meeting), `${baseFilename(meeting)}.json`, 'application/json');
        },
      }, 'Download .json (full record)'),
      meeting.hasAudio ? el('button', {
        class: 'btn btn-block',
        type: 'button',
        onclick: async () => {
          close();
          const ok = await downloadAudio(meeting);
          if (!ok) toast('The audio for this recording is no longer stored.', 'err');
        },
      }, 'Download audio') : null,
      el('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: () => close() }, 'Cancel')));
  }

  function openMoreSheet() {
    sheet((close) => el('div', { class: 'stack' },
      el('h2', {}, 'Recording options'),
      el('button', {
        class: 'btn btn-block',
        type: 'button',
        onclick: async () => {
          close();
          const value = await promptSheet({
            title: 'Rename recording',
            label: 'Title',
            value: meeting.title,
          });
          if (value === undefined) return;
          await persist({ title: value });
          syncTopbar();
          render();
        },
      }, icon('edit'), 'Rename'),
      el('button', {
        class: 'btn btn-block',
        type: 'button',
        onclick: () => { close(); reanalyze(); },
      }, icon('refresh'), meeting.analysis ? 'Re-run analysis' : 'Analyse now'),
      el('button', {
        class: 'btn btn-block',
        type: 'button',
        onclick: () => { close(); openSpeakerSheet(); },
      }, 'Rename speakers'),
      el('button', {
        class: 'btn btn-danger btn-block',
        type: 'button',
        onclick: async () => {
          close();
          const ok = await confirmSheet({
            title: 'Delete this recording?',
            body: 'The audio, transcript and notes will be removed from this device.',
            confirmLabel: 'Delete',
            danger: true,
          });
          if (!ok) return;
          await deleteMeeting(id);
          window.dispatchEvent(new CustomEvent('summary:meeting-changed', { detail: { id } }));
          toast('Recording deleted.');
          ctx.go('#/library');
        },
      }, icon('trash'), 'Delete'),
      el('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: () => close() }, 'Close')));
  }

  function openSpeakerSheet() {
    const ids = [...new Set((meeting.segments || []).map((s) => s.speaker).filter(Boolean))];
    if (!ids.length) {
      toast('This transcript has no speaker labels.');
      return;
    }
    sheet((close) => {
      const inputs = new Map();
      const fields = ids.map((sid) => {
        const input = el('input', {
          class: 'input',
          type: 'text',
          placeholder: sid.replace('S', 'Speaker '),
        });
        input.value = (meeting.speakers || {})[sid] || '';
        inputs.set(sid, input);
        return el('div', { class: 'field' }, el('label', {}, sid.replace('S', 'Speaker ')), input);
      });
      return el('div', { class: 'stack' },
        el('h2', {}, 'Rename speakers'),
        el('p', { class: 'small muted', style: 'margin:0' },
          'Speakers are split by pause length, so the labels are a guess. Naming them here also improves the AI analysis.'),
        ...fields,
        el('button', {
          class: 'btn btn-primary btn-block',
          type: 'button',
          onclick: async () => {
            const speakers = {};
            for (const [sid, input] of inputs) {
              const value = input.value.trim();
              if (value) speakers[sid] = value;
            }
            close();
            await persist({ speakers });
            render();
          },
        }, 'Save'),
        el('button', {
          class: 'btn btn-ghost btn-block',
          type: 'button',
          onclick: async () => {
            close();
            const gap = getSettings().speakerGapMs;
            await persist({ segments: assignSpeakers(meeting.segments || [], gap), speakers: {} });
            render();
            toast('Speaker split recalculated.');
          },
        }, 'Recalculate speaker split'));
    });
  }

  /* ------------------------------------------------------------ analysis */

  async function reanalyze() {
    if (!meeting.segments?.length) {
      toast('There is no transcript to analyse.', 'err');
      return;
    }
    if (!hasKey()) {
      const analysis = analyzeLocally(meeting);
      await persist({ analysis });
      render();
      toast('Summarised on-device. Add an API key in Settings for a written analysis.');
      return;
    }
    analysisState = { stage: 'Starting', pct: 0.02 };
    render();
    await runAnalysis(meeting, { force: true });
  }

  /* -------------------------------------------------------------- player */

  const playBtn = el('button', { class: 'play', type: 'button', 'aria-label': 'Play' }, icon('play'));
  const seek = el('input', { type: 'range', min: '0', max: '1000', value: '0', 'aria-label': 'Seek' });
  const timeLabel = el('span', { class: 'tiny mono faint' }, '00:00');

  function playerRow() {
    if (!meeting.hasAudio) {
      return el('div', { class: 'card small muted' },
        meeting.segments?.length
          ? 'No audio was kept for this recording — the transcript is below.'
          : 'No audio and no transcript were captured.');
    }
    return el('div', { class: 'player' }, playBtn, el('div', { class: 'grow' }, seek,
      el('div', { class: 'row-between' }, timeLabel,
        el('span', { class: 'tiny mono faint' }, fmtDuration(meeting.durationMs)))));
  }

  playBtn.addEventListener('click', async () => {
    if (!audioUrl) {
      const blob = await getAudio(id);
      if (!blob) {
        toast('The audio for this recording is no longer stored.', 'err');
        return;
      }
      audioUrl = URL.createObjectURL(blob);
      audio.src = audioUrl;
    }
    if (audio.paused) {
      await audio.play().catch(() => toast('Playback failed on this device.', 'err'));
    } else {
      audio.pause();
    }
  });

  audio.addEventListener('play', () => playBtn.replaceChildren(icon('pause')));
  audio.addEventListener('pause', () => playBtn.replaceChildren(icon('play')));
  audio.addEventListener('ended', () => playBtn.replaceChildren(icon('play')));

  seek.addEventListener('input', () => {
    // MediaRecorder blobs often report Infinity for duration until fully seeked,
    // so fall back to the measured recording length.
    const total = Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : (meeting.durationMs || 0) / 1000;
    audio.currentTime = (Number(seek.value) / 1000) * total;
  });

  audio.addEventListener('timeupdate', () => {
    const total = Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : (meeting.durationMs || 0) / 1000;
    if (total > 0) seek.value = String(Math.round((audio.currentTime / total) * 1000));
    timeLabel.textContent = fmtClock(audio.currentTime * 1000);
    highlightActiveSegment(audio.currentTime * 1000);
  });

  function highlightActiveSegment(positionMs) {
    if (tab !== 'transcript') return;
    const nodes = body.querySelectorAll('.seg');
    let active = null;
    nodes.forEach((node) => {
      const start = Number(node.dataset.start);
      const end = Number(node.dataset.end);
      const isActive = positionMs >= start && positionMs <= end;
      node.classList.toggle('active', isActive);
      if (isActive) active = node;
    });
    if (active && !userScrolled) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  let userScrolled = false;
  let scrollTimer = 0;
  const onScroll = () => {
    userScrolled = true;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => { userScrolled = false; }, 4000);
  };

  async function seekTo(ms) {
    if (!meeting.hasAudio) return;
    if (!audioUrl) {
      const blob = await getAudio(id);
      if (!blob) return;
      audioUrl = URL.createObjectURL(blob);
      audio.src = audioUrl;
    }
    audio.currentTime = ms / 1000;
    if (audio.paused) audio.play().catch(() => {});
  }

  /* ---------------------------------------------------------------- tabs */

  function renderTabs() {
    return el('div', { class: 'tabs', role: 'tablist' },
      ...TABS.map(([key, label]) => el('button', {
        type: 'button',
        role: 'tab',
        'aria-selected': String(tab === key),
        onclick: () => { tab = key; render(); },
      }, label)));
  }

  function summaryTab() {
    const a = meeting.analysis;
    const stack = el('div', { class: 'stack' });

    if (analysisState) {
      stack.append(el('div', { class: 'card stack' },
        el('div', { class: 'row' }, el('div', { class: 'spinner' }),
          el('span', { class: 'small' }, analysisState.stage || 'Analysing…')),
        el('div', { class: 'progress' }, el('i', { style: `width:${Math.round((analysisState.pct || 0) * 100)}%` }))));
    }

    if (!a && !analysisState) {
      stack.append(emptyState(
        'sparkle',
        'Not analysed yet',
        hasKey()
          ? 'Run the AI pass to get a summary, decisions and action items.'
          : 'Add an Anthropic API key in Settings for a written analysis, or summarise on-device now.',
        el('button', { class: 'btn btn-primary', type: 'button', onclick: reanalyze },
          icon('sparkle'), hasKey() ? 'Analyse with Claude' : 'Summarise on-device'),
      ));
      return stack;
    }

    if (!a) return stack;

    if (a.provider === 'local') {
      stack.append(banner('This summary was produced on-device by picking out the most weighted sentences. Add an API key in Settings for a written analysis.'));
    }

    stack.append(el('div', { class: 'card stack' },
      el('div', { class: 'section-title' }, 'Summary'),
      el('p', { style: 'margin:0;font-size:15px;line-height:1.6' }, a.summary || '—'),
      a.topics?.length ? el('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px' },
        ...a.topics.map((t) => el('span', { class: 'pill pill-accent' }, t))) : null,
      a.sentiment?.note ? el('p', { class: 'tiny faint', style: 'margin:0' },
        `Tone: ${a.sentiment.overall} — ${a.sentiment.note}`) : null));

    if (a.keyPoints?.length) {
      stack.append(el('div', { class: 'card' },
        el('div', { class: 'section-title', style: 'margin-bottom:8px' }, 'Key points'),
        el('ul', { class: 'bullets' }, ...a.keyPoints.map((p) => el('li', {}, p)))));
    }
    if (a.decisions?.length) {
      stack.append(el('div', { class: 'card' },
        el('div', { class: 'section-title', style: 'margin-bottom:8px' }, 'Decisions'),
        el('ul', { class: 'bullets' }, ...a.decisions.map((d) => el('li', {}, d)))));
    }
    if (a.openQuestions?.length) {
      stack.append(el('div', { class: 'card' },
        el('div', { class: 'section-title', style: 'margin-bottom:8px' }, 'Open questions'),
        el('ul', { class: 'bullets' }, ...a.openQuestions.map((q) => el('li', {}, q)))));
    }
    if (a.followUpEmail) {
      stack.append(el('div', { class: 'card stack' },
        el('div', { class: 'row-between' },
          el('div', { class: 'section-title' }, 'Recap email'),
          el('button', {
            class: 'btn btn-sm btn-ghost',
            type: 'button',
            onclick: async () => {
              const ok = await copyToClipboard(a.followUpEmail);
              toast(ok ? 'Draft copied.' : 'Could not copy.', ok ? 'ok' : 'err');
            },
          }, icon('copy'), 'Copy')),
        el('p', { class: 'small', style: 'margin:0;white-space:pre-wrap' }, a.followUpEmail)));
    }

    stack.append(el('p', { class: 'tiny faint center' },
      a.provider === 'anthropic'
        ? `Analysed with ${a.model} · ${fmtDate(a.generatedAt)}`
        : `On-device analysis · ${fmtDate(a.generatedAt)}`));
    return stack;
  }

  function transcriptTab() {
    const segments = meeting.segments || [];
    if (!segments.length) {
      return emptyState('doc', 'No transcript', 'Nothing was recognised for this recording. Live transcription needs Chrome and a network connection.');
    }

    const toolbar = el('div', { class: 'row-between', style: 'margin-bottom:10px' },
      el('span', { class: 'tiny faint' }, `${segments.length} segments · ${segments.reduce((n, s) => n + s.text.split(' ').length, 0)} words`),
      el('div', { class: 'row', style: 'gap:6px' },
        el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: openSpeakerSheet }, 'Speakers'),
        el('button', {
          class: 'btn btn-sm btn-ghost',
          type: 'button',
          'aria-pressed': String(editMode),
          onclick: () => { editMode = !editMode; render(); },
        }, editMode ? 'Done' : 'Fix text')));

    const activate = async (seg, index) => {
      if (editMode) {
        const value = await promptSheet({
          title: 'Fix transcript text',
          label: `${speakerLabel(seg) || 'Segment'} at ${fmtClock(seg.start)}`,
          value: seg.text,
          multiline: true,
        });
        if (value === undefined) return;
        const next = segments.slice();
        if (value) next[index] = { ...seg, text: value };
        else next.splice(index, 1);
        await persist({ segments: next });
        render();
        return;
      }
      seekTo(seg.start);
    };

    const list = el('div', {}, ...segments.map((seg, index) => el('div', {
      class: 'seg',
      dataset: { start: String(seg.start), end: String(seg.end) },
      role: 'button',
      tabindex: '0',
      onclick: () => activate(seg, index),
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate(seg, index);
        }
      },
    },
    el('div', { class: 'seg-head' },
      seg.speaker ? el('span', { class: 'who' }, speakerLabel(seg)) : null,
      el('span', { class: 'at' }, fmtClock(seg.start))),
    el('p', {}, seg.text))));

    return el('div', {}, toolbar, editMode ? banner('Tap any line to correct it. Clearing the text removes that line.') : null, list);
  }

  function actionsTab() {
    const items = meeting.analysis?.actionItems || [];
    if (!items.length) {
      return emptyState('check', 'No action items',
        meeting.analysis ? 'Nothing in this recording read as a commitment.' : 'Run the analysis first to pull out action items.');
    }
    const open = items.filter((i) => !i.done).length;

    const rows = items.map((item, index) => el('div', { class: `action-item${item.done ? ' done' : ''}` },
      el('input', {
        type: 'checkbox',
        checked: item.done,
        'aria-label': `Mark "${item.task}" done`,
        onchange: async (e) => {
          const next = items.slice();
          next[index] = { ...item, done: e.target.checked };
          await persist({ analysis: { ...meeting.analysis, actionItems: next } });
          haptic();
          render();
        },
      }),
      el('div', { class: 'grow' },
        el('div', { class: 'task' }, item.task),
        el('div', { class: 'who-due' },
          item.owner && item.owner !== 'Unassigned' ? el('span', { class: 'pill' }, item.owner) : el('span', { class: 'pill' }, 'Unassigned'),
          item.due ? el('span', { class: 'pill' }, item.due) : null,
          el('span', { class: `prio prio-${item.priority}` }, item.priority)))));

    return el('div', { class: 'stack' },
      el('div', { class: 'row-between' },
        el('div', { class: 'section-title' }, `${open} open · ${items.length - open} done`),
        el('button', {
          class: 'btn btn-sm btn-ghost',
          type: 'button',
          onclick: async () => {
            const text = items.map((i) => `- [${i.done ? 'x' : ' '}] ${i.task}${i.owner && i.owner !== 'Unassigned' ? ` (${i.owner})` : ''}${i.due ? ` — ${i.due}` : ''}`).join('\n');
            const ok = await copyToClipboard(text);
            toast(ok ? 'Action items copied.' : 'Could not copy.', ok ? 'ok' : 'err');
          },
        }, icon('copy'), 'Copy')),
      ...rows);
  }

  function askTab() {
    const log = el('div', { class: 'chat-log' });
    const input = el('input', {
      class: 'input',
      type: 'text',
      placeholder: 'Ask anything about this recording',
      enterkeyhint: 'send',
      'aria-label': 'Question',
    });
    const sendBtn = el('button', { class: 'btn btn-primary', type: 'button' }, icon('chat'), 'Ask');

    function renderLog() {
      const turns = meeting.chat || [];
      if (!turns.length) {
        log.replaceChildren(el('p', { class: 'small faint center' },
          'Ask things like “what did I commit to?”, “what was said about pricing?” or “write a one-line status update”.'));
        return;
      }
      log.replaceChildren(...turns.map((turn) => el('div', {
        class: `bubble ${turn.role === 'user' ? 'me' : 'ai'}`,
      }, turn.text)));
      log.lastElementChild?.scrollIntoView({ block: 'nearest' });
    }

    async function send() {
      const question = input.value.trim();
      if (!question) return;
      if (!hasKey()) {
        toast('Add an Anthropic API key in Settings to ask questions.', 'err');
        return;
      }
      input.value = '';
      const history = (meeting.chat || []).slice();
      const pending = el('div', { class: 'bubble ai' }, '…');
      await persist({ chat: [...history, { role: 'user', text: question, at: Date.now() }] });
      renderLog();
      log.append(pending);
      sendBtn.disabled = true;

      try {
        const answer = await askAboutMeeting(meeting, question, {
          history,
          onText: (_delta, full) => { pending.textContent = full; },
        });
        await persist({ chat: [...(meeting.chat || []), { role: 'assistant', text: answer, at: Date.now() }] });
      } catch (err) {
        toast(err?.message || 'The question failed.', 'err');
      } finally {
        sendBtn.disabled = false;
        renderLog();
      }
    }

    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); send(); }
    });

    renderLog();
    return el('div', { class: 'stack' },
      hasKey() ? null : banner('Questions need an Anthropic API key. Add one in Settings.'),
      log,
      el('div', { class: 'row' }, el('div', { class: 'grow' }, input), sendBtn));
  }

  /* -------------------------------------------------------------- render */

  function render() {
    if (!meeting) {
      body.replaceChildren(emptyState('doc', 'Recording not found', 'It may have been deleted.',
        el('a', { class: 'btn', href: '#/library' }, 'Back to library')));
      return;
    }
    const header = el('div', { class: 'stack', style: 'margin-bottom:14px' },
      el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
        el('span', { class: 'pill' }, icon('clock'), fmtDuration(meeting.durationMs)),
        el('span', { class: 'pill' }, meeting.source === 'call' ? 'Phone call' : 'Microphone'),
        el('span', { class: 'pill' }, fmtDate(meeting.createdAt))),
      playerRow());

    const panel = tab === 'summary' ? summaryTab()
      : tab === 'transcript' ? transcriptTab()
        : tab === 'actions' ? actionsTab()
          : askTab();

    body.replaceChildren(header, renderTabs(), panel);
  }

  /* ---------------------------------------------------------- lifecycle */

  const onProgress = (e) => {
    if (e.detail.id !== id) return;
    analysisState = { stage: e.detail.stage, pct: e.detail.pct };
    if (tab === 'summary') render();
  };
  const onStart = (e) => {
    if (e.detail.id !== id) return;
    analysisState = { stage: 'Starting', pct: 0.02 };
    render();
  };
  const onDone = async (e) => {
    if (e.detail.id !== id) return;
    analysisState = null;
    meeting = await getMeeting(id);
    syncTopbar();
    render();
  };
  const onError = (e) => {
    if (e.detail.id !== id) return;
    analysisState = null;
    render();
    toast(e.detail.message, 'err');
  };

  window.addEventListener('summary:analysis-progress', onProgress);
  window.addEventListener('summary:analysis-start', onStart);
  window.addEventListener('summary:analysis-done', onDone);
  window.addEventListener('summary:analysis-error', onError);
  window.addEventListener('scroll', onScroll, { passive: true });

  root.replaceChildren(body, audio);

  (async () => {
    meeting = await getMeeting(id);
    syncTopbar();
    render();
  })();

  return () => {
    window.removeEventListener('summary:analysis-progress', onProgress);
    window.removeEventListener('summary:analysis-start', onStart);
    window.removeEventListener('summary:analysis-done', onDone);
    window.removeEventListener('summary:analysis-error', onError);
    window.removeEventListener('scroll', onScroll);
    audio.pause();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  };
}
