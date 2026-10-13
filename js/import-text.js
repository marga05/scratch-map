// import-text.js — reads GPX, GeoJSON and CSV files (e.g. from Location Path
// or Whereabout) into the same GPS history as Scoria.
//
// Every point needs a time; points without one are skipped (the app can't
// tell which day they belong to).

import { cleanPoint, saveImported } from './importer.js';

/** Thrown when a CSV's columns can't be recognised: the app then asks you to pick them. */
export class NeedsColumnMapping extends Error {
  constructor(headers, sample) {
    super('Which columns hold latitude, longitude and time?');
    this.headers = headers;
    this.sample = sample;
  }
}

// ---------- times ----------

/** Unix seconds from many time formats, or null. Times without a zone are read as this device's local time. */
export function parseTime(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\s*-?\d+(\.\d+)?\s*$/.test(v)) {
    const n = Number(v);
    if (n > 1e12) return n / 1000;   // milliseconds
    if (n > 1e8) return n;           // seconds
    return null;
  }
  let s = String(v).trim();
  // "2026-08-03 10:15:00" → "2026-08-03T10:15:00" (Safari needs the T)
  s = s.replace(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})/, (_, d, t) => `${d}T${t.padStart(5, '0')}`);
  s = s.replace(/ ?(UTC|GMT)$/i, 'Z').replace(/ ([+-]\d{2}:?\d{2})$/, '$1');
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

// ---------- GPX ----------

function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error("This GPX file couldn't be read (it may be damaged).");
  const raw = [];
  for (const el of doc.querySelectorAll('trkpt, rtept, wpt')) {
    const child = (name) => [...el.children].find((c) => c.localName === name)?.textContent;
    const ext = (name) => [...el.getElementsByTagName('*')].find((c) => c.localName === name)?.textContent;
    raw.push({
      lat: Number(el.getAttribute('lat')),
      lon: Number(el.getAttribute('lon')),
      time: child('time'),
      alt: child('ele') != null ? Number(child('ele')) : null,
      spd: ext('speed') != null ? Number(ext('speed')) : null,          // m/s in GPX
      acc: child('hdop') != null ? Number(child('hdop')) * 5 : null,   // rough: HDOP × 5 m
    });
  }
  return raw;
}

// ---------- GeoJSON ----------

function parseGeoJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("This GeoJSON file couldn't be read."); }
  const features = data.type === 'FeatureCollection' ? data.features : data.type === 'Feature' ? [data] : [];
  const timeOf = (p) => p?.time ?? p?.timestamp ?? p?.datetime ?? p?.date ?? p?.recorded_at ?? p?.created_at;
  const raw = [];
  for (const f of features) {
    const g = f.geometry, p = f.properties ?? {};
    if (!g) continue;
    if (g.type === 'Point') {
      raw.push({ lon: g.coordinates[0], lat: g.coordinates[1], alt: g.coordinates[2] ?? p.altitude ?? null,
        time: timeOf(p), spd: p.speed ?? null, acc: p.accuracy ?? p.horizontal_accuracy ?? null });
    } else if (g.type === 'LineString' || g.type === 'MultiLineString') {
      const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
      const times = p.coordTimes ?? p.times ?? p.timestamps;
      let k = 0;
      lines.forEach((line, li) => line.forEach((c, i) => {
        const tl = Array.isArray(times?.[0]) ? times[li]?.[i] : times?.[k];
        raw.push({ lon: c[0], lat: c[1], alt: c[2] ?? null, time: c[3] ?? tl, spd: null, acc: null });
        k++;
      }));
    }
  }
  return raw;
}

// ---------- CSV ----------

function splitCsv(text) {
  const firstLine = text.slice(0, text.indexOf('\n') + 1 || undefined);
  const delim = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

const find = (headers, ...patterns) => {
  for (const re of patterns) {
    const i = headers.findIndex((h) => re.test(h));
    if (i >= 0) return i;
  }
  return -1;
};

/** Guess which columns are which. Returns null for anything not found. */
export function guessCsvColumns(headers) {
  const h = headers.map((x) => x.trim().toLowerCase());
  const col = (i) => (i >= 0 ? i : null);
  const arrival = find(h, /arriv/, /^start/, /begin/);
  const departure = find(h, /depart/, /^end/, /leave/);
  const dateOnly = find(h, /^date$/, /^day$/);
  const timeOnly = find(h, /^time$/, /^clock/);
  return {
    lat: col(find(h, /^lat(itude)?$/, /lat/)),
    lon: col(find(h, /^(lon|lng|long|longitude)$/, /lon|lng/)),
    time: col(find(h, /timestamp/, /date.?time/, /^time$/, /^date$/, /time/, /date/)),
    date: dateOnly >= 0 && timeOnly >= 0 ? dateOnly : null,   // separate date + time columns
    clock: dateOnly >= 0 && timeOnly >= 0 ? timeOnly : null,
    arrival: arrival >= 0 && departure >= 0 ? arrival : null, // visit logs (e.g. Whereabout)
    departure: arrival >= 0 && departure >= 0 ? departure : null,
    acc: col(find(h, /accuracy/, /^acc/, /hdop/)),
    spd: col(find(h, /speed/)),
    spdKmh: /km/.test(h[find(h, /speed/)] ?? ''),
    alt: col(find(h, /altitude/, /^alt/, /^ele/)),
  };
}

function parseCsv(text, mapping) {
  const rows = splitCsv(text.replace(/^﻿/, ''));
  if (rows.length < 2) throw new Error('This CSV file has no data rows.');
  const headers = rows[0];
  const m = { ...guessCsvColumns(headers), ...(mapping ?? {}) };
  const hasTime = m.time != null || (m.date != null && m.clock != null) || m.arrival != null;
  if (m.lat == null || m.lon == null || !hasTime) throw new NeedsColumnMapping(headers, rows.slice(1, 4));

  const num = (v) => (v == null || v === '' ? null : Number(String(v).replace(',', '.')));
  const raw = [];
  for (const r of rows.slice(1)) {
    const base = {
      lat: num(r[m.lat]), lon: num(r[m.lon]),
      acc: m.acc != null ? num(r[m.acc]) : null,
      spd: m.spd != null ? (num(r[m.spd]) ?? null) / (m.spdKmh ? 3.6 : 1) : null,
      alt: m.alt != null ? num(r[m.alt]) : null,
    };
    if (m.arrival != null) {
      // A visit: one point when you arrived, one when you left (so stop time counts).
      raw.push({ ...base, spd: 0, time: r[m.arrival] });
      if (r[m.departure]) raw.push({ ...base, spd: 0, time: r[m.departure] });
    } else if (m.date != null && m.clock != null) {
      raw.push({ ...base, time: `${r[m.date]} ${r[m.clock]}` });
    } else {
      raw.push({ ...base, time: r[m.time] });
    }
  }
  return raw;
}

// ---------- shared ----------

export function detectFormat(file, text) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.gpx') || /<gpx[\s>]/.test(text.slice(0, 2000))) return 'GPX';
  if (name.endsWith('.geojson') || name.endsWith('.json') || /^\s*\{/.test(text)) return 'GeoJSON';
  if (name.endsWith('.csv') || name.endsWith('.txt') || name.endsWith('.tsv')) return 'CSV';
  return null;
}

/**
 * Import a GPX / GeoJSON / CSV file.
 * @param csvMapping optional { lat, lon, time } column numbers picked by you
 */
export async function importTextFile(file, settings, csvMapping) {
  const text = await file.text();
  const format = detectFormat(file, text);
  if (!format) throw new Error(`"${file.name}" isn't a format the app knows (Scoria .sqlite, GPX, GeoJSON or CSV).`);
  const raw = format === 'GPX' ? parseGpx(text) : format === 'GeoJSON' ? parseGeoJson(text) : parseCsv(text, csvMapping);

  const kept = [];
  let noTime = 0, invalid = 0, badAccuracy = 0, first = null, last = null;
  for (const p of raw) {
    const t = parseTime(p.time);
    if (t == null) { noTime++; continue; }
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180 || (p.lat === 0 && p.lon === 0)) { invalid++; continue; }
    if (first == null || t < first) first = t;
    if (last == null || t > last) last = t;
    if (p.acc != null && p.acc > settings.maxAccuracy) { badAccuracy++; continue; }
    kept.push(cleanPoint(t, p.lat, p.lon, p.acc, p.spd, p.alt));
  }
  if (!kept.length && raw.length && noTime === raw.length) {
    throw new Error(`None of the ${raw.length} points in "${file.name}" has a time, so they can't be placed on a date.`);
  }
  return saveImported(file.name, format, kept, {
    pointsInFile: raw.length, skippedNoTime: noTime, skippedInvalid: invalid,
    skippedAccuracy: badAccuracy, fileFirstT: first, fileLastT: last,
  });
}
