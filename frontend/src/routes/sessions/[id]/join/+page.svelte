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
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { getSession, joinClaim, type SessionDetail, type SessionMember } from '$api/sessions';
  import { getInvite, type InvitePublicView } from '$api/invites';
  import { loadUser } from '$stores/user';

  // localStorage key prefix for anonymous acting-as
  const LS_PREFIX = 'sbc.actingAs.';

  let loading = $state(true);
  let error: string | null = null;
  let session: SessionDetail | null = $state(null);
  let invite: InvitePublicView | null = $state(null);
  let user: { user_id: number; email: string; default_name: string } | null = $state(null);

  // Join form state
  let newNickname = $state('');
  let selectedSlotId: number | null = $state(null);
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

    // Step 3: load session info
    // If we have the invite token, use the public invite endpoint
    if (inviteToken) {
      try {
        invite = await getInvite(inviteToken);
      } catch {
        // Token invalid — ignore, we'll still show the join form
      }
    }

    // Bug 2 fix (PO 12:45): anon users访问 /join 时, /api/sessions/{id} 401 (无 secret/cookie).
    // 用 public /preview endpoint (BE 新加) 仍然能拿 session 名 + members (含 user_id 信息).
    // 这样 anon user 看到 "已被认领的昵称" 列表 + "登录找回" button, 能找回自己绑定的 session.
    if (!session) {
      try {
        const res = await fetch('/api/sessions/' + sid + '/preview', {
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        });
        if (res.ok) {
          const p = await res.json();
          // 把 preview.members 映射成 SessionMember 兼容 shape (join page 现有 derived 可工作).
          session = {
            id: p.id,
            name: p.name,
            members: p.members.map((m) => ({
              id: m.id,
              user_id: m.user_id,
              email: null,  // preview 不暴露 email (隐私)
              display_name: m.display_name,
              role: m.role,
              joined_at: m.claimed_at ?? '',
            })) as SessionMember[],
          } as SessionDetail;
        }
        // 404 / 5xx → join page 仍可用 "新增昵称" 流程 (现状行为)
      } catch {
        // 网络错误 — 同上
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
    error = null;
    busy = true;
    try {
      const res = await joinClaim(sessionId, { action: 'claim', session_member_id: slotId });
      _storeActingAs(res.session_member_id, res.nickname_secret ?? '');
      await goto('/sessions/' + sessionId, { replaceState: true });
    } catch (e: any) {
      const status = e?.status ?? e?.detail?.status;
      if (status === 409) {
        error = '该昵称已被其他人抢走了，请选择其他昵称';
        selectedSlotId = null;
      } else {
        error = e?.message ?? '认领失败';
      }
    } finally {
      busy = false;
    }
  }

  // Bug fix (PO 16:06 报 "未登录状态，选择已有昵称无法跳转 session"):
  // anon user 点 taken slot → 走登录找回流程. returnTo 直接到 /sessions/{id}
  // (而**不** /sessions/{id}/join — 登录后**已** member → onMount 重定向 detail).
  // 之前是 <span disabled> **不**可点.
  async function handleClaimTaken(_slot: SessionMember) {
    await goto('/auth/login?returnTo=/sessions/' + sessionId, { replaceState: true });
  }

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
      error = e?.message ?? '加入失败';
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
  // For anonymous users: show slots with NO claim yet (user_id=null AND claimed_at=null).
  // 重要 (PO 16:39): anon creator 走 /join-claim 后, member.user_id 仍 null 但
  // nickname_secret + claimed_at 已设. 这种 "anon-claimed" 槽**不**应该 anon 重 claim (BE 409).
  // 看 claimed_at 区分: NULL = 真 unclaimed; 已有值 = 已 claim (无论 anon 还是 logged-in).
  // For logged-in users: show all slots (they can bind any).
  let availableSlots = $derived((session?.members ?? []).filter((m: SessionMember) => {
    if (user) {
      // Logged-in users see all slots (any can be bound)
      return true;
    }
    // Anonymous users only see truly unclaimed slots (no secret, no claim time).
    // 注意: preview API 把 m.claimed_at 映射成 m.joined_at (BE /preview 返 _iso(m.claimed_at)).
    // 真 unclaimed: claimed_at === null 字符串 ('') 来自 mapping 时的 `?? ''`.
    // 实际看 preview response: claimed_at 是 ISO string 或 null.
    return m.user_id === null && (!m.joined_at || m.joined_at === '');
  }));

  // Slots that are already claimed/bound (for display only)
  let takenSlots = $derived((session?.members ?? []).filter((m: SessionMember) => {
    if (user) return false; // Don't grey out for logged-in
    return m.user_id !== null;
  }));
</script>

<section>
  <h2>加入 session</h2>

  {#if loading}
    <p>正在加载…</p>
  {:else if error && !session && !invite}
    <div class="error">{error}</div>
  {:else}
    {#if invite}
      <p class="muted">
        来自 <strong>{invite.inviter_display_name}</strong> 的 session:
        <strong>{invite.session_name}</strong>
      </p>
    {:else if session}
      <p class="muted">
        Session: <strong>{session.name}</strong>
      </p>
    {/if}

    {#if error}
      <div class="error" style="margin-bottom: 1rem;">{error}</div>
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
                  class="slot-btn"
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
              placeholder="你的昵称"
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
    {:else}
      <!-- Anonymous user -->
      <div class="stack" style="max-width: 480px;">
        {#if availableSlots.length > 0}
          <div>
            <p class="label">选择已有昵称（先到先得）</p>
            <div class="slot-list">
              {#each availableSlots as slot (slot.id)}
                <button
                  class="slot-btn"
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
          <!-- Bug fix (PO 16:06 报 "未登录状态，选择已有昵称无法跳转 session"):
               anon user 看到已被认领的昵称列表, 点 slot 应该走 "登录找回" 流程
               (登录后 redirect 到 /sessions/{id} → onMount 检测已 member → 重进 session).
               改成可点击 button (之前是 <span disabled>).
               returnTo 用 /sessions/{id} 而**不** /sessions/{id}/join — 直接到 detail,
               避免登录后又卡在 join page. -->
          <div>
            <p class="label muted">已被认领的昵称</p>
            <div class="slot-list">
              {#each takenSlots as slot (slot.id)}
                <button
                  type="button"
                  class="slot-btn slot-btn-claimable"
                  onclick={() => handleClaimTaken(slot)}
                  title="点此登录后找回这个昵称"
                >
                  {slot.display_name}
                  {#if slot.email}
                    <span class="muted">（已被 {slot.email} 绑定）</span>
                  {/if}
                </button>
              {/each}
            </div>
            <p class="muted small" style="margin-top: 0.75rem;">
              如果这其中有你的昵称，<strong>点击该昵称</strong> 或 <a href="/auth/login?returnTo=/sessions/{sessionId}">点此登录</a> 找回。
            </p>
          </div>
        {/if}

        <hr />

        <div>
          <p class="label">新增我的昵称</p>
          <div class="row gap">
            <input
              type="text"
              placeholder="你想叫什么名字？"
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
    {/if}
  {/if}
</section>

<style>
  .slot-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.5rem;
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
    transition: background 0.15s;
  }
  .slot-btn:hover:not(:disabled) {
    background: rgba(99, 102, 241, 0.1);
  }
  .slot-btn:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
  .slot-btn.disabled {
    background: rgba(0, 0, 0, 0.03);
    border-color: rgba(0, 0, 0, 0.1);
    color: var(--color-text-muted);
    cursor: default;
  }
  /* PO 16:06 fix: taken slot 改成可点击 button 走登录找回流程. */
  .slot-btn-claimable {
    background: rgba(99, 102, 241, 0.06);
    border-color: rgba(99, 102, 241, 0.4);
    color: #4f46e5;
    cursor: pointer;
  }
  .slot-btn-claimable:hover {
    background: rgba(99, 102, 241, 0.14);
    border-color: rgba(99, 102, 241, 0.6);
  }
  .gap {
    gap: 0.5rem;
  }
  .row {
    display: flex;
  }
  hr {
    border: none;
    border-top: 1px solid rgba(0, 0, 0, 0.08);
    margin: 1rem 0;
  }
</style>
