// Locks the per-niche routing matrix. The thresholds in lib/lead_policy.js
// are business-critical — too aggressive = client rage-quits, too passive
// = leads slip through. Tests encode the WHY of each tier, per CLAUDE.md
// Rule #9: tests verify intent, not what.

import { describe, it, expect } from 'vitest';
import { decideLeadAction, policyAddendum } from '../lib/lead_policy.js';

const decide = (over = {}) => decideLeadAction({
  score: 0, tier: 'cold', businessType: 'generic',
  hasContact: false, isOutOfHours: false, ...over,
});

describe('decideLeadAction — trades (aggressive)', () => {
  it('pings owner on score>=60 with contact (a roofing quote slipping is £2-5k lost)', () => {
    const a = decide({ businessType: 'trades', score: 65, hasContact: true });
    expect(a.pingOwner).toBe(true);
    expect(a.pingChannel).toBe('whatsapp');
  });
  it('holds back when contact missing — asks for it first', () => {
    const a = decide({ businessType: 'trades', score: 75, hasContact: false });
    expect(a.pingOwner).toBe(false);
    expect(a.askForContact).toBe(true);
  });
  it('routes to email out-of-hours — no 11pm WhatsApp buzzes', () => {
    const a = decide({ businessType: 'trades', score: 75, hasContact: true, isOutOfHours: true });
    expect(a.pingChannel).toBe('email');
  });
});

describe('decideLeadAction — salon (default conservative)', () => {
  it('does NOT ping at score 75 — owner sees 30 chats/day, would rage', () => {
    const a = decide({ businessType: 'salon', score: 75, hasContact: true });
    expect(a.pingOwner).toBe(false);
    expect(a.pingChannel).toBe('digest');
  });
  it('pings only at score>=80 with contact', () => {
    const a = decide({ businessType: 'salon', score: 85, hasContact: true });
    expect(a.pingOwner).toBe(true);
  });
});

describe('decideLeadAction — passive niches (ecommerce, restaurant)', () => {
  it('never pings owner even at score 95 — daily digest is the contract', () => {
    expect(decide({ businessType: 'ecommerce', score: 95, hasContact: true }).pingOwner).toBe(false);
    expect(decide({ businessType: 'restaurant', score: 99, hasContact: true }).pingOwner).toBe(false);
  });
  it('still captures the lead — just doesn\'t interrupt the owner', () => {
    expect(decide({ businessType: 'ecommerce', score: 60, hasContact: true }).captureLead).toBe(true);
  });
});

describe('decideLeadAction — capture threshold', () => {
  it('does not capture below score 40 — too cold, would pollute leads.jsonl', () => {
    expect(decide({ score: 30 }).captureLead).toBe(false);
  });
  it('captures at score 40 (warm tier minimum)', () => {
    expect(decide({ score: 40 }).captureLead).toBe(true);
  });
});

describe('policyAddendum — prompt builder', () => {
  it('includes ask-for-contact line when needed', () => {
    const text = policyAddendum(decide({ businessType: 'trades', score: 75, hasContact: false }));
    expect(text).toMatch(/Push gently/);
  });
  it('includes hot-lead instruction when pingOwner=true', () => {
    const text = policyAddendum(decide({ businessType: 'trades', score: 75, hasContact: true }));
    expect(text).toMatch(/HOT lead/);
  });
  it('omits hot-lead line for cold conversations', () => {
    const text = policyAddendum(decide({ score: 10 }));
    expect(text).not.toMatch(/HOT lead/);
  });
});
