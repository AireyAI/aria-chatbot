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
// lookup_faq — read from clientConfig.canned (parsed from data-canned),
// falling back to the server-side FAQ map + owner knowledge docs (W4).
// The server lookup arrives through ctx.serverFns so this file stays free
// of server.js internals (same pattern as smartSend).
// ──────────────────────────────────────────────────────────────────────────
export async function handle_lookup_faq(input, ctx) {
  const canned = ctx?.clientConfig?.canned || {};
  const answer = canned[input.key];
  if (answer) return { found: true, answer, source: 'canned' };
  if (ctx?.serverFns?.lookupServerFaq) {
    try {
      const hit = await ctx.serverFns.lookupServerFaq({
        key: input.key,
        slug: ctx?.clientConfig?.slug,
        ownerEmail: ctx?.clientConfig?.handoffEmail,
      });
      if (hit?.found) return hit;
    } catch (e) {
      console.warn('[aria/faq] server lookup failed:', e?.message || e);
    }
  }
  return { found: false, hint: 'Not in canned answers — answer from system prompt instead.' };
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

// ──────────────────────────────────────────────────────────────────────────
// W7 — rich behaviors ported from the widget's legacy ::ACTION tags.
//
// The first four are CLIENT-EFFECT handlers: they validate + echo the input
// so the widget (which receives every tool event as a {tool, result} SSE
// frame, or via toolEvents on the non-streaming route) can render the
// matching UI — quick-reply chips, lead form, booking flow, handoff card.
// No server state changes here.
//
// request_callback / request_quote DO change server state: they fire the
// owner notification through serverFns (processCallbackRequest /
// processQuoteRequest in server.js — the exact same code path the legacy
// /api/chat/callback and /api/chat/quote routes use). Fire-and-forget so
// SMTP/Slack latency never blocks the visitor's chat (same pattern as
// create_lead_record above). No approval stage — these are owner-facing
// alerts, matching how the legacy tags behaved.
// ──────────────────────────────────────────────────────────────────────────
export async function handle_show_quick_replies(input, _ctx) {
  const suggestions = (Array.isArray(input?.suggestions) ? input.suggestions : [])
    .map(s => String(s || '').trim()).filter(Boolean).slice(0, 3);
  if (!suggestions.length) return { error: 'suggestions must be a non-empty array of short strings' };
  return { shown: true, suggestions };
}

export async function handle_show_lead_capture(input, _ctx) {
  return { shown: true, reason: input?.reason || null };
}

export async function handle_start_booking_flow(input, _ctx) {
  return { started: true, show_availability: !!input?.show_availability };
}

export async function handle_request_callback(input, ctx) {
  if (!input?.phone) return { error: 'phone is required — ask the visitor for their phone number first.' };
  if (ctx?.serverFns?.requestCallback) {
    Promise.resolve(ctx.serverFns.requestCallback({
      name:       input.name || null,
      phone:      input.phone,
      notes:      input.notes || '',
      ownerEmail: ctx?.clientConfig?.handoffEmail,
      siteName:   ctx?.clientConfig?.businessName || ctx?.clientConfig?.slug,
    })).catch(e => console.error('[aria/callback] owner notify failed:', e?.message || e));
  }
  return { ok: true, requested: true, phone: input.phone };
}

export async function handle_request_quote(input, ctx) {
  if (!input?.details) return { error: 'details is required — gather what the visitor needs quoted first.' };
  if (ctx?.serverFns?.requestQuote) {
    Promise.resolve(ctx.serverFns.requestQuote({
      name:       input.name || null,
      email:      input.email || null,
      phone:      input.phone || null,
      details:    input.details,
      ownerEmail: ctx?.clientConfig?.handoffEmail,
      siteName:   ctx?.clientConfig?.businessName || ctx?.clientConfig?.slug,
    })).catch(e => console.error('[aria/quote] owner notify failed:', e?.message || e));
  }
  return { ok: true, requested: true };
}

export async function handle_handoff_to_human(input, _ctx) {
  return { ok: true, reason: input?.reason || null };
}

// ──────────────────────────────────────────────────────────────────────────
// Read-only booking tools — reach the owner's Google Calendar via serverFns
// (lookupBooking / getAvailability in server.js, same pattern as smartSend).
// No writes, no approval. Graceful when no calendar is connected.
// ──────────────────────────────────────────────────────────────────────────
export async function handle_lookup_booking(input, ctx) {
  if (!input?.email) return { error: 'Ask the visitor for the email they booked with first.' };
  const ownerEmail = ctx?.clientConfig?.handoffEmail || ctx?.clientConfig?.ownerEmail;
  if (!ownerEmail || !ctx?.serverFns?.lookupBooking) {
    return { found: false, message: 'Booking lookup is not available for this site.' };
  }
  try {
    const r = await ctx.serverFns.lookupBooking({ ownerEmail, email: input.email });
    if (!r?.booking) return { found: false, message: 'No upcoming appointment found for that email.' };
    return { found: true, booking: r.booking };
  } catch (e) {
    console.warn('[aria/lookup_booking] failed:', e?.message || e);
    return { found: false, message: 'Could not check the calendar right now.' };
  }
}

export async function handle_check_availability(_input, ctx) {
  const ownerEmail = ctx?.clientConfig?.handoffEmail || ctx?.clientConfig?.ownerEmail;
  if (!ownerEmail || !ctx?.serverFns?.getAvailability) {
    return { slots: [], message: 'Live availability is not connected — offer to take their details and have someone confirm a time.' };
  }
  try {
    const r = await ctx.serverFns.getAvailability({ ownerEmail });
    // Cap to 6 so Aria offers a manageable choice, not a wall of times.
    return { slots: (r?.slots || []).slice(0, 6), message: r?.message || null };
  } catch (e) {
    console.warn('[aria/check_availability] failed:', e?.message || e);
    return { slots: [], message: 'Could not check the calendar right now.' };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Booking WRITE tools — reschedule / cancel. These change the owner's calendar
// (and email the customer), so per Rule #12 they STAGE to pending_actions.jsonl
// and email the owner a one-click confirm; the real calendar write runs in
// /api/pending/confirm. We resolve the actual appointment (eventId) first via
// lookupBooking so the owner approves a SPECIFIC change, not a guess.
// ──────────────────────────────────────────────────────────────────────────
async function _resolveBookingForChange(input, ctx, action) {
  const ownerEmail = ctx?.clientConfig?.handoffEmail || ctx?.clientConfig?.ownerEmail;
  if (!ownerEmail || !ctx?.serverFns?.lookupBooking) {
    return { error: 'Booking changes are not available for this site.' };
  }
  let booking = null;
  try {
    booking = (await ctx.serverFns.lookupBooking({ ownerEmail, email: input.email }))?.booking;
  } catch (e) {
    console.warn(`[aria/${action}] lookup failed:`, e?.message || e);
    return { error: 'Could not check the calendar right now.' };
  }
  if (!booking) return { found: false, message: `No upcoming appointment found for that email — nothing to ${action === 'reschedule_booking' ? 'reschedule' : 'cancel'}.` };
  return { booking };
}

export async function handle_reschedule_booking(input, ctx) {
  if (!input?.email || !input?.new_datetime) return { error: 'Need the visitor\'s booking email and the new time first.' };
  const r = await _resolveBookingForChange(input, ctx, 'reschedule_booking');
  if (!r.booking) return r;
  return stagePendingAction('reschedule_booking', {
    eventId: r.booking.id, email: input.email, new_datetime: input.new_datetime, current: r.booking.date,
  }, ctx);
}

export async function handle_cancel_booking(input, ctx) {
  if (!input?.email) return { error: 'Ask the visitor for the email they booked with first.' };
  const r = await _resolveBookingForChange(input, ctx, 'cancel_booking');
  if (!r.booking) return r;
  return stagePendingAction('cancel_booking', {
    eventId: r.booking.id, email: input.email, summary: r.booking.summary, when: r.booking.date,
  }, ctx);
}

// ──────────────────────────────────────────────────────────────────────────
// show_social_proof — read the business's published reviews summary via
// serverFns (getReviewsSummary in server.js) so Aria can cite genuine proof.
// Read-only. Graceful when the business has no reviews yet.
// ──────────────────────────────────────────────────────────────────────────
export async function handle_show_social_proof(_input, ctx) {
  const slug = ctx?.clientConfig?.slug;
  if (!slug || !ctx?.serverFns?.getReviewsSummary) {
    return { count: 0, message: 'No reviews available to cite — reassure them another way (experience, guarantees).' };
  }
  try {
    const s = await ctx.serverFns.getReviewsSummary({ slug });
    if (!s || !s.count) return { count: 0, message: 'No published reviews yet for this business.' };
    return s;
  } catch (e) {
    console.warn('[aria/show_social_proof] failed:', e?.message || e);
    return { count: 0 };
  }
}

// Dispatcher table consumed by lead_router.js.
export const HANDLERS = {
  qualify_lead:           handle_qualify_lead,
  lookup_faq:             handle_lookup_faq,
  create_lead_record:     handle_create_lead_record,
  send_whatsapp_to_owner: handle_send_whatsapp_to_owner,
  book_calendar_slot:     handle_book_calendar_slot,
  show_quick_replies:     handle_show_quick_replies,
  show_lead_capture:      handle_show_lead_capture,
  start_booking_flow:     handle_start_booking_flow,
  request_callback:       handle_request_callback,
  request_quote:          handle_request_quote,
  handoff_to_human:       handle_handoff_to_human,
  lookup_booking:         handle_lookup_booking,
  check_availability:     handle_check_availability,
  reschedule_booking:     handle_reschedule_booking,
  cancel_booking:         handle_cancel_booking,
  show_social_proof:      handle_show_social_proof,
};
