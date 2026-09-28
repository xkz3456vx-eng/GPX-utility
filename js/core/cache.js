/**
 * Cache clé/valeur avec durée de vie et éviction LRU.
 * - en mémoire toujours ;
 * - optionnellement persisté dans le localStorage (survit au rechargement).
 * Sert à limiter la charge sur les API publiques (BRouter, Overpass).
 */
import { APP } from '../config.js';

/** Hachage 53 bits rapide (cyrb53) pour obtenir des clés courtes. */
export function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function safeStorage() {
  try {
    const k = '__t';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return localStorage;
  } catch {
    return null;
  }
}

export class Cache {
  /**
   * @param {string} ns espace de noms
   * @param {{ttl?: number, max?: number, persist?: boolean}} opts
   */
  constructor(ns, { ttl = 3600e3, max = 200, persist = false } = {}) {
    this.ns = ns;
    this.ttl = ttl;
    this.max = max;
    this.mem = new Map();
    this.storage = persist ? safeStorage() : null;
    this.indexKey = `${APP.storagePrefix}cache:${ns}:index`;
  }

  _k(key) {
    return `${APP.storagePrefix}cache:${this.ns}:${hash(key)}`;
  }

  _index() {
    try {
      return JSON.parse(this.storage.getItem(this.indexKey)) || {};
    } catch {
      return {};
    }
  }

  get(key) {
    const k = this._k(key);
    const now = Date.now();
    const m = this.mem.get(k);
    if (m) {
      if (m.exp > now) {
        this.mem.delete(k);
        this.mem.set(k, m); // LRU : remet en fin
        return m.value;
      }
      this.mem.delete(k);
    }
    if (this.storage) {
      try {
        const raw = this.storage.getItem(k);
        if (raw) {
          const entry = JSON.parse(raw);
          if (entry.exp > now && entry.key === key) {
            this.mem.set(k, entry);
            return entry.value;
          }
          this._remove(k);
        }
      } catch { /* entrée corrompue : ignorée */ }
    }
    return undefined;
  }

  set(key, value) {
    const k = this._k(key);
    const entry = { key, value, exp: Date.now() + this.ttl };
    this.mem.set(k, entry);
    while (this.mem.size > this.max) this.mem.delete(this.mem.keys().next().value);
    if (!this.storage) return;
    const index = this._index();
    index[k] = Date.now();
    const keys = Object.keys(index).sort((a, b) => index[a] - index[b]);
    while (keys.length > this.max) {
      const old = keys.shift();
      delete index[old];
      this.storage.removeItem(old);
    }
    const payload = JSON.stringify(entry);
    // En cas de quota dépassé, on libère les entrées les plus anciennes.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        this.storage.setItem(k, payload);
        this.storage.setItem(this.indexKey, JSON.stringify(index));
        return;
      } catch {
        const old = keys.shift();
        if (!old || old === k) return;
        delete index[old];
        this.storage.removeItem(old);
      }
    }
  }

  _remove(k) {
    this.mem.delete(k);
    if (!this.storage) return;
    this.storage.removeItem(k);
    const index = this._index();
    delete index[k];
    this.storage.setItem(this.indexKey, JSON.stringify(index));
  }

  clear() {
    this.mem.clear();
    if (!this.storage) return;
    for (const k of Object.keys(this._index())) this.storage.removeItem(k);
    this.storage.removeItem(this.indexKey);
  }

  /** Taille approximative occupée dans le localStorage (octets). */
  size() {
    if (!this.storage) return 0;
    let total = 0;
    for (const k of Object.keys(this._index())) total += (this.storage.getItem(k) || '').length * 2;
    return total;
  }
}
