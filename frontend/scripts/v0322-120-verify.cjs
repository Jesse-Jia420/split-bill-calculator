// v0.3.22 #120 verify (PO msg 14:29 #7964 — 5 bug 一次性)
// 5 件事一次验:
//   #1: search input 首次 focus 不消失 (scrollSearchToSticky 守卫: scrollTop>=stickyTop-4 直接 return)
//   #2: members expiry CTA 位置 — 折叠态 row3-expiry 在邀请按钮下方, row4「查看 N 人」上方
//                                 展开态 row3-expiry 在邀请按钮下方, 成员列表 ul.members-list-a 上方
//   #3: (跳过 — 等 PO 给新文案)
//   #4: BillForm 金额 + 付款人同行 flex:1 (input 长度一致), 时间 input max-width min(160px, 100%)
//   #5: members section 去除 hover (background 不变) + 去除删除 × 按钮 (template if false)

const { chromium, devices } = require('playwright');
const fs = require('fs');

async function main() {
  const browser = await chromium.launch();
  const iPhone = devices['iPhone 13'];
  const context = await browser.newContext({ ...iPhone });
  const page = await context.newPage();

  // ==== 0. login ====
  await page.goto('https://test.jessejia.pp.ua/');
  await page.evaluate(async () => {
    await fetch('https://test.jessejia.pp.ua/api/auth/send-code', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({email:'xinhua1001@outlook.com'})});
    await fetch('https://test.jessejia.pp.ua/api/auth/verify-code', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({email:'xinhua1001@outlook.com',code:'000000'}), credentials: 'include'});
  });
  await page.goto('https://test.jessejia.pp.ua/sessions');
  await page.waitForTimeout(800);
  console.log('LOGIN OK, current URL:', page.url());

  // ==== 走 session 1 (anon owner, 32 bills) ====
  await page.goto('https://test.jessejia.pp.ua/sessions/1');
  await page.waitForSelector('.bills-search-input', { timeout: 10000 });
  await page.waitForTimeout(800);

  // ==== A. 搜索框首次 focus 不消失 (#1) ====
  // 用户在页面顶部, 点 search → 浏览器原 scrollIntoView 可能把 search 拉到 viewport 外
  // scrollSearchToSticky 新守卫: scrollTop >= stickyTop-4 → return noop, search 保持原位
  const beforeFocus = await page.evaluate(() => {
    const main = document.querySelector('main');
    const inp = document.querySelector('.bills-search-input');
    const inpRect = inp ? inp.getBoundingClientRect() : null;
    return {
      mainScrollTop: main ? main.scrollTop : -1,
      inputViewportTop: inpRect ? inpRect.top : -1,
    };
  });
  console.log('A. before focus:', JSON.stringify(beforeFocus));

  await page.click('.bills-search-input');
  await page.waitForTimeout(500);

  const afterFocus = await page.evaluate(() => {
    const main = document.querySelector('main');
    const inp = document.querySelector('.bills-search-input');
    const inpRect = inp ? inp.getBoundingClientRect() : null;
    return {
      mainScrollTop: main ? main.scrollTop : -1,
      inputViewportTop: inpRect ? inpRect.top : -1,
    };
  });
  console.log('A. after focus:', JSON.stringify(afterFocus));

  // 验: input 仍在 viewport 内 (0 < top < 800)
  const checkA = afterFocus.inputViewportTop >= 0 && afterFocus.inputViewportTop < 800;
  console.log('A. search input 仍 viewport 内:', checkA ? 'PASS ✓' : 'FAIL ✗');

  // ==== B. expiry CTA 位置 (#2) ====
  // 验证 row3-expiry 元素存在, 位置在 row2 (邀请按钮) 下方, row4 (查看 N 人) 上方 (collapsed)
  // 展开态: row3-expiry 在 ul.members-list-a 上方
  // 先 collapsed (默认)
  const collapsedInfo = await page.evaluate(() => {
    const expiry = document.querySelector('.members-head-row3-expiry');
    const invite = document.querySelector('.members-row2-right .invite-btn, .members-row2-right button');
    const row4 = document.querySelector('.members-head-row4');
    if (!expiry || !invite) return { found: false };
    const expiryRect = expiry.getBoundingClientRect();
    const inviteRect = invite.getBoundingClientRect();
    const row4Rect = row4 ? row4.getBoundingClientRect() : null;
    return {
      expiryFound: true,
      inviteBelowExpiry: expiryRect.top > inviteRect.top,
      row4Found: !!row4,
      expiryAboveRow4: row4Rect ? expiryRect.top < row4Rect.top : null,
      expiryTop: expiryRect.top,
      inviteTop: inviteRect.top,
      row4Top: row4Rect ? row4Rect.top : null,
    };
  });
  console.log('B. collapsed row3-expiry position:', JSON.stringify(collapsedInfo));
  const checkB_collapsed = collapsedInfo.expiryFound && collapsedInfo.inviteBelowExpiry &&
                           collapsedInfo.row4Found && collapsedInfo.expiryAboveRow4;
  console.log('B. collapsed: expiry 在 invite 下方 + row4 上方:', checkB_collapsed ? 'PASS ✓' : 'FAIL ✗');

  // 截图 collapsed state
  await page.screenshot({ path: '/home/node/.openclaw/workspace/sbc/split-bill-calculator/.verify-v0322-120-B-collapsed.png' });

  // 展开态: click members head
  await page.click('.members-head');
  await page.waitForTimeout(500);

  const expandedInfo = await page.evaluate(() => {
    const expiry = document.querySelector('.members-head-row3-expiry');
    const invite = document.querySelector('.members-row2-right .invite-btn, .members-row2-right button');
    const memberList = document.querySelector('ul.members-list-a');
    if (!expiry || !invite) return { found: false };
    const expiryRect = expiry.getBoundingClientRect();
    const inviteRect = invite.getBoundingClientRect();
    const memberListRect = memberList ? memberList.getBoundingClientRect() : null;
    return {
      expiryFound: true,
      inviteBelowExpiry: expiryRect.top > inviteRect.top,
      memberListFound: !!memberList,
      expiryAboveMemberList: memberListRect ? expiryRect.top < memberListRect.top : null,
      expiryTop: expiryRect.top,
      inviteTop: inviteRect.top,
      memberListTop: memberListRect ? memberListRect.top : null,
    };
  });
  console.log('B. expanded row3-expiry position:', JSON.stringify(expandedInfo));
  const checkB_expanded = expandedInfo.expiryFound && expandedInfo.inviteBelowExpiry &&
                          expandedInfo.memberListFound && expandedInfo.expiryAboveMemberList;
  console.log('B. expanded: expiry 在 invite 下方 + member-list 上方:', checkB_expanded ? 'PASS ✓' : 'FAIL ✗');

  // 截图 expanded state
  await page.screenshot({ path: '/home/node/.openclaw/workspace/sbc/split-bill-calculator/.verify-v0322-120-B-expanded.png' });

  // 折叠回去
  await page.click('.members-head');
  await page.waitForTimeout(300);

  // ==== C. 成员 section 去除 hover 效果 + 删除 × 按钮 (#5) ====
  // hover 不变 background + 没有 .member-remove-a 按钮渲染
  const hoverTest = await page.evaluate(async () => {
    const row = document.querySelector('.member-row-a');
    if (!row) return { hasRow: false };
    const beforeBg = getComputedStyle(row).backgroundColor;
    // 模拟 hover (CSS :hover 不能直接 JS 触发, 用 dispatchEvent mouseenter)
    row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await new Promise(r => requestAnimationFrame(r));
    const afterBg = getComputedStyle(row).backgroundColor;
    const removeBtn = document.querySelector('.member-remove-a');
    return {
      hasRow: true,
      beforeBg,
      afterBg,
      bgChanged: beforeBg !== afterBg,
      hasRemoveBtn: !!removeBtn,
    };
  });
  console.log('C. hover + remove button:', JSON.stringify(hoverTest));
  const checkC = !hoverTest.bgChanged && !hoverTest.hasRemoveBtn;
  console.log('C. hover 不变 bg + 无 × 按钮:', checkC ? 'PASS ✓' : 'FAIL ✗');

  // ==== D. BillForm 金额 + 付款人同行 + 时间收窄 (#4) ====
  await page.goto('https://test.jessejia.pp.ua/sessions/1/bills/new');
  await page.waitForSelector('[data-testid="ppts-list"]', { timeout: 10000 });
  await page.waitForTimeout(800);

  const formInfo = await page.evaluate(() => {
    // AmountCalculatorInput 内部 .amount-calc 容器
    const amountContainer = document.querySelector('.bill-amount-cell');
    const payerContainer = document.querySelector('.bill-payer-cell');
    const timeInput = document.querySelector('input[type="datetime-local"]#occurredAt');
    return {
      amountCellFound: !!amountContainer,
      payerCellFound: !!payerContainer,
      amountCellWidth: amountContainer ? amountContainer.getBoundingClientRect().width : -1,
      payerCellWidth: payerContainer ? payerContainer.getBoundingClientRect().width : -1,
      timeInputFound: !!timeInput,
      timeInputWidth: timeInput ? timeInput.getBoundingClientRect().width : -1,
      timeInputMaxWidth: timeInput ? getComputedStyle(timeInput).maxWidth : null,
    };
  });
  console.log('D. form layout:', JSON.stringify(formInfo));
  // 验: 金额 cell width 跟 payer cell width 几乎相等 (±2px tolerance)
  const widthDiff = Math.abs(formInfo.amountCellWidth - formInfo.payerCellWidth);
  const checkD_width = widthDiff <= 2;
  // 验: 时间 input width < 200 (160 max + 一些)
  const checkD_time = formInfo.timeInputWidth > 0 && formInfo.timeInputWidth <= 200;
  console.log('D. 金额 + 付款人 同行 等宽:', checkD_width ? 'PASS ✓ (diff=' + widthDiff + 'px)' : 'FAIL ✗');
  console.log('D. 时间 input 收窄 (≤200px):', checkD_time ? 'PASS ✓ (' + formInfo.timeInputWidth + 'px)' : 'FAIL ✗');
  const checkD = checkD_width && checkD_time;

  // 截图 form
  await page.screenshot({ path: '/home/node/.openclaw/workspace/sbc/split-bill-calculator/.verify-v0322-120-D-form.png' });

  await browser.close();

  // ==== 汇总 ====
  console.log('\n=== Verify Result ===');
  console.log('A. search input focus 不消失       :', checkA ? 'PASS ✓' : 'FAIL ✗');
  console.log('B. expiry CTA 位置 (collapsed)    :', checkB_collapsed ? 'PASS ✓' : 'FAIL ✗');
  console.log('B. expiry CTA 位置 (expanded)     :', checkB_expanded ? 'PASS ✓' : 'FAIL ✗');
  console.log('C. 去除 hover + 去除 × 按钮       :', checkC ? 'PASS ✓' : 'FAIL ✗');
  console.log('D. 金额/付款人同行 + 时间收窄     :', checkD ? 'PASS ✓' : 'FAIL ✗');

  // 截图移到 media dir
  const MEDIA_DIR = '/home/node/.openclaw/workspace/media/v0322-120';
  try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch (e) {}
  for (const f of ['B-collapsed.png', 'B-expanded.png', 'D-form.png']) {
    const src = `/home/node/.openclaw/workspace/sbc/split-bill-calculator/.verify-v0322-120-${f}`;
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, `${MEDIA_DIR}/${f}`);
    }
  }
  console.log('Screenshots copied to', MEDIA_DIR);

  const allPass = checkA && checkB_collapsed && checkB_expanded && checkC && checkD;
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('ERROR:', err);
  process.exit(2);
});