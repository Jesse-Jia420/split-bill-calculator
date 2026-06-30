<script lang="ts">
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { getSession } from '$api/sessions';
  import type { SessionDetail } from '$api/sessions';
  import SettleTransferPath from '$components/SettleTransferPath.svelte';

  let session: SessionDetail | null = null;
  let loading = true;
  let error: string | null = null;

  $: sessionId = Number($page.params.id);

  // map SessionMember.id -> display_name (for friendly labels)
  let memberIdToName: Record<number, string> = {};

  onMount(async () => {
    try {
      session = await getSession(sessionId);
      for (const m of session.members) {
        memberIdToName[m.id] = m.display_name;
      }
    } catch (e: any) {
      error = e?.message ?? '加载失败';
    } finally {
      loading = false;
    }
  });
</script>

<section>
  <div class="row" style="margin-bottom: var(--space-3);">
    <a class="btn ghost" href="/sessions/{sessionId}">← 返回</a>
  </div>

  {#if loading}
    <p class="muted">加载中…</p>
  {:else if error}
    <div class="error">{error}</div>
  {:else if session}
    <h2>{session.name} · 结算</h2>
    <p class="muted">谁付给谁多少,一目了然</p>

    <div class="card">
      <SettleTransferPath {session} {memberIdToName} />
    </div>
  {/if}
</section>