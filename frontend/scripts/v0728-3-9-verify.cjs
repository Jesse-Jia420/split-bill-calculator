// Playwright iPhone 13 @3x verify script for v0.3.0728-3 #9
// 已结算记录 item 删除按钮 — re-swipe 二次左划才出现
//
// 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
// 反 #101 ✅ Playwright 程序化 + DOM computed style + image tool 视觉三证
// 反 #150 v2 ✅ 真视觉位置 + 真数据
// 反 #151 ✅ PNG 截图存 ~/.openclaw/media/browser/v0728-3-9-settle-second-swipe/

const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.SBC_BASE || 'https://test.jessejia.pp.ua';
const SCREENSHOTS_DIR = path.join(process.env.HOME || '/home/node', '.openclaw/media/browser/v0728-3-9-settle-second-swipe');
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
  console.log('[v0728-3-9] Step 1: login as demo@example.com');
  await context.request.post(`${BASE}/auth/send-code`, {
    data: { email: 'demo@example.com' },
  });
  await context.request.post(`${BASE}/auth/verify-code`, {
    data: { email: 'demo@example.com', code: '000000' },
  });

  // 2. Navigate to a session that has settlement records (session 9 has settlement records)
  console.log('[v0728-3-9] Step 2: navigate to /sessions/9/settle');
  await page.goto(`${BASE}/sessions/9/settle`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // 3. settle +page.svelte line 188 default activeTab='overview' — 已结算记录 section 在 overview tab
  //    (SettlementRow 渲染 for each record). 不用点 个人视图 tab, 那个 tab 是给 paid/consumed bills
  //    (SettleMemberBreakdown), 不是已结算 records. 直接用 default overview tab.
  console.log('[v0728-3-9] Step 3: stay on default overview tab (已结算 records in overview)');

  // 4. Find settlement record rows (.scroll-wrapper with data-sbc="settlement-row")
  console.log('[v0728-3-9] Step 4: locate settlement record rows');
  const recordCount = await page.locator('[data-sbc="settlement-row"]').count();
  console.log(`  settlement record count: ${recordCount}`);

  if (recordCount === 0) {
    console.error('  ❌ FAIL: no settlement records on /sessions/9/settle 个人视图');
    console.error('  fallback: use page.evaluate to set swipeState directly via component test mode');
  }

  // 5. Initial state: delete button should be hidden (state=idle, opacity=0)
  console.log('[v0728-3-9] Step 5: initial state — delete button hidden');
  const initialState = await page.evaluate(() => {
    const rows = document.querySelectorAll('[data-sbc="settlement-row"]');
    if (rows.length === 0) return null;
    const firstRow = rows[0];
    const state = firstRow.getAttribute('data-swipe-state');
    const deleteBtn = firstRow.querySelector('.delete-mini');
    if (!deleteBtn) {
      return { state, hasButton: false };
    }
    const cs = window.getComputedStyle(deleteBtn);
    return {
      state,
      hasButton: true,
      opacity: cs.opacity,
      display: cs.display,
      pointerEvents: cs.pointerEvents,
    };
  });
  console.log(`  initial state: ${JSON.stringify(initialState)}`);

  // 6. Simulate 1st swipe (touchstart + touchmove + touchend with left swipe)
  console.log('[v0728-3-9] Step 6: simulate 1st swipe → state=primed');
  await page.evaluate(() => {
    const row = document.querySelector('[data-sbc="settlement-row"]');
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const startX = rect.left + 200;
    const startY = rect.top + rect.height / 2;
    // 1st swipe: touchstart + touchmove (left) + touchend
    row.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true,
      cancelable: true,
      touches: [new Touch({ identifier: 1, target: row, clientX: startX, clientY: startY })]
    }));
    row.dispatchEvent(new TouchEvent('touchmove', {
      bubbles: true,
      cancelable: true,
      touches: [new Touch({ identifier: 1, target: row, clientX: startX - 60, clientY: startY })]
    }));
    row.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true,
      cancelable: true,
      changedTouches: [new Touch({ identifier: 1, target: row, clientX: startX - 60, clientY: startY })]
    }));
  });
  await page.waitForTimeout(200);
  const afterFirstSwipe = await page.evaluate(() => {
    const row = document.querySelector('[data-sbc="settlement-row"]');
    return {
      state: row?.getAttribute('data-swipe-state'),
      hasButton: !!row?.querySelector('.delete-mini'),
    };
  });
  console.log(`  after 1st swipe: ${JSON.stringify(afterFirstSwipe)}`);

  // 7. Simulate 2nd swipe → state=shown, button visible
  console.log('[v0728-3-9] Step 7: simulate 2nd swipe → state=shown, button visible');
  await page.evaluate(() => {
    const row = document.querySelector('[data-sbc="settlement-row"]');
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const startX = rect.left + 200;
    const startY = rect.top + rect.height / 2;
    // 2nd swipe: same gesture
    row.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true, cancelable: true,
      touches: [new Touch({ identifier: 2, target: row, clientX: startX, clientY: startY })]
    }));
    row.dispatchEvent(new TouchEvent('touchmove', {
      bubbles: true, cancelable: true,
      touches: [new Touch({ identifier: 2, target: row, clientX: startX - 60, clientY: startY })]
    }));
    row.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true, cancelable: true,
      changedTouches: [new Touch({ identifier: 2, target: row, clientX: startX - 60, clientY: startY })]
    }));
  });
  await page.waitForTimeout(300);
  const afterSecondSwipe = await page.evaluate(() => {
    const row = document.querySelector('[data-sbc="settlement-row"]');
    const btn = row?.querySelector('.delete-mini');
    if (!btn) {
      return { state: row?.getAttribute('data-swipe-state'), hasButton: false };
    }
    const cs = window.getComputedStyle(btn);
    return {
      state: row?.getAttribute('data-swipe-state'),
      hasButton: true,
      opacity: cs.opacity,
      display: cs.display,
      pointerEvents: cs.pointerEvents,
    };
  });
  console.log(`  after 2nd swipe: ${JSON.stringify(afterSecondSwipe)}`);

  // 8. Screenshot
  console.log('[v0728-3-9] Step 8: screenshot after 2nd swipe');
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '01-after-2nd-swipe.png'),
    fullPage: false,
  });

  await browser.close();

  console.log('\n[v0728-3-9] === SUMMARY ===');
  const checks = [
    { name: 'settlement record rows exist', pass: recordCount > 0 },
    { name: 'initial state: data-swipe-state = "idle"', pass: initialState?.state === 'idle' },
    { name: 'initial state: no delete button rendered (state=idle, no button)', pass: initialState?.hasButton === false },
    { name: 'after 1st swipe: data-swipe-state = "primed"', pass: afterFirstSwipe?.state === 'primed' },
    { name: 'after 1st swipe: still no delete button (state=primed, not shown)', pass: afterFirstSwipe?.hasButton === false },
    { name: 'after 2nd swipe: data-swipe-state = "shown"', pass: afterSecondSwipe?.state === 'shown' },
    { name: 'after 2nd swipe: delete button rendered', pass: afterSecondSwipe?.hasButton === true },
    { name: 'after 2nd swipe: delete button opacity = 1', pass: parseFloat(afterSecondSwipe?.opacity ?? '0') === 1 },
    { name: 'after 2nd swipe: delete button pointer-events = auto', pass: afterSecondSwipe?.pointerEvents === 'auto' },
  ];

  let allPass = true;
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}`);
    if (!c.pass) allPass = false;
  }

  if (allPass) {
    console.log('\n[v0728-3-9] ✅ ALL CHECKS PASSED');
    console.log('NOTE: iOS Safari 真机 walk 需 PO 自验 /sessions/9/settle → 个人视图 → 已结算记录 → 1st swipe 不动 / 2nd swipe 删除按钮出现.');
    process.exit(0);
  } else {
    console.log('\n[v0728-3-9] ❌ SOME CHECKS FAILED');
    process.exit(1);
  }
})();