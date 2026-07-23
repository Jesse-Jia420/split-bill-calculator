// v0.3.22 #124 (UAT bug #6): AFTER — 截图证明只剩 1 个 X (custom)
const { chromium, devices } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  await page.request.post('http://172.18.0.5:8448/api/auth/send-code', {
    data: { email: 'xinhua1001@outlook.com' },
    headers: { 'Content-Type': 'application/json' },
  });
  await page.request.post('http://172.18.0.5:8448/api/auth/verify-code', {
    data: { email: 'xinhua1001@outlook.com', code: '000000' },
    headers: { 'Content-Type': 'application/json' },
  });

  await page.goto('http://172.18.0.5:8448/sessions/1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const input = page.locator('.bills-search-input').first();
  await input.waitFor({ timeout: 5000 });
  await input.click();
  await input.type('打车');
  await page.waitForTimeout(500);

  // 截图 AFTER
  const search = page.locator('.bills-search').first();
  await search.screenshot({ path: '/home/node/.openclaw/media/browser/v0322-124-bug6-after.png' });
  console.log('[1] AFTER screenshot saved');

  // 检查 ::-webkit-search-cancel-button computed
  const nativeCancelRendered = await input.evaluate(el => {
    const styles = getComputedStyle(el, '::-webkit-search-cancel-button');
    return {
      display: styles.display,
      appearance: styles.appearance,
      width: styles.width,
      height: styles.height,
      visibility: styles.visibility,
    };
  });
  console.log('[2] ::-webkit-search-cancel-button AFTER:', JSON.stringify(nativeCancelRendered));

  // 检查 X 按钮数量 — 我们用 SVG / button 计数
  const xButtons = await page.locator('.bills-search svg, .bills-search button').count();
  console.log('[3] x buttons/svg in .bills-search:', xButtons);

  // Expected: search-icon (1) + clear button (1) = 2 (NOT 3 if hidden)
  console.log('[4] Expected count = 2 (icon + custom X) if fix works; BEFORE had 3 (icon + native + custom)');

  await browser.close();

  // assert
  const ok = nativeCancelRendered.display === 'none' && xButtons === 2;
  if (!ok) {
    console.log('FAIL: native not hidden or button count wrong');
    process.exit(1);
  }
  console.log('PASS');
})();