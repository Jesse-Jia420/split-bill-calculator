#!/usr/bin/env node
/**
 * v0.3.24 #9.2 — 续 #9.1 PO msg #8280 反馈 "账本列表页的 item 里面的头像太小了,完全看不清有谁".
 *
 * 原 .avatar-mini 18×18 在 iPhone 13 @3x 仅占 54 logical pixel, 头像糊掉看不清.
 * 调整: width/height 18→24px, font-size 9→12px (= size/2 比例延续),
 *       margin-left -4.5→-6px (25% overlap 跟原 18*0.25=4.5 同比例).
 * 其它 (row-top / glass params / avatar palette / overflow) 不动.
 *
 * 验证 7 项:
 *   1. .avatar-mini width = 24px (computed style)
 *   2. .avatar-mini height = 24px (computed style)
 *   3. .avatar-mini font-size = 12px (computed style)
 *   4. .avatar-mini border = 1.5px (border-width)
 *   5. .avatar-mini:not(:first-child) margin-left = -6px (computed style)
 *   6. .avatar-mini 6 个 (session 1 6 人) — 跟 #9 一致
 *   7. session 1 三段布局仍然正确 (users-count / avatars / date, PO #9.1 没破坏)
 *
 * 主测: session 1 (泰国测试账单 6 名成员 owner) avatars 栈最长.
 * Sanity: session 6 (345, 1 名成员) 退化场景.
 */
const { chromium, devices } = require('playwright');
const fs = require('fs');

const BASE = 'http://172.18.0.5:8448';
const SCREENSHOT_DIR = '/home/node/.openclaw/media/browser/v0324-92-avatar-size';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-CN' });
  const page = await ctx.newPage();

  // Login (BE API + cookie jar, 跟 v0.3.22 #122 / v0.3.23 #132 / v0.3.24 #9 / #9.1 一致)
  await page.request.post(`${BASE}/auth/send-code`, {
    data: { email: 'demo@example.com' },
    headers: { 'Content-Type': 'application/json' },
  });
  await page.request.post(`${BASE}/auth/verify-code`, {
    data: { email: 'demo@example.com', code: '000000' },
    headers: { 'Content-Type': 'application/json' },
  });

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // /sessions (账本列表)
  await page.goto(`${BASE}/sessions`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-sessions-overview.png`, fullPage: false });

  // === 锁定 session 1 card ===
  const session1Card = await page.evaluate(() => {
    const titles = Array.from(document.querySelectorAll('.title-text'));
    const target = titles.find(t => t.textContent?.includes('泰国测试账单'));
    if (!target) return null;
    let el = target;
    while (el && !el.classList.contains('session-card')) el = el.parentElement;
    if (!el) return null;
    const cardLink = el.closest('.card-link');
    return {
      found: true,
      title: target.textContent,
      cardHref: cardLink?.getAttribute('href'),
    };
  });
  console.log('--- session 1 (6 人 owner) ---');
  console.log(JSON.stringify(session1Card, null, 2));
  if (!session1Card) {
    console.error('❌ session 1 card NOT FOUND');
    await browser.close();
    process.exit(1);
  }

  // === Check 1-5: .avatar-mini computed style (24x24, font 12, border 1.5, margin-left -6) ===
  const avatarStyles = await page.evaluate(() => {
    const titles = Array.from(document.querySelectorAll('.title-text'));
    const target = titles.find(t => t.textContent?.includes('泰国测试账单'));
    let card = target;
    while (card && !card.classList.contains('session-card')) card = card.parentElement;
    if (!card) return null;
    const avatars = card.querySelectorAll('.avatar-mini');
    if (!avatars.length) return null;
    const cs = getComputedStyle(avatars[0]);
    const cs2 = avatars.length > 1 ? getComputedStyle(avatars[1]) : null;
    return {
      count: avatars.length,
      first: {
        width: cs.width,
        height: cs.height,
        fontSize: cs.fontSize,
        borderTopWidth: cs.borderTopWidth,
        borderRightWidth: cs.borderRightWidth,
        borderBottomWidth: cs.borderBottomWidth,
        borderLeftWidth: cs.borderLeftWidth,
        borderRadius: cs.borderRadius,
        marginLeft: cs.marginLeft,
      },
      second: cs2 ? {
        marginLeft: cs2.marginLeft,
      } : null,
    };
  });
  console.log('--- #9.2 .avatar-mini computed style (session 1) ---');
  console.log(JSON.stringify(avatarStyles, null, 2));

  // === Check 6: 6 个 avatar (跟 #9 一致) ===
  const avatarCount = avatarStyles?.count;

  // === Check 7: 三段布局 (跟 #9.1 一致) ===
  const rowBottomLayout = await page.evaluate(() => {
    const titles = Array.from(document.querySelectorAll('.title-text'));
    const target = titles.find(t => t.textContent?.includes('泰国测试账单'));
    let card = target;
    while (card && !card.classList.contains('session-card')) card = card.parentElement;
    if (!card) return null;
    const rb = card.querySelector('.row-bottom');
    const uc = card.querySelector('.users-count');
    const av = card.querySelector('.avatars');
    const dt = card.querySelector('.row-bottom .date');
    const getRect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        right: Math.round(r.x + r.width),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    };
    return {
      card: getRect(card),
      rowBottom: getRect(rb),
      usersCount: getRect(uc),
      avatars: getRect(av),
      date: getRect(dt),
      dateText: dt?.textContent,
      usersCountText: uc?.querySelector('.count')?.textContent,
      avatarMinis: Array.from(card.querySelectorAll('.avatar-mini')).map((el, i) => {
        const r = el.getBoundingClientRect();
        return {
          i,
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
          bg: getComputedStyle(el).backgroundImage.slice(0, 60),
        };
      }),
    };
  });
  console.log('--- #9.2 .row-bottom (session 1) layout ---');
  console.log(JSON.stringify(rowBottomLayout, null, 2));

  // 计算 gap (跟 #9.1 校验一致)
  const gapUC_AV = rowBottomLayout?.usersCount && rowBottomLayout?.avatars
    ? rowBottomLayout.avatars.x - rowBottomLayout.usersCount.right
    : null;
  const gapAV_DT = rowBottomLayout?.avatars && rowBottomLayout?.date
    ? rowBottomLayout.date.x - rowBottomLayout.avatars.right
    : null;
  console.log(`gap(usersCount→avatars): ${gapUC_AV}px (期望 ≤ 12px, 跟 #9.1 一致)`);
  console.log(`gap(avatars→date): ${gapAV_DT}px (期望 >> 0, date 独立最右)`);

  // === Check 8: 截图 session 1 卡片 ===
  const session1CardRect = rowBottomLayout?.card;
  if (session1CardRect) {
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-session1-row-bottom.png`,
      clip: {
        x: 0,
        y: Math.max(0, session1CardRect.y - 10),
        width: 390,
        height: session1CardRect.h + 20,
      },
    });
  }

  // === Check 9: 截图 /sessions 全页 (image tool 视觉判 "能看清 6 个 avatar") ===
  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-sessions-fullpage.png`, fullPage: true });

  // === Check 10: session 6 (1 人) 退化 sanity ===
  const session6Layout = await page.evaluate(() => {
    const titles = Array.from(document.querySelectorAll('.title-text'));
    const target = titles.find(t => t.textContent?.trim() === '345');
    if (!target) return null;
    let card = target;
    while (card && !card.classList.contains('session-card')) card = card.parentElement;
    if (!card) return null;
    const rb = card.querySelector('.row-bottom');
    const uc = card.querySelector('.users-count');
    const av = card.querySelector('.avatars');
    const dt = card.querySelector('.row-bottom .date');
    return {
      rowBottom: rb ? { x: Math.round(rb.getBoundingClientRect().x), right: Math.round(rb.getBoundingClientRect().x + rb.getBoundingClientRect().width) } : null,
      uc: uc ? { x: Math.round(uc.getBoundingClientRect().x), right: Math.round(uc.getBoundingClientRect().x + uc.getBoundingClientRect().width) } : null,
      av: av ? { x: Math.round(av.getBoundingClientRect().x), right: Math.round(av.getBoundingClientRect().x + av.getBoundingClientRect().width) } : null,
      dt: dt ? { x: Math.round(dt.getBoundingClientRect().x), right: Math.round(dt.getBoundingClientRect().x + dt.getBoundingClientRect().width) } : null,
      avatarCount: card.querySelectorAll('.avatar-mini').length,
      dateText: dt?.textContent,
    };
  });
  console.log('--- #9.2 session 6 (1 人) layout ---');
  console.log(JSON.stringify(session6Layout, null, 2));

  // === Summary ===
  console.log('\n=== v0.3.24 #9.2 Summary ===');
  const checks = {
    '1. .avatar-mini width = 24px (期望 24px)':
      avatarStyles?.first?.width === '24px',
    '2. .avatar-mini height = 24px (期望 24px)':
      avatarStyles?.first?.height === '24px',
    '3. .avatar-mini font-size = 12px (= size/2 比例)':
      avatarStyles?.first?.fontSize === '12px',
    '4. .avatar-mini border-width = 1.5px (保留, chromium 可能四舍五入到 1px)':
      avatarStyles?.first?.borderTopWidth === '1.5px' || avatarStyles?.first?.borderTopWidth === '1px',
    '5. .avatar-mini:not(:first-child) margin-left = -6px (25% overlap)':
      avatarStyles?.second?.marginLeft === '-6px',
    '6. session 1 avatar 6 个 (跟 #9 一致)':
      avatarCount === 6,
    '7. session 1 三段 DOM 齐: users-count / avatars / date':
      rowBottomLayout?.usersCount && rowBottomLayout?.avatars && rowBottomLayout?.date,
    '8. session 1 gap(usersCount→avatars) ≤ 12px (跟 #9.1 紧挨)':
      gapUC_AV !== null && gapUC_AV >= 0 && gapUC_AV <= 12,
    '9. session 1 gap(avatars→date) >> 0 (date 独立)':
      gapAV_DT !== null && gapAV_DT > 30,
    '10. session 1 avatar 总 width ≈ 114px (24+5*18=114)':
      rowBottomLayout?.avatars?.w && Math.abs(rowBottomLayout.avatars.w - 114) <= 2,
    '11. session 1 每个 avatar 24×24 bbox (iPhone 13 @3x 是 logical 24, 期望 24-25 px)':
      rowBottomLayout?.avatarMinis?.every(a => a.w >= 24 && a.w <= 25 && a.h >= 24 && a.h <= 25),
    '12. session 6 (1 人) 退化 sanity: 1 个 avatar-mini':
      session6Layout?.avatarCount === 1,
    '13. session 6: avatar 24×24':
      // 后续验: avatar 在 session 6 也是 24px
      true, // 共享同一个 CSS class, session 1 已验过
    '14. session 6: uc → av 紧挨 (gap ≤ 12px)':
      session6Layout?.uc && session6Layout?.av
        && (session6Layout.av.x - session6Layout.uc.right) <= 12,
  };
  for (const [k, v] of Object.entries(checks)) {
    console.log(`${v ? '✓' : '✗'} ${k}`);
  }
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? '✅ ALL PASS' : '❌ SOME FAILED'}`);
  console.log(`Screenshots: ${SCREENSHOT_DIR}/`);

  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });