// sw.js — the service worker: a small helper the browser runs in the background
// so the app opens even without internet.
//
// • App files: saved on install; fetched fresh when online, saved copy used
//   when offline. Bump VERSION when adding/removing app files.
// • Map tiles/styles from OpenFreeMap: saved as you view them, so places you've
//   looked at still show offline. Capped so it doesn't fill your phone.

const VERSION = 'v4';
const APP_CACHE = `scratchmap-app-${VERSION}`;
const TILE_CACHE = 'scratchmap-tiles';
const MAX_TILES = 4000;

const APP_FILES = [
  './',
  'index.html',
  'css/app.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/db.js',
  'js/importer.js',
  'js/import-text.js',
  'js/tracks.js',
  'js/mapview.js',
  'js/backup.js',
  'js/reminders.js',
  'js/places.js',
  'js/flights.js',
  'data/airports.json',
  'data/countries.json',
  'data/admin1.json',
  'data/admin2-ne.json',
  'vendor/maplibre/maplibre-gl.mjs',
  'vendor/maplibre/maplibre-gl-worker.mjs',
  'vendor/maplibre/maplibre-gl.css',
  'vendor/sqljs/sql-wasm.js',
  'vendor/sqljs/sql-wasm.wasm',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('scratchmap-app-') && key !== APP_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

async function trimTiles() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Map tiles, fonts, styles: use saved copy if we have it, else fetch & save.
  if (url.hostname.endsWith('openfreemap.org')) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) {
        cache.put(req, res.clone());
        if (Math.random() < 0.02) trimTiles();
      }
      return res;
    })());
    return;
  }

  // Our own files: try the internet first so you always get the newest version;
  // if offline (or it takes > 3 s), use the saved copy.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(APP_CACHE);
      // cache: 'no-cache' = always ask the server "has this changed?" (cheap when it hasn't),
      // so after an update every file is the new version, never a mix of old and new.
      const network = fetch(req, { cache: 'no-cache' }).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      });
      const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
      try {
        const res = await Promise.race([network, timeout]);
        if (res) return res;
      } catch { /* offline */ }
      const hit = await cache.match(req, { ignoreSearch: true });
      return hit || network;
    })());
  }
});
