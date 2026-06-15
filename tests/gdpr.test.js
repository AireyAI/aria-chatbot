// gdpr.test.js
//
// Regression suite for lib/gdpr.js — the data-retention + subject-rights logic
// over Aria's append-only lead ledgers. These tests encode WHY the behaviour
// matters (UK GDPR: storage limitation, Art.15 access, Art.17 erasure), not
// just that functions return something:
//
//   - retention cutoff is boundary-exact (exactly retentionDays old is KEPT;
//     one ms older is REMOVED) — purging a day early is a data-loss bug.
//   - email match is case-insensitive (a subject typing "Bob@X.com" must reach
//     records logged as "bob@x.com").
//   - phone match tolerates +44 vs 0 vs spaces (the same UK mobile written
//     three ways is one subject) — getting this wrong silently fails an
//     erasure request, leaving PII behind.
//   - an empty/unknown subject NEVER matches everyone (never wipe the store).
//   - erasure removes ONLY the subject, leaving every other person intact.
//   - the THREE real stores have different shapes (verified against server.js,
//     not assumed): leads.jsonl carries top-level email/phone + ISO `ts`;
//     channel_leads.jsonl nests contact + ISO `ts`; channel-messages.json has
//     NO email/phone (only senderId/senderName) and uses `timestamp`, not `ts`.
//     Purge and subject-rights must work on all three or PII leaks past
//     retention / survives an erasure request.

import { describe, it, expect } from 'vitest';
import { purgeExpired, subjectAccessExport, redactSubject } from '../lib/gdpr.js';

const DAY = 24 * 60 * 60 * 1000;
// Pin "now" so the retention cutoff is deterministic.
const NOW = Date.parse('2026-06-15T12:00:00Z');

describe('purgeExpired — storage limitation cutoff', () => {
  it('keeps a row exactly retentionDays old (boundary is inclusive)', () => {
    const rows = [{ ts: NOW - 365 * DAY, email: 'a@x.com' }];
    const { kept, removed, removedCount } = purgeExpired(rows, {
      retentionDays: 365,
      now: NOW,
    });
    expect(removedCount).toBe(0);
    expect(removed).toEqual([]);
    expect(kept).toHaveLength(1);
  });

  it('removes a row one millisecond past the window', () => {
    const rows = [{ ts: NOW - 365 * DAY - 1, email: 'a@x.com' }];
    const { kept, removed, removedCount } = purgeExpired(rows, {
      retentionDays: 365,
      now: NOW,
    });
    expect(removedCount).toBe(1);
    expect(kept).toEqual([]);
    expect(removed).toHaveLength(1);
  });

  it('splits a mixed batch into kept (recent) and removed (stale)', () => {
    const rows = [
      { ts: NOW - 10 * DAY, email: 'recent@x.com' }, // keep
      { ts: NOW - 400 * DAY, email: 'old@x.com' }, // remove
      { ts: NOW, email: 'now@x.com' }, // keep
      { ts: NOW - 366 * DAY, email: 'stale@x.com' }, // remove
    ];
    const { kept, removed, removedCount } = purgeExpired(rows, {
      retentionDays: 365,
      now: NOW,
    });
    expect(removedCount).toBe(2);
    expect(kept.map((r) => r.email)).toEqual([
      'recent@x.com',
      'now@x.com',
    ]);
    expect(removed.map((r) => r.email)).toEqual([
      'old@x.com',
      'stale@x.com',
    ]);
  });

  it('keeps rows whose ts is missing/unreadable (fail safe toward retention)', () => {
    const rows = [
      { email: 'no-ts@x.com' },
      { ts: 'not-a-date', email: 'bad-ts@x.com' },
      { ts: NOW - 999 * DAY, email: 'definitely-old@x.com' },
    ];
    const { kept, removedCount } = purgeExpired(rows, {
      retentionDays: 30,
      now: NOW,
    });
    expect(removedCount).toBe(1); // only the readable, old one
    expect(kept.map((r) => r.email)).toEqual(['no-ts@x.com', 'bad-ts@x.com']);
  });

  it('parses ISO-string timestamps for ageing', () => {
    const rows = [{ ts: '2020-01-01T00:00:00Z', email: 'ancient@x.com' }];
    const { removedCount } = purgeExpired(rows, { retentionDays: 30, now: NOW });
    expect(removedCount).toBe(1);
  });

  it('honours the boundary on an ISO-string ts (real channel_leads.jsonl shape)', () => {
    // server.js writes `ts: new Date().toISOString()`, NOT epoch ms. The cutoff
    // must be boundary-exact on strings too, or live data purges a day early.
    const exactly = new Date(NOW - 365 * DAY).toISOString();
    const oneMsOlder = new Date(NOW - 365 * DAY - 1).toISOString();
    const rows = [
      { ts: exactly, contact: { email: 'edge@x.com' } }, // keep
      { ts: oneMsOlder, contact: { email: 'over@x.com' } }, // remove
    ];
    const { kept, removedCount } = purgeExpired(rows, {
      retentionDays: 365,
      now: NOW,
    });
    expect(removedCount).toBe(1);
    expect(kept.map((r) => r.contact.email)).toEqual(['edge@x.com']);
  });

  it('ages channel-messages.json rows by their `timestamp` field (no `ts`)', () => {
    // channel-messages.json records have `timestamp` (ISO), not `ts`. If purge
    // only read `ts`, every message body would be kept forever — defeating
    // retention on the store that actually holds the message text.
    const rows = [
      { id: 'm1', senderName: 'Bob', message: 'hi', timestamp: new Date(NOW - 10 * DAY).toISOString() }, // keep
      { id: 'm2', senderName: 'Bob', message: 'old', timestamp: new Date(NOW - 400 * DAY).toISOString() }, // remove
    ];
    const { kept, removedCount } = purgeExpired(rows, {
      retentionDays: 365,
      now: NOW,
    });
    expect(removedCount).toBe(1);
    expect(kept.map((r) => r.id)).toEqual(['m1']);
  });

  it('purges nothing when retention is unset/invalid (fail safe)', () => {
    const rows = [{ ts: NOW - 999 * DAY, email: 'old@x.com' }];
    expect(purgeExpired(rows, { now: NOW }).removedCount).toBe(0);
    expect(
      purgeExpired(rows, { retentionDays: -5, now: NOW }).removedCount,
    ).toBe(0);
    expect(
      purgeExpired(rows, { retentionDays: NaN, now: NOW }).removedCount,
    ).toBe(0);
  });

  it('retentionDays:0 removes everything older than this instant but keeps now', () => {
    const rows = [
      { ts: NOW, email: 'now@x.com' },
      { ts: NOW - 1, email: 'a-ms-ago@x.com' },
    ];
    const { kept, removedCount } = purgeExpired(rows, {
      retentionDays: 0,
      now: NOW,
    });
    expect(removedCount).toBe(1);
    expect(kept.map((r) => r.email)).toEqual(['now@x.com']);
  });

  it('handles empty / non-array input', () => {
    expect(purgeExpired([], { retentionDays: 30, now: NOW })).toEqual({
      kept: [],
      removed: [],
      removedCount: 0,
    });
    expect(purgeExpired(undefined, { retentionDays: 30, now: NOW }).kept).toEqual(
      [],
    );
  });

  it('defaults now to the current time when omitted', () => {
    // A row from the far past must purge even without an explicit now.
    const rows = [{ ts: 0, email: 'epoch@x.com' }];
    expect(purgeExpired(rows, { retentionDays: 1 }).removedCount).toBe(1);
  });
});

describe('subjectAccessExport — Art.15 data access', () => {
  const rows = [
    { ts: 1, email: 'Bob@Example.com', name: 'Bob' }, // top-level email
    { ts: 2, email: 'alice@x.com', name: 'Alice' },
    { ts: 3, contact: { email: 'bob@example.com' }, name: 'Bob channel' }, // nested
    { ts: 4, phone: '+44 7497 812186', name: 'Bob phone top' },
    { ts: 5, contact: { phone: '07497812186' }, name: 'Bob phone nested' },
  ];

  it('matches email case-insensitively across top-level and nested contact', () => {
    const out = subjectAccessExport(rows, { email: 'bob@example.com' });
    expect(out.map((r) => r.name)).toEqual(['Bob', 'Bob channel']);
  });

  it('matches the same UK mobile written as +44 and as 0 and with spaces', () => {
    // Subject supplies "07497 812186"; records hold "+44 7497 812186"
    // (top-level) and "07497812186" (nested) — both must come back.
    const out = subjectAccessExport(rows, { phone: '07497 812186' });
    expect(out.map((r) => r.name)).toEqual(['Bob phone top', 'Bob phone nested']);
  });

  it('matches on email OR phone when both are supplied', () => {
    const out = subjectAccessExport(rows, {
      email: 'bob@example.com',
      phone: '+447497812186',
    });
    expect(out.map((r) => r.name)).toEqual([
      'Bob',
      'Bob channel',
      'Bob phone top',
      'Bob phone nested',
    ]);
  });

  it('returns empty for a subject with no records', () => {
    expect(subjectAccessExport(rows, { email: 'nobody@x.com' })).toEqual([]);
    expect(subjectAccessExport(rows, { phone: '+44 1111 000000' })).toEqual([]);
  });

  it('returns empty (never "everyone") when no identifier is given', () => {
    expect(subjectAccessExport(rows, {})).toEqual([]);
    expect(subjectAccessExport(rows, { email: '', phone: '' })).toEqual([]);
    expect(
      subjectAccessExport(rows, { email: '', phone: '', senderId: '', name: '' }),
    ).toEqual([]);
    expect(subjectAccessExport(rows)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const copy = JSON.parse(JSON.stringify(rows));
    subjectAccessExport(rows, { email: 'bob@example.com' });
    expect(rows).toEqual(copy);
  });

  it('does not false-positive on short shared phone suffixes', () => {
    // "12345" (5 digits) must NOT match a longer number ending in 12345 —
    // suffix matching requires >= 7 shared digits.
    const short = [{ ts: 1, phone: '447497812345', name: 'long' }];
    expect(subjectAccessExport(short, { phone: '12345' })).toEqual([]);
  });

  it('matches channel-messages by senderId (records carry no email/phone)', () => {
    // Real channel-messages.json rows: { id, senderId, senderName, message,
    // reply, timestamp } — the only subject handle is senderId. A SAR must
    // still surface these message bodies.
    const msgs = [
      { id: 'm1', senderId: 'wa:447497812186', senderName: 'Bob', message: 'hi' },
      { id: 'm2', senderId: 'wa:447111222333', senderName: 'Carol', message: 'yo' },
      { id: 'm3', senderId: 'wa:447497812186', senderName: 'Bob', message: 'again' },
    ];
    const out = subjectAccessExport(msgs, { senderId: 'wa:447497812186' });
    expect(out.map((r) => r.id)).toEqual(['m1', 'm3']);
  });

  it('matches channel-messages by senderName case-insensitively', () => {
    const msgs = [
      { id: 'm1', senderId: 's1', senderName: 'Bob Smith', message: 'hi' },
      { id: 'm2', senderId: 's2', senderName: 'Alice', message: 'yo' },
    ];
    expect(
      subjectAccessExport(msgs, { name: 'bob smith' }).map((r) => r.id),
    ).toEqual(['m1']);
  });
});

describe('redactSubject — Art.17 erasure', () => {
  const rows = [
    { ts: 1, email: 'Bob@Example.com', name: 'Bob' },
    { ts: 2, email: 'alice@x.com', name: 'Alice' },
    { ts: 3, contact: { phone: '+44 7497 812186' }, name: 'Bob channel' },
    { ts: 4, email: 'carol@x.com', phone: '07111222333', name: 'Carol' },
  ];

  it('removes only the subject, leaving everyone else intact', () => {
    const { kept, removedCount } = redactSubject(rows, {
      email: 'bob@example.com',
      phone: '07497812186',
    });
    expect(removedCount).toBe(2); // Bob (email) + Bob channel (phone)
    expect(kept.map((r) => r.name)).toEqual(['Alice', 'Carol']);
  });

  it('erases by phone only, tolerating +44 vs 0', () => {
    const { kept, removedCount } = redactSubject(rows, { phone: '+447497812186' });
    expect(removedCount).toBe(1);
    expect(kept.map((r) => r.name)).toEqual(['Bob', 'Alice', 'Carol']);
  });

  it('removes nothing for an unknown subject', () => {
    const { kept, removedCount } = redactSubject(rows, { email: 'ghost@x.com' });
    expect(removedCount).toBe(0);
    expect(kept).toHaveLength(rows.length);
  });

  it('removes nothing (never wipes the store) when no identifier is given', () => {
    expect(redactSubject(rows, {}).removedCount).toBe(0);
    expect(redactSubject(rows, {}).kept).toHaveLength(rows.length);
    expect(redactSubject(rows).kept).toHaveLength(rows.length);
    // Empty/blank senderId and name must also never match everyone.
    expect(redactSubject(rows, { senderId: '', name: '' }).removedCount).toBe(0);
    expect(redactSubject(rows, { senderId: null, name: '   ' }).removedCount).toBe(0);
  });

  it('erases channel-messages by senderId, leaving other senders intact', () => {
    const msgs = [
      { id: 'm1', senderId: 'wa:447497812186', senderName: 'Bob', message: 'hi' },
      { id: 'm2', senderId: 'wa:447111222333', senderName: 'Carol', message: 'yo' },
      { id: 'm3', senderId: 'wa:447497812186', senderName: 'Bob', message: 'again' },
    ];
    const { kept, removedCount } = redactSubject(msgs, {
      senderId: 'wa:447497812186',
    });
    expect(removedCount).toBe(2);
    expect(kept.map((r) => r.id)).toEqual(['m2']);
  });

  it('does not let a senderId identifier leak into leads-store rows that lack one', () => {
    // leads rows have no senderId; supplying only senderId must not match them.
    const leads = [
      { ts: 1, email: 'a@x.com' },
      { ts: 2, phone: '07497812186' },
    ];
    expect(redactSubject(leads, { senderId: 'wa:447497812186' }).removedCount).toBe(0);
  });

  it('handles empty / non-array input', () => {
    expect(redactSubject([], { email: 'a@x.com' })).toEqual({
      kept: [],
      removedCount: 0,
    });
    expect(redactSubject(undefined, { email: 'a@x.com' }).removedCount).toBe(0);
  });
});
