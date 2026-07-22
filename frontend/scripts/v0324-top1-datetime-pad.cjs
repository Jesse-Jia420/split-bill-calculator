// v0.3.24 Top #1 UAT bug 验证 — 日期选框 iOS picker indicator 不溢出
// PO msg 16:35 UAT line #1 字面:
//   "新建,编账单页, 日期选框还是超出表单了. 你自己看一下"
//
// 修法: BillForm.svelte input[type=datetime-local]#occurredAt 加
//   padding-inline: 12px 32px
//   给 iOS Safari 原生 picker indicator (~30px) 留空间, 避免视觉截断/溢出.
//
// 注意: Playwright headless Chromium 不渲染 iOS picker indicator (仅 iOS Safari 显示),
//   所以 Playwright bbox 不会变; 视觉验证靠 image tool 描述 + 真机 (PO 自行确认).
//   Playwright 验证维度:
//   - padding-inline 实际值 = "12px 32px" (computed style)
//   - input 视觉 width 因为 padding-right 增大而变小 (维持 max-width 限制)
//   - form 不溢出 (occurred.right <= form.right)
//
// iPhone 13 真机 walk (390x844 @3x, webkit).
// 数据前置: session 1 泰国测试 6 人 CNY+THB 32 bills.

const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const BASE = 'https://test.jessejia.pp.ua';
const VERIFY_DIR = '/home/node/.openclaw/media/browser/v0324-top1-datetime-pad';
fs.mkdirSync(VERIFY_DIR, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/`);
  await page.evaluate(async (base) => {
    await fetch(`${base}/auth/send-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@example.com' })
    });
    await fetch(`${base}/auth/verify-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@example.com', code: '000000' })
    });
  }, BASE);

  // ---- new mode ----
  await page.goto(`${BASE}/sessions/1/bills/new`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  const results = [];

  // ============ Test A: padding-inline 实际值 ============
  console.log('\n[Test A] padding-inline computed value');
  {
    const cs = await page.evaluate(() => {
      const inp = document.querySelector('input[type="datetime-local"]#occurredAt');
      return inp ? window.getComputedStyle(inp).paddingInline : null;
    });
    const passed = cs === '12px 32px';
    results.push({ test: 'A_padding_inline_12_32', value: cs, passed });
  }

  // ============ Test B: form 不溢出 ============
  console.log('\n[Test B] occurred.right <= form.right (no overflow)');
  {
    const data = await page.evaluate(() => {
      const form = document.querySelector('form#bill-form');
      const occurred = document.querySelector('input[type="datetime-local"]#occurredAt');
      if (!form || !occurred) return null;
      return {
        formRight: form.getBoundingClientRect().right,
        occurredRight: occurred.getBoundingClientRect().right,
        formLeft: form.getBoundingClientRect().left,
        occurredLeft: occurred.getBoundingClientRect().left,
        noOverflow: occurred.getBoundingClientRect().right <= form.getBoundingClientRect().right
      };
    });
    const passed = !!data && data.noOverflow === true;
    results.push({ test: 'B_no_overflow', data, passed });
    await page.screenshot({ path: path.join(VERIFY_DIR, '01-test-AB-new-mode.png') });
  }

  // ============ Test C: 金额 + 时间 两个 input 仍水平对齐 (flex 1 + min-width 0) ============
  console.log('\n[Test C] 金额 + 时间 y 位置一致 (row 内 flex 1 each)');
  {
    const data = await page.evaluate(() => {
      const amount = document.querySelector('div:has(> input[placeholder="0.00"]), .amount-calc-input, input.amount-input');
      const occurred = document.querySelector('input[type="datetime-local"]#occurredAt');
      if (!amount || !occurred) return null;
      const ar = amount.getBoundingClientRect();
      const or_ = occurred.getBoundingClientRect();
      return {
        amountTop: ar.top,
        amountBottom: ar.bottom,
        occurredTop: or_.top,
        occurredBottom: or_.bottom,
        sameRow: Math.abs(ar.top - or_.top) < 5
      };
    });
    const passed = !!data && data.sameRow === true;
    results.push({ test: 'C_same_row', data, passed });
  }

  // ============ Test D: zoom in for visual check ============
  await page.evaluate(() => {
    const e = document.querySelector('input[type="datetime-local"]#occurredAt');
    e?.scrollIntoView({ block: 'center', behavior: 'instant' });
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(VERIFY_DIR, '02-test-D-new-zoom.png') });

  // ============ Test E: edit mode 同样修 ============
  console.log('\n[Test E] edit mode 同样修');
  await page.goto(`${BASE}/sessions/1/bills/1/edit`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  {
    const data = await page.evaluate(() => {
      const form = document.querySelector('form#bill-form');
      const occurred = document.querySelector('input[type="datetime-local"]#occurredAt');
      if (!form || !occurred) return null;
      const cs = window.getComputedStyle(occurred);
      return {
        paddingInline: cs.paddingInline,
        formRight: form.getBoundingClientRect().right,
        occurredRight: occurred.getBoundingClientRect().right,
        noOverflow: occurred.getBoundingClientRect().right <= form.getBoundingClientRect().right
      };
    });
    const passed = !!data
      && data.paddingInline === '12px 32px'
      && data.noOverflow === true;
    results.push({ test: 'E_edit_mode', data, passed });
    await page.screenshot({ path: path.join(VERIFY_DIR, '03-test-E-edit-mode.png') });
  }

  // ---- Summary ----
  console.log('\n========== SUMMARY ==========');
  let passCount = 0;
  for (const r of results) {
    const status = r.passed ? '✓ PASS' : '✗ FAIL';
    console.log(`  ${status}  ${r.test}`);
    if (r.passed) passCount++;
  }
  console.log(`  TOTAL: ${passCount}/${results.length} passed`);

  await browser.close();
  process.exit(passCount === results.length ? 0 : 1);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});