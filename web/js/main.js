import { t, L, getLang, setLang, applyDir } from './i18n.js';
import { icon, LOGO } from './icons.js';
import { store, boot, on, api, emp, room, people, spec, division, titleOf, rankOf, firstName } from './store.js';
import { $, $$, esc, avatar, toast, segIndicator } from './ui.js';
import { createScene } from './scene.js';
import { initWizard, openWizard, wizardOpen, focusMember, isDraftId } from './wizard.js';
import { initChat, openChat } from './chat.js';
import { initViews, renderOrg, renderWork, openDoc } from './views.js';
import { initWorkflows, renderWorkflows, openRun } from './workflows.js';
import { initPanels, togglePeople, peopleOpen, openActivity, openNotifications, refreshBadge, progressBlock, renderPeople } from './panels.js';
import { initSettings, renderSettings, loadHealth } from './settings.js';
import { modelLabel } from './models.js';
import { loadKeys, keyLine } from './keys.js';

applyDir();
$('#loaderMark').innerHTML = `${LOGO}<span>Office Mini</span>`;
$('#logo').innerHTML = LOGO;

// Company logo (Settings → Company): top bar, loading screen and the browser tab icon
const DEFAULT_ICON = `data:image/svg+xml,${encodeURIComponent(LOGO.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '))}`;
let brandV = null;
function applyBrand() {
  const v = store.org?.settings.logo_v || 0;
  if (v === brandV) return;
  brandV = v;
  const src = v ? `/api/logo?v=${v}` : null;
  const box = $('#logo');
  box.classList.toggle('has-img', !!src);
  box.innerHTML = src ? `<img src="${src}" alt="">` : LOGO;
  let link = document.querySelector('link[rel="icon"]');
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.append(link); }
  link.href = src || DEFAULT_ICON;
  try { localStorage.setItem('om-logo', src || ''); } catch { /* storage blocked */ }
}
// show the company logo on the loading screen straight away if we know it from last time
try { const last = localStorage.getItem('om-logo'); if (last) $('#loaderMark').innerHTML = `<img class="logo-img" src="${last}" alt=""><span>Office Mini</span>`; } catch { /* storage blocked */ }
const mobileQ = matchMedia('(max-width: 860px)');

// ---------------------------------------------------------------- drawer
const drawerEl = $('#drawer'), drawerBody = $('#drawerBody');
const drawer = {
  current: null,
  open({ kind, el, onClose }) {
    if (this.current) { const prev = this.current; this.current = null; prev.onClose?.(true); }
    drawerBody.innerHTML = ''; drawerBody.append(el);
    drawerEl.className = `drawer glass on ${kind}`;
    document.body.classList.add('drawer-open');
    this.current = { kind, onClose };
    closePopover();
    if (mobileQ.matches && peopleOpen()) togglePeople(false);
    insets();
  },
  close() {
    if (!this.current) return;
    const c = this.current; this.current = null;
    drawerEl.classList.remove('on');
    document.body.classList.remove('drawer-open');
    c.onClose?.(true);
    insets();
    setTimeout(() => { if (!this.current) drawerBody.innerHTML = ''; }, 600);
  },
};
$('#scrim').onclick = () => { if (mobileQ.matches && peopleOpen()) togglePeople(false); else drawer.close(); };

function insets() {
  const open = !!drawer.current;
  if (mobileQ.matches) {
    const bottom = open && drawer.current.kind === 'wizard' ? window.innerHeight * 0.64 : 0;
    scene.setInsets({ right: 0, left: 0, bottom });
  } else {
    const d = open ? drawerEl.offsetWidth + 24 : 0;
    const p = peopleOpen() ? $('#people').offsetWidth + 24 : 0;
    const rtl = document.documentElement.dir === 'rtl';
    scene.setInsets({ right: rtl ? p : d, left: rtl ? d : p, bottom: 0 });
  }
}

// ---------------------------------------------------------------- scene
const scene = createScene($('#stage'), {
  onPick: handlePick,
  division,
  icon,
  esc,
  text: (k, ...a) => t(k, ...a),
  statusOf: (id) => { const e = emp(id); return { status: e?.status || 'idle', task: e?.task || '' }; },
  roleShort: (m) => L(spec(m.specialty)?.title) || '',
  roomOf: (id) => emp(id)?.room_id,
  isDraft: (id) => isDraftId(id),
});
window.officeScene = scene;   // handy for debugging from the console
initWizard({ scene, drawer });
initChat({ drawer, editEmployee });
initViews({ showEmployee });
initPanels({ drawer, selectEmployee, openChat, onLayout: insets,
  openRun: (id) => { drawer.close(); openRun(id); }, setView: (v) => { drawer.close(); setView(v); } });
initWorkflows({ drawer, setView: (v) => setView(v), showEmployee, openDoc, openActivity });
initSettings({ setView, toggleLang, setMode, getMode });

// ---------------------------------------------------------------- light / dark
function getMode() { try { return localStorage.getItem('om-mode') || 'dark'; } catch { return 'dark'; } }
const lightQ = matchMedia('(prefers-color-scheme: light)');
function resolvedMode() { const m = getMode(); return m === 'auto' ? (lightQ.matches ? 'light' : 'dark') : m; }
function applyMode() {
  const r = resolvedMode();
  document.documentElement.dataset.mode = r;
  document.querySelector('meta[name="theme-color"]').content = r === 'light' ? '#eef1f8' : '#05060c';
  scene.setAppearance(r);
  $('#modeBtn').innerHTML = icon(r === 'light' ? 'moon' : 'sun', 18);
}
function setMode(m) { try { localStorage.setItem('om-mode', m); } catch { /* storage blocked */ } applyMode(); if (store.view === 'settings') renderSettings(true); }
lightQ.addEventListener('change', () => { if (getMode() === 'auto') applyMode(); });
$('#modeBtn').onclick = () => setMode(resolvedMode() === 'light' ? 'dark' : 'light');
applyMode();

function handlePick(p) {
  if (p.type === 'employee') {
    if (wizardOpen()) { if (isDraftId(p.id)) focusMember(p.id); return; }
    showEmployee(p.id, p.x, p.y);
  } else if (p.type === 'ghost') {
    if (wizardOpen()) return;
    openWizard({ placement: { floor: p.floor, slot: p.slot } });
  } else if (p.type === 'room') {
    if (wizardOpen()) return;
    showRoom(p.id, p.x, p.y);
    scene.focusRoom(p.id);
  } else {
    closePopover();
  }
}

function selectEmployee(id, x, y, fromPanel = false) {
  if (store.view !== 'building') setView('building');
  if (mobileQ.matches && peopleOpen()) togglePeople(false);
  scene.focusEmployee(id);
  showEmployee(id, mobileQ.matches ? null : x, mobileQ.matches ? null : y, fromPanel);
}

// ---------------------------------------------------------------- popovers
const pop = $('#popover');
let popFor = null;
function placePopover(x, y, side = false) {
  if (mobileQ.matches || x == null) { if (!mobileQ.matches) Object.assign(pop.style, { left: `${window.innerWidth / 2 - pop.offsetWidth / 2}px`, top: '90px' }); return; }
  const w = pop.offsetWidth, hgt = pop.offsetHeight, m = 14;
  let left, top, oy = '100%';
  if (side) { left = Math.min(window.innerWidth - w - m, x); top = Math.max(76, Math.min(window.innerHeight - hgt - m, y - hgt / 2)); oy = '50%'; }
  else {
    left = Math.min(window.innerWidth - w - m, Math.max(m, x - w / 2));
    top = y - hgt - 18;
    if (top < 76) { top = Math.min(window.innerHeight - hgt - m, y + 18); oy = '0%'; }
  }
  Object.assign(pop.style, { left: `${left}px`, top: `${top}px` });
  pop.style.setProperty('--ox', `${side ? 0 : x - left}px`); pop.style.setProperty('--oy', oy);
}
function closePopover() {
  pop.classList.remove('on');
  popFor = null;
  scene.select(null);
}

function showEmployee(id, x, y, side = false) {
  const e = emp(id);
  if (!e) return;
  const same = popFor?.type === 'emp' && popFor.id === id;
  popFor = { type: 'emp', id, x, y, side };
  const mgr = emp(e.reports_to);
  const div = division(e.room_division || e.division);
  const reports = e.direct_reports.map(emp).filter(Boolean);
  pop.innerHTML = `<div data-emp-id="${e.id}">
    <div class="pop-head">${avatar(e, 'lg', { crown: true })}<div style="min-width:0"><h3>${esc(e.name)}</h3><p>${esc(titleOf(e))}${rankOf(e) ? ` · ${esc(rankOf(e))}` : ''}</p></div></div>
    <div class="pop-meta">
      <div><span class="tagline" style="--c:${div?.color}">${icon(div?.icon || 'users', 12)} ${esc(L(div?.name))}</span><span style="color:var(--faint)">·</span><span>${esc(e.room_name || '')}</span></div>
      ${e.status === 'working' ? '' : `<div class="status-line"><span class="dot ${e.status || 'idle'}"></span>${esc(t(e.status || 'idle'))}</div>`}
      <div>${icon('org', 15)}<span class="k">${t('reportsTo')}</span>${mgr ? `${avatar(mgr, 'xs', { status: false })}<span>${esc(mgr.name)}</span>` : `<span>${t('owner')}</span>`}</div>
      ${reports.length ? `<div>${icon('users', 15)}<span class="k">${t('directReports')}</span><span style="display:flex;gap:3px">${reports.slice(0, 6).map((r) => avatar(r, 'xs', { status: false })).join('')}</span>${reports.length > 6 ? `<span>+${reports.length - 6}</span>` : ''}</div>` : ''}
      <div>${icon('cpu', 15)}<span class="k">${t('model')}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(modelLabel(e.model))}</span></div>
      <div>${icon('key', 15)}<span class="k">${t('apiKeyShort')}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(keyLine(e))}</span></div>
    </div>
    ${e.id !== 'gm' ? `<div class="pop-rank"><nav class="seg small" id="popRank">
        <button data-rank="lead" class="${e.is_lead ? 'on' : ''}">${icon('crown', 13)}${esc(rankName(2))}</button>
        <button data-rank="member" class="${e.is_lead ? '' : 'on'}">${icon('user', 13)}${esc(rankName(4))}</button></nav>
      <div id="popSucc"></div></div>` : ''}
    <div id="popProgress"></div>
    <div class="pop-actions three">
      <button class="btn primary" data-chat>${icon('message', 16)}${t('chat')}</button>
      <button class="btn ghost" data-edit>${icon('edit', 16)}${t('edit')}</button>
      <button class="btn ghost" data-act title="${esc(t('activity'))}">${icon('pulse', 16)}</button>
    </div></div>`;
  if (e.status === 'working') progressBlock(e, $('#popProgress', pop));
  $('[data-chat]', pop).onclick = () => { closePopover(); setView('building'); openChat(id); };
  $('[data-edit]', pop).onclick = () => { closePopover(); editEmployee(id); };
  $('[data-act]', pop).onclick = () => { closePopover(); openActivity(id); };
  bindRank(e);
  pop.classList.add('on');
  if (!same || !pop.style.left) placePopover(x, y, side);
  requestAnimationFrame(() => { const s = $('#popRank', pop); if (s) segIndicator(s); });
  scene.select(id);
}

const rankName = (lvl) => L(store.catalog.seniority.find((s) => s.level === lvl)?.name) || '';

// Promote / demote straight from the card. Promoting swaps with the current lead; demoting the lead needs a successor.
function bindRank(e) {
  const seg = $('#popRank', pop);
  if (!seg) return;
  const mates = people(e.room_id).filter((p) => p.id !== e.id);
  const apply = async (rank, successor) => {
    try {
      const r = await api(`/employees/${e.id}/rank`, 'POST', { rank, successor });
      const lead = r.org.employees.find((p) => p.id === r.lead), prev = r.org.employees.find((p) => p.id === r.previous);
      toast(prev ? t('rankSwapped', firstName(lead.name), firstName(prev.name)) : t('saved'));
    } catch (err) { toast(err.message, true); }
  };
  $$('[data-rank]', seg).forEach((b) => { b.onclick = () => {
    const rank = b.dataset.rank;
    if ((rank === 'lead') === !!e.is_lead) return;
    if (rank === 'lead' || mates.length === 1) { apply(rank, rank === 'member' ? mates[0].id : null); return; }
    // the lead steps down in a bigger room: choose who takes over
    $('#popSucc', pop).innerHTML = `<div class="succ"><span>${t('newLead')}</span>
      <select class="input sm" id="succSel">${mates.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
      <button class="btn primary sm" id="succGo">${icon('check', 14)}${t('swap')}</button></div>`;
    $('#succGo', pop).onclick = () => apply('member', $('#succSel', pop).value);
  }; });
}

function showRoom(id, x, y) {
  const r = room(id);
  if (!r) return;
  popFor = { type: 'room', id, x, y };
  const div = division(r.division);
  const ppl = people(id);
  const lead = ppl.find((p) => p.is_lead) || ppl[0];
  pop.innerHTML = `
    <div class="pop-head"><div class="av lg" style="--c:${r.accent}">${icon(r.kind === 'exec' ? 'crown' : div?.icon || 'users', 22)}</div>
      <div style="min-width:0"><h3>${esc(r.name)}</h3><p>${esc(L(div?.name))} · ${ppl.length}${r.vacancies ? ` · ${r.vacancies} ${t('vacant').toLowerCase()}` : ''}</p></div></div>
    <div class="pop-meta">${ppl.map((p) => `<div style="justify-content:space-between">
      <button class="room-person" data-open-emp="${p.id}" title="${esc(t('edit'))}">${avatar(p, 'sm', { crown: true })}<span style="min-width:0"><b>${esc(p.name)}</b><span>${esc(p.status === 'working' && p.task ? p.task : `${titleOf(p)}${p.is_lead ? ` · ${rankName(2)}` : ''}`)}</span></span></button>
      <button class="icon-btn" data-chat-id="${p.id}" title="${esc(t('chat'))}">${icon('message', 16)}</button></div>`).join('')}</div>
    <div class="pop-actions">${lead ? `<button class="btn primary" data-lead>${icon('message', 16)}${esc(firstName(lead.name))}</button>` : ''}<button class="btn ghost" data-edit>${icon('edit', 16)}${t('edit')}</button></div>`;
  $$('[data-chat-id]', pop).forEach((b) => { b.onclick = () => { closePopover(); openChat(b.dataset.chatId); }; });
  // tapping a name opens that person's card (rank switch, edit, chat, activity)
  $$('[data-open-emp]', pop).forEach((b) => { b.onclick = (ev) => { const r = b.getBoundingClientRect(); closePopover(); showEmployee(b.dataset.openEmp, mobileQ.matches ? null : r.left + r.width / 2, mobileQ.matches ? null : r.top, false); }; });
  $('[data-lead]', pop)?.addEventListener('click', () => { closePopover(); openChat(lead.id); });
  $('[data-edit]', pop).onclick = () => { closePopover(); openWizard({ roomId: id }); };
  pop.classList.add('on');
  placePopover(x, y);
}

function editEmployee(id) {
  const e = emp(id);
  if (!e) return;
  setView('building');
  openWizard({ roomId: e.room_id, focus: id });
}

document.addEventListener('pointerdown', (e) => {
  if (pop.classList.contains('on') && !pop.contains(e.target) && !e.target.closest('.room-chip, .node, .pp-item')) {
    if (e.target.tagName !== 'CANVAS') closePopover();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('#modal').classList.contains('on')) $('#modal').classList.remove('on');
  else if (pop.classList.contains('on')) closePopover();
  else if (drawer.current) drawer.close();
  else if (store.view !== 'building') setView('building');
});

// ---------------------------------------------------------------- top bar
function renderTop() {
  const org = store.org;
  $('#company').textContent = org.company;
  document.title = org.company;
  applyBrand();
  const working = org.employees.filter((e) => e.status === 'working').length;
  $('#stats').textContent = t('stats', org.employees.length, org.rooms.length, org.floors + 1) + (working ? ` · ${working} ${t('working').toLowerCase()}` : '');
  const seg = $('#viewSeg');
  seg.innerHTML = [['building', 'building'], ['org', 'org'], ['work', 'board'], ['workflows', 'zap']].map(([v, ic]) =>
    `<button data-view="${v}" class="${store.view === v ? 'on' : ''}">${icon(ic, 16)}<span>${t(v)}</span></button>`).join('');
  $$('[data-view]', seg).forEach((b) => { b.onclick = () => setView(b.dataset.view); });
  requestAnimationFrame(() => segIndicator(seg));
  $('#peopleBtn').innerHTML = icon('panel', 18);
  $('#peopleBtn').title = t('people');
  if (!$('#bellBtn svg')) $('#bellBtn').insertAdjacentHTML('afterbegin', icon('bell', 18));
  $('#bellBtn').title = t('notifications');
  $('#langBtn').innerHTML = `<span class="lang-glyph">${getLang() === 'ar' ? 'EN' : 'ع'}</span>`;
  $('#langBtn').title = t('language');
  $('#settingsBtn').innerHTML = icon('sliders', 18);
  $('#settingsBtn').title = t('settings');
  $('#fab').innerHTML = `<span class="plus">${icon('plus', 16)}</span>${t('addRoom')}`;
  $('#legend').innerHTML = ['working', 'idle', 'done', 'error'].map((s) => `<span><i class="dot ${s}"></i>${t(s)}</span>`).join('');
  $('#viewctl').innerHTML = `<button class="icon-btn" data-rot="-90" title="${esc(t('rotateL'))}">${icon('rotl', 17)}</button>
    <button class="icon-btn" data-reset title="${esc(t('resetView'))}">${icon('target', 17)}</button>
    <button class="icon-btn" data-rot="90" title="${esc(t('rotateR'))}">${icon('rotr', 17)}</button>`;
  $$('[data-rot]', $('#viewctl')).forEach((b) => { b.onclick = () => scene.rotate(+b.dataset.rot); });
  $('[data-reset]', $('#viewctl')).onclick = () => scene.resetView();
  renderQuota();
}
function renderQuota() {
  const q = store.quota;
  const el = $('#quota');
  if (!q || q.remaining == null) return;
  const C = 2 * Math.PI * 8, frac = Math.max(0, Math.min(1, q.remaining / (q.limit || 50)));
  el.hidden = false;
  el.title = t('quotaTip');
  el.classList.toggle('low', q.remaining <= 10);
  el.innerHTML = `<svg width="22" height="22" viewBox="0 0 22 22"><circle class="track" cx="11" cy="11" r="8" fill="none" stroke-width="3"/>
    <circle class="val" cx="11" cy="11" r="8" fill="none" stroke-width="3" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - frac)}"/></svg>
    <span>${q.remaining}</span><span class="lbl">/ ${q.limit}</span>`;
}

function setView(v) {
  store.view = v;
  for (const name of ['org', 'work', 'workflows', 'settings']) {
    document.body.classList.toggle(`view-${name}`, v === name);
    $(`#view-${name}`).classList.toggle('on', v === name);
  }
  $$('#viewSeg [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  segIndicator($('#viewSeg'));
  closePopover();
  if (v !== 'building' && drawer.current?.kind === 'wizard') drawer.close();
  if (v === 'org') renderOrg();
  if (v === 'work') renderWork();
  if (v === 'workflows') renderWorkflows();
  if (v === 'settings') renderSettings();
}

function toggleLang() {
  setLang(getLang() === 'ar' ? 'en' : 'ar');
  applyDir();
  drawer.close(); closePopover();
  $('#view-work').innerHTML = '';
  $('#people').innerHTML = '';
  renderTop();
  scene.render(store.org);
  insets();
  renderPeople();
  if (store.view === 'org') renderOrg(); else if (store.view === 'work') renderWork(); else if (store.view === 'workflows') renderWorkflows(); else if (store.view === 'settings') renderSettings(true);
}

$('#fab').onclick = () => openWizard();
$('#langBtn').onclick = toggleLang;
$('#settingsBtn').onclick = () => setView(store.view === 'settings' ? 'building' : 'settings');
$('#bellBtn').onclick = () => openNotifications();
$('#peopleBtn').onclick = () => togglePeople();

// ---------------------------------------------------------------- live events
on('org', () => {
  renderTop();
  if (!wizardOpen()) scene.render(store.org);
  if (popFor?.type === 'emp') { if (emp(popFor.id)) showEmployee(popFor.id, popFor.x, popFor.y, popFor.side); else closePopover(); }
});
on('status', (e) => {
  scene.setStatus(e.id, e.status, e.task);
  if (popFor?.type === 'emp' && popFor.id === e.id) showEmployee(e.id, popFor.x, popFor.y, popFor.side);
  const working = store.org.employees.filter((x) => x.status === 'working').length;
  $('#stats').textContent = t('stats', store.org.employees.length, store.org.rooms.length, store.org.floors + 1) + (working ? ` · ${working} ${t('working').toLowerCase()}` : '');
});
on('handoff', (e) => scene.handoff(e.from, e.to, 'handoff'));
on('report', (e) => scene.handoff(e.from, e.to, 'report'));
on('quota', renderQuota);
on('online', (ok) => { if (!ok) toast(t('offline'), true); });
mobileQ.addEventListener('change', insets);
window.addEventListener('resize', () => { if (popFor) closePopover(); });

// ---------------------------------------------------------------- go
(async () => {
  try {
    await boot();
  } catch (e) {
    $('#loaderMark span').textContent = e.message;
    return;
  }
  renderTop();
  if (peopleOpen() && !mobileQ.matches) togglePeople(true); else if (peopleOpen()) togglePeople(false);
  refreshBadge();
  loadKeys();
  loadHealth();
  setInterval(loadHealth, 5 * 60 * 1000);
  setTimeout(() => $('#loader').classList.add('off'), 250);
})();
