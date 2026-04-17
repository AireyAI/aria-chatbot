# Multi-Channel Messaging Integration — Design Spec

**Date:** 2026-04-17
**Channels:** WhatsApp Business API, Instagram DMs, Facebook Messenger
**Approach:** Unified Meta webhook + Facebook OAuth for client connection

---

## Overview

Add real messaging integrations for WhatsApp, Instagram, and Facebook Messenger to Aria. All three channels go through a single Meta Business App owned by AireyAI. Clients connect via Facebook OAuth (same UX as the existing Gmail connect flow). Aria auto-replies to incoming messages using Claude, following the same pattern as the email auto-reply system.

---

## Env Vars

```
META_APP_ID              — Meta App ID (from Meta Developer dashboard)
META_APP_SECRET          — Meta App Secret (webhook signature verification + OAuth)
META_VERIFY_TOKEN        — Webhook subscription handshake string (you choose it)
```

No per-client tokens stored in env — they come back from OAuth and are stored in `channelConfigs`.

---

## Meta App Setup (Manual, One-Time by Kyle)

1. Create a Meta App at developers.facebook.com
2. Add products: Facebook Login, WhatsApp, Webhooks
3. Configure Facebook Login: set redirect URI to `https://aria-chatbot-production-12d0.up.railway.app/auth/meta/callback`
4. Request permissions: `pages_messaging`, `instagram_manage_messages`, `whatsapp_business_management`, `whatsapp_business_messaging`, `pages_show_list`, `business_management`
5. Set webhook URL to `https://aria-chatbot-production-12d0.up.railway.app/api/meta/webhook`
6. Set webhook verify token to match `META_VERIFY_TOKEN` env var
7. Subscribe to: `messages`, `messaging_postbacks` for Pages; `messages` for Instagram; `messages` for WhatsApp Business Account

---

## Data Structures

### Channel Config (extends existing `channelConfigs` Map)

```js
// channelConfigs.get('client@email.com')
{
  whatsapp: {
    enabled: true,
    phoneNumberId: '123456789',
    wabaId: '987654321',          // WhatsApp Business Account ID
    accessToken: 'EAA...',
    displayPhone: '+44 7940 763489',
    connectedAt: '2026-04-17T...'
  },
  instagram: {
    enabled: true,
    igUserId: '456...',
    accessToken: 'EAA...',
    username: '@ejroofing',
    connectedAt: '2026-04-17T...'
  },
  facebook: {
    enabled: true,
    pageId: '789...',
    pageName: 'EJ Roofing & Construction',
    accessToken: 'EAA...',
    connectedAt: '2026-04-17T...'
  },
  approvalMode: false   // shared across all channels (or per-channel if needed later)
}
```

### Channel Messages (new Map)

```js
// CHANNEL_MESSAGES — persisted to data/channel-messages.json
const CHANNEL_MESSAGES = new Map();
// key: ownerEmail
// value: [{ id, channel, senderId, senderName, message, reply, timestamp, status }]
```

### Channel Stats (new Map)

```js
// CHANNEL_REPLY_STATS — persisted to data/channel-stats.json
const CHANNEL_REPLY_STATS = new Map();
// key: ownerEmail
// value: {
//   whatsapp:  { replied: 0, week: 0, lastReply: null },
//   instagram: { replied: 0, week: 0, lastReply: null },
//   facebook:  { replied: 0, week: 0, lastReply: null },
//   total: 0,
//   leads: { hot: 0, warm: 0, cold: 0 }
// }
```

### Conversation Memory (extends existing pattern)

```js
// Reuse existing conversationMemory Map
// Key format: "ownerEmail::channel::senderId"
// e.g. "client@email.com::whatsapp::447940763489"
// Stores last 20 messages for context
```

---

## New Endpoints

### Webhook

```
GET  /api/meta/webhook          — Webhook verification (Meta handshake)
POST /api/meta/webhook          — Incoming messages from all 3 channels
```

- Raw body capture for signature verification (same pattern as Shopify webhook)
- Verify `X-Hub-Signature-256` header using `META_APP_SECRET`
- ACK with 200 immediately, process async
- Parse payload to determine channel type:
  - `entry[].changes[].field === 'messages'` with `messaging_product === 'whatsapp'` → WhatsApp
  - `entry[].messaging[].message` with Instagram page → Instagram
  - `entry[].messaging[].message` with Facebook page → Messenger
- Look up client by matching recipient ID (phoneNumberId / igUserId / pageId) against `channelConfigs`
- If no client found or channel disabled → ignore silently
- Dedup by message ID to prevent double-processing

### OAuth

```
GET  /auth/meta/start           — Initiate Facebook OAuth (redirects to Facebook)
GET  /auth/meta/callback        — OAuth callback, exchange code for tokens
```

**OAuth flow:**
1. Client clicks "Connect" in dashboard
2. Redirect to Facebook OAuth with required permissions
3. Callback receives auth code
4. Exchange code for short-lived user token
5. Exchange for long-lived user token (60 days)
6. Fetch list of Pages the user manages → get Page access tokens (non-expiring)
7. Check if the Page has WhatsApp, Instagram connected
8. Store all available channel tokens in `channelConfigs`
9. Subscribe the Page to webhook events via API
10. Redirect back to dashboard with success

**Token refresh:** Page access tokens from long-lived user tokens don't expire. But the user token does (60 days). Store the long-lived user token and refresh it before expiry. Add a daily check that refreshes any tokens expiring within 7 days.

### Dashboard API

```
GET  /api/dashboard/messages     — Paginated message feed (all channels)
     ?owner=X&s=TOKEN&channel=whatsapp|instagram|facebook|all&page=1

GET  /api/dashboard/channel-stats — Stats per channel
     ?owner=X&s=TOKEN

POST /api/dashboard/channel-toggle — Enable/disable a channel
     { owner, channel: 'whatsapp'|'instagram'|'facebook', enabled: boolean }

POST /api/dashboard/channel-disconnect — Disconnect a channel
     { owner, channel: 'whatsapp'|'instagram'|'facebook' }
```

All protected by existing `requireDashboardAuth()`.

---

## Message Processing Flow

```
Webhook payload arrives
  → Verify signature (X-Hub-Signature-256)
  → ACK 200
  → Parse channel type + sender + message text
  → Find client by recipient ID
  → Check channel enabled
  → Check rate limit (per sender, 30/min)
  → Check dedup (message ID already processed?)
  → Load conversation memory (ownerEmail::channel::senderId)
  → Build system prompt:
      - Client's business profile (from clientProfiles)
      - Knowledge base entries (from knowledgeBase)
      - Conversation history (last 20 messages)
      - Channel-specific instructions (e.g. "keep replies under 300 chars for WhatsApp")
  → Call Claude (haiku, max_tokens: 500)
  → Send reply via correct Meta API:
      - WhatsApp: POST /v21.0/{phoneNumberId}/messages
      - Instagram: POST /v21.0/{igUserId}/messages
      - Messenger: POST /v21.0/me/messages (with page access token)
  → Save to CHANNEL_MESSAGES
  → Update CHANNEL_REPLY_STATS
  → Update conversationMemory
  → Detect leads (name, phone, email in conversation)
  → Detect bookings (date/time mentioned)
  → If approval mode: email draft to client instead of sending
```

### Channel-Specific Reply Rules

- **WhatsApp:** Max 4096 chars. Mark messages as read via API. Support text replies only (no buttons for now).
- **Instagram:** Max 1000 chars. Reply via Instagram Messaging API.
- **Facebook Messenger:** Max 2000 chars. Reply via Send API with `messaging_type: RESPONSE`.

### Approval Mode

Same as email: if enabled, Aria drafts the reply and emails it to the client with approve/reject links. On approve, sends via the correct channel API. On reject, discards.

Approval endpoints:
```
GET /api/channel/approve?id=APPROVAL_ID   — Send the drafted reply
GET /api/channel/reject?id=APPROVAL_ID    — Discard the draft
```

---

## Dashboard UI Changes

### Stats Row (updated)

Add a new stat card:
```
| Messages Replied | Leads | Bookings | Auto-Reply | Channels |
| 47               | 12    | 5        | ON         | 3 active |
```

### Channels Section (replaces placeholder)

Each channel card shows:
- Channel icon + name
- Connection status (connected page/account name, or "Not connected")
- On/off toggle (only visible when connected)
- Connect/Disconnect button

One "Connect with Facebook" button at the top triggers OAuth. After connecting, the dashboard shows which channels are available based on what the client has (Facebook Page, Instagram Business, WhatsApp Business).

### New Messages Section

Collapsible section (same pattern as Inbox Log):
- Table: Channel icon | Sender | Message preview | Aria's reply preview | Time
- Filter tabs: All / WhatsApp / Instagram / Messenger
- Paginated (10 per page)
- Click to expand full conversation

---

## Persistence

New files in `data/`:
```
data/channel-messages.json     — message history per client
data/channel-stats.json        — reply stats per client per channel
data/meta-tokens.json          — OAuth tokens (long-lived user tokens for refresh)
```

Existing files updated:
```
data/channels.json             — extended with full channel config (tokens, IDs, enabled state)
```

All use the existing `save()` / `loadFile()` debounced persistence pattern.

---

## Token Refresh

Daily interval (alongside existing digest/weekly report intervals):
- Check all stored long-lived user tokens
- If expiring within 7 days, refresh via Meta API
- Log success/failure
- Email Kyle if refresh fails (token revoked, needs re-auth)

---

## Error Handling

- **Webhook fails:** ACK 200 anyway (Meta retries failed webhooks aggressively). Log error.
- **Claude fails:** Don't reply. Log the gap. Retry once after 2s.
- **Meta API send fails:** Log error. If 401 (token expired), mark channel as disconnected, email client.
- **Rate limited by Meta:** Back off. Log. Don't retry immediately.
- **Client not found for incoming message:** Ignore silently (could be a page not connected to any Aria client).

---

## What's NOT Included

- SMS / Twilio (can add later)
- Rich message types (buttons, carousels, images) — text-only replies for now
- WhatsApp message templates (required for sending first, but we're only replying so not needed)
- Instagram story replies
- Facebook comment replies (only DMs)

---

## Implementation Order

1. Meta webhook endpoint (verification + message parsing)
2. Meta OAuth flow (connect/disconnect)
3. Reply generation function (reuse email pattern)
4. Send functions per channel (WhatsApp, Instagram, Messenger)
5. Channel config storage + persistence
6. Dashboard API endpoints (messages, stats, toggle, disconnect)
7. Dashboard UI updates (channels section, messages section, stats)
8. Token refresh job
9. Approval mode for channels
10. Testing with real Meta app
