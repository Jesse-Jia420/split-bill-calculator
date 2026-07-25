const { chromium, devices } = require('playwright');

const FRONT = 'http://172.18.0.5:8448';

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  await page.request.post(`${FRONT}/api/auth/send-code`, {
    data: { email: 'xinhua1001@outlook.com' },
    headers: { 'Content-Type': 'application/json' },
  });
  await page.request.post(`${FRONT}/api/auth/verify-code`, {
    data: { email: 'xinhua1001@outlook.com', code: '000000' },
    headers: { 'Content-Type': 'application/json' },
  });

  const resp = await page.goto(`${FRONT}/sessions/9/settle`, { waitUntil: 'networkidle' });
  console.log('settle status:', resp.status());
  await page.waitForTimeout(3000);

  // Dump all data-sbc attributes
  const sbcAttrs = await page.evaluate(() => {
    const els = document.querySelectorAll('[data-sbc]');
    return Array.from(els).map(e => ({
      tag: e.tagName.toLowerCase(),
      attr: e.getAttribute('data-sbc'),
      visible: e.offsetParent !== null,
      text: e.textContent?.trim().substring(0, 60) || '',
    }));
  });
  console.log('data-sbc elements:', JSON.stringify(sbcAttrs, null, 2));

  // Look for settlement-section text
  const hasSettlementSection = await page.evaluate(() => {
    const text = document.body.textContent;
    return {
      has已结算记录: text.includes('已结算记录'),
      has最新应结算: text.includes('最新应结算'),
      has建议转账: text.includes('建议转账'),
      has添加: text.includes('添加'),
      hasDelete: text.includes('删除'),
    };
  });
  console.log('text matches:', hasSettlementSection);

  await browser.close();
})();