"""Builds per-country "level 2" files (counties, Landkreise, districts …) from
geoBoundaries (gbOpen, open licences – https://www.geoboundaries.org).

The app loads data/adm2/<COUNTRY>.json only for countries you have visited.

  python3 tools/build_admin2.py            (all countries)
  python3 tools/build_admin2.py DEU USA    (only some)

Needs internet, Node.js and mapshaper (npm install mapshaper@0.6.113; put its
.bin folder on PATH). Countries already covered by Natural Earth's grouped
provinces (Spain, France, Italy, UK, …) are skipped.
"""
import json
import subprocess
import sys
import tempfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "adm2"
API = "https://www.geoboundaries.org/api/current/gbOpen/{iso}/{level}/"

# Where geoBoundaries' ADM2 is too coarse to be the "one step smaller" level.
FORCE_LEVEL = {"DEU": "ADM3"}   # ADM2 = 38 Regierungsbezirke, ADM3 = 428 Landkreise/kreisfreie Städte
MAX_UNITS = 6000                # beyond this a file gets too heavy for a phone
MAX_BYTES = 1_400_000           # aim for files of at most ~1.4 MB


# Only ever download from geoBoundaries and the GitHub hosts it stores its files on.
ALLOWED_HOSTS = {
    "www.geoboundaries.org", "geoboundaries.org", "github.com",
    "raw.githubusercontent.com", "media.githubusercontent.com", "objects.githubusercontent.com",
}


def _check(url):
    u = urlsplit(url)
    if u.scheme != "https" or u.hostname not in ALLOWED_HOSTS:
        raise ValueError(f"refusing to fetch {url!r}")
    return url


def _open(url, timeout):
    r = urllib.request.urlopen(_check(url), timeout=timeout)
    _check(r.geturl())  # where any redirect ended up must be allowed too
    return r


def fetch_json(url):
    with _open(url, 60) as r:
        return json.load(r)


def fetch_bytes(url):
    with _open(url, 180) as r:
        return r.read()


def in_rings(x, y, rings):
    inside = False
    for ring in rings:
        j = len(ring) - 1
        for i in range(len(ring)):
            xi, yi = ring[i][0], ring[i][1]
            xj, yj = ring[j][0], ring[j][1]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
            j = i
    return inside


def in_geom(x, y, g):
    polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
    return any(in_rings(x, y, p) for p in polys)


def nearest_vertex_dist(x, y, g):
    polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
    return min((px - x) ** 2 + (py - y) ** 2 for poly in polys for px, py in poly[0])


def pick_level(iso, n_admin1):
    if iso in FORCE_LEVEL:
        return FORCE_LEVEL[iso], fetch_json(API.format(iso=iso, level=FORCE_LEVEL[iso]))
    for level in ("ADM2", "ADM3"):
        try:
            meta = fetch_json(API.format(iso=iso, level=level))
        except Exception:
            continue
        count = int(meta.get("admUnitCount") or 0)
        # Must really be smaller than our regions, and not absurdly many.
        if count > max(n_admin1 * 1.5, n_admin1 + 2) and count <= MAX_UNITS:
            return level, meta
    return None, None


def build(iso, admin1_by_country, tmp):
    regions = admin1_by_country.get(iso, [])
    level, meta = pick_level(iso, len(regions))
    if not level:
        return iso, None
    raw = tmp / f"{iso}.geojson"
    raw.write_bytes(fetch_bytes(meta["simplifiedGeometryGeoJSON"]))
    simple, inner = tmp / f"{iso}_s.geojson", tmp / f"{iso}_p.geojson"
    common = ["-each", "name=shapeName||shapeID", "-filter-fields", "name,shapeID"]
    # Simplify more and more until the file is phone-sized (big countries need coarser borders).
    for interval, precision in ((250, "0.0001"), (800, "0.001"), (2000, "0.001"), (5000, "0.01")):
        subprocess.run(["mapshaper", "-i", str(raw), *common, "-simplify", f"interval={interval}", "keep-shapes",
                        "-o", str(simple), "format=geojson", f"precision={precision}"], check=True, capture_output=True)
        if simple.stat().st_size <= MAX_BYTES:
            break
    subprocess.run(["mapshaper", "-i", str(simple), "-points", "inner", "-o", str(inner), "format=geojson"],
                   check=True, capture_output=True)
    shapes = json.loads(simple.read_text())["features"]
    points = json.loads(inner.read_text())["features"]

    features = []
    for i, (f, pt) in enumerate(zip(shapes, points)):
        if not f.get("geometry"):
            continue
        x, y = pt["geometry"]["coordinates"] if pt.get("geometry") else (None, None)
        if x is None:
            continue
        parent = next((r["properties"]["id"] for r in regions if in_geom(x, y, r["geometry"])), None)
        if parent is None and regions:
            # Just outside the (simplified) region borders: take the region with the nearest edge point.
            parent = min(regions, key=lambda r: nearest_vertex_dist(x, y, r["geometry"]))["properties"]["id"]
        if parent is None:
            continue
        features.append({
            "type": "Feature",
            "properties": {"id": f"{iso}-{level}-{i}", "name": f["properties"]["name"], "a0": iso, "l1": parent},
            "geometry": f["geometry"],
        })
    dest = OUT / f"{iso}.json"
    dest.write_text(json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, separators=(",", ":")))
    return iso, {"level": level, "units": len(features), "kb": round(dest.stat().st_size / 1024),
                 "type": meta.get("boundaryCanonical") or "", "license": meta.get("boundaryLicense") or ""}


def main(only):
    OUT.mkdir(parents=True, exist_ok=True)
    countries = [f["properties"]["id"] for f in json.loads((ROOT / "data" / "countries.json").read_text())["features"]]
    admin1 = json.loads((ROOT / "data" / "admin1.json").read_text())["features"]
    grouped = {f["properties"]["a0"] for f in json.loads((ROOT / "data" / "admin2-ne.json").read_text())["features"]}
    admin1_by_country = {}
    for f in admin1:
        admin1_by_country.setdefault(f["properties"]["a0"], []).append(f)

    todo = [c for c in (only or countries) if c not in grouped]
    index_file = OUT / "index.json"
    index = json.loads(index_file.read_text()) if index_file.exists() else {}
    tmp = Path(tempfile.mkdtemp())

    def job(iso):
        try:
            return build(iso, admin1_by_country, tmp)
        except Exception as e:  # keep going; report at the end
            return iso, {"error": str(e)[:120]}

    with ThreadPoolExecutor(6) as pool:
        for iso, info in pool.map(job, todo):
            if info and "error" not in info:
                index[iso] = info
                print(f"{iso}: {info['units']} × {info['type'] or info['level']} ({info['kb']} KB)")
            elif info:
                print(f"{iso}: failed – {info['error']}")
    index_file.write_text(json.dumps(dict(sorted(index.items())), ensure_ascii=False, indent=0))
    total = sum(v["kb"] for v in index.values())
    print(f"\n{len(index)} countries, {total / 1024:.1f} MB in total")


if __name__ == "__main__":
    main(sys.argv[1:])
