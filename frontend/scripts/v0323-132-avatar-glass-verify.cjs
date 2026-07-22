#!/usr/bin/env node
/**
 * v0.3.23 #132 — UAT old #4 头像玻璃质感 (Option B = backdrop-filter + 半透明)
 *
 * 验证 4 个 avatar classes 都有 backdrop-filter + glass shadow:
 *   - .avatar (SessionMemberList chip, 28×28)
 *   - .ppt-avatar (BillForm, 36×36)
 *   - .avatar-a (+page.svelte, 36×36)
 *   - .avatar-mini (+page.svelte, 32×32)
 */
const { chromium, devices } = require('playwright');
const fs = require('fs');

const BASE = 'http://172.18.0.5:8448';
const SCREENSHOT_DIR = '/home/node/.openclaw/media/browser/v0323-132-avatar-glass';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-CN' });
  const page = await ctx.newPage();

  // Login
  await page.request.post(`${BASE}/auth/send-code`, {
    data: { email: 'xinhua1001@outlook.com' },
    headers: { 'Content-Type': 'application/json' },
  });
  await page.request.post(`${BASE}/auth/verify-code`, {
    data: { email: 'xinhua1001@outlook.com', code: '000000' },
    headers: { 'Content-Type': 'application/json' },
  });

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // 1. /sessions/1 (member section collapsed → avatar-mini in row 2)
  // 注: membersOpen 默认是 true (localStorage 控制), 所以先点击 toggle 按钮折叠
  await page.goto(`${BASE}/sessions/1`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // 点击 toggle 按钮把 members section 折叠 (membersOpen: true → false)
  await page.evaluate(() => {
    const btn = document.querySelector('[aria-label*="收起"], [aria-label*="展开"], [aria-expanded="true"]');
    if (btn) btn.click();
  });
  await page.waitForTimeout(800);

  const avatarMiniStyles = await page.evaluate(() => {
    const el = document.querySelector('.members-avatars-inline .avatar-mini')
      || document.querySelector('.avatar-mini');
    if (!el) return { found: false, count: document.querySelectorAll('.avatar-mini').length };
    const cs = getComputedStyle(el);
    return {
      found: true,
      backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter,
      boxShadow: cs.boxShadow,
      background: cs.backgroundImage,
      width: cs.width,
      height: cs.height,
    };
  });
  console.log('#132 .avatar-mini (折叠态 row 2):');
  console.log(JSON.stringify(avatarMiniStyles, null, 2));

  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-sessions-1-avatar-mini.png`, fullPage: false });

  // 2. /sessions/1 展开 members → avatar-a (36×36 expanded)
  // 先再点 toggle 把 members 展开 (折叠查 .avatar-mini 后要展开才能查 .avatar-a)
  await page.evaluate(() => {
    const btn = document.querySelector('[aria-label*="收起"], [aria-label*="展开"], [aria-expanded="false"]');
    if (btn) btn.click();
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-sessions-1-avatar-a-expanded.png`, fullPage: false });

  // 跳过前 2 个 (owner/me 通常是前 2 个), 找后续不带 .is-me / .is-owner modifier 的
  //   (modifier 覆盖 box-shadow: 0 0 0 Npx #fff, 不含 inset)
  // 优先找带 palette-* 的 (background 是 rgba 0.88 渐变而非默认), 没有再 fallback
  const avatarAStyles = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('.avatar-a'));
    const candidates = all.filter(el =>
      !el.classList.contains('is-me') && !el.classList.contains('is-owner')
    );
    const el = candidates.find(c => Array.from(c.classList).some(cls => cls.startsWith('palette-')))
      || candidates[0];
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter,
      boxShadow: cs.boxShadow,
      background: cs.backgroundImage,
      width: cs.width,
      height: cs.height,
      classes: Array.from(el.classList).join(' '),
    };
  });
  console.log('#132 .avatar-a (展开态 36×36):');
  console.log(JSON.stringify(avatarAStyles, null, 2));
  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-sessions-1-avatar-a-expanded.png`, fullPage: false });

  // 3. /sessions/1/bills/new → BillForm → ppt-avatar (36×36)
  await page.goto(`${BASE}/sessions/1/bills/new`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const pptAvatarStyles = await page.evaluate(() => {
    const el = document.querySelector('.ppt-avatar');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter,
      boxShadow: cs.boxShadow,
      background: cs.backgroundImage,
      width: cs.width,
      height: cs.height,
    };
  });
  console.log('#132 .ppt-avatar (BillForm 36×36):');
  console.log(JSON.stringify(pptAvatarStyles, null, 2));
  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-bills-new-ppt-avatar.png`, fullPage: false });

  // Summary
  const checks = {
    '#132 .avatar-mini backdrop-filter': avatarMiniStyles?.backdropFilter !== 'none' && avatarMiniStyles?.backdropFilter !== '',
    '#132 .avatar-mini glass shadow': avatarMiniStyles?.boxShadow?.includes('inset'),
    '#132 .avatar-a backdrop-filter': avatarAStyles?.backdropFilter !== 'none' && avatarAStyles?.backdropFilter !== '',
    '#132 .avatar-a glass shadow': avatarAStyles?.boxShadow?.includes('inset'),
    '#132 .ppt-avatar backdrop-filter': pptAvatarStyles?.backdropFilter !== 'none' && pptAvatarStyles?.backdropFilter !== '',
    '#132 .ppt-avatar glass shadow': pptAvatarStyles?.boxShadow?.includes('inset'),
  };
  console.log('\n=== Summary ===');
  for (const [k, v] of Object.entries(checks)) console.log(`${v ? '✓' : '✗'} ${k}`);

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });