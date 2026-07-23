#!/usr/bin/env node
/**
 * v0.3.23 #129/#130/#131 — UAT bug 1/2/5 (new) 验证脚本
 *
 * 反 #170: codeserver_exec_clean.js 写文件 (避免 8 字节 binary header 污染)
 * 反 #150 v2: Master 自己真验, 不只是 HTTP 200
 * 反 #167: iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
 *
 * 验证 3 项:
 *   #129: InviteLinkButton 删 btn-icon (📨 + ✓ 都不应有)
 *   #130: BillListGrouped .your-share color = slate-900 (黑)
 *   #131: NavBar .brand:hover color = var(--color-text) (不变)
 */
const { chromium, devices } = require('playwright');
const fs = require('fs');

const BASE = 'http://172.18.0.5:8448';
const SCREENSHOT_DIR = '/home/node/.openclaw/media/browser/v0323-129-130-131';

(async () => {
  // 1. Login via BE API + cookie jar (绕开 UI 浏览器登录 click handler 触发问题)
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();

  // Login via /auth/send-code + /auth/verify-code 获得 cookie
  await page.request.post(`${BASE}/auth/send-code`, {
    data: { email: 'xinhua1001@outlook.com' },
    headers: { 'Content-Type': 'application/json' },
  });
  await page.request.post(`${BASE}/auth/verify-code`, {
    data: { email: 'xinhua1001@outlook.com', code: '000000' },
    headers: { 'Content-Type': 'application/json' },
  });

  // 2. /sessions/1 — verify #129 + #130
  await page.goto(`${BASE}/sessions/1`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);  // 等 glass bg + group cards 渲染稳定

  // #129: invite-btn 内不应有 btn-icon
  const inviteBtnIconCount = await page.locator('[data-testid="invite-btn"] .btn-icon').count();
  const inviteBtnLabelText = await page.locator('[data-testid="invite-btn"] .btn-label').textContent();
  console.log(`#129  invite-btn .btn-icon count = ${inviteBtnIconCount} (期望 0)`);
  console.log(`#129  invite-btn .btn-label text = "${inviteBtnLabelText}"`);

  // #130: .your-share color (取第一个展开的 day-group)
  // 等待 group 展开
  await page.locator('details[open] .bill-row').first().waitFor({ timeout: 5000 }).catch(() => {});
  const yourShareColor = await page.evaluate(() => {
    const el = document.querySelector('.your-share');
    if (!el) return null;
    return getComputedStyle(el).color;
  });
  const yourShareText = await page.locator('.your-share').first().textContent().catch(() => null);
  console.log(`#130  .your-share color = ${yourShareColor} (期望 rgb(23, 23, 23) --gray-900/#171717)`);
  console.log(`#130  .your-share text = "${yourShareText}"`);

  // #131: logo SplitIt hover 色不变 (NavBar 隐藏在 landing, 走 /sessions 验)
  await page.goto(`${BASE}/sessions`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const brandColorBefore = await page.evaluate(() => {
    const el = document.querySelector('.brand');
    return el ? getComputedStyle(el).color : null;
  });
  await page.locator('.brand').hover();
  await page.waitForTimeout(300);
  const brandColorHover = await page.evaluate(() => {
    const el = document.querySelector('.brand');
    return el ? getComputedStyle(el).color : null;
  });
  console.log(`#131  .brand color before hover = ${brandColorBefore}`);
  console.log(`#131  .brand color after hover = ${brandColorHover} (期望不变)`);

  // Take screenshots
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-sessions-brand-hover.png`, fullPage: false });
  await page.goto(`${BASE}/sessions/1`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-sessions-1-invite-no-icon.png`, fullPage: false });
  // 滚到第一个 bill row 看 .your-share
  await page.locator('.bill-row').first().scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-bill-list-yourshare-black.png`, fullPage: false });

  // 总结
  const checks = {
    '#129 btn-icon count': inviteBtnIconCount === 0,
    '#130 your-share color --gray-900': yourShareColor === 'rgb(23, 23, 23)',
    '#131 brand hover 不变色': brandColorBefore === brandColorHover,
  };
  console.log('\n=== Summary ===');
  for (const [k, v] of Object.entries(checks)) console.log(`${v ? '✓' : '✗'} ${k}`);

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
