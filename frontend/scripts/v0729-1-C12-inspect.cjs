const { chromium, devices } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-CN' });
  await ctx.request.post('https://test.jessejia.pp.ua/api/auth/send-code', { data: { email: 'demo@example.com' }, headers: { 'Content-Type': 'application/json' } });
  await ctx.request.post('https://test.jessejia.pp.ua/api/auth/verify-code', { data: { email: 'demo@example.com', code: '000000' }, headers: { 'Content-Type': 'application/json' } });
  const page = await ctx.newPage();

  // /sessions/9/settle — pick the 1st avatar from SettleTransferPath (建议转账)
  await page.goto('https://test.jessejia.pp.ua/sessions/9/settle', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  
  const info = await page.evaluate(() => {
    const result = [];
    // Find ALL elements with avatar class
    const all = document.querySelectorAll('[class*="avatar"]');
    all.forEach((a, idx) => {
      const cs = getComputedStyle(a);
      result.push({
        idx,
        tag: a.tagName,
        class: a.className,
        inlineStyle: a.getAttribute('style'),
        bgColor: cs.backgroundColor,
        bgImage: cs.backgroundImage,
        text: (a.textContent || '').trim().slice(0, 3),
        outerHtml: a.outerHTML.slice(0, 200),
      });
    });
    return result;
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})();