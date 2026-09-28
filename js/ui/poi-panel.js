/**
 * Onglet « Points d'intérêt » et fiches POI (liste + bulles de la carte).
 */
import { POI_CATEGORIES, OSM_TYPE_LABELS, DEFAULTS } from '../config.js';
import { h, fmtKm, fmtDist } from './dom.js';

const DAYS = { Mo: 'lun', Tu: 'mar', We: 'mer', Th: 'jeu', Fr: 'ven', Sa: 'sam', Su: 'dim', PH: 'jours fériés', SH: 'vacances scolaires' };

/** Rend lisible une valeur OSM opening_hours (traduction simple, sans interprétation). */
export function formatOpeningHours(v) {
  if (!v) return '';
  if (v.trim() === '24/7') return 'Ouvert 24 h/24, 7 j/7';
  return v
    .replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)\b/g, (d) => DAYS[d])
    .replace(/\boff\b/gi, 'fermé')
    .replace(/\bclosed\b/gi, 'fermé')
    .replace(/;\s*/g, ' ; ')
    .replace(/(\d{2}):(\d{2})/g, '$1h$2');
}

export const poiTypeLabel = (poi) => OSM_TYPE_LABELS[poi.kind] || poi.kind || POI_CATEGORIES.find((c) => c.id === poi.cat)?.label;

/** Contenu détaillé d'un POI (bulle de carte). */
export function poiCard(poi, app) {
  const t = poi.tags || {};
  const cat = POI_CATEGORIES.find((c) => c.id === poi.cat);
  const selected = !!app.store.doc.selectedPois[poi.id];
  const website = t.website || t['contact:website'];
  const phone = t.phone || t['contact:phone'];
  return h('div', { class: 'poi-card' },
    h('div', { class: 'poi-title' }, h('span', { 'aria-hidden': 'true' }, cat?.icon || '•'), ' ', h('b', {}, poi.name || poiTypeLabel(poi))),
    h('div', { class: 'muted' }, poiTypeLabel(poi)),
    poi.along != null ? h('div', {}, `km ${fmtKm(poi.along).replace(' km', '')} · à ${fmtDist(poi.dist)} du tracé`) : null,
    t.opening_hours ? h('div', { class: 'hours' }, '🕒 ', formatOpeningHours(t.opening_hours)) : null,
    t.drinking_water === 'no' ? h('div', { class: 'warn' }, 'Eau non potable') : null,
    t.seasonal === 'yes' ? h('div', { class: 'warn' }, 'Saisonnier') : null,
    phone ? h('div', {}, '📞 ', h('a', { href: `tel:${phone.replace(/\s+/g, '')}` }, phone)) : null,
    website ? h('div', { class: 'ellipsis' }, '🌐 ', h('a', { href: /^https?:/.test(website) ? website : `https://${website}`, target: '_blank', rel: 'noopener' }, website.replace(/^https?:\/\//, ''))) : null,
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn sm primary', onclick: () => app.actions.addPoiAsWaypoint(poi) }, '➕ Ajouter comme étape'),
      h('button', { class: `btn sm${selected ? ' active' : ''}`, 'aria-pressed': String(selected), onclick: () => app.actions.togglePoiSelected(poi) },
        selected ? '✓ Dans le GPX' : '☐ Inclure au GPX')),
    h('a', { class: 'osm-link', href: `https://www.openstreetmap.org/${poi.id}`, target: '_blank', rel: 'noopener' }, 'Voir sur OpenStreetMap'));
}

export function renderPoiPanel(el, app) {
  const { doc, runtime } = app.store;
  const pois = runtime.pois || [];
  const counts = Object.fromEntries(POI_CATEGORIES.map((c) => [c.id, 0]));
  for (const p of pois) counts[p.cat]++;
  const filter = app.ui.poiFilter || 'all';
  const radiusOut = h('output', {}, fmtDist(doc.poi.radius));
  const hasRoute = runtime.route?.points?.length > 1;

  const controls = h('section', { class: 'block' },
    h('h3', {}, 'Recherche le long du parcours'),
    h('div', { class: 'pref' },
      h('div', { class: 'pref-head' }, h('span', {}, 'Rayon autour du tracé'), radiusOut),
      h('input', {
        type: 'range', min: DEFAULTS.poiRadiusMin, max: DEFAULTS.poiRadiusMax, step: 100, value: doc.poi.radius,
        'aria-label': 'Rayon autour du tracé',
        oninput: (e) => { radiusOut.textContent = fmtDist(Number(e.target.value)); },
        onchange: (e) => app.actions.setPoiRadius(Number(e.target.value)),
      })),
    h('div', { class: 'cats' }, POI_CATEGORIES.map((c) => h('label', { class: 'cat', style: { '--c': c.color } },
      h('input', { type: 'checkbox', checked: !!doc.poi.categories[c.id], onchange: (e) => app.actions.setPoiCategory(c.id, e.target.checked) }),
      h('span', { 'aria-hidden': 'true' }, c.icon), ` ${c.label}`,
      doc.poi.categories[c.id] && counts[c.id] ? h('span', { class: 'badge' }, counts[c.id]) : null))),
    h('label', { class: 'row' },
      h('input', { type: 'checkbox', checked: !!doc.poi.auto, onchange: (e) => app.actions.setPoiAuto(e.target.checked) }),
      ' Mettre à jour automatiquement quand le tracé change'),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn primary', disabled: !hasRoute || runtime.poiLoading, onclick: () => app.actions.refreshPois(true) },
        runtime.poiLoading ? 'Recherche…' : '🔎 Rechercher les POI')),
    runtime.poiLoading && runtime.poiProgress
      ? h('progress', { max: runtime.poiProgress.total || 1, value: runtime.poiProgress.done }) : null,
    runtime.poiStale && !runtime.poiLoading ? h('p', { class: 'hint warn' }, 'Le tracé a changé depuis la dernière recherche.') : null,
    runtime.poiError ? h('p', { class: 'hint error' }, runtime.poiError) : null,
    h('p', { class: 'hint' }, 'Données © contributeurs OpenStreetMap via l’API Overpass. Résultats mis en cache 24 h pour ménager le service.'));

  const selectedCount = Object.keys(doc.selectedPois).length;
  const shown = pois.filter((p) => doc.poi.categories[p.cat])
    .filter((p) => filter === 'all' || (filter === 'selected' ? doc.selectedPois[p.id] : p.cat === filter));
  const list = h('section', { class: 'block' },
    h('div', { class: 'list-head' },
      h('h3', {}, `Résultats (${shown.length})`),
      h('select', { 'aria-label': 'Filtrer', onchange: (e) => { app.ui.poiFilter = e.target.value; app.render(); } },
        h('option', { value: 'all', selected: filter === 'all' }, 'Toutes catégories'),
        h('option', { value: 'selected', selected: filter === 'selected' }, `Sélectionnés pour le GPX (${selectedCount})`),
        POI_CATEGORIES.filter((c) => doc.poi.categories[c.id]).map((c) => h('option', { value: c.id, selected: filter === c.id }, `${c.icon} ${c.label}`)))),
    shown.length
      ? h('ul', { class: 'poi-list' }, shown.slice(0, 400).map((p) => poiRow(p, app)))
      : h('p', { class: 'empty' }, hasRoute ? 'Aucun point d’intérêt à afficher.' : 'Tracez un itinéraire pour rechercher des points d’intérêt.'),
    shown.length > 400 ? h('p', { class: 'hint' }, `400 premiers résultats affichés sur ${shown.length}.`) : null);
  el.replaceChildren(controls, list);
}

function poiRow(p, app) {
  const cat = POI_CATEGORIES.find((c) => c.id === p.cat);
  const sel = !!app.store.doc.selectedPois[p.id];
  return h('li', { class: 'poi-row' },
    h('button', { class: 'poi-main', onclick: () => app.map.openPoi(p), title: 'Voir sur la carte' },
      h('span', { class: 'poi-ico', style: { '--c': cat.color }, 'aria-hidden': 'true' }, cat.icon),
      h('span', { class: 'poi-text' },
        h('b', {}, p.name || poiTypeLabel(p)),
        h('small', {}, `${p.name ? `${poiTypeLabel(p)} · ` : ''}km ${fmtKm(p.along).replace(' km', '')} · ${fmtDist(p.dist)}`),
        p.tags?.opening_hours ? h('small', { class: 'hours' }, `🕒 ${formatOpeningHours(p.tags.opening_hours)}`) : null)),
    h('div', { class: 'poi-actions' },
      h('button', { class: 'btn icon sm', title: 'Ajouter comme étape', 'aria-label': 'Ajouter comme étape', onclick: () => app.actions.addPoiAsWaypoint(p) }, '➕'),
      h('button', {
        class: `btn icon sm${sel ? ' active' : ''}`, title: sel ? 'Retirer du GPX' : 'Inclure dans le GPX', 'aria-pressed': String(sel),
        onclick: () => app.actions.togglePoiSelected(p),
      }, sel ? '✓' : '☐')));
}
