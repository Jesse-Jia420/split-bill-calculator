<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { sendCode, verifyCode } from '$api/auth';
  import { loadUser } from '$stores/user';

  let email = '';
  let code = '';
  let step: 'send' | 'verify' = 'send';
  let busy = false;
  let error: string | null = null;
  let hint: string | null = null;

  onMount(async () => {
    const u = await loadUser();
    if (u) {
      // Already logged in -- go to /sessions.
      await goto('/sessions', { replaceState: true });
    }
  });

  async function handleSend() {
    if (busy) return;
    error = null;
    hint = null;
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes('@')) {
      error = '请输入有效邮箱';
      return;
    }
    busy = true;
    try {
      const res = await sendCode(trimmed);
      hint = '验证码已发送 (' + res.ttl_minutes + ' 分钟内有效)';
      step = 'verify';
    } catch (e: any) {
      const code = e?.code ?? '';
      if (code === 'rate limit exceeded') {
        error = '请求过于频繁,请稍后再试';
      } else if (code === 'invalid email format') {
        error = '邮箱格式不正确';
      } else {
        error = e?.message ?? '发送失败';
      }
    } finally {
      busy = false;
    }
  }

  async function handleVerify() {
    if (busy) return;
    error = null;
    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      error = '验证码是 6 位数字';
      return;
    }
    busy = true;
    try {
      await verifyCode(email.trim(), trimmed);
      await loadUser();
      await goto('/sessions');
    } catch (e: any) {
      const c = e?.code ?? '';
      if (c === 'invalid or expired code') {
        error = '验证码无效或已过期';
      } else {
        error = e?.message ?? '验证失败';
      }
    } finally {
      busy = false;
    }
  }
</script>

<section class="login">
  <h2>登录</h2>
  <p class="muted">用邮箱收验证码即可登录,无需密码。</p>

  <div class="stack">
    <div>
      <label class="label" for="email">邮箱</label>
      <input
        id="email"
        type="email"
        bind:value={email}
        placeholder="you@example.com"
        autocomplete="email"
        disabled={step === 'verify' && busy}
      />
    </div>

    {#if step === 'send'}
      <button class="primary" on:click={handleSend} disabled={busy}>
        {busy ? '发送中…' : '发送验证码'}
      </button>
    {:else}
      <div>
        <label class="label" for="code">验证码</label>
        <input
          id="code"
          type="text"
          inputmode="numeric"
          maxlength="6"
          bind:value={code}
          placeholder="6 位数字"
          autocomplete="one-time-code"
        />
      </div>
      <div class="row" style="gap: var(--space-2);">
        <button class="primary" on:click={handleVerify} disabled={busy}>
          {busy ? '验证中…' : '验证并登录'}
        </button>
        <button class="ghost" on:click={() => { step = 'send'; code = ''; error = null; hint = null; }} disabled={busy}>
          重新发送
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

<style>
  .login {
    max-width: 400px;
    margin: var(--space-6) auto;
  }
</style>