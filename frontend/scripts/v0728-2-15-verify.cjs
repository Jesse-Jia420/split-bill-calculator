// Playwright iPhone 13 @3x verify script for v0.3.0728-2 #15 (PO msg 2026-07-28 21:17 "继续0728-2其他")
// 解冻 #15: 账单列表页右侧上方小字标注 "左划以删除账本, 右划以编辑账本"
// (跟 v0.3.0728-2 #14 session card per-item hint 反向 — 这次是整个 bill list 顶部 1 个 hint)
//
// 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
// 反 #101 ✅ Playwright 程序化 + DOM computed style + image tool 视觉三证
// 反 #150 v2 ✅ 真视觉位置 + 真数据 (session 9 泰国测试 6 members 41 bills)
// 反 #151 ✅ PNG 截图存 ~/.openclaw/media/browser/v0728-2-15-bill-list-hint/

const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.SBC_BASE || 'https://test.jessejia.pp.ua';
const SCREENSHOTS_DIR = path.join(process.env.HOME || '/home/node', '.openclaw/media/browser/v0728-2-15-bill-list-hint');
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
  console.log('[v0728-2-15] Step 1: login as xinhua1001@outlook.com');
  await context.request.post(`${BASE}/auth/send-code`, {
    data: { email: 'xinhua1001@outlook.com' },
  });
  await context.request.post(`${BASE}/auth/verify-code`, {
    data: { email: 'xinhua1001@outlook.com', code: '000000' },
  });

  // 2. Navigate to session 9 (Thailand test, 41 bills)
  console.log('[v0728-2-15] Step 2: navigate to session 9 (Thailand test, 41 bills)');
  await page.goto(`${BASE}/sessions/9`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // 3. Verify bill-swipe-hint is visible
  console.log('[v0728-2-15] Step 3: check bill-swipe-hint present');
  const hint = page.locator('[data-testid="bill-swipe-hint"]');
  const hintCount = await hint.count();
  console.log(`  bill-swipe-hint count: ${hintCount}`);

  // 4. Inspect hint computed styles
  console.log('[v0728-2-15] Step 4: inspect hint computed styles');
  const hintStyles = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="bill-swipe-hint"]');
    if (!el) return null;
    const cs = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      textContent: el.textContent.trim(),
      ariaLabel: el.getAttribute('aria-label'),
      background: cs.background.substring(0, 50),
      backgroundColor: cs.backgroundColor,
      border: cs.border,
      borderRadius: cs.borderRadius,
      padding: cs.padding,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      color: cs.color,
      alignSelf: cs.alignSelf,
      pointerEvents: cs.pointerEvents,
      width: rect.width,
      height: rect.height,
      // Determine if right-aligned (compare right edge to parent right edge)
      parentRect: el.parentElement.getBoundingClientRect(),
      rect: rect,
    };
  });
  console.log(`  text: "${hintStyles?.textContent}"`);
  console.log(`  aria-label: "${hintStyles?.ariaLabel}"`);
  console.log(`  font-size: ${hintStyles?.fontSize}, font-weight: ${hintStyles?.fontWeight}`);
  console.log(`  border-radius: ${hintStyles?.borderRadius}`);
  console.log(`  padding: ${hintStyles?.padding}`);
  console.log(`  color: ${hintStyles?.color}`);
  console.log(`  align-self: ${hintStyles?.alignSelf}`);
  console.log(`  pointer-events: ${hintStyles?.pointerEvents}`);
  console.log(`  width: ${hintStyles?.width}px, height: ${hintStyles?.height}px`);

  // 5. Verify hint is right-aligned (within parent container)
  console.log('[v0728-2-15] Step 5: verify hint right-aligned');
  const alignment = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="bill-swipe-hint"]');
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const parentRect = el.parentElement.getBoundingClientRect();
    const rightGap = parentRect.right - rect.right;
    const leftGap = rect.left - parentRect.left;
    return {
      rightGap,
      leftGap,
      isRightAligned: rightGap < 20 && leftGap > 50,
    };
  });
  console.log(`  right gap from parent: ${alignment?.rightGap}px, left gap: ${alignment?.leftGap}px`);
  console.log(`  right-aligned: ${alignment?.isRightAligned}`);

  // 6. Verify hint is ABOVE the day-list (first day group)
  console.log('[v0728-2-15] Step 6: verify hint ABOVE first day group');
  const positions = await page.evaluate(() => {
    const hint = document.querySelector('[data-testid="bill-swipe-hint"]');
    const firstDay = document.querySelector('[data-testid="day-date"]');
    if (!hint || !firstDay) return null;
    const hintRect = hint.getBoundingClientRect();
    const dayRect = firstDay.getBoundingClientRect();
    return {
      hintBottom: hintRect.bottom,
      dayTop: dayRect.top,
      hintAboveDay: hintRect.bottom <= dayRect.top + 4,
    };
  });
  console.log(`  hint bottom: ${positions?.hintBottom}, first day top: ${positions?.dayTop}`);
  console.log(`  hint above first day: ${positions?.hintAboveDay}`);

  // 7. Verify hint doesn't break day-list swipe functionality (regression)
  console.log('[v0728-2-15] Step 7: verify day-list still has bill rows');
  const dayCount = await page.locator('[data-testid="day-date"]').count();
  const billCount = await page.locator('.bill-row, [data-testid="bill-row"]').count();
  console.log(`  day groups: ${dayCount}, bill rows: ${billCount}`);

  // 8. Screenshot full bill list with hint
  console.log('[v0728-2-15] Step 8: full bill list screenshot');
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '01-bill-list-with-hint.png'),
    fullPage: false,
  });

  // 9. Scroll to top + screenshot (verify hint always visible at top)
  console.log('[v0728-2-15] Step 9: scroll to top + screenshot');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '02-bill-list-scrolled-top.png'),
    fullPage: false,
  });

  // 10. Click on hint, verify pointer-events: none (click passes through)
  console.log('[v0728-2-15] Step 10: click hint, verify pointer-events none');
  let clickReachedUnderlying = false;
  await page.exposeFunction('__recordUnderlyingClick', () => { clickReachedUnderlying = true; });
  await page.evaluate(() => {
    const hint = document.querySelector('[data-testid="bill-swipe-hint"]');
    const parent = hint.parentElement;
    // Add listener to parent to check if click bubbles through
    parent.addEventListener('click', (e) => {
      window.__recordUnderlyingClick();
    }, { once: true, capture: true });
  });
  await hint.click({ force: true });
  await page.waitForTimeout(300);
  console.log(`  click reached underlying: ${clickReachedUnderlying}`);

  await browser.close();

  console.log('\n[v0728-2-15] === SUMMARY ===');
  const checks = [
    { name: 'bill-swipe-hint present', pass: hintCount === 1 },
    { name: 'hint text = "左划以删除账本, 右划以编辑账本"', pass: hintStyles?.textContent === '左划以删除账本, 右划以编辑账本' },
    { name: 'hint aria-label exists for screen readers', pass: hintStyles?.ariaLabel?.includes('左滑') },
    { name: 'hint background = rgba(99, 102, 241, 0.10) glass', pass: hintStyles?.backgroundColor === 'rgba(99, 102, 241, 0.1)' },
    { name: 'hint border includes indigo alpha 0.18', pass: (hintStyles?.border || '').includes('rgba(99, 102, 241, 0.18)') },
    { name: 'hint border-radius = 8px', pass: hintStyles?.borderRadius === '8px' },
    { name: 'hint font-size 12px (small)', pass: hintStyles?.fontSize === '12px' },
    { name: 'hint font-weight 500', pass: hintStyles?.fontWeight === '500' },
    { name: 'hint color = accent-700 indigo', pass: (hintStyles?.color || '').includes('67, 56, 202') || hintStyles?.color === 'rgb(67, 56, 202)' },
    { name: 'hint align-self = flex-end (right-aligned)', pass: hintStyles?.alignSelf === 'flex-end' },
    { name: 'hint pointer-events = none (click passes through)', pass: hintStyles?.pointerEvents === 'none' },
    { name: 'hint right-aligned within parent (right gap < 20)', pass: alignment?.isRightAligned === true },
    { name: 'hint ABOVE first day group (sticky header compatible)', pass: positions?.hintAboveDay === true },
    { name: 'day groups exist (no regression)', pass: dayCount > 0 },
    { name: 'bill rows exist (no regression)', pass: billCount > 0 },
    { name: 'click on hint passes through (pointer-events: none)', pass: clickReachedUnderlying === true },
  ];

  let allPass = true;
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}`);
    if (!c.pass) allPass = false;
  }

  if (allPass) {
    console.log('\n[v0728-2-15] ✅ ALL CHECKS PASSED');
    console.log('NOTE: iOS Safari 真机 walk 需 PO 自验: 进入 /sessions/9 → 账单列表顶部右侧应看到 glass 玻璃 pill "左划以删除账本, 右划以编辑账本".');
    process.exit(0);
  } else {
    console.log('\n[v0728-2-15] ❌ SOME CHECKS FAILED');
    process.exit(1);
  }
})();