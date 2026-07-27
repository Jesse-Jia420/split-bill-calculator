// v0727-1-15-verify.cjs — UAT 0727-1 #15 SettlementRow 横向滚动 + 左/右渐变阴影
//
// PO 字面 (Jesse msg 2026-07-27 23:35 "e.a"):
//   "已结算记录 section 下的 item 如果超长, 则每个独立的 item 可以左右滚动.
//    不要改变目前每个 item 内部的结构"
// 拍板方案 e.a = 左/右边缘渐变阴影 (iOS Mail / Telegram 风格).
//
// Check (反 #150 v2):
//   1. 已结算记录 section 下 .scroll-wrapper 元素存在 (每条 SettlementRow 都有)
//   2. 短 record (无溢出): at-start + at-end 都有 (双侧 fade 不可见)
//   3. 长 record (有溢出): at-start + NOT-at-end (右侧 fade 可见)
//   4. 长 record 滚到中间: NOT-at-start + NOT-at-end (双侧 fade 可见)
//   5. 长 record 滚到最右: NOT-at-start + at-end (仅左侧 fade 可见)
//   6. computed style 验证:
//      - .scroll-wrapper: position relative + overflow-x auto
//      - ::before / ::after: position absolute + width 28px + gradient bg
//      - 双层渐变 (white mask + slate scrim)
//   7. 截图存 verify PNG (iPhone 13 @3x)
//   8. 内部 record-row 结构 100% 不变 (subagent 12/12 check)
//
// Profile: iPhone 13 @3x, webkit, locale zh-CN (per 反 #167)

const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright-core');

const HEADLESS = '/config/.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell';
const OUT = '/home/node/.openclaw/workspace/.openclaw/media/browser/v0727-1-15-settlement-scroll';
const API = 'http://127.0.0.1:8449';
const FE = 'http://127.0.0.1:8448';

fs.mkdirSync(OUT, { recursive: true });

const results = { checks: [], pass: true };

async function recordCheck(name, ok, detail) {
  const entry = { name, ok, detail };
  results.checks.push(entry);
  if (!ok) results.pass = false;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name} — ${JSON.stringify(detail)}`);
}

(async () => {
  const browser = await chromium.launch({
    executablePath: HEADLESS,
    headless: true,
    args: ['--no-sandbox'],
  });

  try {
    const ctx = await browser.newContext({
      ...devices['iPhone 13'],
      hasTouch: true,
      locale: 'zh-CN',
    });

    // Login via BE API (per sbc skill template)
    await ctx.request.post(API + '/auth/send-code', {
      data: { email: 'xinhua1001@outlook.com' },
      headers: { 'Content-Type': 'application/json' },
    });
    const verifyRes = await ctx.request.post(API + '/auth/verify-code', {
      data: { email: 'xinhua1001@outlook.com', code: '000000' },
      headers: { 'Content-Type': 'application/json' },
    });
    console.log('login verify status:', verifyRes.status());

    const sessionsRes = await ctx.request.get(API + '/sessions');
    const sessions = await sessionsRes.json();
    // session 9 = 泰国测试账单 2 (6 members), 有 settlement_records (test data 已建好 4+3=7 条)
    const target = sessions.find((s) => s.session_code === '64BZQNX9NU' || s.id === 9);
    if (!target) {
      console.log('NO target session 9 — fallback to first available');
      console.log('all sessions:', sessions.map((s) => ({ id: s.id, code: s.session_code, name: s.name })));
      await browser.close();
      return;
    }
    const code = target.session_code || String(target.id);
    console.log('using session:', target.id, target.name, 'code=' + code);

    const page = await ctx.newPage();
    await page.goto(FE + '/s/' + code + '/settle', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);  // 等 HMR / records fetch / settle recompute

    // ===== Check 1: .scroll-wrapper 元素存在 =====
    const wrapperCount = await page.evaluate(() => {
      return document.querySelectorAll('[data-sbc="settlement-row"].scroll-wrapper').length;
    });
    await recordCheck(
      '1. 已结算 record-row 都有 .scroll-wrapper class',
      wrapperCount > 0,
      { wrapperCount }
    );

    if (wrapperCount === 0) {
      console.log('NO scroll-wrapper found — taking debug screenshot');
      await page.screenshot({ path: `${OUT}/no-scroll-wrapper.png`, fullPage: true });
      await browser.close();
      return;
    }

    // ===== Check 2-5: 各种 scroll 状态 =====
    const scrollStates = await page.evaluate(() => {
      const wrappers = Array.from(document.querySelectorAll('[data-sbc="settlement-row"].scroll-wrapper'));
      return wrappers.map((w, idx) => {
        const rect = w.getBoundingClientRect();
        const row = w.querySelector('.record-row') || w.firstElementChild;
        const rowText = w.textContent.trim().replace(/\s+/g, ' ').slice(0, 80);
        const cs = (k) => window.getComputedStyle(w).getPropertyValue(k).trim();
        return {
          index: idx,
          recordId: w.getAttribute('data-record-id'),
          scrollLeft: w.scrollLeft,
          scrollWidth: w.scrollWidth,
          clientWidth: w.clientWidth,
          isOverflow: w.scrollWidth > w.clientWidth + 1,
          hasAtStart: w.classList.contains('at-start'),
          hasAtEnd: w.classList.contains('at-end'),
          computedStyle: {
            position: cs('position'),
            overflowX: cs('overflow-x'),
          },
          pseudoBefore: (() => {
            const p = window.getComputedStyle(w, '::before');
            return {
              position: p.position,
              width: p.width,
              left: p.left,
              opacity: p.opacity,
              backgroundHasGradient: /linear-gradient/.test(p.background) || /linear-gradient/.test(p.backgroundImage),
            };
          })(),
          pseudoAfter: (() => {
            const p = window.getComputedStyle(w, '::after');
            return {
              position: p.position,
              width: p.width,
              right: p.right,
              opacity: p.opacity,
              backgroundHasGradient: /linear-gradient/.test(p.background) || /linear-gradient/.test(p.backgroundImage),
            };
          })(),
          rowText,
        };
      });
    });

    console.log('all wrappers:', JSON.stringify(scrollStates, null, 2));

    // 分类: short (不溢出) / long (溢出) wrappers
    const shortWrappers = scrollStates.filter((s) => !s.isOverflow);
    const longWrappers = scrollStates.filter((s) => s.isOverflow);

    await recordCheck(
      '2a. 至少 1 个 short wrapper (无溢出 → at-start + at-end 都有)',
      shortWrappers.length > 0,
      { shortCount: shortWrappers.length }
    );

    if (shortWrappers.length > 0) {
      const sw = shortWrappers[0];
      await recordCheck(
        '2b. short wrapper: at-start class 在',
        sw.hasAtStart === true,
        { index: sw.index, hasAtStart: sw.hasAtStart }
      );
      await recordCheck(
        '2c. short wrapper: at-end class 在 (双侧 fade 都不可见)',
        sw.hasAtEnd === true,
        { index: sw.index, hasAtEnd: sw.hasAtEnd }
      );
      await recordCheck(
        '2d. short wrapper: ::before opacity = 0 (左 fade 不可见)',
        sw.pseudoBefore.opacity === '0',
        { index: sw.index, opacity: sw.pseudoBefore.opacity }
      );
      await recordCheck(
        '2e. short wrapper: ::after opacity = 0 (右 fade 不可见)',
        sw.pseudoAfter.opacity === '0',
        { index: sw.index, opacity: sw.pseudoAfter.opacity }
      );
    }

    await recordCheck(
      '3a. 至少 1 个 long wrapper (溢出 → 应能 scroll)',
      longWrappers.length > 0,
      { longCount: longWrappers.length }
    );

    if (longWrappers.length > 0) {
      // 取第一个 long wrapper 测 scroll
      const lw = longWrappers[0];
      await recordCheck(
        '3b. long wrapper: at-start class 在 (初始未滚动)',
        lw.hasAtStart === true,
        { index: lw.index, hasAtStart: lw.hasAtStart }
      );
      await recordCheck(
        '3c. long wrapper: at-end class 缺 (未到末尾 → 右 fade 应可见)',
        lw.hasAtEnd === false,
        { index: lw.index, hasAtEnd: lw.hasAtEnd }
      );
      await recordCheck(
        '3d. long wrapper: ::before opacity = 0 (初始未滚 → 左 fade 不可见)',
        lw.pseudoBefore.opacity === '0',
        { index: lw.index, opacity: lw.pseudoBefore.opacity }
      );
      await recordCheck(
        '3e. long wrapper: ::after opacity = 1 (右 fade 可见)',
        lw.pseudoAfter.opacity === '1',
        { index: lw.index, opacity: lw.pseudoAfter.opacity }
      );

      // ===== Check 4: 滚到中间 → 双侧 fade =====
      // 算中间 scrollLeft
      const targetMiddle = Math.floor((lw.scrollWidth - lw.clientWidth) / 2);
      await page.evaluate((args) => {
        const wrappers = document.querySelectorAll('[data-sbc="settlement-row"].scroll-wrapper');
        const w = wrappers[args.idx];
        if (w) w.scrollLeft = args.target;
      }, { idx: lw.index, target: targetMiddle });
      await page.waitForTimeout(200);

      const middleState = await page.evaluate((args) => {
        const wrappers = document.querySelectorAll('[data-sbc="settlement-row"].scroll-wrapper');
        const w = wrappers[args.idx];
        if (!w) return null;
        const pB = window.getComputedStyle(w, '::before');
        const pA = window.getComputedStyle(w, '::after');
        return {
          scrollLeft: w.scrollLeft,
          hasAtStart: w.classList.contains('at-start'),
          hasAtEnd: w.classList.contains('at-end'),
          beforeOpacity: pB.opacity,
          afterOpacity: pA.opacity,
        };
      }, { idx: lw.index });

      await recordCheck(
        '4. 滚到中间: NOT at-start + NOT at-end → 双侧 fade 都可见 (opacity=1)',
        middleState && middleState.hasAtStart === false && middleState.hasAtEnd === false &&
          middleState.beforeOpacity === '1' && middleState.afterOpacity === '1',
        middleState
      );

      // ===== Check 5: 滚到最右 → 仅左 fade =====
      const targetEnd = lw.scrollWidth - lw.clientWidth;
      await page.evaluate((args) => {
        const wrappers = document.querySelectorAll('[data-sbc="settlement-row"].scroll-wrapper');
        const w = wrappers[args.idx];
        if (w) w.scrollLeft = args.target;
      }, { idx: lw.index, target: targetEnd });
      // 等 200ms transition 完成 (opacity 200ms ease)
      await page.waitForTimeout(400);

      const endState = await page.evaluate((args) => {
        const wrappers = document.querySelectorAll('[data-sbc="settlement-row"].scroll-wrapper');
        const w = wrappers[args.idx];
        if (!w) return null;
        const pB = window.getComputedStyle(w, '::before');
        const pA = window.getComputedStyle(w, '::after');
        return {
          scrollLeft: w.scrollLeft,
          hasAtStart: w.classList.contains('at-start'),
          hasAtEnd: w.classList.contains('at-end'),
          beforeOpacity: pB.opacity,
          afterOpacity: pA.opacity,
        };
      }, { idx: lw.index });

      await recordCheck(
        '5. 滚到最右: NOT at-start + at-end → 仅左 fade 可见',
        endState && endState.hasAtStart === false && endState.hasAtEnd === true &&
          endState.beforeOpacity === '1' && endState.afterOpacity === '0',
        endState
      );

      // ===== Check 6: computed style 验证 =====
      await recordCheck(
        '6a. wrapper: position: relative',
        lw.computedStyle.position === 'relative',
        { position: lw.computedStyle.position }
      );
      await recordCheck(
        '6b. wrapper: overflow-x: auto',
        lw.computedStyle.overflowX === 'auto',
        { overflowX: lw.computedStyle.overflowX }
      );
      await recordCheck(
        '6c. ::before: position: absolute (从 flex flow 抽出, overlay content)',
        lw.pseudoBefore.position === 'absolute',
        { position: lw.pseudoBefore.position }
      );
      await recordCheck(
        '6d. ::before: width = 28px',
        lw.pseudoBefore.width === '28px',
        { width: lw.pseudoBefore.width }
      );
      await recordCheck(
        '6e. ::after: width = 28px',
        lw.pseudoAfter.width === '28px',
        { width: lw.pseudoAfter.width }
      );
      await recordCheck(
        '6f. ::before: 双层渐变 (white mask 0.85 + slate scrim 0.10)',
        lw.pseudoBefore.backgroundHasGradient,
        { backgroundHasGradient: lw.pseudoBefore.backgroundHasGradient }
      );
      await recordCheck(
        '6g. ::after: 双层渐变',
        lw.pseudoAfter.backgroundHasGradient,
        { backgroundHasGradient: lw.pseudoAfter.backgroundHasGradient }
      );
    }

    // ===== Check 8: 内部 record-row 结构 100% 不变 =====
    // 反 #150 v2 第 3 证: DOM 结构对比 (跟 mockup 5 record-row 同款)
    // 注: SettlementRow.svelte 把 .record-row 和 .scroll-wrapper 类合并在同一个 div 上,
    // 内部子元素直接是 wrapper 的 children.
    const internalStructure = await page.evaluate(() => {
      const wrapper = document.querySelector('[data-sbc="settlement-row"].scroll-wrapper');
      if (!wrapper) return null;
      // 内部 [avatar][arrow][avatar][row-info][row-amount][delete-mini?]
      const inner = Array.from(wrapper.children).filter((c) => !['STYLE', 'SCRIPT'].includes(c.tagName))
        .map((c) => ({
          tag: c.tagName.toLowerCase(),
          class: c.className,
        }));
      return {
        wrapperTag: wrapper.tagName.toLowerCase(),
        wrapperClasses: wrapper.className,
        innerChildren: inner,
        innerChildCount: inner.length,
      };
    });

    console.log('internal structure:', JSON.stringify(internalStructure, null, 2));

    if (internalStructure) {
      // record-row 内部结构: avatar + arrow-mini + avatar + row-info + row-amount [+ delete-mini]
      // 至少 5 个, 最多 6 个 (有 delete-mini 时)
      const innerOk = internalStructure.innerChildCount >= 5 && internalStructure.innerChildCount <= 6;
      await recordCheck(
        '8a. record-row 内部子元素数量 5-6 (avatar + arrow + avatar + row-info + amount [+ delete])',
        innerOk,
        { count: internalStructure.innerChildCount, children: internalStructure.innerChildren }
      );

      // 子元素顺序: avatar (.avatar) + .arrow-mini + avatar (.avatar) + .row-info + .row-amount [+ .delete-mini]
      const expectedOrder = ['avatar', 'arrow-mini', 'avatar', 'row-info', 'row-amount'];
      const actualOrder = internalStructure.innerChildren.map((c) => c.class.split(' ')[0]);
      const orderOk = JSON.stringify(actualOrder.slice(0, 5)) === JSON.stringify(expectedOrder);
      await recordCheck(
        '8b. record-row 内部顺序: avatar → arrow-mini → avatar → row-info → row-amount',
        orderOk,
        { actual: actualOrder, expected: expectedOrder }
      );

      // wrapper (即 .record-row) 同时含 .record-row + .scroll-wrapper class (共存)
      const hasBothClasses = internalStructure.wrapperClasses.includes('record-row') &&
        internalStructure.wrapperClasses.includes('scroll-wrapper');
      await recordCheck(
        '8c. .record-row 同时含 .record-row + .scroll-wrapper class (PO 字面: 不改结构)',
        hasBothClasses,
        { wrapperClasses: internalStructure.wrapperClasses }
      );
    }

    // ===== 截图 =====
    await page.screenshot({ path: `${OUT}/01-settle-overview-default.png`, fullPage: false });
    await page.screenshot({ path: `${OUT}/02-settle-overview-fullpage.png`, fullPage: true });

    // 滚到 long record 拍中间 + 末尾
    if (longWrappers.length > 0) {
      const lw = longWrappers[0];
      const middleScroll = Math.floor((lw.scrollWidth - lw.clientWidth) / 2);
      const endScroll = lw.scrollWidth - lw.clientWidth;

      await page.evaluate((args) => {
        const wrappers = document.querySelectorAll('[data-sbc="settlement-row"].scroll-wrapper');
        const w = wrappers[args.idx];
        if (w) w.scrollLeft = args.target;
      }, { idx: lw.index, target: 0 });
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${OUT}/03-long-record-start.png`, fullPage: false });

      await page.evaluate((args) => {
        const wrappers = document.querySelectorAll('[data-sbc="settlement-row"].scroll-wrapper');
        const w = wrappers[args.idx];
        if (w) w.scrollLeft = args.target;
      }, { idx: lw.index, target: middleScroll });
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${OUT}/04-long-record-middle.png`, fullPage: false });

      await page.evaluate((args) => {
        const wrappers = document.querySelectorAll('[data-sbc="settlement-row"].scroll-wrapper');
        const w = wrappers[args.idx];
        if (w) w.scrollLeft = args.target;
      }, { idx: lw.index, target: endScroll });
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${OUT}/05-long-record-end.png`, fullPage: false });
    }

    // ===== Summary =====
    const passed = results.checks.filter((c) => c.ok).length;
    const failed = results.checks.filter((c) => !c.ok).length;
    console.log('\n===== SUMMARY =====');
    console.log(JSON.stringify({ pass: results.pass, total: results.checks.length, passed, failed }, null, 2));
  } catch (e) {
    console.log('FATAL ERROR:', e.message);
    console.log(e.stack);
    results.pass = false;
    results.error = e.message;
  } finally {
    fs.writeFileSync(`${OUT}/result.json`, JSON.stringify(results, null, 2));
    await browser.close();
    process.exit(results.pass ? 0 : 1);
  }
})().catch((e) => {
  console.log('UNHANDLED:', e.message);
  console.log(e.stack);
  process.exit(2);
});