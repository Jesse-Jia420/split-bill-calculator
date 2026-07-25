// v0325-0725-3-5-fab-deep.cjs - Deep diagnosis of FAB

const { chromium, devices } = require('playwright');
const fs = require('fs');

const VITE_HOST = 'http://127.0.0.1:8448';
const OUT_DIR = '/tmp/verify-v0325-3-5-deep';

(async () => {
  try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch {}
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-CN' });
  const page = await context.newPage();

  // Login
  await page.request.post('http://127.0.0.1:8449/auth/send-code', { data: { email: 'xinhua1001@outlook.com' }, headers: { 'Content-Type': 'application/json' } });
  await page.request.post('http://127.0.0.1:8449/auth/verify-code', { data: { email: 'xinhua1001@outlook.com', code: '000000' }, headers: { 'Content-Type': 'application/json' } });
  const cookies = (await page.request.storageState()).cookies;
  await context.addCookies(cookies);

  const resp = await page.goto(`${VITE_HOST}/sessions`, { waitUntil: 'networkidle', timeout: 15000 });
  console.log('GET /sessions', resp.status());
  await page.waitForTimeout(800);

  // Collect ALL .fab matches
  const allFabs = await page.evaluate(() => {
    const list = [];
    document.querySelectorAll('.fab').forEach((el, i) => {
      const r = el.getBoundingClientRect();
      list.push({
        index: i,
        tag: el.tagName,
        classes: el.className,
        svelteHash: (el.className.match(/s-[\w]+/g) || [''])[0],
        x: r.x.toFixed(1),
        y: r.y.toFixed(1),
        w: r.width,
        h: r.height,
        position: getComputedStyle(el).position,
        fontSize: getComputedStyle(el).fontSize,
        href: el.getAttribute('href'),
        text: el.textContent?.trim(),
        ariaLabel: el.getAttribute('aria-label'),
      });
    });
    return list;
  });
  console.log('=== ALL .fab elements ===');
  console.log(JSON.stringify(allFabs, null, 2));

  // Find all CSS rules matching .fab or containing it
  const allRules = await page.evaluate(() => {
    const matches = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.selectorText && rule.selectorText.includes('.fab')) {
            matches.push({
              selector: rule.selectorText,
              cssText: rule.cssText.slice(0, 200),
            });
          }
        }
      } catch(e) {}
    }
    return matches;
  });
  console.log('\n=== CSS rules with .fab ===');
  console.log(JSON.stringify(allRules, null, 2));

  // Full DOM dump of section containing fab
  const fabSection = await page.evaluate(() => {
    const a = document.querySelector('a.fab');
    if (!a) return null;
    return {
      outerHTML: a.outerHTML,
      parentOuterHTML: a.parentElement?.outerHTML.slice(0, 500),
      grandparentOuterHTML: a.parentElement?.parentElement?.outerHTML.slice(0, 500),
    };
  });
  console.log('\n=== FAB outerHTML ===');
  console.log(fabSection?.outerHTML);
  console.log('\n=== parent ===');
  console.log(fabSection?.parentOuterHTML);

  // Save full DOM for inspection
  const fullHtml = await page.content();
  fs.writeFileSync(`${OUT_DIR}/sessions-page.html`, fullHtml);

  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
