// v0.3.x UAT 0723-3 #2 续 verify — anon path SessionPreviewMember.email
//
// 修法: BE SessionPreviewMember 加 email: str | None = None + helper 联表填
// User.email; FE SessionMemberPreview interface 加 email?: string | null.
//
// 1. anon 模式 navigate /sessions/9/join?token=thailand2-test-2026-07-23-xinhua
// 2. getSession() 403 → fallback getSessionPreview() → 返回 members[].email
// 3. DOM 检查 takenSlots (5 个, 都 bound):
//    - 每 slot 有 .slot-email-muted, textContent = "已被 {maskEmail} 绑定"
//    - 任意 slot 都不能含 "undefined"
//    - mask 正确: demo@example.com → xin***@outlook.com
// 4. BE /sessions/9/preview 返回 members[].email 字段 (直接 API 验)
// 5. 截图存 ~/.openclaw/media/browser/v0723-3-2-anon-email/

const { chromium } = require('playwright');
const fs = require('fs');

const TEST_URL = 'https://test.jessejia.pp.ua';
const SHOT_DIR = `${process.env.HOME}/.openclaw/media/browser/v0723-3-2-anon-email`;
fs.mkdirSync(SHOT_DIR, { recursive: true });

const SESSION_ID = 9;
const SESSION_TOKEN = 'thailand2-test-2026-07-23-xinhua';
// 5 bound members in session 9 (按 id ASC: Jesse/Ju/Canyina/Q/像汤圆一样圆.)
// 期望 mask: local-prefix(3) + *** + @ + full domain
const EXPECTED_TAKEN = [
  { name: 'Jesse',          email: 'demo@example.com',  masked: 'xin***@outlook.com' },
  { name: 'Ju',             email: 'ju@thailand.local',       masked: 'ju***@thailand.local' },
  { name: 'Canyina',        email: 'canyina@thailand.local',  masked: 'can***@thailand.local' },
  { name: 'Q',              email: 'q@thailand.local',        masked: 'q***@thailand.local' },
  { name: '像汤圆一样圆.',    email: 'rounded@thailand.local',  masked: 'rou***@thailand.local' },
];

function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? '✓' : '✗'} ${label}: got=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  // v0.3.x UAT 0723-3 #2 续: anon 模式 — 没有 cookie, 没有 localStorage actingAs,
  // 没有 X-Nickname-Secret header. storageState 清空保证干净.
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    locale: 'zh-CN',
    storageState: { cookies: [], origins: [] },
  });
  const page = await ctx.newPage();

  // --- 1. anon navigate /sessions/9/join ---
  console.log('## 1. anon navigate /sessions/' + SESSION_ID + '/join?token=' + SESSION_TOKEN);
  await page.goto(`${TEST_URL}/sessions/${SESSION_ID}/join?token=${SESSION_TOKEN}`, {
    waitUntil: 'load',
  });
  // 等 page mount + preview 加载
  await page.waitForSelector('.slot-list', { timeout: 10000 });
  await page.waitForTimeout(1500); // 等 reactive 派生
  console.log('  ✓ page loaded, .slot-list found');

  // --- 2. BE /sessions/9/preview API 验证 ---
  console.log('## 2. BE /api/sessions/' + SESSION_ID + '/preview — verify members[].email');
  const preview = await page.evaluate(async (sid) => {
    const r = await fetch(`/api/sessions/${sid}/preview`, { credentials: 'omit' });
    return await r.json();
  }, SESSION_ID);
  if (!preview || !Array.isArray(preview.members)) {
    console.error('  ✗ preview response invalid:', preview);
    process.exit(2);
  }
  expect('preview member count = 5', preview.members.length, 5);
  // 验证每 member 有 email 字段 (anon path 必须拿到才能渲染)
  for (let i = 0; i < preview.members.length; i++) {
    const m = preview.members[i];
    const exp = EXPECTED_TAKEN[i];
    expect(`member[${i}] (${m.display_name}) email`, m.email, exp.email);
  }
  console.log('  ✓ BE preview returns email for all bound members');

  // --- 3. DOM 检查 takenSlots ---
  console.log('## 3. DOM check: takenSlots all show "已被 {masked} 绑定"');
  // anon user sees: user=null → availableSlots = user_id===null (0 here),
  //                 takenSlots = user_id!==null (5 here)
  // .slot-btn.taken = display-only span (灰色, in takenSlots section)
  const takenSpans = page.locator('.slot-btn.taken');
  const takenCount = await takenSpans.count();
  expect('anon takenSlots count = 5', takenCount, 5);

  const takenTexts = [];
  for (let i = 0; i < takenCount; i++) {
    const txt = (await takenSpans.nth(i).textContent()) ?? '';
    takenTexts.push(txt.trim());
  }
  console.log('  taken slot texts:', JSON.stringify(takenTexts, null, 2));

  // 必须不含 "undefined"
  for (let i = 0; i < takenCount; i++) {
    expect(`takenSlot[${i}] does NOT contain 'undefined'`,
      takenTexts[i].includes('undefined'), false);
  }

  // 每 slot 含 "已被 {expected_masked} 绑定"
  for (let i = 0; i < takenCount; i++) {
    const expectedFragment = '已被 ' + EXPECTED_TAKEN[i].masked + ' 绑定';
    expect(`takenSlot[${i}] (${EXPECTED_TAKEN[i].name}) contains "${expectedFragment}"`,
      takenTexts[i].includes(expectedFragment), true);
  }
  console.log('  ✓ all 5 takenSlots have correct masked email binding text');

  // --- 4. DOM 检查 .slot-email-muted 元素 ---
  console.log('## 4. .slot-email-muted element check');
  const emailMuteds = page.locator('.slot-email-muted');
  const mutedCount = await emailMuteds.count();
  expect('.slot-email-muted count = 5', mutedCount, 5);
  for (let i = 0; i < mutedCount; i++) {
    const txt = ((await emailMuteds.nth(i).textContent()) ?? '').trim();
    expect(`.slot-email-muted[${i}] text`, txt,
      '已被 ' + EXPECTED_TAKEN[i].masked + ' 绑定');
  }

  // --- 5. 头像首字母 ---
  console.log('## 5. avatar initial letters in taken slots');
  const expectedInitials = ['J', 'J', 'C', 'Q', '像'];
  const avatars = page.locator('.slot-btn.taken .slot-avatar');
  const avatarCount = await avatars.count();
  expect('taken avatar count = 5', avatarCount, 5);
  for (let i = 0; i < avatarCount; i++) {
    const t = ((await avatars.nth(i).textContent()) ?? '').trim();
    expect(`avatar[${i}] initial`, t, expectedInitials[i]);
  }

  // --- 6. main page screenshot ---
  console.log('## 6. screenshot takenSlots section');
  await page.screenshot({
    path: `${SHOT_DIR}/01-anon-join-session-9.png`,
    fullPage: false,
  });
  console.log('  ✓ screenshot:', `${SHOT_DIR}/01-anon-join-session-9.png`);

  // scroll down to capture any "或" divider / add-new section
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);
  await page.screenshot({
    path: `${SHOT_DIR}/02-anon-join-bottom.png`,
    fullPage: false,
  });
  console.log('  ✓ screenshot:', `${SHOT_DIR}/02-anon-join-bottom.png`);

  // --- 7. fullPage screenshot ---
  console.log('## 7. fullPage screenshot');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  await page.screenshot({
    path: `${SHOT_DIR}/03-anon-join-fullpage.png`,
    fullPage: true,
  });
  console.log('  ✓ screenshot:', `${SHOT_DIR}/03-anon-join-fullpage.png`);

  await browser.close();
  console.log('## done. exitCode =', process.exitCode || 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
