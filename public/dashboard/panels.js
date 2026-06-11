/* ============================================================
   Aria Dashboard — panels (panels.js)
   All 9 panels. Every fetch: skeleton -> content | empty | error+retry.
   SECURITY: every dynamic value is escaped with esc() before it
   touches innerHTML. Never interpolate raw API data.
   ============================================================ */
'use strict';

/* ============ shared render helpers ============ */

function panelHeader(name, sub, actionsHtml) {
  const r = ROUTES[name];
  return '<header class="panel-header">' +
    '<div class="ph-text"><h1 id="panel-heading">' + esc(r.title) + '</h1>' +
    (sub ? '<p>' + esc(sub) + '</p>' : '') + '</div>' +
    '<div class="panel-actions">' + (actionsHtml || '') + '</div></header>';
}
function refreshBtn() {
  return '<button class="btn btn-ghost" data-refresh aria-label="Refresh panel">' + icon('refresh', 15) + ' Refresh</button>';
}
function wireRefresh(root, name) {
  const b = root.querySelector('[data-refresh]');
  if (b) b.addEventListener('click', () => Panels[name].render(root.closest('.panel') || root));
}

/* ---- zero-dependency inline SVG charts ---- */
function svgSparkline(vals, opts) {
  opts = opts || {};
  const w = opts.w || 220, h = opts.h || 44, pad = 3;
  const series = vals.map(v => (v == null ? null : Number(v) || 0));
  const nums = series.filter(v => v != null);
  if (!nums.length) return '';
  const max = Math.max(...nums, 1), min = Math.min(...nums, 0);
  const x = i => pad + (i * (w - pad * 2)) / Math.max(series.length - 1, 1);
  const y = v => h - pad - ((v - min) * (h - pad * 2)) / Math.max(max - min, 1);
  // null-gap aware: split into segments
  let segs = [], cur = [];
  series.forEach((v, i) => {
    if (v == null) { if (cur.length) segs.push(cur); cur = []; }
    else cur.push(x(i).toFixed(1) + ',' + y(v).toFixed(1));
  });
  if (cur.length) segs.push(cur);
  const stroke = opts.stroke || 'var(--accent)';
  const lines = segs.map(s =>
    s.length === 1
      ? '<circle cx="' + s[0].split(',')[0] + '" cy="' + s[0].split(',')[1] + '" r="1.5" fill="' + stroke + '"/>'
      : '<polyline points="' + s.join(' ') + '" fill="none" stroke="' + stroke + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
  ).join('');
  let area = '';
  if (opts.fill !== false && segs.length === 1 && segs[0].length > 1) {
    area = '<polygon points="' + pad + ',' + (h - pad) + ' ' + segs[0].join(' ') + ' ' + x(series.length - 1).toFixed(1) + ',' + (h - pad) +
      '" fill="' + stroke + '" opacity="0.08"/>';
  }
  return '<span class="spark-wrap"><svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' +
    esc(opts.label || 'trend') + '">' + area + lines + '</svg></span>';
}

function svgDonut(parts, opts) {
  // parts: [{value, color, label}]
  opts = opts || {};
  const size = opts.size || 96, r = 38, c = 2 * Math.PI * r;
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return '';
  let off = 0, segs = '';
  parts.forEach(p => {
    const frac = p.value / total;
    segs += '<circle cx="48" cy="48" r="' + r + '" fill="none" stroke="' + p.color + '" stroke-width="10" ' +
      'stroke-dasharray="' + (frac * c).toFixed(2) + ' ' + (c - frac * c).toFixed(2) + '" ' +
      'stroke-dashoffset="' + (-off * c).toFixed(2) + '" transform="rotate(-90 48 48)"/>';
    off += frac;
  });
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 96 96" role="img" aria-label="' + esc(opts.label || 'breakdown') + '">' +
    segs + '<text x="48" y="52" text-anchor="middle" fill="var(--text)" font-size="18" font-weight="650">' + total + '</text></svg>';
}

function hBars(items, color) {
  const max = Math.max(...items.map(i => i.count), 1);
  return items.map(it =>
    '<div class="hbar-row"><span class="hb-label" title="' + esc(it.name) + '">' + esc(it.name) + '</span>' +
    '<span class="hb-track"><span class="hb-fill" style="width:' + Math.round((it.count / max) * 100) + '%;background:' + (color || 'var(--blue)') + '"></span></span>' +
    '<span class="hb-v">' + fmtNum(it.count) + '</span></div>'
  ).join('');
}

function scoreBand(lead) {
  const s = lead.score;
  if (typeof s === 'number') return s >= 70 ? 'hot' : s >= 40 ? 'warm' : 'cold';
  const t = String(s || lead.tag || '').toLowerCase();
  if (t.includes('hot')) return 'hot';
  if (t.includes('warm')) return 'warm';
  return 'cold';
}

/* ============================================================
   PANELS
   ============================================================ */
const Panels = {};

/* ---------------- 1. TODAY (home) ---------------- */
Panels.home = {
  render(root) {
    const h = new Date().getHours();
    const greet = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    const dateStr = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    root.innerHTML =
      panelHeader('home', greet + ' — ' + dateStr, refreshBtn()) +
      '<div id="banner-slot"></div>' +
      '<div id="value-header" class="value-header"></div>' +
      '<div id="hero-status" class="hero" style="margin-bottom:var(--sp-5)"></div>' +
      '<div id="channel-strip" class="chip-strip" style="margin-bottom:var(--sp-5)" role="group" aria-label="Channels"></div>' +
      '<div id="stats-row" class="stats-row" style="margin-bottom:var(--sp-5)"></div>' +
      '<div class="card-grid">' +
        '<div class="card" id="analytics-section"><div class="card-title">' + icon('trending-up', 16) + '<h2>This week</h2><span class="ct-sub" id="wow-pill"></span></div><div id="analytics-body"></div></div>' +
        '<div class="card"><div class="card-title">' + icon('zap', 16) + '<h2>Recent activity</h2></div><div id="activity-body"></div></div>' +
      '</div>';
    wireRefresh(root, 'home');
    loadEscalations(true);
    this.loadHero();
    this.loadActivity();
    this.loadAnalytics();
  },

  async loadHero() {
    const hero = $('#hero-status'), strip = $('#channel-strip'), stats = $('#stats-row'), vh = $('#value-header');
    hero.innerHTML = skeletonHTML(2);
    strip.innerHTML = '';
    stats.innerHTML = skeletonHTML(1);
    let d, cs;
    try {
      [d, cs] = await Promise.all([api('/api/dashboard/stats'), api('/api/dashboard/channel-stats')]);
    } catch (e) {
      hero.innerHTML = errorStateHTML(e.message);
      const r = hero.querySelector('[data-retry]');
      if (r) r.addEventListener('click', () => this.loadHero());
      stats.innerHTML = '';
      return;
    }
    const channels = (cs && cs.channels) || {};
    const chStats = (cs && cs.stats) || {};
    const anyChannelOn = ['facebook', 'instagram', 'whatsapp'].some(k => channels[k] && channels[k].enabled !== false);
    const live = !!(d.autoReplyEnabled || anyChannelOn);
    const totalReplies = (chStats.total || 0) + ((d.emailsReplied && d.emailsReplied.total) || 0);
    const lastReplyTs = ['facebook', 'instagram', 'whatsapp'].map(k => chStats[k] && chStats[k].lastReply).filter(Boolean).sort().pop();
    const connectedAny = anyChannelOn || d.gmailConnected || Object.keys(channels).length > 0;
    const sub = lastReplyTs ? 'Last reply ' + timeAgo(lastReplyTs)
      : connectedAny ? 'Waiting for the first message…'
      : 'No channels connected yet — connect one to go live.';
    const csat = d.csat && d.csat.scorePct != null ? d.csat.scorePct : null;
    const csatClass = csat == null ? '' : csat >= 80 ? 'accent' : csat >= 50 ? 'amber' : 'red';

    hero.innerHTML =
      '<span class="hero-dot' + (live ? '' : ' off') + '" aria-hidden="true"></span>' +
      '<div class="hero-text"><strong>' + (live ? 'Aria is working for you' : 'Aria is paused') + '</strong>' +
      '<span>' + esc(sub) + '</span></div>' +
      '<div class="hero-metrics">' +
        '<div class="hero-metric"><div class="hm-v">' + fmtNum(totalReplies) + '</div><div class="hm-l">Replies</div></div>' +
        '<div class="hero-metric"><div class="hm-v">' + fmtNum(d.leads && d.leads.total) + '</div><div class="hm-l">Leads</div></div>' +
        '<div class="hero-metric"><div class="hm-v">' + fmtNum(d.bookings && d.bookings.total) + '</div><div class="hm-l">Bookings</div></div>' +
        (csat != null
          ? '<button class="hero-metric clickable" id="csat-metric" aria-label="CSAT ' + csat + ' percent — view detail"><div class="hm-v stat-value ' + csatClass + '" style="font-size:18px">' + csat + '%</div><div class="hm-l">CSAT</div></button>'
          : '') +
      '</div>';
    const csatBtn = $('#csat-metric');
    if (csatBtn) csatBtn.addEventListener('click', showCsatDetail);

    // value header — "This week: …"
    const weekReplies = ((d.emailsReplied && d.emailsReplied.week) || 0) +
      ['facebook', 'instagram', 'whatsapp'].reduce((a, k) => a + ((chStats[k] && chStats[k].week) || 0), 0);
    const weekBookings = (d.bookings && d.bookings.week) || 0;
    vh.innerHTML = '<div class="vh-text"><strong>This week: ' + fmtNum(weekReplies) + ' replies · ' +
      fmtNum(weekBookings) + ' booking' + (weekBookings === 1 ? '' : 's') + '</strong>' +
      '<span>' + fmtNum(d.leads && d.leads.hot) + ' hot + ' + fmtNum(d.leads && d.leads.warm) + ' warm leads in the last 30 days</span></div>' +
      '<span class="vh-spark" id="vh-spark"></span>';

    // channel chips
    const chipDefs = [
      { key: 'facebook' }, { key: 'instagram' }, { key: 'whatsapp' },
      { key: 'email', connected: !!d.gmailConnected, enabled: !!d.autoReplyEnabled },
    ];
    strip.innerHTML = chipDefs.map(def => {
      const m = chMeta(def.key);
      const cfg = channels[def.key];
      const connected = def.key === 'email' ? def.connected : !!cfg;
      const enabled = def.key === 'email' ? def.enabled : (cfg && cfg.enabled !== false);
      const cls = !connected ? 'disconnected' : enabled ? '' : 'off';
      const stateTxt = !connected ? 'not connected' : enabled ? 'live' : 'paused';
      return '<button class="chip ' + cls + '" data-chip="' + m.key + '" data-connected="' + connected + '" data-enabled="' + enabled + '"' +
        ' aria-label="' + esc(m.label) + ' — ' + stateTxt + (connected ? '. Click to ' + (enabled ? 'pause' : 'resume') : '. Click to connect') + '">' +
        '<span class="chip-state" aria-hidden="true"></span>' + icon(m.icon, 14) + ' ' + esc(m.label) + '</button>';
    }).join('');
    $$('[data-chip]', strip).forEach(chipBtn => {
      chipBtn.addEventListener('click', async () => {
        const key = chipBtn.dataset.chip;
        const connected = chipBtn.dataset.connected === 'true';
        const enabled = chipBtn.dataset.enabled === 'true';
        if (!connected) { navigate('channels'); return; } // old bug: chip used to open a hidden section
        try {
          if (key === 'email') await apiPost('/api/dashboard/settings', { autoReplyEnabled: !enabled });
          else await apiPost('/api/dashboard/channel-toggle', { channel: key, enabled: !enabled });
          toast(chMeta(key).label + (enabled ? ' paused' : ' resumed'));
          this.loadHero();
        } catch (e) { toast(e.message, 'error'); }
      });
    });

    // stat cards
    stats.innerHTML =
      '<div class="stat-card"><div class="stat-label">' + icon('zap', 13) + ' Hot leads</div><div class="stat-value red">' + fmtNum(d.leads && d.leads.hot) + '</div><div class="stat-hint">last 30 days</div></div>' +
      '<div class="stat-card"><div class="stat-label">' + icon('target', 13) + ' Warm leads</div><div class="stat-value amber">' + fmtNum(d.leads && d.leads.warm) + '</div><div class="stat-hint">last 30 days</div></div>' +
      '<div class="stat-card"><div class="stat-label">' + icon('calendar', 13) + ' Bookings</div><div class="stat-value accent">' + fmtNum(weekBookings) + '</div><div class="stat-hint">this week</div></div>' +
      '<div class="stat-card"><div class="stat-label">' + icon('mail', 13) + ' Emails replied</div><div class="stat-value">' + fmtNum(d.emailsReplied && d.emailsReplied.week) + '</div><div class="stat-hint">this week</div></div>';
  },

  loadActivity() {
    const body = $('#activity-body');
    loadInto(body, () => api('/api/dashboard/activity?limit=12'), (d, c) => {
      const events = (d && d.events) || [];
      if (!events.length) return false;
      const typeIc = { lead: 'target', booking: 'calendar', handoff: 'handshake', csat: 'star' };
      c.innerHTML = events.map(ev => {
        const m = chMeta(ev.channel);
        return '<div class="list-row">' + chIcon(ev.channel) +
          '<div class="lr-main"><div class="lr-title">' + icon(typeIc[ev.type] || 'zap', 12) + ' ' + esc(ev.label) + '</div>' +
          '<div class="lr-sub">' + esc(ev.detail || '') + '</div></div>' +
          '<span class="pill">' + esc(m.label) + '</span>' +
          '<span class="lr-sub" style="flex-shrink:0">' + timeAgo(ev.ts) + '</span></div>';
      }).join('');
    }, { emptyIcon: 'zap', emptyTitle: 'No activity yet', emptySub: 'Leads, bookings and ratings will appear here.' });
  },

  loadAnalytics() {
    // KNOWN: the owner-auth analytics route is currently shadowed server-side
    // (contract §2) — this card MUST degrade gracefully, never hard-fail.
    const body = $('#analytics-body');
    body.innerHTML = skeletonHTML(4);
    api('/api/dashboard/analytics').then(a => {
      if (!a || (!a.volumeByChannel && !a.leadsBreakdown)) throw new ApiError(404, 'empty analytics');
      const vols = a.volumeByChannel || {};
      const combined = [];
      const chans = ['facebook', 'instagram', 'whatsapp', 'email'];
      const len = Math.max(...chans.map(k => (vols[k] || []).length), 0);
      for (let i = 0; i < len; i++) combined.push(chans.reduce((s, k) => s + ((vols[k] || [])[i] || 0), 0));
      const wow = a.weekOverWeek && typeof a.weekOverWeek.convs === 'number' ? a.weekOverWeek.convs : null;
      if (wow != null) {
        $('#wow-pill').innerHTML = '<span class="pill ' + (wow > 0 ? 'accent' : wow < 0 ? 'red' : '') + '">' +
          icon(wow >= 0 ? 'trending-up' : 'trending-down', 11) + ' ' + (wow > 0 ? '+' : '') + wow + '% wk/wk</span>';
      }
      const lb = a.leadsBreakdown || {};
      const donut = svgDonut([
        { value: lb.hot || 0, color: 'var(--red)', label: 'hot' },
        { value: lb.warm || 0, color: 'var(--amber)', label: 'warm' },
        { value: lb.cold || 0, color: 'var(--text-3)', label: 'cold' },
      ], { label: 'Leads breakdown' });
      let html = '';
      if (combined.length) {
        html += '<div><div class="lr-sub" style="margin-bottom:4px">Conversations — daily</div>' +
          svgSparkline(combined, { w: 420, h: 56, label: 'Daily conversations' }) +
          '<div class="legend">' + chans.map(k => '<span><i style="background:' + chMeta(k).cssVar + '"></i>' + esc(chMeta(k).label) + ' ' + fmtNum((vols[k] || []).reduce((s, v) => s + (v || 0), 0)) + '</span>').join('') + '</div></div>';
      }
      if (donut) {
        html += '<div style="display:flex;gap:var(--sp-5);align-items:center;margin-top:var(--sp-4)">' + donut +
          '<div class="legend" style="flex-direction:column;display:flex;gap:6px">' +
          '<span><i style="background:var(--red)"></i>Hot ' + fmtNum(lb.hot) + '</span>' +
          '<span><i style="background:var(--amber)"></i>Warm ' + fmtNum(lb.warm) + '</span>' +
          '<span><i style="background:var(--text-3)"></i>Cold ' + fmtNum(lb.cold) + '</span></div></div>';
      }
      if (Array.isArray(a.csatTrend) && a.csatTrend.some(v => v != null)) {
        html += '<div style="margin-top:var(--sp-4)"><div class="lr-sub" style="margin-bottom:4px">CSAT trend</div>' +
          svgSparkline(a.csatTrend, { w: 420, h: 40, stroke: 'var(--violet)', fill: false, label: 'CSAT trend' }) + '</div>';
      }
      if (Array.isArray(a.topCategories) && a.topCategories.length) {
        html += '<div style="margin-top:var(--sp-4)"><div class="lr-sub" style="margin-bottom:6px">Top topics</div>' + hBars(a.topCategories.slice(0, 5)) + '</div>';
      }
      body.innerHTML = html || emptyStateHTML('trending-up', 'Not enough data yet', 'Charts appear after a few days of conversations.');
      const sparkSlot = $('#vh-spark');
      if (sparkSlot && combined.length) sparkSlot.innerHTML = svgSparkline(combined, { w: 180, h: 36, label: 'Conversations trend' });
    }).catch(err => {
      // graceful degrade — hide the whole card, log (fixes "This week — Failed to load")
      console.warn('[aria] analytics unavailable, hiding card:', err.message);
      const sec = $('#analytics-section');
      if (sec) sec.remove();
    });
  },
};

/* CSAT detail drawer */
async function showCsatDetail() {
  const body = openDrawer('Negative ratings');
  try {
    const d = await api('/api/dashboard/csat-detail');
    const items = (d && d.items) || [];
    if (!items.length) {
      body.innerHTML = emptyStateHTML('thumbs-up', 'No negative ratings', 'Nothing to review — nice.');
      return;
    }
    body.innerHTML = items.map(it =>
      '<div class="gap-card"><div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">' + chIcon(it.channel) +
      '<strong>' + esc(it.senderName || it.senderId || 'Customer') + '</strong>' +
      '<span class="pill red">' + icon('thumbs-down', 11) + ' negative</span>' +
      '<span class="lr-sub" style="margin-left:auto">' + timeAgo(it.ts) + '</span></div>' +
      (it.raw ? '<p class="lr-sub" style="margin-bottom:6px">“' + esc(it.raw) + '”</p>' : '') +
      ((it.history || []).map(hh =>
        '<div class="bubble ' + (hh.role === 'us' ? 'us' : 'them') + '" style="font-size:var(--fs-small)">' + esc(hh.preview || hh.message || '') + '</div>'
      ).join('')) + '</div>'
    ).join('');
  } catch (e) {
    body.innerHTML = errorStateHTML(e.message);
    const r = body.querySelector('[data-retry]');
    if (r) r.addEventListener('click', showCsatDetail);
  }
}

/* ---------------- 2. CONVERSATIONS ---------------- */
Panels.conversations = {
  filter: 'all',
  render(root) {
    root.innerHTML =
      panelHeader('conversations', 'Every message Aria has handled, across all channels.', refreshBtn()) +
      '<div class="chip-strip" style="margin-bottom:var(--sp-4)" role="group" aria-label="Filter by channel" id="conv-filters"></div>' +
      '<div class="card" style="padding:var(--sp-2) var(--sp-4)"><div id="conv-body"></div></div>';
    wireRefresh(root, 'conversations');
    const filters = ['all', 'whatsapp', 'facebook', 'instagram', 'email', 'web'];
    $('#conv-filters').innerHTML = filters.map(f => {
      const label = f === 'all' ? 'All' : chMeta(f).label;
      return '<button class="chip' + (f === this.filter ? ' selected' : '') + '" data-filter="' + f + '" aria-pressed="' + (f === this.filter) + '">' +
        (f === 'all' ? icon('list', 13) : icon(chMeta(f).icon, 13)) + ' ' + esc(label) + '</button>';
    }).join('');
    $$('#conv-filters [data-filter]').forEach(b => b.addEventListener('click', () => {
      this.filter = b.dataset.filter;
      this.render(root);
    }));
    this.load();
  },

  load() {
    const body = $('#conv-body');
    const filter = this.filter;
    const fetcher = async () => {
      const wantSocial = filter !== 'email';
      const wantEmail = filter === 'all' || filter === 'email';
      const socialChannel = ['whatsapp', 'facebook', 'instagram', 'web'].includes(filter) ? filter : 'all';
      const [social, inbox] = await Promise.all([
        wantSocial ? api('/api/dashboard/messages?channel=' + socialChannel + '&page=1').catch(e => { console.warn('[aria] messages:', e.message); return { items: [] }; }) : { items: [] },
        wantEmail ? api('/api/dashboard/inbox-log?page=1').catch(e => { console.warn('[aria] inbox-log:', e.message); return { items: [] }; }) : { items: [] },
      ]);
      let rows = (social.items || []).map(it => ({
        kind: 'social', channel: it.channel, who: it.senderName || it.senderId,
        msg: it.message, reply: it.reply, ts: it.timestamp, senderId: it.senderId, status: it.status,
      })).concat((inbox.items || []).map(it => ({
        kind: 'email', channel: 'email', who: it.senderEmail,
        msg: it.subject, reply: it.replyPreview, ts: it.sentAt,
      })));
      if (filter === 'web') rows = rows.filter(r => String(r.channel).toLowerCase() === 'web');
      rows.sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0));
      return rows.slice(0, 50);
    };
    loadInto(body, fetcher, (rows, c) => {
      if (!rows.length) return false;
      const escal = new Set((window._escalations || []).map(x => x.memKey));
      c.innerHTML = rows.map((r, i) => {
        const memKey = r.kind === 'social' ? OWNER + '::' + r.channel + '::' + r.senderId : null;
        const handed = memKey && escal.has(memKey);
        return '<div class="list-row' + (r.kind === 'social' ? ' clickable" role="button" tabindex="0"' : '"') + ' data-row="' + i + '">' +
          chIcon(r.channel) +
          '<div class="lr-main"><div class="lr-title">' + esc(r.who || 'Unknown') +
          (handed ? ' <span class="pill amber">' + icon('handshake', 10) + ' handed off</span>' : '') +
          (r.status && r.status !== 'sent' ? ' <span class="pill">' + esc(r.status) + '</span>' : '') + '</div>' +
          '<div class="lr-sub">' + esc(String(r.msg || '').slice(0, 100)) + '</div>' +
          (r.reply ? '<div class="lr-sub" style="color:var(--accent)">Aria: ' + esc(String(r.reply).slice(0, 100)) + '</div>' : '') +
          '</div><span class="lr-sub" style="flex-shrink:0">' + timeAgo(r.ts) + '</span></div>';
      }).join('');
      $$('.list-row.clickable', c).forEach(node => {
        const r = rows[Number(node.dataset.row)];
        const open = () => showThread(OWNER + '::' + r.channel + '::' + r.senderId);
        node.addEventListener('click', open);
        node.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      });
    }, {
      emptyIcon: 'message-circle', emptyTitle: 'No conversations yet',
      emptySub: filter === 'all' ? 'Messages from connected channels appear here.' : 'No ' + (filter === 'all' ? '' : chMeta(filter).label) + ' messages yet.',
      emptyCta: 'Connect a channel', emptyCtaAttr: 'onclick="navigate(\'channels\')"',
    });
  },
};

/* thread slide-over drawer */
async function showThread(memKey) {
  const body = openDrawer('Conversation');
  try {
    const d = await api('/api/dashboard/conversation/' + encodeURIComponent(memKey));
    setDrawerTitle(chMeta(d.channel).label + ' · ' + (d.senderId || ''));
    let html = '';
    if (d.state && d.state.paused) {
      html += '<div class="banner" style="margin-bottom:var(--sp-4)"><div class="banner-head">' + icon('pause', 14) +
        ' Aria is paused here' + (d.state.reason ? ' — ' + esc(d.state.reason) : '') + '</div>' +
        '<button class="btn btn-primary btn-sm" id="thread-resume">Resume Aria on this conversation</button></div>';
    }
    html += (d.history || []).map(turn => {
      if (turn.role === 'summary') return '<div class="bubble summary">Earlier summary: ' + esc(turn.preview) + '</div>';
      const us = turn.role === 'us';
      return '<div class="bubble ' + (us ? 'us' : 'them') + '">' + esc(turn.preview) + '</div>' +
        (turn.date ? '<div class="bubble-meta' + (us ? ' us' : '') + '">' + timeAgo(turn.date) + '</div>' : '');
    }).join('') || emptyStateHTML('message-circle', 'No messages', 'This thread is empty.');
    body.innerHTML = html;
    const rbtn = $('#thread-resume');
    if (rbtn) rbtn.addEventListener('click', async () => {
      try { await resumeConversation(memKey); showThread(memKey); } catch (e) { toast(e.message, 'error'); }
    });
  } catch (e) {
    body.innerHTML = errorStateHTML(e.message);
    const r = body.querySelector('[data-retry]');
    if (r) r.addEventListener('click', () => showThread(memKey));
  }
}

/* ---------------- 3. LEADS ---------------- */
Panels.leads = {
  q: '', band: 'all', _rows: [],
  render(root) {
    root.innerHTML =
      panelHeader('leads', 'People Aria has qualified for you.',
        '<button class="btn" id="leads-export">' + icon('download', 14) + ' Export CSV</button>' + refreshBtn()) +
      '<div class="form-row" style="margin-bottom:var(--sp-4);max-width:520px">' +
        '<input class="input" id="leads-search" type="search" placeholder="Search name, email, phone…" aria-label="Search leads">' +
        '<select class="select" id="leads-band" aria-label="Filter by score" style="max-width:140px">' +
          '<option value="all">All scores</option><option value="hot">Hot</option><option value="warm">Warm</option><option value="cold">Cold</option></select>' +
      '</div>' +
      '<div class="card" style="padding:var(--sp-2) var(--sp-4)"><div id="leads-body"></div></div>';
    wireRefresh(root, 'leads');
    $('#leads-export').addEventListener('click', () => window.exportLeadsCSV());
    $('#leads-search').addEventListener('input', e => { this.q = e.target.value.toLowerCase(); this.paint(); });
    $('#leads-band').addEventListener('change', e => { this.band = e.target.value; this.paint(); });
    this.load();
  },
  load() {
    const body = $('#leads-body');
    body.innerHTML = skeletonHTML(5);
    api('/api/dashboard/leads').then(d => {
      this._rows = (d && d.leads) || [];
      this.paint();
    }).catch(e => {
      body.innerHTML = errorStateHTML(e.message);
      const r = body.querySelector('[data-retry]');
      if (r) r.addEventListener('click', () => this.load());
    });
  },
  paint() {
    const body = $('#leads-body');
    if (!body) return;
    let rows = this._rows;
    if (this.q) rows = rows.filter(l => [l.name, l.email, l.phone].some(v => String(v || '').toLowerCase().includes(this.q)));
    if (this.band !== 'all') rows = rows.filter(l => scoreBand(l) === this.band);
    if (!rows.length) {
      body.innerHTML = this._rows.length
        ? emptyStateHTML('search', 'No matching leads', 'Try a different search or filter.')
        : emptyStateHTML('target', 'No leads yet', 'When Aria qualifies a visitor, they land here.', 'Connect a channel', 'onclick="navigate(\'channels\')"');
      return;
    }
    body.innerHTML = '<table class="table"><thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Phone</th><th scope="col">Score</th><th scope="col">When</th></tr></thead><tbody>' +
      rows.map((l, i) => {
        const band = scoreBand(l);
        const pill = band === 'hot' ? 'accent' : band === 'warm' ? 'amber' : '';
        return '<tr class="clickable row-band ' + band + '" data-lead="' + i + '" tabindex="0">' +
          '<td class="primary">' + esc(l.name || '—') + '</td>' +
          '<td>' + esc(l.email || '—') + '</td>' +
          '<td class="num">' + esc(l.phone || '—') + '</td>' +
          '<td><span class="pill ' + pill + '">' + esc(typeof l.score === 'number' ? l.score : band) + '</span></td>' +
          '<td>' + timeAgo(l.date) + '</td></tr>';
      }).join('') + '</tbody></table>';
    const shown = rows;
    $$('[data-lead]', body).forEach(tr => {
      const open = () => showLeadDrawer(shown[Number(tr.dataset.lead)]);
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
    });
  },
};

window.exportLeadsCSV = async function () {
  try {
    const d = await api('/api/dashboard/leads');
    const leads = (d && d.leads) || [];
    if (!leads.length) { toast('No leads to export', 'info'); return; }
    const csvCell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const csv = ['Name,Email,Phone,Score,Date']
      .concat(leads.map(l => [l.name, l.email, l.phone, l.score != null ? l.score : l.tag, l.date].map(csvCell).join(',')))
      .join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'aria-leads.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Exported ' + leads.length + ' leads');
  } catch (e) { toast(e.message, 'error'); }
};

function showLeadDrawer(lead) {
  const body = openDrawer(lead.name || lead.email || 'Lead');
  const band = scoreBand(lead);
  body.innerHTML =
    '<div style="display:flex;gap:8px;align-items:center;margin-bottom:var(--sp-4)">' +
    '<span class="pill ' + (band === 'hot' ? 'accent' : band === 'warm' ? 'amber' : '') + '">' + esc(band) +
    (typeof lead.score === 'number' ? ' · ' + lead.score : '') + '</span>' +
    (lead.tag ? '<span class="pill">' + esc(lead.tag) + '</span>' : '') +
    '<span class="lr-sub" style="margin-left:auto">' + timeAgo(lead.date) + '</span></div>' +
    '<div class="kb-doc-row"><span style="width:80px;color:var(--text-3)">Email</span><span class="primary">' + esc(lead.email || '—') + '</span></div>' +
    '<div class="kb-doc-row"><span style="width:80px;color:var(--text-3)">Phone</span><span>' + esc(lead.phone || '—') + '</span></div>' +
    (lead.page ? '<div class="kb-doc-row"><span style="width:80px;color:var(--text-3)">Page</span><span>' + esc(lead.page) + '</span></div>' : '') +
    (lead.estimatedValue ? '<div class="kb-doc-row"><span style="width:80px;color:var(--text-3)">Est. value</span><span class="primary">£' + fmtNum(lead.estimatedValue) + '</span></div>' : '') +
    '<div style="margin-top:var(--sp-5);display:flex;gap:var(--sp-2)">' +
    '<button class="btn" id="lead-goto-convs">' + icon('message-circle', 14) + ' View conversations</button>' +
    (lead.email ? '<a class="btn" href="mailto:' + esc(lead.email) + '">' + icon('mail', 14) + ' Email</a>' : '') +
    '</div>';
  $('#lead-goto-convs').addEventListener('click', () => { closeDrawer(); navigate('conversations'); });
}

/* ---------------- 4. CUSTOMERS ---------------- */
Panels.customers = {
  q: '', _rows: [],
  render(root) {
    root.innerHTML =
      panelHeader('customers', 'Everyone who has talked to Aria, with lifetime value.', refreshBtn()) +
      '<div style="margin-bottom:var(--sp-4);max-width:380px">' +
        '<input class="input" id="cust-search" type="search" placeholder="Search customers…" aria-label="Search customers"></div>' +
      '<div class="card" style="padding:var(--sp-2) var(--sp-4)"><div id="cust-body"></div></div>';
    wireRefresh(root, 'customers');
    $('#cust-search').addEventListener('input', e => { this.q = e.target.value.toLowerCase(); this.paint(); });
    this.load();
  },
  load() {
    const body = $('#cust-body');
    body.innerHTML = skeletonHTML(6);
    api('/api/dashboard/customers').then(d => {
      this._rows = ((d && d.customers) || []).slice(0, 100);
      this.paint();
    }).catch(e => {
      body.innerHTML = errorStateHTML(e.message);
      const r = body.querySelector('[data-retry]');
      if (r) r.addEventListener('click', () => this.load());
    });
  },
  paint() {
    const body = $('#cust-body');
    if (!body) return;
    let rows = this._rows;
    if (this.q) rows = rows.filter(cu => String(cu.name || cu.key || '').toLowerCase().includes(this.q));
    if (!rows.length) {
      body.innerHTML = this._rows.length
        ? emptyStateHTML('search', 'No matching customers', 'Try a different search.')
        : emptyStateHTML('users', 'No customers yet', 'People who message Aria appear here automatically.');
      return;
    }
    body.innerHTML = '<table class="table"><thead><tr><th scope="col">Customer</th><th scope="col">Channels</th><th scope="col">Touches</th><th scope="col">Last seen</th><th scope="col"></th></tr></thead><tbody>' +
      rows.map((cu, i) =>
        '<tr class="clickable" data-cust="' + i + '" tabindex="0">' +
        '<td class="primary">' + esc(cu.name || cu.key) + '</td>' +
        '<td><span style="display:inline-flex;gap:4px">' + (cu.channels || []).map(ch => chIcon(ch, 12)).join('') + '</span></td>' +
        '<td class="num">' + fmtNum(cu.touches) + '</td>' +
        '<td>' + timeAgo(cu.lastSeen) + '</td>' +
        '<td style="text-align:right;color:var(--accent)">View ' + icon('chevron-right', 13) + '</td></tr>'
      ).join('') + '</tbody></table>';
    const shown = rows;
    $$('[data-cust]', body).forEach(tr => {
      const open = () => showCustomerDrawer(shown[Number(tr.dataset.cust)].key);
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
    });
  },
};

async function showCustomerDrawer(key) {
  const body = openDrawer('Customer');
  try {
    const d = await api('/api/dashboard/customer/' + encodeURIComponent(key));
    setDrawerTitle(d.name || d.key || 'Customer');
    const ltv = d.ltv || 0;
    const tier = ltv >= 60 ? ['VIP', 'accent'] : ltv >= 30 ? ['Engaged', 'amber'] : ltv >= 10 ? ['Active', 'violet'] : ['New', ''];
    const senti = d.sentimentTimeline || [];
    const counts = { positive: 0, neutral: 0, negative: 0, angry: 0 };
    senti.forEach(s => { if (counts[s.sentiment] != null) counts[s.sentiment]++; });
    const totalS = senti.length || 1;
    const sentiBar = senti.length
      ? '<div style="margin:var(--sp-4) 0"><div class="lr-sub" style="margin-bottom:4px">Sentiment over time</div>' +
        '<div class="senti-bar" role="img" aria-label="Sentiment: ' + counts.positive + ' positive, ' + counts.neutral + ' neutral, ' + counts.negative + ' negative, ' + counts.angry + ' angry">' +
        '<i style="width:' + (counts.positive / totalS * 100) + '%;background:var(--accent)"></i>' +
        '<i style="width:' + (counts.neutral / totalS * 100) + '%;background:var(--text-3)"></i>' +
        '<i style="width:' + (counts.negative / totalS * 100) + '%;background:var(--amber)"></i>' +
        '<i style="width:' + (counts.angry / totalS * 100) + '%;background:var(--red)"></i></div></div>'
      : '';
    const section = (title, inner) => inner ? '<h3 style="margin:var(--sp-5) 0 var(--sp-2)">' + esc(title) + '</h3>' + inner : '';
    body.innerHTML =
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:var(--sp-2)">' +
      '<span class="pill ' + tier[1] + '">' + tier[0] + ' · LTV ' + ltv + '</span>' +
      (d.channels || []).map(ch => '<span class="pill">' + esc(chMeta(ch).label) + '</span>').join('') +
      '<span class="lr-sub" style="margin-left:auto">last seen ' + timeAgo(d.lastSeen) + '</span></div>' +
      '<div class="lr-sub">' + fmtNum(d.touches) + ' touches</div>' +
      sentiBar +
      section('Bookings', (d.bookings || []).slice(0, 5).map(b =>
        '<div class="list-row">' + icon('calendar', 14) + '<div class="lr-main"><div class="lr-title">' + esc(b.service || 'Booking') + '</div>' +
        '<div class="lr-sub">' + esc(b.datetime || '') + '</div></div></div>').join('')) +
      section('Conversations', (d.conversations || []).slice(0, 5).map((cv, i) =>
        '<div class="list-row clickable" role="button" tabindex="0" data-thread="' + esc(cv.memKey) + '">' + chIcon(cv.channel) +
        '<div class="lr-main"><div class="lr-title">' + esc(chMeta(cv.channel).label) + '</div>' +
        '<div class="lr-sub">' + fmtNum(cv.msgCount) + ' messages · ' + timeAgo(cv.lastMsgTs) + '</div></div>' +
        icon('chevron-right', 14) + '</div>').join('')) +
      section('Lead history', (d.leadHistory || []).slice(0, 10).map(lh => {
        const pill = lh.leadScore === 'hot' ? 'accent' : lh.leadScore === 'warm' ? 'amber' : '';
        return '<div class="list-row"><span class="pill ' + pill + '">' + esc(lh.leadScore || '—') + '</span>' +
          '<div class="lr-main"><div class="lr-title">' + esc(lh.category || 'Lead') + '</div>' +
          '<div class="lr-sub">“' + esc(lh.preview || '') + '”</div></div>' +
          '<span class="lr-sub">' + timeAgo(lh.ts) + '</span></div>';
      }).join(''));
    $$('[data-thread]', body).forEach(node => {
      const open = () => showThread(node.dataset.thread);
      node.addEventListener('click', open);
      node.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
    });
  } catch (e) {
    body.innerHTML = errorStateHTML(e.message);
    const r = body.querySelector('[data-retry]');
    if (r) r.addEventListener('click', () => showCustomerDrawer(key));
  }
}

/* ---------------- 5. BOOKINGS ---------------- */
Panels.bookings = {
  view: 'list', _rows: [],
  render(root) {
    root.innerHTML =
      panelHeader('bookings', 'Appointments Aria has captured.',
        '<button class="btn' + (this.view === 'list' ? ' btn-primary' : '') + '" data-view="list">' + icon('list', 14) + ' List</button>' +
        '<button class="btn' + (this.view === 'week' ? ' btn-primary' : '') + '" data-view="week">' + icon('grid', 14) + ' Week</button>' +
        refreshBtn()) +
      '<div id="bookings-body"></div>';
    wireRefresh(root, 'bookings');
    $$('[data-view]', root).forEach(b => b.addEventListener('click', () => { this.view = b.dataset.view; this.render(root); }));
    this.load();
  },
  load() {
    const body = $('#bookings-body');
    body.innerHTML = '<div class="card">' + skeletonHTML(5) + '</div>';
    api('/api/dashboard/bookings').then(d => {
      this._rows = (d && d.bookings) || [];
      this.paint();
    }).catch(e => {
      body.innerHTML = '<div class="card">' + errorStateHTML(e.message) + '</div>';
      const r = body.querySelector('[data-retry]');
      if (r) r.addEventListener('click', () => this.load());
    });
  },
  paint() {
    const body = $('#bookings-body');
    if (!body) return;
    if (!this._rows.length) {
      body.innerHTML = '<div class="card">' + emptyStateHTML('calendar', 'No bookings yet', 'When Aria books an appointment, it shows up here.') + '</div>';
      return;
    }
    if (this.view === 'week') { this.paintWeek(body); return; }
    body.innerHTML = '<div class="card" style="padding:var(--sp-2) var(--sp-4)">' +
      this._rows.map((b, i) =>
        '<div class="list-row clickable" role="button" tabindex="0" data-bk="' + i + '">' + chIcon(b.channel || 'web') +
        '<div class="lr-main"><div class="lr-title">' + esc(b.name || 'Booking') + (b.service ? ' — ' + esc(b.service) : '') + '</div>' +
        '<div class="lr-sub">' + esc(b.datetime || '') + (b.contact ? ' · ' + esc(b.contact) : '') + '</div>' +
        (b.notes ? '<div class="lr-sub" style="font-style:italic">' + esc(b.notes) + '</div>' : '') + '</div>' +
        (b.icsFilename ? '<a class="btn btn-sm" href="/api/dashboard/booking-ics/' + encodeURIComponent(b.icsFilename) + '?' + Q + '" aria-label="Download calendar file" onclick="event.stopPropagation()">' + icon('download', 13) + ' .ics</a>' : '') +
        '</div>').join('') + '</div>';
    this.wireRows(body);
  },
  paintWeek(body) {
    // current week, Monday-start, today highlighted
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    monday.setHours(0, 0, 0, 0);
    const days = [];
    for (let i = 0; i < 7; i++) { const d = new Date(monday); d.setDate(monday.getDate() + i); days.push(d); }
    const dayKey = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); // local date, not UTC
    const byDay = {};
    const unscheduled = [];
    this._rows.forEach((b, i) => {
      const ts = Date.parse(b.datetime || b.ts || '');
      if (Number.isNaN(ts)) { unscheduled.push(i); return; }
      const k = dayKey(new Date(ts));
      (byDay[k] = byDay[k] || []).push({ i: i, ts: ts });
    });
    const todayK = dayKey(new Date());
    body.innerHTML = '<div class="week-strip" role="grid" aria-label="This week’s bookings">' +
      days.map(d => {
        const k = dayKey(d);
        const evts = (byDay[k] || []).sort((a, b2) => a.ts - b2.ts);
        return '<div class="week-col' + (k === todayK ? ' today' : '') + '" role="gridcell">' +
          '<div class="wc-head">' + d.toLocaleDateString(undefined, { weekday: 'short' }) + '</div>' +
          '<div class="wc-date">' + d.getDate() + '</div>' +
          evts.map(ev => {
            const b = this._rows[ev.i];
            return '<button class="week-evt" data-bk="' + ev.i + '">' +
              new Date(ev.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) + ' ' + esc(b.name || b.service || 'Booking') + '</button>';
          }).join('') + '</div>';
      }).join('') + '</div>' +
      (unscheduled.length
        ? '<div class="card" style="margin-top:var(--sp-4);padding:var(--sp-3) var(--sp-4)"><div class="lr-sub" style="margin-bottom:4px">Bookings without a parseable date</div>' +
          unscheduled.map(i => '<button class="week-evt" data-bk="' + i + '">' + esc(this._rows[i].name || 'Booking') + ' — ' + esc(this._rows[i].datetime || 'no date') + '</button>').join('') + '</div>'
        : '');
    this.wireRows(body);
  },
  wireRows(body) {
    $$('[data-bk]', body).forEach(node => {
      const b = this._rows[Number(node.dataset.bk)];
      const open = () => showBookingDrawer(b);
      node.addEventListener('click', open);
      node.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
    });
  },
};

function showBookingDrawer(b) {
  const body = openDrawer(b.name || 'Booking');
  const row = (label, val) => val ? '<div class="kb-doc-row"><span style="width:90px;color:var(--text-3)">' + label + '</span><span>' + esc(val) + '</span></div>' : '';
  body.innerHTML =
    '<div style="display:flex;gap:8px;align-items:center;margin-bottom:var(--sp-4)">' + chIcon(b.channel || 'web') +
    '<span class="pill">' + esc(chMeta(b.channel || 'web').label) + '</span>' +
    '<span class="lr-sub" style="margin-left:auto">' + timeAgo(b.ts) + '</span></div>' +
    row('Service', b.service) + row('When', b.datetime) + row('Contact', b.contact) + row('Notes', b.notes) +
    '<div style="margin-top:var(--sp-5);display:flex;gap:var(--sp-2)">' +
    (b.icsFilename ? '<a class="btn" href="/api/dashboard/booking-ics/' + encodeURIComponent(b.icsFilename) + '?' + Q + '">' + icon('download', 14) + ' Add to calendar (.ics)</a>' : '') +
    '</div>' +
    '<p class="lr-sub" style="margin-top:var(--sp-4)">To cancel or move this booking, reply to the customer directly — in-dashboard rescheduling arrives with the calendar upgrade.</p>';
}

/* ---------------- 6. TRAIN ARIA ---------------- */
Panels.train = {
  render(root) {
    root.innerHTML =
      panelHeader('train', 'Teach Aria your business — then test her before customers do.', refreshBtn()) +
      '<div class="card-grid">' +
        '<div class="card span-2" id="train-test"></div>' +
        '<div class="card span-2" id="train-gaps"></div>' +
        '<div class="card span-2" id="train-quick"></div>' +
        '<div class="card span-2" id="train-kb"></div>' +
        '<div class="card span-2" id="train-services"></div>' +
        '<div class="card" id="train-hours"></div>' +
        '<div class="card" id="train-scope"></div>' +
      '</div>';
    wireRefresh(root, 'train');
    this.renderTest();
    this.loadGaps();
    this.renderQuickTrain();
    this.loadKB();
    this.loadServices();
    this.loadHours();
    this.loadScope();
  },

  /* --- 6.1 test sandbox --- */
  renderTest() {
    const card = $('#train-test');
    card.innerHTML = '<div class="card-title">' + icon('flask', 16) + '<h2>Test Aria</h2><span class="ct-sub">sandbox — nothing is sent</span></div>' +
      '<div class="chat-box" id="ta-log" aria-live="polite"></div>' +
      '<form class="form-row" id="ta-form" style="margin-top:var(--sp-2)">' +
      '<input class="input" id="ta-input" placeholder="Ask Aria anything a customer might…" aria-label="Test message" autocomplete="off">' +
      '<button class="btn btn-primary" type="submit" style="flex:0 0 auto">' + icon('send', 14) + ' Ask</button></form>';
    $('#ta-form').addEventListener('submit', async e => {
      e.preventDefault();
      const input = $('#ta-input');
      const msg = input.value.trim();
      if (!msg) return;
      input.value = '';
      const log = $('#ta-log');
      log.insertAdjacentHTML('beforeend', '<div class="bubble them">' + esc(msg) + '</div>');
      const pending = el('<div class="bubble us">' + skeletonHTML(1) + '</div>');
      log.appendChild(pending);
      log.scrollTop = log.scrollHeight;
      try {
        const d = await apiPost('/api/dashboard/test-aria', { message: msg });
        const r = d.reply || {};
        let badges = '';
        const add = (cond, cls, ic, label) => { if (cond) badges += '<span class="pill ' + cls + '">' + icon(ic, 10) + ' ' + esc(label) + '</span>'; };
        add(r.sentiment && r.sentiment !== 'neutral', '', 'eye', r.sentiment);
        add(r.urgency && r.urgency !== 'low', 'amber', 'clock', 'urgency: ' + r.urgency);
        add(r.language && r.language !== 'en', 'blue', 'globe', r.language);
        add(r.outOfScope, 'amber', 'alert-triangle', 'out of scope');
        add(r.needsHuman, 'red', 'handshake', 'needs human');
        add(r.booking, 'accent', 'calendar', 'booking detected');
        add(r.showServicesCarousel, 'violet', 'grid', 'shows carousel');
        const chips = (r.suggestedReplies || []).map(srp => '<span class="pill">' + esc(srp) + '</span>').join(' ');
        const cited = (d.citedChunks || []).map(ck => '<div class="cited-chunk">' + icon('book', 10) + ' ' + esc(ck.title) + ' — ' + esc(ck.preview || '') + '</div>').join('');
        pending.outerHTML = '<div class="bubble us">' + esc(r.text || '(no reply)') + '</div>' +
          (badges ? '<div class="badge-row">' + badges + '</div>' : '') +
          (chips ? '<div class="badge-row">' + chips + '</div>' : '') + cited;
        log.scrollTop = log.scrollHeight;
      } catch (err) {
        pending.outerHTML = '<div class="bubble us" style="color:var(--red)">' + esc(err.message) + '</div>';
      }
    });
  },

  /* --- 6.2 knowledge gaps + bootstrap --- */
  loadGaps() {
    const card = $('#train-gaps');
    card.innerHTML = '<div class="card-title">' + icon('lightbulb', 16) + '<h2>Knowledge gaps</h2><span class="ct-sub">Aria couldn’t answer these — teach her</span></div><div id="gaps-body"></div>';
    const body = $('#gaps-body');
    loadInto(body, () => api('/api/dashboard/channel-gaps'), (d, c) => {
      const clusters = (d && d.clusters) || [];
      if (!clusters.length) return false;
      let html = '';
      if (clusters.length >= 3) {
        html += '<div class="banner" style="background:var(--accent-dim);border-color:rgba(0,229,160,.25)"><div class="banner-head" style="color:var(--accent)">' +
          icon('sparkles', 14) + ' ' + clusters.length + ' question clusters found</div>' +
          '<div><button class="btn btn-primary btn-sm" id="gaps-bootstrap">Draft all answers with AI</button></div></div>';
      }
      html += clusters.map((cl, i) =>
        '<div class="gap-card" data-gap="' + i + '"><div style="display:flex;gap:8px;align-items:flex-start">' +
        '<div class="lr-main"><div class="lr-title">“' + esc(cl.sampleQuestion) + '”</div>' +
        '<div class="lr-sub">asked ' + fmtNum(cl.count) + '× · last ' + timeAgo(cl.lastSeen) + '</div></div>' +
        '<button class="btn btn-sm" data-draft="' + i + '">' + icon('sparkles', 12) + ' Draft answer</button></div>' +
        '<div data-draft-slot></div></div>').join('');
      c.innerHTML = html;
      const boot = $('#gaps-bootstrap');
      if (boot) boot.addEventListener('click', () => this.bootstrap(c));
      $$('[data-draft]', c).forEach(btn => btn.addEventListener('click', async () => {
        const cl = clusters[Number(btn.dataset.draft)];
        const slot = btn.closest('.gap-card').querySelector('[data-draft-slot]');
        slot.innerHTML = skeletonHTML(3);
        btn.disabled = true;
        try {
          const d2 = await apiPost('/api/dashboard/gap-to-kb', { questions: (cl.examples || []).map(x => x.question).concat([cl.sampleQuestion]).filter(Boolean) });
          const draft = d2.draft || {};
          slot.innerHTML =
            (draft.needsOwnerInput && draft.needsOwnerInput.length
              ? '<div class="pill amber" style="margin:6px 0">' + icon('alert-triangle', 10) + ' fill in: ' + esc(draft.needsOwnerInput.join(', ')) + '</div>' : '') +
            '<div class="field" style="margin-top:8px"><label>Title</label><input class="input input-sm" data-d-title value="' + esc(draft.title || '') + '"></div>' +
            '<div class="field"><label>Answer</label><textarea class="textarea" data-d-content>' + esc(draft.content || '') + '</textarea></div>' +
            '<div style="display:flex;gap:8px"><button class="btn btn-primary btn-sm" data-d-accept>' + icon('plus', 12) + ' Add to knowledge</button>' +
            '<button class="btn btn-ghost btn-sm" data-d-discard>Discard</button></div>';
          slot.querySelector('[data-d-accept]').addEventListener('click', async () => {
            try {
              await apiPost('/api/dashboard/knowledge', { title: slot.querySelector('[data-d-title]').value, content: slot.querySelector('[data-d-content]').value });
              toast('Added to Aria’s knowledge');
              this.loadGaps(); this.loadKB();
            } catch (e2) { toast(e2.message, 'error'); }
          });
          slot.querySelector('[data-d-discard]').addEventListener('click', () => { slot.innerHTML = ''; btn.disabled = false; });
        } catch (e2) {
          slot.innerHTML = '<p class="lr-sub" style="color:var(--red)">' + esc(e2.message) + '</p>';
          btn.disabled = false;
        }
      }));
    }, { emptyIcon: 'check', emptyTitle: 'No gaps right now', emptySub: 'Aria has been able to answer everything lately.' });
  },

  async bootstrap(container) {
    const btn = $('#gaps-bootstrap');
    btn.disabled = true;
    btn.textContent = 'Drafting…';
    try {
      const d = await apiPost('/api/dashboard/faq-bootstrap', { limit: 10 });
      const drafts = (d.drafts || []).filter(x => x.draft);
      if (!drafts.length) { toast(d.message || 'No drafts produced', 'info'); btn.disabled = false; btn.textContent = 'Draft all answers with AI'; return; }
      container.innerHTML = '<div class="lr-sub" style="margin-bottom:var(--sp-3)">Review the drafts, untick any you don’t want, then save.</div>' +
        drafts.map((x, i) =>
          '<div class="gap-card"><label style="display:flex;gap:8px;align-items:center;margin-bottom:6px;cursor:pointer">' +
          '<input type="checkbox" checked data-b-check="' + i + '" style="accent-color:var(--accent)"> <strong>“' + esc(x.sampleQuestion) + '”</strong>' +
          '<span class="lr-sub" style="margin-left:auto">' + fmtNum(x.count) + '×</span></label>' +
          '<input class="input input-sm" data-b-title="' + i + '" value="' + esc(x.draft.title || '') + '" style="margin-bottom:6px">' +
          '<textarea class="textarea" data-b-content="' + i + '">' + esc(x.draft.content || '') + '</textarea>' +
          (x.draft.needsOwnerInput && x.draft.needsOwnerInput.length ? '<div class="pill amber" style="margin-top:6px">' + icon('alert-triangle', 10) + ' fill in: ' + esc(x.draft.needsOwnerInput.join(', ')) + '</div>' : '') +
          '</div>').join('') +
        '<button class="btn btn-primary" id="boot-save">' + icon('check', 14) + ' Save selected to knowledge</button>';
      $('#boot-save').addEventListener('click', async () => {
        const accepted = drafts.map((x, i) => ({
          on: container.querySelector('[data-b-check="' + i + '"]').checked,
          title: container.querySelector('[data-b-title="' + i + '"]').value,
          content: container.querySelector('[data-b-content="' + i + '"]').value,
        })).filter(x => x.on).map(x => ({ title: x.title, content: x.content }));
        if (!accepted.length) { toast('Nothing selected', 'info'); return; }
        try {
          const res = await apiPost('/api/dashboard/faq-bootstrap/accept', { accepted: accepted });
          toast('Saved ' + res.saved + (res.skipped ? ', skipped ' + res.skipped : ''));
          this.loadGaps(); this.loadKB();
        } catch (e) { toast(e.message, 'error'); }
      });
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Draft all answers with AI';
    }
  },

  /* --- 6.3 quick train wizard --- */
  renderQuickTrain() {
    const card = $('#train-quick');
    card.innerHTML = '<div class="card-title">' + icon('sparkles', 16) + '<h2>Quick train</h2><span class="ct-sub">website or one-liner → instant setup</span></div>' +
      '<div class="form-row"><div class="field"><label for="qt-url">Website URL</label><input class="input" id="qt-url" placeholder="https://yourbusiness.co.uk" inputmode="url"></div></div>' +
      '<div class="field"><label for="qt-desc">Or describe the business (1–3 sentences)</label><textarea class="textarea" id="qt-desc" placeholder="We’re a family-run roofing company in Leeds…"></textarea></div>' +
      '<button class="btn btn-primary" id="qt-go">' + icon('sparkles', 14) + ' Generate draft</button>' +
      '<div id="qt-result" style="margin-top:var(--sp-4)"></div>';
    $('#qt-go').addEventListener('click', async () => {
      const websiteUrl = $('#qt-url').value.trim();
      const description = $('#qt-desc').value.trim();
      if (!websiteUrl && !description) { toast('Add a URL or a description first', 'info'); return; }
      const out = $('#qt-result');
      out.innerHTML = skeletonHTML(4);
      $('#qt-go').disabled = true;
      try {
        const d = await apiPost('/api/dashboard/ai-train', { websiteUrl: websiteUrl, description: description });
        let html = '';
        if (d.knowledgeDoc) {
          html += '<div class="gap-card"><div class="lr-title" style="margin-bottom:6px">' + icon('book', 13) + ' Knowledge: ' + esc(d.knowledgeDoc.title) + '</div>' +
            '<p class="lr-sub" style="white-space:pre-wrap;max-height:140px;overflow:auto">' + esc(d.knowledgeDoc.content) + '</p>' +
            '<button class="btn btn-sm" data-qt-doc style="margin-top:8px">' + icon('plus', 12) + ' Accept</button></div>';
        }
        if (d.services && d.services.length) {
          html += '<div class="gap-card"><div class="lr-title" style="margin-bottom:6px">' + icon('grid', 13) + ' ' + d.services.length + ' service cards</div>' +
            d.services.map(s => '<span class="pill">' + esc(s.title) + '</span> ').join('') +
            '<div><button class="btn btn-sm" data-qt-services style="margin-top:8px">' + icon('plus', 12) + ' Accept</button></div></div>';
        }
        if (d.allowedTopics && d.allowedTopics.length) {
          html += '<div class="gap-card"><div class="lr-title" style="margin-bottom:6px">' + icon('target', 13) + ' Topic scope</div>' +
            d.allowedTopics.map(t => '<span class="pill">' + esc(t) + '</span> ').join('') +
            '<div><button class="btn btn-sm" data-qt-topics style="margin-top:8px">' + icon('plus', 12) + ' Accept</button></div></div>';
        }
        if (!html) { out.innerHTML = emptyStateHTML('alert-circle', 'Nothing extracted', 'Try a fuller description.'); $('#qt-go').disabled = false; return; }
        html += '<button class="btn btn-primary" data-qt-all>' + icon('check', 14) + ' Accept all</button>';
        out.innerHTML = html;
        const acceptDoc = async () => { await apiPost('/api/dashboard/knowledge', { title: d.knowledgeDoc.title, content: d.knowledgeDoc.content }); this.loadKB(); };
        const acceptServices = async () => {
          const profile = await getProfile();
          const merged = ((profile.servicesCarousel || []).concat(d.services)).slice(0, 10);
          await apiPost('/api/dashboard/profile', { servicesCarousel: merged });
          invalidateProfile(); this.loadServices();
        };
        const acceptTopics = async () => {
          const profile = await getProfile();
          const merged = Array.from(new Set((profile.allowedTopics || []).concat(d.allowedTopics))).slice(0, 12);
          await apiPost('/api/dashboard/profile', { allowedTopics: merged });
          invalidateProfile(); this.loadScope();
        };
        const wire = (sel, fn, label) => {
          const b = out.querySelector(sel);
          if (b) b.addEventListener('click', async () => {
            try { b.disabled = true; await fn(); toast(label + ' saved'); } catch (e) { b.disabled = false; toast(e.message, 'error'); }
          });
        };
        wire('[data-qt-doc]', acceptDoc, 'Knowledge');
        wire('[data-qt-services]', acceptServices, 'Services');
        wire('[data-qt-topics]', acceptTopics, 'Topics');
        wire('[data-qt-all]', async () => {
          if (d.knowledgeDoc) await acceptDoc();
          if (d.services && d.services.length) await acceptServices();
          if (d.allowedTopics && d.allowedTopics.length) await acceptTopics();
        }, 'Everything');
      } catch (e) {
        out.innerHTML = '<p class="lr-sub" style="color:var(--red)">' + esc(e.message) + '</p>';
      }
      $('#qt-go').disabled = false;
    });
  },

  /* --- 6.4 knowledge docs CRUD --- */
  loadKB() {
    const card = $('#train-kb');
    card.innerHTML = '<div class="card-title">' + icon('book', 16) + '<h2>Knowledge documents</h2><span class="ct-sub" id="kb-count"></span></div>' +
      '<div id="kb-list"></div>' +
      '<h3 style="margin:var(--sp-5) 0 var(--sp-3)">Add knowledge</h3>' +
      '<div class="field"><label for="kb-title">Title</label><input class="input" id="kb-title" placeholder="e.g. Pricing & quotes"></div>' +
      '<div class="field"><label for="kb-content">Content</label><textarea class="textarea" id="kb-content" placeholder="Everything Aria should know about this topic…"></textarea></div>' +
      '<div class="form-row" style="align-items:flex-end"><div class="field" style="margin-bottom:0"><label for="kb-improve-inst">AI improve — instruction (optional)</label>' +
      '<input class="input" id="kb-improve-inst" placeholder="e.g. make it friendlier and add a returns section"></div>' +
      '<button class="btn" id="kb-improve" style="flex:0 0 auto">' + icon('sparkles', 14) + ' Improve with AI</button>' +
      '<button class="btn btn-primary" id="kb-add" style="flex:0 0 auto">' + icon('plus', 14) + ' Add to knowledge</button></div>';
    const list = $('#kb-list');
    loadInto(list, () => api('/api/dashboard/knowledge'), (d, c) => {
      const docs = (d && d.docs) || [];
      $('#kb-count').textContent = docs.length + ' / 50 docs';
      if (!docs.length) return false;
      c.innerHTML = docs.map((doc, i) =>
        '<div class="kb-doc-row">' + icon('file-text', 14) +
        '<div class="lr-main"><span class="primary">' + esc(doc.title) + '</span>' +
        '<span class="lr-sub" style="display:block">' + fmtNum(doc.charCount) + ' chars · added ' + timeAgo(doc.uploadedAt) + '</span></div>' +
        '<button class="icon-btn" data-kb-del="' + i + '" aria-label="Remove ' + esc(doc.title) + '">' + icon('trash', 14) + '</button></div>').join('');
      $$('[data-kb-del]', c).forEach(b => b.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: 'Remove this document?', body: 'Aria will stop using it immediately.', confirmLabel: 'Remove', danger: true });
        if (!ok) return;
        try { await apiDelete('/api/dashboard/knowledge/' + b.dataset.kbDel); toast('Removed'); this.loadKB(); }
        catch (e) { toast(e.message, 'error'); }
      }));
    }, { emptyIcon: 'book', emptyTitle: 'No documents yet', emptySub: 'Add your first doc below, or use Quick train.' });
    $('#kb-improve').addEventListener('click', async () => {
      const current = $('#kb-content').value;
      const instruction = $('#kb-improve-inst').value.trim();
      if (!current && !instruction) { toast('Write some content or an instruction first', 'info'); return; }
      const b = $('#kb-improve');
      b.disabled = true;
      try {
        const d = await apiPost('/api/dashboard/ai-improve', { current: current, instruction: instruction, kind: 'knowledge' });
        $('#kb-content').value = d.improved || current;
        toast('Improved — review before adding');
      } catch (e) { toast(e.message, 'error'); }
      b.disabled = false;
    });
    $('#kb-add').addEventListener('click', async () => {
      const title = $('#kb-title').value.trim();
      const content = $('#kb-content').value.trim();
      if (!title || !content) { toast('Title and content required', 'info'); return; }
      try {
        await apiPost('/api/dashboard/knowledge', { title: title, content: content });
        toast('Added to Aria’s knowledge');
        $('#kb-title').value = ''; $('#kb-content').value = '';
        this.loadKB();
      } catch (e) { toast(e.message, 'error'); }
    });
  },

  /* --- 6.5 services carousel editor --- */
  loadServices() {
    const card = $('#train-services');
    card.innerHTML = '<div class="card-title">' + icon('grid', 16) + '<h2>Services carousel</h2><span class="ct-sub">cards Aria can show customers (max 10)</span></div><div id="svc-body">' + skeletonHTML(3) + '</div>';
    getProfile().then(profile => {
      const services = (profile.servicesCarousel || []).map(s => Object.assign({}, s));
      const body = $('#svc-body');
      const paint = () => {
        body.innerHTML = services.map((s, i) =>
          '<div class="service-card" data-svc="' + i + '"><div style="display:flex;gap:var(--sp-3)">' +
          (s.image ? '<img src="' + esc(s.image) + '" alt="" onerror="this.hidden=true">' : '') +
          '<div style="flex:1">' +
          '<div class="form-row"><input class="input input-sm" data-f="title" placeholder="Title" value="' + esc(s.title || '') + '">' +
          '<input class="input input-sm" data-f="subtitle" placeholder="Subtitle" value="' + esc(s.subtitle || '') + '"></div>' +
          '<div class="form-row" style="margin-top:6px"><input class="input input-sm" data-f="image" placeholder="Image URL" value="' + esc(s.image || '') + '">' +
          '<input class="input input-sm" data-f="link" placeholder="Link URL" value="' + esc(s.link || '') + '">' +
          '<input class="input input-sm" data-f="btn_text" placeholder="Button text" value="' + esc(s.btn_text || '') + '" style="max-width:120px"></div>' +
          '</div><button class="icon-btn" data-svc-del="' + i + '" aria-label="Remove service card">' + icon('x', 14) + '</button></div></div>').join('') +
          '<div style="display:flex;gap:var(--sp-2)">' +
          (services.length < 10 ? '<button class="btn" id="svc-add">' + icon('plus', 14) + ' Add service card</button>' : '') +
          '<button class="btn btn-primary" id="svc-save">' + icon('check', 14) + ' Save services</button></div>';
        $$('[data-svc] [data-f]', body).forEach(input => input.addEventListener('input', () => {
          const i = Number(input.closest('[data-svc]').dataset.svc);
          services[i][input.dataset.f] = input.value;
        }));
        $$('[data-svc-del]', body).forEach(b => b.addEventListener('click', () => { services.splice(Number(b.dataset.svcDel), 1); paint(); }));
        const add = $('#svc-add');
        if (add) add.addEventListener('click', () => { services.push({ title: '', subtitle: '', image: '', link: '', btn_text: '' }); paint(); });
        $('#svc-save').addEventListener('click', async () => {
          try {
            await apiPost('/api/dashboard/profile', { servicesCarousel: services });
            invalidateProfile();
            toast('Services saved');
          } catch (e) { toast(e.message, 'error'); }
        });
      };
      paint();
    }).catch(e => { $('#svc-body').innerHTML = errorStateHTML(e.message); });
  },

  /* --- 6.6 business hours (message channels) --- */
  loadHours() {
    const card = $('#train-hours');
    card.innerHTML = '<div class="card-title">' + icon('clock', 16) + '<h2>Business hours</h2><span class="ct-sub" id="hours-badge"></span></div><div id="hours-body">' + skeletonHTML(3) + '</div>';
    getProfile().then(profile => {
      const sched = Object.assign({ mode: 'always', timezone: 'Europe/London', days: {}, outOfHours: 'auto_reply', outOfHoursMessage: '' }, profile.schedule || {});
      sched.days = Object.assign({ mon: '9-17', tue: '9-17', wed: '9-17', thu: '9-17', fri: '9-17', sat: 'closed', sun: 'closed' }, sched.days || {});
      const body = $('#hours-body');
      const badge = () => {
        const st = scheduleStatus(sched);
        $('#hours-badge').innerHTML = '<span class="pill ' + (st.open ? 'accent' : 'amber') + '">' + (st.open ? 'ON now' : 'OFF now') + ' · ' + esc(st.detail) + '</span>';
      };
      const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
      body.innerHTML =
        '<div class="field"><label for="hrs-mode">Mode</label><select class="select" id="hrs-mode">' +
        '<option value="always"' + (sched.mode !== 'business_hours' ? ' selected' : '') + '>Always on (24/7)</option>' +
        '<option value="business_hours"' + (sched.mode === 'business_hours' ? ' selected' : '') + '>Business hours only</option></select></div>' +
        '<div id="hrs-detail"' + (sched.mode === 'business_hours' ? '' : ' hidden') + '>' +
        '<div class="field"><label for="hrs-tz">Timezone</label><input class="input" id="hrs-tz" value="' + esc(sched.timezone) + '"></div>' +
        '<div class="hours-grid">' + days.map(d2 => '<label for="hrs-' + d2 + '">' + d2 + '</label><input class="input input-sm" id="hrs-' + d2 + '" data-day="' + d2 + '" value="' + esc(sched.days[d2]) + '" placeholder="9-18 / 9:30-17:30 / closed / 24h">').join('') + '</div>' +
        '<div class="field"><label for="hrs-ooh">Out of hours</label><select class="select" id="hrs-ooh">' +
        '<option value="auto_reply"' + (sched.outOfHours !== 'silent' ? ' selected' : '') + '>Send an out-of-hours reply</option>' +
        '<option value="silent"' + (sched.outOfHours === 'silent' ? ' selected' : '') + '>Stay silent</option></select></div>' +
        '<div class="field" id="hrs-msg-wrap"' + (sched.outOfHours === 'silent' ? ' hidden' : '') + '><label for="hrs-msg">Out-of-hours message</label>' +
        '<textarea class="textarea" id="hrs-msg">' + esc(sched.outOfHoursMessage || '') + '</textarea></div>' +
        '</div>' +
        '<button class="btn btn-primary" id="hrs-save">' + icon('check', 14) + ' Save hours</button>';
      badge();
      $('#hrs-mode').addEventListener('change', e => { sched.mode = e.target.value; $('#hrs-detail').hidden = sched.mode !== 'business_hours'; badge(); });
      $('#hrs-tz').addEventListener('input', e => { sched.timezone = e.target.value; badge(); });
      $$('#hrs-detail [data-day]', body).forEach(input => input.addEventListener('input', () => { sched.days[input.dataset.day] = input.value; badge(); }));
      $('#hrs-ooh').addEventListener('change', e => { sched.outOfHours = e.target.value; $('#hrs-msg-wrap').hidden = sched.outOfHours === 'silent'; });
      $('#hrs-msg').addEventListener('input', e => { sched.outOfHoursMessage = e.target.value; });
      $('#hrs-save').addEventListener('click', async () => {
        try {
          await apiPost('/api/dashboard/profile', { schedule: sched });
          invalidateProfile();
          toast('Hours saved');
        } catch (e) { toast(e.message, 'error'); }
      });
    }).catch(e => { $('#hours-body').innerHTML = errorStateHTML(e.message); });
  },

  /* --- 6.7 topic scope --- */
  loadScope() {
    const card = $('#train-scope');
    card.innerHTML = '<div class="card-title">' + icon('target', 16) + '<h2>Topic scope</h2><span class="ct-sub">what Aria is allowed to talk about</span></div><div id="scope-body">' + skeletonHTML(2) + '</div>';
    getProfile().then(profile => {
      let topics = (profile.allowedTopics || []).slice();
      const body = $('#scope-body');
      const paint = () => {
        body.innerHTML =
          '<div class="scope-chips">' + (topics.length
            ? topics.map((t, i) => '<span class="scope-chip">' + esc(t) + '<button class="icon-btn" style="width:20px;height:20px" data-topic-del="' + i + '" aria-label="Remove topic ' + esc(t) + '">' + icon('x', 11) + '</button></span>').join('')
            : '<span class="lr-sub">No topic limits — Aria answers anything about the business.</span>') + '</div>' +
          '<div class="form-row"><input class="input" id="scope-add-input" placeholder="Add a topic, e.g. pricing" aria-label="New topic">' +
          '<button class="btn" id="scope-add" style="flex:0 0 auto">' + icon('plus', 14) + ' Add</button>' +
          '<button class="btn btn-primary" id="scope-save" style="flex:0 0 auto">' + icon('check', 14) + ' Save</button></div>';
        $$('[data-topic-del]', body).forEach(b => b.addEventListener('click', () => { topics.splice(Number(b.dataset.topicDel), 1); paint(); }));
        const addTopic = () => {
          const v = $('#scope-add-input').value.trim();
          if (!v) return;
          if (topics.some(t => t.toLowerCase() === v.toLowerCase())) { toast('Already in the list', 'info'); return; }
          topics.push(v);
          paint();
          $('#scope-add-input').focus();
        };
        $('#scope-add').addEventListener('click', addTopic);
        $('#scope-add-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addTopic(); } });
        $('#scope-save').addEventListener('click', async () => {
          try {
            await apiPost('/api/dashboard/profile', { allowedTopics: topics });
            invalidateProfile();
            toast('Topics saved');
          } catch (e) { toast(e.message, 'error'); }
        });
      };
      paint();
    }).catch(e => { $('#scope-body').innerHTML = errorStateHTML(e.message); });
  },
};

/* schedule status (mirrors server logic, client-side badge) */
function scheduleStatus(sched) {
  if (!sched || sched.mode !== 'business_hours') return { open: true, detail: 'always on' };
  const tz = sched.timezone || 'Europe/London';
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  } catch (e) { return { open: true, detail: 'bad timezone' }; }
  const get = t => (parts.find(p => p.type === t) || {}).value || '';
  const day = get('weekday').slice(0, 3).toLowerCase();
  const nowMin = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  const spec = String((sched.days || {})[day] || 'closed').trim().toLowerCase();
  const hhmm = get('hour') + ':' + get('minute') + ' ' + tz;
  if (spec === 'closed') return { open: false, detail: hhmm };
  if (spec === '24h') return { open: true, detail: hhmm };
  const m = spec.match(/^(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return { open: false, detail: 'invalid hours "' + spec + '"' };
  const start = parseInt(m[1], 10) * 60 + (parseInt(m[2] || '0', 10));
  const end = parseInt(m[3], 10) * 60 + (parseInt(m[4] || '0', 10));
  return { open: nowMin >= start && nowMin < end, detail: hhmm };
}

/* ---------------- 7. CHANNELS (incl. phone — fixes the old "skeleton forever" bug) ---------------- */
Panels.channels = {
  render(root) {
    root.innerHTML =
      panelHeader('channels', 'Connect once — they stay connected. Pause any channel any time.', refreshBtn()) +
      '<div class="card-grid">' +
        '<div class="card span-2" id="ch-cards">' + skeletonHTML(4) + '</div>' +
        '<div class="card span-2" id="ch-phone">' + skeletonHTML(3) + '</div>' +
      '</div>';
    wireRefresh(root, 'channels');
    this.loadCards();
    this.loadPhone();
  },

  connectHref(kind) {
    const auth = 'owner=' + encodeURIComponent(OWNER) + '&s=' + encodeURIComponent(TOKEN);
    return kind === 'meta' ? '/connect/meta?' + auth
      : kind === 'instagram' ? '/connect/instagram?' + auth
      : '/connect/gmail?' + auth; // fixed: old template rendered a literal ${...} here (manifest §6.1)
  },

  async loadCards() {
    const wrap = $('#ch-cards');
    let cs;
    try { cs = await api('/api/dashboard/channel-stats'); }
    catch (e) {
      wrap.innerHTML = errorStateHTML(e.message);
      const r = wrap.querySelector('[data-retry]');
      if (r) r.addEventListener('click', () => this.loadCards());
      return;
    }
    const channels = (cs && cs.channels) || {};
    const stats = (cs && cs.stats) || {};
    const defs = [
      { key: 'whatsapp', detail: cfg => cfg.displayPhone, connect: null, connectLabel: 'Talk to us to connect WhatsApp' },
      { key: 'instagram', detail: cfg => cfg.igUsername && '@' + cfg.igUsername, connect: this.connectHref('instagram'), connectLabel: 'Connect Instagram (DMs)' },
      { key: 'facebook', detail: cfg => cfg.pageName, connect: this.connectHref('meta'), connectLabel: 'Connect Facebook (Page + Messenger)' },
    ];
    let html = '<div class="card-title">' + icon('link', 16) + '<h2>Messaging channels</h2></div>';
    html += defs.map(def => {
      const m = chMeta(def.key);
      const cfg = channels[def.key];
      const st = stats[def.key] || {};
      if (!cfg) {
        return '<div class="channel-card disconnected" style="padding:var(--sp-3) 0;border-bottom:1px solid var(--border)">' + chIcon(def.key, 16) +
          '<div class="cc-body"><strong>' + esc(m.label) + '</strong><span class="cc-detail">Not connected</span></div>' +
          '<div class="cc-actions">' + (def.connect
            ? '<a class="btn btn-primary btn-sm" href="' + def.connect + '">' + esc(def.connectLabel) + '</a>'
            : '<span class="lr-sub">' + esc(def.connectLabel) + '</span>') + '</div></div>';
      }
      const enabled = cfg.enabled !== false;
      return '<div class="channel-card" style="padding:var(--sp-3) 0;border-bottom:1px solid var(--border)">' + chIcon(def.key, 16) +
        '<div class="cc-body"><strong>' + esc(m.label) + ' <span class="pill accent">' + icon('check', 10) + ' Connected</span></strong>' +
        '<span class="cc-detail">' + esc(def.detail(cfg) || '') + ' · ' + fmtNum(st.replied || 0) + ' replies · ' +
        (enabled ? 'Aria is replying' : 'Replies paused') + '</span></div>' +
        '<div class="cc-actions">' +
        '<button class="toggle" role="switch" aria-checked="' + enabled + '" aria-label="' + esc(m.label) + ' replies" data-ch-toggle="' + def.key + '"></button>' +
        '<button class="btn btn-ghost btn-sm" data-ch-disc="' + def.key + '">Disconnect</button></div></div>';
    }).join('');

    // email / gmail
    const gmailOn = !!cs.gmailConnected;
    html += '<div class="channel-card' + (gmailOn ? '' : ' disconnected') + '" style="padding:var(--sp-3) 0">' + chIcon('email', 16) +
      '<div class="cc-body"><strong>Email (Gmail)' + (gmailOn ? ' <span class="pill accent">' + icon('check', 10) + ' Connected</span>' : '') + '</strong>' +
      '<span class="cc-detail">' + (gmailOn ? 'Inbox + auto-reply active. Tune behaviour in Settings.' : 'Aria reads and replies to your inbox.') + '</span></div>' +
      '<div class="cc-actions">' + (gmailOn
        ? '<a class="btn btn-sm" href="' + this.connectHref('gmail') + '">Gmail settings</a>'
        : '<a class="btn btn-primary btn-sm" href="' + this.connectHref('gmail') + '">Connect Gmail</a>') + '</div></div>';

    html += '<p class="lr-sub" style="margin-top:var(--sp-3)">' + icon('shield', 12) + ' Aria only reads messages sent to your business — never your personal data. Disconnect any time.</p>';
    wrap.innerHTML = html;

    $$('[data-ch-toggle]', wrap).forEach(t => t.addEventListener('click', async () => {
      const enabled = t.getAttribute('aria-checked') === 'true';
      try {
        await apiPost('/api/dashboard/channel-toggle', { channel: t.dataset.chToggle, enabled: !enabled });
        toast(chMeta(t.dataset.chToggle).label + (enabled ? ' paused' : ' resumed'));
        this.loadCards();
      } catch (e) { toast(e.message, 'error'); }
    }));
    $$('[data-ch-disc]', wrap).forEach(b => b.addEventListener('click', async () => {
      const key = b.dataset.chDisc;
      const ok = await confirmDialog({
        title: 'Disconnect ' + chMeta(key).label + '?',
        body: 'Aria will stop replying on this channel until you reconnect it.',
        confirmLabel: 'Disconnect', danger: true,
      });
      if (!ok) return;
      try { await apiPost('/api/dashboard/channel-disconnect', { channel: key }); toast('Disconnected'); this.loadCards(); }
      catch (e) { toast(e.message, 'error'); }
    }));
  },

  async loadPhone() {
    const wrap = $('#ch-phone');
    let d;
    try { d = await api('/api/dashboard/phone/settings'); }
    catch (e) {
      console.warn('[aria] phone settings unavailable:', e.message);
      wrap.closest('.card') ? wrap.remove() : (wrap.innerHTML = '');
      return;
    }
    const head = '<div class="card-title">' + icon('phone', 16) + '<h2>Phone receptionist</h2>' +
      (d.planAllowed ? '<span class="ct-sub">Receptionist plan</span>' : '') + '</div>';
    if (!d.planAllowed) {
      wrap.innerHTML = head + '<div class="empty-state">' + icon('phone', 26) +
        '<div class="es-title">Aria can answer your phone</div>' +
        '<div class="es-sub">You’re on the ' + esc(d.plan || 'Lite') + ' plan. Upgrade to the Receptionist plan to give Aria a phone line.</div>' +
        '<a class="btn btn-primary" href="mailto:kyle@aireyai.co.uk?subject=Upgrade%20to%20Receptionist%20plan">Ask about upgrading</a></div>';
      return;
    }
    const s = d.settings || {};
    let calls = [];
    try { const cd = await api('/api/dashboard/calls'); calls = (cd && cd.calls) || []; } catch (e) { /* fine */ }

    let numberBlock;
    if (s.provisioned && s.phoneNumber) {
      numberBlock = '<div class="gap-card"><div class="lr-title">Your Aria number: <span class="num">' + esc(s.phoneNumber) + '</span></div>' +
        '<p class="lr-sub">Forward your business line to this number, or publish it directly.</p>' +
        '<button class="btn btn-danger btn-sm" id="ph-release" style="margin-top:8px">Release number</button></div>';
    } else if (d.canProvision) {
      numberBlock = '<div class="gap-card"><div class="lr-title">Get Aria her own number</div>' +
        '<p class="lr-sub">We’ll provision a dedicated line in seconds.</p>' +
        '<button class="btn btn-primary btn-sm" id="ph-provision" style="margin-top:8px">Get my number</button>' +
        '<p class="lr-sub" style="margin-top:var(--sp-3)">Or use a number you already have:</p>' +
        '<div class="form-row" style="margin-top:6px"><input class="input input-sm" id="ph-own-number" placeholder="+44 7..." value="' + esc(s.phoneNumber || '') + '">' +
        '<button class="btn btn-sm" id="ph-own-connect" style="flex:0 0 auto">Connect</button></div></div>';
    } else {
      numberBlock = '<div class="gap-card"><div class="lr-title">Bring your own Vapi number</div>' +
        '<div class="form-row" style="margin-top:6px"><input class="input input-sm" id="ph-own-number" placeholder="+44 7..." value="' + esc(s.phoneNumber || '') + '">' +
        '<button class="btn btn-sm" id="ph-own-connect" style="flex:0 0 auto">Connect</button></div>' +
        '<p class="lr-sub" style="margin-top:6px">Set this webhook in your Vapi server settings:<br><span class="hook-url">' + esc(d.webhookUrl || '') + '</span></p></div>';
    }
    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const bh = Object.assign({ mon: '9-17', tue: '9-17', wed: '9-17', thu: '9-17', fri: '9-17', sat: 'closed', sun: 'closed' }, s.businessHours || {});
    wrap.innerHTML = head + numberBlock +
      '<div class="toggle-row"><div class="tr-text"><strong>Answer calls</strong><span>' + (s.enabled ? 'Live — Aria picks up' : 'Off') + '</span></div>' +
      '<button class="toggle" role="switch" aria-checked="' + !!s.enabled + '" id="ph-enabled" aria-label="Answer calls"></button></div>' +
      '<div class="field" style="margin-top:var(--sp-3)"><label for="ph-greeting">Greeting</label>' +
      '<input class="input" id="ph-greeting" maxlength="300" value="' + esc(s.firstMessage || '') + '" placeholder="Hi, you’ve reached…"></div>' +
      '<div class="field"><label for="ph-mode">Answer schedule</label><select class="select" id="ph-mode">' +
      ['always', 'business_hours', 'out_of_hours'].map(mo =>
        '<option value="' + mo + '"' + (s.answerMode === mo ? ' selected' : '') + '>' +
        (mo === 'always' ? 'Always answer' : mo === 'business_hours' ? 'Business hours only' : 'Out of hours only (after you close)') + '</option>').join('') +
      '</select></div>' +
      '<div id="ph-sched"' + (s.answerMode === 'always' || !s.answerMode ? ' hidden' : '') + '>' +
      '<div class="hours-grid">' + days.map(d2 => '<label for="ph-' + d2 + '">' + d2 + '</label><input class="input input-sm" id="ph-' + d2 + '" data-ph-day="' + d2 + '" value="' + esc(bh[d2]) + '">').join('') + '</div>' +
      '<div class="form-row"><div class="field"><label for="ph-tz">Timezone</label><input class="input" id="ph-tz" value="' + esc(s.timezone || 'Europe/London') + '"></div>' +
      '<div class="field"><label for="ph-fallback">Fallback transfer number</label><input class="input" id="ph-fallback" value="' + esc(s.fallbackNumber || '') + '" placeholder="+44…"></div></div></div>' +
      '<button class="btn btn-primary" id="ph-save" style="margin-top:var(--sp-2)">' + icon('check', 14) + ' Save phone settings</button>' +
      (calls.length
        ? '<h3 style="margin:var(--sp-5) 0 var(--sp-2)">Recent calls</h3>' + calls.slice(0, 6).map(c2 =>
            '<div class="list-row">' + icon(c2.intent === 'booking' ? 'calendar' : c2.intent === 'complaint' ? 'alert-triangle' : 'phone', 14) +
            '<div class="lr-main"><div class="lr-title">' + esc(c2.intent || 'call') + ' · ' + esc(c2.customerNumber || '') + '</div>' +
            '<div class="lr-sub">' + esc(c2.summary || '') + '</div></div>' +
            (c2.recordingUrl ? '<a class="icon-btn" href="' + esc(c2.recordingUrl) + '" target="_blank" rel="noopener" aria-label="Play recording">' + icon('play', 13) + '</a>' : '') +
            '<span class="lr-sub">' + (c2.durationSec ? Math.round(c2.durationSec) + 's · ' : '') + timeAgo(c2.ts) + '</span></div>').join('')
        : '');

    const onToggle = $('#ph-enabled');
    onToggle.addEventListener('click', () => onToggle.setAttribute('aria-checked', onToggle.getAttribute('aria-checked') !== 'true'));
    $('#ph-mode').addEventListener('change', e => { $('#ph-sched').hidden = e.target.value === 'always'; });
    const provision = $('#ph-provision');
    if (provision) provision.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Provision a phone number?', body: 'This adds a dedicated Aria line to your account.', confirmLabel: 'Get my number' });
      if (!ok) return;
      try { const r = await apiPost('/api/dashboard/phone/provision', {}); toast('Your number: ' + r.number); this.loadPhone(); }
      catch (e) { toast(e.message, 'error'); }
    });
    const release = $('#ph-release');
    if (release) release.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Release this number?', body: 'Callers will no longer reach Aria on it. This can’t be undone.', confirmLabel: 'Release', danger: true });
      if (!ok) return;
      try { await apiPost('/api/dashboard/phone/release', {}); toast('Number released'); this.loadPhone(); }
      catch (e) { toast(e.message, 'error'); }
    });
    const ownConnect = $('#ph-own-connect');
    if (ownConnect) ownConnect.addEventListener('click', async () => {
      const num = $('#ph-own-number').value.trim();
      if (!/^\+?[0-9 ()\-]{7,24}$/.test(num)) { toast('That doesn’t look like a phone number', 'error'); return; }
      try { await apiPost('/api/dashboard/phone/settings', { phoneNumber: num, enabled: true }); toast('Number connected'); this.loadPhone(); }
      catch (e) { toast(e.message, 'error'); }
    });
    $('#ph-save').addEventListener('click', async () => {
      const businessHours = {};
      $$('[data-ph-day]', wrap).forEach(inp => { businessHours[inp.dataset.phDay] = inp.value; });
      const bodyOut = {
        enabled: onToggle.getAttribute('aria-checked') === 'true',
        firstMessage: $('#ph-greeting').value,
        answerMode: $('#ph-mode').value,
      };
      const tzIn = $('#ph-tz'), fbIn = $('#ph-fallback');
      if (tzIn) { bodyOut.businessHours = businessHours; bodyOut.timezone = tzIn.value; bodyOut.fallbackNumber = fbIn.value; }
      try { await apiPost('/api/dashboard/phone/settings', bodyOut); toast('Phone settings saved'); }
      catch (e) { toast(e.message, 'error'); }
    });
  },
};

/* ---------------- 8. BUSINESS (profile + webhooks) ---------------- */
Panels.business = {
  render(root) {
    root.innerHTML =
      panelHeader('business', 'What Aria knows about your business, and where events get sent.', refreshBtn()) +
      '<div class="card-grid">' +
        '<div class="card span-2" id="biz-form">' + skeletonHTML(5) + '</div>' +
        '<div class="card span-2" id="biz-hooks">' + skeletonHTML(3) + '</div>' +
      '</div>';
    wireRefresh(root, 'business');
    this.loadForm();
    this.loadWebhooks();
  },

  loadForm() {
    const card = $('#biz-form');
    getProfile(true).then(p => {
      const f = (id, label, val, ph, type) =>
        '<div class="field"><label for="' + id + '">' + label + '</label>' +
        '<input class="input" id="' + id + '" type="' + (type || 'text') + '" value="' + esc(val || '') + '" placeholder="' + esc(ph || '') + '"></div>';
      card.innerHTML = '<div class="card-title">' + icon('building', 16) + '<h2>Business profile</h2></div>' +
        '<div class="form-row">' + f('bz-name', 'Business name', p.businessName, 'Acme Roofing') + f('bz-location', 'Location', p.location, 'Leeds, UK') + '</div>' +
        '<div class="field"><label for="bz-services">Services (free text)</label><textarea class="textarea" id="bz-services" placeholder="Roof repairs, gutter cleaning…">' + esc(p.services || '') + '</textarea></div>' +
        '<div class="form-row">' + f('bz-phone', 'Phone', p.phone, '+44…', 'tel') + f('bz-email', 'Email', p.email || OWNER, '', 'email') + '</div>' +
        '<div class="form-row">' + f('bz-hours', 'Hours (shown to customers)', p.hours, 'Mon–Fri 9–5') +
        '<div class="field"><label for="bz-tone">Tone</label><select class="select" id="bz-tone">' +
        ['friendly', 'professional', 'casual', 'formal'].map(t => '<option value="' + t + '"' + ((p.tone || 'friendly') === t ? ' selected' : '') + '>' + t[0].toUpperCase() + t.slice(1) + '</option>').join('') +
        '</select></div></div>' +
        '<p class="lr-sub" style="margin-bottom:var(--sp-3)">Structured opening hours (for after-hours behaviour) live in Train Aria → Business hours.</p>' +
        '<button class="btn btn-primary" id="bz-save">' + icon('check', 14) + ' Save profile</button>';
      $('#bz-save').addEventListener('click', async () => {
        try {
          await apiPost('/api/dashboard/profile', {
            businessName: $('#bz-name').value, location: $('#bz-location').value,
            services: $('#bz-services').value, phone: $('#bz-phone').value,
            email: $('#bz-email').value, hours: $('#bz-hours').value, tone: $('#bz-tone').value,
          });
          invalidateProfile();
          toast('Profile saved');
        } catch (e) { toast(e.message, 'error'); }
      });
    }).catch(e => { card.innerHTML = errorStateHTML(e.message); });
  },

  loadWebhooks() {
    const card = $('#biz-hooks');
    const EVENTS = ['new_lead', 'hot_lead', 'new_booking', 'handoff', 'angry_message', 'csat_negative', 'conversation_started'];
    const DEFAULTS = ['new_lead', 'new_booking', 'handoff'];
    loadInto(card, () => api('/api/dashboard/webhooks'), (d, c) => {
      const hooks = (d && d.webhooks) || [];
      const deliveries = (d && d.recentDeliveries) || [];
      let html = '<div class="card-title">' + icon('zap', 16) + '<h2>Webhooks</h2><span class="ct-sub">send Aria events to your other tools</span></div>';
      html += hooks.length ? hooks.map((hk, i) =>
        '<div class="hook-card"><div style="display:flex;align-items:center;gap:8px">' +
        '<strong>' + esc(hk.label || 'Webhook') + '</strong>' +
        '<span class="pill ' + (hk.enabled ? 'accent' : '') + '">' + (hk.enabled ? 'ON' : 'OFF') + '</span>' +
        '<span style="margin-left:auto;display:flex;gap:6px">' +
        '<button class="btn btn-sm" data-hk-test="' + i + '">Test</button>' +
        '<button class="btn btn-ghost btn-sm" data-hk-del="' + i + '">Remove</button></span></div>' +
        '<div class="hook-url">' + esc(hk.url) + '</div>' +
        '<div class="badge-row">' + (hk.events || []).map(ev => '<span class="pill">' + esc(ev) + '</span>').join('') +
        (hk.secretHint ? '<span class="pill violet">secret ' + esc(hk.secretHint) + '</span>' : '') + '</div></div>'
      ).join('') : '<p class="lr-sub" style="margin-bottom:var(--sp-3)">No webhooks yet — add one below to pipe leads into your CRM, Slack, or Zapier.</p>';

      html += '<h3 style="margin:var(--sp-4) 0 var(--sp-2)">Add webhook</h3>' +
        '<div class="form-row"><input class="input" id="hk-label" placeholder="Label, e.g. Slack alerts" maxlength="60">' +
        '<input class="input" id="hk-url" placeholder="https://hooks.example.com/…" inputmode="url"></div>' +
        '<div class="event-checks" style="margin:var(--sp-3) 0">' +
        EVENTS.map(ev => '<label><input type="checkbox" value="' + ev + '"' + (DEFAULTS.includes(ev) ? ' checked' : '') + '> ' + ev + '</label>').join('') + '</div>' +
        '<button class="btn btn-primary" id="hk-add">' + icon('plus', 14) + ' Add webhook</button>';

      if (deliveries.length) {
        html += '<h3 style="margin:var(--sp-5) 0 var(--sp-2)">Recent deliveries</h3>' +
          deliveries.slice(0, 8).map(dl => {
            let host = dl.url || '';
            try { host = new URL(dl.url).host; } catch (e) { /* keep raw */ }
            return '<div class="list-row"><span class="pill ' + (dl.ok ? 'accent' : 'red') + '">' + (dl.status || (dl.ok ? 'ok' : 'fail')) + '</span>' +
              '<div class="lr-main"><div class="lr-title">' + esc(dl.event) + '</div><div class="lr-sub">' + esc(host) + (dl.attempt > 1 ? ' · attempt ' + dl.attempt : '') + '</div></div>' +
              '<span class="lr-sub">' + timeAgo(dl.ts) + '</span></div>';
          }).join('');
      }
      c.innerHTML = html;
      $$('[data-hk-test]', c).forEach(b => b.addEventListener('click', async () => {
        try {
          const r = await apiPost('/api/dashboard/webhooks/' + b.dataset.hkTest + '/test', {});
          toast(r.ok ? 'Delivered (status ' + r.status + ')' : 'Failed: ' + (r.reason || r.error || r.status), r.ok ? 'success' : 'error');
          this.loadWebhooks();
        } catch (e) { toast(e.message, 'error'); }
      }));
      $$('[data-hk-del]', c).forEach(b => b.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: 'Remove webhook?', body: 'Events will stop being delivered to this URL.', confirmLabel: 'Remove', danger: true });
        if (!ok) return;
        try { await apiDelete('/api/dashboard/webhooks/' + b.dataset.hkDel); toast('Removed'); this.loadWebhooks(); }
        catch (e) { toast(e.message, 'error'); }
      }));
      $('#hk-add', c).addEventListener('click', async () => {
        const url = $('#hk-url', c).value.trim();
        if (!/^https?:\/\//.test(url)) { toast('Enter a valid http(s) URL', 'error'); return; }
        const events = $$('.event-checks input:checked', c).map(i => i.value);
        try {
          const r = await apiPost('/api/dashboard/webhooks', { label: $('#hk-label', c).value.trim() || 'Webhook', url: url, events: events });
          toast('Added — secret starts ' + String(r.secret || '').slice(0, 12) + '… (shown once, save it now)', 'info');
          this.loadWebhooks();
        } catch (e) { toast(e.message, 'error'); }
      });
    }, { emptyTitle: 'Webhooks unavailable', emptySub: '' });
  },
};

/* ---------------- 9. SETTINGS ---------------- */
Panels.settings = {
  render(root) {
    root.innerHTML =
      panelHeader('settings', 'How Aria behaves, notifies you, and asks for reviews.', refreshBtn()) +
      '<div class="card-grid">' +
        '<div class="card" id="set-email">' + skeletonHTML(3) + '</div>' +
        '<div class="card" id="set-outbound">' + skeletonHTML(3) + '</div>' +
        '<div class="card" id="set-digest">' + skeletonHTML(3) + '</div>' +
        '<div class="card" id="set-reviews">' + skeletonHTML(3) + '</div>' +
        '<div class="card" id="set-password">' + skeletonHTML(2) + '</div>' +
        '<div class="card danger-zone" id="set-danger">' + skeletonHTML(2) + '</div>' +
      '</div>';
    wireRefresh(root, 'settings');
    this.loadEmailToggles();
    this.loadOutbound();
    this.loadDigest();
    this.loadReviews();
    this.renderPassword();
    this.renderDanger();
  },

  toggleRow(id, title, sub, checked) {
    return '<div class="toggle-row"><div class="tr-text"><strong>' + esc(title) + '</strong><span>' + esc(sub) + '</span></div>' +
      '<button class="toggle" role="switch" aria-checked="' + !!checked + '" id="' + id + '" aria-label="' + esc(title) + '"></button></div>';
  },
  wireToggle(id, save) {
    const t = $('#' + id);
    t.addEventListener('click', async () => {
      const next = t.getAttribute('aria-checked') !== 'true';
      t.setAttribute('aria-checked', String(next));
      try { await save(next); toast('Saved'); }
      catch (e) { t.setAttribute('aria-checked', String(!next)); toast(e.message, 'error'); }
    });
  },

  loadEmailToggles() {
    const card = $('#set-email');
    loadInto(card, () => api('/api/dashboard/settings'), (s, c) => {
      c.innerHTML = '<div class="card-title">' + icon('mail', 16) + '<h2>Email auto-reply</h2>' +
        '<span class="ct-sub">' + (s.gmailConnected ? 'Gmail connected' : 'Gmail not connected') + '</span></div>' +
        this.toggleRow('tg-autoreply', 'Auto-reply', 'Aria answers incoming email for you', s.autoReplyEnabled) +
        this.toggleRow('tg-approval', 'Approval mode', 'Review drafts before they send', s.approvalMode) +
        this.toggleRow('tg-followups', 'Follow-ups', 'Aria chases unanswered threads', s.followUpsEnabled !== false) +
        '<a class="btn btn-ghost btn-sm" style="margin-top:var(--sp-3)" href="/connect/gmail?owner=' + encodeURIComponent(OWNER) + '&s=' + encodeURIComponent(TOKEN) + '">' + icon('external', 13) + ' Gmail settings</a>';
      this.wireToggle('tg-autoreply', v => apiPost('/api/dashboard/settings', { autoReplyEnabled: v }));
      this.wireToggle('tg-approval', v => apiPost('/api/dashboard/settings', { approvalMode: v }));
      this.wireToggle('tg-followups', v => apiPost('/api/dashboard/settings', { followUpsEnabled: v }));
    });
  },

  loadOutbound() {
    const card = $('#set-outbound');
    getProfile().then(p => {
      const ob = p.outbound || {};
      const val = k => ob[k] !== false; // defaults ON
      card.innerHTML = '<div class="card-title">' + icon('send', 16) + '<h2>Outbound nudges</h2></div>' +
        this.toggleRow('tg-ob-lead', 'Lead follow-up', 'Email warm leads who went quiet', val('leadFollowup')) +
        this.toggleRow('tg-ob-booking', 'Booking reminders', 'Remind customers before appointments', val('bookingReminder')) +
        this.toggleRow('tg-ob-recovery', 'Conversation recovery', 'Re-engage dropped conversations', val('convRecovery'));
      const save = (key) => async (v) => {
        const profile = await getProfile();
        const outbound = Object.assign({}, profile.outbound || {});
        outbound[key] = v;
        await apiPost('/api/dashboard/profile', { outbound: outbound });
        invalidateProfile();
      };
      this.wireToggle('tg-ob-lead', save('leadFollowup'));
      this.wireToggle('tg-ob-booking', save('bookingReminder'));
      this.wireToggle('tg-ob-recovery', save('convRecovery'));
    }).catch(e => { card.innerHTML = errorStateHTML(e.message); });
  },

  loadDigest() {
    const card = $('#set-digest');
    loadInto(card, () => api('/api/dashboard/notifications/settings'), (d, c) => {
      const s = d.settings || {};
      c.innerHTML = '<div class="card-title">' + icon('bell', 16) + '<h2>Daily digest</h2>' +
        '<span class="ct-sub">' + fmtNum(d.queuedToday) + ' queued today' + (d.lastDigestSent ? ' · last sent ' + timeAgo(d.lastDigestSent) : '') + '</span></div>' +
        this.toggleRow('tg-digest', 'Send a daily digest', 'One summary email instead of a ping per event. Urgent events still alert immediately.', s.enabled) +
        '<div class="form-row" style="margin-top:var(--sp-3)">' +
        '<div class="field"><label for="dg-time">Send time</label><input class="input" id="dg-time" type="time" value="' + esc(s.sendTime || '17:00') + '"></div>' +
        '<div class="field"><label for="dg-tz">Timezone</label><input class="input" id="dg-tz" value="' + esc(s.timezone || 'Europe/London') + '"></div></div>' +
        '<button class="btn btn-primary" id="dg-save">' + icon('check', 14) + ' Save digest</button>';
      this.wireToggle('tg-digest', v => apiPost('/api/dashboard/notifications/settings', { enabled: v, sendTime: $('#dg-time').value || '17:00', timezone: $('#dg-tz').value }));
      $('#dg-save').addEventListener('click', async () => {
        try {
          await apiPost('/api/dashboard/notifications/settings', {
            enabled: $('#tg-digest').getAttribute('aria-checked') === 'true',
            sendTime: $('#dg-time').value || '17:00',
            timezone: $('#dg-tz').value,
          });
          toast('Digest saved');
        } catch (e) { toast(e.message, 'error'); }
      });
    });
  },

  loadReviews() {
    const card = $('#set-reviews');
    loadInto(card, () => api('/api/dashboard/reviews/settings'), (d, c) => {
      const s = d.settings || {};
      const status = !s.url ? ['Not configured', ''] : s.enabled ? ['Active', 'accent'] : ['Disabled', 'amber'];
      c.innerHTML = '<div class="card-title">' + icon('star', 16) + '<h2>Review requests</h2>' +
        '<span class="ct-sub"><span class="pill ' + status[1] + '">' + status[0] + '</span></span></div>' +
        this.toggleRow('tg-reviews', 'Ask for reviews', 'After a booking, Aria asks happy customers for a Google review', s.enabled !== false) +
        '<div class="field" style="margin-top:var(--sp-3)"><label for="rv-url">Google review URL</label>' +
        '<input class="input" id="rv-url" inputmode="url" value="' + esc(s.url || '') + '" placeholder="https://g.page/r/…">' +
        '<span class="lr-sub">Generate yours free at whitespark.ca/google-review-link-generator</span></div>' +
        '<div class="form-row"><div class="field"><label for="rv-delay">Delay after booking</label><select class="select" id="rv-delay">' +
        [[2, '2 hours'], [24, '1 day'], [48, '2 days'], [72, '3 days'], [168, '7 days']].map(([h, lab]) =>
          '<option value="' + h + '"' + ((s.delayHours || 24) === h ? ' selected' : '') + '>' + lab + '</option>').join('') +
        '</select></div>' +
        '<div class="field"><label style="margin-top:22px;display:flex;gap:8px;align-items:center;cursor:pointer"><input type="checkbox" id="rv-email"' + (s.alwaysEmail ? ' checked' : '') + ' style="accent-color:var(--accent)"> Also send by email</label></div></div>' +
        '<div class="field"><label for="rv-template">Message template</label>' +
        '<textarea class="textarea" id="rv-template" maxlength="800" placeholder="' + esc(d.defaultTemplate || '') + '">' + esc(s.template || '') + '</textarea>' +
        '<span class="lr-sub">Placeholders: {customer} {business} {service} {url}</span></div>' +
        '<div style="display:flex;gap:var(--sp-2)"><button class="btn btn-primary" id="rv-save">' + icon('check', 14) + ' Save</button>' +
        '<button class="btn" id="rv-preview">' + icon('eye', 14) + ' Preview</button></div>' +
        '<div id="rv-preview-out" style="margin-top:var(--sp-3)"></div>' +
        ((d.recent || []).length
          ? '<h3 style="margin:var(--sp-4) 0 var(--sp-2)">Recent requests</h3>' + (d.recent || []).slice(0, 6).map(rr =>
              '<div class="list-row"><span class="pill ' + (rr.status === 'sent' ? 'accent' : '') + '">' + esc(rr.status || 'sent') + '</span>' +
              '<div class="lr-main"><div class="lr-sub">' + esc(rr.customer || rr.senderId || '') + '</div></div>' +
              '<span class="lr-sub">' + timeAgo(rr.ts) + '</span></div>').join('')
          : '');
      const save = () => apiPost('/api/dashboard/reviews/settings', {
        enabled: $('#tg-reviews').getAttribute('aria-checked') === 'true',
        url: $('#rv-url').value.trim(),
        delayHours: Number($('#rv-delay').value),
        template: $('#rv-template').value,
        alwaysEmail: $('#rv-email').checked,
      });
      this.wireToggle('tg-reviews', save);
      $('#rv-save').addEventListener('click', async () => {
        try { await save(); toast('Review settings saved'); } catch (e) { toast(e.message, 'error'); }
      });
      $('#rv-preview').addEventListener('click', async () => {
        try {
          const r = await apiPost('/api/dashboard/reviews/test', { customer: 'Sarah', service: 'haircut' });
          $('#rv-preview-out').innerHTML = '<div class="bubble us" style="max-width:100%">' + esc(r.preview || '') + '</div>' +
            (!r.ready ? '<p class="lr-sub" style="color:var(--amber)">Add your review URL to go live.</p>' : '');
        } catch (e) { toast(e.message, 'error'); }
      });
    });
  },

  renderPassword() {
    const card = $('#set-password');
    card.innerHTML = '<div class="card-title">' + icon('key', 16) + '<h2>Password</h2></div>' +
      '<div class="field"><label for="pw-current">Current password</label><input class="input" id="pw-current" type="password" autocomplete="current-password"></div>' +
      '<div class="field"><label for="pw-new">New password (min 8 chars)</label><input class="input" id="pw-new" type="password" autocomplete="new-password" minlength="8"></div>' +
      '<div class="field"><label for="pw-confirm">Confirm new password</label><input class="input" id="pw-confirm" type="password" autocomplete="new-password"></div>' +
      '<button class="btn btn-primary" id="pw-save">' + icon('check', 14) + ' Change password</button>';
    $('#pw-save').addEventListener('click', async () => {
      const cur = $('#pw-current').value, nw = $('#pw-new').value, cf = $('#pw-confirm').value;
      if (nw.length < 8) { toast('New password must be at least 8 characters', 'error'); return; }
      if (nw !== cf) { toast('Passwords don’t match', 'error'); return; }
      try {
        await apiPost('/api/dashboard/reset-password', { currentPassword: cur, newPassword: nw });
        toast('Password changed');
        $('#pw-current').value = $('#pw-new').value = $('#pw-confirm').value = '';
      } catch (e) { toast(e.message, 'error'); }
    });
  },

  renderDanger() {
    const card = $('#set-danger');
    card.innerHTML = '<div class="card-title">' + icon('alert-triangle', 16) + '<h2>Danger zone</h2></div>' +
      '<div class="toggle-row"><div class="tr-text"><strong>Disconnect all channels</strong><span>Aria stops replying everywhere until you reconnect.</span></div>' +
      '<button class="btn btn-danger btn-sm" id="dz-disconnect">Disconnect</button></div>' +
      '<div class="toggle-row"><div class="tr-text"><strong>Delete all knowledge</strong><span>Removes every knowledge document Aria has learned.</span></div>' +
      '<button class="btn btn-danger btn-sm" id="dz-wipe-kb">Delete</button></div>';
    $('#dz-disconnect').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Disconnect every channel?',
        body: 'Messenger, Instagram and WhatsApp will all be disconnected. You can reconnect them from Channels later.',
        confirmLabel: 'Disconnect all', danger: true, typedPhrase: 'DISCONNECT',
      });
      if (!ok) return;
      try {
        const cs = await api('/api/dashboard/channel-stats');
        const keys = Object.keys((cs && cs.channels) || {});
        for (const k of keys) await apiPost('/api/dashboard/channel-disconnect', { channel: k });
        toast(keys.length ? 'Disconnected ' + keys.length + ' channel' + (keys.length > 1 ? 's' : '') : 'No channels were connected', 'info');
      } catch (e) { toast(e.message, 'error'); }
    });
    $('#dz-wipe-kb').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Delete ALL knowledge documents?',
        body: 'Aria forgets everything you’ve taught her. This cannot be undone.',
        confirmLabel: 'Delete everything', danger: true, typedPhrase: 'DELETE',
      });
      if (!ok) return;
      try {
        const d = await api('/api/dashboard/knowledge');
        const n = ((d && d.docs) || []).length;
        for (let i = n - 1; i >= 0; i--) await apiDelete('/api/dashboard/knowledge/' + i);
        toast(n ? 'Deleted ' + n + ' documents' : 'No documents to delete', 'info');
      } catch (e) { toast(e.message, 'error'); }
    });
  },
};
