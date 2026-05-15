// Tests the tool-use loop. Mocks claude.messages.create so we can assert
// that handlers fire in the right order, irreversible tools STAGE (not
// execute), and the router terminates on the final text turn.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { routeChat } from '../lib/lead_router.js';

const DATA_DIR  = resolve('data');
const LEADS     = resolve(DATA_DIR, 'leads.jsonl');
const PENDING   = resolve(DATA_DIR, 'pending_actions.jsonl');

beforeEach(async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.rm(LEADS,   { force: true });
  await fs.rm(PENDING, { force: true });
});

// Builds a fake Anthropic SDK that returns a scripted sequence of responses.
function fakeClaude(scriptedResponses) {
  let i = 0;
  return {
    messages: {
      create: vi.fn(async () => {
        const r = scriptedResponses[i++];
        if (!r) throw new Error('fakeClaude ran out of scripted responses');
        return r;
      }),
    },
  };
}

const textBlock     = (text)            => ({ type: 'text', text });
const toolUseBlock  = (id, name, input) => ({ type: 'tool_use', id, name, input });

describe('routeChat — happy path', () => {
  it('terminates on first text-only turn (no tool calls)', async () => {
    const claude = fakeClaude([
      { content: [textBlock('Hi! How can I help?')], stop_reason: 'end_turn' },
    ]);
    const { reply, toolEvents, stopReason } = await routeChat({
      claude, messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: 'You are Aria.',
      clientConfig: { slug: 'test' },
      sessionId: 't1', serverFns: {},
    });
    expect(reply).toBe('Hi! How can I help?');
    expect(toolEvents).toHaveLength(0);
    expect(stopReason).toBe('end_turn');
  });
});

describe('routeChat — qualify + log', () => {
  it('fires qualify_lead then create_lead_record then final text', async () => {
    const claude = fakeClaude([
      { content: [toolUseBlock('t1', 'qualify_lead', {
          intent: 'quote_request', service_match: true, urgency: 'this_week',
          captured_contact: { name: 'Jord', phone: '07900' },
        })], stop_reason: 'tool_use' },
      { content: [toolUseBlock('t2', 'create_lead_record', {
          name: 'Jord', phone: '07900', service_wanted: 'flat roof repair',
          qualification_score: 90,
        })], stop_reason: 'tool_use' },
      { content: [textBlock('Got it — someone will be in touch within an hour.')],
        stop_reason: 'end_turn' },
    ]);

    const { reply, toolEvents } = await routeChat({
      claude, messages: [{ role: 'user', content: 'need a roof quote, 07900' }],
      systemPrompt: 'You are Aria.',
      clientConfig: { slug: 'ej-roofing', handoffEmail: 'test@example.com' },
      sessionId: 't2', serverFns: {},
    });

    expect(toolEvents.map(e => e.name)).toEqual(['qualify_lead', 'create_lead_record']);
    expect(toolEvents[0].result.score).toBeGreaterThanOrEqual(70);
    expect(reply).toMatch(/Got it/);
    const leadsRaw = await fs.readFile(LEADS, 'utf8');
    expect(leadsRaw).toMatch(/flat roof repair/);
  });
});

describe('routeChat — irreversible tools STAGE not execute (Rule #12)', () => {
  it('send_whatsapp_to_owner writes to pending_actions.jsonl, not fires WA send', async () => {
    const sendWhatsAppMessage = vi.fn();
    const smartSend           = vi.fn(async () => true);

    const claude = fakeClaude([
      { content: [toolUseBlock('t1', 'send_whatsapp_to_owner', {
          summary: 'Hot roofing lead — Jord, 07900, flat roof, urgent',
          callback_number: '07900', urgency: 'immediate',
        })], stop_reason: 'tool_use' },
      { content: [textBlock('Sent to the team.')], stop_reason: 'end_turn' },
    ]);

    await routeChat({
      claude, messages: [{ role: 'user', content: 'call me back urgently' }],
      systemPrompt: 'You are Aria.',
      clientConfig: { slug: 'ej', handoffEmail: 'owner@example.com', handoffWa: '+447900111222' },
      sessionId: 't3',
      serverFns: { sendWhatsAppMessage, smartSend },
    });

    expect(sendWhatsAppMessage).not.toHaveBeenCalled(); // MUST NOT fire on first call
    expect(smartSend).toHaveBeenCalledTimes(1);          // owner approval email goes out
    const pending = (await fs.readFile(PENDING, 'utf8')).trim().split('\n').map(JSON.parse);
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe('send_whatsapp_to_owner');
    expect(pending[0].executed_at).toBeNull();
    expect(pending[0].owner.handoffWa).toBe('+447900111222'); // snapshot for confirm endpoint
    expect(pending[0].token).toMatch(/^[a-f0-9]{32}$/);       // 16-byte hex
  });

  it('book_calendar_slot refuses gracefully when calendar not connected', async () => {
    const claude = fakeClaude([
      { content: [toolUseBlock('t1', 'book_calendar_slot', {
          iso_start: '2026-05-20T14:00:00Z', duration_minutes: 30,
          visitor_name: 'Mrs Jenkins', visitor_contact: 'mrs@example.com',
        })], stop_reason: 'tool_use' },
      { content: [textBlock('OK noted, we\'ll reach out manually.')], stop_reason: 'end_turn' },
    ]);
    const { toolEvents } = await routeChat({
      claude, messages: [{ role: 'user', content: 'book Sunday' }],
      systemPrompt: 'You are Aria.',
      clientConfig: { slug: 'no-cal', calendarConnected: false },
      sessionId: 't4', serverFns: { smartSend: vi.fn() },
    });
    expect(toolEvents[0].result.error).toMatch(/not connected/i);
  });
});

describe('routeChat — safety cap (Rule #10: fail loud)', () => {
  it('returns warning when MAX_ITERS exceeded', async () => {
    // 7 consecutive tool_use turns — past MAX_ITERS=6
    const blizzard = Array.from({ length: 8 }, (_, i) => ({
      content: [toolUseBlock(`t${i}`, 'lookup_faq', { key: 'hours' })],
      stop_reason: 'tool_use',
    }));
    const claude = fakeClaude(blizzard);
    const { reply, warning, stopReason } = await routeChat({
      claude, messages: [{ role: 'user', content: 'spam me' }],
      systemPrompt: 'You are Aria.',
      clientConfig: { slug: 'spam', canned: { hours: '9-5' } },
      sessionId: 't5', serverFns: {},
    });
    expect(stopReason).toBe('max_iters_exceeded');
    expect(warning).toMatch(/MAX_ITERS/);
    expect(reply).toMatch(/team will be in touch/);
  });
});
