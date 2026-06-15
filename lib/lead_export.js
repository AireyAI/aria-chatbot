// lead_export.js
//
// Owner lead CSV export. Leads currently live as append-only JSONL in two
// different shapes (data/leads.jsonl from the website widget, and
// data/channel_leads.jsonl from inbound IG/FB/WA channels) and "die in JSON"
// — there's no way for an owner to pull their leads into a CRM / spreadsheet.
// This module is the portability layer:
//
//   filterOwnerLeads(allRows, { ownerEmail, slug })  -> normalized rows for one owner
//   leadsToCsv(rows, { fields })                      -> RFC-4180 CSV string
//
// Pure functions — no I/O, no network, no Claude. Take plain arrays/objects,
// return values. Deterministic given inputs (the only time-ish input, ts, is
// passed through untouched). This keeps it £0 at runtime and trivially testable.
// The server reads the JSONL files, hands the parsed rows in, and streams the
// returned string back as a text/csv attachment.
//
// The two source shapes:
//   leads.jsonl        { ts, client, sessionId, name, email, phone,
//                        service_wanted, qualification_score, notes }
//                      -> owner match is on `client` (the site slug)
//   channel_leads.jsonl{ ts, ownerEmail, channel, senderId, senderName,
//                        leadScore('hot'|'warm'|'cold'), category,
//                        contact:{ email, phone, ... }, messagePreview,
//                        sentiment, urgency }
//                      -> owner match is on `ownerEmail`
//
// Both collapse to ONE normalized row so the CSV has a single stable schema:
//   { ts, name, email, phone, service, score, channel, source }
// where `score` is the website's numeric qualification_score (0-100) when
// present, otherwise the channel's textual band ('hot'|'warm'|'cold'), and
// `source` records which file the row came from ('web' | 'channel').

// Default column order for the CSV. Stable — do not reorder casually, owners
// import these into spreadsheets that key on position/header.
const DEFAULT_FIELDS = ['ts', 'name', 'email', 'phone', 'service', 'score', 'channel', 'source'];

// Human-friendly header labels per normalized field. Falls back to the raw
// field name for anything not listed (so a custom `fields` array still works).
const FIELD_LABELS = {
  ts: 'Date',
  name: 'Name',
  email: 'Email',
  phone: 'Phone',
  service: 'Service',
  score: 'Score',
  channel: 'Channel',
  source: 'Source',
};

// Coerce any value to a clean string cell. null/undefined -> ''. We don't
// stringify objects/arrays into "[object Object]" — that's never useful in a
// CSV; non-primitives become '' and the caller should normalize first.
function cellString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return ''; // normalized rows are flat; guard anyway
  return String(v);
}

// RFC-4180 field escaping. A field MUST be wrapped in double quotes if it
// contains a comma, a double quote, CR, or LF. Inner double quotes are
// doubled. We quote eagerly when any of those are present and leave plain
// values unquoted (smaller files, still valid).
function escapeCsvField(value) {
  const s = cellString(value);
  if (s === '') return '';
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Is this a website-shaped lead row (leads.jsonl)? It has `client` and no
// `ownerEmail`/`leadScore`. We branch on the discriminating fields rather than
// guessing, so a malformed row never silently lands in the wrong bucket.
function isWebRow(row) {
  return row && typeof row === 'object' && ('client' in row) && !('ownerEmail' in row);
}

// Normalize ONE source row (either shape) into the flat CSV row. Returns null
// for rows we can't classify (defensive — skipped by the caller).
function normalizeRow(row) {
  if (!row || typeof row !== 'object') return null;

  if (isWebRow(row)) {
    return {
      ts: row.ts ?? '',
      name: row.name ?? '',
      email: row.email ?? '',
      phone: row.phone ?? '',
      service: row.service_wanted ?? '',
      // numeric 0-100 qualification score; keep 0 as 0 (don't coerce to '')
      score: row.qualification_score ?? '',
      channel: 'website',
      source: 'web',
    };
  }

  // Channel-shaped row (channel_leads.jsonl). Contact details are nested.
  if (row && typeof row === 'object' && ('ownerEmail' in row || 'leadScore' in row || 'contact' in row)) {
    const contact = (row.contact && typeof row.contact === 'object') ? row.contact : {};
    return {
      ts: row.ts ?? '',
      name: row.senderName ?? contact.name ?? '',
      email: contact.email ?? '',
      phone: contact.phone ?? '',
      service: row.category ?? '',
      // textual band — hot/warm/cold
      score: row.leadScore ?? '',
      channel: row.channel ?? '',
      source: 'channel',
    };
  }

  return null;
}

// Does a raw source row belong to this owner?
//   - web rows match when row.client === slug
//   - channel rows match when row.ownerEmail === ownerEmail
// If only one of {ownerEmail, slug} is supplied, only that side can match.
function rowBelongsToOwner(row, { ownerEmail, slug }) {
  if (!row || typeof row !== 'object') return false;
  if (isWebRow(row)) {
    return slug != null && row.client === slug;
  }
  // channel row
  return ownerEmail != null && row.ownerEmail === ownerEmail;
}

/**
 * Filter a mixed array of raw lead rows (both source shapes) down to the rows
 * belonging to one owner, returned as normalized flat rows ready for CSV.
 *
 * @param {Array<object>} allRows - parsed rows from leads.jsonl + channel_leads.jsonl
 * @param {{ ownerEmail?: string, slug?: string }} opts
 * @returns {Array<{ts,name,email,phone,service,score,channel,source}>}
 */
export function filterOwnerLeads(allRows, { ownerEmail, slug } = {}) {
  if (!Array.isArray(allRows)) return [];
  const out = [];
  for (const row of allRows) {
    if (!rowBelongsToOwner(row, { ownerEmail, slug })) continue;
    const norm = normalizeRow(row);
    if (norm) out.push(norm);
  }
  return out;
}

/**
 * Render normalized rows as an RFC-4180 CSV string.
 *
 * - Always emits a header row (so empty input -> header only, never '').
 * - Stable column order (DEFAULT_FIELDS unless a `fields` array is given).
 * - CRLF line endings per the RFC.
 * - Correct escaping for commas, double quotes, and embedded newlines.
 *
 * @param {Array<object>} rows - normalized rows (output of filterOwnerLeads)
 * @param {{ fields?: string[] }} opts
 * @returns {string} CSV text
 */
export function leadsToCsv(rows, { fields } = {}) {
  const cols = Array.isArray(fields) && fields.length ? fields : DEFAULT_FIELDS;
  const headerLabels = cols.map((f) => FIELD_LABELS[f] || f);
  const lines = [headerLabels.map(escapeCsvField).join(',')];

  const data = Array.isArray(rows) ? rows : [];
  for (const row of data) {
    const cells = cols.map((f) => escapeCsvField(row ? row[f] : ''));
    lines.push(cells.join(','));
  }
  return lines.join('\r\n');
}

// Exported for the server wiring (filename + content-type) and for tests.
export const CSV_DEFAULT_FIELDS = DEFAULT_FIELDS;
