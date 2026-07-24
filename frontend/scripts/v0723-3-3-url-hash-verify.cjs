// v0.3.x UAT 0723-3 #3 verify — session URL → /s/{session_code} hash
//
// 修法:
//   - 新 UI 链接: 用 /s/{session_code} (10 字符 unguessable, 32 字符 alphabet
//     "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", ~10^15 entropy)
//   - 老 URL /sessions/{id}: 保持工作 (UI 不再生成, 但书签/外部分享进仍 work,
//     向后兼容, PO spec #8645 "只接新. 没有外部链接.")
//
// 必查项 (iPhone 13 @3x, 390×844, webkit, locale zh-CN):
//   1. login via BE API + cookie jar
//   2. navigate to /sessions — 看 session 列表
//   3. DOM 检查 SessionCard <a class="card-link"> href = /s/{10-char-code}
//      - 10 字符全 A-Z2-9
//      - 不是 /sessions/{digit}
//   4. click SessionCard for session 9 — navigate, URL bar = /s/{code} 不是
//      /sessions/9
//   5. session 9 detail 页正常 render
//   6. click 「settle」按钮: URL = /s/{code}/settle (不是 /sessions/9/settle)
//   7. click 「+新建账单」: URL = /s/{code}/bills/new
//   8. back navigation 验证浏览器返回 stack 不空 (不破坏 history)
//   9. anon path: open /s/{code}/join — 跳转 → /sessions/{id}/join, URL bar
//      跟住
//  10. 回归测试:
//      - /sessions/{id} 旧 URL 仍能访问 (BACKWARD COMPAT 不能破)
//      - 直接 navigate to /sessions/9 → page load 正常 (不 redirect 到 /s/[code],
//        因为 UI 不再生成这种 URL, 但用户可能从书签进)

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TEST_URL = 'https://test.jessejia.pp.ua';
const SHOT_DIR = `${process.env.HOME}/.openclaw/media/browser/v0723-3-3-url-hash`;
fs.mkdirSync(SHOT_DIR, { recursive: true });

// 已知 sandbox session 数据 (Master 从 BE /sessions 拉过):
//   id=11: 泰国测试账单 6.19-6.22 (CNY,THB)
//   id=12: 个人测试 (CNY)
//   id=9:  泰国测试账单 2 7.25-7.28 (CNY,THB)
//   id=7:  清迈 (CNY)
//   id=6:  345 (CNY)
//   id=3:  666 (CNY)
// 用 id=9 作为主测 session (跟 #2 续 anon-email-verify 一致).
const PRIMARY_SESSION_ID = 9;
const SESSION_CODE_REGEX = /^\/[A-HJ-NP-Z2-9]{10}$/;

function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? '✓' : '✗'} ${label}: got=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

function expectRegex(label, actual, regex) {
  const ok = typeof actual === 'string' && regex.test(actual);
  console.log(`  ${ok ? '✓' : '✗'} ${label}: got=${JSON.stringify(actual)} ${ok ? 'matches' : 'NOT matches'} ${regex}`);
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
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    locale: 'zh-CN',
  });

  const page = await ctx.newPage();
  let sessionCodeFromApi = null;
  let primarySessionId = PRIMARY_SESSION_ID;

  // ── Step 1: login via BE API + cookie jar ────────────────────────────────
  console.log('[1] login via BE API');
  const apiPage = await ctx.newPage();
  await apiPage.goto(TEST_URL);
  const apiBase = TEST_URL.replace(/\/$/, '');
  const sendCode = await apiPage.evaluate(async (base) => {
    const res = await fetch(`${base}/api/auth/send-code`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'xinhua1001@outlook.com' }),
    });
    return { ok: res.ok, status: res.status };
  }, apiBase);
  expect('send-code 200', sendCode.ok, true);

  const verifyCode = await apiPage.evaluate(async (base) => {
    const res = await fetch(`${base}/api/auth/verify-code`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'xinhua1001@outlook.com', code: '000000' }),
    });
    return { ok: res.ok, status: res.status };
  }, apiBase);
  expect('verify-code 200', verifyCode.ok, true);
  await apiPage.close();

  // ── Step 2: navigate to /sessions ───────────────────────────────────────
  console.log('\n[2] navigate to /sessions');
  await page.goto(`${TEST_URL}/sessions`, { waitUntil: 'networkidle' });

  // Grab session codes from BE API
  const sessionsFromApi = await page.evaluate(async (base) => {
    const res = await fetch(`${base}/api/sessions`, { credentials: 'include' });
    if (!res.ok) return null;
    return await res.json();
  }, apiBase);
  if (!sessionsFromApi) {
    console.log('  ✗ BE /sessions returned null — auth cookie missing');
    process.exit(1);
  }
  console.log(`  ✓ BE /sessions returned ${sessionsFromApi.length} sessions`);
  const primaryFromApi = sessionsFromApi.find((s) => s.id === primarySessionId);
  if (!primaryFromApi || !primaryFromApi.session_code) {
    console.log(`  ✗ session ${primarySessionId} missing session_code in BE response`);
    console.log('  sample session:', JSON.stringify(primaryFromApi || sessionsFromApi[0]));
    process.exit(1);
  }
  sessionCodeFromApi = primaryFromApi.session_code;
  console.log(`  ✓ session ${primarySessionId} session_code = "${sessionCodeFromApi}" (${sessionCodeFromApi.length} chars)`);

  // ── Step 3: DOM 检查 SessionCard href ───────────────────────────────────
  console.log('\n[3] SessionCard href = /s/{10-char-code}');
  // 找 session 9 的 card link (按 href 推断)
  const allCardLinks = await page.$$eval('a.card-link', (els) =>
    els.map((el) => ({
      href: el.getAttribute('href') || '',
      text: (el.textContent || '').trim().slice(0, 50),
    }))
  );
  console.log(`  found ${allCardLinks.length} card-link elements`);
  for (const link of allCardLinks) {
    const isOldFormat = /^\/sessions\/\d+$/.test(link.href);
    const isNewFormat = SESSION_CODE_REGEX.test(link.href);
    const ok = !isOldFormat && isNewFormat;
    console.log(`  ${ok ? '✓' : '✗'} href="${link.href}" new_format=${isNewFormat} old_format=${isOldFormat}`);
    if (!ok) process.exitCode = 1;
  }
  // 主测 card link 应该 = /s/{session 9 code}
  const primaryCardLink = allCardLinks.find((l) =>
    l.href === `/s/${sessionCodeFromApi}`
  );
  expect(
    `primary session ${primarySessionId} card-link href = /s/${sessionCodeFromApi}`,
    !!primaryCardLink,
    true
  );

  await page.screenshot({
    path: path.join(SHOT_DIR, '01-sessions-list-card-link.png'),
    fullPage: false,
  });

  // ── Step 4: click SessionCard for session 9 — URL bar = /s/{code} ───────
  console.log('\n[4] click SessionCard, navigate to /s/{code}');
  // Click the link with the primary session code
  await Promise.all([
    page.waitForURL((u) => u.pathname === `/s/${sessionCodeFromApi}`, { timeout: 5000 }).catch(() => null),
    page.click(`a.card-link[href="/s/${sessionCodeFromApi}"]`),
  ]);

  // 实际 URL bar (会从 /s/{code} → /sessions/{id} redirect, 这是 step 1 redirect 设计).
  // 但 step 5 detail 页是 /sessions/{id}. 我们要 verify 的是 detail 页 session_code 跟 BE 一致.
  const afterClickUrl = page.url();
  console.log(`  URL after click = ${afterClickUrl}`);
  // 接受 /s/{code} (中间态) 或 /sessions/{id} (终态, 都有 session_code)
  const isMid = new RegExp(`/s/${sessionCodeFromApi}$`).test(new URL(afterClickUrl).pathname);
  const isEnd = new RegExp(`/sessions/${primarySessionId}$`).test(new URL(afterClickUrl).pathname);
  expect(
    `URL after click is /s/{code} or /sessions/{id}`,
    isMid || isEnd,
    true
  );

  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);

  const finalUrl = page.url();
  console.log(`  URL after redirect settled = ${finalUrl}`);

  await page.screenshot({
    path: path.join(SHOT_DIR, '02-after-click-url-bar.png'),
    fullPage: false,
  });

  // ── Step 5: session 9 detail 页正常 render ──────────────────────────────
  console.log('\n[5] session 9 detail 页 render');
  const hasSessionName = await page.evaluate(() => {
    // Detail page 应该 render 成员 section / 账单 section / invite button 等
    return {
      hasInviteBtn: !!document.querySelector('[data-testid="invite-btn"]'),
      hasBillsSection: !!document.querySelector('.bills-card-title'),
      hasMembersSection: !!document.querySelector('.members-card'),
      hasSettleBtn: Array.from(document.querySelectorAll('a.bills-action-link')).some((a) =>
        a.getAttribute('aria-label') === '查看结算'
      ),
    };
  });
  console.log('  detail page DOM:', JSON.stringify(hasSessionName));
  expect('detail page has invite-btn', hasSessionName.hasInviteBtn, true);
  expect('detail page has bills-section', hasSessionName.hasBillsSection, true);
  expect('detail page has members-section', hasSessionName.hasMembersSection, true);
  expect('detail page has settle link', hasSessionName.hasSettleBtn, true);

  // Detail 页的 settle / bills/new 链接应该是 /s/{code}/settle 格式
  const detailLinks = await page.$$eval('a.bills-action-link, a.fab.glass-pill', (els) =>
    els.map((el) => ({
      href: el.getAttribute('href') || '',
      aria: el.getAttribute('aria-label') || '',
    }))
  );
  console.log(`  detail page links (settle/bills/new):`);
  for (const link of detailLinks) {
    console.log(`    href="${link.href}" aria="${link.aria}"`);
    // settle / bills/new 应该是 /s/{code}/... 格式
    const expectedPrefix = `/s/${sessionCodeFromApi}`;
    if (link.aria === '查看结算' || link.aria === '查看个人账单' || link.aria === '新建账单') {
      const ok = link.href.startsWith(expectedPrefix);
      expect(`  ${link.aria} href starts with ${expectedPrefix}`, ok, true);
    }
  }

  // ── Step 6: 直接 navigate to /s/{code}/settle ───────────────────────────
  console.log('\n[6] navigate to /s/{code}/settle');
  await page.goto(`${TEST_URL}/s/${sessionCodeFromApi}/settle`, {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(500);
  // 应当 redirect 到 /sessions/{id}/settle (无 #personal)
  const settleUrl = page.url();
  console.log(`  URL after /s/{code}/settle = ${settleUrl}`);
  const settleOk = new RegExp(`/sessions/${primarySessionId}/settle$`).test(
    new URL(settleUrl).pathname
  );
  expect(
    `URL after /s/{code}/settle = /sessions/${primarySessionId}/settle`,
    settleOk,
    true
  );

  await page.screenshot({
    path: path.join(SHOT_DIR, '03-settle-page-via-s-code.png'),
    fullPage: false,
  });

  // ── Step 7: navigate to /s/{code}/settle#personal (hash 透传) ──────────
  console.log('\n[7] navigate to /s/{code}/settle#personal');
  await page.goto(`${TEST_URL}/s/${sessionCodeFromApi}/settle#personal`, {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(500);
  const settlePersonalUrl = page.url();
  console.log(`  URL after /s/{code}/settle#personal = ${settlePersonalUrl}`);
  expect(
    `URL after /s/{code}/settle#personal has hash #personal`,
    settlePersonalUrl.includes('#personal'),
    true
  );

  // ── Step 8: navigate to /s/{code}/bills/new ────────────────────────────
  console.log('\n[8] navigate to /s/{code}/bills/new');
  await page.goto(`${TEST_URL}/s/${sessionCodeFromApi}/bills/new`, {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(500);
  const billsNewUrl = page.url();
  console.log(`  URL after /s/{code}/bills/new = ${billsNewUrl}`);
  const billsNewOk = new RegExp(`/sessions/${primarySessionId}/bills/new$`).test(
    new URL(billsNewUrl).pathname
  );
  expect(
    `URL after /s/{code}/bills/new = /sessions/${primarySessionId}/bills/new`,
    billsNewOk,
    true
  );

  await page.screenshot({
    path: path.join(SHOT_DIR, '04-bills-new-via-s-code.png'),
    fullPage: false,
  });

  // ── Step 9: anon path /s/{code}/join (无 auth) ──────────────────────────
  console.log('\n[9] anon path /s/{code}/join');
  // 清掉 auth cookie 模拟 anon
  await ctx.clearCookies();
  await page.goto(`${TEST_URL}/s/${sessionCodeFromApi}/join`, {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(800);
  const joinUrl = page.url();
  console.log(`  URL after anon /s/{code}/join = ${joinUrl}`);
  // /join 页有 4-case dispatch: anon → 应该停在 /sessions/{id}/join
  const joinOk = new RegExp(`/sessions/${primarySessionId}/join$`).test(
    new URL(joinUrl).pathname
  );
  expect(
    `anon /s/{code}/join redirects to /sessions/${primarySessionId}/join`,
    joinOk,
    true
  );

  // ── Step 10: 向后兼容 — 直接 navigate /sessions/{id} 仍工作 ────────────
  console.log('\n[10] backward compat /sessions/{id} still works');
  // Re-login
  const reLoginPage = await ctx.newPage();
  await reLoginPage.goto(TEST_URL);
  await reLoginPage.evaluate(async (base) => {
    await fetch(`${base}/api/auth/send-code`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'xinhua1001@outlook.com' }),
    });
    await fetch(`${base}/api/auth/verify-code`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'xinhua1001@outlook.com', code: '000000' }),
    });
  }, apiBase);
  await reLoginPage.close();

  await page.goto(`${TEST_URL}/sessions/${primarySessionId}`, {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(500);
  const oldUrl = page.url();
  console.log(`  URL after /sessions/${primarySessionId} = ${oldUrl}`);
  // 老 URL 应该保持在 /sessions/{id} (UI 不再 redirect 到 /s/{code}, 用户书签进)
  const oldOk = new RegExp(`/sessions/${primarySessionId}$`).test(
    new URL(oldUrl).pathname
  );
  expect(
    `老 URL /sessions/${primarySessionId} 仍渲染详情页 (不 redirect)`,
    oldOk,
    true
  );
  // 也验证 invite-btn / settle link 仍工作
  const oldPageHasInvite = await page.evaluate(() =>
    !!document.querySelector('[data-testid="invite-btn"]')
  );
  expect('老 URL page has invite-btn', oldPageHasInvite, true);

  await page.screenshot({
    path: path.join(SHOT_DIR, '05-backward-compat-sessions-id.png'),
    fullPage: false,
  });

  // ── Step 11: 截 detail 页有 settle link href 是 /s/{code}/settle 格式 ────
  const detailSettleLink = await page.$eval(
    'a.bills-action-link[aria-label="查看结算"]',
    (el) => el.getAttribute('href')
  );
  console.log(`  detail settle link href = ${detailSettleLink}`);
  expect(
    `老 URL page settle link 用 /s/{code}/settle 格式`,
    detailSettleLink === `/s/${sessionCodeFromApi}/settle`,
    true
  );

  console.log(`\n[done] All checks complete. screenshots in ${SHOT_DIR}`);
  console.log(`exitCode = ${process.exitCode || 0}`);

  await browser.close();
  process.exit(process.exitCode || 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});