// frontend/scripts/v0724-1-3-swipe-verify-touch.cjs
// UAT 0724-1 #3 verify using touchscreen (iOS Safari actual path)

const path = require('path');
const fs = require('fs');

const HEADLESS_SHELL = '/config/.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell';
const SCREENSHOT_DIR = '/home/node/.openclaw/workspace/.openclaw/media/browser/v0724-1-3-touch';
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

(async () => {
  let browser;
  try {
    const { chromium, devices } = require('playwright-core');
    browser = await chromium.launch({
      executablePath: HEADLESS_SHELL,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const context = await browser.newContext({
      ...devices['iPhone 13'],
      hasTouch: true,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });

    const API = 'http://127.0.0.1:8449';
    const FE = 'http://127.0.0.1:8448';

    await context.request.post(API + '/auth/send-code', {
      data: { email: 'xinhua1001@outlook.com' },
      headers: { 'Content-Type': 'application/json' },
    });
    await context.request.post(API + '/auth/verify-code', {
      data: { email: 'xinhua1001@outlook.com', code: '000000' },
      headers: { 'Content-Type': 'application/json' },
    });

    const page = await context.newPage();
    page.on('console', msg => { if (msg.type() === 'error') console.log('[console.error]', msg.text()); });
    page.on('pageerror', err => console.log('[pageerror]', err.message));

    await page.goto(FE + '/sessions', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    // Default state
    const defaultState = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="swipe-action-delete"]');
      if (!btn) return { exists: false };
      const style = getComputedStyle(btn);
      return { exists: true, opacity: style.opacity, width: style.width, ariaHidden: btn.getAttribute('aria-hidden') };
    });
    console.log('1. default state:', JSON.stringify(defaultState, null, 2));

    // Use touchscreen.tap and swipe sequences (iOS-like)
    const card = await page.locator('[data-testid="swipe-trigger"]').first();
    const box = await card.boundingBox();
    const startX = box.x + box.width - 20;
    const startY = box.y + box.height / 2;
    console.log('swipe start:', startX, startY, 'box:', box);

    // Page.touchscreen doesn't have swipe — use evaluate to dispatch touch events directly
    await page.evaluate((args) => {
      const [x, y] = args;
      const target = document.elementFromPoint(x, y);
      if (!target) return;
      const touch1 = new Touch({
        identifier: 1,
        target,
        clientX: x,
        clientY: y,
        pageX: x,
        pageY: y,
      });
      const touchStart = new TouchEvent('touchstart', {
        bubbles: true,
        cancelable: true,
        touches: [touch1],
        targetTouches: [touch1],
        changedTouches: [touch1],
      });
      target.dispatchEvent(touchStart);
    }, [startX, startY]);

    await page.waitForTimeout(100);

    // Touch move -80px (4 steps of -20px)
    for (let i = 1; i <= 4; i++) {
      const newX = startX - 20 * i;
      await page.evaluate((args) => {
        const [x, y] = args;
        const target = document.elementFromPoint(x, y) || document.body;
        const touch1 = new Touch({
          identifier: 1,
          target,
          clientX: x,
          clientY: y,
          pageX: x,
          pageY: y,
        });
        const touchMove = new TouchEvent('touchmove', {
          bubbles: true,
          cancelable: true,
          touches: [touch1],
          targetTouches: [touch1],
          changedTouches: [touch1],
        });
        target.dispatchEvent(touchMove);
      }, [newX, startY]);
      await page.waitForTimeout(50);
    }

    // Mid state
    const midState = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="swipe-action-delete"]');
      if (!btn) return { exists: false };
      const style = getComputedStyle(btn);
      const rect = btn.getBoundingClientRect();
      return {
        exists: true,
        opacity: style.opacity,
        width: rect.width,
        height: rect.height,
        ariaHidden: btn.getAttribute('aria-hidden'),
        pointerEvents: style.pointerEvents,
      };
    });
    console.log('2. mid-swipe state:', JSON.stringify(midState, null, 2));
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-mid.png`, fullPage: false });

    // Touch end
    await page.evaluate((args) => {
      const [x, y] = args;
      const touch1 = new Touch({
        identifier: 1,
        target: document.body,
        clientX: x,
        clientY: y,
        pageX: x,
        pageY: y,
      });
      const touchEnd = new TouchEvent('touchend', {
        bubbles: true,
        cancelable: true,
        touches: [],
        targetTouches: [],
        changedTouches: [touch1],
      });
      document.body.dispatchEvent(touchEnd);
    }, [startX - 80, startY]);

    await page.waitForTimeout(500);

    // After snap
    const afterSnap = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="swipe-action-delete"]');
      if (!btn) return { exists: false };
      const style = getComputedStyle(btn);
      const rect = btn.getBoundingClientRect();
      return {
        exists: true,
        opacity: style.opacity,
        width: rect.width,
        height: rect.height,
        ariaHidden: btn.getAttribute('aria-hidden'),
        pointerEvents: style.pointerEvents,
        style: btn.getAttribute('style'),
      };
    });
    console.log('3. after snap state:', JSON.stringify(afterSnap, null, 2));
    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-after-snap.png`, fullPage: false });

    console.log('---DONE---');
  } catch (e) {
    console.log('ERROR:', e.message);
    console.log(e.stack);
  } finally {
    if (browser) await browser.close();
  }
})();