// Locks the streaming tool-use loop behavior. Same contract as
// lead_router.test.js but verifying that:
//   - text deltas fire via onTextDelta as the model emits them
//   - tool dispatches happen between turns (not buried in finalMessage)
//   - irreversible tools still STAGE (Rule #12), not execute
//   - max_iters safety still triggers
//
// Mocks claude.messages.stream() — Anthropic SDK's stream returns an
// EventEmitter-ish object. We only need .on('text', fn) and .finalMessage().

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { streamRouteChat } from '../lib/lead_router_stream.js';

const DATA_DIR  = resolve('data');
const LEADS     = resolve(DATA_DIR, 'leads.jsonl');
const PENDING   = resolve(DATA_DIR, 'pending_actions.jsonl');

beforeEach(async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.rm(LEADS,   { force: true });
  await fs.rm(PENDING, { force: true });
});

const textBlock     = (text)            => ({ type: 'text', text });
const toolUseBlock  = (id, name, input) => ({ type: 'tool_use', id, name, input });

// Fake stream client — returns scripted responses in order. Each response is
// { content: [...blocks...], stop_reason: 'end_turn'|'tool_use', textChunks?: [string...] }
// If textChunks is provided, we emit those as deltas before resolving finalMessage.
function fakeStreamClaude(scriptedResponses) {
  let i = 0;
  return {
    messages: {
      stream() {
        const r = scriptedResponses[i++];
        if (!r) throw new Error('fakeStreamClaude ran out of scripted responses');
        const handlers = {};
        return {
          on(event, fn) { handlers[event] = fn; return this; },
          finalMessage: async () => {
            // Emit text deltas synchronously (matches how Anthropic's SDK fires)
            const chunks = r.textChunks ?? (r.content || []).filter(b => b.type === 'text').map(b => b.text);
            for (const t of chunks) handlers.text?.(t);
            return { content: r.content, stop_reason: r.stop_reason };
          },
        };
      },
    },
  };
}

describe('streamRouteChat — happy path', () => {
  it('emits text deltas via onTextDelta and terminates on end_turn', async () => {
    const deltas = [];
    const claude = fakeStreamClaude([
      { content: [textBlock('Hello! How can I help?')], stop_reason: 'end_turn',
        textChunks: ['Hello', '! How can ', 'I help?'] },
    ]);

    const { stopReason, toolEvents } = await streamRouteChat({
      claude,
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: 'You are Aria.',
      clientConfig: { slug: 'stream-test' },
      sessionId: 's1',
      serverFns: {},
      onTextDelta: t => deltas.push(t),
    });

    expect(deltas).toEqual(['Hello', '! How can ', 'I help?']);
    expect(deltas.join('')).toBe('Hello! How can I help?');
    expect(stopReason).toBe('end_turn');
    expect(toolEvents).toHaveLength(0);
  });
});

describe('streamRouteChat — tool dispatch between turns', () => {
  it('fires onToolEvent after each tool, streams next turn text', async () => {
    const deltas = [];
    const toolFired = [];
    const claude = fakeStreamClaude([
      // Turn 1: tool_use, no text
      { content: [toolUseBlock('t1', 'qualify_lead', {
          intent: 'quote_request', service_match: true, urgency: 'this_week',
          captured_contact: { name: 'Jord', phone: '07900' },
        })], stop_reason: 'tool_use', textChunks: [] },
      // Turn 2: more tools
      { content: [toolUseBlock('t2', 'create_lead_record', {
          service_wanted: 'flat roof repair', qualification_score: 90,
        })], stop_reason: 'tool_use', textChunks: [] },
      // Turn 3: final text streamed
      { content: [textBlock('Got it — someone will be in touch.')],
        stop_reason: 'end_turn',
        textChunks: ['Got it', ' — someone will be in touch.'] },
    ]);

    const { stopReason, toolEvents, score } = await streamRouteChat({
      claude,
      messages: [{ role: 'user', content: 'need a roof quote, 07900' }],
      systemPrompt: 'You are Aria.',
      clientConfig: { slug: 'ej-roofing', handoffEmail: 'test@example.com' },
      sessionId: 's2',
      serverFns: {},
      onTextDelta: t => deltas.push(t),
      onToolEvent: e => toolFired.push(e.name),
    });

    expect(toolFired).toEqual(['qualify_lead', 'create_lead_record']);
    expect(deltas.join('')).toBe('Got it — someone will be in touch.');
    expect(score).toBeGreaterThanOrEqual(70);
    expect(stopReason).toBe('end_turn');
    expect(toolEvents.map(e => e.name)).toEqual(['qualify_lead', 'create_lead_record']);
  });
});

describe('streamRouteChat — irreversible tools STAGE not execute (Rule #12)', () => {
  it('send_whatsapp_to_owner stages, never fires sendWhatsAppMessage on first call', async () => {
    const sendWhatsAppMessage = vi.fn();
    const smartSend           = vi.fn(async () => true);

    const claude = fakeStreamClaude([
      { content: [toolUseBlock('t1', 'send_whatsapp_to_owner', {
          summary: 'Hot lead', callback_number: '07900', urgency: 'immediate',
        })], stop_reason: 'tool_use', textChunks: [] },
      { content: [textBlock('Sent.')], stop_reason: 'end_turn', textChunks: ['Sent.'] },
    ]);

    await streamRouteChat({
      claude,
      messages: [{ role: 'user', content: 'call me' }],
      systemPrompt: 'You are Aria.',
      clientConfig: { slug: 'ej', handoffEmail: 'owner@x.com', handoffWa: '+447900111222' },
      sessionId: 's3',
      serverFns: { sendWhatsAppMessage, smartSend },
      onTextDelta: () => {},
    });

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(smartSend).toHaveBeenCalledTimes(1);
    const pending = (await fs.readFile(PENDING, 'utf8')).trim().split('\n').map(JSON.parse);
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe('send_whatsapp_to_owner');
    expect(pending[0].executed_at).toBeNull();
  });
});

describe('streamRouteChat — safety cap', () => {
  it('returns warning when MAX_ITERS exceeded', async () => {
    const blizzard = Array.from({ length: 8 }, (_, i) => ({
      content: [toolUseBlock(`t${i}`, 'lookup_faq', { key: 'hours' })],
      stop_reason: 'tool_use', textChunks: [],
    }));
    const claude = fakeStreamClaude(blizzard);
    const { stopReason, warning } = await streamRouteChat({
      claude,
      messages: [{ role: 'user', content: 'spam' }],
      systemPrompt: 'You are Aria.',
      clientConfig: { slug: 'spam', canned: { hours: '9-5' } },
      sessionId: 's4',
      serverFns: {},
      onTextDelta: () => {},
    });
    expect(stopReason).toBe('max_iters_exceeded');
    expect(warning).toMatch(/MAX_ITERS/);
  });
});

describe('streamRouteChat — score persistence baseline', () => {
  it('returns lastScore from clientConfig if no qualify_lead fired', async () => {
    const claude = fakeStreamClaude([
      { content: [textBlock('Hi.')], stop_reason: 'end_turn', textChunks: ['Hi.'] },
    ]);
    const { score } = await streamRouteChat({
      claude,
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: 'You are Aria.',
      clientConfig: { slug: 'x', lastScore: 55 },
      sessionId: 's5',
      serverFns: {},
      onTextDelta: () => {},
    });
    expect(score).toBe(55); // carries forward from previous turn
  });

  it('overrides lastScore with fresh qualify_lead result', async () => {
    const claude = fakeStreamClaude([
      { content: [toolUseBlock('t1', 'qualify_lead', {
          intent: 'quote_request', service_match: true, urgency: 'immediate',
          captured_contact: { phone: '07900' },
        })], stop_reason: 'tool_use', textChunks: [] },
      { content: [textBlock('Logged.')], stop_reason: 'end_turn', textChunks: ['Logged.'] },
    ]);
    const { score } = await streamRouteChat({
      claude,
      messages: [{ role: 'user', content: 'urgent roof, 07900' }],
      systemPrompt: 'You are Aria.',
      clientConfig: { slug: 'x', lastScore: 30 }, // stale low score
      sessionId: 's6',
      serverFns: {},
      onTextDelta: () => {},
    });
    expect(score).toBeGreaterThan(70); // fresh score replaces stale 30
  });
});
