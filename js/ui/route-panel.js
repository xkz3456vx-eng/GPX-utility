/**
 * Onglet « Itinéraire » : profil, préférences, type de parcours, points de
 * passage, statistiques, répartition des surfaces et alertes.
 */
import { PROFILES, PREFERENCES, SURFACES, WAY_TYPES, DIFFICULTIES } from '../config.js';
import { h, fmtKm, fmtM, fmtDuration, fmtPct, fmtDist } from './dom.js';
import { distance } from '../core/geo.js';

const MODES = [
  { id: 'oneway', label: 'Aller simple' },
  { id: 'loop', label: 'Boucle' },
  { id: 'outback', label: 'Aller-retour' },
];

export function renderRoutePanel(el, app) {
  const { doc, runtime } = app.store;
  const profile = PROFILES[doc.profile] || PROFILES.trekking;
  const route = runtime.route;
  el.replaceChildren(
    profileSection(doc, app),
    prefsSection(doc, profile, app),
    modeSection(doc, app),
    waypointSection(doc, route, app),
    statsSection(route, runtime, app),
    breakdownSection(route),
    alertsSection(runtime.alerts || [], app),
  );
}

function section(title, ...children) {
  return h('section', { class: 'block' }, h('h3', {}, title), ...children);
}

function profileSection(doc, app) {
  const chips = Object.entries(PROFILES).map(([id, p]) => h('label', { class: `chip${doc.profile === id && !doc.customProfile ? ' active' : ''}` },
    h('input', {
      type: 'radio', name: 'profile', value: id, checked: doc.profile === id,
      onchange: () => app.actions.setProfile(id),
    }),
    h('span', { 'aria-hidden': 'true' }, p.icon), ' ', p.label));
  const custom = h('details', { class: 'custom-profile', open: !!doc.customProfile },
    h('summary', {}, 'Profil BRouter personnalisé'),
    h('p', { class: 'hint' }, 'Nom exact d’un profil disponible sur l’instance BRouter (ex. « fastbike-lowtraffic », « trekking-steep »). Laisser vide pour utiliser le profil ci-dessus.'),
    h('input', {
      type: 'text', value: doc.customProfile || '', placeholder: 'ex. fastbike-lowtraffic',
      onchange: (e) => app.actions.setCustomProfile(e.target.value.trim()),
    }));
  const used = app.store.runtime.routeInfo?.profile;
  return section('Type de parcours',
    h('div', { class: 'chips' }, chips),
    used ? h('p', { class: 'hint' }, `Profil BRouter utilisé : ${used}`) : null,
    custom);
}

function prefsSection(doc, profile, app) {
  const rows = Object.entries(PREFERENCES).filter(([, p]) => p.activities.includes(profile.activity)).map(([key, p]) => {
    const value = doc.prefs[key] ?? p.default;
    const out = h('output', {}, p.format(value));
    const input = h('input', {
      type: 'range', min: p.min, max: p.max, step: p.step, value,
      'aria-label': p.label,
      oninput: (e) => { out.textContent = p.format(Number(e.target.value)); },
      onchange: (e) => app.actions.setPref(key, Number(e.target.value)),
    });
    return h('div', { class: 'pref' }, h('div', { class: 'pref-head' }, h('span', {}, p.label), out), input);
  });
  return section('Préférences', ...rows,
    h('p', { class: 'hint' }, 'Les préférences sont transmises au profil BRouter lorsqu’il les prend en charge ; le dénivelé maximum déclenche aussi une alerte.'));
}

function modeSection(doc, app) {
  return h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Forme du parcours' },
    MODES.map((m) => h('button', {
      class: `seg${doc.mode === m.id ? ' active' : ''}`, role: 'radio', 'aria-checked': String(doc.mode === m.id),
      onclick: () => app.actions.setMode(m.id),
    }, m.label)));
}

function waypointSection(doc, route, app) {
  const wps = doc.waypoints;
  if (!wps.length) {
    return section('Points de passage', h('p', { class: 'empty' },
      'Cliquez sur la carte pour placer le départ, puis les étapes suivantes. ',
      'Glissez un point pour le déplacer, glissez le tracé pour ajouter une étape, clic droit sur un point pour le supprimer.'));
  }
  // Distance cumulée à chaque point de passage (d'après les tronçons calculés).
  const at = new Map();
  if (route?.legs) {
    for (const leg of route.legs) {
      if (!at.has(leg.fromId)) at.set(leg.fromId, route.cum[leg.startIdx]);
      if (!at.has(leg.toId)) at.set(leg.toId, route.cum[leg.endIdx]);
    }
  }
  let dragFrom = null;
  const items = wps.map((w, i) => {
    const isEnd = i === wps.length - 1 && wps.length > 1 && doc.mode === 'oneway';
    const badge = i === 0 ? 'D' : isEnd ? 'A' : String(i);
    const cls = i === 0 ? 'wp-start' : isEnd ? 'wp-end' : w.poi ? 'wp-poi' : 'wp-via';
    const li = h('li', {
      class: 'wp-item', draggable: 'true',
      ondragstart: (e) => { dragFrom = i; e.dataTransfer.effectAllowed = 'move'; li.classList.add('dragging'); },
      ondragend: () => li.classList.remove('dragging'),
      ondragover: (e) => { e.preventDefault(); li.classList.add('drop'); },
      ondragleave: () => li.classList.remove('drop'),
      ondrop: (e) => { e.preventDefault(); li.classList.remove('drop'); if (dragFrom != null && dragFrom !== i) app.actions.reorder(dragFrom, i); },
    },
    h('span', { class: 'handle', title: 'Glisser pour réordonner', 'aria-hidden': 'true' }, '⋮⋮'),
    h('button', { class: `wp ${cls} wp-btn`, title: 'Centrer la carte', onclick: () => app.map.flyTo(w.lat, w.lng, 15) }, badge),
    h('div', { class: 'wp-main' },
      h('input', {
        class: 'wp-name', type: 'text', value: w.name || '', placeholder: i === 0 ? 'Départ' : isEnd ? 'Arrivée' : `Étape ${i}`,
        'aria-label': `Nom du point ${i + 1}`, onchange: (e) => app.actions.renameWaypoint(w.id, e.target.value),
      }),
      h('small', {}, at.has(w.id) ? `km ${fmtKm(at.get(w.id)).replace(' km', '')}` : '',
        w.straight ? ' · ligne droite vers le suivant' : '',
        doc.fixedLegs?.[w.id] ? ' · trace importée vers le suivant' : '')),
    h('div', { class: 'wp-actions' },
      h('button', { class: 'btn icon sm', title: 'Monter', 'aria-label': 'Monter', disabled: i === 0, onclick: () => app.actions.reorder(i, i - 1) }, '↑'),
      h('button', { class: 'btn icon sm', title: 'Descendre', 'aria-label': 'Descendre', disabled: i === wps.length - 1, onclick: () => app.actions.reorder(i, i + 1) }, '↓'),
      h('button', { class: 'btn icon sm danger', title: 'Supprimer', 'aria-label': 'Supprimer', onclick: () => app.actions.deleteWaypoint(w.id) }, '✕')));
    return li;
  });
  const direct = wps.length > 1 ? distance(wps[0], wps[wps.length - 1]) : 0;
  return section('Points de passage',
    h('ol', { class: 'wp-list' }, items),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn sm', onclick: () => app.actions.reverse() }, '⇄ Inverser'),
      h('button', { class: 'btn sm', onclick: () => app.map.fitRoute(app.store.runtime.route, wps) }, '⤢ Recentrer'),
      h('button', { class: 'btn sm danger', onclick: () => app.actions.clear() }, '🗑 Tout effacer')),
    wps.length > 1 && doc.mode === 'oneway' ? h('p', { class: 'hint' }, `Départ ↔ arrivée à vol d’oiseau : ${fmtDist(direct)}`) : null);
}

function statsSection(route, runtime, app) {
  const t = route?.totals;
  const status = runtime.routing
    ? h('p', { class: 'status loading' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Calcul de l’itinéraire…')
    : null;
  if (!t) return section('Statistiques', status || h('p', { class: 'empty' }, 'Aucun itinéraire calculé.'));
  const card = (label, value, title) => h('div', { class: 'stat', title: title || '' }, h('span', { class: 'stat-v' }, value), h('span', { class: 'stat-l' }, label));
  const speed = app.settings.get('speed');
  return section('Statistiques', status,
    h('div', { class: 'stats' },
      card('Distance', fmtKm(t.distance)),
      card('Dénivelé +', t.hasElevation ? fmtM(t.ascent) : '–'),
      card('Dénivelé −', t.hasElevation ? fmtM(t.descent) : '–'),
      card('Temps estimé', fmtDuration(t.time), speed ? `Vitesse à plat réglée à ${speed} km/h` : 'Selon le profil (modifiable dans les réglages)'),
      card('Altitude min / max', t.hasElevation ? `${fmtM(t.minEle)} / ${fmtM(t.maxEle)}` : '–'),
      card('Pente max', t.hasElevation ? `${Math.round(t.maxGrade)} %` : '–')));
}

function bar(title, defs, values, total) {
  const segs = defs.map((d, i) => ({ ...d, v: values[i] })).filter((d) => d.v > 0);
  return h('div', { class: 'breakdown' },
    h('h4', {}, title),
    h('div', { class: 'bar', role: 'img', 'aria-label': segs.map((s) => `${s.label} ${fmtPct(s.v, total)}`).join(', ') },
      segs.map((s) => h('span', { style: { width: `${(s.v / total) * 100}%`, background: s.color }, title: `${s.label} : ${fmtPct(s.v, total)}` }))),
    h('ul', { class: 'legend' }, segs.map((s) => h('li', {},
      h('i', { style: { background: s.color } }), `${s.label} `, h('b', {}, fmtPct(s.v, total)), h('small', {}, ` ${fmtKm(s.v)}`)))));
}

function breakdownSection(route) {
  if (!route?.totals?.distance) return h('div');
  const total = route.totals.distance;
  return section('Répartition',
    bar('Surface', SURFACES, route.breakdown.surface, total),
    bar('Type de voie', WAY_TYPES, route.breakdown.way, total),
    bar('Difficulté', DIFFICULTIES, route.breakdown.difficulty, total));
}

function alertsSection(alerts, app) {
  if (!alerts.length) return h('div');
  const icon = { danger: '⛔', warning: '⚠️', info: 'ℹ️' };
  return section('Alertes',
    h('ul', { class: 'alerts' }, alerts.map((a) => h('li', { class: `alert alert-${a.level}` },
      h('span', { 'aria-hidden': 'true' }, icon[a.level]), ' ',
      a.at != null
        ? h('button', { class: 'btn link', title: 'Voir sur la carte', onclick: () => app.actions.focusDistance(a.at) }, a.text)
        : a.text))));
}
