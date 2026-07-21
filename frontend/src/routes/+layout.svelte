<script lang="ts">
  /**
   * v0.1.2 反馈修 6 (PO 2026-07-02 11:23 UX 改写) — 全局 +layout.svelte。
   *
   * 本次改写:
   * - 项目 7 (跨页面动画): 升级页面切换动画 150ms → 200ms in / 100ms out
   *   让 fade 更明显,PO 说「系统几乎没有动画反馈」
   * - 加全局 Toast 挂载点 <Toast />
   * - 不引第三方动画库,用 Svelte 内置 fade
   *
   * v0.3.18 #54 (PO msg 18:10 #6569): 取消底部 Footer 区域 — 全屏体验更沉浸,
   * 不再有 "FE: xxxx · BE: xxxx" 占用底部高度, main 滚到底能看到完整最后一行.
   * Footer.svelte 文件保留作为 archive (含 BE /version fetch logic),
   * 未来想恢复直接重新 import + 此处挂载即可.
   */
  import '../app.css';
  import NavBar from '$components/NavBar.svelte';
  import Toast from '$components/Toast.svelte';
  // v0.3.20 #97 (PO msg 13:24 #7503): 整站加回背景图 — 用 textured-paper.jpg
  // (纸张纹理, 不可改) 替代 v0.3.18 #51 之前的纯色. AppBackground 之前是 archive,
  // 现在重新挂载作为 body 第一层 (在 <slot/> 之前的 <main> 之前).
  import AppBackground from '$components/AppBackground.svelte';
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { loadUser } from '$stores/user';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';

  // Best-effort user load on every page mount.
  // v0.3.20 #99-fix5 (PO msg 14:29 #7602 padding-top 不够 + 透明度再降):
  // 把实际 navbar 高度同步到 :root CSS var --navbar-h (供 main.page padding-top 用).
  // 不同页面 navbar 高度不同 (btn-sm touch target 44px 让 logged-in 页 navbar 比 auth
  // 页高 ~18px). ResizeObserver 监听 navbar size 变化 + 16px buffer 让出 navbar 下沿
  // 到首行内容之间 16px 空隙 (PO 原话 "padding top 除了 navbar 高度，还要留一点空余").
  function syncNavbarHeight(): void {
    const nav = document.querySelector(".navbar");
    if (!nav) return;
    const rect = nav.getBoundingClientRect();
    document.documentElement.style.setProperty("--navbar-h", rect.height + "px");
  }
  onMount(async () => {
    syncNavbarHeight();
    const ro = new ResizeObserver(syncNavbarHeight);
    const nav = document.querySelector(".navbar");
    if (nav) ro.observe(nav);
    window.addEventListener("resize", syncNavbarHeight);
    const u = await loadUser();
    const path = page.url.pathname;
    if (u && (path === '/' || path === '')) {
      await goto('/sessions', { replaceState: true });
    }
  });
</script>

<!-- v0.3.18 #51 (PO msg 23:17 #6526) → v0.3.20 #97 (PO msg 13:24 #7503):
     整站去背景图改回加 — 用 AppBackground (paper texture) 替代纯色 body bg.
     body bg 仍然保留 var(--gray-50) 作为 image-load 期间占位. -->
<AppBackground />
<NavBar />
<Toast />
<!-- v0.3.17 #30 (PO msg 14:28 #5957): <main class="page"> 改成内层滚动容器 —
     外层 html/body 已 lock overflow (见 app.css), body 是 flex column,
     .page flex:1 占满中间剩余高度, overflow-y:auto 让内容在 main 内滚,
     不再触发 iOS Safari 的 body 拖动 / rubber-band.
     旧 min-height: calc(100vh - 56px) 删掉 — 那个是当年假设 body 可滚,
     现在 body 锁了不需要这个补偿. -->
<main class="page">
  <!-- v0.3.16 #8 (PO msg 19:26): 去掉外层 key 包裹 — 原 {#key pathname}
       + in:fade 会创建 Svelte hydration comment anchor, 偶发在 iOS Safari
       被 fallback 渲染成乱码。直接 fade 即可, 仍有切换动画。
       v0.3.17 #30: 包一层 .page-inner — 跟 .page 的 padding 分工,
       .page 负责滚动 + max-width, .page-inner 负责 padding, 让
       scrollbar 不被 padding 挤压 (旧 padding 在 .page 直接放, scrollbar
       贴边很奇怪). -->
  <div class="page-inner" in:fade={{ duration: 200 }} out:fade={{ duration: 100 }}>
    <slot />
  </div>
</main>
<!-- v0.3.18 #54 (PO msg 18:10 #6569): Footer 取消. main flex:1 自动吃满
     body column 中间剩余高度 (NavBar 上, 底部不再有 footer 占用空间). -->

<style>
  /* v0.3.17 #30 (PO msg 14:28 #5957): iOS app-shell 化 — main 改内层滚
   * - flex: 1 → 吃满 body flex column 中间剩余高度 (NavBar 上, 底部 iOS safe-area 之下)
   * - overflow-y: auto + overflow-x: hidden → 内层独立滚, 不让外层 body 滚
   * - min-height: 0 → 关键: flex item 默认 min-height: auto 会撑破父容器,
   *   加上 0 才能让 flex: 1 真的收缩. 旧版没有 min-height: 0, 当 .page-inner
   *   内容超过 viewport 时 .page 不会滚, 而是把 body 撑高.
   * - overscroll-behavior-y: contain → main 滚到顶/底时, 不让滚动 bubble
   *   到 body 触发 rubber-band. 这是 iOS app-shell 的关键 trick.
   * - -webkit-overflow-scrolling: touch → 老 iOS Safari momentum scroll. */
  .page {
    flex: 1 1 auto;
    width: 100%;
    max-width: 720px;
    margin: 0 auto;
    /* v0.3.20 #99-fix4 (PO msg 14:26 #7585): 加 padding-top 推内容到固定 navbar 之下
       (NavBar 现在 position:fixed, 不在 flex 流里). padding-top = navbar 内容高 + safe area.
       内容仍可滚动到 navbar 区域下方, 透过 backdrop-filter blur + alpha 0.05 模糊漏出. */
    /* v0.3.20 #99-fix5 (PO msg 14:29 #7602): padding-top 加 16px buffer — 修 #99-fix4 让 navbar 高度刚好被盖的回归. 让出 navbar 下沿到首行内容之间有 16px 空隙. */
    padding: calc(var(--navbar-h, 56px) + env(safe-area-inset-top, 0px) + 16px) 0 0;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior-y: contain;
    -webkit-overflow-scrolling: touch;
    min-height: 0; /* 关键 */
  }
  .page-inner { padding: var(--space-4); width: 100%; }
  @media (min-width: 960px) {
    .page-inner { padding: var(--space-5) var(--space-6); }
  }
</style>