// value_report.js
//
// The monthly "Aria paid for itself" report — the cheapest churn-killer at
// this price point. Once a month every owner gets a plain-language receipt:
// "Aria handled N chats, captured M leads, booked K jobs ≈ £X". Renewal
// decisions are emotional; a concrete revenue number beats any feature list.
//
// Pure function — no I/O, no server internals, no Claude calls, deterministic
// given inputs. The server passes in already-loaded arrays (leads, channel
// leads, bookings, channel messages); this module only filters to the window,
// counts, and applies a documented £-value model. Same fn used by:
//   - GET /api/dashboard/value-report (dashboard headline card)
//   - the monthly outbound_scheduler task (emails renderValueReportHtml)
//
// Any time-dependent behaviour takes a `now` (epoch ms) arg defaulting to
// Date.now() so tests can pin the window deterministically.

// ─── Value model ────────────────────────────────────────────────────────────
// Conservative back-of-envelope, deliberately defensible to a sceptical owner.
// We frame value as POTENTIAL pipeline Aria surfaced, not booked revenue, so
// the number never over-promises. Assumptions (overridable per-call):
//
//   perBooking  £120 — a confirmed booking is the strongest signal; valued at a
//                      modest UK-trade/salon average job. Bookings are the
//                      highest-confidence outcome so they get the full figure.
//   perHotLead   £60 — a hot lead (score ≥ 70 / leadScore 'hot') that did NOT
//                      convert to a booking. Worth roughly job-avg × close-rate.
//   perWarmLead  £15 — a warm/captured lead (score 40–69 / leadScore 'warm').
//                      Lower close probability, so ~1/4 of a hot lead.
//
// Bookings and leads are counted on SEPARATE axes, so a hot lead that also
// booked is NOT double-counted: every booking contributes perBooking, and only
// leads beyond the booking count contribute lead value (see buildValueReport).
export const DEFAULT_VALUE_MODEL = Object.freeze({
  perBooking: 120,
  perHotLead: 60,
  perWarmLead: 15,
});

const DAY_MS = 24 * 60 * 60 * 1000;

// Robust timestamp parse → epoch ms, or NaN. Accepts ISO strings (leads.jsonl,
// channel_leads.jsonl, channel-messages timestamp) and numeric epochs.
function toMs(ts) {
  if (ts == null) return NaN;
  if (typeof ts === 'number') return ts;
  const n = new Date(ts).getTime();
  return Number.isNaN(n) ? NaN : n;
}

// Is `ts` within the trailing window [now - windowDays, now]? Items with an
// unparseable/missing timestamp are EXCLUDED (we never inflate the count with
// rows we can't date).
function inWindow(ts, cutoff, now) {
  const t = toMs(ts);
  if (Number.isNaN(t)) return false;
  return t >= cutoff && t <= now;
}

// Classify a single lead row into 'hot' | 'warm' | null (not a real lead).
// Handles both data shapes:
//   leads.jsonl         → numeric qualification_score (hot ≥ 70, warm ≥ 40)
//   channel_leads.jsonl → leadScore string 'hot' | 'warm' | 'cold'
function classifyLead(row) {
  if (!row || typeof row !== 'object') return null;
  const score = row.qualification_score;
  if (typeof score === 'number') {
    if (score >= 70) return 'hot';
    if (score >= 40) return 'warm';
    return null; // cold / below capture threshold → not counted as a lead
  }
  const tag = String(row.leadScore || '').toLowerCase();
  if (tag === 'hot') return 'hot';
  if (tag === 'warm') return 'warm';
  return null; // cold or unknown → not counted
}

// Build the monthly value report from already-loaded plain arrays.
//
//   leads        — rows from data/leads.jsonl       { ts, qualification_score, ... }
//   channelLeads — rows from data/channel_leads.jsonl { ts, leadScore, ... }
//   bookings     — rows from data/bookings.json     { ts | datetime, ... }
//   messages     — channel messages for this owner  { timestamp, ... }  (chats handled)
//   windowDays   — trailing window length (default 30)
//   now          — epoch ms "as of" (default Date.now()) — pin in tests
//   valueModel   — override any of perBooking / perHotLead / perWarmLead
//
// Returns:
//   { periodLabel, windowDays, chatsHandled, leadsCaptured, hotLeads,
//     bookingsCount, estValueGBP, breakdown:{ ... } }
export function buildValueReport({
  leads = [],
  channelLeads = [],
  bookings = [],
  messages = [],
  windowDays = 30,
  now = Date.now(),
  valueModel = {},
} = {}) {
  const days = Number(windowDays) > 0 ? Number(windowDays) : 30;
  const cutoff = now - days * DAY_MS;
  const model = { ...DEFAULT_VALUE_MODEL, ...(valueModel || {}) };

  // Chats handled = channel messages Aria responded to within the window.
  // We count an item as a handled chat regardless of reply content; the
  // timestamp is the only gate. (Web-widget chats live in a different store
  // and are reported elsewhere — this number is the channel inbox volume.)
  const chatsHandled = (Array.isArray(messages) ? messages : [])
    .filter(m => inWindow(m && (m.timestamp ?? m.ts), cutoff, now)).length;

  // Leads — unify both sources, classify, count hot vs warm within the window.
  let hotLeads = 0;
  let warmLeads = 0;
  const allLeadRows = [
    ...(Array.isArray(leads) ? leads : []),
    ...(Array.isArray(channelLeads) ? channelLeads : []),
  ];
  for (const row of allLeadRows) {
    if (!inWindow(row && row.ts, cutoff, now)) continue;
    const cls = classifyLead(row);
    if (cls === 'hot') hotLeads++;
    else if (cls === 'warm') warmLeads++;
  }
  const leadsCaptured = hotLeads + warmLeads;

  // Bookings — accept `ts` or `datetime` as the timestamp field.
  const bookingsCount = (Array.isArray(bookings) ? bookings : [])
    .filter(b => inWindow(b && (b.ts ?? b.datetime), cutoff, now)).length;

  // Value math. Bookings are the highest-confidence outcome and always count
  // at full perBooking. To avoid double-counting a hot lead that also booked,
  // we credit lead value only for leads BEYOND the booking count — bookings
  // consume hot leads first (most likely to be the ones that booked), then warm.
  const bookingValue = bookingsCount * model.perBooking;
  let creditableHot = hotLeads;
  let creditableWarm = warmLeads;
  let consume = bookingsCount;
  const hotConsumed = Math.min(creditableHot, consume);
  creditableHot -= hotConsumed;
  consume -= hotConsumed;
  const warmConsumed = Math.min(creditableWarm, consume);
  creditableWarm -= warmConsumed;

  const hotLeadValue = creditableHot * model.perHotLead;
  const warmLeadValue = creditableWarm * model.perWarmLead;
  const estValueGBP = Math.round(bookingValue + hotLeadValue + warmLeadValue);

  return {
    periodLabel: periodLabelFor(now, days),
    windowDays: days,
    chatsHandled,
    leadsCaptured,
    hotLeads,
    bookingsCount,
    estValueGBP,
    breakdown: {
      warmLeads,
      // value contributions (rounded individually for display transparency)
      bookingValueGBP: Math.round(bookingValue),
      hotLeadValueGBP: Math.round(hotLeadValue),
      warmLeadValueGBP: Math.round(warmLeadValue),
      // how the de-dup played out, so the email/card can be honest
      hotLeadsCreditedAsLead: creditableHot,
      warmLeadsCreditedAsLead: creditableWarm,
      leadsAttributedToBookings: hotConsumed + warmConsumed,
      valueModel: model,
    },
  };
}

// Human label for the window, e.g. "Last 30 days · to 15 Jun 2026". Kept here
// (not in the email renderer) so the dashboard card and the email agree.
function periodLabelFor(now, days) {
  let to = '';
  try {
    to = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London',
    }).format(new Date(now));
  } catch { to = new Date(now).toISOString().slice(0, 10); }
  return `Last ${days} days · to ${to}`;
}

// Singular/plural helper — "1 chat" vs "2 chats".
function plural(n, one, many) {
  return `${n} ${n === 1 ? one : (many || one + 's')}`;
}

// Render the ROI email. Plain inline-styled HTML, no client-side JS — same
// house style as renderWeeklyDigestHtml in analytics.js. Gracefully handles
// the empty month (all zeros) with an encouraging, non-alarming message.
export function renderValueReportHtml(report, { businessName } = {}) {
  const r = report || {};
  const name = (businessName && String(businessName).trim()) || 'your business';
  const chats = r.chatsHandled || 0;
  const leads = r.leadsCaptured || 0;
  const hot = r.hotLeads || 0;
  const bookings = r.bookingsCount || 0;
  const value = r.estValueGBP || 0;
  const period = r.periodLabel || `Last ${r.windowDays || 30} days`;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // headline is inserted through esc() at the <h2>, so build it with the raw
  // name here (escaping once at the insertion point avoids double-encoding).
  const headline = value > 0
    ? `Aria found you ~£${value} of potential business`
    : `Aria is on the clock for ${name}`;

  const subline = (chats + leads + bookings) === 0
    ? `No customer messages reached Aria ${period.toLowerCase()} — she's ready and waiting. The moment a customer asks, she replies, captures the lead, and tells you.`
    : `Here's what Aria handled for ${esc(name)} — ${plural(chats, 'chat')}, ${plural(leads, 'lead')} captured${bookings ? `, ${plural(bookings, 'job', 'jobs')} booked` : ''}.`;

  const stat = (num, label, color) => `
      <td style="padding:14px 12px;background:#fff;border-radius:8px;border:1px solid #eee;text-align:center;">
        <div style="font-size:30px;font-weight:700;color:${color};line-height:1;">${num}</div>
        <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.04em;margin-top:6px;">${label}</div>
      </td>`;

  const bd = r.breakdown || {};
  const bm = bd.valueModel || DEFAULT_VALUE_MODEL;
  // Only show the value-math line when there's actually value to explain.
  const mathLine = value > 0 ? `
  <p style="color:#777;font-size:12px;margin:0 0 24px;line-height:1.6;">
    How we estimate this: each booked job ≈ £${bm.perBooking}, each hot lead ≈ £${bm.perHotLead},
    each warm lead ≈ £${bm.perWarmLead}. A conservative read of the pipeline Aria put in front of you —
    not a guarantee, just what these enquiries are typically worth.
  </p>` : '';

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#fafafa;color:#222;">
  <h2 style="margin:0 0 4px;color:#111;font-size:21px;">${esc(headline)}</h2>
  <p style="color:#666;margin:0 0 8px;font-size:12px;">${esc(period)}</p>
  <p style="color:#444;margin:0 0 24px;font-size:14px;line-height:1.6;">${subline}</p>

  <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:8px 0;margin:0 0 20px;">
    <tr>
      ${stat(chats, 'Chats handled', '#111')}
      ${stat(leads, 'Leads captured', '#0d9488')}
      ${stat(hot, 'Hot leads', '#d97706')}
      ${stat(bookings, 'Jobs booked', '#7c3aed')}
    </tr>
  </table>
${mathLine}
  <p style="color:#666;font-size:12px;margin:24px 0 0;padding-top:16px;border-top:1px solid #eee;line-height:1.6;">
    These numbers come from real conversations Aria had with your customers ${esc(period.toLowerCase())}.
    <br><br>
    Want anything tuned? Just reply to this email.<br>
    — Kyle
  </p>
</div>`;
}
