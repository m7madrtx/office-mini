// Model picker: choose a provider + model per employee, with capabilities and role-based suggestions.
import { t } from './i18n.js';
import { icon, CAP_ICON } from './icons.js';
import { api, store } from './store.js';
import { $, $$, esc } from './ui.js';

let providersCache = null;
const modelsCache = {};

export async function providers() {
  if (!providersCache) providersCache = (await api('/providers')).providers;
  return providersCache;
}
async function modelsFor(pid) {
  if (!modelsCache[pid]) modelsCache[pid] = (await api(`/models?provider=${pid}`)).models[pid] || [];
  return modelsCache[pid];
}

// On OpenRouter's free tier, paid models fail with "no credit" — flag them
const paidTag = (pid, caps) => (pid === 'openrouter' && !caps.includes('free') && store.quota?.free_tier ? ` · <span class="paid">${t('caps').free === 'Free' ? 'needs credit' : 'يحتاج رصيد'}</span>` : '');

export function modelLabel(ref) {
  if (!ref) return t('companyDefault');
  const id = ref.split(':').slice(1).join(':');
  return id.split('/').pop().replace(/:free$/, ' (free)');
}
export function capChips(caps = [], { only = null, small = false } = {}) {
  return `<span class="caps">${caps.filter((c) => !only || only.includes(c)).map((c) => `<span class="cap cap-${c}${small ? ' sm' : ''}" title="${esc(t('caps')[c] || c)}">${icon(CAP_ICON[c] || 'info', small ? 11 : 12)}${small ? '' : esc(t('caps')[c] || c)}</span>`).join('')}</span>`;
}

export function pickModel({ current = '', specialty = null, allowDefault = true, title = null, provider = null } = {}) {
  return new Promise(async (resolve) => {
    const modal = $('#modal'), sheet = $('#modalSheet');
    const provs = await providers();
    const on = provs.filter((p) => p.configured);
    let pid = provider || (current && current.split(':')[0]) || on[0]?.id || 'openrouter';
    if (!on.find((p) => p.id === pid)) pid = on[0]?.id;
    let query = '';
    const filters = new Set();
    const finish = (val) => { modal.classList.remove('on'); resolve(val); };
    sheet.innerHTML = `<div class="d-head"><div class="av" style="--c:#8b7cff">${icon('cpu', 18)}</div>
        <div class="txt"><h3>${esc(title || t('chooseModel'))}</h3><p>${esc(current ? modelLabel(current) : t('companyDefault'))}</p></div>
        <button class="icon-btn" data-close>${icon('x', 18)}</button></div>
      <div class="content scroll" style="padding-top:12px">
        <div id="mpSuggest"></div>
        ${allowDefault ? `<button class="model-row default${!current ? ' on' : ''}" data-ref="">${icon('building', 16)}<span class="mn"><b>${t('useDefault')}</b><small>${esc(modelLabel(store.org.settings.default_model))}</small></span></button>` : ''}
        <div class="label" style="margin-top:16px">${t('allModels')}</div>
        <div class="pills" id="mpProv">${provs.map((p) => `<button class="pill${p.id === pid ? ' on' : ''}" data-p="${p.id}" ${p.configured ? '' : 'disabled'} title="${p.configured ? '' : esc(p.key_env)}">${esc(p.name)}${p.configured ? '' : ` ${icon('key', 12)}`}</button>`).join('')}</div>
        ${on.length < 2 ? `<div class="help" style="margin:8px 0 0">${icon('info', 13)} ${t('noProviders')}</div>` : ''}
        <div style="display:flex;gap:8px;margin:12px 0 8px"><input class="input sm" id="mpQ" placeholder="${esc(t('searchModels'))}"></div>
        <div class="pills" id="mpCaps">${['free', 'vision', 'ocr', 'audio', 'coding', 'reasoning', 'multilingual', 'long_context'].map((c) => `<button class="pill sm-pill" data-cap="${c}">${icon(CAP_ICON[c], 12)}${esc(t('caps')[c])}</button>`).join('')}</div>
        <div id="mpList" class="model-list"></div>
      </div>`;
    modal.classList.add('on');
    $('[data-close]', sheet).onclick = () => finish(null);
    modal.onclick = (e) => { if (e.target === modal) finish(null); };
    const bindRows = (root) => $$('[data-ref]', root).forEach((b) => { b.onclick = () => finish(b.dataset.ref); });
    bindRows(sheet);

    if (specialty) {
      api(`/models/suggest?specialty=${specialty}&n=${provider ? 12 : 4}`).then(({ needs, suggestions }) => {
        const box = $('#mpSuggest', sheet);
        if (!box) return;
        if (provider) suggestions = suggestions.filter((s) => s.provider === provider).slice(0, 4);   // only models the chosen key can call
        if (!suggestions.length) return;
        box.innerHTML = `<div class="label">${t('suggested')}</div>
          <div class="help" style="margin:-2px 0 8px">${t('needs')} ${capChips(needs, { small: false })}</div>
          ${suggestions.map((s) => `<button class="model-row sug${s.ref === current ? ' on' : ''}" data-ref="${esc(s.ref)}">${icon('sparkles', 16)}
            <span class="mn"><b>${esc(s.name)}</b><small>${esc(s.provider)}${paidTag(s.provider, s.caps)}${s.missing.length ? ` · ${t('missing')}: ${s.missing.map((c) => t('caps')[c]).join(', ')}` : ''}</small></span>${capChips(s.caps, { small: true })}</button>`).join('')}`;
        bindRows(box);
      }).catch(() => {});
    }

    const renderList = async () => {
      const list = $('#mpList', sheet);
      list.innerHTML = `<div class="help" style="padding:12px">…</div>`;
      const models = pid ? await modelsFor(pid) : [];
      const q = query.toLowerCase();
      const rows = models.filter((m) => (!q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) && [...filters].every((c) => m.caps.includes(c))).slice(0, 150);
      list.innerHTML = rows.map((m) => {
        const ref = `${pid}:${m.id}`;
        return `<button class="model-row${ref === current ? ' on' : ''}" data-ref="${esc(ref)}"><span class="mn"><b>${esc(m.name)}</b><small>${esc(m.id)}${m.context ? ` · ${Math.round(m.context / 1000)}k` : ''}${paidTag(pid, m.caps)}</small></span>${capChips(m.caps, { small: true })}</button>`;
      }).join('') || `<div class="help" style="padding:12px">—</div>`;
      bindRows(list);
    };
    $$('[data-p]', sheet).forEach((b) => { b.onclick = () => { pid = b.dataset.p; $$('[data-p]', sheet).forEach((x) => x.classList.toggle('on', x === b)); renderList(); }; });
    $$('[data-cap]', sheet).forEach((b) => { b.onclick = () => { const c = b.dataset.cap; filters.has(c) ? filters.delete(c) : filters.add(c); b.classList.toggle('on'); renderList(); }; });
    let timer;
    $('#mpQ', sheet).oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => { query = e.target.value; renderList(); }, 150); };
    renderList();
  });
}

// A compact button showing the current model; opens the picker.
export function modelButton(ref, specialty, onPick) {
  const id = `mb${Math.random().toString(36).slice(2, 8)}`;
  const html = `<button type="button" class="model-btn" id="${id}">${icon('cpu', 14)}<span>${esc(modelLabel(ref))}</span>${icon('down', 13)}</button>`;
  setTimeout(() => {
    const b = document.getElementById(id);
    if (b) b.onclick = async () => { const r = await pickModel({ current: ref, specialty }); if (r !== null) onPick(r); };
  });
  return html;
}
