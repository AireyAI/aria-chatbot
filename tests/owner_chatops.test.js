// Owner chat-ops tests — the interpreter's deterministic post-processing.
//
// interpretOwnerCommand makes ONE Claude tool-use call (the judgement step),
// then turns the structured tool input into a validated proposal + a
// human-readable summary in plain code. We mock the Claude client so the
// tests cover the parsing/validation/summary logic, not the model.

import { describe, it, expect } from 'vitest';
import { interpretOwnerCommand, OWNER_TOOLS, isClosedOn, localDateISO } from '../lib/owner_chatops.js';

// Minimal fake Anthropic client — returns whatever content we hand it.
function fakeClaude(content) {
  return { messages: { create: async () => ({ content }) } };
}
const toolUse = (name, input) => [{ type: 'tool_use', name, input }];
const textOnly = (t) => [{ type: 'text', text: t }];

describe('OWNER_TOOLS schema', () => {
  it('exposes add_faq + set_business_hours + set_closure', () => {
    expect(OWNER_TOOLS.map(t => t.name).sort()).toEqual(['add_faq', 'set_business_hours', 'set_closure']);
  });
});

describe('add_faq', () => {
  it('returns a structured FAQ proposal with a customer-facing summary', async () => {
    const claude = fakeClaude(toolUse('add_faq', { question: 'Do you do emergency callouts?', answer: 'Yes — 24/7, ring the mobile.' }));
    const r = await interpretOwnerCommand({ messageText: 'tell people we do emergency callouts' }, claude);
    expect(r.action).toBe('add_faq');
    expect(r.payload).toEqual({ question: 'Do you do emergency callouts?', answer: 'Yes — 24/7, ring the mobile.' });
    expect(r.summary).toContain('Do you do emergency callouts?');
  });

  it('falls back to a clarifier when the model returns an empty FAQ', async () => {
    const claude = fakeClaude(toolUse('add_faq', { question: '', answer: '' }));
    const r = await interpretOwnerCommand({ messageText: 'add faq' }, claude);
    expect(r.action).toBe('none');
  });
});

describe('set_business_hours', () => {
  it('expands weekdays + validates the time range', async () => {
    const claude = fakeClaude(toolUse('set_business_hours', { changes: [{ day: 'weekdays', value: '9-17' }] }));
    const r = await interpretOwnerCommand({ messageText: 'open 9 to 5 mon-fri' }, claude);
    expect(r.action).toBe('set_business_hours');
    expect(r.payload.hours).toEqual({ mon: '9-17', tue: '9-17', wed: '9-17', thu: '9-17', fri: '9-17' });
    expect(r.summary).toContain('Monday');
    expect(r.summary).toContain('out-of-hours message'); // owner is told the side-effect
  });

  it('accepts closed + 24h + minute precision', async () => {
    const claude = fakeClaude(toolUse('set_business_hours', { changes: [
      { day: 'sun', value: 'closed' },
      { day: 'sat', value: '24/7' },
      { day: 'fri', value: '8:30-17:30' },
    ] }));
    const r = await interpretOwnerCommand({ messageText: '...' }, claude);
    expect(r.payload.hours).toEqual({ sun: 'closed', sat: '24h', fri: '8:30-17:30' });
  });

  it('rejects an unparseable range and reports it, keeping the valid ones', async () => {
    const claude = fakeClaude(toolUse('set_business_hours', { changes: [
      { day: 'mon', value: '9-17' },
      { day: 'tue', value: 'whenever' },
    ] }));
    const r = await interpretOwnerCommand({ messageText: '...' }, claude);
    expect(r.payload.hours).toEqual({ mon: '9-17' });
    expect(r.summary).toContain('skipped');
  });

  it('returns a clarifier when no change is parseable', async () => {
    const claude = fakeClaude(toolUse('set_business_hours', { changes: [{ day: 'someday', value: 'maybe' }] }));
    const r = await interpretOwnerCommand({ messageText: '...' }, claude);
    expect(r.action).toBe('none');
  });

  it('rejects an end-before-start range', async () => {
    const claude = fakeClaude(toolUse('set_business_hours', { changes: [{ day: 'mon', value: '17-9' }] }));
    const r = await interpretOwnerCommand({ messageText: '...' }, claude);
    expect(r.action).toBe('none');
  });
});

describe('set_closure', () => {
  it('keeps valid ISO dates, dedupes + sorts, and echoes them in the summary', async () => {
    const claude = fakeClaude(toolUse('set_closure', { dates: ['2026-12-26', '2026-12-25', '2026-12-25'], reason: 'Christmas' }));
    const r = await interpretOwnerCommand({ messageText: 'shut 25th-26th dec', todayISO: '2026-12-01' }, claude);
    expect(r.action).toBe('set_closure');
    expect(r.payload.closures).toEqual([
      { date: '2026-12-25', reason: 'Christmas' },
      { date: '2026-12-26', reason: 'Christmas' },
    ]);
    expect(r.summary).toContain('Christmas');
    expect(r.summary).toMatch(/25 Dec/);
  });

  it('drops invalid / impossible dates', async () => {
    const claude = fakeClaude(toolUse('set_closure', { dates: ['2026-13-40', 'next monday', '2026-08-31'] }));
    const r = await interpretOwnerCommand({ messageText: '...', todayISO: '2026-08-01' }, claude);
    expect(r.action).toBe('set_closure');
    expect(r.payload.closures).toEqual([{ date: '2026-08-31', reason: null }]);
  });

  it('asks for clarification when no date is valid', async () => {
    const claude = fakeClaude(toolUse('set_closure', { dates: ['someday'] }));
    const r = await interpretOwnerCommand({ messageText: '...', todayISO: '2026-08-01' }, claude);
    expect(r.action).toBe('none');
  });
});

describe('isClosedOn / localDateISO (the channel gate)', () => {
  it('localDateISO renders the owner-local calendar date', () => {
    // 2026-08-25 23:30 UTC is already the 26th in Sydney.
    expect(localDateISO('2026-08-25T10:00:00Z', 'Europe/London')).toBe('2026-08-25');
    expect(localDateISO('2026-08-25T23:30:00Z', 'Australia/Sydney')).toBe('2026-08-26');
  });

  it('matches a closure on the owner-local date', () => {
    const sched = { timezone: 'Europe/London', closures: [{ date: '2026-08-25', reason: 'Bank holiday' }] };
    expect(isClosedOn(sched, new Date('2026-08-25T09:00:00Z'))).toEqual({ date: '2026-08-25', reason: 'Bank holiday' });
    expect(isClosedOn(sched, new Date('2026-08-24T09:00:00Z'))).toBe(null);
  });

  it('returns null when there are no closures', () => {
    expect(isClosedOn({ timezone: 'Europe/London' }, new Date())).toBe(null);
    expect(isClosedOn({ closures: [] }, new Date())).toBe(null);
  });
});

describe('non-command messages', () => {
  it('passes the model clarifier through when no tool is called', async () => {
    const claude = fakeClaude(textOnly('What would you like to change?'));
    const r = await interpretOwnerCommand({ messageText: 'hey aria' }, claude);
    expect(r.action).toBe('none');
    expect(r.reply).toBe('What would you like to change?');
  });

  it('supplies a default clarifier when the model returns nothing usable', async () => {
    const claude = fakeClaude([]);
    const r = await interpretOwnerCommand({ messageText: '???' }, claude);
    expect(r.action).toBe('none');
    expect(r.reply).toMatch(/add an FAQ|close/i);
  });
});
