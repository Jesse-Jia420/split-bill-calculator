// Screenshot Option C glass-ring
const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('/home/node/.openclaw/workspace/sbc/split-bill-calculator/frontend/node_modules/playwright-core');

const HEADLESS_SHELL = '/home/node/.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell';
const OUT_DIR = '/home/node/.openclaw/workspace/.openclaw/media/browser/v0328-0724-1-5-loading';
fs.mkdirSync(OUT_DIR, { recursive: true });

(async () => {
  const browser = await chromium.launch({
    executablePath: HEADLESS_SHELL,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const ctx = await browser.newContext({
    ...devices['iPhone 13'],
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  const page = await ctx.newPage();
  const url = 'file:///home/node/.openclaw/workspace/sbc/split-bill-calculator/design-mocks/v0328-0724-1-5-loading/03-glass-ring.html';
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  // capture mid-rotation frame (rotation period 900ms, wait ~225ms = quarter turn)
  await page.waitForTimeout(225);
  await page.screenshot({ path: path.join(OUT_DIR, '03-glass-ring.png'), fullPage: false });
  console.log('screenshot: 03-glass-ring.png');
  await browser.close();
})();