/**
 * Réglages utilisateur surchargeant js/config.js, persistés dans le localStorage.
 */
import { APP, SERVICES, API_KEYS } from '../config.js';

const KEY = `${APP.storagePrefix}settings`;

const DEFAULT_SETTINGS = {
  brouterUrl: SERVICES.brouter.url,
  overpassUrl: SERVICES.overpass.urls[0],
  thunderforestKey: API_KEYS.thunderforest,
  contactEmail: APP.contactEmail,
  /** 0 = seuil par défaut du profil. */
  waterGapKm: 0,
  /** 0 = vitesse par défaut du profil (km/h). */
  speed: 0,
  baseLayer: 'osm',
  overlays: [],
  colorMode: 'surface',
  elevationOpen: true,
};

let current = load();

function load() {
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(KEY)) || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export const settings = {
  get(k) {
    return current[k];
  },
  all() {
    return { ...current };
  },
  set(patch) {
    current = { ...current, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(current));
    } catch { /* stockage indisponible (navigation privée) */ }
  },
  reset() {
    current = { ...DEFAULT_SETTINGS };
    try {
      localStorage.removeItem(KEY);
    } catch { /* ignore */ }
  },
  defaults: DEFAULT_SETTINGS,
};
