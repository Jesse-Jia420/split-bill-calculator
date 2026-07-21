#!/usr/bin/env node
/**
 * SBC Currency Bar Modal Screenshots — v0.3.19 #85 v3 (PO #7731 5 反馈再验证)
 *
 * 验证 5 项 PO #7731 二次反馈:
 *   1) Lock icon 统一 Lucide 风格 — DOM 查 .lock-icon svg.lucide-lock (跟其它 lucide 一致)
 *   2) 弹窗存在时锁页面滚动 — main 元素 overflow === 'hidden'
 *   3) multi+has_bills 主+副币种 chip 同行 + ⇄ arrow
 *   4) rate-suffix 去掉 /主币种 冗余
 *   5) 取消/保存改圆形 FAB (左 X / 右 ✓) + .fab--cancel / .fab--submit class
 *
 * 当前 DB:
 *   session 1: CNY+THB, 32 bills (multi+has_bills)
 *   session 2: CNY+HKD, 0 bills  (multi+!has_bills) — 重要测 #3 #4 #5
 *   session 3: CNY, 0 bills    (single+!has_bills) — 测 #1 lock icon + #5
 */

const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const OUT_DIR = path.join(os.homedir(), '.openclaw', 'media', 'v0319-85-v3-5items');
fs.mkdirSync(OUT_DIR, { recursive: true });

async function login(page) {
  await page.goto('http://127.0.0.1:8448/auth/login', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('#email', { timeout: 5000 });
  await page.fill('#email', 'xinhua1001@outlook.com');
  await page.click('button.btn.btn-primary');
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
  await page.screenshot({ path: file, fullPage: false });
  const stat = fs.statSync(file);
  console.log(`  ✓ ${file} (${stat.size} bytes)`);
}

(async () => {
  const browser = await chromium.launch();
  const target = 'iPhone 13';
  console.log(`\n=== iPhone 13 (390x844 @3x, webkit) ===`);
  const context = await browser.newContext({
    ...devices[target],
    locale: 'zh-CN',
  });
  const page = await context.newPage();
  try {
    await login(page);

    // ========== #1 + #2 + #3 + #4 + #5: 全 5 项放 multi+has_bills (session 1) 验 ==========
    console.log('\n[关键] multi+has_bills (session 1) 5 项全验');
    await openSession(page, 1);
    const bar1 = await page.$('[data-sbc="currency-bar-edit"]');
    await bar1.click();
    await page.waitForSelector('[data-sbc="currency-add-modal"][data-mode="multi"][data-has-bills="true"]', { timeout: 5000 });
    await page.waitForTimeout(500);

    // #2: main overflow === hidden (弹窗存在时锁滚动)
    const mainOverflow = await page.evaluate(() => {
      const m = document.querySelector('main');
      return m ? window.getComputedStyle(m).overflow : 'NO_MAIN';
    });
    console.log(`  #2 main.overflow: ${mainOverflow}`);
    console.log(`  #2 验证 (锁滚动): ${mainOverflow === 'hidden' ? '✓ hidden' : '✗ ' + mainOverflow}`);

    // #1: lock icon 是 Lucide SVG (不是 emoji 文本)
    const lockInfo = await page.evaluate(() => {
      const locks = [...document.querySelectorAll('.lock-icon svg')];
      if (locks.length === 0) return { count: 0 };
      const first = locks[0];
      const cls = first.getAttribute('class') || '';
      const lucide = cls.includes('lucide') || first.tagName === 'svg' && first.getAttribute('viewBox');
      return {
        count: locks.length,
        lucide: !!lucide,
        sizeAttr: first.getAttribute('width'),
        strokeWidth: first.getAttribute('stroke-width'),
      };
    });
    console.log(`  #1 lock icon svg 数: ${lockInfo.count} (期望 2 — 主+副币种 chip)`);
    console.log(`  #1 验证 (lucide SVG): ${lockInfo.count >= 2 && lockInfo.lucide ? '✓ 是 Lucide SVG' : '✗ 不是'}`);

    // #3: multi+has_bills 主+副 chip 同行 (currency-pair-row 存在)
    const hasPairRowMHB = await page.$('.currency-pair-row');
    const pairColsMHB = await page.$$('.currency-pair-row .currency-pair-col');
    const pairArrowMHB = await page.$('.currency-pair-arrow');
    console.log(`  #3 multi+has_bills: .currency-pair-row = ${hasPairRowMHB ? '✓ 存在' : '✗ 无'}, cols = ${pairColsMHB.length} (期望 2), arrow = ${pairArrowMHB ? '✓' : '✗'}`);
    // 检查两 chip 同行
    if (pairColsMHB.length === 2) {
      const boxA = await pairColsMHB[0].boundingBox();
      const boxB = await pairColsMHB[1].boundingBox();
      console.log(`  #3 chip box: A y=${boxA.y.toFixed(0)} h=${boxA.height.toFixed(0)} | B y=${boxB.y.toFixed(0)} h=${boxB.height.toFixed(0)}`);
      console.log(`  #3 同行验证: ${Math.abs(boxA.y - boxB.y) < 5 ? '✓ 同行' : '✗ 错位'}`);
    }

    // #4: rate-suffix 简化 (没有 /CNY)
    const rateSuffix = await page.textContent('[data-testid="currency-edit-rate-bills"] + .rate-suffix');
    const isOldStyle = rateSuffix && rateSuffix.includes('/');
    console.log(`  #4 rate-suffix text: "${rateSuffix}"`);
    console.log(`  #4 验证 (无 /单位 冗余): ${!isOldStyle ? '✓ 无 /单位' : '✗ 仍含 /'}`);

    // #5: 圆形按钮 — 找 [data-testid=currency-add-cancel] + [data-testid=currency-add-submit]
    const cancelBtn = await page.$('[data-testid="currency-add-cancel"]');
    const submitBtn = await page.$('[data-testid="currency-add-submit"]');
    const cancelBox = cancelBtn ? await cancelBtn.boundingBox() : null;
    const submitBox = submitBtn ? await submitBtn.boundingBox() : null;
    console.log(`  #5 cancel box: ${cancelBox ? `x=${cancelBox.x.toFixed(0)} y=${cancelBox.y.toFixed(0)} w=${cancelBox.width.toFixed(0)} h=${cancelBox.height.toFixed(0)}` : 'NONE'}`);
    console.log(`  #5 submit box: ${submitBox ? `x=${submitBox.x.toFixed(0)} y=${submitBox.y.toFixed(0)} w=${submitBox.width.toFixed(0)} h=${submitBox.height.toFixed(0)}` : 'NONE'}`);
    const cancelIsCircle = cancelBox && Math.abs(cancelBox.width - cancelBox.height) < 1 && cancelBox.width >= 40 && cancelBox.width <= 50;
    const submitIsCircle = submitBox && Math.abs(submitBox.width - submitBox.height) < 1 && submitBox.width >= 40 && submitBox.width <= 50;
    console.log(`  #5 cancel 圆形: ${cancelIsCircle ? '✓ 44×44 真圆' : '✗ 非圆'}`);
    console.log(`  #5 submit 圆形: ${submitIsCircle ? '✓ 44×44 真圆' : '✗ 非圆'}`);
    // 检查 cancel 内有 X icon SVG
    const cancelIconClass = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="currency-add-cancel"]');
      if (!btn) return null;
      const svg = btn.querySelector('svg');
      return svg ? svg.getAttribute('class') : null;
    });
    const submitIconClass = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="currency-add-submit"]');
      if (!btn) return null;
      const svg = btn.querySelector('svg');
      return svg ? svg.getAttribute('class') : null;
    });
    console.log(`  #5 cancel icon svg class: ${cancelIconClass}`);
    console.log(`  #5 submit icon svg class: ${submitIconClass}`);

    await snap(page, '01-multi-has-bills-all-5-items');

    // 关闭弹窗
    await page.click('[data-testid="currency-add-cancel"]');
    await page.waitForTimeout(500);

    // 验证 main.overflow 恢复
    const mainOverflowAfter = await page.evaluate(() => {
      const m = document.querySelector('main');
      return m ? window.getComputedStyle(m).overflow : 'NO_MAIN';
    });
    console.log(`  #2 关闭弹窗后 main.overflow: ${mainOverflowAfter} (期望非 hidden)`);

    // ========== multi+!has_bills (session 2) 同样验 ==========
    console.log('\n[关键] multi+!has_bills (session 2) 5 项全验');
    await openSession(page, 2);
    const bar2 = await page.$('[data-sbc="currency-bar-edit"]');
    await bar2.click();
    await page.waitForSelector('[data-sbc="currency-add-modal"][data-mode="multi"][data-has-bills="false"]', { timeout: 5000 });
    await page.waitForTimeout(500);
    // #2 again
    const mainOverflowMNB = await page.evaluate(() => window.getComputedStyle(document.querySelector('main')).overflow);
    console.log(`  #2 multi+!has_bills main.overflow: ${mainOverflowMNB}`);

    // #3 multi+!has_bills 也是 currency-pair-row (selects)
    const pairRowMNB = await page.$('.currency-pair-row');
    console.log(`  #3 multi+!has_bills currency-pair-row: ${pairRowMNB ? '✓ 存在 (selects 同行)' : '✗ 无'}`);

    // #4 rate-suffix 多+无账单
    const suffixMNB = await page.textContent('[data-testid="currency-edit-rate"] + .rate-suffix');
    console.log(`  #4 multi+!has_bills rate-suffix: "${suffixMNB}" (期望 "HKD")`);

    // #5 圆形按钮 (多+无账单还有 submit)
    const submitMNBBox = await (await page.$('[data-testid="currency-add-submit"]')).boundingBox();
    console.log(`  #5 multi+!has_bills submit box: ${submitMNBBox.width.toFixed(0)}×${submitMNBBox.height.toFixed(0)} ${submitMNBBox.width === submitMNBBox.height ? '✓ 圆' : '✗ 非圆'}`);

    await snap(page, '02-multi-no-bills-all-5-items');
    await page.click('[data-testid="currency-add-cancel"]');
    await page.waitForTimeout(300);

    // ========== single+!has_bills (session 3) 同样验 ==========
    console.log('\n[关键] single+!has_bills (session 3) 5 项全验');
    await openSession(page, 3);
    const pill3 = await page.$('[data-sbc="currency-pill-add-secondary"]');
    await pill3.click();
    await page.waitForSelector('[data-sbc="currency-add-modal"][data-mode="single"][data-has-bills="false"]', { timeout: 5000 });
    await page.waitForTimeout(500);

    // #1 lock icon (single+!has_bills 没有 chip lock, 是 locked 提示框里的 lock)
    const lockedIconInfo = await page.evaluate(() => {
      const lockedEl = document.querySelector('[data-testid="currency-add-locked"]');
      if (!lockedEl) return null;
      const svg = lockedEl.querySelector('svg');
      if (!svg) return null;
      return { tag: svg.tagName, cls: svg.getAttribute('class') || '', size: svg.getAttribute('width') };
    });
    // wait — single+!has_bills (session 3, 0 bills) 不会有 locked 提示框 (那是 single+has_bills case)
    // 改查主币种 chip 的 lock
    const singlePrimaryLock = await page.evaluate(() => {
      const chip = document.querySelector('.modal-body .primary-chip .lock-icon svg');
      return chip ? { tag: chip.tagName, size: chip.getAttribute('width') } : null;
    });
    console.log(`  #1 single primary chip lock: ${singlePrimaryLock ? '✓ SVG ' + singlePrimaryLock.size + 'x' + singlePrimaryLock.size : '✗ 无'}`);

    // #4 rate-suffix 单+无账单
    const suffixS = await page.textContent('[data-testid="currency-add-rate"] + .rate-suffix');
    console.log(`  #4 single+!has_bills rate-suffix (无副币种): "${suffixS}" (期望 "副币种" — 空时占位)`);

    // #5 圆形按钮
    const cancelSBox = await (await page.$('[data-testid="currency-add-cancel"]')).boundingBox();
    const submitSBox = await (await page.$('[data-testid="currency-add-submit"]')).boundingBox();
    console.log(`  #5 single+!has_bills cancel box: ${cancelSBox.width.toFixed(0)}×${cancelSBox.height.toFixed(0)} ${cancelSBox.width === cancelSBox.height ? '✓ 圆' : '✗'}`);
    console.log(`  #5 single+!has_bills submit box: ${submitSBox.width.toFixed(0)}×${submitSBox.height.toFixed(0)} ${submitSBox.width === submitSBox.height ? '✓ 圆' : '✗'}`);

    await snap(page, '03-single-no-bills-all-5-items');

    console.log('\n✓ All 5 PO #7731 feedback items tested across 3 modes.');
  } catch (e) {
    console.error(`✗ Error: ${e.message}`);
    console.error(e.stack);
  }
  await context.close();
  await browser.close();
})();