<script lang="ts">
  /**
   * v0.3.20 #97 (PO msg 13:24 #7503): 整站加背景图 — 用 textured-paper.jpg
   * (subtle white paper texture, 1700×2200, ~640KB) 作为 app 内页面静态
   * 背景图, 不可改.
   *
   * 历史:
   * - v0.3.18 #47 (PO msg 18:15 #3): 玻璃背景图集成 (玻璃 noise overlay)
   * - v0.3.18 #51 (PO msg 23:17 #6526): 整站去背景图
   * - v0.3.20 #97 (PO msg 13:24 #7503): 加回背景图, 但换 paper texture
   *   (玻璃换成纸张) — paper 自带纹理, 不需要 noise overlay 二次加噪
   *
   * 思路 (跟 v0.3.18 #47 一致, 但 3 处改动):
   * - fixed position 全屏, z-index: -1 (在所有内容之下)
   * - background-image: paper-white fallback (image load 延迟 / fail 时)
   *   透过 fallback 让 AppBackground 占位, 不闪白
   * - 加载 textured-paper.jpg 真实图片
   * - 图片加载失败时 fallback 到 paper-white gradient
   * - **去掉 noise overlay** — paper 自带纹理, 加 noise 反而糊掉细节
   *
   * 注意:
   * - 必须放 <slot/> 之前, 作为 body 第一层 (见 +layout.svelte)
   * - z-index: -1 + position: fixed 不占文档流, 但会触发 GPU 合成层
   * - body bg 在 app.css 保留 paper-white fallback 作为 image-load 期间占位
   */
  import { onMount } from 'svelte';

  let imgLoaded = false;
  let imgFailed = false;

  onMount(() => {
    // 探测图片是否能加载成功 (避免 background-image 自然 fail 时 fall back 到 noise + gradient)
    const probe = new Image();
    probe.onload = () => { imgLoaded = true; };
    probe.onerror = () => { imgFailed = true; };
    probe.src = '/textured-paper.jpg';
  });
</script>

<!-- 纸张背景图层: fixed 全屏, z-index: -1 在所有内容之下 -->
<div class="app-bg" class:loaded={imgLoaded} class:failed={imgFailed} aria-hidden="true"></div>

<style>
  /* v0.3.20 #97: 纸张背景图 (替代 v0.3.18 #47 玻璃 bg).
     z-index: -1 + position: fixed 把它放到 body 之下,
     不参与布局 (不撑高 body, 不影响 main flex column 滚动). */
  .app-bg {
    position: fixed;
    inset: 0;
    z-index: -1;
    width: 100vw;
    height: 100dvh;
    /* fallback: paper-white (image 加载延迟 / 失败时显示).
       跟 app.css body bg var(--gray-50) 一致, 加载完不闪.
       不用 glass 蓝紫 — paper 是暖中性, glass 蓝紫调跟 paper 撞色. */
    background: #fafafa;
    pointer-events: none;
    overflow: hidden;
    /* GPU 加速 (避免 z-index: -1 触发重绘抖动) */
    will-change: transform;
    transform: translateZ(0);
  }
  /* 图片加载成功 → 叠在 fallback 之上 (cover 全屏, 居中).
     textured-paper.jpg 是 3:4 portrait, 在移动端 9:16 viewport 上 cover 会
     裁掉左右两边 (paper 边缘本来没东西, 裁掉不影响视觉).
     noise overlay 不要 — paper 已经有自己的 grain, 加 noise 反而糊掉细节. */
  .app-bg.loaded {
    background-image: url('/textured-paper.jpg');
    background-size: cover;
    background-position: center;
    background-repeat: no-repeat;
  }
  /* 图片加载失败 → 保留 fallback (不做 img 重试, 让 fallback 永久生效) */
  .app-bg.failed {
    background: #fafafa;
  }
</style>
