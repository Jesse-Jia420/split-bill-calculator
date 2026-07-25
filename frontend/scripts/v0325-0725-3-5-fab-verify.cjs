// v0325-0725-3-5-fab-verify.cjs
// 验证 /sessions 页「新增账本」FAB 是否回原意 (v0.3.27 #10 commit ab02ecb 的 glass-pill 圆形 FAB)
// 反 #167 iPhone 13 @3x 真机 profile (390×844, webkit, locale zh-CN)
// 反 #150v2 自己跑浏览器 (非 sandbox 假设)

const { chromium, devices } = require('playwright');
const fs = require('fs');

const VITE_HOST = 'http://127.0.0.1:8448';
const OUT_DIR = '/tmp/verify-v0325-3-5';

(async () => {
  try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch {}
  const browser = await chromium.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  let pass = 0;
  let fail = 0;

  function check(name, ok, info) {
    const mark = ok ? '✓' : '✗';
    if (ok) pass++; else fail++;
    console.log(`  ${mark} ${name}${info ? ': ' + info : ''}`);
    return ok;
  }

  console.log('=== 0. Login via BE API + cookie jar ===');
  const email = 'xinhua1001@outlook.com';
  const sendCodeResp = await page.request.post(`${VITE_HOST.replace(':8448', ':8449').replace('127.0.0.1', '127.0.0.1')}/auth/send-code`, {
    data: { email },
    headers: { 'Content-Type': 'application/json' },
  });
  check('POST /auth/send-code', sendCodeResp.status() === 200, `status ${sendCodeResp.status()}`);

  const verifyResp = await page.request.post(`${VITE_HOST.replace(':8448', ':8449')}/auth/verify-code`, {
    data: { email, code: '000000' },
    headers: { 'Content-Type': 'application/json' },
  });
  check('POST /auth/verify-code', verifyResp.status() === 200, `status ${verifyResp.status()}`);

  // Transfer cookies to context
  const cookies = (await page.request.storageState()).cookies;
  await context.addCookies(cookies);

  console.log('\n=== 1. Navigate to /sessions ===');
  const resp = await page.goto(`${VITE_HOST}/sessions`, { waitUntil: 'networkidle', timeout: 15000 });
  check('GET /sessions', resp && resp.status() === 200, `status ${resp ? resp.status() : 'null'}`);

  await page.waitForTimeout(800);

  // Verify there's at least 1 session card (so we see the non-emphasized FAB state)
  const sessionCards = await page.locator('a.session-card').count();
  console.log(`  (info) session cards on page: ${sessionCards}`);
  // If 0 sessions, the FAB is in "emphasized" (darker) state — both are valid designs.
  // We still want position + size + border-radius right.

  console.log('\n=== 2. FAB exists ===');
  const fab = page.locator('a.fab').first();
  const fabCount = await page.locator('a.fab').count();
  check('a.fab exists in DOM', fabCount >= 1, `count=${fabCount}`);

  await fab.waitFor({ state: 'visible', timeout: 5000 });

  console.log('\n=== 3. FAB computed style (position / size / color / radius) ===');
  const cs = await fab.evaluate((el) => {
    const c = window.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      position: c.position,
      right: c.right,
      bottom: c.bottom,
      width: c.width,
      height: c.height,
      borderRadius: c.borderRadius,
      background: c.background.slice(0, 200),
      border: c.border,
      backdropFilter: c.backdropFilter || c.webkitBackdropFilter,
      fontSize: c.fontSize,
      color: c.color,
      zIndex: c.zIndex,
      href: el.getAttribute('href'),
      classes: el.className,
      rect: {
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
        vw: window.innerWidth,
        vh: window.innerHeight,
      },
    };
  });
  console.log('  FAB computed style:', JSON.stringify(cs, null, 2));

  check('FAB position=fixed', cs.position === 'fixed', `got "${cs.position}"`);
  check('FAB right=28px', cs.right === '28px', `got "${cs.right}"`);
  check('FAB bottom=28px', cs.bottom === '28px', `got "${cs.bottom}"`);
  check('FAB width=80px', cs.width === '80px', `got "${cs.width}"`);
  check('FAB height=80px', cs.height === '80px', `got "${cs.height}"`);
  // iPhone 13 viewport 390x844
  check('FAB has circular border-radius', cs.borderRadius === '50%' || cs.borderRadius === '40px', `got "${cs.borderRadius}"`);

  // Calculate on-screen position
  const fabRightPx = cs.rect.vw - cs.rect.x - cs.rect.w;
  const fabBottomPx = cs.rect.vh - cs.rect.y - cs.rect.h;
  console.log(`  (info) viewport ${cs.rect.vw}×${cs.rect.vh}, FAB at x=${cs.rect.x.toFixed(1)} y=${cs.rect.y.toFixed(1)} w=${cs.rect.w} h=${cs.rect.h}, FAB right-edge to viewport-right: ${fabRightPx.toFixed(1)}px, FAB bottom-edge to viewport-bottom: ${fabBottomPx.toFixed(1)}px`);
  check('FAB visually anchored bottom-right ~28px', fabRightPx < 50 && fabBottomPx < 50, `right-gap=${fabRightPx.toFixed(1)} bottom-gap=${fabBottomPx.toFixed(1)}`);

  check('FAB has glass-pill class', cs.classes.includes('glass-pill'), `classes="${cs.classes}"`);
  check('FAB has backdrop-filter (glass)', cs.backdropFilter && cs.backdropFilter !== 'none' && cs.backdropFilter.includes('blur'), `got "${cs.backdropFilter}"`);

  console.log('\n=== 4. FAB screenshot ===');
  const fabFullPath = `${OUT_DIR}/01-sessions-full-fab.png`;
  await page.screenshot({ path: fabFullPath, fullPage: true });
  console.log(`  saved ${fabFullPath}`);
  const fabPath = `${OUT_DIR}/02-sessions-fab-only.png`;
  await fab.screenshot({ path: fabPath });
  console.log(`  saved ${fabPath}`);

  // Crop bottom-right corner close-up
  const vp = page.viewportSize();
  await page.screenshot({
    path: `${OUT_DIR}/03-sessions-fab-corner.png`,
    clip: { x: vp.width - 160, y: vp.height - 160, width: 160, height: 160 },
  });
  console.log(`  saved ${OUT_DIR}/03-sessions-fab-corner.png (bottom-right 160×160 close-up)`);

  console.log('\n=== 5. FAB click navigates ===');
  const navHref = await fab.getAttribute('href');
  check('FAB href="/sessions/new"', navHref === '/sessions/new', `got "${navHref}"`);

  console.log(`\n=== Result: ${pass} pass / ${fail} fail ===`);

  await browser.close();
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(2);
});
