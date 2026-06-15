// GBP post drafter tests — the deterministic post-processing around the one
// Claude tool-use call. We mock the Claude client so these cover the
// validation/clamp/guard logic, not the model.

import { describe, it, expect } from 'vitest';
import { draftGbpPost, GBP_POST_TOOL } from '../lib/gbp_post.js';

function fakeClaude(toolInput) {
  return { messages: { create: async () => ({ content: toolInput ? [{ type: 'tool_use', name: 'compose_gbp_post', input: toolInput }] : [{ type: 'text', text: 'no tool' }] }) } };
}
const snippets = (n) => Array.from({ length: n }, (_, i) => `customer question ${i}`);

describe('GBP_POST_TOOL schema', () => {
  it('requires theme/body/cta_type and constrains cta_type', () => {
    expect(GBP_POST_TOOL.input_schema.required).toEqual(['theme', 'body', 'cta_type']);
    expect(GBP_POST_TOOL.input_schema.properties.cta_type.enum).toContain('BOOK');
    expect(GBP_POST_TOOL.input_schema.properties.cta_type.enum).toContain('NONE');
  });
});

describe('draftGbpPost — signal gate', () => {
  it('refuses to draft with fewer than 3 customer snippets (no Claude call)', async () => {
    let called = false;
    const claude = { messages: { create: async () => { called = true; return {}; } } };
    const r = await draftGbpPost({ businessName: 'Demo', questionSnippets: snippets(2) }, claude);
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe('draftGbpPost — composition', () => {
  it('returns a structured post with a summary', async () => {
    const claude = fakeClaude({ theme: 'emergency callouts', body: 'We now offer 24/7 emergency callouts.', cta_type: 'CALL', cta_label: 'Call now' });
    const r = await draftGbpPost({ businessName: 'Demo', questionSnippets: snippets(5) }, claude);
    expect(r.ok).toBe(true);
    expect(r.post).toEqual({ theme: 'emergency callouts', body: 'We now offer 24/7 emergency callouts.', ctaType: 'CALL', ctaLabel: 'Call now' });
    expect(r.summary).toMatch(/emergency callouts/);
    expect(r.summary).toMatch(/call button/i);
  });

  it('clamps the body to the 1500-char GBP limit', async () => {
    const long = 'x'.repeat(2000);
    const claude = fakeClaude({ theme: 't', body: long, cta_type: 'NONE' });
    const r = await draftGbpPost({ businessName: 'Demo', questionSnippets: snippets(5) }, claude);
    expect(r.ok).toBe(true);
    expect(r.post.body.length).toBeLessThanOrEqual(1500);
    expect(r.post.body.endsWith('…')).toBe(true);
  });

  it('drops an invalid cta_type to NONE and clears the label', async () => {
    const claude = fakeClaude({ theme: 't', body: 'hi', cta_type: 'WHATEVER', cta_label: 'do it' });
    const r = await draftGbpPost({ businessName: 'Demo', questionSnippets: snippets(5) }, claude);
    expect(r.post.ctaType).toBe('NONE');
    expect(r.post.ctaLabel).toBe('');
  });

  it('fails gracefully when the model returns no tool call', async () => {
    const claude = fakeClaude(null);
    const r = await draftGbpPost({ businessName: 'Demo', questionSnippets: snippets(5) }, claude);
    expect(r.ok).toBe(false);
  });

  it('fails gracefully on an empty body', async () => {
    const claude = fakeClaude({ theme: 't', body: '   ', cta_type: 'NONE' });
    const r = await draftGbpPost({ businessName: 'Demo', questionSnippets: snippets(5) }, claude);
    expect(r.ok).toBe(false);
  });
});
