import { describe, it, expect } from 'vitest';

const BASE = 'http://localhost:3003';

// ── Health & Basic Routes ────────────────────────────────────────────

describe('Health & Basic Routes', () => {
  it('GET /health returns 200 with status ok', async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('GET / returns HTML containing "Aria"', async () => {
    const res = await fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Aria');
  });

  it('GET /chatbot.js serves the widget script', async () => {
    const res = await fetch(`${BASE}/chatbot.js`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  });
});

// ── Admin API ────────────────────────────────────────────────────────

describe('Admin API', () => {
  it('GET /admin without password shows login', async () => {
    const res = await fetch(`${BASE}/admin`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toMatch(/login|password/);
  });

  it('GET /admin with correct password shows admin dashboard', async () => {
    const res = await fetch(`${BASE}/admin?pass=aria-admin`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toMatch(/dashboard|admin/);
  });
});

// ── Chat API ─────────────────────────────────────────────────────────

describe('Chat API', { timeout: 15000 }, () => {
  it('POST /api/chat returns a Claude response', async () => {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Say hi in one word',
        max_tokens: 50,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply || body.response || body.message).toBeTruthy();
  });

  it('POST /api/session creates a session with an ID', async () => {
    const res = await fetch(`${BASE}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId || body.id || body.session_id).toBeTruthy();
  });
});

// ── Invite System ────────────────────────────────────────────────────

describe('Invite System', () => {
  let inviteToken;

  it('POST /api/admin/invite creates an invite with token and link', async () => {
    const res = await fetch(`${BASE}/api/admin/invite?pass=aria-admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeTruthy();
    expect(body.link).toBeTruthy();
    inviteToken = body.token;
  });

  it('GET /api/admin/invites lists invites', async () => {
    const res = await fetch(`${BASE}/api/admin/invites?pass=aria-admin`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('GET /onboard with valid token shows wizard', async () => {
    // Ensure we have a token from the previous test
    expect(inviteToken).toBeTruthy();
    const res = await fetch(`${BASE}/onboard?token=${inviteToken}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toMatch(/onboard|wizard|setup|welcome/);
  });

  it('GET /onboard with invalid token shows error', async () => {
    const res = await fetch(`${BASE}/onboard?token=invalid-fake-token`);
    const html = await res.text();
    expect(html.toLowerCase()).toMatch(/invalid|expired|error|not found/);
  });

  it('DELETE /api/admin/invite removes it', async () => {
    expect(inviteToken).toBeTruthy();
    const res = await fetch(`${BASE}/api/admin/invite?pass=aria-admin`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: inviteToken }),
    });
    expect(res.status).toBe(200);
  });
});

// ── Dashboard Auth ───────────────────────────────────────────────────

describe('Dashboard Auth', () => {
  const uniqueEmail = `dashtest-${Date.now()}@example.com`;
  const testPassword = 'TestPass123!';
  let authToken;

  it('POST /api/dashboard/set-password creates a password and returns token', async () => {
    const res = await fetch(`${BASE}/api/dashboard/set-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: uniqueEmail, password: testPassword }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeTruthy();
    authToken = body.token;
  });

  it('POST /api/dashboard/login with correct password succeeds', async () => {
    const res = await fetch(`${BASE}/api/dashboard/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: uniqueEmail, password: testPassword }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeTruthy();
  });

  it('POST /api/dashboard/login with wrong password returns 401', async () => {
    const res = await fetch(`${BASE}/api/dashboard/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: uniqueEmail, password: 'wrong-password' }),
    });
    expect(res.status).toBe(401);
  });
});

// ── Website Scanner ──────────────────────────────────────────────────

describe('Website Scanner', () => {
  it('POST /api/scan-website with no URL returns 400', async () => {
    const res = await fetch(`${BASE}/api/scan-website`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ── Email Auto-Reply ─────────────────────────────────────────────────

describe('Email Auto-Reply', () => {
  it('GET /api/email-autoreply/status returns a status object', async () => {
    const res = await fetch(`${BASE}/api/email-autoreply/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe('object');
  });
});
