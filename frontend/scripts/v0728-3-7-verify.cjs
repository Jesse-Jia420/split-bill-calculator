// Playwright iPhone 13 @3x verify script for v0.3.0728-3 #7
// 人物选框 CNY → ¥ (reverse v0.3.0728-2 #13: 3 文件 currencySymbol 重新 import + 显 ¥)
//
// 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
// 反 #101 ✅ Playwright 程序化 + DOM computed style + image tool 视觉三证
// 反 #150 v2 ✅ 真视觉位置 + 真数据 (session 9 泰国测试 6 members)
// 反 #151 ✅ PNG 截图存 ~/.openclaw/media/browser/v0728-3-7-currency-symbol/

const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.SBC_BASE || 'https://test.jessejia.pp.ua';
const SCREENSHOTS_DIR = path.join(process.env.HOME || '/home/node', '.openclaw/media/browser/v0728-3-7-currency-symbol');
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
  console.log('[v0728-3-7] Step 1: login as demo@example.com');
  await context.request.post(`${BASE}/auth/send-code`, {
    data: { email: 'demo@example.com' },
  });
  await context.request.post(`${BASE}/auth/verify-code`, {
    data: { email: 'demo@example.com', code: '000000' },
  });

  // 2. /sessions/9/settle - settle 个人视图 member chip net display
  console.log('[v0728-3-7] Step 2: navigate to /sessions/9/settle (个人视图)');
  await page.goto(`${BASE}/sessions/9/settle`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2500);
  // Switch to 个人视图
  try {
    await page.getByText('个人视图', { exact: true }).first().click({ timeout: 5000 });
  } catch {}
  await page.waitForTimeout(800);

  // 3. Find chip-net / chip-net-line text — should show ¥ not CNY
  const chipNets = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.chip-net, .chip-net-line')).slice(0, 5).map((el) => el.textContent.trim());
  });
  console.log(`  chip-net / chip-net-line (settle 个人视图): ${JSON.stringify(chipNets)}`);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-settle-person-view.png'), fullPage: false });

  // 4. /sessions/9 - bill list 个人消费 line
  console.log('[v0728-3-7] Step 3: navigate to /sessions/9 (bill list)');
  await page.goto(`${BASE}/sessions/9`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  const exclusiveRows = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.bill-row-exclusive')).slice(0, 3).map((el) => el.textContent.trim());
  });
  console.log(`  bill-row-exclusive (sessions/9): ${JSON.stringify(exclusiveRows)}`);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-bill-list.png'), fullPage: false });

  // 5. /sessions/9/bills/new - pill-currency button text + font-size
  console.log('[v0728-3-7] Step 4: navigate to /sessions/9/bills/new (pill-currency)');
  await page.goto(`${BASE}/sessions/9/bills/new`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  const pillCurrencies = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.pill-currency')).slice(0, 5).map((el) => ({
      text: el.textContent.trim(),
      fontSize: window.getComputedStyle(el).fontSize,
      padding: window.getComputedStyle(el).padding,
    }));
  });
  console.log(`  pill-currency (bills/new): ${JSON.stringify(pillCurrencies)}`);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-bills-new-pill.png'), fullPage: false });

  await browser.close();

  console.log('\n[v0728-3-7] === SUMMARY ===');
  const checks = [
    { name: 'settle chip-net shows ¥ (not CNY/THB)', pass: chipNets.some((t) => t.includes('¥')) },
    { name: 'settle chip-net no longer shows CNY/THB code', pass: !chipNets.some((t) => /\bCNY\b|\bTHB\b/.test(t)) },
    { name: 'bill-row-exclusive shows ¥ (not CNY/THB)', pass: exclusiveRows.some((t) => t.includes('¥')) },
    { name: 'bill-row-exclusive no longer shows CNY/THB code', pass: !exclusiveRows.some((t) => /\bCNY\b|\bTHB\b/.test(t)) },
    { name: 'pill-currency shows ¥ + font-size 13px (v7 reverse)', pass: pillCurrencies.some((p) => p.text === '¥' && p.fontSize === '13px') },
    { name: 'pill-currency no longer shows CNY/THB code', pass: !pillCurrencies.some((p) => p.text === 'CNY' || p.text === 'THB') },
  ];

  let allPass = true;
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}`);
    if (!c.pass) allPass = false;
  }

  if (allPass) {
    console.log('\n[v0728-3-7] ✅ ALL CHECKS PASSED');
    console.log('NOTE: iOS Safari 真机 walk 需 PO 自验 /sessions/9/settle (chip-net) + /sessions/9 (bill-row-exclusive) + /sessions/9/bills/new (pill-currency) 都应显 ¥ 字符.');
    process.exit(0);
  } else {
    console.log('\n[v0728-3-7] ❌ SOME CHECKS FAILED');
    process.exit(1);
  }
})();