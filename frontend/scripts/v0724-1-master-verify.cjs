// frontend/scripts/v0724-1-master-verify.cjs
// UAT 0724-1 #2/#4/#7/#8 当前 bug 状态验证 (Master 自修前先看现状)
// Updated: 加 SCREENSHOT_DIR 写到 sandbox (sandbox 与 codeserver 共享 working tree)

const path = require('path');
const fs = require('fs');

const HEADLESS_SHELL = '/home/node/.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell';
const SCREENSHOT_DIR = '/home/node/.openclaw/workspace/.openclaw/media/browser/v0724-1-master-after';
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

    const API = process.env.SBC_API_URL || 'http://172.18.0.5:8449';
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

    // 1. /sessions — #2 SessionCard delete-btn
    await page.goto((process.env.SBC_FE_URL || 'http://172.18.0.5:8448') + '/sessions', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    const deleteBtnCheck = await page.evaluate(() => {
      const btn = document.querySelector('.session-card .delete-btn');
      if (!btn) return { exists: false };
      const rect = btn.getBoundingClientRect();
      const style = getComputedStyle(btn);
      return {
        exists: true,
        bbox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        borderRadius: style.borderRadius,
        padding: style.padding,
        minHeight: style.minHeight,
        aspectRatio: style.aspectRatio,
        lineHeight: style.lineHeight,
        display: style.display,
        isCircular: rect.width === rect.height && rect.width > 0,
      };
    });
    console.log('#2 SessionCard delete-btn AFTER fix:', JSON.stringify(deleteBtnCheck, null, 2));
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-sessions-list.png`, fullPage: false });

    // 2. /sessions/9/bills/new — #4 #7 #8
    await page.goto((process.env.SBC_FE_URL || 'http://172.18.0.5:8448') + '/sessions/9/bills/new', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    const timeInputCheck = await page.evaluate(() => {
      const input = document.querySelector('input[type="datetime-local"]#occurredAt');
      if (!input) return { exists: false };
      const rect = input.getBoundingClientRect();
      const style = getComputedStyle(input);
      const parent = input.parentElement;
      const parentRect = parent ? parent.getBoundingClientRect() : null;
      return {
        exists: true,
        bbox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        maxWidth: style.maxWidth,
        width: style.width,
        padding: style.padding,
        parentBbox: parentRect ? { x: parentRect.x, y: parentRect.y, w: parentRect.width, h: parentRect.height } : null,
        exceedsParent: parentRect ? rect.right > parentRect.right + 1 : false,
        exceedsViewport: rect.right > window.innerWidth,
      };
    });
    console.log('#4 time input AFTER fix:', JSON.stringify(timeInputCheck, null, 2));
    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-bills-new-top.png`, fullPage: false });

    // #7: .stack padding-bottom
    const formBottomCheck = await page.evaluate(() => {
      const form = document.querySelector('form#bill-form');
      if (!form) return { exists: false };
      const style = getComputedStyle(form);
      return {
        exists: true,
        paddingBottom: style.paddingBottom,
      };
    });
    console.log('#7 form paddingBottom AFTER fix:', JSON.stringify(formBottomCheck, null, 2));

    // scroll to bottom 看空白
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/03-bills-new-bottom.png`, fullPage: false });

    console.log('---DONE---');
  } catch (e) {
    console.log('ERROR:', e.message);
    console.log(e.stack);
  } finally {
    if (browser) await browser.close();
  }
})();