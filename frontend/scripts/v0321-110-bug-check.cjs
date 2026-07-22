#!/usr/bin/env node
/**
 * v0.3.21 #110 — Bill new/edit 页 datetime-local 超长 + member section 排版 verify (PO msg 18:46).
 *
 * Check Bug 1: <input type="datetime-local"> 是否溢出父容器
 * Check Bug 2: 成员 section "查看 x 人" 在折叠态下 vertical alignment + section 高度
 */
const { chromium } = require('playwright');

const FE = 'http://127.0.0.1:8448';
const TEST_EMAIL = 'demo@example.com';
const TEST_CODE = '000000';
const SCREENSHOT_DIR = '/home/node/.openclaw/media/v0321-110';

const fs = require('fs');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function apiLogin(context) {
  await context.request.post(`${FE}/api/auth/send-code`, { data: { email: TEST_EMAIL } });
  await context.request.post(`${FE}/api/auth/verify-code`, { data: { email: TEST_EMAIL, code: TEST_CODE } });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    locale: 'zh-CN',
  });
  await apiLogin(context);

  const results = { bug1: {}, bug2: {} };

  // ============= Bug 1: datetime-local overflow =============
  const p1 = await context.newPage();
  await p1.goto(`${FE}/sessions/1/bills/new`);
  await p1.waitForSelector('#occurredAt', { timeout: 10000 });
  await p1.waitForTimeout(500);

  // 量 datetime input 宽度
  const dtInfo = await p1.locator('#occurredAt').evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const parent = el.parentElement;
    const parentRect = parent ? parent.getBoundingClientRect() : null;
    const docW = document.documentElement.clientWidth;
    return {
      inputWidthPx: rect.width,
      inputX: rect.x,
      inputRight: rect.right,
      minWidthAttr: cs.minWidth,
      cssWidth: cs.width,
      parentWidthPx: parentRect?.width ?? null,
      parentPaddingLeft: parent ? getComputedStyle(parent).paddingLeft : null,
      viewportWidth: docW,
      documentScrollWidth: document.documentElement.scrollWidth,
      docOverflowX: document.documentElement.scrollWidth > docW,
    };
  });
  results.bug1.dt = dtInfo;
  results.bug1.inputWidthLessThanParent = dtInfo.inputWidthPx <= (dtInfo.parentWidthPx ?? Infinity);
  results.bug1.inputFitsInViewport = dtInfo.inputRight <= dtInfo.viewportWidth;

  await p1.screenshot({ path: `${SCREENSHOT_DIR}/01-bug1-bill-new-datetime.png`, fullPage: true });

  // ============= Bug 2: member section layout =============
  const p2 = await context.newPage();
  await p2.goto(`${FE}/sessions/1`);
  await p2.waitForSelector('.members-head', { timeout: 10000 });
  // 强制 set membersOpen=false 让 row3 出现 (PO 说的是折叠态下问题)
  await p2.evaluate(() => {
    localStorage.setItem('sbc.membersOpen.1', 'false');
  });
  // localStorage 在 navigate 后生效, 重新加载
  await p2.reload();
  await p2.waitForSelector('.members-head-row3', { timeout: 10000 });
  await p2.waitForTimeout(500);

  // session 1 有 6 成员, 手动 set 为折叠态
  // 测 row3 "查看 N 人" 的位置 + 整 .members-head 高度
  const memberSection = await p2.locator('.members-card').first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      boundingHeight: el.getBoundingClientRect().height,
      paddingTop: cs.paddingTop,
      paddingBottom: cs.paddingBottom,
      marginBottom: cs.marginBottom,
    };
  });
  const membersHead = await p2.locator('.members-head').first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      boundingHeight: el.getBoundingClientRect().height,
      childrenHeights: Array.from(el.children).map((c) => c.getBoundingClientRect().height),
    };
  });
  const row3Info = await p2.locator('.members-head-row3').first().evaluate((el) => {
    const hint = el.querySelector('.members-expand-hint');
    const hintRect = hint ? hint.getBoundingClientRect() : null;
    const elRect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      row3Height: elRect.height,
      row3MinHeight: cs.minHeight,
      row3PaddingTop: cs.paddingTop,
      row3PaddingBottom: cs.paddingBottom,
      row3MarginTop: cs.marginTop,
      hintTop: hintRect ? hintRect.top : null,
      hintBottom: hintRect ? hintRect.bottom : null,
      hintRelativeTopInRow3: hintRect && elRect ? (hintRect.top - elRect.top) : null,
    };
  });

  results.bug2.memberSection = memberSection;
  results.bug2.membersHead = membersHead;
  results.bug2.row3 = row3Info;

  await p2.screenshot({ path: `${SCREENSHOT_DIR}/02-bug2-session-detail-collapsed.png`, fullPage: false });
  await p2.close();
  await p1.close();
  await browser.close();

  console.log(JSON.stringify(results, null, 2));
})();