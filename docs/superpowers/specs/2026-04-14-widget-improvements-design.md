# Aria Widget v4 — 10 Improvements Spec

**Date:** 2026-04-14
**File:** `chatbot.js` (single file, all changes inline)
**Dependencies:** None — everything stays self-contained

---

## 1. Markdown & Link Rendering

**Problem:** `makeBotBubble` uses `textContent`, so bold, links, lists from Claude render as plain text.

**Solution:** Add `parseMarkdown(text)` function (~60 lines) that converts:
- `**bold**` → `<strong>`
- `*italic*` → `<em>`
- `` `code` `` → `<code>`
- `[text](url)` → `<a target="_blank" rel="noopener">`
- Bare URLs (`https://...`) → clickable `<a>`
- `- item` / `1. item` → `<ul>` / `<ol>`

**Integration:** Bot bubbles switch from `textContent` to `innerHTML` with parsed output. User messages stay as `textContent` (no XSS risk). Applied in `makeBotBubble()` and `deliverResponse()`.

**Security:** Input is from the Claude API (trusted), but we still escape HTML entities before parsing markdown tokens to prevent any injection from site-crawled content that leaks into responses.

---

## 2. Retry Button on Error

**Problem:** Error catch in `sendMessage` shows plain text "try sending that again" with no action.

**Solution:** Replace the error bubble with a styled card containing:
- The error message text
- A "Retry" button that re-sends the last user message

**Integration:** In the `sendMessage` catch block. Store `lastFailedMessage` before the try block, use it in the retry handler.

**CSS:** `.ac-retry-btn` styled like `.ac-rich-btn` for consistency.

---

## 3. Message Copy Button

**Problem:** No way to copy bot responses (useful for pricing, addresses, contact info).

**Solution:** Add a small copy icon (📋) that appears on hover over bot messages. Click copies plain text to clipboard. Shows brief "Copied!" feedback via the existing `toast()` function.

**Integration:** Added inside `makeBotBubble()`. CSS handles show/hide on hover. Touch devices: icon always visible on bot messages.

**CSS:** `.ac-copy-btn` absolutely positioned top-right of `.ac-msg.bot`, hidden by default, shown on `:hover` and on touch devices.

---

## 4. Offline Detection

**Problem:** Messages silently fail when the user loses connection.

**Solution:**
- Listen to `online`/`offline` events on `window`
- When offline: show a banner below the header ("You're offline"), disable send button
- When back online: hide banner, re-enable send
- No message queueing (adds complexity for little value — user can just resend)

**Integration:** New `initOfflineDetection()` called from `init()`. Banner element `#_ac-offline` inserted after `#_ac-hdr`.

**CSS:** `#_ac-offline` styled as a subtle warning bar.

---

## 5. Phone Number Auto-Linking

**Problem:** Phone numbers in bot responses aren't tappable on mobile.

**Solution:** In `parseMarkdown()`, after markdown processing, detect phone patterns and wrap in `<a href="tel:...">`.

**Patterns:** `+XX XXX XXX XXXX`, `0XXXX XXXXXX`, `(XXX) XXX-XXXX`, and common UK/US formats.

**Regex:** `/(\+?[\d][\d\s\-().]{8,15}\d)/g` — same pattern already used in site crawling, applied to bot output.

---

## 6. `prefers-reduced-motion`

**Problem:** All animations run regardless of OS accessibility settings.

**Solution:**
- Add `@media (prefers-reduced-motion: reduce)` CSS block that kills all animations and transitions
- JS check: `const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches`
- `confetti()` early-returns if `reducedMotion`
- `floatEmoji()` early-returns if `reducedMotion`
- Toggle button glow disabled
- Typing dots animation disabled

**Integration:** CSS block added to `STYLES`. JS check added at top of IIFE, referenced in `confetti()` and `floatEmoji()`.

---

## 7. ARIA Live Region

**Problem:** Screen readers don't get notified when new bot messages appear.

**Solution:**
- Add `<div id="_ac-live" aria-live="polite" aria-atomic="true">` visually hidden in the widget root
- When a bot message is rendered, set its text content into the live region
- Clear after 1 second to avoid stacking

**Integration:** Element added in `buildWidget()`. Updated in `makeBotBubble()`.

**CSS:** `#_ac-live` uses `sr-only` pattern (clip, 1px, overflow hidden).

---

## 8. Image Lightbox

**Problem:** `::IMAGE` renders inline with no way to zoom or expand.

**Solution:**
- Make `::IMAGE` images clickable (`cursor: pointer`)
- On click: create a full-screen overlay with the image centered
- Close on: click outside, close button, Escape key
- Smooth fade-in animation

**Integration:** Click handler added in `renderRichElements()` where images are created. Lightbox elements created on-demand.

**CSS:** `#_ac-lightbox` fixed fullscreen, dark backdrop, centered image with max-width/max-height constraints.

---

## 9. Snappier Thinking Indicator

**Problem:** Artificial delay before thinking indicator appears makes the bot feel slow.

**Solution:**
- Show thinking indicator immediately when message is sent (remove the `await delay(500 + random)` before it)
- Keep a shorter 200ms delay for the response to feel natural (not instant)
- Add a subtle text fade animation to the thinking message rotation

**Integration:** Modify the timing in `sendMessage()`. Add CSS animation for thinking text.

---

## 10. Quick Reply i18n

**Problem:** Quick replies are English-only but system prompt tells Claude to match browser language.

**Solution:**
- Detect `navigator.language`
- If not English (`!lang.startsWith('en')`), translate quick replies via the existing site profile AI call
- Cache translated replies in `sessionStorage` key `_ac_qr_{lang}`
- Fallback to English if translation fails or takes too long (2s timeout)

**Integration:** New `translateQuickReplies()` async function called from `crawlSite()` (already async, non-blocking). Updates `CONFIG.quickReplies` in-place when translation completes.

---

## Testing

All features tested by:
1. Opening the widget on the demo page
2. Sending messages that trigger markdown, links, phone numbers
3. Toggling offline mode in browser DevTools
4. Testing with `prefers-reduced-motion` enabled
5. Screen reader testing for ARIA live region
6. Mobile testing for copy button and phone links
7. Clicking images for lightbox
8. Testing with non-English browser language
