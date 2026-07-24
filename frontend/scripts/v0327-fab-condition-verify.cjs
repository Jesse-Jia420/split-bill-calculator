#!/usr/bin/env node
/**
 * v0.3.27-#17 verify — FAB bg 条件化 (PO 0723-3 续)
 *
 * Covers:
 * - /sessions 0 sessions 状态 → .fab.emphasized 存在 + bg 深
 * - /sessions 有 sessions 状态 → .fab 不带 .emphasized + bg 浅
 * - /sessions/[id] 0 bills 状态 → .fab.emphasized 存在 + bg 深
 * - /sessions/[id] 有 bills 状态 → .fab 不带 .emphasized + bg 浅
 */
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = process.env.SBC_BASE || 'http://172.18.0.5:8448';
const OUT_DIR = path.join(process.env.HOME || '/home/node', '.openclaw/media/browser/v0327-fab-condition/');
fs.mkdirSync(OUT_DIR, { recursive: true });

const DB_QUERY_CMD = (email) => `sqlite3 /config/workspace/split-bill-calculator/backend/data/sbc.db "SELECT code FROM verification_codes WHERE email='${email}' AND used=0 ORDER BY created_at DESC LIMIT 1;"`;

async function login(ctx, email) {
  await ctx.request.post(`${BASE}/api/auth/send-code`, { data: { email }, headers: { 'Content-Type': 'application/json' } });
  if (email.toLowerCase() === 'xinhua1001@outlook.com') {
    await ctx.request.post(`${BASE}/api/auth/verify-code`, { data: { email, code: '000000' }, headers: { 'Content-Type': 'application/json' } });
    return;
  }
  const code = execSync(DB_QUERY_CMD(email)).toString().trim();
  await ctx.request.post(`${BASE}/api/auth/verify-code`, { data: { email, code }, headers: { 'Content-Type': 'application/json' } });
}

async function readFab(page) {
  return page.evaluate(() => {
    const fab = document.querySelector('.fab');
    if (!fab) return null;
    const cs = getComputedStyle(fab);
    return {
      classList: Array.from(fab.classList),
      hasEmphasized: fab.classList.contains('emphasized'),
      backgroundImage: cs.backgroundImage,
      backgroundColor: cs.backgroundColor,
      border: cs.border,
      borderColor: cs.borderColor,
      borderWidth: cs.borderWidth,
    };
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const iPhone = devices['iPhone 13'];
  const ctx = await browser.newContext({ ...iPhone, locale: 'zh-CN', viewport: { width: 390, height: 844 } });

  let failed = 0;
  function check(name, cond, detail) {
    if (cond) console.log(`✓ ${name}`);
    else { console.log(`✗ ${name} — ${detail || ''}`); failed++; }
  }

  // ============================================================
  // PART A: /sessions — 0 sessions 状态 (新 user)
  // ============================================================
  console.log('\n=== PART A1: /sessions 0 sessions (新 user) ===');
  const aEmail = `fab-test-${Date.now()}@example.com`;
  console.log('login fresh:', aEmail);
  await login(ctx, aEmail);

  let page = await ctx.newPage();
  await page.goto(`${BASE}/sessions`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const emptyFab = await readFab(page);
  console.log('empty FAB:', JSON.stringify(emptyFab, null, 2));
  check('A1 .fab hasEmphasized=true', emptyFab?.hasEmphasized === true, `got ${emptyFab?.hasEmphasized}`);
  check('A1 borderWidth=1.5px', emptyFab?.borderWidth === '1.5px', `got ${emptyFab?.borderWidth}`);
  check('A1 bg 含 0.18 alpha', /0\.18/.test(emptyFab?.backgroundImage || '') || /0\.18/.test(emptyFab?.backgroundColor || ''),
    `got ${emptyFab?.backgroundImage?.slice(0, 100)}`);
  await page.screenshot({ path: path.join(OUT_DIR, 'A1-sessions-empty-fab-emphasized.png') });

  // ============================================================
  // PART A2: /sessions — 有 sessions 状态 (xinhua1001)
  // ============================================================
  console.log('\n=== PART A2: /sessions 有 sessions (xinhua1001) ===');
  // logout by clearing cookies + login fresh
  await ctx.clearCookies();
  await login(ctx, 'xinhua1001@outlook.com');

  const page2 = await ctx.newPage();
  await page2.goto(`${BASE}/sessions`, { waitUntil: 'networkidle' });
  await page2.waitForTimeout(800);

  const hasFab = await readFab(page2);
  console.log('has FAB:', JSON.stringify(hasFab, null, 2));
  check('A2 .fab hasEmphasized=false', hasFab?.hasEmphasized === false, `got ${hasFab?.hasEmphasized}`);
  check('A2 borderWidth=1px', hasFab?.borderWidth === '1px', `got ${hasFab?.borderWidth}`);
  check('A2 bg 含 0.04 alpha (浅色)', /0\.04/.test(hasFab?.backgroundImage || '') || /0\.04/.test(hasFab?.backgroundColor || ''),
    `got ${hasFab?.backgroundImage?.slice(0, 100)}`);
  await page2.screenshot({ path: path.join(OUT_DIR, 'A2-sessions-with-fab-normal.png') });

  // ============================================================
  // PART B1: /sessions/[id] — 0 bills 状态 (session 6)
  // ============================================================
  console.log('\n=== PART B1: /sessions/6 0 bills (session 6) ===');
  await page2.goto(`${BASE}/sessions/6`, { waitUntil: 'networkidle' });
  await page2.waitForTimeout(800);

  const billsEmptyFab = await readFab(page2);
  console.log('bills empty FAB:', JSON.stringify(billsEmptyFab, null, 2));
  check('B1 .fab hasEmphasized=true', billsEmptyFab?.hasEmphasized === true, `got ${billsEmptyFab?.hasEmphasized}`);
  check('B1 borderWidth=1.5px', billsEmptyFab?.borderWidth === '1.5px', `got ${billsEmptyFab?.borderWidth}`);
  check('B1 bg 含 0.18 alpha', /0\.18/.test(billsEmptyFab?.backgroundImage || '') || /0\.18/.test(billsEmptyFab?.backgroundColor || ''),
    `got ${billsEmptyFab?.backgroundImage?.slice(0, 100)}`);
  await page2.screenshot({ path: path.join(OUT_DIR, 'B1-sessions-6-empty-bills-fab-emphasized.png') });

  // ============================================================
  // PART B2: /sessions/[id] — 有 bills 状态 (session 11 Thailand 32 bills)
  // ============================================================
  console.log('\n=== PART B2: /sessions/11 有 bills (Thailand 32 bills) ===');
  await page2.goto(`${BASE}/sessions/11`, { waitUntil: 'networkidle' });
  await page2.waitForTimeout(800);

  const hasBillsFab = await readFab(page2);
  console.log('has bills FAB:', JSON.stringify(hasBillsFab, null, 2));
  check('B2 .fab hasEmphasized=false', hasBillsFab?.hasEmphasized === false, `got ${hasBillsFab?.hasEmphasized}`);
  check('B2 borderWidth=1px', hasBillsFab?.borderWidth === '1px', `got ${hasBillsFab?.borderWidth}`);
  check('B2 bg 含 0.04 alpha (浅色)', /0\.04/.test(hasBillsFab?.backgroundImage || '') || /0\.04/.test(hasBillsFab?.backgroundColor || ''),
    `got ${hasBillsFab?.backgroundImage?.slice(0, 100)}`);
  await page2.screenshot({ path: path.join(OUT_DIR, 'B2-sessions-11-with-bills-fab-normal.png') });

  await browser.close();
  console.log(`\n=== Result === ${failed === 0 ? '✅ PASS' : `❌ ${failed} fail`}. Screenshots → ${OUT_DIR}`);
  process.exit(failed === 0 ? 0 : 1);
})();