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
  import LoadingOverlay from '$components/LoadingOverlay.svelte';
  // v0.3.36 (PO msg 2026-07-27 12:19): 全局挂载版本号 badge (FE short hash + BE /version),
  // Master 跟 PO 对齐部署/真机验证时的版本依据. fixed 定位 (top-right z-index 200),
  // 不参与 main flex 流, 不会挤内容.
  import VersionBadge from '$components/VersionBadge.svelte';
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { loadUser } from '$stores/user';
  import { page, navigating } from '$app/state';

  // Best-effort user load on every page mount.
  // v0.3.20 #99-fix5 (PO msg 14:29 #7602 padding-top 不够 + 透明度再降):
  // v0.3.21 #102 (PO msg 14:53): 删了"已登录从 / 重定向到 /sessions" — 让已登录用户
  // 也能看 landing, CTA 改"进入我的账本", "已登录为 xxx" + "退出登录" 都在 landing 显.
  function syncNavbarHeight(): void {
    const nav = document.querySelector(".navbar");
    if (!nav) return;
    const rect = nav.getBoundingClientRect();
    document.documentElement.style.setProperty("--navbar-h", rect.height + "px");
  }

  /**
   * 切出浏览器 / App 后页面会被挂起, 切回时常先露出旧 UI ~2s 再自动刷新,
   * 用户会误以为可操作. 切出瞬间盖上 LoadingOverlay 并挡住交互;
   * 切回时若仍是旧页则主动 reload, overlay 一直保持到新文档替换.
   * (LoadingOverlay 注释里的 PO 意图, 此前未接到 visibility.)
   */
  let awayLoading = $state(false);
  let hiddenAt = 0;

  onMount(() => {
    syncNavbarHeight();
    const ro = new ResizeObserver(syncNavbarHeight);
    const nav = document.querySelector(".navbar");
    if (nav) ro.observe(nav);
    window.addEventListener("resize", syncNavbarHeight);

    const coverAway = () => {
      awayLoading = true;
      hiddenAt = Date.now();
    };

    const onVisibility = () => {
      if (document.hidden) {
        coverAway();
        return;
      }
      // 切回: 保持 overlay; 短暂切后台 (<400ms, 如系统通知) 不强制 reload.
      if (!awayLoading) return;
      if (Date.now() - hiddenAt < 400) {
        awayLoading = false;
        return;
      }
      try {
        window.location.reload();
      } catch {
        // ignore — overlay stays until something else remounts
      }
    };

    const onPageHide = () => coverAway();
    const onPageShow = (e: PageTransitionEvent) => {
      // bfcache 恢复: 旧 DOM 会直接露出来, 立刻盖住并硬刷新.
      if (e.persisted) {
        coverAway();
        try {
          window.location.reload();
        } catch {
          /* ignore */
        }
      }
    };
    const onFreeze = () => coverAway();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    // Page Lifecycle (Chromium): tab frozen in background
    document.addEventListener('freeze', onFreeze);

    void loadUser();

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", syncNavbarHeight);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('freeze', onFreeze);
    };
  });
</script>

<!-- v0.3.18 #51 (PO msg 23:17 #6526) → v0.3.20 #97 (PO msg 13:24 #7503):
     整站去背景图改回加 — 用 AppBackground (paper texture) 替代纯色 body bg.
     body bg 仍然保留 var(--gray-50) 作为 image-load 期间占位. -->
<AppBackground />
<!-- v0.3.21 #102 (PO msg 14:53): landing page (pathname === \"/\") 去掉 header.
     其他页保持 NavBar (Logout / 我的账本 / 登录按钮 / 用户名仍走 NavBar).
     landing 上背景图 + 已登录状态 / 退出登录 链接 自成一派 (见 +page.svelte). -->
{#if page.url.pathname !== "/"}
  <NavBar />
{/if}
<Toast />
<!-- v0.3.36 (PO msg 2026-07-27 12:19): 全局挂载版本号 badge (FE short hash + BE /version),
     Master 跟 PO 对齐部署/真机验证时的版本依据. fixed 定位 (top-right z-index 200),
     不参与 main flex 流, 不会挤内容. -->
<VersionBadge />
<!-- v0.3.28 UAT 0724-1 #5: 全局路由导航时显示 LoadingOverlay (玻璃圆环).
     $navigating store (SvelteKit 5 runes) 在跳转前 fire 非 null, 跳转完成后回到 null.
     跨页面 nav 通常 50-300ms 内完成 — 显示完整 overlay 让用户知道 "系统在加载"
     而不是 "页面卡死". Option C 玻璃圆环 + 玻璃 pill (跟 design-mocks/v0328-0724-1-5-loading/03-glass-ring.html 一致).
     awayLoading: 切出浏览器时提前盖住, 避免切回后 ~2s 旧 UI 可误点. -->
{#if navigating.to || awayLoading}
  <LoadingOverlay text="加载中..." />
{/if}
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
    /* v0.3.22 #119 (PO msg 11:35 #7838 Bug 4): overflow-anchor: always 让浏览器在
       filteredBills 变化引起 .bill-list-grouped 高度缩短时, 自动保持锚定元素位置不变,
       避免 main.scrollTop 被 clamp 带动 sticky search 从 top:8 掉到中部. */
    overflow-anchor: always;
    padding: calc(var(--navbar-h, 56px) + env(safe-area-inset-top, 0px) + 16px) 0 0;
    overflow-y: auto;
    overflow-x: hidden;
    /* none (not contain): iOS rubber-band at top was flashing a large white band under the status bar. */
    overscroll-behavior-y: none;
    -webkit-overflow-scrolling: touch;
    min-height: 0; /* 关键 */
    /* Match paper fallback so any residual overscroll gutter isn't stark browser-white. */
    background-color: transparent;
  }
  .page-inner { padding: var(--space-4); width: 100%; }
  @media (min-width: 960px) {
    .page-inner { padding: var(--space-5) var(--space-6); }
  }

  /* Landing is full-bleed; drop chrome padding / max-width so the stage fills the viewport. */
  :global(body:has(.landing)) .page {
    padding: 0;
    max-width: none;
    overflow: hidden;
  }
  :global(body:has(.landing)) .page-inner {
    padding: 0;
    min-height: 100%;
  }
</style>