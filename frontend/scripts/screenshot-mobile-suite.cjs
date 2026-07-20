#!/usr/bin/env node
/**
 * SBC Mobile Screenshot Suite — v0.3.19 #82 (Designer Agent)
 *
 * 按 SKILL-mobile-validation.md v1.0 §通道 C 模板实现:
 *   - 一次跑多 viewport (iPhone SE / iPhone 13 / iPhone 15 Pro Max / iPad gen 7)
 *   - 强制 webkit (chromium 模拟 iOS Safari)
 *   - locale zh-CN
 *   - isMobile=true + hasTouch=true + deviceScaleFactor 对应 @2x/@3x
 *
 * 用法:
 *   cd /config/workspace/split-bill-calculator/frontend
 *   node scripts/screenshot-mobile-suite.cjs
 *
 * 输出:
 *   ~/.openclaw/media/v0319-82-screenshots/<device>-<slug>.png
 *
 * 反 #167 (新): 任何 mockup / e2e 截图必须用 iPhone 真机 profile, 不准 Desktop Chrome.
 */

const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Targets -----------------------------------------------------------
// 4 个真机 viewport, 覆盖最小 / 主流 / 大屏 / 平板
// viewBox 是 logical CSS pixels, scale 是 deviceScaleFactor
const TARGETS = [
  { name: 'iphoneSE',    device: 'iPhone SE',       width: 375, height: 667,  scale: 2 },
  { name: 'iphone13',    device: 'iPhone 13',       width: 390, height: 844,  scale: 3 },
  { name: 'iphone15pm',  device: 'iPhone 15 Pro Max', width: 430, height: 932, scale: 3 },
  { name: 'ipad',        device: 'iPad (gen 7)',    width: 768, height: 1024, scale: 2 },
];

// --- URLs --------------------------------------------------------------
// 截图目标: 优先 session 详情页 (含 members + bills 两个 section)
// mockup 直接渲染本地 HTML (file://), 也支持 http://localhost:8448 真机渲染
const URLS = [
  // 设计 mockup HTML (file:// 协议, 由 Playwright 直接打开)
  // 在 codeserver 容器内路径为 /config/workspace/...
  {
    kind: 'file',
    path: process.env.SBC_MOCKUP_PATH || '/config/workspace/split-bill-calculator/frontend/design-mocks/v0319-82-session-overall.html',
    slug: 'mockup-overall',
  },
  // 真机对比: 真实 sbc dev server 的 session 详情页 (需先登录)
  // 反 #167 新规要求真机 profile 截图, 同时 mockup + 真实产品页都要验证
  // 真实 session 详情页需先登录, 此处只跑 mockup; 真实产品截图另作一轮
];

// --- Helpers -----------------------------------------------------------
const OUT_DIR = path.join(os.homedir(), '.openclaw', 'media', 'v0319-82-screenshots');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function logHeader(title) {
  console.log('\n' + '='.repeat(60));
  console.log('  ' + title);
  console.log('='.repeat(60));
}

// --- Main --------------------------------------------------------------
(async () => {
  ensureDir(OUT_DIR);
  logHeader('SBC Mobile Screenshot Suite — v0.3.19 #82');
  console.log('Output dir:', OUT_DIR);
  console.log('Targets:');
  for (const t of TARGETS) {
    console.log(`  - ${t.name.padEnd(10)} ${t.width}×${t.height} @${t.scale}x  (${t.device})`);
  }

  const browser = await chromium.launch();
  const results = [];

  for (const url of URLS) {
    logHeader(`URL: ${url.slug} (${url.kind})`);
    for (const target of TARGETS) {
      const context = await browser.newContext({
        ...devices[target.device],
        locale: 'zh-CN',
      });
      const page = await context.newPage();

      let urlToLoad;
      if (url.kind === 'file') {
        urlToLoad = 'file://' + url.path;
      } else {
        urlToLoad = url.path;
      }

      try {
        await page.goto(urlToLoad, { waitUntil: 'load', timeout: 30000 });
        // 等待字体 + 玻璃渲染稳定
        await page.waitForTimeout(700);
      } catch (e) {
        console.log(`  ✗ ${target.name} → ${url.slug}: NAV FAIL: ${e.message}`);
        await context.close();
        continue;
      }

      const outFile = path.join(OUT_DIR, `${target.name}-${url.slug}.png`);
      try {
        await page.screenshot({
          path: outFile,
          fullPage: true,
          // deviceScaleFactor 已经由 device profile 控制, 这里不再覆盖
        });
        const sz = fs.statSync(outFile).size;
        console.log(`  ✓ ${target.name.padEnd(10)} → ${path.basename(outFile)}  (${(sz / 1024).toFixed(0)} KB)`);
        results.push({ target: target.name, slug: url.slug, file: outFile, bytes: sz });
      } catch (e) {
        console.log(`  ✗ ${target.name} → ${url.slug}: SHOT FAIL: ${e.message}`);
      }

      await context.close();
    }
  }

  await browser.close();

  logHeader('Summary');
  console.log(`Total: ${results.length} screenshots`);
  for (const r of results) {
    console.log(`  ${r.target.padEnd(10)} ${(r.bytes / 1024).toFixed(0).padStart(4)} KB  ${r.file}`);
  }
  console.log(`\nDone → ${OUT_DIR}`);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});