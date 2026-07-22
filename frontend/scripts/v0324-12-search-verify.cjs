#!/usr/bin/env node
/**
 * v0.3.24 #12 — UAT bug settle 页 加搜索框 (个人视图 + 主币种汇总).
 *
 * 验证 7 项:
 *   1. settle 页 /sessions/1/settle 默认 (overview) 不显示 search boxes (search 只在 personal tab).
 *   2. 切到 personal tab 后, 2 个 .bills-section-search 出现 (付款明细 + 消费明细).
 *   3. search placeholder = "搜索账单名称" (跟 BillListGrouped 一致).
 *   4. search input glass 风格: backdrop-filter 含 blur/saturate, bg rgba 半透明.
 *   5. 输入关键词 filter (e.g. "晚餐") → bills 数减少.
 *   6. 输入 "ZZZ_NO_MATCH" → filter 空态 placeholder "没有匹配的账单,换个关键词试试。" 显示.
 *   7. X clear 按钮 + 点 X 重置 search.
 *
 * 注: session 1 (泰国测试账单 32 bills, 6 成员) 是主测对象. owner = xinhua1001.
 */
const { chromium, devices } = require('playwright');
const fs = require('fs');

const BASE = 'http://172.18.0.5:8448';
const SCREENSHOT_DIR = '/home/node/.openclaw/workspace/.verify-v0324-12-search';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-CN' });
  const page = await ctx.newPage();

  // Login (BE API + cookie jar, 跟 v0.3.22 #122 / v0.3.23 #132 一致)
  await page.request.post(`${BASE}/auth/send-code`, {
    data: { email: 'xinhua1001@outlook.com' },
    headers: { 'Content-Type': 'application/json' },
  });
  await page.request.post(`${BASE}/auth/verify-code`, {
    data: { email: 'xinhua1001@outlook.com', code: '000000' },
    headers: { 'Content-Type': 'application/json' },
  });

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // === /sessions/1/settle?view=primary ===
  await page.goto(`${BASE}/sessions/1/settle?view=primary`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-settle-default-primary.png`, fullPage: false });

  // === Check 1: 默认 overview tab 不显示 search (personal 才有) ===
  const overviewSearches = await page.locator('.bills-section-search').count();
  console.log('--- Check 1: overview tab search boxes (expect 0) ---');
  console.log(`overviewSearches=${overviewSearches}`);

  // === 切到 personal tab ===
  // IosSwitch 显示 2 option "概览"/"个人视图", 点击 "个人视图" button
  await page.getByRole('tab', { name: /个人视图/ }).click({ timeout: 5000 }).catch(async () => {
    // fallback: 通过 .ios-switch-option[aria-selected=false] 找
    await page.evaluate(() => {
      const opts = Array.from(document.querySelectorAll('.ios-switch-option'));
      const personalOpt = opts.find(o => o.textContent?.includes('个人视图'));
      if (personalOpt) personalOpt.click();
    });
  });
  await page.waitForTimeout(1500);

  // 等待 member-panel 出现
  await page.waitForSelector('.bills-section-paid', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-settle-personal-tab.png`, fullPage: false });

  // === Check 2: personal tab 有 2 个 .bills-section-search ===
  const personalSearches = await page.locator('.bills-section-search').count();
  console.log('--- Check 2: personal tab search boxes (expect 2) ---');
  console.log(`personalSearches=${personalSearches}`);

  // === Check 3: placeholder + glass 风格 ===
  const searchMeta = await page.evaluate(() => {
    const searches = Array.from(document.querySelectorAll('.bills-section-search'));
    if (searches.length === 0) return null;
    const first = searches[0];
    const input = first.querySelector('.bills-section-search-input');
    const cs = getComputedStyle(first);
    return {
      placeholder: input?.placeholder,
      ariaLabel: input?.getAttribute('aria-label'),
      // glass style
      bg: cs.backgroundColor,
      backdrop: cs.backdropFilter || cs.webkitBackdropFilter,
      borderRadius: cs.borderRadius,
      borderColor: cs.borderTopColor,
      // position
      display: cs.display,
      gap: cs.gap,
    };
  });
  console.log('--- Check 3: search placeholder + glass 风格 ---');
  console.log(JSON.stringify(searchMeta, null, 2));

  // === Check 5: filter 测试 — 记录初始 paid/consumed bill 数 ===
  const beforeFilter = await page.evaluate(() => {
    const paid = document.querySelectorAll('.bills-section-paid .bill-subrow').length;
    const consumed = document.querySelectorAll('.bills-section-consumed .bill-subrow').length;
    const paidEmpty = !!document.querySelector('.bills-section-paid .empty-hint');
    const consumedEmpty = !!document.querySelector('.bills-section-consumed .empty-hint');
    return { paid, consumed, paidEmpty, consumedEmpty };
  });
  console.log('--- Check 5: BEFORE filter ---');
  console.log(JSON.stringify(beforeFilter, null, 2));

  // === 输入 "晚餐" (按 bill description 模糊匹配) ===
  // 找到 .bills-section-paid 里的 input (第一个 .bills-section-search 是付款明细)
  await page.locator('.bills-section-paid .bills-section-search-input').fill('晚餐');
  await page.waitForTimeout(500);
  const afterDinner = await page.evaluate(() => {
    const paid = document.querySelectorAll('.bills-section-paid .bill-subrow').length;
    const consumed = document.querySelectorAll('.bills-section-consumed .bill-subrow').length;
    return { paid, consumed };
  });
  console.log('--- Check 5b: AFTER filter "晚餐" ---');
  console.log(JSON.stringify(afterDinner, null, 2));

  // === 清空 search ===
  await page.locator('.bills-section-paid .bills-section-search-input').fill('');
  await page.waitForTimeout(500);
  const afterClear = await page.evaluate(() => {
    const paid = document.querySelectorAll('.bills-section-paid .bill-subrow').length;
    const consumed = document.querySelectorAll('.bills-section-consumed .bill-subrow').length;
    return { paid, consumed };
  });
  console.log('--- Check 5c: AFTER clear (empty search) ---');
  console.log(JSON.stringify(afterClear, null, 2));

  // === Check 6: filter 空态 placeholder ===
  // 输入 "ZZZ_NO_MATCH_AT_ALL"
  await page.locator('.bills-section-paid .bills-section-search-input').fill('ZZZ_NO_MATCH_AT_ALL');
  await page.waitForTimeout(500);
  const afterNoMatch = await page.evaluate(() => {
    const paid = document.querySelectorAll('.bills-section-paid .bill-subrow').length;
    const emptyHints = Array.from(document.querySelectorAll('.bills-section-paid .empty-hint')).map(e => e.textContent?.trim());
    return { paid, emptyHints };
  });
  console.log('--- Check 6: filter "ZZZ_NO_MATCH_AT_ALL" ---');
  console.log(JSON.stringify(afterNoMatch, null, 2));

  // === 截图: 空态 + search ===
  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-settle-empty-state.png`, fullPage: false });

  // === Check 7: clear button + 重置 ===
  const clearBtnExists = await page.locator('.bills-section-paid .bills-section-search-clear').count();
  console.log('--- Check 7: clear button (expect 1 when has text) ---');
  console.log(`clearBtnExists=${clearBtnExists}`);

  await page.locator('.bills-section-paid .bills-section-search-clear').click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  const afterClearClick = await page.evaluate(() => {
    const input = document.querySelector('.bills-section-paid .bills-section-search-input');
    return { inputValue: input?.value };
  });
  console.log('--- Check 7b: AFTER click X clear ---');
  console.log(JSON.stringify(afterClearClick, null, 2));

  // === 切到 split viewMode (原始数据) ===
  await page.evaluate(() => {
    const opts = Array.from(document.querySelectorAll('.ios-switch-option'));
    const splitOpt = opts.find(o => o.textContent?.includes('原始数据'));
    if (splitOpt) splitOpt.click();
  });
  await page.waitForTimeout(1500);

  // === 在 split 模式下, search 仍能 filter ===
  await page.locator('.bills-section-paid .bills-section-search-input').fill('晚餐');
  await page.waitForTimeout(500);
  const afterSplitFilter = await page.evaluate(() => {
    const paid = document.querySelectorAll('.bills-section-paid .bill-subrow').length;
    const emptyHints = Array.from(document.querySelectorAll('.bills-section-paid .empty-hint')).map(e => e.textContent?.trim());
    return { paid, emptyHints };
  });
  console.log('--- Check 8: split viewMode + filter "晚餐" ---');
  console.log(JSON.stringify(afterSplitFilter, null, 2));

  await page.screenshot({ path: `${SCREENSHOT_DIR}/04-settle-split-viewmode.png`, fullPage: false });

  await browser.close();
  console.log('--- DONE ---');
})();