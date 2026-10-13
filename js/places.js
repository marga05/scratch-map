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
//   5. "Stop time" per place: time spent there while moving slower than
//      walking pace. Less than your threshold (default 2 h) = "passed through".
// Results are saved per day (the "dayVisits" store) so that a later import
// only has to analyse the days that changed. Your manual places and
// corrections are added on top at the end, so they never get lost.

import { distanceKm } from './tracks.js';
import { getChunks, getAll, putMany, clearStores } from './db.js';

const ANALYSIS_VERSION = 2; // bump when the analysis logic changes → everything is recomputed
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
  boundaries.areaKm2 = new Map(countries.features.map((f) => [f.properties.id, areaKm2(f.geometry)]));
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

const SLOW_KMH = 15;        // slower than this between two points = "stopped / strolling"
const MAX_STOP_GAP = 86400; // a tracking gap of up to 24 h at the same spot still counts as stopped

function cellFor(lon, lat, b, cellCache) {
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
  return cell;
}

/** Which marked stretch (if any) contains time t? → 'flight' | 'passed' | null */
function stretchAt(t, stretches) {
  for (const s of stretches) if (t >= s.fromT && t <= s.toT) return s.as;
  return null;
}

/**
 * @param seed the last point of the previous day (or null), so stop time
 *             across midnight isn't lost
 */
function analyseChunk(chunk, seed, b, settings, cellCache, stretches) {
  // key "level|id|date" → [level, id, date, firstT, lastT, count, west, south, east, north, stopSec]
  const hits = new Map();
  const dateCache = new Map(); // "tz|15-min bucket" → date
  let prev = seed ? { ...seed } : null;   // previous point (any)
  let prevGround = null;                  // previous point that counted as "on the ground"
  if (seed && !stretchAt(seed.t, stretches)) prevGround = { ...seed, cell: cellFor(seed.lon, seed.lat, b, cellCache) };

  const hit = (level, id, date, t, lon, lat, stopSec) => {
    const k = `${level}|${id}|${date}`;
    const h = hits.get(k);
    if (!h) { hits.set(k, [level, id, date, t, t, 1, lon, lat, lon, lat, stopSec]); return; }
    if (t < h[3]) h[3] = t;
    if (t > h[4]) h[4] = t;
    h[5]++;
    if (lon < h[6]) h[6] = lon;
    if (lat < h[7]) h[7] = lat;
    if (lon > h[8]) h[8] = lon;
    if (lat > h[9]) h[9] = lat;
    h[10] += stopSec;
  };

  for (let i = 0; i < chunk.t.length; i++) {
    const t = chunk.t[i], lat = chunk.lat[i], lon = chunk.lon[i], spd = chunk.spd[i];
    const marked = stretchAt(t, stretches);

    // Skip anything that looks airborne, or that you marked as a flight.
    let flying = marked === 'flight' || (spd != null && spd * 3.6 > settings.maxGroundKmh);
    if (prev && !flying) {
      const d = distanceKm(prev.lat, prev.lon, lat, lon);
      const kmh = d / Math.max((t - prev.t) / 3600, 1 / 3600);
      if (d > 1 && kmh > settings.maxGroundKmh) flying = true;
    }
    prev = { t, lat, lon };
    if (flying) { prevGround = null; continue; }

    const cell = cellFor(lon, lat, b, cellCache);
    if (!cell) { prevGround = null; continue; } // at sea, or outside every border

    const dk = `${cell.tz}|${Math.floor(t / 900)}`; // 15-minute buckets: plenty for dates
    let date = dateCache.get(dk);
    if (!date) { date = localDate(t, cell.tz); dateCache.set(dk, date); }

    // Stop time: the time since the previous point counts as "stopped" in a
    // place if you were in that same place both times and moved slowly.
    let stop = 0;
    if (prevGround && marked !== 'passed') {
      const dt = t - prevGround.t;
      const d = distanceKm(prevGround.lat, prevGround.lon, lat, lon);
      if (dt > 0 && dt <= MAX_STOP_GAP && d / (dt / 3600) < SLOW_KMH) stop = dt;
    }
    const pc = prevGround?.cell;
    hit(0, cell.a0, date, t, lon, lat, pc && pc.a0 === cell.a0 ? stop : 0);
    hit(1, cell.l1, date, t, lon, lat, pc && pc.l1 === cell.l1 ? stop : 0);
    if (cell.l2) hit(2, cell.l2, date, t, lon, lat, pc && pc.l2 === cell.l2 ? stop : 0);
    prevGround = { t, lat, lon, cell };
  }
  return [...hits.values()];
}

/**
 * Bring the saved per-day analysis up to date (only new/changed days are
 * analysed), then add everything up per place, including your manual places
 * and corrections.
 * @param edits { manual: [], corrections: [] } from the database
 * @param range optional { from, to } local dates 'YYYY-MM-DD' to count only those days
 * @param onProgress optional (done, total) callback
 */
export async function updateVisits(settings, edits, range = {}, onProgress) {
  const b = await loadBoundaries();
  const stretches = edits.corrections.filter((c) => c.kind === 'stretch');
  const [chunks, saved] = await Promise.all([getChunks(), getAll('dayVisits')]);
  const savedByDay = new Map(saved.map((s) => [s.day, s]));

  const cellCache = new Map();
  const fresh = [];
  const results = [];
  let done = 0;
  for (let ci = 0; ci < chunks.length; ci++) {
    const c = chunks[ci];
    // A day is re-analysed when its points, the settings, or a marked stretch near it change.
    const dayStart = Date.parse(`${c.day}T00:00:00Z`) / 1000;
    const near = stretches.filter((s) => s.toT >= dayStart - 86400 && s.fromT <= dayStart + 2 * 86400);
    const ver = `${ANALYSIS_VERSION}|${settings.maxGroundKmh}|${near.map((s) => `${s.fromT}-${s.toT}${s.as}`).join(',')}`;
    const s = savedByDay.get(c.day);
    if (s && s.n === c.n && s.ver === ver) { results.push(s); continue; }

    const p = chunks[ci - 1];
    const seed = p ? { t: p.t.at(-1), lat: p.lat.at(-1), lon: p.lon.at(-1) } : null;
    const rec = { day: c.day, n: c.n, ver, hits: analyseChunk(c, seed, b, settings, cellCache, near) };
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
  return aggregate(results, b, range, settings, edits);
}

// ---------- adding it all up ----------

/** All dates from 'YYYY-MM-DD' to 'YYYY-MM-DD' (max ~5 years, as a safety net). */
export function dateSpan(from, to) {
  if (!from) return [];
  const out = [];
  const end = Date.parse(`${to || from}T00:00:00Z`);
  for (let d = Date.parse(`${from}T00:00:00Z`); d <= end && out.length < 2000; d += 86400000) {
    out.push(new Date(d).toISOString().slice(0, 10));
  }
  return out;
}

/** The place itself plus its "parents": a province → its region → its country. */
export function withParents(level, id, b = boundaries) {
  const out = [[level, id]];
  if (level === 2) {
    const f = b.idx2.byId.get(id);
    if (f) out.push([1, f.properties.l1], [0, f.properties.a0]);
  } else if (level === 1) {
    const f = b.idx1.byId.get(id);
    if (f) out.push([0, f.properties.a0]);
  }
  return out;
}

/**
 * @returns {Map<string, Place>} keyed "level:id", e.g. "0:ESP", "1:ESP-aragon"
 * Place = { level, id, name, a0, l1, dates:Set<string>, firstT, lastT, bounds,
 *           stopSec, gps:boolean, manual:[entries], status, corrected }
 * status: 'visited' | 'passed' | 'not'
 */
function aggregate(dayRecords, b, range, settings, edits) {
  const inRange = (date) => !(range.from && date < range.from) && !(range.to && date > range.to);
  const filtering = !!(range.from || range.to);
  const places = new Map();
  const get = (level, id) => {
    const key = `${level}:${id}`;
    let p = places.get(key);
    if (!p) {
      p = { level, id, dates: new Set(), firstT: null, lastT: null, bounds: null, stopSec: 0, gps: false, manual: [], corrected: null };
      places.set(key, p);
    }
    return p;
  };

  // 1. GPS
  for (const rec of dayRecords) {
    for (const [level, id, date, first, last, , w, s, e, n, stopSec = 0] of rec.hits) {
      if (!inRange(date)) continue;
      const p = get(level, id);
      p.gps = true;
      p.dates.add(date);
      p.stopSec += stopSec;
      if (p.firstT == null || first < p.firstT) p.firstT = first;
      if (p.lastT == null || last > p.lastT) p.lastT = last;
      if (!p.bounds) p.bounds = [w, s, e, n];
      else {
        const bb = p.bounds;
        if (w < bb[0]) bb[0] = w;
        if (s < bb[1]) bb[1] = s;
        if (e > bb[2]) bb[2] = e;
        if (n > bb[3]) bb[3] = n;
      }
    }
  }
  const dwell = settings.dwellMinutes * 60;
  for (const p of places.values()) p.status = p.stopSec >= dwell ? 'visited' : 'passed';

  // 2. Places you added by hand (they also count for the region and country around them)
  for (const m of edits.manual) {
    const dates = dateSpan(m.from, m.to).filter(inRange);
    if (filtering && !dates.length) continue; // outside the dates being shown
    for (const [level, id] of withParents(m.level, m.placeId, b)) {
      const p = get(level, id);
      p.manual.push(m);
      dates.forEach((d) => p.dates.add(d));
      p.status = 'visited';
    }
  }

  // 3. Your corrections always win.
  const statusEdits = edits.corrections.filter((c) => c.kind === 'status');
  // Marking a region "visited" means you were in its country too…
  for (const c of statusEdits) {
    if (c.status !== 'visited') continue;
    for (const [level, id] of withParents(c.level, c.placeId, b).slice(1)) get(level, id).status = 'visited';
  }
  // …but a correction you set on a place directly always has the last word.
  for (const c of statusEdits) {
    const p = places.get(`${c.level}:${c.placeId}`) ?? (c.status === 'not' ? null : get(c.level, c.placeId));
    if (!p) continue;
    p.status = c.status;
    p.corrected = c;
  }
  // Places that only exist because of a "not visited" / "passed" edit on a child have no other data;
  // give them a sensible status.
  for (const p of places.values()) if (!p.status) p.status = 'visited';

  for (const p of places.values()) {
    Object.assign(p, describe(p.level, p.id, b));
    p.source = p.gps && p.manual.length ? 'gps+manual' : p.gps ? 'gps' : 'manual';
  }
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

// ---------- searching places by name ----------

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Find countries / regions / provinces whose name matches. Works offline. */
export function searchPlaces(query, limit = 12) {
  const q = fold(query.trim());
  if (q.length < 2) return [];
  const b = boundaries;
  const results = [];
  const consider = (level, props) => {
    const name = fold(props.name ?? '');
    const i = name.indexOf(q);
    if (i < 0) return;
    // Best: name starts with the query; then: a word starts with it; then anywhere.
    const score = (i === 0 ? 0 : /\W/.test(name[i - 1]) ? 1 : 2) + level * 0.1;
    results.push({ level, id: props.id, name: props.name, a0: props.a0 ?? props.id, score });
  };
  b.countries.features.forEach((f) => consider(0, f.properties));
  b.admin1.features.forEach((f) => consider(1, f.properties));
  b.admin2.features.forEach((f) => consider(2, f.properties));
  results.sort((x, y) => x.score - y.score || x.name.localeCompare(y.name));
  return results.slice(0, limit).map((r) => ({ ...r, country: b.countryById.get(r.a0)?.name ?? r.a0 }));
}

// ---------- stats helpers ----------

/** Approximate area of a shape in km² (good enough for "% of the world"). */
function areaKm2(g) {
  const R = 6371;
  const rad = Math.PI / 180;
  const ringArea = (ring) => {
    let sum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[j], [x2, y2] = ring[i];
      sum += (x2 - x1) * rad * (2 + Math.sin(y1 * rad) + Math.sin(y2 * rad));
    }
    return Math.abs((sum * R * R) / 2);
  };
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let total = 0;
  for (const poly of polys) poly.forEach((ring, i) => (total += i === 0 ? ringArea(ring) : -ringArea(ring)));
  return Math.max(total, 0);
}

export function countryArea(id) { return boundaries.areaKm2.get(id) ?? 0; }
export function worldLandKm2() { let t = 0; for (const a of boundaries.areaKm2.values()) t += a; return t; }
export function continentOf(id) { return boundaries.countryById.get(id)?.cont ?? null; }

/** "Berlin, Germany" for a coordinate (or null at sea). */
export function whereIs(lon, lat) {
  const r = boundaries.idx1.find(lon, lat);
  if (!r) return null;
  const country = boundaries.countryById.get(r.properties.a0)?.name;
  return country && country !== r.properties.name ? `${r.properties.name}, ${country}` : r.properties.name;
}
