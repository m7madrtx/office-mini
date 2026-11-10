// Chat with any employee. Shows the chain of command as a live timeline: hand-offs and reports.
import { t, L, getLang } from './i18n.js';
import { icon } from './icons.js';
import { store, api, on, emp, titleOf, firstName } from './store.js';
import { $, h, esc, avatar, md, timeAgo, toast } from './ui.js';
import { attachMentions, highlightMentions } from './mention.js';

let ctx = null;
let C = null;   // { id, el, busy, image }

const SUGGEST = {
  gm: { en: ['What is everyone working on?', 'Ask the email team to summarise my unread mail', 'Plan the launch of our new SaaS feature'],
        ar: ['شنو قاعد يسوي كل واحد؟', 'خلّ فريق الإيميلات يلخص لي البريد غير المقروء', 'خطط لإطلاق ميزة جديدة في منتجنا'] },
  email_manager: { en: ['Anything urgent in my inbox?', 'Draft a reply to the enterprise lead', 'Which emails involve money?'],
                   ar: ['في شي مستعجل بالبريد؟', 'اكتب مسودة رد على العميل المهتم بالباقة', 'أي إيميلات فيها فلوس؟'] },
  other: { en: ['What can you do for me?', 'Give me your top 3 ideas for our product', 'Status update on your tasks'],
           ar: ['شنو تقدر تسوي لي؟', 'عطني أفضل ٣ أفكار لمنتجنا', 'وين وصلت بمهامك؟'] },
};

export function initChat(c) {
  ctx = c;
  on('message', (e) => { if (C && e.message.thread === C.id) append(e.message, true); });
  on('status', (e) => { if (C?.busy) typing(e); if (C && e.id === C.id) head(); });
  on('turn_done', (e) => { if (C && e.thread === C.id) { C.busy = false; typing(null); lock(false); } });
  on('org', () => { if (C) head(); });
}
export const chatOpen = () => C?.id || null;

export async function openChat(id) {
  const e = emp(id);
  if (!e) return;
  C = { id, busy: false, image: null };
  C.el = h(`<div style="display:flex;flex-direction:column;height:100%;min-height:0">
    <div class="d-head" id="chHead"></div>
    <div class="d-body"><div class="msgs scroll" id="chMsgs"></div></div>
    <div class="d-foot">
      <div class="attach-prev" id="chAttach" hidden><img alt=""><button aria-label="remove">${icon('x', 12)}</button></div>
      <div class="composer-wrap"><div class="mention-pop" id="chMention" hidden></div>
      <form class="composer" id="chForm">
        <button type="button" class="icon-btn" id="chImg" title="${esc(t('attach'))}">${icon('image', 18)}</button>
        <input type="file" accept="image/*" id="chFile" hidden>
        <textarea id="chInput" rows="1" placeholder="${esc(t('chatWith', e.name))}"></textarea>
        <button type="button" class="icon-btn" id="chAt" title="${esc(t('mentionHint'))}">${icon('at', 18)}</button>
        <button type="button" class="icon-btn" id="chMic" title="${esc(t('voice'))}" hidden>${icon('mic', 18)}</button>
        <button class="send" id="chSend" disabled aria-label="${esc(t('send'))}">${icon('send', 17)}</button>
      </form></div>
      <div class="mention-hint">${esc(t('mentionHint'))}</div>
    </div></div>`);
  ctx.drawer.open({ kind: 'chat', el: C.el, onClose: () => { C = null; } });
  head();
  wire();
  const { messages } = await api(`/messages?thread=${encodeURIComponent(id)}`);
  if (!C || C.id !== id) return;
  $('#chMsgs', C.el).innerHTML = '';
  if (!messages.length) empty(); else messages.forEach((m) => append(m, false));
  scrollEnd(false);
  if (!matchMedia('(max-width: 860px)').matches) setTimeout(() => $('#chInput', C?.el)?.focus(), 400);
}

function head() {
  const e = emp(C.id);
  if (!e) return;
  const mgr = emp(e.reports_to);
  $('#chHead', C.el).innerHTML = `
    ${avatar(e, '', { crown: true })}
    <div class="txt"><h3>${esc(e.name)}</h3>
      <p><span class="dot ${e.status || 'idle'}"></span>${esc(titleOf(e))}${e.status === 'working' && e.task ? ` · ${esc(e.task)}` : ''}${mgr ? ` · ${t('reportsTo')} ${esc(firstName(mgr.name))}` : ''}</p></div>
    <button class="icon-btn" id="chEdit" title="${esc(t('edit'))}">${icon('edit', 17)}</button>
    <button class="icon-btn" id="chClear" title="${esc(t('clearChat'))}">${icon('trash', 17)}</button>
    <button class="icon-btn" data-close>${icon('x', 18)}</button>`;
  $('[data-close]', C.el).onclick = () => ctx.drawer.close();
  $('#chEdit', C.el).onclick = () => { const id = C.id; ctx.drawer.close(); setTimeout(() => ctx.editEmployee(id), 250); };
  $('#chClear', C.el).onclick = async () => {
    await api(`/messages?thread=${encodeURIComponent(C.id)}`, 'DELETE');
    $('#chMsgs', C.el).innerHTML = ''; empty();
  };
}

function empty() {
  const e = emp(C.id);
  const s = SUGGEST[e.id === 'gm' ? 'gm' : e.specialty === 'email_manager' ? 'email_manager' : 'other'][getLang()] || [];
  const box = h(`<div class="chat-empty">${avatar(e, 'lg', { status: false, crown: true })}<div>${esc(t('emptyChat', firstName(e.name)))}</div>
    <div class="chips">${s.map((x) => `<button class="chip-btn">${esc(x)}</button>`).join('')}</div></div>`);
  box.querySelectorAll('.chip-btn').forEach((b) => { b.onclick = () => { $('#chInput', C.el).value = b.textContent; send(); }; });
  $('#chMsgs', C.el).append(box);
}

function append(m, animate) {
  const list = $('#chMsgs', C.el);
  list.querySelector('.chat-empty')?.remove();
  const node = render(m);
  if (!animate) node.style.animation = 'none';
  const typingEl = list.querySelector('.typing');
  typingEl ? list.insertBefore(node, typingEl) : list.append(node);
  scrollEnd(true);
}

function render(m) {
  const who = emp(m.agent);
  const nm = who ? who.name : t('former');
  if (m.kind === 'user') {
    return h(`<div class="msg user"><div class="col2"><div class="bub">${highlightMentions(esc(m.content), m.meta?.mentions)}${m.meta?.image ? ` ${icon('image', 14)}` : ''}</div></div></div>`);
  }
  if (m.kind === 'approval') {
    const to = emp(m.meta?.to);
    return h(`<div class="event ${m.meta?.approved ? 'ok' : 'no'}">${icon(m.meta?.approved ? 'check' : 'x', 16)}<span><b>${t('you')}</b> → <b>${esc(firstName(to?.name || ''))}</b></span><span class="ttl">${esc(m.content)}${m.meta?.result ? ` · ${esc(m.meta.result)}` : ''}</span></div>`);
  }
  if (m.kind === 'handoff') {
    const to = emp(m.meta?.to);
    const consult = m.meta?.kind === 'consult';
    return h(`<div class="event${consult ? ' consult' : ''}">${icon(consult ? 'message' : 'arrow', 16)}<span>${consult ? esc(t('consulted', firstName(nm), firstName(to?.name || t('former')))) : `<b>${esc(firstName(nm))}</b> → <b>${esc(firstName(to?.name || t('former')))}</b>`}</span><span class="ttl">${esc(m.content)}</span></div>`);
  }
  if (m.kind === 'report') {
    const to = emp(m.meta?.to);
    const label = m.meta?.kind === 'consult' ? t('answered', firstName(nm), firstName(to?.name || t('former'))) : t('reportTo', firstName(nm), firstName(to?.name || t('former')));
    const el = h(`<div class="report open"><header>${avatar(who, 'sm', { status: false })}<div class="t">${esc(label)}<br><span style="color:var(--faint);font-size:11px">${esc(who ? titleOf(who) : '')}</span></div><span class="chev">${icon('down', 16)}</span></header>
      <div class="body"><div><div class="bub">${md(m.content)}</div></div></div></div>`);
    el.querySelector('header').onclick = () => el.classList.toggle('open');
    return el;
  }
  return h(`<div class="msg agent${m.kind === 'error' ? ' error' : ''}">${avatar(who, 'sm', { status: false })}<div class="col2">
    <div class="who">${esc(firstName(nm))}<small>${esc(timeAgo(m.ts, getLang()))}</small></div>
    <div class="bub">${md(m.content)}</div>
    ${m.meta?.requests ? `<div class="foot-meta">${icon('zap', 12)}${esc(t('requests', m.meta.requests))}</div>` : ''}</div></div>`);
}

function typing(e) {
  const list = $('#chMsgs', C?.el);
  if (!list) return;
  let el = list.querySelector('.typing');
  if (!C.busy) { el?.remove(); return; }
  const who = e && e.status === 'working' ? emp(e.id) : emp(C.id);
  const label = e && e.status === 'working' && e.task ? e.task : t('thinking');
  if (!el) { el = h('<div class="typing"></div>'); list.append(el); }
  el.innerHTML = `${avatar(who, 'xs', { status: false })}<span><b style="color:var(--ink-2)">${esc(firstName(who?.name || ''))}</b> · ${esc(label)}</span><i><span></span><span></span><span></span></i>`;
  scrollEnd(true);
}

function lock(on) {
  const s = $('#chSend', C?.el);
  if (s) s.disabled = on || (!$('#chInput', C.el).value.trim() && !C.image);
}

function scrollEnd(smooth) {
  const list = $('#chMsgs', C?.el);
  if (list) list.scrollTo({ top: list.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

async function send(ev) {
  ev?.preventDefault();
  const input = $('#chInput', C.el);
  const text = input.value.trim();
  if ((!text && !C.image) || C.busy) return;
  C.busy = true;
  const image = C.image;
  input.value = ''; autosize(input); clearImage(); lock(true);
  typing(null);
  const mentions = C.mentions?.get() || [];
  C.mentions?.reset();
  try {
    await api('/chat', 'POST', { thread: C.id, text, image, mentions });
  } catch (e) {
    toast(e.message || t('failed'), true);
  } finally {
    if (C) { C.busy = false; typing(null); lock(false); }
  }
}

function autosize(ta) { ta.style.height = 'auto'; ta.style.height = `${Math.min(140, ta.scrollHeight)}px`; }
function clearImage() { if (!C) return; C.image = null; $('#chAttach', C.el).hidden = true; lock(C.busy); }

function wire() {
  const el = C.el;
  const input = $('#chInput', el);
  C.mentions = attachMentions(input, $('#chMention', el));
  $('#chAt', el).onclick = () => {
    const pos = input.selectionStart ?? input.value.length;
    const pre = input.value.slice(0, pos);
    input.value = `${pre}${pre && !/\s$/.test(pre) ? ' ' : ''}@${input.value.slice(pos)}`;
    input.focus(); const at = input.value.indexOf('@', pos) + 1; input.setSelectionRange(at, at);
    input.dispatchEvent(new Event('input'));
  };
  $('#chForm', el).onsubmit = send;
  input.oninput = () => { autosize(input); lock(C.busy); };
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } };
  $('#chImg', el).onclick = () => $('#chFile', el).click();
  $('#chAttach button', el).onclick = clearImage;
  $('#chFile', el).onchange = async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    const img = new Image(); img.src = URL.createObjectURL(file); await img.decode();
    const k = Math.min(1, 1280 / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    C.image = c.toDataURL('image/jpeg', 0.85);
    $('#chAttach img', el).src = C.image; $('#chAttach', el).hidden = false; lock(C.busy);
  };
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR && window.isSecureContext) {
    const mic = $('#chMic', el); mic.hidden = false;
    let rec = null;
    mic.onclick = () => {
      if (rec) { rec.stop(); return; }
      rec = new SR(); rec.lang = getLang() === 'ar' ? 'ar-KW' : 'en-US'; rec.interimResults = true;
      const before = input.value;
      rec.onresult = (ev) => { input.value = `${before} ${Array.from(ev.results).map((r) => r[0].transcript).join(' ')}`.trim(); autosize(input); lock(C.busy); };
      rec.onend = () => { rec = null; mic.style.color = ''; };
      mic.style.color = 'var(--s-working)'; rec.start();
    };
  }
}
