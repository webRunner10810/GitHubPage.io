/* Claude Messages API client (browser-direct).
 *
 * The app is a static site with no backend, so requests go straight from the
 * page to https://api.anthropic.com. That path requires the
 * `anthropic-dangerous-direct-browser-access` header, which opts the request
 * into CORS from a browser origin. Responses are streamed so long transcripts
 * cannot hit a request timeout and the UI can show progress.
 */

import { get as getSetting } from './settings.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

/** Transient failures worth retrying, and how many attempts in total. */
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 800;

/** Roughly one token per four characters — used only to decide when to chunk. */
const CHARS_PER_CHUNK = 240_000;

/** Models that reject `output_config.effort` / adaptive thinking. */
const NO_EFFORT_MODELS = new Set(['claude-haiku-4-5']);

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'A specific 3-7 word title for this conversation.' },
    summary: { type: 'string', description: 'A 2-4 sentence abstract of what happened and what it means.' },
    key_points: { type: 'array', items: { type: 'string' }, description: '3-8 substantive points actually discussed.' },
    decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions that were actually settled. Empty if none.' },
    action_items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          owner: { type: 'string', description: 'Name as spoken, or "Unassigned".' },
          due: { type: 'string', description: 'Due date or timeframe as stated, or "" if none.' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['task', 'owner', 'due', 'priority'],
        additionalProperties: false,
      },
    },
    open_questions: { type: 'array', items: { type: 'string' }, description: 'Questions raised but left unresolved.' },
    topics: { type: 'array', items: { type: 'string' }, description: '3-6 short topic tags.' },
    sentiment: {
      type: 'object',
      properties: {
        overall: { type: 'string', enum: ['positive', 'neutral', 'tense', 'mixed'] },
        note: { type: 'string', description: 'One sentence on the tone and how aligned the participants were.' },
      },
      required: ['overall', 'note'],
      additionalProperties: false,
    },
    follow_up_email: { type: 'string', description: 'A short recap email the user could send to participants.' },
  },
  required: ['title', 'summary', 'key_points', 'decisions', 'action_items', 'open_questions', 'topics', 'sentiment', 'follow_up_email'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are the analyst inside Summary, a meeting-notes app.

You are given a transcript produced by automatic speech recognition from a phone microphone. Work with its limitations:
- Punctuation, casing and proper nouns are often wrong. Read through obvious mis-hearings; do not quote them as if they were exact.
- Speaker labels come from a pause-length heuristic and are frequently wrong. Only attribute something to a person when the words themselves make the attribution clear (someone is addressed by name, or introduces themselves).
- Cross-talk, filler and half-sentences are normal. Ignore them.

Rules:
- Report only what the transcript supports. Never invent participants, numbers, dates or commitments.
- An action item requires someone committing to do something. "We should probably look at that someday" is not an action item.
- A decision is a question that got settled, not a topic that got discussed.
- If the recording is too short, too garbled or too empty to analyse, say so plainly in the summary and return empty lists rather than padding.
- Write in plain, concrete language. No filler, no restating the instructions, no meta-commentary about the transcript format.`;

export class ApiError extends Error {
  constructor(message, { status = 0, type = '', retryable = false, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/** True when analysis can run: either a key is set, or a proxy holds one. */
export function hasKey() {
  return usingProxy() || Boolean((getSetting('apiKey') || '').trim());
}

/**
 * Where requests go. Defaults to the Anthropic API directly; point it at a
 * proxy (see proxy/) to keep the key off the device entirely, in which case
 * the app sends no key at all and the proxy supplies it.
 */
function endpoint() {
  const base = (getSetting('apiBaseUrl') || '').trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
  return `${base}/v1/messages`;
}

function usingProxy() {
  const base = (getSetting('apiBaseUrl') || '').trim();
  return Boolean(base) && base.replace(/\/+$/, '') !== DEFAULT_BASE_URL;
}

function headers() {
  const base = {
    'content-type': 'application/json',
    'anthropic-version': API_VERSION,
  };
  if (usingProxy()) return base;
  return {
    ...base,
    'x-api-key': (getSetting('apiKey') || '').trim(),
    // Opts the request into CORS from a browser origin.
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

/** A proxy holds the key server-side, so only the direct path needs one here. */
function requireCredentials() {
  if (usingProxy()) return;
  if (!(getSetting('apiKey') || '').trim()) {
    throw new ApiError('No Anthropic API key is set. Add one in Settings to use AI analysis.', { type: 'no_key' });
  }
}

/** Turn any failure into a message worth showing on a phone screen. */
async function toApiError(res) {
  let type = '';
  let detail = '';
  try {
    const body = await res.json();
    type = body?.error?.type || '';
    detail = body?.error?.message || '';
  } catch { /* non-JSON error body */ }

  const messages = {
    400: 'The API rejected the request as malformed.',
    401: 'That API key was rejected. Check it in Settings.',
    403: 'This API key is not allowed to use the Messages API.',
    404: 'The selected model is not available to this API key.',
    413: 'The transcript was too large for one request.',
    429: 'Rate limited by the API. Wait a moment and try again.',
    500: 'The API had an internal error. Try again.',
    529: 'The API is overloaded right now. Try again in a minute.',
  };
  const message = messages[res.status] || `Request failed (HTTP ${res.status}).`;
  const retryAfter = Number(res.headers.get('retry-after'));
  return new ApiError(detail ? `${message} ${detail}` : message, {
    status: res.status,
    type,
    retryable: res.status === 429 || res.status >= 500,
    retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0,
  });
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(new DOMException('Aborted', 'AbortError'));
  }, { once: true });
});

/**
 * POST a Messages request and stream the text back.
 * @returns {Promise<{text: string, stopReason: string, usage: object}>}
 */
async function streamMessage(body, { onText, signal, onRetry } = {}) {
  requireCredentials();

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted?.();
    try {
      return await streamOnce(body, { onText, signal });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      lastError = err;
      // Only retry transient failures, and only if nothing was emitted yet —
      // a stream that already produced text cannot be safely restarted.
      if (!(err instanceof ApiError) || !err.retryable || err.emitted || attempt === MAX_ATTEMPTS) throw err;
      const wait = err.retryAfterMs || BASE_BACKOFF_MS * 2 ** (attempt - 1);
      onRetry?.({ attempt, of: MAX_ATTEMPTS, waitMs: wait, message: err.message });
      await sleep(wait, signal);
    }
  }
  throw lastError;
}

/**
 * Incremental Server-Sent Events decoder.
 *
 * Pure and framing-only: `push` takes whatever arrived and returns the JSON
 * payloads of any complete frames, holding the remainder for next time.
 */
export class SseDecoder {
  constructor() {
    this.buffer = '';
    this.decoder = new TextDecoder();
  }

  /**
   * @param {Uint8Array|string} chunk
   * @returns {object[]} parsed `data:` payloads from complete frames
   */
  push(chunk) {
    const text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    this.buffer += text.replace(/\r\n/g, '\n');

    const events = [];
    let split;
    while ((split = this.buffer.indexOf('\n\n')) !== -1) {
      const frame = this.buffer.slice(0, split);
      this.buffer = this.buffer.slice(split + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          events.push(JSON.parse(payload));
        } catch {
          // A truncated or malformed frame is not worth failing the stream over.
        }
      }
    }
    return events;
  }
}

/** One attempt: POST, then fold the SSE events into a message. */
async function streamOnce(body, { onText, signal } = {}) {
  let res;
  try {
    res = await fetch(endpoint(), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(
      navigator.onLine
        ? 'Could not reach the API. Check your connection and try again.'
        : 'You are offline. Connect to a network to run AI analysis.',
      { type: 'network', retryable: true },
    );
  }
  if (!res.ok) throw await toApiError(res);
  if (!res.body) throw new ApiError('The API returned an empty response.', { status: res.status, retryable: true });

  const reader = res.body.getReader();
  const sse = new SseDecoder();
  const message = { text: '', stopReason: '', stopDetails: null, usage: {} };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const event of sse.push(value)) applyEvent(message, event, onText);
    }
  } catch (err) {
    // A stream that already produced text cannot be safely replayed, so mark
    // it and let the retry loop give up rather than duplicate output.
    if (err instanceof ApiError) err.emitted = message.text.length > 0;
    throw err;
  }

  if (message.stopReason === 'refusal') {
    const category = message.stopDetails?.category ? ` (${message.stopDetails.category})` : '';
    throw new ApiError(`Claude declined to analyse this recording${category}.`, { type: 'refusal' });
  }
  return { text: message.text, stopReason: message.stopReason, usage: message.usage };
}

/** Fold one streaming event into the accumulating message. */
function applyEvent(message, event, onText) {
  switch (event.type) {
    case 'content_block_delta':
      if (event.delta?.type === 'text_delta') {
        message.text += event.delta.text;
        onText?.(event.delta.text, message.text);
      }
      break;
    case 'message_delta':
      if (event.delta?.stop_reason) message.stopReason = event.delta.stop_reason;
      if (event.delta?.stop_details) message.stopDetails = event.delta.stop_details;
      if (event.usage) message.usage = { ...message.usage, ...event.usage };
      break;
    case 'message_start':
      if (event.message?.usage) message.usage = { ...message.usage, ...event.message.usage };
      break;
    case 'error':
      throw new ApiError(event.error?.message || 'The API reported a streaming error.', {
        type: event.error?.type || 'stream_error',
        retryable: true,
      });
    default:
      break;
  }
}

/** Base request fields shared by every call, honouring the model's capabilities. */
function baseRequest({ maxTokens = 8000 } = {}) {
  const model = getSetting('model') || 'claude-opus-5';
  const req = { model, max_tokens: maxTokens };
  if (!NO_EFFORT_MODELS.has(model)) {
    req.output_config = { effort: getSetting('effort') || 'high' };
  }
  return req;
}

function transcriptText(meeting) {
  const names = meeting.speakers || {};
  return (meeting.segments || [])
    .map((s) => {
      const who = s.speaker ? (names[s.speaker] || s.speaker) : '';
      const stamp = formatStamp(s.start);
      return who ? `[${stamp}] ${who}: ${s.text}` : `[${stamp}] ${s.text}`;
    })
    .join('\n');
}

function formatStamp(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function contextBlock(meeting) {
  const standing = (getSetting('meetingContext') || '').trim();
  const lines = [];
  lines.push(`Recorded: ${new Date(meeting.createdAt).toLocaleString()}`);
  lines.push(`Length: ${Math.round((meeting.durationMs || 0) / 60000)} minutes`);
  lines.push(`Capture: ${meeting.source === 'call' ? 'phone call on speakerphone, recorded through the handset microphone' : 'in-person or device microphone'}`);
  if (meeting.title) lines.push(`User-supplied title: ${meeting.title}`);
  if (standing) lines.push(`Standing context from the user: ${standing}`);
  return lines.join('\n');
}

/** Split a long transcript on segment boundaries. */
function chunkTranscript(text, size = CHARS_PER_CHUNK) {
  if (text.length <= size) return [text];
  const lines = text.split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if (current.length + line.length + 1 > size && current) {
      chunks.push(current);
      current = '';
    }
    current += `${line}\n`;
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

/**
 * Analyse a meeting into structured notes.
 * @param {object} meeting
 * @param {{onProgress?: (stage: string, pct: number) => void, signal?: AbortSignal}} opts
 */
export async function analyzeMeeting(meeting, { onProgress, signal, onRetry } = {}) {
  const transcript = transcriptText(meeting);
  if (!transcript.trim()) {
    throw new ApiError('There is no transcript to analyse yet.', { type: 'empty' });
  }

  const chunks = chunkTranscript(transcript);
  let material = transcript;
  let materialLabel = 'TRANSCRIPT';

  if (chunks.length > 1) {
    // Map: condense each slice, then reduce over the condensed notes.
    const notes = [];
    for (let i = 0; i < chunks.length; i += 1) {
      onProgress?.(`Reading part ${i + 1} of ${chunks.length}`, (i / chunks.length) * 0.7);
      const { text } = await streamMessage({
        ...baseRequest({ maxTokens: 4000 }),
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `This is part ${i + 1} of ${chunks.length} of a long transcript. Write dense notes covering everything decided, committed to, questioned or agreed in this part. Keep names, numbers and dates verbatim. Do not summarise away detail — later parts depend on it.\n\n<transcript_part>\n${chunks[i]}\n</transcript_part>`,
        }],
      }, { signal, onRetry });
      notes.push(`--- Part ${i + 1} ---\n${text}`);
    }
    material = notes.join('\n\n');
    materialLabel = 'NOTES FROM A LONG TRANSCRIPT';
  }

  onProgress?.('Writing the summary', 0.75);

  const request = baseRequest({ maxTokens: 8000 });
  const tag = materialLabel.toLowerCase().replace(/ /g, '_');
  const { text } = await streamMessage({
    ...request,
    system: SYSTEM_PROMPT,
    output_config: {
      ...(request.output_config || {}),
      format: { type: 'json_schema', schema: ANALYSIS_SCHEMA },
    },
    messages: [{
      role: 'user',
      content: `<context>\n${contextBlock(meeting)}\n</context>\n\n<${tag}>\n${material}\n</${tag}>\n\nProduce the structured meeting notes.`,
    }],
  }, {
    signal,
    onRetry,
    onText: (_delta, full) => {
      // Rough progress from output length — enough to keep the bar moving.
      onProgress?.('Writing the summary', Math.min(0.98, 0.75 + (full.length / 4000) * 0.23));
    },
  });

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError('The model returned a response that could not be read as notes. Try again.', { type: 'parse', retryable: true });
  }

  onProgress?.('Done', 1);
  return normalizeAnalysis(data, { provider: 'anthropic', model: getSetting('model') });
}

/** Fill in anything missing so views never have to null-check deeply. */
export function normalizeAnalysis(data, meta = {}) {
  const arr = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);
  return {
    title: String(data?.title || '').trim(),
    summary: String(data?.summary || '').trim(),
    keyPoints: arr(data?.key_points ?? data?.keyPoints).map(String),
    decisions: arr(data?.decisions).map(String),
    actionItems: arr(data?.action_items ?? data?.actionItems).map((item, i) => ({
      id: item.id || `a${i}`,
      task: String(item.task || '').trim(),
      owner: String(item.owner || 'Unassigned').trim() || 'Unassigned',
      due: String(item.due || '').trim(),
      priority: ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium',
      done: Boolean(item.done),
    })).filter((item) => item.task),
    openQuestions: arr(data?.open_questions ?? data?.openQuestions).map(String),
    topics: arr(data?.topics).map(String),
    sentiment: {
      overall: ['positive', 'neutral', 'tense', 'mixed'].includes(data?.sentiment?.overall) ? data.sentiment.overall : 'neutral',
      note: String(data?.sentiment?.note || '').trim(),
    },
    followUpEmail: String(data?.follow_up_email ?? data?.followUpEmail ?? '').trim(),
    provider: meta.provider || 'local',
    model: meta.model || '',
    generatedAt: Date.now(),
  };
}

/** Free-form follow-up question about one meeting. Streams the answer back. */
export async function askAboutMeeting(meeting, question, { onText, signal, onRetry, history = [] } = {}) {
  const transcript = transcriptText(meeting);
  const priorTurns = history.slice(-8).map((turn) => ({
    role: turn.role === 'assistant' ? 'assistant' : 'user',
    content: turn.text,
  }));

  const { text } = await streamMessage({
    ...baseRequest({ maxTokens: 4000 }),
    system: `${SYSTEM_PROMPT}\n\nThe user is asking follow-up questions about one recording. Answer only from the transcript below. If the answer is not in it, say so in one sentence. Be brief — this is read on a phone.\n\n<context>\n${contextBlock(meeting)}\n</context>\n\n<transcript>\n${transcript}\n</transcript>`,
    messages: [...priorTurns, { role: 'user', content: question }],
  }, { onText, signal, onRetry });

  return text.trim();
}

/** Cheap round-trip used by the "Test key" button in Settings. */
export async function testConnection() {
  const { text } = await streamMessage({
    ...baseRequest({ maxTokens: 32 }),
    messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
  });
  return text.trim();
}
