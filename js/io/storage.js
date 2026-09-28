/**
 * Sauvegarde locale des projets (localStorage) et partage par lien.
 *
 * Le lien de partage contient l'état du document dans le fragment d'URL
 * (#r=...), compressé (deflate) puis encodé en base64url : rien n'est envoyé
 * à un serveur.
 */
import { APP } from '../config.js';
import { uid, normalizeDoc } from '../core/store.js';
import { encodePolyline, decodePolyline, round } from '../core/geo.js';

const P = APP.storagePrefix;
const INDEX = `${P}projects`;
const CURRENT = `${P}current`;

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function listProjects() {
  return read(INDEX, []).sort((a, b) => b.updated - a.updated);
}

export function loadProject(id) {
  const d = read(`${P}project:${id}`, null);
  return d ? normalizeDoc(d) : null;
}

/** Enregistre le document ; renvoie l'id (nouveau si `id` absent). */
export function saveProject(doc, id = null, summary = {}) {
  const pid = id || uid('p');
  if (!write(`${P}project:${pid}`, doc)) throw new Error('Espace de stockage local plein : supprimez d’anciens projets ou videz le cache.');
  const index = read(INDEX, []).filter((p) => p.id !== pid);
  index.push({ id: pid, name: doc.name, updated: Date.now(), ...summary });
  write(INDEX, index);
  return pid;
}

export function deleteProject(id) {
  try {
    localStorage.removeItem(`${P}project:${id}`);
  } catch { /* ignore */ }
  write(INDEX, read(INDEX, []).filter((p) => p.id !== id));
}

export function renameProject(id, name) {
  const d = read(`${P}project:${id}`, null);
  if (!d) return;
  d.name = name;
  write(`${P}project:${id}`, d);
  write(INDEX, read(INDEX, []).map((p) => (p.id === id ? { ...p, name } : p)));
}

/** Sauvegarde automatique de l'état courant (restauré au rechargement). */
export function saveCurrent(doc, projectId) {
  write(CURRENT, { doc, projectId });
}

export function loadCurrent() {
  const c = read(CURRENT, null);
  return c?.doc ? { doc: normalizeDoc(c.doc), projectId: c.projectId || null } : null;
}

// ---------- Lien de partage ----------

/** Représentation compacte du document pour l'URL. */
export function toSharePayload(doc) {
  const idx = new Map(doc.waypoints.map((w, i) => [w.id, i]));
  const fixed = {};
  for (const [fromId, f] of Object.entries(doc.fixedLegs || {})) {
    if (idx.has(fromId)) fixed[idx.get(fromId)] = encodePolyline(f.coords);
  }
  return {
    v: 1,
    n: doc.name,
    m: doc.mode,
    p: doc.profile,
    c: doc.customProfile || undefined,
    pr: doc.prefs,
    w: doc.waypoints.map((w) => [round(w.lat), round(w.lng), w.name || 0, w.straight ? 1 : 0]),
    f: Object.keys(fixed).length ? fixed : undefined,
    po: { r: doc.poi.radius, c: Object.keys(doc.poi.categories).filter((k) => doc.poi.categories[k]) },
    s: Object.values(doc.selectedPois || {}).map((p) => [p.id, round(p.lat), round(p.lng), p.cat, p.kind, p.name || 0]),
  };
}

export function fromSharePayload(o) {
  if (!o || o.v !== 1) throw new Error('Lien de partage non reconnu.');
  const waypoints = (o.w || []).map(([lat, lng, name, straight]) => ({ id: uid(), lat, lng, name: name || '', straight: !!straight }));
  const fixedLegs = {};
  for (const [i, poly] of Object.entries(o.f || {})) {
    const from = waypoints[Number(i)];
    const to = waypoints[Number(i) + 1] || waypoints[0];
    if (!from || !to) continue;
    const coords = decodePolyline(poly);
    // Les extrémités sont recalées exactement sur les points de passage.
    coords[0] = { lat: from.lat, lng: from.lng };
    coords[coords.length - 1] = { lat: to.lat, lng: to.lng };
    fixedLegs[from.id] = { to: to.id, coords };
  }
  const categories = {};
  for (const c of o.po?.c || []) categories[c] = true;
  const selectedPois = {};
  for (const [id, lat, lng, cat, kind, name] of o.s || []) selectedPois[id] = { id, lat, lng, cat, kind, name: name || '', tags: {} };
  return normalizeDoc({
    name: o.n,
    mode: o.m,
    profile: o.p,
    customProfile: o.c || '',
    prefs: o.pr,
    waypoints,
    fixedLegs,
    selectedPois,
    poi: o.po ? { radius: o.po.r, categories: Object.fromEntries(Object.keys(categories).map((k) => [k, true])) } : undefined,
  });
}

const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

function toBase64Chunks(bytes) {
  // btoa + spread échoue au-delà de ~100 ko : on procède par blocs.
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function encodeShare(doc) {
  const json = new TextEncoder().encode(JSON.stringify(toSharePayload(doc)));
  if (typeof CompressionStream !== 'undefined') {
    const z = await pipe(json, new CompressionStream('deflate-raw'));
    return `z${toBase64Chunks(z)}`;
  }
  return `j${toBase64Chunks(json)}`;
}

export async function decodeShare(str) {
  const kind = str[0];
  let bytes = unb64url(str.slice(1));
  if (kind === 'z') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
  else if (kind !== 'j') throw new Error('Lien de partage non reconnu.');
  return fromSharePayload(JSON.parse(new TextDecoder().decode(bytes)));
}

export async function buildShareUrl(doc) {
  const url = new URL(window.location.href);
  url.hash = `r=${await encodeShare(doc)}`;
  url.search = '';
  return url.toString();
}
