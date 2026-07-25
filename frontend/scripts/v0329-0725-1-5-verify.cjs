// v0.3.29 UAT 0725-1 #5 verify script (v2)
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

  await ctx.request.post('http://127.0.0.1:8449/auth/send-code', { data: { email: 'demo@example.com' } });
  await ctx.request.post('http://127.0.0.1:8449/auth/verify-code', { data: { email: 'demo@example.com', code: '000000' } });

  const sessRes = await ctx.request.get('http://127.0.0.1:8449/sessions');
  const sessions = await sessRes.json();
  const target = sessions.find(s => Array.isArray(s.currencies) && s.currencies.length >= 2 && s.member_count >= 5);
  if (!target) { console.error('need multi session'); process.exit(1); }
  console.log('target:', target.id, target.name);

  await page.goto('http://127.0.0.1:8448/sessions/' + target.id + '/bills/new', { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(500);

  const checks = [];
  function check(name, ok, info) {
    checks.push({ name, ok });
    console.log((ok ? 'OK  ' : 'FAIL') + '  ' + name + (info ? ' ' + info : ''));
  }

  const avatarCount = await page.locator('.ppt-avatar').count();
  const dimAvatars = await page.locator('.ppt-avatar.dim').count();
  const litAvatars = avatarCount - dimAvatars;
  console.log('avatar count:', avatarCount, 'dim:', dimAvatars, 'lit:', litAvatars);
  check('ppt-avatar rendered for all members', avatarCount >= 5);
  check('mixed dim and lit avatars', dimAvatars >= 1 && litAvatars >= 1, 'dim=' + dimAvatars + ' lit=' + litAvatars);

  // dim avatar style
  const dimStyle = await page.locator('.ppt-avatar.dim').first().evaluate((el) => {
    const cs = window.getComputedStyle(el);
    return {
      filter: cs.filter,
      opacity: cs.opacity,
      bg: cs.backgroundColor,
      bgImage: cs.backgroundImage,
      backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter,
      boxShadow: cs.boxShadow,
    };
  });
  console.log('dim style:', JSON.stringify(dimStyle));
  check('dim: filter=grayscale(1)', dimStyle.filter === 'grayscale(1)' || dimStyle.filter.indexOf('grayscale(1)') >= 0, 'filter=' + dimStyle.filter);
  check('dim: opacity=0.5', dimStyle.opacity === '0.5');
  check('dim: backdrop-filter 保留 (#132 glass)', !!dimStyle.backdropFilter && dimStyle.backdropFilter.indexOf('blur') >= 0);
  check('dim: box-shadow 保留 (#132 glass)', !!dimStyle.boxShadow && dimStyle.boxShadow.indexOf('rgb') >= 0);
  check('dim: bg=rgba(160,160,160,0.25) 灰', dimStyle.bg.includes('160, 160, 160') && dimStyle.bg.includes('0.25'));

  // lit avatar style
  const litStyle = await page.locator('.ppt-avatar:not(.dim)').first().evaluate((el) => {
    const cs = window.getComputedStyle(el);
    return {
      filter: cs.filter,
      opacity: cs.opacity,
      bg: cs.backgroundColor,
      bgImage: cs.backgroundImage,
    };
  });
  console.log('lit style:', JSON.stringify(litStyle));
  check('lit: filter=none', litStyle.filter === 'none' || litStyle.filter === '');
  check('lit: opacity=1', litStyle.opacity === '1');
  check('lit: bgImage=linear-gradient (palette)', litStyle.bgImage.includes('linear-gradient'));
  check('lit: bgImage 含 0.88 alpha', litStyle.bgImage.includes('0.88'));

  // Toggle test
  const firstRow = page.locator('[data-testid^="ppts-row-"]').first();
  const firstAvatar = page.locator('.ppt-avatar').first();
  const beforeDimClass = await firstAvatar.evaluate(el => el.classList.contains('dim'));
  await firstRow.click();
  await page.waitForTimeout(200);
  const afterDimClass = await firstAvatar.evaluate(el => el.classList.contains('dim'));
  check('click toggles dim state', beforeDimClass !== afterDimClass, 'before=' + beforeDimClass + ' after=' + afterDimClass);

  // Screenshot
  await page.locator('[data-testid=ppts-list]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: '/tmp/v0329-0725-1-5-A-dim-enhanced.png', fullPage: false });

  console.log('\n=== SUMMARY ===');
  console.log('Passed: ' + checks.filter(c => c.ok).length + '/' + checks.length);
  const pass = checks.every(c => c.ok);
  console.log(pass ? 'PASS ALL' : 'FAIL');

  await browser.close();
  process.exit(pass ? 0 : 1);
})();
