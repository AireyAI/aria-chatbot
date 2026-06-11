# Aria Client Dashboard — Complete Feature Manifest
**Source:** `/Users/kyleairey/chatbot/server.js`, route `app.get('/dashboard', …)` at line **11745**; the inline HTML/CSS/JS template literal spans lines ~11760–14465 (`res.send(\`…\`)` closes at 14464–14465). This manifest covers everything in lines 11790–14465 plus the route preamble needed for context.

---

## 0. Route flow before the dashboard renders

| Stage | Behavior |
|---|---|
| No `?owner=` | `res.redirect('/')` |
| Owner has no password (`dashboardPasswords.has(ownerEmail)` false) | redirect to `/connect/gmail?owner=…` (setup) |
| Has password, no/invalid session (`validateSession(sessionToken, ownerEmail)`) | Serves a standalone **login page** (lines ~11760–11806): AriaAi logo, email badge, password input, Login button, error `.msg`, "Powered by AireyAi" footer. JS `login()` POSTs `/api/dashboard/login` with `{owner:'${ownerEmail}', password}`; on `data.ok` redirects to `/dashboard?owner=${encodeURIComponent(ownerEmail)}&s=<token>` |
| Authenticated but brand-new owner | **Onboarding redirect** (11808–11831): if `profile.onboardingComplete` unset AND no `businessName`, no `knowledgeDocs`, no FB/IG/WA `accessToken` in `channelConfigs`, no `gmailTokens` entry, AND `!req.query.skipOnboarding` → `res.redirect('/start?owner=…&s=…')` |
| Authenticated + configured | Full dashboard (11834→14465) |

Auth model for every subsequent API call: **query-string auth** — every fetch appends `Q = 'owner=<OWNER>&s=<TOKEN>'`.

---

## 1. Server-side template interpolations (`${…}` evaluated at render time)

These are the ONLY values baked into the page at render; everything else is fetched client-side.

| Expression | Where used |
|---|---|
| `${ownerEmail}` | Login page email badge + login `fetch` body; topbar `.email-badge`; JS const `OWNER = '${ownerEmail}'` |
| `${encodeURIComponent(ownerEmail)}` | Login redirect URL; `/connect/meta?owner=…` href; `/connect/instagram?owner=…` href |
| `${sessionToken}` | JS const `TOKEN = '${sessionToken}'` |
| `${encodeURIComponent(sessionToken)}` | `/connect/meta` and `/connect/instagram` hrefs (`&s=…`) |

Render-time server values consulted (not interpolated, but gate the render): `getOwnerProfile(ownerEmail)`, `knowledgeDocs.get(ownerEmail)`, `channelConfigs.get(ownerEmail)`, `gmailTokens.has(ownerEmail)`, `dashboardPasswords`, `validateSession`, `req.query.skipOnboarding`.

⚠️ All other `\${…}` occurrences in the template are **backslash-escaped** — they are client-side JS template-literal interpolations, NOT server-side. One of these escapes is a bug (see §6.1).

---

## 2. Page shell & navigation

### 2.1 Topbar (sticky, z-100, blurred `rgba(11,11,22,0.82)`)
- Logo: `Aria` + green `Ai` (`em` accent)
- `.email-badge` showing `${ownerEmail}` (hidden ≤700px)
- `⌘ K` ghost button → `openPalette()`
- `? Tutorial` ghost button → clears `localStorage._aria_tutorial_done` + reloads (re-triggers tutorial)
- `Logout` button → `logout()` = navigate to `/dashboard?owner=<OWNER>` **without** `s` (drops back to login). No server-side session invalidation.

### 2.2 Sidebar (`#sidebar`, fixed 236px, top:55px)
Two nav groups; each `.nav-item` calls `showPanel(name)`:

| Group | Panel id | Icon | Label |
|---|---|---|---|
| (main) | `home` | 🏠 | Home |
| | `conversations` | 💬 | Conversations |
| | `leads` | 🎯 | Leads |
| | `customers` | 👥 | Customers |
| | `bookings` | 📅 | Bookings |
| "Manage" | `train` | 🧠 | Train Aria |
| | `channels` | 🔗 | Channels |
| | `profile` | 🏢 | Business |
| | `settings` | ⚙️ | Settings |

### 2.3 Panel-switch machinery
- `PANEL_NAMES = ['conversations','leads','customers','bookings','train','channels','profile','settings']` — declared at top of script to avoid a TDZ bug (comment documents it broke every button once).
- `showPanel(name)`: show `#panel-home` or one `#sec-<name>` (all others `display:none`); first visit sets `loaded[name]=true`, injects `SKELETON_HTML` into `#body-<name>`, calls `loadSection(name)`; sets `.nav-item.active`; retriggers `.panel-enter` animation (`panelIn` keyframe, 0.28s); persists choice to `localStorage.aria_panel`; scrolls to top.
- Init IIFE restores last panel from `localStorage.aria_panel` (falls back to `home`).
- `toggleSection(name)`: legacy accordion-open path (still wired to section-header `onclick` for conversations/leads/customers/bookings and to channel-chip "not connected" action) — only ever opens + lazy-loads, never collapses. Arrows are hidden via CSS (`.section .arrow{display:none}`), headers de-clickified visually.
- `refreshPanel(name)`: re-inject skeleton + `loadSection(name)` (Refresh buttons in panel headers).
- `loadSection(name)` dispatch: leads→`loadLeads`, bookings→`loadBookings`, profile→`loadProfile`, settings→`loadSettings`, conversations→`loadUnifiedConvs('all')`, train→`loadTrainAria`, customers→`loadCustomers`. **No `channels` branch** (see bug §6.2).

### 2.4 ⌘K Command palette
- Overlay `#cmdk` + input + list + footer hints (↑↓ / ↵ / esc).
- `CMDS` array: 9 "Go" commands (one per panel) + 3 "Do" commands: *Export leads as CSV* (`exportLeads()`), *Refresh current panel* (reads `localStorage.aria_panel`), *Log out*.
- Keyboard: global `keydown` — Cmd/Ctrl+K toggles; Escape closes; ArrowUp/Down move selection; Enter runs. Substring (not fuzzy) filter on label.

### 2.5 Toast, modal, skeletons, empty states
- `toast(msg)`: single `#toast` div, bottom-center green pill, 2.5s auto-hide.
- Modal: `#modal-overlay` + `#modal-content`; `openModal(html)`/`closeModal()`; click-outside closes. Used by thread view, customer profile, CSAT detail.
- `SKELETON_HTML`: 5 shimmer rows (widths 60/85/72/90/50%), `shimmer` keyframe 1.4s.
- `.empty-state` pattern: icon + title + subtitle (used in Customers, Leads, Bookings empties; Leads empty includes a "Connect a channel →" CTA → `showPanel('channels')`).

### 2.6 First-visit tutorial
If `localStorage._aria_tutorial_done` unset: full-screen overlay, 6 steps (Welcome / green dot / channel chips / activity feed / Train Aria / done) with Back/Next buttons + dot indicators; sets the flag on completion. `window.nextStep`/`window.prevStep` are globals.

### 2.7 Helpers
- `api(path)` GET / `apiPost(path, body)` POST — both append `Q` auth query.
- `timeAgo(dateStr)` (just now/m/h/d), `escH(s)` (DOM-based HTML escape; server has a separate `escapeHtml()` for OAuth pages).
- Home greeting IIFE: time-aware "Good morning/afternoon/evening 👋" + locale long date in `#greet-date`.

---

## 3. Panels — data, endpoints, actions

### 3.1 HOME (`#panel-home`) — loaded immediately on page load
Components, top to bottom:

1. **Escalations banner** (`#escalations-banner`, top of `.container`, outside panel-home so visible everywhere) — GET `/api/dashboard/escalations`. If `items.length`: amber banner "🤝 N conversation(s) handed to you", up to 5 rows (channel · senderId · reason) each with a **Resume** button → `resumeConv(memKey)` → confirm → POST `/api/dashboard/resume-conversation` `{memKey}` → toast + `loadStats()`. Also injects a `badge-attn` "N need attention" pill into the Conversations section header.
2. **Greeting** (`#home-greet`).
3. **Hero status bar** (`#hero-status`): pulsing green dot (red `.off` if paused). Live = `d.autoReplyEnabled || any of fb/ig/wa channels[c].enabled`. Title "Aria is working for you / Aria is paused"; sub = last reply timeAgo, or "Waiting for the first message…", or "No channels connected yet…". Metrics: Replies (channel-stats total), Leads total, Bookings total, optional **CSAT %** (color-banded ≥80 green / ≥50 amber / red, clickable → `showCsatDetail()` modal). Hero-actions slot shows "N emails / N bookings this week" text only (comment notes master pause is per-channel via chips).
4. **Channel chip strip** (`#channel-strip`): 4 chips — Messenger 📘, Instagram 📷, WhatsApp 💬, Email 📧. States: `on` / `off`(paused) / `disconnected`(45% opacity). Click behavior: connected social chip → `toggleChannel(key, !enabled)`; email chip → `toggleSetting('autoReplyEnabled', !enabled)`; disconnected → `toggleSection('channels')` (note: opens section but does NOT switch the visible panel — see §6.5).
5. **Activity feed**: GET `/api/dashboard/activity?limit=12`. Rows: typed icon (lead 🎯 / booking 📅 / handoff 🤝 / csat ⭐), label, detail, channel pill, timeAgo.
6. **Analytics "This week"** (`loadAnalytics()`, fired on load): GET `/api/dashboard/analytics`. Renders: week-over-week pill (`weekOverWeek.convs` %, ↑/↓/→); 4 `.ana-card`s in 2×2 grid (1-col ≤700px): **Conversations** combined 7-day sparkline + per-channel legend (`volumeByChannel.{facebook,instagram,whatsapp,email}` arrays, brand colors); **Leads donut** (`leadsBreakdown.hot/warm/cold`); **CSAT trend** sparkline (`csatTrend`, violet, null-gap aware); **Top topics** horizontal bars (`topCategories`, max 5). Chart helpers are zero-dependency inline SVG builders: `svgSparkline`, `svgDonut`, `renderHorizontalBars`.
7. **Stats grid** (`#stats-row`): 4 stat cards from GET `/api/dashboard/stats` — Hot leads (red, 30d), Warm leads (amber, 30d), Bookings this week, Emails this week. Error fallback: single "!" card.

`loadStats()` calls (Promise.all): GET `/api/dashboard/stats` + GET `/api/dashboard/channel-stats`; then sequentially activity + escalations. `loadChannels()` is ALSO called once at page load (populates the Channels section cards).

### 3.2 CONVERSATIONS (`#sec-conversations`)
- Header actions: **↻ Refresh** (`refreshPanel('conversations')`).
- Filter buttons (`.conv-filter`): All / 📧 Email / 📘 Messenger / 📷 Instagram / 💬 WhatsApp → `loadUnifiedConvs(filter)`.
- Data merge: social → GET `/api/dashboard/messages?channel=<all|fb|ig|wa>&page=1`; email → GET `/api/dashboard/inbox-log?page=1`. Items merged, sorted desc by ts, sliced to 50.
- Table: channel icon / From / Message (100ch) / Aria's reply (100ch) / When.
- Row click (social only): builds `memKey = OWNER + '::' + channel + '::' + senderId` → `showThread(memKey)`. Email rows non-clickable (comment: "separate ledger").
- **Thread modal** (`showThread`): GET `/api/dashboard/conversation/<memKey>`. Bubbles: Customer (`them`), Aria (`us`), "Earlier summary" (`summary`, dashed violet, italic). PAUSED chip if `state.paused` (+ reason), with "Resume Aria on this conversation" CTA → `resumeConv`.

### 3.3 LEADS (`#sec-leads`)
- Header actions: **↧ Export CSV** (`exportLeads()` — client-side: GET `/api/dashboard/leads`, builds Name/Email/Phone CSV, Blob download `aria-leads.csv`) + **↻ Refresh**.
- GET `/api/dashboard/leads` → table Name/Email/Phone. Empty state with "Connect a channel →" CTA. No pagination, no lead-score column (hot/warm only visible on Home stats + customer profile).

### 3.4 CUSTOMERS (`#sec-customers`)
- Header: ↻ Refresh.
- GET `/api/dashboard/customers` → card list (max 100): name, channel icons, touch count, last seen, "View →".
- **Customer profile modal** (`showCustomerProfile`): GET `/api/dashboard/customer/<encodeURIComponent(key)>`. Shows: name + channels + touches + "first seen" (actually rendered from `d.lastSeen` — see §6.7); **LTV score** + tier badge (VIP ≥60 / Engaged ≥30 / Active ≥10 / New); **sentiment timeline** stacked bar (positive/neutral/negative/angry); **Bookings** (≤5); **Conversation threads** (≤5, click chains `closeModal()` → `showThread`); **Lead history** (≤10, score-color pill + category + preview quote).

### 3.5 BOOKINGS (`#sec-bookings`)
- Header: ↻ Refresh.
- GET `/api/dashboard/bookings` → cards: channel icon, name — service, 📅 datetime, contact, italic notes, optional **📅 .ics download** link → GET `/api/dashboard/booking-ics/<icsFilename>?<Q>` (auth in query string).
- No edit/cancel/delete actions.

### 3.6 TRAIN ARIA (`#sec-train`) — the biggest panel; 7 sub-cards rendered into placeholder divs
`loadTrainAria()` scaffolds `#train-test/-gaps/-quick/-knowledge/-services/-hours/-scope`, then runs `renderTestAriaCard()`, `renderQuickTrainCard()`, and `Promise.all([loadKnowledgeDocs, loadServicesEditor, loadScopeEditor, loadKnowledgeGaps, loadBusinessHoursEditor])`.

1. **🧪 Test Aria sandbox**: question input + "Ask Aria" → POST `/api/dashboard/test-aria` `{message}`. Renders reply text, suggested-reply chips, badges (sentiment, urgency, language≠en, ⚠️ OUT OF SCOPE, 🤝 NEEDS HUMAN, 📅 BOOKING DETECTED, 🎠 SHOWS CAROUSEL), and 📚 cited knowledge chunks (`citedChunks[].title/preview`).
2. **🕳️ Knowledge Gaps**: GET `/api/dashboard/channel-gaps` → clusters of unanswered questions (sampleQuestion, count, lastSeen). Per-cluster **✨ Draft answer** → `draftGapKb(i)` → POST `/api/dashboard/gap-to-kb` `{questions}` → editable title/content draft + `needsOwnerInput` placeholder warning → **+ Add to knowledge** (`acceptGapDraft` → POST `/api/dashboard/knowledge`) or Discard. If ≥3 clusters, **🚀 Bootstrap banner**: "✨ Draft all answers" → POST `/api/dashboard/faq-bootstrap` `{limit:10}` → checkbox-pick card list (editable titles/contents) → **+ Save all to KB** → POST `/api/dashboard/faq-bootstrap/accept` `{accepted:[{title,content}]}` → toast saved/skipped counts, reload docs+gaps. State in `window._gaps`, `window._gapDraft`, `window._bootstrapDrafts`.
3. **✨ Quick Train wizard**: website URL and/or 1–3-sentence description → POST `/api/dashboard/ai-train` `{websiteUrl, description}` → draft of knowledgeDoc + services[] + allowedTopics[] with per-block **+ Accept** buttons and **+ Accept ALL** (`acceptQtDoc` → POST `/api/dashboard/knowledge`; `acceptQtServices` → merge into `window._services` (cap 10) → POST `/api/dashboard/profile` `{servicesCarousel}`; `acceptQtTopics` → set-merge → POST `/api/dashboard/profile` `{allowedTopics}`). State `window._qtDraft`.
4. **📚 Knowledge Documents**: GET `/api/dashboard/knowledge` → doc rows (title, charCount, uploadedAt) each with **Remove** → confirm → **DELETE** `/api/dashboard/knowledge/<idx>?<Q>` (index-based delete). Add form: title + content textarea + **✨ Improve with AI** (uses `prompt()` for the instruction → POST `/api/dashboard/ai-improve` `{current, instruction, kind:'knowledge'}` → replaces textarea) + **+ Add to Aria's knowledge** → POST `/api/dashboard/knowledge` `{title,content}`.
5. **🎠 Services Carousel editor**: GET `/api/dashboard/profile` → `profile.servicesCarousel`. Per-card inputs: title, subtitle, image URL (60px preview, `onerror` hides), link URL, button text; remove (×); **+ Add service card** (max 10); **Save services** → POST `/api/dashboard/profile` `{owner, servicesCarousel}`. Live-mutates `window._services` via `oninput`.
6. **🕐 Business Hours**: GET `/api/dashboard/profile` → `profile.schedule`. Mode select (Always 24/7 vs Business hours only); when business_hours: timezone input, per-day hour inputs (mon–sun, format `9-18`/`9:30-17:30`/`closed`/`24h`), out-of-hours behaviour select (`auto_reply` w/ message textarea vs `silent`). **Live status badge** `computeLiveScheduleBadge()` mirrors server logic client-side (🟢 ON / 🌙 OFF with current tz time). `updateHoursDay` patch-renders only the badge to avoid cursor jump. **Save** → POST `/api/dashboard/profile` `{owner, schedule}`. State `window._schedule`.
7. **🚦 Topic Scope**: GET `/api/dashboard/profile` → `allowedTopics` chips with × remove, add input (Enter or Add btn, dup check), **Save topics** → POST `/api/dashboard/profile` `{owner, allowedTopics}`. State `window._scopeTopics`.

### 3.7 CHANNELS (`#sec-channels`) — static HTML body + `loadChannels()` enrichment
Static content (rendered server-side):
- Intro copy ("Once connected they **stay connected**").
- **Connect Facebook (Page + Messenger)** button → `/connect/meta?owner=${…}&s=${…}` (server-interpolated, works) + privacy reassurance copy.
- **Connect Instagram (DMs)** button → `/connect/instagram?owner=${…}&s=${…}` (server-interpolated, works).
- **Connect Gmail (Inbox + Auto-reply)** link `#gmail-connect-btn` → href is **broken** (see §6.1).
- `#gmail-status-row` + `#channel-cards` placeholders.

`loadChannels()` (runs once at page load): GET `/api/dashboard/channel-stats` →
- Per-channel cards for WhatsApp Business / Instagram DMs / Facebook Messenger: connected → "✓ Connected" + detail (`displayPhone`/`igUsername`/`pageName`), reply state (Aria is replying / Replies paused), reply count, **enable toggle** → `toggleChannel` → POST `/api/dashboard/channel-toggle` `{owner, channel, enabled}`, **Disconnect** → confirm → POST `/api/dashboard/channel-disconnect` `{owner, channel}`. Not connected → 50%-opacity "Not connected" card.
- Hides the big Connect buttons (`meta-connect-btn`, `ig-connect-btn`, `gmail-connect-btn`) when that channel is already connected (deliberate UX: visible Connect on a connected channel reads as broken).
- Gmail connected → green "✓ Connected / Inbox + auto-reply active" row in `#gmail-status-row`.

### 3.8 BUSINESS PROFILE (`#sec-profile`)
GET `/api/dashboard/profile` → form: Business Name, Services (textarea), Location, Phone, Email (defaults to OWNER), Hours (free text — distinct from Train Aria's structured schedule), Tone select (friendly/professional/casual/formal). **Save Profile** → POST `/api/dashboard/profile` (full flat object incl. `owner`).

### 3.9 SETTINGS (`#sec-settings`) — 4 toggle groups + 4 lazy sub-panels
`loadSettings()`: Promise.all GET `/api/dashboard/settings` + GET `/api/dashboard/profile`.

**Email auto-reply toggles** (each `saveSetting(key,bool)` → POST `/api/dashboard/settings` `{owner, [key]: value}`):
- Auto-Reply (`autoReplyEnabled`)
- Approval Mode (`approvalMode`) — review drafts before send
- Follow-Ups (`followUpsEnabled`)

**Outbound nudges** (each `saveOutbound(key,bool)` — reads current profile, mutates `profile.outbound`, POST `/api/dashboard/profile` `{owner, outbound}`; defaults ON):
- Lead follow-up email (`leadFollowup`)
- Booking reminders (`bookingReminder`)
- Conversation recovery (`convRecovery`)

**Connections**: Gmail status badge (Connected/Disconnected) + "Gmail Settings" link → `/connect/gmail?owner=…&s=…` (this one is a *client-side* template literal so it works, unlike §6.1).

**📞 Phone receptionist** (`loadPhoneSettings`, GET `/api/dashboard/phone/settings`):
- **Plan gate**: if `!d.planAllowed` → upsell card ("Upgrade to the Receptionist plan… You're on the Lite plan"), no controls.
- Else also GET `/api/dashboard/calls` → recent 6 calls (intent emoji: booking📅 quote💷 enquiry💬 complaint⚠️ message✉️ other📞, summary, ▶ recording link, duration, timeAgo).
- Number block, 3 states: (1) provisioned number → display + forwarding tip + **Release number** → confirm → POST `/api/dashboard/phone/release`; (2) `canProvision` → **Get my number →** → POST `/api/dashboard/phone/provision` `{}`; plus "OR use a number you already have" → **Connect** (regex-validated) → POST `/api/dashboard/phone/settings` `{phoneNumber, enabled:true}` + webhook URL display (`d.webhookUrl`); (3) BYO Vapi paste fallback: number input + webhook URL for Vapi Server settings.
- Enabled toggle (`ph-enabled`, ● Live/● Off), Greeting input (`firstMessage`), **answer schedule block** (`phoneScheduleBlock`): mode select (always / out_of_hours / business_hours), per-day hours grid, timezone, fallback transfer number. **Save** → POST `/api/dashboard/phone/settings` (full body; guards for the no-input provisioned state).

**📋 Notification digest** (`loadDigestSettings`, GET `/api/dashboard/notifications/settings`): enabled toggle, queued-today count, last-sent, send time (time input, default 17:00), timezone. **Save** → POST `/api/dashboard/notifications/settings` `{enabled, sendTime, timezone}`. Copy explains urgent events still fire immediately.

**⭐ Review requests** (`loadReviewSettings`, GET `/api/dashboard/reviews/settings`): enabled toggle, status badge (Active/Disabled/Not configured), Google review URL input (+ whitespark.ca generator link), delay select (2h–7d), "Also email" checkbox, message template textarea (placeholders `{customer} {business} {service} {url}`, default shown), **Save** → POST `/api/dashboard/reviews/settings`, **Preview** → POST `/api/dashboard/reviews/test` `{customer:'Sarah', service:'haircut'}` → inline preview block. Recent 6 request rows (sent / skipped / skipped-no-URL).

**🔗 Webhooks** (`loadWebhooks`, GET `/api/dashboard/webhooks`): hook cards (label, ●ON/OFF, url, event pills, secret hint) with **Test** → POST `/api/dashboard/webhooks/<idx>/test` and **Remove** → confirm → **DELETE** `/api/dashboard/webhooks/<idx>?<Q>`. Add form: label, URL, event checkboxes (`new_lead, hot_lead, new_booking, handoff, angry_message, csat_negative`; defaults checked: new_lead/new_booking/handoff) → POST `/api/dashboard/webhooks` `{label,url,events}` → toast shows first 12 chars of returned secret. Recent 8 deliveries (status color, event, host, timeAgo). `EVENT_LABELS` also includes `conversation_started` and `test` (display-only).

---

## 4. Complete endpoint inventory (exact paths + methods)

All called with `?owner=<OWNER>&s=<TOKEN>` appended.

| Method | Path | Used by |
|---|---|---|
| POST | `/api/dashboard/login` | login page (pre-auth) |
| GET | `/api/dashboard/stats` | Home hero + stats grid |
| GET | `/api/dashboard/channel-stats` | Home chips/hero + Channels cards |
| GET | `/api/dashboard/activity?limit=12` | Home activity feed |
| GET | `/api/dashboard/analytics` | Home weekly charts |
| GET | `/api/dashboard/escalations` | Escalation banner + attn badge |
| POST | `/api/dashboard/resume-conversation` | Resume buttons (banner + thread modal) |
| GET | `/api/dashboard/messages?channel=&page=` | Conversations (+ dead `loadMessages`) |
| GET | `/api/dashboard/inbox-log?page=` | Conversations email merge (+ dead `loadInbox`) |
| GET | `/api/dashboard/conversation/<memKey>` | Thread modal |
| GET | `/api/dashboard/customers` | Customers list |
| GET | `/api/dashboard/customer/<key>` | Customer profile modal |
| GET | `/api/dashboard/csat-detail` | CSAT 👎 modal |
| GET | `/api/dashboard/leads` | Leads panel + CSV export |
| GET | `/api/dashboard/bookings` | Bookings panel |
| GET | `/api/dashboard/booking-ics/<icsFilename>` | .ics download link |
| POST | `/api/dashboard/test-aria` | Test Aria sandbox |
| GET | `/api/dashboard/channel-gaps` | Knowledge Gaps |
| POST | `/api/dashboard/gap-to-kb` | Draft answer from gap |
| POST | `/api/dashboard/faq-bootstrap` | Bulk-draft FAQs |
| POST | `/api/dashboard/faq-bootstrap/accept` | Bulk-save FAQs |
| GET | `/api/dashboard/knowledge` | KB doc list |
| POST | `/api/dashboard/knowledge` | Add KB doc (also gap/quick-train accept) |
| DELETE | `/api/dashboard/knowledge/<idx>` | Remove KB doc |
| POST | `/api/dashboard/ai-improve` | ✨ Improve KB text |
| POST | `/api/dashboard/ai-train` | Quick Train draft |
| GET | `/api/dashboard/profile` | Profile/services/scope/hours/settings reads |
| POST | `/api/dashboard/profile` | Profile/services/scope/hours/outbound writes |
| GET | `/api/dashboard/settings` | Settings toggles read |
| POST | `/api/dashboard/settings` | `saveSetting` / `toggleSetting` |
| POST | `/api/dashboard/channel-toggle` | Chip + card channel pause/resume |
| POST | `/api/dashboard/channel-disconnect` | Disconnect button |
| GET | `/api/dashboard/phone/settings` | Phone panel read |
| POST | `/api/dashboard/phone/settings` | Phone save / connect-own-number |
| POST | `/api/dashboard/phone/provision` | Get Aria number |
| POST | `/api/dashboard/phone/release` | Release number |
| GET | `/api/dashboard/calls` | Recent calls list |
| GET | `/api/dashboard/webhooks` | Webhooks read |
| POST | `/api/dashboard/webhooks` | Add webhook |
| DELETE | `/api/dashboard/webhooks/<idx>` | Remove webhook |
| POST | `/api/dashboard/webhooks/<idx>/test` | Test webhook |
| GET | `/api/dashboard/notifications/settings` | Digest read |
| POST | `/api/dashboard/notifications/settings` | Digest save |
| GET | `/api/dashboard/reviews/settings` | Reviews read |
| POST | `/api/dashboard/reviews/settings` | Reviews save |
| POST | `/api/dashboard/reviews/test` | Review preview |

Non-API navigations: `/connect/meta?owner&s`, `/connect/instagram?owner&s`, `/connect/gmail?owner&s` (×2, one broken), `/dashboard?owner` (logout), `/start?owner&s` (server redirect).

---

## 5. Design system / theming / responsive

**Fonts:** Google Fonts **Geist** (400–800), single family for display + body (`--font-display`/`--font-body` both Geist; hierarchy via weight/size — commented as deliberate "institutional" choice). Headings get `letter-spacing:-0.02em`.

**CSS custom properties** (`:root`, the contract for a rebuild):
- Surfaces: `--bg:#0b0b16`, `--surface-1:#14142099`, `--surface-2:#161630`, `--surface-3:#1c1c34`; lines `--line: rgba(255,255,255,.07)`, `--line-2: .12`
- Text scale (3-step): `--text:#f1f1f7`, `--text-2:#a6a6bf`, `--text-3:#6c6c85`
- Accent: `--accent:#00e5a0` (green), `--accent-ink:#04130d`, alphas `--accent-06/-12/-30`; semantics `--danger:#ff6b6b`, `--warn:#fbbf24`, `--info:#38bdf8`, `--violet:#9d96ff`
- Radii `--r-sm:9 / md:13 / lg:17 / xl:22 / full:999`; shadows `--shadow-1/-2/-glow`
- Body background: fixed dual radial glows (green top-left, violet top-right)

⚠️ Despite the token system, **most colors are hardcoded hex inline** throughout the JS-built HTML (`#00e5a0`, `#161630`, `#8888aa`, `#9898b8`, `#6b6b8a`, `#fbbf24`, `#ff6b6b`, `#9d96ff`, channel brand colors `#1877F2/#E1306C/#25D366`) — only the static CSS uses vars consistently. A rebuild should consolidate.

**Other machinery:** custom scrollbars; `::selection`; `:focus-visible` outline; `tabular-nums` on all numerics; row hover micro-interactions; `panelIn`/`fadeIn`/`pulse`/`shimmer` keyframes; `.tb-ghost`, `.panel-action(.primary)`, `.cta-btn`, `.btn-save` (gradient green), `.btn-logout`, `.badge-on/.badge-off`, `.wow-pill(.up/.down)`, `.toggle` switch component, `.cmdk-*` palette suite, `.gmail-link/.gmail-card`.

**Responsive:**
- ≤900px: sidebar becomes horizontal sticky scroll bar (labels hidden, icons hidden, `.container` margin-left 0)
- ≤700px: smaller topbar/logo, email badge hidden, hero 1-col, stats 2-col, smaller tables/chips, greet-date hidden, analytics 1-col

---

## 6. Broken / duplicated / vestigial

### Broken
1. **Gmail Connect link in Manage Channels is dead** (line ~12263): `href="/connect/gmail?owner=\${encodeURIComponent(OWNER)}&s=\${encodeURIComponent(TOKEN)}"` — the `\${}` escape only makes sense inside a *client-side* JS template literal, but this anchor is raw server-rendered HTML, so the rendered href is literally `/connect/gmail?owner=${encodeURIComponent(OWNER)}&s=…`. The visually-identical link in Settings (line ~13842) is inside `body.innerHTML = \`…\`` and works. Partially masked because `loadChannels()` hides the button when Gmail is already connected — but for a NOT-yet-connected owner, the primary Gmail CTA 404s/garbles.
2. **Channels panel self-destructs via sidebar**: `loadSection()` has **no `channels` branch**, but `showPanel('channels')` (sidebar button, ⌘K command, and the localStorage restore on load) sets `loaded.channels=true` and replaces `#body-channels` innerHTML with `SKELETON_HTML` before calling the no-op loader → the entire static Channels content (Connect FB/IG/Gmail buttons, `#gmail-status-row`, `#channel-cards`) is wiped and replaced with a **permanent skeleton shimmer**. Only reaching it via `toggleSection('channels')` (disconnected chip click) preserves the content. Any rebuild must treat Channels as a real loadable section.
3. **`logout()` doesn't invalidate the session** — just drops the `s` param from the URL; the token remains valid server-side and in browser history.
4. **Session token in every URL** (query-string auth) — leaks into history, logs, referrers, and the .ics download href. Noted as a rebuild-contract issue, matches the known P0 CSRF/session findings in the Aria product review.

### Vestigial (dead code to drop or rewire in a rebuild)
5. **`loadInbox(page)`** (~13685): targets `#body-inbox`, which doesn't exist anywhere in the template. Nothing calls it except its own pagination buttons. Legacy of a pre-unified "Inbox" section.
6. **`loadMessages(page, channel)` + `msgChannel`** (~14418): targets `#messages-list` and `.msg-filter` buttons — neither exists. Superseded by `loadUnifiedConvs`. Dead.
7. Stale comment `// One-click test button (already in topbar)` (~12678) — there is no test button in the topbar (only ⌘K / Tutorial / Logout).
8. Customer modal label bug: header prints "first seen `timeAgo(d.lastSeen)`" — wrong field or wrong label.
9. Disconnected channel chip's click action `toggleSection('channels')` opens the section but doesn't call `showPanel('channels')` — in sidebar mode the section is `display:none`, so the click appears to do nothing (though it accidentally protects against bug #2 by setting `loaded.channels` without the skeleton wipe).

### Duplicated (consolidate on rebuild)
10. **Channel definition lists** repeated ~4×: chips in `loadStats`, cards in `loadChannels`, plus channel icon maps (`📘/📷/💬/📧`) re-declared independently in at least 6 functions (customers, profile modal, conversations, bookings, loadStats, loadMessages).
11. **Two separate business-hours editors** with near-identical day-grid/mode/timezone logic: Train Aria's `renderHoursEditor`/`computeLiveScheduleBadge` (message channels, `profile.schedule`) vs Settings' `phoneScheduleBlock` (voice, `phone/settings.businessHours`). Plus a third free-text "Hours" field in Business Profile.
12. **Gmail SVG logo** (actually Google "G" paths) pasted twice verbatim (Channels + Settings).
13. **Two settings write paths for the same concept**: `saveSetting`/`toggleSetting` both POST `/api/dashboard/settings` with identical shape; outbound flags go through `/api/dashboard/profile` instead.
14. `profile` is re-fetched independently by `loadServicesEditor`, `loadBusinessHoursEditor`, `loadScopeEditor`, `loadProfile`, `loadSettings`, and `saveOutbound` — six GETs of the same resource on a Train-Aria visit.
15. Inline-style soup: virtually all dynamic HTML uses long inline style strings rather than the defined classes — the `:root` token system exists but is bypassed by hundreds of hardcoded hex values.
