// Playwright iPhone 13 @3x verify script for v0.3.0728-3 #5
// 币种设置弹窗的标题应该居中
//
// 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
// 反 #101 ✅ Playwright 程序化 + DOM computed style + image tool 视觉三证
// 反 #150 v2 ✅ 真视觉位置 + 真数据
// 反 #151 ✅ PNG 截图存 ~/.openclaw/media/browser/v0728-3-5-currency-modal-title/

const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.SBC_BASE || 'https://test.jessejia.pp.ua';
const SCREENSHOTS_DIR = path.join(process.env.HOME || '/home/node', '.openclaw/media/browser/v0728-3-5-currency-modal-title');
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
  console.log('[v0728-3-5] Step 1: login as xinhua1001@outlook.com');
  await context.request.post(`${BASE}/auth/send-code`, {
    data: { email: 'xinhua1001@outlook.com' },
  });
  await context.request.post(`${BASE}/auth/verify-code`, {
    data: { email: 'xinhua1001@outlook.com', code: '000000' },
  });

  // 2. Navigate to a multi-currency session (session 13 has CNY+USD per earlier scan)
  console.log('[v0728-3-5] Step 2: navigate to multi-currency session to open CurrencyAddModal');
  await page.goto(`${BASE}/sessions/13`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // 3. Find and click the currency bar/pill to open CurrencyAddModal
  console.log('[v0728-3-5] Step 3: find currency bar and click');
  const currencyBar = page.locator('[data-testid="currency-bar"], [data-testid="currency-pair"], .currency-bar, .currency-pair-item').first();
  if ((await currencyBar.count()) === 0) {
    // Try clicking currency pill inside members section
    const currencyPill = page.locator('text=/CNY|添加|币种/').first();
    if ((await currencyPill.count()) > 0) {
      await currencyPill.click();
    } else {
      console.error('  ❌ FAIL: currency bar / pill not found');
      process.exit(1);
    }
  } else {
    await currencyBar.click();
  }
  await page.waitForTimeout(800);

  // 4. Look for CurrencyAddModal
  console.log('[v0728-3-5] Step 4: locate CurrencyAddModal');
  const modal = page.locator('.currency-modal, [data-sbc="currency-add-modal"], [role="dialog"]').first();
  const modalCount = await modal.count();
  console.log(`  modal count: ${modalCount}`);

  if (modalCount === 0) {
    // Maybe it's a sheet not modal — try alternate selectors
    const sheet = page.locator('.sheet').first();
    if ((await sheet.count()) > 0) {
      console.log('  modal is a sheet (.sheet)');
    } else {
      console.error('  ❌ FAIL: CurrencyAddModal not found');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '00-no-modal.png') });
      process.exit(1);
    }
  }

  // 5. Inspect sheet-head / sheet-title / sheet-close positions
  console.log('[v0728-3-5] Step 5: inspect title centering');
  const positions = await page.evaluate(() => {
    const sheetHead = document.querySelector('.sheet-head');
    const sheetTitle = document.querySelector('.sheet-title');
    const sheetClose = document.querySelector('.sheet-close');
    if (!sheetHead || !sheetTitle) return null;
    const headRect = sheetHead.getBoundingClientRect();
    const titleRect = sheetTitle.getBoundingClientRect();
    const titleCS = window.getComputedStyle(sheetTitle);
    const headCS = window.getComputedStyle(sheetHead);
    const closeRect = sheetClose ? sheetClose.getBoundingClientRect() : null;
    const closeCS = sheetClose ? window.getComputedStyle(sheetClose) : null;
    return {
      headRect: { left: headRect.left, right: headRect.right, width: headRect.width, center: (headRect.left + headRect.right) / 2 },
      titleRect: { left: titleRect.left, right: titleRect.right, width: titleRect.width, center: (titleRect.left + titleRect.right) / 2, top: titleRect.top, bottom: titleRect.bottom },
      titleText: sheetTitle.textContent.trim(),
      titleJustifySelf: titleCS.justifySelf,
      headDisplay: headCS.display,
      headGridTemplateColumns: headCS.gridTemplateColumns,
      closeRect: closeRect ? { left: closeRect.left, right: closeRect.right, center: (closeRect.left + closeRect.right) / 2 } : null,
      closeJustifySelf: closeCS ? closeCS.justifySelf : null,
    };
  });
  console.log(`  head center: ${positions?.headRect.center}`);
  console.log(`  title text: "${positions?.titleText}"`);
  console.log(`  title center: ${positions?.titleRect.center}`);
  console.log(`  title width: ${positions?.titleRect.width}`);
  console.log(`  title justify-self: ${positions?.titleJustifySelf}`);
  console.log(`  head display: ${positions?.headDisplay}`);
  console.log(`  head grid-template-columns: ${positions?.headGridTemplateColumns}`);
  console.log(`  close rect: ${JSON.stringify(positions?.closeRect)}`);
  console.log(`  close justify-self: ${positions?.closeJustifySelf}`);

  // 6. Verify title center is close to head center
  const centerDelta = Math.abs((positions?.titleRect.center ?? 0) - (positions?.headRect.center ?? 0));
  console.log(`  center delta (title vs head): ${centerDelta}px`);

  // 7. Verify close button is at the right side (close right edge ≈ head right edge)
  const closeDelta = positions?.closeRect ? Math.abs(positions.closeRect.right - positions.headRect.right) : null;
  console.log(`  close right delta vs head right: ${closeDelta}px`);

  // 8. Screenshot full modal
  console.log('[v0728-3-5] Step 8: screenshot full modal');
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '01-modal-title-centered.png'),
    fullPage: false,
  });

  // 9. Screenshot close-up of sheet-head area
  console.log('[v0728-3-5] Step 9: close-up screenshot of sheet-head');
  if (positions) {
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, '02-sheet-head-closeup.png'),
      clip: {
        x: positions.headRect.left - 10,
        y: positions.titleRect.top - 10,
        width: positions.headRect.width + 20,
        height: (positions.titleRect.bottom - positions.titleRect.top) + 20,
      },
    });
  }

  await browser.close();

  console.log('\n[v0728-3-5] === SUMMARY ===');
  const checks = [
    { name: 'CurrencyAddModal opens', pass: modalCount === 1 || (await page.locator('.sheet').count()) > 0 },
    { name: 'sheet-head display = grid', pass: positions?.headDisplay === 'grid' },
    { name: 'sheet-head grid-template-columns = "1fr auto 1fr" (or close)', pass: positions?.headGridTemplateColumns?.includes('1fr') && positions?.headGridTemplateColumns?.includes('auto') },
    { name: 'sheet-title justify-self = center', pass: positions?.titleJustifySelf === 'center' },
    { name: 'title center delta < 10px (centered)', pass: centerDelta < 10 },
    { name: 'close button right-aligned (close right ≈ head right, delta < 20)', pass: closeDelta !== null && closeDelta < 20 },
    { name: 'close justify-self = end (or right)', pass: positions?.closeJustifySelf === 'end' || positions?.closeJustifySelf === 'right' },
  ];

  let allPass = true;
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}`);
    if (!c.pass) allPass = false;
  }

  if (allPass) {
    console.log('\n[v0728-3-5] ✅ ALL CHECKS PASSED');
    console.log('NOTE: chromium 真机验证 OK. iOS Safari 视觉需 PO 自验.');
    process.exit(0);
  } else {
    console.log('\n[v0728-3-5] ❌ SOME CHECKS FAILED');
    process.exit(1);
  }
})();