// ics_builder.js
//
// Generate RFC 5545 iCalendar (.ics) file content for booking confirmations.
// Works with every calendar app — Apple, Google, Outlook, Fantastical, etc.
// Customers tap the attachment, calendar adds the event with one tap.
//
// No dependencies. Pure string assembly. The hardest part is correct CRLF
// line endings + folding long lines at 75 octets (we ignore folding for
// our short bookings — fields are bounded).

// Format a Date object as ICS UTC datetime: 20260524T143000Z
function fmtUTC(dt) {
  const d = new Date(dt);
  if (isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) + 'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) + 'Z';
}

// Escape per RFC 5545 §3.3.11
function escIcs(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Build a single-event ICS string.
//
// Required:
//   uid           — globally unique (we use booking timestamp + senderId)
//   start         — Date or ISO string
//   summary       — event title (shown in calendar)
// Optional:
//   end           — defaults to start + 60 min if not given
//   description   — long text shown in event details
//   location      — physical/virtual address
//   organizerEmail — appears as event organiser
//   attendeeEmail  — customer email (if captured) — gets invite + RSVP
//   attendeeName
export function buildIcsEvent({ uid, start, end, summary, description, location, organizerEmail, organizerName, attendeeEmail, attendeeName }) {
  const startStr = fmtUTC(start);
  if (!startStr) throw new Error('Invalid start datetime');
  const endStr = fmtUTC(end || new Date(new Date(start).getTime() + 60 * 60 * 1000));
  const stampStr = fmtUTC(new Date());

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AireyAI//Aria Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}@aireyai.co.uk`,
    `DTSTAMP:${stampStr}`,
    `DTSTART:${startStr}`,
    `DTEND:${endStr}`,
    `SUMMARY:${escIcs(summary || 'Booking')}`,
  ];
  if (description) lines.push(`DESCRIPTION:${escIcs(description)}`);
  if (location)    lines.push(`LOCATION:${escIcs(location)}`);
  if (organizerEmail) {
    lines.push(`ORGANIZER;CN=${escIcs(organizerName || organizerEmail)}:mailto:${organizerEmail}`);
  }
  if (attendeeEmail) {
    lines.push(`ATTENDEE;CN=${escIcs(attendeeName || attendeeEmail)};RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:${attendeeEmail}`);
  }
  lines.push('STATUS:CONFIRMED');
  lines.push('SEQUENCE:0');
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');

  return lines.join('\r\n') + '\r\n';
}

// Parse the loose datetime strings Claude tends to return into proper Date
// objects. Returns null if unparseable — caller should fall back to plain
// "your booking is confirmed" message without an .ics attachment.
//
// Handles:
//   - ISO 8601: "2026-05-28T14:00:00Z" or "2026-05-28 14:00"
//   - DD/MM/YYYY HH:mm: "28/05/2026 14:00" (UK default)
//   - Named days resolved by Claude already: assumes ISO when given
export function parseBookingDateTime(s) {
  if (!s) return null;
  const raw = String(s).trim();

  // Try native Date parse first (handles ISO + many common formats)
  const direct = new Date(raw);
  if (!isNaN(direct.getTime()) && direct.getFullYear() > 2020) return direct;

  // UK DD/MM/YYYY HH:mm
  const ukMatch = raw.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})[ T]+(\d{1,2}):(\d{2})/);
  if (ukMatch) {
    const [, dd, mm, yy, hh, mi] = ukMatch;
    const year = yy.length === 2 ? 2000 + Number(yy) : Number(yy);
    const d = new Date(year, Number(mm) - 1, Number(dd), Number(hh), Number(mi));
    if (!isNaN(d.getTime())) return d;
  }

  return null;
}
