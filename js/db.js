/* IndexedDB persistence.
 *
 * Four object stores:
 *   meetings    — metadata, transcript segments and analysis (small, read often)
 *   audio       — one finished Blob per meeting (large, read on playback/export)
 *   liveSession — the single in-progress recording, if any
 *   liveChunks  — that recording's audio chunks as they arrive
 *
 * The two `live*` stores exist because Android kills backgrounded tabs without
 * warning. Everything is written as it is captured, so an interrupted meeting
 * is recoverable on the next launch instead of lost, and a three-hour
 * recording never has to sit in memory.
 */

const DB_NAME = 'summary-db';
const DB_VERSION = 2;
const STORE_MEETINGS = 'meetings';
const STORE_AUDIO = 'audio';
const STORE_LIVE = 'liveSession';
const STORE_LIVE_CHUNKS = 'liveChunks';

const LIVE_ID = 'current';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_MEETINGS)) {
        db.createObjectStore(STORE_MEETINGS, { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(STORE_AUDIO)) {
        db.createObjectStore(STORE_AUDIO, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_LIVE)) {
        db.createObjectStore(STORE_LIVE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_LIVE_CHUNKS)) {
        db.createObjectStore(STORE_LIVE_CHUNKS, { keyPath: ['meetingId', 'index'] });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Another tab is holding an older version of the database open.'));
  });
  return dbPromise;
}

function tx(store, mode, run) {
  return open().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = run(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request ? request.result : undefined);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  }));
}

/** True when a write failed because the origin is out of storage. */
export function isQuotaError(err) {
  return err?.name === 'QuotaExceededError'
    || err?.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || err?.code === 22;
}

/** Blank meeting record — the single source of truth for the shape we store. */
export function newMeeting(overrides = {}) {
  const now = Date.now();
  return {
    id: overrides.id || (crypto.randomUUID ? crypto.randomUUID() : String(now)),
    title: '',
    createdAt: now,
    updatedAt: now,
    durationMs: 0,
    source: 'mic',          // 'mic' | 'call'
    language: 'en-US',
    hasAudio: false,
    audioType: '',
    audioSize: 0,
    segments: [],           // [{ id, start, end, speaker, text }]
    speakers: {},           // { 'S1': 'Alex' } — user-supplied display names
    analysis: null,         // see js/ai.js normalizeAnalysis()
    chat: [],               // [{ role: 'user'|'assistant', text, at }]
    starred: false,
    recovered: false,       // rebuilt from an interrupted session
    ...overrides,
  };
}

/* ------------------------------------------------------------- meetings -- */

export async function saveMeeting(meeting) {
  const record = { ...meeting, updatedAt: Date.now() };
  await tx(STORE_MEETINGS, 'readwrite', (store) => store.put(record));
  return record;
}

export function getMeeting(id) {
  return tx(STORE_MEETINGS, 'readonly', (store) => store.get(id));
}

export async function listMeetings() {
  const all = await tx(STORE_MEETINGS, 'readonly', (store) => store.getAll());
  return (all || []).sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteMeeting(id) {
  await tx(STORE_MEETINGS, 'readwrite', (store) => store.delete(id));
  await tx(STORE_AUDIO, 'readwrite', (store) => store.delete(id));
}

export async function saveAudio(id, blob) {
  await tx(STORE_AUDIO, 'readwrite', (store) => store.put({ id, blob, type: blob.type, size: blob.size }));
}

export async function getAudio(id) {
  const row = await tx(STORE_AUDIO, 'readonly', (store) => store.get(id));
  return row ? row.blob : null;
}

export async function clearAll() {
  await tx(STORE_MEETINGS, 'readwrite', (store) => store.clear());
  await tx(STORE_AUDIO, 'readwrite', (store) => store.clear());
  await clearLiveSession();
}

/* --------------------------------------------------------- live session -- */

/**
 * Start tracking an in-progress recording. Replaces any previous one — the app
 * only ever records a single meeting at a time.
 */
export async function beginLiveSession({ meetingId, source, language, mimeType, keepAudio }) {
  await clearLiveSession();
  const session = {
    id: LIVE_ID,
    meetingId,
    source,
    language,
    mimeType,
    keepAudio,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    durationMs: 0,
    chunkCount: 0,
    segments: [],
    audioDropped: false,
  };
  await tx(STORE_LIVE, 'readwrite', (store) => store.put(session));
  return session;
}

export function getLiveSession() {
  return tx(STORE_LIVE, 'readonly', (store) => store.get(LIVE_ID));
}

/** Merge fields into the live session row. No-op if there is no session. */
export async function updateLiveSession(patch) {
  const current = await getLiveSession();
  if (!current) return null;
  const next = { ...current, ...patch, id: LIVE_ID, updatedAt: Date.now() };
  await tx(STORE_LIVE, 'readwrite', (store) => store.put(next));
  return next;
}

/** Persist one audio chunk. Throws on quota so the caller can react. */
export function appendLiveChunk(meetingId, index, blob) {
  return tx(STORE_LIVE_CHUNKS, 'readwrite', (store) => store.put({ meetingId, index, blob }));
}

/** Reassemble the recorded audio from its persisted chunks, in order. */
export async function assembleLiveAudio(meetingId, mimeType) {
  const range = IDBKeyRange.bound([meetingId, -Infinity], [meetingId, Infinity]);
  const rows = await tx(STORE_LIVE_CHUNKS, 'readonly', (store) => store.getAll(range));
  if (!rows?.length) return null;
  rows.sort((a, b) => a.index - b.index);
  return new Blob(rows.map((r) => r.blob), { type: mimeType || 'audio/webm' });
}

export async function clearLiveSession() {
  const current = await getLiveSession().catch(() => null);
  if (current?.meetingId) {
    const range = IDBKeyRange.bound([current.meetingId, -Infinity], [current.meetingId, Infinity]);
    await tx(STORE_LIVE_CHUNKS, 'readwrite', (store) => store.delete(range));
  }
  await tx(STORE_LIVE_CHUNKS, 'readwrite', (store) => store.clear());
  await tx(STORE_LIVE, 'readwrite', (store) => store.delete(LIVE_ID));
}

/* ------------------------------------------------------------- storage --- */

/** Browser-reported storage usage, when the Storage API is available. */
export async function usage() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage: used = 0, quota = 0 } = await navigator.storage.estimate();
    return { used, quota };
  } catch {
    return null;
  }
}

/** Ask Android/Chrome not to evict our recordings under storage pressure. */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
