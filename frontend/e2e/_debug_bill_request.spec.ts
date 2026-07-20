/**
 * DEBUG: capture what headers the FE actually sends on POST /api/sessions/1/bills
 */
import { test } from "@playwright/test";

const BASE = "http://localhost:8448";

test("debug: capture bill request headers", async ({ browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    locale: "zh-CN",
  });
  const page = await ctx.newPage();

  // Capture all requests
  const captured: { url: string; method: string; headers: any; postData: string | null }[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/sessions") && req.method() === "POST") {
      captured.push({
        url: req.url(),
        method: req.method(),
        headers: req.headers(),
        postData: req.postData(),
      });
    }
  });
  page.on("console", (msg) => console.log("PAGE:", msg.text()));

  await page.goto(`${BASE}/`);
  await page.locator("button", { hasText: "直接开始使用" }).first().click();
  await page.waitForURL(/\/sessions\/new/, { timeout: 10000 });

  await page.locator("#session-name").fill("Debug Test");
  await page.locator('button:has-text("下一步")').click();
  await expect2(page, "h2", "一共有多少个昵称");
  await page.locator('input[placeholder*="你的昵称"]').fill("我");
  await page.locator('input[placeholder*="同伴"]').fill("同伴 A");
  await page.locator('button:has-text("下一步")').click();
  await expect2(page, "h2", "使用什么币种");
  await page.locator('button:has-text("确认创建")').click();

  await page.waitForURL(/\/sessions\/\d+$/, { timeout: 15000 });
  const sid = Number(page.url().match(/\/sessions\/(\d+)/)![1]);

  // log localStorage
  const ls = await page.evaluate((sid) => ({
    secret: localStorage.getItem(`sbc.actingAs.${sid}`),
    allKeys: Object.keys(localStorage),
  }), sid);
  console.log("LS:", JSON.stringify(ls));

  // go to bills/new
  await page.locator('a:has-text("新建账单"), [aria-label="新建账单"]').first().click();
  await page.waitForURL(/\/bills\/new/, { timeout: 10000 });
  await page.waitForLoadState("networkidle");

  // amount
  await page.locator('[data-testid="amount-calc-row"]').click();
  const sheet = page.locator('.sheet[role="dialog"]');
  await sheet.getByRole("button", { name: "1", exact: true }).click();
  await page.locator('[data-testid="amount-calc-eq-done"]').click();

  // desc
  await page.locator("#desc").fill("Debug bill");

  // payer
  await page.locator("#payer").selectOption({ index: 1 });

  // submit
  await page.locator('button[type="submit"]:has-text("保存账单")').click();
  await page.waitForTimeout(2000);

  console.log("CAPTURED REQUESTS:", JSON.stringify(captured, null, 2));

  await ctx.close();
});

async function expect2(page: any, role: string, text: string) {
  await page.locator(role, { hasText: text }).waitFor({ timeout: 5000 });
}