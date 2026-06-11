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

describe('lookup_faq — server-side fallback (W4)', () => {
  it('falls back to serverFns.lookupServerFaq when canned misses', async () => {
    const lookupServerFaq = vi.fn(async ({ key, slug }) => ({
      found: true, answer: 'We open at 9am.', source: 'server_faq',
    }));
    const claude = fakeClaude([
      { content: [toolUseBlock('t1', 'lookup_faq', { key: 'opening_hours' })], stop_reason: 'tool_use' },
      { content: [textBlock('We open at 9am.')], stop_reason: 'end_turn' },
    ]);
    const { toolEvents } = await routeChat({
      claude, messages: [{ role: 'user', content: 'when do you open?' }],
      systemPrompt: 'You are Aria.',
      clientConfig: { slug: 'faq-site', handoffEmail: 'owner@example.com', canned: {} },
      sessionId: 't6', serverFns: { lookupServerFaq },
    });
    expect(lookupServerFaq).toHaveBeenCalledWith({
      key: 'opening_hours', slug: 'faq-site', ownerEmail: 'owner@example.com',
    });
    expect(toolEvents[0].result).toEqual({ found: true, answer: 'We open at 9am.', source: 'server_faq' });
  });

  it('canned answer still wins over the server lookup', async () => {
    const lookupServerFaq = vi.fn();
    const claude = fakeClaude([
      { content: [toolUseBlock('t1', 'lookup_faq', { key: 'hours' })], stop_reason: 'tool_use' },
      { content: [textBlock('9-5.')], stop_reason: 'end_turn' },
    ]);
    const { toolEvents } = await routeChat({
      claude, messages: [{ role: 'user', content: 'hours?' }],
      systemPrompt: 'You are Aria.',
      clientConfig: { slug: 's', canned: { hours: '9-5' } },
      sessionId: 't7', serverFns: { lookupServerFaq },
    });
    expect(lookupServerFaq).not.toHaveBeenCalled();
    expect(toolEvents[0].result.found).toBe(true);
    expect(toolEvents[0].result.answer).toBe('9-5');
  });

  it('reports not-found when canned misses and server lookup misses', async () => {
    const claude = fakeClaude([
      { content: [toolUseBlock('t1', 'lookup_faq', { key: 'parking' })], stop_reason: 'tool_use' },
      { content: [textBlock('Let me check with the team.')], stop_reason: 'end_turn' },
    ]);
    const { toolEvents } = await routeChat({
      claude, messages: [{ role: 'user', content: 'parking?' }],
      systemPrompt: 'You are Aria.',
      clientConfig: { slug: 's', canned: {} },
      sessionId: 't8', serverFns: { lookupServerFaq: vi.fn(async () => ({ found: false })) },
    });
    expect(toolEvents[0].result.found).toBe(false);
    expect(toolEvents[0].result.hint).toMatch(/system prompt/);
  });
});

// ── W7: ::ACTION behaviors ported to real tools ─────────────────────────────

describe('request_callback — ported ::CALLBACK (W7)', () => {
  it('fires serverFns.requestCallback with owner routing and returns ok', async () => {
    const requestCallback = vi.fn(async () => {});
    const claude = fakeClaude([
      { content: [toolUseBlock('t1', 'request_callback', {
          name: 'Jord', phone: '07900111222', notes: 'leaky gutter',
        })], stop_reason: 'tool_use' },
      { content: [textBlock('Done — someone will call you shortly.')], stop_reason: 'end_turn' },
    ]);
    const { toolEvents } = await routeChat({
      claude, messages: [{ role: 'user', content: 'can someone call me? 07900111222' }],
      systemPrompt: 'You are Aria.',
      clientConfig: { slug: 'ej-roofing', handoffEmail: 'owner@example.com', businessName: 'EJ Roofing' },
      sessionId: 'cb1', serverFns: { requestCallback },
    });
    expect(requestCallback).toHaveBeenCalledTimes(1);
    expect(requestCallback).toHaveBeenCalledWith({
      name: 'Jord', phone: '07900111222', notes: 'leaky gutter',
      ownerEmail: 'owner@example.com', siteName: 'EJ Roofing',
    });
    expect(toolEvents[0].result).toMatchObject({ ok: true, requested: true, phone: '07900111222' });
  });

  it('refuses without a phone number and does NOT notify the owner', async () => {
    const requestCallback = vi.fn();
    const claude = fakeClaude([
      { content: [toolUseBlock('t1', 'request_callback', { name: 'Jord' })], stop_reason: 'tool_use' },
      { content: [textBlock('What number should we call you on?')], stop_reason: 'end_turn' },
    ]);
    const { toolEvents } = await routeChat({
      claude, messages: [{ role: 'user', content: 'call me back' }],
      systemPrompt: 'You are Aria.',
      clientConfig: { slug: 'ej', handoffEmail: 'owner@example.com' },
      sessionId: 'cb2', serverFns: { requestCallback },
    });
    expect(toolEvents[0].result.error).toMatch(/phone/i);
    expect(requestCallback).not.toHaveBeenCalled();
  });
});

describe('request_quote — ported ::QUOTE (W7)', () => {
  it('fires serverFns.requestQuote with details + contact and returns ok', async () => {
    const requestQuote = vi.fn(async () => {});
    const claude = fakeClaude([
      { content: [toolUseBlock('t1', 'request_quote', {
          name: 'Mrs Jenkins', email: 'mrs@example.com',
          details: 'Flat roof repair, ~6m², photo shows cracked felt',
        })], stop_reason: 'tool_use' },
      { content: [textBlock('Quote request sent!')], stop_reason: 'end_turn' },
    ]);
    const { toolEvents } = await routeChat({
      claude, messages: [{ role: 'user', content: 'how much to fix this?' }],
      systemPrompt: 'You are Aria.',
      clientConfig: { slug: 'ej-roofing', handoffEmail: 'owner@example.com' },
      sessionId: 'q1', serverFns: { requestQuote },
    });
    expect(requestQuote).toHaveBeenCalledTimes(1);
    expect(requestQuote.mock.calls[0][0]).toMatchObject({
      details: 'Flat roof repair, ~6m², photo shows cracked felt',
      email: 'mrs@example.com',
      ownerEmail: 'owner@example.com',
    });
    expect(toolEvents[0].result).toMatchObject({ ok: true, requested: true });
  });

  it('refuses without details', async () => {
    const requestQuote = vi.fn();
    const claude = fakeClaude([
      { content: [toolUseBlock('t1', 'request_quote', { name: 'x' })], stop_reason: 'tool_use' },
      { content: [textBlock('What do you need quoted?')], stop_reason: 'end_turn' },
    ]);
    const { toolEvents } = await routeChat({
      claude, messages: [{ role: 'user', content: 'quote please' }],
      systemPrompt: 'You are Aria.',
      clientConfig: { slug: 's' },
      sessionId: 'q2', serverFns: { requestQuote },
    });
    expect(toolEvents[0].result.error).toMatch(/details/i);
    expect(requestQuote).not.toHaveBeenCalled();
  });
});

describe('client-effect tools — widget renders from the echoed result (W7)', () => {
  it('show_quick_replies echoes trimmed suggestions capped at 3', async () => {
    const claude = fakeClaude([
      { content: [toolUseBlock('t1', 'show_quick_replies', {
          suggestions: [' Book now ', 'Get a quote', '', 'Opening hours', 'Fourth one'],
        })], stop_reason: 'tool_use' },
      { content: [textBlock('Here are some options.')], stop_reason: 'end_turn' },
    ]);
    const { toolEvents } = await routeChat({
      claude, messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: 'You are Aria.',
      clientConfig: { slug: 's' },
      sessionId: 'qr1', serverFns: {},
    });
    expect(toolEvents[0].result).toEqual({
      shown: true,
      suggestions: ['Book now', 'Get a quote', 'Opening hours'],
    });
  });

  it('start_booking_flow echoes the availability flag for the widget', async () => {
    const claude = fakeClaude([
      { content: [toolUseBlock('t1', 'start_booking_flow', { show_availability: true })], stop_reason: 'tool_use' },
      { content: [textBlock("Here's what's free.")], stop_reason: 'end_turn' },
    ]);
    const { toolEvents } = await routeChat({
      claude, messages: [{ role: 'user', content: 'when are you free?' }],
      systemPrompt: 'You are Aria.',
      clientConfig: { slug: 's' },
      sessionId: 'bk1', serverFns: {},
    });
    expect(toolEvents[0].result).toEqual({ started: true, show_availability: true });
  });
});
