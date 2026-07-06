<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { getInvite, acceptInvite } from '$api/invites';
  import { loadUser } from '$stores/user';
  import { loadSessions } from '$stores/sessions';
  import type { InvitePublicView } from '$api/invites';

  let loading = true;
  let error: string | null = null;
  let invite: InvitePublicView | null = null;
  let user: { user_id: number; email: string; default_name: string } | null = null;
  let displayName = '';
  let busy = false;

  $: token = page.params.token ?? '';

  onMount(async () => {
    if (!token) {
      error = '邀请链接无效';
      loading = false;
      return;
    }
    const [inviteRes, userRes] = await Promise.allSettled([
      getInvite(token),
      loadUser(),
    ]);
    if (inviteRes.status === 'fulfilled') {
      invite = inviteRes.value;
    } else {
      const code = inviteRes.reason?.code ?? '';
      if (code === 'invite no longer available' || inviteRes.reason?.status === 410) {
        error = '此邀请链接已失效(被撤销、已接受或已过期)';
      } else if (inviteRes.reason?.status === 404) {
        error = '邀请链接不存在';
      } else {
        error = '无法读取邀请:' + (inviteRes.reason?.message ?? '未知错误');
      }
      loading = false;
      return;
    }
    user = userRes.status === 'fulfilled' ? userRes.value : null;
    if (user) {
      displayName = user.default_name;
    }
    loading = false;
  });

  async function handleAccept() {
    if (busy) return;
    error = null;
    const trimmed = displayName.trim();
    if (!trimmed) {
      error = '请输入你在这个 session 里的昵称';
      return;
    }
    busy = true;
    try {
      const res = await acceptInvite(token, { display_name: trimmed });
      await loadSessions();
      await goto('/sessions/' + res.session_id, { replaceState: true });
    } catch (e: any) {
      const c = e?.code ?? '';
      if (c === 'not authenticated') {
        await goto('/auth/login?next=/invites/' + token, { replaceState: true });
        return;
      }
      if (c === 'invite no longer available' || e?.status === 410) {
        error = '此邀请已失效';
      } else {
        error = e?.message ?? '加入失败';
      }
    } finally {
      busy = false;
    }
  }
</script>

<section>
  <h2>加入 session</h2>

  {#if loading}
    <p>正在加载邀请…</p>
  {:else if !invite}
    <div class="error">{error}</div>
  {:else if invite.status !== 'active'}
    <div class="error">此邀请链接已{invite.status === 'accepted' ? '被接受' : invite.status === 'expired' ? '过期' : '被撤销'}。</div>
  {:else if !user}
    <p>你需要先登录才能加入 session。</p>
    <p class="muted">邀请来自 <strong>{invite.inviter_display_name}</strong> 的 session:<strong>{invite.session_name}</strong></p>
    <div class="stack" style="max-width: 320px;">
      <a class="primary" href="/auth/login?next=/invites/{token}">登录 / 注册</a>
    </div>
  {:else}
    <p class="muted">邀请来自 <strong>{invite.inviter_display_name}</strong> 的 session:<strong>{invite.session_name}</strong></p>
    <p>登录身份:<strong>{user.email}</strong></p>
    <div class="stack" style="max-width: 480px;">
      <div>
        <label class="label" for="display_name">你在这个 session 里的昵称</label>
        <input id="display_name" type="text" bind:value={displayName} maxlength="50" />
        <p class="muted" style="font-size: var(--font-size-sm);">在同一 session 内可以与你的默认昵称不同(例如「老王」)</p>
      </div>
      <button class="primary" on:click={handleAccept} disabled={busy}>
        {busy ? '加入中…' : '加入 session'}
      </button>
      {#if error}
        <div class="error">{error}</div>
      {/if}
    </div>
  {/if}
</section>
