<script lang="ts">
  /**
   * §3.11.11 (PO 2026-07-08 17:41 拍板) — 单屏 wizard join page.
   *
   * URL: /sessions/{id}/join[?token=xxx]
   *
   * 单屏 wizard UI (PRD §3.11.11 决策 2 + 4):
   * - 上半屏: 所有已认领昵称 as buttons (全部 members, 不 filter)
   * - 下半屏: 新建昵称 input + 按钮
   * - 不区分老/新用户 (同 UI)
   * - 不做 wizard 步进 (单步)
   * - 不做 "登录找回" CTA
   *
   * Edge cases:
   * - 点错昵称 → BE 接受 (错进 session) → 退出重选
   * - 7 天外 session → BE 410 → 显示 "session 已回收"
   * - 新用户点选已有 (不认得) → BE 接受 → 退出重选
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { getSession, joinClaim, type SessionDetail } from '$api/sessions';
  import { getInvite, type InvitePublicView } from '$api/invites';
  import { loadUser } from '$stores/user';

  const LS_PREFIX = 'sbc.actingAs.';

  let loading = $state(true);
  let error: string | null = $state(null);
  let session: SessionDetail | null = $state(null);
  let invite: InvitePublicView | null = $state(null);
  let reclaimed = $state(false);   // 7 天外 410
  let newNickname = $state('');
  let busy = $state(false);

  let sessionId = $derived(Number(page.params.id) || 0);
  let inviteToken = $derived(page.url.searchParams.get('token'));

  onMount(async () => {
    const sid = sessionId;
    if (!sid) {
      error = '无效的 session';
      loading = false;
      return;
    }

    // 尝试 localStorage acting-as secret → 验证后直接进 session
    if (typeof window !== 'undefined') {
      const actingAs = _findActingAs(sessionId);
      if (actingAs) {
        try {
          const verified = await getSession(sessionId);
          session = verified;
          await goto('/sessions/' + sessionId, { replaceState: true });
          return;
        } catch {
          localStorage.removeItem(actingAs.key);
        }
      }
    }

    // 尝试通过 cookie 认证 (logged-in)
    try {
      const verified = await getSession(sessionId);
      session = verified;
      await goto('/sessions/' + sessionId, { replaceState: true });
      return;
    } catch {
      // Not a member — fall through to join page
    }

    // 加载 session preview (anon 也可用)
    if (!session) {
      try {
        const res = await fetch('/api/sessions/' + sid + '/preview', {
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        });
        if (res.status === 410) {
          // §3.11.11: 7 天外 session 已回收
          reclaimed = true;
          loading = false;
          return;
        }
        if (res.ok) {
          const p = await res.json() as {
            id: number;
            name: string;
            currencies: string[];
            primary_currency: string;
            members: Array<{
              id: number;
              user_id: number | null;
              display_name: string;
              role: string;
              claimed_at: string | null;
            }>;
          };
          session = {
            id: p.id,
            name: p.name,
            owner_user_id: null,
            created_at: '',
            currencies: p.currencies,
            primary_currency: p.primary_currency,
            exchange_rates: [],
            members: p.members.map((m) => ({
              id: m.id,
              user_id: m.user_id,
              email: null,
              display_name: m.display_name,
              role: m.role,
              joined_at: m.claimed_at ?? '',
            })),
          } as SessionDetail;
        }
      } catch {
        // 网络错误 — 仍显示 join form
      }
    }

    // invite token → 显示 inviter 信息
    if (inviteToken && !invite) {
      try {
        invite = await getInvite(inviteToken);
      } catch {
        // ignore
      }
    }

    loading = false;
  });

  function _findActingAs(sid: number): { key: string; secret: string } | null {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(LS_PREFIX)) {
        const secret = localStorage.getItem(key);
        if (secret) {
          const parts = key.split('.');
          if (parts.length === 3 && Number(parts[2]) === sid) {
            return { key, secret };
          }
        }
      }
    }
    return null;
  }

  /** 上半屏: 点已有昵称 → claim slot */
  async function handleClaim(slotId: number) {
    if (busy) return;
    error = null;
    busy = true;
    try {
      const res = await joinClaim(sessionId, { action: 'claim', session_member_id: slotId });
      _storeActingAs(res.session_member_id, res.nickname_secret ?? '');
      await goto('/sessions/' + sessionId, { replaceState: true });
    } catch (e: any) {
      const status = e?.status ?? e?.detail?.status;
      if (status === 409) {
        error = '该昵称已被其他人抢走了，请选择其他昵称或新建一个';
      } else if (status === 410) {
        reclaimed = true;
      } else {
        error = e?.message ?? '认领失败';
      }
    } finally {
      busy = false;
    }
  }

  /** 下半屏: 新建昵称 → add slot */
  async function handleAdd() {
    if (busy) return;
    const nickname = newNickname.trim();
    if (!nickname) {
      error = '请输入昵称';
      return;
    }
    error = null;
    busy = true;
    try {
      const res = await joinClaim(sessionId, { action: 'add', display_name: nickname });
      _storeActingAs(res.session_member_id, res.nickname_secret ?? '');
      await goto('/sessions/' + sessionId, { replaceState: true });
    } catch (e: any) {
      const status = e?.status ?? e?.detail?.status;
      if (status === 410) {
        reclaimed = true;
      } else {
        error = e?.message ?? '加入失败';
      }
    } finally {
      busy = false;
    }
  }

  function _storeActingAs(_memberId: number, secret: string) {
    if (typeof window !== 'undefined' && sessionId && secret) {
      localStorage.setItem(LS_PREFIX + sessionId, secret);
    }
  }
</script>

<section>
  <h2>加入 session</h2>

  {#if loading}
    <p class="muted">正在加载…</p>

  {:else if reclaimed}
    <!-- §3.11.11 决策 b: 7 天外 session 直接回收 -->
    <div class="reclaimed-card">
      <div class="reclaimed-icon" aria-hidden="true">⏱</div>
      <h3>session 已回收</h3>
      <p>这个 session 的邀请链接已过期（owner 超过 7 天没有活动）。</p>
      <p>如果你是 owner，请 <a href="/auth/login?returnTo=/sessions/{sessionId}">登录</a> 后认领并重新激活 session。</p>
    </div>

  {:else if error && !session && !invite}
    <div class="error">{error}</div>

  {:else}
    <!-- Session 名称显示 -->
    {#if invite}
      <p class="muted">
        来自 <strong>{invite.inviter_display_name}</strong> 的 session:
        <strong>{invite.session_name}</strong>
      </p>
    {:else if session}
      <p class="muted">Session: <strong>{session.name}</strong></p>
    {/if}

    {#if error}
      <div class="error" style="margin-bottom: 1rem;">{error}</div>
    {/if}

    <!-- ============================================================
         单屏 wizard (SPEC §5 + PRD §3.11.11 决策 2)
         ============================================================ -->
    <div class="wizard">
      <!-- 上半屏: 选你的昵称 — 所有已认领 slot buttons -->
      <div class="wizard-section">
        <p class="wizard-label">选你的昵称</p>
        {#if session?.members?.length}
          <div class="slot-list">
            {#each session.members as m (m.id)}
              <button
                class="slot-btn"
                onclick={() => handleClaim(m.id)}
                disabled={busy}
                title="点击加入这个昵称"
              >
                {m.display_name}
              </button>
            {/each}
          </div>
        {:else}
          <p class="muted small">还没有昵称，直接新建一个吧</p>
        {/if}
      </div>

      <hr class="wizard-sep" />

      <!-- 下半屏: 新建昵称 -->
      <div class="wizard-section">
        <p class="wizard-label">或新建昵称</p>
        <div class="row gap">
          <input
            type="text"
            placeholder="输入你想用的昵称"
            bind:value={newNickname}
            maxlength="50"
            onkeydown={(e) => e.key === 'Enter' && handleAdd()}
          />
          <button class="primary" onclick={handleAdd} disabled={busy}>
            {busy ? '加入中…' : '加入'}
          </button>
        </div>
      </div>
    </div>

    <p class="muted small tip">
      点错昵称也没关系，进入后可以退出重选
    </p>
  {/if}
</section>

<style>
  .wizard {
    background: var(--gray-50, #f9fafb);
    border: 1px solid var(--gray-200, #e5e7eb);
    border-radius: var(--radius-lg, 12px);
    padding: var(--space-4, 1.5rem);
    max-width: 540px;
    margin-top: var(--space-3, 1rem);
  }
  .wizard-section {
    padding: var(--space-2, 0.5rem) 0;
  }
  .wizard-label {
    font-weight: 600;
    font-size: 0.9rem;
    color: var(--gray-700, #374151);
    margin: 0 0 0.75rem 0;
  }
  .wizard-sep {
    border: none;
    border-top: 1px solid var(--gray-200, #e5e7eb);
    margin: var(--space-3, 1rem) 0;
  }
  .slot-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .slot-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    border: 1px solid rgba(99, 102, 241, 0.3);
    border-radius: 0.5rem;
    background: rgba(99, 102, 241, 0.04);
    color: #4f46e5;
    cursor: pointer;
    font-size: 0.9rem;
    transition: background 0.15s, border-color 0.15s;
  }
  .slot-btn:hover:not(:disabled) {
    background: rgba(99, 102, 241, 0.1);
    border-color: rgba(99, 102, 241, 0.5);
  }
  .slot-btn:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
  .gap {
    gap: 0.5rem;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
  }
  .tip {
    margin-top: var(--space-3, 1rem);
    font-size: 0.8rem;
  }
  /* 7 天外回收卡片 */
  .reclaimed-card {
    background: var(--gray-50, #f9fafb);
    border: 1px solid var(--gray-200, #e5e7eb);
    border-radius: var(--radius-lg, 12px);
    padding: var(--space-6, 2.5rem);
    text-align: center;
    max-width: 480px;
    margin-top: var(--space-3, 1rem);
  }
  .reclaimed-icon {
    font-size: 3rem;
    margin-bottom: 1rem;
  }
  .reclaimed-card h3 {
    margin: 0 0 0.75rem 0;
    color: var(--gray-800, #1f2937);
  }
  .reclaimed-card p {
    color: var(--gray-600, #4b5563);
    margin: 0.5rem 0;
    font-size: 0.9rem;
  }
</style>
