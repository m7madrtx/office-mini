// App state, API calls and the live event stream.
import { L } from './i18n.js';

export const store = { catalog: null, org: null, quota: null, view: 'building', online: true };
const subs = new Map();
export const on = (evt, fn) => { if (!subs.has(evt)) subs.set(evt, new Set()); subs.get(evt).add(fn); return () => subs.get(evt).delete(fn); };
export const emit = (evt, data) => subs.get(evt)?.forEach((fn) => fn(data));

export async function api(path, method = 'GET', body) {
  const r = await fetch(`/api${path}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
  return data;
}

export const emp = (id) => store.org?.employees.find((e) => e.id === id);
export const room = (id) => store.org?.rooms.find((r) => r.id === id);
export const spec = (id) => store.catalog?.specialties.find((s) => s.id === id);
export const division = (id) => store.catalog?.divisions.find((d) => d.id === id);
export const people = (roomId) => store.org.employees.filter((e) => e.room_id === roomId).sort((a, b) => a.desk - b.desk || a.seat - b.seat);
export const titleOf = (e) => L(e?.title) || '';
// "Team lead" / "Team member" (the GM has no rank label)
export const rankOf = (e) => (e && e.seniority > 0 ? L(store.catalog?.seniority.find((s) => s.level === e.seniority)?.name) || '' : '');
export const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
export const firstName = (name = '') => name.split(/\s+/)[0] || name;

export function setOrg(org) {
  store.org = org;
  emit('org', org);
}

export async function boot() {
  const [catalog, org] = await Promise.all([api('/catalog'), api('/org')]);
  store.catalog = catalog;
  setOrg(org);
  api('/quota').then((q) => { store.quota = q; emit('quota', q); }).catch(() => {});
  connect();
}

function connect() {
  const es = new EventSource('/api/events');
  // after a reconnect (e.g. the server restarted with an update) reload the catalog too, so options like ranks stay current
  es.onopen = () => {
    if (store.online) return;
    store.online = true; emit('online', true);
    api('/catalog').then((c) => { store.catalog = c; return api('/org'); }).then(setOrg).catch(() => {});
  };
  es.onerror = () => { if (store.online) { store.online = false; emit('online', false); } };
  es.onmessage = (ev) => {
    const e = JSON.parse(ev.data);
    switch (e.type) {
      case 'org': setOrg(e.org); break;
      case 'status': {
        const p = emp(e.id);
        if (p) { p.status = e.status; p.task = e.task; p.status_ts = e.ts; }
        emit('status', e);
        break;
      }
      case 'quota': store.quota = e; emit('quota', e); break;
      default: emit(e.type, e);
    }
  };
}
