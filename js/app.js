// app.js — the "conductor": connects buttons and panels to the other modules.

import { getMeta, setMeta, getChunks, getPointStats, getAll, add, del, requestPersistence, clearStores, STORES, dayKey } from './db.js';
import { importScoriaFile } from './importer.js';
import { buildTracks } from './tracks.js';
import { MapView } from './mapview.js';
import { buildBackupFile, shareOrDownload, markBackedUp, readBackupFile, restoreBackup } from './backup.js';
import { dueReminders, buildMonthlyIcs } from './reminders.js';
import { loadBoundaries, updateVisits, countAreas, stays, bbox, searchPlaces, describe } from './places.js';
import {
  loadAirports, searchAirports, airportLabel, airportSnapshot, flightsGeoJSON, flightKm, detectFlights,
} from './flights.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

export const DEFAULT_SETTINGS = {
  maxAccuracy: 100,   // metres
  gapMinutes: 30,
  gapKm: 5,
  maxGroundKmh: 400,
  reminderDays: 30,
  mapStyle: 'normal',
  mapLevel: 0,        // 0 countries, 1 regions, 2 provinces
  dwellMinutes: 120,  // stop this long in a place → "visited"; less → "passed through"
  countPassed: false, // count "passed through" places in totals?
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  range: { from: null, to: null }, // 'YYYY-MM-DD' strings (local dates), null = open
  preparedBackup: null,
  places: new Map(),  // "level:id" → place, see places.js
  edits: { manual: [], corrections: [] },
  flights: [],
  stretchDraft: {},
  stretchAs: 'passed',
  km: 0,
};

// ---------- small helpers ----------

const fmtDate = (unixSec) =>
  unixSec == null ? '–' : new Date(unixSec * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDateTime = (unixSec) =>
  new Date(unixSec * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtNum = (n) => n.toLocaleString();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const localDayString = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

let toastTimer;
function toast(msg, ms = 3000) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// ---------- bottom sheets ----------

function openSheet(name) {
  closeSheets();
  $(`#sheet-${name}`).hidden = false;
  $('#scrim').hidden = false;
  document.body.classList.add('panel-open'); // laptop: map makes room for the sidebar
  mapView?.map.resize();
  $(`.toolbar [data-sheet="${name}"]`)?.classList.add('active');
  onSheetOpen[name]?.();
}
function closeSheets() {
  mapView?.select(null);
  $$('.sheet').forEach((s) => (s.hidden = true));
  $('#scrim').hidden = true;
  $$('.toolbar button').forEach((b) => b.classList.remove('active'));
  document.body.classList.remove('panel-open');
  mapView?.map.resize();
}
const onSheetOpen = {
  places: renderPlacesSheet,
  flights: renderFlightsSheet,
  data: () => { renderImportLog(); renderBackupStatus(); },
  settings: renderSettings,
  dates: renderDateSheet,
  layers: renderLayersSheet,
};

// ---------- map + tracks ----------

let mapView;

async function refreshTracks({ fit = false } = {}) {
  // The date filter picks whole UTC-day chunks with one day of slack on each
  // side, then trims to exact local-time timestamps.
  const { from, to } = state.range;
  const fromT = from ? new Date(`${from}T00:00:00`).getTime() / 1000 : null;
  const toT = to ? new Date(`${to}T23:59:59`).getTime() / 1000 : null;
  const chunks = await getChunks(fromT != null ? dayKey(fromT - 86400) : null, toT != null ? dayKey(toT + 86400) : null);
  const tracks = buildTracks(chunks, state.settings, { fromT, toT });
  mapView.setTrackData(tracks); // safe before the map finishes loading
  if (fit) mapView.fitTo(tracks.bounds);

  state.trackCount = tracks.count;
  state.km = tracks.totalKm;
  renderStatus();
  return tracks;
}

function renderStatus() {
  const { from, to } = state.range;
  const rangeLabel = from || to
    ? `${from ? fmtDate(new Date(`${from}T12:00`) / 1000) : '…'} – ${to ? fmtDate(new Date(`${to}T12:00`) / 1000) : '…'}`
    : 'All time';
  if (!state.trackCount) {
    $('#status').textContent = from || to ? `${rangeLabel} · no GPS points in this range` : 'No GPS points yet — tap Import';
    return;
  }
  const countries = [...state.places.values()].filter((p) => p.level === 0 && counts(p)).length;
  $('#status').textContent =
    `${rangeLabel} · ${countries} ${countries === 1 ? 'country' : 'countries'} · ${fmtNum(Math.round(state.km))} km`;
}

// ---------- places (scratch map) ----------

/** Does this place count in totals? "Passed through" only if you switched that on in Settings. */
const counts = (p) => p.status === 'visited' || (p.status === 'passed' && state.settings.countPassed);
/** Is it coloured on the map at all? */
const shows = (p) => p.status === 'visited' || p.status === 'passed';
const swatchClass = (p) => (p.source === 'manual' && p.status === 'visited' ? 'manual' : p.status);
const plural = (n, word) => `${fmtNum(n)} ${word}${n === 1 ? '' : 's'}`;
const STATUS_LABEL = { visited: 'Visited', passed: 'Passed through', not: 'Not visited' };

function fmtDuration(sec) {
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86400 * 2) return `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`;
  return `${Math.round(sec / 86400)} days`;
}

async function refreshPlaces() {
  const before = new Set([...state.places].filter(([, p]) => shows(p)).map(([k]) => k));
  const [manual, corrections] = await Promise.all([getAll(STORES.manualPlaces), getAll(STORES.corrections)]);
  state.edits = { manual, corrections };
  state.places = await updateVisits(state.settings, state.edits, state.range, (done, total) => {
    $('#status').textContent = `Finding places… ${Math.round((done / total) * 100)}%`;
  });
  mapView.setPlaceStates(state.places);
  renderStatus();
  return [...state.places].filter(([k, p]) => shows(p) && !before.has(k)).map(([k]) => k);
}

function placesOf(level, a0) {
  return [...state.places.values()].filter((p) => p.level === level && (a0 == null || p.a0 === a0));
}

const placeButton = (p, extra = '') => `<li><button data-level="${p.level}" data-id="${esc(p.id)}">
  <span class="swatch ${swatchClass(p)}"></span>
  <span class="grow">${esc(p.name)}${extra}</span>
  <span class="days">${p.dates.size ? plural(p.dates.size, 'day') : p.status === 'passed' ? 'passed' : ''}</span>
</button></li>`;

function wirePlaceButtons(root) {
  root.querySelectorAll('button[data-level]').forEach((b) =>
    (b.onclick = () => openPlace(Number(b.dataset.level), b.dataset.id, { fly: true })));
}

function renderPlacesSheet() {
  const all = [...state.places.values()].filter(counts);
  const n = (lvl) => all.filter((p) => p.level === lvl).length;
  const allDates = new Set(all.filter((p) => p.level === 0).flatMap((p) => [...p.dates]));
  $('#totals').innerHTML = `
    <div><b>${n(0)}</b><span>countries</span></div>
    <div><b>${n(1)}</b><span>regions</span></div>
    <div><b>${fmtNum(allDates.size)}</b><span>days travelled</span></div>`;
  $('#places-hint').innerHTML = `
    <span class="legend">
      <span><i style="background:#e0a526"></i>visited</span>
      <span><i style="background:#f2d68c"></i>passed through</span>
      <span><i class="manual-i" style="background:repeating-linear-gradient(135deg,#e0a526 0 3px,#f6e3b0 3px 6px)"></i>added by hand</span>
    </span>
    Flights never count. ${state.settings.countPassed ? '"Passed through" places are counted.' : '"Passed through" places aren\'t counted in totals.'}`;

  const countries = placesOf(0).filter(shows).sort((a, b) => b.dates.size - a.dates.size || a.name.localeCompare(b.name));
  $('#place-list').innerHTML = countries.length
    ? countries.map((c) => {
      const r = placesOf(1, c.id).filter(counts).length;
      const r2 = placesOf(2, c.id).filter(counts).length;
      const total2 = countAreas(c.id, 2);
      return placeButton(c, `<small>${STATUS_LABEL[c.status]} · ${r}/${countAreas(c.id, 1)} regions${total2 ? ` · ${r2}/${total2} provinces` : ''}</small>`);
    }).join('')
    : '<li class="hint">No places yet. Import GPS data, or search above to add places by hand.</li>';
  wirePlaceButtons($('#place-list'));
  renderStretchList();
}

function renderPlaceSearch() {
  const q = $('#place-search').value;
  const results = searchPlaces(q);
  $('#place-search-results').innerHTML = results.map((r) => {
    const p = state.places.get(`${r.level}:${r.id}`);
    const kind = ['Country', 'Region', 'Province'][r.level];
    return `<li><button data-level="${r.level}" data-id="${esc(r.id)}">
      <span class="swatch ${p && shows(p) ? swatchClass(p) : 'not'}" ${p && shows(p) ? '' : 'style="background:var(--line)"'}></span>
      <span class="grow">${esc(r.name)}<small>${kind}${r.level ? ` · ${esc(r.country)}` : ''}</small></span>
      <span class="days">${p && shows(p) ? STATUS_LABEL[p.status] : ''}</span></button></li>`;
  }).join('') || (q.trim().length >= 2 ? '<li class="hint">No match. Try the local name (e.g. "Bayern").</li>' : '');
  wirePlaceButtons($('#place-search-results'));
}

const fmtLocalDate = (d) =>
  new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
function fmtStay(s) {
  if (s.from === s.to) return fmtLocalDate(s.from);
  const a = new Date(`${s.from}T12:00:00`), b = new Date(`${s.to}T12:00:00`);
  const sameMonth = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
  return sameMonth
    ? `${a.getDate()}–${fmtLocalDate(s.to)}`
    : `${a.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${fmtLocalDate(s.to)}`;
}

function openPlace(level, id, { fly = false } = {}) {
  renderPlacePanel(level, id);
  openSheet('place');
  mapView.select(level, id); // after openSheet, which clears the old selection
  const p = state.places.get(`${level}:${id}`);
  const feature = mapView.featureOf(level, id);
  // Chosen from a list → show it on the map (tapping the map keeps the view as is).
  if (fly) mapView.fitTo(p?.bounds ?? (feature && bbox(feature.geometry)));
  else if (!p?.bounds && feature) mapView.fitTo(bbox(feature.geometry));
}

function renderPlacePanel(level, id) {
  const p = state.places.get(`${level}:${id}`);
  const feature = mapView.featureOf(level, id);
  const name = p?.name ?? feature?.properties.name ?? id;
  const a0 = p?.a0 ?? (level === 0 ? id : feature?.properties.a0);
  const country = level > 0 ? mapView.featureOf(0, a0)?.properties.name : null;
  const status = p?.status ?? 'not';
  const filtered = state.range.from || state.range.to;

  // Where the information comes from
  let source = 'No GPS points on the ground here' + (filtered ? ' in the selected dates.' : '.');
  if (p?.gps) source = `From GPS · stopped ${fmtDuration(p.stopSec)} in total`;
  if (p?.manual.length) source = p.gps ? `${source} · also added by hand` : 'Added by hand';
  if (p?.corrected) source += ' · status set by you';

  const sortedDates = p ? [...p.dates].sort() : [];
  const st = p ? stays(p.dates) : [];
  const sub = level < 2 && p ? placesOf(level + 1, a0)
    .filter((x) => (level === 0 || x.l1 === id) && shows(x))
    .sort((x, y) => y.dates.size - x.dates.size) : [];
  const ownManual = (p?.manual ?? []);

  $('#place-title').textContent = name;
  const body = $('#place-body');
  body.innerHTML = `
    ${country ? `<p class="hint">${esc(country)}</p>` : ''}
    <p><span class="badge ${p?.source === 'manual' && status === 'visited' ? 'manual' : status}">${STATUS_LABEL[status]}</span>
       <span class="hint">· ${esc(source)}</span></p>
    ${sortedDates.length ? `
    <div class="facts">
      <div><small>Days</small><b>${sortedDates.length}</b></div>
      <div><small>Stays</small><b>${st.length}</b></div>
      <div><small>First visit</small>${fmtLocalDate(sortedDates[0])}</div>
      <div><small>Last visit</small>${fmtLocalDate(sortedDates.at(-1))}</div>
    </div>` : p ? '<p class="hint">No dates known.</p>' : ''}
    ${p?.bounds ? '<button class="btn primary wide" id="place-zoom">Zoom to my routes here</button>' : ''}

    <h3>Status</h3>
    <div class="segmented" id="place-status">
      ${['visited', 'passed', 'not'].map((s) => `<button data-status="${s}" class="${s === status ? 'on' : ''}">${STATUS_LABEL[s]}</button>`).join('')}
    </div>
    ${p?.corrected ? '<button class="btn ghost wide" id="place-auto">Back to automatic</button>' : ''}

    <h3>Add a visit by hand</h3>
    <div class="manual-form">
      <p class="hint">For trips before you tracked, or when tracking stopped. Dates are optional.</p>
      <div class="row two">
        <label>From<input type="date" id="mv-from"></label>
        <label>To<input type="date" id="mv-to"></label>
      </div>
      <textarea id="mv-note" rows="2" placeholder="Note (optional)"></textarea>
      <button class="btn primary wide" id="mv-add">Add visit</button>
    </div>
    ${ownManual.length ? `<ul class="log" id="mv-list">${ownManual.map((m) => {
      const where = m.level === level && m.placeId === id ? '' : ` · via ${esc(describe(m.level, m.placeId).name)}`;
      const when = m.from ? (m.to && m.to !== m.from ? `${fmtLocalDate(m.from)} – ${fmtLocalDate(m.to)}` : fmtLocalDate(m.from)) : 'No dates';
      return `<li><div class="row-actions" style="align-items:center"><span style="flex:1">${when}${where}
        ${m.note ? `<small>${esc(m.note)}</small>` : ''}</span>
        <button class="close" data-del-manual="${m.id}" aria-label="Delete this visit">✕</button></div></li>`;
    }).join('')}</ul>` : ''}

    ${st.length ? `<h3>Dates</h3>
    <ul class="stays">${st.slice().reverse().map((s) =>
      `<li><span>${fmtStay(s)}</span><span>${plural(s.days, 'day')}</span></li>`).join('')}</ul>` : ''}
    ${sub.length ? `<h3>${level === 0 ? 'Regions' : 'Provinces'}</h3>
    <ul class="place-list">${sub.map((x) => placeButton(x)).join('')}</ul>` : ''}`;

  $('#place-zoom') && ($('#place-zoom').onclick = () => { closeSheets(); mapView.fitTo(p.bounds); });
  wirePlaceButtons(body);

  body.querySelectorAll('#place-status button').forEach((b) => (b.onclick = async () => {
    for (const c of state.edits.corrections) {
      if (c.kind === 'status' && c.level === level && c.placeId === id) await del(STORES.corrections, c.id);
    }
    await add(STORES.corrections, { kind: 'status', level, placeId: id, status: b.dataset.status, at: Date.now() });
    await afterEdit(level, id, `Marked as "${STATUS_LABEL[b.dataset.status]}".`);
  }));
  $('#place-auto') && ($('#place-auto').onclick = async () => {
    await del(STORES.corrections, p.corrected.id);
    await afterEdit(level, id, 'Back to automatic.');
  });
  $('#mv-add').onclick = async () => {
    let from = $('#mv-from').value || null, to = $('#mv-to').value || null;
    if (!from && to) [from, to] = [to, null];
    if (from && to && to < from) [from, to] = [to, from];
    await add(STORES.manualPlaces, { level, placeId: id, from, to, note: $('#mv-note').value.trim(), at: Date.now() });
    await afterEdit(level, id, 'Visit added ✓');
  };
  body.querySelectorAll('[data-del-manual]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Delete this visit?')) return;
    await del(STORES.manualPlaces, Number(b.dataset.delManual));
    await afterEdit(level, id, 'Visit deleted.');
  }));
}

async function afterEdit(level, id, msg) {
  await refreshPlaces();
  renderPlacePanel(level, id);
  mapView.select(level, id);
  toast(msg);
}

async function setLevel(level) {
  state.settings.mapLevel = level;
  await setMeta('settings', state.settings);
  mapView.setLevel(level);
  renderLayersSheet();
}

// ---------- marked stretches (parts of the track that count differently) ----------

const toLocalInput = (t) => {
  const d = new Date(t * 1000);
  return `${localDayString(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const fromLocalInput = (v) => (v ? Math.round(new Date(v).getTime() / 1000) : null);
const STRETCH_LABEL = { passed: 'Passing through', flight: 'Flight (ignored)' };

function renderStretchList() {
  const list = state.edits.corrections.filter((c) => c.kind === 'stretch').sort((a, b) => b.fromT - a.fromT);
  $('#stretch-list').innerHTML = list.map((s) => `<li><div class="row-actions" style="align-items:center">
      <span style="flex:1"><b>${STRETCH_LABEL[s.as]}</b><small>${fmtDateTime(s.fromT)} – ${fmtDateTime(s.toT)}</small></span>
      <button class="close" data-del-stretch="${s.id}" aria-label="Delete stretch">✕</button></div></li>`).join('')
    || '<li class="hint">None yet.</li>';
  $$('[data-del-stretch]').forEach((b) => (b.onclick = async () => {
    await del(STORES.corrections, Number(b.dataset.delStretch));
    await refreshPlaces();
    renderPlacesSheet();
    toast('Stretch removed.');
  }));
}

function openStretch(draft = {}) {
  $('#st-from').value = draft.fromT ? toLocalInput(draft.fromT) : '';
  $('#st-to').value = draft.toT ? toLocalInput(draft.toT) : '';
  setStretchAs(draft.as ?? 'passed');
  openSheet('stretch');
}
function setStretchAs(as) {
  state.stretchAs = as;
  $$('#st-as button').forEach((b) => b.classList.toggle('on', b.dataset.as === as));
  $('#st-as-hint').textContent = as === 'passed'
    ? 'Places along this stretch only count as "passed through", even if you were slow (e.g. a traffic jam).'
    : 'GPS points in this stretch are ignored for places, like any other flight.';
}
async function saveStretch() {
  let fromT = fromLocalInput($('#st-from').value), toT = fromLocalInput($('#st-to').value);
  if (!fromT || !toT) return toast('Please fill in both start and end.');
  if (toT < fromT) [fromT, toT] = [toT, fromT];
  await add(STORES.corrections, { kind: 'stretch', fromT, toT, as: state.stretchAs, at: Date.now() });
  state.stretchDraft = {};
  mapView.currentPopup?.remove();
  await refreshPlaces();
  openSheet('places');
  toast('Stretch saved ✓');
}

function onPointTap(props, coords) {
  const el = document.createElement('div');
  const spd = props.spd != null && props.spd !== 'null' ? ` · ${Math.round(props.spd * 3.6)} km/h` : '';
  el.innerHTML = `<b>${esc(fmtDateTime(Number(props.t)))}</b><div class="hint">GPS point${spd}</div>
    <div class="row-actions"><button class="btn" data-end="fromT">Start stretch here</button>
    <button class="btn" data-end="toT">End stretch here</button></div>`;
  el.querySelectorAll('button').forEach((b) => (b.onclick = () => {
    state.stretchDraft = { ...state.stretchDraft, [b.dataset.end]: Number(props.t) };
    const d = state.stretchDraft;
    if (d.fromT && d.toT) openStretch(d);
    else toast(d.fromT ? 'Start set. Now tap the dot where it ends.' : 'End set. Now tap the dot where it starts.', 4000);
    mapView.currentPopup?.remove();
  }));
  mapView.popup(coords, el);
}

// ---------- flights ----------

async function refreshFlights() {
  state.flights = (await getAll(STORES.flights)).sort((a, b) => b.date.localeCompare(a.date));
  const { from, to } = state.range;
  const shown = state.flights.filter((f) => !(from && f.date < from) && !(to && f.date > to));
  mapView.setFlights(flightsGeoJSON(shown));
}

function setupAirportPicker(inputSel, listSel) {
  const input = $(inputSel), list = $(listSel);
  input.oninput = () => {
    input._airport = null;
    input.classList.remove('chosen');
    const found = searchAirports(input.value);
    list.innerHTML = found.map((a, i) => `<li><button data-i="${i}"><span class="grow"><b>${esc(a.code)}</b> · ${esc(a.city || a.name)}${a.size === -1 ? ' (closed)' : ''}
      <small>${esc(a.name)} · ${esc(a.cc)}</small></span></button></li>`).join('');
    list.querySelectorAll('button').forEach((b) => (b.onclick = () => {
      input._airport = found[Number(b.dataset.i)];
      input.value = airportLabel(input._airport);
      input.classList.add('chosen');
      list.innerHTML = '';
    }));
  };
}

async function renderFlightsSheet() {
  await loadAirports();
  const fl = state.flights;
  const km = fl.reduce((s, f) => s + flightKm(f), 0);
  const airportsUsed = new Set(fl.flatMap((f) => [f.from.code, f.to.code]));
  $('#flight-totals').innerHTML = `
    <div><b>${fl.length}</b><span>flights</span></div>
    <div><b>${fmtNum(Math.round(km))}</b><span>km flown</span></div>
    <div><b>${airportsUsed.size}</b><span>airports</span></div>`;
  $('#fl-list').innerHTML = fl.map((f) => `<li><div class="row-actions" style="align-items:center;padding:6px 0">
      <span style="flex:1"><b>${esc(f.from.code)} → ${esc(f.to.code)}</b> · ${fmtLocalDate(f.date)}
        <small>${esc(f.from.city || f.from.name)} → ${esc(f.to.city || f.to.name)} · ${fmtNum(Math.round(flightKm(f)))} km</small></span>
      <button class="close" data-del-flight="${f.id}" aria-label="Delete flight">✕</button></div></li>`).join('')
    || '<li class="hint">No flights yet.</li>';
  $$('[data-del-flight]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Delete this flight?')) return;
    await del(STORES.flights, Number(b.dataset.delFlight));
    await refreshFlights();
    renderFlightsSheet();
  }));

  // Flights spotted in the GPS track, not yet added or dismissed
  const dismissed = new Set(await getMeta('dismissedFlights', []));
  const have = new Set(fl.map((f) => `${f.date}|${f.from.code}|${f.to.code}`));
  const sugg = detectFlights(await getChunks())
    .filter((s) => !dismissed.has(s.key) && !have.has(`${s.date}|${s.from.code}|${s.to.code}`));
  $('#fl-suggest-wrap').hidden = !sugg.length;
  $('#fl-suggest').innerHTML = sugg.map((s, i) => `<li style="padding:8px 0">
      Looks like a flight from <b>${esc(s.from.city || s.from.name)} (${esc(s.from.code)})</b> to
      <b>${esc(s.to.city || s.to.name)} (${esc(s.to.code)})</b> on ${fmtLocalDate(s.date)}.
      <div class="row-actions"><button class="btn primary" data-sugg-add="${i}">Add it</button>
      <button class="btn" data-sugg-no="${i}">Not a flight</button></div></li>`).join('');
  $$('[data-sugg-add]').forEach((b) => (b.onclick = async () => {
    const s = sugg[Number(b.dataset.suggAdd)];
    await add(STORES.flights, { date: s.date, from: airportSnapshot(s.from), to: airportSnapshot(s.to), source: 'detected', t1: s.t1, t2: s.t2, at: Date.now() });
    await refreshFlights();
    renderFlightsSheet();
    toast('Flight added ✓');
  }));
  $$('[data-sugg-no]').forEach((b) => (b.onclick = async () => {
    await setMeta('dismissedFlights', [...dismissed, sugg[Number(b.dataset.suggNo)].key]);
    renderFlightsSheet();
  }));
}

async function addFlight() {
  const from = $('#fl-from')._airport, to = $('#fl-to')._airport, date = $('#fl-date').value;
  if (!from || !to) return toast('Pick both airports from the suggestions.');
  if (!date) return toast('Please choose the date.');
  if (from.code === to.code && from.lat === to.lat) return toast('From and To are the same airport.');
  await add(STORES.flights, { date, from: airportSnapshot(from), to: airportSnapshot(to), source: 'manual', at: Date.now() });
  for (const sel of ['#fl-from', '#fl-to']) { $(sel).value = ''; $(sel)._airport = null; $(sel).classList.remove('chosen'); }
  await refreshFlights();
  renderFlightsSheet();
  toast(`Flight ${from.code} → ${to.code} added ✓`);
}

// ---------- reminders banner ----------

async function checkReminders() {
  const [lastBackupAt, lastImportAt, stats] = await Promise.all([
    getMeta('lastBackupAt'), getMeta('lastImportAt'), getPointStats(),
  ]);
  const msgs = dueReminders({ lastBackupAt, lastImportAt, hasData: stats.count > 0, reminderDays: state.settings.reminderDays });
  if (!msgs.length || sessionStorage.getItem('bannerDismissed')) { $('#banner').hidden = true; return; }
  const needsBackup = msgs.some((m) => m.kind === 'backup');
  $('#banner-text').textContent = msgs.map((m) => m.text).join(' ') + (needsBackup ? ' Back up now?' : ' Import now?');
  $('#banner-go').textContent = needsBackup ? 'Back up' : 'Import';
  $('#banner-go').onclick = () => {
    openSheet('data');
    if (needsBackup) $('#backup-heading').scrollIntoView({ block: 'start' });
  };
  $('#banner').hidden = false;
}

// ---------- import ----------

async function handleImport(files) {
  const prog = $('#import-progress');
  const out = $('#import-result');
  out.innerHTML = '';
  for (const file of files) {
    prog.hidden = false;
    prog.textContent = `Reading ${file.name}…`;
    try {
      const s = await importScoriaFile(file, state.settings);
      prog.textContent = 'Finding countries and regions…';
      const fresh = await refreshPlaces();
      const newNames = (lvl) => fresh.filter((k) => k.startsWith(`${lvl}:`)).map((k) => state.places.get(k).name);
      const nc = newNames(0), nr = newNames(1);
      out.insertAdjacentHTML('beforeend', `
        <div class="result ok">
          <b>${esc(s.fileName)}</b>
          <dl>
            <dt>Points in file</dt><dd>${fmtNum(s.pointsInFile)}</dd>
            <dt>File covers</dt><dd>${fmtDate(s.fileFirstT)} – ${fmtDate(s.fileLastT)}</dd>
            <dt>New points added</dt><dd><b>${fmtNum(s.newPoints)}</b></dd>
            <dt>Already had</dt><dd>${fmtNum(s.alreadyHad)}</dd>
            <dt>Skipped (inaccurate > ${state.settings.maxAccuracy} m)</dt><dd>${fmtNum(s.skippedAccuracy)}</dd>
            ${s.skippedSimulated ? `<dt>Skipped (simulated)</dt><dd>${fmtNum(s.skippedSimulated)}</dd>` : ''}
            ${s.skippedInvalid ? `<dt>Skipped (broken)</dt><dd>${fmtNum(s.skippedInvalid)}</dd>` : ''}
            <dt>New days with data</dt><dd>${fmtNum(s.newDays)}</dd>
            ${s.pinsAdded ? `<dt>Saved places added</dt><dd>${fmtNum(s.pinsAdded)}</dd>` : ''}
          </dl>
          ${nc.length ? `<p><b>New countries:</b> ${esc(nc.join(', '))}</p>` : ''}
          ${nr.length ? `<p><b>New regions:</b> ${esc(nr.join(', '))}</p>` : ''}
        </div>`);
    } catch (e) {
      console.error(e);
      out.insertAdjacentHTML('beforeend', `<div class="result err"><b>${esc(file.name)}</b><br>${esc(e.message)}</div>`);
    }
  }
  prog.hidden = true;
  $('#import-file').value = '';
  await refreshTracks({ fit: true });
  renderImportLog();
  sessionStorage.removeItem('bannerDismissed');
  checkReminders();
}

async function renderImportLog() {
  const log = (await getAll(STORES.imports)).sort((a, b) => b.importedAt - a.importedAt);
  $('#import-log').innerHTML = log.length
    ? log.map((s) => `<li>${esc(s.fileName)} — <b>${fmtNum(s.newPoints)}</b> new of ${fmtNum(s.pointsInFile)}
        <small>Imported ${new Date(s.importedAt).toLocaleString()} · file covers ${fmtDate(s.fileFirstT)} – ${fmtDate(s.fileLastT)}</small></li>`).join('')
    : '<li class="hint">Nothing imported yet.</li>';
}

// ---------- backup ----------

async function renderBackupStatus() {
  const [last, stats] = await Promise.all([getMeta('lastBackupAt'), getPointStats()]);
  $('#backup-status').textContent =
    `${last ? `Last backup: ${new Date(last).toLocaleString()}.` : 'No backup made yet.'} ` +
    `The app holds ${fmtNum(stats.count)} GPS points over ${fmtNum(stats.days)} days.`;
  // A prepared file goes stale once data changes, so start fresh each time.
  state.preparedBackup = null;
  $('#backup-share').hidden = true;
  $('#backup-prepare').hidden = false;
}

async function prepareBackup() {
  const btn = $('#backup-prepare');
  btn.disabled = true;
  btn.textContent = 'Packing…';
  try {
    state.preparedBackup = await buildBackupFile();
    const kb = Math.max(1, Math.round(state.preparedBackup.size / 1024));
    $('#backup-share').textContent = `Save / share backup file (${kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB'})`;
    $('#backup-share').hidden = false;
    btn.hidden = true;
  } catch (e) {
    console.error(e);
    toast(`Backup failed: ${e.message}`, 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Prepare backup';
  }
}

// Called directly from the tap, so Safari allows the share sheet.
async function shareBackup() {
  if (!state.preparedBackup) return;
  const result = await shareOrDownload(state.preparedBackup);
  if (result === 'cancelled') return toast('Backup not saved (cancelled).');
  await markBackedUp();
  toast(result === 'shared' ? 'Backup handed over ✓ — make sure you picked “Save to Files”.' : 'Backup downloaded ✓', 5000);
  sessionStorage.removeItem('bannerDismissed');
  renderBackupStatus();
  checkReminders();
}

async function handleRestore(file) {
  const out = $('#restore-result');
  out.innerHTML = '';
  try {
    const data = await readBackupFile(file);
    const ok = confirm(
      `Restore backup from ${new Date(data.exportedAt).toLocaleString()}?\n\n` +
      `It contains ${fmtNum(data.pointCount)} GPS points.\n\nEverything currently in the app will be replaced.`);
    if (!ok) return;
    await restoreBackup(data);
    await loadSettings();
    out.innerHTML = `<div class="result ok">Restored ✓ ${fmtNum(data.pointCount)} GPS points.</div>`;
    await refreshTracks({ fit: true });
    await refreshPlaces();
    await refreshFlights();
    renderBackupStatus();
    checkReminders();
  } catch (e) {
    console.error(e);
    out.innerHTML = `<div class="result err">${esc(e.message)}</div>`;
  } finally {
    $('#restore-file').value = '';
  }
}

// ---------- dates ----------

function renderDateSheet() {
  $('#date-from').value = state.range.from ?? '';
  $('#date-to').value = state.range.to ?? '';
  getPointStats().then((s) => {
    $('#date-summary').textContent = s.count ? `Your data runs from ${fmtDate(s.firstT)} to ${fmtDate(s.lastT)}.` : '';
  });
}

async function applyRange(from, to) {
  state.range = { from: from || null, to: to || null };
  $$('#date-presets button').forEach((b) => b.classList.remove('on'));
  closeSheets();
  await refreshTracks({ fit: true });
  await refreshPlaces();
  await refreshFlights();
}

function presetRange(preset) {
  const now = new Date();
  const y = now.getFullYear();
  switch (preset) {
    case 'year': return [`${y}-01-01`, `${y}-12-31`];
    case 'lastyear': return [`${y - 1}-01-01`, `${y - 1}-12-31`];
    case '30': return [localDayString(new Date(now - 29 * 86400_000)), localDayString(now)];
    default: return [null, null];
  }
}

// ---------- layers ----------

function renderLayersSheet() {
  $$('#style-seg button').forEach((b) => b.classList.toggle('on', b.dataset.style === state.settings.mapStyle));
  $$('#level-seg button').forEach((b) => b.classList.toggle('on', Number(b.dataset.level) === state.settings.mapLevel));
  $('#level-hint').textContent = [
    'Whole countries.',
    'States, comunidades, Bundesländer, régions, regioni… for every country.',
    'For now only where the border data has them: Spain (provincias), France (départements), Italy (province), UK (councils), and a few more. More countries come in a later step.',
  ][state.settings.mapLevel];
}

// ---------- settings ----------

async function loadSettings() {
  state.settings = { ...DEFAULT_SETTINGS, ...(await getMeta('settings', {})) };
}

async function renderSettings() {
  const form = $('#settings-form');
  for (const [k, v] of Object.entries(state.settings)) {
    const el = form.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
  try {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    if (est) {
      $('#storage-info').textContent =
        `Storage used: ${(est.usage / 1048576).toFixed(1)} MB. ` +
        (persisted ? 'Browser has agreed to keep the data.' : 'The browser may clear data if space runs low — keep backups!');
    }
  } catch { /* not supported */ }
}

async function saveSettings(ev) {
  ev.preventDefault();
  const form = ev.target;
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    const el = form.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') { state.settings[k] = el.checked; continue; }
    const n = Number(el.value);
    if (Number.isFinite(n) && n > 0) state.settings[k] = n;
  }
  await setMeta('settings', state.settings);
  toast('Settings saved ✓');
  closeSheets();
  await refreshTracks();
  refreshPlaces();
  checkReminders();
}

async function wipeAll() {
  if (!confirm('Delete ALL data in this app (GPS points, manual places, settings)?\n\nThis cannot be undone. Make a backup first if unsure.')) return;
  if (prompt('Type DELETE to confirm') !== 'DELETE') return;
  await clearStores(Object.values(STORES));
  state.settings = { ...DEFAULT_SETTINGS };
  closeSheets();
  await refreshTracks();
  await refreshPlaces();
  await refreshFlights();
  toast('All data deleted.');
  checkReminders();
}

// ---------- start-up ----------

async function init() {
  await loadSettings();
  mapView = new MapView('map', { style: state.settings.mapStyle });
  mapView.setLevel(state.settings.mapLevel);
  mapView.onPlaceTap = (level, id) => openPlace(level, id);
  mapView.onPointTap = onPointTap;
  if (location.hostname === 'localhost') window.__scratchmap = { mapView, state }; // testing aid, local only

  // Toolbar + sheets
  $$('.toolbar button').forEach((b) => (b.onclick = () => {
    const open = !$(`#sheet-${b.dataset.sheet}`).hidden;
    open ? closeSheets() : openSheet(b.dataset.sheet);
  }));
  $$('.sheet .close').forEach((b) => (b.onclick = closeSheets));
  $('#scrim').onclick = closeSheets;
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeSheets());

  // Banner
  $('#banner-close').onclick = () => { sessionStorage.setItem('bannerDismissed', '1'); $('#banner').hidden = true; };

  // Layers
  $('#lyr-scratch').onchange = (e) => mapView.setVisible('scratch', e.target.checked);
  $('#lyr-routes').onchange = (e) => mapView.setVisible('routes', e.target.checked);
  $('#lyr-flights').onchange = (e) => mapView.setVisible('flights', e.target.checked);

  // Places: search, stretches
  $('#place-search').oninput = renderPlaceSearch;
  $('#stretch-new').onclick = () => openStretch(state.stretchDraft);
  $$('#st-as button').forEach((b) => (b.onclick = () => setStretchAs(b.dataset.as)));
  $('#st-save').onclick = saveStretch;

  // Flights
  setupAirportPicker('#fl-from', '#fl-from-list');
  setupAirportPicker('#fl-to', '#fl-to-list');
  $('#fl-add').onclick = addFlight;
  $$('#level-seg button').forEach((b) => (b.onclick = () => setLevel(Number(b.dataset.level))));
  $('#lyr-points').onchange = (e) => mapView.setVisible('points', e.target.checked);
  $$('#style-seg button').forEach((b) => (b.onclick = async () => {
    state.settings.mapStyle = b.dataset.style;
    await setMeta('settings', state.settings);
    mapView.setStyle(b.dataset.style);
    renderLayersSheet();
  }));

  // Dates
  $$('#date-presets button').forEach((b) => (b.onclick = () => {
    const [f, t] = presetRange(b.dataset.preset);
    $('#date-from').value = f ?? '';
    $('#date-to').value = t ?? '';
    applyRange(f, t);
  }));
  $('#date-apply').onclick = () => applyRange($('#date-from').value, $('#date-to').value);

  // Import
  $('#import-file').onchange = (e) => e.target.files.length && handleImport([...e.target.files]);

  // Backup
  $('#backup-prepare').onclick = prepareBackup;
  $('#backup-share').onclick = shareBackup;
  $('#ics-download').onclick = () => shareOrDownload(buildMonthlyIcs());
  $('#restore-file').onchange = (e) => e.target.files[0] && handleRestore(e.target.files[0]);

  // Settings
  $('#settings-form').onsubmit = saveSettings;
  $('#wipe').onclick = wipeAll;

  requestPersistence();
  await refreshTracks({ fit: true });
  checkReminders();
  mapView.setBoundaries(await loadBoundaries());
  await Promise.all([refreshPlaces(), refreshFlights()]);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker failed', e));
  }
}

init().catch((e) => {
  console.error(e);
  $('#status').textContent = `Something went wrong: ${e.message}`;
});
