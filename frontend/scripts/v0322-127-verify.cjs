// v0.3.22 #127 (UAT bug #2): members "N人" 删 + expiry yyyy.mm.dd + owner name
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

  // 检查 #2.a — members title 文字
  const title = page.locator('.members-title-a').first();
  await title.waitFor({ timeout: 5000 });
  const titleText = (await title.textContent())?.trim();
  console.log('[2a] members title:', JSON.stringify(titleText));
  const aOk = !titleText.includes('人');
  console.log('[2a] title 没有 "人"?', aOk, '(should be true — N人 已删)');

  // 检查 #2.b — expiry pill
  const expiryPill = page.locator('[data-testid="invite-expiry-pill"]').first();
  const expiryExists = await expiryPill.isVisible().catch(() => false);
  console.log('[2b] expiry pill visible?', expiryExists, '(for anon session 1 应为 true)');

  if (expiryExists) {
    const expiryText = (await expiryPill.textContent())?.trim();
    console.log('[2b] expiry pill text:', JSON.stringify(expiryText));
    // 期望: "2026.07.29 过期 · Jesse 登录即可永久保存" (类似格式)
    const hasDateFormat = /\d{4}\.\d{2}\.\d{2} 过期/.test(expiryText);
    const hasOwnerName = expiryText.includes('Jesse') || expiryText.includes('owner');
    const hasInsteadOfYi = expiryText.includes('即可');
    console.log('[2b] has yyyy.mm.dd 过期 format?', hasDateFormat);
    console.log('[2b] has owner name?', hasOwnerName);
    console.log('[2b] has 即可 (instead of 以)?', hasInsteadOfYi);
  }

  // 截图 members head
  const membersCard = page.locator('.members-card').first();
  await membersCard.screenshot({ path: '/home/node/.openclaw/media/browser/v0322-127-after.png' });
  console.log('[3] members card screenshot saved');

  await browser.close();

  if (!aOk) {
    console.log('FAIL: members title still has count');
    process.exit(1);
  }
  console.log('PASS');
})();