// API keys added in Settings, and the pickers that assign them to an employee or a room.
import { getLang } from './i18n.js';
import { api, on, emit, store } from './store.js';
import { esc } from './ui.js';

let cache = { keys: [], can_edit: false };
export const ar = () => getLang() === 'ar';
export const keysState = () => cache;

export async function loadKeys() {
  try { cache = await api('/keys'); } catch { /* offline */ }
  if (!store.providersList) { try { store.providersList = (await api('/providers')).providers; } catch { /* offline */ } }
  emit('keysLoaded', cache);
  return cache;
}
on('keys', loadKeys);

export const keyById = (id) => cache.keys.find((k) => k.id === +id);
export const providerOf = (ref) => (ref || store.org?.settings.default_model || '').split(':')[0];

// <select> for one employee, grouped by provider: each provider's company key from .env, plus keys added in Settings.
// Values: "env:<provider>" (company key, or the room's key if it has one for that provider) or "<key id>".
// Picking a different provider than the current model's means the model must change too (the caller handles that).
export function keySelect({ model, current, roomKey = null, attrs = '' }) {
  const pid = providerOf(model);
  const provs = (store.providersList || []).filter((p) => p.key_env !== 'OLLAMA_BASE_URL');
  const room = roomKey ? keyById(roomKey) : null;
  const own = keyById(current);
  const selected = own ? String(own.id) : `env:${pid}`;
  const groups = provs.map((p) => {
    const mine = cache.keys.filter((k) => k.provider === p.id);
    if (!p.company && !mine.length) return '';
    const inherit = room && room.provider === p.id
      ? (ar() ? `مفتاح الغرفة · ${room.label}` : `Room key · ${room.label}`)
      : (ar() ? 'مفتاح الشركة (.env)' : 'Company key (.env)');
    return `<optgroup label="${esc(p.name)}">
      ${p.company || (room && room.provider === p.id) ? `<option value="env:${p.id}" ${selected === `env:${p.id}` ? 'selected' : ''}>${esc(p.name)} · ${esc(inherit)}</option>` : ''}
      ${mine.map((k) => `<option value="${k.id}" ${selected === String(k.id) ? 'selected' : ''}>${esc(p.name)} · ${esc(k.label)} ${esc(k.masked)}</option>`).join('')}</optgroup>`;
  }).join('');
  const covered = provs.some((p) => p.id === pid && (p.company || (room && room.provider === pid))) || own;
  const missing = covered ? '' : `<option value="" selected disabled>${esc(ar() ? `اختر مفتاح لـ ${pid}` : `Pick a key for ${pid}`)}</option>`;
  return `<select class="input sm" ${attrs}>${missing}${groups}</select>`;
}

// Parse a keySelect value → { provider, keyId }
export function parseKeyChoice(v) {
  if (!v) return null;
  if (v.startsWith('env:')) return { provider: v.slice(4), keyId: null };
  const k = keyById(v);
  return k ? { provider: k.provider, keyId: k.id } : null;
}

// <select> for a room: applies to everyone in it whose model is from the same provider
export function roomKeySelect(current, attrs = '') {
  const groups = {};
  for (const k of cache.keys) (groups[k.provider_name] ||= []).push(k);
  return `<select class="input sm" ${attrs}>
    <option value="">${ar() ? 'بدون (كل شخص يستخدم مفتاحه أو مفتاح الشركة)' : 'None (each person’s own key, or the company key)'}</option>
    ${Object.entries(groups).map(([name, ks]) => `<optgroup label="${esc(name)}">${ks.map((k) => `<option value="${k.id}" ${+current === k.id ? 'selected' : ''}>${esc(k.label)} · ${esc(k.masked)}</option>`).join('')}</optgroup>`).join('')}
  </select>`;
}

// short text for an employee card: which key their calls use
export function keyLine(e) {
  const pid = providerOf(e.model);
  const own = keyById(e.api_key_id);
  if (own && own.provider === pid) return own.label;
  const room = store.org?.rooms.find((r) => r.id === e.room_id);
  const rk = room && keyById(room.api_key_id);
  if (rk && rk.provider === pid) return `${rk.label} (${ar() ? 'الغرفة' : 'room'})`;
  return ar() ? 'مفتاح الشركة' : 'Company key';
}
