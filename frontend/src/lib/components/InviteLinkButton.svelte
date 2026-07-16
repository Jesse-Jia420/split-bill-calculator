<script lang="ts">
  /**
   * v0.1.2 反馈修 6 + v0.2.1 UI rev — 邀请按钮 stopPropagation (避免触发 members header 折叠).
   *
   * 设计 (PO 反馈 2026-07-02 11:23):
   * - 点击「邀请」 → 立即复制 invite URL + 显示 Toast「已复制邀请链接」
   * - 按钮文字短时变「已复制 ✓」(300ms 反馈)
   * - 不弹 modal,无需用户再点一次
   * - 失败兜底: 选中 input + execCommand('copy')
   * - 第一次点击 lazy load invite,后续点击只复制
   *
   * v0.3.15 (PO #4807 + Designer 报告) — 清理死代码:
   * - 删 `let error: string | null = null` (声明后从未赋值)
   * - 删 `<div class="error">{error}</div>` 模板 (永远不显示)
   * 成功/失败反馈一直走 toast (L68/70),无副作用.
   */
  import { toast } from '$stores/toast';

  export let sessionId: number;
  /** v0.3.1: unguessable public code from sessions.session_code. */
  export let sessionCode: string = '';
  /** True if the caller is the session owner (保留 prop,后续 v0.2 rotate 功能回归使用)。 */
  export const isOwner: boolean = false;

  let copied = false;
  let resetTimer: ReturnType<typeof setTimeout> | null = null;

  /** v0.3.1: copy the SESSION URL (not the invite URL).
   * Per PO 16:55, the "invite link" that gets copied should just be the
   * session page URL — the invite token is internal and not surfaced. */
  $: inviteUrl =
    typeof window !== 'undefined'
      ? sessionCode
        ? window.location.origin + '/s/' + sessionCode
        : window.location.origin + '/sessions/' + sessionId
      : '';

  /** v0.3.1: copy SESSION URL directly (no lazy load needed — no
   *  API call, no expiry display). Just copy `${origin}/sessions/${id}`. */
  async function handleInviteClick() {
    const url = inviteUrl;
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
      // Fallback: 隐藏 input + execCommand('copy')
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

    // v0.3.1 (PO Bug #4): show "已复制" for 10s then reset to "邀请".
    // Only 2 states: 邀请 / 已复制. No busy / loading state.
    copied = true;
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      copied = false;
      resetTimer = null;
    }, 10000);
  }


</script>

<div class="invite-row">
  <!-- PO 反馈修 6 项目 1: 点击立即复制 + toast,不再开 modal。 -->
  <button
    type="button"
    class="glass-pill invite-btn"
    class:copied
    on:click={(e) => { e.stopPropagation(); handleInviteClick(); }}
    title="复制邀请链接"
    aria-label="复制邀请链接"
    data-testid="invite-btn"
  >
    <span class="btn-content">
      <span class="btn-icon" aria-hidden="true">{copied ? '✓' : '📨'}</span>
      <span class="btn-label">{copied ? '已复制' : '邀请'}</span>
    </span>
  </button>
</div>

<style>
  .invite-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    align-items: flex-end;
  }
  /* v0.3.16 #8 (PO msg 19:26): 加 .glass-pill 玻璃化 —
     bg/border/box-shadow 由 .glass-pill 提供, 这里只保留布局与 copied 反馈。 */
  .invite-btn {
    /* 玻璃化在 .glass-pill 类里, 这里不重复定义 bg/border/box-shadow。
       只保留 copied 状态的视觉反馈 (绿色) + transition (匹配 pill 的 150ms)。 */
    transition: transform 150ms ease, background 150ms ease, box-shadow 150ms ease, color 150ms ease;
  }
  .invite-btn:active {
    transform: scale(0.97);
  }
  /* copied 状态: 玻璃底色 + 绿色文字 + 绿色光晕, 保持玻璃质感 */
  .invite-btn.copied {
    background: linear-gradient(
      135deg,
      rgba(16, 185, 129, 0.18) 0%,
      rgba(16, 185, 129, 0.12) 100%
    );
    border-color: rgba(16, 185, 129, 0.30);
    color: var(--color-success, #047857);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.6),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04),
      0 1px 4px rgba(16, 185, 129, 0.14);
  }
  .invite-btn.copied:hover {
    background: linear-gradient(
      135deg,
      rgba(16, 185, 129, 0.26) 0%,
      rgba(16, 185, 129, 0.20) 100%
    );
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
  /* 移动端 375px: 极致紧凑,ICON + 文字同行,不挤压 */
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
