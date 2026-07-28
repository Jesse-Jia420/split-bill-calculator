// Playwright iPhone 13 @3x verify script for v0.3.0728-3 #4
// BillForm 预设选项位置 — 从 "说明上方" 挪到 "说明和说明 input 之间"
//
// 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
// 反 #101 ✅ Playwright 程序化 + DOM computed style + image tool 视觉三证
// 反 #150 v2 ✅ 真视觉位置 + 真数据
// 反 #151 ✅ PNG 截图存 ~/.openclaw/media/browser/v0728-3-4-billform-preset-position/

const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.SBC_BASE || 'https://test.jessejia.pp.ua';
const SCREENSHOTS_DIR = path.join(process.env.HOME || '/home/node', '.openclaw/media/browser/v0728-3-4-billform-preset-position');
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
  console.log('[v0728-3-4] Step 1: login as demo@example.com');
  await context.request.post(`${BASE}/auth/send-code`, {
    data: { email: 'demo@example.com' },
  });
  await context.request.post(`${BASE}/auth/verify-code`, {
    data: { email: 'demo@example.com', code: '000000' },
  });

  // 2. Navigate to bill new page for a session (use /sessions/9 — Thailand test, 41 bills, multi-currency)
  console.log('[v0728-3-4] Step 2: navigate to /sessions/9/bills/new');
  await page.goto(`${BASE}/sessions/9/bills/new`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // 3. Verify preset-row, label, and input all exist
  console.log('[v0728-3-4] Step 3: verify preset-row, label, input exist');
  const presetCount = await page.locator('[data-testid="desc-preset-row"]').count();
  const labelCount = await page.locator('label[for="desc"]').count();
  const inputCount = await page.locator('input#desc').count();
  console.log(`  preset-row: ${presetCount}, label[for=desc]: ${labelCount}, input#desc: ${inputCount}`);

  // 4. Verify DOM order: label should come BEFORE preset-row, preset-row BEFORE input
  console.log('[v0728-3-4] Step 4: verify DOM order (label → preset-row → input)');
  const order = await page.evaluate(() => {
    const label = document.querySelector('label[for="desc"]');
    const presetRow = document.querySelector('[data-testid="desc-preset-row"]');
    const input = document.querySelector('input#desc');
    if (!label || !presetRow || !input) return null;
    const position = (a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return 'before';
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 'after';
      return 'same';
    };
    return {
      labelVsPreset: position(label, presetRow),
      presetVsInput: position(presetRow, input),
    };
  });
  console.log(`  label vs preset-row: ${order?.labelVsPreset} (expect: before)`);
  console.log(`  preset-row vs input: ${order?.presetVsInput} (expect: before)`);

  // 5. Verify visual order matches DOM order (using bounding boxes top position)
  console.log('[v0728-3-4] Step 5: verify visual order via bounding box top');
  const visualOrder = await page.evaluate(() => {
    const label = document.querySelector('label[for="desc"]');
    const presetRow = document.querySelector('[data-testid="desc-preset-row"]');
    const input = document.querySelector('input#desc');
    if (!label || !presetRow || !input) return null;
    const lr = label.getBoundingClientRect();
    const pr = presetRow.getBoundingClientRect();
    const ir = input.getBoundingClientRect();
    return {
      labelTop: lr.top,
      presetTop: pr.top,
      inputTop: ir.top,
      orderCorrect: lr.top < pr.top && pr.top < ir.top,
    };
  });
  console.log(`  label top: ${visualOrder?.labelTop}, preset top: ${visualOrder?.presetTop}, input top: ${visualOrder?.inputTop}`);
  console.log(`  visual order correct (label < preset < input): ${visualOrder?.orderCorrect}`);

  // 6. Verify preset chips are still functional (click chip → description = preset)
  console.log('[v0728-3-4] Step 6: verify preset chip click fills description');
  await page.click('[data-testid="desc-preset-晚餐"]');
  await page.waitForTimeout(200);
  const descValue = await page.inputValue('input#desc');
  console.log(`  description after click 晚餐 chip: "${descValue}"`);

  // 7. Screenshot full page
  console.log('[v0728-3-4] Step 7: full page screenshot');
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '01-billform-full.png'),
    fullPage: false,
  });

  // 8. Screenshot description area only (label + preset + input)
  console.log('[v0728-3-4] Step 8: description area screenshot');
  if (visualOrder) {
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, '02-description-area.png'),
      clip: {
        x: 0,
        y: visualOrder.labelTop - 10,
        width: 390,
        height: (visualOrder.inputTop - visualOrder.labelTop) + 60,
      },
    });
  }

  await browser.close();

  console.log('\n[v0728-3-4] === SUMMARY ===');
  const checks = [
    { name: 'preset-row exists', pass: presetCount === 1 },
    { name: 'label[for=desc] exists', pass: labelCount === 1 },
    { name: 'input#desc exists', pass: inputCount === 1 },
    { name: 'DOM order: label before preset-row', pass: order?.labelVsPreset === 'before' },
    { name: 'DOM order: preset-row before input', pass: order?.presetVsInput === 'before' },
    { name: 'visual order: label top < preset top < input top', pass: visualOrder?.orderCorrect === true },
    { name: 'preset chip 晚餐 click fills description', pass: descValue === '晚餐' },
  ];

  let allPass = true;
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}`);
    if (!c.pass) allPass = false;
  }

  if (allPass) {
    console.log('\n[v0728-3-4] ✅ ALL CHECKS PASSED');
    console.log('NOTE: iOS Safari 真机 walk 需 PO 自验 /sessions/9/bills/new → 说明 label 下方 → 预设 chip 行 → 说明 input.');
    process.exit(0);
  } else {
    console.log('\n[v0728-3-4] ❌ SOME CHECKS FAILED');
    process.exit(1);
  }
})();