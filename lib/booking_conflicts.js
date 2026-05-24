// booking_conflicts.js
//
// Detects overlap between a proposed booking and the owner's existing
// confirmed bookings. Pure function — no I/O, no clock dep beyond what's
// passed in. Used by:
//   - the booking-ready path in handleIncomingChannelMessage (prevents Aria
//     confirming a slot that's already taken — Aria's single biggest
//     production own-goal risk)
//   - any future calendar-style admin view that wants to flag double-booked
//     entries retroactively
//
// Definition of "conflict": two bookings overlap if their [start, end)
// intervals intersect. A 14:00-15:00 booking and a 14:30-15:30 booking
// conflict. A 14:00-15:00 and 15:00-16:00 do NOT conflict (back-to-back
// is OK by default — set bufferMin > 0 to enforce a gap).
//
// Cancelled bookings (status === 'cancelled') are ignored. Past bookings
// (end time < now) are also ignored so we don't block this Tuesday because
// someone had this Tuesday slot last week.

import { parseBookingDateTime } from './ics_builder.js';

const DEFAULT_DURATION_MIN = 60;

// One overlap check between two intervals. Both ends exclusive on the right.
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Main entry. Args:
//   newDatetime  — string (ISO or UK format), or Date object
//   durationMin  — minutes for the proposed booking (default 60)
//   existing     — array of booking records: { datetime, durationMin?, status?, ... }
//   bufferMin    — minutes of gap required between bookings (default 0)
//   now          — Date for "ignore past" filter (default new Date())
//
// Returns array of conflicting existing records (empty if no conflict).
// Caller decides what to do with conflicts (deny, suggest alt, alert).
export function findBookingConflicts({
  newDatetime,
  durationMin = DEFAULT_DURATION_MIN,
  existing    = [],
  bufferMin   = 0,
  now         = new Date(),
}) {
  const newStart = newDatetime instanceof Date
    ? newDatetime
    : parseBookingDateTime(newDatetime);
  if (!newStart || isNaN(newStart.getTime())) return []; // can't compare what we can't parse

  const newEnd       = new Date(newStart.getTime() + durationMin * 60_000);
  const bufferMs     = bufferMin * 60_000;
  const nowMs        = now.getTime();

  const conflicts = [];
  for (const b of existing) {
    if (!b || b.status === 'cancelled') continue;

    const bStart = b.datetime instanceof Date
      ? b.datetime
      : parseBookingDateTime(b.datetime);
    if (!bStart || isNaN(bStart.getTime())) continue;

    const bDur   = Number(b.durationMin) > 0 ? Number(b.durationMin) : DEFAULT_DURATION_MIN;
    const bEnd   = new Date(bStart.getTime() + bDur * 60_000);
    // Skip bookings entirely in the past
    if (bEnd.getTime() < nowMs) continue;

    // Apply buffer by expanding the existing interval on both sides
    const bStartBuf = new Date(bStart.getTime() - bufferMs);
    const bEndBuf   = new Date(bEnd.getTime()   + bufferMs);

    if (overlaps(newStart, newEnd, bStartBuf, bEndBuf)) {
      conflicts.push({
        ...b,
        _parsedStart: bStart.toISOString(),
        _parsedEnd:   bEnd.toISOString(),
      });
    }
  }
  return conflicts;
}

// Helper: format a conflict list into customer-facing text. Use after
// findBookingConflicts returns non-empty so Aria can explain WHY she
// can't confirm without exposing other customers' details (privacy:
// we never say WHO has the slot, just THAT it's taken).
export function describeConflictsForCustomer(conflicts) {
  if (!conflicts || conflicts.length === 0) return null;
  if (conflicts.length === 1) {
    const c = conflicts[0];
    const when = new Date(c._parsedStart || c.datetime).toLocaleString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
    return `that ${when} slot is already taken`;
  }
  return `those times overlap with ${conflicts.length} existing bookings`;
}
