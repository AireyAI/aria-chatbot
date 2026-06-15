import { describe, it, expect } from 'vitest';
import { filterOwnerLeads, leadsToCsv, CSV_DEFAULT_FIELDS } from '../lib/lead_export.js';

// Sample raw rows in the two real source shapes.
const webRow = (over = {}) => ({
  ts: '2026-06-10T09:00:00.000Z',
  client: 'jord-window-cleaning',
  sessionId: 's1',
  name: 'Alice',
  email: 'alice@example.com',
  phone: '07123456789',
  service_wanted: 'Gutter clean',
  qualification_score: 85,
  notes: 'eager',
  ...over,
});

const channelRow = (over = {}) => ({
  ts: '2026-06-11T10:00:00.000Z',
  ownerEmail: 'owner@biz.co.uk',
  channel: 'instagram',
  senderId: 'ig_1',
  senderName: 'Bob',
  leadScore: 'hot',
  category: 'booking',
  contact: { email: 'bob@example.com', phone: '07999000111' },
  messagePreview: 'hi there',
  sentiment: 'positive',
  urgency: 'high',
  ...over,
});

describe('filterOwnerLeads', () => {
  it('filters web rows by slug and channel rows by ownerEmail', () => {
    const rows = [
      webRow({ client: 'jord-window-cleaning', name: 'Alice' }),
      webRow({ client: 'someone-else', name: 'NotMine' }),
      channelRow({ ownerEmail: 'owner@biz.co.uk', senderName: 'Bob' }),
      channelRow({ ownerEmail: 'other@biz.co.uk', senderName: 'NotMine2' }),
    ];
    const out = filterOwnerLeads(rows, { ownerEmail: 'owner@biz.co.uk', slug: 'jord-window-cleaning' });
    expect(out.map((r) => r.name)).toEqual(['Alice', 'Bob']);
  });

  it('normalizes a web row into the flat shape (numeric score, website channel)', () => {
    const out = filterOwnerLeads([webRow()], { slug: 'jord-window-cleaning' });
    expect(out).toEqual([
      {
        ts: '2026-06-10T09:00:00.000Z',
        name: 'Alice',
        email: 'alice@example.com',
        phone: '07123456789',
        service: 'Gutter clean',
        score: 85,
        channel: 'website',
        source: 'web',
      },
    ]);
  });

  it('normalizes a channel row, lifting nested contact + textual band', () => {
    const out = filterOwnerLeads([channelRow()], { ownerEmail: 'owner@biz.co.uk' });
    expect(out).toEqual([
      {
        ts: '2026-06-11T10:00:00.000Z',
        name: 'Bob',
        email: 'bob@example.com',
        phone: '07999000111',
        service: 'booking',
        score: 'hot',
        channel: 'instagram',
        source: 'channel',
      },
    ]);
  });

  it('preserves a qualification_score of 0 (does not coerce to empty)', () => {
    const out = filterOwnerLeads([webRow({ qualification_score: 0 })], { slug: 'jord-window-cleaning' });
    expect(out[0].score).toBe(0);
  });

  it('does NOT match web rows when only ownerEmail is supplied (and vice versa)', () => {
    const rows = [webRow(), channelRow()];
    // only slug -> only the web row
    expect(filterOwnerLeads(rows, { slug: 'jord-window-cleaning' }).map((r) => r.source)).toEqual(['web']);
    // only ownerEmail -> only the channel row
    expect(filterOwnerLeads(rows, { ownerEmail: 'owner@biz.co.uk' }).map((r) => r.source)).toEqual(['channel']);
  });

  it('handles missing fields gracefully (empty strings, no throw)', () => {
    const out = filterOwnerLeads(
      [{ client: 'jord-window-cleaning' }, { ownerEmail: 'owner@biz.co.uk' }],
      { ownerEmail: 'owner@biz.co.uk', slug: 'jord-window-cleaning' },
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ name: '', email: '', phone: '', channel: 'website', source: 'web' });
    expect(out[1]).toMatchObject({ name: '', email: '', phone: '', source: 'channel' });
  });

  it('channel row with missing/non-object contact does not throw', () => {
    const out = filterOwnerLeads(
      [channelRow({ contact: undefined }), channelRow({ contact: null })],
      { ownerEmail: 'owner@biz.co.uk' },
    );
    expect(out).toHaveLength(2);
    expect(out[0].email).toBe('');
    expect(out[1].phone).toBe('');
  });

  it('returns [] for non-array input', () => {
    expect(filterOwnerLeads(null, { slug: 'x' })).toEqual([]);
    expect(filterOwnerLeads(undefined, {})).toEqual([]);
    expect(filterOwnerLeads({}, { slug: 'x' })).toEqual([]);
  });

  it('returns [] when no owner identifiers match anything', () => {
    expect(filterOwnerLeads([webRow(), channelRow()], { ownerEmail: 'nobody', slug: 'nope' })).toEqual([]);
    expect(filterOwnerLeads([webRow(), channelRow()], {})).toEqual([]);
  });

  it('falls back to contact.name for a channel row missing senderName', () => {
    const out = filterOwnerLeads(
      [channelRow({ senderName: undefined, contact: { name: 'Carol', email: 'c@x.com' } })],
      { ownerEmail: 'owner@biz.co.uk' },
    );
    expect(out[0].name).toBe('Carol');
  });

  it('senderName wins over contact.name when BOTH are present', () => {
    // Guards the `senderName ?? contact.name` precedence — a regression that
    // flipped the order would silently mislabel every channel lead.
    const out = filterOwnerLeads(
      [channelRow({ senderName: 'Dave', contact: { name: 'WRONG', email: 'd@x.com' } })],
      { ownerEmail: 'owner@biz.co.uk' },
    );
    expect(out[0].name).toBe('Dave');
  });

  it('classifies a row carrying BOTH client AND ownerEmail as a CHANNEL row', () => {
    // The whole point of the isWebRow discriminator is `'client' in row &&
    // !('ownerEmail' in row)`. If it were loosened to just `'client' in row`,
    // this corrupt/ambiguous row would be mis-bucketed as web (wrong shape,
    // wrong owner-match field). This test fails if the discriminator regresses.
    const hybrid = {
      ts: 't',
      client: 'jord-window-cleaning',
      ownerEmail: 'owner@biz.co.uk',
      channel: 'facebook',
      senderName: 'Hybrid',
      leadScore: 'warm',
      category: 'quote',
      contact: { email: 'h@x.com', phone: '07000' },
    };
    // Must NOT match when filtering by slug (it is not a web row)…
    expect(filterOwnerLeads([hybrid], { slug: 'jord-window-cleaning' })).toEqual([]);
    // …and MUST match + normalize as a channel row when filtering by ownerEmail.
    const out = filterOwnerLeads([hybrid], { ownerEmail: 'owner@biz.co.uk' });
    expect(out).toEqual([
      {
        ts: 't',
        name: 'Hybrid',
        email: 'h@x.com',
        phone: '07000',
        service: 'quote',
        score: 'warm',
        channel: 'facebook',
        source: 'channel',
      },
    ]);
  });

  it('keeps every matching row (no drop/dedup/merge) and order is input order', () => {
    // Two web + two channel, interleaved; all four belong to the owner.
    const rows = [
      webRow({ name: 'W1' }),
      channelRow({ senderName: 'C1' }),
      webRow({ name: 'W2' }),
      channelRow({ senderName: 'C2' }),
    ];
    const out = filterOwnerLeads(rows, { ownerEmail: 'owner@biz.co.uk', slug: 'jord-window-cleaning' });
    expect(out).toHaveLength(4);
    expect(out.map((r) => r.name)).toEqual(['W1', 'C1', 'W2', 'C2']);
  });
});

describe('leadsToCsv — RFC-4180 escaping', () => {
  it('emits header only for empty rows', () => {
    const csv = leadsToCsv([]);
    expect(csv).toBe('Date,Name,Email,Phone,Service,Score,Channel,Source');
    expect(csv.includes('\r\n')).toBe(false); // single line, no trailing newline
  });

  it('emits header only for non-array input', () => {
    expect(leadsToCsv(null)).toBe('Date,Name,Email,Phone,Service,Score,Channel,Source');
    expect(leadsToCsv(undefined)).toBe('Date,Name,Email,Phone,Service,Score,Channel,Source');
  });

  it('quotes values containing a comma', () => {
    const csv = leadsToCsv([{ name: 'Smith, John', email: 'a@b.com' }], { fields: ['name', 'email'] });
    const [, dataLine] = csv.split('\r\n');
    expect(dataLine).toBe('"Smith, John",a@b.com');
  });

  it('escapes embedded double quotes by doubling and wrapping', () => {
    const csv = leadsToCsv([{ name: 'He said "hi"' }], { fields: ['name'] });
    expect(csv.split('\r\n')[1]).toBe('"He said ""hi"""');
  });

  it('quotes values containing newlines (CR, LF, CRLF)', () => {
    const csv = leadsToCsv(
      [{ notes: 'line1\nline2' }, { notes: 'a\rb' }, { notes: 'x\r\ny' }],
      { fields: ['notes'] },
    );
    const lines = csv.split('\r\n');
    // header is line 0; the embedded-newline cells are themselves quoted so
    // splitting on \r\n at the record level is unsafe in general — assert by
    // searching for the quoted forms instead.
    expect(csv).toContain('"line1\nline2"');
    expect(csv).toContain('"a\rb"');
    expect(csv).toContain('"x\r\ny"');
    // header is intact and unquoted ('notes' has no label -> raw field name)
    expect(lines[0]).toBe('notes');
  });

  it('does not quote plain values', () => {
    const csv = leadsToCsv([{ email: 'plain@example.com' }], { fields: ['email'] });
    expect(csv.split('\r\n')[1]).toBe('plain@example.com');
  });

  it('renders null/undefined cells as empty, keeps numeric 0', () => {
    const csv = leadsToCsv([{ name: null, score: 0, phone: undefined }], { fields: ['name', 'score', 'phone'] });
    expect(csv.split('\r\n')[1]).toBe(',0,');
  });

  it('uses stable default column order and labels', () => {
    expect(CSV_DEFAULT_FIELDS).toEqual(['ts', 'name', 'email', 'phone', 'service', 'score', 'channel', 'source']);
    const csv = leadsToCsv([]);
    expect(csv).toBe('Date,Name,Email,Phone,Service,Score,Channel,Source');
  });

  it('honours a custom fields array (subset + order) with raw-name fallback labels', () => {
    const csv = leadsToCsv([{ email: 'a@b.com', name: 'Al', extra: 'z' }], { fields: ['email', 'name', 'extra'] });
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Email,Name,extra'); // 'extra' has no label -> raw name
    expect(lines[1]).toBe('a@b.com,Al,z');
  });

  it('ignores empty/invalid fields arg and uses defaults', () => {
    expect(leadsToCsv([], { fields: [] })).toBe('Date,Name,Email,Phone,Service,Score,Channel,Source');
    expect(leadsToCsv([], { fields: 'nope' })).toBe('Date,Name,Email,Phone,Service,Score,Channel,Source');
  });

  it('emits exactly one record line per input row plus a header', () => {
    // Plain (un-quoted, newline-free) values so record boundaries == \r\n.
    // A regression that dropped, duplicated, or merged rows fails here.
    const rows = [
      { name: 'A', email: 'a@x' },
      { name: 'B', email: 'b@x' },
      { name: 'C', email: 'c@x' },
    ];
    const csv = leadsToCsv(rows, { fields: ['name', 'email'] });
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(4); // 1 header + 3 data
    expect(lines.slice(1)).toEqual(['A,a@x', 'B,b@x', 'C,c@x']);
  });

  it('round-trips end-to-end: filter then CSV with worst-case values', () => {
    const rows = [
      webRow({ name: 'Smith, "Bob"', service_wanted: 'Roof\nrepair', qualification_score: 90 }),
      channelRow({ senderName: 'Eve', category: 'sales, urgent' }),
    ];
    const normalized = filterOwnerLeads(rows, { ownerEmail: 'owner@biz.co.uk', slug: 'jord-window-cleaning' });
    const csv = leadsToCsv(normalized);
    expect(csv.startsWith('Date,Name,Email,Phone,Service,Score,Channel,Source\r\n')).toBe(true);
    expect(csv).toContain('"Smith, ""Bob"""');
    expect(csv).toContain('"Roof\nrepair"');
    expect(csv).toContain('"sales, urgent"');
    expect(csv).toContain(',website,web');
    expect(csv).toContain(',instagram,channel');
  });
});
