<script lang="ts">
  /**
   * v0.3 (PRD §3.10) — session join / claim page.
   *
   * URL: /sessions/{id}/join[?token=xxx]
   *
   * User flow:
   * 1. Logged-in user with (user_id, session_id) binding → auto-redirect to session.
   * 2. Anonymous user with valid actingAs secret in localStorage → verify + redirect.
   * 3. Anonymous user with ?token=xxx → show session name + join options.
   * 4. Unknown user → show join options (no session name shown without token).
   *
   * 4-action matrix (join-claim endpoint):
   *   Anonymous:  claim existing unclaimed slot | add new nickname
   *   Logged-in: bind existing slot (user_id) | add new nickname (user_id)
   *
   * v0.3.17 #33 (PO msg 01:34 #6139 + msg 01:37 #6149 续) — join session page 玻璃化重构 + 文案 polish.
   * 跟 v0.3.17 #27 全玻璃化 polish + #30/#31/#32 liquid glass 设计语言一致.
   * 复用现有 utility (.glass-pill / .glass-input / .btn-primary), 不引入新 design token.
   * #6149 PO 文案 polish: 标题「回到/加入账本」/ taken slot 描述 / 「或」字 divider / 新建昵称描述.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    getSession,
    getSessionPreview,
    joinClaim,
    type SessionDetail,
    type SessionMember,
    type SessionPreview,
    type SessionPreviewMember
  } from '$api/sessions';
  import { getInvite, type InvitePublicView } from '$api/invites';
  import { loadUser } from '$stores/user';
  import { toast } from '$stores/toast';

  // localStorage key prefix for anonymous acting-as
  const LS_PREFIX = 'sbc.actingAs.';

  let loading = $state(true);
  let session: SessionDetail | null = $state(null);
  // v0.3.1 (BUG-LANDING-1): public, no-auth session preview. Populated
  // when getSession() 403s (anon flow) so /join can still render
  // session name + member slots (including the owner placeholder "我"
  // that the wizard creates).
  let preview: SessionPreview | null = $state(null);
  let invite: InvitePublicView | null = $state(null);
  let user: { user_id: number; email: string; default_name: string } | null = $state(null);

  /** Combined member list — prefers full session detail, falls back to
   * public preview. Used by the slots derivations below. */
  type AnyMember = SessionMember | SessionPreviewMember;
  function _combinedMembers(): AnyMember[] {
    const fromDetail: SessionMember[] = session?.members ?? [];
    const fromPreview: SessionPreviewMember[] = preview?.members ?? [];
    return (fromDetail.length > 0 ? fromDetail : fromPreview) as AnyMember[];
  }
  let members = $derived(_combinedMembers());

  // Join form state
  let newNickname = $state('');
  let selectedSlotId: number | null = $state(null);
  let busy = $state(false);

  let sessionId = $derived(Number(page.params.id) || 0);
  let inviteToken = $derived(page.url.searchParams.get('token'));

  onMount(async () => {
    const sid = sessionId;
    if (!sid) {
      // v0.3.15 (PO #4807): 错误统一走 Toast
      toast.error('无效的 账本');
      loading = false;
      return;
    }

    user = await loadUser();

    // Step 1: try to find an acting-as entry for this session in localStorage
    if (typeof window !== 'undefined') {
      const actingAs = _findActingAs(sessionId);
      if (actingAs) {
        // Verify the secret with the BE
        try {
          const verified = await getSession(sessionId);
          session = verified;
          await goto('/sessions/' + sessionId, { replaceState: true });
          return;
        } catch {
          // Secret invalid or expired — clear localStorage and continue
          localStorage.removeItem(actingAs.key);
        }
      }
    }

    // Step 2: if logged in, check if already a member
    if (user) {
      try {
        const verified = await getSession(sessionId);
        session = verified;
        // Already a member — redirect to session
        await goto('/sessions/' + sessionId, { replaceState: true });
        return;
      } catch {
        // Not a member — fall through to join page
      }
    }

    // Step 3: load public session preview (BUG-LANDING-1)
    // This is reached only when neither actingAs nor logged-in flow
    // produced a session (anon creator who clicked "直接开始使用" on
    // landing). getSession() 403s for anon, so we fall back to the
    // public /preview endpoint to render the session name + member
    // slots (including the owner placeholder "我"). If this also
    // fails (e.g. invalid id) the page just shows the "新增我的昵称"
    // form without a session name.
    try {
      preview = await getSessionPreview(sessionId);
    } catch {
      // Preview not available — ignore; invite + add-nickname form still work
    }

    // Step 4: load session info
    // If we have the invite token, use the public invite endpoint
    if (inviteToken) {
      try {
        invite = await getInvite(inviteToken);
      } catch {
        // Token invalid — ignore, we'll still show the join form
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
          // key format: sbc.actingAs.{sessionId}
          const parts = key.split('.');
          if (parts.length === 3 && Number(parts[2]) === sid) {
            return { key, secret };
          }
        }
      }
    }
    return null;
  }

  async function handleClaim(slotId: number) {
    if (busy) return;
    busy = true;
    try {
      const res = await joinClaim(sessionId, { action: 'claim', session_member_id: slotId });
      _storeActingAs(res.session_member_id, res.nickname_secret ?? '');
      await goto('/sessions/' + sessionId, { replaceState: true });
    } catch (e: any) {
      // v0.3.15 (PO #4807): 错误统一走 Toast
      const status = e?.status ?? e?.detail?.status;
      if (status === 409) {
        toast.error('该昵称已被其他人抢走了，请选择其他昵称');
        selectedSlotId = null;
      } else {
        toast.error(e?.message ?? '认领失败');
      }
    } finally {
      busy = false;
    }
  }

  async function handleAdd() {
    if (busy) return;
    const nickname = newNickname.trim();
    if (!nickname) {
      // v0.3.15 (PO #4807): 错误统一走 Toast
      toast.error('请输入昵称');
      return;
    }
    busy = true;
    try {
      const res = await joinClaim(sessionId, { action: 'add', display_name: nickname });
      _storeActingAs(res.session_member_id, res.nickname_secret ?? '');
      await goto('/sessions/' + sessionId, { replaceState: true });
    } catch (e: any) {
      // v0.3.15 (PO #4807): 错误统一走 Toast
      toast.error(e?.message ?? '加入失败');
    } finally {
      busy = false;
    }
  }

  function _storeActingAs(_memberId: number, secret: string) {
    // v0.3.1: store under sessionId (not memberId) so session page /
    // settle / listBills (which all read 'sbc.actingAs.' + sessionId)
    // can find the secret. memberId-keyed was a v0.3.0 typo.
    if (typeof window !== 'undefined' && sessionId && secret) {
      localStorage.setItem(LS_PREFIX + sessionId, secret);
    }
  }

  // Derive the list of available (unclaimed / unbound) nickname slots.
  // For anonymous users: show slots with nickname_secret=NULL (unclaimed).
  // For logged-in users: show all slots (they can bind any).
  let availableSlots = $derived(members.filter((m: AnyMember) => {
    if (user) {
      // Logged-in users see all slots (any can be bound)
      return true;
    }
    // Anonymous users only see unclaimed slots
    return m.user_id === null;
  }));

  // Slots that are already claimed/bound (for display only)
  let takenSlots = $derived(members.filter((m: AnyMember) => {
    if (user) return false; // Don't grey out for logged-in
    return m.user_id !== null;
  }));
</script>

<section class="join-page">
  <h2 class="step-title">回到/加入账本</h2>

  {#if loading}
    <p>正在加载…</p>
  {:else}
    {#if invite}
      <p class="muted">
        来自 <strong>{invite.inviter_display_name}</strong> 的账本:
        <strong>{invite.session_name}</strong>
      </p>
    {:else if session}
      <p class="muted">
        账本: <strong>{session.name}</strong>
      </p>
    {:else if preview}
      <p class="muted">
        账本: <strong>{preview.name}</strong>
      </p>
    {/if}

    {#if user}
      <!-- Logged-in user -->
      <p>登录身份: <strong>{user.email}</strong></p>

      <div class="stack" style="max-width: 480px;">
        {#if availableSlots.length > 0}
          <div>
            <p class="label">选择已有昵称（绑定到你的账号）</p>
            <div class="slot-list">
              {#each availableSlots as slot (slot.id)}
                <button
                  class="glass-pill slot-btn"
                  onclick={() => handleClaim(slot.id)}
                  disabled={busy}
                >
                  {slot.display_name}
                </button>
              {/each}
            </div>
          </div>
        {/if}

        <div>
          <p class="label">或者新增一个昵称</p>
          <div class="row gap">
            <input
              type="text"
              class="glass-input"
              placeholder="你的昵称"
              bind:value={newNickname}
              maxlength="50"
              onkeydown={(e) => e.key === 'Enter' && handleAdd()}
            />
            <button class="btn btn-primary" onclick={handleAdd} disabled={busy}>
              {busy ? '加入中…' : '加入'}
            </button>
          </div>
        </div>
      </div>
    {:else}
      <!-- Anonymous user -->
      <div class="stack" style="max-width: 480px;">
        {#if availableSlots.length > 0}
          <div>
            <p class="label">选择已有昵称（先到先得）</p>
            <div class="slot-list">
              {#each availableSlots as slot (slot.id)}
                <button
                  class="glass-pill slot-btn"
                  onclick={() => handleClaim(slot.id)}
                  disabled={busy}
                >
                  {slot.display_name}
                </button>
              {/each}
            </div>
          </div>
        {/if}

        {#if takenSlots.length > 0}
          <div>
            <p class="label muted">选择昵称以回到账本</p>
            <div class="slot-list">
              {#each takenSlots as slot (slot.id)}
                <span class="glass-pill slot-btn taken">
                  {slot.display_name}
                  {#if (slot as SessionMember).email}
                    <span class="muted">（已被 {(slot as SessionMember).email} 绑定）</span>
                  {/if}
                </span>
              {/each}
            </div>
          </div>
        {/if}

        <div class="divider-with-text"><span>或</span></div>

        <div>
          <p class="label">新建昵称以加入账本</p>
          <div class="row gap">
            <input
              type="text"
              class="glass-input"
              placeholder="你想叫什么名字？"
              bind:value={newNickname}
              maxlength="50"
              onkeydown={(e) => e.key === 'Enter' && handleAdd()}
            />
            <button class="btn btn-primary" onclick={handleAdd} disabled={busy}>
              {busy ? '加入中…' : '加入'}
            </button>
          </div>
        </div>
      </div>
    {/if}
  {/if}
</section>

<style>
  /* v0.3.17 #33 — join session page 玻璃化重构 (PO msg 01:34 #6139 + msg 01:37 #6149 续)
   * 跟 v0.3.17 #27 全玻璃化 polish + #30/#31/#32 liquid glass 一致.
   * 复用现有 .glass-pill / .glass-input / .btn-primary utility, 不引入新 design token.
   * .step-title 同 wizard .step-title 参数 (后续如需全局化, 跟随 wizard 一起迁). */

  .join-page {
    max-width: 480px;
    margin: 0 auto;
    padding: 1.5rem 1rem;
  }

  /* step-title 跟 wizard step-title 同款 — v0.3.17 #33 局部加 (等 wizard 移全局时一起迁) */
  .step-title {
    font-size: 1.5rem;
    font-weight: 700;
    color: #171717;
    margin: 0 0 0.375rem;
    line-height: 1.2;
  }

  .slot-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  /* slot-btn: 玻璃 pill 复用, hover/active/focus 由 .glass-pill 全局管 (#33 重构)
   * 保留 slot-btn 作为语义 class, 仅做 layout + size 调优 (padding/font-size) */
  .slot-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    cursor: pointer;
    font-size: 0.9rem;
  }
  .slot-btn:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
  /* taken 状态: display-only (灰显 + 中性 bg), 跟 .glass-pill 默认 accent 区分 */
  .slot-btn.taken {
    background: rgba(255, 255, 255, 0.45);
    color: var(--color-text-muted, #6b7280);
    border-color: rgba(99, 102, 241, 0.08);
    cursor: default;
    opacity: 0.7;
  }
  .slot-btn.taken:hover {
    /* display-only, 不响应 hover */
    transform: none;
    background: rgba(255, 255, 255, 0.45);
  }

  .gap {
    gap: 0.5rem;
  }
  .row {
    display: flex;
  }

  /* v0.3.17 #33 续: 「或」字 divider — 跟全站 glass language 一致 (#6149 PO msg 01:37)
   * 蓝紫半透 0.5px 装饰 + 中间 "或" 灰显文字 (跟 login .or-divider 同结构, 玻璃描边替换灰边) */
  .divider-with-text {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 1rem 0;
    color: var(--color-text-muted, #9ca3af);
    font-size: 0.8125rem;
  }
  .divider-with-text::before,
  .divider-with-text::after {
    content: '';
    flex: 1;
    height: 0.5px;
    background: rgba(99, 102, 241, 0.18);
  }
</style>