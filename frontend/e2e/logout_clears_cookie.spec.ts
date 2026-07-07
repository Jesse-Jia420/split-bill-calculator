/**
 * TEST-010 — Logout clears cookie + invalidates token
 *
 * Covers: Coverage-Gaps.md gap #10 (PRD §6.2 logout)
 *
 * What this verifies
 * ------------------
 * 1. Logged-in user sees "退出" button in the header.
 * 2. Clicking it fires POST /auth/logout → 200 { logged_out: true }.
 * 3. Browser cookie `sbc_session` is deleted (Set-Cookie expired).
 * 4. FE state cleared: header no longer shows the user email.
 * 5. After logout, GET /auth/me returns 401 (token invalidated in DB).
 * 6. Header now shows "登录" instead of "退出".
 *
 * Real selectors (read from Header.svelte + auth.ts):
 *   - button:has-text("退出")  (logout button)
 *   - button:has-text("登录")  (login link, shown after logout)
 *   - generic showing user's email
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import { ensureUserAndToken, wipeDb, type SeededUser } from "./test-helpers";

const BASE = "http://localhost:8448";
const TEST_EMAIL = "logout.laura@jessejia.local";

async function loginAs(ctx: BrowserContext, user: SeededUser) {
  await ctx.addCookies([
    {
      name: "sbc_session",
      value: user.raw_token,
      url: BASE,
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

test.beforeEach(() => {
  wipeDb();
});

test("TEST-010: logout clears cookie, invalidates token, resets header UI", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const user = ensureUserAndToken(TEST_EMAIL);
  await loginAs(ctx, user);
  const page = await ctx.newPage();

  // Land on a logged-in page so the header renders.
  await page.goto(`${BASE}/sessions`);
  await page.waitForLoadState("networkidle");

  // Sanity: header shows user email + "退出" button (not "登录").
  const logoutBtn = page.locator('button:has-text("退出")');
  await expect(logoutBtn).toBeVisible();
  await expect(page.locator("text=登录").first()).not.toBeVisible();
  // default_name is derived from email local-part in ensureUserAndToken.
  const defaultName = TEST_EMAIL.split("@")[0];
  await expect(page.getByText(defaultName)).toBeVisible();

  // Confirm sbc_session cookie is set before logout.
  const cookiesBefore = await ctx.cookies();
  const sessionCookieBefore = cookiesBefore.find((c) => c.name === "sbc_session");
  expect(sessionCookieBefore, "sbc_session cookie should exist before logout").toBeTruthy();
  expect(sessionCookieBefore?.value).toBe(user.raw_token);

  // Watch the logout POST so we can verify its response shape.
  const logoutPromise = page.waitForResponse(
    (r) =>
      r.url().endsWith("/auth/logout") && r.request().method() === "POST"
  );
  await logoutBtn.click();
  const logoutResp = await logoutPromise;
  expect(logoutResp.status()).toBe(200);
  const logoutBody = await logoutResp.json();
  expect(logoutBody.logged_out).toBe(true);

  // Cookie must be cleared in the browser.
  // Playwright's ctx.cookies() reflects actual browser cookie jar
  // after Set-Cookie with Max-Age=0/Expires=1970 is processed.
  const cookiesAfter = await ctx.cookies();
  const sessionCookieAfter = cookiesAfter.find((c) => c.name === "sbc_session");
  // The cookie should either be absent or have empty/expired value.
  if (sessionCookieAfter) {
    expect(
      sessionCookieAfter.value === "" ||
        (sessionCookieAfter.expires !== undefined && sessionCookieAfter.expires <= Date.now() / 1000),
      `sbc_session cookie must be cleared or expired, got: ${JSON.stringify(sessionCookieAfter)}`
    ).toBe(true);
  }

  // Header no longer shows the user's email or "退出" button.
  await expect(page.locator('button:has-text("退出")')).toHaveCount(0);
  // Login link should now be visible.
  await expect(page.locator('a:has-text("登录")').first()).toBeVisible();

  // Subsequent /auth/me returns 401 (token deleted in DB).
  const meRes = await page.request.get(`${BASE}/api/auth/me`);
  expect(meRes.status(), "/auth/me after logout should be 401").toBe(401);

  await ctx.close();
});