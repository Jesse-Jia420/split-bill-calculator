const { chromium, devices } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-CN' });
  await ctx.request.post('https://test.jessejia.pp.ua/api/auth/send-code', { data: { email: 'xinhua1001@outlook.com' }, headers: { 'Content-Type': 'application/json' } });
  await ctx.request.post('https://test.jessejia.pp.ua/api/auth/verify-code', { data: { email: 'xinhua1001@outlook.com', code: '000000' }, headers: { 'Content-Type': 'application/json' } });
  const page = await ctx.newPage();

  for (const url of ['/sessions/9', '/sessions/9/settle', '/sessions/9/bills/new']) {
    console.log('=== URL:', url);
    try {
      await page.goto('https://test.jessejia.pp.ua' + url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500);
      const info = await page.evaluate(() => {
        const avatars = document.querySelectorAll('.avatar, .avatar-a, .avatar-mini, .chip-avatar, .ppt-avatar, [class*="avatar"]');
        return Array.from(avatars).slice(0, 6).map(a => {
          const cs = getComputedStyle(a);
          return {
            class: a.className,
            bgColor: cs.backgroundColor,
            bgImage: cs.backgroundImage,
            inlineStyle: a.getAttribute('style'),
            text: (a.textContent || '').trim().slice(0, 2),
          };
        });
      });
      console.log(JSON.stringify(info, null, 2));
    } catch (e) {
      console.log('error:', e.message);
    }
  }
  await browser.close();
})();