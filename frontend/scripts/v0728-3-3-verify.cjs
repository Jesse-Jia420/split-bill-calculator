// Playwright iPhone 13 @3x verify script for v0.3.0728-3 #3
// 在我的账本页, 整个列表的右上方添加提示文字 "左划以删除账本" — reverse v0.3.0728-2 #14 per-item hint
//
// 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
// 反 #101 ✅ Playwright 程序化 + DOM computed style + image tool 视觉三证
// 反 #150 v2 ✅ 真视觉位置 + 真数据
// 反 #151 ✅ PNG 截图存 ~/.openclaw/media/browser/v0728-3-3-sessions-list-hint/

const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.SBC_BASE || 'https://test.jessejia.pp.ua';
const SCREENSHOTS_DIR = path.join(process.env.HOME || '/home/node', '.openclaw/media/browser/v0728-3-3-sessions-list-hint');
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const iPhone13 = devices['iPhone 13'];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...iPhone13,
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  // 1. Login via BE API as xinhua1001 (who owns sessions 9 + 13 per earlier scan)
  console.log('[v0728-3-3] Step 1: login as xinhua1001@outlook.com');
  await context.request.post(`${BASE}/auth/send-code`, {
    data: { email: 'xinhua1001@outlook.com' },
  });
  await context.request.post(`${BASE}/auth/verify-code`, {
    data: { email: 'xinhua1001@outlook.com', code: '000000' },
  });

  // 2. Navigate to /sessions (sessions list page)
  console.log('[v0728-3-3] Step 2: navigate to /sessions');
  await page.goto(`${BASE}/sessions`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // 3. Verify list-top hint is visible (xinhua1001 owns sessions → hasOwnedSession=true → hint shows)
  console.log('[v0728-3-3] Step 3: verify list-top hint visible');
  const listHint = page.locator('[data-testid="list-top-hint-delete"]');
  const hintCount = await listHint.count();
  console.log(`  list-top-hint count: ${hintCount}`);

  // 4. Inspect list-top hint computed style
  console.log('[v0728-3-3] Step 4: inspect list-top hint computed style');
  const hintStyles = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="list-top-hint-delete"]');
    if (!el) return null;
    const cs = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      textContent: el.textContent.trim(),
      ariaLabel: el.getAttribute('aria-label'),
      display: cs.display,
      alignSelf: cs.alignSelf,
      marginLeft: cs.marginLeft,
      background: cs.background.substring(0, 50),
      color: cs.color,
      fontSize: cs.fontSize,
      borderRadius: cs.borderRadius,
      padding: cs.padding,
      pointerEvents: cs.pointerEvents,
      rect: { top: rect.top, right: rect.right, width: rect.width, height: rect.height },
    };
  });
  console.log(`  text: "${hintStyles?.textContent}"`);
  console.log(`  aria-label: "${hintStyles?.ariaLabel}"`);
  console.log(`  display: ${hintStyles?.display}, align-self: ${hintStyles?.alignSelf}, margin-left: ${hintStyles?.marginLeft}`);
  console.log(`  background: ${hintStyles?.background}`);
  console.log(`  color: ${hintStyles?.color}, font-size: ${hintStyles?.fontSize}, border-radius: ${hintStyles?.borderRadius}`);
  console.log(`  padding: ${hintStyles?.padding}, pointer-events: ${hintStyles?.pointerEvents}`);
  console.log(`  rect: top ${hintStyles?.rect.top}, right ${hintStyles?.rect.right}, width ${hintStyles?.rect.width}, height ${hintStyles?.rect.height}`);

  // 5. Verify hint is right-aligned within parent (margin-left: auto)
  console.log('[v0728-3-3] Step 5: verify right-aligned');
  const rightAligned = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="list-top-hint-delete"]');
    if (!el) return null;
    const parent = el.parentElement;
    const elRect = el.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    return {
      rightGap: parentRect.right - elRect.right,
      leftGap: elRect.left - parentRect.left,
      isRightAligned: parentRect.right - elRect.right < 20,
    };
  });
  console.log(`  right gap: ${rightAligned?.rightGap}, left gap: ${rightAligned?.leftGap}, right-aligned: ${rightAligned?.isRightAligned}`);

  // 6. Verify per-item .swipe-hint is GONE from each SessionCard (reverse v0.3.0728-2 #14)
  console.log('[v0728-3-3] Step 6: verify per-item .swipe-hint removed (reverse #14)');
  const perItemHintCount = await page.locator('.session-card .swipe-hint').count();
  console.log(`  per-item .swipe-hint count (should be 0): ${perItemHintCount}`);

  // 7. Verify hint is ABOVE the SessionCard list (top < first card top)
  console.log('[v0728-3-3] Step 7: verify hint above SessionCard list');
  const positions = await page.evaluate(() => {
    const hint = document.querySelector('[data-testid="list-top-hint-delete"]');
    const firstCard = document.querySelector('.session-card');
    if (!hint || !firstCard) return null;
    const hintRect = hint.getBoundingClientRect();
    const cardRect = firstCard.getBoundingClientRect();
    return {
      hintBottom: hintRect.bottom,
      cardTop: cardRect.top,
      hintAboveCard: hintRect.bottom <= cardRect.top + 4,
    };
  });
  console.log(`  hint bottom: ${positions?.hintBottom}, first card top: ${positions?.cardTop}, hint above card: ${positions?.hintAboveCard}`);

  // 8. Screenshot
  console.log('[v0728-3-3] Step 8: full page screenshot');
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '01-sessions-list-with-hint.png'),
    fullPage: false,
  });

  await browser.close();

  console.log('\n[v0728-3-3] === SUMMARY ===');
  const checks = [
    { name: 'list-top-hint-delete element exists (1)', pass: hintCount === 1 },
    { name: 'hint text = "← 左划以删除账本"', pass: hintStyles?.textContent === '←左划以删除账本' },
    { name: 'hint aria-label = "左划以删除账本"', pass: hintStyles?.ariaLabel === '左划以删除账本' },
    { name: 'hint display = inline-flex', pass: hintStyles?.display === 'inline-flex' },
    { name: 'hint align-self = flex-end (right-aligned in flex parent)', pass: hintStyles?.alignSelf === 'flex-end' },
    { name: 'hint background = rgba(99, 102, 241, 0.10) glass', pass: hintStyles?.background.includes('rgba(99, 102, 241, 0.1)') || hintStyles?.background.includes('99, 102, 241') },
    { name: 'hint font-size = 11px', pass: hintStyles?.fontSize === '11px' },
    { name: 'hint border-radius = 6px', pass: hintStyles?.borderRadius === '6px' },
    { name: 'hint pointer-events = none (不抢 click)', pass: hintStyles?.pointerEvents === 'none' },
    { name: 'hint right-aligned within parent (right gap < 20)', pass: rightAligned?.isRightAligned === true },
    { name: 'per-item .swipe-hint removed (count = 0, reverse #14)', pass: perItemHintCount === 0 },
    { name: 'hint ABOVE first SessionCard (hint bottom ≤ card top)', pass: positions?.hintAboveCard === true },
  ];

  let allPass = true;
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}`);
    if (!c.pass) allPass = false;
  }

  if (allPass) {
    console.log('\n[v0728-3-3] ✅ ALL CHECKS PASSED');
    console.log('NOTE: iOS Safari 真机 walk 需 PO 自验 /sessions → 列表顶部右侧应看到 glass pill "左划以删除账本".');
    process.exit(0);
  } else {
    console.log('\n[v0728-3-3] ❌ SOME CHECKS FAILED');
    process.exit(1);
  }
})();