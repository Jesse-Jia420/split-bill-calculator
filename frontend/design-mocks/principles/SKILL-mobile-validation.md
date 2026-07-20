# SBC Mobile Validation Spec (v1.0) — 真机验证规范

> **目的**: 解决 v0.3.18 #73 反复翻车 ("字面执行 token 但视觉烂") 的根因 — **没有真机尺寸验证**
> **作者**: Master (Jesbun / 贾馍)
> **起草时间**: 2026-07-21
> **状态**: v1.0 — 强制执行

---

## 🎯 核心问题

### v0.3.18 #73 翻车根因 (PO 反馈 "你没有用手机的尺寸验证")

Coder 在 codeserver 容器里跑 playwright 默认是 **Desktop Chrome**：
- ❌ 桌面视口渲染 (默认 1280×720)
- ❌ 鼠标点击 (8px 命中, 不测 44pt touch target)
- ❌ 1px 边框 (真 retina @3x 变 0.33px, 颜色变灰)
- ❌ 字体渲染 (桌面 chrome subpixel, iOS Safari grayscale)
- ❌ safe-area (iOS notch/home indicator)
- ❌ -webkit-overflow-scrolling (iOS 滚动弹性)

**结果**: 我写"真机验证"截图全是 desktop Chrome, **不是真手机**. 等于没验证.

---

## 📐 真机验证规范 (强制)

### 1. 必须用 iPhone 真机 profile

**强制配置** (`frontend/playwright.config.ts` projects):

```typescript
projects: [
  { name: "iphone13", use: { ...devices["iPhone 13"] } },     // 390×844 @3x
  { name: "iphoneSE", use: { ...devices["iPhone SE"] } },     // 375×667 @2x (旧 iPhone 基准)
  { name: "ipad",    use: { ...devices["iPad (gen 7)"] } },    // 768×1024 @2x (平板)
],
```

**Device 关键参数** (Playwright `devices['iPhone 13']`):

| 参数 | 值 | 意义 |
|------|----|------|
| viewport | 390×844 | logical CSS pixels |
| deviceScaleFactor | 3 | retina @3x |
| userAgent | "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0...)" | iOS Safari UA |
| isMobile | true | 触发移动端媒体查询 |
| hasTouch | true | 启用 touch events |
| defaultBrowserType | "webkit" | 强制 webkit, 不是 chromium |

### 2. Mockup 截图必含 3 个 viewport

| Viewport | 文件名后缀 | 用途 |
|----------|----------|------|
| 375×667 (iPhone SE) | `-375.png` | **最小真机基准** — 必须过 |
| 390×844 (iPhone 13) | `-375.png` (主流) | 默认 iPhone 真机 |
| 768×1024 (iPad) | `-768.png` | 平板 |

**@2x 或 @3x 输出**: iPhone 13 devicePixelRatio=3, 截图 390×844 输出 1170×2532 PNG

### 3. 必含 iOS Chrome

**不可省** (否则视觉看着假):

```html
<style>
  /* iOS status bar (Dynamic Island) — top safe area */
  .ios-status-bar {
    position: sticky; top: 0;
    height: env(safe-area-inset-top, 47px);
    background: rgba(255,255,255,0.001); /* transparent */
  }
  /* iOS home indicator — bottom safe area */
  .ios-home-indicator {
    position: sticky; bottom: 0;
    height: env(safe-area-inset-bottom, 34px);
    /* 中心横条 */
  }
  .ios-home-indicator::after {
    content: ""; display: block;
    width: 134px; height: 5px; border-radius: 3px;
    background: #000; opacity: 0.85;
    margin: 21px auto 8px;
  }
</style>

<body>
  <div class="ios-status-bar"></div>
  <main>... 内容 ...</main>
  <div class="ios-home-indicator"></div>
</body>
```

### 4. 触摸目标 ≥ 44pt (iOS HIG)

**强制**: 任何可点击元素 `min-height: 44px` + `min-width: 44px` + `padding: 12px+`.

```css
.ppt-toggle, .chip, .link-btn {
  min-height: 44px;        /* iOS HIG 强制 */
  min-width:  44px;
  padding: 12px;
  /* 不是 min-height: 32px + padding: 4px 那样的设计 token */
}
```

### 5. 字体渲染一致性

| 桌面 Chromium | iOS Safari | 影响 |
|---------------|------------|------|
| subpixel antialiasing | grayscale antialiasing | 字体看着细一点 |
| -webkit-font-smoothing: auto | antialiased | text-shadow 处理不同 |

**强制测试**: 所有 mockup 必须在 iPhone 真机 profile 截图, 不能 desktop Chrome.

---

## 🛠 真机验证通道 (技术实现)

### 通道 A — Playwright 真机 emulation (推荐)

```javascript
// frontend/scripts/screenshot-iphone.js
import { chromium, devices } from 'playwright';

const browser = await chromium.launch();
const context = await browser.newContext({
  ...devices['iPhone 13'],
  locale: 'zh-CN',
});
const page = await context.newPage();
await page.goto('http://localhost:8448/sessions/12', { waitUntil: 'networkidle' });
await page.screenshot({ path: '~/.openclaw/media/v0319-81/session-12-iphone13.png', fullPage: true });
await browser.close();
```

### 通道 B — Vite 真机 + remote debugging

```bash
# Vite 启动时 (already running on port 8448):
vite --host 0.0.0.0 --port 8448

# 外部连接 (codeserver 内):
# Vite 启动后会 listen 0.0.0.0:8448, 通过 codeserver proxy 暴露
# 真手机可通过 codeserver WebView (有 chromium-arm64 container 在 port 3004) 访问

# 或用 codeserver 内 chromium 远程调试:
chromium --headless --disable-gpu --remote-debugging-port=9222
# 然后用 Playwright `chromium.connectOverCDP('http://localhost:9222')`
```

### 通道 C — 截图脚本 (一次跑多 viewport)

**文件**: `frontend/scripts/screenshot-mobile-suite.cjs`

```javascript
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const TARGETS = [
  { name: 'iphoneSE',  device: 'iPhone SE',    width: 375, scale: 2 },
  { name: 'iphone13',  device: 'iPhone 13',    width: 390, scale: 3 },
  { name: 'iphone15pm',device: 'iPhone 15 Pro Max', width: 430, scale: 3 },
  { name: 'ipad',      device: 'iPad (gen 7)', width: 768, scale: 2 },
];

const URLS = [
  '/sessions/12',
  '/sessions/11',
  '/sessions/12/settle',
  '/sessions/12/bills/new',
];

(async () => {
  const browser = await chromium.launch();
  for (const target of TARGETS) {
    const context = await browser.newContext({
      ...devices[target.device],
      locale: 'zh-CN',
    });
    const page = await context.newPage();
    for (const url of URLS) {
      await page.goto(`http://localhost:8448${url}`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(500);
      const file = `~/.openclaw/media/v0319-mobile/${target.name}-${url.replace(/[\/:]/g, '_')}.png`;
      await page.screenshot({ path: file, fullPage: true });
      console.log(`✓ ${file}`);
    }
    await context.close();
  }
  await browser.close();
})();
```

**用法**:
```bash
cd /config/workspace/split-bill-calculator/frontend
node scripts/screenshot-mobile-suite.cjs
```

---

## ✅ Coder 真机验证 checklist (反 #150 续)

Coder 报"完成"前必跑:

```bash
cd /config/workspace/split-bill-calculator/frontend

# 1. 跑真机截图套件
node scripts/screenshot-mobile-suite.cjs

# 2. 手动看图 (在 OpenClaw media 目录)
ls -lt ~/.openclaw/media/v0319-mobile/

# 3. 视觉自查 (Master 真用户 walk)
# 必查项:
# - [ ] touch target ≥ 44pt? (iOS HIG)
# - [ ] 1px 边框在 @3x 不变灰? (用 retina 真机或 @2x 模拟)
# - [ ] safe-area 正确? (顶部 status bar, 底部 home indicator)
# - [ ] 字体不糊? (iOS Safari grayscale AA)
# - [ ] scroll 弹性? (-webkit-overflow-scrolling: touch)
# - [ ] 配色 iOS 看着协调? (不要饱和度爆表)

# 4. 报告时附:
# - 至少 1 张 iPhone 真机截图 (375 或 390)
# - 不是 desktop Chrome 截图
```

---

## 📂 关键路径

| 项 | 路径 |
|------|------|
| 真机截图输出 | `~/.openclaw/media/v0319-mobile/` (或 `/home/node/.openclaw/media/v0319-mobile/`) |
| 真机截图脚本 | `frontend/scripts/screenshot-mobile-suite.cjs` |
| iPhone 13 device config | `playwright.devices['iPhone 13']` |
| 关联文档 | `SKILL-design-principles.md` v0.1 (原则 1-8) |

---

## 🪞 反模式 (硬性禁止)

| 反模式 | 触发 |
|--------|------|
| ❌ 用 Desktop Chrome 截图报"真机验证" | 任何 commit/push 前 |
| ❌ 写 `min-height: 32px` 当默认 touch target | 任何 interactive 元素 |
| ❌ 1px 边框无 retina 适配 | 真机看着变 0.33px 灰线 |
| ❌ 省略 iOS status bar / home indicator | mockup 看着假 |
| ❌ 用 fixed viewport `375×667` 当设计基准 | 应该用 `min-width: 320px` mobile-first |
| ❌ `direction: rtl` 当头像堆叠技巧 | Svelte 模板不兼容 |
| ❌ 配色饱和度 > 70% (看着扎眼) | iOS 偏好低饱和 |

---

## 📋 强制执行时间表

| 时机 | 动作 |
|------|------|
| **#82 Designer 出图前** | 读本规范 + 用 iPhone 真机截图 |
| **#82 Coder 落地前** | 跑真机截图套件, 自查 checklist |
| **Master 真用户 walk** | OpenClaw media 看 iPhone 截图 (不是 Desktop Chrome) |
| **PO 验收前** | 必附至少 1 张 iPhone 真机截图 |

---

## 🔗 关联文档

- **SKILL-design-principles.md v0.1** — 8 条视觉原则 (信息层级 / 密度 / 负空间 / 颜色 / 头像 / affordance / iOS 参照 / 反 token)
- **本规范 v1.0** — 真机验证 (本文件, 附录 9)
- **未来 v1.1** — 增加 iPad 真机 + 横屏 + 暗黑模式

---

_作者: Master Jesbun, 2026-07-21_
_关联 commit: 7b1faee (#73 烂) → afa53453 (revert)_
_关联反模式: 反 #150 续, 反 #164 (视觉烂伪装成 bug fix)_