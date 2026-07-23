// v0.3.25 Top #2 verify — iOS Safari keyboard 起来时个人消费 input 是否被遮
// 模拟键盘 (window.resize 减小 height) → focus input → 等三次 scrollIntoView 重试
// → 验 input 在 viewport 内 (input.bottom < viewport.height) + CSS 实测
//
// 用 session 9 (泰国测试账单 2 7.25-7.28, 5 人) - bills/new

const { chromium } = require('playwright');

const TEST_URL = 'https://test.jessejia.pp.ua';
const SESSION_ID = 9;

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, // iPhone 13
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    locale: 'zh-CN',
  });
  const page = await ctx.newPage();

  // --- 1. 登录 via BE API (cookie jar) ---
  console.log('## 1. login via BE API');
  await page.goto(`${TEST_URL}/auth/login`, { waitUntil: 'load' });
  await page.evaluate(async () => {
    const sendCode = await fetch('/api/auth/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@example.com' }),
    });
    if (!sendCode.ok) throw new Error('send-code failed: ' + sendCode.status);
    const verifyCode = await fetch('/api/auth/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@example.com', code: '000000' }),
    });
    if (!verifyCode.ok) throw new Error('verify-code failed: ' + verifyCode.status);
  });
  console.log('  ✓ login OK');

  // --- 2. 进 bills/new for session 9 ---
  console.log('## 2. navigate /sessions/' + SESSION_ID + '/bills/new');
  await page.goto(`${TEST_URL}/sessions/${SESSION_ID}/bills/new`, { waitUntil: 'load' });
  await page.waitForTimeout(3000);

  // DEBUG: screenshot what page renders
  await page.screenshot({
    path: '/home/node/.openclaw/media/browser/v0325-top2-debug-page.png',
    fullPage: false,
  });
  const html = await page.evaluate(() => document.body.innerHTML.length);
  console.log('  body innerHTML length =', html);
  const formExists = await page.evaluate(() => !!document.querySelector('form#bill-form'));
  console.log('  form#bill-form exists =', formExists);
  const pageContent = await page.evaluate(() => document.body.innerText.slice(0, 500));
  console.log('  page text (first 500 chars) =', JSON.stringify(pageContent));

  // --- 3. CSS 实测: form .stack padding-bottom ---
  console.log('## 3. CSS computed style check (pre-click)');
  const stackPaddingBottom = await page.evaluate(() => {
    const form = document.querySelector('form#bill-form.stack');
    if (!form) return null;
    return window.getComputedStyle(form).paddingBottom;
  });
  console.log('  form .stack padding-bottom =', stackPaddingBottom);

  // --- 4. 模拟 keyboard 起来: window resize 模拟 iOS keyboard ---
  console.log('## 4. simulate keyboard (resize viewport to 390x520)');
  await page.setViewportSize({ width: 390, height: 520 });
  await page.waitForTimeout(300);

  // --- 5. click 最后一个 member 的 ¥ button → enterExclusiveMode → focus input ---
  console.log('## 5. click last member ¥ button to enter exclusive mode');
  // pill-inputs appear after click ¥ button (only when exclusive). First click ¥ button.
  const yenButtons = await page.locator('button[aria-label*="设置个人消费"]').count();
  console.log('  ¥ button count =', yenButtons);

  // Click last ¥ button (shared pill - aria-label "为 X 设置个人消费")
  const lastYenBtn = page.locator('button[aria-label*="设置个人消费"]').last();
  await lastYenBtn.click();
  console.log('  ✓ last ¥ button clicked');

  // --- 5.5. pill-input CSS 实测 (after click, in exclusive mode) ---
  await page.waitForTimeout(100);
  const pillInputs = await page.locator('input.pill-input').count();
  console.log('  pill-input count (after click) =', pillInputs);

  const firstPillInputScrollMarginBottom = await page.evaluate(() => {
    const input = document.querySelector('input.pill-input');
    if (!input) return null;
    return window.getComputedStyle(input).scrollMarginBottom;
  });
  console.log('  first pill-input scroll-margin-bottom =', firstPillInputScrollMarginBottom);

  // --- 6. 等三次 scrollIntoView 重试 (rAF + 350ms + 700ms = 总 ~800ms) ---
  await page.waitForTimeout(900);

  // --- 7. 取最后 focused pill-input 的 bounding rect ---
  console.log('## 6. verify focused input in viewport');
  const inputRect = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input.pill-input'));
    // Find the focused one (or the last one)
    let active = document.activeElement;
    if (!active || !active.classList.contains('pill-input')) {
      active = inputs[inputs.length - 1];
    }
    if (!active) return null;
    const r = active.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
  });
  console.log('  input rect =', inputRect);

  const viewportHeight = 520; // simulated keyboard
  const inputBottomBelowKeyboard = inputRect && inputRect.bottom > viewportHeight;
  const inputTopAboveViewport = inputRect && inputRect.top < 0;
  console.log('  viewport height =', viewportHeight);
  console.log('  input.bottom > viewport.height ?', inputBottomBelowKeyboard, '(should be false)');
  console.log('  input.top < 0 ?', inputTopAboveViewport, '(should be false)');

  // --- 8. 截图存证 ---
  console.log('## 7. screenshot');
  await page.screenshot({
    path: '/home/node/.openclaw/media/browser/v0325-top2-keyboard-test.png',
    fullPage: false,
  });
  console.log('  ✓ saved v0325-top2-keyboard-test.png');

  // --- 9. 恢复 viewport + click last ¥ button exit exclusive ---
  console.log('## 8. restore viewport');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);

  await browser.close();

  // --- 10. 最终判定 ---
  const checks = {
    form_stack_padding_bottom_280px: stackPaddingBottom === '280px',
    pill_input_count_at_least_1: pillInputs >= 1, // click 1 个 ¥ button → 至少 1 exclusive input 出现
    pill_input_scroll_margin_bottom_280px: firstPillInputScrollMarginBottom === '280px',
    input_in_viewport: !inputBottomBelowKeyboard && !inputTopAboveViewport,
  };
  console.log('\n## FINAL CHECKS');
  for (const [k, v] of Object.entries(checks)) {
    console.log(`  ${v ? '✓' : '✗'} ${k}`);
  }
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n## RESULT: ${allPass ? 'PASS' : 'FAIL'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error('ERROR:', e);
  process.exit(2);
});