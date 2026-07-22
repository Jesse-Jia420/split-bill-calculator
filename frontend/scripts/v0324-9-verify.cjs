#!/usr/bin/env node
/**
 * v0.3.24 #9 — UAT bug 账本 item 重设计: 玻璃更透 + 人 icon 人数移到 row 最左.
 *
 * 验证 5 项:
 *   1. .session-card bg = linear-gradient rgba(255,255,255, 0.62→0.38)
 *      (玻璃更透, #139 0.75→0.62 + 0.50→0.38)
 *   2. .session-card backdrop-filter saturate(200%) blur(28px) brightness(1.05)
 *      (vs #139 saturate(200%) blur(24px) brightness(1.04))
 *   3. .row-bottom DOM 拆 3 段 — users-count (左) | avatars (中) | date (右)
 *   4. row 三段位置 — users-count 顶 leftmost (x 最小), avatars 中, date rightmost (x 最大)
 *   5. avatar-mini 玻璃质感 — backdrop-filter + rgba 0.88 palette 渐变 + -4.5px overlap
 *
 * 注: session 1 (泰国测试账单 6.19-6.22, 6 名成员) 有最丰富 avatars 栈, 主测该 card.
 *     其他 sessions (1/2 名成员) 作为 sanity check.
 */
const { chromium, devices } = require('playwright');
const fs = require('fs');

const BASE = 'http://172.18.0.5:8448';
const SCREENSHOT_DIR = '/home/node/.openclaw/media/browser/v0324-9-session-card-refined';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-CN' });
  const page = await ctx.newPage();

  // Login (BE API + cookie jar, 跟 v0.3.22 #122 / v0.3.23 #132 一致)
  await page.request.post(`${BASE}/auth/send-code`, {
    data: { email: 'xinhua1001@outlook.com' },
    headers: { 'Content-Type': 'application/json' },
  });
  await page.request.post(`${BASE}/auth/verify-code`, {
    data: { email: 'xinhua1001@outlook.com', code: '000000' },
    headers: { 'Content-Type': 'application/json' },
  });

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // /sessions (账本列表, 4 张卡片 — 重点 session 1 = 6 人 owner)
  await page.goto(`${BASE}/sessions`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-sessions-overview.png`, fullPage: false });

  // === 锁定 session 1 的 card 做主测 (6 人 owner, avatars 栈最长) ===
  const session1Card = await page.evaluate(() => {
    // 找名字含"泰国测试账单"的 card 容器
    const titles = Array.from(document.querySelectorAll('.title-text'));
    const target = titles.find(t => t.textContent?.includes('泰国测试账单'));
    if (!target) return null;
    // 向上找最近的 .session-card
    let el = target;
    while (el && !el.classList.contains('session-card')) el = el.parentElement;
    if (!el) return null;
    // 找外层 .card-link (a 标签)
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
    console.error('❌ session 1 (泰国测试账单) card NOT FOUND');
    await browser.close();
    process.exit(1);
  }

  // 1. .session-card computed style (以 session 1 卡为对象)
  const cardStyles = await page.evaluate(() => {
    const titles = Array.from(document.querySelectorAll('.title-text'));
    const target = titles.find(t => t.textContent?.includes('泰国测试账单'));
    let el = target;
    while (el && !el.classList.contains('session-card')) el = el.parentElement;
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      background: cs.backgroundImage,
      backgroundColor: cs.backgroundColor,
      backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter,
      width: cs.width,
      height: cs.height,
    };
  });
  console.log('--- #9 .session-card (session 1) computed style ---');
  console.log(JSON.stringify(cardStyles, null, 2));

  // 2. .row-bottom 三段 DOM + 位置 (rectangle x 坐标)
  const rowBottomLayout = await page.evaluate(() => {
    const titles = Array.from(document.querySelectorAll('.title-text'));
    const target = titles.find(t => t.textContent?.includes('泰国测试账单'));
    let card = target;
    while (card && !card.classList.contains('session-card')) card = card.parentElement;
    if (!card) return null;
    const rb = card.querySelector('.row-bottom');
    if (!rb) return null;
    const uc = card.querySelector('.users-count');
    const av = card.querySelector('.avatars');
    const dt = card.querySelector('.row-bottom .date');
    const getRect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    return {
      card: getRect(card),
      rowBottom: getRect(rb),
      usersCount: getRect(uc),
      avatars: getRect(av),
      date: getRect(dt),
      usersCountHTML: uc?.innerHTML.slice(0, 200),
      avatarsHTML: av?.outerHTML.slice(0, 500),
      dateText: dt?.textContent,
    };
  });
  console.log('--- #9 .row-bottom (session 1) 三段 layout ---');
  console.log(JSON.stringify(rowBottomLayout, null, 2));

  // 3. avatar-mini computed style (session 1 card, 6 人应该有 6 个 avatar-mini)
  const avatarMiniStyles = await page.evaluate(() => {
    const titles = Array.from(document.querySelectorAll('.title-text'));
    const target = titles.find(t => t.textContent?.includes('泰国测试账单'));
    let card = target;
    while (card && !card.classList.contains('session-card')) card = card.parentElement;
    if (!card) return { found: false };
    const all = Array.from(card.querySelectorAll('.avatar-mini'));
    if (all.length === 0) return { found: false, count: 0 };
    const palettes = all.map((el) => {
      const cs = getComputedStyle(el);
      return {
        classes: Array.from(el.classList).filter(c => !c.startsWith('s-')).join(' '),
        backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter,
        boxShadow: cs.boxShadow,
        background: cs.backgroundImage,
        width: cs.width,
        height: cs.height,
        marginLeft: cs.marginLeft,
      };
    });
    return {
      found: true,
      count: all.length,
      palettes,
    };
  });
  console.log('--- #9 .avatar-mini (session 1 row-bottom) ---');
  console.log(JSON.stringify(avatarMiniStyles, null, 2));

  // 4. users-count + date computed style
  const metaStyles = await page.evaluate(() => {
    const titles = Array.from(document.querySelectorAll('.title-text'));
    const target = titles.find(t => t.textContent?.includes('泰国测试账单'));
    let card = target;
    while (card && !card.classList.contains('session-card')) card = card.parentElement;
    if (!card) return null;
    const uc = card.querySelector('.users-count');
    const dt = card.querySelector('.row-bottom .date');
    if (!uc || !dt) return null;
    const csUC = getComputedStyle(uc);
    const csUCInner = getComputedStyle(uc.querySelector('.count'));
    const csUCInnerSVG = getComputedStyle(uc.querySelector('.users-icon'));
    const csDT = getComputedStyle(dt);
    return {
      usersCount_display: csUC.display,
      usersCount_gap: csUC.gap,
      usersCount_color_icon: csUCInnerSVG.color,
      usersCount_color_count: csUCInner.color,
      usersCount_font_weight: csUCInner.fontWeight,
      usersCount_font_variantNumeric: csUCInner.fontVariantNumeric,
      usersCount_font_size: csUCInner.fontSize,
      date_color: csDT.color,
      date_font_variantNumeric: csDT.fontVariantNumeric,
      date_font_size: csDT.fontSize,
    };
  });
  console.log('--- #9 users-count + date style (session 1) ---');
  console.log(JSON.stringify(metaStyles, null, 2));

  // 5. hover 状态 bg — 模拟 hover (mouseenter) + 取实时 computed style 验证 hover bg
  //    Svelte scoped CSS 不会出现在 document.styleSheets 直接枚举里, 用 trigger hover 后
  //    读 getComputedStyle 更可靠 (跟 v0.3.23 #132 / #137 / #138 一致)
  const cardLink = await page.locator('a.card-link').first();
  await cardLink.hover();
  await page.waitForTimeout(300);
  const hoverBg = await page.evaluate(() => {
    const card = document.querySelector('.session-card');
    if (!card) return null;
    const cs = getComputedStyle(card);
    return {
      backgroundImage: cs.backgroundImage,
      transform: cs.transform,
      boxShadow: cs.boxShadow,
    };
  });
  console.log('--- #9 hover bg computed style (after mouseenter) ---');
  console.log(JSON.stringify(hoverBg, null, 2));
  // 移走鼠标取消 hover (避免影响后续)
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);

  // 6. 截图存证 — session 1 卡片 row-bottom zoom
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

  // 7. 验证 session 6 (1 人) — 退化情况, 1 个 avatar 占位
  const session6Card = await page.evaluate(() => {
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
      cardRect: { x: Math.round(card.getBoundingClientRect().x), y: Math.round(card.getBoundingClientRect().y), w: Math.round(card.getBoundingClientRect().width), h: Math.round(card.getBoundingClientRect().height) },
      ucRect: { x: Math.round(uc.getBoundingClientRect().x), w: Math.round(uc.getBoundingClientRect().width) },
      avRect: { x: Math.round(av.getBoundingClientRect().x), w: Math.round(av.getBoundingClientRect().width) },
      dtRect: { x: Math.round(dt.getBoundingClientRect().x), w: Math.round(dt.getBoundingClientRect().width) },
      avatarCount: card.querySelectorAll('.avatar-mini').length,
      dateText: dt.textContent,
    };
  });
  console.log('--- #9 session 6 (1 人) layout ---');
  console.log(JSON.stringify(session6Card, null, 2));

  // === Summary ===
  console.log('\n=== v0.3.24 #9 Summary ===');
  const palette2 = avatarMiniStyles?.palettes?.[1]; // 第 2 个 avatar (有 margin-left overlap)
  const checks = {
    '1. .session-card bg alpha 0.62/0.38': cardStyles?.background?.includes('rgba(255, 255, 255, 0.62)')
      && cardStyles?.background?.includes('rgba(255, 255, 255, 0.38)'),
    '2. .session-card backdrop-filter saturate(200%) blur(28px) brightness(1.05)': cardStyles?.backdropFilter?.includes('saturate(2)')
      && cardStyles?.backdropFilter?.includes('blur(28px)')
      && cardStyles?.backdropFilter?.includes('brightness(1.05)'),
    '3a. .users-count exists': rowBottomLayout?.usersCount !== null,
    '3b. .avatars exists': rowBottomLayout?.avatars !== null,
    '3c. .row-bottom .date exists': rowBottomLayout?.date !== null,
    '4a. users-count x < avatars x (左/中)': rowBottomLayout?.usersCount?.x < rowBottomLayout?.avatars?.x,
    '4b. avatars x < date x (中/右)': rowBottomLayout?.avatars?.x < rowBottomLayout?.date?.x,
    '5a. avatar-mini count = 6 (session 1)': avatarMiniStyles?.count === 6,
    '5b. avatar-mini palette-0 bg rgba 0.88': avatarMiniStyles?.palettes?.[0]?.background?.includes('0.88)'),
    '5c. avatar-mini palette-1 bg rgba 0.88': avatarMiniStyles?.palettes?.[1]?.background?.includes('0.88)'),
    '5d. avatar-mini 2nd (非 first-child) margin-left -4.5px': palette2?.marginLeft === '-4.5px',
    '5e. avatar-mini 1st (first-child) margin-left 0px': avatarMiniStyles?.palettes?.[0]?.marginLeft === '0px',
    '5f. avatar-mini backdrop-filter blur(4px) saturate(180%)': avatarMiniStyles?.palettes?.[0]?.backdropFilter?.includes('blur(4px)')
      && avatarMiniStyles?.palettes?.[0]?.backdropFilter?.includes('saturate(1.8)'),
    '5g. avatar-mini width/height 18px': avatarMiniStyles?.palettes?.[0]?.width === '18px'
      && avatarMiniStyles?.palettes?.[0]?.height === '18px',
    '6. users-count tabular-nums + font-weight 600': metaStyles?.usersCount_font_variantNumeric === 'tabular-nums'
      && metaStyles?.usersCount_font_weight === '600',
    '7. date tabular-nums': metaStyles?.date_font_variantNumeric === 'tabular-nums',
    '8. hover bg alpha 0.78/0.55 (computed style)': hoverBg?.backgroundImage?.includes('rgba(255, 255, 255, 0.78)')
      && hoverBg?.backgroundImage?.includes('rgba(255, 255, 255, 0.55)'),
    '8b. hover transform translateY(-2px)': hoverBg?.transform?.includes('matrix(1, 0, 0, 1, 0, -2)') || hoverBg?.transform === 'matrix(1, 0, 0, 1, 0, -2)' || hoverBg?.transform?.match(/matrix.*-2.*\)/),
    '9. session 6 (1 人): avatar count = 1 (退化 sanity)': session6Card?.avatarCount === 1,
    '10. session 6: 用户 icon 在左, date 在右 (sanity)': session6Card?.ucRect?.x < session6Card?.dtRect?.x,
  };
  for (const [k, v] of Object.entries(checks)) {
    console.log(`${v ? '✓' : '✗'} ${k}`);
  }
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? '✅ ALL PASS' : '❌ SOME FAILED'}`);

  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });