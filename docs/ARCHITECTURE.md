# Architecture du Planificateur GPX

Application web **100 % statique** (HTML/CSS/JavaScript, modules ES natifs, aucune étape de build, aucun backend). Elle s'héberge sur n'importe quel serveur de fichiers (GitHub Pages, Netlify, Nginx…) et dialogue directement, depuis le navigateur, avec des API publiques compatibles CORS.

## 1. Vue d'ensemble

```
┌──────────────────────────── Navigateur ────────────────────────────┐
│                                                                    │
│  index.html + css/style.css                                        │
│        │                                                           │
│   js/main.js  ── orchestrateur : actions, calcul, rendu            │
│        │                                                           │
│  ┌─────┴──────┐   ┌──────────────┐   ┌───────────────┐            │
│  │ core/      │   │ services/    │   │ analysis/     │            │
│  │ store      │   │ brouter  ────┼──►│ route-analysis│            │
│  │ route-     │──►│ overpass ────┼──►│ alerts        │            │
│  │  builder   │   │ nominatim    │   └───────────────┘            │
│  │ geo, cache │   └──────┬───────┘                                │
│  │ http,      │          │ fetch (file d'attente, cache, retry)    │
│  │ settings   │          ▼                                        │
│  └────────────┘   ┌──────────────┐   ┌───────────────┐            │
│                   │ io/          │   │ ui/           │            │
│                   │ gpx, storage │   │ map (Leaflet) │            │
│                   └──────────────┘   │ elevation-chart│           │
│                                      │ *-panel        │           │
│                                      └───────────────┘            │
└──────────────┬──────────────┬──────────────┬───────────────────────┘
               ▼              ▼              ▼
        BRouter (routage) Overpass (POI)  Nominatim (recherche)
        + tuiles OSM / OpenTopoMap / CyclOSM / IGN / Thunderforest
```

## 2. Choix techniques

| Sujet | Choix | Raison |
|---|---|---|
| Carte | **Leaflet 1.9** (CDN unpkg, avec SRI) | Léger, robuste sur mobile, fonds raster OSM/topo simples à ajouter. |
| Code | JavaScript ES2022 en modules natifs | Pas de build : on dépose les fichiers et ça marche. |
| Graphique | Canvas maison (`ui/elevation-chart.js`) | Aucune dépendance, rendu rapide même avec 50 000 points (échantillonnage par pixel). |
| État | Store minimaliste (`core/store.js`) | Un document sérialisable + historique annuler/rétablir. |
| Persistance | `localStorage` | Projets, sauvegarde automatique, cache Overpass, réglages. |
| Partage | État compressé (deflate-raw) en base64url dans le fragment `#r=` | Rien n'est envoyé à un serveur ; le lien suffit. |

## 3. Modules

| Fichier | Rôle |
|---|---|
| `js/config.js` | **Configuration centrale** : URL des services, clés API, limites de fréquence, fonds de carte, profils (mapping vers BRouter), curseurs de préférences → paramètres BRouter, catégories de POI (filtres Overpass), couleurs. |
| `js/core/store.js` | Document éditable (`waypoints`, `mode`, `profile`, `prefs`, `fixedLegs`, `selectedPois`, `poi`) + données d'exécution (tracé calculé, POI, états). Historique annuler/rétablir. |
| `js/core/route-builder.js` | Découpe l'itinéraire en **tronçons** (point i → i+1, + retour en boucle), calcule chacun (BRouter, ligne droite ou géométrie importée), les concatène ; gère l'aller-retour. |
| `js/core/geo.js` | Géométrie pure : haversine, simplification Douglas-Peucker, index spatial de polyligne (distance d'un POI au tracé), encodage polyline. |
| `js/core/http.js` | File d'attente limitant la concurrence et l'intervalle entre requêtes, délai maximal, nouvelles tentatives (429/5xx, `Retry-After`). |
| `js/core/cache.js` | Cache LRU avec durée de vie, en mémoire et/ou `localStorage`, résistant au quota plein. |
| `js/core/settings.js` | Réglages utilisateur surchargeant `config.js` (URL BRouter auto-hébergée, clés API…). |
| `js/services/brouter.js` | Client BRouter : construction de l'URL, profils de repli, lecture du GeoJSON et des `messages` (tags OSM par portion), traduction des erreurs (point hors réseau, profil inconnu, service indisponible…). |
| `js/services/overpass.js` | Requêtes Overpass `around` le long du tracé simplifié, par tronçon et par morceaux ≤ 80 km, cache 24 h, serveur de secours. |
| `js/services/nominatim.js` | Recherche de lieux (1 requête/s, pas d'autocomplétion, conformément à la politique d'usage). |
| `js/analysis/route-analysis.js` | Surfaces (asphalte / gravier / terre / sentier), type de voie, difficulté (tags `sac_scale`, `mtb:scale`, `smoothness`, `tracktype` + pente), pentes lissées, D+/D− avec hystérésis, temps estimé. |
| `js/analysis/alerts.js` | Alertes : « aucun point d'eau sur X km », commerces, dénivelé max dépassé, montées raides, tronçons en erreur. |
| `js/io/gpx.js` | Export GPX 1.1 (trace + étapes + POI avec description/horaires) et import (trk, rte, wpt). |
| `js/io/storage.js` | Projets locaux, sauvegarde automatique, encodage/décodage des liens de partage. |
| `js/ui/map.js` | Carte, couches, marqueurs déplaçables, tracé coloré, « glisser le tracé pour insérer une étape », curseur synchronisé. |
| `js/ui/elevation-chart.js` | Profil altimétrique : survol ↔ carte, sélection d'une portion (stats), clic pour centrer. |
| `js/ui/*-panel.js` | Onglets Itinéraire, Points d'intérêt, Projets, Réglages. |
| `js/main.js` | Démarrage, liaison des événements, actions, planification des calculs. |

## 4. Flux de données

1. Toute modification (clic carte, glisser un point, curseur…) passe par une **action** de `main.js` → `store.update()` (historisé) → événement `doc`.
2. `doc` déclenche (avec anti-rebond 200 ms) `computeRoute()` :
   - chaque tronçon est une requête BRouter distincte, **mise en cache** par (instance, profil, paramètres, extrémités) : déplacer un point ne recalcule que les 2 tronçons voisins ;
   - un tronçon en échec (point hors réseau, API indisponible) est dessiné en **pointillé rouge** et signalé, sans bloquer le reste.
3. Le tracé assemblé passe par `analyzeRoute()` → carte, profil, statistiques, répartitions.
4. Si la mise à jour automatique des POI est active (anti-rebond 1,5 s), `fetchPoisAlong()` interroge Overpass tronçon par tronçon (cache), puis chaque POI est projeté sur le tracé (distance, kilométrage).
5. `computeAlerts()` combine tracé et POI.
6. Le document est sauvegardé automatiquement (restauré au rechargement).

## 5. Profils et préférences

| Profil de l'interface | Profils BRouter essayés (repli) | Vitesse à plat |
|---|---|---|
| Vélo de route | `fastbike` | 25 km/h |
| Gravel | `gravel` → `trekking` | 20 km/h |
| VTT | `mtb` → `mtb-zossebart` → `trekking` | 15 km/h |
| Vélo de trekking | `trekking` | 18 km/h |
| Vélo urbain (sécurité) | `safety` → `trekking` | 16 km/h |
| Randonnée à pied | `hiking-mountain` → `hiking-beta` → `shortest` | 4,5 km/h (DIN 33466) |

Un **profil personnalisé** (n'importe quel nom de profil présent sur l'instance) peut être saisi.

Les curseurs sont traduits en paramètres `profile:<variable>=<valeur>` ajoutés à l'URL BRouter (`consider_traffic`, `avoid_unsafe`, `stick_to_cycleroutes`, `ignore_cycleroutes`, `avoid_unpaved`, `consider_elevation`…). Un profil qui ne déclare pas une variable l'ignore : l'effet dépend donc du profil. Le mapping se modifie dans `PREFERENCES` (`config.js`). Le dénivelé maximum active en plus une alerte.

## 6. Respect des services publics

- **BRouter** : ≤ 2 requêtes simultanées, 250 ms minimum entre deux requêtes, cache des tronçons, anti-rebond, annulation des calculs obsolètes. Instance auto-hébergée configurable.
- **Overpass** : 1 requête à la fois, 1,5 s d'intervalle, tracé simplifié (≤ 150 sommets par requête), cache persistant 24 h, requêtes regroupées par clé OSM, serveur de secours sur 429/5xx.
- **Nominatim** : 1 requête/s, uniquement à la validation, cache 7 jours, paramètre `email` configurable.
- **Tuiles** : attribution affichée pour chaque fond.
- **User-Agent** : les navigateurs interdisent de le modifier ; les services identifient l'application par l'en-tête `Referer` (envoyé automatiquement) et, pour Nominatim, par l'e-mail de contact.

## 7. Limites connues

- Les altitudes et surfaces d'une trace importée « telle quelle » proviennent du fichier (les surfaces sont alors « inconnues »).
- Les horaires d'ouverture sont affichés (traduits) mais pas interprétés (« ouvert maintenant »).
- L'aller-retour reprend le même chemin en sens inverse (pas de recalcul du retour).
