# Aria v5 — Design Spec

## Overview

Upgrade Aria from a chatbot-with-email-features into a self-service AI assistant platform. Clients onboard via a single link, Aria learns their business automatically, and the client gets a clean dashboard to manage everything. The widget gets voice, image upload, and multilingual support. Automated tests protect every deploy.

---

## 1. Self-Service Onboarding

### Problem

Onboarding is manual — Kyle embeds the script, configures the prompt, connects Gmail, sets up auto-reply. External businesses (not Kyle's web clients) can't onboard at all without Kyle's involvement.

### Solution

A link-based onboarding flow that gets a client from zero to "Aria is replying to my emails and booking my calendar" in under 2 minutes.

### How It Works

**Kyle's side — generating the link:**

- New admin route `GET /admin/invite` renders a form: enter client email, optionally pre-fill their website URL and business type
- Generates a unique invite token stored in `data/invites.json` with: `{ token, email, url?, type?, createdAt, used: false }`
- Produces a link: `https://aria-chatbot-production-12d0.up.railway.app/onboard?t=INVITE_TOKEN`
- Kyle sends this link to the client (WhatsApp, email, whatever)

**Client's side — clicking the link:**

- `GET /onboard?t=TOKEN` validates the token and starts the wizard

**Step 1 — Website scan (skipped if URL pre-filled):**

- If no URL in the invite, client enters their website URL
- Server crawls the site (homepage + up to 5 linked pages) using existing site-crawl logic from `chatbot.js`
- Claude analyzes the crawled content and extracts: business name, services offered, location, phone, email, working hours, tone/style
- Presents the extracted profile to the client: "Here's what I found about your business — is this right?"
- Client can edit any field inline
- Save the confirmed profile as the `data-prompt` and business config

**Step 2 — Connect Gmail + Google Calendar:**

- Single OAuth button: "Connect your Gmail" (existing OAuth flow)
- Scopes already include Gmail read/send + Calendar
- On successful OAuth callback, redirect back to the onboarding wizard
- Auto-enable email auto-reply with the business profile as the system prompt
- Auto-enable calendar booking

**Completion:**

- Client sets a dashboard password
- Redirect to their dashboard
- Aria is live — polling their inbox, replying with Claude, creating calendar events for bookings
- Show a confirmation: "Aria is now managing your inbox. Here's what she'll do..."

### Invite Management

- `GET /admin/invites` — list all invites (used/unused) in the admin panel
- `DELETE /admin/invite/:token` — revoke an unused invite
- Invites expire after 7 days if unused
- Each invite is single-use

---

## 2. Client Dashboard (Smart Single Page)

### Problem

Current client-facing page (`/connect/gmail?owner=EMAIL`) only shows Gmail connection and auto-reply toggle. Clients can't see what Aria is doing, what leads came in, or what emails were sent.

### Solution

A single scrollable page at `/dashboard?owner=EMAIL` with collapsible sections. Mobile-first, works on any phone.

### Layout

**Top bar:**
- Aria logo
- Client email badge
- Logout button

**Status cards row (always visible):**
- Emails replied (this week / total)
- Leads captured (this week / total)
- Bookings made (this week / total)
- Auto-reply status (on/off toggle, clickable)

**Collapsible sections:**

**Inbox Log**
- List of emails Aria replied to: sender, subject, Aria's reply preview, timestamp
- Expandable to see full reply
- Filter: last 7 days / 30 days / all
- Status badges: replied, pending approval, skipped (OOO/spam)

**Leads**
- Table: name, email, phone, source (chat/email), date captured
- Click to expand: full conversation or email thread
- Export to CSV button

**Calendar**
- Upcoming bookings: date, time, client name, service
- Synced from Google Calendar
- Link to open in Google Calendar

**Business Profile**
- Editable fields: business name, services, hours, location, phone, email
- "Tone" selector: professional, friendly, casual
- Save updates the system prompt automatically

**Settings**
- Toggle auto-reply on/off
- Toggle approval mode (review before sending) on/off
- Toggle follow-up emails on/off
- Connect/disconnect Gmail
- Connect/disconnect Google Calendar
- Change dashboard password

### Authentication

- Uses existing password system (`data/dashboard-passwords.json`)
- Session tokens with 7-day expiry (`data/dashboard-sessions.json`)
- Forgot password flow (existing)

### New Routes

- `GET /dashboard` — serves the dashboard page (requires `?owner=` or session cookie)
- `GET /api/dashboard/stats` — returns status card data
- `GET /api/dashboard/inbox-log` — returns email reply log (paginated)
- `GET /api/dashboard/leads` — returns captured leads (paginated)
- `GET /api/dashboard/bookings` — returns upcoming bookings
- `GET /api/dashboard/profile` — returns business profile
- `POST /api/dashboard/profile` — update business profile
- `GET /api/dashboard/settings` — returns toggle states
- `POST /api/dashboard/settings` — update toggles

---

## 3. Widget v5

### 3a. Voice Input

**How it works:**
- Mic button appears next to the send button in the chat widget
- Uses browser `SpeechRecognition` API (Web Speech API) — no external service needed
- Tap to start recording, tap again to stop (or auto-stop on silence)
- Transcribed text appears in the input field
- User can edit before sending, or it auto-sends after 1.5s of silence
- Visual feedback: pulsing mic icon while recording, waveform animation

**Fallback:** If `SpeechRecognition` is not supported (Firefox, some mobile browsers), hide the mic button. Show it only when the API is available.

**Privacy:** Audio is processed locally by the browser — never sent to the server. Only the transcribed text is sent.

### 3b. Voice Output (Text-to-Speech)

**How it works:**
- Small speaker icon on each bot message
- Uses browser `SpeechSynthesis` API — no external service
- Tap to read the message aloud
- Optional: auto-speak toggle in widget settings (off by default)
- Respects `prefers-reduced-motion` — disables auto-speak

**Voice selection:** Use the browser's default voice. If multiple voices are available for the detected language, prefer a natural-sounding one.

### 3c. File/Image Upload

**How it works:**
- Paperclip/attachment button next to send button
- Accepts images (jpg, png, webp, gif) and documents (pdf)
- Max file size: 5MB
- Image preview shown in chat before sending
- Images sent to server as base64, included in Claude's message as image content blocks
- Claude can see and describe the image, then respond contextually
- Documents: extract text content server-side, include as context

**New routes:**
- `POST /api/chat/upload` — accepts multipart form data with file + message + session ID
- Server processes image → sends to Claude as vision input
- Server processes PDF → extracts text → includes in prompt

**Use cases:** Photo of roof damage, nails/lash style reference, broken appliance, menu to analyze, document to summarize.

### 3d. Multilingual Support

**How it works:**
- No language selector needed — Aria auto-detects from the visitor's first message
- Add to system prompt prefix: "Detect the language of the user's message. Respond in the same language. If the user switches language mid-conversation, switch with them."
- Quick reply buttons: translate labels based on detected language (Claude generates translated quick replies on first response)
- Widget UI labels (placeholder text, button labels) stay in English but the conversation flows in any language

**Scope:** This is Claude-powered, not a translation layer. Claude natively handles 50+ languages. The widget just needs to not block non-English input (already works — no changes to input handling needed).

---

## 4. Automated Testing

### Test Framework

- **Vitest** for unit and integration tests (fast, zero-config, ESM native)
- **Playwright** for E2E widget tests
- `npm test` runs the full suite
- Tests run before every deploy (add to `package.json` scripts)

### 4a. Server Tests (Vitest)

**API route tests:**
- `POST /api/chat` — returns a valid Claude response
- `POST /api/chat/stream` — streams chunks correctly
- `POST /api/session` — creates session with valid ID
- `POST /api/lead` — captures lead data
- `POST /api/booking` — creates booking
- `GET /health` — returns 200 with stats

**Email auto-reply tests:**
- Enable/disable auto-reply toggles correctly
- Status endpoint reflects current state
- Reply log returns entries in correct format
- Rate limiting prevents double-replies (mock Gmail API)
- OOO detection skips auto-reply messages

**Auth tests:**
- Set password hashes correctly
- Login with correct password returns session token
- Login with wrong password returns 401
- Session tokens expire after 7 days
- Forgot password generates valid reset token

**Onboarding tests (new):**
- Valid invite token loads wizard
- Expired/used token shows error
- Website scan extracts business profile
- Profile save generates valid system prompt
- OAuth callback completes onboarding

**Dashboard API tests (new):**
- Stats endpoint returns correct counts
- Inbox log pagination works
- Profile update saves and regenerates prompt
- Settings toggle persists state

### 4b. Widget Tests (Playwright)

**Load tests:**
- Widget script loads without errors
- Chat button renders on page
- Clicking chat button opens the chat window
- Chat window is responsive (test at 375px and 1280px)

**Chat tests:**
- Sending a message shows it in the chat
- Bot responds within 10 seconds
- Streaming response renders progressively
- Quick reply buttons appear and are clickable

**Feature tests:**
- Voice input button appears (when SpeechRecognition available)
- File upload button appears and accepts images
- Message reactions work (thumbs up)
- Handoff buttons render (WhatsApp, email)

**Regression tests:**
- Widget doesn't break page scroll
- Widget doesn't conflict with existing page styles
- Multiple widget instances don't conflict
- Widget works with CSP headers

### Test Data

- Mock Anthropic API responses for unit tests (don't burn tokens)
- Use real API for one smoke test tagged `@smoke` (runs on deploy only)
- Mock Gmail API for email tests
- Test HTML page that embeds the widget for Playwright tests

---

## 5. Website Scanner (New Component)

Powers the onboarding flow — extracts business information from a website.

### How it works

- `POST /api/scan-website` — accepts `{ url }`, returns business profile
- Fetches homepage HTML (server-side fetch, not browser)
- Extracts: page title, meta description, headings, main content text, contact info (phone, email, address), social links
- Follows up to 5 internal links (About, Services, Contact, Menu, Pricing) to gather more info
- Sends extracted content to Claude with prompt: "Analyze this website content and extract: business name, what they do (services), location, phone number, email, working hours, and the tone they use (professional/friendly/casual). Return as JSON."
- Returns structured profile: `{ name, services, location, phone, email, hours, tone, summary }`

### Rate limiting

- Max 1 scan per minute per IP
- Cache scan results for 24 hours (don't re-crawl same URL)

---

## Technical Notes

### File changes

- `server.js` — new routes for onboarding, dashboard, website scanner, file upload
- `chatbot.js` — voice input/output buttons, file upload button, multilingual prompt prefix
- `package.json` — add vitest, playwright as devDependencies
- New: `tests/server.test.js`, `tests/widget.test.js`, `tests/test-page.html`
- New: `data/invites.json` — invite tokens

### No breaking changes

- All existing embeds continue working unchanged
- Existing `/connect/gmail` route stays functional (redirects to new `/dashboard`)
- Existing admin panel unchanged
- No database migration needed — still JSON files

### Dependencies to add

- `vitest` (dev) — test runner
- `playwright` (dev) — browser testing
- `@playwright/test` (dev) — test framework
- No new production dependencies — voice/TTS use browser APIs, file upload uses existing Express middleware
