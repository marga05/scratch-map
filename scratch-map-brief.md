# Build brief: personal travel scratch-map PWA

This is a hand-off from a planning conversation. It covers what I want, which decisions are already made, and what the data looks like. Please read all of it before writing code, and ask me about anything under "Open questions" before building those parts.

---

## 1. Goal

I want to see every place I've ever travelled, on my iPhone, for free:

1. **The exact lines I've travelled.** This is the main thing: real GPS routes, not just pins.
2. **A scratch map I can zoom through detail levels**: countries → states/comunidades/Bundesländer → provinces/districts, filled in automatically from my GPS data.
3. **All my flights** on the map, without the countries I fly over counting as visited.
4. **How many days I spent where, and on which dates.**
5. **Manual control**: add places the tracker missed or that I visited before I started tracking, and correct places the system got wrong.
6. **Safe backups**, so nothing is lost if my phone breaks.

It has to be **free**. I won't pay for subscriptions or hosting.

---

## 2. Decisions already made (and why)

### Tracking is done by a separate app, not by this PWA
- On iPhone, a PWA (or any web page) only gets location while it's open on screen. It can't track in the background, so it can't record routes itself.
- Building a native app (Swift, Apple developer account) was rejected as too much work.
- **So: a free tracking app records the GPS, and this PWA is the viewer and analyser.** I export a file from the tracker every month or so and import it here.

### Tracker chosen: Scoria: Private Location Log
- Free. The developer commits to keeping the core features private and free. No subscription appears in the app or the App Store.
- Logs in the background all the time, and accuracy/battery is easy to adjust.
- Has a setting that **warns me if tracking stops**, which I've turned on.
- Data stays on the device, with no account.
- **Export:** in the app I can only find **"Export database", which produces a `.sqlite` file**. The App Store description says it can also export CSV or GPX, but I haven't found that in the app, maybe because it needs a selection first. **The importer must support Scoria's `.sqlite` as the main format.**
- Its map has several styles (including satellite) but no shops or places, unlike Google/Apple Maps.
- Known risk: a reviewer said tracking sometimes stopped silently after 12–18 hours. The stop-warning should catch that.

### Fallback / secondary trackers (nice to support too)
- **Location Path: Travel History** (developer Mohini Sharma; its home-screen name is "Location Log"). Exports **GPX, GeoJSON or CSV** and can switch between Apple and Google Maps. It has a Premium tier (€0.99/month, €9.99/year, €29.99 lifetime) but nothing in the app says what it unlocks. No automatic backup or export.
- **Whereabout: Location Log** (developer Charlie Liu). Fully free and exports **CSV**. It also has a webhook that POSTs a JSON payload to a URL whenever I arrive at or leave a place. A PWA can't receive webhooks, so ignore that for now.
- Backtrack and Location Log by Edward Quinn were rejected (abandoned / not available in Spain).

### Maps: no Google Maps or Apple Maps
- In an earlier project (a Pan-America trip map) I found it hard or impossible to embed Google/Apple Maps in a self-made app: API keys, billing, poor offline support.
- **Use MapLibre GL JS (preferred, because it handles large vector layers well) or Leaflet with free OpenStreetMap-based tiles.** No API key that costs money, please. If a tile provider needs a free key, tell me.

### My phone and computer
- iPhone on **iOS 26.6.2**. The PWA must work well in Safari and as a home-screen app.
- I also have a laptop, which matters for backups (section 4F).

---

## 3. The Scoria `.sqlite` format (verified from a real export)

I uploaded a real export (made 2026-10-13, only 2 points because I hadn't moved yet). Structure:

```sql
CREATE TABLE "location" (
    id                          INTEGER NOT NULL PRIMARY KEY,
    timestamp                   INTEGER NOT NULL UNIQUE ON CONFLICT IGNORE,  -- Unix seconds, UTC
    latitude                    REAL    NOT NULL,
    longitude                   REAL    NOT NULL,
    horizontal_accuracy         REAL    NOT NULL,   -- metres
    msl_altitude                REAL,
    ellipsoid_altitude          REAL,
    vertical_accuracy           REAL,
    story                       INTEGER,
    speed                       REAL,               -- m/s, may be NULL
    speed_accuracy              REAL,
    course                      REAL,
    course_accuracy             REAL,
    is_simulated_by_software    INTEGER,
    is_produced_by_accessory    INTEGER,
    was_imported                INTEGER NOT NULL DEFAULT 0,
    gx INTEGER, gy INTEGER,                         -- Scoria's internal grid coords
    cy8 ... cx12                                    -- GENERATED VIRTUAL columns (gy >> n etc.)
) STRICT;

CREATE TABLE pins (           -- places saved in Scoria (empty in my export)
    id INTEGER NOT NULL PRIMARY KEY,
    lng REAL NOT NULL, lat REAL NOT NULL,
    name TEXT NOT NULL, icon TEXT NOT NULL,
    lists TEXT NOT NULL, tags TEXT NOT NULL,
    boundary TEXT
) STRICT;
```

Also present: a `_sqlx_migrations` table (ignore it) and indexes on the cell columns.

Implementation notes:
- Read it in the browser with **sql.js** (SQLite compiled to WebAssembly), fully client-side.
- The table uses `STRICT` and generated columns, so use a recent sql.js build (bundled SQLite ≥ 3.37). Select only the real columns: `SELECT timestamp, latitude, longitude, horizontal_accuracy, speed, msl_altitude FROM location ORDER BY timestamp`.
- **Deduplicate by `timestamp`** when importing, because each new export probably contains old data again.
- Filter out bad points: very poor `horizontal_accuracy` (make the threshold configurable, e.g. > 100 m) and `is_simulated_by_software = 1`.
- **Unknown:** whether an export contains my whole history or only the time range selected in the app. Once I have more data, the importer should report the date range of each file so I can tell.
- Optionally import `pins` as saved places.

---

## 4. Functions I want

Priority labels: **[MUST]** = v1, **[NICE]** = if possible / later.

### A. Import

1. **[MUST] Import tracker data**
   - Import Scoria `.sqlite` via the iPhone file picker (including from iCloud Drive).
   - Merge everything into one history and dedupe.
   - After import, show a summary: number of points, date range, new countries or regions found.
2. **[NICE] Other formats:** also accept **GPX, GeoJSON and CSV** (Location Path, Whereabout). For CSV, detect or let me map the lat/lon/time columns.

### B. The map

3. **[MUST] Switchable scratch-map detail levels.** I want to switch between as many levels as possible:
   - **Level 0, countries [MUST].**
   - **Level 1, first-level regions [MUST]:** US states, Spanish **comunidades autónomas**, German **Bundesländer**, French régions, Italian regioni, etc., for every country where possible.
   - **Level 2, second-level divisions [NICE]:** whatever is one step smaller, e.g. Spanish provincias, German Landkreise, US counties, French départements, Italian province.
   - A clear control (segmented buttons or similar) to switch levels. Per-country lists such as "Spain: 9/17 comunidades, 21/50 provincias".
   - ⚠️ **Data trap:** Natural Earth's admin-1 file gives Spain's **50 provinces**, not the 17 comunidades, and the same happens in some other countries. Group them using its region field, so level 1 shows the 17 comunidades + Ceuta/Melilla and the provinces can serve as level 2 for Spain. Check France, Italy and the UK for the same issue.
   - Level 2 data: Natural Earth has no global second-level layer. Use **geoBoundaries ADM2** (open licence) or similar. It's big, so **load it per country, only when needed**, not all at once.
4. **[MUST] Routes and GPS points on the same map**
   - Toggle layers on top of the scratch map: **routes (lines)**, **raw GPS points** (dots, at closer zoom), **flights**.
   - Split lines where there's a big time gap or an impossible jump, so it doesn't draw fake straight lines across oceans.
   - Filter by date range (a specific trip, a year, all time).
   - Performance: years of points must stay smooth on a phone. Simplify or decimate lines at low zoom, and only show raw points when zoomed in.
5. **[NICE] Map styles:** a normal style that shows places/streets, and a minimal style that shows the scratch-map colours clearly.

### C. Visit status: visited vs. passed through vs. flown over

6. **[MUST] Flights never make a place "visited".** A country or region only counts from ground GPS points or manual entries, never from a flight line passing over it.
7. **[MUST] Show all my flights** as curved great-circle arcs, styled differently from ground routes, with their own on/off toggle.
   - **Manual flights:** add a flight by picking two airports (search by city or IATA code) and a date.
   - **[NICE] Flight detection:** spot jumps between points that imply aircraft speed (e.g. > 300 km/h over a long gap) and suggest "Looks like a flight from X to Y on [date]. Add it?"
8. **[NICE] Detect "passed through" vs. "actually visited"**, e.g. a train or car ride through a region without stopping.
   - Possible logic: in that area, every point is moving fast (e.g. > 50 km/h) and there's no stop or dwell longer than N minutes → "passed through". Otherwise → "visited". Make the thresholds configurable.
   - Show "passed through" places in a lighter shade, with a setting for whether they count in totals.
9. **Each place therefore has a status:** `visited` · `passed through` · `not visited`, plus a source: `GPS` / `manual`. Flown-over places stay `not visited`.

### D. Manual control

10. **[MUST] Manually add places**
    - Places the tracker missed (phone dead, tracking stopped) and **past travel from before I started tracking**.
    - Add by searching a place name, tapping the map, or ticking a country or region in a list. Include a date or date range, and optionally a note.
    - Manual visits look slightly different from GPS visits (e.g. hatched or outlined), so I can see what's verified.
11. **[MUST] Correct the system's verdict**
    - Tap a country or region and change its status: "visited" → "passed through", "flown over / not visited", or "visited".
    - Also select specific GPS points or a stretch of route, e.g. a train ride, and mark it as "passing through" or "flight" so it stops counting.
    - **Store manual edits separately from the raw GPS data**, so re-importing Scoria files never undoes my corrections. Edits are included in the backup.
12. **[NICE] Trips:** group dates into named trips, e.g. "Pan-America trip", and filter the map by trip.

### E. Days and dates per place

13. **[MUST] Days spent per place**
    - For each country / region / province: **total number of days** spent there and **the list of dates** (grouped into stays, e.g. "3–9 Aug 2027, 7 days").
    - Count **calendar days in the local time zone** of the place. A travel day counts for each place I was in that day.
    - Tap a place on the map → a panel showing days, dates, first and last visit, and a button to zoom to my routes there.
    - Manual entries with date ranges also count towards days.
14. **[NICE] Stats:** total distance, countries, regions, continents, % of the world, northern/southern-most points, km per year.

### F. Backup, so I never lose data if my phone breaks

The browser storage of a PWA on iOS can be wiped, and Scoria only keeps data on my phone, so backups matter a lot. There are two things to protect: **(a) Scoria's raw `.sqlite` file**, the master copy of my GPS history, and **(b) the PWA's own data**: manual places, corrections, flights, trips.

15. **[MUST] One-tap backup export from the PWA**
    - Export everything (merged GPS history + manual edits + flights + settings) as one file.
    - Use the **iOS share sheet (Web Share API)** so I can save it straight to **iCloud Drive (Files app)**, Google Drive, or AirDrop it to my laptop.
    - **Restore** from that file on a new phone or after Safari data is cleared.
16. **[MUST] Backup reminders**
    - When I open the app, show a clear banner if my last backup or last Scoria import is older than N days (e.g. 30, configurable): "Last backup 34 days ago. Back up now?"
    - **Also offer a reminder that works without opening the app:** a button that downloads a **recurring calendar event (.ics)**, e.g. "1st of every month: export Scoria data, import into the scratch map, back up, send a copy to laptop". I'd add it to my calendar once, and no server is needed.
    - Push notifications from a PWA on iOS would need a push server. Only do that if it can be done free and simply. Otherwise the banner + calendar reminder is enough.
17. **[NICE] Direct cloud backup**
    - **Google Drive:** possible with Google's free Drive API (needs a free OAuth client ID, which I can set up if you walk me through it). Save backups to a dedicated Drive folder in one tap.
    - **iCloud Drive:** a web app can't write to iCloud Drive silently. The share sheet → "Save to Files" → iCloud Drive is the realistic route. If an **iOS Shortcut** could automate any part of this, e.g. saving the latest export to a fixed iCloud folder, explain how.
    - The reminder text should tell me to keep the **raw Scoria `.sqlite`** in iCloud Drive or on my laptop as well, not just the PWA backup.

---

## 5. Technical constraints and preferences
- **Free only:** free hosting (e.g. GitHub Pages, which gives the HTTPS PWAs need), free tile provider, no paid APIs.
- **Privacy:** location data never leaves my phone except into backup locations I choose. No analytics, no server, no account.
- **Static site:** no backend. Keep the build simple. A plain HTML/JS app or a small Vite project is fine. Explain how to deploy it in plain steps.
- **Offline:** installable PWA (manifest, service worker, home-screen icon). Data stored in **IndexedDB**. Boundary files cached locally, and map tiles cached for viewed areas where the provider allows it.
- **Boundary data:** Natural Earth (public domain) for countries and admin-1. geoBoundaries (or similar open data) for admin-2, loaded per country. Simplify the geometry so files stay phone-sized.
- **Speed:** I record many points a day. Before point-in-polygon testing, reduce points to unique grid cells (e.g. ~1 km) per day. Use a spatial index (e.g. rbush). Store results so later imports only process new points.
- **Mobile-first UI:** large tap targets, works in portrait on iPhone, respects safe-area insets.
- **Explain things simply:** I'm not a professional developer. Tell me in plain language what each step does and anything I need to do on my phone.

---

## 6. Open questions (please ask me before deciding)
1. Which countries' regions matter most to me besides the US, Spain and Germany? Should all countries get level 1 from the start?
2. How long a stop should turn "passed through" into "visited"? E.g. 30 minutes, 2 hours, an overnight stay?
3. Should "passed through" places count in my totals by default?
4. How should the scratch map look: colours, style, light/dark? How should manual and passed-through places look?
5. Backup reminder: every how many days? Is a calendar (.ics) reminder enough, or do I want Google Drive direct backup in v1?
6. Do I want trips (item 12) in v1 or later?

---

## 7. Suggested build order
1. Static PWA shell (manifest, service worker), deployed to GitHub Pages, and I install it on my iPhone.
2. Scoria `.sqlite` import → IndexedDB → draw routes and points on a MapLibre/OSM map.
3. **Backup export/restore + reminder banner + .ics reminder.** Do this early so my data is safe from the start.
4. Country detection and the country scratch map.
5. Level 1 regions (with comunidades grouping for Spain) and the level switcher.
6. Days and dates per place.
7. Manual flights + flight layer (flights never count as visits).
8. Manual add / correct-status tools.
9. Passed-through detection.
10. Level 2 divisions, other importers, flight detection, Google Drive backup, stats, trips.

For testing before I have much real data, generate a fake Scoria-format `.sqlite` with a multi-country route. It should include a train ride through a region without stopping, a multi-day stay, and a gap that looks like a flight.
