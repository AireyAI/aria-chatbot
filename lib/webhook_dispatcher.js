// webhook_dispatcher.js
//
// Outbound webhook delivery with HMAC signing + bounded retry. Used by
// Aria to notify owner-configured endpoints (Zapier, Make, Slack, custom
// CRM, etc) when significant events happen (new lead, booking, handoff).
//
// Per Engineering Rule 13: every delivery attempt logged append-only to
// data/webhook_log.jsonl. Receivers can audit which events fired when.

import crypto from 'crypto';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const LEDGER = resolve('data/webhook_log.jsonl');
const MAX_BODY_BYTES = 64 * 1024;
const RETRY_DELAYS_MS = [30_000, 120_000, 480_000]; // 30s, 2m, 8m — then give up

// Sign a payload body with the webhook secret. Receiver verifies by
// computing sha256(secret + body) themselves and comparing constant-time.
export function signPayload(secret, bodyString) {
  return 'sha256=' + crypto.createHmac('sha256', secret || '').update(bodyString).digest('hex');
}

function appendToLedger(entry) {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    appendFileSync(LEDGER, JSON.stringify(entry) + '\n');
  } catch (e) { console.warn('[webhook] ledger append failed:', e.message); }
}

// Dispatch one webhook delivery. Returns { ok, status, attempt } on first
// success OR after final retry. Caller doesn't await retries — they happen
// async in setTimeout chains so the main request flow isn't blocked.
export async function dispatchWebhook(webhook, event, data) {
  if (!webhook?.url || !webhook?.enabled) return { ok: false, reason: 'disabled' };

  const body = JSON.stringify({
    event, timestamp: new Date().toISOString(), data,
  });
  if (body.length > MAX_BODY_BYTES) {
    return { ok: false, reason: 'payload too large' };
  }

  const signature = signPayload(webhook.secret, body);
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'AriaBot/1.0 (+https://aireyai.co.uk)',
    'X-Aria-Event': event,
    'X-Aria-Signature': signature,
    'X-Aria-Timestamp': String(Date.now()),
  };

  const attempt = async (attemptNum) => {
    const startedAt = Date.now();
    try {
      const r = await fetch(webhook.url, {
        method: 'POST', headers, body,
        signal: AbortSignal.timeout(8000),
      });
      const took = Date.now() - startedAt;
      appendToLedger({
        ts: new Date().toISOString(), event, url: webhook.url,
        attempt: attemptNum, status: r.status, ok: r.ok, ms: took,
      });
      if (r.ok) return { ok: true, status: r.status, attempt: attemptNum };
      // 4xx — don't retry, it's a config problem (bad URL, auth)
      if (r.status >= 400 && r.status < 500) {
        return { ok: false, status: r.status, attempt: attemptNum, reason: 'client error — not retrying' };
      }
      // 5xx — retry if budget remains
      throw new Error(`status ${r.status}`);
    } catch (e) {
      appendToLedger({
        ts: new Date().toISOString(), event, url: webhook.url,
        attempt: attemptNum, ok: false, error: String(e.message).slice(0, 200),
      });
      if (attemptNum >= RETRY_DELAYS_MS.length) {
        return { ok: false, attempt: attemptNum, error: e.message };
      }
      // Schedule next attempt — fire-and-forget so caller returns immediately
      const delay = RETRY_DELAYS_MS[attemptNum - 1];
      setTimeout(() => attempt(attemptNum + 1), delay);
      return { ok: false, retrying: true, attempt: attemptNum };
    }
  };

  return attempt(1);
}

// Read recent delivery log entries for one owner's webhook URLs. Used
// by dashboard "recent deliveries" panel.
export function readWebhookLog({ urls, limit = 50 } = {}) {
  if (!existsSync(LEDGER)) return [];
  const urlSet = urls instanceof Set ? urls : new Set(urls || []);
  const out = [];
  const lines = readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);
  // Scan newest first
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (urlSet.size && !urlSet.has(e.url)) continue;
      out.push(e);
    } catch {}
  }
  return out;
}
