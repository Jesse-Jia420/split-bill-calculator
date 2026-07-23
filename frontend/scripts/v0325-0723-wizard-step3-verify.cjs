// v0.3.25 #0723-wizard-step3 verify — Playwright iPhone 13 真机
//
// 1. 登录后 /sessions/new → 走到 step 3
// 2. 验 single mode 文案:
//    - "选择单币种或双币种结算" hint 已删
//    - IosSwitch option text = "单币种" + "双币种"
//    - conditional hint = "用于国内旅游、消费等场景"
//    - 主币种 label = "结算币种（用于朋友间结算的币种）"
// 3. 切到 dual mode (test path), 验:
//    - conditional hint = "用于出国旅游、消费等场景"
//    - 副币种 label = "支付币种（实际消费的币种）"

const { chromium } = require('playwright');

const TEST_URL = 'https://test.jessejia.pp.ua';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    locale: 'zh-CN',
  });
  const page = await ctx.newPage();

  console.log('## 1. login via BE API');
  await page.goto(`${TEST_URL}/auth/login`, { waitUntil: 'load' });
  await page.evaluate(async () => {
    await fetch('/api/auth/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'xinhua1001@outlook.com' }),
    });
    await fetch('/api/auth/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'xinhua1001@outlook.com', code: '000000' }),
    });
  });
  console.log('  ✓ login OK');

  console.log('## 2. navigate /sessions/new and reach step 3');
  await page.goto(`${TEST_URL}/sessions/new`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  // Step 1 (name) → fill → next
  await page.fill('#session-name', 'verify-test-0723');
  const nextBtn = page.locator('button[aria-label="下一步"]').first();
  if (await nextBtn.count() > 0) {
    await nextBtn.click();
    await page.waitForTimeout(500);
  }

  // Step 2 (members) → skip → next
  await page.waitForTimeout(500);
  const nextBtn2 = page.locator('button[aria-label="下一步"]').first();
  if (await nextBtn2.count() > 0) {
    await nextBtn2.click();
    await page.waitForTimeout(500);
  }

  await page.waitForTimeout(800);

  // Step 3 should now be visible. Verify checks.
  console.log('## 3. verify single mode (default)');

  const stepHints = await page.evaluate(() => {
    const ps = Array.from(document.querySelectorAll('p.step-hint'));
    return ps.map((p) => p.textContent);
  });
  console.log('  .step-hint count =', stepHints.length, '(should be 0)');

  const switchOptions = await page.evaluate(() => {
    const opt = document.querySelector('.ios-switch');
    if (!opt) return null;
    const options = Array.from(opt.querySelectorAll('button, .ios-switch-option, [role="option"]'))
      .map((b) => b.textContent.trim())
      .filter(Boolean);
    return options;
  });
  console.log('  IosSwitch options =', JSON.stringify(switchOptions), '(should be ["单币种", "双币种"])');

  const modeHint = await page.evaluate(() => {
    const el = document.querySelector('.currency-mode-hint');
    return el ? el.textContent.trim() : null;
  });
  console.log('  currency-mode-hint =', JSON.stringify(modeHint), '(should be "用于国内旅游、消费等场景")');

  const primaryLabel = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('label.currency-label'));
    return labels.map((l) => l.textContent.trim());
  });
  console.log('  primary label(s) =', JSON.stringify(primaryLabel), '(should contain "结算币种（用于朋友间结算的币种）")');

  await page.screenshot({
    path: '/home/node/.openclaw/media/browser/v0325-0723-wizard-step3-single.png',
    fullPage: false,
  });
  console.log('  ✓ saved v0325-0723-wizard-step3-single.png');

  // Try switching to dual mode
  console.log('## 4. switch to dual mode');
  const dualBtn = page.locator('.ios-switch button:has-text("双币种"), .ios-switch [role="option"]:has-text("双币种")').first();
  const dualBtnCount = await page.locator('.ios-switch button:has-text("双币种"), .ios-switch [role="option"]:has-text("双币种")').count();
  console.log('  dual button count =', dualBtnCount);
  if (dualBtnCount > 0) {
    const isDisabled = await dualBtn.evaluate((el) => el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled') || el.classList.contains('locked'));
    console.log('  dual disabled =', isDisabled);
    if (!isDisabled) {
      await dualBtn.click();
      await page.waitForTimeout(500);
    }
  }

  const modeHintDual = await page.evaluate(() => {
    const el = document.querySelector('.currency-mode-hint');
    return el ? el.textContent.trim() : null;
  });
  console.log('  currency-mode-hint (dual) =', JSON.stringify(modeHintDual), '(should be "用于出国旅游、消费等场景")');

  const secondaryLabel = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('label.currency-label'));
    return labels.length >= 2 ? labels[1].textContent.trim() : null;
  });
  console.log('  secondary label =', JSON.stringify(secondaryLabel));

  await page.screenshot({
    path: '/home/node/.openclaw/media/browser/v0325-0723-wizard-step3-dual.png',
    fullPage: false,
  });
  console.log('  ✓ saved v0325-0723-wizard-step3-dual.png');

  await browser.close();

  const checks = {
    step_hint_deleted: stepHints.length === 0,
    ios_switch_options: switchOptions && JSON.stringify(switchOptions) === JSON.stringify(['单币种', '双币种']),
    mode_hint_single_text: modeHint === '用于国内旅游、消费等场景',
    primary_label: primaryLabel && primaryLabel[0] === '结算币种（用于朋友间结算的币种）',
    mode_hint_dual_text: modeHintDual === '用于出国旅游、消费等场景',
    secondary_label: secondaryLabel === '支付币种（实际消费的币种）',
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