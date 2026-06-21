// Integration suite for the live HTTP API in server.js.
//
// Unlike the pure-unit suites (lead_router, lead_policy, bot_upgrades), this
// one needs a running server. It boots its OWN copy of server.js in a
// SANDBOXED temp working directory so it never touches the real ./data dir
// (which holds live Gmail tokens, owner sessions, etc.). All data-file paths
// in server.js are `path.resolve('data/...')` — i.e. cwd-relative — so running
// the child with cwd=<tempdir> redirects every read/write into throwaway
// storage. Static assets (chatbot.js, public/) are symlinked in so the
// express.static('.') routes still resolve; only `data/` is a fresh empty dir.
//
// Secrets are NOT inherited: .env is not symlinked, and we inject fake
// ADMIN_PASS / ANTHROPIC_API_KEY so the server boots without real credentials
// and never makes an outbound Anthropic/Gmail call. Tests therefore stick to
// deterministic routes (validation, auth, HTML pages) and avoid happy-path
// chat/scan endpoints that would hit external APIs.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import os from 'node:os';
import {
  mkdtempSync, mkdirSync, readdirSync, symlinkSync, rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SERVER_JS = join(REPO_ROOT, 'server.js');

// Known fakes injected into the child — referenced by the auth tests.
const ADMIN_PASS = 'test-admin-pass-1234';

let BASE;          // e.g. http://localhost:3517
let child;         // the spawned server process
let sandboxDir;    // temp cwd for the child
let serverLog = '';

// Grab a free TCP port by binding to 0 and reading the assigned port back.
function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

// Build a sandbox cwd: symlink every repo-root entry EXCEPT the ones that
// would leak secrets / live state, then drop a fresh empty data/ dir in.
function buildSandbox() {
  const dir = mkdtempSync(join(os.tmpdir(), 'aria-server-test-'));
  const skip = new Set(['data', '.env', 'node_modules', '.git']);
  for (const name of readdirSync(REPO_ROOT)) {
    if (skip.has(name)) continue;
    symlinkSync(join(REPO_ROOT, name), join(dir, name));
  }
  mkdirSync(join(dir, 'data'), { recursive: true });
  return dir;
}

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (code ${child.exitCode}):\n${serverLog}`);
    }
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms:\n${serverLog}`);
}

beforeAll(async () => {
  const port = await freePort();
  BASE = `http://localhost:${port}`;
  sandboxDir = buildSandbox();

  child = spawn('node', [SERVER_JS], {
    cwd: sandboxDir,
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_PASS,
      // Non-empty so `new Anthropic({apiKey})` constructs; we never exercise a
      // real chat completion, so the value is irrelevant beyond being truthy.
      ANTHROPIC_API_KEY: 'sk-ant-test-not-real',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => { serverLog += d; });
  child.stderr.on('data', d => { serverLog += d; });

  await waitForHealth();
}, 30000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    await new Promise(res => {
      child.once('exit', res);
      child.kill('SIGTERM');
      setTimeout(() => { child.kill('SIGKILL'); res(); }, 3000).unref?.();
    });
  }
  if (sandboxDir) rmSync(sandboxDir, { recursive: true, force: true });
});

// ── small request helpers ──────────────────────────────────────────────────

async function api(path, { method = 'GET', body, headers } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}
// Admin auth travels in the X-Admin-Pass header. The ?pass= query fallback was
// removed 2026-06-16 (it leaked the master password into logs + browser history).
const ADMIN_HDR = { 'x-admin-pass': ADMIN_PASS };
const adminApi = (path, opts = {}) => api(path, { ...opts, headers: { ...ADMIN_HDR, ...(opts.headers || {}) } });

// ── Health & static assets ──────────────────────────────────────────────────

describe('Health & static', () => {
  it('GET /health returns the live status object', async () => {
    const res = await api('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    // Current shape exposes live counters, not just {status}.
    expect(body).toHaveProperty('sessions');
    expect(body).toHaveProperty('faqs');
    expect(body).toHaveProperty('handoffs');
  });

  it('GET /chatbot.js serves the widget script', async () => {
    const res = await api('/chatbot.js');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(500);
  });
});

// ── Admin dashboard (X-Admin-Pass header auth; ?pass= removed 2026-06-16) ────

describe('Admin dashboard', () => {
  it('GET /admin without credentials serves the sign-in page', async () => {
    const res = await api('/admin');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Aria Admin');
    // The authed dashboard is "Aria Admin v5"; the gate page is not.
    expect(html).not.toContain('Aria Admin v5');
  });

  it('GET /admin with the X-Admin-Pass header serves the full dashboard', async () => {
    const res = await adminApi('/admin');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Aria Admin v5');
    // Regression guard: the master password must never be embedded in the page.
    expect(html).not.toContain(ADMIN_PASS);
  });

  it('GET /admin?pass=<correct> no longer authenticates (?pass= removed)', async () => {
    const res = await api(`/admin?pass=${ADMIN_PASS}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('Aria Admin v5');
  });

  it('GET /admin?pass=wrong stays on the sign-in page', async () => {
    const res = await api('/admin?pass=definitely-wrong');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('Aria Admin v5');
  });
});

// ── Chat & session API (validation only — no Claude call) ────────────────────

describe('Chat & session API', () => {
  it('POST /api/chat rejects a body without a messages array', async () => {
    // Current contract is { messages: [...] }; the old { message: "..." } shape
    // has no `messages` array, so it short-circuits to 400 before any API call.
    const res = await api('/api/chat', { method: 'POST', body: { message: 'hi' } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid messages');
  });

  it('POST /api/session requires a sessionId', async () => {
    const res = await api('/api/session', { method: 'POST', body: {} });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('No sessionId');
  });

  it('POST /api/session with a sessionId persists and returns { ok: true }', async () => {
    const res = await api('/api/session', {
      method: 'POST',
      body: { sessionId: `test-${Date.now()}`, page: '/pricing' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

// ── Invite system (admin via X-Admin-Pass header; token in URL path on DELETE) ─

describe('Invite system', () => {
  let token;

  it('POST /api/admin/invite without credentials returns 403', async () => {
    const res = await api('/api/admin/invite', {
      method: 'POST', body: { email: 'nope@example.com' },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Unauthorised');
  });

  it('POST /api/admin/invite without an email returns 400', async () => {
    const res = await adminApi('/api/admin/invite', { method: 'POST', body: {} });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('email is required');
  });

  it('POST /api/admin/invite creates an invite with token + onboard link', async () => {
    const res = await adminApi('/api/admin/invite', {
      method: 'POST', body: { email: 'invitee@example.com' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.token).toBeTruthy();
    expect(body.link).toContain(`/onboard?t=${body.token}`);
    token = body.token;
  });

  it('GET /api/admin/invites lists the created invite', async () => {
    const res = await adminApi('/api/admin/invites');
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.some(inv => inv.token === token)).toBe(true);
  });

  it('GET /onboard?t=<token> serves the setup wizard for a valid invite', async () => {
    expect(token).toBeTruthy();
    const res = await api(`/onboard?t=${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Aria Setup');
  });

  it('GET /onboard with no token shows an invalid-link page', async () => {
    const res = await api('/onboard');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Invalid Link');
  });

  it('GET /onboard with a bogus token shows an invalid-link page', async () => {
    const res = await api('/onboard?t=not-a-real-token');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Invalid Link');
  });

  it('DELETE /api/admin/invite/:token removes it (token in the path)', async () => {
    expect(token).toBeTruthy();
    const res = await adminApi(`/api/admin/invite/${token}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    const after = await (await adminApi('/api/admin/invites')).json();
    expect(after.some(inv => inv.token === token)).toBe(false);
  });

  it('DELETE /api/admin/invite/:token returns 404 for an unknown token', async () => {
    const res = await adminApi('/api/admin/invite/ghost-token', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Invite not found');
  });
});

// ── Dashboard owner auth (System A: owner + password → session token) ────────

describe('Dashboard owner auth', () => {
  const owner = `owner-${Date.now()}@example.com`;
  const password = 'CorrectHorse9!';
  let sessionToken;

  it('POST /api/dashboard/set-password rejects a short password', async () => {
    const res = await api('/api/dashboard/set-password', {
      method: 'POST', body: { owner: `short-${Date.now()}@example.com`, password: 'abc' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at least 8/i);
  });

  it('POST /api/dashboard/set-password creates a password and returns a token', async () => {
    const res = await api('/api/dashboard/set-password', {
      method: 'POST', body: { owner, password },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.token).toBeTruthy();
  });

  it('POST /api/dashboard/set-password twice for the same owner returns 400', async () => {
    const res = await api('/api/dashboard/set-password', {
      method: 'POST', body: { owner, password },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already set/i);
  });

  it('POST /api/dashboard/login with the correct password returns a token', async () => {
    const res = await api('/api/dashboard/login', {
      method: 'POST', body: { owner, password },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.token).toBeTruthy();
    sessionToken = body.token;
  });

  it('POST /api/dashboard/login with a wrong password returns 401', async () => {
    const res = await api('/api/dashboard/login', {
      method: 'POST', body: { owner, password: 'wrong-password' },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Wrong password');
  });

  it('POST /api/dashboard/login for an unknown owner returns 400', async () => {
    const res = await api('/api/dashboard/login', {
      method: 'POST', body: { owner: 'ghost@example.com', password },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('No password set');
  });

  it('GET /api/dashboard/stats requires a valid session', async () => {
    const res = await api('/api/dashboard/stats');
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Not authenticated');
  });

  it('GET /api/dashboard/stats returns the stats shape with owner + token', async () => {
    expect(sessionToken).toBeTruthy();
    const res = await api(`/api/dashboard/stats?owner=${encodeURIComponent(owner)}&s=${sessionToken}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('emailsReplied');
    expect(body).toHaveProperty('bookings');
    expect(body).toHaveProperty('leads');
    expect(body).toHaveProperty('gmailConnected');
  });
});

// ── Website scanner (validation only — no outbound fetch) ────────────────────

describe('Website scanner', () => {
  it('POST /api/scan-website without a url returns 400', async () => {
    const res = await api('/api/scan-website', { method: 'POST', body: {} });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('url is required');
  });
});

// ── Email auto-reply status (admin-gated) ────────────────────────────────────

describe('Email auto-reply status', () => {
  it('GET /api/email-autoreply/status without credentials returns 403', async () => {
    const res = await api('/api/email-autoreply/status');
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Unauthorised');
  });

  it('GET /api/email-autoreply/status returns a status object for admin', async () => {
    const res = await adminApi('/api/email-autoreply/status?owner=owner@example.com');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.owner).toBe('owner@example.com');
    expect(body.enabled).toBe(false);
    expect(typeof body.config).toBe('object');
    expect(typeof body.stats).toBe('object');
  });
});
