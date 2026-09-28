/**
 * Lecture / écriture de fichiers GPX 1.1.
 * `exportGpx` est pur (testable sous Node) ; `parseGpx` utilise DOMParser.
 */
import { APP, POI_CATEGORIES, OSM_TYPE_LABELS } from '../config.js';

export function xmlEscape(s) {
  return String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

const f6 = (v) => Number(v).toFixed(6);
const f1 = (v) => Number(v).toFixed(1);

function wpt(p, { name, desc, sym, type }) {
  return [
    `  <wpt lat="${f6(p.lat)}" lon="${f6(p.lng)}">`,
    Number.isFinite(p.ele) ? `    <ele>${f1(p.ele)}</ele>` : '',
    name ? `    <name>${xmlEscape(name)}</name>` : '',
    desc ? `    <desc>${xmlEscape(desc)}</desc>` : '',
    sym ? `    <sym>${xmlEscape(sym)}</sym>` : '',
    type ? `    <type>${xmlEscape(type)}</type>` : '',
    '  </wpt>',
  ].filter(Boolean).join('\n');
}

export function poiDescription(poi) {
  const t = poi.tags || {};
  const parts = [OSM_TYPE_LABELS[poi.kind] || poi.kind];
  if (poi.along != null) parts.push(`km ${(poi.along / 1000).toFixed(1)}`);
  if (poi.dist != null) parts.push(`à ${Math.round(poi.dist)} m du tracé`);
  if (t.opening_hours) parts.push(`Horaires : ${t.opening_hours}`);
  if (t.phone || t['contact:phone']) parts.push(`Tél. : ${t.phone || t['contact:phone']}`);
  if (t.website || t['contact:website']) parts.push(t.website || t['contact:website']);
  return parts.filter(Boolean).join(' – ');
}

/**
 * @param {object} p
 * @param {string} p.name nom de l'itinéraire
 * @param {Array<{lat,lng,ele}>} p.track points du tracé (ele = altitude complétée)
 * @param {Array<{lat,lng,name}>} p.waypoints étapes
 * @param {object[]} p.pois POI sélectionnés
 * @param {boolean} [p.includeWaypoints=true]
 * @param {string} [p.time] horodatage ISO pour les métadonnées
 */
export function exportGpx({ name, track, waypoints = [], pois = [], includeWaypoints = true, time = new Date().toISOString() }) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${xmlEscape(`${APP.name} ${APP.version}`)}" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">`,
    '  <metadata>',
    `    <name>${xmlEscape(name)}</name>`,
    `    <time>${xmlEscape(time)}</time>`,
    '  </metadata>',
  ];
  if (includeWaypoints) {
    waypoints.forEach((w, i) => {
      const label = w.name || (i === 0 ? 'Départ' : i === waypoints.length - 1 ? 'Arrivée' : `Étape ${i}`);
      lines.push(wpt(w, { name: label, sym: i === 0 || i === waypoints.length - 1 ? 'Flag, Blue' : 'Flag, Green', type: 'Étape' }));
    });
  }
  for (const poi of pois) {
    const cat = POI_CATEGORIES.find((c) => c.id === poi.cat);
    lines.push(wpt(poi, {
      name: poi.name || OSM_TYPE_LABELS[poi.kind] || cat?.label || 'POI',
      desc: poiDescription(poi),
      sym: cat?.gpxSym,
      type: cat?.label,
    }));
  }
  lines.push('  <trk>', `    <name>${xmlEscape(name)}</name>`, '    <trkseg>');
  for (const p of track) {
    lines.push(Number.isFinite(p.ele)
      ? `      <trkpt lat="${f6(p.lat)}" lon="${f6(p.lng)}"><ele>${f1(p.ele)}</ele></trkpt>`
      : `      <trkpt lat="${f6(p.lat)}" lon="${f6(p.lng)}"/>`);
  }
  lines.push('    </trkseg>', '  </trk>', '</gpx>', '');
  return lines.join('\n');
}

/**
 * Analyse un fichier GPX (trk, rte, wpt).
 * @returns {{name:string, tracks: Array<Array<{lat,lng,ele}>>, waypoints: Array<{lat,lng,ele,name,desc}>}}
 */
export function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Fichier GPX illisible (XML invalide).');
  const byTag = (root, tag) => Array.from(root.getElementsByTagNameNS('*', tag));
  const child = (el, tag) => byTag(el, tag).find((c) => c.parentNode === el);
  const pt = (el) => {
    const ele = child(el, 'ele');
    return {
      lat: Number(el.getAttribute('lat')),
      lng: Number(el.getAttribute('lon')),
      ele: ele ? Number(ele.textContent) : null,
    };
  };
  const valid = (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng);
  const tracks = [];
  for (const trk of byTag(doc, 'trk')) {
    // Les segments d'une même trace sont concaténés.
    const pts = byTag(trk, 'trkpt').map(pt).filter(valid);
    if (pts.length >= 2) tracks.push(pts);
  }
  for (const rte of byTag(doc, 'rte')) {
    const pts = byTag(rte, 'rtept').map(pt).filter(valid);
    if (pts.length >= 2) tracks.push(pts);
  }
  const waypoints = byTag(doc, 'wpt').map((el) => ({
    ...pt(el),
    name: child(el, 'name')?.textContent?.trim() || '',
    desc: child(el, 'desc')?.textContent?.trim() || '',
  })).filter(valid);
  const metaName = byTag(doc, 'metadata')[0] ? child(byTag(doc, 'metadata')[0], 'name')?.textContent : '';
  const trkName = byTag(doc, 'trk')[0] ? child(byTag(doc, 'trk')[0], 'name')?.textContent : '';
  if (!tracks.length && !waypoints.length) throw new Error('Aucune trace, route ni point trouvé dans ce fichier.');
  return { name: (metaName || trkName || '').trim(), tracks, waypoints };
}

export function safeFilename(name) {
  return (name || 'itineraire').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9-_ ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'itineraire';
}
