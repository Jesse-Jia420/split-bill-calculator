<script lang="ts">
  import { createInvite } from '$api/invites';

  export let sessionId: number;
  /** Optional callback when an invite is created. */
  export let onCreated: ((url: string, token: string) => void) | null = null;

  let busy = false;
  let error: string | null = null;
  let open = false;
  let inviteUrl = '';
  let copied = false;

  async function handleCreate() {
    if (busy) return;
    busy = true;
    error = null;
    try {
      const res = await createInvite(sessionId);
      const token = res.token;
      inviteUrl = window.location.origin + '/invites/' + token;
      open = true;
      copied = false;
      if (onCreated) onCreated(inviteUrl, token);
    } catch (e: any) {
      error = e?.message ?? 'failed to create invite';
    } finally {
      busy = false;
    }
  }

  async function handleCopy() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // fallback: select the text
      const el = document.getElementById('invite-url') as HTMLInputElement | null;
      if (el) {
        el.select();
      }
    }
  }

  function close() {
    open = false;
  }
</script>

<div>
  <button class="primary" on:click={handleCreate} disabled={busy}>
    {busy ? '生成中…' : '生成邀请链接'}
  </button>
  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if open}
    <div class="modal-backdrop" on:click={close} on:keydown={(e) => e.key === 'Escape' && close()} role="button" tabindex="-1">
      <div class="modal" on:click|stopPropagation role="dialog" aria-modal="true">
        <h3>邀请链接</h3>
        <p class="hint">把这个链接发给队友，他们打开后会看到 session 名字。</p>
        <div class="url-row">
          <input id="invite-url" type="text" readonly value={inviteUrl} on:focus={(e) => e.currentTarget.select()} />
          <button on:click={handleCopy}>{copied ? '已复制' : '复制'}</button>
        </div>
        <div class="row between">
          <button class="ghost" on:click={close}>关闭</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
    padding: var(--space-4);
  }
  .modal {
    background: var(--color-surface);
    border-radius: var(--radius);
    padding: var(--space-5);
    width: 100%;
    max-width: 480px;
    box-sizing: border-box;
  }
  .modal h3 {
    margin: 0 0 var(--space-2);
  }
  .url-row {
    display: flex;
    gap: var(--space-2);
    margin: var(--space-3) 0;
  }
  .url-row input {
    flex: 1;
    min-width: 0;
  }
</style>