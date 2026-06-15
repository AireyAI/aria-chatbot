// Tests for lib/heartbeat.js — silent-failure detection.
//
// The contract these tests defend (and would catch a regression on):
//   1. A surface broken/silent past its grace window must be flagged.
//   2. A surface that is NATURALLY quiet must NOT false-alarm — this is the
//      whole reason the module derives thresholds per-surface. If someone
//      "simplifies" detectAnomalies to a global cutoff, these tests fail.
//   3. Unknown rhythm / junk / empty input degrade safely (no alert), never throw.
//   4. assessSilence's `now` is injectable so time is pinnable.

import { describe, it, expect } from 'vitest';
import { assessSilence, detectAnomalies, formatAlert } from '../lib/heartbeat.js';

const H = 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // fixed epoch ms for deterministic tests

describe('assessSilence', () => {
  it('reports healthy when last activity is within the expected window', () => {
    const r = assessSilence({ lastActivityTs: NOW - 1 * H, now: NOW, expectedWithinHours: 4 });
    expect(r.silent).toBe(false);
    expect(r.hoursSince).toBeCloseTo(1, 5);
  });

  it('reports silent once the gap exceeds the expected window', () => {
    const r = assessSilence({ lastActivityTs: NOW - 10 * H, now: NOW, expectedWithinHours: 4 });
    expect(r.silent).toBe(true);
    expect(r.hoursSince).toBeCloseTo(10, 5);
  });

  it('is NOT silent exactly at the boundary, only strictly beyond it', () => {
    const atBoundary = assessSilence({ lastActivityTs: NOW - 4 * H, now: NOW, expectedWithinHours: 4 });
    expect(atBoundary.silent).toBe(false); // 4h gap, 4h window → not yet broken
    const justOver = assessSilence({ lastActivityTs: NOW - (4 * H + 1), now: NOW, expectedWithinHours: 4 });
    expect(justOver.silent).toBe(true);
  });

  it('treats a never-active surface as unknown: infinite gap, not flagged silent', () => {
    const r = assessSilence({ lastActivityTs: null, now: NOW, expectedWithinHours: 4 });
    expect(r.hoursSince).toBe(Infinity);
    expect(r.silent).toBe(false);
  });

  it('handles 0 / NaN lastActivityTs as unknown', () => {
    expect(assessSilence({ lastActivityTs: 0, now: NOW, expectedWithinHours: 4 }).hoursSince).toBe(Infinity);
    expect(assessSilence({ lastActivityTs: NaN, now: NOW, expectedWithinHours: 4 }).hoursSince).toBe(Infinity);
  });

  it('never reports silent when no expected window is given', () => {
    const r = assessSilence({ lastActivityTs: NOW - 1000 * H, now: NOW });
    expect(r.silent).toBe(false);
    expect(r.hoursSince).toBeCloseTo(1000, 5);
  });

  it('never reports silent when the expected window is zero or negative', () => {
    // A non-positive window is "no usable window" → must NOT alarm, even for a
    // huge gap. Guards against a regression where the `> 0` check became truthy.
    expect(assessSilence({ lastActivityTs: NOW - 1000 * H, now: NOW, expectedWithinHours: 0 }).silent).toBe(false);
    expect(assessSilence({ lastActivityTs: NOW - 1000 * H, now: NOW, expectedWithinHours: -5 }).silent).toBe(false);
  });

  it('returns safe defaults when called with no arguments at all', () => {
    const r = assessSilence();
    expect(r.silent).toBe(false);
    expect(r.hoursSince).toBe(Infinity);
  });

  it('clamps negative gaps (clock skew / future timestamp) to 0 hours', () => {
    const r = assessSilence({ lastActivityTs: NOW + 5 * H, now: NOW, expectedWithinHours: 4 });
    expect(r.hoursSince).toBe(0);
    expect(r.silent).toBe(false);
  });

  it('defaults now to Date.now() when omitted', () => {
    const r = assessSilence({ lastActivityTs: Date.now() - 2 * H, expectedWithinHours: 4 });
    expect(r.silent).toBe(false);
    expect(r.hoursSince).toBeGreaterThan(1.5);
    expect(r.hoursSince).toBeLessThan(2.5);
  });
});

describe('detectAnomalies', () => {
  it('flags a chatty surface that has gone unexpectedly dark', () => {
    // whatsapp normally every 2h → grace ~ max(6, 2*4)=8h. 30h dark = broken.
    const alerts = detectAnomalies(
      { whatsapp: { lastActivityTs: NOW - 30 * H, typicalIntervalHours: 2 } },
      { now: NOW }
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].surface).toBe('whatsapp');
    expect(alerts[0].severity).toBe('critical'); // 30h >> 2*8h
    expect(alerts[0].hoursSince).toBeCloseTo(30, 1);
  });

  it('does NOT flag the same chatty surface when it is within rhythm', () => {
    const alerts = detectAnomalies(
      { whatsapp: { lastActivityTs: NOW - 3 * H, typicalIntervalHours: 2 } },
      { now: NOW }
    );
    expect(alerts).toEqual([]);
  });

  it('does NOT false-alarm a NATURALLY quiet surface even after many days dark', () => {
    // voice normally only every ~10 days → above the naturally-quiet cutoff.
    // 12 days of silence is normal for it; must stay silent.
    const alerts = detectAnomalies(
      { voice: { lastActivityTs: NOW - 12 * 24 * H, typicalIntervalHours: 10 * 24 } },
      { now: NOW }
    );
    expect(alerts).toEqual([]);
  });

  it('distinguishes a broken busy surface from a fine quiet one in the same sweep', () => {
    const alerts = detectAnomalies(
      {
        whatsapp: { lastActivityTs: NOW - 40 * H, typicalIntervalHours: 2 },   // BROKEN
        voice:    { lastActivityTs: NOW - 30 * 24 * H, typicalIntervalHours: 14 * 24 }, // naturally quiet, fine
        web:      { lastActivityTs: NOW - 1 * H, typicalIntervalHours: 1 },     // healthy
      },
      { now: NOW }
    );
    expect(alerts.map(a => a.surface)).toEqual(['whatsapp']);
  });

  it('marks a configured-but-never-active surface as critical (silent failure)', () => {
    // claims a 3h rhythm but has literally never fired → very suspicious.
    const alerts = detectAnomalies(
      { instagram: { lastActivityTs: null, typicalIntervalHours: 3 } },
      { now: NOW }
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].surface).toBe('instagram');
    expect(alerts[0].severity).toBe('critical');
    expect(alerts[0].hoursSince).toBe(Infinity);
    expect(alerts[0].lastActivityTs).toBeNull();
  });

  it('ignores surfaces with unknown rhythm (no typicalIntervalHours)', () => {
    const alerts = detectAnomalies(
      {
        facebook: { lastActivityTs: NOW - 100 * H },                 // no interval
        whatsapp: { lastActivityTs: NOW - 1 * H, typicalIntervalHours: 0 }, // invalid interval
      },
      { now: NOW }
    );
    expect(alerts).toEqual([]);
  });

  it('respects MIN_EXPECTED_HOURS floor — a hyper-chatty surface gets a 6h grace, not seconds', () => {
    // interval 0.1h → raw grace 0.4h, but floored to 6h. A 4h gap must NOT alarm.
    const alerts = detectAnomalies(
      { web: { lastActivityTs: NOW - 4 * H, typicalIntervalHours: 0.1 } },
      { now: NOW }
    );
    expect(alerts).toEqual([]);
    // ...but 8h dark on that same surface DOES alarm (past the 6h floor).
    const broken = detectAnomalies(
      { web: { lastActivityTs: NOW - 8 * H, typicalIntervalHours: 0.1 } },
      { now: NOW }
    );
    expect(broken.map(a => a.surface)).toEqual(['web']);
  });

  it('honours a custom silenceMultiplier baseline override', () => {
    const surface = { whatsapp: { lastActivityTs: NOW - 9 * H, typicalIntervalHours: 2 } };
    // default multiplier 4 → grace 8h → 9h is broken
    expect(detectAnomalies(surface, { now: NOW }).length).toBe(1);
    // multiplier 6 → grace 12h → 9h is fine
    expect(detectAnomalies(surface, { now: NOW, baseline: { silenceMultiplier: 6 } })).toEqual([]);
  });

  it('honours a custom naturallyQuietIntervalHrs override', () => {
    // surface fires every 48h. Default cutoff (1 week) watches it → 300h dark alarms.
    const surface = { sms: { lastActivityTs: NOW - 300 * H, typicalIntervalHours: 48 } };
    expect(detectAnomalies(surface, { now: NOW }).length).toBe(1);
    // lower the cutoff below 48h → surface is now "naturally quiet", suppressed.
    expect(detectAnomalies(surface, { now: NOW, baseline: { naturallyQuietIntervalHrs: 24 } })).toEqual([]);
  });

  it('suppresses a surface whose interval is EXACTLY the quiet cutoff (>= boundary)', () => {
    // The cutoff is inclusive: interval === cutoff means "naturally quiet".
    // Defends the `>=` in the quiet-cutoff guard against a `>` regression.
    const surface = { sms: { lastActivityTs: NOW - 5000 * H, typicalIntervalHours: 24 } };
    expect(detectAnomalies(surface, { now: NOW, baseline: { naturallyQuietIntervalHrs: 24 } })).toEqual([]);
    // one tick below the cutoff → now watched, so a long dark stretch DOES alarm.
    const surfaceBelow = { sms: { lastActivityTs: NOW - 5000 * H, typicalIntervalHours: 23.9 } };
    expect(detectAnomalies(surfaceBelow, { now: NOW, baseline: { naturallyQuietIntervalHrs: 24 } }).map(a => a.surface)).toEqual(['sms']);
  });

  it('caps the deadline at MAX_EXPECTED_HOURS so a slow-but-watched surface still alarms', () => {
    // interval 48h, multiplier 4 → raw grace 192h, but capped to 168h (1 week).
    // So a surface dark for 170h (between raw-grace and cap) still alarms. If the
    // MAX cap were removed, 170h < 192h and it would wrongly stay silent.
    const alerts = detectAnomalies(
      { sms: { lastActivityTs: NOW - 170 * H, typicalIntervalHours: 48 } },
      { now: NOW }
    );
    expect(alerts.map(a => a.surface)).toEqual(['sms']);
    expect(alerts[0].expectedWithinHours).toBe(168);
  });

  it('defaults now to Date.now() when omitted (a freshly-dark surface alarms)', () => {
    // No `now` passed → uses real clock. A surface last active 50h ago, normally
    // every 2h, must alarm. Guards the default-now path through detectAnomalies.
    const alerts = detectAnomalies(
      { whatsapp: { lastActivityTs: Date.now() - 50 * H, typicalIntervalHours: 2 } }
    );
    expect(alerts.map(a => a.surface)).toEqual(['whatsapp']);
  });

  it('sorts worst-first (never-active, then longest gap)', () => {
    const alerts = detectAnomalies(
      {
        a: { lastActivityTs: NOW - 20 * H, typicalIntervalHours: 1 },
        b: { lastActivityTs: null, typicalIntervalHours: 1 },          // never active → top
        c: { lastActivityTs: NOW - 50 * H, typicalIntervalHours: 1 },  // longest finite gap
      },
      { now: NOW }
    );
    expect(alerts.map(a => a.surface)).toEqual(['b', 'c', 'a']);
  });

  it('returns [] for empty, null, or non-object input without throwing', () => {
    expect(detectAnomalies({}, { now: NOW })).toEqual([]);
    expect(detectAnomalies(null, { now: NOW })).toEqual([]);
    expect(detectAnomalies(undefined)).toEqual([]);
    expect(detectAnomalies('nope', { now: NOW })).toEqual([]);
  });

  it('skips junk per-surface entries without throwing', () => {
    const alerts = detectAnomalies(
      {
        whatsapp: null,
        voice: 'broken',
        web: { lastActivityTs: NOW - 40 * H, typicalIntervalHours: 2 }, // the one real broken surface
      },
      { now: NOW }
    );
    expect(alerts.map(a => a.surface)).toEqual(['web']);
  });
});

describe('formatAlert', () => {
  it('produces a critical line with the red marker and human gap', () => {
    const line = formatAlert({ surface: 'whatsapp', hoursSince: 31, typicalIntervalHours: 2, severity: 'critical' });
    expect(line).toContain('🔴');
    expect(line).toContain('whatsapp');
    expect(line).toContain('31h');
    expect(line).toContain('~2h');
    expect(line).toMatch(/broken integration/i);
  });

  it('produces a warning line with the orange marker', () => {
    const line = formatAlert({ surface: 'web', hoursSince: 9, typicalIntervalHours: 1, severity: 'warning' });
    expect(line).toContain('🟠');
    expect(line).toContain('web');
  });

  it('phrases a never-active surface as "no activity on record"', () => {
    const line = formatAlert({ surface: 'instagram', hoursSince: Infinity, typicalIntervalHours: 3, severity: 'critical' });
    expect(line).toMatch(/no activity on record/i);
    expect(line).not.toContain('Infinity');
  });

  it('formats multi-day gaps compactly', () => {
    const line = formatAlert({ surface: 'voice', hoursSince: 52, typicalIntervalHours: 6, severity: 'critical' });
    expect(line).toContain('2d 4h');
  });

  it('formats sub-hour gaps in minutes', () => {
    const line = formatAlert({ surface: 'web', hoursSince: 0.5, typicalIntervalHours: 0.1, severity: 'warning' });
    expect(line).toContain('30m');
  });

  it('returns empty string for a junk alert', () => {
    expect(formatAlert(null)).toBe('');
    expect(formatAlert({})).toBe('');
  });

  it('rounds a fractional hours gap to a whole-hour figure', () => {
    const line = formatAlert({ surface: 'whatsapp', hoursSince: 30.4, typicalIntervalHours: 2, severity: 'critical' });
    expect(line).toContain('30h');
    expect(line).not.toContain('30.4');
  });

  it('omits the rhythm clause when typical interval is missing or invalid', () => {
    const line = formatAlert({ surface: 'web', hoursSince: 9, severity: 'warning' });
    expect(line).toContain('web');
    expect(line).not.toContain('normally every');
  });

  it('round-trips a WARNING alert from detectAnomalies into a clean orange line', () => {
    // 10h dark, normally every 2h → grace 8h, gap 10h < 2*8 → warning (not critical).
    const [alert] = detectAnomalies(
      { whatsapp: { lastActivityTs: NOW - 10 * H, typicalIntervalHours: 2 } },
      { now: NOW }
    );
    expect(alert.severity).toBe('warning');
    const line = formatAlert(alert);
    expect(line).toContain('🟠');
    expect(line).toContain('whatsapp');
  });

  it('round-trips: a detectAnomalies alert formats cleanly', () => {
    const [alert] = detectAnomalies(
      { whatsapp: { lastActivityTs: NOW - 30 * H, typicalIntervalHours: 2 } },
      { now: NOW }
    );
    const line = formatAlert(alert);
    expect(line).toContain('whatsapp');
    expect(line.length).toBeGreaterThan(20);
  });
});
