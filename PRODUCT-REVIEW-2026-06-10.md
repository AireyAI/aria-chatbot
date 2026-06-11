# Aria Product Review — 2026-06-10

Full review of the Aria receptionist product (text + voice + outbound) against one question:
**what's missing so a business renting Aria gets real, visible, monthly value — and what services can we add so Aria helps run their website and business?**

Sources: code audit of `~/chatbot`, `~/aireyai_voice`, `~/jarvis/agents/aria_caller`; promise audit of
`aria.html` / `pricing.html` / `SERVICES.md`; market scan of Chatbase, Tidio/Lyro, Intercom Fin,
Smith.ai, Rosie, Goodcall, Slang.ai, Ruby, Podium, NiceJob, GoHighLevel resellers.

---

## 1. What Aria actually is today

### Text bot (`~/chatbot`, live on Railway) — stronger than expected
- Claude Haiku 4.5 with a real tool-use loop (`lib/lead_router.js`): lead qualification scoring
  (0–100, intent + urgency + service match), lead records, staged calendar bookings with conflict
  detection + ICS invites, WhatsApp-to-owner handoff (approval-gated).
- Gmail auto-reply lane: reads owner inbox, drafts replies from the knowledge base, 5-min
  per-sender cooldown, reply log in admin.
- Owner notifications: instant lead emails with magic-link admin access, batched daily digest at
  owner's local time.
- Per-client KB CRUD (lexical match only, no embeddings), widget with 9 business presets,
  white-label flag, dark mode, conversation persistence.
- Integrations wired: Gmail, Google Calendar, Slack, Mailchimp, Shopify, Vapi handoff.
- **3 live clients**: howhighscaffolding, dolled_by_louise, ej_roofing (`data/owners.json`).

### Voice (`~/aireyai_voice`) — works, but single-tenant
- V1 inbound answering on Kyle's own Twilio UK number: Vapi + Sonnet 4.6 + ElevenLabs, Calendly
  SMS booking links, Resend follow-up emails, call budget guard, JSONL audit log.
- **V2 (per-client assistants, number purchasing, admin) is roadmap only.** A renter cannot be
  provisioned today without manual one-off work.

### Outbound (`aria_caller`) — design doc only. Not built, not wired.

---

## 2. Promise vs. code — what we're selling that doesn't exist

| Promise (marketing) | Reality |
|---|---|
| Voice Pro £449/mo "CRM sync HubSpot/Pipedrive" | No CRM adapter anywhere in the voice lane. **Critical** — unbacked paid tier. |
| Per-client voice receptionist £249/mo | Single-tenant V1; only Kyle's number works. |
| "Lead reports" (BOT_ARIA tier) | No report generation code. Raw data files only. |
| "Monthly conversation review + retrain" | Manual (Kyle in the Vapi console). No API, no automation. |
| "1,500 call-minutes (Voice Pro)" | No minute-cap enforcement; budget guard checks £ spend only. |
| Bundle discounts / annual prepay | Stated on pricing pages, nothing enforces or tracks them. |

**Action:** either build these (roadmap below) or soften the copy now. Selling Voice Pro before
V2 multi-tenancy exists is the biggest exposure.

---

## 3. The core finding: Aria captures value but never *shows* it

The market scan was unambiguous: at £97–249/mo, chat quality is table stakes. What keeps an SMB
paying every month is **proof-of-ROI plumbing** — Rosie/Smith.ai push a call summary to the
owner's phone after *every* call; Podium/NiceJob show the Google-review count growing; everyone
at this tier ships a "revenue captured" dashboard.

Aria does the work (leads scored, bookings staged, emails answered) and then hides it in JSON
files the renter never sees. The renter's experience of £97/mo is an embed snippet and
occasional emails. That's a churn machine.

### Top renter-value gaps (ranked)
1. **No client dashboard** — `/dashboard` route is spec'd (v5 plan) but returns a placeholder.
   Renters can't see leads, conversations, bookings, or usage.
2. **No monthly value report** — the digest lists events but never frames ROI ("Aria answered
   214 chats, captured 9 leads, booked 4 jobs ≈ £2,300"). This single email is the cheapest
   churn-killer in the category.
3. **No lead export / CRM push** — no CSV, no Zapier-style standard webhook. Leads die in JSON.
4. **No per-client metering** — one global message cap and one shared Anthropic key. One spammy
   client throttles everyone; no renter can see their own usage.
5. **Self-serve onboarding built but unwired** — `lib/onboarding.js` (350 LOC, website scanner,
   SSRF guards) exists; the `/api/onboard/*` routes were never added to `server.js`.
6. **Text and voice are islands** — separate KBs, separate lead stores. A caller and a web
   visitor from the same business hit two different Arias.
7. **No missed-call-text-back** — the documented stickiest feature for local SMBs, and we
   already have Twilio in the voice lane.
8. **No chat→WhatsApp/SMS continuation** — visitor leaves the site, conversation dies.
9. **No review requests** — NiceJob charges £75–125/mo for this alone; the Starter Pack already
   promises a "Review Engine," so Aria should be the thing that delivers it.
10. **GDPR + security debt** — no data purge, no consent UI despite `data-gdpr` flag, no SAR
    export, leads are write-only forever; CORS reflects any origin with credentials; outbound
    webhooks unsigned; `ANTHROPIC_API_KEY` sits in `.env` inside the repo.

### Half-built inventory (libs written, never wired)
`lib/onboarding.js`, `lib/audio_intake.js` (Deepgram voice input), `lib/image_intake.js`
(photo upload — huge for trades quoting), `lib/channel_lead_scorer.js` (Meta/IG scoring),
widget upload button (HTML exists, no handler), `/admin/invite` flow, `/dashboard`.
Plus four stray `.zip` files in the repo root to delete.

---

## 4. New services: Aria as the business's front office, not a widget

Kyle's framing: "add more services to the bot itself… how it can better run their websites for
them and help their business." AireyAI builds the client's website AND rents them Aria — no
competitor has that loop. That's the moat:

### Tier A — Aria runs their website (unique to us)
- **KB self-learning → site updates**: weekly job clusters unanswered/frequent questions →
  one-click "add this FAQ to your website" (we control the repo; Aria opens the change, owner
  approves — two-stage, matches our approval pattern).
- **Content-gap radar**: "17 visitors asked about emergency callouts this month; your site
  doesn't mention them. Want a section?" → drafts the section.
- **Owner chat-ops**: owner texts/WhatsApps Aria "closed bank holiday Monday" → Aria updates
  site opening hours, KB, and Google Business Profile in one pass.
- **Monthly GBP post** drafted from real conversation themes (plugs into the existing
  gbp-guides system).

### Tier B — Aria runs their lead flow (market table-stakes we're missing)
- Missed-call-text-back (Twilio already in stack).
- Chat→WhatsApp continuation (capture number, keep the thread alive).
- Quote-chase + no-show reminder sequences (extend the existing 2-wave follow-up).
- Post-job review request texts + AI-drafted review replies (= the Starter Pack Review Engine).
- Photo upload in widget for trades ("send a photo of the damage") — `image_intake.js` is
  already written.

### Tier C — Aria proves its worth (retention plumbing)
- Client dashboard: conversations, leads, bookings, usage, transcripts.
- Instant WhatsApp summary to owner after every call/qualified chat.
- Monthly "Aria paid for itself" email with estimated £ captured.
- Per-client usage view + caps.

---

## 5. Roadmap (effort-ranked)

**This week (low effort, libs/specs exist):**
1. Wire `/dashboard` (leads, conversations, bookings, usage) — routes partially spec'd in v5 plan.
2. Lead CSV export + one standard outbound webhook (signed).
3. Per-client usage metering + per-client caps (split `usage.json` by owner).
4. Wire `lib/onboarding.js` routes + `/admin/invite`.
5. Monthly value email (template over data we already log).
6. Soften Voice Pro copy until CRM sync exists; delete dead zips; move secrets out of repo.

**This month:**
7. Missed-call-text-back + chat→WhatsApp continuation.
8. Review-request engine (delivers the Starter Pack promise).
9. Unify KB + lead ledger across text/voice (one Aria per business).
10. Widget photo upload (wire `image_intake.js`) for trade quoting.
11. GDPR: retention purge job, consent UI, SAR export, lead deletion.

**This quarter:**
12. Voice V2 multi-tenancy (per-client Vapi assistant + number provisioning).
13. KB self-learning → website/GBP update loop (Tier A — the moat).
14. CRM push (start with Zapier-compatible webhook, add HubSpot/Pipedrive if a client demands).
15. Embeddings for KB retrieval (current lexical match will miss paraphrases as KBs grow).

---

## 6. Risk register (fix regardless of roadmap)
- Shared Anthropic key + global cap = one client can take down all three live clients.
- `ANTHROPIC_API_KEY` in `.env` in the repo; Gmail tokens + admin pass in plain JSON.
- CORS wildcard-with-credentials; unsigned outbound webhooks.
- Write-only lead ledger with no purge = GDPR exposure that grows daily.
- No health endpoint / structured logging — a silent failure would look exactly like "no leads
  this week" (same failure class as the trading bot's 4-hour silence and outreach_auto's 18 days).
