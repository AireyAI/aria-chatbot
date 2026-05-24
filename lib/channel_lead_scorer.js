// channel_lead_scorer.js
//
// Heuristic scoring for FB/IG/WhatsApp leads. Runs after Claude has already
// extracted contact + intent into a structured object (see generateChannelReply
// in server.js). Pure function — no I/O, easy to swap.
//
// Design: combine signals, don't trust any single one. Phone given alone is
// weaker than "I want to book Tuesday" alone. Multiple weak signals = strong
// (e.g. asked price + gave email + 4 messages deep). Tune the thresholds at
// the bottom — `MIN_HOT_SCORE` / `MIN_WARM_SCORE` — based on real data.

const HOT_KEYWORDS = /\b(book|booking|appointment|hire|when can you (start|come)|schedule|reserve|today|tomorrow|this week|asap|urgent|need.*now)\b/i;
const WARM_KEYWORDS = /\b(quote|price|cost|how much|available|availability|estimate|interested|looking for|need a|do you (do|offer))\b/i;
const COLD_KEYWORDS = /\b(just (looking|browsing|asking)|maybe|some(day|time)|might|just curious|no rush)\b/i;

export function scoreChannelLead({ senderMessage = '', reply = null, contact = {}, conversationLength = 1 }) {
  const msg = String(senderMessage || '');
  let score = 0;

  // Booking detected by Claude is the strongest signal.
  if (reply?.booking) score += 5;

  // Explicit cold language down-weights everything below.
  if (COLD_KEYWORDS.test(msg)) score -= 3;

  // Intent signals from message text.
  if (HOT_KEYWORDS.test(msg)) score += 3;
  if (WARM_KEYWORDS.test(msg)) score += 2;

  // Contact info captured = the sender is willing to be reached.
  if (contact?.email) score += 2;
  if (contact?.phone) score += 2;

  // Conversation depth — 4+ exchanges = invested, not a tyre-kicker.
  if (conversationLength >= 4) score += 1;
  if (conversationLength >= 8) score += 1;

  // Message length matters at the margin — single emoji / one-word ≠ a lead.
  if (msg.trim().length < 12) score -= 1;

  // Thresholds (tunable based on observed precision/recall).
  const MIN_HOT_SCORE = 5;
  const MIN_WARM_SCORE = 2;

  if (score >= MIN_HOT_SCORE) return 'hot';
  if (score >= MIN_WARM_SCORE) return 'warm';
  return 'cold';
}

// Light intent classifier — separate from scoring because category drives
// downstream actions (booking → Calendar, complaint → handoff, quote → CRM).
export function categorizeChannelMessage(senderMessage = '') {
  const m = String(senderMessage || '').toLowerCase();
  if (/\b(book|appointment|schedule|reserve|available|when can you (start|come))\b/.test(m)) return 'booking';
  if (/\b(quote|price|cost|how much|estimate)\b/.test(m)) return 'quote';
  if (/\b(complain|disappointed|terrible|refund|cancel)\b/.test(m)) return 'complaint';
  if (/\b(thank|thanks|great service|loved|brilliant)\b/.test(m)) return 'feedback';
  return 'general';
}
