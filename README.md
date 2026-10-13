# Scratch Map

A personal travel map for your iPhone. It shows the exact GPS routes you've
travelled (recorded by the **Scoria** app) and colours every country and region
you've been to in gold, with how many days you spent there and on which dates.
Flights and manual places are still to come. It's free, has no server or
account, and your data stays on your phone except for backups you choose to make.

The full wish list is in [scratch-map-brief.md](scratch-map-brief.md).

## What works so far (build steps 1–6)

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
| `js/places.js` | Works out which countries/regions you visited, and on which local dates |
| `data/` | Simplified borders from Natural Earth (public domain), with time zones |
| `sw.js` | Service worker: keeps the app working offline |
| `vendor/` | Libraries (MapLibre GL 6.14, sql.js 1.14), stored locally so nothing loads from elsewhere |
| `tools/make_fake_scoria.py` | Makes fake test data → `test-data/fake-scoria.sqlite` |
| `tools/make_icons.py` | Draws the app icons |
| `tools/build_boundaries.py` | Rebuilds `data/` from Natural Earth (only needed to update borders) |

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
