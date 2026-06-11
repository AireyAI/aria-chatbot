# Aria Dashboard API Contract
**Source:** `/Users/kyleairey/chatbot/server.js` (17,747 lines, audited 2026-06-11)

---

## 1. Authentication

### 1.1 Two distinct auth systems exist under `/api/dashboard/*`

| System | Used by | Credential | Transport |
|---|---|---|---|
| **A. Owner session auth** (`requireDashboardAuth`, line 10232) | Every route below unless noted | 64-char hex session token | Query `?s=<token>` OR header `x-session-token`, PLUS `owner` (query param or body field) |
| **B. Slug admin-token auth** (`verifyAdminToken`, line 216) | `GET /api/dashboard/analytics` (line 6416) and `GET /api/dashboard/sessions` (line 6738) ONLY | HMAC-signed stateless token issued after Google OAuth | Header `X-Aria-Token`, plus `?slug=` query param |

**System A — `requireDashboardAuth(req, res)` (line 10232):**
```js
const owner = req.query.owner || req.body?.owner;
const token = req.query.s || req.headers['x-session-token'];
if (!owner || !token || !validateSession(token, owner)) → 401 { "error": "Not authenticated" }
```
Every System-A endpoint therefore needs `owner` + token on EVERY call. Failure is always `401 {"error":"Not authenticated"}`.

**`validateSession(token, ownerEmail)` (line 986):** looks up token in `dashboardSessions` Map (`token → { ownerEmail, expiresAt }`); rejects if missing, expired, or `ownerEmail` mismatch. Expired sessions are deleted on touch.

**Sessions:** created by `createSession(ownerEmail)` (line 979) — `crypto.randomBytes(32).toString('hex')` (256-bit), **7-day expiry**, persisted to `data/dashboard-sessions.json`. There is no logout endpoint and no session-refresh endpoint; tokens simply expire.

**System B — `verifyAdminToken(token, slugExpected)` (line 216):** token format `email~expiry~slug~sig` where `sig = HMAC-SHA256(ADMIN_PASS, "email~expiry~slug")` base64url. Stateless. Verified constant-time; also requires `isOwner(slug, email)` against `data/owners.json` / `OWNERS_JSON` env. Issued by the `/auth/admin/start` Google OAuth flow (token returned in URL hash `#aria_token=`; the existing page stores it in `sessionStorage`).

### 1.2 Password storage
- File: `data/dashboard-passwords.json` (Map `ownerEmail → hash`, JSON object on disk).
- **Current format:** scrypt — `s2$<salt hex 32 chars>$<hash hex 128 chars>`, params `N=16384, r=8, p=1, maxmem=64MB`, 16-byte random salt, 64-byte key (`scryptHash`, line 944).
- **Legacy format:** `h_<base36>` from a trivial 32-bit `simpleHash` (line 931). Still verifiable; **re-hashed to scrypt automatically on first successful login** (`verify.needsRehash` path in `/login`).
- Comparison is `crypto.timingSafeEqual`.

### 1.3 Auth endpoints (all System-A issuers; no auth required to call)

#### POST `/api/dashboard/login` (line 2951)
- Body (JSON): `{ owner: string, password: string }`
- 400 `{error:'owner and password required'}` | 400 `{error:'No password set'}` | 401 `{error:'Wrong password'}`
- 200: `{ ok: true, token: string }` ← session token, use as `s`/`x-session-token`

#### POST `/api/dashboard/set-password` (line 2939) — first-time setup only
- Body: `{ owner, password }` (min 8 chars)
- 400 if password already set (`'Password already set. Use reset if needed.'`)
- 200: `{ ok: true, token }`

#### POST `/api/dashboard/forgot-password` (line 2825)
- Body: `{ owner }`
- 400 `{error:'owner required'}` | 400 `{error:'No account found for this email'}` (NB: account enumeration is possible)
- Generates 30-min single-use token, emails link to `/dashboard/reset-password?token=&owner=`
- 200: `{ ok: true, message: 'Reset link sent to your email' }` | 500 `{error:'Failed to send reset email. Contact support.'}`

#### POST `/api/dashboard/complete-reset` (line 2924) — consumes emailed token
- Body: `{ token, owner, password }` (min 8 chars)
- 400 `{error:'Invalid or expired reset link'}`
- 200: `{ ok: true, sessionToken }` ← note field name is `sessionToken` here, `token` elsewhere

#### POST `/api/dashboard/reset-password` (line 2968) — logged-in change (but actually auths by current password, not session)
- Body: `{ owner, currentPassword, newPassword }` (new min 8 chars)
- 401 `{error:'Wrong current password'}`
- 200: `{ ok: true }` (no new session issued)

**Login page flow:** `GET /dashboard?owner=<email>` — no password set → redirect `/connect/gmail?owner=`; password set but no/invalid `?s=` → server-rendered login page; valid `?s=` → dashboard HTML. `GET /start?owner=&s=` (onboarding wizard) also validates session at line 8201 and bounces to `/dashboard` on failure.

---

## 2. ⚠️ Route conflict you must know about

`GET /api/dashboard/analytics` is registered **twice**:
1. **Line 6416** — System B (X-Aria-Token + `?slug=`). Registered first, so **Express always routes here**.
2. **Line 10788** — System A (owner+session), 7-day rollup. **Unreachable dead code** — any request without `slug` gets `400 {error:'slug query param required'}` from handler #1; the owner-auth handler never runs.

A new frontend should use the slug-token analytics endpoint (or fix the path collision server-side first if the owner-auth rollup is wanted).

---

## 3. Analytics (domain: analytics)

### GET `/api/dashboard/analytics` (line 6416) — **Auth: System B**
- Query: `slug` (required, lowercased). Header: `X-Aria-Token`.
- 400 `{error:'slug query param required'}` | 401 `{error:'not authenticated'}`
- 200:
```json
{
  "slug": "ej_roofing",
  "ownerEmail": "owner@example.com",
  "businessType": "trades",
  "window7d": {
    "chats": 0, "widgetLoads": 0, "chatOpens": 0,
    "leadsCaptured": 0, "hotLeads": 0, "bookings": 0,
    "ownerNotified": 0, "afterHours": 0,
    "estimatedValueGbp": 0,
    "sampleHotLeads": [],          // up to 5
    "firstEventTs": null, "lastEventTs": null
  },
  "window30d": { "chats": 0, "leadsCaptured": 0, "hotLeads": 0, "bookings": 0, "estimatedValueGbp": 0 },
  "generatedAt": "ISO"
}
```

### GET `/api/dashboard/sessions` (line 6738) — **Auth: System B**
- Query: `slug` (required), `days` (1–90, default 7). Header: `X-Aria-Token`.
- 200: `{ slug, sessions: [...], totalSessions }`, each session (from `lib/analytics.js sessionsForSlugWindow`):
```json
{ "sessionId": "...", "slug": "...", "startedAt": "ISO", "lastActivityAt": "ISO",
  "messages": 3, "chatOpened": true, "leadCaptured": false, "leadHot": false,
  "bookingCreated": false, "afterHours": false, "ownerNotified": false,
  "leadSummary": null, "leadScore": null }
```
Sorted newest `lastActivityAt` first.

### GET `/api/dashboard/stats` (line 10243) — **Auth: A**
- 200:
```json
{
  "emailsReplied": { "week": 0, "total": 0 },
  "bookings": { "week": 0, "total": 0 },
  "leads": { "total": 0, "hot": 0, "warm": 0, "cold": 0 },
  "leadsBySource": {
    "email":   { "hot": 0, "warm": 0, "cold": 0 },
    "channel": { "hot": 0, "warm": 0, "cold": 0 }
  },
  "csat": { "positive": 0, "negative": 0, "total": 0, "scorePct": null },  // null when no ratings; 90-day window
  "autoReplyEnabled": false,
  "gmailConnected": false
}
```
(Token budget deliberately not exposed — admin-only at `/api/admin/usage`.)

### GET `/api/dashboard/analytics` (line 10788) — **DEAD (shadowed)**. For reference, it would return:
`{ period:'7d', volumeByChannel:{facebook:[7],instagram:[7],whatsapp:[7],email:[7]}, totalConversations, leadsBreakdown:{hot,warm,cold}, sentimentDist:{positive,neutral,negative,angry}, csatTrend:[7 of pct|null], topCategories:[{name,count}×5], weekOverWeek:{convs:pct,convsAbs} }` — arrays are 7 daily buckets oldest→newest.

### GET `/api/dashboard/activity` (line 10895) — **Auth: A**
- Query: `limit` (default 20, max 50)
- 200: `{ events: [...] }` newest-first, each one of:
  - `{ type:'lead', ts, channel, label:'HOT lead from <name>', detail:<preview ≤100>, score:'hot|warm|cold', category }`
  - `{ type:'booking', ts, channel, label:'Booking: <name>', detail:<datetime|notes> }`
  - `{ type:'handoff', ts, channel, label:'Handed off to you — <senderId>', detail:<reason> }`
  - `{ type:'csat', ts, channel, label:'👍|👎 rating from <name>', detail:<raw ≤80>, rating:'positive|negative' }`

---

## 4. Leads (domain: leads)

### GET `/api/dashboard/leads` (line 11494) — **Auth: A**
Widget-chat leads (from in-memory `sessions`), deduped by email.
- 200: `{ leads: [ { email, name|null, phone|null, score|null, tag|null, page|null, date } ] }`

---

## 5. Bookings (domain: bookings)

### GET `/api/dashboard/bookings` (line 11522) — **Auth: A**
- 200: `{ bookings: [...] }` — newest first, max 50. Booking objects are heterogeneous; channel bookings look like `{ name, contact, service, datetime, notes?, channel, ownerEmail, ts, durationMin:60 }`; widget bookings are `{ ...req.body, ts }` from `POST /api/booking`. Render defensively (`b.ownerEmail || b.alertTo` is the owner key).

### GET `/api/dashboard/booking-ics/:filename` (line 11534) — **Auth: A**
- `:filename` must match `^booking-[A-Za-z0-9_\-@.]+\.ics$` (400 `invalid filename` otherwise) and must contain the owner's alphanumeric-squashed email (403 `not your booking`).
- 200: `text/calendar` attachment. 404 `not found` (plain text errors, not JSON).

---

## 6. Conversations (domain: conversations)

memKey format throughout: `"<ownerEmail>::<channel>::<senderId>"`.

### GET `/api/dashboard/messages` (line 11685) — **Auth: A**
- Query: `channel` (`all`|`facebook`|`instagram`|`whatsapp`...; default `all`), `page` (default 1). 10 per page.
- 200: `{ items, page, totalPages, total }`; item: `{ id, channel, senderId, senderName, message, reply, timestamp, status:'sent'|'conflict-blocked'|... }` (newest first; server keeps last 500/owner).

### GET `/api/dashboard/conversation/:memKey` (line 11413) — **Auth: A**
- `:memKey` URL-encoded; must start with `<owner>::` → else 403 `{error:'not your conversation'}`
- 200: `{ memKey, channel, senderId, history: [ { role:'sender'|'us', preview:<≤300 chars>, date } ], state: { paused?, escalatedAt?, reason?, resumedAt?, pendingBooking?, ... } }`

### GET `/api/dashboard/escalations` (line 11450) — **Auth: A**
- 200: `{ items: [ { memKey, channel, senderId, escalatedAt, reason } ] }` (paused convs only, newest first)

### POST `/api/dashboard/resume-conversation` (line 11465) — **Auth: A**
- Body: `{ memKey }` (must start with `<owner>::` → else 400 `{error:'invalid memKey'}`)
- 200: `{ ok: true }` or `{ ok: true, note: 'no-op — no paused state' }`

### GET `/api/dashboard/csat-detail` (line 11426) — **Auth: A**
- 200: `{ items: [...] }` — last ≤30 negative ratings, newest first; each = raw CSAT ledger entry (`{ ownerEmail, channel, senderId, senderName?, rating:'negative', raw?, ts }`) plus `history` (last 6 conversation turns).

### GET `/api/dashboard/inbox-log` (line 11482) — **Auth: A** (email reply log)
- Query: `page` (default 1), 20/page.
- 200: `{ items: [ { ownerEmail, senderEmail, subject, replyPreview:<≤200>, sentAt, type, leadScore|null, category|null } ], page, perPage:20, total, totalPages }`

---

## 7. Knowledge & AI training (domain: knowledge)

### GET `/api/dashboard/knowledge` (line 15644) — **Auth: A**
- 200: `{ docs: [ { title, charCount, uploadedAt } ] }` (content NOT returned — there is no doc-content read endpoint)

### POST `/api/dashboard/knowledge` (line 15652) — **Auth: A** — body limit 2 MB
- Body: `{ title, content }` — title clipped 120 chars; content max 200,000 chars (413 over). Cap 50 docs/owner (oldest silently dropped).
- 200: `{ ok: true, totalDocs }`

### DELETE `/api/dashboard/knowledge/:idx` (line 15667) — **Auth: A**
- `:idx` = array index. 404 `{error:'not found'}` out of range. 200: `{ ok: true }`

### GET `/api/dashboard/channel-gaps` (line 10978) — **Auth: A**
Unanswered-question clusters, last 30 days, token-Jaccard ≥0.4 clustering.
- 200: `{ clusters: [ { count, lastSeen, sampleQuestion, examples: [≤3 of { question, channel, ariaReply, reason }] } ] (≤25, by count desc), totalGaps }`

### POST `/api/dashboard/gap-to-kb` (line 11032) — **Auth: A** — calls Claude
- Body: `{ questions: string[] }` (required, non-empty)
- 200: `{ draft: { title, content, needsOwnerInput: string[] } }` | 500 `{error:'AI returned invalid JSON', raw}` or `{error:'Draft failed: ...'}`
- Does NOT persist — owner accepts via POST /knowledge.

### POST `/api/dashboard/faq-bootstrap` (line 11087) — **Auth: A** — parallel Claude drafting
- Body: `{ limit?: number }` (clamped 3–15, default 10)
- 200: `{ drafts: [ { clusterIdx, count, sampleQuestion, draft: { title, content, needsOwnerInput[] } } | { clusterIdx, count, sampleQuestion, error } ], totalGaps, totalClusters }` — or `{ drafts: [], message: 'No gaps to bootstrap from yet.' }`

### POST `/api/dashboard/faq-bootstrap/accept` (line 11192) — **Auth: A** — limit 512 kb
- Body: `{ accepted: [ { title, content } ] }` (400 if empty)
- 200: `{ ok: true, saved, skipped, totalDocs }` (50-doc cap enforced; saved docs get `source:'faq-bootstrap'`)

### POST `/api/dashboard/test-aria` (line 11220) — **Auth: A** — sandbox, nothing sent
- Body: `{ message: string (required), simulateChannel?: 'instagram'|'whatsapp'|'facebook' (default 'instagram') }`
- 200:
```json
{
  "reply": { "text", "suggestedReplies": [], "sentiment", "urgency", "language",
             "outOfScope", "needsHuman", "handoffReason", "booking", "contact",
             "showServicesCarousel" },
  "citedChunks": [ { "title", "preview": "<≤200>", "score" } ],
  "tokensUsed": 0
}
```

### POST `/api/dashboard/ai-train` (line 11288) — **Auth: A** — one-shot setup wizard
- Body: `{ websiteUrl?: string, description?: string }` (at least one; 400 otherwise; 400 `'No usable input — website unreachable and no description given'`)
- 200: `{ knowledgeDoc: { title, content } | null, services: [ { title, subtitle, image, link, btn_text } ] (≤10), allowedTopics: string[] (≤12), siteCharsExtracted }`
- Read-only — owner saves via /knowledge, /profile (servicesCarousel, allowedTopics).

### POST `/api/dashboard/ai-improve` (line 11377) — **Auth: A**
- Body: `{ current?: string, instruction?: string, kind?: 'knowledge'|'service' }` (current or instruction required)
- 200: `{ improved: string }`

---

## 8. Channels (domain: channels)

### GET `/api/dashboard/channels` (line 11665) — **⚠️ NO AUTH — only `?owner=` query param**
- 200: `{ channels: { whatsapp?: {...}, instagram?: {...}, facebook?: {...}, sms?: {...} } }` — **returns the raw channelConfigs object, which can include access tokens.** This is an unauthenticated data leak; a new frontend should not rely on this remaining open (treat as auth-A and expect it to be fixed).

### POST `/api/dashboard/channels` (line 11672) — **Auth: A**
- Body: `{ channel: string, value: any }` (both required) — sets `configs[channel] = value` verbatim.
- 200: `{ ok: true }`

### GET `/api/dashboard/channel-stats` (line 11702) — **Auth: A**
- 200: `{ stats: { whatsapp: {replied,week,lastReply}, instagram: {...}, facebook: {...}, total }, channels: <channelConfigs obj>, gmailConnected: bool }`

### POST `/api/dashboard/channel-toggle` (line 11716) — **Auth: A**
- Body: `{ channel: string, enabled: boolean }` (typeof boolean enforced). 400 `'Channel not connected'` if absent.
- 200: `{ ok: true }`

### POST `/api/dashboard/channel-disconnect` (line 11731) — **Auth: A**
- Body: `{ channel }`. 200: `{ ok: true }` (idempotent delete)

---

## 9. Phone / voice (domain: phone) — gated by plan `receptionist`

Plan model: `profile.plan ∈ {'lite','receptionist'}`, default `lite`; `canUseVoice()` requires receptionist. Set admin-side via `POST /api/admin/set-plan`.

### GET `/api/dashboard/phone/settings` (line 16964) — **Auth: A**
- 200:
```json
{
  "planAllowed": false,
  "plan": "lite",
  "settings": {
    "enabled": false, "phoneNumber": "", "voiceId": "paula", "firstMessage": "",
    "provisioned": false,
    "answerMode": "always",            // always | business_hours | out_of_hours
    "businessHours": { "mon": "9-17", "tue": "9-17", "wed": "9-17", "thu": "9-17", "fri": "9-17", "sat": "closed", "sun": "closed" },
    "timezone": "Europe/London", "fallbackNumber": ""
  },
  "canProvision": false,
  "webhookUrl": "https://<host>/api/vapi/webhook"
}
```

### POST `/api/dashboard/phone/settings` (line 16988) — **Auth: A** — limit 8 kb
- 403 `{error:'Voice receptionist requires the Receptionist plan.'}` if not on plan.
- Body (all optional, merge semantics): `{ enabled: bool, phoneNumber: string≤24 (ignored if number was provisioned), voiceId: ≤40, firstMessage: ≤300, answerMode: enum, businessHours: {mon..sun: string≤16}, timezone: ≤60, fallbackNumber: ≤24 }`
- 200: `{ ok: true, settings: <merged config incl. vapiNumberId if present> }`

### POST `/api/dashboard/phone/provision` (line 17030) — **Auth: A** — spends real money
- Body: `{ areaCode?: string }`
- 403 plan gate | 503 `'Phone provisioning is not enabled yet — contact support.'` (no VAPI_API_KEY) | 409 `{error:'You already have a number...', number}` | 502 `{error:'Could not provision a number right now. ...'}`
- 200: `{ ok: true, number, vapiNumberId }`

### POST `/api/dashboard/phone/release` (line 17071) — **Auth: A**
- 404 `{error:'No provisioned number to release.'}`
- 200: `{ ok: true }`

### GET `/api/dashboard/calls` (line 17084) — **Auth: A**
- 200: `{ calls: [ { ts, intent, summary, customerNumber, durationSec, recordingUrl, booking|null } ] }` — newest first, ≤40, from `data/phone_calls.jsonl`.

---

## 10. Reviews (domain: reviews)

### GET `/api/dashboard/reviews/settings` (line 10599) — **Auth: A**
- 200: `{ settings: { enabled: bool (default true), url: '', delayHours: 24, template: '', alwaysEmail: false }, recent: [≤30 ledger entries newest-first], defaultTemplate: 'Hi {customer}! ... {url}' }`

### POST `/api/dashboard/reviews/settings` (line 10632) — **Auth: A** — limit 16 kb
- Body: `{ enabled?=true, url?='' (must be http(s) if set), delayHours?=24 (clamped 1–720), template?='' (≤800), alwaysEmail?=false }`
- 200: `{ ok: true, settings: {...saved} }`

### POST `/api/dashboard/reviews/test` (line 10661) — **Auth: A** — render preview, sends nothing
- Body: `{ customer?: string (default 'Sarah'), service?: string (default 'visit') }`
- 200: `{ preview: string, ready: bool }` — template placeholders `{customer} {business} {service} {url}`

---

## 11. Webhooks (domain: settings/integrations)

Valid event types: `new_lead`, `hot_lead`, `new_booking`, `handoff`, `angry_message`, `csat_negative`, `conversation_started` (+ `test`). Delivery: POST JSON `{event, timestamp, data}` with headers `X-Aria-Event`, `X-Aria-Signature: sha256=<hmac>`, `X-Aria-Timestamp`; retries 30s/2m/8m on 5xx.

### GET `/api/dashboard/webhooks` (line 10454) — **Auth: A**
- 200: `{ webhooks: [ { label, url, events: [], enabled, secretHint: '••••abcd'|null } ], recentDeliveries: [≤30 of { ts, event, url, attempt, status?, ok, ms?, error? }] }`

### POST `/api/dashboard/webhooks` (line 10473) — **Auth: A** — limit 32 kb
- Body: `{ label?: string (≤60, default 'Webhook'), url: http(s) required, events?: string[] (default ['new_lead','new_booking','handoff']), enabled?=true, replaceIndex?: number }`
- Max 10 per owner (400). Update preserves existing secret.
- 200: `{ ok: true, secret: '<48-hex>' }` — **only time the full secret is shown**

### DELETE `/api/dashboard/webhooks/:index` (line 10510) — **Auth: A**
- 404 `{error:'not found'}` / `{error:'profile not found'}`. 200: `{ ok: true }`

### POST `/api/dashboard/webhooks/:index/test` (line 10528) — **Auth: A**
- 404 `{error:'webhook not found'}`
- 200: dispatch result — `{ ok:true, status, attempt }` or `{ ok:false, status?, attempt?, reason?|error?, retrying? }`

---

## 12. Notifications (domain: settings)

### GET `/api/dashboard/notifications/settings` (line 10549) — **Auth: A**
- 200: `{ settings: { enabled: bool, sendTime: 'HH:MM' (default '17:00'), timezone: string (default 'Europe/London') }, queuedToday: number, lastDigestSent: string|null }`

### POST `/api/dashboard/notifications/settings` (line 10566) — **Auth: A** — limit 4 kb
- Body: `{ enabled?=false, sendTime?='17:00' (regex ^\d{1,2}:\d{2}$ → 400 'sendTime must be HH:MM'), timezone?: string }`
- 200: `{ ok: true, settings: {...} }`

---

## 13. Customers / CRM (domain: leads)

### GET `/api/dashboard/customers` (line 10681) — **Auth: A**
- 200: `{ customers: [ { key, name, channels: string[], touches, lastSeen, recent: [≤1 touch] } ] }` — sorted lastSeen desc.

### GET `/api/dashboard/customer/:contactKey` (line 10705) — **Auth: A**
- `:contactKey` URL-encoded. 404 `{error:'Customer not found'}`.
- 200:
```json
{
  "key", "name", "channels": [], "touches", "lastSeen",
  "leadHistory": [ { "ts","channel","leadScore","category","sentiment","preview" } ],
  "bookings": [ <booking objects> ],
  "conversations": [ { "memKey","channel","senderId","msgCount","lastMsgTs" } ],
  "sentimentTimeline": [ { "ts","sentiment" } ],
  "ltv": 0
}
```
- `ltv` is 0–100 (`lib/customer_ltv.js`): bookings×30 + hotLeads×10 + otherLeads×3 + convs×2 + log-scaled touches, capped 100. UI tiers: ≥60 VIP `#00e5a0`, ≥30 Engaged `#fbbf24`, ≥10 Active `#9d96ff`, else New `#8888aa`.

---

## 14. Profile & settings (domain: settings)

### GET `/api/dashboard/profile` (line 11558) — **Auth: A**
- 200: `{ profile: {...} | {} }` — fields seen: `email, businessName, services, location, phone, hours, tone, servicesCarousel[], allowedTopics[], outbound{}, schedule{}, onboardingComplete, plan, webhooks[], notificationDigest{}, reviewRequest{}, businessHours{}`

### POST `/api/dashboard/profile` (line 11570) — **Auth: A** — **partial update**: only keys present in body are written
- Body (all optional): `{ businessName, services, location, phone, email, hours, tone (default 'friendly'), servicesCarousel: [], allowedTopics: [], outbound: {}, schedule: {}, onboardingComplete: bool }`
- Side effect: rebuilds the email auto-reply system prompt if auto-reply enabled.
- 200: `{ ok: true, profile: <full updated profile> }`

### GET `/api/dashboard/settings` (line 11624) — **Auth: A**
- 200: `{ autoReplyEnabled: bool, approvalMode: bool, followUpsEnabled: bool (default true), gmailConnected: bool }`

### POST `/api/dashboard/settings` (line 11637) — **Auth: A**
- Body (each optional): `{ autoReplyEnabled: bool, approvalMode: bool, followUpsEnabled: bool }`
- 200: `{ ok: true }`

---

## 15. Outbound tasks (domain: settings/debug)

### GET `/api/dashboard/outbound` (line 17540) — **Auth: A**
- 200: `{ tasks: [ { id, type: 'lead_followup'|'booking_reminder'|'conv_recovery', dueAt, scheduledAt, payloadSummary: string } ] }` — pending only, sorted dueAt asc.

---

## 16. Frontend implementation notes

1. **Token plumbing:** keep `owner` (email) + session token; send both on every System-A call — simplest is `?owner=<email>&s=<token>` on GETs and `{ owner }` in JSON bodies + `x-session-token` header on POST/DELETE. (`requireDashboardAuth` reads body `owner` too, so query `owner` isn't needed on POSTs that include it in the body.)
2. **Body parsing:** routes that declare `express.json({limit})` inline are listed above; the others rely on global JSON parsing — always send `Content-Type: application/json`.
3. **Sessions survive restarts** (persisted JSON) but reset tokens (`forgot-password`) and the System-B OAuth states are in-memory only — they die on server restart.
4. **No PUT/PATCH anywhere** — updates are POST; deletes use DELETE with array indices (`webhooks/:index`, `knowledge/:idx`), so refetch the list after every mutation since indices shift.
5. **Field-name inconsistencies to honor:** login/set-password return `token`; complete-reset returns `sessionToken`. Error payloads are always `{ error: string }` except booking-ics (plain text).
6. **Known server bugs/quirks (verified):** (a) the owner-auth analytics route is shadowed (section 2); (b) `GET /api/dashboard/channels` is unauthenticated and can expose channel access tokens; (c) `POST /api/dashboard/webhooks` and `DELETE .../webhooks/:index` mutate the profile in memory without calling `persistProfiles()` — webhook changes can be lost on restart.
