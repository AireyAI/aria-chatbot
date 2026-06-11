// Wave-1 bot-upgrade unit tests (REDESIGN-SPEC Part 3).
// Covers the new PURE helpers added for W1 (missed-call text-back) — the
// scheduler handlers themselves live in server.js and are exercised by the
// running app, but the classification + business-hours maths are the parts
// with real branching, so they get direct coverage here.

import { describe, it, expect } from 'vitest';
import { isMissedCall } from '../lib/vapi_handler.js';
import { nextOpenTime, evaluateSchedule } from '../lib/business_hours.js';

// ── W1: isMissedCall ─────────────────────────────────────────────────────

describe('isMissedCall (W1 missed-call text-back)', () => {
  it('true for ring-out / declined endedReasons', () => {
    expect(isMissedCall({ endedReason: 'customer-did-not-answer' })).toBe(true);
    expect(isMissedCall({ endedReason: 'customer-busy' })).toBe(true);
    expect(isMissedCall({ endedReason: 'voicemail' })).toBe(true);
    expect(isMissedCall({ endedReason: 'assistant-request-returned-error' })).toBe(true);
  });

  it('true for short-abandon: hung up in seconds with no real transcript', () => {
    expect(isMissedCall({ endedReason: 'customer-ended-call', durationSec: 4, transcript: '' })).toBe(true);
    expect(isMissedCall({ endedReason: 'customer-ended-call', durationSec: 8, transcript: 'Hello?' })).toBe(true);
  });

  it('false when the caller actually spoke to Aria (real intent extracted)', () => {
    expect(isMissedCall({
      endedReason: 'customer-ended-call', durationSec: 95,
      structured: { intent: 'booking', summary: 'Booked a gutter clean' },
      transcript: 'long conversation...',
    })).toBe(false);
    // Even a "missed-looking" reason is overridden by a real outcome —
    // the booked/quote follow-up path owns those callers.
    expect(isMissedCall({ endedReason: 'voicemail', structured: { intent: 'quote' } })).toBe(false);
  });

  it('false for a normal-length call with no missed signal', () => {
    expect(isMissedCall({
      endedReason: 'customer-ended-call', durationSec: 60,
      structured: { intent: 'other' },
      transcript: 'A real back-and-forth conversation that went nowhere actionable but happened.',
    })).toBe(false);
  });
});

// ── W1: nextOpenTime ─────────────────────────────────────────────────────

const HOURS_9_17 = { mon: '9-17', tue: '9-17', wed: '9-17', thu: '9-17', fri: '9-17', sat: 'closed', sun: 'closed' };

// Build a UTC timestamp for a given 2026 date/time. Europe/London is UTC+0
// in January, so local == UTC and the assertions stay timezone-exact.
const jan = (day, hour, min = 0) => Date.UTC(2026, 0, day, hour, min);

describe('nextOpenTime (W1 business-hours gating)', () => {
  const sched = { mode: 'business_hours', businessHours: HOURS_9_17, timezone: 'Europe/London' };

  it('returns fromTs unchanged when already in-hours', () => {
    const t = jan(5, 11); // Mon 5 Jan 2026, 11:00 — open
    expect(evaluateSchedule(sched, t).inHours).toBe(true);
    expect(nextOpenTime(sched, t)).toBe(t);
  });

  it('returns fromTs for mode always', () => {
    const t = jan(4, 3); // Sun 03:00
    expect(nextOpenTime({ mode: 'always' }, t)).toBe(t);
  });

  it('rolls an out-of-hours evening forward to the next morning opening', () => {
    const t = jan(5, 20); // Mon 20:00 — closed
    const next = nextOpenTime(sched, t);
    expect(next).not.toBeNull();
    const evalAt = evaluateSchedule(sched, next);
    expect(evalAt.inHours).toBe(true);
    // Next open window is Tue 09:00 — allow the 15-min scan granularity.
    expect(next).toBeGreaterThanOrEqual(jan(6, 9));
    expect(next).toBeLessThanOrEqual(jan(6, 9, 15));
  });

  it('skips a closed weekend to Monday', () => {
    const t = jan(3, 12); // Sat 3 Jan 2026, 12:00 — closed all weekend
    const next = nextOpenTime(sched, t);
    expect(next).toBeGreaterThanOrEqual(jan(5, 9));
    expect(next).toBeLessThanOrEqual(jan(5, 9, 15));
  });

  it('returns null when every day is closed (caller decides the fallback)', () => {
    const allClosed = {
      mode: 'business_hours',
      businessHours: { mon: 'closed', tue: 'closed', wed: 'closed', thu: 'closed', fri: 'closed', sat: 'closed', sun: 'closed' },
      timezone: 'Europe/London',
    };
    expect(nextOpenTime(allClosed, jan(5, 12))).toBeNull();
  });
});
