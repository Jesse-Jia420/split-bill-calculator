// Regenerate 4-up comparison with proper iframe height (no scroll, full mockup visible)
const { chromium } = require('/config/workspace/split-bill-calculator/frontend/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const MOCKUPS_DIR = '/config/workspace/split-bill-calculator/frontend/design-mocks';
const SHOTS_DIR = path.join(MOCKUPS_DIR, 'screenshots');

const BASE_URL = 'http://127.0.0.1:8450';

const buildComparisonHtml = (variants, title) => {
  const panels = variants.map((v) => `
    <div class="panel">
      <div class="panel-label ${v.danger ? 'danger' : ''}">${v.label}</div>
      <div class="panel-frame">
        <iframe src="${BASE_URL}/v0318-68-bills-header-${v.file}.html" frameborder="0" scrolling="no"></iframe>
      </div>
    </div>
  `).join('');

  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  :root { --bg: #f2f3f7; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif; -webkit-font-smoothing: antialiased; }
  .wrap { padding: 28px 32px; }
  h1 { font-size: 26px; font-weight: 800; color: #0f172a; margin: 0 0 4px 0; letter-spacing: -0.5px; }
  .crumb { font-size: 12.5px; color: #64748b; margin-bottom: 24px; letter-spacing: 0.02em; font-weight: 500; }
  .grid { display: grid; grid-template-columns: repeat(${variants.length}, 1fr); gap: 18px; align-items: start; }
  .panel { background: #fff; border: 1px solid rgba(15,23,42,0.08); border-radius: 22px; padding: 14px; box-shadow: 0 4px 16px rgba(15,23,42,0.05); overflow: hidden; }
  .panel-label { font-size: 14px; font-weight: 800; color: #4338ca; padding: 6px 14px; background: rgba(99,102,241,0.10); border-radius: 999px; display: inline-block; margin-bottom: 12px; letter-spacing: 0.02em; }
  .panel-label.danger { color: #b91c1c; background: rgba(254,226,226,0.65); }
  .panel-label.gold { color: #92400e; background: rgba(254,243,199,0.85); }
  .panel-frame { width: 100%; height: 1340px; border-radius: 14px; overflow: hidden; }
  iframe { width: 100%; height: 100%; border: 0; display: block; }
</style>
</head>
<body>
<div class="wrap">
  <div class="crumb">v0.3.18 #68 · PO #6865 #3 反馈: 账单列表时间 header 单/双币排版混乱</div>
  <h1>账单列表时间 header · 4 方案同框对比 (375px)</h1>
  <div class="grid">${panels}</div>
</div>
</body></html>`;
};

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  const comparisonHtml = buildComparisonHtml([
    { file: 'CURRENT', label: '❌ CURRENT · 现状 (PO 觉得混乱)', danger: true },
    { file: 'A', label: '★ A · 固定 3 行 + chip (推荐)', gold: true },
    { file: 'B', label: '○ B · 主币大 + 副币 compact' },
    { file: 'C', label: '○ C · 镜像 header + chip 行' },
  ], '账单列表时间 header · 4 方案同框对比 (375px)');

  const compPath = path.join(MOCKUPS_DIR, 'v0318-68-comparison.html');
  fs.writeFileSync(compPath, comparisonHtml);
  console.log('wrote ' + compPath);

  const ctx = await browser.newContext({ viewport: { width: 1800, height: 1500 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto('file://' + compPath, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(SHOTS_DIR, 'v0318-68-bills-header-comparison-4up.png'), fullPage: true });
  console.log('saved comparison shot');
  await ctx.close();

  await browser.close();
  console.log('done');
})().catch(e => { console.error('FATAL', e); process.exit(1); });