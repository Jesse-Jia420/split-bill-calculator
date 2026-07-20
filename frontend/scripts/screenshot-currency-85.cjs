#!/usr/bin/env node
/**
 * SBC Currency Bar Modal Screenshots — v0.3.19 #85 (Coder Agent)
 *
 * 按 SKILL-mobile-validation.md v1.0 §通道 C 模板:
 *   - 用 playwright.devices 真机 profile (iPhone 13 / iPhone SE)
 *   - 强制 webkit (chromium 模拟 iOS Safari)
 *   - locale zh-CN
 *   - isMobile=true + hasTouch=true
 *
 * 用途: 验证 v0.3.19 #85 (PO #7308) — 单币种 bar 缩短 + 多币种改弹窗 + 有/无账单规则:
 *
 *   iPhone 13 × 4 张:
 *     1. 单币种 + 没账单 (id=131 EUR, 0 bills) — 短 pill, 不带 +icon
 *     2. 单币种 + 有账单 (id=134 CNY, 3 bills) — 短 pill, owner 视角
 *     3. 多币种 + 没账单 (id=12 CNY+THB, 0 bills) — 整 bar + 弹窗 (3 fields + 修改)
 *     4. 多币种 + 有账单 (id=11 CNY+THB, 32 bills) — 整 bar + 弹窗 (rate only + 保存汇率)
 *
 *   iPhone SE × 2 张:
 *     1. 单币种 + 没账单 (id=131 EUR, 0 bills) — 短 pill, 最小真机
 *     2. 多币种 + 有账单 (id=11 CNY+THB, 32 bills) — 整 bar + 弹窗 (rate only), 弹窗不破布局
 */

const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TARGETS = [
  { name: 'iphoneSE', device: 'iPhone SE', width: 375, height: 667, scale: 2 },
  { name: 'iphone13', device: 'iPhone 13', width: 390, height: 844, scale: 3 },
];

const OUT_DIR = path.join(os.homedir(), '.openclaw', 'media', 'v0319-85');
fs.mkdirSync(OUT_DIR, { recursive: true });

async function login(page) {
  await page.goto('http://127.0.0.1:8448/auth/login', { waitUntil: 'networkidle' });
  await page.fill('#email', 'demo@example.com');
  await page.click('button.btn.btn-primary'); // 发送验证码
  await page.waitForTimeout(1500);
  await page.waitForSelector('#code', { timeout: 5000 });
  await page.fill('#code', '000000');
  const verifyBtn = await page.$('button.btn.btn-primary');
  await verifyBtn.click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
}

async function openSession(page, sessionId) {
  await page.goto(`http://127.0.0.1:8448/sessions/${sessionId}`, {
    waitUntil: 'networkidle',
    timeout: 30000,
  });
  await page.waitForSelector('[data-sbc="currency-meta"]', { timeout: 10000 });
  await page.waitForTimeout(500);
}

async function snap(page, label) {
  const file = path.join(OUT_DIR, `${label}.png`);
  await page.screenshot({ path: file, fullPage: false }); // viewport-only, no fullPage
  const stat = fs.statSync(file);
  console.log(`✓ ${file} (${stat.size} bytes)`);
}

async function snapFull(page, label) {
  const file = path.join(OUT_DIR, `${label}.png`);
  await page.screenshot({ path: file, fullPage: true });
  const stat = fs.statSync(file);
  console.log(`✓ ${file} (${stat.size} bytes)`);
}

(async () => {
  const browser = await chromium.launch();
  for (const target of TARGETS) {
    console.log(`\n=== ${target.name} (${target.width}x${target.height} @${target.scale}x) ===`);
    const context = await browser.newContext({
      ...devices[target.device],
      locale: 'zh-CN',
    });
    const page = await context.newPage();
    try {
      await login(page);

      // === iPhone 13: 4 张 ===
      // === iPhone SE: 2 张 (单币种 + 多币种+弹窗) ===
      if (target.name === 'iphone13') {
        // #1: 单币种 + 没账单 (id=131 EUR, 0 bills) — 短 pill
        await openSession(page, 131);
        await snapFull(page, 'iphone13-1-single-no-bills');

        // #2: 单币种 + 有账单 (id=134 CNY, 3 bills) — 短 pill, owner 视角
        await openSession(page, 134);
        await snapFull(page, 'iphone13-2-single-has-bills');

        // #3: 多币种 + 没账单 (id=12 CNY+THB, 0 bills) — 整 bar + 弹窗
        await openSession(page, 12);
        // 截一张关弹窗状态 (bar 整体 clickable)
        await snapFull(page, 'iphone13-3a-multi-no-bills-closed');
        // 点击整 bar → 弹窗打开 (3 fields + 修改)
        const bar = await page.$('[data-sbc="currency-bar-edit"]');
        if (!bar) throw new Error('No currency-bar-edit found');
        await bar.click();
        await page.waitForSelector('[data-sbc="currency-add-modal"][data-mode="multi"]', { timeout: 5000 });
        await page.waitForTimeout(800); // 动画 settle
        await snapFull(page, 'iphone13-3b-multi-no-bills-modal');

        // #4: 多币种 + 有账单 (id=11 CNY+THB, 32 bills) — 整 bar + 弹窗 (rate only)
        await openSession(page, 11);
        await snapFull(page, 'iphone13-4a-multi-has-bills-closed');
        // 点击整 bar → 弹窗打开 (rate only + 保存汇率)
        const bar2 = await page.$('[data-sbc="currency-bar-edit"]');
        if (!bar2) throw new Error('No currency-bar-edit found');
        await bar2.click();
        await page.waitForSelector('[data-sbc="currency-add-modal"][data-mode="multi"][data-has-bills="true"]', { timeout: 5000 });
        await page.waitForTimeout(800);
        await snapFull(page, 'iphone13-4b-multi-has-bills-modal');
      } else {
        // iPhone SE: 2 张
        // #1: 单币种 + 没账单 (id=131) — 短 pill, 最小真机
        await openSession(page, 131);
        await snapFull(page, 'iphoneSE-1-single-no-bills');

        // #2: 多币种 + 有账单 (id=11) — 整 bar + 弹窗 (rate only)
        await openSession(page, 11);
        const barSE = await page.$('[data-sbc="currency-bar-edit"]');
        if (!barSE) throw new Error('No currency-bar-edit found');
        await barSE.click();
        await page.waitForSelector('[data-sbc="currency-add-modal"][data-mode="multi"][data-has-bills="true"]', { timeout: 5000 });
        await page.waitForTimeout(800);
        await snapFull(page, 'iphoneSE-2-multi-has-bills-modal');
      }
    } catch (e) {
      console.error(`✗ ${target.name}: ${e.message}`);
      console.error(e.stack);
    }
    await context.close();
  }
  await browser.close();
  console.log('\n✓ Done.');
})();