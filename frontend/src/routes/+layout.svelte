<script lang="ts">
  import '../app.css';
  import NavBar from '$components/NavBar.svelte';
  import { onMount } from 'svelte';
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
  <slot />
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