#!/usr/bin/env node
/**
 * v0.3.21 #106.3 — 字号继续调小 (PO msg 18:17) 真机验证.
 *
 * 检查:
 *  - .tagline computed font-size = 26px (1.625rem @16px base)
 *  - .tagline-emphasis computed font-size = 32px
 *  - hierarchy preserved: wordmark (125/58) > emphasis (32) > body (26)
 */
const { chromium } = require('playwright');

const FE = 'http://127.0.0.1:8448';
const SCREENSHOT_DIR = '/home/node/.openclaw/media/v0321-106-3';

const fs = require('fs');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    locale: 'zh-CN',
  });

  const results = {};

  // === 匿名态 ===
  const page1 = await context.newPage();
  await page1.goto(`${FE}/`);
  await page1.waitForSelector('.tagline', { timeout: 5000 });
  await page1.waitForTimeout(500);

  // 读取 :root font-size (设了 --font-size-base = clamp(0.875rem, 4vw, 1rem))
  // 在 iPhone 13 (390px viewport) 下, 4vw = 15.6px, 所以 1rem = 15.6px
  // 1.625rem 实际计算为 25.35px, 不是 26px (后者是按 16px base 算的)
  const rootFontSize = await page1.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  const taglineSize = await page1.locator('.tagline').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const emphasisSize = await page1.locator('.tagline-emphasis').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const taglineWeight = await page1.locator('.tagline').evaluate((el) => parseInt(getComputedStyle(el).fontWeight, 10));
  const emphasisWeight = await page1.locator('.tagline-emphasis').first().evaluate((el) => parseInt(getComputedStyle(el).fontWeight, 10));

  await page1.screenshot({ path: `${SCREENSHOT_DIR}/01-anonymous-landing.png`, fullPage: false });

  // 验证 tagline 字号按 CSS 1.625rem 渲染 (允许 ±0.1px 浮点误差)
  const taglineExpected = 1.625 * rootFontSize;
  const emphasisExpected = 32;
  results.anonymous = {
    rootFontSizePx: rootFontSize,
    taglineFontSizePx: taglineSize,
    taglineFontSizeExpectedPx: taglineExpected,
    emphasisFontSizePx: emphasisSize,
    emphasisFontSizeExpectedPx: emphasisExpected,
    taglineFontWeight: taglineWeight,
    emphasisFontWeight: emphasisWeight,
    taglineSizeOk: Math.abs(taglineSize - taglineExpected) < 0.5,
    emphasisSizeOk: Math.abs(emphasisSize - emphasisExpected) < 0.5,
    hierarchyOk: emphasisSize > taglineSize,
  };
  await page1.close();

  await browser.close();

  console.log(JSON.stringify(results, null, 2));

  const fail = [];
  if (!results.anonymous.taglineSizeOk) fail.push(`tagline font-size = ${results.anonymous.taglineFontSizePx}px (expect ~${results.anonymous.taglineFontSizeExpectedPx}px)`);
  if (!results.anonymous.emphasisSizeOk) fail.push(`tagline-emphasis font-size = ${results.anonymous.emphasisFontSizePx}px (expect ~${results.anonymous.emphasisFontSizeExpectedPx}px)`);
  if (!results.anonymous.hierarchyOk) fail.push(`hierarchy broken: emphasis (${results.anonymous.emphasisFontSizePx}) should be > body (${results.anonymous.taglineFontSizePx})`);
  if (results.anonymous.taglineFontWeight !== 400) fail.push(`tagline weight = ${results.anonymous.taglineFontWeight} (expect 400, per #106.2)`);
  if (results.anonymous.emphasisFontWeight !== 700) fail.push(`tagline-emphasis weight = ${results.anonymous.emphasisFontWeight} (expect 700)`);

  if (fail.length > 0) {
    console.log('\n❌ FAILED:');
    for (const f of fail) console.log('  - ' + f);
    process.exit(1);
  } else {
    console.log('\n✅ ALL PASSED');
  }
})();