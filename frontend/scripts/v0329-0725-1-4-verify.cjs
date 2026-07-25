// v0.3.29 UAT 0725-1 #4 verify script
// PO: 账本 item 的删除按钮出现后, 如果用户点击或滑动了这个 item 外的其他地方,
//     刚刚这个删除按钮应收起来.
// 验证: .session-card swipe-open (btnWidth=56, progress=1) 后, 点 wrap 外
//       (e.g. document.body) → 触发 svelte:window on:click → onWindowClick
//       → 重置 openSwipeIdStore + swipeOffsetStore → .delete-btn 收起 (btnWidth → 0).
//
// 修法 (SessionCard.svelte): 加 svelte:window on:click={onWindowClick} + onWindowClick handler
//       检测 target 不在 .session-swipe-wrap 内 → reset store.
//
// 注: chromium-headless page.mouse.up() 会触发 synthetic click on mousedown target,
//     现有 onWrapClick 立即 reset (修前/修后都有 — 这是 v0.3.28 #3 续修 2 设计).
//     iOS Safari 真机: touch drag 后不触发 click (touch-action: pan-y + browser 抑制),
//     swipe 保持打开状态. 为 headless 验证 #4 fix, 用 JS-dispatched mouseup (跳过 synthetic click)
//     模拟真机 swipe-open 状态, 再 JS-dispatch click on document.body 验证 svelte:window 监听.
const { chromium, devices } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/config/.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell',
    headless: true,
  });
  const ctx = await browser.newContext({
    ...devices['iPhone 13'],
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  const page = await ctx.newPage();

  await ctx.request.post('http://127.0.0.1:8449/auth/send-code', { data: { email: 'xinhua1001@outlook.com' } });
  await ctx.request.post('http://127.0.0.1:8449/auth/verify-code', { data: { email: 'xinhua1001@outlook.com', code: '000000' } });

  const sessRes = await ctx.request.get('http://127.0.0.1:8449/sessions');
  const sessions = await sessRes.json();
  const ownedSessions = sessions.filter(s => s.role === 'owner' || (s.owner_email && s.owner_email.includes('xinhua1001')));
  const target = ownedSessions[0] || sessions[0];
  if (!target) { console.error('no session found'); process.exit(1); }
  console.log('target:', target.id, target.name, 'role=' + target.role);

  const checks = [];
  function check(name, ok, info) {
    checks.push({ name, ok });
    console.log((ok ? 'OK  ' : 'FAIL') + '  ' + name + (info ? ' ' + info : ''));
  }

  await page.goto('http://127.0.0.1:8460/sessions', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2500);

  // === Test A: 找 owner card wrap ===
  const ownerWrapCount = await page.locator('.session-swipe-wrap:has(.delete-btn)').count();
  console.log('owner wraps with delete-btn:', ownerWrapCount);
  if (ownerWrapCount === 0) { console.error('no owner card with delete-btn found'); process.exit(1); }

  const wrap = page.locator('.session-swipe-wrap:has(.delete-btn)').first();
  const wrapBox = await wrap.boundingBox();
  const startX = wrapBox.x + wrapBox.width * 0.7;
  const startY = wrapBox.y + wrapBox.height / 2;

  // === Test B: 模拟 swipe-open (mouse drag + JS-dispatched mouseup 跳过 synthetic click) ===
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 1; i <= 15; i++) {
    await page.mouse.move(startX - i * 10, startY);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(300);
  // JS-dispatched mouseup: 触发 onWindowMouseUp → endDrag → snap to -56 + openSwipeIdStore = id
  // 但跳过 chromium synthetic click on mousedown target (这 click 会触发 onWrapClick reset)
  await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  }, { x: startX - 150, y: startY });
  await page.waitForTimeout(500);

  // === Test C: 验证 swipe-open 状态 ===
  const afterSwipe = await page.evaluate(() => {
    const wrap = document.querySelector('.session-swipe-wrap:has(.delete-btn)');
    const btn = wrap.querySelector('.delete-btn');
    const r = btn.getBoundingClientRect();
    return {
      width: r.width,
      height: r.height,
      ariaHidden: btn.getAttribute('aria-hidden'),
      progress: btn.style.getPropertyValue('--swipe-progress') || '0',
      isOpen: r.width >= 50 && btn.getAttribute('aria-hidden') === 'false',
    };
  });
  console.log('after JS-mouseup (swipe-open state):', JSON.stringify(afterSwipe));
  check('#4 setup: delete-btn visible after swipe (btnWidth=56, progress=1, aria-hidden=false)',
        afterSwipe && afterSwipe.isOpen,
        'w=' + (afterSwipe ? afterSwipe.width : '?') + ' aria-hidden=' + (afterSwipe ? afterSwipe.ariaHidden : '?') + ' progress=' + (afterSwipe ? afterSwipe.progress : '?'));

  if (!afterSwipe || !afterSwipe.isOpen) {
    console.error('SWIPE-OPEN SETUP FAILED — cannot continue #4 fix verify');
    console.log('\n=== SUMMARY ===');
    console.log('Passed: ' + checks.filter(c => c.ok).length + '/' + checks.length);
    console.log('FAIL (setup)');
    await browser.close();
    process.exit(1);
  }

  // === Test D: JS-dispatch click outside wrap (on document.body, 不通过 .session-swipe-wrap) ===
  // svelte:window on:click → onWindowClick → target.closest('.session-swipe-wrap') = null
  // → reset swipeOffsetStore + openSwipeIdStore
  await page.evaluate(() => {
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 195, clientY: 800 }));
  });
  await page.waitForTimeout(500);

  const afterOutsideClick = await page.evaluate(() => {
    const wrap = document.querySelector('.session-swipe-wrap:has(.delete-btn)');
    const btn = wrap.querySelector('.delete-btn');
    const r = btn.getBoundingClientRect();
    return {
      width: r.width,
      ariaHidden: btn.getAttribute('aria-hidden'),
      progress: btn.style.getPropertyValue('--swipe-progress') || '0',
      isClosed: r.width < 5, // 收起后 width → 0 (progress → 0)
    };
  });
  console.log('after JS-click on body (outside wrap):', JSON.stringify(afterOutsideClick));
  check('#4 CORE: delete-btn closed after outside-click on body (width < 5px)',
        afterOutsideClick && afterOutsideClick.isClosed,
        'w=' + (afterOutsideClick ? afterOutsideClick.width : '?') + ' aria-hidden=' + (afterOutsideClick ? afterOutsideClick.ariaHidden : '?') + ' progress=' + (afterOutsideClick ? afterOutsideClick.progress : '?'));

  // === Test E: 截图存证 (after outside click 收起) ===
  await page.screenshot({ path: '/tmp/v0329-0725-1-4-A-after-outside-click.png', clip: { x: 0, y: 0, width: 390, height: 400 } });

  // === Test F: 反向 — 点 wrap 内 (NON-delete-btn area) 应该被 onWrapClick reset ===
  // (这验证 onWindowClick 不会跟 onWrapClick 冲突: wrap 内 click 走 onWrapClick 路径)
  // 重新 swipe-open + click wrap 内容 (NOT delete-btn)
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 1; i <= 15; i++) {
    await page.mouse.move(startX - i * 10, startY);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(300);
  await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  }, { x: startX - 150, y: startY });
  await page.waitForTimeout(500);

  const beforeWrapClick = await page.evaluate(() => {
    const wrap = document.querySelector('.session-swipe-wrap:has(.delete-btn)');
    const btn = wrap.querySelector('.delete-btn');
    return { width: btn.getBoundingClientRect().width, ariaHidden: btn.getAttribute('aria-hidden') };
  });
  console.log('before wrap-internal click:', JSON.stringify(beforeWrapClick));

  // 点 wrap 内 (e.g., wrap 中央非 delete-btn 区 — title pill area)
  // wrap.left + 30, wrap.mid-y — this should be inside wrap but not on delete-btn (which is at right)
  const wrapClickPt = await page.evaluate(() => {
    const wrap = document.querySelector('.session-swipe-wrap:has(.delete-btn)');
    const r = wrap.getBoundingClientRect();
    return { x: r.x + r.width * 0.3, y: r.y + r.height / 2 };  // 左侧 30% 区域, NOT delete-btn (在右)
  });
  // JS-dispatch click (模拟真机点 wrap 内容)
  await page.evaluate(({x, y}) => {
    const target = document.elementFromPoint(x, y);
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  }, wrapClickPt);
  await page.waitForTimeout(500);

  const afterWrapClick = await page.evaluate(() => {
    const wrap = document.querySelector('.session-swipe-wrap:has(.delete-btn)');
    const btn = wrap.querySelector('.delete-btn');
    return { width: btn.getBoundingClientRect().width, ariaHidden: btn.getAttribute('aria-hidden'), isClosed: btn.getBoundingClientRect().width < 5 };
  });
  console.log('after wrap-internal click:', JSON.stringify(afterWrapClick));
  check('#4 wrap-internal: 点 wrap 内容 (非 delete-btn) 也收起 (验证 onWrapClick 路径)',
        afterWrapClick && afterWrapClick.isClosed,
        'w=' + (afterWrapClick ? afterWrapClick.width : '?'));

  console.log('\n=== SUMMARY ===');
  console.log('Passed: ' + checks.filter(c => c.ok).length + '/' + checks.length);
  const pass = checks.every(c => c.ok);
  console.log(pass ? 'PASS ALL' : 'FAIL');

  await browser.close();
  process.exit(pass ? 0 : 1);
})();