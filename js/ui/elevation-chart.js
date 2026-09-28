/**
 * Profil altimétrique interactif (canvas, sans dépendance).
 * - aire colorée selon le mode de coloration du tracé ;
 * - survol : curseur + infobulle, synchronisé avec la carte ;
 * - glisser : sélection d'une portion (statistiques + surbrillance sur la carte) ;
 * - clic : centre la carte sur le point.
 */
import { pointColor } from './map.js';
import { POI_CATEGORIES, SURFACES } from '../config.js';
import { fmtKm, fmtM } from './dom.js';

const PAD = { l: 46, r: 12, t: 14, b: 22 };

function niceStep(range, target) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

export class ElevationChart {
  constructor(container, handlers = {}) {
    this.h = handlers;
    this.el = container;
    this.base = document.createElement('canvas');
    this.overlay = document.createElement('canvas');
    this.tip = document.createElement('div');
    this.tip.className = 'chart-tip';
    this.el.append(this.base, this.overlay, this.tip);
    this.route = null;
    this.cursor = null;
    this.range = null;
    this._bind();
    new ResizeObserver(() => this.draw()).observe(this.el);
  }

  setData(route, colorMode, pois = []) {
    this.route = route && route.points.length > 1 ? route : null;
    this.colorMode = colorMode;
    this.pois = pois;
    this.range = null;
    this.draw();
  }

  setCursor(idx) {
    this.cursor = idx;
    this._drawOverlay();
  }

  setRange(range) {
    this.range = range;
    this._drawOverlay();
  }

  _size() {
    const r = this.el.getBoundingClientRect();
    return { w: Math.max(100, r.width), h: Math.max(80, r.height) };
  }

  _prep(canvas) {
    const { w, h } = this._size();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  _scales(w, h) {
    const an = this.route;
    const total = an.totals.distance || 1;
    let min = an.totals.minEle ?? 0, max = an.totals.maxEle ?? 100;
    const span = Math.max(50, max - min);
    min = Math.floor((min - span * 0.08) / 10) * 10;
    max = Math.ceil((max + span * 0.12) / 10) * 10;
    const pw = w - PAD.l - PAD.r, ph = h - PAD.t - PAD.b;
    return {
      total, min, max, pw, ph,
      x: (d) => PAD.l + (d / total) * pw,
      y: (e) => PAD.t + ph - ((e - min) / (max - min)) * ph,
      d: (px) => Math.max(0, Math.min(total, ((px - PAD.l) / pw) * total)),
    };
  }

  /** Index du point à la distance `d` (recherche dichotomique). */
  indexAt(d) {
    const cum = this.route.cum;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < d) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && d - cum[lo - 1] < cum[lo] - d) lo--;
    return lo;
  }

  draw() {
    const { ctx, w, h } = this._prep(this.base);
    this._prep(this.overlay);
    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(this.el);
    const fg = css.getPropertyValue('--chart-fg').trim() || '#374151';
    const grid = css.getPropertyValue('--chart-grid').trim() || '#e5e7eb';
    if (!this.route) {
      ctx.fillStyle = fg;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Ajoutez au moins deux points sur la carte pour afficher le profil.', w / 2, h / 2);
      return;
    }
    const an = this.route;
    const s = this._scales(w, h);
    this.s = s;
    ctx.font = '11px system-ui, sans-serif';
    ctx.strokeStyle = grid;
    ctx.fillStyle = fg;
    ctx.lineWidth = 1;
    // Grille horizontale (altitude)
    const ys = niceStep(s.max - s.min, Math.max(2, Math.floor(s.ph / 35)));
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let e = Math.ceil(s.min / ys) * ys; e <= s.max; e += ys) {
      const y = Math.round(s.y(e)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.l, y);
      ctx.lineTo(w - PAD.r, y);
      ctx.stroke();
      ctx.fillText(`${e} m`, PAD.l - 4, y);
    }
    // Grille verticale (distance)
    const xs = niceStep(s.total / 1000, Math.max(2, Math.floor(s.pw / 70))) * 1000;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let d = 0; d <= s.total; d += xs) {
      const x = Math.round(s.x(d)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, PAD.t);
      ctx.lineTo(x, h - PAD.b);
      ctx.stroke();
      ctx.fillText(`${Math.round(d / 1000)} km`, x, h - PAD.b + 5);
    }
    // Aire colorée : une colonne par pixel.
    const bottom = h - PAD.b;
    const top = [];
    for (let px = PAD.l; px <= w - PAD.r; px++) {
      const i = this.indexAt(s.d(px));
      const y = s.y(an.ele[i]);
      top.push([px, y]);
      ctx.fillStyle = pointColor(an, Math.max(1, i), this.colorMode === 'plain' ? 'plain' : this.colorMode);
      ctx.globalAlpha = 0.75;
      ctx.fillRect(px, y, 1.2, bottom - y);
    }
    ctx.globalAlpha = 1;
    ctx.beginPath();
    top.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = fg;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Débuts de tronçons (points de passage)
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = fg;
    ctx.lineWidth = 1;
    for (const leg of an.legs || []) {
      if (leg.startIdx === 0) continue;
      const x = Math.round(s.x(an.cum[leg.startIdx])) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, PAD.t);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // POI (eau, commerces, hébergement) en haut du graphique
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (const p of this.pois || []) {
      if (!['water', 'food', 'lodging'].includes(p.cat)) continue;
      const cat = POI_CATEGORIES.find((c) => c.id === p.cat);
      for (const at of [p.along, p.alongReturn]) {
        if (at == null) continue;
        ctx.fillText(cat.icon, s.x(at), 0);
      }
    }
    if (!an.totals.hasElevation) {
      ctx.fillStyle = fg;
      ctx.textAlign = 'center';
      ctx.fillText('Altitudes indisponibles pour ce tracé', PAD.l + s.pw / 2, PAD.t + s.ph / 2);
    }
    this._drawOverlay();
  }

  _drawOverlay() {
    const ctx = this.overlay.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { w, h } = this._size();
    ctx.clearRect(0, 0, w, h);
    this.tip.style.display = 'none';
    if (!this.route || !this.s) return;
    const s = this.s;
    const an = this.route;
    if (this.range) {
      const [a, b] = this.range;
      const x1 = s.x(an.cum[Math.min(a, b)]), x2 = s.x(an.cum[Math.max(a, b)]);
      ctx.fillStyle = 'rgba(250, 204, 21, 0.25)';
      ctx.fillRect(x1, PAD.t, x2 - x1, s.ph);
    }
    if (this.cursor == null || !an.points[this.cursor]) return;
    const i = this.cursor;
    const x = s.x(an.cum[i]);
    const y = s.y(an.ele[i]);
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, PAD.t);
    ctx.lineTo(x, h - PAD.b);
    ctx.stroke();
    ctx.fillStyle = '#111827';
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    const surf = SURFACES[an.surface[i]]?.label || '';
    const tagsRaw = an.tagList[an.points[i].tag] || '';
    const hw = (tagsRaw.match(/highway=(\S+)/) || [])[1];
    this.tip.textContent = '';
    const lines = [
      `${fmtKm(an.cum[i])}${an.totals.hasElevation ? ` · ${fmtM(an.ele[i])}` : ''}`,
      an.totals.hasElevation ? `Pente : ${an.grades[i].toFixed(1).replace('.', ',')} %` : '',
      `${surf}${hw ? ` (${hw})` : ''}`,
    ].filter(Boolean);
    for (const l of lines) this.tip.append(Object.assign(document.createElement('div'), { textContent: l }));
    this.tip.style.display = 'block';
    const tw = this.tip.offsetWidth;
    this.tip.style.left = `${x + 10 + tw > w ? x - tw - 10 : x + 10}px`;
    this.tip.style.top = `${PAD.t}px`;
  }

  _bind() {
    const idxFromEvent = (e) => {
      if (!this.route || !this.s) return null;
      const r = this.overlay.getBoundingClientRect();
      return this.indexAt(this.s.d(e.clientX - r.left));
    };
    let down = null;
    this.overlay.addEventListener('pointerdown', (e) => {
      const i = idxFromEvent(e);
      if (i == null) return;
      down = { i, x: e.clientX, moved: false };
      this.overlay.setPointerCapture(e.pointerId);
    });
    this.overlay.addEventListener('pointermove', (e) => {
      const i = idxFromEvent(e);
      if (i == null) return;
      this.cursor = i;
      if (down && Math.abs(e.clientX - down.x) > 5 && e.pointerType === 'mouse') {
        down.moved = true;
        this.range = [down.i, i];
      }
      this._drawOverlay();
      this.h.onHover?.(i);
    });
    this.overlay.addEventListener('pointerup', (e) => {
      if (!down) return;
      const i = idxFromEvent(e);
      if (down.moved && i != null) this.h.onRange?.(Math.min(down.i, i), Math.max(down.i, i));
      else if (i != null) this.h.onClick?.(i);
      down = null;
    });
    this.overlay.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.cursor = null;
      this._drawOverlay();
      this.h.onHover?.(null);
    });
    this.overlay.addEventListener('dblclick', () => {
      this.range = null;
      this._drawOverlay();
      this.h.onRange?.(null, null);
    });
  }
}
