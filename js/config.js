/**
 * Configuration centrale de l'application.
 *
 * Tout ce qui dépend d'un service externe (URL, clés API, limites de fréquence,
 * profils BRouter) est regroupé ici. Les valeurs peuvent être surchargées à
 * l'exécution depuis l'onglet « Réglages » (stockées dans le localStorage du
 * navigateur), sans modifier ce fichier.
 */

export const APP = {
  name: 'Planificateur GPX',
  version: '1.0.0',
  /** Identifiant envoyé aux services qui l'acceptent (Nominatim : paramètre `email`). */
  contactEmail: '',
  /** Préfixe des clés localStorage. */
  storagePrefix: 'gpxp:',
};

export const SERVICES = {
  brouter: {
    /** Instance publique par défaut. Remplacez par votre instance auto-hébergée si besoin. */
    url: 'https://brouter.de/brouter',
    timeoutMs: 60000,
    /** Limitation de fréquence : requêtes simultanées et intervalle minimal (ms). */
    concurrency: 2,
    minIntervalMs: 250,
  },
  overpass: {
    /** Le premier serveur est utilisé ; les suivants servent de secours en cas d'erreur 429/5xx. */
    urls: [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
    ],
    timeoutS: 60,
    concurrency: 1,
    minIntervalMs: 1500,
    /** Durée de vie du cache des POI (ms). */
    cacheTtlMs: 24 * 3600 * 1000,
    /** Longueur maximale d'un morceau de tracé par requête (km). */
    chunkKm: 80,
  },
  nominatim: {
    url: 'https://nominatim.openstreetmap.org/search',
    /** Politique d'usage Nominatim : 1 requête / seconde maximum, pas d'autocomplétion. */
    minIntervalMs: 1100,
  },
};

/** Clés API optionnelles (renseignables aussi dans l'onglet Réglages). */
export const API_KEYS = {
  thunderforest: '',
};

const OSM_ATTR = '&copy; contributeurs <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

/**
 * Fonds de carte. `requiresKey` : la couche n'est proposée que si la clé est renseignée.
 * `{apikey}` est remplacé par la clé correspondante.
 */
export const BASE_LAYERS = [
  {
    id: 'osm',
    label: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 19, attribution: OSM_ATTR },
  },
  {
    id: 'opentopomap',
    label: 'OpenTopoMap (topo)',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 17, subdomains: 'abc', attribution: `${OSM_ATTR}, SRTM | style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)` },
  },
  {
    id: 'cyclosm',
    label: 'CyclOSM (vélo)',
    url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
    options: { maxZoom: 20, subdomains: 'abc', attribution: `${OSM_ATTR} | <a href="https://www.cyclosm.org">CyclOSM</a>` },
  },
  {
    id: 'ign-plan',
    label: 'IGN Plan (France)',
    url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png',
    options: { maxZoom: 19, attribution: '&copy; <a href="https://www.ign.fr">IGN</a> – Géoplateforme' },
  },
  {
    id: 'ign-ortho',
    label: 'IGN Photos aériennes',
    url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg',
    options: { maxZoom: 19, attribution: '&copy; <a href="https://www.ign.fr">IGN</a> – Géoplateforme' },
  },
  {
    id: 'tf-outdoors',
    label: 'Thunderforest Outdoors',
    requiresKey: 'thunderforest',
    url: 'https://{s}.tile.thunderforest.com/outdoors/{z}/{x}/{y}.png?apikey={apikey}',
    options: { maxZoom: 22, subdomains: 'abc', attribution: `${OSM_ATTR} | &copy; <a href="https://www.thunderforest.com">Thunderforest</a>` },
  },
  {
    id: 'tf-cycle',
    label: 'Thunderforest OpenCycleMap',
    requiresKey: 'thunderforest',
    url: 'https://{s}.tile.thunderforest.com/cycle/{z}/{x}/{y}.png?apikey={apikey}',
    options: { maxZoom: 22, subdomains: 'abc', attribution: `${OSM_ATTR} | &copy; <a href="https://www.thunderforest.com">Thunderforest</a>` },
  },
];

export const OVERLAYS = [
  {
    id: 'wmt-cycling',
    label: 'Itinéraires vélo (Waymarked Trails)',
    url: 'https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png',
    options: { maxZoom: 18, opacity: 0.7, attribution: '<a href="https://waymarkedtrails.org">Waymarked Trails</a>' },
  },
  {
    id: 'wmt-hiking',
    label: 'Sentiers balisés (Waymarked Trails)',
    url: 'https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png',
    options: { maxZoom: 18, opacity: 0.7, attribution: '<a href="https://waymarkedtrails.org">Waymarked Trails</a>' },
  },
];

/**
 * Profils proposés à l'utilisateur, mappés sur les profils BRouter.
 * `brouter` : liste de profils essayés dans l'ordre (le suivant sert de repli si
 * l'instance ne connaît pas le précédent).
 * `speed` : vitesse à plat (km/h) ; `vam` : vitesse ascensionnelle (m/h) ;
 * `surfaceFactor` : multiplicateur de vitesse par catégorie de surface
 * [asphalte, gravier, terre, sentier, inconnu] ; `waterGapKm` : seuil d'alerte.
 */
export const PROFILES = {
  route: {
    label: 'Vélo de route', icon: '🚴', activity: 'bike',
    brouter: ['fastbike'],
    speed: 25, vam: 800, surfaceFactor: [1, 0.65, 0.5, 0.35, 0.9], waterGapKm: 60,
  },
  gravel: {
    label: 'Gravel', icon: '🚵', activity: 'bike',
    brouter: ['gravel', 'trekking'],
    speed: 20, vam: 700, surfaceFactor: [1, 0.85, 0.75, 0.55, 0.9], waterGapKm: 40,
  },
  vtt: {
    label: 'VTT', icon: '⛰️', activity: 'bike',
    brouter: ['mtb', 'mtb-zossebart', 'trekking'],
    speed: 15, vam: 600, surfaceFactor: [1, 0.9, 0.85, 0.7, 0.9], waterGapKm: 30,
  },
  trekking: {
    label: 'Vélo de trekking', icon: '🚲', activity: 'bike',
    brouter: ['trekking'],
    speed: 18, vam: 600, surfaceFactor: [1, 0.85, 0.7, 0.5, 0.9], waterGapKm: 40,
  },
  ville: {
    label: 'Vélo urbain (sécurité)', icon: '🏙️', activity: 'bike',
    brouter: ['safety', 'trekking'],
    speed: 16, vam: 500, surfaceFactor: [1, 0.8, 0.65, 0.5, 0.9], waterGapKm: 40,
  },
  rando: {
    label: 'Randonnée à pied', icon: '🥾', activity: 'hike',
    brouter: ['hiking-mountain', 'hiking-beta', 'shortest'],
    speed: 4.5, up: 300, down: 500, surfaceFactor: [1, 1, 1, 0.9, 1], waterGapKm: 15,
  },
};

export const DEFAULT_PROFILE = 'trekking';

/**
 * Curseurs de préférences et leur traduction en paramètres de profil BRouter
 * (transmis dans l'URL sous la forme `profile:<nom>=<valeur>`, cf. doc BRouter).
 * Un profil qui ne définit pas un paramètre l'ignore simplement.
 */
export const PREFERENCES = {
  traffic: {
    label: 'Éviter le trafic', activities: ['bike', 'hike'],
    min: 0, max: 1, step: 0.1, default: 0.5,
    format: (v) => ['Indifférent', 'Un peu', 'Modérément', 'Fortement', 'Au maximum'][Math.round(v * 4)],
    toParams: (v) => ({ consider_traffic: v >= 0.3 ? 1 : 0, avoid_unsafe: v >= 0.7 ? 1 : 0 }),
  },
  cycleways: {
    label: 'Privilégier les pistes / itinéraires cyclables', activities: ['bike'],
    min: 0, max: 1, step: 0.1, default: 0.5,
    format: (v) => ['Ignorer', 'Un peu', 'Normal', 'Beaucoup', 'Uniquement si possible'][Math.round(v * 4)],
    toParams: (v) => ({ ignore_cycleroutes: v < 0.2 ? 1 : 0, stick_to_cycleroutes: v >= 0.8 ? 1 : 0 }),
  },
  unpaved: {
    label: 'Tolérance aux chemins non goudronnés', activities: ['bike', 'hike'],
    min: 0, max: 1, step: 0.1, default: 0.5,
    format: (v) => ['À éviter', 'Faible', 'Moyenne', 'Élevée', 'Recherchés'][Math.round(v * 4)],
    toParams: (v) => ({ avoid_unpaved: v < 0.3 ? 1 : 0, prefer_unpaved: v > 0.8 ? 1 : 0 }),
  },
  maxAscent: {
    label: 'Dénivelé positif maximum', activities: ['bike', 'hike'],
    min: 0, max: 5000, step: 100, default: 0,
    format: (v) => (v === 0 ? 'Illimité' : `${v} m`),
    toParams: (v) => ({ consider_elevation: v > 0 ? 1 : 0 }),
  },
};

/** Catégories de surface (index utilisé dans les tableaux d'analyse). */
export const SURFACES = [
  { id: 'asphalt', label: 'Asphalte', color: '#4b5563' },
  { id: 'gravel', label: 'Gravier / stabilisé', color: '#d97706' },
  { id: 'dirt', label: 'Terre / herbe', color: '#92400e' },
  { id: 'path', label: 'Sentier', color: '#16a34a' },
  { id: 'unknown', label: 'Inconnu', color: '#a1a1aa' },
];

export const DIFFICULTIES = [
  { id: 'easy', label: 'Facile', color: '#16a34a' },
  { id: 'medium', label: 'Modérée', color: '#eab308' },
  { id: 'hard', label: 'Difficile', color: '#dc2626' },
  { id: 'extreme', label: 'Très difficile', color: '#581c87' },
];

export const WAY_TYPES = [
  { id: 'major', label: 'Route principale', color: '#dc2626' },
  { id: 'minor', label: 'Petite route', color: '#f59e0b' },
  { id: 'cycleway', label: 'Piste cyclable', color: '#2563eb' },
  { id: 'track', label: 'Chemin', color: '#92400e' },
  { id: 'path', label: 'Sentier', color: '#16a34a' },
  { id: 'other', label: 'Autre', color: '#a1a1aa' },
];

/**
 * Catégories de points d'intérêt (Overpass). `filters` : liste de sélecteurs
 * Overpass QL ; `match` : fonction de classement d'un élément OSM reçu.
 */
export const POI_CATEGORIES = [
  {
    id: 'water', label: "Points d'eau", icon: '💧', color: '#0284c7', default: true, gpxSym: 'Drinking Water',
    filters: [
      '["amenity"~"^(drinking_water|water_point)$"]',
      '["man_made"="water_tap"]["access"!="private"]',
      '["amenity"="fountain"]["drinking_water"="yes"]',
      '["natural"="spring"]["drinking_water"="yes"]',
    ],
    match: (t) => ['drinking_water', 'water_point'].includes(t.amenity) || t.man_made === 'water_tap'
      || (t.amenity === 'fountain' && t.drinking_water === 'yes') || (t.natural === 'spring' && t.drinking_water === 'yes'),
  },
  {
    id: 'food', label: 'Commerces alimentaires', icon: '🛒', color: '#059669', default: true, gpxSym: 'Shopping Center',
    filters: ['["shop"~"^(supermarket|convenience|bakery|greengrocer|butcher|deli|farm|general|pastry)$"]'],
    match: (t) => /^(supermarket|convenience|bakery|greengrocer|butcher|deli|farm|general|pastry)$/.test(t.shop || ''),
  },
  {
    id: 'lodging', label: 'Hébergements', icon: '🛏️', color: '#7c3aed', default: true, gpxSym: 'Lodging',
    filters: ['["tourism"~"^(hotel|guest_house|hostel|motel|camp_site|alpine_hut|wilderness_hut|chalet)$"]'],
    match: (t) => /^(hotel|guest_house|hostel|motel|camp_site|alpine_hut|wilderness_hut|chalet)$/.test(t.tourism || ''),
  },
  {
    id: 'restaurant', label: 'Cafés / restaurants', icon: '☕', color: '#b45309', default: false, gpxSym: 'Restaurant',
    filters: ['["amenity"~"^(restaurant|cafe|fast_food|bar|pub)$"]'],
    match: (t) => /^(restaurant|cafe|fast_food|bar|pub)$/.test(t.amenity || ''),
  },
  {
    id: 'toilets', label: 'Toilettes', icon: '🚻', color: '#0891b2', default: false, gpxSym: 'Restroom',
    filters: ['["amenity"="toilets"]'],
    match: (t) => t.amenity === 'toilets',
  },
  {
    id: 'bike', label: 'Réparation vélo', icon: '🔧', color: '#e11d48', default: false, gpxSym: 'Bike Trail',
    filters: ['["shop"="bicycle"]', '["amenity"="bicycle_repair_station"]'],
    match: (t) => t.shop === 'bicycle' || t.amenity === 'bicycle_repair_station',
  },
  {
    id: 'station', label: 'Gares', icon: '🚉', color: '#475569', default: false, gpxSym: 'Ground Transportation',
    filters: ['["railway"~"^(station|halt)$"]'],
    match: (t) => t.railway === 'station' || t.railway === 'halt',
  },
];

/** Traduction des types OSM les plus courants pour l'affichage. */
export const OSM_TYPE_LABELS = {
  drinking_water: "Point d'eau potable", water_point: "Point d'eau", water_tap: 'Robinet', fountain: 'Fontaine', spring: 'Source',
  supermarket: 'Supermarché', convenience: 'Épicerie', bakery: 'Boulangerie', greengrocer: 'Primeur', butcher: 'Boucherie',
  deli: 'Traiteur', farm: 'Vente à la ferme', general: 'Magasin général', pastry: 'Pâtisserie',
  hotel: 'Hôtel', guest_house: "Chambre d'hôtes / gîte", hostel: 'Auberge de jeunesse', motel: 'Motel', camp_site: 'Camping',
  alpine_hut: 'Refuge', wilderness_hut: 'Cabane / abri', chalet: 'Gîte / chalet',
  restaurant: 'Restaurant', cafe: 'Café', fast_food: 'Restauration rapide', bar: 'Bar', pub: 'Pub',
  toilets: 'Toilettes', bicycle: 'Magasin / réparateur vélo', bicycle_repair_station: 'Station de réparation vélo',
  station: 'Gare', halt: 'Halte ferroviaire',
};

export const DEFAULTS = {
  poiRadius: 1000,
  poiRadiusMin: 200,
  poiRadiusMax: 2000,
  poiAuto: true,
  colorMode: 'surface',
  baseLayer: 'osm',
  historyLimit: 100,
  /** Distance au-delà de laquelle un segment en ligne droite est signalé (m). */
  steepGradeAlert: 12,
};
