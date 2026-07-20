const { chromium, devices } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-CN' });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:8448/auth/login', { waitUntil: 'networkidle' });
  await page.fill('#email', 'xinhua1001@outlook.com');
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
  const info = await pill.evaluate(el => {
    const s = window.getComputedStyle(el);
    const inner = el.querySelector('.currency-chip');
    const innerBox = inner ? inner.getBoundingClientRect() : null;
    return {
      outerClass: el.className,
      outerHTML: el.outerHTML.substring(0, 200),
      outerStyle: {
        minHeight: s.minHeight, height: s.height, padding: s.padding,
        fontSize: s.fontSize, borderRadius: s.borderRadius, border: s.border,
        display: s.display, width: s.width, maxWidth: s.maxWidth,
      },
      innerText: inner?.textContent.trim(),
      innerBox: innerBox ? {x: innerBox.x, y: innerBox.y, w: innerBox.width, h: innerBox.height} : null,
    };
  });
  console.log('Single pill:');
  console.log('  box:', JSON.stringify(box));
  console.log('  class:', info.outerClass);
  console.log('  outerHTML:', info.outerHTML);
  console.log('  styles:', JSON.stringify(info.outerStyle, null, 2));
  console.log('  inner:', info.innerText, JSON.stringify(info.innerBox));

  // Take element screenshot for visual verification
  await pill.screenshot({ path: '/tmp/single-pill-element.png' });
  console.log('Saved /tmp/single-pill-element.png');
  await browser.close();
})();
