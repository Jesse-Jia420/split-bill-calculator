const { chromium, devices } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-CN' });
  await ctx.request.post('https://test.jessejia.pp.ua/api/auth/send-code', { data: { email: 'demo@example.com' }, headers: { 'Content-Type': 'application/json' } });
  await ctx.request.post('https://test.jessejia.pp.ua/api/auth/verify-code', { data: { email: 'demo@example.com', code: '000000' }, headers: { 'Content-Type': 'application/json' } });
  const page = await ctx.newPage();
  await page.goto('https://test.jessejia.pp.ua/sessions/9', { waitUntil: 'networkidle' });
  await page.waitForSelector('.bills-search', { timeout: 15000 });
  await page.waitForTimeout(1500);

  // Disable sticky by measuring at scroll 0
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  // Re-measure at top scroll (sticky should still be at original location)
  const info = await page.evaluate(() => {
    const head = document.querySelector('.bills-card-head');
    const search = document.querySelector('.bills-search');
    const card = document.querySelector('.bills-card');
    return {
      cardParent: card?.parentElement?.className,
      headMarginBottom: head ? getComputedStyle(head).marginBottom : null,
      searchMarginTop: search ? getComputedStyle(search).marginTop : null,
      searchPosition: search ? getComputedStyle(search).position : null,
      searchTop: search ? getComputedStyle(search).top : null,
      headRect: head ? head.getBoundingClientRect() : null,
      searchRect: search ? search.getBoundingClientRect() : null,
      gapScroll0: head && search ? search.getBoundingClientRect().top - head.getBoundingClientRect().bottom : null,
    };
  });
  console.log('scroll=0:', JSON.stringify(info, null, 2));

  // Also scroll bills-card into view
  await page.evaluate(() => {
    const card = document.querySelector('.bills-card');
    if (card) card.scrollIntoView({ block: 'start' });
  });
  await page.waitForTimeout(500);
  const info2 = await page.evaluate(() => {
    const head = document.querySelector('.bills-card-head');
    const search = document.querySelector('.bills-search');
    return {
      gapAfterScroll: head && search ? search.getBoundingClientRect().top - head.getBoundingClientRect().bottom : null,
      searchPosition: search ? getComputedStyle(search).position : null,
      searchRect: search ? search.getBoundingClientRect() : null,
    };
  });
  console.log('afterScroll:', JSON.stringify(info2, null, 2));

  await page.screenshot({ path: '/home/node/.openclaw/media/browser/v0729-1-C7-gap.png', fullPage: false });
  await browser.close();
})();