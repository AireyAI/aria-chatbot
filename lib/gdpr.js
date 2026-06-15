// gdpr.js
//
// Data-retention + data-subject-rights logic for Aria's lead ledgers.
//
// WHY THIS EXISTS:
//   Aria's lead stores (data/leads.jsonl, data/channel_leads.jsonl,
//   data/channel-messages.json) are append-only and contain personal data —
//   names, emails, phone numbers, message bodies. A write-only ledger with no
//   purge is a GDPR exposure that *grows every single day*: under UK GDPR an
//   owner must (a) not keep personal data longer than necessary (storage
//   limitation), (b) honour a Subject Access Request (Art. 15), and (c) honour
//   an erasure / "right to be forgotten" request (Art. 17). None of that is
//   possible against an immutable append-only file. This module supplies the
//   three pure operations the server/scheduler need:
//
//     - purgeExpired      → storage limitation (retention cutoff)
//     - subjectAccessExport → Art. 15 (give the subject their data)
//     - redactSubject     → Art. 17 (remove the subject's data)
//
// PURE LOGIC — no I/O, no network, no Claude. Every function takes plain arrays
// of records and returns plain values. The only time-dependent function
// (purgeExpired) accepts a `now` (epoch ms) so tests can pin the cutoff; the
// caller in server.js passes Date.now() by default. The server owns reading the
// JSONL/JSON files and rewriting them with the `kept` rows — see the wiring spec.
//
// RECORD SHAPE (loose by design — these run across three different stores with
// DIFFERENT conventions, verified against server.js, not assumed):
//   Timestamp:
//     - leads.jsonl / channel_leads.jsonl carry `ts`. In live data this is an
//       ISO-8601 STRING (server.js writes `ts: new Date().toISOString()`), not
//       epoch ms — so we parse strings as well as numbers.
//     - channel-messages.json carries `timestamp` (also ISO), NOT `ts`. If we
//       only read `ts` here, EVERY message body would look "un-ageable" and be
//       kept forever — silently defeating retention on the store that actually
//       holds the message text. So we read `ts` OR `timestamp`.
//   Subject identity:
//     - leads.jsonl carries top-level `email`/`phone`.
//     - channel_leads.jsonl nests them under `contact` ({ email, phone }).
//     - channel-messages.json carries NO email/phone — only `senderId` /
//       `senderName`. So the subject matcher also accepts an optional
//       `senderId` (exact) and `name` (case-insensitive) identifier, used only
//       when the caller supplies it, so an erasure/SAR can actually reach the
//       message bodies. None of these ever match "everyone".

// Read a timestamp off a record. The lead stores use `ts`; channel-messages
// uses `timestamp`. Both are ISO strings in live data (server.js), but we also
// accept a numeric epoch (ms) for forward-compat. Returns finite ms or NaN.
function readTs(row) {
  const t = row?.ts ?? row?.timestamp;
  if (typeof t === 'number') return t;
  if (typeof t === 'string') {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
    const p = Date.parse(t);
    return Number.isNaN(p) ? NaN : p;
  }
  return NaN;
}

// Pull every email a record might carry (top-level + nested contact).
function emailsOf(row) {
  const out = [];
  if (row?.email) out.push(row.email);
  if (row?.contact?.email) out.push(row.contact.email);
  return out;
}

// Pull every phone a record might carry (top-level + nested contact).
function phonesOf(row) {
  const out = [];
  if (row?.phone) out.push(row.phone);
  if (row?.contact?.phone) out.push(row.contact.phone);
  return out;
}

// Normalize an email for comparison: trim + lowercase. Returns '' for falsy.
function normEmail(e) {
  return typeof e === 'string' ? e.trim().toLowerCase() : '';
}

// Normalize a phone to bare digits so different formats compare equal.
// "+44 7497 812186", "07497 812186", "(07497) 812186" → "447497812186" /
// "07497812186". We deliberately keep the leading digits as-is here and rely on
// SUFFIX matching at the comparison site to bridge +44 vs 0 (a UK mobile is
// "+447497812186" vs "07497812186" — they share the suffix "7497812186").
function normPhone(p) {
  return typeof p === 'string' || typeof p === 'number'
    ? String(p).replace(/\D/g, '')
    : '';
}

// Strip a single leading "0" — the UK national trunk prefix. A UK mobile is
// "07497812186" nationally but "+447497812186" internationally; the "0" is
// dropped when the "+44" country code is added. Removing it from both sides
// leaves the significant subscriber digits ("7497812186") aligned for a clean
// suffix compare. (A bare international number has no leading 0, so this is a
// no-op for those.)
function dropTrunkZero(digits) {
  return digits.startsWith('0') ? digits.slice(1) : digits;
}

// Do two normalized phone digit-strings refer to the same number?
// Match if (after stripping the UK trunk 0) either is a suffix of the other AND
// the shared suffix is long enough to be meaningful (>= 7 digits — anything
// shorter than a subscriber number would cause false positives). This tolerates
// +44 vs 0 vs spaces/brackets:
//   "447497812186" vs "07497812186" → both → "7497812186" → match
//   "447497812186" vs "447497812186"               → exact match
function phonesMatch(rawA, rawB) {
  if (!rawA || !rawB) return false;
  if (rawA === rawB) return true;
  const a = dropTrunkZero(rawA);
  const b = dropTrunkZero(rawB);
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < 7) return false;
  return longer.endsWith(shorter);
}

// Build a reusable predicate: does this record belong to the named subject?
// A subject is identified by any of email / phone / senderId / name. A record
// matches if ANY of its emails matches the subject email (case-insensitive) OR
// any of its phones matches the subject phone (suffix-tolerant) OR its senderId
// matches exactly OR its senderName matches (case-insensitive). senderId/name
// exist so channel-messages.json records (which carry NO email/phone) can be
// reached for an access/erasure request. At least one identifier must be
// supplied or the predicate always returns false (never match "everyone").
function makeSubjectMatcher({ email, phone, senderId, name } = {}) {
  const wantEmail = normEmail(email);
  const wantPhone = normPhone(phone);
  const wantSenderId =
    senderId == null || senderId === '' ? '' : String(senderId);
  const wantName = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (!wantEmail && !wantPhone && !wantSenderId && !wantName) return () => false;
  return (row) => {
    if (wantEmail) {
      for (const e of emailsOf(row)) {
        if (normEmail(e) === wantEmail) return true;
      }
    }
    if (wantPhone) {
      for (const p of phonesOf(row)) {
        if (phonesMatch(normPhone(p), wantPhone)) return true;
      }
    }
    if (wantSenderId && row?.senderId != null) {
      if (String(row.senderId) === wantSenderId) return true;
    }
    if (wantName && typeof row?.senderName === 'string') {
      if (row.senderName.trim().toLowerCase() === wantName) return true;
    }
    return false;
  };
}

// --- Storage limitation (Art. 5(1)(e)) -------------------------------------
//
// Split rows into those still within the retention window and those past it.
// A row is EXPIRED when its age (now - ts) is STRICTLY GREATER than the
// retention window. A row exactly `retentionDays` old (age === window) is KEPT
// — the boundary is inclusive of the cutoff day, so retention is honoured to
// the millisecond and we never purge a day early.
//
// Rows with an unreadable/missing ts are KEPT (we never destroy data we can't
// confidently age — failing safe toward retention, not deletion).
//
//   purgeExpired(rows, { retentionDays: 365, now }) ->
//     { kept: [...], removed: [...], removedCount: N }
export function purgeExpired(rows, { retentionDays, now = Date.now() } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    // No valid retention configured → purge nothing (fail safe).
    return { kept: list.slice(), removed: [], removedCount: 0 };
  }
  const windowMs = retentionDays * 24 * 60 * 60 * 1000;
  const kept = [];
  const removed = [];
  for (const row of list) {
    const ts = readTs(row);
    if (Number.isNaN(ts)) {
      kept.push(row); // can't age it → keep it
      continue;
    }
    const age = now - ts;
    if (age > windowMs) removed.push(row);
    else kept.push(row);
  }
  return { kept, removed, removedCount: removed.length };
}

// --- Subject Access Request (Art. 15) --------------------------------------
//
// Return every record belonging to the data subject, in original order. Read-
// only: does not mutate the input. Empty subject (no identifier) → [].
//
//   subjectAccessExport(rows, { email, phone, senderId, name }) -> [matching rows]
export function subjectAccessExport(rows, { email, phone, senderId, name } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const matches = makeSubjectMatcher({ email, phone, senderId, name });
  return list.filter((row) => matches(row));
}

// --- Erasure / Right to be forgotten (Art. 17) -----------------------------
//
// Remove ONLY the subject's records; everyone else's data is untouched and
// returned in `kept` (original order). With an empty subject (no identifier)
// nothing is removed — we never wipe the whole store on a missing identifier.
//
//   redactSubject(rows, { email, phone, senderId, name }) -> { kept: [...], removedCount: N }
export function redactSubject(rows, { email, phone, senderId, name } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const matches = makeSubjectMatcher({ email, phone, senderId, name });
  const kept = [];
  let removedCount = 0;
  for (const row of list) {
    if (matches(row)) removedCount += 1;
    else kept.push(row);
  }
  return { kept, removedCount };
}
