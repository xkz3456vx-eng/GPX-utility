/**
 * Alertes le long du parcours : absence de points d'eau / de commerces sur une
 * longue distance, dénivelé au-delà de la limite fixée, fortes pentes,
 * tronçons non calculés.
 */
import { rangeStats } from './route-analysis.js';

const km = (m) => (m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',');

/**
 * Plus longues portions sans POI d'une catégorie.
 * @param {number[]} positions positions le long du tracé (m)
 * @param {number} total longueur du tracé (m)
 * @param {number} threshold seuil (m)
 */
export function findGaps(positions, total, threshold) {
  const sorted = [...positions].filter((p) => p >= 0 && p <= total).sort((a, b) => a - b);
  const stops = [0, ...sorted, total];
  const gaps = [];
  for (let i = 1; i < stops.length; i++) {
    const len = stops[i] - stops[i - 1];
    if (len > threshold) gaps.push({ from: stops[i - 1], to: stops[i], length: len });
  }
  return gaps;
}

/**
 * @param {object} p
 * @param {object} p.route analyse du tracé
 * @param {object[]} p.pois POI (avec `along` et éventuellement `alongReturn`)
 * @param {object} p.doc document courant
 * @param {object} p.profile définition du profil
 * @param {number} p.waterGapKm seuil d'alerte eau
 * @param {boolean} p.poisLoaded les POI ont-ils été chargés pour ce tracé ?
 * @returns {{level:'danger'|'warning'|'info', text:string, at?:number}[]}
 */
export function computeAlerts({ route, pois, doc, profile, waterGapKm, poisLoaded, steepGrade = 12 }) {
  const alerts = [];
  if (!route || route.points.length < 2) return alerts;
  const total = route.totals.distance;

  for (const leg of route.legs || []) {
    if (leg.kind === 'error') {
      alerts.push({ level: 'danger', text: `Tronçon ${leg.index + 1} non calculé : ${leg.error} (affiché en ligne droite pointillée).`, at: route.cum[leg.startIdx] });
    }
  }
  const straight = (route.legs || []).filter((l) => l.kind === 'straight').length;
  if (straight) alerts.push({ level: 'info', text: `${straight} tronçon(s) tracé(s) en ligne droite, hors réseau routier.` });

  const maxAscent = doc.prefs?.maxAscent || 0;
  if (maxAscent > 0 && route.totals.ascent > maxAscent) {
    alerts.push({ level: 'warning', text: `Dénivelé positif de ${Math.round(route.totals.ascent)} m, supérieur au maximum fixé (${maxAscent} m).` });
  }

  if (route.totals.hasElevation) {
    // Portions de plus de 200 m au-dessus du seuil de pente (montée).
    const limit = profile.activity === 'hike' ? steepGrade * 2.5 : steepGrade;
    let start = -1, worst = 0, count = 0, worstAt = 0;
    for (let i = 0; i < route.grades.length; i++) {
      const steep = route.grades[i] >= limit;
      if (steep && start < 0) start = i;
      if ((!steep || i === route.grades.length - 1) && start >= 0) {
        if (route.cum[i] - route.cum[start] >= 200) {
          count++;
          const s = rangeStats(route, start, i);
          if (s.maxGrade > worst) { worst = s.maxGrade; worstAt = route.cum[start]; }
        }
        start = -1;
      }
    }
    if (count) alerts.push({ level: 'warning', text: `${count} montée(s) raide(s) (> ${limit} %), jusqu'à ${Math.round(worst)} % au km ${km(worstAt)}.`, at: worstAt });
  }

  if (!poisLoaded) {
    alerts.push({ level: 'info', text: "Recherchez les points d'intérêt pour vérifier les points d'eau et les ravitaillements." });
    return alerts;
  }
  const positionsOf = (cat) => pois.filter((p) => p.cat === cat).flatMap((p) => [p.along, p.alongReturn].filter((v) => v != null));
  const threshold = waterGapKm * 1000;
  if (doc.poi.categories.water) {
    for (const g of findGaps(positionsOf('water'), total, threshold)) {
      const level = g.length > threshold * 1.5 ? 'danger' : 'warning';
      alerts.push({ level, text: `Aucun point d'eau sur ${km(g.length)} km, du km ${km(g.from)} au km ${km(g.to)}.`, at: g.from });
    }
  } else {
    alerts.push({ level: 'info', text: "Catégorie « Points d'eau » désactivée : ravitaillement en eau non vérifié." });
  }
  if (doc.poi.categories.food) {
    for (const g of findGaps(positionsOf('food'), total, threshold * 2)) {
      alerts.push({ level: 'warning', text: `Aucun commerce alimentaire sur ${km(g.length)} km, du km ${km(g.from)} au km ${km(g.to)}.`, at: g.from });
    }
  }
  return alerts;
}
