<script lang="ts">
  /**
   * Legacy deep link → open ledger and rely on BillSheet on the main page.
   * Query `?bill=new` is reserved for a future auto-open; for now redirect home.
   */
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import LoadingOverlay from '$components/LoadingOverlay.svelte';

  let code = $derived(page.params.code ?? '');

  onMount(() => {
    void goto(`/s/${code}?bill=new`, { replaceState: true });
  });
</script>

<LoadingOverlay text="打开账单…" />
