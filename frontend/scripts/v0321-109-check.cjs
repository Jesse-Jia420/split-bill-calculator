#!/usr/bin/env node
/**
 * v0.3.21 #109 — Join 页面去掉"先到先得"验证 (PO msg 18:17)
 *
 * 验: anon join 页面 "选择已有昵称" label 不含 "先到先得"
 * 测试 session 5 (测试加入页, 3 available slots: 小明/小红/小刚)
 */
const { chromium } = require('playwright');

const FE = 'http://127.0.0.1:8448';
const SCREENSHOT_DIR = '/home/node/.openclaw/media/v0321-109';
const fs = require('fs');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  // 匿名 context (不 login)
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    locale: 'zh-CN',
  });

  const results = {};

  // 匿名 join session 5 (刚创建, 3 available slots)
  const page = await context.newPage();
  await page.goto(`${FE}/sessions/5/join`);
  // 等 label 渲染
  await page.waitForSelector('.label', { timeout: 10000 });
  await page.waitForTimeout(500);

  // 找所有 .label 文本
  const labels = await page.locator('.label').allTextContents();

  // 单独找 "选择已有昵称" 那个
  const chooseExistingLabel = labels.find((l) => l.includes('选择已有昵称'));

  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-anon-join-page.png`, fullPage: true });

  results.allLabels = labels;
  results.chooseExistingLabel = chooseExistingLabel ?? null;
  results.hasFirstComeFirstServed = labels.some((l) => /先到先得/.test(l));
  results.chooseExistingClean = chooseExistingLabel === '选择已有昵称';

  await page.close();
  await browser.close();

  console.log(JSON.stringify(results, null, 2));

  const fail = [];
  if (results.hasFirstComeFirstServed) fail.push(`'先到先得' 仍存在: ${results.allLabels.find((l) => /先到先得/.test(l))}`);
  if (!results.chooseExistingClean) fail.push(`'选择已有昵称' label 文本 = "${results.chooseExistingLabel}" (期望严格 "选择已有昵称")`);

  if (fail.length > 0) {
    console.log('\n❌ FAILED:');
    for (const f of fail) console.log('  - ' + f);
    process.exit(1);
  } else {
    console.log('\n✅ ALL PASSED');
  }
})();