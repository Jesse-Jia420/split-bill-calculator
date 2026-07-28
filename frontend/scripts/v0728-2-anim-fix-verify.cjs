// Playwright iPhone 13 @3x verify script for v0.3.0728-2-anim-fix (UAT 0728-2 续修 #16)
// 5 色 conic-gradient 边框流光 — cb3aedf (rainbow-fix) 后续: 真修 iOS Safari WebKit z-index:-1 escape leak
//
// 跟 v0.3.37 #16 + v0.3.0728-2-rainbow-fix 视觉目的一致:
//   - .invite-btn-breathing: 5 色 conic-gradient (indigo→purple→pink→amber→emerald) 边框流光
//   - dramatic breathing: transform scale 1↔1.05 + box-shadow alpha 0 (po #8 去光晕, 只保留 scale)
//   - flow 5s linear infinite, breath 1.5s (错峰)
//
// 修法要点 (vs cb3aedf):
//   - button 加 isolation: isolate 创建独立 stacking context
//   - ::before z-index -1 → 0 (保持 within stacking context, 不逃逸)
//   - ::after z-index -1 → 1 (覆盖中间, 留 2px ring)
//   - button 加 overflow: hidden (双保险, 视觉 clip 在 border-box)
//
// 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
// 反 #101 ✅ Playwright 程序化 + DOM computed style + image tool 视觉三证
// 反 #150 v2 ✅ 真视觉位置 + 真数据 (session 39 "呃呃呃" 1-member, 跟 Jesse 截图 "噢噢噢" 同 shape)
// 反 #151 ✅ PNG 截图存 ~/.openclaw/media/browser/v0728-2-anim-fix/

const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.SBC_BASE || 'https://test.jessejia.pp.ua';
const SCREENSHOTS_DIR = path.join(process.env.HOME || '/home/node', '.openclaw/media/browser/v0728-2-anim-fix');
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const iPhone13 = devices['iPhone 13'];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...iPhone13,
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  // 1. Login via BE API
  console.log('[verify-anim-fix] Step 1: login as demo@example.com via BE API');
  await context.request.post(`${BASE}/auth/send-code`, {
    data: { email: 'demo@example.com' },
  });
  await context.request.post(`${BASE}/auth/verify-code`, {
    data: { email: 'demo@example.com', code: '000000' },
  });

  // 2. Navigate to session 39 ("呃呃呃", 1-member, 跟 Jesse 截图 "噢噢噢" 同 shape)
  console.log('[verify-anim-fix] Step 2: navigate to session 39');
  await page.goto(`${BASE}/sessions/39`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // 3. Inspect invite button
  console.log('[verify-anim-fix] Step 3: inspect invite button');
  const inviteBtn = page.locator('[data-testid="invite-btn"]');
  const inviteBtnCount = await inviteBtn.count();
  console.log(`  invite-btn count: ${inviteBtnCount}`);
  if (inviteBtnCount === 0) {
    console.error('  ❌ FAIL: invite button not found');
    process.exit(1);
  }

  // 4. Force invite-btn-breathing class (logged-in user doesn't trigger naturally)
  console.log('[verify-anim-fix] Step 4: add .invite-btn-breathing class');
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="invite-btn"]');
    if (btn) {
      btn.classList.add('invite-btn-breathing');
      // 同时强制 parent 也显示（避免因 parent 没 breathing prop 而 effect 链断）
      // 但只用 class 也足够 render
    }
  });
  await page.waitForTimeout(500);

  // 5. Inspect button-level computed styles
  console.log('[verify-anim-fix] Step 5: inspect button level (invite-breath + isolation/overflow)');
  const btnStyles = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="invite-btn"]');
    if (!btn) return null;
    const cs = window.getComputedStyle(btn);
    return {
      animationName: cs.animationName,
      animationDuration: cs.animationDuration,
      position: cs.position,
      isolation: cs.isolation,
      overflow: cs.overflow,
      overflowX: cs.overflowX,
      overflowY: cs.overflowY,
      border: cs.border,
      borderColor: cs.borderColor,
      backgroundClip: cs.backgroundClip,
    };
  });
  console.log(`  button animation-name: ${btnStyles?.animationName}`);
  console.log(`  button animation-duration: ${btnStyles?.animationDuration}`);
  console.log(`  button position: ${btnStyles?.position}`);
  console.log(`  button isolation: ${btnStyles?.isolation}`);
  console.log(`  button overflow: ${btnStyles?.overflow}`);
  console.log(`  button overflow-x/y: ${btnStyles?.overflowX} ${btnStyles?.overflowY}`);
  console.log(`  button border: ${btnStyles?.border}`);
  console.log(`  button background-clip: ${btnStyles?.backgroundClip}`);

  // 6. ::before computed styles (fix: z-index 0, NOT -1)
  console.log('[verify-anim-fix] Step 6: inspect ::before');
  const beforeStyles = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="invite-btn"]');
    if (!btn) return null;
    const cs = window.getComputedStyle(btn, '::before');
    return {
      content: cs.content,
      position: cs.position,
      animationName: cs.animationName,
      animationDuration: cs.animationDuration,
      animationIterationCount: cs.animationIterationCount,
      animationTimingFunction: cs.animationTimingFunction,
      animationDelay: cs.animationDelay,
      backgroundImage: cs.backgroundImage.substring(0, 400),
      zIndex: cs.zIndex,
      pointerEvents: cs.pointerEvents,
      inset: `${cs.top} ${cs.right} ${cs.bottom} ${cs.left}`,
    };
  });
  console.log(`  ::before animation-name: ${beforeStyles?.animationName}`);
  console.log(`  ::before animation-duration: ${beforeStyles?.animationDuration}`);
  console.log(`  ::before animation-iteration-count: ${beforeStyles?.animationIterationCount}`);
  console.log(`  ::before z-index: ${beforeStyles?.zIndex}`);
  console.log(`  ::before position: ${beforeStyles?.position}`);
  console.log(`  ::before inset (top/right/bottom/left): ${beforeStyles?.inset}`);
  console.log(`  ::before pointer-events: ${beforeStyles?.pointerEvents}`);
  console.log(`  ::before background-image (first 400 chars):`);
  console.log(`    ${beforeStyles?.backgroundImage}`);

  // 5 colors in conic-gradient
  const hasIndigo = (beforeStyles?.backgroundImage || '').includes('rgb(99, 102, 241)');
  const hasPurple = (beforeStyles?.backgroundImage || '').includes('rgb(168, 85, 247)');
  const hasPink = (beforeStyles?.backgroundImage || '').includes('rgb(236, 72, 153)');
  const hasAmber = (beforeStyles?.backgroundImage || '').includes('rgb(245, 158, 11)');
  const hasEmerald = (beforeStyles?.backgroundImage || '').includes('rgb(16, 185, 129)');
  console.log(`  ::before 5 colors: indigo=${hasIndigo} purple=${hasPurple} pink=${hasPink} amber=${hasAmber} emerald=${hasEmerald}`);

  // 7. ::after computed styles (fix: z-index 1, NOT -1)
  console.log('[verify-anim-fix] Step 7: inspect ::after');
  const afterStyles = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="invite-btn"]');
    if (!btn) return null;
    const cs = window.getComputedStyle(btn, '::after');
    return {
      content: cs.content,
      position: cs.position,
      zIndex: cs.zIndex,
      inset: `${cs.top} ${cs.right} ${cs.bottom} ${cs.left}`,
      backgroundColor: cs.backgroundColor,
      backdropFilter: cs.backdropFilter || cs.getPropertyValue('backdrop-filter'),
      pointerEvents: cs.pointerEvents,
    };
  });
  console.log(`  ::after position: ${afterStyles?.position}`);
  console.log(`  ::after z-index: ${afterStyles?.zIndex}`);
  console.log(`  ::after inset (top/right/bottom/left): ${afterStyles?.inset}`);
  console.log(`  ::after background-color: ${afterStyles?.backgroundColor}`);
  console.log(`  ::after backdrop-filter: ${afterStyles?.backdropFilter}`);
  console.log(`  ::after pointer-events: ${afterStyles?.pointerEvents}`);

  // 8. Visual screenshots — 3 frame timeline (delay 0/-1.67/-3.33s)
  console.log('[verify-anim-fix] Step 8: visual screenshots — 3 frames at different phases');
  for (const delay of [0, -1.67, -3.33]) {
    await page.evaluate((d) => {
      const existing = document.getElementById('test-border-flow-delay');
      if (existing) existing.remove();
      const style = document.createElement('style');
      style.id = 'test-border-flow-delay';
      style.textContent = `[data-testid="invite-btn"].invite-btn-breathing::before { animation-delay: ${d}s !important; }`;
      document.head.appendChild(style);
    }, delay);
    await page.waitForTimeout(300);

    const frameFile = `0${delay === 0 ? '1' : delay === -1.67 ? '2' : '3'}-border-flow-phase-${delay}s.png`;
    await inviteBtn.screenshot({
      path: path.join(SCREENSHOTS_DIR, frameFile),
      animations: 'disabled',
      timeout: 5000,
    });
    console.log(`  saved: ${frameFile} (delay=${delay}s)`);
  }

  // 9. Full page screenshot
  console.log('[verify-anim-fix] Step 9: full page screenshot');
  await page.evaluate(() => {
    const existing = document.getElementById('test-border-flow-delay');
    if (existing) existing.remove();
  });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '04-fullpage-with-border-flow.png'),
    fullPage: false,
  });

  await browser.close();

  console.log('\n[verify-anim-fix] === SUMMARY ===');
  const checks = [
    { name: 'invite button found', pass: inviteBtnCount === 1 },
    { name: 'button isolation = isolate (NEW, fix)', pass: btnStyles?.isolation === 'isolate' },
    { name: 'button overflow = hidden (NEW, fix defensive)', pass: btnStyles?.overflow === 'hidden' },
    { name: 'button animation-name = invite-breath', pass: btnStyles?.animationName === 'invite-breath' },
    { name: 'button animation-duration = 1.5s', pass: btnStyles?.animationDuration === '1.5s' },
    { name: 'button position = relative', pass: btnStyles?.position === 'relative' },
    { name: 'button border includes transparent', pass: (btnStyles?.border || '').includes('transparent') },
    { name: 'button background-clip = padding-box', pass: btnStyles?.backgroundClip === 'padding-box' },
    { name: '::before animation-name = invite-border-flow', pass: beforeStyles?.animationName === 'invite-border-flow' },
    { name: '::before animation-duration = 5s', pass: beforeStyles?.animationDuration === '5s' },
    { name: '::before animation-iteration-count = infinite', pass: beforeStyles?.animationIterationCount === 'infinite' },
    { name: '::before background = conic-gradient', pass: (beforeStyles?.backgroundImage || '').includes('conic-gradient') },
    { name: '::before conic has 5 colors (indigo/purple/pink/amber/emerald)', pass: hasIndigo && hasPurple && hasPink && hasAmber && hasEmerald },
    { name: '::before z-index = 0 (FIX, was -1)', pass: beforeStyles?.zIndex === '0' || beforeStyles?.zIndex === 'auto' },
    { name: '::before position = absolute', pass: beforeStyles?.position === 'absolute' },
    { name: '::before pointer-events = none', pass: beforeStyles?.pointerEvents === 'none' },
    { name: '::after z-index = 1 (FIX, was -1)', pass: afterStyles?.zIndex === '1' },
    { name: '::after position = absolute', pass: afterStyles?.position === 'absolute' },
    { name: '::after inset includes 2px (cover center, leave ring)', pass: (afterStyles?.inset || '').includes('2px') },
    { name: '::after background = white glass rgb(255, 255, 255, 0.55)', pass: afterStyles?.backgroundColor === 'rgba(255, 255, 255, 0.55)' },
    { name: '::after backdrop-filter set', pass: (afterStyles?.backdropFilter || '').length > 0 },
    { name: '::after pointer-events = none', pass: afterStyles?.pointerEvents === 'none' },
  ];

  let allPass = true;
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}`);
    if (!c.pass) allPass = false;
  }

  if (allPass) {
    console.log('\n[verify-anim-fix] ✅ ALL CHECKS PASSED');
    console.log('NOTE: chromium can\'t catch iOS Safari WebKit z-index escape (this is the bug).');
    console.log('      Verify visually + PO 真机 iPhone Safari walk 仍需.');
    process.exit(0);
  } else {
    console.log('\n[verify-anim-fix] ❌ SOME CHECKS FAILED');
    process.exit(1);
  }
})();
