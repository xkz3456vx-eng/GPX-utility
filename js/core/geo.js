/**
 * Fonctions géométriques pures (aucune dépendance au DOM ni à Leaflet).
 * Les points sont des objets { lat, lng, ele? }.
 */

const R = 6371008.8;
const RAD = Math.PI / 180;

/** Distance orthodromique en mètres. */
export function haversine(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLng = (lng2 - lng1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function distance(a, b) {
  return haversine(a.lat, a.lng, b.lat, b.lng);
}

/** Distances cumulées (m) le long d'une liste de points. */
export function cumulativeDistances(points) {
  const out = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) out[i] = out[i - 1] + distance(points[i - 1], points[i]);
  return out;
}

/**
 * Projection équirectangulaire locale (mètres), suffisante pour des calculs
 * de proximité sur quelques centaines de kilomètres.
 */
export function localProjection(lat0) {
  const kx = Math.cos(lat0 * RAD) * R * RAD;
  const ky = R * RAD;
  return (lat, lng) => [lng * kx, lat * ky];
}

/** Distance d'un point P au segment AB (coordonnées projetées). Renvoie { d, t }. */
export function pointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return { d: Math.hypot(px - cx, py - cy), t };
}

/**
 * Index spatial minimal pour trouver le point le plus proche d'une polyligne.
 * Construit une fois par tracé, interrogé pour chaque POI ou survol de souris.
 */
export class PolylineIndex {
  constructor(points, cum = cumulativeDistances(points)) {
    this.points = points;
    this.cum = cum;
    const lat0 = points.length ? points.reduce((s, p) => s + p.lat, 0) / points.length : 0;
    this.project = localProjection(lat0);
    this.xy = new Float64Array(points.length * 2);
    points.forEach((p, i) => {
      const [x, y] = this.project(p.lat, p.lng);
      this.xy[2 * i] = x;
      this.xy[2 * i + 1] = y;
    });
    // Grille de cellules de 2 km pour limiter les segments testés.
    this.cell = 2000;
    this.grid = new Map();
    for (let i = 0; i < points.length - 1; i++) {
      const x1 = this.xy[2 * i], y1 = this.xy[2 * i + 1], x2 = this.xy[2 * i + 2], y2 = this.xy[2 * i + 3];
      const cx1 = Math.floor(Math.min(x1, x2) / this.cell), cx2 = Math.floor(Math.max(x1, x2) / this.cell);
      const cy1 = Math.floor(Math.min(y1, y2) / this.cell), cy2 = Math.floor(Math.max(y1, y2) / this.cell);
      for (let cx = cx1; cx <= cx2; cx++) {
        for (let cy = cy1; cy <= cy2; cy++) {
          const k = `${cx},${cy}`;
          let arr = this.grid.get(k);
          if (!arr) this.grid.set(k, (arr = []));
          arr.push(i);
        }
      }
    }
  }

  /**
   * Point du tracé le plus proche de (lat, lng).
   * Renvoie { index, t, dist, along } ou null. `maxDist` borne la recherche (m).
   */
  nearest(lat, lng, maxDist = Infinity) {
    const n = this.points.length;
    if (n === 0) return null;
    if (n === 1) {
      const d = haversine(lat, lng, this.points[0].lat, this.points[0].lng);
      return d <= maxDist ? { index: 0, t: 0, dist: d, along: 0 } : null;
    }
    const [px, py] = this.project(lat, lng);
    let best = null;
    const test = (i) => {
      const r = pointToSegment(px, py, this.xy[2 * i], this.xy[2 * i + 1], this.xy[2 * i + 2], this.xy[2 * i + 3]);
      if (!best || r.d < best.dist) best = { index: i, t: r.t, dist: r.d };
    };
    if (Number.isFinite(maxDist)) {
      const reach = Math.ceil(maxDist / this.cell);
      const cx0 = Math.floor(px / this.cell), cy0 = Math.floor(py / this.cell);
      const seen = new Set();
      for (let cx = cx0 - reach; cx <= cx0 + reach; cx++) {
        for (let cy = cy0 - reach; cy <= cy0 + reach; cy++) {
          const arr = this.grid.get(`${cx},${cy}`);
          if (!arr) continue;
          for (const i of arr) if (!seen.has(i)) { seen.add(i); test(i); }
        }
      }
    } else {
      for (let i = 0; i < n - 1; i++) test(i);
    }
    if (!best || best.dist > maxDist) return null;
    best.along = this.cum[best.index] + best.t * (this.cum[best.index + 1] - this.cum[best.index]);
    // Index du sommet le plus proche, pratique pour synchroniser carte / profil.
    best.vertex = best.t < 0.5 ? best.index : best.index + 1;
    return best;
  }
}

/** Simplification Douglas–Peucker (tolérance en mètres). Conserve les extrémités. */
export function simplify(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const lat0 = points[0].lat;
  const proj = localProjection(lat0);
  const xy = points.map((p) => proj(p.lat, p.lng));
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const { d } = pointToSegment(xy[i][0], xy[i][1], xy[a][0], xy[a][1], xy[b][0], xy[b][1]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolerance) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Simplifie jusqu'à obtenir au plus `maxPoints` points. */
export function simplifyTo(points, maxPoints, startTolerance = 10) {
  let tol = startTolerance;
  let out = simplify(points, tol);
  while (out.length > maxPoints && tol < 100000) {
    tol *= 1.6;
    out = simplify(points, tol);
  }
  return out;
}

/** Découpe une polyligne en morceaux d'environ `maxLen` mètres (points de jonction partagés). */
export function chunkByDistance(points, maxLen) {
  if (points.length < 2) return [points];
  const chunks = [];
  let cur = [points[0]];
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += distance(points[i - 1], points[i]);
    cur.push(points[i]);
    if (len >= maxLen && i < points.length - 1) {
      chunks.push(cur);
      cur = [points[i]];
      len = 0;
    }
  }
  chunks.push(cur);
  return chunks;
}

export function boundsOf(points) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const p of points) {
    if (p.lat < s) s = p.lat;
    if (p.lat > n) n = p.lat;
    if (p.lng < w) w = p.lng;
    if (p.lng > e) e = p.lng;
  }
  return [[s, w], [n, e]];
}

/** Arrondi pour clés de cache et liens de partage. */
export const round = (v, d = 5) => Math.round(v * 10 ** d) / 10 ** d;

/** Encodage « Google polyline » (précision 5), compact pour les liens de partage. */
export function encodePolyline(points, precision = 5) {
  const f = 10 ** precision;
  let lastLat = 0, lastLng = 0, out = '';
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return s + String.fromCharCode(v + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * f), lng = Math.round(p.lng * f);
    out += enc(lat - lastLat) + enc(lng - lastLng);
    lastLat = lat;
    lastLng = lng;
  }
  return out;
}

export function decodePolyline(str, precision = 5) {
  const f = 10 ** precision;
  const pts = [];
  let i = 0, lat = 0, lng = 0;
  const dec = () => {
    let res = 0, shift = 0, b;
    do {
      b = str.charCodeAt(i++) - 63;
      res |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return res & 1 ? ~(res >> 1) : res >> 1;
  };
  while (i < str.length) {
    lat += dec();
    lng += dec();
    pts.push({ lat: lat / f, lng: lng / f });
  }
  return pts;
}
