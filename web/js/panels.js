// People side panel, notifications/approvals centre, live activity logs, live progress.
import { t, L, getLang } from './i18n.js';
import { icon } from './icons.js';
import { store, api, on, emp, room, division, titleOf, firstName } from './store.js';
import { $, $$, h, esc, avatar, timeAgo, toast, segIndicator } from './ui.js';

let ctx = null;
export function initPanels(c) { ctx = c; }

// ================================================================ people panel
const P = { open: false, group: 'division', active: false, q: '' };
try { Object.assign(P, JSON.parse(localStorage.getItem('om-people') || '{}'), { q: '' }); } catch { /* storage blocked */ }
const save = () => { try { localStorage.setItem('om-people', JSON.stringify({ open: P.open, group: P.group, active: P.active })); } catch { /* ignore */ } };

export function peopleOpen() { return P.open; }
export function togglePeople(force) {
  P.open = force ?? !P.open; save();
  document.body.classList.toggle('people-open', P.open);
  $('#people').classList.toggle('on', P.open);
  if (P.open) renderPeople();
  ctx.onLayout();
}

export function renderPeople() {
  const box = $('#people');
  if (!box || !P.open) return;
  if (!box.querySelector('.pp-head')) {
    box.innerHTML = `<div class="pp-head"><h3>${icon('users', 16)}<span>${t('people')}</span><small id="ppCount"></small></h3>
        <button class="icon-btn" id="ppClose">${icon('x', 17)}</button></div>
      <div class="pp-tools">
        <input class="input sm" id="ppQ" placeholder="${esc(t('searchPeople'))}">
        <div class="pp-row"><nav class="seg small" id="ppGroup">${[['division', 'byDivision'], ['room', 'byRoom'], ['status', 'byStatus'], ['manager', 'byManager']].map(([v, k]) =>
          `<button data-g="${v}" class="${P.group === v ? 'on' : ''}">${t(k)}</button>`).join('')}</nav></div>
        <label class="pp-active"><button class="switch${P.active ? ' on' : ''}" id="ppActive" role="switch"><i></i></button>${t('activeOnly')}</label>
      </div>
      <div class="pp-list scroll" id="ppList"></div>`;
    $('#ppClose', box).onclick = () => togglePeople(false);
    $('#ppQ', box).oninput = (e) => { P.q = e.target.value.toLowerCase(); renderPeople(); };
    $$('[data-g]', box).forEach((b) => { b.onclick = () => { P.group = b.dataset.g; save(); $$('[data-g]', box).forEach((x) => x.classList.toggle('on', x === b)); segIndicator($('#ppGroup', box)); renderPeople(); }; });
    $('#ppActive', box).onclick = (e) => { P.active = !P.active; save(); e.currentTarget.classList.toggle('on', P.active); renderPeople(); };
    requestAnimationFrame(() => segIndicator($('#ppGroup', box)));
  }
  const all = store.org.employees;
  let list = all.filter((e) => (!P.active || e.status === 'working') && (!P.q || e.name.toLowerCase().includes(P.q) || titleOf(e).toLowerCase().includes(P.q)));
  $('#ppCount', box).textContent = `${list.length}/${all.length}`;
  const groups = new Map();
  const key = (e) => {
    if (P.group === 'room') { const r = room(e.room_id); return [e.room_id, r?.name || '—', r?.accent || '#888', r?.kind === 'exec' ? 'crown' : division(r?.division)?.icon]; }
    if (P.group === 'status') { const s = e.status || 'idle'; return [s, t(s), { working: '#ff5c8a', idle: '#2ee59d', done: '#4f8cff', error: '#ffa63d' }[s], 'pulse']; }
    if (P.group === 'manager') { const m = emp(e.reports_to); return [e.reports_to || 'owner', m ? m.name : t('owner'), m?.color || '#8b7cff', 'org']; }
    const d = division(e.room_division || e.division); return [d?.id, L(d?.name), d?.color, d?.icon];
  };
  list.sort((a, b) => a.seniority - b.seniority || a.name.localeCompare(b.name));
  for (const e of list) { const [k, label, color, ic] = key(e); if (!groups.has(k)) groups.set(k, { label, color, ic, items: [] }); groups.get(k).items.push(e); }
  const order = P.group === 'status' ? ['working', 'error', 'done', 'idle'] : null;
  const entries = [...groups.entries()].sort((a, b) => (order ? order.indexOf(a[0]) - order.indexOf(b[0]) : 0));
  $('#ppList', box).innerHTML = list.length ? entries.map(([, g]) => `<div class="pp-group">
      <div class="pp-gh"><span class="sw" style="--c:${g.color}">${icon(g.ic || 'users', 11)}</span><span>${esc(g.label)}</span><small>${g.items.length}</small></div>
      ${g.items.map((e) => `<button class="pp-item${e.status === 'working' ? ' working' : ''}" data-emp="${e.id}">${avatar(e, 'sm', { crown: true })}
        <span class="tx"><b>${esc(e.name)}</b><span>${esc(e.status === 'working' && e.task ? e.task : titleOf(e))}</span>
        ${e.status === 'working' ? '<i class="bar"></i>' : ''}</span></button>`).join('')}</div>`).join('')
    : `<div class="empty" style="padding:40px 10px">${icon('users', 28)}<div>${P.active ? t('nobodyActive') : '—'}</div></div>`;
  $$('[data-emp]', box).forEach((b) => { b.onclick = () => { const r = b.getBoundingClientRect(); ctx.selectEmployee(b.dataset.emp, r.right + 8, r.top + r.height / 2, true); }; });
}

let ppTimer = null;
const ppSoon = () => { clearTimeout(ppTimer); ppTimer = setTimeout(renderPeople, 120); };
on('org', ppSoon);
on('status', ppSoon);

// ================================================================ live progress (popover block)
export async function progressBlock(e, mountEl) {
  if (!mountEl) return;
  const since = e.status_ts ? Math.max(0, Math.round(Date.now() / 1000 - e.status_ts)) : null;
  mountEl.innerHTML = `<div class="progress">
    <div class="pg-top"><span class="dot working"></span><b>${t('currentTask')}</b><small id="pgElapsed">${since != null ? t('elapsed', since) : ''}</small></div>
    <div class="pg-task">${esc(e.task || t('working'))}</div><div class="pg-bar"><i></i></div>
    <div class="pg-steps" id="pgSteps"></div></div>`;
  const { activity } = await api(`/activity?employee=${encodeURIComponent(e.id)}&limit=5`);
  const steps = $('#pgSteps', mountEl);
  if (steps) steps.innerHTML = activity.map(stepRow).join('');
}
const KIND_ICON = { model: 'cpu', tool: 'cog', result: 'check', handoff: 'arrow', report: 'message', consult: 'message', approval: 'bell', hire: 'users', error: 'alert', info: 'info' };
function stepRow(a) {
  return `<div class="pg-step k-${a.kind}">${icon(KIND_ICON[a.kind] || 'info', 12)}<span>${esc(a.text)}</span></div>`;
}
on('activity', (ev) => {
  const box = document.querySelector('#popover .pg-steps');
  if (box && box.closest('[data-emp-id]')?.dataset.empId === ev.entry.employee) {
    box.insertAdjacentHTML('beforeend', stepRow(ev.entry));
    while (box.children.length > 5) box.firstElementChild.remove();
  }
});
setInterval(() => {
  const el = document.querySelector('#popover #pgElapsed');
  const id = document.querySelector('#popover [data-emp-id]')?.dataset.empId;
  const e = id && emp(id);
  if (el && e?.status_ts) el.textContent = t('elapsed', Math.max(0, Math.round(Date.now() / 1000 - e.status_ts)));
}, 1000);

// ================================================================ activity log (drawer + list)
const ACT_FILTERS = { all: null, model: ['model'], tools: ['tool', 'result'], tasks: ['handoff', 'report', 'consult', 'approval', 'hire'], errors: ['error'] };
export function activityList(entries, { withWho = false } = {}) {
  return entries.map((a) => {
    const who = withWho ? emp(a.employee) : null;
    const time = new Date(a.ts * 1000).toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `<div class="act k-${a.kind}"><span class="tm">${time}</span>${withWho ? avatar(who, 'xs', { status: false }) : ''}<span class="ki">${icon(KIND_ICON[a.kind] || 'info', 13)}</span><span class="tx">${withWho && who ? `<b>${esc(firstName(who.name))}</b> ` : ''}${esc(a.text)}</span></div>`;
  }).join('');
}

export async function openActivity(id) {
  const e = emp(id);
  if (!e) return;
  let filter = 'all';
  const el = h(`<div style="display:flex;flex-direction:column;height:100%;min-height:0">
    <div class="d-head">${avatar(e, '', { crown: true })}<div class="txt"><h3>${esc(e.name)}</h3><p><span class="live-dot"></span>${t('live')} · ${t('activity')}</p></div>
      <button class="icon-btn" data-chat title="${esc(t('chat'))}">${icon('message', 17)}</button>
      <button class="icon-btn" data-close>${icon('x', 18)}</button></div>
    <div style="padding:10px 16px 0"><nav class="seg small" id="actSeg">${Object.keys(ACT_FILTERS).map((k) => `<button data-f="${k}" class="${k === 'all' ? 'on' : ''}">${{ all: t('allActivity').split(' ')[0], model: t('model'), tools: 'Tools', tasks: t('tasks'), errors: t('error') }[k]}</button>`).join('')}</nav></div>
    <div class="d-body"><div class="acts scroll" id="actList"></div></div></div>`);
  ctx.drawer.open({ kind: 'activity', el, onClose: () => { off(); } });
  $('[data-close]', el).onclick = () => ctx.drawer.close();
  $('[data-chat]', el).onclick = () => ctx.openChat(id);
  requestAnimationFrame(() => segIndicator($('#actSeg', el)));
  let entries = (await api(`/activity?employee=${encodeURIComponent(id)}&limit=200`)).activity;
  const list = $('#actList', el);
  const draw = () => {
    const f = ACT_FILTERS[filter];
    const rows = entries.filter((a) => !f || f.includes(a.kind));
    list.innerHTML = rows.length ? activityList(rows) : `<div class="empty">${icon('pulse', 28)}<div>${t('noActivity')}</div></div>`;
    list.scrollTop = list.scrollHeight;
  };
  $$('[data-f]', el).forEach((b) => { b.onclick = () => { filter = b.dataset.f; $$('[data-f]', el).forEach((x) => x.classList.toggle('on', x === b)); segIndicator($('#actSeg', el)); draw(); }; });
  draw();
  const off = on('activity', (ev) => {
    if (ev.entry.employee !== id) return;
    entries.push(ev.entry);
    const f = ACT_FILTERS[filter];
    if (f && !f.includes(ev.entry.kind)) return;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    list.querySelector('.empty')?.remove();
    list.insertAdjacentHTML('beforeend', activityList([ev.entry]));
    list.lastElementChild.classList.add('fresh');
    if (atBottom) list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  });
}

// ================================================================ notifications + approvals
const N = { tab: 'approvals', status: 'pending', group: 'employee' };
export async function refreshBadge() {
  try {
    const r = await api('/notifications');
    const n = r.pending + r.unread;
    const b = $('#bellBadge');
    b.textContent = n > 99 ? '99+' : n;
    b.hidden = !n;
    b.classList.toggle('urgent', r.pending > 0);
  } catch { /* offline */ }
}
on('approvals', () => { refreshBadge(); if (ctx?.drawer.current?.kind === 'notifications') renderNotifications(); });
on('notification', () => { refreshBadge(); if (ctx?.drawer.current?.kind === 'notifications') renderNotifications(); });

let nEl = null;
export function openNotifications() {
  nEl = h(`<div style="display:flex;flex-direction:column;height:100%;min-height:0">
    <div class="d-head"><div class="av" style="--c:#f5b544">${icon('bell', 18)}</div><div class="txt"><h3>${t('notifications')}</h3><p id="nSub"></p></div>
      <button class="icon-btn" data-close>${icon('x', 18)}</button></div>
    <div style="padding:10px 16px 4px;display:grid;gap:8px">
      <nav class="seg small" id="nTabs"><button data-tab="approvals" class="on">${icon('check', 13)}${t('approvals')}</button><button data-tab="updates">${icon('bell', 13)}${t('updates')}</button></nav>
      <div class="pp-row" id="nFilters"></div></div>
    <div class="d-body"><div class="scroll" id="nList" style="height:100%;padding:8px 16px 20px"></div></div></div>`);
  ctx.drawer.open({ kind: 'notifications', el: nEl, onClose: () => { nEl = null; } });
  $('[data-close]', nEl).onclick = () => ctx.drawer.close();
  $$('[data-tab]', nEl).forEach((b) => { b.onclick = () => { N.tab = b.dataset.tab; $$('[data-tab]', nEl).forEach((x) => x.classList.toggle('on', x === b)); segIndicator($('#nTabs', nEl)); renderNotifications(); }; });
  requestAnimationFrame(() => segIndicator($('#nTabs', nEl)));
  renderNotifications();
}

async function renderNotifications() {
  if (!nEl) return;
  const list = $('#nList', nEl), filters = $('#nFilters', nEl);
  if (N.tab === 'updates') {
    filters.innerHTML = `<button class="btn quiet sm" id="nRead">${icon('check', 14)}${t('markRead')}</button>`;
    $('#nRead', nEl).onclick = async () => { await api('/notifications/read', 'POST'); renderNotifications(); };
    const { notifications } = await api('/notifications');
    const rows = notifications.filter((n) => n.kind !== 'approval');
    $('#nSub', nEl).textContent = `${rows.filter((n) => !n.read).length} ${t('unread').toLowerCase()}`;
    list.innerHTML = rows.length ? rows.map((n) => {
      const e = emp(n.employee);
      return `<div class="note-item${n.read ? '' : ' unread'} k-${n.kind}${/^(run|wf):/.test(n.ref || '') ? ' link-item' : ''}" data-ref="${esc(n.ref || '')}">${avatar(e, 'sm', { status: false })}<div class="tx"><b>${esc(n.title)}</b>
        ${n.body ? `<p>${esc(n.body.slice(0, 220))}</p>` : ''}<small>${esc(e?.name || '')} · ${esc(timeAgo(n.ts, getLang()))}</small></div></div>`;
    }).join('') : `<div class="empty">${icon('bell', 28)}<div>${t('noUpdates')}</div></div>`;
    $$('.link-item', list).forEach((it) => { it.onclick = () => { const [k, id] = it.dataset.ref.split(':'); if (k === 'run') ctx.openRun(+id); else ctx.setView('workflows'); }; });
    return;
  }
  filters.innerHTML = `<nav class="seg small" id="nStatus"><button data-s="pending" class="${N.status === 'pending' ? 'on' : ''}">${t('pending')}</button><button data-s="decided" class="${N.status === 'decided' ? 'on' : ''}">${t('decided')}</button></nav>
    <select class="input sm" id="nGroup" style="width:auto">${[['employee', 'byEmployee'], ['division', 'byDivision'], ['room', 'byRoom'], ['type', 'byType']].map(([v, k]) => `<option value="${v}" ${N.group === v ? 'selected' : ''}>${t('groupBy')}: ${t(k)}</option>`).join('')}</select>`;
  requestAnimationFrame(() => segIndicator($('#nStatus', nEl)));
  $$('[data-s]', nEl).forEach((b) => { b.onclick = () => { N.status = b.dataset.s; renderNotifications(); }; });
  $('#nGroup', nEl).onchange = (e) => { N.group = e.target.value; renderNotifications(); };
  const { approvals } = await api('/approvals');
  const rows = approvals.filter((a) => (N.status === 'pending' ? a.status === 'pending' : a.status !== 'pending'));
  $('#nSub', nEl).textContent = `${approvals.filter((a) => a.status === 'pending').length} ${t('pending').toLowerCase()}`;
  const keyOf = (a) => {
    const e = emp(a.employee);
    if (N.group === 'division') { const d = division(e?.room_division || e?.division); return [d?.id || '-', L(d?.name) || '—', d?.color]; }
    if (N.group === 'room') { const r = room(e?.room_id); return [r?.id || '-', r?.name || '—', r?.accent]; }
    if (N.group === 'type') return [a.kind, t('kinds')[a.kind] || a.kind, '#8b7cff'];
    return [a.employee, e?.name || t('former'), e?.color];
  };
  const groups = new Map();
  for (const a of rows) { const [k, label, color] = keyOf(a); if (!groups.has(k)) groups.set(k, { label, color, items: [] }); groups.get(k).items.push(a); }
  list.innerHTML = rows.length ? [...groups.values()].map((g) => `<div class="pp-group"><div class="pp-gh"><span class="sw" style="--c:${g.color || '#8b7cff'}"></span><span>${esc(g.label)}</span><small>${g.items.length}</small></div>
    ${g.items.map((a) => {
      const e = emp(a.employee);
      return `<div class="appr ${a.status}" data-a="${a.id}"><div class="ah">${avatar(e, 'sm', { status: false })}<div class="tx"><b>${esc(a.title)}</b>
        <small><span class="kind">${esc(t('kinds')[a.kind] || a.kind)}</span> · ${esc(e?.name || '')} · ${esc(timeAgo(a.ts, getLang()))}</small></div></div>
        ${a.detail ? `<p class="detail">${esc(a.detail)}</p>` : ''}
        ${a.status === 'pending' ? `<div class="aa"><input class="input sm" placeholder="Note (optional)" data-note>
          <button class="btn ghost sm" data-no>${icon('x', 14)}${t('reject')}</button><button class="btn primary sm" data-yes>${icon('check', 14)}${t('approve')}</button></div>`
          : `<div class="verdict ${a.status}">${icon(a.status === 'approved' ? 'check' : 'x', 13)}${t(a.status)}${a.note ? ` · ${esc(a.note)}` : ''}</div>`}</div>`;
    }).join('')}</div>`).join('') : `<div class="empty">${icon('check', 28)}<div>${t('noApprovals')}</div></div>`;
  $$('.appr', list).forEach((card) => {
    const decide = async (approve) => {
      card.classList.add('deciding');
      try {
        await api(`/approvals/${card.dataset.a}`, 'POST', { approve, note: $('[data-note]', card)?.value || '' });
        toast(t(approve ? 'approved' : 'rejected'));
      } catch (err) { toast(err.message, true); card.classList.remove('deciding'); }
    };
    $('[data-yes]', card)?.addEventListener('click', () => decide(true));
    $('[data-no]', card)?.addEventListener('click', () => decide(false));
  });
}
