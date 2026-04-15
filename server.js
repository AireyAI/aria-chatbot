/**
 * Aria Chatbot Server — v5.1
 *
 * Env vars:
 *   ANTHROPIC_API_KEY      required
 *   ADMIN_PASS             default: aria-admin
 *   NOTIFY_EMAIL           owner alert email
 *   SMTP_HOST/PORT/USER/PASS/FROM  nodemailer config
 *   SLACK_WEBHOOK          Slack incoming webhook URL
 *   SHOPIFY_STORE          e.g. mystore.myshopify.com
 *   SHOPIFY_TOKEN          Shopify Admin API token
 *   SHOPIFY_WEBHOOK_SECRET Shopify webhook signing secret (from webhook settings)
 *   CJ_EMAIL               CJ Dropshipping account email
 *   CJ_API_KEY             CJ Dropshipping API key (from CJ developer dashboard)
 *   MAILCHIMP_API_KEY      e.g. abc123-us1
 *   MAILCHIMP_LIST_ID      audience/list ID
 *   DIGEST_HOUR            hour for daily digest (default 8)
 *   PORT                   default 3000
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, join } from 'path';

// Load .env file manually (no extra package needed)
try {
  const env = readFileSync(resolve('.env'), 'utf8');
  env.split('\n').forEach(line => {
    const clean = line.trim();
    if (!clean || clean.startsWith('#')) return;
    const idx = clean.indexOf('=');
    if (idx < 0) return;
    const key = clean.slice(0, idx).trim();
    const val = clean.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !process.env[key]) process.env[key] = val;
  });
} catch {}

import express    from 'express';
import Anthropic  from '@anthropic-ai/sdk';
import cors       from 'cors';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import crypto     from 'crypto';

const app    = express();
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const ADMIN  = process.env.ADMIN_PASS || 'aria-admin';

// ─── Middleware ───────────────────────────────────────────────────────────────
const corsOpts = { origin: '*', methods: ['GET','POST','DELETE','PUT','OPTIONS','PATCH'] };
app.use(cors(corsOpts));
app.options('*', cors(corsOpts));
// Raw body capture for Shopify webhook HMAC verification — must run before express.json()
app.use('/api/shopify/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use('/chatbot.js', (req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.use(express.static('.'));

// ─── Email ────────────────────────────────────────────────────────────────────
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER) {
  mailer = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: +( process.env.SMTP_PORT||587), secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  mailer.verify().then(() => console.log('✉️  Email ready')).catch(e => console.warn('Email:', e.message));
}
const sendEmail = async ({ to, subject, html, replyTo }) => {
  if (!mailer || !to) return;
  const opts = { from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, html };
  if (replyTo) opts.replyTo = replyTo;
  try { await mailer.sendMail(opts); }
  catch (e) { console.warn('Email fail:', e.message); }
};

// Helper: resolve which email address to alert (per-site owner OR global fallback)
const ownerTo = (req_ownerEmail) => req_ownerEmail || process.env.NOTIFY_EMAIL;

// ─── Gmail OAuth2 ─────────────────────────────────────────────────────────────
// Stores connected owner Gmail accounts: email → { tokens, gmail client }
const gmailTokens = new Map();

function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/gmail/callback'
  );
}

function getAuthUrl(ownerEmail) {
  const client = makeOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/calendar',
    ],
    state: ownerEmail || '',
  });
}

const TOKEN_FILE = resolve('data/gmail-tokens.json');
const AUTOREPLY_FILE = resolve('data/email-autoreply.json');

// Load saved tokens on startup
function loadSavedTokens() {
  try {
    if (existsSync(TOKEN_FILE)) {
      const saved = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
      for (const [email, tokens] of Object.entries(saved)) {
        const auth = makeOAuthClient();
        auth.setCredentials(tokens);
        auth.on('tokens', (newTokens) => {
          const merged = { ...tokens, ...newTokens };
          auth.setCredentials(merged);
          gmailTokens.set(email, { auth, tokens: merged });
          persistTokens();
          console.log(`🔄 Refreshed Gmail tokens for ${email}`);
        });
        gmailTokens.set(email, { auth, tokens });
        console.log(`✉️  Restored Gmail connection for ${email}`);
      }
    }
  } catch (e) { console.warn('Failed to load saved tokens:', e.message); }
}

// Load saved auto-reply configs on startup
function loadSavedAutoReply() {
  try {
    if (existsSync(AUTOREPLY_FILE)) {
      const saved = JSON.parse(readFileSync(AUTOREPLY_FILE, 'utf8'));
      for (const [email, config] of Object.entries(saved)) {
        EMAIL_AUTO_REPLY_ENABLED.set(email, config);
        console.log(`📧 Restored auto-reply for ${email}`);
      }
    }
  } catch (e) { console.warn('Failed to load auto-reply config:', e.message); }
}

function persistTokens() {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    const obj = {};
    for (const [email, { tokens }] of gmailTokens) obj[email] = tokens;
    writeFileSync(TOKEN_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.warn('Failed to persist tokens:', e.message); }
}

function persistAutoReply() {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    const obj = {};
    for (const [email, config] of EMAIL_AUTO_REPLY_ENABLED) obj[email] = config;
    writeFileSync(AUTOREPLY_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.warn('Failed to persist auto-reply config:', e.message); }
}

async function saveGmailTokens(ownerEmail, tokens) {
  const auth = makeOAuthClient();
  auth.setCredentials(tokens);
  // Auto-refresh tokens when they expire
  auth.on('tokens', (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    auth.setCredentials(merged);
    gmailTokens.set(ownerEmail, { auth, tokens: merged });
    persistTokens();
    console.log(`🔄 Refreshed Gmail tokens for ${ownerEmail}`);
  });
  gmailTokens.set(ownerEmail, { auth, tokens });
  persistTokens();
  console.log(`✉️  Gmail connected for ${ownerEmail}`);
}

// Send an email using the owner's connected Gmail account
async function sendViaGmail(ownerEmail, { to, subject, html, replyTo }) {
  const entry = gmailTokens.get(ownerEmail);
  if (!entry) return false;
  try {
    // Refresh token if needed
    const { auth } = entry;
    const gmail = google.gmail({ version: 'v1', auth });

    // Build RFC 2822 message
    const lines = [
      `From: ${ownerEmail}`,
      `To: ${to}`,
      replyTo ? `Reply-To: ${replyTo}` : '',
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      html,
    ].filter(Boolean).join('\r\n');

    const encoded = Buffer.from(lines).toString('base64url');
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
    return true;
  } catch (e) {
    console.warn(`Gmail send failed for ${ownerEmail}:`, e.message);
    return false;
  }
}

// Smart send: use owner's Gmail if connected, otherwise fall back to server SMTP
async function smartSend({ ownerEmail, to, subject, html, replyTo }) {
  if (ownerEmail && gmailTokens.has(ownerEmail)) {
    const sent = await sendViaGmail(ownerEmail, { to, subject, html, replyTo });
    if (sent) return;
  }
  // Fallback to server SMTP
  await sendEmail({ to, subject, html, replyTo });
}

// ─── Email Auto-Reply ────────────────────────────────────────────────────────
// Polls connected Gmail inboxes and auto-replies using Claude + the business prompt

const REPLIED_FILE = resolve('data/replied-emails.json');
const repliedEmails = new Set();       // track message IDs we've already replied to

// Load replied emails from disk on startup
function loadRepliedEmails() {
  try {
    if (existsSync(REPLIED_FILE)) {
      const saved = JSON.parse(readFileSync(REPLIED_FILE, 'utf8'));
      for (const id of saved) repliedEmails.add(id);
      console.log(`📧 Restored ${repliedEmails.size} replied email IDs`);
    }
  } catch (e) { console.warn('Failed to load replied emails:', e.message); }
}

function persistRepliedEmails() {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    // Only keep the last 500 IDs to prevent file bloat
    const ids = [...repliedEmails].slice(-500);
    writeFileSync(REPLIED_FILE, JSON.stringify(ids));
  } catch (e) { console.warn('Failed to persist replied emails:', e.message); }
}
const EMAIL_POLL_INTERVAL = 3 * 60 * 1000; // check every 3 minutes
const EMAIL_AUTO_REPLY_ENABLED = new Map(); // ownerEmail → { enabled, systemPrompt }

function enableEmailAutoReply(ownerEmail, systemPrompt) {
  EMAIL_AUTO_REPLY_ENABLED.set(ownerEmail, { enabled: true, systemPrompt });
  persistAutoReply();
  console.log(`📧 Auto-reply enabled for ${ownerEmail}`);
}

function disableEmailAutoReply(ownerEmail) {
  EMAIL_AUTO_REPLY_ENABLED.delete(ownerEmail);
  persistAutoReply();
  console.log(`📧 Auto-reply disabled for ${ownerEmail}`);
}

async function checkInboxAndReply(ownerEmail) {
  const entry = gmailTokens.get(ownerEmail);
  const config = EMAIL_AUTO_REPLY_ENABLED.get(ownerEmail);
  if (!entry || !config?.enabled) return;

  try {
    const gmail = google.gmail({ version: 'v1', auth: entry.auth });

    // Get unread emails from the last hour (not sent by us, not spam/trash)
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread is:inbox -from:me newer_than:1h',
      maxResults: 10,
    });

    const messages = res.data.messages || [];
    for (const msg of messages) {
      if (repliedEmails.has(msg.id)) continue;

      const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const headers = full.data.payload.headers;
      const from    = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
      const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
      const msgId   = headers.find(h => h.name.toLowerCase() === 'message-id')?.value || '';

      // Extract sender email
      const senderEmail = from.match(/<(.+?)>/)?.[1] || from.trim();

      // Skip noreply, mailer-daemon, own emails, newsletters, automated senders
      if (/noreply|no-reply|mailer-daemon|postmaster|notifications?@|newsletter|digest|updates?@/i.test(senderEmail)) {
        repliedEmails.add(msg.id);
        continue;
      }
      if (senderEmail.toLowerCase() === ownerEmail.toLowerCase()) {
        repliedEmails.add(msg.id);
        continue;
      }

      // Check if we already replied in this thread — prevents double-replies after restart
      const thread = await gmail.users.threads.get({ userId: 'me', id: full.data.threadId, format: 'metadata', metadataHeaders: ['From'] });
      const threadMsgs = thread.data.messages || [];
      const weAlreadyReplied = threadMsgs.some(m => {
        const f = m.payload.headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
        return f.toLowerCase().includes(ownerEmail.toLowerCase()) && m.id !== msg.id;
      });
      if (weAlreadyReplied) {
        repliedEmails.add(msg.id);
        continue;
      }

      // Extract body text
      let bodyText = '';
      const parts = full.data.payload.parts || [];
      if (parts.length) {
        const textPart = parts.find(p => p.mimeType === 'text/plain') || parts[0];
        if (textPart?.body?.data) bodyText = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
      } else if (full.data.payload.body?.data) {
        bodyText = Buffer.from(full.data.payload.body.data, 'base64').toString('utf-8');
      }

      if (!bodyText.trim()) { repliedEmails.add(msg.id); continue; }

      // Strip email signatures and quoted replies
      bodyText = bodyText.split(/\n--\s*\n/)[0].split(/\nOn .+ wrote:/)[0].trim();

      console.log(`📧 New email from ${senderEmail}: "${subject}"`);

      // Generate reply with Claude (also detects bookings)
      const senderName = from.split('<')[0].trim().replace(/"/g, '') || 'there';
      const result = await generateEmailReply(config.systemPrompt, senderName, senderEmail, subject, bodyText);

      if (result?.reply) {
        // Build reply email with threading headers
        const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
        const threadId = full.data.threadId;

        const headerLines = [
          `From: ${ownerEmail}`,
          `To: ${senderEmail}`,
          `Subject: ${replySubject}`,
          msgId ? `In-Reply-To: ${msgId}` : '',
          msgId ? `References: ${msgId}` : '',
          'MIME-Version: 1.0',
          'Content-Type: text/html; charset=utf-8',
        ].filter(Boolean).join('\r\n');
        const replyHeaders = headerLines + '\r\n\r\n' + result.reply;

        const encoded = Buffer.from(replyHeaders).toString('base64url');
        await gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw: encoded, threadId },
        });

        // Mark original as read
        await gmail.users.messages.modify({
          userId: 'me', id: msg.id,
          requestBody: { removeLabelIds: ['UNREAD'] },
        });

        console.log(`✅ Auto-replied to ${senderEmail} re: "${subject}"`);

        // If a booking was detected, create a Google Calendar event
        if (result.booking) {
          const b = result.booking;
          b.email = b.email || senderEmail;
          b.name  = b.name || senderName;
          console.log(`📅 Booking detected in email from ${senderEmail}: ${b.datetime}`);
          const calEvent = await createCalendarEvent(ownerEmail, {
            name:     b.name,
            email:    b.email,
            datetime: b.datetime,
            notes:    b.notes || subject,
            siteName: 'Email',
            page:     'Email auto-reply',
          });
          if (calEvent) {
            console.log(`📅 Calendar event created from email: ${calEvent.htmlLink}`);
          }
        }
      }

      repliedEmails.add(msg.id);
    }
    persistRepliedEmails();
  } catch (e) {
    console.warn(`📧 Inbox check failed for ${ownerEmail}:`, e.message);
  }
}

async function generateEmailReply(systemPrompt, senderName, senderEmail, subject, body) {
  try {
    const r = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{ role: 'user', content: `You received this email. Write a helpful, professional reply AND check if it contains a booking or appointment request.

From: ${senderName} (${senderEmail})
Subject: ${subject}
Message:
${body}

Respond with valid JSON only:
{
  "reply": "<p>Your HTML reply here</p>",
  "booking": null or { "name": "customer name", "email": "their email", "datetime": "the date/time they mentioned", "notes": "what work they need" }
}

Rules for the reply:
- Be friendly, helpful, and concise
- If they're asking for a quote or booking, confirm you'll get back to them and ask for any missing details
- If you can answer their question directly, do so
- Always offer to arrange a call or site visit
- Sign off with the business name
- Format the reply as simple HTML with <p> tags

Rules for booking detection:
- If the email mentions a specific date, time, appointment, booking, or scheduling — extract it into the booking object
- Include their name, email, the date/time they mentioned (as written), and what work they need
- If no booking/date is mentioned, set booking to null` }],
      system: systemPrompt + '\n\nYou are replying to emails on behalf of this business. Keep replies short, professional, and warm. Never mention you are an AI — write as if you are a member of the team. Always respond with valid JSON.',
    });
    const text = r.content[0]?.text || '';
    try {
      const parsed = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
      return parsed;
    } catch {
      // If JSON parsing fails, treat whole response as reply
      return { reply: text, booking: null };
    }
  } catch (e) {
    console.warn('Email reply generation failed:', e.message);
    return null;
  }
}

// Start polling loop for all connected accounts with auto-reply enabled
setInterval(() => {
  for (const [ownerEmail] of EMAIL_AUTO_REPLY_ENABLED) {
    checkInboxAndReply(ownerEmail);
  }
}, EMAIL_POLL_INTERVAL);

// ─── Email Auto-Reply API Routes ─────────────────────────────────────────────

// Enable auto-reply for an owner
app.post('/api/email-autoreply/enable', (req, res) => {
  const { owner, systemPrompt } = req.body;
  if (!owner) return res.status(400).json({ error: 'owner required' });
  if (!gmailTokens.has(owner)) return res.status(400).json({ error: 'Gmail not connected for this owner' });
  enableEmailAutoReply(owner, systemPrompt || 'You are a helpful business assistant.');
  res.json({ ok: true, owner, enabled: true });
});

// Disable auto-reply
app.post('/api/email-autoreply/disable', (req, res) => {
  const { owner } = req.body;
  disableEmailAutoReply(owner);
  res.json({ ok: true, owner, enabled: false });
});

// Check status
app.get('/api/email-autoreply/status', (req, res) => {
  const { owner } = req.query;
  const config = EMAIL_AUTO_REPLY_ENABLED.get(owner);
  res.json({ owner, enabled: !!config?.enabled });
});

// Manual trigger — check inbox now without waiting for the poll
app.post('/api/email-autoreply/check-now', async (req, res) => {
  const { owner } = req.body;
  if (!owner) return res.status(400).json({ error: 'owner required' });
  if (!gmailTokens.has(owner)) return res.status(400).json({ error: 'Gmail not connected' });
  if (!EMAIL_AUTO_REPLY_ENABLED.has(owner)) return res.status(400).json({ error: 'Auto-reply not enabled' });
  try {
    await checkInboxAndReply(owner);
    res.json({ ok: true, checked: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Slack ────────────────────────────────────────────────────────────────────
async function slack(blocks, text = 'Aria notification') {
  const url = process.env.SLACK_WEBHOOK;
  if (!url) return;
  try { await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text, blocks }) }); }
  catch {}
}

// ─── Stores ───────────────────────────────────────────────────────────────────
const sessions     = new Map();
const faqs         = new Map();
const handoffs     = new Map();
const bookings     = [];
const npsScores    = [];
const abResults    = { A:{ opens:0, leads:0 }, B:{ opens:0, leads:0 } };
const gaps         = [];        // knowledge gaps: questions bot couldn't answer
const leadStatuses = new Map(); // email → { status, notes, updatedAt }
let faqSeq = 1;
const MAX_SESS = 2000;

// ─── Dropshipping stores ──────────────────────────────────────────────────────
const dsProducts = new Map(); // shopifyVariantId → { cjSku, cjPid, title, costPrice, sellPrice, imageUrl }
const dsOrders   = [];        // fulfilled dropship orders

// ─── Usage tracking ───────────────────────────────────────────────────────────
// Tracks token usage per calendar month. Cost per 1M tokens (Haiku): input $0.80, output $4.00
const COST_IN  = 0.80  / 1_000_000;
const COST_OUT = 4.00  / 1_000_000;
let usageMonth = '';   // YYYY-MM of current bucket
let usage = { messages: 0, inputTokens: 0, outputTokens: 0, cost: 0 };

// Site settings — configurable from admin dashboard
let siteSettings = {
  // Cap
  capEnabled:   false,
  capMessages:  1000,
  capWarningAt: 80,
  capWarnSent:  false,
  // Bot appearance
  botName:      '',
  botColor:     '',
  welcomeMsg:   '',
  businessType: '',
  // Business profile — injected into every system prompt
  businessName:     '',
  businessTagline:  '',
  businessLocation: '',
  businessPhone:    '',
  businessEmail:    '',
  businessHours:    '',
  businessServices: '',
  businessPrices:   '',
  businessArea:     '',   // delivery/service area
  businessExtra:    '',   // anything else the bot should know
};

// Build the business context block injected into every system prompt
function buildBusinessContext() {
  const s = siteSettings;
  const lines = [];
  if (s.businessName)     lines.push(`Business name: ${s.businessName}`);
  if (s.businessTagline)  lines.push(`Tagline: ${s.businessTagline}`);
  if (s.businessLocation) lines.push(`Location: ${s.businessLocation}`);
  if (s.businessPhone)    lines.push(`Phone: ${s.businessPhone}`);
  if (s.businessEmail)    lines.push(`Email: ${s.businessEmail}`);
  if (s.businessHours)    lines.push(`Opening hours: ${s.businessHours}`);
  if (s.businessArea)     lines.push(`Service/delivery area: ${s.businessArea}`);
  if (s.businessServices) lines.push(`\nServices/products offered:\n${s.businessServices}`);
  if (s.businessPrices)   lines.push(`\nPricing:\n${s.businessPrices}`);
  if (s.businessExtra)    lines.push(`\nAdditional info:\n${s.businessExtra}`);
  if (!lines.length) return '';
  return `\n\n--- BUSINESS INFORMATION ---\nYou work for this business. Use the information below to answer customer questions accurately. If asked something not covered here, say you'll check with the team rather than guessing.\n\n${lines.join('\n')}\n--- END BUSINESS INFORMATION ---`;
}

function currentMonth() { return new Date().toISOString().slice(0, 7); }

function trackUsage(inputTokens = 0, outputTokens = 0) {
  const mo = currentMonth();
  if (mo !== usageMonth) {
    // New month — reset counter, keep last month for history
    usageMonth = mo;
    usage = { messages: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    siteSettings.capWarnSent = false;
    save('siteSettings', siteSettings);
  }
  usage.messages++;
  usage.inputTokens  += inputTokens;
  usage.outputTokens += outputTokens;
  usage.cost = +(usage.inputTokens * COST_IN + usage.outputTokens * COST_OUT).toFixed(4);
  save('usage', { month: usageMonth, ...usage });

  // Warn owner when approaching cap
  if (siteSettings.capEnabled && !siteSettings.capWarnSent) {
    const pct = (usage.messages / siteSettings.capMessages) * 100;
    if (pct >= (siteSettings.capWarningAt || 80)) {
      siteSettings.capWarnSent = true;
      save('siteSettings', siteSettings);
      sendEmail({
        to: process.env.NOTIFY_EMAIL,
        subject: `⚠️ Aria chatbot at ${Math.round(pct)}% of monthly message cap`,
        html: `<p>Your chatbot has used <strong>${usage.messages} of ${siteSettings.capMessages}</strong> messages this month (${Math.round(pct)}%).</p><p>Estimated cost so far: <strong>$${usage.cost}</strong></p><p>Raise the cap in your admin dashboard if needed.</p>`,
      });
    }
  }
}

function isOverCap() {
  if (!siteSettings.capEnabled) return false;
  if (currentMonth() !== usageMonth) return false;
  return usage.messages >= siteSettings.capMessages;
}

// ─── Persistence (file-based — survives server restarts) ──────────────────────
const DATA_DIR = resolve('./data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

function dataPath(name) { return join(DATA_DIR, `${name}.json`); }

function loadFile(name, fallback = null) {
  try {
    const raw = readFileSync(dataPath(name), 'utf8');
    return JSON.parse(raw);
  } catch { return fallback; }
}

function saveFile(name, data) {
  try { writeFileSync(dataPath(name), JSON.stringify(data, null, 2)); }
  catch (e) { console.warn(`Persist save ${name}:`, e.message); }
}

// Debounced save — batches rapid writes (e.g. streaming messages) into one disk write
const _saveTimers = {};
function save(name, data, delay = 500) {
  clearTimeout(_saveTimers[name]);
  _saveTimers[name] = setTimeout(() => saveFile(name, data), delay);
}

// ─── Load persisted data on startup ──────────────────────────────────────────
(function loadPersistedData() {
  // FAQs
  const savedFaqs = loadFile('faqs', []);
  savedFaqs.forEach(f => faqs.set(f.id, f));
  faqSeq = savedFaqs.reduce((max, f) => Math.max(max, f.id + 1), 1);

  // Bookings
  const savedBookings = loadFile('bookings', []);
  bookings.push(...savedBookings);

  // Lead statuses (pipeline)
  const savedStatuses = loadFile('leadStatuses', []);
  savedStatuses.forEach(([k, v]) => leadStatuses.set(k, v));

  // Knowledge gaps
  const savedGaps = loadFile('gaps', []);
  gaps.push(...savedGaps);

  // Dropship product catalogue (critical — losing this means orders can't auto-fulfil)
  const savedProducts = loadFile('dsProducts', []);
  savedProducts.forEach(([k, v]) => dsProducts.set(k, v));

  // Dropship order history
  const savedDsOrders = loadFile('dsOrders', []);
  dsOrders.push(...savedDsOrders);

  // Usage tracking
  const savedUsage = loadFile('usage', null);
  if (savedUsage && savedUsage.month === currentMonth()) {
    usageMonth = savedUsage.month;
    usage = { messages: savedUsage.messages || 0, inputTokens: savedUsage.inputTokens || 0, outputTokens: savedUsage.outputTokens || 0, cost: savedUsage.cost || 0 };
  } else {
    usageMonth = currentMonth();
  }

  // Site settings
  const savedSettings = loadFile('siteSettings', null);
  if (savedSettings) Object.assign(siteSettings, savedSettings);

  console.log(`📂 Loaded: ${savedFaqs.length} FAQs, ${savedBookings.length} bookings, ${savedProducts.length} products, ${savedDsOrders.length} dropship orders, ${usage.messages} msgs this month`);
})();

function getSession(id) {
  return sessions.get(id) || { id, startedAt:new Date(), lastActivity:new Date(), messages:[], leads:[], rating:null, nps:null, tag:null, score:null, sentiment:'neutral', page:'', url:'', referrer:'', abVariant:null, followupSent:false };
}
function saveSession(id, upd) {
  const s = { ...getSession(id), ...upd, lastActivity:new Date() };
  sessions.set(id, s);
  if (sessions.size > MAX_SESS) sessions.delete(sessions.keys().next().value);
  return s;
}

// ─── Rate limit ───────────────────────────────────────────────────────────────
const rates = new Map();
function checkRate(ip) {
  const now = Date.now(), win = 60_000, lim = 30;
  let r = rates.get(ip) || { n:0, reset:now+win };
  if (now > r.reset) r = { n:0, reset:now+win };
  if (r.n >= lim) return false;
  r.n++; rates.set(ip, r); return true;
}

// ─── AI helpers ───────────────────────────────────────────────────────────────
async function aiJSON(prompt, maxTokens = 300) {
  try {
    const r = await claude.messages.create({ model:'claude-haiku-4-5-20251001', max_tokens:maxTokens, messages:[{ role:'user', content:prompt }] });
    return JSON.parse(r.content[0].text.match(/\{[\s\S]*\}/)?.[0] || '{}');
  } catch { return {}; }
}

async function tagAndScore(session) {
  if (!session.messages?.length) return {};
  const convo = session.messages.map(m=>`${m.role}: ${m.content}`).join('\n').slice(0,3000);
  const r = await aiJSON(`Analyse this chat. JSON only:
{"tag":"Sale Opportunity|Support Request|Complaint|Feedback|Just Browsing","score":1-10,"summary":"2 sentences","hotLead":true|false,"sentiment":"positive|neutral|negative","topObjection":"string or null"}
Conversation:\n${convo}`);
  if (r.tag) saveSession(session.id, { tag:r.tag, score:r.score, summary:r.summary, hotLead:r.hotLead, sentiment:r.sentiment, topObjection:r.topObjection });
  return r;
}

// ─── Email templates ──────────────────────────────────────────────────────────
const wrap = (body, adminUrl, brandColor = '#6C63FF', brandName = 'Aria Chatbot') => `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f0f0f8;padding:30px;margin:0">
<div style="max-width:580px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.1)">
<div style="background:${brandColor};padding:22px 28px"><h1 style="color:white;margin:0;font-size:19px">✦ ${brandName}</h1></div>
<div style="padding:28px">${body}</div>
<div style="padding:14px 28px;background:#f8f8fc;font-size:12px;color:#999;border-top:1px solid #eee">
  ${brandName} · ${adminUrl ? `<a href="${adminUrl}" style="color:${brandColor}">Open Admin</a>` : ''}
</div></div></body></html>`;

const leadTpl = ({ email, name, page, convo, score, tag, adminUrl, qualification }) => wrap(`
  <h2 style="margin:0 0 16px;color:#1a1a2e">🎯 New Lead${score>=7?' 🔥':''}</h2>
  <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
    <tr><td style="padding:7px 0;color:#999;width:90px">Email</td><td><a href="mailto:${email}" style="color:#6C63FF;font-weight:700">${email}</a></td></tr>
    ${name?`<tr><td style="padding:7px 0;color:#999">Name</td><td style="font-weight:600">${name}</td></tr>`:''}
    <tr><td style="padding:7px 0;color:#999">Page</td><td>${page}</td></tr>
    <tr><td style="padding:7px 0;color:#999">Score</td><td><span style="background:${score>=7?'#2ecc71':score>=4?'#f39c12':'#e74c3c'};color:white;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:700">${score||'?'}/10</span></td></tr>
    <tr><td style="padding:7px 0;color:#999">Intent</td><td>${tag||'Unknown'}</td></tr>
    ${qualification?.urgency?`<tr><td style="padding:7px 0;color:#999">Urgency</td><td style="font-weight:600;color:${qualification.urgency==='urgent'?'#e74c3c':'#666'}">${qualification.urgency}</td></tr>`:''}
    ${qualification?.budget?`<tr><td style="padding:7px 0;color:#999">Budget</td><td style="font-weight:600">${qualification.budget}</td></tr>`:''}
    ${qualification?.need?`<tr><td style="padding:7px 0;color:#999;vertical-align:top">Need</td><td style="color:#444">${qualification.need?.slice(0,150)}</td></tr>`:''}
  </table>
  <div style="background:#f8f8fc;border-radius:10px;padding:14px;font-size:13px;color:#444;margin-bottom:20px">
    ${convo.slice(-6).map(m=>`<div style="padding:3px 0"><strong style="color:${m.role==='user'?'#333':'#6C63FF'}">${m.role==='user'?'User':'Bot'}:</strong> ${m.content?.slice(0,150)}</div>`).join('')}
  </div>
  <a href="mailto:${email}" style="display:inline-block;padding:11px 22px;background:#6C63FF;color:white;border-radius:10px;text-decoration:none;font-weight:600">Reply now →</a>
`, adminUrl);

const bookingTpl = ({ name, email, datetime, notes, page, adminUrl }) => wrap(`
  <h2 style="margin:0 0 16px;color:#1a1a2e">📅 New Booking Request</h2>
  <table style="width:100%;border-collapse:collapse">
    <tr><td style="padding:7px 0;color:#999;width:90px">Name</td><td style="font-weight:700">${name}</td></tr>
    <tr><td style="padding:7px 0;color:#999">Email</td><td><a href="mailto:${email}" style="color:#6C63FF">${email}</a></td></tr>
    <tr><td style="padding:7px 0;color:#999">Requested</td><td style="font-weight:700;color:#6C63FF">${datetime}</td></tr>
    ${notes?`<tr><td style="padding:7px 0;color:#999">Notes</td><td>${notes}</td></tr>`:''}
    <tr><td style="padding:7px 0;color:#999">From</td><td>${page}</td></tr>
  </table>
  <a href="mailto:${email}?subject=Booking Confirmation" style="display:inline-block;margin-top:18px;padding:11px 22px;background:#6C63FF;color:white;border-radius:10px;text-decoration:none;font-weight:600">Confirm booking →</a>
`, adminUrl);

const digestTpl = ({ date, stats, topQ, hotLeads, bookingCount, abResults, topObjections, adminUrl }) => wrap(`
  <h2 style="margin:0 0 4px;color:#1a1a2e">📊 ${date} — Daily Digest</h2>
  <p style="color:#888;margin:0 0 22px;font-size:13px">Here's what happened yesterday.</p>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:24px">
    ${[['Conversations',stats.today],['Leads',stats.leadsToday],['Avg Rating',stats.avgRating||'—'],['Bookings',bookingCount]].map(([l,n])=>`<div style="background:#f8f8fc;border-radius:10px;padding:14px;text-align:center"><div style="font-size:26px;font-weight:800;color:#6C63FF">${n}</div><div style="color:#999;font-size:12px;margin-top:2px">${l}</div></div>`).join('')}
  </div>
  ${topQ.length?`<h3 style="font-size:13px;margin-bottom:8px">Top questions</h3><table style="width:100%;font-size:12px;border-collapse:collapse">${topQ.map(([w,c])=>`<tr><td style="padding:4px 0;color:#444">${w}</td><td style="color:#6C63FF;font-weight:700;text-align:right">${c}x</td></tr>`).join('')}</table>`:''}
  ${topObjections?.length?`<h3 style="font-size:13px;margin:16px 0 8px">Top objections</h3><p style="font-size:13px;color:#666">${topObjections.join(' · ')}</p>`:''}
  ${abResults?`<h3 style="font-size:13px;margin:16px 0 8px">A/B Test</h3><p style="font-size:13px;color:#666">A: ${abResults.A.leads} leads from ${abResults.A.opens} opens · B: ${abResults.B.leads} leads from ${abResults.B.opens} opens</p>`:''}
  <a href="${adminUrl}" style="display:inline-block;margin-top:20px;padding:11px 22px;background:#6C63FF;color:white;border-radius:10px;text-decoration:none;font-weight:600">Full dashboard →</a>
`, adminUrl);

// Sent TO the visitor after they submit their email
const visitorFollowupTpl = ({ visitorName, botName, siteName, ownerName, summaryPoints, adminUrl }) => wrap(`
  <h2 style="margin:0 0 16px;color:#1a1a2e">Hey${visitorName ? ` ${visitorName}` : ''}! Thanks for chatting ✦</h2>
  <p style="font-size:14px;color:#444;line-height:1.6;margin-bottom:20px">
    This is ${botName} from <strong>${siteName}</strong> following up on our chat.
    ${ownerName ? `<strong>${ownerName}</strong> and the team have` : 'The team has'} been notified and will be in touch soon.
  </p>
  ${summaryPoints?.length ? `
  <div style="background:#f8f8fc;border-radius:10px;padding:16px;margin-bottom:20px">
    <p style="font-size:12px;font-weight:700;color:#999;margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">What we covered</p>
    ${summaryPoints.map(p => `<p style="font-size:13.5px;color:#444;padding:3px 0">• ${p}</p>`).join('')}
  </div>` : ''}
  <p style="font-size:13.5px;color:#444;line-height:1.6">
    Got more questions in the meantime? Just reply to this email — ${ownerName || 'the team'} will get back to you! 😊
  </p>
`, adminUrl);

// Booking confirmation sent TO the visitor
const visitorBookingTpl = ({ name, datetime, siteName, botName, ownerName, ownerEmail, calendarLink, adminUrl }) => wrap(`
  <h2 style="margin:0 0 16px;color:#1a1a2e">📅 Booking Received!</h2>
  <p style="font-size:14px;color:#444;line-height:1.6;margin-bottom:20px">
    Hi ${name || 'there'}! Your booking with <strong>${siteName}</strong> has been received.
  </p>
  <div style="background:#f8f8fc;border-radius:10px;padding:16px;margin-bottom:20px">
    <p style="font-size:12px;font-weight:700;color:#999;margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px">Your booking details</p>
    <p style="font-size:15px;color:#1a1a2e;font-weight:700">📅 ${datetime}</p>
    ${ownerName ? `<p style="font-size:13px;color:#666;margin-top:6px">With: ${ownerName}</p>` : ''}
  </div>
  ${calendarLink ? `
  <div style="background:#e8f5e920;border:1.5px solid #2ecc7140;border-radius:10px;padding:14px;margin-bottom:20px;text-align:center">
    <p style="font-size:13px;color:#1a8a4a;margin-bottom:10px">✓ This has been added to your calendar</p>
    <a href="${calendarLink}" style="display:inline-block;padding:9px 20px;background:#2ecc71;color:white;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600">View in Google Calendar →</a>
  </div>` : ''}
  <p style="font-size:13.5px;color:#444;line-height:1.6">
    ${ownerName || 'The team'} will be in touch to confirm shortly.
    ${ownerEmail ? `You can reach them at <a href="mailto:${ownerEmail}" style="color:#6C63FF">${ownerEmail}</a>.` : ''}
  </p>
  <p style="font-size:13px;color:#888;margin-top:18px">Need to reschedule? Just reply to this email.</p>
`, adminUrl);

const weeklyTpl = ({ period, stats, trend, topQuestions, hotLeads, npsAvg, adminUrl }) => wrap(`
  <h2 style="margin:0 0 4px;color:#1a1a2e">📈 Weekly Report — ${period}</h2>
  <p style="color:#888;margin:0 0 22px;font-size:13px">Your chatbot's performance this week.</p>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:24px">
    ${[['Conversations',stats.total,trend.total],['Leads',stats.leads,trend.leads],['Lead Score Avg',stats.avgScore||'—',null],['NPS Score',npsAvg||'—',null]].map(([l,n,t])=>`<div style="background:#f8f8fc;border-radius:10px;padding:14px;text-align:center"><div style="font-size:26px;font-weight:800;color:#6C63FF">${n}</div><div style="color:#999;font-size:12px;margin-top:2px">${l}${t!=null?` <span style="color:${t>=0?'#2ecc71':'#e74c3c'}">${t>=0?'▲':'▼'}${Math.abs(t)}</span>`:''}</div></div>`).join('')}
  </div>
  ${topQuestions.length?`<h3 style="font-size:13px;margin-bottom:8px">Top 5 questions this week</h3><ol style="padding-left:18px;font-size:13px;color:#444">${topQuestions.slice(0,5).map(([w])=>`<li style="padding:3px 0">${w}</li>`).join('')}</ol>`:''}
  ${hotLeads.length?`<h3 style="font-size:13px;margin:16px 0 8px">Hot leads this week 🔥</h3><ul style="padding-left:18px;font-size:13px">${hotLeads.slice(0,5).map(l=>`<li><a href="mailto:${l.email}" style="color:#6C63FF">${l.email}</a> — ${l.score}/10</li>`).join('')}</ul>`:''}
  <a href="${adminUrl}" style="display:inline-block;margin-top:20px;padding:11px 22px;background:#6C63FF;color:white;border-radius:10px;text-decoration:none;font-weight:600">Full dashboard →</a>
`, adminUrl);

// ─── Slack block builder ──────────────────────────────────────────────────────
function slackLeadBlocks({ email, score, tag, page, adminUrl }) {
  return [
    { type:'header', text:{ type:'plain_text', text:`🎯 New Lead${score>=7?' 🔥':''}` } },
    { type:'section', fields:[
      { type:'mrkdwn', text:`*Email:*\n${email}` },
      { type:'mrkdwn', text:`*Score:*\n${score||'?'}/10` },
      { type:'mrkdwn', text:`*Type:*\n${tag||'Unknown'}` },
      { type:'mrkdwn', text:`*Page:*\n${page}` },
    ]},
    { type:'actions', elements:[
      { type:'button', text:{ type:'plain_text', text:'View Admin' }, url:adminUrl, style:'primary' },
      { type:'button', text:{ type:'plain_text', text:`Email ${email}` }, url:`mailto:${email}` },
    ]},
  ];
}

// ─── Google Calendar ──────────────────────────────────────────────────────────

// Parse natural language datetime into ISO — uses Claude so "next Tuesday 2pm" just works
async function parseBookingDatetime(text) {
  const today = new Date().toISOString().slice(0, 10);
  const r = await aiJSON(`Convert this booking request into a start/end datetime.
Today's date: ${today}
Booking text: "${text}"
Assume 1 hour duration unless specified. Use UTC+0 if no timezone given.
Return ONLY valid JSON: {"start":"2024-01-15T14:00:00","end":"2024-01-15T15:00:00","valid":true}
If the text is too vague to parse, return: {"valid":false}`);
  return r?.valid ? r : null;
}

// Create a Google Calendar event for a confirmed booking
async function createCalendarEvent(ownerEmail, booking) {
  const entry = gmailTokens.get(ownerEmail);
  if (!entry) return null;

  try {
    const calendar = google.calendar({ version: 'v3', auth: entry.auth });
    const parsed   = await parseBookingDatetime(booking.datetime);

    let eventBody;
    if (parsed) {
      eventBody = {
        summary:     `📅 Booking: ${booking.name}`,
        description: `Booked via ${booking.siteName || booking.page || 'chatbot'}\n\nNotes: ${booking.notes || 'None'}\n\nEmail: ${booking.email}`,
        start: { dateTime: parsed.start, timeZone: booking.timezone || 'Europe/London' },
        end:   { dateTime: parsed.end,   timeZone: booking.timezone || 'Europe/London' },
        attendees: [{ email: booking.email, displayName: booking.name }],
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 60 },
            { method: 'popup', minutes: 15 },
          ],
        },
        guestsCanModify: false,
        guestsCanSeeOtherGuests: false,
      };
    } else {
      // Unparseable time — create an all-day reminder so nothing gets lost
      const dateStr = new Date().toISOString().slice(0, 10);
      eventBody = {
        summary:     `📅 Booking: ${booking.name} — ${booking.datetime}`,
        description: `Booked via ${booking.siteName || booking.page}\nRequested time: ${booking.datetime}\nNotes: ${booking.notes || 'None'}\nEmail: ${booking.email}`,
        start: { date: dateStr },
        end:   { date: dateStr },
        attendees: [{ email: booking.email, displayName: booking.name }],
      };
    }

    const result = await calendar.events.insert({
      calendarId:    'primary',
      requestBody:   eventBody,
      sendUpdates:   'all',   // sends Google Calendar invite to the visitor's email
    });

    console.log(`📅 Calendar event created for ${ownerEmail}: ${result.data.htmlLink}`);
    return result.data;
  } catch (e) {
    console.warn(`Calendar event failed for ${ownerEmail}:`, e.message);
    return null;
  }
}

// ─── Gmail Connect Routes ─────────────────────────────────────────────────────

// Connection page — owner visits this URL to connect their Gmail
// e.g. http://localhost:3000/connect/gmail?owner=pete@gmail.com
app.get('/connect/gmail', (req, res) => {
  const ownerEmail = req.query.owner || '';
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center">
      <h2>⚠️ Google credentials not configured</h2>
      <p>Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your environment variables.</p>
    </body></html>`);
  }

  const isConnected = gmailTokens.has(ownerEmail);
  const authUrl = getAuthUrl(ownerEmail);

  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Connect Gmail — Aria Chatbot</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f0f8;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;}
    .box{background:white;border-radius:20px;padding:40px;max-width:440px;width:100%;box-shadow:0 8px 40px rgba(0,0,0,.12);text-align:center;}
    .icon{font-size:48px;margin-bottom:20px;}
    h1{font-size:22px;color:#1a1a2e;margin-bottom:10px;}
    p{font-size:14px;color:#666;line-height:1.6;margin-bottom:24px;}
    .email{display:inline-block;background:#f0f0f8;border-radius:8px;padding:6px 14px;font-size:13px;color:#1a1a2e;font-weight:600;margin-bottom:24px;}
    .btn{display:block;width:100%;padding:14px;background:#6C63FF;color:white;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;transition:opacity .15s;}
    .btn:hover{opacity:.88;}
    .btn.google{background:white;color:#333;border:1.5px solid #ddd;display:flex;align-items:center;justify-content:center;gap:10px;}
    .btn.google:hover{background:#f8f8f8;}
    .connected{background:#2ecc7118;border:1.5px solid #2ecc71;border-radius:12px;padding:16px;margin-bottom:20px;color:#1a8a4a;}
    .connected strong{display:block;font-size:15px;margin-bottom:4px;}
    .connected span{font-size:13px;}
    .what{background:#f8f8fc;border-radius:12px;padding:16px;text-align:left;margin-bottom:24px;}
    .what h3{font-size:12px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;}
    .what li{font-size:13px;color:#444;padding:3px 0;list-style:none;padding-left:20px;position:relative;}
    .what li::before{content:'✓';position:absolute;left:0;color:#6C63FF;font-weight:700;}
    .disconnect{margin-top:12px;background:none;border:none;color:#e74c3c;font-size:12px;cursor:pointer;font-family:inherit;}
  </style>
  </head><body><div class="box">
    <div class="icon">📧</div>
    <h1>Connect Your Gmail</h1>
    ${ownerEmail ? `<div class="email">${ownerEmail}</div>` : ''}
    ${isConnected ? `
      <div class="connected">
        <strong>✓ Gmail Connected!</strong>
        <span>Your chatbot is sending emails from your Gmail account.</span>
      </div>
      <div class="what"><h3>What this means</h3><ul>
        <li>Lead alerts arrive in your Gmail sent items</li>
        <li>Visitors see your Gmail address, not a bot address</li>
        <li>Booking confirmations sent from you</li>
        <li>Visitors can reply directly to you</li>
      </ul></div>
      <a href="${authUrl}" class="btn google">
        <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 6.293C4.672 4.166 6.656 3.58 9 3.58z"/></svg>
        Reconnect Gmail
      </a>
      <form action="/disconnect/gmail" method="POST" style="margin-top:10px">
        <input type="hidden" name="owner" value="${ownerEmail}">
        <button class="disconnect" type="submit">Disconnect Gmail</button>
      </form>
    ` : `
      <p>Connect your Gmail so the chatbot can <strong>read and reply to incoming emails automatically</strong>, send lead alerts, booking confirmations, and follow-ups — all from your own email address.</p>
      <div class="what"><h3>You're giving access to</h3><ul>
        <li>Read incoming emails to generate smart replies</li>
        <li>Send emails and replies on your behalf</li>
        <li>Mark emails as read after replying</li>
        <li>Manage your Google Calendar for bookings</li>
        <li>Revoke anytime in Google settings</li>
      </ul></div>
      <a href="${authUrl}" class="btn google">
        <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 6.293C4.672 4.166 6.656 3.58 9 3.58z"/></svg>
        Connect Gmail
      </a>
    `}
  </div></body></html>`);
});

// OAuth2 callback — Google redirects here after owner signs in
app.get('/auth/gmail/callback', async (req, res) => {
  const { code, state: ownerEmail, error } = req.query;
  if (error) return res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>❌ Access denied</h2><p>${error}</p><p><a href="/connect/gmail?owner=${ownerEmail}">Try again</a></p></body></html>`);
  if (!code) return res.status(400).send('No code received');
  try {
    const client = makeOAuthClient();
    const { tokens } = await client.getToken(code);
    await saveGmailTokens(ownerEmail, tokens);
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:sans-serif;background:#f0f0f8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.box{background:white;border-radius:20px;padding:40px;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,.12)}</style></head>
    <body><div class="box">
      <div style="font-size:48px;margin-bottom:16px">🎉</div>
      <h1 style="color:#1a1a2e;margin-bottom:10px">Gmail Connected!</h1>
      <p style="color:#666;font-size:14px">Your chatbot will now send emails from <strong>${ownerEmail}</strong>.</p>
      <p style="color:#666;font-size:13px;margin-top:12px">You can close this window.</p>
    </div></body></html>`);
  } catch (e) {
    console.error('Gmail OAuth error:', e.message);
    res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>❌ Something went wrong</h2><p>${e.message}</p><a href="/connect/gmail?owner=${ownerEmail}">Try again</a></body></html>`);
  }
});

// Check connection status (used by admin dashboard)
app.get('/connect/gmail/status', (req, res) => {
  const { owner } = req.query;
  res.json({ connected: gmailTokens.has(owner), owner });
});

// Disconnect Gmail
app.post('/disconnect/gmail', (req, res) => {
  const owner = req.body.owner;
  if (owner) gmailTokens.delete(owner);
  res.redirect(`/connect/gmail?owner=${encodeURIComponent(owner || '')}`);
});

// ─── Chat endpoints ───────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  if (!checkRate(req.ip)) return res.status(429).json({ error:'Rate limited' });
  if (isOverCap()) return res.status(429).json({ error:'Monthly message limit reached — please try again next month.' });
  const { system, messages, model, max_tokens, sessionId } = req.body;
  if (!messages?.length) return res.status(400).json({ error:'Invalid messages' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error:'API key not configured' });
  try {
    const r = await claude.messages.create({
      model:      model || 'claude-haiku-4-5-20251001',
      max_tokens: max_tokens || 500,
      system:     (system || 'You are a helpful assistant.') + buildBusinessContext(),
      messages:   messages.slice(-24),
    });
    trackUsage(r.usage?.input_tokens || 0, r.usage?.output_tokens || 0);
    if (sessionId) saveSession(sessionId, { messages: messages.slice(-24) });
    res.json(r);
  } catch(e) {
    console.error('Chat error:', e.message);
    res.status(500).json({ error: e.message?.includes('API key') ? 'Invalid API key' : 'AI error' });
  }
});

app.post('/api/chat/stream', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const sse = d => { res.write(`data: ${typeof d === 'string' ? d : JSON.stringify(d)}\n\n`); if (typeof res.flush === 'function') res.flush(); };
  if (!checkRate(req.ip)) { sse({ error:'Rate limited' }); return res.end(); }
  if (isOverCap()) { sse({ error:'Monthly message limit reached — please try again next month.' }); return res.end(); }
  if (!process.env.ANTHROPIC_API_KEY) { sse({ error:'API key not configured — add ANTHROPIC_API_KEY to your .env file' }); return res.end(); }
  const { system, messages, model, max_tokens, sessionId } = req.body;
  if (!messages?.length) { sse({ error:'Invalid' }); return res.end(); }
  let aborted = false;
  req.on('close', () => { aborted = true; });
  try {
    const stream = claude.messages.stream({
      model:      model || 'claude-haiku-4-5-20251001',
      max_tokens: max_tokens || 500,
      system:     (system || 'You are a helpful assistant.') + buildBusinessContext(),
      messages:   messages.slice(-24),
    });
    req.on('close', () => { try { stream.abort(); } catch {} });
    stream.on('text', t => { if (!aborted) sse({ text: t }); });
    stream.on('finalMessage', msg => {
      trackUsage(msg.usage?.input_tokens || 0, msg.usage?.output_tokens || 0);
      if (!aborted) { sse('[DONE]'); res.end(); }
      if (sessionId) saveSession(sessionId, { messages: messages.slice(-24) });
    });
    stream.on('error', e => {
      if (e.name === 'APIUserAbortError' || aborted) return;
      console.error('Stream error:', e.message);
      if (!aborted) { sse({ error:'Stream error' }); res.end(); }
    });
    stream.on('abort', () => { /* expected on client disconnect, do nothing */ });
  } catch(e) {
    console.error('Stream setup error:', e.message);
    if (!aborted) { sse({ error: 'AI error' }); res.end(); }
  }
});

// ─── Session ──────────────────────────────────────────────────────────────────
app.post('/api/session', (req, res) => {
  const { sessionId, messages, page, url, referrer, rating, nps, npsComment, sentiment, abVariant, journey } = req.body;
  if (!sessionId) return res.status(400).json({ error:'No sessionId' });
  const upd = {};
  if (messages)    upd.messages    = messages.slice(-20);
  if (page)        upd.page        = page;
  if (url)         upd.url         = url;
  if (referrer)    upd.referrer    = referrer;
  if (rating)      upd.rating      = rating;
  if (sentiment)   upd.sentiment   = sentiment;
  if (abVariant)   upd.abVariant   = abVariant;
  if (journey)     upd.journey     = journey;
  if (nps != null) { upd.nps = nps; upd.npsComment = npsComment; npsScores.push({ score:nps, comment:npsComment, page, ts:new Date() }); }
  if (abVariant)   abResults[abVariant] && abResults[abVariant].opens++;
  saveSession(sessionId, upd);
  res.json({ ok:true });
});

// ─── Lead ─────────────────────────────────────────────────────────────────────
app.post('/api/lead', async (req, res) => {
  const { email, name, sessionId, page, url, journey,
          ownerEmail, ownerName, siteName, botName, followupEnabled,
          qualification, businessType } = req.body;
  if (!email) return res.status(400).json({ error:'No email' });

  // Init lead status as new
  if (!leadStatuses.has(email)) {
    leadStatuses.set(email, { status:'new', notes:'', updatedAt:new Date(), name, page, siteName });
    save('leadStatuses', Array.from(leadStatuses.entries()));
  }

  const session = getSession(sessionId);
  saveSession(sessionId, { leads:[...(session.leads||[]), email], ownerEmail, siteName });
  if (session.abVariant && abResults[session.abVariant]) abResults[session.abVariant].leads++;

  const insight    = await tagAndScore({ ...session, id:sessionId, messages:session.messages });
  const adminUrl   = `${req.protocol}://${req.get('host')}/admin?pass=${ADMIN}`;
  const alertTo    = ownerTo(ownerEmail);   // per-site owner, or global fallback

  // 1. Alert the site owner — use their Gmail if connected, otherwise server SMTP
  //    Reply-to is the visitor so owner just hits Reply to respond
  await smartSend({
    ownerEmail: alertTo,
    to:         alertTo,
    replyTo:    email,
    subject:    `🎯 New Lead${insight?.score >= 7 ? ' 🔥' : ''}: ${email} (${insight?.score||'?'}/10)${siteName ? ' — ' + siteName : ''}`,
    html:       leadTpl({ email, name, page, url, convo:session.messages||[], score:insight?.score, tag:insight?.tag, adminUrl, qualification }),
  });

  // 2. Follow-up email TO the visitor — sent from owner's Gmail if connected
  //    Reply-to is the owner so visitor replies go straight to them
  if (followupEnabled !== false && followupEnabled !== 'false') {
    const summaryPoints = insight?.summary
      ? insight.summary.split(/\.|,/).map(s => s.trim()).filter(s => s.length > 10).slice(0, 3)
      : [];
    // First follow-up: 3 minutes (feels personal, not instant robot)
    setTimeout(() => smartSend({
      ownerEmail: alertTo,
      to:         email,
      replyTo:    alertTo,
      subject:    `Thanks for chatting with ${botName || 'us'} ✦`,
      html:       visitorFollowupTpl({ visitorName:name, botName:botName||'us', siteName:siteName||page, ownerName, summaryPoints, adminUrl:null }),
    }), 3 * 60 * 1000);

    // Second follow-up: 24 hours (only if lead status still 'new' — owner hasn't replied)
    setTimeout(async () => {
      const status = leadStatuses.get(email);
      if (status?.status !== 'new') return; // owner already engaged, skip
      await smartSend({
        ownerEmail: alertTo,
        to:         email,
        replyTo:    alertTo,
        subject:    `Still thinking about it? — ${siteName || botName || 'us'}`,
        html:       wrap(`
          <h2 style="margin:0 0 16px;color:#1a1a2e">Just checking in 👋</h2>
          <p style="font-size:14px;color:#444;line-height:1.7;margin-bottom:20px">
            Hi${name ? ` ${name}` : ''}! I noticed you were asking some great questions yesterday.
            ${ownerName ? `<strong>${ownerName}</strong> and the team are` : 'The team is'} still here and happy to help.
          </p>
          ${qualification?.need ? `<div style="background:#f8f8fc;border-radius:10px;padding:14px;margin-bottom:20px;font-size:13.5px;color:#444"><p style="font-weight:600;margin-bottom:6px">You were asking about:</p><p>${qualification.need.slice(0,200)}</p></div>` : ''}
          <p style="font-size:14px;color:#444;line-height:1.7">Just reply to this email and someone will get back to you within the hour.</p>
        `, null, '#6C63FF', siteName || botName),
      });
    }, 24 * 60 * 60 * 1000);
  }

  // 3. Slack alert to owner channel
  await slack(slackLeadBlocks({ email, score:insight?.score, tag:insight?.tag, page, adminUrl }), `New lead: ${email}${siteName ? ' ('+siteName+')' : ''}`);

  // 4. Mailchimp sync
  if (process.env.MAILCHIMP_API_KEY && process.env.MAILCHIMP_LIST_ID) {
    const dc = process.env.MAILCHIMP_API_KEY.split('-')[1];
    fetch(`https://${dc}.api.mailchimp.com/3.0/lists/${process.env.MAILCHIMP_LIST_ID}/members`, {
      method:'POST',
      headers:{ 'Authorization':`Bearer ${process.env.MAILCHIMP_API_KEY}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ email_address:email, status:'subscribed', merge_fields:{ FNAME:name||'', SOURCE:siteName||page } }),
    }).catch(() => {});
  }

  res.json({ ok:true, score:insight?.score, tag:insight?.tag });
});

// ─── Booking ──────────────────────────────────────────────────────────────────
app.post('/api/booking', async (req, res) => {
  const b = { ...req.body, ts:new Date() };
  bookings.push(b);
  save('bookings', bookings);
  const adminUrl  = `${req.protocol}://${req.get('host')}/admin?pass=${ADMIN}`;
  const alertTo   = ownerTo(b.ownerEmail);

  // 1. Create Google Calendar event (non-blocking — runs in parallel with emails)
  const calendarPromise = alertTo ? createCalendarEvent(alertTo, b) : Promise.resolve(null);

  // 2. Alert the site owner — use their Gmail if connected
  await smartSend({
    ownerEmail: alertTo,
    to:         alertTo,
    replyTo:    b.email,
    subject:    `📅 Booking: ${b.name} — ${b.datetime}${b.siteName ? ' (' + b.siteName + ')' : ''}`,
    html:       bookingTpl({ ...b, adminUrl }),
  });

  // 3. Wait for calendar, then send visitor confirmation with calendar link if available
  const calEvent = await calendarPromise;
  b.calendarLink = calEvent?.htmlLink || null;
  b.calendarAdded = !!calEvent;

  if (b.email) {
    await smartSend({
      ownerEmail: alertTo,
      to:         b.email,
      replyTo:    alertTo,
      subject:    `📅 Booking received — ${b.siteName || b.page}`,
      html:       visitorBookingTpl({ name:b.name, datetime:b.datetime, siteName:b.siteName||b.page, botName:b.botName||'us', ownerName:b.ownerName, ownerEmail:alertTo, calendarLink:b.calendarLink, adminUrl:null }),
    });
  }

  // 4. Slack
  await slack([
    { type:'header', text:{ type:'plain_text', text:'📅 New Booking' + (calEvent ? ' — Added to Calendar ✓' : '') } },
    { type:'section', text:{ type:'mrkdwn', text:`*${b.name}* (${b.email}) — *${b.datetime}*\nSite: ${b.siteName||b.page}${calEvent?.htmlLink ? '\n<'+calEvent.htmlLink+'|View in Google Calendar>' : ''}` } },
  ], `Booking from ${b.name}`);

  res.json({ ok:true, calendarAdded: !!calEvent, calendarLink: b.calendarLink });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  DROPSHIPPING ENGINE — CJ Dropshipping API v2
//  Flow: Shopify order paid → find supplier SKU → auto-order → track → notify
// ═══════════════════════════════════════════════════════════════════════════════

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';
let _cjToken  = null, _cjTokenExpiry = 0;

// Get (or refresh) CJ access token
async function getCJToken() {
  if (_cjToken && Date.now() < _cjTokenExpiry - 60_000) return _cjToken;
  if (!process.env.CJ_EMAIL || !process.env.CJ_API_KEY) return null;
  try {
    const r = await fetch(`${CJ_BASE}/authentication/getAccessToken`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email: process.env.CJ_EMAIL, password: process.env.CJ_API_KEY }),
    });
    const d = await r.json();
    if (!d.result) { console.warn('CJ auth failed:', d.message); return null; }
    _cjToken       = d.data.accessToken;
    _cjTokenExpiry = Date.now() + (parseInt(d.data.accessTokenExpiryDate) || 86_400_000);
    console.log('✅ CJ Dropshipping connected');
    return _cjToken;
  } catch (e) { console.warn('CJ token error:', e.message); return null; }
}

// Generic CJ API call
async function cjAPI(path, method = 'GET', body = null) {
  const token = await getCJToken();
  if (!token) throw new Error('CJ not configured');
  const opts = { method, headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${CJ_BASE}${path}`, opts);
  return r.json();
}

// Search CJ product catalog
async function cjSearchProducts(keyword, page = 1, pageSize = 20) {
  return cjAPI(`/product/list?productNameEn=${encodeURIComponent(keyword)}&pageNum=${page}&pageSize=${pageSize}`);
}

// Get full product detail + variants
async function cjGetProduct(pid) {
  return cjAPI(`/product/query?pid=${encodeURIComponent(pid)}`);
}

// Get real-time stock + price for a variant
async function cjGetVariantInfo(vid) {
  return cjAPI(`/product/variant/queryByVid?vid=${encodeURIComponent(vid)}`);
}

// Place a fulfilment order with CJ
async function cjPlaceOrder(orderData) {
  return cjAPI('/shopping/order/createOrder', 'POST', orderData);
}

// Get order status from CJ
async function cjGetOrder(cjOrderId) {
  return cjAPI(`/shopping/order/getOrderDetail?orderId=${encodeURIComponent(cjOrderId)}`);
}

// Get tracking info
async function cjGetTracking(trackNumber) {
  return cjAPI(`/logistic/getTrackInfo?trackNumber=${encodeURIComponent(trackNumber)}`);
}

// Verify Shopify webhook HMAC signature
function verifyShopifyHmac(rawBody, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('⚠️  SHOPIFY_WEBHOOK_SECRET not set — webhook open to anyone. Add it to .env!');
    return true; // open during dev, but logs warning every time
  }
  if (!hmacHeader) return false;
  const digest = crypto.createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

// Auto-fulfil a Shopify order through CJ
async function autoFulfil(shopifyOrder) {
  const ship = shopifyOrder.shipping_address;
  if (!ship) return { skipped: true, reason: 'No shipping address' };

  // Build CJ line items from mapped products
  const cjProducts = [];
  const unmapped   = [];
  for (const item of shopifyOrder.line_items || []) {
    const mapped = dsProducts.get(String(item.variant_id)) || dsProducts.get(String(item.product_id));
    if (!mapped) { unmapped.push(item.name); continue; }
    cjProducts.push({ vid: mapped.cjSku, quantity: item.quantity });
  }

  if (!cjProducts.length) {
    console.log(`Order #${shopifyOrder.order_number}: no mapped products (unmapped: ${unmapped.join(', ')})`);
    return { skipped: true, reason: `Products not in catalogue: ${unmapped.join(', ')}`, unmapped };
  }

  const orderPayload = {
    orderNumber:          String(shopifyOrder.order_number),
    shippingZip:          ship.zip          || '',
    shippingCountryCode:  ship.country_code  || '',
    shippingCountry:      ship.country       || '',
    shippingProvince:     ship.province      || '',
    shippingCity:         ship.city          || '',
    shippingAddress:      ship.address1      || '',
    shippingAddress2:     ship.address2      || '',
    shippingCustomerName: `${ship.first_name || ''} ${ship.last_name || ''}`.trim(),
    shippingPhone:        ship.phone || shopifyOrder.phone || '',
    remark:               `Shopify #${shopifyOrder.order_number} — auto via Aria`,
    products:             cjProducts,
  };

  try {
    const result = await cjPlaceOrder(orderPayload);
    if (!result.result) throw new Error(result.message || 'CJ order failed');

    const cjOrderId = result.data?.orderId;
    const record = {
      shopifyOrderId:     shopifyOrder.id,
      shopifyOrderNumber: shopifyOrder.order_number,
      cjOrderId,
      status:       'processing',
      customer:     { name: orderPayload.shippingCustomerName, email: shopifyOrder.email },
      items:        shopifyOrder.line_items?.map(i => i.name),
      unmapped,
      createdAt:    new Date(),
      tracking:     null,
      trackNumber:  null,
    };
    dsOrders.push(record);
    save('dsOrders', dsOrders);
    console.log(`✅ Auto-fulfilled Shopify #${shopifyOrder.order_number} → CJ ${cjOrderId}`);

    // Notify store owner
    const adminUrl = `http://localhost:${process.env.PORT||3000}/admin?pass=${ADMIN}`;
    const alertTo  = process.env.NOTIFY_EMAIL;
    if (alertTo) {
      sendEmail({
        to: alertTo, subject: `📦 Auto-fulfilled: Order #${shopifyOrder.order_number}`,
        html: wrap(`
          <h2 style="margin:0 0 16px;color:#1a1a2e">📦 Order Auto-Fulfilled</h2>
          <p style="font-size:14px;color:#444;margin-bottom:16px">Shopify order <strong>#${shopifyOrder.order_number}</strong> was automatically placed with CJ Dropshipping.</p>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:6px 0;color:#999;width:120px">Customer</td><td style="font-weight:600">${record.customer.name}</td></tr>
            <tr><td style="padding:6px 0;color:#999">Email</td><td><a href="mailto:${record.customer.email}" style="color:#6C63FF">${record.customer.email}</a></td></tr>
            <tr><td style="padding:6px 0;color:#999">CJ Order ID</td><td style="font-family:monospace">${cjOrderId}</td></tr>
            <tr><td style="padding:6px 0;color:#999">Items</td><td>${record.items?.join(', ')}</td></tr>
            ${unmapped.length ? `<tr><td style="padding:6px 0;color:#999">⚠️ Unmapped</td><td style="color:#e74c3c">${unmapped.join(', ')}</td></tr>` : ''}
          </table>
          <a href="${adminUrl}" style="display:inline-block;margin-top:18px;padding:10px 20px;background:#6C63FF;color:white;border-radius:10px;text-decoration:none;font-weight:600">View in Admin →</a>
        `, adminUrl),
      });
    }
    // Schedule tracking check: 6h, 24h, 48h after placement
    [6, 24, 48].forEach(h => setTimeout(() => pollTracking(record), h * 3_600_000));
    return { ok: true, cjOrderId, unmapped };
  } catch (e) {
    console.error(`CJ order error for #${shopifyOrder.order_number}:`, e.message);
    // Alert owner immediately — silent failures cost money
    const alertTo = process.env.NOTIFY_EMAIL;
    if (alertTo) {
      sendEmail({
        to:      alertTo,
        subject: `⚠️ Auto-fulfil FAILED: Shopify #${shopifyOrder.order_number}`,
        html:    wrap(`
          <h2 style="margin:0 0 16px;color:#e74c3c">⚠️ Fulfilment Failed</h2>
          <p style="font-size:14px;color:#444;margin-bottom:16px">
            Shopify order <strong>#${shopifyOrder.order_number}</strong> could NOT be automatically fulfilled via CJ Dropshipping.
          </p>
          <div style="background:#fdf0f0;border:1.5px solid #e74c3c40;border-radius:10px;padding:14px;margin-bottom:20px">
            <p style="font-size:13px;color:#e74c3c;font-weight:600">Error: ${e.message}</p>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px">
            <tr><td style="padding:5px 0;color:#999;width:100px">Customer</td><td>${shopifyOrder.shipping_address?.first_name||''} ${shopifyOrder.shipping_address?.last_name||''}</td></tr>
            <tr><td style="padding:5px 0;color:#999">Email</td><td>${shopifyOrder.email||'—'}</td></tr>
            <tr><td style="padding:5px 0;color:#999">Items</td><td>${shopifyOrder.line_items?.map(i=>i.name).join(', ')||'—'}</td></tr>
          </table>
          <p style="font-size:13px;color:#666">You need to fulfil this order manually. Log in to CJ Dropshipping and place the order, then update Shopify with the tracking number.</p>
        `, null, '#e74c3c'),
      });
    }
    return { error: e.message };
  }
}

// Poll CJ for tracking number and notify customer
async function pollTracking(record) {
  if (record.tracking) return; // already have it
  try {
    const detail = await cjGetOrder(record.cjOrderId);
    const trackNum = detail?.data?.trackNumber || detail?.data?.trackingNumber;
    if (!trackNum) return;
    record.trackNumber = trackNum;
    // Get carrier tracking info
    const trackInfo = await cjGetTracking(trackNum);
    const carrier   = trackInfo?.data?.carrierName || 'Carrier';
    const trackUrl  = trackInfo?.data?.trackUrl || `https://t.17track.net/en#nums=${trackNum}`;
    record.tracking  = { number: trackNum, carrier, url: trackUrl, updatedAt: new Date() };
    record.status    = 'shipped';
    save('dsOrders', dsOrders);
    // Sync fulfillment back to Shopify so order shows as "Fulfilled"
    if (record.shopifyOrderId && process.env.SHOPIFY_STORE && process.env.SHOPIFY_TOKEN) {
      (async () => {
        try {
          const shopBase = `https://${process.env.SHOPIFY_STORE}/admin/api/2024-01`;
          const shopHdr  = { 'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN, 'Content-Type': 'application/json' };
          // Create fulfillment location (need location ID)
          const locR = await fetch(`${shopBase}/locations.json`, { headers: shopHdr });
          const { locations } = await locR.json();
          const locationId = locations?.[0]?.id;
          if (locationId) {
            await fetch(`${shopBase}/orders/${record.shopifyOrderId}/fulfillments.json`, {
              method: 'POST', headers: shopHdr,
              body: JSON.stringify({ fulfillment: {
                location_id:     locationId,
                tracking_number: trackNum,
                tracking_company: carrier,
                tracking_url:    trackUrl,
                notify_customer: true,
              }}),
            });
            console.log(`✅ Shopify fulfillment updated for order ${record.shopifyOrderNumber}`);
          }
        } catch (e) { console.warn('Shopify fulfillment sync error:', e.message); }
      })();
    }

    // Email customer their tracking
    if (record.customer?.email) {
      sendEmail({
        to:      record.customer.email,
        subject: `📦 Your order #${record.shopifyOrderNumber} has shipped!`,
        html:    wrap(`
          <h2 style="margin:0 0 16px;color:#1a1a2e">Your order is on its way! 📦</h2>
          <p style="font-size:14px;color:#444;margin-bottom:20px">Hi ${record.customer.name?.split(' ')[0] || 'there'}! Great news — your order has shipped.</p>
          <div style="background:#f8f8fc;border-radius:12px;padding:18px;margin-bottom:20px">
            <p style="font-size:12px;font-weight:700;color:#999;margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px">Tracking details</p>
            <p style="font-size:15px;font-weight:700;color:#1a1a2e;margin-bottom:4px">${carrier}</p>
            <p style="font-size:14px;color:#6C63FF;font-family:monospace">${trackNum}</p>
          </div>
          <a href="${trackUrl}" style="display:inline-block;padding:11px 22px;background:#6C63FF;color:white;border-radius:10px;text-decoration:none;font-weight:600">Track your order →</a>
        `, null),
      });
    }
    console.log(`📮 Tracking sent for #${record.shopifyOrderNumber}: ${trackNum}`);
  } catch (e) { console.warn('Tracking poll error:', e.message); }
}

// ─── Shopify webhook (orders/paid) ────────────────────────────────────────────
// In Shopify: Settings → Notifications → Webhooks → Add webhook
// Event: Order payment  Format: JSON  URL: https://your-server.com/api/shopify/webhook
app.post('/api/shopify/webhook', async (req, res) => {
  const rawBody = req.body; // express.raw() gives us a Buffer here
  const hmac    = req.headers['x-shopify-hmac-sha256'];
  const topic   = req.headers['x-shopify-topic'] || '';

  // Verify signature
  if (!verifyShopifyHmac(rawBody, hmac)) {
    console.warn('Shopify webhook: invalid HMAC — rejected');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const order = JSON.parse(rawBody.toString());
  res.status(200).json({ ok: true }); // ACK Shopify immediately (must be < 5s)

  // Only auto-fulfil paid orders
  if (!topic.includes('orders/paid') && order.financial_status !== 'paid') return;

  console.log(`📬 Shopify webhook: order #${order.order_number} (${order.financial_status})`);
  setImmediate(() => autoFulfil(order)); // run async, don't hold up the response
});

// ─── Dropship admin: product catalogue ───────────────────────────────────────

// Search CJ catalogue from admin
app.get('/admin/dropship/search', async (req, res) => {
  if (req.query.pass !== ADMIN) return res.status(403).json({ error:'Unauthorised' });
  const keyword = req.query.q;
  if (!keyword) return res.status(400).json({ error:'Missing q' });
  try {
    const r = await cjSearchProducts(keyword);
    if (!r.result) return res.json({ products: [], message: r.message });
    res.json({ products: (r.data?.list || []).map(p => ({
      pid:       p.pid,
      title:     p.productNameEn,
      image:     p.productImage,
      category:  p.categoryName,
      sellPrice: p.sellPrice,
      variants:  p.variants?.length || 0,
    })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get CJ product variants
app.get('/admin/dropship/product/:pid', async (req, res) => {
  if (req.query.pass !== ADMIN) return res.status(403).json({ error:'Unauthorised' });
  try {
    const r = await cjGetProduct(req.params.pid);
    if (!r.result) return res.json({ error: r.message });
    res.json({ product: r.data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add/update a product mapping (Shopify variant → CJ variant)
app.post('/admin/dropship/map', (req, res) => {
  if (req.query.pass !== ADMIN) return res.status(403).json({ error:'Unauthorised' });
  const { shopifyVariantId, cjSku, cjPid, title, costPrice, sellPrice, imageUrl } = req.body;
  if (!shopifyVariantId || !cjSku) return res.status(400).json({ error:'Missing fields' });
  dsProducts.set(String(shopifyVariantId), { cjSku, cjPid, title, costPrice, sellPrice, imageUrl, addedAt: new Date() });
  save('dsProducts', Array.from(dsProducts.entries()));
  res.json({ ok: true, total: dsProducts.size });
});

// Remove a product mapping
app.delete('/admin/dropship/map/:id', (req, res) => {
  if (req.query.pass !== ADMIN) return res.status(403).json({ error:'Unauthorised' });
  dsProducts.delete(req.params.id);
  save('dsProducts', Array.from(dsProducts.entries()));
  res.json({ ok: true });
});

// Manually trigger fulfilment (for testing or missed webhooks)
app.post('/admin/dropship/fulfil/:orderId', async (req, res) => {
  if (req.query.pass !== ADMIN) return res.status(403).json({ error:'Unauthorised' });
  const { SHOPIFY_STORE: store, SHOPIFY_TOKEN: token } = process.env;
  if (!store || !token) return res.status(400).json({ error:'Shopify not configured' });
  try {
    const r = await fetch(`https://${store}/admin/api/2024-01/orders/${req.params.orderId}.json`, { headers:{ 'X-Shopify-Access-Token':token } });
    const { order } = await r.json();
    if (!order) return res.status(404).json({ error:'Order not found' });
    const result = await autoFulfil(order);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Poll tracking for all untracked orders
app.post('/admin/dropship/poll-tracking', async (req, res) => {
  if (req.query.pass !== ADMIN) return res.status(403).json({ error:'Unauthorised' });
  const untracked = dsOrders.filter(o => !o.tracking && o.cjOrderId);
  await Promise.allSettled(untracked.map(pollTracking));
  res.json({ ok: true, polled: untracked.length });
});

// Dropship data for admin
app.get('/admin/dropship/data', (req, res) => {
  if (req.query.pass !== ADMIN) return res.status(403).json({ error:'Unauthorised' });
  const today = new Date().toDateString();
  const todayOrders = dsOrders.filter(o => new Date(o.createdAt).toDateString() === today);
  const shipped     = dsOrders.filter(o => o.status === 'shipped');
  res.json({
    catalogue:   Array.from(dsProducts.entries()).map(([shopifyId, p]) => ({ shopifyId, ...p })),
    orders:      dsOrders.slice().reverse().slice(0, 100),
    stats: {
      total:       dsOrders.length,
      today:       todayOrders.length,
      shipped:     shipped.length,
      pending:     dsOrders.filter(o => o.status === 'processing').length,
      products:    dsProducts.size,
      cjConnected: !!process.env.CJ_EMAIL && !!process.env.CJ_API_KEY,
    },
  });
});

// ─── Shopify order lookup ─────────────────────────────────────────────────────
app.get('/api/shopify/order', async (req, res) => {
  const store = process.env.SHOPIFY_STORE, token = process.env.SHOPIFY_TOKEN;
  if (!store || !token) return res.json({ error:'Shopify not configured' });
  const q = req.query.q;
  if (!q) return res.status(400).json({ error:'Missing query' });
  try {
    const param  = q.includes('@') ? `email=${encodeURIComponent(q)}` : `name=%23${encodeURIComponent(q)}`;
    const r = await fetch(`https://${store}/admin/api/2024-01/orders.json?${param}&status=any&fields=id,name,email,financial_status,fulfillment_status,created_at,tracking_url,line_items`, { headers:{ 'X-Shopify-Access-Token':token } });
    const { orders } = await r.json();
    if (!orders?.length) return res.json({ found:false });
    const o = orders[0];
    res.json({ found:true, order:{ number:o.name, status:o.financial_status, fulfillment:o.fulfillment_status||'unfulfilled', items:o.line_items?.map(i=>i.name).join(', '), date:new Date(o.created_at).toLocaleDateString(), tracking:o.tracking_url } });
  } catch { res.status(500).json({ error:'Shopify error' }); }
});

// ─── Handoff (live chat) ──────────────────────────────────────────────────────
app.post('/api/handoff', (req, res) => {
  const { sessionId, page, url, ownerEmail, siteName } = req.body;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  handoffs.set(id, { id, sessionId, page, url, ownerEmail, siteName, userMessages:[], agentMessages:[], status:'waiting', ts:new Date() });
  const adminUrl  = `${process.env.BASE_URL||'http://localhost:3000'}/admin?pass=${ADMIN}`;
  const alertTo   = ownerTo(ownerEmail);
  // Email alert to site owner
  sendEmail({ to:alertTo, subject:`🙋 Live chat requested — ${siteName||page}`, html:`<p>Someone on <strong>${siteName||page}</strong> has requested a live agent.<br><a href="${adminUrl}">Open admin to respond →</a></p>` });
  // Slack
  slack([{ type:'section', text:{ type:'mrkdwn', text:`🙋 *Live chat requested* on ${siteName||page}\n<${adminUrl}|Open admin to respond>` } }], 'Live chat requested');
  res.json({ id });
});

app.get('/api/handoff/:id', (req, res) => {
  const h = handoffs.get(req.params.id);
  if (!h) return res.status(404).json({ error:'Not found' });
  // Return agent messages to client (for polling) — admin gets full view via /admin/data
  res.json({ messages: h.agentMessages, status: h.status });
});

app.post('/api/handoff/:id/message', (req, res) => {
  const h = handoffs.get(req.params.id);
  if (!h) return res.status(404).json({ error:'Not found' });
  const { role = 'agent', text } = req.body;
  if (role === 'agent') {
    // Only admins can send agent messages
    if (req.query.pass !== ADMIN) return res.status(403).json({ error:'Unauthorised' });
    h.agentMessages.push({ role:'agent', text, ts:new Date() });
    h.status = 'active';
  } else {
    // User messages stored so admin can see them in the chat panel
    h.userMessages.push({ role:'user', text, ts:new Date() });
  }
  res.json({ ok:true });
});

app.put('/api/handoff/:id/close', (req, res) => {
  if (req.query.pass !== ADMIN) return res.status(403).json({ error:'Unauthorised' });
  const h = handoffs.get(req.params.id);
  if (h) { h.status = 'closed'; }
  res.json({ ok:true });
});

// ─── NPS ──────────────────────────────────────────────────────────────────────
app.post('/api/nps', (req, res) => {
  const { score, comment, sessionId, page } = req.body;
  npsScores.push({ score, comment, sessionId, page, ts:new Date() });
  if (sessionId) saveSession(sessionId, { nps:score, npsComment:comment });
  res.json({ ok:true });
});

// ─── A/B tracking ─────────────────────────────────────────────────────────────
app.post('/api/ab', (req, res) => {
  const { variant, event } = req.body; // event: open | lead | booking
  if (!abResults[variant]) return res.status(400).json({ error:'Invalid variant' });
  if (event === 'open')    abResults[variant].opens++;
  if (event === 'lead')    abResults[variant].leads++;
  if (event === 'booking') abResults[variant].bookings = (abResults[variant].bookings||0)+1;
  res.json({ ok:true });
});

// ─── Knowledge gaps ───────────────────────────────────────────────────────────
app.post('/api/gap', (req, res) => {
  const { question, page, url } = req.body;
  if (!question?.trim()) return res.json({ ok:true });
  gaps.unshift({ question: question.trim(), page, url, ts: new Date() });
  if (gaps.length > 300) gaps.length = 300;
  save('gaps', gaps, 2000);
  res.json({ ok:true });
});

// ─── Lead status management ───────────────────────────────────────────────────
app.patch('/admin/lead/:email/status', (req, res) => {
  if (req.query.pass !== ADMIN) return res.status(403).json({ error:'Unauthorised' });
  const { status, notes } = req.body;
  const valid = ['new','contacted','converted','lost'];
  if (!valid.includes(status)) return res.status(400).json({ error:'Invalid status' });
  const existing = leadStatuses.get(req.params.email) || {};
  leadStatuses.set(req.params.email, { ...existing, status, notes: notes ?? existing.notes, updatedAt: new Date() });
  save('leadStatuses', Array.from(leadStatuses.entries()));
  res.json({ ok:true });
});

// ─── Usage & Settings ─────────────────────────────────────────────────────────
app.get('/admin/usage', (req, res) => {
  if (req.query.pass !== ADMIN) return res.status(403).json({ error:'Unauthorised' });
  const cap = siteSettings.capEnabled ? siteSettings.capMessages : null;
  const pct = cap ? Math.round((usage.messages / cap) * 100) : null;
  res.json({ month: usageMonth, ...usage, cap, capEnabled: siteSettings.capEnabled, capPct: pct });
});

app.get('/admin/settings', (req, res) => {
  if (req.query.pass !== ADMIN) return res.status(403).json({ error:'Unauthorised' });
  res.json(siteSettings);
});

app.post('/admin/settings', (req, res) => {
  if (req.query.pass !== ADMIN) return res.status(403).json({ error:'Unauthorised' });
  const allowed = [
    'capEnabled','capMessages','capWarningAt',
    'botName','botColor','welcomeMsg','businessType',
    'businessName','businessTagline','businessLocation','businessPhone',
    'businessEmail','businessHours','businessServices','businessPrices',
    'businessArea','businessExtra',
  ];
  allowed.forEach(k => { if (req.body[k] !== undefined) siteSettings[k] = req.body[k]; });
  save('siteSettings', siteSettings);
  res.json({ ok:true, settings: siteSettings });
});

// Public config endpoint — widget fetches this on load to pick up live bot settings
// Only exposes appearance fields, never admin/business-private data
app.get('/api/config', (req, res) => {
  res.json({
    botName:      siteSettings.botName     || null,
    botColor:     siteSettings.botColor    || null,
    welcomeMsg:   siteSettings.welcomeMsg  || null,
    businessType: siteSettings.businessType || null,
    businessName: siteSettings.businessName || null,
  });
});

// ─── FAQ ──────────────────────────────────────────────────────────────────────
app.get('/api/faqs', (req, res) => res.json(Array.from(faqs.values()).filter(f=>f.approved)));

app.post('/admin/faq', (req, res) => {
  if (req.query.pass !== ADMIN) return res.status(403).json({ error:'Unauthorised' });
  const { question, answer } = req.body;
  if (!question||!answer) return res.status(400).json({ error:'Missing fields' });
  const id = faqSeq++;
  faqs.set(id, { id, question, answer, approved:true, hits:0, ts:new Date() });
  save('faqs', Array.from(faqs.values()));
  res.json({ ok:true, id });
});

app.delete('/admin/faq/:id', (req, res) => {
  if (req.query.pass !== ADMIN) return res.status(403).json({ error:'Unauthorised' });
  faqs.delete(parseInt(req.params.id));
  save('faqs', Array.from(faqs.values()));
  res.json({ ok:true });
});

// ─── Auto FAQ generation ──────────────────────────────────────────────────────
app.post('/admin/generate-faq', async (req, res) => {
  if (req.query.pass !== ADMIN) return res.status(403).json({ error:'Unauthorised' });
  const allMsgs = Array.from(sessions.values()).flatMap(s=>(s.messages||[]).filter(m=>m.role==='user').map(m=>m.content)).slice(0,200);
  if (allMsgs.length < 5) return res.json({ faqHtml:'<p>Not enough conversations yet. Come back after 20+ chats.</p>' });
  try {
    const r = await claude.messages.create({
      model:'claude-sonnet-4-6', max_tokens:2000,
      messages:[{ role:'user', content:`You are generating a FAQ page from real chatbot conversations.
Here are the most recent user questions (${allMsgs.length} messages):
${allMsgs.slice(-100).join('\n')}

Group into 6-10 FAQ topics with clear questions and concise answers.
Return clean HTML only (no markdown, no code blocks): use <h3> for questions, <p> for answers, wrapped in <div class="faq-section">.` }],
    });
    res.json({ faqHtml:r.content[0].text });
  } catch { res.status(500).json({ error:'AI error' }); }
});

// ─── Admin data ───────────────────────────────────────────────────────────────
app.get('/admin/data', (req, res) => {
  if (req.query.pass !== ADMIN) return res.status(403).json({ error:'Unauthorised' });
  const all    = Array.from(sessions.values()).sort((a,b)=>new Date(b.lastActivity)-new Date(a.lastActivity));
  const today  = new Date().toDateString();
  const todayS = all.filter(s=>new Date(s.startedAt).toDateString()===today);
  const freq   = {};
  all.forEach(s=>(s.messages||[]).filter(m=>m.role==='user').forEach(m=>m.content.toLowerCase().split(/\W+/).filter(w=>w.length>4).forEach(w=>{freq[w]=(freq[w]||0)+1;})));
  const topWords = Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,20);
  const allLeads = all.flatMap(s=>(s.leads||[]).map(e=>({ email:e, score:s.score, tag:s.tag, page:s.page, hotLead:s.hotLead, ts:s.lastActivity })));
  const hotLeads = allLeads.filter(l=>l.score>=7);
  const todayLeads = allLeads.filter(l=>new Date(l.ts).toDateString()===today);
  const ratings  = all.filter(s=>s.rating).map(s=>s.rating);
  const avgRating = ratings.length?(ratings.reduce((a,b)=>a+b,0)/ratings.length).toFixed(1):null;
  const npsAvg   = npsScores.length?(npsScores.reduce((a,b)=>a+b.score,0)/npsScores.length).toFixed(1):null;
  const objections = all.filter(s=>s.topObjection).map(s=>s.topObjection).filter(Boolean);
  const topObj   = [...new Set(objections)].slice(0,5);
  const activeHandoffs = Array.from(handoffs.values()).filter(h=>h.status!=='closed');
  // Merge lead statuses into lead objects
  const allLeadsWithStatus = allLeads.map(l => ({ ...l, ...(leadStatuses.get(l.email)||{ status:'new', notes:'' }) }));
  const hotLeadsWithStatus = hotLeads.map(l => ({ ...l, ...(leadStatuses.get(l.email)||{ status:'new', notes:'' }) }));
  // Deduplicated gaps (same question asked multiple times = higher priority)
  const gapFreq = {};
  gaps.forEach(g => { const k = g.question.toLowerCase().slice(0,80); gapFreq[k] = (gapFreq[k]||0)+1; });
  const topGaps = Object.entries(gapFreq).sort((a,b)=>b[1]-a[1]).slice(0,30).map(([q,count])=>({ question:q, count, ts: gaps.find(g=>g.question.toLowerCase().slice(0,80)===q)?.ts }));
  res.json({ sessions:all, faqs:Array.from(faqs.values()), bookings, handoffs:activeHandoffs, npsScores, abResults, topWords, allLeads:allLeadsWithStatus, hotLeads:hotLeadsWithStatus, topObjections:topObj, gaps:topGaps,
    stats:{ total:all.length, today:todayS.length, leads:allLeads.length, leadsToday:todayLeads.length, avgRating, npsAvg, bookings:bookings.length, hotLeads:hotLeads.length, activeHandoffs:activeHandoffs.length, gaps:gaps.length } });
});

// ─── Admin dashboard ──────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  if (req.query.pass !== ADMIN) return res.send(`<!DOCTYPE html><html><head><title>Admin</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#0f0f1a;display:flex;align-items:center;justify-content:center;min-height:100vh;}.box{background:#1a1a2e;border-radius:16px;padding:40px;width:320px;text-align:center;}h2{color:#fff;margin-bottom:24px;}input{width:100%;padding:11px 15px;border-radius:10px;border:1.5px solid #2a2a44;background:#13131f;color:#fff;font-size:14px;outline:none;margin-bottom:12px;}input:focus{border-color:#6C63FF;}button{width:100%;padding:11px;background:#6C63FF;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;}</style></head><body><div class="box"><h2>🔐 Admin Login</h2><form onsubmit="event.preventDefault();window.location='/admin?pass='+document.getElementById('p').value"><input id="p" type="password" placeholder="Admin password" autofocus><button>Enter →</button></form></div></body></html>`);

  const PASS = ADMIN;
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aria Admin v5</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f1a;color:#e8e8f8;min-height:100vh;}
.top{background:#1a1a2e;border-bottom:1px solid #2a2a44;padding:13px 28px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;}
.top h1{font-size:17px;font-weight:700;color:#fff;}.top h1 span{color:#6C63FF;}
.top-btns{display:flex;gap:8px;}
.btn{background:#6C63FF;color:#fff;border:none;border-radius:8px;padding:7px 15px;font-size:13px;cursor:pointer;font-family:inherit;transition:opacity .15s;}
.btn:hover{opacity:.85;}.btn.ghost{background:transparent;border:1px solid #2a2a44;color:#c0c0e0;}
.btn.red{background:#e74c3c;}.btn.green{background:#2ecc71;color:#fff;}
.body{padding:22px 28px;max-width:1400px;margin:0 auto;}
.stats{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:20px;}
.stat{background:#1a1a2e;border-radius:12px;padding:16px;border:1px solid #2a2a44;}
.stat .n{font-size:28px;font-weight:800;color:#6C63FF;}.stat .hot{color:#ff4757;}
.stat .l{font-size:12px;color:#8888aa;margin-top:3px;}
.tabs{display:flex;gap:4px;margin-bottom:18px;border-bottom:1px solid #2a2a44;padding-bottom:0;overflow-x:auto;}
.tab{padding:9px 16px;font-size:13px;cursor:pointer;border-radius:8px 8px 0 0;color:#8888aa;border:none;background:none;font-family:inherit;border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap;}
.tab.on{color:#6C63FF;border-bottom-color:#6C63FF;background:#1a1a2e;}
.panel{display:none;}.panel.on{display:block;}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px;}
.card{background:#1a1a2e;border-radius:12px;padding:18px;border:1px solid #2a2a44;margin-bottom:14px;}
.card h3{font-size:13px;font-weight:600;color:#fff;margin-bottom:12px;padding-bottom:9px;border-bottom:1px solid #2a2a44;}
.ri{display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid #1e1e30;font-size:13px;}
.badge{padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;}
.b-hot{background:#ff475720;color:#ff4757;border:1px solid #ff475740;}
.b-sale{background:#2ecc7120;color:#2ecc71;border:1px solid #2ecc7140;}
.b-sup{background:#3498db20;color:#3498db;border:1px solid #3498db40;}
.b-comp{background:#e74c3c20;color:#e74c3c;border:1px solid #e74c3c40;}
.b-feed{background:#9b59b620;color:#9b59b6;border:1px solid #9b59b640;}
.session{background:#1a1a2e;border-radius:10px;border:1px solid #2a2a44;margin-bottom:8px;overflow:hidden;}
.shdr{padding:11px 14px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:10px;}
.shdr:hover{background:#22223a;}.stitle{font-size:13px;font-weight:600;color:#fff;}
.smeta{font-size:11.5px;color:#8888aa;margin-top:2px;}.sbadges{display:flex;gap:4px;flex-shrink:0;}
.smsgs{display:none;padding:10px 14px;border-top:1px solid #2a2a44;font-size:12.5px;}
.smsgs.open{display:block;}
.msg-r{padding:4px 0;border-bottom:1px solid #1e1e30;}
.msg-r .who{font-weight:600;margin-right:5px;}.msg-r.u .who{color:#8888aa;}.msg-r:not(.u) .who{color:#6C63FF;}
.msg-r .txt{color:#c0c0e0;}
input,textarea{background:#13131f;border:1.5px solid #2a2a44;color:#e8e8f8;border-radius:8px;padding:8px 12px;font-size:13px;outline:none;font-family:inherit;width:100%;}
input:focus,textarea:focus{border-color:#6C63FF;}
textarea{resize:vertical;min-height:60px;}
.faq-item{background:#1a1a2e;border:1px solid #2a2a44;border-radius:9px;padding:12px 14px;margin-bottom:7px;display:flex;align-items:start;justify-content:space-between;gap:10px;}
.faq-q{font-size:13px;font-weight:600;color:#fff;margin-bottom:3px;}.faq-a{font-size:12.5px;color:#a0a0c0;}
.del-btn{background:#e74c3c22;border:1px solid #e74c3c44;color:#e74c3c;border-radius:6px;padding:3px 9px;font-size:11.5px;cursor:pointer;font-family:inherit;flex-shrink:0;}
/* Lead pipeline */
.lead-row{background:#13131f;border-radius:9px;padding:12px 14px;margin-bottom:7px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.lead-email{color:#6C63FF;font-weight:700;font-size:13px;flex:1;min-width:160px;}
.lead-meta{font-size:11.5px;color:#8888aa;flex:1;}
.status-sel{background:#13131f;border:1.5px solid #2a2a44;color:#e8e8f8;border-radius:6px;padding:4px 8px;font-size:12px;outline:none;font-family:inherit;cursor:pointer;}
.status-sel:focus{border-color:#6C63FF;}
.b-new{background:#3498db20;color:#3498db;border:1px solid #3498db40;}
.b-contacted{background:#f39c1220;color:#f39c12;border:1px solid #f39c1240;}
.b-converted{background:#2ecc7120;color:#2ecc71;border:1px solid #2ecc7140;}
.b-lost{background:#e74c3c20;color:#e74c3c;border:1px solid #e74c3c40;}
/* Knowledge gaps */
.gap-row{padding:9px 0;border-bottom:1px solid #1e1e30;display:flex;align-items:center;gap:10px;}
.gap-q{font-size:13px;color:#e8e8f8;flex:1;}
.gap-cnt{font-size:11.5px;font-weight:700;color:#ff4757;min-width:30px;text-align:right;}
/* Handoff */
.handoff-chat{background:#13131f;border-radius:8px;padding:12px;max-height:250px;overflow-y:auto;margin-bottom:10px;}
.hm{padding:4px 0;font-size:13px;}.hm.agent{color:#6C63FF;font-weight:600;}.hm.user{color:#c0c0e0;}
.agent-input{display:flex;gap:8px;margin-top:8px;}
.agent-input input{flex:1;}
/* NPS */
.nps-bar{height:8px;background:#6C63FF;border-radius:4px;margin-top:4px;}
/* AB */
.ab-card{background:#1a1a2e;border-radius:10px;border:1px solid #2a2a44;padding:16px;text-align:center;}
.ab-n{font-size:32px;font-weight:800;color:#6C63FF;}.ab-rate{font-size:13px;color:#8888aa;margin-top:4px;}
.faq-html-preview{background:#f8f8fc;color:#333;border-radius:10px;padding:16px;font-size:13px;margin-top:14px;max-height:400px;overflow-y:auto;}
.faq-html-preview h3{margin:12px 0 6px;font-size:15px;color:#1a1a2e;}
.faq-html-preview p{color:#444;line-height:1.6;}
@media(max-width:900px){.stats{grid-template-columns:1fr 1fr}.row2{grid-template-columns:1fr}}
</style></head><body>
<div class="top">
  <h1>✦ <span>Aria</span> Admin v5</h1>
  <div class="top-btns">
    <button class="btn ghost" onclick="exportAll()">⬇ Export</button>
    <button class="btn" onclick="load()">⟳ Refresh</button>
  </div>
</div>
<div class="body">
  <div class="stats" id="stats"></div>
  <div class="tabs">
    <button class="tab on" onclick="tab('convos')">💬 Conversations</button>
    <button class="tab" onclick="tab('leads')">🎯 Pipeline</button>
    <button class="tab" onclick="tab('bookings')">📅 Bookings</button>
    <button class="tab" onclick="tab('dropship')">📦 Dropship</button>
    <button class="tab" onclick="tab('gaps')">🧩 Gaps</button>
    <button class="tab" onclick="tab('handoffs')">🙋 Live Chat</button>
    <button class="tab" onclick="tab('faq')">❓ FAQ</button>
    <button class="tab" onclick="tab('ab')">🧪 A/B</button>
    <button class="tab" onclick="tab('nps')">⭐ NPS</button>
    <button class="tab" onclick="tab('insights')">📊 Insights</button>
    <button class="tab" onclick="tab('gmail')">📧 Gmail</button>
    <button class="tab" onclick="tab('usage')">📈 Usage</button>
    <button class="tab" onclick="tab('settings')">⚙️ Settings</button>
  </div>

  <div id="p-convos" class="panel on"><div id="sessions"></div></div>

  <div id="p-leads" class="panel">
    <div class="card">
      <h3>🎯 Lead Pipeline</h3>
      <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
        <button class="btn ghost" style="font-size:12px;padding:5px 12px" onclick="filterLeads('all')">All</button>
        <button class="btn ghost" style="font-size:12px;padding:5px 12px" onclick="filterLeads('new')">🆕 New</button>
        <button class="btn ghost" style="font-size:12px;padding:5px 12px" onclick="filterLeads('contacted')">📞 Contacted</button>
        <button class="btn ghost" style="font-size:12px;padding:5px 12px" onclick="filterLeads('converted')">✅ Converted</button>
        <button class="btn ghost" style="font-size:12px;padding:5px 12px" onclick="filterLeads('lost')">❌ Lost</button>
      </div>
      <div id="lead-pipeline"></div>
    </div>
    <div class="card"><h3>🏷 Top Objections Heard</h3><div id="objections"></div></div>
  </div>

  <div id="p-dropship" class="panel">
    <!-- Stats row -->
    <div class="stats" id="ds-stats" style="margin-bottom:16px"></div>
    <div class="row2">
      <!-- Left: Order queue -->
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="card">
          <h3 style="display:flex;justify-content:space-between;align-items:center">
            📦 Order Queue
            <button class="btn ghost" style="font-size:11.5px;padding:4px 12px" onclick="pollTracking()">🔄 Poll tracking</button>
          </h3>
          <div id="ds-orders"></div>
        </div>
      </div>
      <!-- Right: Product catalogue + CJ search -->
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="card">
          <h3>🔍 Add Product from CJ Dropshipping</h3>
          <p style="font-size:12.5px;color:#8888aa;margin-bottom:12px">Search the CJ catalogue. Find a product, copy the variant ID, and link it to your Shopify variant.</p>
          <div style="display:flex;gap:8px;margin-bottom:12px">
            <input id="cj-search" placeholder="Search CJ: e.g. wireless earbuds" style="flex:1"/>
            <button class="btn" onclick="cjSearch()">Search</button>
          </div>
          <div id="cj-results" style="max-height:300px;overflow-y:auto"></div>
        </div>
        <div class="card">
          <h3>🔗 Map Product to CJ</h3>
          <p style="font-size:12.5px;color:#8888aa;margin-bottom:12px">Link a Shopify product variant to a CJ variant SKU so orders are auto-fulfilled.</p>
          <div style="display:grid;gap:8px;margin-bottom:12px">
            <div><label style="font-size:11.5px;color:#8888aa;display:block;margin-bottom:3px">Shopify Variant ID</label><input id="ds-shopify-id" placeholder="e.g. 12345678"/></div>
            <div><label style="font-size:11.5px;color:#8888aa;display:block;margin-bottom:3px">CJ Variant SKU (vid)</label><input id="ds-cj-sku" placeholder="e.g. BAO-001-RED-XL"/></div>
            <div><label style="font-size:11.5px;color:#8888aa;display:block;margin-bottom:3px">Product Name</label><input id="ds-title" placeholder="e.g. Wireless Earbuds Pro"/></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
              <div><label style="font-size:11.5px;color:#8888aa;display:block;margin-bottom:3px">Your Cost (£)</label><input id="ds-cost" type="number" step="0.01" placeholder="5.99"/></div>
              <div><label style="font-size:11.5px;color:#8888aa;display:block;margin-bottom:3px">Sell Price (£)</label><input id="ds-sell" type="number" step="0.01" placeholder="19.99"/></div>
            </div>
          </div>
          <button class="btn green" onclick="mapProduct()">Add to Catalogue ✓</button>
        </div>
        <div class="card">
          <h3>📋 Mapped Catalogue (<span id="ds-cat-count">0</span> products)</h3>
          <div id="ds-catalogue"></div>
        </div>
        <div class="card">
          <h3>⚙️ Setup Guide</h3>
          <div style="font-size:13px;color:#8888aa;line-height:1.9">
            <p><strong style="color:#6C63FF">Step 1</strong> — Add to <code>.env</code>:<br>
              <code style="background:#13131f;padding:2px 8px;border-radius:4px;font-size:12px;color:#2ecc71">CJ_EMAIL=your@email.com</code><br>
              <code style="background:#13131f;padding:2px 8px;border-radius:4px;font-size:12px;color:#2ecc71">CJ_API_KEY=your-cj-api-key</code>
            </p>
            <p><strong style="color:#6C63FF">Step 2</strong> — In Shopify: Settings → Notifications → Webhooks<br>
              Add webhook: <strong>Order payment</strong> → <code style="background:#13131f;padding:2px 8px;border-radius:4px;font-size:12px;color:#2ecc71">https://your-server.com/api/shopify/webhook</code><br>
              Copy the webhook secret → add to <code>.env</code>:<br>
              <code style="background:#13131f;padding:2px 8px;border-radius:4px;font-size:12px;color:#2ecc71">SHOPIFY_WEBHOOK_SECRET=whsec_xxx</code>
            </p>
            <p><strong style="color:#6C63FF">Step 3</strong> — Map your products above using CJ search</p>
            <p><strong style="color:#6C63FF">Step 4</strong> — Test: place a test order in Shopify → it auto-appears here</p>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div id="p-gaps" class="panel">
    <div class="card">
      <h3>🧩 Knowledge Gaps — questions your bot couldn't answer</h3>
      <p style="font-size:13px;color:#8888aa;margin-bottom:16px">These are questions visitors asked that the bot couldn't answer from your site content. Add them to your FAQs or site content to fill the gaps.</p>
      <div id="gaps-list"></div>
    </div>
  </div>

  <div id="p-bookings" class="panel">
    <div class="card"><h3>📅 Booking Requests</h3><div id="booking-list"></div></div>
  </div>

  <div id="p-handoffs" class="panel">
    <div class="card"><h3>🙋 Active Live Chat Sessions</h3><div id="handoff-list"></div></div>
  </div>

  <div id="p-faq" class="panel">
    <div class="card">
      <h3>Add FAQ — Instant answers, zero AI cost</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:start;margin-bottom:16px">
        <div><label style="font-size:11.5px;color:#8888aa;display:block;margin-bottom:4px">Question / keyword</label><input id="faq-q" placeholder="e.g. opening hours"/></div>
        <div><label style="font-size:11.5px;color:#8888aa;display:block;margin-bottom:4px">Answer</label><textarea id="faq-a" style="min-height:42px" placeholder="We're open Mon-Fri 9-5pm"></textarea></div>
        <div style="padding-top:18px"><button class="btn" onclick="addFAQ()">Add ✓</button></div>
      </div>
      <div id="faq-list"></div>
    </div>
    <div class="card">
      <h3>💡 Suggested from conversations</h3>
      <div id="suggested-faqs"></div>
    </div>
    <div class="card">
      <h3>🤖 Auto-generate FAQ page</h3>
      <p style="font-size:13px;color:#8888aa;margin-bottom:12px">AI analyses all conversations and writes a ready-to-publish FAQ page.</p>
      <button class="btn" onclick="generateFAQ()">Generate FAQ page</button>
      <div id="faq-preview"></div>
    </div>
  </div>

  <div id="p-ab" class="panel">
    <div class="card">
      <h3>🧪 A/B Test Results</h3>
      <p style="font-size:12.5px;color:#8888aa;margin-bottom:16px">Configure variants with <code style="background:#13131f;padding:2px 6px;border-radius:4px;color:#6C63FF">data-ab-test</code> on the script tag.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px" id="ab-cards"></div>
    </div>
  </div>

  <div id="p-nps" class="panel">
    <div class="card"><h3>⭐ NPS Scores</h3><div id="nps-list"></div></div>
  </div>

  <div id="p-gmail" class="panel">
    <div class="card">
      <h3>📧 Gmail Connections</h3>
      <p style="font-size:13px;color:#8888aa;margin-bottom:16px">Send each client their connect link. Once they sign in with Google, their chatbot emails will come from their own Gmail address.</p>
      <div style="display:flex;gap:8px;margin-bottom:20px">
        <input id="gmail-email" placeholder="client@gmail.com" style="flex:1"/>
        <button class="btn" onclick="genGmailLink()">Generate Link</button>
      </div>
      <div id="gmail-link-out" style="display:none;background:#13131f;border-radius:8px;padding:12px;margin-bottom:16px">
        <div style="font-size:11.5px;color:#8888aa;margin-bottom:6px">Send this link to your client:</div>
        <div id="gmail-link-url" style="font-size:13px;color:#6C63FF;word-break:break-all"></div>
        <button class="btn" style="margin-top:10px;font-size:12px;padding:6px 14px" onclick="copyGmailLink()">Copy link</button>
      </div>
      <h3 style="margin-bottom:12px;border-top:1px solid #2a2a44;padding-top:14px">Connected Accounts</h3>
      <div id="gmail-connections"><div style="color:#8888aa;font-size:13px">No Gmail accounts connected yet.</div></div>
    </div>
    <div class="card">
      <h3>How it works</h3>
      <div style="font-size:13px;color:#8888aa;line-height:1.8">
        <p>1. Enter your client's Gmail address above → copy the link</p>
        <p>2. Send it to them (email, WhatsApp, wherever)</p>
        <p>3. They click it → sign in with Google → done in 30 seconds</p>
        <p>4. All chatbot emails now send <strong style="color:#e8e8f8">from their Gmail</strong> — leads, bookings, follow-ups</p>
        <p>5. Visitors reply directly to them, they reply directly back</p>
      </div>
    </div>
  </div>

  <div id="p-insights" class="panel">
    <div class="row2">
      <div class="card"><h3>🔥 Top Topics</h3><div id="words"></div></div>
      <div class="card"><h3>🏷 Conversation Types</h3><div id="tags"></div></div>
    </div>
    <div class="card">
      <h3>😊 Sentiment Breakdown</h3>
      <div id="sentiment"></div>
    </div>
  </div>

  <div id="p-usage" class="panel">
    <div class="card">
      <h3>📈 Usage This Month</h3>
      <div id="usage-content" style="margin-top:16px"><div style="color:#8888aa;font-size:13px">Loading...</div></div>
    </div>
    <div class="card">
      <h3>💰 Cost Guide</h3>
      <div style="font-size:13px;color:#8888aa;line-height:1.9">
        <p>Model: <strong style="color:#e8e8f8">Claude Haiku</strong> — cheapest, fastest</p>
        <p>Input: <strong style="color:#e8e8f8">$0.80</strong> per 1M tokens</p>
        <p>Output: <strong style="color:#e8e8f8">$4.00</strong> per 1M tokens</p>
        <p style="margin-top:10px;padding-top:10px;border-top:1px solid #2a2a44">A typical conversation (10 messages) costs roughly <strong style="color:#2ecc71">$0.003</strong></p>
        <p>500 chats/month ≈ <strong style="color:#2ecc71">~$1.50</strong></p>
        <p>2,000 chats/month ≈ <strong style="color:#2ecc71">~$6.00</strong></p>
        <p style="margin-top:10px;padding-top:10px;border-top:1px solid #2a2a44;color:#e8e8f8">You charge: £20–50/month. Margin: ~98%.</p>
      </div>
    </div>
  </div>

  <div id="p-settings" class="panel">
    <div class="card">
      <h3>🏢 Business Profile</h3>
      <p style="font-size:13px;color:#8888aa;margin-bottom:18px">Fill this in when you hand over a site. The bot will know everything here and answer customer questions accurately.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
        <label style="display:block">
          <div style="font-size:12px;color:#8888aa;margin-bottom:5px">Business name</div>
          <input id="s-businessName" placeholder="e.g. Joe's Pizza" style="width:100%"/>
        </label>
        <label style="display:block">
          <div style="font-size:12px;color:#8888aa;margin-bottom:5px">Tagline / what they do</div>
          <input id="s-businessTagline" placeholder="e.g. Award-winning pizza in Manchester" style="width:100%"/>
        </label>
        <label style="display:block">
          <div style="font-size:12px;color:#8888aa;margin-bottom:5px">Location / address</div>
          <input id="s-businessLocation" placeholder="e.g. 12 High St, Manchester" style="width:100%"/>
        </label>
        <label style="display:block">
          <div style="font-size:12px;color:#8888aa;margin-bottom:5px">Service / delivery area</div>
          <input id="s-businessArea" placeholder="e.g. Within 5 miles of Manchester city centre" style="width:100%"/>
        </label>
        <label style="display:block">
          <div style="font-size:12px;color:#8888aa;margin-bottom:5px">Phone number</div>
          <input id="s-businessPhone" placeholder="e.g. 0161 123 4567" style="width:100%"/>
        </label>
        <label style="display:block">
          <div style="font-size:12px;color:#8888aa;margin-bottom:5px">Email address</div>
          <input id="s-businessEmail" placeholder="e.g. hello@joespizza.co.uk" style="width:100%"/>
        </label>
      </div>
      <label style="display:block;margin-bottom:14px">
        <div style="font-size:12px;color:#8888aa;margin-bottom:5px">Opening hours</div>
        <input id="s-businessHours" placeholder="e.g. Mon–Fri 9am–6pm, Sat 10am–4pm, closed Sunday" style="width:100%"/>
      </label>
      <label style="display:block;margin-bottom:14px">
        <div style="font-size:12px;color:#8888aa;margin-bottom:5px">Services / products</div>
        <textarea id="s-businessServices" rows="3" placeholder="List what they offer, one per line or as a paragraph. e.g. Margherita pizza £9, Pepperoni £11, Gluten-free bases available..." style="width:100%;background:#13131f;border:1.5px solid #2a2a44;color:#e8e8f8;border-radius:8px;padding:9px 12px;font-size:13px;outline:none;resize:vertical;font-family:inherit"></textarea>
      </label>
      <label style="display:block;margin-bottom:14px">
        <div style="font-size:12px;color:#8888aa;margin-bottom:5px">Pricing info</div>
        <textarea id="s-businessPrices" rows="2" placeholder="e.g. Small from £8, Large from £13. 10% off on Tuesdays. Free delivery over £20." style="width:100%;background:#13131f;border:1.5px solid #2a2a44;color:#e8e8f8;border-radius:8px;padding:9px 12px;font-size:13px;outline:none;resize:vertical;font-family:inherit"></textarea>
      </label>
      <label style="display:block;margin-bottom:18px">
        <div style="font-size:12px;color:#8888aa;margin-bottom:5px">Anything else the bot should know</div>
        <textarea id="s-businessExtra" rows="3" placeholder="e.g. We're halal certified. Parking is free on site. We do not take walk-ins on weekends. Dogs welcome in the courtyard." style="width:100%;background:#13131f;border:1.5px solid #2a2a44;color:#e8e8f8;border-radius:8px;padding:9px 12px;font-size:13px;outline:none;resize:vertical;font-family:inherit"></textarea>
      </label>
      <button class="btn" onclick="saveProfile()">Save business profile</button>
      <span id="profile-saved" style="display:none;margin-left:12px;font-size:12px;color:#2ecc71">✓ Saved — bot updated immediately</span>
    </div>
    <div class="card">
      <h3>⚙️ Bot Appearance</h3>
      <p style="font-size:13px;color:#8888aa;margin-bottom:18px">Customise how the widget looks and introduces itself.</p>
      <div id="settings-form">
        <label style="display:block;margin-bottom:14px">
          <div style="font-size:12px;color:#8888aa;margin-bottom:5px">Bot name</div>
          <input id="s-botName" placeholder="e.g. Aria" style="width:100%"/>
        </label>
        <label style="display:block;margin-bottom:14px">
          <div style="font-size:12px;color:#8888aa;margin-bottom:5px">Brand colour (hex)</div>
          <input id="s-botColor" placeholder="e.g. #6C63FF" style="width:100%"/>
        </label>
        <label style="display:block;margin-bottom:14px">
          <div style="font-size:12px;color:#8888aa;margin-bottom:5px">Welcome message</div>
          <input id="s-welcomeMsg" placeholder="Hi! How can I help today?" style="width:100%"/>
        </label>
        <label style="display:block;margin-bottom:18px">
          <div style="font-size:12px;color:#8888aa;margin-bottom:5px">Business type</div>
          <select id="s-businessType" style="width:100%;background:#13131f;border:1.5px solid #2a2a44;color:#e8e8f8;border-radius:8px;padding:9px 12px;font-size:13px;outline:none;">
            <option value="">-- Select type --</option>
            <option value="restaurant">Restaurant</option>
            <option value="salon">Salon / Beauty</option>
            <option value="gym">Gym / Fitness</option>
            <option value="clinic">Clinic / Health</option>
            <option value="agency">Agency</option>
            <option value="ecommerce">E-commerce</option>
            <option value="law">Law / Legal</option>
            <option value="realestate">Real Estate</option>
            <option value="trades">Trades</option>
            <option value="generic">Generic</option>
          </select>
        </label>
        <button class="btn" onclick="saveSettings()">Save appearance</button>
        <span id="settings-saved" style="display:none;margin-left:12px;font-size:12px;color:#2ecc71">✓ Saved</span>
      </div>
    </div>
    <div class="card">
      <h3>🔒 Monthly Message Cap</h3>
      <p style="font-size:13px;color:#8888aa;margin-bottom:16px">Protect yourself from unexpected costs. When the cap is hit, the bot tells visitors to come back next month.</p>
      <label style="display:flex;align-items:center;gap:10px;margin-bottom:16px;cursor:pointer">
        <input type="checkbox" id="s-capEnabled" style="width:16px;height:16px;accent-color:#6C63FF">
        <span style="font-size:13px;color:#e8e8f8">Enable monthly cap</span>
      </label>
      <label style="display:block;margin-bottom:14px">
        <div style="font-size:12px;color:#8888aa;margin-bottom:5px">Max messages per month</div>
        <input id="s-capMessages" type="number" placeholder="1000" style="width:100%"/>
      </label>
      <label style="display:block;margin-bottom:18px">
        <div style="font-size:12px;color:#8888aa;margin-bottom:5px">Warn me when usage reaches (%)</div>
        <input id="s-capWarningAt" type="number" placeholder="80" min="10" max="100" style="width:100%"/>
      </label>
      <button class="btn" onclick="saveCap()">Save cap settings</button>
      <span id="cap-saved" style="display:none;margin-left:12px;font-size:12px;color:#2ecc71">✓ Saved</span>
    </div>
  </div>
</div>

<script>
const PASS = '${PASS}';
let _d = null;

async function load() {
  const r = await fetch('/admin/data?pass='+PASS);
  _d = await r.json(); render(_d);
}

function render({ stats, sessions, faqs, bookings, handoffs, npsScores, abResults, topWords, allLeads, hotLeads, topObjections, gaps }) {
  el('stats').innerHTML = [
    stat(stats.total,'Total Sessions'), stat(stats.today,'Active Today'),
    \`<div class="stat"><div class="n"><span class="hot">\${stats.hotLeads}</span>/<span>\${stats.leads}</span></div><div class="l">Hot / Total Leads</div></div>\`,
    stat(stats.avgRating?stats.avgRating+'⭐':'—','Avg Rating'), stat(stats.activeHandoffs,'Live Chats'),
    \`<div class="stat"><div class="n" style="color:\${stats.gaps>0?'#ff4757':'#2ecc71'}">\${stats.gaps||0}</div><div class="l">Knowledge Gaps</div></div>\`,
  ].join('');

  // Sessions
  el('sessions').innerHTML = sessions.slice(0,80).map((s,i)=>{
    const tc={'Sale Opportunity':'b-sale','Support Request':'b-sup','Complaint':'b-comp','Feedback':'b-feed','Just Browsing':'b-feed'}[s.tag]||'b-feed';
    const bs=[s.leads?.length?'<span class="badge b-sale">Lead</span>':'',s.hotLead?'<span class="badge b-hot">Hot</span>':'',s.tag?\`<span class="badge \${tc}">\${s.tag}</span>\`:'',s.score?\`<span class="badge b-sup">\${s.score}/10</span>\`:'',s.nps!=null?\`<span class="badge b-feed">NPS:\${s.nps}</span>\`:''].filter(Boolean).join('');
    const msgs=(s.messages||[]).map(m=>\`<div class="msg-r \${m.role==='user'?'u':''}"><span class="who">\${m.role==='user'?'You':'Bot'}</span><span class="txt">\${esc(m.content?.slice(0,250))}</span></div>\`).join('');
    return \`<div class="session"><div class="shdr" onclick="tog(\${i})"><div><div class="stitle">\${esc(s.page||'Unknown')}</div><div class="smeta">\${new Date(s.startedAt).toLocaleString()} · \${s.messages?.length||0} msgs\${s.leads?.length?' · 📧 '+s.leads.join(', '):''}\${s.journey?.length?' · '+s.journey.length+' pages':''}</div></div><div class="sbadges">\${bs}</div></div><div class="smsgs" id="sm-\${i}">\${msgs||'<div style="color:#8888aa;font-size:12.5px;padding:6px 0">No messages</div>'}</div></div>\`;
  }).join('') || '<div style="color:#8888aa;padding:16px">No conversations yet</div>';

  // Lead pipeline
  window._allLeads = allLeads || [];
  renderLeadPipeline(window._allLeads);
  el('objections').innerHTML = (topObjections||[]).map(o=>\`<div class="ri"><span style="color:#e67e22">"\${esc(o)}"</span></div>\`).join('')||'<div style="color:#8888aa;font-size:13px">No objections tracked yet</div>';

  // Knowledge gaps
  el('gaps-list').innerHTML = (gaps||[]).length
    ? (gaps||[]).map(g=>\`<div class="gap-row"><div class="gap-q">"\${esc(g.question)}"</div><div style="display:flex;align-items:center;gap:8px"><span class="gap-cnt">\${g.count}×</span><button class="btn" style="font-size:11.5px;padding:4px 10px" onclick="prefillFAQ('\${esc(g.question)}')">Add FAQ</button></div></div>\`).join('')
    : '<div style="color:#2ecc71;font-size:13px;padding:8px 0">✓ No gaps detected — your bot is answering everything!</div>';

  // Bookings
  el('booking-list').innerHTML = (bookings||[]).slice().reverse().slice(0,30).map(b=>\`<div class="ri"><div><strong style="color:#fff">\${esc(b.name)}</strong> — <a href="mailto:\${b.email}" style="color:#6C63FF">\${b.email}</a> — <strong style="color:#6C63FF">\${esc(b.datetime)}</strong><div style="font-size:11px;color:#8888aa;margin-top:3px">\${esc(b.siteName||b.page||'')} · \${new Date(b.ts).toLocaleString()}\${b.calendarAdded?'&nbsp;<span style="color:#2ecc71">✓ Calendar</span>':''}</div></div><div style="display:flex;gap:6px">\${b.calendarLink?'<a href="'+b.calendarLink+'" target="_blank" class="btn ghost" style="font-size:11.5px;padding:4px 10px;text-decoration:none">📅 View</a>':''}<a href="mailto:\${b.email}?subject=Booking Confirmation" class="btn" style="font-size:11.5px;padding:4px 10px">Confirm</a></div></div>\`).join('')||'<div style="color:#8888aa;font-size:13px">No bookings yet</div>';

  // Handoffs
  el('handoff-list').innerHTML = (handoffs||[]).map(h=>\`
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div><strong style="color:#fff">\${esc(h.page||'Unknown page')}</strong> <span class="badge \${h.status==='waiting'?'b-hot':'b-sale'}">\${h.status}</span></div>
        <button class="btn red" style="font-size:11.5px;padding:4px 10px" onclick="closeHandoff('\${h.id}')">Close</button>
      </div>
      <div class="handoff-chat" id="hchat-\${h.id}">
        \${[...(h.userMessages||[]).map(m=>({...m,_who:'user'})), ...(h.agentMessages||[]).map(m=>({...m,_who:'agent'}))]
          .sort((a,b)=>new Date(a.ts)-new Date(b.ts))
          .map(m=>\`<div class="hm \${m._who==='agent'?'agent':''}">\${m._who==='agent'?'[You]':'[User]'} \${esc(m.text||m.content||'')}</div>\`).join('')||'<div style="color:#666;font-size:12px">Waiting for messages...</div>'}
      </div>
      <div class="agent-input">
        <input id="hinp-\${h.id}" placeholder="Type your reply..." onkeydown="if(event.key==='Enter')sendHandoff('\${h.id}')"/>
        <button class="btn green" style="font-size:12px;padding:7px 14px" onclick="sendHandoff('\${h.id}')">Send</button>
      </div>
    </div>\`).join('')||'<div style="color:#8888aa;font-size:13px">No active live chats</div>';

  // FAQs
  renderFAQs(faqs||[]);
  el('suggested-faqs').innerHTML = topWords.slice(0,8).map(([w,c])=>\`<div class="ri"><span style="color:#c0c0e0">\${w} (\${c}x)</span><button class="btn" style="font-size:11.5px;padding:4px 10px" onclick="prefillFAQ('\${w}')">Add FAQ</button></div>\`).join('')||'<div style="color:#8888aa;font-size:12.5px">Start conversations to see suggestions</div>';

  // A/B
  el('ab-cards').innerHTML = ['A','B'].map(v=>{
    const d = abResults[v]||{opens:0,leads:0};
    const rate = d.opens ? ((d.leads/d.opens)*100).toFixed(1) : 0;
    return \`<div class="ab-card"><div style="font-size:20px;font-weight:800;color:#888;margin-bottom:8px">Variant \${v}</div><div class="ab-n">\${d.leads}</div><div class="ab-rate">leads from \${d.opens} opens</div><div style="font-size:22px;font-weight:800;color:#2ecc71;margin-top:8px">\${rate}%</div><div class="ab-rate">conversion rate</div></div>\`;
  }).join('');

  // NPS
  const npsAvg = npsScores?.length ? (npsScores.reduce((a,b)=>a+b.score,0)/npsScores.length).toFixed(1) : null;
  el('nps-list').innerHTML = npsAvg ? \`<div style="font-size:32px;font-weight:800;color:#6C63FF;margin-bottom:16px">NPS: \${npsAvg}/10</div>\` + (npsScores||[]).reverse().slice(0,20).map(n=>\`<div class="ri"><span style="color:#fff;font-size:16px;font-weight:700">\${n.score}</span><span style="color:#c0c0e0;font-size:13px;flex:1;margin-left:12px">\${esc(n.comment||'No comment')}</span><span style="color:#8888aa;font-size:11px">\${new Date(n.ts).toLocaleDateString()}</span></div>\`).join('') : '<div style="color:#8888aa;font-size:13px">No NPS scores yet</div>';

  // Insights - words
  const maxW = topWords[0]?.[1]||1;
  el('words').innerHTML = topWords.slice(0,12).map(([w,c])=>\`<div class="ri"><span style="color:#c0c0e0">\${w}</span><div style="display:flex;align-items:center;gap:8px"><span style="color:#8888aa;font-size:12px">\${c}</span><div style="height:5px;background:#6C63FF;border-radius:3px;width:\${Math.round(c/maxW*80)}px"></div></div></div>\`).join('')||'<div style="color:#8888aa;font-size:13px">No data yet</div>';

  // Tags
  const tagCount={};
  (sessions||[]).forEach(s=>{if(s.tag)tagCount[s.tag]=(tagCount[s.tag]||0)+1;});
  const tagColors={'Sale Opportunity':'#2ecc71','Support Request':'#3498db','Complaint':'#e74c3c','Feedback':'#9b59b6','Just Browsing':'#95a5a6'};
  el('tags').innerHTML = Object.entries(tagCount).sort((a,b)=>b[1]-a[1]).map(([t,c])=>\`<div class="ri"><span style="color:\${tagColors[t]||'#ccc'}">\${t}</span><strong style="color:#fff">\${c}</strong></div>\`).join('')||'<div style="color:#8888aa;font-size:13px">No tagged sessions yet</div>';

  // Sentiment
  const sent={positive:0,neutral:0,negative:0};
  (sessions||[]).forEach(s=>{if(s.sentiment)sent[s.sentiment]=(sent[s.sentiment]||0)+1;});
  const total=Object.values(sent).reduce((a,b)=>a+b,0)||1;
  el('sentiment').innerHTML = [['positive','#2ecc71','😊'],['neutral','#f39c12','😐'],['negative','#e74c3c','😟']].map(([k,c,e])=>\`<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span>\${e} \${k}</span><span style="color:#fff">\${sent[k]||0}</span></div><div style="background:#2a2a44;border-radius:4px;height:8px"><div style="background:\${c};border-radius:4px;height:8px;width:\${Math.round((sent[k]||0)/total*100)}%"></div></div></div>\`).join('');
}

function renderFAQs(list) {
  el('faq-list').innerHTML = list.filter(f=>f.approved).map(f=>\`<div class="faq-item"><div><div class="faq-q">Q: \${esc(f.question)}</div><div class="faq-a">A: \${esc(f.answer)}</div></div><button class="del-btn" onclick="delFAQ(\${f.id})">✕</button></div>\`).join('')||'<div style="color:#8888aa;font-size:13px;padding:6px 0">No FAQs yet</div>';
}

async function addFAQ() {
  const q=el('faq-q').value.trim(),a=el('faq-a').value.trim();
  if(!q||!a)return;
  await fetch('/admin/faq?pass='+PASS,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:q,answer:a})});
  el('faq-q').value='';el('faq-a').value='';load();
}
async function delFAQ(id){await fetch('/admin/faq/'+id+'?pass='+PASS,{method:'DELETE'});load();}
function prefillFAQ(w){el('faq-q').value=w;el('faq-q').focus();tab('faq');}

async function generateFAQ() {
  el('faq-preview').innerHTML = '<div style="color:#8888aa;font-size:13px;margin-top:12px">Generating... ✦</div>';
  const r = await fetch('/admin/generate-faq?pass='+PASS,{method:'POST'});
  const {faqHtml,error} = await r.json();
  if (error) { el('faq-preview').innerHTML = \`<div style="color:#e74c3c;font-size:13px;margin-top:12px">\${error}</div>\`; return; }
  el('faq-preview').innerHTML = \`<div class="faq-html-preview">\${faqHtml}</div>
  <button class="btn ghost" style="margin-top:10px" onclick="copyFAQ()">📋 Copy HTML</button>\`;
  el('faq-preview')._html = faqHtml;
}
function copyFAQ(){navigator.clipboard.writeText(el('faq-preview')._html||'');alert('Copied!');}

async function sendHandoff(id) {
  const inp = el('hinp-'+id); if(!inp.value.trim())return;
  await fetch('/api/handoff/'+id+'/message?pass='+PASS,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:inp.value})});
  inp.value='';load();
}
async function closeHandoff(id){await fetch('/api/handoff/'+id+'/close?pass='+PASS,{method:'PUT'});load();}

// ─── Dropship admin JS ────────────────────────────────────────────────────────
let _dsData = null;
async function loadDropship() {
  const r = await fetch('/admin/dropship/data?pass='+PASS);
  _dsData = await r.json();
  renderDropship(_dsData);
}

function renderDropship({ stats, orders, catalogue }) {
  // Stats
  const cjStatus = stats.cjConnected
    ? '<span style="color:#2ecc71">● Connected</span>'
    : '<span style="color:#e74c3c">● Not connected</span>';
  el('ds-stats').innerHTML = [
    stat(stats.total,'Total Orders'), stat(stats.today,'Today'),
    stat(stats.pending,'Processing'), stat(stats.shipped,'Shipped'),
    stat(stats.products,'Products'), \`<div class="stat"><div class="n" style="font-size:14px;padding-top:6px">\${cjStatus}</div><div class="l">CJ Status</div></div>\`,
  ].join('');

  // Orders
  const statusColor = { processing:'#f39c12', shipped:'#2ecc71', error:'#e74c3c' };
  el('ds-orders').innerHTML = orders.length
    ? orders.slice(0,50).map(o=>\`<div style="padding:10px 0;border-bottom:1px solid #1e1e30">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <span style="font-weight:700;color:#fff">Shopify #\${o.shopifyOrderNumber}</span>
          <span style="font-size:11.5px;font-weight:700;color:\${statusColor[o.status]||'#888'}">\${o.status}</span>
        </div>
        <div style="font-size:12px;color:#8888aa">\${o.customer?.name||''} · \${o.items?.join(', ').slice(0,60)||''}</div>
        \${o.cjOrderId?\`<div style="font-size:11.5px;color:#6C63FF;margin-top:3px">CJ: \${o.cjOrderId}</div>\`:''}
        \${o.tracking?\`<div style="margin-top:6px"><a href="\${o.tracking.url}" target="_blank" style="font-size:12px;color:#2ecc71;font-weight:600">📮 Track: \${o.tracking.number}</a> (\${o.tracking.carrier})</div>\`:''}
        \${o.unmapped?.length?\`<div style="font-size:11.5px;color:#e74c3c;margin-top:3px">⚠️ Unmapped: \${o.unmapped.join(', ')}</div>\`:''}
        <div style="font-size:11px;color:#666;margin-top:3px">\${new Date(o.createdAt).toLocaleString()}</div>
      </div>\`).join('')
    : '<div style="color:#8888aa;font-size:13px;padding:12px 0">No orders yet. Connect Shopify webhook to start.</div>';

  // Catalogue
  el('ds-cat-count').textContent = catalogue.length;
  el('ds-catalogue').innerHTML = catalogue.length
    ? catalogue.map(p=>\`<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #1e1e30;font-size:12.5px">
        <div>
          <div style="color:#fff;font-weight:600">\${esc(p.title||p.shopifyId)}</div>
          <div style="color:#8888aa;font-size:11.5px">Shopify: \${p.shopifyId} → CJ: \${p.cjSku}</div>
          \${p.costPrice?\`<div style="color:#2ecc71;font-size:11.5px">Cost £\${p.costPrice} → Sell £\${p.sellPrice||'?'}</div>\`:''}
        </div>
        <button class="del-btn" onclick="dsUnmap('\${p.shopifyId}')">Remove</button>
      </div>\`).join('')
    : '<div style="color:#8888aa;font-size:13px;padding:8px 0">No products mapped yet. Search CJ above and add them.</div>';
}

async function cjSearch() {
  const q = el('cj-search').value.trim();
  if (!q) return;
  el('cj-results').innerHTML = '<div style="color:#8888aa;font-size:13px;padding:8px 0">Searching CJ... ✦</div>';
  const r = await fetch('/admin/dropship/search?pass='+PASS+'&q='+encodeURIComponent(q));
  const { products, message } = await r.json();
  if (!products?.length) {
    el('cj-results').innerHTML = \`<div style="color:#8888aa;font-size:13px;padding:8px 0">\${message||'No results found'}</div>\`;
    return;
  }
  el('cj-results').innerHTML = products.map(p=>\`
    <div style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid #1e1e30;align-items:center">
      \${p.image?\`<img src="\${p.image}" style="width:48px;height:48px;border-radius:6px;object-fit:cover;flex-shrink:0">\`:'<div style="width:48px;height:48px;border-radius:6px;background:#2a2a44;flex-shrink:0"></div>'}
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;color:#fff;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\${esc(p.title)}</div>
        <div style="font-size:11.5px;color:#8888aa">\${esc(p.category||'')} · \${p.variants} variant(s) · Cost: $\${p.sellPrice||'?'}</div>
        <div style="font-size:11.5px;color:#6C63FF;font-family:monospace;margin-top:2px">PID: \${p.pid}</div>
      </div>
      <button class="btn ghost" style="font-size:11.5px;padding:4px 10px;flex-shrink:0" onclick="prefillCJ('\${p.pid}',\${JSON.stringify(p.title).replace(/'/g,\\"\\\\\\"\\")},''\${p.sellPrice}')">Use this</button>
    </div>\`).join('');
}

function prefillCJ(pid, title, price) {
  el('ds-cj-sku').value = pid; // will need variant SKU from detail view, but pid is a start
  el('ds-title').value  = title;
  el('ds-cost').value   = price || '';
  el('ds-cj-sku').focus();
  el('ds-cj-sku').select();
}

async function mapProduct() {
  const data = {
    shopifyVariantId: el('ds-shopify-id').value.trim(),
    cjSku:            el('ds-cj-sku').value.trim(),
    title:            el('ds-title').value.trim(),
    costPrice:        el('ds-cost').value,
    sellPrice:        el('ds-sell').value,
  };
  if (!data.shopifyVariantId || !data.cjSku) { alert('Shopify Variant ID and CJ SKU are required.'); return; }
  const r = await fetch('/admin/dropship/map?pass='+PASS, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
  const d = await r.json();
  if (d.ok) {
    ['ds-shopify-id','ds-cj-sku','ds-title','ds-cost','ds-sell'].forEach(id => el(id).value = '');
    loadDropship();
  }
}

async function dsUnmap(id) {
  await fetch('/admin/dropship/map/'+encodeURIComponent(id)+'?pass='+PASS, { method:'DELETE' });
  loadDropship();
}

async function pollTracking() {
  const b = event.target; b.textContent = 'Polling... ⟳';
  await fetch('/admin/dropship/poll-tracking?pass='+PASS, { method:'POST' });
  b.textContent = 'Done ✓'; setTimeout(() => { b.textContent = '🔄 Poll tracking'; loadDropship(); }, 1500);
}

function tab(name) {
  const names=['convos','leads','bookings','dropship','gaps','handoffs','faq','ab','nps','insights','gmail','usage','settings'];
  document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('on',names[i]===name));
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('on'));
  el('p-'+name).classList.add('on');
  if (name === 'dropship') loadDropship();
  if (name === 'usage') loadUsage();
  if (name === 'settings') loadSettings();
}

async function loadUsage() {
  const r = await fetch('/admin/usage?pass='+PASS);
  const u = await r.json();
  const pct = u.capEnabled && u.cap ? Math.min(100, Math.round((u.messages / u.cap) * 100)) : null;
  const barColor = pct >= 90 ? '#e74c3c' : pct >= 70 ? '#f39c12' : '#6C63FF';
  el('usage-content').innerHTML = \`
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px">
      \${stat(u.messages.toLocaleString(), 'Messages sent')}
      \${stat('$'+u.cost, 'Est. cost (USD)')}
      \${stat((u.inputTokens/1000).toFixed(1)+'k', 'Input tokens')}
      \${stat((u.outputTokens/1000).toFixed(1)+'k', 'Output tokens')}
    </div>
    \${u.capEnabled ? \`
      <div style="margin-bottom:6px;display:flex;justify-content:space-between;font-size:12px;color:#8888aa">
        <span>Monthly cap: \${u.messages.toLocaleString()} / \${u.cap.toLocaleString()} messages</span>
        <span style="font-weight:700;color:\${barColor}">\${pct}%</span>
      </div>
      <div style="background:#13131f;border-radius:20px;height:10px;overflow:hidden">
        <div style="width:\${pct}%;height:100%;background:\${barColor};border-radius:20px;transition:width .4s"></div>
      </div>
      \${pct >= 80 ? \`<div style="margin-top:10px;font-size:12.5px;color:#f39c12">⚠️ Approaching cap — raise it in Settings if needed</div>\` : ''}
    \` : \`<div style="font-size:12.5px;color:#8888aa;margin-top:8px">No cap set — go to ⚙️ Settings to add one</div>\`}
    <div style="margin-top:16px;font-size:12px;color:#8888aa">Month: \${u.month} · Resets on the 1st</div>
  \`;
}

async function loadSettings() {
  const r = await fetch('/admin/settings?pass='+PASS);
  const s = await r.json();
  // Appearance
  el('s-botName').value      = s.botName || '';
  el('s-botColor').value     = s.botColor || '';
  el('s-welcomeMsg').value   = s.welcomeMsg || '';
  el('s-businessType').value = s.businessType || '';
  // Cap
  el('s-capEnabled').checked = !!s.capEnabled;
  el('s-capMessages').value  = s.capMessages || 1000;
  el('s-capWarningAt').value = s.capWarningAt || 80;
  // Business profile
  el('s-businessName').value     = s.businessName || '';
  el('s-businessTagline').value  = s.businessTagline || '';
  el('s-businessLocation').value = s.businessLocation || '';
  el('s-businessArea').value     = s.businessArea || '';
  el('s-businessPhone').value    = s.businessPhone || '';
  el('s-businessEmail').value    = s.businessEmail || '';
  el('s-businessHours').value    = s.businessHours || '';
  el('s-businessServices').value = s.businessServices || '';
  el('s-businessPrices').value   = s.businessPrices || '';
  el('s-businessExtra').value    = s.businessExtra || '';
}

async function saveProfile() {
  const body = {
    businessName:     el('s-businessName').value.trim(),
    businessTagline:  el('s-businessTagline').value.trim(),
    businessLocation: el('s-businessLocation').value.trim(),
    businessArea:     el('s-businessArea').value.trim(),
    businessPhone:    el('s-businessPhone').value.trim(),
    businessEmail:    el('s-businessEmail').value.trim(),
    businessHours:    el('s-businessHours').value.trim(),
    businessServices: el('s-businessServices').value.trim(),
    businessPrices:   el('s-businessPrices').value.trim(),
    businessExtra:    el('s-businessExtra').value.trim(),
  };
  await fetch('/admin/settings?pass='+PASS, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  el('profile-saved').style.display = 'inline';
  setTimeout(() => { el('profile-saved').style.display = 'none'; }, 3000);
}

async function saveSettings() {
  const body = {
    botName:      el('s-botName').value.trim(),
    botColor:     el('s-botColor').value.trim(),
    welcomeMsg:   el('s-welcomeMsg').value.trim(),
    businessType: el('s-businessType').value,
  };
  await fetch('/admin/settings?pass='+PASS, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  el('settings-saved').style.display = 'inline';
  setTimeout(() => { el('settings-saved').style.display = 'none'; }, 2500);
}

async function saveCap() {
  const body = {
    capEnabled:   el('s-capEnabled').checked,
    capMessages:  parseInt(el('s-capMessages').value) || 1000,
    capWarningAt: parseInt(el('s-capWarningAt').value) || 80,
  };
  await fetch('/admin/settings?pass='+PASS, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  el('cap-saved').style.display = 'inline';
  setTimeout(() => { el('cap-saved').style.display = 'none'; }, 2500);
}

let _leadFilter = 'all';
function filterLeads(f) { _leadFilter = f; renderLeadPipeline(window._allLeads||[]); }

function renderLeadPipeline(leads) {
  const statusColors = { new:'b-new', contacted:'b-contacted', converted:'b-converted', lost:'b-lost' };
  const filtered = _leadFilter === 'all' ? leads : leads.filter(l=>(l.status||'new')===_leadFilter);
  el('lead-pipeline').innerHTML = filtered.slice(0,60).map(l=>{
    const status = l.status||'new';
    const qParts = [l.qualification?.need?'Need: '+l.qualification.need.slice(0,60):null,l.qualification?.urgency?'Urgency: '+l.qualification.urgency:null,l.qualification?.budget?'Budget: '+l.qualification.budget:null].filter(Boolean);
    return \`<div class="lead-row" id="lr-\${btoa(l.email).replace(/=/g,'')}">
      <div style="flex:1;min-width:200px">
        <a href="mailto:\${l.email}" class="lead-email">\${esc(l.email)}</a>
        \${l.name?\`<div style="font-size:11.5px;color:#c0c0e0;margin-top:2px">\${esc(l.name)}</div>\`:''}
        \${qParts.length?\`<div style="font-size:11px;color:#8888aa;margin-top:3px">\${qParts.join(' · ')}</div>\`:''}
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        \${l.score!=null?\`<span class="badge \${l.score>=7?'b-hot':'b-sup'}">\${l.score}/10</span>\`:''}
        <span class="badge \${statusColors[status]||'b-new'}">\${status}</span>
        <select class="status-sel" onchange="setLeadStatus('\${l.email}',this.value)">
          <option value="new" \${status==='new'?'selected':''}>New</option>
          <option value="contacted" \${status==='contacted'?'selected':''}>Contacted</option>
          <option value="converted" \${status==='converted'?'selected':''}>Converted ✅</option>
          <option value="lost" \${status==='lost'?'selected':''}>Lost</option>
        </select>
        <a href="mailto:\${l.email}" class="btn" style="font-size:11.5px;padding:5px 12px;text-decoration:none">Email →</a>
      </div>
    </div>\`;
  }).join('') || \`<div style="color:#8888aa;font-size:13px;padding:12px 0">No \${_leadFilter==='all'?'':_leadFilter+' '}leads yet</div>\`;
}

async function setLeadStatus(email, status) {
  await fetch('/admin/lead/'+encodeURIComponent(email)+'/status?pass='+PASS, {
    method:'PATCH', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ status })
  });
  // Update local data
  const lead = (window._allLeads||[]).find(l=>l.email===email);
  if (lead) lead.status = status;
  renderLeadPipeline(window._allLeads||[]);
}
function tog(i){el('sm-'+i).classList.toggle('open');}
function stat(n,l){return \`<div class="stat"><div class="n">\${n}</div><div class="l">\${l}</div></div>\`;}
function el(id){return document.getElementById(id);}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function exportAll(){if(!_d)return;const a=Object.assign(document.createElement('a'),{href:URL.createObjectURL(new Blob([JSON.stringify(_d,null,2)],{type:'application/json'})),download:'aria-export-'+Date.now()+'.json'});a.click();}

// Gmail connection helpers
const BASE_URL = window.location.origin;
let _gmailConnections = [];

function genGmailLink(){
  const email = el('gmail-email').value.trim();
  if(!email||!email.includes('@')){el('gmail-email').style.borderColor='#e74c3c';return;}
  el('gmail-email').style.borderColor='';
  const link = BASE_URL+'/connect/gmail?owner='+encodeURIComponent(email);
  el('gmail-link-url').textContent = link;
  el('gmail-link-out').style.display = 'block';
  // Check if already connected
  fetch('/connect/gmail/status?owner='+encodeURIComponent(email))
    .then(r=>r.json()).then(d=>{
      if(d.connected && !_gmailConnections.includes(email)){
        _gmailConnections.push(email);
        renderGmailConnections();
      }
    }).catch(()=>{});
}

function copyGmailLink(){
  const url = el('gmail-link-url').textContent;
  navigator.clipboard?.writeText(url).then(()=>{
    const b = event.target; b.textContent='Copied! ✓';
    setTimeout(()=>b.textContent='Copy link',2000);
  });
}

function renderGmailConnections(){
  const div = el('gmail-connections');
  if(!_gmailConnections.length){div.innerHTML='<div style="color:#8888aa;font-size:13px">No Gmail accounts connected yet.</div>';return;}
  div.innerHTML = _gmailConnections.map(e=>\`
    <div class="ri">
      <div>
        <span style="color:#2ecc71;font-weight:600">✓ Connected</span>
        <span style="color:#c0c0e0;margin-left:8px">\${esc(e)}</span>
      </div>
      <div style="display:flex;gap:6px">
        <a href="/connect/gmail?owner=\${encodeURIComponent(e)}" target="_blank" class="btn ghost" style="font-size:11.5px;padding:4px 10px;text-decoration:none">View</a>
        <button class="btn" style="font-size:11.5px;padding:4px 10px" onclick="copyConnectLink('\${esc(e)}')">Copy Link</button>
      </div>
    </div>
  \`).join('');
}

function copyConnectLink(email){
  navigator.clipboard?.writeText(BASE_URL+'/connect/gmail?owner='+encodeURIComponent(email));
  alert('Link copied for '+email);
}

load();
// Auto-refresh handoffs every 10s
setInterval(()=>{if(document.getElementById('p-handoffs').classList.contains('on'))load();},10000);
</script></body></html>`);
});

// ─── Client Setup Wizard ─────────────────────────────────────────────────────
app.get('/setup', (req, res) => {
  const SERVER = `${req.protocol}://${req.get('host')}`;
  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Set Up Your Chatbot</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f0f8;min-height:100vh;color:#1a1a2e;}
.hero{background:linear-gradient(135deg,#6C63FF,#5A52D5);padding:40px 24px;text-align:center;color:white;}
.hero h1{font-size:28px;font-weight:800;margin-bottom:8px;}
.hero p{font-size:15px;opacity:.85;}
.steps{display:flex;justify-content:center;gap:0;margin-top:24px;}
.step{display:flex;align-items:center;gap:8px;font-size:13px;opacity:.75;}
.step.active{opacity:1;font-weight:700;}
.step-dot{width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;}
.step.active .step-dot{background:white;color:#6C63FF;}
.step-line{width:40px;height:2px;background:rgba(255,255,255,.2);margin:0 4px;}
.wrap{max-width:640px;margin:0 auto;padding:32px 20px;}
.card{background:white;border-radius:20px;padding:32px;box-shadow:0 4px 24px rgba(0,0,0,.08);margin-bottom:20px;}
.card h2{font-size:18px;font-weight:700;margin-bottom:6px;}
.card .sub{font-size:13.5px;color:#888;margin-bottom:24px;}
label{display:block;font-size:13px;font-weight:600;color:#444;margin-bottom:6px;margin-top:16px;}
label:first-of-type{margin-top:0;}
input,textarea,select{width:100%;padding:11px 14px;border:1.5px solid #e0e0ee;border-radius:10px;font-size:14px;outline:none;font-family:inherit;color:#1a1a2e;background:#fafafa;transition:border-color .2s;}
input:focus,textarea:focus,select:focus{border-color:#6C63FF;background:white;}
textarea{resize:vertical;min-height:80px;line-height:1.5;}
.color-row{display:flex;gap:10px;align-items:center;}
.color-row input[type=color]{width:48px;height:44px;padding:2px;border-radius:10px;cursor:pointer;flex-shrink:0;}
.color-row input[type=text]{flex:1;}
.swatch-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;}
.swatch{width:32px;height:32px;border-radius:50%;cursor:pointer;border:2px solid transparent;transition:transform .15s;}
.swatch:hover,.swatch.on{transform:scale(1.18);border-color:#1a1a2e;}
.btn{display:block;width:100%;padding:14px;background:#6C63FF;color:white;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;transition:opacity .15s;margin-top:24px;}
.btn:hover{opacity:.88;}
.btn.ghost{background:white;color:#6C63FF;border:2px solid #6C63FF;}
.hidden{display:none;}
/* Code output */
.code-box{background:#1a1a2e;border-radius:14px;padding:20px;margin-top:16px;position:relative;}
.code-box pre{font-family:'Fira Code',Consolas,monospace;font-size:12.5px;color:#e8e8f8;white-space:pre-wrap;word-break:break-all;line-height:1.7;}
.copy-btn{position:absolute;top:14px;right:14px;background:#6C63FF;color:white;border:none;border-radius:8px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;}
.copy-btn:hover{opacity:.85;}
/* Platforms */
.platform-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;}
.pt{padding:7px 14px;border:1.5px solid #e0e0ee;border-radius:20px;font-size:13px;cursor:pointer;background:white;font-family:inherit;transition:all .15s;}
.pt.on{background:#6C63FF;color:white;border-color:#6C63FF;}
.platform-guide{font-size:13.5px;color:#444;line-height:1.8;}
.platform-guide ol{padding-left:20px;}
.platform-guide li{padding:3px 0;}
.platform-guide strong{color:#1a1a2e;}
/* Preview */
.preview-badge{display:inline-flex;align-items:center;gap:6px;background:#2ecc7118;border:1px solid #2ecc7140;color:#1a8a4a;border-radius:20px;padding:6px 14px;font-size:13px;font-weight:600;margin-bottom:16px;}
/* Checklist */
.check-item{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #f0f0f8;font-size:14px;}
.check-item:last-child{border:none;}
.ck{width:22px;height:22px;border-radius:50%;background:#2ecc71;color:white;display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0;}
</style>
</head><body>

<div class="hero">
  <h1>✦ Set Up Your Chatbot</h1>
  <p>Takes about 2 minutes. No technical knowledge needed.</p>
  <div class="steps">
    <div class="step active" id="s1"><div class="step-dot">1</div> Your Details</div>
    <div class="step-line"></div>
    <div class="step" id="s2"><div class="step-dot">2</div> Appearance</div>
    <div class="step-line"></div>
    <div class="step" id="s3"><div class="step-dot">3</div> Get Your Code</div>
  </div>
</div>

<div class="wrap">

<!-- STEP 1: Details -->
<div id="step1" class="card">
  <h2>Tell us about your business</h2>
  <div class="sub">This helps the bot answer questions about you correctly.</div>

  <label>Business name</label>
  <input id="f-site" placeholder="e.g. Pete's Plumbing" oninput="update()"/>

  <label>Your name</label>
  <input id="f-owner" placeholder="e.g. Pete" oninput="update()"/>

  <label>Your email address</label>
  <input id="f-email" type="email" placeholder="pete@gmail.com" oninput="update()"/>

  <label>Your WhatsApp number (optional)</label>
  <input id="f-wa" placeholder="+447700000000" oninput="update()"/>

  <label>What does your business do? <span style="font-weight:400;color:#aaa">(the bot will use this to answer questions)</span></label>
  <textarea id="f-desc" placeholder="e.g. We're a plumbing company based in London. We offer boiler servicing, emergency callouts, and bathroom fitting. Available Mon-Fri 9am-5pm." oninput="update()"></textarea>

  <label>Bot name</label>
  <input id="f-bot" placeholder="Aria" value="Aria" oninput="update()"/>

  <button class="btn" onclick="goStep(2)">Next — Choose colours →</button>
</div>

<!-- STEP 2: Appearance -->
<div id="step2" class="card hidden">
  <h2>Choose your colours</h2>
  <div class="sub">Pick something that matches your brand.</div>

  <label>Accent colour</label>
  <div class="color-row">
    <input type="color" id="f-color-pick" value="#6C63FF" oninput="syncColor(this.value)"/>
    <input type="text" id="f-color" value="#6C63FF" placeholder="#6C63FF" oninput="syncColorText(this.value)"/>
  </div>
  <div class="swatch-row">
    ${['#6C63FF','#FF6B6B','#00C9A7','#4D96FF','#FF922B','#FF6EB4','#1a1a2e','#2ecc71'].map(c =>
      `<div class="swatch" style="background:${c}" onclick="syncColor('${c}')" title="${c}"></div>`
    ).join('')}
  </div>

  <label>Chat position</label>
  <select id="f-pos" oninput="update()">
    <option value="right">Bottom right (recommended)</option>
    <option value="left">Bottom left</option>
  </select>

  <button class="btn" onclick="goStep(3)" style="margin-top:24px">Next — Get your code →</button>
  <button class="btn ghost" onclick="goStep(1)" style="margin-top:10px">← Back</button>
</div>

<!-- STEP 3: Code -->
<div id="step3" class="card hidden">
  <h2>Your chatbot is ready! 🎉</h2>
  <div class="sub">Copy the code below and paste it into your website.</div>

  <div class="preview-badge">✓ Personalised for <span id="preview-name" style="margin-left:3px">your business</span></div>

  <div class="code-box">
    <pre id="code-out"></pre>
    <button class="copy-btn" onclick="copyCode()">Copy</button>
  </div>

  <div style="margin-top:28px">
    <div style="font-size:14px;font-weight:700;margin-bottom:12px">Where are you adding it?</div>
    <div class="platform-tabs">
      ${[['wordpress','WordPress'],['shopify','Shopify'],['wix','Wix'],['squarespace','Squarespace'],['webflow','Webflow'],['html','Raw HTML'],['other','Other']].map(([k,l]) =>
        `<button class="pt${k==='wordpress'?' on':''}" onclick="showPlatform('${k}',this)">${l}</button>`
      ).join('')}
    </div>
    <div class="platform-guide" id="platform-guide"></div>
  </div>

  <div style="margin-top:28px">
    <div style="font-size:14px;font-weight:700;margin-bottom:14px">What happens next</div>
    <div class="check-item"><div class="ck">✓</div> Visitors see a chat button in the corner of your site</div>
    <div class="check-item"><div class="ck">✓</div> They chat — you get email alerts from your own Gmail</div>
    <div class="check-item"><div class="ck">✓</div> Bookings go straight into your Google Calendar</div>
    <div class="check-item"><div class="ck">✓</div> Bot updates automatically — never touch the code again</div>
  </div>

  <div style="margin-top:28px;background:#f8f8fc;border-radius:14px;padding:20px;">
    <div style="font-size:13.5px;font-weight:700;margin-bottom:8px;">📧 Connect your Gmail</div>
    <p style="font-size:13px;color:#666;margin-bottom:12px;">So emails come from your address, not a bot address.</p>
    <a id="gmail-link" href="#" target="_blank" style="display:inline-block;padding:10px 20px;background:#fff;border:1.5px solid #ddd;border-radius:10px;font-size:13px;font-weight:600;color:#333;text-decoration:none;">
      <svg style="vertical-align:middle;margin-right:6px" width="16" height="16" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 6.293C4.672 4.166 6.656 3.58 9 3.58z"/></svg>
      Connect Gmail
    </a>
  </div>

  <button class="btn ghost" onclick="goStep(2)" style="margin-top:16px">← Edit details</button>
</div>

</div>

<script>
const SERVER = '${SERVER}';
const PLATFORMS = {
  wordpress: \`<ol>
    <li>In your WordPress dashboard go to <strong>Plugins → Add New</strong></li>
    <li>Search for <strong>WPCode</strong> and install it (free)</li>
    <li>Go to <strong>Code Snippets → Add Snippet → Add Your Custom Code</strong></li>
    <li>Set location to <strong>Footer</strong></li>
    <li>Paste your code above → <strong>Save &amp; Activate</strong></li>
    <li>Done — bot appears on every page ✓</li>
  </ol>\`,
  shopify: \`<ol>
    <li>Go to <strong>Online Store → Themes → Edit Code</strong></li>
    <li>Open <strong>theme.liquid</strong></li>
    <li>Find <strong>&lt;/body&gt;</strong> near the bottom</li>
    <li>Paste your code just before it</li>
    <li>Click <strong>Save</strong> — done ✓</li>
  </ol>\`,
  wix: \`<ol>
    <li>Go to <strong>Settings → Custom Code</strong></li>
    <li>Click <strong>Add Code</strong></li>
    <li>Set placement to <strong>Body - end</strong></li>
    <li>Set to <strong>All pages</strong></li>
    <li>Paste your code → <strong>Apply</strong> ✓</li>
  </ol>\`,
  squarespace: \`<ol>
    <li>Go to <strong>Settings → Advanced → Code Injection</strong></li>
    <li>Paste your code in the <strong>Footer</strong> box</li>
    <li>Click <strong>Save</strong> ✓</li>
    <li><em>Note: requires Business plan or above</em></li>
  </ol>\`,
  webflow: \`<ol>
    <li>Go to <strong>Project Settings → Custom Code</strong></li>
    <li>Paste your code in <strong>Footer Code</strong></li>
    <li>Click <strong>Save Changes</strong></li>
    <li><strong>Publish</strong> your site ✓</li>
  </ol>\`,
  html: \`<ol>
    <li>Open your HTML file</li>
    <li>Find the <strong>&lt;/body&gt;</strong> tag at the bottom</li>
    <li>Paste your code just before it</li>
    <li>Save and upload ✓</li>
  </ol>\`,
  other: \`<p>Find where your website lets you add code to the footer or before the closing &lt;/body&gt; tag. That's where you paste it. Most website builders have a "Custom Code" or "Footer Script" section in their settings. If you're stuck, send us your platform name and we'll guide you through it.</p>\`,
};

function goStep(n) {
  [1,2,3].forEach(i => {
    document.getElementById('step'+i).classList.toggle('hidden', i!==n);
    document.getElementById('s'+i).classList.toggle('active', i===n);
  });
  if(n===3){ update(); showPlatform('wordpress', document.querySelector('.pt')); }
  window.scrollTo({top:0,behavior:'smooth'});
}

function syncColor(v) {
  document.getElementById('f-color').value = v;
  document.getElementById('f-color-pick').value = v;
  document.querySelectorAll('.swatch').forEach(s => s.classList.toggle('on', s.style.background===v||s.title===v));
  update();
}
function syncColorText(v) {
  if(/^#[0-9a-fA-F]{6}$/.test(v)) { document.getElementById('f-color-pick').value = v; syncColor(v); }
}

function val(id){ return document.getElementById(id)?.value?.trim()||''; }

function buildCode() {
  const site  = val('f-site');
  const owner = val('f-owner');
  const email = val('f-email');
  const wa    = val('f-wa');
  const desc  = val('f-desc');
  const bot   = val('f-bot')||'Aria';
  const color = val('f-color')||'#6C63FF';
  const pos   = val('f-pos')||'right';

  const prompt = desc
    ? 'You are '+bot+', assistant for '+site+'. '+desc
    : '';

  const attrs = [
    \`  data-server="\${SERVER}"\`,
    site  ? \`  data-site-name="\${site}"\` : '',
    \`  data-name="\${bot}"\`,
    color !== '#6C63FF' ? \`  data-color="\${color}"\` : '',
    pos   !== 'right'   ? \`  data-position="\${pos}"\` : '',
    email ? \`  data-owner-email="\${email}"\` : '',
    owner ? \`  data-owner-name="\${owner}"\` : '',
    wa    ? \`  data-handoff-wa="\${wa}"\` : '',
    email ? \`  data-handoff-email="\${email}"\` : '',
    prompt? \`  data-prompt="\${prompt}"\` : '',
  ].filter(Boolean).join('\\n');

  return \`<script src="\${SERVER}/chatbot.js"\\n\${attrs}\\n></scr\`+\`ipt>\`;
}

function update() {
  const code = buildCode();
  const out = document.getElementById('code-out');
  if(out) out.textContent = code;
  const pn = document.getElementById('preview-name');
  if(pn) pn.textContent = val('f-site') || 'your business';
  const gl = document.getElementById('gmail-link');
  const email = val('f-email');
  if(gl && email) gl.href = SERVER+'/connect/gmail?owner='+encodeURIComponent(email);
}

function copyCode() {
  navigator.clipboard?.writeText(buildCode()).then(()=>{
    const b = document.querySelector('.copy-btn');
    b.textContent='Copied! ✓'; b.style.background='#2ecc71';
    setTimeout(()=>{b.textContent='Copy';b.style.background='';},2500);
  });
}

function showPlatform(key, btn) {
  document.querySelectorAll('.pt').forEach(b=>b.classList.remove('on'));
  if(btn) btn.classList.add('on');
  document.getElementById('platform-guide').innerHTML = PLATFORMS[key]||'';
}

update();
</script>
</body></html>`);
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status:'ok', sessions:sessions.size, faqs:faqs.size, handoffs:handoffs.size }));

// ─── Daily digest ─────────────────────────────────────────────────────────────
let lastDigestDay = null;
setInterval(async () => {
  const now = new Date(), day = now.toDateString(), h = now.getHours();
  const dh = parseInt(process.env.DIGEST_HOUR||'8');
  if (h === dh && lastDigestDay !== day && process.env.NOTIFY_EMAIL) {
    lastDigestDay = day;
    const all = Array.from(sessions.values()), today = all.filter(s=>new Date(s.startedAt).toDateString()===day);
    const allLeads = all.flatMap(s=>(s.leads||[]).map(e=>({email:e,score:s.score}))), todayLeads = allLeads.filter(l=>new Date(sessions.get(l.sessionId)?.lastActivity||0).toDateString()===day);
    const hotLeads = allLeads.filter(l=>l.score>=7), ratings = all.filter(s=>s.rating).map(s=>s.rating);
    const avgRating = ratings.length?(ratings.reduce((a,b)=>a+b,0)/ratings.length).toFixed(1):null;
    const freq={};today.forEach(s=>(s.messages||[]).filter(m=>m.role==='user').forEach(m=>m.content.toLowerCase().split(/\W+/).filter(w=>w.length>4).forEach(w=>{freq[w]=(freq[w]||0)+1;})));
    const topQ=Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,8), topObj=all.filter(s=>s.topObjection).map(s=>s.topObjection).filter(Boolean).slice(0,5);
    const adminUrl=`http://localhost:${process.env.PORT||3000}/admin?pass=${ADMIN}`;
    await sendEmail({ to:process.env.NOTIFY_EMAIL, subject:`📊 Aria Daily Digest — ${day}`, html:digestTpl({ date:day, stats:{ today:today.length, leadsToday:todayLeads.length, avgRating }, topQ, hotLeads, bookingCount:bookings.filter(b=>new Date(b.ts).toDateString()===day).length, abResults, topObjections:topObj, adminUrl }) });
  }
}, 60_000);

// ─── Weekly report (Mondays) ──────────────────────────────────────────────────
let lastWeeklyDay = null;
setInterval(async () => {
  const now = new Date();
  if (now.getDay() !== 1 || now.getHours() !== 8 || lastWeeklyDay === now.toDateString() || !process.env.NOTIFY_EMAIL) return;
  lastWeeklyDay = now.toDateString();
  const week = Date.now() - 7*24*60*60*1000, prevWeek = week - 7*24*60*60*1000;
  const all = Array.from(sessions.values());
  const thisWeek = all.filter(s=>new Date(s.startedAt)>=new Date(week));
  const prevW    = all.filter(s=>new Date(s.startedAt)>=new Date(prevWeek)&&new Date(s.startedAt)<new Date(week));
  const allLeads = thisWeek.flatMap(s=>(s.leads||[]).map(e=>({email:e,score:s.score})));
  const hotLeads = allLeads.filter(l=>l.score>=7), scores = thisWeek.filter(s=>s.score).map(s=>s.score);
  const avgScore = scores.length?(scores.reduce((a,b)=>a+b,0)/scores.length).toFixed(1):null;
  const npsThis  = npsScores.filter(n=>new Date(n.ts)>=new Date(week)), npsAvg=npsThis.length?(npsThis.reduce((a,b)=>a+b.score,0)/npsThis.length).toFixed(1):null;
  const freq={};thisWeek.forEach(s=>(s.messages||[]).filter(m=>m.role==='user').forEach(m=>m.content.toLowerCase().split(/\W+/).filter(w=>w.length>4).forEach(w=>{freq[w]=(freq[w]||0)+1;})));
  const topQ=Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const adminUrl=`http://localhost:${process.env.PORT||3000}/admin?pass=${ADMIN}`;
  await sendEmail({ to:process.env.NOTIFY_EMAIL, subject:`📈 Aria Weekly Report`, html:weeklyTpl({ period:`${new Date(week).toLocaleDateString()} — ${now.toLocaleDateString()}`, stats:{ total:thisWeek.length, leads:allLeads.length, avgScore }, trend:{ total:thisWeek.length-prevW.length, leads:allLeads.length-prevW.flatMap(s=>(s.leads||[])).length }, topQuestions:topQ, hotLeads, npsAvg, adminUrl }) });
  console.log('📈 Weekly report sent');
}, 60_000);

// ─── Abandoned recovery ───────────────────────────────────────────────────────
setInterval(async () => {
  if (!process.env.NOTIFY_EMAIL) return;
  const twoH = 2*60*60*1000, adminUrl=`http://localhost:${process.env.PORT||3000}/admin?pass=${ADMIN}`;
  for (const [id, s] of sessions) {
    if ((s.leads||[]).length && !s.followupSent && Date.now()-new Date(s.lastActivity)>twoH) {
      s.followupSent = true; sessions.set(id, s);
      const convo=(s.messages||[]).slice(-6).map(m=>`${m.role==='user'?'Visitor':'Bot'}: ${m.content}`).join('\n');
      for (const lead of s.leads) {
        await sendEmail({ to:process.env.NOTIFY_EMAIL, subject:`⚠️ Abandoned Lead: ${lead}`, html:`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:20px;"><h2>⚠️ Abandoned Lead</h2><p><a href="mailto:${lead}">${lead}</a> gave their email but went quiet on <strong>${s.page}</strong>.</p><pre style="background:#f5f5f5;padding:14px;border-radius:8px;font-size:13px">${convo}</pre><a href="mailto:${lead}" style="display:inline-block;margin-top:12px;padding:10px 20px;background:#6C63FF;color:white;border-radius:8px;text-decoration:none">Follow up →</a> <a href="${adminUrl}" style="display:inline-block;margin-top:12px;padding:10px 20px;background:#333;color:white;border-radius:8px;text-decoration:none;margin-left:8px">Admin</a></body></html>` });
      }
    }
  }
}, 60*60*1000);

// Restore persisted state before starting
loadSavedTokens();
loadSavedAutoReply();
loadRepliedEmails();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n  ✦ Aria Chatbot Server v5.1\n  → Admin: http://localhost:${PORT}/admin?pass=${ADMIN}\n  → Health: http://localhost:${PORT}/health\n`));

// ─── Global error handlers — prevent unhandled errors from crashing the process
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message || err);
});
