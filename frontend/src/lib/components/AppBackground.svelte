<script lang="ts">
  /**
   * v0.3.18 #47 (PO msg 18:15 #3): 玻璃背景图集成。
   *
   * 思路:
   * - fixed position 全屏, z-index: -1 (在所有内容之下)
   * - background-image: linear-gradient fallback (image load 延迟 / fail 时)
   *   透过 fallback bg 让 AppBackground 占位, 不闪白
   * - 加载 glass-bg.jpg 真实图片 (minimax/image-01 生成, light indigo gradient)
   * - 图片加载失败时 fallback 到 linear-gradient
   * - 加 0.04 noise overlay (data-uri SVG noise), 让 glass backdrop-filter
   *   模糊时有质感, 避免大面积纯色玻璃失去材质
   *
   * 注意:
   * - 必须放 <slot/> 之前, 作为 body 第一层 (见 +layout.svelte)
   * - z-index: -1 + position: fixed 不占文档流, 但会触发 GPU 合成层
   * - body bg 在 app.css 保留 linear-gradient fallback 作为 image-load 期间占位
   * - 用 plain let + onMount, 不引入 $state, 跟项目其它 legacy 组件一致
   */
  import { onMount } from 'svelte';

  let imgLoaded = false;
  let imgFailed = false;

  onMount(() => {
    // 探测图片是否能加载成功 (避免 background-image 自然 fail 时 fall back 到 noise + gradient)
    const probe = new Image();
    probe.onload = () => { imgLoaded = true; };
    probe.onerror = () => { imgFailed = true; };
    probe.src = '/glass-bg.jpg';
  });
</script>

<!-- 玻璃背景图层: fixed 全屏, z-index: -1 在所有内容之下 -->
<div class="app-bg" class:loaded={imgLoaded} class:failed={imgFailed} aria-hidden="true">
  <!-- noise overlay: 0.04 不透明度 SVG turbulence, 让玻璃模糊时仍有质感 -->
  <svg
    class="noise"
    xmlns="http://www.w3.org/2000/svg"
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    <filter id="noise-filter">
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch" />
      <feColorMatrix type="saturate" values="0" />
    </filter>
    <rect width="100%" height="100%" filter="url(#noise-filter)" opacity="0.5" />
  </svg>
</div>

<style>
  /* v0.3.18 #47: 玻璃背景图。
     z-index: -1 + position: fixed 把它放到 body 之下,
     不参与布局 (不撑高 body, 不影响 main flex column 滚动). */
  .app-bg {
    position: fixed;
    inset: 0;
    z-index: -1;
    width: 100vw;
    height: 100dvh;
    /* fallback: linear-gradient (image 加载延迟 / 失败时显示)。
       跟 v0.3.16 之前的 nav-bg 同款, indigo 浅蓝紫基调。 */
    background: linear-gradient(180deg, #f0f5ff 0%, #e0e7ff 100%);
    pointer-events: none;
    overflow: hidden;
    /* GPU 加速 (避免 z-index: -1 触发重绘抖动) */
    will-change: transform;
    transform: translateZ(0);
  }
  /* 图片加载成功 → 叠在 fallback 之上 (cover 全屏, 居中)。
     cover 模式会裁剪超出比例部分 — 16:9 图在 mobile 9:16 viewport 上会
     裁掉左右, 但 glass blur 模糊后看不出构图, 不影响视觉。 */
  .app-bg.loaded {
    background-image: url('/glass-bg.jpg');
    background-size: cover;
    background-position: center;
    background-repeat: no-repeat;
  }
  /* 图片加载失败 → 保留 fallback (不做 img 重试, 让 fallback 永久生效) */
  .app-bg.failed {
    background: linear-gradient(180deg, #f0f5ff 0%, #e0e7ff 100%);
  }
  /* noise overlay: SVG 蒙版做 0.04 不透明度 fractalNoise,
     给玻璃 backdrop-filter 模糊时增加质感颗粒。
     用 SVG 而非 PNG 是为了 file-size + 可缩放。 */
  .noise {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0.04;
    pointer-events: none;
    mix-blend-mode: overlay;
  }
</style>