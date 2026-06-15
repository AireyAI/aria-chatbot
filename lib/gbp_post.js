// gbp_post.js
//
// Drafts a Google Business Profile post from what customers ACTUALLY asked
// Aria this month — the "Aria runs your web presence" moat (product review
// Tier A). The owner gets a ready-to-paste local post grounded in real demand,
// not a generic template.
//
// Judgement layer only (CLAUDE.md Rule #5): ONE Claude tool-use call turns the
// month's conversation themes into a composed post, then validates/clamps the
// result in plain code. Theme GATHERING (reading channel messages, dedupe,
// category counts) is plain code in server.js. No server internals, no I/O here.

const CTA_TYPES = ['BOOK', 'ORDER', 'BUY', 'LEARN_MORE', 'SIGN_UP', 'CALL', 'NONE'];
const MAX_BODY = 1500; // Google Business Profile post hard limit

export const GBP_POST_TOOL = {
  name: 'compose_gbp_post',
  description: 'Compose ONE Google Business Profile post (a short local-business update or offer) grounded in what customers actually asked this period.',
  input_schema: {
    type: 'object',
    properties: {
      theme: { type: 'string', description: 'The single topic the post is built around, drawn from the customer questions provided (e.g. "emergency callouts", "Christmas availability").' },
      body: { type: 'string', description: `The post text, under ${MAX_BODY} characters, in the business's own voice. Warm, specific, local. One clear point. No hashtag spam, no emoji walls.` },
      cta_type: { type: 'string', enum: CTA_TYPES, description: 'The Google Business call-to-action button that best fits the post, or NONE.' },
      cta_label: { type: 'string', description: 'Short phrase for the action if a CTA fits, e.g. "Get a quote". Empty when NONE.' },
    },
    required: ['theme', 'body', 'cta_type'],
  },
};

// Draft a GBP post. Throws on API/billing errors (caller owns isAiBillingError).
// Returns:
//   { ok: true,  post: { theme, body, ctaType, ctaLabel }, summary }
//   { ok: false, reason }   // not enough signal, or model returned nothing usable
export async function draftGbpPost({ businessName, services, monthLabel, questionSnippets = [], categoryCounts = {} }, claude, { model = 'claude-haiku-4-5-20251001' } = {}) {
  const snippets = questionSnippets.map(s => String(s || '').trim()).filter(Boolean).slice(0, 40);
  if (snippets.length < 3) {
    return { ok: false, reason: "Not enough recent customer conversations to draft a post from yet — come back once Aria has handled a few more chats." };
  }

  const system = `You write Google Business Profile posts for ${businessName || 'a local business'}.
${services ? `Services: ${services}.\n` : ''}Write ONE short post for ${monthLabel || 'this month'}, grounded in what customers ACTUALLY asked Aria recently (provided by the user). Pick the single most useful or sellable theme — a common question, a recurring need, or a timely offer. Speak in the business's voice to local customers. Be specific, never generic filler. Keep it under ${MAX_BODY} characters. You MUST call the compose_gbp_post tool.`;
  const userContent = `What customers asked recently:\n${snippets.map(s => '- ' + s).join('\n')}\n\nThis period's enquiry mix: ${JSON.stringify(categoryCounts || {})}.`;

  const resp = await claude.messages.create({
    model,
    max_tokens: 900,
    system,
    tools: [GBP_POST_TOOL],
    tool_choice: { type: 'tool', name: 'compose_gbp_post' },
    messages: [{ role: 'user', content: userContent }],
  });

  const toolUse = resp.content.find(b => b.type === 'tool_use');
  if (!toolUse) return { ok: false, reason: 'Could not draft a post just now — try again.' };

  const theme = String(toolUse.input?.theme || '').trim().slice(0, 120);
  let body = String(toolUse.input?.body || '').trim();
  if (!body) return { ok: false, reason: 'Could not draft a post just now — try again.' };
  if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY - 1).trimEnd() + '…';

  const ctaType = CTA_TYPES.includes(toolUse.input?.cta_type) ? toolUse.input.cta_type : 'NONE';
  const ctaLabel = ctaType === 'NONE' ? '' : String(toolUse.input?.cta_label || '').trim().slice(0, 40);

  return {
    ok: true,
    post: { theme, body, ctaType, ctaLabel },
    summary: `Draft post about "${theme}"${ctaType !== 'NONE' ? ` with a ${ctaType.replace(/_/g, ' ').toLowerCase()} button` : ''}.`,
  };
}
