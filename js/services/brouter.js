/**
 * Client de l'API BRouter (https://github.com/abrensch/brouter).
 *
 * Requête : GET <url>?lonlats=lon,lat|lon,lat&profile=<p>&alternativeidx=0&format=geojson
 *           [&profile:<param>=<valeur>]  (surcharge des variables du profil)
 * Réponse : FeatureCollection GeoJSON ; `properties.messages` contient un
 * tableau (en-tête + lignes) décrivant les tags OSM de chaque portion de voie.
 */
import { SERVICES, PROFILES, PREFERENCES } from '../config.js';
import { RequestQueue, fetchWithRetry, HttpError } from '../core/http.js';
import { Cache } from '../core/cache.js';
import { round } from '../core/geo.js';

const queue = new RequestQueue({ concurrency: SERVICES.brouter.concurrency, minInterval: SERVICES.brouter.minIntervalMs });
const cache = new Cache('brouter', { ttl: 6 * 3600e3, max: 400, persist: false });
/** Profil effectivement accepté par une instance, pour ne pas retenter les replis à chaque tronçon. */
const resolved = new Map();

export class RoutingError extends Error {
  constructor(message, { code = 'unknown', detail = '' } = {}) {
    super(message);
    this.code = code; // 'offroad' | 'noroute' | 'profile' | 'unavailable' | 'overload' | 'unknown' | 'abort'
    this.detail = detail;
  }
}

/** Paramètres de profil dérivés des curseurs de préférences. */
export function profileParams(doc) {
  const def = PROFILES[doc.profile] || PROFILES.trekking;
  const params = {};
  for (const [k, pref] of Object.entries(PREFERENCES)) {
    if (!pref.activities.includes(def.activity)) continue;
    Object.assign(params, pref.toParams(doc.prefs[k] ?? pref.default));
  }
  return params;
}

export function profileCandidates(doc) {
  if (doc.customProfile?.trim()) return [doc.customProfile.trim()];
  return (PROFILES[doc.profile] || PROFILES.trekking).brouter;
}

/** Traduit une erreur technique en message compréhensible. */
export function explainError(err) {
  if (err instanceof RoutingError) return err;
  if (err instanceof HttpError) {
    if (err.kind === 'abort') return new RoutingError('Annulé', { code: 'abort' });
    if (err.kind === 'timeout') return new RoutingError('Le calcul a pris trop de temps (délai dépassé).', { code: 'unavailable' });
    if (err.kind === 'network') {
      return new RoutingError('Service BRouter injoignable (hors ligne, instance arrêtée ou CORS non autorisé).', { code: 'unavailable' });
    }
    const body = (err.body || '').trim();
    if (/not mapped|position not|no (such )?datafile|datafile .* not found|out of (the )?map/i.test(body)) {
      return new RoutingError('Point hors du réseau routable ou hors de la zone couverte : déplacez-le près d’une route ou d’un chemin.', { code: 'offroad', detail: body });
    }
    if (/profile/i.test(body) && /(not|unknown|exist|missing|invalid)/i.test(body)) {
      return new RoutingError('Profil inconnu de cette instance BRouter.', { code: 'profile', detail: body });
    }
    if (/no track|no route|target island|not reachable|unreachable|operation killed/i.test(body)) {
      return new RoutingError('Aucun itinéraire trouvé entre ces points (zone isolée, accès interdit pour ce profil…).', { code: 'noroute', detail: body });
    }
    if (err.status === 429 || err.status === 503) {
      return new RoutingError('Serveur BRouter surchargé, nouvelle tentative conseillée dans quelques instants.', { code: 'overload', detail: body });
    }
    return new RoutingError(`Erreur BRouter (${err.status}) ${body.slice(0, 160)}`, { code: 'unknown', detail: body });
  }
  return new RoutingError(err?.message || 'Erreur inconnue', { code: 'unknown' });
}

function buildUrl(base, from, to, profile, params) {
  const q = new URLSearchParams({
    lonlats: `${round(from.lng, 6)},${round(from.lat, 6)}|${round(to.lng, 6)},${round(to.lat, 6)}`,
    profile,
    alternativeidx: '0',
    format: 'geojson',
  });
  for (const [k, v] of Object.entries(params)) q.append(`profile:${k}`, String(v));
  return `${base}?${q.toString()}`;
}

/**
 * Associe à chaque point du tracé les tags de la voie qui y mène, à partir
 * du tableau `messages` de BRouter (chaque ligne désigne la fin d'une portion).
 */
export function parseGeoJson(json) {
  const feature = json?.features?.[0];
  if (!feature || feature.geometry?.type !== 'LineString') throw new RoutingError('Réponse BRouter invalide.', { code: 'unknown' });
  const coords = feature.geometry.coordinates.map(([lng, lat, ele]) => ({ lat, lng, ele: Number.isFinite(ele) ? ele : null }));
  const props = feature.properties || {};
  const tagList = [];
  const tagIndex = new Map();
  const tagOf = (s) => {
    if (!tagIndex.has(s)) {
      tagIndex.set(s, tagList.length);
      tagList.push(s);
    }
    return tagIndex.get(s);
  };
  const tags = new Int32Array(coords.length).fill(-1);
  const msgs = Array.isArray(props.messages) ? props.messages : [];
  if (msgs.length > 1) {
    const head = msgs[0];
    const iLon = head.indexOf('Longitude');
    const iLat = head.indexOf('Latitude');
    const iTags = head.indexOf('WayTags');
    let cursor = 0;
    for (const row of msgs.slice(1)) {
      const lng = Number(row[iLon]) / 1e6;
      const lat = Number(row[iLat]) / 1e6;
      const t = tagOf(String(row[iTags] || ''));
      let j = cursor;
      while (j < coords.length && (Math.abs(coords[j].lat - lat) > 2e-6 || Math.abs(coords[j].lng - lng) > 2e-6)) j++;
      if (j >= coords.length) continue;
      for (let k = cursor; k <= j; k++) tags[k] = t;
      cursor = j + 1;
    }
    let last = -1;
    for (let k = 0; k < tags.length; k++) {
      if (tags[k] === -1) tags[k] = last;
      else last = tags[k];
    }
    // Premier point : même voie que le segment suivant.
    if (tags.length > 1 && tags[0] === -1) tags[0] = tags[1];
  }
  return {
    coords,
    tags: Array.from(tags),
    tagList,
    time: Number(props['total-time']) || null,
    ascend: Number(props['filtered ascend']) || null,
    length: Number(props['track-length']) || null,
  };
}

/**
 * Calcule un tronçon entre deux points. Essaie les profils candidats dans
 * l'ordre tant que l'instance répond « profil inconnu ».
 */
export async function routeLeg(from, to, { baseUrl, candidates, params, signal }) {
  const rkey = `${baseUrl}|${candidates.join(',')}`;
  const ordered = resolved.has(rkey) ? [resolved.get(rkey)] : candidates;
  let lastErr = null;
  for (const profile of ordered) {
    const url = buildUrl(baseUrl, from, to, profile, params);
    const cached = cache.get(url);
    if (cached) return { ...cached, profile };
    try {
      const res = await queue.run(() => fetchWithRetry(url, {}, { timeoutMs: SERVICES.brouter.timeoutMs, retries: 1, signal }), signal);
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        // Certaines erreurs BRouter sont renvoyées avec un code 200 en texte brut.
        throw explainError(new HttpError('texte', { status: 200, body: text }));
      }
      const leg = parseGeoJson(json);
      cache.set(url, leg);
      resolved.set(rkey, profile);
      return { ...leg, profile };
    } catch (e) {
      lastErr = explainError(e);
      if (lastErr.code !== 'profile') throw lastErr;
    }
  }
  throw lastErr || new RoutingError('Aucun profil disponible.', { code: 'profile' });
}

export function clearRoutingCache() {
  cache.clear();
  resolved.clear();
}
