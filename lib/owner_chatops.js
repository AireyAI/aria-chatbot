// owner_chatops.js
//
// Owner chat-ops — lets a business owner manage their Aria by texting it.
//
// The owner WhatsApps their own Aria number ("we now close at 5 on Fridays",
// "add an FAQ: do you do emergency callouts? yes — 24/7, ring the mobile") and
// Aria turns that free text into ONE concrete, structured change. The
// orchestrator in server.js stages it for a one-tap YES/NO confirmation
// (Rule #12) before applying it to the live profile / knowledge base.
//
// This module is the JUDGEMENT layer only (CLAUDE.md Rule #5): it makes a
// single Claude call to interpret the message, then builds a deterministic,
// human-readable summary from the structured result in plain code. ALL
// execution — writing the KB, mutating the schedule, persistence — stays in
// server.js where the in-memory stores live. No server internals leak in here.

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABEL = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

// The two things an owner can change by text in v1. Both write to stores all
// three Aria brains (widget / channels / voice) already read from.
export const OWNER_TOOLS = [
  {
    name: 'add_faq',
    description: 'Add a question-and-answer to the business knowledge base so Aria can answer it for customers. Use for any fact, policy, price, or notice the owner wants customers told — e.g. "tell people we\'re shut bank holiday Monday", "we now offer gutter cleaning", "deposits are 20%".',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The customer-facing question, phrased as a customer would ask it. e.g. "Do you offer emergency callouts?"' },
        answer: { type: 'string', description: "The answer in the owner's voice, concise and customer-ready." },
      },
      required: ['question', 'answer'],
    },
  },
  {
    name: 'set_business_hours',
    description: "Change the recurring weekly opening hours for one or more days. Use when the owner changes when they're open/closed on given weekdays.",
    input_schema: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          description: 'One entry per day (or day-group) being changed.',
          items: {
            type: 'object',
            properties: {
              day: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'weekdays', 'weekends', 'all'], description: 'Which day or group this change applies to.' },
              value: { type: 'string', description: 'Opening hours in 24h "H-H" form (e.g. "9-17", "8:30-17:30"), or "closed", or "24h" for round-the-clock.' },
            },
            required: ['day', 'value'],
          },
        },
      },
      required: ['changes'],
    },
  },
];

// Validate + canonicalise an hours string. Returns the cleaned value or null.
function cleanHours(v) {
  const s = String(v || '').trim().toLowerCase().replace(/\s+/g, '').replace(/[–—]/g, '-');
  if (s === 'closed' || s === 'shut' || s === 'off') return 'closed';
  if (s === '24h' || s === '24/7' || s === '24hours' || s === 'allday') return '24h';
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?-(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return null;
  const start = Number(m[1]) * 60 + Number(m[2] || 0);
  const end = Number(m[3]) * 60 + Number(m[4] || 0);
  if (start < 0 || end > 24 * 60 || end <= start) return null;
  return s;
}

// Expand a day or day-group into concrete day keys.
function expandDays(day) {
  if (day === 'all') return [...DAY_KEYS];
  if (day === 'weekdays') return ['mon', 'tue', 'wed', 'thu', 'fri'];
  if (day === 'weekends') return ['sat', 'sun'];
  return DAY_KEYS.includes(day) ? [day] : [];
}

function prettyHours(v) {
  if (v === 'closed') return 'closed';
  if (v === '24h') return 'open 24h';
  return v.replace('-', '–');
}

// Interpret one owner message into a structured proposal. Makes a single
// Claude tool-use call. Throws on API/billing errors so the caller can
// degrade gracefully (it owns isAiBillingError).
//
// Returns one of:
//   { action: 'add_faq',           payload: { question, answer },   summary }
//   { action: 'set_business_hours', payload: { hours: {mon:'9-17'} }, summary }
//   { action: 'none', reply }   // not an admin command / too vague
export async function interpretOwnerCommand({ messageText, businessName, currentHours }, claude, { model = 'claude-haiku-4-5-20251001' } = {}) {
  const system = `You are the admin co-pilot for ${businessName || 'this business'}'s AI receptionist, Aria. The business OWNER is texting you to manage Aria — not a customer.

Turn their message into exactly ONE change by calling a tool:
- add_faq — when they want Aria to KNOW or TELL customers something (a fact, price, policy, or a one-off notice like "we're closed Monday").
- set_business_hours — when they change opening/closing times for specific weekdays.

If the message is vague, a greeting, or a question to you rather than a command, do NOT call a tool — reply with ONE short sentence asking what they'd like to change.

Current weekly hours: ${JSON.stringify(currentHours || 'not set')}.
Keep FAQ answers short, in the owner's voice, ready to show a customer.`;

  const resp = await claude.messages.create({
    model,
    max_tokens: 700,
    system,
    tools: OWNER_TOOLS,
    messages: [{ role: 'user', content: messageText }],
  });

  const toolUse = resp.content.find(b => b.type === 'tool_use');
  if (!toolUse) {
    const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
    return {
      action: 'none',
      reply: text || 'What would you like to change? You can say things like "add an FAQ: do you do emergency callouts?" or "we now close at 5 on Fridays".',
    };
  }

  if (toolUse.name === 'add_faq') {
    const question = String(toolUse.input?.question || '').trim();
    const answer = String(toolUse.input?.answer || '').trim();
    if (!question || !answer) return { action: 'none', reply: 'I couldn\'t tell what to add — try "add an FAQ: <question>? <answer>".' };
    return {
      action: 'add_faq',
      payload: { question: question.slice(0, 500), answer: answer.slice(0, 2000) },
      summary: `Add this Q&A so Aria can tell customers:\n\nQ: ${question}\nA: ${answer}`,
    };
  }

  if (toolUse.name === 'set_business_hours') {
    const raw = Array.isArray(toolUse.input?.changes) ? toolUse.input.changes : [];
    const hours = {};
    const rejected = [];
    for (const c of raw) {
      const val = cleanHours(c?.value);
      const days = expandDays(String(c?.day || '').toLowerCase());
      if (!val || !days.length) { rejected.push(`${c?.day}=${c?.value}`); continue; }
      for (const d of days) hours[d] = val;
    }
    if (!Object.keys(hours).length) {
      return { action: 'none', reply: 'I couldn\'t read those hours — try e.g. "Fridays 9 to 5" or "closed Sundays".' };
    }
    const lines = DAY_KEYS.filter(d => hours[d]).map(d => `• ${DAY_LABEL[d]}: ${prettyHours(hours[d])}`);
    let summary = `Update your opening hours:\n\n${lines.join('\n')}`;
    summary += `\n\n(Aria will reply to customers during these hours and use your out-of-hours message otherwise.)`;
    if (rejected.length) summary += `\n\nI skipped what I couldn't read: ${rejected.join(', ')}.`;
    return { action: 'set_business_hours', payload: { hours }, summary };
  }

  return { action: 'none', reply: 'I\'m not sure what to change — try "add an FAQ…" or "change my Friday hours…".' };
}
