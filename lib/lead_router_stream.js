// Streaming variant of routeChat — emits text deltas as they arrive from
// Anthropic AND dispatches tools between turns, so the visitor sees
// progressive text output instead of waiting for the full tool-loop to
// complete before any text renders.
//
// Pattern: claude.messages.stream() emits text deltas live. When the model
// stops (stop_reason='tool_use'), we dispatch the requested tools and start
// a new stream with the tool_results in the conversation. Repeats until
// the model emits stop_reason='end_turn' (or we hit MAX_ITERS).
//
// Callbacks:
//   onTextDelta(t)  — fires for every text chunk (forward to SSE)
//   onToolEvent(e)  — fires after each tool dispatch ({name, input, result})
//
// Returns { stopReason, toolEvents, score, warning? } at end of conversation.

import { ARIA_TOOLS, TOOL_METADATA } from './tools.js';
import { HANDLERS } from './tool_handlers.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_ITERS = 6;

export async function streamRouteChat({
  claude,
  messages,
  systemPrompt,
  clientConfig,
  sessionId,
  serverFns,
  onTextDelta,
  onToolEvent,
  isAborted,        // () => boolean — caller checks SSE socket state
  model = DEFAULT_MODEL,
  maxTokens = 1024,
}) {
  const ctx = { clientConfig, sessionId, serverFns };
  const toolEvents = [];
  const convo = [...messages];
  // Sum streaming usage across every iteration so trackUsage() in the server
  // route can apply the full cost — not just the last turn. Aborts still get
  // attributed for whatever the model produced before the disconnect (visitor
  // already paid for the tokens that crossed the wire).
  let usage = { inputTokens: 0, outputTokens: 0 };

  const aborted = () => { try { return !!isAborted?.(); } catch { return false; } };

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    if (aborted()) {
      return { stopReason: 'client_aborted', toolEvents, score: clientConfig?.lastScore ?? 0, usage };
    }

    const stream = claude.messages.stream({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      tools: ARIA_TOOLS,
      messages: convo,
    });

    // Forward every text delta to the SSE consumer immediately.
    // Abort the upstream Anthropic stream if the visitor disconnects — without
    // this, a closed browser tab still bills tokens until the model finishes.
    stream.on('text', t => {
      if (aborted()) { try { stream.abort(); } catch {} return; }
      try { onTextDelta?.(t); } catch {}
    });

    let final;
    try {
      final = await stream.finalMessage();
    } catch (err) {
      // stream.abort() rejects the promise — treat as clean abort, not an error.
      if (aborted()) {
        return { stopReason: 'client_aborted', toolEvents, score: clientConfig?.lastScore ?? 0, usage };
      }
      throw err;
    }
    usage.inputTokens  += final.usage?.input_tokens  || 0;
    usage.outputTokens += final.usage?.output_tokens || 0;
    convo.push({ role: 'assistant', content: final.content });

    // If the client disconnected during the turn, do NOT dispatch tools.
    // Irreversible side effects (WhatsApp ping, calendar slot) must not fire
    // for a visitor who's already gone.
    if (aborted()) {
      return { stopReason: 'client_aborted', toolEvents, score: clientConfig?.lastScore ?? 0, usage };
    }

    const toolUses = final.content.filter(b => b.type === 'tool_use');
    if (toolUses.length === 0) {
      const qualifyEvent = toolEvents.find(e => e.name === 'qualify_lead');
      const score = qualifyEvent?.result?.score ?? clientConfig?.lastScore ?? 0;
      return { stopReason: final.stop_reason, toolEvents, score, usage };
    }

    // Dispatch every tool_use in this turn before starting the next stream.
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
      const event = {
        name: block.name,
        input: block.input,
        result,
        metadata: TOOL_METADATA[block.name],
      };
      toolEvents.push(event);
      try { onToolEvent?.(event); } catch {}
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }
    convo.push({ role: 'user', content: toolResults });
  }

  // Safety net per Rule #10: surface loud.
  return {
    stopReason: 'max_iters_exceeded',
    toolEvents,
    score: clientConfig?.lastScore ?? 0,
    usage,
    warning: `streamRouteChat hit MAX_ITERS=${MAX_ITERS} for session ${sessionId}`,
  };
}
