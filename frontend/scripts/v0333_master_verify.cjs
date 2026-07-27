// v0.3.33 Master 端到端 verify (反 #150 v2 守则: cross-check user 字面 spec on 真机)
const { chromium, devices } = require('playwright');

const FRONT = 'http://172.18.0.5:8448';
const OUT = process.env.HOME + '/.openclaw/media/browser/v0325-3-master-verify';
require('fs').mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-CN' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().substring(0, 200)); });

  // login via BE proxy
  await page.request.post(FRONT + '/api/auth/send-code', {
    data: { email: 'demo@example.com' },
    headers: { 'Content-Type': 'application/json' },
  });
  await page.request.post(FRONT + '/api/auth/verify-code', {
    data: { email: 'demo@example.com', code: '000000' },
    headers: { 'Content-Type': 'application/json' },
  });

  const results = {};

  // === Bug #5: /sessions .fab visible ===
  await page.goto(FRONT + '/sessions', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: OUT + '/01-sessions.png', fullPage: true });
  const fab = page.locator('a.fab[aria-label="新建账本"]').first();
  results['#5-fab-visible'] = await fab.isVisible();
  const fabBox = await fab.boundingBox();
  const fabStyles = await fab.evaluate(el => {
    const cs = getComputedStyle(el);
    return {
      bg: cs.background.substring(0, 200),
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      width: cs.width,
      height: cs.height,
      borderRadius: cs.borderRadius,
    };
  });
  results['#5-fab-styles'] = fabStyles;
  results['#5-fab-box'] = fabBox;
  console.log('[#5] fab visible:', results['#5-fab-visible'], 'styles:', JSON.stringify(fabStyles));

  // === Bug #2 + #3 + #4: /sessions/9/settle ===
  await page.goto(FRONT + '/sessions/9/settle', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: OUT + '/02-settle-overview.png', fullPage: true });
  results['#4-no-settle-latest-section'] = await page.locator('[data-sbc="settle-latest-section"]').count();
  results['#3-add-btn-pill'] = await page.evaluate(() => {
    const btn = document.querySelector('[data-sbc="settle-add-record-btn"]');
    if (!btn) return null;
    const cs = getComputedStyle(btn);
    return { text: btn.textContent.trim(), height: cs.height, borderRadius: cs.borderRadius, hasIcon: !!btn.querySelector('svg') };
  });
  results['#2-avatar-12px'] = await page.evaluate(() => {
    const av = document.querySelector('[data-sbc="settlement-row"] .avatar');
    if (!av) return null;
    const cs = getComputedStyle(av);
    return { fontSize: cs.fontSize, fontWeight: cs.fontWeight, hasTextShadow: cs.textShadow !== 'none', bg: cs.background.substring(0, 200) };
  });
  console.log('[#2-4]', JSON.stringify(results, null, 2));

  // open add sheet
  await page.click('[data-sbc="settle-add-record-btn"]');
  await page.waitForTimeout(800);
  await page.screenshot({ path: OUT + '/03-settle-add-sheet.png', fullPage: true });

  // === Bug #1: /sessions/9/login ===
  // Use string concat to avoid template literal quote issues
  const loginUrl = FRONT + '/sessions/9/login?as=36&nickname=Jesse&emailMasked=x%2A%2A%2A%40outlook.com';
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: OUT + '/04-login.png', fullPage: true });
  results['#1-cta-row'] = await page.locator('.cta-row').count();
  results['#1-login-back-fab'] = await page.locator('[data-testid="login-back-fab"]').count();
  results['#1-submit-pill'] = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="login-submit-btn"]');
    if (!btn) return null;
    const cs = getComputedStyle(btn);
    return { text: btn.textContent.trim(), height: cs.height, borderRadius: cs.borderRadius };
  });
  results['#1-navbar-hidden'] = await page.evaluate(() => {
    const nav = document.querySelector('header.navbar .right');
    if (!nav) return 'right-area-absent';
    return { html: nav.innerHTML.substring(0, 200), hasSaveLogin: nav.innerHTML.includes('登录以保存') };
  });
  console.log('[#1]', JSON.stringify(results, null, 2));

  // console errors collected
  results['__errors__'] = errs;
  console.log('__ERRORS__:', errs.length, errs.slice(0, 5));

  await browser.close();
  require('fs').writeFileSync(OUT + '/results.json', JSON.stringify(results, null, 2));
  console.log('OK wrote', OUT);
})();
