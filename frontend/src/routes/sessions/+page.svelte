<script lang="ts">
  import { onMount } from 'svelte';
  import { loadSessions, sessions } from '$stores/sessions';
  import SessionCard from '$components/SessionCard.svelte';

  let loading = true;
  let error: string | null = null;

  onMount(async () => {
    try {
      await loadSessions();
    } catch (e: any) {
      error = e?.message ?? '加载失败';
    } finally {
      loading = false;
    }
  });
</script>

<section>
  <div class="row between" style="margin-bottom: var(--space-4);">
    <h2>我的 sessions</h2>
    <a class="btn primary" href="/sessions/new">+ 新建 session</a>
  </div>

  {#if loading}
    <p class="muted">加载中…</p>
  {:else if error}
    <div class="error">{error}</div>
  {:else if $sessions.length === 0}
    <div class="card" style="text-align: center;">
      <p class="muted">还没有 session</p>
      <a class="btn primary" href="/sessions/new">创建第一个</a>
    </div>
  {:else}
    <div class="stack">
      {#each $sessions as s (s.id)}
        <SessionCard session={s} />
      {/each}
    </div>
  {/if}
</section>