// mapview.js — the map itself (MapLibre GL) and the layers we draw on top.
//
// Base maps come from OpenFreeMap: free, OpenStreetMap-based, no API key.
// On top, from bottom to top: scratch-map colours → route lines → GPS dots.

import * as maplibregl from '../vendor/maplibre/maplibre-gl.mjs';

export const MAP_STYLES = {
  normal: { label: 'Normal', url: 'https://tiles.openfreemap.org/styles/liberty' },
  minimal: { label: 'Minimal', url: 'https://tiles.openfreemap.org/styles/positron' },
};

// Gold scratch-off look
export const SCRATCH_COLORS = {
  visited: '#e0a526',
  passed: '#f2d68c',
  outline: '#a8761a',
};

const EMPTY = { type: 'FeatureCollection', features: [] };
const LEVEL_SOURCES = ['countries', 'admin1', 'admin2'];

export class MapView {
  constructor(container, { style = 'normal' } = {}) {
    this.data = { lines: EMPTY, points: EMPTY };
    this.boundaries = null;     // { countries, admin1, admin2 } GeoJSON
    this.placeStates = new Map(); // "level:id" → { status }
    this.level = 0;
    this.selected = null;       // "level:id"
    this.visible = { routes: true, points: true, scratch: true };
    this.map = new maplibregl.Map({
      container,
      style: MAP_STYLES[style]?.url ?? MAP_STYLES.normal.url,
      center: [10, 45],
      zoom: 2.5,
      attributionControl: { compact: true },
    });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    this.map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl(), 'bottom-left');

    // A style change wipes our layers, so (re)add them every time a style loads.
    // (map.isStyleLoaded() can say "no" while tiles are still loading, so we keep our own flag.)
    this.styleReady = false;
    this.map.on('style.load', () => { this.styleReady = true; this.#addLayers(); });

    // Tapping the map → which area of the current level is here?
    this.map.on('click', (e) => {
      if (!this.onPlaceTap || !this.visible.scratch) return;
      const f = this.map.queryRenderedFeatures(e.point, { layers: [`fill-${this.level}`] })[0];
      if (f) this.onPlaceTap(this.level, f.properties.id);
    });
  }

  setStyle(key) {
    this.styleReady = false;
    this.map.setStyle(MAP_STYLES[key].url);
  }

  #addLayers() {
    const m = this.map;
    // Put the scratch colours underneath the map's place names, so labels stay readable.
    const firstLabel = m.getStyle().layers.find((l) => l.type === 'symbol')?.id;

    if (this.boundaries) this.#addScratchLayers(firstLabel);

    m.addSource('routes', { type: 'geojson', data: this.data.lines, tolerance: 0.6 });
    m.addSource('points', { type: 'geojson', data: this.data.points, maxzoom: 16 });

    m.addLayer({
      id: 'routes-casing', type: 'line', source: 'routes',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-opacity': 0.8,
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 2.5, 10, 5, 16, 8],
      },
    });
    m.addLayer({
      id: 'routes', type: 'line', source: 'routes',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#e2483d',
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.2, 10, 3, 16, 5],
      },
    });
    // Dots only appear when zoomed in (minzoom), to keep the phone fast.
    m.addLayer({
      id: 'points', type: 'circle', source: 'points', minzoom: 12,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 2, 18, 5],
        'circle-color': '#1d4ed8',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1,
      },
    });
    this.#applyVisibility();
  }

  #addScratchLayers(beforeId) {
    const m = this.map;
    LEVEL_SOURCES.forEach((src, level) => {
      // promoteId lets us colour each area by its id without copying the data.
      m.addSource(src, { type: 'geojson', data: this.boundaries[src], promoteId: 'id' });
      m.addLayer({
        id: `fill-${level}`, type: 'fill', source: src,
        paint: {
          'fill-color': ['match', ['feature-state', 'status'],
            'visited', SCRATCH_COLORS.visited,
            'passed', SCRATCH_COLORS.passed,
            '#000000'],
          'fill-opacity': ['match', ['feature-state', 'status'],
            'visited', 0.55,
            'passed', 0.45,
            0], // not visited: invisible but still tappable
        },
      }, beforeId);
      m.addLayer({
        id: `line-${level}`, type: 'line', source: src,
        paint: {
          'line-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#14213d', SCRATCH_COLORS.outline],
          'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 3,
            ['match', ['feature-state', 'status'], 'visited', 1, 'passed', 1, 0.4]],
          'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1,
            ['match', ['feature-state', 'status'], 'visited', 0.9, 'passed', 0.7, 0.35]],
        },
      }, beforeId);
    });
    this.#applyPlaceStates();
  }

  /** Give the map the border data (once). */
  setBoundaries(b) {
    this.boundaries = { countries: b.countries, admin1: b.admin1, admin2: b.admin2 };
    if (this.styleReady && !this.map.getSource('countries')) {
      const firstLabel = this.map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
      // Scratch layers must sit below the routes, so insert below the route casing if present.
      this.#addScratchLayers(this.map.getLayer('routes-casing') ? 'routes-casing' : firstLabel);
      this.#applyVisibility();
    }
  }

  /** places: Map "level:id" → place (with .status) */
  setPlaceStates(places) {
    this.placeStates = places;
    this.#applyPlaceStates();
  }

  #applyPlaceStates() {
    const m = this.map;
    if (!m.getSource('countries')) return;
    LEVEL_SOURCES.forEach((src) => m.removeFeatureState({ source: src }));
    for (const p of this.placeStates.values()) {
      m.setFeatureState({ source: LEVEL_SOURCES[p.level], id: p.id }, { status: p.status });
    }
    if (this.selected) {
      const [lvl, id] = this.#splitKey(this.selected);
      m.setFeatureState({ source: LEVEL_SOURCES[lvl], id }, { selected: true });
    }
  }

  #splitKey(key) {
    const i = key.indexOf(':');
    return [Number(key.slice(0, i)), key.slice(i + 1)];
  }

  select(level, id) {
    const m = this.map;
    if (this.selected && m.getSource('countries')) {
      const [l, i] = this.#splitKey(this.selected);
      m.setFeatureState({ source: LEVEL_SOURCES[l], id: i }, { selected: false });
    }
    this.selected = level == null ? null : `${level}:${id}`;
    if (this.selected && m.getSource('countries')) {
      m.setFeatureState({ source: LEVEL_SOURCES[level], id }, { selected: true });
    }
  }

  setLevel(level) {
    this.level = level;
    this.#applyVisibility();
  }

  setTrackData({ lines, points }) {
    this.data = { lines, points };
    this.map.getSource('routes')?.setData(lines);
    this.map.getSource('points')?.setData(points);
  }

  setVisible(layer, on) {
    this.visible[layer] = on;
    this.#applyVisibility();
  }

  #applyVisibility() {
    const m = this.map;
    const set = (id, on) => m.getLayer(id) && m.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    set('routes', this.visible.routes);
    set('routes-casing', this.visible.routes);
    set('points', this.visible.points);
    for (let l = 0; l < LEVEL_SOURCES.length; l++) {
      set(`fill-${l}`, this.visible.scratch && l === this.level);
      set(`line-${l}`, this.visible.scratch && l === this.level);
    }
  }

  fitTo(bounds) {
    if (!bounds) return;
    this.map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], {
      // Extra room at top (status chip + banner) and bottom (toolbar).
      padding: { top: 120, bottom: 110, left: 40, right: 70 },
      maxZoom: 14,
      duration: 800,
    });
  }

  /** The feature (shape) of one area, or undefined. */
  featureOf(level, id) {
    return this.boundaries?.[LEVEL_SOURCES[level]].features.find((x) => x.properties.id === id);
  }
}
