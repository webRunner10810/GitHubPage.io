/* Microphone capture.
 *
 * Wraps getUserMedia + MediaRecorder and exposes a monotonic recording clock
 * that excludes paused time, so transcript timestamps line up with the saved
 * audio file on playback.
 */

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',   // Chrome/Android — what a Pixel 7 will pick
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',                // Safari/iOS
  'audio/ogg;codecs=opus',
];

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const type of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return '';
}

export function isSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined';
}

export class Recorder extends EventTarget {
  constructor() {
    super();
    this.state = 'idle';        // idle | recording | paused | stopped
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.mimeType = '';
    this.wakeLock = null;
    this._startedAt = 0;        // performance.now() when the current run began
    this._accumulated = 0;      // ms recorded before the current run
    this._raf = 0;
    this._audioCtx = null;
    this._analyser = null;
    this._levelBuf = null;
  }

  /** Milliseconds of audio captured so far, excluding paused time. */
  elapsed() {
    if (this.state === 'recording') return this._accumulated + (performance.now() - this._startedAt);
    return this._accumulated;
  }

  async start({ captureAudio = true } = {}) {
    if (this.state === 'recording' || this.state === 'paused') return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    this._startMeter();

    if (captureAudio) {
      this.mimeType = pickMimeType();
      this.recorder = new MediaRecorder(this.stream, this.mimeType ? { mimeType: this.mimeType, audioBitsPerSecond: 64000 } : undefined);
      this.chunks = [];
      this.recorder.ondataavailable = (e) => {
        if (e.data && e.data.size) this.chunks.push(e.data);
      };
      this.recorder.onerror = (e) => this.dispatchEvent(new CustomEvent('error', { detail: e.error || e }));
      // A 1s timeslice keeps data flushing so a crash loses at most a second.
      this.recorder.start(1000);
    }

    this._accumulated = 0;
    this._startedAt = performance.now();
    this.state = 'recording';
    this._acquireWakeLock();
    this.dispatchEvent(new CustomEvent('statechange', { detail: this.state }));
  }

  pause() {
    if (this.state !== 'recording') return;
    this._accumulated += performance.now() - this._startedAt;
    if (this.recorder?.state === 'recording') this.recorder.pause();
    this.state = 'paused';
    this.dispatchEvent(new CustomEvent('statechange', { detail: this.state }));
  }

  resume() {
    if (this.state !== 'paused') return;
    this._startedAt = performance.now();
    if (this.recorder?.state === 'paused') this.recorder.resume();
    this.state = 'recording';
    this._acquireWakeLock();
    this.dispatchEvent(new CustomEvent('statechange', { detail: this.state }));
  }

  /** Stops capture and resolves with { blob, mimeType, durationMs }. */
  async stop() {
    if (this.state === 'idle' || this.state === 'stopped') {
      return { blob: null, mimeType: this.mimeType, durationMs: this.elapsed() };
    }
    if (this.state === 'recording') this._accumulated += performance.now() - this._startedAt;
    const durationMs = this._accumulated;

    const blob = await new Promise((resolve) => {
      if (!this.recorder || this.recorder.state === 'inactive') {
        resolve(this.chunks.length ? new Blob(this.chunks, { type: this.mimeType || 'audio/webm' }) : null);
        return;
      }
      this.recorder.onstop = () => {
        resolve(this.chunks.length ? new Blob(this.chunks, { type: this.mimeType || 'audio/webm' }) : null);
      };
      try {
        this.recorder.stop();
      } catch {
        resolve(this.chunks.length ? new Blob(this.chunks, { type: this.mimeType || 'audio/webm' }) : null);
      }
    });

    this._teardown();
    this.state = 'stopped';
    this.dispatchEvent(new CustomEvent('statechange', { detail: this.state }));
    return { blob, mimeType: this.mimeType, durationMs };
  }

  /** Abandon the recording without producing a file. */
  cancel() {
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    } catch { /* already stopped */ }
    this.chunks = [];
    this._teardown();
    this.state = 'idle';
    this._accumulated = 0;
    this.dispatchEvent(new CustomEvent('statechange', { detail: this.state }));
  }

  /* ------------------------------------------------------------ metering */

  _startMeter() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this._audioCtx = new Ctx();
    const source = this._audioCtx.createMediaStreamSource(this.stream);
    this._analyser = this._audioCtx.createAnalyser();
    this._analyser.fftSize = 1024;
    this._analyser.smoothingTimeConstant = 0.75;
    source.connect(this._analyser);
    this._levelBuf = new Uint8Array(this._analyser.fftSize);

    const tick = () => {
      this._raf = requestAnimationFrame(tick);
      if (!this._analyser || this.state !== 'recording') {
        this.dispatchEvent(new CustomEvent('level', { detail: 0 }));
        return;
      }
      this._analyser.getByteTimeDomainData(this._levelBuf);
      let sum = 0;
      for (let i = 0; i < this._levelBuf.length; i += 1) {
        const v = (this._levelBuf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / this._levelBuf.length);
      // Perceptual-ish curve: quiet speech should still move the meter.
      const level = Math.min(1, Math.pow(rms * 3.4, 0.72));
      this.dispatchEvent(new CustomEvent('level', { detail: level }));
    };
    tick();
  }

  _teardown() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._analyser = null;
    if (this._audioCtx) {
      this._audioCtx.close().catch(() => {});
      this._audioCtx = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this._releaseWakeLock();
  }

  /* ----------------------------------------------------------- wake lock */

  async _acquireWakeLock() {
    if (!('wakeLock' in navigator) || this.wakeLock) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
    } catch { /* denied, low battery, or backgrounded — recording continues */ }
  }

  _releaseWakeLock() {
    if (!this.wakeLock) return;
    this.wakeLock.release().catch(() => {});
    this.wakeLock = null;
  }

  /** Re-request the lock after the tab comes back to the foreground. */
  refreshWakeLock() {
    if (this.state === 'recording' && !this.wakeLock) this._acquireWakeLock();
  }
}
