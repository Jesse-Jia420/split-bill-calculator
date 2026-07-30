<script lang="ts">
  /**
   * Legacy edit URL → ledger with ?editBill={id} so the sheet can open.
   */
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import LoadingOverlay from '$components/LoadingOverlay.svelte';

  let code = $derived(page.params.code ?? '');
  let billId = $derived(page.params.billId ?? '');

  onMount(() => {
    void goto(`/s/${code}?editBill=${billId}`, { replaceState: true });
  });
</script>

<LoadingOverlay text="打开账单…" />
