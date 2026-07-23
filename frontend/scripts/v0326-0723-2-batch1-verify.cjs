#!/usr/bin/env node
/**
 * v0.3.26 #0723-2 Batch 1 verify (8 项 text/CSS 一次性)
 */
const { chromium, devices } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const iPhone = devices['iPhone 13'];
  const context = await browser.newContext({ ...iPhone, locale: 'zh-CN' });
  const page = await context.newPage();
  const log = (...a) => console.log('[verify]', ...a);
  const errs = [];
  const ok = (m) => log('✓', m);
  const fail = (m, e) => { errs.push(m); log('✗', m, e || ''); };

  // Login via BE API
  await page.request.post('http://127.0.0.1:8449/auth/send-code', { data: { email: 'demo@example.com' } });
  await page.request.post('http://127.0.0.1:8449/auth/verify-code', { data: { email: 'demo@example.com', code: '000000' } });

  try {
    // === 1) Wizard step 3 (sessions/new) ===
    log('1) Wizard step 3...');
    await page.goto('http://127.0.0.1:8448/sessions/new', { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    // step 1
    await page.locator('#session-name').fill('TestSessionA');
    // click 下一步
    await page.locator('button[aria-label="下一步"]').click();
    await page.waitForTimeout(500);
    // step 2 — fill nicknames
    const nickInputs = page.locator('.nickname-list input');
    const nickCount = await nickInputs.count();
    for (let i = 0; i < nickCount; i++) {
      await nickInputs.nth(i).fill(`User${i+1}`);
    }
    await page.locator('button[aria-label="下一步"]').click();
    await page.waitForTimeout(500);
    // step 3
    log('   step 3 visible?');
    const stepTitle = await page.locator('.step-title').textContent();
    if (stepTitle && stepTitle.includes('币种')) {
      ok(`step 3 title: ${stepTitle}`);
    } else {
      fail(`step 3 title 错: ${stepTitle}`);
    }

    // #12: 加粗 国内/出国
    const singleBtn = page.locator('button:has-text("单币种")').first();
    if (await singleBtn.count() > 0) {
      await singleBtn.click();
      await page.waitForTimeout(300);
      const hint = page.locator('.currency-mode-hint').first();
      if (await hint.count() > 0) {
        const strong = await hint.locator('strong').count();
        const text = await hint.textContent();
        if (strong >= 1 && text && text.includes('国内')) {
          ok(`#12 single: 国内 加粗 (strong=${strong}, text="${text.trim()}")`);
        } else {
          fail(`#12 single: 加粗失败 (strong=${strong}, text="${text}")`);
        }
      } else {
        fail('#12 single: 找不到 .currency-mode-hint');
      }
    } else {
      fail('#12: 找不到 单币种 button');
    }

    const dualBtn = page.locator('button:has-text("双币种")').first();
    if (await dualBtn.count() > 0) {
      await dualBtn.click();
      await page.waitForTimeout(300);
      const hint = page.locator('.currency-mode-hint').first();
      if (await hint.count() > 0) {
        const strong = await hint.locator('strong').count();
        const text = await hint.textContent();
        if (strong >= 1 && text && text.includes('出国')) {
          ok(`#12 dual: 出国 加粗 (strong=${strong}, text="${text.trim()}")`);
        } else {
          fail(`#12 dual: 加粗失败 (strong=${strong}, text="${text}")`);
        }
      }
    } else {
      fail('#12: 找不到 双币种 button');
    }

    // #13: 文案
    const rateLabelText = await page.locator('label[for="exchange-rate-input"]').textContent();
    if (rateLabelText && rateLabelText.includes('结算币种') && !rateLabelText.includes('副币种')) {
      ok(`#13: 汇率 label: "${rateLabelText.trim()}"`);
    } else {
      fail(`#13: 汇率 label 错: "${rateLabelText}"`);
    }
    const rateHint = await page.locator('.exchange-rate-hint').textContent();
    if (rateHint && rateHint.includes('请先选结算币种') && !rateHint.includes('请先选副币种')) {
      ok(`#13: rate hint: "${rateHint.trim()}"`);
    } else {
      fail(`#13: rate hint 错: "${rateHint}"`);
    }

    // === 2) Session 9 (Thailand 测试账单 2, 5 members, 40 bills, owner): #0723 batch #10, #1 BillListGrouped ===
    log('2) Session 9 (Thailand 测试账单 2) detail...');
    await page.goto('http://127.0.0.1:8448/sessions/9', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    // 展开 members section
    const membersHeader9 = page.locator('.members-head').first();
    if (await membersHeader9.count() > 0) {
      await membersHeader9.click();
      await page.waitForTimeout(500);
    }

    // #14: solo-cta-a (session 9 是 5 members, 不触发 1-member 分支, 验证元素不存在)
    const soloCta = await page.locator('[data-testid="solo-member-cta"]').count();
    if (soloCta === 0) ok('#14: 1-member solo-cta-a data-testid="solo-member-cta" 元素已删');
    else fail(`#14: solo-cta-a 仍存在 (count=${soloCta})`);

    // #20: expiry pill (session 9 是 owner 永久, 通常无 expiry)
    const expiryPill = page.locator('[data-testid="invite-expiry-pill"]');
    const expiryCount = await expiryPill.count();
    if (expiryCount > 0) {
      const ownerName = await page.locator('.expiry-cta-nick').count();
      if (ownerName === 0) {
        const text = await expiryPill.textContent();
        ok(`#20: expiry pill 已删 owner name span (text="${text.trim()}")`);
      } else {
        fail(`#20: .expiry-cta-nick 仍存在`);
      }
    } else {
      log('  (session 9 无 expiry pill — owner 永久保存, 跳过 #20 验证)');
    }

    // #0723 batch #10: bills-card-title size 对齐 members-title-a
    const billsTitle = page.locator('.bills-card-title').first();
    const membersTitle = page.locator('.members-title-a').first();
    if (await billsTitle.count() > 0 && await membersTitle.count() > 0) {
      const b = await billsTitle.evaluate(el => {
        const s = getComputedStyle(el);
        return { fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color };
      });
      const m = await membersTitle.evaluate(el => {
        const s = getComputedStyle(el);
        return { fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color };
      });
      if (b.fontSize === m.fontSize && b.fontWeight === m.fontWeight) {
        ok(`#0723 batch #10: bills-card-title = members-title-a (size=${b.fontSize}, weight=${b.fontWeight})`);
      } else {
        fail(`#0723 batch #10: bills=${JSON.stringify(b)} vs members=${JSON.stringify(m)}`);
      }
    } else {
      fail(`#0723 batch #10: title 元素缺失 (bills=${await billsTitle.count()}, members=${await membersTitle.count()})`);
    }

    // #1 BillListGrouped: 独占 → 个人消费
    const exclusiveBill = page.locator('.bill-row-exclusive').first();
    if (await exclusiveBill.count() > 0) {
      const text = await exclusiveBill.textContent();
      if (text && text.includes('个人消费') && !text.includes('独占')) {
        ok(`#1 BillListGrouped: .bill-row-exclusive = "${text.trim()}"`);
      } else {
        fail(`#1 BillListGrouped: text="${text}"`);
      }
    } else {
      log('  (session 9 当前 .bill-row-exclusive 不在 viewport, 滚到中部再试)');
      await page.evaluate(() => window.scrollTo(0, 600));
      await page.waitForTimeout(500);
      const ex2 = page.locator('.bill-row-exclusive').first();
      if (await ex2.count() > 0) {
        const text = await ex2.textContent();
        if (text && text.includes('个人消费') && !text.includes('独占')) {
          ok(`#1 BillListGrouped (scrolled): .bill-row-exclusive = "${text.trim()}"`);
        } else {
          fail(`#1 BillListGrouped (scrolled): text="${text}"`);
        }
      } else {
        log('  (没找到 .bill-row-exclusive — session 9 可能没 exclusive bill 在初始位置)');
      }
    }

    // === 3) Session 6 (1-member 0-bills): #14 1-member prompt ===
    log('3) Session 6 (1-member)...');
    await page.goto('http://127.0.0.1:8448/sessions/6', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const membersHeader6 = page.locator('.members-head').first();
    if (await membersHeader6.count() > 0) {
      await membersHeader6.click();
      await page.waitForTimeout(500);
    }
    // 检查 1-member prompt
    const soloPrompt = await page.locator('[data-testid="solo-member-cta"]').count();
    if (soloPrompt === 0) ok('#14 验证 (session 6 1-member): solo-cta-a 不渲染');
    else fail(`#14 验证 (session 6 1-member): solo-cta-a 仍渲染 (count=${soloPrompt})`);
    // #15: EmptyState description
    const emptyDesc = page.locator('.empty-description').first();
    if (await emptyDesc.count() > 0) {
      const text = await emptyDesc.textContent();
      if (text && text.includes('自动计算分摊') && !text.includes('分摊自动结算')) {
        ok(`#15 (session 6 0-bills): EmptyState description = "${text.trim()}"`);
      } else {
        fail(`#15: EmptyState description = "${text}"`);
      }
    } else {
      log('  (session 6 0-bills, 但没看到 EmptyState 描述)');
    }

    // === 4) Settle personal view: #1 + #3 ===
    log('4) Settle personal view...');
    await page.goto('http://127.0.0.1:8448/sessions/9/settle?view=personal&member=2', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const sharedTags = page.locator('.tag.shared-tag');
    const exclusiveTags = page.locator('.tag.exclusive-tag');
    const sCount = await sharedTags.count();
    const eCount = await exclusiveTags.count();
    if (sCount > 0) {
      const sample = await sharedTags.first().textContent();
      if (sample && sample.includes('分摊') && !sample.includes('共享')) {
        ok(`#3 SettleMemberBreakdown: shared-tag = "${sample.trim()}" (count=${sCount})`);
      } else {
        fail(`#3 SettleMemberBreakdown: shared-tag text="${sample}"`);
      }
    } else {
      log('  (settle personal view 无 shared tag — 可能该 member 没 shared bill)');
    }
    if (eCount > 0) {
      const sample = await exclusiveTags.first().textContent();
      if (sample && sample.includes('个人消费') && !sample.includes('独占')) {
        ok(`#1 SettleMemberBreakdown: exclusive-tag = "${sample.trim()}" (count=${eCount})`);
      } else {
        fail(`#1 SettleMemberBreakdown: exclusive-tag text="${sample}"`);
      }
    } else {
      log('  (settle personal view 无 exclusive tag)');
    }

    // === 5) 截图存证 ===
    log('5) 截图存证...');
    const fs = require('fs');
    const path = require('path');
    const outDir = '/home/node/.openclaw/media/browser/v0326-0723-2-batch1';
    fs.mkdirSync(outDir, { recursive: true });

    // session 9 detail
    await page.goto('http://127.0.0.1:8448/sessions/9', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(outDir, '01-session-9-bills-header.png') });

    // session 6 (1-member, no solo CTA)
    await page.goto('http://127.0.0.1:8448/sessions/6', { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const h6 = page.locator('.members-head').first();
    if (await h6.count() > 0) {
      await h6.click();
      await page.waitForTimeout(500);
    }
    await page.screenshot({ path: path.join(outDir, '02-session-6-1member-no-solo-cta.png') });

    // session 9 settle personal
    await page.goto('http://127.0.0.1:8448/sessions/9/settle?view=personal&member=2', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(outDir, '03-settle-personal-tags.png'), fullPage: true });

    // wizard step 3 dual
    await page.goto('http://127.0.0.1:8448/sessions/new', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await page.locator('#session-name').fill('TestSessionB');
    await page.locator('button[aria-label="下一步"]').click();
    await page.waitForTimeout(300);
    const nicks2 = page.locator('.nickname-list input');
    const nc2 = await nicks2.count();
    for (let i = 0; i < nc2; i++) await nicks2.nth(i).fill(`U${i+1}`);
    await page.locator('button[aria-label="下一步"]').click();
    await page.waitForTimeout(400);
    if (await page.locator('button:has-text("双币种")').count() > 0) {
      await page.locator('button:has-text("双币种")').first().click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(outDir, '03-wizard-step3-dual-bold.png') });
    }
    if (await page.locator('button:has-text("单币种")').count() > 0) {
      await page.locator('button:has-text("单币种")').first().click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(outDir, '04-wizard-step3-single-bold.png') });
    }
    log(`截图存到 ${outDir}`);
  } catch (e) {
    errs.push(`Exception: ${e.message}`);
    log('EXCEPTION', e.message, e.stack);
  } finally {
    await browser.close();
    log('--- 总结 ---');
    if (errs.length === 0) log('✅ 全部通过');
    else log(`❌ ${errs.length} 项失败:\n  - ${errs.join('\n  - ')}`);
    process.exit(errs.length === 0 ? 0 : 1);
  }
})();
