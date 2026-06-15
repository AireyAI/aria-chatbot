// usage_meter.test.js
//
// Proves the per-client metering logic that fixes the cross-tenant blast radius:
// one owner's usage must never count against another owner, yesterday's usage
// must never count against today's cap, and either cap (tokens OR messages)
// blocks at its boundary. These tests would fail if the bucketing key dropped
// the ownerEmail or the day, or if the cap comparison flipped at the boundary.

import { describe, it, expect } from 'vitest';
import {
  recordOwnerUsage,
  checkOwnerBudget,
  ownerUsageSummary,
  dayKey,
  DEFAULT_TOKENS_PER_DAY,
  DEFAULT_MESSAGES_PER_DAY,
} from '../lib/usage_meter.js';

// Pin the clock. 2026-06-15T12:00Z and the day before for rollover tests.
const DAY1 = Date.parse('2026-06-15T12:00:00Z'); // 2026-06-15 (UTC)
const DAY0 = Date.parse('2026-06-14T12:00:00Z'); // 2026-06-14 (UTC)
const A = 'alice@biz.co';
const B = 'bob@biz.co';

describe('dayKey', () => {
  it('returns the UTC calendar day, matching server.js todayKey()', () => {
    expect(dayKey(DAY1)).toBe('2026-06-15');
    // 23:30 UTC is still the same UTC day even though it's next-day in London.
    expect(dayKey(Date.parse('2026-06-15T23:30:00Z'))).toBe('2026-06-15');
  });
});

describe('recordOwnerUsage — accumulation', () => {
  it('accumulates tokens, components, and messages across calls', () => {
    let s = {};
    s = recordOwnerUsage(s, A, { inputTokens: 100, outputTokens: 40, now: DAY1 });
    s = recordOwnerUsage(s, A, { inputTokens: 60, outputTokens: 10, now: DAY1 });
    const b = s[A]['2026-06-15'];
    expect(b.inputTokens).toBe(160);
    expect(b.outputTokens).toBe(50);
    expect(b.tokens).toBe(210); // derived = input + output, never drifts
    expect(b.messages).toBe(2); // default messages=1 per call
  });

  it('defaults messages to 1 but honours messages:0 (token-only record)', () => {
    let s = {};
    s = recordOwnerUsage(s, A, { inputTokens: 10, outputTokens: 5, messages: 0, now: DAY1 });
    const b = s[A]['2026-06-15'];
    expect(b.tokens).toBe(15);
    expect(b.messages).toBe(0);
  });

  it('does NOT mutate the input state (returns a new object to persist)', () => {
    const s0 = {};
    const s1 = recordOwnerUsage(s0, A, { inputTokens: 100, outputTokens: 0, now: DAY1 });
    expect(s0).toEqual({}); // original untouched
    expect(s1).not.toBe(s0);
    expect(s1[A]['2026-06-15'].tokens).toBe(100);

    // A second record must not retroactively mutate the previously returned state.
    const s2 = recordOwnerUsage(s1, A, { inputTokens: 50, outputTokens: 0, now: DAY1 });
    expect(s1[A]['2026-06-15'].tokens).toBe(100); // s1 still 100
    expect(s2[A]['2026-06-15'].tokens).toBe(150);
  });

  it('coerces NaN / negative / undefined token counts to 0 (no poisoning the bucket)', () => {
    let s = {};
    s = recordOwnerUsage(s, A, { inputTokens: -50, outputTokens: NaN, now: DAY1 });
    s = recordOwnerUsage(s, A, { inputTokens: undefined, outputTokens: 30, now: DAY1 });
    const b = s[A]['2026-06-15'];
    expect(b.tokens).toBe(30); // only the valid 30 counts
  });

  it('floors fractional messages and clamps negative messages to 0', () => {
    let s = {};
    s = recordOwnerUsage(s, A, { inputTokens: 5, messages: 2.7, now: DAY1 });
    expect(s[A]['2026-06-15'].messages).toBe(2); // 2.7 -> floor 2, never round up
    s = recordOwnerUsage(s, A, { inputTokens: 5, messages: -3, now: DAY1 });
    expect(s[A]['2026-06-15'].messages).toBe(2); // -3 contributes 0, total unchanged
  });

  it('is a no-op when ownerEmail is missing (fail safe, never throws)', () => {
    const s0 = { existing: { '2026-06-15': { tokens: 5, inputTokens: 5, outputTokens: 0, messages: 1 } } };
    const s1 = recordOwnerUsage(s0, '', { inputTokens: 100, outputTokens: 100, now: DAY1 });
    expect(s1).toEqual(s0); // unchanged
  });
});

describe('per-owner isolation', () => {
  it("owner A's usage does not affect owner B's bucket or budget", () => {
    let s = {};
    // A burns a lot; B does nothing.
    s = recordOwnerUsage(s, A, { inputTokens: 9000, outputTokens: 9000, now: DAY1 });

    const aCheck = checkOwnerBudget(s, A, { tokensPerDay: 10000, now: DAY1 });
    const bCheck = checkOwnerBudget(s, B, { tokensPerDay: 10000, now: DAY1 });

    expect(aCheck.usedTokens).toBe(18000);
    expect(aCheck.allowed).toBe(false); // A is over
    expect(bCheck.usedTokens).toBe(0);
    expect(bCheck.allowed).toBe(true); // B completely unaffected — the whole point
  });

  it('recording for B does not touch A', () => {
    let s = {};
    s = recordOwnerUsage(s, A, { inputTokens: 100, outputTokens: 0, now: DAY1 });
    s = recordOwnerUsage(s, B, { inputTokens: 999, outputTokens: 0, now: DAY1 });
    expect(s[A]['2026-06-15'].tokens).toBe(100);
    expect(s[B]['2026-06-15'].tokens).toBe(999);
  });
});

describe('checkOwnerBudget — cap enforcement at the boundary', () => {
  it('blocks at exactly the token cap (>=, matching global checkBudget)', () => {
    let s = {};
    s = recordOwnerUsage(s, A, { inputTokens: 4999, outputTokens: 0, messages: 0, now: DAY1 });
    expect(checkOwnerBudget(s, A, { tokensPerDay: 5000, now: DAY1 }).allowed).toBe(true);

    s = recordOwnerUsage(s, A, { inputTokens: 1, outputTokens: 0, messages: 0, now: DAY1 }); // now 5000
    const at = checkOwnerBudget(s, A, { tokensPerDay: 5000, now: DAY1 });
    expect(at.usedTokens).toBe(5000);
    expect(at.allowed).toBe(false); // boundary is blocked
    expect(at.remainingTokens).toBe(0);
    expect(at.blockedBy).toBe('tokens');
  });

  it('blocks on the MESSAGE cap independently of tokens', () => {
    let s = {};
    // Tiny tokens, but hit the message cap.
    for (let i = 0; i < 3; i++) s = recordOwnerUsage(s, A, { inputTokens: 1, outputTokens: 1, now: DAY1 });
    const res = checkOwnerBudget(s, A, { tokensPerDay: 1_000_000, messagesPerDay: 3, now: DAY1 });
    expect(res.usedMessages).toBe(3);
    expect(res.allowed).toBe(false);
    expect(res.blockedBy).toBe('messages');
    expect(res.remainingMessages).toBe(0);
  });

  it('uses generous defaults when caps are unset (nothing breaks)', () => {
    let s = {};
    s = recordOwnerUsage(s, A, { inputTokens: 1000, outputTokens: 1000, now: DAY1 });
    const res = checkOwnerBudget(s, A, { now: DAY1 });
    expect(res.capTokens).toBe(DEFAULT_TOKENS_PER_DAY);
    expect(res.capMessages).toBe(DEFAULT_MESSAGES_PER_DAY);
    expect(res.allowed).toBe(true);
  });

  it('treats a zero/invalid cap override as "use the default", never a 0 cap', () => {
    const s = {};
    const res = checkOwnerBudget(s, A, { tokensPerDay: 0, messagesPerDay: -5, now: DAY1 });
    expect(res.capTokens).toBe(DEFAULT_TOKENS_PER_DAY);
    expect(res.capMessages).toBe(DEFAULT_MESSAGES_PER_DAY);
    expect(res.allowed).toBe(true); // an empty owner is never blocked by a phantom 0 cap
  });

  it('an unknown owner is always allowed with zero usage', () => {
    const res = checkOwnerBudget({}, 'never-seen@biz.co', { tokensPerDay: 100, now: DAY1 });
    expect(res.usedTokens).toBe(0);
    expect(res.usedMessages).toBe(0);
    expect(res.allowed).toBe(true);
    expect(res.blockedBy).toBe(null);
  });

  it('reports remainingMessages correctly while still under both caps', () => {
    let s = {};
    for (let i = 0; i < 2; i++) s = recordOwnerUsage(s, A, { inputTokens: 1, outputTokens: 1, now: DAY1 });
    const res = checkOwnerBudget(s, A, { tokensPerDay: 1000, messagesPerDay: 5, now: DAY1 });
    expect(res.allowed).toBe(true);
    expect(res.remainingMessages).toBe(3); // 5 cap - 2 used
    expect(res.remainingTokens).toBe(996); // 1000 cap - 4 tokens used
    expect(res.blockedBy).toBe(null);
  });

  it('reports tokens as blockedBy when BOTH caps are tripped (tokens checked first)', () => {
    let s = {};
    s = recordOwnerUsage(s, A, { inputTokens: 10000, outputTokens: 0, now: DAY1 }); // 1 msg, 10k tok
    const res = checkOwnerBudget(s, A, { tokensPerDay: 5000, messagesPerDay: 1, now: DAY1 });
    expect(res.allowed).toBe(false);
    expect(res.blockedBy).toBe('tokens'); // deterministic precedence, not 'messages'
  });
});

describe('day rollover', () => {
  it("yesterday's usage does not count against today's cap", () => {
    let s = {};
    // Owner maxed out yesterday.
    s = recordOwnerUsage(s, A, { inputTokens: 5000, outputTokens: 0, now: DAY0 });
    expect(checkOwnerBudget(s, A, { tokensPerDay: 5000, now: DAY0 }).allowed).toBe(false); // blocked yesterday

    // Same state, but "now" is the next day → fresh bucket, allowed again.
    const today = checkOwnerBudget(s, A, { tokensPerDay: 5000, now: DAY1 });
    expect(today.usedTokens).toBe(0);
    expect(today.allowed).toBe(true);
  });

  it('records into separate buckets per day', () => {
    let s = {};
    s = recordOwnerUsage(s, A, { inputTokens: 100, outputTokens: 0, now: DAY0 });
    s = recordOwnerUsage(s, A, { inputTokens: 200, outputTokens: 0, now: DAY1 });
    expect(s[A]['2026-06-14'].tokens).toBe(100);
    expect(s[A]['2026-06-15'].tokens).toBe(200);
  });
});

describe('ownerUsageSummary — rollup', () => {
  it('sums the trailing window and reports today separately', () => {
    let s = {};
    s = recordOwnerUsage(s, A, { inputTokens: 100, outputTokens: 50, now: DAY0 }); // yesterday: 150 tok, 1 msg
    s = recordOwnerUsage(s, A, { inputTokens: 200, outputTokens: 80, now: DAY1 }); // today: 280 tok, 1 msg
    s = recordOwnerUsage(s, A, { inputTokens: 20, outputTokens: 0, now: DAY1 });  // today: +20 tok, +1 msg

    const sum = ownerUsageSummary(s, A, { now: DAY1, days: 30 });
    expect(sum.today.day).toBe('2026-06-15');
    expect(sum.today.tokens).toBe(300); // 280 + 20
    expect(sum.today.messages).toBe(2);
    expect(sum.totalTokens).toBe(450); // 150 + 300
    expect(sum.totalMessages).toBe(3);
    expect(sum.activeDays).toBe(2);
    expect(sum.windowDays).toBe(30);
    // Est cost mirrors server.js Haiku rates: input*0.8/M + output*4/M, rounded
    // to 4dp (same +(...).toFixed(4) as server.js trackUsage).
    // input total = 100+200+20 = 320, output total = 50+80 = 130.
    const expectedCost = +(320 * (0.8 / 1e6) + 130 * (4 / 1e6)).toFixed(4);
    expect(sum.estCostUsd).toBe(expectedCost);
  });

  it('newest-first series has one entry per day in the window with today first', () => {
    let s = {};
    s = recordOwnerUsage(s, A, { inputTokens: 10, outputTokens: 0, now: DAY1 });
    const sum = ownerUsageSummary(s, A, { now: DAY1, days: 7 });
    expect(sum.series.length).toBe(7);
    expect(sum.series[0].day).toBe('2026-06-15'); // today first
    expect(sum.series[0].tokens).toBe(10);
    expect(sum.series[1].day).toBe('2026-06-14'); // then yesterday
    expect(sum.series[6].day).toBe('2026-06-09'); // 7th-back
  });

  it('excludes days outside the window (a 1-day window only sees today)', () => {
    let s = {};
    s = recordOwnerUsage(s, A, { inputTokens: 999, outputTokens: 0, now: DAY0 }); // yesterday
    s = recordOwnerUsage(s, A, { inputTokens: 5, outputTokens: 0, now: DAY1 });   // today
    const sum = ownerUsageSummary(s, A, { now: DAY1, days: 1 });
    expect(sum.totalTokens).toBe(5); // yesterday's 999 is outside the 1-day window
    expect(sum.series.length).toBe(1);
  });

  it('clamps days:0 and negative days to a 1-day window (not the 30-day default)', () => {
    let s = {};
    s = recordOwnerUsage(s, A, { inputTokens: 999, outputTokens: 0, now: DAY0 }); // yesterday
    s = recordOwnerUsage(s, A, { inputTokens: 5, outputTokens: 0, now: DAY1 });   // today
    // Regression guard: `|| 30` must not swallow a 0 back into the default.
    const zero = ownerUsageSummary(s, A, { now: DAY1, days: 0 });
    expect(zero.windowDays).toBe(1);
    expect(zero.totalTokens).toBe(5); // only today, yesterday's 999 excluded
    expect(zero.series.length).toBe(1);

    const neg = ownerUsageSummary(s, A, { now: DAY1, days: -3 });
    expect(neg.windowDays).toBe(1);
    expect(neg.series.length).toBe(1);
  });

  it('uses the 30-day default when days is omitted', () => {
    const sum = ownerUsageSummary({}, A, { now: DAY1 });
    expect(sum.windowDays).toBe(30);
    expect(sum.series.length).toBe(30);
  });

  it('floors a fractional days window', () => {
    const sum = ownerUsageSummary({}, A, { now: DAY1, days: 7.9 });
    expect(sum.windowDays).toBe(7);
    expect(sum.series.length).toBe(7);
  });

  it('returns zeros for an unknown owner without throwing', () => {
    const sum = ownerUsageSummary({}, 'ghost@biz.co', { now: DAY1, days: 30 });
    expect(sum.totalTokens).toBe(0);
    expect(sum.totalMessages).toBe(0);
    expect(sum.activeDays).toBe(0);
    expect(sum.estCostUsd).toBe(0);
    expect(sum.series.length).toBe(30);
  });
});
