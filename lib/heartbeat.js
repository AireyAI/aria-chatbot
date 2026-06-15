// heartbeat.js
//
// Silent-failure detection for Aria's inbound surfaces (WhatsApp, Instagram,
// Facebook, web widget, voice, email). The whole point: a BROKEN integration
// looks exactly like a quiet week. Both present as "no leads", "no replies",
// "lastReply was ages ago" — so a dead WhatsApp webhook, an expired Meta token,
// or a crashed voice bridge hides as ordinary low season and nobody notices for
// days. This is the same failure class that left the trading bot silent for 4h
// and outreach_auto dead for 18 days (Engineering Rule #10 — fail loud).
//
// The trick to not crying wolf: alert on a surface only when it has gone
// UNEXPECTEDLY silent — silent relative to ITS OWN typical activity rhythm. A
// surface that normally fires every 2h and has now been dark 30h is broken; a
// surface that only ever sees a message every few days is just quiet, and must
// NOT alarm. So every threshold is derived per-surface from its own typical
// interval, not a single global cutoff.
//
// Pure judgement-free logic (CLAUDE.md Rule #5): every function takes plain
// data and returns plain data. Anything needing "now" accepts a `now` epoch-ms
// param defaulting to Date.now() so tests pin it. No Claude, no I/O, no network.
// Building `perSurface` from channelStats / channelMessages / EMAIL_REPLY_STATS,
// the actual smartSend ping, and the daily dedupe all live in server.js — see
// the wiring spec. Nothing in here imports server internals.

const HOUR_MS = 60 * 60 * 1000;

// How many "typical intervals" of silence before a surface counts as broken.
// 4× its own rhythm is comfortably past normal jitter (a busy WhatsApp that
// fires hourly would need ~4h of total silence; a slower surface scales up
// automatically). Tunable per call via the baseline override below.
const DEFAULT_SILENCE_MULTIPLIER = 4;

// Floor + ceiling on the per-surface deadline so the multiplier can't produce
// absurd thresholds. A chatty surface (interval ~0.1h) still gets a sane grace
// window; a glacial one can't push its alarm out past a week (by which point a
// dead integration is its own emergency regardless of "typical" rhythm).
const MIN_EXPECTED_HOURS = 6;
const MAX_EXPECTED_HOURS = 24 * 7;

// A surface whose own typical interval is at/above this is treated as
// "naturally quiet" — we never raise a silence alert for it, because the
// signal-to-noise of "it's been a while" is hopeless for a surface that's
// always sparse. (Distinct from MAX_EXPECTED_HOURS, which caps the deadline of
// surfaces we DO watch.)
const NATURALLY_QUIET_INTERVAL_HOURS = 24 * 7;

// ── assessSilence ──────────────────────────────────────────────────────────
// The atomic check: given the last time a thing was active and how long we'd
// expect to wait before hearing from it again, is it silent NOW, and for how
// long? Used both standalone (e.g. "has ANY surface been active this week?")
// and as the primitive inside detectAnomalies.
//
//   lastActivityTs       — epoch ms of the most recent activity (or null/0/NaN
//                          if there has NEVER been any — treated as "unknown")
//   now                  — epoch ms; defaults to Date.now()
//   expectedWithinHours  — grace window in hours; silence beyond this = broken
//
// Returns { silent, hoursSince }.
//   - hoursSince is Infinity when we've never seen activity (can't time a gap
//     from nothing) — that is itself maximally suspicious.
//   - silent is true once the gap exceeds the expected window. With no prior
//     activity at all we DON'T mark silent here (a brand-new surface that has
//     simply never been used isn't "broken") — callers that care about
//     never-active surfaces decide that explicitly.
export function assessSilence({ lastActivityTs, now = Date.now(), expectedWithinHours } = {}) {
  const last = Number(lastActivityTs);
  const expected = Number(expectedWithinHours);
  const hasExpected = Number.isFinite(expected) && expected > 0;

  // No usable last-activity timestamp → unknown. Infinite gap, but not flagged
  // silent (could be a never-used surface, not a broken one).
  if (!Number.isFinite(last) || last <= 0) {
    return { silent: false, hoursSince: Infinity };
  }

  const gapMs = Math.max(0, now - last);
  const hoursSince = gapMs / HOUR_MS;
  const silent = hasExpected ? hoursSince > expected : false;
  return { silent, hoursSince };
}

// Per-surface expected-silence deadline (hours) derived from the surface's own
// rhythm. Exported so the wiring layer / tests can reason about thresholds.
function expectedHoursFor(typicalIntervalHours, multiplier) {
  const interval = Number(typicalIntervalHours);
  if (!Number.isFinite(interval) || interval <= 0) return null; // unknown rhythm
  const raw = interval * multiplier;
  return Math.min(MAX_EXPECTED_HOURS, Math.max(MIN_EXPECTED_HOURS, raw));
}

// ── detectAnomalies ─────────────────────────────────────────────────────────
// Scan every surface and return alerts ONLY for ones that have gone
// unexpectedly silent relative to their own typical interval.
//
//   perSurface — { whatsapp: { lastActivityTs, typicalIntervalHours },
//                  voice:    { ... }, web: { ... }, ... }
//                Each surface: lastActivityTs (epoch ms, last inbound/handled
//                activity) + typicalIntervalHours (its normal gap between
//                activity). A surface with no typicalIntervalHours has no
//                rhythm to compare against → never alerted.
//
//   opts.now        — epoch ms; defaults to Date.now()
//   opts.baseline   — optional overrides:
//        silenceMultiplier         — × typical interval before alarm (default 4)
//        naturallyQuietIntervalHrs — surfaces whose own interval is ≥ this are
//                                    deemed always-quiet and never alerted
//
// Returns Array<alert>, each:
//   { surface, hoursSince, expectedWithinHours, typicalIntervalHours,
//     lastActivityTs, severity }
// severity: 'critical' once the gap is ≥ 2× the deadline (long-dead, escalate),
//           else 'warning'. Sorted worst-first so a digest shows the most
//           overdue surface at the top.
export function detectAnomalies(perSurface, { now = Date.now(), baseline = {} } = {}) {
  if (!perSurface || typeof perSurface !== 'object') return [];

  const multiplier = Number.isFinite(baseline.silenceMultiplier) && baseline.silenceMultiplier > 0
    ? baseline.silenceMultiplier
    : DEFAULT_SILENCE_MULTIPLIER;
  const quietCutoff = Number.isFinite(baseline.naturallyQuietIntervalHrs) && baseline.naturallyQuietIntervalHrs > 0
    ? baseline.naturallyQuietIntervalHrs
    : NATURALLY_QUIET_INTERVAL_HOURS;

  const alerts = [];

  for (const [surface, data] of Object.entries(perSurface)) {
    if (!data || typeof data !== 'object') continue; // junk entry, skip

    const interval = Number(data.typicalIntervalHours);
    // Unknown rhythm → we have no baseline to judge "unexpected" against. Don't
    // guess; staying silent here is the whole anti-false-alarm contract.
    if (!Number.isFinite(interval) || interval <= 0) continue;

    // Surface that is simply always quiet — a multi-day natural gap is normal,
    // so refuse to alarm no matter how long it's been. This is the line that
    // stops "we only get a voice call a week" from paging the owner.
    if (interval >= quietCutoff) continue;

    const expectedWithinHours = expectedHoursFor(interval, multiplier);
    if (expectedWithinHours == null) continue;

    const { silent, hoursSince } = assessSilence({
      lastActivityTs: data.lastActivityTs,
      now,
      expectedWithinHours,
    });

    // Never-active surface (hoursSince === Infinity): only flag it if it claims
    // a real rhythm. A surface that says "I normally fire every 2h" but has a
    // null lastActivityTs is genuinely suspicious (configured + integrated, yet
    // never any traffic) → treat as silent. assessSilence returns silent:false
    // for the null case, so handle it explicitly here.
    const neverActive = !Number.isFinite(Number(data.lastActivityTs)) || Number(data.lastActivityTs) <= 0;
    const isSilent = silent || neverActive;
    if (!isSilent) continue;

    const severity = (Number.isFinite(hoursSince) && hoursSince >= expectedWithinHours * 2) || neverActive
      ? 'critical'
      : 'warning';

    alerts.push({
      surface,
      hoursSince: Number.isFinite(hoursSince) ? Math.round(hoursSince * 10) / 10 : Infinity,
      expectedWithinHours: Math.round(expectedWithinHours * 10) / 10,
      typicalIntervalHours: Math.round(interval * 10) / 10,
      lastActivityTs: neverActive ? null : Number(data.lastActivityTs),
      severity,
    });
  }

  // Worst-first: Infinity (never active) floats to the top, then longest gaps.
  alerts.sort((a, b) => {
    if (a.hoursSince === b.hoursSince) return 0;
    if (a.hoursSince === Infinity) return -1;
    if (b.hoursSince === Infinity) return 1;
    return b.hoursSince - a.hoursSince;
  });

  return alerts;
}

// ── formatAlert ──────────────────────────────────────────────────────────────
// One short human line for an email / Slack ping. Deterministic — no model.
//   "🔴 whatsapp has gone silent — no activity for 31h (normally every ~2h).
//    A broken integration looks just like this; check the connection."
export function formatAlert(alert) {
  if (!alert || !alert.surface) return '';
  const name = String(alert.surface);
  const icon = alert.severity === 'critical' ? '🔴' : '🟠';

  const since = alert.hoursSince === Infinity || !Number.isFinite(alert.hoursSince)
    ? 'no activity on record at all'
    : `no activity for ${formatHours(alert.hoursSince)}`;

  const rhythm = Number.isFinite(alert.typicalIntervalHours) && alert.typicalIntervalHours > 0
    ? ` (normally every ~${formatHours(alert.typicalIntervalHours)})`
    : '';

  return `${icon} ${name} has gone silent — ${since}${rhythm}. A broken integration looks just like this; check the connection.`;
}

// Compact hours → "45m" / "3h" / "2d 4h". Internal helper for formatAlert.
function formatHours(h) {
  if (!Number.isFinite(h)) return '∞';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  const days = Math.floor(h / 24);
  const rem = Math.round(h - days * 24);
  return rem ? `${days}d ${rem}h` : `${days}d`;
}
