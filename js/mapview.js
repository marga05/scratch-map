// mapview.js — the map itself (MapLibre GL) and the layers we draw on top.
//
// Base maps come from OpenFreeMap: free, OpenStreetMap-based, no API key.

import * as maplibregl from '../vendor/maplibre/maplibre-gl.mjs';

export const MAP_STYLES = {
  normal: { label: 'Normal', url: 'https://tiles.openfreemap.org/styles/liberty' },
  minimal: { label: 'Minimal', url: 'https://tiles.openfreemap.org/styles/positron' },
};

const EMPTY = { type: 'FeatureCollection', features: [] };

export class MapView {
  constructor(container, { style = 'normal' } = {}) {
    this.data = { lines: EMPTY, points: EMPTY };
    this.visible = { routes: true, points: true };
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
    this.map.on('style.load', () => this.#addLayers());
  }

  setStyle(key) {
    this.map.setStyle(MAP_STYLES[key].url);
  }

  #addLayers() {
    const m = this.map;
    m.addSource('routes', { type: 'geojson', data: this.data.lines, tolerance: 0.6 });
    // Points: clustering off; dots only appear when zoomed in (see minzoom).
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
    const vis = (on) => (on ? 'visible' : 'none');
    for (const id of ['routes', 'routes-casing']) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', vis(this.visible.routes));
    }
    if (this.map.getLayer('points')) this.map.setLayoutProperty('points', 'visibility', vis(this.visible.points));
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
}
