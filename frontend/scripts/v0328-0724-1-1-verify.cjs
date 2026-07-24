// frontend/scripts/v0328-0724-1-1-verify.cjs
// UAT 0724-1 #1: 账单 section 去框 + 按钮右侧对齐 (iPhone 13 @3x 验证)
//
// 验证:
// 1. .bills-card-head 没有 background (rgba transparent or none)
// 2. .bills-card-head 没有 border
// 3. .bills-card-head 没有 box-shadow / glass 装饰
// 4. 跟 .members-head 同源 (都是 0 bg / 0 border / 0 padding, 纯文字 header)
// 5. 查看结算 + 个人账单 按钮在 head 同一行右对齐
// 6. 移动端 flex-wrap 自然换行 (按钮不溢出)

const path = require('path');
const fs = require('fs');

const HEADLESS_SHELL = '/config/.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell';
const SCREENSHOT_DIR = '/home/node/.openclaw/workspace/.openclaw/media/browser/v0328-0724-1-1-bills-card-head';
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

(async () => {
  let browser;
  try {
    const { chromium, devices } = require(path.join('/config/workspace/split-bill-calculator/frontend', 'node_modules/playwright-core'));
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

    // 1. login via BE API (绕过 UI login click handler 触发问题)
    const API = 'http://127.0.0.1:8449';
    const loginRes = await context.request.post(API + '/auth/send-code', {
      data: { email: 'demo@example.com' },
      headers: { 'Content-Type': 'application/json' },
    });
    console.log('send-code:', loginRes.status());
    const verifyRes = await context.request.post(API + '/auth/verify-code', {
      data: { email: 'demo@example.com', code: '000000' },
      headers: { 'Content-Type': 'application/json' },
    });
    console.log('verify-code:', verifyRes.status());

    // 2. navigate to session 9 detail
    const page = await context.newPage();
    page.on('console', msg => { if (msg.type() === 'error') console.log('[console.error]', msg.text()); });
    page.on('pageerror', err => console.log('[pageerror]', err.message));

    await page.goto('https://test.jessejia.pp.ua/sessions/9', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // 3. verify .bills-card-head computed style
    const billsHeadStyle = await page.evaluate(() => {
      const el = document.querySelector('.bills-card-head');
      if (!el) return null;
      const s = getComputedStyle(el);
      return {
        exists: true,
        backgroundColor: s.backgroundColor,
        backgroundImage: s.backgroundImage,
        border: s.border,
        borderWidth: s.borderWidth,
        borderRadius: s.borderRadius,
        opacity: s.opacity,
        padding: s.padding,
        display: s.display,
        flexWrap: s.flexWrap,
        backdropFilter: s.backdropFilter || s.webkitBackdropFilter,
        boxShadow: s.boxShadow,
      };
    });
    console.log('--- bills-card-head ---');
    console.log(JSON.stringify(billsHeadStyle, null, 2));

    // 4. verify .members-head 对比
    const membersHeadStyle = await page.evaluate(() => {
      const el = document.querySelector('.members-head');
      if (!el) return null;
      const s = getComputedStyle(el);
      return {
        backgroundColor: s.backgroundColor,
        backgroundImage: s.backgroundImage,
        border: s.border,
        borderWidth: s.borderWidth,
        borderRadius: s.borderRadius,
        opacity: s.opacity,
        padding: s.padding,
        display: s.display,
        cursor: s.cursor,
      };
    });
    console.log('--- members-head (baseline) ---');
    console.log(JSON.stringify(membersHeadStyle, null, 2));

    // 5. verify bills action links in same row, right aligned
    const billsActionsLayout = await page.evaluate(() => {
      const head = document.querySelector('.bills-card-head');
      if (!head) return null;
      const headRect = head.getBoundingClientRect();
      const left = head.querySelector('.bills-card-head-left');
      const right = head.querySelector('.bills-card-head-right');
      const calc = head.querySelector('.bills-action-link');
      const personal = head.querySelectorAll('.bills-action-link')[1];
      return {
        head: { x: headRect.x, y: headRect.y, w: headRect.width, h: headRect.height },
        leftBox: left?.getBoundingClientRect(),
        rightBox: right?.getBoundingClientRect(),
        calcBox: calc?.getBoundingClientRect(),
        personalBox: personal?.getBoundingClientRect(),
      };
    });
    console.log('--- bills actions layout ---');
    console.log(JSON.stringify(billsActionsLayout, null, 2));

    // 6. screenshot
    await page.screenshot({ path: SCREENSHOT_DIR + '/01-session-9-bills-head.png', fullPage: true });
    console.log('saved 01-session-9-bills-head.png');

    // 7. mobile (320px) — 按钮放不下时是否换行
    await page.setViewportSize({ width: 320, height: 568 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: SCREENSHOT_DIR + '/02-mobile-320-bills-head.png', fullPage: true });
    console.log('saved 02-mobile-320-bills-head.png');

    await browser.close();
    console.log('done');
  } catch (e) {
    console.error('verify failed:', e.message);
    console.error(e.stack);
    if (browser) await browser.close();
    process.exit(1);
  }
})();