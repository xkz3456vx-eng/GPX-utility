/**
 * État central de l'application.
 *
 * - `doc` : le « document » éditable et sérialisable (points de passage, profil,
 *   préférences, POI retenus…). Chaque modification est historisée pour
 *   annuler / rétablir, et sauvegardée automatiquement.
 * - `runtime` : données dérivées ou éphémères (tracé calculé, POI trouvés,
 *   états de chargement) – jamais sauvegardées.
 */
import { DEFAULT_PROFILE, PREFERENCES, POI_CATEGORIES, DEFAULTS } from '../config.js';

let seq = 0;
export const uid = (p = 'w') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function newDoc() {
  return {
    name: 'Nouvel itinéraire',
    waypoints: [],
    mode: 'oneway', // 'oneway' | 'loop' | 'outback'
    profile: DEFAULT_PROFILE,
    customProfile: '',
    prefs: Object.fromEntries(Object.entries(PREFERENCES).map(([k, p]) => [k, p.default])),
    /** Géométries figées (import GPX), indexées par id du point de départ du tronçon. */
    fixedLegs: {},
    /** POI retenus pour l'export, indexés par identifiant OSM. */
    selectedPois: {},
    poi: {
      radius: DEFAULTS.poiRadius,
      categories: Object.fromEntries(POI_CATEGORIES.map((c) => [c.id, c.default])),
      auto: DEFAULTS.poiAuto,
    },
  };
}

/** Complète un document chargé (ancien format, lien partagé…) avec les valeurs par défaut. */
export function normalizeDoc(d) {
  const base = newDoc();
  const doc = { ...base, ...d };
  doc.prefs = { ...base.prefs, ...(d.prefs || {}) };
  doc.poi = { ...base.poi, ...(d.poi || {}), categories: { ...base.poi.categories, ...(d.poi?.categories || {}) } };
  doc.waypoints = (d.waypoints || []).filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lng))
    .map((w) => ({ id: w.id || uid(), lat: w.lat, lng: w.lng, name: w.name || '', straight: !!w.straight, poi: w.poi || null }));
  doc.fixedLegs = d.fixedLegs || {};
  doc.selectedPois = d.selectedPois || {};
  return doc;
}

class Store {
  constructor() {
    this.doc = newDoc();
    this.runtime = {
      route: null, // analyse du tracé (cf. analysis/route-analysis.js)
      routing: false,
      pois: [],
      poiLoading: false,
      poiError: null,
      poiStale: false,
      hoverIndex: null,
      range: null,
      projectId: null,
    };
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Map();
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event).delete(fn);
  }

  emit(event, payload) {
    for (const fn of this.listeners.get(event) || []) fn(payload);
  }

  /**
   * Modifie le document via une fonction qui reçoit une copie profonde.
   * @param {(doc) => void} mutator
   * @param {{record?: boolean, reason?: string}} opts
   */
  update(mutator, { record = true, reason = '' } = {}) {
    const before = JSON.stringify(this.doc);
    const draft = JSON.parse(before);
    mutator(draft);
    const after = JSON.stringify(draft);
    if (after === before) return;
    if (record) {
      this.undoStack.push(before);
      if (this.undoStack.length > DEFAULTS.historyLimit) this.undoStack.shift();
      this.redoStack = [];
    }
    this.doc = draft;
    this.emit('doc', { reason });
  }

  /** Remplace tout le document (chargement de projet, import, lien partagé). */
  replace(doc, { record = true, reason = 'replace' } = {}) {
    if (record) this.undoStack.push(JSON.stringify(this.doc));
    this.redoStack = record ? [] : this.redoStack;
    this.doc = normalizeDoc(JSON.parse(JSON.stringify(doc)));
    this.emit('doc', { reason });
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(this.undoStack.pop());
    this.emit('doc', { reason: 'undo' });
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(this.redoStack.pop());
    this.emit('doc', { reason: 'redo' });
    return true;
  }

  setRuntime(patch) {
    Object.assign(this.runtime, patch);
    this.emit('runtime', patch);
  }
}

export const store = new Store();
