/**
 * DEBUG 422: capture bill request + response for 422 error
 */
import { test, expect, type BrowserContext, type Page } from "@playwright/test";

const BASE = "http://localhost:8448";
const IPHONE_VIEWPORT = { width: 390, height: 844 } as const;
const MOBILE_CONTEXT_OPTS = {
  viewport: IPHONE_VIEWPORT,
  hasTouch: true,
  isMobile: true,
  locale: "zh-CN",
  ignoreHTTPSErrors: true,
  deviceScaleFactor: 3,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
} as const;

async function loginBySqlInjection(ctx: BrowserContext, email: string): Promise<string> {
  const Database = require("better-sqlite3");
  const SQLITE_PATH = process.env.SBC_SQLITE_PATH ?? "/config/workspace/split-bill-calculator/backend/data/sbc.db";
  const db = new Database(SQLITE_PATH);
  try {
    db.prepare("INSERT OR IGNORE INTO users (email, default_name, created_at) VALUES (?, ?, ?)").run(email, email.split("@")[0], new Date().toISOString());
    const code = "999999";
    db.prepare("INSERT INTO verification_codes (email, code, purpose, session_id, created_at, expires_at, used) VALUES (?, ?, ?, NULL, ?, ?, 0)").run(email, code, "magic_link", new Date().toISOString(), new Date(Date.now() + 10 * 60_000).toISOString());
    const loginPage = await ctx.newPage();
    await loginPage.goto(`${BASE}/auth/login?next=/sessions`);
    await loginPage.waitForLoadState("networkidle");
    await loginPage.locator('input[type="email"], #email').first().fill(email);
    const sendBtn = loginPage.locator('button:has-text("发送"), button:has-text("send"), button[type="submit"]').first();
    if ((await sendBtn.count()) > 0) {
      await sendBtn.click().catch(() => {});
      await loginPage.waitForTimeout(500);
    }
    const codeInput = loginPage.locator('input[name="code"], input[inputmode="numeric"], input[placeholder*="验证码"]').first();
    if ((await codeInput.count()) > 0) {
      await codeInput.fill(code);
      const verifyBtn = loginPage.locator('button:has-text("验证"), button[type="submit"]').first();
      await verifyBtn.click();
      await loginPage.waitForURL(/\/sessions/, { timeout: 10000 });
    }
    await loginPage.close();
  } finally {
    db.close();
  }
  return email.split("@")[0];
}

test("debug 422", async ({ browser }) => {
  const ctx: BrowserContext = await browser.newContext({ ...MOBILE_CONTEXT_OPTS });
  const page: Page = await ctx.newPage();

  const capturedRequests: any[] = [];
  const capturedResponses: any[] = [];
  
  page.on("request", (req) => {
    if (req.url().includes("/api/sessions") && (req.method() === "POST" || req.method() === "GET")) {
      capturedRequests.push({
        url: req.url(),
        method: req.method(),
        headers: req.headers(),
        postData: req.postData(),
      });
    }
  });
  
  page.on("response", (res) => {
    if (res.url().includes("/api/sessions") && res.status() >= 400) {
      capturedResponses.push({
        url: res.url(),
        status: res.status(),
        body: res.text(),
      });
    }
  });

  // Login to get cookie
  await loginBySqlInjection(ctx, "debug422@test.local");
  
  // Create session via wizard
  await page.goto(`${BASE}/sessions/new`);
  await page.waitForLoadState("networkidle");
  await page.locator("#session-name").fill("Debug 422 Test");
  await page.locator('button:has-text("下一步")').click();
  await expect(page.locator("h2", { hasText: "一共有多少个昵称" })).toBeVisible();
  
  // Step 2: fill nicknames
  const inputs = await page.locator('input[type="text"]').all();
  await inputs[0].fill("我");
  await inputs[1].fill("同伴 A");
  await page.locator('button:has-text("下一步")').click();
  
  // Step 3: confirm creation
  await expect(page.locator("h2", { hasText: "使用什么币种" })).toBeVisible();
  await page.locator('button:has-text("确认创建")').click();
  
  await page.waitForURL(/\/sessions\/\d+$/, { timeout: 15000 });
  const sid = Number(page.url().match(/\/sessions\/(\d+)/)![1]);
  console.log("SID:", sid);
  
  // Go to bill form
  await page.goto(`${BASE}/sessions/${sid}/bills/new`);
  await page.waitForLoadState("networkidle");
  
  // Fill amount via calculator
  await page.locator('[data-testid="amount-calc-row"]').click();
  const sheet = page.locator('.sheet[role="dialog"]');
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "1", exact: true }).click();
  await sheet.getByRole("button", { name: "0", exact: true }).click();
  await sheet.getByRole("button", { name: "0", exact: true }).click();
  await page.locator('[data-testid="amount-calc-eq-done"]').click();
  await expect(sheet).toHaveCount(0);
  
  // Fill desc
  await page.locator("#desc").fill("Debug bill");
  
  // Select payer
  await page.locator("#payer").selectOption({ index: 1 });
  
  // Capture submit request
  await page.locator('button[type="submit"]:has-text("保存账单")').click();
  await page.waitForTimeout(3000);
  
  console.log("CAPTURED REQUESTS:", JSON.stringify(capturedRequests, null, 2));
  console.log("CAPTURED RESPONSES:", JSON.stringify(capturedResponses, null, 2));
  
  // Check if 422
  const has422 = capturedResponses.some(r => r.status === 422);
  if (has422) {
    console.log("422 FOUND!");
  }
  
  await ctx.close();
});