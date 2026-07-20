// BillForm v0.3.20 Mockup Screenshot Script
// Output: 750×1624 @2x PNG
const path = require('path');
const { chromium } = require(path.resolve('/config/workspace/split-bill-calculator/frontend/node_modules/playwright'));

const HTML = '/config/workspace/split-bill-calculator/frontend/_mockup/mockup.html';
const PNG  = '/config/workspace/split-bill-calculator/frontend/_mockup/mockup-v0320.png';
const FULL = '/config/workspace/split-bill-calculator/frontend/_mockup/mockup-v0320-fullpage.png';

(async () => {
  const browser = await chromium.launch();
  // iPhone-ish logical viewport @2x DPR
  const ctx = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    deviceScaleFactorIsScale: 1,
    isMobile: false,           // no extra UA — desktop chromium fine
    hasTouch: false,
  });
  const page = await ctx.newPage();

  await page.goto(`file://${HTML}`, { waitUntil: 'load' });
  // wait for any web-fonts/network to settle (none here, but safe)
  await page.waitForLoadState('networkidle').catch(() => {});
  // small settle
  await page.waitForTimeout(150);

  // measure & sanity check pill boxes via DOM (just log, not for screenshot)
  const stats = await page.evaluate(() => {
    const pills = Array.from(document.querySelectorAll('.pill'));
    return pills.map((p) => {
      const r = p.getBoundingClientRect();
      return {
        state: p.classList.contains('exclusive') ? 'exclusive' : 'shared',
        text:  (p.textContent || '').trim().slice(0, 40),
        width: Math.round(r.width),
        height: Math.round(r.height),
        x: Math.round(r.x),
        y: Math.round(r.y),
      };
    });
  });
  console.log('PILL STATS:', JSON.stringify(stats, null, 2));

  // viewport screenshot (frame only, 375×812 logical → 750×1624 actual)
  await page.screenshot({
    path: PNG,
    fullPage: false,
    type: 'png',
    omitBackground: false,
  });
  console.log('Saved viewport PNG:', PNG);

  await browser.close();
})().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
