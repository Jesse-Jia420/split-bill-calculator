#!/usr/bin/env node
/**
 * v0.3.29 — UAT 0725-1 #13 v4 Verify A
 *
 * 验证 Feature A: join/+page.svelte 合并列表 + 同时显昵称邮箱
 *
 * 数据前置: session 7 "清迈" 3 人 (Jes owner 邮箱绑定 + Ju/Bb 匿名)
 * 测试用 ANON flow (不登录), 验证 merge list 视觉 + email/nickname 混排
 *
 * 跑法: 本地 codeserver 启了 vite dev server 8470, 用 172.18.0.5:8470.
 * 注意 cookies 域不同 → 必须重新登录 (不复用 test.jessejia.pp.ua).
 */

const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const BASE = 'http://172.18.0.5:8470';  // codeserver 本地 dev server
const VERIFY_DIR = '/home/node/.openclaw/media/browser/v0329-0725-1-13-A';
fs.mkdirSync(VERIFY_DIR, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  });
  const page = await ctx.newPage();

  // ====== ANON flow: 不登录, 直接 /sessions/7/join ======
  // 不走 login, 走 anon (PO v4 视觉平等 验证点在 anon flow — 所有用户都能见)
  await page.goto(`${BASE}/sessions/7/join`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(4000);  // loading overlay + getSessionPreview

  const results = [];

  // ============ Test 1: .member-pick-row DOM 数量 == session 成员总数 ============
  console.log('\n[Test 1] .member-pick-row DOM 数量 == session 成员总数');
  {
    const data = await page.evaluate(() => {
      const rows = document.querySelectorAll('[data-testid="member-pick-row"]');
      const sessionNameEl = document.querySelector('.muted strong');
      return {
        rowCount: rows.length,
        sessionName: sessionNameEl?.textContent || null,
        emailRowCount: Array.from(rows).filter(r => r.getAttribute('data-has-email') === '1').length,
        anonRowCount: Array.from(rows).filter(r => r.getAttribute('data-has-email') === '0').length,
      };
    });
    console.log('  rows:', data.rowCount, '(email:', data.emailRowCount, '+ anon:', data.anonRowCount, ')');
    console.log('  session:', data.sessionName);
    // session 7 = 3 members (1 email + 2 anon)
    const passed = data.rowCount === 3 && data.emailRowCount === 1 && data.anonRowCount === 2;
    results.push({ test: '1_member_pick_row_count', data, passed });
  }

  // ============ Test 2: 每 row 含 .member-nickname + 有邮箱用户含 .member-email-masked ============
  console.log('\n[Test 2] 每 row nickname + (有邮箱用户) email masked');
  {
    const data = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="member-pick-row"]'));
      return rows.map(row => {
        const nicknameEl = row.querySelector('.member-nickname');
        const emailEl = row.querySelector('.member-email-masked');
        const hasEmail = row.getAttribute('data-has-email') === '1';
        return {
          hasNickname: !!nicknameEl,
          nicknameText: nicknameEl?.textContent?.trim() || null,
          hasEmail: hasEmail,
          hasEmailEl: !!emailEl,
          emailText: emailEl?.textContent?.trim() || null,
        };
      });
    });
    console.log('  rows:', JSON.stringify(data));
    const allValid = data.every(r => r.hasNickname && r.nicknameText) &&
                     data.filter(r => r.hasEmail).every(r => r.hasEmailEl && r.emailText) &&
                     data.filter(r => !r.hasEmail).every(r => !r.hasEmailEl);
    results.push({ test: '2_nickname_and_email_per_row', data, passed: allValid });
  }

  // ============ Test 3: 有邮箱用户 nickname 颜色 == 无邮箱 nickname 颜色 (视觉平等) ============
  console.log('\n[Test 3] 有邮箱/无邮箱 nickname 颜色相同 (PO v4 视觉平等)');
  {
    const data = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="member-pick-row"]'));
      const rowsWithEmail = rows.filter(r => r.getAttribute('data-has-email') === '1');
      const rowsNoEmail = rows.filter(r => r.getAttribute('data-has-email') === '0');
      if (rowsWithEmail.length === 0 || rowsNoEmail.length === 0) {
        return { rowsWithEmailCount: rowsWithEmail.length, rowsNoEmailCount: rowsNoEmail.length, valid: false };
      }
      const emailNickColor = window.getComputedStyle(rowsWithEmail[0].querySelector('.member-nickname')).color;
      const emailNickOpacity = window.getComputedStyle(rowsWithEmail[0].querySelector('.member-nickname')).opacity;
      const anonNickColor = window.getComputedStyle(rowsNoEmail[0].querySelector('.member-nickname')).color;
      const anonNickOpacity = window.getComputedStyle(rowsNoEmail[0].querySelector('.member-nickname')).opacity;
      return {
        emailNickColor,
        emailNickOpacity,
        anonNickColor,
        anonNickOpacity,
        rowsWithEmailCount: rowsWithEmail.length,
        rowsNoEmailCount: rowsNoEmail.length,
        valid: emailNickColor === anonNickColor && emailNickOpacity === anonNickOpacity,
      };
    });
    console.log('  email-nick:', data.emailNickColor, '/', data.emailNickOpacity);
    console.log('  anon-nick: ', data.anonNickColor, '/', data.anonNickOpacity);
    results.push({ test: '3_email_anon_visual_equal', data, passed: data.valid });
  }

  // ============ Test 4: nickname 字号 16px font-weight 600 ============
  console.log('\n[Test 4] nickname 字号 16px font-weight 600 (PO v4 字面)');
  {
    const data = await page.evaluate(() => {
      const nick = document.querySelector('[data-testid="member-pick-row"] .member-nickname');
      if (!nick) return null;
      const cs = window.getComputedStyle(nick);
      return {
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        color: cs.color,
      };
    });
    console.log('  computed:', JSON.stringify(data));
    // 16px font-size + 600 weight
    const passed = !!data && data.fontSize === '16px' && data.fontWeight === '600';
    results.push({ test: '4_nickname_16px_600', data, passed });
  }

  // ============ Test 5: masked email 副行 (PO 拍 B 方案: 首 1 字符 + *** + @domain) ============
  console.log('\n[Test 5] 有邮箱用户 masked email 副行 (PO 拍 B 方案)');
  {
    const data = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="member-pick-row"][data-has-email="1"]'));
      return rows.map(row => {
        const emailEl = row.querySelector('.member-email-masked');
        return {
          text: emailEl?.textContent?.trim() || null,
          fontSize: emailEl ? window.getComputedStyle(emailEl).fontSize : null,
          color: emailEl ? window.getComputedStyle(emailEl).color : null,
        };
      });
    });
    console.log('  email rows:', JSON.stringify(data));
    // session 7 owner = xinhua1001@outlook.com → x***@outlook.com
    const allValid = data.length > 0 && data.every(r => r.text && /^[a-zA-Z]\*\*\*@\S+\.\S+$/.test(r.text));
    results.push({ test: '5_email_masked_format', data, passed: allValid });
  }

  // ============ Test 6: 点有邮箱 row → navigate 到 /sessions/7/login ============
  console.log('\n[Test 6] 点有邮箱 row → navigate 到 /sessions/7/login');
  {
    let navUrl = null;
    const navPromise = page.waitForURL(/\/sessions\/\d+\/login/, { timeout: 5000 }).then(() => {
      navUrl = page.url();
    }).catch(() => {});
    
    const emailRow = await page.locator('[data-testid="member-pick-row"][data-has-email="1"]').first();
    const exists = await emailRow.count();
    if (exists > 0) {
      await emailRow.click();
    }
    await navPromise;
    const data = {
      navTriggered: !!navUrl,
      navUrl,
      passed: !!navUrl && navUrl.includes('/sessions/7/login'),
    };
    console.log('  nav URL:', navUrl);
    results.push({ test: '6_email_row_navigates_to_login', data, passed: data.passed });
  }

  // ============ Test 7: 截图保存 (anon flow 列表合并视觉) ============
  console.log('\n[Test 7] 截图保存');
  // 先回到 join 页 (上一步 navigate 走了)
  await page.goto(`${BASE}/sessions/7/join`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const screenshotPath = path.join(VERIFY_DIR, 'merge-list.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log('  screenshot:', screenshotPath);
  results.push({ test: '7_screenshot', data: { path: screenshotPath }, passed: true });

  // ====== Summary ======
  console.log('\n===== Summary =====');
  const passedCount = results.filter(r => r.passed).length;
  console.log(`Passed: ${passedCount} / ${results.length}`);
  results.forEach((r, i) => {
    console.log(`  ${r.passed ? '✓' : '✗'} ${i+1}. ${r.test}`);
  });

  await browser.close();
  process.exit(passedCount === results.length ? 0 : 1);
})();
