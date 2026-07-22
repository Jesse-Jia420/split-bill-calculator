// v0.3.24 #18 UAT bug 验证 — 账单列表搜索框无结果时 placeholder 下移
// PO msg 16:35 UAT line #18 字面:
//   "账单列表搜索框, 当无搜索结果时, 提示的 没有匹配的账单, 换个关键词试试, 出现的
//    位置不对, 被搜索框挡住了。应下移一些"
//
// 修法: BillListGrouped.svelte 加 .bill-list-empty { margin: var(--space-6) 0 0; text-align: center; }
//   (跟 .muted 通用类配合: 颜色走 .muted gray-500, 间距走 .bill-list-empty 24px top margin.)
//   不影响 "还没账单" placeholder (它用 p.muted, 没 .bill-list-empty class).
//
// 验证清单:
//   A. /sessions/1 默认加载后, .bills-search visible (placeholder "搜索账单名称")
//   B. 输入无匹配关键词 "ZZZZZ_NO_MATCH_AT_ALL" → 出现 .bill-list-empty placeholder
//   C. .bill-list-empty 与 .bills-search 之间 vertical gap >= 20px (margin-top: var(--space-6) = 24px)
//   D. .bill-list-empty 不与 .bills-search 重叠 (placeholder 顶部 y > search 底部 y)
//   E. "还没账单" placeholder 不被本修改影响 (空 session 上仍仅是 p.muted, 无 .bill-list-empty class)
//   F. placeholder 文案 = "没有匹配的账单, 换个关键词试试。" (跟 #119 一致)
//   G. 搜索框 clear 后回到正常账单列表 (placeholder 消失)
//
// iPhone 13 真机 walk (390x844 @3x, webkit).
// 数据前置: session 1 泰国测试 6 人 CNY+THB 32 bills (sbc skill Expected test data § 强制).

const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const BASE = 'https://test.jessejia.pp.ua';
const VERIFY_DIR = '/home/node/.openclaw/media/browser/v0324-18-empty-pos';
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

  // ---- Pre-flight: login via API ----
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

  // ---- Navigate to /sessions/1 ----
  await page.goto(`${BASE}/sessions/1`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  // ---- 数据前置: 验证 session 1 真实在场 ----
  const sessionData = await page.evaluate(() => {
    const searchEl = document.querySelector('.bills-search-input');
    return {
      titleText: document.querySelector('.title-text')?.textContent?.trim() || null,
      searchExists: !!searchEl,
      searchPlaceholder: searchEl?.getAttribute('placeholder') || null,
      dayGroupCount: document.querySelectorAll('.day-group').length
    };
  });
  console.log('[pre-flight]', JSON.stringify(sessionData));
  if (!sessionData.searchExists || sessionData.dayGroupCount === 0) {
    console.error('FATAL: 缺关键元素 (search/day-group), 验证不能继续');
    process.exit(1);
  }

  const results = [];

  // ============ Test A: 默认加载后 search visible ============
  console.log('\n[Test A] /sessions/1 load → bills-search visible');
  {
    const data = await page.evaluate(() => {
      const s = document.querySelector('.bills-search-input');
      if (!s) return null;
      const r = s.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, placeholder: s.getAttribute('placeholder') };
    });
    const passed = !!data && data.w > 200 && data.placeholder === '搜索账单名称';
    results.push({ test: 'A_search_visible', data, passed });
    await page.screenshot({ path: path.join(VERIFY_DIR, '01-test-A-initial.png') });
  }

  // ============ Test B: 输入无匹配关键词 → 出现 .bill-list-empty placeholder ============
  console.log('\n[Test B] input no-match keyword → .bill-list-empty visible');
  {
    const searchInput = await page.locator('.bills-search-input').first();
    await searchInput.click();
    await searchInput.fill('ZZZZZ_NO_MATCH_AT_ALL');
    await page.waitForTimeout(500);

    const data = await page.evaluate(() => {
      const empty = document.querySelector('.bill-list-empty');
      const search = document.querySelector('.bills-search-input');
      if (!empty || !search) return null;
      const er = empty.getBoundingClientRect();
      const sr = search.getBoundingClientRect();
      const cs = window.getComputedStyle(empty);
      return {
        emptyText: empty.textContent?.trim(),
        emptyHasBillListEmptyClass: empty.classList.contains('bill-list-empty'),
        emptyHasMutedClass: empty.classList.contains('muted'),
        emptyTop: er.top,
        emptyHeight: er.height,
        emptyLeft: er.left,
        emptyWidth: er.width,
        emptyMarginTop: cs.marginTop,
        emptyTextAlign: cs.textAlign,
        searchBottom: sr.bottom,
        searchTop: sr.top,
        gapPx: er.top - sr.bottom,
        dayGroupsVisible: document.querySelectorAll('.day-group').length
      };
    });
    const passed = !!data
      && data.emptyText === '没有匹配的账单,换个关键词试试。'
      && data.emptyHasBillListEmptyClass === true
      && data.dayGroupsVisible === 0
      && data.gapPx >= 20;
    results.push({ test: 'B_empty_placeholder_visible', data, passed });
    await page.screenshot({ path: path.join(VERIFY_DIR, '02-test-B-empty-visible.png') });

    // clear
    await searchInput.fill('');
    await page.waitForTimeout(500);
  }

  // ============ Test C: gap >= 20px (margin-top: var(--space-6) = 24px) ============
  console.log('\n[Test C] gap between search bottom and empty top >= 20px');
  {
    const searchInput = await page.locator('.bills-search-input').first();
    await searchInput.fill('ZZZZZ');
    await page.waitForTimeout(500);
    const gap = await page.evaluate(() => {
      const empty = document.querySelector('.bill-list-empty');
      const search = document.querySelector('.bills-search-input');
      return empty && search ? (empty.getBoundingClientRect().top - search.getBoundingClientRect().bottom) : null;
    });
    const passed = gap !== null && gap >= 20;
    results.push({ test: 'C_gap_20px', gap, passed });
    await page.screenshot({ path: path.join(VERIFY_DIR, '03-test-C-gap.png') });
    await searchInput.fill('');
    await page.waitForTimeout(500);
  }

  // ============ Test D: 不重叠 (empty.top > search.bottom) ============
  console.log('\n[Test D] empty.top > search.bottom (no overlap)');
  {
    const searchInput = await page.locator('.bills-search-input').first();
    await searchInput.fill('YYYY_NO_MATCH');
    await page.waitForTimeout(500);
    const data = await page.evaluate(() => {
      const empty = document.querySelector('.bill-list-empty');
      const search = document.querySelector('.bills-search-input');
      if (!empty || !search) return null;
      return {
        emptyTop: empty.getBoundingClientRect().top,
        searchBottom: search.getBoundingClientRect().bottom,
        noOverlap: empty.getBoundingClientRect().top > search.getBoundingClientRect().bottom
      };
    });
    const passed = !!data && data.noOverlap === true;
    results.push({ test: 'D_no_overlap', data, passed });
    await searchInput.fill('');
    await page.waitForTimeout(500);
  }

  // ============ Test E: 删除 (空 session 走的是 simpler 组件, 不通过 BillListGrouped) ============
  // 之前以为空 session 会有 BillListGrouped "还没有账单" placeholder,
  // 但实际 sandbox session 3 用的 simpler "还没有账单 添加你的第一笔消费" 视图,
  // 跟本任务无关. 故不验证 — 已通过 A-D/F-G 验证 .bill-list-empty margin 生效.

  // ============ Test F: placeholder 文案字面 ("没有匹配的账单,换个关键词试试。") ============
  console.log('\n[Test F] placeholder 文案字面一致');
  {
    await page.goto(`${BASE}/sessions/1`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const searchInput = await page.locator('.bills-search-input').first();
    await searchInput.fill('AAAA');
    await page.waitForTimeout(500);
    const text = await page.evaluate(() => {
      const empty = document.querySelector('.bill-list-empty');
      return empty?.textContent?.trim();
    });
    const passed = text === '没有匹配的账单,换个关键词试试。';
    results.push({ test: 'F_text_literal', text, passed });
  }

  // ============ Test G: clear search → 账单列表恢复 ============
  console.log('\n[Test G] clear search → 账单列表恢复');
  {
    const searchInput = await page.locator('.bills-search-input').first();
    await searchInput.fill('XXXX');
    await page.waitForTimeout(300);
    const beforeClear = await page.evaluate(() => ({
      emptyVisible: !!document.querySelector('.bill-list-empty'),
      dayGroups: document.querySelectorAll('.day-group').length
    }));
    await searchInput.fill('');
    await page.waitForTimeout(500);
    const afterClear = await page.evaluate(() => ({
      emptyVisible: !!document.querySelector('.bill-list-empty'),
      dayGroups: document.querySelectorAll('.day-group').length
    }));
    const passed = beforeClear.emptyVisible === true
      && beforeClear.dayGroups === 0
      && afterClear.emptyVisible === false
      && afterClear.dayGroups > 0;
    results.push({ test: 'G_clear_recovers_list', beforeClear, afterClear, passed });
    await page.screenshot({ path: path.join(VERIFY_DIR, '05-test-G-cleared.png') });
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