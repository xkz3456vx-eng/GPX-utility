/** Petites aides DOM et de formatage (français). */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * Crée un élément : h('button', { class: 'btn', onclick: fn }, 'Texte', enfant…)
 * Les chaînes sont insérées comme texte (jamais comme HTML).
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

export function fmtKm(m) {
  if (m == null || !Number.isFinite(m)) return '–';
  return `${m < 100000 ? nf1.format(m / 1000) : nf0.format(m / 1000)} km`;
}

export function fmtM(m) {
  return m == null || !Number.isFinite(m) ? '–' : `${nf0.format(m)} m`;
}

export function fmtDist(m) {
  return m < 1000 ? `${Math.round(m)} m` : fmtKm(m);
}

export function fmtDuration(hours) {
  if (!Number.isFinite(hours) || hours <= 0) return '–';
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60);
  const min = total % 60;
  return h ? `${h} h ${String(min).padStart(2, '0')}` : `${min} min`;
}

export function fmtPct(part, total) {
  return total > 0 ? `${nf0.format((part / total) * 100)} %` : '0 %';
}

export function debounce(fn, ms) {
  let t;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

// ---------- Notifications ----------

export function toast(message, type = 'info', timeout = 4500) {
  const box = $('#toasts');
  if (!box) return;
  const el = h('div', { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' }, message);
  box.append(el);
  const close = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 250);
  };
  el.addEventListener('click', close);
  if (timeout) setTimeout(close, timeout);
}

/** Télécharge un contenu texte sous forme de fichier. */
export function download(filename, content, mime = 'application/gpx+xml') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
