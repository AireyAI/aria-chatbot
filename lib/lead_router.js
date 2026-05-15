// lead_router.js — wraps claude.messages.create() with a tool-use loop.
//
// Drop-in replacement for the body of POST /api/chat. Instead of a single
// turn, this runs Claude in a loop: model emits text or tool_use → we
// dispatch tools → feed results back → continue until model emits a
// terminal text response (or hits maxIters as a safety cap).
//
// Caller passes:
//   - claude:        Anthropic SDK instance (already constructed in server.js)
//   - messages:      conversation history [{role, content}, ...]
//   - systemPrompt:  the client's data-prompt
//   - clientConfig:  { slug, handoffEmail, handoffWa, canned, calendarConnected, serverBaseUrl }
//   - sessionId:     for logging
//   - serverFns:     { smartSend, sendWhatsAppMessage, ... } — handlers reach
//                    back into server.js without this file importing it directly
//
// Returns { reply, toolEvents } where reply is the final assistant text and
// toolEvents is an array of { name, input, result } for telemetry.

import { ARIA_TOOLS, TOOL_METADATA } from './tools.js';
import { HANDLERS } from './tool_handlers.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_ITERS = 6;

export async function routeChat({
  claude,
  messages,
  systemPrompt,
  clientConfig,
  sessionId,
  serverFns,
  model = DEFAULT_MODEL,
  maxTokens = 1024,
}) {
  const ctx = { clientConfig, sessionId, serverFns };
  const toolEvents = [];
  const convo = [...messages];

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const resp = await claude.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      tools: ARIA_TOOLS,
      messages: convo,
    });

    // Append the model's turn so it sees its own tool_use blocks next round.
    convo.push({ role: 'assistant', content: resp.content });

    const toolUses = resp.content.filter(b => b.type === 'tool_use');
    if (toolUses.length === 0) {
      // No tools requested → terminal turn. Concatenate text blocks.
      const reply = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      return { reply, toolEvents, stopReason: resp.stop_reason };
    }

    // Dispatch every tool_use in this turn.
    const toolResults = [];
    for (const block of toolUses) {
      const handler = HANDLERS[block.name];
      let result;
      try {
        result = handler
          ? await handler(block.input, ctx)
          : { error: `Unknown tool: ${block.name}` };
      } catch (err) {
        result = { error: String(err?.message || err) };
      }
      toolEvents.push({
        name: block.name,
        input: block.input,
        result,
        metadata: TOOL_METADATA[block.name],
      });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }
    convo.push({ role: 'user', content: toolResults });
  }

  // Safety net: model wouldn't stop calling tools. Surface loud per Rule #10.
  return {
    reply: "I've collected enough info — someone from the team will be in touch shortly.",
    toolEvents,
    stopReason: 'max_iters_exceeded',
    warning: `routeChat hit MAX_ITERS=${MAX_ITERS} for session ${sessionId}`,
  };
}
