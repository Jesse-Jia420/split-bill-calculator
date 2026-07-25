#!/usr/bin/env node
/**
 * v0.3.29 — UAT 0725-1 #13 v4 Verify B
 *
 * 验证 Feature B + C: /sessions/{id}/login 路由 + header + 表单
 *
 * PO v4 字面要求:
 * 1. Header row: 左 56×56 圆形 back FAB + 右 pill "登录 →" 按钮
 * 2. 副标题: "登录 {nickname}({emailMasked})以回到账本" (15px font-weight 500)
 * 3. 副副标题: "{session_name}" (13px muted)
 * 4. 邮箱 input: empty value, placeholder="请输入邮箱"
 * 5. 验证码 input + helper: "验证码将发送至 {emailMasked}"
 * 6. 主 CTA: "登录并回到账本" (全宽 indigo 渐变)
 * 7. 不能 pre-fill 真邮箱
 * 8. Back FAB click → 回 /sessions/{id}/join
 *
 * 数据前置: session 7 "清迈" — 来自 join 页 Feature A 测试
 * 导航入口: /sessions/7/login?as=16&nickname=Jes&emailMasked=x***@outlook.com
 */

const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const BASE = 'http://172.18.0.5:8470';  // codeserver 本地 dev server
const VERIFY_DIR = '/home/node/.openclaw/media/browser/v0329-0725-1-13-B';
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

  // 直接导航到 login 页 (anon flow, 没登录)
  const LOGIN_URL = `${BASE}/sessions/7/login?as=16&nickname=Jes&emailMasked=x***@outlook.com`;
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  const results = [];

  // ============ Test 1: 头部行 .login-header 存在 + 56×56 左 + pill 18px 圆角 右 ============
  console.log('\n[Test 1] .login-header 存在 + .login-back-fab 56×56 + .login-pill-btn 18px 圆角');
  {
    const data = await page.evaluate(() => {
      const header = document.querySelector('.login-header');
      const fab = document.querySelector('.login-back-fab');
      const pill = document.querySelector('.login-pill-btn');
      if (!header || !fab || !pill) {
        return { headerExists: !!header, fabExists: !!fab, pillExists: !!pill, valid: false };
      }
      const fabRect = fab.getBoundingClientRect();
      const pillCs = window.getComputedStyle(pill);
      return {
        headerExists: true,
        fabExists: true,
        pillExists: true,
        fabWidth: fabRect.width,
        fabHeight: fabRect.height,
        fabBorderRadius: window.getComputedStyle(fab).borderRadius,
        pillBorderRadius: pillCs.borderRadius,
        pillText: pill.textContent?.trim() || '',
        valid:
          fabRect.width >= 50 && fabRect.width <= 60 &&  // ~56px
          fabRect.height >= 50 && fabRect.height <= 60 &&
          parseFloat(pillCs.borderRadius) >= 16 && parseFloat(pillCs.borderRadius) <= 20,  // ~18px
      };
    });
    console.log('  data:', JSON.stringify(data));
    results.push({ test: '1_header_fab_pill', data, passed: data.valid });
  }

  // ============ Test 2: 副标题 "登录 Ju(j***@gmail.com)以回到账本" 文字匹配 ============
  console.log('\n[Test 2] 副标题 "登录 Jes(x***@outlook.com)以回到账本" 文字匹配');
  {
    const data = await page.evaluate(() => {
      const subtitle = document.querySelector('[data-testid="login-subtitle"]');
      const sessionName = document.querySelector('[data-testid="login-session-name"]');
      if (!subtitle) return { valid: false, reason: 'no subtitle' };
      const text = subtitle.textContent?.trim() || '';
      const sessionText = sessionName?.textContent?.trim() || '';
      return {
        subtitleText: text,
        sessionNameText: sessionText,
        valid:
          text.includes('登录') &&
          text.includes('Jes') &&
          text.includes('x***@outlook.com') &&
          text.includes('以回到账本') &&
          sessionText === '清迈',
      };
    });
    console.log('  subtitle:', data.subtitleText);
    console.log('  session:', data.sessionNameText);
    results.push({ test: '2_subtitle_text_match', data, passed: data.valid });
  }

  // ============ Test 3: input[type=email] value="" (empty), placeholder="请输入邮箱" ============
  console.log('\n[Test 3] 邮箱 input value="" + placeholder="请输入邮箱"');
  {
    const data = await page.evaluate(() => {
      const input = document.querySelector('input[type="email"]');
      if (!input) return { valid: false, reason: 'no email input' };
      return {
        value: input.value,
        placeholder: input.placeholder,
        autocomplete: input.autocomplete,
        valid:
          input.value === '' &&  // PO v4 强调: 不能 pre-fill 真邮箱
          input.placeholder === '请输入邮箱' &&
          input.autocomplete === 'off',
      };
    });
    console.log('  data:', JSON.stringify(data));
    results.push({ test: '3_email_input_empty', data, passed: data.valid });
  }

  // ============ Test 4: 验证码 helper 显示 "验证码将发送至 j***@gmail.com" ============
  console.log('\n[Test 4] 验证码 helper "验证码将发送至 x***@outlook.com"');
  {
    const data = await page.evaluate(() => {
      const helper = document.querySelector('[data-testid="login-code-helper"]');
      if (!helper) return { valid: false, reason: 'no helper' };
      const text = helper.textContent?.trim() || '';
      return {
        text,
        valid:
          text.includes('验证码将发送至') &&
          text.includes('x***@outlook.com'),
      };
    });
    console.log('  helper:', data.text);
    results.push({ test: '4_code_helper_text', data, passed: data.valid });
  }

  // ============ Test 5: 主 CTA "登录并回到账本" 存在 + 全宽 ============
  console.log('\n[Test 5] 主 CTA "登录并回到账本" 存在 + 全宽');
  {
    const data = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="login-submit-btn"]');
      if (!btn) return { valid: false, reason: 'no submit btn' };
      const rect = btn.getBoundingClientRect();
      const cs = window.getComputedStyle(btn);
      return {
        text: btn.textContent?.trim() || '',
        width: rect.width,
        // Full width >= 280 (iPhone 13 viewport 390 - padding 40 - extra ~70)
        valid: btn.textContent?.includes('登录并回到账本') && rect.width >= 280 && cs.background.includes('gradient'),
      };
    });
    console.log('  data:', JSON.stringify(data));
    results.push({ test: '5_main_cta_fullwidth', data, passed: data.valid });
  }

  // ============ Test 6: nickname 高亮 indigo 颜色 (PO v4) ============
  console.log('\n[Test 6] nickname 用 indigo 高亮 + font-weight 600');
  {
    const data = await page.evaluate(() => {
      const nickEl = document.querySelector('[data-testid="login-subtitle"] .nickname');
      if (!nickEl) return { valid: false, reason: 'no nickname' };
      const cs = window.getComputedStyle(nickEl);
      return {
        color: cs.color,
        fontWeight: cs.fontWeight,
        text: nickEl.textContent?.trim() || '',
        valid: cs.color === 'rgb(79, 70, 229)' && cs.fontWeight === '600' && nickEl.textContent?.trim() === 'Jes',
      };
    });
    console.log('  data:', JSON.stringify(data));
    results.push({ test: '6_nickname_indigo', data, passed: data.valid });
  }

  // ============ Test 7: Back FAB click → 回 /sessions/{id}/join ============
  console.log('\n[Test 7] Back FAB click → 回 /sessions/7/join');
  {
    let navUrl = null;
    const navPromise = page.waitForURL(/\/sessions\/\d+\/join/, { timeout: 5000 }).then(() => {
      navUrl = page.url();
    }).catch(() => {});

    await page.click('[data-testid="login-back-fab"]');
    await navPromise;

    const data = {
      navUrl,
      passed: !!navUrl && navUrl.includes('/sessions/7/join'),
    };
    console.log('  nav URL:', navUrl);
    results.push({ test: '7_back_fab_navigates_join', data, passed: data.passed });
  }

  // ============ Test 8: 截图保存 (登录页完整视觉) ============
  console.log('\n[Test 8] 截图保存');
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const screenshotPath = path.join(VERIFY_DIR, 'login-page.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log('  screenshot:', screenshotPath);
  results.push({ test: '8_screenshot', data: { path: screenshotPath }, passed: true });

  // ============ Test 9: 输入 email + click "获取验证码" → step='verify' + cooldown ============
  console.log('\n[Test 9] 输入 email + 获取验证码 → step=verify + cooldown 60s');
  {
    await page.fill('input[type="email"]', 'test@example.com');
    await page.click('[data-testid="login-send-code-btn"]');
    await page.waitForTimeout(2500);

    const data = await page.evaluate(() => {
      const codeBtn = document.querySelector('[data-testid="login-send-code-btn"]');
      const codeInput = document.querySelector('[data-testid="login-code-input"]');
      return {
        codeBtnText: codeBtn?.textContent?.trim() || '',
        codeInputDisabled: codeInput?.disabled || false,
        codeBtnDisabled: codeBtn?.disabled || false,
        valid: !!codeBtn && /^\d+s$/.test(codeBtn.textContent?.trim() || '') && !codeInput?.disabled,
      };
    });
    console.log('  data:', JSON.stringify(data));
    results.push({ test: '9_send_code_step_verify', data, passed: data.valid });
  }

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
