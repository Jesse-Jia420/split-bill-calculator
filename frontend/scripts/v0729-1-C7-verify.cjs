const { chromium, devices } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-CN' });
  await ctx.request.post('https://test.jessejia.pp.ua/api/auth/send-code', { data: { email: 'demo@example.com' }, headers: { 'Content-Type': 'application/json' } });
  await ctx.request.post('https://test.jessejia.pp.ua/api/auth/verify-code', { data: { email: 'demo@example.com', code: '000000' }, headers: { 'Content-Type': 'application/json' } });
  const page = await ctx.newPage();
  await page.goto('https://test.jessejia.pp.ua/sessions/9', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.bills-search', { timeout: 15000 });
  await page.waitForTimeout(800);
  // scroll to bring card head + search into view
  await page.evaluate(() => {
    const el = document.querySelector('.bills-card-head');
    if (el) el.scrollIntoView({ block: 'start' });
  });
  await page.waitForTimeout(500);
  
  const info = await page.evaluate(() => {
    const head = document.querySelector('.bills-card-head');
    const search = document.querySelector('.bills-search');
    return {
      headMarginBottom: head ? getComputedStyle(head).marginBottom : null,
      searchMarginTop: search ? getComputedStyle(search).marginTop : null,
      headRect: head ? head.getBoundingClientRect() : null,
      searchRect: search ? search.getBoundingClientRect() : null,
      gap: head && search ? search.getBoundingClientRect().top - head.getBoundingClientRect().bottom : null,
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await page.screenshot({ path: '/home/node/.openclaw/media/browser/v0729-1-C7-gap.png', fullPage: false });
  await browser.close();
})();