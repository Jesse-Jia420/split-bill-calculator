// v0.3.29 UAT 0725-1 #7 verify script (final - bills/new + bills/edit)
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

  await ctx.request.post('http://127.0.0.1:8449/auth/send-code', { data: { email: 'xinhua1001@outlook.com' } });
  await ctx.request.post('http://127.0.0.1:8449/auth/verify-code', { data: { email: 'xinhua1001@outlook.com', code: '000000' } });

  const sessRes = await ctx.request.get('http://127.0.0.1:8449/sessions');
  const sessions = await sessRes.json();
  const target = sessions.find(s => Array.isArray(s.currencies) && s.currencies.length >= 2);
  if (!target) { console.error('no multi session'); process.exit(1); }
  console.log('target:', target.id, target.name);

  const billsRes = await ctx.request.get('http://127.0.0.1:8449/sessions/' + target.id + '/bills');
  const bills = await billsRes.json();
  if (!bills.length) { console.error('no bills'); process.exit(1); }
  const someBill = bills[0];
  console.log('some bill:', someBill.id, someBill.description);

  const checks = [];
  function check(name, ok) {
    checks.push({ name, ok });
    console.log((ok ? 'OK  ' : 'FAIL') + '  ' + name);
  }

  // === Test A: bills/new 加载显示 LoadingOverlay ===
  // Throttle the session detail fetch
  await page.route('**/api/sessions/' + target.id, async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  await page.goto('http://127.0.0.1:8448/sessions/' + target.id + '/bills/new', { waitUntil: 'commit' });

  let newLoadingShown = false, newRingVisible = false, newPillText = null, newOverlayPos = null;
  try {
    await page.waitForSelector('.loading-overlay', { timeout: 4000 });
    newLoadingShown = true;
  } catch (e) {}
  if (newLoadingShown) {
    newRingVisible = await page.locator('.loading-overlay .glass-ring').count() > 0;
    newPillText = await page.locator('.loading-overlay .text').textContent();
    newOverlayPos = await page.locator('.loading-overlay').evaluate((el) => window.getComputedStyle(el).position);
    await page.screenshot({ path: '/tmp/v0329-0725-1-7-A-new-loading.png', fullPage: false });
  }
  await page.waitForSelector('form#bill-form', { timeout: 8000 });
  const newFormVisible = await page.locator('form#bill-form').isVisible();
  const newLoadingAfter = await page.locator('.loading-overlay').count();
  await page.screenshot({ path: '/tmp/v0329-0725-1-7-A-new-loaded.png', fullPage: false });

  check('bills/new LoadingOverlay shown', newLoadingShown);
  check('bills/new glass-ring rendered', newRingVisible);
  check('bills/new pill text=加载账单...', newPillText === '加载账单...');
  check('bills/new position=fixed', newOverlayPos === 'fixed');
  check('bills/new form visible after', newFormVisible);
  check('bills/new loading cleared after', newLoadingAfter === 0);

  await page.unroute('**/api/sessions/' + target.id).catch(() => {});

  // === Test B: bills/edit 加载显示 LoadingOverlay ===
  await page.route('**/api/sessions/' + target.id + '/bills/' + someBill.id, async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  await page.goto('http://127.0.0.1:8448/sessions/' + target.id + '/bills/' + someBill.id + '/edit', { waitUntil: 'commit' });

  let editLoadingShown = false, editRingVisible = false, editPillText = null;
  try {
    await page.waitForSelector('.loading-overlay', { timeout: 4000 });
    editLoadingShown = true;
  } catch (e) {}
  if (editLoadingShown) {
    editRingVisible = await page.locator('.loading-overlay .glass-ring').count() > 0;
    editPillText = await page.locator('.loading-overlay .text').textContent();
    await page.screenshot({ path: '/tmp/v0329-0725-1-7-B-edit-loading.png', fullPage: false });
  }
  await page.waitForSelector('form#bill-form', { timeout: 8000 });
  const editFormVisible = await page.locator('form#bill-form').isVisible();
  const editLoadingAfter = await page.locator('.loading-overlay').count();
  await page.screenshot({ path: '/tmp/v0329-0725-1-7-B-edit-loaded.png', fullPage: false });

  check('bills/edit LoadingOverlay shown', editLoadingShown);
  check('bills/edit glass-ring rendered', editRingVisible);
  check('bills/edit pill text=加载账单...', editPillText === '加载账单...');
  check('bills/edit form visible after', editFormVisible);
  check('bills/edit loading cleared after', editLoadingAfter === 0);

  await page.unroute('**/api/sessions/' + target.id + '/bills/' + someBill.id).catch(() => {});

  // === Test C: spot-check 没有 regression (其他路由 LoadingOverlay 仍然正常) ===
  await page.goto('http://127.0.0.1:8448/sessions/' + target.id, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  const sessionDetailLoaded = await page.locator('h2').first().textContent().catch(() => null);
  check('sessions/{id} still renders (no regression)', !!sessionDetailLoaded);

  console.log('\n=== SUMMARY ===');
  console.log('Passed: ' + checks.filter(c => c.ok).length + '/' + checks.length);
  const pass = checks.every(c => c.ok);
  console.log(pass ? 'PASS ALL' : 'FAIL');
  await browser.close();
  process.exit(pass ? 0 : 1);
})();
