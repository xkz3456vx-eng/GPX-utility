/**
 * Analyse d'un tracé : surfaces, type de voie, difficulté, pentes, dénivelé,
 * temps estimé. Module pur (testable sous Node).
 */
import { SURFACES, DIFFICULTIES, WAY_TYPES } from '../config.js';
import { cumulativeDistances } from '../core/geo.js';

export const SURFACE = Object.fromEntries(SURFACES.map((s, i) => [s.id, i]));
export const WAY = Object.fromEntries(WAY_TYPES.map((s, i) => [s.id, i]));

/** "highway=track surface=gravel" -> { highway: 'track', surface: 'gravel' } */
export function parseWayTags(raw) {
  const out = {};
  for (const part of (raw || '').split(/\s+/)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

const PAVED = /^(asphalt|paved|concrete(:.*)?|paving_stones(:.*)?|sett|cobblestone(:.*)?|unhewn_cobblestone|metal|wood|chipseal|tartan|rubber|bricks?)$/;
const GRAVEL = /^(gravel|fine_gravel|compacted|pebblestone|shells)$/;
const DIRT = /^(unpaved|dirt|earth|ground|mud|sand|grass|soil|grass_paver|woodchips|clay|rock|stone|snow|ice)$/;
const ROADS = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|cycleway|pedestrian|busway)(_link)?$/;
const PATHS = /^(path|footway|bridleway|steps|via_ferrata)$/;

export function classifySurface(t) {
  const hw = t.highway || '';
  const s = t.surface;
  if (s) {
    if (PAVED.test(s)) return SURFACE.asphalt;
    if (GRAVEL.test(s)) return SURFACE.gravel;
    if (DIRT.test(s)) return PATHS.test(hw) ? SURFACE.path : SURFACE.dirt;
  }
  if (hw === 'track') {
    switch (t.tracktype) {
      case 'grade1': return SURFACE.asphalt;
      case 'grade2': return SURFACE.gravel;
      default: return SURFACE.dirt;
    }
  }
  if (hw === 'footway' && !t.sac_scale) return SURFACE.unknown;
  if (PATHS.test(hw)) return SURFACE.path;
  if (ROADS.test(hw)) return SURFACE.asphalt;
  return SURFACE.unknown;
}

export function classifyWayType(t) {
  const hw = t.highway || '';
  // Pistes cyclables, voies vertes (chemins désignés vélo) et bandes séparées.
  if (hw === 'cycleway' || /^(track|separate)$/.test(t.cycleway || '')) return WAY.cycleway;
  if (t.bicycle === 'designated' && (PATHS.test(hw) || hw === 'track')) return WAY.cycleway;
  if (/^(motorway|trunk|primary|secondary)(_link)?$/.test(hw)) return WAY.major;
  if (/^(tertiary|unclassified|residential|living_street|service|road|pedestrian)(_link)?$/.test(hw)) return WAY.minor;
  if (hw === 'track') return WAY.track;
  if (PATHS.test(hw)) return WAY.path;
  return WAY.other;
}

/** Difficulté intrinsèque de la voie (0..3) selon l'activité. */
export function wayDifficulty(t, surface, activity) {
  if (activity === 'hike') {
    const sac = t.sac_scale || '';
    if (/alpine/.test(sac)) return 3;
    if (sac === 'demanding_mountain_hiking') return 2;
    if (sac === 'mountain_hiking' || t.highway === 'via_ferrata') return 1;
    return 0;
  }
  const mtb = Number.parseFloat(t['mtb:scale']);
  if (Number.isFinite(mtb)) return mtb >= 3 ? 3 : mtb >= 2 ? 2 : mtb >= 1 ? 1 : 0;
  if (t.highway === 'steps') return 3;
  if (/^(very_bad|horrible|very_horrible|impassable)$/.test(t.smoothness || '')) return 3;
  if (/^(bad)$/.test(t.smoothness || '') || /^grade[45]$/.test(t.tracktype || '')) return 2;
  if (surface === SURFACE.path) return 2;
  if (surface === SURFACE.dirt || surface === SURFACE.gravel) return 1;
  return 0;
}

/** Difficulté liée à la pente (%, valeur absolue en montée surtout). */
export function gradeDifficulty(grade, activity) {
  const g = grade > 0 ? grade : Math.abs(grade) * 0.6; // les descentes comptent moins
  if (activity === 'hike') return g >= 35 ? 3 : g >= 25 ? 2 : g >= 15 ? 1 : 0;
  return g >= 12 ? 3 : g >= 8 ? 2 : g >= 4 ? 1 : 0;
}

/** Complète les altitudes manquantes par interpolation linéaire en distance. */
export function fillElevation(points, cum) {
  const n = points.length;
  const ele = new Float64Array(n);
  let known = 0;
  for (let i = 0; i < n; i++) if (Number.isFinite(points[i].ele)) known++;
  if (known === 0) return { ele, hasElevation: false };
  let prev = -1;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(points[i].ele)) {
      ele[i] = points[i].ele;
      if (prev === -1) for (let k = 0; k < i; k++) ele[k] = ele[i];
      else if (i - prev > 1) {
        const span = cum[i] - cum[prev] || 1;
        for (let k = prev + 1; k < i; k++) ele[k] = ele[prev] + (ele[i] - ele[prev]) * ((cum[k] - cum[prev]) / span);
      }
      prev = i;
    }
  }
  for (let k = prev + 1; k < n; k++) ele[k] = ele[prev];
  return { ele, hasElevation: true };
}

/** Pente lissée (%) en chaque point, calculée sur une fenêtre de ±`half` mètres. */
export function computeGrades(cum, ele, half = 50) {
  const n = cum.length;
  const grades = new Float32Array(n);
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    while (a < i && cum[i] - cum[a] > half) a++;
    if (b < i) b = i;
    while (b < n - 1 && cum[b] - cum[i] < half) b++;
    const dd = cum[b] - cum[a];
    grades[i] = dd > 5 ? ((ele[b] - ele[a]) / dd) * 100 : 0;
  }
  return grades;
}

/** Dénivelés positif/négatif avec hystérésis (filtre le bruit du MNT). */
export function computeClimb(ele, threshold = 3) {
  let up = 0, down = 0;
  if (!ele.length) return { up, down };
  let ref = ele[0];
  for (let i = 1; i < ele.length; i++) {
    const d = ele[i] - ref;
    if (d >= threshold) { up += d; ref = ele[i]; } else if (d <= -threshold) { down -= d; ref = ele[i]; }
  }
  return { up, down };
}

/**
 * Temps estimé (heures).
 * - Randonnée : méthode DIN 33466 (horizontal 4,5 km/h ; +300 m/h ; −500 m/h),
 *   le plus grand des deux temps + la moitié du plus petit.
 * - Vélo : vitesse à plat modulée par la surface, + temps de montée selon la
 *   vitesse ascensionnelle (VAM), gain limité en descente.
 */
export function estimateTime(profile, { cum, ele, surface }, speedOverride = 0) {
  const n = cum.length;
  if (n < 2) return 0;
  const speed = speedOverride > 0 ? speedOverride : profile.speed;
  if (profile.activity === 'hike') {
    let horiz = 0, up = 0, down = 0;
    for (let i = 1; i < n; i++) {
      const dd = cum[i] - cum[i - 1];
      const f = profile.surfaceFactor?.[surface[i]] ?? 1;
      horiz += dd / 1000 / (speed * f);
    }
    const climb = computeClimb(ele);
    up = climb.up / (profile.up || 300);
    down = climb.down / (profile.down || 500);
    const vert = up + down;
    return Math.max(horiz, vert) + Math.min(horiz, vert) / 2;
  }
  let t = 0;
  const vam = profile.vam || 600;
  for (let i = 1; i < n; i++) {
    const dd = (cum[i] - cum[i - 1]) / 1000;
    if (dd <= 0) continue;
    const dh = ele[i] - ele[i - 1];
    const f = profile.surfaceFactor?.[surface[i]] ?? 1;
    const v = speed * f;
    if (dh > 0) t += dd / v + dh / vam * 0.75;
    else {
      const grade = -dh / (dd * 1000);
      t += dd / Math.min(v * (1 + Math.min(0.6, grade * 6)), v * 1.6);
    }
  }
  return t;
}

/**
 * Analyse complète d'un tracé assemblé.
 * @param {Array<{lat,lng,ele,tag,leg}>} points
 * @param {string[]} tagList tags bruts (index = point.tag)
 * @param {object} profile définition du profil (config PROFILES)
 */
export function analyzeRoute(points, tagList, profile, { speed = 0 } = {}) {
  const n = points.length;
  const cum = cumulativeDistances(points);
  const { ele, hasElevation } = fillElevation(points, cum);
  const grades = computeGrades(cum, ele);
  const parsed = tagList.map(parseWayTags);
  const tagSurface = parsed.map(classifySurface);
  const tagWay = parsed.map(classifyWayType);
  const surface = new Uint8Array(n);
  const way = new Uint8Array(n);
  const difficulty = new Uint8Array(n);
  const breakdown = {
    surface: new Array(SURFACES.length).fill(0),
    way: new Array(WAY_TYPES.length).fill(0),
    difficulty: new Array(DIFFICULTIES.length).fill(0),
  };
  for (let i = 0; i < n; i++) {
    const tg = points[i].tag;
    const has = tg != null && tg >= 0 && tg < tagList.length;
    surface[i] = has ? tagSurface[tg] : SURFACE.unknown;
    way[i] = has ? tagWay[tg] : WAY.other;
    const wd = has ? wayDifficulty(parsed[tg], surface[i], profile.activity) : 0;
    const gd = hasElevation ? gradeDifficulty(grades[i], profile.activity) : 0;
    difficulty[i] = Math.max(wd, gd);
    if (i > 0) {
      const dd = cum[i] - cum[i - 1];
      breakdown.surface[surface[i]] += dd;
      breakdown.way[way[i]] += dd;
      breakdown.difficulty[difficulty[i]] += dd;
    }
  }
  const climb = hasElevation ? computeClimb(ele) : { up: 0, down: 0 };
  let minEle = Infinity, maxEle = -Infinity, maxGrade = 0;
  for (let i = 0; i < n; i++) {
    if (ele[i] < minEle) minEle = ele[i];
    if (ele[i] > maxEle) maxEle = ele[i];
    if (grades[i] > maxGrade) maxGrade = grades[i];
  }
  const distance = n ? cum[n - 1] : 0;
  const time = estimateTime(profile, { cum, ele, surface }, speed);
  return {
    points,
    tagList,
    parsedTags: parsed,
    cum,
    ele,
    grades,
    surface,
    way,
    difficulty,
    breakdown,
    totals: {
      distance,
      ascent: climb.up,
      descent: climb.down,
      minEle: hasElevation ? minEle : null,
      maxEle: hasElevation ? maxEle : null,
      maxGrade: hasElevation ? maxGrade : null,
      time,
      hasElevation,
    },
  };
}

/** Statistiques d'une portion [a, b] (indices de points) d'une analyse. */
export function rangeStats(an, a, b) {
  if (a > b) [a, b] = [b, a];
  const ele = an.ele.slice(a, b + 1);
  const climb = computeClimb(ele);
  let maxGrade = 0;
  for (let i = a; i <= b; i++) maxGrade = Math.max(maxGrade, an.grades[i]);
  return { distance: an.cum[b] - an.cum[a], ascent: climb.up, descent: climb.down, maxGrade };
}
