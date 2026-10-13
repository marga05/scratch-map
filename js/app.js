// app.js — the "conductor": connects buttons and panels to the other modules.

import { getMeta, setMeta, getChunks, getPointStats, getAll, requestPersistence, clearStores, STORES, dayKey } from './db.js';
import { importScoriaFile } from './importer.js';
import { buildTracks } from './tracks.js';
import { MapView } from './mapview.js';
import { buildBackupFile, shareOrDownload, markBackedUp, readBackupFile, restoreBackup } from './backup.js';
import { dueReminders, buildMonthlyIcs } from './reminders.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

export const DEFAULT_SETTINGS = {
  maxAccuracy: 100,   // metres
  gapMinutes: 30,
  gapKm: 5,
  maxGroundKmh: 400,
  reminderDays: 30,
  mapStyle: 'normal',
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  range: { from: null, to: null }, // 'YYYY-MM-DD' strings (local dates), null = open
  preparedBackup: null,
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
  $(`.toolbar [data-sheet="${name}"]`)?.classList.add('active');
  onSheetOpen[name]?.();
}
function closeSheets() {
  $$('.sheet').forEach((s) => (s.hidden = true));
  $('#scrim').hidden = true;
  $$('.toolbar button').forEach((b) => b.classList.remove('active'));
}
const onSheetOpen = {
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

  const rangeLabel = from || to ? `${from ? fmtDate(fromT) : '…'} – ${to ? fmtDate(toT) : '…'}` : 'All time';
  $('#status').textContent = tracks.count
    ? `${rangeLabel} · ${fmtNum(tracks.count)} points · ${fmtNum(Math.round(tracks.totalKm))} km`
    : (from || to ? `${rangeLabel} · no GPS points in this range` : 'No GPS points yet — tap Import');
  return tracks;
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
  refreshTracks();
  checkReminders();
}

async function wipeAll() {
  if (!confirm('Delete ALL data in this app (GPS points, manual places, settings)?\n\nThis cannot be undone. Make a backup first if unsure.')) return;
  if (prompt('Type DELETE to confirm') !== 'DELETE') return;
  await clearStores(Object.values(STORES));
  state.settings = { ...DEFAULT_SETTINGS };
  closeSheets();
  await refreshTracks();
  toast('All data deleted.');
  checkReminders();
}

// ---------- start-up ----------

async function init() {
  await loadSettings();
  mapView = new MapView('map', { style: state.settings.mapStyle });

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
  $('#lyr-routes').onchange = (e) => mapView.setVisible('routes', e.target.checked);
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

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker failed', e));
  }
}

init().catch((e) => {
  console.error(e);
  $('#status').textContent = `Something went wrong: ${e.message}`;
});
