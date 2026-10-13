"""Builds data/airports.json from OurAirports (public domain).

  1. Download https://davidmegginson.github.io/ourairports-data/airports.csv
  2. python3 tools/build_airports.py path/to/airports.csv

Keeps airports that have an IATA code (MAD, BER, …) and are either large/medium
or have scheduled passenger flights. Closed airports (e.g. Berlin-Tegel) are
kept too, using the old code from their keywords, so past flights can be added.
Each entry is a small list:
  [iata, name, city, country (2 letters), lat, lon, size]
  size: 2 large, 1 medium, 0 other, -1 closed (its code may now belong to another airport)
"""
import csv
import json
import re
import sys
from pathlib import Path

SIZE = {"large_airport": 2, "medium_airport": 1}


def main(src):
    out = []
    seen = set()
    closed = []
    with open(src, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["type"] == "closed" and "airport" in r["name"].lower() and "heliport" not in r["name"].lower():
                m = re.match(r"\s*([A-Z]{3})\b", r["keywords"] or "")
                if m:
                    closed.append([m.group(1), r["name"], r["municipality"] or "", r["iso_country"],
                                   round(float(r["latitude_deg"]), 4), round(float(r["longitude_deg"]), 4), -1])
                continue
            iata = (r["iata_code"] or "").strip().upper()
            if len(iata) != 3 or not iata.isalpha() or iata in seen:
                continue
            if r["type"] not in SIZE and r["scheduled_service"] != "yes":
                continue
            seen.add(iata)
            out.append([
                iata, r["name"], r["municipality"] or "", r["iso_country"],
                round(float(r["latitude_deg"]), 4), round(float(r["longitude_deg"]), 4),
                SIZE.get(r["type"], 0),
            ])
    out += closed
    out.sort(key=lambda a: (-a[6], a[0]))
    dest = Path(__file__).resolve().parent.parent / "data" / "airports.json"
    dest.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"{dest}: {len(out)} airports, {dest.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
