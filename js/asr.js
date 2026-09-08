/* Live speech-to-text on top of the Web Speech API.
 *
 * Chrome on Android ends a recognition session after every natural pause even
 * with `continuous = true`, so the session is restarted automatically for as
 * long as the user is recording. Timestamps come from the recorder clock that
 * is injected via `clock`, which keeps segments aligned with the audio file.
 */

// Read through globalThis so the module can be imported outside a browser
// (the unit tests exercise the pure transforms at the bottom of this file).
const SpeechRecognitionImpl = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

export function isSupported() {
  return Boolean(SpeechRecognitionImpl);
}

/** Languages offered in Settings — all well supported by Chrome's recognizer. */
export const LANGUAGES = [
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['en-IN', 'English (India)'],
  ['en-AU', 'English (Australia)'],
  ['es-ES', 'Spanish (Spain)'],
  ['es-MX', 'Spanish (Mexico)'],
  ['fr-FR', 'French'],
  ['de-DE', 'German'],
  ['it-IT', 'Italian'],
  ['pt-BR', 'Portuguese (Brazil)'],
  ['nl-NL', 'Dutch'],
  ['sv-SE', 'Swedish'],
  ['pl-PL', 'Polish'],
  ['tr-TR', 'Turkish'],
  ['ru-RU', 'Russian'],
  ['hi-IN', 'Hindi'],
  ['ar-SA', 'Arabic'],
  ['zh-CN', 'Chinese (Mandarin)'],
  ['ja-JP', 'Japanese'],
  ['ko-KR', 'Korean'],
];

const FATAL_ERRORS = new Set(['not-allowed', 'service-not-allowed', 'audio-capture']);

export class Transcriber extends EventTarget {
  /**
   * @param {object} opts
   * @param {() => number} opts.clock  Recording position in ms.
   * @param {string} opts.lang         BCP-47 tag, e.g. 'en-US'.
   */
  constructor({ clock, lang = 'en-US' } = {}) {
    super();
    this.clock = clock || (() => 0);
    this.lang = lang;
    this.active = false;            // user intent: should we be listening?
    this.listening = false;         // actual recognizer state
    this.recognition = null;
    this.interim = '';
    this._segmentStart = null;      // clock position where the current phrase began
    this._restartTimer = 0;
    this._backoff = 300;
    this._lastError = '';
  }

  start() {
    if (!SpeechRecognitionImpl) {
      this._emit('error', { code: 'unsupported', message: 'This browser has no speech recognition.' });
      return false;
    }
    this.active = true;
    this._backoff = 300;
    this._spinUp();
    return true;
  }

  stop() {
    this.active = false;
    clearTimeout(this._restartTimer);
    this.interim = '';
    if (this.recognition) {
      try { this.recognition.stop(); } catch { /* already stopping */ }
    }
  }

  /** Pausing keeps user intent but suspends the recognizer. */
  pause() {
    clearTimeout(this._restartTimer);
    this.active = false;
    if (this.recognition) {
      try { this.recognition.abort(); } catch { /* already stopped */ }
    }
  }

  resume() {
    if (this.active) return;
    this.active = true;
    this._backoff = 300;
    this._spinUp();
  }

  setLanguage(lang) {
    this.lang = lang;
    if (this.active) {
      // Restart so the new language takes effect immediately.
      try { this.recognition?.abort(); } catch { /* ignored */ }
    }
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _spinUp() {
    if (!this.active || this.listening) return;
    const rec = new SpeechRecognitionImpl();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      this.listening = true;
      this._lastError = '';
      this._emit('statechange', { listening: true });
    };

    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const alt = result[0];
        const text = (alt?.transcript || '').trim();
        if (!text) continue;
        if (this._segmentStart === null) this._segmentStart = Math.max(0, this.clock() - 400);
        if (result.isFinal) {
          const segment = {
            id: `${Date.now().toString(36)}-${i}`,
            start: this._segmentStart,
            end: this.clock(),
            text: capitalize(text),
            confidence: typeof alt.confidence === 'number' ? alt.confidence : null,
            speaker: null,
          };
          this._segmentStart = null;
          this.interim = '';
          this._emit('final', segment);
        } else {
          interim += `${text} `;
        }
      }
      if (interim) {
        this.interim = interim.trim();
        this._emit('interim', this.interim);
      }
    };

    rec.onerror = (event) => {
      this._lastError = event.error;
      if (FATAL_ERRORS.has(event.error)) {
        this.active = false;
        this._emit('error', { code: event.error, message: errorMessage(event.error), fatal: true });
      } else if (event.error === 'network') {
        // Chrome's recognizer is cloud-backed; surface it but keep retrying.
        this._emit('error', { code: event.error, message: errorMessage(event.error), fatal: false });
      }
      // 'no-speech' and 'aborted' are normal during a long meeting — stay quiet.
    };

    rec.onend = () => {
      this.listening = false;
      this._emit('statechange', { listening: false });
      if (!this.active) return;
      // Back off a little on repeated failures so we do not spin.
      const delay = this._lastError && this._lastError !== 'no-speech' ? this._backoff : 120;
      if (this._lastError && this._lastError !== 'no-speech') {
        this._backoff = Math.min(this._backoff * 2, 8000);
      } else {
        this._backoff = 300;
      }
      clearTimeout(this._restartTimer);
      this._restartTimer = setTimeout(() => this._spinUp(), delay);
    };

    this.recognition = rec;
    try {
      rec.start();
    } catch {
      // start() throws if a previous session has not fully released yet.
      this.listening = false;
      clearTimeout(this._restartTimer);
      this._restartTimer = setTimeout(() => this._spinUp(), 400);
    }
  }
}

function capitalize(text) {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function errorMessage(code) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access was blocked. Allow it in the site settings and start again.';
    case 'audio-capture':
      return 'No microphone was available. Another app may be holding it.';
    case 'network':
      return 'Speech recognition lost its network connection. Recording continues; text will resume when you are back online.';
    default:
      return `Speech recognition error: ${code}`;
  }
}

/**
 * Assign speaker labels from pause structure: a gap longer than `gapMs`
 * between two phrases is treated as a turn change. This is a heuristic, not
 * real diarization — the UI lets people rename and correct speakers.
 */
export function assignSpeakers(segments, gapMs = 1500) {
  let speaker = 1;
  return segments.map((seg, i) => {
    if (i > 0) {
      const gap = seg.start - segments[i - 1].end;
      if (gap > gapMs) speaker = speaker === 1 ? 2 : 1;
    }
    return { ...seg, speaker: `S${speaker}` };
  });
}

/** Merge consecutive same-speaker phrases separated by less than `gapMs`. */
export function mergeSegments(segments, gapMs = 900) {
  const out = [];
  for (const seg of segments) {
    const prev = out[out.length - 1];
    if (prev && prev.speaker === seg.speaker && seg.start - prev.end < gapMs && `${prev.text} ${seg.text}`.length < 900) {
      prev.text = `${prev.text} ${seg.text}`.replace(/\s+/g, ' ');
      prev.end = seg.end;
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}
