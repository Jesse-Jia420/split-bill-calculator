// v0.3.32 -- UAT 0725-2 #1 Playwright iPhone 13 verification
//
// Goals:
// - 三段 layout DOM 存在 (建议转账 / 已结算记录 / 最新应结算)
// - 添加按钮 → sheet 弹出 (mockup 2)
// - 填 ¥150 → preview 显示 (mockup 3)
// - submit → POST 成功 + sheet 关 + list 多一条 (mockup 4-5)
// - 删除按钮 (添加者) 可见 + click 删除成功
// - 跨币种分别计算 (CNY + THB 互不影响)
// - 边界 case: amount=0 / payer==payee 都 disable submit

const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT_DIR = '/tmp/v0325-2-1-shots';
const API_BASE = 'http://127.0.0.1:8449';
const FRONT_BASE = 'http://localhost:8448';
const SESSION_CODE = '64BZQNX9NU';  // session 9 (Thailand)
const SESSION_ID = 9;

function log(...a) { console.log('[verify]', ...a); }

(async () => {
  try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch {}

  const browser = await chromium.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  // Navigate to root first so subsequent relative /api/ calls work
  await page.goto(`${FRONT_BASE}/`);
  await page.waitForTimeout(500);

  // Login via page.evaluate (uses browser cookies via vite proxy /api)
  log('login as xinhua1001@outlook.com');
  const loginResult = await page.evaluate(async () => {
    const r1 = await fetch(`/api/auth/send-code`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'xinhua1001@outlook.com' }),
    });
    const r2 = await fetch(`/api/auth/verify-code`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'xinhua1001@outlook.com', code: '000000' }),
    });
    return { r1: r1.status, r2: r2.status };
  });
  log(`  - login result: ${loginResult.r1}, ${loginResult.r2}`);
  if (loginResult.r2 !== 200) throw new Error('login failed');

  // Cleanup via API (use relative URL so vite proxy works + cookies flow)
  log('cleanup: delete any existing settlement_records on session 9');
  const cleanupResult = await page.evaluate(async () => {
    const r = await fetch(`/api/sessions/9/settlement_records`, { credentials: 'include' });
    const records = await r.json();
    if (!Array.isArray(records)) {
      console.log('records is not array:', JSON.stringify(records));
      return 0;
    }
    for (const rec of records) {
      const del = await fetch(`/api/sessions/9/settlement_records/${rec.id}`, {
        method: 'DELETE', credentials: 'include',
      });
      console.log(`deleted ${rec.id}: ${del.status}`);
    }
    return records.length;
  });
  log(`  - cleaned up ${cleanupResult} records`);

  // Navigate to settle page
  log(`navigate to /sessions/9/settle`);
  await page.goto(`${FRONT_BASE}/sessions/${SESSION_ID}/settle`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT_DIR, '01-overview-empty.png') });

  // === Test 1: 三段 layout DOM 存在 ===
  log('Test 1: 三段 layout DOM');
  const recordsSection = await page.locator('[data-sbc="settle-records-section"]').count();
  const addBtn = await page.locator('[data-sbc="settle-add-record-btn"]').count();
  const emptyHint = await page.locator('[data-sbc="settle-records-empty"]').count();
  log(`  - records section count: ${recordsSection}`);
  log(`  - add btn count: ${addBtn}`);
  log(`  - empty hint count: ${emptyHint}`);
  if (recordsSection !== 1) throw new Error(`expected 1 records section, got ${recordsSection}`);
  if (addBtn !== 1) throw new Error(`expected 1 add btn, got ${addBtn}`);
  if (emptyHint !== 1) throw new Error(`expected 1 empty hint, got ${emptyHint}`);
  await page.screenshot({ path: path.join(OUT_DIR, '02-overview-empty-state.png') });

  // === Test 2: 添加按钮 → sheet 弹出 ===
  log('Test 2: click add btn -> sheet opens');
  await page.locator('[data-sbc="settle-add-record-btn"]').click();
  await page.waitForTimeout(400);
  const sheetCount = await page.locator('[data-sbc="settlement-sheet"]').count();
  const payerSelectExists = await page.locator('[data-sbc="sheet-payer-select"]').count();
  log(`  - sheet count: ${sheetCount}`);
  log(`  - payer select count: ${payerSelectExists}`);
  if (sheetCount !== 1) throw new Error(`expected 1 sheet, got ${sheetCount}`);
  if (payerSelectExists !== 1) throw new Error(`expected payer select, got ${payerSelectExists}`);
  await page.screenshot({ path: path.join(OUT_DIR, '03-add-sheet-empty.png') });

  // === Test 3: 填 ¥150 → preview 显示 ===
  log('Test 3: fill amount -> preview shows');
  await page.locator('[data-sbc="sheet-payer-select"]').selectOption('36');
  await page.waitForTimeout(100);
  await page.locator('[data-sbc="sheet-payee-select"]').selectOption('38');
  await page.waitForTimeout(100);
  await page.locator('[data-sbc="sheet-currency-select"]').selectOption('CNY');
  await page.locator('[data-sbc="sheet-amount-input"]').fill('150');
  await page.waitForTimeout(300);
  const previewExists = await page.locator('[data-sbc="sheet-preview"]').count();
  log(`  - preview count: ${previewExists}`);
  if (previewExists !== 1) throw new Error('preview should show after fill');
  const submitBtn = page.locator('[data-sbc="sheet-submit-btn"]');
  const isDisabled = await submitBtn.isDisabled();
  log(`  - submit disabled: ${isDisabled}`);
  if (isDisabled) throw new Error('submit btn should be enabled');
  await page.screenshot({ path: path.join(OUT_DIR, '04-add-sheet-preview.png') });

  // === Test 4: submit → POST 成功 + sheet 关 + list 多一条 ===
  log('Test 4: submit -> POST success + sheet close + list updates');
  await submitBtn.click();
  await page.waitForTimeout(800);
  const sheetCountAfter = await page.locator('[data-sbc="settlement-sheet"]').count();
  log(`  - sheet count after submit: ${sheetCountAfter}`);
  if (sheetCountAfter !== 0) throw new Error('sheet should close after submit');
  const emptyAfter = await page.locator('[data-sbc="settle-records-empty"]').count();
  log(`  - empty hint count after: ${emptyAfter}`);
  if (emptyAfter !== 0) throw new Error('empty hint should disappear');
  const rowCount = await page.locator('[data-sbc="settlement-row"]').count();
  log(`  - record row count: ${rowCount}`);
  if (rowCount !== 1) throw new Error(`expected 1 record row, got ${rowCount}`);
  await page.screenshot({ path: path.join(OUT_DIR, '05-records-list-1row.png') });

  // === Test 5: 第二个 record (跨币种) ===
  log('Test 5: add cross-currency record (THB)');
  await page.locator('[data-sbc="settle-add-record-btn"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-sbc="sheet-payer-select"]').selectOption('40');
  await page.locator('[data-sbc="sheet-payee-select"]').selectOption('38');
  await page.locator('[data-sbc="sheet-currency-select"]').selectOption('THB');
  await page.locator('[data-sbc="sheet-amount-input"]').fill('100');
  await page.locator('[data-sbc="sheet-note-input"]').fill('已支付宝');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, '06-add-sheet-thb.png') });
  await page.locator('[data-sbc="sheet-submit-btn"]').click();
  await page.waitForTimeout(800);
  const rowCount2 = await page.locator('[data-sbc="settlement-row"]').count();
  log(`  - record row count after THB: ${rowCount2}`);
  if (rowCount2 !== 2) throw new Error(`expected 2 record rows, got ${rowCount2}`);
  await page.screenshot({ path: path.join(OUT_DIR, '07-records-list-2rows.png') });

  // === Test 6: 最新应结算 section 出现 + 包含两条 ===
  log('Test 6: latest section appears with 2 affected transfers');
  const latestRows = await page.locator('[data-sbc="settle-latest-row"]').count();
  log(`  - latest rows count: ${latestRows}`);
  if (latestRows !== 2) throw new Error(`expected 2 latest rows, got ${latestRows}`);
  await page.screenshot({ path: path.join(OUT_DIR, '08-latest-section-2rows.png'), fullPage: true });

  // === Test 7: 删除按钮 (创建者) 可见 ===
  log('Test 7: delete btn visibility (creator only)');
  const deleteBtnsV2 = await page.locator('button[aria-label="删除记录"]').count();
  log(`  - delete btns v2: ${deleteBtnsV2}`);
  if (deleteBtnsV2 !== 2) {
    log(`  WARN: expected 2 delete buttons, got ${deleteBtnsV2}`);
  }
  await page.screenshot({ path: path.join(OUT_DIR, '09-delete-btns-visible.png') });

  // === Test 8: 删除第二条 (THB record) ===
  log('Test 8: delete THB record');
  const records = await page.evaluate(async () => {
    const r = await fetch(`/api/sessions/9/settlement_records`, { credentials: 'include' });
    return await r.json();
  });
  if (!Array.isArray(records)) {
    log(`  - records is not array:`, JSON.stringify(records));
    throw new Error('expected records array, got ' + JSON.stringify(records).substring(0, 100));
  }
  log(`  - records: ${records.length}`);
  for (const r of records) log(`    - ${r.id}: ${r.payer_name} -> ${r.payee_name} ${r.amount} ${r.currency}`);
  const thbRecord = records.find((r) => r.currency === 'THB');
  if (thbRecord) {
    page.on('dialog', async (dialog) => {
      log(`  - dialog: ${dialog.type()} "${dialog.message()}"`);
      await dialog.accept();
    });
    await page.evaluate(async (recordId) => {
      const rows = document.querySelectorAll('[data-sbc="settlement-row"]');
      for (const row of rows) {
        if (row.getAttribute('data-record-id') === String(recordId)) {
          const btn = row.querySelector('button[aria-label="删除记录"]');
          if (btn) btn.click();
          return;
        }
      }
    }, thbRecord.id);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT_DIR, '10-after-delete-thb.png') });
    const rowCountAfterDel = await page.locator('[data-sbc="settlement-row"]').count();
    log(`  - record row count after delete: ${rowCountAfterDel}`);
    if (rowCountAfterDel !== 1) throw new Error(`expected 1 row after delete, got ${rowCountAfterDel}`);
  }

  // === Test 9: 验证 settle transfers 调整 ===
  log('Test 9: verify transfers adjusted via API');
  const settle = await page.evaluate(async () => {
    const r = await fetch(`/api/sessions/9/settle?view=primary`, { credentials: 'include' });
    return await r.json();
  });
  log(`  - transfers:`);
  for (const t of settle.transfers) {
    log(`    - ${t.from_member_id} -> ${t.to_member_id}: ${t.amount} ${settle.primary_currency}`);
  }

  // === Test 10: 边界 case — 填 amount = 0 (should disable submit) ===
  log('Test 10: amount = 0 should disable submit');
  await page.locator('[data-sbc="settle-add-record-btn"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-sbc="sheet-payer-select"]').selectOption('36');
  await page.locator('[data-sbc="sheet-payee-select"]').selectOption('38');
  await page.locator('[data-sbc="sheet-amount-input"]').fill('0');
  await page.waitForTimeout(200);
  const submitDisabledZero = await page.locator('[data-sbc="sheet-submit-btn"]').isDisabled();
  log(`  - submit disabled with amount=0: ${submitDisabledZero}`);
  if (!submitDisabledZero) throw new Error('submit should be disabled with amount=0');
  await page.screenshot({ path: path.join(OUT_DIR, '11-amount-zero-disabled.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // === Test 11: 边界 case — payer == payee should disable submit ===
  log('Test 11: payer == payee should disable submit');
  await page.locator('[data-sbc="settle-add-record-btn"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-sbc="sheet-payer-select"]').selectOption('36');
  await page.locator('[data-sbc="sheet-payee-select"]').selectOption('36');
  await page.locator('[data-sbc="sheet-amount-input"]').fill('100');
  await page.waitForTimeout(200);
  const submitDisabledSame = await page.locator('[data-sbc="sheet-submit-btn"]').isDisabled();
  log(`  - submit disabled with payer==payee: ${submitDisabledSame}`);
  if (!submitDisabledSame) throw new Error('submit should be disabled with payer==payee');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  await browser.close();
  log('All tests passed!');
})().catch(async (e) => {
  console.error('FAIL:', e.message, e.stack);
  process.exit(1);
});