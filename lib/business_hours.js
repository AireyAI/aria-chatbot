// business_hours.js
//
// Per-owner schedule logic. Determines whether Aria should auto-reply
// RIGHT NOW given a profile's schedule + owner timezone.
//
// Pure function — no I/O, side-effect free, deterministic given inputs.
// Same fn used by:
//   - handleIncomingChannelMessage (decide whether to reply now)
//   - dashboard live status badge ("Aria is currently: ON")
//   - test sandbox ("Aria would reply: yes / no — out of hours")

// Schedule shape:
//   { mode: 'always' | 'business_hours' | 'custom',
//     businessHours: { mon: '9-18', tue: '9-18', wed: '9-18', thu: '9-18',
//                      fri: '9-18', sat: 'closed', sun: 'closed' },
//     timezone: 'Europe/London',
//     outOfHoursMode: 'silent' | 'auto_reply',
//     outOfHoursMessage: 'Thanks for getting in touch...' }
//
// Time format: "9-18" means 09:00-18:00 local. "9:30-17:30" allowed.
// "closed" or null means no hours that day.
// "24h" means always open that day.

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Parse "9-18" or "9:30-17:30" into { startMin, endMin } where minutes
// are since midnight. Returns null for closed/invalid.
function parseRange(s) {
  if (!s || s === 'closed') return null;
  if (s === '24h' || s === '24/7') return { startMin: 0, endMin: 24 * 60 };
  const m = String(s).match(/^\s*(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*$/);
  if (!m) return null;
  const startMin = Number(m[1]) * 60 + Number(m[2] || 0);
  const endMin = Number(m[3]) * 60 + Number(m[4] || 0);
  if (endMin <= startMin) return null; // we don't support cross-midnight ranges
  return { startMin, endMin };
}

// Project a timestamp into the owner's local day-of-week + minutes-since-midnight.
function projectToLocalTime(ts, timezone = 'Europe/London') {
  const date = ts ? new Date(ts) : new Date();
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short',
      hour: 'numeric', minute: 'numeric', hour12: false,
    });
    const parts = fmt.formatToParts(date);
    const wd = parts.find(p => p.type === 'weekday')?.value?.toLowerCase().slice(0, 3) || 'mon';
    const hour = Number(parts.find(p => p.type === 'hour')?.value || 0);
    const minute = Number(parts.find(p => p.type === 'minute')?.value || 0);
    return { dayKey: wd, minutes: hour * 60 + minute };
  } catch (e) {
    // Fallback to UTC if timezone is invalid
    const dow = date.getUTCDay();
    return { dayKey: DAY_KEYS[dow], minutes: date.getUTCHours() * 60 + date.getUTCMinutes() };
  }
}

// Main entry — returns { inHours, mode, schedule, outOfHoursMessage, nextOpensAt }
export function evaluateSchedule(schedule, ts) {
  const sched = schedule || {};
  const mode = sched.mode || 'always';
  const timezone = sched.timezone || 'Europe/London';

  // Always-on bypass
  if (mode === 'always') {
    return { inHours: true, mode, timezone, outOfHoursMessage: sched.outOfHoursMessage };
  }

  // Default business hours preset if user picked business_hours but never tuned it
  const defaultHours = { mon: '9-18', tue: '9-18', wed: '9-18', thu: '9-18', fri: '9-18', sat: 'closed', sun: 'closed' };
  const hours = sched.businessHours || defaultHours;

  const { dayKey, minutes } = projectToLocalTime(ts, timezone);
  const today = parseRange(hours[dayKey]);
  const inHours = !!(today && minutes >= today.startMin && minutes < today.endMin);

  return {
    inHours,
    mode,
    timezone,
    todayLocal: dayKey,
    minutesLocal: minutes,
    outOfHoursMode: sched.outOfHoursMode || 'auto_reply',
    outOfHoursMessage: sched.outOfHoursMessage || 'Thanks for getting in touch! We are currently closed but will get back to you as soon as we are open.',
  };
}

// Find the next timestamp (ms) at which the schedule is in-hours, scanning
// forward in stepMin increments. Returns fromTs unchanged when already
// in-hours (incl. mode 'always'), or null when no open window exists within
// maxDays (e.g. every day set to 'closed') — caller decides the fallback.
//
// Used by outbound tasks (missed-call text-back) so proactive messages land
// during the owner's open hours instead of at 2am.
export function nextOpenTime(schedule, fromTs = Date.now(), { stepMin = 15, maxDays = 7 } = {}) {
  if (evaluateSchedule(schedule, fromTs).inHours) return fromTs;
  const stepMs = stepMin * 60 * 1000;
  const horizon = fromTs + maxDays * 24 * 60 * 60 * 1000;
  for (let t = fromTs + stepMs; t <= horizon; t += stepMs) {
    if (evaluateSchedule(schedule, t).inHours) return t;
  }
  return null;
}
