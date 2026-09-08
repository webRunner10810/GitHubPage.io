/* IndexedDB persistence.
 *
 * Two object stores so the library list stays cheap to read:
 *   meetings — metadata, transcript segments and analysis (small, read often)
 *   audio    — one Blob per meeting (large, read only on playback/export)
 */

const DB_NAME = 'summary-db';
const DB_VERSION = 1;
const STORE_MEETINGS = 'meetings';
const STORE_AUDIO = 'audio';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_MEETINGS)) {
        const store = db.createObjectStore(STORE_MEETINGS, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(STORE_AUDIO)) {
        db.createObjectStore(STORE_AUDIO, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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
    analysis: null,         // see js/ai.js buildAnalysis()
    chat: [],               // [{ role: 'user'|'assistant', text, at }]
    starred: false,
    ...overrides,
  };
}

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
}

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
