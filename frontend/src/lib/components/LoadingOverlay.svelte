<script lang="ts">
  /**
   * v0.3.28 UAT 0724-1 #5 — LoadingOverlay (Option C: Glass Ring)
   *
   * PO 字面意图 (Jesse 2026-07-24 "帮我 design 玻璃质感的圆环加载页面"):
   *   "重新打开浏览器时, 都会展示页面, 然后自动刷新一次. 这样会误导用户
   *    以为一开始展示的页面是可以交互的. 能不能用一个有动画的可爱的风格
   *    一致的加载中页面, 来做过渡?"
   *   → 范围扩张: "事实上能不能给所有 加载中 页面都加上同样风格的动画?"
   *
   * 设计语言 (Option C = iOS 圆环 + Liquid Glass 材质合一):
   *   - 40×40 圆环 (iOS spinner 形状, 用户认知成本最低)
   *   - 玻璃材质: 透明背景 + 4 层 box-shadow 模拟 ring 厚度
   *     (inset 浅紫描边 + inset 高光 + inset 暗描边 + outer 紫光晕)
   *   - 顶部弧形 indigo active glow (radial gradient + 双层 box-shadow 发光)
   *     跟 .glass-ring 主体一起旋转, 让"加载感"比 iOS 默认 spinner 强
   *   - 900ms cubic-bezier(0.45, 0, 0.55, 1) 旋转 (缓入缓出, 比 linear 更"柔和")
   *   - 玻璃 pill (跟 Option B 同款) breathe 包"加载账单..."文案
   *     - 135deg rgba(255,255,255,0.78)→0.62 玻璃渐变
   *     - saturate 200% blur 24px backdrop-filter
   *     - inset highlight + 1px 白边 + 4px 灰外阴影
   *     - 2.4s scale 1→1.03→1 breathe (呼吸感)
   *
   * 两种 variant:
   *   - full (默认): 全屏 fixed overlay, 用于 page load + settle compute
   *   - inline: 行内 flex, 用于 bills list fetch + wizard step 过渡
   *
   * 可访问性:
   *   - role="status" + aria-live="polite" + aria-busy="true" (屏幕阅读器友好)
   *   - glass-ring aria-hidden="true" (装饰元素, 屏幕阅读器跳过)
   *   - prefers-reduced-motion: 全部动画停 (a11y + 用户偏好)
   *
   * 反模式 (绝对禁止):
   *   - ❌ 修改 +layout.svelte 现有布局 (只挂载 overlay, 不破坏 navbar/main)
   *   - ❌ 用 emoji 替代 SVG icon (Option C 设计明确用 CSS box-shadow 圆环)
   *   - ❌ 引入新 npm 包 (用 CSS keyframes + box-shadow)
   *   - ❌ 旋转动画 linear (cubic-bezier 缓入缓出更"可爱" 跟全站 spring 同源)
   *   - ❌ backdrop-filter blur > 24px (跟全站玻璃 20-28px 范围对齐)
   *
   * 排除范围 (本任务不修, 待后续 sprint):
   *   - dark mode 适配 (当前只 light mode #fafafa bg)
   *   - 各页自定义文案 (现在传 default "加载中...")
   */
  export let text: string = '加载中...';
  /** true = 行内变体 (用于 inline loading 状态), false = 全屏 overlay */
  export let inline: boolean = false;
</script>

{#if inline}
  <!-- v0.3.28 #5 inline variant: 行内 loading 状态 (e.g. wizard step 切换内嵌) -->
  <div class="loading-inline" role="status" aria-live="polite" aria-busy="true">
    <div class="glass-ring" aria-hidden="true"></div>
    <span class="text">{text}</span>
  </div>
{:else}
  <!-- v0.3.28 #5 full variant: 全屏 overlay (page load + settle compute) -->
  <div class="loading-overlay" role="status" aria-live="polite" aria-busy="true">
    <div class="glass-ring" aria-hidden="true"></div>
    <div class="loading-pill">
      <span class="text">{text}</span>
    </div>
  </div>
{/if}

<style>
  /* v0.3.28 UAT 0724-1 #5 (Option C 玻璃圆环): 跟全站 Liquid Glass token 同源.
   * 不引入新 design token — 用 indigo accent (#6366f1 / #4f46e5 / #4338ca /
   * #818cf8 / #3730a3) + 全站玻璃 rgba + saturate + blur 范围. */

  /* 主体圆环 — 透明背景 + 4 层 box-shadow 模拟 ring 厚度 */
  .glass-ring {
    position: relative;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: transparent;
    box-shadow:
      inset 0 0 0 4px rgba(99, 102, 241, 0.18),  /* ring 内圈描边 (浅紫) */
      inset 0 1px 0 4px rgba(255, 255, 255, 0.55), /* ring 顶部高光 (inset highlight) */
      inset 0 -1px 0 4px rgba(99, 102, 241, 0.08), /* ring 底部暗描边 */
      0 0 0 0.5px rgba(99, 102, 241, 0.35),  /* ring 外描边 (微细) */
      0 8px 24px rgba(99, 102, 241, 0.18),  /* 紫光晕主浮起 */
      0 1px 2px rgba(99, 102, 241, 0.10);   /* 紫光晕微投影 */
    animation: ringRotate 900ms cubic-bezier(0.45, 0, 0.55, 1) infinite;
    flex-shrink: 0;
  }
  /* 顶部 active glow — 8×8 紫球, 跟 .glass-ring 一起旋转
   * 让"加载感"比纯圆环强 (iOS 默认 spinner 没这个 active dot)
   * v0.3.0728-2 #1 — UAT 0728-2 #1 (PO msg 16:50) 加载动画层级修复:
   *   原 top: -1px 球在 .glass-ring 外环边缘, ::after 内环玻璃又盖在球上, 球被遮。
   *   修法: top: 0 (球在环上缘, 不出环) + z-index: 3 (永远在 ::after 内环玻璃 z-index: 1 之上).
   *   同时 ball box-shadow 加 indigo-700 (var(--accent-700)) 跟 .glass-ring inset highlight 同色系,
   *   视觉上是环上镶嵌一颗发光紫球, 不会被内玻璃挡. */
  .glass-ring::before {
    content: "";
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: radial-gradient(
      circle at 30% 30%,
      #818cf8 0%,    /* indigo-400 浅紫 */
      #4f46e5 60%,   /* indigo-600 主色 */
      #3730a3 100%   /* indigo-800 深紫 */
    );
    box-shadow:
      0 0 8px rgba(99, 102, 241, 0.6),   /* 近距发光 */
      0 0 16px rgba(99, 102, 241, 0.4);  /* 远距光晕 */
    z-index: 3;  /* 永远在 ::after inner glass (z-index 1) 之上 */
  }
  /* 内层玻璃质感 — 子元素承载 backdrop-filter (圆环本身 transparent)
   * v0.3.0728-2 #1: z-index: 1 让 .glass-ring::before ball (z-index: 3) 永远在 inner glass 之上. */
  .glass-ring::after {
    content: "";
    position: absolute;
    inset: 4px;
    border-radius: 50%;
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.55) 0%,
      rgba(165, 180, 252, 0.18) 100%
    );
    backdrop-filter: blur(4px) saturate(220%);
    -webkit-backdrop-filter: blur(4px) saturate(220%);
    z-index: 1;
  }
  @keyframes ringRotate {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }

  /* Full variant: 全屏 fixed overlay (page load + settle compute) */
  .loading-overlay {
    position: fixed;
    inset: 0;
    background: rgba(250, 250, 250, 0.65);
    backdrop-filter: blur(16px) saturate(180%);
    -webkit-backdrop-filter: blur(16px) saturate(180%);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 18px;
    z-index: 9999;
    /* navbar (z-index 1000) 之上, toast (z-index 9999) 同级 */
  }

  /* Inline variant: 行内 flex (wizard step 切换内嵌) */
  .loading-inline {
    display: inline-flex;
    align-items: center;
    gap: 12px;
  }

  /* 玻璃 pill (跟 Option B 同款 — 3 方案共享 pill 视觉, 设计语言一致) */
  .loading-pill {
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.78) 0%,
      rgba(255, 255, 255, 0.62) 100%
    );
    backdrop-filter: blur(24px) saturate(200%);
    -webkit-backdrop-filter: blur(24px) saturate(200%);
    border: 1px solid rgba(255, 255, 255, 0.78);
    border-radius: 999px;
    padding: 10px 20px;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.9),  /* 顶部高光 */
      0 4px 16px rgba(15, 23, 42, 0.06);      /* 灰外阴影 */
    display: flex;
    align-items: center;
    gap: 10px;
    animation: cardBreathe 2.4s ease-in-out infinite;
  }
  @keyframes cardBreathe {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.03); }
  }

  .text {
    font-size: 14px;
    font-weight: 500;
    color: #4338ca;  /* indigo-700, 跟全站 accent-700 token 同 */
    letter-spacing: -0.005em;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", system-ui, sans-serif;
  }

  /* v0.3.28 #5 (a11y): prefers-reduced-motion 禁用全部动画 */
  @media (prefers-reduced-motion: reduce) {
    .glass-ring { animation: none; }
    .glass-ring::before { opacity: 0.7; }
    .loading-pill { animation: none; }
  }
</style>