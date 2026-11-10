// Small DOM helpers shared by the views.
import { icon } from './icons.js';
import { initials } from './store.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// Readable initials on any colour: white on darker colours, near-black on light ones (whichever contrasts more)
const fgCache = new Map();
export function inkFor(hex = '#8b7cff') {
  if (fgCache.has(hex)) return fgCache.get(hex);
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  let fg = '#ffffff';
  if (m) {
    const n = parseInt(m[1], 16);
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    // the avatar's gradient is a little lighter than the colour itself, so judge a slightly lightened tone
    const ch = [n >> 16, (n >> 8) & 255, n & 255].map((v) => lin(v + (255 - v) * 0.12));
    const L = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    // plain WCAG ratios favour black on mid-tones (purple, blue), which reads poorly; use a perceptual cut-off instead
    fg = L > 0.36 ? '#0b0c16' : '#ffffff';
  }
  fgCache.set(hex, fg);
  return fg;
}

export function avatar(e, size = '', { status = true, crown = false } = {}) {
  if (!e) return `<div class="av ${size}" style="--c:#4a4f6e;--fg:#fff">?</div>`;
  const st = status ? `<i class="st ${e.status || 'idle'}"></i>` : '';
  const cr = crown && e.is_lead ? `<span class="crown">${icon('crown', 13)}</span>` : '';
  return `<div class="av ${size}" style="--c:${e.color};--fg:${inkFor(e.color)}" data-av="${e.id}"><span class="ini">${esc(initials(e.name))}</span>${st}${cr}</div>`;
}

// Toasts: never more than 2 on screen, and the same message is never shown twice (it just stays up longer)
const TOAST_MAX = 2, TOAST_MS = 3200;
function dismissToast(el) {
  if (el.classList.contains('out')) return;
  clearTimeout(el._timer);
  el.classList.add('out');
  setTimeout(() => el.remove(), 350);
}
export function toast(msg, bad = false) {
  const box = $('#toasts');
  const live = [...box.querySelectorAll('.toast:not(.out)')];
  const same = live.find((el) => el.dataset.msg === msg);
  if (same) {   // repeat: refresh it instead of stacking a copy
    clearTimeout(same._timer);
    same.classList.remove('bump'); void same.offsetWidth; same.classList.add('bump');
    same._timer = setTimeout(() => dismissToast(same), TOAST_MS);
    return;
  }
  const el = h(`<div class="toast glass${bad ? ' bad' : ''}">${icon(bad ? 'alert' : 'check', 16)}<span>${esc(msg)}</span></div>`);
  el.dataset.msg = msg;
  box.append(el);
  live.slice(0, Math.max(0, live.length + 1 - TOAST_MAX)).forEach(dismissToast);   // oldest go first
  el._timer = setTimeout(() => dismissToast(el), TOAST_MS);
}

// In-app confirmation (the browser's confirm() is silently blocked in embedded browsers).
// Resolves true/false. Restores whatever the shared modal was showing before.
export function confirmBox({ title, text = '', ok = 'OK', cancel = 'Cancel', danger = false, icon: ic = 'alert' }) {
  return new Promise((resolve) => {
    const m = $('#modal'), sheet = $('#modalSheet');
    const prev = m.classList.contains('on') ? { html: sheet.innerHTML, onclick: m.onclick } : null;
    sheet.innerHTML = `<div class="confirm"><div class="cf-ico${danger ? ' danger' : ''}">${icon(ic, 22)}</div>
      <h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}
      <div class="cf-actions"><button class="btn ghost" data-no>${esc(cancel)}</button>
        <button class="btn ${danger ? 'danger solid' : 'primary'}" data-yes>${esc(ok)}</button></div></div>`;
    m.classList.add('on', 'small');
    const done = (v) => {
      document.removeEventListener('keydown', onKey, true);
      m.classList.remove('small');
      if (prev) { sheet.innerHTML = prev.html; m.onclick = prev.onclick; } else m.classList.remove('on');
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } if (e.key === 'Enter') { e.preventDefault(); done(true); } };
    document.addEventListener('keydown', onKey, true);
    $('[data-no]', sheet).onclick = () => done(false);
    $('[data-yes]', sheet).onclick = () => done(true);
    m.onclick = (e) => { if (e.target === m) done(false); };
    setTimeout(() => $('[data-yes]', sheet)?.focus(), 50);
  });
}

export function timeAgo(ts, lang = 'en') {
  const s = Math.max(1, Math.round(Date.now() / 1000 - ts));
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto', style: 'short' });
  if (s < 60) return rtf.format(-s, 'second');
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}

// Tiny, safe Markdown → HTML (headings, lists, code, bold/italic, links, tables).
export function md(src = '') {
  const blocks = [];
  let text = esc(src).replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _l, code) => { blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\u0000\d+\u0000$/.test(line.trim())) { out.push(line.trim()); continue; }
    const hm = line.match(/^(#{1,4})\s+(.*)/);
    if (hm) { const n = Math.min(4, hm[1].length + 1); out.push(`<h${n}>${inline(hm[2])}</h${n}>`); continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) { items.push(`<li>${inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`); i++; }
      i--; out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
    }
    if (/^\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { if (!/^\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i]); i++; }
      i--;
      out.push(`<table>${rows.map((r, k) => `<tr>${r.split('|').slice(1, -1).map((c) => `<${k ? 'td' : 'th'}>${inline(c.trim())}</${k ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</table>`);
      continue;
    }
    if (!line.trim()) { out.push(''); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  return out.join('\n').replace(/\u0000(\d+)\u0000/g, (_, k) => blocks[+k]);
}

// Animated sliding indicator for segmented controls
export function segIndicator(seg) {
  let ind = seg.querySelector('.ind');
  if (!ind) { ind = h('<span class="ind"></span>'); seg.prepend(ind); }
  const on = seg.querySelector('button.on');
  if (!on) { ind.style.width = '0'; return; }
  ind.style.width = `${on.offsetWidth}px`;
  ind.style.transform = `translateX(${on.offsetLeft}px)`;
}
