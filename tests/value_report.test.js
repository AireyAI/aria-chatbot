import { describe, it, expect } from 'vitest';
import {
  buildValueReport,
  renderValueReportHtml,
  DEFAULT_VALUE_MODEL,
} from '../lib/value_report.js';

// Pin "now" so every window test is deterministic.
const NOW = Date.parse('2026-06-15T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(NOW - days * DAY).toISOString();

describe('buildValueReport — window filtering', () => {
  it('counts only items inside the trailing window', () => {
    const leads = [
      { ts: ago(1), qualification_score: 80 },   // hot, in window
      { ts: ago(29), qualification_score: 50 },  // warm, in window (boundary-ish)
      { ts: ago(45), qualification_score: 90 },  // hot but OUTSIDE 30d → ignored
    ];
    const bookings = [
      { ts: ago(2) },                            // in window
      { ts: ago(40) },                           // outside → ignored
    ];
    const messages = [
      { timestamp: ago(0) },                     // in window
      { timestamp: ago(10) },                    // in window
      { timestamp: ago(31) },                    // outside → ignored
    ];
    const r = buildValueReport({ leads, bookings, messages, windowDays: 30, now: NOW });
    expect(r.chatsHandled).toBe(2);
    expect(r.hotLeads).toBe(1);
    expect(r.leadsCaptured).toBe(2); // 1 hot + 1 warm in window
    expect(r.breakdown.warmLeads).toBe(1);
    expect(r.bookingsCount).toBe(1);
  });

  it('honours the exact window boundary and excludes future-dated rows', () => {
    const justInside = new Date(NOW - 30 * DAY + 1000).toISOString();
    const justOutside = new Date(NOW - 30 * DAY - 1000).toISOString();
    const future = new Date(NOW + 60 * 1000).toISOString();
    const leads = [
      { ts: justInside, qualification_score: 75 },
      { ts: justOutside, qualification_score: 75 },
      { ts: future, qualification_score: 75 },
    ];
    const r = buildValueReport({ leads, windowDays: 30, now: NOW });
    expect(r.hotLeads).toBe(1); // only justInside; future is excluded
  });

  it('respects a custom windowDays (7-day window)', () => {
    const leads = [
      { ts: ago(3), qualification_score: 80 },   // in 7d
      { ts: ago(10), qualification_score: 80 },  // outside 7d
    ];
    const r = buildValueReport({ leads, windowDays: 7, now: NOW });
    expect(r.hotLeads).toBe(1);
    expect(r.windowDays).toBe(7);
  });

  it('excludes rows with missing or unparseable timestamps', () => {
    const leads = [
      { qualification_score: 90 },                 // no ts
      { ts: 'not-a-date', qualification_score: 90 },
      { ts: ago(1), qualification_score: 90 },     // valid
    ];
    const r = buildValueReport({ leads, now: NOW });
    expect(r.hotLeads).toBe(1);
  });
});

describe('buildValueReport — both lead sources + classification', () => {
  it('unifies leads.jsonl (numeric score) and channel_leads.jsonl (string tag)', () => {
    const leads = [
      { ts: ago(1), qualification_score: 70 },   // hot (>= 70)
      { ts: ago(2), qualification_score: 40 },   // warm (>= 40)
      { ts: ago(3), qualification_score: 39 },   // cold → not a lead
    ];
    const channelLeads = [
      { ts: ago(1), leadScore: 'hot' },
      { ts: ago(2), leadScore: 'warm' },
      { ts: ago(3), leadScore: 'cold' },         // not counted
      { ts: ago(4), leadScore: 'HOT' },          // case-insensitive
    ];
    const r = buildValueReport({ leads, channelLeads, now: NOW });
    expect(r.hotLeads).toBe(3);  // 1 numeric hot + 2 channel hot
    expect(r.breakdown.warmLeads).toBe(2); // 1 numeric warm + 1 channel warm
    expect(r.leadsCaptured).toBe(5);
  });

  it('treats numeric score 69 as warm and 70 as hot (boundary)', () => {
    const leads = [
      { ts: ago(1), qualification_score: 69 },
      { ts: ago(1), qualification_score: 70 },
    ];
    const r = buildValueReport({ leads, now: NOW });
    expect(r.hotLeads).toBe(1);
    expect(r.breakdown.warmLeads).toBe(1);
  });

  it('applies the trailing window to channelLeads as well as leads', () => {
    // Regression guard: channelLeads must be window-filtered on its OWN ts,
    // not waved through. Only the in-window channel rows should count.
    const channelLeads = [
      { ts: ago(1), leadScore: 'hot' },    // in window
      { ts: ago(45), leadScore: 'hot' },   // outside 30d → ignored
      { ts: ago(50), leadScore: 'warm' },  // outside 30d → ignored
    ];
    const r = buildValueReport({ channelLeads, windowDays: 30, now: NOW });
    expect(r.hotLeads).toBe(1);
    expect(r.leadsCaptured).toBe(1);
  });

  it('ignores numeric scores below the warm threshold and non-lead tags', () => {
    const leads = [{ ts: ago(1), qualification_score: 39 }]; // below 40 → cold
    const channelLeads = [
      { ts: ago(1), leadScore: 'cold' },
      { ts: ago(1), leadScore: 'unknown' },
      { ts: ago(1) }, // no leadScore at all
    ];
    const r = buildValueReport({ leads, channelLeads, now: NOW });
    expect(r.leadsCaptured).toBe(0);
    expect(r.hotLeads).toBe(0);
    expect(r.breakdown.warmLeads).toBe(0);
    expect(r.estValueGBP).toBe(0);
  });
});

describe('buildValueReport — real-data timestamp shapes', () => {
  it('counts a booking by its epoch `ts` even when `datetime` is free-text', () => {
    // data/bookings.json carries both an epoch `ts` (record creation) and a
    // free-text `datetime` ("next Tuesday 3pm") extracted from the message.
    // The window must key off the parseable `ts`, never the free-text string.
    const bookings = [
      { ts: NOW - 1 * DAY, datetime: 'next Tuesday at 3pm', service: 'boiler' },
    ];
    const r = buildValueReport({ bookings, now: NOW });
    expect(r.bookingsCount).toBe(1);
  });

  it('drops a booking whose only date is unparseable free-text (no ts)', () => {
    const bookings = [{ datetime: 'sometime next week', service: 'boiler' }];
    const r = buildValueReport({ bookings, now: NOW });
    expect(r.bookingsCount).toBe(0); // unparseable → excluded, never inflated
  });

  it('counts a chat by `ts` when `timestamp` is absent', () => {
    // Defensive: some channel rows may carry `ts` instead of `timestamp`.
    const messages = [
      { ts: ago(1) },          // counted via ts fallback
      { timestamp: ago(2) },   // counted via timestamp
      { ts: ago(40) },         // outside window → ignored
    ];
    const r = buildValueReport({ messages, now: NOW });
    expect(r.chatsHandled).toBe(2);
  });
});

describe('buildValueReport — value math', () => {
  it('uses default value model and de-dups bookings against leads', () => {
    // 2 bookings, 3 hot leads, 1 warm lead.
    // Bookings consume hot leads first: 2 of the 3 hot leads are attributed to
    // bookings; 1 hot + 1 warm remain creditable as lead value.
    const leads = [
      { ts: ago(1), qualification_score: 90 },
      { ts: ago(1), qualification_score: 90 },
      { ts: ago(1), qualification_score: 90 },
      { ts: ago(1), qualification_score: 50 },
    ];
    const bookings = [{ ts: ago(1) }, { ts: ago(2) }];
    const r = buildValueReport({ leads, bookings, now: NOW });

    const m = DEFAULT_VALUE_MODEL;
    const expected =
      2 * m.perBooking +   // bookings
      1 * m.perHotLead +   // 1 leftover hot
      1 * m.perWarmLead;   // 1 warm
    expect(r.estValueGBP).toBe(expected);
    expect(r.breakdown.leadsAttributedToBookings).toBe(2);
    expect(r.breakdown.hotLeadsCreditedAsLead).toBe(1);
    expect(r.breakdown.warmLeadsCreditedAsLead).toBe(1);
    expect(r.breakdown.bookingValueGBP).toBe(2 * m.perBooking);
  });

  it('does not let bookings credit lead value twice when bookings exceed leads', () => {
    // 3 bookings but only 1 hot lead — bookings consume the 1 hot lead,
    // leaving zero creditable lead value; value = bookings only.
    const leads = [{ ts: ago(1), qualification_score: 95 }];
    const bookings = [{ ts: ago(1) }, { ts: ago(1) }, { ts: ago(1) }];
    const r = buildValueReport({ leads, bookings, now: NOW });
    expect(r.estValueGBP).toBe(3 * DEFAULT_VALUE_MODEL.perBooking);
    expect(r.breakdown.hotLeadValueGBP).toBe(0);
    expect(r.breakdown.warmLeadValueGBP).toBe(0);
  });

  it('honours an overridden value model', () => {
    const leads = [{ ts: ago(1), qualification_score: 80 }]; // 1 hot, no bookings
    const r = buildValueReport({
      leads,
      now: NOW,
      valueModel: { perHotLead: 500 },
    });
    expect(r.estValueGBP).toBe(500);
    expect(r.breakdown.valueModel.perHotLead).toBe(500);
    // un-overridden keys fall back to defaults
    expect(r.breakdown.valueModel.perBooking).toBe(DEFAULT_VALUE_MODEL.perBooking);
  });

  it('consumes hot leads first then warm when bookings exceed hot count', () => {
    // 4 bookings, 2 hot, 3 warm. Bookings consume both hot leads, then 2 of
    // the 3 warm leads. Only 1 warm lead survives as creditable lead value.
    const leads = [
      { ts: ago(1), qualification_score: 90 },
      { ts: ago(1), qualification_score: 90 },
      { ts: ago(1), qualification_score: 50 },
      { ts: ago(1), qualification_score: 50 },
      { ts: ago(1), qualification_score: 50 },
    ];
    const bookings = [{ ts: ago(1) }, { ts: ago(1) }, { ts: ago(1) }, { ts: ago(1) }];
    const r = buildValueReport({ leads, bookings, now: NOW });
    const m = DEFAULT_VALUE_MODEL;

    expect(r.breakdown.leadsAttributedToBookings).toBe(4); // 2 hot + 2 warm consumed
    expect(r.breakdown.hotLeadsCreditedAsLead).toBe(0);
    expect(r.breakdown.warmLeadsCreditedAsLead).toBe(1);
    expect(r.breakdown.hotLeadValueGBP).toBe(0);
    expect(r.breakdown.warmLeadValueGBP).toBe(1 * m.perWarmLead);
    expect(r.estValueGBP).toBe(4 * m.perBooking + 1 * m.perWarmLead);
  });

  it('rounds the TOTAL estimate (not just per-line) for fractional models', () => {
    // 1 hot + 1 warm, no bookings, fractional rates. Sum = 10.5 + 4.5 = 15.0
    // here, so to make rounding observable use rates that sum to a .5 boundary.
    const leads = [
      { ts: ago(1), qualification_score: 90 }, // hot
      { ts: ago(1), qualification_score: 50 }, // warm
    ];
    const r = buildValueReport({
      leads,
      now: NOW,
      valueModel: { perHotLead: 10.2, perWarmLead: 4.5 },
    });
    // raw total 14.7 → Math.round → 15
    expect(r.estValueGBP).toBe(15);
    expect(Number.isInteger(r.estValueGBP)).toBe(true);
  });

  it('values leads-only (no bookings) at full lead rates', () => {
    const leads = [
      { ts: ago(1), qualification_score: 80 }, // hot
      { ts: ago(1), qualification_score: 50 }, // warm
    ];
    const r = buildValueReport({ leads, now: NOW });
    expect(r.estValueGBP).toBe(DEFAULT_VALUE_MODEL.perHotLead + DEFAULT_VALUE_MODEL.perWarmLead);
  });
});

describe('buildValueReport — empty data', () => {
  it('returns all zeros for no input', () => {
    const r = buildValueReport({ now: NOW });
    expect(r.chatsHandled).toBe(0);
    expect(r.leadsCaptured).toBe(0);
    expect(r.hotLeads).toBe(0);
    expect(r.bookingsCount).toBe(0);
    expect(r.estValueGBP).toBe(0);
    expect(r.windowDays).toBe(30);
    expect(typeof r.periodLabel).toBe('string');
    expect(r.periodLabel.length).toBeGreaterThan(0);
  });

  it('survives being called with no args at all', () => {
    const r = buildValueReport();
    expect(r.estValueGBP).toBe(0);
    expect(r.chatsHandled).toBe(0);
  });

  it('coerces a bogus windowDays back to the 30-day default', () => {
    const r = buildValueReport({ windowDays: 0, now: NOW });
    expect(r.windowDays).toBe(30);
    const r2 = buildValueReport({ windowDays: -5, now: NOW });
    expect(r2.windowDays).toBe(30);
  });
});

describe('renderValueReportHtml', () => {
  it('renders the headline value and the numbers for a populated report', () => {
    const report = buildValueReport({
      leads: [{ ts: ago(1), qualification_score: 90 }],
      bookings: [{ ts: ago(1) }],
      messages: [{ timestamp: ago(1) }, { timestamp: ago(2) }],
      now: NOW,
    });
    const html = renderValueReportHtml(report, { businessName: 'Joe Plumbing' });
    expect(html).toContain('Joe Plumbing');
    expect(html).toContain(`£${report.estValueGBP}`);
    expect(html).toContain('Chats handled');
    expect(html).toContain('Jobs booked');
    // value-math explainer present when value > 0
    expect(html).toContain('How we estimate this');
  });

  it('renders graceful, non-alarming HTML for an empty month', () => {
    const report = buildValueReport({ now: NOW });
    const html = renderValueReportHtml(report, { businessName: 'Quiet Co' });
    expect(html).toContain('Quiet Co');
    expect(html).toContain('ready and waiting');
    // no value-math block when there's no value
    expect(html).not.toContain('How we estimate this');
    // still well-formed-ish: contains the stat grid labels
    expect(html).toContain('Hot leads');
  });

  it('falls back to a generic business name when none provided', () => {
    const report = buildValueReport({ now: NOW });
    const html = renderValueReportHtml(report);
    expect(html).toContain('your business');
  });

  it('uses singular wording for exactly one of each', () => {
    const report = buildValueReport({
      leads: [{ ts: ago(1), qualification_score: 90 }], // 1 lead (hot)
      bookings: [{ ts: ago(1) }],                       // 1 booking
      messages: [{ timestamp: ago(1) }],                // 1 chat
      now: NOW,
    });
    const html = renderValueReportHtml(report, { businessName: 'Solo Co' });
    expect(html).toContain('1 chat,');
    expect(html).toContain('1 lead captured');
    expect(html).toContain('1 job booked');
    expect(html).not.toContain('1 chats');
    expect(html).not.toContain('1 leads');
    expect(html).not.toContain('1 jobs');
  });

  it('uses plural wording for multiple of each', () => {
    const report = buildValueReport({
      leads: [
        { ts: ago(1), qualification_score: 90 },
        { ts: ago(1), qualification_score: 50 },
      ],
      bookings: [{ ts: ago(1) }, { ts: ago(2) }],
      messages: [{ timestamp: ago(1) }, { timestamp: ago(2) }, { timestamp: ago(3) }],
      now: NOW,
    });
    const html = renderValueReportHtml(report, { businessName: 'Busy Co' });
    expect(html).toContain('3 chats');
    expect(html).toContain('2 leads captured');
    expect(html).toContain('2 jobs booked');
  });

  it('escapes HTML in the business name', () => {
    const report = buildValueReport({ now: NOW });
    const html = renderValueReportHtml(report, { businessName: '<script>x</script>' });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('tolerates being called with a null/undefined report', () => {
    const html = renderValueReportHtml(null, { businessName: 'X' });
    expect(typeof html).toBe('string');
    expect(html).toContain('X');
  });
});
