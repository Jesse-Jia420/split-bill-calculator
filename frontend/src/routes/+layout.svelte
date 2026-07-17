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
   * §3.11.13: 加 <Footer /> 集中展示 FE/BE 版本号, NavBar 头部不再展示版本号
   */
  import '../app.css';
  import NavBar from '$components/NavBar.svelte';
  import Toast from '$components/Toast.svelte';
  import Footer from '$components/Footer.svelte';
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { loadUser } from '$stores/user';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';

  // Best-effort user load on every page mount.
  onMount(async () => {
    const u = await loadUser();
    // Redirect "/" to "/sessions" when logged in (per spec §1.5).
    // 忽略 Svelte type 抱怨 pathname union 检查,运行时仍然可能为空字符串
    const path = page.url.pathname;
    if (u && (path === '/' || path === '')) {
      await goto('/sessions', { replaceState: true });
    }
  });
</script>

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
<!-- §3.11.13: 版本号集中显示在底部 Footer, NavBar 头部不再展示 -->
<Footer />

<style>
  /* v0.3.17 #30 (PO msg 14:28 #5957): iOS app-shell 化 — main 改内层滚
   * - flex: 1 → 吃满 body flex column 中间剩余高度 (NavBar 上, Footer 下)
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
    padding: 0;
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