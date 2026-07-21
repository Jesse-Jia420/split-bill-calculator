#!/usr/bin/env node
/**
 * v0.3.21 #106 CurrencyAddModal 4 模式真机 walk + 9 项改动验证.
 *
 * 验证:
 *  #1 ⇄ 箭头不在 (multi+has_bills 同行 chip 之间)
 *  #2 右上角 × 按钮不在
 *  #3 取消按钮移右下挨保存 (flex-end)
 *  #4 chip / select 视觉统一 (.currency-pair-item 共享 pill)
 *  #5 "(不可改)" / "(有账单, 不可改)" 文字后缀不在
 *  #6 副币种 select 加「—」选项 (multi+!has_bills), 选后 rate disabled + label 切换单币种
 *  #7 .modal-backdrop click handler 不在 (点弹窗外不关)
 *  #8 "提交后会创建..." hint 不在
 *  #9 .modal box-shadow 有 ring + halo glow
 *
 * 数据基线:
 *  - session 3: CNY 单币种 + 0 bills → single + !has_bills
 *  - session 2: CNY+HKD 多币种 + 0 bills → multi + !has_bills
 *  - session 1: CNY+THB 多币种 + 32 bills → multi + has_bills
 *  - 无 single+has_bills session (per sbc skill #85 v3 排除范围)
 */
const { chromium } = require('playwright');

const SCREENSHOT_DIR = '/home/node/.openclaw/media/v0321-106';
const FE = 'http://127.0.0.1:8448';
const TEST_EMAIL = 'demo@example.com';
const TEST_CODE = '000000';

// 容器内 mkdir 兜底
const fs = require('fs');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function apiLogin(context) {
  const resp = await context.request.post(`${FE}/api/auth/send-code`, {
    data: { email: TEST_EMAIL },
  });
  if (!resp.ok()) throw new Error(`send-code failed: ${resp.status()}`);
  const resp2 = await context.request.post(`${FE}/api/auth/verify-code`, {
    data: { email: TEST_EMAIL, code: TEST_CODE },
  });
  if (!resp2.ok()) throw new Error(`verify-code failed: ${resp2.status()}`);
}

async function openModalAndScreenshot(page, sessionId, label) {
  await page.goto(`${FE}/sessions/${sessionId}`);
  // 等 SessionCurrencyBadge 出现 (pill 或 bar, owner 是 xinhua1001)
  const pill = page.locator('[data-sbc="currency-pill-add-secondary"]');
  const bar = page.locator('[data-sbc="currency-bar-edit"]');
  await page.waitForSelector('[data-sbc="currency-pill-add-secondary"], [data-sbc="currency-bar-edit"]', { timeout: 10000 });
  // 单币种 → 点击 pill; 多币种 → 点击整 bar
  if (await pill.count() > 0) {
    await pill.first().click();
  } else {
    await bar.first().click();
  }
  // 等 modal 出现
  await page.waitForSelector('[data-sbc="currency-add-modal"]', { timeout: 3000 });
  // 等动画
  await page.waitForTimeout(350);

  const outPath = `${SCREENSHOT_DIR}/${label}-modal.png`;
  await page.screenshot({ path: outPath, fullPage: false });

  // 收集 modal 关键 DOM 数据
  const modal = page.locator('[data-sbc="currency-add-modal"]');
  const mode = await modal.getAttribute('data-mode');
  const hasBills = await modal.getAttribute('data-has-bills');

  // #1 检查 ⇄ 箭头
  const arrowCount = await modal.locator('.currency-pair-arrow').count();

  // #2 检查右上角 × 关闭按钮
  const closeCount = await modal.locator('.modal-close').count();

  // #3 检查取消按钮位置 (flex-end = 在 submit 左边 + 同 row 右半)
  const cancelBtn = modal.locator('[data-testid="currency-add-cancel"]');
  const submitBtn = modal.locator('[data-testid="currency-add-submit"]');
  let cancelAlignRight = null;
  if (await cancelBtn.count() > 0 && await submitBtn.count() > 0) {
    const cancelBox = await cancelBtn.boundingBox();
    const submitBox = await submitBtn.boundingBox();
    // 取消按钮 X 坐标应该 >= submit X 坐标 - 100 (即两者都在右半, cancel 在 submit 左)
    cancelAlignRight = cancelBox && submitBox && (cancelBox.x + cancelBox.width) <= (submitBox.x + submitBox.width + 8) && cancelBox.x < submitBox.x;
  }

  // #4 检查 chip / select 都有 .currency-pair-item
  const pairItemCount = await modal.locator('.currency-pair-item').count();
  const legacyChipCount = await modal.locator('.primary-chip').count();

  // #5 检查文字后缀不在 (看所有 .field-label + .hint 内容)
  const labels = await modal.locator('.field-label, .hint').allTextContents();
  const hasLockedSuffix = labels.some((t) => /\(不可改\)|\(有账单, 不可改\)|\(主币种.*已锁定\)/.test(t));

  // #8 检查 "提交后会创建" hint 不在
  const hintTexts = await modal.locator('.hint').allTextContents();
  const hasSubmitHint = hintTexts.some((t) => /提交后会创建/.test(t));

  // #9 检查 box-shadow 有 ring (≥1px spread, accent indigo) + halo (≥48px blur 0 offset, accent indigo)
  // 注意: browser 把 CSS shorthand 序列化为 `rgba(...) Npx Npx Npx Npx`,
  // 所以 `0 0 0 2px rgba(...)` 变成 `rgba(...) 0px 0px 0px 2px`,
  // `0 0 60px rgba(...)` 变成 `rgba(...) 0px 0px 60px 0px`.
  const boxShadow = await modal.evaluate((el) => getComputedStyle(el).boxShadow);
  // ring = spread 1~3px (排除 inset 的 0px spread)
  const hasRing = /rgba\(99,\s*102,\s*241[\s\S]*?0px 0px 0px [12345](?:\.\d+)?px(?! inset)/.test(boxShadow);
  // halo = accent color blur ≥48px offset 0
  const hasHalo = /rgba\(99,\s*102,\s*241[\s\S]*?0px 0px (?:48|60|80|100)px 0px/.test(boxShadow);

  return {
    label,
    sessionId,
    mode,
    hasBills,
    arrowCount,        // #1 expect 0
    closeCount,        // #2 expect 0
    cancelAlignRight,  // #3 expect true
    pairItemCount,     // #4 expect > 0 (chip + select 都用)
    legacyChipCount,   // #4 expect 0
    hasLockedSuffix,   // #5 expect false
    hasSubmitHint,     // #8 expect false
    boxShadowSnippet: boxShadow.slice(0, 200),
    hasRing,           // #9 expect true
    hasHalo,           // #9 expect true
  };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    locale: 'zh-CN',
  });
  await apiLogin(context);

  const results = [];

  // === 模式 1: single + !has_bills (session 3) ===
  const page1 = await context.newPage();
  const r1 = await openModalAndScreenshot(page1, 3, '01-single-no-bills');
  results.push(r1);
  await page1.close();

  // === 模式 2: multi + !has_bills (session 2) ===
  const page2 = await context.newPage();
  const r2 = await openModalAndScreenshot(page2, 2, '02-multi-no-bills');
  // #6 验证 「—」 option + 选后 rate disabled + submit label 切换单币种
  const modal2 = page2.locator('[data-sbc="currency-add-modal"]');
  await modal2.waitFor();
  const dashOptions = await modal2.locator('[data-testid="currency-edit-secondary"] option').evaluateAll(
    (opts) => opts.map((o) => ({ value: o.value, text: o.textContent.trim() }))
  );
  const hasDashOption = dashOptions.some((o) => o.value === '' && o.text === '—');
  // 选「—」
  await modal2.locator('[data-testid="currency-edit-secondary"]').selectOption('');
  await page2.waitForTimeout(150);
  const rateDisabled = await modal2.locator('[data-testid="currency-edit-rate"]').isDisabled();
  const submitLabel = await modal2.locator('[data-testid="currency-add-submit"]').getAttribute('aria-label');
  // 截图 「—」 选中状态
  await page2.screenshot({
    path: SCREENSHOT_DIR + '/02b-multi-dash-selected.png',
  });
  // 触发 submit 验 toast
  let toastSeen = null;
  const toastPromise = page2.waitForSelector('.toast, [role="status"], [class*="toast"]', { timeout: 2000 }).catch(() => null);
  await modal2.locator('[data-testid="currency-add-submit"]').click();
  const toast = await toastPromise;
  if (toast) {
    toastSeen = await toast.textContent();
    await page2.screenshot({
      path: SCREENSHOT_DIR + '/02c-multi-dash-toast.png',
    });
  }
  r2.dashOptions = dashOptions;
  r2.hasDashOption = hasDashOption;
  r2.rateDisabledAfterDash = rateDisabled;
  r2.submitLabelAfterDash = submitLabel;
  r2.toastSeen = toastSeen;
  results.push(r2);
  await page2.close();

  // === 模式 3: multi + has_bills (session 1) ===
  const page3 = await context.newPage();
  const r3 = await openModalAndScreenshot(page3, 1, '03-multi-has-bills');
  // #7 验证弹窗外点击不关
  const modal3 = page3.locator('[data-sbc="currency-add-modal"]');
  // 点 backdrop 区域 (modal 之外的空白)
  await page3.mouse.click(20, 20);  // 左上角, 不在 modal 上
  await page3.waitForTimeout(300);
  const modalStillOpen = await modal3.isVisible();
  r3.modalStillOpenAfterOutsideClick = modalStillOpen;
  results.push(r3);
  await page3.close();

  await browser.close();

  console.log(JSON.stringify(results, null, 2));

  // 汇总 pass/fail
  const fail = [];
  for (const r of results) {
    if (r.arrowCount !== 0) fail.push(`${r.label}: #1 arrowCount=${r.arrowCount} (expect 0)`);
    if (r.closeCount !== 0) fail.push(`${r.label}: #2 closeCount=${r.closeCount} (expect 0)`);
    if (r.cancelAlignRight !== true) fail.push(`${r.label}: #3 cancelAlignRight=${r.cancelAlignRight}`);
    if (r.pairItemCount < 1) fail.push(`${r.label}: #4 pairItemCount=${r.pairItemCount}`);
    if (r.legacyChipCount !== 0) fail.push(`${r.label}: #4 legacyChipCount=${r.legacyChipCount}`);
    if (r.hasLockedSuffix) fail.push(`${r.label}: #5 hasLockedSuffix=true`);
    if (r.hasSubmitHint) fail.push(`${r.label}: #8 hasSubmitHint=true`);
    if (!r.hasRing) fail.push(`${r.label}: #9 hasRing=false`);
    if (!r.hasHalo) fail.push(`${r.label}: #9 hasHalo=false`);
  }
  if (r2) {
    if (!r2.hasDashOption) fail.push(`#6 multi+!has_bills: 「—」 option not found in secondary select`);
    if (!r2.rateDisabledAfterDash) fail.push(`#6 rate input NOT disabled after picking 「—」`);
    if (r2.submitLabelAfterDash !== '切换单币种') fail.push(`#6 submit label after 「—」: ${r2.submitLabelAfterDash} (expect "切换单币种")`);
  }
  if (r3) {
    if (!r3.modalStillOpenAfterOutsideClick) fail.push(`#7 modal closed after outside click (should stay open)`);
  }

  if (fail.length > 0) {
    console.log('\n❌ FAILED:');
    for (const f of fail) console.log('  - ' + f);
    process.exit(1);
  } else {
    console.log('\n✅ ALL PASSED');
  }
})();