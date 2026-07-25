// v0.3.29 UAT 0725-1 #1 verify script
// PO: 没让你把搜索账单的搜索框垂直高度变大, 只让你给搜索框及其背后的区域加模糊背景.
// 验证: .bills-search 高度 ~44px (不是 50px), ::before 玻璃覆盖 .bills-search 上下 12px gap.
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

  // Login
  await ctx.request.post('http://127.0.0.1:8449/auth/send-code', { data: { email: 'xinhua1001@outlook.com' } });
  await ctx.request.post('http://127.0.0.1:8449/auth/verify-code', { data: { email: 'xinhua1001@outlook.com', code: '000000' } });

  const sessRes = await ctx.request.get('http://127.0.0.1:8449/sessions');
  const sessions = await sessRes.json();
  const target = sessions.find(s => Array.isArray(s.currencies) && s.currencies.length >= 2 && s.member_count >= 3);
  if (!target) { console.error('need multi session'); process.exit(1); }
  console.log('target:', target.id, target.name);

  await page.goto('http://127.0.0.1:8460/sessions/' + target.id, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2500);

  const checks = [];
  function check(name, ok, info) {
    checks.push({ name, ok });
    console.log((ok ? 'OK  ' : 'FAIL') + '  ' + name + (info ? ' ' + info : ''));
  }

  // === Test A: .bills-search 实际 height ===
  const searchInfo = await page.evaluate(() => {
    const el = document.querySelector('.bills-search');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      height: cs.height,
      rectHeight: rect.height,
      paddingTop: cs.paddingTop,
      paddingBottom: cs.paddingBottom,
      paddingLeft: cs.paddingLeft,
      paddingRight: cs.paddingRight,
      borderTopWidth: cs.borderTopWidth,
      borderBottomWidth: cs.borderBottomWidth,
    };
  });
  console.log('bills-search info:', JSON.stringify(searchInfo));
  if (!searchInfo) { console.error('no .bills-search found'); process.exit(1); }
  // height should be ~44px (padding 11+11 + content 22 + border 1+1 = 44)
  const height = parseFloat(searchInfo.height);
  check('.bills-search height ≈ 44px (PO 字面要求)', height >= 43 && height <= 46, 'height=' + height + 'px (was 50px before fix)');
  check('.bills-search padding-top = 11px', searchInfo.paddingTop === '11px', 'padding-top=' + searchInfo.paddingTop);
  check('.bills-search padding-bottom = 11px', searchInfo.paddingBottom === '11px', 'padding-bottom=' + searchInfo.paddingBottom);

  // === Test B: --bills-search-h 同步收 (60 → 54) ===
  const searchH = await page.evaluate(() => {
    const el = document.querySelector('.bills-card');
    return el ? getComputedStyle(el).getPropertyValue('--bills-search-h').trim() : null;
  });
  console.log('--bills-search-h:', searchH);
  check('--bills-search-h = 54px (sync from 60px)', searchH === '54px', '--bills-search-h=' + searchH);

  // === Test C: ::before glass 覆盖 .bills-search 上下 12px gap ===
  const beforeInfo = await page.evaluate(() => {
    const el = document.querySelector('.bills-search');
    if (!el) return null;
    const before = getComputedStyle(el, '::before');
    return {
      content: before.content,
      top: before.top,
      bottom: before.bottom,
      left: before.left,
      right: before.right,
      bg: before.backgroundColor,
      backdropFilter: before.backdropFilter,
      zIndex: before.zIndex,
      position: before.position,
    };
  });
  console.log('::before info:', JSON.stringify(beforeInfo));
  if (!beforeInfo) { console.error('no ::before'); process.exit(1); }
  check('::before content not empty', beforeInfo.content && beforeInfo.content !== 'none' && beforeInfo.content !== 'normal', 'content=' + beforeInfo.content);
  check('::before top: -12px (覆盖 search 上方 12px gap)', beforeInfo.top === '-12px', 'top=' + beforeInfo.top);
  check('::before bottom: -12px (覆盖 search 下方 12px gap)', beforeInfo.bottom === '-12px', 'bottom=' + beforeInfo.bottom);
  check('::before has glass bg (rgba 255,255,255,0.55)', beforeInfo.bg.includes('rgba(255, 255, 255, 0.55)') || beforeInfo.bg.includes('255, 255, 255'), 'bg=' + beforeInfo.bg);
  check('::before has backdrop-filter blur(20px) saturate(180%)', beforeInfo.backdropFilter.includes('blur(20px)') && (beforeInfo.backdropFilter.includes('saturate(180%)') || beforeInfo.backdropFilter.includes('saturate(1.8)')), 'backdrop-filter=' + beforeInfo.backdropFilter);

  // === Test D: 视觉确认 — 玻璃覆盖上下 12px gap ===
  // Scroll 让 search 浮起, 截图
  await page.evaluate(() => {
    const main = document.querySelector('main');
    if (main) main.scrollTop = 600;
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/v0329-0725-1-1-A-search-scrolled.png', clip: { x: 0, y: 0, width: 390, height: 200 } });
  // 取 search 区域 + 上下 12px 截图
  const searchRect = await page.evaluate(() => {
    const el = document.querySelector('.bills-search');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y - 12, width: r.width, height: r.height + 24 };
  });
  if (searchRect) {
    await page.screenshot({
      path: '/tmp/v0329-0725-1-1-B-search-region-with-gap.png',
      clip: { x: Math.max(0, searchRect.x), y: Math.max(0, searchRect.y), width: searchRect.width, height: searchRect.height }
    });
  }

  // === Test E: 不回归 — search sticky 仍常驻顶部 ===
  const stickyOk = await page.evaluate(() => {
    const el = document.querySelector('.bills-search');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { position: cs.position, top: cs.top, zIndex: cs.zIndex };
  });
  console.log('sticky info:', JSON.stringify(stickyOk));
  check('bills-search position: sticky', stickyOk.position === 'sticky', 'position=' + stickyOk.position);
  check('bills-search z-index: 20', stickyOk.zIndex === '20', 'z-index=' + stickyOk.zIndex);

  console.log('\n=== SUMMARY ===');
  console.log('Passed: ' + checks.filter(c => c.ok).length + '/' + checks.length);
  const pass = checks.every(c => c.ok);
  console.log(pass ? 'PASS ALL' : 'FAIL');

  await browser.close();
  process.exit(pass ? 0 : 1);
})();