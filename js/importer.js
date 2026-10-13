// importer.js — reads a Scoria ".sqlite" export right here in the browser.
//
// sql.js is SQLite (the database engine Scoria uses) compiled to WebAssembly,
// so the file never leaves your phone.

import { mergePoints, add, getAll, setMeta } from './db.js';

let sqlPromise;
function loadSqlJs() {
  if (sqlPromise) return sqlPromise;
  sqlPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/sqljs/sql-wasm.js';
    s.onload = () =>
      window.initSqlJs({ locateFile: (f) => `vendor/sqljs/${f}` }).then(resolve, reject);
    s.onerror = () => reject(new Error('Could not load the SQLite reader (sql.js).'));
    document.head.appendChild(s);
  });
  return sqlPromise;
}

function rows(db, sql) {
  const res = db.exec(sql);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
}

/**
 * Import one Scoria file.
 * @param {File} file
 * @param {{maxAccuracy:number}} settings
 * @returns summary object shown to the user
 */
export async function importScoriaFile(file, settings) {
  const SQL = await loadSqlJs();
  const bytes = new Uint8Array(await file.arrayBuffer());

  // Every SQLite file starts with the text "SQLite format 3".
  const header = new TextDecoder().decode(bytes.slice(0, 15));
  if (header !== 'SQLite format 3') {
    throw new Error(`"${file.name}" isn't a SQLite database. In Scoria use "Export database".`);
  }

  const db = new SQL.Database(bytes);
  try {
    const tables = rows(db, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
    if (!tables.includes('location')) {
      throw new Error(`"${file.name}" has no "location" table — is it really a Scoria export?`);
    }

    // Only ask for real columns (Scoria also has computed "virtual" columns we don't need).
    const cols = rows(db, 'PRAGMA table_info(location)').map((r) => r.name);
    const has = (c) => cols.includes(c);
    const select = [
      'timestamp', 'latitude', 'longitude',
      has('horizontal_accuracy') ? 'horizontal_accuracy' : 'NULL AS horizontal_accuracy',
      has('speed') ? 'speed' : 'NULL AS speed',
      has('msl_altitude') ? 'msl_altitude' : 'NULL AS msl_altitude',
      has('is_simulated_by_software') ? 'is_simulated_by_software' : '0 AS is_simulated_by_software',
    ].join(', ');

    const stmt = db.prepare(`SELECT ${select} FROM location ORDER BY timestamp`);
    const kept = [];
    let total = 0, badAccuracy = 0, simulated = 0, invalid = 0;
    let fileFirst = null, fileLast = null;

    while (stmt.step()) {
      const [t, lat, lon, acc, spd, alt, sim] = stmt.get();
      total++;
      if (fileFirst === null) fileFirst = t;
      fileLast = t;
      if (sim === 1) { simulated++; continue; }
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { invalid++; continue; }
      if (acc != null && acc > settings.maxAccuracy) { badAccuracy++; continue; }
      kept.push(cleanPoint(t, lat, lon, acc, spd, alt));
    }
    stmt.free();

    // Saved places ("pins") from Scoria, if any — skip ones we already have.
    let pinsAdded = 0;
    if (tables.includes('pins')) {
      const existing = new Set((await getAll('savedPlaces')).map((p) => `${p.lat},${p.lon},${p.name}`));
      for (const p of rows(db, 'SELECT lat, lng, name, icon, tags FROM pins')) {
        const key = `${p.lat},${p.lng},${p.name}`;
        if (existing.has(key)) continue;
        await add('savedPlaces', { lat: p.lat, lon: p.lng, name: p.name, icon: p.icon, tags: p.tags, source: 'scoria' });
        pinsAdded++;
      }
    }

    return saveImported(file.name, 'Scoria', kept, {
      pointsInFile: total, skippedAccuracy: badAccuracy, skippedSimulated: simulated,
      skippedInvalid: invalid, fileFirstT: fileFirst, fileLastT: fileLast, pinsAdded,
    });
  } finally {
    db.close();
  }
}

/** Round and tidy one GPS point the same way for every file format. */
export function cleanPoint(t, lat, lon, acc = null, spd = null, alt = null) {
  return {
    t: Math.round(t),
    lat: Math.round(lat * 1e6) / 1e6,
    lon: Math.round(lon * 1e6) / 1e6,
    acc: acc == null || !Number.isFinite(acc) ? null : Math.round(acc),
    spd: spd == null || !Number.isFinite(spd) || spd < 0 ? null : Math.round(spd * 10) / 10,
    alt: alt == null || !Number.isFinite(alt) ? null : Math.round(alt),
  };
}

/** Merge the points into your history (skipping ones you already have) and log the import. */
export async function saveImported(fileName, format, kept, info) {
  const { added, newDays } = await mergePoints(kept);
  const summary = {
    fileName,
    format,
    importedAt: Date.now(),
    kept: kept.length,
    newPoints: added,
    alreadyHad: kept.length - added,
    newDays: newDays.length,
    skippedAccuracy: 0,
    skippedSimulated: 0,
    skippedInvalid: 0,
    skippedNoTime: 0,
    pinsAdded: 0,
    ...info,
  };
  await add('imports', summary);
  await setMeta('lastImportAt', summary.importedAt);
  return summary;
}
