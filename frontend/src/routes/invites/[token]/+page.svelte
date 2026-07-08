<script lang="ts">
  /**
   * v0.3.2 bug fix (PRD §3.10.5) — /invites/{token} 4-case dispatch.
   *
   * Before v0.3.2 this page was stuck at v0.2.x behaviour:
   *   - anon visitor → "你需要先登录" + button to /auth/login (forced login)
   *   - logged-in visitor → "你在这个 session 里的昵称" input + manual "加入 session" button
   * Both branches ignored PRD §3.10.5's 4-case dispatch table.
   *
   * After v0.3.2 (this rewrite):
   *   | 访问者状态                                              | 行为                                    |
   *   | ------------------------------------------------------- | --------------------------------------- |
   *   | 已登录 + 已有 (user_id, session_id) 绑定                | auto-match → /sessions/{id}            |
   *   | 已登录 + 无绑定                                          | → /sessions/{id}/join                   |
   *   | 未登录 / 匿名 (无 secret)                                | → /sessions/{id}/join                   |
   *   | 匿名 + localStorage 有 sbc.actingAs.{sid}               | FE 自动取 secret → BE 验证 → /sessions/{id} |
   *
   * Implementation notes:
   *   - Reuses getInvite (public) for token → session_id lookup.
   *   - Reuses getSession (which reads localStorage X-Nickname-Secret) for the
   *     verify + auto-match path. No new BE endpoints.
   *   - The actual join/claim UI lives at /sessions/[id]/join (handles both
   *     anon and logged-in flows via join_claim endpoint). This page is just a
   *     dispatcher.
   *   - The legacy POST /invites/{token}/accept endpoint (BE) is NOT used by
   *     this page anymore; it stays for owner admin actions per PRD §3.10.5.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { getInvite } from '$api/invites';
  import { getSession } from '$api/sessions';
  import { loadUser } from '$stores/user';

  // localStorage key prefix — matches sessions.ts + /join page.
  const LS_PREFIX = 'sbc.actingAs.';

  let token = $derived(page.params.token ?? '');
  let loading = $state(true);
  let error: string | null = $state(null);

  onMount(async () => {
    if (!token) {
      error = '邀请链接无效';
      loading = false;
      return;
    }

    // Step 1: Resolve invite token → session_id (public, no auth required).
    let sessionId: number;
    try {
      const invite = await getInvite(token);
      if (invite.status !== 'active') {
        error =
          '此邀请链接已' +
          (invite.status === 'expired'
            ? '过期'
            : invite.status === 'accepted'
              ? '被接受'
              : '失效') +
          '。';
        loading = false;
        return;
      }
      sessionId = invite.session_id;
    } catch (e: any) {
      const status = e?.status ?? e?.detail?.status;
      if (status === 404) {
        error = '邀请链接不存在';
      } else if (status === 410) {
        error = '此邀请链接已失效(被撤销、已接受或已过期)';
      } else {
        error = e?.message ?? '无法读取邀请';
      }
      loading = false;
      return;
    }

    // Step 2: Determine user state (logged-in or anon).
    const user = await loadUser();

    // Step 3: Check localStorage for an acting-as secret for THIS session.
    // Key format is `sbc.actingAs.{sessionId}` (see sessions.ts + /join page).
    const hasSecretForThisSession =
      typeof window !== 'undefined' &&
      Boolean(localStorage.getItem(LS_PREFIX + sessionId));

    // Step 4: 4-case dispatch (see table at top of file).

    // Case A: anon + has secret for this session → verify with BE → direct in
    if (!user && hasSecretForThisSession) {
      try {
        await getSession(sessionId);
        await goto('/sessions/' + sessionId, { replaceState: true });
        return;
      } catch {
        // Secret invalid or expired — clear localStorage and fall through to /join
        if (typeof window !== 'undefined') {
          localStorage.removeItem(LS_PREFIX + sessionId);
        }
        await goto('/sessions/' + sessionId + '/join', { replaceState: true });
        return;
      }
    }

    // Case B: logged-in → try getSession (BE checks (user_id, session_id) binding)
    if (user) {
      try {
        await getSession(sessionId);
        await goto('/sessions/' + sessionId, { replaceState: true });
        return;
      } catch {
        // Not a member — fall through to /join
        await goto('/sessions/' + sessionId + '/join', { replaceState: true });
        return;
      }
    }

    // Cases C, D: anon (no secret for this session) → /join
    await goto('/sessions/' + sessionId + '/join', { replaceState: true });
  });
</script>

<svelte:head>
  <title>加入 session · Split Bill</title>
</svelte:head>

<main class="container" style="padding-top: 4rem; text-align: center;">
  {#if loading}
    <p>正在打开 session…</p>
  {:else if error}
    <h2>打不开</h2>
    <p class="muted">{error}</p>
    <p style="margin-top: 1.5rem;">
      <a href="/">回到首页</a>
    </p>
  {/if}
</main>