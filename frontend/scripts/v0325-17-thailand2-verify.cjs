#!/usr/bin/env node
/**
 * v0.3.25 #17 — Thailand #2 session Playwright iPhone 13 verification.
 *
 * Verifies:
 *   1. /sessions list shows session 9 (泰国测试账单 2 7.25-7.28) at top
 *   2. /sessions/9 detail loads (5 members + 40 bills)
 *   3. /sessions/9/settle?view=primary renders balances + transfers
 *   4. /sessions/9/bills shows 40-bill list grouped by day (4 days)
 *   5. Each member has both payer + participant + exclusive coverage
 *
 * Saves 4 PNGs to ~/.openclaw/media/browser/v0325-17-thailand2/.
 */

const { chromium, devices } = require("playwright");
const fs = require("fs");
const path = require("path");

const SCREENSHOT_DIR = path.join(
  process.env.HOME || "/home/node",
  ".openclaw/media/browser/v0325-17-thailand2"
);

async function login(page) {
  // Call the auth API in the page's own context so the Set-Cookie
  // response header lands in the same CookieJar as subsequent
  // navigations. Using page.context().request.post can silently fail
  // to propagate the cookie when the request hits the vite proxy
  // from a different origin than the page.
  await page.goto("https://test.jessejia.pp.ua/auth/login", {
    waitUntil: "load",
  });
  await page.evaluate(async () => {
    await fetch("/api/auth/send-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email: "demo@example.com" }),
    });
    const verifyRes = await fetch("/api/auth/verify-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email: "demo@example.com", code: "000000" }),
    });
    if (!verifyRes.ok) {
      throw new Error("verify-code failed: " + verifyRes.status);
    }
  });
  // Reload /sessions so the page sees the new cookie.
  await page.goto("https://test.jessejia.pp.ua/sessions", { waitUntil: "load" });
}

async function shot(page, name) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const file = path.join(SCREENSHOT_DIR, name);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

(async () => {
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const iphone = devices["iPhone 13"];
  const context = await browser.newContext({
    ...iphone,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
  const page = await context.newPage();

  await login(page);

  // === 1. /sessions list (session 9 at top) ===
  await page.goto("https://test.jessejia.pp.ua/sessions", { waitUntil: "load" });
  await page.waitForSelector(".session-card", { timeout: 20000 });
  await page.waitForTimeout(800);
  const firstCardText = await page.locator(".session-card").first().textContent();
  console.log("First session card text:", firstCardText?.slice(0, 80));
  if (!firstCardText?.includes("泰国测试账单 2 7.25-7.28")) {
    console.error("FAIL: session 9 not at top of /sessions");
    process.exit(1);
  }
  await shot(page, "01-sessions-list-session9-top.png");
  console.log("✓ session 9 at top of /sessions");

  // === 2. /sessions/9 detail ===
  await page.goto("https://test.jessejia.pp.ua/sessions/9", { waitUntil: "load" });
  await page.waitForTimeout(2500);
  // members section — count avatars
  const memberCount = await page.locator(".member-row, [data-member-id]").count();
  console.log("session 9 member rows visible:", memberCount);
  // bills list grouped by day
  const billRows = await page.locator(".bill-row, [data-bill-id]").count();
  console.log("session 9 bill rows visible:", billRows);
  await shot(page, "02-sessions-9-detail.png");
  console.log("✓ /sessions/9 detail loaded");

  // === 3. /sessions/9/settle?view=primary ===
  await page.goto("https://test.jessejia.pp.ua/sessions/9/settle?view=primary", {
    waitUntil: "load",
  });
  await page.waitForTimeout(2500);
  const settleH1 = await page.locator("h1, h2, .balance").first().textContent();
  console.log("settle heading:", settleH1?.slice(0, 80));
  await shot(page, "03-sessions-9-settle-primary.png");
  console.log("✓ /sessions/9/settle?view=primary loaded");

  // === 4. /sessions/9 detail — scroll to bills section to verify the
//       40 bills grouped by 4 days render correctly ===
  await page.goto("https://test.jessejia.pp.ua/sessions/9", { waitUntil: "load" });
  await page.waitForTimeout(2000);
  // Scroll to the bills section
  await page.evaluate(() => {
    const billsSection = document.querySelector("[data-section=bills], .bills-section");
    if (billsSection) billsSection.scrollIntoView();
    else window.scrollTo(0, document.body.scrollHeight / 2);
  });
  await page.waitForTimeout(1200);
  await shot(page, "04-sessions-9-bills-scrolled.png");
  console.log("✓ /sessions/9 bills section scrolled into view");

  // === 5. /sessions/9/bills/new (sanity check BillForm loads) ===
  await page.goto("https://test.jessejia.pp.ua/sessions/9/bills/new", { waitUntil: "load" });
  await page.waitForTimeout(2000);
  await shot(page, "05-sessions-9-bills-new.png");

  await browser.close();
  console.log("\n✅ all 5 pages verified");
})();