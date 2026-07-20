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
  // Single EUR pill (id=131)
  await page.goto('http://127.0.0.1:8448/sessions/131', { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-sbc="currency-pill-add-secondary"]', { timeout: 5000 });
  await page.waitForTimeout(500);
  const pill = await page.$('[data-sbc="currency-pill-add-secondary"]');
  const box = await pill.boundingBox();
  const styles = await pill.evaluate(el => {
    const s = window.getComputedStyle(el);
    return {
      minHeight: s.minHeight, height: s.height, padding: s.padding,
      fontSize: s.fontSize, boxSizing: s.boxSizing,
    };
  });
  console.log('Single pill:', JSON.stringify(box), JSON.stringify(styles));

  // Multi bar (id=12, no bills)
  await page.goto('http://127.0.0.1:8448/sessions/12', { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-sbc="currency-bar-edit"]', { timeout: 5000 });
  await page.waitForTimeout(500);
  const bar = await page.$('[data-sbc="currency-bar-edit"]');
  const bbox = await bar.boundingBox();
  const bstyles = await bar.evaluate(el => {
    const s = window.getComputedStyle(el);
    return {
      minHeight: s.minHeight, height: s.height, padding: s.padding,
      fontSize: s.fontSize, boxSizing: s.boxSizing,
    };
  });
  console.log('Multi bar:', JSON.stringify(bbox), JSON.stringify(bstyles));
  await browser.close();
})();