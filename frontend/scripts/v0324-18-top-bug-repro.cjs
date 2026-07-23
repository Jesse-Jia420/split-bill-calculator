// v0.3.24 Top #1 + Top #2 真机复现 + bbox 量化
// Top #1: "新建,编账单页, 日期选框还是超出表单了. 你自己看一下"
// Top #2: "新建,编账单页, 最下边参与者的 个人消费 input focus 时,
//          键盘弹出不会拖起页面, 导致用户看不到在输入的东西是什么"
// 这俩都是 iOS 真机 iPhone 13 Safari 表现, Playwright headless 模拟不到键盘,
// 但能给出 baseline DOM bbox + 视觉证据, 协助 Master 决定修法.
//
// 输出: 6 PNG 存 ~/.openclaw/media/browser/v0324-top-bugs/ + 文本量化数据.

const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const BASE = 'https://test.jessejia.pp.ua';
const VERIFY_DIR = '/home/node/.openclaw/media/browser/v0324-top-bugs';
fs.mkdirSync(VERIFY_DIR, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  });
  const page = await ctx.newPage();

  // ---- Pre-flight: login via API ----
  await page.goto(`${BASE}/`);
  await page.evaluate(async (base) => {
    await fetch(`${base}/auth/send-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@example.com' })
    });
    await fetch(`${base}/auth/verify-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@example.com', code: '000000' })
    });
  }, BASE);

  // ---- Navigate to /sessions/1/bills/new ----
  await page.goto(`${BASE}/sessions/1/bills/new`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  console.log('\n========== Top #1: 日期选框是否超出表单 ==========');
  const top1 = await page.evaluate(() => {
    const form = document.querySelector('form#bill-form');
    const occurred = document.querySelector('input[type="datetime-local"]#occurredAt');
    if (!form || !occurred) return null;
    const fr = form.getBoundingClientRect();
    const or_ = occurred.getBoundingClientRect();
    const cs = window.getComputedStyle(occurred);
    return {
      form: { x: fr.x, y: fr.y, w: fr.width, h: fr.height, right: fr.right, bottom: fr.bottom },
      occurred: { x: or_.x, y: or_.y, w: or_.width, h: or_.height, right: or_.right, bottom: or_.bottom },
      overflowRight: or_.right > fr.right,
      overflowLeft: or_.x < fr.x,
      width: or_.width,
      maxWidth: cs.maxWidth,
      minWidth: cs.minWidth,
      paddingBlock: cs.paddingBlock,
      paddingInline: cs.paddingInline
    };
  });
  console.log(JSON.stringify(top1, null, 2));

  await page.screenshot({ path: path.join(VERIFY_DIR, '01-top1-bills-new-initial.png') });

  // scroll to occurred input for close-up
  await page.evaluate(() => {
    const e = document.querySelector('input[type="datetime-local"]#occurredAt');
    e?.scrollIntoView({ block: 'center', behavior: 'instant' });
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(VERIFY_DIR, '02-top1-bills-new-zoom.png') });

  // ---- Top #2: 个人消费 input focus ----
  console.log('\n========== Top #2: 最下边个人消费 input focus ==========');

  // Find ppts li last
  const top2pre = await page.evaluate(() => {
    const ppts = document.querySelectorAll('li[data-testid^="ppts-li-"]');
    if (ppts.length === 0) return null;
    const last = ppts[ppts.length - 1];
    const input = last.querySelector('input[type="number"], input[type="text"], input[class*="amount"], input[class*="consume"]');
    return {
      liCount: ppts.length,
      lastHasInput: !!input,
      lastInputTag: input?.tagName,
      lastInputType: input?.getAttribute('type'),
      lastInputClass: input?.className,
      lastInputPlaceholder: input?.getAttribute('placeholder'),
      lastLiRect: last.getBoundingClientRect()
    };
  });
  console.log('Pre-flight:', JSON.stringify(top2pre, null, 2));

  // Find per-member input (search for "个人消费" placeholder or member-amount input)
  const lastMemberInput = await page.evaluate(() => {
    const all = document.querySelectorAll('input');
    for (const inp of all) {
      const ph = inp.getAttribute('placeholder') || '';
      const ac = inp.getAttribute('aria-label') || '';
      if (ph.includes('个人消费') || ac.includes('个人消费') ||
          inp.classList.contains('member-amount') || inp.classList.contains('personal-amount')) {
        const r = inp.getBoundingClientRect();
        return {
          tag: inp.tagName,
          type: inp.getAttribute('type'),
          placeholder: ph,
          ariaLabel: ac,
          className: inp.className,
          rect: { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom }
        };
      }
    }
    return null;
  });
  console.log('Last member input found:', JSON.stringify(lastMemberInput, null, 2));

  if (lastMemberInput) {
    // Click the input
    await page.evaluate(() => {
      const all = document.querySelectorAll('input');
      for (const inp of all) {
        const ph = inp.getAttribute('placeholder') || '';
        const ac = inp.getAttribute('aria-label') || '';
        if (ph.includes('个人消费') || ac.includes('个人消费') ||
            inp.classList.contains('member-amount') || inp.classList.contains('personal-amount')) {
          inp.focus();
          inp.scrollIntoView({ block: 'center', behavior: 'instant' });
          return;
        }
      }
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(VERIFY_DIR, '03-top2-bills-new-input-focused.png') });

    // Scroll position after focus
    const top2post = await page.evaluate(() => {
      const main = document.querySelector('main');
      const inp = Array.from(document.querySelectorAll('input')).find(i => {
        const ph = i.getAttribute('placeholder') || '';
        const ac = i.getAttribute('aria-label') || '';
        return ph.includes('个人消费') || ac.includes('个人消费');
      });
      if (!main || !inp) return null;
      const r = inp.getBoundingClientRect();
      const isVisible = r.top >= 0 && r.bottom <= window.innerHeight && r.top < window.innerHeight;
      return {
        scrollTop: main.scrollTop,
        inputTop: r.top,
        inputBottom: r.bottom,
        viewportH: window.innerHeight,
        isFullyVisible: isVisible,
        distanceFromTop: r.top,
        distanceFromBottom: window.innerHeight - r.bottom
      };
    });
    console.log('After focus:', JSON.stringify(top2post, null, 2));

    // Try typing to see if input stays visible
    await page.keyboard.type('99');
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(VERIFY_DIR, '04-top2-bills-new-after-type.png') });

    const top2after = await page.evaluate(() => {
      const main = document.querySelector('main');
      const inp = Array.from(document.querySelectorAll('input')).find(i => {
        const ph = i.getAttribute('placeholder') || '';
        const ac = i.getAttribute('aria-label') || '';
        return ph.includes('个人消费') || ac.includes('个人消费');
      });
      if (!main || !inp) return null;
      const r = inp.getBoundingClientRect();
      return {
        scrollTop: main.scrollTop,
        inputValue: inp.value,
        inputTop: r.top,
        inputBottom: r.bottom,
        isFullyVisible: r.top >= 0 && r.bottom <= window.innerHeight && r.top < window.innerHeight
      };
    });
    console.log('After type:', JSON.stringify(top2after, null, 2));
  }

  // ---- Also try edit page ----
  console.log('\n========== Edit page (bills/1/edit) ==========');
  await page.goto(`${BASE}/sessions/1/bills/1/edit`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const top1edit = await page.evaluate(() => {
    const form = document.querySelector('form#bill-form');
    const occurred = document.querySelector('input[type="datetime-local"]#occurredAt');
    if (!form || !occurred) return null;
    const fr = form.getBoundingClientRect();
    const or_ = occurred.getBoundingClientRect();
    return {
      form: { x: fr.x, y: fr.y, w: fr.width, right: fr.right },
      occurred: { x: or_.x, y: or_.y, w: or_.width, right: or_.right },
      overflowRight: or_.right > fr.right,
      overflowLeft: or_.x < fr.x
    };
  });
  console.log('Edit:', JSON.stringify(top1edit, null, 2));
  await page.screenshot({ path: path.join(VERIFY_DIR, '05-top1-bills-edit.png') });

  await browser.close();
  console.log('\n========== DONE ==========');
  console.log(`Screenshots: ${VERIFY_DIR}/`);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});