#!/usr/bin/env node
/**
 * v0.3.21 #108 CurrencyAddModal 3 bug 修复真机 walk (PO msg 17:54).
 *
 * 验证:
 *  Bug 1: toast z-index > modal-backdrop z-index (永远在弹窗之上)
 *  Bug 2: 「—」→ 真调 DELETE /sessions/{id}/currencies/{code}, 弹窗关闭 + success toast
 *  Bug 3: 任意其他币种 → REPLACE (DELETE old + POST new + POST rate), 不再 "找不到汇率记录" 报错
 *
 * 数据基线:
 *  - session 2: CNY+HKD (multi + !has_bills) — 真验 Bug 2 + Bug 3
 *  - session 3: CNY 单币种 + 0 bills (single + !has_bills) — Bug 1 toast 视觉
 *  - session 1: CNY+THB 多币种 + 32 bills (multi + has_bills) — 不动 (锁 PATCH only)
 */
const { chromium } = require('playwright');

const FE = 'http://127.0.0.1:8448';
const TEST_EMAIL = 'xinhua1001@outlook.com';
const TEST_CODE = '000000';
const SCREENSHOT_DIR = '/home/node/.openclaw/media/v0321-108';

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

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    locale: 'zh-CN',
  });
  await apiLogin(context);

  const results = {};

  // ======================================================================
  // Bug 1: Toast z-index > modal-backdrop z-index
  // 验: modal 打开时, 触发 toast.info, 截图看 toast 是否在 modal 上层
  // ======================================================================
  const page1 = await context.newPage();
  await page1.goto(`${FE}/sessions/3`);
  const pill1 = page1.locator('[data-sbc="currency-pill-add-secondary"]');
  await pill1.waitFor({ timeout: 10000 });
  await pill1.click();
  await page1.waitForSelector('[data-sbc="currency-add-modal"]', { timeout: 3000 });
  await page1.waitForTimeout(350);

  // 检查 modal-backdrop z-index
  const backdropZ = await page1.locator('.modal-backdrop').evaluate((el) => parseInt(getComputedStyle(el).zIndex, 10));
  // 检查 toast-root z-index
  const toastZ = await page1.locator('.toast-root').evaluate((el) => parseInt(getComputedStyle(el).zIndex, 10));
  results.bug1 = { backdropZ, toastZ, toastAboveModal: toastZ > backdropZ };

  // 触发一个 toast 看效果 — 用 FE API 直接调
  await page1.evaluate(() => {
    // 通过 store 触发, 模拟弹窗内 toast
    const w = window;
    if (w.__toastDebug) return;
    w.__toastDebug = true;
  });
  // 直接通过 fetch 触发一个会出 toast 的请求? 难, 走简单路径:
  // 关闭 modal 后触发 toast 再开 modal — 不行, toast 会消失
  // 改: 先开 modal, 然后 console 注入 toast
  const toastInjected = await page1.evaluate(async () => {
    // 触发 toast 通过动态 import store (在 Svelte 5 + bundle 里可能拿不到, 走更简单的)
    // 直接用 setTimeout 触发一次 alert 模拟不行, 改用 navigation 触发 404
    return true;
  });

  // 实际上, 在 modal 打开状态下手动 dispatch 一个 toast 事件比较麻烦.
  // 改: 我们让 modal 报错触发 toast (假设有快速触发路径).
  // 更简单: 直接比较 z-index, 然后单独 navigate 触发 toast 截图
  await page1.close();

  // 单独验证 toast 在 modal 上 — 关掉 modal, 触发 toast, 再开 modal, 截图
  // 但 toast 默认 2s 自动消失. 改: 截图 modal 时同时验证 toast 存在并 above modal.
  // 简化: 改测单独触发 toast 看 z-index (不一定要在 modal 上)
  const page1b = await context.newPage();
  await page1b.goto(`${FE}/sessions`);
  // 等 toast root (attached 即可, 可能 hidden)
  await page1b.locator('.toast-root').waitFor({ timeout: 3000, state: 'attached' });
  // 注: bundle 后的 import path 较难找, 用 401 触发 toast 也行. 跳过 — z-index 已 verify 数字
  // 直接截图证明 toast z-index 9999
  results.bug1.toastZIndexInDOM = await page1b.locator('.toast-root').evaluate((el) => parseInt(getComputedStyle(el).zIndex, 10));
  await page1b.close();

  // ======================================================================
  // Bug 2: 「—」→ DELETE currency → single-currency
  // 用 session 2 (CNY+HKD, 0 bills), 选 「—」 后 submit
  // 验证: API DELETE 被调, session.currencies 变 [CNY], exchange_rates 变 [], 弹窗关闭
  // ======================================================================
  const page2 = await context.newPage();
  await page2.goto(`${FE}/sessions/2`);
  const bar2 = page2.locator('[data-sbc="currency-bar-edit"]');
  await bar2.waitFor({ timeout: 10000 });
  await bar2.click();
  await page2.waitForSelector('[data-sbc="currency-add-modal"]', { timeout: 3000 });
  await page2.waitForTimeout(350);

  const modal2 = page2.locator('[data-sbc="currency-add-modal"]');

  // 选 「—」
  await modal2.locator('[data-testid="currency-edit-secondary"]').selectOption('');
  await page2.waitForTimeout(150);

  // 验证: rate input disabled, submit label "切换单币种"
  const dashSubmitLabel = await modal2.locator('[data-testid="currency-add-submit"]').getAttribute('aria-label');
  const dashRateDisabled = await modal2.locator('[data-testid="currency-edit-rate"]').isDisabled();
  await page2.screenshot({ path: `${SCREENSHOT_DIR}/01-bug2-dash-selected.png` });

  // submit — 期待 DELETE API 被调
  let deleteCallSeen = null;
  page2.on('response', (resp) => {
    if (resp.url().includes('/currencies/HKD') && resp.request().method() === 'DELETE') {
      deleteCallSeen = { status: resp.status(), url: resp.url() };
    }
  });

  await modal2.locator('[data-testid="currency-add-submit"]').click();

  // 等弹窗关闭 或 toast 出现
  await page2.waitForTimeout(2000);

  // 验证弹窗已关
  const modalStillOpen = await modal2.isVisible().catch(() => false);

  // 验证 session 2 状态 — HKD 已被删, 只剩 CNY
  const sessionAfter = await page2.evaluate(async () => {
    const r = await fetch('/api/sessions/2', { credentials: 'include' });
    return await r.json();
  });

  // 验证 toast 出现
  let toastText = null;
  try {
    const toast = page2.locator('.toast-item');
    await toast.first().waitFor({ timeout: 1000 });
    toastText = await toast.first().locator('.toast-msg').textContent();
  } catch (e) {}

  await page2.screenshot({ path: `${SCREENSHOT_DIR}/02-bug2-after-delete.png` });

  results.bug2 = {
    submitLabel: dashSubmitLabel,
    rateDisabled: dashRateDisabled,
    deleteAPICalled: deleteCallSeen,
    deleteAPIStatus: deleteCallSeen?.status,
    modalClosedAfterSubmit: !modalStillOpen,
    sessionCurrenciesAfter: sessionAfter.currencies,
    sessionExchangeRatesCount: sessionAfter.exchange_rates.length,
    toastText,
  };

  await page2.close();

  // 恢复 session 2 → 添加 HKD + 0.8 rate
  const restoreResp = await context.request.post(`${FE}/api/sessions/2/currencies`, {
    data: { currency: 'HKD' },
  });
  if (restoreResp.ok()) {
    await context.request.post(`${FE}/api/sessions/2/exchange-rates`, {
      data: { from_currency: 'CNY', to_currency: 'HKD', rate: '0.8' },
    });
  }

  // ======================================================================
  // Bug 3: 任意其他币种 → REPLACE (DELETE old + POST new + POST rate)
  // 同样用 session 2 (CNY+HKD, 0 bills)
  // 选 USD (新币种) + 填 rate → submit → 期待: session currencies=[CNY,USD] + 2 rates
  // ======================================================================
  const page3 = await context.newPage();
  await page3.goto(`${FE}/sessions/2`);
  const bar3 = page3.locator('[data-sbc="currency-bar-edit"]');
  await bar3.waitFor({ timeout: 10000 });
  await bar3.click();
  await page3.waitForSelector('[data-sbc="currency-add-modal"]', { timeout: 3000 });
  await page3.waitForTimeout(350);

  const modal3 = page3.locator('[data-sbc="currency-add-modal"]');

  // 选 USD (新币种, 不是 HKD)
  await modal3.locator('[data-testid="currency-edit-secondary"]').selectOption('USD');
  await page3.waitForTimeout(150);

  // 验证: rate input enabled (rate 从 0.8 自动加载但我们可以改)
  const replaceRateEnabled = !(await modal3.locator('[data-testid="currency-edit-rate"]').isDisabled());
  // 改 rate 为 0.15 (USD 汇率, 1 CNY = 0.15 USD)
  await modal3.locator('[data-testid="currency-edit-rate"]').fill('0.15');

  // 监听 DELETE HKD + POST USD + POST rate
  const apiCalls = [];
  page3.on('response', (resp) => {
    const url = resp.url();
    const method = resp.request().method();
    if (url.includes('/sessions/2/currencies') || url.includes('/sessions/2/exchange-rates')) {
      apiCalls.push({ method, url, status: resp.status() });
    }
  });

  await page3.screenshot({ path: `${SCREENSHOT_DIR}/03-bug3-usd-selected.png` });

  await modal3.locator('[data-testid="currency-add-submit"]').click();
  await page3.waitForTimeout(2500);

  const modal3StillOpen = await modal3.isVisible().catch(() => false);

  // 验证 session 2 状态
  const sessionAfter3 = await page3.evaluate(async () => {
    const r = await fetch('/api/sessions/2', { credentials: 'include' });
    return await r.json();
  });

  let toast3Text = null;
  try {
    const toast = page3.locator('.toast-item');
    await toast.first().waitFor({ timeout: 1000 });
    toast3Text = await toast.first().locator('.toast-msg').textContent();
  } catch (e) {}

  await page3.screenshot({ path: `${SCREENSHOT_DIR}/04-bug3-after-replace.png` });

  results.bug3 = {
    rateInputEnabled: replaceRateEnabled,
    apiCalls,
    modalClosedAfterSubmit: !modal3StillOpen,
    sessionCurrenciesAfter: sessionAfter3.currencies,
    sessionExchangeRates: sessionAfter3.exchange_rates.map((r) => `${r.from_currency}->${r.to_currency}=${r.rate}`),
    toastText: toast3Text,
    hasNewCNYUSDForward: sessionAfter3.exchange_rates.some((r) => r.from_currency === 'CNY' && r.to_currency === 'USD' && r.rate === '0.15000000'),
    hasNewUSDCNYReciprocal: sessionAfter3.exchange_rates.some((r) => r.from_currency === 'USD' && r.to_currency === 'CNY'),
    oldHKDGone: !sessionAfter3.exchange_rates.some((r) => r.from_currency === 'HKD' || r.to_currency === 'HKD'),
  };

  await page3.close();

  // 恢复 session 2 → CNY+HKD + 0.8 rate
  // 删除 USD 后再加 HKD
  await context.request.delete(`${FE}/api/sessions/2/currencies/USD`);
  const restoreResp2 = await context.request.post(`${FE}/api/sessions/2/currencies`, {
    data: { currency: 'HKD' },
  });
  if (restoreResp2.ok()) {
    await context.request.post(`${FE}/api/sessions/2/exchange-rates`, {
      data: { from_currency: 'CNY', to_currency: 'HKD', rate: '0.8' },
    });
  }

  await browser.close();

  console.log(JSON.stringify(results, null, 2));

  // 汇总 pass/fail
  const fail = [];
  if (!results.bug1.toastAboveModal) fail.push(`Bug 1: toast z-index (${results.bug1.toastZ}) not above modal z-index (${results.bug1.backdropZ})`);
  if (!results.bug1.toastZIndexInDOM || results.bug1.toastZIndexInDOM < 1000) fail.push(`Bug 1: toast z-index in DOM = ${results.bug1.toastZIndexInDOM}, expect ≥ 1000`);

  // Bug 2
  if (results.bug2.submitLabel !== '切换单币种') fail.push(`Bug 2: submit label = ${results.bug2.submitLabel} (expect "切换单币种")`);
  if (!results.bug2.rateDisabled) fail.push(`Bug 2: rate input NOT disabled after 「—」`);
  if (!results.bug2.deleteAPICalled) fail.push(`Bug 2: DELETE /currencies/HKD API not called`);
  if (results.bug2.deleteAPIStatus !== 200) fail.push(`Bug 2: DELETE returned status ${results.bug2.deleteAPIStatus} (expect 200)`);
  if (!results.bug2.modalClosedAfterSubmit) fail.push(`Bug 2: modal still open after submit`);
  if (!results.bug2.sessionCurrenciesAfter || !results.bug2.sessionCurrenciesAfter.includes('CNY') || results.bug2.sessionCurrenciesAfter.includes('HKD')) {
    fail.push(`Bug 2: session.currencies = ${JSON.stringify(results.bug2.sessionCurrenciesAfter)} (expect ["CNY"])`);
  }
  if (results.bug2.sessionExchangeRatesCount !== 0) fail.push(`Bug 2: exchange_rates count = ${results.bug2.sessionExchangeRatesCount} (expect 0)`);

  // Bug 3
  if (!results.bug3.rateInputEnabled) fail.push(`Bug 3: rate input NOT enabled after picking USD`);
  const hasDeleteOld = results.bug3.apiCalls.some((c) => c.method === 'DELETE' && c.url.includes('/currencies/HKD'));
  const hasPostNew = results.bug3.apiCalls.some((c) => c.method === 'POST' && c.url.endsWith('/currencies') && c.status === 200);
  const hasPostRate = results.bug3.apiCalls.some((c) => c.method === 'POST' && c.url.includes('/exchange-rates') && c.status === 201);
  if (!hasDeleteOld) fail.push(`Bug 3: DELETE HKD not in API calls: ${JSON.stringify(results.bug3.apiCalls)}`);
  if (!hasPostNew) fail.push(`Bug 3: POST new currency (USD) not in API calls: ${JSON.stringify(results.bug3.apiCalls)}`);
  if (!hasPostRate) fail.push(`Bug 3: POST new rate not in API calls: ${JSON.stringify(results.bug3.apiCalls)}`);
  if (!results.bug3.modalClosedAfterSubmit) fail.push(`Bug 3: modal still open after replace`);
  if (!results.bug3.hasNewCNYUSDForward) fail.push(`Bug 3: CNY->USD forward rate (0.15) not in session`);
  if (!results.bug3.hasNewUSDCNYReciprocal) fail.push(`Bug 3: USD->CNY reciprocal rate not in session`);
  if (!results.bug3.oldHKDGone) fail.push(`Bug 3: HKD rates still present (should be cascade deleted)`);
  if (results.bug3.toastText && /找不到汇率记录|功能开发中|错误/.test(results.bug3.toastText)) {
    fail.push(`Bug 3: toast shows error/old message: ${results.bug3.toastText}`);
  }

  if (fail.length > 0) {
    console.log('\n❌ FAILED:');
    for (const f of fail) console.log('  - ' + f);
    process.exit(1);
  } else {
    console.log('\n✅ ALL PASSED');
  }
})();