// v0.3.21 #115+#116+#117 quick verify (PO msg 11:35 #7838)
// 4 bug 一次验:
//   #115 Bug 2: shared pill 货币在前, 字样在后
//   #116 Bug 1 + Bug 4: 搜索框删 scrollSearchToSticky (无 onfocus/oninput handler)
//   #117 Bug 3: enterExclusiveMode 显式 scrollIntoView (iOS keyboard 顶起页面)

const { chromium, devices } = require('playwright');

async function main() {
  const browser = await chromium.launch();
  const iPhone = devices['iPhone 13'];
  const context = await browser.newContext({ ...iPhone });
  const page = await context.newPage();

  // 1. login
  await page.goto('https://test.jessejia.pp.ua/auth/login');
  await page.fill('input[type="email"]', 'demo@example.com');
  await page.click('button[type="submit"]');
  await page.waitForSelector('input[name="code"]', { timeout: 5000 });
  await page.fill('input[name="code"]', '000000');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/sessions/, { timeout: 10000 });
  console.log('LOGIN OK, current URL:', page.url());

  // 2. go to session 1 bills/new → 验 #115 (shared pill 顺序)
  await page.goto('https://test.jessejia.pp.ua/sessions/1/bills/new');
  await page.waitForSelector('[data-testid="ppts-list"]', { timeout: 10000 });
  await page.waitForTimeout(500);

  // shared pill 在 participants list 里 — 找第一个 chip 看顺序
  const sharedChip = await page.$('[data-testid^="ppts-chip-"][data-state="shared"]');
  if (!sharedChip) {
    console.log('FAIL: no shared chip found');
    process.exit(1);
  }

  // 验 shared pill children: first child 应是 .pill-currency (¥), 第二个是 .pill-label
  const pillChildInfo = await sharedChip.evaluate((el) => {
    const children = Array.from(el.children);
    return children.map((c) => ({
      tag: c.tagName,
      class: c.className,
      text: c.textContent.trim(),
    }));
  });
  console.log('SHARED PILL CHILDREN:', JSON.stringify(pillChildInfo));

  // 验 currency 在前 (index 0), label 在后 (index 1)
  const check115 =
    pillChildInfo.length === 2 &&
    pillChildInfo[0].class.includes('pill-currency') &&
    pillChildInfo[1].class.includes('pill-label') &&
    pillChildInfo[0].text.length <= 3 && // ¥ or $
    pillChildInfo[1].text.includes('个人消费');
  console.log('#115 shared pill 货币在前:', check115 ? 'PASS ✓' : 'FAIL ✗');

  // 3. 验 #117 Bug 3: 点 shared pill → main.scrollTop 变化 (scrollIntoView 触发)
  // 滚到 members 列表底部
  await page.evaluate(() => {
    const main = document.querySelector('main');
    if (main) main.scrollTop = 0;
  });

  // 点 shared pill
  await sharedChip.click();
  await page.waitForTimeout(600);  // 等 rAF + smooth scroll 完成

  const mainScrollTopAfter = await page.evaluate(() => {
    const main = document.querySelector('main');
    return main ? main.scrollTop : -1;
  });
  console.log('MAIN scrollTop after click shared pill:', mainScrollTopAfter);
  const check117 = mainScrollTopAfter > 0;
  console.log('#117 iOS keyboard scrollIntoView:', check117 ? 'PASS ✓ (main.scrollTop > 0)' : 'FAIL ✗ (main.scrollTop 没变, scrollIntoView 没生效)');

  // 4. go to session 1 详情页 → 验 #116 (search input 无 onfocus/oninput handler)
  await page.goto('https://test.jessejia.pp.ua/sessions/1');
  await page.waitForSelector('.bills-search-input', { timeout: 10000 });
  await page.waitForTimeout(500);

  // 验 search input 没有 onfocus / oninput 属性 (用 page.evaluate 查 event handler 不可行, 改成验源码 import)
  // 用 getEventListeners (CDP) 不容易, 改用间接验: scrollSearchToSticky 函数不应被 reference
  const searchInputInfo = await page.evaluate(() => {
    const inp = document.querySelector('.bills-search-input');
    if (!inp) return null;
    return {
      type: inp.type,
      placeholder: inp.placeholder,
      ariaLabel: inp.getAttribute('aria-label'),
    };
  });
  console.log('SEARCH INPUT INFO:', JSON.stringify(searchInputInfo));

  // 间接验: 滚动 main 然后点 search, main.scrollTop 不应被程序化重置
  await page.evaluate(() => {
    const main = document.querySelector('main');
    if (main) main.scrollTop = 500;
  });
  await page.waitForTimeout(200);
  const scrollBeforeFocus = await page.evaluate(() => {
    const main = document.querySelector('main');
    return main ? main.scrollTop : -1;
  });
  console.log('MAIN scrollTop before focus search:', scrollBeforeFocus);

  await page.click('.bills-search-input');
  await page.waitForTimeout(800);  // 等可能的 smooth scroll

  const scrollAfterFocus = await page.evaluate(() => {
    const main = document.querySelector('main');
    return main ? main.scrollTop : -1;
  });
  console.log('MAIN scrollTop after focus search:', scrollAfterFocus);
  const check116 = Math.abs(scrollBeforeFocus - scrollAfterFocus) < 50;
  console.log('#116 search input focus 不重置滚动:', check116 ? 'PASS ✓ (scrollTop 保持稳定)' : 'FAIL ✗ (scrollTop 跳变)');

  // 5. 截图存证
  await page.screenshot({ path: '/home/node/.openclaw/workspace/sbc/split-bill-calculator/.verify-v0321-115-116-117.png', fullPage: false });
  console.log('SCREENSHOT saved');

  await browser.close();

  // 最终汇总
  console.log('\n=== Verify Result ===');
  console.log('#115 shared pill 货币在前:', check115 ? 'PASS ✓' : 'FAIL ✗');
  console.log('#116 search input focus 不重置滚动:', check116 ? 'PASS ✓' : 'FAIL ✗');
  console.log('#117 iOS keyboard scrollIntoView:', check117 ? 'PASS ✓' : 'FAIL ✗');
  process.exit(check115 && check116 && check117 ? 0 : 1);
}

main().catch((err) => {
  console.error('ERROR:', err);
  process.exit(2);
});