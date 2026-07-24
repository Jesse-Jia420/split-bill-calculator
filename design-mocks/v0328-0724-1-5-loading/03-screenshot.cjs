// /home/node/.openclaw/workspace/sbc/split-bill-calculator/design-mocks/v0328-0724-1-5-loading/03-screenshot.cjs
// Screenshot 2 个 loading mockup HTML → PNG
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

  const files = [
    { html: '01-ios-spinner.html', out: '01-ios-spinner.png' },
    { html: '02-liquid-glass-scale.html', out: '02-liquid-glass-scale.png' },
  ];

  for (const { html, out } of files) {
    const page = await ctx.newPage();
    const url = 'file:///home/node/.openclaw/workspace/sbc/split-bill-calculator/design-mocks/v0328-0724-1-5-loading/' + html;
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    // capture mid-animation frame
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT_DIR, out), fullPage: false });
    console.log('screenshot:', out);
    await page.close();
  }

  await browser.close();
})();