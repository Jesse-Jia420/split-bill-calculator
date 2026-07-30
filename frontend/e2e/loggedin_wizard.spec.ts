/**
 * TEST-002 — Logged-in wizard creates session (owner_user_id set, owner auto-added)
 *
 * Covers: HIGH risk gap #2 from Coverage-Gaps.md
 *
 * What this verifies
 * ------------------
 * When a logged-in user creates a session via /sessions/new wizard:
 *   - BE POST /sessions sets owner_user_id = user.id (NOT NULL)
 *   - BE auto-creates a SessionMember with role='owner', user_id=user.id,
 *     display_name=user.default_name
 *   - Wizard does NOT call join-claim (logged-in flow skips anon claim)
 *   - Wizard does NOT need localStorage `sbc.actingAs.{sid}` (logged-in
 *     identification is via cookie, not secret)
 *   - session_code is generated and present in detail payload
 *
 * Pre-conditions:
 *   - Frontend running on http://localhost:8448
 *   - Backend running on http://localhost:8449
 *   - User must NOT be in DEV_BYPASS_EMAILS (we need real auth_tokens row
 *     so we can use ensureUserAndToken + loginAs pattern)
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import {
  ensureUserAndToken,
  wipeDb,
  type SeededUser,
} from "./test-helpers";

const TEST_EMAIL = "loggedin.alice@local.test";
const SESSION_NAME = "TEST-002 logged-in wizard";

const SCREENSHOTS_DIR = path.join(process.cwd(), "e2e", "screenshots");
const SCREENSHOT_STEP = (n: number, name: string) =>
  path.join(SCREENSHOTS_DIR, `test-002-${String(n).padStart(2, "0")}-${name}.png`);

async function loginAs(ctx: BrowserContext, user: SeededUser) {
  await ctx.addCookies([
    {
      name: "sbc_session",
      value: user.raw_token,
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

test.beforeEach(() => {
  wipeDb();
});

test("TEST-002: logged-in wizard → owner_user_id set, owner auto-added as member", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const user = ensureUserAndToken(TEST_EMAIL);
  await loginAs(ctx, user);

  const page = await ctx.newPage();

  // Step 1: open wizard
  await page.goto("http://localhost:8448/sessions/new");
  await page.waitForLoadState("networkidle");

  // Should NOT be redirected away (we're logged in, have valid cookie)
  expect(page.url()).toContain("/sessions/new");

  // Step 1: enter session name → next
  await page.locator("#session-name").fill(SESSION_NAME);
  await page.locator('button:has-text("下一步")').click();
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: SCREENSHOT_STEP(1, "step2-nicknames") });

  // Step 2: For logged-in, first input is readonly (owner auto-filled).
  // We need 2 placeholders (to make 3 total: owner + 2 placeholders).
  // Increase count to 3: memberCount starts at 2, click + button once.
  await expect(page.locator("h2")).toHaveText(/一共有多少个昵称/);
  const countDisplay = page.locator(".count-display");
  await expect(countDisplay).toHaveText("2");
  // Click + to increase to 3
  await page.locator('.count-btn[aria-label="增加一人"]').click();
  await expect(countDisplay).toHaveText("3");
  await page.screenshot({ path: SCREENSHOT_STEP(2, "step2-count3") });

  // Now fill the 2 placeholder nicknames (inputs[0] is owner readonly, inputs[1-2] are placeholders)
  const inputs = await page.locator('input[type="text"]').all();
  expect(inputs.length).toBeGreaterThanOrEqual(3);
  // inputs[0] = owner readonly, inputs[1] = first placeholder, inputs[2] = second placeholder
  await inputs[1].fill("Bob");
  await inputs[2].fill("Charlie");
  await page.screenshot({ path: SCREENSHOT_STEP(2, "step2-filled") });
  await page.locator('button:has-text("下一步")').click();

  // Step 3: Currency → confirm
  await page.waitForLoadState("networkidle");
  await expect(page.locator("h2")).toHaveText(/使用什么币种/);
  await page.screenshot({ path: SCREENSHOT_STEP(3, "step3-currency") });
  await page.locator('button:has-text("确认创建")').click();

  // Should navigate to /sessions/{id}
  await page.waitForURL(/\/sessions\/\d+/, { timeout: 10000 });
  const url = page.url();
  const match = url.match(/\/sessions\/(\d+)/);
  expect(match).not.toBeNull();
  const sessionId = Number(match![1]);
  expect(sessionId).toBeGreaterThan(0);

  await page.screenshot({ path: SCREENSHOT_STEP(3, "session-detail") });

  // ── Assertions via API ────────────────────────────────────────────────
  // Use raw cookie for the API call (page.request already has cookies)
  const detailRes = await page.request.get(
    `http://localhost:8448/api/sessions/${sessionId}`
  );
  expect(detailRes.status(), "GET /sessions/{id} should return 200").toBe(200);
  const detail = await detailRes.json();

  // 1. owner_user_id === user.id (NOT null)
  expect(detail.owner_user_id, "owner_user_id should match logged-in user.id")
    .toBe(user.user_id);

  // 2. session_code should be 10 chars
  expect(detail.session_code, "session_code should be present").toMatch(
    /^[A-Z2-9]{10}$/
  );

  // 3. members list should have 3 people: 1 owner + 2 placeholders
  expect(detail.members.length, "should have 3 members (owner + 2 placeholders)")
    .toBe(3);

  // 4. owner should be auto-added with role='owner'
  const owner = detail.members.find((m: any) => m.role === "owner");
  expect(owner, "owner member should exist").toBeTruthy();
  expect(owner.user_id).toBe(user.user_id);
  expect(owner.display_name).toBe("loggedin.alice"); // email local-part
  expect(owner.email).toBe(TEST_EMAIL);

  // 5. The 2 nicknames we provided should be placeholders
  // NOTE: SessionRole enum only has OWNER / MEMBER — placeholders are
  // distinguished by user_id=null (no associated user account yet).
  const placeholders = detail.members.filter(
    (m: any) => m.user_id === null && m.role !== "owner"
  );
  expect(placeholders.length).toBe(2);
  const placeholderNames = placeholders.map((m: any) => m.display_name).sort();
  expect(placeholderNames).toEqual(["Bob", "Charlie"]);
  for (const p of placeholders) {
    expect(p.user_id, "placeholder should have user_id=null").toBeNull();
    expect(p.email, "placeholder should have email=null").toBeNull();
  }

  await page.screenshot({ path: SCREENSHOT_STEP(4, "members-verified") });

  // 6. Wizard should NOT have set localStorage sbc.actingAs.{sid}
  // (logged-in users don't need the anon secret — they're identified via cookie)
  const ls = await page.evaluate(() => {
    return Object.fromEntries(
      Object.entries(localStorage).filter(([k]) => k.startsWith("sbc."))
    );
  });
  expect(
    Object.keys(ls),
    "logged-in wizard should not set sbc.actingAs.* in localStorage"
  ).toHaveLength(0);

  await ctx.close();
});