// Room setup wizard: the same 5 steps for creating and editing a room.
import { t, L, getLang } from './i18n.js';
import { icon } from './icons.js';
import { store, api, people, room as roomOf, spec, division, emp, setOrg, titleOf } from './store.js';
import { $, $$, h, esc, avatar, toast, segIndicator, confirmBox, inkFor } from './ui.js';
import { lookFor } from './scene.js';
import { modelButton, pickModel } from './models.js';
import { kbBlock, uploadStaged } from './kbui.js';
import { keySelect, roomKeySelect, parseKeyChoice, providerOf } from './keys.js';

const DIV_ROLES = {
  product: ['product_manager', 'project_manager', 'technical_writer'],
  engineering: ['engineering_manager', 'fullstack_engineer', 'frontend_engineer', 'backend_engineer', 'devops_engineer', 'qa_engineer', 'mobile_engineer', 'security_engineer', 'ml_engineer', 'software_architect'],
  research: ['rd_researcher', 'competitor_researcher', 'data_analyst'],
  design: ['ui_designer', 'ux_researcher', 'technical_writer'],
  marketing: ['marketing_manager', 'content_marketer', 'seo_specialist', 'growth_marketer'],
  sales: ['sales_executive', 'customer_success', 'support_specialist'],
  operations: ['email_manager', 'finance_analyst', 'hr_recruiter', 'legal_counsel'],
};
const STEPS = 5;
const TAB_ICONS = ['users', 'layers', 'crown', 'user', 'check'];
let W = null;        // wizard state while open
let ctx = null;      // { scene, drawer }

export function initWizard(c) { ctx = c; }
export const wizardOpen = () => !!W;
export const isDraftId = (id) => !!W && W.d.members.some((m) => (m.id || '') === id);

// ---------------------------------------------------------------- helpers
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function usedNames() {
  return new Set([...store.org.employees.map((e) => e.name), ...(W ? W.d.members.map((m) => m.name) : [])]);
}
function newName() {
  const used = usedNames();
  for (let i = 0; i < 60; i++) {
    const n = `${pick(store.catalog.first_names)} ${pick(store.catalog.last_names)}`;
    if (!used.has(n)) return n;
  }
  return `${pick(store.catalog.first_names)} ${pick(store.catalog.last_names)}`;
}
function distinctColors(n, avoid = []) {
  const pal = store.catalog.palette.filter((c) => !avoid.includes(c));
  const out = [];
  const shuffled = [...pal].sort(() => Math.random() - 0.5);
  for (let i = 0; i < n; i++) out.push(shuffled[i % shuffled.length]);
  return out;
}
const roleFor = (div, k) => (DIV_ROLES[div] || DIV_ROLES.engineering)[k % (DIV_ROLES[div] || DIV_ROLES.engineering).length];
const count = () => W.d.desks * W.d.per;

function makeMember(k) {
  const d = W.d;
  const color = d.colorMode === 'uniform' ? d.uniformColor : pick(store.catalog.palette);
  const specialty = d.composition === 'same' ? d.sameSpec : roleFor(d.division, k);
  return { id: null, name: newName(), specialty, seniority: k === 0 ? 2 : 4, color, instructions: '', model: '', staged: [] };
}

// fill = add people to empty seats; editing a room with vacancies keeps them vacant until asked
function syncSeats(fill = true) {
  const d = W.d;
  const n = count();
  if (fill) while (d.members.length < n) d.members.push(makeMember(d.members.length));
  if (d.members.length > n) d.members.length = n;
  // every team room has exactly one team lead
  if (d.leadSeat < 0 || d.leadSeat >= d.members.length) d.leadSeat = 0;
}
const rankName = (lead) => L(store.catalog.seniority.find((s) => s.level === (lead ? 2 : 4))?.name) || '';

function payload() {
  const d = W.d;
  const members = d.members.map((m, k) => ({
    id: m.id || undefined, desk: Math.floor(k / d.per), seat: k % d.per, name: m.name.trim(),
    specialty: W.exec ? 'general_manager' : (d.composition === 'same' ? d.sameSpec : m.specialty),
    seniority: W.exec ? 0 : (k === d.leadSeat ? 2 : 4),   // rank follows the lead pick
    color: m.color, instructions: m.instructions, is_lead: k === d.leadSeat, model: m.model || '', api_key_id: m.api_key_id || null,
  }));
  return {
    room: {
      name: d.name.trim(), division: d.division, accent: d.accent, desks: d.desks, per_desk: d.per, theme: d.theme,
      color_mode: d.colorMode, uniform_color: d.uniformColor, composition: d.composition,
      floor: d.placement.floor, slot: d.placement.slot, api_key_id: d.apiKey || null,
    },
    members, lead_reports_to: W.exec ? null : d.leadReportsTo,
  };
}

function draftForScene() {
  const d = W.d;
  const p = payload();
  return {
    roomId: W.roomId, exec: W.exec,
    room: { name: d.name.trim() || t('preview'), division: d.division, accent: d.accent, desks: d.desks, per_desk: d.per, theme: d.theme },
    members: p.members.map((m, k) => ({ ...m, id: d.members[k].id || `__d${k}`, look: d.members[k].look || lookFor(m) })),
    placement: d.placement,
  };
}

let previewTimer = null;
function preview(focus = false) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    if (!W) return;
    ctx.scene.render(store.org, draftForScene());
    if (focus) setTimeout(() => ctx.scene.focusPreview(), 120);
  }, 90);
}

// ---------------------------------------------------------------- open / close
export function openWizard({ roomId = null, placement = null, focus = null, step = null } = {}) {
  if (ctx.drawer.current?.kind === 'wizard') ctx.drawer.current.onClose = null;  // replacing an open wizard
  const r = roomId ? roomOf(roomId) : null;
  if (r) {
    const ppl = people(r.id);
    const lead = ppl.findIndex((p) => p.is_lead);
    W = {
      mode: 'edit', roomId: r.id, exec: r.kind === 'exec', step: step ?? 0, maxStep: STEPS - 1, rolesTouched: true, accentTouched: true,
      d: {
        name: r.name, division: r.division, accent: r.accent, placement: { floor: 'keep' }, desks: r.desks, per: r.per_desk,
        composition: r.composition, sameSpec: ppl[0]?.specialty || 'fullstack_engineer', colorMode: r.color_mode || 'individual',
        uniformColor: r.uniform_color || ppl[0]?.color || store.catalog.palette[0], leadSeat: Math.max(0, lead),
        leadReportsTo: (ppl[lead] || ppl[0])?.reports_to || 'gm', theme: r.theme || 'modern', staged: [], apiKey: r.api_key_id || null,
        members: ppl.map((p) => ({ id: p.id, name: p.name, specialty: p.specialty, seniority: p.seniority, color: p.color, instructions: p.instructions || '', look: p.look, model: p.model || '', api_key_id: p.api_key_id || null, staged: [] })),
      },
    };
  } else {
    const div = 'engineering';
    W = {
      mode: 'create', roomId: null, exec: false, step: 0, maxStep: 0, rolesTouched: false, accentTouched: false,
      d: {
        name: '', division: div, accent: division(div).color, placement: placement || { floor: 'auto' }, desks: 1, per: 2,
        composition: 'mixed', sameSpec: roleFor(div, 1), colorMode: 'individual', uniformColor: division(div).color,
        leadSeat: 0, leadReportsTo: 'gm', members: [], theme: 'modern', staged: [],
      },
    };
    syncSeats();
    const cols = distinctColors(W.d.members.length);
    W.d.members.forEach((m, k) => { m.color = cols[k]; });
  }
  render();
  ctx.drawer.open({ kind: 'wizard', el: W.el, onClose: closeWizard });
  preview(true);
  if (focus) setTimeout(() => focusMember(focus), 380);
}

export function closeWizard(fromDrawer = false) {
  if (!W) return;
  W = null;
  if (!fromDrawer) ctx.drawer.close();
  ctx.scene.render(store.org);
  ctx.scene.resetView();
}

export function focusMember(id) {
  if (!W) return;
  const k = W.d.members.findIndex((m) => m.id === id);
  if (k < 0) return;
  go(3);
  setTimeout(() => {
    const row = $(`.prow[data-k="${k}"]`, W.el);
    if (!row) return;
    const more = $(`[data-more="${k}"]`, row);   // open their details (role, model, key, files, move)
    if (more) more.hidden = false;
    row.scrollIntoView({ behavior: 'smooth', block: 'start' });
    row.classList.add('flash');
    $('input', row)?.focus({ preventScroll: true });
    setTimeout(() => row.classList.remove('flash'), 1600);
  }, 360);
}

// ---------------------------------------------------------------- shell
function render() {
  const title = W.mode === 'edit' ? t('editRoomTitle', W.d.name) : t('newRoomTitle');
  const el = h(`<div style="display:flex;flex-direction:column;height:100%;min-height:0">
    <div class="d-head">
      <div class="av" style="--c:${W.d.accent}">${icon(W.exec ? 'crown' : 'layers', 18)}</div>
      <div class="txt"><h3 id="wzTitle">${esc(title)}</h3><p id="wzHint">${esc(t('stepHint')[W.step])}</p></div>
      <button class="icon-btn" data-close>${icon('x', 18)}</button>
    </div>
    <nav class="wz-tabs" id="wzSteps" role="tablist"></nav>
    <div class="d-body"><div class="steps">${[0, 1, 2, 3, 4].map((i) => `<div class="step scroll" data-step="${i}"></div>`).join('')}</div></div>
    <div class="d-foot"><div class="err" id="wzErr"></div><div class="wiz-foot" id="wzFoot"></div></div>
  </div>`);
  W.el = el;
  $('[data-close]', el).onclick = () => closeWizard();
  paint();
}

function paint() {
  const el = W.el;
  // clickable tabs: jump straight to any section (moving forward still checks what's required)
  $('#wzSteps', el).innerHTML = t('steps').map((s, i) => `<button role="tab" aria-selected="${i === W.step}" data-go="${i}" class="wz-tab${i === W.step ? ' on' : ''}${i <= W.maxStep && i !== W.step ? ' seen' : ''}">
    ${icon(TAB_ICONS[i], 15)}<span>${esc(s)}</span></button>`).join('');
  $$('[data-go]', el).forEach((b) => { b.onclick = () => go(+b.dataset.go); });
  $('#wzHint', el).textContent = t('stepHint')[W.step];
  $$('.step', el).forEach((s) => {
    const i = +s.dataset.step;
    s.classList.toggle('on', i === W.step);
    s.classList.toggle('past', i < W.step);
  });
  renderStep(W.step);
  const last = W.step === STEPS - 1;
  // Previous · Next · Save — save is available from any section
  $('#wzFoot', el).innerHTML = `
    <button class="btn quiet" data-back ${W.step === 0 ? 'disabled' : ''}>${icon('left', 16)}<span>${t('previous')}</span></button>
    <div class="sp"></div>
    <button class="btn ghost" data-next ${last ? 'disabled' : ''}><span>${t('nextTab')}</span>${icon('right', 16)}</button>
    <button class="btn primary" data-submit>${icon(W.mode === 'edit' ? 'check' : 'sparkles', 16)}<span>${t(W.mode === 'edit' ? 'saveShort' : 'create')}</span></button>`;
  $('[data-back]', el)?.addEventListener('click', () => go(W.step - 1));
  $('[data-cancel]', el)?.addEventListener('click', () => closeWizard());
  $('[data-next]', el)?.addEventListener('click', () => go(W.step + 1));
  $('[data-submit]', el)?.addEventListener('click', submit);
}

function validate(step) {
  if (step >= 0 && !W.d.name.trim()) return t('roomName');
  if (step >= 1 && !W.exec && W.d.members.length < 2) return t('needTwo');
  if (step >= 3 && W.d.members.some((m) => !m.name.trim())) return t('name');
  return null;
}

function go(step) {
  if (!W) return;
  step = Math.max(0, Math.min(STEPS - 1, step));
  if (step > W.step) {
    const bad = validate(step - 1);   // everything before the target section must be valid
    if (bad) { showErr(`${bad} ✱`); $(`.step.on input`, W.el)?.focus(); return; }
  }
  showErr('');
  W.step = step;
  W.maxStep = Math.max(W.maxStep, step);
  paint();
  $(`.step[data-step="${step}"]`, W.el).scrollTop = 0;
}
const showErr = (m) => { const e = $('#wzErr', W.el); if (e) e.textContent = m; };

function renderStep(i) {
  const box = $(`.step[data-step="${i}"]`, W.el);
  [stepTeam, stepLayout, stepRoles, stepPeople, stepReview][i](box);
}

// ---------------------------------------------------------------- step 1: team
function stepTeam(box) {
  const d = W.d;
  const divs = store.catalog.divisions.filter((x) => (W.exec ? x.id === 'executive' : x.id !== 'executive'));
  const free = store.org.free_slots;
  const floors = store.org.floors;
  const floorPills = [];
  if (W.mode === 'edit' && !W.exec) floorPills.push({ v: 'keep', label: t('keep') });
  if (!W.exec) {
    floorPills.push({ v: 'auto', label: t('auto') });
    for (let f = 0; f < floors; f++) {
      const n = free.filter((s) => s.floor === f).length;
      floorPills.push({ v: f, label: t('floorLabel', f + 1), sub: n ? `${n}` : t('fullFloor'), disabled: !n });
    }
    floorPills.push({ v: 'new', label: t('newFloor') });
  }
  const palette = [...new Set([division(d.division)?.color, ...store.catalog.palette])].filter(Boolean);
  box.innerHTML = `
    <div class="field"><label>${t('roomName')}</label>
      <input class="input" id="fName" maxlength="40" placeholder="${esc(t('roomNamePh'))}" value="${esc(d.name)}"></div>
    <div class="field"><label>${t('division')}</label>
      <div class="div-grid">${divs.map((x) => `<button class="div-card${x.id === d.division ? ' on' : ''}" data-div="${x.id}" style="--c:${x.color}" ${W.exec ? 'disabled' : ''}>
        <span class="ico">${icon(x.icon, 16)}</span><span>${esc(L(x.name))}</span></button>`).join('')}</div></div>
    ${W.exec ? `<div class="field"><div class="help">${icon('info', 14)} ${t('lockedExec')}</div></div>` : `
    <div class="field"><label>${t('placement')}</label>
      <div class="pills">${floorPills.map((p) => `<button class="pill${String(p.v) === String(d.placement.floor) ? ' on' : ''}" data-place="${p.v}" ${p.disabled ? 'disabled' : ''}>${esc(p.label)}${p.sub ? ` <small>${esc(p.sub)}</small>` : ''}</button>`).join('')}</div></div>`}
    <div class="field"><label>${icon('palette', 14)} ${t('theme')}</label>
      <div class="theme-grid">${store.catalog.themes.map((th) => `<button class="theme-card th-${th}${th === d.theme ? ' on' : ''}" data-rtheme="${th}">${esc(t('themes')[th] || th)}</button>`).join('')}</div></div>
    <div class="field"><label>${t('accent')}</label>
      <div class="swatches">${palette.map((c) => `<button class="sw-btn${c === d.accent ? ' on' : ''}" data-acc="${c}" style="--c:${c}" aria-label="${c}"></button>`).join('')}</div></div>
    ${W.exec ? '' : `<div class="field"><label class="lbl-ic">${icon('key', 14)}<span>${t('roomKey')}</span></label>${roomKeySelect(d.apiKey, 'id="roomKey"')}
      <div class="help">${t('roomKeyHelp')}</div></div>`}
    <div class="field"><label class="lbl-ic">${icon('clip', 14)}<span>${t('kbRoom')}</span></label>${kbBlock({ scopeType: 'room', scopeId: W.roomId, staged: d.staged })}</div>`;
  $$('[data-rtheme]', box).forEach((b) => b.onclick = () => { d.theme = b.dataset.rtheme; $$('[data-rtheme]', box).forEach((x) => x.classList.toggle('on', x === b)); preview(); });
  const name = $('#fName', box);
  name.oninput = () => { d.name = name.value; $('#wzTitle', W.el).textContent = W.mode === 'edit' ? t('editRoomTitle', d.name) : t('newRoomTitle'); showErr(''); preview(); };
  name.onkeydown = (e) => { if (e.key === 'Enter') go(1); };
  if (W.mode === 'create') setTimeout(() => name.focus({ preventScroll: true }), 420);
  $$('[data-div]', box).forEach((b) => b.onclick = () => {
    d.division = b.dataset.div;
    if (!W.accentTouched) { d.accent = division(d.division).color; if (d.colorMode === 'uniform') d.uniformColor = d.accent; }
    if (!W.rolesTouched) { d.members.forEach((m, k) => { m.specialty = roleFor(d.division, k); }); d.sameSpec = roleFor(d.division, 1); }
    stepTeam(box); preview();
  });
  $$('[data-place]', box).forEach((b) => b.onclick = () => {
    const v = b.dataset.place;
    d.placement = { floor: ['auto', 'new', 'keep'].includes(v) ? v : +v };
    stepTeam(box); preview(true);
  });
  $$('[data-acc]', box).forEach((b) => b.onclick = () => { d.accent = b.dataset.acc; W.accentTouched = true; $('.d-head .av', W.el).style.setProperty('--c', d.accent); stepTeam(box); preview(); });
  $('#roomKey', box)?.addEventListener('change', (e) => { d.apiKey = e.target.value ? +e.target.value : null; });
}

// ---------------------------------------------------------------- step 2: layout
function seatMap() {
  const d = W.d;
  let html = '';
  for (let r = 0; r < d.desks; r++) {
    const ppl = d.members.slice(r * d.per, r * d.per + d.per);
    html += `<div class="seatrow"><div class="people">${ppl.map((m, j) => {
      const k = r * d.per + j;
      return `<div class="seat" style="animation-delay:${k * 40}ms">${avatar({ ...m, id: m.id || `__${k}`, is_lead: k === d.leadSeat }, 'sm', { status: false, crown: true })}</div>`;
    }).join('')}</div><div class="desk" style="width:${d.per * 36 + 20}px"></div></div>`;
  }
  return `<div class="seatmap" style="--acc:${d.accent}">${html}</div><div class="cap">${t('capacity', count()).replace(/^(\d+)/, '<b>$1</b>')}</div>`;
}
function stepLayout(box) {
  const d = W.d;
  // never fewer than 2 seats: a team lead plus at least one team member
  const shrinkOk = (key) => (key === 'desks' ? (d.desks - 1) * d.per : d.desks * (d.per - 1)) >= 2;
  const ctl = (key, val, min, max) => `<div class="stepper-ctl"><button data-dec="${key}" ${val <= min || W.exec || !shrinkOk(key) ? 'disabled' : ''}>${icon('minus', 16)}</button><output>${val}</output><button data-inc="${key}" ${val >= max || W.exec ? 'disabled' : ''}>${icon('plus', 16)}</button></div>`;
  box.innerHTML = `
    ${W.exec ? `<div class="field"><div class="help">${icon('info', 14)} ${t('lockedExec')}</div></div>` : ''}
    <div class="two">
      <div class="field"><label>${t('desks')}</label>${ctl('desks', d.desks, 1, 3)}</div>
      <div class="field"><label>${t('perDesk')}</label>${ctl('per', d.per, 1, 4)}</div>
    </div>
    <div id="seatmap">${seatMap()}</div>
    ${W.exec ? '' : `<div class="help" style="text-align:center;margin-top:8px">${icon('crown', 13)} ${t('needTwo')}</div>`}
    ${d.members.length < count() ? `<div class="help" style="display:flex;align-items:center;gap:10px;justify-content:center;margin-top:12px">
      ${count() - d.members.length} ${t('vacant').toLowerCase()} <button class="btn ghost sm" id="fillSeats">${icon('plus', 14)}${t('addRoom').split(' ')[0]}</button></div>` : ''}`;
  $('#fillSeats', box)?.addEventListener('click', () => { syncSeats(true); stepLayout(box); preview(); });
  const change = (key, delta) => {
    const before = count();
    d[key] = Math.max(1, Math.min(key === 'desks' ? 3 : 4, d[key] + delta));
    syncSeats(count() > before && d.members.length >= before);
    if (d.colorMode === 'random') d.members.forEach((m) => { m.color = m.color || pick(store.catalog.palette); });
    stepLayout(box); preview(true);
  };
  $$('[data-inc]', box).forEach((b) => b.onclick = () => change(b.dataset.inc, 1));
  $$('[data-dec]', box).forEach((b) => b.onclick = () => change(b.dataset.dec, -1));
}

// ---------------------------------------------------------------- step 3: roles
function specOptions(selected) {
  return store.catalog.divisions.filter((x) => x.id !== 'executive').map((x) => `<optgroup label="${esc(L(x.name))}">${
    store.catalog.specialties.filter((s) => s.division === x.id).map((s) => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${esc(L(s.title))}</option>`).join('')}</optgroup>`).join('');
}
function managers() {
  const inRoom = new Set(W.d.members.map((m) => m.id).filter(Boolean));
  return store.org.employees.filter((e) => !inRoom.has(e.id)).sort((a, b) => a.seniority - b.seniority || a.name.localeCompare(b.name));
}
function roleList(box) {
  const d = W.d;
  const q = ($('#roleQ', box)?.value || '').toLowerCase();
  const own = store.catalog.specialties.filter((s) => s.division === d.division);
  const other = store.catalog.specialties.filter((s) => s.division !== d.division && s.division !== 'executive');
  const match = (s) => !q || L(s.title).toLowerCase().includes(q) || s.title.en.toLowerCase().includes(q);
  const opt = (s) => { const dv = division(s.division); return `<button class="role-opt${s.id === d.sameSpec ? ' on' : ''}" data-spec="${s.id}"><span class="ico" style="--c:${dv.color}">${icon(dv.icon, 14)}</span>${esc(L(s.title))}<small>${esc(L(dv.name))}</small></button>`; };
  const a = own.filter(match), b = other.filter(match);
  return `${a.length ? `<div class="group-label">${esc(L(division(d.division).name))}</div>${a.map(opt).join('')}` : ''}${b.length ? `<div class="group-label">${esc(t('mixed'))}</div>${b.map(opt).join('')}` : ''}`;
}
function stepRoles(box) {
  const d = W.d;
  if (W.exec) {
    box.innerHTML = `<div class="field"><div class="help">${icon('info', 14)} ${t('lockedExec')}</div></div>
      <div class="prow"><div>${avatar({ ...d.members[0], id: 'gm', is_lead: true }, '', { status: false, crown: true })}</div>
      <div><b>${esc(d.members[0].name)}</b><div class="help" style="margin:0">${esc(L(spec('general_manager').title))} · ${esc(L(store.catalog.seniority[0].name))}</div></div></div>`;
    return;
  }
  const mgrs = managers();
  box.innerHTML = `
    <div class="field"><label>${t('composition')}</label>
      <nav class="seg small" id="compSeg"><button data-comp="same" class="${d.composition === 'same' ? 'on' : ''}">${icon('users', 14)}${t('same')}</button><button data-comp="mixed" class="${d.composition === 'mixed' ? 'on' : ''}">${icon('layers', 14)}${t('mixed')}</button></nav></div>
    ${d.composition === 'same' ? `
      <div class="field"><label>${t('specialty')}</label>
        <input class="input sm" id="roleQ" placeholder="${esc(t('searchRoles'))}" style="margin-bottom:8px">
        <div class="search-list scroll" id="roleList">${roleList(box)}</div></div>` : ''}
    <div class="field"><label>${t('team')}</label><div class="rows">${d.members.map((m, k) => `
      <div class="prow" data-k="${k}">${avatar({ ...m, id: m.id || `__${k}`, is_lead: k === d.leadSeat }, 'sm', { status: false, crown: true })}
        <div class="grid">
          <div class="seatlbl"><span>${esc(m.name)}</span><span>${t('seat', Math.floor(k / d.per) + 1, (k % d.per) + 1)}</span></div>
          ${d.composition === 'mixed' ? `<select class="input sm" data-spec-k="${k}">${specOptions(m.specialty)}</select>` : `<div class="input sm" style="display:flex;align-items:center;opacity:.7;overflow:hidden;white-space:nowrap">${esc(L(spec(d.sameSpec)?.title))}</div>`}
          <span class="rank-chip${k === d.leadSeat ? ' lead' : ''}">${icon(k === d.leadSeat ? 'crown' : 'user', 12)}${esc(rankName(k === d.leadSeat))}</span>
        </div></div>`).join('')}</div></div>
    <div class="two">
      <div class="field"><label>${t('leadPick')}</label>
        <select class="input" id="leadSel">${d.members.map((m, k) => `<option value="${k}" ${k === d.leadSeat ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
      <div class="field"><label>${t('teamReportsTo')}</label>
        <select class="input" id="bossSel">${mgrs.map((e) => `<option value="${e.id}" ${e.id === d.leadReportsTo ? 'selected' : ''}>${esc(e.name)} · ${esc(titleOf(e))}</option>`).join('')}</select></div>
    </div>
    <div class="help" style="margin-top:-8px">${icon('info', 13)} ${t('leadHelp')}</div>`;
  const seg = $('#compSeg', box);
  requestAnimationFrame(() => segIndicator(seg));
  $$('[data-comp]', box).forEach((b) => b.onclick = () => {
    d.composition = b.dataset.comp; W.rolesTouched = true;
    if (d.composition === 'same') d.sameSpec = d.members[Math.min(1, d.members.length - 1)]?.specialty || d.sameSpec;
    stepRoles(box); preview();
  });
  const q = $('#roleQ', box);
  if (q) q.oninput = () => { $('#roleList', box).innerHTML = roleList(box); bindRoles(); };
  const bindRoles = () => $$('[data-spec]', box).forEach((b) => b.onclick = () => {
    d.sameSpec = b.dataset.spec; W.rolesTouched = true;
    $$('[data-spec]', box).forEach((x) => x.classList.toggle('on', x === b)); stepRolesRows(box); preview();
  });
  bindRoles();
  $$('[data-spec-k]', box).forEach((s) => s.onchange = () => { d.members[+s.dataset.specK].specialty = s.value; W.rolesTouched = true; preview(); });
  $('#leadSel', box).onchange = (e) => {
    d.leadSeat = Math.max(0, +e.target.value);
    stepRoles(box); preview();
  };
  $('#bossSel', box).onchange = (e) => { d.leadReportsTo = e.target.value; };
}
function stepRolesRows(box) {
  $$('.prow .input.sm:not(select)', box).forEach((x) => { x.textContent = L(spec(W.d.sameSpec)?.title); });
}

// ---------------------------------------------------------------- step 4: people
function stepPeople(box) {
  const d = W.d;
  const pal = store.catalog.palette;
  box.innerHTML = `
    <div class="field"><label>${t('colors')}${d.colorMode === 'random' ? `<button class="link" id="reroll">${icon('dice', 14)} ${t('reroll')}</button>` : ''}</label>
      <nav class="seg small" id="colSeg">
        <button data-cm="individual" class="${d.colorMode === 'individual' ? 'on' : ''}">${icon('user', 14)}${t('individual')}</button>
        <button data-cm="uniform" class="${d.colorMode === 'uniform' ? 'on' : ''}">${icon('drop', 14)}${t('uniform')}</button>
        <button data-cm="random" class="${d.colorMode === 'random' ? 'on' : ''}">${icon('shuffle', 14)}${t('random')}</button></nav>
      ${d.colorMode === 'uniform' ? `<div class="swatches" style="margin-top:12px">${pal.map((c) => `<button class="sw-btn${c === d.uniformColor ? ' on' : ''}" data-uc="${c}" style="--c:${c}"></button>`).join('')}</div>` : ''}
    </div>
    <div class="field"><label>${t('reviewPeople')}<button class="link" id="shuffleNames">${icon('shuffle', 14)} ${t('shuffleNames')}</button></label>
      <div class="rows">${d.members.map((m, k) => `
        <div class="prow" data-k="${k}">${avatar({ ...m, id: m.id || `__${k}`, is_lead: k === d.leadSeat }, '', { status: false, crown: true })}
          <div class="grid" style="grid-template-columns:1fr">
            <input class="input sm" data-name-k="${k}" value="${esc(m.name)}" maxlength="40" placeholder="${esc(t('name'))}">
            <div class="seatlbl" style="margin-top:2px"><span>${esc(L(spec(specOf(m))?.title))}</span>
              <button class="link" data-notes-k="${k}">${icon('sliders', 12)} ${getLang() === 'ar' ? 'التفاصيل' : 'Details'}</button></div>
            ${d.colorMode === 'individual' ? `<div class="swatches">${pal.map((c) => `<button class="sw-btn${c === m.color ? ' on' : ''}" data-c-k="${k}" data-c="${c}" style="--c:${c}"></button>`).join('')}</div>` : ''}
            <div class="more person-more" data-more="${k}" hidden>
              <div class="lbl">${t('roleDesc')}</div>
              <textarea class="input" data-ins-k="${k}" rows="3" placeholder="${esc(t('roleDescPh'))}">${esc(m.instructions)}</textarea>
              <div class="lbl">${t('model')}</div><div data-model-k="${k}">${modelButton(m.model, specOf(m), (ref) => { m.model = ref; m.api_key_id = null; reopenDetails(k); })}</div>
              <div class="lbl">${t('apiKey')}</div>${keySelect({ model: m.model, current: m.api_key_id, roomKey: W.exec ? null : d.apiKey, attrs: `data-key-k="${k}"` })}
              <div class="lbl">${t('knowledge')}</div>${kbBlock({ scopeType: 'employee', scopeId: m.id, staged: m.staged || (m.staged = []), compact: true })}
              ${W.mode === 'edit' && m.id && !W.exec ? `<div class="lbl">${t('moveTo')}</div>
                <div class="move-row"><select class="input sm" data-move-sel="${k}">${store.org.rooms.filter((r) => r.kind === 'team' && r.id !== W.roomId).map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select>
                  <button class="btn ghost sm" data-move="${k}">${icon('move', 14)}${t('moveBtn')}</button></div>
                <button class="btn danger sm" data-fire="${k}" style="justify-self:start">${icon('trash', 14)}${t('letGo')}</button>` : ''}
            </div>
          </div></div>`).join('')}</div></div>`;
  requestAnimationFrame(() => segIndicator($('#colSeg', box)));
  const refreshAv = (k) => {
    const m = d.members[k];
    const av = $(`.prow[data-k="${k}"] .av`, box);
    if (av) { av.style.setProperty('--c', m.color); av.style.setProperty('--fg', inkFor(m.color)); av.firstChild.textContent =m.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase(); }
  };
  $$('[data-cm]', box).forEach((b) => b.onclick = () => {
    d.colorMode = b.dataset.cm;
    if (d.colorMode === 'uniform') d.members.forEach((m) => { m.color = d.uniformColor; });
    if (d.colorMode === 'random') d.members.forEach((m) => { m.color = pick(pal); });
    if (d.colorMode === 'individual') { const cols = distinctColors(d.members.length); d.members.forEach((m, k) => { m.color = cols[k]; }); }
    stepPeople(box); preview();
  });
  $('#reroll', box)?.addEventListener('click', () => { d.members.forEach((m) => { m.color = pick(pal); }); stepPeople(box); preview(); });
  $$('[data-uc]', box).forEach((b) => b.onclick = () => { d.uniformColor = b.dataset.uc; d.members.forEach((m) => { m.color = d.uniformColor; }); stepPeople(box); preview(); });
  $$('[data-c-k]', box).forEach((b) => b.onclick = () => {
    const k = +b.dataset.cK; d.members[k].color = b.dataset.c;
    $$(`[data-c-k="${k}"]`, box).forEach((x) => x.classList.toggle('on', x === b)); refreshAv(k); preview();
  });
  $$('[data-name-k]', box).forEach((i) => i.oninput = () => { const k = +i.dataset.nameK; d.members[k].name = i.value; refreshAv(k); showErr(''); preview(); });
  $('#shuffleNames', box).onclick = () => { d.members.forEach((m) => { m.name = ''; }); d.members.forEach((m) => { m.name = newName(); }); stepPeople(box); preview(); };
  $$('[data-notes-k]', box).forEach((b) => b.onclick = () => { const more = $(`[data-more="${b.dataset.notesK}"]`, box); more.hidden = !more.hidden; });
  $$('[data-ins-k]', box).forEach((ta) => ta.oninput = () => { d.members[+ta.dataset.insK].instructions = ta.value; });
  $$('[data-key-k]', box).forEach((s) => s.onchange = async () => {
    const k = +s.dataset.keyK, m = d.members[k];
    const c = parseKeyChoice(s.value);
    if (!c) return;
    if (c.provider !== providerOf(m.model)) {
      // a key from another provider needs a model from that provider
      const ref = await pickModel({ current: '', specialty: specOf(m), provider: c.provider, allowDefault: false });
      if (!ref) { reopenDetails(k); return; }
      m.model = ref;
    }
    m.api_key_id = c.keyId;
    reopenDetails(k);
  });
  const reload = (r, msg) => { const rid = W.roomId; setOrg(r.org); toast(msg); W = null; openWizard({ roomId: rid, step: 3 }); };
  $$('[data-move]', box).forEach((b) => b.onclick = async () => {
    const k = +b.dataset.move, m = d.members[k];
    const target = $(`[data-move-sel="${k}"]`, box).value;
    if (!target) return;
    try { reload(await api(`/employees/${m.id}`, 'PATCH', { room_id: target }), t('moved', m.name, roomOf(target)?.name || '')); }
    catch (e) { showErr(e.message); }
  });
  $$('[data-fire]', box).forEach((b) => b.onclick = async () => {
    const m = d.members[+b.dataset.fire];
    if (!await confirmBox({ title: t('letGo'), text: t('confirmLetGo', m.name), ok: t('letGo'), cancel: t('cancel'), danger: true, icon: 'trash' })) return;
    try { reload(await api(`/employees/${m.id}`, 'DELETE'), t('deleted')); }
    catch (e) { showErr(e.message); }
  });
}
const specOf = (m) => (W.exec ? 'general_manager' : (W.d.composition === 'same' ? W.d.sameSpec : m.specialty));
function reopenDetails(k) {
  const box = $('.step[data-step="3"]', W.el);
  stepPeople(box);
  const more = $(`[data-more="${k}"]`, box);
  if (more) more.hidden = false;
}

// ---------------------------------------------------------------- step 5: review
function stepReview(box) {
  const d = W.d;
  const p = payload();
  const boss = emp(d.leadReportsTo);
  const lead = d.leadSeat >= 0 ? p.members[d.leadSeat] : null;
  const place = d.placement.floor === 'keep' ? t('keep') : d.placement.floor === 'auto' ? t('auto') : d.placement.floor === 'new' ? t('newFloor') : t('floorLabel', d.placement.floor + 1);
  const title = (m) => {
    const s = store.catalog.seniority.find((x) => x.level === m.seniority);
    return `${L(spec(m.specialty)?.title)}${m.seniority > 0 && m.seniority !== 4 ? ` · ${L(s?.name)}` : ''}`;
  };
  box.innerHTML = `
    <div class="review-card"><h4>${esc(t('team').toUpperCase())}</h4><dl class="kv">
      <dt>${t('roomName')}</dt><dd>${esc(d.name)}</dd>
      <dt>${t('division')}</dt><dd><span class="tagline" style="--c:${division(d.division).color}">${icon(division(d.division).icon, 12)} ${esc(L(division(d.division).name))}</span></dd>
      ${W.exec ? '' : `<dt>${t('placement')}</dt><dd>${esc(place)}</dd>`}
      <dt>${t('desks')}</dt><dd>${d.desks} × ${d.per} = ${count()}</dd></dl></div>
    <div class="review-card"><h4>${esc(t('reviewPeople').toUpperCase())}</h4><div class="ppl">${p.members.map((m, k) => `
      <div class="p">${avatar({ ...m, id: m.id || `__${k}` }, 'sm', { status: false, crown: true })}<div><b>${esc(m.name)}</b><span>${esc(title(m))}</span></div></div>`).join('')}</div></div>
    ${W.exec ? '' : `<div class="review-card"><h4>${esc(t('reviewChain').toUpperCase())}</h4><div class="chain">
      <div class="lvl">${avatar(boss, 'xs', { status: false })}<b>${esc(boss?.name || '')}</b><span style="color:var(--muted)">${esc(titleOf(boss))}</span></div>
      ${lead ? `<div class="lvl" style="padding-inline-start:18px">${icon('right', 13)}${avatar({ ...lead, id: 'x' }, 'xs', { status: false })}<b>${esc(lead.name)}</b><span class="lead-badge">${icon('crown', 12)} ${t('lead')}</span></div>` : ''}
      ${p.members.filter((m, k) => k !== d.leadSeat).map((m) => `<div class="lvl" style="padding-inline-start:${lead ? 36 : 18}px">${icon('right', 13)}${avatar({ ...m, id: 'y' }, 'xs', { status: false })}<b>${esc(m.name)}</b><span style="color:var(--muted)">${esc(L(spec(m.specialty)?.title))}</span></div>`).join('')}
    </div></div>`}
    ${W.mode === 'edit' && !W.exec ? `<button class="btn danger block" id="delRoom">${icon('trash', 16)}${t('deleteRoom')}</button>` : ''}`;
  $('#delRoom', box)?.addEventListener('click', async () => {
    if (!await confirmBox({ title: t('deleteRoom'), text: t('confirmDelete'), ok: t('deleteRoom'), cancel: t('cancel'), danger: true, icon: 'trash' })) return;
    try {
      const r = await api(`/rooms/${W.roomId}`, 'DELETE');
      setOrg(r.org); toast(t('deleted')); closeWizard();
    } catch (e) { showErr(e.message); }
  });
}

// ---------------------------------------------------------------- submit
async function submit() {
  const bad = validate(4);
  if (bad) { showErr(`${bad} ✱`); return; }
  const btn = $('[data-submit]', W.el);
  btn.disabled = true;
  try {
    const body = payload();
    const r = W.mode === 'edit' ? await api(`/rooms/${W.roomId}`, 'PUT', body) : await api('/rooms', 'POST', body);
    // files attached before the room/people existed upload now that they have ids
    await uploadStaged('room', r.id, W.d.staged);
    const saved = r.org.employees.filter((e) => e.room_id === r.id);
    for (const [k, m] of W.d.members.entries()) {
      if (!m.staged?.length) continue;
      const e = saved.find((x) => x.desk === Math.floor(k / W.d.per) && x.seat === k % W.d.per);
      if (e) await uploadStaged('employee', e.id, m.staged);
    }
    const name = W.d.name;
    const created = W.mode === 'create';
    W = null;
    ctx.drawer.close();
    setOrg(r.org);
    toast(created ? t('created', name) : t('saved'));
    setTimeout(() => ctx.scene.focusRoom(r.id), 500);
  } catch (e) {
    showErr(e.message); btn.disabled = false;
  }
}
