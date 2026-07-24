// frontend/scripts/v0724-1-3-swipe-verify.cjs
// UAT 0724-1 #3 (SessionCard swipe-style 删除按钮) 验证
// Playwright iPhone 13 @3x

const path = require('path');
const fs = require('fs');

const HEADLESS_SHELL = '/config/.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell';
const SCREENSHOT_DIR = '/home/node/.openclaw/workspace/.openclaw/media/browser/v0724-1-3-swipe';
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
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });

    const API = process.env.SBC_API_URL || 'http://127.0.0.1:8449';
    const FE = process.env.SBC_FE_URL || 'http://127.0.0.1:8448';

    const loginRes = await context.request.post(API + '/auth/send-code', {
      data: { email: 'xinhua1001@outlook.com' },
      headers: { 'Content-Type': 'application/json' },
    });
    console.log('send-code:', loginRes.status());
    const verifyRes = await context.request.post(API + '/auth/verify-code', {
      data: { email: 'xinhua1001@outlook.com', code: '000000' },
      headers: { 'Content-Type': 'application/json' },
    });
    console.log('verify-code:', verifyRes.status());

    const page = await context.newPage();
    page.on('console', msg => { if (msg.type() === 'error') console.log('[console.error]', msg.text()); });
    page.on('pageerror', err => console.log('[pageerror]', err.message));

    // /sessions — owner 看 swipe-style 删除按钮
    await page.goto(FE + '/sessions', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    // 1. swipe-trigger 存在
    const triggerExists = await page.evaluate(() => {
      const t = document.querySelector('[data-testid="swipe-trigger"]');
      return t ? true : false;
    });
    console.log('1. swipe-trigger exists:', triggerExists);

    // 2. 默认状态: .delete-btn invisible (opacity 0, width 0, pointer-events none)
    const defaultState = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="swipe-action-delete"]');
      if (!btn) return { exists: false };
      const style = getComputedStyle(btn);
      const rect = btn.getBoundingClientRect();
      return {
        exists: true,
        opacity: style.opacity,
        width: style.width,
        height: rect.height,
        pointerEvents: style.pointerEvents,
        ariaHidden: btn.getAttribute('aria-hidden'),
      };
    });
    console.log('2. default state:', JSON.stringify(defaultState, null, 2));
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-default-invisible.png`, fullPage: false });

    // 3. 模拟左滑 (mousedown + mousemove -80px + hold)
    const triggerSelector = '.session-card .session-swipe-wrap, [data-testid="swipe-trigger"]';
    const card = await page.locator(triggerSelector).first();
    const box = await card.boundingBox();
    if (!box) {
      console.log('NO TRIGGER BOX FOUND');
    } else {
      const startX = box.x + box.width - 10;
      const startY = box.y + box.height / 2;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX - 80, startY, { steps: 10 });
      await page.waitForTimeout(400);

      // 4. swipe 中: button 渐显
      const swipeMidState = await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="swipe-action-delete"]');
        if (!btn) return { exists: false };
        const style = getComputedStyle(btn);
        const rect = btn.getBoundingClientRect();
        return {
          opacity: style.opacity,
          width: rect.width,
          height: rect.height,
          pointerEvents: style.pointerEvents,
          ariaHidden: btn.getAttribute('aria-hidden'),
        };
      });
      console.log('4. swipe mid state:', JSON.stringify(swipeMidState, null, 2));
      await page.screenshot({ path: `${SCREENSHOT_DIR}/02-swiping.png`, fullPage: false });

      // 5. mouseup
      await page.mouse.up();
      await page.waitForTimeout(400);

      const afterSnap = await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="swipe-action-delete"]');
        if (!btn) return { exists: false };
        const style = getComputedStyle(btn);
        const rect = btn.getBoundingClientRect();
        return {
          opacity: style.opacity,
          width: rect.width,
          height: rect.height,
          pointerEvents: style.pointerEvents,
          ariaHidden: btn.getAttribute('aria-hidden'),
        };
      });
      console.log('5. after snap (>= 60 swipe):', JSON.stringify(afterSnap, null, 2));
      await page.screenshot({ path: `${SCREENSHOT_DIR}/03-after-snap.png`, fullPage: false });

      // 6. card-link 的 clip-path 应该让右边缘 56px
      const clipPath = await page.evaluate(() => {
        const link = document.querySelector('.session-card .card-link');
        if (!link) return { exists: false };
        const style = getComputedStyle(link);
        return {
          exists: true,
          clipPath: style.clipPath || style.webkitClipPath,
        };
      });
      console.log('6. card-link clip-path:', JSON.stringify(clipPath, null, 2));

      // 7. 点击删除按钮 (swipe-action-delete) → 应该开 modal
      const swipeBtn = await page.locator('[data-testid="swipe-action-delete"]').first();
      const swBtnBox = await swipeBtn.boundingBox();
      if (swBtnBox && swBtnBox.width > 0) {
        await swipeBtn.click({ timeout: 3000 });
        await page.waitForTimeout(500);
        const modalVisible = await page.evaluate(() => {
          const modal = document.querySelector('.modal-backdrop, .modal-box, [role="dialog"]');
          return modal ? { exists: true, role: modal.getAttribute('role'), text: modal.textContent.slice(0, 50) } : { exists: false };
        });
        console.log('7. after click swipe action:', JSON.stringify(modalVisible, null, 2));
        await page.screenshot({ path: `${SCREENSHOT_DIR}/04-modal-opened.png`, fullPage: false });

        // close modal
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      } else {
        console.log('7. SKIPPED: swipe button not visible (width=0)');
      }
    }

    console.log('---DONE---');
  } catch (e) {
    console.log('ERROR:', e.message);
    console.log(e.stack);
  } finally {
    if (browser) await browser.close();
  }
})();