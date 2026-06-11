# Aria Dashboard Redesign + Bot Upgrade — Build Contract

Goal (Kyle): "Full redesign… modern, professional, slick, easy to use, easy to understand —
then improve the functionality of Aria, the bot itself."

Reference docs (read before building):
- `_build/MAP-dashboardUI.md` — exhaustive manifest of the CURRENT dashboard (feature-parity contract: nothing may be lost)
- `_build/MAP-apiContract.md` — every `/api/dashboard/*` route + auth flow (the new frontend builds against this; do not re-read server.js for shapes)
- `_build/MAP-botCapabilities.md` — bot capability map + ranked improvements

---

## Part 1 — New dashboard app (static, extracted from server.js)

### Architecture
- New files ONLY under `public/dashboard/`: `index.html`, `login.html`, `styles.css`, `app.js`, `panels.js`, `icons.js`. **No build step, no framework, no CDN dependencies** (self-host everything; Geist via system fallback stack `"Geist", -apple-system, "SF Pro Text", Inter, sans-serif` — load Geist from `/dashboard/assets/` if present, else fallback silently).
- Auth model unchanged: app reads `owner` + `s` from `location.search`; every fetch appends them (same `Q` pattern). Server-side gates stay in server.js (NOT edited in this part — a later phase swaps the route to `res.sendFile`).
- `login.html` replicates the login flow: POST `/api/dashboard/login`, redirect with `&s=<token>` on success, forgot-password link (POST `/api/dashboard/forgot-password`).

### Design system — "institutional dark" (tokens at top of styles.css)
```css
--bg:#0A0A12; --surface:#10101C; --surface-2:#161624; --surface-3:#1D1D2E;
--border:rgba(255,255,255,.07); --border-strong:rgba(255,255,255,.12);
--text:#EDEDF4; --text-2:#9C9CB4; --text-3:#62627A;
--accent:#00E5A0; --accent-dim:rgba(0,229,160,.12);
--amber:#FFB454; --red:#FF6B6B; --blue:#6E9BFF;
--fs-h1:22px; --fs-h2:16px; --fs-h3:13px; --fs-body:13.5px; --fs-small:12px; --fs-micro:11px;
--space: 4px grid (4/8/12/16/20/24/32/48);
--radius-sm:8px; --radius-md:12px; --radius-lg:16px;
--shadow-md:0 4px 24px rgba(0,0,0,.35), 0 1px 2px rgba(0,0,0,.4);
```
Rules (hard):
- **NO emoji anywhere in chrome** (nav, buttons, panel titles, empty states). All icons = inline SVG, 1.5px stroke, 18px, `currentColor` (Lucide-style: home, message-circle, target, users, calendar, brain/sparkles, link, building, settings, search, x, check, chevron…). Put them in `icons.js` as a `icon(name, size)` helper. Emoji MAY remain inside user content (messages) only.
- Headings: tracking `-0.02em`, weight 600-650. Numbers in stats: `font-variant-numeric: tabular-nums`.
- Animate ONLY transform/opacity, 0.18–0.28s, ease-out springs. No `transition-all`. No confetti — ever.
- Every interactive element: hover, focus-visible (2px accent outline offset 2px), active states.
- Surface layering: page → card (surface, border) → elevated (surface-2, shadow-md) → floating (surface-3, modal/palette).
- Empty states: SVG icon + one-line title + one-line sub + single CTA. No paragraphs.
- Density: 13.5px body, 36px table rows, 16-20px card padding. This is a pro tool, not a marketing page.

### Layout
- Topbar 52px, blurred glass (`backdrop-filter`), logo "Aria" + accent "Ai", right: owner email chip (hidden mobile), ⌘K button, Logout.
- Sidebar 220px fixed; sections "Overview" (Home, Conversations, Leads, Customers, Bookings) + "Manage" (Train Aria, Channels, Business, Settings). Active item: accent left-rail (2px) + accent-dim bg. ≤900px: sidebar becomes slide-over with hamburger; ≤700px: bottom tab bar with 5 primary items + "More" sheet.
- URL hash routing (`#/leads`) replacing `localStorage.aria_panel` (keep reading the old key once for migration). Browser back/forward works.

### Feature parity + upgrades per panel (manifest is the contract; these are the deltas)
1. **Home → "Today"**: keep escalations banner, hero status, channel strip, activity feed, stat cards — redesigned. ADD value header: "This week: N replies · N leads · N bookings" with a **30-day sparkline** (inline SVG, data from `/api/dashboard/analytics`) and an estimated-value line when leads have `estimatedValue` (else hide). Fix the "This week — Failed to load" bug: that card must degrade gracefully (hide section + log) when analytics 404s/empty.
2. **Conversations**: channel filter chips (All/WhatsApp/Messenger/Instagram/Email/Web), unified list with channel icon, unread/handoff badges, thread modal → slide-over drawer (right, 480px) instead of center modal; Resume-conversation action kept.
3. **Leads**: score-banded rows (hot ≥70 accent, warm 40-69 amber, cold dim), CSV export kept, search + status filter, lead drawer with full detail + conversation link.
4. **Customers**: keep LTV/repeat data, searchable table, customer drawer.
5. **Bookings**: list + **week strip view** (7 columns, today highlighted), ICS download kept, cancel/reschedule actions kept.
6. **Train Aria**: KB docs CRUD, FAQ bootstrap flow, gap-to-kb ("Aria couldn't answer these — teach her" cards with one-click add), AI-improve/ai-train actions, **test sandbox chat box** kept.
7. **Channels**: connect/disconnect/toggle per channel (Meta/IG/WA/Email/Phone), status pills, phone provisioning UI kept. FIX: manifest §6.2 — `loadSection` has no `channels` branch (panel never loads on direct nav). New router must load every panel.
8. **Business (profile)**: business info form, hours editor, webhooks list (add/delete), notification settings.
9. **Settings**: password change, digest/notification prefs, reviews settings, danger zone (complete-reset, double-confirm typed phrase).
10. **Global**: ⌘K palette (fuzzy match this time, recent-first), toasts (top-right stack, max 3), tutorial rebuilt as a dismissible 4-step coach-marks overlay (no modal hijack; skippable instantly; same localStorage key).

### Known bugs to fix in the rebuild
- §6.1 escaped-`${}` render bug in old template (verify whatever string it produced doesn't recur).
- §6.2 missing `channels` branch in `loadSection`.
- Logout: also call new `POST /api/dashboard/logout` (added in Part 2) then redirect.
- Analytics card hard-fails → graceful degrade.

### Quality bar
Lighthouse a11y ≥95 on /dashboard (labels, roles, contrast ≥4.5:1, focus order). First paint of shell <1s local. Every fetch has skeleton → content/empty/error triple state. It should read like Linear/Stripe internal tooling, not a template.

---

## Part 2 — Server swap (after Part 1 files exist)
In `server.js`:
1. Replace the inline login page + dashboard template (lines ~11760–14465) with auth-gated `res.sendFile` of `public/dashboard/login.html` / `index.html`. Keep ALL gate logic (password → /connect/gmail redirect, onboarding redirect, validateSession) byte-for-byte equivalent.
2. `app.use('/dashboard/assets', express.static('public/dashboard'))` for css/js/icons (no auth on assets).
3. Add `POST /api/dashboard/logout` — deletes the session token server-side.
4. Delete the now-dead template code; server.js should shrink by ~2,700 lines. Run `npm test` after.

## Part 3 — Bot upgrades wave 1 (server.js + lib/, no public/ edits)
Work orders from `MAP-botCapabilities.md` §D (full details there):
- **W1 Missed-call-text-back** (§D2): on Vapi end-of-call with missed/declined/short-abandon `endedReason`, schedule WA text via existing `outbound_scheduler` task. New task type `missed_call_followup`. Respect business hours (`business_hours.js`) + one-per-contact-per-24h dedupe.
- **W2 Real calendar booking confirm** (§D3): `book_calendar_slot` approval path calls existing `createCalendarEvent` + writes `bookings[]` ledger; availability check includes owner's Google Calendar via `/api/calendar/availability` logic.
- **W3 Quote follow-up** (§D7): scheduler task `quote_followup` at T+48h after quote sent, skip if lead replied/booked since.
- **W4 KB → widget** (§D8): widget/server prompt path injects owner knowledge docs + approved learning-loop FAQs via `rag_retriever` (same as channels); router `lookup_faq` reads server `faqs` map + knowledge docs, not just `data-canned`.
- **W5 Review-request parity** (§D9): `/api/booking` (widget form bookings) schedules `review_request` same as channel bookings.
- **W6 Language** (§D10): channel "reply in visitor's language" rule added to widget prompt; Vapi transcriber language auto (config flag per owner, default en).
Each: surgical, match existing patterns (append-only ledgers, two-stage approval where external send). Add/extend vitest tests where the touched logic already has coverage (lead_policy, outbound_scheduler). `npm test` must pass.

## Part 4 — Bot upgrades wave 2 (after Parts 2-3 merged)
- **W7 Router brain default** (§D1): flip widget default endpoint to `/api/chat/router/stream`, port `::ACTION` rich behaviors into real tools, keep abort-safety + usage tracking from `lead_router_stream.js`. Legacy path stays available via `data-endpoint` opt-out.
- **W8 Widget photo→quote** (§D5): widget image upload routes into the router conversation (vision → quoteDraft pipeline like channels).

## Out of scope (flag to Kyle, do NOT build)
- SMS channel (Twilio cost decision), Stripe payment links / deposits (real-money, needs explicit approval), voice multi-language personas.
