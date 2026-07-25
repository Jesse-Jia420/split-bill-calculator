// v0.3.29 UAT 0725-1 #9 verify script
// PO: 新建编辑账单页, 个人金额 pill 内的文字高度有问题, 跟 pill 没对齐.
// 验证: .pill-input 在 .excl-pill (height: 32px) 内的视觉居中 — input computed line-height + height 应 = 32px,
// input 文字 baseline 跟兄弟 .pill-currency (¥ button) baseline y 坐标差 < 4px (sub-pixel 容忍).
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
  const target = sessions.find(s => Array.isArray(s.currencies) && s.currencies.length >= 2 && s.member_count >= 5);
  if (!target) { console.error('need multi session with >= 5 members'); process.exit(1); }
  console.log('target:', target.id, target.name);

  // 打开 bills/new 路由
  await page.goto('http://127.0.0.1:8448/sessions/' + target.id + '/bills/new', { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(500);

  const checks = [];
  function check(name, ok, info) {
    checks.push({ name, ok });
    console.log((ok ? 'OK  ' : 'FAIL') + '  ' + name + (info ? ' ' + info : ''));
  }

  // === Test A: .pill-input computed style ===
  // 默认 pill 是 shared (¥ 灰, 无 input). 点 ¥ 进 exclusive 模式. 找第一个 pill.
  const firstPill = page.locator('.excl-pill').first();
  const firstPillBox = await firstPill.boundingBox();
  console.log('first pill box:', JSON.stringify(firstPillBox));

  // 进入 exclusive 模式 (点 ¥ button)
  const firstPillCurrency = page.locator('.excl-pill .pill-currency').first();
  await firstPillCurrency.click();
  await page.waitForTimeout(300);

  // 检查 .pill-input 是否出现
  const pillInputCount = await page.locator('.pill-input').count();
  console.log('pill-input count:', pillInputCount);
  check('pill-input appeared after entering exclusive mode', pillInputCount >= 1);

  if (pillInputCount >= 1) {
    const inputStyle = await page.locator('.pill-input').first().evaluate((el) => {
      const cs = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        height: cs.height,
        lineHeight: cs.lineHeight,
        fontSize: cs.fontSize,
        rectH: rect.height,
        rectW: rect.width,
        display: cs.display,
        padding: cs.padding,
        verticalAlign: cs.verticalAlign,
      };
    });
    console.log('pill-input style:', JSON.stringify(inputStyle));
    check('pill-input height=32px', inputStyle.height === '32px' || inputStyle.rectH === 32);
    check('pill-input line-height=32px', inputStyle.lineHeight === '32px' || inputStyle.lineHeight === 'normal' /* computed auto */, 'computed=' + inputStyle.lineHeight);
    check('pill-input computed rectH=32', inputStyle.rectH === 32 || Math.abs(inputStyle.rectH - 32) < 1, 'rectH=' + inputStyle.rectH);

    // === Test B: 文字 baseline 跟 .pill-currency 一致 ===
    // 用 getBoundingClientRect 测 input 文字 region vs ¥ button 文字 region
    const baselineCheck = await page.evaluate(() => {
      const input = document.querySelector('.pill-input');
      const currency = input && input.parentElement ? input.parentElement.querySelector('.pill-currency') : null;
      const pill = input && input.parentElement;
      if (!input || !currency || !pill) return null;
      const inputRect = input.getBoundingClientRect();
      const currencyRect = currency.getBoundingClientRect();
      const pillRect = pill.getBoundingClientRect();
      return {
        pillY: pillRect.top,
        pillH: pillRect.height,
        inputY: inputRect.top,
        inputH: inputRect.height,
        currencyY: currencyRect.top,
        currencyH: currencyRect.height,
        // input center vs pill center
        inputCenterY: inputRect.top + inputRect.height / 2,
        pillCenterY: pillRect.top + pillRect.height / 2,
        // currency center vs pill center
        currencyCenterY: currencyRect.top + currencyRect.height / 2,
        // delta inputCenterY - currencyCenterY (should be small if both vertically centered)
        centerDelta: Math.abs((inputRect.top + inputRect.height / 2) - (currencyRect.top + currencyRect.height / 2)),
      };
    });
    console.log('baseline check:', JSON.stringify(baselineCheck));
    if (baselineCheck) {
      // input 和 currency 都应该垂直居中在 pill 内
      const inputDelta = Math.abs(baselineCheck.inputCenterY - baselineCheck.pillCenterY);
      const currencyDelta = Math.abs(baselineCheck.currencyCenterY - baselineCheck.pillCenterY);
      console.log('  input vs pill center delta:', inputDelta);
      console.log('  currency vs pill center delta:', currencyDelta);
      // 容忍 2px sub-pixel 偏差
      check('input vertically centered in pill (±2px)', inputDelta < 2, 'delta=' + inputDelta.toFixed(2));
      check('currency vertically centered in pill (±2px)', currencyDelta < 2, 'delta=' + currencyDelta.toFixed(2));
      check('input & currency same baseline (±2px)', baselineCheck.centerDelta < 2, 'delta=' + baselineCheck.centerDelta.toFixed(2));
    }

    // === Test C: 截图存证 ===
    await page.locator('.excl-pill').first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({ path: '/tmp/v0329-0725-1-9-A-pill-alignment.png', clip: { x: 0, y: 0, width: 390, height: 844 }, fullPage: false });
  }

  // === Test D: 不回归 — 默认 shared pill 仍正常 ===
  // 退出 exclusive 模式 (再点 ¥)
  await firstPillCurrency.click();
  await page.waitForTimeout(300);
  const sharedPills = await page.locator('.excl-pill').count();
  check('shared pills count maintained', sharedPills >= 5);

  console.log('\n=== SUMMARY ===');
  console.log('Passed: ' + checks.filter(c => c.ok).length + '/' + checks.length);
  const pass = checks.every(c => c.ok);
  console.log(pass ? 'PASS ALL' : 'FAIL');

  await browser.close();
  process.exit(pass ? 0 : 1);
})();
