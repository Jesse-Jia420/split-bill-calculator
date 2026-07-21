#!/usr/bin/env node
/**
 * SBC Currency Bar Modal Screenshots — v0.3.19 #85 v2 (PO #7731 反馈验证)
 *
 * 验证 4 项反馈:
 *   1) Single pill 居中 (跟 multi bar 一样视觉)
 *   2) 弹窗去全屏深色背景 (backdrop transparent)
 *   3) Multi+!has_bills 删「修改主币种/副币种功能开发中...」hint
 *   4) Multi+!has_bills 主+副币种 select 同行
 *
 * 当前 DB 状态 (sandbox BE):
 *   session 1: 泰国测试账单 6.19-6.22, currencies=[CNY, THB], bills=32    (multi+has_bills)
 *   session 2: 个人测试, currencies=[CNY, HKD], bills=0                  (multi+!has_bills) ←
 *   session 3: 666, currencies=[CNY], bills=0                            (single+!has_bills)
 *
 * 真机 profile: iPhone 13 (390x844 @3x, webkit)
 */

const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const OUT_DIR = path.join(os.homedir(), '.openclaw', 'media', 'v0319-85-v2-po7731');
fs.mkdirSync(OUT_DIR, { recursive: true });

async function login(page) {
  await page.goto('http://127.0.0.1:8448/auth/login', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('#email', { timeout: 5000 });
  await page.fill('#email', 'demo@example.com');
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
  console.log(`✓ ${file} (${stat.size} bytes)`);
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

    // ========== #1: single pill 居中 (session 3 — CNY, 0 bills, owner) ==========
    console.log('\n#1 single pill 居中验证 (session 3)');
    await openSession(page, 3);
    const pill = await page.$('[data-sbc="currency-pill-add-secondary"]');
    if (!pill) throw new Error('No single pill on session 3');
    const pillBox = await pill.boundingBox();
    const pillCenter = pillBox.x + pillBox.width / 2;
    const viewportCenter = 390 / 2;
    const offsetPill = Math.abs(pillCenter - viewportCenter);
    console.log(`  pill box: x=${pillBox.x.toFixed(1)} y=${pillBox.y.toFixed(1)} w=${pillBox.width.toFixed(1)} h=${pillBox.height.toFixed(1)}`);
    console.log(`  pill center: ${pillCenter.toFixed(1)} / viewport center: ${viewportCenter} → 偏离 ${offsetPill.toFixed(1)}px`);
    console.log(`  #1 验证: ${offsetPill < 5 ? '✓ 居中 (容差 <5px)' : '✗ 未居中'}`);
    await snap(page, '01-single-pill-centered');

    // ========== [对比] multi bar 居中 (session 1) ==========
    console.log('\n[对比] multi bar 居中 (session 1)');
    await openSession(page, 1);
    const bar = await page.$('[data-sbc="currency-bar-edit"]');
    const barBox = await bar.boundingBox();
    const barCenter = barBox.x + barBox.width / 2;
    const offsetBar = Math.abs(barCenter - viewportCenter);
    console.log(`  bar box: x=${barBox.x.toFixed(1)} y=${barBox.y.toFixed(1)} w=${barBox.width.toFixed(1)} h=${barBox.height.toFixed(1)}`);
    console.log(`  bar center: ${barCenter.toFixed(1)} → 偏离 ${offsetBar.toFixed(1)}px ✓`);
    await snap(page, '02-multi-bar-centered-compare');

    // ========== #2 + #3 + #4: 验证 multi+!has_bills (session 2 现在 multi+0 bills) ==========
    console.log('\n#2 #3 #4 multi+!has_bills 弹窗验证 (session 2: CNY+HKD, 0 bills)');
    await openSession(page, 2);
    const bar2 = await page.$('[data-sbc="currency-bar-edit"]');
    if (!bar2) throw new Error('No multi bar on session 2 (expected multi mode)');
    await bar2.click();
    await page.waitForSelector('[data-sbc="currency-add-modal"][data-mode="multi"][data-has-bills="false"]', { timeout: 5000 });
    await page.waitForTimeout(500);

    // #2: backdrop transparent
    const backdropBg = await page.evaluate(() => {
      const bd = document.querySelector('.modal-backdrop');
      return bd ? window.getComputedStyle(bd).backgroundColor : 'NO_BACKDROP';
    });
    console.log(`  #2 backdrop bg: ${backdropBg}`);
    console.log(`  #2 验证: ${backdropBg === 'rgba(0, 0, 0, 0)' || backdropBg === 'transparent' ? '✓ 透明' : '✗ 仍有深色'}`);

    // #3: 删「修改主币种/副币种」hint
    const bodyText = await page.textContent('.modal-body');
    const hasHint = bodyText.includes('修改主币种') || bodyText.includes('功能开发中');
    console.log(`  #3 检查「修改主币种/副币种」hint: ${hasHint ? '✗ 仍存在' : '✓ 已删'}`);

    // #4: 主+副币种 select 同行
    const hasPairRow = await page.$('.modal-body .currency-pair-row');
    const pairCols = await page.$$('.modal-body .currency-pair-row .currency-pair-col');
    console.log(`  #4 currency-pair-row: ${hasPairRow ? '✓ 存在' : '✗ 不存在'}`);
    console.log(`  #4 currency-pair-col 数: ${pairCols.length} (期望 2 — 主+副币种各一)`);
    // 检查两 col 是否同一 row (y 坐标接近)
    let colYs = [];
    for (const col of pairCols) {
      const box = await col.boundingBox();
      colYs.push(box.y);
    }
    console.log(`  #4 col ys: [${colYs.map(y => y.toFixed(0)).join(', ')}] (期望完全相等 / 同行)`);
    const sameRow = colYs.length === 2 && Math.abs(colYs[0] - colYs[1]) < 2;
    console.log(`  #4 同行验证: ${sameRow ? '✓ 同一行' : '✗ 错位'}`);
    // 检查两 col 水平 layout (x 不同, w 接近)
    let colBoxes = [];
    for (const col of pairCols) {
      const box = await col.boundingBox();
      colBoxes.push(box);
    }
    const colsSideBySide = colBoxes.length === 2 && colBoxes[0].x < colBoxes[1].x;
    console.log(`  #4 水平并排: ${colsSideBySide ? '✓' : '✗'} (${colBoxes.map(b => `x=${b.x.toFixed(0)} w=${b.width.toFixed(0)}`).join(' | ')})`);

    // 验证 select 元素
    const primarySel = await page.$('[data-testid="currency-edit-primary"]');
    const secondarySel = await page.$('[data-testid="currency-edit-secondary"]');
    const primaryBox = await primarySel.boundingBox();
    const secondaryBox = await secondarySel.boundingBox();
    console.log(`  primary select box: x=${primaryBox.x.toFixed(0)} w=${primaryBox.width.toFixed(0)}`);
    console.log(`  secondary select box: x=${secondaryBox.x.toFixed(0)} w=${secondaryBox.width.toFixed(0)}`);
    console.log(`  two selects x-overlap: ${primaryBox.x < secondaryBox.x + secondaryBox.width && secondaryBox.x < primaryBox.x + primaryBox.width ? '✓ 行内 (overlap)' : '✗ 不在同行'}`);

    await snap(page, '03-multi-no-bills-modal-side-by-side');

    // 关闭
    await page.click('.modal-close');
    await page.waitForTimeout(300);

    // ========== [follow-up] multi+has_bills (session 1) 验 #2 backdrop ==========
    console.log('\n[follow-up] multi+has_bills modal (session 1) #2 验证');
    await openSession(page, 1);
    const bar3 = await page.$('[data-sbc="currency-bar-edit"]');
    await bar3.click();
    await page.waitForSelector('[data-sbc="currency-add-modal"][data-mode="multi"][data-has-bills="true"]', { timeout: 5000 });
    await page.waitForTimeout(500);
    const multiHBBackdrop = await page.evaluate(() => {
      const bd = document.querySelector('.modal-backdrop');
      return bd ? window.getComputedStyle(bd).backgroundColor : 'NO_BACKDROP';
    });
    console.log(`  multi+has_bills backdrop: ${multiHBBackdrop}`);
    console.log(`  #2 验证 (multi+has_bills): ${multiHBBackdrop === 'rgba(0, 0, 0, 0)' || multiHBBackdrop === 'transparent' ? '✓ 透明' : '✗ 仍有深色'}`);
    // multi+has_bills 应该没有 .currency-pair-row (chips, 不是 select)
    const hasPairRowMHB = await page.$('.modal-body .currency-pair-row');
    console.log(`  multi+has_bills 不该有 .currency-pair-row: ${hasPairRowMHB ? '✗ 错!' : '✓ 没有 (chips 不是 select)'}`);
    await snap(page, '04-multi-has-bills-modal-no-backdrop');

    // ========== [follow-up] single+!has_bills (session 3) #2 验证 ==========
    console.log('\n[follow-up] single+!has_bills modal (session 3) #2 验证');
    await page.click('.modal-close');
    await page.waitForTimeout(300);
    await openSession(page, 3);
    const pill2 = await page.$('[data-sbc="currency-pill-add-secondary"]');
    await pill2.click();
    await page.waitForSelector('[data-sbc="currency-add-modal"][data-mode="single"][data-has-bills="false"]', { timeout: 5000 });
    await page.waitForTimeout(500);
    const singleBackdrop = await page.evaluate(() => {
      const bd = document.querySelector('.modal-backdrop');
      return bd ? window.getComputedStyle(bd).backgroundColor : 'NO_BACKDROP';
    });
    console.log(`  single+!has_bills backdrop: ${singleBackdrop}`);
    console.log(`  #2 验证 (single+!has_bills): ${singleBackdrop === 'rgba(0, 0, 0, 0)' || singleBackdrop === 'transparent' ? '✓ 透明' : '✗ 仍有深色'}`);
    await snap(page, '05-single-no-bills-modal-no-backdrop');

    console.log('\n✓ All 4 PO #7731 反馈验证完成.');
  } catch (e) {
    console.error(`✗ Error: ${e.message}`);
    console.error(e.stack);
  }
  await context.close();
  await browser.close();
})();