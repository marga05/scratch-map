"""Builds the phone-sized border files in data/ from Natural Earth (public domain).

You only need this if you want to rebuild the border data.

  1. Download from https://github.com/nvkelso/natural-earth-vector (tag v5.1.2, folder geojson/):
       ne_10m_admin_0_countries.geojson
       ne_10m_admin_1_states_provinces.geojson
  2. python3 tools/build_boundaries.py <folder with those files>
     (needs Node.js; mapshaper is fetched automatically with npx, and
      geo-tz must be installed: npm install geo-tz@8)

Writes:
  data/countries.json   level 0 – countries
  data/admin1.json      level 1 – states / comunidades / Bundesländer / régions …
  data/admin2-ne.json   level 2 – only for the "grouped" countries below, where
                        Natural Earth's units are really one level down
                        (Spanish provincias, French départements, Italian province, UK councils …)
"""
import json
import re
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path

MAPSHAPER = ["npx", "-y", "mapshaper@0.6.113"]

# Countries where Natural Earth's "admin-1" is really admin-2.
# Value = which field holds the real first-level region.
GROUPED = {
    "ESP": "region",    # 50 provincias -> 17 comunidades + Ceuta + Melilla
    "FRA": "region",    # 101 départements -> 18 régions
    "ITA": "region",    # 110 province -> 20 regioni
    "GBR": "geonunit",  # 232 councils -> England, Scotland, Wales, Northern Ireland
    "PHL": "region",    # provinces -> 17 regions
    "SVN": "region",    # 193 municipalities -> 12 statistical regions
    "LVA": "region",    # 119 municipalities -> 5 regions
    "MLT": "region",    # 68 local councils -> 3 regions
    "MKD": "region",    # 84 municipalities -> statistical regions
    "KOS": "region",    # 30 municipalities -> 7 districts
}


def slug(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-").lower()


def mapshaper(*args):
    subprocess.run([*MAPSHAPER, *args], check=True)


def main(src):
    src = Path(src)
    out = Path(__file__).resolve().parent.parent / "data"
    out.mkdir(exist_ok=True)
    tmp = Path(tempfile.mkdtemp())

    # ---- level 0: countries ----
    mapshaper(
        str(src / "ne_10m_admin_0_countries.geojson"),
        "-each", "id=ADM0_A3, name=NAME, cont=CONTINENT, iso2=ISO_A2_EH",
        "-filter-fields", "id,name,cont,iso2",
        "-simplify", "8%", "keep-shapes",
        "-o", str(out / "countries.json"), "format=geojson", "precision=0.0001",
    )

    # ---- level 1 + 2: tag every unit with its real level-1 region ----
    a1 = json.loads((src / "ne_10m_admin_1_states_provinces.geojson").read_text())
    for f in a1["features"]:
        p = f["properties"]
        a0 = p["adm0_a3"]
        name = p["name"] or p["name_en"] or p["adm1_code"]
        field = GROUPED.get(a0)
        group = p.get(field) if field else None
        if field and group:
            l1id, l1name = f"{a0}-{slug(group)}", group
        else:
            l1id, l1name = p["adm1_code"], name
        f["properties"] = {
            "a0": a0, "l1id": l1id, "l1name": l1name, "grouped": bool(field and group),
            "l2id": p["adm1_code"], "l2name": name,
        }
    tagged = tmp / "a1_tagged.geojson"
    tagged.write_text(json.dumps(a1))

    # Simplify once (keeps shared borders aligned), then build both outputs from it.
    simplified = tmp / "a1_simple.geojson"
    mapshaper(str(tagged), "-simplify", "6%", "keep-shapes", "-o", str(simplified), "format=geojson", "precision=0.0001")

    mapshaper(
        str(simplified),
        "-dissolve", "l1id", "copy-fields=a0,l1name",
        "-rename-fields", "id=l1id,name=l1name",
        "-o", str(out / "admin1.json"), "format=geojson", "precision=0.0001",
    )
    mapshaper(
        str(simplified),
        "-filter", "grouped === true",
        "-rename-fields", "id=l2id,name=l2name,l1=l1id",
        "-filter-fields", "id,name,a0,l1",
        "-o", str(out / "admin2-ne.json"), "format=geojson", "precision=0.0001",
    )

    # Each region gets its time zone, so days can be counted in local time.
    inner = tmp / "a1_inner.geojson"
    mapshaper(str(out / "admin1.json"), "-points", "inner", "-o", str(inner), "format=geojson")
    subprocess.run(["node", str(Path(__file__).resolve().parent / "add_timezones.js"), str(inner)], check=True)

    for f in ("countries.json", "admin1.json", "admin2-ne.json"):
        n = len(json.loads((out / f).read_text())["features"])
        print(f"{f}: {n} areas, {(out / f).stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
