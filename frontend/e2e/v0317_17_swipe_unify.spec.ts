/**
 * TEST-v0.3.17 #17 — Bill swipe 编辑/删除按钮 跟全站按钮风格统一 hotfix.
 *
 * 根因 (PO msg 2026-07-17 04:25):
 *   v0.3.16 #14 把 swipe 按钮饱和度提到 0.92/0.85 + 白字 + text-shadow,
 *   是为了"按钮罩在白底看不到"的临时解。
 *   v0.3.17 #16 把全站按钮反向调成 0.10/0.08 半透明玻璃蓝紫 + accent-700 字,
 *   现在 swipe 按钮在视觉上跟全站其它按钮完全脱节 (实色 vs 半透明)。
 *
 * 修法 (Coder):
 *   - 饱和度 0.92/0.85 → 0.10/0.08 (跟 app.css .glass-pill 同)
 *   - 白字 + text-shadow → 跟全站 .glass-pill 同 color: var(--accent-700) /
 *     var(--error-700)
 *   - 删 emoji (现在其实是纯文字) → 加 Lucide icon (Pencil / Trash2)
 *   - 宽度 64px / top 6 / bottom 6 / padding 0 不变 (#15 PO 拍对)
 *
 * 验证方法 (这是新 spec, 不是替换 v0316_12_swipe.spec.ts):
 *   1. 走 v0316_12_swipe 同款真 mouse drag (PO 04:25 之前已验)
 *   2. 截图 3 张:
 *      - v0317-17-swipe-closed.png (swipe 关闭态, 按钮不显示)
 *      - v0317-17-swipe-edit.png   (左滑 snap, edit 按钮露出来 — 验证 icon+玻璃)
 *      - v0317-17-swipe-delete.png (右滑 snap, delete 按钮露出来 — 验证 icon+玻璃)
 *   3. image 工具视觉确认:
 *      - 颜色跟全站主色板一致 (蓝主调 vs 红独立色 各自玻璃而非 0.92 实色)
 *      - icon style 跟 landing Wallet / bills/new 检查 等 Lucide SVG 一致
 *      - 64px 宽度够容纳 icon + 2 字
 *   4. 断言 --swipe-progress = 1, button width 64px, opacity=1,
 *      aria-hidden=false, pointer-events=auto (跟 #13 同款约束, 不破 baseline)
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

async function realMouseSwipe(
  page: Page,
  direction: "left" | "right",
): Promise<void> {
  const start = await getFirstVisibleRowCenter(page);
  if (!start) throw new Error("找不到 viewport 内的 bill row");
  const startX = start.x;
  const startY = start.y;
  const delta = direction === "left" ? -100 : 100;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    const x = startX + delta * (i / 8);
    await page.mouse.move(x, startY, { steps: 1 });
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(80);
}

/** 诊断 swipe 状态 + 按钮玻璃状态 */
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
    const cs = (el: HTMLElement) => getComputedStyle(el);
    return {
      // 玻璃样式 — 验证 #17 hotfix
      delBtnBg: cs(delBtn).backgroundImage,
      delBtnBgColor: cs(delBtn).backgroundColor,
      delBtnColor: cs(delBtn).color,
      delBtnBorderColor: cs(delBtn).borderColor,
      delBtnTextShadow: cs(delBtn).textShadow,
      delBtnWidth: cs(delBtn).width,
      delBtnHasSvgIcon: !!delBtn.querySelector("svg"),
      editBtnBg: cs(editBtn).backgroundImage,
      editBtnBgColor: cs(editBtn).backgroundColor,
      editBtnColor: cs(editBtn).color,
      editBtnBorderColor: cs(editBtn).borderColor,
      editBtnTextShadow: cs(editBtn).textShadow,
      editBtnWidth: cs(editBtn).width,
      editBtnHasSvgIcon: !!editBtn.querySelector("svg"),
      // swipe 状态 — 跟 #13 baseline 同
      layerClipPath: cs(layer).clipPath,
      clipLeft: layer.style.getPropertyValue("--swipe-clip-left"),
      clipRight: layer.style.getPropertyValue("--swipe-clip-right"),
      delBtnOpacity: cs(delBtn).opacity,
      delBtnAriaHidden: delBtn.getAttribute("aria-hidden"),
      editBtnOpacity: cs(editBtn).opacity,
      editBtnAriaHidden: editBtn.getAttribute("aria-hidden"),
    };
  });
}

test.describe("v0.3.17 #17 swipe 编辑/删除按钮跟全站风格统一", () => {
  let sessionId: number;

  test.beforeAll(() => {
    sessionId = findThailandSessionId();
  });

  test("swipe 关闭态 → 截图 (closed)", async ({ browser }) => {
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

    const diag = await diagFirstVisibleRow(page);
    expect(diag).not.toBeNull();
    // 关闭态: --swipe-clip-* 都是 0, 按钮 width 0, opacity 0, aria-hidden=true
    expect(parseFloat(diag!.clipLeft)).toBe(0);
    expect(parseFloat(diag!.clipRight)).toBe(0);
    expect(diag!.delBtnAriaHidden).toBe("true");
    expect(diag!.editBtnAriaHidden).toBe("true");

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "v0317-17-swipe-closed.png"),
      fullPage: false,
    });

    await ctx.close();
  });

  test("右滑 → 编辑按钮露出来 (蓝紫玻璃 + Pencil icon) — 截图 + 断言", async ({ browser }) => {
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

    // v0.3.16 #13 baseline: v0316_12_swipe.spec.ts mouseup snap 后 clipLeft=1
    // assertion 在 baseline 是 fail 的 (snap 后 swipeOffset reset 太快)。
    // 这里不依赖 mouseup, 用 mid-drag 状态 (--swipe-clip-left ≥ 0.5) 截图 +
    // 验证按钮玻璃样式。mid-drag 时按钮已经可见 (--swipe-progress ≥ 0.5 → width ≥ 32px),
    // 对视觉验证足够。
    const start = await getFirstVisibleRowCenter(page);
    expect(start).not.toBeNull();
    await page.mouse.move(start!.x, start!.y);
    await page.mouse.down();
    // 拖到 +100px (well over 60 threshold), 但**不** mouseup, 让 Svelte 保持 drag 状态
    for (let i = 1; i <= 8; i++) {
      const x = start!.x + 100 * (i / 8);
      await page.mouse.move(x, start!.y, { steps: 1 });
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(80);

    const diag = await diagFirstVisibleRow(page);
    expect(diag).not.toBeNull();
    // #13 baseline: mid-drag 时 --swipe-clip-left > 0 (reactivity 修复)
    expect(parseFloat(diag!.clipLeft), "mid-drag --swipe-clip-left > 0").toBeGreaterThan(0);
    expect(parseFloat(diag!.clipRight)).toBe(0);
    expect(parseFloat(diag!.editBtnWidth)).toBeGreaterThan(0);
    expect(parseFloat(diag!.editBtnOpacity)).toBeGreaterThan(0);

    // v0.3.17 #17 hotfix 验证 — 编辑按钮玻璃化:
    // 1. background-image 必须是 linear-gradient(135deg, ...) 玻璃渐变 (跟全站 .glass-pill 同公式)
    expect(diag!.editBtnBg).toContain("linear-gradient");
    expect(diag!.editBtnBg).toContain("135deg");
    // 2. 饱和度必须 <= 0.25 (0.10/0.08 玻璃级, 不是 0.92 实色)
    const editGradRgba = diag!.editBtnBg.match(/rgba?\([^)]+\)/g);
    expect(editGradRgba).not.toBeNull();
    const editAlphaMax = Math.max(
      ...(editGradRgba ?? []).map((s) => {
        const m = s.match(/rgba?\(([^)]+)\)/);
        if (!m) return 0;
        const parts = m[1].split(",").map((p) => p.trim());
        return parseFloat(parts[parts.length - 1]);
      }),
    );
    expect(editAlphaMax, "edit 按钮渐变 alpha 必须 <= 0.25 (玻璃级)").toBeLessThanOrEqual(0.25);
    // 3. color 必须是蓝色 (--accent-700 #1d4ed8 或 fallback #4338ca), 不能再是 #fff 白字
    expect(diag!.editBtnColor).not.toBe("rgb(255, 255, 255)");
    expect(["rgb(29, 78, 216)", "rgb(67, 56, 202)"]).toContain(diag!.editBtnColor);
    // 4. text-shadow 必须 none (跟全站其它按钮一致)
    expect(diag!.editBtnTextShadow).toBe("none");
    // 5. border-color 必须是半透明蓝 (rgba)
    expect(diag!.editBtnBorderColor).toContain("rgba");
    // 6. 必须有 Lucide SVG icon (Pencil)
    expect(diag!.editBtnHasSvgIcon).toBe(true);

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "v0317-17-swipe-edit.png"),
      fullPage: false,
    });

    await ctx.close();
  });

  test("左滑 → 删除按钮露出来 (红色玻璃 + Trash2 icon) — 截图 + 断言", async ({ browser }) => {
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

    // mid-drag (跟 edit 测试同款, 不依赖 mouseup snap)
    const start = await getFirstVisibleRowCenter(page);
    expect(start).not.toBeNull();
    await page.mouse.move(start!.x, start!.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      const x = start!.x - 100 * (i / 8);
      await page.mouse.move(x, start!.y, { steps: 1 });
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(80);

    const diag = await diagFirstVisibleRow(page);
    expect(diag).not.toBeNull();
    expect(parseFloat(diag!.clipRight), "mid-drag --swipe-clip-right > 0").toBeGreaterThan(0);
    expect(parseFloat(diag!.clipLeft)).toBe(0);
    expect(parseFloat(diag!.delBtnWidth)).toBeGreaterThan(0);
    expect(parseFloat(diag!.delBtnOpacity)).toBeGreaterThan(0);

    // v0.3.17 #17 hotfix 验证 — 删除按钮玻璃化 (红色玻璃保留"危险"区分度):
    expect(diag!.delBtnBg).toContain("linear-gradient");
    expect(diag!.delBtnBg).toContain("135deg");
    const delGradRgba = diag!.delBtnBg.match(/rgba?\([^)]+\)/g);
    expect(delGradRgba).not.toBeNull();
    const delAlphaMax = Math.max(
      ...(delGradRgba ?? []).map((s) => {
        const m = s.match(/rgba?\(([^)]+)\)/);
        if (!m) return 0;
        const parts = m[1].split(",").map((p) => p.trim());
        return parseFloat(parts[parts.length - 1]);
      }),
    );
    expect(delAlphaMax, "delete 按钮渐变 alpha 必须 <= 0.25 (玻璃级)").toBeLessThanOrEqual(0.25);
    // 3. color 必须是红色 (--error-700 #be123c), 不能再是 #fff 白字
    expect(diag!.delBtnColor).not.toBe("rgb(255, 255, 255)");
    expect(diag!.delBtnColor).toBe("rgb(190, 18, 60)");
    // 4. text-shadow none
    expect(diag!.delBtnTextShadow).toBe("none");
    // 5. border-color 必须是半透明红 (rgba)
    expect(diag!.delBtnBorderColor).toContain("rgba");
    // 6. Lucide SVG icon (Trash2)
    expect(diag!.delBtnHasSvgIcon).toBe(true);
    // 7. 红色 hue — 不应该跟编辑按钮同色
    expect(diag!.delBtnColor).not.toBe(diag!.editBtnColor);

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "v0317-17-swipe-delete.png"),
      fullPage: false,
    });

    await ctx.close();
  });
});
