#!/usr/bin/env node
/**
 * v0.3.21 #110 — datetime-local 在多 viewport 下检查溢出
 */
const { chromium, devices } = require('playwright');

const FE = 'http://127.0.0.1:8448';
const TEST_EMAIL = 'xinhua1001@outlook.com';
const TEST_CODE = '000000';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const results = [];

  const viewports = [
    { name: 'tiny-320', width: 320, height: 568 },
    { name: 'android-small-360', width: 360, height: 640 },
    { name: 'iphone-se-375', width: 375, height: 667 },
    { name: 'iphone-13-mini-375', width: 375, height: 812 },
    { name: 'iphone-13-390', width: 390, height: 844 },
    { name: 'iphone-14-393', width: 393, height: 852 },
    { name: 'iphone-14-pro-max-430', width: 430, height: 932 },
  ];

  for (const vp of viewports) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 3,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      locale: 'zh-CN',
    });
    await context.request.post(`${FE}/api/auth/send-code`, { data: { email: TEST_EMAIL } });
    await context.request.post(`${FE}/api/auth/verify-code`, { data: { email: TEST_EMAIL, code: TEST_CODE } });

    const page = await context.newPage();
    await page.goto(`${FE}/sessions/1/bills/new`);
    await page.waitForSelector('#occurredAt', { timeout: 10000 });
    await page.waitForTimeout(400);

    const info = await page.locator('#occurredAt').evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        inputWidth: rect.width,
        inputRight: rect.right,
        viewportWidth: window.innerWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        cssWidth: cs.width,
        cssMinWidth: cs.minWidth,
        cssMaxWidth: cs.maxWidth,
        cssBoxSizing: cs.boxSizing,
        overflowX: document.documentElement.scrollWidth > window.innerWidth,
      };
    });

    results.push({ vp: vp.name, viewport: vp.width, ...info });
    await page.close();
    await context.close();
  }

  await browser.close();
  console.log(JSON.stringify(results, null, 2));
})();