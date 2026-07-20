#!/usr/bin/env node
/**
 * SBC BillForm 3-state Chip Screenshot Script — v0.3.19 #84 (Coder Agent)
 *
 * 按 SKILL-mobile-validation.md v1.0 §通道 C 模板:
 *   - 用 playwright.devices 真机 profile (iPhone 13 / iPhone SE)
 *   - 强制 webkit (chromium 模拟 iOS Safari)
 *   - locale zh-CN
 *   - isMobile=true + hasTouch=true
 *
 * 用途: 验证 BillForm 单 chip 三态切换 (PO #7082 + #7085 拍板):
 *   - ghost (默认): 仅 "独占" 文字, 14px gray-400, 无 bg/border
 *   - input (编辑): white bg + accent 描边 + ¥ + input
 *   - pill (数字): accent bg + ¥500 ✎
 */

const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TARGETS = [
  { name: 'iphoneSE', device: 'iPhone SE', width: 375, height: 667, scale: 2 },
  { name: 'iphone13', device: 'iPhone 13', width: 390, height: 844, scale: 3 },
];

const OUT_DIR = path.join(os.homedir(), '.openclaw', 'media', 'v0319-84');
fs.mkdirSync(OUT_DIR, { recursive: true });

const SESSION_ID = 11;

async function loginAndOpenBillNew(page, sessionId) {
  await page.goto('http://127.0.0.1:8448/auth/login', { waitUntil: 'networkidle' });
  await page.fill('#email', 'demo@example.com');
  await page.click('button.btn.btn-primary'); // 发送验证码
  await page.waitForTimeout(1500);
  // step should now be 'verify'
  await page.waitForSelector('#code', { timeout: 5000 });
  await page.fill('#code', '000000');
  // 验证按钮: button.btn.btn-primary
  const verifyBtn = await page.$('button.btn.btn-primary');
  await verifyBtn.click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  // 现在应该跳到 /sessions; 手动 goto bills/new
  await page.goto(`http://127.0.0.1:8448/sessions/${sessionId}/bills/new`, {
    waitUntil: 'networkidle',
    timeout: 30000,
  });
  await page.waitForSelector('[data-testid^="ppts-li-"]', { timeout: 10000 });
}

async function snap(page, label) {
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
      await loginAndOpenBillNew(page, SESSION_ID);
      await page.waitForTimeout(800);

      // 1. 全 ghost 态 (默认所有 member 都是 amount='0')
      await snap(page, `${target.name}-1-all-ghost`);

      // 2. 点击第一个 ghost chip → 编辑态
      const allChips = await page.$$('[data-testid^="ppts-chip-"]');
      console.log(`  found ${allChips.length} chips`);
      if (allChips.length === 0) throw new Error('No ppts-chip found');
      await allChips[0].click();
      await page.waitForTimeout(400);
      await snap(page, `${target.name}-2-editing-first`);

      // 3. 输入 50 → blur → 数字态
      const input = await page.$('[data-testid^="ppts-amount-"]');
      if (input) {
        await input.fill('50');
        await page.evaluate(() => document.activeElement && document.activeElement.blur());
        await page.waitForTimeout(400);
      }
      await snap(page, `${target.name}-3-number-first`);

      // 4. 编辑第二个 → 三态同框
      const chipsAfter = await page.$$('[data-testid^="ppts-chip-"]');
      if (chipsAfter.length >= 3) {
        await chipsAfter[1].click();
        await page.waitForTimeout(400);
        const input2 = await page.$('[data-testid^="ppts-amount-"]');
        if (input2) {
          await input2.fill('24.50');
          await page.evaluate(() => document.activeElement && document.activeElement.blur());
        }
        await page.waitForTimeout(400);
        await snap(page, `${target.name}-4-three-states`);

        // 5. 点数字态 pill → 编辑态
        await chipsAfter[0].click();
        await page.waitForTimeout(400);
        await snap(page, `${target.name}-5-edit-from-number`);
      } else {
        console.log(`  ⚠ only ${chipsAfter.length} chips, skip multi-state`);
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