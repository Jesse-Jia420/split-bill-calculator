<script lang="ts">
  import { onMount } from 'svelte';
  import { getSessionInvite, rotateSessionInvite } from '$api/invites';
  import type { SessionInvite } from '$api/invites';

  export let sessionId: number;
  /** True if the caller is the session owner (shows the "rotate" affordance). */
  export let isOwner: boolean = false;

  let invite: SessionInvite | null = null;
  let busy = false;
  let error: string | null = null;
  let open = false;
  let copied = false;
  let confirmingRotate = false;

  /** Full shareable URL (origin + client-relative path). */
  $: inviteUrl = invite
    ? (typeof window !== 'undefined' ? window.location.origin : '') + invite.url
    : '';

  async function load() {
    busy = true;
    error = null;
    try {
      invite = await getSessionInvite(sessionId);
    } catch (e: any) {
      // 403 if not a member (shouldn't happen here -- guarded by page), but be defensive
      error = e?.message ?? 'failed to load invite';
    } finally {
      busy = false;
    }
  }

  onMount(load);

  async function handleCopy() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // Fallback: select the text so the user can copy manually.
      const el = document.getElementById('invite-url') as HTMLInputElement | null;
      if (el) el.select();
    }
  }

  async function handleRotateClick() {
    confirmingRotate = true;
  }

  async function handleRotateConfirm() {
    confirmingRotate = false;
    if (busy) return;
    busy = true;
    error = null;
    try {
      invite = await rotateSessionInvite(sessionId);
    } catch (e: any) {
      error = e?.message ?? 'failed to rotate invite';
    } finally {
      busy = false;
    }
  }

  function close() {
    open = false;
  }

  /** Compact countdown, e.g. "29d 18h", or "已过期" when expired. */
  function remaining(expiresAtIso: string): string {
    const now = Date.now();
    const exp = new Date(expiresAtIso).getTime();
    const ms = exp - now;
    if (ms <= 0) return '已过期';
    const days = Math.floor(ms / (1000 * 60 * 60 * 24));
    const hours = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    if (days > 0) return `${days}天${hours}小时后过期`;
    if (hours > 0) return `${hours}小时后过期`;
    const minutes = Math.floor(ms / (1000 * 60));
    return `${minutes}分钟后过期`;
  }
</script>

<div class="invite-row">
  <button class="primary" on:click={load} disabled={busy}>
    {busy ? '加载中…' : (invite ? '查看邀请链接' : '查看邀请链接')}
  </button>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if invite && !open}
    <div class="muted hint">链接 {remaining(invite.expires_at)}</div>
  {/if}

  {#if invite && open}
    <div
      class="modal-backdrop"
      on:click={close}
      on:keydown={(e) => e.key === 'Escape' && close()}
      role="button"
      tabindex="-1"
    >
      <div class="modal" on:click|stopPropagation role="dialog" aria-modal="true">
        <h3>邀请链接</h3>
        <p class="hint">
          把这个链接发给队友，他们打开后会看到 session 名字。
          {#if invite.status === 'expired'}
            <span class="badge danger">已过期</span>
          {:else}
            链接 <strong>{remaining(invite.expires_at)}</strong>。
          {/if}
        </p>

        <div class="url-row">
          <input
            id="invite-url"
            type="text"
            readonly
            value={inviteUrl}
            on:focus={(e) => e.currentTarget.select()}
          />
          <button on:click={handleCopy}>{copied ? '已复制' : '复制'}</button>
        </div>

        <div class="meta muted">
          创建于 {new Date(invite.created_at).toLocaleString('zh-CN')}
        </div>

        {#if isOwner}
          <div class="owner-actions">
            {#if !confirmingRotate}
              <button class="ghost" on:click={handleRotateClick} disabled={busy}>
                重置链接（旧链接立即失效）
              </button>
            {:else}
              <div class="confirm">
                <span>确认重置？旧链接会立刻失效。</span>
                <button class="danger" on:click={handleRotateConfirm} disabled={busy}>
                  确认重置
                </button>
                <button class="ghost" on:click={() => (confirmingRotate = false)} disabled={busy}>
                  取消
                </button>
              </div>
            {/if}
          </div>
        {/if}

        <div class="row between modal-footer">
          <button class="ghost" on:click={close}>关闭</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .invite-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    align-items: flex-end;
  }
  .hint {
    font-size: var(--font-size-sm);
    margin: var(--space-1) 0;
  }
  .badge.danger {
    display: inline-block;
    margin-left: var(--space-2);
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--color-danger, #d33);
    color: #fff;
    font-size: var(--font-size-sm);
  }
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
  .meta {
    font-size: var(--font-size-sm);
  }
  .owner-actions {
    margin-top: var(--space-4);
    padding-top: var(--space-3);
    border-top: 1px solid var(--color-border, rgba(0, 0, 0, 0.08));
  }
  .confirm {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
    font-size: var(--font-size-sm);
  }
  .modal-footer {
    margin-top: var(--space-4);
  }
</style>
