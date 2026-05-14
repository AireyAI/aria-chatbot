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
];

// Map tool name → { handler, requiresOwnerApproval }. Used by lead_router.js
// to route tool_use blocks to the right dispatcher.
export const TOOL_METADATA = {
  qualify_lead:           { requiresOwnerApproval: false, isJudgment: true  },
  lookup_faq:             { requiresOwnerApproval: false, isJudgment: false },
  create_lead_record:     { requiresOwnerApproval: false, isJudgment: false },
  send_whatsapp_to_owner: { requiresOwnerApproval: true,  isJudgment: false },
  book_calendar_slot:     { requiresOwnerApproval: true,  isJudgment: false },
};
