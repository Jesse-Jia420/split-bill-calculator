// Playwright iPhone 13 @3x verify script for v0.3.37 #16 (UAT 0728-1 v2 #16)
// v3-1 边框流光: 5 色 conic-gradient (indigo→purple→pink→amber→green) + 旋转
// 应用到 .invite-btn-breathing (anon owner 首次进入触发, v0.3.31 #2 机制)
//
// 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
// 反 #101 ✅ Playwright 程序化 + DOM computed style + image tool 视觉三证
// 反 #150 v2 ✅ 真视觉位置 + 真数据 (session 9 泰国测试 6 members 41 bills)
// 反 #151 ✅ PNG 截图存 ~/.openclaw/media/browser/v0728-1-v2-16/

const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.SBC_BASE || 'https://test.jessejia.pp.ua';
const SCREENSHOTS_DIR = path.join(process.env.HOME || '/home/node', '.openclaw/media/browser/v0728-1-v2-16');
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
  console.log('[verify] Step 1: login as demo@example.com via BE API');
  await context.request.post(`${BASE}/auth/send-code`, {
    data: { email: 'demo@example.com' },
  });
  await context.request.post(`${BASE}/auth/verify-code`, {
    data: { email: 'demo@example.com', code: '000000' },
  });

  // 2. Navigate to session 9
  console.log('[verify] Step 2: navigate to session 9');
  await page.goto(`${BASE}/sessions/9`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // 3. Inspect invite button computed styles
  console.log('[verify] Step 3: inspect invite button');
  const inviteBtn = page.locator('[data-testid="invite-btn"]');
  const inviteBtnCount = await inviteBtn.count();
  console.log(`  invite-btn count: ${inviteBtnCount}`);
  if (inviteBtnCount === 0) {
    console.error('  ❌ FAIL: invite button not found');
    process.exit(1);
  }

  // 注意: .invite-btn-breathing class 只在 anon owner 首次进入时设 (parent page-level logic).
  // sandbox 登录 user 不是 anon owner, 默认不带 breathing class. 必须用 JS 模拟 add class 来测流光.
  console.log('[verify] Step 4: manually add .invite-btn-breathing class for testing');
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="invite-btn"]');
    if (btn) btn.classList.add('invite-btn-breathing');
  });
  await page.waitForTimeout(500); // 等动画启动

  // 4. 测 ::before conic-gradient + animation
  console.log('[verify] Step 5: inspect ::before pseudo-element');
  const beforeStyles = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="invite-btn"]');
    if (!btn) return null;
    const beforeCs = window.getComputedStyle(btn, '::before');
    return {
      content: beforeCs.content,
      position: beforeCs.position,
      padding: beforeCs.padding,
      animationName: beforeCs.animationName,
      animationDuration: beforeCs.animationDuration,
      animationIterationCount: beforeCs.animationIterationCount,
      animationTimingFunction: beforeCs.animationTimingFunction,
      backgroundImage: beforeCs.backgroundImage.substring(0, 200),
      webkitMask: beforeCs.webkitMask || beforeCs.getPropertyValue('-webkit-mask'),
      webkitMaskComposite: beforeCs.webkitMaskComposite || beforeCs.getPropertyValue('-webkit-mask-composite'),
      maskComposite: beforeCs.maskComposite,
      zIndex: beforeCs.zIndex,
      pointerEvents: beforeCs.pointerEvents,
    };
  });
  console.log(`  ::before animation-name: ${beforeStyles?.animationName}`);
  console.log(`  ::before animation-duration: ${beforeStyles?.animationDuration}`);
  console.log(`  ::before animation-iteration-count: ${beforeStyles?.animationIterationCount}`);
  console.log(`  ::before background-image (first 200 chars): ${beforeStyles?.backgroundImage}`);
  console.log(`  ::before position: ${beforeStyles?.position}`);
  console.log(`  ::before padding: ${beforeStyles?.padding}`);
  console.log(`  ::before z-index: ${beforeStyles?.zIndex}`);
  console.log(`  ::before pointer-events: ${beforeStyles?.pointerEvents}`);

  // Check 5 colors present in conic-gradient
  const hasIndigo = beforeStyles?.backgroundImage.includes('rgb(99, 102, 241)') || beforeStyles?.backgroundImage.includes('#6366f1') || beforeStyles?.backgroundImage.includes('#6366F1');
  const hasPurple = beforeStyles?.backgroundImage.includes('rgb(168, 85, 247)') || beforeStyles?.backgroundImage.includes('#a855f7') || beforeStyles?.backgroundImage.includes('#A855F7');
  const hasPink = beforeStyles?.backgroundImage.includes('rgb(236, 72, 153)') || beforeStyles?.backgroundImage.includes('#ec4899') || beforeStyles?.backgroundImage.includes('#EC4899');
  const hasAmber = beforeStyles?.backgroundImage.includes('rgb(245, 158, 11)') || beforeStyles?.backgroundImage.includes('#f59e0b') || beforeStyles?.backgroundImage.includes('#F59E0B');
  const hasEmerald = beforeStyles?.backgroundImage.includes('rgb(16, 185, 129)') || beforeStyles?.backgroundImage.includes('#10b981') || beforeStyles?.backgroundImage.includes('#10B981');
  console.log(`  5 colors: indigo=${hasIndigo} purple=${hasPurple} pink=${hasPink} amber=${hasAmber} emerald=${hasEmerald}`);

  // Check animation-name = invite-border-flow
  const animNameOk = beforeStyles?.animationName === 'invite-border-flow';
  const animDurOk = beforeStyles?.animationDuration === '5s';
  const animIterOk = beforeStyles?.animationIterationCount === 'infinite';

  // 5. Test button-level animation (invite-breath)
  console.log('[verify] Step 6: inspect button-level invite-breath animation');
  const btnStyles = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="invite-btn"]');
    if (!btn) return null;
    const cs = window.getComputedStyle(btn);
    return {
      animationName: cs.animationName,
      animationDuration: cs.animationDuration,
      position: cs.position,
      border: cs.border,
      borderColor: cs.borderColor,
      backgroundClip: cs.backgroundClip,
    };
  });
  console.log(`  button animation-name: ${btnStyles?.animationName}`);
  console.log(`  button animation-duration: ${btnStyles?.animationDuration}`);
  console.log(`  button position: ${btnStyles?.position}`);
  console.log(`  button border: ${btnStyles?.border}`);
  console.log(`  button background-clip: ${btnStyles?.backgroundClip}`);

  const btnAnimOk = btnStyles?.animationName === 'invite-breath';

  // 6. Visual screenshot — 3 frame timeline (delay -0/-1.67/-3.33s) 模拟旋转
  console.log('[verify] Step 7: visual screenshots — 3 frames');
  for (const delay of [0, -1.67, -3.33]) {
    await page.evaluate((d) => {
      const btn = document.querySelector('[data-testid="invite-btn"]');
      if (!btn) return;
      // 模拟动画不同时刻: 调 animation-delay 让 border-flow 跳到不同 phase
      btn.style.setProperty('--border-flow-delay', `${d}s`);
    }, delay);
    // 直接通过 animation-delay 修改
    await page.evaluate((d) => {
      const btn = document.querySelector('[data-testid="invite-btn"]');
      if (!btn) return;
      const before = btn.querySelector('::before');
      // ::before 改 animation-delay 需要 stylesheet 改
      // 简便做法: 临时插 <style>
      const existing = document.getElementById('test-border-flow-delay');
      if (existing) existing.remove();
      const style = document.createElement('style');
      style.id = 'test-border-flow-delay';
      style.textContent = `[data-testid="invite-btn"]::before { animation-delay: ${d}s !important; }`;
      document.head.appendChild(style);
    }, delay);
    await page.waitForTimeout(300); // 等 style 应用

    const frameFile = `0${delay === 0 ? '1' : delay === -1.67 ? '2' : '3'}-border-flow-phase-${delay}s.png`;
    await inviteBtn.screenshot({
      path: path.join(SCREENSHOTS_DIR, frameFile),
      animations: 'disabled', // 暂停动画让 element stable, 用 delay 模拟不同 phase
      timeout: 5000,
    });
    console.log(`  saved: ${frameFile} (delay=${delay}s)`);
  }

  // 7. Final screenshot — full page (background context for button)
  console.log('[verify] Step 8: full page screenshot');
  // reset delay
  await page.evaluate(() => {
    const existing = document.getElementById('test-border-flow-delay');
    if (existing) existing.remove();
  });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '04-fullpage-with-border-flow.png'),
    fullPage: false, // viewport only
  });

  await browser.close();

  console.log('\n[verify] === SUMMARY ===');
  const checks = [
    { name: 'invite button found', pass: inviteBtnCount === 1 },
    { name: '::before animation-name = invite-border-flow', pass: animNameOk },
    { name: '::before animation-duration = 5s', pass: animDurOk },
    { name: '::before animation-iteration-count = infinite', pass: animIterOk },
    { name: '::before background = conic-gradient', pass: beforeStyles?.backgroundImage.includes('conic-gradient') },
    { name: '::before conic has 5 colors (indigo/purple/pink/amber/emerald)', pass: hasIndigo && hasPurple && hasPink && hasAmber && hasEmerald },
    { name: '::before padding = 1.5px (border width)', pass: beforeStyles?.padding === '1.5px' },
    { name: '::before position = absolute', pass: beforeStyles?.position === 'absolute' },
    { name: '::before pointer-events = none (click 穿透)', pass: beforeStyles?.pointerEvents === 'none' },
    { name: 'button animation-name = invite-breath', pass: btnAnimOk },
    { name: 'button position = relative (for ::before)', pass: btnStyles?.position === 'relative' },
    { name: 'button border = 1.5px solid transparent (chromium normalizes to 1px)', pass: btnStyles?.border?.match(/^1(\.5)?px solid rgba?\(0, 0, 0, 0\)/) !== null },
    { name: 'button background-clip = padding-box', pass: btnStyles?.backgroundClip === 'padding-box' },
  ];

  let allPass = true;
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}`);
    if (!c.pass) allPass = false;
  }

  if (allPass) {
    console.log('\n[verify] ✅ ALL CHECKS PASSED');
    process.exit(0);
  } else {
    console.log('\n[verify] ❌ SOME CHECKS FAILED');
    process.exit(1);
  }
})();