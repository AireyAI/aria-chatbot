// customer_ltv.js
//
// "Customer Lifetime Value" proxy score for a customer's profile.
//
// This is a heuristic, not real money — Aria doesn't see invoice values.
// The score is a relative ranking signal: which customers should the
// owner pay extra attention to? Used to:
//   - sort the Customers list (highest LTV first)
//   - show a colour-coded badge in the customer profile header
//   - feed a future "VIP" segment (e.g. send win-back campaign if a 90+
//     score customer goes quiet for 60 days)
//
// Default weights below favour committed action (bookings) > intent
// (hot leads) > engagement (general touches). Tune for your business.

export function ltvScore({ bookings = 0, leads = 0, hotLeads = 0, conversations = 0, touches = 0 } = {}) {
  // Each signal type contributes a sub-score. Sum then cap at 100.
  let score = 0;

  // Bookings are the highest-confidence signal — each one is worth 30.
  score += bookings * 30;

  // Hot leads are intent without commit yet — each worth 10.
  score += hotLeads * 10;

  // Other leads (warm + cold) — each worth 3.
  const otherLeads = Math.max(0, leads - hotLeads);
  score += otherLeads * 3;

  // Pure engagement (conversations they had even without a captured
  // lead) — small contribution per conv.
  score += conversations * 2;

  // Touches diminishing-returns boost — log scale so a chatty customer
  // doesn't dominate a customer who actually books.
  if (touches > 1) score += Math.min(20, Math.log2(touches) * 5);

  return Math.min(100, Math.round(score));
}

// Tier helper — maps numeric score to a human label + colour for the UI.
// Thresholds picked to make most customers "Active" (default state),
// "Engaged" when they're showing intent, "VIP" when they've actually
// committed (booked).
export function ltvTier(score) {
  if (score >= 60) return { label: 'VIP',      color: '#00e5a0' };
  if (score >= 30) return { label: 'Engaged',  color: '#fbbf24' };
  if (score >= 10) return { label: 'Active',   color: '#9d96ff' };
  return            { label: 'New',      color: '#8888aa' };
}
