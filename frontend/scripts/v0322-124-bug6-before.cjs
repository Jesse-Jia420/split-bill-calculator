// v0.3.22 #124 (UAT bug #6): BEFORE — 截图证明 2 个 X 按钮存在
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
  // 输入一些文字以触发 native cancel button
  await input.click();
  await input.type('打车');
  await page.waitForTimeout(500);

  // 截图 search 框区域
  const search = page.locator('.bills-search').first();
  await search.screenshot({ path: '/home/node/.openclaw/media/browser/v0322-124-bug6-before.png' });
  console.log('[1] BEFORE screenshot saved');

  // 检查 input 内是否有 native X (::-webkit-search-cancel-button rendered)
  const inputBoundingBox = await input.boundingBox();
  console.log('[2] input bbox:', JSON.stringify(inputBoundingBox));

  // 找 custom clear button 的 bbox
  const customBtn = page.locator('.bills-search-clear').first();
  const customBtnVisible = await customBtn.isVisible().catch(() => false);
  console.log('[3] custom .bills-search-clear visible?', customBtnVisible);
  if (customBtnVisible) {
    const cb = await customBtn.boundingBox();
    console.log('[3b] custom btn bbox:', JSON.stringify(cb));
  }

  // 检查 ::-webkit-search-cancel-button 渲染
  // 方法: 在 input 内 click 位置 + 看是否有 native X (使用 evaluate 检测)
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
  console.log('[4] ::-webkit-search-cancel-button computed style:', JSON.stringify(nativeCancelRendered));

  await browser.close();
})();