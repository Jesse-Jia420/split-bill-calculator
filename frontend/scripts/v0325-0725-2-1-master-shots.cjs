const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');

const FRONT = 'http://172.18.0.5:8448';
const OUT_DIR = '/home/node/.openclaw/media/browser/v0325-2-1-master';
fs.mkdirSync(OUT_DIR, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  // Login via vite proxy /api/* → BE
  await page.request.post(`${FRONT}/api/auth/send-code`, {
    data: { email: 'demo@example.com' },
    headers: { 'Content-Type': 'application/json' },
  });
  const verifyResp = await page.request.post(`${FRONT}/api/auth/verify-code`, {
    data: { email: 'demo@example.com', code: '000000' },
    headers: { 'Content-Type': 'application/json' },
  });
  console.log('login status:', verifyResp.status());

  // Navigate to real /sessions/9/settle
  const resp = await page.goto(`${FRONT}/sessions/9/settle`, { waitUntil: 'networkidle' });
  console.log('settle status:', resp.status());
  await page.waitForTimeout(2000);

  // 1) Three-segment overview
  await page.screenshot({ path: path.join(OUT_DIR, '01-settle-overview.png'), fullPage: true });
  console.log('01 OK');

  // 2) Click add button → open AddSettlementSheet
  const addBtn = page.locator('[data-sbc="add-settlement-btn"]').first();
  if (await addBtn.count() > 0) {
    await addBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT_DIR, '02-add-sheet-open.png'), fullPage: false });
    console.log('02 OK');
  } else {
    console.log('add btn not found');
  }

  await browser.close();
  console.log('SHOTS DONE at', OUT_DIR);
})();