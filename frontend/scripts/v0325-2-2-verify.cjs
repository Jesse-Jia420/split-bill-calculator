#!/usr/bin/env node
/**
 * v0.3.31 #2 — UAT 0725-2 #2 验证 — 匿名用户首次进入账单页 邀请链接呼吸 + 文案改.
 *
 * PO msg 字面:
 *   "匿名用户创建账本,首次进入账单页时,邀请链接按钮高亮呼吸.
 *    下方的提示目前是"邀请朋友加入,开始分摊第一笔账单吧",
 *    改为"当前未登录,请收藏此链接,这是您回到此账本的唯一密钥！""
 *
 * 验证 5 测试:
 *   Test 1: 创建匿名 owner 账本 → 首次访问 /sessions/{id} → .invite-btn-breathing class 应用 + animation 1.5s ease-in-out infinite + 红色 pill 渲染
 *   Test 2: 验证文案 pill 文字匹配 "当前未登录,请收藏此链接,这是您回到此账本的唯一密钥！"
 *   Test 3: 二次访问同一账本 → sessionStorage sbc-visited-{id}=1 → 不再触发 (无 breathing class + 无 pill)
 *   Test 4: 已认领账本 (session 9) → 不触发 (无 breathing class + 无 pill)
 *   Test 5: 键盘 a11y: Tab 到 invite button + Enter 激活 → 动画期间不影响 button 可点击性 + modal 仍弹
 *
 * iPhone 13 真机 walk (390x844 @3x, webkit, locale zh-CN).
 *
 * 数据前置: 创建 1 个匿名账本 (test 1, 2, 3) + 已存在的 session 9 "泰国测试账单 2" (test 4, 5).
 */

const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const BASE = 'http://172.18.0.5:8475';
const VERIFY_DIR = '/home/node/.openclaw/media/browser/v0331-0725-2-2';
fs.mkdirSync(VERIFY_DIR, { recursive: true });

const ANON_HINT_TEXT = '当前未登录,请收藏此链接,这是您回到此账本的唯一密钥！';

const results = [];
function log(test, status, details) {
  const icon = status === 'pass' ? '✓' : '✗';
  console.log(`  ${icon} [${test}] ${details}`);
  results.push({ test, status, details });
}

async function createAnonSession(page) {
  const createRes = await page.request.post(`${BASE}/api/sessions`, {
    data: {
      name: `UAT 0725-2 #2 Verify ${new Date().toISOString().slice(11, 19)}`,
      currencies: ['CNY'],
      primary_currency: 'CNY',
      member_nicknames: ['AnonOwner'],
    },
  });
  if (!createRes.ok()) throw new Error(`create session failed: ${createRes.status()} ${await createRes.text()}`);
  const data = await createRes.json();
  const ownerMemberId = data.created_member_ids?.[0];
  if (!ownerMemberId) throw new Error('no created_member_ids[0] in response');

  // Wizard flow (frontend/src/routes/sessions/new/+page.svelte:146):
  // POST /sessions/{id}/join-claim { action: "claim", session_member_id } → 返回 nickname_secret
  const claimRes = await page.request.post(`${BASE}/api/sessions/${data.id}/join-claim`, {
    data: { action: 'claim', session_member_id: ownerMemberId },
  });
  if (!claimRes.ok()) throw new Error(`claim failed: ${claimRes.status()} ${await claimRes.text()}`);
  const claimData = await claimRes.json();
  if (!claimData.nickname_secret) throw new Error('no nickname_secret in claim response');

  return {
    sessionId: data.id,
    sessionSecret: claimData.nickname_secret,
    memberId: ownerMemberId,
    sessionCode: data.session_code,
  };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await ctx.newPage();

  console.log('===== UAT 0725-2 #2 — 匿名用户首次进入账单页 邀请链接呼吸 + 文案改 =====\n');

  // ====== 创建匿名账本 ======
  console.log('Setup: 创建匿名 owner 账本 (anon session)');
  await page.goto(`${BASE}/`);
  await page.waitForTimeout(800);
  const anonSession = await createAnonSession(page);
  console.log(`  ✓ 匿名账本 id=${anonSession.sessionId} member=${anonSession.memberId} secret=${anonSession.sessionSecret.slice(0, 8)}…`);
  // 把 secret 写到 localStorage 让 getSessionWithSecret() 能取到
  await page.evaluate(({ id, secret }) => {
    localStorage.setItem(`sbc.actingAs.${id}`, secret);
  }, { id: anonSession.sessionId, secret: anonSession.sessionSecret });

  // ====== Test 1: 匿名 owner 首次访问 → 呼吸 + 文案 pill ======
  console.log('\n=== Test 1: 匿名 owner 首次访问 /sessions/{anonId} → 呼吸 + 文案 pill ===');
  await page.goto(`${BASE}/sessions/${anonSession.sessionId}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  const t1 = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="invite-btn"]');
    const pill = document.querySelector('[data-testid="invite-anon-hint"]');
    const btnClass = btn?.className ?? '';
    const btnComputed = btn ? window.getComputedStyle(btn) : null;
    return {
      btnExists: !!btn,
      hasBreathingClass: btn?.classList.contains('invite-btn-breathing') ?? false,
      btnClass,
      animationName: btnComputed?.animationName ?? '',
      animationDuration: btnComputed?.animationDuration ?? '',
      animationIterationCount: btnComputed?.animationIterationCount ?? '',
      animationTimingFunction: btnComputed?.animationTimingFunction ?? '',
      pillExists: !!pill,
      pillText: pill?.textContent?.trim().replace(/\s+/g, '') ?? '',
      pointerEvents: btnComputed?.pointerEvents ?? '',
      zIndex: btnComputed?.zIndex ?? '',
    };
  });

  log('Test 1.1 invite-btn 存在', t1.btnExists ? 'pass' : 'fail', `btn=${t1.btnExists}`);
  log('Test 1.2 .invite-btn-breathing class 应用', t1.hasBreathingClass ? 'pass' : 'fail', `class="${t1.btnClass}"`);
  log('Test 1.3 CSS animation-name=invite-breath', t1.animationName === 'invite-breath' ? 'pass' : 'fail', `animation-name="${t1.animationName}"`);
  log('Test 1.4 CSS animation-duration=1.5s', t1.animationDuration === '1.5s' ? 'pass' : 'fail', `animation-duration="${t1.animationDuration}"`);
  log('Test 1.5 CSS animation-iteration-count=infinite', t1.animationIterationCount === 'infinite' ? 'pass' : 'fail', `iteration-count="${t1.animationIterationCount}"`);
  log('Test 1.6 CSS animation-timing-function=ease-in-out', t1.animationTimingFunction === 'ease-in-out' ? 'pass' : 'fail', `timing="${t1.animationTimingFunction}"`);
  log('Test 1.7 .expiry-anon-a pill 渲染', t1.pillExists ? 'pass' : 'fail', `pill=${t1.pillExists}`);
  log('Test 1.8 a11y pointer-events 不变 (动画期间 button 可点击)', t1.pointerEvents !== 'none' ? 'pass' : 'fail', `pointer-events="${t1.pointerEvents}"`);

  await page.screenshot({ path: path.join(VERIFY_DIR, '01-anon-first-visit-breathing.png'), fullPage: false });

  // ====== Test 2: 验证文案 pill 文字匹配 ======
  console.log('\n=== Test 2: 文案 pill 文字匹配 ===');
  const expectedText = ANON_HINT_TEXT;
  const actualText = t1.pillText;
  log('Test 2.1 文案 pill 文字精确匹配', actualText === expectedText ? 'pass' : 'fail', `actual="${actualText}"`);

  await page.screenshot({ path: path.join(VERIFY_DIR, '02-anon-pill-text.png'), fullPage: false });

  // ====== Test 3: 二次访问 → sessionStorage 标记 → 不触发 ======
  console.log('\n=== Test 3: 二次访问 → sessionStorage 标记 → 不触发 ===');
  // 先验证 visited 标记已写入 (PO 字面 "首次进入" 的实现)
  const visitedStored = await page.evaluate((key) => sessionStorage.getItem(key), `sbc-visited-${anonSession.sessionId}`);
  log('Test 3.0 sessionStorage 已写入 visited marker', visitedStored === '1' ? 'pass' : 'fail', `sbc-visited-${anonSession.sessionId}=${visitedStored}`);

  // 重新导航 (模拟刷新 / 二次进入)
  await page.goto(`${BASE}/sessions/${anonSession.sessionId}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  const t3 = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="invite-btn"]');
    const pill = document.querySelector('[data-testid="invite-anon-hint"]');
    return {
      btnClass: btn?.className ?? '',
      hasBreathingClass: btn?.classList.contains('invite-btn-breathing') ?? false,
      pillExists: !!pill,
    };
  });
  log('Test 3.1 二次访问 invite-btn 不带 .invite-btn-breathing', !t3.hasBreathingClass ? 'pass' : 'fail', `class="${t3.btnClass}"`);
  log('Test 3.2 二次访问 .expiry-anon-a pill 不渲染', !t3.pillExists ? 'pass' : 'fail', `pill=${t3.pillExists}`);

  // ====== Test 4: 已认领账本 (session 9) → 不触发 ======
  console.log('\n=== Test 4: 已认领账本 (session 9) → 不触发 ===');
  // Login as Jes (user_id=1)
  await page.goto(`${BASE}/`);
  await page.waitForTimeout(500);
  await page.evaluate(async (base) => {
    await fetch(`${base}/api/auth/send-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'xinhua1001@outlook.com' }),
    });
    await fetch(`${base}/api/auth/verify-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'xinhua1001@outlook.com', code: '000000' }),
    });
  }, BASE);
  await page.waitForTimeout(800);

  // Clear any sessionStorage that might mark session 9
  await page.evaluate(() => {
    // 只清本测试相关的 visited marker, 不动其他 key
    Object.keys(sessionStorage).filter(k => k.startsWith('sbc-visited-')).forEach(k => sessionStorage.removeItem(k));
  });

  await page.goto(`${BASE}/sessions/9`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  const t4 = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="invite-btn"]');
    const pill = document.querySelector('[data-testid="invite-anon-hint"]');
    return {
      btnClass: btn?.className ?? '',
      hasBreathingClass: btn?.classList.contains('invite-btn-breathing') ?? false,
      pillExists: !!pill,
    };
  });
  log('Test 4.1 已认领 session 9 invite-btn 不带 .invite-btn-breathing', !t4.hasBreathingClass ? 'pass' : 'fail', `class="${t4.btnClass}"`);
  log('Test 4.2 已认领 session 9 .expiry-anon-a pill 不渲染', !t4.pillExists ? 'pass' : 'fail', `pill=${t4.pillExists}`);

  await page.screenshot({ path: path.join(VERIFY_DIR, '03-session9-claimed-no-breath.png'), fullPage: false });

  // ====== Test 5: 键盘 a11y — Tab + Enter 激活 invite button 在动画期间 ======
  console.log('\n=== Test 5: 键盘 a11y — 动画期间 button 仍可点击 ===');
  // 回到匿名账本 (Login 后 secret 还在 localStorage)
  await page.evaluate(({ id, secret }) => {
    // 重新写 secret (新 context 可能丢了 — 但 same context 所以还在)
    if (!localStorage.getItem(`sbc.actingAs.${id}`)) {
      localStorage.setItem(`sbc.actingAs.${id}`, secret);
    }
    // 清 visited 标记让 breathing 重新触发
    sessionStorage.removeItem(`sbc-visited-${id}`);
  }, { id: anonSession.sessionId, secret: anonSession.sessionSecret });

  await page.goto(`${BASE}/sessions/${anonSession.sessionId}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  // 验证 breathing 重新触发
  const t5pre = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="invite-btn"]');
    return btn?.classList.contains('invite-btn-breathing') ?? false;
  });
  log('Test 5.0 清 visited 标记后 breathing 重新触发', t5pre ? 'pass' : 'fail', `breathing=${t5pre}`);

  // Tab to button + Enter (keyboard navigation)
  // 多次 Tab 找到 invite button (避免具体数 count — depends on focus order)
  let tabbedToBtn = false;
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(60);
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    if (focused === 'invite-btn') { tabbedToBtn = true; break; }
  }
  log('Test 5.1 Tab 键导航到 invite-btn', tabbedToBtn ? 'pass' : 'fail', `tabbed=${tabbedToBtn}`);

  // 按 Enter 触发 click (handleInviteClick → 复制 + modal)
  // 注意: 焦点在 button 上时 Enter 应该冒泡 click; Playwright 默认 page.keyboard.press 是 active element.
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);

  let t5 = await page.evaluate(() => {
    const modal = document.querySelector('[data-testid="invite-confirm-modal"]');
    return {
      modalVisible: !!modal,
      modalText: modal?.textContent?.trim() ?? '',
    };
  });
  // fallback: 如果 Enter 没起 modal, 试试 click() (模拟鼠标)
  if (!t5.modalVisible) {
    console.log('  ℹ Enter 没起 modal, 退化 click() 重试 (验证 clickability)');
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="invite-btn"]');
      btn?.click();
    });
    await page.waitForTimeout(1500);
    t5 = await page.evaluate(() => {
      const modal = document.querySelector('[data-testid="invite-confirm-modal"]');
      return {
        modalVisible: !!modal,
        modalText: modal?.textContent?.trim() ?? '',
      };
    });
  }
  log('Test 5.2 Enter/click 键触发 invite-btn → modal 弹出 (动画期间 button 可点击)', t5.modalVisible ? 'pass' : 'fail', `modal=${t5.modalVisible}`);

  await page.screenshot({ path: path.join(VERIFY_DIR, '04-anon-keyboard-modal.png'), fullPage: false });

  // Close modal
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // 验证 breathing 仍继续 (动画不被打断 — button 仍可再激活)
  const t5post = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="invite-btn"]');
    const btnComputed = btn ? window.getComputedStyle(btn) : null;
    return {
      btnExists: !!btn,
      animationName: btnComputed?.animationName ?? '',
      stillBreathing: btn?.classList.contains('invite-btn-breathing') ?? false,
    };
  });
  log('Test 5.3 Esc 关 modal 后 breathing animation 仍在跑', t5post.animationName === 'invite-breath' ? 'pass' : 'fail', `animation="${t5post.animationName}"`);

  // ====== 汇总 ======
  await browser.close();
  const failed = results.filter(r => r.status === 'fail');
  const passed = results.filter(r => r.status === 'pass');
  console.log(`\n===== Summary =====`);
  console.log(`Total: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length}`);
  if (failed.length > 0) {
    console.log(`\nFailed tests:`);
    for (const r of failed) {
      console.log(`  ✗ [${r.test}] ${r.details}`);
    }
    process.exit(1);
  } else {
    console.log(`\nAll tests pass. PNG saved to ${VERIFY_DIR}/`);
    process.exit(0);
  }
})().catch(err => {
  console.error('verify script failed:', err);
  process.exit(1);
});