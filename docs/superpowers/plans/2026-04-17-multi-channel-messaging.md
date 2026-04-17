# Multi-Channel Messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real WhatsApp, Instagram DM, and Facebook Messenger integrations to Aria via a unified Meta webhook, so clients connect with one Facebook OAuth click and Aria auto-replies to incoming messages using Claude.

**Architecture:** Single Meta webhook endpoint handles all 3 channels. Facebook OAuth lets clients connect in one click (same UX as Gmail). Reply generation reuses the existing email auto-reply pattern (Claude haiku + business profile + knowledge base + conversation memory). Per-channel on/off toggles and approval mode in the client dashboard.

**Tech Stack:** Express.js, Meta Graph API v21.0, Facebook Login OAuth, Anthropic Claude API (existing), crypto for HMAC signature verification.

---

### Task 1: Data Structures & Persistence

**Files:**
- Modify: `server.js:264-274` (add new Maps alongside existing ones)
- Modify: `server.js:1619-1659` (add to `loadPersistedData()`)

- [ ] **Step 1: Add channel message and stats Maps after existing declarations (line ~274)**

Insert after the `pendingSetups` Map declaration (line 274):

```js
// ─── Multi-Channel Messaging ───────────────���────────────────────────────────
const CHANNEL_MESSAGES_FILE = resolve('data/channel-messages.json');
const CHANNEL_STATS_FILE = resolve('data/channel-stats.json');
const META_TOKENS_FILE = resolve('data/meta-tokens.json');
const CHANNEL_APPROVALS_FILE = resolve('data/channel-approvals.json');
const channelMessages = new Map();      // ownerEmail → [{ id, channel, senderId, senderName, message, reply, timestamp, status }]
const channelStats = new Map();         // ownerEmail → { whatsapp: { replied, week, lastReply }, instagram: {...}, facebook: {...}, total }
const metaTokens = new Map();           // ownerEmail → { userToken, userTokenExpiry, pages: [{ pageId, pageName, accessToken, igUserId, igUsername, wabaId, waPhoneNumberId, waDisplayPhone }] }
const channelApprovals = new Map();     // approvalId → { ownerEmail, channel, senderId, senderName, draftReply, createdAt }
const processedMetaMessages = new Set(); // dedup — message IDs already handled
```

- [ ] **Step 2: Add persistence functions after the new declarations**

```js
function persistChannelMessages() {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    const obj = {};
    for (const [k, v] of channelMessages) obj[k] = v;
    writeFileSync(CHANNEL_MESSAGES_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.warn('Failed to persist channel messages:', e.message); }
}

function persistChannelStats() {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    const obj = {};
    for (const [k, v] of channelStats) obj[k] = v;
    writeFileSync(CHANNEL_STATS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.warn('Failed to persist channel stats:', e.message); }
}

function persistMetaTokens() {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    const obj = {};
    for (const [k, v] of metaTokens) obj[k] = v;
    writeFileSync(META_TOKENS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.warn('Failed to persist Meta tokens:', e.message); }
}

function persistChannelApprovals() {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    const obj = {};
    for (const [k, v] of channelApprovals) obj[k] = v;
    writeFileSync(CHANNEL_APPROVALS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.warn('Failed to persist channel approvals:', e.message); }
}
```

- [ ] **Step 3: Add load functions inside `loadPersistedData()` (line ~1658, before the closing `)()`)**

```js
  // Channel messages
  try {
    if (existsSync(CHANNEL_MESSAGES_FILE)) {
      const saved = JSON.parse(readFileSync(CHANNEL_MESSAGES_FILE, 'utf8'));
      for (const [k, v] of Object.entries(saved)) channelMessages.set(k, v);
    }
  } catch (e) { console.warn('Failed to load channel messages:', e.message); }

  // Channel stats
  try {
    if (existsSync(CHANNEL_STATS_FILE)) {
      const saved = JSON.parse(readFileSync(CHANNEL_STATS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(saved)) channelStats.set(k, v);
    }
  } catch (e) { console.warn('Failed to load channel stats:', e.message); }

  // Meta OAuth tokens
  try {
    if (existsSync(META_TOKENS_FILE)) {
      const saved = JSON.parse(readFileSync(META_TOKENS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(saved)) metaTokens.set(k, v);
      console.log(`📱 Loaded Meta tokens for ${metaTokens.size} accounts`);
    }
  } catch (e) { console.warn('Failed to load Meta tokens:', e.message); }

  // Channel approvals
  try {
    if (existsSync(CHANNEL_APPROVALS_FILE)) {
      const saved = JSON.parse(readFileSync(CHANNEL_APPROVALS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(saved)) channelApprovals.set(k, v);
    }
  } catch (e) { console.warn('Failed to load channel approvals:', e.message); }
```

- [ ] **Step 4: Verify server starts without errors**

Run: `cd /Users/kyleairey/chatbot && node server.js`
Expected: Server starts, no crash. Ctrl+C to stop.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: add multi-channel data structures and persistence"
```

---

### Task 2: Meta Webhook Endpoint

**Files:**
- Modify: `server.js:55-56` (add raw body capture for Meta webhook, alongside Shopify)
- Modify: `server.js` (add webhook routes before the `/health` endpoint at line ~7458)

- [ ] **Step 1: Add raw body capture for Meta webhook (line 56, after the Shopify raw body line)**

```js
app.use('/api/meta/webhook', express.raw({ type: 'application/json' }));
```

- [ ] **Step 2: Add Meta signature verification helper function**

Insert near the other helper functions (after the Shopify HMAC verification, around line ~4099):

```js
// ─── Meta Webhook Signature Verification ──────────────��──────────────────────
function verifyMetaSignature(rawBody, signatureHeader) {
  if (!process.env.META_APP_SECRET || !signatureHeader) return false;
  const expected = crypto
    .createHmac('sha256', process.env.META_APP_SECRET)
    .update(rawBody)
    .digest('hex');
  return signatureHeader === `sha256=${expected}`;
}
```

- [ ] **Step 3: Add webhook verification GET endpoint (Meta handshake)**

Insert before the `/health` endpoint (line ~7458):

```js
// ─── Meta Webhook ──────────────────────────────────────────���─────────────────
app.get('/api/meta/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('✅ Meta webhook verified');
    return res.status(200).send(challenge);
  }
  res.status(403).send('Forbidden');
});
```

- [ ] **Step 4: Add webhook POST handler for incoming messages**

```js
app.post('/api/meta/webhook', (req, res) => {
  const rawBody = req.body; // Buffer from express.raw()
  const sig = req.headers['x-hub-signature-256'];

  if (!verifyMetaSignature(rawBody, sig)) {
    console.warn('⚠️ Meta webhook: invalid signature');
    return res.status(401).send('Invalid signature');
  }

  // ACK immediately — Meta retries aggressively if slow
  res.status(200).send('EVENT_RECEIVED');

  // Parse and process async
  let payload;
  try { payload = JSON.parse(rawBody.toString()); }
  catch { return; }

  setImmediate(() => processMetaWebhook(payload));
});
```

- [ ] **Step 5: Add the `processMetaWebhook` function that parses and routes messages**

```js
async function processMetaWebhook(payload) {
  if (!payload.entry) return;

  for (const entry of payload.entry) {
    // ── WhatsApp messages ──
    if (entry.changes) {
      for (const change of entry.changes) {
        if (change.field === 'messages' && change.value?.messages) {
          for (const msg of change.value.messages) {
            if (msg.type !== 'text') continue; // text only for now
            const phoneNumberId = change.value.metadata?.phone_number_id;
            const senderId = msg.from; // sender's phone number
            const senderName = change.value.contacts?.[0]?.profile?.name || senderId;
            const messageText = msg.text?.body || '';
            const messageId = msg.id;
            await handleIncomingChannelMessage({
              channel: 'whatsapp', recipientId: phoneNumberId,
              senderId, senderName, messageText, messageId,
            });
          }
        }
      }
    }

    // ── Instagram & Facebook Messenger messages ──
    if (entry.messaging) {
      for (const event of entry.messaging) {
        if (!event.message?.text) continue; // text only for now
        const recipientId = event.recipient?.id; // page ID or IG user ID
        const senderId = event.sender?.id;
        const messageText = event.message.text;
        const messageId = event.message.mid;

        // Determine channel: check if this recipient is an IG user or FB page
        const channel = findChannelByRecipientId(recipientId);
        if (!channel) continue;

        await handleIncomingChannelMessage({
          channel: channel.type, recipientId,
          senderId, senderName: senderId, // will resolve name later
          messageText, messageId,
        });
      }
    }
  }
}
```

- [ ] **Step 6: Add `findChannelByRecipientId` helper**

```js
function findChannelByRecipientId(recipientId) {
  for (const [ownerEmail, config] of channelConfigs) {
    if (config.facebook?.pageId === recipientId) {
      return { type: 'facebook', ownerEmail, config: config.facebook };
    }
    if (config.instagram?.igUserId === recipientId) {
      return { type: 'instagram', ownerEmail, config: config.instagram };
    }
  }
  return null;
}

function findOwnerByWhatsAppPhoneId(phoneNumberId) {
  for (const [ownerEmail, config] of channelConfigs) {
    if (config.whatsapp?.phoneNumberId === phoneNumberId) {
      return { ownerEmail, config: config.whatsapp };
    }
  }
  return null;
}
```

- [ ] **Step 7: Verify server starts with new endpoints**

Run: `cd /Users/kyleairey/chatbot && node server.js`
Expected: Server starts, no crash.

- [ ] **Step 8: Commit**

```bash
git add server.js
git commit -m "feat: add Meta webhook endpoint with signature verification"
```

---

### Task 3: Message Processing & Reply Generation

**Files:**
- Modify: `server.js` (add `handleIncomingChannelMessage` and `generateChannelReply` functions near the email reply generation at line ~996)

- [ ] **Step 1: Add `handleIncomingChannelMessage` function after `generateEmailReply` (line ~996)**

```js
// ─── Multi-Channel Message Handler ───────────────────────────────────────────
async function handleIncomingChannelMessage({ channel, recipientId, senderId, senderName, messageText, messageId }) {
  // Dedup
  if (processedMetaMessages.has(messageId)) return;
  processedMetaMessages.add(messageId);
  // Cap dedup set at 5000 entries
  if (processedMetaMessages.size > 5000) {
    const first = processedMetaMessages.values().next().value;
    processedMetaMessages.delete(first);
  }

  // Find owner
  let ownerEmail, channelConfig;
  if (channel === 'whatsapp') {
    const found = findOwnerByWhatsAppPhoneId(recipientId);
    if (!found) return;
    ownerEmail = found.ownerEmail;
    channelConfig = found.config;
  } else {
    const found = findChannelByRecipientId(recipientId);
    if (!found) return;
    ownerEmail = found.ownerEmail;
    channelConfig = found.config;
  }

  // Check channel enabled
  const ownerChannels = channelConfigs.get(ownerEmail);
  if (!ownerChannels?.[channel]?.enabled) return;

  console.log(`📱 [${channel}] Message from ${senderName} (${senderId}) for ${ownerEmail}: "${messageText.substring(0, 80)}"`);

  // Build system prompt from client profile
  const profile = getOwnerProfile(ownerEmail);
  const systemPrompt = profile?.systemPrompt || `You are a helpful business assistant for ${ownerEmail}.`;

  // Knowledge base
  const kbEntries = knowledgeBase.get(ownerEmail) || [];
  const kbContext = kbEntries.length
    ? '\n\nFREQUENTLY ASKED QUESTIONS:\n' + kbEntries.map(e => `Q: ${e.question}\nA: ${e.answer}`).join('\n\n')
    : '';

  // Conversation memory
  const memKey = `${ownerEmail}::${channel}::${senderId}`;
  const history = conversationMemory.get(memKey) || [];
  const convContext = history.length
    ? '\n\nPREVIOUS MESSAGES with this person (most recent last):\n' +
      history.map(h => `[${h.role === 'sender' ? 'THEM' : 'US'}] ${h.preview}`).join('\n---\n')
    : '';

  // Channel-specific instructions
  const channelLimits = {
    whatsapp: 'Keep replies under 300 words. Use short paragraphs. No HTML.',
    instagram: 'Keep replies under 200 words. Casual, friendly tone. No HTML.',
    facebook: 'Keep replies under 300 words. Friendly and professional. No HTML.',
  };
  const channelInstructions = `\n\nYou are replying via ${channel}. ${channelLimits[channel]} Never mention you are AI — write as a team member.`;

  // Generate reply
  const reply = await generateChannelReply(
    systemPrompt + kbContext + convContext + channelInstructions,
    senderName, messageText
  );

  if (!reply) {
    console.warn(`📱 [${channel}] Failed to generate reply for ${senderId}`);
    return;
  }

  // Save to conversation memory
  const historyEntry = (entries, role, text) => {
    entries.push({ role, preview: text.substring(0, 300), date: new Date().toISOString() });
    if (entries.length > 20) entries.splice(0, entries.length - 20);
    conversationMemory.set(memKey, entries);
    persistConversationMemory();
  };
  historyEntry(history, 'sender', messageText);

  // Check approval mode
  const approvalMode = ownerChannels.approvalMode || ownerChannels[channel]?.approvalMode;
  if (approvalMode) {
    const approvalId = generateSessionToken();
    channelApprovals.set(approvalId, {
      ownerEmail, channel, senderId, senderName, messageText,
      draftReply: reply.text, booking: reply.booking, createdAt: Date.now(),
    });
    persistChannelApprovals();

    const serverUrl = process.env.GOOGLE_REDIRECT_URI?.replace('/auth/gmail/callback', '') || `http://localhost:${process.env.PORT || 3000}`;
    await smartSend({
      ownerEmail, to: ownerEmail,
      subject: `✏️ Review Aria's ${channel} reply to ${senderName}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:20px;">
        <h2 style="color:#1a1a2e;margin-bottom:4px;">New ${channel} message from ${senderName}</h2>
        <div style="background:#f8f8fc;border-radius:10px;padding:16px;margin-bottom:20px;">
          <p style="font-size:12px;color:#999;margin-bottom:8px;">THEIR MESSAGE:</p>
          <p style="color:#333;font-size:14px;line-height:1.6;">${messageText.substring(0, 500)}</p>
        </div>
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px;margin-bottom:20px;">
          <p style="font-size:12px;color:#999;margin-bottom:8px;">ARIA'S DRAFT REPLY:</p>
          <p style="color:#333;font-size:14px;line-height:1.6;">${reply.text}</p>
        </div>
        <div style="display:flex;gap:12px;">
          <a href="${serverUrl}/api/channel/approve?id=${approvalId}" style="display:inline-block;padding:12px 24px;background:#00e5a0;color:#0d0d1f;border-radius:10px;text-decoration:none;font-weight:600;">✓ Send</a>
          <a href="${serverUrl}/api/channel/reject?id=${approvalId}" style="display:inline-block;padding:12px 24px;background:#ff6b6b;color:#fff;border-radius:10px;text-decoration:none;font-weight:600;">✗ Discard</a>
        </div>
      </div>`,
    });
    console.log(`✏�� [${channel}] Approval sent to ${ownerEmail}`);
    return;
  }

  // Send reply directly
  const sent = await sendChannelReply(channel, channelConfig, senderId, reply.text);
  if (!sent) {
    console.warn(`📱 [${channel}] Failed to send reply to ${senderId}`);
    return;
  }

  // Save our reply to conversation memory
  historyEntry(conversationMemory.get(memKey) || [], 'us', reply.text);

  // Log message
  const msgs = channelMessages.get(ownerEmail) || [];
  msgs.push({
    id: messageId, channel, senderId, senderName,
    message: messageText, reply: reply.text,
    timestamp: new Date().toISOString(), status: 'sent',
  });
  if (msgs.length > 500) msgs.splice(0, msgs.length - 500);
  channelMessages.set(ownerEmail, msgs);
  persistChannelMessages();

  // Update stats
  trackChannelReply(ownerEmail, channel);

  // Detect booking
  if (reply.booking) {
    bookings.push({ ...reply.booking, channel, ownerEmail, ts: new Date().toISOString() });
    save('bookings', bookings);
  }

  console.log(`📱 [${channel}] Replied to ${senderName}: "${reply.text.substring(0, 60)}..."`);
}
```

- [ ] **Step 2: Add `getOwnerProfile` helper (finds profile by ownerEmail)**

```js
function getOwnerProfile(ownerEmail) {
  // Check auto-reply config first (has systemPrompt)
  const arConfig = EMAIL_AUTO_REPLY_ENABLED.get(ownerEmail);
  if (arConfig?.systemPrompt) return { systemPrompt: arConfig.systemPrompt, config: arConfig.config };

  // Check client profiles by email
  for (const [key, val] of clientProfiles) {
    if (val.email === ownerEmail || key === ownerEmail) return val;
  }
  return null;
}
```

- [ ] **Step 3: Add `generateChannelReply` function**

```js
async function generateChannelReply(systemPrompt, senderName, messageText) {
  try {
    const r = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: `You received this message from ${senderName}:

"${messageText}"

Respond with valid JSON only:
{
  "text": "Your plain text reply here (no HTML)",
  "booking": null or { "name": "customer name", "datetime": "date/time mentioned", "notes": "what they need" }
}

Rules:
- Be friendly, helpful, and concise
- If asking for a quote or booking, confirm and ask for missing details
- If you can answer directly, do so
- Offer to arrange a call or visit when appropriate
- Sign off with the business name
- Plain text only, no HTML tags
- If a date/time/appointment is mentioned, extract into booking object` }],
      system: systemPrompt,
    });
    const text = r.content[0]?.text || '';
    try {
      const parsed = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
      return parsed;
    } catch {
      return { text, booking: null };
    }
  } catch (e) {
    console.warn('Channel reply generation failed:', e.message);
    return null;
  }
}
```

- [ ] **Step 4: Add `trackChannelReply` stats function**

```js
function trackChannelReply(ownerEmail, channel) {
  const stats = channelStats.get(ownerEmail) || {
    whatsapp: { replied: 0, week: 0, lastReply: null },
    instagram: { replied: 0, week: 0, lastReply: null },
    facebook: { replied: 0, week: 0, lastReply: null },
    total: 0,
  };
  if (!stats[channel]) stats[channel] = { replied: 0, week: 0, lastReply: null };
  stats[channel].replied++;
  stats[channel].week++;
  stats[channel].lastReply = new Date().toISOString();
  stats.total++;
  channelStats.set(ownerEmail, stats);
  persistChannelStats();
}
```

- [ ] **Step 5: Verify server starts**

Run: `cd /Users/kyleairey/chatbot && node server.js`
Expected: Starts without errors.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: add channel message processing and Claude reply generation"
```

---

### Task 4: Send Functions Per Channel

**Files:**
- Modify: `server.js` (add send functions near the other send helpers, after `smartSend` around line ~236)

- [ ] **Step 1: Add `sendChannelReply` router function**

```js
// ─── Multi-Channel Send ─────────────��───────────────────────────────────────
async function sendChannelReply(channel, channelConfig, recipientId, text) {
  try {
    if (channel === 'whatsapp') return await sendWhatsAppMessage(channelConfig, recipientId, text);
    if (channel === 'instagram') return await sendInstagramMessage(channelConfig, recipientId, text);
    if (channel === 'facebook') return await sendFacebookMessage(channelConfig, recipientId, text);
    return false;
  } catch (e) {
    console.warn(`📱 [${channel}] Send failed:`, e.message);
    return false;
  }
}
```

- [ ] **Step 2: Add WhatsApp send function**

```js
async function sendWhatsAppMessage(config, recipientPhone, text) {
  const r = await fetch(`https://graph.facebook.com/v21.0/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: recipientPhone,
      type: 'text',
      text: { body: text },
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    console.warn('WhatsApp send error:', err);
    return false;
  }
  return true;
}
```

- [ ] **Step 3: Add Instagram send function**

```js
async function sendInstagramMessage(config, recipientId, text) {
  const r = await fetch(`https://graph.facebook.com/v21.0/${config.igUserId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    console.warn('Instagram send error:', err);
    return false;
  }
  return true;
}
```

- [ ] **Step 4: Add Facebook Messenger send function**

```js
async function sendFacebookMessage(config, recipientId, text) {
  const r = await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${config.accessToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_type: 'RESPONSE',
      recipient: { id: recipientId },
      message: { text },
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    console.warn('Facebook send error:', err);
    return false;
  }
  return true;
}
```

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: add WhatsApp, Instagram, Facebook send functions"
```

---

### Task 5: Channel Approval Endpoints

**Files:**
- Modify: `server.js` (add approve/reject endpoints near the email approval endpoints)

- [ ] **Step 1: Add channel approve and reject endpoints**

Insert near the Meta webhook code:

```js
// ─── Channel Approval ─────────────────────────────────────��──────────────────
app.get('/api/channel/approve', async (req, res) => {
  const { id } = req.query;
  const approval = channelApprovals.get(id);
  if (!approval) {
    return res.send('<html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>Expired or already handled</h2></body></html>');
  }

  const { ownerEmail, channel, senderId, draftReply, booking } = approval;
  const ownerChannels = channelConfigs.get(ownerEmail);
  const channelConfig = ownerChannels?.[channel];

  if (!channelConfig) {
    return res.send('<html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>Channel no longer connected</h2></body></html>');
  }

  const sent = await sendChannelReply(channel, channelConfig, senderId, draftReply);

  channelApprovals.delete(id);
  persistChannelApprovals();

  if (sent) {
    // Log and track
    const msgs = channelMessages.get(ownerEmail) || [];
    msgs.push({
      id: crypto.randomUUID(), channel, senderId, senderName: approval.senderName,
      message: approval.messageText, reply: draftReply,
      timestamp: new Date().toISOString(), status: 'sent',
    });
    channelMessages.set(ownerEmail, msgs);
    persistChannelMessages();
    trackChannelReply(ownerEmail, channel);

    if (booking) {
      bookings.push({ ...booking, channel, ownerEmail, ts: new Date().toISOString() });
      save('bookings', bookings);
    }

    // Save to conversation memory
    const memKey = `${ownerEmail}::${channel}::${senderId}`;
    const history = conversationMemory.get(memKey) || [];
    history.push({ role: 'us', preview: draftReply.substring(0, 300), date: new Date().toISOString() });
    conversationMemory.set(memKey, history);
    persistConversationMemory();
  }

  res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#0d0d1f;color:#eee;">
    <h2 style="color:#00e5a0;">${sent ? '✓ Reply sent!' : '✗ Failed to send'}</h2>
    <p style="color:#9898b8;">You can close this tab.</p>
  </body></html>`);
});

app.get('/api/channel/reject', (req, res) => {
  const { id } = req.query;
  channelApprovals.delete(id);
  persistChannelApprovals();
  res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#0d0d1f;color:#eee;">
    <h2 style="color:#ff6b6b;">✗ Reply discarded</h2>
    <p style="color:#9898b8;">You can close this tab.</p>
  </body></html>`);
});
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: add channel message approval/reject endpoints"
```

---

### Task 6: Meta OAuth Flow

**Files:**
- Modify: `server.js` (add OAuth routes near the existing Gmail OAuth routes, around line ~2930)

- [ ] **Step 1: Add `/auth/meta/start` endpoint**

Insert after the Meta webhook code:

```js
// ─── Meta OAuth (Facebook Login) ────────────────────────���────────────────────
app.get('/auth/meta/start', (req, res) => {
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) {
    return res.send('<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#0d0d1f;color:#eee;"><h2>Meta app not configured</h2></body></html>');
  }
  const ownerEmail = req.query.owner || '';
  const sessionToken = req.query.s || '';
  if (!ownerEmail || !validateSession(sessionToken, ownerEmail)) {
    return res.redirect('/dashboard?owner=' + encodeURIComponent(ownerEmail));
  }

  const redirectUri = (process.env.GOOGLE_REDIRECT_URI?.replace('/auth/gmail/callback', '') || `http://localhost:${process.env.PORT || 3000}`) + '/auth/meta/callback';
  const state = JSON.stringify({ owner: ownerEmail, s: sessionToken });
  const scopes = [
    'pages_show_list', 'pages_messaging',
    'instagram_basic', 'instagram_manage_messages',
    'whatsapp_business_management', 'whatsapp_business_messaging',
    'business_management',
  ].join(',');

  const url = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${process.env.META_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(scopes)}&response_type=code`;
  res.redirect(url);
});
```

- [ ] **Step 2: Add `/auth/meta/callback` endpoint**

```js
app.get('/auth/meta/callback', async (req, res) => {
  const { code, state } = req.query;
  let ownerEmail = '', sessionToken = '';
  try {
    const parsed = JSON.parse(state);
    ownerEmail = parsed.owner;
    sessionToken = parsed.s;
  } catch {}

  if (!code || !ownerEmail) {
    return res.send('<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#0d0d1f;color:#eee;"><h2>Connection failed</h2><p style="color:#9898b8">Missing authorization code.</p></body></html>');
  }

  const redirectUri = (process.env.GOOGLE_REDIRECT_URI?.replace('/auth/gmail/callback', '') || `http://localhost:${process.env.PORT || 3000}`) + '/auth/meta/callback';

  try {
    // Exchange code for short-lived user token
    const tokenUrl = `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${process.env.META_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${process.env.META_APP_SECRET}&code=${code}`;
    const tokenRes = await fetch(tokenUrl);
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error.message);

    // Exchange for long-lived token (60 days)
    const longUrl = `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&fb_exchange_token=${tokenData.access_token}`;
    const longRes = await fetch(longUrl);
    const longData = await longRes.json();
    if (longData.error) throw new Error(longData.error.message);

    const userToken = longData.access_token;
    const expiresIn = longData.expires_in || 5184000; // ~60 days

    // Fetch pages the user manages
    const pagesRes = await fetch(`https://graph.facebook.com/v21.0/me/accounts?access_token=${userToken}&fields=id,name,access_token,instagram_business_account{id,username}`);
    const pagesData = await pagesRes.json();
    if (pagesData.error) throw new Error(pagesData.error.message);

    const pages = (pagesData.data || []).map(p => ({
      pageId: p.id,
      pageName: p.name,
      accessToken: p.access_token, // non-expiring page token
      igUserId: p.instagram_business_account?.id || null,
      igUsername: p.instagram_business_account?.username || null,
      wabaId: null,
      waPhoneNumberId: null,
      waDisplayPhone: null,
    }));

    // Check for WhatsApp Business accounts
    const wabaRes = await fetch(`https://graph.facebook.com/v21.0/me/businesses?access_token=${userToken}&fields=id,name,owned_whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number}}`);
    const wabaData = await wabaRes.json();

    if (wabaData.data) {
      for (const biz of wabaData.data) {
        const wabas = biz.owned_whatsapp_business_accounts?.data || [];
        for (const waba of wabas) {
          const phones = waba.phone_numbers?.data || [];
          if (phones.length > 0) {
            // Attach WA info to the first page (or create a virtual entry)
            const target = pages[0] || { pageId: null, pageName: biz.name, accessToken: userToken };
            target.wabaId = waba.id;
            target.waPhoneNumberId = phones[0].id;
            target.waDisplayPhone = phones[0].display_phone_number;
            if (!pages.length) pages.push(target);
          }
        }
      }
    }

    // Store tokens
    metaTokens.set(ownerEmail, {
      userToken,
      userTokenExpiry: Date.now() + expiresIn * 1000,
      pages,
    });
    persistMetaTokens();

    // Update channelConfigs with available channels
    const existing = channelConfigs.get(ownerEmail) || {};
    const page = pages[0]; // use first page
    if (page) {
      if (page.pageId) {
        existing.facebook = {
          enabled: existing.facebook?.enabled ?? true,
          pageId: page.pageId,
          pageName: page.pageName,
          accessToken: page.accessToken,
          connectedAt: new Date().toISOString(),
        };

        // Subscribe page to webhook
        try {
          await fetch(`https://graph.facebook.com/v21.0/${page.pageId}/subscribed_apps?access_token=${page.accessToken}&subscribed_fields=messages,messaging_postbacks`, { method: 'POST' });
          console.log(`📱 Subscribed page ${page.pageName} to webhook`);
        } catch (e) { console.warn('Page subscription failed:', e.message); }
      }
      if (page.igUserId) {
        existing.instagram = {
          enabled: existing.instagram?.enabled ?? true,
          igUserId: page.igUserId,
          igUsername: page.igUsername,
          accessToken: page.accessToken,
          connectedAt: new Date().toISOString(),
        };
      }
      if (page.waPhoneNumberId) {
        existing.whatsapp = {
          enabled: existing.whatsapp?.enabled ?? true,
          phoneNumberId: page.waPhoneNumberId,
          wabaId: page.wabaId,
          accessToken: userToken, // WA uses user token, not page token
          displayPhone: page.waDisplayPhone,
          connectedAt: new Date().toISOString(),
        };

        // Register WA phone for webhooks
        try {
          await fetch(`https://graph.facebook.com/v21.0/${page.wabaId}/subscribed_apps`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${userToken}` },
          });
          console.log(`📱 Subscribed WhatsApp ${page.waDisplayPhone} to webhook`);
        } catch (e) { console.warn('WA subscription failed:', e.message); }
      }
    }
    channelConfigs.set(ownerEmail, existing);
    persistChannels();

    console.log(`📱 Meta connected for ${ownerEmail}: ${pages.length} page(s), FB=${!!page?.pageId}, IG=${!!page?.igUserId}, WA=${!!page?.waPhoneNumberId}`);

    // Redirect back to dashboard
    res.redirect(`/dashboard?owner=${encodeURIComponent(ownerEmail)}&s=${encodeURIComponent(sessionToken)}&meta_connected=1`);

  } catch (e) {
    console.error('Meta OAuth error:', e.message);
    res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#0d0d1f;color:#eee;">
      <h2 style="color:#ff6b6b;">Connection failed</h2>
      <p style="color:#9898b8;">${e.message}</p>
      <a href="/dashboard?owner=${encodeURIComponent(ownerEmail)}&s=${encodeURIComponent(sessionToken)}" style="color:#00e5a0;">Back to Dashboard</a>
    </body></html>`);
  }
});
```

- [ ] **Step 3: Verify server starts**

Run: `cd /Users/kyleairey/chatbot && node server.js`
Expected: Starts without errors.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add Meta OAuth flow for client channel connection"
```

---

### Task 7: Dashboard API Endpoints

**Files:**
- Modify: `server.js` (add endpoints near the existing dashboard API at line ~6698)

- [ ] **Step 1: Add `/api/dashboard/messages` endpoint**

Insert after the existing dashboard API endpoints (after `/api/dashboard/channels` at line ~6881):

```js
// GET /api/dashboard/messages — paginated channel message feed
app.get('/api/dashboard/messages', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const channel = req.query.channel || 'all';
  const page = parseInt(req.query.page) || 1;
  const perPage = 10;

  let msgs = channelMessages.get(owner) || [];
  if (channel !== 'all') msgs = msgs.filter(m => m.channel === channel);
  msgs = msgs.slice().reverse(); // newest first

  const totalPages = Math.ceil(msgs.length / perPage);
  const items = msgs.slice((page - 1) * perPage, page * perPage);
  res.json({ items, page, totalPages, total: msgs.length });
});

// GET /api/dashboard/channel-stats
app.get('/api/dashboard/channel-stats', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const stats = channelStats.get(owner) || {
    whatsapp: { replied: 0, week: 0, lastReply: null },
    instagram: { replied: 0, week: 0, lastReply: null },
    facebook: { replied: 0, week: 0, lastReply: null },
    total: 0,
  };
  const channels = channelConfigs.get(owner) || {};
  res.json({ stats, channels });
});

// POST /api/dashboard/channel-toggle — enable/disable a channel
app.post('/api/dashboard/channel-toggle', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const { channel, enabled } = req.body;
  if (!channel || typeof enabled !== 'boolean') return res.status(400).json({ error: 'channel and enabled required' });

  const existing = channelConfigs.get(owner) || {};
  if (!existing[channel]) return res.status(400).json({ error: 'Channel not connected' });
  existing[channel].enabled = enabled;
  channelConfigs.set(owner, existing);
  persistChannels();
  res.json({ ok: true });
});

// POST /api/dashboard/channel-disconnect — remove a channel
app.post('/api/dashboard/channel-disconnect', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const { channel } = req.body;
  if (!channel) return res.status(400).json({ error: 'channel required' });

  const existing = channelConfigs.get(owner) || {};
  delete existing[channel];
  channelConfigs.set(owner, existing);
  persistChannels();
  res.json({ ok: true });
});
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: add dashboard API endpoints for channel messages, stats, toggle"
```

---

### Task 8: Dashboard UI — Channels Section

**Files:**
- Modify: `server.js:7095-7151` (replace the placeholder channels section in the `/dashboard` HTML)

- [ ] **Step 1: Replace the channels section HTML in the dashboard**

Find the existing channels section (lines 7095-7151) and replace it with:

```html
  <div class="section" id="sec-channels">
    <div class="section-header" onclick="toggleSection('channels')">
      <h3>&#x1F4F1; Channels</h3>
      <span class="arrow">&#x25B6;</span>
    </div>
    <div class="section-body" id="body-channels">
      <div style="padding:16px 20px;">
        <p style="font-size:13px;color:#9898b8;margin-bottom:16px;">Connect your social accounts so Aria can auto-reply to messages.</p>

        <a href="/auth/meta/start?owner=\${encodeURIComponent(OWNER)}&s=\${encodeURIComponent(TOKEN)}" id="meta-connect-btn" style="display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:13px;background:#1877F2;color:#fff;border:none;border-radius:12px;font-size:14px;font-weight:600;text-decoration:none;margin-bottom:20px;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
          Connect with Facebook
        </a>

        <div id="channel-cards" style="display:flex;flex-direction:column;gap:12px;"></div>
      </div>
    </div>
  </div>
```

- [ ] **Step 2: Replace the `loadChannels` function in the dashboard script**

Find the existing `loadChannels()` function and its `connectChannel()` companion (lines 7410-7453) and replace with:

```js
async function loadChannels() {
  try {
    const d = await api('/api/dashboard/channel-stats');
    const channels = d.channels || {};
    const stats = d.stats || {};
    const container = document.getElementById('channel-cards');
    if (!container) return;

    const channelDefs = [
      { key: 'whatsapp', name: 'WhatsApp Business', icon: '&#x1F4AC;', color: '#25D366', detail: c => c.displayPhone || 'Connected' },
      { key: 'instagram', name: 'Instagram DMs', icon: '&#x1F4F7;', color: '#E1306C', detail: c => c.igUsername || 'Connected' },
      { key: 'facebook', name: 'Facebook Messenger', icon: '&#x1F4AC;', color: '#1877F2', detail: c => c.pageName || 'Connected' },
    ];

    let html = '';
    let anyConnected = false;
    for (const def of channelDefs) {
      const ch = channels[def.key];
      const st = stats[def.key] || { replied: 0 };
      if (ch && ch.accessToken) {
        anyConnected = true;
        const statusColor = ch.enabled ? '#00e5a0' : '#ff6b6b';
        const statusText = ch.enabled ? 'Active' : 'Paused';
        html += '<div style="background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;display:flex;align-items:center;justify-content:space-between;">' +
          '<div style="display:flex;align-items:center;gap:12px;">' +
            '<span style="font-size:24px;">' + def.icon + '</span>' +
            '<div><div style="font-weight:600;font-size:14px;">' + def.name + '</div>' +
            '<div style="font-size:12px;color:' + statusColor + ';">' + statusText + ' &middot; ' + escH(def.detail(ch)) + '</div>' +
            '<div style="font-size:11px;color:#6b6b8a;margin-top:2px;">' + st.replied + ' replies</div></div>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:8px;">' +
            '<label class="toggle" style="width:44px;height:24px;"><input type="checkbox" ' + (ch.enabled ? 'checked' : '') + ' onchange="toggleChannel(\\'' + def.key + '\\',this.checked)"><span class="slider"></span></label>' +
            '<button onclick="disconnectChannel(\\'' + def.key + '\\')" style="background:rgba(255,80,80,0.1);color:#ff6b6b;border:1px solid rgba(255,80,80,0.2);border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;font-family:inherit;">Disconnect</button>' +
          '</div>' +
        '</div>';
      } else {
        html += '<div style="background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;display:flex;align-items:center;justify-content:space-between;opacity:0.5;">' +
          '<div style="display:flex;align-items:center;gap:12px;">' +
            '<span style="font-size:24px;">' + def.icon + '</span>' +
            '<div><div style="font-weight:600;font-size:14px;">' + def.name + '</div>' +
            '<div style="font-size:12px;color:#6b6b8a;">Not connected</div></div>' +
          '</div>' +
        '</div>';
      }
    }
    container.innerHTML = html;

    // Hide connect button if already connected
    if (anyConnected) {
      const btn = document.getElementById('meta-connect-btn');
      if (btn) { btn.textContent = 'Reconnect / Add Channels'; btn.style.background = 'rgba(24,119,242,0.15)'; btn.style.color = '#1877F2'; btn.style.border = '1px solid rgba(24,119,242,0.3)'; }
    }
  } catch (e) { console.warn('Failed to load channels:', e); }
}

async function toggleChannel(channel, enabled) {
  try {
    const r = await apiPost('/api/dashboard/channel-toggle', { owner: OWNER, channel, enabled });
    if (r.ok) toast(channel + (enabled ? ' enabled' : ' paused'));
    loadChannels();
  } catch (e) { toast('Error updating channel'); }
}

async function disconnectChannel(channel) {
  if (!confirm('Disconnect ' + channel + '? Aria will stop replying on this channel.')) return;
  try {
    const r = await apiPost('/api/dashboard/channel-disconnect', { owner: OWNER, channel });
    if (r.ok) toast(channel + ' disconnected');
    loadChannels();
  } catch (e) { toast('Error disconnecting'); }
}

loadChannels();
```

- [ ] **Step 3: Verify server starts and serve the dashboard**

Run: `cd /Users/kyleairey/chatbot && node server.js`
Open: `http://localhost:3000/dashboard?owner=test@example.com&s=<token>`
Expected: Channels section shows "Connect with Facebook" button and 3 channel cards (all "Not connected").

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: update dashboard channels UI with real Meta OAuth connection"
```

---

### Task 9: Dashboard UI — Messages Section

**Files:**
- Modify: `server.js` (add new collapsible section in the dashboard HTML, after the Channels section)

- [ ] **Step 1: Add Messages section HTML after the Channels section in the dashboard**

Insert after `</div>` closing `sec-channels` (the closing tag before the toast div):

```html
  <!-- Channel Messages -->
  <div class="section" id="sec-messages">
    <div class="section-header" onclick="toggleSection('messages')">
      <h3>&#x1F4AC; Messages</h3>
      <span class="arrow">&#x25B6;</span>
    </div>
    <div class="section-body" id="body-messages">
      <div style="display:flex;gap:8px;margin-bottom:12px;">
        <button onclick="loadMessages(1,'all')" class="msg-filter active" style="background:rgba(0,229,160,0.15);color:#00e5a0;border:1px solid rgba(0,229,160,0.3);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:inherit;">All</button>
        <button onclick="loadMessages(1,'whatsapp')" class="msg-filter" style="background:rgba(255,255,255,0.06);color:#ccc;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:inherit;">WhatsApp</button>
        <button onclick="loadMessages(1,'instagram')" class="msg-filter" style="background:rgba(255,255,255,0.06);color:#ccc;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:inherit;">Instagram</button>
        <button onclick="loadMessages(1,'facebook')" class="msg-filter" style="background:rgba(255,255,255,0.06);color:#ccc;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:inherit;">Messenger</button>
      </div>
      <div id="messages-list"><div class="empty">Loading...</div></div>
    </div>
  </div>
```

- [ ] **Step 2: Add `loadMessages` function to the dashboard script**

```js
let msgChannel = 'all';
async function loadMessages(page, channel) {
  if (channel) msgChannel = channel;
  // Update filter button styles
  document.querySelectorAll('.msg-filter').forEach((btn, i) => {
    const channels = ['all','whatsapp','instagram','facebook'];
    if (channels[i] === msgChannel) {
      btn.style.background = 'rgba(0,229,160,0.15)';
      btn.style.color = '#00e5a0';
      btn.style.borderColor = 'rgba(0,229,160,0.3)';
    } else {
      btn.style.background = 'rgba(255,255,255,0.06)';
      btn.style.color = '#ccc';
      btn.style.borderColor = 'rgba(255,255,255,0.1)';
    }
  });

  const container = document.getElementById('messages-list');
  try {
    const d = await api('/api/dashboard/messages?channel=' + msgChannel + '&page=' + page);
    if (!d.items || !d.items.length) {
      container.innerHTML = '<div class="empty">No messages yet.</div>';
      return;
    }
    const icons = { whatsapp: '&#x1F4AC;', instagram: '&#x1F4F7;', facebook: '&#x1F4AC;' };
    let html = '<table><thead><tr><th></th><th>From</th><th>Message</th><th>Reply</th><th>When</th></tr></thead><tbody>';
    for (const m of d.items) {
      html += '<tr>' +
        '<td>' + (icons[m.channel] || '') + '</td>' +
        '<td>' + escH(m.senderName || m.senderId) + '</td>' +
        '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escH((m.message || '').substring(0, 80)) + '</td>' +
        '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escH((m.reply || '').substring(0, 80)) + '</td>' +
        '<td>' + timeAgo(m.timestamp) + '</td>' +
      '</tr>';
    }
    html += '</tbody></table>';
    if (d.totalPages > 1) {
      html += '<div class="pagination">';
      for (let i = 1; i <= d.totalPages; i++) {
        html += '<button class="' + (i === page ? 'active' : '') + '" onclick="loadMessages(' + i + ')">' + i + '</button>';
      }
      html += '</div>';
    }
    container.innerHTML = html;
  } catch (e) { container.innerHTML = '<div class="empty">Failed to load messages.</div>'; }
}
```

- [ ] **Step 3: Register the messages section in `loadSection`**

Update the `loadSection` function to handle the new section:

```js
async function loadSection(name) {
  if (name === 'inbox') await loadInbox(1);
  else if (name === 'leads') await loadLeads();
  else if (name === 'bookings') await loadBookings();
  else if (name === 'profile') await loadProfile();
  else if (name === 'settings') await loadSettings();
  else if (name === 'messages') await loadMessages(1, 'all');
}
```

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add Messages section to client dashboard with channel filtering"
```

---

### Task 10: Dashboard Stats Update

**Files:**
- Modify: `server.js:7196-7223` (update `loadStats` function in the dashboard)

- [ ] **Step 1: Update `loadStats` to include channel message count**

Replace the `loadStats` function:

```js
async function loadStats() {
  try {
    const [d, ch] = await Promise.all([
      api('/api/dashboard/stats'),
      api('/api/dashboard/channel-stats'),
    ]);
    const chTotal = ch.stats?.total || 0;
    const connected = ['whatsapp','instagram','facebook'].filter(c => ch.channels?.[c]?.accessToken).length;
    document.getElementById('stats-row').innerHTML = \`
      <div class="stat-card">
        <div class="value">\${d.emailsReplied.total}</div>
        <div class="label">Emails Replied</div>
        <div class="sub">\${d.emailsReplied.week} this week</div>
      </div>
      <div class="stat-card">
        <div class="value">\${chTotal}</div>
        <div class="label">Messages Replied</div>
        <div class="sub">across \${connected} channel\${connected !== 1 ? 's' : ''}</div>
      </div>
      <div class="stat-card">
        <div class="value">\${d.leads.total}</div>
        <div class="label">Leads</div>
        <div class="sub">\${d.leads.hot} hot, \${d.leads.warm} warm</div>
      </div>
      <div class="stat-card">
        <div class="value">\${d.bookings.total}</div>
        <div class="label">Bookings</div>
        <div class="sub">\${d.bookings.week} this week</div>
      </div>
      <div class="stat-card \${d.autoReplyEnabled ? 'status-on' : 'status-off'}">
        <div class="value">\${d.autoReplyEnabled ? 'ON' : 'OFF'}</div>
        <div class="label">Auto-Reply</div>
        <div class="sub">\${d.gmailConnected ? '<span class="badge-on">Gmail connected</span>' : '<span class="badge-off">Gmail not connected</span>'}</div>
      </div>
    \`;
  } catch (e) {
    document.getElementById('stats-row').innerHTML = '<div class="stat-card"><div class="value">!</div><div class="label">Failed to load stats</div></div>';
  }
}
loadStats();
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: add channel message stats to dashboard overview"
```

---

### Task 11: Token Refresh Job

**Files:**
- Modify: `server.js` (add interval near the existing digest/weekly intervals at line ~7462)

- [ ] **Step 1: Add daily token refresh interval**

Insert after the weekly report interval:

```js
// ─── Meta Token Refresh (daily) ──────────���───────────────────────────────────
let lastTokenRefreshDay = null;
setInterval(async () => {
  const now = new Date();
  if (now.getHours() !== 3 || lastTokenRefreshDay === now.toDateString()) return; // run at 3am
  lastTokenRefreshDay = now.toDateString();

  for (const [ownerEmail, tokens] of metaTokens) {
    const daysUntilExpiry = (tokens.userTokenExpiry - Date.now()) / (24 * 60 * 60 * 1000);
    if (daysUntilExpiry > 7) continue; // still fresh

    console.log(`🔄 Refreshing Meta token for ${ownerEmail} (expires in ${Math.floor(daysUntilExpiry)} days)`);
    try {
      const url = `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&fb_exchange_token=${tokens.userToken}`;
      const r = await fetch(url);
      const data = await r.json();
      if (data.error) throw new Error(data.error.message);

      tokens.userToken = data.access_token;
      tokens.userTokenExpiry = Date.now() + (data.expires_in || 5184000) * 1000;
      metaTokens.set(ownerEmail, tokens);
      persistMetaTokens();

      // Also refresh WhatsApp config if it uses the user token
      const chConfig = channelConfigs.get(ownerEmail);
      if (chConfig?.whatsapp?.accessToken) {
        chConfig.whatsapp.accessToken = data.access_token;
        channelConfigs.set(ownerEmail, chConfig);
        persistChannels();
      }

      console.log(`✅ Refreshed Meta token for ${ownerEmail}`);
    } catch (e) {
      console.warn(`❌ Failed to refresh Meta token for ${ownerEmail}:`, e.message);
      // Alert Kyle
      await sendEmail({
        to: process.env.NOTIFY_EMAIL,
        subject: `⚠️ Meta token refresh failed for ${ownerEmail}`,
        html: `<p>The Meta token for <strong>${ownerEmail}</strong> failed to refresh: ${e.message}</p><p>They may need to reconnect via the dashboard.</p>`,
      });
    }
  }
}, 60_000);
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: add daily Meta token refresh with expiry alerting"
```

---

### Task 12: Update Startup Log & Environment Validation

**Files:**
- Modify: `server.js:7596` (the `app.listen` startup line)

- [ ] **Step 1: Update the startup log to show Meta status**

Replace the `app.listen` line:

```js
app.listen(PORT, () => {
  const meta = process.env.META_APP_ID ? '✅' : '❌';
  console.log(`\n  ✦ Aria Chatbot Server v5.2`);
  console.log(`  → Admin: http://localhost:${PORT}/admin?pass=${ADMIN}`);
  console.log(`  → Health: http://localhost:${PORT}/health`);
  console.log(`  → Meta channels: ${meta} (${metaTokens.size} connected accounts)`);
  console.log('');
});
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: update startup log with Meta channel status"
```

---

### Task 13: Final Integration Test

- [ ] **Step 1: Start the server locally**

Run: `cd /Users/kyleairey/chatbot && node server.js`
Expected: Server starts, shows Meta channels status.

- [ ] **Step 2: Test webhook verification endpoint**

Run: `curl "http://localhost:3000/api/meta/webhook?hub.mode=subscribe&hub.verify_token=test&hub.challenge=test123"`
Expected: `403 Forbidden` (wrong token). Set `META_VERIFY_TOKEN=test` in `.env` and restart, then same curl should return `test123`.

- [ ] **Step 3: Test dashboard loads with new sections**

Set up a test session and open dashboard. Verify:
- Stats row has 5 cards including "Messages Replied"
- Channels section shows "Connect with Facebook" button and 3 channel cards
- Messages section shows with filter tabs (All / WhatsApp / Instagram / Messenger)

- [ ] **Step 4: Test API endpoints return correct structure**

Run:
```bash
curl "http://localhost:3000/api/dashboard/channel-stats?owner=test@example.com&s=<token>"
curl "http://localhost:3000/api/dashboard/messages?owner=test@example.com&s=<token>&channel=all&page=1"
```
Expected: JSON responses with correct structure (empty data is fine).

- [ ] **Step 5: Final commit with version bump**

Update the server comment header from `v5.1` to `v5.2`:

```bash
git add server.js
git commit -m "feat: Aria v5.2 — multi-channel messaging (WhatsApp, Instagram, Messenger)"
```
