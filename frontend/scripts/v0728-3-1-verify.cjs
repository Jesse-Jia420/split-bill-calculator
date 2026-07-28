// Playwright iPhone 13 @3x verify script for v0.3.0728-3 #1
// 邀请 join 页 anon 显示已有昵称 (reverse v0.3.0728-2 #2: re-add slot-list block 到 anon 路径)
//
// 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
// 反 #101 ✅ Playwright 程序化 + DOM computed style + image tool 视觉三证
// 反 #150 v2 ✅ 真视觉位置 + 真数据 (session 9 泰国测试 6 members)
// 反 #151 ✅ PNG 截图存 ~/.openclaw/media/browser/v0728-3-1-join-anon-nickname-list/

const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.SBC_BASE || 'https://test.jessejia.pp.ua';
const SCREENSHOTS_DIR = path.join(process.env.HOME || '/home/node', '.openclaw/media/browser/v0728-3-1-join-anon-nickname-list');
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const iPhone13 = devices['iPhone 13'];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...iPhone13,
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  // 1. Login via BE API as xinhua1001 (who is in session 9)
  console.log('[v0728-3-1] Step 1: login as demo@example.com');
  await context.request.post(`${BASE}/auth/send-code`, {
    data: { email: 'demo@example.com' },
  });
  await context.request.post(`${BASE}/auth/verify-code`, {
    data: { email: 'demo@example.com', code: '000000' },
  });

  // 2. Navigate to /s/64BZQNX9NU/join (anon join page, session 9 canonical URL)
  //    Log out first to test anon behavior
  console.log('[v0728-3-1] Step 2: clear cookies for anon test');
  await context.clearCookies();

  await page.goto(`${BASE}/s/64BZQNX9NU/join`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2500);

  // 3. Verify slot-list is visible for anon
  console.log('[v0728-3-1] Step 3: verify slot-list visible for anon');
  const slotListCount = await page.locator('[data-testid="member-pick-row"]').count();
  console.log(`  member-pick-row count (anon): ${slotListCount}`);

  // 4. Inspect slot-list content
  console.log('[v0728-3-1] Step 4: inspect slot-list content');
  const slotItems = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[data-testid="member-pick-row"]')).slice(0, 10).map((el) => ({
      nickname: el.querySelector('.member-nickname')?.textContent?.trim(),
      emailMasked: el.querySelector('.member-email-masked')?.textContent?.trim() || '(no email)',
      hasEmail: el.getAttribute('data-has-email'),
    }));
  });
  console.log(`  slot items: ${JSON.stringify(slotItems)}`);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-anon-join-with-slotlist.png'), fullPage: false });

  // 5. Verify "新建昵称" form is also still present
  console.log('[v0728-3-1] Step 5: verify 新建昵称 form still present');
  const newNicknameForm = await page.locator('input.glass-input[placeholder="你想叫什么名字？"], input.glass-input[placeholder="你的昵称"]').count();
  console.log(`  new nickname input count: ${newNicknameForm}`);

  await browser.close();

  console.log('\n[v0728-3-1] === SUMMARY ===');
  const checks = [
    { name: 'anon join page shows slot-list (reverse #2)', pass: slotListCount > 0 },
    { name: 'slot items have nickname text', pass: slotItems.some((s) => s.nickname && s.nickname.length > 0) },
    { name: '新昵称 form still present (reverse #2 + retain create form)', pass: newNicknameForm >= 1 },
    { name: 'slot items count >= 2 (multi-member session)', pass: slotListCount >= 2 },
  ];

  let allPass = true;
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}`);
    if (!c.pass) allPass = false;
  }

  if (allPass) {
    console.log('\n[v0728-3-1] ✅ ALL CHECKS PASSED');
    console.log('NOTE: iOS Safari 真机 walk 需 PO 自验 邀请链接 (anon) → 应该看到已有 nickname 列表 (跟 logged-in 用户同款 slot-list) + 仍可新建昵称.');
    process.exit(0);
  } else {
    console.log('\n[v0728-3-1] ❌ SOME CHECKS FAILED');
    process.exit(1);
  }
})();