// db.js — everything the app saves lives here, in the browser's IndexedDB.
//
// GPS points are stored in "day chunks": one record per UTC day holding
// parallel number arrays (t, lat, lon, ...). Storing millions of points as
// separate records would be slow on a phone; a few thousand day-records is fast.
//
// Your own edits (manual places, corrections, flights, trips) live in their own
// stores, completely separate from GPS data, so re-importing never touches them.

const DB_NAME = 'scratchmap';
const DB_VERSION = 2;

export const STORES = {
  chunks: 'chunks',         // key: 'YYYY-MM-DD' (UTC) → { day, t[], lat[], lon[], acc[], spd[], alt[] }
  meta: 'meta',             // key → value (settings, lastBackupAt, lastImportAt…)
  imports: 'imports',       // log of every imported file
  savedPlaces: 'savedPlaces', // pins imported from Scoria
  manualPlaces: 'manualPlaces',
  corrections: 'corrections',
  flights: 'flights',
  trips: 'trips',
  dayVisits: 'dayVisits',   // key: 'YYYY-MM-DD' (UTC) → which places were visited that day (re-computable, not backed up)
};

// Stores that hold *your* data (not raw GPS) — all go into backups as-is.
export const USER_STORES = ['savedPlaces', 'manualPlaces', 'corrections', 'flights', 'trips', 'imports'];

let dbPromise;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: 'day' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('dayVisits')) db.createObjectStore('dayVisits', { keyPath: 'day' });
      for (const s of USER_STORES) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Ask the browser not to clear our data when space runs low.
// (Safari may still clear it — that's why backups matter.)
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* not supported */ }
  return false;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------- meta (small key/value settings) ----------

export async function getMeta(key, fallback = undefined) {
  const db = await openDB();
  const v = await wrap(db.transaction('meta').objectStore('meta').get(key));
  return v === undefined ? fallback : v;
}
export async function setMeta(key, value) {
  const db = await openDB();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(value, key);
  return done(tx);
}
export async function getAllMeta() {
  const db = await openDB();
  const store = db.transaction('meta').objectStore('meta');
  const [keys, values] = await Promise.all([wrap(store.getAllKeys()), wrap(store.getAll())]);
  return Object.fromEntries(keys.map((k, i) => [k, values[i]]));
}

// ---------- generic record stores ----------

export async function getAll(storeName) {
  const db = await openDB();
  return wrap(db.transaction(storeName).objectStore(storeName).getAll());
}
export async function add(storeName, record) {
  const db = await openDB();
  return wrap(db.transaction(storeName, 'readwrite').objectStore(storeName).add(record));
}
export async function put(storeName, record) {
  const db = await openDB();
  return wrap(db.transaction(storeName, 'readwrite').objectStore(storeName).put(record));
}

// ---------- GPS point chunks ----------

export const dayKey = (unixSeconds) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

const FIELDS = ['t', 'lat', 'lon', 'acc', 'spd', 'alt'];

/**
 * Merge new points into the day chunks. Points already stored (same timestamp)
 * are skipped — that's the dedupe. Returns how many points were actually new.
 * @param {Array<{t,lat,lon,acc,spd,alt}>} points
 */
export async function mergePoints(points) {
  const byDay = new Map();
  for (const p of points) {
    const k = dayKey(p.t);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(p);
  }

  const db = await openDB();
  const tx = db.transaction('chunks', 'readwrite');
  const store = tx.objectStore('chunks');
  let added = 0;
  const newDays = [];

  for (const [day, incoming] of byDay) {
    const existing = await wrap(store.get(day));
    const map = new Map(); // timestamp → point
    if (existing) {
      for (let i = 0; i < existing.t.length; i++) {
        map.set(existing.t[i], Object.fromEntries(FIELDS.map((f) => [f, existing[f][i]])));
      }
    } else {
      newDays.push(day);
    }
    for (const p of incoming) {
      if (!map.has(p.t)) { map.set(p.t, p); added++; }
    }
    const sorted = [...map.values()].sort((a, b) => a.t - b.t);
    const rec = { day, n: sorted.length };
    for (const f of FIELDS) rec[f] = sorted.map((p) => p[f] ?? null);
    store.put(rec);
  }
  await done(tx);
  return { added, newDays };
}

/** Read chunks between two 'YYYY-MM-DD' keys (inclusive). Either may be null = open-ended. */
export async function getChunks(fromDay = null, toDay = null) {
  const db = await openDB();
  let range = null;
  if (fromDay && toDay) range = IDBKeyRange.bound(fromDay, toDay);
  else if (fromDay) range = IDBKeyRange.lowerBound(fromDay);
  else if (toDay) range = IDBKeyRange.upperBound(toDay);
  return wrap(db.transaction('chunks').objectStore('chunks').getAll(range));
}

/** Quick summary without loading every point into the map. */
export async function getPointStats() {
  const chunks = await getChunks();
  let count = 0;
  for (const c of chunks) count += c.n;
  return {
    count,
    days: chunks.length,
    firstT: chunks.length ? chunks[0].t[0] : null,
    lastT: chunks.length ? chunks[chunks.length - 1].t.at(-1) : null,
  };
}

// ---------- wipe / restore helpers ----------

export async function clearStores(names) {
  const db = await openDB();
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  return done(tx);
}

export async function putMany(storeName, records) {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  const s = tx.objectStore(storeName);
  for (const r of records) s.put(r);
  return done(tx);
}

export async function del(storeName, key) {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).delete(key);
  return done(tx);
}
