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

const PREVIEW_DIR = resolve('data', 'previews');
const PREVIEW_TTL_MS = 60 * 60 * 1000; // 1 hour — preview tokens expire after this

// ──────────────────────────────────────────────────────────────────────────
// Fetch site content (server-side — we don't trust client crawl).
// Returns plain text up to a cap so we don't blow Claude's context.
// ──────────────────────────────────────────────────────────────────────────
export async function fetchSiteContent(url) {
  const u = new URL(url); // throws on invalid URL — caller catches
  const res = await fetch(u.toString(), {
    headers: { 'User-Agent': 'AireyAI-Aria-Onboarder/1.0' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Site returned HTTP ${res.status}`);
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
