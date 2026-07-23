#!/usr/bin/env node
const { chromium, devices } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const iPhone = devices['iPhone 13'];
  const context = await browser.newContext({ ...iPhone, locale: 'zh-CN' });
  const page = await context.newPage();
  // Login via API
  const r1 = await page.request.post('http://127.0.0.1:8449/auth/send-code', { data: { email: 'xinhua1001@outlook.com' } });
  console.log('send-code:', r1.status());
  const r2 = await page.request.post('http://127.0.0.1:8449/auth/verify-code', { data: { email: 'xinhua1001@outlook.com', code: '000000' } });
  console.log('verify-code:', r2.status());
  const cookies = await context.cookies();
  console.log('cookies:', cookies.map(c => c.name + '=' + c.value.slice(0, 20) + '...').join(', '));
  await page.goto('http://127.0.0.1:8448/sessions/1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  console.log('URL:', page.url());
  console.log('title:', await page.title());
  const visibleText = await page.locator('body').textContent();
  console.log('body text (first 500):', visibleText.slice(0, 500));
  await browser.close();
})();
