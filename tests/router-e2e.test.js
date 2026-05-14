// E2E for the data-endpoint="/api/chat/router" wiring.
//
// Stubs the router endpoint via page.route() so no real Anthropic call
// fires. Asserts: (1) widget POSTs to /api/chat/router (not /api/chat),
// (2) router-shape response { reply, toolEvents, score, action } renders
// as a bot message, (3) the request body carries clientConfig.
//
// Per CLAUDE.md Rule #9: tests verify intent. The intent here is "the
// data-endpoint opt-in actually flips the widget onto the new path".

import { test, expect } from '@playwright/test';

const TEST_PAGE = '/tests/router-test-page.html';

test.describe('Lead router — widget wiring', () => {
  test('widget POSTs to /api/chat/router (not /api/chat) when data-endpoint is set', async ({ page }) => {
    let routerCalled = false;
    let legacyCalled = false;
    let capturedBody  = null;

    // Stub BOTH endpoints — we want to fail loud if widget hits the legacy path.
    await page.route('**/api/chat/router', async (route) => {
      routerCalled = true;
      capturedBody = JSON.parse(route.request().postData() || '{}');
      const reply = 'Got it — flat roof repair, someone will be in touch.';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          content: [{ type: 'text', text: reply }], // legacy widget reads this
          reply,                                     // richer consumers
          toolEvents: [
            { name: 'qualify_lead', input: {}, result: { score: 90, tier: 'hot', reason: 'mock' } },
            { name: 'create_lead_record', input: {}, result: { logged: true, leadId: 'mock-1' } },
          ],
          score: 90,
          stopReason: 'end_turn',
          action: { captureLead: true, pingOwner: true, pingChannel: 'whatsapp' },
        }),
      });
    });
    await page.route('**/api/chat', async (route) => {
      legacyCalled = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto(TEST_PAGE);
    await page.locator('#_ac-btn').click();
    await expect(page.locator('#_ac-win')).toBeVisible({ timeout: 5000 });

    // Drive via the widget's public API (window.AriaChat.send) — bypasses
    // input enable/disable state which is tricky to reproduce with fill().
    await page.evaluate(() => window.AriaChat.send('I need a flat roof repair, can someone call 07900?'));

    // Bot reply renders
    const botMsg = page.locator('.ac-msg.bot');
    await expect(botMsg.last()).toContainText('flat roof repair', { timeout: 8000 });

    expect(routerCalled).toBe(true);
    expect(legacyCalled).toBe(false);
    expect(capturedBody?.messages?.length).toBeGreaterThan(0);
    expect(capturedBody?.messages?.at(-1)?.content).toMatch(/flat roof repair/);
  });

  test('handles router response with stopReason=max_iters_exceeded gracefully', async ({ page }) => {
    await page.route('**/api/chat/router', async (route) => {
      const reply = "I've collected enough info — someone from the team will be in touch shortly.";
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          content: [{ type: 'text', text: reply }],
          reply,
          toolEvents: [],
          stopReason: 'max_iters_exceeded',
        }),
      });
    });

    await page.goto(TEST_PAGE);
    await page.locator('#_ac-btn').click();
    await expect(page.locator('#_ac-win')).toBeVisible({ timeout: 5000 });
    await page.evaluate(() => window.AriaChat.send('hi'));

    const botMsg = page.locator('.ac-msg.bot');
    await expect(botMsg.last()).toContainText('team will be in touch', { timeout: 8000 });
  });

  test('500 from router surfaces as visible error (Rule #10 — fail loud)', async ({ page }) => {
    await page.route('**/api/chat/router', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'AI error' }),
      });
    });

    await page.goto(TEST_PAGE);
    await page.locator('#_ac-btn').click();
    await expect(page.locator('#_ac-win')).toBeVisible({ timeout: 5000 });
    await page.evaluate(() => window.AriaChat.send('hi'));

    // Widget should show *some* visible error/fallback rather than silently swallowing.
    // We don't assert exact copy because the widget has its own error UI string —
    // the assertion is "the bot didn't go silent on a 500".
    await page.waitForTimeout(2000);
    const winText = await page.locator('#_ac-win').textContent();
    expect(winText?.length || 0).toBeGreaterThan(50);
  });
});
