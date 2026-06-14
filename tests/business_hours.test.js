// business_hours.test.js
//
// Regression suite for the dashboard→bot schedule key contract.
//
// The "Train Aria → Business hours" dashboard card (public/dashboard/panels.js)
// saves a schedule shaped as { mode, timezone, days, outOfHours, outOfHoursMessage }.
// The bot gate evaluateSchedule() is the single consumer. These tests prove that
// the hours an owner actually saves via the dashboard reach the gate — the bug was
// that the gate only read `businessHours`/`outOfHoursMode` and silently fell back to
// a default 9-18 Mon-Fri window, ignoring everything the dashboard saved.

import { describe, it, expect } from 'vitest';
import { evaluateSchedule } from '../lib/business_hours.js';

// 2026-06-15 is a Monday. June = BST (UTC+1), so 10:00 UTC == 11:00 Europe/London.
const MON_1100_LONDON = Date.parse('2026-06-15T10:00:00Z');

describe('evaluateSchedule — dashboard-saved schedule shape (days / outOfHours)', () => {
  it('honours a dashboard-saved daily window instead of the default 9-18', () => {
    // Owner moved Monday hours to the afternoon only. At 11:00 they are CLOSED.
    const dashboardSaved = {
      mode: 'business_hours',
      timezone: 'Europe/London',
      days: { mon: '14-18', tue: '9-17', wed: '9-17', thu: '9-17', fri: '9-17', sat: 'closed', sun: 'closed' },
      outOfHours: 'auto_reply',
      outOfHoursMessage: 'We open at 2pm on Mondays.',
    };
    const { inHours } = evaluateSchedule(dashboardSaved, MON_1100_LONDON);
    expect(inHours).toBe(false); // 11:00 is before the saved 14-18 window
  });

  it('honours a dashboard-saved out-of-hours mode (silent)', () => {
    const dashboardSaved = {
      mode: 'business_hours',
      timezone: 'Europe/London',
      days: { mon: 'closed', tue: '9-17', wed: '9-17', thu: '9-17', fri: '9-17', sat: 'closed', sun: 'closed' },
      outOfHours: 'silent',
    };
    const res = evaluateSchedule(dashboardSaved, MON_1100_LONDON);
    expect(res.inHours).toBe(false);
    expect(res.outOfHoursMode).toBe('silent');
  });
});

describe('evaluateSchedule — canonical businessHours/outOfHoursMode still win', () => {
  it('prefers businessHours/outOfHoursMode when both keys are present', () => {
    // The voice path (voiceShouldAnswer) passes businessHours directly — it must
    // keep working and take precedence over any legacy days key.
    const sched = {
      mode: 'business_hours',
      timezone: 'Europe/London',
      businessHours: { mon: '9-18', tue: '9-18', wed: '9-18', thu: '9-18', fri: '9-18', sat: 'closed', sun: 'closed' },
      days: { mon: 'closed' }, // stale — must be ignored in favour of businessHours
      outOfHoursMode: 'auto_reply',
      outOfHours: 'silent',
    };
    const res = evaluateSchedule(sched, MON_1100_LONDON);
    expect(res.inHours).toBe(true);             // businessHours mon 9-18 wins
    expect(res.outOfHoursMode).toBe('auto_reply'); // outOfHoursMode wins
  });
});
