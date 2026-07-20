const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = '/host_tmp';
const TMP = '/tmp/billform-review';

(async () => {
  // Ensure dirs exist (codeserver side)
  try { fs.mkdirSync(OUT, { recursive: true }); } catch {}
  try { fs.mkdirSync(TMP, { recursive: true }); } catch {}

  const browser = await chromium.launch();

  // Use iPhone 13 device
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  // Try various sessions and paths
  const targets = [
    { sid: 11, path: '/sessions/11/bills/new' },
    { sid: 12, path: '/sessions/12/bills/new' },
    { sid: 12, path: '/sessions/12/bills' },
    { sid: 11, path: '/sessions/11' },
  ];

  for (const { sid, path: p } of targets) {
    try {
      const resp = await page.goto(`http://localhost:8448${p}`, { waitUntil: 'networkidle', timeout: 12000 });
      const status = resp ? resp.status() : 'no-resp';
      if (status === 200) {
        await page.waitForTimeout(600);
        const safe = p.replace(/[\/:]/g, '_');
        const file = `${TMP}/iphone13-s${sid}${safe}.png`;
        await page.screenshot({ path: file, fullPage: true });
        console.log(`OK ${file} (status ${status})`);
      } else {
        console.log(`SKIP s${sid}${p} status=${status}`);
      }
    } catch (e) {
      console.log(`ERR s${sid}${p}: ${e.message.split('\n')[0]}`);
    }
  }

  await browser.close();
})();