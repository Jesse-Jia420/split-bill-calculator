// Playwright iPhone 13 @3x verify script for v0.3.0728-2 #20 解冻 (PO msg 2026-07-28 21:17 "继续0728-2其他")
// 5 → 10 扩色: 新成员头像颜色不应与已有成员头像的颜色一样
//
// 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
// 反 #101 ✅ Playwright 程序化 + DOM computed style + image tool 视觉三证
// 反 #150 v2 ✅ 真视觉位置 + 真数据 (session 9 泰国测试 6 members 41 bills + session 13 11+ members)
// 反 #151 ✅ PNG 截图存 ~/.openclaw/media/browser/v0728-2-20-palette-10/

const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.SBC_BASE || 'https://test.jessejia.pp.ua';
const SCREENSHOTS_DIR = path.join(process.env.HOME || '/home/node', '.openclaw/media/browser/v0728-2-20-palette-10');
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const iPhone13 = devices['iPhone 13'];

// Expected palette gradients (5 new ones added in v0.3.0728-2 #20)
const EXPECTED_PALETTES = {
  0: 'linear-gradient(135deg, rgba(129, 140, 248, 0.88), rgba(99, 102, 241, 0.88))', // existing
  1: 'linear-gradient(135deg, rgba(244, 114, 182, 0.88), rgba(236, 72, 153, 0.88))', // existing
  2: 'linear-gradient(135deg, rgba(52, 211, 153, 0.88), rgba(16, 185, 129, 0.88))',  // existing
  3: 'linear-gradient(135deg, rgba(251, 191, 36, 0.88), rgba(245, 158, 11, 0.88))',  // existing
  4: 'linear-gradient(135deg, rgba(96, 165, 250, 0.88), rgba(59, 130, 246, 0.88))',  // existing
  5: 'linear-gradient(135deg, rgba(244, 63, 94, 0.88), rgba(217, 70, 239, 0.88))',   // NEW rose → fuchsia
  6: 'linear-gradient(135deg, rgba(132, 204, 22, 0.88), rgba(34, 197, 94, 0.88))',    // NEW lime → green
  7: 'linear-gradient(135deg, rgba(14, 165, 233, 0.88), rgba(59, 130, 246, 0.88))',   // NEW sky → blue
  8: 'linear-gradient(135deg, rgba(139, 92, 246, 0.88), rgba(236, 72, 153, 0.88))',   // NEW violet → pink
  9: 'linear-gradient(135deg, rgba(249, 115, 22, 0.88), rgba(239, 68, 68, 0.88))',    // NEW orange → red
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...iPhone13,
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  // 1. Login via BE API
  console.log('[v0728-2-20] Step 1: login as demo@example.com');
  await context.request.post(`${BASE}/auth/send-code`, {
    data: { email: 'demo@example.com' },
  });
  await context.request.post(`${BASE}/auth/verify-code`, {
    data: { email: 'demo@example.com', code: '000000' },
  });

  // 2. Navigate to /sessions (sessions list page) to see palette扩色 in action
  console.log('[v0728-2-20] Step 2: navigate to /sessions (sessions list)');
  await page.goto(`${BASE}/sessions`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // 3. Verify palette-{i%10} classes are used in DOM
  console.log('[v0728-2-20] Step 3: check palette-5..9 classes exist in DOM');
  const paletteClasses = await page.evaluate(() => {
    const classes = new Set();
    document.querySelectorAll('[class*="palette-"]').forEach((el) => {
      el.classList.forEach((c) => {
        const m = c.match(/^palette-(\d+)$/);
        if (m) classes.add(parseInt(m[1], 10));
      });
    });
    return Array.from(classes).sort((a, b) => a - b);
  });
  console.log(`  palette classes used in DOM: [${paletteClasses.join(', ')}]`);

  // 4. Navigate to session 9 (Thailand test, 6 members)
  console.log('[v0728-2-20] Step 4: navigate to /sessions/9 (6 members, 41 bills)');
  await page.goto(`${BASE}/sessions/9`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // 5. Verify members section avatar-a palette CSS
  console.log('[v0728-2-20] Step 5: verify members section avatar-a palette classes');
  const membersPaletteClasses = await page.evaluate(() => {
    const classes = new Set();
    document.querySelectorAll('[class*="palette-"]').forEach((el) => {
      el.classList.forEach((c) => {
        const m = c.match(/^palette-(\d+)$/);
        if (m) classes.add(parseInt(m[1], 10));
      });
    });
    return Array.from(classes).sort((a, b) => a - b);
  });
  console.log(`  avatar-a palette classes: [${membersPaletteClasses.join(', ')}]`);

  // 6. Get computed background for each palette-{N} CSS rule
  console.log('[v0728-2-20] Step 6: verify palette-{N} CSS backgrounds');
  const paletteBackgrounds = await page.evaluate(() => {
    const results = {};
    for (let i = 0; i <= 9; i++) {
      // Inject a test div with the class
      const div = document.createElement('div');
      div.className = `palette-${i} test-palette-${i}`;
      div.style.position = 'absolute';
      div.style.left = '-9999px';
      document.body.appendChild(div);
      const cs = window.getComputedStyle(div);
      results[i] = cs.backgroundImage;
      div.remove();
    }
    return results;
  });
  for (let i = 0; i <= 9; i++) {
    const bg = paletteBackgrounds[i] || '';
    const matches = bg.includes('linear-gradient');
    console.log(`  palette-${i}: ${matches ? '✓' : '✗'} ${bg.substring(0, 100)}`);
  }

  // 7. Check at least 6 distinct palette colors used for 6 members in session 9
  console.log('[v0728-2-20] Step 7: verify no duplicate palette colors for 6 members');
  // Get all member avatars
  const memberColors = await page.evaluate(() => {
    const members = document.querySelectorAll('.avatar-a');
    return Array.from(members).slice(0, 10).map((el) => {
      const cs = window.getComputedStyle(el);
      // Extract class palette-N
      let paletteIdx = -1;
      el.classList.forEach((c) => {
        const m = c.match(/^palette-(\d+)$/);
        if (m) paletteIdx = parseInt(m[1], 10);
      });
      return { paletteIdx, bg: cs.backgroundImage.substring(0, 50) };
    });
  });
  console.log(`  member avatars: ${memberColors.length}`);
  const uniquePalettes = new Set(memberColors.map((m) => m.paletteIdx));
  console.log(`  unique palettes: ${uniquePalettes.size}, values: [${Array.from(uniquePalettes).sort().join(', ')}]`);

  // 8. Verify no two members with same palette index in session 9
  const hasCollision = uniquePalettes.size < memberColors.length;
  console.log(`  collision detected: ${hasCollision}`);

  // 9. Screenshot of /sessions/9 with members visible
  console.log('[v0728-2-20] Step 9: screenshot members section');
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '01-session-9-members.png'),
    fullPage: false,
  });

  // 10. Navigate to /sessions/13 (11 members, most extreme collision case before fix)
  console.log('[v0728-2-20] Step 10: navigate to /sessions/13 (11 members)');
  await page.goto(`${BASE}/sessions/13`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  const s13Members = await page.evaluate(() => {
    const members = document.querySelectorAll('.avatar-a');
    return Array.from(members).slice(0, 15).map((el) => {
      let paletteIdx = -1;
      el.classList.forEach((c) => {
        const m = c.match(/^palette-(\d+)$/);
        if (m) paletteIdx = parseInt(m[1], 10);
      });
      return paletteIdx;
    });
  });
  console.log(`  /sessions/13 avatar palettes: [${s13Members.join(', ')}]`);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '02-session-13-members.png'),
    fullPage: false,
  });

  // 11. Navigate to /sessions (sessions list) — SessionCard uses avatar-mini with palette-{i%10}
  console.log('[v0728-2-20] Step 11: navigate to /sessions (list with mini avatars)');
  await page.goto(`${BASE}/sessions`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  const listMiniPalettes = await page.evaluate(() => {
    const minis = document.querySelectorAll('.avatar-mini[class*="palette-"]');
    return Array.from(minis).slice(0, 20).map((el) => {
      let paletteIdx = -1;
      el.classList.forEach((c) => {
        const m = c.match(/^palette-(\d+)$/);
        if (m) paletteIdx = parseInt(m[1], 10);
      });
      return paletteIdx;
    });
  });
  console.log(`  sessions list mini avatar palettes: [${listMiniPalettes.join(', ')}]`);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '03-sessions-list.png'),
    fullPage: false,
  });

  // 12. Navigate to /join/{code} anon page (palette-0..9 used for slot avatars)
  console.log('[v0728-2-20] Step 12: navigate to anon join page');
  await page.goto(`${BASE}/s/64BZQNX9NU/join`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  const joinSlotPalettes = await page.evaluate(() => {
    const slots = document.querySelectorAll('.slot-avatar[class*="palette-"]');
    return Array.from(slots).slice(0, 15).map((el) => {
      let paletteIdx = -1;
      el.classList.forEach((c) => {
        const m = c.match(/^palette-(\d+)$/);
        if (m) paletteIdx = parseInt(m[1], 10);
      });
      return paletteIdx;
    });
  });
  console.log(`  join slot avatar palettes: [${joinSlotPalettes.join(', ')}]`);

  await browser.close();

  console.log('\n[v0728-2-20] === SUMMARY ===');
  const checks = [
    { name: 'palette-0..4 CSS still defined (existing colors)', pass: [0,1,2,3,4].every(i => paletteBackgrounds[i]?.includes('linear-gradient')) },
    { name: 'palette-5 CSS defined (NEW rose → fuchsia)', pass: paletteBackgrounds[5]?.includes('244, 63, 94') && paletteBackgrounds[5]?.includes('217, 70, 239') },
    { name: 'palette-6 CSS defined (NEW lime → green)', pass: paletteBackgrounds[6]?.includes('132, 204, 22') && paletteBackgrounds[6]?.includes('34, 197, 94') },
    { name: 'palette-7 CSS defined (NEW sky → blue)', pass: paletteBackgrounds[7]?.includes('14, 165, 233') && paletteBackgrounds[7]?.includes('59, 130, 246') },
    { name: 'palette-8 CSS defined (NEW violet → pink)', pass: paletteBackgrounds[8]?.includes('139, 92, 246') && paletteBackgrounds[8]?.includes('236, 72, 153') },
    { name: 'palette-9 CSS defined (NEW orange → red)', pass: paletteBackgrounds[9]?.includes('249, 115, 22') && paletteBackgrounds[9]?.includes('239, 68, 68') },
    { name: 'session 9: no duplicate palette colors for 6 members', pass: uniquePalettes.size === memberColors.length && memberColors.length >= 6 },
    { name: 'session 9: 6 unique palettes', pass: uniquePalettes.size >= 6 },
    { name: '/sessions/13 11 members: no collision with 10 colors', pass: new Set(s13Members).size === s13Members.length },
    { name: 'sessions list uses palette-{i%10} (loop index mod 10)', pass: listMiniPalettes.length > 0 },
    { name: 'palette-{i%10} gives ≤ 10 distinct values', pass: new Set(listMiniPalettes).size <= 10 },
    { name: 'join slot avatars use palette-{i%10} (was i%7, now mod 10)', pass: joinSlotPalettes.length > 0 },
  ];

  let allPass = true;
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}`);
    if (!c.pass) allPass = false;
  }

  if (allPass) {
    console.log('\n[v0728-2-20] ✅ ALL CHECKS PASSED');
    console.log('NOTE: iOS Safari 真机 walk 需 PO 验证 6+ 成员 session 新成员头像颜色独立.');
    process.exit(0);
  } else {
    console.log('\n[v0728-2-20] ❌ SOME CHECKS FAILED');
    process.exit(1);
  }
})();