// places.js — works out which countries / regions / provinces you've been in,
// and on which (local) dates.
//
// How it works, in short:
//   1. Every GPS point is snapped to a ~1 km grid square, so a day with
//      thousands of points shrinks to a handful of squares to check.
//   2. Points moving faster than a ground vehicle are skipped, so flights
//      never make a place "visited".
//   3. Each square is looked up in the region borders ("which shape is this
//      point inside?"). The region also tells us the country and time zone.
//   4. The time of the point, in that region's time zone, gives the local date.
// Results are saved per day (the "dayVisits" store) so that a later import
// only has to analyse the days that changed.

import { distanceKm } from './tracks.js';
import { getChunks, getAll, putMany, clearStores } from './db.js';

const ANALYSIS_VERSION = 1; // bump when the analysis logic changes → everything is recomputed
const CELL = 100;           // grid squares of 1/100 degree (~1.1 km)

// ---------- border data + spatial index ----------

class GeoIndex {
  constructor(fc) {
    this.features = fc.features;
    this.byId = new Map();
    this.grid = new Map(); // "lon,lat" (whole degrees) → feature indices
    this.features.forEach((f, i) => {
      this.byId.set(f.properties.id, f);
      const b = bbox(f.geometry);
      f.bbox = b;
      for (let x = Math.floor(b[0]); x <= Math.floor(b[2]); x++) {
        for (let y = Math.floor(b[1]); y <= Math.floor(b[3]); y++) {
          const k = `${x},${y}`;
          if (!this.grid.has(k)) this.grid.set(k, []);
          this.grid.get(k).push(i);
        }
      }
    });
  }
  /** The feature containing (lon, lat), or null. */
  find(lon, lat, filter) {
    const cands = this.grid.get(`${Math.floor(lon)},${Math.floor(lat)}`);
    if (!cands) return null;
    for (const i of cands) {
      const f = this.features[i];
      const b = f.bbox;
      if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      if (filter && !filter(f)) continue;
      if (inGeometry(lon, lat, f.geometry)) return f;
    }
    return null;
  }
}

export function bbox(g) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const poly of polys) for (const [x, y] of poly[0]) {
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
  }
  return b;
}

// "Ray casting": draw a line from the point to the right and count how many
// borders it crosses. Odd = inside. Works with holes (lakes, enclaves) too.
function inRings(x, y, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
function inGeometry(x, y, g) {
  if (g.type === 'Polygon') return inRings(x, y, g.coordinates);
  for (const poly of g.coordinates) if (inRings(x, y, poly)) return true;
  return false;
}

let boundaries; // { countries, admin1, admin2, idx1, idx2, version }
export async function loadBoundaries() {
  if (boundaries) return boundaries;
  const get = (f) => fetch(`data/${f}`).then((r) => {
    if (!r.ok) throw new Error(`Could not load border data (${f}).`);
    return r.json();
  });
  const [countries, admin1, admin2] = await Promise.all([get('countries.json'), get('admin1.json'), get('admin2-ne.json')]);
  boundaries = {
    countries, admin1, admin2,
    idx1: new GeoIndex(admin1),
    idx2: new GeoIndex(admin2),
    countryById: new Map(countries.features.map((f) => [f.properties.id, f.properties])),
    // Countries whose level-2 units we have (for now: the "grouped" ones like Spain)
    level2Countries: new Set(admin2.features.map((f) => f.properties.a0)),
  };
  return boundaries;
}

// ---------- local dates ----------

const fmtCache = new Map();
function localDate(t, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }); }
    catch { f = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }); }
    fmtCache.set(tz, f);
  }
  return f.format(new Date(t * 1000)); // "2026-08-03"
}

// ---------- analysing one day-chunk ----------

function analyseChunk(chunk, b, settings, cellCache) {
  // key "level|id|date" → [level, id, date, firstT, lastT, count, west, south, east, north]
  const hits = new Map();
  const dateCache = new Map(); // "tz|15-min bucket" → date
  let prev = null;

  const hit = (level, id, date, t, lon, lat) => {
    const k = `${level}|${id}|${date}`;
    const h = hits.get(k);
    if (!h) { hits.set(k, [level, id, date, t, t, 1, lon, lat, lon, lat]); return; }
    if (t < h[3]) h[3] = t;
    if (t > h[4]) h[4] = t;
    h[5]++;
    if (lon < h[6]) h[6] = lon;
    if (lat < h[7]) h[7] = lat;
    if (lon > h[8]) h[8] = lon;
    if (lat > h[9]) h[9] = lat;
  };

  for (let i = 0; i < chunk.t.length; i++) {
    const t = chunk.t[i], lat = chunk.lat[i], lon = chunk.lon[i], spd = chunk.spd[i];

    // Skip anything that looks airborne.
    let flying = spd != null && spd * 3.6 > settings.maxGroundKmh;
    if (prev && !flying) {
      const d = distanceKm(prev.lat, prev.lon, lat, lon);
      const kmh = d / Math.max((t - prev.t) / 3600, 1 / 3600);
      if (d > 1 && kmh > settings.maxGroundKmh) flying = true;
    }
    prev = { t, lat, lon };
    if (flying) continue;

    // Which region is this grid square in? (cached — squares repeat a lot)
    const cx = Math.round(lon * CELL), cy = Math.round(lat * CELL);
    const ck = `${cx},${cy}`;
    let cell = cellCache.get(ck);
    if (cell === undefined) {
      const x = cx / CELL, y = cy / CELL;
      const r1 = b.idx1.find(x, y);
      if (!r1) cell = null;
      else {
        const p1 = r1.properties;
        const r2 = b.level2Countries.has(p1.a0) ? b.idx2.find(x, y, (f) => f.properties.l1 === p1.id) : null;
        cell = { a0: p1.a0, l1: p1.id, l2: r2?.properties.id ?? null, tz: p1.tz };
      }
      cellCache.set(ck, cell);
    }
    if (!cell) continue; // at sea, or outside every border

    const dk = `${cell.tz}|${Math.floor(t / 900)}`; // 15-minute buckets: plenty for dates
    let date = dateCache.get(dk);
    if (!date) { date = localDate(t, cell.tz); dateCache.set(dk, date); }

    hit(0, cell.a0, date, t, lon, lat);
    hit(1, cell.l1, date, t, lon, lat);
    if (cell.l2) hit(2, cell.l2, date, t, lon, lat);
  }
  return [...hits.values()];
}

/**
 * Bring the saved per-day analysis up to date (only new/changed days are
 * analysed), then add everything up per place.
 * @param range optional { from, to } local dates 'YYYY-MM-DD' to count only those days
 * @param onProgress optional (done, total) callback
 */
export async function updateVisits(settings, range = {}, onProgress) {
  const b = await loadBoundaries();
  const ver = `${ANALYSIS_VERSION}|${settings.maxGroundKmh}`;
  const [chunks, saved] = await Promise.all([getChunks(), getAll('dayVisits')]);
  const savedByDay = new Map(saved.map((s) => [s.day, s]));

  const cellCache = new Map();
  const fresh = [];
  const results = [];
  let done = 0;
  for (const c of chunks) {
    const s = savedByDay.get(c.day);
    if (s && s.n === c.n && s.ver === ver) { results.push(s); continue; }
    const rec = { day: c.day, n: c.n, ver, hits: analyseChunk(c, b, settings, cellCache) };
    fresh.push(rec);
    results.push(rec);
    if (++done % 20 === 0) {
      onProgress?.(done, chunks.length);
      await new Promise((r) => setTimeout(r)); // let the screen update
    }
  }
  if (fresh.length) await putMany('dayVisits', fresh);
  // Forget analysis of days that no longer exist (e.g. after a restore)
  const live = new Set(chunks.map((c) => c.day));
  if (saved.some((s) => !live.has(s.day))) {
    await clearStores(['dayVisits']);
    await putMany('dayVisits', results);
  }
  return aggregate(results, b, range);
}

// ---------- adding it all up ----------

/**
 * @returns {Map<string, Place>} keyed "level:id", e.g. "0:ESP", "1:ESP-aragon"
 * Place = { level, id, name, a0, l1, dates:Set<string>, firstT, lastT, bounds, status, source }
 */
function aggregate(dayRecords, b, range = {}) {
  const places = new Map();
  for (const rec of dayRecords) {
    for (const [level, id, date, first, last, , w, s, e, n] of rec.hits) {
      if ((range.from && date < range.from) || (range.to && date > range.to)) continue;
      const key = `${level}:${id}`;
      let p = places.get(key);
      if (!p) {
        p = { level, id, dates: new Set(), firstT: first, lastT: last, bounds: [w, s, e, n], status: 'visited', source: 'gps' };
        places.set(key, p);
      }
      p.dates.add(date);
      if (first < p.firstT) p.firstT = first;
      if (last > p.lastT) p.lastT = last;
      const b = p.bounds;
      if (w < b[0]) b[0] = w;
      if (s < b[1]) b[1] = s;
      if (e > b[2]) b[2] = e;
      if (n > b[3]) b[3] = n;
    }
  }
  for (const p of places.values()) Object.assign(p, describe(p.level, p.id, b));
  return places;
}

/** Name + parent info for any place id. */
export function describe(level, id, b = boundaries) {
  if (level === 0) return { name: b.countryById.get(id)?.name ?? id, a0: id };
  const f = (level === 1 ? b.idx1 : b.idx2).byId.get(id);
  return { name: f?.properties.name ?? id, a0: f?.properties.a0, l1: f?.properties.l1 };
}

/** How many level-1 / level-2 areas a country has in total. */
export function countAreas(a0, level) {
  const fc = level === 1 ? boundaries.admin1 : boundaries.admin2;
  return fc.features.filter((f) => f.properties.a0 === a0).length;
}

/** Group dates into stays: ["2026-08-03","2026-08-04","2026-08-09"] → 2 stays. */
export function stays(dateSet) {
  const days = [...dateSet].sort();
  const out = [];
  const toNum = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;
  for (const d of days) {
    const last = out.at(-1);
    if (last && toNum(d) - toNum(last.to) === 1) { last.to = d; last.days++; }
    else out.push({ from: d, to: d, days: 1 });
  }
  return out;
}
