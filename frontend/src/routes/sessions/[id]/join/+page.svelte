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
      toast.error('无效的 session');
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

<section>
  <h2>加入 session</h2>

  {#if loading}
    <p>正在加载…</p>
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
    {:else if preview}
      <p class="muted">
        Session: <strong>{preview.name}</strong>
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
          <div>
            <p class="label muted">已被认领的昵称</p>
            <div class="slot-list">
              {#each takenSlots as slot (slot.id)}
                <span class="slot-btn disabled">
                  {slot.display_name}
                  {#if (slot as SessionMember).email}
                    <span class="muted">（已被 {(slot as SessionMember).email} 绑定）</span>
                  {/if}
                </span>
              {/each}
            </div>
          </div>
        {/if}

        <hr />

        <div>
          <p class="label">新建一个角色（昵称）</p>
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
