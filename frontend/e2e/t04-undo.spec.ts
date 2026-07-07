/**
 * T04 end-to-end test: delete bill → click 撤销 → bill restored.
 *
 * What this verifies
 * ------------------
 * v0.2.1 Sprint 2 fix of the T04 delete-undo 5s toast. The bug was that
 * the undo button's onclick routed through a `window.__sbcBillUndo_<id>`
 * global handler set by `attachUndo` AFTER `await deleteBill`. On
 * Svelte 5 + Vite HMR + a fast localhost, the undo button rendered
 * before the handler was wired, so clicks silently failed.
 *
 * Fix: 撤销 button onclick → undoDelete(entry.id) directly (no global).
 *
 * This test (v0.2.1 Sprint 2):
 *  1. Logs in as xinhua1001 (dev seed owner of session 1).
 *  2. Creates a uniquely-named bill via the UI's POST /bills.
 *  3. Touch-swipes the bill row to expose the 删除 action button.
 *  4. Taps 删除 — verifies DELETE /bills/{id} returns 204.
 *  5. Verifies the undo banner appears with a 撤销 button.
 *  6. Clicks 撤销 — verifies POST /bills succeeds (201) and bill is back.
 *
 * Screenshots are written to `frontend/e2e/screenshots/` for the Markdown
 * report. The test uses `ensureUserAndToken` from test-helpers to bypass
 * the email verification flow (same pattern as full_flow.spec.ts).
 *
 * Prerequisite: `scripts/seed_dev_data.py` must have been run so session 1
 * "泰国测试账单 6.19-6.22" exists with xinhua1001@outlook.com as owner.
 */
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import {
  ensureUserAndToken,
  SCREENSHOTS_DIR,
} from "./test-helpers";

const OWNER = "xinhua1001@outlook.com";
const BASE = "http://localhost:8448";
const SESSION_NAME = "T04-undo self-contained";
const SHOT = (n: number, name: string) =>
  path.join(SCREENSHOTS_DIR, `t04-${String(n).padStart(2, "0")}-${name}.png`);

async function loginAs(ctx: BrowserContext, token: string) {
  await ctx.addCookies([
    {
      name: "sbc_session",
      value: token,
      url: "http://localhost:8448",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

test.beforeAll(() => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
});

// v0.3.1 (TEST-009 fix): the original T04 spec depended on a hardcoded
// session id=1 from seed_dev_data.py, which other tests' beforeEach
// wipeDb() destroys → POST /api/sessions/1/bills → 403 (not a member).
//
// Rewrite: this test now creates its own session + bill via API, then
// uses the returned ids for the swipe-delete + undo flow. wipeDb() at
// the top of beforeEach still runs (it's the default fixture), so the
// session we create here is the only session in the DB.

test("T04 fix: swipe-delete bill → click 撤销 → bill restored", async ({
  browser,
}) => {
  // iPhone device emulation so touchstart/touchmove listeners on .bill-row fire.
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    locale: "zh-CN",
  });
  const page = await ctx.newPage();

  // 1) Login as owner.
  const user = ensureUserAndToken(OWNER);
  await loginAs(ctx, user.raw_token);

  // Navigate to base URL so subsequent fetch() calls have an origin.
  await page.goto("http://localhost:8448/");
  await page.waitForLoadState("networkidle");

  // 2) Create our own session + bill via API. No dependency on seed.
  const createSessionRes = await page.request.post(`${BASE}/api/sessions`, {
    data: {
      name: SESSION_NAME,
      currencies: ["CNY"],
      primary_currency: "CNY",
      member_nicknames: [],
    },
  });
  expect(createSessionRes.status(), "create session should be 201").toBe(201);
  const createSummary = await createSessionRes.json();
  const sid = createSummary.id;
  expect(sid).toBeGreaterThan(0);
  // POST returns summary only; GET returns full SessionDetail with members.
  const detailRes = await page.request.get(`${BASE}/api/sessions/${sid}`);
  expect(detailRes.status()).toBe(200);
  const detail = await detailRes.json();
  const ownerMemberId = detail.members[0].id;
  expect(ownerMemberId).toBeGreaterThan(0);

  const uniqueDesc = `t04-fix-${Date.now()}`;
  const created = await page.evaluate(async ({ sid, ownerMemberId, desc }) => {
    const res = await fetch(`/api/sessions/${sid}/bills`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: 42.42,
        payer_member_id: ownerMemberId,
        description: desc,
        occurred_at: "2026-07-03T23:30:00+00:00",
        currency: "CNY",
        participants: [{ member_id: ownerMemberId, is_exclusive: false, exclusive_amount: 0 }],
      }),
    });
    return { status: res.status, body: await res.json() };
  }, { sid, ownerMemberId, desc: uniqueDesc });
  expect(created.status).toBe(201);
  const billId = created.body.id;

  // 3) Reload to see the bill in the UI.
  await page.goto(`http://localhost:8448/sessions/${sid}`, {
    waitUntil: "networkidle",
  });
  await page.waitForTimeout(1500);

  // Verify the bill is visible.
  const visible = await page
    .locator(`.bill-desc:has-text("${uniqueDesc}")`)
    .count();
  expect(visible).toBeGreaterThan(0);

  await page.screenshot({ path: SHOT(1, "bill-visible") });

  // 4) Swipe left on the bill row to expose the 删除 action button.
  const billRow = page
    .locator(".bill-row")
    .filter({ hasText: uniqueDesc })
    .first();
  await billRow.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const box = await billRow.boundingBox();
  if (!box) throw new Error("could not find bill row bounding box");

  const startX = box.x + box.width - 20;
  const endX = box.x + 20;
  const y = box.y + box.height / 2;

  // Dispatch TouchEvents directly via JS — the Svelte on:touchstart
  // listener needs proper TouchEvent objects with Touch[]. We also dispatch
  // touchmove on the bill-row directly since that's where the listener is.
  await page.evaluate(async ({ startX, endX, y, billDesc }) => {
    const billRows = document.querySelectorAll(".bill-row");
    let target = null;
    for (const r of billRows) {
      if (r.textContent && r.textContent.includes(billDesc)) {
        target = r;
        break;
      }
    }
    if (!target) throw new Error("bill-row not found");
    function makeTouch(id, x, y) {
      return new Touch({
        identifier: id,
        target,
        clientX: x,
        clientY: y,
        pageX: x,
        pageY: y,
        screenX: x,
        screenY: y,
        radiusX: 5,
        radiusY: 5,
      });
    }
    function makeEv(type, touches, changedTouches) {
      return new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches,
        targetTouches: touches,
        changedTouches,
      });
    }
    const startT = makeTouch(1, startX, y);
    target.dispatchEvent(makeEv("touchstart", [startT], [startT]));
    const steps = 25;
    for (let i = 1; i <= steps; i++) {
      const x = startX + ((endX - startX) * i) / steps;
      const t = makeTouch(1, x, y);
      target.dispatchEvent(makeEv("touchmove", [t], [t]));
      await new Promise((r) => setTimeout(r, 12));
    }
    const endT = makeTouch(1, endX, y);
    target.dispatchEvent(makeEv("touchend", [], [endT]));
    await new Promise((r) => setTimeout(r, 300));
  }, { startX, endX, y, billDesc: uniqueDesc });
  await page.waitForTimeout(300);

  await page.screenshot({ path: SHOT(2, "after-swipe") });

  // 5) Verify the 删除 action button is now visible (aria-hidden=false).
  //    The action button is a sibling of .bill-row, inside .bill-swipe-wrap.
  const deleteBtn = billRow
    .locator("xpath=..")
    .locator(".bill-swipe-action")
    .first();
  const ariaHidden = await deleteBtn.getAttribute("aria-hidden");
  expect(ariaHidden).toBe("false");

  // 6) Click 删除 → DELETE /bills/{id} should fire and return 204.
  //    Use JS click() since the button may have transition animation
  //    (opacity:0 → 1 over 200ms) that makes Playwright's .tap() fail
  //    visibility checks. JS click bypasses Playwright's actionability checks.
  const deleteRespPromise = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/sessions/${sid}/bills/${billId}`) &&
      r.request().method() === "DELETE",
  );
  await deleteBtn.evaluate((el) => (el as HTMLButtonElement).click());
  const deleteResp = await deleteRespPromise;
  expect(deleteResp.status()).toBe(204);
  await page.waitForTimeout(2000);

  await page.screenshot({ path: SHOT(3, "after-delete") });

  // 7) Verify undo banner is visible with 撤销 button.
  const undoBtn = page.locator(".undo-btn").first();
  await expect(undoBtn).toBeVisible();
  // After DELETE returns (very fast on localhost), the button text should
  // already be "撤销" — not the deleting/restoring state.
  await expect(undoBtn).toHaveText(/^撤销$/);

  // 8) Click 撤销 — THE CRITICAL FIX TEST.
  //     Expected: POST /api/sessions/1/bills returns 201 AND the bill is
  //     re-listed.
  const postRespPromise = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/sessions/${sid}/bills`) &&
      r.request().method() === "POST",
  );
  await undoBtn.evaluate((el) => (el as HTMLButtonElement).click());
  const postResp = await postRespPromise;
  expect(postResp.status()).toBe(201);
  await page.waitForTimeout(1500);

  await page.screenshot({ path: SHOT(4, "after-undo") });

  // 9) Verify the bill is back in the API listing.
  const restoredCount = await page.evaluate(async ({ sid, desc }) => {
    const res = await fetch(`/api/sessions/${sid}/bills`, {
      credentials: "include",
    });
    const bills = (await res.json()) as Array<{ description: string }>;
    return bills.filter((b) => b.description === desc).length;
  }, { sid, desc: uniqueDesc });
  expect(restoredCount).toBeGreaterThan(0);

  // 10) Verify the undo banner is dismissed (bill-restore path filters it out).
  await expect(page.locator(".undo-stack")).toHaveCount(0);

  await ctx.close();
});