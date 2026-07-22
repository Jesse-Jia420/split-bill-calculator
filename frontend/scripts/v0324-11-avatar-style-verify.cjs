#!/usr/bin/env node
/**
 * v0.3.24 #11 — UAT bug settle 页头像样式跟成员 section 一致
 *
 * 验证 SettleMemberBreakdown.svelte .chip-avatar (36×36) 套 #132 Option B 玻璃:
 *   - backdrop-filter: blur(4px) saturate(180%)
 *   - box-shadow 含 inset (4-layer glass shadow)
 *   - background: linear-gradient(... rgba(..., 0.88) ...) (palette 渐变保留)
 *
 * 测试路径: iPhone 13 真机, /sessions/1/settle, 2 个 tab (概览 + 个人视图)
 *   - 概览 tab: SettleTransferPath .avatar (32×32, 已在 #132 改过, 仅 sanity check)
 *   - 个人视图 tab: SettleMemberBreakdown .chip-avatar (36×36, 本次 #11 改)
 */
const { chromium, devices } = require('playwright');
const fs = require('fs');

const BASE = 'http://172.18.0.5:8448';
const SCREENSHOT_DIR = '/home/node/.openclaw/media/browser/v0324-11-avatar-style';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-CN' });
  const page = await ctx.newPage();

  // Login
  await page.request.post(`${BASE}/auth/send-code`, {
    data: { email: 'xinhua1001@outlook.com' },
    headers: { 'Content-Type': 'application/json' },
  });
  await page.request.post(`${BASE}/auth/verify-code`, {
    data: { email: 'xinhua1001@outlook.com', code: '000000' },
    headers: { 'Content-Type': 'application/json' },
  });

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // ==========================================================================
  // Tab 1: 概览 (overview) — SettleTransferPath .avatar (32×32, #132 已改)
  // ==========================================================================
  await page.goto(`${BASE}/sessions/1/settle`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-overview-tab-default.png`, fullPage: false });

  // SettleTransferPath avatar 是 .avatar (32×32) — 概览 tab 主要 avatar
  const overviewAvatarStyles = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('.avatar'));
    const samples = [];
    for (const el of all.slice(0, 3)) {
      const cs = getComputedStyle(el);
      samples.push({
        backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter,
        boxShadow: cs.boxShadow,
        background: cs.backgroundImage || cs.background,
        width: cs.width,
        height: cs.height,
        rect: el.getBoundingClientRect(),
      });
    }
    return samples;
  });
  console.log('#11 Tab 1 (概览) SettleTransferPath .avatar (32×32) 前 3 个:');
  console.log(JSON.stringify(overviewAvatarStyles, null, 2));

  // ==========================================================================
  // Tab 2: 个人视图 (personal) — SettleMemberBreakdown .chip-avatar (36×36, #11 新改)
  // ==========================================================================
  // IosSwitch 选项 "个人视图" button — 通过 text content 找
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const personalBtn = btns.find(b => b.textContent?.trim() === '个人视图');
    if (personalBtn) personalBtn.click();
  });
  await page.waitForTimeout(1500);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-personal-tab-default.png`, fullPage: false });

  // SettleMemberBreakdown avatar 是 .chip-avatar (36×36) — 个人视图 tab 顶部成员选择器
  const personalAvatarStyles = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('.chip-avatar'));
    const samples = [];
    for (const el of all.slice(0, 5)) {
      const cs = getComputedStyle(el);
      samples.push({
        backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter,
        boxShadow: cs.boxShadow,
        background: cs.backgroundImage || cs.background,
        width: cs.width,
        height: cs.height,
        border: cs.border,
        inlineStyle: el.getAttribute('style'),
        rect: { x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y, w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height },
      });
    }
    return { total: all.length, samples };
  });
  console.log('\n#11 Tab 2 (个人视图) SettleMemberBreakdown .chip-avatar (36×36) 总数:', personalAvatarStyles.total);
  console.log(JSON.stringify(personalAvatarStyles, null, 2));

  // ==========================================================================
  // Tab 2 sub: view=primary (主币种汇总) — 默认就是 primary
  // ==========================================================================
  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-personal-tab-view-primary.png`, fullPage: false });

  // ==========================================================================
  // Tab 2 sub: view=split (原始数据) — 仅多币种 session 可切 (session 1 泰国测试账单是单币种, 跳过)
  // ==========================================================================
  // 检查 session.currencies.length, 若只有 1 个币种则 split option disabled, 不切
  const hasSplitOption = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.some(b => b.textContent?.trim() === '原始数据' && !b.disabled);
  });
  console.log('\n#11 split option enabled:', hasSplitOption);

  // 04: zoomed screenshot of chip-avatar strip (顶部成员选择器)
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  const chipStrip = await page.evaluate(() => {
    const wrapper = document.querySelector('.member-tabs-wrapper');
    if (!wrapper) return null;
    const r = wrapper.getBoundingClientRect();
    return { x: Math.max(0, r.x - 10), y: Math.max(0, r.y - 10), width: r.width + 20, height: r.height + 20 };
  });
  if (chipStrip) {
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/04-chip-avatar-zoom.png`,
      clip: chipStrip,
    });
    console.log('\nSaved chip-avatar zoomed screenshot');
  }

  // ==========================================================================
  // 校验: chip-avatar glass 风格检查
  // ==========================================================================
  const checks = {
    'chip-avatar count >= 2': personalAvatarStyles.total >= 2,
    'chip-avatar backdrop-filter 含 blur': personalAvatarStyles.samples.every(s => s.backdropFilter?.includes('blur')),
    'chip-avatar backdrop-filter 含 saturate': personalAvatarStyles.samples.every(s => s.backdropFilter?.includes('saturate')),
    // 'me' chip 默认被选中, box-shadow 被 me double ring 覆盖 (无 inset) — 这是设计预期.
    // 只要求 ≥ half (即非 me chips) 有 inset glass shadow.
    'chip-avatar box-shadow 含 inset (非 me)': personalAvatarStyles.samples.filter(s => !s.boxShadow?.includes('rgb(29, 78, 216)')).every(s => s.boxShadow?.includes('inset')),
    'chip-avatar background 是 linear-gradient': personalAvatarStyles.samples.every(s => s.background?.includes('linear-gradient')),
    'chip-avatar background 含 rgba': personalAvatarStyles.samples.every(s => s.background?.includes('rgba')),
    'chip-avatar width = 36px': personalAvatarStyles.samples.every(s => s.width === '36px'),
    'chip-avatar inline style 有 avatarGradient': personalAvatarStyles.samples.every(s => s.inlineStyle?.includes('linear-gradient')),
    'overview SettleTransferPath .avatar glass': overviewAvatarStyles.every(s => s.backdropFilter?.includes('blur') && s.boxShadow?.includes('inset')),
  };
  console.log('\n=== Summary ===');
  let pass = 0, fail = 0;
  for (const [k, v] of Object.entries(checks)) {
    console.log(`${v ? '✓' : '✗'} ${k}`);
    if (v) pass++; else fail++;
  }
  console.log(`\n${pass}/${pass+fail} checks pass`);

  await browser.close();
  if (fail > 0) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });