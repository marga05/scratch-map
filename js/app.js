// app.js — the "conductor": connects buttons and panels to the other modules.

import { getMeta, setMeta, getChunks, getPointStats, getAll, requestPersistence, clearStores, STORES, dayKey } from './db.js';
import { importScoriaFile } from './importer.js';
import { buildTracks } from './tracks.js';
import { MapView } from './mapview.js';
import { buildBackupFile, shareOrDownload, markBackedUp, readBackupFile, restoreBackup } from './backup.js';
import { dueReminders, buildMonthlyIcs } from './reminders.js';
import { loadBoundaries, updateVisits, countAreas, stays, bbox } from './places.js';

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
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  range: { from: null, to: null }, // 'YYYY-MM-DD' strings (local dates), null = open
  preparedBackup: null,
  places: new Map(),  // "level:id" → place, see places.js
  km: 0,
};

const LEVEL_NAMES = ['countries', 'regions', 'provinces'];

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
  $(`.toolbar [data-sheet="${name}"]`)?.classList.add('active');
  onSheetOpen[name]?.();
}
function closeSheets() {
  mapView?.select(null);
  $$('.sheet').forEach((s) => (s.hidden = true));
  $('#scrim').hidden = true;
  $$('.toolbar button').forEach((b) => b.classList.remove('active'));
}
const onSheetOpen = {
  places: renderPlacesSheet,
  import: renderImportLog,
  backup: renderBackupStatus,
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

/** Does this place count in totals? (Later: "passed through" places can be switched off.) */
const counts = (p) => p.status === 'visited';

async function refreshPlaces() {
  const before = new Set(state.places.keys());
  state.places = await updateVisits(state.settings, state.range, (done, total) => {
    $('#status').textContent = `Finding places… ${Math.round((done / total) * 100)}%`;
  });
  mapView.setPlaceStates(state.places);
  renderStatus();
  return [...state.places.keys()].filter((k) => !before.has(k));
}

function placesOf(level, a0) {
  return [...state.places.values()].filter((p) => p.level === level && (a0 == null || p.a0 === a0));
}

function renderPlacesSheet() {
  const all = [...state.places.values()].filter(counts);
  const n = (lvl) => all.filter((p) => p.level === lvl).length;
  const allDates = new Set(all.filter((p) => p.level === 0).flatMap((p) => [...p.dates]));
  $('#totals').innerHTML = `
    <div><b>${n(0)}</b><span>countries</span></div>
    <div><b>${n(1)}</b><span>regions</span></div>
    <div><b>${fmtNum(allDates.size)}</b><span>days travelled</span></div>`;

  const countries = placesOf(0).filter(counts).sort((a, b) => b.dates.size - a.dates.size);
  $('#place-list').innerHTML = countries.length
    ? countries.map((c) => {
      const r = placesOf(1, c.id).filter(counts).length;
      const r2 = placesOf(2, c.id).filter(counts).length;
      const total2 = countAreas(c.id, 2);
      return `<li><button data-level="0" data-id="${esc(c.id)}">
        <span class="swatch ${c.status}"></span>
        <span class="grow">${esc(c.name)}
          <small>${r}/${countAreas(c.id, 1)} regions${total2 ? ` · ${r2}/${total2} provinces` : ''}</small></span>
        <span class="days">${c.dates.size} ${c.dates.size === 1 ? 'day' : 'days'}</span>
      </button></li>`;
    }).join('')
    : '<li class="hint">No places yet. Import GPS data to fill your map.</li>';
  $$('#place-list button').forEach((b) => (b.onclick = () => openPlace(Number(b.dataset.level), b.dataset.id)));
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

function openPlace(level, id) {
  const key = `${level}:${id}`;
  const p = state.places.get(key);
  const feature = mapView.featureOf(level, id);
  const name = p?.name ?? feature?.properties.name ?? id;
  const a0 = p?.a0 ?? (level === 0 ? id : feature?.properties.a0);
  const country = level > 0 ? state.places.get(`0:${a0}`)?.name ?? mapView.featureOf(0, a0)?.properties.name : null;

  $('#place-title').textContent = name;
  const body = $('#place-body');
  if (!p) {
    body.innerHTML = `
      ${country ? `<p class="hint">${esc(country)}</p>` : ''}
      <p><span class="badge">Not visited</span></p>
      <p class="hint">No GPS points on the ground here${state.range.from || state.range.to ? ' in the selected dates' : ''}.
      Adding places by hand comes in a later step.</p>`;
  } else {
    const st = stays(p.dates);
    const sub = level < 2 ? placesOf(level + 1, level === 0 ? id : a0)
      .filter((x) => level === 0 || x.l1 === id)
      .filter(counts)
      .sort((x, y) => y.dates.size - x.dates.size) : [];
    body.innerHTML = `
      ${country ? `<p class="hint">${esc(country)}</p>` : ''}
      <p><span class="badge ${p.status}">Visited</span> <span class="hint">· from GPS</span></p>
      <div class="facts">
        <div><small>Days</small><b>${p.dates.size}</b></div>
        <div><small>Stays</small><b>${st.length}</b></div>
        <div><small>First visit</small>${fmtLocalDate([...p.dates].sort()[0])}</div>
        <div><small>Last visit</small>${fmtLocalDate([...p.dates].sort().at(-1))}</div>
      </div>
      <button class="btn primary wide" id="place-zoom">Zoom to my routes here</button>
      <h3>Dates</h3>
      <ul class="stays">${st.slice().reverse().map((s) =>
        `<li><span>${fmtStay(s)}</span><span>${s.days} ${s.days === 1 ? 'day' : 'days'}</span></li>`).join('')}</ul>
      ${sub.length ? `<h3>${level === 0 ? 'Regions' : 'Provinces'} visited</h3>
      <ul class="place-list">${sub.map((x) => `<li><button data-level="${x.level}" data-id="${esc(x.id)}">
        <span class="swatch ${x.status}"></span><span class="grow">${esc(x.name)}</span>
        <span class="days">${x.dates.size} ${x.dates.size === 1 ? 'day' : 'days'}</span></button></li>`).join('')}</ul>` : ''}`;
    $('#place-zoom').onclick = () => { closeSheets(); mapView.fitTo(p.bounds); };
    body.querySelectorAll('.place-list button').forEach((b) =>
      (b.onclick = () => openPlace(Number(b.dataset.level), b.dataset.id)));
  }
  openSheet('place');
  mapView.select(level, id); // after openSheet, which clears the old selection
  if (!p && feature) mapView.fitTo(bbox(feature.geometry));
}

async function setLevel(level) {
  state.settings.mapLevel = level;
  await setMeta('settings', state.settings);
  mapView.setLevel(level);
  renderLayersSheet();
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
  $('#banner-go').onclick = () => openSheet(needsBackup ? 'backup' : 'import');
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
    if (form.elements[k]) form.elements[k].value = v;
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
    if (form.elements[k]) {
      const n = Number(form.elements[k].value);
      if (Number.isFinite(n) && n > 0) state.settings[k] = n;
    }
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
  toast('All data deleted.');
  checkReminders();
}

// ---------- start-up ----------

async function init() {
  await loadSettings();
  mapView = new MapView('map', { style: state.settings.mapStyle });
  mapView.setLevel(state.settings.mapLevel);
  mapView.onPlaceTap = (level, id) => openPlace(level, id);

  // Toolbar + sheets
  $$('.toolbar button').forEach((b) => (b.onclick = () => {
    const open = !$(`#sheet-${b.dataset.sheet}`).hidden;
    open ? closeSheets() : openSheet(b.dataset.sheet);
  }));
  $$('.sheet .close').forEach((b) => (b.onclick = closeSheets));
  $('#scrim').onclick = closeSheets;

  // Banner
  $('#banner-close').onclick = () => { sessionStorage.setItem('bannerDismissed', '1'); $('#banner').hidden = true; };

  // Layers
  $('#lyr-scratch').onchange = (e) => mapView.setVisible('scratch', e.target.checked);
  $('#lyr-routes').onchange = (e) => mapView.setVisible('routes', e.target.checked);
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
  await refreshPlaces();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker failed', e));
  }
}

init().catch((e) => {
  console.error(e);
  $('#status').textContent = `Something went wrong: ${e.message}`;
});
