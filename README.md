# Planificateur GPX – un BRouter amélioré

Application web statique pour **planifier des itinéraires vélo et randonnée** et les **exporter en GPX** : calcul d'itinéraire BRouter, profils adaptés (route, gravel, VTT, trekking, randonnée…), tracé coloré par surface / difficulté / pente, points d'eau et ravitaillements le long du parcours (OpenStreetMap), profil altimétrique interactif, alertes, sauvegarde locale et partage par lien.

Aucun backend : tout tourne dans le navigateur. Architecture détaillée : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Fonctionnalités

- **Itinéraire** : clic sur la carte pour ajouter un point, glisser pour le déplacer, glisser le tracé pour insérer une étape, clic droit (ou bouton ✕) pour supprimer, réordonnancement par glisser-déposer ou flèches, aller simple / boucle / aller-retour, inversion, annuler/rétablir (Ctrl+Z / Ctrl+Y), segment en ligne droite optionnel.
- **Recalcul automatique** à chaque modification, tronçon par tronçon (seuls les tronçons modifiés sont recalculés) ; un point hors réseau ou une API indisponible est signalé et le tronçon s'affiche en pointillé.
- **Profils** : Vélo de route, Gravel, VTT, Trekking, Vélo urbain, Randonnée (+ profil BRouter personnalisé) ; curseurs éviter le trafic, pistes cyclables, tolérance au non-goudronné, dénivelé maximum.
- **Tracé coloré** par surface (asphalte, gravier, terre, sentier), type de voie, difficulté ou pente, avec répartition en %.
- **Points d'intérêt** (Overpass) dans un couloir de 200 m à 2 km : points d'eau, commerces alimentaires, hébergements, cafés/restaurants, toilettes, réparation vélo, gares. Nom, distance au tracé, kilométrage, horaires, bouton « ajouter comme étape », sélection pour l'export. Cache 24 h.
- **Statistiques** : distance, D+/D−, altitudes, pente max, temps estimé selon le profil ; **alertes** « aucun point d'eau sur les X prochains km », commerces, montées raides, dénivelé max dépassé.
- **Profil altimétrique** synchronisé avec la carte, sélection d'une portion pour en obtenir les statistiques.
- **Import / export GPX** (trace, étapes, POI sélectionnés) ; l'import peut conserver la trace, la recalculer via BRouter ou n'en garder que les points.
- **Projets** enregistrés dans le navigateur, sauvegarde automatique, **lien de partage** autonome.
- Interface **responsive** en français ; fonds OSM, OpenTopoMap, CyclOSM, IGN Plan / photos, Thunderforest (avec clé), surcouches Waymarked Trails.

## Démarrage local

Les modules ES exigent un serveur HTTP (l'ouverture directe de `index.html` en `file://` ne fonctionne pas) :

```bash
python3 -m http.server 8080
# ou
npx http-server -p 8080 -c-1 .
```

Puis ouvrir <http://localhost:8080>.

Tests unitaires (Node ≥ 20, aucune dépendance) :

```bash
npm test
```

## Déploiement

L'application est un simple dossier de fichiers statiques : `index.html`, `css/`, `js/`. Aucune compilation.

### GitHub Pages (recommandé)

Le dépôt contient le workflow `.github/workflows/pages.yml` qui publie le site à chaque push sur `main` :

1. Fusionner la branche dans `main`.
2. Dans le dépôt GitHub : **Settings → Pages → Build and deployment → Source : « GitHub Actions »**.
3. Lancer le workflow (onglet **Actions → Déployer sur GitHub Pages → Run workflow**) ou pousser sur `main`.
4. Le site est disponible sur `https://<utilisateur>.github.io/<dépôt>/`.

Alternative sans workflow : Settings → Pages → Source « Deploy from a branch », branche `main`, dossier `/ (root)` (le fichier `.nojekyll` est déjà présent).

### Netlify, Vercel, Cloudflare Pages

Importer le dépôt, **commande de build : aucune**, **dossier publié : `.`** (racine).

### Serveur personnel (Nginx, Apache, Caddy…)

Copier `index.html`, `css/` et `js/` dans la racine web. Exemple Nginx :

```nginx
server {
  listen 443 ssl;
  server_name gpx.example.org;
  root /var/www/gpx-planner;
  location / { try_files $uri $uri/ /index.html; }
  location ~* \.(js|css)$ { add_header Cache-Control "public, max-age=3600"; }
}
```

Servir en **HTTPS** (requis pour la géolocalisation et le presse-papiers).

## Configuration

Tout est centralisé dans [`js/config.js`](js/config.js) :

| Clé | Rôle |
|---|---|
| `SERVICES.brouter.url` | Instance BRouter (par défaut `https://brouter.de/brouter`) |
| `SERVICES.overpass.urls` | Serveurs Overpass (principal + secours) |
| `SERVICES.*.concurrency / minIntervalMs` | Limitation de fréquence |
| `API_KEYS.thunderforest` | Clé Thunderforest (fonds Outdoors / OpenCycleMap) |
| `APP.contactEmail` | E-mail transmis à Nominatim |
| `PROFILES` | Profils de l'interface → profils BRouter, vitesses, seuils d'alerte eau |
| `PREFERENCES` | Curseurs → paramètres `profile:…` envoyés à BRouter |
| `POI_CATEGORIES` | Catégories de POI et filtres Overpass |
| `BASE_LAYERS`, `OVERLAYS` | Fonds de carte |

Les principaux réglages (URL BRouter/Overpass, clé Thunderforest, e-mail, vitesse, seuil d'alerte eau) sont aussi modifiables **dans l'onglet ⚙️ Réglages**, stockés dans le navigateur de l'utilisateur. Ne mettez pas dans `config.js` de clé que vous ne voulez pas rendre publique : un site statique expose tout son code.

### Instance BRouter auto-hébergée

Pour ne pas dépendre de `brouter.de` (quotas, disponibilité) :

```bash
git clone https://github.com/abrensch/brouter.git && cd brouter
./gradlew clean build
# Télécharger les segments de la zone voulue (5°×5°) depuis https://brouter.de/brouter/segments4/
mkdir -p misc/segments4 && cd misc/segments4
wget https://brouter.de/brouter/segments4/E5_N45.rd5
cd ../..
./misc/scripts/standalone/server.sh     # écoute sur le port 17777
```

Une image Docker est également fournie par le projet (voir son README). Renseignez ensuite `http://localhost:17777/brouter` (ou l'URL publique derrière un reverse proxy HTTPS) dans **Réglages → URL de l'instance BRouter**. Le serveur BRouter renvoie l'en-tête CORS `Access-Control-Allow-Origin: *` ; si vous le placez derrière un proxy, conservez-le. Pour disposer des profils `gravel`, `mtb`, `hiking-mountain`…, copiez les fichiers `.brf` voulus dans `misc/profiles2/` (les profils absents sont automatiquement remplacés par leur repli).

## Conditions d'utilisation des services

- [BRouter](https://brouter.de) : instance publique gratuite et bénévole, à utiliser avec modération ; auto-hébergez pour un usage intensif.
- [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) : ~10 000 requêtes/jour et 1 Go/jour par utilisateur ; l'application met en cache et limite ses requêtes.
- [Nominatim](https://operations.osmfoundation.org/policies/nominatim/) : 1 requête/s maximum, pas d'autocomplétion.
- [Tuiles OpenStreetMap](https://operations.osmfoundation.org/policies/tiles/) : usage modéré, attribution obligatoire ; pour un site à fort trafic, utilisez un fournisseur de tuiles dédié.
- Données © contributeurs OpenStreetMap, licence ODbL.
