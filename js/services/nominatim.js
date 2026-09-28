/**
 * Recherche de lieux (géocodage) via Nominatim.
 * Politique d'usage : 1 requête/s max, pas d'autocomplétion (recherche à la validation uniquement).
 */
import { SERVICES } from '../config.js';
import { RequestQueue, fetchWithRetry } from '../core/http.js';
import { Cache } from '../core/cache.js';
import { settings } from '../core/settings.js';

const queue = new RequestQueue({ concurrency: 1, minInterval: SERVICES.nominatim.minIntervalMs });
const cache = new Cache('nominatim', { ttl: 7 * 24 * 3600e3, max: 50, persist: true });

export async function searchPlace(text, { signal } = {}) {
  const q = text.trim();
  if (!q) return [];
  const cached = cache.get(q.toLowerCase());
  if (cached) return cached;
  const params = new URLSearchParams({ q, format: 'jsonv2', limit: '6', 'accept-language': 'fr' });
  const email = settings.get('contactEmail');
  if (email) params.set('email', email);
  const res = await queue.run(() => fetchWithRetry(`${SERVICES.nominatim.url}?${params}`, {}, { timeoutMs: 15000, retries: 1, signal }), signal);
  const json = await res.json();
  const out = json.map((r) => ({ name: r.display_name, lat: Number(r.lat), lng: Number(r.lon), type: r.type }));
  cache.set(q.toLowerCase(), out);
  return out;
}
