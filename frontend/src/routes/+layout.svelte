<script lang="ts">
  /**
   * v0.1.2 反馈修 5 (PO 2026-07-01 23:00 UX 改写) — 全局 +layout.svelte。
   *
   * 项目 9 (跨页面动画):
   * - 页面切换: <slot /> 包 {#key $page.url.pathname} + transition:fade={{duration:150}}
   * - 不要动画过度,每个 transition ≤ 300ms
   *
   * 设计原则:
   * - 让页面切换有「轻量」反馈 (150ms fade)
   * - 不影响子组件本身的过渡 (子组件可继续用 Svelte transition 局部)
   * - 用 Svelte 内置 fade/fly/slide,不引第三方动画库
   */
  import '../app.css';
  import NavBar from '$components/NavBar.svelte';
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { loadUser } from '$stores/user';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';

  // Best-effort user load on every page mount. The home page also has
  // its own version-bar loader, so we don't block rendering here.
  onMount(async () => {
    const u = await loadUser();
    // Redirect "/" to "/sessions" when logged in (per spec §1.5).
    if (u && ($page.url.pathname === '/' || $page.url.pathname === '')) {
      await goto('/sessions', { replaceState: true });
    }
  });
</script>

<NavBar />
<main class="page">
  {#key $page.url.pathname}
    <!-- 项目 9: 全局页面切换 fade 150ms (克制, 不超过 300ms) -->
    <div in:fade={{ duration: 150 }}>
      <slot />
    </div>
  {/key}
</main>

<style>
  .page {
    max-width: 720px;
    margin: 0 auto;
    padding: var(--space-4);
    min-height: calc(100vh - 56px);
  }
  @media (min-width: 960px) {
    .page {
      padding: var(--space-5) var(--space-6);
    }
  }
</style>
