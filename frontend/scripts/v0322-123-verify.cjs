// v0.3.22 #123 (UAT bug #7): placeholder 搜索账单说明 → 搜索账单名称
const { chromium, devices } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  // login via BE
  await page.request.post('http://172.18.0.5:8448/api/auth/send-code', {
    data: { email: 'xinhua1001@outlook.com' },
    headers: { 'Content-Type': 'application/json' },
  });
  await page.request.post('http://172.18.0.5:8448/api/auth/verify-code', {
    data: { email: 'xinhua1001@outlook.com', code: '000000' },
    headers: { 'Content-Type': 'application/json' },
  });
  console.log('[1] login OK');

  // navigate to session 1
  await page.goto('http://172.18.0.5:8448/sessions/1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // check search input placeholder
  const input = page.locator('.bills-search-input').first();
  await input.waitFor({ timeout: 5000 });
  const placeholder = await input.getAttribute('placeholder');
  const ariaLabel = await input.getAttribute('aria-label');
  console.log('[2] placeholder:', JSON.stringify(placeholder));
  console.log('[3] aria-label:', JSON.stringify(ariaLabel));

  const expected = '搜索账单名称';
  const placeholderOk = placeholder === expected;
  const ariaLabelOk = ariaLabel === expected;
  const oldTextGone = !page.url().includes('搜索账单说明'); // placeholder doesn't affect URL but safety
  console.log('[4] placeholder match expected?', placeholderOk);
  console.log('[5] aria-label match expected?', ariaLabelOk);

  // screenshot search area for visual proof
  const search = page.locator('.bills-search').first();
  await search.screenshot({ path: '/home/node/.openclaw/media/browser/v0322-123-search-placeholder.png' });
  console.log('[6] search area screenshot saved');

  await browser.close();

  if (!placeholderOk || !ariaLabelOk) {
    console.log('FAIL');
    process.exit(1);
  }
  console.log('PASS');
})();