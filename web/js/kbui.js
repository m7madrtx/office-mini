// Knowledge-base attachments for an employee, room, division or the company.
import { t } from './i18n.js';
import { icon } from './icons.js';
import { api } from './store.js';
import { $, esc, toast } from './ui.js';

const fmtSize = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const readFile = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });

// Render a knowledge block. If scopeId is missing (entity not saved yet), files are kept in `staged`.
export function kbBlock({ scopeType, scopeId = null, staged = null, compact = false }) {
  const id = `kb${Math.random().toString(36).slice(2, 8)}`;
  setTimeout(() => mount(document.getElementById(id), { scopeType, scopeId, staged }));
  return `<div class="kb${compact ? ' compact' : ''}" id="${id}"><div class="kb-list"></div>
    <label class="kb-add">${icon('upload', 14)}<span>${t('addFiles')}</span><input type="file" multiple hidden
      accept=".pdf,.docx,.txt,.md,.csv,.json,.py,.js,.ts,.html,.css,.yaml,.yml,.xml,.sql,.log,.java,.go,.rs,.c,.cpp,.cs,.php,.rb,image/*"></label>
    ${compact ? '' : `<div class="help">${t('kbHelp')}</div>`}</div>`;
}

async function mount(root, { scopeType, scopeId, staged }) {
  if (!root) return;
  const list = $('.kb-list', root);
  const render = async () => {
    let files = [];
    if (scopeId) files = (await api(`/kb?scope_type=${scopeType}&scope_id=${encodeURIComponent(scopeId)}`)).files;
    const stagedRows = (staged || []).map((f, i) => `<div class="kb-file staged">${icon('clip', 13)}<span class="nm">${esc(f.name)}</span><small>${t('staged')}</small><button data-unstage="${i}">${icon('x', 12)}</button></div>`);
    list.innerHTML = files.map((f) => `<div class="kb-file">${icon('file', 13)}<span class="nm" title="${esc(f.name)}">${esc(f.name)}</span><small>${fmtSize(f.size)}</small><button data-del="${f.id}" title="${esc(t('delete'))}">${icon('x', 12)}</button></div>`).join('') + stagedRows.join('');
    list.querySelectorAll('[data-del]').forEach((b) => { b.onclick = async () => { await api(`/kb/${b.dataset.del}`, 'DELETE'); render(); }; });
    list.querySelectorAll('[data-unstage]').forEach((b) => { b.onclick = () => { staged.splice(+b.dataset.unstage, 1); render(); }; });
  };
  $('input', root).onchange = async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    for (const f of files) {
      if (f.size > 15e6) { toast(`${f.name}: > 15 MB`, true); continue; }
      const data = await readFile(f);
      if (scopeId) {
        try { await api('/kb', 'POST', { scope_type: scopeType, scope_id: scopeId, name: f.name, mime: f.type, data }); }
        catch (err) { toast(err.message, true); }
      } else if (staged) staged.push({ name: f.name, mime: f.type, data });
    }
    if (scopeId && files.length) toast(t('uploaded', files.length));
    render();
  };
  render();
}

export async function uploadStaged(scopeType, scopeId, staged = []) {
  for (const f of staged) await api('/kb', 'POST', { scope_type: scopeType, scope_id: scopeId, name: f.name, mime: f.mime, data: f.data });
}
