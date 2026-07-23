// v0.3.22 #126 (UAT bug #3): BEFORE — 截图看实际的"-"是什么
const { chromium, devices } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  await page.request.post('http://172.18.0.5:8448/api/auth/send-code', {
    data: { email: 'demo@example.com' },
    headers: { 'Content-Type': 'application/json' },
  });
  await page.request.post('http://172.18.0.5:8448/api/auth/verify-code', {
    data: { email: 'demo@example.com', code: '000000' },
    headers: { 'Content-Type': 'application/json' },
  });

  await page.goto('http://172.18.0.5:8448/sessions/1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // 截图 members section
  const membersCard = page.locator('.members-card').first();
  await membersCard.waitFor({ timeout: 5000 });
  await membersCard.screenshot({ path: '/home/node/.openclaw/media/browser/v0322-126-bug3-before.png' });
  console.log('[1] members card screenshot saved');

  // 检查第一个 member-row-a 的 innerText 看实际显示
  const firstMemberRow = page.locator('.member-row-a').first();
  const text = await firstMemberRow.textContent();
  console.log('[2] first member-row text:', JSON.stringify(text));

  // also check innerHTML for any - char
  const html = await firstMemberRow.innerHTML();
  // 找 email附近的内容
  const emailIdx = html.indexOf('member-email-a');
  if (emailIdx >= 0) {
    console.log('[3] email area HTML:', JSON.stringify(html.substring(emailIdx - 80, emailIdx + 150)));
  }

  await browser.close();
})();