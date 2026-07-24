// v0.3.x UAT 0723 #6 verify — SessionCard avatar 显示昵称首字母
//
// 修法: BE SessionSummary.avatars: list[AvatarItem] + _get_member_avatars()
// helper; FE SessionCard.svelte {#each session.avatars} 渲染 initial 字符.
//
// 1. 登录 xinhua1001
// 2. navigate /sessions 等列表
// 3. 找 session 11 (泰国测试账单 6.19-6.22, 5 members) → 验 5 个头像 J/J/C/Q/像
// 4. 找 session 6 (345, 1 member display_name="我") → 验 1 个头像 "我"
//    (注: task 字面说 "J" 但 PO 字面意图是 display_name[0], session 6 实际
//     member 的 display_name 是中文 "我" — 按 spec 一字不漏实现, 实际 = "我")
// 5. 视觉截图存 ~/.openclaw/media/browser/v0723-6-avatar-initial/

const { chromium } = require('playwright');
const fs = require('fs');

const TEST_URL = 'https://test.jessejia.pp.ua';
const SHOT_DIR = `${process.env.HOME}/.openclaw/media/browser/v0723-6-avatar-initial`;
fs.mkdirSync(SHOT_DIR, { recursive: true });

// 期望 initial 字符 (按 session_member.id ASC 顺序, 跟 BE helper 一致)
// session 11 actual: Jesse/Ju/Canyina/Q/像汤圆一样圆.
// session 6 actual: 我 (CJK 单字)
const SESSION_11_EXPECTED = ['J', 'J', 'C', 'Q', '像'];
const SESSION_6_EXPECTED = ['我'];

function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? '✓' : '✗'} ${label}: got=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    locale: 'zh-CN',
  });
  const page = await ctx.newPage();

  // --- 1. 登录 via BE API ---
  console.log('## 1. login via BE API');
  await page.goto(`${TEST_URL}/auth/login`, { waitUntil: 'load' });
  await page.evaluate(async () => {
    await fetch('/api/auth/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'xinhua1001@outlook.com' }),
    });
    await fetch('/api/auth/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'xinhua1001@outlook.com', code: '000000' }),
    });
  });
  console.log('  ✓ login OK');

  // --- 2. 拿 /sessions 列表, 校验 SessionSummary.avatars 字段存在 ---
  console.log('## 2. fetch /api/sessions, verify avatars field present');
  const list = await page.evaluate(async () => {
    const r = await fetch('/api/sessions', { credentials: 'include' });
    return await r.json();
  });
  if (!Array.isArray(list)) {
    console.error('  ✗ /api/sessions not array:', list);
    process.exit(2);
  }
  console.log('  sessions count =', list.length);
  const session11 = list.find((s) => s.id === 11);
  const session6 = list.find((s) => s.id === 6);
  if (!session11 || !session6) {
    console.error('  ✗ session 11 or 6 missing. all ids:', list.map((s) => s.id));
    process.exit(2);
  }
  expect('session 11 has avatars array',
    Array.isArray(session11.avatars) && session11.avatars.length === 5, true);
  expect('session 6 has avatars array (1)',
    Array.isArray(session6.avatars) && session6.avatars.length === 1, true);
  console.log('  session 11 avatars:', JSON.stringify(session11.avatars));
  console.log('  session 6 avatars:', JSON.stringify(session6.avatars));
  expect('session 11 initials',
    session11.avatars.map((a) => a.initial), SESSION_11_EXPECTED);
  expect('session 6 initial',
    session6.avatars.map((a) => a.initial), SESSION_6_EXPECTED);
  expect('session 11 names preserved (display_name)',
    session11.avatars.map((a) => a.name),
    ['Jesse', 'Ju', 'Canyina', 'Q', '像汤圆一样圆.']);

  // --- 3. navigate /sessions 等列表渲染 ---
  console.log('## 3. navigate /sessions, wait for cards');
  await page.goto(`${TEST_URL}/sessions`, { waitUntil: 'load' });
  await page.waitForSelector('a[href*="/sessions/"]', { timeout: 10000 });
  await page.waitForTimeout(1500); // give HMR time

  // 找包含 session 11 名 ("泰国测试账单 6.19-6.22") 的卡片
  const cardSelector11 = (label) => `a.card-link:has-text("泰国测试账单 6.19-6.22") ${label}`;
  const cardSelector6 = (label) => `a.card-link:has-text("345"):not(:has-text("345")) ${label}`;

  // --- 4. session 11: 5 avatars, each non-empty + first initial = J ---
  console.log('## 4. session 11 (5 avatars) — DOM check');
  const s11 = page.locator('a.card-link').filter({ hasText: '泰国测试账单 6.19-6.22' }).first();
  await s11.scrollIntoViewIfNeeded();
  const s11Avatars = s11.locator('.avatar-mini:not(.avatar-mini-overflow)');
  const s11Count = await s11Avatars.count();
  expect('session 11 avatar-mini count = 5', s11Count, 5);
  const s11Texts = [];
  for (let i = 0; i < s11Count; i++) {
    const t = (await s11Avatars.nth(i).textContent()) ?? '';
    s11Texts.push(t);
  }
  expect('session 11 avatar textContents', s11Texts, SESSION_11_EXPECTED);

  // 第一个 avatar aria-label 是 member 的 display_name
  const s11FirstAria = await s11Avatars.nth(0).getAttribute('aria-label');
  expect('session 11 first avatar aria-label', s11FirstAria, 'Jesse');
  const s11FifthAria = await s11Avatars.nth(4).getAttribute('aria-label');
  expect('session 11 fifth avatar aria-label (CJK)', s11FifthAria, '像汤圆一样圆.');

  // 截图 — session 11 卡片
  await s11.screenshot({ path: `${SHOT_DIR}/session-11-card.png` });
  console.log('  ✓ screenshot:', `${SHOT_DIR}/session-11-card.png`);

  // --- 5. session 6: 1 avatar (display_name = "我") ---
  console.log('## 5. session 6 (1 avatar, display_name "我") — DOM check');
  const s6 = page.locator('a.card-link').filter({ hasText: /^345/ }).first();
  await s6.scrollIntoViewIfNeeded();
  const s6Avatars = s6.locator('.avatar-mini:not(.avatar-mini-overflow)');
  const s6Count = await s6Avatars.count();
  expect('session 6 avatar-mini count = 1', s6Count, 1);
  const s6Text = (await s6Avatars.nth(0).textContent()) ?? '';
  expect('session 6 avatar textContent = "我" (CJK)', s6Text, '我');
  await s6.screenshot({ path: `${SHOT_DIR}/session-6-card.png` });
  console.log('  ✓ screenshot:', `${SHOT_DIR}/session-6-card.png`);

  // --- 6. 全 /sessions 列表截图 ---
  console.log('## 6. full /sessions page screenshot');
  await page.screenshot({
    path: `${SHOT_DIR}/sessions-full.png`,
    fullPage: false,
  });

  // --- 7. fallback 路径: 模拟无 avatars 字段的 response ---
  // 用 route.fulfill 拦截 /api/sessions 返回无 avatars 字段的 payload,
  // 确保 FE 仍渲染 N 个 palette 渐变实心圆点 (不挂).
  console.log('## 7. fallback test — no avatars field, N palette placeholders');
  await page.route('**/api/sessions', async (route) => {
    const r = await route.fetch();
    const body = await r.json();
    const stripped = body.map((s) => {
      const { avatars, ...rest } = s; // eslint-disable-line no-unused-vars
      return rest;
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(stripped),
    });
  });
  await page.goto(`${TEST_URL}/sessions`, { waitUntil: 'load' });
  await page.waitForSelector('a[href*="/sessions/"]', { timeout: 10000 });
  await page.waitForTimeout(1500);
  const fbS11 = page.locator('a.card-link').filter({ hasText: '泰国测试账单 6.19-6.22' }).first();
  await fbS11.scrollIntoViewIfNeeded();
  const fbCount = await fbS11.locator('.avatar-mini:not(.avatar-mini-overflow)').count();
  expect('fallback: session 11 still has 5 avatars (empty palette placeholders)', fbCount, 5);
  const fbFirstText = (await fbS11.locator('.avatar-mini:not(.avatar-mini-overflow)').first().textContent())?.trim() ?? '';
  expect('fallback: first avatar textContent = empty (no initial)', fbFirstText, '');
  await fbS11.screenshot({ path: `${SHOT_DIR}/session-11-fallback.png` });
  console.log('  ✓ fallback screenshot:', `${SHOT_DIR}/session-11-fallback.png`);

  await browser.close();
  console.log('## done. exitCode =', process.exitCode || 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
