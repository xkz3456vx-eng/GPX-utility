/**
 * Onglets « Projets » (sauvegarde locale) et « Réglages ».
 */
import { PROFILES, SERVICES } from '../config.js';
import { h, fmtKm } from './dom.js';
import { listProjects } from '../io/storage.js';
import { poiCacheSize } from '../services/overpass.js';

const dateFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

export function renderProjectsPanel(el, app) {
  const projects = listProjects();
  const currentId = app.store.runtime.projectId;
  el.replaceChildren(
    h('section', { class: 'block' },
      h('h3', {}, 'Projet en cours'),
      h('p', {}, h('b', {}, app.store.doc.name), currentId ? ' (enregistré)' : ' (non enregistré)'),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn primary', onclick: () => app.actions.saveProject(false) }, '💾 Enregistrer'),
        h('button', { class: 'btn', onclick: () => app.actions.saveProject(true) }, 'Enregistrer une copie'),
        h('button', { class: 'btn', onclick: () => app.actions.newProject() }, '＋ Nouveau')),
      h('p', { class: 'hint' }, 'Les projets sont stockés uniquement dans ce navigateur (localStorage). Utilisez « Partager » ou l’export GPX pour les transférer.')),
    h('section', { class: 'block' },
      h('h3', {}, `Mes projets (${projects.length})`),
      projects.length
        ? h('ul', { class: 'project-list' }, projects.map((p) => h('li', { class: `project${p.id === currentId ? ' current' : ''}` },
          h('button', { class: 'project-main', onclick: () => app.actions.openProject(p.id) },
            h('b', {}, p.name),
            h('small', {}, [
              PROFILES[p.profile]?.label,
              p.distance ? fmtKm(p.distance) : null,
              p.ascent ? `D+ ${Math.round(p.ascent)} m` : null,
              dateFmt.format(new Date(p.updated)),
            ].filter(Boolean).join(' · '))),
          h('div', { class: 'wp-actions' },
            h('button', { class: 'btn icon sm', title: 'Renommer', 'aria-label': 'Renommer', onclick: () => app.actions.renameProject(p.id, p.name) }, '✎'),
            h('button', { class: 'btn icon sm danger', title: 'Supprimer', 'aria-label': 'Supprimer', onclick: () => app.actions.deleteProject(p.id, p.name) }, '✕')))))
        : h('p', { class: 'empty' }, 'Aucun projet enregistré.')));
}

export function renderSettingsPanel(el, app) {
  const s = app.settings.all();
  const field = (label, key, attrs = {}, hint = '') => h('label', { class: 'field' },
    h('span', {}, label),
    h('input', {
      value: s[key] ?? '', ...attrs,
      onchange: (e) => app.actions.setSetting(key, attrs.type === 'number' ? Number(e.target.value) || 0 : e.target.value.trim()),
    }),
    hint ? h('small', { class: 'hint' }, hint) : null);
  const profile = PROFILES[app.store.doc.profile];
  el.replaceChildren(
    h('section', { class: 'block' },
      h('h3', {}, 'Services'),
      field('URL de l’instance BRouter', 'brouterUrl', { type: 'url', placeholder: SERVICES.brouter.url },
        'Instance publique par défaut ; indiquez ici votre instance auto-hébergée (ex. http://localhost:17777/brouter).'),
      field('URL du serveur Overpass', 'overpassUrl', { type: 'url', placeholder: SERVICES.overpass.urls[0] }),
      field('Clé API Thunderforest (optionnelle)', 'thunderforestKey', { type: 'text', autocomplete: 'off', spellcheck: false },
        'Active les fonds « Outdoors » et « OpenCycleMap ». Clé gratuite sur thunderforest.com.'),
      field('E-mail de contact (optionnel)', 'contactEmail', { type: 'email' },
        'Transmis à Nominatim comme le recommande sa politique d’usage.')),
    h('section', { class: 'block' },
      h('h3', {}, 'Estimations et alertes'),
      field('Vitesse moyenne à plat (km/h)', 'speed', { type: 'number', min: 0, max: 60, step: 0.5, placeholder: String(profile.speed) },
        `0 = valeur du profil (${profile.speed} km/h pour « ${profile.label} »).`),
      field('Alerte « pas de point d’eau » au-delà de (km)', 'waterGapKm', { type: 'number', min: 0, max: 300, step: 1, placeholder: String(profile.waterGapKm) },
        `0 = valeur du profil (${profile.waterGapKm} km).`)),
    h('section', { class: 'block' },
      h('h3', {}, 'Cache et données'),
      h('p', { class: 'hint' }, `Cache des POI : ${(poiCacheSize() / 1024).toFixed(0)} Ko.`),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', onclick: () => app.actions.clearCaches() }, 'Vider les caches'),
        h('button', { class: 'btn danger', onclick: () => app.actions.resetSettings() }, 'Réinitialiser les réglages'))),
    h('section', { class: 'block about' },
      h('h3', {}, 'À propos'),
      h('p', {}, 'Calcul d’itinéraire : ', h('a', { href: 'https://brouter.de', target: '_blank', rel: 'noopener' }, 'BRouter'),
        '. Données cartographiques : © ', h('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener' }, 'contributeurs OpenStreetMap'),
        '. Recherche de lieux : Nominatim. POI : Overpass API.'),
      h('p', { class: 'hint' }, 'Raccourcis : Ctrl+Z annuler, Ctrl+Y rétablir, Suppr supprime le dernier point.')));
}
