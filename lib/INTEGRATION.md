# Lead Router — integration patch

Drop-in for `server.js`. Three small changes — none of them touch your
uncommitted 2026-05-14 hardening.

## 1. Imports (top of server.js, near the existing `import Anthropic` line)

```js
import { routeChat } from './lib/lead_router.js';
import { decideLeadAction, policyAddendum } from './lib/lead_policy.js';
```

## 2. Expose existing server.js helpers to the router

The handlers call back into your existing functions via `serverFns` so
`lib/` stays free of server.js internals. Just below where `smartSend`
and `sendWhatsAppMessage` are defined, add:

```js
const ariaServerFns = { smartSend, sendWhatsAppMessage };
```

## 3. Replace the body of `app.post('/api/chat', ...)` at server.js:3452

Existing route does a single `claude.messages.create` and parses the text.
Swap it for the tool-use loop:

```js
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, systemPrompt, sessionId, clientConfig = {} } = req.body;

    // 1. Policy decision based on the LAST score in this session (stored
    //    by qualify_lead tool calls). Default to cold for first turn.
    const lastScore = clientConfig.lastScore ?? 0;
    const tier = lastScore >= 70 ? 'hot' : lastScore >= 40 ? 'warm' : 'cold';
    const action = decideLeadAction({
      score: lastScore,
      tier,
      businessType: clientConfig.type,
      hasContact: Boolean(clientConfig.capturedEmail || clientConfig.capturedPhone),
      isOutOfHours: clientConfig.isOutOfHours ?? false,
    });

    // 2. Append policy addendum so Claude knows what's expected this turn.
    const fullPrompt = systemPrompt + '\n\n' + policyAddendum(action);

    // 3. Run the tool-use loop.
    const { reply, toolEvents, warning } = await routeChat({
      claude,
      messages,
      systemPrompt: fullPrompt,
      clientConfig: { ...clientConfig, serverBaseUrl: `${req.protocol}://${req.get('host')}` },
      sessionId,
      serverFns: ariaServerFns,
    });

    if (warning) console.warn('[aria/router]', warning); // Rule #10 — fail loud
    res.json({ reply, toolEvents });
  } catch (err) {
    console.error('[aria/chat] error:', err);
    res.status(500).json({ error: 'chat_failed' });
  }
});
```

## 4. Add the confirm endpoint for staged actions

Per Rule #12 (two-stage approval), `send_whatsapp_to_owner` and
`book_calendar_slot` stage to `data/pending_actions.jsonl` and email the
owner a one-click link. Add this route anywhere convenient:

```js
app.get('/api/pending/confirm', async (req, res) => {
  const { id, token } = req.query;
  const lines = (await fs.readFile('data/pending_actions.jsonl', 'utf8'))
    .trim().split('\n').map(JSON.parse);
  const row = lines.find(r => r.id === id && r.token === token);
  if (!row) return res.status(403).send('Invalid or expired link');
  if (row.executed_at) return res.send('Already actioned.');

  // Execute for real
  if (row.kind === 'send_whatsapp_to_owner') {
    await sendWhatsAppMessage(
      { /* meta cfg */ },
      row.payload.callback_number,
      row.payload.summary
    );
  }
  // book_calendar_slot: call your existing calendar.events.insert helper here

  // Mark executed by appending a new line — log stays append-only (Rule #13)
  await fs.appendFile('data/pending_actions.jsonl',
    JSON.stringify({ ...row, executed_at: new Date().toISOString() }) + '\n');
  res.send('Done — Aria has sent it.');
});
```

## What this gives you

- Every chat now runs through native Anthropic tool-use
- Claude can: qualify, lookup FAQ, log leads, request WhatsApp ping
  (approved by you), request booking (approved by you)
- All state changes are auditable via `data/leads.jsonl` and
  `data/pending_actions.jsonl` (append-only)
- Policy thresholds live in `lib/lead_policy.js` — tune per-client without
  redeploying anything else

## Tests to add (vitest is already wired)

- `tests/lead_router.test.js` — mock `claude.messages.create` to return
  tool_use blocks, assert handlers fire in correct order
- `tests/lead_policy.test.js` — assert each `businessType × score` combo
  produces the expected action shape
