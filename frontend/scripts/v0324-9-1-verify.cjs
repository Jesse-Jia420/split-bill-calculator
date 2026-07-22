#!/usr/bin/env node
/**
 * v0.3.24 #9.1 — 续 #9 PO msg #8269 反馈 row-bottom layout fix.
 *
 * PO 字面反馈: "人 icon 人数的右侧应紧接着头像, 不应该空这么多"
 * 原 layout (flex space-between) 三段均匀分布, users-count 和 avatars 中间空隙过大.
 * 修法: .row-bottom 删 justify-content: space-between, .avatars 加 margin-left: auto.
 *
 * 验证 6 项:
 *   1. .row-bottom computed style 没有 justify-content: space-between (跟 #9 区分)
 *   2. .row-bottom .date computed margin-left 是 auto 解析后的 px 值 (> 0, 填充剩余空间)
 *      — v0.3.24 #9.1 实际改 .date 加 margin-left: auto, 不是 .avatars
 *      (margin-left: auto 在 .avatars 会让 users-count 和 avatars 反而更远, 跟 PO 意图反.)
 *   3. .row-bottom 三段 DOM 齐: .users-count / .avatars / .row-bottom .date
 *   4. x 坐标: users_count_right ≈ avatars_left (gap ≤ 12px) — PO 字面 "紧挨"
 *   5. x 坐标: avatars_right << date_left (大空隙) — date 独立最右
 *   6. date x 在 row 末尾 (date_right ≈ row_right, gap ≤ 8px)
 *
 * 主测: session 1 (泰国测试账单 6.19-6.22, 6 名成员 owner) avatars 栈最长.
 * Sanity: session 6 (345, 1 名成员) 退化场景.
 */
const { chromium, devices } = require('playwright');
const fs = require('fs');

const BASE = 'http://172.18.0.5:8448';
const SCREENSHOT_DIR = '/home/node/.openclaw/media/browser/v0324-9-1-row-bottom-layout';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-CN' });
  const page = await ctx.newPage();

  // Login (BE API + cookie jar, 跟 v0.3.22 #122 / v0.3.23 #132 / v0.3.24 #9 一致)
  await page.request.post(`${BASE}/auth/send-code`, {
    data: { email: 'xinhua1001@outlook.com' },
    headers: { 'Content-Type': 'application/json' },
  });
  await page.request.post(`${BASE}/auth/verify-code`, {
    data: { email: 'xinhua1001@outlook.com', code: '000000' },
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

  // === Check 1: .row-bottom computed style (没有 justify-content: space-between) ===
  const rowBottomStyle = await page.evaluate(() => {
    const titles = Array.from(document.querySelectorAll('.title-text'));
    const target = titles.find(t => t.textContent?.includes('泰国测试账单'));
    let card = target;
    while (card && !card.classList.contains('session-card')) card = card.parentElement;
    if (!card) return null;
    const rb = card.querySelector('.row-bottom');
    if (!rb) return null;
    const cs = getComputedStyle(rb);
    return {
      display: cs.display,
      justifyContent: cs.justifyContent,
      alignItems: cs.alignItems,
      gap: cs.gap,
      flexDirection: cs.flexDirection,
    };
  });
  console.log('--- #9.1 .row-bottom computed style ---');
  console.log(JSON.stringify(rowBottomStyle, null, 2));

  // === Check 2: .avatars + .date computed style — margin-left ===
  // v0.3.24 #9.1: margin-left: auto 在 .row-bottom .date (不是 .avatars)
  const styles = await page.evaluate(() => {
    const titles = Array.from(document.querySelectorAll('.title-text'));
    const target = titles.find(t => t.textContent?.includes('泰国测试账单'));
    let card = target;
    while (card && !card.classList.contains('session-card')) card = card.parentElement;
    if (!card) return null;
    const av = card.querySelector('.avatars');
    const dt = card.querySelector('.row-bottom .date');
    if (!av || !dt) return null;
    const csAv = getComputedStyle(av);
    const csDt = getComputedStyle(dt);
    return {
      avatars: {
        display: csAv.display,
        alignItems: csAv.alignItems,
        flexShrink: csAv.flexShrink,
        minWidth: csAv.minWidth,
        marginLeft: csAv.marginLeft,
      },
      date: {
        fontSize: csDt.fontSize,
        color: csDt.color,
        fontVariantNumeric: csDt.fontVariantNumeric,
        flexShrink: csDt.flexShrink,
        lineHeight: csDt.lineHeight,
        marginLeft: csDt.marginLeft,
      },
    };
  });
  console.log('--- #9.1 .avatars + .date computed style ---');
  console.log(JSON.stringify(styles, null, 2));
  const avatarsStyle = styles?.avatars;
  const dateStyle = styles?.date;

  // === Check 3: 三段 DOM + x 坐标 ===
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
    };
  });
  console.log('--- #9.1 .row-bottom (session 1) layout ---');
  console.log(JSON.stringify(rowBottomLayout, null, 2));

  // 计算 gap 距离 (PO 字面 "紧挨")
  const gapUsersCountAvatars = rowBottomLayout?.usersCount && rowBottomLayout?.avatars
    ? rowBottomLayout.avatars.x - rowBottomLayout.usersCount.right
    : null;
  const gapAvatarsDate = rowBottomLayout?.avatars && rowBottomLayout?.date
    ? rowBottomLayout.date.x - rowBottomLayout.avatars.right
    : null;
  const gapDateRightEdge = rowBottomLayout?.date && rowBottomLayout?.rowBottom
    ? rowBottomLayout.rowBottom.right - rowBottomLayout.date.right
    : null;
  console.log(`gap(usersCount→avatars): ${gapUsersCountAvatars}px (期望 ≤ 12px, 含 gap 10px + sub-pixel)`);
  console.log(`gap(avatars→date): ${gapAvatarsDate}px (期望 >> 0, 大空隙, date 独立最右)`);
  console.log(`gap(date→rowRight): ${gapDateRightEdge}px (期望 ≤ 8px)`);

  // === Check 7: 截图 session 1 卡片 ===
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

  // === Check 8: session 6 (1 人) 退化 sanity ===
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
  console.log('--- #9.1 session 6 (1 人) layout ---');
  console.log(JSON.stringify(session6Layout, null, 2));

  // === Summary ===
  console.log('\n=== v0.3.24 #9.1 Summary ===');
  const checks = {
    '1. .row-bottom computed justify-content ≠ space-between (改对了)':
      rowBottomStyle?.justifyContent !== 'space-between',
    '2. .row-bottom computed align-items = center (原本就有, 没破坏)':
      rowBottomStyle?.alignItems === 'center',
    '3. .row-bottom computed display = flex':
      rowBottomStyle?.display === 'flex',
    '4. .row-bottom .date computed margin-left 是 auto 解析后的 px 值 (> 0, 填充剩余空间)':
      // chromium 解析 margin-left:auto 算成实际 px 值, 期望 > 0 (填充剩余空间)
      // (margin-left: 0px 表示没生效)
      dateStyle?.marginLeft !== '0px' && dateStyle?.marginLeft !== 'auto',
    '5. .users-count right ≈ .avatars left (gap ≤ 12px, PO 字面 "紧挨")':
      gapUsersCountAvatars !== null && gapUsersCountAvatars >= 0 && gapUsersCountAvatars <= 12,
    '6. .avatars right << .date left (大空隙, date 独立最右)':
      gapAvatarsDate !== null && gapAvatarsDate > 30,
    '7. .date right ≈ .row-bottom right (gap ≤ 8px, 在 row 末尾)':
      gapDateRightEdge !== null && gapDateRightEdge >= 0 && gapDateRightEdge <= 8,
    '8. .users-count 顶 leftmost (x = rowBottom.x, 内 padding)':
      rowBottomLayout?.usersCount && rowBottomLayout?.rowBottom
        && Math.abs(rowBottomLayout.usersCount.x - rowBottomLayout.rowBottom.x) < 20,
    '9. session 1 三段 DOM 齐: users-count / avatars / date':
      rowBottomLayout?.usersCount && rowBottomLayout?.avatars && rowBottomLayout?.date,
    '10. session 6 (1 人) 退化 sanity: 1 个 avatar-mini':
      session6Layout?.avatarCount === 1,
    '11. session 6: uc → av 紧挨 (gap ≤ 12px)':
      session6Layout?.uc && session6Layout?.av
        && (session6Layout.av.x - session6Layout.uc.right) <= 12,
    '12. session 6: av → dt 大空隙 (gap > 30px)':
      session6Layout?.av && session6Layout?.dt
        && (session6Layout.dt.x - session6Layout.av.right) > 30,
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