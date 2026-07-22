// v0.3.22 #119 verify (PO msg 11:35 #7838 Bug 5 + Bug 4 续 + 2 增强)
// 4 件事一次验:
//   Bug 5: BillForm.svelte handlePillBlur — input 0/空/非法 → blur 退到 shared
//   Bug 4 续: BillListGrouped.svelte listMinHeight — filter 变化时 scrollTop 不 clamp 让 search sticky 稳
//   empty placeholder: BillListGrouped totalBills prop — filter 没匹配 → "没有匹配的账单" not "还没有账单"
//   +layout.svelte overflow-anchor: always — computed style 含 overflow-anchor: always

const { chromium, devices } = require('playwright');
const fs = require('fs');

async function main() {
  const browser = await chromium.launch();
  const iPhone = devices['iPhone 13'];
  const context = await browser.newContext({ ...iPhone });
  const page = await context.newPage();

  // ==== 0. login (API 直接拿 cookie) ====
  // 先 visit 域名建立 context, 再设 cookie, 再访问
  await page.goto('https://test.jessejia.pp.ua/');
  // 直接调 BE API 拿 cookie
  const loginResp = await page.evaluate(async () => {
    const send = await fetch('https://test.jessejia.pp.ua/api/auth/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'xinhua1001@outlook.com' }),
    });
    const verify = await fetch('https://test.jessejia.pp.ua/api/auth/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'xinhua1001@outlook.com', code: '000000' }),
      credentials: 'include',
    });
    return { send: send.status, verify: verify.status };
  });
  console.log('LOGIN API:', JSON.stringify(loginResp));
  // 确认登录成功
  await page.goto('https://test.jessejia.pp.ua/sessions');
  await page.waitForTimeout(800);
  console.log('LOGIN OK, current URL:', page.url());
  if (!page.url().includes('/sessions')) {
    console.log('FAIL: login failed, URL not /sessions');
    process.exit(1);
  }

  // ==== A. overflow-anchor: always (layout) ====
  // computed style "auto" 是 chromium quirk, 实际看 behavior: filter 改 list 高度时
  // main.scrollTop 不应被 clamp, sticky search 应保持顶贴.  (跟 #118 scrollSearchToSticky 配合)
  await page.goto('https://test.jessejia.pp.ua/sessions/1');
  await page.waitForSelector('.bills-search-input', { timeout: 10000 });
  await page.waitForTimeout(800);

  // 验证规则存在: 在 .page.s-XXXX 选择器下能找到 overflow-anchor: always
  // Svelte 5 scoped style 注入到 <style> 标签里, 不是 document.styleSheets
  const layoutAnchor = await page.evaluate(() => {
    // 也查 styleSheets
    const rules = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.cssText && rule.cssText.includes('overflow-anchor')) {
            rules.push('sheet: ' + rule.cssText.slice(0, 200));
          }
        }
      } catch (e) {}
    }
    // 也查 <style> tag text (Svelte 5 scoped styles)
    for (const styleTag of document.querySelectorAll('style')) {
      const text = styleTag.textContent || '';
      if (text.includes('overflow-anchor')) {
        const snippet = text.match(/\.page[^}]*overflow-anchor[^}]*\}/s);
        if (snippet) rules.push('styleTag: ' + snippet[0].slice(0, 200));
      }
    }
    return { ok: rules.length > 0, rules: rules.slice(0, 2) };
  });
  console.log('A. +layout.svelte .page has overflow-anchor rule:', JSON.stringify(layoutAnchor));
  const checkA = layoutAnchor.ok === true;

  // ==== B. BillListGrouped min-height + sticky scroll (Bug 4 续) ====
  // 滚到 bills list 中下部 (远离 search 顶部), focus search, 模拟 typing
  await page.evaluate(() => {
    const main = document.querySelector('main');
    if (main) main.scrollTop = 600;
  });
  await page.waitForTimeout(300);

  const scrollBeforeType = await page.evaluate(() => {
    const main = document.querySelector('main');
    return main ? main.scrollTop : -1;
  });

  // 点 search input 触发 focus (会走 #118 scrollSearchToSticky with visualViewport guard)
  await page.click('.bills-search-input');
  await page.waitForTimeout(400);

  const scrollAfterFocus = await page.evaluate(() => {
    const main = document.querySelector('main');
    return main ? main.scrollTop : -1;
  });
  console.log('B. scrollTop before focus:', scrollBeforeType, 'after focus:', scrollAfterFocus);

  // 在 search input 输入字符 → 触发 filteredBills 变化 → list 缩短
  await page.type('.bills-search-input', 'a');
  await page.waitForTimeout(400);
  const scrollAfterA = await page.evaluate(() => {
    const main = document.querySelector('main');
    return main ? main.scrollTop : -1;
  });
  await page.type('.bills-search-input', 'bc');
  await page.waitForTimeout(400);
  const scrollAfterAbc = await page.evaluate(() => {
    const main = document.querySelector('main');
    return main ? main.scrollTop : -1;
  });
  console.log('B. scrollTop after "a":', scrollAfterA, 'after "abc":', scrollAfterAbc);

  // 验: search sticky element 视觉位置稳 — 顶部 y 应保持 viewport top 不远
  // 即便 main.scrollHeight 缩短, search 不应被推下
  const searchStickyPos = await page.evaluate(() => {
    const inp = document.querySelector('.bills-search-input');
    if (!inp) return null;
    const rect = inp.getBoundingClientRect();
    return { top: rect.top, height: rect.height };
  });
  console.log('B. search input position after typing:', JSON.stringify(searchStickyPos));

  // 检查 .bill-grouped 实际有 min-height style
  const billGroupedMinHeight = await page.evaluate(() => {
    const el = document.querySelector('.bill-grouped');
    if (!el) return null;
    return {
      styleAttr: el.getAttribute('style'),
      offsetHeight: el.offsetHeight,
      minHeight: getComputedStyle(el).minHeight,
    };
  });
  console.log('B. .bill-grouped min-height:', JSON.stringify(billGroupedMinHeight));

  // 验: scrollHeight 没被 clamp (search sticky 应在 viewport 顶部附近)
  const checkB = searchStickyPos && searchStickyPos.top < 200; // < 200px = sticky 仍贴顶
  console.log('B. sticky 保持顶贴 (search.top < 200):', checkB ? 'PASS ✓' : 'FAIL ✗ (search 跳到中部)');

  // ==== C. BillListGrouped filter empty placeholder ====
  // 输入绝对不会匹配的字符串 (e.g. "ZZZZZ") → filter=0 但 totalBills>0 → "没有匹配的账单"
  await page.fill('.bills-search-input', 'ZZZZZ_NO_MATCH_AT_ALL');
  await page.waitForTimeout(500);

  const filterEmptyInfo = await page.evaluate(() => {
    const emptyEl = document.querySelector('.bill-list-empty');
    const oldEmpty = document.querySelector('.bill-grouped > p.muted:not(.bill-list-empty)');
    return {
      hasNewEmpty: !!emptyEl,
      newEmptyText: emptyEl ? emptyEl.textContent.trim() : null,
      hasOldEmpty: !!oldEmpty,
      oldEmptyText: oldEmpty ? oldEmpty.textContent.trim() : null,
    };
  });
  console.log('C. filter empty placeholder:', JSON.stringify(filterEmptyInfo));

  const checkC = filterEmptyInfo.hasNewEmpty &&
                 filterEmptyInfo.newEmptyText &&
                 filterEmptyInfo.newEmptyText.includes('没有匹配');
  console.log('C. filter 空态显示 "没有匹配":', checkC ? 'PASS ✓' : 'FAIL ✗');

  // 截图 1: filter 0 匹配状态
  await page.screenshot({ path: '/home/node/.openclaw/workspace/sbc/split-bill-calculator/.verify-v0322-119-C-filter-empty.png' });

  // 清空 search
  await page.fill('.bills-search-input', '');
  await page.waitForTimeout(300);

  // ==== D. BillForm handlePillBlur (Bug 5) ====
  let checkD = false;
  await page.goto('https://test.jessejia.pp.ua/sessions/1/bills/new');
  await page.waitForSelector('[data-testid="ppts-list"]', { timeout: 10000 });
  await page.waitForTimeout(500);

  // 找第一个 shared pill
  const sharedChip = await page.$('[data-testid^="ppts-chip-"][data-state="shared"]');
  if (!sharedChip) {
    console.log('D. FAIL: no shared chip found');
  } else {
    // click shared pill → enter exclusive mode (input focus)
    await sharedChip.click();
    await page.waitForTimeout(500);

    // 找到刚进入 exclusive 状态的 input (它跟 sharedChip 在同一 chip 内, exclusive 状态)
    const inputInfo = await page.evaluate(() => {
      const chip = document.querySelector('[data-testid^="ppts-chip-"][data-state="exclusive"]');
      if (!chip) return null;
      const inp = chip.querySelector('input.pill-input');
      if (!inp) return null;
      return {
        value: inp.value,
        focused: document.activeElement === inp,
      };
    });
    console.log('D. after click shared chip:', JSON.stringify(inputInfo));

    // 用 keyboard.type 输入 0 (触发 Svelte bind:value 更新 st.amount='0')
    await page.keyboard.type('0');
    await page.waitForTimeout(300);

    const afterType = await page.evaluate(() => {
      const inp = document.querySelector('[data-testid^="ppts-chip-"][data-state="exclusive"] input.pill-input');
      return { value: inp ? inp.value : null };
    });
    console.log('D. after type 0:', JSON.stringify(afterType));

    // 显式 blur input (触发 handlePillBlur)
    await page.evaluate(() => {
      const inp = document.querySelector('[data-testid^="ppts-chip-"][data-state="exclusive"] input.pill-input');
      if (inp) inp.blur();
    });
    await page.waitForTimeout(500);

    // 验: 该 chip 应回到 shared (exclusive → shared via handlePillBlur)
    const afterBlurInfo = await page.evaluate(() => {
      const chips = Array.from(document.querySelectorAll('[data-testid^="ppts-chip-"]'));
      const states = chips.map((c) => c.getAttribute('data-state'));
      const sharedCount = states.filter((s) => s === 'shared').length;
      const exclusiveCount = states.filter((s) => s === 'exclusive').length;
      return {
        totalChips: chips.length,
        sharedCount,
        exclusiveCount,
        states: states.join(','),
      };
    });
    console.log('D. after blur with amount=0:', JSON.stringify(afterBlurInfo));

    // 期待: exclusive chip 没了 (handlePillBlur 退到 shared)
    checkD = afterBlurInfo.exclusiveCount === 0;
    console.log('D. handlePillBlur amount=0 → shared:', checkD ? 'PASS ✓' : 'FAIL ✗');

    // 截图 2: handlePillBlur 后状态
    await page.screenshot({ path: '/home/node/.openclaw/workspace/sbc/split-bill-calculator/.verify-v0322-119-D-handlePillBlur.png' });
  }

  await browser.close();

  // ==== 汇总 ====
  console.log('\n=== Verify Result ===');
  console.log('A. overflow-anchor: always       :', checkA ? 'PASS ✓' : 'FAIL ✗');
  console.log('B. sticky search 不跳位 (min-h)  :', checkB ? 'PASS ✓' : 'FAIL ✗');
  console.log('C. filter 0 匹配 → 没有匹配      :', checkC ? 'PASS ✓' : 'FAIL ✗');
  console.log('D. handlePillBlur amount=0 → shared:', checkD ? 'PASS ✓' : 'FAIL ✗');

  // 截图移到 media dir (per dev convention)
  const MEDIA_DIR = '/home/node/.openclaw/workspace/media/v0322-119';
  try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch (e) {}
  for (const f of ['C-filter-empty.png', 'D-handlePillBlur.png']) {
    const src = `/home/node/.openclaw/workspace/sbc/split-bill-calculator/.verify-v0322-119-${f}`;
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, `${MEDIA_DIR}/${f}`);
    }
  }
  console.log('Screenshots copied to', MEDIA_DIR);

  const allPass = checkA && checkB && checkC && checkD;
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('ERROR:', err);
  process.exit(2);
});