/**
 * Carte Leaflet : fonds de carte, points de passage déplaçables, tracé coloré,
 * POI, curseur synchronisé avec le profil altimétrique.
 * Leaflet est chargé globalement (window.L) par index.html.
 */
import { BASE_LAYERS, OVERLAYS, SURFACES, DIFFICULTIES, WAY_TYPES, POI_CATEGORIES } from '../config.js';
import { PolylineIndex } from '../core/geo.js';
import { settings } from '../core/settings.js';

const L = window.L;

export function gradeColor(g) {
  if (g <= -8) return '#1d4ed8';
  if (g <= -3) return '#60a5fa';
  if (g < 3) return '#22c55e';
  if (g < 6) return '#eab308';
  if (g < 9) return '#f97316';
  if (g < 12) return '#dc2626';
  return '#7f1d1d';
}

export const GRADE_LEGEND = [
  { label: '< −8 %', color: '#1d4ed8' }, { label: '−8 à −3 %', color: '#60a5fa' }, { label: '±3 %', color: '#22c55e' },
  { label: '3 à 6 %', color: '#eab308' }, { label: '6 à 9 %', color: '#f97316' }, { label: '9 à 12 %', color: '#dc2626' },
  { label: '> 12 %', color: '#7f1d1d' },
];

export function pointColor(route, i, mode) {
  switch (mode) {
    case 'surface': return SURFACES[route.surface[i]].color;
    case 'difficulty': return DIFFICULTIES[route.difficulty[i]].color;
    case 'way': return WAY_TYPES[route.way[i]].color;
    case 'grade': return gradeColor(route.grades[i]);
    default: return '#2563eb';
  }
}

export class MapView {
  /**
   * @param {HTMLElement} el
   * @param {object} h gestionnaires : onMapClick, onWaypointMove, onWaypointDelete, waypointPopup,
   *   onRouteInsert, onHover, poiPopup
   */
  constructor(el, h) {
    this.h = h;
    this.map = L.map(el, { zoomControl: true, preferCanvas: false, doubleClickZoom: false }).setView([46.6, 2.4], 6);
    this.renderer = L.canvas({ padding: 0.5, tolerance: 6 });
    this._initLayers();
    L.control.scale({ imperial: false }).addTo(this.map);

    this.routeGroup = L.layerGroup().addTo(this.map);
    this.poiGroup = L.layerGroup().addTo(this.map);
    this.wpGroup = L.layerGroup().addTo(this.map);
    this.rangeLayer = null;
    this.cursor = L.circleMarker([0, 0], { radius: 7, color: '#fff', weight: 3, fillColor: '#111827', fillOpacity: 1, interactive: false });
    this.route = null;
    this.index = null;
    this.markers = new Map();

    this.map.on('click', (e) => this.h.onMapClick?.(e.latlng));
  }

  _initLayers() {
    this.baseLayers = {};
    const key = settings.get('thunderforestKey');
    for (const def of BASE_LAYERS) {
      if (def.requiresKey && !(def.requiresKey === 'thunderforest' && key)) continue;
      const url = def.url.replace('{apikey}', encodeURIComponent(key || ''));
      this.baseLayers[def.label] = Object.assign(L.tileLayer(url, { ...def.options, crossOrigin: true }), { _id: def.id });
    }
    this.overlays = {};
    for (const def of OVERLAYS) this.overlays[def.label] = Object.assign(L.tileLayer(def.url, def.options), { _id: def.id });
    const wanted = settings.get('baseLayer');
    const base = Object.values(this.baseLayers).find((l) => l._id === wanted) || Object.values(this.baseLayers)[0];
    base.addTo(this.map);
    for (const l of Object.values(this.overlays)) if ((settings.get('overlays') || []).includes(l._id)) l.addTo(this.map);
    this.layerControl = L.control.layers(this.baseLayers, this.overlays, { position: 'topright' }).addTo(this.map);
    this.map.on('baselayerchange', (e) => settings.set({ baseLayer: e.layer._id }));
    const syncOverlays = () => settings.set({ overlays: Object.values(this.overlays).filter((l) => this.map.hasLayer(l)).map((l) => l._id) });
    this.map.on('overlayadd overlayremove', syncOverlays);
  }

  /** Recrée les fonds (après saisie d'une clé API). */
  refreshLayers() {
    for (const l of [...Object.values(this.baseLayers), ...Object.values(this.overlays)]) this.map.removeLayer(l);
    this.layerControl.remove();
    this._initLayers();
  }

  invalidate() {
    this.map.invalidateSize();
  }

  // ---------- Points de passage ----------

  setWaypoints(wps, mode) {
    this.wpGroup.clearLayers();
    this.markers.clear();
    wps.forEach((w, i) => {
      const isStart = i === 0;
      const isEnd = i === wps.length - 1 && wps.length > 1 && mode === 'oneway';
      const label = isStart ? 'D' : isEnd ? 'A' : String(i);
      const cls = isStart ? 'wp-start' : isEnd ? 'wp-end' : w.poi ? 'wp-poi' : 'wp-via';
      const icon = L.divIcon({ className: 'wp-icon', html: `<div class="wp ${cls}">${label}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
      const m = L.marker([w.lat, w.lng], { icon, draggable: true, autoPan: true, title: w.name || `Point ${i + 1}`, riseOnHover: true });
      m.on('dragend', () => this.h.onWaypointMove?.(w.id, m.getLatLng()));
      m.on('contextmenu', (e) => {
        L.DomEvent.preventDefault(e.originalEvent);
        this.h.onWaypointDelete?.(w.id);
      });
      m.bindPopup(() => this.h.waypointPopup(w.id), { minWidth: 220 });
      m.addTo(this.wpGroup);
      this.markers.set(w.id, m);
    });
  }

  // ---------- Tracé ----------

  setRoute(route, colorMode) {
    this.routeGroup.clearLayers();
    this.clearRange();
    this.cursor.remove();
    this.route = route;
    this.index = null;
    if (!route || route.points.length < 2) return;
    const pts = route.points;
    this.index = new PolylineIndex(pts, route.cum);
    const latlngs = pts.map((p) => [p.lat, p.lng]);
    L.polyline(latlngs, { renderer: this.renderer, color: '#fff', weight: 9, opacity: 0.9, interactive: false }).addTo(this.routeGroup);

    // Regroupe les segments consécutifs de même style en une seule polyligne.
    const legKind = (i) => route.legs?.[pts[i].leg]?.kind;
    let run = [latlngs[0]];
    let style = null;
    const flush = () => {
      if (run.length > 1 && style) {
        L.polyline(run, { renderer: this.renderer, color: style.color, weight: 5, opacity: 1, dashArray: style.dash, interactive: false, lineCap: 'butt' }).addTo(this.routeGroup);
      }
    };
    for (let i = 1; i < pts.length; i++) {
      const kind = legKind(i);
      const s = kind === 'error' ? { color: '#dc2626', dash: '6 8' }
        : kind === 'straight' ? { color: '#6b7280', dash: '4 6' }
          : { color: pointColor(route, i, colorMode), dash: null };
      if (!style || s.color !== style.color || s.dash !== style.dash) {
        flush();
        run = [latlngs[i - 1]];
        style = s;
      }
      run.push(latlngs[i]);
    }
    flush();

    // Ligne invisible et large pour le survol et le « glisser pour ajouter un point ».
    const hit = L.polyline(latlngs, { renderer: this.renderer, color: '#000', opacity: 0, weight: 18, bubblingMouseEvents: false }).addTo(this.routeGroup);
    hit.on('mousemove', (e) => {
      const n = this.index.nearest(e.latlng.lat, e.latlng.lng);
      if (n) this.h.onHover?.(n.vertex, true);
    });
    hit.on('mouseout', () => this.h.onHover?.(null, true));
    hit.on('mousedown', (e) => this._startRouteDrag(e));
    hit.on('click', (e) => L.DomEvent.stop(e));
  }

  _startRouteDrag(e) {
    const oe = e.originalEvent;
    if (oe.button !== 0) return;
    L.DomEvent.stop(e);
    const n = this.index.nearest(e.latlng.lat, e.latlng.lng);
    if (!n) return;
    const legIdx = this.route.points[n.vertex].leg;
    const map = this.map;
    map.dragging.disable();
    const start = map.mouseEventToContainerPoint(oe);
    const ghost = L.circleMarker(e.latlng, { radius: 8, color: '#111827', weight: 2, fillColor: '#fbbf24', fillOpacity: 1, interactive: false });
    let moved = false;
    const move = (ev) => {
      if (!moved && ev.containerPoint.distanceTo(start) > 6) {
        moved = true;
        ghost.addTo(map);
      }
      if (moved) ghost.setLatLng(ev.latlng);
    };
    const up = () => {
      map.off('mousemove', move);
      map.dragging.enable();
      ghost.remove();
      // Relâcher sans avoir bougé = simple clic : ajoute un point en fin de parcours.
      if (moved) this.h.onRouteInsert?.(legIdx, ghost.getLatLng());
      else this.h.onMapClick?.(e.latlng);
    };
    map.on('mousemove', move);
    document.addEventListener('mouseup', up, { once: true });
  }

  showCursor(idx) {
    if (idx == null || !this.route?.points[idx]) {
      this.cursor.remove();
      return;
    }
    const p = this.route.points[idx];
    this.cursor.setLatLng([p.lat, p.lng]);
    if (!this.map.hasLayer(this.cursor)) this.cursor.addTo(this.map);
  }

  highlightRange(a, b) {
    this.clearRange();
    if (!this.route || a == null || b == null) return;
    if (a > b) [a, b] = [b, a];
    const pts = this.route.points.slice(a, b + 1).map((p) => [p.lat, p.lng]);
    this.rangeLayer = L.polyline(pts, { color: '#facc15', weight: 12, opacity: 0.55, interactive: false }).addTo(this.map);
    this.rangeLayer.bringToBack();
  }

  clearRange() {
    this.rangeLayer?.remove();
    this.rangeLayer = null;
  }

  // ---------- POI ----------

  setPois(pois, selected, enabled) {
    this.poiGroup.clearLayers();
    for (const poi of pois) {
      if (!enabled[poi.cat]) continue;
      const cat = POI_CATEGORIES.find((c) => c.id === poi.cat);
      const sel = !!selected[poi.id];
      const icon = L.divIcon({
        className: 'poi-icon',
        html: `<div class="poi${sel ? ' poi-selected' : ''}" style="--c:${cat.color}">${cat.icon}</div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      });
      L.marker([poi.lat, poi.lng], { icon, title: poi.name || cat.label, keyboard: false })
        .bindPopup(() => this.h.poiPopup(poi.id), { minWidth: 220, maxWidth: 300 })
        .addTo(this.poiGroup);
    }
  }

  openPoi(poi) {
    this.poiGroup.eachLayer((m) => {
      const ll = m.getLatLng();
      if (Math.abs(ll.lat - poi.lat) < 1e-9 && Math.abs(ll.lng - poi.lng) < 1e-9) {
        this.map.setView(ll, Math.max(this.map.getZoom(), 15));
        m.openPopup();
      }
    });
  }

  closePopup() {
    this.map.closePopup();
  }

  // ---------- Vue ----------

  fitRoute(route, waypoints) {
    const pts = route?.points?.length ? route.points : waypoints;
    if (!pts?.length) return;
    if (pts.length === 1) {
      this.map.setView([pts[0].lat, pts[0].lng], 14);
      return;
    }
    this.map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])), { padding: [30, 30] });
  }

  panToIndex(idx) {
    const p = this.route?.points[idx];
    if (p) this.map.panTo([p.lat, p.lng]);
  }

  flyTo(lat, lng, zoom = 14) {
    this.map.flyTo([lat, lng], zoom, { duration: 0.8 });
  }

  locate() {
    return new Promise((resolve, reject) => {
      this.map.once('locationfound', (e) => resolve(e.latlng));
      this.map.once('locationerror', (e) => reject(e));
      this.map.locate({ setView: true, maxZoom: 14 });
    });
  }
}
