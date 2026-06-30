<script lang="ts">
  import { goto } from '$app/navigation';
  import { createSession } from '$api/sessions';
  import { loadSessions } from '$stores/sessions';
  import { loadUser } from '$stores/user';
  import { onMount } from 'svelte';

  let name = '';
  let busy = false;
  let error: string | null = null;
  let loading = true;

  onMount(async () => {
    const u = await loadUser();
    if (!u) {
      // Not logged in -- bounce to login, then come back here.
      await goto('/auth/login?next=/sessions/new', { replaceState: true });
      return;
    }
    loading = false;
  });

  async function handleCreate() {
    if (busy) return;
    error = null;
    const trimmed = name.trim();
    if (!trimmed) {
      error = '请输入 session 名字';
      return;
    }
    busy = true;
    try {
      const created = await createSession(trimmed);
      await loadSessions();
      await goto('/sessions/' + created.id);
    } catch (e: any) {
      const c = e?.code ?? '';
      if (c === 'not authenticated') {
        await goto('/auth/login?next=/sessions/new', { replaceState: true });
        return;
      }
      error = e?.message ?? '创建失败';
    } finally {
      busy = false;
    }
  }
</script>

<section>
  <h2>新建 session</h2>
  <p class="muted">session = 一个记账本,可以是旅行 / 合租 / 聚餐…</p>

  {#if loading}
    <p>正在检查登录状态…</p>
  {:else}
    <div class="stack" style="max-width: 480px;">
      <div>
        <label class="label" for="name">名字</label>
        <input id="name" type="text" bind:value={name} placeholder="例: 2026 曼谷之旅" maxlength="200" />
      </div>
      <button class="primary" on:click={handleCreate} disabled={busy}>
        {busy ? '创建中…' : '创建'}
      </button>
      {#if error}
        <div class="error">{error}</div>
      {/if}
    </div>
  {/if}
</section>
