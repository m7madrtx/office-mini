// "@" autocomplete in the chat composer: tag a person, a room or a whole division.
import { t, L } from './i18n.js';
import { icon } from './icons.js';
import { store, titleOf } from './store.js';
import { esc, avatar } from './ui.js';

function candidates(q) {
  q = q.toLowerCase();
  const out = [];
  for (const e of store.org.employees) out.push({ type: 'employee', id: e.id, label: e.name, sub: titleOf(e), e });
  for (const r of store.org.rooms) out.push({ type: 'room', id: r.id, label: r.name, sub: t('roomWord'), color: r.accent });
  const used = new Set(store.org.employees.map((e) => e.room_division || e.division));
  for (const d of store.catalog.divisions) if (used.has(d.id)) out.push({ type: 'division', id: d.id, label: L(d.name), sub: t('divisionWord'), color: d.color, icon: d.icon });
  return out.filter((c) => !q || c.label.toLowerCase().includes(q) || c.sub.toLowerCase().includes(q)).slice(0, 8);
}

export function attachMentions(ta, pop) {
  let mentions = [];
  let items = [], sel = 0, start = -1;
  const close = () => { pop.hidden = true; start = -1; };
  const render = () => {
    pop.innerHTML = items.map((c, i) => `<button type="button" class="mention-opt${i === sel ? ' on' : ''}" data-i="${i}">
      ${c.e ? avatar(c.e, 'xs', { status: false }) : `<span class="av xs" style="--c:${c.color}">${icon(c.icon || 'users', 11)}</span>`}
      <b>${esc(c.label)}</b><small>${esc(c.sub)}</small></button>`).join('');
    pop.querySelectorAll('[data-i]').forEach((b) => { b.onmousedown = (e) => { e.preventDefault(); choose(+b.dataset.i); }; });
  };
  const choose = (i) => {
    const c = items[i];
    if (!c) return;
    const before = ta.value.slice(0, start), after = ta.value.slice(ta.selectionStart);
    const tag = `@${c.label} `;
    ta.value = before + tag + after;
    const pos = before.length + tag.length;
    ta.setSelectionRange(pos, pos);
    if (!mentions.some((m) => m.type === c.type && m.id === c.id)) mentions.push({ type: c.type, id: c.id, label: c.label });
    close();
    ta.dispatchEvent(new Event('input'));
  };
  ta.addEventListener('input', () => {
    const upto = ta.value.slice(0, ta.selectionStart);
    const m = upto.match(/(^|\s)@([^\s@]{0,24}(?: [^\s@]{0,20})?)$/);
    if (!m) { close(); return; }
    start = upto.length - m[2].length - 1;
    items = candidates(m[2]);
    sel = 0;
    if (!items.length) { close(); return; }
    pop.hidden = false;
    render();
  });
  ta.addEventListener('keydown', (e) => {
    if (pop.hidden) return;
    if (e.key === 'ArrowDown') { sel = (sel + 1) % items.length; render(); e.preventDefault(); e.stopImmediatePropagation(); }
    else if (e.key === 'ArrowUp') { sel = (sel - 1 + items.length) % items.length; render(); e.preventDefault(); e.stopImmediatePropagation(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { choose(sel); e.preventDefault(); e.stopImmediatePropagation(); }
    else if (e.key === 'Escape') { close(); e.stopImmediatePropagation(); }
  }, true);
  ta.addEventListener('blur', () => setTimeout(close, 150));
  return {
    get: () => mentions.filter((m) => ta.value.includes(`@${m.label}`)),
    reset: () => { mentions = []; close(); },
  };
}

// Highlight @mentions inside already-escaped message text
export function highlightMentions(html, mentions = []) {
  for (const m of mentions) {
    const lab = esc(`@${m.label}`);
    html = html.split(lab).join(`<span class="mention">${lab}</span>`);
  }
  return html;
}
