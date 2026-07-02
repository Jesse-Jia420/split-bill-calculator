<script lang="ts">
  /**
   * v0.1.2 反馈修 6 Commit 1 (PO 2026-07-02 11:23) — 邀请按钮点击立即复制邀请链接。
   *
   * 设计 (PO 反馈):
   * - 点击「邀请」 → 立即复制 invite URL + 显示 Toast「已复制邀请链接」
   * - 按钮文字短时变「已复制」(1200ms 反馈)
   * - 不弹 modal,无需用户再点一次
   * - 失败兜底: 隐藏 textarea + execCommand('copy')
   * - 第一次点击 lazy load invite,后续点击只复制
   *
   * Commit 2 (feat) 加按钮按下 scale 0.97 微动 — 在此基础上加 active transition
   */
  import { onMount } from 'svelte';
  import { getSessionInvite } from '$api/invites';
  import type { SessionInvite } from '$api/invites';
  import { toast } from '$stores/toast';

  export let sessionId: number;
  /** True if the caller is the session owner (保留 prop,后续 v0.2 rotate 功能回归使用)。 */
  export const isOwner: boolean = false;

  let invite: SessionInvite | null = null;
  let busy = false;
  let error: string | null = null;
  let copied = false;

  $: inviteUrl = invite
    ? (typeof window !== 'undefined' ? window.location.origin : '') + invite.url
    : '';

  async function ensureLoaded(): Promise<string | null> {
    if (invite && inviteUrl) return inviteUrl;
    if (busy) return null;
    busy = true;
    error = null;
    try {
      invite = await getSessionInvite(sessionId);
      return inviteUrl;
    } catch (e: any) {
      error = e?.message ?? '加载邀请链接失败';
      toast.error(error ?? '加载邀请链接失败');
      return null;
    } finally {
      busy = false;
    }
  }

  async function handleInviteClick() {
    const url = await ensureLoaded();
    if (!url) return;

    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch {
      ok = false;
    }

    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }

    if (ok) {
      toast.success('已复制邀请链接');
    } else {
      toast.info('复制失败,请手动选中链接');
    }

    copied = true;
    setTimeout(() => (copied = false), 1200);
  }

  function remaining(expiresAtIso: string): string {
    const now = Date.now();
    const exp = new Date(expiresAtIso).getTime();
    const ms = exp - now;
    if (ms <= 0) return '已过期';
    const days = Math.floor(ms / (1000 * 60 * 60 * 24));
    const hours = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    if (days > 0) return `${days} 天 ${hours} 小时后过期`;
    if (hours > 0) return `${hours} 小时后过期`;
    const minutes = Math.floor(ms / (1000 * 60));
    return `${minutes} 分钟后过期`;
  }
</script>

<div class="invite-row">
  <button
    type="button"
    class="primary invite-btn"
    class:copied
    on:click={handleInviteClick}
    disabled={busy}
    title="复制邀请链接"
    aria-label="复制邀请链接"
  >
    <span class="btn-content">
      <span class="btn-icon" aria-hidden="true">{copied ? '✓' : '📨'}</span>
      <span class="btn-label">{busy ? '加载中…' : copied ? '已复制' : '邀请'}</span>
    </span>
  </button>

  {#if invite}
    <span class="muted hint">{remaining(invite.expires_at)}</span>
  {/if}

  {#if error}
    <div class="error">{error}</div>
  {/if}
</div>

<style>
  .invite-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    align-items: flex-end;
  }
  .invite-btn {
    transition: background-color 150ms ease, box-shadow 200ms ease;
  }
  .invite-btn.copied {
    background: var(--color-success, #10b981);
    border-color: var(--color-success, #10b981);
    box-shadow: 0 0 0 4px rgba(16, 185, 129, 0.18);
  }
  .btn-content {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  .btn-icon {
    font-size: 14px;
    line-height: 1;
  }
  @media (max-width: 380px) {
    .invite-btn {
      padding: var(--space-2) var(--space-3);
      min-height: 36px;
    }
    .btn-label {
      font-size: var(--font-size-sm);
    }
  }

  .hint {
    font-size: var(--font-size-sm);
    margin: var(--space-1) 0;
  }
</style>