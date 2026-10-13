"""Makes small fake GPX / GeoJSON / CSV files in test-data/ for testing the importers.

Run:  python3 tools/make_fake_text_formats.py
"""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "test-data"
OUT.mkdir(exist_ok=True)

# 1. GPX: a 4-hour walk around Lisbon on 10 Mar 2025 (UTC times with Z)
start = datetime(2025, 3, 10, 10, 0, tzinfo=timezone.utc)
pts = []
for i in range(240):
    lat = 38.7139 + 0.004 * ((i % 60) / 60) - 0.002
    lon = -9.1394 + 0.004 * ((i // 60) / 4)
    t = (start + timedelta(minutes=i)).strftime("%Y-%m-%dT%H:%M:%SZ")
    pts.append(f'<trkpt lat="{lat:.6f}" lon="{lon:.6f}"><ele>50</ele><time>{t}</time></trkpt>')
(OUT / "fake-location-path.gpx").write_text(
    '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="fake" xmlns="http://www.topografix.com/GPX/1/1">'
    f'<trk><name>Lisbon walk</name><trkseg>{"".join(pts)}</trkseg></trk></gpx>\n')

# 2. CSV, Whereabout-style visit log: Porto, with arrival/departure times
(OUT / "fake-whereabout.csv").write_text(
    "place_name,latitude,longitude,arrival_date,departure_date\n"
    '"Ribeira",41.1407,-8.6113,2025-03-12 09:30:00,2025-03-12 13:00:00\n'
    '"Livraria Lello",41.1469,-8.6149,2025-03-12 14:00:00,2025-03-12 15:10:00\n'
    '"Hotel",41.1496,-8.6109,2025-03-12 20:00:00,2025-03-13 09:00:00\n')

# 3. GeoJSON LineString with coordTimes: a walk in Paris on 20 Apr 2024
coords, times = [], []
s = datetime(2024, 4, 20, 9, 0, tzinfo=timezone.utc)
for i in range(180):
    coords.append([2.2945 + i * 0.0003, 48.8584 + (i % 30) * 0.0001])
    times.append((s + timedelta(minutes=i)).isoformat().replace("+00:00", "Z"))
(OUT / "fake-paris.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": [
    {"type": "Feature", "properties": {"coordTimes": times}, "geometry": {"type": "LineString", "coordinates": coords}}]}))

# 4. CSV with column names the app can't guess (German, semicolons) → column picker
rows = ["Breite;Länge;Zeitpunkt;Notiz"]
for i in range(60):
    rows.append(f"47.3769;{8.5417 + i * 0.0002:.4f};2024-06-01 1{i // 30}:{(i % 30) * 2:02d}:00;Zürich")
(OUT / "fake-unknown-columns.csv").write_text("\n".join(rows) + "\n")
print("wrote GPX, CSV, GeoJSON test files to", OUT)
