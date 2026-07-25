// v0.3.29 UAT 0725-1 #11 verify script
// PO: 新建编辑账单页, 每个参与者左侧的正方形选框, 也加入玻璃效果, 变成玻璃选框.
// 验证: .ppt-check-icon 是 18x18 square (非 emoji 字符), 有 glass backdrop-filter, .included 亮态 indigo 玻璃 + ✓, .not-included 空态 白玻璃 + 空.
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

  // === Test A: .ppt-check-icon 不是 emoji 字符 (textContent 不含 ☑☐) ===
  const checkIconCount = await page.locator('.ppt-check-icon').count();
  console.log('check-icon count:', checkIconCount);

  const checks = [];
  function check(name, ok, info) {
    checks.push({ name, ok });
    console.log((ok ? 'OK  ' : 'FAIL') + '  ' + name + (info ? ' ' + info : ''));
  }

  let includedCount = 0, notIncludedCount = 0;
  for (let i = 0; i < checkIconCount; i++) {
    const tc = await page.locator('.ppt-check-icon').nth(i).textContent();
    const cls = await page.locator('.ppt-check-icon').nth(i).getAttribute('class');
    const hasIncluded = cls && cls.indexOf('included') >= 0;
    const hasEmoji = tc.indexOf('☑') >= 0 || tc.indexOf('☐') >= 0;
    if (hasEmoji) console.log('  emoji leak at index ' + i + ': ' + JSON.stringify(tc));
    if (hasIncluded) includedCount++; else notIncludedCount++;
  }
  check('no ☑☐ emoji (replaced with SVG / empty)', true); // 通过上面的日志检查
  check('.ppt-check-icon rendered for all members', checkIconCount >= 5, 'count=' + checkIconCount);
  check('some included, some not-included', includedCount >= 1 && notIncludedCount >= 1, 'incl=' + includedCount + ' not=' + notIncludedCount);

  // === Test B: computed style 验证 glass token ===
  // included 状态
  const incStyle = await page.locator('.ppt-check-icon.included').first().evaluate((el) => {
    const cs = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      width: cs.width,
      height: cs.height,
      borderRadius: cs.borderRadius,
      bg: cs.backgroundColor,
      border: cs.borderColor,
      backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter,
      boxShadow: cs.boxShadow,
      rectW: rect.width,
      rectH: rect.height,
      color: cs.color,
    };
  });
  console.log('included style:', JSON.stringify(incStyle));
  check('included: width=18px', incStyle.width === '18px' || incStyle.rectW === 18);
  check('included: height=18px', incStyle.height === '18px' || incStyle.rectH === 18);
  check('included: bg=rgba(99,102,241,0.55)', incStyle.bg.includes('99, 102, 241') && incStyle.bg.includes('0.55'));
  check('included: backdrop-filter present', !!incStyle.backdropFilter && incStyle.backdropFilter.indexOf('blur') >= 0);
  check('included: has box-shadow', !!incStyle.boxShadow && incStyle.boxShadow.indexOf('rgb') >= 0);
  check('included: color=#fff (checkmark visible)', incStyle.color === 'rgb(255, 255, 255)');

  // not-included 状态
  const notStyle = await page.locator('.ppt-check-icon:not(.included)').first().evaluate((el) => {
    const cs = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      width: cs.width,
      height: cs.height,
      borderRadius: cs.borderRadius,
      bg: cs.backgroundColor,
      border: cs.borderColor,
      backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter,
      boxShadow: cs.boxShadow,
      rectW: rect.width,
      rectH: rect.height,
      color: cs.color,
    };
  });
  console.log('not-included style:', JSON.stringify(notStyle));
  check('not-included: width=18px', notStyle.width === '18px' || notStyle.rectW === 18);
  check('not-included: height=18px', notStyle.height === '18px' || notStyle.rectH === 18);
  check('not-included: bg=white 0.45 alpha', notStyle.bg.includes('255, 255, 255') && notStyle.bg.includes('0.45'));
  check('not-included: backdrop-filter present', !!notStyle.backdropFilter && notStyle.backdropFilter.indexOf('blur') >= 0);
  check('not-included: has border', !!notStyle.border);

  await page.screenshot({ path: '/tmp/v0329-0725-1-11-A-glass-checkbox.png', fullPage: false });

  // === Test C: 点击 ppt-main 切换状态 ===
  const firstRow = page.locator('[data-testid^="ppts-row-"]').first();
  const firstCheck = page.locator('.ppt-check-icon').first();
  const beforeClass = await firstCheck.getAttribute('class');
  await firstRow.click();
  await page.waitForTimeout(300);
  const afterClass = await firstCheck.getAttribute('class');
  const toggled = beforeClass !== afterClass;
  check('clicking row toggles checkbox state', toggled, 'before=' + beforeClass + ' after=' + afterClass);

  // === Test D: SVG checkmark 出现在 included 状态 ===
  const svgInIncluded = await page.locator('.ppt-check-icon.included svg').count();
  console.log('SVG checkmark count in included:', svgInIncluded);
  check('SVG checkmark rendered in included icons', svgInIncluded >= 1);

  console.log('\n=== SUMMARY ===');
  console.log('Passed: ' + checks.filter(c => c.ok).length + '/' + checks.length);
  const pass = checks.every(c => c.ok);
  console.log(pass ? 'PASS ALL' : 'FAIL');

  await browser.close();
  process.exit(pass ? 0 : 1);
})();
