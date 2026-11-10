// Org chart and Work (tasks board, documents, inbox) views.
import { t, getLang } from './i18n.js';
import { icon } from './icons.js';
import { store, api, on, emp, titleOf, firstName } from './store.js';
import { $, $$, h, esc, avatar, md, timeAgo, segIndicator } from './ui.js';
import { activityList } from './panels.js';

let ctx = null;
let workTab = 'tasks';

export function initViews(c) {
  ctx = c;
  on('org', () => { if (store.view === 'org') renderOrg(); });
  on('status', () => { if (store.view === 'org') renderOrg(true); });
  on('records', () => { if (store.view === 'work' && workTab !== 'activity') renderWork(); });
  on('activity', (ev) => {
    if (store.view !== 'work' || workTab !== 'activity') return;
    const list = $('#workBody .acts');
    if (!list) return;
    list.insertAdjacentHTML('beforeend', activityList([ev.entry], { withWho: true }));
    list.lastElementChild.classList.add('fresh');
    const body = $('#workBody');
    body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });
  });
}

// ---------------------------------------------------------------- org chart
export function renderOrg(quiet = false) {
  const box = $('#view-org');
  const all = store.org.employees;
  const kids = (id) => all.filter((e) => e.reports_to === id).sort((a, b) => a.seniority - b.seniority || a.name.localeCompare(b.name));
  let n = 0;
  const node = (e) => `<li><button class="node" data-emp="${e.id}" style="animation-delay:${quiet ? 0 : (n++) * 45}ms${quiet ? ';animation:none' : ''}">${avatar(e, '', { crown: true })}
      <span class="txt"><b>${esc(e.name)}</b><span>${esc(titleOf(e))}</span></span>${e.status === 'working' ? `<span class="dot working"></span>` : ''}</button>
      ${kids(e.id).length ? `<ul>${kids(e.id).map(node).join('')}</ul>` : ''}</li>`;
  const roots = all.filter((e) => !e.reports_to);
  const narrow = matchMedia('(max-width: 860px)').matches;   // phones get an indented outline
  const prevScroll = $('.view-body', box)?.scrollTop;
  box.innerHTML = `<div class="view-head"><div><h2>${t('orgTitle')}</h2><p>${t('orgSub')}</p></div></div>
    <div class="view-body scroll"><div class="${narrow ? 'vlist' : 'tree'}"><ul><li><div class="node owner">${icon('user', 16)}<span class="txt"><b>${t('owner')}</b></span></div>
      <ul>${roots.map(node).join('')}</ul></li></ul></div></div>`;
  $$('[data-emp]', box).forEach((b) => { b.onclick = (ev) => ctx.showEmployee(b.dataset.emp, ev.clientX, ev.clientY); });
  const body = $('.view-body', box);
  if (quiet && prevScroll != null) body.scrollTop = prevScroll;
  if (!narrow && !quiet) requestAnimationFrame(() => { body.scrollLeft = (body.scrollWidth - body.clientWidth) / 2; });
}

// ---------------------------------------------------------------- work
export async function renderWork() {
  const box = $('#view-work');
  if (!box.querySelector('.view-head')) {
    box.innerHTML = `<div class="view-head"><div><h2>${t('work')}</h2></div>
      <nav class="seg" id="workSeg">
        <button data-tab="tasks">${icon('board', 16)}${t('tasks')}</button>
        <button data-tab="documents">${icon('file', 16)}${t('documents')}</button>
        <button data-tab="inbox">${icon('inbox', 16)}${t('inbox')}</button>
        <button data-tab="activity">${icon('pulse', 16)}${t('activity')}</button></nav></div>
      <div class="view-body scroll" id="workBody"></div>`;
    $$('[data-tab]', box).forEach((b) => { b.onclick = () => { workTab = b.dataset.tab; renderWork(); }; });
  }
  $$('[data-tab]', box).forEach((b) => b.classList.toggle('on', b.dataset.tab === workTab));
  requestAnimationFrame(() => segIndicator($('#workSeg', box)));
  const body = $('#workBody', box);
  if (workTab === 'tasks') {
    const { tasks } = await api('/tasks');
    const cols = [['in_progress', t('inProgress'), 'clock'], ['done', t('doneCol'), 'check'], ['blocked', t('blocked'), 'alert']];
    if (!tasks.length) { body.innerHTML = `<div class="empty">${icon('board', 34)}<div>${t('noTasks')}</div></div>`; return; }
    body.innerHTML = `<div class="kanban">${cols.map(([k, label, ic]) => {
      const list = tasks.filter((x) => (k === 'in_progress' ? ['in_progress', 'todo'].includes(x.status) : x.status === k));
      return `<div class="col"><h3>${icon(ic, 15)}${label}<span class="count">${list.length}</span></h3><div class="list scroll">${list.map((x, i) => {
        const a = emp(x.assigner), b = emp(x.assignee);
        return `<div class="card" data-task="${x.id}" style="animation-delay:${i * 40}ms"><b>${esc(x.title)}</b>
          <div class="meta">${avatar(a, 'xs', { status: false })}${icon('arrow', 12)}${avatar(b, 'xs', { status: false })}<span>${esc(firstName(b?.name || t('former')))}</span><span style="margin-inline-start:auto">${esc(timeAgo(x.updated || x.ts, getLang()))}</span></div></div>`;
      }).join('')}</div></div>`;
    }).join('')}</div>`;
    $$('[data-task]', body).forEach((c) => { c.onclick = () => openTask(tasks.find((x) => x.id === +c.dataset.task)); });
  } else if (workTab === 'documents') {
    const { documents } = await api('/documents');
    if (!documents.length) { body.innerHTML = `<div class="empty">${icon('file', 34)}<div>${t('noDocs')}</div></div>`; return; }
    body.innerHTML = `<div class="docs">${documents.map((d, i) => {
      const a = emp(d.author);
      return `<div class="card" data-doc="${d.id}" style="animation-delay:${i * 35}ms"><b>${esc(d.title)}</b><p>${esc(d.preview.replace(/[#*`>|-]/g, ' '))}</p>
        <div class="meta" style="margin-top:10px">${avatar(a, 'xs', { status: false })}<span>${esc(firstName(a?.name || t('former')))}</span><span style="margin-inline-start:auto">${esc(timeAgo(d.ts, getLang()))}</span></div></div>`;
    }).join('')}</div>`;
    $$('[data-doc]', body).forEach((c) => { c.onclick = () => openDoc(+c.dataset.doc); });
  } else if (workTab === 'activity') {
    const { activity } = await api('/activity?limit=250');
    body.innerHTML = activity.length ? `<div class="acts" style="max-width:900px">${activityList(activity, { withWho: true })}</div>`
      : `<div class="empty">${icon('pulse', 34)}<div>${t('noActivity')}</div></div>`;
    body.scrollTop = body.scrollHeight;
  } else {
    const { emails } = await api('/emails');
    body.innerHTML = `<div class="mails">${emails.map((m, i) => `<div class="card mail-card${m.unread ? ' unread' : ''}" style="animation-delay:${i * 35}ms;cursor:default">
      <b>${esc(m.subject)}</b><div class="from">${esc(m.sender)} · ${esc(timeAgo(m.ts, getLang()))}</div>
      <p style="margin-top:8px;-webkit-line-clamp:4">${esc(m.body)}</p>
      ${m.draft ? `<div class="draft"><b style="display:inline;margin:0">${t('draft')}</b>\n${esc(m.draft)}</div>` : ''}</div>`).join('')}</div>`;
  }
}

function modal(html) {
  const m = $('#modal'), sheet = $('#modalSheet');
  sheet.innerHTML = html;
  m.classList.add('on');
  const close = () => m.classList.remove('on');
  m.onclick = (e) => { if (e.target === m) close(); };
  $$('[data-close]', sheet).forEach((b) => { b.onclick = close; });
  return { sheet, close };
}

function openTask(x) {
  const a = emp(x.assigner), b = emp(x.assignee);
  modal(`<div class="d-head">${avatar(b, '', { status: false })}<div class="txt"><h3>${esc(x.title)}</h3>
      <p>${esc(a?.name || t('former'))} → ${esc(b?.name || t('former'))} · ${esc(timeAgo(x.ts, getLang()))}</p></div>
      <button class="icon-btn" data-close>${icon('x', 18)}</button></div>
    <div class="content scroll"><div class="doc">
      <h3>${t('tasks')}</h3><p>${esc(x.detail || '')}</p>
      ${x.result ? `<h3>${t('reportTo', firstName(b?.name || ''), firstName(a?.name || ''))}</h3>${md(x.result)}` : ''}</div></div>`);
}

export async function openDoc(id) {
  const d = await api(`/documents/${id}`);
  const a = emp(d.author);
  const words = d.content.split(/\s+/).filter(Boolean).length;
  const { sheet, close } = modal(`<div class="d-head">${avatar(a, '', { status: false })}<div class="txt"><h3>${esc(d.title)}</h3>
      <p>${esc(a?.name || t('former'))} · ${esc(timeAgo(d.ts, getLang()))} · ${t('words', words)}</p></div>
      <button class="icon-btn" data-del title="${esc(t('deleteRoom'))}">${icon('trash', 17)}</button>
      <button class="icon-btn" data-close>${icon('x', 18)}</button></div>
    <div class="content scroll"><div class="doc">${md(d.content)}</div></div>`);
  $('[data-del]', sheet).onclick = async () => { await api(`/documents/${id}`, 'DELETE'); close(); renderWork(); };
}
