// vapi_handler.js
//
// Voice receptionist integration via Vapi (https://vapi.ai). Vapi bundles
// telephony (Twilio) + STT (Deepgram) + LLM proxying + TTS (ElevenLabs)
// behind ONE webhook surface, so Aria answers phone calls without us
// touching four vendor SDKs.
//
// MULTI-TENANT DESIGN — the key idea:
//   We do NOT pre-create a static Vapi assistant per client. Instead every
//   client's Vapi phone number points its serverUrl at our single
//   /api/vapi/webhook. On an inbound call Vapi fires `assistant-request`;
//   we look up the owner by the dialed number and return a freshly-built
//   assistant carrying THAT owner's business prompt + current knowledge
//   base + voice + tools. A client who edits their FAQ at 2pm has Aria
//   using it on the 2:01pm call — no redeploy, no per-client assistant to
//   keep in sync.
//
// One webhook, four event types (message.type):
//   - assistant-request    → return the per-owner assistant config
//   - tool-calls           → mid-call function calls (check_availability)
//   - status-update        → call lifecycle (ringing/answered/ended)
//   - end-of-call-report   → transcript + summary + structured data + audio
//
// Security: Vapi signs each webhook with a shared secret in the
// X-Vapi-Signature header (HMAC-SHA256 of the raw body). We verify it so
// a third party can't POST fake "booking" payloads to our endpoint.

import crypto from 'crypto';

// Verify the X-Vapi-Signature header against the raw request body.
// Vapi computes HMAC-SHA256(secret, rawBody) and sends hex. We recompute
// and constant-time compare. Returns true when valid OR when no secret is
// configured (dev mode — log a warning at the call site).
export function verifyVapiSignature(rawBody, signatureHeader, secret) {
  if (!secret) return true; // dev mode — caller should warn
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  // Vapi may send "sha256=<hex>" or bare hex — normalise.
  const got = String(signatureHeader).replace(/^sha256=/, '');
  if (got.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch { return false; }
}

// Build the per-owner Vapi assistant config returned on assistant-request.
// This is where the owner's brand voice, knowledge, and call behaviour
// live. We assemble it fresh each call from current profile + KB so edits
// take effect immediately.
//
// Args:
//   ownerEmail   — used in metadata so later webhooks know whose call this is
//   profile      — { businessName, services, location, phone, tone, hours }
//   knowledge    — array of { title, content } KB docs (RAG-lite: inlined)
//   serverUrl    — our public base URL for tool callbacks
//   opts         — { voiceId, firstMessage, maxDurationSec }
export function buildAssistantConfig({ ownerEmail, profile = {}, knowledge = [], serverUrl, opts = {} }) {
  const businessName = profile.businessName || 'the business';
  const services     = profile.services || '';
  const location     = profile.location || '';
  const tone         = profile.tone || 'friendly';

  // Inline up to ~6 KB docs into the system prompt. Phone calls are short
  // and latency-sensitive, so we don't do a retrieval round-trip mid-call —
  // we front-load the most useful knowledge. Cap total size to keep the
  // prompt lean (long prompts = slower first token = dead air on the line).
  const kbBlock = knowledge.length
    ? '\n\nBUSINESS KNOWLEDGE (use to answer caller questions):\n' +
      knowledge.slice(0, 6).map(d => `### ${d.title}\n${String(d.content).slice(0, 600)}`).join('\n\n')
    : '';

  const systemPrompt = `You are Aria, the friendly phone receptionist for ${businessName}${location ? ` in ${location}` : ''}.
${services ? `What ${businessName} does: ${services}.` : ''}
Tone: ${tone}, warm, and natural — you're a real team member, never robotic. Keep replies SHORT (1-2 sentences) because this is a live phone call — long monologues feel unnatural and the caller can't skim.

YOUR JOB ON A CALL:
1. Greet warmly, find out what the caller needs.
2. Answer questions using the business knowledge below.
3. If they want to BOOK: collect their name, what they need, and a preferred day/time. Use the check_availability tool to confirm the slot is free BEFORE telling them it's booked. If it's taken, offer the nearest alternatives.
4. If they want a PRICE/QUOTE: give a rough indication if you can from the knowledge, but say a firm quote will be confirmed by text. Never commit to an exact price you're unsure of.
5. If you genuinely can't help (complaint, complex issue, something off-topic): take a message and say someone will call back.
6. Always confirm a callback number before hanging up so the team can follow up.

IMPORTANT RULES:
- Never say you are an AI or a bot — you're Aria from ${businessName}.
- Never make up facts (prices, availability, policies) not in your knowledge. If unsure, say you'll confirm by text/callback.
- Speak numbers and times naturally ("half past two", "the fourteenth").
- If the caller is silent or you can't understand, politely ask them to repeat.${kbBlock}`;

  return {
    name: `Aria — ${businessName}`,
    // Vapi model proxying: Claude does the reasoning, Vapi handles transport.
    model: {
      provider: 'anthropic',
      model: 'claude-3-5-haiku-20241022',
      temperature: 0.5,
      maxTokens: 250,
      messages: [{ role: 'system', content: systemPrompt }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'check_availability',
            description: 'Check if a requested appointment date/time is free before confirming a booking with the caller. Always call this before saying a slot is booked.',
            parameters: {
              type: 'object',
              properties: {
                datetime: { type: 'string', description: 'Requested appointment date and time in ISO 8601 if possible, else natural language (e.g. "next Tuesday 2pm")' },
                service:  { type: 'string', description: 'What the appointment is for' },
              },
              required: ['datetime'],
            },
          },
        },
      ],
    },
    voice: {
      provider: '11labs',
      voiceId: opts.voiceId || 'paula', // warm British female default
      stability: 0.5,
      similarityBoost: 0.75,
    },
    // Per-owner transcriber language (W6) — owners in multilingual areas set
    // this from the dashboard phone settings; default stays English.
    transcriber: { provider: 'deepgram', model: 'nova-3', language: opts.transcriberLanguage || 'en' },
    firstMessage: opts.firstMessage || `Hi, you've reached ${businessName}, this is Aria. How can I help you today?`,
    // After the call ends Vapi POSTs a report with a Claude-written summary
    // + structured data. We tell it exactly what fields to extract so our
    // post-call pipeline gets clean data instead of parsing free text.
    analysisPlan: {
      structuredDataPrompt: 'Extract structured outcomes from this phone call for the business owner.',
      structuredDataSchema: {
        type: 'object',
        properties: {
          intent:        { type: 'string', enum: ['booking', 'quote', 'enquiry', 'complaint', 'message', 'other'] },
          callerName:    { type: 'string' },
          callbackNumber:{ type: 'string' },
          booking: {
            type: 'object',
            properties: {
              datetime: { type: 'string' },
              service:  { type: 'string' },
              notes:    { type: 'string' },
            },
          },
          quoteRequest:  { type: 'string', description: 'What they wanted priced, if anything' },
          message:       { type: 'string', description: 'Any message to pass to the team' },
          followUpNeeded:{ type: 'boolean' },
          summary:       { type: 'string', description: 'One-line summary of the call' },
        },
        required: ['intent', 'summary'],
      },
    },
    serverUrl: `${serverUrl}/api/vapi/webhook`,
    maxDurationSeconds: opts.maxDurationSec || 600,
    // Pass owner identity through so every later webhook knows the tenant.
    metadata: { ownerEmail },
    endCallPhrases: ['goodbye', 'bye for now', 'speak soon'],
  };
}

// Normalise an end-of-call-report message into a flat shape our pipeline
// consumes. Vapi nests things under message.* — this isolates the rest of
// the codebase from Vapi's payload structure.
export function extractCallReport(message) {
  const call = message.call || {};
  const analysis = message.analysis || {};
  return {
    callId:        call.id || message.call?.id || null,
    ownerEmail:    call.metadata?.ownerEmail || message.assistant?.metadata?.ownerEmail || null,
    customerNumber: call.customer?.number || message.customer?.number || null,
    dialedNumber:  call.phoneNumber?.number || message.phoneNumber?.number || null,
    durationSec:   message.durationSeconds || message.duration || null,
    endedReason:   message.endedReason || null,
    transcript:    message.transcript || message.artifact?.transcript || '',
    recordingUrl:  message.recordingUrl || message.artifact?.recordingUrl || null,
    summary:       analysis.summary || message.summary || '',
    structured:    analysis.structuredData || message.structuredData || {},
    startedAt:     call.startedAt || null,
    endedAt:       call.endedAt || null,
  };
}

// ─── Missed-call detection (W1 missed-call-text-back) ────────────────────
// Classify whether an end-of-call report represents a call where the caller
// never actually spoke to Aria — declined off-schedule, rang out, went to
// voicemail, or hung up in the first seconds. Pure function so it's unit-
// testable without webhook fixtures.
//
// NOT missed when the caller got through and Aria extracted a real outcome
// (any structured intent besides 'other') — those callers already get the
// booked/quote/conflict WhatsApp follow-up from handleVoiceCallOutcome.
const MISSED_REASON_RE = /no-answer|did-not-answer|busy|decline|voicemail|no-microphone|assistant-request-(returned-error|failed)|silence-?timed-?out|customer-did-not-give/i;

export function isMissedCall(report) {
  const intent = report?.structured?.intent;
  if (intent && intent !== 'other') return false; // real conversation happened
  if (MISSED_REASON_RE.test(String(report?.endedReason || ''))) return true;
  // Short-abandon: hung up almost immediately with nothing meaningful said.
  const dur = Number(report?.durationSec);
  const transcript = String(report?.transcript || '').trim();
  if (Number.isFinite(dur) && dur > 0 && dur < 12 && transcript.length < 40) return true;
  return false;
}

// ─── Number provisioning (server-side, AireyAI's Vapi account) ───────────
// Buy a fresh Vapi-native number and point it at our webhook WITHOUT an
// assistantId — that forces Vapi to fire assistant-request per call, which
// is how one webhook serves every tenant (see top-of-file notes). The
// client never touches Vapi; they click a button, we call this.
//
// Returns { id, number } on success. Throws on API error so the caller can
// surface a clean message + NOT record a half-provisioned number.
export async function provisionVapiNumber({ apiKey, serverUrl, secret, name, areaCode, countryCode = 'GB' }) {
  if (!apiKey) throw new Error('no Vapi API key configured');
  const body = {
    provider: 'vapi',
    name: (name || 'Aria line').slice(0, 60),
    // server.url + NO assistantId => assistant-request fires per call
    server: {
      url: `${serverUrl}/api/vapi/webhook`,
      ...(secret ? { secret } : {}),
    },
  };
  if (areaCode) body.numberDesiredAreaCode = String(areaCode);

  const r = await fetch('https://api.vapi.ai/phone-number', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`Vapi provision failed (${r.status}): ${data?.message || data?.error || 'unknown'}`);
  }
  if (!data.number) throw new Error('Vapi returned no number');
  return { id: data.id, number: data.number };
}

// Release a number we provisioned (e.g. owner cancels). Stops the ~£1.20/mo
// charge. Best-effort — returns true/false, never throws.
export async function releaseVapiNumber({ apiKey, id }) {
  if (!apiKey || !id) return false;
  try {
    const r = await fetch(`https://api.vapi.ai/phone-number/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    return r.ok;
  } catch { return false; }
}

// Pull the function-call name + args out of a tool-calls webhook. Vapi has
// shipped two shapes over time (functionCall vs toolCalls[]) — handle both.
export function extractToolCall(message) {
  // Newer: message.toolCalls = [{ id, function: { name, arguments } }]
  const tc = message.toolCalls?.[0] || message.toolCallList?.[0];
  if (tc) {
    let args = tc.function?.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    return { id: tc.id, name: tc.function?.name, args: args || {} };
  }
  // Older: message.functionCall = { name, parameters }
  if (message.functionCall) {
    return { id: null, name: message.functionCall.name, args: message.functionCall.parameters || {} };
  }
  return null;
}
