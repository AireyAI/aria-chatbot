// Tool handlers — deterministic dispatchers for each ARIA_TOOLS entry.
//
// Each handler is called by lead_router.js when Claude emits a tool_use
// block. Handlers MUST return a JSON-serialisable object — the router
// feeds it back to Claude as a tool_result so the conversation can
// continue.
//
// Per CLAUDE.md Rule #5 (Claude only for judgment): everything in this
// file is plain code. No LLM calls. The only fuzzy step is qualify_lead
// — and even that is "Claude proposes a structured score, code uses it".
//
// Per Rule #12 (two-stage approval): book_calendar_slot and
// send_whatsapp_to_owner STAGE actions to pending_actions.jsonl and email
// the owner a one-click confirm link. They do NOT execute on first call.

import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = resolve('data');
const LEADS_LOG    = resolve(DATA_DIR, 'leads.jsonl');
const PENDING_LOG  = resolve(DATA_DIR, 'pending_actions.jsonl');

// Append-only JSONL writer (CLAUDE.md Rule #13).
async function appendJsonl(path, obj) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(path, JSON.stringify(obj) + '\n', 'utf8');
}

// ──────────────────────────────────────────────────────────────────────────
// qualify_lead — Claude has already done the judgement and given us a
// structured input. We turn it into a 0-100 score using simple rules so
// score thresholds are auditable, not vibes-based.
// ──────────────────────────────────────────────────────────────────────────
export async function handle_qualify_lead(input, _ctx) {
  const { intent, captured_contact = {}, service_match, urgency } = input;
  let score = 0;
  if (service_match) score += 30;
  if (intent === 'quote_request' || intent === 'booking' || intent === 'product_purchase') score += 25;
  if (intent === 'price_question') score += 10;
  if (urgency === 'immediate') score += 25;
  else if (urgency === 'this_week') score += 15;
  else if (urgency === 'this_month') score += 5;
  if (captured_contact.email)  score += 10;
  if (captured_contact.phone)  score += 15;
  if (captured_contact.name)   score += 5;
  score = Math.min(100, score);

  const tier = score >= 70 ? 'hot' : score >= 40 ? 'warm' : 'cold';
  return { score, tier, reason: `intent=${intent}, urgency=${urgency}, contact=${Object.keys(captured_contact).join(',') || 'none'}` };
}

// ──────────────────────────────────────────────────────────────────────────
// lookup_faq — read from clientConfig.canned (parsed from data-canned).
// ──────────────────────────────────────────────────────────────────────────
export async function handle_lookup_faq(input, ctx) {
  const canned = ctx?.clientConfig?.canned || {};
  const answer = canned[input.key];
  return answer
    ? { found: true, answer }
    : { found: false, hint: 'Not in canned answers — answer from system prompt instead.' };
}

// ──────────────────────────────────────────────────────────────────────────
// create_lead_record — append to leads.jsonl + dual-deliver notification.
//
// Dual delivery: every lead Aria captures pings BOTH the client (handoffEmail)
// AND the agency (apcapital.ai@gmail.com, set as NOTIFY_EMAIL on Railway).
// Why: in the agency-bundled model, Kyle needs to see value flowing across
// his whole client portfolio in real-time — both for QC and for the eventual
// "we've delivered N leads, here's the £29/mo tier" pricing conversation.
//
// Emails are fire-and-forget (Rule #12-adjacent) — SMTP latency must not
// block the chat response or the model's next tool call.
// ──────────────────────────────────────────────────────────────────────────
export async function handle_create_lead_record(input, ctx) {
  const row = {
    ts: new Date().toISOString(),
    client: ctx?.clientConfig?.slug || ctx?.clientConfig?.handoffEmail || 'unknown',
    sessionId: ctx?.sessionId,
    ...input,
  };
  await appendJsonl(LEADS_LOG, row);

  // Dual delivery — fire-and-forget so chat stays snappy.
  if (ctx?.serverFns?.smartSend) {
    const businessName = ctx?.clientConfig?.businessName || ctx?.clientConfig?.slug || 'your site';
    const clientEmail  = ctx?.clientConfig?.handoffEmail;
    const agencyEmail  = process.env.NOTIFY_EMAIL; // Kyle's apcapital.ai@gmail.com per the 2026-05-15 rotation
    const subject = `🔔 Aria captured a lead via ${businessName}${input.qualification_score ? ` (score ${input.qualification_score})` : ''}`;
    const fmt = (v) => v ? String(v).replace(/</g, '&lt;') : '<em style="color:#999">not captured</em>';
    const html = `
      <div style="font-family:-apple-system,system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1a202c;line-height:1.6">
        <h2 style="font-size:20px;margin-bottom:4px">New lead — ${fmt(businessName)}</h2>
        <p style="color:#718096;font-size:13px;margin-bottom:24px">via Aria, ${new Date().toISOString()}</p>
        <table style="border-collapse:collapse;width:100%;font-size:14px">
          <tr><td style="padding:8px 0;color:#4a5568;width:140px">Service wanted</td><td>${fmt(input.service_wanted)}</td></tr>
          <tr><td style="padding:8px 0;color:#4a5568">Name</td><td>${fmt(input.name)}</td></tr>
          <tr><td style="padding:8px 0;color:#4a5568">Email</td><td>${fmt(input.email)}</td></tr>
          <tr><td style="padding:8px 0;color:#4a5568">Phone</td><td>${fmt(input.phone)}</td></tr>
          <tr><td style="padding:8px 0;color:#4a5568">Qualification score</td><td>${fmt(input.qualification_score)} / 100</td></tr>
          ${input.notes ? `<tr><td style="padding:8px 0;color:#4a5568;vertical-align:top">Notes</td><td>${fmt(input.notes)}</td></tr>` : ''}
        </table>
      </div>`;
    // Don't await — keep chat latency low even if SMTP is slow.
    if (clientEmail) {
      ctx.serverFns.smartSend({ ownerEmail: clientEmail, to: clientEmail, subject, html })
        .catch(e => console.error('[aria/lead] client notify failed:', e?.message || e));
    }
    if (agencyEmail && agencyEmail !== clientEmail) {
      ctx.serverFns.smartSend({ ownerEmail: agencyEmail, to: agencyEmail, subject: `[Agency] ${subject}`, html })
        .catch(e => console.error('[aria/lead] agency notify failed:', e?.message || e));
    }
  }

  return { logged: true, leadId: row.ts };
}

// ──────────────────────────────────────────────────────────────────────────
// Staging helper for the two approval-gated tools.
// Writes to pending_actions.jsonl with a fresh token; owner gets emailed
// a one-click ?action=<id>&token=<t> link that executes the real send.
// ──────────────────────────────────────────────────────────────────────────
async function stagePendingAction(kind, payload, ctx) {
  const id = crypto.randomBytes(8).toString('hex');
  const token = crypto.randomBytes(16).toString('hex');
  // Snapshot the owner-routing fields onto the row so confirm can fire
  // without re-reading client config from anywhere else.
  const ownerSnapshot = {
    handoffEmail: ctx?.clientConfig?.handoffEmail,
    handoffWa:    ctx?.clientConfig?.handoffWa,
    handoffUrl:   ctx?.clientConfig?.handoffUrl,
    slug:         ctx?.clientConfig?.slug,
  };
  await appendJsonl(PENDING_LOG, {
    id, token, kind, payload, owner: ownerSnapshot,
    client: ctx?.clientConfig?.slug,
    sessionId: ctx?.sessionId,
    staged_at: new Date().toISOString(),
    executed_at: null,
  });

  // Owner notification — uses smartSend() already in server.js. We expose it
  // through ctx.serverFns so this file stays free of server.js internals.
  //
  // FIRE-AND-FORGET: don't await. SMTP outages or slow mail providers must
  // NOT block the chat response. The action is already staged on disk
  // (above); the email is just the convenience confirm link. If mail fails,
  // owner can still execute via the staged row's id+token directly.
  const ownerEmail = ctx?.clientConfig?.handoffEmail;
  if (ownerEmail && ctx?.serverFns?.smartSend) {
    const base = ctx?.clientConfig?.serverBaseUrl || '';
    const confirmUrl = `${base}/api/pending/confirm?id=${id}&token=${token}`;
    ctx.serverFns.smartSend({
      ownerEmail,
      to: ownerEmail,
      subject: `Aria wants approval to ${kind.replace(/_/g, ' ')}`,
      html: `<p>Aria captured a lead and wants to <b>${kind}</b>:</p>
             <pre>${JSON.stringify(payload, null, 2)}</pre>
             <p><a href="${confirmUrl}">Approve & send</a></p>`,
    }).catch(e => console.error('[aria/stage] owner notify failed:', e?.message || e));
  }

  return { staged: true, id, requires_owner_approval: true };
}

export async function handle_send_whatsapp_to_owner(input, ctx) {
  return stagePendingAction('send_whatsapp_to_owner', input, ctx);
}

export async function handle_book_calendar_slot(input, ctx) {
  if (!ctx?.clientConfig?.calendarConnected) {
    return { error: 'Calendar not connected for this client. Offer the handoff URL instead.' };
  }
  return stagePendingAction('book_calendar_slot', input, ctx);
}

// Dispatcher table consumed by lead_router.js.
export const HANDLERS = {
  qualify_lead:           handle_qualify_lead,
  lookup_faq:             handle_lookup_faq,
  create_lead_record:     handle_create_lead_record,
  send_whatsapp_to_owner: handle_send_whatsapp_to_owner,
  book_calendar_slot:     handle_book_calendar_slot,
};
