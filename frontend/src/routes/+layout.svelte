<script lang="ts">
  /**
   * v0.1.2 反馈修 6 Commit 1 (PO 2026-07-02 11:23 UX 改写) — 全局 +layout.svelte。
   *
   * Commit 1 (fix):
   * - 加全局 Toast 挂载点 <Toast /> (PO 反馈: 邀请复制成功提示)
   *
   * Commit 2 (feat) 改页面切换 fade 150ms → 200ms in / 100ms out
   */
  import '../app.css';
  import NavBar from '$components/NavBar.svelte';
  import Toast from '$components/Toast.svelte';
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { loadUser } from '$stores/user';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';

  onMount(async () => {
    const u = await loadUser();
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