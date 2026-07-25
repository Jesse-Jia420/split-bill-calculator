// v0325-0725-3-5-fab-walk.cjs — Test FAB in multiple states
const { chromium, devices } = require('playwright');
const fs = require('fs');
const OUT = '/tmp/verify-v0325-3-5-walk';

(async () => {
  try { fs.mkdirSync(OUT, { recursive: true }); } catch {}
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-CN' });
  const page = await context.newPage();

  // Login
  await page.request.post('http://127.0.0.1:8449/auth/send-code', {
    data: { email: 'xinhua1001@outlook.com' },
    headers: { 'Content-Type': 'application/json' },
  });
  await page.request.post('http://127.0.0.1:8449/auth/verify-code', {
    data: { email: 'xinhua1001@outlook.com', code: '000000' },
    headers: { 'Content-Type': 'application/json' },
  });
  const cookies = (await page.request.storageState()).cookies;
  await context.addCookies(cookies);

  // 1. Empty state (/sessions with 0 sessions... but our test DB has 15+)
  console.log('=== A. /sessions default (current DB has 15 sessions) ===');
  const resp = await page.goto('http://127.0.0.1:8448/sessions', { waitUntil: 'networkidle' });
  console.log('GET status:', resp.status());
  await page.waitForTimeout(800);
  const sessionCount = await page.locator('a.session-card').count();
  const fabCount = await page.locator('a.fab').count();
  console.log(`Session cards: ${sessionCount}, FAB count: ${fabCount}`);

  // Get FAB info
  const fabInfo = async (label) => {
    const fab = page.locator('a.fab').first();
    const info = await fab.evaluate((el) => {
      const c = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        position: c.position,
        bottom: c.bottom,
        right: c.right,
        w: r.width, h: r.height,
        x: Math.round(r.x), y: Math.round(r.y),
        rect_w: Math.round(r.width),
        borderRadius: c.borderRadius,
        bg: c.backgroundImage.slice(0, 100),
        border: c.border,
        zIndex: c.zIndex,
        vw: window.innerWidth,
        vh: window.innerHeight,
        classes: el.className,
        bottomFromVp: window.innerHeight - r.bottom,
        rightFromVp: window.innerWidth - r.right,
        bgColor: c.backgroundColor,
        opacity: c.opacity,
      };
    });
    console.log(`FAB [${label}]:`, JSON.stringify(info, null, 2));
    return info;
  };

  await fabInfo('top of /sessions');
  await page.screenshot({ path: `${OUT}/A1-sessions-top.png`, fullPage: true });

  // 2. Scroll down — does FAB stick?
  console.log('\n=== B. Scroll /sessions down 1000px ===');
  await page.evaluate(() => window.scrollTo({ top: 1000, behavior: 'instant' }));
  await page.waitForTimeout(300);
  await fabInfo('scrolled /sessions');
  await page.screenshot({ path: `${OUT}/B1-sessions-scrolled.png`, fullPage: false });

  // 3. Detailed view of FAB after scroll
  const fab = page.locator('a.fab').first();
  await fab.screenshot({ path: `${OUT}/C1-fab-after-scroll.png` });

  // 4. Last item accessibility — does FAB overlap last session card?
  console.log('\n=== C. Last session card position vs FAB ===');
  const lastSessionBox = await page.locator('a.session-card').last().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      bottom: Math.round(r.bottom),
      right: Math.round(r.right),
      vp_w: window.innerWidth,
      vp_h: window.innerHeight,
    };
  });
  console.log('Last session card:', JSON.stringify(lastSessionBox, null, 2));

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
