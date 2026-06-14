// Owner chat-ops tests — the interpreter's deterministic post-processing.
//
// interpretOwnerCommand makes ONE Claude tool-use call (the judgement step),
// then turns the structured tool input into a validated proposal + a
// human-readable summary in plain code. We mock the Claude client so the
// tests cover the parsing/validation/summary logic, not the model.

import { describe, it, expect } from 'vitest';
import { interpretOwnerCommand, OWNER_TOOLS } from '../lib/owner_chatops.js';

// Minimal fake Anthropic client — returns whatever content we hand it.
function fakeClaude(content) {
  return { messages: { create: async () => ({ content }) } };
}
const toolUse = (name, input) => [{ type: 'tool_use', name, input }];
const textOnly = (t) => [{ type: 'text', text: t }];

describe('OWNER_TOOLS schema', () => {
  it('exposes exactly add_faq + set_business_hours', () => {
    expect(OWNER_TOOLS.map(t => t.name).sort()).toEqual(['add_faq', 'set_business_hours']);
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
