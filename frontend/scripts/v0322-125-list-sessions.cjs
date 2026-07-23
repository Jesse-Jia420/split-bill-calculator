// v0.3.22 #125 (UAT bug #5): 找到有双币种的 session
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

  await page.goto('http://172.18.0.5:8448/sessions', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // 截图 sessions 列表 (current state, showing what currency each session has)
  await page.screenshot({ path: '/home/node/.openclaw/media/browser/v0322-125-sessions-list.png' });
  console.log('[1] sessions list screenshot saved');

  await browser.close();
})();