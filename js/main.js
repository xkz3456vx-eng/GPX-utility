/**
 * Point d'entrée : relie l'état (store), les services (BRouter, Overpass,
 * Nominatim), l'analyse du tracé et l'interface (carte, profil, onglets).
 */
import { PROFILES, SERVICES, SURFACES, DIFFICULTIES, WAY_TYPES, POI_CATEGORIES } from './config.js';
import { store, uid, newDoc } from './core/store.js';
import { settings } from './core/settings.js';
import { PolylineIndex, cumulativeDistances, distance } from './core/geo.js';
import { computeRoute } from './core/route-builder.js';
import { clearRoutingCache } from './services/brouter.js';
import { fetchPoisAlong, clearPoiCache } from './services/overpass.js';
import { searchPlace } from './services/nominatim.js';
import { analyzeRoute, rangeStats } from './analysis/route-analysis.js';
import { computeAlerts } from './analysis/alerts.js';
import { exportGpx, parseGpx, safeFilename } from './io/gpx.js';
import * as storage from './io/storage.js';
import { MapView, GRADE_LEGEND } from './ui/map.js';
import { ElevationChart } from './ui/elevation-chart.js';
import { renderRoutePanel } from './ui/route-panel.js';
import { renderPoiPanel, poiCard } from './ui/poi-panel.js';
import { renderProjectsPanel, renderSettingsPanel } from './ui/projects-panel.js';
import { $, $$, h, toast, debounce, download, fmtKm, fmtM } from './ui/dom.js';

const app = { store, settings, ui: { poiFilter: 'all', tab: 'route' } };
window.gpxPlanner = app; // pratique pour le débogage depuis la console

SERVICES.overpass.urlOverride = settings.get('overpassUrl');

// ---------------------------------------------------------------------------
// Carte et profil altimétrique
// ---------------------------------------------------------------------------

app.map = new MapView($('#map'), {
  onMapClick: (ll) => actions.addWaypoint(ll.lat, ll.lng),
  onWaypointMove: (id, ll) => actions.moveWaypoint(id, ll.lat, ll.lng),
  onWaypointDelete: (id) => actions.deleteWaypoint(id),
  waypointPopup: (id) => waypointPopup(id),
  onRouteInsert: (legIdx, ll) => actions.insertWaypoint(legIdx + 1, ll.lat, ll.lng),
  onHover: (idx) => {
    app.map.showCursor(idx);
    app.chart.setCursor(idx);
  },
  poiPopup: (id) => {
    const poi = store.runtime.pois.find((p) => p.id === id) || store.doc.selectedPois[id];
    return poi ? poiCard(poi, app) : h('div', {}, 'POI introuvable');
  },
});

app.chart = new ElevationChart($('#chart'), {
  onHover: (idx) => app.map.showCursor(idx),
  onClick: (idx) => app.map.panToIndex(idx),
  onRange: (a, b) => {
    store.runtime.range = a == null ? null : [a, b];
    app.map.highlightRange(a, b);
    renderRangeInfo();
  },
});

function waypointPopup(id) {
  const i = store.doc.waypoints.findIndex((w) => w.id === id);
  const w = store.doc.waypoints[i];
  if (!w) return h('div');
  const isLast = i === store.doc.waypoints.length - 1 && store.doc.mode !== 'loop';
  return h('div', { class: 'wp-popup' },
    h('input', {
      type: 'text', value: w.name || '', placeholder: `Point ${i + 1}`, 'aria-label': 'Nom du point',
      onchange: (e) => actions.renameWaypoint(id, e.target.value),
    }),
    h('small', { class: 'muted' }, `${w.lat.toFixed(5)}, ${w.lng.toFixed(5)}`),
    isLast ? null : h('label', { class: 'row' },
      h('input', { type: 'checkbox', checked: !!w.straight, onchange: (e) => actions.setStraight(id, e.target.checked) }),
      ' Ligne droite jusqu’au point suivant'),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn sm danger', onclick: () => { app.map.closePopup(); actions.deleteWaypoint(id); } }, '✕ Supprimer')));
}

// ---------------------------------------------------------------------------
// Actions (toutes les modifications du document passent par ici)
// ---------------------------------------------------------------------------

/** Supprime les géométries figées qui touchent un point modifié. */
function dropFixed(d, id) {
  delete d.fixedLegs[id];
  for (const [k, f] of Object.entries(d.fixedLegs)) if (f.to === id) delete d.fixedLegs[k];
}

const actions = {
  addWaypoint(lat, lng, extra = {}) {
    store.update((d) => {
      d.waypoints.push({ id: uid(), lat, lng, name: '', straight: false, poi: null, ...extra });
    });
  },
  insertWaypoint(index, lat, lng, extra = {}) {
    store.update((d) => {
      const prev = d.waypoints[index - 1];
      if (prev) delete d.fixedLegs[prev.id];
      d.waypoints.splice(index, 0, { id: uid(), lat, lng, name: '', straight: false, poi: null, ...extra });
    });
  },
  moveWaypoint(id, lat, lng) {
    store.update((d) => {
      const w = d.waypoints.find((x) => x.id === id);
      if (!w) return;
      w.lat = lat;
      w.lng = lng;
      w.poi = null;
      dropFixed(d, id);
    });
  },
  deleteWaypoint(id) {
    store.update((d) => {
      d.waypoints = d.waypoints.filter((w) => w.id !== id);
      dropFixed(d, id);
    });
  },
  deleteLast() {
    const last = store.doc.waypoints.at(-1);
    if (last) actions.deleteWaypoint(last.id);
  },
  renameWaypoint(id, name) {
    store.update((d) => {
      const w = d.waypoints.find((x) => x.id === id);
      if (w) w.name = name.trim();
    });
  },
  setStraight(id, on) {
    store.update((d) => {
      const w = d.waypoints.find((x) => x.id === id);
      if (w) w.straight = on;
      delete d.fixedLegs[id];
    });
  },
  reorder(from, to) {
    if (to < 0 || to >= store.doc.waypoints.length) return;
    store.update((d) => {
      const [w] = d.waypoints.splice(from, 1);
      d.waypoints.splice(to, 0, w);
      d.fixedLegs = {}; // l'ordre change : les géométries importées ne sont plus valides
    });
  },
  reverse() {
    store.update((d) => {
      d.waypoints.reverse();
      // Les tronçons figés sont inversés aussi.
      const fixed = {};
      for (const [fromId, f] of Object.entries(d.fixedLegs)) fixed[f.to] = { to: fromId, coords: [...f.coords].reverse() };
      d.fixedLegs = fixed;
    });
  },
  clear() {
    if (store.doc.waypoints.length && !confirm('Effacer tous les points de passage ?')) return;
    store.update((d) => {
      d.waypoints = [];
      d.fixedLegs = {};
    });
  },
  setProfile(id) {
    store.update((d) => {
      d.profile = id;
      d.customProfile = '';
    });
  },
  setCustomProfile(name) {
    store.update((d) => { d.customProfile = name; });
  },
  setPref(key, v) {
    store.update((d) => { d.prefs[key] = v; });
  },
  setMode(mode) {
    store.update((d) => { d.mode = mode; });
  },
  setName(name) {
    store.update((d) => { d.name = name.trim() || 'Itinéraire sans nom'; });
  },
  focusDistance(m) {
    const r = store.runtime.route;
    if (!r) return;
    const idx = app.chart.indexAt(m);
    app.map.panToIndex(idx);
    app.map.showCursor(idx);
    app.chart.setCursor(idx);
  },

  // --- POI ---
  setPoiRadius(v) {
    store.update((d) => { d.poi.radius = v; }, { record: false });
    if (store.doc.poi.auto) schedulePois();
  },
  setPoiCategory(id, on) {
    store.update((d) => { d.poi.categories[id] = on; }, { record: false });
    if (on && store.doc.poi.auto) schedulePois();
    else updateAlerts();
  },
  setPoiAuto(on) {
    store.update((d) => { d.poi.auto = on; }, { record: false });
    if (on) schedulePois();
  },
  refreshPois: (force) => refreshPois(force),
  addPoiAsWaypoint(poi) {
    const r = store.runtime.route;
    const extra = { name: poi.name || '', poi: { id: poi.id, cat: poi.cat } };
    const wps = store.doc.waypoints;
    app.map.closePopup();
    if (!r || wps.length < 2 || poi.leg == null) {
      actions.addWaypoint(poi.lat, poi.lng, extra);
    } else {
      // Insère l'étape dans le tronçon le plus proche pour ne pas désorganiser le parcours.
      const legIndex = r.legs[poi.leg]?.index ?? wps.length - 1;
      actions.insertWaypoint(legIndex + 1, poi.lat, poi.lng, extra);
    }
    toast(`« ${poi.name || 'POI'} » ajouté comme étape.`, 'success');
  },
  togglePoiSelected(poi) {
    store.update((d) => {
      if (d.selectedPois[poi.id]) delete d.selectedPois[poi.id];
      else {
        const { id, lat, lng, cat, kind, name, tags } = poi;
        d.selectedPois[id] = { id, lat, lng, cat, kind, name, tags };
      }
    });
  },

  // --- Projets ---
  saveProject(copy) {
    try {
      const r = store.runtime.route;
      const doc = copy ? { ...store.doc, name: `${store.doc.name} (copie)` } : store.doc;
      const id = storage.saveProject(doc, copy ? null : store.runtime.projectId, {
        profile: doc.profile, distance: r?.totals.distance || 0, ascent: r?.totals.ascent || 0,
      });
      if (copy) store.update((d) => { d.name = doc.name; }, { record: false });
      store.setRuntime({ projectId: id });
      toast('Projet enregistré dans ce navigateur.', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  },
  openProject(id) {
    const doc = storage.loadProject(id);
    if (!doc) return toast('Projet introuvable.', 'error');
    store.replace(doc);
    store.setRuntime({ projectId: id });
    fitAfterRoute = true;
  },
  newProject() {
    if (store.doc.waypoints.length && !confirm('Commencer un nouvel itinéraire ? Les modifications non enregistrées restent récupérables avec « Annuler ».')) return;
    store.replace(newDoc());
    store.setRuntime({ projectId: null, pois: [] });
  },
  renameProject(id, current) {
    const name = prompt('Nouveau nom du projet :', current);
    if (!name?.trim()) return;
    storage.renameProject(id, name.trim());
    if (id === store.runtime.projectId) store.update((d) => { d.name = name.trim(); }, { record: false });
    render();
  },
  deleteProject(id, name) {
    if (!confirm(`Supprimer définitivement le projet « ${name} » ?`)) return;
    storage.deleteProject(id);
    if (id === store.runtime.projectId) store.setRuntime({ projectId: null });
    render();
  },

  // --- Réglages ---
  setSetting(key, value) {
    settings.set({ [key]: value });
    if (key === 'overpassUrl') SERVICES.overpass.urlOverride = value;
    if (key === 'thunderforestKey') app.map.refreshLayers();
    if (['brouterUrl', 'speed', 'waterGapKm'].includes(key)) scheduleRoute(0);
    toast('Réglage enregistré.', 'success', 1500);
  },
  clearCaches() {
    clearRoutingCache();
    clearPoiCache();
    toast('Caches vidés.', 'success');
    render();
  },
  resetSettings() {
    if (!confirm('Rétablir tous les réglages par défaut ?')) return;
    settings.reset();
    SERVICES.overpass.urlOverride = settings.get('overpassUrl');
    app.map.refreshLayers();
    scheduleRoute(0);
    render();
  },
};
app.actions = actions;

// ---------------------------------------------------------------------------
// Calcul de l'itinéraire
// ---------------------------------------------------------------------------

let routeCtrl = null;
let routeSeq = 0;
let fitAfterRoute = false;
let lastErrorsKey = '';

const scheduleRoute = debounce(() => recompute(), 200);

async function recompute() {
  const doc = store.doc;
  routeCtrl?.abort();
  if (doc.waypoints.length < 2) {
    store.setRuntime({ route: null, routing: false, routeInfo: null });
    afterRoute();
    return;
  }
  routeCtrl = new AbortController();
  const seq = ++routeSeq;
  store.setRuntime({ routing: true });
  renderStatus();
  try {
    const res = await computeRoute(doc, { baseUrl: settings.get('brouterUrl') || SERVICES.brouter.url, signal: routeCtrl.signal });
    if (seq !== routeSeq) return;
    const profile = PROFILES[doc.profile] || PROFILES.trekking;
    const an = analyzeRoute(res.points, res.tagList, profile, { speed: settings.get('speed') });
    an.legs = res.legs;
    store.setRuntime({ route: an, routing: false, routeInfo: { profile: res.profile } });
    const errs = res.legs.filter((l) => l.kind === 'error');
    const key = errs.map((l) => `${l.fromId}:${l.errorCode}`).join('|');
    if (errs.length && key !== lastErrorsKey) toast(errs[0].error, 'error', 7000);
    lastErrorsKey = key;
    afterRoute();
  } catch (e) {
    if (e.code === 'abort' || seq !== routeSeq) return;
    store.setRuntime({ routing: false });
    toast(`Calcul impossible : ${e.message}`, 'error');
    render();
  }
}

function afterRoute() {
  const r = store.runtime.route;
  app.map.setRoute(r, colorMode());
  store.runtime.range = null;
  renderRangeInfo();
  positionPois();
  app.chart.setData(r, colorMode(), visiblePois());
  if (fitAfterRoute && r) {
    app.map.fitRoute(r, store.doc.waypoints);
    fitAfterRoute = false;
  }
  if (r && store.doc.poi.auto) schedulePois();
  else if (store.runtime.poiLoaded) store.runtime.poiStale = true;
  updateAlerts();
}

// ---------------------------------------------------------------------------
// Points d'intérêt
// ---------------------------------------------------------------------------

let poiCtrl = null;
let rawPois = [];
const schedulePois = debounce(() => refreshPois(false), 1500);

/** Géométrie aller (sans le retour d'un aller-retour), découpée par tronçon. */
function legGeometries(r) {
  return (r.legs || []).map((l) => r.points.slice(l.startIdx, l.endIdx + 1));
}

async function refreshPois(force) {
  const r = store.runtime.route;
  if (!r) return;
  const cats = Object.keys(store.doc.poi.categories).filter((k) => store.doc.poi.categories[k]);
  poiCtrl?.abort();
  poiCtrl = new AbortController();
  const ctrl = poiCtrl;
  store.setRuntime({ poiLoading: true, poiError: null, poiProgress: { done: 0, total: 0 } });
  render();
  try {
    const { pois, errors } = await fetchPoisAlong(legGeometries(r), {
      radius: store.doc.poi.radius,
      categories: cats,
      signal: ctrl.signal,
      onProgress: (done, total) => {
        store.runtime.poiProgress = { done, total };
        const p = $('#tab-pois progress');
        if (p) { p.max = total || 1; p.value = done; }
      },
    });
    if (ctrl !== poiCtrl) return;
    rawPois = pois;
    store.setRuntime({ poiLoading: false, poiLoaded: true, poiStale: false, poiError: errors.length ? errors.join(' ') : null });
    if (errors.length && force) toast(errors[0], 'error', 7000);
    positionPois();
    app.chart.setData(store.runtime.route, colorMode(), visiblePois());
    updateAlerts();
  } catch (e) {
    if (e.kind === 'abort') return;
    store.setRuntime({ poiLoading: false, poiError: e.message });
    render();
  }
}

/** Calcule distance au tracé et position (km) de chaque POI, filtre hors couloir. */
function positionPois() {
  const r = store.runtime.route;
  if (!r || !rawPois.length) {
    store.runtime.pois = [];
    app.map.setPois([], {}, {});
    return;
  }
  const outEnd = r.legs?.length ? r.legs[r.legs.length - 1].endIdx : r.points.length - 1;
  const oneWay = r.points.slice(0, outEnd + 1);
  const index = new PolylineIndex(oneWay, r.cum.slice(0, outEnd + 1));
  const oneWayLen = r.cum[outEnd];
  const radius = store.doc.poi.radius * 1.15;
  const out = [];
  for (const p of rawPois) {
    const n = index.nearest(p.lat, p.lng, radius);
    if (!n) continue;
    const item = { ...p, dist: n.dist, along: n.along, leg: oneWay[n.vertex].leg };
    if (store.doc.mode === 'outback') item.alongReturn = 2 * oneWayLen - n.along;
    out.push(item);
  }
  out.sort((a, b) => a.along - b.along);
  store.runtime.pois = out;
  app.map.setPois(out, store.doc.selectedPois, store.doc.poi.categories);
}

const visiblePois = () => store.runtime.pois.filter((p) => store.doc.poi.categories[p.cat]);

function updateAlerts() {
  const r = store.runtime.route;
  const profile = PROFILES[store.doc.profile] || PROFILES.trekking;
  const alerts = computeAlerts({
    route: r,
    pois: visiblePois(),
    doc: store.doc,
    profile,
    waterGapKm: settings.get('waterGapKm') || profile.waterGapKm,
    poisLoaded: !!store.runtime.poiLoaded && !store.runtime.poiLoading,
  });
  store.runtime.alerts = alerts;
  render();
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

const colorMode = () => settings.get('colorMode') || 'surface';

function renderLegend() {
  const mode = colorMode();
  const items = mode === 'surface' ? SURFACES : mode === 'difficulty' ? DIFFICULTIES : mode === 'way' ? WAY_TYPES : mode === 'grade' ? GRADE_LEGEND : [];
  $('#legend-items').replaceChildren(...items.map((i) => h('span', { class: 'lg' }, h('i', { style: { background: i.color } }), i.label)));
}

function renderStatus() {
  const el = $('#map-status');
  const rt = store.runtime;
  const msgs = [];
  if (rt.routing) msgs.push('Calcul de l’itinéraire…');
  if (rt.poiLoading) msgs.push('Recherche des points d’intérêt…');
  el.hidden = !msgs.length;
  el.replaceChildren(...msgs.map((m) => h('div', {}, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' ', m)));
}

function renderRangeInfo() {
  const r = store.runtime.route;
  const rg = store.runtime.range;
  const el = $('#range-info');
  if (!r || !rg) {
    el.textContent = r ? 'Glissez sur le profil pour analyser une portion' : '';
    return;
  }
  const s = rangeStats(r, rg[0], rg[1]);
  el.replaceChildren(
    `Portion km ${fmtKm(r.cum[rg[0]]).replace(' km', '')} → ${fmtKm(r.cum[rg[1]]).replace(' km', '')} : ${fmtKm(s.distance)}, D+ ${fmtM(s.ascent)}, D− ${fmtM(s.descent)}, pente max ${Math.round(s.maxGrade)} % `,
    h('button', { class: 'btn link', onclick: () => { app.chart.setRange(null); app.chart.h.onRange(null, null); } }, 'effacer'),
  );
}

function render() {
  renderStatus();
  renderRoutePanel($('#tab-route'), app);
  renderPoiPanel($('#tab-pois'), app);
  renderProjectsPanel($('#tab-projects'), app);
  renderSettingsPanel($('#tab-settings'), app);
  const n = store.runtime.pois.filter((p) => store.doc.poi.categories[p.cat]).length;
  $('#poi-count').textContent = n ? String(n) : '';
  const name = $('#doc-name');
  if (document.activeElement !== name) name.value = store.doc.name;
  $('#btn-undo').disabled = !store.undoStack.length;
  $('#btn-redo').disabled = !store.redoStack.length;
}
app.render = render;

const autosave = debounce(() => storage.saveCurrent(store.doc, store.runtime.projectId), 500);

store.on('doc', ({ reason }) => {
  app.map.setWaypoints(store.doc.waypoints, store.doc.mode);
  app.map.setPois(store.runtime.pois, store.doc.selectedPois, store.doc.poi.categories);
  if (reason === 'import' || reason === 'replace') fitAfterRoute = true;
  scheduleRoute();
  autosave();
  render();
});

// ---------------------------------------------------------------------------
// Import / export / partage
// ---------------------------------------------------------------------------

/** Points répartis le long d'une trace (pour recalculer via BRouter). */
function sampleTrack(pts, maxPoints = 30, minSpacing = 2000) {
  const cum = cumulativeDistances(pts);
  const total = cum[cum.length - 1];
  const step = Math.max(minSpacing, total / (maxPoints - 1));
  const out = [pts[0]];
  let next = step;
  for (let i = 1; i < pts.length - 1; i++) {
    if (cum[i] >= next) {
      out.push(pts[i]);
      next = cum[i] + step;
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Découpe une trace en tronçons figés (~1/20 de la longueur, min 3 km) avec un point à chaque jonction. */
function trackToFixedLegs(pts) {
  const cum = cumulativeDistances(pts);
  const total = cum[cum.length - 1];
  const step = Math.max(3000, total / 20);
  const cuts = [0];
  let next = step;
  for (let i = 1; i < pts.length - 1; i++) {
    if (cum[i] >= next && total - cum[i] > step / 3) {
      cuts.push(i);
      next = cum[i] + step;
    }
  }
  cuts.push(pts.length - 1);
  const waypoints = cuts.map((i) => ({ id: uid(), lat: pts[i].lat, lng: pts[i].lng, name: '', straight: false, poi: null }));
  const fixedLegs = {};
  for (let k = 0; k < cuts.length - 1; k++) {
    fixedLegs[waypoints[k].id] = { to: waypoints[k + 1].id, coords: pts.slice(cuts[k], cuts[k + 1] + 1).map((p) => ({ lat: p.lat, lng: p.lng, ele: p.ele })) };
  }
  return { waypoints, fixedLegs };
}

async function importFile(file) {
  let gpx;
  try {
    gpx = parseGpx(await file.text());
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  const dlg = $('#import-dialog');
  const track = gpx.tracks.flat();
  const trackLen = track.length > 1 ? cumulativeDistances(track).at(-1) : 0;
  $('#import-summary').textContent = `« ${gpx.name || file.name} » : ${gpx.tracks.length} trace(s), ${track.length} points (${fmtKm(trackLen)}), ${gpx.waypoints.length} point(s) nommé(s).`;
  const radios = $$('input[name="import-mode"]', dlg);
  radios.find((r) => r.value === 'fixed').disabled = track.length < 2;
  radios.find((r) => r.value === 'reroute').disabled = track.length < 2;
  radios.find((r) => r.value === 'waypoints').disabled = !gpx.waypoints.length;
  const firstEnabled = radios.find((r) => !r.disabled);
  if (firstEnabled && radios.find((r) => r.checked)?.disabled) firstEnabled.checked = true;
  dlg.returnValue = '';
  dlg.showModal();
  await new Promise((res) => dlg.addEventListener('close', res, { once: true }));
  if (dlg.returnValue !== 'ok') return;
  const mode = radios.find((r) => r.checked)?.value;
  const replace = $('#import-replace').checked;

  let waypoints = [];
  let fixedLegs = {};
  if (mode === 'fixed') ({ waypoints, fixedLegs } = trackToFixedLegs(track));
  else if (mode === 'reroute') waypoints = sampleTrack(track).map((p) => ({ id: uid(), lat: p.lat, lng: p.lng, name: '' }));
  else waypoints = gpx.waypoints.map((p) => ({ id: uid(), lat: p.lat, lng: p.lng, name: p.name }));

  store.update((d) => {
    if (replace) {
      d.waypoints = waypoints;
      d.fixedLegs = fixedLegs;
      d.name = gpx.name || file.name.replace(/\.gpx$/i, '');
    } else {
      d.waypoints.push(...waypoints);
      Object.assign(d.fixedLegs, fixedLegs);
    }
  }, { reason: 'import' });
  fitAfterRoute = true;
  toast(mode === 'reroute' ? `Trace importée : recalcul via ${waypoints.length} points de passage.` : 'Import terminé.', 'success');
}

function exportFile() {
  const r = store.runtime.route;
  if (!r) return toast('Aucun itinéraire à exporter : placez au moins deux points.', 'warning');
  const dlg = $('#export-dialog');
  const selected = Object.values(store.doc.selectedPois);
  $('#export-poi-count').textContent = String(selected.length);
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return;
    let pois = $('#export-pois').checked ? selected : [];
    if ($('#export-all-pois').checked) {
      const ids = new Set(pois.map((p) => p.id));
      pois = [...pois, ...visiblePois().filter((p) => !ids.has(p.id))];
    }
    // Complète km / distance pour les POI sélectionnés à partir des positions calculées.
    const byId = new Map(store.runtime.pois.map((p) => [p.id, p]));
    pois = pois.map((p) => byId.get(p.id) || p);
    const track = r.points.map((p, i) => ({ lat: p.lat, lng: p.lng, ele: r.totals.hasElevation ? r.ele[i] : null }));
    const xml = exportGpx({
      name: store.doc.name,
      track,
      waypoints: store.doc.waypoints,
      pois,
      includeWaypoints: $('#export-wpts').checked,
    });
    download(`${safeFilename(store.doc.name)}.gpx`, xml);
    toast('Fichier GPX téléchargé.', 'success');
  }, { once: true });
}

async function share() {
  if (!store.doc.waypoints.length) return toast('Rien à partager pour l’instant.', 'warning');
  const url = await storage.buildShareUrl(store.doc);
  if (url.length > 8000) toast('Lien très long (trace importée détaillée) : certains services pourraient le tronquer.', 'warning', 7000);
  try {
    await navigator.clipboard.writeText(url);
    toast('Lien de partage copié dans le presse-papiers.', 'success');
  } catch {
    prompt('Copiez ce lien de partage :', url);
  }
}

// ---------------------------------------------------------------------------
// Recherche de lieu
// ---------------------------------------------------------------------------

async function runSearch(e) {
  e.preventDefault();
  const q = $('#search-input').value;
  const list = $('#search-results');
  if (!q.trim()) return;
  list.hidden = false;
  list.replaceChildren(h('li', { class: 'muted' }, 'Recherche…'));
  try {
    const results = await searchPlace(q);
    list.replaceChildren(...(results.length ? results.map((r) => h('li', {},
      h('button', { class: 'result', onclick: () => { app.map.flyTo(r.lat, r.lng); list.hidden = true; } }, r.name),
      h('button', {
        class: 'btn icon sm', title: 'Ajouter comme point de passage', 'aria-label': 'Ajouter comme point de passage',
        onclick: () => { actions.addWaypoint(r.lat, r.lng, { name: r.name.split(',')[0] }); app.map.flyTo(r.lat, r.lng); list.hidden = true; },
      }, '➕'))) : [h('li', { class: 'muted' }, 'Aucun résultat.')]));
  } catch (err) {
    list.replaceChildren(h('li', { class: 'error' }, `Recherche indisponible (${err.message}).`));
  }
}

// ---------------------------------------------------------------------------
// Événements de l'interface
// ---------------------------------------------------------------------------

function bindUi() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    $$('.tab').forEach((x) => { x.classList.toggle('active', x === t); x.setAttribute('aria-selected', String(x === t)); });
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${t.dataset.tab}`));
    app.ui.tab = t.dataset.tab;
  }));
  $('#btn-undo').addEventListener('click', () => store.undo());
  $('#btn-redo').addEventListener('click', () => store.redo());
  $('#btn-import').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importFile(f);
  });
  $('#btn-export').addEventListener('click', exportFile);
  $('#btn-share').addEventListener('click', share);
  $('#btn-fit').addEventListener('click', () => app.map.fitRoute(store.runtime.route, store.doc.waypoints));
  $('#btn-locate').addEventListener('click', () => app.map.locate().catch(() => toast('Localisation indisponible.', 'warning')));
  $('#doc-name').addEventListener('change', (e) => actions.setName(e.target.value));
  $('#search-form').addEventListener('submit', runSearch);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#search-form')) $('#search-results').hidden = true;
  });
  const cm = $('#color-mode');
  cm.value = colorMode();
  cm.addEventListener('change', () => {
    settings.set({ colorMode: cm.value });
    renderLegend();
    app.map.setRoute(store.runtime.route, colorMode());
    app.chart.setData(store.runtime.route, colorMode(), visiblePois());
  });
  const elev = $('#elevation');
  const toggle = $('#btn-elevation');
  const setOpen = (open) => {
    elev.classList.toggle('collapsed', !open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = `Profil altimétrique ${open ? '▾' : '▸'}`;
    settings.set({ elevationOpen: open });
    setTimeout(() => { app.map.invalidate(); app.chart.draw(); }, 50);
  };
  setOpen(settings.get('elevationOpen') !== false);
  toggle.addEventListener('click', () => setOpen(elev.classList.contains('collapsed')));
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if ((e.ctrlKey || e.metaKey) && !typing && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) store.redo(); else store.undo();
    } else if ((e.ctrlKey || e.metaKey) && !typing && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      store.redo();
    } else if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey) {
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      actions.deleteLast();
    }
  });
  window.addEventListener('hashchange', loadFromHash);
}

async function loadFromHash() {
  const m = window.location.hash.match(/^#r=(.+)$/);
  if (!m) return false;
  try {
    const doc = await storage.decodeShare(m[1]);
    store.replace(doc, { reason: 'import' });
    store.setRuntime({ projectId: null });
    fitAfterRoute = true;
    toast('Itinéraire partagé chargé. Enregistrez-le dans « Projets » pour le conserver.', 'success', 6000);
  } catch (e) {
    toast(`Lien de partage invalide : ${e.message}`, 'error');
  }
  history.replaceState(null, '', window.location.pathname + window.location.search);
  return true;
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

async function start() {
  bindUi();
  renderLegend();
  if (!(await loadFromHash())) {
    const cur = storage.loadCurrent();
    if (cur) {
      store.replace(cur.doc, { record: false, reason: 'restore' });
      store.setRuntime({ projectId: cur.projectId });
      fitAfterRoute = true;
    }
  }
  app.map.setWaypoints(store.doc.waypoints, store.doc.mode);
  if (store.doc.waypoints.length === 1) app.map.fitRoute(null, store.doc.waypoints);
  render();
  app.chart.setData(null);
  scheduleRoute();
  // Premier lancement : légère aide.
  if (!store.doc.waypoints.length) toast('Cliquez sur la carte pour placer le point de départ.', 'info', 6000);
}

// Pour les tests et la console : accès aux fonctions internes.
app.internals = { recompute, refreshPois, importFile, trackToFixedLegs, sampleTrack, distance };

start();
