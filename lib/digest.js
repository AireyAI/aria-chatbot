// digest.js
//
// Notification digest mode — pure helpers. Owners with high inbound
// volume can opt to batch informational alerts (new lead, booking
// confirmed, review sent, conv recovery, cancellation, etc) into a
// single daily digest email delivered at their local sendTime.
//
// Action-required alerts (handoff, no-show predicted, quote awaiting
// approval, angry message, channel approval) always fire immediately
// regardless of digest mode — customer is waiting on a real-time
// decision and a 5pm summary would mean missing the moment.
//
// This module exposes:
//   - shouldFireDigest(cfg, ownerNow) — is "now" inside the owner's
//     local sendTime minute? Used by the tick loop.
//   - renderDigestHtml(entries, businessName) — formats buffered
//     entries into a single email body grouped by event type.
//   - canBatch(eventType) — central whitelist of safely-batchable
//     event types. Used by notify() to decide path.

// Events safe to batch — informational, no immediate human action
// needed. Anything not in this set goes immediate by default.
const BATCHABLE_EVENTS = new Set([
  'new_lead',
  'new_booking',
  'booking_cancelled_ack',  // informational ack to owner — actual cancel email separately
  'booking_conflict_blocked',
  'review_sent',
  'conv_recovery_sent',
  'csat_positive',
  'service_carousel_sent',
]);

export function canBatch(eventType) {
  return BATCHABLE_EVENTS.has(eventType);
}

// Project "now" into the owner's local hour:minute.
// Returns { hh, mm } in 24h.
function localHourMinute(timezone = 'Europe/London', ts = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour: 'numeric', minute: 'numeric', hour12: false,
    });
    const parts = fmt.formatToParts(ts);
    return {
      hh: Number(parts.find(p => p.type === 'hour')?.value || 0),
      mm: Number(parts.find(p => p.type === 'minute')?.value || 0),
    };
  } catch {
    return { hh: ts.getUTCHours(), mm: ts.getUTCMinutes() };
  }
}

// Parse "17:00" or "17" or "5pm" → {hh, mm}. Returns null on invalid.
export function parseSendTime(s) {
  if (!s) return { hh: 17, mm: 0 };
  const m = String(s).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = Number(m[2] || 0);
  const ampm = m[3]?.toLowerCase();
  if (ampm === 'pm' && hh < 12) hh += 12;
  if (ampm === 'am' && hh === 12) hh = 0;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { hh, mm };
}

// Is the owner's local time within the same minute as sendTime?
// Tick loop runs every minute, so single-minute window means each owner
// fires exactly once per day (idempotency handled by the caller's
// "last sent date" check).
export function shouldFireDigest(cfg, ts = new Date()) {
  if (!cfg?.enabled) return false;
  const send = parseSendTime(cfg.sendTime || '17:00');
  if (!send) return false;
  const local = localHourMinute(cfg.timezone || 'Europe/London', ts);
  return local.hh === send.hh && local.mm === send.mm;
}

// Group buffered entries by event type for rendering. Keeps insertion
// order within each group.
function groupByType(entries) {
  const groups = new Map();
  for (const e of entries) {
    const arr = groups.get(e.type) || [];
    arr.push(e);
    groups.set(e.type, arr);
  }
  return groups;
}

const TYPE_LABELS = {
  new_lead:                 { icon: '🎯', label: 'New leads' },
  new_booking:              { icon: '📅', label: 'New bookings' },
  booking_cancelled_ack:    { icon: '❌', label: 'Cancellations' },
  booking_conflict_blocked: { icon: '⚠️',  label: 'Booking conflicts averted' },
  review_sent:              { icon: '⭐', label: 'Review requests sent' },
  conv_recovery_sent:       { icon: '💬', label: 'Conversation recoveries' },
  csat_positive:            { icon: '👍', label: 'Positive feedback' },
  service_carousel_sent:    { icon: '🛍', label: 'Services carousels sent' },
};

export function renderDigestHtml(entries, businessName = 'your business', dateLabel) {
  if (!entries || entries.length === 0) return null;
  const groups = groupByType(entries);
  const dateStr = dateLabel || new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });

  let sections = '';
  for (const [type, items] of groups) {
    const meta = TYPE_LABELS[type] || { icon: '·', label: type.replace(/_/g, ' ') };
    const rows = items.slice(0, 50).map(e =>
      `<tr><td style="padding:6px 10px;border-bottom:1px solid #f0f0f5;font-size:13px;color:#444;">${e.summary || '—'}</td>
         <td style="padding:6px 10px;border-bottom:1px solid #f0f0f5;font-size:11.5px;color:#888;white-space:nowrap;text-align:right;">${formatTimeShort(e.ts)}</td></tr>`
    ).join('');
    const moreLabel = items.length > 50 ? `<div style="font-size:11.5px;color:#888;padding:6px 10px;">…and ${items.length - 50} more</div>` : '';
    sections += `
      <div style="background:#fff;border:1px solid #eaeaf0;border-radius:10px;margin-bottom:14px;overflow:hidden;">
        <div style="background:#f6f6fb;padding:10px 14px;font-size:12px;font-weight:600;color:#1a1a2e;">
          ${meta.icon} ${meta.label} <span style="color:#888;font-weight:400;">(${items.length})</span>
        </div>
        <table style="width:100%;border-collapse:collapse;">${rows}</table>
        ${moreLabel}
      </div>`;
  }

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#f8f8fc;">
    <div style="background:#0d0d1f;color:#fff;padding:18px;border-radius:12px;margin-bottom:18px;">
      <h2 style="margin:0 0 4px;color:#00e5a0;font-size:18px;">Aria's daily digest</h2>
      <p style="margin:0;color:#9898b8;font-size:12.5px;">${dateStr} · ${businessName} · ${entries.length} event${entries.length === 1 ? '' : 's'}</p>
    </div>
    ${sections}
    <p style="margin:18px 0 0;font-size:11px;color:#aaa;text-align:center;">Sent because you enabled digest mode in Settings. Action-required alerts (handoffs, no-shows, quote approvals, angry messages) still fire immediately.</p>
  </div>`;
}

function formatTimeShort(ts) {
  try {
    return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}
