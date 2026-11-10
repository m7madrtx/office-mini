// Workflows: routines and multi-step processes that run by hand or on a schedule.
// Page (cards + recent runs + templates), editor drawer, and a live run viewer.
import { t, L, getLang } from './i18n.js';
import { icon } from './icons.js';
import { store, api, on, emp, room, spec, division, titleOf, firstName } from './store.js';
import { $, $$, h, esc, avatar, md, toast, timeAgo, segIndicator, confirmBox } from './ui.js';
import { progressBlock } from './panels.js';

let ctx = null;
let data = { workflows: [], templates: [], icons: [], max_steps: 8, max_budget: 40 };
let runs = [];
let loaded = false;
const RV = { id: null, sheet: null, open: new Set() };   // the open run viewer

export const WF_COLOR = { zap: '#a497ff', inbox: '#22c3ee', trending: '#f5b544', code: '#8b7cff', megaphone: '#ff5c8a', alert: '#ffa63d',
  clock: '#4f8cff', file: '#9aa3c7', users: '#2ee59d', target: '#ff7a59', flask: '#c084fc', star: '#facc15' };
const ACTIVE = ['running', 'waiting'];
const DAY_ORDER = [6, 0, 1, 2, 3, 4, 5];   // Sunday first; ids are Python weekdays (Mon = 0)

export function initWorkflows(c) {
  ctx = c;
  on('workflows', async () => { await load(); if (store.view === 'workflows') renderWorkflows(true); });
  on('workflow', (e) => {
    const i = runs.findIndex((r) => r.id === e.run.id);
    if (i >= 0) runs[i] = e.run; else runs.unshift(e.run);
    const wf = data.workflows.find((w) => w.id === e.run.workflow_id);
    if (wf) { wf.running = ACTIVE.includes(e.run.status); wf.last_run = e.run; }
    if (store.view === 'workflows') renderWorkflows(true);
    if (RV.id === e.run.id) drawRun(e.run);
  });
  on('status', () => { if (RV.id && store.view) refreshRunProgress(); });
}

async function load() {
  const [w, r] = await Promise.all([api('/workflows'), api('/runs?limit=30')]);
  data = w; runs = r.runs; loaded = true;
}

// ---------------------------------------------------------------- helpers
const colorOf = (wf) => WF_COLOR[wf.icon] || '#a497ff';
const pad = (n) => String(n).padStart(2, '0');

function timeUntil(ts) {
  const s = Math.round(ts - Date.now() / 1000);
  const rtf = new Intl.RelativeTimeFormat(getLang(), { numeric: 'auto', style: 'short' });
  if (s < 60) return rtf.format(Math.max(1, s), 'second');
  if (s < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (s < 86400 * 1.5) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}
const clock = (ts) => new Date(ts * 1000).toLocaleString(getLang(), { weekday: 'short', hour: '2-digit', minute: '2-digit' });

export function scheduleText(tr = {}) {
  const days = t('wfDays');
  if (tr.type === 'interval') return t('wfEveryH', tr.every_hours || 24);
  if (tr.type === 'daily') return t('wfDailyAt', tr.time);
  if (tr.type === 'weekly') {
    const d = [...(tr.days || [])].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
    if (d.length === 7) return t('wfDailyAt', tr.time);
    if (d.length === 5 && [0, 1, 2, 3, 6].every((x) => d.includes(x))) return t('wfWorkdaysAt', tr.time);
    return t('wfOnAt', d.map((x) => days[x]).join(getLang() === 'ar' ? '، ' : ', '), tr.time);
  }
  return t('wfManual');
}

// Mirror of the server's schedule maths, for the editor's "next run" preview
function nextAfter(tr, after = Date.now() / 1000) {
  if (tr.type === 'interval') return after + Math.max(1, tr.every_hours || 24) * 3600;
  if (!['daily', 'weekly'].includes(tr.type)) return null;
  const [hh, mm] = (tr.time || '09:00').split(':').map(Number);
  const days = tr.type === 'weekly' ? new Set(tr.days || []) : new Set([0, 1, 2, 3, 4, 5, 6]);
  if (!days.size) return null;
  const base = new Date(after * 1000); base.setHours(hh, mm, 0, 0);
  for (let k = 0; k < 8; k++) {
    const c = new Date(base); c.setDate(base.getDate() + k);
    if (c.getTime() / 1000 > after && days.has((c.getDay() + 6) % 7)) return c.getTime() / 1000;
  }
  return null;
}

// Who a step goes to: same rules as the server (room → lead, division → head, role → most senior holder, else GM)
export function resolveTarget(to = '') {
  const [kind, ...rest] = to.split(':'); const id = rest.join(':');
  const all = store.org.employees;
  const gm = all.find((e) => e.id === 'gm');
  if (kind === 'emp') { const e = emp(id); return { e: e || gm, label: e?.name || t('former'), sub: e ? titleOf(e) : t('wfGone'), warn: !e }; }
  if (kind === 'room') {
    const r = room(id);
    const ps = all.filter((e) => e.room_id === id).sort((a, b) => (b.is_lead - a.is_lead) || a.seniority - b.seniority);
    return { e: ps[0] || gm, label: r?.name || '—', sub: ps[0] ? t('wfVia', ps[0].name) : t('wfEmptyRoom'), warn: !ps[0], icon: 'building', color: r?.accent };
  }
  if (kind === 'div') {
    const d = division(id);
    const ps = all.filter((e) => (e.room_division || e.division) === id).sort((a, b) => a.seniority - b.seniority);
    return { e: ps[0] || gm, label: L(d?.name) || id, sub: ps[0] ? t('wfVia', ps[0].name) : t('wfEmptyDiv'), warn: !ps[0], icon: d?.icon || 'layers', color: d?.color };
  }
  if (kind === 'role') {
    const s = spec(id);
    const ps = all.filter((e) => e.specialty === id).sort((a, b) => a.seniority - b.seniority);
    return { e: ps[0] || gm, label: L(s?.title) || id, sub: ps[0] ? t('wfVia', ps[0].name) : t('wfNobodyRole'), warn: !ps[0], icon: 'sparkles' };
  }
  return { e: gm, label: '—', sub: '', warn: true };
}

function runStatus(st) {
  const map = { running: ['working', 'pulse'], waiting: ['wait', 'user'], done: ['ok', 'check'], failed: ['bad', 'alert'], stopped: ['muted', 'x'],
    cancelled: ['muted', 'x'], interrupted: ['wait', 'alert'], skipped: ['muted', 'minus'], out_of_budget: ['wait', 'zap'], pending: ['muted', 'clock'] };
  const [cls, ic] = map[st] || ['muted', 'info'];
  return `<span class="rs ${cls}">${icon(ic, 12)}${esc(t('wfStatus')[st] || st)}</span>`;
}
function duration(a, b) {
  if (!a) return '';
  const s = Math.max(0, Math.round((b || Date.now() / 1000) - a));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${pad(s % 60)}s` : `${Math.floor(s / 3600)}h ${pad(Math.floor(s % 3600 / 60))}m`;
}

// ---------------------------------------------------------------- page
export async function renderWorkflows(quiet = false) {
  const box = $('#view-workflows');
  if (!loaded || !quiet) { try { await load(); } catch (e) { toast(e.message, true); return; } }
  const prev = $('.view-body', box)?.scrollTop;
  const q = store.quota;
  const scheduled = data.workflows.filter((w) => w.enabled && w.trigger.type !== 'manual');
  box.innerHTML = `<div class="view-head"><div><h2>${t('workflows')}</h2><p>${t('wfSub')}</p></div>
      <button class="btn primary sm" id="wfNew">${icon('plus', 15)}${t('wfNew')}</button></div>
    <div class="view-body scroll"><div class="wf-page">
      ${data.workflows.length ? `
        <div class="wf-note">${icon('zap', 14)}<span>${q?.free_tier ? t('wfBudgetNote', q.remaining, q.limit, scheduled.length) : t('wfBudgetNotePaid', scheduled.length)}</span></div>
        <div class="wf-grid">${data.workflows.map(card).join('')}</div>
        <h3 class="wf-h">${icon('clock', 15)}${t('wfRecent')}</h3>
        ${runs.length ? `<div class="run-list">${runs.slice(0, 14).map(runRow).join('')}</div>` : `<div class="help" style="padding:4px 2px 10px">${t('wfNoRuns')}</div>`}
        <h3 class="wf-h">${icon('sparkles', 15)}${t('wfTemplates')}</h3>`
      : `<div class="wf-hero"><div class="wf-hero-ico">${icon('zap', 28)}</div><h3>${t('wfHeroTitle')}</h3><p>${t('wfHeroText')}</p></div>
         <h3 class="wf-h">${icon('sparkles', 15)}${t('wfStartFrom')}</h3>`}
      <div class="tpl-grid">${data.templates.map(tplCard).join('')}
        <button class="tpl blank" data-blank><span class="tpl-ico">${icon('plus', 18)}</span><b>${t('wfBlank')}</b><p>${t('wfBlankText')}</p></button></div>
    </div></div>`;
  const body = $('.view-body', box);
  if (quiet && prev) body.scrollTop = prev;
  $('#wfNew', box).onclick = () => openEditor();
  $('[data-blank]', box).onclick = () => openEditor();
  $$('[data-tpl]', box).forEach((b) => { b.onclick = () => openEditor(null, data.templates.find((x) => x.id === b.dataset.tpl)); });
  $$('.wf-card', box).forEach((c) => {
    const wf = data.workflows.find((w) => w.id === +c.dataset.wf);
    $('[data-run]', c)?.addEventListener('click', () => runNow(wf));
    $('[data-edit]', c).onclick = () => openEditor(wf);
    $('[data-last]', c)?.addEventListener('click', () => openRun(+c.querySelector('[data-last]').dataset.last));
    $('[data-toggle]', c)?.addEventListener('click', async (ev) => {
      const b = ev.currentTarget; b.classList.toggle('on');
      try { await api(`/workflows/${wf.id}`, 'PATCH', { enabled: b.classList.contains('on') }); toast(b.classList.contains('on') ? t('wfResumed') : t('wfPaused')); }
      catch (e) { toast(e.message, true); }
    });
    $$('[data-who]', c).forEach((a) => { a.onclick = (ev) => ctx.showEmployee(a.dataset.who, ev.clientX, ev.clientY); });
  });
  $$('[data-runid]', box).forEach((b) => { b.onclick = () => openRun(+b.dataset.runid); });
}

function chain(steps, liveRun) {
  return steps.map((s, i) => {
    const r = resolveTarget(s.to);
    const st = liveRun?.steps?.[i]?.status;
    return `${i ? `<span class="ch-arrow">${icon('arrow', 12)}</span>` : ''}<span class="ch-step ${st || ''}" title="${esc(`${i + 1}. ${s.title} — ${r.label}`)}" data-who="${r.e?.id || ''}">
      ${avatar(r.e, 'sm', { status: false })}${s.gate ? `<i class="gate">${icon('user', 9)}</i>` : ''}</span>`;
  }).join('');
}

function card(wf, i) {
  const live = wf.running ? runs.find((r) => r.workflow_id === wf.id && ACTIVE.includes(r.status)) : null;
  const last = wf.last_run;
  const sched = wf.trigger.type !== 'manual';
  const by = wf.created_by && wf.created_by !== 'owner' ? emp(wf.created_by) : null;
  let progress = '';
  if (live) {
    const k = live.steps.findIndex((s) => ACTIVE.includes(s.status));
    const cur = live.steps[k];
    const who = emp(cur?.assignee);
    progress = `<button class="wf-live" data-last="${live.id}"><span class="bar"><i style="width:${Math.round(((k < 0 ? 0 : k) + (cur?.status === 'running' ? .5 : 0)) / live.steps.length * 100)}%"></i></span>
      <span class="tx">${cur?.status === 'waiting' ? `${icon('user', 13)}${t('wfNeedsYou')}` : `<span class="dot working"></span>${esc(firstName(who?.name || ''))} · ${esc(cur?.title || '')}`}</span>
      <span class="n">${(k < 0 ? 0 : k) + 1}/${live.steps.length}</span></button>`;
  }
  return `<article class="wf-card${wf.enabled || !sched ? '' : ' paused'}" data-wf="${wf.id}" style="--c:${colorOf(wf)};animation-delay:${i * 50}ms">
    <div class="wf-top"><span class="wf-ico">${icon(wf.icon || 'zap', 18)}</span>
      <div class="wf-tt"><h3>${esc(wf.name)}</h3>${wf.description ? `<p>${esc(wf.description)}</p>` : ''}</div>
      ${sched ? `<button class="switch${wf.enabled ? ' on' : ''}" data-toggle title="${esc(t('wfEnabled'))}"><i></i></button>` : ''}</div>
    <div class="wf-chain">${chain(wf.steps, live)}</div>
    <div class="wf-meta">
      <span class="chip">${icon(sched ? 'clock' : 'user', 12)}${esc(scheduleText(wf.trigger))}</span>
      ${sched && wf.enabled && wf.next_run ? `<span class="chip soft" title="${esc(clock(wf.next_run))}">${t('wfNext', timeUntil(wf.next_run))}</span>` : ''}
      ${sched && !wf.enabled ? `<span class="chip soft">${t('wfPausedChip')}</span>` : ''}
      <span class="chip soft" title="${esc(t('wfBudgetTip'))}">${icon('zap', 11)}≤ ${wf.budget_effective}</span>
      ${by ? `<span class="chip soft">${t('wfBy', firstName(by.name))}</span>` : ''}
    </div>
    ${progress}
    <div class="wf-actions">
      <button class="btn ${live ? 'ghost' : 'primary'} sm" data-run ${live ? 'disabled' : ''}>${icon(live ? 'pulse' : 'send', 14)}${live ? t('wfRunning') : t('wfRunNow')}</button>
      <button class="btn ghost sm" data-edit>${icon('edit', 14)}${t('edit')}</button>
      ${last && !live ? `<button class="btn quiet sm last" data-last="${last.id}">${runStatus(last.status)}<span>${esc(timeAgo(last.ts, getLang()))}</span></button>` : ''}
    </div></article>`;
}

function runRow(r, i) {
  const wf = data.workflows.find((w) => w.id === r.workflow_id);
  const k = r.steps.filter((s) => s.status === 'done').length;
  return `<button class="run-row" data-runid="${r.id}" style="--c:${wf ? colorOf(wf) : '#8b7cff'};animation-delay:${i * 25}ms">
    <span class="ri">${icon(wf?.icon || 'zap', 14)}</span>
    <span class="rn"><b>${esc(r.name)}</b><small>${icon(r.trigger === 'schedule' ? 'clock' : 'user', 11)}${esc(t(r.trigger === 'schedule' ? 'wfScheduled' : 'wfByHand'))} · ${esc(timeAgo(r.ts, getLang()))}</small></span>
    <span class="rp">${k}/${r.steps.length}</span>
    <span class="rq">${icon('zap', 11)}${r.requests}</span>
    ${runStatus(r.status)}</button>`;
}

function tplCard(tp, i) {
  const c = WF_COLOR[tp.icon] || '#a497ff';
  return `<button class="tpl" data-tpl="${tp.id}" style="--c:${c};animation-delay:${i * 40}ms">
    <span class="tpl-ico">${icon(tp.icon, 18)}</span><b>${esc(L(tp.name))}</b><p>${esc(L(tp.description))}</p>
    <span class="tpl-foot"><span>${icon(tp.trigger.type === 'manual' ? 'user' : 'clock', 11)}${esc(scheduleText(tp.trigger))}</span><span>${t('wfStepsN', tp.steps.length)}</span></span></button>`;
}

// ---------------------------------------------------------------- run now
async function runNow(wf) {
  if (wf.input_hint) {
    const text = await askBrief(wf);
    if (text === null) return;
    return start(wf, text);
  }
  start(wf, null);
}
async function start(wf, input) {
  try {
    const { run_id } = await api(`/workflows/${wf.id}/run`, 'POST', { input });
    toast(t('wfStarted', wf.name));
    openRun(run_id);
  } catch (e) { toast(e.message, true); }
}
function askBrief(wf) {
  return new Promise((resolve) => {
    const m = $('#modal'), sheet = $('#modalSheet');
    sheet.innerHTML = `<div class="d-head"><div class="av" style="--c:${colorOf(wf)}">${icon(wf.icon, 18)}</div><div class="txt"><h3>${esc(wf.name)}</h3><p>${t('wfStepsN', wf.steps.length)} · ${icon('zap', 11)} ≤ ${wf.budget_effective}</p></div>
        <button class="icon-btn" data-close>${icon('x', 18)}</button></div>
      <div class="content"><div class="field"><label>${esc(wf.input_hint)}</label>
        <textarea class="input" id="wfBrief" rows="4" placeholder="${esc(t('wfBriefPh'))}">${esc(wf.default_input || '')}</textarea></div>
        <div style="display:flex;justify-content:flex-end;gap:8px"><button class="btn ghost" data-close>${t('cancel')}</button><button class="btn primary" id="wfGo">${icon('send', 15)}${t('wfRunNow')}</button></div></div>`;
    m.classList.add('on');
    const done = (v) => { m.classList.remove('on'); resolve(v); };
    $$('[data-close]', sheet).forEach((b) => { b.onclick = () => done(null); });
    m.onclick = (e) => { if (e.target === m) done(null); };
    $('#wfGo', sheet).onclick = () => done($('#wfBrief', sheet).value.trim());
    setTimeout(() => $('#wfBrief', sheet).focus(), 60);
  });
}

// ---------------------------------------------------------------- run viewer
export async function openRun(id) {
  let r;
  try { r = (await api(`/runs/${id}`)).run; } catch (e) { toast(e.message, true); return; }
  const m = $('#modal');
  RV.id = id; RV.sheet = $('#modalSheet'); RV.open = new Set();
  const last = [...r.steps.keys()].filter((i) => r.steps[i].output).pop();
  if (last != null) RV.open.add(last);
  drawRun(r, true);
  m.classList.add('on');
  m.onclick = (e) => { if (e.target === m) closeRun(); };
}
function closeRun() { $('#modal').classList.remove('on'); RV.id = null; }

function drawRun(r, first = false) {
  const sheet = RV.sheet;
  if (!sheet || RV.id !== r.id) return;
  // only redraw while this run is still the one on screen (another modal may have replaced it)
  if (!first && !($('#modal').classList.contains('on') && sheet.querySelector(`[data-rv="${r.id}"]`))) { RV.id = null; return; }
  const wf = data.workflows.find((w) => w.id === r.workflow_id) || { icon: 'zap', name: r.name };
  const active = ACTIVE.includes(r.status);
  const prevScroll = $('.content', sheet)?.scrollTop;
  sheet.innerHTML = `<div class="d-head" data-rv="${r.id}"><div class="av" style="--c:${colorOf(wf)}">${icon(wf.icon || 'zap', 18)}</div>
      <div class="txt"><h3>${esc(r.name)}</h3><p>${runStatus(r.status)}<span>${esc(t(r.trigger === 'schedule' ? 'wfScheduled' : 'wfByHand'))} · ${esc(timeAgo(r.ts, getLang()))} · ${duration(r.ts, r.finished)}</span></p></div>
      ${active ? `<button class="btn danger sm" id="rvCancel">${icon('x', 14)}${t('wfCancel')}</button>` : ''}
      <button class="icon-btn" data-close>${icon('x', 18)}</button></div>
    <div class="content scroll">
      <div class="rv-stats"><div><small>${t('wfRequests')}</small><b>${r.requests}<span> / ${r.budget || '—'}</span></b><span class="bar"><i style="width:${r.budget ? Math.min(100, r.requests / r.budget * 100) : 0}%"></i></span></div>
        <div><small>${t('wfStepsDone')}</small><b>${r.steps.filter((s) => s.status === 'done').length}<span> / ${r.steps.length}</span></b></div>
        <div><small>${t('wfDuration')}</small><b>${duration(r.ts, r.finished) || '—'}</b></div></div>
      ${r.input ? `<div class="rv-brief"><small>${t('wfBrief')}</small><p>${esc(r.input)}</p></div>` : ''}
      ${r.error ? `<div class="rv-err ${r.status}">${icon(r.status === 'failed' ? 'alert' : 'info', 14)}<span>${esc(r.error)}</span></div>` : ''}
      <ol class="tl">${r.steps.map((s, i) => stepItem(s, i)).join('')}</ol>
      ${r.doc_id ? `<button class="btn ghost sm" id="rvDoc">${icon('file', 14)}${t('wfSavedDoc')}</button>` : ''}
    </div>`;
  if (prevScroll) $('.content', sheet).scrollTop = prevScroll;
  $$('[data-close]', sheet).forEach((b) => { b.onclick = closeRun; });
  $('#rvCancel', sheet)?.addEventListener('click', async () => { try { await api(`/runs/${r.id}/cancel`, 'POST'); } catch (e) { toast(e.message, true); } });
  $('#rvDoc', sheet)?.addEventListener('click', () => { closeRun(); ctx.openDoc(r.doc_id); });
  $$('[data-tog]', sheet).forEach((b) => { b.onclick = () => { const i = +b.dataset.tog; RV.open.has(i) ? RV.open.delete(i) : RV.open.add(i); drawRun(r); }; });
  $$('[data-who]', sheet).forEach((b) => { b.onclick = () => { closeRun(); ctx.openActivity(b.dataset.who); }; });
  $$('[data-gate]', sheet).forEach((g) => {
    const decide = async (approve) => {
      g.classList.add('deciding');
      try { await api(`/approvals/${g.dataset.gate}`, 'POST', { approve, note: $('input', g).value }); }
      catch (e) { toast(e.message, true); g.classList.remove('deciding'); }
    };
    $('[data-yes]', g).onclick = () => decide(true);
    $('[data-no]', g).onclick = () => decide(false);
  });
  refreshRunProgress();
}

function stepItem(s, i) {
  const target = resolveTarget(s.to);
  const who = emp(s.assignee) || target.e;
  const mark = { done: icon('check', 13), failed: icon('x', 13), skipped: icon('minus', 13), waiting: icon('user', 12) }[s.status] || `<span>${i + 1}</span>`;
  const out = s.output && RV.open.has(i);
  return `<li class="tl-step ${s.status}">
    <span class="tl-mark">${mark}</span>
    <div class="tl-body">
      <div class="tl-head">
        <button class="tl-who" data-who="${who?.id || ''}" title="${esc(t('activity'))}">${avatar(who, 'sm', { status: false })}</button>
        <div class="tl-tt"><b>${esc(s.title)}</b><small>${esc(who?.name || target.label)}${s.to.startsWith('emp:') ? '' : ` · ${esc(target.label)}`}${s.started ? ` · ${duration(s.started, s.finished)}` : ''}${s.requests ? ` · ${icon('zap', 10)}${s.requests}` : ''}</small></div>
        ${runStatus(s.status)}</div>
      ${s.status === 'running' ? `<div class="tl-live" data-live="${who?.id || ''}"></div>` : ''}
      ${s.status === 'waiting' && s.approval_id ? `<div class="tl-gate" data-gate="${s.approval_id}"><p>${icon('user', 13)}${t('wfGateAsk', firstName(who?.name || ''))}</p>
        <div class="aa"><input class="input sm" placeholder="${esc(t('wfGateNote'))}"><button class="btn ghost sm" data-no>${icon('x', 14)}${t('wfStop')}</button><button class="btn primary sm" data-yes>${icon('check', 14)}${t('wfContinue')}</button></div></div>` : ''}
      ${s.note ? `<div class="tl-note">${icon('message', 12)}${esc(s.note)}</div>` : ''}
      ${s.output ? `<button class="tl-tog" data-tog="${i}">${icon(out ? 'down' : 'right', 13)}${t(out ? 'wfHideResult' : 'wfShowResult')}</button>${out ? `<div class="tl-out doc">${md(s.output)}</div>` : ''}` : ''}
    </div></li>`;
}

function refreshRunProgress() {
  if (!RV.sheet || !RV.id) return;
  $$('[data-live]', RV.sheet).forEach((el) => { const e = emp(el.dataset.live); if (e && e.status === 'working') progressBlock(e, el); });
}

// ---------------------------------------------------------------- editor
function blankStep() { return { to: 'emp:gm', title: '', instructions: '', gate: false }; }

export function openEditor(wf = null, tpl = null) {
  const ar = getLang() === 'ar';
  const d = wf ? JSON.parse(JSON.stringify(wf)) : tpl ? {
    name: L(tpl.name), description: L(tpl.description), icon: tpl.icon, trigger: { ...tpl.trigger }, template: tpl.id,
    input_hint: L(tpl.input_hint) || '', default_input: '', budget: 0, min_quota: 10, save_output: true, enabled: true,
    steps: tpl.steps.map((s) => ({ to: s.to, title: ar && s.title_ar ? s.title_ar : s.title, instructions: s.instructions, gate: !!s.gate })),
  } : { name: '', description: '', icon: 'zap', trigger: { type: 'manual' }, input_hint: '', default_input: '', budget: 0, min_quota: 10, save_output: true, enabled: true, steps: [blankStep()] };
  d.askBrief = !!d.input_hint;
  const el = h(`<div style="display:flex;flex-direction:column;height:100%;min-height:0">
    <div class="d-head"><div class="av" id="weAv" style="--c:${WF_COLOR[d.icon] || '#a497ff'}">${icon(d.icon, 18)}</div>
      <div class="txt"><h3>${wf ? esc(t('editRoomTitle', wf.name)) : t('wfNew')}</h3><p>${t('wfEditorSub')}</p></div>
      <button class="icon-btn" data-close>${icon('x', 18)}</button></div>
    <div class="d-body"><div class="scroll we" id="weBody"></div></div>
    <div class="d-foot"><div class="err" id="weErr"></div><div class="we-foot">
      ${wf ? `<button class="btn danger sm" id="weDel">${icon('trash', 14)}</button>` : ''}<span style="flex:1"></span>
      <button class="btn ghost" data-close>${t('cancel')}</button><button class="btn primary" id="weSave">${icon('check', 15)}${wf ? t('save') : t('wfCreate')}</button></div></div></div>`);
  ctx.drawer.open({ kind: 'workflow', el });
  $$('[data-close]', el).forEach((b) => { b.onclick = () => ctx.drawer.close(); });
  const body = $('#weBody', el);

  const targetOptions = (cur) => {
    const ppl = [...store.org.employees].sort((a, b) => a.seniority - b.seniority || a.name.localeCompare(b.name));
    const rooms = store.org.rooms.filter((r) => store.org.employees.some((e) => e.room_id === r.id));
    const divs = store.catalog.divisions.filter((dv) => store.org.employees.some((e) => (e.room_division || e.division) === dv.id));
    const roles = [...store.catalog.specialties].sort((a, b) => L(a.title).localeCompare(L(b.title)));
    const opt = (v, label) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    return `<optgroup label="${esc(t('people'))}">${ppl.map((e) => opt(`emp:${e.id}`, `${e.name} — ${titleOf(e)}`)).join('')}</optgroup>
      <optgroup label="${esc(t('wfRoomsLead'))}">${rooms.map((r) => opt(`room:${r.id}`, r.name)).join('')}</optgroup>
      <optgroup label="${esc(t('wfDivsHead'))}">${divs.map((dv) => opt(`div:${dv.id}`, L(dv.name))).join('')}</optgroup>
      <optgroup label="${esc(t('wfRoles'))}">${roles.map((s) => opt(`role:${s.id}`, L(s.title))).join('')}</optgroup>`;
  };

  const draw = () => {
    const sc = body.scrollTop;
    const tr = d.trigger;
    const nxt = nextAfter(tr);
    const auto = 4 * Math.max(1, d.steps.length);
    const budget = d.budget || Math.min(data.max_budget, auto);
    body.innerHTML = `
      <div class="field"><label>${t('wfName')}</label><input class="input" id="weName" maxlength="60" value="${esc(d.name)}" placeholder="${esc(t('wfNamePh'))}"></div>
      <div class="field"><label>${t('wfDesc')}</label><input class="input" id="weDesc" maxlength="300" value="${esc(d.description || '')}" placeholder="${esc(t('wfDescPh'))}"></div>
      <div class="field"><label>${t('wfIcon')}</label><div class="we-icons">${(data.icons || Object.keys(WF_COLOR)).map((ic) => `<button class="we-ic${ic === d.icon ? ' on' : ''}" data-ic="${ic}" style="--c:${WF_COLOR[ic]}">${icon(ic, 16)}</button>`).join('')}</div></div>

      <div class="label" style="margin-top:6px">${t('wfSteps')}<small style="font-weight:500;color:var(--muted)">${t('wfStepsHelp')}</small></div>
      <div class="we-steps">${d.steps.map((s, i) => {
        const r = resolveTarget(s.to);
        return `${i ? `<div class="we-link">${icon('down', 13)}<span>${t('wfPasses')}</span></div>` : ''}
        <div class="we-step" data-i="${i}">
          <div class="we-sh"><span class="we-n">${i + 1}</span><input class="input sm we-title" maxlength="80" value="${esc(s.title)}" placeholder="${esc(t('wfStepTitlePh'))}">
            <button class="icon-btn" data-up ${i ? '' : 'disabled'} title="↑">${icon('down', 14)}</button>
            <button class="icon-btn" data-dn ${i < d.steps.length - 1 ? '' : 'disabled'} title="↓">${icon('down', 14)}</button>
            <button class="icon-btn" data-rm ${d.steps.length > 1 ? '' : 'disabled'} title="${esc(t('delete'))}">${icon('trash', 14)}</button></div>
          <select class="input sm we-to">${targetOptions(s.to)}</select>
          <div class="we-who${r.warn ? ' warn' : ''}">${avatar(r.e, 'xs', { status: false })}<span>${icon('arrow', 11)} ${esc(r.sub || r.label)}</span></div>
          <textarea class="input we-ins" rows="3" placeholder="${esc(t('wfInsPh'))}">${esc(s.instructions)}</textarea>
          <label class="we-gate"><span>${icon('user', 13)}${t('wfGate')}</span><button type="button" class="switch${s.gate ? ' on' : ''}" data-gatesw><i></i></button></label>
        </div>`;
      }).join('')}</div>
      ${d.steps.length < data.max_steps ? `<button class="we-add" id="weAdd">${icon('plus', 15)}${t('wfAddStep')}</button>` : ''}

      <div class="we-sec"><h4>${icon('clock', 15)}${t('wfWhen')}</h4>
        <nav class="seg small" id="weTrig">${['manual', 'daily', 'weekly', 'interval'].map((k) => `<button data-tr="${k}" class="${tr.type === k ? 'on' : ''}">${t('wfTrig')[k]}</button>`).join('')}</nav>
        ${['daily', 'weekly'].includes(tr.type) ? `<div class="we-row"><label>${t('wfAt')}</label><input type="time" class="input sm" id="weTime" value="${esc(tr.time || '09:00')}" style="width:130px"></div>` : ''}
        ${tr.type === 'weekly' ? `<div class="we-days">${DAY_ORDER.map((k) => `<button class="pill${(tr.days || []).includes(k) ? ' on' : ''}" data-day="${k}">${esc(t('wfDays')[k])}</button>`).join('')}</div>` : ''}
        ${tr.type === 'interval' ? `<div class="we-row"><label>${t('wfEvery')}</label><input type="number" class="input sm" id="weHours" min="1" max="168" value="${tr.every_hours || 24}" style="width:90px"><span>${t('wfHours')}</span></div>` : ''}
        <div class="help">${tr.type === 'manual' ? t('wfManualHelp') : nxt ? `${icon('clock', 12)} ${t('wfNextAt', clock(nxt))}` : t('wfPickDay')}</div></div>

      <div class="we-sec"><h4>${icon('message', 15)}${t('wfBrief')}</h4>
        <label class="we-gate"><span>${t('wfAskBrief')}</span><button type="button" class="switch${d.askBrief ? ' on' : ''}" id="weAskBrief"><i></i></button></label>
        ${d.askBrief ? `<input class="input sm" id="weHint" maxlength="80" value="${esc(d.input_hint || '')}" placeholder="${esc(t('wfHintPh'))}" style="margin-top:8px">` : ''}
        ${tr.type !== 'manual' || d.askBrief ? `<textarea class="input" id="weDefault" rows="2" style="margin-top:8px" placeholder="${esc(t('wfDefaultPh'))}">${esc(d.default_input || '')}</textarea>` : ''}
        <div class="help">${t('wfBriefHelp')}</div></div>

      <div class="we-sec"><h4>${icon('zap', 15)}${t('wfBudget')}</h4>
        <div class="we-row"><label>${t('wfBudgetCap')}</label><input type="number" class="input sm" id="weBudget" min="0" max="${data.max_budget}" value="${d.budget || ''}" placeholder="${Math.min(data.max_budget, auto)}" style="width:90px"></div>
        <div class="help">${t('wfBudgetHelp', budget, Math.floor(50 / budget))}</div>
        ${tr.type !== 'manual' ? `<div class="we-row" style="margin-top:10px"><label>${t('wfMinQuota')}</label><input type="number" class="input sm" id="weMinQ" min="0" max="50" value="${d.min_quota ?? 10}" style="width:90px"></div>
          <div class="help">${t('wfMinQuotaHelp')}</div>` : ''}
        <label class="we-gate" style="margin-top:12px"><span>${icon('file', 13)}${t('wfSaveDoc')}</span><button type="button" class="switch${d.save_output ? ' on' : ''}" id="weSaveDoc"><i></i></button></label></div>`;
    body.scrollTop = sc;
    requestAnimationFrame(() => segIndicator($('#weTrig', body)));
    bind();
  };

  const collect = () => {
    d.name = $('#weName', body).value; d.description = $('#weDesc', body).value;
    $$('.we-step', body).forEach((row) => {
      const s = d.steps[+row.dataset.i];
      s.title = $('.we-title', row).value; s.to = $('.we-to', row).value; s.instructions = $('.we-ins', row).value;
    });
    if ($('#weTime', body)) d.trigger.time = $('#weTime', body).value || '09:00';
    if ($('#weHours', body)) d.trigger.every_hours = Math.max(1, Math.min(168, +$('#weHours', body).value || 24));
    if ($('#weHint', body)) d.input_hint = $('#weHint', body).value;
    if ($('#weDefault', body)) d.default_input = $('#weDefault', body).value;
    d.budget = Math.max(0, Math.min(data.max_budget, +$('#weBudget', body).value || 0));
    if ($('#weMinQ', body)) d.min_quota = Math.max(0, Math.min(50, +$('#weMinQ', body).value || 0));
  };

  const bind = () => {
    $$('[data-ic]', body).forEach((b) => { b.onclick = () => { collect(); d.icon = b.dataset.ic; const av = $('#weAv', el); av.style.setProperty('--c', WF_COLOR[d.icon]); av.innerHTML = icon(d.icon, 18); draw(); }; });
    $$('.we-step', body).forEach((row) => {
      const i = +row.dataset.i;
      $('[data-up]', row).onclick = () => { collect(); [d.steps[i - 1], d.steps[i]] = [d.steps[i], d.steps[i - 1]]; draw(); };
      $('[data-dn]', row).onclick = () => { collect(); [d.steps[i + 1], d.steps[i]] = [d.steps[i], d.steps[i + 1]]; draw(); };
      $('[data-rm]', row).onclick = () => { collect(); d.steps.splice(i, 1); draw(); };
      $('[data-gatesw]', row).onclick = (ev) => { ev.currentTarget.classList.toggle('on'); d.steps[i].gate = ev.currentTarget.classList.contains('on'); };
      $('.we-to', row).onchange = () => { collect(); draw(); };
    });
    $('#weAdd', body)?.addEventListener('click', () => {
      collect(); d.steps.push(blankStep()); draw();
      requestAnimationFrame(() => { const last = $$('.we-step', body).pop(); last?.scrollIntoView({ behavior: 'smooth', block: 'center' }); $('.we-title', last)?.focus({ preventScroll: true }); });
    });
    $$('[data-tr]', body).forEach((b) => { b.onclick = () => {
      collect(); const k = b.dataset.tr;
      d.trigger = { type: k, time: d.trigger.time || '09:00', days: d.trigger.days?.length ? d.trigger.days : [0], every_hours: d.trigger.every_hours || 24 };
      draw();
    }; });
    $$('[data-day]', body).forEach((b) => { b.onclick = () => {
      collect(); const k = +b.dataset.day; const set = new Set(d.trigger.days || []);
      set.has(k) ? set.delete(k) : set.add(k); d.trigger.days = [...set]; draw();
    }; });
    $('#weTime', body)?.addEventListener('change', () => { collect(); draw(); });
    $('#weHours', body)?.addEventListener('change', () => { collect(); draw(); });
    $('#weBudget', body).addEventListener('change', () => { collect(); draw(); });
    $('#weAskBrief', body).onclick = () => { collect(); d.askBrief = !d.askBrief; if (d.askBrief && !d.input_hint) d.input_hint = t('wfHintDefault'); draw(); };
    $('#weSaveDoc', body).onclick = (ev) => { ev.currentTarget.classList.toggle('on'); d.save_output = ev.currentTarget.classList.contains('on'); };
  };

  $('#weSave', el).onclick = async () => {
    collect();
    const err = $('#weErr', el);
    const payload = { ...d, input_hint: d.askBrief ? (d.input_hint || t('wfHintDefault')) : '' };
    delete payload.askBrief;
    if (payload.trigger.type !== 'weekly') delete payload.trigger.days;
    try {
      $('#weSave', el).disabled = true;
      if (wf) await api(`/workflows/${wf.id}`, 'PUT', payload); else await api('/workflows', 'POST', payload);
      toast(wf ? t('saved') : t('wfCreated', d.name));
      ctx.drawer.close();
      if (store.view !== 'workflows') ctx.setView('workflows');
    } catch (e) { err.textContent = e.message; $('#weSave', el).disabled = false; }
  };
  $('#weDel', el)?.addEventListener('click', async () => {
    if (!await confirmBox({ title: t('delete'), text: t('wfConfirmDelete', wf.name), ok: t('delete'), cancel: t('cancel'), danger: true, icon: 'trash' })) return;
    try { await api(`/workflows/${wf.id}`, 'DELETE'); toast(t('wfDeleted')); ctx.drawer.close(); } catch (e) { toast(e.message, true); }
  });
  draw();
}
