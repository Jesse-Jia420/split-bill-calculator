const { chromium, devices } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-CN' });
  // login via BE API to avoid UI login issues
  await ctx.request.post('https://test.jessejia.pp.ua/api/auth/send-code', { data: { email: 'demo@example.com' }, headers: { 'Content-Type': 'application/json' } });
  await ctx.request.post('https://test.jessejia.pp.ua/api/auth/verify-code', { data: { email: 'demo@example.com', code: '000000' }, headers: { 'Content-Type': 'application/json' } });
  const page = await ctx.newPage();
  await page.goto('https://test.jessejia.pp.ua/sessions/9', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.invite-btn', { timeout: 15000 });
  await page.waitForTimeout(500);
  await page.locator('.invite-btn').first().click();
  await page.waitForSelector('.invite-modal-title', { timeout: 8000 });
  await page.waitForTimeout(500);
  
  const info = await page.evaluate(() => {
    const title = document.querySelector('.invite-modal-title');
    const sub = document.querySelector('.invite-modal-sub');
    return {
      title: title ? {
        text: title.textContent?.trim(),
        fontSize: getComputedStyle(title).fontSize,
        fontFamily: getComputedStyle(title).fontFamily,
        fontWeight: getComputedStyle(title).fontWeight,
        letterSpacing: getComputedStyle(title).letterSpacing,
        webkitTextSizeAdjust: getComputedStyle(title).webkitTextSizeAdjust,
      } : null,
      sub: sub ? {
        text: sub.textContent?.trim(),
        fontSize: getComputedStyle(sub).fontSize,
        fontFamily: getComputedStyle(sub).fontFamily,
      } : null,
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await page.screenshot({ path: '/home/node/.openclaw/media/browser/v0729-1-C5-font.png', fullPage: false });
  await browser.close();
})();