<script lang="ts">
  /**
   * v0.1.2 反馈修 6 (PO 2026-07-02 11:23 UX 改写) — 全局 +layout.svelte。
   *
   * 本次改写:
   * - 项目 7 (跨页面动画): 升级页面切换动画 150ms → 200ms in / 100ms out
   *   让 fade 更明显,PO 说「系统几乎没有动画反馈」
   * - 加全局 Toast 挂载点 <Toast />
   * - 不引第三方动画库,用 Svelte 内置 fade
   */
  import '../app.css';
  import NavBar from '$components/NavBar.svelte';
  import Toast from '$components/Toast.svelte';
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { loadUser } from '$stores/user';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';

  // Best-effort user load on every page mount.
  onMount(async () => {
    const u = await loadUser();
    // Redirect "/" to "/sessions" when logged in (per spec §1.5).
    // 忽略 Svelte type 抱怨 pathname union 检查,运行时仍然可能为空字符串
    const path = $page.url.pathname;
    if (u && (path === '/' || path === '')) {
      await goto('/sessions', { replaceState: true });
    }
  });
</script>

<NavBar />
<Toast />
<main class="page">
  {#key $page.url.pathname}
    <!-- 反馈修 6 项目 7: 全局页面切换 fade 200ms in / 100ms out (略明显于之前的 150ms) -->
    <div in:fade={{ duration: 200 }} out:fade={{ duration: 100 }}>
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