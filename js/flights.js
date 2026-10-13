// flights.js — airports, flight arcs, and spotting flights in your GPS data.
//
// Flights are only drawn on the map. They never make a place "visited":
// the place analysis (places.js) never looks at them.

import { distanceKm } from './tracks.js';

let airports; // [{ code, name, city, cc, lat, lon, size }]

export async function loadAirports() {
  if (airports) return airports;
  const res = await fetch('data/airports.json');
  if (!res.ok) throw new Error('Could not load the airport list.');
  airports = (await res.json()).map(([code, name, city, cc, lat, lon, size]) => ({ code, name, city, cc, lat, lon, size }));
  return airports;
}

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Search by IATA code (MAD), city (Madrid) or airport name. */
export function searchAirports(query, limit = 8) {
  const q = fold(query.trim());
  if (!q) return [];
  const scored = [];
  for (const a of airports) {
    let score = null;
    if (q.length === 3 && a.code.toLowerCase() === q) score = 0;
    else if (fold(a.city).startsWith(q)) score = 1;
    else if (fold(a.name).startsWith(q)) score = 2;
    else if (q.length >= 3 && (fold(a.name).includes(q) || fold(a.city).includes(q))) score = 3;
    if (score === null) continue;
    scored.push({ a, score: score + (2 - a.size) * 0.1 }); // big airports first, closed ones last
  }
  scored.sort((x, y) => x.score - y.score);
  return scored.slice(0, limit).map((s) => s.a);
}

export const airportLabel = (a) => `${a.code} · ${a.city || a.name}${a.size === -1 ? ' (closed)' : ''}`;

/** What a flight stores about an airport (a snapshot, so old codes stay correct). */
export const airportSnapshot = (a) => ({ code: a.code, name: a.name, city: a.city, cc: a.cc, lat: a.lat, lon: a.lon });

/**
 * A curved "great-circle" line: the shortest path over the globe, which is how
 * planes really fly and why long flights look curved on a flat map.
 */
export function arc(from, to, steps = 64) {
  const rad = Math.PI / 180;
  const [φ1, λ1, φ2, λ2] = [from.lat * rad, from.lon * rad, to.lat * rad, to.lon * rad];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2));
  if (d === 0) return [[from.lon, from.lat], [to.lon, to.lat]];
  const coords = [];
  let prevLon = null;
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    let lon = Math.atan2(y, x) / rad;
    const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / rad;
    // Keep the line continuous across the 180° meridian (e.g. Tokyo → Los Angeles).
    if (prevLon !== null) while (lon - prevLon > 180) lon -= 360;
    if (prevLon !== null) while (lon - prevLon < -180) lon += 360;
    prevLon = lon;
    coords.push([lon, lat]);
  }
  return coords;
}

export const flightKm = (f) => distanceKm(f.from.lat, f.from.lon, f.to.lat, f.to.lon);

export function flightsGeoJSON(flights) {
  return {
    type: 'FeatureCollection',
    features: flights.map((f) => ({
      type: 'Feature',
      properties: { id: f.id, label: `${f.from.code}–${f.to.code}` },
      geometry: { type: 'LineString', coordinates: arc(f.from, f.to) },
    })),
  };
}

function nearestAirport(lat, lon, maxKm = 60) {
  let best = null, bestD = maxKm;
  for (const a of airports) {
    if (Math.abs(a.lat - lat) > 1 || Math.abs(a.lon - lon) > 1.5) continue; // quick skip
    const d = distanceKm(lat, lon, a.lat, a.lon) + (a.size === -1 ? 15 : 0) - a.size * 3; // prefer big, open airports
    if (d < bestD) { best = a; bestD = d; }
  }
  return best;
}

/**
 * Look for jumps in your GPS track that only a plane could make:
 * more than 150 km at more than 250 km/h, with an airport near both ends.
 * @returns [{ key, t1, t2, date, from, to, km }]
 */
export function detectFlights(chunks) {
  const found = [];
  let prev = null;
  for (const c of chunks) {
    for (let i = 0; i < c.t.length; i++) {
      const p = { t: c.t[i], lat: c.lat[i], lon: c.lon[i] };
      if (prev) {
        const km = distanceKm(prev.lat, prev.lon, p.lat, p.lon);
        const h = (p.t - prev.t) / 3600;
        if (km > 150 && h > 0 && km / h > 250) {
          const from = nearestAirport(prev.lat, prev.lon);
          const to = nearestAirport(p.lat, p.lon);
          if (from && to && from.code !== to.code) {
            const d = new Date(prev.t * 1000);
            const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            found.push({ key: `${prev.t}-${p.t}`, t1: prev.t, t2: p.t, date, from, to, km: Math.round(km) });
          }
        }
      }
      prev = p;
    }
  }
  return found;
}
