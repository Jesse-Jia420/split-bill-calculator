// Headless screenshot script for v0318-68 mockups
// Captures each HTML at 320 / 375 / 768 viewport widths
const { chromium } = require('/config/workspace/split-bill-calculator/frontend/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const MOCKUPS_DIR = '/config/workspace/split-bill-calculator/frontend/design-mocks';
const SHOTS_DIR = path.join(MOCKUPS_DIR, 'screenshots');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const variants = ['CURRENT', 'A', 'B', 'C'];
const viewports = [
  { name: '320', w: 320, h: 1500 },
  { name: '375', w: 375, h: 1300 },
  { name: '768', w: 768, h: 1500 },
];

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const baseUrl = 'http://127.0.0.1:8450';
  for (const v of variants) {
    const url = `${baseUrl}/v0318-68-bills-header-${v}.html`;
    for (const vp of viewports) {
      const ctx = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
        deviceScaleFactor: 2,
      });
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: 'networkidle' });
      // wait for fonts / paint
      await page.waitForTimeout(400);
      const outPath = path.join(SHOTS_DIR, `v0318-68-bills-header-${v}-${vp.name}.png`);
      await page.screenshot({ path: outPath, fullPage: true });
      console.log(`saved ${outPath} (${vp.w}×${vp.h} @2x)`);
      await ctx.close();
    }
  }
  await browser.close();
  console.log('all screenshots saved');
})().catch(e => { console.error('FATAL', e); process.exit(1); });