const { chromium, devices } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-CN' });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:8448/auth/login', { waitUntil: 'networkidle' });
  await page.fill('#email', 'demo@example.com');
  await page.click('button.btn.btn-primary');
  await page.waitForTimeout(1500);
  await page.fill('#code', '000000');
  const btn = await page.$('button.btn.btn-primary');
  await btn.click();
  await page.waitForLoadState('networkidle');
  // Multi bar (id=12)
  await page.goto('http://127.0.0.1:8448/sessions/12', { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-sbc="currency-bar-edit"]', { timeout: 5000 });
  await page.waitForTimeout(500);
  const bar = await page.$('[data-sbc="currency-bar-edit"]');
  const box = await bar.boundingBox();
  const info = await bar.evaluate(el => {
    const s = window.getComputedStyle(el);
    return {
      outerClass: el.className,
      outerStyle: {
        minHeight: s.minHeight, height: s.height, padding: s.padding,
        fontSize: s.fontSize, borderRadius: s.borderRadius,
        display: s.display, width: s.width,
      },
    };
  });
  console.log('Multi bar:');
  console.log('  box:', JSON.stringify(box));
  console.log('  class:', info.outerClass);
  console.log('  styles:', JSON.stringify(info.outerStyle, null, 2));
  // Element screenshot
  await bar.screenshot({ path: '/tmp/multi-bar-element.png' });
  console.log('Saved /tmp/multi-bar-element.png');
  await browser.close();
})();
