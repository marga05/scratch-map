"""Makes a FAKE Scoria-style .sqlite export for testing the app.

Same table layout as a real Scoria export. The fake trip:
  1. Madrid, 3 days (multi-day stay)
  2. High-speed train Madrid -> Zaragoza -> Barcelona, passing through
     Castilla-La Mancha and Aragon WITHOUT stopping
  3. Barcelona, 2 days
  4. Flight Barcelona -> Berlin: tracking gap + 1,500 km jump (should NOT draw a line)
  5. Berlin, 3 days
  6. Car Berlin -> Dresden -> Prague (crosses into Czechia)
  7. Prague, 2 days
Plus a few junk points (very inaccurate, and one "simulated") that the
importer should throw away.

Run:  python3 tools/make_fake_scoria.py
Output: test-data/fake-scoria.sqlite
"""
import math
import random
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

random.seed(42)
OUT = Path(__file__).resolve().parent.parent / "test-data" / "fake-scoria.sqlite"

SCHEMA = """
CREATE TABLE "location" (
    id INTEGER NOT NULL PRIMARY KEY,
    timestamp INTEGER NOT NULL UNIQUE ON CONFLICT IGNORE,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    horizontal_accuracy REAL NOT NULL,
    msl_altitude REAL,
    ellipsoid_altitude REAL,
    vertical_accuracy REAL,
    story INTEGER,
    speed REAL,
    speed_accuracy REAL,
    course REAL,
    course_accuracy REAL,
    is_simulated_by_software INTEGER,
    is_produced_by_accessory INTEGER,
    was_imported INTEGER NOT NULL DEFAULT 0,
    gx INTEGER, gy INTEGER,
    cy8 INTEGER GENERATED ALWAYS AS (gy >> 8) VIRTUAL,
    cx8 INTEGER GENERATED ALWAYS AS (gx >> 8) VIRTUAL,
    cy12 INTEGER GENERATED ALWAYS AS (gy >> 12) VIRTUAL,
    cx12 INTEGER GENERATED ALWAYS AS (gx >> 12) VIRTUAL
) STRICT;
CREATE INDEX location_c8 ON location (cy8, cx8);
CREATE TABLE pins (
    id INTEGER NOT NULL PRIMARY KEY,
    lng REAL NOT NULL, lat REAL NOT NULL,
    name TEXT NOT NULL, icon TEXT NOT NULL,
    lists TEXT NOT NULL, tags TEXT NOT NULL,
    boundary TEXT
) STRICT;
CREATE TABLE _sqlx_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL);
"""

points = []  # (t, lat, lon, acc, speed_m_s, sim)


def ts(y, mo, d, h=0, mi=0):
    return int(datetime(y, mo, d, h, mi, tzinfo=timezone.utc).timestamp())


def km_between(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def stay(center, start_t, end_t, spots):
    """Wander around a city: sit at spots, stroll between them; points every ~5 min."""
    t = start_t
    i = 0
    while t < end_t:
        spot = spots[i % len(spots)]
        hour = datetime.fromtimestamp(t, timezone.utc).hour
        if 0 <= hour < 7:  # asleep at the hotel (spot 0): sparse points
            spot = spots[0]
            step = 1800
        else:
            step = 300
            if random.random() < 0.15:
                i += 1
        lat = spot[0] + random.gauss(0, 0.0004)
        lon = spot[1] + random.gauss(0, 0.0005)
        points.append((t, lat, lon, random.uniform(5, 25), random.uniform(0, 1.5), 0))
        t += step + random.randint(-30, 30)


def travel(waypoints, start_t, kmh, every_s=60):
    """Move along waypoints at a steady speed, a point every `every_s` seconds."""
    t = start_t
    speed_ms = kmh / 3.6
    for a, b in zip(waypoints, waypoints[1:]):
        dist = km_between(a, b)
        dur = dist / kmh * 3600
        n = max(1, int(dur / every_s))
        for k in range(n):
            f = k / n
            lat = a[0] + (b[0] - a[0]) * f + random.gauss(0, 0.0002)
            lon = a[1] + (b[1] - a[1]) * f + random.gauss(0, 0.0002)
            points.append((int(t), lat, lon, random.uniform(5, 30), speed_ms * random.uniform(0.9, 1.1), 0))
            t += every_s
    return int(t)


MADRID = [(40.4168, -3.7038), (40.4153, -3.6845), (40.4138, -3.6921), (40.4240, -3.7120)]
BCN = [(41.3851, 2.1734), (41.4036, 2.1744), (41.3809, 2.1228), (41.3870, 2.1700)]
BERLIN = [(52.5200, 13.4050), (52.5163, 13.3777), (52.5076, 13.3904), (52.5300, 13.4130)]
PRAGUE = [(50.0755, 14.4378), (50.0865, 14.4114), (50.0870, 14.4208)]

# 1. Madrid, 3 days
stay(MADRID[0], ts(2026, 8, 3, 9), ts(2026, 8, 6, 7, 30), MADRID)
# 2. AVE train Madrid -> Guadalajara -> Calatayud -> Zaragoza -> Lleida -> Barcelona, ~280 km/h, no stops
t = travel([(40.4065, -3.6893), (40.6300, -3.1600), (41.3530, -1.6430), (41.6580, -0.9110),
            (41.6200, 0.6300), (41.3790, 2.1400)], ts(2026, 8, 6, 8), kmh=260)
# 3. Barcelona, 2 days
stay(BCN[0], t + 600, ts(2026, 8, 8, 12), BCN)
# 4. Flight BCN -> BER: last point at El Prat, nothing in the air, first point at BER
points.append((ts(2026, 8, 8, 13), 41.2974, 2.0833, 10, 0, 0))
points.append((ts(2026, 8, 8, 16, 5), 52.3667, 13.5033, 12, 0, 0))
# 5. Berlin, 3 days
stay(BERLIN[0], ts(2026, 8, 8, 17), ts(2026, 8, 11, 9), BERLIN)
# 6. Car Berlin -> Dresden -> border -> Prague, ~110 km/h
t = travel([(52.4800, 13.4300), (51.8000, 13.6500), (51.0504, 13.7373),
            (50.7700, 13.9300), (50.6600, 14.0300), (50.0755, 14.4378)], ts(2026, 8, 11, 9, 30), kmh=110)
# 7. Prague, 2 days
stay(PRAGUE[0], t + 600, ts(2026, 8, 13, 18), PRAGUE)

# Junk the importer must drop:
points.append((ts(2026, 8, 4, 12, 0) + 7, 40.9, -3.0, 1500.0, 0, 0))   # terrible accuracy
points.append((ts(2026, 8, 9, 12, 0) + 11, 48.85, 2.35, 10.0, 0, 1))    # "simulated" point in Paris

OUT.parent.mkdir(exist_ok=True)
if OUT.exists():
    OUT.unlink()
db = sqlite3.connect(OUT)
db.executescript(SCHEMA)
db.executemany(
    "INSERT INTO location (timestamp, latitude, longitude, horizontal_accuracy, msl_altitude, speed, "
    "is_simulated_by_software, is_produced_by_accessory, gx, gy) VALUES (?,?,?,?,?,?,?,0,0,0)",
    [(t, lat, lon, acc, 650.0, spd, sim) for (t, lat, lon, acc, spd, sim) in sorted(points)],
)
db.execute("INSERT INTO pins (lng, lat, name, icon, lists, tags) VALUES (2.1744, 41.4036, 'Sagrada Familia', 'star', '[]', '[]')")
db.commit()
n = db.execute("SELECT COUNT(*), MIN(timestamp), MAX(timestamp) FROM location").fetchone()
db.close()
print(f"wrote {OUT} with {n[0]} points, "
      f"{datetime.fromtimestamp(n[1], timezone.utc):%Y-%m-%d} to {datetime.fromtimestamp(n[2], timezone.utc):%Y-%m-%d}")
