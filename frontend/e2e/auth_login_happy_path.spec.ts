/**
 * TEST-001 — Login happy path (dev bypass)
 *
 * Covers: HIGH risk gap #1 from Coverage-Gaps.md
 *
 * What this verifies
 * ------------------
 * Full login flow: /auth/login → send-code → verify-code → redirected to
 * /sessions with sbc_session cookie set.
 *
 * Uses DEV_BYPASS_EMAILS: demo@example.com accepts any 6-digit code
 * without SMTP roundtrip. No DB seeding needed.
 *
 * Pre-conditions:
 *   - Frontend running on http://localhost:8448
 *   - demo@example.com in DEV_BYPASS_EMAILS (already set in .env)
 *   - Backend running on http://localhost:8449
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const SCREENSHOTS_DIR = path.join(process.cwd(), "e2e", "screenshots");

const SCREENSHOT_STEP = (n: number, name: string) =>
  path.join(SCREENSHOTS_DIR, `test-001-${String(n).padStart(2, "0")}-${name}.png`);

const TEST_EMAIL = "demo@example.com";
const TEST_CODE = "123456";

test.beforeAll(() => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
});

test("TEST-001: login happy path — send → verify → /sessions", async ({
  browser,
}) => {
  const ctx: BrowserContext = await browser.newContext({
    // Accept self-signed cert on localhost
    ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();

  // ── Step 1: Land on login page ────────────────────────────────────────
  await page.goto("http://localhost:8448/auth/login");
  await page.waitForLoadState("networkidle");

  // Should see the login heading + email input
  await expect(page.locator("h2")).toContainText("登录");
  await expect(page.locator("#email")).toBeVisible();
  await expect(page.locator("#email")).toHaveAttribute("type", "email");

  await page.screenshot({ path: SCREENSHOT_STEP(1, "login-page") });

  // ── Step 2: Fill email → send code ─────────────────────────────────────
  await page.locator("#email").fill(TEST_EMAIL);
  await page.locator('button:has-text("发送验证码")').click();

  // After send, step should transition to verify (hint message visible)
  await expect(page.locator(".success")).toContainText("验证码已发送", {
    timeout: 5000,
  });

  // Code input should now be visible
  await expect(page.locator("#code")).toBeVisible();
  await page.screenshot({ path: SCREENSHOT_STEP(2, "code-sent") });

  // ── Step 3: Fill code → verify ──────────────────────────────────────────
  await page.locator("#code").fill(TEST_CODE);
  await page.locator('button:has-text("验证并登录")').click();

  // Should navigate to /sessions (or returnTo if set)
  await page.waitForURL(/\/sessions/, { timeout: 10000 });

  // The page should render without error — at minimum the sessions heading
  await expect(page.locator("h2, h1").first()).toBeVisible();
  await page.screenshot({ path: SCREENSHOT_STEP(3, "sessions-page") });

  // ── Step 4: Cookie should be set ────────────────────────────────────────
  const cookies = await ctx.cookies();
  const sbcCookie = cookies.find((c) => c.name === "sbc_session");
  expect(sbcCookie, "sbc_session cookie should be set").toBeTruthy();
  expect(sbcCookie!.value.length, "token should be non-empty").toBeGreaterThan(10);

  // ── Step 5: /auth/me should confirm correct user ────────────────────────
  const meRes = await page.request.get("http://localhost:8448/api/auth/me", {
    headers: { Cookie: `sbc_session=${sbcCookie!.value}` },
  });
  expect(meRes.status(), "/auth/me should return 200").toBe(200);
  const meJson = await meRes.json();
  expect(meJson.email).toBe(TEST_EMAIL);
  expect(meJson.default_name).toBeTruthy();

  await page.screenshot({ path: SCREENSHOT_STEP(4, "auth-me-confirmed") });
  await ctx.close();
});

test("TEST-001b: dev bypass accepts any 6-digit code", async ({
  browser,
}) => {
  // Verify that any 6-digit code works for demo@example.com
  const ctx: BrowserContext = await browser.newContext({
    ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();

  await page.goto(
    `http://localhost:8448/auth/login?email=${encodeURIComponent(TEST_EMAIL)}&code=000000`
  );
  await page.waitForLoadState("networkidle");

  // Should be pre-filled on the verify step
  await expect(page.locator("#code")).toHaveValue("000000");

  await page.locator('button:has-text("验证并登录")').click();
  await page.waitForURL(/\/sessions/, { timeout: 10000 });

  const cookies = await ctx.cookies();
  const sbcCookie = cookies.find((c) => c.name === "sbc_session");
  expect(sbcCookie).toBeTruthy();

  await ctx.close();
});

test("TEST-001c: invalid code shows error", async ({ browser }) => {
  // Non-bypass email should get error for wrong code
  // We use a non-DEV_BYPASS email + wrong code → should get 401
  const ctx: BrowserContext = await browser.newContext({
    ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();

  await page.goto(
    `http://localhost:8448/auth/login?email=test-notbypass@example.com&code=999999`
  );
  await page.waitForLoadState("networkidle");

  // Code is pre-filled but user is not in DEV_BYPASS → verify should fail
  await page.locator('button:has-text("验证并登录")').click();

  // Error message should appear
  await expect(page.locator(".error")).toContainText("验证码", {
    timeout: 5000,
  });

  // Should still be on login page
  expect(page.url()).toContain("/auth/login");

  await ctx.close();
});
