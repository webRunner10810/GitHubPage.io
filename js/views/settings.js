/* Settings — API key, model, language, capture behaviour, storage. */

import { el, fmtBytes, icon } from '../util.js';
import { banner, confirmSheet, toast } from '../ui.js';
import { EFFORTS, MODELS, getSettings, resetSettings, setSettings } from '../settings.js';
import { LANGUAGES, isSupported as asrSupported } from '../asr.js';
import { isSupported as recorderSupported } from '../recorder.js';
import { clearAll, listMeetings, usage } from '../db.js';
import { testConnection } from '../ai.js';
import { downloadText } from '../export.js';

function field(label, control, hint) {
  return el('div', { class: 'field' },
    el('label', {}, label),
    control,
    hint ? el('div', { class: 'hint' }, hint) : null);
}

function toggle(label, name, hint) {
  const input = el('input', {
    type: 'checkbox',
    checked: getSettings()[name],
    onchange: (e) => setSettings({ [name]: e.target.checked }),
  });
  return el('div', {},
    el('div', { class: 'switch' }, el('div', {}, el('div', {}, label),
      hint ? el('div', { class: 'hint' }, hint) : null), input));
}

function select(name, options, onChange) {
  const node = el('select', {
    class: 'select',
    onchange: (e) => {
      setSettings({ [name]: e.target.value });
      onChange?.(e.target.value);
    },
  }, ...options.map(([value, label]) => el('option', { value }, label)));
  node.value = getSettings()[name];
  return node;
}

export function mount(root, ctx) {
  const s = getSettings();
  const container = el('div', { class: 'stack' });

  /* ------------------------------------------------------------- AI key */

  const keyInput = el('input', {
    class: 'input',
    type: 'password',
    placeholder: 'sk-ant-…',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    'aria-label': 'Anthropic API key',
  });
  keyInput.value = s.apiKey;

  const testBtn = el('button', { class: 'btn btn-sm', type: 'button' }, icon('check'), 'Test key');
  const keyStatus = el('div', { class: 'hint' });

  keyInput.addEventListener('change', () => {
    setSettings({ apiKey: keyInput.value.trim() });
    keyStatus.textContent = keyInput.value.trim() ? 'Key saved on this device.' : 'Key removed.';
  });

  testBtn.addEventListener('click', async () => {
    setSettings({ apiKey: keyInput.value.trim() });
    testBtn.disabled = true;
    keyStatus.textContent = 'Contacting the API…';
    try {
      const reply = await testConnection();
      keyStatus.textContent = `Working — the API replied “${reply}”.`;
      toast('API key works.', 'ok');
    } catch (err) {
      keyStatus.textContent = err?.message || 'The test failed.';
      toast(err?.message || 'The test failed.', 'err');
    } finally {
      testBtn.disabled = false;
    }
  });

  container.append(el('div', { class: 'card stack' },
    el('div', { class: 'section-title' }, 'AI analysis'),
    field('Anthropic API key', keyInput,
      'Stored in this browser only and sent directly to api.anthropic.com. Anything with script access to this site could read it — use a key scoped to this app, and clear it when you are done.'),
    el('div', { class: 'row' }, testBtn, el('div', { class: 'grow' })),
    keyStatus,
    field('Model', select('model', MODELS)),
    field('Thinking effort', select('effort', EFFORTS), 'Higher effort is slower and costs more, but reads long meetings more carefully.'),
    field('Standing context (optional)', (() => {
      const ta = el('textarea', {
        class: 'textarea',
        placeholder: 'Team names, product names, acronyms — anything that helps the model read the transcript.',
        onchange: (e) => setSettings({ meetingContext: e.target.value }),
      });
      ta.value = s.meetingContext;
      return ta;
    })())));

  container.append(el('div', { class: 'card' },
    toggle('Analyse automatically', 'autoAnalyze', 'Run the summary as soon as a recording is saved.')));

  /* ------------------------------------------------------------ capture */

  const captureSelect = el('select', {
    class: 'select',
    onchange: (e) => setSettings({ captureMode: e.target.value }),
  },
  el('option', { value: 'both' }, 'Audio + live transcript'),
  el('option', { value: 'audio' }, 'Audio only'),
  el('option', { value: 'transcript' }, 'Transcript only (no audio file)'));
  captureSelect.value = s.captureMode;

  const gapInput = el('input', {
    class: 'input',
    type: 'number',
    min: '500',
    max: '5000',
    step: '100',
    onchange: (e) => setSettings({ speakerGapMs: Math.max(500, Math.min(5000, Number(e.target.value) || 1500)) }),
  });
  gapInput.value = String(s.speakerGapMs);

  container.append(el('div', { class: 'card stack' },
    el('div', { class: 'section-title' }, 'Recording'),
    field('What to capture', captureSelect),
    field('Transcription language', select('language', LANGUAGES),
      'Speech recognition is single-language — pick the one that will be spoken most.'),
    toggle('Split speakers automatically', 'autoSpeakers', 'Treat a long pause as a change of speaker. A guess, not real diarization.'),
    field('Pause that means a new speaker (ms)', gapInput),
    toggle('Keep the audio file', 'keepAudio', 'Turn off to save only the transcript and use much less storage.')));

  /* ------------------------------------------------------------ storage */

  const storageBox = el('div', { class: 'card stack' });

  async function renderStorage() {
    const meetings = await listMeetings();
    const est = await usage();
    const audioBytes = meetings.reduce((n, m) => n + (m.audioSize || 0), 0);

    storageBox.replaceChildren(
      el('div', { class: 'section-title' }, 'Data on this device'),
      el('div', { class: 'small muted' },
        `${meetings.length} recording${meetings.length === 1 ? '' : 's'} · ${fmtBytes(audioBytes)} of audio`),
      est ? el('div', { class: 'stack', style: 'gap:6px' },
        el('div', { class: 'progress' },
          el('i', { style: `width:${Math.min(100, Math.round((est.used / (est.quota || 1)) * 100))}%` })),
        el('div', { class: 'tiny faint' }, `${fmtBytes(est.used)} used of about ${fmtBytes(est.quota)} available to this site`)) : null,
      el('button', {
        class: 'btn btn-block btn-sm',
        type: 'button',
        onclick: async () => {
          const all = await listMeetings();
          if (!all.length) {
            toast('There is nothing to export yet.');
            return;
          }
          downloadText(JSON.stringify({ exportedAt: Date.now(), meetings: all }, null, 2),
            `summary-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
          toast('Backup downloaded (transcripts and notes, not audio).');
        },
      }, icon('doc'), 'Export all notes as JSON'),
      el('button', {
        class: 'btn btn-danger btn-block btn-sm',
        type: 'button',
        onclick: async () => {
          const ok = await confirmSheet({
            title: 'Delete every recording?',
            body: 'All audio, transcripts and notes on this device will be erased. This cannot be undone.',
            confirmLabel: 'Delete everything',
            danger: true,
          });
          if (!ok) return;
          await clearAll();
          window.dispatchEvent(new CustomEvent('summary:meeting-changed', { detail: {} }));
          renderStorage();
          toast('All recordings deleted.');
        },
      }, icon('trash'), 'Delete all recordings'),
      el('button', {
        class: 'btn btn-ghost btn-block btn-sm',
        type: 'button',
        onclick: async () => {
          const ok = await confirmSheet({
            title: 'Reset settings?',
            body: 'This clears the API key and every preference. Recordings are kept.',
            confirmLabel: 'Reset settings',
            danger: true,
          });
          if (!ok) return;
          resetSettings();
          ctx.go('#/settings', { reload: true });
          toast('Settings reset.');
        },
      }, 'Reset settings'));
  }

  container.append(storageBox);

  /* -------------------------------------------------------------- about */

  const support = [
    ['Microphone recording', recorderSupported()],
    ['Live transcription', asrSupported()],
    ['Install as an app', 'serviceWorker' in navigator],
    ['Share sheet', Boolean(navigator.share)],
    ['Screen wake lock', 'wakeLock' in navigator],
  ];

  container.append(el('div', { class: 'card stack' },
    el('div', { class: 'section-title' }, 'This device'),
    ...support.map(([label, ok]) => el('div', { class: 'row-between small' },
      el('span', { class: 'muted' }, label),
      el('span', { class: ok ? 'pill pill-ok' : 'pill' }, ok ? 'Supported' : 'Not available'))),
    asrSupported() ? null : banner('Live transcription needs Chrome (Android or desktop). Other browsers can still record audio.')));

  container.append(el('div', { class: 'card stack' },
    el('div', { class: 'section-title' }, 'Recording other people'),
    el('p', { class: 'small muted', style: 'margin:0' },
      'Consent rules for recording a conversation differ by country and by state. Some places require every participant to agree. You are responsible for getting that agreement before you hit record.'),
    el('p', { class: 'tiny faint', style: 'margin:0' },
      'Audio and transcripts stay on this device. When AI analysis runs, the transcript text — not the audio — is sent to the Anthropic API.')));

  root.replaceChildren(container);
  renderStorage();
  return () => {};
}
