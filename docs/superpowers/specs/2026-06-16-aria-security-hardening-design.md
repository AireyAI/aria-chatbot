# Aria Chatbot — Security & GDPR Hardening (design)

- **Date:** 2026-06-16
- **Repo:** `/Users/kyleairey/chatbot` (`AireyAI/aria-chatbot`, Railway, `main`)
- **Status:** Phase 0 designed & approved. Phases 1–5 are a sequenced backlog (specced when reached).
- **Live clients at risk:** How High Scaffolding, Dolled by Louise, EJ Roofing (`data/owners.json`).

## Why

The 2026-06-10 product review flagged a security/GDPR risk register. A code recon
(2026-06-16) found **most of it already fixed** — `.env` is gitignored and never
committed, webhooks are HMAC-signed (`lib/webhook_dispatcher.js:17`), GDPR SAR
export/erase endpoints exist (`server.js:15223`), the consent gate exists
(`chatbot.js:3294`), admin auth is timing-safe (`server.js:167`), `/health`
exists (`15918`), onboarding SSRF guards are wired. This spec covers what is
**actually still open**, verified against current code.

## Still-open items (verified) and phase roadmap

Each phase is independently shippable, verifiable, and revertible. Effort:
S=<1hr, M=hours, L=day+.

| # | Phase | Closes | Effort | Status |
|---|---|---|---|---|
| **0** | Stop-the-bleeding: remove `?pass=` master-password exposure; make domain allowlist enforce | admin-pass in logs/history; casual browser embed-theft | M | **This sub-project** |
| 1 | CORS split: kill global `origin:true`+`credentials:true`; admin strict-with-creds, widget reflect-without-creds | cross-origin credential exposure | M | backlog |
| 2 | Per-client isolation: per-embed token on `/api/chat`, per-owner metering + caps | $ drain via open proxy; one client browning out all (**only Critical**) | M–L | backlog |
| 3 | Encrypt OAuth tokens at rest (AES-256-GCM, key in Railway env) | token theft if `data/` exfiltrated | M | backlog |
| 4 | Re-enable GDPR purge safely (confirm crash cause, make non-blocking, dry-run gate) | retention breach | M | backlog |
| 5 | Observability: pino structured logs + request IDs; arm dormant heartbeat email sweep | silent failures invisible | M | backlog |

Phase 2 note: the open-proxy abuse (`curl /api/chat` with a spoofed `Origin` +
arbitrary `system` prompt = free Claude on the shared key) is a *browser-bypass*
problem and is **not** closed by Phase 0's allowlist (origin headers are
spoofable off-browser). Phase 2's per-embed token is the real fix.

---

## Phase 0 — detailed design

Two independent workstreams, shipped as two separate commits/deploys.

### 0A — Kill the master-password exposure

**Problem.** `/admin` serves the dashboard only to an authenticated admin
(`server.js:9095`, `if (!adminAuth(req)) return <login page>`), but the served
dashboard embeds the master password directly: `const PASS = ADMIN` (`9199`) →
interpolated into client JS as `const PASS = '<password>'` (`9668`) → sent on
~25 dashboard fetches as `?pass=<password>` (`9672`–`10224`). Result: the master
admin password lands in **Railway access logs, browser history, and Referer**.
Not public (gated by `adminAuth`), but a real secret-in-logs leak. `adminAuth()`
also still accepts `?pass=` as auth fallback #3 (`8026`–`8027`).

**Change.**
1. **Server** — remove the `?pass=` branch in `adminAuth()` (`8026`–`8027`).
   Auth becomes cookie (`_hasValidAdminCookie`, `158`) OR `X-Admin-Pass` header
   (`8024`) only. Magic-link login (`/admin/request-magic-link` → `/admin/login`
   sets the HttpOnly `aria_admin_session` cookie, `9007`) is unaffected.
2. **Dashboard frontend** — delete `const PASS = ADMIN` (`9199`) and the client
   line `const PASS = '${PASS}'` (`9668`); strip `?pass='+PASS` (and `?pass='+PASS+'&`)
   from every fetch in the `9672`–`10224` block. Same-origin fetches send the
   HttpOnly cookie automatically (`credentials:'same-origin'` default), so they
   stay authenticated. The master password is no longer present in the browser.
3. **Ops/scripts/docs** — migrate `curl '/admin/...?pass=$ARIA_ADMIN_PASS'` to
   `-H "X-Admin-Pass: $ARIA_ADMIN_PASS"`. Update
   `~/.claude/projects/-Users-kyleairey/memory/reference_aria_chatbot_setup.md`
   (Domain Allowlist snippet) and audit `~/jarvis/agents/scripts/clients/aria_*.py`
   for any `?pass=` callers; migrate them to the header.

**Verify.** Log into the dashboard; exercise every tab (data, faq, domains,
usage, settings, invites, dropship, leads, handoffs); confirm all 200 and **zero
`?pass=` in any request URL** (DevTools network panel). Confirm `X-Admin-Pass`
curl still authenticates `/admin/domains`.

**Risk.** Med — a missed fetch 403s that tab. Mitigation: exhaustive find/replace
in the `9672`–`10224` block + full click-through before the Railway push. The
`X-Admin-Pass` header path is retained as the scripts' auth, so server-side ops
never depend on `?pass=`.

**Rollback.** Single revert of the commit; `?pass=` branch returns.

### 0B — Make the domain allowlist enforce

**Problem.** `isDomainAllowed()` (`1933`–`1961`) **always returns `true`** — a
non-matching origin is only logged (`1959`–`1960`), and an empty allowlist
returns `true` (`1950`). The allowlist is currently advisory, not a boundary.
`data/allowed-domains.json` does not exist → the set is empty at boot.

**Change.**
1. Add a flag `ENFORCE_DOMAIN_ALLOWLIST` (default **off**) read at startup.
2. When **on**: a browser origin (origin/referer present) that is neither
   first-party (`FIRST_PARTY_DOMAINS`, `1927`) nor in `allowedDomains` →
   **return `false`** (the `/api/chat` middleware at `293`–`296` already turns a
   `false` into `403 Unauthorized domain`). Keep returning `true` for: no-origin
   (server-to-server), first-party, and exact/subdomain matches.
3. **Decision (locked):** seed `allowedDomains` from an `ALLOWED_DOMAINS` env var
   (comma-separated) **and** `data/allowed-domains.json`, mirroring the
   `OWNERS_JSON` env-seed pattern (`185`) so the set survives Railway's ephemeral
   volume. With a seed always present, behave **fail-closed** when on (empty set
   is treated as misconfig, not allow-all). The flag is the safety valve.

**Two-stage rollout (mandatory — touches live clients).**
- **Stage A (prepare):** obtain the 3 clients' real widget origins from **Railway
  logs** — the `[domain] serving widget for non-allowlisted origin:` warnings
  (`1959`) and actual `/api/chat` `Origin` headers are ground truth (they may be
  `aireyai.github.io/<slug>` subpaths, already first-party, or custom domains).
  Confirm the list with Kyle. Seed `ALLOWED_DOMAINS` + file. Deploy with the flag
  still **off**.
- **Stage B (verify):** with the flag off, confirm in logs that every live origin
  *would* match (no would-be-403s for real clients). A scripted check hits
  `/api/chat` with each live `Origin` and an `OPTIONS`/probe expecting a match.
- **Stage C (flip):** set `ENFORCE_DOMAIN_ALLOWLIST=true`. Re-verify: each live
  origin → 200; an arbitrary other origin → 403; first-party → 200. If any live
  client breaks, flip the flag off (no redeploy needed).

**Caveat (carried).** Origin/referer is a browser-only signal; `curl` with a
spoofed or absent `Origin` still bypasses (`1936` allows no-origin). Off-browser
proxy abuse is closed in **Phase 2**, not here.

**Risk.** Med — a missing/wrong domain 403s a live client. Killed by the
log-audit (Stage A) + per-origin 200 check (Stage C) + instant flag-off rollback.

---

## What needs Kyle (human-in-the-loop)

1. **Confirm the 3 live clients' widget domains** once derived from Railway logs
   (Stage A) — before seeding.
2. **Approve the flag flip to `true`** (Stage C) — the only irreversible-ish,
   client-facing moment. Two-stage per engineering rule #12.

Everything else (code, find/replace, docs, verification scripts) is Claude's call.

## Out of scope (this spec)

Phases 1–5 above. Each gets its own spec when reached. No CORS changes, no
per-client tokens, no token encryption, no GDPR-purge re-enable, no logging
overhaul in Phase 0.

## Success criteria

- Master admin password appears in **no** served HTML, request URL, or access log
  (0A). Dashboard fully functional via cookie; scripts via `X-Admin-Pass`.
- With `ENFORCE_DOMAIN_ALLOWLIST=true` and the seed in place: all 3 live client
  origins serve (200); a non-allowlisted browser origin is denied (403);
  first-party always serves; flag-off restores allow-all instantly (0B).
- Two clean, independently-revertible commits. No regression in the existing
  vitest suite (note: `tests/server.test.js` has an uncommitted sandboxed
  integration rewrite in the working tree — reconcile before/with these changes).
