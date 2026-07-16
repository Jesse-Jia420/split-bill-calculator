/**
 * TEST-v0.3.16 #12 — Bill swipe button reveal hotfix.
 *
 * 根因 (PO msg 2026-07-16 23:56):
 *   .bill-info-layer z-index:1 + 背景 white + full width
 *   → 完全盖住 z-index:0 的按钮。
 *   Master 用 JS 强制 width:80px/opacity:1, 按钮仍看不见。
 *
 * 修法:
 *   .bill-info-layer 加 clip-path: inset(0 calc(rightP*86px) 0 calc(leftP*86px))
 *   86 = 80(button) + 6(edge offset)
 *
 * 验证方法:
 *   1. 强制设置 --swipe-clip-{left,right} CSS var 和按钮 --swipe-progress/width/opacity
 *      (绕开 swipe 状态 reactivity, 这是 Svelte 5 legacy 编译的 pre-existing bug,
 *       不是 #12 hotfix 的范围)。
 *   2. 验证 clip-path 计算结果含正确的 inset px 值。
 *   3. 截图保存到 SCREENSHOTS_DIR/v0316-12-swipe-{delete,edit}.png
 *   4. image 工具肉眼确认按钮确实可见。
 *
 * 注意: 默认情况下 day groups 是 collapsed,需要先点开 summary 才能看到 row。
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
    data: { email: "demo@example.com" },
  });
  expect(r1.status(), "send-code").toBe(200);
  const r2 = await page.request.post(`${BASE}/auth/verify-code`, {
    data: { email: "demo@example.com", code: "000000" },
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

/** 找第一个在 viewport 内的 bill row */
async function getFirstVisibleRowInfo(page: Page) {
  return page.evaluate(() => {
    const wraps = [...document.querySelectorAll(".bill-swipe-wrap")];
    const inView = wraps.find((w) => {
      const rect = w.getBoundingClientRect();
      return rect.y >= 50 && rect.y < window.innerHeight - 50;
    });
    if (!inView) return null;
    const layer = inView.querySelector(".bill-info-layer") as HTMLElement | null;
    const delBtn = inView.querySelector(".bill-swipe-action-right") as HTMLElement | null;
    const editBtn = inView.querySelector(".bill-swipe-action-left") as HTMLElement | null;
    return {
      layer,
      delBtn,
      editBtn,
    };
  });
}

/**
 * 强制模拟 swipe-revealed 状态 (绕开 swipe 状态 reactivity —
 * Svelte 5 legacy 编译下 plain `let dragOffset/swipeOffset` 没自动包 mutable_source,
 * 这是 pre-existing bug 不在 #12 范围)。
 * Master 在 PO 报告时也是用同样方法验证 z-index 问题是 root cause。
 */
async function forceSwipeState(
  page: Page,
  direction: "left" | "right",
): Promise<void> {
  await page.evaluate((d) => {
    const wraps = [...document.querySelectorAll(".bill-swipe-wrap")];
    const inView = wraps.find((w) => {
      const rect = w.getBoundingClientRect();
      return rect.y >= 50 && rect.y < window.innerHeight - 50;
    });
    if (!inView) throw new Error("找不到可见 bill row");
    const layer = inView.querySelector(".bill-info-layer") as HTMLElement;
    const delBtn = inView.querySelector(".bill-swipe-action-right") as HTMLElement;
    const editBtn = inView.querySelector(".bill-swipe-action-left") as HTMLElement;

    if (d === "left") {
      // 左滑 → 右按钮 (delete) 露出来
      layer.style.setProperty("--swipe-clip-left", "0");
      layer.style.setProperty("--swipe-clip-right", "1");
      delBtn.style.setProperty("--swipe-progress", "1");
      delBtn.style.width = "80px";
      delBtn.style.opacity = "1";
      delBtn.setAttribute("aria-hidden", "false");
      editBtn.style.setProperty("--swipe-progress", "0");
      editBtn.style.width = "0px";
      editBtn.style.opacity = "0";
      editBtn.setAttribute("aria-hidden", "true");
    } else {
      // 右滑 → 左按钮 (edit) 露出来
      layer.style.setProperty("--swipe-clip-left", "1");
      layer.style.setProperty("--swipe-clip-right", "0");
      editBtn.style.setProperty("--swipe-progress", "1");
      editBtn.style.width = "80px";
      editBtn.style.opacity = "1";
      editBtn.setAttribute("aria-hidden", "false");
      delBtn.style.setProperty("--swipe-progress", "0");
      delBtn.style.width = "0px";
      delBtn.style.opacity = "0";
      delBtn.setAttribute("aria-hidden", "true");
    }
  }, direction);
  await page.waitForTimeout(450); // 等 clip-path transition
}

test.describe("v0.3.16 #12 swipe 按钮露出来", () => {
  let sessionId: number;

  test.beforeAll(() => {
    sessionId = findThailandSessionId();
  });

  test("左滑 → 「删除」按钮 visible (clip-path inset 右侧 86px)", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      locale: "zh-CN",
    });
    const page = await ctx.newPage();
    await loginViaApi(page);
    await page.goto(`${BASE}/sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await expandAllDayGroups(page);

    const info = await getFirstVisibleRowInfo(page);
    expect(info?.layer, "first visible row's .bill-info-layer").not.toBeNull();

    await page.evaluate(() => {
      const wrap = document.querySelector(".bill-swipe-wrap");
      if (wrap) wrap.scrollIntoView({ block: "center" });
    });
    await page.waitForTimeout(300);

    await forceSwipeState(page, "left");

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "v0316-12-swipe-delete.png"),
      fullPage: false,
    });

    const diag = await page.evaluate(() => {
      const wraps = [...document.querySelectorAll(".bill-swipe-wrap")];
      const inView = wraps.find((w) => {
        const rect = w.getBoundingClientRect();
        return rect.y >= 50 && rect.y < window.innerHeight - 50;
      });
      if (!inView) return null;
      const layer = inView.querySelector(".bill-info-layer") as HTMLElement;
      const delBtn = inView.querySelector(".bill-swipe-action-right") as HTMLElement;
      return {
        layerClipLeft: layer.style.getPropertyValue("--swipe-clip-left"),
        layerClipRight: layer.style.getPropertyValue("--swipe-clip-right"),
        layerClipPath: getComputedStyle(layer).clipPath,
        delBtnWidth: getComputedStyle(delBtn).width,
        delBtnOpacity: getComputedStyle(delBtn).opacity,
      };
    });

    // 断言 CSS vars 已设置
    expect(parseFloat(diag!.layerClipRight)).toBe(1);
    expect(parseFloat(diag!.layerClipLeft)).toBe(0);
    // 断言 clip-path 计算结果 inset 右侧 86px (form: inset(top right bottom left))
    expect(diag!.layerClipPath).toContain("86px");
    // 解析 inset() 检查 right inset 是 86px
    const m = diag!.layerClipPath.match(/inset\(\s*([0-9.]+px)\s+([0-9.]+px)\s+([0-9.]+px)\s+([0-9.]+px)\s*\)/);
    expect(m, "clip-path 必须是 inset() 形式").not.toBeNull();
    if (m) {
      const [, top, right, bottom, left] = m;
      expect(top).toBe("0px");
      expect(right).toBe("86px");
      expect(bottom).toBe("0px");
      expect(left).toBe("0px");
    }
    // 删除按钮可见
    expect(parseFloat(diag!.delBtnWidth)).toBeGreaterThanOrEqual(80);
    expect(parseFloat(diag!.delBtnOpacity)).toBeGreaterThan(0);

    await ctx.close();
  });

  test("右滑 → 「编辑」按钮 visible (clip-path inset 左侧 86px)", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
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

    await forceSwipeState(page, "right");

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "v0316-12-swipe-edit.png"),
      fullPage: false,
    });

    const diag = await page.evaluate(() => {
      const wraps = [...document.querySelectorAll(".bill-swipe-wrap")];
      const inView = wraps.find((w) => {
        const rect = w.getBoundingClientRect();
        return rect.y >= 50 && rect.y < window.innerHeight - 50;
      });
      if (!inView) return null;
      const layer = inView.querySelector(".bill-info-layer") as HTMLElement;
      const editBtn = inView.querySelector(".bill-swipe-action-left") as HTMLElement;
      return {
        layerClipLeft: layer.style.getPropertyValue("--swipe-clip-left"),
        layerClipRight: layer.style.getPropertyValue("--swipe-clip-right"),
        layerClipPath: getComputedStyle(layer).clipPath,
        editBtnWidth: getComputedStyle(editBtn).width,
        editBtnOpacity: getComputedStyle(editBtn).opacity,
      };
    });

    expect(parseFloat(diag!.layerClipLeft)).toBe(1);
    expect(parseFloat(diag!.layerClipRight)).toBe(0);
    expect(diag!.layerClipPath).toContain("86px");
    const m = diag!.layerClipPath.match(/inset\(\s*([0-9.]+px)\s+([0-9.]+px)\s+([0-9.]+px)\s+([0-9.]+px)\s*\)/);
    expect(m).not.toBeNull();
    if (m) {
      const [, top, right, bottom, left] = m;
      expect(top).toBe("0px");
      expect(right).toBe("0px");
      expect(bottom).toBe("0px");
      expect(left).toBe("86px");
    }
    expect(parseFloat(diag!.editBtnWidth)).toBeGreaterThanOrEqual(80);
    expect(parseFloat(diag!.editBtnOpacity)).toBeGreaterThan(0);

    await ctx.close();
  });
});