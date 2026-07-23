// v0.3.22 #122 (PO msg 15:35 #8025): 验证 InviteLinkButton 改名为 "账本链接/邀请"
// login 走 BE API + cookie jar, 跳过 UI login(避免 click handler 触发问题)
const { chromium, devices } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  // 1. login via BE (cookie jar) - 注入 cookie
  const apiResp = await page.request.post('http://172.18.0.5:8448/api/auth/send-code', {
    data: { email: 'xinhua1001@outlook.com' },
    headers: { 'Content-Type': 'application/json' },
  });
  console.log('[1] send-code status:', apiResp.status());

  const verifyResp = await page.request.post('http://172.18.0.5:8448/api/auth/verify-code', {
    data: { email: 'xinhua1001@outlook.com', code: '000000' },
    headers: { 'Content-Type': 'application/json' },
  });
  console.log('[2] verify-code status:', verifyResp.status());
  const verifyBody = await verifyResp.json().catch(() => ({}));
  console.log('[2b] verify-code body:', JSON.stringify(verifyBody).substring(0, 200));

  // 2. check /auth/me
  const meResp = await page.request.get('http://172.18.0.5:8448/api/auth/me');
  const meBody = await meResp.json().catch(() => ({}));
  console.log('[3] auth/me:', JSON.stringify(meBody).substring(0, 200));

  // 3. navigate to /sessions/1
  await page.goto('http://172.18.0.5:8448/sessions/1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // 4. check invite button text
  const btn = page.locator('[data-testid="invite-btn"]').first();
  try {
    await btn.waitFor({ timeout: 5000 });
  } catch (e) {
    console.log('[4] invite-btn not found in 5s');
    await page.screenshot({ path: '/home/node/.openclaw/media/browser/v0322-122-debug-sessions1.png' });
    const html = await page.content();
    console.log('[4b] page HTML around members-header:');
    const idx = html.indexOf('members-header');
    if (idx >= 0) console.log(html.substring(idx - 100, idx + 500));
    await browser.close();
    process.exit(1);
  }
  const btnText = (await btn.textContent())?.trim();
  console.log('[4] invite-btn text:', JSON.stringify(btnText));

  const expectedText = '账本链接/邀请';
  const hasNewText = btnText?.includes(expectedText);
  console.log('[5] has new text "' + expectedText + '"?', hasNewText);

  // 6. check old text NOT present (only the new combined text)
  const isOldOnly = btnText?.trim() === '邀请';
  console.log('[6] old-only text "邀请"?', isOldOnly, '(should be false)');

  // 7. screenshot the invite button
  await btn.screenshot({ path: '/home/node/.openclaw/media/browser/v0322-122-invite-btn.png' });
  console.log('[7] button screenshot saved');

  // 8. screenshot the members header area
  const membersHeader = page.locator('.members-header').first();
  await membersHeader.screenshot({ path: '/home/node/.openclaw/media/browser/v0322-122-members-header.png' });
  console.log('[8] members header screenshot saved');

  // 9. click button → toast appears
  await btn.click();
  await page.waitForTimeout(800);
  const toastVisible = await page.locator('.toast-item').first().isVisible().catch(() => false);
  const toastText = toastVisible ? (await page.locator('.toast-item').first().textContent())?.trim() : null;
  console.log('[9] toast visible after click?', toastVisible, 'text:', JSON.stringify(toastText));

  // 10. screenshot after click (button should now show "已复制")
  await btn.screenshot({ path: '/home/node/.openclaw/media/browser/v0322-122-invite-btn-copied.png' });

  await browser.close();

  if (!hasNewText) {
    console.log('FAIL: button text does not match expected');
    process.exit(1);
  }
  console.log('PASS');
})();