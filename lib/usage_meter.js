// usage_meter.js
//
// Per-CLIENT (per-ownerEmail) usage metering + daily caps.
//
// Why this exists: today Aria has ONE global token budget (server.js
// checkBudget / recordTokenUsage) backed by a single in-memory Map and a
// single Anthropic key. That means a single noisy client — or a DM-spam
// attack on one owner's channel — can exhaust the shared budget and throttle
// EVERY other client at once. That cross-tenant blast radius was flagged as
// risk #1 in the product review. This module is the logic layer that fixes it:
// usage is bucketed by ownerEmail AND by calendar day, so one owner's spend can
// never count against another owner, and yesterday's spend never counts against
// today's cap.
//
// PURE LOGIC ONLY (CLAUDE.md Rule #5): every function takes a plain state object
// (the thing the orchestrator persists to data/owner-usage.json) plus plain
// args, and returns a value. No imports from server.js, no file I/O, no network,
// no Claude calls. Functions never mutate the state passed in — they return a new
// object to persist (so the caller controls the write). Anything time-dependent
// accepts a `now` (epoch ms) that defaults to Date.now(), so tests can pin the
// clock and day boundaries are deterministic.
//
// State shape (keyed ownerEmail → day → bucket):
//   {
//     "owner@biz.co": {
//       "2026-06-15": { tokens: 1234, inputTokens: 900, outputTokens: 334, messages: 7 },
//       "2026-06-14": { ... }
//     },
//     ...
//   }
//
// Day key is UTC YYYY-MM-DD — matches the existing global checkBudget in
// server.js (`new Date().toISOString().slice(0,10)`) so the two budgets roll
// over on the same boundary and stay comparable.
//
// Used by:
//   - handleIncomingChannelMessage + the router chat paths (gate with
//     checkOwnerBudget alongside the existing global checkBudget; record with
//     recordOwnerUsage after each reply).
//   - dashboard "Usage this month" card (ownerUsageSummary).

// Generous defaults so nothing breaks if an owner has no config set. These sit
// well above the existing global per-owner default (50k tokens/day) — the point
// of a PER-owner cap is isolation, not a tighter clamp, so a normal client is
// never throttled while a runaway one still gets stopped before it can hurt
// others.
export const DEFAULT_TOKENS_PER_DAY = 200_000;
export const DEFAULT_MESSAGES_PER_DAY = 1_000;

// Haiku pricing (USD per token) — mirrors COST_IN / COST_OUT in server.js so the
// dashboard summary's cost estimate matches the global usage figure.
const COST_IN = 0.80 / 1_000_000;
const COST_OUT = 4.00 / 1_000_000;

// UTC calendar day for an epoch-ms timestamp. Kept identical to server.js's
// todayKey() day component so both budgets share a rollover boundary.
export function dayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

// Coerce anything to a finite, non-negative integer (defensive against NaN /
// undefined / negative token counts coming back from the API or a bad caller).
function nonNegInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function emptyBucket() {
  return { tokens: 0, inputTokens: 0, outputTokens: 0, messages: 0 };
}

// Read one owner+day bucket out of state without mutating anything. Returns a
// fresh empty bucket when absent (so reads on an unknown owner are safe).
function readBucket(state, ownerEmail, day) {
  const ownerDays = state && state[ownerEmail];
  const b = ownerDays && ownerDays[day];
  if (!b) return emptyBucket();
  return {
    tokens: nonNegInt(b.tokens),
    inputTokens: nonNegInt(b.inputTokens),
    outputTokens: nonNegInt(b.outputTokens),
    messages: nonNegInt(b.messages),
  };
}

// recordOwnerUsage(state, ownerEmail, { inputTokens, outputTokens, messages, now })
//
// Returns a NEW state object with this owner's TODAY bucket incremented. Does
// NOT mutate the input (the caller persists the returned object). `messages`
// defaults to 1 (one reply == one round-trip); pass 0 to record token spend
// without counting a message. `tokens` is always derived as input+output so the
// token total can never drift from the two components.
export function recordOwnerUsage(state, ownerEmail, { inputTokens = 0, outputTokens = 0, messages = 1, now = Date.now() } = {}) {
  const next = { ...(state || {}) };
  if (!ownerEmail) return next; // nothing to attribute usage to — no-op, fail safe

  const day = dayKey(now);
  const inTok = nonNegInt(inputTokens);
  const outTok = nonNegInt(outputTokens);
  const msgs = nonNegInt(messages); // 0 is allowed (token-only record)

  const prev = readBucket(next, ownerEmail, day);
  const updatedBucket = {
    inputTokens: prev.inputTokens + inTok,
    outputTokens: prev.outputTokens + outTok,
    tokens: prev.tokens + inTok + outTok,
    messages: prev.messages + msgs,
  };

  // Clone only the owner's day map so other owners / other days share structure
  // but are never mutated in place.
  next[ownerEmail] = { ...(next[ownerEmail] || {}), [day]: updatedBucket };
  return next;
}

// checkOwnerBudget(state, ownerEmail, { tokensPerDay, messagesPerDay, now })
//
// Read-only gate. `allowed` is false once EITHER the token cap or the message
// cap is reached for TODAY (>=, so the boundary value is blocked — matches the
// global checkBudget's `usage.tokens < cap` semantics). Only today's bucket is
// considered, so a busy yesterday never blocks today.
export function checkOwnerBudget(state, ownerEmail, { tokensPerDay, messagesPerDay, now = Date.now() } = {}) {
  const capTokens = nonNegInt(tokensPerDay) || DEFAULT_TOKENS_PER_DAY;
  const capMessages = nonNegInt(messagesPerDay) || DEFAULT_MESSAGES_PER_DAY;
  const day = dayKey(now);
  const b = readBucket(state, ownerEmail, day);

  const tokensOk = b.tokens < capTokens;
  const messagesOk = b.messages < capMessages;

  return {
    allowed: tokensOk && messagesOk,
    usedTokens: b.tokens,
    usedMessages: b.messages,
    capTokens,
    capMessages,
    remainingTokens: Math.max(0, capTokens - b.tokens),
    remainingMessages: Math.max(0, capMessages - b.messages),
    // Which limit tripped (null when allowed) — lets the caller log/explain why
    // a reply was suppressed without re-deriving the comparison.
    blockedBy: tokensOk && messagesOk ? null : (!tokensOk ? 'tokens' : 'messages'),
  };
}

// ownerUsageSummary(state, ownerEmail, { now, days })
//
// Rollup for the dashboard usage card: today + a trailing N-day window
// (inclusive of today). Sums tokens/messages across the window and returns the
// per-day series newest-first for a sparkline, plus an estimated USD cost using
// the same Haiku rates as server.js.
export function ownerUsageSummary(state, ownerEmail, { now = Date.now(), days = 30 } = {}) {
  // Clamp the window to >=1. A caller passing days:0 or a negative means "a tiny
  // window", not "fall back to the 30-day default" — so floor to 1 rather than
  // letting `|| 30` swallow a 0 back into the default. Only an absent/NaN days
  // uses the 30-day default (via the destructuring default above + nonNegInt).
  const requested = nonNegInt(days);
  const window = days === undefined || days === null || Number.isNaN(Number(days))
    ? 30
    : Math.max(1, requested);
  const today = dayKey(now);
  const todayBucket = readBucket(state, ownerEmail, today);

  let totalTokens = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalMessages = 0;
  let activeDays = 0;
  const series = [];

  for (let i = 0; i < window; i++) {
    const dayMs = now - i * 24 * 60 * 60 * 1000;
    const d = dayKey(dayMs);
    const b = readBucket(state, ownerEmail, d);
    totalTokens += b.tokens;
    totalInputTokens += b.inputTokens;
    totalOutputTokens += b.outputTokens;
    totalMessages += b.messages;
    if (b.tokens > 0 || b.messages > 0) activeDays++;
    series.push({ day: d, tokens: b.tokens, messages: b.messages });
  }

  const estCostUsd = +(totalInputTokens * COST_IN + totalOutputTokens * COST_OUT).toFixed(4);

  return {
    ownerEmail: ownerEmail || null,
    windowDays: window,
    today: { day: today, tokens: todayBucket.tokens, messages: todayBucket.messages },
    totalTokens,
    totalInputTokens,
    totalOutputTokens,
    totalMessages,
    activeDays,
    estCostUsd,
    series, // newest-first, one entry per day in the window
  };
}
