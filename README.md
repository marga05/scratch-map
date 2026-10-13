# Scratch Map

A personal travel map for your iPhone. It shows the exact GPS routes you've
travelled (recorded by the **Scoria** app) and colours every country and region
you've been to in gold, with how many days you spent there and on which dates.
It also draws your flights, lets you add and correct places by hand, and tells
apart places you visited from places you only passed through. It's free, has no
server or account, and your data stays on your phone except for backups you choose to make.

The full wish list is in [scratch-map-brief.md](scratch-map-brief.md).

## What it does (build steps 1–10)

- **Installable app (PWA):** add it to your home screen and it opens full-screen, even offline.
- **Import Scoria `.sqlite` files.** Duplicate points are skipped, so importing the same history twice is safe.
  Inaccurate (> 100 m, adjustable) and "simulated" points are dropped. Each import shows what date range the file covers.
- **Map:** your routes as red lines and GPS dots (dots appear when zoomed in). Lines are broken at tracking gaps and at
  impossible speeds such as flights, so there are no fake straight lines across the sea. Normal and Minimal map styles are available.
- **Date filter:** all time, this year, last year, last 30 days, or a custom range.
- **Backup:** packs everything into one small file and opens the iPhone share sheet → *Save to Files* → iCloud Drive. **Restore** reads that file back.
- **Scratch map:** countries, regions and (for Spain, France, Italy, the UK and a few others) provinces turn gold
  when you have GPS points there on the ground. Fast-moving points (flights) never count. Switch levels under **Layers**.
  Spain shows its 17 comunidades + Ceuta/Melilla, France its 18 régions, Italy its 20 regioni, and the UK England/Scotland/Wales/NI.
- **Days per place:** tap any area, or use the **Places** list, to see total days, each stay (e.g. "3–8 Aug 2026, 6 days"),
  first and last visit, and the regions inside it. Days are counted in the place's **local time zone**, and a travel day
  counts for every place you were in. The date filter applies to these too.
- **Visited vs. passed through:** a place counts as *visited* once you've stopped there for 2 hours in total
  (slower than 15 km/h). Less than that means *passed through*, shown in pale gold and not counted in totals.
  You can change both in **Settings**.
- **Flights:** under **Flights**, add a flight by searching two airports (city or code, closed airports like
  Tegel included) and a date. It's drawn as a dashed curved line. The app also spots flights in your GPS
  ("Looks like a flight from Barcelona to Berlin…") and offers to add them. Flights never make a place visited.
- **Manual control:** in any place's panel you can
  - add a visit by hand (dates optional, with a note). These places show with gold stripes.
  - set the status yourself (*visited / passed through / not visited*). Your choice always wins, and
    "Back to automatic" undoes it.
  - mark a *stretch* of your track (tap a GPS dot → Start/End stretch here) as "passing through" or "flight".
  All of this is stored separately from the GPS data, so re-importing never undoes it, and it's included in backups.
- **Search:** find any country, region or province by name under **Places**, even offline.
- **Provinces/counties everywhere:** level 2 is loaded per country, only for countries you've visited
  (US counties, German Landkreise, Dutch gemeenten, …).
- **Other file formats:** GPX, GeoJSON and CSV (e.g. Location Path, Whereabout). For a CSV whose columns
  aren't recognised, the app asks you which column is which.
- **Stats:** km on the ground and flown, km per year, continents, % of the world's land, and your
  furthest north/south/east/west points.
- **Reminders:** a banner appears when your last import or backup is older than 30 days (adjustable). There's also a button that
  adds a **monthly calendar reminder** (1st of each month) with the checklist.

## Folder guide

| Path | What it is |
|---|---|
| `index.html` | The page: map, toolbar, and the slide-up panels |
| `css/app.css` | Look and layout (phone-first, light/dark) |
| `js/app.js` | Connects the buttons to everything else |
| `js/db.js` | Saving data on the phone (IndexedDB) |
| `js/importer.js` | Reads Scoria `.sqlite` files |
| `js/tracks.js` | Turns GPS points into route lines |
| `js/mapview.js` | The map (MapLibre + free OpenFreeMap tiles) |
| `js/backup.js` | Backup file: make, share, restore |
| `js/reminders.js` | Banner logic + calendar (.ics) reminder |
| `js/places.js` | Works out which countries/regions you visited, on which local dates, and for how long you stopped |
| `js/flights.js` | Airports, curved flight lines, spotting flights in GPS data |
| `js/import-text.js` | Reads GPX, GeoJSON and CSV files |
| `data/` | Simplified borders (with time zones), airports, and `adm2/` per-country counties/districts |
| `sw.js` | Service worker: keeps the app working offline |
| `vendor/` | Libraries (MapLibre GL 6.14, sql.js 1.14), stored locally so nothing loads from elsewhere |
| `tools/make_fake_scoria.py` | Makes fake test data → `test-data/fake-scoria.sqlite` |
| `tools/make_icons.py` | Draws the app icons |
| `tools/build_boundaries.py` | Rebuilds the country/region borders from Natural Earth |
| `tools/build_admin2.py` | Rebuilds `data/adm2/` from geoBoundaries |
| `tools/build_airports.py` | Rebuilds `data/airports.json` from OurAirports |
| `tools/make_fake_text_formats.py` | Makes fake GPX/GeoJSON/CSV test files |

## Try it on your computer

1. Open Terminal in this folder and run:
   ```bash
   python3 -m http.server 8765
   ```
2. Open <http://localhost:8765> in a browser.
3. Tap **Import** and pick `test-data/fake-scoria.sqlite`. It's a fake trip: Madrid → train → Barcelona → flight → Berlin → car → Prague.

## Where it lives online

- **App:** <https://marga05.github.io/scratch-map/> (works on iPhone and in any laptop browser)
- **Code:** <https://github.com/marga05/scratch-map> (public; your travel data is *not* in it, it only lives on your devices)

To publish a change: commit it, then run `git push`. GitHub Pages updates the site within a minute or two,
and the app picks up the new version the next time you open it online.

Note: the phone and the laptop each keep **their own** copy of your data. Move data between them with
**Backup** on one device and **Restore** on the other.

## Install on your iPhone

1. Open <https://marga05.github.io/scratch-map/> in **Safari**.
2. Tap the **Share** button → **Add to Home Screen** → **Add**.
3. Always open it from the home-screen icon. The home-screen app has its own storage, separate from Safari tabs.

## Your monthly routine

1. **Scoria** → *Export database* → save the `.sqlite` file to **iCloud Drive**. Keep these raw files: they're your master copy.
2. **Scratch Map** → **Import** → pick that file.
3. **Scratch Map** → **Backup** → *Prepare backup* → *Save / share* → **Save to Files** → iCloud Drive.
4. Every now and then, AirDrop both files to your laptop.

Tap *Add monthly reminder to calendar* once, and your calendar will remind you on the 1st of every month.

## Data sources and credits

- Country and region borders: [Natural Earth](https://www.naturalearthdata.com) (public domain).
- Provinces / counties / districts: [geoBoundaries](https://www.geoboundaries.org) (gbOpen, open licences;
  Runfola et al. 2020, *geoBoundaries: A global database of political administrative boundaries*, PLoS ONE).
  Each country's licence is listed in `data/adm2/index.json`.
- Airports: [OurAirports](https://ourairports.com/data/) (public domain).
- Map tiles: [OpenFreeMap](https://openfreemap.org), © [OpenMapTiles](https://openmaptiles.org), data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
- Libraries: [MapLibre GL JS](https://maplibre.org) (BSD-3) and [sql.js](https://sql.js.org) (MIT).
