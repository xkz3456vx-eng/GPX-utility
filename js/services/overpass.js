/**
 * Recherche de points d'intérêt OpenStreetMap via l'API Overpass, dans un
 * couloir autour du tracé (filtre `around` appliqué à une polyligne).
 *
 * Pour ménager les serveurs publics :
 * - requêtes par tronçon (déplacer un point ne relance que les tronçons concernés),
 * - tracé simplifié (≤ 150 sommets par requête) et découpé en morceaux,
 * - cache persistant 24 h (localStorage), file d'attente 1 requête à la fois,
 * - serveur de secours en cas d'erreur 429 / 5xx.
 */
import { SERVICES, POI_CATEGORIES } from '../config.js';
import { RequestQueue, fetchWithRetry, HttpError } from '../core/http.js';
import { Cache } from '../core/cache.js';
import { simplify, simplifyTo, chunkByDistance, encodePolyline, round } from '../core/geo.js';

const queue = new RequestQueue({ concurrency: SERVICES.overpass.concurrency, minInterval: SERVICES.overpass.minIntervalMs });
const cache = new Cache('overpass', { ttl: SERVICES.overpass.cacheTtlMs, max: 60, persist: true });

export function buildQuery(points, radius, categoryIds, timeout = SERVICES.overpass.timeoutS) {
  const around = `(around:${Math.round(radius)},${points.map((p) => `${round(p.lat, 5)},${round(p.lng, 5)}`).join(',')})`;
  const clauses = POI_CATEGORIES.filter((c) => categoryIds.includes(c.id))
    .flatMap((c) => c.filters.map((f) => `nwr${f}${around};`));
  return `[out:json][timeout:${timeout}];\n(\n${clauses.join('\n')}\n);\nout center tags qt;`;
}

export function categorize(tags) {
  const cat = POI_CATEGORIES.find((c) => c.match(tags));
  return cat ? cat.id : null;
}

/** Normalise un élément Overpass en POI. */
export function toPoi(el) {
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  const tags = el.tags || {};
  const cat = categorize(tags);
  if (!cat || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const kind = tags.amenity || tags.shop || tags.tourism || tags.man_made || tags.natural || tags.railway || '';
  return {
    id: `${el.type}/${el.id}`,
    lat,
    lng,
    cat,
    kind,
    name: tags.name || tags['name:fr'] || tags.brand || tags.operator || '',
    tags,
  };
}

async function runQuery(query, signal) {
  const urls = [...new Set([SERVICES.overpass.urlOverride, ...SERVICES.overpass.urls].filter(Boolean))];
  let lastErr;
  for (const url of urls) {
    try {
      const res = await queue.run(() => fetchWithRetry(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
      }, { timeoutMs: (SERVICES.overpass.timeoutS + 15) * 1000, retries: 1, signal }), signal);
      const json = await res.json();
      if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark) && !json.elements?.length) {
        throw new HttpError(json.remark, { status: 504, body: json.remark });
      }
      return json.elements || [];
    } catch (e) {
      if (e.kind === 'abort') throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

export function explainOverpassError(e) {
  if (e?.kind === 'network') return 'Serveur Overpass injoignable (hors ligne ?).';
  if (e?.kind === 'timeout' || e?.status === 504) return 'Le serveur Overpass a mis trop de temps à répondre ; réduisez le rayon ou réessayez plus tard.';
  if (e?.status === 429) return 'Trop de requêtes vers Overpass : patientez une minute avant de réessayer.';
  return `Erreur Overpass : ${e?.message || 'inconnue'}`;
}

/**
 * Récupère les POI le long d'une liste de tronçons.
 * @param {Array<Array<{lat,lng}>>} legs géométrie de chaque tronçon
 * @param {{radius:number, categories:string[], signal?:AbortSignal, onProgress?:(done,total)=>void}} opts
 * @returns {Promise<{pois: object[], errors: string[]}>}
 */
export async function fetchPoisAlong(legs, { radius, categories, signal, onProgress }) {
  if (!categories.length) return { pois: [], errors: [] };
  const cats = [...categories].sort();
  const chunks = [];
  for (const leg of legs) {
    if (leg.length < 2) continue;
    const simplified = simplify(leg, Math.max(25, radius / 5));
    for (const part of chunkByDistance(simplified, SERVICES.overpass.chunkKm * 1000)) {
      chunks.push(simplifyTo(part, 150, Math.max(25, radius / 5)));
    }
  }
  const seenKeys = new Set();
  const unique = chunks.filter((c) => {
    const k = encodePolyline(c);
    if (seenKeys.has(k)) return false;
    seenKeys.add(k);
    return true;
  });
  const byId = new Map();
  const errors = [];
  let done = 0;
  onProgress?.(0, unique.length);
  for (const chunk of unique) {
    const key = `${radius}|${cats.join(',')}|${encodePolyline(chunk)}`;
    let elements = cache.get(key);
    if (!elements) {
      try {
        elements = await runQuery(buildQuery(chunk, radius, cats), signal);
        // On ne garde que le strict nécessaire pour limiter la taille du cache.
        elements = elements.map((e) => ({ type: e.type, id: e.id, lat: e.lat, lon: e.lon, center: e.center, tags: e.tags }));
        cache.set(key, elements);
      } catch (e) {
        if (e.kind === 'abort') throw e;
        errors.push(explainOverpassError(e));
        elements = [];
      }
    }
    for (const el of elements) {
      const poi = toPoi(el);
      if (poi) byId.set(poi.id, poi);
    }
    onProgress?.(++done, unique.length);
  }
  return { pois: [...byId.values()], errors: [...new Set(errors)] };
}

export function clearPoiCache() {
  cache.clear();
}

export function poiCacheSize() {
  return cache.size();
}
