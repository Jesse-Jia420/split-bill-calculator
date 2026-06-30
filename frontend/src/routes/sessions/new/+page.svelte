<script lang="ts">
  import { goto } from '$app/navigation';
  import { sendCode, verifyCode } from '$api/auth';
  import { createSession } from '$api/sessions';
  import { loadSessions } from '$stores/sessions';
  import { loadUser } from '$stores/user';

  let name = '';
  let code = '';
  let step: 'name' | 'verify' = 'name';
  let busy = false;
  let error: string | null = null;
  let hint: string | null = null;

  async function handleNext() {
    if (busy) return;
    error = null;
    hint = null;
    const trimmed = name.trim();
    if (!trimmed) {
      error = '请输入 session 名字';
      return;
    }
    busy = true;
    try {
      const user = await loadUser();
      if (!user) {
        // Need to log in first -- prompt for code is sent to the user's email.
        await sendCode(user?.email ?? '');
        // We don't know email here. Push user to /auth/login.
        error = '请先登录后再创建 session';
        await goto('/auth/login');
        return;
      }
      await sendCode(user.email);
      hint = '验证码已发送到 ' + user.email + ',请查收';
      step = 'verify';
    } catch (e: any) {
      const c = e?.code ?? '';
      if (c === 'rate limit exceeded') {
        error = '请求过于频繁,请稍后再试';
      } else {
        error = e?.message ?? '操作失败';
      }
    } finally {
      busy = false;
    }
  }

  async function handleCreate() {
    if (busy) return;
    error = null;
    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      error = '验证码是 6 位数字';
      return;
    }
    busy = true;
    try {
      const user = await loadUser();
      if (!user) {
        error = '请重新登录';
        await goto('/auth/login');
        return;
      }
      // Verify the code with the user's email (acts like a "create confirmation").
      await verifyCode(user.email, trimmed);
      // Then create the session. Backend doesn't require the code here,
      // but we keep the verification gate so the owner proves email ownership.
      const created = await createSession(name.trim());
      await loadSessions();
      await goto('/sessions/' + created.id);
    } catch (e: any) {
      const c = e?.code ?? '';
      if (c === 'invalid or expired code') {
        error = '验证码无效或已过期';
      } else {
        error = e?.message ?? '创建失败';
      }
    } finally {
      busy = false;
    }
  }
</script>

<section>
  <h2>新建 session</h2>
  <p class="muted">session = 一个记账本,可以是旅行 / 合租 / 聚餐…</p>

  <div class="stack" style="max-width: 480px;">
    {#if step === 'name'}
      <div>
        <label class="label" for="name">名字</label>
        <input id="name" type="text" bind:value={name} placeholder="例: 2026 曼谷之旅" maxlength="200" />
      </div>
      <button class="primary" on:click={handleNext} disabled={busy}>
        {busy ? '发送验证码…' : '下一步:验证我的邮箱'}
      </button>
    {:else}
      <p>session 名: <strong>{name}</strong></p>
      <div>
        <label class="label" for="code">邮箱验证码</label>
        <input id="code" type="text" inputmode="numeric" maxlength="6" bind:value={code} placeholder="6 位数字" autocomplete="one-time-code" />
      </div>
      <div class="row" style="gap: var(--space-2);">
        <button class="primary" on:click={handleCreate} disabled={busy}>
          {busy ? '创建中…' : '创建'}
        </button>
        <button class="ghost" on:click={() => { step = 'name'; code = ''; error = null; hint = null; }} disabled={busy}>
          返回
        </button>
      </div>
    {/if}

    {#if hint}
      <div class="success">{hint}</div>
    {/if}
    {#if error}
      <div class="error">{error}</div>
    {/if}
  </div>
</section>