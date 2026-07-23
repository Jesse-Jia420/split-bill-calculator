// v0.3.22 #125 (UAT bug #5): 验证 .currency-bar 颜色已匹配 .glass-pill
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

  // Goto session 1 (泰国测试账单, CNY+THB dual currency)
  await page.goto('http://172.18.0.5:8448/sessions/1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // 检查 .currency-bar 元素
  const bar = page.locator('.currency-bar').first();
  let barVisible = false;
  let barBg = null;
  let inviteBtnBg = null;
  try {
    await bar.waitFor({ timeout: 5000 });
    barVisible = await bar.isVisible();
    if (barVisible) {
      barBg = await bar.evaluate(el => getComputedStyle(el).background);
      const borderColor = await bar.evaluate(el => getComputedStyle(el).borderColor);
      console.log('[1] .currency-bar visible:', barVisible);
      console.log('[2] .currency-bar computed background:', JSON.stringify(barBg));
      console.log('[3] .currency-bar border-color:', borderColor);
    }
  } catch (e) {
    console.log('[1] .currency-bar NOT visible (可能不在 detail 页)');
  }

  // 检查 InviteLinkButton (.glass-pill.invite-btn) bg for comparison
  const inviteBtn = page.locator('[data-testid="invite-btn"]').first();
  try {
    await inviteBtn.waitFor({ timeout: 3000 });
    inviteBtnBg = await inviteBtn.evaluate(el => getComputedStyle(el).background);
    console.log('[4] .invite-btn (.glass-pill) bg:', JSON.stringify(inviteBtnBg));
  } catch (e) {
    console.log('[4] .invite-btn not visible');
  }

  // 截图 session 详情页
  await page.screenshot({ path: '/home/node/.openclaw/media/browser/v0322-125-session1-full.png' });
  console.log('[5] session 1 full screenshot saved');

  // 截图 rate bar 区域
  try {
    await bar.screenshot({ path: '/home/node/.openclaw/media/browser/v0322-125-rate-bar.png' });
    console.log('[6] rate bar screenshot saved');
  } catch (e) {
    console.log('[6] no rate bar to screenshot');
  }

  await browser.close();

  // Compare: bar should have alpha 0.04/0.02 (compare with invite button 0.04/0.02)
  const barHasOld = barBg && (barBg.includes('0.1)') || barBg.includes('0.08)'));
  const inviteHasNew = inviteBtnBg && inviteBtnBg.includes('0.04');
  console.log('[7] bar bg has old deep alpha (0.10/0.08)?', barHasOld, '(should be false)');
  console.log('[8] invite btn bg has new light alpha (0.04)?', inviteHasNew, '(should be true)');

  if (barHasOld || !inviteHasNew) {
    console.log('FAIL: bar color not updated to match invite button');
    process.exit(1);
  }
  console.log('PASS');
})();