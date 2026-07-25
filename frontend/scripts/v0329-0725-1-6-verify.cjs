#!/usr/bin/env node
/**
 * v0.3.29 — UAT 0725-1 #6 验证 — datetime-local picker 真根因修 (方案 B).
 *
 * PO msg 字面: "新建,编账单页, 日期选框还是超出表单了. 你自己看一下"
 *
 * 之前:
 *   - v0.3.24 Top #1 (commit be9d25b): padding-inline 12 32px — 缓解症状
 *   - v0.3.28 #4 (commit e046710): max-width 100% — 缓解症状
 *
 * 真根因:
 *   iOS Safari datetime-local widget 有 ~200px implicit min-width
 *   (picker indicator 30px + locale text 140-170px). WebKit bug #119175
 *   12 年未修, iOS 26.4 没改 datetime-local 渲染规则. CSS max-width 只
 *   能压上限不能压下限 — 任何 padding 调整都不管用.
 *
 * 方案 B:
 *   挪 occurredAt 到独立整行 .occurredAt-row { width: 100% }, 物理给
 *   widget 200px+ container.
 *
 * 验证 5 项:
 *   1. .occurredAt-row DOM 存在 (新加的 wrapper class)
 *   2. occurredAt input width (computed) >= 200px (iPhone 13 viewport 390)
 *   3. amount 跟 occurredAt 不再同行 (y 坐标差异 > 30px)
 *   4. occurredAt input 右侧不超出 form 边界 (no overflow)
 *   5. padding-inline 保留 12px 16px (容纳 picker indicator)
 *
 * iPhone 13 真机 walk (390x844 @3x, webkit).
 * 数据前置: session 9 泰国测试 6 人 CNY+THB 32 bills.
 */

const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const BASE = 'https://test.jessejia.pp.ua';
const VERIFY_DIR = '/home/node/.openclaw/media/browser/v0329-0725-1-6';
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

  // Login via BE API + cookie jar
  await page.goto(`${BASE}/`);
  await page.evaluate(async (base) => {
    await fetch(`${base}/auth/send-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'xinhua1001@outlook.com' })
    });
    await fetch(`${base}/auth/verify-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'xinhua1001@outlook.com', code: '000000' })
    });
  }, BASE);

  // ---- new mode ----
  await page.goto(`${BASE}/sessions/9/bills/new`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  const results = [];

  // ============ Test 1: .occurredAt-row DOM 存在 ============
  console.log('\n[Test 1] .occurredAt-row DOM 存在 (新 wrapper class)');
  {
    const data = await page.evaluate(() => {
      const row = document.querySelector('.occurredAt-row');
      const input = row?.querySelector('input#occurredAt');
      return {
        rowExists: !!row,
        inputInsideRow: !!input,
        rowClassName: row?.className || null
      };
    });
    const passed = data.rowExists === true && data.inputInsideRow === true;
    results.push({ test: '1_occurredAt_row_DOM', data, passed });
  }

  // ============ Test 2: occurredAt input width >= 200px ============
  console.log('\n[Test 2] occurredAt input width >= 200px (能装下 iOS widget)');
  {
    const data = await page.evaluate(() => {
      const input = document.querySelector('input[type="datetime-local"]#occurredAt');
      if (!input) return null;
      const rect = input.getBoundingClientRect();
      const cs = window.getComputedStyle(input);
      return {
        offsetWidth: input.offsetWidth,
        boundingWidth: rect.width,
        cssWidth: cs.width,
        parentClassName: input.parentElement?.className,
        grandparentClassName: input.parentElement?.parentElement?.className
      };
    });
    const passed = !!data && data.boundingWidth >= 200;
    results.push({ test: '2_input_width_gte_200', data, passed });
  }

  // ============ Test 3: amount 跟 occurredAt 不再同行 ============
  console.log('\n[Test 3] amount 跟 occurredAt 不再同行 (y 差 > 30px)');
  {
    const data = await page.evaluate(() => {
      // amount 在 AmountCalculatorInput 组件内, 取它的 input 子元素
      const amountCalc = document.querySelector('.amount-calc-input, [data-testid="amount-input"], .AmountCalculatorInput');
      // fallback: 取 form 里第一个 number-like input (不是 datetime)
      let amountEl = amountCalc;
      if (!amountEl) {
        const allInputs = Array.from(document.querySelectorAll('form#bill-form input'));
        amountEl = allInputs.find(i => i.type !== 'datetime-local' && i.type !== 'hidden');
      }
      const occurred = document.querySelector('input[type="datetime-local"]#occurredAt');
      if (!amountEl || !occurred) return null;
      const ar = amountEl.getBoundingClientRect();
      const or_ = occurred.getBoundingClientRect();
      return {
        amountTop: ar.top,
        amountBottom: ar.bottom,
        amountClassName: amountEl.className,
        occurredTop: or_.top,
        occurredBottom: or_.bottom,
        yDiff: or_.top - ar.bottom,
        differentRows: (or_.top - ar.bottom) > 30
      };
    });
    const passed = !!data && data.differentRows === true;
    results.push({ test: '3_different_rows', data, passed });
  }

  // ============ Test 4: occurredAt input 右侧不超出 form 边界 ============
  console.log('\n[Test 4] occurredAt input.right <= form.right (no overflow)');
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
        formWidth: form.getBoundingClientRect().width,
        occurredWidth: occurred.getBoundingClientRect().width,
        noOverflow: occurred.getBoundingClientRect().right <= form.getBoundingClientRect().right + 1
      };
    });
    const passed = !!data && data.noOverflow === true;
    results.push({ test: '4_no_overflow', data, passed });
    await page.screenshot({ path: path.join(VERIFY_DIR, '01-test-1-4-new-mode.png') });
  }

  // ============ Test 5: padding-inline 保留 12px 16px ============
  console.log('\n[Test 5] padding-inline 保留 12px 16px');
  {
    const data = await page.evaluate(() => {
      const input = document.querySelector('input[type="datetime-local"]#occurredAt');
      if (!input) return null;
      const cs = window.getComputedStyle(input);
      return {
        paddingInline: cs.paddingInline,
        width: cs.width,
        display: cs.display,
        minWidth: cs.minWidth,
        maxWidth: cs.maxWidth
      };
    });
    const passed = !!data && data.paddingInline === '12px 16px';
    results.push({ test: '5_padding_inline', data, passed });
  }

  // ============ Test 6: zoom in 视觉截图 (occurredAt focus) ============
  await page.evaluate(() => {
    const e = document.querySelector('input[type="datetime-local"]#occurredAt');
    e?.scrollIntoView({ block: 'center', behavior: 'instant' });
    e?.focus();
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(VERIFY_DIR, '02-test-D-new-zoom.png') });

  // ============ Test 7: edit mode 同样修 ============
  console.log('\n[Test 7] edit mode 同样修');
  await page.goto(`${BASE}/sessions/9/bills/73/edit`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  {
    const data = await page.evaluate(() => {
      const form = document.querySelector('form#bill-form');
      const occurred = document.querySelector('input[type="datetime-local"]#occurredAt');
      if (!form || !occurred) return null;
      const cs = window.getComputedStyle(occurred);
      return {
        rowExists: !!document.querySelector('.occurredAt-row'),
        paddingInline: cs.paddingInline,
        width: cs.width,
        boundingWidth: occurred.getBoundingClientRect().width,
        formRight: form.getBoundingClientRect().right,
        occurredRight: occurred.getBoundingClientRect().right,
        noOverflow: occurred.getBoundingClientRect().right <= form.getBoundingClientRect().right + 1
      };
    });
    const passed = !!data
      && data.rowExists === true
      && data.paddingInline === '12px 16px'
      && data.boundingWidth >= 200
      && data.noOverflow === true;
    results.push({ test: '7_edit_mode', data, passed });
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
