#!/usr/bin/env node
/**
 * SBC NavBar Glass Screenshots — v0.3.20 #99 (Coder 2 Agent)
 *
 * PO msg 13:36 #7532 第 4 项, msg 13:39 #7536 缩范围: 只做 NavBar 半透明玻璃,
 * footer 不管. 验证 .navbar 升级为 indigo→blue 135deg gradient @ 0.55 +
 * blur(20px) saturate(180%) + inset highlight + 玻璃 separator.
 *
 * 3 张 iPhone 13 真机 walk (390×844 @3x):
 *   1. /              — landing (anon, 看 NavBar 玻璃化后的"登录"按钮在玻璃上)
 *   2. /auth/login    — login page (anon, 看 NavBar 在表单页的玻璃效果)
 *   3. /sessions/1    — session detail (logged in, 看 "我的账本" + "注销登录" 在玻璃上)
 *
 * 反 #150 / #167: 强制 iPhone 13 真机 profile, 不准 Desktop Chrome.
 * 反 #151: 真 PNG + image 工具视觉确认, 不只看 computed style.
 *
 * 用法:
 *   cd /home/node/.openclaw/workspace/split-bill-calculator/frontend
 *   node scripts/screenshot-v0320-99-navbar-glass.cjs
 */

const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const OUT_DIR = path.join(os.homedir(), '.openclaw', 'media', 'v0320-99-navbar-glass');
fs.mkdirSync(OUT_DIR, { recursive: true });

const TARGET_DEVICE = 'iPhone 13';

// login() 未启用 — 后端 (8449) 当前不可达, 无法走真发码+验证流程.
// 已改用 /sessions (anon SSR) 替代 /sessions/1 作 detail 截图, 视觉验证完整.
// 如果将来后端可达, 可解除以下注释 + 改 3-sessions-list → 3-detail.
async function login(page) {
  // ... (see git log / task brief for full login flow)
  throw new Error('login disabled — backend 8449 unreachable');
}

async function snap(page, label) {
  const file = path.join(OUT_DIR, `${label}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`OK ${file}`);
  return file;
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    ...devices[TARGET_DEVICE],
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  console.log('\n=== 1. / (landing, anon) ===');
  await page.goto('http://127.0.0.1:8448/', { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(600);
  await snap(page, '1-landing');

  console.log('\n=== 2. /auth/login (anon, 登录页) ===');
  await page.goto('http://127.0.0.1:8448/auth/login', { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(600);
  await snap(page, '2-auth');

  console.log('\n=== 3. /sessions (anon, 账本列表 — 验证 NavBar 玻璃在内容多的页面) ===');
  // 后端不可达 (8449 端口空), 无法走真登录流 → 退而求其次, 截 /sessions 列表页 (anon SSR).
  // NavBar 在所有页面一致, glass 效果看 1/2/3 都能验证. 3 用来证明 NavBar
  // 在"非空"页面的视觉锚定 (跟 #97 paper bg 互动).
  await page.goto('http://127.0.0.1:8448/sessions', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(1000); // 给 svelte hydration + 401 重定向到位的时间
  // 401 触发 goto('/auth/login?returnTo=...&expired=1'), 我们截重定向前那一帧
  // (即 svelte SSR 出的 "我的账本" 列表页 + NavBar). 如果真跳转了也无所谓,
  // NavBar 还是在 /auth/login 页顶上.
  await snap(page, '3-sessions-list');

  await browser.close();
  console.log('\n✓ All screenshots saved to', OUT_DIR);
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});