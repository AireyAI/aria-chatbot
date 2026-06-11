# Aria Chatbot — Current Bot Capability Map (2026-06-11)

Codebase: `/Users/kyleairey/chatbot` — `server.js` (17,747 lines), widget `chatbot.js` (3,196 lines), 20 lib modules.

There are **three distinct "brains"** in production, and knowing which capability lives in which brain is the key to this map:

1. **Web widget legacy path** (`/api/chat` + `/api/chat/stream`) — system prompt built CLIENT-side in chatbot.js; bot "acts" via `::ACTION` text tags parsed by the widget. This is the DEFAULT for every embed (`data-endpoint` defaults to `/api/chat`, chatbot.js:191-193).
2. **Channel pipeline** (WhatsApp / FB Messenger / IG Direct via `/api/meta/webhook`) — by far the richest brain: structured-JSON replies with vision, voice-note transcription, slot-fill booking + conflict gate, quote drafting with owner approval, CSAT, gap learning, follow-up scheduling.
3. **Voice receptionist** (Vapi webhook `/api/vapi/webhook`) — multi-tenant phone answering, mid-call availability checks, post-call booking/quote fan-out.

Plus a fourth, **dormant** brain: the proper Anthropic tool-use router (`lib/lead_router.js` / `lead_router_stream.js` at `/api/chat/router[/stream]`) — wired server-side but opt-in only.

---

## (A) Every tool/action the bot can call today

### A1. Anthropic tool-use router (lib/tools.js → tool_handlers.js, served at `/api/chat/router` + `/api/chat/router/stream`)
| Tool | Behavior |
|---|---|
| `qualify_lead` | Claude proposes structured intent/urgency/contact; code scores 0-100 deterministically (≥70 hot, 40-69 warm, <40 FAQ). |
| `lookup_faq` | Reads canned answer from `clientConfig.canned` (the embed's `data-canned` JSON). |
| `create_lead_record` | Appends to `data/leads.jsonl` + fire-and-forget dual email (client `handoffEmail` + agency `NOTIFY_EMAIL`). No approval needed. |
| `send_whatsapp_to_owner` | Two-stage: stages to `pending_actions.jsonl`, emails owner a one-click `/api/pending/confirm?id&token` link; confirm executes a real WA send to the owner. |
| `book_calendar_slot` | Two-stage stage-and-confirm, **but the confirm handler is a stub** — it only emails the owner the booking JSON; no real `calendar.events.insert` (server.js:4687-4699 comment: "full calendar wiring is a follow-up"). |

Loop mechanics: max 6 iterations, usage summed across turns, streaming variant aborts cleanly on visitor disconnect and never dispatches side-effecting tools for a gone visitor.

### A2. Widget-path `::ACTION` pseudo-tools (legacy `/api/chat`, parsed in chatbot.js `parseRich`)
`::BUTTON[label](msg)`, `::HANDOFF` (live handoff session or contact card), `::IMAGE/::VIDEO/::DOCUMENT` rich embeds, `::BOOKING` (multi-step booking form → `/api/booking` → owner+visitor email with .ics + Google Calendar event via owner's connected Gmail), `::CHECK_AVAILABILITY` (fetches real slots from `/api/calendar/availability`, renders tappable slot picker), `::CALLBACK{json}` (→ `/api/chat/callback`: owner email + Slack + calendar entry), `::QUOTE{json}` (→ `/api/chat/quote`: owner email + lead record), `::DIRECTIONS`, `::CONTACT` (tel/mailto/wa.me card), `::SERVICES`, `::ORDER` (e-com order flow → `/api/order`), `::RESCHEDULE` (email lookup → `/api/booking/lookup` → cancel/reschedule via `/api/booking/cancel|reschedule`).

### A3. Channel-pipeline structured outputs (WA/FB/IG — every reply is JSON with these "implicit tools")
- **Booking slot-fill**: extracts name/contact/datetime across turns; when complete, runs `findBookingConflicts` (the double-book gate), saves booking, fires `confirmAndShipBooking` (ICS email to both sides + channel confirm), schedules 24h-before reminder + post-visit review request.
- **Quote drafting** (`quoteIntent`/`quoteDraft`): itemised line-item quote with currency/validity/caveat; auto-cap check — above owner's max it escalates to human; otherwise staged in `pendingQuotes` and owner gets approve / **edit (full web form)** / reject links (`/api/quotes/approve|edit|reject`); approved quote sent with "Book me in" chips, logged + `quote_sent` webhook.
- **Contact extraction** → lead scoring (`channel_lead_scorer`), lead ledger, `new_lead`/`hot_lead`/`angry_message` webhooks, hot-lead T+3min Claude-written follow-up email.
- **Sentiment + urgency classification**, `needsHuman` handoff with reason, **language detection + reply in customer's language** (any ISO-639-1).
- **`suggestedReplies`** → real quick-reply buttons (WA interactive buttons, FB/IG chips).
- **`showServicesCarousel`** → swipeable services card carousel sent as follow-up.
- **`bookingReminderResponse`** → classifies confirm/reschedule/cancel replies to reminders.
- **Vision**: customer photos resolved via `image_intake.js` (WA token-gated base64; FB/IG CDN URL blocks), max 4 × 5MB, with an explicit "LOOK at them" prompt rule — photos feed straight into quote/booking reasoning.
- **Voice notes**: `audio_intake.js` transcribes via Whisper (Groq preferred, OpenAI fallback, ~$0.003/30s) and feeds the transcript through the full pipeline — RAG, lead score, booking all work on voice for free.
- **CSAT**: closure-language detection triggers "did that help? 👍/👎" with 7-day cooldown.
- **Knowledge-gap logging**: vague-fallback or `outOfScope` replies appended to gaps ledger (feeds learning loop).
- **Approval mode**: owners can run channels in draft-first mode — `channelApprovals` staged, owner one-click `/api/channel/approve|reject`.
- **RAG**: `rag_retriever.js` BM25-lite keyword retrieval (500-char chunks, top-3) over owner-uploaded knowledge docs — used in channel pipeline (server.js:15955) and dashboard test sandbox; no embeddings by design.
- **Business hours**: `evaluateSchedule()` gates whether Aria replies now, silently, or with out-of-hours auto-reply, per-owner timezone.

### A4. Voice receptionist (Vapi — telephony provider)
- **Provider: Vapi** (api.vapi.ai), which bundles Twilio telephony + Deepgram nova-3 STT + Anthropic LLM + ElevenLabs TTS. Numbers provisioned/released from the dashboard via `/api/dashboard/phone/provision|release` (`provisionVapiNumber`, provider `'vapi'`); BYO-number paste also supported. Cost modelled at ~£0.11/min; plan-gated (`canUseVoice`) + per-owner answer schedule (`always | business_hours | out_of_hours`), off-schedule transfers to a fallback human number.
- **Per-call assistant built fresh** from the owner's live profile + KB (up to 6 docs inlined) — FAQ edits live on the next call.
- **Mid-call tool**: `check_availability` — parses datetime, runs the same conflict detector as DMs, tells the assistant free/taken.
- **End-of-call fan-out**: call ledger (transcript, recording, structured intent) → if intent=booking, routes through the SAME booking pipeline (conflict gate, ICS, reminders, review request) → **WhatsApp written confirmation to the caller** (booked / quote-coming / slot-clashed variants) → digest-aware owner notification (complaints = immediate).

### A5. Scheduled outbound tasks (`outbound_scheduler.js`, 60s tick, append-only ledger, replay-on-restart)
| Task | Behavior |
|---|---|
| `lead_followup` | T+3min Claude-written warm email to hot leads with captured email. |
| `booking_reminder` | 24h-before "still good for you?" with ✓/Reschedule/Cancel chips via channel + email; sets reminder-response state. |
| `noshow_check` | 2h-before: if reminder unanswered, alerts owner ("quick call now saves the slot") + `noshow_predicted` webhook. |
| `review_request` | N hours post-appointment, templated Google-review ask via original channel (email backup); opt-in via owner's review URL; own ledger + webhook. |
| `conv_recovery` | Daily sweep re-engages stale conversations ("circling back on your question about X") with chips. |

### A6. Other server-side bot capabilities
- **Outbound webhooks** (`webhook_dispatcher.js`): HMAC-signed, 3-retry (30s/2m/8m), events `new_lead`, `hot_lead`, `angry_message`, `new_booking`, `quote_sent`, `noshow_predicted`, `review_request_sent`, `booking_conflict_blocked` → Zapier/Make/CRM.
- **Email auto-reply** (Gmail watcher with approve/reject links, `/api/email-autoreply/*`).
- **Reviews capture**: public submit `/api/reviews/:slug` (sanitised, pending state, owner email + Slack alert), moderation PATCH, public GET serves approved only.
- **Learning loop** (`/api/admin/learning*`): knowledge gaps clustered into proposals → Kyle/owner approves with an answer → auto-promoted to live FAQ Aria uses on the next chat.
- **Shopify order lookup** + **CJ Dropshipping fulfilment engine** (order-paid webhook → supplier order → tracking poll).
- **Customer LTV** proxy (`customer_ltv.js`) for VIP/Engaged/Active tiers in customer memory.
- **Abandoned-chat recovery** (`/api/chat/abandoned`) + **chat summary email** (`/api/chat/summary`) + **auto-lead capture** (`/api/chat/auto-lead`).

## (B) Widget-side capabilities (chatbot.js)
- **Image upload — YES**: 📎 button → 5MB file → base64 → `/api/chat/upload` (one-shot Haiku vision call). *Caveat: this call is stateless — no conversation history, reply doesn't re-enter the lead/quote pipeline.*
- **Voice input — YES**: mic button via Web Speech API (`SpeechRecognition`/`webkitSpeechRecognition`), `voiceInputEnabled: true` default, hidden when unsupported.
- **Quick replies — YES**: niche-preset chips (9 industry presets: restaurant, salon, gym, healthcare, agency, ecommerce, legal, real-estate, trades) + AI `FOLLOWUPS:` suggested next questions + **auto-translation of quick replies into the visitor's browser language** (cached per-locale).
- **Booking UI — YES**: multi-step in-chat booking card (name → datetime → email → notes → confirm), real **calendar slot picker** from `/api/calendar/availability`, plus self-serve **reschedule/cancel by email lookup**, and an **order flow** for e-com.
- Smart action cards: callback-request, quote-request, directions (Google Maps), contact card (tel/email/WhatsApp), services cards, handoff card (book-a-call / WhatsApp / email) or **live human handoff** with polling.
- Site intelligence: page crawl + 24h-cached Haiku-built business profile injected into the prompt; canned-answer shortcuts; easter eggs; smart model selection (Haiku ↔ smarter model by message complexity) + dynamic max_tokens.
- Engagement: proactive nudges, cart-abandonment greeting + discount code, objection-handling presets, testimonial cards, NPS rating on close, A/B variant tracking, GDPR consent gate, sound effects/moods/floating emoji, export/clear chat, mobile keyboard viewport handling, auto lead detection (email/phone regex → `/api/chat/auto-lead`), chat-summary + abandoned-recovery beacons on exit.
- Streaming via `/api/chat/stream` (SSE).

## (C) Wired vs orphaned

**Fully wired and live:**
- Legacy widget path (`/api/chat`, `/api/chat/stream`) + all `::ACTION` tags — the production default.
- Channel pipeline (WA/FB/IG) with everything in A3 — the flagship.
- Voice receptionist incl. provisioning, schedule gate, post-call fan-out.
- Outbound scheduler + all 5 task handlers (scheduled from real triggers: hot lead, booking confirm, reminder, recovery sweep).
- Webhooks, reviews, learning loop, email auto-reply, business hours, LTV, RAG (channel + test sandbox), image + audio intake (channel side), quotes approval flow, booking conflict gate.

**Wired but dormant / half-wired:**
- **The Anthropic tool router** (`tools.js`, `tool_handlers.js`, `lead_router*.js`, `/api/chat/router[/stream]`, `/api/pending/confirm`) — fully functional server-side but **opt-in per client via `data-endpoint`; the default embed never touches it**. The "real" tool-use brain is effectively benched while production runs on `::ACTION` regex tags.
- **`book_calendar_slot` confirm is a stub** — approval just emails the owner the JSON; no calendar insert (even though `createCalendarEvent` exists and is used by `/api/booking` and callbacks — the wiring between them was never finished).
- **`lookup_faq`** only reads the embed's `data-canned`; it ignores the server-side `faqs` map and knowledge docs that the learning loop writes to — so approved learnings reach the channel brain but not the router brain.
- **SMS channel**: `channelConfigs` comment lists `sms` but `sendChannelReply` only implements whatsapp/instagram/facebook — **no SMS send path exists anywhere** (voice "text confirmation" is actually WhatsApp-only).
- **Widget RAG gap**: owner knowledge docs (`/api/dashboard/knowledge`) feed channels and the test sandbox, but the web widget's prompt is built client-side from page-crawl — server KB and learned FAQs don't reach website visitors (widget pulls `/api/faqs` only).

## (D) Top 10 bot-capability improvements, ranked (UK trade/salon SMB lens)

1. **Make the tool router the default widget brain** — retire the `::ACTION` regex layer by flipping `data-endpoint` to `/api/chat/router/stream` and porting the rich actions into real tools; one brain, auditable tool events, server-side prompt. Everything else below gets easier after this. **(M)**
2. **Missed-call-text-back** — the single highest-converting trade/salon feature and it's absent: when the voice line declines off-schedule, rings out, or a caller hangs up early (`endedReason`), auto-text "Sorry we missed you — what do you need? Reply here" via WA (and SMS once #4 lands). 60-80% of trade jobs start as a phone call. **(S — all the pieces exist: end-of-call report, WA sender, scheduler.)**
3. **Finish real calendar booking** — `book_calendar_slot` confirm should call the existing `createCalendarEvent` + write `bookings[]`, and `/api/calendar/availability` should drive the voice + channel conflict gate too (today conflicts only check Aria's own bookings, not the owner's actual Google Calendar). Double-booking is the #1 trust-killer the code itself names. **(M)**
4. **Native SMS channel (Twilio/Vapi SMS)** — implement the `sms` case in `sendChannelReply` + inbound webhook. UK trades' customers often have no WhatsApp Business relationship; reminders, review asks, and missed-call-text-back all multiply in reach. **(M)**
5. **Photo quotes on the web widget** — channels already do vision→quoteDraft, but the widget's upload is a stateless Haiku one-shot outside history and the quote pipeline. Route widget images into the main conversation (router path makes this trivial) so "send a photo of the leak, get an itemised quote draft" works on the website too — the marquee trade demo. **(S/M)**
6. **Payment links on quote-accept / booking deposit** — quote flow ends at "Book me in" with no money motion; add a Stripe payment-link line to approved quotes and an optional deposit on booking confirm (kills no-shows far harder than the reminder does; salons especially). Real-money integration → two-stage approval per Rule 12. **(M)**
7. **Quote follow-up task** — quotes are sent and ledgered but never chased; add a `quote_followup` scheduler task at T+48h ("any questions on the quote? It's valid for N more days"). Trades win jobs on the chase; this is five lines of scheduling plus one handler. **(S)**
8. **Serve learned knowledge to website visitors** — wire owner KB docs + learning-loop FAQs + RAG into the widget path's server prompt (today only channels benefit; the website — usually the busiest surface — answers from a page crawl). Also fixes router-brain `lookup_faq` ignoring the server FAQ map. **(S)**
9. **Review-request parity for web/voice bookings** — review_request is only scheduled from the channel `confirmAndShipBooking`; voice bookings get it via the shared pipeline but widget-form bookings (`/api/booking`) never do. One `scheduleTask` call closes the loop on the surface most salons actually take bookings from. **(S)**
10. **Multilingual voice + widget reply-language rule** — Deepgram transcriber is hardcoded `language: 'en'` and the widget prompt has no "reply in the visitor's language" rule (channels have it). Add auto language detect on voice + the one-line widget rule; matters for salons/cleaners in multilingual UK cities. **(S voice config + S widget; L only if doing full voice persona per language.)**

**Honourable mention (do during #1):** abort-safety and usage-tracking are already excellent in `lead_router_stream.js` — preserve that code path rather than rewriting it.