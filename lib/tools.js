// Anthropic tool-use schemas for Aria's lead router.
// Each tool maps to a handler in tool_handlers.js. Schemas are sent to
// claude.messages.create({ tools: ARIA_TOOLS, ... }) so Claude can decide
// WHEN to invoke each action mid-conversation.
//
// Irreversible actions (booking a slot, messaging the owner) carry
// requiresOwnerApproval: true so handlers stage them rather than firing —
// per CLAUDE.md Rule #12 (two-stage approval).

export const ARIA_TOOLS = [
  {
    name: 'qualify_lead',
    description:
      'Score whether the current conversation represents a real qualified lead vs casual browsing. ' +
      'Call this BEFORE invoking any state-changing tool. Returns a score 0-100 and a reason. ' +
      'Use the score to decide whether to escalate (>=70 fires owner notification, 40-69 captures contact only, <40 stays as FAQ).',
    input_schema: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          enum: ['quote_request', 'booking', 'product_purchase', 'support', 'price_question', 'browsing'],
          description: 'The dominant intent of the visitor based on the conversation so far.',
        },
        captured_contact: {
          type: 'object',
          description: 'What contact info the visitor has provided (any combination of name, email, phone).',
          properties: {
            name: { type: 'string' },
            email: { type: 'string' },
            phone: { type: 'string' },
          },
        },
        service_match: {
          type: 'boolean',
          description: 'Does the visitor need a service the client actually offers (per the system prompt)?',
        },
        urgency: {
          type: 'string',
          enum: ['immediate', 'this_week', 'this_month', 'just_looking'],
        },
      },
      required: ['intent', 'service_match', 'urgency'],
    },
  },

  {
    name: 'lookup_faq',
    description:
      'Look up a canned answer from the client\'s data-canned JSON (hours, pricing, service area). ' +
      'Use this for FAQ-style questions before generating a freeform answer — keeps answers consistent with what the client signed off.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The FAQ key, e.g. "hours", "price", "service_area".' },
      },
      required: ['key'],
    },
  },

  {
    name: 'create_lead_record',
    description:
      'Append a new lead to the client\'s leads log. Fires immediately (no approval). ' +
      'Use this once qualify_lead returns a score >=40 AND at least one contact field (email OR phone) is captured. ' +
      'This is the source of truth for "what leads did Aria capture this week".',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        service_wanted: { type: 'string', description: 'What the visitor needs, in 1 sentence.' },
        qualification_score: { type: 'number', description: 'From qualify_lead.' },
        notes: { type: 'string', description: 'Anything else useful for the owner — postcode, timing, budget hints.' },
      },
      required: ['service_wanted', 'qualification_score'],
    },
  },

  {
    name: 'send_whatsapp_to_owner',
    description:
      'Send a WhatsApp message to the business owner with the qualified lead details. ' +
      'REQUIRES OWNER APPROVAL — this stages the message in pending_actions.jsonl and emails the owner a one-click "send" link. ' +
      'Only call this for qualification_score >=70 AND when the visitor asks to be contacted.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One-paragraph lead summary for the owner.' },
        callback_number: { type: 'string', description: 'The visitor\'s phone — what the owner will call/text back.' },
        urgency: { type: 'string', enum: ['immediate', 'this_week', 'this_month'] },
      },
      required: ['summary', 'callback_number', 'urgency'],
    },
  },

  {
    name: 'book_calendar_slot',
    description:
      'Tentatively book a calendar slot on the client\'s Google Calendar (data-handoff-url / connected calendar). ' +
      'REQUIRES OWNER APPROVAL — this stages a pending event and emails the owner. The visitor is told "we\'ll confirm within 1 hour". ' +
      'Only call this if the client has Calendar connected (clientConfig.calendarConnected === true).',
    input_schema: {
      type: 'object',
      properties: {
        iso_start: { type: 'string', description: 'ISO-8601 start time in the client\'s timezone.' },
        duration_minutes: { type: 'number' },
        visitor_name: { type: 'string' },
        visitor_contact: { type: 'string', description: 'Email or phone to confirm to.' },
        service: { type: 'string' },
      },
      required: ['iso_start', 'duration_minutes', 'visitor_name', 'visitor_contact'],
    },
  },

  // ── W7: rich behaviors ported from the widget's legacy ::ACTION tags ─────
  // The first four are CLIENT-EFFECT tools: the handler validates + echoes the
  // input, and the widget (which receives every tool event as a {tool, result}
  // stream frame / toolEvents entry) renders the matching UI. request_callback
  // and request_quote additionally fire the real owner notification server-side
  // via serverFns (same code path as the legacy /api/chat/callback|quote).

  {
    name: 'show_quick_replies',
    description:
      'Show the visitor up to 3 tappable quick-reply buttons under your message — the next logical steps in their journey. ' +
      'Use INSTEAD of writing a "FOLLOWUPS:" line. Make each suggestion short (2-6 words) and specific to the conversation.',
    input_schema: {
      type: 'object',
      properties: {
        suggestions: {
          type: 'array',
          items: { type: 'string' },
          description: '1-3 short suggested replies, e.g. ["Book an appointment", "Get a quote"].',
        },
      },
      required: ['suggestions'],
    },
  },

  {
    name: 'show_lead_capture',
    description:
      'Show the email lead-capture form in the chat so the visitor can leave their email for a follow-up. ' +
      'Use when the visitor wants info sent over, is leaving without converting, or asks to be contacted later. ' +
      'Do NOT use if they already gave contact details (use create_lead_record instead).',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why the form is being shown (for telemetry).' },
      },
    },
  },

  {
    name: 'start_booking_flow',
    description:
      'Open the in-chat booking flow so the visitor can book an appointment (name → date/time → email → confirm). ' +
      'Use when the visitor wants to book, schedule, or asks about availability. ' +
      'Set show_availability=true to show real free calendar slots first (e.g. they asked "when are you free?").',
    input_schema: {
      type: 'object',
      properties: {
        show_availability: { type: 'boolean', description: 'Show the live slot picker instead of the booking form.' },
      },
    },
  },

  {
    name: 'request_callback',
    description:
      'Send the business owner a callback request (email + Slack + calendar entry) and show the visitor a confirmation card. ' +
      'Fires immediately. ONLY call after the visitor has given their phone number.',
    input_schema: {
      type: 'object',
      properties: {
        name:  { type: 'string' },
        phone: { type: 'string', description: 'The visitor\'s phone number — required.' },
        notes: { type: 'string', description: 'What they want the call about.' },
      },
      required: ['phone'],
    },
  },

  {
    name: 'request_quote',
    description:
      'Send the business owner a quote request with everything the visitor needs (email + Slack + lead record) and show the visitor a confirmation card. ' +
      'Fires immediately. Gather WHAT they need first (and ideally a contact detail); include photo observations in details if they sent photos.',
    input_schema: {
      type: 'object',
      properties: {
        name:    { type: 'string' },
        email:   { type: 'string' },
        phone:   { type: 'string' },
        details: { type: 'string', description: 'What the visitor needs quoted, in their words plus anything you observed (photos, sizes, urgency).' },
      },
      required: ['details'],
    },
  },

  {
    name: 'handoff_to_human',
    description:
      'Hand the conversation to a real person — shows the visitor the contact/handoff card (book a call, WhatsApp, email) or starts a live handoff session. ' +
      'Use when they explicitly ask for a human or you genuinely cannot help further.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why the handoff is happening.' },
      },
    },
  },

  // ── Read-only booking tools (2026-06-22) — no approval: they only READ the
  // owner's connected Google Calendar so Aria can answer "when's my appointment"
  // and OFFER real free slots in prose. Booking/cancel/reschedule WRITES stay
  // approval-gated (book_calendar_slot). ─────────────────────────────────────
  {
    name: 'lookup_booking',
    description:
      'Look up the visitor\'s upcoming appointment on the business calendar by their email. Read-only. ' +
      'Use when they ask "when is my appointment / is my booking confirmed / what time am I booked in". ' +
      'Requires their email — ask for it first if they have not given one.',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'The email the visitor booked with.' },
      },
      required: ['email'],
    },
  },

  {
    name: 'check_availability',
    description:
      'Get the business\'s real free appointment slots (next 5 working days, 9am-5pm) so you can OFFER specific times in your reply ' +
      '(e.g. "I\'ve got Tuesday 2pm or Wednesday 10am — which suits?"). Read-only. ' +
      'Use when the visitor asks when you are free / wants to book / asks about availability. ' +
      'After they pick a time, use start_booking_flow or book_calendar_slot to actually book it.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },

  // ── Booking WRITE tools (2026-06-22) — REQUIRE owner approval (Rule #12).
  // They stage to pending_actions.jsonl + email the owner a one-click confirm;
  // the real calendar change runs in /api/pending/confirm. Tell the visitor the
  // business will confirm shortly. ──────────────────────────────────────────
  {
    name: 'reschedule_booking',
    description:
      'Request to move the visitor\'s existing appointment to a new time. REQUIRES OWNER APPROVAL — it stages the change and emails the business a one-click confirm. ' +
      'Tell the visitor "I\'ve asked them to move your appointment — they\'ll confirm shortly". ' +
      'Needs the email they booked with (to find the appointment) and the new date/time they want.',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'The email the visitor booked with.' },
        new_datetime: { type: 'string', description: 'The new date/time they want, in their words (e.g. "next Tuesday 2pm").' },
      },
      required: ['email', 'new_datetime'],
    },
  },

  {
    name: 'cancel_booking',
    description:
      'Request to cancel the visitor\'s existing appointment. REQUIRES OWNER APPROVAL — it stages the cancellation and emails the business a one-click confirm. ' +
      'Tell the visitor "I\'ve asked them to cancel your appointment — they\'ll confirm shortly". ' +
      'Confirm the visitor really wants to cancel before calling this. Needs the email they booked with.',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'The email the visitor booked with.' },
      },
      required: ['email'],
    },
  },
];

// Map tool name → { handler, requiresOwnerApproval }. Used by lead_router.js
// to route tool_use blocks to the right dispatcher.
export const TOOL_METADATA = {
  qualify_lead:           { requiresOwnerApproval: false, isJudgment: true  },
  lookup_faq:             { requiresOwnerApproval: false, isJudgment: false },
  create_lead_record:     { requiresOwnerApproval: false, isJudgment: false },
  send_whatsapp_to_owner: { requiresOwnerApproval: true,  isJudgment: false },
  book_calendar_slot:     { requiresOwnerApproval: true,  isJudgment: false },
  // W7 — ported ::ACTION behaviors. clientEffect: the widget renders the UI
  // from the tool event; no approval needed (matches the legacy tags, which
  // fired without approval). request_callback / request_quote notify the
  // owner directly — they are owner-facing alerts, not visitor-facing sends.
  show_quick_replies:     { requiresOwnerApproval: false, isJudgment: false, clientEffect: true },
  show_lead_capture:      { requiresOwnerApproval: false, isJudgment: false, clientEffect: true },
  start_booking_flow:     { requiresOwnerApproval: false, isJudgment: false, clientEffect: true },
  request_callback:       { requiresOwnerApproval: false, isJudgment: false, clientEffect: true },
  request_quote:          { requiresOwnerApproval: false, isJudgment: false, clientEffect: true },
  handoff_to_human:       { requiresOwnerApproval: false, isJudgment: false, clientEffect: true },
  // Read-only calendar reads — return data for Aria to use in prose, no writes.
  lookup_booking:         { requiresOwnerApproval: false, isJudgment: false },
  check_availability:     { requiresOwnerApproval: false, isJudgment: false },
  // Booking WRITES — owner approves before the calendar changes (Rule #12).
  reschedule_booking:     { requiresOwnerApproval: true,  isJudgment: false },
  cancel_booking:         { requiresOwnerApproval: true,  isJudgment: false },
};
