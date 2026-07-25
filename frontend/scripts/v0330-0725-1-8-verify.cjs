#!/usr/bin/env node
/**
 * v0.3.30 #8 — UAT 0725-1 #8 验证 — 计算器功能优化.
 *
 * PO msg 字面: "新建编辑账单页, 计算器的功能要优化. 其中 等于 号, 应该是计算结果
 * 并加括号的功能. 如当用户输出 60, -, 10, =, /, 5 时, 代表 (60-10)/5.
 *  - 计算器内的结果框最右侧新增 对号 按钮, 点击可让计算器组件消失, 金额填入表单的金额字段.
 *  - 表单的金额字段不随计算器内金额的变化而变化, 仅填入并展示计算后的结果.
 *  - 表单内去除金额 input 右侧的 '= xxx货币符号', 仅保留 input.
 *  - 表达式错误时, 在计算器的结果框内, 使用红色玻璃 pill 展示 '表达式错误'.
 *  - 计算器内的结果部分, 等号之后只展示金额数字, 不展示币种."
 *
 * 验证 4 状态 (mockup-0725-1-8-1/2/3/4):
 *   State 1 (input): 输入 "60 - 10" → 验无对号按钮
 *   State 2 (result): 依次按 60, -, 10, =, /, 5 → 验结果框 "(60-10)/5" + value=10 + 对号按钮 visible
 *   State 3 (error): 输入 "60 /" → 验结果框红色错误 pill "表达式错误" + confirm 灰
 *   State 4 (confirm): 点对号 → 验计算器消失 + amount input value="10" + 无后缀
 *
 * iPhone 13 真机 walk (390x844 @3x, webkit, locale zh-CN).
 * 数据前置: session 9 泰国测试 6 人 CNY+THB 32 bills.
 */

const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const BASE = 'http://172.18.0.5:8480';
const VERIFY_DIR = '/home/node/.openclaw/media/browser/v0330-0725-1-8';
fs.mkdirSync(VERIFY_DIR, { recursive: true });

function log(test, status, details) {
  const icon = status === 'pass' ? '✓' : '✗';
  console.log(`  ${icon} [${test}] ${details}`);
  return { test, status, details };
}

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

  // Login via BE API + cookie jar (避免 UI login click handler 触发问题)
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

  console.log('===== UAT 0725-1 #8 — 计算器功能优化 4 状态验证 =====\n');

  // ====== 1. Navigate to /sessions/9/bills/new (新建账单) ======
  console.log('Step 1: navigate to /sessions/9/bills/new');
  await page.goto(`${BASE}/sessions/9/bills/new`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  // Open calculator by clicking form-row
  console.log('Step 2: open calculator (click form-row)');
  await page.click('[data-testid="amount-calc-row"]');
  await page.waitForTimeout(800);

  // ====== State 1: input "60 - 10" → no confirm button ======
  console.log('\n=== State 1: input "60 - 10" (无等号) ===');
  const results = [];

  // Press 60 - 10
  for (const ch of ['6', '0', '-', '1', '0']) {
    await page.click(`button[aria-label="${ch === '-' ? '减' : ch === '/' ? '除' : ch === '*' ? '乘' : ch === '+' ? '加' : ch === '.' ? '小数点' : ch}"]`);
    await page.waitForTimeout(80);
  }

  // Capture state 1
  await page.screenshot({ path: path.join(VERIFY_DIR, '01-state-input.png'), fullPage: false });

  const s1 = await page.evaluate(() => {
    const expr = document.querySelector('[data-testid="amount-calc-sheet-expr"]')?.textContent?.trim() ?? '';
    const preview = document.querySelector('[data-testid="amount-calc-sheet-preview"]')?.textContent?.trim() ?? '';
    const errorPill = document.querySelector('[data-testid="amount-calc-error-pill"]');
    const confirmBtn = document.querySelector('[data-testid="amount-calc-confirm"]');
    return {
      expr,
      preview,
      errorVisible: !!errorPill,
      confirmVisible: confirmBtn ? !confirmBtn.classList.contains('hidden') : false,
      confirmDisabled: confirmBtn ? confirmBtn.hasAttribute('disabled') : true,
    };
  });
  console.log(`  expr="${s1.expr}" preview="${s1.preview}" errorVisible=${s1.errorVisible} confirmVisible=${s1.confirmVisible}`);

  results.push(log('S1.expr', s1.expr === '60-10' ? 'pass' : 'fail', `expr should be "60-10", got "${s1.expr}"`));
  results.push(log('S1.preview', s1.preview.includes('= 50.00') ? 'pass' : 'fail', `preview should be "= 50.00", got "${s1.preview}"`));
  results.push(log('S1.no-confirm', !s1.confirmVisible ? 'pass' : 'fail', `confirm should be hidden, got visible=${s1.confirmVisible}`));
  results.push(log('S1.no-error', !s1.errorVisible ? 'pass' : 'fail', `no error pill expected, got visible=${s1.errorVisible}`));

  // Clear for next state
  await page.click('button[aria-label="清空"]');
  await page.waitForTimeout(300);

  // ====== State 2: input 60 - 10 = / 5 → "(60-10)/5" + value=10 + confirm ======
  console.log('\n=== State 2: 60 - 10 = / 5 (等号 + 续) ===');
  for (const ch of ['6', '0', '-', '1', '0']) {
    await page.click(`button[aria-label="${ch === '-' ? '减' : ch === '/' ? '除' : ch === '*' ? '乘' : ch === '+' ? '加' : ch === '.' ? '小数点' : ch}"]`);
    await page.waitForTimeout(80);
  }
  // Press =
  await page.click('[data-testid="amount-calc-eq"]');
  await page.waitForTimeout(200);
  // Press / 5
  for (const ch of ['/', '5']) {
    await page.click(`button[aria-label="${ch === '/' ? '除' : ch}"]`);
    await page.waitForTimeout(80);
  }

  await page.screenshot({ path: path.join(VERIFY_DIR, '02-state-result.png'), fullPage: false });

  const s2 = await page.evaluate(() => {
    const expr = document.querySelector('[data-testid="amount-calc-sheet-expr"]')?.textContent?.trim() ?? '';
    const preview = document.querySelector('[data-testid="amount-calc-sheet-preview"]')?.textContent?.trim() ?? '';
    const errorPill = document.querySelector('[data-testid="amount-calc-error-pill"]');
    const confirmBtn = document.querySelector('[data-testid="amount-calc-confirm"]');
    return {
      expr,
      preview,
      errorVisible: !!errorPill,
      confirmVisible: confirmBtn ? !confirmBtn.classList.contains('hidden') : false,
      confirmDisabled: confirmBtn ? confirmBtn.hasAttribute('disabled') : true,
      confirmRect: confirmBtn ? confirmBtn.getBoundingClientRect().toJSON() : null,
    };
  });
  console.log(`  expr="${s2.expr}" preview="${s2.preview}" confirmVisible=${s2.confirmVisible} confirmDisabled=${s2.confirmDisabled}`);

  results.push(log('S2.expr', s2.expr === '(60-10)/5' ? 'pass' : 'fail', `expr should be "(60-10)/5", got "${s2.expr}"`));
  results.push(log('S2.preview', s2.preview === '= 10.00' || s2.preview === '= 10' ? 'pass' : 'fail', `preview should be "= 10.00" or "= 10" (no currency), got "${s2.preview}"`));
  results.push(log('S2.preview-no-currency', !s2.preview.includes('CNY') && !s2.preview.includes('THB') ? 'pass' : 'fail', `preview must NOT show currency after =, got "${s2.preview}"`));
  results.push(log('S2.confirm-visible', s2.confirmVisible ? 'pass' : 'fail', `confirm should be visible, got visible=${s2.confirmVisible}`));
  results.push(log('S2.confirm-not-disabled', !s2.confirmDisabled ? 'pass' : 'fail', `confirm should NOT be disabled, got disabled=${s2.confirmDisabled}`));

  // Confirm button visual check (44x44 circle, purple gradient)
  const confirmBg = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="amount-calc-confirm"]');
    if (!btn) return null;
    const cs = getComputedStyle(btn);
    return { bg: cs.background, borderRadius: cs.borderRadius, w: btn.getBoundingClientRect().width, h: btn.getBoundingClientRect().height };
  });
  results.push(log('S2.confirm-circle', confirmBg && confirmBg.borderRadius === '50%' ? 'pass' : 'fail', `border-radius should be 50%, got "${confirmBg?.borderRadius}"`));
  results.push(log('S2.confirm-44', confirmBg && Math.abs(confirmBg.w - 44) < 2 && Math.abs(confirmBg.h - 44) < 2 ? 'pass' : 'fail', `confirm should be 44x44, got ${confirmBg?.w}x${confirmBg?.h}`));
  results.push(log('S2.confirm-gradient', confirmBg && confirmBg.bg.includes('linear-gradient') && confirmBg.bg.includes('99, 102, 241') ? 'pass' : 'fail', `confirm should have indigo gradient, got "${confirmBg?.bg?.slice(0, 80)}"`));

  // ====== State 4: click confirm → calculator closes + amount filled ======
  console.log('\n=== State 4: click confirm (点对号) ===');
  await page.click('[data-testid="amount-calc-confirm"]');
  await page.waitForTimeout(600);

  await page.screenshot({ path: path.join(VERIFY_DIR, '04-state-confirm.png'), fullPage: false });

  const s4 = await page.evaluate(() => {
    const sheet = document.querySelector('.sheet');
    const backdrop = document.querySelector('[data-testid="amount-calc-backdrop"]');
    const formInput = document.querySelector('[data-testid="amount-calc-input"]');
    return {
      sheetVisible: sheet !== null,
      backdropVisible: backdrop !== null,
      formInputValue: formInput?.value ?? '',
    };
  });
  console.log(`  sheetVisible=${s4.sheetVisible} backdropVisible=${s4.backdropVisible} formInputValue="${s4.formInputValue}"`);

  results.push(log('S4.sheet-closed', !s4.sheetVisible ? 'pass' : 'fail', `sheet should be closed (removed), got visible=${s4.sheetVisible}`));
  results.push(log('S4.backdrop-closed', !s4.backdropVisible ? 'pass' : 'fail', `backdrop should be closed, got visible=${s4.backdropVisible}`));
  results.push(log('S4.amount-filled', s4.formInputValue === '10' || s4.formInputValue === '10.00' ? 'pass' : 'fail', `form input should be "10" or "10.00", got "${s4.formInputValue}"`));

  // PO #3: form input 右侧无 "= xxx currency" 后缀
  // 验 form-row 内不存在 preview span
  const formRowHasPreview = await page.evaluate(() => {
    const row = document.querySelector('[data-testid="amount-calc-row"]');
    if (!row) return null;
    const preview = row.querySelector('.preview');
    return {
      hasPreview: !!preview,
      previewText: preview?.textContent?.trim() ?? '',
    };
  });
  results.push(log('S4.no-form-preview', !formRowHasPreview?.hasPreview ? 'pass' : 'fail', `form-row should NOT have preview span, got hasPreview=${formRowHasPreview?.hasPreview}, text="${formRowHasPreview?.previewText}"`));

  // ====== State 3: error (60 /) ======
  console.log('\n=== State 3: 60 / (除号后空, 错误) ===');
  // Reopen calculator
  await page.click('[data-testid="amount-calc-row"]');
  await page.waitForTimeout(500);
  for (const ch of ['6', '0', '/']) {
    await page.click(`button[aria-label="${ch === '/' ? '除' : ch}"]`);
    await page.waitForTimeout(80);
  }

  await page.screenshot({ path: path.join(VERIFY_DIR, '03-state-error.png'), fullPage: false });

  const s3 = await page.evaluate(() => {
    const expr = document.querySelector('[data-testid="amount-calc-sheet-expr"]')?.textContent?.trim() ?? '';
    const errorPill = document.querySelector('[data-testid="amount-calc-error-pill"]');
    const preview = document.querySelector('[data-testid="amount-calc-sheet-preview"]');
    const confirmBtn = document.querySelector('[data-testid="amount-calc-confirm"]');
    return {
      expr,
      errorVisible: !!errorPill,
      errorText: errorPill?.textContent?.trim() ?? '',
      errorBg: errorPill ? getComputedStyle(errorPill).background.slice(0, 200) : '',
      errorBorder: errorPill ? getComputedStyle(errorPill).border : '',
      errorColor: errorPill ? getComputedStyle(errorPill).color : '',
      previewVisible: !!preview,
      confirmVisible: confirmBtn ? !confirmBtn.classList.contains('hidden') : false,
      confirmDisabled: confirmBtn ? confirmBtn.hasAttribute('disabled') : true,
      confirmBg: confirmBtn ? getComputedStyle(confirmBtn).background : '',
    };
  });
  console.log(`  expr="${s3.expr}" errorText="${s3.errorText}" errorVisible=${s3.errorVisible} confirmDisabled=${s3.confirmDisabled}`);

  results.push(log('S3.expr', s3.expr === '60/' ? 'pass' : 'fail', `expr should be "60/", got "${s3.expr}"`));
  results.push(log('S3.error-visible', s3.errorVisible ? 'pass' : 'fail', `error pill should be visible, got visible=${s3.errorVisible}`));
  results.push(log('S3.error-text', s3.errorText === '表达式错误' ? 'pass' : 'fail', `error text should be "表达式错误", got "${s3.errorText}"`));
  results.push(log('S3.error-red-bg', s3.errorBg.includes('239, 68, 68') ? 'pass' : 'fail', `error bg should be rgba(239,68,68,...), got "${s3.errorBg}"`));
  results.push(log('S3.error-red-color', s3.errorColor.includes('185, 28, 28') ? 'pass' : 'fail', `error text color should be #b91c1c (185,28,28), got "${s3.errorColor}"`));
  results.push(log('S3.preview-hidden', !s3.previewVisible ? 'pass' : 'fail', `preview should be hidden in error state, got visible=${s3.previewVisible}`));
  // Note: in error state, the = is not pressed yet, so confirm btn is hidden (not just disabled)
  // Per task spec: "State 3: 对号按钮置灰 (rgba 0.4 + 弱 shadow) — 错误态不可确认"
  // If user types "60 /" (no =), the confirm is hidden (no = yet)
  // If user types "60 - 10 = /" (= then /), the confirm is visible but disabled
  results.push(log('S3.confirm-disabled-or-hidden', s3.confirmDisabled || !s3.confirmVisible ? 'pass' : 'fail', `confirm should be disabled or hidden, got disabled=${s3.confirmDisabled} visible=${s3.confirmVisible}`));

  // ====== State 2b: error with = → confirm visible but disabled ======
  console.log('\n=== State 3b: 60 - 10 = / (等号 + 续错) ===');
  // Clear
  await page.click('button[aria-label="清空"]');
  await page.waitForTimeout(200);
  for (const ch of ['6', '0', '-', '1', '0']) {
    await page.click(`button[aria-label="${ch === '-' ? '减' : ch}"]`);
    await page.waitForTimeout(80);
  }
  await page.click('[data-testid="amount-calc-eq"]');
  await page.waitForTimeout(200);
  await page.click('button[aria-label="除"]');
  await page.waitForTimeout(200);

  const s3b = await page.evaluate(() => {
    const expr = document.querySelector('[data-testid="amount-calc-sheet-expr"]')?.textContent?.trim() ?? '';
    const errorPill = document.querySelector('[data-testid="amount-calc-error-pill"]');
    const confirmBtn = document.querySelector('[data-testid="amount-calc-confirm"]');
    return {
      expr,
      errorVisible: !!errorPill,
      errorText: errorPill?.textContent?.trim() ?? '',
      confirmVisible: confirmBtn ? !confirmBtn.classList.contains('hidden') : false,
      confirmDisabled: confirmBtn ? confirmBtn.hasAttribute('disabled') : true,
      confirmBg: confirmBtn ? getComputedStyle(confirmBtn).background : '',
    };
  });
  console.log(`  expr="${s3b.expr}" errorText="${s3b.errorText}" confirmVisible=${s3b.confirmVisible} confirmDisabled=${s3b.confirmDisabled}`);

  results.push(log('S3b.expr', s3b.expr === '(60-10)/' ? 'pass' : 'fail', `expr should be "(60-10)/", got "${s3b.expr}"`));
  results.push(log('S3b.error', s3b.errorVisible && s3b.errorText === '表达式错误' ? 'pass' : 'fail', `error pill should be visible with "表达式错误", got visible=${s3b.errorVisible} text="${s3b.errorText}"`));
  results.push(log('S3b.confirm-disabled', s3b.confirmDisabled ? 'pass' : 'fail', `confirm should be disabled (gray), got disabled=${s3b.confirmDisabled}`));
  results.push(log('S3b.confirm-gray-bg', s3b.confirmBg.includes('148, 163, 184') ? 'pass' : 'fail', `confirm should be gray (rgba(148,163,184,0.4)), got "${s3b.confirmBg.slice(0, 80)}"`));

  // ====== Final summary ======
  console.log('\n===== Summary =====');
  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  console.log(`Total: ${results.length} | Pass: ${passed} | Fail: ${failed}`);

  // ====== State 5: edit mode prefill ======
  console.log('\n=== State 5: edit mode prefill (existing bill 74, amount=150) ===');
  await page.goto(`${BASE}/sessions/9/bills/74/edit`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  // Read form input value
  const s5 = await page.evaluate(() => {
    const input = document.querySelector('[data-testid="amount-calc-input"]');
    return { formInputValue: input?.value ?? '' };
  });
  console.log(`  formInputValue on edit page: "${s5.formInputValue}"`);
  results.push(log('S5.edit-prefill', s5.formInputValue === '150' || s5.formInputValue === '150.00' ? 'pass' : 'fail', `form input should be "150" or "150.00", got "${s5.formInputValue}"`));

  // Open calculator
  await page.click('[data-testid="amount-calc-row"]');
  await page.waitForTimeout(800);

  // Read sheet state
  const s5b = await page.evaluate(() => {
    const expr = document.querySelector('[data-testid="amount-calc-sheet-expr"]')?.textContent?.trim() ?? '';
    const preview = document.querySelector('[data-testid="amount-calc-sheet-preview"]')?.textContent?.trim() ?? '';
    return { expr, preview };
  });
  console.log(`  Sheet expr: "${s5b.expr}" preview: "${s5b.preview}"`);
  results.push(log('S5.sheet-expr', s5b.expr === '150' ? 'pass' : 'fail', `sheet expr should be "150", got "${s5b.expr}"`));
  results.push(log('S5.sheet-preview', s5b.preview.includes('150') ? 'pass' : 'fail', `sheet preview should show "= 150.00 CNY", got "${s5b.preview}"`));

  await page.screenshot({ path: path.join(VERIFY_DIR, '05-state-edit.png'), fullPage: false });

  console.log('\n===== Final Summary =====');
  const totalPassed = results.filter(r => r.status === 'pass').length;
  const totalFailed = results.filter(r => r.status === 'fail').length;
  console.log(`Total: ${results.length} | Pass: ${totalPassed} | Fail: ${totalFailed}`);

  await browser.close();
  process.exit(totalFailed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
