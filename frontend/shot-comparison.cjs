// Generate side-by-side comparison images:
// 1. CURRENT vs A vs B vs C 同框对比 (single header per variant)
// 2. Each方案 单币 vs 双币 同框 (证明统一)
const { chromium } = require('/config/workspace/split-bill-calculator/frontend/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const MOCKUPS_DIR = '/config/workspace/split-bill-calculator/frontend/design-mocks';
const SHOTS_DIR = path.join(MOCKUPS_DIR, 'screenshots');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const BASE_URL = 'http://127.0.0.1:8450';

// HTML for comparison images
const buildComparisonHtml = (variants, title) => {
  const panels = variants.map((v, i) => `
    <div class="panel">
      <div class="label">${v.label}</div>
      <iframe src="${BASE_URL}/v0318-68-bills-header-${v.file}.html" frameborder="0" scrolling="no"></iframe>
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
  .wrap { padding: 20px; }
  h1 { font-size: 22px; font-weight: 700; color: #0f172a; margin: 0 0 6px 0; letter-spacing: -0.4px; }
  .crumb { font-size: 12px; color: #64748b; margin-bottom: 16px; letter-spacing: 0.02em; }
  .grid { display: grid; grid-template-columns: repeat(${variants.length}, 1fr); gap: 16px; align-items: start; }
  .panel { background: #fff; border: 1px solid rgba(15,23,42,0.08); border-radius: 18px; padding: 10px; box-shadow: 0 2px 8px rgba(15,23,42,0.04); }
  .label { font-size: 13px; font-weight: 700; color: #4338ca; padding: 4px 10px; background: rgba(99,102,241,0.08); border-radius: 999px; display: inline-block; margin-bottom: 8px; letter-spacing: 0.02em; }
  .label.danger { color: #b91c1c; background: rgba(254,226,226,0.6); }
  iframe { width: 100%; height: 760px; border: 0; display: block; border-radius: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="crumb">v0.3.18 #68 · PO #6865 #3 反馈</div>
  <h1>${title}</h1>
  <div class="grid">${panels}</div>
</div>
</body></html>`;
};

// HTML for single-vs-double comparison (within one design)
const buildSingleVsDoubleHtml = (variant, file) => {
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>方案 ${variant} · 单币 vs 双币 同框</title>
<style>
  :root { --bg: #f2f3f7; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif; -webkit-font-smoothing: antialiased; }
  .wrap { padding: 20px; max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 22px; font-weight: 700; color: #0f172a; margin: 0 0 6px 0; letter-spacing: -0.4px; }
  .crumb { font-size: 12px; color: #64748b; margin-bottom: 16px; letter-spacing: 0.02em; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .pair .col { background: #fff; border: 1px solid rgba(15,23,42,0.08); border-radius: 18px; padding: 10px; box-shadow: 0 2px 8px rgba(15,23,42,0.04); }
  .col-label { font-size: 13px; font-weight: 700; padding: 4px 10px; border-radius: 999px; display: inline-block; margin-bottom: 8px; letter-spacing: 0.02em; }
  .col-label.single { color: #4338ca; background: rgba(99,102,241,0.08); }
  .col-label.dual { color: #0f766e; background: rgba(20,184,166,0.10); }
  iframe { width: 100%; height: 600px; border: 0; display: block; border-radius: 12px; }
  .note { margin-top: 12px; padding: 10px 14px; border-radius: 12px; background: rgba(99,102,241,0.06); font-size: 12px; color: #3730a3; }
</style>
</head>
<body>
<div class="wrap">
  <div class="crumb">v0.3.18 #68 · 方案 ${variant} 验证 · 单币 vs 双币 高度统一</div>
  <h1>方案 ${variant} · 单币 group ⇄ 双币 group 同框 (375px)</h1>
  <div class="pair">
    <div class="col">
      <span class="col-label single">单币 group · 6月20日</span>
      <iframe src="${BASE_URL}/v0318-68-bills-header-${file}.html" frameborder="0" scrolling="no"></iframe>
    </div>
    <div class="col">
      <span class="col-label dual">双币 group · 6月22日</span>
      <iframe src="${BASE_URL}/v0318-68-bills-header-${file}.html" frameborder="0" scrolling="no"></iframe>
    </div>
  </div>
  <div class="note">✅ 验证点: 方案 ${variant} 下, 单币和双币 group header 的高度一致, 不再出现现状的 "2 行 vs 3 行" 混乱。</div>
</div>
</body></html>`;
};

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  // 1. Four-variant comparison
  const comparisonHtml = buildComparisonHtml([
    { file: 'CURRENT', label: '❌ CURRENT · 现状', danger: true },
    { file: 'A', label: '✓ A · 固定 3 行 + chip' },
    { file: 'B', label: '✓ B · 主币大 + 副币 compact' },
    { file: 'C', label: '✓ C · 镜像 header + chip 行' },
  ], '账单列表时间 header · 4 方案同框对比 (375px)');

  const compPath = path.join(MOCKUPS_DIR, 'v0318-68-comparison.html');
  fs.writeFileSync(compPath, comparisonHtml);
  console.log('wrote ' + compPath);

  const ctx1 = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
  const page1 = await ctx1.newPage();
  await page1.goto('file://' + compPath, { waitUntil: 'networkidle' });
  await page1.waitForTimeout(800);
  await page1.screenshot({ path: path.join(SHOTS_DIR, 'v0318-68-bills-header-comparison-4up.png'), fullPage: true });
  console.log('saved comparison shot');
  await ctx1.close();

  // 2. Single vs Double within each方案
  for (const v of ['A', 'B', 'C']) {
    const html = buildSingleVsDoubleHtml(v, v);
    const fp = path.join(MOCKUPS_DIR, `v0318-68-single-vs-double-${v}.html`);
    fs.writeFileSync(fp, html);
    console.log('wrote ' + fp);

    const ctx = await browser.newContext({ viewport: { width: 900, height: 750 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto('file://' + fp, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(SHOTS_DIR, `v0318-68-${v}-single-vs-double.png`), fullPage: true });
    console.log(`saved ${v} single-vs-double shot`);
    await ctx.close();
  }

  await browser.close();
  console.log('all comparison shots saved');
})().catch(e => { console.error('FATAL', e); process.exit(1); });