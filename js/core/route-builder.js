/**
 * Assemblage de l'itinéraire complet à partir des points de passage :
 * un tronçon par paire de points consécutifs (+ retour au départ en boucle),
 * calculé par BRouter, en ligne droite, ou figé (géométrie importée).
 * Chaque tronçon est mis en cache séparément : déplacer un point ne
 * recalcule que les deux tronçons adjacents.
 */
import { routeLeg, profileCandidates, profileParams, RoutingError } from '../services/brouter.js';
import { distance } from './geo.js';

const near = (a, b) => Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lng - b.lng) < 1e-7;

export function buildLegs(doc) {
  const wps = doc.waypoints;
  const legs = [];
  for (let i = 0; i < wps.length - 1; i++) legs.push({ index: i, from: wps[i], to: wps[i + 1] });
  if (doc.mode === 'loop' && wps.length >= 2) legs.push({ index: wps.length - 1, from: wps[wps.length - 1], to: wps[0], closing: true });
  for (const leg of legs) {
    leg.straight = !!leg.from.straight;
    const f = doc.fixedLegs?.[leg.from.id];
    if (f && f.to === leg.to.id && f.coords?.length >= 2 && near(f.coords[0], leg.from) && near(f.coords[f.coords.length - 1], leg.to)) {
      leg.fixed = f.coords;
    }
  }
  return legs;
}

/** Ligne droite densifiée (un point tous les ~200 m) pour le profil et les POI. */
function straightLine(a, b) {
  const d = distance(a, b);
  const n = Math.max(1, Math.ceil(d / 200));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t, ele: null });
  }
  return pts;
}

/**
 * Calcule tous les tronçons puis les concatène.
 * @returns {Promise<{points, tagList, legs, profile}>}
 */
export async function computeRoute(doc, { baseUrl, signal } = {}) {
  const legs = buildLegs(doc);
  const candidates = profileCandidates(doc);
  const params = profileParams(doc);
  const results = await Promise.all(legs.map(async (leg) => {
    if (leg.fixed) return { kind: 'fixed', coords: leg.fixed.map((p) => ({ lat: p.lat, lng: p.lng, ele: p.ele ?? null })), tags: null, tagList: [] };
    if (leg.straight) return { kind: 'straight', coords: straightLine(leg.from, leg.to), tags: null, tagList: [] };
    try {
      const r = await routeLeg(leg.from, leg.to, { baseUrl, candidates, params, signal });
      return { kind: 'route', ...r };
    } catch (e) {
      if (e instanceof RoutingError && e.code === 'abort') throw e;
      return { kind: 'error', error: e, coords: straightLine(leg.from, leg.to), tags: null, tagList: [] };
    }
  }));
  if (signal?.aborted) throw new RoutingError('Annulé', { code: 'abort' });

  const points = [];
  const tagList = [];
  const tagMap = new Map();
  const outLegs = [];
  let profileUsed = null;
  results.forEach((r, li) => {
    if (r.profile) profileUsed = r.profile;
    const remap = r.tagList.map((s) => {
      if (!tagMap.has(s)) {
        tagMap.set(s, tagList.length);
        tagList.push(s);
      }
      return tagMap.get(s);
    });
    const startIdx = points.length ? points.length - 1 : 0;
    r.coords.forEach((c, i) => {
      if (i === 0 && points.length) return; // point de jonction partagé
      const t = r.tags ? r.tags[i] : -1;
      points.push({ lat: c.lat, lng: c.lng, ele: c.ele, tag: t >= 0 ? remap[t] : -1, leg: li });
    });
    outLegs.push({
      index: legs[li].index,
      fromId: legs[li].from.id,
      toId: legs[li].to.id,
      kind: r.kind,
      error: r.error ? r.error.message : null,
      errorCode: r.error ? r.error.code : null,
      startIdx,
      endIdx: points.length - 1,
    });
  });

  // Aller-retour : on repasse par le même chemin en sens inverse.
  if (doc.mode === 'outback' && points.length > 1) {
    const n = points.length - 1;
    for (let j = 1; j <= n; j++) {
      const src = points[n - j];
      points.push({ ...src, tag: points[n - j + 1].tag, ret: true });
    }
  }
  return { points, tagList, legs: outLegs, profile: profileUsed };
}
