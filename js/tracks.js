// tracks.js — turns stored GPS points into map shapes (route lines + dots).
//
// Lines are cut ("split") wherever drawing a straight line would be a lie:
// a long gap in tracking where you also moved far, or a jump faster than any
// ground vehicle (usually a flight). That stops fake lines across oceans.

const R = 6371; // Earth radius in km

export function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * @param chunks day-chunks from db.getChunks() (already sorted by day)
 * @param settings { gapMinutes, gapKm, maxGroundKmh }
 * @param range optional { fromT, toT } unix seconds to trim to
 */
export function buildTracks(chunks, settings, range = {}) {
  const lines = [];
  const points = [];
  const bounds = [Infinity, Infinity, -Infinity, -Infinity]; // west, south, east, north
  let current = [];
  let prev = null;
  let count = 0;
  let totalKm = 0;
  let splits = 0;
  // Distance is only counted once you've moved 100 m from the last counted
  // spot, so GPS "wobble" while standing still doesn't add fake kilometres.
  let anchor = null;
  const MIN_STEP_KM = 0.1;

  const flush = () => {
    if (current.length >= 2) {
      lines.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: current } });
    }
    current = [];
  };

  for (const c of chunks) {
    for (let i = 0; i < c.t.length; i++) {
      const t = c.t[i];
      if (range.fromT != null && t < range.fromT) continue;
      if (range.toT != null && t > range.toT) continue;
      const lat = c.lat[i], lon = c.lon[i];
      count++;

      if (prev) {
        const dKm = distanceKm(prev.lat, prev.lon, lat, lon);
        const dtH = Math.max((t - prev.t) / 3600, 1 / 3600);
        const kmh = dKm / dtH;
        const longGap = t - prev.t > settings.gapMinutes * 60 && dKm > settings.gapKm;
        const tooFast = kmh > settings.maxGroundKmh && dKm > 1;
        if (longGap || tooFast) { flush(); splits++; anchor = null; }
      }
      if (!anchor) anchor = { lat, lon };
      else {
        const stepKm = distanceKm(anchor.lat, anchor.lon, lat, lon);
        if (stepKm >= MIN_STEP_KM) { totalKm += stepKm; anchor = { lat, lon }; }
      }

      current.push([lon, lat]);
      points.push({
        type: 'Feature',
        properties: { t, acc: c.acc[i], spd: c.spd[i] },
        geometry: { type: 'Point', coordinates: [lon, lat] },
      });
      if (lon < bounds[0]) bounds[0] = lon;
      if (lat < bounds[1]) bounds[1] = lat;
      if (lon > bounds[2]) bounds[2] = lon;
      if (lat > bounds[3]) bounds[3] = lat;
      prev = { t, lat, lon };
    }
  }
  flush();

  return {
    lines: { type: 'FeatureCollection', features: lines },
    points: { type: 'FeatureCollection', features: points },
    bounds: count ? bounds : null,
    count,
    totalKm,
    splits,
  };
}
