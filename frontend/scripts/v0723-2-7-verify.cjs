const fs = require('fs');
const { chromium, devices } = require('playwright-core');
const HEADLESS = '/config/.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell';
const OUT = '/home/node/.openclaw/workspace/.openclaw/media/browser/v0723-2-7-glass-pad';
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const browser = await chromium.launch({ executablePath: HEADLESS, headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ ...devices['iPhone 13'], hasTouch: true, locale: 'zh-CN' });
  const API = 'http://127.0.0.1:8449';
  await ctx.request.post(API + '/auth/send-code', { data: { email: 'demo@example.com' }, headers: { 'Content-Type': 'application/json' } });
  await ctx.request.post(API + '/auth/verify-code', { data: { email: 'demo@example.com', code: '000000' }, headers: { 'Content-Type': 'application/json' } });
  const sessionsRes = await ctx.request.get(API + '/sessions');
  const sessions = await sessionsRes.json();
  const withBills = sessions.find(s => s.bill_count > 0);
  if (!withBills) { console.log('NO session with bills'); await browser.close(); return; }
  const code = withBills.session_code || String(withBills.id);
  console.log('using session:', withBills.id, withBills.name, 'bills:', withBills.bill_count, 'code:', code);
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:8448/s/' + code, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const state = await page.evaluate(() => {
    const search = document.querySelector('.bills-search');
    if (!search) return { exists: false, url: location.href };
    const before = window.getComputedStyle(search, '::before');
    const rect = search.getBoundingClientRect();
    return {
      exists: true,
      url: location.href,
      searchBox: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      beforeContent: before.content,
      beforeTop: before.top,
      beforeBottom: before.bottom,
      beforeBg: before.backgroundColor,
      beforeBackdrop: before.backdropFilter || before.webkitBackdropFilter,
    };
  });
  console.log('search state:', JSON.stringify(state, null, 2));
  await page.screenshot({ path: `${OUT}/search-glass.png`, fullPage: false });
  console.log('DONE');
  await browser.close();
})().catch(e => { console.log('ERROR:', e.message); process.exit(1); });
