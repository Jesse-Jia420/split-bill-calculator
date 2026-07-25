// v0.3.29 UAT 0725-1 #12 verify script (v2 - use .avatar-a for expanded)
const { chromium, devices } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/config/.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell',
    headless: true,
  });

  const checks = [];
  function check(name, ok, info) {
    checks.push({ name, ok });
    console.log((ok ? 'OK  ' : 'FAIL') + '  ' + name + (info ? ' ' + info : ''));
  }

  const norm = (bg) => bg.replace(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/g, 'rgba($1,$2,$3,$4)').trim();

  // Login ctx
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
  const useSession = sessions.find(s => Array.isArray(s.currencies) && s.currencies.length >= 2);
  if (!useSession) { console.error('no multi session'); process.exit(1); }
  console.log('target session:', useSession.id, useSession.name);

  // === Test A: anon /sessions/{id}/join 取 slot avatar ===
  const anonCtx = await browser.newContext({
    ...devices['iPhone 13'],
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  const anonPage = await anonCtx.newPage();
  await anonPage.goto('http://127.0.0.1:8448/sessions/' + useSession.id + '/join', { waitUntil: 'networkidle', timeout: 15000 });
  await anonPage.waitForTimeout(500);
  const slotCount = await anonPage.locator('.slot-avatar').count();
  console.log('slot-avatar count:', slotCount);
  const slotBgs = [];
  for (let i = 0; i < slotCount; i++) {
    const bg = await anonPage.locator('.slot-avatar').nth(i).evaluate((el) => window.getComputedStyle(el).backgroundImage);
    const cls = await anonPage.locator('.slot-avatar').nth(i).getAttribute('class');
    slotBgs.push({ index: i, cls, bg: norm(bg) });
    console.log('  slot[' + i + '] cls=' + cls + ' bg=' + bg.slice(0, 100));
  }
  await anonPage.screenshot({ path: '/tmp/v0329-0725-1-12-A-join.png', fullPage: false });

  // === Test B: /sessions/{id} 取 member section .avatar-a (expanded 默认) ===
  await page.goto('http://127.0.0.1:8448/sessions/' + useSession.id, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(500);
  const avatarACount = await page.locator('.avatar-a').count();
  console.log('avatar-a count:', avatarACount);
  const memberBgs = [];
  for (let i = 0; i < avatarACount; i++) {
    const bg = await page.locator('.avatar-a').nth(i).evaluate((el) => window.getComputedStyle(el).backgroundImage);
    const cls = await page.locator('.avatar-a').nth(i).getAttribute('class');
    memberBgs.push({ index: i, cls, bg: norm(bg) });
    console.log('  member[' + i + '] cls=' + cls + ' bg=' + bg.slice(0, 100));
  }
  await page.screenshot({ path: '/tmp/v0329-0725-1-12-B-sessions.png', fullPage: false });

  // === Test C: 对比 palette-{0..4} ===
  for (let i = 0; i < 5; i++) {
    const slot = slotBgs.find(s => s.cls && s.cls.indexOf('palette-' + i) >= 0);
    const member = memberBgs.find(m => m.cls && m.cls.indexOf('palette-' + i) >= 0);
    const match = slot && member && slot.bg === member.bg;
    check('palette-' + i + ' match', !!match, 'slot=' + (slot ? slot.bg.slice(0, 60) : 'NONE') + ' member=' + (member ? member.bg.slice(0, 60) : 'NONE'));
  }

  const pass = checks.every(c => c.ok);
  console.log('\\n=== SUMMARY ===');
  console.log('Passed: ' + checks.filter(c => c.ok).length + '/' + checks.length);
  console.log(pass ? 'PASS ALL' : 'FAIL');

  await browser.close();
  process.exit(pass ? 0 : 1);
})();
