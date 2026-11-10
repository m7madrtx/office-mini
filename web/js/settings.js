// Settings page + colour-coded API health alerts.
import { t, L, getLang } from './i18n.js';
import { icon, LOGO } from './icons.js';
import { store, api, on } from './store.js';
import { $, $$, esc, toast, segIndicator, timeAgo, confirmBox } from './ui.js';
import { modelButton, modelLabel } from './models.js';
import { kbBlock } from './kbui.js';
import { keysState, loadKeys } from './keys.js';

let ctx = null;
let health = [];
const dismissed = new Map();   // provider -> state dismissed

const STATE_TXT = {
  en: { ok: 'Healthy', low: 'Running low', rate_limited: 'Rate limited', error: 'Unreachable', depleted: 'Depleted', expired: 'Expired', invalid: 'Invalid key', unconfigured: 'Not connected' },
  ar: { ok: 'سليم', low: 'قارب ينتهي', rate_limited: 'محدود مؤقتاً', error: 'ما يرد', depleted: 'خلص الرصيد', expired: 'منتهي', invalid: 'مفتاح غلط', unconfigured: 'غير متصل' },
};
const stateTxt = (s) => (STATE_TXT[getLang()] || STATE_TXT.en)[s] || s;

export function initSettings(c) {
  ctx = c;
  on('keys', () => loadHealth());   // a per-employee key failed or changed: refresh the alert banners
  on('health', (e) => { const i = health.findIndex((h) => h.provider === e.health.provider); if (i >= 0) health[i] = { ...health[i], ...e.health }; else health.push(e.health); renderAlerts(); if (store.view === 'settings') renderSettings(true); });
}

export async function loadHealth(refresh = false) {
  try { health = (await api(`/providers/health${refresh ? '?refresh=true' : ''}`)).health; } catch { /* offline */ }
  renderAlerts();
  return health;
}

// ---------------------------------------------------------------- alert banners
function renderAlerts() {
  const box = $('#alerts');
  if (!box) return;
  const bad = health.filter((h) => (h.level === 'red' || h.level === 'amber') && dismissed.get(h.provider) !== h.state);
  box.innerHTML = bad.map((h) => `<div class="alert ${h.level}" data-p="${h.provider}">
      <span class="ai">${icon(h.level === 'red' ? 'alert' : 'zap', 15)}</span>
      <span class="at"><b>${esc(h.name || h.provider)} · ${esc(stateTxt(h.state))}</b><span>${esc(h.detail || '')}</span></span>
      <button class="btn quiet sm" data-open>${t('settings')}</button>
      <button class="icon-btn" data-x>${icon('x', 15)}</button></div>`).join('');
  $$('.alert', box).forEach((a) => {
    $('[data-x]', a).onclick = () => { const h = health.find((x) => x.provider === a.dataset.p); dismissed.set(a.dataset.p, h?.state); renderAlerts(); };
    $('[data-open]', a).onclick = () => ctx.setView('settings');
  });
  const worst = health.some((h) => h.level === 'red') ? 'red' : health.some((h) => h.level === 'amber') ? 'amber' : '';
  $('#settingsBtn')?.setAttribute('data-alert', worst);
}

// ---------------------------------------------------------------- settings page
export async function renderSettings(quiet = false) {
  const box = $('#view-settings');
  const s = store.org.settings;
  const prevScroll = $('.view-body', box)?.scrollTop;
  if (!quiet || !health.length) await loadHealth(!quiet);
  if (!store.providersList) { try { store.providersList = (await api('/providers')).providers; } catch { store.providersList = []; } }
  if (!quiet) await loadKeys();
  const divs = store.catalog.divisions;
  box.innerHTML = `<div class="view-head"><div><h2>${t('settings')}</h2><p>${esc(store.org.company)}</p></div>
      <button class="btn ghost sm" id="stRefresh">${icon('refresh', 14)}${getLang() === 'ar' ? 'افحص الاتصال' : 'Re-check connections'}</button></div>
    <div class="view-body scroll"><div class="settings-grid">
      <section class="st-card wide"><h3>${icon('cpu', 16)}${t('providers')}</h3>
        <div class="prov-grid">${health.filter((h) => !h.is_key).map((h) => `<div class="prov ${h.level}">
          <div class="pt"><span class="pd"></span><b>${esc(h.name)}</b><span class="ps">${esc(stateTxt(h.state))}</span></div>
          <div class="pdesc">${esc(h.detail || '')}</div>
          <div class="pk"><code>${esc(h.key_env)}</code>${h.keys_url ? `<a href="${esc(h.keys_url)}" target="_blank" rel="noopener">${icon('external', 12)}</a>` : ''}<small>${h.ts ? esc(timeAgo(h.ts, getLang())) : ''}</small></div></div>`).join('')}</div>
        <div class="help">${icon('key', 13)} ${getLang() === 'ar' ? 'المفاتيح تنحفظ في ملف .env على جهازك. بعد ما تضيف مفتاح، أعد تشغيل التطبيق.' : 'Keys live in the .env file on your PC. After adding one, restart the app (stop.bat, then run.bat).'}</div></section>
      <section class="st-card wide" id="stKeys">${keysCard()}</section>
      <section class="st-card"><h3>${icon('building', 16)}${t('company')}</h3>
        <div class="field"><input class="input" id="stCompany" maxlength="40" value="${esc(store.org.company)}"></div>
        <div class="field"><label>${getLang() === 'ar' ? 'شعار الشركة' : 'Company logo'}</label>
          <div class="logo-pick"><div class="logo-tile${s.logo_v ? ' has-img' : ''}">${s.logo_v ? `<img src="/api/logo?v=${s.logo_v}" alt="">` : LOGO}</div>
            <div class="acts"><label class="btn ghost sm">${icon('upload', 14)}${s.logo_v ? (getLang() === 'ar' ? 'غيّر' : 'Replace') : (getLang() === 'ar' ? 'ارفع شعار' : 'Upload logo')}
                <input type="file" id="stLogo" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden></label>
              ${s.logo_v ? `<button class="btn quiet sm" id="stLogoDel">${icon('x', 14)}${getLang() === 'ar' ? 'أزل' : 'Remove'}</button>` : ''}</div></div>
          <div class="help">${getLang() === 'ar' ? 'PNG أو JPG أو SVG. يظهر في الشريط العلوي وأيقونة التبويب. الأفضل صورة مربعة.' : 'PNG, JPG or SVG. Shown in the top bar and the browser tab. Square images look best.'}</div></div>
        <div class="field"><label>${t('language')}</label><nav class="seg small" id="stLang"><button data-l="en" class="${getLang() === 'en' ? 'on' : ''}">English</button><button data-l="ar" class="${getLang() === 'ar' ? 'on' : ''}">العربية</button></nav></div>
        <div class="field"><label>${getLang() === 'ar' ? 'المظهر' : 'Appearance'}</label><nav class="seg small" id="stMode">${[['dark', 'moon', getLang() === 'ar' ? 'داكن' : 'Dark'], ['light', 'sun', getLang() === 'ar' ? 'فاتح' : 'Light'], ['auto', 'sliders', getLang() === 'ar' ? 'تلقائي' : 'Auto']].map(([m, ic, lbl]) =>
          `<button data-mode-set="${m}" class="${ctx.getMode() === m ? 'on' : ''}">${icon(ic, 13)}${lbl}</button>`).join('')}</nav></div></section>
      <section class="st-card"><h3>${icon('sparkles', 16)}${t('defaultModel')}</h3>
        <div class="field"><label>${t('defaultModel')}</label><div id="stDef"></div></div>
        <div class="field"><label>${t('visionModel')}</label><div id="stVis"></div></div></section>
      <section class="st-card"><h3>${icon('org', 16)}${getLang() === 'ar' ? 'السلوك' : 'Behaviour'}</h3>
        <div class="field"><label>${t('review')}<button class="switch${s.review_reports ? ' on' : ''}" data-sw="review_reports"><i></i></button></label><div class="help">${t('reviewHelp')}</div></div>
        <div class="field"><label>${t('autoHire')}<button class="switch${s.auto_hire ? ' on' : ''}" data-sw="auto_hire"><i></i></button></label><div class="help">${t('autoHireHelp')}</div></div>
        <div class="help">${icon('zap', 13)} ${t('budgetNote')}</div></section>
      <section class="st-card"><h3>${icon('file', 16)}${t('kbCompany')}</h3>${kbBlock({ scopeType: 'company', scopeId: 'company' })}</section>
      <section class="st-card"><h3>${icon('layers', 16)}${t('kbDivision')}</h3>
        <select class="input sm" id="stDiv" style="margin-bottom:10px">${divs.map((d) => `<option value="${d.id}">${esc(L(d.name))}</option>`).join('')}</select>
        <div id="stDivKb"></div></section>
    </div></div>`;
  if (prevScroll) $('.view-body', box).scrollTop = prevScroll;
  requestAnimationFrame(() => { segIndicator($('#stLang', box)); segIndicator($('#stMode', box)); });
  $$('[data-mode-set]', box).forEach((b) => { b.onclick = () => ctx.setMode(b.dataset.modeSet); });
  const patch = async (body) => { try { await api('/settings', 'PATCH', body); toast(t('saved')); } catch (e) { toast(e.message, true); } };
  $('#stRefresh', box).onclick = async () => { await loadHealth(true); renderSettings(true); };
  $('#stCompany', box).onchange = (e) => patch({ company: e.target.value });
  $('#stLogo', box).onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const r = await api('/logo', 'PUT', { data: await logoData(f) });
      store.org.settings.logo_v = r.logo_v;
      toast(getLang() === 'ar' ? 'انحفظ الشعار' : 'Logo updated');
      renderSettings(true);
    } catch (err) { toast(err.message, true); }
  };
  $('#stLogoDel', box)?.addEventListener('click', async () => { await api('/logo', 'DELETE'); store.org.settings.logo_v = 0; renderSettings(true); });
  $$('[data-l]', box).forEach((b) => { b.onclick = () => { if (b.dataset.l !== getLang()) ctx.toggleLang(); }; });
  $$('[data-sw]', box).forEach((b) => { b.onclick = () => { b.classList.toggle('on'); patch({ [b.dataset.sw]: b.classList.contains('on') }); }; });
  const mountModel = (id, key) => {
    $(id, box).innerHTML = modelButton(s[key], key === 'vision_model' ? 'ui_designer' : 'general_manager', (ref) => { if (ref) patch({ [key]: ref }); });
  };
  mountModel('#stDef', 'default_model');
  mountModel('#stVis', 'vision_model');
  bindKeys($('#stKeys', box));
  const divKb = () => { $('#stDivKb', box).innerHTML = kbBlock({ scopeType: 'division', scopeId: $('#stDiv', box).value, compact: true }); };
  $('#stDiv', box).onchange = divKb; divKb();
}
// Logos: SVGs are kept as they are; photos/bitmaps are shrunk to 256 px (keeping transparency) before upload
function logoData(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('Could not read the file'));
    r.onload = () => {
      if (file.type === 'image/svg+xml') { resolve(r.result); return; }
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image'));
      img.onload = () => {
        const k = Math.min(1, 256 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
        const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      };
      img.src = r.result;
    };
    r.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------- API keys card
const K = {
  en: { title: 'API keys', sub: 'Give an employee or a whole room its own key: separate billing, limits and free quota. Without one, the company key in .env is used.',
    none: 'No keys yet. Add one below, then pick it for a person (room wizard → People → Details) or a whole room (room wizard → Team).',
    provider: 'Provider', label: 'Name', labelPh: 'e.g. Marketing team', secret: 'API key', add: 'Add', check: 'Check', del: 'Delete',
    today: (n) => `${n} today`, total: (n) => `${n} total`, unused: 'Not assigned yet', usedBy: 'Used by',
    localOnly: 'For safety, keys can only be added or deleted on the PC running Office Mini (the phone connection is not encrypted). You can still assign keys to people here.',
    confirmDel: (l) => `Delete the key “${l}”? People and rooms using it fall back to the company key.`, added: 'Key added', where: 'Stored only on this PC, in data/company.db. Never shown again in full.',
    states: { unchecked: 'Not checked' } },
  ar: { title: 'مفاتيح API', sub: 'اعطِ موظف أو غرفة كاملة مفتاحها الخاص: فوترة وحدود ورصيد مجاني منفصل. بدونه يُستخدم مفتاح الشركة في .env.',
    none: 'ما في مفاتيح للحين. أضف واحد تحت، بعدين اختاره لشخص (معالج الغرفة ← الأشخاص ← التفاصيل) أو لغرفة كاملة (معالج الغرفة ← الفريق).',
    provider: 'المزود', label: 'الاسم', labelPh: 'مثلاً: فريق التسويق', secret: 'مفتاح API', add: 'أضف', check: 'افحص', del: 'احذف',
    today: (n) => `${n} اليوم`, total: (n) => `${n} إجمالي`, unused: 'مو مستخدم للحين', usedBy: 'يستخدمه',
    localOnly: 'للأمان، إضافة وحذف المفاتيح بس من الكمبيوتر اللي شغّال عليه التطبيق (اتصال الجوال مو مشفّر). تقدر توزّع المفاتيح على الموظفين من هني.',
    confirmDel: (l) => `تحذف المفتاح «${l}»؟ اللي يستخدمونه يرجعون لمفتاح الشركة.`, added: 'انضاف المفتاح', where: 'ينحفظ بس على هالكمبيوتر في data/company.db. وما ينعرض كامل مرة ثانية.',
    states: { unchecked: 'ما انفحص' } },
};
const k = (key, ...a) => { const v = (K[getLang()] || K.en)[key]; return typeof v === 'function' ? v(...a) : v; };

function keysCard() {
  const { keys, can_edit } = keysState();
  const provs = (store.providersList || []).filter((p) => p.key_env !== 'OLLAMA_BASE_URL');
  return `<h3>${icon('key', 16)}${k('title')}</h3><div class="help" style="margin:-6px 0 12px">${k('sub')}</div>
    ${keys.length ? `<div class="key-list">${keys.map((x) => `<div class="key-row ${x.level}" data-key="${x.id}">
      <span class="pd"></span>
      <div class="kt"><b>${esc(x.label)}</b><small>${esc(x.provider_name)} · <code>${esc(x.masked)}</code> · ${esc(x.state === 'unchecked' ? k('states').unchecked : stateTxt(x.state))}${x.detail && x.level !== 'green' ? ` — ${esc(x.detail)}` : ''}</small>
        <small class="ku">${x.employees.length || x.rooms.length ? `${k('usedBy')}: ${[...x.rooms.map((r) => `${icon('building', 11)} ${esc(r.name)}`), ...x.employees.map((e) => esc(e.name))].join(', ')}` : k('unused')}</small></div>
      <span class="kn">${icon('zap', 11)}${k('today', x.uses_today)}<small>${k('total', x.uses)}</small></span>
      <button class="btn quiet sm" data-kcheck="${x.id}">${icon('refresh', 13)}${k('check')}</button>
      ${can_edit ? `<button class="icon-btn" data-kdel="${x.id}" title="${esc(k('del'))}">${icon('trash', 15)}</button>` : ''}</div>`).join('')}</div>`
      : `<div class="help" style="margin-bottom:12px">${icon('info', 13)} ${k('none')}</div>`}
    ${can_edit ? `<div class="key-add">
      <select class="input sm" id="kProv">${provs.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
      <input class="input sm" id="kLabel" maxlength="40" placeholder="${esc(k('labelPh'))}">
      <input class="input sm" id="kSecret" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(k('secret'))}">
      <button class="btn primary sm" id="kAdd">${icon('plus', 14)}${k('add')}</button></div>
      <div class="help">${icon('key', 12)} ${k('where')}</div><div class="err" id="kErr"></div>`
      : `<div class="help">${icon('info', 13)} ${k('localOnly')}</div>`}`;
}

function bindKeys(card) {
  if (!card) return;
  const redraw = () => { card.innerHTML = keysCard(); bindKeys(card); };
  $$('[data-kcheck]', card).forEach((b) => { b.onclick = async () => { b.disabled = true; try { await api(`/keys/${b.dataset.kcheck}/check`, 'POST'); await loadKeys(); redraw(); loadHealth(); } catch (e) { toast(e.message, true); b.disabled = false; } }; });
  $$('[data-kdel]', card).forEach((b) => { b.onclick = async () => {
    const x = keysState().keys.find((y) => y.id === +b.dataset.kdel);
    if (!await confirmBox({ title: k('del'), text: k('confirmDel', x?.label || ''), ok: k('del'), cancel: t('cancel'), danger: true, icon: 'trash' })) return;
    try { await api(`/keys/${b.dataset.kdel}`, 'DELETE'); await loadKeys(); redraw(); loadHealth(); } catch (e) { toast(e.message, true); }
  }; });
  $('#kAdd', card)?.addEventListener('click', async () => {
    const btn = $('#kAdd', card); btn.disabled = true; $('#kErr', card).textContent = '';
    try {
      await api('/keys', 'POST', { provider: $('#kProv', card).value, label: $('#kLabel', card).value, secret: $('#kSecret', card).value });
      $('#kSecret', card).value = '';
      toast(k('added')); await loadKeys(); redraw(); loadHealth();
    } catch (e) { $('#kErr', card).textContent = e.message; btn.disabled = false; }
  });
}
on('keysLoaded', () => { const c = $('#stKeys'); if (c && store.view === 'settings' && !c.contains(document.activeElement)) { c.innerHTML = keysCard(); bindKeys(c); } });

export { modelLabel };
