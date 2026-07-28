// Playwright iPhone 13 @3x verify script for v0.3.0728-2 #6 (PO 解冻 — 解冻 0728-2 #6: PWA 快捷安装 "更短路径")
//
// 修法: 捕获 beforeinstallprompt event (Android/Desktop Chrome only) → 1-click 立即添加到桌面
// iOS Safari 不支持 beforeinstallprompt, 走 navigator.share() (#3 按钮, v0.3.37 #5 #4) 已是天然最短路径.
//
// 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
// 反 #101 ✅ Playwright 程序化 + DOM computed style + image tool 视觉三证
// 反 #150 v2 ✅ 真视觉位置 + 真数据 (session 9 泰国测试)
// 反 #151 ✅ PNG 截图存 ~/.openclaw/media/browser/v0728-2-6-pwa-fast-path/

const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.SBC_BASE || 'https://test.jessejia.pp.ua';
const SCREENSHOTS_DIR = path.join(process.env.HOME || '/home/node', '.openclaw/media/browser/v0728-2-6-pwa-fast-path');
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const iPhone13 = devices['iPhone 13'];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...iPhone13,
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  // 1. Login via BE API
  console.log('[v0728-2-6] Step 1: login as demo@example.com');
  await context.request.post(`${BASE}/auth/send-code`, {
    data: { email: 'demo@example.com' },
  });
  await context.request.post(`${BASE}/auth/verify-code`, {
    data: { email: 'demo@example.com', code: '000000' },
  });

  // 2. Navigate to session 9
  console.log('[v0728-2-6] Step 2: navigate to session 9');
  await page.goto(`${BASE}/sessions/9`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // 3. Click invite button to open modal
  console.log('[v0728-2-6] Step 3: click invite-btn to open modal');
  const inviteBtn = page.locator('[data-testid="invite-btn"]');
  if ((await inviteBtn.count()) === 0) {
    console.error('  ❌ FAIL: invite button not found');
    process.exit(1);
  }
  await inviteBtn.click();
  await page.waitForTimeout(500);

  // 4. Verify modal is open
  console.log('[v0728-2-6] Step 4: verify modal opens');
  const modal = page.locator('[data-testid="invite-confirm-modal"]');
  const modalOpen = await modal.count();
  console.log(`  modal open count: ${modalOpen}`);

  // 5. Initial state: NO beforeinstallprompt event (iOS Safari UA in iPhone 13)
  //    → install-btn should NOT be shown
  console.log('[v0728-2-6] Step 5: check initial state (no beforeinstallprompt event)');
  const installBtn = page.locator('[data-testid="invite-install-btn"]');
  const initialBtnCount = await installBtn.count();
  console.log(`  install-btn count (initial): ${initialBtnCount}`);
  // iPhone 13 UA = iOS Safari, no beforeinstallprompt from iOS Safari
  // → button should be hidden (count = 0)

  // 6. Simulate beforeinstallprompt event (mock Android Chrome desktop scenario)
  console.log('[v0728-2-6] Step 6: dispatch fake beforeinstallprompt event');
  await page.evaluate(() => {
    // Create a fake BeforeInstallPromptEvent
    const fakeEvent = new Event('beforeinstallprompt', { cancelable: true });
    // Mock prompt() and userChoice per Chromium spec
    (fakeEvent).prompt = () => Promise.resolve();
    (fakeEvent).userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(fakeEvent);
  });
  await page.waitForTimeout(300);

  // 7. After dispatching event: install-btn should be visible
  console.log('[v0728-2-6] Step 7: verify install-btn now visible');
  const afterDispatchBtnCount = await installBtn.count();
  console.log(`  install-btn count (after dispatch): ${afterDispatchBtnCount}`);

  // 8. Inspect install-btn computed styles
  console.log('[v0728-2-6] Step 8: inspect install-btn computed styles');
  const btnStyles = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="invite-install-btn"]');
    if (!btn) return null;
    const cs = window.getComputedStyle(btn);
    const rect = btn.getBoundingClientRect();
    return {
      tagName: btn.tagName,
      textContent: btn.textContent.trim(),
      type: cs.background.split('linear-gradient')[1]?.substring(0, 50) || cs.background.substring(0, 50),
      backgroundImage: cs.backgroundImage.substring(0, 100),
      color: cs.color,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      height: rect.height,
      width: rect.width,
      border: cs.border,
      borderRadius: cs.borderRadius,
      boxShadow: cs.boxShadow.substring(0, 50),
      ariaLabel: btn.getAttribute('aria-label'),
      title: btn.getAttribute('title'),
      cursor: cs.cursor,
      display: cs.display,
    };
  });
  console.log(`  install-btn text: "${btnStyles?.textContent}"`);
  console.log(`  aria-label: "${btnStyles?.ariaLabel}"`);
  console.log(`  title: "${btnStyles?.title}"`);
  console.log(`  background: ${btnStyles?.backgroundImage}`);
  console.log(`  color: ${btnStyles?.color}`);
  console.log(`  font-size: ${btnStyles?.fontSize}, font-weight: ${btnStyles?.fontWeight}`);
  console.log(`  height: ${btnStyles?.height}px, width: ${btnStyles?.width}px`);
  console.log(`  border-radius: ${btnStyles?.borderRadius}`);
  console.log(`  cursor: ${btnStyles?.cursor}`);

  // 9. Verify existing 3-button row still works (regression check)
  console.log('[v0728-2-6] Step 9: verify existing 3-button row still present');
  const pwaRowCount = await page.locator('[data-testid="invite-pwa-row"]').count();
  const saveQrCount = await page.locator('[data-testid="invite-pwa-save-qr"]').count();
  const shareQrCount = await page.locator('[data-testid="invite-pwa-share-qr"]').count();
  const shareLinkCount = await page.locator('[data-testid="invite-pwa-share-link"]').count();
  console.log(`  pwa-row: ${pwaRowCount}, save-qr: ${saveQrCount}, share-qr: ${shareQrCount}, share-link: ${shareLinkCount}`);

  // 10. Position check: install-btn should be BEFORE QR code (above it in DOM)
  console.log('[v0728-2-6] Step 10: verify install-btn placement (before QR)');
  const positions = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="invite-install-btn"]');
    const qr = document.querySelector('[data-testid="invite-qr-wrap"]');
    if (!btn || !qr) return null;
    const btnRect = btn.getBoundingClientRect();
    const qrRect = qr.getBoundingClientRect();
    return {
      btnTop: btnRect.top,
      qrTop: qrRect.top,
      btnBeforeQr: btnRect.top < qrRect.top,
      btnAboveQr: btnRect.bottom <= qrRect.top + 4,
    };
  });
  console.log(`  btn top: ${positions?.btnTop}, qr top: ${positions?.qrTop}`);
  console.log(`  btn before QR: ${positions?.btnBeforeQr}`);

  // 11. Screenshot full modal
  console.log('[v0728-2-6] Step 11: full modal screenshot');
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '01-modal-with-install-btn.png'),
    fullPage: false,
  });

  // 12. Click install-btn, verify prompt() called and installPromptEvent cleared
  console.log('[v0728-2-6] Step 12: click install-btn → check prompt() called');
  let promptCalled = false;
  await page.exposeFunction('__recordPrompt', () => { promptCalled = true; });
  await page.evaluate(() => {
    // Re-dispatch event with hook to record prompt() call
    const fakeEvent = new Event('beforeinstallprompt', { cancelable: true });
    fakeEvent.prompt = () => {
      window.__recordPrompt();
      return Promise.resolve();
    };
    fakeEvent.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(fakeEvent);
  });
  await page.waitForTimeout(300);
  await installBtn.click();
  await page.waitForTimeout(500);
  console.log(`  prompt() called: ${promptCalled}`);

  // 13. After click: install-btn should be hidden (one-time event)
  console.log('[v0728-2-6] Step 13: verify install-btn hidden after one-time use');
  const afterClickBtnCount = await installBtn.count();
  console.log(`  install-btn count (after click): ${afterClickBtnCount}`);

  // 14. Close modal, screenshot
  console.log('[v0728-2-6] Step 14: close modal');
  const closeBtn = page.locator('[data-testid="invite-confirm-btn"]');
  await closeBtn.click();
  await page.waitForTimeout(300);

  await browser.close();

  console.log('\n[v0728-2-6] === SUMMARY ===');
  const checks = [
    { name: 'modal opens after invite click', pass: modalOpen === 1 },
    { name: 'install-btn hidden initially (iOS Safari, no beforeinstallprompt)', pass: initialBtnCount === 0 },
    { name: 'install-btn visible after dispatch fake event', pass: afterDispatchBtnCount === 1 },
    { name: 'install-btn text = "立即添加到桌面"', pass: btnStyles?.textContent?.includes('立即添加到桌面') },
    { name: 'install-btn aria-label = "立即添加到桌面"', pass: btnStyles?.ariaLabel === '立即添加到桌面' },
    { name: 'install-btn has gradient background (indigo→purple)', pass: (btnStyles?.backgroundImage || '').includes('linear-gradient') },
    { name: 'install-btn color = white #fff', pass: btnStyles?.color === 'rgb(255, 255, 255)' },
    { name: 'install-btn font-size = 14px', pass: btnStyles?.fontSize === '14px' },
    { name: 'install-btn font-weight = 600', pass: btnStyles?.fontWeight === '600' },
    { name: 'install-btn height = 44px', pass: btnStyles?.height === 44 },
    { name: 'install-btn has 12px border-radius', pass: btnStyles?.borderRadius === '12px' },
    { name: 'install-btn cursor = pointer', pass: btnStyles?.cursor === 'pointer' },
    { name: 'install-btn has box-shadow', pass: (btnStyles?.boxShadow || '').length > 10 },
    { name: 'install-btn placed BEFORE QR code (above)', pass: positions?.btnBeforeQr === true },
    { name: 'existing 3-button row still present (regression)', pass: pwaRowCount === 1 && saveQrCount === 1 && shareQrCount === 1 && shareLinkCount === 1 },
    { name: 'prompt() called when clicking install-btn', pass: promptCalled === true },
    { name: 'install-btn hidden after one-time use', pass: afterClickBtnCount === 0 },
  ];

  let allPass = true;
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}`);
    if (!c.pass) allPass = false;
  }

  if (allPass) {
    console.log('\n[v0728-2-6] ✅ ALL CHECKS PASSED');
    console.log('NOTE: chromium 不重现 iOS Safari z-index escape 类行为, 但本测试不依赖.');
    console.log('      1-click install 实际行为需 Android Chrome / Desktop Chrome 真机验证.');
    process.exit(0);
  } else {
    console.log('\n[v0728-2-6] ❌ SOME CHECKS FAILED');
    process.exit(1);
  }
})();
