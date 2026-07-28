// Playwright iPhone 13 @3x verify script for v0.3.0728-3 #6
// 主币种汇总/原始数据两页的付款明细/消费明细的搜索框, 都应该 sticky
//
// 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
// 反 #101 ✅ Playwright 程序化 + DOM computed style + image tool 视觉三证
// 反 #150 v2 ✅ 真视觉位置 + 真数据
// 反 #151 ✅ PNG 截图存 ~/.openclaw/media/browser/v0728-3-6-settle-search-sticky/

const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.SBC_BASE || 'https://test.jessejia.pp.ua';
const SCREENSHOTS_DIR = path.join(process.env.HOME || '/home/node', '.openclaw/media/browser/v0728-3-6-settle-search-sticky');
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
  console.log('[v0728-3-6] Step 1: login as xinhua1001@outlook.com');
  await context.request.post(`${BASE}/auth/send-code`, {
    data: { email: 'xinhua1001@outlook.com' },
  });
  await context.request.post(`${BASE}/auth/verify-code`, {
    data: { email: 'xinhua1001@outlook.com', code: '000000' },
  });

  // 2. Navigate to /sessions/9/settle (multi-currency, multi-bills — both paid and consumed sections visible)
  console.log('[v0728-3-6] Step 2: navigate to /sessions/9/settle');
  await page.goto(`${BASE}/sessions/9/settle`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // 3. Switch to 个人视图 tab (settle +page.svelte line 188 activeTab default 'overview')
  //    概览 tab 渲染 SettleTransferPath (没有 paid/consumed split sections).
  //    需点 IosSwitch 的 "个人视图" tab 切到 personal view (SettleMemberBreakdown) 才渲染 .bills-section-search.
  console.log('[v0728-3-6] Step 3: switch to 个人视图 tab');
  // IosSwitch 用 button role, text "个人视图". 用 page.getByText 抓 tab label click.
  // 用 .first() 避免匹配到 概览选项里也含"个人" sub-text.
  const personalTab = page.getByText('个人视图', { exact: true }).first();
  if (await personalTab.count() > 0) {
    await personalTab.click({ timeout: 5000 });
    await page.waitForTimeout(800);
    console.log('  clicked 个人视图 tab');
  } else {
    console.log('  个人视图 tab not found (可能默认就是 personal view), 继续');
  }

  // 4. Locate both .bills-section-search boxes (paid + consumed)
  console.log('[v0728-3-6] Step 4: locate both .bills-section-search boxes');
  const searchBoxes = await page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('.bills-section-search'));
    return boxes.map((b) => {
      const cs = window.getComputedStyle(b);
      const rect = b.getBoundingClientRect();
      const input = b.querySelector('.bills-section-search-input');
      return {
        position: cs.position,
        top: cs.top,
        zIndex: cs.zIndex,
        placeholder: input?.placeholder,
        rect: { top: rect.top, height: rect.height },
      };
    });
  });
  console.log(`  search boxes count: ${searchBoxes.length}`);
  for (let i = 0; i < searchBoxes.length; i++) {
    const sb = searchBoxes[i];
    console.log(`  [${i}] position: ${sb.position}, top: ${sb.top}, z-index: ${sb.zIndex}, placeholder: ${sb.placeholder}, rect.top: ${sb.rect.top}, height: ${sb.rect.height}`);
  }

  // 5. Scroll down to verify sticky behavior
  console.log('[v0728-3-6] Step 5: scroll down to verify search stays visible (sticky)');
  const initialRect = await page.evaluate(() => {
    const b = document.querySelector('.bills-section-search');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, viewportH: window.innerHeight };
  });
  console.log(`  before scroll: search top ${initialRect?.top}, viewport ${initialRect?.viewportH}`);

  // Scroll 300px down
  await page.evaluate(() => window.scrollBy(0, 300));
  await page.waitForTimeout(300);

  const afterScrollRect = await page.evaluate(() => {
    const b = document.querySelector('.bills-section-search');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
  console.log(`  after scroll 300px: search top ${afterScrollRect?.top}`);

  // 6. Verify search box is still visible (sticky behavior)
  const isStickyWorking = afterScrollRect && afterScrollRect.top < 100 && afterScrollRect.top >= 0;
  console.log(`  search box sticky working (still near top of viewport after scroll): ${isStickyWorking}`);

  // 7. Verify search box is NOT covered by section header (z-index check)
  console.log('[v0728-3-6] Step 7: verify search below section header (z-index 9 < h4 z-index 10)');
  const zIndexes = await page.evaluate(() => {
    const sectionHeader = document.querySelector('.section-header');
    const search = document.querySelector('.bills-section-search');
    if (!sectionHeader || !search) return null;
    const headerCs = window.getComputedStyle(sectionHeader);
    const searchCs = window.getComputedStyle(search);
    return {
      headerZ: headerCs.zIndex,
      searchZ: searchCs.zIndex,
    };
  });
  console.log(`  section-header z-index: ${zIndexes?.headerZ}, search z-index: ${zIndexes?.searchZ}`);

  // 8. Verify search functionality still works (type + filter)
  console.log('[v0728-3-6] Step 8: verify search functionality (type + filter)');
  await page.fill('.bills-section-search-input', '晚餐');
  await page.waitForTimeout(500);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '01-settle-search-sticky-typed.png'),
    fullPage: false,
  });

  // Clear search
  await page.click('.bills-section-search-clear').catch(() => {});
  await page.waitForTimeout(300);

  // 9. Screenshot initial state + scrolled state
  console.log('[v0728-3-6] Step 9: screenshot initial + scrolled states');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '02-settle-search-initial.png'),
    fullPage: false,
  });

  await page.evaluate(() => window.scrollBy(0, 500));
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '03-settle-search-scrolled.png'),
    fullPage: false,
  });

  await browser.close();

  console.log('\n[v0728-3-6] === SUMMARY ===');
  const checks = [
    { name: 'settle page loads (paid + consumed sections render)', pass: searchBoxes.length === 2 },
    { name: 'both search boxes have position: sticky', pass: searchBoxes.every((sb) => sb.position === 'sticky') },
    { name: 'both search boxes have top offset (32px)', pass: searchBoxes.every((sb) => sb.top === '32px') },
    { name: 'both search boxes have z-index 9 (below h4 z-index 10)', pass: searchBoxes.every((sb) => sb.zIndex === '9') },
    { name: 'section-header z-index 10 (above search)', pass: zIndexes?.headerZ === '10' },
    { name: 'search stays visible after scroll 300px (sticky)', pass: isStickyWorking === true },
    { name: 'search placeholder = "搜索账单名称"', pass: searchBoxes.every((sb) => sb.placeholder === '搜索账单名称') },
  ];

  let allPass = true;
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}`);
    if (!c.pass) allPass = false;
  }

  if (allPass) {
    console.log('\n[v0728-3-6] ✅ ALL CHECKS PASSED');
    console.log('NOTE: iOS Safari 真机 walk 需 PO 自验 /sessions/9/settle → 滚动 bill list → 搜索框应常驻顶部可见.');
    process.exit(0);
  } else {
    console.log('\n[v0728-3-6] ❌ SOME CHECKS FAILED');
    process.exit(1);
  }
})();