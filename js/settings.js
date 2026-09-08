/* User preferences, persisted in localStorage.
 *
 * The Anthropic API key lives here too. That is a deliberate trade-off for a
 * static, server-less app: the key never leaves the device except in the
 * Authorization header of a request the user triggered, but anything with
 * script access to this origin can read it. Settings says so plainly, and the
 * app is fully usable with no key at all (offline summaries).
 */

const KEY = 'summary.settings.v1';

const DEFAULTS = {
  apiKey: '',
  model: 'claude-opus-5',
  effort: 'high',
  language: 'en-US',
  captureMode: 'both',        // both | audio | transcript
  autoAnalyze: true,          // run the AI pass as soon as a recording is saved
  autoSpeakers: true,
  speakerGapMs: 1500,
  keepAudio: true,
  meetingContext: '',         // optional standing context: team, project, jargon
};

let cache = null;

function read() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function getSettings() {
  return { ...read() };
}

export function get(name) {
  return read()[name];
}

export function setSettings(patch) {
  cache = { ...read(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch { /* private mode or quota — settings stay in memory for this session */ }
  window.dispatchEvent(new CustomEvent('settings-changed', { detail: { ...cache } }));
  return { ...cache };
}

export function resetSettings() {
  cache = { ...DEFAULTS };
  try { localStorage.removeItem(KEY); } catch { /* ignored */ }
  window.dispatchEvent(new CustomEvent('settings-changed', { detail: { ...cache } }));
}

export const MODELS = [
  ['claude-opus-5', 'Claude Opus 5 — best quality'],
  ['claude-sonnet-5', 'Claude Sonnet 5 — faster, cheaper'],
  ['claude-haiku-4-5', 'Claude Haiku 4.5 — fastest'],
];

export const EFFORTS = [
  ['low', 'Low — quickest, cheapest'],
  ['medium', 'Medium'],
  ['high', 'High — recommended'],
  ['xhigh', 'Very high — most thorough'],
];
