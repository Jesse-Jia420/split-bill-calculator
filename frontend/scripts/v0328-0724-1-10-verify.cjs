// v0.3.28 — UAT 0724-1 #10 verify script
// PO: 单币种的个人视图, 不需要 主币种汇总和原始数据 的选项
// 测试: 多币种 session → toggle visible / 单币种 session → toggle hidden
const { chromium, devices } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/config/.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell',
    headless: true,
  });
  const ctx = await browser.newContext({
    ...devices['iPhone 13'],
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  const page = await ctx.newPage();

  // 1. 登录 via BE API (sandbox path)
  const loginRes = await ctx.request.post('http://127.0.0.1:8449/auth/send-code', {
    data: { email: 'xinhua1001@outlook.com' },
  });
  if (!loginRes.ok()) throw new Error('send-code failed: ' + loginRes.status());
  const verifyRes = await ctx.request.post('http://127.0.0.1:8449/auth/verify-code', {
    data: { email: 'xinhua1001@outlook.com', code: '000000' },
  });
  if (!verifyRes.ok()) throw new Error('verify-code failed: ' + verifyRes.status());

  // 2. 拿到 sessions 列表
  const sessRes = await ctx.request.get('http://127.0.0.1:8449/sessions');
  const sessions = await sessRes.json();
  console.log('sessions:', sessions.map(s => ({ id: s.id, name: s.name, currencies: s.currencies })));

  // 3. 找 multi currency session (CNY+THB)
  const multiSess = sessions.find(s => Array.isArray(s.currencies) && s.currencies.length >= 2);
  // 4. 找 single currency session (CNY only)
  const singleSess = sessions.find(s => Array.isArray(s.currencies) && s.currencies.length === 1);
  if (!multiSess || !singleSess) {
    console.error('need both multi + single session. multi:', multiSess?.id, 'single:', singleSess?.id);
    process.exit(1);
  }

  console.log('--- multi session ---', multiSess.id, multiSess.currencies);
  console.log('--- single session ---', singleSess.id, singleSess.currencies);

  // === Test A: multi currency session → personal view → toggle visible ===
  await page.goto(`http://127.0.0.1:8448/sessions/${multiSess.id}/settle`, { waitUntil: 'networkidle' });
  // 切到个人视图
  const overviewBtn = await page.locator('button:has-text("概览")').first();
  const personalBtn = await page.locator('button:has-text("个人视图")').first();
  await personalBtn.click();
  await page.waitForTimeout(500);
  // 期望 toggle 可见: ariaLabel="结算视图" (主币种汇总 / 原始数据)
  const multiToggleVisible = await page.locator('[aria-label="结算视图"]').isVisible().catch(() => false);
  const multiPrimaryOpt = await page.locator('[aria-label="结算视图"] button:has-text("主币种汇总")').count();
  const multiSplitOpt = await page.locator('[aria-label="结算视图"] button:has-text("原始数据")').count();
  console.log(`multi session: toggleVisible=${multiToggleVisible} primaryOpt=${multiPrimaryOpt} splitOpt=${multiSplitOpt}`);
  await page.screenshot({ path: '/tmp/v0328-0724-1-10-A-multi.png', fullPage: false });

  // === Test B: single currency session → personal view → toggle hidden ===
  await page.goto(`http://127.0.0.1:8448/sessions/${singleSess.id}/settle`, { waitUntil: 'networkidle' });
  await personalBtn.click();
  await page.waitForTimeout(500);
  const singleToggleVisible = await page.locator('[aria-label="结算视图"]').isVisible().catch(() => false);
  const singleToggleCount = await page.locator('[aria-label="结算视图"]').count();
  console.log(`single session: toggleVisible=${singleToggleVisible} toggleCount=${singleToggleCount}`);
  await page.screenshot({ path: '/tmp/v0328-0724-1-10-B-single.png', fullPage: false });

  // === Test C: single currency session → overview tab still works ===
  await overviewBtn.click();
  await page.waitForTimeout(500);
  const overviewStillWorks = await page.locator('text=/结算/').first().isVisible().catch(() => false);
  console.log(`single session overview: stillWorks=${overviewStillWorks}`);
  await page.screenshot({ path: '/tmp/v0328-0724-1-10-C-overview.png', fullPage: false });

  // === Test D: SettleMemberBreakdown 仍渲染 (viewMode='split' 走原始数据 = primary 单币种 source) ===
  const memberBreakdownVisible = await page.locator('text=/付款明细/').first().isVisible().catch(() => false);
  console.log(`single session personal: SettleMemberBreakdown rendered=${memberBreakdownVisible}`);

  // 输出结果
  const pass = multiToggleVisible && multiPrimaryOpt >= 1 && multiSplitOpt >= 1
            && !singleToggleVisible && singleToggleCount === 0
            && overviewStillWorks && memberBreakdownVisible;
  console.log(pass ? '✅ ALL PASS' : '❌ FAIL');

  await browser.close();
  process.exit(pass ? 0 : 1);
})();