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
 *   BRANDSGATEWAY_API_KEY  BrandsGateway REST API key (from account settings)
 *   PRINTFUL_API_KEY       Printful API token (from Printful dashboard → API)
 *   MAILCHIMP_API_KEY      e.g. abc123-us1
 *   MAILCHIMP_LIST_ID      audience/list ID
 *   DIGEST_HOUR            hour for daily digest (default 8)
 *   PORT                   default 3000
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs';
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
import { promises as fsp } from 'node:fs';
import { routeChat }                    from './lib/lead_router.js';
import { decideLeadAction, policyAddendum } from './lib/lead_policy.js';
import { scoreChannelLead, categorizeChannelMessage } from './lib/channel_lead_scorer.js';
import { retrieveRelevantChunks } from './lib/rag_retriever.js';
import { buildIcsEvent, parseBookingDateTime } from './lib/ics_builder.js';
import { scheduleTask, cancelTask, listPending, bootstrapFromLedger, registerTaskHandler, startTickLoop } from './lib/outbound_scheduler.js';
import { ltvScore, ltvTier } from './lib/customer_ltv.js';
import { evaluateSchedule } from './lib/business_hours.js';
import { dispatchWebhook, readWebhookLog, signPayload as signWebhookPayload } from './lib/webhook_dispatcher.js';
import { extractImageRefs, resolveImageRefsToBlocks } from './lib/image_intake.js';
import { extractAudioRefs, transcribeAudioRef } from './lib/audio_intake.js';
import { findBookingConflicts, describeConflictsForCustomer } from './lib/booking_conflicts.js';
import { canBatch as digestCanBatch, shouldFireDigest, renderDigestHtml } from './lib/digest.js';
import { verifyVapiSignature, buildAssistantConfig, extractCallReport, extractToolCall, provisionVapiNumber, releaseVapiNumber } from './lib/vapi_handler.js';
import { safeFetch as _safeFetch }     from './lib/onboarding.js';
import { recordEvent, rollupForWindow, renderWeeklyDigestHtml, estimateLeadValue, sessionsForSlugWindow } from './lib/analytics.js';

const app    = express();
// Railway terminates TLS at its edge proxy and forwards X-Forwarded-Proto.
// Without trust proxy, req.protocol reports the inner http:// and any URLs
// we generate (preview links, embed snippets) come back as http://. Trust
// the proxy so generated URLs use the real public https:// scheme.
app.set('trust proxy', true);
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// ADMIN_PASS is required. The historical fallback 'aria-admin' was retired
// 2026-05-14 — having a guessable default meant any reader of this OSS repo
// could wipe the live domain allowlist. Refuse to start without it.
if (!process.env.ADMIN_PASS) {
  console.error('FATAL: ADMIN_PASS env var is required. Set it on Railway → aria-chatbot service → Variables.');
  process.exit(1);
}
const ADMIN  = process.env.ADMIN_PASS;

// ─── Admin auth — magic-link + cookie session (Codex C5 fix) ─────────────────
// We used to ship `${ADMIN}` inside every owner-notification URL. That meant
// every site owner had the master password in their inbox (a single forwarded
// alert email = full takeover). Replaced with:
//   1. mintAdminMagicLink() — one-shot 30-min token, exchanged for a session
//   2. adminSessions Map     — 24h httpOnly cookies, crypto-random ids
//   3. adminAuth(req)        — accepts cookie OR header; legacy ?pass still
//      works as a fallback to avoid breaking old inbox links during rollout
const adminMagicLinks = new Map();   // token → { expiresAt }
const adminSessions   = new Map();   // sessionId → { expiresAt, createdAt, ip }
const ADMIN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const ADMIN_MAGIC_TTL_MS   = 30 * 60 * 1000;

function _sweepAdminMaps() {
  const now = Date.now();
  for (const [t, v] of adminMagicLinks) if (v.expiresAt < now) adminMagicLinks.delete(t);
  for (const [s, v] of adminSessions)   if (v.expiresAt < now) adminSessions.delete(s);
}
setInterval(_sweepAdminMaps, 5 * 60 * 1000).unref();

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function mintAdminMagicLink(req) {
  const token = crypto.randomBytes(24).toString('hex');
  adminMagicLinks.set(token, { expiresAt: Date.now() + ADMIN_MAGIC_TTL_MS });
  // req may be null in cron/startup contexts — fall back to public env URL.
  let base;
  if (req) {
    base = `${req.protocol}://${req.get('host')}`;
  } else if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    base = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  } else if (process.env.BASE_URL) {
    base = process.env.BASE_URL.replace(/\/+$/, '');
  } else {
    base = `http://localhost:${process.env.PORT || 3000}`;
  }
  return `${base}/admin/auth?t=${token}`;
}

// Public base URL of this server. Prefers the live request host, falls back
// to Railway domain / BASE_URL / localhost. Used by integrations that need
// to hand external services a callback URL (Vapi serverUrl, etc).
function appBaseUrl(req) {
  if (req) return `${req.protocol}://${req.get('host')}`;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, '');
  return `http://localhost:${process.env.PORT || 3000}`;
}

function mintAdminSession(ip) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  adminSessions.set(sessionId, {
    expiresAt: Date.now() + ADMIN_SESSION_TTL_MS,
    createdAt: Date.now(),
    ip,
  });
  return sessionId;
}

// Single source of truth for admin authentication. Used by adminAuth(),
// isAdmin(), and the 27 inline checks in handler bodies. Constant-time
// comparison on shared-secret paths to dodge timing oracles.
function _hasValidAdminCookie(req) {
  const cookies = parseCookies(req);
  const sid = cookies.aria_admin_session;
  if (!sid) return false;
  const sess = adminSessions.get(sid);
  if (!sess || sess.expiresAt < Date.now()) return false;
  return true;
}

function _constantTimeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ─── Per-Client Owner Allowlist (for OAuth-gated admin pages) ─────────────────
// Maps slug → Set of authorized owner emails. Loaded from data/owners.json at
// startup. Used to gate /auth/admin/start (who can sign in for which client)
// and isAdminReq (whether a presented signed token's email is authorized).
import { readFileSync as _ownersRF, existsSync as _ownersEX, writeFileSync as _ownersWF } from 'fs';
const OWNERS_FILE = (await import('path')).resolve('data/owners.json');
const owners = new Map();
function loadOwners() {
  owners.clear();
  // 1. Seed from OWNERS_JSON env var (survives Railway container rebuilds even
  //    if the data/ volume is ephemeral). Optional.
  if (process.env.OWNERS_JSON) {
    try {
      const raw = JSON.parse(process.env.OWNERS_JSON);
      for (const [slug, emails] of Object.entries(raw)) {
        if (Array.isArray(emails)) owners.set(slug.toLowerCase(), new Set(emails.map(e => String(e).toLowerCase())));
      }
    } catch (e) { console.error('Failed to parse OWNERS_JSON env:', e.message); }
  }
  // 2. data/owners.json (committed to repo, ships with deploy). Overrides env
  //    on a per-slug basis so post-deploy edits via /admin/owners stick.
  try {
    if (_ownersEX(OWNERS_FILE)) {
      const raw = JSON.parse(_ownersRF(OWNERS_FILE, 'utf8'));
      for (const [slug, emails] of Object.entries(raw)) {
        if (Array.isArray(emails)) owners.set(slug.toLowerCase(), new Set(emails.map(e => String(e).toLowerCase())));
      }
    }
  } catch (e) { console.error('Failed to load owners.json:', e.message); }
  console.log(`👥 Loaded owners for ${owners.size} client(s): ${[...owners.keys()].join(', ') || '(none)'}`);
}
loadOwners();
function isOwner(slug, email) {
  if (!slug || !email) return false;
  const set = owners.get(String(slug).toLowerCase());
  return !!(set && set.has(String(email).toLowerCase()));
}

// Signed-token helpers. Token format: `${email}~${expiry}~${slug}~${sig}` where
// sig = HMAC-SHA256(ADMIN_PASS, `${email}~${expiry}~${slug}`).
//   `~` is the separator (URL-safe, never appears in emails / slugs / digits /
//   base64url, so split('~') always yields exactly 4 parts even when the email
//   contains dots like `liam@howhighscaffolding.com`).
// Issued after Google OAuth confirms the user owns the email; verified on every
// review-admin API call. Stateless — no session storage required.
function signAdminToken(email, slug, expiry) {
  const payload = `${email}~${expiry}~${slug}`;
  const sig = crypto.createHmac('sha256', ADMIN).update(payload).digest('base64url');
  return `${payload}~${sig}`;
}
function verifyAdminToken(token, slugExpected) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const parts = token.split('~');
  if (parts.length !== 4) return null;
  const [email, expiryStr, slug, sig] = parts;
  if (slugExpected && slug.toLowerCase() !== slugExpected.toLowerCase()) return null;
  const expiry = parseInt(expiryStr, 10);
  if (!expiry || expiry < Date.now()) return null;
  const expected = crypto.createHmac('sha256', ADMIN)
    .update(`${email}~${expiry}~${slug}`).digest('base64url');
  // Constant-time compare to defeat timing attacks
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (!isOwner(slug, email)) return null;
  return { email, slug, expiry };
}

// OAuth state token store. Maps short random token → { slug, returnTo, created }.
// State is round-tripped through Google's `state` param so callbacks can resume
// the original "where to send the user back" intent. 10 min TTL.
const adminAuthStates = new Map();
function makeAdminAuthState(slug, returnTo) {
  const token = crypto.randomBytes(24).toString('base64url');
  adminAuthStates.set(token, { slug, returnTo, created: Date.now() });
  return token;
}
function consumeAdminAuthState(token) {
  const st = adminAuthStates.get(token);
  if (!st) return null;
  adminAuthStates.delete(token);
  if (Date.now() - st.created > 10 * 60 * 1000) return null;
  return st;
}
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [t, s] of adminAuthStates) if (s.created < cutoff) adminAuthStates.delete(t);
}, 5 * 60 * 1000).unref();

// ─── Middleware ───────────────────────────────────────────────────────────────
// origin: true reflects the request's Origin header back, which is required
// when the client uses credentialed requests (navigator.sendBeacon always does).
// Wildcard '*' is rejected by browsers in that case.
const corsOpts = {
  origin: true,
  credentials: true,
  methods: ['GET','POST','DELETE','PUT','OPTIONS','PATCH'],
  // Explicit allow-list — required for cross-origin admin auth from client domains
  // (howhighscaffolding.co.uk → aria-chatbot...railway.app) to send X-Aria-Token.
  allowedHeaders: ['content-type', 'x-aria-token', 'x-admin-password', 'authorization'],
};
app.use(cors(corsOpts));
app.options('*', cors(corsOpts));
// Raw body capture for Shopify webhook HMAC verification — must run before express.json()
app.use('/api/shopify/webhook', express.raw({ type: 'application/json' }));
app.use('/api/meta/webhook', express.raw({ type: 'application/json' }));
app.use('/api/vapi/webhook', express.raw({ type: '*/*' })); // raw for HMAC signature verify
app.use(express.json());
app.use('/chatbot.js', (req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
// Domain whitelist middleware — protects chatbot widget endpoints from unauthorized domains
app.use((req, res, next) => {
  // Only check widget-facing endpoints (chat, leads, bookings, handoffs, sessions, nps, gaps, faqs)
  const widgetPaths = ['/api/chat', '/api/lead', '/api/booking', '/api/session', '/api/handoff', '/api/nps', '/api/gap', '/api/faqs', '/api/ab', '/api/reviews'];
  const isWidgetReq = widgetPaths.some(p => req.path.startsWith(p));
  if (isWidgetReq && !isDomainAllowed(req)) {
    return res.status(403).json({ error: 'Unauthorized domain. Contact AireyAi to enable this site.' });
  }
  next();
});

app.use('/tests', express.static(resolve('tests')));
app.use(express.static('.'));

// ─── Email ────────────────────────────────────────────────────────────────────
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER) {
  mailer = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: +( process.env.SMTP_PORT||587), secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  mailer.verify().then(() => console.log('✉️  Email ready')).catch(e => console.warn('Email:', e.message));
}
const sendEmail = async ({ to, subject, html, replyTo, attachments }) => {
  if (!mailer || !to) return;
  const opts = { from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, html };
  if (replyTo) opts.replyTo = replyTo;
  if (attachments && attachments.length) opts.attachments = attachments;
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

function getAuthUrl(ownerEmail, onboardToken) {
  const client = makeOAuthClient();
  const stateValue = onboardToken
    ? JSON.stringify({ owner: ownerEmail || '', onboard: onboardToken })
    : ownerEmail
      ? ownerEmail
      : JSON.stringify({ quickSetup: true });
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state: stateValue,
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
async function sendViaGmail(ownerEmail, { to, subject, html, replyTo, attachments }) {
  const entry = gmailTokens.get(ownerEmail);
  if (!entry) return false;
  try {
    const { auth } = entry;
    const gmail = google.gmail({ version: 'v1', auth });

    // Multipart/mixed so we can attach files (e.g. .ics calendar invites)
    const hasAtt = attachments && attachments.length > 0;
    const boundary = 'rwr-' + Math.random().toString(36).slice(2);
    const head = [
      `From: ${ownerEmail}`,
      `To: ${to}`,
      replyTo ? `Reply-To: ${replyTo}` : '',
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      hasAtt ? `Content-Type: multipart/mixed; boundary="${boundary}"` : 'Content-Type: text/html; charset=utf-8',
    ].filter(Boolean).join('\r\n');

    let body;
    if (hasAtt) {
      const parts = [
        `--${boundary}`,
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: 7bit',
        '',
        html,
      ];
      for (const a of attachments) {
        const ctype = a.contentType || 'application/octet-stream';
        const buf = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content || '', 'utf8');
        parts.push(
          `--${boundary}`,
          `Content-Type: ${ctype}; name="${a.filename}"`,
          `Content-Disposition: attachment; filename="${a.filename}"`,
          'Content-Transfer-Encoding: base64',
          '',
          buf.toString('base64').replace(/(.{76})/g, '$1\r\n'),
        );
      }
      parts.push(`--${boundary}--`);
      body = parts.join('\r\n');
    } else {
      body = html;
    }

    const encoded = Buffer.from(head + '\r\n\r\n' + body).toString('base64url');
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
    return true;
  } catch (e) {
    console.warn(`Gmail send failed for ${ownerEmail}:`, e.message);
    return false;
  }
}

// Smart send: use owner's Gmail if connected, otherwise fall back to server SMTP
async function smartSend({ ownerEmail, to, subject, html, replyTo, attachments }) {
  if (ownerEmail && gmailTokens.has(ownerEmail)) {
    const sent = await sendViaGmail(ownerEmail, { to, subject, html, replyTo, attachments });
    if (sent) return;
  }
  // Fallback to server SMTP
  await sendEmail({ to, subject, html, replyTo, attachments });
}

// ─── Multi-Channel Send ─────────────────────────────────────────────────────
// quickReplies (optional): array of up to 3 short strings (max ~20 chars).
// Renders as tappable button row beneath the message on FB Messenger + IG.
// WhatsApp uses a different interactive-message format (reply_buttons).
// Falls back to plain text silently if channel doesn't support buttons.
async function sendChannelReply(channel, channelConfig, recipientId, text, quickReplies) {
  try {
    const qr = Array.isArray(quickReplies) ? quickReplies.filter(s => typeof s === 'string' && s.trim()).slice(0, 3) : [];
    if (channel === 'whatsapp') return await sendWhatsAppMessage(channelConfig, recipientId, text, qr);
    if (channel === 'instagram') return await sendInstagramMessage(channelConfig, recipientId, text, qr);
    if (channel === 'facebook') return await sendFacebookMessage(channelConfig, recipientId, text, qr);
    return false;
  } catch (e) {
    console.warn(`📱 [${channel}] Send failed:`, e.message);
    return false;
  }
}

async function sendWhatsAppMessage(config, recipientPhone, text, quickReplies = []) {
  // WhatsApp interactive reply_buttons supports up to 3 buttons, each title
  // max 20 chars. Falls back to plain text if no quickReplies provided.
  const body = quickReplies.length
    ? {
        messaging_product: 'whatsapp',
        to: recipientPhone,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: text.slice(0, 1024) },
          action: {
            buttons: quickReplies.slice(0, 3).map((title, i) => ({
              type: 'reply',
              reply: { id: `qr_${i}`, title: title.slice(0, 20) },
            })),
          },
        },
      }
    : {
        messaging_product: 'whatsapp',
        to: recipientPhone,
        type: 'text',
        text: { body: text },
      };
  const r = await fetch(`https://graph.facebook.com/v21.0/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.text();
    console.warn('WhatsApp send error:', err);
    return false;
  }
  return true;
}

async function sendInstagramMessage(config, recipientId, text, quickReplies = []) {
  const message = { text };
  if (quickReplies.length) {
    message.quick_replies = quickReplies.slice(0, 13).map(title => ({
      content_type: 'text',
      title: title.slice(0, 20),
      payload: title.slice(0, 1000),
    }));
  }
  const r = await fetch(`https://graph.facebook.com/v21.0/${config.igUserId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, message }),
  });
  if (!r.ok) {
    const err = await r.text();
    console.warn('Instagram send error:', err);
    return false;
  }
  return true;
}

// Sender_action signals "typing_on" / "typing_off" / "mark_seen" for
// FB Messenger + Instagram. Customer sees "..." dots while Claude composes.
// Fail-silent — typing indicator is decoration, never block on it.
async function sendTypingIndicator(channel, channelConfig, recipientId, on = true) {
  try {
    if (channel === 'facebook') {
      await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${channelConfig.accessToken}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: recipientId }, sender_action: on ? 'typing_on' : 'typing_off' }),
      });
    } else if (channel === 'instagram') {
      await fetch(`https://graph.facebook.com/v21.0/${channelConfig.igUserId}/messages`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${channelConfig.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: recipientId }, sender_action: on ? 'typing_on' : 'typing_off' }),
      });
    }
    // WhatsApp has no typing-indicator API; mark_as_read is closest but
    // not used here to avoid double-read receipts.
  } catch {}
}

// Generic-template carousel for FB Messenger + IG Direct. Up to 10 cards,
// each with image_url, title, subtitle (under 80 chars), and 1-3 buttons.
// Use for browsable service catalogues — way higher conversion than text.
async function sendFacebookCarousel(config, recipientId, cards) {
  const elements = cards.slice(0, 10).map(c => ({
    title: String(c.title || '').slice(0, 80),
    subtitle: c.subtitle ? String(c.subtitle).slice(0, 80) : undefined,
    image_url: c.image || undefined,
    default_action: c.link ? { type: 'web_url', url: c.link, webview_height_ratio: 'tall' } : undefined,
    buttons: c.link ? [{ type: 'web_url', url: c.link, title: (c.btn_text || 'Learn more').slice(0, 20) }] : undefined,
  }));
  const body = {
    recipient: { id: recipientId },
    message: { attachment: { type: 'template', payload: { template_type: 'generic', elements } } },
  };
  const r = await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${config.accessToken}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) { console.warn('FB carousel send error:', await r.text()); return false; }
  return true;
}

async function sendInstagramCarousel(config, recipientId, cards) {
  const elements = cards.slice(0, 10).map(c => ({
    title: String(c.title || '').slice(0, 80),
    subtitle: c.subtitle ? String(c.subtitle).slice(0, 80) : undefined,
    image_url: c.image || undefined,
    buttons: c.link ? [{ type: 'web_url', url: c.link, title: (c.btn_text || 'Learn more').slice(0, 20) }] : undefined,
  }));
  const body = {
    recipient: { id: recipientId },
    message: { attachment: { type: 'template', payload: { template_type: 'generic', elements } } },
  };
  const r = await fetch(`https://graph.facebook.com/v21.0/${config.igUserId}/messages`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) { console.warn('IG carousel send error:', await r.text()); return false; }
  return true;
}

async function sendChannelCarousel(channel, channelConfig, recipientId, cards) {
  try {
    if (channel === 'facebook')  return await sendFacebookCarousel(channelConfig, recipientId, cards);
    if (channel === 'instagram') return await sendInstagramCarousel(channelConfig, recipientId, cards);
    // WhatsApp: list-message format (different shape, deferred)
    return false;
  } catch (e) { console.warn(`[${channel}] carousel send error:`, e.message); return false; }
}

async function sendFacebookMessage(config, recipientId, text, quickReplies = []) {
  const message = { text };
  if (quickReplies.length) {
    message.quick_replies = quickReplies.slice(0, 13).map(title => ({
      content_type: 'text',
      title: title.slice(0, 20),
      payload: title.slice(0, 1000),
    }));
  }
  const r = await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${config.accessToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_type: 'RESPONSE', recipient: { id: recipientId }, message }),
  });
  if (!r.ok) {
    const err = await r.text();
    console.warn('Facebook send error:', err);
    return false;
  }
  return true;
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
const EMAIL_AUTO_REPLY_ENABLED = new Map(); // ownerEmail → { enabled, systemPrompt, config }
const EMAIL_REPLY_STATS = new Map();       // ownerEmail → { replied, bookings, lastReply, followUps }
const STATS_FILE = resolve('data/email-stats.json');
const FOLLOWUP_FILE = resolve('data/email-followups.json');
const PASSWORDS_FILE = resolve('data/dashboard-passwords.json');
const SESSIONS_FILE = resolve('data/dashboard-sessions.json');
const INVITES_FILE = resolve('data/invites.json');
const dashboardPasswords = new Map(); // ownerEmail → hashed password
const dashboardSessions = new Map();  // token → { ownerEmail, expiresAt }
const invites = new Map();            // token → { email, url, type, createdAt, used }
const pendingSetups = new Map();      // token → { profile, createdAt } — temporary store for setup scan results

// ─── Multi-Channel Messaging ─────────────────────────────────────────────────
const CHANNEL_MESSAGES_FILE = resolve('data/channel-messages.json');
const CHANNEL_STATS_FILE = resolve('data/channel-stats.json');
const META_TOKENS_FILE = resolve('data/meta-tokens.json');
const CHANNEL_APPROVALS_FILE = resolve('data/channel-approvals.json');
const CHANNEL_LEADS_FILE = resolve('data/channel_leads.jsonl');   // hoisted from below — referenced by startup customer-index rebuild (TDZ fix)
const channelMessages = new Map();      // ownerEmail → [{ id, channel, senderId, senderName, message, reply, timestamp, status }]
const channelStats = new Map();         // ownerEmail → { whatsapp: { replied, week, lastReply }, instagram: {...}, facebook: {...}, total }
const metaTokens = new Map();           // ownerEmail → { userToken, userTokenExpiry, pages: [{ pageId, pageName, accessToken, igUserId, igUsername, wabaId, waPhoneNumberId, waDisplayPhone }] }
const channelApprovals = new Map();     // approvalId → { ownerEmail, channel, senderId, senderName, draftReply, createdAt }
const pendingQuotes = new Map();        // quoteId → { ownerEmail, channel, senderId, senderName, draft, originalQuestion, createdAt }
const processedMetaMessages = new Set(); // dedup — message IDs already handled
const QUOTES_LEDGER_FILE = resolve('data/quotes.jsonl');
const PENDING_QUOTES_FILE = resolve('data/pending_quotes.json');

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

function loadPendingQuotes() {
  try {
    if (existsSync(PENDING_QUOTES_FILE)) {
      const saved = JSON.parse(readFileSync(PENDING_QUOTES_FILE, 'utf8'));
      for (const [k, v] of Object.entries(saved)) pendingQuotes.set(k, v);
    }
  } catch (e) { console.warn('Failed to load pending quotes:', e.message); }
}
function persistPendingQuotes() {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    const obj = {};
    for (const [k, v] of pendingQuotes) obj[k] = v;
    writeFileSync(PENDING_QUOTES_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.warn('Failed to persist pending quotes:', e.message); }
}
function appendQuoteLedger(entry) {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    appendFileSync(QUOTES_LEDGER_FILE, JSON.stringify(entry) + '\n');
  } catch (e) { console.warn('[quote] ledger append failed:', e.message); }
}

// ─── Notification digest buffer ──────────────────────────────────────────
// In-memory per-owner queue of informational notifications that get
// folded into a single daily digest email. Persisted to disk so the
// buffer survives restarts (otherwise a 4am restart could lose the
// 4am-5pm worth of bookings to summarise).
const NOTIFICATION_DIGEST_FILE  = resolve('data/notification_digest.json');
const DIGEST_LAST_SENT_FILE     = resolve('data/digest_last_sent.json');
const notificationDigestBuffer  = new Map(); // ownerEmail → [{ts, type, summary}]
const digestLastSentDate        = new Map(); // ownerEmail → "YYYY-MM-DD" (idempotency)

function loadDigestState() {
  try {
    if (existsSync(NOTIFICATION_DIGEST_FILE)) {
      const saved = JSON.parse(readFileSync(NOTIFICATION_DIGEST_FILE, 'utf8'));
      for (const [k, v] of Object.entries(saved)) notificationDigestBuffer.set(k, v);
    }
  } catch (e) { console.warn('[digest] load buffer failed:', e.message); }
  try {
    if (existsSync(DIGEST_LAST_SENT_FILE)) {
      const saved = JSON.parse(readFileSync(DIGEST_LAST_SENT_FILE, 'utf8'));
      for (const [k, v] of Object.entries(saved)) digestLastSentDate.set(k, v);
    }
  } catch (e) { console.warn('[digest] load last-sent failed:', e.message); }
}
function persistDigestState() {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    const buf = {}; for (const [k, v] of notificationDigestBuffer) buf[k] = v;
    writeFileSync(NOTIFICATION_DIGEST_FILE, JSON.stringify(buf, null, 2));
    const last = {}; for (const [k, v] of digestLastSentDate) last[k] = v;
    writeFileSync(DIGEST_LAST_SENT_FILE, JSON.stringify(last, null, 2));
  } catch (e) { console.warn('[digest] persist failed:', e.message); }
}

// notify() — wraps smartSend with the digest-vs-immediate decision.
// Use this INSTEAD of smartSend for owner-bound notification emails.
// urgency: 'immediate' (default for unknown event types) | 'digest'
//   (only honoured if the type is in the canBatch whitelist).
// type:    event-type string (e.g. 'new_lead', 'handoff', 'quote_drafted')
//          used to (a) decide batchability, (b) group in the digest UI.
// summary: short one-line text shown in the digest row. If urgency is
//          immediate, summary is ignored (full html sent as-is).
async function notify({ ownerEmail, type, subject, html, summary, urgency }) {
  if (!ownerEmail) return;
  const profile = getOwnerProfile(ownerEmail);
  const cfg = profile?.profile?.notificationDigest || profile?.config?.notificationDigest || {};
  const digestOn = !!cfg.enabled;

  const shouldBatch = digestOn && urgency !== 'immediate' && digestCanBatch(type);

  if (shouldBatch) {
    const buf = notificationDigestBuffer.get(ownerEmail) || [];
    buf.push({ ts: new Date().toISOString(), type, summary: String(summary || subject || type).slice(0, 280) });
    // Cap per-owner buffer to last 500 entries (prevents runaway memory)
    if (buf.length > 500) buf.splice(0, buf.length - 500);
    notificationDigestBuffer.set(ownerEmail, buf);
    persistDigestState();
    return; // not sent now — will roll into the next digest fire
  }

  // Immediate path
  try {
    await smartSend({ ownerEmail, to: ownerEmail, subject, html });
  } catch (e) { console.warn('[notify] send failed:', e.message); }
}

// Per-minute tick to flush due digests. Each owner fires exactly once
// per local date — guarded by digestLastSentDate (resists clock skew,
// double-tick within the same minute, and replay-on-restart).
async function tickDigests() {
  for (const [ownerEmail, entries] of notificationDigestBuffer) {
    if (!entries || entries.length === 0) continue;
    const profile = getOwnerProfile(ownerEmail);
    const cfg = profile?.profile?.notificationDigest || profile?.config?.notificationDigest || {};
    if (!cfg.enabled) continue;
    if (!shouldFireDigest(cfg)) continue;

    const todayLocal = (() => {
      try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone || 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      } catch { return new Date().toISOString().slice(0, 10); }
    })();
    if (digestLastSentDate.get(ownerEmail) === todayLocal) continue;

    // Send + clear
    const businessName = profile?.profile?.businessName || profile?.businessName || 'your business';
    const html = renderDigestHtml(entries, businessName);
    if (html) {
      try {
        await smartSend({
          ownerEmail, to: ownerEmail,
          subject: `📋 Aria's daily digest — ${entries.length} event${entries.length === 1 ? '' : 's'}`,
          html,
        });
        console.log(`📋 [digest] sent ${entries.length}-entry digest to ${ownerEmail}`);
      } catch (e) { console.warn('[digest] send failed:', e.message); }
    }
    notificationDigestBuffer.set(ownerEmail, []);
    digestLastSentDate.set(ownerEmail, todayLocal);
    persistDigestState();
  }
}

function loadInvites() {
  try {
    if (existsSync(INVITES_FILE)) {
      const saved = JSON.parse(readFileSync(INVITES_FILE, 'utf8'));
      for (const [token, invite] of Object.entries(saved)) invites.set(token, invite);
    }
  } catch (e) { console.warn('Failed to load invites:', e.message); }
}

function persistInvites() {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    const obj = {};
    for (const [token, invite] of invites) obj[token] = invite;
    writeFileSync(INVITES_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.warn('Failed to persist invites:', e.message); }
}

function loadPasswords() {
  try {
    if (existsSync(PASSWORDS_FILE)) {
      const saved = JSON.parse(readFileSync(PASSWORDS_FILE, 'utf8'));
      for (const [email, hash] of Object.entries(saved)) dashboardPasswords.set(email, hash);
    }
  } catch (e) { console.warn('Failed to load passwords:', e.message); }
}

function persistPasswords() {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    const obj = {};
    for (const [email, hash] of dashboardPasswords) obj[email] = hash;
    writeFileSync(PASSWORDS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.warn('Failed to persist passwords:', e.message); }
}

function loadSessions() {
  try {
    if (existsSync(SESSIONS_FILE)) {
      const saved = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
      for (const [token, session] of Object.entries(saved)) {
        if (session.expiresAt > Date.now()) dashboardSessions.set(token, session);
      }
    }
  } catch (e) { console.warn('Failed to load sessions:', e.message); }
}

function persistSessions() {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    const obj = {};
    for (const [token, session] of dashboardSessions) {
      if (session.expiresAt > Date.now()) obj[token] = session;
    }
    writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.warn('Failed to persist sessions:', e.message); }
}

// Password hashing — scrypt with random salt. Old format was a 32-bit
// non-crypto hash trivially reversible by a Python one-liner. New format is
// `s2$<saltHex>$<hashHex>`. Old `h_*` hashes still verify so existing users
// don't get locked out; first successful login re-hashes them to scrypt.
function simpleHash(str) {
  // BACKCOMPAT shim — only called by reads of the password file. Returns the
  // legacy format so old stored hashes still compare equal during migration.
  // New writes go through scryptHash(); migrated reads update in place.
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return 'h_' + Math.abs(hash).toString(36);
}

function scryptHash(password) {
  const salt = crypto.randomBytes(16);
  // N=2^15 is a reasonable web-app default — ~50ms on modern CPU, makes a
  // GPU-cracking spree expensive without making login feel slow.
  // N=16384 = OWASP minimum, ~25ms per hash, fits in Node's default 32MB scrypt maxmem.
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `s2$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return { ok: false, needsRehash: false };
  if (stored.startsWith('s2$')) {
    const parts = stored.split('$');
    if (parts.length !== 3) return { ok: false, needsRehash: false };
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    let actual;
    try { actual = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }); }
    catch { return { ok: false, needsRehash: false }; }
    if (actual.length !== expected.length) return { ok: false, needsRehash: false };
    return { ok: crypto.timingSafeEqual(actual, expected), needsRehash: false };
  }
  // Legacy h_* format — verify, then signal caller to re-hash with scrypt.
  if (stored.startsWith('h_')) {
    return { ok: simpleHash(password) === stored, needsRehash: true };
  }
  return { ok: false, needsRehash: false };
}

function generateSessionToken() {
  // 32 bytes = 256 bits of entropy via CSPRNG. Previous Math.random()-based
  // version had ~165 bits and was predictable from a V8 internal state leak.
  return crypto.randomBytes(32).toString('hex');
}

function createSession(ownerEmail) {
  const token = generateSessionToken();
  dashboardSessions.set(token, { ownerEmail, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 }); // 7 days
  persistSessions();
  return token;
}

function validateSession(token, ownerEmail) {
  const session = dashboardSessions.get(token);
  if (!session) return false;
  if (session.expiresAt < Date.now()) { dashboardSessions.delete(token); persistSessions(); return false; }
  return session.ownerEmail === ownerEmail;
}
const pendingFollowUps = new Map();        // msgId → { ownerEmail, senderEmail, senderName, subject, sentAt, followUpAt, attempts }
const PENDING_APPROVALS_FILE = resolve('data/pending-approvals.json');
const pendingApprovals = new Map();        // approvalId → { ownerEmail, senderEmail, senderName, subject, threadId, msgId, replyHtml, brandedHtml, booking, createdAt }
const REPLY_LOG_FILE = resolve('data/reply-log.json');
const replyLog = [];                       // [{ ownerEmail, senderEmail, subject, replyPreview, sentAt, type }]

function loadPendingApprovals() {
  try {
    if (existsSync(PENDING_APPROVALS_FILE)) {
      const saved = JSON.parse(readFileSync(PENDING_APPROVALS_FILE, 'utf8'));
      for (const [id, a] of Object.entries(saved)) pendingApprovals.set(id, a);
    }
  } catch (e) { console.warn('Failed to load approvals:', e.message); }
}

function persistPendingApprovals() {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    const obj = {};
    for (const [id, a] of pendingApprovals) obj[id] = a;
    writeFileSync(PENDING_APPROVALS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.warn('Failed to persist approvals:', e.message); }
}

function loadReplyLog() {
  try {
    if (existsSync(REPLY_LOG_FILE)) {
      const saved = JSON.parse(readFileSync(REPLY_LOG_FILE, 'utf8'));
      replyLog.push(...saved);
    }
  } catch (e) { console.warn('Failed to load reply log:', e.message); }
}

function persistReplyLog() {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    const trimmed = replyLog.slice(-200);
    writeFileSync(REPLY_LOG_FILE, JSON.stringify(trimmed, null, 2));
  } catch (e) { console.warn('Failed to persist reply log:', e.message); }
}

function logReply(ownerEmail, senderEmail, subject, replyPreview, type, leadScore, category) {
  replyLog.push({ ownerEmail, senderEmail, subject, replyPreview: replyPreview.substring(0, 200), sentAt: new Date().toISOString(), type, leadScore: leadScore || null, category: category || null });
  if (replyLog.length > 200) replyLog.splice(0, replyLog.length - 200);
  persistReplyLog();
}

function loadEmailStats() {
  try {
    if (existsSync(STATS_FILE)) {
      const saved = JSON.parse(readFileSync(STATS_FILE, 'utf8'));
      for (const [email, stats] of Object.entries(saved)) EMAIL_REPLY_STATS.set(email, stats);
    }
  } catch (e) { console.warn('Failed to load email stats:', e.message); }
}

function persistEmailStats() {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    const obj = {};
    for (const [email, stats] of EMAIL_REPLY_STATS) obj[email] = stats;
    writeFileSync(STATS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.warn('Failed to persist email stats:', e.message); }
}

function loadFollowUps() {
  try {
    if (existsSync(FOLLOWUP_FILE)) {
      const saved = JSON.parse(readFileSync(FOLLOWUP_FILE, 'utf8'));
      for (const [id, fu] of Object.entries(saved)) pendingFollowUps.set(id, fu);
      console.log(`📧 Restored ${pendingFollowUps.size} pending follow-ups`);
    }
  } catch (e) { console.warn('Failed to load follow-ups:', e.message); }
}

function persistFollowUps() {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    const obj = {};
    for (const [id, fu] of pendingFollowUps) obj[id] = fu;
    writeFileSync(FOLLOWUP_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.warn('Failed to persist follow-ups:', e.message); }
}

function trackReply(ownerEmail, type, leadScore, category) {
  const stats = EMAIL_REPLY_STATS.get(ownerEmail) || { replied: 0, bookings: 0, followUps: 0, urgent: 0, lastReply: null, history: [], leads: { hot: 0, warm: 0, cold: 0 }, categories: { quote: 0, booking: 0, complaint: 0, feedback: 0, general: 0 } };
  if (!stats.leads) stats.leads = { hot: 0, warm: 0, cold: 0 };
  if (!stats.categories) stats.categories = { quote: 0, booking: 0, complaint: 0, feedback: 0, general: 0 };
  if (type === 'reply') { stats.replied++; stats.lastReply = new Date().toISOString(); }
  if (type === 'booking') stats.bookings++;
  if (type === 'followup') stats.followUps++;
  if (type === 'urgent') stats.urgent++;
  if (leadScore && stats.leads[leadScore] !== undefined) stats.leads[leadScore]++;
  if (category && stats.categories[category] !== undefined) stats.categories[category]++;
  stats.history.push({ type, time: new Date().toISOString(), leadScore, category });
  if (stats.history.length > 200) stats.history = stats.history.slice(-200);
  EMAIL_REPLY_STATS.set(ownerEmail, stats);
  persistEmailStats();
}

function enableEmailAutoReply(ownerEmail, systemPrompt, config = {}) {
  EMAIL_AUTO_REPLY_ENABLED.set(ownerEmail, { enabled: true, systemPrompt, config });
  persistAutoReply();
  console.log(`📧 Auto-reply enabled for ${ownerEmail}`);
}

function disableEmailAutoReply(ownerEmail) {
  EMAIL_AUTO_REPLY_ENABLED.delete(ownerEmail);
  persistAutoReply();
  console.log(`📧 Auto-reply disabled for ${ownerEmail}`);
}

// Check if currently within business hours
function isWithinBusinessHours(config) {
  if (!config?.hoursStart || !config?.hoursEnd) return null; // no hours set = always on
  const now = new Date();
  const hour = now.getUTCHours() + (config.timezone || 0);
  const day = now.getUTCDay();
  // Skip weekends if configured
  if (config.skipWeekends && (day === 0 || day === 6)) return false;
  return hour >= config.hoursStart && hour < config.hoursEnd;
}

// Wrap reply HTML in a branded email template
function wrapInTemplate(replyHtml, config, isOutOfHours) {
  const brandColor = config?.brandColor || '#6C63FF';
  const businessName = config?.businessName || '';
  const phone = config?.phone || '';
  const website = config?.website || '';
  const ownerEmail = config?.ownerEmail || '';

  const facebook = config?.facebook || '';
  const instagram = config?.instagram || '';
  const bookingUrl = config?.bookingUrl || '';
  const reviewsUrl = config?.reviewsUrl || '';

  const signature = [
    businessName ? `<strong>${businessName}</strong>` : '',
    phone ? `📞 ${phone}` : '',
    ownerEmail ? `✉️ ${ownerEmail}` : '',
    website ? `🌐 <a href="${website}" style="color:${brandColor};text-decoration:none;">${website.replace(/^https?:\/\//, '')}</a>` : '',
  ].filter(Boolean).join('<br>');

  const socialLinks = [
    facebook ? `<a href="${facebook}" style="color:${brandColor};text-decoration:none;margin-right:12px;">Facebook</a>` : '',
    instagram ? `<a href="${instagram}" style="color:${brandColor};text-decoration:none;margin-right:12px;">Instagram</a>` : '',
    bookingUrl ? `<a href="${bookingUrl}" style="color:${brandColor};text-decoration:none;margin-right:12px;">Book Now</a>` : '',
    reviewsUrl ? `<a href="${reviewsUrl}" style="color:${brandColor};text-decoration:none;">Reviews</a>` : '',
  ].filter(Boolean).join('');
  const socialBar = socialLinks ? `<div style="padding:12px 28px;text-align:center;font-size:12px;">${socialLinks}</div>` : '';

  const oohNotice = isOutOfHours === false ? '' : isOutOfHours ? `
    <div style="background:#fff8e1;border-left:4px solid #ffc107;padding:12px 16px;border-radius:0 8px 8px 0;margin-bottom:16px;font-size:13px;color:#666;">
      We're currently outside business hours. We've received your message and will follow up during working hours.
    </div>` : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <div style="max-width:580px;margin:20px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
    <div style="background:${brandColor};padding:20px 28px;">
      <div style="font-size:18px;font-weight:700;color:#ffffff;">${businessName || 'Hi there'}</div>
    </div>
    <div style="padding:28px;font-size:14px;line-height:1.7;color:#333;">
      ${oohNotice}
      ${replyHtml}
    </div>
    ${signature ? `
    <div style="border-top:1px solid #eee;padding:20px 28px;font-size:12.5px;line-height:1.8;color:#888;">
      ${signature}
    </div>` : ''}
    ${socialBar}
    <div style="background:#fafafa;padding:12px 28px;text-align:center;font-size:11px;color:#bbb;">
      Powered by <a href="https://aireyai.co.uk" style="color:${brandColor};text-decoration:none;">AireyAi</a>
    </div>
  </div>
</body></html>`;
}

// Detect if email is spam, cold outreach, marketing, or automated
function isSpamOrMarketing(from, subject, body) {
  const spamPatterns = [
    /unsubscribe/i, /opt.?out/i, /click here to/i, /limited.?time.?offer/i,
    /act now/i, /congratulations.*won/i, /claim your/i, /free trial/i,
    /discount code/i, /special offer/i, /exclusive deal/i, /bulk email/i,
    /mailing list/i, /view in browser/i, /email preferences/i,
    /just following up.*haven't heard/i, /touching base/i, /circle back/i,
    /I came across your/i, /I noticed your company/i, /I'd love to connect/i,
    /quick question about your/i, /partnership opportunity/i, /collaboration opportunity/i,
    /we help (companies|businesses|brands)/i, /increase your (revenue|sales|traffic)/i,
    /SEO (services|agency|expert)/i, /lead generation/i, /marketing (agency|services)/i,
    /schedule a (demo|call|meeting) with/i, /book a time/i,
  ];
  const combined = `${subject} ${body}`;
  const matches = spamPatterns.filter(p => p.test(combined));
  return matches.length >= 2; // 2+ spam signals = skip
}

// Detect urgent emails that need forwarding
function isUrgentEmail(subject, body) {
  const urgentPatterns = [
    /urgent/i, /emergency/i, /asap/i, /immediately/i,
    /complaint/i, /not happy/i, /disappointed/i, /disgusted/i,
    /refund/i, /broken/i, /damaged/i, /safety/i,
    /legal action/i, /solicitor/i, /lawyer/i, /trading standards/i,
  ];
  const combined = `${subject} ${body}`;
  return urgentPatterns.some(p => p.test(combined));
}

// ─── Conversation Memory ─────────────────────────────────────────────────────
// Stores recent email exchanges per sender so Aria has context across threads
const CONV_MEMORY_FILE = resolve('data/conversation-memory.json');
const conversationMemory = new Map(); // key: "ownerEmail::senderEmail" → [{ role, subject, preview, date }]

function loadConversationMemory() {
  try {
    if (existsSync(CONV_MEMORY_FILE)) {
      const saved = JSON.parse(readFileSync(CONV_MEMORY_FILE, 'utf8'));
      for (const [key, entries] of Object.entries(saved)) conversationMemory.set(key, entries);
    }
  } catch (e) { console.warn('Failed to load conversation memory:', e.message); }
}

function persistConversationMemory() {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    const obj = {};
    for (const [key, entries] of conversationMemory) obj[key] = entries;
    writeFileSync(CONV_MEMORY_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.warn('Failed to persist conversation memory:', e.message); }
}

// Per-conversation runtime state. Currently tracks paused/escalated status
// so owner-handoff actually stops Aria from talking over a human takeover.
const CONV_STATE_FILE = resolve('data/conversation_state.json');
const conversationState = new Map(); // memKey → { paused, escalatedAt, reason, resumedAt }
try {
  if (existsSync(CONV_STATE_FILE)) {
    const saved = JSON.parse(readFileSync(CONV_STATE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(saved)) conversationState.set(k, v);
  }
} catch (e) { console.warn('Failed to load conv state:', e.message); }

function persistConversationState() {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    const obj = {};
    for (const [k, v] of conversationState) obj[k] = v;
    writeFileSync(CONV_STATE_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.warn('Failed to persist conv state:', e.message); }
}

function addToConversationMemory(ownerEmail, senderEmail, role, subject, preview) {
  const key = `${ownerEmail}::${senderEmail.toLowerCase()}`;
  const history = conversationMemory.get(key) || [];
  history.push({ role, subject, preview: preview.substring(0, 300), date: new Date().toISOString() });
  // Keep last 10 exchanges per sender
  if (history.length > 10) history.splice(0, history.length - 10);
  conversationMemory.set(key, history);
  persistConversationMemory();
}

function getConversationContext(ownerEmail, senderEmail) {
  const key = `${ownerEmail}::${senderEmail.toLowerCase()}`;
  const history = conversationMemory.get(key) || [];
  if (!history.length) return '';
  return '\n\nPREVIOUS EMAIL HISTORY with this sender (most recent last):\n' +
    history.map(h => `[${h.role === 'sender' ? 'THEM' : 'US'}] Subject: ${h.subject}\n${h.preview}`).join('\n---\n') +
    '\n\nUse this context to give a more personal, informed reply. Reference previous conversations where relevant.';
}

// ─── Rate Limiting ───────────────────────────────────────────────────────────
// Prevent multiple auto-replies to the same sender within a short window
const replyRateLimit = new Map(); // "ownerEmail::senderEmail" → lastReplyTimestamp
const RATE_LIMIT_WINDOW = 5 * 60 * 1000; // 5 minutes

function isRateLimited(ownerEmail, senderEmail) {
  const key = `${ownerEmail}::${senderEmail.toLowerCase()}`;
  const lastReply = replyRateLimit.get(key);
  if (lastReply && (Date.now() - lastReply) < RATE_LIMIT_WINDOW) return true;
  return false;
}

function markReplied(ownerEmail, senderEmail) {
  const key = `${ownerEmail}::${senderEmail.toLowerCase()}`;
  replyRateLimit.set(key, Date.now());
}

// ─── Out-of-Office Detection ─────────────────────────────────────────────────
function isOutOfOffice(subject, body) {
  const oooPatterns = [
    /out of (the )?office/i, /auto[- ]?reply/i, /automatic reply/i,
    /on (annual |sick )?leave/i, /away from (my )?desk/i, /currently away/i,
    /on holiday/i, /on vacation/i, /limited access to email/i,
    /I('m| am) (currently )?(out|away|off)/i, /will (return|be back|respond)/i,
    /no longer (work|with|at)/i, /maternity|paternity leave/i,
  ];
  const combined = `${subject} ${body}`;
  return oooPatterns.filter(p => p.test(combined)).length >= 1;
}

// ─── Lead Scoring ────────────────────────────────────────────────────────────
function scoreEmail(subject, body, urgent) {
  let score = 0;
  const combined = `${subject} ${body}`.toLowerCase();

  // Hot signals (+3 each)
  if (/quote|estimate|pricing|how much|cost/i.test(combined)) score += 3;
  if (/book|appointment|schedule|available|when can/i.test(combined)) score += 3;
  if (/asap|urgent|emergency|today|tomorrow/i.test(combined)) score += 3;
  if (/hire|need.*done|looking for/i.test(combined)) score += 3;

  // Warm signals (+1 each)
  if (/interested|considering|thinking about/i.test(combined)) score += 1;
  if (/do you (offer|provide|do|cover)/i.test(combined)) score += 1;
  if (/phone|call|number|contact/i.test(combined)) score += 1;
  if (/location|area|postcode|address/i.test(combined)) score += 1;

  // Cold signals (-1 each)
  if (/just (wondering|asking|curious)/i.test(combined)) score -= 1;
  if (/no rush|no hurry|whenever/i.test(combined)) score -= 1;

  if (urgent) score += 2;

  if (score >= 5) return 'hot';
  if (score >= 2) return 'warm';
  return 'cold';
}

// ─── Email Category Detection ────────────────────────────────────────────────
function categorizeEmail(subject, body) {
  const combined = `${subject} ${body}`.toLowerCase();
  if (/quote|estimate|pricing|how much|cost|price/i.test(combined)) return 'quote';
  if (/book|appointment|schedule|available|reservation/i.test(combined)) return 'booking';
  if (/complaint|not happy|disappointed|refund|damaged|broken|disgusted|terrible/i.test(combined)) return 'complaint';
  if (/thank|thanks|great (job|work|service)|pleased|happy with/i.test(combined)) return 'feedback';
  return 'general';
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

      // Extract body text — try plain text first, fall back to HTML
      let bodyText = '';
      const parts = full.data.payload.parts || [];
      if (parts.length) {
        const textPart = parts.find(p => p.mimeType === 'text/plain');
        const htmlPart = parts.find(p => p.mimeType === 'text/html');
        if (textPart?.body?.data) {
          bodyText = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
        } else if (htmlPart?.body?.data) {
          bodyText = Buffer.from(htmlPart.body.data, 'base64').toString('utf-8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        } else if (parts[0]?.body?.data) {
          bodyText = Buffer.from(parts[0].body.data, 'base64').toString('utf-8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        }
        // Check nested parts (multipart/alternative inside multipart/mixed)
        if (!bodyText.trim()) {
          for (const part of parts) {
            const subParts = part.parts || [];
            const sub = subParts.find(p => p.mimeType === 'text/plain') || subParts.find(p => p.mimeType === 'text/html');
            if (sub?.body?.data) {
              bodyText = Buffer.from(sub.body.data, 'base64').toString('utf-8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
              break;
            }
          }
        }
      } else if (full.data.payload.body?.data) {
        bodyText = Buffer.from(full.data.payload.body.data, 'base64').toString('utf-8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      }

      // If body is still empty, use the subject line as context
      if (!bodyText.trim() && subject.trim()) {
        bodyText = subject;
      }

      if (!bodyText.trim()) { repliedEmails.add(msg.id); continue; }

      // Strip email signatures and quoted replies
      bodyText = bodyText.split(/\n--\s*\n/)[0].split(/\nOn .+ wrote:/)[0].trim();

      const senderName = from.split('<')[0].trim().replace(/"/g, '') || 'there';
      const cfg = config.config || {};

      // Spam/marketing filter
      if (isSpamOrMarketing(from, subject, bodyText)) {
        console.log(`🚫 Skipped spam/marketing from ${senderEmail}: "${subject}"`);
        repliedEmails.add(msg.id);
        continue;
      }

      // Out-of-office detection — don't reply to OOO auto-replies
      if (isOutOfOffice(subject, bodyText)) {
        console.log(`🏖️ Skipped out-of-office from ${senderEmail}: "${subject}"`);
        repliedEmails.add(msg.id);
        // Also cancel any pending follow-ups for this sender
        for (const [fuId, fu] of pendingFollowUps) {
          if (fu.senderEmail.toLowerCase() === senderEmail.toLowerCase() && fu.ownerEmail === ownerEmail) {
            pendingFollowUps.delete(fuId);
          }
        }
        persistFollowUps();
        continue;
      }

      // Rate limiting — skip if we already replied to this sender recently
      if (isRateLimited(ownerEmail, senderEmail)) {
        console.log(`⏳ Rate-limited reply to ${senderEmail} (replied <5 min ago)`);
        repliedEmails.add(msg.id);
        continue;
      }

      // Detect attachments
      const hasAttachments = (full.data.payload.parts || []).some(p => p.filename && p.filename.length > 0);
      const attachmentNames = (full.data.payload.parts || []).filter(p => p.filename && p.filename.length > 0).map(p => p.filename);

      // Urgent email detection — forward to owner's phone via email
      const urgent = isUrgentEmail(subject, bodyText);

      // Lead scoring and categorization
      const leadScore = scoreEmail(subject, bodyText, urgent);
      const emailCategory = categorizeEmail(subject, bodyText);
      if (urgent && cfg.phone) {
        console.log(`🚨 URGENT email from ${senderEmail}: "${subject}"`);
        trackReply(ownerEmail, 'urgent');
        // Send SMS-style alert to owner (short email to their personal address)
        try {
          await sendEmail({
            to: ownerEmail,
            subject: `🚨 URGENT: ${subject}`,
            html: `<p><strong>Urgent email from ${senderName} (${senderEmail})</strong></p><p>Subject: ${subject}</p><p>${bodyText.substring(0, 300)}...</p><p><em>This was flagged as urgent by Aria. Please respond directly.</em></p>`,
          });
        } catch (e) { console.warn('Failed to send urgent alert:', e.message); }
      }

      // Check business hours
      const withinHours = isWithinBusinessHours(cfg);

      console.log(`📧 New email from ${senderEmail}: "${subject}"${withinHours === false ? ' [OUT OF HOURS]' : ''}${urgent ? ' [URGENT]' : ''}`);

      // Generate reply with Claude (also detects bookings)
      const hoursContext = withinHours === false ? '\n\nIMPORTANT: It is currently outside business hours. Acknowledge their message warmly, let them know you have received it, and that the team will follow up during working hours. Still answer any simple questions you can.' : '';
      // Inject knowledge base into prompt
      const kbEntries = knowledgeBase.get(ownerEmail) || [];
      const kbContext = kbEntries.length ? '\n\nFREQUENTLY ASKED QUESTIONS — use these to answer accurately:\n' + kbEntries.map(e => `Q: ${e.question}\nA: ${e.answer}`).join('\n\n') : '';
      // Conversation memory — previous exchanges with this sender
      const convContext = getConversationContext(ownerEmail, senderEmail);
      // Attachment awareness
      const attachContext = hasAttachments ? `\n\nNOTE: This email includes ${attachmentNames.length} attachment(s): ${attachmentNames.join(', ')}. Acknowledge that you received their attachments in your reply.` : '';

      // Save incoming email to conversation memory
      addToConversationMemory(ownerEmail, senderEmail, 'sender', subject, bodyText);

      const result = await generateEmailReply(config.systemPrompt + hoursContext + kbContext + convContext + attachContext, senderName, senderEmail, subject, bodyText);

      if (result?.reply) {
        // Wrap in branded template
        const brandedHtml = wrapInTemplate(result.reply, { ...cfg, ownerEmail }, withinHours === false);
        const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
        const threadId = full.data.threadId;

        // Approval mode — email draft to owner instead of sending directly
        if (cfg.approvalMode) {
          const approvalId = generateSessionToken();
          const serverUrl = process.env.GOOGLE_REDIRECT_URI?.replace('/auth/gmail/callback', '') || `http://localhost:${process.env.PORT || 3000}`;
          pendingApprovals.set(approvalId, {
            ownerEmail, senderEmail, senderName, subject: replySubject, threadId, msgId,
            replyHtml: result.reply, brandedHtml, booking: result.booking, createdAt: Date.now(),
          });
          persistPendingApprovals();

          // Send approval email to owner
          try {
            await smartSend({ ownerEmail, to: ownerEmail, subject: `✏️ Review Aria's draft reply to ${senderName}`,
              html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:20px;">
                <h2 style="color:#1a1a2e;margin-bottom:4px;">New email from ${senderName}</h2>
                <p style="color:#888;font-size:13px;margin-bottom:16px;">Subject: ${subject}</p>
                <div style="background:#f8f8fc;border-radius:10px;padding:16px;margin-bottom:20px;">
                  <p style="font-size:12px;color:#999;margin-bottom:8px;">THEIR MESSAGE:</p>
                  <p style="color:#333;font-size:14px;line-height:1.6;">${bodyText.substring(0, 500)}</p>
                </div>
                <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px;margin-bottom:20px;">
                  <p style="font-size:12px;color:#999;margin-bottom:8px;">ARIA'S DRAFT REPLY:</p>
                  <div style="color:#333;font-size:14px;line-height:1.6;">${result.reply}</div>
                </div>
                <div style="display:flex;gap:12px;">
                  <a href="${serverUrl}/api/email-autoreply/approve?id=${approvalId}" style="display:inline-block;padding:12px 24px;background:#00e5a0;color:#0d0d1f;border-radius:10px;text-decoration:none;font-weight:600;">✓ Send Reply</a>
                  <a href="${serverUrl}/api/email-autoreply/reject?id=${approvalId}" style="display:inline-block;padding:12px 24px;background:#ff6b6b;color:#fff;border-radius:10px;text-decoration:none;font-weight:600;">✗ Discard</a>
                </div>
                <p style="color:#999;font-size:11px;margin-top:16px;">This draft will expire in 24 hours if not approved.</p>
              </div>` });
            console.log(`✏️ Approval email sent to ${ownerEmail} for reply to ${senderEmail}`);
          } catch (e) { console.warn('Failed to send approval email:', e.message); }

          // Mark as read but don't send reply yet
          await gmail.users.messages.modify({ userId: 'me', id: msg.id, requestBody: { removeLabelIds: ['UNREAD'] } });
        } else {
          // Auto mode — send immediately
          const headerLines = [
            `From: ${ownerEmail}`,
            `To: ${senderEmail}`,
            `Subject: ${replySubject}`,
            msgId ? `In-Reply-To: ${msgId}` : '',
            msgId ? `References: ${msgId}` : '',
            'MIME-Version: 1.0',
            'Content-Type: text/html; charset=utf-8',
          ].filter(Boolean).join('\r\n');
          const replyHeaders = headerLines + '\r\n\r\n' + brandedHtml;

          const encoded = Buffer.from(replyHeaders).toString('base64url');
          await gmail.users.messages.send({
            userId: 'me',
            requestBody: { raw: encoded, threadId },
          });

          await gmail.users.messages.modify({
            userId: 'me', id: msg.id,
            requestBody: { removeLabelIds: ['UNREAD'] },
          });

          trackReply(ownerEmail, 'reply', leadScore, emailCategory);
          logReply(ownerEmail, senderEmail, subject, result.reply, 'auto', leadScore, emailCategory);
          addToConversationMemory(ownerEmail, senderEmail, 'us', subject, result.reply);
          markReplied(ownerEmail, senderEmail);
          console.log(`✅ Auto-replied to ${senderEmail} re: "${subject}" [${leadScore}/${emailCategory}]`);

          // Schedule follow-up check (24h)
          if (cfg.followUps !== false) {
            pendingFollowUps.set(msg.id, {
              ownerEmail, senderEmail, senderName, subject, threadId,
              sentAt: Date.now(), followUpAt: Date.now() + 24 * 60 * 60 * 1000, attempts: 0,
            });
            persistFollowUps();
          }
        }

        // If a booking was detected, create a Google Calendar event
        if (result.booking) {
          const b = result.booking;
          b.email = b.email || senderEmail;
          b.name  = b.name || senderName;
          console.log(`📅 Booking detected in email from ${senderEmail}: ${b.datetime}`);
          trackReply(ownerEmail, 'booking');
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

// Follow-up check loop — every 30 minutes, check if leads replied
setInterval(async () => {
  const now = Date.now();
  for (const [msgId, fu] of pendingFollowUps) {
    if (now < fu.followUpAt || fu.attempts >= 2) {
      if (fu.attempts >= 2) { pendingFollowUps.delete(msgId); persistFollowUps(); }
      continue;
    }
    const entry = gmailTokens.get(fu.ownerEmail);
    const config = EMAIL_AUTO_REPLY_ENABLED.get(fu.ownerEmail);
    if (!entry || !config?.enabled) continue;

    try {
      const gmail = google.gmail({ version: 'v1', auth: entry.auth });
      // Check if the sender replied in this thread
      const thread = await gmail.users.threads.get({ userId: 'me', id: fu.threadId, format: 'metadata', metadataHeaders: ['From'] });
      const senderReplied = thread.data.messages?.some(m => {
        const f = m.payload.headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
        return f.toLowerCase().includes(fu.senderEmail.toLowerCase()) && m.id !== msgId;
      });

      if (senderReplied) {
        pendingFollowUps.delete(msgId);
        persistFollowUps();
        continue;
      }

      // Send follow-up
      const followUpNum = fu.attempts + 1;
      const cfg = config.config || {};
      const followUpReply = await generateEmailReply(
        config.systemPrompt + `\n\nThis is follow-up #${followUpNum}. The customer hasn't replied to your previous email. Send a brief, friendly follow-up. Don't be pushy — just check in and remind them you're here to help.`,
        fu.senderName, fu.senderEmail, fu.subject, `(Follow-up to previous conversation about: ${fu.subject})`
      );

      if (followUpReply?.reply) {
        const brandedHtml = wrapInTemplate(followUpReply.reply, { ...cfg, ownerEmail: fu.ownerEmail }, false);
        const replySubject = fu.subject.startsWith('Re:') ? fu.subject : `Re: ${fu.subject}`;
        const headerLines = [
          `From: ${fu.ownerEmail}`,
          `To: ${fu.senderEmail}`,
          `Subject: ${replySubject}`,
          'MIME-Version: 1.0',
          'Content-Type: text/html; charset=utf-8',
        ].join('\r\n');
        const raw = headerLines + '\r\n\r\n' + brandedHtml;
        await gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw: Buffer.from(raw).toString('base64url'), threadId: fu.threadId },
        });
        trackReply(fu.ownerEmail, 'followup');
        console.log(`📧 Follow-up #${followUpNum} sent to ${fu.senderEmail} re: "${fu.subject}"`);
      }

      fu.attempts++;
      fu.followUpAt = now + 48 * 60 * 60 * 1000; // next follow-up in 48h
      persistFollowUps();
    } catch (e) {
      console.warn(`Follow-up check failed for ${fu.senderEmail}:`, e.message);
    }
  }
}, 30 * 60 * 1000); // every 30 minutes

// ─── Email Auto-Reply API Routes ─────────────────────────────────────────────

// Enable auto-reply for an owner (with extended config)
app.post('/api/email-autoreply/enable', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  const { owner, systemPrompt, config: cfg } = req.body;
  if (!owner) return res.status(400).json({ error: 'owner required' });
  if (!gmailTokens.has(owner)) return res.status(400).json({ error: 'Gmail not connected for this owner' });
  enableEmailAutoReply(owner, systemPrompt || 'You are a helpful business assistant.', cfg || {});
  res.json({ ok: true, owner, enabled: true });
});

// Disable auto-reply
app.post('/api/email-autoreply/disable', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  const { owner } = req.body;
  disableEmailAutoReply(owner);
  res.json({ ok: true, owner, enabled: false });
});

// Check status — exposes config + reply stats, admin only
app.get('/api/email-autoreply/status', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  const { owner } = req.query;
  const config = EMAIL_AUTO_REPLY_ENABLED.get(owner);
  const stats = EMAIL_REPLY_STATS.get(owner) || { replied: 0, bookings: 0, followUps: 0, urgent: 0, lastReply: null, leads: { hot: 0, warm: 0, cold: 0 }, categories: { quote: 0, booking: 0, complaint: 0, feedback: 0, general: 0 } };
  res.json({ owner, enabled: !!config?.enabled, config: config?.config || {}, stats });
});

// Debug — show what's in the inbox and why each email would be skipped.
// Returns raw inbox previews and sender addresses — strict admin only.
app.post('/api/email-autoreply/debug', async (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  const { owner } = req.body;
  if (!owner) return res.status(400).json({ error: 'owner required' });
  const entry = gmailTokens.get(owner);
  if (!entry) return res.status(400).json({ error: 'Gmail not connected' });
  try {
    const gmail = google.gmail({ version: 'v1', auth: entry.auth });
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread is:inbox -from:me newer_than:1h',
      maxResults: 10,
    });
    const messages = list.data.messages || [];
    const results = [];
    for (const msg of messages) {
      const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const headers = full.data.payload.headers;
      const from = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
      const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
      const senderEmail = from.match(/<(.+?)>/)?.[1] || from.trim();

      let skip = null;
      if (repliedEmails.has(msg.id)) skip = 'already in repliedEmails set';
      else if (/noreply|no-reply|mailer-daemon|postmaster|notifications?@|newsletter|digest|updates?@/i.test(senderEmail)) skip = 'automated sender';
      else if (senderEmail.toLowerCase() === owner.toLowerCase()) skip = 'from self';
      else {
        const thread = await gmail.users.threads.get({ userId: 'me', id: full.data.threadId, format: 'metadata', metadataHeaders: ['From'] });
        const threadMsgs = thread.data.messages || [];
        const weReplied = threadMsgs.some(m => {
          const f = m.payload.headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
          return f.toLowerCase().includes(owner.toLowerCase()) && m.id !== msg.id;
        });
        if (weReplied) skip = 'already replied in thread';
      }

      let bodyText = '';
      const parts = full.data.payload.parts || [];
      if (parts.length) {
        const textPart = parts.find(p => p.mimeType === 'text/plain') || parts[0];
        if (textPart?.body?.data) bodyText = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
      } else if (full.data.payload.body?.data) {
        bodyText = Buffer.from(full.data.payload.body.data, 'base64').toString('utf-8');
      }
      if (!skip && !bodyText.trim()) skip = 'empty body';

      results.push({ id: msg.id, from, subject, senderEmail, skip: skip || 'WOULD REPLY', bodyPreview: bodyText.substring(0, 100) });
    }
    res.json({ unreadCount: messages.length, repliedSetSize: repliedEmails.size, emails: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Clear replied set — for retesting. Resets idempotency state, admin only.
app.post('/api/email-autoreply/clear-replied', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  repliedEmails.clear();
  persistRepliedEmails();
  res.json({ ok: true, cleared: true });
});

// Manual trigger — check inbox now without waiting for the poll. Admin only.
app.post('/api/email-autoreply/check-now', async (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
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

// Approve a pending reply — sends the draft
app.get('/api/email-autoreply/approve', async (req, res) => {
  const { id } = req.query;
  const approval = pendingApprovals.get(id);
  if (!approval) return res.send('<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#0d0d1f;color:#eee;"><h2>❌ Approval not found</h2><p>This link may have expired or already been used.</p></body></html>');

  const { ownerEmail, senderEmail, senderName, subject, threadId, msgId, brandedHtml, booking, replyHtml } = approval;
  const entry = gmailTokens.get(ownerEmail);
  if (!entry) return res.send('<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#0d0d1f;color:#eee;"><h2>❌ Gmail not connected</h2><p>Please reconnect Gmail.</p></body></html>');

  try {
    const gmail = google.gmail({ version: 'v1', auth: entry.auth });
    const headerLines = [
      `From: ${ownerEmail}`, `To: ${senderEmail}`, `Subject: ${subject}`,
      msgId ? `In-Reply-To: ${msgId}` : '', msgId ? `References: ${msgId}` : '',
      'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8',
    ].filter(Boolean).join('\r\n');
    const encoded = Buffer.from(headerLines + '\r\n\r\n' + brandedHtml).toString('base64url');
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded, threadId } });

    trackReply(ownerEmail, 'reply');
    logReply(ownerEmail, senderEmail, subject, replyHtml, 'approved');
    pendingApprovals.delete(id);
    persistPendingApprovals();

    // Handle booking if detected
    if (booking) {
      booking.email = booking.email || senderEmail;
      booking.name = booking.name || senderName;
      trackReply(ownerEmail, 'booking');
      await createCalendarEvent(ownerEmail, { name: booking.name, email: booking.email, datetime: booking.datetime, notes: booking.notes || subject, siteName: 'Email', page: 'Approved reply' });
    }

    console.log(`✅ Approved reply to ${senderEmail} re: "${subject}"`);
    res.send('<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#0d0d1f;color:#eee;"><div style="font-size:48px;margin-bottom:16px">✅</div><h2 style="color:#00e5a0;">Reply Sent!</h2><p style="color:#9898b8;">The approved reply has been sent to ' + senderEmail + '.</p></body></html>');
  } catch (e) {
    console.warn('Approval send failed:', e.message);
    res.send('<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#0d0d1f;color:#eee;"><h2>❌ Failed to send</h2><p>' + e.message + '</p></body></html>');
  }
});

// Reject a pending reply — discard the draft
app.get('/api/email-autoreply/reject', (req, res) => {
  const { id } = req.query;
  const approval = pendingApprovals.get(id);
  if (!approval) return res.send('<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#0d0d1f;color:#eee;"><h2>❌ Not found</h2><p>This link may have expired or already been used.</p></body></html>');

  logReply(approval.ownerEmail, approval.senderEmail, approval.subject, approval.replyHtml, 'rejected');
  pendingApprovals.delete(id);
  persistPendingApprovals();

  console.log(`🗑️ Rejected reply to ${approval.senderEmail} re: "${approval.subject}"`);
  res.send('<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#0d0d1f;color:#eee;"><div style="font-size:48px;margin-bottom:16px">🗑️</div><h2>Reply Discarded</h2><p style="color:#9898b8;">The draft reply to ' + approval.senderEmail + ' has been discarded.</p></body></html>');
});

// Get reply log for a specific owner — exposes outbound message history.
app.get('/api/email-autoreply/reply-log', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  const { owner } = req.query;
  if (!owner) return res.status(400).json({ error: 'owner required' });
  const ownerLog = replyLog.filter(r => r.ownerEmail === owner).reverse().slice(0, 50);
  res.json({ ok: true, log: ownerLog });
});

// ─── Knowledge Base ─────────────────────────────────────────────────────────
// ─── Domain Whitelist ────────────────────────────────────────────────────────
const DOMAINS_FILE = resolve('data/allowed-domains.json');
const allowedDomains = new Set(); // e.g. "mysite.co.uk", "localhost:3000"

function loadAllowedDomains() {
  try {
    if (existsSync(DOMAINS_FILE)) {
      const saved = JSON.parse(readFileSync(DOMAINS_FILE, 'utf8'));
      for (const d of saved) allowedDomains.add(d.toLowerCase());
      console.log(`🔒 Loaded ${allowedDomains.size} allowed domains`);
    }
  } catch (e) { console.warn('Failed to load domains:', e.message); }
}

function persistAllowedDomains() {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    writeFileSync(DOMAINS_FILE, JSON.stringify([...allowedDomains], null, 2));
  } catch (e) { console.warn('Failed to persist domains:', e.message); }
}

// Check if a request origin is from an allowed domain
function isDomainAllowed(req) {
  // If no domains configured, allow all (backwards compatible)
  if (allowedDomains.size === 0) return true;

  const origin = req.headers.origin || req.headers.referer || '';
  // Always allow admin, dashboard, and server-to-server requests (no origin)
  if (!origin) return true;

  try {
    const url = new URL(origin);
    const host = url.host.toLowerCase(); // includes port
    const hostname = url.hostname.toLowerCase();
    // Check exact host or hostname match
    if (allowedDomains.has(host) || allowedDomains.has(hostname)) return true;
    // Check if it's a subdomain of an allowed domain (e.g. www.mysite.co.uk matches mysite.co.uk)
    for (const d of allowedDomains) {
      if (hostname.endsWith('.' + d)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

const KNOWLEDGE_BASE_FILE = resolve('data/knowledge-base.json');
const knowledgeBase = new Map(); // ownerEmail → [{ id, question, answer, createdAt }]

function loadKnowledgeBase() {
  try {
    if (existsSync(KNOWLEDGE_BASE_FILE)) {
      const saved = JSON.parse(readFileSync(KNOWLEDGE_BASE_FILE, 'utf8'));
      for (const [email, entries] of Object.entries(saved)) knowledgeBase.set(email, entries);
    }
  } catch (e) { console.warn('Failed to load knowledge base:', e.message); }
}

function persistKnowledgeBase() {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    const obj = {};
    for (const [email, entries] of knowledgeBase) obj[email] = entries;
    writeFileSync(KNOWLEDGE_BASE_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.warn('Failed to persist knowledge base:', e.message); }
}

// Get all FAQs for an owner
app.get('/api/knowledge-base', (req, res) => {
  const { owner } = req.query;
  if (!owner) return res.status(400).json({ error: 'owner required' });
  res.json({ ok: true, entries: knowledgeBase.get(owner) || [] });
});

// Add a FAQ entry
app.post('/api/knowledge-base', (req, res) => {
  const { owner, question, answer } = req.body;
  if (!owner || !question || !answer) return res.status(400).json({ error: 'owner, question, and answer required' });
  const entries = knowledgeBase.get(owner) || [];
  const entry = { id: crypto.randomUUID(), question, answer, createdAt: new Date().toISOString() };
  entries.push(entry);
  knowledgeBase.set(owner, entries);
  persistKnowledgeBase();
  res.json({ ok: true, entry });
});

// Delete a FAQ entry
app.delete('/api/knowledge-base', (req, res) => {
  const { owner, id } = req.body;
  if (!owner || !id) return res.status(400).json({ error: 'owner and id required' });
  const entries = knowledgeBase.get(owner) || [];
  const filtered = entries.filter(e => e.id !== id);
  knowledgeBase.set(owner, filtered);
  persistKnowledgeBase();
  res.json({ ok: true, deleted: id });
});

// ─── Website Scanner ─────────────────────────────────────────────────────────
const CLIENT_PROFILES_FILE = resolve('data/client-profiles.json');
const clientProfiles = new Map(); // url → { profile, scannedAt }

try {
  if (existsSync(CLIENT_PROFILES_FILE)) {
    const raw = JSON.parse(readFileSync(CLIENT_PROFILES_FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw)) clientProfiles.set(k, v);
    console.log(`🔍 Loaded ${clientProfiles.size} cached client profiles`);
  }
} catch (e) { console.warn('Failed to load client profiles:', e.message); }

function persistProfiles() {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    writeFileSync(CLIENT_PROFILES_FILE, JSON.stringify(Object.fromEntries(clientProfiles), null, 2));
  } catch (e) { console.warn('Failed to persist client profiles:', e.message); }
}

async function scanWebsite(url) {
  // Normalise URL
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const baseUrl = new URL(url);

  // safeFetch validates URL + DNS + every redirect target. Without this, the
  // legacy scanner was a wide-open SSRF primitive — anyone could ask the
  // server to fetch any internal address.
  const homepageRes = await _safeFetch(url, {
    headers: { 'User-Agent': 'AriaBot/1.0 (website scanner)' },
    timeoutMs: 15000,
  });
  if (!homepageRes.ok) throw new Error(`Failed to fetch ${url}: ${homepageRes.status}`);
  const homepageHtml = await homepageRes.text();

  // Find internal links to key pages
  const keyPages = ['about', 'services', 'contact', 'menu', 'pricing', 'team', 'faq',
                    'our-services', 'about-us', 'contact-us', 'our-team', 'price', 'treatments'];
  const linkRegex = /href=["']([^"']+)["']/gi;
  const foundLinks = new Set();
  let match;
  while ((match = linkRegex.exec(homepageHtml)) !== null) {
    try {
      const href = match[1];
      const linkUrl = new URL(href, baseUrl.origin);
      // Only same-origin links
      if (linkUrl.hostname !== baseUrl.hostname) continue;
      const path = linkUrl.pathname.toLowerCase();
      if (keyPages.some(kp => path.includes(kp))) {
        foundLinks.add(linkUrl.href);
      }
    } catch {}
  }

  // Limit to 5 subpages
  const pagesToFetch = [...foundLinks].slice(0, 5);

  // Helper: strip HTML to plain text
  function stripHtml(html) {
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#?\w+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Gather text from all pages
  let allText = `=== HOMEPAGE (${url}) ===\n${stripHtml(homepageHtml)}\n\n`;

  for (const pageUrl of pagesToFetch) {
    try {
      // Same-origin filter above doesn't help if the origin itself resolves to
      // an internal IP, so re-validate each subpage through safeFetch too.
      const res = await _safeFetch(pageUrl, {
        headers: { 'User-Agent': 'AriaBot/1.0 (website scanner)' },
        timeoutMs: 10000,
      });
      if (res.ok) {
        const html = await res.text();
        allText += `=== ${pageUrl} ===\n${stripHtml(html)}\n\n`;
      }
    } catch {}
  }

  // Truncate to ~30k chars to stay within context limits
  if (allText.length > 30000) allText = allText.slice(0, 30000);

  // Ask Claude to extract the business profile
  const extraction = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are a business profile extractor. Analyze the following website text and extract a JSON business profile.

Return ONLY valid JSON with these fields (use null for anything not found):
{
  "name": "Business name",
  "services": ["service 1", "service 2"],
  "location": "Full address or city/area",
  "phone": "Phone number",
  "email": "Email address",
  "hours": "Opening hours summary",
  "tone": "Brand tone in 2-3 words, e.g. 'friendly and professional', 'luxury and elegant', 'casual and fun'",
  "summary": "One paragraph describing what this business does"
}

Website text:
${allText}`
    }]
  });

  const responseText = extraction.content[0].text.trim();
  // Extract JSON from response (handle markdown code blocks)
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Failed to extract profile from website');

  return JSON.parse(jsonMatch[0]);
}

app.post('/api/scan-website', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    // Normalise for cache key
    let cacheKey = url.toLowerCase().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(cacheKey)) cacheKey = 'https://' + cacheKey;

    // Check cache (24 hour TTL)
    const cached = clientProfiles.get(cacheKey);
    if (cached && (Date.now() - new Date(cached.scannedAt).getTime()) < 24 * 60 * 60 * 1000) {
      return res.json({ ok: true, profile: cached.profile, cached: true });
    }

    const profile = await scanWebsite(url);

    // Cache the result
    clientProfiles.set(cacheKey, { profile, scannedAt: new Date().toISOString() });
    persistProfiles();

    res.json({ ok: true, profile, cached: false });
  } catch (e) {
    console.error('Website scan failed:', e.message);
    res.status(500).json({ error: 'Failed to scan website', detail: e.message });
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
const reviews      = new Map();  // slug → [{id, name, email, rating, text, service, date, submittedAt, source, approved, rejected}]
const npsScores    = [];
const abResults    = { A:{ opens:0, leads:0 }, B:{ opens:0, leads:0 } };
const gaps         = [];        // knowledge gaps: questions bot couldn't answer (slug-tagged)
// Self-improvement loop: gaps that have been clustered (>=3 similar visitor
// questions for the same slug) are promoted to "learning proposals" awaiting
// owner approval. Approved proposals graduate to regular FAQ entries.
//   proposal: { id, slug, question, variants[], evidenceCount, suggestedAnswer,
//               status: 'pending'|'approved'|'rejected', createdAt, decidedAt? }
const learningProposals = new Map(); // proposalId → proposal
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

  // Reviews (per-client slug)
  const savedReviews = loadFile('reviews', {});
  for (const [slug, list] of Object.entries(savedReviews)) reviews.set(slug, list);

  // Lead statuses (pipeline)
  const savedStatuses = loadFile('leadStatuses', []);
  savedStatuses.forEach(([k, v]) => leadStatuses.set(k, v));

  // Knowledge gaps
  const savedGaps = loadFile('gaps', []);
  gaps.push(...savedGaps);

  // Learning proposals (self-improvement loop — clustered gaps awaiting owner approval)
  const savedLearnings = loadFile('learningProposals', []);
  for (const p of savedLearnings) learningProposals.set(p.id, p);

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

  // Pending quotes (owner approval queue for AI-drafted price quotes)
  loadPendingQuotes();

  // Notification digest buffer (informational alerts batched into daily email)
  loadDigestState();

  // NOTE: loadVoiceConfig() is called at its own declaration site lower in
  // the file — its state consts (VOICE_CONFIG_FILE, voiceNumberIndex) are
  // declared there, so calling it here would hit a temporal-dead-zone
  // ReferenceError and crash boot. (Same TDZ class as the CHANNEL_LEADS_FILE
  // fix earlier this session.)

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
// Branded email wrapper — accepts optional per-client brand config from the booking
// payload (brandColor, brandName, brandLogoUrl, brandTagline, siteUrl). When those
// fields are missing it falls back to the original Aria chrome.
const wrap = (body, adminUrl, brand = {}) => {
  const brandColor   = brand.brandColor   || '#6C63FF';
  const brandName    = brand.brandName    || 'Aria Chatbot';
  const brandLogoUrl = brand.brandLogoUrl || '';
  const brandTagline = brand.brandTagline || '';
  const siteUrl      = brand.siteUrl      || '';
  const footer       = brand.footer       || '';

  const headerInner = brandLogoUrl
    ? `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>
         <td style="padding-right:14px"><img src="${brandLogoUrl}" alt="${brandName}" width="44" height="44" style="display:block;border-radius:50%;border:1px solid rgba(255,255,255,0.2)" /></td>
         <td style="vertical-align:middle">
           <div style="color:#fff;font-size:17px;font-weight:700;letter-spacing:0.02em;line-height:1.1">${brandName}</div>
           ${brandTagline ? `<div style="color:rgba(255,255,255,0.75);font-size:10px;font-weight:600;letter-spacing:0.25em;text-transform:uppercase;margin-top:4px">${brandTagline}</div>` : ''}
         </td>
       </tr></table>`
    : `<h1 style="color:#fff;margin:0;font-size:18px;font-weight:700;letter-spacing:0.01em">✦ ${brandName}</h1>`;

  return `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f4f7;padding:32px 16px;margin:0;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.08)">
  <div style="background:${brandColor};padding:24px 28px">${headerInner}</div>
  <div style="padding:32px 28px">${body}</div>
  <div style="padding:18px 28px;background:#fafafc;font-size:11.5px;color:#8a8a96;border-top:1px solid #eef0f4;line-height:1.5">
    ${footer || `${brandName}${siteUrl ? ` · <a href="${siteUrl}" style="color:${brandColor};text-decoration:none">${siteUrl.replace(/^https?:\/\//,'')}</a>` : ''}`}
    ${adminUrl ? ` · <a href="${adminUrl}" style="color:${brandColor};text-decoration:none">Admin</a>` : ''}
  </div>
</div></body></html>`;
};

// Helper: extract brand config from a booking / event payload
function brandFromPayload(p) {
  return {
    brandColor:   p.brandColor,
    brandName:    p.siteName,
    brandLogoUrl: p.brandLogoUrl,
    brandTagline: p.brandTagline,
    siteUrl:      p.siteUrl,
    footer:       p.emailFooter
  };
}

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

// Owner alert: new booking received
const bookingTpl = (p) => {
  const brand = brandFromPayload(p);
  const color = brand.brandColor || '#6C63FF';
  const phone = p.phone || '';
  const rows = [
    p.service          && ['Service',  p.service + (p.duration_minutes ? ` · ${p.duration_minutes} min` : '') + (p.price_gbp ? ` · £${p.price_gbp}` : '')],
    ['When',           `<strong style="color:${color};font-size:16px">${p.datetime}</strong>`],
    ['Client',          p.name],
    p.email            && ['Email',    `<a href="mailto:${p.email}" style="color:${color};text-decoration:none;font-weight:600">${p.email}</a>`],
    phone              && ['Phone',    `<a href="tel:${phone.replace(/\s+/g,'')}" style="color:${color};text-decoration:none;font-weight:600">${phone}</a>`],
    p.notes            && ['Notes',    `<span style="color:#3a3a3a;line-height:1.5;white-space:pre-line">${p.notes}</span>`],
    ['Source',          p.page || p.siteName || 'Website']
  ].filter(Boolean);

  const replyHref = p.email ? `mailto:${p.email}?subject=Re:%20Your%20${encodeURIComponent(p.service || 'booking')}%20on%20${encodeURIComponent(p.datetime || '')}&body=${encodeURIComponent(`Hi ${(p.name||'').split(' ')[0]},\n\nThanks for booking in with me. Just confirming I've got you down for ${p.datetime || 'your session'}.\n\nLooking forward to seeing you.\n\nJord`)}` : '';
  const callHref  = phone ? `tel:${phone.replace(/\s+/g,'')}` : '';

  return wrap(`
    <p style="margin:0 0 6px;color:#8a8a96;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.2em">New booking request</p>
    <h2 style="margin:0 0 24px;color:#1a1a1a;font-size:26px;line-height:1.15;font-weight:700">${p.name} · ${p.datetime}</h2>
    <div style="background:#fafafc;border:1px solid #eef0f4;border-radius:14px;padding:22px 24px;margin-bottom:24px">
      <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:14px;color:#1a1a1a">
        ${rows.map(([k,v]) => `
          <tr>
            <td style="padding:8px 0;color:#8a8a96;width:90px;vertical-align:top;font-size:12px;text-transform:uppercase;letter-spacing:0.1em;font-weight:600">${k}</td>
            <td style="padding:8px 0;vertical-align:top">${v}</td>
          </tr>`).join('')}
      </table>
    </div>
    <div style="display:block">
      ${replyHref ? `<a href="${replyHref}" style="display:inline-block;margin:0 8px 8px 0;padding:12px 22px;background:${color};color:#fff;border-radius:999px;text-decoration:none;font-weight:600;font-size:13.5px;letter-spacing:0.02em">Reply to client →</a>` : ''}
      ${callHref  ? `<a href="${callHref}"  style="display:inline-block;margin:0 8px 8px 0;padding:12px 22px;background:#fff;color:${color};border:1.5px solid ${color};border-radius:999px;text-decoration:none;font-weight:600;font-size:13.5px">Call client</a>` : ''}
    </div>
    <p style="margin:22px 0 0;color:#8a8a96;font-size:12px;line-height:1.5">📎 A <strong>booking.ics</strong> file is attached — tap it from Outlook / Apple Mail / Gmail to add this session to your calendar in one click.</p>
  `, p.adminUrl, brand);
};

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
const visitorBookingTpl = (p) => {
  const brand = brandFromPayload(p);
  const color = brand.brandColor || '#6C63FF';
  const firstName = (p.name || '').split(' ')[0] || 'there';
  const location = p.location || p.address || '';
  const mapUrl = p.mapUrl || (location ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}` : '');

  const detailRows = [
    p.service          && ['Treatment', p.service + (p.duration_minutes ? ` · ${p.duration_minutes} min` : '') + (p.price_gbp ? ` · £${p.price_gbp}` : '')],
    ['When',            `<strong style="color:${color};font-size:15px">${p.datetime}</strong>`],
    p.ownerName        && ['Therapist', p.ownerName],
    location           && ['Where',     `<a href="${mapUrl}" style="color:${color};text-decoration:none;font-weight:600">${location}</a>`]
  ].filter(Boolean);

  const hasPreparation = p.service && /massage|assessment|treatment|rehab/i.test(p.service);

  return wrap(`
    <p style="margin:0 0 6px;color:#8a8a96;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.2em">Booking received</p>
    <h2 style="margin:0 0 16px;color:#1a1a1a;font-size:26px;line-height:1.2;font-weight:700">See you soon, ${firstName}.</h2>
    <p style="margin:0 0 24px;color:#3a3a3a;font-size:15px;line-height:1.6">
      ${p.ownerName || 'Your therapist'} has received your booking and will confirm shortly. Here's everything you need to know.
    </p>

    <div style="background:#fafafc;border:1px solid #eef0f4;border-radius:14px;padding:22px 24px;margin-bottom:20px">
      <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:14px;color:#1a1a1a">
        ${detailRows.map(([k,v]) => `
          <tr>
            <td style="padding:8px 0;color:#8a8a96;width:100px;vertical-align:top;font-size:12px;text-transform:uppercase;letter-spacing:0.1em;font-weight:600">${k}</td>
            <td style="padding:8px 0;vertical-align:top">${v}</td>
          </tr>`).join('')}
      </table>
    </div>

    ${p.calendarLink ? `
    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:12px;padding:14px 18px;margin-bottom:20px;text-align:center">
      <p style="margin:0 0 10px;font-size:13px;color:#166534;font-weight:600">✓ Added to your calendar</p>
      <a href="${p.calendarLink}" style="display:inline-block;padding:9px 20px;background:#16a34a;color:#fff;border-radius:999px;text-decoration:none;font-size:13px;font-weight:600">Open in Google Calendar →</a>
    </div>` : `
    <p style="margin:0 0 20px;color:#8a8a96;font-size:12.5px;line-height:1.5;padding:10px 14px;background:#fffaea;border-radius:10px;border:1px solid #fde68a">
      📎 A <strong>booking.ics</strong> file is attached — tap it to add this session to your own calendar.
    </p>`}

    ${hasPreparation ? `
    <div style="margin-bottom:22px">
      <p style="margin:0 0 10px;color:#8a8a96;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.2em">Before you come</p>
      <ul style="margin:0;padding:0 0 0 18px;color:#3a3a3a;font-size:13.5px;line-height:1.7">
        <li>Wear gym kit — shorts and a t-shirt, or whatever you train in.</li>
        <li>Come clean and showered if you can.</li>
        <li>Bring a note of anything that's been bothering you — tight spots, injuries, any goals.</li>
      </ul>
    </div>` : ''}

    <div style="margin-bottom:20px">
      <p style="margin:0 0 10px;color:#8a8a96;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.2em">Need to reschedule?</p>
      <p style="margin:0;color:#3a3a3a;font-size:13.5px;line-height:1.6">
        Free to move any session up to 24 hours before. Just reply to this email${p.ownerEmail ? ` or call ${p.ownerName || 'us'}` : ''}.
      </p>
    </div>

    ${p.ownerEmail ? `
    <div style="border-top:1px solid #eef0f4;padding-top:18px">
      <p style="margin:0;color:#8a8a96;font-size:12.5px;line-height:1.7">
        Questions? Drop a line to <a href="mailto:${p.ownerEmail}" style="color:${color};text-decoration:none;font-weight:600">${p.ownerEmail}</a>.
      </p>
    </div>` : ''}
  `, p.adminUrl, brand);
};

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
/**
 * Build a calendar invite (.ics) attachment for a booking email.
 * Returns a { filename, content, contentType } object, or null if the datetime
 * can't be parsed (in which case we just skip the attachment — email still goes).
 *
 * `method` is 'REQUEST' for the owner (they can accept it like an invite) and
 * 'PUBLISH' for the visitor (it shows as an info event, no RSVP prompt).
 */
function pad2(n) { return String(n).padStart(2, '0'); }
function icsDate(d) {
  return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) +
         'T' + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z';
}
function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}
async function buildBookingIcs(booking, { method = 'REQUEST' } = {}) {
  // Prefer explicit structured date+time from the form; fallback to AI-parsed datetime string.
  let start, end;
  if (booking.date && booking.time) {
    // Interpret as Europe/London. Build as local, convert to UTC via tz offset best-effort (UTC+0 for simplicity — iCal clients handle well with Z).
    const [hh, mm] = booking.time.split(':').map(Number);
    const [yy, m, d] = booking.date.split('-').map(Number);
    start = new Date(Date.UTC(yy, m - 1, d, hh, mm));
    const dur = parseInt(booking.duration_minutes, 10) || 60;
    end = new Date(start.getTime() + dur * 60 * 1000);
  } else {
    const parsed = await parseBookingDatetime(booking.datetime);
    if (!parsed) return null;
    start = new Date(parsed.start);
    end = new Date(parsed.end);
  }
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;

  const uid = (booking.ts ? new Date(booking.ts).getTime() : Date.now()) + '-' + Math.random().toString(36).slice(2) + '@repwithrobson';
  const now = new Date();
  const owner = booking.ownerEmail || '';
  const ownerName = booking.ownerName || 'Therapist';
  const visitor = booking.email || '';
  const visitorName = booking.name || 'Client';
  const siteName = booking.siteName || 'REP with Robson';

  const summary = `${booking.service || 'Session'} — ${visitorName}`;
  const descLines = [
    `Service: ${booking.service || 'Session'}${booking.duration_minutes ? ` (${booking.duration_minutes} min)` : ''}`,
    booking.price_gbp ? `Price: £${booking.price_gbp}` : '',
    `Client: ${visitorName}`,
    booking.phone ? `Phone: ${booking.phone}` : '',
    `Email: ${visitor}`,
    booking.notes ? `\nNotes:\n${booking.notes}` : '',
    `\nBooked via ${siteName}`
  ].filter(Boolean).join('\n');
  const location = booking.location || booking.address || '1 Lonsdale Street, Carlisle CA1 1BJ';

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${siteName}//Booking//EN`,
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(summary)}`,
    `DESCRIPTION:${icsEscape(descLines)}`,
    `LOCATION:${icsEscape(location)}`,
    owner ? `ORGANIZER;CN=${icsEscape(ownerName)}:mailto:${owner}` : '',
    visitor ? `ATTENDEE;CN=${icsEscape(visitorName)};RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:${visitor}` : '',
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'BEGIN:VALARM',
    'TRIGGER:-PT1H',
    'ACTION:DISPLAY',
    `DESCRIPTION:Upcoming session — ${icsEscape(summary)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');

  return {
    filename: 'booking.ics',
    content: ics,
    contentType: `text/calendar; method=${method}; charset=UTF-8`
  };
}

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
const passwordResetTokens = new Map(); // token → { ownerEmail, expiresAt }

// Request password reset — sends email with reset link
app.post('/api/dashboard/forgot-password', async (req, res) => {
  const { owner } = req.body;
  if (!owner) return res.status(400).json({ error: 'owner required' });
  if (!dashboardPasswords.has(owner)) return res.status(400).json({ error: 'No account found for this email' });
  const token = generateSessionToken();
  passwordResetTokens.set(token, { ownerEmail: owner, expiresAt: Date.now() + 30 * 60 * 1000 }); // 30 min
  const serverUrl = process.env.GOOGLE_REDIRECT_URI?.replace('/auth/gmail/callback', '') || `http://localhost:${process.env.PORT || 3000}`;
  const resetLink = `${serverUrl}/dashboard/reset-password?token=${token}&owner=${encodeURIComponent(owner)}`;
  try {
    await sendEmail({
      to: owner,
      subject: 'Aria Dashboard — Set or reset your password',
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;">
        <h2 style="color:#1a1a2e;">Set your Aria dashboard password</h2>
        <p style="color:#666;line-height:1.6;">Click the button below to set (or reset) your password. Use this whether it's your first time signing in or you've forgotten an old one.</p>
        <a href="${resetLink}" style="display:inline-block;margin:20px 0;padding:14px 28px;background:#00e5a0;color:#0d0d1f;border-radius:12px;text-decoration:none;font-weight:600;">Set your password</a>
        <p style="color:#999;font-size:12px;">This link expires in 30 minutes. If you didn't request this, you can ignore this email.</p>
      </div>`,
    });
    res.json({ ok: true, message: 'Reset link sent to your email' });
  } catch (e) {
    console.warn('Failed to send reset email:', e.message);
    // Fall back — try sending via Gmail if SMTP not configured
    try {
      await smartSend({ ownerEmail: owner, to: owner, subject: 'Aria Dashboard — Set or reset your password',
        html: `<p>Click here to set or reset your Aria dashboard password:</p><p><a href="${resetLink}">${resetLink}</a></p><p style="color:#999;font-size:12px;">Expires in 30 minutes.</p>` });
      res.json({ ok: true, message: 'Reset link sent to your email' });
    } catch (e2) {
      res.status(500).json({ error: 'Failed to send reset email. Contact support.' });
    }
  }
});

// Password reset page
app.get('/dashboard/reset-password', (req, res) => {
  const { token, owner } = req.query;
  const reset = passwordResetTokens.get(token);
  if (!reset || reset.expiresAt < Date.now() || reset.ownerEmail !== owner) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d1f;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;color:#eee;}.box{background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:36px;max-width:400px;width:100%;text-align:center;}a{color:#00e5a0;text-decoration:none;}</style>
    </head><body><div class="box">
      <div style="font-size:36px;margin-bottom:16px;">⏰</div>
      <h2>Link expired</h2>
      <p style="color:#9898b8;margin:16px 0;">This reset link has expired or is invalid.</p>
      <a href="/connect/gmail?owner=${encodeURIComponent(owner || '')}">Back to login</a>
    </div></body></html>`);
  }

  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Aria — Reset Password</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d1f;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;color:#eee;}
    .box{background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:36px;max-width:400px;width:100%;text-align:center;}
    .logo span{font-size:28px;font-weight:800;color:#fff;letter-spacing:-0.5px;}
    .logo span em{font-style:normal;color:#00e5a0;}
    h2{font-size:18px;margin:24px 0 8px;}
    p{font-size:13px;color:#9898b8;margin-bottom:20px;}
    input[type=password]{width:100%;padding:14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;font-size:15px;color:#eee;font-family:inherit;outline:none;text-align:center;letter-spacing:2px;margin-bottom:12px;}
    input[type=password]:focus{border-color:rgba(0,229,160,0.4);}
    .btn{display:block;width:100%;padding:14px;background:#00e5a0;color:#0d0d1f;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;}
    .btn:hover{opacity:.88;}
    .msg{padding:10px;border-radius:8px;font-size:13px;margin-bottom:14px;display:none;}
    .msg.error{display:block;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.2);color:#ff6b6b;}
    .msg.success{display:block;background:rgba(0,229,160,0.1);border:1px solid rgba(0,229,160,0.25);color:#00e5a0;}
  </style>
  </head><body>
  <div class="box">
    <div class="logo"><span>Aria<em>Ai</em></span></div>
    <h2>Set new password</h2>
    <p>Choose a new password for your dashboard.</p>
    <div id="msg" class="msg"></div>
    <input type="password" id="pw" placeholder="New password" autofocus>
    <input type="password" id="pw2" placeholder="Confirm password" onkeydown="if(event.key==='Enter')resetPw()">
    <button class="btn" onclick="resetPw()">Reset Password</button>
  </div>
  <script>
    async function resetPw() {
      const pw = document.getElementById('pw').value;
      const pw2 = document.getElementById('pw2').value;
      const el = document.getElementById('msg');
      if (!pw || pw.length < 4) { el.textContent = 'Password must be at least 4 characters'; el.className = 'msg error'; return; }
      if (pw !== pw2) { el.textContent = "Passwords don't match"; el.className = 'msg error'; return; }
      const r = await fetch('/api/dashboard/complete-reset', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({token:'${token}',owner:'${owner}',password:pw}) });
      const data = await r.json();
      if (data.ok) {
        el.textContent = 'Password reset! Redirecting...';
        el.className = 'msg success';
        setTimeout(() => { window.location.href = '/connect/gmail?owner=${encodeURIComponent(owner)}&s=' + data.sessionToken; }, 1500);
      } else {
        el.textContent = data.error || 'Failed to reset password';
        el.className = 'msg error';
      }
    }
  </script>
  </body></html>`);
});

// Complete password reset
app.post('/api/dashboard/complete-reset', (req, res) => {
  const { token, owner, password } = req.body;
  const reset = passwordResetTokens.get(token);
  if (!reset || reset.expiresAt < Date.now() || reset.ownerEmail !== owner) {
    return res.status(400).json({ error: 'Invalid or expired reset link' });
  }
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  dashboardPasswords.set(owner, scryptHash(password));
  persistPasswords();
  passwordResetTokens.delete(token);
  const sessionToken = createSession(owner);
  res.json({ ok: true, sessionToken });
});

// Set password for dashboard
app.post('/api/dashboard/set-password', (req, res) => {
  const { owner, password } = req.body;
  if (!owner || !password) return res.status(400).json({ error: 'owner and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (dashboardPasswords.has(owner)) return res.status(400).json({ error: 'Password already set. Use reset if needed.' });
  dashboardPasswords.set(owner, scryptHash(password));
  persistPasswords();
  const token = createSession(owner);
  res.json({ ok: true, token });
});

// Login to dashboard
app.post('/api/dashboard/login', (req, res) => {
  const { owner, password } = req.body;
  if (!owner || !password) return res.status(400).json({ error: 'owner and password required' });
  const stored = dashboardPasswords.get(owner);
  if (!stored) return res.status(400).json({ error: 'No password set' });
  const verify = verifyPassword(password, stored);
  if (!verify.ok) return res.status(401).json({ error: 'Wrong password' });
  // Migrate legacy h_* hashes to scrypt on first successful login.
  if (verify.needsRehash) {
    dashboardPasswords.set(owner, scryptHash(password));
    persistPasswords();
  }
  const token = createSession(owner);
  res.json({ ok: true, token });
});

// Reset password (requires current password)
app.post('/api/dashboard/reset-password', (req, res) => {
  const { owner, currentPassword, newPassword } = req.body;
  if (!owner || !currentPassword || !newPassword) return res.status(400).json({ error: 'All fields required' });
  const stored = dashboardPasswords.get(owner);
  if (!stored || !verifyPassword(currentPassword, stored).ok) return res.status(401).json({ error: 'Wrong current password' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  dashboardPasswords.set(owner, scryptHash(newPassword));
  persistPasswords();
  res.json({ ok: true });
});

// ─── Quick Setup (one-link onboarding) ───────────────────────────────────────
const SETUP_CODE = process.env.SETUP_CODE || 'aireyai';

app.get('/setup', (req, res) => {
  if (req.query.code !== SETUP_CODE) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aria</title>
    <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d1f;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#eee;padding:20px;}.box{background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:40px;text-align:center;max-width:400px;}</style>
    </head><body><div class="box"><div style="font-size:48px;margin-bottom:16px">🔒</div><h2>Access Required</h2><p style="color:#9898b8;margin-top:12px;">You need an access code to set up Aria. Contact your provider.</p></div></body></html>`);
  }

  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aria — Setup</title>
    <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d1f;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#eee;padding:20px;}.box{background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:40px;text-align:center;max-width:440px;}</style>
    </head><body><div class="box"><h2>⚠️ Not configured yet</h2><p style="color:#9898b8;margin-top:12px;">Google credentials haven't been set up. Contact your provider.</p></div></body></html>`);
  }

  const setupCode = req.query.code;

  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Aria — Connect Your Business</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d1f;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;color:#eee;}
    .box{background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:48px 40px;text-align:center;max-width:440px;width:100%;}
    .logo span{font-size:32px;font-weight:800;letter-spacing:-0.5px;}
    .logo em{font-style:normal;color:#00e5a0;}
    h2{font-size:20px;margin:28px 0 12px;font-weight:700;}
    p{font-size:14px;color:#9898b8;line-height:1.7;margin-bottom:24px;}
    .gmail-btn{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;padding:15px;border:1.5px solid #ddd;border-radius:12px;background:#fff;color:#333;font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;transition:all .15s;font-family:inherit;}
    .gmail-btn:hover{background:#f8f8f8;transform:translateY(-1px);}
    .gmail-btn:disabled,.gmail-btn.disabled{opacity:.4;cursor:not-allowed;transform:none;}
    input{width:100%;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:14px;font-size:14px;color:#eee;font-family:inherit;outline:none;transition:border-color .2s;margin-bottom:16px;}
    input:focus{border-color:rgba(0,229,160,0.4);}
    input::placeholder{color:#6b6b8a;}
    .features{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:24px 0;text-align:left;}
    .feat{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px;}
    .feat .icon{font-size:20px;margin-bottom:6px;}
    .feat .label{font-size:12px;color:#9898b8;line-height:1.4;}
    .footer{margin-top:24px;font-size:11px;color:#6b6b8a;line-height:1.6;}
    .spinner{display:inline-block;width:18px;height:18px;border:2px solid rgba(255,255,255,0.2);border-top-color:#00e5a0;border-radius:50%;animation:spin .6s linear infinite;}
    @keyframes spin{to{transform:rotate(360deg)}}
    .scan-status{font-size:13px;color:#9898b8;margin-bottom:16px;min-height:20px;}
    .scan-status.done{color:#00e5a0;}
    .scan-status.error{color:#ff6b6b;}
    .hide{display:none!important;}
  </style>
  </head><body>
  <div class="box">
    <div class="logo"><span>Aria<em>Ai</em></span></div>
    <h2>Your AI Business Assistant</h2>
    <p>Paste your website below and connect your Google account. Aria will learn your business and start replying to customers automatically.</p>

    <input id="site-url" type="url" placeholder="https://yourbusiness.co.uk">
    <div id="scan-status" class="scan-status"></div>

    <a href="#" id="google-btn" class="gmail-btn" onclick="startSetup(event)">
      <svg width="20" height="20" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
      Connect with Google
    </a>

    <div class="features">
      <div class="feat"><div class="icon">📧</div><div class="label">Auto-reply to customer emails</div></div>
      <div class="feat"><div class="icon">📅</div><div class="label">Book appointments to your calendar</div></div>
      <div class="feat"><div class="icon">🤖</div><div class="label">AI learns your business</div></div>
      <div class="feat"><div class="icon">⚡</div><div class="label">Set up in 60 seconds</div></div>
    </div>

    <div class="footer">We'll access your Gmail to reply to customers and your Calendar to manage bookings. You can disconnect any time.</div>
  </div>

  <script>
    let scannedProfile = null;

    async function startSetup(e) {
      e.preventDefault();
      const url = document.getElementById('site-url').value.trim();
      const status = document.getElementById('scan-status');
      const btn = document.getElementById('google-btn');

      if (!url) {
        status.textContent = 'Please paste your website URL first';
        status.className = 'scan-status error';
        document.getElementById('site-url').focus();
        return;
      }

      // Scan the website
      btn.classList.add('disabled');
      btn.style.pointerEvents = 'none';
      status.innerHTML = '<span class="spinner"></span> Scanning your website...';
      status.className = 'scan-status';

      try {
        const r = await fetch('/api/scan-website', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        const data = await r.json();
        if (data.error) throw new Error(data.error);
        scannedProfile = data.profile || data;
        scannedProfile.websiteUrl = url;

        // Save profile temporarily with a setup token
        const saveR = await fetch('/api/setup/save-scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile: scannedProfile }),
        });
        const saveData = await saveR.json();

        status.textContent = '✓ Found: ' + (scannedProfile.name || url);
        status.className = 'scan-status done';

        // Redirect to Google OAuth with the scan token
        window.location.href = '/auth/gmail/start?setup=' + saveData.token;
      } catch (err) {
        status.textContent = 'Could not scan — try again or check the URL';
        status.className = 'scan-status error';
        btn.classList.remove('disabled');
        btn.style.pointerEvents = '';
      }
    }
  </script>
  </body></html>`);
});

// Save scanned profile temporarily for setup flow — returns a token to pass through OAuth
app.post('/api/setup/save-scan', (req, res) => {
  const { profile } = req.body;
  if (!profile) return res.status(400).json({ error: 'profile required' });
  const token = crypto.randomBytes(24).toString('hex');
  pendingSetups.set(token, { profile, createdAt: Date.now() });
  // Clean up old entries (> 30 minutes)
  for (const [k, v] of pendingSetups) {
    if (Date.now() - v.createdAt > 30 * 60 * 1000) pendingSetups.delete(k);
  }
  res.json({ token });
});

app.get('/connect/gmail', (req, res) => {
  const ownerEmail = req.query.owner || '';
  const sessionToken = req.query.s || '';
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center">
      <h2>⚠️ Google credentials not configured</h2>
      <p>Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your environment variables.</p>
    </body></html>`);
  }

  const hasPassword = dashboardPasswords.has(ownerEmail);
  const isAuthenticated = sessionToken && validateSession(sessionToken, ownerEmail);

  // If password exists but not authenticated, show login
  if (hasPassword && !isAuthenticated) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Aria — Login</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d1f;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;color:#eee;}
      .box{background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:36px;max-width:400px;width:100%;text-align:center;}
      .logo span{font-size:28px;font-weight:800;color:#fff;letter-spacing:-0.5px;}
      .logo span em{font-style:normal;color:#00e5a0;}
      h2{font-size:18px;margin:24px 0 8px;}
      p{font-size:13px;color:#9898b8;margin-bottom:20px;}
      .email-badge{display:inline-block;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:5px 14px;font-size:13px;color:#fff;font-weight:600;margin-bottom:20px;}
      input[type=password]{width:100%;padding:14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;font-size:15px;color:#eee;font-family:inherit;outline:none;text-align:center;letter-spacing:2px;margin-bottom:16px;}
      input[type=password]:focus{border-color:rgba(0,229,160,0.4);}
      .btn{display:block;width:100%;padding:14px;background:#00e5a0;color:#0d0d1f;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;}
      .btn:hover{opacity:.88;}
      .msg{padding:10px;border-radius:8px;font-size:13px;margin-bottom:14px;display:none;}
      .msg.error{display:block;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.2);color:#ff6b6b;}
      .footer{margin-top:24px;font-size:12px;color:#6b6b8a;}
      .footer a{color:#00e5a0;text-decoration:none;}
    </style>
    </head><body>
    <div class="box">
      <div class="logo"><span>Aria<em>Ai</em></span></div>
      <h2>Welcome back</h2>
      <div class="email-badge">${ownerEmail}</div>
      <div id="msg" class="msg"></div>
      <input type="password" id="pw" placeholder="Enter your password" autofocus onkeydown="if(event.key==='Enter')login()">
      <button class="btn" onclick="login()">Login</button>
      <button id="forgotBtn" onclick="forgotPw()" style="background:none;border:none;color:#6b6b8a;font-size:12px;cursor:pointer;margin-top:12px;font-family:inherit;">Forgot or first time? Reset password →</button>
      <div class="footer">Powered by <a href="https://aireyai.co.uk">AireyAi</a></div>
    </div>
    <script>
      async function login() {
        const pw = document.getElementById('pw').value;
        if (!pw) return;
        const r = await fetch('/api/dashboard/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({owner:'${ownerEmail}',password:pw}) });
        const data = await r.json();
        if (data.ok) {
          window.location.href = '/connect/gmail?owner=${encodeURIComponent(ownerEmail)}&s=' + data.token;
        } else {
          const el = document.getElementById('msg');
          el.textContent = data.error || 'Wrong password';
          el.className = 'msg error';
        }
      }
      async function forgotPw() {
        const btn = document.getElementById('forgotBtn');
        btn.textContent = 'Sending reset link...';
        btn.disabled = true;
        const r = await fetch('/api/dashboard/forgot-password', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({owner:'${ownerEmail}'}) });
        const data = await r.json();
        const el = document.getElementById('msg');
        if (data.ok) {
          el.textContent = 'Check your email — we just sent a link to set your password.';
          el.className = 'msg';
          el.style.display = 'block';
          el.style.background = 'rgba(0,229,160,0.1)';
          el.style.border = '1px solid rgba(0,229,160,0.25)';
          el.style.color = '#00e5a0';
        } else {
          el.textContent = data.error || 'Failed to send reset link';
          el.className = 'msg error';
        }
        btn.textContent = 'Forgot or first time? Reset password →';
        btn.disabled = false;
      }
    </script>
    </body></html>`);
  }

  // If no password set, show create password screen
  if (!hasPassword) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Aria — Create Password</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d1f;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;color:#eee;}
      .box{background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:36px;max-width:400px;width:100%;text-align:center;}
      .logo span{font-size:28px;font-weight:800;color:#fff;letter-spacing:-0.5px;}
      .logo span em{font-style:normal;color:#00e5a0;}
      h2{font-size:18px;margin:24px 0 8px;}
      p{font-size:13px;color:#9898b8;margin-bottom:20px;line-height:1.6;}
      .email-badge{display:inline-block;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:5px 14px;font-size:13px;color:#fff;font-weight:600;margin-bottom:20px;}
      input[type=password]{width:100%;padding:14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;font-size:15px;color:#eee;font-family:inherit;outline:none;text-align:center;letter-spacing:2px;margin-bottom:12px;}
      input[type=password]:focus{border-color:rgba(0,229,160,0.4);}
      .btn{display:block;width:100%;padding:14px;background:#00e5a0;color:#0d0d1f;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;}
      .btn:hover{opacity:.88;}
      .msg{padding:10px;border-radius:8px;font-size:13px;margin-bottom:14px;display:none;}
      .msg.error{display:block;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.2);color:#ff6b6b;}
      .hint{font-size:11.5px;color:#6b6b8a;margin-bottom:16px;}
      .footer{margin-top:24px;font-size:12px;color:#6b6b8a;}
      .footer a{color:#00e5a0;text-decoration:none;}
    </style>
    </head><body>
    <div class="box">
      <div class="logo"><span>Aria<em>Ai</em></span></div>
      <h2>Create your password</h2>
      <p>This password protects your Aria dashboard. You'll need it each time you log in.</p>
      <div class="email-badge">${ownerEmail}</div>
      <div id="msg" class="msg"></div>
      <input type="password" id="pw" placeholder="Choose a password" autofocus>
      <input type="password" id="pw2" placeholder="Confirm password" onkeydown="if(event.key==='Enter')createPw()">
      <p class="hint">Minimum 4 characters</p>
      <button class="btn" onclick="createPw()">Create Password</button>
      <div class="footer">Powered by <a href="https://aireyai.co.uk">AireyAi</a></div>
    </div>
    <script>
      async function createPw() {
        const pw = document.getElementById('pw').value;
        const pw2 = document.getElementById('pw2').value;
        const el = document.getElementById('msg');
        if (!pw || pw.length < 4) { el.textContent = 'Password must be at least 4 characters'; el.className = 'msg error'; return; }
        if (pw !== pw2) { el.textContent = 'Passwords don\\'t match'; el.className = 'msg error'; return; }
        const r = await fetch('/api/dashboard/set-password', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({owner:'${ownerEmail}',password:pw}) });
        const data = await r.json();
        if (data.ok) {
          window.location.href = '/connect/gmail?owner=${encodeURIComponent(ownerEmail)}&s=' + data.token;
        } else {
          el.textContent = data.error || 'Failed to create password';
          el.className = 'msg error';
        }
      }
    </script>
    </body></html>`);
  }

  // ── Authenticated dashboard ──
  const isConnected = gmailTokens.has(ownerEmail);
  const authUrl = getAuthUrl(ownerEmail);

  const autoReplyConfig = EMAIL_AUTO_REPLY_ENABLED.get(ownerEmail);
  const autoReplyEnabled = !!autoReplyConfig?.enabled;
  const currentPrompt = autoReplyConfig?.systemPrompt || '';
  const currentCfg = autoReplyConfig?.config || {};
  const stats = EMAIL_REPLY_STATS.get(ownerEmail) || { replied: 0, bookings: 0, followUps: 0, urgent: 0, lastReply: null, leads: { hot: 0, warm: 0, cold: 0 }, categories: { quote: 0, booking: 0, complaint: 0, feedback: 0, general: 0 }, history: [] };
  if (!stats.leads) stats.leads = { hot: 0, warm: 0, cold: 0 };
  if (!stats.categories) stats.categories = { quote: 0, booking: 0, complaint: 0, feedback: 0, general: 0 };
  if (!stats.history) stats.history = [];

  // Build chart data — last 30 days
  const chartData = {};
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    chartData[d.toISOString().split('T')[0]] = { replies: 0, bookings: 0 };
  }
  for (const h of stats.history) {
    const day = h.time?.split('T')[0];
    if (chartData[day]) {
      if (h.type === 'reply') chartData[day].replies++;
      if (h.type === 'booking') chartData[day].bookings++;
    }
  }
  const chartLabels = Object.keys(chartData);
  const chartReplies = chartLabels.map(d => chartData[d].replies);
  const chartBookings = chartLabels.map(d => chartData[d].bookings);

  // Determine if this is a new (unconfigured) client for onboarding wizard
  const isNewClient = !autoReplyConfig && !isConnected;

  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Aria — Email Settings</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d1f;min-height:100vh;padding:20px;color:#eee;}
    .wrap{max-width:520px;margin:0 auto;}
    .logo{text-align:center;margin-bottom:32px;padding-top:40px;}
    .logo span{font-size:28px;font-weight:800;color:#fff;letter-spacing:-0.5px;}
    .logo span em{font-style:normal;color:#00e5a0;}
    .card{background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:28px;margin-bottom:20px;}
    .card h2{font-size:17px;font-weight:700;margin-bottom:14px;display:flex;align-items:center;gap:10px;}
    .card p{font-size:13.5px;color:#9898b8;line-height:1.6;margin-bottom:16px;}
    .status{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;padding:5px 12px;border-radius:20px;}
    .status.on{background:rgba(0,229,160,0.12);color:#00e5a0;border:1px solid rgba(0,229,160,0.25);}
    .status.off{background:rgba(255,80,80,0.1);color:#ff6b6b;border:1px solid rgba(255,80,80,0.2);}
    .dot{width:7px;height:7px;border-radius:50%;display:inline-block;}
    .dot.on{background:#00e5a0;}
    .dot.off{background:#ff6b6b;}
    .email-badge{display:inline-block;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:5px 14px;font-size:13px;color:#fff;font-weight:600;margin-bottom:16px;}
    .btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:13px;border:none;border-radius:12px;font-size:14px;font-weight:600;cursor:pointer;transition:all .15s;text-decoration:none;font-family:inherit;}
    .btn:hover{opacity:.88;transform:translateY(-1px);}
    .btn-primary{background:#00e5a0;color:#0d0d1f;}
    .btn-google{background:#fff;color:#333;border:1.5px solid #ddd;}
    .btn-google:hover{background:#f8f8f8;}
    .btn-danger{background:rgba(255,80,80,0.12);color:#ff6b6b;border:1px solid rgba(255,80,80,0.2);}
    .btn-danger:hover{background:rgba(255,80,80,0.2);}
    .btn-outline{background:transparent;color:#00e5a0;border:1.5px solid rgba(0,229,160,0.3);}
    .btn-outline:hover{background:rgba(0,229,160,0.08);}
    .features{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px;}
    .feat{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px;text-align:center;}
    .feat .icon{font-size:22px;margin-bottom:6px;}
    .feat .label{font-size:12px;color:#9898b8;font-weight:500;}
    textarea{width:100%;min-height:120px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:14px;font-size:13px;color:#eee;font-family:inherit;line-height:1.6;resize:vertical;outline:none;transition:border-color .2s;}
    textarea:focus{border-color:rgba(0,229,160,0.4);}
    textarea::placeholder{color:#6b6b8a;}
    label{display:block;font-size:12px;font-weight:600;color:#9898b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;}
    .hint{font-size:11.5px;color:#6b6b8a;margin-top:6px;line-height:1.5;}
    .divider{height:1px;background:rgba(255,255,255,0.06);margin:20px 0;}
    .toggle-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;}
    .toggle{position:relative;width:48px;height:26px;cursor:pointer;}
    .toggle input{opacity:0;width:0;height:0;}
    .toggle .slider{position:absolute;inset:0;background:#333;border-radius:26px;transition:.3s;}
    .toggle .slider:before{content:'';position:absolute;height:20px;width:20px;left:3px;bottom:3px;background:#888;border-radius:50%;transition:.3s;}
    .toggle input:checked+.slider{background:rgba(0,229,160,0.3);}
    .toggle input:checked+.slider:before{transform:translateX(22px);background:#00e5a0;}
    .info{background:rgba(0,229,160,0.06);border:1px solid rgba(0,229,160,0.15);border-radius:10px;padding:14px;font-size:12.5px;color:#9898b8;line-height:1.6;margin-bottom:16px;}
    .info strong{color:#00e5a0;}
    .msg{padding:12px 16px;border-radius:10px;font-size:13px;font-weight:500;margin-bottom:16px;display:none;}
    .msg.success{display:block;background:rgba(0,229,160,0.1);border:1px solid rgba(0,229,160,0.25);color:#00e5a0;}
    .msg.error{display:block;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.2);color:#ff6b6b;}
    .actions{display:flex;gap:10px;}
    .actions .btn{flex:1;}
    .footer{text-align:center;padding:32px 0;font-size:12px;color:#6b6b8a;}
    .footer a{color:#00e5a0;text-decoration:none;}
  </style>
  </head><body>
  <div class="wrap">
    <div class="logo"><span>Aria<em>Ai</em></span></div>

    ${ownerEmail ? `<div style="text-align:center;margin-bottom:24px"><div class="email-badge">${ownerEmail}</div></div>` : ''}

    <div id="msg" class="msg"></div>

    <!-- Connection Card -->
    <div class="card">
      <h2>📧 Gmail Connection</h2>
      ${isConnected ? `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
          <span class="status on"><span class="dot on"></span> Connected</span>
        </div>
        <div class="features">
          <div class="feat"><div class="icon">💬</div><div class="label">Auto-Reply</div></div>
          <div class="feat"><div class="icon">📅</div><div class="label">Calendar Sync</div></div>
          <div class="feat"><div class="icon">📨</div><div class="label">Lead Alerts</div></div>
          <div class="feat"><div class="icon">🔒</div><div class="label">Secure</div></div>
        </div>
        <div class="actions">
          <a href="${authUrl}" class="btn btn-outline">Reconnect</a>
          <form action="/disconnect/gmail" method="POST" style="flex:1;display:flex">
            <input type="hidden" name="owner" value="${ownerEmail}">
            <button class="btn btn-danger" type="submit" style="flex:1">Disconnect</button>
          </form>
        </div>
      ` : `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
          <span class="status off"><span class="dot off"></span> Not Connected</span>
        </div>
        <p>Connect your Gmail to enable AI-powered email replies, calendar bookings, and lead alerts — all sent from your own email address.</p>
        <div class="info"><strong>What we access:</strong> Read incoming emails to generate replies, send on your behalf, mark as read, and manage your calendar for bookings. Revoke anytime in Google settings.</div>
        <a href="${authUrl}" class="btn btn-google">
          <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 6.293C4.672 4.166 6.656 3.58 9 3.58z"/></svg>
          Connect Gmail
        </a>
      `}
    </div>

    ${isNewClient ? `
    <!-- Onboarding Wizard -->
    <div class="card" id="onboardingWizard">
      <h2>👋 Welcome to Aria</h2>
      <p style="margin-bottom:20px;">Let's get your AI assistant set up in 3 simple steps.</p>

      <div id="wizStep1" style="display:block;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
          <div style="width:36px;height:36px;border-radius:50%;background:rgba(0,229,160,0.15);color:#00e5a0;display:flex;align-items:center;justify-content:center;font-weight:800;font-family:sans-serif;">1</div>
          <div><div style="font-weight:600;font-size:14px;">Connect your Gmail</div><div style="font-size:12px;color:#6b6b8a;">So Aria can read and reply to emails on your behalf</div></div>
        </div>
        <a href="${authUrl}" class="btn btn-google" style="width:100%;text-align:center;">
          <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 6.293C4.672 4.166 6.656 3.58 9 3.58z"/></svg>
          Connect Gmail
        </a>
        <p class="hint" style="margin-top:12px;">Steps 2 and 3 will appear once connected.</p>
      </div>
    </div>
    ` : ''}

    ${isConnected ? `
    <!-- Stats Card -->
    <div class="card">
      <h2>📊 Performance</h2>
      <div class="features">
        <div class="feat"><div class="icon" style="font-size:28px;font-weight:800;color:#00e5a0;">${stats.replied}</div><div class="label">Emails Replied</div></div>
        <div class="feat"><div class="icon" style="font-size:28px;font-weight:800;color:#38bdf8;">${stats.bookings}</div><div class="label">Bookings Made</div></div>
        <div class="feat"><div class="icon" style="font-size:28px;font-weight:800;color:#fbbf24;">${stats.followUps}</div><div class="label">Follow-Ups Sent</div></div>
        <div class="feat"><div class="icon" style="font-size:28px;font-weight:800;color:#ff6b6b;">${stats.urgent}</div><div class="label">Urgent Flagged</div></div>
      </div>
      ${stats.lastReply ? `<div style="font-size:12px;color:#6b6b8a;text-align:center;margin-top:8px;">Last reply: ${new Date(stats.lastReply).toLocaleString('en-GB')}</div>` : ''}

      <div class="divider"></div>

      <!-- Lead Scores -->
      <div style="margin-bottom:16px;">
        <div style="font-size:13px;font-weight:600;margin-bottom:10px;color:#9898b8;">Lead Quality</div>
        <div style="display:flex;gap:10px;">
          <div style="flex:1;background:rgba(255,80,80,0.08);border:1px solid rgba(255,80,80,0.15);border-radius:10px;padding:12px;text-align:center;">
            <div style="font-size:22px;font-weight:800;color:#ff6b6b;">${stats.leads.hot}</div>
            <div style="font-size:11px;color:#ff6b6b;font-weight:600;">🔥 Hot</div>
          </div>
          <div style="flex:1;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.15);border-radius:10px;padding:12px;text-align:center;">
            <div style="font-size:22px;font-weight:800;color:#fbbf24;">${stats.leads.warm}</div>
            <div style="font-size:11px;color:#fbbf24;font-weight:600;">🌤️ Warm</div>
          </div>
          <div style="flex:1;background:rgba(56,189,248,0.08);border:1px solid rgba(56,189,248,0.15);border-radius:10px;padding:12px;text-align:center;">
            <div style="font-size:22px;font-weight:800;color:#38bdf8;">${stats.leads.cold}</div>
            <div style="font-size:11px;color:#38bdf8;font-weight:600;">❄️ Cold</div>
          </div>
        </div>
      </div>

      <!-- Category Breakdown -->
      <div>
        <div style="font-size:13px;font-weight:600;margin-bottom:10px;color:#9898b8;">Email Categories</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          <span style="background:rgba(0,229,160,0.1);color:#00e5a0;padding:4px 12px;border-radius:8px;font-size:12px;font-weight:600;">💰 Quotes: ${stats.categories.quote}</span>
          <span style="background:rgba(56,189,248,0.1);color:#38bdf8;padding:4px 12px;border-radius:8px;font-size:12px;font-weight:600;">📅 Bookings: ${stats.categories.booking}</span>
          <span style="background:rgba(255,80,80,0.1);color:#ff6b6b;padding:4px 12px;border-radius:8px;font-size:12px;font-weight:600;">⚠️ Complaints: ${stats.categories.complaint}</span>
          <span style="background:rgba(251,191,36,0.1);color:#fbbf24;padding:4px 12px;border-radius:8px;font-size:12px;font-weight:600;">⭐ Feedback: ${stats.categories.feedback}</span>
          <span style="background:rgba(255,255,255,0.06);color:#9898b8;padding:4px 12px;border-radius:8px;font-size:12px;font-weight:600;">📧 General: ${stats.categories.general}</span>
        </div>
      </div>
    </div>

    <!-- Chart Card -->
    <div class="card">
      <h2>📈 30-Day Activity</h2>
      <canvas id="activityChart" height="200"></canvas>
    </div>

    <!-- Auto-Reply Card -->
    <div class="card">
      <h2>🤖 Email Auto-Reply</h2>
      <div class="toggle-row">
        <div>
          <div style="font-size:14px;font-weight:600;margin-bottom:2px;">Auto-reply to incoming emails</div>
          <div style="font-size:12px;color:#6b6b8a;">Aria reads new emails and sends a professional reply</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="autoReplyToggle" ${autoReplyEnabled ? 'checked' : ''} onchange="toggleAutoReply(this.checked)">
          <span class="slider"></span>
        </label>
      </div>

      <div class="divider"></div>

      <label for="prompt">Business Description</label>
      <textarea id="prompt" placeholder="Describe your business so Aria knows how to reply to emails. Include: business name, services, location, phone, email, hours, and any common questions.

Example: You are Aria, the assistant for Smith Plumbing — a family plumbing business in Manchester. Services include boiler repair, bathroom fitting, and emergency callouts. Phone: 07700 123456. Mon-Sat 8am-6pm.">${currentPrompt}</textarea>
      <p class="hint">This tells Aria about your business so it can reply to emails accurately. The more detail you include, the better the replies.</p>

      <div style="margin-top:16px;">
        <button class="btn btn-primary" onclick="saveAll()">Save Settings</button>
      </div>

      <div class="divider"></div>

      <button class="btn btn-outline" onclick="testNow()" id="testBtn">Test — Check Inbox Now</button>
    </div>

    <!-- Business Details Card -->
    <div class="card">
      <h2>🏢 Business Details</h2>
      <p>These details are used in your branded email signature.</p>

      <label for="businessName">Business Name</label>
      <input type="text" id="businessName" value="${currentCfg.businessName || ''}" placeholder="e.g. Smith Plumbing" style="width:100%;padding:12px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;font-size:13px;color:#eee;font-family:inherit;outline:none;margin-bottom:14px;">

      <label for="phone">Phone Number</label>
      <input type="text" id="phone" value="${currentCfg.phone || ''}" placeholder="e.g. 07700 123456" style="width:100%;padding:12px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;font-size:13px;color:#eee;font-family:inherit;outline:none;margin-bottom:14px;">

      <label for="website">Website</label>
      <input type="text" id="website" value="${currentCfg.website || ''}" placeholder="e.g. https://yoursite.co.uk" style="width:100%;padding:12px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;font-size:13px;color:#eee;font-family:inherit;outline:none;margin-bottom:14px;">

      <label for="brandColor">Brand Colour</label>
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;">
        <input type="color" id="brandColor" value="${currentCfg.brandColor || '#6C63FF'}" style="width:48px;height:40px;border:none;border-radius:8px;cursor:pointer;background:none;">
        <input type="text" id="brandColorText" value="${currentCfg.brandColor || '#6C63FF'}" placeholder="#6C63FF" style="flex:1;padding:12px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;font-size:13px;color:#eee;font-family:inherit;outline:none;">
      </div>
    </div>

    <!-- Business Hours Card -->
    <div class="card">
      <h2>🕐 Business Hours</h2>
      <p>Set your working hours so Aria gives appropriate out-of-hours replies.</p>

      <div class="toggle-row" style="margin-top:12px;">
        <div>
          <div style="font-size:14px;font-weight:600;margin-bottom:2px;">Enable business hours</div>
          <div style="font-size:12px;color:#6b6b8a;">Different replies outside working hours</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="hoursToggle" ${currentCfg.hoursStart ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px;">
        <div>
          <label for="hoursStart">Opens (24h)</label>
          <select id="hoursStart" style="width:100%;padding:12px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;font-size:13px;color:#eee;font-family:inherit;">
            ${Array.from({length:24}, (_,i) => `<option value="${i}" ${(currentCfg.hoursStart||9) === i ? 'selected' : ''}>${String(i).padStart(2,'0')}:00</option>`).join('')}
          </select>
        </div>
        <div>
          <label for="hoursEnd">Closes (24h)</label>
          <select id="hoursEnd" style="width:100%;padding:12px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;font-size:13px;color:#eee;font-family:inherit;">
            ${Array.from({length:24}, (_,i) => `<option value="${i}" ${(currentCfg.hoursEnd||17) === i ? 'selected' : ''}>${String(i).padStart(2,'0')}:00</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="toggle-row" style="margin-top:14px;">
        <div style="font-size:13px;color:#9898b8;">Skip weekends</div>
        <label class="toggle">
          <input type="checkbox" id="skipWeekends" ${currentCfg.skipWeekends ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </div>
    </div>

    <!-- Follow-ups Card -->
    <div class="card">
      <h2>📬 Follow-Ups</h2>
      <div class="toggle-row">
        <div>
          <div style="font-size:14px;font-weight:600;margin-bottom:2px;">Auto follow-up if no reply</div>
          <div style="font-size:12px;color:#6b6b8a;">Sends a friendly check-in after 24h, then again at 48h</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="followUpsToggle" ${currentCfg.followUps !== false ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </div>
    </div>

    <!-- Approval Mode Card -->
    <div class="card">
      <h2>✏️ Reply Approval Mode</h2>
      <div class="toggle-row">
        <div>
          <div style="font-size:14px;font-weight:600;margin-bottom:2px;">Review before sending</div>
          <div style="font-size:12px;color:#6b6b8a;">Aria emails you each draft with approve/reject buttons instead of sending automatically</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="approvalToggle" ${currentCfg.approvalMode ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </div>
    </div>

    <!-- Custom Footer Card -->
    <div class="card">
      <h2>🔗 Email Footer Links</h2>
      <p>Add social media and booking links to your email signature.</p>

      <label for="facebook">Facebook URL</label>
      <input type="text" id="facebook" value="${currentCfg.facebook || ''}" placeholder="https://facebook.com/yourbusiness" style="width:100%;padding:12px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;font-size:13px;color:#eee;font-family:inherit;outline:none;margin-bottom:14px;">

      <label for="instagram">Instagram URL</label>
      <input type="text" id="instagram" value="${currentCfg.instagram || ''}" placeholder="https://instagram.com/yourbusiness" style="width:100%;padding:12px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;font-size:13px;color:#eee;font-family:inherit;outline:none;margin-bottom:14px;">

      <label for="bookingUrl">Booking Page URL</label>
      <input type="text" id="bookingUrl" value="${currentCfg.bookingUrl || ''}" placeholder="https://calendly.com/yourbusiness" style="width:100%;padding:12px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;font-size:13px;color:#eee;font-family:inherit;outline:none;margin-bottom:14px;">

      <label for="reviewsUrl">Reviews Page URL</label>
      <input type="text" id="reviewsUrl" value="${currentCfg.reviewsUrl || ''}" placeholder="https://google.com/maps/place/yourbusiness" style="width:100%;padding:12px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;font-size:13px;color:#eee;font-family:inherit;outline:none;margin-bottom:14px;">
    </div>

    <!-- Knowledge Base Card -->
    <div class="card">
      <h2>📚 Knowledge Base</h2>
      <p>Add FAQs so Aria can answer common questions accurately.</p>

      <div id="kbList" style="margin:16px 0;"></div>

      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:16px;margin-top:12px;">
        <label for="kbQuestion">Question</label>
        <input type="text" id="kbQuestion" placeholder="e.g. What are your opening hours?" style="width:100%;padding:10px 12px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:8px;font-size:13px;color:#eee;font-family:inherit;outline:none;margin-bottom:10px;">

        <label for="kbAnswer">Answer</label>
        <textarea id="kbAnswer" rows="3" placeholder="e.g. We're open Monday to Friday, 9am to 5pm." style="min-height:70px;"></textarea>

        <button class="btn btn-outline" onclick="addKbEntry()" style="margin-top:10px;width:100%;">+ Add FAQ</button>
      </div>
    </div>

    <!-- Reply Log Card -->
    <div class="card">
      <h2>📨 Recent Replies</h2>
      <p>See what Aria has been replying to.</p>
      <div id="replyLog" style="margin-top:16px;"></div>
      <button class="btn btn-outline" onclick="loadReplyLog()" style="margin-top:12px;width:100%;">Refresh</button>
    </div>

    <!-- How It Works -->
    <div class="card">
      <h2>💡 How It Works</h2>
      <p style="margin-bottom:8px;">Once enabled, Aria will:</p>
      <div style="font-size:13px;color:#9898b8;line-height:2;">
        1. Check your inbox every 3 minutes<br>
        2. Skip spam, marketing, and out-of-office replies automatically<br>
        3. Remember previous conversations with each sender for context<br>
        4. Write a professional, branded reply using your business info and FAQs<br>
        5. Acknowledge any attachments the sender included<br>
        6. Rate each lead as hot, warm, or cold and categorise the email<br>
        7. Send the reply from your Gmail with your branded signature<br>
        8. If a booking is mentioned, add it to your Google Calendar<br>
        9. Flag urgent emails and alert you immediately<br>
        10. Follow up with leads who don't reply within 24h<br>
        11. Rate-limit replies so rapid-fire senders only get one response
      </div>
    </div>
    ` : ''}

    <div class="footer">Powered by <a href="https://aireyai.co.uk">AireyAi</a></div>
  </div>

  <script>
    const owner = '${ownerEmail}';
    const server = '';

    function showMsg(text, type) {
      const el = document.getElementById('msg');
      el.textContent = text;
      el.className = 'msg ' + type;
      setTimeout(() => { el.className = 'msg'; }, 4000);
    }

    function getConfig() {
      const hoursEnabled = document.getElementById('hoursToggle')?.checked;
      return {
        businessName: document.getElementById('businessName')?.value || '',
        phone: document.getElementById('phone')?.value || '',
        website: document.getElementById('website')?.value || '',
        brandColor: document.getElementById('brandColorText')?.value || '#6C63FF',
        hoursStart: hoursEnabled ? parseInt(document.getElementById('hoursStart')?.value || '9') : null,
        hoursEnd: hoursEnabled ? parseInt(document.getElementById('hoursEnd')?.value || '17') : null,
        skipWeekends: document.getElementById('skipWeekends')?.checked || false,
        followUps: document.getElementById('followUpsToggle')?.checked !== false,
        approvalMode: document.getElementById('approvalToggle')?.checked || false,
        facebook: document.getElementById('facebook')?.value || '',
        instagram: document.getElementById('instagram')?.value || '',
        bookingUrl: document.getElementById('bookingUrl')?.value || '',
        reviewsUrl: document.getElementById('reviewsUrl')?.value || '',
        timezone: 0,
      };
    }

    // Sync colour picker with text input
    document.getElementById('brandColor')?.addEventListener('input', e => {
      document.getElementById('brandColorText').value = e.target.value;
    });
    document.getElementById('brandColorText')?.addEventListener('input', e => {
      if (/^#[0-9a-f]{6}$/i.test(e.target.value)) document.getElementById('brandColor').value = e.target.value;
    });

    async function toggleAutoReply(enabled) {
      const prompt = document.getElementById('prompt')?.value || '';
      if (enabled && !prompt.trim()) {
        showMsg('Please enter a business description first.', 'error');
        document.getElementById('autoReplyToggle').checked = false;
        return;
      }
      const endpoint = enabled ? '/api/email-autoreply/enable' : '/api/email-autoreply/disable';
      const body = enabled ? { owner, systemPrompt: prompt, config: getConfig() } : { owner };
      const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await r.json();
      if (data.ok) showMsg(enabled ? 'Auto-reply enabled!' : 'Auto-reply disabled.', 'success');
      else showMsg(data.error || 'Something went wrong.', 'error');
    }

    async function saveAll() {
      const prompt = document.getElementById('prompt')?.value?.trim();
      if (!prompt) { showMsg('Please enter a business description.', 'error'); return; }
      const toggle = document.getElementById('autoReplyToggle');
      const body = { owner, systemPrompt: prompt, config: getConfig() };
      if (toggle.checked) {
        const r = await fetch('/api/email-autoreply/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await r.json();
        if (data.ok) showMsg('All settings saved!', 'success');
        else showMsg(data.error || 'Failed to save.', 'error');
      } else {
        showMsg('Settings saved! Turn on auto-reply to activate.', 'success');
      }
    }

    async function testNow() {
      const btn = document.getElementById('testBtn');
      btn.textContent = 'Checking...';
      btn.disabled = true;
      const r = await fetch('/api/email-autoreply/check-now', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner }) });
      const data = await r.json();
      btn.textContent = 'Test — Check Inbox Now';
      btn.disabled = false;
      if (data.ok) showMsg('Inbox checked! If there were new emails, replies have been sent.', 'success');
      else showMsg(data.error || 'Failed to check inbox.', 'error');
    }

    // ── Knowledge Base ──
    async function loadKb() {
      try {
        const r = await fetch('/api/knowledge-base?owner=' + encodeURIComponent(owner));
        const data = await r.json();
        const list = document.getElementById('kbList');
        if (!list) return;
        if (!data.entries?.length) { list.innerHTML = '<p style="color:#6b6b8a;font-size:13px;text-align:center;">No FAQs added yet.</p>'; return; }
        list.innerHTML = data.entries.map(e => '<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:14px;margin-bottom:10px;">'
          + '<div style="font-size:13px;font-weight:600;color:#00e5a0;margin-bottom:4px;">Q: ' + e.question + '</div>'
          + '<div style="font-size:12.5px;color:#9898b8;line-height:1.5;">A: ' + e.answer + '</div>'
          + '<button onclick="deleteKb(\'' + e.id + '\')" style="margin-top:8px;background:none;border:1px solid rgba(255,80,80,0.3);color:#ff6b6b;font-size:11px;padding:4px 10px;border-radius:6px;cursor:pointer;">Delete</button>'
          + '</div>').join('');
      } catch {}
    }

    async function addKbEntry() {
      const q = document.getElementById('kbQuestion')?.value?.trim();
      const a = document.getElementById('kbAnswer')?.value?.trim();
      if (!q || !a) { showMsg('Please fill in both question and answer.', 'error'); return; }
      const r = await fetch('/api/knowledge-base', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner, question: q, answer: a }) });
      const data = await r.json();
      if (data.ok) { document.getElementById('kbQuestion').value = ''; document.getElementById('kbAnswer').value = ''; loadKb(); showMsg('FAQ added!', 'success'); }
      else showMsg(data.error || 'Failed to add.', 'error');
    }

    async function deleteKb(id) {
      const r = await fetch('/api/knowledge-base', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner, id }) });
      const data = await r.json();
      if (data.ok) { loadKb(); showMsg('FAQ deleted.', 'success'); }
    }

    // ── Reply Log ──
    async function loadReplyLog() {
      try {
        const r = await fetch('/api/email-autoreply/reply-log?owner=' + encodeURIComponent(owner));
        const data = await r.json();
        const el = document.getElementById('replyLog');
        if (!el) return;
        if (!data.log?.length) { el.innerHTML = '<p style="color:#6b6b8a;font-size:13px;text-align:center;">No replies yet.</p>'; return; }
        el.innerHTML = data.log.slice(0, 20).map(r => {
          const badge = r.type === 'approved' ? '<span style="background:rgba(0,229,160,0.15);color:#00e5a0;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:600;">APPROVED</span>'
            : r.type === 'rejected' ? '<span style="background:rgba(255,80,80,0.15);color:#ff6b6b;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:600;">REJECTED</span>'
            : '<span style="background:rgba(56,189,248,0.15);color:#38bdf8;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:600;">AUTO</span>';
          const scoreBadge = r.leadScore === 'hot' ? '<span style="background:rgba(255,80,80,0.12);color:#ff6b6b;padding:2px 6px;border-radius:5px;font-size:9px;font-weight:700;">🔥 HOT</span>'
            : r.leadScore === 'warm' ? '<span style="background:rgba(251,191,36,0.12);color:#fbbf24;padding:2px 6px;border-radius:5px;font-size:9px;font-weight:700;">🌤️ WARM</span>'
            : r.leadScore ? '<span style="background:rgba(56,189,248,0.12);color:#38bdf8;padding:2px 6px;border-radius:5px;font-size:9px;font-weight:700;">❄️ COLD</span>' : '';
          const catBadge = r.category ? '<span style="background:rgba(255,255,255,0.06);color:#9898b8;padding:2px 6px;border-radius:5px;font-size:9px;font-weight:600;text-transform:uppercase;">' + r.category + '</span>' : '';
          return '<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:14px;margin-bottom:10px;">'
            + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">'
            + '<div style="font-size:13px;font-weight:600;color:#eee;">' + (r.senderEmail || 'Unknown') + '</div><div style="display:flex;gap:6px;align-items:center;">' + scoreBadge + catBadge + badge + '</div></div>'
            + '<div style="font-size:12px;color:#9898b8;margin-bottom:4px;">Re: ' + (r.subject || '') + '</div>'
            + '<div style="font-size:12px;color:#6b6b8a;line-height:1.5;">' + (r.replyPreview || '').substring(0, 150) + '...</div>'
            + '<div style="font-size:11px;color:#6b6b8a;margin-top:6px;">' + new Date(r.sentAt).toLocaleString('en-GB') + '</div>'
            + '</div>';
        }).join('');
      } catch {}
    }

    // Load KB and reply log on page load
    loadKb();
    loadReplyLog();

    // ── 30-Day Activity Chart ──
    const chartEl = document.getElementById('activityChart');
    if (chartEl) {
      const labels = ${JSON.stringify(chartLabels)}.map(d => { const p = d.split('-'); return p[2] + '/' + p[1]; });
      new Chart(chartEl, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: 'Replies', data: ${JSON.stringify(chartReplies)}, backgroundColor: 'rgba(0,229,160,0.5)', borderRadius: 4 },
            { label: 'Bookings', data: ${JSON.stringify(chartBookings)}, backgroundColor: 'rgba(56,189,248,0.5)', borderRadius: 4 },
          ],
        },
        options: {
          responsive: true,
          plugins: { legend: { labels: { color: '#9898b8', font: { size: 11 } } } },
          scales: {
            x: { ticks: { color: '#6b6b8a', font: { size: 10 }, maxRotation: 45 }, grid: { color: 'rgba(255,255,255,0.04)' } },
            y: { ticks: { color: '#6b6b8a', stepSize: 1 }, grid: { color: 'rgba(255,255,255,0.04)' }, beginAtZero: true },
          },
        },
      });
    }

    // ── Browser Push Notifications ──
    if ('Notification' in window && navigator.serviceWorker) {
      async function setupPush() {
        if (Notification.permission === 'default') {
          const btn = document.createElement('div');
          btn.innerHTML = '<div class="card" style="text-align:center;cursor:pointer;" onclick="requestNotifPermission(this)"><div style="font-size:24px;margin-bottom:8px;">🔔</div><div style="font-size:13px;font-weight:600;">Enable Browser Notifications</div><div style="font-size:12px;color:#6b6b8a;margin-top:4px;">Get instant alerts when urgent emails arrive</div></div>';
          const wrap = document.querySelector('.wrap');
          const footer = document.querySelector('.footer');
          if (wrap && footer) wrap.insertBefore(btn.firstChild, footer);
        }
      }
      setupPush();
    }

    window.requestNotifPermission = async function(el) {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        el.innerHTML = '<div style="font-size:24px;margin-bottom:8px;">✅</div><div style="font-size:13px;font-weight:600;color:#00e5a0;">Notifications enabled!</div>';
        // Start polling for urgent emails
        startUrgentPoll();
      } else {
        el.innerHTML = '<div style="font-size:13px;color:#ff6b6b;">Notifications were denied. Enable in browser settings.</div>';
      }
    };

    // Poll for urgent notifications (only if permission granted)
    let lastUrgentCheck = Date.now();
    function startUrgentPoll() {
      setInterval(async () => {
        try {
          const r = await fetch('/api/email-autoreply/reply-log?owner=' + encodeURIComponent(owner));
          const data = await r.json();
          const recent = (data.log || []).filter(l => new Date(l.sentAt).getTime() > lastUrgentCheck && l.category === 'complaint');
          for (const item of recent) {
            new Notification('🚨 Urgent: ' + item.subject, { body: 'From: ' + item.senderEmail, icon: '/favicon.ico' });
          }
          if (recent.length) lastUrgentCheck = Date.now();
        } catch {}
      }, 60000); // check every minute
    }
    if (Notification.permission === 'granted') startUrgentPoll();
  </script>
  </body></html>`);
});

// OAuth2 callback — Google redirects here after owner signs in
app.get('/auth/gmail/callback', async (req, res) => {
  const { code, state: rawState, error } = req.query;

  // ── Admin-auth dispatch ────────────────────────────────────────────────────
  // If state is `{adminAuth: true, t: <state_token>}`, this is a cross-origin
  // login for a client review page (not a Gmail-token-saving flow). Handle it
  // here BEFORE the Gmail flow tries to persist tokens for the user.
  try {
    const parsed = JSON.parse(rawState);
    if (parsed && parsed.adminAuth && parsed.t) {
      if (error) return res.status(400).send(`<h1>Sign-in cancelled</h1><p>${error}</p>`);
      if (!code) return res.status(400).send('No code received');
      const st = consumeAdminAuthState(parsed.t);
      if (!st) return res.status(400).send('<h1>Link expired</h1><p>Sign-in link expired or already used. Go back to the admin page and click "Sign in with Google" again.</p>');
      const oauthClient = makeOAuthClient();
      const { tokens } = await oauthClient.getToken(code);
      oauthClient.setCredentials(tokens);
      const userInfo = await google.oauth2({ version: 'v2', auth: oauthClient }).userinfo.get();
      const verifiedEmail = String(userInfo.data.email || '').toLowerCase();
      if (!verifiedEmail) return res.status(400).send('<h1>Sign-in failed</h1><p>Google did not return your email address.</p>');
      if (!isOwner(st.slug, verifiedEmail)) {
        return res.status(403).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Not authorized</title>
        <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d1f;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}.box{background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:40px;max-width:480px;text-align:center}h1{color:#ef4444;margin-top:0}a{color:#60a5fa}</style>
        </head><body><div class="box"><h1>Not authorized</h1><p><strong>${verifiedEmail}</strong> is not on the owner list for <strong>${st.slug}</strong>.</p><p>If this is your first time, ask the AireyAI team to add your email. Otherwise, sign out of Google and try again with the right account.</p><p><a href="${st.returnTo}">← Back to admin page</a></p></div></body></html>`);
      }
      // Issue a 24h signed token and bounce the user back to the original page
      // with the token in the URL fragment (never sent in HTTP requests, so it
      // doesn't leak through server logs or the Referer header).
      const expiry = Date.now() + 24 * 60 * 60 * 1000;
      const token = signAdminToken(verifiedEmail, st.slug, expiry);
      const returnUrl = st.returnTo + (st.returnTo.includes('#') ? '&' : '#') + 'aria_token=' + encodeURIComponent(token);
      console.log(`🔑 Admin sign-in: ${verifiedEmail} for slug=${st.slug}`);
      return res.redirect(returnUrl);
    }
  } catch (_) { /* not admin auth — fall through to Gmail flow */ }

  // Parse state — could be JSON { owner, onboard, quickSetup, setupToken } or plain email string
  let ownerEmail = rawState || '';
  let onboardToken = null;
  let isQuickSetup = false;
  let setupToken = null;
  try {
    const parsed = JSON.parse(rawState);
    if (parsed && parsed.setupToken) {
      setupToken = parsed.setupToken;
      ownerEmail = '';
    } else if (parsed && parsed.quickSetup) {
      isQuickSetup = true;
      ownerEmail = '';
    } else if (parsed && parsed.owner) {
      ownerEmail = parsed.owner;
      onboardToken = parsed.onboard || null;
    }
  } catch (_) { /* rawState is plain email string — already assigned */ }

  if (error) return res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>❌ Access denied</h2><p>${error}</p><p><a href="/setup">Try again</a></p></body></html>`);
  if (!code) return res.status(400).send('No code received');
  try {
    const client = makeOAuthClient();
    const { tokens } = await client.getToken(code);

    // If no email known, fetch from Google
    if (!ownerEmail || isQuickSetup || setupToken) {
      client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: 'v2', auth: client });
      const { data } = await oauth2.userinfo.get();
      ownerEmail = data.email;
    }

    await saveGmailTokens(ownerEmail, tokens);

    // If coming from onboarding wizard, redirect back there
    if (onboardToken) {
      return res.redirect(`/onboard?t=${encodeURIComponent(onboardToken)}&gmail_connected=1`);
    }

    // Setup flow with website scan — link the scanned profile to this Google account
    if (setupToken && pendingSetups.has(setupToken)) {
      const { profile } = pendingSetups.get(setupToken);
      pendingSetups.delete(setupToken);

      // Build system prompt from scanned profile
      const parts = [];
      if (profile.name) parts.push(`You are the AI assistant for ${profile.name}.`);
      if (profile.services) parts.push(`Services offered: ${profile.services}.`);
      if (profile.location) parts.push(`Located at: ${profile.location}.`);
      if (profile.phone) parts.push(`Phone: ${profile.phone}.`);
      if (profile.email) parts.push(`Email: ${profile.email}.`);
      if (profile.hours) parts.push(`Business hours: ${profile.hours}.`);
      if (profile.summary) parts.push(profile.summary);
      const systemPrompt = parts.length
        ? parts.join(' ') + ' Answer customer questions helpfully and accurately based on this information.'
        : 'You are Aria, a friendly AI assistant. Answer customer questions helpfully.';

      // Save the client profile
      const cacheKey = (profile.websiteUrl || '').toLowerCase().replace(/\/+$/, '') || ownerEmail;
      clientProfiles.set(cacheKey, {
        profile: { ...profile, systemPrompt },
        scannedAt: new Date().toISOString(),
      });
      persistProfiles();

      // Auto-enable auto-reply with the scanned business prompt
      enableEmailAutoReply(ownerEmail, systemPrompt, { ownerEmail, businessName: profile.name || ownerEmail.split('@')[0] });
    }

    // Quick setup (no scan) — auto-enable auto-reply with a generic prompt
    if (isQuickSetup) {
      const genericPrompt = `You are Aria, a friendly AI assistant. You help manage emails by providing helpful, professional responses. Always be polite and try to understand what the customer needs. If you're unsure about something specific to the business, let the customer know someone will follow up with more details.`;
      enableEmailAutoReply(ownerEmail, genericPrompt, { ownerEmail, businessName: ownerEmail.split('@')[0] });
    }

    // Create a session so they go straight to the dashboard
    const sessionToken = createSession(ownerEmail);
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d1f;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;color:#eee;}
      .box{background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:48px 40px;text-align:center;max-width:440px;width:100%;}
      .logo span{font-size:28px;font-weight:800;letter-spacing:-0.5px;}
      .logo em{font-style:normal;color:#00e5a0;}
      h1{font-size:22px;margin:16px 0 8px;}
      p{font-size:14px;color:#9898b8;line-height:1.7;margin-bottom:8px;}
      .email{display:inline-block;background:rgba(0,229,160,0.1);border:1px solid rgba(0,229,160,0.25);border-radius:8px;padding:6px 16px;font-size:14px;color:#00e5a0;font-weight:600;margin:12px 0;}
      .btn{display:inline-block;margin-top:20px;padding:14px 28px;background:#00e5a0;color:#0d0d1f;border-radius:12px;text-decoration:none;font-weight:600;transition:all .15s;}
      .btn:hover{opacity:.88;transform:translateY(-1px);}
      .checks{text-align:left;margin:20px 0;font-size:13px;color:#9898b8;line-height:2;}
      .checks span{color:#00e5a0;margin-right:8px;}
    </style>
    </head><body>
    <div class="box">
      <div class="logo"><span>Aria<em>Ai</em></span></div>
      <div style="font-size:48px;margin:20px 0">🎉</div>
      <h1>You're All Set!</h1>
      <div class="email">${ownerEmail}</div>
      <div class="checks">
        <div><span>✓</span> Gmail connected</div>
        <div><span>✓</span> Auto-reply enabled</div>
        <div><span>✓</span> Calendar booking ready</div>
      </div>
      <p>Aria is now monitoring your inbox and will reply to customers automatically.</p>
      <a href="/dashboard?owner=${encodeURIComponent(ownerEmail)}&s=${sessionToken}" class="btn">Go to Dashboard →</a>
    </div>
    </body></html>`);
  } catch (e) {
    console.error('Gmail OAuth error:', e.message);
    res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#0d0d1f;color:#eee;"><h2>❌ Something went wrong</h2><p style="color:#9898b8;">${e.message}</p><a href="/setup" style="color:#00e5a0;">Try again</a></body></html>`);
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

// ─── Self-Serve Onboarding ───────────────────────────────────────────────────
// Phase 1 spike: visitor pastes their URL → server scans it → Claude extracts
// business profile → generate Aria prompt → create preview session → visitor
// sees Aria embedded with their config + copy-paste embed snippet.
//
// Phase 2 (later) adds Stripe auth + per-account domain allowlisting between
// the preview and the embed snippet.

// POST /api/onboard/scan { url } → { profile, prompt, snippet, previewToken }
app.post('/api/onboard/scan', async (req, res) => {
  if (!checkRate(req.ip)) return res.status(429).json({ error: 'Rate limited' });
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Provide a website URL' });

  try {
    const { fetchSiteContent, extractBusinessProfile, generateSystemPrompt,
            createPreviewSession, generateEmbedSnippet, validateScanUrl } = await import('./lib/onboarding.js');

    // Validate URL up-front so SSRF + format errors return 400 with the
    // actual reason instead of being masked as a generic 500.
    const urlErr = validateScanUrl(url);
    if (urlErr) return res.status(400).json({ error: urlErr });

    const content = await fetchSiteContent(url);
    const profile = await extractBusinessProfile(claude, content);
    if (!profile) return res.status(422).json({ error: 'Could not extract business info — site may be JS-heavy or behind auth.' });

    const prompt = generateSystemPrompt(profile);
    const session = await createPreviewSession({ profile, prompt });
    const serverBaseUrl = `${req.protocol}://${req.get('host')}`;
    const snippet = generateEmbedSnippet({ profile, prompt, serverBaseUrl });

    res.json({
      profile,
      prompt,
      snippet,
      previewToken: session.token,
      previewUrl: `${serverBaseUrl}/preview/${session.token}`,
    });
  } catch (e) {
    console.error('[onboard/scan]', e.message);
    res.status(500).json({ error: e.message?.startsWith('Site') ? e.message : 'Scan failed — check the URL is reachable.' });
  }
});

// POST /api/onboard/install { previewToken, email, siteUrl } →
// finalises onboarding: allowlists the visitor's domain on Aria's server,
// emails them the install snippet. This is the "go live" step after preview.
//
// Phase 2 will add a Stripe Checkout gate before this route. For now it's
// open (free tier) so we can prove the funnel converts.
app.post('/api/onboard/install', async (req, res) => {
  if (!checkRate(req.ip)) return res.status(429).json({ error: 'Rate limited' });
  const { previewToken, email, siteUrl } = req.body || {};
  if (!previewToken || !email || !siteUrl) return res.status(400).json({ error: 'previewToken, email, and siteUrl required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });

  try {
    const { getPreviewSession, autoAllowlistDomain, emailInstallSnippet, generateEmbedSnippet } = await import('./lib/onboarding.js');
    const session = await getPreviewSession(previewToken);
    if (!session) return res.status(404).json({ error: 'Preview expired — generate a new one at /start' });

    const u = new URL(siteUrl);
    const serverBaseUrl = `${req.protocol}://${req.get('host')}`;
    const snippet = generateEmbedSnippet({ profile: session.profile, prompt: session.prompt, serverBaseUrl });

    // Step 1: allowlist their domain (so widget requests stop being 403'd)
    const allowlist = await autoAllowlistDomain(u.hostname, serverBaseUrl);
    // Step 2: email them the snippet (fire-and-forget — email latency must not block UX)
    emailInstallSnippet({
      smartSend, toEmail: email,
      businessName: session.profile.businessName,
      snippet,
      previewUrl: `${serverBaseUrl}/preview/${previewToken}`,
    }).catch(e => console.error('[onboard/install] email failed:', e?.message));

    res.json({
      ok: true,
      message: 'Domain allowlisted. Check your email for the install snippet.',
      domainAllowlisted: allowlist.ok,
      snippet, // also return inline so the page can show it immediately
    });
  } catch (e) {
    console.error('[onboard/install]', e.message);
    res.status(500).json({ error: 'Install failed — try again or contact support.' });
  }
});

// GET /preview/:token → HTML page with Aria embedded using the preview's config.
// This is the "live preview" iframe the /start page shows after the scan.
app.get('/preview/:token', async (req, res) => {
  const { getPreviewSession } = await import('./lib/onboarding.js');
  const session = await getPreviewSession(req.params.token);
  if (!session) return res.status(404).send('<h1>Preview expired</h1><p>Previews live for 1 hour. <a href="/start">Generate a new one</a>.</p>');

  const { profile, prompt } = session;
  const serverBaseUrl = `${req.protocol}://${req.get('host')}`;

  // Funnel: track that this prospect actually opened the preview. Critical
  // signal for cold-outreach conversion rates (sent vs viewed vs replied).
  const _slug = (profile.businessName || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 50);
  recordEvent({ slug: _slug, event: 'preview_viewed', sessionId: req.params.token, data: { hostname: profile.hostname || null } });
  const safePrompt = prompt.replace(/"/g, '&quot;').replace(/\n/g, ' ');
  // Fake mini-site styled in the visitor's detected brand colour so they
  // immediately recognise "this is what Aria looks like on MY site".
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aria preview — ${profile.businessName}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; min-height: 100vh;
         background: linear-gradient(135deg, ${profile.primaryColor || '#4a5568'}15, #fff);
         display: flex; align-items: center; justify-content: center; padding: 40px 20px; }
  .preview { max-width: 600px; text-align: center; }
  h1 { font-size: 32px; margin: 0 0 12px; color: #1a202c; }
  .business { color: ${profile.primaryColor || '#4a5568'}; }
  p { color: #4a5568; line-height: 1.6; }
  .pill { display: inline-block; background: ${profile.primaryColor || '#4a5568'}; color: white;
          padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: 600;
          letter-spacing: 1px; text-transform: uppercase; margin-bottom: 20px; }
</style></head>
<body>
  <div class="preview">
    <div class="pill">Aria preview</div>
    <h1>Welcome to <span class="business">${profile.businessName}</span></h1>
    <p>${profile.description || ''}</p>
    <p style="margin-top: 30px; font-size: 14px; color: #718096;">Try the chatbot in the bottom-right corner →</p>
  </div>
  <script src="${serverBaseUrl}/chatbot.js"
    data-name="Aria"
    data-color="${profile.primaryColor || '#4a5568'}"
    data-server="${serverBaseUrl}"
    data-endpoint="/api/chat/router"
    data-streaming="true"
    data-type="${profile.businessType || 'generic'}"
    ${profile.contact?.email ? `data-handoff-email="${profile.contact.email}"` : ''}
    data-prompt="${safePrompt}"
  ></script>
</body></html>`);
});

// GET /start → the onboarding landing page where visitors paste their URL.
// Niche-tuned headlines that swap onto the generic /start page based on
// /start/:niche path. Same flow, but the hero + feature copy speaks
// directly to the niche so SEO + paid landing pages convert better.
const NICHE_COPY = {
  trades:     { hero: 'Install Aria on your trades website in <span class="accent">60 seconds</span>',
                sub: 'Stop losing leads to voicemail. Aria qualifies every visitor, captures their name + number, and WhatsApps you the hot ones.',
                niche: 'Trades' },
  roofers:    { hero: '<span class="accent">Never miss</span> a roofing quote again',
                sub: 'Aria handles your inbox 24/7. Captures the visitor\'s name, address, and what work they need — texts you the qualified leads in real time.',
                niche: 'Roofers' },
  salons:     { hero: 'Aria takes salon bookings while you do <span class="accent">lashes</span>',
                sub: 'Visitors book themselves while you\'re mid-treatment. Aria knows your services, captures contact details, and emails you a daily roundup.',
                niche: 'Salons' },
  restaurants:{ hero: 'Aria takes <span class="accent">reservations</span> on your website',
                sub: 'Two-stage approval — Aria captures the booking, you confirm. Never an embarrassing double-book or 9pm "are you open?" question missed.',
                niche: 'Restaurants' },
  gyms:       { hero: 'Aria sells <span class="accent">memberships</span> while the gym is closed',
                sub: 'After-hours visitors get tour bookings and price quotes without you lifting a finger.',
                niche: 'Gyms' },
  clinics:    { hero: 'Aria triages enquiries <span class="accent">24/7</span>',
                sub: 'Booking requests, prescription questions, hours — captured and queued for your team. HIPAA-safe handoff.',
                niche: 'Clinics' },
};

app.get(['/start', '/start/:niche'], (req, res) => {
  const copy = NICHE_COPY[req.params?.niche] || {
    hero: 'Install Aria on your site in <span class="accent">60 seconds</span>',
    sub: 'Paste your website URL. Aria will read it, learn your business, and show you a working AI chatbot configured for you — before you sign up.',
    niche: null,
  };
  // Inject into the render below — see the next edit which swaps the static H1.
  res.locals = { ...res.locals, copy };
  return renderStartPage(res, copy);
});

function renderStartPage(res, copy) {
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${copy.niche ? `Aria — AI chatbot for ${copy.niche}` : 'Aria — install on your site in 60 seconds'}</title>
<meta name="description" content="Aria is a 60-second-install AI chatbot${copy.niche ? ` built for ${copy.niche.toLowerCase()}` : ''}. Auto-qualifies leads, captures contact details, hands off to WhatsApp. No card required to try.">
<meta property="og:title" content="Aria — ${copy.niche ? `AI chatbot for ${copy.niche}` : 'install on your site in 60 seconds'}">
<meta property="og:description" content="Paste your URL → see Aria configured for your business → install in 60 seconds. No card.">
<meta property="og:type" content="website">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #fff; color: #1a202c; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 80px 24px; }
  h1 { font-size: 44px; line-height: 1.1; font-weight: 800; letter-spacing: -0.03em; margin-bottom: 16px; }
  h1 .accent { background: linear-gradient(135deg, #6366f1, #ec4899); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
  .sub { color: #4a5568; font-size: 19px; line-height: 1.6; margin-bottom: 40px; max-width: 560px; }
  .form { display: flex; gap: 12px; margin-bottom: 16px; }
  input { flex: 1; font-size: 17px; padding: 16px 20px; border: 2px solid #e2e8f0; border-radius: 12px;
          font-family: inherit; outline: none; transition: border-color 0.15s; }
  input:focus-visible { border-color: #6366f1; }
  button { background: #1a202c; color: white; font-size: 17px; font-weight: 600; padding: 16px 28px;
           border: 0; border-radius: 12px; cursor: pointer; font-family: inherit; transition: transform 0.15s; }
  button:hover { transform: translateY(-1px); }
  button:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
  .hint { color: #718096; font-size: 14px; }
  .result { margin-top: 48px; display: none; }
  .result.show { display: block; }
  iframe { width: 100%; height: 480px; border: 2px solid #e2e8f0; border-radius: 16px; background: #fff; }
  .snippet { background: #1a202c; color: #cbd5e0; padding: 20px; border-radius: 12px; margin-top: 24px;
             font-family: 'SF Mono', Monaco, monospace; font-size: 13px; line-height: 1.6;
             overflow-x: auto; white-space: pre; }
  .copy { background: #6366f1; margin-top: 12px; }
  .step { color: #6366f1; font-weight: 600; font-size: 13px; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 8px; }
  .error { color: #e53e3e; margin-top: 12px; font-size: 14px; }
  .features { margin: 60px 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 24px; }
  .feature { padding: 24px; background: #f7fafc; border-radius: 12px; }
  .feature h3 { font-size: 16px; margin-bottom: 8px; }
  .feature p { font-size: 14px; color: #4a5568; line-height: 1.5; }
</style></head>
<body>
<div class="wrap">
  <h1>${copy.hero}</h1>
  <p class="sub">${copy.sub}</p>

  <div class="form">
    <input id="url" type="url" placeholder="https://your-website.com" autocomplete="off" autofocus>
    <button id="scan" onclick="scan()">Scan my site →</button>
  </div>
  <p class="hint">No signup. No card. Works on any website.</p>
  <p class="error" id="err"></p>

  <div class="features">
    <div class="feature"><h3>Captures leads automatically</h3><p>Aria qualifies every visitor and texts you the hot ones.</p></div>
    <div class="feature"><h3>Books appointments</h3><p>Two-stage approval — you confirm before bookings land.</p></div>
    <div class="feature"><h3>White-label by default</h3><p>Looks like your brand. No "Powered by" footer.</p></div>
  </div>

  <div class="result" id="result">
    <p class="step">Step 1 of 3 — live preview</p>
    <h2 style="font-size:24px;margin-bottom:16px">Here's Aria on your site:</h2>
    <iframe id="preview"></iframe>

    <p class="step" style="margin-top:48px">Step 2 of 3 — allowlist your domain</p>
    <h2 style="font-size:24px;margin-bottom:8px">Tell us where to send the install code:</h2>
    <p style="color:#4a5568;margin-bottom:16px">We'll allowlist your domain on our server and email you the snippet. Free to install — no card required.</p>
    <div class="form" style="margin-bottom:0">
      <input id="email" type="email" placeholder="you@your-business.com" autocomplete="email">
      <button id="install" onclick="install()">Email me the snippet →</button>
    </div>
    <p class="error" id="installErr"></p>
    <p class="hint" id="installOk" style="display:none;color:#16a34a;font-weight:600"></p>

    <p class="step" style="margin-top:48px">Step 3 of 3 — paste &amp; ship</p>
    <h2 style="font-size:24px;margin-bottom:16px">Paste this before <code style="background:#f7fafc;padding:2px 6px;border-radius:4px">&lt;/body&gt;</code> on every page:</h2>
    <pre class="snippet" id="snippet"></pre>
    <button class="copy" onclick="copySnippet()">Copy to clipboard</button>
  </div>
</div>

<script>
async function scan() {
  const url = document.getElementById('url').value.trim();
  const btn = document.getElementById('scan');
  const err = document.getElementById('err');
  err.textContent = '';
  if (!url) { err.textContent = 'Paste your website URL first.'; return; }

  btn.disabled = true; btn.textContent = 'Scanning your site…';
  try {
    const res = await fetch('/api/onboard/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Scan failed');

    _currentPreviewToken = data.previewToken;
    _currentSiteUrl = url;
    document.getElementById('preview').src = data.previewUrl;
    document.getElementById('snippet').textContent = data.snippet;
    document.getElementById('result').classList.add('show');
    document.getElementById('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Scan my site →';
  }
}
function copySnippet() {
  navigator.clipboard.writeText(document.getElementById('snippet').textContent);
  event.target.textContent = '✓ Copied';
  setTimeout(() => event.target.textContent = 'Copy to clipboard', 1500);
}
let _currentPreviewToken = null, _currentSiteUrl = null;
async function install() {
  const email = document.getElementById('email').value.trim();
  const btn = document.getElementById('install');
  const err = document.getElementById('installErr');
  const okMsg = document.getElementById('installOk');
  err.textContent = ''; okMsg.style.display = 'none';
  if (!email) { err.textContent = 'Add your email so we can send the snippet.'; return; }
  btn.disabled = true; btn.textContent = 'Allowlisting your domain…';
  try {
    const res = await fetch('/api/onboard/install', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ previewToken: _currentPreviewToken, email, siteUrl: _currentSiteUrl }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Install failed');
    okMsg.textContent = '✓ ' + data.message;
    okMsg.style.display = 'block';
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Email me the snippet →';
  }
}
document.getElementById('url').addEventListener('keydown', e => {
  if (e.key === 'Enter') scan();
});
document.getElementById('email').addEventListener('keydown', e => {
  if (e.key === 'Enter') install();
});
// Auto-fill URL from ?url= query param (for SEO landing pages / referrals)
const urlParam = new URLSearchParams(location.search).get('url');
if (urlParam) {
  document.getElementById('url').value = urlParam;
  // Auto-scan after a short delay so the page renders first
  setTimeout(scan, 400);
}
</script>
</body></html>`);
}

// ─── Lead-Router Chat (tool-use) ─────────────────────────────────────────────
// Same guard rails as /api/chat (rate limit, cost cap, session save) but
// routes through lib/lead_router.js so Claude can invoke tools to qualify
// leads, log them, stage WhatsApp pings, and stage calendar bookings.
// Two-stage approval (CLAUDE.md Rule #12): irreversible tools STAGE to
// data/pending_actions.jsonl and email the owner a one-click confirm link.
app.post('/api/chat/router', async (req, res) => {
  if (!checkRate(req.ip)) return res.status(429).json({ error: 'Rate limited' });
  if (isOverCap())        return res.status(429).json({ error: 'Monthly message limit reached — please try again next month.' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API key not configured' });

  const { system, messages, model, max_tokens, sessionId, clientConfig = {} } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'Invalid messages' });

  try {
    const lastScore = clientConfig.lastScore ?? 0;
    const tier = lastScore >= 70 ? 'hot' : lastScore >= 40 ? 'warm' : 'cold';
    const action = decideLeadAction({
      score: lastScore,
      tier,
      businessType: clientConfig.type,
      hasContact:   Boolean(clientConfig.capturedEmail || clientConfig.capturedPhone),
      isOutOfHours: clientConfig.isOutOfHours ?? false,
    });

    // Per-page enrichment — visitor on /pricing is way more buying-ready
    // than one on /about. Thread page context into the prompt so Aria knows
    // where in the funnel this person is.
    const pageContext = (clientConfig.pageUrl || clientConfig.pageTitle || clientConfig.isOutOfHours)
      ? '\n\nVISITOR CONTEXT:\n'
        + (clientConfig.pageTitle ? `- Currently viewing: "${clientConfig.pageTitle}"\n` : '')
        + (clientConfig.pagePath  ? `- Page path: ${clientConfig.pagePath}\n` : '')
        + (clientConfig.isOutOfHours ? '- It is currently outside business hours — set expectations about response time.\n' : '')
      : '';

    const fullPrompt = (system || 'You are a helpful assistant.')
      + buildBusinessContext()
      + pageContext
      + '\n\n' + policyAddendum(action);

    const { reply, toolEvents, warning, stopReason, usage } = await routeChat({
      claude,
      messages: messages.slice(-24),
      systemPrompt: fullPrompt,
      clientConfig: { ...clientConfig, serverBaseUrl: `${req.protocol}://${req.get('host')}` },
      sessionId,
      serverFns: { smartSend, sendWhatsAppMessage },
      model: model || 'claude-sonnet-4-6',
      maxTokens: max_tokens || 800,
    });

    // Track usage AFTER the call so monthly caps + cost alerts actually
    // include router traffic. Without this, /api/chat tracked but the new
    // tool-use router silently bypassed the cap (Codex B2).
    if (usage) trackUsage(usage.inputTokens, usage.outputTokens);
    if (warning) console.warn('[aria/router]', warning); // Rule #10 — fail loud
    if (sessionId) saveSession(sessionId, { messages: messages.slice(-24) });

    // Track the qualify_lead score back to clientConfig so the next turn can
    // re-evaluate policy with up-to-date info. Widget should persist this.
    const qualifyEvent = toolEvents.find(e => e.name === 'qualify_lead');
    const newScore = qualifyEvent?.result?.score ?? lastScore;

    // Funnel analytics — one event per chat round-trip, plus higher-signal
    // events for lead capture + hot-lead promotion + after-hours engagement.
    // Prefer explicit clientConfig.slug, then derive from Origin/Referer host
    // so widgets that forgot to set data-slug still get attributed per site.
    const _slug = clientConfig.slug || deriveSlugFromRequest(req) || 'unknown';
    const _owner = clientConfig.handoffEmail || null;
    recordEvent({ slug: _slug, event: 'chat_message', sessionId, ownerEmail: _owner });
    // Fire first-chat milestone email exactly once per slug (file-backed dedupe).
    maybeFireFirstChatMilestone({ slug: _slug, ownerEmail: _owner, serverUrl: `${req.protocol}://${req.get('host')}` });
    if (clientConfig.isOutOfHours) {
      recordEvent({ slug: _slug, event: 'after_hours', sessionId, ownerEmail: _owner });
    }
    if (newScore >= 40 && newScore > lastScore) {
      recordEvent({
        slug: _slug, event: 'lead_captured', sessionId, ownerEmail: _owner,
        data: { score: newScore, summary: qualifyEvent?.input?.summary || null },
      });
      if (newScore >= 70) {
        recordEvent({
          slug: _slug, event: 'lead_hot', sessionId, ownerEmail: _owner,
          data: { score: newScore, summary: qualifyEvent?.input?.summary || null },
        });
      }
    }
    for (const e of toolEvents) {
      if (e.name === 'send_whatsapp_to_owner' && e.result?.ok) {
        recordEvent({ slug: _slug, event: 'owner_notified', sessionId, ownerEmail: _owner, data: { channel: 'whatsapp' } });
      } else if (e.name === 'book_calendar_slot' && e.result?.ok) {
        recordEvent({ slug: _slug, event: 'booking_created', sessionId, ownerEmail: _owner });
      }
    }

    // Dual-shape response: widget reads `data.content[0].text` (Anthropic shape)
    // unchanged; richer consumers can read `reply`, `toolEvents`, `score`, `action`.
    res.json({
      content: [{ type: 'text', text: reply }],
      reply,
      toolEvents,
      score: newScore,
      stopReason,
      action,
    });
  } catch (e) {
    console.error('[aria/router] error:', e.message);
    res.status(500).json({ error: 'AI error' });
  }
});

// ─── Streaming variant of /api/chat/router (SSE) ─────────────────────────────
// Same policy and tool-use loop as /api/chat/router but emits text deltas as
// they arrive from Anthropic. Tool dispatches happen invisibly between turns
// — visitor sees continuous text output instead of a long pause.
//
// SSE event format matches /api/chat/stream so the widget's streamResponse
// handler can consume it unchanged: {text: t} deltas, optional {tool: name},
// final {done, score, toolEvents, stopReason}, then literal "[DONE]".
app.post('/api/chat/router/stream', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const sse = d => { res.write(`data: ${typeof d === 'string' ? d : JSON.stringify(d)}\n\n`); if (typeof res.flush === 'function') res.flush(); };

  if (!checkRate(req.ip)) { sse({ error: 'Rate limited' }); return res.end(); }
  if (isOverCap())        { sse({ error: 'Monthly message limit reached — please try again next month.' }); return res.end(); }
  if (!process.env.ANTHROPIC_API_KEY) { sse({ error: 'API key not configured' }); return res.end(); }

  const { system, messages, model, max_tokens, sessionId, clientConfig = {} } = req.body;
  if (!messages?.length) { sse({ error: 'Invalid messages' }); return res.end(); }

  // res.on('close') — fires on actual client disconnect. NOT req.on('close')
  // which in Node 24+ fires the moment express.json() finishes consuming the
  // body, killing every SSE write before the model even responds.
  let aborted = false;
  res.on('close', () => { aborted = true; });

  try {
    const lastScore = clientConfig.lastScore ?? 0;
    const tier = lastScore >= 70 ? 'hot' : lastScore >= 40 ? 'warm' : 'cold';
    const action = decideLeadAction({
      score: lastScore,
      tier,
      businessType: clientConfig.type,
      hasContact:   Boolean(clientConfig.capturedEmail || clientConfig.capturedPhone),
      isOutOfHours: clientConfig.isOutOfHours ?? false,
    });

    const pageContext = (clientConfig.pageUrl || clientConfig.pageTitle || clientConfig.isOutOfHours)
      ? '\n\nVISITOR CONTEXT:\n'
        + (clientConfig.pageTitle ? `- Currently viewing: "${clientConfig.pageTitle}"\n` : '')
        + (clientConfig.pagePath  ? `- Page path: ${clientConfig.pagePath}\n` : '')
        + (clientConfig.isOutOfHours ? '- It is currently outside business hours — set expectations about response time.\n' : '')
      : '';

    const fullPrompt = (system || 'You are a helpful assistant.')
      + buildBusinessContext()
      + pageContext
      + '\n\n' + policyAddendum(action);

    const { streamRouteChat } = await import('./lib/lead_router_stream.js');
    const { stopReason, toolEvents, score, warning, usage } = await streamRouteChat({
      claude,
      messages: messages.slice(-24),
      systemPrompt: fullPrompt,
      clientConfig: { ...clientConfig, serverBaseUrl: `${req.protocol}://${req.get('host')}` },
      sessionId,
      serverFns: { smartSend, sendWhatsAppMessage },
      onTextDelta: t => { if (!aborted) sse({ text: t }); },
      onToolEvent: e => { if (!aborted) sse({ tool: e.name, result: e.result }); },
      // Lets the router actually abort the upstream Anthropic stream + skip
      // irreversible tool dispatch when the visitor closes the tab.
      isAborted: () => aborted,
      model: model || 'claude-sonnet-4-6',
      maxTokens: max_tokens || 800,
    });

    // Track usage even on aborted streams — tokens already crossed the wire.
    if (usage) trackUsage(usage.inputTokens, usage.outputTokens);
    if (warning) console.warn('[aria/router-stream]', warning);
    if (sessionId) saveSession(sessionId, { messages: messages.slice(-24) });

    // Funnel analytics — same shape as non-streaming router. We don't record
    // aborts as `chat_message` because no full exchange occurred.
    if (stopReason !== 'client_aborted') {
      const _slug = clientConfig.slug || 'unknown';
      const _owner = clientConfig.handoffEmail || null;
      recordEvent({ slug: _slug, event: 'chat_message', sessionId, ownerEmail: _owner });
    // Fire first-chat milestone email exactly once per slug (file-backed dedupe).
    maybeFireFirstChatMilestone({ slug: _slug, ownerEmail: _owner, serverUrl: `${req.protocol}://${req.get('host')}` });
      if (clientConfig.isOutOfHours) {
        recordEvent({ slug: _slug, event: 'after_hours', sessionId, ownerEmail: _owner });
      }
      const qualifyEvent = toolEvents.find(e => e.name === 'qualify_lead');
      if (qualifyEvent && score >= 40 && score > (clientConfig.lastScore ?? 0)) {
        recordEvent({
          slug: _slug, event: 'lead_captured', sessionId, ownerEmail: _owner,
          data: { score, summary: qualifyEvent.input?.summary || null },
        });
        if (score >= 70) {
          recordEvent({
            slug: _slug, event: 'lead_hot', sessionId, ownerEmail: _owner,
            data: { score, summary: qualifyEvent.input?.summary || null },
          });
        }
      }
      for (const e of toolEvents) {
        if (e.name === 'send_whatsapp_to_owner' && e.result?.ok) {
          recordEvent({ slug: _slug, event: 'owner_notified', sessionId, ownerEmail: _owner, data: { channel: 'whatsapp' } });
        } else if (e.name === 'book_calendar_slot' && e.result?.ok) {
          recordEvent({ slug: _slug, event: 'booking_created', sessionId, ownerEmail: _owner });
        }
      }
    }

    if (!aborted) {
      sse({ done: true, score, toolEvents, stopReason, action });
      sse('[DONE]');
      res.end();
    }
  } catch (e) {
    console.error('[aria/router-stream] error:', e.message);
    if (!aborted) { sse({ error: 'AI error' }); res.end(); }
  }
});

// ─── Pending action confirmation (two-stage approval for irreversible ops) ──
// Owner gets emailed a link like /api/pending/confirm?id=<id>&token=<t>
// which executes the staged WhatsApp send or calendar booking.
//
// In-process lock prevents the read→check→execute→append race (Codex B5).
// Two simultaneous clicks would otherwise both pass the "already actioned"
// check, both fire sendWhatsAppMessage, and the prospect gets the same WA
// twice. Single-instance Railway deploy makes a Map-based lock sufficient;
// a multi-node setup would need a real lease (Redis SETNX or similar).
const _pendingConfirmInFlight = new Set();

function _resolveWhatsAppCreds(ownerHandoffEmail) {
  // Sender = agency (Kyle), not the site owner. Try env first (most common),
  // then per-owner channelConfigs (rare — only set if a client has their own
  // WABA + Kyle is operating it for them).
  if (process.env.WA_PHONE_NUMBER_ID && process.env.WA_ACCESS_TOKEN) {
    return { phoneNumberId: process.env.WA_PHONE_NUMBER_ID, accessToken: process.env.WA_ACCESS_TOKEN };
  }
  if (ownerHandoffEmail && typeof channelConfigs !== 'undefined') {
    const cfg = channelConfigs.get(ownerHandoffEmail);
    if (cfg?.whatsapp?.phoneNumberId && cfg?.whatsapp?.accessToken) return cfg.whatsapp;
  }
  return null;
}

app.get('/api/pending/confirm', async (req, res) => {
  const { id, token } = req.query;
  if (!id || !token) return res.status(400).send('Missing id or token');

  // Block concurrent confirmations for the same id. The reservation is freed
  // in finally{} regardless of execute success/failure so a retried link still
  // works after a transient error (e.g. SMTP timeout).
  if (_pendingConfirmInFlight.has(id)) {
    return res.status(409).send('Confirmation already in progress — refresh in a moment.');
  }
  _pendingConfirmInFlight.add(id);

  let rows;
  try {
    try {
      const raw = await fsp.readFile(resolve('data', 'pending_actions.jsonl'), 'utf8');
      rows = raw.trim().split('\n').filter(Boolean).map(JSON.parse);
    } catch {
      return res.status(404).send('No pending actions');
    }

    // Append-only log: an entry is "live" if its id has no later row with executed_at set.
    const matches = rows.filter(r => r.id === id);
    if (!matches.length) return res.status(403).send('Invalid or expired link');
    const row = matches[0];
    if (!_constantTimeEq(row.token, String(token))) return res.status(403).send('Invalid token');
    if (matches.some(r => r.executed_at)) return res.send('Already actioned.');

    if (row.kind === 'send_whatsapp_to_owner') {
      const wa = row.payload;
      const ownerWa = row.owner?.handoffWa;
      if (!ownerWa) {
        console.error('[aria/pending] cannot send — no handoffWa on staged row', row.id);
        return res.status(500).send('No WhatsApp number configured for this client');
      }
      const creds = _resolveWhatsAppCreds(row.owner?.handoffEmail);
      if (!creds) {
        // Fail loud (Rule #10) — silently swallowing this used to mean the
        // owner thought their lead was forwarded when nothing actually sent.
        console.error('[aria/pending] no WhatsApp creds resolved (env or channelConfigs) — id=' + row.id);
        return res.status(500).send('WhatsApp not configured on this server. Lead saved to dashboard.');
      }
      const ok = await sendWhatsAppMessage(creds, ownerWa,
        `New lead from your site (Aria):\n\n${wa.summary}\n\nCallback: ${wa.callback_number}\nUrgency: ${wa.urgency}`);
      if (!ok) {
        console.error('[aria/pending] WhatsApp send returned false — id=' + row.id);
        return res.status(502).send('WhatsApp send failed. Check server logs.');
      }
    } else if (row.kind === 'book_calendar_slot') {
      // Each client's calendar auth is per-account — full calendar.events.insert
      // wiring is a follow-up. For now: email the owner with the booking details
      // so they confirm by hand. Visitor was told "we'll confirm within 1 hour".
      const b = row.payload;
      const ownerEmail = row.owner?.handoffEmail || process.env.NOTIFY_EMAIL;
      if (ownerEmail) {
        await smartSend({
          ownerEmail, to: ownerEmail,
          subject: `Aria booking request — ${b.visitor_name}`,
          html: `<p>Tentative booking:</p><pre>${JSON.stringify(b, null, 2)}</pre>`
        });
      }
    } else {
      return res.status(400).send(`Unknown pending kind: ${row.kind}`);
    }

    await fsp.appendFile(resolve('data', 'pending_actions.jsonl'),
      JSON.stringify({ ...row, executed_at: new Date().toISOString() }) + '\n');
    res.send('Done — Aria has sent it.');
  } catch (e) {
    console.error('[aria/pending] execute failed:', e.message);
    res.status(500).send('Execute failed: ' + e.message);
  } finally {
    _pendingConfirmInFlight.delete(id);
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
  // res.on('close') — Node 24+ emits req 'close' when the body stream is
  // consumed (right after express.json()), which would falsely flag aborted=true
  // before any text deltas fire. res 'close' fires only on actual disconnect.
  let aborted = false;
  res.on('close', () => { aborted = true; });
  try {
    const stream = claude.messages.stream({
      model:      model || 'claude-haiku-4-5-20251001',
      max_tokens: max_tokens || 500,
      system:     (system || 'You are a helpful assistant.') + buildBusinessContext(),
      messages:   messages.slice(-24),
    });
    res.on('close', () => { try { stream.abort(); } catch {} });
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

// ─── Image Upload ────────────────────────────────────────────────────────────
app.post('/api/chat/upload', async (req, res) => {
  try {
    const { image, message, system, sessionId, model } = req.body;
    if (!image) return res.status(400).json({ error: 'No image provided' });

    const match = image.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Invalid image format' });

    const mediaType = match[1];
    const data = match[2];

    const messages = [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
        { type: 'text', text: message || 'What do you see in this image? How can you help based on what you see?' },
      ],
    }];

    const response = await claude.messages.create({
      model: model || 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: system || '',
      messages,
    });

    trackUsage(response.usage?.input_tokens || 0, response.usage?.output_tokens || 0);
    res.json(response);
  } catch (e) {
    res.status(500).json({ error: e.message });
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
  // Magic-link replaces ?pass=ADMIN so the master password never lands in
  // client inboxes (Codex C5). One-shot, 30min, consumed on first click.
  const adminUrl   = mintAdminMagicLink(req);
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

  // 3. Add to Google Calendar as a lead event (timestamped now)
  if (alertTo && gmailTokens.has(alertTo)) {
    createCalendarEvent(alertTo, {
      name: `🎯 Lead: ${name || email}`,
      email: email,
      datetime: new Date().toISOString(),
      notes: `Lead from ${siteName || page || 'website'}\nEmail: ${email}${name ? '\nName: ' + name : ''}${qualification?.need ? '\nNeed: ' + qualification.need : ''}${insight?.score ? '\nScore: ' + insight.score + '/10' : ''}`,
      siteName: siteName || page,
      timezone: 'Europe/London',
    }).catch(() => {});
  }

  // 4. Slack alert to owner channel
  await slack(slackLeadBlocks({ email, score:insight?.score, tag:insight?.tag, page, adminUrl }), `New lead: ${email}${siteName ? ' ('+siteName+')' : ''}`);

  // 5. Mailchimp sync
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
  // Magic-link instead of master password in client inboxes (Codex C5).
  const adminUrl  = mintAdminMagicLink(req);
  const alertTo   = ownerTo(b.ownerEmail);

  // 1. Create Google Calendar event (non-blocking — runs in parallel with emails)
  const calendarPromise = alertTo ? createCalendarEvent(alertTo, b) : Promise.resolve(null);

  // 2. Generate .ics calendar invite attachment (works with any mail client — Outlook, Apple Mail, Gmail)
  //    Skipped silently if we can't determine the date (e.g. free-text bookings)
  const icsOwner = await buildBookingIcs({ ...b, ownerEmail: alertTo }, { method: 'REQUEST' }).catch(() => null);
  const icsVisitor = await buildBookingIcs({ ...b, ownerEmail: alertTo }, { method: 'PUBLISH' }).catch(() => null);

  // 3. Alert the site owner — use their Gmail if connected; attach the .ics so Outlook users can one-tap-add
  await smartSend({
    ownerEmail: alertTo,
    to:         alertTo,
    replyTo:    b.email,
    subject:    `New booking — ${b.name} · ${b.datetime}`,
    html:       bookingTpl({ ...b, adminUrl }),
    attachments: icsOwner ? [icsOwner] : undefined,
  });

  // 4. Wait for calendar, then send visitor confirmation with calendar link if available
  const calEvent = await calendarPromise;
  b.calendarLink = calEvent?.htmlLink || null;
  b.calendarAdded = !!calEvent;

  if (b.email) {
    await smartSend({
      ownerEmail: alertTo,
      to:         b.email,
      replyTo:    alertTo,
      subject:    `Booking received — ${b.siteName || 'your session'}`,
      html:       visitorBookingTpl({ ...b, ownerEmail: alertTo, calendarLink: b.calendarLink, adminUrl: null }),
      attachments: icsVisitor ? [icsVisitor] : undefined,
    });
  }

  // 4. Slack
  await slack([
    { type:'header', text:{ type:'plain_text', text:'📅 New Booking' + (calEvent ? ' — Added to Calendar ✓' : '') } },
    { type:'section', text:{ type:'mrkdwn', text:`*${b.name}* (${b.email}) — *${b.datetime}*\nSite: ${b.siteName||b.page}${calEvent?.htmlLink ? '\n<'+calEvent.htmlLink+'|View in Google Calendar>' : ''}` } },
  ], `Booking from ${b.name}`);

  res.json({ ok:true, calendarAdded: !!calEvent, calendarLink: b.calendarLink });
});

// ─── Standalone Booking Page ──────────────────────────────────────────────────

app.get('/book', async (req, res) => {
  const owner = req.query.owner || '';
  if (!owner) return res.status(400).send('Missing owner parameter');

  // Load client profile for business name and services
  let businessName = owner.split('@')[0];
  let services = [];
  let brandColor = '#6C63FF';
  for (const [, v] of clientProfiles) {
    if (v.profile?.email === owner || v.profile?.name) {
      businessName = v.profile.name || businessName;
      if (v.profile.services) {
        services = v.profile.services.split(/,|;|\n/).map(s => s.trim()).filter(Boolean);
      }
      break;
    }
  }

  res.send(`<!DOCTYPE html><html><head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Book — ${businessName}</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d1f;min-height:100vh;color:#eee;padding:20px;}
      .container{max-width:480px;margin:0 auto;}
      .logo{text-align:center;margin-bottom:24px;}
      .logo h1{font-size:24px;font-weight:800;letter-spacing:-0.5px;}
      .logo em{font-style:normal;color:${brandColor};}
      .logo p{font-size:13px;color:#9898b8;margin-top:4px;}
      .step{display:none;} .step.active{display:block;}
      .step h2{font-size:18px;margin-bottom:16px;font-weight:600;}
      .services{display:flex;flex-direction:column;gap:8px;margin-bottom:20px;}
      .svc{background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px 16px;cursor:pointer;transition:all .15s;font-size:14px;}
      .svc:hover,.svc.selected{border-color:${brandColor};background:rgba(108,99,255,0.08);}
      .svc.selected::after{content:'✓';float:right;color:${brandColor};font-weight:700;}
      .slots{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:20px;max-height:320px;overflow-y:auto;}
      .slot{background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px;cursor:pointer;text-align:center;transition:all .15s;font-size:13px;}
      .slot:hover,.slot.selected{border-color:${brandColor};background:rgba(108,99,255,0.08);}
      .slot .day{font-weight:600;font-size:14px;margin-bottom:2px;}
      .slot .time{color:#9898b8;font-size:12px;}
      input{width:100%;padding:14px 16px;background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:12px;color:#eee;font-size:14px;margin-bottom:12px;outline:none;}
      input:focus{border-color:${brandColor};}
      input::placeholder{color:#666;}
      .btn{width:100%;padding:14px;background:${brandColor};color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;transition:all .15s;}
      .btn:hover{opacity:.88;transform:translateY(-1px);}
      .btn:disabled{opacity:.4;cursor:not-allowed;transform:none;}
      .back{background:none;border:none;color:#9898b8;font-size:13px;cursor:pointer;margin-bottom:16px;padding:0;}
      .back:hover{color:#eee;}
      .loading{text-align:center;padding:40px;color:#9898b8;font-size:14px;}
      .success{text-align:center;padding:40px 0;}
      .success .icon{font-size:48px;margin-bottom:16px;}
      .success h2{margin-bottom:8px;}
      .success p{color:#9898b8;font-size:14px;line-height:1.6;}
      .success .email{display:inline-block;background:rgba(108,99,255,0.1);border:1px solid rgba(108,99,255,0.25);border-radius:8px;padding:6px 16px;font-size:14px;color:${brandColor};font-weight:600;margin:12px 0;}
    </style>
  </head><body>
    <div class="container">
      <div class="logo">
        <h1>${businessName}</h1>
        <p>Book an appointment online</p>
      </div>

      <!-- Step 1: Service -->
      <div class="step active" id="step-service">
        <h2>What would you like to book?</h2>
        <div class="services" id="service-list">
          ${services.length ? services.map(s => `<div class="svc" onclick="selectService(this,'${s.replace(/'/g, "\\'")}')">${s}</div>`).join('') : '<input id="custom-service" placeholder="What do you need? (e.g. Haircut, Massage, Consultation)" />'}
        </div>
        <button class="btn" onclick="goToSlots()">Next →</button>
      </div>

      <!-- Step 2: Time slot -->
      <div class="step" id="step-slots">
        <button class="back" onclick="goBack('step-service')">← Back</button>
        <h2>Pick a time</h2>
        <div id="slots-container"><div class="loading">Loading available slots...</div></div>
        <button class="btn" id="slots-next" disabled onclick="goToDetails()">Next →</button>
      </div>

      <!-- Step 3: Details -->
      <div class="step" id="step-details">
        <button class="back" onclick="goBack('step-slots')">← Back</button>
        <h2>Your details</h2>
        <input id="b-name" placeholder="Your name" />
        <input id="b-email" type="email" placeholder="Email address" />
        <input id="b-phone" type="tel" placeholder="Phone number (optional)" />
        <div id="confirm-summary" style="background:#161630;border-radius:12px;padding:16px;margin-bottom:16px;font-size:13px;color:#9898b8;"></div>
        <button class="btn" onclick="confirmBooking()">Confirm Booking ✓</button>
      </div>

      <!-- Step 4: Success -->
      <div class="step" id="step-done">
        <div class="success">
          <div class="icon">🎉</div>
          <h2>You're booked in!</h2>
          <p>A confirmation email is on its way.<br>We'll see you soon.</p>
          <div class="email" id="done-summary"></div>
        </div>
      </div>
    </div>

    <script>
      const OWNER = '${owner}';
      let selectedService = '';
      let selectedSlot = null;

      function selectService(el, name) {
        document.querySelectorAll('.svc').forEach(s => s.classList.remove('selected'));
        el.classList.add('selected');
        selectedService = name;
      }

      function showStep(id) {
        document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
        document.getElementById(id).classList.add('active');
      }

      function goBack(stepId) { showStep(stepId); }

      async function goToSlots() {
        if (!selectedService) {
          const custom = document.getElementById('custom-service');
          if (custom) selectedService = custom.value.trim();
        }
        if (!selectedService) return;
        showStep('step-slots');
        const container = document.getElementById('slots-container');
        container.innerHTML = '<div class="loading">Checking availability...</div>';
        try {
          const r = await fetch('/api/calendar/availability?owner=' + encodeURIComponent(OWNER));
          const data = await r.json();
          if (!data.slots?.length) {
            container.innerHTML = '<div class="loading">No slots available right now — please call us to arrange.</div>';
            return;
          }
          container.innerHTML = '<div class="slots">' + data.slots.map((s, i) =>
            '<div class="slot" onclick="selectSlot(this,' + i + ')">' +
              '<div class="day">' + s.date + '</div>' +
              '<div class="time">' + s.time + '</div>' +
            '</div>'
          ).join('') + '</div>';
          window._slots = data.slots;
        } catch {
          container.innerHTML = '<div class="loading">Could not load slots — please try again.</div>';
        }
      }

      function selectSlot(el, idx) {
        document.querySelectorAll('.slot').forEach(s => s.classList.remove('selected'));
        el.classList.add('selected');
        selectedSlot = window._slots[idx];
        document.getElementById('slots-next').disabled = false;
      }

      function goToDetails() {
        if (!selectedSlot) return;
        showStep('step-details');
        document.getElementById('confirm-summary').innerHTML =
          '<strong>' + selectedService + '</strong><br>' + selectedSlot.date + ' — ' + selectedSlot.time;
      }

      async function confirmBooking() {
        const name = document.getElementById('b-name').value.trim();
        const email = document.getElementById('b-email').value.trim();
        const phone = document.getElementById('b-phone').value.trim();
        if (!name || !email) return alert('Please enter your name and email.');
        try {
          await fetch('/api/booking', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name, email, phone,
              datetime: selectedSlot.date + ' ' + selectedSlot.time.split(' - ')[0],
              notes: selectedService,
              ownerEmail: OWNER,
              siteName: '${businessName.replace(/'/g, "\\'")}',
              page: 'Booking Page',
            }),
          });
          document.getElementById('done-summary').textContent = selectedSlot.date + ' — ' + selectedSlot.time;
          showStep('step-done');
        } catch {
          alert('Something went wrong — please try again.');
        }
      }
    </script>
  </body></html>`);
});

// ─── Order Endpoint ──────────────────────────────────────────────────────────

app.post('/api/order', async (req, res) => {
  const { name, email, phone, item, variant, address, notes, ownerEmail, siteName } = req.body;
  if (!item) return res.status(400).json({ error: 'Item required' });
  const alertTo = ownerTo(ownerEmail);

  // Save as lead
  const key = email || phone || name;
  if (key && !leadStatuses.has(key)) {
    leadStatuses.set(key, { status: 'new', notes: 'Order: ' + item, updatedAt: new Date(), name, siteName });
    save('leadStatuses', Array.from(leadStatuses.entries()));
  }

  // Email the owner
  await smartSend({
    ownerEmail: alertTo,
    to: alertTo,
    replyTo: email || undefined,
    subject: `🛒 New Order: ${item}${variant ? ' (' + variant + ')' : ''} — ${name || 'Visitor'}`,
    html: `<div style="font-family:-apple-system,sans-serif;max-width:500px;margin:0 auto;padding:24px;">
      <h2 style="margin:0 0 16px;color:#1a1a2e">🛒 New Order</h2>
      <div style="background:#f8f8fc;border-radius:12px;padding:20px;margin-bottom:16px;">
        <p style="margin:0 0 8px;font-size:14px;"><strong>Item:</strong> ${item}${variant ? ' — ' + variant : ''}</p>
        <p style="margin:0 0 8px;font-size:14px;"><strong>Name:</strong> ${name || 'Not provided'}</p>
        ${email ? `<p style="margin:0 0 8px;font-size:14px;"><strong>Email:</strong> <a href="mailto:${email}">${email}</a></p>` : ''}
        ${phone ? `<p style="margin:0 0 8px;font-size:14px;"><strong>Phone:</strong> <a href="tel:${phone}">${phone}</a></p>` : ''}
        ${address ? `<p style="margin:0 0 8px;font-size:14px;"><strong>Delivery:</strong> ${address}</p>` : ''}
        ${notes ? `<p style="margin:0;font-size:14px;"><strong>Notes:</strong> ${notes}</p>` : ''}
      </div>
      <p style="font-size:13px;color:#666;">From ${siteName || 'your website'} • ${new Date().toLocaleString('en-GB')}</p>
    </div>`,
  });

  // Add to Google Calendar
  if (alertTo && gmailTokens.has(alertTo)) {
    createCalendarEvent(alertTo, {
      name: `🛒 Order: ${item}${variant ? ' (' + variant + ')' : ''} — ${name || 'Visitor'}`,
      email: email || '',
      datetime: new Date().toISOString(),
      notes: `Order placed\nItem: ${item}${variant ? '\nVariant: ' + variant : ''}\n${name ? 'Name: ' + name : ''}${email ? '\nEmail: ' + email : ''}${phone ? '\nPhone: ' + phone : ''}${address ? '\nDelivery: ' + address : ''}${notes ? '\nNotes: ' + notes : ''}\nSite: ${siteName || 'website'}`,
      siteName: siteName,
      timezone: 'Europe/London',
    }).catch(() => {});
  }

  // Slack
  await slack([
    { type: 'header', text: { type: 'plain_text', text: '🛒 New Order' } },
    { type: 'section', text: { type: 'mrkdwn', text: `*${item}*${variant ? ' (' + variant + ')' : ''}\n${name || 'Visitor'}${email ? ' — ' + email : ''}\n${address ? 'Delivery: ' + address : 'No address'}\nSite: ${siteName || 'Website'}` } },
  ], `Order: ${item}`);

  // Confirmation email to visitor
  if (email) {
    await smartSend({
      ownerEmail: alertTo,
      to: email,
      replyTo: alertTo,
      subject: `🛒 Order received — ${item}`,
      html: `<div style="font-family:-apple-system,sans-serif;max-width:500px;margin:0 auto;padding:24px;">
        <h2 style="margin:0 0 16px;color:#1a1a2e">Order Received ✓</h2>
        <p style="font-size:14px;color:#444;line-height:1.7;margin-bottom:16px;">Thanks${name ? ' ' + name : ''}! Your order has been received and someone will be in touch to confirm.</p>
        <div style="background:#f8f8fc;border-radius:12px;padding:16px;font-size:14px;">
          <strong>${item}</strong>${variant ? ' — ' + variant : ''}
          ${address ? '<br>Delivering to: ' + address : ''}
        </div>
        <p style="font-size:13px;color:#666;margin-top:16px;">From ${siteName || 'the team'}</p>
      </div>`,
    });
  }

  res.json({ ok: true });
});

// ─── Booking Lookup / Reschedule / Cancel ────────────────────────────────────

// Look up a booking by visitor email in Google Calendar
app.get('/api/booking/lookup', async (req, res) => {
  const { owner, email } = req.query;
  if (!owner || !email) return res.json({ booking: null });
  const entry = gmailTokens.get(owner);
  if (!entry) return res.json({ booking: null });

  try {
    const calendar = google.calendar({ version: 'v3', auth: entry.auth });
    const now = new Date();
    const { data } = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      maxResults: 50,
      singleEvents: true,
      orderBy: 'startTime',
      q: email,
    });

    const event = data.items?.find(e =>
      e.description?.toLowerCase().includes(email.toLowerCase()) ||
      e.attendees?.some(a => a.email?.toLowerCase() === email.toLowerCase())
    );

    if (!event) return res.json({ booking: null });

    res.json({
      booking: {
        id: event.id,
        summary: event.summary || 'Appointment',
        date: event.start?.dateTime
          ? new Date(event.start.dateTime).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
          : event.start?.date || 'Unknown date',
        description: event.description || '',
      },
    });
  } catch (e) {
    console.warn('Booking lookup failed:', e.message);
    res.json({ booking: null });
  }
});

// Cancel a booking
app.post('/api/booking/cancel', async (req, res) => {
  const { owner, eventId } = req.body;
  if (!owner || !eventId) return res.status(400).json({ error: 'Missing owner or eventId' });
  const entry = gmailTokens.get(owner);
  if (!entry) return res.status(400).json({ error: 'Calendar not connected' });

  try {
    const calendar = google.calendar({ version: 'v3', auth: entry.auth });
    await calendar.events.delete({ calendarId: 'primary', eventId, sendUpdates: 'all' });
    res.json({ ok: true });
  } catch (e) {
    console.warn('Cancel failed:', e.message);
    res.status(500).json({ error: 'Could not cancel' });
  }
});

// Reschedule a booking
app.post('/api/booking/reschedule', async (req, res) => {
  const { owner, eventId, newDatetime } = req.body;
  if (!owner || !eventId || !newDatetime) return res.status(400).json({ error: 'Missing fields' });
  const entry = gmailTokens.get(owner);
  if (!entry) return res.status(400).json({ error: 'Calendar not connected' });

  try {
    const calendar = google.calendar({ version: 'v3', auth: entry.auth });
    const parsed = await parseBookingDatetime(newDatetime);

    const patch = parsed
      ? { start: { dateTime: parsed.start, timeZone: 'Europe/London' }, end: { dateTime: parsed.end, timeZone: 'Europe/London' } }
      : { summary: `📅 Rescheduled — ${newDatetime}` };

    await calendar.events.patch({ calendarId: 'primary', eventId, requestBody: patch, sendUpdates: 'all' });
    res.json({ ok: true });
  } catch (e) {
    console.warn('Reschedule failed:', e.message);
    res.status(500).json({ error: 'Could not reschedule' });
  }
});

// ─── Reviews (multi-tenant moderation) ───────────────────────────────────────
//
// Fully multi-tenant: every client site gets its own reviews list via a slug in
// the URL (e.g. /api/reviews/repwithrobson, /api/reviews/ejroofing). One server,
// one DB file, full isolation between clients.
//
// Admin password resolution (most specific wins):
//   1. env REVIEWS_ADMIN_PASS_<slug>   — per-client (e.g. REVIEWS_ADMIN_PASS_repwithrobson)
//   2. env REVIEWS_ADMIN_PASS          — global master (you only)
//
// Note: the historical "aria-admin" default was retired alongside ADMIN_PASS
// in 2026-05 — a guessable default in an OSS repo meant any reader could
// moderate every tenant's reviews. Falls back to ADMIN_PASS so existing
// admin auth still works without needing a separate REVIEWS_ADMIN_PASS env.
const REVIEWS_MASTER_PASS = process.env.REVIEWS_ADMIN_PASS || ADMIN;

function adminPassForSlug(slug) {
  const perClient = process.env['REVIEWS_ADMIN_PASS_' + slug];
  return perClient || REVIEWS_MASTER_PASS;
}

function persistReviews() {
  const obj = {};
  for (const [slug, list] of reviews.entries()) obj[slug] = list;
  save('reviews', obj);
}

function sanitiseText(s, max = 2000) {
  if (typeof s !== 'string') return '';
  // Strip control chars + angle brackets (XSS) + cap length
  return s.replace(/[\x00-\x1f<>]/g, '').trim().slice(0, max);
}

function isAdminReq(req, slug) {
  // 1. New: HMAC-signed token from Google-OAuth admin sign-in (preferred path).
  //    No shared secret on the client; email is verified against owners.json.
  const ariaToken = req.get('X-Aria-Token') || req.query.aria_token;
  if (ariaToken && verifyAdminToken(String(ariaToken), slug)) return true;

  // 2. Legacy: shared `X-Admin-Password` header / `?adminPass=` query.
  //    Kept working during OAuth rollout so non-migrated clients aren't broken.
  //    A console warning fires so we can see in logs which slugs still depend
  //    on the password path and need migrating.
  const expected = adminPassForSlug(slug);
  const header = req.get('X-Admin-Password');
  const query  = req.query.adminPass;
  const accept = v => v && (v === expected || v === REVIEWS_MASTER_PASS);
  if (accept(header) || accept(query)) {
    console.warn(`⚠️  Legacy X-Admin-Password used for slug=${slug} — migrate to OAuth (data/owners.json)`);
    return true;
  }
  return false;
}

// GET — list reviews for a client. ?all=1 (+ admin header) returns pending/rejected too.
app.get('/api/reviews/:slug', (req, res) => {
  const slug = req.params.slug;
  const list = reviews.get(slug) || [];
  const wantAll = req.query.all === '1';
  if (wantAll && !isAdminReq(req, slug)) return res.status(401).json({ error: 'Admin auth required for ?all=1' });
  const filtered = wantAll ? list : list.filter(r => r.approved && !r.rejected);
  // Redact private fields for public responses
  const visible = wantAll ? filtered : filtered.map(({ email, ip, ...rest }) => rest);
  res.json({ reviews: visible, total: visible.length });
});

// POST — submit a new review (pending approval).
app.post('/api/reviews/:slug', async (req, res) => {
  const slug = req.params.slug;
  const body = req.body || {};
  const name   = sanitiseText(body.name, 80);
  const email  = sanitiseText(body.email, 120);
  const text   = sanitiseText(body.text || body.review, 2000);
  const rating = Math.max(1, Math.min(5, parseInt(body.rating, 10) || 5));
  const service = sanitiseText(body.service, 80);

  if (!name || !email || text.length < 20) {
    return res.status(400).json({ error: 'name, email and review (min 20 chars) are required' });
  }

  const review = {
    id: 'rv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name, email, rating, text, service,
    date: 'Just now',
    source: 'Website',
    submittedAt: new Date().toISOString(),
    approved: false,
    rejected: false,
    ip: req.headers['x-forwarded-for'] || req.ip || ''
  };

  const list = reviews.get(slug) || [];
  list.unshift(review);
  reviews.set(slug, list);
  persistReviews();

  // Alert owner (uses the slug to derive owner email from client profile, falls back to body.ownerEmail)
  let ownerEmail = body.ownerEmail || null;
  if (!ownerEmail) {
    for (const [, v] of clientProfiles) {
      if (v.profile?.slug === slug || v.profile?.code === slug) { ownerEmail = v.profile.email; break; }
    }
  }
  const alertTo = ownerTo(ownerEmail);
  if (alertTo) {
    const safeText = text.replace(/</g, '&lt;');
    const adminUrl = `${req.protocol}://${req.get('host')}/admin/reviews.html`;
    await smartSend({
      ownerEmail: alertTo,
      to: alertTo,
      replyTo: email,
      subject: `⭐ New review from ${name} (${rating}★) — ${slug}`,
      html: `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
        <h2 style="margin:0 0 16px;color:#0A0A0A">⭐ New review awaiting approval</h2>
        <p style="font-size:14px;color:#666;"><strong>${name}</strong> (${email}) left a ${rating}-star review on your ${slug} site.</p>
        ${service ? `<p style="font-size:13px;color:#888;">Treatment: ${service}</p>` : ''}
        <blockquote style="border-left:3px solid #EC0A7E;padding:12px 16px;background:#FAFAFA;font-size:14px;margin:16px 0;">${safeText}</blockquote>
        <a href="${adminUrl}" style="display:inline-block;padding:12px 22px;background:#EC0A7E;color:#fff;border-radius:999px;text-decoration:none;font-weight:600">Approve or reject →</a>
      </div>`,
    });
  }

  await slack([
    { type: 'header', text: { type: 'plain_text', text: `⭐ New review — ${slug}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*${name}* (${email}) — ${rating}★\n${text.slice(0, 280)}${text.length > 280 ? '…' : ''}` } },
  ], `New review for ${slug}`);

  res.json({ ok: true, id: review.id });
});

// PATCH — moderate a review (approve / reject / delete). Admin only.
app.patch('/api/reviews/:slug/:id', (req, res) => {
  const { slug, id } = req.params;
  if (!isAdminReq(req, slug)) return res.status(401).json({ error: 'Admin auth required' });
  const action = (req.body?.action || '').toLowerCase();
  const list = reviews.get(slug) || [];
  const idx = list.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Review not found' });

  if (action === 'approve') { list[idx].approved = true;  list[idx].rejected = false; }
  else if (action === 'reject')  { list[idx].approved = false; list[idx].rejected = true; }
  else if (action === 'delete')  { list.splice(idx, 1); }
  else return res.status(400).json({ error: 'action must be approve | reject | delete' });

  reviews.set(slug, list);
  persistReviews();
  res.json({ ok: true });
});

// ─── Abandoned Chat Recovery ─────────────────────────────────────────────────

// Stores abandoned chats and sends recovery email after 30 minutes
app.post('/api/chat/abandoned', async (req, res) => {
  const { messages, ownerEmail, siteName, botName, visitorName, page, sessionId } = req.body;
  if (!messages?.length || messages.length < 4) return res.json({ ok: true });
  const alertTo = ownerTo(ownerEmail);

  // Try to find visitor email from conversation
  const allText = messages.filter(m => m.role === 'user').map(m => m.content).join(' ');
  const emailMatch = allText.match(/[\w.+-]+@[\w.-]+\.\w{2,}/);
  const visitorEmail = emailMatch?.[0];

  // Alert owner immediately
  await smartSend({
    ownerEmail: alertTo,
    to: alertTo,
    subject: `⚠️ Abandoned Chat${visitorName ? ': ' + visitorName : ''} — ${siteName || 'Website'}`,
    html: `<div style="font-family:-apple-system,sans-serif;max-width:500px;margin:0 auto;padding:24px;">
      <h2 style="margin:0 0 16px;color:#1a1a2e">⚠️ Visitor Left Without Booking</h2>
      <p style="font-size:14px;color:#666;margin-bottom:16px;">Someone chatted on ${siteName || 'your website'} but didn't book, leave contact info, or place an order.</p>
      ${visitorName ? `<p style="font-size:14px;"><strong>Name:</strong> ${visitorName}</p>` : ''}
      ${visitorEmail ? `<p style="font-size:14px;"><strong>Email found in chat:</strong> ${visitorEmail}</p>` : ''}
      <p style="font-size:14px;"><strong>Page:</strong> ${page || 'Unknown'}</p>
      <div style="margin:16px 0;border-top:1px solid #eee;padding-top:16px;">
        <p style="font-size:13px;font-weight:600;margin-bottom:8px;">Conversation:</p>
        ${messages.slice(-10).map(m => `<p style="font-size:13px;color:${m.role === 'user' ? '#333' : '#888'};margin:4px 0;"><strong>${m.role === 'user' ? (visitorName || 'Visitor') : 'Aria'}:</strong> ${m.content.slice(0, 200)}</p>`).join('')}
      </div>
    </div>`,
  });

  // If we found their email, schedule a recovery email in 30 minutes
  if (visitorEmail) {
    setTimeout(async () => {
      // Check they haven't converted since (became a lead)
      if (leadStatuses.has(visitorEmail)) return;

      await smartSend({
        ownerEmail: alertTo,
        to: visitorEmail,
        replyTo: alertTo,
        subject: `Still interested? — ${siteName || botName || 'us'}`,
        html: `<div style="font-family:-apple-system,sans-serif;max-width:500px;margin:0 auto;padding:24px;">
          <h2 style="margin:0 0 16px;color:#1a1a2e">Hey${visitorName ? ' ' + visitorName : ''} 👋</h2>
          <p style="font-size:14px;color:#444;line-height:1.7;margin-bottom:16px;">
            I noticed you were chatting with us earlier but didn't get a chance to finish up.
            If you'd like to book in or have any questions, just reply to this email — happy to help!
          </p>
          <p style="font-size:14px;color:#444;line-height:1.7;">
            ${siteName ? `The team at <strong>${siteName}</strong> is` : 'We are'} here whenever you're ready.
          </p>
        </div>`,
      });
    }, 30 * 60 * 1000);
  }

  res.json({ ok: true });
});

// ─── Smart Chat Actions ──────────────────────────────────────────────────────

// Calendar availability check — returns free slots for the next 5 days
app.get('/api/calendar/availability', async (req, res) => {
  const owner = ownerTo(req.query.owner);
  if (!owner || !gmailTokens.has(owner)) return res.json({ slots: [], message: 'Calendar not connected' });

  try {
    const entry = gmailTokens.get(owner);
    const calendar = google.calendar({ version: 'v3', auth: entry.auth });
    const now = new Date();
    const end = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);

    const { data } = await calendar.freebusy.query({
      requestBody: {
        timeMin: now.toISOString(),
        timeMax: end.toISOString(),
        timeZone: 'Europe/London',
        items: [{ id: 'primary' }],
      },
    });

    const busy = (data.calendars?.primary?.busy || []).map(b => ({
      start: new Date(b.start),
      end: new Date(b.end),
    }));

    // Generate available 1-hour slots between 9am-5pm
    const slots = [];
    for (let d = 0; d < 5; d++) {
      const day = new Date(now);
      day.setDate(day.getDate() + d);
      if (day.getDay() === 0 || day.getDay() === 6) continue; // skip weekends

      for (let h = 9; h < 17; h++) {
        const slotStart = new Date(day);
        slotStart.setHours(h, 0, 0, 0);
        const slotEnd = new Date(slotStart);
        slotEnd.setHours(h + 1);

        if (slotStart < now) continue;

        const isBusy = busy.some(b => slotStart < b.end && slotEnd > b.start);
        if (!isBusy) {
          slots.push({
            date: slotStart.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }),
            time: `${h}:00 - ${h + 1}:00`,
            iso: slotStart.toISOString(),
          });
        }
      }
    }

    res.json({ slots: slots.slice(0, 10) });
  } catch (e) {
    console.warn('Calendar availability check failed:', e.message);
    res.json({ slots: [], message: 'Could not check calendar' });
  }
});

// Callback request — visitor wants a call back
app.post('/api/chat/callback', async (req, res) => {
  const { name, phone, ownerEmail, siteName, botName, notes } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required' });
  const alertTo = ownerTo(ownerEmail);

  await smartSend({
    ownerEmail: alertTo,
    to: alertTo,
    subject: `📞 Callback Request: ${name || 'Visitor'} — ${siteName || 'Website'}`,
    html: `<div style="font-family:-apple-system,sans-serif;max-width:500px;margin:0 auto;padding:24px;">
      <h2 style="margin:0 0 16px;color:#1a1a2e">📞 Callback Requested</h2>
      <div style="background:#f8f8fc;border-radius:12px;padding:20px;margin-bottom:16px;">
        <p style="margin:0 0 8px;font-size:14px;"><strong>Name:</strong> ${name || 'Not provided'}</p>
        <p style="margin:0 0 8px;font-size:14px;"><strong>Phone:</strong> <a href="tel:${phone}">${phone}</a></p>
        ${notes ? `<p style="margin:0;font-size:14px;"><strong>Context:</strong> ${notes}</p>` : ''}
      </div>
      <p style="font-size:13px;color:#666;">From ${siteName || 'your website'} chat • ${new Date().toLocaleString('en-GB')}</p>
    </div>`,
  });

  await slack([
    { type: 'header', text: { type: 'plain_text', text: '📞 Callback Request' } },
    { type: 'section', text: { type: 'mrkdwn', text: `*${name || 'Visitor'}* wants a call back\nPhone: ${phone}\nSite: ${siteName || 'Website'}${notes ? '\nContext: ' + notes : ''}` } },
  ], `Callback: ${name || phone}`);

  // Add to Google Calendar
  if (alertTo && gmailTokens.has(alertTo)) {
    createCalendarEvent(alertTo, {
      name: `📞 Callback: ${name || 'Visitor'} — ${phone}`,
      email: '',
      datetime: new Date().toISOString(),
      notes: `Callback requested\nPhone: ${phone}${name ? '\nName: ' + name : ''}${notes ? '\nContext: ' + notes : ''}\nSite: ${siteName || 'website'}`,
      siteName: siteName,
      timezone: 'Europe/London',
    }).catch(() => {});
  }

  res.json({ ok: true });
});

// Quote request — visitor wants a quote
app.post('/api/chat/quote', async (req, res) => {
  const { name, email, phone, details, ownerEmail, siteName, botName } = req.body;
  if (!details) return res.status(400).json({ error: 'Details required' });
  const alertTo = ownerTo(ownerEmail);

  await smartSend({
    ownerEmail: alertTo,
    to: alertTo,
    replyTo: email || undefined,
    subject: `💰 Quote Request: ${name || 'Visitor'} — ${siteName || 'Website'}`,
    html: `<div style="font-family:-apple-system,sans-serif;max-width:500px;margin:0 auto;padding:24px;">
      <h2 style="margin:0 0 16px;color:#1a1a2e">💰 Quote Requested</h2>
      <div style="background:#f8f8fc;border-radius:12px;padding:20px;margin-bottom:16px;">
        <p style="margin:0 0 8px;font-size:14px;"><strong>Name:</strong> ${name || 'Not provided'}</p>
        ${email ? `<p style="margin:0 0 8px;font-size:14px;"><strong>Email:</strong> <a href="mailto:${email}">${email}</a></p>` : ''}
        ${phone ? `<p style="margin:0 0 8px;font-size:14px;"><strong>Phone:</strong> <a href="tel:${phone}">${phone}</a></p>` : ''}
        <p style="margin:0;font-size:14px;"><strong>What they need:</strong></p>
        <p style="margin:4px 0 0;font-size:14px;color:#333;white-space:pre-wrap;">${details}</p>
      </div>
      <p style="font-size:13px;color:#666;">From ${siteName || 'your website'} chat • ${new Date().toLocaleString('en-GB')}</p>
    </div>`,
  });

  // Also save as a lead if email provided
  if (email && !leadStatuses.has(email)) {
    leadStatuses.set(email, { status: 'new', notes: 'Quote request: ' + details.slice(0, 200), updatedAt: new Date(), name, siteName });
    save('leadStatuses', Array.from(leadStatuses.entries()));
  }

  await slack([
    { type: 'header', text: { type: 'plain_text', text: '💰 Quote Request' } },
    { type: 'section', text: { type: 'mrkdwn', text: `*${name || 'Visitor'}*${email ? ' (' + email + ')' : ''}\nSite: ${siteName || 'Website'}\n${details.slice(0, 300)}` } },
  ], `Quote request: ${name || 'Visitor'}`);

  // Add to Google Calendar
  if (alertTo && gmailTokens.has(alertTo)) {
    createCalendarEvent(alertTo, {
      name: `💰 Quote: ${name || 'Visitor'}${email ? ' (' + email + ')' : ''}`,
      email: email || '',
      datetime: new Date().toISOString(),
      notes: `Quote request\n${name ? 'Name: ' + name : ''}${email ? '\nEmail: ' + email : ''}${phone ? '\nPhone: ' + phone : ''}\nDetails: ${details.slice(0, 300)}\nSite: ${siteName || 'website'}`,
      siteName: siteName,
      timezone: 'Europe/London',
    }).catch(() => {});
  }

  res.json({ ok: true });
});

// Chat summary — sent to owner when conversation ends
app.post('/api/chat/summary', async (req, res) => {
  const { messages, ownerEmail, siteName, visitorName, visitorEmail, visitorPhone, page } = req.body;
  if (!messages?.length) return res.json({ ok: true });
  const alertTo = ownerTo(ownerEmail);
  if (!alertTo) return res.json({ ok: true });

  // Only send summary for meaningful conversations (3+ exchanges)
  const botMsgs = messages.filter(m => m.role === 'assistant').length;
  if (botMsgs < 3) return res.json({ ok: true });

  const convoHtml = messages.map(m => {
    const who = m.role === 'user' ? (visitorName || 'Visitor') : 'Aria';
    const bg = m.role === 'user' ? '#e8f4fd' : '#f0f0f0';
    return `<div style="background:${bg};border-radius:8px;padding:10px 14px;margin-bottom:6px;font-size:13px;"><strong>${who}:</strong> ${m.content.slice(0, 500)}</div>`;
  }).join('');

  await smartSend({
    ownerEmail: alertTo,
    to: alertTo,
    subject: `💬 Chat Summary${visitorName ? ': ' + visitorName : ''} — ${siteName || 'Website'}`,
    html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
      <h2 style="margin:0 0 16px;color:#1a1a2e">💬 Chat Conversation</h2>
      ${visitorName || visitorEmail || visitorPhone ? `<div style="background:#f8f8fc;border-radius:12px;padding:16px;margin-bottom:16px;font-size:13px;">
        ${visitorName ? `<strong>Name:</strong> ${visitorName}<br>` : ''}
        ${visitorEmail ? `<strong>Email:</strong> ${visitorEmail}<br>` : ''}
        ${visitorPhone ? `<strong>Phone:</strong> ${visitorPhone}<br>` : ''}
        <strong>Page:</strong> ${page || 'Unknown'}
      </div>` : ''}
      <div style="margin-bottom:16px;">${convoHtml}</div>
      <p style="font-size:12px;color:#999;">From ${siteName || 'your website'} • ${new Date().toLocaleString('en-GB')} • ${messages.length} messages</p>
    </div>`,
  });

  res.json({ ok: true });
});

// Auto lead capture from chat — saves contact info detected in conversation
app.post('/api/chat/auto-lead', async (req, res) => {
  const { name, email, phone, ownerEmail, siteName, page, sessionId } = req.body;
  if (!email && !phone) return res.status(400).json({ error: 'Need email or phone' });
  const alertTo = ownerTo(ownerEmail);
  const key = email || phone;

  if (!leadStatuses.has(key)) {
    leadStatuses.set(key, { status: 'new', notes: 'Auto-captured from chat', updatedAt: new Date(), name, page, siteName });
    save('leadStatuses', Array.from(leadStatuses.entries()));

    await smartSend({
      ownerEmail: alertTo,
      to: alertTo,
      replyTo: email || undefined,
      subject: `🎯 Auto-captured Lead: ${name || email || phone} — ${siteName || 'Website'}`,
      html: `<div style="font-family:-apple-system,sans-serif;max-width:500px;margin:0 auto;padding:24px;">
        <h2 style="margin:0 0 16px;color:#1a1a2e">🎯 Lead Auto-Captured</h2>
        <p style="font-size:14px;color:#666;margin-bottom:16px;">Aria detected contact info during a chat conversation.</p>
        <div style="background:#f8f8fc;border-radius:12px;padding:20px;">
          ${name ? `<p style="margin:0 0 8px;font-size:14px;"><strong>Name:</strong> ${name}</p>` : ''}
          ${email ? `<p style="margin:0 0 8px;font-size:14px;"><strong>Email:</strong> <a href="mailto:${email}">${email}</a></p>` : ''}
          ${phone ? `<p style="margin:0;font-size:14px;"><strong>Phone:</strong> <a href="tel:${phone}">${phone}</a></p>` : ''}
        </div>
        <p style="font-size:13px;color:#666;margin-top:16px;">From ${siteName || 'your website'} • ${page || ''} • ${new Date().toLocaleString('en-GB')}</p>
      </div>`,
    });

    await slack([
      { type: 'header', text: { type: 'plain_text', text: '🎯 Auto-Captured Lead' } },
      { type: 'section', text: { type: 'mrkdwn', text: `*${name || 'Unknown'}*\n${email ? 'Email: ' + email + '\n' : ''}${phone ? 'Phone: ' + phone : ''}\nSite: ${siteName || 'Website'}` } },
    ], `Auto-lead: ${email || phone}`);

    // Add to Google Calendar
    if (alertTo && gmailTokens.has(alertTo)) {
      createCalendarEvent(alertTo, {
        name: `🎯 Lead: ${name || email || phone}`,
        email: email || '',
        datetime: new Date().toISOString(),
        notes: `Auto-captured from chat\n${email ? 'Email: ' + email : ''}${phone ? '\nPhone: ' + phone : ''}\nSite: ${siteName || page || 'website'}`,
        siteName: siteName || page,
        timezone: 'Europe/London',
      }).catch(() => {});
    }
  }

  res.json({ ok: true });
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

// ─── BrandsGateway API ───────────────────────────────────────────────────────
const BG_BASE = 'https://api.brandsgateway.com/api/v1';

async function bgAPI(path, method = 'GET', body = null) {
  const key = process.env.BRANDSGATEWAY_API_KEY;
  if (!key) throw new Error('BrandsGateway not configured');
  const opts = { method, headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${BG_BASE}${path}`, opts);
  return r.json();
}

async function bgSearchProducts(keyword, page = 1) {
  return bgAPI(`/products?search=${encodeURIComponent(keyword)}&page=${page}&per_page=20`);
}

async function bgGetProduct(id) {
  return bgAPI(`/products/${encodeURIComponent(id)}`);
}

async function bgPlaceOrder(orderData) {
  return bgAPI('/orders', 'POST', orderData);
}

async function bgGetOrder(orderId) {
  return bgAPI(`/orders/${encodeURIComponent(orderId)}`);
}

// ─── Printful API ────────────────────────────────────────────────────────────
const PF_BASE = 'https://api.printful.com';

async function pfAPI(path, method = 'GET', body = null) {
  const key = process.env.PRINTFUL_API_KEY;
  if (!key) throw new Error('Printful not configured');
  const opts = { method, headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${PF_BASE}${path}`, opts);
  return r.json();
}

async function pfSearchProducts(keyword) {
  // Printful catalog = their printable product templates
  const data = await pfAPI('/products');
  const all = data.result || [];
  const kw = keyword.toLowerCase();
  return all.filter(p => p.title?.toLowerCase().includes(kw) || p.type_name?.toLowerCase().includes(kw));
}

async function pfGetProduct(id) {
  return pfAPI(`/products/${encodeURIComponent(id)}`);
}

async function pfPlaceOrder(orderData) {
  return pfAPI('/orders', 'POST', orderData);
}

async function pfGetOrder(orderId) {
  return pfAPI(`/orders/${encodeURIComponent(orderId)}`);
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

function verifyMetaSignature(rawBody, signatureHeader) {
  if (!process.env.META_APP_SECRET || !signatureHeader) return false;
  const expected = crypto
    .createHmac('sha256', process.env.META_APP_SECRET)
    .update(rawBody)
    .digest('hex');
  return signatureHeader === `sha256=${expected}`;
}

// Auto-fulfil a Shopify order through CJ
async function autoFulfil(shopifyOrder) {
  const ship = shopifyOrder.shipping_address;
  if (!ship) return { skipped: true, reason: 'No shipping address' };

  // Build line items grouped by supplier
  const supplierItems = { cj: [], brandsgateway: [], printful: [] };
  const unmapped   = [];
  for (const item of shopifyOrder.line_items || []) {
    const mapped = dsProducts.get(String(item.variant_id)) || dsProducts.get(String(item.product_id));
    if (!mapped) { unmapped.push(item.name); continue; }
    const supplier = mapped.supplier || 'cj';
    if (!supplierItems[supplier]) supplierItems[supplier] = [];
    supplierItems[supplier].push({ ...mapped, quantity: item.quantity, name: item.name });
  }

  const allItems = [...supplierItems.cj, ...supplierItems.brandsgateway, ...supplierItems.printful];
  if (!allItems.length) {
    console.log(`Order #${shopifyOrder.order_number}: no mapped products (unmapped: ${unmapped.join(', ')})`);
    return { skipped: true, reason: `Products not in catalogue: ${unmapped.join(', ')}`, unmapped };
  }

  const customerName = `${ship.first_name || ''} ${ship.last_name || ''}`.trim();
  const results = {};

  // ── CJ fulfilment ──
  if (supplierItems.cj.length) {
    try {
      const cjPayload = {
        orderNumber: String(shopifyOrder.order_number),
        shippingZip: ship.zip || '', shippingCountryCode: ship.country_code || '',
        shippingCountry: ship.country || '', shippingProvince: ship.province || '',
        shippingCity: ship.city || '', shippingAddress: ship.address1 || '',
        shippingAddress2: ship.address2 || '',
        shippingCustomerName: customerName,
        shippingPhone: ship.phone || shopifyOrder.phone || '',
        remark: `Shopify #${shopifyOrder.order_number} — auto via Aria`,
        products: supplierItems.cj.map(i => ({ vid: i.cjSku, quantity: i.quantity })),
      };
      const r = await cjPlaceOrder(cjPayload);
      if (!r.result) throw new Error(r.message || 'CJ order failed');
      results.cj = { ok: true, orderId: r.data?.orderId };
    } catch (e) { results.cj = { error: e.message }; }
  }

  // ── BrandsGateway fulfilment ──
  if (supplierItems.brandsgateway.length) {
    try {
      const bgPayload = {
        order_number: String(shopifyOrder.order_number),
        shipping_address: {
          first_name: ship.first_name || '', last_name: ship.last_name || '',
          address1: ship.address1 || '', address2: ship.address2 || '',
          city: ship.city || '', province: ship.province || '',
          zip: ship.zip || '', country_code: ship.country_code || '',
          phone: ship.phone || shopifyOrder.phone || '',
        },
        line_items: supplierItems.brandsgateway.map(i => ({
          product_id: i.supplierProductId, variant_id: i.supplierVariantId, quantity: i.quantity,
        })),
      };
      const r = await bgPlaceOrder(bgPayload);
      if (r.error) throw new Error(r.error?.message || r.message || 'BrandsGateway order failed');
      results.brandsgateway = { ok: true, orderId: r.data?.id || r.id };
    } catch (e) { results.brandsgateway = { error: e.message }; }
  }

  // ── Printful fulfilment ──
  if (supplierItems.printful.length) {
    try {
      const pfPayload = {
        external_id: String(shopifyOrder.order_number),
        recipient: {
          name: customerName, address1: ship.address1 || '', address2: ship.address2 || '',
          city: ship.city || '', state_code: ship.province_code || ship.province || '',
          country_code: ship.country_code || '', zip: ship.zip || '',
          phone: ship.phone || shopifyOrder.phone || '', email: shopifyOrder.email || '',
        },
        items: supplierItems.printful.map(i => ({
          sync_variant_id: parseInt(i.supplierVariantId), quantity: i.quantity,
        })),
      };
      const r = await pfPlaceOrder(pfPayload);
      if (r.error) throw new Error(r.error?.message || 'Printful order failed');
      results.printful = { ok: true, orderId: r.result?.id };
    } catch (e) { results.printful = { error: e.message }; }
  }

  const anyOk = Object.values(results).some(r => r.ok);
  const supplierOrderId = results.cj?.orderId || results.brandsgateway?.orderId || results.printful?.orderId;

  const suppliers = Object.entries(results).filter(([,r]) => r.ok).map(([s]) => s);
  const supplierLabel = suppliers.length ? suppliers.join(' + ').toUpperCase() : 'UNKNOWN';

  try {
    const record = {
      shopifyOrderId:     shopifyOrder.id,
      shopifyOrderNumber: shopifyOrder.order_number,
      cjOrderId:          supplierOrderId,
      suppliers:          results,
      supplier:           suppliers[0] || 'cj',
      status:             anyOk ? 'processing' : 'error',
      customer:           { name: customerName, email: shopifyOrder.email },
      items:              shopifyOrder.line_items?.map(i => i.name),
      unmapped,
      createdAt:          new Date(),
      tracking:           null,
      trackNumber:        null,
    };
    dsOrders.push(record);
    save('dsOrders', dsOrders);
    console.log(`✅ Auto-fulfilled Shopify #${shopifyOrder.order_number} → ${supplierLabel} ${supplierOrderId || ''}`);

    // Notify store owner
    const adminUrl = mintAdminMagicLink(null);
    const alertTo  = process.env.NOTIFY_EMAIL;
    if (alertTo) {
      sendEmail({
        to: alertTo, subject: `📦 Auto-fulfilled: Order #${shopifyOrder.order_number}`,
        html: wrap(`
          <h2 style="margin:0 0 16px;color:#1a1a2e">📦 Order Auto-Fulfilled</h2>
          <p style="font-size:14px;color:#444;margin-bottom:16px">Shopify order <strong>#${shopifyOrder.order_number}</strong> was automatically placed with <strong>${supplierLabel}</strong>.</p>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:6px 0;color:#999;width:120px">Customer</td><td style="font-weight:600">${record.customer.name}</td></tr>
            <tr><td style="padding:6px 0;color:#999">Email</td><td><a href="mailto:${record.customer.email}" style="color:#6C63FF">${record.customer.email}</a></td></tr>
            <tr><td style="padding:6px 0;color:#999">Supplier(s)</td><td style="font-family:monospace">${supplierLabel}</td></tr>
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

// Search supplier catalogue from admin (supports cj, brandsgateway, printful)
app.get('/admin/dropship/search', async (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error:'Unauthorised' });
  const keyword = req.query.q, supplier = req.query.supplier || 'cj';
  if (!keyword) return res.status(400).json({ error:'Missing q' });
  try {
    if (supplier === 'brandsgateway') {
      const r = await bgSearchProducts(keyword);
      const items = r.data || r.products || r || [];
      res.json({ supplier: 'brandsgateway', products: (Array.isArray(items) ? items : []).slice(0, 20).map(p => ({
        pid: String(p.id), title: p.name || p.title, image: p.images?.[0]?.src || p.image,
        category: p.product_type || p.category || '', sellPrice: p.variants?.[0]?.price || p.price || '',
        brand: p.vendor || p.brand || '', variants: p.variants?.length || 0,
      })) });
    } else if (supplier === 'printful') {
      const items = await pfSearchProducts(keyword);
      res.json({ supplier: 'printful', products: items.slice(0, 20).map(p => ({
        pid: String(p.id), title: p.title, image: p.image,
        category: p.type_name || '', sellPrice: '', brand: 'Printful',
        variants: p.variant_count || 0,
      })) });
    } else {
      const r = await cjSearchProducts(keyword);
      if (!r.result) return res.json({ supplier: 'cj', products: [], message: r.message });
      res.json({ supplier: 'cj', products: (r.data?.list || []).map(p => ({
        pid: p.pid, title: p.productNameEn, image: p.productImage,
        category: p.categoryName, sellPrice: p.sellPrice, brand: '',
        variants: p.variants?.length || 0,
      })) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get product variants (any supplier)
app.get('/admin/dropship/product/:pid', async (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error:'Unauthorised' });
  const supplier = req.query.supplier || 'cj';
  try {
    if (supplier === 'brandsgateway') {
      const r = await bgGetProduct(req.params.pid);
      res.json({ product: r.data || r });
    } else if (supplier === 'printful') {
      const r = await pfGetProduct(req.params.pid);
      res.json({ product: r.result || r });
    } else {
      const r = await cjGetProduct(req.params.pid);
      if (!r.result) return res.json({ error: r.message });
      res.json({ product: r.data });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add/update a product mapping (Shopify variant → supplier variant)
app.post('/admin/dropship/map', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error:'Unauthorised' });
  const { shopifyVariantId, cjSku, cjPid, title, costPrice, sellPrice, imageUrl, supplier, supplierProductId, supplierVariantId } = req.body;
  const sku = cjSku || supplierVariantId;
  if (!shopifyVariantId || !sku) return res.status(400).json({ error:'Missing fields' });
  dsProducts.set(String(shopifyVariantId), {
    cjSku: sku, cjPid, title, costPrice, sellPrice, imageUrl,
    supplier: supplier || 'cj', supplierProductId: supplierProductId || cjPid || '',
    supplierVariantId: supplierVariantId || cjSku || sku,
    addedAt: new Date(),
  });
  save('dsProducts', Array.from(dsProducts.entries()));
  res.json({ ok: true, total: dsProducts.size });
});

// Remove a product mapping
app.delete('/admin/dropship/map/:id', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error:'Unauthorised' });
  dsProducts.delete(req.params.id);
  save('dsProducts', Array.from(dsProducts.entries()));
  res.json({ ok: true });
});

// Manually trigger fulfilment (for testing or missed webhooks)
app.post('/admin/dropship/fulfil/:orderId', async (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error:'Unauthorised' });
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
  if (!adminAuth(req)) return res.status(403).json({ error:'Unauthorised' });
  const untracked = dsOrders.filter(o => !o.tracking && o.cjOrderId);
  await Promise.allSettled(untracked.map(pollTracking));
  res.json({ ok: true, polled: untracked.length });
});

// Dropship data for admin
app.get('/admin/dropship/data', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error:'Unauthorised' });
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
      bgConnected: !!process.env.BRANDSGATEWAY_API_KEY,
      pfConnected: !!process.env.PRINTFUL_API_KEY,
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
  const adminUrl  = mintAdminMagicLink(null);
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
    if (!adminAuth(req)) return res.status(403).json({ error:'Unauthorised' });
    h.agentMessages.push({ role:'agent', text, ts:new Date() });
    h.status = 'active';
  } else {
    // User messages stored so admin can see them in the chat panel
    h.userMessages.push({ role:'user', text, ts:new Date() });
  }
  res.json({ ok:true });
});

app.put('/api/handoff/:id/close', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error:'Unauthorised' });
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
// Each gap is now tagged with `slug` so the self-improvement loop can cluster
// per-client (different businesses have different question patterns — a salon
// gets "do you do lash tints?" while a roofer gets "how much for flat roof?").
app.post('/api/gap', (req, res) => {
  const { question, page, url, slug: bodySlug } = req.body;
  if (!question?.trim()) return res.json({ ok:true });
  const slug = String(bodySlug || '').toLowerCase().trim() || deriveSlugFromRequest(req) || 'unknown';
  gaps.unshift({
    id: 'gap_' + crypto.randomBytes(6).toString('hex'),
    slug,
    question: question.trim(),
    page,
    url,
    ts: new Date(),
  });
  if (gaps.length > 300) gaps.length = 300;
  save('gaps', gaps, 2000);
  res.json({ ok:true });
});

// ─── Lead status management ───────────────────────────────────────────────────
app.patch('/admin/lead/:email/status', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error:'Unauthorised' });
  const { status, notes } = req.body;
  const valid = ['new','contacted','converted','lost'];
  if (!valid.includes(status)) return res.status(400).json({ error:'Invalid status' });
  const existing = leadStatuses.get(req.params.email) || {};
  leadStatuses.set(req.params.email, { ...existing, status, notes: notes ?? existing.notes, updatedAt: new Date() });
  save('leadStatuses', Array.from(leadStatuses.entries()));
  res.json({ ok:true });
});

// ─── Funnel Analytics — per-client conversion rollup ────────────────────────
// Reads data/aria_events.jsonl, projects events into a 7/30-day funnel per
// client. JSON for tooling; HTML view at /admin/analytics.
app.get('/admin/analytics', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  _hardenAdminResponse(res);
  const week = rollupForWindow({ windowMs: 7 * 24 * 60 * 60 * 1000 });
  const month = rollupForWindow({ windowMs: 30 * 24 * 60 * 60 * 1000 });
  res.json({
    window7d: week,
    window30d: month,
    generatedAt: new Date().toISOString(),
  });
});

app.get('/admin/analytics/:slug', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  _hardenAdminResponse(res);
  const week = rollupForWindow({ windowMs: 7 * 24 * 60 * 60 * 1000 });
  const row = week.slugs?.[req.params.slug];
  if (!row) return res.status(404).json({ error: 'No events for slug in last 7d' });
  res.json(row);
});

// ─── Client-facing analytics ────────────────────────────────────────────────
// Same data as /admin/analytics/:slug but behind the CLIENT's auth (X-Aria-Token)
// so each owner can see their own funnel without master admin access. Slug is
// derived from the verified token — clients can never see another client's data.
app.get('/api/dashboard/analytics', (req, res) => {
  const token = req.get('X-Aria-Token') || '';
  const slugQuery = String(req.query.slug || '').toLowerCase();
  if (!slugQuery) return res.status(400).json({ error: 'slug query param required' });
  const verified = verifyAdminToken(token, slugQuery);
  if (!verified) return res.status(401).json({ error: 'not authenticated' });
  const week = rollupForWindow({ windowMs: 7 * 24 * 60 * 60 * 1000 });
  const month = rollupForWindow({ windowMs: 30 * 24 * 60 * 60 * 1000 });
  const slug = verified.slug;
  const row7 = week.slugs?.[slug] || { slug, counts: {}, sampleHotLeads: [] };
  const row30 = month.slugs?.[slug] || { slug, counts: {}, sampleHotLeads: [] };
  // Derive headline metrics for the client to read directly.
  const c7 = row7.counts || {}, c30 = row30.counts || {};
  const businessType = (typeof BUSINESS_TYPE_FOR_SLUG !== 'undefined' && BUSINESS_TYPE_FOR_SLUG[slug]) || 'generic';
  const hot7 = c7.lead_hot || 0;
  const warm7 = Math.max(0, (c7.lead_captured || 0) - hot7);
  const value7 = estimateLeadValue(businessType, hot7, warm7);
  const hot30 = c30.lead_hot || 0;
  const warm30 = Math.max(0, (c30.lead_captured || 0) - hot30);
  const value30 = estimateLeadValue(businessType, hot30, warm30);
  res.json({
    slug,
    ownerEmail: verified.email,
    businessType,
    window7d: {
      chats: c7.chat_message || 0,
      widgetLoads: c7.widget_loaded || 0,
      chatOpens: c7.chat_opened || 0,
      leadsCaptured: c7.lead_captured || 0,
      hotLeads: hot7,
      bookings: c7.booking_created || 0,
      ownerNotified: c7.owner_notified || 0,
      afterHours: c7.after_hours || 0,
      estimatedValueGbp: value7,
      sampleHotLeads: (row7.sampleHotLeads || []).slice(0, 5),
      firstEventTs: row7.firstEventTs || null,
      lastEventTs: row7.lastEventTs || null,
    },
    window30d: {
      chats: c30.chat_message || 0,
      leadsCaptured: c30.lead_captured || 0,
      hotLeads: hot30,
      bookings: c30.booking_created || 0,
      estimatedValueGbp: value30,
    },
    generatedAt: new Date().toISOString(),
  });
});

// HTML page for the client-facing analytics dashboard. Auth is handled
// client-side via the existing X-Aria-Token flow. The page redirects to
// /auth/admin/start on first visit and stores the token in sessionStorage.
// All dynamic values are written via textContent or safe DOM APIs to avoid XSS.
app.get('/dashboard/analytics', (req, res) => {
  const slug = String(req.query.slug || '').toLowerCase();
  if (!slug) {
    return res.status(400).send('Missing slug. Add ?slug=your_business to the URL.');
  }
  if (!owners.has(slug)) {
    return res.status(404).send('Unknown client slug. Ask Kyle to add you to owners.json.');
  }
  const SERVER = `${req.protocol}://${req.get('host')}`;
  // slug is owner-validated above; safe to embed as JSON literal.
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aria dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         background: #0d0d1f; color: #eeeef8; min-height: 100vh; line-height: 1.5; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 40px 24px; }
  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 32px;
           padding-bottom: 16px; border-bottom: 1px solid #2a2a44; }
  h1 { font-size: 24px; font-weight: 700; letter-spacing: -0.02em; }
  h1 .badge { display: inline-block; padding: 3px 10px; margin-left: 8px;
              background: #22D3E033; color: #22D3E0; border-radius: 999px;
              font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .who { font-size: 13px; color: #9898b8; }
  .who-email { color: #22D3E0; text-decoration: none; cursor: pointer; }
  .hero { background: linear-gradient(135deg, #1a1a2e 0%, #1f1f3b 100%);
          border: 1px solid #2a2a44; border-radius: 16px; padding: 32px;
          margin-bottom: 24px; text-align: center; }
  .hero .label { font-size: 12px; font-weight: 600; color: #9898b8;
                 text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 8px; }
  .hero .value { font-size: 56px; font-weight: 800; color: #00E5A0; letter-spacing: -0.04em;
                 line-height: 1; margin-bottom: 8px; }
  .hero .sub { font-size: 14px; color: #9898b8; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 14px; margin-bottom: 32px; }
  .stat { background: #1a1a2e; border: 1px solid #2a2a44; border-radius: 12px;
          padding: 18px 20px; }
  .stat .num { font-size: 32px; font-weight: 800; color: #eeeef8; letter-spacing: -0.02em; }
  .stat .lbl { font-size: 12px; color: #9898b8; margin-top: 4px;
               text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
  .section { margin-bottom: 32px; }
  .section h2 { font-size: 16px; font-weight: 700; margin-bottom: 12px;
                color: #eeeef8; letter-spacing: -0.01em; }
  .empty { background: #1a1a2e; border: 1px dashed #2a2a44; border-radius: 12px;
           padding: 28px; text-align: center; color: #9898b8; font-size: 14px; }
  .empty .icon { font-size: 32px; margin-bottom: 8px; opacity: 0.5; }
  .session-row { background: #1a1a2e; border: 1px solid #2a2a44; border-radius: 10px;
                 padding: 14px 18px; margin-bottom: 8px; display: flex; justify-content: space-between;
                 align-items: center; gap: 12px; }
  .session-out { font-size: 13px; color: #eeeef8; font-weight: 600; }
  .session-meta { font-size: 11px; color: #6b6b8a; margin-top: 2px; }
  .session-id { font-size: 11px; color: #6b6b8a; font-family: ui-monospace, "SF Mono", monospace; }
  .footer-note { margin-top: 40px; padding-top: 20px; border-top: 1px solid #2a2a44;
                 font-size: 12px; color: #6b6b8a; text-align: center; }
  .footer-note a { color: #22D3E0; text-decoration: none; }
  .loading { display: inline-block; padding: 4px 12px; background: #1a1a2e;
             border-radius: 999px; font-size: 12px; color: #9898b8; }
  .err { padding: 16px; background: #2a1a1a; border: 1px solid #5a2a2a;
         border-radius: 8px; color: #ff9090; font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Aria <span class="badge" id="slug-badge"></span></h1>
    <div class="who" id="who"><span class="loading">Signing in…</span></div>
  </header>

  <div id="content" style="display:none;">
    <div class="hero">
      <div class="label">Estimated value Aria delivered this week</div>
      <div class="value" id="hero-value">£0</div>
      <div class="sub" id="hero-sub">No activity yet. Aria will start counting as soon as visitors chat with her.</div>
    </div>

    <div class="grid">
      <div class="stat"><div class="num" id="s-chats">0</div><div class="lbl">Conversations (7d)</div></div>
      <div class="stat"><div class="num" id="s-leads">0</div><div class="lbl">Leads captured</div></div>
      <div class="stat"><div class="num" id="s-hot">0</div><div class="lbl">Hot leads</div></div>
      <div class="stat"><div class="num" id="s-bookings">0</div><div class="lbl">Bookings</div></div>
      <div class="stat"><div class="num" id="s-notified">0</div><div class="lbl">Pings sent to you</div></div>
      <div class="stat"><div class="num" id="s-afterhours">0</div><div class="lbl">After-hours chats</div></div>
    </div>

    <div class="section">
      <h2>30-day rollup</h2>
      <div class="grid">
        <div class="stat"><div class="num" id="m-chats">0</div><div class="lbl">Conversations</div></div>
        <div class="stat"><div class="num" id="m-leads">0</div><div class="lbl">Leads</div></div>
        <div class="stat"><div class="num" id="m-bookings">0</div><div class="lbl">Bookings</div></div>
        <div class="stat"><div class="num" id="m-value">£0</div><div class="lbl">Estimated value</div></div>
      </div>
    </div>

    <div class="section">
      <h2>Recent visitors</h2>
      <div id="sessions-mount"><div class="empty">Loading recent conversations…</div></div>
    </div>

    <div class="footer-note">
      Data refreshes on page load. Questions? Email
      <a href="mailto:apcapital.ai@gmail.com">apcapital.ai@gmail.com</a>
    </div>
  </div>

  <div id="error" style="display:none;"></div>
</div>

<script>
(function() {
  const SLUG = ${JSON.stringify(slug)};
  const SERVER = ${JSON.stringify(SERVER)};
  const TOKEN_KEY = 'aria_token_' + SLUG;

  // Slug badge — set safely via textContent
  document.getElementById('slug-badge').textContent = SLUG;

  // Pick up token from URL hash if returning from OAuth
  if (location.hash.startsWith('#aria_token=')) {
    const t = location.hash.slice('#aria_token='.length);
    sessionStorage.setItem(TOKEN_KEY, t);
    history.replaceState(null, '', location.pathname + location.search);
  }

  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token) {
    const returnTo = encodeURIComponent(SERVER + '/dashboard/analytics?slug=' + SLUG);
    location.href = SERVER + '/auth/admin/start?slug=' + SLUG + '&return_to=' + returnTo;
    return;
  }

  const headers = { 'X-Aria-Token': token };

  function setWhoSignedIn(email) {
    const whoEl = document.getElementById('who');
    whoEl.replaceChildren();
    whoEl.appendChild(document.createTextNode('Signed in as '));
    const link = document.createElement('a');
    link.className = 'who-email';
    link.href = '#';
    link.textContent = email;
    link.addEventListener('click', (ev) => {
      ev.preventDefault();
      sessionStorage.removeItem(TOKEN_KEY);
      location.reload();
    });
    whoEl.appendChild(link);
  }

  function showError(msg) {
    const errEl = document.getElementById('error');
    errEl.replaceChildren();
    const box = document.createElement('div');
    box.className = 'err';
    box.textContent = msg;
    errEl.appendChild(box);
    errEl.style.display = 'block';
  }

  async function load() {
    try {
      const whoR = await fetch(SERVER + '/auth/admin/whoami?slug=' + SLUG, { headers });
      if (whoR.status === 401) {
        sessionStorage.removeItem(TOKEN_KEY);
        location.reload();
        return;
      }
      const who = await whoR.json();
      setWhoSignedIn(who.email || 'unknown');

      const aR = await fetch(SERVER + '/api/dashboard/analytics?slug=' + SLUG, { headers });
      if (!aR.ok) throw new Error('Analytics fetch failed (' + aR.status + ')');
      const a = await aR.json();
      document.getElementById('content').style.display = 'block';
      const w = a.window7d || {}, m = a.window30d || {};
      const fmt = (n) => '£' + (n || 0).toLocaleString('en-GB');
      document.getElementById('hero-value').textContent = fmt(w.estimatedValueGbp);
      if ((w.chats || 0) > 0) {
        const chatsTxt = w.chats + ' conversation' + (w.chats === 1 ? '' : 's');
        const hotTxt = w.hotLeads + ' hot lead' + (w.hotLeads === 1 ? '' : 's');
        document.getElementById('hero-sub').textContent =
          'Across ' + chatsTxt + ', ' + hotTxt + ' captured. Estimate uses ' + a.businessType + ' rate.';
      }
      document.getElementById('s-chats').textContent = w.chats || 0;
      document.getElementById('s-leads').textContent = w.leadsCaptured || 0;
      document.getElementById('s-hot').textContent = w.hotLeads || 0;
      document.getElementById('s-bookings').textContent = w.bookings || 0;
      document.getElementById('s-notified').textContent = w.ownerNotified || 0;
      document.getElementById('s-afterhours').textContent = w.afterHours || 0;
      document.getElementById('m-chats').textContent = m.chats || 0;
      document.getElementById('m-leads').textContent = m.leadsCaptured || 0;
      document.getElementById('m-bookings').textContent = m.bookings || 0;
      document.getElementById('m-value').textContent = fmt(m.estimatedValueGbp);

      // Sessions list — Stage 3 endpoint, best effort
      try {
        const sR = await fetch(SERVER + '/api/dashboard/sessions?slug=' + SLUG, { headers });
        if (sR.ok) {
          const s = await sR.json();
          renderSessions(s.sessions || []);
        } else {
          renderSessions([]);
        }
      } catch (e) {
        renderSessions([]);
      }
    } catch (e) {
      showError(e.message || 'Failed to load dashboard');
    }
  }

  function renderSessions(sessions) {
    const mount = document.getElementById('sessions-mount');
    mount.replaceChildren();
    if (!sessions || !sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No visitor conversations yet. Aria starts counting when someone chats.';
      mount.appendChild(empty);
      return;
    }
    sessions.slice(0, 20).forEach(s => {
      const t = s.startedAt ? new Date(s.startedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '';
      const outcomeText = s.bookingCreated ? 'Booked'
                        : s.leadHot ? 'Hot lead'
                        : s.leadCaptured ? 'Lead captured'
                        : s.afterHours ? 'After-hours'
                        : 'Chat only';
      const msgCount = (s.messages || 0);
      const msgTxt = msgCount + ' message' + (msgCount === 1 ? '' : 's');

      const row = document.createElement('div');
      row.className = 'session-row';
      const left = document.createElement('div');
      const out = document.createElement('div');
      out.className = 'session-out';
      out.textContent = outcomeText;
      const meta = document.createElement('div');
      meta.className = 'session-meta';
      meta.textContent = msgTxt + (t ? ' · ' + t : '');
      left.appendChild(out);
      left.appendChild(meta);
      const idEl = document.createElement('div');
      idEl.className = 'session-id';
      idEl.textContent = (s.sessionId || '').slice(0, 8);
      row.appendChild(left);
      row.appendChild(idEl);
      mount.appendChild(row);
    });
  }

  load();
})();
</script>
</body>
</html>`);
});

// ─── Per-visitor sessions (drill-down) ──────────────────────────────────────
// Returns one row per visitor session in the last 7 days, with derived outcome
// flags (booked / hot lead / captured / abandoned). Powers the "Recent visitors"
// section of the client dashboard + Kyle's master per-client visitor view.

// Client-facing — auth scoped to slug derived from X-Aria-Token.
app.get('/api/dashboard/sessions', (req, res) => {
  const token = req.get('X-Aria-Token') || '';
  const slugQuery = String(req.query.slug || '').toLowerCase();
  if (!slugQuery) return res.status(400).json({ error: 'slug query param required' });
  const verified = verifyAdminToken(token, slugQuery);
  if (!verified) return res.status(401).json({ error: 'not authenticated' });
  const windowDays = Math.max(1, Math.min(90, Number(req.query.days) || 7));
  const result = sessionsForSlugWindow({
    slug: verified.slug,
    windowMs: windowDays * 24 * 60 * 60 * 1000,
  });
  res.json(result);
});

// Master-admin — Kyle can drill into any slug from his admin dashboard.
app.get('/admin/sessions/:slug', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  _hardenAdminResponse(res);
  const windowDays = Math.max(1, Math.min(90, Number(req.query.days) || 7));
  const result = sessionsForSlugWindow({
    slug: String(req.params.slug || '').toLowerCase(),
    windowMs: windowDays * 24 * 60 * 60 * 1000,
  });
  res.json(result);
});

// ─── Slug auto-detection from request origin ────────────────────────────────
// When a chat widget POSTs to /api/chat without an explicit clientConfig.slug
// (the common case for embeds installed before we added the analytics layer),
// derive a stable slug from the Origin or Referer host. Maps known hosts to
// their canonical slugs; falls back to host-hyphenated form otherwise.
//
// Example: https://ejroofing.co.uk/ → "ejroofing-co-uk"
//          https://www.dolledbylouise.co.uk/about → "dolledbylouise-co-uk"
//
// This means embeds that forgot data-slug still get attributed per site,
// which fixes the ~97% of chats currently orphaned to slug:"unknown".
const HOST_SLUG_OVERRIDES = {
  // Map known hosts to their canonical jarvis-registry slug for cross-system
  // consistency. Hosts not listed fall back to auto-hyphenation.
  'ejroofing.co.uk':         'ej_roofing',
  'howhighscaffolding.co.uk': 'howhighscaffolding',
  'dolledbylouise.co.uk':    'dolled_by_louise',
  'theskinden.co.uk':        'the_skin_den',
};
function deriveSlugFromRequest(req) {
  if (!req) return null;
  const raw = req.get('Origin') || req.get('Referer') || '';
  if (!raw) return null;
  let host = '';
  try { host = new URL(raw).hostname; } catch { return null; }
  if (!host) return null;
  host = host.toLowerCase().replace(/^www\./, '');
  if (HOST_SLUG_OVERRIDES[host]) return HOST_SLUG_OVERRIDES[host];
  // Reject obvious non-client hosts to avoid polluting analytics with
  // localhost, Railway preview, or aria.html (the marketing page itself).
  if (host === 'localhost' || host.endsWith('.up.railway.app') || host === 'aireyai.co.uk') return null;
  // Generic fallback: ejroofing.co.uk → ejroofing-co-uk
  return host.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || null;
}

// ─── Self-improvement loop ──────────────────────────────────────────────────
// Cluster recent gaps for one slug by token-overlap similarity, surface
// clusters of 3+ as "learning proposals" awaiting owner approval. We
// deliberately stay simple (no embedding model, no Claude call) — Jaccard
// on stemmed tokens catches obvious duplicates ("do you do lash extensions"
// vs "can I book lash extensions") without an external dependency.

// Strip stop-words + punctuation + lowercase. Returns a Set of significant
// tokens for similarity comparison.
const _STOPWORDS = new Set([
  'a','an','and','are','as','at','be','by','do','does','for','from','have',
  'i','if','in','is','it','my','of','on','or','the','to','was','we','what',
  'will','with','you','your','about','can','could','would','should','how',
  'when','where','who','why','this','that','there','any','some','me','our',
]);
// Very light stemmer — collapses "weddings"/"wedding", "prices"/"price",
// "extensions"/"extension" to the same token. Avoids breaking "pass"/"boss"
// by only stripping when length > 4 and the token doesn't end in "ss".
function _stem(w) {
  if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
function _gapTokens(text) {
  return new Set(
    String(text || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !_STOPWORDS.has(w))
      .map(_stem)
  );
}

// Jaccard similarity: |intersection| / |union|. 0..1, threshold ~0.5 for
// "same question" on short trade questions. Tuned conservatively to avoid
// false-positive clustering of "do you do roofs" with "do you do extensions".
function _gapSimilarity(a, b) {
  const inter = [...a].filter(t => b.has(t)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

const LEARNING_CLUSTER_MIN = 3;             // Fork 1 (A): need 3+ gaps to propose
const LEARNING_CLUSTER_THRESHOLD = 0.5;     // Jaccard threshold (lower = more lenient)
const LEARNING_WINDOW_DAYS = 30;            // only consider recent-ish gaps

// Recompute clusters for one slug and create learning proposals for any
// cluster of 3+ similar gaps that doesn't already have a pending proposal.
// Returns the count of new proposals created.
function refreshLearningProposalsForSlug(slug) {
  if (!slug || slug === 'unknown') return 0;
  const cutoff = Date.now() - LEARNING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recent = gaps.filter(g => g.slug === slug && new Date(g.ts).getTime() >= cutoff);
  if (recent.length < LEARNING_CLUSTER_MIN) return 0;

  // Track which gaps are already covered by an existing pending/approved proposal
  const usedGapIds = new Set();
  for (const p of learningProposals.values()) {
    if (p.slug !== slug) continue;
    if (p.status === 'rejected') continue;
    for (const v of (p.variantIds || [])) usedGapIds.add(v);
  }

  // Greedy clustering — for each unclustered gap, find similar ones, group together
  const tokens = recent.map(g => ({ gap: g, tk: _gapTokens(g.question) }));
  const clusters = [];
  const claimed = new Set();
  for (let i = 0; i < tokens.length; i++) {
    if (claimed.has(i) || usedGapIds.has(tokens[i].gap.id)) continue;
    const cluster = [tokens[i]];
    claimed.add(i);
    for (let j = i + 1; j < tokens.length; j++) {
      if (claimed.has(j) || usedGapIds.has(tokens[j].gap.id)) continue;
      if (_gapSimilarity(tokens[i].tk, tokens[j].tk) >= LEARNING_CLUSTER_THRESHOLD) {
        cluster.push(tokens[j]);
        claimed.add(j);
      }
    }
    if (cluster.length >= LEARNING_CLUSTER_MIN) clusters.push(cluster);
  }

  let created = 0;
  for (const cluster of clusters) {
    // Pick the most recent gap's question as the canonical phrasing — usually
    // the freshest expression of the pattern.
    const sorted = [...cluster].sort((a, b) =>
      new Date(b.gap.ts).getTime() - new Date(a.gap.ts).getTime()
    );
    const proposal = {
      id: 'lp_' + crypto.randomBytes(8).toString('hex'),
      slug,
      question: sorted[0].gap.question,
      variants: cluster.map(c => c.gap.question),
      variantIds: cluster.map(c => c.gap.id).filter(Boolean),
      evidenceCount: cluster.length,
      suggestedAnswer: '',                  // owner fills this in on approval
      status: 'pending',
      createdAt: new Date().toISOString(),
      decidedAt: null,
    };
    learningProposals.set(proposal.id, proposal);
    created++;
  }
  if (created > 0) {
    save('learningProposals', [...learningProposals.values()], 1000);
    console.log(`🧠 Learning proposals: ${created} new for slug=${slug}`);
  }
  return created;
}

// Run clustering for every slug that has had gaps recently. Called by the
// weekly cron right before the digest goes out.
function refreshAllLearningProposals() {
  const slugSet = new Set(gaps.map(g => g.slug).filter(s => s && s !== 'unknown'));
  let total = 0;
  for (const slug of slugSet) total += refreshLearningProposalsForSlug(slug);
  return total;
}

// Master-admin endpoint: list all pending proposals across slugs. Kyle's
// at-a-glance "what does Aria want to learn?" view.
app.get('/api/admin/learning', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  _hardenAdminResponse(res);
  const all = [...learningProposals.values()];
  const pending = all.filter(p => p.status === 'pending').sort((a, b) =>
    b.evidenceCount - a.evidenceCount || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  res.json({
    pending,
    countsByStatus: {
      pending: all.filter(p => p.status === 'pending').length,
      approved: all.filter(p => p.status === 'approved').length,
      rejected: all.filter(p => p.status === 'rejected').length,
    },
  });
});

// Trigger clustering manually (testing). Body: { slug?: string }
app.post('/api/admin/learning/refresh', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  _hardenAdminResponse(res);
  const { slug } = req.body || {};
  const created = slug ? refreshLearningProposalsForSlug(slug) : refreshAllLearningProposals();
  res.json({ ok: true, created });
});

// Approve a proposal: writes a regular FAQ entry with the owner-supplied
// answer, marks proposal approved. Aria will use the new FAQ on next chat.
app.post('/api/admin/learning/:id/approve', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  _hardenAdminResponse(res);
  const { answer } = req.body || {};
  const proposal = learningProposals.get(req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
  if (proposal.status !== 'pending') return res.status(400).json({ error: `Already ${proposal.status}` });
  if (!answer?.trim()) return res.status(400).json({ error: 'answer required' });

  // Promote to FAQ. Reuse the existing faqs Map shape so Aria's chat
  // handler picks it up without further changes.
  const faqId = 'faq_' + crypto.randomBytes(6).toString('hex');
  faqs.set(faqId, {
    id: faqId,
    slug: proposal.slug,
    question: proposal.question,
    answer: answer.trim(),
    approved: true,
    hits: 0,
    ts: new Date(),
    source: 'learning_proposal',
    proposalId: proposal.id,
  });
  proposal.status = 'approved';
  proposal.decidedAt = new Date().toISOString();
  proposal.suggestedAnswer = answer.trim();
  proposal.faqId = faqId;
  save('faqs', [...faqs.values()], 1000);
  save('learningProposals', [...learningProposals.values()], 1000);
  console.log(`✅ Learning proposal approved: ${proposal.id} → faq ${faqId} (slug=${proposal.slug})`);
  res.json({ ok: true, faqId });
});

// Reject a proposal: marks it dismissed, the underlying gaps stay in the
// raw gaps array but won't be re-clustered into a new proposal.
app.post('/api/admin/learning/:id/reject', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  _hardenAdminResponse(res);
  const proposal = learningProposals.get(req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
  if (proposal.status !== 'pending') return res.status(400).json({ error: `Already ${proposal.status}` });
  proposal.status = 'rejected';
  proposal.decidedAt = new Date().toISOString();
  save('learningProposals', [...learningProposals.values()], 1000);
  res.json({ ok: true });
});

// ─── Onboarding emails ──────────────────────────────────────────────────────
// Two triggers: welcome email when a new owner is added, first-chat milestone
// when Aria handles her first conversation on a client site. Both file-backed
// for idempotency across server restarts.

const FIRST_CHAT_LOG = resolve('data', 'first_chat_milestones.jsonl');
const _firedFirstChats = new Set();

(function _loadFirstChatLog() {
  try {
    if (!existsSync(FIRST_CHAT_LOG)) return;
    const raw = readFileSync(FIRST_CHAT_LOG, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e.slug) _firedFirstChats.add(e.slug);
      } catch { /* skip malformed */ }
    }
    console.log(`📨 First-chat milestones loaded: ${_firedFirstChats.size} slug(s)`);
  } catch (e) { console.warn('Failed to load first-chat log:', e.message); }
})();

async function maybeFireFirstChatMilestone({ slug, ownerEmail, serverUrl }) {
  if (!slug || !ownerEmail) return;
  if (_firedFirstChats.has(slug)) return;
  _firedFirstChats.add(slug);
  try {
    const dashboardUrl = `${serverUrl || ''}/dashboard/analytics?slug=${encodeURIComponent(slug)}`;
    const friendlyName = slug.replace(/[_-]/g, ' ');
    const html = `<div style="font-family:-apple-system,sans-serif;color:#1a1a2e;max-width:560px;margin:0 auto;padding:30px 20px;">
      <h2 style="margin:0 0 12px;color:#22D3E0;">Aria just handled her first chat</h2>
      <p style="font-size:15px;line-height:1.55;color:#444;">She's officially live on your site. Someone messaged your business through the widget and Aria responded.</p>
      <p style="font-size:15px;line-height:1.55;color:#444;">Want to see what she said and start tracking your numbers?</p>
      <p style="margin:24px 0;"><a href="${dashboardUrl}" style="display:inline-block;background:#22D3E0;color:#0d0d1f;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;">Open your dashboard →</a></p>
      <p style="font-size:13px;color:#666;margin-top:30px;">From now on Aria's working for you 24/7. You'll get a weekly summary every Monday with leads and bookings.</p>
      <p style="font-size:13px;color:#666;">— Kyle</p>
    </div>`;
    await smartSend({
      ownerEmail,
      to: ownerEmail,
      subject: `Aria just answered her first message on ${friendlyName}`,
      html,
      replyTo: process.env.NOTIFY_EMAIL,
    });
    await fsp.appendFile(FIRST_CHAT_LOG, JSON.stringify({
      slug, ownerEmail, ts: new Date().toISOString(),
    }) + '\n');
    console.log(`🎉 First-chat milestone sent: ${slug} -> ${ownerEmail}`);
  } catch (e) {
    _firedFirstChats.delete(slug);
    console.warn(`[onboarding] first-chat milestone failed for ${slug}:`, e.message);
  }
}

async function sendOwnerWelcomeEmail({ slug, ownerEmail, serverUrl }) {
  if (!ownerEmail) return;
  try {
    const dashboardUrl = `${serverUrl || ''}/dashboard/analytics?slug=${encodeURIComponent(slug)}`;
    const friendlyName = slug.replace(/[_-]/g, ' ');
    const html = `<div style="font-family:-apple-system,sans-serif;color:#1a1a2e;max-width:560px;margin:0 auto;padding:30px 20px;">
      <h2 style="margin:0 0 14px;">Welcome — Aria's set up for you</h2>
      <p style="font-size:15px;line-height:1.55;color:#444;">Hi! Kyle here. I've just provisioned Aria, your 24/7 AI receptionist, for <b>${friendlyName}</b>.</p>
      <p style="font-size:15px;line-height:1.55;color:#444;">She's already wired in. Here's what happens next:</p>
      <ul style="font-size:14px;color:#444;line-height:1.7;padding-left:20px;">
        <li>Aria starts answering visitor questions on your site</li>
        <li>When someone leaves their details, she texts or emails you straight away</li>
        <li>Every Monday morning you get a "this is what Aria did for you" summary</li>
      </ul>
      <p style="margin:24px 0;"><a href="${dashboardUrl}" style="display:inline-block;background:#22D3E0;color:#0d0d1f;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;">Open your dashboard →</a></p>
      <p style="font-size:13px;color:#666;margin-top:30px;">Hit reply if you want to change anything — her tone, what she asks, what counts as a hot lead. — Kyle</p>
    </div>`;
    await smartSend({
      ownerEmail,
      to: ownerEmail,
      subject: `Aria is live on your site (${friendlyName})`,
      html,
      replyTo: process.env.NOTIFY_EMAIL,
    });
    console.log(`📨 Welcome email sent: ${slug} -> ${ownerEmail}`);
  } catch (e) {
    console.warn(`[onboarding] welcome email failed for ${slug}:`, e.message);
  }
}

// HTML view of pending learning proposals for Kyle (master admin only).
// Each proposal shows the canonical question, evidence count, sample
// visitor variants, and a textarea for the answer. Approve writes it
// to faqs immediately; Reject dismisses it permanently. All dynamic
// content rendered via DOM APIs (no innerHTML splicing) per the
// security review hook.
app.get('/admin/learning', (req, res) => {
  _hardenAdminResponse(res);
  if (!adminAuth(req)) return res.redirect('/admin');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aria — Learning Proposals</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         background: #0d0d1f; color: #eeeef8; min-height: 100vh; line-height: 1.5; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 32px 24px; }
  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px;
           padding-bottom: 16px; border-bottom: 1px solid #2a2a44; }
  h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
  .back { font-size: 13px; color: #22D3E0; text-decoration: none; }
  .empty { background: #1a1a2e; border: 1px dashed #2a2a44; border-radius: 12px;
           padding: 36px; text-align: center; color: #9898b8; font-size: 14px; }
  .proposal { background: #1a1a2e; border: 1px solid #2a2a44; border-radius: 12px;
              padding: 22px; margin-bottom: 16px; }
  .p-head { display: flex; align-items: center; justify-content: space-between;
            margin-bottom: 12px; gap: 12px; flex-wrap: wrap; }
  .p-slug { display: inline-block; padding: 3px 10px; background: #22D3E033;
            color: #22D3E0; border-radius: 999px; font-size: 11px;
            font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .p-count { font-size: 12px; color: #9898b8; }
  .p-q { font-size: 16px; color: #eeeef8; font-weight: 600; margin-bottom: 8px; }
  .p-variants { font-size: 12px; color: #9898b8; margin-bottom: 14px;
                background: #13131f; border-radius: 8px; padding: 10px 12px;
                border-left: 2px solid #2a2a44; }
  .p-variants summary { cursor: pointer; outline: none; }
  .p-variants ul { margin-top: 8px; padding-left: 18px; }
  .p-variants li { margin: 4px 0; }
  textarea.answer { width: 100%; min-height: 80px; padding: 10px 12px;
                    background: #13131f; border: 1.5px solid #2a2a44;
                    color: #eeeef8; border-radius: 8px; font-size: 14px;
                    font-family: inherit; outline: none; resize: vertical;
                    margin-bottom: 12px; }
  textarea.answer:focus { border-color: #22D3E0; }
  .actions { display: flex; gap: 8px; }
  button { padding: 9px 18px; border-radius: 8px; border: none; cursor: pointer;
           font-size: 13px; font-weight: 600; font-family: inherit; transition: opacity .15s; }
  button:hover { opacity: 0.9; }
  .btn-approve { background: #00e5a0; color: #0d0d1f; }
  .btn-reject { background: transparent; border: 1px solid #2a2a44; color: #c0c0e0; }
  .feedback { margin-left: 12px; font-size: 12px; align-self: center; }
  .feedback.ok { color: #00e5a0; }
  .feedback.err { color: #ff6b6b; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Aria — Learning Proposals</h1>
    <a class="back" href="/admin">← back to admin</a>
  </header>
  <p style="font-size:13px;color:#9898b8;margin-bottom:24px;">Questions visitors have asked that Aria couldn't answer. Write an answer + approve to teach her permanently. 3+ similar visitor questions trigger a proposal.</p>
  <div id="mount"><div class="empty">Loading proposals…</div></div>
</div>
<script>
(function() {
  const mount = document.getElementById('mount');

  function showEmpty(text) {
    mount.replaceChildren();
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = text;
    mount.appendChild(e);
  }

  function makeProposal(p) {
    const wrap = document.createElement('div');
    wrap.className = 'proposal';
    wrap.dataset.id = p.id;

    const head = document.createElement('div');
    head.className = 'p-head';
    const left = document.createElement('div');
    const slug = document.createElement('span');
    slug.className = 'p-slug';
    slug.textContent = p.slug || 'unknown';
    left.appendChild(slug);
    const count = document.createElement('span');
    count.className = 'p-count';
    count.style.marginLeft = '10px';
    count.textContent = (p.evidenceCount || 1) + ' visitor' + (p.evidenceCount === 1 ? '' : 's') + ' asked';
    left.appendChild(count);
    head.appendChild(left);
    wrap.appendChild(head);

    const q = document.createElement('div');
    q.className = 'p-q';
    q.textContent = '"' + (p.question || '') + '"';
    wrap.appendChild(q);

    if (p.variants && p.variants.length > 1) {
      const det = document.createElement('details');
      det.className = 'p-variants';
      const sum = document.createElement('summary');
      sum.textContent = 'View all ' + p.variants.length + ' visitor phrasings';
      det.appendChild(sum);
      const ul = document.createElement('ul');
      for (const v of p.variants) {
        const li = document.createElement('li');
        li.textContent = v;
        ul.appendChild(li);
      }
      det.appendChild(ul);
      wrap.appendChild(det);
    }

    const ta = document.createElement('textarea');
    ta.className = 'answer';
    ta.placeholder = "Teach Aria how to answer this. She'll use this verbatim with future visitors.";
    wrap.appendChild(ta);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const approve = document.createElement('button');
    approve.className = 'btn-approve';
    approve.textContent = 'Approve & teach Aria';
    const reject = document.createElement('button');
    reject.className = 'btn-reject';
    reject.textContent = 'Dismiss';
    const fb = document.createElement('span');
    fb.className = 'feedback';
    actions.appendChild(approve);
    actions.appendChild(reject);
    actions.appendChild(fb);
    wrap.appendChild(actions);

    approve.addEventListener('click', async () => {
      const answer = ta.value.trim();
      if (!answer) { fb.className = 'feedback err'; fb.textContent = 'Write an answer first'; return; }
      approve.disabled = true; reject.disabled = true;
      fb.className = 'feedback'; fb.textContent = 'Saving…';
      try {
        const r = await fetch('/api/admin/learning/' + encodeURIComponent(p.id) + '/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ answer }),
        });
        if (r.ok) {
          fb.className = 'feedback ok';
          fb.textContent = 'Approved — Aria will use this now';
          setTimeout(() => wrap.remove(), 1200);
        } else {
          const j = await r.json().catch(() => ({}));
          fb.className = 'feedback err';
          fb.textContent = j.error || 'Save failed';
          approve.disabled = false; reject.disabled = false;
        }
      } catch (e) {
        fb.className = 'feedback err';
        fb.textContent = 'Network error';
        approve.disabled = false; reject.disabled = false;
      }
    });

    reject.addEventListener('click', async () => {
      approve.disabled = true; reject.disabled = true;
      fb.className = 'feedback'; fb.textContent = 'Dismissing…';
      try {
        const r = await fetch('/api/admin/learning/' + encodeURIComponent(p.id) + '/reject', {
          method: 'POST', credentials: 'same-origin',
        });
        if (r.ok) { wrap.remove(); }
        else { fb.className = 'feedback err'; fb.textContent = 'Dismiss failed';
               approve.disabled = false; reject.disabled = false; }
      } catch (e) {
        fb.className = 'feedback err'; fb.textContent = 'Network error';
        approve.disabled = false; reject.disabled = false;
      }
    });

    return wrap;
  }

  async function load() {
    try {
      const r = await fetch('/api/admin/learning', { credentials: 'same-origin' });
      if (r.status === 403) { location.href = '/admin'; return; }
      const data = await r.json();
      const items = data.pending || [];
      if (!items.length) {
        showEmpty('No pending proposals. Aria proposes new FAQs after 3+ visitors ask the same unanswered question. Check back next week.');
        return;
      }
      mount.replaceChildren();
      for (const p of items) mount.appendChild(makeProposal(p));
    } catch (e) {
      showEmpty('Failed to load proposals: ' + (e.message || 'unknown error'));
    }
  }
  load();
})();
</script>
</body>
</html>`);
});

// Trigger weekly digest manually (for testing — cron handles the schedule).
// Body: { dryRun?: bool, ownerEmail?: string }
app.post('/admin/analytics/send-digest', async (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  _hardenAdminResponse(res);
  const { dryRun, ownerEmail } = req.body || {};
  const result = await sendWeeklyDigests({ dryRun: !!dryRun, ownerEmailFilter: ownerEmail });
  res.json(result);
});

// Worker — emails each owner their per-client weekly digest. Idempotent
// within a 24h window via the data/weekly_digest_log.jsonl file.
async function sendWeeklyDigests({ dryRun = false, ownerEmailFilter = null } = {}) {
  const week = rollupForWindow({ windowMs: 7 * 24 * 60 * 60 * 1000 });
  const sent = [];
  const skipped = [];
  const failed = [];

  // De-dupe — read digest log, skip slugs already mailed in last 24h.
  const digestLogPath = resolve('data', 'weekly_digest_log.jsonl');
  const recentlyMailed = new Set();
  try {
    const raw = readFileSync(digestLogPath, 'utf8');
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (new Date(ev.ts).getTime() > cutoff) recentlyMailed.add(ev.slug);
      } catch {}
    }
  } catch {}

  for (const slug of Object.keys(week.slugs || {})) {
    const row = week.slugs[slug];
    const owner = row.ownerEmail;
    if (!owner) { skipped.push({ slug, reason: 'no ownerEmail recorded' }); continue; }
    if (ownerEmailFilter && owner !== ownerEmailFilter) { skipped.push({ slug, reason: 'filter mismatch' }); continue; }
    if (recentlyMailed.has(slug)) { skipped.push({ slug, reason: 'already sent <24h ago' }); continue; }

    // Skip if there's no real signal — sending "0 chats this week" emails to
    // owners is the fastest way to get them to unsubscribe.
    const totalEvents = Object.values(row.counts || {}).reduce((a, b) => a + b, 0);
    if (totalEvents < 3) { skipped.push({ slug, reason: 'low signal' }); continue; }

    const businessType = row.businessType || 'generic';
    const weekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const weekEnd = new Date().toISOString().slice(0, 10);
    // Surface pending learning proposals for this slug — the digest links to
    // /admin/learning where Kyle one-clicks approve. Limits to top 5 by evidence.
    const pendingLearnings = [...learningProposals.values()]
      .filter(p => p.slug === slug && p.status === 'pending')
      .sort((a, b) => b.evidenceCount - a.evidenceCount)
      .slice(0, 5);
    const html = renderWeeklyDigestHtml({
      slug, businessType, weekStart, weekEnd, row,
      pendingLearnings,
      learningUrl: `${process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : ''}/admin/learning?slug=${encodeURIComponent(slug)}`,
    });
    const hot = row.counts?.lead_hot || 0;
    const subject = hot > 0
      ? `Aria found ${hot} hot lead${hot === 1 ? '' : 's'} for you this week`
      : `Your weekly Aria summary`;

    if (dryRun) {
      sent.push({ slug, ownerEmail: owner, subject, htmlLength: html.length, dryRun: true });
      continue;
    }
    try {
      await smartSend({ ownerEmail: owner, to: owner, subject, html, replyTo: process.env.NOTIFY_EMAIL });
      await fsp.appendFile(digestLogPath, JSON.stringify({ ts: new Date().toISOString(), slug, ownerEmail: owner }) + '\n');
      sent.push({ slug, ownerEmail: owner });
    } catch (e) {
      failed.push({ slug, error: e.message });
    }
  }
  return { sent: sent.length, skipped: skipped.length, failed: failed.length, details: { sent, skipped, failed } };
}

// Cron: every Monday 08:00 UTC. Single-instance Railway deploy makes a
// process-local setInterval sufficient. We compute the day-of-week + hour
// every minute and only fire on the right combo, so a restart doesn't
// re-fire (the digest log dedupes anyway).
let _lastDigestRunIso = null;
setInterval(async () => {
  const now = new Date();
  const isMon = now.getUTCDay() === 1;
  const isHour = now.getUTCHours() === 8;
  const ymd = now.toISOString().slice(0, 10);
  if (!isMon || !isHour || _lastDigestRunIso === ymd) return;
  _lastDigestRunIso = ymd;
  try {
    // Refresh learning proposals first so this week's digest includes any
    // freshly-clustered gaps from the past 7 days.
    const lp = refreshAllLearningProposals();
    if (lp > 0) console.log(`🧠 Weekly cron: ${lp} new learning proposals generated`);
    const r = await sendWeeklyDigests({});
    console.log(`📊 Weekly digest run: ${r.sent} sent, ${r.skipped} skipped, ${r.failed} failed`);
  } catch (e) {
    console.error('[analytics] weekly digest failed:', e.message);
  }
}, 60 * 1000).unref();

// ─── Usage & Settings ─────────────────────────────────────────────────────────
// ─── Agency Dashboard — per-client lead stats (internal tool for Kyle) ───────
// Reads data/leads.jsonl, groups by `client` field, returns per-client roll-up
// of leads_total / leads_7d / leads_30d / hot_rate / last_lead. Powers the
// HTML view at /admin/clients.html.
app.get('/admin/clients', async (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  try {
    let leads = [];
    try {
      const raw = await fsp.readFile(resolve('data', 'leads.jsonl'), 'utf8');
      leads = raw.trim().split('\n').filter(Boolean).map(JSON.parse);
    } catch { /* no leads yet */ }

    const now = Date.now();
    const D7 = 7 * 86400_000, D30 = 30 * 86400_000;
    const byClient = new Map();
    for (const lead of leads) {
      const slug = lead.client || 'unknown';
      const t = new Date(lead.ts).getTime();
      if (!byClient.has(slug)) byClient.set(slug, { client: slug, total: 0, last7: 0, last30: 0, hot: 0, last_ts: null });
      const row = byClient.get(slug);
      row.total += 1;
      if (now - t <= D7)  row.last7 += 1;
      if (now - t <= D30) row.last30 += 1;
      if ((lead.qualification_score ?? 0) >= 70) row.hot += 1;
      if (!row.last_ts || t > row.last_ts) row.last_ts = t;
    }
    const clients = [...byClient.values()]
      .map(r => ({ ...r, hot_rate: r.total ? +(r.hot / r.total).toFixed(2) : 0, last_lead: r.last_ts ? new Date(r.last_ts).toISOString() : null }))
      .sort((a, b) => (b.last_ts || 0) - (a.last_ts || 0));

    res.json({ leads_total: leads.length, clients_count: clients.length, clients });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// HTML view of the same — easier for Kyle to glance at on his phone.
app.get('/admin/clients.html', async (req, res) => {
  if (!adminAuth(req)) return res.status(403).send('<h1>Unauthorised</h1>');
  try {
    let leads = [];
    try {
      const raw = await fsp.readFile(resolve('data', 'leads.jsonl'), 'utf8');
      leads = raw.trim().split('\n').filter(Boolean).map(JSON.parse);
    } catch {}
    const now = Date.now();
    const D7 = 7 * 86400_000, D30 = 30 * 86400_000;
    const byClient = new Map();
    for (const lead of leads) {
      const slug = lead.client || 'unknown';
      const t = new Date(lead.ts).getTime();
      if (!byClient.has(slug)) byClient.set(slug, { client: slug, total: 0, last7: 0, last30: 0, hot: 0, last_ts: null });
      const r = byClient.get(slug);
      r.total += 1;
      if (now - t <= D7)  r.last7 += 1;
      if (now - t <= D30) r.last30 += 1;
      if ((lead.qualification_score ?? 0) >= 70) r.hot += 1;
      if (!r.last_ts || t > r.last_ts) r.last_ts = t;
    }
    const rows = [...byClient.values()].sort((a, b) => (b.last_ts || 0) - (a.last_ts || 0));
    const totalRevenue = rows.length * 29; // illustrative — if every client paid £29/mo
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aria — Agency Dashboard</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #f7fafc; color: #1a202c; margin: 0; padding: 24px; }
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 28px; margin: 0 0 4px; }
  .sub { color: #4a5568; margin-bottom: 24px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat { background: white; padding: 16px 20px; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  .stat .v { font-size: 28px; font-weight: 700; }
  .stat .l { font-size: 12px; color: #718096; text-transform: uppercase; letter-spacing: 0.5px; }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  th { background: #edf2f7; text-align: left; padding: 12px 16px; font-size: 12px; color: #4a5568; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 12px 16px; border-top: 1px solid #f1f5f9; font-size: 14px; }
  tr:hover td { background: #fafafa; }
  .hot { background: #fee2e2; color: #991b1b; padding: 2px 8px; border-radius: 6px; font-size: 12px; font-weight: 600; }
  .empty { padding: 60px; text-align: center; color: #718096; }
  .empty a { color: #6366f1; }
</style></head>
<body><div class="wrap">
  <h1>Agency Dashboard</h1>
  <p class="sub">Lead capture across all Aria-bundled client sites. Refresh to update.</p>
  <div class="stats">
    <div class="stat"><div class="v">${rows.length}</div><div class="l">Active clients</div></div>
    <div class="stat"><div class="v">${leads.length}</div><div class="l">Total leads captured</div></div>
    <div class="stat"><div class="v">${rows.reduce((s,r)=>s+r.last7,0)}</div><div class="l">Leads (last 7d)</div></div>
    <div class="stat"><div class="v">£${totalRevenue}</div><div class="l">MRR at £29/client</div></div>
  </div>
  ${rows.length === 0 ? '<div class="empty">No leads captured yet. Bundle Aria on a client site and wait for the first chat. <br><br><a href="/start">/start</a> to try it yourself.</div>' : `
  <table>
    <thead><tr><th>Client</th><th>Total</th><th>30d</th><th>7d</th><th>Hot rate</th><th>Last lead</th></tr></thead>
    <tbody>
      ${rows.map(r => `<tr>
        <td><strong>${r.client}</strong></td>
        <td>${r.total}</td>
        <td>${r.last30}</td>
        <td>${r.last7}</td>
        <td>${r.hot > 0 ? `<span class="hot">${Math.round(r.hot/r.total*100)}% hot</span>` : '—'}</td>
        <td style="color:#718096">${r.last_ts ? new Date(r.last_ts).toLocaleString('en-GB') : '—'}</td>
      </tr>`).join('')}
    </tbody>
  </table>`}
</div></body></html>`);
  } catch (e) {
    res.status(500).send('<h1>Error</h1><pre>' + e.message + '</pre>');
  }
});

// ─── Admin Domain Whitelist Endpoints ─────────────────────────────────────────
app.get('/admin/domains', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  res.json({ domains: [...allowedDomains] });
});

app.post('/admin/domains', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: 'domain required' });
  const clean = domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
  if (!clean) return res.status(400).json({ error: 'invalid domain' });
  allowedDomains.add(clean);
  persistAllowedDomains();
  console.log(`🔒 Domain added: ${clean}`);
  res.json({ ok: true, domain: clean, total: allowedDomains.size });
});

app.delete('/admin/domains', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: 'domain required' });
  allowedDomains.delete(domain.toLowerCase());
  persistAllowedDomains();
  console.log(`🔓 Domain removed: ${domain}`);
  res.json({ ok: true, removed: domain, total: allowedDomains.size });
});

app.get('/admin/usage', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error:'Unauthorised' });
  const cap = siteSettings.capEnabled ? siteSettings.capMessages : null;
  const pct = cap ? Math.round((usage.messages / cap) * 100) : null;
  res.json({ month: usageMonth, ...usage, cap, capEnabled: siteSettings.capEnabled, capPct: pct });
});

app.get('/admin/settings', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error:'Unauthorised' });
  res.json(siteSettings);
});

app.post('/admin/settings', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error:'Unauthorised' });
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
  if (!adminAuth(req)) return res.status(403).json({ error:'Unauthorised' });
  const { question, answer } = req.body;
  if (!question||!answer) return res.status(400).json({ error:'Missing fields' });
  const id = faqSeq++;
  faqs.set(id, { id, question, answer, approved:true, hits:0, ts:new Date() });
  save('faqs', Array.from(faqs.values()));
  res.json({ ok:true, id });
});

app.delete('/admin/faq/:id', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error:'Unauthorised' });
  faqs.delete(parseInt(req.params.id));
  save('faqs', Array.from(faqs.values()));
  res.json({ ok:true });
});

// ─── Auto FAQ generation ──────────────────────────────────────────────────────
app.post('/admin/generate-faq', async (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error:'Unauthorised' });
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
  if (!adminAuth(req)) return res.status(403).json({ error:'Unauthorised' });
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

// ─── Admin OAuth (cross-origin, cookie-less) ─────────────────────────────────
// Browser flow:
//   1. Client admin page hits /auth/admin/start?slug=X&return_to=Y
//   2. Server stashes {slug, returnTo} keyed by random state token, redirects
//      to Google OAuth with minimum scope (just userinfo.email).
//   3. Google bounces back to /auth/gmail/callback (existing endpoint), which
//      detects the admin-auth state, verifies email is in owners.json[slug],
//      issues a 24h HMAC-signed token, redirects user to
//      `${return_to}#aria_token=<token>`.
//   4. Admin page reads the token from location.hash, stores in sessionStorage,
//      sends as `X-Aria-Token` header on every API call.
app.get('/auth/admin/start', (req, res) => {
  const { slug, return_to } = req.query;
  if (!slug) return res.status(400).send('slug query param required');
  if (!owners.has(String(slug).toLowerCase())) {
    return res.status(404).send(`<h1>Unknown client</h1><p>No owners registered for slug "<code>${slug}</code>". Add them to <code>data/owners.json</code> on the Aria server.</p>`);
  }
  const returnTo = String(return_to || '/');
  // Reject open redirects — return_to must be http(s) and not protocol-relative.
  if (!/^https?:\/\//i.test(returnTo)) return res.status(400).send('return_to must be an absolute http(s) URL');
  const stateToken = makeAdminAuthState(slug, returnTo);
  const oauthClient = makeOAuthClient();
  const url = oauthClient.generateAuthUrl({
    access_type: 'online',          // login only — no refresh token needed
    prompt: 'select_account',       // always show account chooser (avoids silent wrong-account auth)
    scope: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
    state: JSON.stringify({ adminAuth: true, t: stateToken }),
  });
  res.redirect(url);
});

// Verifies the X-Aria-Token header and returns the signed-in email + slug.
// Admin pages call this on load to decide whether to show the UI or the
// "Sign in with Google" button.
app.get('/auth/admin/whoami', (req, res) => {
  const { slug } = req.query;
  const token = req.get('X-Aria-Token') || '';
  if (!slug) return res.status(400).json({ error: 'slug query param required' });
  const verified = verifyAdminToken(token, String(slug));
  if (!verified) return res.status(401).json({ error: 'not authenticated' });
  res.json({ email: verified.email, slug: verified.slug, expiresAt: verified.expiry });
});

// Owner management (for adding new clients/owners post-install).
app.get('/admin/owners', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  const out = {};
  for (const [slug, set] of owners) out[slug] = [...set];
  res.json({ owners: out });
});
app.post('/admin/owners', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  const { slug, emails } = req.body || {};
  if (!slug || !Array.isArray(emails)) return res.status(400).json({ error: 'slug and emails[] required' });
  const cleanSlug = String(slug).toLowerCase().trim();
  const cleanEmails = emails.map(e => String(e).toLowerCase().trim()).filter(Boolean);
  // Compute which emails are newly added — fire welcome email to those only.
  const existing = owners.get(cleanSlug) || new Set();
  const newlyAdded = cleanEmails.filter(e => !existing.has(e));
  owners.set(cleanSlug, new Set(cleanEmails));
  // Persist
  const obj = {};
  for (const [s, set] of owners) obj[s] = [...set];
  _ownersWF(OWNERS_FILE, JSON.stringify(obj, null, 2));
  console.log(`👥 Owners updated for slug=${cleanSlug}: ${cleanEmails.join(', ')} (${newlyAdded.length} new)`);
  // Fire welcome emails async — don't block the response or fail on smtp errors
  const serverUrl = `${req.protocol}://${req.get('host')}`;
  for (const ownerEmail of newlyAdded) {
    sendOwnerWelcomeEmail({ slug: cleanSlug, ownerEmail, serverUrl }).catch(() => {});
  }
  res.json({ ok: true, slug: cleanSlug, emails: cleanEmails, newlyAdded });
});

// ─── Invite system ───────────────────────────────────────────────────────────
// Admin auth — accepts (in order of preference):
//   1. aria_admin_session cookie  — set by /admin/auth magic-link exchange
//   2. X-Admin-Pass header        — used by curl/scripts (server-side only)
//   3. ?pass= query string        — legacy, deprecated, kept for old inbox links
//      until the next deploy. New links never include the password.
function adminAuth(req) {
  if (_hasValidAdminCookie(req)) return true;
  const headerPass = req.headers['x-admin-pass'];
  if (typeof headerPass === 'string' && _constantTimeEq(headerPass, ADMIN)) return true;
  const queryPass = req.query?.pass;
  if (typeof queryPass === 'string' && _constantTimeEq(queryPass, ADMIN)) return true;
  return false;
}

app.post('/api/admin/invite', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  const { email, url, type } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required' });
  const token = crypto.randomBytes(16).toString('hex');
  const serverUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
    : 'http://localhost:' + (process.env.PORT || 3000);
  invites.set(token, { email, url: url || null, type: type || null, createdAt: new Date().toISOString(), used: false });
  persistInvites();
  res.json({ ok: true, token, link: `${serverUrl}/onboard?t=${token}` });
});

app.get('/api/admin/invites', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const list = [];
  for (const [token, inv] of invites) {
    const expired = !inv.used && (Date.now() - new Date(inv.createdAt).getTime()) > SEVEN_DAYS;
    list.push({ token, ...inv, expired });
  }
  res.json(list);
});

app.delete('/api/admin/invite/:token', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  if (!invites.has(req.params.token)) return res.status(404).json({ error: 'Invite not found' });
  invites.delete(req.params.token);
  persistInvites();
  res.json({ ok: true });
});

// ─── Onboarding Wizard ──────────────────────────────────────────────────────

// Gmail OAuth start (for onboarding flow + setup flow)
app.get('/auth/gmail/start', (req, res) => {
  const { owner, onboard, setup } = req.query;
  // Setup flow — no owner needed, token links to scanned profile
  if (setup) {
    const client = makeOAuthClient();
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
      state: JSON.stringify({ setupToken: setup }),
    });
    return res.redirect(url);
  }
  if (!owner) return res.status(400).send('Missing owner parameter');
  const url = getAuthUrl(owner, onboard || null);
  res.redirect(url);
});

// Save profile from onboarding wizard
app.post('/api/onboard/save-profile', (req, res) => {
  const { token, profile } = req.body;
  if (!token || !profile) return res.status(400).json({ error: 'token and profile required' });
  const invite = invites.get(token);
  if (!invite) return res.status(400).json({ error: 'Invalid invite token' });

  // Build system prompt from profile fields
  const parts = [];
  if (profile.businessName) parts.push(`You are the AI assistant for ${profile.businessName}.`);
  if (profile.services) parts.push(`Services offered: ${profile.services}.`);
  if (profile.location) parts.push(`Located at: ${profile.location}.`);
  if (profile.phone) parts.push(`Phone: ${profile.phone}.`);
  if (profile.email) parts.push(`Email: ${profile.email}.`);
  if (profile.hours) parts.push(`Business hours: ${profile.hours}.`);
  const systemPrompt = parts.length
    ? parts.join(' ') + ' Answer customer questions helpfully and accurately based on this information.'
    : 'You are a helpful business assistant.';

  // Save profile keyed by invite email
  const ownerEmail = invite.email;
  const url = invite.url || profile.website || '';
  const cacheKey = url ? url.toLowerCase().replace(/\/+$/, '') : ownerEmail;
  clientProfiles.set(cacheKey, {
    profile: { ...profile, systemPrompt },
    scannedAt: new Date().toISOString(),
  });
  persistProfiles();

  res.json({ ok: true });
});

// Complete onboarding
app.post('/api/onboard/complete', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });
  const invite = invites.get(token);
  if (!invite) return res.status(400).json({ error: 'Invalid invite token' });

  // Mark invite as used
  invite.used = true;
  persistInvites();

  const ownerEmail = invite.email;

  // If Gmail is connected and profile exists, auto-enable email auto-reply
  if (gmailTokens.has(ownerEmail)) {
    // Find profile
    const url = invite.url || '';
    const cacheKey = url ? url.toLowerCase().replace(/\/+$/, '') : ownerEmail;
    const cached = clientProfiles.get(cacheKey);
    if (cached?.profile?.systemPrompt) {
      enableEmailAutoReply(ownerEmail, cached.profile.systemPrompt, {
        businessName: cached.profile.businessName || '',
        phone: cached.profile.phone || '',
        website: url,
        ownerEmail,
      });
    }
  }

  res.json({ ok: true });
});

// Onboarding wizard page
app.get('/onboard', (req, res) => {
  const token = req.query.t;
  const gmailConnected = req.query.gmail_connected === '1';
  const serverUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
    : process.env.GOOGLE_REDIRECT_URI?.replace('/auth/gmail/callback', '') || `http://localhost:${process.env.PORT || 3000}`;

  // Validate token
  if (!token) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d1f;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;color:#eee;}.box{background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:36px;max-width:400px;width:100%;text-align:center;}</style>
    </head><body><div class="box">
      <div style="font-size:36px;margin-bottom:16px;">&#10060;</div>
      <h2>Invalid Link</h2>
      <p style="color:#9898b8;margin:16px 0;">This onboarding link is missing a valid token. Please check your invite email and try again.</p>
    </div></body></html>`);
  }

  const invite = invites.get(token);
  if (!invite) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d1f;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;color:#eee;}.box{background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:36px;max-width:400px;width:100%;text-align:center;}</style>
    </head><body><div class="box">
      <div style="font-size:36px;margin-bottom:16px;">&#10060;</div>
      <h2>Invalid Link</h2>
      <p style="color:#9898b8;margin:16px 0;">This onboarding link is not valid. Please contact support for a new invite.</p>
    </div></body></html>`);
  }

  if (invite.used) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d1f;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;color:#eee;}.box{background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:36px;max-width:400px;width:100%;text-align:center;}a{color:#00e5a0;text-decoration:none;}</style>
    </head><body><div class="box">
      <div style="font-size:36px;margin-bottom:16px;">&#9989;</div>
      <h2>Already Set Up</h2>
      <p style="color:#9898b8;margin:16px 0;">This invite link has already been used.</p>
      <a href="/connect/gmail?owner=${encodeURIComponent(invite.email)}" style="display:inline-block;margin-top:8px;padding:14px 28px;background:#00e5a0;color:#0d0d1f;border-radius:12px;text-decoration:none;font-weight:600;">Go to Dashboard</a>
    </div></body></html>`);
  }

  // Check if expired (7 days)
  const ageMs = Date.now() - new Date(invite.createdAt).getTime();
  if (ageMs > 7 * 24 * 60 * 60 * 1000) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d1f;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;color:#eee;}.box{background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:36px;max-width:400px;width:100%;text-align:center;}</style>
    </head><body><div class="box">
      <div style="font-size:36px;margin-bottom:16px;">&#9200;</div>
      <h2>Link Expired</h2>
      <p style="color:#9898b8;margin:16px 0;">This invite link has expired. Please contact AireyAI for a new invite.</p>
    </div></body></html>`);
  }

  // Valid invite — serve the wizard
  const inviteEmail = invite.email || '';
  const inviteUrl = invite.url || '';
  const isGmailConnected = gmailConnected || gmailTokens.has(inviteEmail);

  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aria Setup - Get Started</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d1f;min-height:100vh;color:#eee;display:flex;align-items:center;justify-content:center;padding:20px;}
.container{max-width:520px;width:100%;}
.logo{text-align:center;margin-bottom:28px;}
.logo span{font-size:28px;font-weight:800;color:#fff;letter-spacing:-0.5px;}
.logo span em{font-style:normal;color:#00e5a0;}
.progress{display:flex;justify-content:center;gap:12px;margin-bottom:32px;}
.dot{width:12px;height:12px;border-radius:50%;background:rgba(255,255,255,0.1);transition:background 0.3s,box-shadow 0.3s;}
.dot.active{background:#00e5a0;box-shadow:0 0 12px rgba(0,229,160,0.4);}
.dot.done{background:#00e5a0;opacity:0.5;}
.card{background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:32px;margin-bottom:16px;}
h2{font-size:20px;font-weight:700;margin-bottom:8px;}
p.sub{font-size:13px;color:#9898b8;margin-bottom:24px;line-height:1.6;}
label{display:block;font-size:12px;color:#9898b8;margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;}
input[type=text],input[type=email],input[type=url],input[type=password],input[type=tel],textarea{
  width:100%;padding:13px 16px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);
  border-radius:10px;font-size:14px;color:#eee;font-family:inherit;outline:none;margin-bottom:16px;transition:border-color 0.2s;
}
input:focus,textarea:focus{border-color:rgba(0,229,160,0.5);}
textarea{min-height:80px;resize:vertical;}
.btn{display:block;width:100%;padding:14px;background:#00e5a0;color:#0d0d1f;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;transition:opacity 0.15s;}
.btn:hover{opacity:0.88;}
.btn:disabled{opacity:0.5;cursor:not-allowed;}
.btn-outline{background:transparent;border:1px solid rgba(0,229,160,0.3);color:#00e5a0;}
.btn-outline:hover{background:rgba(0,229,160,0.08);}
.msg{padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:14px;display:none;}
.msg.error{display:block;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.2);color:#ff6b6b;}
.msg.success{display:block;background:rgba(0,229,160,0.1);border:1px solid rgba(0,229,160,0.25);color:#00e5a0;}
.spinner{display:inline-block;width:18px;height:18px;border:2px solid rgba(0,229,160,0.3);border-top-color:#00e5a0;border-radius:50%;animation:spin 0.6s linear infinite;vertical-align:middle;margin-right:8px;}
@keyframes spin{to{transform:rotate(360deg)}}
.step{display:none;}.step.active{display:block;}
.skip-link{display:block;text-align:center;margin-top:12px;font-size:12px;color:#6b6b8a;cursor:pointer;text-decoration:underline;}
.skip-link:hover{color:#9898b8;}
.gmail-btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:14px;background:#fff;color:#333;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;transition:opacity 0.15s;}
.gmail-btn:hover{opacity:0.9;}
.gmail-btn svg{width:20px;height:20px;}
.connected-badge{display:flex;align-items:center;gap:8px;padding:14px;background:rgba(0,229,160,0.08);border:1px solid rgba(0,229,160,0.25);border-radius:12px;color:#00e5a0;font-size:14px;font-weight:600;justify-content:center;margin-bottom:16px;}
.field-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
@media(max-width:500px){.field-row{grid-template-columns:1fr;}}
.complete-icon{font-size:64px;text-align:center;margin-bottom:16px;}
</style>
</head><body>
<div class="container">
  <div class="logo"><span>Aria <em>by AireyAI</em></span></div>
  <div class="progress">
    <div class="dot active" id="dot1"></div>
    <div class="dot" id="dot2"></div>
    <div class="dot" id="dot3"></div>
    <div class="dot" id="dot4"></div>
  </div>

  <!-- STEP 1: Website Scan -->
  <div class="step active" id="step1">
    <div class="card">
      <h2>Scan Your Website</h2>
      <p class="sub">We'll pull your business info automatically so Aria knows how to help your customers.</p>
      <div id="scanMsg" class="msg"></div>
      <label>Website URL</label>
      <input type="url" id="websiteUrl" placeholder="https://yourbusiness.com" value="${inviteUrl}">
      <button class="btn" id="scanBtn" onclick="scanWebsite()">Scan My Website</button>
      <span class="skip-link" onclick="skipScan()">Skip — I'll enter details manually</span>
    </div>
  </div>

  <!-- STEP 2: Confirm Profile -->
  <div class="step" id="step2">
    <div class="card">
      <h2>Confirm Your Profile</h2>
      <p class="sub">Review and edit the details below. Aria will use this to answer your customers.</p>
      <div id="profileMsg" class="msg"></div>
      <label>Business Name</label>
      <input type="text" id="pName" placeholder="Your Business Name">
      <label>Services</label>
      <textarea id="pServices" placeholder="List your main services or products..."></textarea>
      <div class="field-row">
        <div><label>Location</label><input type="text" id="pLocation" placeholder="City, State"></div>
        <div><label>Phone</label><input type="tel" id="pPhone" placeholder="07xxx xxx xxx"></div>
      </div>
      <div class="field-row">
        <div><label>Email</label><input type="email" id="pEmail" value="${inviteEmail}"></div>
        <div><label>Hours</label><input type="text" id="pHours" placeholder="Mon-Fri 9am-5pm"></div>
      </div>
      <button class="btn" onclick="saveProfile()">Looks Good &#8212; Next</button>
    </div>
  </div>

  <!-- STEP 3: Connect Gmail -->
  <div class="step" id="step3">
    <div class="card">
      <h2>Connect Gmail</h2>
      <p class="sub">Let Aria send and reply to emails on your behalf. This is optional but recommended.</p>
      <div id="gmailMsg" class="msg"></div>
      <div id="gmailNotConnected">
        <a href="/auth/gmail/start?owner=${encodeURIComponent(inviteEmail)}&onboard=${encodeURIComponent(token)}" class="gmail-btn" style="text-decoration:none;">
          <svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.97 10.97 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
          Connect with Google
        </a>
        <span class="skip-link" onclick="skipGmail()">Skip for now</span>
      </div>
      <div id="gmailConnected" style="display:none;">
        <div class="connected-badge">&#10003; Gmail Connected</div>
        <button class="btn" onclick="goToStep(4)">Continue</button>
      </div>
    </div>
  </div>

  <!-- STEP 4: Set Password -->
  <div class="step" id="step4">
    <div class="card">
      <h2>Set Your Password</h2>
      <p class="sub">Create a password for your Aria dashboard. You'll use this to log in and manage settings.</p>
      <div id="pwMsg" class="msg"></div>
      <label>Password</label>
      <input type="password" id="pw1" placeholder="Choose a password (4+ characters)">
      <label>Confirm Password</label>
      <input type="password" id="pw2" placeholder="Confirm your password">
      <button class="btn" onclick="completeSetup()">Complete Setup</button>
    </div>
  </div>

  <!-- COMPLETE -->
  <div class="step" id="stepDone">
    <div class="card" style="text-align:center;">
      <div class="complete-icon">&#127881;</div>
      <h2 style="font-size:24px;">Aria Is Live!</h2>
      <p class="sub" style="margin-bottom:28px;">Your AI assistant is ready to help your customers. Head to your dashboard to fine-tune settings.</p>
      <a href="/connect/gmail?owner=${encodeURIComponent(inviteEmail)}" class="btn" style="text-decoration:none;display:block;text-align:center;">Go to Dashboard</a>
    </div>
  </div>
</div>

<script>
const TOKEN = '${token}';
const OWNER = '${inviteEmail}';
const PRE_URL = '${inviteUrl}';
let currentStep = 1;
let scannedProfile = null;

// If gmail was just connected, jump to step 4
if (${isGmailConnected ? 'true' : 'false'}) {
  goToStep(4);
}
// If URL pre-filled, auto-trigger scan
else if (PRE_URL) {
  setTimeout(() => scanWebsite(), 300);
}

function goToStep(n) {
  currentStep = n;
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  const stepEl = n <= 4 ? document.getElementById('step' + n) : document.getElementById('stepDone');
  if (stepEl) stepEl.classList.add('active');
  // Update dots
  for (let i = 1; i <= 4; i++) {
    const dot = document.getElementById('dot' + i);
    dot.className = 'dot';
    if (i < n) dot.classList.add('done');
    if (i === n && n <= 4) dot.classList.add('active');
  }
}

async function scanWebsite() {
  const url = document.getElementById('websiteUrl').value.trim();
  if (!url) { showMsg('scanMsg', 'Please enter a website URL.', 'error'); return; }
  const btn = document.getElementById('scanBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Scanning...';
  showMsg('scanMsg', '', '');
  try {
    const r = await fetch('/api/scan-website', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    const data = await r.json();
    if (data.ok && data.profile) {
      scannedProfile = data.profile;
      // Pre-fill step 2
      document.getElementById('pName').value = data.profile.businessName || '';
      document.getElementById('pServices').value = (data.profile.services || []).join(', ');
      document.getElementById('pLocation').value = data.profile.location || '';
      document.getElementById('pPhone').value = data.profile.phone || '';
      document.getElementById('pHours').value = data.profile.hours || '';
      showMsg('scanMsg', 'Website scanned successfully!', 'success');
      setTimeout(() => goToStep(2), 800);
    } else {
      showMsg('scanMsg', data.error || 'Scan failed. You can enter details manually.', 'error');
      btn.disabled = false;
      btn.textContent = 'Scan My Website';
    }
  } catch (e) {
    showMsg('scanMsg', 'Network error. You can skip and enter details manually.', 'error');
    btn.disabled = false;
    btn.textContent = 'Scan My Website';
  }
}

function skipScan() { goToStep(2); }

async function saveProfile() {
  const profile = {
    businessName: document.getElementById('pName').value.trim(),
    services: document.getElementById('pServices').value.trim(),
    location: document.getElementById('pLocation').value.trim(),
    phone: document.getElementById('pPhone').value.trim(),
    email: document.getElementById('pEmail').value.trim(),
    hours: document.getElementById('pHours').value.trim(),
    website: document.getElementById('websiteUrl')?.value?.trim() || PRE_URL,
  };
  if (!profile.businessName) { showMsg('profileMsg', 'Please enter a business name.', 'error'); return; }
  try {
    const r = await fetch('/api/onboard/save-profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN, profile }) });
    const data = await r.json();
    if (data.ok) {
      goToStep(3);
      // Check if Gmail already connected
      checkGmailStatus();
    } else {
      showMsg('profileMsg', data.error || 'Failed to save profile.', 'error');
    }
  } catch (e) {
    showMsg('profileMsg', 'Network error. Please try again.', 'error');
  }
}

async function checkGmailStatus() {
  try {
    const r = await fetch('/connect/gmail/status?owner=' + encodeURIComponent(OWNER));
    const data = await r.json();
    if (data.connected) {
      document.getElementById('gmailNotConnected').style.display = 'none';
      document.getElementById('gmailConnected').style.display = 'block';
    }
  } catch (_) {}
}

function skipGmail() { goToStep(4); }

async function completeSetup() {
  const pw = document.getElementById('pw1').value;
  const pw2 = document.getElementById('pw2').value;
  if (!pw || pw.length < 4) { showMsg('pwMsg', 'Password must be at least 4 characters.', 'error'); return; }
  if (pw !== pw2) { showMsg('pwMsg', 'Passwords do not match.', 'error'); return; }
  try {
    // Set password
    const r1 = await fetch('/api/dashboard/set-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: OWNER, password: pw }) });
    const d1 = await r1.json();
    if (!d1.ok && d1.error !== 'Password already set. Use reset if needed.') {
      showMsg('pwMsg', d1.error || 'Failed to set password.', 'error');
      return;
    }
    // Complete onboarding
    const r2 = await fetch('/api/onboard/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
    const d2 = await r2.json();
    if (d2.ok) {
      goToStep(5); // shows completion screen
    } else {
      showMsg('pwMsg', d2.error || 'Failed to complete setup.', 'error');
    }
  } catch (e) {
    showMsg('pwMsg', 'Network error. Please try again.', 'error');
  }
}

function showMsg(id, text, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'msg' + (type ? ' ' + type : '');
  el.style.display = text ? 'block' : 'none';
}
</script>
</body></html>`);
});

// ─── Self-onboarding wizard /start ──────────────────────────────────────
// Post-login deep-config wizard that walks new owners through business
// basics → channel connect → KB seed → review URL → digest prefs. Sets
// profile.onboardingComplete:true when finished so future logins skip
// straight to /dashboard. Idempotent — owners can re-run anytime to
// reconfigure.
//
// Auth model: requires existing dashboard auth (?owner=&s=). New clients
// arrive here via the existing /onboard invite → password-setup → Gmail
// → redirect-to-/start chain.

app.get('/start', (req, res) => {
  const ownerEmail = req.query.owner || '';
  const sessionToken = req.query.s || '';
  if (!ownerEmail || !sessionToken || !validateSession(sessionToken, ownerEmail)) {
    return res.redirect(`/dashboard?owner=${encodeURIComponent(ownerEmail)}`);
  }
  const step = Math.max(1, Math.min(5, parseInt(req.query.step) || 1));
  const profile = getOwnerProfile(ownerEmail)?.profile || {};
  const channels = channelConfigs.get(ownerEmail) || {};
  const hasMeta = ['facebook', 'instagram', 'whatsapp'].some(c => channels[c]?.accessToken);
  const hasGmail = gmailTokens.has(ownerEmail);
  const Q = `owner=${encodeURIComponent(ownerEmail)}&s=${encodeURIComponent(sessionToken)}`;

  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aria — Setup Wizard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d1f;min-height:100vh;color:#eee;padding:20px;}
.wrap{max-width:540px;margin:0 auto;padding-top:30px;}
.logo{text-align:center;margin-bottom:24px;}
.logo span{font-size:24px;font-weight:800;color:#fff;letter-spacing:-0.5px;}
.logo span em{font-style:normal;color:#00e5a0;}
.progress{display:flex;gap:8px;margin-bottom:28px;justify-content:center;}
.dot{width:30px;height:6px;border-radius:3px;background:rgba(255,255,255,0.1);transition:.3s;}
.dot.done{background:#00e5a0;}
.dot.active{background:#9d96ff;}
.card{background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:28px;margin-bottom:16px;}
.step-num{display:inline-block;background:rgba(157,150,255,0.15);color:#9d96ff;padding:4px 12px;border-radius:20px;font-size:11.5px;font-weight:600;margin-bottom:14px;text-transform:uppercase;letter-spacing:0.5px;}
h2{font-size:20px;font-weight:700;margin-bottom:8px;color:#fff;}
.lede{font-size:13.5px;color:#9898b8;margin-bottom:22px;line-height:1.6;}
.field{margin-bottom:14px;}
.field label{display:block;font-size:11.5px;color:#9898b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;font-weight:600;}
input,textarea,select{width:100%;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:11px 13px;font-size:14px;color:#eee;font-family:inherit;outline:none;transition:border-color .2s;}
input:focus,textarea:focus,select:focus{border-color:rgba(0,229,160,0.4);}
textarea{resize:vertical;min-height:84px;line-height:1.55;}
.hint{font-size:11.5px;color:#6b6b8a;margin-top:5px;line-height:1.5;}
.row{display:flex;gap:10px;}
.row .field{flex:1;}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 22px;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;text-decoration:none;transition:.15s;}
.btn-primary{background:#00e5a0;color:#0d0d1f;}
.btn-primary:hover{opacity:.9;transform:translateY(-1px);}
.btn-secondary{background:rgba(255,255,255,0.06);color:#eee;border:1px solid rgba(255,255,255,0.1);}
.btn-secondary:hover{background:rgba(255,255,255,0.1);}
.btn-link{background:transparent;color:#9d96ff;padding:8px 0;font-size:13px;}
.actions{display:flex;justify-content:space-between;margin-top:24px;align-items:center;}
.channel-row{display:flex;align-items:center;justify-content:space-between;padding:14px;background:rgba(255,255,255,0.03);border-radius:10px;margin-bottom:10px;}
.channel-row .label{display:flex;align-items:center;gap:12px;}
.channel-row .icon{font-size:20px;}
.badge-on{background:rgba(0,229,160,0.15);color:#00e5a0;padding:3px 10px;border-radius:14px;font-size:11px;font-weight:600;}
.badge-off{background:rgba(255,255,255,0.06);color:#888;padding:3px 10px;border-radius:14px;font-size:11px;}
.note{background:rgba(157,150,255,0.05);border:1px solid rgba(157,150,255,0.2);border-radius:10px;padding:12px 14px;font-size:12.5px;color:#bbb;margin-bottom:18px;line-height:1.55;}
.msg{padding:10px;border-radius:8px;font-size:13px;margin-bottom:14px;display:none;}
.msg.success{display:block;background:rgba(0,229,160,0.1);border:1px solid rgba(0,229,160,0.25);color:#00e5a0;}
.msg.error{display:block;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.2);color:#ff6b6b;}
.success-icon{font-size:48px;margin-bottom:14px;}
</style>
</head><body>
<div class="wrap">
  <div class="logo"><span>Aria<em>Ai</em></span></div>
  <div class="progress">
    ${[1,2,3,4,5].map(n => `<div class="dot ${n < step ? 'done' : n === step ? 'active' : ''}"></div>`).join('')}
  </div>
  <div id="msg" class="msg"></div>

  ${step === 1 ? `
  <div class="card">
    <div class="step-num">Step 1 of 5</div>
    <h2>Tell us about your business 👋</h2>
    <p class="lede">Aria uses this to introduce herself + answer customer questions in your voice. You can change all of this later in Settings.</p>
    <div class="field"><label>Business name</label><input id="businessName" value="${escapeHtml(profile.businessName || '')}" placeholder="e.g. Louise's Hair Studio"></div>
    <div class="field"><label>What you do (one line)</label><input id="services" value="${escapeHtml(profile.services || '')}" placeholder="e.g. Haircuts, colour, treatments"></div>
    <div class="row">
      <div class="field"><label>City / area</label><input id="location" value="${escapeHtml(profile.location || '')}" placeholder="e.g. Manchester, UK"></div>
      <div class="field"><label>Phone (optional)</label><input id="phone" value="${escapeHtml(profile.phone || '')}" placeholder="07xxx xxxxxx"></div>
    </div>
    <div class="field"><label>Tone</label>
      <select id="tone">
        ${['friendly','professional','warm','playful','formal'].map(t => `<option value="${t}" ${profile.tone === t ? 'selected' : ''}>${t.charAt(0).toUpperCase() + t.slice(1)}</option>`).join('')}
      </select>
      <p class="hint">How Aria sounds when she replies to customers.</p>
    </div>
    <div class="actions">
      <a href="/dashboard?${Q}" class="btn btn-link">Skip for now</a>
      <button class="btn btn-primary" onclick="saveStep1()">Continue →</button>
    </div>
  </div>
  ` : ''}

  ${step === 2 ? `
  <div class="card">
    <div class="step-num">Step 2 of 5</div>
    <h2>Connect your channels 📡</h2>
    <p class="lede">Aria will read + reply on these — connect any/all. You can add more later.</p>
    <div class="channel-row">
      <div class="label"><span class="icon">📧</span><div><div style="font-weight:600;">Gmail</div><div style="font-size:11.5px;color:#888;">Email auto-replies, lead capture</div></div></div>
      ${hasGmail ? '<span class="badge-on">● Connected</span>' : `<a href="/connect/gmail?owner=${encodeURIComponent(ownerEmail)}" class="btn btn-secondary" style="padding:8px 14px;font-size:12.5px;">Connect</a>`}
    </div>
    <div class="channel-row">
      <div class="label"><span class="icon">💬</span><div><div style="font-weight:600;">Meta — FB Messenger + Instagram + WhatsApp</div><div style="font-size:11.5px;color:#888;">DMs across all three Meta channels</div></div></div>
      ${hasMeta ? '<span class="badge-on">● Connected</span>' : `<a href="/connect/meta?owner=${encodeURIComponent(ownerEmail)}&s=${encodeURIComponent(sessionToken)}" class="btn btn-secondary" style="padding:8px 14px;font-size:12.5px;">Connect</a>`}
    </div>
    ${!hasGmail && !hasMeta ? '<div class="note">⚠️ You can continue without connecting yet — but Aria needs at least one channel to do anything useful.</div>' : ''}
    <div class="actions">
      <a href="/start?${Q}&step=1" class="btn btn-link">← Back</a>
      <a href="/start?${Q}&step=3" class="btn btn-primary">Continue →</a>
    </div>
  </div>
  ` : ''}

  ${step === 3 ? `
  <div class="card">
    <div class="step-num">Step 3 of 5</div>
    <h2>Seed Aria's knowledge 🧠</h2>
    <p class="lede">Give Aria 2-3 things customers commonly ask about. She'll cite these in replies. You can add more (or let her auto-suggest) later.</p>
    <div class="field">
      <label>Quick FAQ — title + answer (one entry, more in Settings)</label>
      <input id="kbTitle" placeholder="e.g. Opening hours" style="margin-bottom:8px;">
      <textarea id="kbContent" placeholder="e.g. We're open Mon-Fri 9-6 and Saturdays 10-4. Sundays closed. Walk-ins welcome but bookings preferred."></textarea>
    </div>
    <div class="note">💡 Or paste a longer doc — about page, services list, FAQ document — anything Aria should know.</div>
    <div class="actions">
      <a href="/start?${Q}&step=2" class="btn btn-link">← Back</a>
      <div style="display:flex;gap:10px;">
        <a href="/start?${Q}&step=4" class="btn btn-secondary">Skip</a>
        <button class="btn btn-primary" onclick="saveStep3()">Save & continue →</button>
      </div>
    </div>
  </div>
  ` : ''}

  ${step === 4 ? `
  <div class="card">
    <div class="step-num">Step 4 of 5</div>
    <h2>Auto-collect Google reviews ⭐</h2>
    <p class="lede">24 hours after every confirmed booking, Aria DMs your customer asking for a Google review. The single biggest growth lever you can flip in 60 seconds.</p>
    <div class="field">
      <label>Your Google review link</label>
      <input id="reviewUrl" value="${escapeHtml((profile.reviewRequest && profile.reviewRequest.url) || '')}" placeholder="https://g.page/r/your-place-id/review" style="font-family:monospace;font-size:12.5px;">
      <p class="hint">Find yours at <a href="https://whitespark.ca/google-review-link-generator/" target="_blank" style="color:#00e5a0;">whitespark.ca/google-review-link-generator</a> or use any review URL (Trustpilot, Facebook).</p>
    </div>
    <div class="actions">
      <a href="/start?${Q}&step=3" class="btn btn-link">← Back</a>
      <div style="display:flex;gap:10px;">
        <a href="/start?${Q}&step=5" class="btn btn-secondary">Skip</a>
        <button class="btn btn-primary" onclick="saveStep4()">Save & continue →</button>
      </div>
    </div>
  </div>
  ` : ''}

  ${step === 5 ? `
  <div class="card" style="text-align:center;">
    <div class="success-icon">🎉</div>
    <h2 style="margin-bottom:14px;">You're ready, ${escapeHtml(profile.businessName || 'team')}</h2>
    <p class="lede" style="margin-bottom:22px;">Aria is live. She'll handle messages on your connected channels, draft quotes for your approval, ask for reviews after bookings, and surface any gaps in her knowledge so you can fix them in one click.</p>
    <p class="lede"><b style="color:#00e5a0;">What to do next:</b> send Aria a test message from your phone to see her reply, then open the dashboard to fine-tune anything.</p>
    <div style="margin-top:24px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
      <button class="btn btn-primary" onclick="completeOnboarding()">Open dashboard →</button>
    </div>
  </div>
  ` : ''}
</div>

<script>
const Q = '${Q}';
const msg = document.getElementById('msg');
function showMsg(text, kind = 'success') { msg.className = 'msg ' + kind; msg.textContent = text; }
async function apiPost(path, body) {
  const r = await fetch(path + '?' + Q, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

async function saveStep1() {
  const body = {
    businessName: document.getElementById('businessName').value.trim(),
    services:     document.getElementById('services').value.trim(),
    location:     document.getElementById('location').value.trim(),
    phone:        document.getElementById('phone').value.trim(),
    tone:         document.getElementById('tone').value,
  };
  if (!body.businessName) { showMsg('Add your business name to continue', 'error'); return; }
  const r = await apiPost('/api/dashboard/profile', body);
  if (r.ok) location.href = '/start?' + Q + '&step=2';
  else showMsg('Save failed — try again', 'error');
}

async function saveStep3() {
  const title = document.getElementById('kbTitle').value.trim();
  const content = document.getElementById('kbContent').value.trim();
  if (!title || !content) { showMsg('Add both a title and content, or click Skip', 'error'); return; }
  const r = await apiPost('/api/dashboard/knowledge', { title, content });
  if (r.ok) location.href = '/start?' + Q + '&step=4';
  else showMsg(r.error || 'Save failed', 'error');
}

async function saveStep4() {
  const url = document.getElementById('reviewUrl').value.trim();
  if (!url) { location.href = '/start?' + Q + '&step=5'; return; }
  if (!/^https?:\\/\\//.test(url)) { showMsg('URL must start with http:// or https://', 'error'); return; }
  const r = await apiPost('/api/dashboard/reviews/settings', { enabled: true, url, delayHours: 24, template: '' });
  if (r.ok) location.href = '/start?' + Q + '&step=5';
  else showMsg(r.error || 'Save failed', 'error');
}

async function completeOnboarding() {
  await apiPost('/api/dashboard/profile', { onboardingComplete: true });
  location.href = '/dashboard?' + Q;
}
</script>
</body></html>`);
});

// Accept onboardingComplete flag on profile saves so step 5 can mark it.
// This is wired into the same /api/dashboard/profile endpoint above by
// adding to the partial-update field list — done in a follow-up.

// ─── Client Health Dashboard ─────────────────────────────────────────────────
app.get('/admin/clients', (req, res) => {
  if (!adminAuth(req)) return res.redirect('/admin');

  const clients = [];
  for (const [email, config] of EMAIL_AUTO_REPLY_ENABLED) {
    const stats = EMAIL_REPLY_STATS.get(email) || { replied: 0, bookings: 0, lastReply: null };
    const hasTokens = gmailTokens.has(email);
    const channels = channelConfigs.get(email) || {};
    const lastActivity = stats.lastReply ? new Date(stats.lastReply) : null;
    const daysInactive = lastActivity ? Math.floor((Date.now() - lastActivity.getTime()) / (1000 * 60 * 60 * 24)) : 999;

    clients.push({
      email,
      enabled: config.enabled,
      gmailConnected: hasTokens,
      replied: stats.replied || 0,
      bookings: stats.bookings || 0,
      lastReply: stats.lastReply || 'Never',
      daysInactive,
      channels: Object.keys(channels).length,
      status: !hasTokens ? 'disconnected' : daysInactive > 14 ? 'inactive' : daysInactive > 7 ? 'quiet' : 'active',
      businessName: config.config?.businessName || email.split('@')[0],
    });
  }

  clients.sort((a, b) => {
    const order = { disconnected: 0, inactive: 1, quiet: 2, active: 3 };
    return order[a.status] - order[b.status];
  });

  const statusColors = { active: '#00e5a0', quiet: '#ffa726', inactive: '#ff6b6b', disconnected: '#888' };

  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Client Health — Aria Admin</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d1f;min-height:100vh;color:#eee;padding:20px;}
      .container{max-width:800px;margin:0 auto;}
      h1{font-size:22px;margin-bottom:4px;} .sub{color:#9898b8;font-size:13px;margin-bottom:24px;}
      .back{color:#00e5a0;font-size:13px;text-decoration:none;display:inline-block;margin-bottom:16px;}
      .client{background:#161630;border:1px solid rgba(255,255,255,0.06);border-radius:14px;padding:16px 20px;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;gap:16px;}
      .client .info{flex:1;min-width:0;}
      .client .name{font-weight:600;font-size:15px;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .client .email{font-size:12px;color:#9898b8;}
      .client .stats{display:flex;gap:16px;font-size:12px;color:#9898b8;}
      .client .stats span{white-space:nowrap;}
      .badge{display:inline-block;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;}
      .summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px;}
      .sum-card{background:#161630;border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:16px;text-align:center;}
      .sum-card .val{font-size:28px;font-weight:800;color:#00e5a0;}
      .sum-card .lbl{font-size:11px;color:#9898b8;text-transform:uppercase;margin-top:4px;}
    </style>
  </head><body>
    <div class="container">
      <a class="back" href="/admin">← Back to Admin</a>
      <h1>Client Health</h1>
      <p class="sub">${clients.length} clients total</p>

      <div class="summary">
        <div class="sum-card"><div class="val">${clients.filter(c => c.status === 'active').length}</div><div class="lbl">Active</div></div>
        <div class="sum-card"><div class="val" style="color:#ffa726">${clients.filter(c => c.status === 'quiet').length}</div><div class="lbl">Quiet</div></div>
        <div class="sum-card"><div class="val" style="color:#ff6b6b">${clients.filter(c => c.status === 'inactive' || c.status === 'disconnected').length}</div><div class="lbl">Needs Attention</div></div>
        <div class="sum-card"><div class="val">${clients.reduce((s, c) => s + c.replied, 0)}</div><div class="lbl">Total Replies</div></div>
      </div>

      ${clients.map(c => `<div class="client">
        <div class="info">
          <div class="name">${c.businessName}</div>
          <div class="email">${c.email}</div>
          <div class="stats">
            <span>📧 ${c.replied} replies</span>
            <span>📅 ${c.bookings} bookings</span>
            <span>📡 ${c.channels} channels</span>
            <span>🕐 ${c.daysInactive < 999 ? c.daysInactive + 'd ago' : 'Never'}</span>
          </div>
        </div>
        <span class="badge" style="background:${statusColors[c.status]}22;color:${statusColors[c.status]}">${c.status}</span>
      </div>`).join('')}
    </div>
  </body></html>`);
});

// ─── Bulk Embed Generator ────────────────────────────────────────────────────
// Admin plan manager — flip any client between Lite ↔ Receptionist with a
// click. The in-page fetches inherit the admin cookie (adminAuth passed to
// render this page), so no password is embedded in the HTML.
app.get('/admin/plans', (req, res) => {
  if (!adminAuth(req)) return res.redirect('/admin');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Plans — Aria Admin</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d1f;min-height:100vh;color:#eee;padding:20px;}
    .container{max-width:680px;margin:0 auto;}
    .back{color:#00e5a0;font-size:13px;text-decoration:none;display:inline-block;margin-bottom:16px;}
    h1{font-size:22px;margin-bottom:4px;} .sub{color:#9898b8;font-size:13px;margin-bottom:24px;}
    .row{background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px 16px;margin-bottom:10px;display:flex;align-items:center;gap:12px;}
    .row .email{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;}
    .badge{font-size:11px;font-weight:600;padding:4px 10px;border-radius:12px;white-space:nowrap;}
    .badge.lite{background:rgba(255,255,255,0.08);color:#9898b8;}
    .badge.rec{background:rgba(0,229,160,0.15);color:#00e5a0;}
    .num{font-size:11px;color:#6b6b8a;white-space:nowrap;}
    .btn{border:none;border-radius:8px;padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;}
    .btn.up{background:#00e5a0;color:#0d0d1f;}
    .btn.down{background:rgba(255,80,80,0.12);color:#ff6b6b;border:1px solid rgba(255,80,80,0.2);}
    .btn:hover{opacity:.85;}
    .empty{color:#6b6b8a;font-size:13px;padding:20px;text-align:center;}
    #toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#161630;border:1px solid rgba(0,229,160,0.3);color:#00e5a0;padding:10px 18px;border-radius:10px;font-size:13px;opacity:0;transition:.3s;pointer-events:none;}
    #toast.show{opacity:1;}
  </style>
  </head><body>
    <div class="container">
      <a class="back" href="/admin">← Back to Admin</a>
      <h1>Client Plans</h1>
      <p class="sub">Flip any client between Aria Lite and Receptionist. Receptionist unlocks the voice phone receptionist.</p>
      <div id="list"><div class="empty">Loading…</div></div>
    </div>
    <div id="toast"></div>
    <script>
      function toast(t){var e=document.getElementById('toast');e.textContent=t;e.classList.add('show');setTimeout(function(){e.classList.remove('show');},2200);}
      function esc(s){return String(s||'').replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
      async function load(){
        const r = await fetch('/api/admin/plans').then(x=>x.json());
        const rows = r.rows||[];
        const el = document.getElementById('list');
        if(!rows.length){el.innerHTML='<div class="empty">No clients yet.</div>';return;}
        el.innerHTML = rows.map(function(o){
          const isRec = o.plan==='receptionist';
          return '<div class="row">'+
            '<span class="email">'+esc(o.ownerEmail)+'</span>'+
            (o.hasNumber?'<span class="num">📞 number</span>':'')+
            '<span class="badge '+(isRec?'rec':'lite')+'">'+(isRec?'Receptionist':'Lite')+'</span>'+
            '<button class="btn '+(isRec?'down':'up')+'" onclick="setPlan(\\''+esc(o.ownerEmail)+'\\',\\''+(isRec?'lite':'receptionist')+'\\')">'+(isRec?'Downgrade to Lite':'Upgrade to Receptionist')+'</button>'+
          '</div>';
        }).join('');
      }
      async function setPlan(email, plan){
        const r = await fetch('/api/admin/set-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ownerEmail:email,plan:plan})}).then(x=>x.json());
        if(r.ok){toast('✓ '+email+' → '+plan);load();}
        else toast(r.error||'Failed');
      }
      load();
    </script>
  </body></html>`);
});

app.get('/admin/embed', (req, res) => {
  if (!adminAuth(req)) return res.redirect('/admin');
  const serverUrl = process.env.GOOGLE_REDIRECT_URI?.replace('/auth/gmail/callback', '') || `http://localhost:${process.env.PORT || 3000}`;

  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Embed Generator — Aria Admin</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d1f;min-height:100vh;color:#eee;padding:20px;}
      .container{max-width:600px;margin:0 auto;}
      h1{font-size:22px;margin-bottom:4px;} .sub{color:#9898b8;font-size:13px;margin-bottom:24px;}
      .back{color:#00e5a0;font-size:13px;text-decoration:none;display:inline-block;margin-bottom:16px;}
      label{display:block;font-size:13px;color:#9898b8;margin-bottom:6px;margin-top:16px;}
      input,select{width:100%;padding:12px 14px;background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#eee;font-size:14px;outline:none;font-family:inherit;}
      input:focus,select:focus{border-color:#00e5a0;}
      input::placeholder{color:#555;}
      .btn{width:100%;padding:14px;background:#00e5a0;color:#0d0d1f;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;margin-top:24px;}
      .btn:hover{opacity:.88;}
      .output{margin-top:24px;background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;position:relative;}
      .output pre{font-size:12px;color:#00e5a0;white-space:pre-wrap;word-break:break-all;line-height:1.6;font-family:'SF Mono',monospace;}
      .copy{position:absolute;top:8px;right:8px;background:rgba(0,229,160,0.15);color:#00e5a0;border:none;border-radius:6px;padding:6px 12px;font-size:11px;cursor:pointer;font-weight:600;}
    </style>
  </head><body>
    <div class="container">
      <a class="back" href="/admin">← Back to Admin</a>
      <h1>Embed Generator</h1>
      <p class="sub">Generate the embed code for a client's website</p>

      <label>Client Name / Business Name</label>
      <input id="e-name" placeholder="e.g. Harper Hair Studio" />

      <label>Client Email (owner)</label>
      <input id="e-email" type="email" placeholder="e.g. client@gmail.com" />

      <label>Brand Colour</label>
      <input id="e-color" type="color" value="#6C63FF" style="height:44px;padding:4px;" />

      <label>Business Type</label>
      <select id="e-type">
        <option value="generic">Generic</option>
        <option value="trades">Trades</option>
        <option value="salon">Salon / Beauty</option>
        <option value="restaurant">Restaurant / Food</option>
        <option value="gym">Gym / Fitness</option>
        <option value="clinic">Clinic / Health</option>
        <option value="agency">Agency</option>
        <option value="ecommerce">Ecommerce / Shop</option>
        <option value="law">Legal</option>
        <option value="realestate">Real Estate</option>
      </select>

      <label>Phone Number (optional)</label>
      <input id="e-phone" placeholder="+44..." />

      <label>WhatsApp Number (optional)</label>
      <input id="e-wa" placeholder="+44..." />

      <label>Location / Address (optional)</label>
      <input id="e-location" placeholder="e.g. 123 High Street, London" />

      <button class="btn" onclick="generate()">Generate Embed Code</button>

      <div class="output" id="output" style="display:none;">
        <button class="copy" onclick="navigator.clipboard.writeText(document.getElementById('code').textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)">Copy</button>
        <pre id="code"></pre>
      </div>
    </div>
    <script>
      function generate() {
        const name = document.getElementById('e-name').value.trim();
        const email = document.getElementById('e-email').value.trim();
        const color = document.getElementById('e-color').value;
        const type = document.getElementById('e-type').value;
        const phone = document.getElementById('e-phone').value.trim();
        const wa = document.getElementById('e-wa').value.trim();
        const loc = document.getElementById('e-location').value.trim();
        if (!name || !email) return alert('Name and email are required.');

        let code = '<script src="${serverUrl}/chatbot.js"\\n';
        code += '    data-name="Aria"\\n';
        code += '    data-color="' + color + '"\\n';
        code += '    data-server="${serverUrl}"\\n';
        code += '    data-type="' + type + '"\\n';
        code += '    data-owner-email="' + email + '"\\n';
        code += '    data-site-name="' + name + '"\\n';
        code += '    data-booking=\\'{"ownerName":"' + name + '","ownerEmail":"' + email + '"}\\'\\n';
        if (phone) code += '    data-phone="' + phone + '"\\n';
        if (wa) code += '    data-whatsapp="' + wa + '"\\n    data-handoff-wa="' + wa + '"\\n';
        if (loc) code += '    data-location="' + loc + '"\\n';
        code += '    data-handoff-email="' + email + '"\\n';
        code += '><\\/script>';

        document.getElementById('code').textContent = code.replace(/\\n/g, '\\n');
        document.getElementById('output').style.display = 'block';
      }
    </script>
  </body></html>`);
});

// ─── Token Health Check (error alerts) ───────────────────────────────────────
// Check Google token health every hour, alert if any are broken
setInterval(async () => {
  for (const [email, entry] of gmailTokens) {
    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: entry.auth });
      await oauth2.userinfo.get();
    } catch (e) {
      if (e.message?.includes('invalid_grant') || e.message?.includes('Token has been expired')) {
        console.warn('Token expired for:', email);
        const alertTo = process.env.NOTIFY_EMAIL;
        if (alertTo) {
          smartSend({
            ownerEmail: null,
            to: alertTo,
            subject: `⚠️ Aria Alert: Google token expired for ${email}`,
            html: `<div style="font-family:-apple-system,sans-serif;padding:24px;">
              <h2 style="color:#ff6b6b;">⚠️ Token Expired</h2>
              <p>${email} needs to reconnect their Google account.</p>
              <p>Their auto-reply and calendar integration will not work until reconnected.</p>
              <p><a href="${process.env.GOOGLE_REDIRECT_URI?.replace('/auth/gmail/callback', '') || 'http://localhost:3000'}/connect/gmail?owner=${encodeURIComponent(email)}">Reconnect link</a></p>
            </div>`,
          }).catch(() => {});
        }
      }
    }
  }
}, 60 * 60 * 1000);

// ─── Admin auth — magic-link exchange + cookie login + logout ─────────────────
// All three set/clear an httpOnly aria_admin_session cookie. After login, the
// 27 inline admin route handlers (via adminAuth(req)) accept the cookie and
// the URL no longer needs to carry ?pass=.

// Set cookie defenses on every admin response: no-store keeps proxy caches
// from holding the HTML; Referrer-Policy stops outbound links from leaking
// the admin URL (mostly cosmetic now that ?pass= is gone, but cheap).
function _hardenAdminResponse(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
}

function _setAdminCookie(res, sessionId) {
  // SameSite=Lax keeps OAuth callbacks working; Secure required in prod since
  // Railway terminates TLS. httpOnly keeps JS from reading it.
  const secure = process.env.NODE_ENV === 'production' || process.env.RAILWAY_PUBLIC_DOMAIN;
  const attrs = [
    `aria_admin_session=${sessionId}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`,
    'Path=/',
  ];
  if (secure) attrs.push('Secure');
  res.set('Set-Cookie', attrs.join('; '));
}

function _clearAdminCookie(res) {
  res.set('Set-Cookie', 'aria_admin_session=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/');
}

// Magic-link exchange. The email-issued link is one-shot — the token is
// consumed on first hit so a forwarded email can't grant a second session.
app.get('/admin/auth', (req, res) => {
  _hardenAdminResponse(res);
  const token = req.query.t;
  if (typeof token !== 'string' || !token) return res.status(400).send('Missing token');
  const entry = adminMagicLinks.get(token);
  if (!entry || entry.expiresAt < Date.now()) {
    adminMagicLinks.delete(token);
    return res.status(410).send('<h1>Link expired</h1><p>Magic links are valid for 30 minutes. Request a new one from the admin page.</p>');
  }
  adminMagicLinks.delete(token); // one-shot
  const sessionId = mintAdminSession(req.ip);
  _setAdminCookie(res, sessionId);
  res.redirect('/admin');
});

// Password login — POST so the password never appears in URLs, logs, or
// referer headers. Body is JSON. Throttling left to upstream rate limiter.
// Magic-link issuance — alternative to password auth. Kyle requests a link
// to his admin email (NOTIFY_EMAIL); server only emails if the address matches
// the configured admin email. Always responds 200 OK so a passing scanner
// can't learn which addresses are admins.
app.post('/admin/request-magic-link', express.json(), async (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim();
  const adminEmail = String(process.env.NOTIFY_EMAIL || '').toLowerCase().trim();
  // Respond OK regardless to avoid leaking which emails are valid admins.
  res.json({ ok: true, message: 'If that email is a registered admin, a sign-in link is on its way.' });
  if (!email || !adminEmail || email !== adminEmail) {
    console.log(`[admin-magic-link] rejected request for ${email || '(empty)'}`);
    return;
  }
  try {
    const link = mintAdminMagicLink(req);
    await smartSend({
      ownerEmail: adminEmail,
      to: adminEmail,
      subject: 'Aria — your sign-in link',
      html: `<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a2e;">
        <h2 style="margin:0 0 12px;">Sign in to Aria Admin</h2>
        <p style="font-size:14px;line-height:1.55;color:#444;">Click the button below to sign in. The link works once and expires in 15 minutes.</p>
        <p style="margin:22px 0;"><a href="${link}" style="display:inline-block;background:#6C63FF;color:#fff;padding:13px 24px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px;">Sign in →</a></p>
        <p style="font-size:11px;color:#888;">If you didn't request this, you can ignore the email — no action needed.</p>
      </div>`,
      replyTo: process.env.NOTIFY_EMAIL,
    });
    console.log(`[admin-magic-link] sent to ${adminEmail}`);
  } catch (e) {
    console.warn('[admin-magic-link] send failed:', e.message);
  }
});

app.post('/admin/login', express.json(), (req, res) => {
  _hardenAdminResponse(res);
  const pass = req.body?.password;
  if (typeof pass !== 'string' || !_constantTimeEq(pass, ADMIN)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const sessionId = mintAdminSession(req.ip);
  _setAdminCookie(res, sessionId);
  res.json({ ok: true });
});

app.post('/admin/logout', (req, res) => {
  _hardenAdminResponse(res);
  const cookies = parseCookies(req);
  if (cookies.aria_admin_session) adminSessions.delete(cookies.aria_admin_session);
  _clearAdminCookie(res);
  res.json({ ok: true });
});

// ─── Admin dashboard ──────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  _hardenAdminResponse(res);
  if (!adminAuth(req)) return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aria Admin</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         background: #0f0f1a; color: #e8e8f8; display: flex; align-items: center;
         justify-content: center; min-height: 100vh; padding: 20px; }
  .box { background: #1a1a2e; border-radius: 16px; padding: 36px 32px;
         width: 100%; max-width: 360px; }
  h2 { color: #fff; font-size: 20px; font-weight: 700; margin-bottom: 4px; text-align: center; }
  .sub { color: #8888aa; font-size: 12px; text-align: center; margin-bottom: 26px; }
  input { width: 100%; padding: 11px 14px; border-radius: 10px;
          border: 1.5px solid #2a2a44; background: #13131f; color: #fff;
          font-size: 14px; outline: none; margin-bottom: 10px; font-family: inherit; }
  input:focus { border-color: #6C63FF; }
  button { width: 100%; padding: 11px; background: #6C63FF; color: #fff;
           border: none; border-radius: 10px; font-size: 14px; font-weight: 600;
           cursor: pointer; font-family: inherit; transition: opacity .15s; }
  button:hover { opacity: 0.9; }
  button.alt { background: transparent; border: 1.5px solid #2a2a44; color: #c0c0e0; }
  .divider { display: flex; align-items: center; gap: 10px; margin: 20px 0;
             color: #6b6b8a; font-size: 11px; text-transform: uppercase;
             letter-spacing: 0.1em; font-weight: 600; }
  .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: #2a2a44; }
  .msg { font-size: 12px; margin-top: 10px; min-height: 16px; padding: 6px 0; }
  .msg.err { color: #ff6b6b; }
  .msg.ok { color: #00e5a0; }
</style>
</head>
<body>
<div class="box">
  <h2>Aria Admin</h2>
  <div class="sub">Sign in to your dashboard</div>

  <form id="passForm">
    <input id="p" type="password" placeholder="Admin password" autocomplete="current-password">
    <button type="submit">Sign in with password</button>
  </form>

  <div class="divider">or</div>

  <form id="linkForm">
    <input id="em" type="email" placeholder="your@email.com" autocomplete="email">
    <button type="submit" class="alt">Email me a sign-in link</button>
  </form>

  <div id="msg" class="msg"></div>
</div>

<script>
(function() {
  const msgEl = document.getElementById('msg');
  function setMsg(text, kind) {
    msgEl.textContent = text;
    msgEl.className = 'msg ' + (kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : '');
  }

  document.getElementById('passForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const pw = document.getElementById('p').value;
    if (!pw) return;
    setMsg('Signing in…', '');
    try {
      const r = await fetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
        credentials: 'same-origin',
      });
      if (r.ok) {
        window.location.href = '/admin';
      } else {
        setMsg('Wrong password', 'err');
      }
    } catch (e) {
      setMsg('Network error — try again', 'err');
    }
  });

  document.getElementById('linkForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = document.getElementById('em').value.trim();
    if (!email) return;
    setMsg('Sending link…', '');
    try {
      await fetch('/admin/request-magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      setMsg('If that email is a registered admin, a sign-in link is on its way (15 min expiry).', 'ok');
    } catch (e) {
      setMsg('Network error — try again', 'err');
    }
  });
})();
</script>
</body>
</html>`);

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
    <button class="tab" onclick="tab('domains')">🔒 Domains</button>
    <button class="tab" onclick="tab('settings')">⚙️ Settings</button>
    <button class="tab" onclick="tab('invites')">🔗 Invites</button>
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
      <!-- Right: Supplier search + catalogue -->
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="card">
          <h3>🔍 Search Supplier Catalogues</h3>
          <div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap">
            <button class="btn" id="sup-cj" onclick="setSupplier('cj')" style="font-size:12px;padding:5px 14px">CJ Dropshipping</button>
            <button class="btn ghost" id="sup-brandsgateway" onclick="setSupplier('brandsgateway')" style="font-size:12px;padding:5px 14px">BrandsGateway</button>
            <button class="btn ghost" id="sup-printful" onclick="setSupplier('printful')" style="font-size:12px;padding:5px 14px">Printful</button>
          </div>
          <div id="sup-status" style="font-size:11.5px;margin-bottom:10px"></div>
          <div style="display:flex;gap:8px;margin-bottom:12px">
            <input id="cj-search" placeholder="Search products..." style="flex:1"/>
            <button class="btn" onclick="cjSearch()">Search</button>
          </div>
          <div id="cj-results" style="max-height:300px;overflow-y:auto"></div>
        </div>
        <div class="card">
          <h3>🔗 Map Product to Supplier</h3>
          <p style="font-size:12.5px;color:#8888aa;margin-bottom:12px">Link a Shopify product variant to a supplier variant so orders are auto-fulfilled.</p>
          <div style="display:grid;gap:8px;margin-bottom:12px">
            <div><label style="font-size:11.5px;color:#8888aa;display:block;margin-bottom:3px">Shopify Variant ID</label><input id="ds-shopify-id" placeholder="e.g. 12345678"/></div>
            <div><label style="font-size:11.5px;color:#8888aa;display:block;margin-bottom:3px">Supplier Variant ID / SKU</label><input id="ds-cj-sku" placeholder="e.g. BAO-001-RED-XL"/></div>
            <div><label style="font-size:11.5px;color:#8888aa;display:block;margin-bottom:3px">Product Name</label><input id="ds-title" placeholder="e.g. Wireless Earbuds Pro"/></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
              <div><label style="font-size:11.5px;color:#8888aa;display:block;margin-bottom:3px">Your Cost (£)</label><input id="ds-cost" type="number" step="0.01" placeholder="5.99"/></div>
              <div><label style="font-size:11.5px;color:#8888aa;display:block;margin-bottom:3px">Sell Price (£)</label><input id="ds-sell" type="number" step="0.01" placeholder="19.99"/></div>
            </div>
            <input type="hidden" id="ds-supplier" value="cj"/>
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
            <p><strong style="color:#6C63FF">CJ Dropshipping</strong> — Budget products, fast UK/EU shipping<br>
              <code style="background:#13131f;padding:2px 8px;border-radius:4px;font-size:12px;color:#2ecc71">CJ_EMAIL=your@email.com</code><br>
              <code style="background:#13131f;padding:2px 8px;border-radius:4px;font-size:12px;color:#2ecc71">CJ_API_KEY=your-cj-api-key</code>
            </p>
            <p><strong style="color:#e74c3c">BrandsGateway</strong> — Designer brands (Gucci, Versace, Prada, Calvin Klein)<br>
              <code style="background:#13131f;padding:2px 8px;border-radius:4px;font-size:12px;color:#2ecc71">BRANDSGATEWAY_API_KEY=your-bg-api-key</code>
            </p>
            <p><strong style="color:#3498db">Printful</strong> — Print-on-demand (custom t-shirts, hoodies, mugs)<br>
              <code style="background:#13131f;padding:2px 8px;border-radius:4px;font-size:12px;color:#2ecc71">PRINTFUL_API_KEY=your-printful-token</code>
            </p>
            <p style="border-top:1px solid #2a2a44;padding-top:12px;margin-top:8px"><strong style="color:#6C63FF">Shopify Webhook</strong> — Required for auto-fulfilment<br>
              Settings → Notifications → Webhooks → <strong>Order payment</strong><br>
              <code style="background:#13131f;padding:2px 8px;border-radius:4px;font-size:12px;color:#2ecc71">https://your-server.com/api/shopify/webhook</code><br>
              <code style="background:#13131f;padding:2px 8px;border-radius:4px;font-size:12px;color:#2ecc71">SHOPIFY_WEBHOOK_SECRET=whsec_xxx</code>
            </p>
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
      <h3>👥 Per-Client Token Usage Today</h3>
      <p style="font-size:12px;color:#8888aa;margin-bottom:14px">Channel reply token spend per AireyAI client account. Clients NEVER see this — admin-only.</p>
      <div id="per-client-usage" style="font-size:13px;"><div style="color:#8888aa">Loading…</div></div>
    </div>
    <div class="card">
      <h3>📈 Total Chatbot Usage This Month</h3>
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

  <div id="p-domains" class="panel">
    <div class="card">
      <h3>🔒 Allowed Domains</h3>
      <p style="font-size:13px;color:#8888aa;margin-bottom:14px">Only websites on this list can use the Aria chatbot. If the list is empty, all domains are allowed (open mode).</p>
      <div style="display:flex;gap:8px;margin-bottom:18px;">
        <input id="newDomain" placeholder="e.g. myclient.co.uk" style="flex:1;padding:10px 14px;background:#13131f;border:1.5px solid #2a2a44;border-radius:10px;color:#fff;font-size:13px;outline:none;font-family:inherit;" onkeydown="if(event.key==='Enter')addDomain()">
        <button class="btn" onclick="addDomain()">+ Add</button>
      </div>
      <div id="domainList" style="font-size:13px;color:#c0c0e0;"></div>
      <p style="font-size:11px;color:#6b6b8a;margin-top:14px;">Subdomains are automatically included (e.g. adding mysite.co.uk also allows www.mysite.co.uk). Admin, dashboard, and Gmail callback URLs are always allowed.</p>
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

  <div id="p-invites" class="panel">
    <div class="card">
      <h3>🔗 Generate Invite Link</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
        <label style="display:block">
          <div style="font-size:12px;color:#8888aa;margin-bottom:5px">Client email <span style="color:#e74c3c">*</span></div>
          <input id="inv-email" type="email" placeholder="client@example.com" required style="width:100%"/>
        </label>
        <label style="display:block">
          <div style="font-size:12px;color:#8888aa;margin-bottom:5px">Website URL (optional)</div>
          <input id="inv-url" type="url" placeholder="https://example.com" style="width:100%"/>
        </label>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px">
        <label style="display:block">
          <div style="font-size:12px;color:#8888aa;margin-bottom:5px">Business type</div>
          <select id="inv-type" class="status-sel" style="width:100%;padding:8px 12px;font-size:13px;border-radius:8px">
            <option value="trades">Trades</option>
            <option value="salon">Salon</option>
            <option value="restaurant">Restaurant</option>
            <option value="gym">Gym</option>
            <option value="clinic">Clinic</option>
            <option value="agency">Agency</option>
            <option value="ecommerce">Ecommerce</option>
            <option value="law">Law</option>
          </select>
        </label>
        <div style="display:flex;align-items:flex-end">
          <button class="btn" onclick="generateInvite()" style="width:100%">Generate Link</button>
        </div>
      </div>
      <div id="inv-result" style="display:none;background:#13131f;border:1px solid #2a2a44;border-radius:8px;padding:14px;margin-bottom:14px">
        <div style="font-size:12px;color:#8888aa;margin-bottom:6px">Invite link:</div>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="inv-link" readonly style="flex:1;background:#0f0f1a;border-color:#6C63FF;color:#6C63FF;font-size:12px"/>
          <button class="btn ghost" onclick="copyInvite()" style="flex-shrink:0">📋 Copy</button>
        </div>
        <div id="inv-copied" style="display:none;font-size:11px;color:#2ecc71;margin-top:6px">✓ Copied to clipboard</div>
      </div>
    </div>
    <div class="card">
      <h3>📋 Existing Invites</h3>
      <div id="inv-list" style="font-size:13px;color:#8888aa">Loading...</div>
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
let _activeSupplier = 'cj';
const supColors = { cj:'#6C63FF', brandsgateway:'#e74c3c', printful:'#3498db' };
const supNames = { cj:'CJ Dropshipping', brandsgateway:'BrandsGateway', printful:'Printful' };

function setSupplier(s) {
  _activeSupplier = s;
  el('ds-supplier').value = s;
  ['cj','brandsgateway','printful'].forEach(k => {
    const b = el('sup-'+k);
    if (k===s) { b.className='btn'; b.style.background=supColors[k]; }
    else { b.className='btn ghost'; b.style.background=''; }
  });
  el('cj-search').placeholder = 'Search ' + supNames[s] + '...';
  el('cj-results').innerHTML = '';
  updateSupStatus();
}

function updateSupStatus() {
  if (!_dsData) return;
  const s = _dsData.stats;
  const status = [];
  status.push(s.cjConnected ? '<span style="color:#2ecc71">● CJ</span>' : '<span style="color:#e74c3c">○ CJ</span>');
  status.push(s.bgConnected ? '<span style="color:#2ecc71">● BrandsGateway</span>' : '<span style="color:#e74c3c">○ BrandsGateway</span>');
  status.push(s.pfConnected ? '<span style="color:#2ecc71">● Printful</span>' : '<span style="color:#e74c3c">○ Printful</span>');
  el('sup-status').innerHTML = status.join(' &nbsp; ');
}

async function loadDropship() {
  const r = await fetch('/admin/dropship/data?pass='+PASS);
  _dsData = await r.json();
  renderDropship(_dsData);
  updateSupStatus();
}

function renderDropship({ stats, orders, catalogue }) {
  el('ds-stats').innerHTML = [
    stat(stats.total,'Total Orders'), stat(stats.today,'Today'),
    stat(stats.pending,'Processing'), stat(stats.shipped,'Shipped'),
    stat(stats.products,'Products'), stat((stats.cjConnected?1:0)+(stats.bgConnected?1:0)+(stats.pfConnected?1:0)+'/3','Suppliers'),
  ].join('');

  // Orders
  const statusColor = { processing:'#f39c12', shipped:'#2ecc71', error:'#e74c3c' };
  el('ds-orders').innerHTML = orders.length
    ? orders.slice(0,50).map(o=>{
        const sup = o.supplier || 'cj';
        return \`<div style="padding:10px 0;border-bottom:1px solid #1e1e30">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <span style="font-weight:700;color:#fff">Shopify #\${o.shopifyOrderNumber} <span style="font-size:10px;padding:2px 6px;border-radius:4px;background:\${supColors[sup]||'#666'}20;color:\${supColors[sup]||'#888'};font-weight:600;margin-left:6px">\${supNames[sup]||sup}</span></span>
          <span style="font-size:11.5px;font-weight:700;color:\${statusColor[o.status]||'#888'}">\${o.status}</span>
        </div>
        <div style="font-size:12px;color:#8888aa">\${o.customer?.name||''} · \${o.items?.join(', ').slice(0,60)||''}</div>
        \${o.cjOrderId?\`<div style="font-size:11.5px;color:#6C63FF;margin-top:3px">Order: \${o.cjOrderId}</div>\`:''}
        \${o.tracking?\`<div style="margin-top:6px"><a href="\${o.tracking.url}" target="_blank" style="font-size:12px;color:#2ecc71;font-weight:600">📮 Track: \${o.tracking.number}</a> (\${o.tracking.carrier})</div>\`:''}
        \${o.unmapped?.length?\`<div style="font-size:11.5px;color:#e74c3c;margin-top:3px">⚠️ Unmapped: \${o.unmapped.join(', ')}</div>\`:''}
        <div style="font-size:11px;color:#666;margin-top:3px">\${new Date(o.createdAt).toLocaleString()}</div>
      </div>\`;}).join('')
    : '<div style="color:#8888aa;font-size:13px;padding:12px 0">No orders yet. Connect Shopify webhook to start.</div>';

  // Catalogue — grouped by supplier
  el('ds-cat-count').textContent = catalogue.length;
  el('ds-catalogue').innerHTML = catalogue.length
    ? catalogue.map(p=>{
        const sup = p.supplier || 'cj';
        return \`<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #1e1e30;font-size:12.5px">
        <div>
          <div style="color:#fff;font-weight:600">\${esc(p.title||p.shopifyId)} <span style="font-size:10px;padding:1px 5px;border-radius:3px;background:\${supColors[sup]||'#666'}20;color:\${supColors[sup]||'#888'}">\${supNames[sup]||sup}</span></div>
          <div style="color:#8888aa;font-size:11.5px">Shopify: \${p.shopifyId} → \${p.cjSku}</div>
          \${p.costPrice?\`<div style="color:#2ecc71;font-size:11.5px">Cost £\${p.costPrice} → Sell £\${p.sellPrice||'?'}</div>\`:''}
        </div>
        <button class="del-btn" onclick="dsUnmap('\${p.shopifyId}')">Remove</button>
      </div>\`;}).join('')
    : '<div style="color:#8888aa;font-size:13px;padding:8px 0">No products mapped yet. Search a supplier above and add them.</div>';
}

async function cjSearch() {
  const q = el('cj-search').value.trim();
  if (!q) return;
  const sup = _activeSupplier;
  el('cj-results').innerHTML = \`<div style="color:#8888aa;font-size:13px;padding:8px 0">Searching \${supNames[sup]}... ✦</div>\`;
  const r = await fetch('/admin/dropship/search?pass='+PASS+'&q='+encodeURIComponent(q)+'&supplier='+sup);
  const { products, message } = await r.json();
  if (!products?.length) {
    el('cj-results').innerHTML = \`<div style="color:#8888aa;font-size:13px;padding:8px 0">\${message||'No results found'}</div>\`;
    return;
  }
  el('cj-results').innerHTML = products.map(p=>\`
    <div style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid #1e1e30;align-items:center">
      \${p.image?\`<img src="\${p.image}" style="width:48px;height:48px;border-radius:6px;object-fit:cover;flex-shrink:0">\`:'<div style="width:48px;height:48px;border-radius:6px;background:#2a2a44;flex-shrink:0"></div>'}
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;color:#fff;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\${esc(p.title)}\${p.brand?\` <span style="color:\${supColors[sup]||'#888'};font-size:10px">\${esc(p.brand)}</span>\`:''}</div>
        <div style="font-size:11.5px;color:#8888aa">\${esc(p.category||'')} · \${p.variants} variant(s)\${p.sellPrice?' · £'+p.sellPrice:''}</div>
        <div style="font-size:11.5px;color:\${supColors[sup]||'#6C63FF'};font-family:monospace;margin-top:2px">ID: \${p.pid}</div>
      </div>
      <button class="btn ghost" style="font-size:11.5px;padding:4px 10px;flex-shrink:0" onclick="prefillCJ('\${p.pid}','\${esc(p.title).replace(/'/g,"&#39;")}','\${p.sellPrice||""}')">Use this</button>
    </div>\`).join('');
}

function prefillCJ(pid, title, price) {
  el('ds-cj-sku').value = pid;
  el('ds-title').value  = title;
  el('ds-cost').value   = price || '';
  el('ds-supplier').value = _activeSupplier;
  el('ds-cj-sku').focus();
  el('ds-cj-sku').select();
}

async function mapProduct() {
  const sup = el('ds-supplier').value || _activeSupplier;
  const data = {
    shopifyVariantId:  el('ds-shopify-id').value.trim(),
    cjSku:             el('ds-cj-sku').value.trim(),
    title:             el('ds-title').value.trim(),
    costPrice:         el('ds-cost').value,
    sellPrice:         el('ds-sell').value,
    supplier:          sup,
    supplierProductId: el('ds-cj-sku').value.trim(),
    supplierVariantId: el('ds-cj-sku').value.trim(),
  };
  if (!data.shopifyVariantId || !data.cjSku) { alert('Shopify Variant ID and Supplier SKU are required.'); return; }
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
  const names=['convos','leads','bookings','dropship','gaps','handoffs','faq','ab','nps','insights','gmail','usage','domains','settings','invites'];
  document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('on',names[i]===name));
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('on'));
  el('p-'+name).classList.add('on');
  if (name === 'dropship') loadDropship();
  if (name === 'usage') loadUsage();
  if (name === 'domains') loadDomains();
  if (name === 'settings') loadSettings();
  if (name === 'invites') loadInvites();
}

async function loadDomains() {
  const r = await fetch('/admin/domains?pass='+PASS);
  const data = await r.json();
  const list = el('domainList');
  if (!data.domains?.length) {
    list.innerHTML = '<div style="padding:16px;text-align:center;color:#6b6b8a;background:#13131f;border-radius:10px;border:1px dashed #2a2a44;"><p style="margin-bottom:4px;">🌐 Open mode — all domains allowed</p><p style="font-size:11px;">Add a domain above to enable the whitelist.</p></div>';
    return;
  }
  list.innerHTML = data.domains.map(d =>
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#13131f;border:1px solid #2a2a44;border-radius:10px;margin-bottom:8px;">'
    + '<div style="display:flex;align-items:center;gap:8px;"><span style="color:#2ecc71;font-size:10px;">●</span><span>' + d + '</span></div>'
    + '<button class="btn red" style="font-size:11px;padding:4px 10px;" onclick="removeDomain(\\'' + d + '\\')">Remove</button>'
    + '</div>'
  ).join('');
}

async function addDomain() {
  const input = el('newDomain');
  const domain = input.value.trim();
  if (!domain) return;
  const r = await fetch('/admin/domains?pass='+PASS, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ domain }) });
  const data = await r.json();
  if (data.ok) { input.value = ''; loadDomains(); }
}

async function removeDomain(domain) {
  if (!confirm('Remove ' + domain + ' from the whitelist?')) return;
  await fetch('/admin/domains?pass='+PASS, { method:'DELETE', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ domain }) });
  loadDomains();
}

async function loadUsage() {
  // Per-client channel-token table (admin-only)
  try {
    const pcr = await fetch('/api/admin/usage', { headers: { 'x-admin-password': PASS } });
    const pcd = await pcr.json();
    const pcEl = el('per-client-usage');
    if (!pcd.rows?.length) {
      pcEl.innerHTML = '<div style="color:#8888aa">No client usage yet today.</div>';
    } else {
      const rows = pcd.rows.map(r => {
        const barColor = r.pctUsed >= 90 ? '#e74c3c' : r.pctUsed >= 70 ? '#f39c12' : '#2ecc71';
        return '<div style="padding:10px 0;border-bottom:1px solid #1e1e30;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;font-size:13px;color:#e8e8f8;margin-bottom:6px;">' +
            '<span style="font-weight:600">' + r.ownerEmail + '</span>' +
            '<span style="color:' + barColor + ';font-weight:700">' + r.pctUsed + '% · ' + r.usedToday.toLocaleString() + ' / ' + r.capToday.toLocaleString() + ' tok</span>' +
          '</div>' +
          '<div style="background:#13131f;border-radius:20px;height:6px;overflow:hidden;">' +
            '<div style="width:' + r.pctUsed + '%;height:100%;background:' + barColor + ';"></div>' +
          '</div>' +
          '<div style="font-size:11.5px;color:#8888aa;margin-top:3px">' + r.repliesToday + ' replies today</div>' +
        '</div>';
      }).join('');
      pcEl.innerHTML = rows + '<div style="margin-top:12px;font-size:12px;color:#8888aa;text-align:right">Total today: <b style="color:#e8e8f8">' + (pcd.totalUsedToday || 0).toLocaleString() + ' tokens</b></div>';
    }
  } catch (e) { el('per-client-usage').innerHTML = '<div style="color:#e74c3c">Failed: ' + e.message + '</div>'; }

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

// ── Invites ──
async function generateInvite() {
  const email = el('inv-email').value.trim();
  if (!email) { alert('Email is required'); return; }
  const body = { email, websiteUrl: el('inv-url').value.trim(), businessType: el('inv-type').value };
  const r = await fetch('/api/admin/invite?pass='+PASS, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  const d = await r.json();
  if (d.link) {
    el('inv-link').value = d.link;
    el('inv-result').style.display = 'block';
    el('inv-copied').style.display = 'none';
    el('inv-email').value = '';
    el('inv-url').value = '';
    loadInvites();
  } else { alert(d.error || 'Failed to generate invite'); }
}
function copyInvite() {
  navigator.clipboard?.writeText(el('inv-link').value);
  el('inv-copied').style.display = 'block';
  setTimeout(() => el('inv-copied').style.display = 'none', 2000);
}
async function loadInvites() {
  const r = await fetch('/api/admin/invites?pass='+PASS);
  const invites = await r.json();
  if (!invites.length) { el('inv-list').innerHTML = '<div style="padding:12px 0;color:#8888aa">No invites yet</div>'; return; }
  el('inv-list').innerHTML = invites.map(inv => {
    const date = new Date(inv.createdAt).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
    const status = inv.used ? 'Used' : (inv.expired ? 'Expired' : 'Active');
    const badgeClass = inv.used ? 'b-converted' : (inv.expired ? 'b-lost' : 'b-new');
    return '<div class="lead-row">'
      + '<span class="lead-email">' + (inv.email||'—') + '</span>'
      + '<span class="lead-meta">' + (inv.businessType||'') + (inv.websiteUrl ? ' · '+inv.websiteUrl : '') + '</span>'
      + '<span class="badge '+badgeClass+'">' + status + '</span>'
      + '<span style="font-size:11.5px;color:#8888aa">' + date + '</span>'
      + '<button class="del-btn" onclick="deleteInvite(\\'' + inv.token + '\\')">Delete</button>'
      + '</div>';
  }).join('');
}
async function deleteInvite(token) {
  if (!confirm('Delete this invite?')) return;
  await fetch('/api/admin/invite/'+token+'?pass='+PASS, { method:'DELETE' });
  loadInvites();
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

// ─── Client Dashboard ─────────────────────────────────────────────────────────

function requireDashboardAuth(req, res) {
  const owner = req.query.owner || req.body?.owner;
  const token = req.query.s || req.headers['x-session-token'];
  if (!owner || !token || !validateSession(token, owner)) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }
  return owner;
}

// GET /api/dashboard/stats
app.get('/api/dashboard/stats', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const stats = EMAIL_REPLY_STATS.get(owner) || { replied: 0, bookings: 0, followUps: 0, urgent: 0, lastReply: null, leads: { hot: 0, warm: 0, cold: 0 }, categories: {}, history: [] };
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const history = stats.history || [];
  const emailsWeek = history.filter(h => new Date(h.time) > weekAgo).length;
  const bookingsWeek = history.filter(h => h.type === 'booking' && new Date(h.time) > weekAgo).length;
  // Combine email leads (EMAIL_REPLY_STATS) + channel leads (channelStats)
  // so the dashboard's Leads card shows all sources unified.
  const chStats = channelStats.get(owner) || {};
  const chLeads = chStats.leads || { hot: 0, warm: 0, cold: 0 };
  const hot  = (stats.leads?.hot  || 0) + (chLeads.hot  || 0);
  const warm = (stats.leads?.warm || 0) + (chLeads.warm || 0);
  const cold = (stats.leads?.cold || 0) + (chLeads.cold || 0);
  const totalLeads = hot + warm + cold;
  const autoReplyConfig = EMAIL_AUTO_REPLY_ENABLED.get(owner);
  // CSAT tally — derive from the append-only ledger, scoped to this owner
  // + last 90 days. Cheap O(file lines) since CSAT is rare events only.
  let csatPos = 0, csatNeg = 0;
  try {
    if (existsSync(CSAT_FILE)) {
      const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
      for (const line of readFileSync(CSAT_FILE, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e.ownerEmail !== owner) continue;
          if (new Date(e.ts).getTime() < cutoff) continue;
          if (e.rating === 'positive') csatPos++;
          else if (e.rating === 'negative') csatNeg++;
        } catch {}
      }
    }
  } catch {}
  const csatTotal = csatPos + csatNeg;
  const csatScore = csatTotal > 0 ? Math.round((csatPos / csatTotal) * 100) : null;

  res.json({
    emailsReplied: { week: emailsWeek, total: stats.replied || 0 },
    bookings: { week: bookingsWeek, total: stats.bookings || 0 },
    leads: { total: totalLeads, hot, warm, cold },
    leadsBySource: {
      email:   { hot: stats.leads?.hot  || 0, warm: stats.leads?.warm  || 0, cold: stats.leads?.cold  || 0 },
      channel: { hot: chLeads.hot       || 0, warm: chLeads.warm       || 0, cold: chLeads.cold       || 0 },
    },
    csat: { positive: csatPos, negative: csatNeg, total: csatTotal, scorePct: csatScore },
    // budget intentionally NOT exposed here — clients should never see how
    // many tokens they're burning. Kyle-only view at /api/admin/usage.
    autoReplyEnabled: !!autoReplyConfig?.enabled,
    gmailConnected: gmailTokens.has(owner)
  });
});

// Admin-only — per-owner daily token + reply usage across the whole estate
app.get('/api/admin/usage', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  const rows = [];
  // Walk both EMAIL_AUTO_REPLY_ENABLED owners + channelConfigs owners + anyone
  // who appears in tokenUsageDaily today
  const owners = new Set([
    ...Array.from(EMAIL_AUTO_REPLY_ENABLED.keys()),
    ...Array.from(channelConfigs.keys()),
  ]);
  for (const k of tokenUsageDaily.keys()) owners.add(k.split('::')[0]);
  for (const owner of owners) {
    const profile = getOwnerProfile(owner);
    const b = checkBudget(owner, profile?.config?.tokensPerDay);
    rows.push({
      ownerEmail: owner,
      usedToday: b.used,
      capToday: b.cap,
      repliesToday: b.replies,
      pctUsed: Math.round((b.used / b.cap) * 100),
    });
  }
  rows.sort((a, b) => b.usedToday - a.usedToday);
  res.json({ rows, totalUsedToday: rows.reduce((s, r) => s + r.usedToday, 0) });
});

// Admin-only — per-owner VOICE usage + estimated cost. Derives entirely
// from the append-only phone_calls.jsonl ledger (no counter state to drift).
// Voice is real per-minute money on AireyAI's Vapi account, so this is the
// "who's costing what" view BEFORE the Vapi invoice lands. Kyle-only —
// clients never see minutes or cost (same wall as token usage).
const VOICE_COST_PER_MIN = Number(process.env.VOICE_COST_PER_MIN) || 0.11; // £/min raw (Vapi+Twilio+STT+LLM+TTS)
const VOICE_NUMBER_RENTAL = Number(process.env.VOICE_NUMBER_RENTAL) || 1.20; // £/mo per number
// Admin-only — set a client's plan ('lite' | 'receptionist'). This is how
// Kyle grants/revokes the voice receptionist when a client pays (manual
// until Stripe is wired; Stripe will later POST the same change).
app.post('/api/admin/set-plan', express.json({ limit: '2kb' }), (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  const { ownerEmail, plan } = req.body || {};
  if (!ownerEmail) return res.status(400).json({ error: 'ownerEmail required' });
  if (![PLANS.LITE, PLANS.RECEPTIONIST].includes(plan)) {
    return res.status(400).json({ error: `plan must be '${PLANS.LITE}' or '${PLANS.RECEPTIONIST}'` });
  }
  // Find/create the profile entry and set plan.
  let key = null, entry = null;
  for (const [k, v] of clientProfiles) {
    if (v?.profile?.email === ownerEmail) { key = k; entry = v; break; }
  }
  if (!entry) { entry = { profile: { email: ownerEmail }, scannedAt: new Date().toISOString() }; clientProfiles.set(ownerEmail, entry); }
  entry.profile.plan = plan;
  clientProfiles.set(key || ownerEmail, entry);
  persistProfiles();
  // If downgrading to lite while they hold a number, disable voice so it
  // stops answering (we leave the number provisioned; release is separate).
  if (plan === PLANS.LITE) {
    const vc = voiceConfig.get(ownerEmail);
    if (vc?.enabled) { voiceConfig.set(ownerEmail, { ...vc, enabled: false }); persistVoiceConfig(); }
  }
  console.log(`💳 [plan] ${ownerEmail} → ${plan}`);
  res.json({ ok: true, ownerEmail, plan });
});

// Admin-only — list every owner's current plan (quick estate view).
app.get('/api/admin/plans', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  const owners = new Set([
    ...Array.from(EMAIL_AUTO_REPLY_ENABLED.keys()),
    ...Array.from(channelConfigs.keys()),
  ]);
  for (const [, v] of clientProfiles) { if (v?.profile?.email) owners.add(v.profile.email); }
  const rows = Array.from(owners).map(o => ({
    ownerEmail: o,
    plan: getOwnerPlan(o),
    hasNumber: !!voiceConfig.get(o)?.vapiNumberId,
  }));
  rows.sort((a, b) => (a.plan === b.plan ? 0 : a.plan === PLANS.RECEPTIONIST ? -1 : 1));
  res.json({ rows });
});

app.get('/api/admin/voice-usage', (req, res) => {
  if (!adminAuth(req)) return res.status(403).json({ error: 'Unauthorised' });
  const now = new Date();
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const perOwner = new Map(); // owner → { calls, seconds }
  try {
    if (existsSync(PHONE_CALLS_LEDGER)) {
      for (const line of readFileSync(PHONE_CALLS_LEDGER, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (!e.ownerEmail || !e.ts) continue;
        if (!String(e.ts).startsWith(monthKey)) continue; // this calendar month only
        const cur = perOwner.get(e.ownerEmail) || { calls: 0, seconds: 0 };
        cur.calls += 1;
        cur.seconds += Number(e.durationSec) || 0;
        perOwner.set(e.ownerEmail, cur);
      }
    }
  } catch (e) { console.warn('[voice-usage] ledger read failed:', e.message); }

  const rows = [];
  for (const [owner, v] of perOwner) {
    const minutes = v.seconds / 60;
    const hasNumber = !!voiceConfig.get(owner)?.vapiNumberId;
    const cost = minutes * VOICE_COST_PER_MIN + (hasNumber ? VOICE_NUMBER_RENTAL : 0);
    rows.push({
      ownerEmail: owner,
      calls: v.calls,
      minutes: Math.round(minutes * 10) / 10,
      estCostGbp: Math.round(cost * 100) / 100,
      hasNumber,
    });
  }
  rows.sort((a, b) => b.estCostGbp - a.estCostGbp);
  res.json({
    month: monthKey,
    perMinRate: VOICE_COST_PER_MIN,
    numberRental: VOICE_NUMBER_RENTAL,
    rows,
    totals: {
      calls: rows.reduce((s, r) => s + r.calls, 0),
      minutes: Math.round(rows.reduce((s, r) => s + r.minutes, 0) * 10) / 10,
      estCostGbp: Math.round(rows.reduce((s, r) => s + r.estCostGbp, 0) * 100) / 100,
      activeNumbers: rows.filter(r => r.hasNumber).length,
    },
  });
});

// ─── Webhook events — central dispatcher used by every firing site ─────
// Looks up owner's webhooks from profile.webhooks[], filters by event +
// enabled, fires each via the dispatcher (which handles HMAC signing +
// retry asynchronously). Fire-and-forget so the calling flow isn't
// blocked by slow receivers.
//
// Valid event types:
//   'new_lead'         — fires when a lead is scored (any score)
//   'hot_lead'         — fires only when leadScore === 'hot'
//   'new_booking'      — fires when a booking's slots all fill
//   'handoff'          — fires when conversation paused for human takeover
//   'angry_message'    — fires when sentiment classified as 'angry'
//   'csat_negative'    — fires when customer rates a conv 👎
//   'conversation_started' — fires on the first message in a conv
async function fireWebhookEvent(ownerEmail, event, data) {
  const profile = getOwnerProfile(ownerEmail);
  const webhooks = profile?.profile?.webhooks || profile?.webhooks || profile?.config?.webhooks || [];
  if (!webhooks.length) return;
  for (const wh of webhooks) {
    if (!wh.enabled || !wh.url) continue;
    if (Array.isArray(wh.events) && wh.events.length && !wh.events.includes(event)) continue;
    // Don't await — let retries happen async
    dispatchWebhook(wh, event, { ...data, ownerEmail }).catch(e => {
      console.warn(`[webhook] ${event} → ${wh.url}: ${e.message}`);
    });
  }
}

// GET /api/dashboard/webhooks — list owner's webhooks + recent deliveries
app.get('/api/dashboard/webhooks', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const profile = getOwnerProfile(owner);
  const webhooks = profile?.profile?.webhooks || [];
  const urls = new Set(webhooks.map(w => w.url));
  const recentDeliveries = readWebhookLog({ urls, limit: 30 });
  res.json({
    // Strip secrets from response (only show last 4 chars for ID)
    webhooks: webhooks.map(w => ({
      label: w.label, url: w.url, events: w.events || [],
      enabled: w.enabled !== false,
      secretHint: w.secret ? '••••' + String(w.secret).slice(-4) : null,
    })),
    recentDeliveries,
  });
});

// POST /api/dashboard/webhooks — add/update a webhook
app.post('/api/dashboard/webhooks', express.json({ limit: '32kb' }), (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const { label, url, events, enabled = true, replaceIndex } = req.body || {};
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Valid http(s) URL required' });
  // Find/create profile
  let profileKey = null, profileEntry = null;
  for (const [k, v] of clientProfiles) {
    if (v?.profile?.email === owner) { profileKey = k; profileEntry = v; break; }
  }
  if (!profileEntry) {
    profileEntry = { profile: { email: owner, webhooks: [] }, scannedAt: new Date().toISOString() };
    clientProfiles.set(owner, profileEntry);
  }
  const webhooks = profileEntry.profile.webhooks || [];
  const newEntry = {
    label: String(label || 'Webhook').slice(0, 60),
    url: String(url),
    events: Array.isArray(events) ? events : ['new_lead', 'new_booking', 'handoff'],
    enabled: !!enabled,
    secret: crypto.randomBytes(24).toString('hex'),
    createdAt: new Date().toISOString(),
  };
  if (typeof replaceIndex === 'number' && webhooks[replaceIndex]) {
    // Preserve existing secret when updating
    newEntry.secret = webhooks[replaceIndex].secret;
    webhooks[replaceIndex] = newEntry;
  } else {
    if (webhooks.length >= 10) return res.status(400).json({ error: 'Max 10 webhooks per owner' });
    webhooks.push(newEntry);
  }
  profileEntry.profile.webhooks = webhooks;
  clientProfiles.set(profileKey || owner, profileEntry);
  res.json({ ok: true, secret: newEntry.secret });
});

// DELETE /api/dashboard/webhooks/:index
app.delete('/api/dashboard/webhooks/:index', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const idx = parseInt(req.params.index);
  for (const [k, v] of clientProfiles) {
    if (v?.profile?.email !== owner) continue;
    const webhooks = v.profile.webhooks || [];
    if (idx < 0 || idx >= webhooks.length) return res.status(404).json({ error: 'not found' });
    webhooks.splice(idx, 1);
    v.profile.webhooks = webhooks;
    clientProfiles.set(k, v);
    return res.json({ ok: true });
  }
  res.status(404).json({ error: 'profile not found' });
});

// POST /api/dashboard/webhooks/:index/test — fire a test event so owner
// can verify their receiver accepts the payload
app.post('/api/dashboard/webhooks/:index/test', async (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const idx = parseInt(req.params.index);
  const profile = getOwnerProfile(owner);
  const webhooks = profile?.profile?.webhooks || [];
  const wh = webhooks[idx];
  if (!wh) return res.status(404).json({ error: 'webhook not found' });
  const result = await dispatchWebhook(wh, 'test', {
    message: 'This is a test event from Aria. If you see this, your webhook is wired up correctly.',
    ownerEmail: owner,
  });
  res.json(result);
});

// ─── Notification digest settings ────────────────────────────────────────
// Owners with high inbound volume can opt-in to batch informational
// alerts (new lead, booking, review sent, conv recovery, etc) into a
// single email at their local sendTime. Action-required alerts
// (handoff, no-show, quote approval, angry message) always immediate.

app.get('/api/dashboard/notifications/settings', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const profile = getOwnerProfile(owner);
  const cfg = profile?.profile?.notificationDigest || profile?.config?.notificationDigest || {};
  const buffered = (notificationDigestBuffer.get(owner) || []).length;
  res.json({
    settings: {
      enabled:  !!cfg.enabled,
      sendTime: cfg.sendTime || '17:00',
      timezone: cfg.timezone || profile?.profile?.businessHours?.timezone || 'Europe/London',
    },
    queuedToday: buffered,
    lastDigestSent: digestLastSentDate.get(owner) || null,
  });
});

app.post('/api/dashboard/notifications/settings', express.json({ limit: '4kb' }), (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const { enabled = false, sendTime = '17:00', timezone } = req.body || {};
  // Validate sendTime format
  if (!/^\d{1,2}:\d{2}$/.test(sendTime)) return res.status(400).json({ error: 'sendTime must be HH:MM' });

  let profileKey = null, profileEntry = null;
  for (const [k, v] of clientProfiles) {
    if (v?.profile?.email === owner) { profileKey = k; profileEntry = v; break; }
  }
  if (!profileEntry) {
    profileEntry = { profile: { email: owner }, scannedAt: new Date().toISOString() };
    clientProfiles.set(owner, profileEntry);
  }
  profileEntry.profile.notificationDigest = {
    enabled:  !!enabled,
    sendTime: String(sendTime),
    timezone: timezone || profileEntry.profile?.businessHours?.timezone || 'Europe/London',
  };
  clientProfiles.set(profileKey || owner, profileEntry);
  res.json({ ok: true, settings: profileEntry.profile.notificationDigest });
});

// ─── Review request settings ─────────────────────────────────────────────
// Owners configure their Google Place review URL (or Trustpilot, Facebook
// reviews, etc) + optional custom template. Aria auto-sends a follow-up
// N hours after every confirmed appointment.
//
// GET returns current settings + recent send history from the ledger.
// POST upserts the settings. Empty url = effectively disabled (handler
// silently no-ops). enabled:false = explicit disable even with a url set.

app.get('/api/dashboard/reviews/settings', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const profile = getOwnerProfile(owner);
  const cfg = profile?.profile?.reviewRequest || profile?.config?.reviewRequest || {};

  // Read last 30 review-request ledger entries for this owner
  let recent = [];
  try {
    if (existsSync(REVIEW_REQUESTS_LEDGER)) {
      const lines = readFileSync(REVIEW_REQUESTS_LEDGER, 'utf8').split('\n').filter(Boolean).slice(-200);
      for (let i = lines.length - 1; i >= 0 && recent.length < 30; i--) {
        try {
          const e = JSON.parse(lines[i]);
          if (e.ownerEmail === owner) recent.push(e);
        } catch {}
      }
    }
  } catch {}

  res.json({
    settings: {
      enabled:    cfg.enabled !== false,
      url:        cfg.url || '',
      delayHours: Number(cfg.delayHours) > 0 ? Number(cfg.delayHours) : 24,
      template:   cfg.template || '',
      alwaysEmail: !!cfg.alwaysEmail,
    },
    recent,
    defaultTemplate: 'Hi {customer}! Hope your {service} with {business} went well 🙏 If you have 30 seconds, a quick review really helps us out: {url}',
  });
});

app.post('/api/dashboard/reviews/settings', express.json({ limit: '16kb' }), (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const { enabled = true, url = '', delayHours = 24, template = '', alwaysEmail = false } = req.body || {};
  if (url && !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Review URL must start with http:// or https://' });
  const delayClamped = Math.max(1, Math.min(720, Number(delayHours) || 24)); // 1h–30d sanity

  let profileKey = null, profileEntry = null;
  for (const [k, v] of clientProfiles) {
    if (v?.profile?.email === owner) { profileKey = k; profileEntry = v; break; }
  }
  if (!profileEntry) {
    profileEntry = { profile: { email: owner }, scannedAt: new Date().toISOString() };
    clientProfiles.set(owner, profileEntry);
  }
  profileEntry.profile.reviewRequest = {
    enabled:    !!enabled,
    url:        String(url).trim().slice(0, 500),
    delayHours: delayClamped,
    template:   String(template || '').slice(0, 800),
    alwaysEmail: !!alwaysEmail,
  };
  clientProfiles.set(profileKey || owner, profileEntry);
  res.json({ ok: true, settings: profileEntry.profile.reviewRequest });
});

// POST /api/dashboard/reviews/test — preview the rendered template
// against a dummy booking so owner can see exactly what their customer
// will receive. Does NOT actually send anything.
app.post('/api/dashboard/reviews/test', express.json({ limit: '4kb' }), (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const profile = getOwnerProfile(owner);
  const cfg = profile?.profile?.reviewRequest || profile?.config?.reviewRequest || {};
  const businessName = profile?.profile?.businessName || 'us';
  const tmpl = (cfg.template && typeof cfg.template === 'string')
    ? cfg.template
    : `Hi {customer}! Hope your {service} with {business} went well 🙏 If you have 30 seconds, a quick review really helps us out: {url}`;
  const preview = tmpl
    .replace(/\{customer\}/g, req.body?.customer || 'Sarah')
    .replace(/\{business\}/g, businessName)
    .replace(/\{service\}/g, req.body?.service || 'visit')
    .replace(/\{url\}/g, cfg.url || '[review URL not set]');
  res.json({ preview, ready: !!cfg.url && cfg.enabled !== false });
});

// GET /api/dashboard/customers — list all known customers for the owner,
// sorted by most-recent touch. Pulled from the in-memory customerIndex
// which is rebuilt at startup from channel_leads.jsonl.
app.get('/api/dashboard/customers', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const owned = customerIndex.get(owner);
  if (!owned) return res.json({ customers: [] });
  const list = [];
  for (const [key, c] of owned) {
    list.push({
      key,
      name: c.name || key.split(':')[1],
      channels: Array.from(c.channels || []),
      touches: c.totalTouches || 0,
      lastSeen: c.lastSeen,
      recent: (c.recent || []).slice(0, 1),
    });
  }
  list.sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
  res.json({ customers: list });
});

// GET /api/dashboard/customer/:contactKey — full profile for one customer.
// Aggregates conversations (from conversationMemory across all channels for
// this senderId), bookings (matched on contact), leads (matched on
// contactKey), and computes a simple LTV proxy.
app.get('/api/dashboard/customer/:contactKey', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const targetKey = decodeURIComponent(req.params.contactKey || '');
  const owned = customerIndex.get(owner);
  if (!owned?.has(targetKey)) return res.status(404).json({ error: 'Customer not found' });
  const customer = owned.get(targetKey);

  // 1. Lead history from channel_leads.jsonl — filter by contactKey match
  const leadHistory = [];
  const sentimentTimeline = [];
  try {
    if (existsSync(CHANNEL_LEADS_FILE)) {
      for (const line of readFileSync(CHANNEL_LEADS_FILE, 'utf8').split('\n').filter(Boolean)) {
        try {
          const e = JSON.parse(line);
          if (e.ownerEmail !== owner) continue;
          const ek = customerKey(e.contact || {});
          if (ek !== targetKey) continue;
          leadHistory.push({
            ts: e.ts, channel: e.channel, leadScore: e.leadScore, category: e.category,
            sentiment: e.sentiment, preview: e.messagePreview,
          });
          if (e.sentiment) sentimentTimeline.push({ ts: e.ts, sentiment: e.sentiment });
        } catch {}
      }
    }
  } catch {}

  // 2. Bookings matched on contact
  const customerBookings = bookings.filter(b => {
    if (b.ownerEmail !== owner) return false;
    const bKey = customerKey({ name: b.name, email: b.contact?.includes('@') ? b.contact : null, phone: b.contact && !b.contact?.includes('@') ? b.contact : null });
    return bKey === targetKey;
  }).reverse();

  // 3. Conversations across all channels — scan conversationMemory keys
  // for any matching senderId across channels this customer touched.
  const conversations = [];
  const recentSenderIds = new Set((customer.recent || []).map(r => r.channel + '::' + r.preview));
  for (const [memKey, history] of conversationMemory) {
    if (!memKey.startsWith(owner + '::')) continue;
    const [, channel, senderId] = memKey.split('::');
    if (!customer.channels?.has(channel)) continue;
    // Check the recorded touches for this customer — does this senderId appear in any of them?
    // (We don't have a senderId↔customerKey map yet so we use the conv's contact preview as proxy.)
    const matchesByPreview = (history || []).some(h =>
      h.role === 'sender' && (customer.recent || []).some(r => h.preview?.slice(0, 60).includes(r.preview?.slice(0, 60)))
    );
    if (matchesByPreview) {
      conversations.push({ memKey, channel, senderId, msgCount: history.length, lastMsgTs: history[history.length - 1]?.date });
    }
  }
  conversations.sort((a, b) => (b.lastMsgTs || '').localeCompare(a.lastMsgTs || ''));

  // 4. LTV proxy — simple weighted sum. Tunable in lib/customer_ltv.js
  //    (Kyle owns the formula — see TODO at top of that file.)
  const ltv = ltvScore({
    bookings: customerBookings.length,
    leads: leadHistory.length,
    hotLeads: leadHistory.filter(l => l.leadScore === 'hot').length,
    conversations: conversations.length,
    touches: customer.totalTouches,
  });

  res.json({
    key: targetKey,
    name: customer.name,
    channels: Array.from(customer.channels || []),
    touches: customer.totalTouches,
    lastSeen: customer.lastSeen,
    leadHistory,
    bookings: customerBookings,
    conversations,
    sentimentTimeline,
    ltv,
  });
});

// GET /api/dashboard/analytics — 7-day rollup of conversation volume,
// sentiment, leads, CSAT, top categories. Reads directly from the JSONL
// ledgers (no separate aggregation layer needed at current scale; cache
// later if a client crosses ~10k convs/week).
app.get('/api/dashboard/analytics', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;

  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const buckets = 7;
  const cutoff = now - buckets * DAY_MS;

  // dayIndex helper: 0 = today, 6 = 7 days ago
  const dayIndex = (ts) => {
    const age = now - new Date(ts).getTime();
    return Math.min(buckets - 1, Math.max(0, Math.floor(age / DAY_MS)));
  };
  const emptyBuckets = () => Array(buckets).fill(0);

  // 1. Conversation VOLUME per channel — derived from channelMessages map.
  const volumeByChannel = { facebook: emptyBuckets(), instagram: emptyBuckets(), whatsapp: emptyBuckets(), email: emptyBuckets() };
  const channelMsgs = channelMessages.get(owner) || [];
  for (const m of channelMsgs) {
    if (!m.timestamp || new Date(m.timestamp).getTime() < cutoff) continue;
    const ch = m.channel;
    if (volumeByChannel[ch]) volumeByChannel[ch][buckets - 1 - dayIndex(m.timestamp)]++;
  }
  // Email volume — derived from EMAIL_REPLY_STATS.history
  const stats = EMAIL_REPLY_STATS.get(owner) || { history: [] };
  for (const h of (stats.history || [])) {
    if (!h.time || new Date(h.time).getTime() < cutoff) continue;
    volumeByChannel.email[buckets - 1 - dayIndex(h.time)]++;
  }

  // 2. SENTIMENT distribution + LEADS breakdown — derive from channel_leads.jsonl
  const sentimentDist = { positive: 0, neutral: 0, negative: 0, angry: 0 };
  const leadsBreakdown = { hot: 0, warm: 0, cold: 0 };
  const categoryCounts = {};
  try {
    if (existsSync(CHANNEL_LEADS_FILE)) {
      const lines = readFileSync(CHANNEL_LEADS_FILE, 'utf8').split('\n').filter(Boolean).slice(-1500);
      for (const l of lines) {
        try {
          const e = JSON.parse(l);
          if (e.ownerEmail !== owner) continue;
          if (new Date(e.ts).getTime() < cutoff) continue;
          if (e.leadScore && leadsBreakdown[e.leadScore] !== undefined) leadsBreakdown[e.leadScore]++;
          if (e.category) categoryCounts[e.category] = (categoryCounts[e.category] || 0) + 1;
          if (e.sentiment && sentimentDist[e.sentiment] !== undefined) sentimentDist[e.sentiment]++;
        } catch {}
      }
    }
  } catch {}

  // 3. CSAT trend — per-day positive/total over 7 days
  const csatPerDay = emptyBuckets().map(() => ({ pos: 0, tot: 0 }));
  try {
    if (existsSync(CSAT_FILE)) {
      const lines = readFileSync(CSAT_FILE, 'utf8').split('\n').filter(Boolean).slice(-500);
      for (const l of lines) {
        try {
          const e = JSON.parse(l);
          if (e.ownerEmail !== owner) continue;
          if (new Date(e.ts).getTime() < cutoff) continue;
          const idx = buckets - 1 - dayIndex(e.ts);
          csatPerDay[idx].tot++;
          if (e.rating === 'positive') csatPerDay[idx].pos++;
        } catch {}
      }
    }
  } catch {}
  // Convert to % per day (null when no ratings that day so chart can show gaps)
  const csatTrend = csatPerDay.map(d => d.tot > 0 ? Math.round((d.pos / d.tot) * 100) : null);

  // 4. Top categories — top 5
  const topCategories = Object.entries(categoryCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // 5. Week-over-week deltas (this 7d vs previous 7d)
  const prevCutoff = now - 2 * buckets * DAY_MS;
  let thisWeekConvs = 0, prevWeekConvs = 0;
  for (const m of channelMsgs) {
    if (!m.timestamp) continue;
    const t = new Date(m.timestamp).getTime();
    if (t >= cutoff) thisWeekConvs++;
    else if (t >= prevCutoff) prevWeekConvs++;
  }
  const pct = (cur, prev) => prev > 0 ? Math.round(((cur - prev) / prev) * 100) : (cur > 0 ? 100 : 0);

  res.json({
    period: '7d',
    volumeByChannel,
    totalConversations: Object.values(volumeByChannel).reduce((s, arr) => s + arr.reduce((a, b) => a + b, 0), 0),
    leadsBreakdown,
    sentimentDist,        // currently empty (sentiment not yet on lead records)
    csatTrend,
    topCategories,
    weekOverWeek: {
      convs: pct(thisWeekConvs, prevWeekConvs),
      convsAbs: thisWeekConvs - prevWeekConvs,
    },
  });
});

// GET /api/dashboard/activity — unified feed of recent events for the
// dashboard's Activity panel. Aggregates from multiple sources (channel
// leads, bookings, escalations, CSAT) and returns last N events sorted
// newest-first. One endpoint = one render in the UI.
app.get('/api/dashboard/activity', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const events = [];

  // Recent channel leads (last ~200 lines of ledger, filtered to owner)
  try {
    if (existsSync(CHANNEL_LEADS_FILE)) {
      const lines = readFileSync(CHANNEL_LEADS_FILE, 'utf8').split('\n').filter(Boolean).slice(-500);
      for (const l of lines) {
        try {
          const e = JSON.parse(l);
          if (e.ownerEmail !== owner) continue;
          events.push({
            type: 'lead',
            ts: e.ts,
            channel: e.channel,
            label: `${e.leadScore?.toUpperCase()} lead from ${e.senderName || e.senderId}`,
            detail: e.messagePreview?.slice(0, 100),
            score: e.leadScore,
            category: e.category,
          });
        } catch {}
      }
    }
  } catch {}

  // Bookings — filter to owner
  for (const b of bookings.slice(-100)) {
    if (b.ownerEmail !== owner) continue;
    events.push({
      type: 'booking',
      ts: b.ts || b.date,
      channel: b.channel || 'email',
      label: `Booking: ${b.name || 'anon'}`,
      detail: b.datetime || b.notes || '',
    });
  }

  // Escalations / paused conversations
  for (const [memKey, st] of conversationState) {
    if (!memKey.startsWith(owner + '::')) continue;
    if (st.paused && st.escalatedAt) {
      const [, ch, senderId] = memKey.split('::');
      events.push({
        type: 'handoff',
        ts: st.escalatedAt,
        channel: ch,
        label: `Handed off to you — ${senderId}`,
        detail: st.reason || 'human requested',
      });
    }
  }

  // Recent CSAT ratings
  try {
    if (existsSync(CSAT_FILE)) {
      const lines = readFileSync(CSAT_FILE, 'utf8').split('\n').filter(Boolean).slice(-200);
      for (const l of lines) {
        try {
          const e = JSON.parse(l);
          if (e.ownerEmail !== owner) continue;
          events.push({
            type: 'csat',
            ts: e.ts,
            channel: e.channel,
            label: `${e.rating === 'positive' ? '👍' : '👎'} rating from ${e.senderName || e.senderId}`,
            detail: e.raw?.slice(0, 80),
            rating: e.rating,
          });
        } catch {}
      }
    }
  } catch {}

  events.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  res.json({ events: events.slice(0, limit) });
});

// GET /api/dashboard/channel-gaps — clustered list of unanswered customer
// questions for the Train Aria section. Clusters by simple token-overlap
// so "do you do dog grooming" and "are dogs welcome for grooming" merge.
app.get('/api/dashboard/channel-gaps', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const items = [];
  try {
    if (existsSync(CHANNEL_GAPS_FILE)) {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // last 30 days
      for (const line of readFileSync(CHANNEL_GAPS_FILE, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e.ownerEmail !== owner) continue;
          if (new Date(e.ts).getTime() < cutoff) continue;
          items.push(e);
        } catch {}
      }
    }
  } catch {}
  // Cluster — token jaccard >= 0.4 = same gap
  const tokenise = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 3));
  const clusters = [];
  for (const it of items) {
    const tks = tokenise(it.question);
    let matched = null;
    for (const c of clusters) {
      const inter = [...c.tokens].filter(t => tks.has(t)).length;
      const union = new Set([...c.tokens, ...tks]).size;
      const jaccard = union ? inter / union : 0;
      if (jaccard >= 0.4) { matched = c; break; }
    }
    if (matched) {
      matched.examples.push(it);
      matched.count++;
      matched.lastSeen = it.ts > matched.lastSeen ? it.ts : matched.lastSeen;
      for (const t of tks) matched.tokens.add(t);
    } else {
      clusters.push({ tokens: tks, examples: [it], count: 1, firstSeen: it.ts, lastSeen: it.ts });
    }
  }
  // Sort by count desc — most-asked unanswered questions first
  clusters.sort((a, b) => b.count - a.count);
  res.json({
    clusters: clusters.slice(0, 25).map(c => ({
      count: c.count,
      lastSeen: c.lastSeen,
      examples: c.examples.slice(0, 3).map(e => ({ question: e.question, channel: e.channel, ariaReply: e.ariaReply, reason: e.reason })),
      sampleQuestion: c.examples[0].question,
    })),
    totalGaps: items.length,
  });
});

// POST /api/dashboard/gap-to-kb — owner picks one gap cluster, Claude
// drafts a knowledge document that would have prevented the fallback.
app.post('/api/dashboard/gap-to-kb', express.json({ limit: '32kb' }), async (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const { questions } = req.body || {};
  if (!Array.isArray(questions) || !questions.length) {
    return res.status(400).json({ error: 'questions array required' });
  }
  const profile = getOwnerProfile(owner);
  const businessHint = profile?.profile?.businessName
    ? `\nBUSINESS: ${profile.profile.businessName}${profile.profile.services ? ` — services: ${profile.profile.services}` : ''}`
    : '';
  try {
    const r = await callClaudeWithFallback({
      max_tokens: 800,
      messages: [{ role: 'user', content: `Draft a knowledge document for an AI customer-service bot. Customers have asked these questions but the bot didn't have a confident answer — what should we tell the bot so it CAN answer next time?${businessHint}

UNANSWERED QUESTIONS:
${questions.map((q, i) => `${i + 1}. "${q}"`).join('\n')}

Reply with valid JSON only:
{
  "title": "Short title (e.g. 'Dog grooming services + policy')",
  "content": "200-500 word knowledge doc the bot will cite. Address the questions above. Be honest about what you DON'T know — leave [PLACEHOLDER: ...] markers for facts the owner needs to fill (e.g. [PLACEHOLDER: price for full groom]). Use bullet structure where helpful.",
  "needsOwnerInput": ["short list of placeholders the owner must fill before this doc is useful"]
}` }],
    });
    const text = r.content[0]?.text || '';
    try {
      const parsed = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
      res.json({
        draft: {
          title: parsed.title || 'Knowledge update',
          content: parsed.content || '',
          needsOwnerInput: Array.isArray(parsed.needsOwnerInput) ? parsed.needsOwnerInput : [],
        },
      });
    } catch (e) {
      res.status(500).json({ error: 'AI returned invalid JSON', raw: text.slice(0, 500) });
    }
  } catch (e) {
    res.status(500).json({ error: 'Draft failed: ' + e.message });
  }
});

// POST /api/dashboard/faq-bootstrap — one-click "warm-start" Aria's
// knowledge base. Takes the top N unanswered question clusters and
// drafts a KB article for each in PARALLEL via Claude. Owner reviews +
// bulk-accepts. Designed for cold-start: a brand-new client connects,
// Aria has nothing to RAG against, accuracy suffers — this surfaces
// the 8-10 things customers actually asked, drafts answers in 5
// seconds, and owner approves with one click.
//
// Why bulk vs per-cluster: the per-cluster "Draft answer" button (which
// already exists below) is for ad-hoc one-offs. Bootstrap is for the
// "fix the whole gap" workflow during onboarding.
app.post('/api/dashboard/faq-bootstrap', express.json({ limit: '16kb' }), async (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const limit = Math.max(3, Math.min(15, Number(req.body?.limit) || 10));

  // Pull gap clusters using the same logic as the GET endpoint. Rather
  // than re-write, factor the cluster build into an inline helper here.
  const items = [];
  try {
    if (existsSync(CHANNEL_GAPS_FILE)) {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      for (const line of readFileSync(CHANNEL_GAPS_FILE, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e.ownerEmail !== owner) continue;
          if (new Date(e.ts).getTime() < cutoff) continue;
          items.push(e);
        } catch {}
      }
    }
  } catch {}

  if (items.length === 0) return res.json({ drafts: [], message: 'No gaps to bootstrap from yet.' });

  // Quick token-jaccard pre-cluster (cheap, deterministic)
  const tokenise = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 3));
  const clusters = [];
  for (const it of items) {
    const tks = tokenise(it.question);
    let matched = null;
    for (const c of clusters) {
      const inter = [...c.tokens].filter(t => tks.has(t)).length;
      const union = new Set([...c.tokens, ...tks]).size;
      const jaccard = union ? inter / union : 0;
      if (jaccard >= 0.4) { matched = c; break; }
    }
    if (matched) {
      matched.examples.push(it); matched.count++;
      for (const t of tks) matched.tokens.add(t);
    } else {
      clusters.push({ tokens: tks, examples: [it], count: 1 });
    }
  }
  clusters.sort((a, b) => b.count - a.count);
  const topClusters = clusters.slice(0, limit);

  const profile = getOwnerProfile(owner);
  const businessHint = profile?.profile?.businessName
    ? `\nBUSINESS: ${profile.profile.businessName}${profile.profile.services ? ` — services: ${profile.profile.services}` : ''}`
    : '';

  // Parallel-draft all clusters. Promise.all here is the right call:
  // each draft is independent + Claude rate limits at the account level
  // are generous enough that 10 simultaneous Haiku calls land fine
  // (typically ~3-5s total for 10 vs 30-50s sequential).
  const drafts = await Promise.all(topClusters.map(async (cluster, idx) => {
    const questions = cluster.examples.slice(0, 4).map(e => e.question);
    try {
      const r = await callClaudeWithFallback({
        max_tokens: 600,
        messages: [{ role: 'user', content: `Draft a knowledge document for an AI customer-service bot. Customers have asked these questions but the bot didn't have a confident answer — what should we tell the bot so it CAN answer next time?${businessHint}

UNANSWERED QUESTIONS (cluster ${idx + 1}, asked ${cluster.count}×):
${questions.map((q, i) => `${i + 1}. "${q}"`).join('\n')}

Reply with valid JSON only:
{
  "title": "Short title (e.g. 'Dog grooming services + policy')",
  "content": "150-350 word knowledge doc the bot will cite. Address the questions above. Be honest about what you DON'T know — leave [PLACEHOLDER: short description] markers for facts the owner needs to fill (e.g. [PLACEHOLDER: starting price for full groom]). Use bullet structure where helpful.",
  "needsOwnerInput": ["short list of placeholders the owner must fill"]
}` }],
      });
      const text = r.content[0]?.text || '';
      const parsed = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
      return {
        clusterIdx: idx,
        count: cluster.count,
        sampleQuestion: cluster.examples[0].question,
        draft: {
          title: parsed.title || `Knowledge entry ${idx + 1}`,
          content: parsed.content || '',
          needsOwnerInput: Array.isArray(parsed.needsOwnerInput) ? parsed.needsOwnerInput : [],
        },
      };
    } catch (e) {
      return {
        clusterIdx: idx,
        count: cluster.count,
        sampleQuestion: cluster.examples[0].question,
        error: 'Draft failed: ' + e.message,
      };
    }
  }));

  res.json({
    drafts,
    totalGaps: items.length,
    totalClusters: clusters.length,
  });
});

// POST /api/dashboard/faq-bootstrap/accept — bulk-save approved drafts
// to the owner's knowledge base in one call. Caps at 50 docs total
// (matches single-doc save endpoint).
app.post('/api/dashboard/faq-bootstrap/accept', express.json({ limit: '512kb' }), (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const accepted = Array.isArray(req.body?.accepted) ? req.body.accepted : [];
  if (accepted.length === 0) return res.status(400).json({ error: 'accepted array required' });

  const docs = knowledgeDocs.get(owner) || [];
  let saved = 0, skipped = 0;
  for (const a of accepted) {
    if (!a?.title || !a?.content) { skipped++; continue; }
    if (docs.length >= 50) { skipped++; continue; }
    docs.push({
      title:      String(a.title).slice(0, 120),
      content:    String(a.content).slice(0, 200000),
      uploadedAt: new Date().toISOString(),
      source:     'faq-bootstrap',
    });
    saved++;
  }
  knowledgeDocs.set(owner, docs);
  persistKnowledgeDocs();
  res.json({ ok: true, saved, skipped, totalDocs: docs.length });
});

// POST /api/dashboard/test-aria — sandbox endpoint that runs an owner's
// test question through the SAME pipeline as a live channel message,
// minus the actual send. Returns Aria's full response + classification
// + which knowledge chunks she cited. Lets owner validate training.
app.post('/api/dashboard/test-aria', express.json({ limit: '32kb' }), async (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const { message, simulateChannel = 'instagram' } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });

  const profile = getOwnerProfile(owner);
  const systemPrompt = profile?.systemPrompt || `You are a helpful business assistant for ${owner}.`;
  const allowedTopics = profile?.config?.allowedTopics || profile?.allowedTopics || profile?.profile?.allowedTopics || null;

  // FAQ KB
  const kbEntries = knowledgeBase.get(owner) || [];
  const kbContext = kbEntries.length
    ? '\n\nFREQUENTLY ASKED QUESTIONS:\n' + kbEntries.map(e => `Q: ${e.question}\nA: ${e.answer}`).join('\n\n')
    : '';

  // RAG over uploaded docs
  const ownerDocs = knowledgeDocs.get(owner) || [];
  const ragChunks = ownerDocs.length ? retrieveRelevantChunks(message, ownerDocs, { topK: 3 }) : [];
  const ragContext = ragChunks.length
    ? '\n\nRELEVANT DOCUMENT EXCERPTS (cite these for accuracy — DO NOT make up details not in them):\n' +
      ragChunks.map(c => `[from "${c.title}"] ${c.content}`).join('\n\n')
    : '';

  const channelLimits = {
    whatsapp: 'Keep replies under 300 words. Use short paragraphs. No HTML.',
    instagram: 'Keep replies under 200 words. Casual, friendly tone. No HTML.',
    facebook: 'Keep replies under 300 words. Friendly and professional. No HTML.',
  };
  const channelInstructions = `\n\nYou are replying via ${simulateChannel}. ${channelLimits[simulateChannel] || ''} Never mention you are AI — write as a team member.`;

  try {
    const reply = await generateChannelReply(
      systemPrompt + kbContext + ragContext + channelInstructions,
      'Test User', message,
      { allowedTopics }
    );
    if (!reply) return res.status(500).json({ error: 'Reply generation failed' });
    res.json({
      reply: {
        text: reply.text,
        suggestedReplies: reply.suggestedReplies || [],
        sentiment: reply.sentiment,
        urgency: reply.urgency,
        language: reply.language,
        outOfScope: reply.outOfScope,
        needsHuman: reply.needsHuman,
        handoffReason: reply.handoffReason,
        booking: reply.booking,
        contact: reply.contact,
        showServicesCarousel: reply.showServicesCarousel,
      },
      citedChunks: ragChunks.map(c => ({ title: c.title, preview: c.content.slice(0, 200), score: c.score })),
      tokensUsed: reply._tokensUsed || 0,
    });
  } catch (e) {
    res.status(500).json({ error: 'Test failed: ' + e.message });
  }
});

// POST /api/dashboard/ai-train — one-shot wizard. Takes a website URL
// and/or short business description, scrapes the site (if URL given),
// and asks Claude to draft a knowledge document + service-carousel cards
// + topic-scope chips. Returns the drafts for owner review BEFORE saving.
//
// Per Engineering Rule 12: nothing gets persisted here. The owner reviews
// each draft + clicks Accept per item via the existing knowledge/services/
// scope endpoints. This endpoint is read-only judgment.
app.post('/api/dashboard/ai-train', express.json({ limit: '256kb' }), async (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const { websiteUrl, description } = req.body || {};
  if (!websiteUrl && !description) {
    return res.status(400).json({ error: 'Provide either websiteUrl or description' });
  }

  // Fetch + strip the website if URL given. Cap at 30k chars so prompt stays sane.
  let siteText = '';
  if (websiteUrl) {
    try {
      const u = new URL(websiteUrl.startsWith('http') ? websiteUrl : 'https://' + websiteUrl);
      const r = await fetch(u.toString(), { headers: { 'User-Agent': 'AriaBot/1.0 (+https://aireyai.co.uk)' }, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const html = await r.text();
        // Strip script + style, then tags, then collapse whitespace
        siteText = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&[a-z]+;/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 30000);
      }
    } catch (e) {
      console.warn('[ai-train] site fetch failed:', e.message);
    }
  }

  const userInput = [
    description ? `BUSINESS DESCRIPTION (from owner): ${description}` : '',
    siteText ? `WEBSITE CONTENT (extracted):\n${siteText}` : '',
  ].filter(Boolean).join('\n\n');

  if (!userInput) {
    return res.status(400).json({ error: 'No usable input — website unreachable and no description given' });
  }

  try {
    const r = await callClaudeWithFallback({
      max_tokens: 2000,
      messages: [{ role: 'user', content: `You're helping a small business set up their AI customer-service assistant (Aria). Read the input below and draft three things Aria can use to handle messages from their customers.

INPUT:
${userInput}

Reply with valid JSON only (no preamble, no markdown):
{
  "knowledgeDoc": {
    "title": "Short title (e.g. 'Services + Prices')",
    "content": "Plain-text doc summarising what this business does, services they offer, prices/ranges where mentioned, hours, location, key policies. 200-800 words. Aria will cite this for accurate answers — don't invent details that aren't in the input. Use bullet structure where helpful."
  },
  "services": [
    { "title": "Service name", "subtitle": "Price/duration/key detail", "image": "", "link": "", "btn_text": "Book now" }
  ],
  "allowedTopics": ["topic 1", "topic 2", "topic 3"]
}

Rules:
- knowledgeDoc.content: factual ONLY. If a price/hour/location isn't in the input, don't make one up. Leave gaps for the owner to fill.
- services: 2-5 cards covering the most-asked-for services. Use REAL prices from input if given, else use "Contact for pricing" in subtitle. Leave image + link empty for owner to fill.
- allowedTopics: 3-8 short topic phrases that this business actually handles. E.g. ["scaffolding hire", "scaffolding quotes", "site access"]. Used to politely refuse off-topic questions.
- If input is very thin (e.g. just "a hair salon"), generate plausible defaults but mark obvious placeholders with [PLACEHOLDER: ...] so the owner sees them.` }],
    });
    const text = r.content[0]?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
    } catch (e) {
      return res.status(500).json({ error: 'AI returned invalid JSON', raw: text.slice(0, 500) });
    }
    res.json({
      knowledgeDoc: parsed.knowledgeDoc || null,
      services: Array.isArray(parsed.services) ? parsed.services.slice(0, 10) : [],
      allowedTopics: Array.isArray(parsed.allowedTopics) ? parsed.allowedTopics.filter(t => typeof t === 'string').slice(0, 12) : [],
      siteCharsExtracted: siteText.length,
    });
  } catch (e) {
    console.error('[ai-train] Claude failed:', e);
    res.status(500).json({ error: 'AI draft failed: ' + e.message });
  }
});

// POST /api/dashboard/ai-improve — takes existing draft text + an "instruction"
// (rewrite, expand, shorten, add prices, etc) and returns improved version.
// Used by per-field "✨ Improve with AI" buttons.
app.post('/api/dashboard/ai-improve', express.json({ limit: '256kb' }), async (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const { current, instruction, kind } = req.body || {};
  if (!current && !instruction) return res.status(400).json({ error: 'current or instruction required' });
  const kindHint = kind === 'knowledge' ? 'a knowledge document Aria will cite for customer answers'
    : kind === 'service' ? 'a service-card description shown to customers in a carousel'
    : 'a piece of content for an AI customer-service bot';
  try {
    const r = await callClaudeWithFallback({
      max_tokens: 800,
      messages: [{ role: 'user', content: `Improve the following text. It's ${kindHint}.

CURRENT TEXT:
"""${current || '(blank)'}"""

INSTRUCTION FROM OWNER:
"${instruction || 'Polish for clarity + warmth. Keep it concise.'}"

Rules:
- Don't invent factual details (prices, hours, services) that aren't in the current text.
- Keep the same overall meaning unless instruction says otherwise.
- Plain text only, no markdown formatting, no preamble.

Reply with ONLY the improved text, nothing else.` }],
    });
    const improved = (r.content[0]?.text || '').trim();
    res.json({ improved });
  } catch (e) {
    res.status(500).json({ error: 'Improve failed: ' + e.message });
  }
});

// GET /api/dashboard/conversation/:memKey — full thread for one sender
// (drill-down from the Conversations table). Pulls from conversationMemory
// for raw history + adds metadata (paused state, last lead score, etc.).
app.get('/api/dashboard/conversation/:memKey', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const memKey = decodeURIComponent(req.params.memKey || '');
  if (!memKey.startsWith(owner + '::')) return res.status(403).json({ error: 'not your conversation' });
  const history = conversationMemory.get(memKey) || [];
  const state = conversationState.get(memKey) || {};
  const [, channel, senderId] = memKey.split('::');
  res.json({ memKey, channel, senderId, history, state });
});

// GET /api/dashboard/csat-detail — list recent 👎 ratings with conversation
// preview so owners can learn from negative feedback.
app.get('/api/dashboard/csat-detail', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const negatives = [];
  try {
    if (existsSync(CSAT_FILE)) {
      const lines = readFileSync(CSAT_FILE, 'utf8').split('\n').filter(Boolean).slice(-500);
      for (const l of lines) {
        try {
          const e = JSON.parse(l);
          if (e.ownerEmail !== owner) continue;
          if (e.rating !== 'negative') continue;
          const memKey = `${e.ownerEmail}::${e.channel}::${e.senderId}`;
          const history = (conversationMemory.get(memKey) || []).slice(-6);
          negatives.push({ ...e, history });
        } catch {}
      }
    }
  } catch {}
  negatives.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  res.json({ items: negatives.slice(0, 30) });
});

// GET /api/dashboard/escalations — list paused (handed-off) conversations
app.get('/api/dashboard/escalations', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const items = [];
  for (const [memKey, state] of conversationState) {
    if (!state.paused) continue;
    const [ownerEmail, channel, senderId] = memKey.split('::');
    if (ownerEmail !== owner) continue;
    items.push({ memKey, channel, senderId, escalatedAt: state.escalatedAt, reason: state.reason });
  }
  items.sort((a, b) => (b.escalatedAt || '').localeCompare(a.escalatedAt || ''));
  res.json({ items });
});

// POST /api/dashboard/resume-conversation — owner hands control back to Aria
app.post('/api/dashboard/resume-conversation', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const { memKey } = req.body || {};
  if (!memKey || !memKey.startsWith(owner + '::')) {
    return res.status(400).json({ error: 'invalid memKey' });
  }
  const state = conversationState.get(memKey);
  if (!state) return res.json({ ok: true, note: 'no-op — no paused state' });
  state.paused = false;
  state.resumedAt = new Date().toISOString();
  conversationState.set(memKey, state);
  persistConversationState();
  res.json({ ok: true });
});

// GET /api/dashboard/inbox-log
app.get('/api/dashboard/inbox-log', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 20;
  const ownerLog = replyLog.filter(r => r.ownerEmail === owner).reverse();
  const total = ownerLog.length;
  const items = ownerLog.slice((page - 1) * perPage, page * perPage);
  res.json({ items, page, perPage, total, totalPages: Math.ceil(total / perPage) || 1 });
});

// GET /api/dashboard/leads
app.get('/api/dashboard/leads', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const leads = [];
  const seen = new Set();
  for (const [, s] of sessions) {
    if (!s.leads || !s.leads.length) continue;
    // Match by ownerEmail on session, or by page URL containing owner domain
    const isOwner = s.ownerEmail === owner;
    if (!isOwner) continue;
    for (const leadEmail of s.leads) {
      if (seen.has(leadEmail)) continue;
      seen.add(leadEmail);
      leads.push({
        email: leadEmail,
        name: s.leadName || null,
        phone: s.leadPhone || null,
        score: s.score || null,
        tag: s.tag || null,
        page: s.page || null,
        date: s.lastActivity || s.startedAt
      });
    }
  }
  res.json({ leads });
});

// GET /api/dashboard/bookings
app.get('/api/dashboard/bookings', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const ownerBookings = bookings.filter(b => {
    const bookingOwner = b.ownerEmail || b.alertTo || '';
    return bookingOwner.toLowerCase() === owner.toLowerCase();
  }).reverse().slice(0, 50);
  res.json({ bookings: ownerBookings });
});

// GET /api/dashboard/booking-ics/:filename — owner downloads the .ics for a
// past booking. Auth gated + filename sandboxed to prevent path traversal.
app.get('/api/dashboard/booking-ics/:filename', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const filename = String(req.params.filename || '');
  // Hard sandbox: only allow our own filename pattern
  if (!/^booking-[A-Za-z0-9_\-@.]+\.ics$/.test(filename)) {
    return res.status(400).send('invalid filename');
  }
  const path = join(BOOKING_ICS_DIR, filename);
  try {
    if (!existsSync(path)) return res.status(404).send('not found');
    // Verify this booking belongs to this owner (filename contains owner email)
    if (!filename.includes(owner.replace(/[^a-zA-Z0-9]/g, ''))) {
      return res.status(403).send('not your booking');
    }
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(readFileSync(path));
  } catch (e) {
    res.status(500).send('read failed: ' + e.message);
  }
});

// GET /api/dashboard/profile
app.get('/api/dashboard/profile', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  // Find profile by owner email
  let profile = null;
  for (const [, v] of clientProfiles) {
    if (v.profile?.email === owner) { profile = v.profile; break; }
  }
  res.json({ profile: profile || {} });
});

// POST /api/dashboard/profile
app.post('/api/dashboard/profile', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const { businessName, services, location, phone, email, hours, tone, servicesCarousel, allowedTopics, outbound, schedule, onboardingComplete } = req.body;
  // Find or create profile entry
  let profileKey = null;
  for (const [k, v] of clientProfiles) {
    if (v.profile?.email === owner) { profileKey = k; break; }
  }
  // Partial-update semantics: only set keys that were actually sent so a
  // services-only save doesn't wipe out tone, etc.
  const updates = {};
  if (businessName !== undefined) updates.businessName = businessName || '';
  if (services     !== undefined) updates.services     = services     || '';
  if (location     !== undefined) updates.location     = location     || '';
  if (phone        !== undefined) updates.phone        = phone        || '';
  if (email        !== undefined) updates.email        = email        || owner;
  if (hours        !== undefined) updates.hours        = hours        || '';
  if (tone         !== undefined) updates.tone         = tone         || 'friendly';
  if (servicesCarousel !== undefined) updates.servicesCarousel = Array.isArray(servicesCarousel) ? servicesCarousel : [];
  if (allowedTopics    !== undefined) updates.allowedTopics    = Array.isArray(allowedTopics)    ? allowedTopics    : [];
  if (outbound         !== undefined && typeof outbound === 'object') updates.outbound = outbound;
  if (schedule         !== undefined && typeof schedule === 'object') updates.schedule = schedule;
  if (onboardingComplete !== undefined) updates.onboardingComplete = !!onboardingComplete;
  if (profileKey) {
    const existing = clientProfiles.get(profileKey);
    existing.profile = { ...existing.profile, ...updates };
    clientProfiles.set(profileKey, existing);
  } else {
    clientProfiles.set(owner, { profile: { email: owner, ...updates }, scannedAt: new Date().toISOString() });
  }
  persistProfiles();

  // Resolve the updated profile object for both the auto-reply prompt
  // rebuild and the response body. Previous code referenced an undefined
  // `updatedProfile` symbol — fired on any save by an autoReply-enabled
  // owner.
  const updatedProfile = (profileKey
    ? clientProfiles.get(profileKey)?.profile
    : clientProfiles.get(owner)?.profile) || { email: owner };

  // Update auto-reply prompt if enabled
  const autoReply = EMAIL_AUTO_REPLY_ENABLED.get(owner);
  if (autoReply?.enabled) {
    const prompt = `You are ${updatedProfile.businessName || 'a business assistant'}. Services: ${updatedProfile.services || 'various'}. Location: ${updatedProfile.location || 'N/A'}. Phone: ${updatedProfile.phone || 'N/A'}. Hours: ${updatedProfile.hours || 'N/A'}. Tone: ${updatedProfile.tone || 'friendly'}.`;
    autoReply.systemPrompt = prompt;
    EMAIL_AUTO_REPLY_ENABLED.set(owner, autoReply);
    persistAutoReply();
  }

  res.json({ ok: true, profile: updatedProfile });
});

// GET /api/dashboard/settings
app.get('/api/dashboard/settings', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const config = EMAIL_AUTO_REPLY_ENABLED.get(owner);
  res.json({
    autoReplyEnabled: !!config?.enabled,
    approvalMode: !!config?.config?.approvalMode,
    followUpsEnabled: config?.config?.followUpsEnabled !== false,
    gmailConnected: gmailTokens.has(owner)
  });
});

// POST /api/dashboard/settings
app.post('/api/dashboard/settings', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const { autoReplyEnabled, approvalMode, followUpsEnabled } = req.body;
  const existing = EMAIL_AUTO_REPLY_ENABLED.get(owner) || { enabled: false, systemPrompt: 'You are a helpful business assistant.', config: {} };

  if (autoReplyEnabled !== undefined) existing.enabled = !!autoReplyEnabled;
  if (!existing.config) existing.config = {};
  if (approvalMode !== undefined) existing.config.approvalMode = !!approvalMode;
  if (followUpsEnabled !== undefined) existing.config.followUpsEnabled = !!followUpsEnabled;

  EMAIL_AUTO_REPLY_ENABLED.set(owner, existing);
  persistAutoReply();
  res.json({ ok: true });
});

// Channel config storage
const CHANNELS_FILE = resolve('data/channels.json');
const channelConfigs = new Map(); // ownerEmail → { whatsapp, instagram, sms, facebook }
try {
  const raw = JSON.parse(readFileSync(CHANNELS_FILE, 'utf8'));
  for (const [k, v] of Object.entries(raw)) channelConfigs.set(k, v);
} catch {}
function persistChannels() {
  try { mkdirSync(resolve('data'), { recursive: true }); writeFileSync(CHANNELS_FILE, JSON.stringify(Object.fromEntries(channelConfigs), null, 2)); } catch {}
}

// GET /api/dashboard/channels
app.get('/api/dashboard/channels', (req, res) => {
  const owner = req.query.owner;
  if (!owner) return res.json({ channels: {} });
  res.json({ channels: channelConfigs.get(owner) || {} });
});

// POST /api/dashboard/channels
app.post('/api/dashboard/channels', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const { channel, value } = req.body;
  if (!channel || !value) return res.status(400).json({ error: 'channel and value required' });
  const existing = channelConfigs.get(owner) || {};
  existing[channel] = value;
  channelConfigs.set(owner, existing);
  persistChannels();
  res.json({ ok: true });
});

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
  res.json({ stats, channels, gmailConnected: gmailTokens.has(owner) });
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

// GET /dashboard — Client Dashboard Page
app.get('/dashboard', (req, res) => {
  const ownerEmail = req.query.owner || '';
  const sessionToken = req.query.s || '';

  if (!ownerEmail) return res.redirect('/');

  const hasPassword = dashboardPasswords.has(ownerEmail);

  // No password → redirect to setup
  if (!hasPassword) return res.redirect(`/connect/gmail?owner=${encodeURIComponent(ownerEmail)}`);

  const isAuthenticated = sessionToken && validateSession(sessionToken, ownerEmail);

  // Has password but not authenticated → show login
  if (!isAuthenticated) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Aria — Login</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d1f;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;color:#eee;}
      .box{background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:36px;max-width:400px;width:100%;text-align:center;}
      .logo span{font-size:28px;font-weight:800;color:#fff;letter-spacing:-0.5px;}
      .logo span em{font-style:normal;color:#00e5a0;}
      h2{font-size:18px;margin:24px 0 8px;}
      p{font-size:13px;color:#9898b8;margin-bottom:20px;}
      .email-badge{display:inline-block;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:5px 14px;font-size:13px;color:#fff;font-weight:600;margin-bottom:20px;}
      input[type=password]{width:100%;padding:14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;font-size:15px;color:#eee;font-family:inherit;outline:none;text-align:center;letter-spacing:2px;margin-bottom:16px;}
      input[type=password]:focus{border-color:rgba(0,229,160,0.4);}
      .btn{display:block;width:100%;padding:14px;background:#00e5a0;color:#0d0d1f;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;}
      .btn:hover{opacity:.88;}
      .msg{padding:10px;border-radius:8px;font-size:13px;margin-bottom:14px;display:none;}
      .msg.error{display:block;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.2);color:#ff6b6b;}
      .footer{margin-top:24px;font-size:12px;color:#6b6b8a;}
      .footer a{color:#00e5a0;text-decoration:none;}
    </style>
    </head><body>
    <div class="box">
      <div class="logo"><span>Aria<em>Ai</em></span></div>
      <h2>Welcome back</h2>
      <div class="email-badge">${ownerEmail}</div>
      <div id="msg" class="msg"></div>
      <input type="password" id="pw" placeholder="Enter your password" autofocus onkeydown="if(event.key==='Enter')login()">
      <button class="btn" onclick="login()">Login</button>
      <div class="footer">Powered by <a href="https://aireyai.co.uk">AireyAi</a></div>
    </div>
    <script>
      async function login() {
        const pw = document.getElementById('pw').value;
        if (!pw) return;
        const r = await fetch('/api/dashboard/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({owner:'${ownerEmail}',password:pw}) });
        const data = await r.json();
        if (data.ok) {
          window.location.href = '/dashboard?owner=${encodeURIComponent(ownerEmail)}&s=' + data.token;
        } else {
          const el = document.getElementById('msg');
          el.textContent = data.error || 'Wrong password';
          el.className = 'msg error';
        }
      }
    </script>
    </body></html>`);
  }

  // Authenticated — route brand-new owners through the wizard.
  //
  // "Brand-new" = onboardingComplete is unset AND no existing config
  // signals (no businessName, no knowledge docs, no connected channels).
  // This way pre-this-commit owners who already configured the old way
  // don't get bounced into a fresh wizard — only genuinely fresh accounts
  // do. Wizard itself sets onboardingComplete:true on step 5 so the
  // redirect stops firing for them too.
  const _onboardingProfile = getOwnerProfile(ownerEmail)?.profile;
  const _alreadyConfigured = !!(
       _onboardingProfile?.businessName
    || (knowledgeDocs.get(ownerEmail) || []).length > 0
    || (() => {
         const ch = channelConfigs.get(ownerEmail) || {};
         return ['facebook', 'instagram', 'whatsapp'].some(k => ch[k]?.accessToken);
       })()
    || gmailTokens.has(ownerEmail)
  );
  if (_onboardingProfile
      && !_onboardingProfile.onboardingComplete
      && !_alreadyConfigured
      && !req.query.skipOnboarding) {
    return res.redirect(`/start?owner=${encodeURIComponent(ownerEmail)}&s=${encodeURIComponent(sessionToken)}`);
  }

  // Authenticated — serve the full dashboard
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aria — Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
/* ── Institutional design system — "AI Command Center" ───────────────── */
:root{
  /* surfaces (kept close to originals so inline-styled sections stay coherent) */
  --bg:#0b0b16; --surface-1:#14142099; --surface-2:#161630; --surface-3:#1c1c34;
  --line:rgba(255,255,255,0.07); --line-2:rgba(255,255,255,0.12);
  /* one clean 3-step neutral text scale (replaces the 5 mismatched greys) */
  --text:#f1f1f7; --text-2:#a6a6bf; --text-3:#6c6c85;
  /* single accent + semantics */
  --accent:#00e5a0; --accent-ink:#04130d;
  --accent-06:rgba(0,229,160,0.06); --accent-12:rgba(0,229,160,0.12); --accent-30:rgba(0,229,160,0.30);
  --danger:#ff6b6b; --warn:#fbbf24; --info:#38bdf8; --violet:#9d96ff;
  /* radius + elevation scale */
  --r-sm:9px; --r-md:13px; --r-lg:17px; --r-xl:22px; --r-full:999px;
  --shadow-1:0 1px 2px rgba(0,0,0,0.3);
  --shadow-2:0 8px 24px -8px rgba(0,0,0,0.5),0 2px 6px rgba(0,0,0,0.3);
  --shadow-glow:0 0 0 1px var(--accent-30),0 8px 30px -10px rgba(0,229,160,0.25);
  /* One disciplined grotesque across the board — institutional, systematic,
     professional. Hierarchy comes from weight + size, not a second family. */
  --font-display:'Geist',system-ui,-apple-system,sans-serif;
  --font-body:'Geist',system-ui,-apple-system,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--font-body);background:var(--bg);min-height:100vh;color:var(--text);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  /* layered atmosphere: two faint radial glows + a hairline grain — depth without noise */
  background-image:radial-gradient(900px 500px at 12% -8%,rgba(0,229,160,0.06),transparent 60%),radial-gradient(800px 600px at 110% 0%,rgba(91,79,232,0.07),transparent 55%);
  background-attachment:fixed;}
h1,h2,h3,h4,.stat-card .value,.hero-metric .v,.hero-title{font-family:var(--font-display);letter-spacing:-0.02em;}
a{color:var(--accent);text-decoration:none;}
::selection{background:var(--accent-30);color:#fff;}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px;}
*::-webkit-scrollbar{width:10px;height:10px;}
*::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.08);border-radius:99px;border:2px solid transparent;background-clip:padding-box;}
*::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.16);background-clip:padding-box;}
.topbar{position:sticky;top:0;z-index:100;background:rgba(11,11,22,0.82);backdrop-filter:blur(18px) saturate(1.4);border-bottom:1px solid var(--line);padding:14px 24px;display:flex;align-items:center;justify-content:space-between;}
.topbar .logo span{font-family:var(--font-display);font-size:22px;font-weight:800;color:#fff;letter-spacing:-0.4px;}
.topbar .logo em{font-style:normal;color:var(--accent);}
.topbar .right{display:flex;align-items:center;gap:12px;}
.email-badge{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:4px 12px;font-size:12px;color:#ccc;font-weight:500;}
/* Hero status */
.hero{position:relative;background:linear-gradient(135deg,#15152e 0%,#191940 100%);border:1px solid var(--line-2);border-radius:var(--r-xl);padding:26px;margin-bottom:18px;display:grid;grid-template-columns:auto 1fr auto;gap:24px;align-items:center;box-shadow:var(--shadow-2);overflow:hidden;}
.hero::before{content:'';position:absolute;inset:0;background:radial-gradient(420px 180px at 88% -40%,var(--accent-12),transparent 70%);pointer-events:none;}
.hero-status{display:flex;align-items:center;gap:14px;}
.hero-dot{width:14px;height:14px;border-radius:50%;background:#00e5a0;box-shadow:0 0 12px rgba(0,229,160,0.6);animation:pulse 2.5s ease-in-out infinite;}
.hero-dot.off{background:#ff6b6b;box-shadow:0 0 12px rgba(255,80,80,0.5);animation:none;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
.hero-title{font-size:18px;font-weight:700;color:#fff;line-height:1.2;}
.hero-sub{font-size:12px;color:#9898b8;margin-top:3px;}
.hero-metrics{display:flex;gap:28px;}
.hero-metric{text-align:center;}
.hero-metric .v{font-size:24px;font-weight:800;color:#00e5a0;line-height:1;}
.hero-metric .l{font-size:10.5px;color:#8888aa;margin-top:4px;text-transform:uppercase;letter-spacing:0.6px;}
.hero-actions{display:flex;flex-direction:column;gap:6px;align-items:flex-end;}
.hero-toggle-row{display:flex;align-items:center;gap:8px;font-size:12px;color:#ccc;}
/* Channel chip strip */
.channel-strip{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px;}
.channel-chip{display:flex;align-items:center;gap:8px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r-full);padding:8px 15px;font-size:13px;color:var(--text-2);cursor:pointer;transition:all 0.15s;}
.channel-chip:hover{border-color:var(--line-2);color:var(--text);transform:translateY(-1px);}
.channel-chip.on{border-color:var(--accent-30);}
.channel-chip .chip-dot{width:8px;height:8px;border-radius:50%;background:#6b6b8a;}
.channel-chip.on .chip-dot{background:#00e5a0;box-shadow:0 0 8px rgba(0,229,160,0.5);}
.channel-chip.off .chip-dot{background:#ff6b6b;}
.channel-chip.disconnected{opacity:0.45;}
/* Activity feed */
.activity-feed{background:#161630;border:1px solid rgba(255,255,255,0.06);border-radius:14px;padding:18px;margin-bottom:18px;}
.activity-feed h3{font-size:13px;color:#9898b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:14px;font-weight:600;}
.activity-row{display:flex;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:13px;}
.activity-row:last-child{border-bottom:none;}
.activity-icon{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;}
.activity-icon.lead{background:rgba(0,229,160,0.12);}
.activity-icon.booking{background:rgba(56,189,248,0.12);}
.activity-icon.handoff{background:rgba(251,191,36,0.12);}
.activity-icon.csat{background:rgba(155,89,182,0.12);}
.activity-meta{flex:1;min-width:0;}
.activity-label{color:#eee;font-weight:500;}
.activity-detail{color:#8888aa;font-size:11.5px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.activity-time{font-size:11px;color:#6b6b8a;flex-shrink:0;}
.activity-channel{font-size:10px;background:rgba(255,255,255,0.06);color:#9898b8;padding:1px 7px;border-radius:10px;text-transform:capitalize;}
/* Analytics */
.analytics{background:#161630;border:1px solid rgba(255,255,255,0.06);border-radius:14px;padding:18px;margin-bottom:18px;}
.analytics-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
.analytics-head h3{font-size:13px;color:#9898b8;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;}
.analytics-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;}
.ana-card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.05);border-radius:12px;padding:14px;}
.ana-card .ana-title{font-size:11.5px;color:#8888aa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;font-weight:600;}
.ana-card svg{display:block;margin:0 auto;}
.ana-legend{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;font-size:10.5px;color:#8888aa;}
.ana-legend .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:middle;}
.wow-pill{display:inline-flex;align-items:center;gap:4px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:3px 10px;font-size:11.5px;color:#9898b8;}
.wow-pill.up{color:#00e5a0;border-color:rgba(0,229,160,0.3);background:rgba(0,229,160,0.06);}
.wow-pill.down{color:#ff6b6b;border-color:rgba(255,107,107,0.3);background:rgba(255,107,107,0.06);}
.ana-stack{display:flex;flex-direction:column;gap:6px;}
.ana-row{display:flex;align-items:center;gap:8px;font-size:12px;color:#ccc;}
.ana-row .bar{flex:1;height:6px;background:rgba(255,255,255,0.05);border-radius:4px;overflow:hidden;position:relative;}
.ana-row .bar-fill{height:100%;background:#00e5a0;border-radius:4px;}
.ana-row .label{min-width:90px;color:#aaa;text-transform:capitalize;}
.ana-row .count{min-width:30px;text-align:right;font-weight:600;color:#fff;font-size:11.5px;}
@media(max-width:700px){.analytics-grid{grid-template-columns:1fr;}}
/* Section status badges */
.section-header .badge-attn{background:rgba(251,191,36,0.15);color:#fbbf24;border:1px solid rgba(251,191,36,0.3);padding:2px 8px;border-radius:10px;font-size:10.5px;font-weight:600;margin-left:8px;}
/* Drill-down modal */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:500;display:none;align-items:center;justify-content:center;padding:20px;}
.modal-overlay.show{display:flex;}
.modal{background:#161630;border:1px solid rgba(255,255,255,0.1);border-radius:16px;max-width:640px;width:100%;max-height:80vh;overflow-y:auto;padding:24px;}
.modal h3{font-size:16px;color:#fff;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;}
.modal .close-x{background:none;border:none;color:#8888aa;font-size:22px;cursor:pointer;line-height:1;}
.thread-msg{padding:10px 14px;margin-bottom:8px;border-radius:10px;font-size:13px;line-height:1.5;max-width:85%;}
.thread-msg.them{background:#1f1f3a;color:#eee;}
.thread-msg.us{background:rgba(0,229,160,0.12);color:#cfffe8;margin-left:auto;}
.thread-msg.summary{background:rgba(155,89,182,0.08);border:1px dashed rgba(155,89,182,0.3);color:#c9a4dc;font-style:italic;}
.thread-meta{font-size:10.5px;color:#6b6b8a;margin-bottom:4px;}
/* CTAs */
.cta-card{background:linear-gradient(135deg,rgba(0,229,160,0.08),rgba(0,229,160,0.02));border:1px dashed rgba(0,229,160,0.3);border-radius:12px;padding:18px 22px;text-align:center;margin:8px 0;}
.cta-card h4{font-size:14px;color:#fff;margin-bottom:6px;font-weight:600;}
.cta-card p{font-size:12.5px;color:#9898b8;margin-bottom:12px;}
.cta-btn{display:inline-block;background:#00e5a0;color:#0d0d1f;padding:8px 18px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;border:none;cursor:pointer;font-family:inherit;}
.btn-logout{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:6px 14px;font-size:12px;color:#ff6b6b;cursor:pointer;font-family:inherit;font-weight:500;}
.btn-logout:hover{background:rgba(255,80,80,0.1);}
.container{max-width:960px;margin:0 auto;padding:24px 16px 60px;}
.stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:28px;}
.stat-card{background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r-lg);padding:20px;text-align:center;box-shadow:var(--shadow-1);transition:transform .18s cubic-bezier(.2,.8,.2,1),border-color .18s;}
.stat-card:hover{transform:translateY(-2px);border-color:var(--line-2);}
.stat-card .value{font-size:34px;font-weight:800;color:var(--accent);line-height:1.05;font-variant-numeric:tabular-nums;}
.stat-card .label{font-size:11.5px;color:var(--text-3);margin-top:7px;text-transform:uppercase;letter-spacing:0.7px;font-weight:600;}
.stat-card .sub{font-size:11px;color:var(--text-3);margin-top:4px;}
.stat-card.status-on .value{color:var(--accent);}
.stat-card.status-off .value{color:var(--danger);}
.section{background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r-lg);margin-bottom:14px;overflow:hidden;box-shadow:var(--shadow-1);transition:border-color .18s;}
.section.open{border-color:var(--line-2);}
.section-header{padding:17px 20px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;user-select:none;transition:background 0.15s;}
.section-header:hover{background:rgba(255,255,255,0.025);}
.section-header h3{font-size:15.5px;font-weight:600;display:flex;align-items:center;gap:9px;color:var(--text);}
.section-header .arrow{font-size:12px;color:#6b6b8a;transition:transform 0.2s;}
.section.open .arrow{transform:rotate(90deg);}
.section-body{display:none;padding:0 20px 20px;animation:fadeIn 0.2s;}
.section.open .section-body{display:block;}
@keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
table{width:100%;border-collapse:collapse;font-size:13px;}
th{text-align:left;padding:8px 10px;color:#6b6b8a;font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid rgba(255,255,255,0.06);}
td{padding:10px;border-bottom:1px solid rgba(255,255,255,0.04);color:#ccc;}
tr:last-child td{border-bottom:none;}
.empty{text-align:center;padding:24px;color:#6b6b8a;font-size:13px;}
.pagination{display:flex;justify-content:center;gap:8px;margin-top:12px;}
.pagination button{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:6px 12px;color:#ccc;cursor:pointer;font-size:12px;font-family:inherit;}
.pagination button:hover{background:rgba(0,229,160,0.1);border-color:rgba(0,229,160,0.3);}
.pagination button.active{background:#00e5a0;color:#0d0d1f;border-color:#00e5a0;font-weight:600;}
.form-group{margin-bottom:14px;}
.form-group label{display:block;font-size:12px;color:#8888aa;margin-bottom:5px;font-weight:500;}
.form-group input,.form-group select,.form-group textarea{width:100%;padding:11px 13px;background:rgba(255,255,255,0.035);border:1px solid var(--line-2);border-radius:var(--r-sm);font-size:14px;color:var(--text);font-family:inherit;outline:none;transition:border-color .15s,box-shadow .15s,background .15s;}
.form-group input::placeholder,.form-group textarea::placeholder{color:var(--text-3);}
.form-group input:focus,.form-group select:focus,.form-group textarea:focus{border-color:var(--accent);background:rgba(0,229,160,0.04);box-shadow:0 0 0 3px var(--accent-12);}
.form-group textarea{resize:vertical;min-height:60px;}
.form-group select{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%238888aa' d='M6 8L1 3h10z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;}
.btn-save{background:linear-gradient(180deg,#00f5ac,#00d492);color:var(--accent-ink);border:none;border-radius:var(--r-sm);padding:12px 28px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:0 6px 18px -6px rgba(0,229,160,0.5);transition:transform .15s,box-shadow .15s,filter .15s;}
.btn-save:hover{transform:translateY(-1px);filter:brightness(1.05);box-shadow:0 10px 24px -8px rgba(0,229,160,0.6);}
.btn-save:active{transform:translateY(0);}
.toggle-row{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.04);}
.toggle-row:last-child{border-bottom:none;}
.toggle-row .info{font-size:13px;color:#ccc;}
.toggle-row .info small{display:block;color:#6b6b8a;font-size:11px;margin-top:2px;}
.toggle{position:relative;width:44px;height:24px;flex-shrink:0;}
.toggle input{opacity:0;width:0;height:0;}
.toggle .slider{position:absolute;inset:0;background:rgba(255,255,255,0.1);border-radius:24px;cursor:pointer;transition:background 0.2s;}
.toggle .slider:before{content:'';position:absolute;width:18px;height:18px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:transform 0.2s;}
.toggle input:checked+.slider{background:#00e5a0;}
.toggle input:checked+.slider:before{transform:translateX(20px);}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#00e5a0;color:#0d0d1f;padding:10px 24px;border-radius:10px;font-size:13px;font-weight:600;opacity:0;transition:opacity 0.3s;pointer-events:none;z-index:200;}
.toast.show{opacity:1;}
.badge-on{display:inline-block;background:rgba(0,229,160,0.15);color:#00e5a0;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600;}
.badge-off{display:inline-block;background:rgba(255,80,80,0.15);color:#ff6b6b;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600;}
.gmail-link{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:16px;padding:14px 24px;background:#fff;border:1.5px solid #ddd;border-radius:12px;font-size:15px;font-weight:600;color:#333;text-decoration:none;transition:all .15s;}
.gmail-link:hover{background:#f8f8f8;transform:translateY(-1px);}
.gmail-link svg{width:20px;height:20px;}
.gmail-card{background:linear-gradient(135deg,rgba(0,229,160,0.08),rgba(0,229,160,0.02));border:1px solid rgba(0,229,160,0.2);border-radius:14px;padding:20px;margin-bottom:16px;text-align:center;}
.gmail-card p{font-size:13px;color:#9898b8;margin-bottom:14px;}
/* ── Home greeting ──────────────────────────────────────────────────── */
.home-greet{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:18px;}
.greet-hi{font-family:var(--font-display);font-size:27px;font-weight:800;color:var(--text);letter-spacing:-0.03em;line-height:1.1;}
.greet-sub{font-size:13px;color:var(--text-2);margin-top:4px;}
.greet-date{font-size:12px;color:var(--text-3);text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;}
@media(max-width:700px){.greet-hi{font-size:22px;}.greet-date{display:none;}}
/* ── Sidebar navigation ─────────────────────────────────────────────── */
.sidebar{position:fixed;top:55px;left:0;width:236px;height:calc(100vh - 55px);overflow-y:auto;padding:18px 12px 24px;border-right:1px solid var(--line);background:rgba(10,10,20,0.45);backdrop-filter:blur(10px);display:flex;flex-direction:column;gap:3px;z-index:50;}
.nav-label{font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.9px;font-weight:700;padding:16px 12px 7px;}
.nav-group{display:flex;flex-direction:column;gap:3px;}
.nav-item{display:flex;align-items:center;gap:11px;padding:10px 12px;border:none;background:none;color:var(--text-2);font-family:inherit;font-size:13.5px;font-weight:500;border-radius:var(--r-sm);cursor:pointer;text-align:left;width:100%;transition:background .14s,color .14s,box-shadow .14s;}
.nav-item .ni-ic{font-size:16px;width:20px;text-align:center;flex-shrink:0;}
.nav-item:hover{background:rgba(255,255,255,0.05);color:var(--text);}
.nav-item.active{background:var(--accent-12);color:var(--accent);font-weight:600;box-shadow:inset 3px 0 0 var(--accent);}
.container{margin-left:236px;}
/* In sidebar/panel mode the sections are full pages, not accordions */
.section .arrow{display:none;}
.section .section-header{cursor:default;padding:20px 22px 16px;}
.section .section-header:hover{background:none;}
.section .section-header h3{font-size:18px;letter-spacing:-0.02em;}
/* Premium panel-switch entrance */
@keyframes panelIn{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
.panel-enter{animation:panelIn .28s cubic-bezier(.2,.8,.2,1);}
/* Skeleton loaders — the institutional alternative to "Loading…" text */
@keyframes shimmer{0%{background-position:-400px 0}100%{background-position:400px 0}}
.skeleton{background:linear-gradient(90deg,rgba(255,255,255,0.04) 25%,rgba(255,255,255,0.09) 37%,rgba(255,255,255,0.04) 63%);background-size:800px 100%;animation:shimmer 1.4s ease-in-out infinite;border-radius:8px;}
.sk-row{height:14px;margin:9px 0;}
.sk-card{height:78px;border-radius:var(--r-lg);}
.sk-wrap{display:flex;flex-direction:column;gap:2px;padding:4px 0;}
/* Polished empty states */
.empty-state{text-align:center;padding:38px 24px;}
.empty-state .es-ic{font-size:34px;margin-bottom:10px;opacity:.9;}
.empty-state .es-t{font-family:var(--font-display);font-size:15px;font-weight:700;color:var(--text);margin-bottom:5px;}
.empty-state .es-s{font-size:12.5px;color:var(--text-2);line-height:1.6;max-width:340px;margin:0 auto;}
/* Numbers don't jitter as they update */
.stat-card .value,.hero-metric .v,.ana-row .count,td{font-variant-numeric:tabular-nums;}
/* Row micro-interactions */
tbody tr{transition:background .12s;}
tbody tr:hover{background:rgba(255,255,255,0.025);}
.activity-row{transition:background .12s;border-radius:8px;}
.activity-row:hover{background:rgba(255,255,255,0.025);}
/* Topbar ghost buttons (cleaner than the old inline tutorial button) */
.tb-ghost{background:rgba(255,255,255,0.05);border:1px solid var(--line-2);border-radius:var(--r-sm);padding:6px 13px;font-size:12px;color:var(--text-2);cursor:pointer;font-family:inherit;font-weight:500;transition:all .14s;}
.tb-ghost:hover{background:rgba(255,255,255,0.09);color:var(--text);}
/* ⌘K command palette */
.cmdk-overlay{position:fixed;inset:0;background:rgba(5,5,12,0.62);backdrop-filter:blur(5px);z-index:600;display:none;align-items:flex-start;justify-content:center;padding-top:13vh;}
.cmdk-overlay.show{display:flex;}
.cmdk-box{width:100%;max-width:560px;background:var(--surface-2);border:1px solid var(--line-2);border-radius:var(--r-lg);box-shadow:var(--shadow-2);overflow:hidden;animation:panelIn .18s ease;}
.cmdk-input{width:100%;padding:17px 20px;background:none;border:none;border-bottom:1px solid var(--line);color:var(--text);font-family:var(--font-body);font-size:16px;outline:none;}
.cmdk-input::placeholder{color:var(--text-3);}
.cmdk-list{max-height:340px;overflow-y:auto;padding:8px;}
.cmdk-item{display:flex;align-items:center;gap:12px;padding:11px 13px;border-radius:var(--r-sm);font-size:14px;color:var(--text-2);cursor:pointer;}
.cmdk-item .cmdk-ic{font-size:16px;width:22px;text-align:center;flex-shrink:0;}
.cmdk-item .cmdk-grp{margin-left:auto;font-size:10.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.6px;}
.cmdk-item.sel{background:var(--accent-12);color:var(--accent);}
.cmdk-item.sel .cmdk-grp{color:var(--accent);opacity:.7;}
.cmdk-empty{padding:26px;text-align:center;color:var(--text-3);font-size:13px;}
.cmdk-foot{display:flex;gap:18px;padding:10px 18px;border-top:1px solid var(--line);font-size:11px;color:var(--text-3);}
.cmdk-foot b{color:var(--text-2);font-weight:600;}
/* Panel header action buttons (Refresh, Export, …) */
.panel-actions{display:flex;gap:7px;align-items:center;}
.panel-action{display:inline-flex;align-items:center;gap:5px;background:rgba(255,255,255,0.05);border:1px solid var(--line-2);border-radius:var(--r-sm);padding:6px 12px;font-size:11.5px;color:var(--text-2);cursor:pointer;font-family:inherit;font-weight:600;transition:all .14s;}
.panel-action:hover{background:rgba(255,255,255,0.09);color:var(--text);border-color:var(--line-2);}
.panel-action.primary{background:var(--accent-12);border-color:var(--accent-30);color:var(--accent);}
.panel-action.primary:hover{background:rgba(0,229,160,0.18);}
@media(max-width:900px){
  .sidebar{position:sticky;top:55px;width:auto;height:auto;flex-direction:row;align-items:center;overflow-x:auto;overflow-y:hidden;border-right:none;border-bottom:1px solid var(--line);gap:6px;padding:10px 12px;}
  .sidebar .nav-label{display:none;}
  .nav-group{flex-direction:row;gap:6px;}
  .nav-item{white-space:nowrap;padding:9px 13px;font-size:13px;}
  .nav-item .ni-ic{display:none;}
  .container{margin-left:0;}
}
@media(max-width:700px){
  .topbar{padding:12px 16px;}
  .topbar .logo span{font-size:18px;}
  .email-badge{display:none;}
  .hero{grid-template-columns:1fr;gap:14px;padding:18px;}
  .hero-metrics{justify-content:flex-start;gap:18px;}
  .hero-actions{align-items:flex-start;}
  .stats-row{grid-template-columns:1fr 1fr;}
  .stat-card .value{font-size:24px;}
  table{font-size:12px;}
  td,th{padding:8px 6px;}
  .channel-strip{gap:6px;}
  .channel-chip{padding:6px 10px;font-size:12px;}
}
</style>
</head><body>

<div class="topbar">
  <div class="logo"><span>Aria<em>Ai</em></span></div>
  <div class="right">
    <div class="email-badge">${ownerEmail}</div>
    <button class="tb-ghost" onclick="openPalette()" title="Search (⌘K)">⌘ K</button>
    <button class="tb-ghost" onclick="localStorage.removeItem('_aria_tutorial_done');location.reload()">? Tutorial</button>
    <button class="btn-logout" onclick="logout()">Logout</button>
  </div>
</div>

<aside class="sidebar" id="sidebar">
  <nav class="nav-group">
    <button class="nav-item active" data-panel="home" onclick="showPanel('home')"><span class="ni-ic">🏠</span>Home</button>
    <button class="nav-item" data-panel="conversations" onclick="showPanel('conversations')"><span class="ni-ic">💬</span>Conversations</button>
    <button class="nav-item" data-panel="leads" onclick="showPanel('leads')"><span class="ni-ic">🎯</span>Leads</button>
    <button class="nav-item" data-panel="customers" onclick="showPanel('customers')"><span class="ni-ic">👥</span>Customers</button>
    <button class="nav-item" data-panel="bookings" onclick="showPanel('bookings')"><span class="ni-ic">📅</span>Bookings</button>
  </nav>
  <div class="nav-label">Manage</div>
  <nav class="nav-group">
    <button class="nav-item" data-panel="train" onclick="showPanel('train')"><span class="ni-ic">🧠</span>Train Aria</button>
    <button class="nav-item" data-panel="channels" onclick="showPanel('channels')"><span class="ni-ic">🔗</span>Channels</button>
    <button class="nav-item" data-panel="profile" onclick="showPanel('profile')"><span class="ni-ic">🏢</span>Business</button>
    <button class="nav-item" data-panel="settings" onclick="showPanel('settings')"><span class="ni-ic">⚙️</span>Settings</button>
  </nav>
</aside>

<div class="container">

  <!-- Escalations banner (only when present) -->
  <div id="escalations-banner" style="display:none;"></div>

  <!-- HOME PANEL: overview (hero + channels + activity + analytics + stats) -->
  <div id="panel-home">
  <div class="home-greet">
    <div>
      <div class="greet-hi" id="greet-hi">Welcome back</div>
      <div class="greet-sub" id="greet-sub">Here's how Aria is doing</div>
    </div>
    <div class="greet-date" id="greet-date"></div>
  </div>
  <!-- HERO STATUS BAR -->
  <div class="hero" id="hero-status">
    <div class="hero-status">
      <div class="hero-dot" id="hero-dot"></div>
      <div>
        <div class="hero-title" id="hero-title">Aria is loading…</div>
        <div class="hero-sub" id="hero-sub">—</div>
      </div>
    </div>
    <div class="hero-metrics" id="hero-metrics">
      <div class="hero-metric"><div class="v">—</div><div class="l">Today</div></div>
    </div>
    <div class="hero-actions" id="hero-actions"></div>
  </div>

  <!-- CHANNEL CHIPS (always visible, one row, on/off per channel) -->
  <div class="channel-strip" id="channel-strip">
    <div style="font-size:12px;color:#6b6b8a;">Loading channels…</div>
  </div>

  <!-- ACTIVITY FEED -->
  <div class="activity-feed">
    <h3>🕐 Recent Activity</h3>
    <div id="activity-list"><div class="empty" style="padding:14px 0">Loading…</div></div>
  </div>

  <!-- ANALYTICS — 7-day rollup charts -->
  <div class="analytics" id="analytics-panel">
    <div class="analytics-head"><h3>📊 This week</h3><div id="ana-wow"></div></div>
    <div class="analytics-grid" id="ana-grid">
      <div class="empty" style="padding:14px 0">Loading…</div>
    </div>
  </div>

  <!-- STATS GRID (compact, secondary) -->
  <div class="stats-row" id="stats-row">
    <div class="stat-card"><div class="value">—</div><div class="label">Loading...</div></div>
  </div>

  </div><!-- /panel-home -->

  <!-- DRILL-DOWN SECTIONS (each shown as a full panel via the sidebar) -->

  <!-- Conversations — merged inbox log + channel messages -->
  <div class="section" id="sec-conversations">
    <div class="section-header" onclick="toggleSection('conversations')">
      <h3>&#x1F4AC; Conversations</h3>
      <div class="panel-actions"><button class="panel-action" onclick="event.stopPropagation();refreshPanel('conversations')">↻ Refresh</button></div>
    </div>
    <div class="section-body" id="body-conversations">
      <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;">
        <button onclick="loadUnifiedConvs('all')" class="conv-filter active" data-filter="all" style="background:rgba(0,229,160,0.15);color:#00e5a0;border:1px solid rgba(0,229,160,0.3);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:inherit;">All</button>
        <button onclick="loadUnifiedConvs('email')" class="conv-filter" data-filter="email" style="background:rgba(255,255,255,0.06);color:#ccc;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:inherit;">📧 Email</button>
        <button onclick="loadUnifiedConvs('facebook')" class="conv-filter" data-filter="facebook" style="background:rgba(255,255,255,0.06);color:#ccc;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:inherit;">📘 Messenger</button>
        <button onclick="loadUnifiedConvs('instagram')" class="conv-filter" data-filter="instagram" style="background:rgba(255,255,255,0.06);color:#ccc;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:inherit;">📷 Instagram</button>
        <button onclick="loadUnifiedConvs('whatsapp')" class="conv-filter" data-filter="whatsapp" style="background:rgba(255,255,255,0.06);color:#ccc;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:inherit;">💬 WhatsApp</button>
      </div>
      <div id="conversations-list"><div class="empty">Loading...</div></div>
    </div>
  </div>

  <!-- Leads -->
  <div class="section" id="sec-leads">
    <div class="section-header" onclick="toggleSection('leads')">
      <h3>&#x1F464; Leads</h3>
      <div class="panel-actions"><button class="panel-action" onclick="event.stopPropagation();exportLeads()">↧ Export CSV</button><button class="panel-action" onclick="event.stopPropagation();refreshPanel('leads')">↻ Refresh</button></div>
    </div>
    <div class="section-body" id="body-leads"><div class="empty">Loading...</div></div>
  </div>

  <!-- Customers — repeat-customer profile drill-down -->
  <div class="section" id="sec-customers">
    <div class="section-header" onclick="toggleSection('customers')">
      <h3>&#x1F465; Customers</h3>
      <div class="panel-actions"><button class="panel-action" onclick="event.stopPropagation();refreshPanel('customers')">↻ Refresh</button></div>
    </div>
    <div class="section-body" id="body-customers"><div class="empty">Loading...</div></div>
  </div>

  <!-- Bookings -->
  <div class="section" id="sec-bookings">
    <div class="section-header" onclick="toggleSection('bookings')">
      <h3>&#x1F4C5; Upcoming Bookings</h3>
      <div class="panel-actions"><button class="panel-action" onclick="event.stopPropagation();refreshPanel('bookings')">↻ Refresh</button></div>
    </div>
    <div class="section-body" id="body-bookings"><div class="empty">Loading...</div></div>
  </div>

  <!-- Train Aria (new — KB + Knowledge docs + Services + Scope) -->
  <div class="section" id="sec-train">
    <div class="section-header" onclick="toggleSection('train')">
      <h3>&#x1F9E0; Train Aria</h3>
      <span class="arrow">&#x25B6;</span>
    </div>
    <div class="section-body" id="body-train"><div class="empty">Loading...</div></div>
  </div>

  <!-- Channels (now a deeper drill-down — chips up top handle quick toggle) -->
  <div class="section" id="sec-channels">
    <div class="section-header" onclick="toggleSection('channels')">
      <h3>&#x1F517; Manage Channels</h3>
      <span class="arrow">&#x25B6;</span>
    </div>
    <div class="section-body" id="body-channels">
      <div style="padding:8px 0;">
        <p style="font-size:13px;color:#9898b8;margin-bottom:16px;">Connect Aria to your channels. Once connected they <b>stay connected</b> — you won't need to do this again.</p>

        <a href="/connect/meta?owner=${encodeURIComponent(ownerEmail)}&s=${encodeURIComponent(sessionToken)}" id="meta-connect-btn" style="display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:13px;background:#1877F2;color:#fff;border:none;border-radius:12px;font-size:14px;font-weight:600;text-decoration:none;margin-bottom:6px;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
          <span>Connect Facebook (Page + Messenger)</span>
        </a>
        <p style="font-size:11.5px;color:#8888aa;margin:0 0 14px;padding:0 4px;line-height:1.5;">🔒 You'll log in with your personal Facebook so Meta can verify you're a Page admin — but Aria <b>only connects to the Business Page you select</b>. She never sees your personal DMs, posts, or friends. If you admin multiple Pages, you'll get to pick which one.</p>

        <a href="/connect/instagram?owner=${encodeURIComponent(ownerEmail)}&s=${encodeURIComponent(sessionToken)}" id="ig-connect-btn" style="display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:13px;background:linear-gradient(45deg,#FED373 0%,#F15245 35%,#D92E7F 65%,#9B36B7 100%);color:#fff;border:none;border-radius:12px;font-size:14px;font-weight:600;text-decoration:none;margin-bottom:20px;box-shadow:0 4px 14px rgba(217,46,127,0.25);">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>
          <span>Connect Instagram (DMs)</span>
        </a>

        <a class="gmail-link" id="gmail-connect-btn" href="/connect/gmail?owner=\${encodeURIComponent(OWNER)}&s=\${encodeURIComponent(TOKEN)}" style="margin-top:0;margin-bottom:20px;">
          <svg viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
          Connect Gmail (Inbox + Auto-reply)
        </a>

        <div id="gmail-status-row" style="margin-bottom:12px;"></div>
        <div id="channel-cards" style="display:flex;flex-direction:column;gap:12px;"></div>
      </div>
    </div>
  </div>

  <!-- Business Profile -->
  <div class="section" id="sec-profile">
    <div class="section-header" onclick="toggleSection('profile')">
      <h3>&#x1F3E2; Business Profile</h3>
      <span class="arrow">&#x25B6;</span>
    </div>
    <div class="section-body" id="body-profile"><div class="empty">Loading...</div></div>
  </div>

  <!-- Settings (small at bottom) -->
  <div class="section" id="sec-settings">
    <div class="section-header" onclick="toggleSection('settings')">
      <h3>&#x2699;&#xFE0F; Settings</h3>
      <span class="arrow">&#x25B6;</span>
    </div>
    <div class="section-body" id="body-settings"><div class="empty">Loading...</div></div>
  </div>

</div>

<!-- Drill-down modal for conversation threads + CSAT detail -->
<div class="modal-overlay" id="modal-overlay" onclick="if(event.target.id==='modal-overlay')closeModal()">
  <div class="modal" id="modal-content"></div>
</div>

<div class="toast" id="toast"></div>

<!-- ⌘K command palette -->
<div class="cmdk-overlay" id="cmdk" onclick="if(event.target.id==='cmdk')closePalette()">
  <div class="cmdk-box">
    <input id="cmdk-input" class="cmdk-input" placeholder="Search panels &amp; actions…" oninput="renderPalette(this.value)" autocomplete="off" spellcheck="false">
    <div class="cmdk-list" id="cmdk-list"></div>
    <div class="cmdk-foot"><span><b>↑↓</b> navigate</span><span><b>↵</b> open</span><span><b>esc</b> close</span></div>
  </div>
</div>

<script>
const OWNER = '${ownerEmail}';
const TOKEN = '${sessionToken}';
const Q = 'owner=' + encodeURIComponent(OWNER) + '&s=' + encodeURIComponent(TOKEN);
const loaded = {};
// Sidebar panel names — declared at top so showPanel() (called during init,
// further down) never hits a temporal-dead-zone on this const. Browser-side
// TDZ is invisible to node --check, which is why this broke every button.
const PANEL_NAMES = ['conversations','leads','customers','bookings','train','channels','profile','settings'];
const SKELETON_HTML = '<div class="sk-wrap">' + ['60%','85%','72%','90%','50%'].map(function(w){ return '<div class="skeleton sk-row" style="width:' + w + '"></div>'; }).join('') + '</div>';

function api(path) { return fetch(path + (path.includes('?') ? '&' : '?') + Q).then(r => r.json()); }
function apiPost(path, body) {
  return fetch(path + (path.includes('?') ? '&' : '?') + Q, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
  }).then(r => r.json());
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

function logout() {
  window.location.href = '/dashboard?owner=' + encodeURIComponent(OWNER);
}

function timeAgo(dateStr) {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days + 'd ago';
}

function escH(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// Load stats + hero + chips + activity immediately
async function loadStats() {
  try {
    const [d, ch] = await Promise.all([
      api('/api/dashboard/stats'),
      api('/api/dashboard/channel-stats'),
    ]);
    const chTotal = ch.stats?.total || 0;
    const channels = ch.channels || {};
    const csat = d.csat || { total: 0, scorePct: null };

    // ─── HERO STATUS ───────────────────────────────────────────────────
    // Aria's overall status: ON if any auto-reply channel is enabled, OFF otherwise
    const anyChannelOn = ['facebook','instagram','whatsapp'].some(c => channels[c]?.enabled);
    const anyChannelConnected = ['facebook','instagram','whatsapp'].some(c => channels[c]?.accessToken);
    const isLive = d.autoReplyEnabled || anyChannelOn;
    const lastActivity = chTotal ? (channels.facebook?.lastReply || channels.instagram?.lastReply || channels.whatsapp?.lastReply) : null;
    const heroDot = document.getElementById('hero-dot');
    heroDot.classList.toggle('off', !isLive);
    document.getElementById('hero-title').textContent = isLive ? 'Aria is working for you' : 'Aria is paused';
    document.getElementById('hero-sub').textContent = lastActivity
      ? 'Last reply ' + timeAgo(lastActivity)
      : (anyChannelConnected ? 'Waiting for the first message…' : 'No channels connected yet — scroll down to connect one');
    document.getElementById('hero-metrics').innerHTML =
      '<div class="hero-metric"><div class="v">' + chTotal + '</div><div class="l">Replies</div></div>' +
      '<div class="hero-metric"><div class="v">' + d.leads.total + '</div><div class="l">Leads</div></div>' +
      '<div class="hero-metric"><div class="v">' + d.bookings.total + '</div><div class="l">Bookings</div></div>' +
      (csat.scorePct != null ? '<div class="hero-metric" style="cursor:pointer" onclick="showCsatDetail()" title="Click to see negative ratings"><div class="v" style="color:' + (csat.scorePct >= 80 ? '#00e5a0' : csat.scorePct >= 50 ? '#fbbf24' : '#ff6b6b') + '">' + csat.scorePct + '%</div><div class="l">CSAT</div></div>' : '');
    // Hero actions: master pause/resume (visual only — channel-toggle is per-channel via chips)
    document.getElementById('hero-actions').innerHTML =
      '<div style="font-size:11px;color:#6b6b8a;">' + d.emailsReplied.week + ' emails / ' + d.bookings.week + ' bookings this week</div>';

    // ─── CHANNEL CHIPS ─────────────────────────────────────────────────
    const channelDefs = [
      { key: 'facebook', name: 'Messenger', icon: '📘' },
      { key: 'instagram', name: 'Instagram', icon: '📷' },
      { key: 'whatsapp', name: 'WhatsApp', icon: '💬' },
      { key: 'email', name: 'Email', icon: '📧' },
    ];
    const stripEl = document.getElementById('channel-strip');
    stripEl.innerHTML = channelDefs.map(def => {
      let connected, enabled, label;
      if (def.key === 'email') {
        connected = d.gmailConnected;
        enabled = d.autoReplyEnabled;
        label = connected ? (enabled ? 'On' : 'Paused') : 'Not connected';
      } else {
        const ch = channels[def.key];
        connected = !!ch?.accessToken;
        enabled = !!ch?.enabled;
        label = connected ? (enabled ? 'On' : 'Paused') : 'Not connected';
      }
      const cls = connected ? (enabled ? 'on' : 'off') : 'disconnected';
      const action = connected
        ? (def.key === 'email' ? 'toggleSetting("autoReplyEnabled",' + !enabled + ')' : 'toggleChannel("' + def.key + '",' + !enabled + ')')
        : 'toggleSection("channels")';
      return '<div class="channel-chip ' + cls + '" onclick=\\'' + action + '\\'>' +
        '<div class="chip-dot"></div>' +
        '<span>' + def.icon + ' ' + def.name + '</span>' +
        '<span style="font-size:11px;color:#8888aa;">' + label + '</span>' +
      '</div>';
    }).join('');

    // ─── ACTIVITY FEED ─────────────────────────────────────────────────
    try {
      const act = await api('/api/dashboard/activity?limit=12');
      const list = document.getElementById('activity-list');
      if (!act.events?.length) {
        list.innerHTML = '<div class="empty" style="padding:14px 0">Nothing here yet — once Aria starts handling messages, recent activity will show up here.</div>';
      } else {
        const iconFor = (t) => ({ lead: '🎯', booking: '📅', handoff: '🤝', csat: '⭐' }[t] || '•');
        list.innerHTML = act.events.map(e => {
          return '<div class="activity-row">' +
            '<div class="activity-icon ' + e.type + '">' + iconFor(e.type) + '</div>' +
            '<div class="activity-meta">' +
              '<div class="activity-label">' + escH(e.label || '') + '</div>' +
              (e.detail ? '<div class="activity-detail">' + escH(e.detail) + '</div>' : '') +
            '</div>' +
            (e.channel ? '<div class="activity-channel">' + escH(e.channel) + '</div>' : '') +
            '<div class="activity-time">' + timeAgo(e.ts) + '</div>' +
          '</div>';
        }).join('');
      }
    } catch {}

    // ─── COMPACT STATS GRID (secondary, breakdowns) ────────────────────
    document.getElementById('stats-row').innerHTML = \`
      <div class="stat-card">
        <div class="value" style="color:#ff6b6b">\${d.leads.hot}</div>
        <div class="label">Hot Leads</div>
        <div class="sub">last 30 days</div>
      </div>
      <div class="stat-card">
        <div class="value" style="color:#fbbf24">\${d.leads.warm}</div>
        <div class="label">Warm Leads</div>
        <div class="sub">last 30 days</div>
      </div>
      <div class="stat-card">
        <div class="value">\${d.bookings.week}</div>
        <div class="label">Bookings This Week</div>
      </div>
      <div class="stat-card">
        <div class="value">\${d.emailsReplied.week}</div>
        <div class="label">Emails This Week</div>
      </div>
    \`;
    // Escalations banner — if any conv is paused waiting for owner takeover
    // Also adds an "attention" badge on the Conversations section header.
    try {
      const esc = await api('/api/dashboard/escalations');
      const escDiv = document.getElementById('escalations-banner');
      const convHeader = document.querySelector('#sec-conversations .section-header h3');
      // Strip any previous attention badge
      const oldBadge = convHeader?.querySelector('.badge-attn');
      if (oldBadge) oldBadge.remove();
      if (escDiv) {
        if (esc.items?.length) {
          const rows = esc.items.slice(0, 5).map(e => '<li>' + escH(e.channel) + ' · ' + escH(e.senderId) + ' · <i>' + escH(e.reason || 'human requested') + '</i> <button onclick="resumeConv(\\'' + e.memKey + '\\')" style="margin-left:8px;background:#00e5a0;color:#0d0d1f;border:none;border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;">Resume</button></li>').join('');
          escDiv.innerHTML = '<div style="background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);border-radius:12px;padding:14px 18px;margin-bottom:20px;"><b style="color:#fbbf24;">🤝 ' + esc.items.length + ' conversation(s) handed to you</b><ul style="margin:8px 0 0 0;padding-left:18px;font-size:13px;color:#ccc;line-height:1.7;">' + rows + '</ul></div>';
          escDiv.style.display = 'block';
          if (convHeader) {
            const b = document.createElement('span');
            b.className = 'badge-attn';
            b.textContent = esc.items.length + ' need attention';
            convHeader.appendChild(b);
          }
        } else {
          escDiv.style.display = 'none';
        }
      }
    } catch {}
  } catch (e) {
    document.getElementById('stats-row').innerHTML = '<div class="stat-card"><div class="value">!</div><div class="label">Failed to load stats</div></div>';
  }
}
// ─── SVG mini-chart helpers (zero-dep, ~100 lines for 4 chart types) ────
// All return SVG strings. Sized to fit inside an .ana-card.
function svgSparkline(values, { w = 240, h = 50, color = '#00e5a0', fill = true } = {}) {
  if (!values || !values.length) return '<svg width="' + w + '" height="' + h + '"></svg>';
  const max = Math.max(1, ...values.filter(v => v != null));
  const step = w / (values.length - 1 || 1);
  let pts = '';
  values.forEach((v, i) => {
    if (v == null) return;
    const x = i * step;
    const y = h - (v / max) * (h - 4) - 2;
    pts += (pts ? ' L ' : 'M ') + x.toFixed(1) + ',' + y.toFixed(1);
  });
  const area = fill && pts ? '<path d="' + pts + ' L ' + w + ',' + h + ' L 0,' + h + ' Z" fill="' + color + '" opacity="0.12" />' : '';
  const line = pts ? '<path d="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />' : '';
  // Day labels along bottom (7 dots = mon-sun style relative)
  const labels = values.map((_, i) => {
    const daysAgo = values.length - 1 - i;
    const d = new Date(Date.now() - daysAgo * 86400000);
    return '<text x="' + (i * step).toFixed(1) + '" y="' + (h + 10) + '" font-size="8" fill="#6b6b8a" text-anchor="middle">' + d.toLocaleDateString('en-GB', { weekday: 'short' }).slice(0, 2) + '</text>';
  }).join('');
  return '<svg width="' + w + '" height="' + (h + 14) + '">' + area + line + labels + '</svg>';
}
function svgDonut(parts, { size = 80, colors = ['#ff6b6b', '#fbbf24', '#9898b8'] } = {}) {
  // parts: [{label, value}], renders concentric donut + middle total
  const total = parts.reduce((s, p) => s + (p.value || 0), 0) || 1;
  const radius = size / 2 - 6;
  const circ = 2 * Math.PI * radius;
  let offset = 0;
  const segments = parts.map((p, i) => {
    const fraction = (p.value || 0) / total;
    const dash = circ * fraction;
    const seg = '<circle cx="' + (size / 2) + '" cy="' + (size / 2) + '" r="' + radius + '" fill="none" stroke="' + (colors[i] || '#666') + '" stroke-width="10" stroke-dasharray="' + dash + ' ' + (circ - dash) + '" stroke-dashoffset="-' + offset + '" transform="rotate(-90 ' + (size / 2) + ' ' + (size / 2) + ')" />';
    offset += dash;
    return seg;
  }).join('');
  return '<svg width="' + size + '" height="' + size + '">' +
    '<circle cx="' + (size / 2) + '" cy="' + (size / 2) + '" r="' + radius + '" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="10" />' +
    segments +
    '<text x="' + (size / 2) + '" y="' + (size / 2 + 4) + '" font-size="16" font-weight="700" fill="#fff" text-anchor="middle">' + total + '</text>' +
    '</svg>';
}
function renderHorizontalBars(items, { maxBars = 5 } = {}) {
  if (!items?.length) return '<div class="empty" style="padding:8px 0;font-size:12px;">No data yet</div>';
  const max = Math.max(...items.map(i => i.count || 0), 1);
  return '<div class="ana-stack">' + items.slice(0, maxBars).map(it => {
    const pct = ((it.count / max) * 100).toFixed(0);
    return '<div class="ana-row">' +
      '<div class="label">' + escH(it.name) + '</div>' +
      '<div class="bar"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="count">' + it.count + '</div>' +
    '</div>';
  }).join('') + '</div>';
}

async function loadAnalytics() {
  const grid = document.getElementById('ana-grid');
  const wowEl = document.getElementById('ana-wow');
  try {
    const d = await api('/api/dashboard/analytics');
    // Week-over-week pill
    const wow = d.weekOverWeek || {};
    if (wow.convs != null && wow.convsAbs != null) {
      const dir = wow.convs > 0 ? 'up' : (wow.convs < 0 ? 'down' : '');
      const arrow = wow.convs > 0 ? '↑' : (wow.convs < 0 ? '↓' : '→');
      wowEl.innerHTML = '<span class="wow-pill ' + dir + '">' + arrow + ' ' + Math.abs(wow.convs) + '% vs last week</span>';
    } else { wowEl.innerHTML = ''; }

    const colours = { facebook: '#1877F2', instagram: '#E1306C', whatsapp: '#25D366', email: '#fbbf24' };
    const channelTotals = Object.entries(d.volumeByChannel || {})
      .map(([k, vs]) => ({ key: k, total: vs.reduce((s, v) => s + v, 0), vs }));
    const totalAll = channelTotals.reduce((s, c) => s + c.total, 0);

    // 1. Volume card — combined sparkline + per-channel legend
    const combinedVs = (d.volumeByChannel.facebook || []).map((_, i) =>
      ['facebook','instagram','whatsapp','email'].reduce((s, k) => s + (d.volumeByChannel[k]?.[i] || 0), 0)
    );
    const volCard = '<div class="ana-card">' +
      '<div class="ana-title">💬 Conversations (' + totalAll + ' this week)</div>' +
      svgSparkline(combinedVs) +
      '<div class="ana-legend">' +
        channelTotals.filter(c => c.total > 0).map(c =>
          '<span><span class="dot" style="background:' + (colours[c.key] || '#888') + '"></span>' + c.key + ' ' + c.total + '</span>'
        ).join('') +
        (channelTotals.every(c => c.total === 0) ? '<span style="color:#6b6b8a">No conversations yet this week</span>' : '') +
      '</div>' +
    '</div>';

    // 2. Leads donut
    const lb = d.leadsBreakdown || { hot: 0, warm: 0, cold: 0 };
    const leadsCard = '<div class="ana-card">' +
      '<div class="ana-title">🎯 Leads (' + (lb.hot + lb.warm + lb.cold) + ' this week)</div>' +
      svgDonut([
        { label: 'Hot', value: lb.hot },
        { label: 'Warm', value: lb.warm },
        { label: 'Cold', value: lb.cold },
      ], { colors: ['#ff6b6b', '#fbbf24', '#6b6b8a'] }) +
      '<div class="ana-legend">' +
        '<span><span class="dot" style="background:#ff6b6b"></span>Hot ' + lb.hot + '</span>' +
        '<span><span class="dot" style="background:#fbbf24"></span>Warm ' + lb.warm + '</span>' +
        '<span><span class="dot" style="background:#6b6b8a"></span>Cold ' + lb.cold + '</span>' +
      '</div>' +
    '</div>';

    // 3. CSAT trend — sparkline with null gaps
    const csatVs = d.csatTrend || [];
    const hasCsat = csatVs.some(v => v != null);
    const csatCard = '<div class="ana-card">' +
      '<div class="ana-title">⭐ CSAT trend (last 7 days)</div>' +
      (hasCsat ? svgSparkline(csatVs.map(v => v == null ? null : v), { color: '#9d96ff' }) +
        '<div class="ana-legend"><span style="color:#9898b8">Higher is better — based on 👍/👎 ratings</span></div>'
        : '<div class="empty" style="padding:14px 0;font-size:12px;">No ratings yet this week</div>') +
    '</div>';

    // 4. Top categories
    const cats = d.topCategories || [];
    const catsCard = '<div class="ana-card">' +
      '<div class="ana-title">🏷️ Top topics</div>' +
      renderHorizontalBars(cats) +
    '</div>';

    grid.innerHTML = volCard + leadsCard + csatCard + catsCard;
  } catch (e) {
    grid.innerHTML = '<div class="empty">Failed to load analytics.</div>';
  }
}
// Fire on page load
loadAnalytics();

async function resumeConv(memKey) {
  if (!confirm('Hand this conversation back to Aria? She\\'ll start auto-replying again.')) return;
  try {
    const r = await apiPost('/api/dashboard/resume-conversation', { memKey });
    if (r.ok) { toast('Conversation resumed'); loadStats(); }
  } catch (e) { toast('Resume failed'); }
}
loadStats();

// Home greeting — time-aware + today's date.
(function(){
  const h = new Date().getHours();
  const g = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const hi = document.getElementById('greet-hi');
  if (hi) hi.textContent = g + ' 👋';
  const d = document.getElementById('greet-date');
  if (d) { try { d.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }); } catch (e) {} }
})();

// Sidebar init — open the last-viewed panel (or Home). This also hides the
// non-active section panels so the dashboard opens as one clean view
// instead of a long accordion scroll.
(function(){
  let p = 'home';
  try { p = localStorage.getItem('aria_panel') || 'home'; } catch (e) {}
  if (p !== 'home' && !document.getElementById('sec-' + p)) p = 'home';
  showPanel(p);
})();

// Welcome tutorial — show on first visit
if (!localStorage.getItem('_aria_tutorial_done')) {
  const overlay = document.createElement('div');
  overlay.id = 'tutorial-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
  const steps = [
    { title: 'Welcome to Aria 👋', text: 'Aria is your 24/7 AI receptionist. She replies to messages and emails in your voice — across Facebook, Instagram, WhatsApp, and Gmail.' },
    { title: 'The green dot 🟢', text: 'At the top of the dashboard, a green pulsing dot means Aria is live and replying. Red means she is paused — flip channel chips to control her.' },
    { title: 'Channels — tap to pause 📡', text: 'The chips under the hero show every channel. Tap one to pause/resume Aria on just that channel. Need to add a new one? Open the "Manage Channels" section.' },
    { title: 'Activity feed 🕐', text: 'The Recent Activity feed shows what Aria has been up to — new leads, bookings, handoffs, and customer ratings. Hot leads are 🎯, bookings are 📅, takeovers are 🤝.' },
    { title: 'Train Aria 🧠', text: 'Open the "Train Aria" section to upload knowledge documents, set up a services carousel, and tell Aria what topics she should + should not handle.' },
    { title: 'You\\'re set 🎉', text: 'Aria is ready. If anything ever needs your attention, you\\'ll see a banner at the top of the dashboard AND get an email.' },
  ];
  let stepIdx = 0;
  function showTutorialStep() {
    const s = steps[stepIdx];
    overlay.innerHTML = '<div style="background:#161630;border-radius:20px;padding:32px;max-width:420px;width:100%;text-align:center;">' +
      '<h2 style="font-size:20px;margin-bottom:12px;">' + s.title + '</h2>' +
      '<p style="font-size:14px;color:#9898b8;line-height:1.7;margin-bottom:24px;">' + s.text + '</p>' +
      '<div style="display:flex;gap:8px;justify-content:center;">' +
      (stepIdx > 0 ? '<button onclick="prevStep()" style="padding:10px 20px;background:rgba(255,255,255,0.06);color:#eee;border:1px solid rgba(255,255,255,0.1);border-radius:10px;cursor:pointer;font-size:13px;">← Back</button>' : '') +
      '<button onclick="nextStep()" style="padding:10px 24px;background:#00e5a0;color:#0d0d1f;border:none;border-radius:10px;cursor:pointer;font-size:14px;font-weight:600;">' + (stepIdx === steps.length - 1 ? 'Get Started →' : 'Next →') + '</button>' +
      '</div>' +
      '<div style="margin-top:16px;display:flex;gap:6px;justify-content:center;">' + steps.map((_, i) => '<div style="width:8px;height:8px;border-radius:50%;background:' + (i === stepIdx ? '#00e5a0' : '#333') + '"></div>').join('') + '</div>' +
      '</div>';
  }
  window.nextStep = () => { stepIdx++; if (stepIdx >= steps.length) { overlay.remove(); localStorage.setItem('_aria_tutorial_done', '1'); } else showTutorialStep(); };
  window.prevStep = () => { if (stepIdx > 0) { stepIdx--; showTutorialStep(); } };
  showTutorialStep();
  document.body.appendChild(overlay);
}

// One-click test button (already in topbar)

// In sidebar/panel mode each section is a full page, not a collapsible
// accordion — so this only ever OPENS + lazy-loads, never collapses.
function toggleSection(name) {
  const sec = document.getElementById('sec-' + name);
  if (!sec) return;
  if (!sec.classList.contains('open')) {
    sec.classList.add('open');
    if (!loaded[name]) { loaded[name] = true; loadSection(name); }
  }
}

// Sidebar navigation — show one panel at a time. 'home' = the overview
// (hero + activity + analytics); everything else maps to a section.
// (PANEL_NAMES is declared at the top of this script to avoid a TDZ on init.)
function showPanel(name) {
  const home = document.getElementById('panel-home');
  if (home) home.style.display = (name === 'home') ? 'block' : 'none';
  PANEL_NAMES.forEach(p => {
    const s = document.getElementById('sec-' + p);
    if (s) s.style.display = (p === name) ? 'block' : 'none';
  });
  if (name !== 'home') {
    const s = document.getElementById('sec-' + name);
    if (s) {
      s.classList.add('open');
      if (!loaded[name]) {
        loaded[name] = true;
        // Show a skeleton shimmer in the panel body while its data loads
        // (institutional touch — beats a "Loading…" string). loadSection
        // replaces it with real content.
        const b = document.getElementById('body-' + name);
        if (b) b.innerHTML = SKELETON_HTML;
        loadSection(name);
      }
    }
  }
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.panel === name));
  // Premium entrance — retrigger the fade/slide on the panel now shown.
  const shown = (name === 'home') ? home : document.getElementById('sec-' + name);
  if (shown) { shown.classList.remove('panel-enter'); void shown.offsetWidth; shown.classList.add('panel-enter'); }
  try { localStorage.setItem('aria_panel', name); } catch (e) {}
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

// Re-fetch a panel's data on demand (the Refresh action in panel headers).
function refreshPanel(name) {
  const b = document.getElementById('body-' + name);
  if (b) b.innerHTML = SKELETON_HTML;
  loadSection(name);
}

// Export the lead list as a CSV the owner can open in Excel/Sheets.
async function exportLeads() {
  try {
    const d = await api('/api/dashboard/leads');
    const rows = (d && d.leads) || [];
    if (!rows.length) { toast('No leads to export yet'); return; }
    const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const csv = 'Name,Email,Phone\\n' + rows.map(l => [l.name, l.email, l.phone].map(esc).join(',')).join('\\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'aria-leads.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Exported ' + rows.length + ' lead' + (rows.length === 1 ? '' : 's'));
  } catch (e) { toast('Export failed'); }
}

// ─── ⌘K command palette ──────────────────────────────────────────────────
// Press Cmd/Ctrl+K anywhere → fuzzy-search to any panel or action. The
// signature "power product" feature. Self-contained: one overlay + keymap.
const CMDS = [
  { ic: '🏠', label: 'Home',             grp: 'Go', run: function(){ showPanel('home'); } },
  { ic: '💬', label: 'Conversations',    grp: 'Go', run: function(){ showPanel('conversations'); } },
  { ic: '🎯', label: 'Leads',            grp: 'Go', run: function(){ showPanel('leads'); } },
  { ic: '👥', label: 'Customers',        grp: 'Go', run: function(){ showPanel('customers'); } },
  { ic: '📅', label: 'Bookings',         grp: 'Go', run: function(){ showPanel('bookings'); } },
  { ic: '🧠', label: 'Train Aria',       grp: 'Go', run: function(){ showPanel('train'); } },
  { ic: '🔗', label: 'Channels',         grp: 'Go', run: function(){ showPanel('channels'); } },
  { ic: '🏢', label: 'Business Profile', grp: 'Go', run: function(){ showPanel('profile'); } },
  { ic: '⚙️', label: 'Settings',         grp: 'Go', run: function(){ showPanel('settings'); } },
  { ic: '↧', label: 'Export leads as CSV', grp: 'Do', run: function(){ exportLeads(); } },
  { ic: '↻', label: 'Refresh current panel', grp: 'Do', run: function(){ var p; try{ p = localStorage.getItem('aria_panel'); }catch(e){} if (p && p !== 'home') refreshPanel(p); } },
  { ic: '🚪', label: 'Log out',          grp: 'Do', run: function(){ logout(); } },
];
let _palItems = [], _palSel = 0;
function openPalette(){ const o = document.getElementById('cmdk'); o.classList.add('show'); const i = document.getElementById('cmdk-input'); i.value = ''; renderPalette(''); setTimeout(function(){ i.focus(); }, 20); }
function closePalette(){ document.getElementById('cmdk').classList.remove('show'); }
function renderPalette(q){
  q = (q || '').toLowerCase().trim();
  _palItems = CMDS.map(function(c, i){ return { c: c, i: i }; }).filter(function(x){ return !q || x.c.label.toLowerCase().indexOf(q) >= 0; });
  _palSel = 0;
  const list = document.getElementById('cmdk-list');
  if (!_palItems.length) { list.innerHTML = '<div class="cmdk-empty">No matching commands</div>'; return; }
  list.innerHTML = _palItems.map(function(x, idx){
    return '<div class="cmdk-item' + (idx === 0 ? ' sel' : '') + '" data-idx="' + idx + '" onclick="runPalette(' + idx + ')"><span class="cmdk-ic">' + x.c.ic + '</span>' + escH(x.c.label) + '<span class="cmdk-grp">' + x.c.grp + '</span></div>';
  }).join('');
}
function movePalette(d){
  const items = document.querySelectorAll('.cmdk-item');
  if (!items.length) return;
  _palSel = (_palSel + d + items.length) % items.length;
  items.forEach(function(el, i){ el.classList.toggle('sel', i === _palSel); });
  items[_palSel].scrollIntoView({ block: 'nearest' });
}
function runPalette(idx){ const x = _palItems[idx != null ? idx : _palSel]; if (x) { closePalette(); x.c.run(); } }
document.addEventListener('keydown', function(e){
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    const o = document.getElementById('cmdk');
    if (o.classList.contains('show')) closePalette(); else openPalette();
    return;
  }
  if (!document.getElementById('cmdk').classList.contains('show')) return;
  if (e.key === 'Escape') closePalette();
  else if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); runPalette(); }
});

async function loadSection(name) {
  if (name === 'leads') await loadLeads();
  else if (name === 'bookings') await loadBookings();
  else if (name === 'profile') await loadProfile();
  else if (name === 'settings') await loadSettings();
  else if (name === 'conversations') await loadUnifiedConvs('all');
  else if (name === 'train') await loadTrainAria();
  else if (name === 'customers') await loadCustomers();
}

// ─── Customers — repeat-customer profile drill-down ──────────────────────
async function loadCustomers() {
  const body = document.getElementById('body-customers');
  try {
    const d = await api('/api/dashboard/customers');
    const list = d.customers || [];
    if (!list.length) {
      body.innerHTML = '<div class="empty-state"><div class="es-ic">👥</div><div class="es-t">No returning customers yet</div><div class="es-s">Aria builds this list automatically — whenever the same person messages you 2+ times (matched by email, phone, or name), they appear here with their full history.</div></div>';
      return;
    }
    const icons = { facebook: '📘', instagram: '📷', whatsapp: '💬', email: '📧', voice: '☎️' };
    let html = '<div style="display:flex;flex-direction:column;gap:8px;">';
    for (const c of list.slice(0, 100)) {
      const chans = (c.channels || []).map(ch => icons[ch] || '·').join(' ');
      html += '<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:12px 14px;display:flex;align-items:center;gap:12px;cursor:pointer;transition:all 0.15s;" onmouseover="this.style.borderColor=\\'rgba(255,255,255,0.15)\\'" onmouseout="this.style.borderColor=\\'rgba(255,255,255,0.06)\\'" onclick="showCustomerProfile(\\'' + encodeURIComponent(c.key) + '\\')">' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:13.5px;color:#fff;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escH(c.name || c.key.split(':')[1]) + '</div>' +
          '<div style="font-size:11.5px;color:#8888aa;margin-top:3px;">' + chans + ' · ' + c.touches + ' touch' + (c.touches !== 1 ? 'es' : '') + ' · last seen ' + timeAgo(c.lastSeen) + '</div>' +
        '</div>' +
        '<div style="font-size:11px;color:#9d96ff;flex-shrink:0;">View →</div>' +
      '</div>';
    }
    html += '</div>';
    body.innerHTML = html;
  } catch (e) { body.innerHTML = '<div class="empty">Failed to load customers.</div>'; }
}

async function showCustomerProfile(contactKey) {
  openModal('<div style="color:#8888aa;text-align:center;padding:24px">Loading customer profile…</div>');
  try {
    const d = await api('/api/dashboard/customer/' + contactKey);
    if (d.error) { openModal('<h3>Not found<button class="close-x" onclick="closeModal()">×</button></h3><p style="color:#9898b8">' + escH(d.error) + '</p>'); return; }
    const ltv = d.ltv || 0;
    const tier = ltv >= 60 ? {l:'VIP',c:'#00e5a0'} : ltv >= 30 ? {l:'Engaged',c:'#fbbf24'} : ltv >= 10 ? {l:'Active',c:'#9d96ff'} : {l:'New',c:'#8888aa'};
    const icons = { facebook: '📘', instagram: '📷', whatsapp: '💬', email: '📧' };
    const channels = (d.channels || []).map(ch => icons[ch] || '·').join(' ');

    // Sentiment timeline as a tiny inline visual
    const sentBuckets = { positive: 0, neutral: 0, negative: 0, angry: 0 };
    (d.sentimentTimeline || []).forEach(s => { if (sentBuckets[s.sentiment] !== undefined) sentBuckets[s.sentiment]++; });
    const sentTotal = Object.values(sentBuckets).reduce((a, b) => a + b, 0);
    const sentBar = sentTotal ? Object.entries(sentBuckets).filter(([, v]) => v > 0).map(([k, v]) => {
      const w = (v / sentTotal * 100).toFixed(0);
      const colorMap = { positive: '#00e5a0', neutral: '#9898b8', negative: '#fbbf24', angry: '#ff6b6b' };
      return '<div style="flex:' + w + ';background:' + colorMap[k] + ';height:6px;" title="' + k + ': ' + v + '"></div>';
    }).join('') : '<div style="background:rgba(255,255,255,0.05);height:6px;border-radius:3px;flex:1;"></div>';

    // Lead history rows
    const leadRows = (d.leadHistory || []).slice(0, 10).map(l => {
      const scoreColor = l.leadScore === 'hot' ? '#ff6b6b' : l.leadScore === 'warm' ? '#fbbf24' : '#9898b8';
      return '<div style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:12px;">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;">' +
          '<span style="background:' + scoreColor + '20;color:' + scoreColor + ';padding:1px 8px;border-radius:10px;font-size:10.5px;font-weight:600;text-transform:uppercase;">' + (l.leadScore || 'unscored') + '</span>' +
          '<span style="font-size:10.5px;color:#8888aa;">' + (icons[l.channel] || '·') + ' ' + (l.category || 'general') + '</span>' +
          '<span style="font-size:10.5px;color:#6b6b8a;margin-left:auto;">' + timeAgo(l.ts) + '</span>' +
        '</div>' +
        (l.preview ? '<div style="color:#bbb;font-style:italic;line-height:1.5;">"' + escH(l.preview.slice(0, 200)) + '"</div>' : '') +
      '</div>';
    }).join('') || '<div class="empty" style="padding:14px 0;font-size:12px;">No lead history</div>';

    // Bookings
    const bookingRows = (d.bookings || []).slice(0, 5).map(b =>
      '<div style="background:rgba(0,229,160,0.05);border-radius:8px;padding:10px;margin-bottom:6px;font-size:12.5px;">' +
        '<div style="color:#fff;font-weight:600;">📅 ' + escH(b.service || 'Booking') + '</div>' +
        '<div style="color:#00e5a0;font-size:11.5px;margin-top:3px;">' + escH(b.datetime || '—') + '</div>' +
      '</div>'
    ).join('') || '<div class="empty" style="padding:14px 0;font-size:12px;">No bookings yet</div>';

    // Conversation threads
    const convRows = (d.conversations || []).slice(0, 5).map(c =>
      '<div onclick="closeModal();setTimeout(() => showThread(\\'' + c.memKey + '\\'), 100)" style="background:rgba(255,255,255,0.03);border-radius:8px;padding:10px;margin-bottom:6px;font-size:12.5px;cursor:pointer;border:1px solid rgba(255,255,255,0.06);" onmouseover="this.style.borderColor=\\'rgba(157,150,255,0.4)\\'" onmouseout="this.style.borderColor=\\'rgba(255,255,255,0.06)\\'">' +
        '<div style="color:#fff;">' + (icons[c.channel] || '·') + ' ' + c.msgCount + ' messages</div>' +
        '<div style="color:#8888aa;font-size:11px;margin-top:3px;">Last: ' + timeAgo(c.lastMsgTs) + ' — click to view →</div>' +
      '</div>'
    ).join('') || '<div class="empty" style="padding:14px 0;font-size:12px;">No conversation threads found</div>';

    openModal(
      '<div style="display:flex;align-items:start;justify-content:space-between;margin-bottom:18px;gap:12px;">' +
        '<div style="flex:1;min-width:0;">' +
          '<h3 style="font-size:18px;color:#fff;margin:0 0 4px;">' + escH(d.name || contactKey.split(':')[1]) + '</h3>' +
          '<div style="font-size:11.5px;color:#8888aa;">' + channels + ' · ' + d.touches + ' touch' + (d.touches !== 1 ? 'es' : '') + ' · first seen ' + timeAgo(d.lastSeen) + '</div>' +
        '</div>' +
        '<div style="text-align:right;flex-shrink:0;">' +
          '<div style="background:' + tier.c + '20;color:' + tier.c + ';padding:3px 12px;border-radius:14px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;display:inline-block;">' + tier.l + '</div>' +
          '<div style="font-size:20px;font-weight:800;color:' + tier.c + ';margin-top:6px;">' + ltv + '</div>' +
          '<div style="font-size:10px;color:#6b6b8a;text-transform:uppercase;letter-spacing:0.5px;">LTV score</div>' +
        '</div>' +
        '<button class="close-x" onclick="closeModal()" style="margin-left:8px;">×</button>' +
      '</div>' +
      (sentTotal ? '<div style="margin-bottom:18px;"><div style="font-size:11px;color:#8888aa;text-transform:uppercase;margin-bottom:6px;letter-spacing:0.5px;">Sentiment over time</div><div style="display:flex;gap:0;border-radius:3px;overflow:hidden;">' + sentBar + '</div></div>' : '') +
      '<div style="margin-bottom:18px;"><div style="font-size:11px;color:#8888aa;text-transform:uppercase;margin-bottom:8px;letter-spacing:0.5px;">📅 Bookings (' + (d.bookings?.length || 0) + ')</div>' + bookingRows + '</div>' +
      '<div style="margin-bottom:18px;"><div style="font-size:11px;color:#8888aa;text-transform:uppercase;margin-bottom:8px;letter-spacing:0.5px;">💬 Conversation threads</div>' + convRows + '</div>' +
      '<div><div style="font-size:11px;color:#8888aa;text-transform:uppercase;margin-bottom:8px;letter-spacing:0.5px;">🎯 Lead history (' + (d.leadHistory?.length || 0) + ')</div>' + leadRows + '</div>'
    );
  } catch (e) { openModal('<div style="color:#ff6b6b">Failed to load profile: ' + e.message + '</div>'); }
}

// ─── Modal + drill-down helpers ─────────────────────────────────────────
function openModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-overlay').classList.add('show');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('show');
}

async function showThread(memKey) {
  openModal('<div style="color:#8888aa;text-align:center;padding:24px">Loading conversation…</div>');
  try {
    const d = await api('/api/dashboard/conversation/' + encodeURIComponent(memKey));
    const rows = (d.history || []).map(h => {
      const cls = h.role === 'sender' ? 'them' : (h.role === 'summary' ? 'summary' : 'us');
      const label = h.role === 'sender' ? 'Customer' : (h.role === 'summary' ? 'Earlier summary' : 'Aria');
      return '<div>' +
        '<div class="thread-meta">' + escH(label) + ' · ' + timeAgo(h.date) + '</div>' +
        '<div class="thread-msg ' + cls + '">' + escH(h.preview || '') + '</div>' +
      '</div>';
    }).join('');
    const pauseChip = d.state?.paused
      ? '<span style="background:rgba(251,191,36,0.15);color:#fbbf24;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;margin-left:8px;">PAUSED · ' + escH(d.state.reason || 'human takeover') + '</span>'
      : '';
    openModal(
      '<h3>💬 ' + escH(d.channel || 'channel') + ' conversation' + pauseChip +
        '<button class="close-x" onclick="closeModal()">×</button></h3>' +
      '<div style="font-size:11.5px;color:#6b6b8a;margin-bottom:14px;">With ' + escH(d.senderId) + '</div>' +
      (rows || '<div class="empty" style="padding:14px 0">No messages stored.</div>') +
      (d.state?.paused ? '<div style="margin-top:16px;text-align:center;"><button class="cta-btn" onclick="resumeConv(\\'' + memKey + '\\');closeModal()">Resume Aria on this conversation</button></div>' : '')
    );
  } catch (e) { openModal('<div style="color:#ff6b6b">Failed to load conversation: ' + e.message + '</div>'); }
}

async function showCsatDetail() {
  openModal('<div style="color:#8888aa;text-align:center;padding:24px">Loading 👎 ratings…</div>');
  try {
    const d = await api('/api/dashboard/csat-detail');
    if (!d.items?.length) {
      openModal('<h3>⭐ CSAT details<button class="close-x" onclick="closeModal()">×</button></h3>' +
        '<div class="empty" style="padding:24px 0">No 👎 ratings yet — Aria\\'s been doing well!</div>');
      return;
    }
    const rows = d.items.map(item => {
      const recent = (item.history || []).slice(-3).map(h =>
        '<div class="thread-meta">' + (h.role === 'sender' ? 'Customer' : 'Aria') + ' · ' + timeAgo(h.date) + '</div>' +
        '<div class="thread-msg ' + (h.role === 'sender' ? 'them' : 'us') + '">' + escH(h.preview || '') + '</div>'
      ).join('');
      return '<div style="border-bottom:1px solid rgba(255,255,255,0.06);padding:14px 0;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">' +
          '<div style="color:#fff;font-weight:600;font-size:13px;">👎 ' + escH(item.senderName || item.senderId) + ' <span style="font-weight:400;color:#8888aa;font-size:11px;">on ' + escH(item.channel) + '</span></div>' +
          '<div style="font-size:11px;color:#8888aa;">' + timeAgo(item.ts) + '</div>' +
        '</div>' +
        (item.raw ? '<div style="font-size:12px;color:#8888aa;font-style:italic;margin-bottom:8px;">"' + escH(item.raw) + '"</div>' : '') +
        (recent || '<div style="font-size:12px;color:#6b6b8a;">No conversation history retained.</div>') +
      '</div>';
    }).join('');
    openModal(
      '<h3>👎 Negative ratings — last 30<button class="close-x" onclick="closeModal()">×</button></h3>' +
      '<p style="font-size:12px;color:#8888aa;margin-bottom:14px;">Customers who rated Aria\\'s replies negatively. Use these to improve your Knowledge Documents or Topic Scope.</p>' +
      rows
    );
  } catch (e) { openModal('<div style="color:#ff6b6b">Failed: ' + e.message + '</div>'); }
}

// Quick-toggle helper used by channel chips for email auto-reply
async function toggleSetting(key, value) {
  try {
    const body = { owner: OWNER };
    body[key] = value;
    const r = await apiPost('/api/dashboard/settings', body);
    if (r.ok) { toast(value ? 'Auto-reply ON' : 'Auto-reply paused'); loadStats(); }
  } catch (e) { toast('Failed to toggle'); }
}

// ─── Unified Conversations ─────────────────────────────────────────────
let convFilter = 'all';
async function loadUnifiedConvs(filter) {
  convFilter = filter || 'all';
  // Update filter button styles
  document.querySelectorAll('.conv-filter').forEach(btn => {
    const isActive = btn.dataset.filter === convFilter;
    btn.classList.toggle('active', isActive);
    btn.style.background = isActive ? 'rgba(0,229,160,0.15)' : 'rgba(255,255,255,0.06)';
    btn.style.color = isActive ? '#00e5a0' : '#ccc';
    btn.style.borderColor = isActive ? 'rgba(0,229,160,0.3)' : 'rgba(255,255,255,0.1)';
  });
  const container = document.getElementById('conversations-list');
  try {
    const items = [];
    // Channel messages (FB/IG/WA)
    if (convFilter === 'all' || convFilter === 'facebook' || convFilter === 'instagram' || convFilter === 'whatsapp') {
      const chFilter = convFilter === 'all' ? 'all' : convFilter;
      const d = await api('/api/dashboard/messages?channel=' + chFilter + '&page=1');
      for (const m of (d.items || [])) {
        items.push({
          channel: m.channel,
          from: m.senderName || m.senderId,
          senderId: m.senderId,
          msg: m.message, reply: m.reply, ts: m.timestamp,
        });
      }
    }
    // Email inbox
    if (convFilter === 'all' || convFilter === 'email') {
      const d = await api('/api/dashboard/inbox-log?page=1');
      for (const r of (d.items || [])) {
        items.push({
          channel: 'email', from: r.senderEmail, msg: r.subject,
          reply: r.replyPreview, ts: r.sentAt,
        });
      }
    }
    items.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
    if (!items.length) {
      container.innerHTML = '<div class="empty">No conversations yet on this channel.</div>';
      return;
    }
    const icons = { email: '📧', facebook: '📘', instagram: '📷', whatsapp: '💬' };
    let html = '<table><thead><tr><th></th><th>From</th><th>Message</th><th>Aria\\'s reply</th><th>When</th></tr></thead><tbody>';
    for (const it of items.slice(0, 50)) {
      // Channel messages get a memKey we can use for thread drill-down.
      // Email entries don't yet (separate ledger) — clicking does nothing for email.
      const memKey = it.channel !== 'email' && it.senderId
        ? OWNER + '::' + it.channel + '::' + it.senderId
        : null;
      const clickAttr = memKey ? ' onclick="showThread(\\'' + memKey + '\\')" style="cursor:pointer"' : '';
      html += '<tr' + clickAttr + '>' +
        '<td style="width:24px">' + (icons[it.channel] || '') + '</td>' +
        '<td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escH(it.from || '—') + '</td>' +
        '<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escH((it.msg || '').substring(0, 100)) + '</td>' +
        '<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escH((it.reply || '').substring(0, 100)) + '</td>' +
        '<td style="width:80px;font-size:11.5px;color:#8888aa">' + timeAgo(it.ts) + '</td>' +
      '</tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  } catch (e) { container.innerHTML = '<div class="empty">Failed to load conversations.</div>'; }
}

// ─── Train Aria (KB + Knowledge docs + Services + Scope) ────────────────
async function loadTrainAria() {
  const body = document.getElementById('body-train');
  body.innerHTML = '<div style="padding:8px 0;">' +
    '<p style="font-size:13px;color:#9898b8;margin-bottom:18px;">Teach Aria your business — answers, documents, services, hours, and what topics she should + shouldn\\'t handle.</p>' +
    '<div id="train-test" style="margin-bottom:28px;"></div>' +
    '<div id="train-gaps" style="margin-bottom:28px;"></div>' +
    '<div id="train-quick" style="margin-bottom:28px;"></div>' +
    '<div id="train-knowledge" style="margin-bottom:28px;"></div>' +
    '<div id="train-services" style="margin-bottom:28px;"></div>' +
    '<div id="train-hours" style="margin-bottom:28px;"></div>' +
    '<div id="train-scope" style="margin-bottom:8px;"></div>' +
  '</div>';
  renderTestAriaCard();
  renderQuickTrainCard();
  await Promise.all([loadKnowledgeDocs(), loadServicesEditor(), loadScopeEditor(), loadKnowledgeGaps(), loadBusinessHoursEditor()]);
}

// ─── Test Aria sandbox ────────────────────────────────────────────────────
function renderTestAriaCard() {
  const el = document.getElementById('train-test');
  el.innerHTML =
    '<div style="background:rgba(0,229,160,0.04);border:1px solid rgba(0,229,160,0.2);border-radius:14px;padding:18px;">' +
      '<h4 style="font-size:14px;color:#fff;margin-bottom:6px;display:flex;align-items:center;gap:8px;">🧪 Test Aria <span style="font-size:11px;font-weight:400;color:#9898b8;">— ask her anything, see how she\\'d reply</span></h4>' +
      '<p style="font-size:12.5px;color:#9898b8;margin-bottom:12px;line-height:1.6;">Type a question a real customer might ask. Aria will reply using your current knowledge + scope settings. Test things before real customers hit them.</p>' +
      '<div style="display:flex;gap:8px;margin-bottom:12px;">' +
        '<input id="ta-q" placeholder="e.g. Do you do same-day bookings?" style="flex:1;" onkeydown="if(event.key===\\'Enter\\')testAria()">' +
        '<button class="cta-btn" onclick="testAria()" id="ta-btn">Ask Aria</button>' +
      '</div>' +
      '<div id="ta-result"></div>' +
    '</div>';
}

async function testAria() {
  const q = document.getElementById('ta-q').value.trim();
  if (!q) { toast('Type a question first'); return; }
  const btn = document.getElementById('ta-btn');
  const result = document.getElementById('ta-result');
  btn.disabled = true;
  btn.textContent = '⏳';
  result.innerHTML = '';
  try {
    const r = await apiPost('/api/dashboard/test-aria', { message: q });
    if (r.error) { toast(r.error); btn.disabled = false; btn.textContent = 'Ask Aria'; return; }
    const reply = r.reply;
    const badges = [];
    if (reply.sentiment) badges.push('Sentiment: <b>' + reply.sentiment + '</b>');
    if (reply.urgency)   badges.push('Urgency: <b>' + reply.urgency + '</b>');
    if (reply.language && reply.language !== 'en') badges.push('Language: <b>' + reply.language + '</b>');
    if (reply.outOfScope) badges.push('<span style="color:#ff6b6b">⚠️ OUT OF SCOPE</span>');
    if (reply.needsHuman) badges.push('<span style="color:#fbbf24">🤝 NEEDS HUMAN</span>');
    if (reply.booking)    badges.push('<span style="color:#00e5a0">📅 BOOKING DETECTED</span>');
    if (reply.showServicesCarousel) badges.push('<span style="color:#9d96ff">🎠 SHOWS CAROUSEL</span>');
    result.innerHTML =
      '<div style="background:rgba(255,255,255,0.03);border-radius:10px;padding:14px;">' +
        '<div style="font-size:11.5px;color:#8888aa;margin-bottom:6px;">Aria\\'s reply:</div>' +
        '<div style="color:#eee;font-size:13.5px;line-height:1.6;white-space:pre-wrap;margin-bottom:10px;">' + escH(reply.text) + '</div>' +
        (reply.suggestedReplies?.length ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">' + reply.suggestedReplies.map(s => '<span style="background:rgba(0,229,160,0.1);color:#00e5a0;border:1px solid rgba(0,229,160,0.3);border-radius:20px;padding:4px 12px;font-size:11.5px;">' + escH(s) + '</span>').join('') + '</div>' : '') +
        (badges.length ? '<div style="font-size:11px;color:#8888aa;margin-top:8px;">' + badges.join(' · ') + '</div>' : '') +
        (r.citedChunks?.length ? '<div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.06);"><div style="font-size:11px;color:#8888aa;margin-bottom:6px;">📚 Cited from your knowledge:</div>' + r.citedChunks.map(c => '<div style="font-size:11.5px;color:#aaa;margin:3px 0;"><b>' + escH(c.title) + '</b>: ' + escH(c.preview) + '…</div>').join('') + '</div>' : '') +
      '</div>';
    btn.disabled = false;
    btn.textContent = 'Ask Aria';
  } catch (e) { toast('Test failed: ' + e.message); btn.disabled = false; btn.textContent = 'Ask Aria'; }
}

// ─── Knowledge Gaps panel ────────────────────────────────────────────────
async function loadKnowledgeGaps() {
  const el = document.getElementById('train-gaps');
  try {
    const d = await api('/api/dashboard/channel-gaps');
    if (!d.clusters?.length) {
      el.innerHTML =
        '<div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:14px;padding:16px;">' +
          '<h4 style="font-size:14px;color:#fff;margin-bottom:4px;">🕳️ Knowledge Gaps</h4>' +
          '<p style="font-size:12px;color:#8888aa;">No gaps in the last 30 days — Aria is answering everything customers ask. Nice.</p>' +
        '</div>';
      return;
    }
    // Bulk-bootstrap banner — only show if there are 3+ clusters (worthwhile)
    const bootstrapBanner = d.clusters.length >= 3
      ? '<div style="background:linear-gradient(135deg,rgba(0,229,160,0.08),rgba(157,150,255,0.08));border:1px solid rgba(0,229,160,0.3);border-radius:14px;padding:18px;margin-bottom:14px;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;">' +
            '<div style="flex:1;">' +
              '<h4 style="font-size:14px;color:#fff;margin:0 0 4px;display:flex;align-items:center;gap:8px;">🚀 Bootstrap Aria\\'s knowledge base in 1 click</h4>' +
              '<p style="font-size:12px;color:#9898b8;margin:0;line-height:1.5;">She\\'ll draft answers to your top ' + Math.min(10, d.clusters.length) + ' unanswered questions in ~5 seconds. Review and accept the lot in one go.</p>' +
            '</div>' +
            '<button onclick="bootstrapFaqs()" id="bootstrap-btn" style="background:#00e5a0;color:#0d0d1f;border:none;border-radius:8px;padding:8px 18px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;flex-shrink:0;">✨ Draft all answers</button>' +
          '</div>' +
          '<div id="bootstrap-results" style="margin-top:14px;"></div>' +
        '</div>'
      : '';

    el.innerHTML =
      bootstrapBanner +
      '<div style="background:rgba(251,191,36,0.04);border:1px solid rgba(251,191,36,0.25);border-radius:14px;padding:18px;">' +
        '<h4 style="font-size:14px;color:#fff;margin-bottom:6px;display:flex;align-items:center;gap:8px;">🕳️ Knowledge Gaps <span style="background:rgba(251,191,36,0.2);color:#fbbf24;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">' + d.clusters.length + '</span></h4>' +
        '<p style="font-size:12.5px;color:#9898b8;margin-bottom:14px;line-height:1.6;">Customers asked these questions but Aria fell back to vague answers. Click any to have her draft a knowledge entry that\\'ll fix it.</p>' +
        '<div style="display:flex;flex-direction:column;gap:8px;">' +
          d.clusters.map((c, i) => '<div style="background:rgba(255,255,255,0.04);border-radius:10px;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px;">' +
            '<div style="flex:1;min-width:0;">' +
              '<div style="font-size:13px;color:#eee;overflow:hidden;text-overflow:ellipsis;">' + escH(c.sampleQuestion) + '</div>' +
              '<div style="font-size:11px;color:#8888aa;margin-top:3px;">' + c.count + ' time' + (c.count > 1 ? 's' : '') + ' · last asked ' + timeAgo(c.lastSeen) + '</div>' +
            '</div>' +
            '<button onclick="draftGapKb(' + i + ')" style="background:rgba(251,191,36,0.15);color:#fbbf24;border:1px solid rgba(251,191,36,0.3);border-radius:6px;padding:4px 12px;font-size:11.5px;cursor:pointer;font-family:inherit;flex-shrink:0;">✨ Draft answer</button>' +
          '</div>').join('') +
        '</div>' +
        '<div id="gap-draft" style="margin-top:14px;"></div>' +
      '</div>';
    window._gaps = d.clusters;
  } catch (e) {
    el.innerHTML = '<div class="empty">Failed to load knowledge gaps.</div>';
  }
}

async function draftGapKb(idx) {
  const cluster = window._gaps?.[idx];
  if (!cluster) return;
  const draftEl = document.getElementById('gap-draft');
  draftEl.innerHTML = '<div style="background:rgba(255,255,255,0.03);padding:14px;border-radius:10px;color:#8888aa;font-size:13px;">⏳ Aria is drafting a knowledge entry from these questions…</div>';
  try {
    const questions = cluster.examples.map(e => e.question);
    const r = await apiPost('/api/dashboard/gap-to-kb', { questions });
    if (r.error) { draftEl.innerHTML = '<div style="color:#ff6b6b">' + r.error + '</div>'; return; }
    const draft = r.draft;
    const placeholderWarning = draft.needsOwnerInput?.length
      ? '<div style="background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);border-radius:8px;padding:10px;margin-bottom:10px;font-size:12px;color:#fbbf24;"><b>⚠️ You need to fill in these placeholders before it\\'s useful:</b><br>' + draft.needsOwnerInput.map(p => '· ' + escH(p)).join('<br>') + '</div>'
      : '';
    draftEl.innerHTML =
      '<div style="background:rgba(0,229,160,0.05);border:1px solid rgba(0,229,160,0.3);border-radius:12px;padding:14px;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">' +
          '<b style="color:#00e5a0;font-size:13px;">📝 Aria\\'s draft</b>' +
          '<div style="display:flex;gap:8px;">' +
            '<button onclick="document.getElementById(\\'gap-draft\\').innerHTML=\\'\\'" style="background:rgba(255,255,255,0.06);color:#8888aa;border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:4px 12px;font-size:11px;cursor:pointer;font-family:inherit;">Discard</button>' +
            '<button onclick="acceptGapDraft()" style="background:#00e5a0;color:#0d0d1f;border:none;border-radius:6px;padding:4px 14px;font-size:11.5px;font-weight:600;cursor:pointer;font-family:inherit;">+ Add to knowledge</button>' +
          '</div>' +
        '</div>' +
        placeholderWarning +
        '<div class="form-group" style="margin-bottom:10px;"><label>Title</label><input id="gap-title" value="' + escH(draft.title) + '"></div>' +
        '<div class="form-group"><label>Content (edit before accepting)</label><textarea id="gap-content" rows="8">' + escH(draft.content) + '</textarea></div>' +
      '</div>';
    window._gapDraft = draft;
  } catch (e) { draftEl.innerHTML = '<div style="color:#ff6b6b">Draft failed: ' + e.message + '</div>'; }
}

async function bootstrapFaqs() {
  const btn = document.getElementById('bootstrap-btn');
  const out = document.getElementById('bootstrap-results');
  if (!btn || !out) return;
  btn.disabled = true; btn.textContent = '⏳ Drafting…';
  out.innerHTML = '<div style="background:rgba(255,255,255,0.03);padding:14px;border-radius:10px;color:#8888aa;font-size:12.5px;">Aria is drafting answers in parallel. This takes ~5 seconds for 10 clusters…</div>';
  try {
    const r = await apiPost('/api/dashboard/faq-bootstrap', { limit: 10 });
    btn.disabled = false; btn.textContent = '✨ Re-draft';
    const drafts = (r.drafts || []).filter(d => d.draft);
    if (drafts.length === 0) {
      out.innerHTML = '<div class="empty" style="padding:14px;">No drafts came back — try again or use per-question drafting below.</div>';
      return;
    }
    window._bootstrapDrafts = drafts;
    const cards = drafts.map((d, i) => {
      const placeholderWarn = d.draft.needsOwnerInput?.length
        ? '<div style="background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.25);border-radius:6px;padding:6px 10px;margin:8px 0;font-size:11px;color:#fbbf24;">⚠️ Fill placeholders: ' + d.draft.needsOwnerInput.map(escH).join(' · ') + '</div>'
        : '';
      return '<div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px 14px;margin-bottom:10px;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;">' +
          '<div style="font-size:11px;color:#8888aa;">' +
            '<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">' +
              '<input type="checkbox" class="bs-pick" data-idx="' + i + '" checked style="margin:0;">' +
              '<span>Asked ' + d.count + '× · ' + escH(d.sampleQuestion.slice(0, 70)) + (d.sampleQuestion.length > 70 ? '…' : '') + '</span>' +
            '</label>' +
          '</div>' +
        '</div>' +
        '<div class="form-group" style="margin-bottom:8px;"><label style="font-size:10.5px;">Title</label><input class="bs-title" data-idx="' + i + '" value="' + escH(d.draft.title) + '" style="font-size:13px;"></div>' +
        '<div class="form-group" style="margin-bottom:0;"><label style="font-size:10.5px;">Content</label><textarea class="bs-content" data-idx="' + i + '" rows="5" style="font-size:12.5px;">' + escH(d.draft.content) + '</textarea></div>' +
        placeholderWarn +
      '</div>';
    }).join('');
    out.innerHTML =
      '<div style="font-size:11.5px;color:#8888aa;margin:8px 0 10px;">Uncheck any you don\\'t want. Edit content freely. Then save the lot.</div>' +
      cards +
      '<div style="display:flex;justify-content:flex-end;gap:8px;">' +
        '<button onclick="document.getElementById(\\'bootstrap-results\\').innerHTML=\\'\\'" style="background:rgba(255,255,255,0.06);color:#8888aa;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;font-family:inherit;">Discard all</button>' +
        '<button onclick="bulkAcceptFaqs()" style="background:#00e5a0;color:#0d0d1f;border:none;border-radius:8px;padding:8px 18px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;">+ Save all to KB</button>' +
      '</div>';
  } catch (e) {
    btn.disabled = false; btn.textContent = '✨ Draft all answers';
    out.innerHTML = '<div style="color:#ff6b6b;font-size:12px;">Bootstrap failed: ' + escH(e.message || 'unknown') + '</div>';
  }
}

async function bulkAcceptFaqs() {
  const picks = Array.from(document.querySelectorAll('.bs-pick:checked')).map(c => Number(c.getAttribute('data-idx')));
  if (picks.length === 0) { toast('Nothing selected'); return; }
  const accepted = picks.map(idx => ({
    title:   document.querySelector('.bs-title[data-idx="' + idx + '"]').value.trim(),
    content: document.querySelector('.bs-content[data-idx="' + idx + '"]').value.trim(),
  })).filter(a => a.title && a.content);
  try {
    const r = await apiPost('/api/dashboard/faq-bootstrap/accept', { accepted });
    if (r.ok) {
      toast('✓ Saved ' + r.saved + ' to knowledge base' + (r.skipped ? ' (' + r.skipped + ' skipped)' : ''));
      document.getElementById('bootstrap-results').innerHTML = '';
      loadKnowledgeDocs();
      loadKnowledgeGaps();
    } else { toast(r.error || 'Save failed'); }
  } catch (e) { toast('Bulk save failed'); }
}

async function acceptGapDraft() {
  const title = document.getElementById('gap-title').value.trim();
  const content = document.getElementById('gap-content').value.trim();
  if (!title || !content) { toast('Title + content required'); return; }
  try {
    const r = await apiPost('/api/dashboard/knowledge', { title, content });
    if (r.ok) {
      toast('✓ Added — Aria will use this next time customers ask');
      document.getElementById('gap-draft').innerHTML = '';
      loadKnowledgeDocs();
    } else toast(r.error || 'Save failed');
  } catch (e) { toast('Save failed'); }
}

// ─── Quick Train wizard — one-line input → full draft via Claude ─────────
function renderQuickTrainCard() {
  const el = document.getElementById('train-quick');
  el.innerHTML =
    '<div style="background:linear-gradient(135deg,rgba(108,99,255,0.12),rgba(108,99,255,0.03));border:1px dashed rgba(108,99,255,0.4);border-radius:14px;padding:20px;">' +
      '<h4 style="font-size:14px;color:#fff;margin-bottom:6px;display:flex;align-items:center;gap:8px;">✨ Quick Train <span style="font-size:11px;font-weight:400;color:#9898b8;">— let Aria draft everything for you</span></h4>' +
      '<p style="font-size:12.5px;color:#9898b8;margin-bottom:14px;line-height:1.6;">Paste your website URL or describe your business in a sentence. Aria will read it and draft your knowledge doc, services carousel, and topic scope — you just review + accept.</p>' +
      '<div class="form-group" style="margin-bottom:10px;"><label>Your website URL (optional)</label><input id="qt-url" type="text" placeholder="https://your-business.co.uk"></div>' +
      '<div class="form-group" style="margin-bottom:12px;"><label>Or describe your business in 1-3 sentences</label><textarea id="qt-desc" rows="3" placeholder="e.g. I run How High Scaffolding in Carlisle. We do domestic and commercial scaffolding, all NASC-compliant. Free quotes within 24 hours."></textarea></div>' +
      '<button class="cta-btn" onclick="runQuickTrain()" id="qt-btn">✨ Generate draft</button>' +
      '<div id="qt-result" style="margin-top:16px;"></div>' +
    '</div>';
}

async function runQuickTrain() {
  const url = document.getElementById('qt-url').value.trim();
  const desc = document.getElementById('qt-desc').value.trim();
  if (!url && !desc) { toast('Enter a URL or description'); return; }
  const btn = document.getElementById('qt-btn');
  const result = document.getElementById('qt-result');
  btn.disabled = true;
  btn.textContent = '⏳ Aria is reading…';
  result.innerHTML = '';
  try {
    const r = await apiPost('/api/dashboard/ai-train', { websiteUrl: url, description: desc });
    if (r.error) { toast(r.error); btn.disabled = false; btn.textContent = '✨ Generate draft'; return; }
    window._qtDraft = r;
    renderQuickTrainResult(r);
  } catch (e) { toast('Draft failed: ' + e.message); btn.disabled = false; btn.textContent = '✨ Generate draft'; }
}

function renderQuickTrainResult(r) {
  const el = document.getElementById('qt-result');
  const btn = document.getElementById('qt-btn');
  btn.disabled = false;
  btn.textContent = '✨ Re-generate draft';
  const kd = r.knowledgeDoc;
  const services = r.services || [];
  const topics = r.allowedTopics || [];
  el.innerHTML =
    '<div style="background:rgba(0,229,160,0.05);border:1px solid rgba(0,229,160,0.3);border-radius:12px;padding:16px;margin-top:14px;">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">' +
        '<b style="color:#00e5a0;font-size:13px;">📝 Aria\\'s draft — review + accept what you want</b>' +
        '<button onclick="acceptAllQt()" style="background:#00e5a0;color:#0d0d1f;border:none;border-radius:8px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;">+ Accept ALL</button>' +
      '</div>' +
      (kd ? '<div style="background:rgba(255,255,255,0.03);border-radius:10px;padding:12px;margin-bottom:12px;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
          '<b style="color:#fff;font-size:12.5px;">📚 ' + escH(kd.title || 'Knowledge document') + '</b>' +
          '<button onclick="acceptQtDoc()" style="background:rgba(0,229,160,0.15);color:#00e5a0;border:1px solid rgba(0,229,160,0.3);border-radius:6px;padding:3px 12px;font-size:11px;cursor:pointer;font-family:inherit;">+ Accept</button>' +
        '</div>' +
        '<div style="font-size:12px;color:#bbb;white-space:pre-wrap;max-height:160px;overflow-y:auto;line-height:1.6;">' + escH(kd.content || '') + '</div>' +
      '</div>' : '') +
      (services.length ? '<div style="background:rgba(255,255,255,0.03);border-radius:10px;padding:12px;margin-bottom:12px;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
          '<b style="color:#fff;font-size:12.5px;">🎠 Services (' + services.length + ')</b>' +
          '<button onclick="acceptQtServices()" style="background:rgba(0,229,160,0.15);color:#00e5a0;border:1px solid rgba(0,229,160,0.3);border-radius:6px;padding:3px 12px;font-size:11px;cursor:pointer;font-family:inherit;">+ Accept all</button>' +
        '</div>' +
        services.map(s => '<div style="font-size:12px;color:#bbb;padding:4px 0;"><b>' + escH(s.title) + '</b> · ' + escH(s.subtitle || '') + '</div>').join('') +
      '</div>' : '') +
      (topics.length ? '<div style="background:rgba(255,255,255,0.03);border-radius:10px;padding:12px;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">' +
          '<b style="color:#fff;font-size:12.5px;">🚦 Topic Scope (' + topics.length + ')</b>' +
          '<button onclick="acceptQtTopics()" style="background:rgba(0,229,160,0.15);color:#00e5a0;border:1px solid rgba(0,229,160,0.3);border-radius:6px;padding:3px 12px;font-size:11px;cursor:pointer;font-family:inherit;">+ Accept all</button>' +
        '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:5px;">' +
          topics.map(t => '<span style="background:rgba(255,255,255,0.06);color:#ccc;padding:3px 10px;border-radius:12px;font-size:11.5px;">' + escH(t) + '</span>').join('') +
        '</div>' +
      '</div>' : '') +
    '</div>';
}

async function acceptQtDoc() {
  const kd = window._qtDraft?.knowledgeDoc;
  if (!kd) return;
  const r = await apiPost('/api/dashboard/knowledge', { title: kd.title, content: kd.content });
  if (r.ok) { toast('Knowledge doc added'); loadKnowledgeDocs(); }
}
async function acceptQtServices() {
  const services = window._qtDraft?.services;
  if (!services?.length) return;
  // Merge with any existing
  const existing = window._services || [];
  window._services = existing.concat(services).slice(0, 10);
  const r = await apiPost('/api/dashboard/profile', { owner: OWNER, servicesCarousel: window._services });
  if (r.ok) { toast('Services added'); loadServicesEditor(); }
}
async function acceptQtTopics() {
  const topics = window._qtDraft?.allowedTopics;
  if (!topics?.length) return;
  const existing = window._scopeTopics || [];
  const merged = [...new Set([...existing, ...topics])];
  const r = await apiPost('/api/dashboard/profile', { owner: OWNER, allowedTopics: merged });
  if (r.ok) { toast('Topics added'); loadScopeEditor(); }
}
async function acceptAllQt() {
  if (!window._qtDraft) return;
  toast('Accepting all 3 — one moment…');
  await acceptQtDoc();
  await acceptQtServices();
  await acceptQtTopics();
  document.getElementById('qt-result').innerHTML = '<div style="text-align:center;color:#00e5a0;padding:16px;font-size:13px;">✓ All accepted. Aria is now trained on your business.</div>';
}

async function loadKnowledgeDocs() {
  const el = document.getElementById('train-knowledge');
  try {
    const d = await api('/api/dashboard/knowledge');
    const rows = (d.docs || []).map((doc, i) => {
      return '<div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px;">' +
        '<div style="min-width:0;flex:1;">' +
          '<div style="font-size:13px;color:#fff;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escH(doc.title) + '</div>' +
          '<div style="font-size:11px;color:#8888aa;margin-top:2px;">' + (doc.charCount || 0).toLocaleString() + ' chars · uploaded ' + timeAgo(doc.uploadedAt) + '</div>' +
        '</div>' +
        '<button onclick="deleteKnowledgeDoc(' + i + ')" style="background:rgba(255,80,80,0.1);color:#ff6b6b;border:1px solid rgba(255,80,80,0.2);border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;font-family:inherit;flex-shrink:0;">Remove</button>' +
      '</div>';
    }).join('');
    el.innerHTML =
      '<h4 style="font-size:13px;color:#fff;margin-bottom:10px;">📚 Knowledge Documents <span style="font-size:11px;font-weight:400;color:#8888aa;">— Aria cites these for accurate answers (no hallucination)</span></h4>' +
      (rows ? '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;">' + rows + '</div>' : '<div class="empty" style="padding:14px 0">No documents yet. Paste your services, prices, FAQ, policies — anything Aria should know.</div>') +
      '<div style="background:rgba(0,229,160,0.05);border:1px solid rgba(0,229,160,0.15);border-radius:10px;padding:14px;">' +
        '<div class="form-group" style="margin-bottom:10px;"><label>Document title</label><input id="kd-title" type="text" placeholder="e.g. Service prices, Booking policy, Care instructions"></div>' +
        '<div class="form-group" style="margin-bottom:12px;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">' +
            '<label style="margin-bottom:0;">Content (paste any plain text — services, prices, FAQ, policies, etc.)</label>' +
            '<button onclick="improveKnowledge()" style="background:rgba(108,99,255,0.15);color:#9d96ff;border:1px solid rgba(108,99,255,0.3);border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;font-family:inherit;" title="Polish + structure this text with AI">✨ Improve with AI</button>' +
          '</div>' +
          '<textarea id="kd-content" rows="6" placeholder="Hair colour: £85-150 depending on length. Cuts: £35. Open Tue-Sat 9am-6pm. Cancellation: 24hr notice required..."></textarea>' +
        '</div>' +
        '<button class="btn-save" onclick="uploadKnowledgeDoc()">+ Add to Aria\\'s knowledge</button>' +
      '</div>';
  } catch (e) {
    el.innerHTML = '<div class="empty">Failed to load knowledge docs.</div>';
  }
}

async function uploadKnowledgeDoc() {
  const title = document.getElementById('kd-title').value.trim();
  const content = document.getElementById('kd-content').value.trim();
  if (!title || !content) { toast('Title + content required'); return; }
  try {
    const r = await apiPost('/api/dashboard/knowledge', { title, content });
    if (r.ok) { toast('Document added — Aria will cite it from now on'); loadKnowledgeDocs(); }
    else toast(r.error || 'Upload failed');
  } catch (e) { toast('Upload failed'); }
}

// AI polish for the knowledge content textarea — owner writes a rough
// draft, clicks ✨ Improve, gets it back structured + warmer.
async function improveKnowledge() {
  const ta = document.getElementById('kd-content');
  const current = ta.value.trim();
  if (!current) { toast('Write something first, then I can improve it'); return; }
  const instruction = prompt('How should Aria improve this? (Examples: "polish for clarity", "add headers + structure", "make it warmer", "shorten by half")', 'Polish for clarity + add structure');
  if (instruction === null) return; // cancelled
  toast('⏳ Improving…');
  try {
    const r = await apiPost('/api/dashboard/ai-improve', { current, instruction, kind: 'knowledge' });
    if (r.improved) {
      ta.value = r.improved;
      toast('✓ Improved — review before saving');
    } else { toast(r.error || 'Improve failed'); }
  } catch (e) { toast('Improve failed: ' + e.message); }
}

async function deleteKnowledgeDoc(idx) {
  if (!confirm('Remove this document from Aria\\'s knowledge?')) return;
  try {
    const r = await fetch('/api/dashboard/knowledge/' + idx + '?' + Q, { method: 'DELETE' });
    const d = await r.json();
    if (d.ok) { toast('Removed'); loadKnowledgeDocs(); }
  } catch (e) { toast('Remove failed'); }
}

async function loadServicesEditor() {
  const el = document.getElementById('train-services');
  try {
    const d = await api('/api/dashboard/profile');
    const services = (d.profile?.servicesCarousel) || [];
    el.innerHTML =
      '<h4 style="font-size:13px;color:#fff;margin-bottom:10px;">🎠 Services Carousel <span style="font-size:11px;font-weight:400;color:#8888aa;">— shown when customers ask "what do you offer"</span></h4>' +
      '<div id="services-list" style="display:flex;flex-direction:column;gap:10px;margin-bottom:12px;"></div>' +
      '<button class="btn-save" onclick="addServiceCard()" style="background:rgba(255,255,255,0.06);color:#00e5a0;border:1px solid rgba(0,229,160,0.3);">+ Add service card</button>';
    window._services = services.length ? services : [];
    renderServicesList();
  } catch (e) { el.innerHTML = '<div class="empty">Failed to load services.</div>'; }
}

function renderServicesList() {
  const list = document.getElementById('services-list');
  if (!list) return;
  if (!window._services?.length) {
    list.innerHTML = '<div class="empty" style="padding:14px 0">No services yet. Add 2-5 of your most-asked-for services with photos.</div>';
    return;
  }
  list.innerHTML = window._services.map((s, i) =>
    '<div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px;">' +
      '<div style="display:flex;align-items:start;gap:12px;">' +
        (s.image ? '<img src="' + escH(s.image) + '" style="width:60px;height:60px;border-radius:8px;object-fit:cover;flex-shrink:0;" onerror="this.style.display=\\'none\\'">' : '') +
        '<div style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:8px;">' +
          '<input placeholder="Title" value="' + escH(s.title || '') + '" oninput="window._services[' + i + '].title=this.value">' +
          '<input placeholder="Subtitle (price, duration, etc)" value="' + escH(s.subtitle || '') + '" oninput="window._services[' + i + '].subtitle=this.value">' +
          '<input placeholder="Image URL (optional)" value="' + escH(s.image || '') + '" oninput="window._services[' + i + '].image=this.value" style="grid-column:span 2">' +
          '<input placeholder="Link URL (optional)" value="' + escH(s.link || '') + '" oninput="window._services[' + i + '].link=this.value">' +
          '<input placeholder="Button text (e.g. Book now)" value="' + escH(s.btn_text || '') + '" oninput="window._services[' + i + '].btn_text=this.value">' +
        '</div>' +
        '<button onclick="removeService(' + i + ')" style="background:rgba(255,80,80,0.1);color:#ff6b6b;border:1px solid rgba(255,80,80,0.2);border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;font-family:inherit;flex-shrink:0;">×</button>' +
      '</div>' +
    '</div>').join('') +
    '<button class="btn-save" onclick="saveServices()" style="margin-top:8px;">Save services</button>';
}

function addServiceCard() {
  window._services = window._services || [];
  if (window._services.length >= 10) { toast('Max 10 service cards'); return; }
  window._services.push({ title: '', subtitle: '', image: '', link: '', btn_text: 'Learn more' });
  renderServicesList();
}

function removeService(i) {
  window._services.splice(i, 1);
  renderServicesList();
}

async function saveServices() {
  try {
    const r = await apiPost('/api/dashboard/profile', { owner: OWNER, servicesCarousel: window._services });
    if (r.ok) toast('Services saved — Aria will show these when asked');
  } catch (e) { toast('Save failed'); }
}

// ─── Business Hours editor ───────────────────────────────────────────────
async function loadBusinessHoursEditor() {
  const el = document.getElementById('train-hours');
  try {
    const d = await api('/api/dashboard/profile');
    const sched = d.profile?.schedule || { mode: 'always' };
    window._schedule = JSON.parse(JSON.stringify(sched)); // editable copy
    renderHoursEditor();
  } catch (e) { el.innerHTML = '<div class="empty">Failed to load hours.</div>'; }
}

function renderHoursEditor() {
  const el = document.getElementById('train-hours');
  const sched = window._schedule || { mode: 'always' };
  const mode = sched.mode || 'always';
  const tz = sched.timezone || 'Europe/London';
  const hours = sched.businessHours || { mon: '9-18', tue: '9-18', wed: '9-18', thu: '9-18', fri: '9-18', sat: 'closed', sun: 'closed' };
  const ooh = sched.outOfHoursMode || 'auto_reply';
  const oohMsg = sched.outOfHoursMessage || 'Thanks for getting in touch! We are currently closed but will reply as soon as we are open.';

  // Live status — uses the SAME logic the server uses
  const liveBadge = computeLiveScheduleBadge(sched);

  const days = [
    { key: 'mon', label: 'Mon' }, { key: 'tue', label: 'Tue' }, { key: 'wed', label: 'Wed' },
    { key: 'thu', label: 'Thu' }, { key: 'fri', label: 'Fri' }, { key: 'sat', label: 'Sat' }, { key: 'sun', label: 'Sun' },
  ];

  el.innerHTML =
    '<h4 style="font-size:13px;color:#fff;margin-bottom:6px;display:flex;align-items:center;gap:8px;">🕐 Business Hours <span style="font-size:11px;font-weight:400;color:#9898b8;">— when Aria is allowed to auto-reply</span></h4>' +
    '<p style="font-size:12px;color:#8888aa;margin-bottom:14px;">' + liveBadge + '</p>' +
    '<div class="form-group" style="margin-bottom:14px;">' +
      '<label>Mode</label>' +
      '<select onchange="updateSchedule(\\'mode\\',this.value)" style="width:auto;min-width:240px;">' +
        '<option value="always" ' + (mode === 'always' ? 'selected' : '') + '>Always on (24/7)</option>' +
        '<option value="business_hours" ' + (mode === 'business_hours' ? 'selected' : '') + '>Business hours only</option>' +
      '</select>' +
    '</div>' +
    (mode === 'business_hours' ? (
      '<div class="form-group" style="margin-bottom:14px;">' +
        '<label>Timezone</label>' +
        '<input type="text" value="' + escH(tz) + '" oninput="updateSchedule(\\'timezone\\',this.value)" placeholder="Europe/London" style="max-width:240px;">' +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:18px;">' +
        days.map(d => {
          const val = hours[d.key] || 'closed';
          return '<div style="display:flex;align-items:center;gap:10px;background:rgba(255,255,255,0.03);padding:8px 12px;border-radius:8px;">' +
            '<div style="min-width:40px;font-size:12px;color:#aaa;text-transform:uppercase;font-weight:600;">' + d.label + '</div>' +
            '<input type="text" value="' + escH(val) + '" oninput="updateHoursDay(\\'' + d.key + '\\',this.value)" placeholder="closed" style="flex:1;font-size:12.5px;background:rgba(255,255,255,0.04);">' +
          '</div>';
        }).join('') +
      '</div>' +
      '<p style="font-size:11px;color:#6b6b8a;margin-top:-10px;margin-bottom:14px;">Format: "9-18" or "9:30-17:30" · "closed" · "24h"</p>' +
      '<div class="form-group" style="margin-bottom:14px;">' +
        '<label>Outside-hours behaviour</label>' +
        '<select onchange="updateSchedule(\\'outOfHoursMode\\',this.value)" style="width:auto;min-width:240px;">' +
          '<option value="auto_reply" ' + (ooh === 'auto_reply' ? 'selected' : '') + '>Send polite "we are closed" reply</option>' +
          '<option value="silent" ' + (ooh === 'silent' ? 'selected' : '') + '>Silent (log message, no reply)</option>' +
        '</select>' +
      '</div>' +
      (ooh === 'auto_reply' ? (
        '<div class="form-group" style="margin-bottom:14px;">' +
          '<label>Out-of-hours message</label>' +
          '<textarea rows="3" oninput="updateSchedule(\\'outOfHoursMessage\\',this.value)" placeholder="Thanks for getting in touch! We are currently closed...">' + escH(oohMsg) + '</textarea>' +
        '</div>'
      ) : '')
    ) : '') +
    '<button class="btn-save" onclick="saveSchedule()">Save business hours</button>';
}

function computeLiveScheduleBadge(sched) {
  if (!sched || sched.mode === 'always' || !sched.mode) {
    return '<span style="background:rgba(0,229,160,0.1);color:#00e5a0;padding:2px 10px;border-radius:10px;font-weight:600;">🟢 Aria is always on</span>';
  }
  // Approximate the server-side check client-side (same logic, in browser TZ)
  try {
    const tz = sched.timezone || 'Europe/London';
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false });
    const parts = fmt.formatToParts(now);
    const wd = parts.find(p => p.type === 'weekday').value.toLowerCase().slice(0, 3);
    const hour = Number(parts.find(p => p.type === 'hour').value);
    const min = Number(parts.find(p => p.type === 'minute').value);
    const minutes = hour * 60 + min;
    const today = (sched.businessHours || {})[wd] || 'closed';
    const m = String(today).match(/^\s*(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*$/);
    let inHours = today === '24h';
    if (m) {
      const startMin = Number(m[1]) * 60 + Number(m[2] || 0);
      const endMin = Number(m[3]) * 60 + Number(m[4] || 0);
      inHours = minutes >= startMin && minutes < endMin;
    }
    return inHours
      ? '<span style="background:rgba(0,229,160,0.1);color:#00e5a0;padding:2px 10px;border-radius:10px;font-weight:600;">🟢 Aria is ON right now (' + wd + ' ' + String(hour).padStart(2,'0') + ':' + String(min).padStart(2,'0') + ' ' + tz + ')</span>'
      : '<span style="background:rgba(251,191,36,0.1);color:#fbbf24;padding:2px 10px;border-radius:10px;font-weight:600;">🌙 Aria is OFF right now (' + wd + ' ' + String(hour).padStart(2,'0') + ':' + String(min).padStart(2,'0') + ' ' + tz + ' — outside business hours)</span>';
  } catch { return ''; }
}

function updateSchedule(key, value) {
  window._schedule = window._schedule || {};
  if (key === 'mode' && value === 'always') {
    // Switching to always-on — keep stored hours but rerender simpler view
    window._schedule.mode = 'always';
  } else {
    window._schedule[key] = value;
    if (key === 'mode' && value === 'business_hours' && !window._schedule.businessHours) {
      window._schedule.businessHours = { mon: '9-18', tue: '9-18', wed: '9-18', thu: '9-18', fri: '9-18', sat: 'closed', sun: 'closed' };
    }
  }
  renderHoursEditor();
}

function updateHoursDay(day, value) {
  window._schedule = window._schedule || {};
  window._schedule.businessHours = window._schedule.businessHours || {};
  window._schedule.businessHours[day] = value;
  // Don't full-re-render — just update the live badge so cursor doesn't jump in input
  const liveDiv = document.querySelector('#train-hours p');
  if (liveDiv) liveDiv.innerHTML = computeLiveScheduleBadge(window._schedule);
}

async function saveSchedule() {
  try {
    const r = await apiPost('/api/dashboard/profile', { owner: OWNER, schedule: window._schedule });
    if (r.ok) toast('Business hours saved');
    loadBusinessHoursEditor(); // refresh badge
  } catch (e) { toast('Save failed'); }
}

async function loadScopeEditor() {
  const el = document.getElementById('train-scope');
  try {
    const d = await api('/api/dashboard/profile');
    const topics = d.profile?.allowedTopics || [];
    window._scopeTopics = topics.slice();
    el.innerHTML =
      '<h4 style="font-size:13px;color:#fff;margin-bottom:10px;">🚦 Topic Scope <span style="font-size:11px;font-weight:400;color:#8888aa;">— what Aria should answer (everything else gets a polite redirect)</span></h4>' +
      '<p style="font-size:12px;color:#8888aa;margin-bottom:10px;">Leave empty if Aria can answer anything. Otherwise add topics like "scaffolding hire", "hair colouring", "garden design".</p>' +
      '<div id="scope-chips" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;min-height:32px;"></div>' +
      '<div style="display:flex;gap:8px;">' +
        '<input id="scope-input" placeholder="e.g. plumbing repairs" style="flex:1;" onkeydown="if(event.key===\\'Enter\\'){event.preventDefault();addScopeTopic()}">' +
        '<button class="btn-save" onclick="addScopeTopic()" style="padding:10px 18px;">Add</button>' +
      '</div>' +
      '<button class="btn-save" onclick="saveScope()" style="margin-top:12px;">Save topics</button>';
    renderScopeChips();
  } catch (e) { el.innerHTML = '<div class="empty">Failed to load scope.</div>'; }
}

function renderScopeChips() {
  const chips = document.getElementById('scope-chips');
  if (!chips) return;
  if (!window._scopeTopics?.length) {
    chips.innerHTML = '<div style="font-size:12px;color:#6b6b8a;">No topics set — Aria will answer anything in scope of her general business prompt.</div>';
    return;
  }
  chips.innerHTML = window._scopeTopics.map((t, i) =>
    '<span style="background:rgba(0,229,160,0.1);color:#00e5a0;border:1px solid rgba(0,229,160,0.3);border-radius:20px;padding:5px 12px;font-size:12px;display:inline-flex;align-items:center;gap:6px;">' +
      escH(t) +
      '<button onclick="removeScopeTopic(' + i + ')" style="background:none;border:none;color:#00e5a0;cursor:pointer;font-size:14px;padding:0;line-height:1;">×</button>' +
    '</span>').join('');
}

function addScopeTopic() {
  const inp = document.getElementById('scope-input');
  const t = inp.value.trim();
  if (!t) return;
  window._scopeTopics = window._scopeTopics || [];
  if (window._scopeTopics.includes(t)) { toast('Already added'); return; }
  window._scopeTopics.push(t);
  inp.value = '';
  renderScopeChips();
}

function removeScopeTopic(i) {
  window._scopeTopics.splice(i, 1);
  renderScopeChips();
}

async function saveScope() {
  try {
    const r = await apiPost('/api/dashboard/profile', { owner: OWNER, allowedTopics: window._scopeTopics });
    if (r.ok) toast('Scope saved — Aria will stay on-topic');
  } catch (e) { toast('Save failed'); }
}

let inboxPage = 1;
async function loadInbox(page) {
  inboxPage = page;
  const body = document.getElementById('body-inbox');
  try {
    const d = await api('/api/dashboard/inbox-log?page=' + page);
    if (!d.items.length) { body.innerHTML = '<div class="empty">No emails replied yet.</div>'; return; }
    let html = '<table><thead><tr><th>From</th><th>Subject</th><th>When</th></tr></thead><tbody>';
    for (const r of d.items) {
      html += '<tr><td>' + escH(r.senderEmail) + '</td><td>' + escH(r.subject) + '</td><td>' + timeAgo(r.sentAt) + '</td></tr>';
    }
    html += '</tbody></table>';
    if (d.totalPages > 1) {
      html += '<div class="pagination">';
      for (let i = 1; i <= d.totalPages; i++) {
        html += '<button class="' + (i === page ? 'active' : '') + '" onclick="loadInbox(' + i + ')">' + i + '</button>';
      }
      html += '</div>';
    }
    body.innerHTML = html;
  } catch (e) { body.innerHTML = '<div class="empty">Failed to load inbox log.</div>'; }
}

async function loadLeads() {
  const body = document.getElementById('body-leads');
  try {
    const d = await api('/api/dashboard/leads');
    if (!d.leads.length) {
      body.innerHTML = '<div class="empty-state"><div class="es-ic">🎯</div><div class="es-t">No leads yet</div><div class="es-s">Leads appear here automatically when Aria captures a name, email, or phone during a conversation. Connect a channel to get started.</div><button class="cta-btn" style="margin-top:16px" onclick="showPanel(\\'channels\\')">Connect a channel →</button></div>';
      return;
    }
    let html = '<table><thead><tr><th>Name</th><th>Email</th><th>Phone</th></tr></thead><tbody>';
    for (const l of d.leads) {
      html += '<tr><td>' + escH(l.name || '—') + '</td><td>' + escH(l.email) + '</td><td>' + escH(l.phone || '—') + '</td></tr>';
    }
    html += '</tbody></table>';
    body.innerHTML = html;
  } catch (e) { body.innerHTML = '<div class="empty">Failed to load leads.</div>'; }
}

async function loadBookings() {
  const body = document.getElementById('body-bookings');
  try {
    const d = await api('/api/dashboard/bookings');
    if (!d.bookings.length) {
      body.innerHTML = '<div class="empty-state"><div class="es-ic">📅</div><div class="es-t">No bookings yet</div><div class="es-s">When a customer asks to book or hire, Aria collects the details (name, contact, time), checks for clashes, saves it here, emails you a calendar invite, and sends the customer a confirmation.</div></div>';
      return;
    }
    const icons = { email: '📧', facebook: '📘', instagram: '📷', whatsapp: '💬' };
    let html = '<div style="display:flex;flex-direction:column;gap:10px;">';
    for (const b of d.bookings) {
      const when = b.datetime || b.date || '—';
      const channel = b.channel || 'email';
      const icsBtn = b.icsFilename
        ? '<a href="/api/dashboard/booking-ics/' + encodeURIComponent(b.icsFilename) + '?' + Q + '" download style="background:rgba(0,229,160,0.15);color:#00e5a0;border:1px solid rgba(0,229,160,0.3);border-radius:6px;padding:4px 10px;font-size:11px;text-decoration:none;flex-shrink:0;">📅 .ics</a>'
        : '';
      html += '<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:12px 14px;display:flex;align-items:center;gap:12px;">' +
        '<div style="font-size:18px;flex-shrink:0;">' + (icons[channel] || '📅') + '</div>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:13px;color:#fff;font-weight:600;">' + escH(b.name || '—') + (b.service ? ' <span style="color:#8888aa;font-weight:400;">— ' + escH(b.service) + '</span>' : '') + '</div>' +
          '<div style="font-size:11.5px;color:#00e5a0;margin-top:2px;">📅 ' + escH(when) + '</div>' +
          (b.contact ? '<div style="font-size:11.5px;color:#8888aa;margin-top:2px;">' + escH(b.contact) + '</div>' : '') +
          (b.notes ? '<div style="font-size:11px;color:#6b6b8a;margin-top:4px;font-style:italic;">' + escH(b.notes) + '</div>' : '') +
        '</div>' +
        icsBtn +
      '</div>';
    }
    html += '</div>';
    body.innerHTML = html;
  } catch (e) { body.innerHTML = '<div class="empty">Failed to load bookings.</div>'; }
}

async function loadProfile() {
  const body = document.getElementById('body-profile');
  try {
    const d = await api('/api/dashboard/profile');
    const p = d.profile || {};
    body.innerHTML = \`
      <div class="form-group"><label>Business Name</label><input type="text" id="pf-name" value="\${escH(p.businessName || '')}"></div>
      <div class="form-group"><label>Services</label><textarea id="pf-services">\${escH(p.services || '')}</textarea></div>
      <div class="form-group"><label>Location</label><input type="text" id="pf-location" value="\${escH(p.location || '')}"></div>
      <div class="form-group"><label>Phone</label><input type="text" id="pf-phone" value="\${escH(p.phone || '')}"></div>
      <div class="form-group"><label>Email</label><input type="text" id="pf-email" value="\${escH(p.email || OWNER)}"></div>
      <div class="form-group"><label>Hours</label><input type="text" id="pf-hours" value="\${escH(p.hours || '')}"></div>
      <div class="form-group"><label>Tone</label>
        <select id="pf-tone">
          <option value="friendly" \${p.tone==='friendly'?'selected':''}>Friendly</option>
          <option value="professional" \${p.tone==='professional'?'selected':''}>Professional</option>
          <option value="casual" \${p.tone==='casual'?'selected':''}>Casual</option>
          <option value="formal" \${p.tone==='formal'?'selected':''}>Formal</option>
        </select>
      </div>
      <button class="btn-save" onclick="saveProfile()">Save Profile</button>
    \`;
  } catch (e) { body.innerHTML = '<div class="empty">Failed to load profile.</div>'; }
}

async function saveProfile() {
  const data = {
    owner: OWNER,
    businessName: document.getElementById('pf-name').value,
    services: document.getElementById('pf-services').value,
    location: document.getElementById('pf-location').value,
    phone: document.getElementById('pf-phone').value,
    email: document.getElementById('pf-email').value,
    hours: document.getElementById('pf-hours').value,
    tone: document.getElementById('pf-tone').value
  };
  try {
    const r = await apiPost('/api/dashboard/profile', data);
    if (r.ok) toast('Profile saved!');
    else toast('Failed to save');
  } catch (e) { toast('Error saving profile'); }
}

async function loadSettings() {
  const body = document.getElementById('body-settings');
  try {
    const [d, profile] = await Promise.all([api('/api/dashboard/settings'), api('/api/dashboard/profile')]);
    const ob = profile?.profile?.outbound || {};
    const leadFu = ob.leadFollowup !== false; // default ON
    const bookRem = ob.bookingReminder !== false;
    const convRec = ob.convRecovery !== false;
    body.innerHTML = \`
      <h4 style="font-size:13px;color:#fff;margin:4px 0 12px;">Email auto-reply</h4>
      <div class="toggle-row">
        <div class="info">Auto-Reply<small>Automatically reply to incoming emails using AI</small></div>
        <label class="toggle"><input type="checkbox" id="tog-autoreply" \${d.autoReplyEnabled?'checked':''} onchange="saveSetting('autoReplyEnabled',this.checked)"><span class="slider"></span></label>
      </div>
      <div class="toggle-row">
        <div class="info">Approval Mode<small>Review AI drafts before they are sent</small></div>
        <label class="toggle"><input type="checkbox" id="tog-approval" \${d.approvalMode?'checked':''} onchange="saveSetting('approvalMode',this.checked)"><span class="slider"></span></label>
      </div>
      <div class="toggle-row">
        <div class="info">Follow-Ups<small>Send automatic follow-up emails if no response</small></div>
        <label class="toggle"><input type="checkbox" id="tog-followups" \${d.followUpsEnabled?'checked':''} onchange="saveSetting('followUpsEnabled',this.checked)"><span class="slider"></span></label>
      </div>

      <h4 style="font-size:13px;color:#fff;margin:24px 0 12px;">Outbound nudges from Aria</h4>
      <div class="toggle-row">
        <div class="info">Lead follow-up email<small>~3 min after a hot lead with email captured, Aria sends a personalised "thanks for getting in touch" email</small></div>
        <label class="toggle"><input type="checkbox" id="ob-lead" \${leadFu?'checked':''} onchange="saveOutbound('leadFollowup',this.checked)"><span class="slider"></span></label>
      </div>
      <div class="toggle-row">
        <div class="info">Booking reminders<small>24h before each booking, Aria reminds the customer via the channel they booked on + email</small></div>
        <label class="toggle"><input type="checkbox" id="ob-book" \${bookRem?'checked':''} onchange="saveOutbound('bookingReminder',this.checked)"><span class="slider"></span></label>
      </div>
      <div class="toggle-row">
        <div class="info">Conversation recovery<small>If a 3+ exchange conv goes quiet 24-72h, Aria sends a friendly nudge with "Yes still keen / Not right now" buttons</small></div>
        <label class="toggle"><input type="checkbox" id="ob-conv" \${convRec?'checked':''} onchange="saveOutbound('convRecovery',this.checked)"><span class="slider"></span></label>
      </div>

      <h4 style="font-size:13px;color:#fff;margin:24px 0 12px;">Connections</h4>
      <div class="toggle-row">
        <div class="info">Gmail Status<small>\${d.gmailConnected ? 'Connected and active' : 'Not connected'}</small></div>
        <div>\${d.gmailConnected ? '<span class="badge-on">Connected</span>' : '<span class="badge-off">Disconnected</span>'}</div>
      </div>
      <a class="gmail-link" href="/connect/gmail?owner=\${encodeURIComponent(OWNER)}&s=\${encodeURIComponent(TOKEN)}">
        <svg viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
        Gmail Settings
      </a>

      <h4 style="font-size:13px;color:#fff;margin:24px 0 12px;">📞 Phone receptionist <span style="font-size:11px;font-weight:400;color:#9898b8;">— Aria answers your phone, books + quotes by voice</span></h4>
      <div id="phone-panel"><div class="empty" style="padding:14px 0;font-size:12px;">Loading…</div></div>

      <h4 style="font-size:13px;color:#fff;margin:24px 0 12px;">📋 Notification digest <span style="font-size:11px;font-weight:400;color:#9898b8;">— batch informational alerts into one daily email</span></h4>
      <div id="digest-panel"><div class="empty" style="padding:14px 0;font-size:12px;">Loading…</div></div>

      <h4 style="font-size:13px;color:#fff;margin:24px 0 12px;">⭐ Review requests <span style="font-size:11px;font-weight:400;color:#9898b8;">— Aria auto-asks for a Google review 24h after each booking</span></h4>
      <div id="reviews-panel"><div class="empty" style="padding:14px 0;font-size:12px;">Loading…</div></div>

      <h4 style="font-size:13px;color:#fff;margin:24px 0 12px;">🔗 Webhooks <span style="font-size:11px;font-weight:400;color:#9898b8;">— pipe Aria events to Zapier, Slack, your CRM</span></h4>
      <div id="webhooks-panel"><div class="empty" style="padding:14px 0;font-size:12px;">Loading…</div></div>
    \`;
    loadWebhooks();
    loadReviewSettings();
    loadDigestSettings();
    loadPhoneSettings();
  } catch (e) { body.innerHTML = '<div class="empty">Failed to load settings.</div>'; }
}

// ─── Phone receptionist settings panel ──────────────────────────────────
async function loadPhoneSettings() {
  const el = document.getElementById('phone-panel');
  if (!el) return;
  try {
    const d = await api('/api/dashboard/phone/settings');
    const s = d.settings || {};

    // PLAN GATE — Lite owners see an upsell, not the controls. Drives the
    // upgrade without exposing any voice surface they aren't paying for.
    if (!d.planAllowed) {
      el.innerHTML =
        '<div style="background:linear-gradient(135deg,rgba(157,150,255,0.1),rgba(0,229,160,0.08));border:1px solid rgba(157,150,255,0.3);border-radius:12px;padding:20px;text-align:center;">' +
          '<div style="font-size:28px;margin-bottom:8px;">📞</div>' +
          '<div style="font-size:15px;color:#fff;font-weight:700;margin-bottom:6px;">Add a phone receptionist</div>' +
          '<p style="font-size:12.5px;color:#9898b8;margin:0 auto 14px;max-width:380px;line-height:1.6;">Upgrade to the <b style="color:#9d96ff;">Receptionist</b> plan and Aria answers your phone 24/7 — booking appointments, taking quote requests, and texting callers a follow-up. Everything your inbox Aria does, now by voice.</p>' +
          '<div style="font-size:11.5px;color:#6b6b8a;">You\\'re on the <b>Lite</b> plan (Instagram + Facebook DMs + email). Contact us to upgrade.</div>' +
        '</div>';
      return;
    }

    const calls = (await api('/api/dashboard/calls')).calls || [];

    const intentEmoji = { booking: '📅', quote: '💷', enquiry: '💬', complaint: '⚠️', message: '✉️', other: '📞' };
    const callRows = calls.length ? calls.slice(0, 6).map(c =>
      '<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:12px;">' +
        '<span style="font-size:14px;">' + (intentEmoji[c.intent] || '📞') + '</span>' +
        '<span style="color:#ddd;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escH(c.summary || c.intent || 'Call') + '</span>' +
        (c.recordingUrl ? '<a href="' + escH(c.recordingUrl) + '" target="_blank" style="color:#00e5a0;font-size:11px;">▶</a>' : '') +
        '<span style="color:#6b6b8a;font-size:10.5px;">' + (c.durationSec ? c.durationSec + 's · ' : '') + timeAgo(c.ts) + '</span>' +
      '</div>'
    ).join('') : '<div class="empty" style="padding:10px 0;font-size:11.5px;">No calls yet. Once your Vapi number is live, calls appear here.</div>';

    // Number block: three states —
    //  (1) has a number we provisioned → show it + forwarding tip + release
    //  (2) no number, one-click available → "Get my Aria number" button
    //  (3) no number, no provisioning → BYO paste fallback (+ webhook URL)
    let numberBlock;
    if (s.phoneNumber && s.provisioned) {
      numberBlock =
        '<div style="background:rgba(0,229,160,0.06);border:1px solid rgba(0,229,160,0.25);border-radius:8px;padding:12px 14px;margin-bottom:10px;">' +
          '<div style="font-size:10.5px;color:#8888aa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Your Aria number</div>' +
          '<div style="font-size:18px;color:#00e5a0;font-weight:700;font-family:monospace;">' + escH(s.phoneNumber) + '</div>' +
          '<p style="font-size:11px;color:#9898b8;margin:8px 0 0;line-height:1.5;">📣 Put this on your website + Google listing, OR keep your current number and set it to <b>forward calls</b> to this one (your phone provider can do this — we\\'ll guide you).</p>' +
          '<button onclick="releasePhoneNumber()" style="margin-top:10px;background:rgba(255,80,80,0.1);color:#ff6b6b;border:1px solid rgba(255,80,80,0.2);border-radius:6px;padding:5px 12px;font-size:11px;cursor:pointer;font-family:inherit;">Release number</button>' +
        '</div>';
    } else if (d.canProvision) {
      numberBlock =
        '<div style="background:rgba(157,150,255,0.06);border:1px solid rgba(157,150,255,0.25);border-radius:8px;padding:14px;margin-bottom:10px;text-align:center;">' +
          '<div style="font-size:13px;color:#fff;font-weight:600;margin-bottom:4px;">📲 Get a new Aria phone number</div>' +
          '<p style="font-size:11.5px;color:#9898b8;margin:0 0 12px;line-height:1.5;">One click and Aria gets a brand-new number, ready to answer. Use it directly or forward your existing line to it.</p>' +
          '<button onclick="provisionPhoneNumber(this)" class="btn-save" style="width:auto;padding:10px 20px;">Get my number →</button>' +
        '</div>' +
        // OR — connect a number the client already has
        '<div style="display:flex;align-items:center;gap:10px;margin:12px 0;"><div style="flex:1;height:1px;background:rgba(255,255,255,0.08);"></div><span style="font-size:11px;color:#6b6b8a;">OR</span><div style="flex:1;height:1px;background:rgba(255,255,255,0.08);"></div></div>' +
        '<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:14px;margin-bottom:10px;">' +
          '<div style="font-size:13px;color:#fff;font-weight:600;margin-bottom:4px;">📞 Use a number you already have</div>' +
          '<p style="font-size:11px;color:#9898b8;margin:0 0 10px;line-height:1.5;">Enter your existing business number. To make Aria answer it, you\\'ll either point that number\\'s call-routing at Aria, or forward its calls to an Aria number — we\\'ll guide you after you save.</p>' +
          '<div style="display:flex;gap:8px;">' +
            '<input id="ph-own-number" value="' + escH(s.phoneNumber || '') + '" placeholder="+44 7700 900123" style="flex:1;font-family:monospace;font-size:13px;">' +
            '<button onclick="connectOwnNumber()" style="background:rgba(157,150,255,0.15);color:#9d96ff;border:1px solid rgba(157,150,255,0.3);border-radius:8px;padding:8px 16px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;">Connect</button>' +
          '</div>' +
          '<div style="background:rgba(0,0,0,0.15);border-radius:6px;padding:8px 10px;margin-top:10px;">' +
            '<div style="font-size:10px;color:#8888aa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;">Webhook URL (for your number\\'s call provider)</div>' +
            '<code style="font-size:10.5px;color:#00e5a0;word-break:break-all;">' + escH(d.webhookUrl || '') + '</code>' +
          '</div>' +
        '</div>';
    } else {
      numberBlock =
        '<div class="form-group" style="margin-bottom:10px;">' +
          '<label style="font-size:11px;">Your Vapi phone number</label>' +
          '<input id="ph-number" value="' + escH(s.phoneNumber || '') + '" placeholder="+44 7700 900123" style="font-family:monospace;font-size:13px;">' +
        '</div>' +
        '<div style="background:rgba(255,255,255,0.03);border-radius:8px;padding:10px 12px;margin-bottom:10px;">' +
          '<div style="font-size:10.5px;color:#8888aa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Webhook URL — paste into your Vapi number\\'s Server settings</div>' +
          '<code style="font-size:11px;color:#00e5a0;word-break:break-all;">' + escH(d.webhookUrl || '') + '</code>' +
        '</div>';
    }

    el.innerHTML =
      '<div style="background:rgba(0,229,160,0.04);border:1px solid rgba(0,229,160,0.2);border-radius:10px;padding:14px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
          '<div style="font-size:12px;color:#fff;font-weight:600;">Voice answering ' + (s.enabled && s.phoneNumber ? '<span style="color:#00e5a0;font-size:11px;">● Live</span>' : '<span style="color:#6b6b8a;font-size:11px;">● Off</span>') + '</div>' +
          '<label class="toggle"><input type="checkbox" id="ph-enabled" ' + (s.enabled ? 'checked' : '') + '><span class="slider"></span></label>' +
        '</div>' +
        '<p style="font-size:11.5px;color:#9898b8;margin:0 0 12px;line-height:1.5;">Aria answers calls 24/7, books appointments (with conflict-checking), takes quote requests, and texts callers a follow-up.</p>' +
        numberBlock +
        '<div class="form-group" style="margin-bottom:10px;">' +
          '<label style="font-size:11px;">Greeting (first thing callers hear)</label>' +
          '<input id="ph-greeting" value="' + escH(s.firstMessage || '') + '" placeholder="Hi, you\\'ve reached [business], this is Aria. How can I help?">' +
        '</div>' +
        phoneScheduleBlock(s) +
        '<button class="btn-save" onclick="savePhoneSettings()">Save</button>' +
      '</div>' +
      '<h5 style="font-size:11px;color:#8888aa;text-transform:uppercase;letter-spacing:0.5px;margin:18px 0 8px;">Recent calls</h5>' +
      callRows;
  } catch (e) { el.innerHTML = '<div class="empty">Failed to load phone settings.</div>'; }
}

// Renders the "when should Aria answer?" controls. Mode selector + (when
// not 24/7) a per-day hours grid, timezone, and a fallback number that
// calls transfer to when Aria is off-schedule.
function phoneScheduleBlock(s) {
  const mode = s.answerMode || 'always';
  const hrs = s.businessHours || { mon:'9-17', tue:'9-17', wed:'9-17', thu:'9-17', fri:'9-17', sat:'closed', sun:'closed' };
  const tz = s.timezone || 'Europe/London';
  const days = [['mon','Mon'],['tue','Tue'],['wed','Wed'],['thu','Thu'],['fri','Fri'],['sat','Sat'],['sun','Sun']];
  const detailHidden = mode === 'always';
  const dayRows = days.map(function(d){
    return '<div style="display:flex;align-items:center;gap:8px;">' +
      '<span style="min-width:34px;font-size:11px;color:#aaa;text-transform:uppercase;font-weight:600;">' + d[1] + '</span>' +
      '<input id="ph-hrs-' + d[0] + '" value="' + escH(hrs[d[0]] || 'closed') + '" placeholder="closed" style="flex:1;font-size:12px;font-family:monospace;">' +
    '</div>';
  }).join('');
  return '<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:14px;margin-bottom:10px;">' +
    '<label style="font-size:11px;display:block;margin-bottom:6px;">When should Aria answer?</label>' +
    '<select id="ph-mode" onchange="togglePhoneSchedule()" style="width:100%;font-size:13px;margin-bottom:10px;">' +
      '<option value="always" ' + (mode==='always'?'selected':'') + '>Always — 24/7</option>' +
      '<option value="out_of_hours" ' + (mode==='out_of_hours'?'selected':'') + '>Out of hours only (after you close)</option>' +
      '<option value="business_hours" ' + (mode==='business_hours'?'selected':'') + '>Business hours only (overflow while you\\'re busy)</option>' +
    '</select>' +
    '<div id="ph-schedule-detail" style="display:' + (detailHidden?'none':'block') + ';">' +
      '<p style="font-size:10.5px;color:#8888aa;margin:0 0 8px;line-height:1.5;">Set your opening hours below. Format: <b>9-17</b> or <b>9:30-17:30</b> · <b>closed</b> · <b>24h</b>.</p>' +
      '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;">' + dayRows + '</div>' +
      '<div class="form-group" style="margin-bottom:10px;">' +
        '<label style="font-size:11px;">Timezone</label>' +
        '<input id="ph-tz" value="' + escH(tz) + '" placeholder="Europe/London" style="font-family:monospace;font-size:12.5px;">' +
      '</div>' +
      '<div class="form-group" style="margin-bottom:0;">' +
        '<label style="font-size:11px;">Transfer calls to (when Aria isn\\'t answering)</label>' +
        '<input id="ph-fallback" value="' + escH(s.fallbackNumber || '') + '" placeholder="+44 7700 900123 — your mobile / shop line" style="font-family:monospace;font-size:12.5px;">' +
        '<p style="font-size:10.5px;color:#6b6b8a;margin-top:4px;line-height:1.5;">When Aria is off-schedule, callers ring through to this number. Leave blank to just let them try again later.</p>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function togglePhoneSchedule() {
  const mode = document.getElementById('ph-mode').value;
  const detail = document.getElementById('ph-schedule-detail');
  if (detail) detail.style.display = (mode === 'always') ? 'none' : 'block';
}

async function provisionPhoneNumber(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Getting your number…'; }
  try {
    const r = await apiPost('/api/dashboard/phone/provision', {});
    if (r.ok) { toast('✓ Your Aria number: ' + r.number); loadPhoneSettings(); }
    else { toast(r.error || 'Could not get a number'); if (btn) { btn.disabled = false; btn.textContent = 'Get my number →'; } }
  } catch (e) { toast('Provisioning failed'); if (btn) { btn.disabled = false; btn.textContent = 'Get my number →'; } }
}

async function connectOwnNumber() {
  const el = document.getElementById('ph-own-number');
  const num = (el && el.value || '').trim();
  if (!num) { toast('Enter your number first'); return; }
  if (!/^[+0-9 ()-]{7,}$/.test(num)) { toast('That doesn\\'t look like a phone number'); return; }
  try {
    const r = await apiPost('/api/dashboard/phone/settings', { phoneNumber: num, enabled: true });
    if (r.ok) { toast('✓ Number connected — see the setup note to route calls to Aria'); loadPhoneSettings(); }
    else toast(r.error || 'Could not connect number');
  } catch (e) { toast('Connect failed'); }
}

async function releasePhoneNumber() {
  if (!confirm('Release this number? Aria will stop answering calls to it and the number is gone for good.')) return;
  try {
    const r = await apiPost('/api/dashboard/phone/release', {});
    if (r.ok) { toast('Number released'); loadPhoneSettings(); }
    else toast(r.error || 'Release failed');
  } catch (e) { toast('Release failed'); }
}

async function savePhoneSettings() {
  // ph-number only exists in the BYO-paste state; provisioned numbers have
  // no input field, so guard the read.
  const numEl = document.getElementById('ph-number');
  const body = {
    enabled: document.getElementById('ph-enabled').checked,
    firstMessage: document.getElementById('ph-greeting').value.trim(),
  };
  if (numEl) body.phoneNumber = numEl.value.trim();
  // Schedule fields (present whenever the panel is unlocked)
  const modeEl = document.getElementById('ph-mode');
  if (modeEl) {
    body.answerMode = modeEl.value;
    const tzEl = document.getElementById('ph-tz');
    const fbEl = document.getElementById('ph-fallback');
    if (tzEl) body.timezone = tzEl.value.trim();
    if (fbEl) body.fallbackNumber = fbEl.value.trim();
    const bh = {};
    ['mon','tue','wed','thu','fri','sat','sun'].forEach(function(dk){
      const inp = document.getElementById('ph-hrs-' + dk);
      if (inp) bh[dk] = inp.value.trim() || 'closed';
    });
    if (Object.keys(bh).length) body.businessHours = bh;
  }
  try {
    const r = await apiPost('/api/dashboard/phone/settings', body);
    if (r.ok) { toast(body.enabled ? '✓ Voice answering live' : '✓ Saved'); loadPhoneSettings(); }
    else toast(r.error || 'Save failed');
  } catch (e) { toast('Save failed'); }
}

// ─── Webhooks panel ─────────────────────────────────────────────────────
async function loadWebhooks() {
  const el = document.getElementById('webhooks-panel');
  if (!el) return;
  try {
    const d = await api('/api/dashboard/webhooks');
    const hooks = d.webhooks || [];
    const recent = (d.recentDeliveries || []).slice(0, 8);

    const EVENT_LABELS = {
      new_lead: 'New lead', hot_lead: 'Hot lead', new_booking: 'Booking',
      handoff: 'Handoff', angry_message: 'Angry', csat_negative: '👎 CSAT',
      conversation_started: 'Conv started', test: 'Test',
    };
    const hookCards = hooks.map((wh, i) => {
      const events = (wh.events || []).map(e => '<span style="background:rgba(157,150,255,0.1);color:#9d96ff;padding:2px 8px;border-radius:10px;font-size:10.5px;">' + (EVENT_LABELS[e] || e) + '</span>').join(' ');
      return '<div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:12px 14px;margin-bottom:8px;">' +
        '<div style="display:flex;align-items:start;gap:12px;">' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:13px;color:#fff;font-weight:600;">' + escH(wh.label || 'Webhook') + ' ' + (wh.enabled ? '<span style="color:#00e5a0;font-size:10px;">●ON</span>' : '<span style="color:#6b6b8a;font-size:10px;">●OFF</span>') + '</div>' +
            '<div style="font-size:11px;color:#8888aa;margin-top:2px;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escH(wh.url) + '</div>' +
            (events ? '<div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap;">' + events + '</div>' : '') +
            (wh.secretHint ? '<div style="font-size:10.5px;color:#6b6b8a;margin-top:6px;font-family:monospace;">Secret: ' + wh.secretHint + '</div>' : '') +
          '</div>' +
          '<div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">' +
            '<button onclick="testWebhook(' + i + ')" style="background:rgba(0,229,160,0.1);color:#00e5a0;border:1px solid rgba(0,229,160,0.3);border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;font-family:inherit;">Test</button>' +
            '<button onclick="deleteWebhook(' + i + ')" style="background:rgba(255,80,80,0.1);color:#ff6b6b;border:1px solid rgba(255,80,80,0.2);border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;font-family:inherit;">Remove</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    const recentRows = recent.length ? recent.map(r => {
      const okColour = r.ok ? '#00e5a0' : '#ff6b6b';
      return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:11.5px;">' +
        '<span style="color:' + okColour + ';font-weight:600;min-width:36px;">' + (r.status || (r.ok ? 'OK' : 'ERR')) + '</span>' +
        '<span style="color:#aaa;min-width:90px;">' + escH(r.event) + '</span>' +
        '<span style="color:#8888aa;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;font-size:10.5px;">' + escH(r.url.replace(/^https?:\\/\\//, '')) + '</span>' +
        '<span style="color:#6b6b8a;font-size:10.5px;">' + timeAgo(r.ts) + '</span>' +
      '</div>';
    }).join('') : '<div class="empty" style="padding:10px 0;font-size:11.5px;">No deliveries yet — events fire when leads, bookings, handoffs, or angry messages happen.</div>';

    el.innerHTML =
      (hookCards || '<div class="empty" style="padding:10px 0;font-size:12px;">No webhooks yet. Add one to pipe Aria events to Zapier, Slack, or your CRM.</div>') +
      '<div style="background:rgba(157,150,255,0.05);border:1px solid rgba(157,150,255,0.2);border-radius:10px;padding:12px;margin-top:10px;">' +
        '<div class="form-group" style="margin-bottom:8px;"><label>Label</label><input id="wh-label" placeholder="My Zapier webhook"></div>' +
        '<div class="form-group" style="margin-bottom:8px;"><label>URL</label><input id="wh-url" placeholder="https://hooks.zapier.com/hooks/catch/..."></div>' +
        '<div class="form-group" style="margin-bottom:10px;"><label>Fire on which events?</label>' +
          '<div id="wh-events" style="display:flex;flex-wrap:wrap;gap:6px;">' +
            ['new_lead','hot_lead','new_booking','handoff','angry_message','csat_negative'].map(e =>
              '<label style="display:inline-flex;align-items:center;gap:5px;background:rgba(255,255,255,0.04);padding:5px 10px;border-radius:14px;font-size:11.5px;color:#ccc;cursor:pointer;"><input type="checkbox" value="' + e + '" ' + (['new_lead','new_booking','handoff'].includes(e) ? 'checked' : '') + ' style="margin:0;">' + (EVENT_LABELS[e] || e) + '</label>'
            ).join('') +
          '</div>' +
        '</div>' +
        '<button class="btn-save" onclick="addWebhook()">+ Add webhook</button>' +
      '</div>' +
      '<h5 style="font-size:11px;color:#8888aa;text-transform:uppercase;letter-spacing:0.5px;margin:18px 0 8px;">Recent deliveries</h5>' +
      recentRows;
  } catch (e) { el.innerHTML = '<div class="empty">Failed to load webhooks.</div>'; }
}

async function addWebhook() {
  const label = document.getElementById('wh-label').value.trim();
  const url = document.getElementById('wh-url').value.trim();
  const events = Array.from(document.querySelectorAll('#wh-events input:checked')).map(c => c.value);
  if (!url) { toast('URL required'); return; }
  try {
    const r = await apiPost('/api/dashboard/webhooks', { label, url, events });
    if (r.ok) {
      toast('Webhook added — secret: ' + r.secret.slice(0, 12) + '…');
      loadWebhooks();
    } else { toast(r.error || 'Failed'); }
  } catch (e) { toast('Add failed'); }
}

async function deleteWebhook(idx) {
  if (!confirm('Remove this webhook? Events will stop firing to it immediately.')) return;
  try {
    const r = await fetch('/api/dashboard/webhooks/' + idx + '?' + Q, { method: 'DELETE' });
    const d = await r.json();
    if (d.ok) { toast('Removed'); loadWebhooks(); }
  } catch (e) { toast('Remove failed'); }
}

async function testWebhook(idx) {
  toast('Firing test event…');
  try {
    const r = await apiPost('/api/dashboard/webhooks/' + idx + '/test', {});
    if (r.ok) toast('✓ Test sent, status ' + r.status);
    else toast('✗ ' + (r.reason || r.error || ('status ' + r.status)));
    setTimeout(loadWebhooks, 500);
  } catch (e) { toast('Test failed'); }
}

// ─── Notification digest settings panel ─────────────────────────────────
async function loadDigestSettings() {
  const el = document.getElementById('digest-panel');
  if (!el) return;
  try {
    const d = await api('/api/dashboard/notifications/settings');
    const s = d.settings || {};
    const queued = d.queuedToday || 0;
    const lastSent = d.lastDigestSent ? ' · last sent ' + d.lastDigestSent : '';

    el.innerHTML =
      '<div style="background:rgba(157,150,255,0.04);border:1px solid rgba(157,150,255,0.2);border-radius:10px;padding:14px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
          '<div style="font-size:12px;color:#fff;font-weight:600;">Batch informational alerts <span style="color:#8888aa;font-weight:400;font-size:11px;">· ' + queued + ' queued today' + lastSent + '</span></div>' +
          '<label class="toggle"><input type="checkbox" id="nd-enabled" ' + (s.enabled ? 'checked' : '') + '><span class="slider"></span></label>' +
        '</div>' +
        '<p style="font-size:11.5px;color:#9898b8;margin:0 0 12px;line-height:1.5;">When on, low-urgency events (new leads, bookings, review requests, conflict deflections) batch into one daily email. Urgent stuff (handoffs, angry messages, no-show predictions, quote approvals) still fire immediately.</p>' +
        '<div style="display:flex;gap:10px;align-items:flex-end;">' +
          '<div class="form-group" style="flex:0 0 120px;margin-bottom:0;">' +
            '<label style="font-size:11px;">Send time</label>' +
            '<input id="nd-sendTime" type="time" value="' + escH(s.sendTime || '17:00') + '" style="font-family:inherit;font-size:13px;">' +
          '</div>' +
          '<div class="form-group" style="flex:1;margin-bottom:0;">' +
            '<label style="font-size:11px;">Timezone</label>' +
            '<input id="nd-timezone" value="' + escH(s.timezone || 'Europe/London') + '" placeholder="Europe/London" style="font-family:monospace;font-size:12px;">' +
          '</div>' +
          '<button class="btn-save" onclick="saveDigestSettings()" style="flex:0 0 80px;">Save</button>' +
        '</div>' +
      '</div>';
  } catch (e) { el.innerHTML = '<div class="empty">Failed to load digest settings.</div>'; }
}

async function saveDigestSettings() {
  const body = {
    enabled:  document.getElementById('nd-enabled').checked,
    sendTime: document.getElementById('nd-sendTime').value || '17:00',
    timezone: document.getElementById('nd-timezone').value.trim() || 'Europe/London',
  };
  try {
    const r = await apiPost('/api/dashboard/notifications/settings', body);
    if (r.ok) {
      toast(body.enabled ? '✓ Digest mode on — informational alerts batch into ' + body.sendTime + ' email' : '✓ Digest off — all alerts fire immediately');
      loadDigestSettings();
    } else { toast(r.error || 'Failed'); }
  } catch (e) { toast('Save failed'); }
}

// ─── Review-request settings panel ──────────────────────────────────────
async function loadReviewSettings() {
  const el = document.getElementById('reviews-panel');
  if (!el) return;
  try {
    const d = await api('/api/dashboard/reviews/settings');
    const s = d.settings || {};
    const recent = (d.recent || []).slice(0, 6);
    const defaultTmpl = d.defaultTemplate || '';

    const statusBadge = s.enabled && s.url
      ? '<span style="color:#00e5a0;font-size:11px;">● Active</span>'
      : (s.url ? '<span style="color:#fbbf24;font-size:11px;">● Disabled</span>' : '<span style="color:#6b6b8a;font-size:11px;">● Not configured</span>');

    const recentRows = recent.length ? recent.map(r => {
      const colour = r.status === 'sent' ? '#00e5a0' : '#8888aa';
      const lbl = r.status === 'sent' ? 'sent' : (r.status === 'skipped-no-url' ? 'skipped (no URL)' : 'skipped');
      return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:11.5px;">' +
        '<span style="color:' + colour + ';font-weight:600;min-width:46px;">' + lbl + '</span>' +
        '<span style="color:#aaa;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escH(r.senderName || r.senderId || '?') + ' on ' + escH(r.channel || '?') + '</span>' +
        '<span style="color:#6b6b8a;font-size:10.5px;">' + timeAgo(r.ts) + '</span>' +
      '</div>';
    }).join('') : '<div class="empty" style="padding:10px 0;font-size:11.5px;">No review requests sent yet — they fire 24h after each confirmed booking once you set a URL below.</div>';

    el.innerHTML =
      '<div style="background:rgba(0,229,160,0.05);border:1px solid rgba(0,229,160,0.2);border-radius:10px;padding:14px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
          '<div style="font-size:12px;color:#fff;font-weight:600;">Auto-ask for reviews ' + statusBadge + '</div>' +
          '<label class="toggle"><input type="checkbox" id="rv-enabled" ' + (s.enabled ? 'checked' : '') + '><span class="slider"></span></label>' +
        '</div>' +
        '<div class="form-group" style="margin-bottom:10px;">' +
          '<label style="font-size:11px;">Your Google review link <span style="color:#9898b8;font-weight:400;">(g.page/r/... or any review URL)</span></label>' +
          '<input id="rv-url" placeholder="https://g.page/r/your-place-id/review" value="' + escH(s.url || '') + '" style="font-family:monospace;font-size:12px;">' +
          '<div style="font-size:10.5px;color:#8888aa;margin-top:4px;">Find yours at <a href="https://whitespark.ca/google-review-link-generator/" target="_blank" style="color:#00e5a0;">whitespark.ca/google-review-link-generator</a></div>' +
        '</div>' +
        '<div style="display:flex;gap:10px;margin-bottom:10px;">' +
          '<div class="form-group" style="flex:1;margin-bottom:0;">' +
            '<label style="font-size:11px;">Send how long after booking?</label>' +
            '<select id="rv-delay" style="width:100%;">' +
              [2,6,12,24,48,72,168].map(h => '<option value="' + h + '" ' + (s.delayHours === h ? 'selected' : '') + '>' + (h < 24 ? h + ' hour' + (h > 1 ? 's' : '') : (h / 24) + ' day' + (h / 24 > 1 ? 's' : '')) + '</option>').join('') +
            '</select>' +
          '</div>' +
          '<div class="form-group" style="flex:1;margin-bottom:0;display:flex;flex-direction:column;justify-content:flex-end;">' +
            '<label style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:#ccc;cursor:pointer;background:rgba(255,255,255,0.04);padding:8px 12px;border-radius:8px;"><input type="checkbox" id="rv-alwaysEmail" ' + (s.alwaysEmail ? 'checked' : '') + ' style="margin:0;">Also email (not just channel)</label>' +
          '</div>' +
        '</div>' +
        '<div class="form-group" style="margin-bottom:10px;">' +
          '<label style="font-size:11px;">Message template <span style="color:#9898b8;font-weight:400;">— placeholders: {customer} {business} {service} {url}</span></label>' +
          '<textarea id="rv-template" rows="3" style="font-family:inherit;font-size:12.5px;width:100%;background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#fff;padding:8px 10px;resize:vertical;" placeholder="' + escH(defaultTmpl) + '">' + escH(s.template || '') + '</textarea>' +
          '<div style="font-size:10.5px;color:#8888aa;margin-top:4px;">Leave blank to use the default template shown above.</div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;">' +
          '<button class="btn-save" onclick="saveReviewSettings()" style="flex:1;">Save</button>' +
          '<button onclick="previewReview()" style="background:rgba(157,150,255,0.1);color:#9d96ff;border:1px solid rgba(157,150,255,0.3);border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;font-family:inherit;">Preview</button>' +
        '</div>' +
        '<div id="rv-preview" style="margin-top:10px;font-size:12.5px;color:#ccc;background:rgba(0,0,0,0.2);border-left:3px solid #9d96ff;padding:10px 12px;border-radius:6px;display:none;"></div>' +
      '</div>' +
      '<h5 style="font-size:11px;color:#8888aa;text-transform:uppercase;letter-spacing:0.5px;margin:18px 0 8px;">Recent review requests</h5>' +
      recentRows;
  } catch (e) { el.innerHTML = '<div class="empty">Failed to load review settings.</div>'; }
}

async function saveReviewSettings() {
  const body = {
    enabled:    document.getElementById('rv-enabled').checked,
    url:        document.getElementById('rv-url').value.trim(),
    delayHours: Number(document.getElementById('rv-delay').value) || 24,
    template:   document.getElementById('rv-template').value.trim(),
    alwaysEmail: document.getElementById('rv-alwaysEmail').checked,
  };
  try {
    const r = await apiPost('/api/dashboard/reviews/settings', body);
    if (r.ok) {
      toast(body.enabled && body.url ? '✓ Review requests active' : '✓ Saved');
      loadReviewSettings();
    } else { toast(r.error || 'Failed to save'); }
  } catch (e) { toast('Save failed'); }
}

async function previewReview() {
  try {
    const r = await apiPost('/api/dashboard/reviews/test', { customer: 'Sarah', service: 'haircut' });
    const el = document.getElementById('rv-preview');
    if (el) {
      el.style.display = 'block';
      el.innerHTML = '<div style="color:#9d96ff;font-size:10.5px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Preview — what Sarah would receive:</div>' + escH(r.preview || '(no preview)');
    }
  } catch (e) { toast('Preview failed'); }
}

async function saveOutbound(key, value) {
  try {
    // Send a partial profile update containing nested outbound flag
    const profileResp = await api('/api/dashboard/profile');
    const outbound = profileResp?.profile?.outbound || {};
    outbound[key] = value;
    const r = await apiPost('/api/dashboard/profile', { owner: OWNER, outbound });
    if (r.ok) toast(value ? 'On — Aria will send these' : 'Off');
  } catch (e) { toast('Failed to update'); }
}

async function saveSetting(key, value) {
  try {
    const body = { owner: OWNER };
    body[key] = value;
    const r = await apiPost('/api/dashboard/settings', body);
    if (r.ok) toast('Setting updated!');
    else toast('Failed to update');
  } catch (e) { toast('Error updating setting'); }
}

async function loadChannels() {
  try {
    const d = await api('/api/dashboard/channel-stats');
    const channels = d.channels || {};
    const stats = d.stats || {};
    const container = document.getElementById('channel-cards');
    if (!container) return;

    const channelDefs = [
      { key: 'whatsapp', name: 'WhatsApp Business', icon: '\u{1F4AC}', color: '#25D366', detail: c => c.displayPhone || 'Connected' },
      { key: 'instagram', name: 'Instagram DMs', icon: '\u{1F4F7}', color: '#E1306C', detail: c => c.igUsername || 'Connected' },
      { key: 'facebook', name: 'Facebook Messenger', icon: '\u{1F4AC}', color: '#1877F2', detail: c => c.pageName || 'Connected' },
    ];

    let html = '';
    let anyConnected = false;
    for (const def of channelDefs) {
      const ch = channels[def.key];
      const st = stats[def.key] || { replied: 0 };
      if (ch && ch.accessToken) {
        anyConnected = true;
        // Connection is solid (we have a token). The toggle below controls
        // whether Aria actively REPLIES \u2014 that's separate from "connected".
        const replyColor = ch.enabled ? '#00e5a0' : '#ffa726';
        const replyText = ch.enabled ? 'Aria is replying' : 'Replies paused';
        html += '<div style="background:#161630;border:1px solid rgba(0,229,160,0.25);border-radius:12px;padding:16px;display:flex;align-items:center;justify-content:space-between;">' +
          '<div style="display:flex;align-items:center;gap:12px;">' +
            '<span style="font-size:24px;">' + def.icon + '</span>' +
            '<div><div style="font-weight:600;font-size:14px;">' + def.name + ' <span style="color:#00e5a0;font-size:12px;font-weight:700;">\u2713 Connected</span></div>' +
            '<div style="font-size:12px;color:' + replyColor + ';">' + escH(def.detail(ch)) + ' \u00B7 ' + replyText + '</div>' +
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

    // When a channel IS connected, HIDE its big "Connect" button — leaving it
    // visible (even relabeled "Reconnect") makes users think the connection
    // is broken and they must act. Connected state is shown clearly by the
    // ✓ Connected card above. A connected channel only needs the small
    // Disconnect control on its card, not a giant blue Connect button.
    const hideIfConnected = (btnId, isConnected) => {
      const btn = document.getElementById(btnId);
      if (btn) btn.style.display = isConnected ? 'none' : '';
    };
    hideIfConnected('meta-connect-btn', !!channels.facebook?.accessToken);
    hideIfConnected('ig-connect-btn',   !!channels.instagram?.accessToken);
    hideIfConnected('gmail-connect-btn', !!d.gmailConnected);

    // Gmail has no card in #channel-cards (it's not a social channel), so when
    // connected give it its own clear ✓ Connected confirmation row.
    const gmailRow = document.getElementById('gmail-status-row');
    if (gmailRow) {
      gmailRow.innerHTML = d.gmailConnected
        ? '<div style="background:#161630;border:1px solid rgba(0,229,160,0.25);border-radius:12px;padding:16px;display:flex;align-items:center;gap:12px;">' +
            '<span style="font-size:24px;">📧</span>' +
            '<div><div style="font-weight:600;font-size:14px;">Gmail <span style="color:#00e5a0;font-size:12px;font-weight:700;">✓ Connected</span></div>' +
            '<div style="font-size:12px;color:#00e5a0;">Inbox + auto-reply active</div></div>' +
          '</div>'
        : '';
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

let msgChannel = 'all';
async function loadMessages(page, channel) {
  if (channel) msgChannel = channel;
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
    const icons = { whatsapp: '\u{1F4AC}', instagram: '\u{1F4F7}', facebook: '\u{1F4AC}' };
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
</script>
</body></html>`);
});

// ─── Meta OAuth (Facebook Login for Business) ────────────────────────────────
// Flow: /connect/meta?owner=&s= → FB OAuth dialog → /auth/meta/callback
// On success: enumerates Pages + linked IG accounts, subscribes each Page to
// the app's webhooks, stores tokens in channelConfigs[owner] with enabled:false.
// Owner must explicitly toggle each channel on from the dashboard before any
// reply is generated (handleIncomingChannelMessage gates on `enabled`).
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const META_OAUTH_STATES = new Map(); // stateToken → { owner, sessionToken, expiresAt }
const META_OAUTH_TTL_MS = 10 * 60 * 1000;
// Facebook Login for Business uses a saved "Configuration" in the Meta
// dashboard to bundle permissions/assets — we pass config_id= instead of
// scope=. Configuration "Aria Pages IG WhatsApp" was created 2026-05-23 and
// includes: pages_show_list, pages_messaging, pages_manage_metadata,
// business_management, instagram_business_basic, instagram_business_manage_messages.
const META_LOGIN_CONFIG_ID = process.env.META_LOGIN_CONFIG_ID || '1753616562794235';

function metaPublicBase(req) {
  if (req) return `${req.protocol}://${req.get('host')}`;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, '');
  return `http://localhost:${process.env.PORT || 3000}`;
}

function pruneMetaStates() {
  const now = Date.now();
  for (const [k, v] of META_OAUTH_STATES) if (v.expiresAt < now) META_OAUTH_STATES.delete(k);
}

// Admin-only: mint a dashboard session for any email and kick off /connect/meta.
// Used by Kyle to connect Meta channels on behalf of any owner without
// requiring the owner to have a password set up first.
app.get('/admin/connect/meta-as', (req, res) => {
  if (!adminAuth(req)) return res.status(403).send('<h2>Admin auth required</h2><p><a href="/admin">Sign in</a></p>');
  const owner = (req.query.owner || '').toString().toLowerCase().trim();
  if (!owner || !owner.includes('@')) return res.status(400).send('<h2>Missing ?owner=email</h2>');
  const token = createSession(owner);
  res.redirect(`/connect/meta?owner=${encodeURIComponent(owner)}&s=${encodeURIComponent(token)}`);
});

// Pending-choices map for the multi-Page picker step. Keyed by a fresh
// state token (so the original META_OAUTH_STATES is consumed once, can't
// be reused). 15-minute TTL — owner needs to pick before then or restart.
const META_PENDING_CHOICES = new Map();
const META_PENDING_TTL_MS = 15 * 60 * 1000;
function prunePendingChoices() {
  const now = Date.now();
  for (const [k, v] of META_PENDING_CHOICES) if (v.expiresAt < now) META_PENDING_CHOICES.delete(k);
}

app.get('/connect/meta', (req, res) => {
  const owner = (req.query.owner || '').toString();
  const sessionToken = (req.query.s || '').toString();
  if (!owner || !sessionToken || !validateSession(sessionToken, owner)) {
    return res.status(401).send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#0d0d1f;color:#eee;min-height:100vh">
      <h2>Not signed in</h2>
      <p>Sign in to your dashboard first, then come back to <code>/connect/meta</code>.</p>
      <p><a href="/connect/gmail?owner=${encodeURIComponent(owner)}" style="color:#00e5a0">Go to login →</a></p>
    </body></html>`);
  }
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) {
    return res.status(500).send('<h2>Meta credentials not configured</h2>');
  }

  pruneMetaStates();
  const state = crypto.randomBytes(24).toString('hex');
  META_OAUTH_STATES.set(state, { owner, sessionToken, expiresAt: Date.now() + META_OAUTH_TTL_MS });

  const redirect = `${metaPublicBase(req)}/auth/meta/callback`;
  const url = `https://www.facebook.com/v18.0/dialog/oauth`
    + `?client_id=${process.env.META_APP_ID}`
    + `&redirect_uri=${encodeURIComponent(redirect)}`
    + `&state=${state}`
    + `&config_id=${encodeURIComponent(META_LOGIN_CONFIG_ID)}`
    + `&response_type=code`;
  res.redirect(url);
});

app.get('/auth/meta/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) {
    return res.status(400).send(`<html><body style="font-family:sans-serif;padding:40px;background:#0d0d1f;color:#eee;min-height:100vh">
      <h2>Facebook returned an error</h2>
      <p><b>${escapeHtml(String(error))}</b>: ${escapeHtml(String(error_description || ''))}</p>
    </body></html>`);
  }
  pruneMetaStates();
  const st = state && META_OAUTH_STATES.get(String(state));
  if (!st) return res.status(400).send('<h2>State expired — start over from your dashboard.</h2>');
  META_OAUTH_STATES.delete(String(state));

  const { owner, sessionToken } = st;
  const redirect = `${metaPublicBase(req)}/auth/meta/callback`;

  try {
    // 1. Short-lived user token
    const tokenUrl = `https://graph.facebook.com/v18.0/oauth/access_token`
      + `?client_id=${process.env.META_APP_ID}`
      + `&client_secret=${process.env.META_APP_SECRET}`
      + `&redirect_uri=${encodeURIComponent(redirect)}`
      + `&code=${encodeURIComponent(String(code))}`;
    const tokRes = await fetch(tokenUrl);
    const tok = await tokRes.json();
    if (!tok.access_token) throw new Error('No access_token: ' + JSON.stringify(tok));

    // 2. Exchange for long-lived (60 days)
    const llUrl = `https://graph.facebook.com/v18.0/oauth/access_token`
      + `?grant_type=fb_exchange_token`
      + `&client_id=${process.env.META_APP_ID}`
      + `&client_secret=${process.env.META_APP_SECRET}`
      + `&fb_exchange_token=${tok.access_token}`;
    const llRes = await fetch(llUrl);
    const ll = await llRes.json();
    const userToken = ll.access_token || tok.access_token;

    // 3. Fetch pages + linked IG accounts
    const pagesRes = await fetch(`https://graph.facebook.com/v18.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${userToken}`);
    const pagesData = await pagesRes.json();
    const pages = pagesData.data || [];

    if (!pages.length) {
      return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Aria — No Business Page found</title></head>
        <body style="font-family:-apple-system,sans-serif;background:#0d0d1f;color:#eee;min-height:100vh;padding:40px;">
        <div style="max-width:560px;margin:0 auto;background:#161630;border:1px solid rgba(251,191,36,0.3);border-radius:16px;padding:32px;">
          <h2 style="color:#fbbf24;margin:0 0 12px;">⚠️ No Facebook Business Page found</h2>
          <p style="color:#ccc;line-height:1.7;font-size:14.5px;margin:0 0 14px;">Aria connects to your <b>Facebook Business Page</b> — not your personal profile. You don't currently have a Business Page on your Facebook account.</p>
          <p style="color:#9898b8;font-size:13.5px;line-height:1.7;margin:0 0 20px;"><b>To fix:</b><br>1. Open Facebook → menu → <b>Pages</b> → <b>Create new Page</b><br>2. Fill in your business name + category (takes ~2 mins)<br>3. Come back here and click Connect Facebook again</p>
          <p style="color:#6b6b8a;font-size:12px;margin:0 0 20px;">Your personal Facebook account is NOT connected. Aria only ever sees messages sent to your Business Page.</p>
          <a href="https://www.facebook.com/pages/creation/" target="_blank" style="display:inline-block;padding:12px 22px;background:#1877F2;color:#fff;border-radius:10px;text-decoration:none;font-weight:600;margin-right:8px;">Create a Page →</a>
          <a href="/dashboard?owner=${encodeURIComponent(owner)}&s=${encodeURIComponent(sessionToken)}" style="display:inline-block;padding:12px 22px;background:rgba(255,255,255,0.06);color:#ccc;border-radius:10px;text-decoration:none;font-size:13px;">Back to dashboard</a>
        </div></body></html>`);
    }

    // If multiple Pages — interrupt the flow with a Page picker so the
    // owner explicitly chooses which Business Page Aria should connect
    // to (instead of silently saving whichever Meta returned first).
    if (pages.length > 1) {
      prunePendingChoices();
      const pickerState = crypto.randomBytes(24).toString('hex');
      META_PENDING_CHOICES.set(pickerState, {
        owner, sessionToken, userToken, pages,
        expiresAt: Date.now() + META_PENDING_TTL_MS,
      });
      return res.redirect(`/connect/meta/pick-page?state=${pickerState}`);
    }

    // Single Page — proceed directly.
    const summary = await saveMetaSelections({ owner, page: pages[0], userToken });
    return res.send(renderMetaConnectedHtml({ owner, sessionToken, summary, pageName: pages[0].name }));

  } catch (e) {
    console.error('[meta-oauth] callback failed', e);
    res.status(500).send(`<html><body style="font-family:sans-serif;padding:40px;background:#0d0d1f;color:#eee;min-height:100vh">
      <h2>OAuth callback failed</h2>
      <pre style="background:#0a0a18;padding:16px;border-radius:8px;overflow:auto">${escapeHtml(e.message)}</pre>
    </body></html>`);
  }
});

// Helper: save ONE Page + linked IG + scan-for-WhatsApp. Returns summary
// for the success page render. Used by both single-page auto-save and the
// multi-page picker route.
async function saveMetaSelections({ owner, page, userToken }) {
  const existing = channelConfigs.get(owner) || {};
  const summary = [];

  // Subscribe the chosen Page to webhooks
  try {
    const subRes = await fetch(`https://graph.facebook.com/v18.0/${page.id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_deliveries,message_reads&access_token=${page.access_token}`, { method: 'POST' });
    const subData = await subRes.json();
    if (!subData.success) console.warn('[meta-oauth] page subscribe failed', page.id, subData);
  } catch (e) {
    console.warn('[meta-oauth] page subscribe error', page.id, e.message);
  }
  existing.facebook = {
    pageId: page.id,
    pageName: page.name,
    accessToken: page.access_token,
    enabled: existing.facebook?.enabled === true, // preserve prior toggle if reconnecting
    connectedAt: new Date().toISOString(),
  };
  summary.push({ type: 'page', id: page.id, name: page.name });

  // Linked IG Business account
  const ig = page.instagram_business_account;
  if (ig?.id) {
    existing.instagram = {
      igUserId: ig.id,
      igUsername: ig.username,
      pageId: page.id,
      accessToken: page.access_token,
      enabled: existing.instagram?.enabled === true,
      connectedAt: new Date().toISOString(),
    };
    summary.push({ type: 'instagram', id: ig.id, name: '@' + ig.username });
  }

  // WhatsApp Business scan (via owner's Business Portfolio). Only fires
  // when owner has Business Portfolio with WA set up.
  try {
    const wabaRes = await fetch(`https://graph.facebook.com/v18.0/me/businesses?fields=id,name,owned_whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number}}&access_token=${userToken}`);
    const wabaData = await wabaRes.json();
    for (const biz of (wabaData.data || [])) {
      for (const waba of (biz.owned_whatsapp_business_accounts?.data || [])) {
        const phone = (waba.phone_numbers?.data || [])[0];
        if (!phone) continue;
        existing.whatsapp = {
          phoneNumberId: phone.id,
          displayPhone: phone.display_phone_number,
          wabaId: waba.id,
          businessName: biz.name,
          accessToken: userToken,
          enabled: existing.whatsapp?.enabled === true,
          connectedAt: new Date().toISOString(),
        };
        summary.push({ type: 'whatsapp', id: phone.id, name: phone.display_phone_number });
        try {
          await fetch(`https://graph.facebook.com/v18.0/${waba.id}/subscribed_apps`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${userToken}` },
          });
        } catch (e) { console.warn('[meta-oauth] WABA subscribe error', waba.id, e.message); }
        break;
      }
      if (existing.whatsapp) break;
    }
  } catch (e) {
    console.warn('[meta-oauth] WA enumeration failed:', e.message);
  }

  channelConfigs.set(owner, existing);
  persistChannels();
  return summary;
}

// Helper: render the success page after a Page is connected. Now explicit
// about "we only connect your Business Page, not your personal account".
function renderMetaConnectedHtml({ owner, sessionToken, summary, pageName }) {
  const ICONS = { page: '📘 Messenger', instagram: '📷 Instagram', whatsapp: '💬 WhatsApp' };
  const rows = summary.map(s => `<li><b>${ICONS[s.type] || s.type}:</b> ${escapeHtml(s.name)} <span style="color:#6b6b8a">(${s.id})</span></li>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Aria — Connected</title></head>
  <body style="font-family:-apple-system,sans-serif;background:#0d0d1f;color:#eee;min-height:100vh;padding:40px;">
    <div style="max-width:560px;margin:0 auto;background:#161630;border:1px solid rgba(0,229,160,0.3);border-radius:16px;padding:32px;">
      <h2 style="margin:0 0 6px;color:#00e5a0;">✓ Connected to your Business Page</h2>
      <p style="color:#fff;font-size:16px;font-weight:600;margin:0 0 8px;">${escapeHtml(pageName)}</p>
      <p style="color:#9898b8;font-size:13.5px;margin:0 0 18px;line-height:1.6;">Aria can now reply to Messenger DMs sent to this Page. Replies stay off until you flip the toggle in your dashboard.</p>
      <ul style="line-height:1.9;font-size:14px;list-style:none;padding:0;background:rgba(0,229,160,0.05);border-radius:10px;padding:12px 16px;margin-bottom:18px;">${rows}</ul>
      <div style="background:rgba(255,255,255,0.04);border-left:3px solid #6b6b8a;padding:10px 14px;margin-bottom:18px;border-radius:6px;">
        <p style="color:#9898b8;font-size:12.5px;margin:0;line-height:1.6;">🔒 <b>Your personal Facebook is NOT connected.</b> Aria can only see messages sent to your Business Page. She cannot read your DMs, posts, friends, or anything on your personal profile.</p>
      </div>
      <a href="/dashboard?owner=${encodeURIComponent(owner)}&s=${encodeURIComponent(sessionToken)}" style="display:inline-block;padding:12px 22px;background:#00e5a0;color:#0d0d1f;border-radius:10px;text-decoration:none;font-weight:600;">Back to dashboard →</a>
    </div>
  </body></html>`;
}

// GET /connect/meta/pick-page — multi-Page picker.
// Two modes: render the picker form OR finalize on ?pick=PAGEID
app.get('/connect/meta/pick-page', async (req, res) => {
  prunePendingChoices();
  const state = String(req.query.state || '');
  const pickedPageId = String(req.query.pick || '');
  const stash = META_PENDING_CHOICES.get(state);
  if (!stash) return res.status(400).send('<h2>This Page-picker session expired. Please re-run /connect/meta from your dashboard.</h2>');

  // Finalize: owner picked a Page
  if (pickedPageId) {
    const chosen = stash.pages.find(p => p.id === pickedPageId);
    if (!chosen) return res.status(400).send('<h2>Invalid Page selection.</h2>');
    META_PENDING_CHOICES.delete(state);
    try {
      const summary = await saveMetaSelections({ owner: stash.owner, page: chosen, userToken: stash.userToken });
      return res.send(renderMetaConnectedHtml({ owner: stash.owner, sessionToken: stash.sessionToken, summary, pageName: chosen.name }));
    } catch (e) {
      console.error('[meta-oauth] picker save failed', e);
      return res.status(500).send(`<h2>Failed to save: ${escapeHtml(e.message)}</h2>`);
    }
  }

  // Render: picker form
  const cards = stash.pages.map(p => {
    const ig = p.instagram_business_account;
    return `<a href="/connect/meta/pick-page?state=${encodeURIComponent(state)}&pick=${encodeURIComponent(p.id)}" style="display:block;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:16px;margin-bottom:10px;text-decoration:none;color:#eee;transition:all 0.15s;" onmouseover="this.style.borderColor='rgba(0,229,160,0.4)';this.style.background='rgba(0,229,160,0.06)'" onmouseout="this.style.borderColor='rgba(255,255,255,0.1)';this.style.background='rgba(255,255,255,0.04)'">
      <div style="font-size:15px;font-weight:600;color:#fff;">📘 ${escapeHtml(p.name)}</div>
      <div style="font-size:12px;color:#8888aa;margin-top:4px;">Page ID: ${escapeHtml(p.id)}</div>
      ${ig?.username ? `<div style="font-size:12px;color:#E1306C;margin-top:4px;">📷 Linked Instagram: @${escapeHtml(ig.username)}</div>` : ''}
    </a>`;
  }).join('');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Aria — Pick your Business Page</title></head>
  <body style="font-family:-apple-system,sans-serif;background:#0d0d1f;color:#eee;min-height:100vh;padding:40px;">
    <div style="max-width:560px;margin:0 auto;background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:32px;">
      <h2 style="margin:0 0 8px;color:#00e5a0;">Which Page should Aria connect to?</h2>
      <p style="color:#9898b8;font-size:13.5px;margin:0 0 18px;line-height:1.6;">You admin ${stash.pages.length} Pages on your Facebook. Aria connects to <b>ONE</b> Business Page — pick the one for the business you want her to handle messages for.</p>
      <div style="margin-bottom:18px;">${cards}</div>
      <div style="background:rgba(255,255,255,0.04);border-left:3px solid #6b6b8a;padding:10px 14px;border-radius:6px;">
        <p style="color:#9898b8;font-size:12px;margin:0;line-height:1.6;">🔒 Only the Page you select will be connected. Your personal Facebook + other Pages stay completely separate from Aria.</p>
      </div>
    </div>
  </body></html>`);
});

// ─── Meta Webhook ────────────────────────────────────────────────────────────
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

// ─── Instagram Business Login (standalone, no FB Page required) ──────────────
// Meta launched IG-direct OAuth in late 2024. Endpoint is api.instagram.com,
// scopes use instagram_business_* prefix. App must have Instagram product
// added in Meta dashboard with OAuth redirect URI whitelisted.
const IG_OAUTH_STATES = new Map();
const IG_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments',
].join(',');

app.get('/connect/instagram', (req, res) => {
  const owner = (req.query.owner || '').toString();
  const sessionToken = (req.query.s || '').toString();
  if (!owner || !sessionToken || !validateSession(sessionToken, owner)) {
    return res.status(401).send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#0d0d1f;color:#eee;min-height:100vh">
      <h2>Not signed in</h2>
      <p><a href="/connect/gmail?owner=${encodeURIComponent(owner)}" style="color:#00e5a0">Go to login →</a></p>
    </body></html>`);
  }
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) {
    return res.status(500).send('<h2>Meta credentials not configured</h2>');
  }

  // Prune expired states
  const now = Date.now();
  for (const [k, v] of IG_OAUTH_STATES) if (v.expiresAt < now) IG_OAUTH_STATES.delete(k);

  const state = crypto.randomBytes(24).toString('hex');
  IG_OAUTH_STATES.set(state, { owner, sessionToken, expiresAt: Date.now() + META_OAUTH_TTL_MS });

  const redirect = `${metaPublicBase(req)}/auth/instagram/callback`;
  // Instagram OAuth uses www.instagram.com/oauth/authorize (not facebook.com).
  // enable_fb_login=0 forces the IG-only flow (no fallback to FB Login).
  // IG_APP_ID is a separate sub-app auto-created by Meta when you add the
  // Instagram product. Falls back to META_APP_ID for legacy setups.
  const url = `https://www.instagram.com/oauth/authorize`
    + `?client_id=${process.env.IG_APP_ID || process.env.META_APP_ID}`
    + `&redirect_uri=${encodeURIComponent(redirect)}`
    + `&state=${state}`
    + `&scope=${encodeURIComponent(IG_SCOPES)}`
    + `&response_type=code`
    + `&enable_fb_login=0`
    + `&force_authentication=1`;
  res.redirect(url);
});

app.get('/auth/instagram/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) {
    return res.status(400).send(`<html><body style="font-family:sans-serif;padding:40px;background:#0d0d1f;color:#eee;min-height:100vh">
      <h2>Instagram returned an error</h2>
      <p><b>${escapeHtml(String(error))}</b>: ${escapeHtml(String(error_description || ''))}</p>
    </body></html>`);
  }
  const st = state && IG_OAUTH_STATES.get(String(state));
  if (!st) return res.status(400).send('<h2>State expired — start over from your dashboard.</h2>');
  IG_OAUTH_STATES.delete(String(state));

  const { owner, sessionToken } = st;
  const redirect = `${metaPublicBase(req)}/auth/instagram/callback`;

  try {
    // 1. Exchange code → short-lived IG user access token (1 hour)
    // IG sub-app credentials when set, else fall back to parent FB app.
    const igClientId = process.env.IG_APP_ID || process.env.META_APP_ID;
    const igClientSecret = process.env.IG_APP_SECRET || process.env.META_APP_SECRET;
    const formBody = new URLSearchParams({
      client_id: igClientId,
      client_secret: igClientSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirect,
      code: String(code),
    });
    const tokRes = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody.toString(),
    });
    const tok = await tokRes.json();
    if (!tok.access_token) throw new Error('No access_token from IG: ' + JSON.stringify(tok));

    // 2. Exchange short-lived → long-lived IG token (60 days)
    const llUrl = `https://graph.instagram.com/access_token`
      + `?grant_type=ig_exchange_token`
      + `&client_secret=${encodeURIComponent(igClientSecret)}`
      + `&access_token=${encodeURIComponent(tok.access_token)}`;
    const llRes = await fetch(llUrl);
    const ll = await llRes.json();
    const igToken = ll.access_token || tok.access_token;

    // 3. Fetch IG user profile (username, id)
    const meRes = await fetch(`https://graph.instagram.com/v18.0/me?fields=id,username,user_id,account_type&access_token=${encodeURIComponent(igToken)}`);
    const me = await meRes.json();
    if (!me.id) throw new Error('No IG profile: ' + JSON.stringify(me));

    // 4. Save to channelConfigs.instagram (preserve enabled toggle if reconnecting)
    const existing = channelConfigs.get(owner) || {};
    existing.instagram = {
      igUserId: me.user_id || me.id,
      igUsername: me.username,
      accountType: me.account_type,
      accessToken: igToken,
      enabled: existing.instagram?.enabled === true,
      source: 'instagram-direct',
      connectedAt: new Date().toISOString(),
    };
    channelConfigs.set(owner, existing);
    persistChannels();

    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Aria — Instagram Connected</title></head>
    <body style="font-family:-apple-system,sans-serif;background:#0d0d1f;color:#eee;min-height:100vh;padding:40px;">
      <div style="max-width:560px;margin:0 auto;background:#161630;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:32px;">
        <h2 style="margin:0 0 8px;background:linear-gradient(45deg,#FED373,#F15245,#D92E7F,#9B36B7);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">✓ Instagram Connected</h2>
        <p style="color:#9898b8;font-size:14px;margin:0 0 20px;">Aria can now receive DMs sent to <b>@${escapeHtml(me.username || '')}</b>. Replies stay off until you flip the toggle in your dashboard.</p>
        <a href="/dashboard?owner=${encodeURIComponent(owner)}&s=${encodeURIComponent(sessionToken)}" style="display:inline-block;margin-top:8px;padding:12px 22px;background:linear-gradient(45deg,#F15245,#D92E7F);color:#fff;border-radius:10px;text-decoration:none;font-weight:600;">Back to dashboard →</a>
      </div>
    </body></html>`);
  } catch (e) {
    console.error('[ig-oauth] callback failed', e);
    res.status(500).send(`<html><body style="font-family:sans-serif;padding:40px;background:#0d0d1f;color:#eee;min-height:100vh">
      <h2>Instagram OAuth failed</h2>
      <pre style="background:#0a0a18;padding:16px;border-radius:8px;overflow:auto">${escapeHtml(e.message)}</pre>
    </body></html>`);
  }
});

app.post('/api/meta/webhook', (req, res) => {
  const rawBody = req.body;
  const sig = req.headers['x-hub-signature-256'];

  if (!verifyMetaSignature(rawBody, sig)) {
    console.warn('⚠️ Meta webhook: invalid signature');
    return res.status(401).send('Invalid signature');
  }

  res.status(200).send('EVENT_RECEIVED');

  let payload;
  try { payload = JSON.parse(rawBody.toString()); }
  catch { return; }

  setImmediate(() => processMetaWebhook(payload));
});

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

function getOwnerProfile(ownerEmail) {
  const arConfig = EMAIL_AUTO_REPLY_ENABLED.get(ownerEmail);
  // Pull dashboard profile (clientProfiles) so allowedTopics + servicesCarousel
  // saved via the Train Aria editors are visible to the channel pipeline.
  let dashProfile = null;
  for (const [key, val] of clientProfiles) {
    if (val?.profile?.email === ownerEmail || val?.email === ownerEmail || key === ownerEmail) {
      dashProfile = val?.profile || val;
      break;
    }
  }
  if (arConfig?.systemPrompt) {
    return {
      systemPrompt: arConfig.systemPrompt,
      config: arConfig.config,
      // Merge in dashboard-side fields so the channel handler sees them
      allowedTopics: dashProfile?.allowedTopics,
      servicesCarousel: dashProfile?.servicesCarousel,
      profile: dashProfile,
    };
  }
  if (dashProfile) return { profile: dashProfile, ...dashProfile };
  return null;
}

// ─── Plan tiers ──────────────────────────────────────────────────────────
// Two plans (no billing system yet — Kyle assigns manually when a client
// pays; Stripe later just sets the same field):
//   'lite'         — IG/FB DM replies + email auto-reply (the base product)
//   'receptionist' — everything in lite PLUS the voice phone receptionist
//
// Stored on profile.plan. Anything unset/unknown defaults to 'lite' so a
// brand-new account can't accidentally get the expensive feature for free.
const PLANS = { LITE: 'lite', RECEPTIONIST: 'receptionist' };
function getOwnerPlan(ownerEmail) {
  const p = getOwnerProfile(ownerEmail)?.profile?.plan;
  return p === PLANS.RECEPTIONIST ? PLANS.RECEPTIONIST : PLANS.LITE;
}
// Single source of truth for "can this owner use voice?" — gate every
// voice surface (dashboard, provisioning, webhook) through this.
function canUseVoice(ownerEmail) {
  return getOwnerPlan(ownerEmail) === PLANS.RECEPTIONIST;
}

// Decide whether Aria should ANSWER a call right now given the owner's
// voice schedule. Reuses evaluateSchedule() (the same engine the DM
// channel office-hours uses) so we don't keep two time-window codepaths.
//   answerMode:
//     'always'         → 24/7 (default)
//     'business_hours' → only DURING the configured open hours (overflow)
//     'out_of_hours'   → only OUTSIDE open hours (after staff go home)
// Returns true if Aria should pick up; false → caller transfers/declines.
function voiceShouldAnswer(cfg, now = new Date()) {
  const mode = cfg?.answerMode || 'always';
  if (mode === 'always') return true;
  const sched = {
    mode: 'business_hours',
    businessHours: cfg.businessHours || { mon: '9-17', tue: '9-17', wed: '9-17', thu: '9-17', fri: '9-17', sat: 'closed', sun: 'closed' },
    timezone: cfg.timezone || 'Europe/London',
  };
  const { inHours } = evaluateSchedule(sched, now);
  return mode === 'out_of_hours' ? !inHours : inHours;
}

async function processMetaWebhook(payload) {
  if (!payload.entry) return;

  for (const entry of payload.entry) {
    // WhatsApp messages
    if (entry.changes) {
      for (const change of entry.changes) {
        if (change.field === 'messages' && change.value?.messages) {
          for (const msg of change.value.messages) {
            // Accept text / image / audio inbound. Voice notes go through
            // Whisper to a transcript and then ride the normal text path.
            const isText  = msg.type === 'text';
            const isImage = msg.type === 'image';
            const isAudio = msg.type === 'audio';
            if (!isText && !isImage && !isAudio) continue;

            const phoneNumberId = change.value.metadata?.phone_number_id;
            const senderId      = msg.from;
            const senderName    = change.value.contacts?.[0]?.profile?.name || senderId;
            const messageId     = msg.id;
            const imageRefs     = extractImageRefs({ channel: 'whatsapp', msg });
            const audioRefs     = extractAudioRefs({ channel: 'whatsapp', msg });

            // Transcribe voice notes BEFORE entering the channel handler so the
            // transcript becomes messageText and every downstream feature
            // (RAG / slot fill / booking detection / sentiment) works as if
            // they typed it. Need the WA access token to fetch token-gated media.
            let messageText;
            let voiceMeta = null;
            if (isText) {
              messageText = msg.text?.body || '';
            } else if (isImage) {
              messageText = msg.image?.caption || '(sent a photo)';
            } else {
              messageText = '(sent a voice note)';
              if (audioRefs.length > 0) {
                try {
                  const wa = findOwnerByWhatsAppPhoneId(phoneNumberId);
                  const accessToken = wa?.config?.accessToken || process.env.WA_ACCESS_TOKEN;
                  const { transcript, provider, bytes } = await transcribeAudioRef(audioRefs[0], accessToken);
                  messageText = transcript;
                  voiceMeta = { provider, bytes, durationApprox: null };
                  console.log(`🎙️  [voice] transcribed ${bytes}B WA voice note via ${provider}: "${transcript.slice(0, 100)}"`);
                } catch (e) {
                  console.warn(`[voice] WA transcription failed: ${e.message}`);
                  // Fallback messageText stays "(sent a voice note)" — Aria will
                  // still answer something reasonable (e.g. "Got your voice
                  // note — could you also type a quick line so I can help?").
                }
              }
            }

            await handleIncomingChannelMessage({
              channel: 'whatsapp', recipientId: phoneNumberId,
              senderId, senderName, messageText, messageId, imageRefs, voiceMeta,
            });
          }
        }
      }
    }

    // Instagram & Facebook Messenger messages
    if (entry.messaging) {
      for (const event of entry.messaging) {
        // Allow text / image / audio. Anything else (file/video/sticker) skipped.
        const hasText     = !!event.message?.text;
        const hasImageAtt = (event.message?.attachments || []).some(a => a.type === 'image');
        const hasAudioAtt = (event.message?.attachments || []).some(a => a.type === 'audio');
        if (!hasText && !hasImageAtt && !hasAudioAtt) continue;

        const recipientId = event.recipient?.id;
        const senderId    = event.sender?.id;
        const messageId   = event.message.mid;

        const channel = findChannelByRecipientId(recipientId);
        if (!channel) continue;

        const imageRefs = extractImageRefs({ channel: channel.type, event });
        const audioRefs = extractAudioRefs({ channel: channel.type, event });

        // Transcribe FB/IG voice notes. CDN URLs are publicly fetchable
        // so no access token needed for the audio download itself.
        let messageText;
        let voiceMeta = null;
        if (hasText) {
          messageText = event.message.text;
        } else if (hasImageAtt) {
          messageText = '(sent a photo)';
        } else {
          messageText = '(sent a voice note)';
          if (audioRefs.length > 0) {
            try {
              const { transcript, provider, bytes } = await transcribeAudioRef(audioRefs[0], null);
              messageText = transcript;
              voiceMeta = { provider, bytes, durationApprox: null };
              console.log(`🎙️  [voice] transcribed ${bytes}B ${channel.type} voice note via ${provider}: "${transcript.slice(0, 100)}"`);
            } catch (e) {
              console.warn(`[voice] ${channel.type} transcription failed: ${e.message}`);
            }
          }
        }

        await handleIncomingChannelMessage({
          channel: channel.type, recipientId,
          senderId, senderName: senderId,
          messageText, messageId, imageRefs, voiceMeta,
        });
      }
    }
  }
}

// Resilient Claude call with retry + Sonnet fallback. Haiku is the workhorse;
// if it errors 3× we drop to Sonnet for this single call (rarely fires,
// roughly 10× the cost, only when haiku is misbehaving). Exponential backoff
// on retryable errors (529 overloaded, 5xx, network) but NOT on 4xx (bad
// request — retrying won't help).
async function callClaudeWithFallback(payload) {
  const models = ['claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929'];
  let lastErr;
  for (let i = 0; i < models.length; i++) {
    try {
      return await claude.messages.create({ ...payload, model: models[i] });
    } catch (e) {
      lastErr = e;
      const status = e?.status || e?.error?.status;
      const retryable = !status || status === 429 || status === 529 || status >= 500;
      if (!retryable) throw e;
      if (i < models.length - 1) {
        const wait = Math.min(500 * Math.pow(2, i), 4000);
        console.warn(`Claude call attempt ${i + 1} failed (${status || 'network'}): ${e.message}. Retrying in ${wait}ms with ${models[i + 1]}`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

async function generateChannelReply(systemPrompt, senderName, messageText, opts = {}) {
  const { allowedTopics, imageRefs = [], waAccessToken, ownerEmail, channel } = opts;
  const scopeRule = allowedTopics?.length
    ? `\n- SCOPE: this business only handles ${allowedTopics.join(', ')}. If the message is clearly OFF these topics (e.g. asking for legal/medical advice, asking about a different industry), set outOfScope=true and politely redirect in your text reply (say what you can help with, suggest they contact the relevant expert elsewhere). Common related questions still count as in-scope.`
    : '';

  // Resolve incoming images (if any) into Anthropic content blocks.
  // Silent fallback policy: if image load fails we keep going with text only
  // — see image_intake.js for rationale. Errors get logged for admin visibility.
  let imageBlocks = [];
  if (imageRefs.length > 0) {
    try {
      const { blocks, errors } = await resolveImageRefsToBlocks(imageRefs, waAccessToken);
      imageBlocks = blocks;
      if (errors.length) {
        console.warn(`[vision] ${errors.length}/${imageRefs.length} image(s) failed to load for ${ownerEmail || 'unknown'} on ${channel || '?'}: ${errors.map(e => e.error).join('; ')}`);
      }
      if (blocks.length) {
        console.log(`👁️  [vision] resolved ${blocks.length} image(s) for Claude on ${channel || '?'} for ${ownerEmail || 'unknown'}`);
      }
    } catch (e) {
      console.warn('[vision] image resolution threw:', e.message);
    }
  }

  const visionRule = imageBlocks.length > 0
    ? `\n- IMAGES: the customer attached ${imageBlocks.length} image(s) above. LOOK at them and incorporate what you see into your reply — describe relevant details (e.g. "I can see the leak under your sink", "that's a lovely Beagle"), then answer their question or guide them to next steps. Never say "I can't see images" — you can.`
    : '';

  // Build content array. When images are present we use the multimodal shape
  // (array of blocks); when not, we keep the original string form for zero-
  // overhead text-only path.
  const textBlock = `You received this message from ${senderName}:

"${messageText}"

Respond with valid JSON only:
{
  "text": "Your plain text reply here (no HTML)",
  "booking": null or { "name": "customer name", "datetime": "date/time mentioned", "notes": "what they need" },
  "contact": { "name": "customer name or null", "email": "email if shared, else null", "phone": "phone if shared, else null" },
  "sentiment": "positive" | "neutral" | "negative" | "angry",
  "urgency": "low" | "medium" | "high",
  "outOfScope": true | false,
  "needsHuman": true | false,
  "handoffReason": "short reason if needsHuman, else null",
  "suggestedReplies": ["Btn 1", "Btn 2", "Btn 3"] or [],
  "language": "en" | "es" | "fr" | "de" | "it" | "pt" | "nl" | "pl" | "ar" | "zh" | "ja" | "ko" | other ISO-639-1 code,
  "showServicesCarousel": true | false,
  "bookingReminderResponse": "confirmed" | "reschedule" | "cancel" | null,
  "quoteIntent": true | false,
  "quoteDraft": null or {
    "lineItems": [{ "label": "what it covers", "price": 120, "qty": 1, "notes": "optional context" }],
    "subtotal": 120,
    "currency": "£" or "$" or "€",
    "validityDays": 30,
    "caveat": "Subject to on-site assessment. Final price may vary based on access, materials, scope changes."
  }
}

Rules:
- Be friendly, helpful, and concise
- If asking for a quote or booking, confirm and ask for missing details
- If you can answer directly, do so
- Offer to arrange a call or visit when appropriate
- Sign off with the business name
- Plain text only, no HTML tags
- If a date/time/appointment is mentioned, extract into booking object. RESOLVE relative dates ("tomorrow", "next Tuesday at 2pm") into an ISO 8601 datetime in UTC if possible — e.g. "2026-05-28T14:00:00Z". If only a date is given (no time), default to 10:00 local. If ambiguous, set datetime to the user's original phrasing.
- If sender shared their email or phone anywhere in this message OR conversation history, extract into contact object — otherwise leave fields null
- sentiment: classify the sender's tone. "angry" = swearing, threats, all-caps frustration, repeated complaints. "negative" = frustrated but civil. "neutral" = transactional. "positive" = thankful/excited.
- urgency: "high" = explicit deadline today/asap/emergency/urgent/now/leaking/broken; "medium" = "this week"/"soon"/quote-soon; "low" = browsing, future planning, no time pressure
- needsHuman: true ONLY when the user explicitly asks for a human/manager OR you genuinely cannot help (refund disputes, complex billing, complaints about specific staff). Set handoffReason concisely. Don't escalate easy stuff.
- suggestedReplies: 2-3 SHORT (≤20 chars each) tappable button options that match likely next actions for this customer. Examples: ["Get a quote", "Book a call", "See examples"]. Leave [] if no obvious next step (e.g. complaint, off-topic, post-handoff). Never include "Talk to a human" if you've already set needsHuman=true.
- language: detect the customer's language (ISO-639-1 code: "en", "es", "fr", "de", etc.) and WRITE YOUR REPLY TEXT IN THE SAME LANGUAGE. If they switch mid-conversation, follow them. Default to English when unclear.
- showServicesCarousel: true ONLY when the customer asks "what do you do/offer", "what services", "show me your products", "what can I get from you" etc. Keep your text reply short ("Here's what we offer:") because a swipeable card carousel will be sent right after. false otherwise.
- bookingReminderResponse: ONLY set this if the conversation context mentions a recent booking reminder Aria sent (look for "REMINDER PENDING" note in the system prompt). Classify the customer's response: "confirmed" (yes / yep / sounds good / see you then / 👍), "reschedule" (need to move / different time / not that day / can we do another), "cancel" (need to cancel / can't make it / something came up). Set to null otherwise (no pending reminder, or this message isn't a response to one).
- quoteIntent: true when the customer is asking for a price/quote/cost/estimate ("how much for…", "what would it cost", "can I get a quote", "ballpark for…", "do you do estimates", "price on a 3-bed re-roof"). false otherwise.
- quoteDraft: when quoteIntent is true AND you have enough info in the system prompt's SERVICES/KB context to estimate, fill this. lineItems = breakdown (use 1-5 items, label them clearly like "Standard service call-out" / "Per square metre"). subtotal = sum of items. currency = pick from "£", "$", "€" based on business location (UK = £, US = $, EU = €; default £). validityDays = 30 unless the prompt says otherwise. caveat = honest hedging line ("Subject to on-site assessment", "Final price depends on access/materials/scope", "Indicative only — call/text to confirm"). If you DON'T have enough info to quote, set quoteDraft to null and ask 1-2 clarifying questions in your text reply instead (size, scope, location). If quoteDraft IS set, your text reply should be SHORT like: "Let me put a quick quote together for you — one moment, I'll get it over shortly 📋" — because the actual itemised quote will be sent after owner approval.${scopeRule}${visionRule}`;

    // Multimodal: image blocks come FIRST (Anthropic recommends image-before-text
    // ordering for best comprehension), text block last. Pure-text path keeps
    // the simpler string content shape.
    const userContent = imageBlocks.length > 0
      ? [...imageBlocks, { type: 'text', text: textBlock }]
      : textBlock;

  try {
    const r = await callClaudeWithFallback({
      max_tokens: 600,
      messages: [{ role: 'user', content: userContent }],
      system: systemPrompt,
    });
    const text = r.content[0]?.text || '';
    try {
      const parsed = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
      // Defensive defaults so downstream code never NPEs on missing fields.
      parsed.contact = parsed.contact || { name: null, email: null, phone: null };
      parsed.booking = parsed.booking || null;
      parsed.sentiment = parsed.sentiment || 'neutral';
      parsed.urgency = parsed.urgency || 'low';
      parsed.outOfScope = !!parsed.outOfScope;
      parsed.needsHuman = !!parsed.needsHuman;
      parsed.handoffReason = parsed.handoffReason || null;
      parsed.suggestedReplies = Array.isArray(parsed.suggestedReplies)
        ? parsed.suggestedReplies.filter(s => typeof s === 'string' && s.trim()).slice(0, 3)
        : [];
      parsed.language = typeof parsed.language === 'string' ? parsed.language.toLowerCase().slice(0, 5) : 'en';
      parsed.showServicesCarousel = !!parsed.showServicesCarousel;
      parsed.bookingReminderResponse = ['confirmed', 'reschedule', 'cancel'].includes(parsed.bookingReminderResponse)
        ? parsed.bookingReminderResponse
        : null;
      parsed.quoteIntent = !!parsed.quoteIntent;
      // Validate quoteDraft shape — bail to null if anything looks broken
      if (parsed.quoteDraft && Array.isArray(parsed.quoteDraft.lineItems) && parsed.quoteDraft.lineItems.length > 0) {
        parsed.quoteDraft.lineItems = parsed.quoteDraft.lineItems
          .filter(li => li && typeof li.label === 'string' && li.label.trim())
          .map(li => ({
            label: String(li.label).slice(0, 120),
            price: Number(li.price) || 0,
            qty:   Number(li.qty) > 0 ? Number(li.qty) : 1,
            notes: li.notes ? String(li.notes).slice(0, 200) : null,
          }))
          .slice(0, 8);
        parsed.quoteDraft.subtotal     = Number(parsed.quoteDraft.subtotal) || parsed.quoteDraft.lineItems.reduce((s, li) => s + li.price * li.qty, 0);
        parsed.quoteDraft.currency     = ['£','$','€'].includes(parsed.quoteDraft.currency) ? parsed.quoteDraft.currency : '£';
        parsed.quoteDraft.validityDays = Math.max(1, Math.min(365, Number(parsed.quoteDraft.validityDays) || 30));
        parsed.quoteDraft.caveat       = String(parsed.quoteDraft.caveat || '').slice(0, 300);
      } else {
        parsed.quoteDraft = null;
      }
      parsed._tokensUsed = (r.usage?.input_tokens || 0) + (r.usage?.output_tokens || 0);
      return parsed;
    } catch {
      return { text, booking: null, contact: { name: null, email: null, phone: null }, sentiment: 'neutral', urgency: 'low', outOfScope: false, needsHuman: false, handoffReason: null, suggestedReplies: [], language: 'en', showServicesCarousel: false, _tokensUsed: (r.usage?.input_tokens || 0) + (r.usage?.output_tokens || 0) };
    }
  } catch (e) {
    console.warn('Channel reply generation failed:', e.message);
    return null;
  }
}

// Compress old conversation entries into one summary line. Fires when raw
// history exceeds CONV_MAX_RAW so we keep memory bounded yet retain context
// across long conversations (institutional bots can recall conv from weeks
// ago — without this we'd just truncate and forget).
const CONV_MAX_RAW = 12;            // keep last N raw exchanges verbatim
const CONV_SUMMARIZE_TRIGGER = 18;  // when total >= this, compress to fit
async function summarizeOldHistory(oldEntries) {
  try {
    const r = await callClaudeWithFallback({
      max_tokens: 200,
      messages: [{ role: 'user', content: `Summarise this customer-service conversation snippet into ONE sentence (under 280 chars). Keep names, services discussed, prices mentioned, time-sensitive commitments. Drop pleasantries.

${oldEntries.map(h => `[${h.role === 'sender' ? 'THEM' : 'US'}] ${h.preview}`).join('\n')}

Reply with just the summary sentence, no preamble.` }],
    });
    return (r.content[0]?.text || '').trim().slice(0, 280);
  } catch (e) {
    console.warn('History summarise failed:', e.message);
    return null;
  }
}

// Ship a booking confirmation: ICS file by email to owner + customer
// (when email captured), confirmation message back on the channel, and
// the .ics goes into the file system so the dashboard can re-download it.
const BOOKING_ICS_DIR = resolve('data/booking_ics');
try { mkdirSync(BOOKING_ICS_DIR, { recursive: true }); } catch {}

async function confirmAndShipBooking(booking) {
  const {
    ownerEmail, channel, channelConfig, senderId, senderName,
    bookingData, // { name, contact (email or phone), service, datetime }
  } = booking;

  const profile = getOwnerProfile(ownerEmail);
  const businessName = profile?.profile?.businessName || profile?.businessName || 'Your business';
  const businessLocation = profile?.profile?.location || profile?.location || '';

  const parsedDate = parseBookingDateTime(bookingData.datetime);
  const customerEmail = bookingData.contact?.includes('@') ? bookingData.contact : null;

  let icsContent = null;
  let icsFilename = null;
  if (parsedDate) {
    try {
      const uid = `${ownerEmail}-${Date.now()}-${(senderId || 'anon').replace(/[^a-zA-Z0-9]/g, '')}`;
      icsContent = buildIcsEvent({
        uid,
        start: parsedDate,
        summary: `${businessName} — ${bookingData.service || 'Booking'} (${bookingData.name || senderName || 'customer'})`,
        description: [
          `Customer: ${bookingData.name || senderName || 'Unknown'}`,
          bookingData.contact ? `Contact: ${bookingData.contact}` : '',
          bookingData.service ? `Service: ${bookingData.service}` : '',
          bookingData.notes ? `\nNotes: ${bookingData.notes}` : '',
          `\nBooked via Aria on ${channel}`,
        ].filter(Boolean).join('\n'),
        location: businessLocation,
        organizerEmail: ownerEmail,
        organizerName: businessName,
        attendeeEmail: customerEmail,
        attendeeName: bookingData.name || senderName,
      });
      icsFilename = `booking-${uid}.ics`;
      try {
        writeFileSync(join(BOOKING_ICS_DIR, icsFilename), icsContent);
      } catch (e) { console.warn('[booking] save .ics failed:', e.message); }
    } catch (e) {
      console.warn('[booking] ICS build failed:', e.message);
    }
  }

  // Email owner — always
  const dateLabel = parsedDate
    ? parsedDate.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : (bookingData.datetime || 'TBC');
  try {
    await smartSend({
      ownerEmail, to: ownerEmail,
      subject: `📅 New booking — ${bookingData.name || senderName} on ${dateLabel}`,
      html: `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:20px;">
        <div style="background:#0d0d1f;color:#fff;padding:18px;border-radius:12px;">
          <h2 style="margin:0 0 6px;color:#00e5a0;">📅 New booking via Aria</h2>
          <p style="margin:0;color:#9898b8;font-size:13px;">Via ${channel}</p>
        </div>
        <div style="background:#fff;color:#222;padding:20px;border-radius:12px;margin-top:14px;border:1px solid #eee;">
          <p style="margin:0 0 6px;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Customer</p>
          <p style="margin:0 0 14px;font-size:16px;font-weight:600;">${(bookingData.name || senderName || 'Unknown')}</p>
          ${bookingData.contact ? `<p style="margin:0 0 6px;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Contact</p><p style="margin:0 0 14px;font-size:14px;">${bookingData.contact}</p>` : ''}
          ${bookingData.service ? `<p style="margin:0 0 6px;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Service</p><p style="margin:0 0 14px;font-size:14px;">${bookingData.service}</p>` : ''}
          <p style="margin:0 0 6px;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">When</p>
          <p style="margin:0 0 14px;font-size:14px;font-weight:600;color:#0d6e3f;">${dateLabel}</p>
          ${bookingData.notes ? `<p style="margin:0 0 6px;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Notes</p><p style="margin:0;font-size:13.5px;color:#555;">${bookingData.notes}</p>` : ''}
        </div>
        ${icsContent ? '<p style="margin:14px 0 0;font-size:12px;color:#666;text-align:center;">📎 Calendar invite (.ics) attached — open to add to your calendar app.</p>' : '<p style="margin:14px 0 0;font-size:12px;color:#cc8800;text-align:center;">⚠️ Date could not be parsed automatically — please add to your calendar manually.</p>'}
      </div>`,
      attachments: icsContent ? [{
        filename: 'booking.ics',
        content: icsContent,
        contentType: 'text/calendar; charset=utf-8; method=REQUEST',
      }] : undefined,
    });
  } catch (e) { console.warn('[booking] owner email failed:', e.message); }

  // Email customer — if we captured their email
  if (customerEmail && icsContent) {
    try {
      await smartSend({
        ownerEmail, to: customerEmail,
        subject: `Your booking with ${businessName} — ${dateLabel}`,
        html: `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:20px;">
          <div style="background:#00e5a0;color:#0d0d1f;padding:18px;border-radius:12px;text-align:center;">
            <h2 style="margin:0;">✓ Booking Confirmed</h2>
          </div>
          <div style="background:#fff;color:#222;padding:20px;border-radius:12px;margin-top:14px;border:1px solid #eee;">
            <p style="margin:0 0 14px;">Hi ${bookingData.name || 'there'},</p>
            <p style="margin:0 0 14px;">Thanks for booking with <b>${businessName}</b>. Your appointment is confirmed:</p>
            ${bookingData.service ? `<p style="margin:0 0 8px;"><b>Service:</b> ${bookingData.service}</p>` : ''}
            <p style="margin:0 0 8px;"><b>When:</b> ${dateLabel}</p>
            ${businessLocation ? `<p style="margin:0 0 14px;"><b>Where:</b> ${businessLocation}</p>` : ''}
            <p style="margin:14px 0 0;font-size:13px;color:#666;">📎 Calendar invite attached — tap to add to your calendar.</p>
            <p style="margin:14px 0 0;font-size:12px;color:#888;">Need to change or cancel? Just reply to this email or message us on ${channel}.</p>
          </div>
        </div>`,
        attachments: [{
          filename: 'booking.ics',
          content: icsContent,
          contentType: 'text/calendar; charset=utf-8; method=REQUEST',
        }],
      });
    } catch (e) { console.warn('[booking] customer email failed:', e.message); }
  }

  // Confirm to customer on the channel
  if (channelConfig && senderId) {
    const confirmText = customerEmail
      ? `✅ All booked in for ${dateLabel}. Confirmation + calendar invite sent to ${customerEmail}.`
      : `✅ All booked in for ${dateLabel}. We'll be in touch closer to the time.`;
    try {
      await sendChannelReply(channel, channelConfig, senderId, confirmText);
    } catch (e) { console.warn('[booking] channel confirm failed:', e.message); }
  }

  // Schedule a 24h-before reminder — fires via channel + email
  if (parsedDate) {
    const reminderAt = parsedDate.getTime() - 24 * 60 * 60 * 1000;
    if (reminderAt > Date.now() + 60_000) { // only future-schedule if > 1 min ahead
      try {
        scheduleTask({
          type: 'booking_reminder',
          dueAt: reminderAt,
          ownerEmail,
          payload: {
            channel, senderId, senderName,
            customerEmail,
            datetime: bookingData.datetime,
            service: bookingData.service,
          },
        });
        console.log(`⏰ [booking] Reminder scheduled for ${new Date(reminderAt).toISOString()}`);
      } catch (e) { console.warn('[booking] schedule reminder failed:', e.message); }
    }

    // Schedule a review request — fires N hours AFTER the appointment.
    // Owner opts in via dashboard config (reviewRequest.enabled + url). If
    // not configured the handler no-ops cleanly, so always scheduling is safe.
    const ownerReviewCfg = getOwnerProfile(ownerEmail)?.profile?.reviewRequest
                        || getOwnerProfile(ownerEmail)?.config?.reviewRequest
                        || {};
    const reviewDelayH  = Number(ownerReviewCfg.delayHours) > 0 ? Number(ownerReviewCfg.delayHours) : 24;
    const reviewAt      = parsedDate.getTime() + reviewDelayH * 60 * 60 * 1000;
    if (reviewAt > Date.now() + 60_000) {
      try {
        scheduleTask({
          type: 'review_request',
          dueAt: reviewAt,
          ownerEmail,
          payload: {
            channel, senderId, senderName,
            customerName: bookingData.name || senderName,
            customerEmail,
            service:  bookingData.service,
            datetime: bookingData.datetime,
          },
        });
        console.log(`⭐ [booking] Review request scheduled for ${new Date(reviewAt).toISOString()}`);
      } catch (e) { console.warn('[booking] schedule review request failed:', e.message); }
    }
  }

  return { icsFilename, parsedDate };
}

// Second Claude call ONLY when escalating — summarises the conversation so
// the owner gets actionable context instead of a wall of messages.
async function generateHandoffSummary(senderName, conversationHistory, lastMessage, reason) {
  try {
    const r = await callClaudeWithFallback({
      max_tokens: 300,
      messages: [{ role: 'user', content: `Aria needs to hand off a ${senderName} conversation to the business owner. Reason: ${reason || 'human requested'}.

Conversation so far (oldest → newest):
${conversationHistory.map(h => `[${h.role === 'sender' ? 'THEM' : 'US'}] ${h.preview}`).join('\n')}

Most recent message: "${lastMessage}"

Write a 3-bullet summary the owner can read in 10 seconds:
- What does the customer want?
- What's already been said?
- What's the single next action the owner should take?

Plain text, 3 bullets, no preamble.` }],
    });
    return r.content[0]?.text?.trim() || `Customer ${senderName} needs you to take over. Reason: ${reason}.`;
  } catch (e) {
    console.warn('Handoff summary failed:', e.message);
    return `Customer ${senderName} needs you to take over. Reason: ${reason}.`;
  }
}

// Repeat-customer index. In-memory map keyed by owner → contact-key → past
// summary. Lets Aria say "welcome back John, last time you asked about X"
// when she recognises a returning customer by extracted email/phone/name.
// Rebuilt at startup from channel_leads.jsonl + persists incrementally as
// new contacts come in.
const customerIndex = new Map(); // ownerEmail → Map(contactKey → {name, lastSeen, channels:Set, messagePreviews:[]})

function customerKey(contact) {
  if (!contact) return null;
  if (contact.email) return 'email:' + String(contact.email).trim().toLowerCase();
  if (contact.phone) return 'phone:' + String(contact.phone).replace(/[^\d+]/g, '');
  if (contact.name)  return 'name:'  + String(contact.name).trim().toLowerCase();
  return null;
}

function recordCustomerTouch(ownerEmail, { contact, channel, messagePreview, leadScore }) {
  const key = customerKey(contact);
  if (!key) return;
  if (!customerIndex.has(ownerEmail)) customerIndex.set(ownerEmail, new Map());
  const owned = customerIndex.get(ownerEmail);
  const prev = owned.get(key) || { name: null, lastSeen: null, channels: new Set(), recent: [], totalTouches: 0 };
  prev.name = contact?.name || prev.name;
  prev.lastSeen = new Date().toISOString();
  prev.channels.add(channel);
  prev.recent.unshift({ ts: prev.lastSeen, channel, leadScore, preview: (messagePreview || '').slice(0, 120) });
  if (prev.recent.length > 5) prev.recent = prev.recent.slice(0, 5);
  prev.totalTouches++;
  owned.set(key, prev);
}

function lookupReturningCustomer(ownerEmail, contact) {
  const key = customerKey(contact);
  if (!key) return null;
  const owned = customerIndex.get(ownerEmail);
  if (!owned) return null;
  const hit = owned.get(key);
  // Only "returning" if we've seen them before this current touch
  if (!hit || hit.totalTouches < 2) return null;
  return hit;
}

// Rebuild from JSONL ledger at startup so server restarts don't lose history
function rebuildCustomerIndex() {
  try {
    if (!existsSync(CHANNEL_LEADS_FILE)) return;
    for (const line of readFileSync(CHANNEL_LEADS_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (!e.ownerEmail || !e.contact) continue;
        recordCustomerTouch(e.ownerEmail, { contact: e.contact, channel: e.channel, messagePreview: e.messagePreview, leadScore: e.leadScore });
      } catch {}
    }
    console.log(`👥 Rebuilt customer index: ${[...customerIndex.values()].reduce((a, m) => a + m.size, 0)} unique contacts across ${customerIndex.size} owners`);
  } catch (e) { console.warn('Customer index rebuild failed:', e.message); }
}
rebuildCustomerIndex();

// Knowledge documents per owner — uploaded via dashboard, used by RAG
// retriever to ground Aria's answers in real owner content. Each doc is
// { title, content, uploadedAt }. Persisted to data/knowledge_docs.json.
const KNOWLEDGE_DOCS_FILE = resolve('data/knowledge_docs.json');
const knowledgeDocs = new Map(); // ownerEmail → [{title, content, uploadedAt}]
try {
  if (existsSync(KNOWLEDGE_DOCS_FILE)) {
    const saved = JSON.parse(readFileSync(KNOWLEDGE_DOCS_FILE, 'utf8'));
    for (const [k, v] of Object.entries(saved)) knowledgeDocs.set(k, v);
  }
} catch (e) { console.warn('Failed to load knowledge docs:', e.message); }
function persistKnowledgeDocs() {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    const obj = {};
    for (const [k, v] of knowledgeDocs) obj[k] = v;
    writeFileSync(KNOWLEDGE_DOCS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.warn('Failed to persist knowledge docs:', e.message); }
}

// ─── Voice receptionist (Vapi) state ─────────────────────────────────────
// voiceConfig: ownerEmail → { enabled, phoneNumber, voiceId, firstMessage,
//   greetingHours }. Keyed by owner so the dashboard can read/write it.
// voiceNumberIndex: dialedNumber (E.164) → ownerEmail. Built from
//   voiceConfig so an inbound call's assistant-request resolves to an owner
//   in O(1). Rebuilt whenever voiceConfig changes.
const VOICE_CONFIG_FILE = resolve('data/voice_config.json');
const PHONE_CALLS_LEDGER = resolve('data/phone_calls.jsonl');
const voiceConfig = new Map();
const voiceNumberIndex = new Map();

function rebuildVoiceNumberIndex() {
  voiceNumberIndex.clear();
  for (const [owner, cfg] of voiceConfig) {
    if (cfg?.phoneNumber) voiceNumberIndex.set(normalisePhone(cfg.phoneNumber), owner);
  }
}
// Strip everything but digits + leading + so "+44 7497 812186" and
// "447497812186" resolve to the same key.
function normalisePhone(p) {
  if (!p) return '';
  const s = String(p).replace(/[^\d+]/g, '');
  return s.startsWith('+') ? s : (s.startsWith('00') ? '+' + s.slice(2) : '+' + s);
}
function loadVoiceConfig() {
  try {
    if (existsSync(VOICE_CONFIG_FILE)) {
      const saved = JSON.parse(readFileSync(VOICE_CONFIG_FILE, 'utf8'));
      for (const [k, v] of Object.entries(saved)) voiceConfig.set(k, v);
    }
  } catch (e) { console.warn('Failed to load voice config:', e.message); }
  rebuildVoiceNumberIndex();
}
function persistVoiceConfig() {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    const obj = {};
    for (const [k, v] of voiceConfig) obj[k] = v;
    writeFileSync(VOICE_CONFIG_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.warn('Failed to persist voice config:', e.message); }
  rebuildVoiceNumberIndex();
}
function appendPhoneCallLedger(entry) {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    appendFileSync(PHONE_CALLS_LEDGER, JSON.stringify(entry) + '\n');
  } catch (e) { console.warn('[voice] call ledger append failed:', e.message); }
}
// Load voice config NOW — after its state consts are initialized. Module
// top-level runs once at boot, same effect as loading in the startup IIFE
// but without the TDZ crash that calling it earlier caused.
loadVoiceConfig();

// GET /api/dashboard/knowledge — list owner's docs
app.get('/api/dashboard/knowledge', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const docs = (knowledgeDocs.get(owner) || []).map(d => ({ title: d.title, charCount: (d.content || '').length, uploadedAt: d.uploadedAt }));
  res.json({ docs });
});

// POST /api/dashboard/knowledge — add a doc (title + plain text content)
app.post('/api/dashboard/knowledge', express.json({ limit: '2mb' }), (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const { title, content } = req.body || {};
  if (!title || !content) return res.status(400).json({ error: 'title + content required' });
  if (String(content).length > 200000) return res.status(413).json({ error: 'doc too large (200k char max)' });
  const docs = knowledgeDocs.get(owner) || [];
  docs.push({ title: String(title).slice(0, 120), content: String(content), uploadedAt: new Date().toISOString() });
  if (docs.length > 50) docs.shift(); // cap at 50 docs per owner
  knowledgeDocs.set(owner, docs);
  persistKnowledgeDocs();
  res.json({ ok: true, totalDocs: docs.length });
});

// DELETE /api/dashboard/knowledge/:idx — remove a doc by index
app.delete('/api/dashboard/knowledge/:idx', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const idx = parseInt(req.params.idx);
  const docs = knowledgeDocs.get(owner) || [];
  if (idx < 0 || idx >= docs.length) return res.status(404).json({ error: 'not found' });
  docs.splice(idx, 1);
  knowledgeDocs.set(owner, docs);
  persistKnowledgeDocs();
  res.json({ ok: true });
});

// Per-owner-per-day token budget for channel replies. Default 50k/day
// (~250-500 replies depending on length). Prevents a single chatty
// customer (or DM spam attack) from draining the Anthropic spend on
// behalf of one client. Owners can raise via profile config.tokensPerDay.
const DEFAULT_DAILY_TOKEN_BUDGET = 50000;
const tokenUsageDaily = new Map(); // `${ownerEmail}::YYYY-MM-DD` → { tokens, replies }

function todayKey(ownerEmail) {
  return `${ownerEmail}::${new Date().toISOString().slice(0, 10)}`;
}
function checkBudget(ownerEmail, capOverride) {
  const cap = capOverride || DEFAULT_DAILY_TOKEN_BUDGET;
  const usage = tokenUsageDaily.get(todayKey(ownerEmail)) || { tokens: 0, replies: 0 };
  return { allowed: usage.tokens < cap, used: usage.tokens, cap, replies: usage.replies };
}
function recordTokenUsage(ownerEmail, tokensUsed) {
  const key = todayKey(ownerEmail);
  const usage = tokenUsageDaily.get(key) || { tokens: 0, replies: 0 };
  usage.tokens += tokensUsed || 0;
  usage.replies += 1;
  tokenUsageDaily.set(key, usage);
  // Garbage-collect entries older than 3 days to keep map bounded
  const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const k of tokenUsageDaily.keys()) {
    if (k.split('::')[1] < cutoff) tokenUsageDaily.delete(k);
  }
}

// Channel knowledge-gap ledger. Distinct from the existing widget /api/gap
// system — those came from the chat-widget on websites. This one tracks
// FB/IG/WA conversations where Aria fell back to vague answers, so owners
// can fix the underlying knowledge.
const CHANNEL_GAPS_FILE = resolve('data/channel_gaps.jsonl');
function appendChannelGap(entry) {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    appendFileSync(CHANNEL_GAPS_FILE, JSON.stringify(entry) + '\n');
  } catch (e) { console.warn('[channel-gap] append failed:', e.message); }
}

// Heuristic: Aria's reply signals a knowledge gap when it leans on these
// fallback phrases. Tuned for the warm-but-uncertain answers that mean
// "I should have known this but didn't".
const GAP_FALLBACK_RE = /\b(i\s?[''']?(?:ll|will)\s+(?:have|get|let)\s+(?:the\s+team|someone)|let me check|i[''']?m not sure|i don[''']?t (?:have|know)|the team will|i[''']?ll pass this on|let me get back|will need to confirm|don[''']?t have that (?:info|detail)|can[''']?t answer that|outside my (?:scope|knowledge))\b/i;

// CSAT ledger — append-only, one line per rating event.
const CSAT_FILE = resolve('data/csat.jsonl');
function appendCsat(entry) {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    appendFileSync(CSAT_FILE, JSON.stringify(entry) + '\n');
  } catch (e) { console.warn('[csat] append failed:', e.message); }
}

// Conversation-closure heuristic. Fires CSAT prompt when a customer says one
// of these and the conv has progressed (>=2 message exchanges). Keep loose
// — better to over-prompt than miss closings.
const CLOSURE_RE = /\b(thanks|thank you|cheers|ta|perfect|great|brilliant|sorted|got it|all good|amazing|appreciate it|grand)[!. ]*$/i;

// Append-only ledger of channel-sourced leads. One line per scored message
// so we never lose history (Engineering Rule 13). Consumers derive current
// state by reading recent entries.
// (CHANNEL_LEADS_FILE constant lives near top of file alongside other *_FILE
//  constants — was hoisted to fix a temporal-dead-zone error in startup.)
function appendChannelLead(entry) {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    appendFileSync(CHANNEL_LEADS_FILE, JSON.stringify(entry) + '\n');
  } catch (e) { console.warn('[channel-lead] append failed:', e.message); }
}

// Roll up scored lead into channelStats.{owner}.leads.{hot|warm|cold}
// + append to the JSONL ledger. The dashboard's /api/dashboard/stats
// later sums these alongside email leads for a unified Leads card.
function trackChannelLead(ownerEmail, { channel, senderId, senderName, leadScore, category, contact, messagePreview, sentiment, urgency }) {
  const stats = channelStats.get(ownerEmail) || {
    whatsapp: { replied: 0, week: 0, lastReply: null },
    instagram: { replied: 0, week: 0, lastReply: null },
    facebook: { replied: 0, week: 0, lastReply: null },
    total: 0,
    leads: { hot: 0, warm: 0, cold: 0 },
    categories: { booking: 0, quote: 0, complaint: 0, feedback: 0, general: 0 },
  };
  if (!stats.leads) stats.leads = { hot: 0, warm: 0, cold: 0 };
  if (!stats.categories) stats.categories = { booking: 0, quote: 0, complaint: 0, feedback: 0, general: 0 };
  stats.leads[leadScore] = (stats.leads[leadScore] || 0) + 1;
  stats.categories[category] = (stats.categories[category] || 0) + 1;
  channelStats.set(ownerEmail, stats);
  persistChannelStats();

  appendChannelLead({
    ts: new Date().toISOString(),
    ownerEmail, channel, senderId, senderName,
    leadScore, category,
    sentiment: sentiment || null,
    urgency: urgency || null,
    contact: contact || {},
    messagePreview: (messagePreview || '').slice(0, 200),
  });
}

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

async function handleIncomingChannelMessage({ channel, recipientId, senderId, senderName, messageText, messageId, imageRefs = [], voiceMeta = null }) {
  // Dedup
  if (processedMetaMessages.has(messageId)) return;
  processedMetaMessages.add(messageId);
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

  // Conversation memKey + paused-state check. If owner manually paused this
  // conv (e.g. after escalation), Aria stops auto-replying until resumed.
  const memKey = `${ownerEmail}::${channel}::${senderId}`;
  const convState = conversationState.get(memKey);

  // CSAT response capture — if we sent a 👍/👎 prompt and this message is
  // the rating, log it + skip the normal reply flow (don't re-engage on a
  // rating message, looks weird).
  if (convState?.csatPending) {
    const rated = /^[👍👎]|^(thumbs up|thumbs down|good|bad|👌|👏|🙏|⭐+|[1-5]\/5|[1-5] *out of *5)/i.test(messageText.trim());
    if (rated) {
      const positive = /👍|👌|👏|good|great|brilliant|perfect|amazing|⭐⭐⭐⭐⭐|⭐⭐⭐⭐|[45]\/5|[45] *out of *5/i.test(messageText);
      appendCsat({
        ts: new Date().toISOString(),
        ownerEmail, channel, senderId, senderName,
        rating: positive ? 'positive' : 'negative',
        raw: messageText.slice(0, 200),
      });
      const st = conversationState.get(memKey) || {};
      delete st.csatPending;
      conversationState.set(memKey, st);
      persistConversationState();
      // Brief thank-you, no new conv loop
      await sendChannelReply(channel, ownerChannels[channel], senderId, positive ? 'Thanks for the feedback! 🙏' : 'Thanks for letting us know — we\'ll do better next time.');
      console.log(`⭐ [${channel}] CSAT recorded: ${positive ? 'positive' : 'negative'} from ${senderName}`);
      if (!positive) {
        fireWebhookEvent(ownerEmail, 'csat_negative', {
          channel, senderId, senderName,
          rating: 'negative', raw: messageText.slice(0, 200),
        });
      }
      return;
    }
  }
  if (convState?.paused) {
    console.log(`📱 [${channel}] Conv paused (escalated) — skipping auto-reply for ${senderId}`);
    return;
  }

  // Build system prompt from client profile
  const profile = getOwnerProfile(ownerEmail);
  const systemPrompt = profile?.systemPrompt || `You are a helpful business assistant for ${ownerEmail}.`;
  const allowedTopics = profile?.config?.allowedTopics
    || profile?.allowedTopics
    || profile?.profile?.allowedTopics
    || null;

  // Business hours gate. Owner-configurable schedule per profile. If outside
  // hours: either silently log (no reply), or send a polite auto-reply
  // saying "we are closed". Either way the message + lead are still saved.
  const schedule = profile?.profile?.schedule || profile?.schedule || profile?.config?.schedule;
  if (schedule) {
    const evalRes = evaluateSchedule(schedule, new Date());
    if (!evalRes.inHours) {
      console.log(`🕐 [${channel}] Out of hours for ${ownerEmail} (${evalRes.todayLocal} ${Math.floor(evalRes.minutesLocal/60)}:${String(evalRes.minutesLocal%60).padStart(2,'0')} ${evalRes.timezone})`);
      if (evalRes.outOfHoursMode === 'auto_reply' && evalRes.outOfHoursMessage) {
        try {
          await sendChannelReply(channel, ownerChannels[channel], senderId, evalRes.outOfHoursMessage);
        } catch (e) { console.warn('[ooh] auto-reply send failed:', e.message); }
      }
      // Log incoming message so it's visible in dashboard + activity feed
      const msgs = channelMessages.get(ownerEmail) || [];
      msgs.push({
        id: messageId, channel, senderId, senderName,
        message: messageText, reply: evalRes.outOfHoursMode === 'auto_reply' ? evalRes.outOfHoursMessage : '(out of hours — not replied)',
        timestamp: new Date().toISOString(), status: 'ooh',
      });
      if (msgs.length > 500) msgs.splice(0, msgs.length - 500);
      channelMessages.set(ownerEmail, msgs);
      persistChannelMessages();
      return;
    }
  }

  // Budget gate — bail before spending tokens if today's cap is hit.
  // Owner gets one alert email per day per cap-hit. After cap, we stop
  // auto-replying entirely until midnight rollover.
  const budget = checkBudget(ownerEmail, profile?.config?.tokensPerDay);
  if (!budget.allowed) {
    const st = conversationState.get(memKey) || {};
    if (!st.budgetAlertSentToday || st.budgetAlertSentToday !== new Date().toISOString().slice(0, 10)) {
      try {
        await smartSend({
          ownerEmail, to: ownerEmail,
          subject: `⚠️ Aria daily token budget hit for ${channel}`,
          html: `<div style="font-family:sans-serif;padding:20px;max-width:520px;margin:0 auto;">
            <h2 style="color:#fbbf24;">Daily limit reached</h2>
            <p>Aria has hit your daily token budget (${budget.cap.toLocaleString()} tokens, ${budget.replies} replies sent today).</p>
            <p>She'll resume auto-replying tomorrow. You can raise the cap via your dashboard settings if this is happening too often.</p>
          </div>`,
        });
        st.budgetAlertSentToday = new Date().toISOString().slice(0, 10);
        conversationState.set(memKey, st);
        persistConversationState();
      } catch {}
    }
    console.log(`💸 [${channel}] Budget hit for ${ownerEmail} — skipping reply (used ${budget.used}/${budget.cap})`);
    return;
  }

  // Slot tracking — if a booking is in progress, surface which slots are
  // still empty so Aria asks for ONE missing piece at a time instead of
  // either re-asking everything or skipping the missing field.
  const pendingBooking = convState?.pendingBooking || null;
  const slotContext = pendingBooking
    ? `\n\nBOOKING IN PROGRESS — we already collected: ${JSON.stringify(pendingBooking)}. Still need (in priority order): ${
        ['name', 'contact', 'service', 'datetime'].filter(slot => !pendingBooking[slot]).join(', ') || 'nothing — confirm and close out'
      }. Ask for the NEXT missing slot only, don't re-ask filled ones.`
    : '';

  // Returning-customer recognition. We can only check known contacts (name
  // captured from this senderId's past conv via slot filling, or matched
  // by past extracted email/phone). Personalises the opener.
  const knownContact = (convState?.pendingBooking)
    ? { name: convState.pendingBooking.name, email: convState.pendingBooking.contact?.includes('@') ? convState.pendingBooking.contact : null, phone: !convState.pendingBooking.contact?.includes('@') ? convState.pendingBooking.contact : null }
    : null;
  const returning = knownContact ? lookupReturningCustomer(ownerEmail, knownContact) : null;
  const returningContext = returning
    ? `\n\nRETURNING CUSTOMER — you've spoken with ${returning.name || senderName} before. Last touch: ${returning.lastSeen}. Recent topics: ${returning.recent.slice(0, 3).map(r => r.preview).join(' | ')}. Acknowledge briefly ("welcome back") but don't repeat their history at them — just reply to current message with the context in mind.`
    : '';

  // Knowledge base (manual FAQs)
  const kbEntries = knowledgeBase.get(ownerEmail) || [];
  const kbContext = kbEntries.length
    ? '\n\nFREQUENTLY ASKED QUESTIONS:\n' + kbEntries.map(e => `Q: ${e.question}\nA: ${e.answer}`).join('\n\n')
    : '';

  // RAG over uploaded documents — retrieve top 3 chunks relevant to the
  // sender's message. Empty silently when owner has no docs uploaded.
  const ownerDocs = knowledgeDocs.get(ownerEmail) || [];
  const ragChunks = ownerDocs.length ? retrieveRelevantChunks(messageText, ownerDocs, { topK: 3 }) : [];
  const ragContext = ragChunks.length
    ? '\n\nRELEVANT DOCUMENT EXCERPTS (cite these for accuracy — DO NOT make up details not in them):\n' +
      ragChunks.map(c => `[from "${c.title}"] ${c.content}`).join('\n\n')
    : '';

  // Conversation memory (memKey already defined above for paused-state check)
  const history = conversationMemory.get(memKey) || [];
  const convContext = history.length
    ? '\n\nPREVIOUS CONVERSATION with this person (oldest → newest):\n' +
      history.map(h => {
        if (h.role === 'summary') return `[EARLIER — SUMMARY] ${h.preview}`;
        if (h.role === 'sender')  return `[THEM] ${h.preview}`;
        return `[US] ${h.preview}`;
      }).join('\n---\n')
    : '';

  // Channel-specific instructions
  const channelLimits = {
    whatsapp: 'Keep replies under 300 words. Use short paragraphs. No HTML.',
    instagram: 'Keep replies under 200 words. Casual, friendly tone. No HTML.',
    facebook: 'Keep replies under 300 words. Friendly and professional. No HTML.',
  };
  const channelInstructions = `\n\nYou are replying via ${channel}. ${channelLimits[channel]} Never mention you are AI — write as a team member.`;

  // Show "typing…" so the customer knows Aria is composing (institutional UX)
  sendTypingIndicator(channel, ownerChannels[channel], senderId, true);

  // Generate reply (with scope guardrail + slot + returning + RAG context + images)
  // For WhatsApp images we need the WA access token to resolve media_id →
  // base64 server-side. FB/IG images are publicly-fetchable Meta CDN URLs.
  const waAccessTokenForMedia = channel === 'whatsapp'
    ? (channelConfig?.accessToken || process.env.WA_ACCESS_TOKEN)
    : null;

  // Voice-note hint: when transcription was used, tell Claude so it can
  // acknowledge naturally ("Got your voice note...") rather than treating
  // it as if the customer had typed it out.
  const voiceContext = voiceMeta
    ? `\n\nNOTE: this message arrived as a VOICE NOTE which Aria transcribed. The text above is the transcript. Feel free to start your reply with a brief natural acknowledgement (e.g. "Got your voice note —") before answering. Don't ask them to type it out, the transcript is what they meant.`
    : '';

  // Reminder context — if Aria sent a "still good for X?" reminder recently
  // and the customer hasn't responded yet, flag it so Claude classifies this
  // message as confirmed / reschedule / cancel.
  const pendingReminder = conversationState.get(memKey)?.pendingReminder;
  const reminderContext = pendingReminder
    ? `\n\nREMINDER PENDING: Aria sent a booking reminder (${pendingReminder.bookingDatetime}${pendingReminder.service ? ' for ' + pendingReminder.service : ''}) on ${pendingReminder.sentAt}. THIS CUSTOMER MESSAGE MAY BE THEIR RESPONSE. If they confirm / reschedule / cancel, set bookingReminderResponse accordingly. If confirming, reply warm + short ("Brilliant — see you then 👋"). If rescheduling, ask what time works. If cancelling, acknowledge politely + ask if they want to rebook later.`
    : '';

  const reply = await generateChannelReply(
    systemPrompt + kbContext + ragContext + convContext + slotContext + returningContext + channelInstructions + voiceContext + reminderContext,
    senderName, messageText,
    { allowedTopics, imageRefs, waAccessToken: waAccessTokenForMedia, ownerEmail, channel }
  );

  // Stop typing whether we got a reply or not
  sendTypingIndicator(channel, ownerChannels[channel], senderId, false);

  if (!reply) {
    console.warn(`📱 [${channel}] Failed to generate reply for ${senderId}`);
    return;
  }

  // Charge budget (input + output tokens for THIS reply)
  recordTokenUsage(ownerEmail, reply._tokensUsed || 0);

  // Reminder-response handling — act on Claude's classification BEFORE
  // running the standard send/persist flow. Clears pendingReminder so the
  // noshow_check at T-2h sees the conv as resolved + no alert fires.
  if (reply.bookingReminderResponse && pendingReminder) {
    const st = conversationState.get(memKey) || {};
    delete st.pendingReminder;
    conversationState.set(memKey, st);
    persistConversationState();

    if (reply.bookingReminderResponse === 'cancel') {
      // Mark the booking cancelled in bookings[] so it stops blocking the
      // slot for conflict-detection + isn't sent the review-request after.
      // Owner-scoped match: prefer contact-on-channel, fall back to
      // channel+datetime so we don't accidentally cancel the wrong owner's
      // booking that happens to share a contact id.
      const bookingIdx = bookings.findIndex(b =>
        b.ownerEmail === ownerEmail
        && (b.contact === senderId
            || (b.channel === channel && b.datetime === pendingReminder.bookingDatetime))
      );
      if (bookingIdx >= 0) {
        bookings[bookingIdx].status = 'cancelled';
        bookings[bookingIdx].cancelledAt = new Date().toISOString();
        save('bookings', bookings);
      }
      // Alert owner so they can fill the slot
      try {
        await smartSend({
          ownerEmail, to: ownerEmail,
          subject: `❌ Booking cancelled — ${senderName}`,
          html: `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:20px;font-size:14.5px;line-height:1.6;color:#222;">${senderName} just cancelled their ${pendingReminder.bookingDatetime}${pendingReminder.service ? ' ' + pendingReminder.service : ''} booking via ${channel}.<br><br>Slot is now free.</div>`,
        });
      } catch {}
      fireWebhookEvent(ownerEmail, 'booking_cancelled', {
        channel, senderId, senderName,
        datetime: pendingReminder.bookingDatetime, service: pendingReminder.service,
      });
      console.log(`❌ [reminder] ${senderName} cancelled booking ${pendingReminder.bookingDatetime}`);
    } else if (reply.bookingReminderResponse === 'reschedule') {
      // Keep pendingBooking with cleared datetime so the next "how about 4pm?"
      // message merges straight into a slot-fill flow + re-runs conflict check.
      const existingBooking = bookings.find(b => b.ownerEmail === ownerEmail && b.datetime === pendingReminder.bookingDatetime);
      const stB = conversationState.get(memKey) || {};
      stB.pendingBooking = {
        name:    existingBooking?.name || senderName,
        contact: existingBooking?.contact || null,
        service: pendingReminder.service,
        datetime: null,
      };
      conversationState.set(memKey, stB);
      persistConversationState();
      console.log(`🔁 [reminder] ${senderName} wants to reschedule ${pendingReminder.bookingDatetime}`);
    } else {
      // confirmed — log only, fire webhook so CRM knows
      fireWebhookEvent(ownerEmail, 'booking_confirmed', {
        channel, senderId, senderName,
        datetime: pendingReminder.bookingDatetime, service: pendingReminder.service,
      });
      console.log(`✓ [reminder] ${senderName} confirmed ${pendingReminder.bookingDatetime}`);
    }
  }

  // ─── Quote drafting (two-stage approval) ──────────────────────────────
  // When Claude detected quote intent AND drafted line items, store as a
  // pendingQuote + email owner with [Approve][Edit][Reject] buttons.
  // Customer just gets Aria's "let me put a quote together" reply — the
  // itemised quote arrives after owner approves.
  if (reply.quoteIntent && reply.quoteDraft) {
    const ownerCfg = profile?.profile?.quoteAutoDraft || profile?.config?.quoteAutoDraft || {};
    const maxAmt   = Number(ownerCfg.maxAmount) > 0 ? Number(ownerCfg.maxAmount) : 5000;
    if (ownerCfg.enabled === false) {
      // Owner opted out — just send Aria's normal reply, no draft.
      console.log(`💷 [quote] skipped — owner disabled auto-draft (${ownerEmail})`);
    } else if (reply.quoteDraft.subtotal > maxAmt) {
      // Above owner's auto-draft cap — escalate instead of drafting
      console.log(`💷 [quote] subtotal ${reply.quoteDraft.subtotal} > max ${maxAmt}, escalating to human for ${ownerEmail}`);
      try {
        await smartSend({
          ownerEmail, to: ownerEmail,
          subject: `💷 Quote request above auto-cap — ${senderName} (${reply.quoteDraft.currency}${reply.quoteDraft.subtotal})`,
          html: `<div style="font-family:-apple-system,sans-serif;max-width:520px;padding:20px;">
            <p><b>${senderName}</b> asked: <i>"${messageText.slice(0, 200)}"</i></p>
            <p>Aria drafted a quote at <b>${reply.quoteDraft.currency}${reply.quoteDraft.subtotal}</b>, above your auto-cap of ${reply.quoteDraft.currency}${maxAmt}.</p>
            <p>Reply directly to the customer on ${channel} so you can scope properly.</p>
          </div>`,
        });
      } catch {}
    } else {
      // Normal flow — create pending quote + email owner
      const quoteId = generateSessionToken();
      pendingQuotes.set(quoteId, {
        ownerEmail, channel, senderId, senderName,
        originalQuestion: messageText.slice(0, 500),
        draft: reply.quoteDraft,
        createdAt: Date.now(),
        contact: null, // set from reply.contact if present
      });
      pendingQuotes.get(quoteId).contact = reply.contact?.email || reply.contact?.phone || null;
      persistPendingQuotes();
      appendQuoteLedger({
        ts: new Date().toISOString(), event: 'drafted',
        quoteId, ownerEmail, channel, senderId, senderName,
        subtotal: reply.quoteDraft.subtotal, currency: reply.quoteDraft.currency,
      });

      // Build approval email
      const serverUrl = process.env.GOOGLE_REDIRECT_URI?.replace('/auth/gmail/callback', '') || `http://localhost:${process.env.PORT || 3000}`;
      const itemRows = reply.quoteDraft.lineItems.map(li =>
        `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;">${escapeHtml(li.label)}${li.notes ? `<br><span style="font-size:11px;color:#888;">${escapeHtml(li.notes)}</span>` : ''}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">${li.qty > 1 ? li.qty + ' × ' : ''}${reply.quoteDraft.currency}${li.price.toFixed(2)}</td></tr>`
      ).join('');

      try {
        await smartSend({
          ownerEmail, to: ownerEmail,
          subject: `💷 Aria drafted a quote for ${senderName} — ${reply.quoteDraft.currency}${reply.quoteDraft.subtotal}`,
          html: `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:20px;">
            <h2 style="color:#1a1a2e;margin-bottom:4px;">New quote request</h2>
            <div style="background:#f8f8fc;border-radius:10px;padding:14px;margin:14px 0;font-size:13.5px;color:#555;">
              <b>${senderName}</b> asked (via ${channel}):<br>
              <i>"${escapeHtml(messageText.slice(0, 300))}"</i>
            </div>
            <div style="background:#fff;border:1px solid #e0e0eb;border-radius:10px;padding:16px;margin:14px 0;">
              <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Aria's draft quote</div>
              <table style="width:100%;border-collapse:collapse;font-size:13.5px;color:#222;">
                ${itemRows}
                <tr><td style="padding:10px 8px;font-weight:700;">Total</td><td style="padding:10px 8px;text-align:right;font-weight:700;color:#0d6e3f;">${reply.quoteDraft.currency}${reply.quoteDraft.subtotal.toFixed(2)}</td></tr>
              </table>
              ${reply.quoteDraft.caveat ? `<p style="font-size:11.5px;color:#888;margin-top:10px;font-style:italic;">${escapeHtml(reply.quoteDraft.caveat)}</p>` : ''}
              <p style="font-size:11.5px;color:#888;margin-top:4px;">Valid for ${reply.quoteDraft.validityDays} days.</p>
            </div>
            <div style="display:flex;gap:8px;margin-top:18px;">
              <a href="${serverUrl}/api/quotes/approve?id=${quoteId}" style="display:inline-block;padding:11px 18px;background:#00e5a0;color:#0d0d1f;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px;">✓ Send to customer</a>
              <a href="${serverUrl}/api/quotes/edit?id=${quoteId}" style="display:inline-block;padding:11px 18px;background:#9d96ff;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px;">✎ Edit first</a>
              <a href="${serverUrl}/api/quotes/reject?id=${quoteId}" style="display:inline-block;padding:11px 18px;background:#ff6b6b;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px;">✗ Reject</a>
            </div>
            <p style="font-size:11px;color:#aaa;margin-top:18px;">If you ignore this, the customer just gets Aria's holding message. Reject = nothing sent.</p>
          </div>`,
        });
        console.log(`💷 [quote] drafted ${reply.quoteDraft.currency}${reply.quoteDraft.subtotal} for ${senderName} (${ownerEmail}) — awaiting owner approval [${quoteId.slice(0, 8)}]`);
        fireWebhookEvent(ownerEmail, 'quote_drafted', {
          quoteId, channel, senderId, senderName,
          subtotal: reply.quoteDraft.subtotal, currency: reply.quoteDraft.currency,
        });
      } catch (e) { console.warn('[quote] owner approval email failed:', e.message); }
    }
  }

  // Save incoming to conversation memory + summarise on overflow.
  // Sliding-window pattern: most recent CONV_MAX_RAW entries kept verbatim,
  // older entries compressed into a single summary entry that persists.
  history.push({ role: 'sender', preview: messageText.substring(0, 300), date: new Date().toISOString() });
  if (history.length >= CONV_SUMMARIZE_TRIGGER) {
    const overflow = history.length - CONV_MAX_RAW;
    // Don't re-summarise an existing summary — preserve it + add to it.
    const existingSummary = history[0]?.role === 'summary' ? history.shift() : null;
    const toCompress = history.splice(0, overflow);
    if (existingSummary) toCompress.unshift({ role: 'sender', preview: existingSummary.preview, date: existingSummary.date });
    const summaryText = await summarizeOldHistory(toCompress);
    if (summaryText) {
      history.unshift({ role: 'summary', preview: summaryText, date: new Date().toISOString() });
      console.log(`📝 [${channel}] Summarised ${toCompress.length} old entries → ${summaryText.slice(0, 80)}...`);
    }
  }
  conversationMemory.set(memKey, history);
  persistConversationMemory();

  // ─── Trust pack: sentiment / urgency / handoff / scope ──────────────────
  // 1. ANGRY or HIGH-URGENCY → alert owner immediately. Aria still sends
  //    her reply (don't ghost the customer), but owner gets a heads-up.
  const isAngry = reply.sentiment === 'angry' || reply.sentiment === 'negative';
  const isUrgent = reply.urgency === 'high';
  if (isAngry || isUrgent) {
    try {
      await smartSend({
        ownerEmail, to: ownerEmail,
        subject: `🚨 ${isAngry ? 'Angry' : 'Urgent'} ${channel} message from ${senderName}`,
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:20px;">
          <h2 style="color:#${isAngry ? 'ff6b6b' : 'fbbf24'};margin-bottom:4px;">${isAngry ? '😡 Angry' : '⏰ Urgent'} message on ${channel}</h2>
          <p style="color:#666;font-size:13px;margin-bottom:16px;">Sentiment: <b>${reply.sentiment}</b> · Urgency: <b>${reply.urgency}</b></p>
          <div style="background:#fef2f2;border-left:4px solid #${isAngry ? 'ff6b6b' : 'fbbf24'};padding:12px 16px;margin-bottom:16px;">
            <p style="font-size:12px;color:#999;margin-bottom:6px;">${senderName} said:</p>
            <p style="color:#333;font-size:14px;">${messageText.substring(0, 500).replace(/</g,'&lt;')}</p>
          </div>
          <p style="font-size:13px;color:#666;">Aria has replied to keep the customer engaged, but you may want to take this one yourself.</p>
        </div>`,
      });
      console.log(`🚨 [${channel}] Alerted owner: ${isAngry ? 'angry' : 'urgent'} message from ${senderName}`);
    } catch (e) { console.warn('Alert send failed:', e.message); }
  }

  // 2. needsHuman → escalate: pause auto-reply on this conv + ship summary
  if (reply.needsHuman) {
    conversationState.set(memKey, { paused: true, escalatedAt: new Date().toISOString(), reason: reply.handoffReason });
    persistConversationState();
    try {
      const summary = await generateHandoffSummary(senderName, history, messageText, reply.handoffReason);
      await smartSend({
        ownerEmail, to: ownerEmail,
        subject: `🤝 Aria handed off ${senderName} (${channel}) — your turn`,
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:20px;">
          <h2 style="color:#1a1a2e;margin-bottom:4px;">Conversation needs you</h2>
          <p style="color:#666;font-size:13px;margin-bottom:16px;">${channel} · ${senderName} · ${reply.handoffReason || 'Aria flagged this for human review'}</p>
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px;margin-bottom:20px;white-space:pre-line;">${summary.replace(/</g,'&lt;')}</div>
          <p style="font-size:13px;color:#666;">Auto-reply is <b>paused</b> on this conversation until you resume it from your dashboard.</p>
        </div>`,
      });
      console.log(`🤝 [${channel}] Handed off ${senderName} → ${ownerEmail}: ${reply.handoffReason}`);
      fireWebhookEvent(ownerEmail, 'handoff', {
        channel, senderId, senderName,
        reason: reply.handoffReason || 'human requested',
        summary,
      });
    } catch (e) { console.warn('Handoff summary failed:', e.message); }
  }

  // 3. outOfScope → mark category. Aria's text already contains the polite
  //    redirect (per the prompt's scope rule), so we just log + skip booking.
  if (reply.outOfScope) {
    console.log(`🚫 [${channel}] Out of scope from ${senderName}: redirected`);
    reply.booking = null; // never book off-topic stuff even if Claude tried
  }

  // Check approval mode
  const approvalMode = ownerChannels.approvalMode || ownerChannels[channel]?.approvalMode;
  if (approvalMode) {
    const approvalId = generateSessionToken();
    channelApprovals.set(approvalId, {
      ownerEmail, channel, senderId, senderName, messageText,
      draftReply: reply.text, booking: reply.booking,
      suggestedReplies: reply.suggestedReplies || [],
      createdAt: Date.now(),
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
    console.log(`✏️ [${channel}] Approval sent to ${ownerEmail}`);
    return;
  }

  // Send reply directly. Quick-reply buttons attached when Claude provided
  // suggestedReplies — Messenger + IG render as tappable chips, WhatsApp
  // renders as interactive reply buttons (max 3).
  const sent = await sendChannelReply(channel, channelConfig, senderId, reply.text, reply.suggestedReplies);

  // Aria asked to show the services carousel and owner has services
  // defined in their profile — fire it as a follow-up message.
  const ownerServices = profile?.config?.services
    || profile?.servicesCarousel
    || profile?.profile?.servicesCarousel;
  if (reply.showServicesCarousel && Array.isArray(ownerServices) && ownerServices.length) {
    setTimeout(async () => {
      try {
        await sendChannelCarousel(channel, channelConfig, senderId, ownerServices);
        console.log(`🎠 [${channel}] Sent services carousel (${ownerServices.length} cards) to ${senderName}`);
      } catch (e) { console.warn('Carousel send failed:', e.message); }
    }, 1500);
  }
  if (!sent) {
    console.warn(`📱 [${channel}] Failed to send reply to ${senderId}`);
    return;
  }

  // Save our reply to conversation memory
  const updatedHistory = conversationMemory.get(memKey) || [];
  updatedHistory.push({ role: 'us', preview: reply.text.substring(0, 300), date: new Date().toISOString() });
  if (updatedHistory.length > 20) updatedHistory.splice(0, updatedHistory.length - 20);
  conversationMemory.set(memKey, updatedHistory);
  persistConversationMemory();

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

  // Score + promote to lead. Uses conversation depth so longer convs
  // weigh hotter. Append-only ledger via trackChannelLead.
  try {
    const convLen = (conversationMemory.get(memKey) || []).length;
    const leadScore = scoreChannelLead({
      senderMessage: messageText,
      reply,
      contact: reply.contact || {},
      conversationLength: convLen,
    });
    const category = categorizeChannelMessage(messageText);
    trackChannelLead(ownerEmail, {
      channel, senderId, senderName,
      leadScore, category,
      sentiment: reply.sentiment,
      urgency: reply.urgency,
      contact: reply.contact || {},
      messagePreview: messageText,
    });
    // Update the in-memory repeat-customer index too so the NEXT message
    // can use the recognition logic.
    recordCustomerTouch(ownerEmail, {
      contact: reply.contact || { name: senderName },
      channel, messagePreview: messageText, leadScore,
    });
    console.log(`📱 [${channel}] Lead scored: ${leadScore} / ${category} (conv=${convLen})`);

    // Fire webhook event(s) — new_lead always, hot_lead only when score=hot
    fireWebhookEvent(ownerEmail, 'new_lead', {
      channel, senderId, senderName,
      leadScore, category,
      sentiment: reply.sentiment, urgency: reply.urgency,
      contact: reply.contact || {},
      messagePreview: messageText.slice(0, 300),
    });
    if (leadScore === 'hot') {
      fireWebhookEvent(ownerEmail, 'hot_lead', {
        channel, senderId, senderName,
        category,
        contact: reply.contact || {},
        messagePreview: messageText.slice(0, 300),
      });
    }
    if (reply.sentiment === 'angry') {
      fireWebhookEvent(ownerEmail, 'angry_message', {
        channel, senderId, senderName,
        messagePreview: messageText.slice(0, 300),
      });
    }

    // Auto-schedule personalised follow-up email for HOT leads with email captured.
    // Fires 3 minutes later so the conversation has a chance to continue naturally
    // first. Owner-opt-outable via profile.config.outbound.leadFollowup = false.
    if (leadScore === 'hot' && reply.contact?.email) {
      try {
        scheduleTask({
          type: 'lead_followup',
          dueAt: Date.now() + 3 * 60 * 1000,
          ownerEmail,
          payload: {
            leadEmail: reply.contact.email,
            leadName: reply.contact.name || senderName,
            channel, leadScore,
            lastMessage: messageText.slice(0, 300),
          },
        });
        console.log(`📨 [${channel}] Lead followup scheduled for ${reply.contact.email} (T+3min)`);
      } catch (e) { console.warn('[outbound] schedule lead_followup failed:', e.message); }
    }
  } catch (e) { console.warn('[channel-lead] scoring failed:', e.message); }

  // Knowledge gap detection — if Aria's reply fell back to vague language
  // OR she explicitly said outOfScope, log the question so the owner can
  // train her on it later. Clusters of similar gaps trigger auto-draft.
  try {
    const fellBack = GAP_FALLBACK_RE.test(reply.text || '');
    if (fellBack || reply.outOfScope) {
      appendChannelGap({
        ts: new Date().toISOString(),
        ownerEmail, channel, senderId,
        question: messageText.slice(0, 500),
        ariaReply: (reply.text || '').slice(0, 300),
        reason: reply.outOfScope ? 'out-of-scope' : 'low-confidence-fallback',
      });
      console.log(`🕳️ [${channel}] Gap logged: "${messageText.slice(0, 60)}..."`);
    }
  } catch (e) { console.warn('[channel-gap] log failed:', e.message); }

  // CSAT trigger — when the customer's CURRENT message contains closure
  // language and we have at least 2 exchanges deep + haven't asked CSAT
  // recently. Fire as a follow-up message with Quick Reply buttons.
  if (CLOSURE_RE.test(messageText) && history.length >= 3 && !convState?.csatPending) {
    const lastCsatTime = convState?.lastCsatAt ? new Date(convState.lastCsatAt).getTime() : 0;
    const cooldownMs = 7 * 24 * 60 * 60 * 1000; // don't re-prompt same conv within a week
    if (Date.now() - lastCsatTime > cooldownMs) {
      // Wait ~3s so it lands AFTER Aria's main reply (most channels render in arrival order)
      setTimeout(async () => {
        try {
          await sendChannelReply(channel, ownerChannels[channel], senderId, 'Quick one — did that help?', ['👍 Yes', '👎 Not really']);
          const st = conversationState.get(memKey) || {};
          st.csatPending = true;
          st.lastCsatAt = new Date().toISOString();
          conversationState.set(memKey, st);
          persistConversationState();
          console.log(`⭐ [${channel}] CSAT prompt sent to ${senderName}`);
        } catch (e) { console.warn('CSAT prompt failed:', e.message); }
      }, 3000);
    }
  }

  // Slot-filled booking pipeline. Merge any new booking fields into the
  // running pendingBooking state. Only push to the real bookings[] when the
  // CRITICAL slots are filled (name + contact + datetime) — otherwise keep
  // collecting via subsequent messages.
  if (reply.booking || reply.contact?.name || reply.contact?.email || reply.contact?.phone) {
    const prev = (conversationState.get(memKey)?.pendingBooking) || {};
    const merged = {
      ...prev,
      ...(reply.booking || {}),
      name: reply.booking?.name || reply.contact?.name || prev.name || null,
      contact: reply.contact?.email || reply.contact?.phone || prev.contact || null,
      service: reply.booking?.notes || reply.booking?.service || prev.service || null,
      datetime: reply.booking?.datetime || prev.datetime || null,
    };
    const ready = merged.name && merged.contact && merged.datetime;
    if (ready) {
      // CONFLICT GATE — never confirm a slot that overlaps another booking for
      // this owner. Without this, Aria happily says yes to 2pm even when 2pm
      // is already taken — the single biggest production own-goal she could
      // make. Owners only get one chance with a customer; double-booking
      // erodes trust faster than any clever feature builds it.
      const ownerBookings = bookings.filter(b => b.ownerEmail === ownerEmail);
      const conflicts = findBookingConflicts({
        newDatetime: merged.datetime,
        durationMin: 60, // MVP default — extend per-owner via dashboard later
        existing:    ownerBookings,
        bufferMin:   0,  // SMB default: back-to-back is fine
      });

      if (conflicts.length > 0) {
        // Keep the pending booking so the customer can propose another slot
        // in their next message — we don't drop the captured name/contact.
        const st = conversationState.get(memKey) || {};
        st.pendingBooking = { ...merged, datetime: null }; // clear bad slot, keep rest
        conversationState.set(memKey, st);
        persistConversationState();

        const conflictPhrase = describeConflictsForCustomer(conflicts) || 'that slot is taken';
        const altReply = `Ah — ${conflictPhrase}. Could you suggest another time that works for you?`;
        try {
          await sendChannelReply(channel, channelConfig, senderId, altReply, ['Earlier same day', 'Later same day', 'Different day']);
        } catch (e) { console.warn('[booking-conflict] alt reply send failed:', e.message); }

        // Log to channel message history so dashboard reflects the deflection
        const msgs = channelMessages.get(ownerEmail) || [];
        msgs.push({
          id: crypto.randomUUID(), channel, senderId, senderName,
          message: messageText, reply: altReply,
          timestamp: new Date().toISOString(),
          status: 'conflict-blocked',
        });
        channelMessages.set(ownerEmail, msgs);
        persistChannelMessages();

        console.log(`⚠️  [booking-conflict] Blocked double-book for ${ownerEmail} at ${merged.datetime} (${conflicts.length} conflict(s))`);
        // FYI to owner (batched into digest when digest mode is on)
        await notify({
          ownerEmail, type: 'booking_conflict_blocked',
          subject: `⚠️ Aria averted a double-book`,
          html: `<p>${senderName} tried to book ${merged.datetime} but you already have a booking at that time. Aria deflected + asked for an alternative slot.</p>`,
          summary: `${senderName} → ${merged.datetime} (slot taken)`,
        });
        // Done — return early so we don't push or fire confirmation
        return;
      }

      const bookingRecord = { ...merged, channel, ownerEmail, ts: new Date().toISOString(), durationMin: 60 };
      bookings.push(bookingRecord);
      save('bookings', bookings);
      // Clear pending now that it's a real booking.
      const st = conversationState.get(memKey) || {};
      delete st.pendingBooking;
      conversationState.set(memKey, st);
      persistConversationState();
      console.log(`📅 [${channel}] Booking ready + saved for ${senderName}: ${merged.name} / ${merged.datetime}`);
      // Fire webhook event so connected CRMs / Zapier / Slack know about it
      fireWebhookEvent(ownerEmail, 'new_booking', {
        channel, senderId, senderName,
        booking: merged,
      });
      // FIRE the confirmation flow — ICS email to owner + customer + channel reply
      // Done in a setImmediate so the current message handler returns fast.
      setImmediate(async () => {
        try {
          const confirmation = await confirmAndShipBooking({
            ownerEmail, channel, channelConfig, senderId, senderName,
            bookingData: merged,
          });
          // Stash ics filename on the booking record so dashboard can re-download
          if (confirmation.icsFilename) {
            bookingRecord.icsFilename = confirmation.icsFilename;
            save('bookings', bookings);
          }
        } catch (e) { console.warn('[booking] confirmation flow failed:', e.message); }
      });
    } else {
      const st = conversationState.get(memKey) || {};
      st.pendingBooking = merged;
      conversationState.set(memKey, st);
      persistConversationState();
      console.log(`📋 [${channel}] Booking slot update for ${senderName}: ${JSON.stringify(merged)}`);
    }
  }

  console.log(`📱 [${channel}] Replied to ${senderName}: "${reply.text.substring(0, 60)}..."`);
}

// ─── Channel Approval ────────────────────────────────────────────────────────
app.get('/api/channel/approve', async (req, res) => {
  const { id } = req.query;
  const approval = channelApprovals.get(id);
  if (!approval) {
    return res.send('<html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>Expired or already handled</h2></body></html>');
  }

  const { ownerEmail, channel, senderId, draftReply, booking, suggestedReplies } = approval;
  const ownerChannels = channelConfigs.get(ownerEmail);
  const channelConfig = ownerChannels?.[channel];

  if (!channelConfig) {
    return res.send('<html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>Channel no longer connected</h2></body></html>');
  }

  const sent = await sendChannelReply(channel, channelConfig, senderId, draftReply, suggestedReplies);

  channelApprovals.delete(id);
  persistChannelApprovals();

  if (sent) {
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

// ─── Quote approval endpoints ───────────────────────────────────────────
// Three endpoints mirror the channel-approval pattern but for AI-drafted
// price quotes. Owner clicks email button → quote is formatted + sent to
// customer via the original channel (with optional email copy if we have
// their address).

function renderQuoteMessageText(draft, businessName) {
  const lines = draft.lineItems.map(li =>
    `• ${li.label}${li.qty > 1 ? ` (×${li.qty})` : ''} — ${draft.currency}${(li.price * li.qty).toFixed(2)}`
  ).join('\n');
  return `Here's a quote from ${businessName}:\n\n${lines}\n\nTotal: ${draft.currency}${draft.subtotal.toFixed(2)}\n\n${draft.caveat ? draft.caveat + '\n\n' : ''}Valid for ${draft.validityDays} days. Let me know if you'd like to go ahead and I'll book you in 👇`;
}

// SEND — accept the draft as-is, fire to customer on their original channel
app.get('/api/quotes/approve', async (req, res) => {
  const { id } = req.query;
  const pending = pendingQuotes.get(id);
  if (!pending) {
    return res.send('<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#0d0d1f;color:#eee;"><h2>Quote expired or already handled</h2><p style="color:#9898b8;">You can close this tab.</p></body></html>');
  }
  const { ownerEmail, channel, senderId, senderName, draft } = pending;
  const ownerChannels = channelConfigs.get(ownerEmail);
  const channelConfig = ownerChannels?.[channel];
  if (!channelConfig) {
    return res.send('<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#0d0d1f;color:#eee;"><h2>Channel no longer connected</h2></body></html>');
  }
  const profile = getOwnerProfile(ownerEmail);
  const businessName = profile?.profile?.businessName || profile?.businessName || 'us';
  const messageText = renderQuoteMessageText(draft, businessName);

  let sent = false;
  try {
    sent = await sendChannelReply(channel, channelConfig, senderId, messageText, ['Book me in', 'Got questions', 'Not right now']);
  } catch (e) { console.warn('[quote-approve] channel send failed:', e.message); }

  if (sent) {
    // Log to channelMessages so dashboard reflects the sent quote
    const msgs = channelMessages.get(ownerEmail) || [];
    msgs.push({
      id: crypto.randomUUID(), channel, senderId, senderName,
      message: pending.originalQuestion, reply: messageText,
      timestamp: new Date().toISOString(),
      status: 'quote-sent',
      meta: { quoteSubtotal: draft.subtotal, quoteCurrency: draft.currency },
    });
    channelMessages.set(ownerEmail, msgs);
    persistChannelMessages();
  }

  appendQuoteLedger({
    ts: new Date().toISOString(), event: 'sent',
    quoteId: id, ownerEmail, channel, senderId, senderName,
    subtotal: draft.subtotal, currency: draft.currency,
    items: draft.lineItems.length,
  });
  fireWebhookEvent(ownerEmail, 'quote_sent', {
    quoteId: id, channel, senderId, senderName,
    subtotal: draft.subtotal, currency: draft.currency,
  });

  pendingQuotes.delete(id);
  persistPendingQuotes();
  res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#0d0d1f;color:#eee;">
    <h2 style="color:#00e5a0;">✓ Quote sent to ${escapeHtml(senderName)}</h2>
    <p style="color:#9898b8;">Total: ${draft.currency}${draft.subtotal.toFixed(2)}. You can close this tab.</p>
  </body></html>`);
});

// EDIT — render a simple form pre-populated with the draft, owner edits + submits
app.get('/api/quotes/edit', (req, res) => {
  const { id } = req.query;
  const pending = pendingQuotes.get(id);
  if (!pending) {
    return res.send('<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#0d0d1f;color:#eee;"><h2>Quote expired or already handled</h2></body></html>');
  }
  const { senderName, draft } = pending;
  const itemRows = draft.lineItems.map((li, i) => `
    <div style="display:flex;gap:8px;margin-bottom:8px;">
      <input name="label_${i}" value="${escapeHtml(li.label)}" placeholder="Line item" style="flex:2;padding:8px;border:1px solid #444;background:#1a1a2e;color:#eee;border-radius:6px;">
      <input name="qty_${i}" type="number" min="1" value="${li.qty}" style="width:60px;padding:8px;border:1px solid #444;background:#1a1a2e;color:#eee;border-radius:6px;">
      <input name="price_${i}" type="number" step="0.01" min="0" value="${li.price.toFixed(2)}" style="width:100px;padding:8px;border:1px solid #444;background:#1a1a2e;color:#eee;border-radius:6px;">
    </div>`).join('');

  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Edit quote</title></head>
  <body style="font-family:-apple-system,sans-serif;background:#0d0d1f;color:#eee;padding:30px;max-width:600px;margin:0 auto;">
    <h2 style="color:#9d96ff;">Edit quote for ${escapeHtml(senderName)}</h2>
    <form method="POST" action="/api/quotes/edit?id=${id}">
      <div style="margin-bottom:14px;font-size:12px;color:#8888aa;">Line items (label · qty · ${escapeHtml(draft.currency)} unit price)</div>
      ${itemRows}
      <label style="display:block;margin:14px 0 4px;font-size:12px;color:#9898b8;">Caveat / disclaimer</label>
      <textarea name="caveat" rows="2" style="width:100%;padding:8px;border:1px solid #444;background:#1a1a2e;color:#eee;border-radius:6px;font-family:inherit;">${escapeHtml(draft.caveat)}</textarea>
      <label style="display:block;margin:14px 0 4px;font-size:12px;color:#9898b8;">Valid for (days)</label>
      <input name="validityDays" type="number" min="1" max="365" value="${draft.validityDays}" style="width:100px;padding:8px;border:1px solid #444;background:#1a1a2e;color:#eee;border-radius:6px;">
      <div style="margin-top:24px;display:flex;gap:8px;">
        <button type="submit" style="background:#00e5a0;color:#0d0d1f;border:none;border-radius:8px;padding:11px 18px;font-weight:600;cursor:pointer;font-family:inherit;font-size:13px;">✓ Send edited quote</button>
        <a href="/api/quotes/reject?id=${id}" style="background:#ff6b6b;color:#fff;border:none;border-radius:8px;padding:11px 18px;font-weight:600;text-decoration:none;font-family:inherit;font-size:13px;display:inline-block;">✗ Reject</a>
      </div>
    </form>
  </body></html>`);
});

app.post('/api/quotes/edit', express.urlencoded({ extended: true, limit: '32kb' }), async (req, res) => {
  const { id } = req.query;
  const pending = pendingQuotes.get(id);
  if (!pending) {
    return res.send('<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#0d0d1f;color:#eee;"><h2>Quote expired</h2></body></html>');
  }
  // Rebuild line items from form fields
  const newItems = [];
  for (let i = 0; i < 8; i++) {
    const label = (req.body[`label_${i}`] || '').trim();
    if (!label) continue;
    newItems.push({
      label,
      qty:   Math.max(1, Number(req.body[`qty_${i}`]) || 1),
      price: Math.max(0, Number(req.body[`price_${i}`]) || 0),
      notes: null,
    });
  }
  if (newItems.length === 0) {
    return res.send('<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#0d0d1f;color:#eee;"><h2>Need at least one line item</h2><a href="/api/quotes/edit?id=' + id + '" style="color:#00e5a0;">Back to edit</a></body></html>');
  }
  pending.draft.lineItems    = newItems;
  pending.draft.subtotal     = newItems.reduce((s, li) => s + li.price * li.qty, 0);
  pending.draft.caveat       = String(req.body.caveat || pending.draft.caveat).slice(0, 300);
  pending.draft.validityDays = Math.max(1, Math.min(365, Number(req.body.validityDays) || 30));
  pendingQuotes.set(id, pending);
  persistPendingQuotes();

  // Redirect through approve to actually send (DRY — single send path)
  res.redirect(`/api/quotes/approve?id=${id}`);
});

app.get('/api/quotes/reject', (req, res) => {
  const { id } = req.query;
  const pending = pendingQuotes.get(id);
  if (pending) {
    appendQuoteLedger({
      ts: new Date().toISOString(), event: 'rejected',
      quoteId: id, ownerEmail: pending.ownerEmail, channel: pending.channel,
      senderId: pending.senderId, senderName: pending.senderName,
      subtotal: pending.draft.subtotal, currency: pending.draft.currency,
    });
  }
  pendingQuotes.delete(id);
  persistPendingQuotes();
  res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#0d0d1f;color:#eee;">
    <h2 style="color:#ff6b6b;">✗ Quote rejected</h2>
    <p style="color:#9898b8;">Nothing sent. Customer is waiting for you to reply on the channel directly.</p>
  </body></html>`);
});

// ─── Voice receptionist (Vapi) webhook ──────────────────────────────────
// ONE endpoint, four event types. Vapi posts raw JSON (express.raw is set
// for this path so we can HMAC-verify), then we parse + switch on
// message.type. See lib/vapi_handler.js for the multi-tenant design notes.
app.post('/api/vapi/webhook', async (req, res) => {
  // req.body is a Buffer (express.raw). Verify signature over the raw bytes.
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body || {});
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (!verifyVapiSignature(raw, req.headers['x-vapi-signature'], secret)) {
    console.warn('[voice] webhook signature verification failed');
    return res.status(401).json({ error: 'bad signature' });
  }
  if (!secret) console.warn('[voice] VAPI_WEBHOOK_SECRET not set — accepting unverified webhook (dev mode)');

  let payload;
  try { payload = JSON.parse(raw); } catch { return res.status(400).json({ error: 'bad json' }); }
  const message = payload.message || payload;
  const type = message.type;

  try {
    // ── 1. assistant-request — Vapi asks which assistant answers this call.
    //    Resolve owner by the dialed number, build their assistant fresh.
    if (type === 'assistant-request') {
      const dialed = normalisePhone(message.call?.phoneNumber?.number || message.phoneNumber?.number || '');
      const ownerEmail = voiceNumberIndex.get(dialed);
      if (!ownerEmail || voiceConfig.get(ownerEmail)?.enabled === false) {
        // No tenant for this number (or disabled) — let Vapi play a default.
        return res.json({ error: 'This number is not currently configured for voice answering.' });
      }
      // PLAN GATE (backstop) — even if a number is somehow configured for a
      // Lite owner, refuse to answer. Stops voice minutes billing on an
      // account that isn't paying for the receptionist tier.
      if (!canUseVoice(ownerEmail)) {
        console.warn(`📞 [voice] assistant-request refused — ${ownerEmail} not on receptionist plan`);
        return res.json({ error: 'Voice answering is not enabled on this plan.' });
      }
      // SCHEDULE GATE — owner may set Aria to answer only out-of-hours, only
      // during business hours, or 24/7. When she's off-schedule, transfer the
      // call to the owner's fallback number (so a human can pick up); if no
      // fallback is set, decline so Vapi plays its default + the caller can
      // try later / leave voicemail via their carrier.
      {
        const sc = voiceConfig.get(ownerEmail) || {};
        if (!voiceShouldAnswer(sc)) {
          if (sc.fallbackNumber) {
            console.log(`📞 [voice] off-schedule for ${ownerEmail} → transfer to ${sc.fallbackNumber}`);
            return res.json({ destination: { type: 'number', number: normalisePhone(sc.fallbackNumber) } });
          }
          console.log(`📞 [voice] off-schedule for ${ownerEmail}, no fallback → declining`);
          return res.json({ error: 'Outside answering hours.' });
        }
      }
      const profile = getOwnerProfile(ownerEmail)?.profile || {};
      const knowledge = knowledgeDocs.get(ownerEmail) || [];
      const cfg = voiceConfig.get(ownerEmail) || {};
      const serverUrl = appBaseUrl(req);
      const assistant = buildAssistantConfig({
        ownerEmail, profile, knowledge, serverUrl,
        opts: { voiceId: cfg.voiceId, firstMessage: cfg.firstMessage, maxDurationSec: cfg.maxDurationSec },
      });
      console.log(`📞 [voice] assistant-request for ${ownerEmail} on ${dialed}`);
      return res.json({ assistant });
    }

    // ── 2. tool-calls — mid-call function call (check_availability).
    if (type === 'tool-calls' || type === 'function-call') {
      const tool = extractToolCall(message);
      const ownerEmail = message.call?.metadata?.ownerEmail || message.assistant?.metadata?.ownerEmail;
      if (tool?.name === 'check_availability') {
        const parsed = parseBookingDateTime(tool.args.datetime);
        let resultText;
        if (!parsed) {
          resultText = `I couldn't pin down that exact time — could you say the day and time again?`;
        } else {
          const ownerBookings = bookings.filter(b => b.ownerEmail === ownerEmail);
          const conflicts = findBookingConflicts({ newDatetime: tool.args.datetime, durationMin: 60, existing: ownerBookings, bufferMin: 0 });
          resultText = conflicts.length === 0
            ? `That time is free. Confirm with the caller and let them know you'll text a confirmation shortly.`
            : `That slot is already taken. Offer the caller a nearby alternative (e.g. an hour earlier or later, or the next day).`;
        }
        // Vapi expects { results: [{ toolCallId, result }] } (or legacy { result })
        const body = tool.id
          ? { results: [{ toolCallId: tool.id, result: resultText }] }
          : { result: resultText };
        return res.json(body);
      }
      return res.json({ result: 'OK' });
    }

    // ── 3. status-update — call lifecycle. Log but no action needed.
    if (type === 'status-update') {
      return res.json({ ok: true });
    }

    // ── 4. end-of-call-report — the payoff. Persist + run pipelines.
    if (type === 'end-of-call-report') {
      const report = extractCallReport(message);
      const ownerEmail = report.ownerEmail || voiceNumberIndex.get(normalisePhone(report.dialedNumber || ''));
      if (!ownerEmail) { console.warn('[voice] end-of-call-report with no resolvable owner'); return res.json({ ok: true }); }

      // Persist the call (append-only — Rule 13)
      appendPhoneCallLedger({
        ts: new Date().toISOString(),
        ownerEmail,
        callId: report.callId,
        customerNumber: report.customerNumber,
        durationSec: report.durationSec,
        endedReason: report.endedReason,
        intent: report.structured?.intent || 'other',
        summary: report.structured?.summary || report.summary || '',
        structured: report.structured || {},
        transcript: String(report.transcript || '').slice(0, 20000),
        recordingUrl: report.recordingUrl,
      });

      // Fire the rest async so we return 200 to Vapi fast.
      setImmediate(() => handleVoiceCallOutcome({ ownerEmail, report }).catch(e => console.error('[voice] outcome handler failed:', e.message)));

      console.log(`📞 [voice] call ended for ${ownerEmail} — intent=${report.structured?.intent || '?'} dur=${report.durationSec}s`);
      return res.json({ ok: true });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('[voice] webhook handler error:', e.message);
    return res.status(200).json({ ok: false }); // 200 so Vapi doesn't retry-storm
  }
});

// Post-call fan-out: booking pipeline, owner notification, customer SMS/WA.
async function handleVoiceCallOutcome({ ownerEmail, report }) {
  const s = report.structured || {};
  const profile = getOwnerProfile(ownerEmail);
  const businessName = profile?.profile?.businessName || profile?.businessName || 'your business';
  const customerNumber = report.customerNumber;
  const callerName = s.callerName || 'Caller';

  // 1. BOOKING — route through the SAME pipeline as a DM booking so conflict
  //    detection, ICS, reminders, and review-requests all work for free.
  let bookingResult = null;
  if (s.intent === 'booking' && s.booking?.datetime) {
    const ownerBookings = bookings.filter(b => b.ownerEmail === ownerEmail);
    const conflicts = findBookingConflicts({ newDatetime: s.booking.datetime, durationMin: 60, existing: ownerBookings, bufferMin: 0 });
    if (conflicts.length === 0) {
      const bookingRecord = {
        name: callerName, contact: customerNumber, service: s.booking.service || null,
        datetime: s.booking.datetime, notes: s.booking.notes || null,
        channel: 'phone', ownerEmail, ts: new Date().toISOString(), durationMin: 60, source: 'voice',
      };
      bookings.push(bookingRecord);
      save('bookings', bookings);
      fireWebhookEvent(ownerEmail, 'new_booking', { channel: 'phone', senderName: callerName, booking: bookingRecord });
      try {
        await confirmAndShipBooking({
          ownerEmail, channel: 'phone', channelConfig: null,
          senderId: customerNumber, senderName: callerName,
          bookingData: { name: callerName, contact: customerNumber, service: s.booking.service, datetime: s.booking.datetime, notes: s.booking.notes },
        });
      } catch (e) { console.warn('[voice] confirmAndShipBooking failed:', e.message); }
      bookingResult = 'booked';
    } else {
      bookingResult = 'conflict';
    }
  }

  // 2. CUSTOMER FOLLOW-UP via WhatsApp (if owner has WA connected + we have
  //    the caller's number). Phone callers love a written confirmation.
  const waConfig = channelConfigs.get(ownerEmail)?.whatsapp;
  if (waConfig?.accessToken && customerNumber) {
    let followText = null;
    if (bookingResult === 'booked') {
      followText = `Hi ${callerName}, thanks for calling ${businessName}! Confirming your booking${s.booking?.service ? ' for ' + s.booking.service : ''} on ${s.booking?.datetime}. Reply here if you need to change anything. 👋`;
    } else if (s.intent === 'quote' && s.quoteRequest) {
      followText = `Hi ${callerName}, thanks for calling ${businessName}! We'll get a quote together for ${s.quoteRequest} and text it over shortly.`;
    } else if (bookingResult === 'conflict') {
      followText = `Hi ${callerName}, thanks for calling ${businessName}! That time's just been taken — reply here with another time that suits and we'll lock it in.`;
    }
    if (followText) {
      try { await sendWhatsAppMessage(waConfig, customerNumber, followText); }
      catch (e) { console.warn('[voice] customer WA follow-up failed:', e.message); }
    }
  }

  // 3. OWNER notification — digest-aware. Calls are informational unless
  //    the caller needs a callback / left a complaint (then immediate).
  const urgent = s.intent === 'complaint' || s.followUpNeeded === true;
  const intentEmoji = { booking: '📅', quote: '💷', enquiry: '💬', complaint: '⚠️', message: '✉️', other: '📞' }[s.intent] || '📞';
  const html = `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:20px;">
    <div style="background:#0d0d1f;color:#fff;padding:16px;border-radius:12px;">
      <h2 style="margin:0 0 4px;color:#00e5a0;">${intentEmoji} Phone call handled by Aria</h2>
      <p style="margin:0;color:#9898b8;font-size:13px;">${callerName}${customerNumber ? ' · ' + escapeHtml(customerNumber) : ''} · ${report.durationSec || '?'}s</p>
    </div>
    <div style="background:#fff;color:#222;padding:18px;border-radius:12px;margin-top:12px;border:1px solid #eee;">
      <p style="margin:0 0 10px;font-weight:600;">${escapeHtml(s.summary || report.summary || 'Call completed')}</p>
      ${s.booking?.datetime ? `<p style="margin:0 0 6px;"><b>Booking:</b> ${escapeHtml(s.booking.service || 'appointment')} — ${escapeHtml(s.booking.datetime)} ${bookingResult === 'booked' ? '✅ confirmed' : bookingResult === 'conflict' ? '⚠️ clashed, customer asked to rebook' : ''}</p>` : ''}
      ${s.quoteRequest ? `<p style="margin:0 0 6px;"><b>Quote wanted:</b> ${escapeHtml(s.quoteRequest)}</p>` : ''}
      ${s.message ? `<p style="margin:0 0 6px;"><b>Message:</b> ${escapeHtml(s.message)}</p>` : ''}
      ${s.callbackNumber ? `<p style="margin:0 0 6px;"><b>Callback:</b> ${escapeHtml(s.callbackNumber)}</p>` : ''}
      ${report.recordingUrl ? `<p style="margin:12px 0 0;"><a href="${report.recordingUrl}" style="color:#00a070;">▶ Listen to recording</a></p>` : ''}
    </div>
  </div>`;
  await notify({
    ownerEmail, type: 'phone_call',
    subject: `${intentEmoji} Aria handled a call — ${escapeHtml(s.summary || callerName)}`,
    html,
    summary: `${callerName} · ${s.intent || 'call'} · ${s.summary || ''}`.slice(0, 200),
    urgency: urgent ? 'immediate' : undefined,
  });
}

// ─── Voice dashboard endpoints ──────────────────────────────────────────
app.get('/api/dashboard/phone/settings', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const cfg = voiceConfig.get(owner) || {};
  const allowed = canUseVoice(owner);
  res.json({
    planAllowed: allowed,           // false → dashboard shows upsell, hides controls
    plan: getOwnerPlan(owner),
    settings: {
      enabled: !!cfg.enabled,
      phoneNumber: cfg.phoneNumber || '',
      voiceId: cfg.voiceId || 'paula',
      firstMessage: cfg.firstMessage || '',
      provisioned: !!cfg.vapiNumberId, // true = we bought it (vs BYO paste)
      answerMode: cfg.answerMode || 'always', // always | business_hours | out_of_hours
      businessHours: cfg.businessHours || { mon: '9-17', tue: '9-17', wed: '9-17', thu: '9-17', fri: '9-17', sat: 'closed', sun: 'closed' },
      timezone: cfg.timezone || 'Europe/London',
      fallbackNumber: cfg.fallbackNumber || '',
    },
    canProvision: allowed && !!process.env.VAPI_API_KEY, // one-click available?
    webhookUrl: `${appBaseUrl(req)}/api/vapi/webhook`,
  });
});

app.post('/api/dashboard/phone/settings', express.json({ limit: '8kb' }), (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  if (!canUseVoice(owner)) return res.status(403).json({ error: 'Voice receptionist requires the Receptionist plan.' });
  // Merge, don't replace — a provisioned number stores vapiNumberId +
  // phoneNumber that the settings form doesn't send back. Overwriting the
  // whole object on a greeting-only save would orphan the number (still
  // billing on Vapi, but unreachable from our index).
  const existing = voiceConfig.get(owner) || {};
  const { enabled, phoneNumber, voiceId, firstMessage, answerMode, businessHours, timezone, fallbackNumber } = req.body || {};
  const merged = { ...existing };
  if (enabled !== undefined)      merged.enabled = !!enabled;
  // Only let the form set phoneNumber when this ISN'T a provisioned number
  // (provisioned numbers are managed by provision/release, not the form).
  if (phoneNumber !== undefined && !existing.vapiNumberId) merged.phoneNumber = String(phoneNumber).trim().slice(0, 24);
  if (voiceId !== undefined)      merged.voiceId = String(voiceId).slice(0, 40);
  if (firstMessage !== undefined) merged.firstMessage = String(firstMessage).slice(0, 300);
  // Schedule fields
  if (answerMode !== undefined)   merged.answerMode = ['always', 'business_hours', 'out_of_hours'].includes(answerMode) ? answerMode : 'always';
  if (timezone !== undefined)     merged.timezone = String(timezone).slice(0, 60) || 'Europe/London';
  if (fallbackNumber !== undefined) merged.fallbackNumber = String(fallbackNumber).trim().slice(0, 24);
  if (businessHours !== undefined && businessHours && typeof businessHours === 'object') {
    // Whitelist the 7 day keys; each value a short range string.
    const clean = {};
    for (const k of ['mon','tue','wed','thu','fri','sat','sun']) {
      if (businessHours[k] !== undefined) clean[k] = String(businessHours[k]).slice(0, 16);
    }
    merged.businessHours = { ...(existing.businessHours || {}), ...clean };
  }
  voiceConfig.set(owner, merged);
  persistVoiceConfig();
  res.json({ ok: true, settings: merged });
});

// POST /api/dashboard/phone/provision — one-click "Get my Aria number".
// Buys a Vapi-native number on AireyAI's account, points it at our webhook
// (no assistantId → per-call assistant-request → multi-tenant), stores it.
//
// GUARDS (this spends real money — ~£1.20/mo per number on our Vapi acct):
//   - one number per owner (refuses if they already have one)
//   - requires VAPI_API_KEY (else returns a clean "not available yet")
//   - the client clicking the button IS the two-stage approval (Rule 12)
app.post('/api/dashboard/phone/provision', express.json({ limit: '4kb' }), async (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  if (!canUseVoice(owner)) return res.status(403).json({ error: 'Voice receptionist requires the Receptionist plan. Upgrade to add a phone number.' });
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Phone provisioning is not enabled yet — contact support.' });

  const existing = voiceConfig.get(owner);
  if (existing?.phoneNumber && existing?.vapiNumberId) {
    return res.status(409).json({ error: 'You already have a number. Release it first to get a new one.', number: existing.phoneNumber });
  }

  try {
    const profile = getOwnerProfile(owner)?.profile || {};
    const { areaCode } = req.body || {};
    const { id, number } = await provisionVapiNumber({
      apiKey,
      serverUrl: appBaseUrl(req),
      secret: process.env.VAPI_WEBHOOK_SECRET,
      name: `Aria — ${profile.businessName || owner}`,
      areaCode: areaCode || null,
    });
    voiceConfig.set(owner, {
      ...(existing || {}),
      enabled: true,
      phoneNumber: number,
      vapiNumberId: id,
      voiceId: existing?.voiceId || 'paula',
      firstMessage: existing?.firstMessage || '',
      provisionedAt: new Date().toISOString(),
    });
    persistVoiceConfig();
    console.log(`📞 [voice] provisioned ${number} (${id}) for ${owner}`);
    res.json({ ok: true, number, vapiNumberId: id });
  } catch (e) {
    console.error('[voice] provision failed:', e.message);
    res.status(502).json({ error: 'Could not provision a number right now. ' + e.message });
  }
});

// POST /api/dashboard/phone/release — give the number back, stop the charge.
app.post('/api/dashboard/phone/release', express.json({ limit: '2kb' }), async (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const cfg = voiceConfig.get(owner);
  if (!cfg?.vapiNumberId) return res.status(404).json({ error: 'No provisioned number to release.' });
  await releaseVapiNumber({ apiKey: process.env.VAPI_API_KEY, id: cfg.vapiNumberId });
  voiceConfig.set(owner, { ...cfg, enabled: false, phoneNumber: '', vapiNumberId: null });
  persistVoiceConfig();
  console.log(`📞 [voice] released number for ${owner}`);
  res.json({ ok: true });
});

// Recent calls panel — reads the append-only ledger, newest first.
app.get('/api/dashboard/calls', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const out = [];
  try {
    if (existsSync(PHONE_CALLS_LEDGER)) {
      const lines = readFileSync(PHONE_CALLS_LEDGER, 'utf8').split('\n').filter(Boolean).slice(-500);
      for (let i = lines.length - 1; i >= 0 && out.length < 40; i--) {
        try {
          const e = JSON.parse(lines[i]);
          if (e.ownerEmail !== owner) continue;
          out.push({
            ts: e.ts, intent: e.intent, summary: e.summary,
            customerNumber: e.customerNumber, durationSec: e.durationSec,
            recordingUrl: e.recordingUrl,
            booking: e.structured?.booking || null,
          });
        } catch {}
      }
    }
  } catch {}
  res.json({ calls: out });
});

// Note: legacy /auth/meta/start + duplicate /auth/meta/callback removed
// 2026-05-24. Dashboard now routes through /connect/meta (config_id flow).
// The duplicate callback was dead code — Express resolves the earlier
// declaration first.

// ─── Outbound Scheduler — lead follow-ups, booking reminders, recovery ──
//
// Three task types share one cron loop:
//   - lead_followup  (fires ~3 min after a hot lead with email captured)
//   - booking_reminder (fires 24h before a confirmed booking)
//   - conv_recovery   (fires 24h after a 3+ exchange conv goes quiet)
//
// All persisted to data/outbound_tasks.jsonl (append-only). Server restart
// replays pending tasks. Per Rule 12: each task is an explicit OUTBOUND
// message — owners can disable per task type via profile.config.outbound.

registerTaskHandler('lead_followup', async (task) => {
  const { ownerEmail, payload } = task;
  const { leadEmail, leadName, channel, leadScore, lastMessage } = payload;
  if (!leadEmail) return false;
  const profile = getOwnerProfile(ownerEmail);
  // Per-owner opt-out
  if (profile?.config?.outbound?.leadFollowup === false) return false;
  if (profile?.profile?.outbound?.leadFollowup === false) return false;
  const businessName = profile?.profile?.businessName || profile?.businessName || 'our team';
  const businessPhone = profile?.profile?.phone || '';
  const businessEmail = profile?.profile?.email || ownerEmail;
  // Generate follow-up content via Claude (warm, short, value-add — not pushy)
  let bodyText = '';
  try {
    const r = await callClaudeWithFallback({
      max_tokens: 400,
      messages: [{ role: 'user', content: `Write a SHORT (under 120 words) friendly follow-up email from a small business to a customer who just messaged via ${channel}. The customer is a hot lead — they were asking about a service.

Business: ${businessName}
Customer name: ${leadName || 'there'}
What the customer said: "${lastMessage || '(no preview)'}"
Contact details for the business: ${businessPhone || businessEmail}

Write ONLY the email body (no subject, no greeting "Subject:", no signature block — just the message text). Be warm + concise. Acknowledge their question. Offer a clear next step (book a call, get a quote, visit, reply). End with the business name. Don't be pushy or salesy. Don't make up prices/availability.` }],
    });
    bodyText = (r.content[0]?.text || '').trim();
  } catch (e) {
    console.warn('[outbound] lead_followup body gen failed:', e.message);
    bodyText = `Hi ${leadName || 'there'},\n\nThanks for getting in touch via ${channel}. We saw your message and wanted to reach out personally — happy to help with what you're after.\n\nReply anytime, or give us a ring on ${businessPhone || 'the number on our website'}.\n\n${businessName}`;
  }
  try {
    await smartSend({
      ownerEmail, to: leadEmail,
      replyTo: businessEmail,
      subject: `Re: your ${channel} message — ${businessName}`,
      html: `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:20px;color:#222;line-height:1.6;font-size:14.5px;white-space:pre-line;">${bodyText.replace(/</g, '&lt;')}</div>`,
    });
    console.log(`📨 [outbound] lead_followup sent to ${leadEmail} for ${ownerEmail}`);
    return true;
  } catch (e) {
    console.warn('[outbound] lead_followup send failed:', e.message);
    return false;
  }
});

registerTaskHandler('booking_reminder', async (task) => {
  const { ownerEmail, payload } = task;
  const { channel, senderId, senderName, customerEmail, datetime, service } = payload;
  const profile = getOwnerProfile(ownerEmail);
  if (profile?.config?.outbound?.bookingReminder === false) return false;
  if (profile?.profile?.outbound?.bookingReminder === false) return false;
  const businessName = profile?.profile?.businessName || 'our team';
  const parsedDate = parseBookingDateTime(datetime);
  const dateLabel = parsedDate
    ? parsedDate.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : datetime;

  // Smart-reminder phrasing — ASK for confirmation, don't just announce.
  // "Still good for ..." with confirm/reschedule/cancel chips drives a 2-3×
  // higher response rate than the old one-way "looking forward to seeing you"
  // and unlocks the no-show prediction path.
  const msg = `👋 Quick check-in — you're booked with ${businessName}${service ? ' for ' + service : ''} tomorrow at ${dateLabel}. Still good for you?`;
  const chips = ['✓ Yes, confirmed', 'Reschedule', 'Cancel'];

  let channelSent = false;
  if (channel && senderId) {
    const channelConfig = channelConfigs.get(ownerEmail)?.[channel];
    if (channelConfig) {
      try {
        await sendChannelReply(channel, channelConfig, senderId, msg, chips);
        channelSent = true;
      } catch {}
    }
  }
  if (customerEmail) {
    try {
      await smartSend({
        ownerEmail, to: customerEmail,
        subject: `Confirming: ${businessName} — ${dateLabel}`,
        html: `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:20px;font-size:14.5px;line-height:1.6;color:#222;">
          <p>${msg}</p>
          <p style="margin-top:14px;font-size:13px;color:#666;">Just reply to this email or message us on ${channel} to confirm, reschedule, or cancel.</p>
        </div>`,
      });
    } catch {}
  }

  // Mark the conversation as "awaiting reminder response" so Aria's next
  // reply classification can route confirm/reschedule/cancel correctly.
  if (channel && senderId) {
    const memKey = `${ownerEmail}::${channel}::${senderId}`;
    const st = conversationState.get(memKey) || {};
    st.pendingReminder = {
      bookingDatetime: datetime,
      service:         service || null,
      sentAt:          new Date().toISOString(),
      channel,
    };
    conversationState.set(memKey, st);
    persistConversationState();
  }

  // Schedule a no-show check 2h before the appointment. If the customer
  // hasn't replied to the reminder by then, alert the owner so they can
  // call/double-book the slot. This is the "real assistant" delta.
  if (parsedDate) {
    const noshowAt = parsedDate.getTime() - 2 * 60 * 60 * 1000;
    if (noshowAt > Date.now() + 60_000) {
      try {
        scheduleTask({
          type: 'noshow_check',
          dueAt: noshowAt,
          ownerEmail,
          payload: { channel, senderId, senderName, customerEmail, datetime, service },
        });
      } catch (e) { console.warn('[booking_reminder] noshow_check schedule failed:', e.message); }
    }
  }

  console.log(`⏰ [outbound] smart booking_reminder sent to ${senderName} (${ownerEmail}) — chips=${channelSent ? 'yes' : 'email-only'}`);
  return true;
});

// No-show check — fires 2h before the appointment. If the customer hasn't
// responded to the reminder (pendingReminder still set on conversationState),
// alert the owner. Most no-shows are predictable from silence: this gives
// the owner ~2 hours to call, fill the slot, or rebook.
registerTaskHandler('noshow_check', async (task) => {
  const { ownerEmail, payload } = task;
  const { channel, senderId, senderName, customerEmail, datetime, service } = payload;
  if (!channel || !senderId) return false;
  const memKey = `${ownerEmail}::${channel}::${senderId}`;
  const st = conversationState.get(memKey) || {};
  if (!st.pendingReminder) {
    // Customer already responded — nothing to flag.
    console.log(`✓ [noshow_check] ${senderName} already confirmed/handled their ${datetime} booking`);
    return true;
  }
  // Customer went silent. Alert the owner.
  const profile = getOwnerProfile(ownerEmail);
  const businessName = profile?.profile?.businessName || 'your business';
  const parsedDate = parseBookingDateTime(datetime);
  const dateLabel = parsedDate
    ? parsedDate.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : datetime;

  try {
    await smartSend({
      ownerEmail, to: ownerEmail,
      subject: `⚠️ Likely no-show — ${senderName} (${dateLabel})`,
      html: `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:20px;font-size:14.5px;line-height:1.6;color:#222;">
        <div style="background:#fff3cd;border:1px solid #ffc107;padding:14px;border-radius:10px;margin-bottom:14px;">
          <b style="color:#856404;">⚠️ ${senderName} hasn't confirmed their ${dateLabel}${service ? ' ' + service : ''} booking</b>
        </div>
        <p>Aria sent a "still good?" reminder ${st.pendingReminder?.sentAt ? 'at ' + new Date(st.pendingReminder.sentAt).toLocaleString('en-GB') : 'earlier'} via ${channel} — no reply.</p>
        <p><b>Booking in 2 hours.</b> ${customerEmail ? 'Customer email: <a href="mailto:' + customerEmail + '">' + customerEmail + '</a>' : 'No customer email on file — try DM via ' + channel + '.'}</p>
        <p style="font-size:13px;color:#666;margin-top:16px;">This is the no-show prediction. Quick call now usually saves the slot.</p>
      </div>`,
    });
  } catch (e) { console.warn('[noshow_check] owner email failed:', e.message); }

  fireWebhookEvent(ownerEmail, 'noshow_predicted', {
    channel, senderId, senderName, customerEmail, datetime, service,
  });

  console.log(`🚨 [outbound] noshow_predicted for ${senderName} (${ownerEmail}) — ${dateLabel}`);
  return true;
});

// Review request — fires N hours after a confirmed booking. Asks the
// customer for a Google review (or whatever review URL the owner set).
// Opt-in: if owner hasn't configured reviewRequest.enabled + url, handler
// silently no-ops. Always-on by default once URL is set.
//
// Direct revenue lever: SMBs live or die by Google review count. A salon
// going from 12 → 60 reviews can double click-through-rate on Maps. This
// closes the loop on a chatbot that otherwise stops at "captured the lead".
const REVIEW_REQUESTS_LEDGER = resolve('data/review_requests.jsonl');
function appendReviewRequestLedger(entry) {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    appendFileSync(REVIEW_REQUESTS_LEDGER, JSON.stringify(entry) + '\n');
  } catch (e) { console.warn('[review_request] ledger append failed:', e.message); }
}

registerTaskHandler('review_request', async (task) => {
  const { ownerEmail, payload } = task;
  const { channel, senderId, senderName, customerName, customerEmail, service, datetime } = payload;

  const profile = getOwnerProfile(ownerEmail);
  const cfg     = profile?.profile?.reviewRequest || profile?.config?.reviewRequest || {};

  // Opt-in gates: must be enabled AND have a URL. Silent skip otherwise.
  if (cfg.enabled === false) {
    appendReviewRequestLedger({ ts: new Date().toISOString(), ownerEmail, senderId, status: 'skipped-disabled' });
    return true;
  }
  if (!cfg.url) {
    console.log(`⭐ [review_request] skipped — no review URL configured for ${ownerEmail}`);
    appendReviewRequestLedger({ ts: new Date().toISOString(), ownerEmail, senderId, status: 'skipped-no-url' });
    return true;
  }

  const businessName = profile?.profile?.businessName || profile?.businessName || 'us';
  const greetingName = customerName || senderName || 'there';

  // Default template — short, warm, no pressure. Owner can override per
  // dashboard. Placeholders: {customer}, {business}, {service}, {url}.
  const tmpl = (cfg.template && typeof cfg.template === 'string')
    ? cfg.template
    : `Hi {customer}! Hope your {service} with {business} went well 🙏 If you have 30 seconds, a quick review really helps us out: {url}`;

  const msg = tmpl
    .replace(/\{customer\}/g, greetingName)
    .replace(/\{business\}/g, businessName)
    .replace(/\{service\}/g, service || 'visit')
    .replace(/\{url\}/g, cfg.url);

  // Send via the original channel (where the booking was made).
  let channelSent = false;
  if (channel && senderId) {
    const channelConfig = channelConfigs.get(ownerEmail)?.[channel];
    if (channelConfig) {
      try {
        await sendChannelReply(channel, channelConfig, senderId, msg);
        channelSent = true;
      } catch (e) { console.warn(`[review_request] ${channel} send failed:`, e.message); }
    }
  }

  // Backup: email the customer if we have their email AND channel send failed
  // (or send both if owner has cfg.alwaysEmail = true). One-touch normally.
  if (customerEmail && (!channelSent || cfg.alwaysEmail)) {
    try {
      await smartSend({
        ownerEmail, to: customerEmail,
        subject: `Quick favour — review for ${businessName}?`,
        html: `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px;font-size:15px;line-height:1.6;color:#222;">
          <p>${msg.replace(cfg.url, `<a href="${cfg.url}" style="color:#00a070;font-weight:600;">leave a review</a>`)}</p>
          <p style="margin-top:18px;font-size:12px;color:#888;">Thanks for choosing ${businessName}.</p>
        </div>`,
      });
    } catch (e) { console.warn('[review_request] email send failed:', e.message); }
  }

  appendReviewRequestLedger({
    ts: new Date().toISOString(),
    ownerEmail, senderId, senderName: greetingName, channel,
    service, datetime, status: 'sent',
  });

  // Webhook so connected CRMs can track review-request fires
  fireWebhookEvent(ownerEmail, 'review_request_sent', {
    channel, senderId, senderName: greetingName,
    customerEmail, service, datetime, reviewUrl: cfg.url,
  });

  // Digest-friendly FYI for the owner (batched when digest mode on,
  // skipped when off — no spammy "review sent" email per-customer).
  await notify({
    ownerEmail, type: 'review_sent',
    subject: `⭐ Review request sent — ${greetingName}`,
    html: `<p>Aria asked ${greetingName} for a review on ${channel}.</p>`,
    summary: `${greetingName} · ${channel}${service ? ' · ' + service : ''}`,
  });

  console.log(`⭐ [outbound] review_request sent to ${greetingName} (${ownerEmail}) via ${channel}`);
  return true;
});

registerTaskHandler('conv_recovery', async (task) => {
  const { ownerEmail, payload } = task;
  const { channel, senderId, senderName, lastTopic } = payload;
  const profile = getOwnerProfile(ownerEmail);
  if (profile?.config?.outbound?.convRecovery === false) return false;
  if (profile?.profile?.outbound?.convRecovery === false) return false;
  // Don't recover if conv has had activity in the last 18h (someone replied)
  const memKey = `${ownerEmail}::${channel}::${senderId}`;
  const history = conversationMemory.get(memKey) || [];
  const lastTs = history[history.length - 1]?.date;
  if (lastTs && Date.now() - new Date(lastTs).getTime() < 18 * 60 * 60 * 1000) {
    console.log(`[outbound] conv_recovery skipped — recent activity for ${senderName}`);
    return true;
  }
  const businessName = profile?.profile?.businessName || 'us';
  const msg = lastTopic
    ? `Hi ${senderName || 'there'} 👋 Just circling back on your question about ${lastTopic} — still interested? Happy to pick up where we left off.`
    : `Hi ${senderName || 'there'} 👋 Just checking back in — anything else you'd like to ask ${businessName}? Happy to help.`;
  const channelConfig = channelConfigs.get(ownerEmail)?.[channel];
  if (!channelConfig) return false;
  try {
    await sendChannelReply(channel, channelConfig, senderId, msg, ['Yes, still keen', 'Not right now']);
    console.log(`🔁 [outbound] conv_recovery sent to ${senderName} via ${channel}`);
    return true;
  } catch (e) {
    console.warn('[outbound] conv_recovery send failed:', e.message);
    return false;
  }
});

// Boot scheduler at startup
const _pendingCount = bootstrapFromLedger();
console.log(`📅 Outbound scheduler: ${_pendingCount} pending tasks loaded from ledger`);
startTickLoop(60_000);

// Notification-digest tick — runs every minute, flushes buffered
// informational alerts for any owner whose local sendTime is "now".
setInterval(() => { tickDigests().catch(e => console.error('[digest] tick failed:', e.message)); }, 60_000);

// Daily 8am sentiment digest — sums yesterday's negative + angry interactions
// from channel_leads.jsonl, emails owner a digest with examples. Only fires
// if threshold met (>=1 angry OR >=3 negative) — silence when things are fine.
let lastSentimentDigestDay = null;
setInterval(async () => {
  const now = new Date();
  if (now.getHours() !== 8 || lastSentimentDigestDay === now.toDateString()) return;
  lastSentimentDigestDay = now.toDateString();

  // Build per-owner buckets
  const byOwner = new Map(); // ownerEmail → { angry: [], negative: [] }
  try {
    if (existsSync(CHANNEL_LEADS_FILE)) {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const lines = readFileSync(CHANNEL_LEADS_FILE, 'utf8').split('\n').filter(Boolean).slice(-2000);
      for (const l of lines) {
        try {
          const e = JSON.parse(l);
          if (!e.ownerEmail || !e.sentiment) continue;
          if (new Date(e.ts).getTime() < cutoff) continue;
          if (e.sentiment !== 'angry' && e.sentiment !== 'negative') continue;
          if (!byOwner.has(e.ownerEmail)) byOwner.set(e.ownerEmail, { angry: [], negative: [] });
          byOwner.get(e.ownerEmail)[e.sentiment].push(e);
        } catch {}
      }
    }
  } catch {}

  for (const [ownerEmail, bucket] of byOwner) {
    const angryCount = bucket.angry.length;
    const negCount = bucket.negative.length;
    if (angryCount === 0 && negCount < 3) continue; // threshold
    try {
      const exampleRows = [...bucket.angry, ...bucket.negative].slice(0, 5).map(e => {
        const colour = e.sentiment === 'angry' ? '#ff6b6b' : '#fbbf24';
        return `<div style="background:#fff;border-left:3px solid ${colour};padding:10px 14px;margin-bottom:8px;border-radius:6px;font-size:13px;">
          <div style="color:#888;font-size:11px;margin-bottom:4px;">${e.sentiment.toUpperCase()} · ${e.channel} · ${e.senderName || 'anon'}</div>
          <div style="color:#333;font-style:italic;">"${(e.messagePreview || '').slice(0, 200).replace(/</g, '&lt;')}"</div>
        </div>`;
      }).join('');
      await smartSend({
        ownerEmail, to: ownerEmail,
        subject: `🚨 Aria sentiment digest — ${angryCount} angry, ${negCount} negative in last 24h`,
        html: `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:20px;">
          <div style="background:#0d0d1f;color:#fff;padding:18px;border-radius:12px;">
            <h2 style="margin:0 0 6px;color:#ff6b6b;">😤 Sentiment digest — last 24h</h2>
            <p style="margin:0;color:#9898b8;font-size:13px;">${angryCount} angry · ${negCount} negative</p>
          </div>
          <div style="margin-top:14px;">${exampleRows}</div>
          <p style="margin:14px 0 0;font-size:12px;color:#666;text-align:center;">These are interactions Aria classified as negative or angry. Worth reviewing — could be a recurring issue, a missing service detail, or one customer worth a personal follow-up.</p>
        </div>`,
      });
      console.log(`📧 Sentiment digest sent to ${ownerEmail}: ${angryCount} angry, ${negCount} negative`);
    } catch (e) { console.warn('[sentiment-digest] send failed:', e.message); }
  }
}, 5 * 60 * 1000); // check every 5 min, fires once per day

// Daily sweep — once a day, find conversations that had ≥3 exchanges
// but went quiet >24h ago. Schedule a recovery nudge for each (one per
// memKey, dedupe via in-memory set so we don't re-nudge repeatedly).
const recoveryNudgedToday = new Set();
let lastRecoverySweepDay = null;
setInterval(() => {
  const day = new Date().toISOString().slice(0, 10);
  if (lastRecoverySweepDay === day) return;
  // Only sweep at 10am-11am local to land at a polite time
  const h = new Date().getHours();
  if (h !== 10) return;
  lastRecoverySweepDay = day;
  recoveryNudgedToday.clear();
  let scheduled = 0;
  for (const [memKey, history] of conversationMemory) {
    if (!Array.isArray(history) || history.length < 3) continue;
    const last = history[history.length - 1];
    if (!last?.date) continue;
    const ageMs = Date.now() - new Date(last.date).getTime();
    // Only nudge convs that went quiet 24-72h ago. Older = dead, skip.
    if (ageMs < 24 * 60 * 60 * 1000 || ageMs > 72 * 60 * 60 * 1000) continue;
    if (recoveryNudgedToday.has(memKey)) continue;
    // Skip paused/escalated convs — owner is handling them
    if (conversationState.get(memKey)?.paused) continue;
    const [ownerEmail, channel, senderId] = memKey.split('::');
    // Need a channel config to send via
    const channelConfig = channelConfigs.get(ownerEmail)?.[channel];
    if (!channelConfig?.enabled) continue;
    // Skip if there's already a pending recovery for this memKey
    const dup = listPending({ ownerEmail, type: 'conv_recovery' }).find(t =>
      t.payload?.channel === channel && t.payload?.senderId === senderId);
    if (dup) continue;
    // Extract a recent topic hint for the message
    const recentText = history.slice(-3).filter(h => h.role === 'sender').map(h => h.preview).join(' ');
    const topicMatch = recentText.match(/\b(quote|booking|price|cost|service|appointment|hire|wedding|haircut)\w*\b/i);
    try {
      scheduleTask({
        type: 'conv_recovery',
        dueAt: Date.now() + 5 * 60 * 1000, // 5 min so they don't all fire at once
        ownerEmail,
        payload: { channel, senderId, senderName: senderId, lastTopic: topicMatch?.[0] || null },
      });
      recoveryNudgedToday.add(memKey);
      scheduled++;
    } catch (e) {}
  }
  if (scheduled) console.log(`🔁 [outbound] Daily recovery sweep scheduled ${scheduled} nudges`);
}, 5 * 60 * 1000); // check every 5 min

// Admin/debug endpoint to inspect pending tasks
app.get('/api/dashboard/outbound', (req, res) => {
  const owner = requireDashboardAuth(req, res);
  if (!owner) return;
  const items = listPending({ ownerEmail: owner }).map(t => ({
    id: t.id, type: t.type, dueAt: t.dueAt, scheduledAt: t.scheduledAt,
    payloadSummary: t.payload?.leadName || t.payload?.senderName || t.payload?.customerEmail || '',
  })).sort((a, b) => a.dueAt - b.dueAt);
  res.json({ tasks: items });
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
    const adminUrl=mintAdminMagicLink(null);
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
  const adminUrl=mintAdminMagicLink(null);
  await sendEmail({ to:process.env.NOTIFY_EMAIL, subject:`📈 Aria Weekly Report`, html:weeklyTpl({ period:`${new Date(week).toLocaleDateString()} — ${now.toLocaleDateString()}`, stats:{ total:thisWeek.length, leads:allLeads.length, avgScore }, trend:{ total:thisWeek.length-prevW.length, leads:allLeads.length-prevW.flatMap(s=>(s.leads||[])).length }, topQuestions:topQ, hotLeads, npsAvg, adminUrl }) });
  console.log('📈 Weekly report sent');
}, 60_000);

// ─── Per-client weekly email report (Mondays 9am) ─────────────────────────────
let lastClientWeeklyDay = null;
setInterval(async () => {
  const now = new Date();
  if (now.getDay() !== 1 || now.getHours() !== 9 || lastClientWeeklyDay === now.toDateString()) return;
  lastClientWeeklyDay = now.toDateString();

  for (const [ownerEmail, config] of EMAIL_AUTO_REPLY_ENABLED) {
    if (!config?.enabled) continue;
    const stats = EMAIL_REPLY_STATS.get(ownerEmail);
    if (!stats || stats.replied === 0) continue;
    const cfg = config.config || {};
    const brandColor = cfg.brandColor || '#00e5a0';
    const businessName = cfg.businessName || 'Your Business';

    // Count this week's activity from history
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const thisWeek = (stats.history || []).filter(h => new Date(h.time) >= new Date(weekAgo));
    const weekReplied = thisWeek.filter(h => h.type === 'reply').length;
    const weekBookings = thisWeek.filter(h => h.type === 'booking').length;
    const weekFollowUps = thisWeek.filter(h => h.type === 'followup').length;
    const weekUrgent = thisWeek.filter(h => h.type === 'urgent').length;

    if (weekReplied === 0 && weekBookings === 0) continue; // nothing to report

    const serverUrl = process.env.GOOGLE_REDIRECT_URI?.replace('/auth/gmail/callback', '') || `http://localhost:${process.env.PORT || 3000}`;

    try {
      await smartSend({ ownerEmail, to: ownerEmail, subject: `📊 Aria Weekly Report — ${businessName}`,
        html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;">
        <div style="max-width:520px;margin:20px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
          <div style="background:${brandColor};padding:24px 28px;color:#fff;">
            <div style="font-size:20px;font-weight:700;">Weekly Report</div>
            <div style="font-size:13px;opacity:0.85;margin-top:4px;">${businessName} — ${new Date(weekAgo).toLocaleDateString('en-GB')} to ${now.toLocaleDateString('en-GB')}</div>
          </div>
          <div style="padding:28px;">
            <div style="display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap;">
              <div style="flex:1;min-width:100px;background:#f8f8fc;border-radius:10px;padding:16px;text-align:center;">
                <div style="font-size:28px;font-weight:800;color:${brandColor};">${weekReplied}</div>
                <div style="font-size:12px;color:#888;margin-top:4px;">Emails Replied</div>
              </div>
              <div style="flex:1;min-width:100px;background:#f8f8fc;border-radius:10px;padding:16px;text-align:center;">
                <div style="font-size:28px;font-weight:800;color:#38bdf8;">${weekBookings}</div>
                <div style="font-size:12px;color:#888;margin-top:4px;">Bookings</div>
              </div>
              <div style="flex:1;min-width:100px;background:#f8f8fc;border-radius:10px;padding:16px;text-align:center;">
                <div style="font-size:28px;font-weight:800;color:#fbbf24;">${weekFollowUps}</div>
                <div style="font-size:12px;color:#888;margin-top:4px;">Follow-Ups</div>
              </div>
            </div>
            ${weekUrgent ? `<p style="color:#ff6b6b;font-size:13px;margin-bottom:16px;">⚠️ ${weekUrgent} urgent email${weekUrgent > 1 ? 's' : ''} flagged this week</p>` : ''}
            <div style="font-size:13px;color:#666;line-height:1.7;margin-bottom:20px;">
              <strong>All-time totals:</strong> ${stats.replied} replies, ${stats.bookings} bookings, ${stats.followUps} follow-ups
            </div>
            <a href="${serverUrl}/connect/gmail?owner=${encodeURIComponent(ownerEmail)}" style="display:inline-block;padding:12px 24px;background:${brandColor};color:#fff;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px;">View Dashboard</a>
          </div>
          <div style="background:#fafafa;padding:12px 28px;text-align:center;font-size:11px;color:#bbb;">
            Powered by <a href="https://aireyai.co.uk" style="color:${brandColor};text-decoration:none;">AireyAi</a>
          </div>
        </div></body></html>` });
      console.log(`📊 Weekly report sent to ${ownerEmail}`);
    } catch (e) { console.warn(`Failed to send weekly report to ${ownerEmail}:`, e.message); }
  }
}, 60_000);

// ─── Meta Token Refresh (daily) ──────────────────────────────────────────────
let lastTokenRefreshDay = null;
setInterval(async () => {
  const now = new Date();
  if (now.getHours() !== 3 || lastTokenRefreshDay === now.toDateString()) return;
  lastTokenRefreshDay = now.toDateString();

  for (const [ownerEmail, tokens] of metaTokens) {
    const daysUntilExpiry = (tokens.userTokenExpiry - Date.now()) / (24 * 60 * 60 * 1000);
    if (daysUntilExpiry > 7) continue;

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

      const chConfig = channelConfigs.get(ownerEmail);
      if (chConfig?.whatsapp?.accessToken) {
        chConfig.whatsapp.accessToken = data.access_token;
        channelConfigs.set(ownerEmail, chConfig);
        persistChannels();
      }

      console.log(`✅ Refreshed Meta token for ${ownerEmail}`);
    } catch (e) {
      console.warn(`❌ Failed to refresh Meta token for ${ownerEmail}:`, e.message);
      await sendEmail({
        to: process.env.NOTIFY_EMAIL,
        subject: `⚠️ Meta token refresh failed for ${ownerEmail}`,
        html: `<p>The Meta token for <strong>${ownerEmail}</strong> failed to refresh: ${e.message}</p><p>They may need to reconnect via the dashboard.</p>`,
      });
    }
  }
}, 60_000);

// ─── Abandoned recovery ───────────────────────────────────────────────────────
setInterval(async () => {
  if (!process.env.NOTIFY_EMAIL) return;
  const twoH = 2*60*60*1000, adminUrl=mintAdminMagicLink(null);
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
loadEmailStats();
loadFollowUps();
loadPasswords();
loadSessions();
loadPendingApprovals();
loadReplyLog();
loadKnowledgeBase();
loadConversationMemory();
loadAllowedDomains();
loadInvites();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const meta = process.env.META_APP_ID ? '✅' : '❌';
  console.log(`\n  ✦ Aria Chatbot Server v5.2`);
  // Startup print — local dev only. Goes to your own terminal so the leak
  // surface is the same as the env var itself.
  console.log(`  → Admin: http://localhost:${PORT}/admin  (login with ADMIN_PASS)`);
  console.log(`  → Health: http://localhost:${PORT}/health`);
  console.log(`  → Meta channels: ${meta} (${metaTokens.size} connected accounts)`);
  console.log('');
});

// ─── Global error handlers — prevent unhandled errors from crashing the process
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message || err);
});
