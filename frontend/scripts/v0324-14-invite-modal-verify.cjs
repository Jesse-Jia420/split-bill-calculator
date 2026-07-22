#!/usr/bin/env node
/**
 * v0.3.24 #14 — UAT bug 邀请链接按钮改 confirm modal — 验证脚本
 *
 * 反 #150: Master 自写自验 — 真机 walk, 不只是 HTTP 200
 * 反 #162: §11 sync 与 fix commit 同 batch
 * 反 #167: iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
 * 反 #170: 不在本脚本里写代码, 只验证
 * 反 #189: SPEC append 用 heredoc
 * 反 #151: 真 PNG + image tool 视觉确认
 *
 * 验证 5 项:
 *   1. 登录 → /sessions/1
 *   2. click invite-btn → modal 显示
 *   3. modal 文案两段:
 *      - 含 "已复制此账本链接"
 *      - 含 "请妥善保管此链接"
 *   4. "知道了" 按钮显示
 *   5. click "知道了" → modal 消失 (不再 DOM)
 */
const { chromium, devices } = require('playwright');
const fs = require('fs');

const BASE = 'http://172.18.0.5:8448';
const SCREENSHOT_DIR = '/home/node/.openclaw/media/browser/v0324-14-invite-modal';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();

  // 1. Login via BE API + cookie jar
  await page.request.post(`${BASE}/auth/send-code`, {
    data: { email: 'demo@example.com' },
    headers: { 'Content-Type': 'application/json' },
  });
  await page.request.post(`${BASE}/auth/verify-code`, {
    data: { email: 'demo@example.com', code: '000000' },
    headers: { 'Content-Type': 'application/json' },
  });

  // 2. /sessions/1
  await page.goto(`${BASE}/sessions/1`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);  // 等玻璃背景渲染稳定

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // 截图: 邀请按钮初始态
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/01-before-click.png`,
    fullPage: false,
  });

  // 3. click 邀请按钮 → modal 显示
  await page.locator('[data-testid="invite-btn"]').click();
  await page.waitForTimeout(400);  // 等 modal 渲染 + 动画

  // 4. 检查 modal DOM
  const modalVisible = await page
    .locator('[data-testid="invite-confirm-modal"]')
    .isVisible()
    .catch(() => false);
  const modalText = await page
    .locator('[data-testid="invite-confirm-msg"]')
    .textContent()
    .catch(() => null);
  const confirmBtnVisible = await page
    .locator('[data-testid="invite-confirm-btn"]')
    .isVisible()
    .catch(() => false);
  const confirmBtnText = await page
    .locator('[data-testid="invite-confirm-btn"]')
    .textContent()
    .catch(() => null);

  console.log(`modal visible: ${modalVisible} (期望 true)`);
  console.log(`modal text: "${modalText}"`);
  console.log(`confirm btn visible: ${confirmBtnVisible} (期望 true)`);
  console.log(`confirm btn text: "${confirmBtnText}" (期望 "知道了")`);

  // 截图: modal 显示中
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/02-modal-shown.png`,
    fullPage: false,
  });

  // 文案断言
  const hasTextLine1 = (modalText ?? '').includes('已复制此账本链接');
  const hasTextLine2 = (modalText ?? '').includes('请妥善保管此链接');

  console.log(`文案含 "已复制此账本链接": ${hasTextLine1}`);
  console.log(`文案含 "请妥善保管此链接": ${hasTextLine2}`);

  // 5. click 知道了 → modal 消失
  await page.locator('[data-testid="invite-confirm-btn"]').click();
  await page.waitForTimeout(300);

  // 检查 modal 不再可见
  const modalCountAfter = await page
    .locator('[data-testid="invite-confirm-modal"]')
    .count();
  const modalVisibleAfter = modalCountAfter > 0
    ? await page
        .locator('[data-testid="invite-confirm-modal"]')
        .isVisible()
        .catch(() => false)
    : false;

  console.log(`modal count after close: ${modalCountAfter} (期望 0)`);
  console.log(`modal visible after close: ${modalVisibleAfter} (期望 false)`);

  // 截图: modal 关闭后
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/03-after-close.png`,
    fullPage: false,
  });

  // 总结
  const checks = {
    'modal 显示': modalVisible,
    'modal 文案含 "已复制此账本链接"': hasTextLine1,
    'modal 文案含 "请妥善保管此链接"': hasTextLine2,
    '"知道了" 按钮显示': confirmBtnVisible,
    '"知道了" 按钮文字': confirmBtnText?.trim() === '知道了',
    'click 知道了 → modal 不在 DOM (count=0)': modalCountAfter === 0,
  };
  console.log('\n=== Summary ===');
  let pass = true;
  for (const [k, v] of Object.entries(checks)) {
    console.log(`${v ? '✓' : '✗'} ${k}`);
    if (!v) pass = false;
  }

  if (!pass) process.exitCode = 1;

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
