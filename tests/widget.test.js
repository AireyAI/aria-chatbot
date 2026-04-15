import { test, expect } from '@playwright/test';

const TEST_PAGE = '/tests/test-page.html';

// ─── Widget Loading ───────────────────────────────────────────────────────────

test.describe('Widget Loading', () => {
  test('chat button renders on page', async ({ page }) => {
    await page.goto(TEST_PAGE);
    const btn = page.locator('#_ac-btn');
    await expect(btn).toBeVisible({ timeout: 10000 });
  });

  test('clicking chat button opens window', async ({ page }) => {
    await page.goto(TEST_PAGE);
    const btn = page.locator('#_ac-btn');
    await expect(btn).toBeVisible({ timeout: 10000 });
    await btn.click();
    const win = page.locator('#_ac-win');
    await expect(win).toBeVisible({ timeout: 5000 });
  });

  test('chat window shows bot name', async ({ page }) => {
    await page.goto(TEST_PAGE);
    const btn = page.locator('#_ac-btn');
    await expect(btn).toBeVisible({ timeout: 10000 });
    await btn.click();
    await expect(page.locator('#_ac-win')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#_ac-win')).toContainText('TestBot');
  });
});

// ─── Chat Interaction ─────────────────────────────────────────────────────────

test.describe('Chat Interaction', () => {
  test('sending a message shows it in chat', async ({ page }) => {
    await page.goto(TEST_PAGE);
    const btn = page.locator('#_ac-btn');
    await expect(btn).toBeVisible({ timeout: 10000 });
    await btn.click();
    await expect(page.locator('#_ac-win')).toBeVisible({ timeout: 5000 });

    const input = page.locator('#_ac-win textarea, #_ac-win input[type="text"]');
    await input.fill('Hello test');
    await input.press('Enter');

    const userMsg = page.locator('.ac-msg.ac-user');
    await expect(userMsg.first()).toBeVisible({ timeout: 5000 });
    await expect(userMsg.first()).toContainText('Hello test');
  });

  test('bot responds to a message', async ({ page }) => {
    await page.goto(TEST_PAGE);
    const btn = page.locator('#_ac-btn');
    await expect(btn).toBeVisible({ timeout: 10000 });
    await btn.click();
    await expect(page.locator('#_ac-win')).toBeVisible({ timeout: 5000 });

    const input = page.locator('#_ac-win textarea, #_ac-win input[type="text"]');
    await input.fill('Hello');
    await input.press('Enter');

    const botMsg = page.locator('.ac-msg.ac-bot');
    await expect(botMsg.first()).toBeVisible({ timeout: 15000 });
  });
});

// ─── Responsive ───────────────────────────────────────────────────────────────

test.describe('Responsive', () => {
  test('widget works at mobile width (375px)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(TEST_PAGE);
    const btn = page.locator('#_ac-btn');
    await expect(btn).toBeVisible({ timeout: 10000 });
    await btn.click();
    await expect(page.locator('#_ac-win')).toBeVisible({ timeout: 5000 });
  });

  test('widget works at desktop width (1280px)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(TEST_PAGE);
    const btn = page.locator('#_ac-btn');
    await expect(btn).toBeVisible({ timeout: 10000 });
    await btn.click();
    await expect(page.locator('#_ac-win')).toBeVisible({ timeout: 5000 });
  });
});

// ─── Upload Button ────────────────────────────────────────────────────────────

test.describe('Upload Button', () => {
  test('upload button is visible', async ({ page }) => {
    await page.goto(TEST_PAGE);
    const btn = page.locator('#_ac-btn');
    await expect(btn).toBeVisible({ timeout: 10000 });
    await btn.click();
    await expect(page.locator('#_ac-win')).toBeVisible({ timeout: 5000 });

    const upload = page.locator('#_ac-upload');
    await expect(upload).toBeVisible({ timeout: 5000 });
  });
});

// ─── No Page Interference ─────────────────────────────────────────────────────

test.describe('No Page Interference', () => {
  test('widget does not break page scroll', async ({ page }) => {
    await page.goto(TEST_PAGE);
    const btn = page.locator('#_ac-btn');
    await expect(btn).toBeVisible({ timeout: 10000 });

    // Page should still be scrollable (not locked by widget)
    const canScroll = await page.evaluate(() => {
      const body = document.body;
      const html = document.documentElement;
      const style = window.getComputedStyle(body);
      return style.overflow !== 'hidden' && html.style.overflow !== 'hidden';
    });
    expect(canScroll).toBe(true);
  });
});
