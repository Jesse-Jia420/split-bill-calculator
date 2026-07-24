#!/usr/bin/env node
/**
 * SBC Real Session Page Screenshot — v0.3.19 #83 (Coder Agent)
 *
 * 目标: 反 #167 强制真机 profile 截图 (iPhone 13 + iPhone SE)
 * 流程: 登录 → /sessions/11 + /sessions/12 → 折叠态 / 展开态各一张
 * 输出: ~/.openclaw/media/v0319-83/<device>-<slug>.png
 */

const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const OUT_DIR = path.join(os.homedir(), '.openclaw', 'media', 'v0319-83');
// OpenClaw container → codeserver 容器 走 1panel-network 直接 IP
const BASE_URL = process.env.SBC_BASE_URL || 'http://172.18.0.5:8448';

const DEVICES = [
  { name: 'iphone13', device: 'iPhone 13', width: 390, height: 844 },
  { name: 'iphoneSE', device: 'iPhone SE', width: 375, height: 667 },
];

const SESSIONS = [
  { id: 11, slug: 'sessions-11', desc: '泰国测试账单 6.19-6.22 (多人)' },
  { id: 12, slug: 'sessions-12', desc: '个人测试 (单人)' },
];

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

async function login(context) {
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(800);
  // 填 email
  await page.fill('input[type="email"]', 'xinhua1001@outlook.com');
  await page.waitForTimeout(300);
  // 点击发送验证码按钮 (on:click={handleSend}, 不是 type=submit)
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const send = btns.find(b => /发送|send|登录/i.test(b.textContent || ''));
    if (send) send.click();
  });
  await page.waitForTimeout(1500);
  // 输入 6 位 code
  await page.fill('input[inputmode="numeric"]', '000000');
  await page.waitForTimeout(300);
  // 点击验证按钮 (on:click={handleVerify})
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const verify = btns.find(b => /验证|登录|verify/i.test(b.textContent || ''));
    if (verify) verify.click();
  });
  await page.waitForTimeout(2500);
  await page.close();
}

async function shootSession(context, sessionId, device, expanded) {
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/sessions/${sessionId}`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1200);

  // 切换 members 展开/折叠
  if (expanded) {
    // 默认折叠, 需要点击 header 展开
    await page.evaluate(() => {
      const header = document.querySelector('.members-head');
      if (header && header.getAttribute('aria-expanded') === 'false') {
        header.click();
      }
    });
    await page.waitForTimeout(600);
  } else {
    // 确保折叠: 如果已展开, 点一次收起
    await page.evaluate(() => {
      const header = document.querySelector('.members-head');
      if (header && header.getAttribute('aria-expanded') === 'true') {
        header.click();
      }
    });
    await page.waitForTimeout(400);
  }

  const state = expanded ? 'expanded' : 'collapsed';
  const outFile = path.join(OUT_DIR, `${device.name}-${sessionId}-${state}.png`);
  // 视口截图 (只看 members section, 不滚动到底)
  await page.screenshot({ path: outFile, fullPage: false });
  const sz = fs.statSync(outFile).size;
  console.log(`  ✓ ${device.name} session/${sessionId} ${state} → ${path.basename(outFile)} (${(sz / 1024).toFixed(0)} KB)`);
  await page.close();
  return { file: outFile, bytes: sz };
}

(async () => {
  ensureDir(OUT_DIR);
  console.log('Output dir:', OUT_DIR);

  const browser = await chromium.launch();
  const allResults = [];

  for (const device of DEVICES) {
    console.log(`\n=== ${device.name} (${device.width}×${device.height}) ===`);
    const context = await browser.newContext({
      ...devices[device.device],
      locale: 'zh-CN',
    });
    // 登录一次, 后续页面共享 cookie
    await login(context);

    for (const s of SESSIONS) {
      console.log(`  → ${s.slug}: ${s.desc}`);
      // 折叠态
      const c = await shootSession(context, s.id, device, false);
      allResults.push({ device: device.name, session: s.id, state: 'collapsed', ...c });
      // 展开态
      const e = await shootSession(context, s.id, device, true);
      allResults.push({ device: device.name, session: s.id, state: 'expanded', ...e });
    }

    await context.close();
  }

  await browser.close();

  console.log('\n=== Summary ===');
  for (const r of allResults) {
    console.log(`  ${r.device.padEnd(10)} session/${r.session} ${r.state.padEnd(10)} (${(r.bytes / 1024).toFixed(0).padStart(4)} KB)  ${r.file}`);
  }
  console.log(`\nTotal: ${allResults.length} screenshots → ${OUT_DIR}`);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});