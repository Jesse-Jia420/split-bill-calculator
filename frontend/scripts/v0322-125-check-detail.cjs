// v0.3.22 #125 — 通过 page context 拿 sessions API 数据
const { chromium, devices } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  await page.request.post('http://172.18.0.5:8448/api/auth/send-code', {
    data: { email: 'demo@example.com' },
    headers: { 'Content-Type': 'application/json' },
  });
  await page.request.post('http://172.18.0.5:8448/api/auth/verify-code', {
    data: { email: 'demo@example.com', code: '000000' },
    headers: { 'Content-Type': 'application/json' },
  });

  const resp = await page.request.get('http://172.18.0.5:8448/api/sessions');
  const data = await resp.json();
  for (const s of data) {
    console.log('id=' + s.id + ' name=' + s.name + ' cur=' + JSON.stringify(s.currencies) + ' bills=' + (s.bill_count || '?'));
  }

  await browser.close();
})();