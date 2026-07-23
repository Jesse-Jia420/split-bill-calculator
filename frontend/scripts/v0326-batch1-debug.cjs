#!/usr/bin/env node
const { chromium, devices } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const iPhone = devices['iPhone 13'];
  const context = await browser.newContext({ ...iPhone, locale: 'zh-CN' });
  const page = await context.newPage();
  await page.request.post('http://127.0.0.1:8449/auth/send-code', { data: { email: 'demo@example.com' } });
  await page.request.post('http://127.0.0.1:8449/auth/verify-code', { data: { email: 'demo@example.com', code: '000000' } });
  await page.goto('http://127.0.0.1:8448/sessions/1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  // 直接查 DOM
  const billsCount = await page.locator('.bills-card-title').count();
  const membersCount = await page.locator('.members-title-a').count();
  console.log('bills-card-title count:', billsCount);
  console.log('members-title-a count:', membersCount);
  // Check if they're visible
  const billsVisible = await page.locator('.bills-card-title').first().isVisible().catch(() => false);
  const membersVisible = await page.locator('.members-title-a').first().isVisible().catch(() => false);
  console.log('bills visible:', billsVisible);
  console.log('members visible:', membersVisible);
  // Get HTML
  const billsHTML = await page.locator('.bills-card-title').first().evaluate(el => el.outerHTML).catch(() => 'null');
  const membersHTML = await page.locator('.members-title-a').first().evaluate(el => el.outerHTML).catch(() => 'null');
  console.log('bills HTML:', billsHTML);
  console.log('members HTML:', membersHTML);
  await browser.close();
})();
