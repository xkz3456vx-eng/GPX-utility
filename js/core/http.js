/**
 * Accès réseau : file d'attente avec limitation de fréquence, délai maximal,
 * nouvelles tentatives avec attente exponentielle (et respect de Retry-After).
 *
 * Note : les navigateurs interdisent de modifier l'en-tête User-Agent. Les
 * services publics identifient l'application via l'en-tête Referer envoyé
 * automatiquement (et, pour Nominatim, via le paramètre `email` si configuré).
 */

export class HttpError extends Error {
  constructor(message, { status = 0, body = '', kind = 'http' } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    this.kind = kind; // 'http' | 'network' | 'timeout' | 'abort'
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(t);
    reject(new HttpError('Requête annulée', { kind: 'abort' }));
  }, { once: true });
});

/** File d'attente : au plus `concurrency` tâches en parallèle, espacées d'au moins `minInterval` ms. */
export class RequestQueue {
  constructor({ concurrency = 1, minInterval = 0 } = {}) {
    this.concurrency = concurrency;
    this.minInterval = minInterval;
    this.active = 0;
    this.last = 0;
    this.pending = [];
  }

  run(task, signal) {
    return new Promise((resolve, reject) => {
      const job = { task, resolve, reject, signal };
      if (signal) {
        signal.addEventListener('abort', () => {
          const i = this.pending.indexOf(job);
          if (i >= 0) {
            this.pending.splice(i, 1);
            reject(new HttpError('Requête annulée', { kind: 'abort' }));
          }
        }, { once: true });
      }
      this.pending.push(job);
      this._next();
    });
  }

  _next() {
    if (this.active >= this.concurrency || this.pending.length === 0) return;
    const wait = this.last + this.minInterval - Date.now();
    if (wait > 0) {
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this._next(), wait);
      return;
    }
    const job = this.pending.shift();
    this.active++;
    this.last = Date.now();
    Promise.resolve()
      .then(() => job.task())
      .then(job.resolve, job.reject)
      .finally(() => {
        this.active--;
        this.last = Date.now();
        this._next();
      });
    this._next();
  }
}

/**
 * fetch avec délai maximal et nouvelles tentatives sur 429/502/503/504 et erreurs réseau.
 * Renvoie la Response si `res.ok`, sinon lève une HttpError contenant le corps.
 */
export async function fetchWithRetry(url, init = {}, { timeoutMs = 30000, retries = 2, signal } = {}) {
  let attempt = 0;
  for (;;) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
    let res;
    try {
      res = await fetch(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) throw new HttpError('Requête annulée', { kind: 'abort' });
      const timedOut = ctrl.signal.aborted;
      if (attempt < retries) {
        await sleep(1000 * 2 ** attempt, signal);
        attempt++;
        continue;
      }
      throw new HttpError(timedOut ? 'Délai dépassé' : 'Service injoignable', { kind: timedOut ? 'timeout' : 'network' });
    }
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (res.ok) return res;
    const body = await res.text().catch(() => '');
    if ([429, 502, 503, 504].includes(res.status) && attempt < retries) {
      const ra = Number(res.headers.get('Retry-After'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : 1500 * 2 ** attempt, signal);
      attempt++;
      continue;
    }
    throw new HttpError(`HTTP ${res.status}`, { status: res.status, body });
  }
}
