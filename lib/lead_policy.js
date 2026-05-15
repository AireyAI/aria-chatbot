// lead_policy.js — per-niche lead-routing thresholds.
//
// The router and handlers are mechanical. THIS file decides what actually
// happens at each qualification tier — how aggressive Aria gets, when she
// pings the owner vs stays as a polite FAQ-bot.
//
// Per CLAUDE.md Rule #5 (Claude only for judgment): qualify_lead returns
// a structured 0-100 score; this function decides what to do with it.
// Plain JS, fully auditable, easy to tune without touching the LLM stack.
//
// Niche-tier shape:
//   • aggressive (trades, law, clinic): low daily volume, owner WANTS hot
//     leads on WhatsApp immediately. Ping at score>=60 once contact captured.
//   • passive (ecommerce, restaurant): high volume, never ping owner —
//     always log to digest. Bookings handled by calendar tool, not humans.
//   • default (salon, gym, agency, anything else): conservative. Only ping
//     for nailed-on hot leads (score>=80 + contact). Otherwise digest.
//
// Out-of-hours guardrail: regardless of tier, route urgent pings to email
// (not WhatsApp) outside business hours — no 11pm buzzes.

export function decideLeadAction({ score, tier, businessType, hasContact, isOutOfHours }) {
  const aggressive = ['trades', 'law', 'clinic'].includes(businessType);
  const passive    = ['ecommerce', 'restaurant'].includes(businessType);

  const captureLead = score >= 40;
  const pingOwner   = aggressive ? (score >= 60 && hasContact)
                    : passive    ? false
                    :              (score >= 80 && hasContact);
  const pingChannel = isOutOfHours ? 'email' : (pingOwner ? 'whatsapp' : 'digest');

  return {
    captureLead,
    pingOwner,
    pingChannel,
    askForContact:  captureLead && !hasContact,
    handoffToHuman: score >= 70,
  };
}

// Turns a decision into the system-prompt addendum Aria sees on every turn —
// so the model knows the policy it's operating under, not just the tools.
export function policyAddendum(action) {
  const lines = ['POLICY FOR THIS TURN:'];
  if (action.askForContact)  lines.push('- Push gently for the visitor\'s name + email or phone.');
  if (action.captureLead)    lines.push('- Once you have a service + 1 contact field, call create_lead_record.');
  if (action.pingOwner)      lines.push(`- This is a HOT lead — call send_whatsapp_to_owner after capturing contact.`);
  if (action.handoffToHuman) lines.push('- Offer the WhatsApp/booking button before ending the conversation.');
  return lines.join('\n');
}
