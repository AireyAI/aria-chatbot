// Per-client funnel analytics — single append-only JSONL, derived rollups.
//
// Why one global file instead of per-slug: append-only writes from many
// clients are cheap; reads happen on a cron (weekly digest) or admin pull,
// not on the hot path. Single file = single fsync, single rotation strategy,
// trivially shipped to BigQuery later if we outgrow filesystem analytics.
//
// Event schema:
//   { ts, slug, event, sessionId?, ownerEmail?, data? }
//
// Event vocabulary (canonical — keep this list in sync with consumers):
//   preview_viewed   — /preview/:token rendered for a prospect
//   widget_loaded    — chatbot.js initialised on a live client site
//   chat_opened      — visitor opened the widget panel
//   chat_message     — round-trip exchange via /api/chat or /api/chat/router
//   lead_captured    — qualify_lead returned score >= 40
//   lead_hot         — score >= 70 (subset of lead_captured)
//   owner_notified   — WhatsApp or email ping fired
//   booking_created  — calendar slot booked
//   after_hours      — chat exchange outside the client's business hours

import { promises as fsp } from 'node:fs';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

const EVENTS_PATH = resolve('data', 'aria_events.jsonl');

function _ensureDir() {
  const dir = resolve('data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// Fire-and-forget. Writing analytics MUST NOT block or break a chat request.
// Errors are logged but never propagate. Single-instance Railway deploy means
// append-on-write is atomic enough; if we ever go multi-node, swap for an
// SQS/Kinesis writer here without changing call sites.
export function recordEvent({ slug, event, sessionId, ownerEmail, data }) {
  if (!slug || !event) return;
  const entry = {
    ts: new Date().toISOString(),
    slug,
    event,
    ...(sessionId   ? { sessionId } : {}),
    ...(ownerEmail  ? { ownerEmail } : {}),
    ...(data        ? { data } : {}),
  };
  _ensureDir();
  fsp.appendFile(EVENTS_PATH, JSON.stringify(entry) + '\n').catch(e => {
    console.warn('[analytics] write failed:', e.message);
  });
}

// Synchronous read for cron + admin. Loads the file once and projects events
// into per-slug counts within the window. O(n) over events; fine until we
// have >1M events at which point we'd rotate or move to a DB.
export function rollupForWindow({ windowMs, sinceTs } = {}) {
  if (!existsSync(EVENTS_PATH)) return { events: 0, slugs: {} };
  const cutoff = sinceTs
    ? new Date(sinceTs).getTime()
    : Date.now() - (windowMs || 7 * 24 * 60 * 60 * 1000);

  const raw = readFileSync(EVENTS_PATH, 'utf8');
  const slugs = {};
  let total = 0;

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const t = new Date(ev.ts).getTime();
    if (Number.isNaN(t) || t < cutoff) continue;
    total++;
    const slug = ev.slug;
    if (!slugs[slug]) slugs[slug] = {
      slug,
      ownerEmail: ev.ownerEmail || null,
      counts: {},
      sampleHotLeads: [],
      firstEventTs: ev.ts,
      lastEventTs: ev.ts,
    };
    const row = slugs[slug];
    row.counts[ev.event] = (row.counts[ev.event] || 0) + 1;
    if (ev.ownerEmail) row.ownerEmail = ev.ownerEmail; // most recent wins
    if (ev.ts > row.lastEventTs) row.lastEventTs = ev.ts;
    if (ev.event === 'lead_hot' && row.sampleHotLeads.length < 5) {
      row.sampleHotLeads.push({
        ts: ev.ts,
        sessionId: ev.sessionId || null,
        summary: ev.data?.summary || null,
        score: ev.data?.score || null,
      });
    }
  }
  return { events: total, slugs };
}

// Estimated value — conservative back-of-envelope, used in the weekly digest
// to give the owner a "this is what Aria did for you" number. Tuned to UK
// trades pricing where a single lead is worth ~£300 (job avg) × 25% close
// rate = £75 expected value. Owners can override per-niche if we add config.
const ESTIMATED_VALUE_PER_LEAD_GBP = {
  trades: 75, salon: 40, restaurant: 25, gym: 50, clinic: 90,
  agency: 200, ecommerce: 30, law: 250, generic: 50,
};

export function estimateLeadValue(businessType, hotLeadCount, warmLeadCount = 0) {
  const perLead = ESTIMATED_VALUE_PER_LEAD_GBP[businessType] || ESTIMATED_VALUE_PER_LEAD_GBP.generic;
  // Hot leads = full value; warm = 1/3 (lower close probability)
  return Math.round(hotLeadCount * perLead + warmLeadCount * (perLead / 3));
}

// Format a weekly digest body for owner email — plain HTML, no client-side JS.
export function renderWeeklyDigestHtml({ slug, businessType, weekStart, weekEnd, row }) {
  const c = row.counts || {};
  const chats = c.chat_message || 0;
  const hot = c.lead_hot || 0;
  const warm = (c.lead_captured || 0) - hot;
  const afterHours = c.after_hours || 0;
  const notified = c.owner_notified || 0;
  const bookings = c.booking_created || 0;
  const value = estimateLeadValue(businessType, hot, warm);

  const sampleRows = (row.sampleHotLeads || []).slice(0, 3).map(s =>
    `<li style="margin:8px 0;color:#444;"><b>£${ESTIMATED_VALUE_PER_LEAD_GBP[businessType] || 50}+ likely</b> · score ${s.score || '?'} · ${(s.summary || 'no summary').slice(0, 120)}</li>`
  ).join('') || '<li style="color:#888;">No hot leads this week — Aria is still learning your customer questions.</li>';

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#fafafa;color:#222;">
  <h2 style="margin:0 0 4px;color:#111;">Aria found you ~£${value} of potential revenue this week</h2>
  <p style="color:#666;margin:0 0 24px;font-size:13px;">${weekStart} → ${weekEnd}</p>

  <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 24px;">
    <tr>
      <td style="padding:12px 16px;background:#fff;border-radius:8px;border:1px solid #eee;text-align:center;width:25%;">
        <div style="font-size:28px;font-weight:700;color:#111;">${chats}</div>
        <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.04em;">Chats</div>
      </td>
      <td style="width:8px;"></td>
      <td style="padding:12px 16px;background:#fff;border-radius:8px;border:1px solid #eee;text-align:center;width:25%;">
        <div style="font-size:28px;font-weight:700;color:#d97706;">${hot}</div>
        <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.04em;">Hot leads</div>
      </td>
      <td style="width:8px;"></td>
      <td style="padding:12px 16px;background:#fff;border-radius:8px;border:1px solid #eee;text-align:center;width:25%;">
        <div style="font-size:28px;font-weight:700;color:#0d9488;">${afterHours}</div>
        <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.04em;">After hours</div>
      </td>
      <td style="width:8px;"></td>
      <td style="padding:12px 16px;background:#fff;border-radius:8px;border:1px solid #eee;text-align:center;width:25%;">
        <div style="font-size:28px;font-weight:700;color:#7c3aed;">${bookings}</div>
        <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.04em;">Bookings</div>
      </td>
    </tr>
  </table>

  <h3 style="margin:0 0 12px;font-size:15px;color:#111;">Top hot leads this week</h3>
  <ul style="list-style:none;padding:0;margin:0 0 24px;font-size:13px;">${sampleRows}</ul>

  <p style="color:#666;font-size:12px;margin:24px 0 0;padding-top:16px;border-top:1px solid #eee;">
    Aria sent <b>${notified}</b> alert${notified === 1 ? '' : 's'} to you this week.
    These numbers come from real conversations on your site.
    <br><br>
    Need anything tuned? Reply to this email and I'll fix it.<br>
    — Kyle
  </p>
</div>`;
}
