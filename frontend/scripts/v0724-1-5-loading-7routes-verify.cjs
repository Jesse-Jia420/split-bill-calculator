// frontend/scripts/v0724-1-5-loading-7routes-verify.cjs
// UAT 0724-1 #5 续修: 7 个路由补 LoadingOverlay 后, Playwright verify 玻璃圆环 overlay 真的渲染

const path = require('path');
const fs = require('fs');

const HEADLESS_SHELL = '/home/node/.openclaw/workspace/.openclaw/workspace/.openclaw/workspace/.openclaw/.cache';
// 用 sandbox 路径
const SHELL_PATH = '/home/node/.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell';
const SCREENSHOT_DIR = '/home/node/.openclaw/workspace/.openclaw/media/browser/v0724-1-5-7routes-after';
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const API = process.env.SBC_API_URL || 'http://127.0.0.1:8449';
const FE = process.env.SBC_FE_URL || 'http://127.0.0.1:8448';

(async () => {
  let browser;
  try {
    const { chromium, devices } = require('playwright-core');
    browser = await chromium.launch({
      executablePath: SHELL_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const context = await browser.newContext({
      ...devices['iPhone 13'],
      hasTouch: true,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });

    await context.request.post(API + '/auth/send-code', {
      data: { email: 'demo@example.com' },
      headers: { 'Content-Type': 'application/json' },
    });
    await context.request.post(API + '/auth/verify-code', {
      data: { email: 'demo@example.com', code: '000000' },
      headers: { 'Content-Type': 'application/json' },
    });

    const page = await context.newPage();
    page.on('console', msg => { if (msg.type() === 'error') console.log('[console.error]', msg.text()); });
    page.on('pageerror', err => console.log('[pageerror]', err.message));

    // 先去 sessions 列表拿到 session_code
    await page.goto(FE + '/sessions', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    const sessionCode = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/s/"]');
      if (links.length === 0) return null;
      const m = links[0].getAttribute('href').match(/\/s\/([A-Z0-9]+)/);
      return m ? m[1] : null;
    });
    console.log('sessionCode:', sessionCode);

    if (!sessionCode) {
      console.log('NO SESSION CODE — aborting');
      await browser.close();
      return;
    }

    // 7 个路由 — 每个都打开看 LoadingOverlay 是否渲染 (glass ring + glass pill)
    const routes = [
      { path: `/s/${sessionCode}`, name: '01-s-code-detail', text: '正在打开账本' },
      { path: `/s/${sessionCode}/bills/new`, name: '02-s-code-bills-new', text: '正在打开账本' },
      { path: `/s/${sessionCode}/bills/1/edit`, name: '03-s-code-bills-edit', text: '正在打开账本' },
      { path: `/s/${sessionCode}/settle`, name: '04-s-code-settle', text: '正在打开账本结算' },
      { path: `/s/${sessionCode}/join`, name: '05-s-code-join', text: '正在打开账本' },
      { path: `/invites/test-token`, name: '06-invites-token', text: '正在打开账本' },
    ];

    for (const route of routes) {
      // 用 page.goto + 强制 networkidle 等待 API 返回 — 但 API 失败时不会 idle.
      // 改为: page.goto + 立刻 waitForTimeout 100ms 截图 (loading state 期间)
      await page.goto(FE + route.path, { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(150);  // 短延迟让 loading state 显
      const state = await page.evaluate(() => {
        const ring = document.querySelector('.glass-ring');
        const pill = document.querySelector('.loading-pill .text');
        const oldText = document.querySelector('main p')?.textContent?.trim() || null;
        return {
          hasGlassRing: !!ring,
          hasLoadingPill: !!pill,
          pillText: pill?.textContent || null,
          oldPText: oldText,
        };
      });
      console.log(route.name + ' (' + route.path + '):', JSON.stringify(state));
      await page.screenshot({ path: `${SCREENSHOT_DIR}/${route.name}.png`, fullPage: false });
    }

    // sessions/[id]/join 老路径
    await page.goto(FE + '/sessions/9/join', { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(150);
    const joinState = await page.evaluate(() => {
      const ring = document.querySelector('.glass-ring');
      const pill = document.querySelector('.loading-pill .text');
      return {
        hasGlassRing: !!ring,
        hasLoadingPill: !!pill,
        pillText: pill?.textContent || null,
      };
    });
    console.log('07-sessions-id-join:', JSON.stringify(joinState));
    await page.screenshot({ path: `${SCREENSHOT_DIR}/07-sessions-id-join.png`, fullPage: false });

    console.log('---DONE---');
  } catch (e) {
    console.log('ERROR:', e.message);
    console.log(e.stack);
  } finally {
    if (browser) await browser.close();
  }
})();