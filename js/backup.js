// backup.js — pack everything into one file, and unpack it again.
//
// The backup is JSON (plain text) squeezed with gzip so it stays small.
// It holds: all GPS points, your manual places/corrections/flights/trips,
// the import log, and your settings.

import { getChunks, getAll, getAllMeta, clearStores, putMany, setMeta, USER_STORES } from './db.js';

const FORMAT = 'scratchmap-backup';
const VERSION = 1;

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}
async function gunzip(blob) {
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export async function buildBackupFile() {
  const chunks = await getChunks();
  const stores = {};
  for (const s of USER_STORES) stores[s] = await getAll(s);
  const meta = await getAllMeta();
  delete meta.lastBackupAt; // set fresh on the device that restores

  const payload = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    pointCount: chunks.reduce((n, c) => n + c.n, 0),
    chunks,
    stores,
    meta,
  };
  const blob = await gzip(JSON.stringify(payload));
  const stamp = new Date().toISOString().slice(0, 10);
  return new File([blob], `scratchmap-backup-${stamp}.json.gz`, { type: 'application/gzip' });
}

/**
 * Hand the file to the iPhone share sheet (Save to Files → iCloud Drive,
 * AirDrop, Google Drive…). Falls back to a normal download on computers.
 * Must be called straight from a tap — Safari only allows sharing then.
 * @returns 'shared' | 'downloaded' | 'cancelled'
 */
export async function shareOrDownload(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
      // Some browsers refuse; fall through to a download.
    }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}

export async function markBackedUp() {
  await setMeta('lastBackupAt', Date.now());
}

/** Read a backup file (gzipped or — if a browser already unzipped it — plain JSON). */
export async function readBackupFile(file) {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const isGzip = head[0] === 0x1f && head[1] === 0x8b;
  const text = isGzip ? await gunzip(file) : await file.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("That file isn't a Scratch Map backup."); }
  if (data.format !== FORMAT) throw new Error("That file isn't a Scratch Map backup.");
  if (data.version > VERSION) throw new Error('This backup was made by a newer version of the app. Update the app first.');
  return data;
}

/** Replace everything in the app with the backup's contents. */
export async function restoreBackup(data) {
  await clearStores(['chunks', ...USER_STORES]);
  await putMany('chunks', data.chunks);
  for (const s of USER_STORES) await putMany(s, data.stores?.[s] ?? []);
  for (const [k, v] of Object.entries(data.meta ?? {})) await setMeta(k, v);
  // Restoring counts as "backed up": the data you have now is in that file.
  await markBackedUp();
}
