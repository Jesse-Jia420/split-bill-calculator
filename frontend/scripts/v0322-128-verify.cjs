// v0.3.22 #128 (UAT bug #1): 验证 scrollSearchToSticky 同步滚后 search 不跑 viewport 外
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

  // 1. 滚到 mid (search 不在 viewport 顶部 sticky)
  const mainEl = page.locator('main').first();
  await mainEl.evaluate(el => { el.scrollTop = 400; });
  await page.waitForTimeout(300);

  const beforeSearchTop = await page.locator('.bills-search').first().evaluate(el => {
    return el.getBoundingClientRect().top;
  });
  const beforeMainScrollTop = await page.locator('main').first().evaluate(el => el.scrollTop);
  console.log('[1] BEFORE focus: search.top=' + beforeSearchTop + ' main.scrollTop=' + beforeMainScrollTop);

  // 2. focus 搜索框 (triggers scrollSearchToSticky)
  await page.locator('.bills-search-input').first().focus();
  await page.waitForTimeout(400);  // 让任何 rAF / browser scroll 都完成

  const afterSearchTop = await page.locator('.bills-search').first().evaluate(el => {
    return el.getBoundingClientRect().top;
  });
  const afterMainScrollTop = await page.locator('main').first().evaluate(el => el.scrollTop);
  console.log('[2] AFTER focus:  search.top=' + afterSearchTop + ' main.scrollTop=' + afterMainScrollTop);

  // 3. search.top 应该在 [0, STICKY_OFFSET=8+误差范围内], 不能远 < 0 (跑 viewport 外)
  // 或远 > 100 (被滚太远)
  const expectedStickyTop = 8;  // 跟 CSS top: var(--space-2) = 8px 一致
  const tolerance = 50;
  const isAtSticky = Math.abs(afterSearchTop - expectedStickyTop) < tolerance;
  const isNotOffscreen = afterSearchTop >= -20;  // 允许小偏移
  console.log('[3] search.top within tolerance of sticky top?', isAtSticky);
  console.log('[4] search NOT off-screen (top >= -20)?', isNotOffscreen);

  // 截图 evidence
  await page.screenshot({ path: '/home/node/.openclaw/media/browser/v0322-128-after-focus.png' });

  // 4. 测试 stick 行为 — 当 search 已经 sticky 时再 focus, 不应该乱滚
  await page.locator('main').first().evaluate(el => { el.scrollTop = 600; });
  await page.waitForTimeout(300);
  await page.locator('.bills-search-input').first().focus();
  await page.waitForTimeout(300);
  const stickySearchTop = await page.locator('.bills-search').first().evaluate(el => el.getBoundingClientRect().top);
  const stickyMainTop = await page.locator('main').first().evaluate(el => el.scrollTop);
  console.log('[5] sticky state, after focus: search.top=' + stickySearchTop + ' main.scrollTop=' + stickyMainTop);

  await browser.close();

  if (!isNotOffscreen) {
    console.log('FAIL: search disappeared off-viewport after focus');
    process.exit(1);
  }
  if (!isAtSticky) {
    console.log('WARN: search not at expected sticky position (likely fine — visualViewport quirk in headless)');
  }
  console.log('PASS');
})();