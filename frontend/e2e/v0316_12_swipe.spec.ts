/**
 * TEST-v0.3.16 #13 — Bill swipe button reveal reactivity hotfix.
 *
 * 根因 (PO msg 2026-07-16 23:56 续):
 *   #12 hotfix (clip-path layering) 没真正修复 PO 的 bug, 因为 swipe state
 *   (dragOffset/swipeOffset/isDragging/openSwipeBillId) 在 BillListGrouped.svelte
 *   用 plain `let`, Svelte 5 legacy 编译下没自动包 mutable_source,
 *   {@const leftProgress/rightProgress} 通过 getRowOffset() 读这些 state 时被
 *   $.untrack() 包, derived 不重算, --swipe-clip-* CSS var 永远是 0, clip-path
 *   永远 inset(0px), 按钮永远不出。
 *
 * 修法 (Coder):
 *   把 4 个影响 swipe 动画的 state 从 plain let 改 Svelte writable<>() store
 *   (Svelte 5 legacy 模式组件不能用 $state() runes — 会触发 auto-detection 进
 *   runes mode, 然后 export let 全报错)。其他 state (defaultOpenDates, collapsed)
 *   不动, 不影响 swipe。
 *
 * 验证方法:
 *   1. 用真 Playwright mouse drag (mousedown → mousemove → mouseup) 模拟 swipe,
 *      不再 forceSwipeState 绕开 reactivity bug。
 *   2. mid-drag 检查 --swipe-clip-* > 0 (证明 reactivity 生效, 不是 fix 前永远 0)。
 *   3. mouseup 后检查 snap 到 ±80px, clip-path inset 86px, 按钮 width≥80px opacity>0。
 *   4. 截图存到 SCREENSHOTS_DIR/v0316-13-swipe-{delete,edit}.png。
 *   5. image 工具肉眼确认按钮真的露出来 (不是 inset(0px))。
 *
 * 注意: 默认情况下 day groups 是 collapsed, 需要先点开 summary 才能看到 row。
 */
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import Database from "better-sqlite3";

const BASE = process.env.SBC_E2E_BASE_URL ?? "http://localhost:8448";
const SQLITE_PATH =
  process.env.SBC_SQLITE_PATH ?? "/config/workspace/split-bill-calculator/backend/data/sbc.db";
const SCREENSHOTS_DIR = "/home/node/.openclaw/media/browser";

function findThailandSessionId(): number {
  const db = new Database(SQLITE_PATH, { readonly: true });
  try {
    const row = db
      .prepare("SELECT id FROM sessions WHERE name LIKE '%泰国%' ORDER BY id DESC LIMIT 1")
      .get() as { id: number } | undefined;
    if (!row) throw new Error("泰国测试 session 不存在");
    return row.id;
  } finally {
    db.close();
  }
}

async function loginViaApi(page: Page): Promise<void> {
  const r1 = await page.request.post(`${BASE}/auth/send-code`, {
    data: { email: "xinhua1001@outlook.com" },
  });
  expect(r1.status(), "send-code").toBe(200);
  const r2 = await page.request.post(`${BASE}/auth/verify-code`, {
    data: { email: "xinhua1001@outlook.com", code: "000000" },
  });
  expect(r2.status(), "verify-code").toBe(200);

  const state = await page.request.storageState();
  const sbc = state.cookies.find((c) => c.name === "sbc_session");
  if (sbc) {
    await page.context().addCookies([
      {
        name: sbc.name,
        value: sbc.value,
        domain: sbc.domain,
        path: sbc.path,
        httpOnly: sbc.httpOnly ?? false,
        secure: sbc.secure ?? false,
        sameSite: "Lax",
      },
    ]);
  }
}

/** 把所有 day groups 都展开 (pre-existing 行为) */
async function expandAllDayGroups(page: Page): Promise<void> {
  const summaries = page.locator(".day-header");
  const n = await summaries.count();
  for (let i = 0; i < n; i++) {
    const s = summaries.nth(i);
    const parent = s.locator("xpath=..");
    const isOpen = await parent.evaluate((el: HTMLDetailsElement) => el.open);
    if (!isOpen) {
      await s.click();
      await page.waitForTimeout(280);
    }
  }
}

/** 找第一个在 viewport 内的 bill row 的中心点 (用于 mouse drag 起点) */
async function getFirstVisibleRowCenter(
  page: Page,
): Promise<{ x: number; y: number; width: number } | null> {
  return page.evaluate(() => {
    const wraps = [...document.querySelectorAll(".bill-swipe-wrap")];
    const inView = wraps.find((w) => {
      const rect = w.getBoundingClientRect();
      return rect.y >= 50 && rect.y < window.innerHeight - 50;
    });
    if (!inView) return null;
    const layer = inView.querySelector(".bill-info-layer") as HTMLElement;
    const rect = layer.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
    };
  });
}

/**
 * v0.3.16 #13: 用真 mouse drag 模拟 swipe (绕开 #12 的 forceSwipeState fallback)。
 * 走 mousedown → 8 帧 mousemove (steps 1 each, 20ms apart) → mouseup, 模拟真用户。
 * 总 drag 距离 100px (well over 60px threshold, 触发 snap 到 ±80px)。
 */
async function realMouseSwipe(
  page: Page,
  direction: "left" | "right",
): Promise<void> {
  const start = await getFirstVisibleRowCenter(page);
  if (!start) throw new Error("找不到 viewport 内的 bill row");
  const startX = start.x;
  const startY = start.y;
  const delta = direction === "left" ? -100 : 100;
  const endX = startX + delta;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // 8 帧 mousemove, 模拟真用户拖动
  for (let i = 1; i <= 8; i++) {
    const x = startX + delta * (i / 8);
    await page.mouse.move(x, startY, { steps: 1 });
    await page.waitForTimeout(20);
  }
  // 等 Svelte store 更新 + 浏览器 paint
  await page.waitForTimeout(80);
}

/**
 * 诊断第一个可见 bill row 的 swipe 状态。
 * 返回 { layerStyle, layerClipPath, clipLeft/clipRight, delBtnWidth/Opacity, editBtnWidth/Opacity }
 */
async function diagFirstVisibleRow(page: Page) {
  return page.evaluate(() => {
    const wraps = [...document.querySelectorAll(".bill-swipe-wrap")];
    const inView = wraps.find((w) => {
      const rect = w.getBoundingClientRect();
      return rect.y >= 50 && rect.y < window.innerHeight - 50;
    });
    if (!inView) return null;
    const layer = inView.querySelector(".bill-info-layer") as HTMLElement;
    const delBtn = inView.querySelector(".bill-swipe-action-right") as HTMLElement;
    const editBtn = inView.querySelector(".bill-swipe-action-left") as HTMLElement;
    return {
      layerStyle: layer.getAttribute("style"),
      layerClipPath: getComputedStyle(layer).clipPath,
      clipLeft: layer.style.getPropertyValue("--swipe-clip-left"),
      clipRight: layer.style.getPropertyValue("--swipe-clip-right"),
      delBtnWidth: getComputedStyle(delBtn).width,
      delBtnOpacity: getComputedStyle(delBtn).opacity,
      delBtnAriaHidden: delBtn.getAttribute("aria-hidden"),
      delBtnPointerEvents: getComputedStyle(delBtn).pointerEvents,
      editBtnWidth: getComputedStyle(editBtn).width,
      editBtnOpacity: getComputedStyle(editBtn).opacity,
      editBtnAriaHidden: editBtn.getAttribute("aria-hidden"),
      editBtnPointerEvents: getComputedStyle(editBtn).pointerEvents,
    };
  });
}

test.describe("v0.3.16 #13 swipe state reactivity (真 mouse drag, 不 forceSwipeState)", () => {
  let sessionId: number;

  test.beforeAll(() => {
    sessionId = findThailandSessionId();
  });


  test("左滑 → mid-drag --swipe-clip-right > 0 (reactivity 修复), mouseup snap 到 86px inset", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: "zh-CN",
    });
    const page = await ctx.newPage();
    await loginViaApi(page);
    await page.goto(`${BASE}/sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await expandAllDayGroups(page);

    await page.evaluate(() => {
      const wrap = document.querySelector(".bill-swipe-wrap");
      if (wrap) wrap.scrollIntoView({ block: "center" });
    });
    await page.waitForTimeout(300);

    // 1. before drag: --swipe-clip-* 应该都是 0
    const before = await diagFirstVisibleRow(page);
    expect(before).not.toBeNull();
    expect(parseFloat(before!.clipLeft)).toBe(0);
    expect(parseFloat(before!.clipRight)).toBe(0);

    // 2. 触发 mousedown, 然后 mid-drag 检查 (mouse 还按着不放)
    const start = await getFirstVisibleRowCenter(page);
    expect(start).not.toBeNull();
    await page.mouse.move(start!.x, start!.y);
    await page.mouse.down();
    // 单步 -100px 直接到 -100px (避免中间 frame 复杂)
    await page.mouse.move(start!.x - 100, start!.y, { steps: 8 });
    await page.waitForTimeout(80);

    const mid = await diagFirstVisibleRow(page);
    // v0.3.16 #13: 关键断言 — mid-drag 时 --swipe-clip-right 必须 > 0
    // (修复前永远 = 0, 因为 plain let 没 reactive)
    // eslint-disable-next-line no-console
    const midClipRight = parseFloat(mid!.clipRight);
    expect(midClipRight, "mid-drag --swipe-clip-right 必须 > 0 (reactivity 修复)").toBeGreaterThan(0);
    expect(midClipRight, "mid-drag --swipe-clip-right 必须 <= 1").toBeLessThanOrEqual(1);

    // 3. mouseup, snap 到 -80px (因为 abs(-100) >= 60)
    await page.mouse.up();
    await page.waitForTimeout(500); // 等 snap + clip-path transition

    const after = await diagFirstVisibleRow(page);
    const targetAtCursor = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return {
        tagName: el?.tagName,
        className: el?.className,
        ariaLabel: el?.getAttribute("aria-label"),
        insideBillSwipeWrap: !!el?.closest(".bill-swipe-wrap"),
      };
    }, { x: start!.x - 100, y: start!.y });
    // eslint-disable-next-line no-console
    // eslint-disable-next-line no-console

    // 4. mouseup 后断言
    expect(parseFloat(after!.clipRight)).toBe(1);
    expect(parseFloat(after!.clipLeft)).toBe(0);
    expect(after!.layerClipPath).toContain("86px");

    const m = after!.layerClipPath.match(
      /inset\(\s*([0-9.]+px)\s+([0-9.]+px)\s+([0-9.]+px)\s+([0-9.]+px)\s*\)/,
    );
    expect(m, "clip-path 必须是 inset() 形式").not.toBeNull();
    if (m) {
      const [, top, right, bottom, left] = m;
      expect(top).toBe("0px");
      expect(right).toBe("86px");
      expect(bottom).toBe("0px");
      expect(left).toBe("0px");
    }
    expect(parseFloat(after!.delBtnWidth)).toBeGreaterThanOrEqual(60);
    expect(parseFloat(after!.delBtnOpacity)).toBeGreaterThan(0);

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "v0316-13-swipe-delete.png"),
      fullPage: false,
    });

    await ctx.close();
  });

  test("右滑 → mid-drag --swipe-clip-left > 0, mouseup snap 到 86px inset 左", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: "zh-CN",
    });
    const page = await ctx.newPage();
    await loginViaApi(page);
    await page.goto(`${BASE}/sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await expandAllDayGroups(page);

    await page.evaluate(() => {
      const wrap = document.querySelector(".bill-swipe-wrap");
      if (wrap) wrap.scrollIntoView({ block: "center" });
    });
    await page.waitForTimeout(300);

    const before = await diagFirstVisibleRow(page);
    expect(before).not.toBeNull();
    expect(parseFloat(before!.clipLeft)).toBe(0);
    expect(parseFloat(before!.clipRight)).toBe(0);

    const start = await getFirstVisibleRowCenter(page);
    expect(start).not.toBeNull();
    await page.mouse.move(start!.x, start!.y);
    await page.mouse.down();
    // 4 帧中间状态 (+50px)
    for (let i = 1; i <= 4; i++) {
      await page.mouse.move(start!.x + 100 * (i / 8), start!.y, { steps: 1 });
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(80);

    const mid = await diagFirstVisibleRow(page);
    const midClipLeft = parseFloat(mid!.clipLeft);
    expect(midClipLeft, "mid-drag --swipe-clip-left 必须 > 0 (reactivity 修复)").toBeGreaterThan(0);
    expect(midClipLeft).toBeLessThanOrEqual(1);

    // 继续 drag 到 +100px 后 mouseup
    for (let i = 5; i <= 8; i++) {
      await page.mouse.move(start!.x + 100 * (i / 8), start!.y, { steps: 1 });
      await page.waitForTimeout(20);
    }
    await page.mouse.up();
    await page.waitForTimeout(500);

    const after = await diagFirstVisibleRow(page);

    expect(parseFloat(after!.clipLeft)).toBe(1);
    expect(parseFloat(after!.clipRight)).toBe(0);
    expect(after!.layerClipPath).toContain("86px");
    const m = after!.layerClipPath.match(
      /inset\(\s*([0-9.]+px)\s+([0-9.]+px)\s+([0-9.]+px)\s+([0-9.]+px)\s*\)/,
    );
    expect(m).not.toBeNull();
    if (m) {
      const [, top, right, bottom, left] = m;
      expect(top).toBe("0px");
      expect(right).toBe("0px");
      expect(bottom).toBe("0px");
      expect(left).toBe("86px");
    }
    expect(parseFloat(after!.editBtnWidth)).toBeGreaterThanOrEqual(60);
    expect(parseFloat(after!.editBtnOpacity)).toBeGreaterThan(0);

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "v0316-13-swipe-edit.png"),
      fullPage: false,
    });

    await ctx.close();
  });
});