/* ============================================================
   Aria Dashboard — core runtime (app.js)
   Auth plumbing, API helpers, hash router, command palette,
   toasts, drawer, modals, skeletons, coach-marks tutorial.
   Panels live in panels.js (global `Panels`).
   ============================================================ */
'use strict';

/* ---------------- auth ---------------- */
const _qs = new URLSearchParams(location.search);
const OWNER = _qs.get('owner') || '';
const TOKEN = _qs.get('s') || '';
const Q = 'owner=' + encodeURIComponent(OWNER) + '&s=' + encodeURIComponent(TOKEN);

if (!OWNER || !TOKEN) {
  // Not authenticated — bounce to login (preserve owner if we have it).
  location.replace('/dashboard/login.html' + (OWNER ? '?owner=' + encodeURIComponent(OWNER) : ''));
}

/* ---------------- tiny DOM helpers ---------------- */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------------- API helpers (owner + s query auth) ---------------- */
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function _withQ(path) {
  return path + (path.includes('?') ? '&' : '?') + Q;
}

async function _handle(res) {
  if (res.status === 401) {
    location.replace('/dashboard/login.html?owner=' + encodeURIComponent(OWNER) + '&expired=1');
    throw new ApiError(401, 'Session expired');
  }
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    data = await res.json().catch(() => null);
  } else {
    data = await res.text().catch(() => null);
  }
  if (!res.ok) {
    const msg = (data && data.error) ? data.error : (typeof data === 'string' && data ? data.slice(0, 140) : 'Request failed (' + res.status + ')');
    throw new ApiError(res.status, msg);
  }
  return data;
}

async function api(path) {
  const res = await fetch(_withQ(path), { headers: { 'x-session-token': TOKEN } });
  return _handle(res);
}
async function apiPost(path, body) {
  const res = await fetch(_withQ(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-token': TOKEN },
    body: JSON.stringify(Object.assign({ owner: OWNER }, body || {})),
  });
  return _handle(res);
}
async function apiDelete(path) {
  const res = await fetch(_withQ(path), { method: 'DELETE', headers: { 'x-session-token': TOKEN } });
  return _handle(res);
}

/* profile cache — the old dashboard fetched /profile 6x per visit */
let _profilePromise = null;
function getProfile(force) {
  if (force || !_profilePromise) {
    _profilePromise = api('/api/dashboard/profile').then(d => (d && d.profile) || {});
  }
  return _profilePromise;
}
function invalidateProfile() { _profilePromise = null; }

/* ---------------- formatting ---------------- */
function timeAgo(d) {
  if (!d) return '';
  const ts = typeof d === 'number' ? d : Date.parse(d);
  if (Number.isNaN(ts)) return String(d);
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function fmtDate(d) {
  const ts = typeof d === 'number' ? d : Date.parse(d);
  if (Number.isNaN(ts)) return String(d || '');
  return new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function fmtNum(n) { return Number(n || 0).toLocaleString(); }

/* ---------------- channel metadata (single source — was duplicated 6x) ---------------- */
const CHANNELS = {
  facebook:  { key: 'facebook',  label: 'Messenger', icon: 'facebook',  cssVar: 'var(--ch-facebook)' },
  instagram: { key: 'instagram', label: 'Instagram', icon: 'instagram', cssVar: 'var(--ch-instagram)' },
  whatsapp:  { key: 'whatsapp',  label: 'WhatsApp',  icon: 'message-circle', cssVar: 'var(--ch-whatsapp)' },
  email:     { key: 'email',     label: 'Email',     icon: 'mail',      cssVar: 'var(--ch-email)' },
  web:       { key: 'web',       label: 'Web chat',  icon: 'globe',     cssVar: 'var(--ch-web)' },
  phone:     { key: 'phone',     label: 'Phone',     icon: 'phone',     cssVar: 'var(--ch-phone)' },
};
function chMeta(key) {
  const k = String(key || '').toLowerCase();
  if (k === 'fb' || k === 'messenger') return CHANNELS.facebook;
  if (k === 'ig') return CHANNELS.instagram;
  if (k === 'wa') return CHANNELS.whatsapp;
  return CHANNELS[k] || { key: k, label: k || 'Unknown', icon: 'message-square', cssVar: 'var(--text-3)' };
}
function chIcon(key, size) {
  const m = chMeta(key);
  return '<span class="ch-ic" style="color:' + m.cssVar + ';background:color-mix(in srgb, ' + m.cssVar + ' 12%, transparent)" title="' + esc(m.label) + '">' + icon(m.icon, size || 15) + '</span>';
}

/* ---------------- toasts (top-right stack, max 3) ---------------- */
function toast(msg, type) {
  type = type || 'success';
  const wrap = $('#toasts');
  while (wrap.children.length >= 3) wrap.removeChild(wrap.firstChild);
  const ic = type === 'error' ? 'alert-circle' : type === 'info' ? 'info' : 'check';
  const t = el('<div class="toast ' + type + '">' + icon(ic, 16) + '<div>' + esc(msg) + '</div></div>');
  wrap.appendChild(t);
  setTimeout(() => {
    t.classList.add('leaving');
    t.addEventListener('animationend', () => t.remove(), { once: true });
  }, 3500);
}

/* ---------------- skeleton / empty / error states ---------------- */
function skeletonHTML(rows) {
  const widths = [62, 85, 71, 90, 54, 78];
  let html = '<div class="skel" role="status" aria-label="Loading">';
  for (let i = 0; i < (rows || 5); i++) {
    html += '<div class="skel-row" style="width:' + widths[i % widths.length] + '%"></div>';
  }
  return html + '</div>';
}
function emptyStateHTML(ic, title, sub, ctaLabel, ctaAttr) {
  return '<div class="empty-state">' + icon(ic, 28) +
    '<div class="es-title">' + esc(title) + '</div>' +
    '<div class="es-sub">' + esc(sub) + '</div>' +
    (ctaLabel ? '<button class="btn" ' + (ctaAttr || '') + '>' + esc(ctaLabel) + '</button>' : '') +
    '</div>';
}
function errorStateHTML(msg) {
  return '<div class="error-state">' + icon('alert-triangle', 26) +
    '<div class="es-title">Couldn’t load this</div>' +
    '<div class="es-sub">' + esc(msg || 'Something went wrong.') + '</div>' +
    '<button class="btn" data-retry>' + icon('refresh', 14) + ' Retry</button></div>';
}

/**
 * Standard three-state loader: skeleton -> content | empty | inline error with retry.
 * renderer(data, container) returns false to show the empty state instead.
 */
function loadInto(container, fetcher, renderer, opts) {
  opts = opts || {};
  container.innerHTML = skeletonHTML(opts.rows || 5);
  fetcher().then(data => {
    container.innerHTML = '';
    const ok = renderer(data, container);
    if (ok === false) {
      container.innerHTML = emptyStateHTML(
        opts.emptyIcon || 'inbox',
        opts.emptyTitle || 'Nothing here yet',
        opts.emptySub || 'New items will show up here.',
        opts.emptyCta, opts.emptyCtaAttr
      );
    }
  }).catch(err => {
    if (opts.degrade && (err.status === 404 || err.status === 400)) {
      // Graceful degrade: endpoint not available — hide the section, log once.
      console.warn('[aria] section degraded:', err.message);
      container.closest(opts.degrade) ? container.closest(opts.degrade).remove() : (container.innerHTML = '');
      return;
    }
    container.innerHTML = errorStateHTML(err.message);
    const retry = $('[data-retry]', container);
    if (retry) retry.addEventListener('click', () => loadInto(container, fetcher, renderer, opts));
  });
}

/* ---------------- focus trap ---------------- */
function trapFocus(container, e) {
  const focusables = $$('a[href], button:not(:disabled), input, select, textarea, [tabindex]:not([tabindex="-1"])', container)
    .filter(n => n.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0], last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/* ---------------- drawer (right slide-over, 480px) ---------------- */
let _drawerReturnFocus = null;

function openDrawer(title) {
  const overlay = $('#drawer-overlay');
  const drawer = $('#drawer');
  _drawerReturnFocus = document.activeElement;
  $('#drawer-title').textContent = title || '';
  const body = $('#drawer-body');
  body.innerHTML = skeletonHTML(6);
  overlay.classList.add('open');
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  $('#drawer-close').focus();
  return body;
}
function setDrawerTitle(title) { $('#drawer-title').textContent = title; }
function closeDrawer() {
  const drawer = $('#drawer');
  if (!drawer.classList.contains('open')) return;
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  $('#drawer-overlay').classList.remove('open');
  if (_drawerReturnFocus && _drawerReturnFocus.focus) _drawerReturnFocus.focus();
  _drawerReturnFocus = null;
}

/* ---------------- modal + confirm dialog ---------------- */
function closeModal() {
  $('#modal').classList.remove('open');
  $('#modal-overlay').classList.remove('open');
}

/**
 * confirmDialog({title, body, confirmLabel, danger, typedPhrase}) -> Promise<boolean>
 */
function confirmDialog(opts) {
  return new Promise(resolve => {
    const modal = $('#modal');
    const overlay = $('#modal-overlay');
    const phraseHtml = opts.typedPhrase
      ? '<div class="field"><label for="modal-phrase">Type <strong>' + esc(opts.typedPhrase) + '</strong> to confirm</label>' +
        '<input id="modal-phrase" class="input" autocomplete="off" spellcheck="false"></div>'
      : '';
    modal.innerHTML =
      '<h2 id="modal-title">' + esc(opts.title) + '</h2>' +
      '<div class="modal-body">' + (opts.bodyHtml || esc(opts.body || '')) + phraseHtml + '</div>' +
      '<div class="modal-actions">' +
        '<button class="btn btn-ghost" data-act="cancel">Cancel</button>' +
        '<button class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" data-act="ok"' + (opts.typedPhrase ? ' disabled' : '') + '>' +
          esc(opts.confirmLabel || 'Confirm') + '</button>' +
      '</div>';
    overlay.classList.add('open');
    modal.classList.add('open');

    const done = (val) => { closeModal(); modal._onEscape = null; resolve(val); };
    modal._onEscape = () => done(false);
    $('[data-act="cancel"]', modal).addEventListener('click', () => done(false));
    $('[data-act="ok"]', modal).addEventListener('click', () => done(true));
    overlay.onclick = () => done(false);
    const phraseInput = $('#modal-phrase', modal);
    if (phraseInput) {
      phraseInput.addEventListener('input', () => {
        $('[data-act="ok"]', modal).disabled = phraseInput.value.trim() !== opts.typedPhrase;
      });
      phraseInput.focus();
    } else {
      $('[data-act="ok"]', modal).focus();
    }
    modal.addEventListener('keydown', e => { if (e.key === 'Tab') trapFocus(modal, e); });
  });
}

/* ---------------- command palette (fuzzy, recent-first) ---------------- */
const RECENT_KEY = 'aria_cmdk_recent';
let _cmdkItems = [];
let _cmdkSel = 0;

function fuzzyScore(query, text) {
  const q = query.toLowerCase().replace(/\s+/g, '');
  const t = text.toLowerCase();
  if (!q) return 0;
  let score = 0, ti = 0, prev = -2;
  for (const ch of q) {
    let found = -1;
    for (let i = ti; i < t.length; i++) { if (t[i] === ch) { found = i; break; } }
    if (found < 0) return -1;
    score += 1;
    if (found === prev + 1) score += 2;                       // consecutive run
    if (found === 0 || /[\s\/\-]/.test(t[found - 1])) score += 3; // word boundary
    prev = found; ti = found + 1;
  }
  return score - t.length * 0.01;
}

function getCommands() {
  const go = Object.keys(ROUTES).map(name => ({
    id: 'go:' + name,
    section: 'Go',
    label: 'Go to ' + ROUTES[name].title,
    icon: ROUTES[name].icon,
    hint: '#/' + name,
    run: () => navigate(name),
  }));
  const doCmds = [
    { id: 'do:export-leads', section: 'Do', label: 'Export leads as CSV', icon: 'download', run: () => window.exportLeadsCSV && window.exportLeadsCSV() },
    { id: 'do:refresh', section: 'Do', label: 'Refresh current panel', icon: 'refresh', run: () => renderRoute() },
    { id: 'do:tutorial', section: 'Do', label: 'Replay the tour', icon: 'help', run: () => startTutorial(true) },
    { id: 'do:logout', section: 'Do', label: 'Log out', icon: 'logout', run: logout },
  ];
  return go.concat(doCmds);
}

function openPalette() {
  const ov = $('#cmdk-overlay'), pal = $('#cmdk');
  ov.classList.add('open');
  pal.classList.add('open');
  pal.setAttribute('aria-hidden', 'false');
  const input = $('#cmdk-input');
  input.value = '';
  renderPalette('');
  input.focus();
}
function closePalette() {
  const pal = $('#cmdk');
  if (!pal.classList.contains('open')) return;
  pal.classList.remove('open');
  pal.setAttribute('aria-hidden', 'true');
  $('#cmdk-overlay').classList.remove('open');
}
function paletteIsOpen() { return $('#cmdk').classList.contains('open'); }

function renderPalette(query) {
  const all = getCommands();
  let items;
  if (!query.trim()) {
    // recent-first when no query
    let recents = [];
    try { recents = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (e) { /* ignore */ }
    const recentItems = recents.map(id => all.find(c => c.id === id)).filter(Boolean)
      .map(c => Object.assign({}, c, { section: 'Recent' }));
    const rest = all.filter(c => !recents.includes(c.id));
    items = recentItems.concat(rest);
  } else {
    items = all
      .map(c => ({ c, s: fuzzyScore(query, c.label) }))
      .filter(x => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map(x => x.c);
  }
  _cmdkItems = items;
  _cmdkSel = 0;
  const list = $('#cmdk-list');
  if (!items.length) {
    list.innerHTML = '<li class="cmdk-empty">No matching commands</li>';
    return;
  }
  let html = '';
  let lastSection = null;
  items.forEach((c, i) => {
    if (c.section !== lastSection) {
      html += '<li class="cmdk-section" role="presentation">' + esc(c.section) + '</li>';
      lastSection = c.section;
    }
    html += '<li class="cmdk-item' + (i === 0 ? ' selected' : '') + '" id="cmdk-opt-' + i + '" role="option" data-i="' + i + '"' +
      (i === 0 ? ' aria-selected="true"' : ' aria-selected="false"') + '>' +
      icon(c.icon || 'chevron-right', 15) + '<span>' + esc(c.label) + '</span>' +
      (c.hint ? '<span class="ck-hint">' + esc(c.hint) + '</span>' : '') + '</li>';
  });
  list.innerHTML = html;
  $$('.cmdk-item', list).forEach(node => {
    node.addEventListener('click', () => runCommand(Number(node.dataset.i)));
    node.addEventListener('mousemove', () => setPaletteSel(Number(node.dataset.i)));
  });
}
function setPaletteSel(i) {
  if (i < 0 || i >= _cmdkItems.length) return;
  _cmdkSel = i;
  $$('.cmdk-item').forEach(n => {
    const on = Number(n.dataset.i) === i;
    n.classList.toggle('selected', on);
    n.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on) n.scrollIntoView({ block: 'nearest' });
  });
  $('#cmdk-input').setAttribute('aria-activedescendant', 'cmdk-opt-' + i);
}
function runCommand(i) {
  const cmd = _cmdkItems[i];
  if (!cmd) return;
  try {
    let recents = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    recents = [cmd.id].concat(recents.filter(id => id !== cmd.id)).slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recents));
  } catch (e) { /* ignore */ }
  closePalette();
  cmd.run();
}

/* ---------------- router ---------------- */
const ROUTES = {
  home:          { title: 'Today',         icon: 'home' },
  conversations: { title: 'Conversations', icon: 'message-circle' },
  leads:         { title: 'Leads',         icon: 'target' },
  customers:     { title: 'Customers',     icon: 'users' },
  bookings:      { title: 'Bookings',      icon: 'calendar' },
  train:         { title: 'Train Aria',    icon: 'sparkles' },
  channels:      { title: 'Channels',      icon: 'link' },
  business:      { title: 'Business',      icon: 'building' },
  settings:      { title: 'Settings',      icon: 'settings' },
};

function parseHash() {
  const m = location.hash.match(/^#\/([a-z]+)/);
  let name = m ? m[1] : null;
  if (name === 'profile') name = 'business'; // old name migration
  return ROUTES[name] ? name : null;
}
function navigate(name) {
  if (parseHash() === name) { renderRoute(); return; }
  location.hash = '#/' + name;
}
function currentRoute() { return parseHash() || 'home'; }

function renderRoute() {
  const name = currentRoute();
  // active states — sidebar + tabbar
  $$('[data-nav]').forEach(n => {
    const on = n.dataset.nav === name;
    n.classList.toggle('active', on);
    if (n.closest('.nav-list')) n.setAttribute('aria-current', on ? 'page' : 'false');
  });
  closeSidebar(); closeSheet(); closeDrawer();
  const route = ROUTES[name];
  document.title = route.title + ' — Aria';
  const view = $('#view');
  view.innerHTML = '';
  const root = el('<section class="panel" aria-labelledby="panel-heading"></section>');
  view.appendChild(root);
  if (typeof Panels !== 'undefined' && Panels[name]) {
    Panels[name].render(root);
  } else {
    root.innerHTML = errorStateHTML('Panel "' + name + '" is not registered.');
  }
  // every route loads — fixes the old "channels skeleton forever" bug (manifest §6.2)
  if (name !== 'home') loadEscalations(false);
}

/* ---------------- escalations banner (global) ---------------- */
async function loadEscalations(renderBanner) {
  let items = [];
  try {
    const d = await api('/api/dashboard/escalations');
    items = (d && d.items) || [];
  } catch (e) { console.warn('[aria] escalations unavailable:', e.message); return; }
  // nav badge on Conversations
  $$('[data-nav="conversations"] .nav-badge').forEach(b => b.remove());
  if (items.length) {
    const navItem = $('.sidebar [data-nav="conversations"]');
    if (navItem) navItem.appendChild(el('<span class="nav-badge" aria-label="' + items.length + ' need attention">' + items.length + '</span>'));
  }
  window._escalations = items;
  if (renderBanner === false) return;
  const slot = $('#banner-slot');
  if (!slot) return;
  if (!items.length) { slot.innerHTML = ''; return; }
  let rows = items.slice(0, 5).map((it, i) => {
    const m = chMeta(it.channel);
    return '<div class="banner-row"><span class="br-main">' + esc(m.label) + ' · ' + esc(it.senderId) +
      (it.reason ? ' — ' + esc(it.reason) : '') + '</span>' +
      '<span class="pill amber">' + timeAgo(it.escalatedAt) + '</span>' +
      '<button class="btn btn-sm" data-resume="' + esc(it.memKey) + '">Resume Aria</button></div>';
  }).join('');
  slot.innerHTML = '<div class="banner" role="region" aria-label="Conversations needing attention">' +
    '<div class="banner-head">' + icon('handshake', 16) + ' ' + items.length +
    ' conversation' + (items.length > 1 ? 's' : '') + ' handed to you</div>' + rows + '</div>';
  $$('[data-resume]', slot).forEach(btn => {
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Resume Aria?', body: 'Aria will take over this conversation again.', confirmLabel: 'Resume' });
      if (!ok) return;
      try {
        await apiPost('/api/dashboard/resume-conversation', { memKey: btn.dataset.resume });
        toast('Aria resumed on this conversation');
        loadEscalations(true);
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}

/* expose resume for panels.js (thread drawer) */
async function resumeConversation(memKey) {
  await apiPost('/api/dashboard/resume-conversation', { memKey: memKey });
  toast('Aria resumed on this conversation');
  loadEscalations(true);
}

/* ---------------- logout ---------------- */
async function logout() {
  try { await apiPost('/api/dashboard/logout', {}); } catch (e) { /* endpoint lands in Part 2 — degrade silently */ }
  location.href = '/dashboard?owner=' + encodeURIComponent(OWNER);
}

/* ---------------- coach-marks tutorial (4 steps, skippable) ---------------- */
const TUT_KEY = '_aria_tutorial_done';
let _tutStep = 0;
let _tutActive = false;

const TUT_STEPS = [
  { target: () => $('.sidebar'), title: 'Everything in one place', text: 'Conversations, leads, bookings and training all live in this menu. Aria handles the messages — you watch the results.' },
  { target: () => $('#hero-status') || $('#view'), title: 'Aria’s live status', text: 'The green dot means Aria is answering customers right now. Replies, leads and bookings update here in real time.' },
  { target: () => $('#cmdk-btn'), title: 'Jump anywhere', text: 'Press ⌘K (or Ctrl+K) to search every page and action — like exporting your leads as a CSV.' },
  { target: () => $('[data-nav="train"]'), title: 'Make Aria smarter', text: 'Add knowledge, test answers in the sandbox, and teach Aria the questions she couldn’t answer yet.' },
];

function startTutorial(force) {
  if (!force && localStorage.getItem(TUT_KEY)) return;
  if (currentRoute() !== 'home') navigate('home');
  _tutStep = 0;
  _tutActive = true;
  setTimeout(renderTutStep, 350); // let home paint
}
function endTutorial() {
  _tutActive = false;
  localStorage.setItem(TUT_KEY, '1');
  const ring = $('#coach-ring'), card = $('#coach-card');
  if (ring) ring.remove();
  if (card) card.remove();
}
function renderTutStep() {
  if (!_tutActive) return;
  const step = TUT_STEPS[_tutStep];
  const target = step.target();
  let ring = $('#coach-ring'), card = $('#coach-card');
  if (!ring) { ring = el('<div id="coach-ring" class="coach-ring"></div>'); document.body.appendChild(ring); }
  if (!card) { card = el('<div id="coach-card" class="coach-card" role="dialog" aria-modal="false" aria-label="Tour"></div>'); document.body.appendChild(card); }

  let r = { top: innerHeight / 2 - 40, left: innerWidth / 2 - 120, width: 240, height: 80 };
  if (target && target.getClientRects().length) { // (offsetParent is null for fixed-position targets like the sidebar)
    const b = target.getBoundingClientRect();
    r = { top: b.top - 6, left: b.left - 6, width: b.width + 12, height: b.height + 12 };
  }
  ring.style.top = r.top + 'px'; ring.style.left = r.left + 'px';
  ring.style.width = r.width + 'px'; ring.style.height = r.height + 'px';

  const dots = TUT_STEPS.map((_, i) => '<i class="' + (i <= _tutStep ? 'on' : '') + '"></i>').join('');
  card.innerHTML = '<h2>' + esc(step.title) + '</h2><p>' + esc(step.text) + '</p>' +
    '<div class="coach-foot"><span class="coach-dots">' + dots + '</span>' +
    '<button class="btn btn-ghost btn-sm" data-tut="skip">Skip</button>' +
    (_tutStep > 0 ? '<button class="btn btn-sm" data-tut="back">Back</button>' : '') +
    '<button class="btn btn-primary btn-sm" data-tut="next">' + (_tutStep === TUT_STEPS.length - 1 ? 'Done' : 'Next') + '</button></div>';

  // place card below target (or above if no room)
  const ch = 170;
  let top = r.top + r.height + 12;
  if (top + ch > innerHeight) top = Math.max(12, r.top - ch - 12);
  let left = Math.min(Math.max(12, r.left), innerWidth - 312);
  card.style.top = top + 'px'; card.style.left = left + 'px';

  $('[data-tut="skip"]', card).addEventListener('click', endTutorial);
  const back = $('[data-tut="back"]', card);
  if (back) back.addEventListener('click', () => { _tutStep--; renderTutStep(); });
  $('[data-tut="next"]', card).addEventListener('click', () => {
    if (_tutStep === TUT_STEPS.length - 1) { endTutorial(); return; }
    _tutStep++;
    renderTutStep();
  });
  $('[data-tut="next"]', card).focus();
}

/* ---------------- mobile nav ---------------- */
function openSidebar() {
  $('.sidebar').classList.add('open');
  $('#sidebar-backdrop').classList.add('open');
  $('#hamburger-btn').setAttribute('aria-expanded', 'true');
}
function closeSidebar() {
  $('.sidebar').classList.remove('open');
  $('#sidebar-backdrop').classList.remove('open');
  const hb = $('#hamburger-btn');
  if (hb) hb.setAttribute('aria-expanded', 'false');
}
function openSheet() { $('#more-sheet').classList.add('open'); }
function closeSheet() { const s = $('#more-sheet'); if (s) s.classList.remove('open'); }

/* ---------------- global keyboard ---------------- */
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    paletteIsOpen() ? closePalette() : openPalette();
    return;
  }
  if (e.key === 'Escape') {
    if (_tutActive) { endTutorial(); return; }
    if (paletteIsOpen()) { closePalette(); return; }
    const modal = $('#modal');
    if (modal.classList.contains('open')) { (modal._onEscape || closeModal)(); return; }
    if ($('#drawer').classList.contains('open')) { closeDrawer(); return; }
    closeSheet(); closeSidebar();
    return;
  }
  if (paletteIsOpen()) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setPaletteSel(Math.min(_cmdkSel + 1, _cmdkItems.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setPaletteSel(Math.max(_cmdkSel - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); runCommand(_cmdkSel); }
    return;
  }
  if (e.key === 'Tab' && $('#drawer').classList.contains('open')) trapFocus($('#drawer'), e);
});

/* ---------------- boot ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  if (!OWNER || !TOKEN) return; // redirecting

  // chrome icons
  $('#cmdk-btn').innerHTML = icon('command', 14) + '<span>K</span>';
  $('#help-btn').innerHTML = icon('help', 16);
  $('#logout-btn').innerHTML = icon('logout', 14) + ' Logout';
  $('#hamburger-btn').innerHTML = icon('menu', 18);
  $('#drawer-close').innerHTML = icon('x', 16);
  $('#email-chip').innerHTML = icon('user', 13) + '<span>' + esc(OWNER) + '</span>';
  $('#cmdk-search-ic').innerHTML = icon('search', 16);

  // sidebar + tabbar nav icons
  $$('[data-nav]').forEach(n => {
    const r = ROUTES[n.dataset.nav];
    if (r) n.insertAdjacentHTML('afterbegin', icon(r.icon, n.closest('.tabbar') ? 18 : 16));
  });
  const moreBtn = $('#tab-more');
  if (moreBtn) moreBtn.insertAdjacentHTML('afterbegin', icon('more', 18));

  // wiring
  $('#cmdk-btn').addEventListener('click', openPalette);
  $('#help-btn').addEventListener('click', () => startTutorial(true));
  $('#logout-btn').addEventListener('click', logout);
  $('#hamburger-btn').addEventListener('click', openSidebar);
  $('#sidebar-backdrop').addEventListener('click', closeSidebar);
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-overlay').addEventListener('click', closeDrawer);
  $('#cmdk-overlay').addEventListener('click', closePalette);
  $('#cmdk-input').addEventListener('input', e => renderPalette(e.target.value));
  if (moreBtn) moreBtn.addEventListener('click', openSheet);
  $$('[data-nav]').forEach(n => n.addEventListener('click', () => navigate(n.dataset.nav)));

  // initial route: hash > old localStorage key (one-time migration) > home
  if (!parseHash()) {
    let legacy = null;
    try { legacy = localStorage.getItem('aria_panel'); localStorage.removeItem('aria_panel'); } catch (e) { /* ignore */ }
    if (legacy === 'profile') legacy = 'business';
    const start = ROUTES[legacy] ? legacy : 'home';
    history.replaceState(null, '', location.pathname + location.search + '#/' + start);
  }
  window.addEventListener('hashchange', renderRoute);
  renderRoute();
  loadEscalations(true);
  startTutorial(false);
});
