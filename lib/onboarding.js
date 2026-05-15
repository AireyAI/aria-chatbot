// Self-serve onboarding — turn a website URL into a fully-configured Aria
// embed in 60 seconds, with zero human intervention.
//
// Flow:
//   1. Visitor pastes their URL on aireyai.co.uk/start
//   2. Server fetches the URL, strips HTML to text
//   3. Claude extracts structured business profile JSON
//   4. Server generates the Aria system prompt from the profile
//   5. Server creates a preview session (short-lived token)
//   6. Visitor sees Aria embedded with their config in an iframe preview
//   7. Visitor copies the embed snippet, pastes on their site, done
//
// Phase 2 (later) adds Stripe auth between steps 6 and 7.

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import dns from 'node:dns/promises';

const PREVIEW_DIR = resolve('data', 'previews');
// 30 days — covers cold-outreach emails opened weeks after send. Preview
// tokens are config snapshots, not auth — cheap to keep, low abuse risk.
const PREVIEW_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ──────────────────────────────────────────────────────────────────────────
// SSRF guard — refuse to scan URLs that point inside our infrastructure.
// Returns a string error message if the URL should be rejected, else null.
//
// Threat model: a public /api/onboard/scan endpoint lets anyone trigger
// the server to fetch ANY URL. Without this guard, an attacker can probe
// Railway's metadata service (169.254.169.254), internal services on
// localhost, or other RFC1918 ranges. Even though only the extracted
// JSON ever returns to the caller (raw bytes don't leak), it's an
// unbounded fetch primitive we shouldn't hand out.
// ──────────────────────────────────────────────────────────────────────────
export function validateScanUrl(url) {
  let u;
  try { u = new URL(url); } catch { return 'Invalid URL — include the scheme, e.g. https://your-site.com'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'URL must start with http:// or https://';
  const host = u.hostname.toLowerCase();
  // Block by hostname pattern — these never resolve to public sites.
  if (host === 'localhost' || host.endsWith('.localhost')) return 'localhost URLs are not allowed';
  if (host === '0.0.0.0' || host === '::' || host === '[::]') return 'Wildcard addresses are not allowed';
  // Block by IPv4 ranges (RFC1918, link-local, loopback, multicast, reserved).
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const ipCheck = isInternalIp(host);
    if (ipCheck) return ipCheck;
  }
  // Block all IPv6 literals — too many edge cases to whitelist reliably.
  if (host.includes(':') || host.startsWith('[')) return 'IPv6 literal addresses are not allowed';
  // Block AWS/GCP/Azure metadata endpoints by canonical hostname too.
  if (host === 'metadata.google.internal' || host === 'metadata.azure.com') return 'Cloud metadata endpoints are not allowed';
  return null; // safe
}

// Apply RFC1918 / loopback / link-local / metadata checks to a resolved IP.
// Used by both the sync URL validator AND the post-DNS check, so a hostname
// like "rebind.evil.com" that resolves to 169.254.169.254 still gets blocked.
export function isInternalIp(ip) {
  if (!ip) return 'Empty IP';
  // IPv4
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]];
    if (a === 10) return 'Private IP range (10.0.0.0/8)';
    if (a === 127) return 'Loopback address';
    if (a === 169 && b === 254) return 'Link-local / cloud metadata range';
    if (a === 172 && b >= 16 && b <= 31) return 'Private IP range (172.16.0.0/12)';
    if (a === 192 && b === 168) return 'Private IP range (192.168.0.0/16)';
    if (a === 100 && b >= 64 && b <= 127) return 'Carrier-grade NAT range (100.64.0.0/10)';
    if (a === 0) return 'Reserved 0.0.0.0/8';
    if (a >= 224) return 'Multicast/reserved range';
    return null;
  }
  // IPv6 — reject anything that isn't a clearly-global address. Cheaper than
  // enumerating every reserved range. The vast majority of legit sites we
  // scan are dual-stack with public A records, so v6-only blocking is fine.
  if (ip.includes(':')) return 'IPv6 address (blocked by policy)';
  return 'Unrecognised IP format';
}

// Resolve all A/AAAA records for the hostname and reject if ANY of them
// land in internal ranges. Catches:
//  - Direct attacks ("scan http://169.254.169.254/")
//  - DNS rebinding precursor ("rebind.evil.com" resolves to public + private)
//  - Misconfigured DNS pointing public-looking hostnames at internal IPs
export async function validateResolvedHost(hostname) {
  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (e) {
    return `DNS lookup failed for ${hostname}: ${e.code || e.message}`;
  }
  if (!addrs.length) return `Hostname ${hostname} resolves to nothing`;
  for (const { address } of addrs) {
    const bad = isInternalIp(address);
    if (bad) return `${hostname} resolves to ${address} — ${bad}`;
  }
  return null;
}

// safeFetch — the only function callers should use to fetch arbitrary URLs.
// Performs: URL syntax check → DNS resolution validation → manual redirect
// loop with re-validation at each hop. Caps redirects at 4 (browser default
// is 20; we don't need that for a scanner).
export async function safeFetch(url, { headers = {}, timeoutMs = 15000, maxRedirects = 4 } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const syntaxErr = validateScanUrl(current);
    if (syntaxErr) throw new Error(`SSRF blocked: ${syntaxErr}`);

    const u = new URL(current);
    const dnsErr = await validateResolvedHost(u.hostname);
    if (dnsErr) throw new Error(`SSRF blocked: ${dnsErr}`);

    const res = await fetch(current, {
      headers: { 'User-Agent': 'AireyAI-Aria-Onboarder/1.0', ...headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });

    // 2xx / 4xx / 5xx — return as-is, caller handles
    if (res.status < 300 || res.status >= 400) return res;

    // 3xx — re-validate the Location target before following
    const location = res.headers.get('location');
    if (!location) return res; // 3xx without Location — let caller see it
    current = new URL(location, current).toString();
  }
  throw new Error(`SSRF blocked: redirect limit (${maxRedirects}) exceeded`);
}

// ──────────────────────────────────────────────────────────────────────────
// Fetch site content (server-side — we don't trust client crawl).
// Returns plain text up to a cap so we don't blow Claude's context.
// ──────────────────────────────────────────────────────────────────────────
export async function fetchSiteContent(url) {
  // safeFetch validates URL syntax + DNS + every redirect target before reading.
  const res = await safeFetch(url);
  if (!res.ok) throw new Error(`Site returned HTTP ${res.status}`);
  const u = new URL(res.url || url);
  const html = await res.text();
  // Strip scripts, styles, and HTML tags. Collapse whitespace. Cap at 8KB.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);

  // Also extract <title> and <meta description> for high-signal context
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || '';
  const metaDesc = (html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i) || [])[1]?.trim() || '';

  return { hostname: u.hostname, title, metaDesc, text };
}

// ──────────────────────────────────────────────────────────────────────────
// Extract structured business profile from raw site content using Claude.
// Returns null on parse failure so caller can fall back gracefully.
// ──────────────────────────────────────────────────────────────────────────
export async function extractBusinessProfile(claude, { hostname, title, metaDesc, text }) {
  const r = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001', // cheap — this is a one-shot extraction
    max_tokens: 800,
    system: 'You extract structured business information from website content. Return ONLY valid JSON, no markdown, no preamble.',
    messages: [{
      role: 'user',
      content: `Analyse this website and extract key business facts.

Hostname: ${hostname}
Page title: ${title}
Meta description: ${metaDesc}

Page content (first 8KB):
${text}

Return JSON with this exact shape:
{
  "businessName": "exact business name as it appears",
  "businessType": "one of: trades, salon, restaurant, gym, clinic, agency, ecommerce, law, generic",
  "description": "2-sentence plain-english summary of what they do",
  "location": "city/area, or 'online only' if no physical location",
  "services": ["service 1", "service 2"],
  "priceRange": "from £X / not listed",
  "contact": { "phone": "", "email": "", "address": "" },
  "hours": "e.g. Mon-Fri 9am-5pm or 'not listed'",
  "tone": "professional / friendly / casual / luxury / budget-friendly",
  "primaryColor": "best-guess hex of their brand colour from any colour mentions or fallback to a sensible niche default"
}

Rules:
- businessType MUST be one of the listed enum values, pick the closest match
- If a field is genuinely absent, use empty string "" (don't invent)
- primaryColor: if not obvious, use defaults — trades=#2a7af0, salon=#c2688e, restaurant=#d97a4a, gym=#1a8754, clinic=#0d6efd, agency=#6c5ce7, ecommerce=#000000, law=#1a3a5f, generic=#4a5568`,
    }],
  });

  const responseText = r.content?.[0]?.text || '';
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Generate the Aria system prompt from the extracted profile.
// This is deterministic — no LLM call — so the output is auditable and
// reproducible. Per CLAUDE.md Rule #5 (Claude only for judgment).
// ──────────────────────────────────────────────────────────────────────────
export function generateSystemPrompt(profile) {
  const lines = [
    `You are Aria, the friendly AI assistant for ${profile.businessName}.`,
    '',
    profile.description ? `About: ${profile.description}` : '',
    profile.location ? `Location: ${profile.location}` : '',
    profile.services?.length ? `Services: ${profile.services.join(', ')}.` : '',
    profile.priceRange && profile.priceRange !== 'not listed' ? `Pricing: ${profile.priceRange}.` : '',
    profile.hours && profile.hours !== 'not listed' ? `Hours: ${profile.hours}.` : '',
    profile.contact?.phone ? `Phone: ${profile.contact.phone}.` : '',
    profile.contact?.email ? `Email: ${profile.contact.email}.` : '',
    profile.contact?.address ? `Address: ${profile.contact.address}.` : '',
    '',
    `Tone: ${profile.tone || 'friendly and professional'}.`,
    '',
    'Be helpful, capture the visitor\'s name and contact details (email or phone), what they need, and any preferred time. Always offer to have the team follow up. Do not invent prices, services, or facts not listed above — if unsure, say you\'ll have the team get back to them.',
  ];
  return lines.filter(Boolean).join('\n');
}

// ──────────────────────────────────────────────────────────────────────────
// Preview session — short-lived token that lets the onboarding page embed
// a working Aria chat with the auto-generated config, BEFORE billing.
// Stored as one-file-per-token in data/previews/ so they auto-expire.
// ──────────────────────────────────────────────────────────────────────────
export async function createPreviewSession({ profile, prompt }) {
  await fs.mkdir(PREVIEW_DIR, { recursive: true });
  const token = crypto.randomBytes(12).toString('hex');
  const session = {
    token,
    profile,
    prompt,
    createdAt: Date.now(),
    expiresAt: Date.now() + PREVIEW_TTL_MS,
  };
  await fs.writeFile(resolve(PREVIEW_DIR, `${token}.json`), JSON.stringify(session), 'utf8');
  return session;
}

export async function getPreviewSession(token) {
  if (!/^[a-f0-9]{24}$/.test(token)) return null; // belt + braces — reject malformed tokens
  try {
    const raw = await fs.readFile(resolve(PREVIEW_DIR, `${token}.json`), 'utf8');
    const session = JSON.parse(raw);
    if (Date.now() > session.expiresAt) return null;
    return session;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Auto-allowlist a domain via Aria's own /admin/domains endpoint. We call
// it internally (server-to-server, same host) using the ADMIN_PASS env var.
// Adds the apex + www variants so both forms work without separate signup.
// ──────────────────────────────────────────────────────────────────────────
export async function autoAllowlistDomain(hostname, serverBaseUrl) {
  const adminPass = process.env.ADMIN_PASS;
  if (!adminPass) {
    console.warn('[onboarding] ADMIN_PASS not set — skipping auto-allowlist');
    return { ok: false, error: 'ADMIN_PASS not configured' };
  }

  // Normalize: strip www., lowercase, take apex form
  const apex = hostname.toLowerCase().replace(/^www\./, '');
  const candidates = [apex, `www.${apex}`];
  const results = [];
  for (const domain of candidates) {
    try {
      const res = await fetch(`${serverBaseUrl}/admin/domains?pass=${encodeURIComponent(adminPass)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain }),
        signal: AbortSignal.timeout(5000),
      });
      results.push({ domain, status: res.status, ok: res.ok });
    } catch (e) {
      results.push({ domain, error: e.message });
    }
  }
  return { ok: results.every(r => r.ok), results };
}

// ──────────────────────────────────────────────────────────────────────────
// Email the install snippet to the visitor. Caller passes smartSend from
// server.js so this module stays decoupled from server.js internals.
// ──────────────────────────────────────────────────────────────────────────
export async function emailInstallSnippet({ smartSend, toEmail, businessName, snippet, previewUrl }) {
  if (!smartSend) return { ok: false, error: 'smartSend not available' };
  const html = `
    <div style="font-family:-apple-system,system-ui,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#1a202c;line-height:1.6">
      <h1 style="font-size:24px;margin-bottom:8px">Aria is ready for ${businessName}</h1>
      <p style="color:#4a5568">Paste this snippet on every page of your site, right before <code style="background:#f7fafc;padding:2px 6px;border-radius:4px">&lt;/body&gt;</code>:</p>
      <pre style="background:#1a202c;color:#cbd5e0;padding:20px;border-radius:12px;font-family:'SF Mono',Monaco,monospace;font-size:12px;line-height:1.5;overflow-x:auto;white-space:pre-wrap;word-break:break-all">${snippet.replace(/</g, '&lt;')}</pre>
      <p style="margin-top:24px;color:#4a5568">Your preview is also live (1-hour expiry): <a href="${previewUrl}" style="color:#6366f1">${previewUrl}</a></p>
      <hr style="margin:32px 0;border:0;border-top:1px solid #e2e8f0">
      <p style="font-size:13px;color:#718096">If you didn't request this, you can safely ignore the email. No account was created.</p>
    </div>`;
  try {
    await smartSend({
      ownerEmail: toEmail,
      to: toEmail,
      subject: `Your Aria install snippet for ${businessName}`,
      html,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Generate the install snippet — the <script> tag the visitor copy-pastes
// onto their site. Filled with the values from their preview session.
// ──────────────────────────────────────────────────────────────────────────
export function generateEmbedSnippet({ profile, prompt, serverBaseUrl }) {
  // Escape double quotes in the prompt so the HTML attribute stays valid.
  const safePrompt = prompt.replace(/"/g, '&quot;').replace(/\n/g, ' ');
  const lines = [
    `<!-- Aria AI Chatbot — auto-generated by ${serverBaseUrl}/start -->`,
    `<script src="${serverBaseUrl}/chatbot.js"`,
    `    data-name="Aria"`,
    `    data-color="${profile.primaryColor || '#4a5568'}"`,
    `    data-server="${serverBaseUrl}"`,
    `    data-endpoint="/api/chat/router"`,
    `    data-streaming="true"`,
    `    data-type="${profile.businessType || 'generic'}"`,
    profile.contact?.email ? `    data-handoff-email="${profile.contact.email}"` : '',
    profile.contact?.phone ? `    data-handoff-wa="${profile.contact.phone}"` : '',
    `    data-prompt="${safePrompt}"`,
    `></script>`,
  ];
  return lines.filter(Boolean).join('\n');
}
