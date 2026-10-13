// Adds a "tz" (IANA time zone, e.g. "Europe/Madrid") to every region in data/admin1.json.
// Used by build_boundaries.py. Needs: npm install geo-tz@8 (build time only).
// Usage: node tools/add_timezones.js <inner-points.geojson>
const fs = require('fs');
const path = require('path');
const { find } = require('geo-tz');

const file = path.join(__dirname, '..', 'data', 'admin1.json');
const regions = JSON.parse(fs.readFileSync(file, 'utf8'));
const points = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const tzById = new Map();
for (const f of points.features) {
  const [lon, lat] = f.geometry.coordinates;
  tzById.set(f.properties.id, find(lat, lon)[0]);
}
let missing = 0;
for (const f of regions.features) {
  f.properties.tz = tzById.get(f.properties.id) || null;
  if (!f.properties.tz) missing++;
}
fs.writeFileSync(file, JSON.stringify(regions));
console.log(`time zones added; ${missing} regions without one`);
