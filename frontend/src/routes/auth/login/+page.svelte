<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { sendCode, verifyCode } from '$api/auth';
  import { bindActingMember, getSessionPreview } from '$api/sessions';
  import { loadUser } from '$stores/user';

  let email = '';
  let code = '';
  let step: 'send' | 'verify' = 'send';
  let busy = false;
  let error: string | null = null;
  let hint: string | null = null;
  // §3.11.13 决策 α/β/γ/δ/ε/ζ — 根据 returnTo + actingAs 上下文动态切换.
  // 默认 = "登录"; 场景 A (从 join 页点 logged-in slot 来) → "嗨 X，请登录";
  // 场景 C (在 session 内 + 有 secret, 非 join) → "嗨 X，完成登录即可永久保存 session".
  let pageTitle = '登录';

  /**
   * Safe returnTo (post-login redirect target).
   *
   * Read from `?returnTo=` on mount and **validated** to prevent
   * open-redirect (a malicious link like `/auth/login?returnTo=//evil.com`
   * would otherwise navigate the just-logged-in user off-site).
   *
   * Rules (see T16 401 redirect):
   *   1. Must start with `/`            — relative paths only
   *   2. Must NOT start with `//`        — `//evil.com` is a protocol-relative URL
   *   3. Must NOT equal `/auth/login`   — would loop the login page
   *
   * Anything else → no returnTo; we fall back to `/sessions` after login.
   */
  let returnTo: string | null = null;
  let expired = false;

  onMount(async () => {
    // Read returnTo from URL (only on client; $page is reactive in svelte).
    const raw = page.url.searchParams.get('returnTo');
    returnTo = sanitizeReturnTo(raw);

    expired = page.url.searchParams.get('expired') === '1';

    // §3.11.13: 在 loadUser 前 derive 上下文, 决定 H2 文案.
    await deriveLoginContext();

    // Test-mode pre-fill: ?email=foo&code=123456 lets e2e specs jump
    // straight to the verify step without going through /auth/send-code
    // (which would require a real SMTP roundtrip in CI).
    const qpEmail = page.url.searchParams.get('email');
    const qpCode = page.url.searchParams.get('code');
    if (qpEmail) email = qpEmail;
    if (qpCode && /^\d{6}$/.test(qpCode)) {
      code = qpCode;
      step = 'verify';
    }

    const u = await loadUser();
    if (u) {
      // Already logged in -- go to /sessions (or returnTo if valid).
      await goto(returnTo ?? '/sessions', { replaceState: true });
    }
  });

  function sanitizeReturnTo(raw: string | null): string | null {
    if (!raw) return null;
    if (!raw.startsWith('/')) return null;
    if (raw.startsWith('//')) return null; // protocol-relative = open-redirect
    if (raw === '/auth/login') return null; // avoid loop
    return raw;
  }

  /**
   * §3.11.13: 根据 returnTo + localStorage actingAs secret + BE preview
   * 推导登录页 H2 文案. 失败或场景不匹配 → 保持默认 '登录'.
   */
  async function deriveLoginContext() {
    if (!returnTo) return; // 场景 B (无 returnTo): 保持 '登录'

    const m = returnTo.match(/^\/sessions\/(\d+)(\/|$)/);
    if (!m) return; // 非 session 路由: 保持默认
    const sid = parseInt(m[1], 10);
    const isJoinFlow = returnTo.includes(`/sessions/${sid}/join`);

    // localStorage 只在浏览器端可用
    const secret = typeof localStorage !== 'undefined'
      ? localStorage.getItem(`sbc.actingAs.${sid}`)
      : null;
    if (!secret) return; // 场景 C 需要 secret, 没 secret → 降级到默认

    let preview;
    try {
      preview = await getSessionPreview(sid);
    } catch {
      return; // 失败降级到默认
    }
    const me = preview.members.find((x) => x.nickname_secret === secret);
    if (!me || !me.display_name) return; // 找不到对应 slot → 默认

    if (isJoinFlow) {
      pageTitle = `嗨 ${me.display_name}，请登录`;
    } else {
      pageTitle = `嗨 ${me.display_name}，完成登录即可永久保存 session`;
    }
  }

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

  /**
   * §3.11.14: After verify_code 200, try to bind the anon-acting localStorage
   * secret to the now-logged-in user. Silent on failure (slot already bound /
   * rotated by β / session expired) — the user still falls back to anon-acting
   * inside the session via the localStorage secret.
   */
  async function tryBindActingMember() {
    console.log('[§3.11.14 DEBUG] tryBindActingMember called, returnTo=', returnTo);
    if (!returnTo) {
      console.log('[§3.11.14 DEBUG] early return: returnTo null');
      return;
    }
    const m = returnTo.match(/^\/sessions\/(\d+)(\/|$)/);
    if (!m) {
      console.log('[§3.11.14 DEBUG] early return: regex no match');
      return;
    }
    const sid = parseInt(m[1], 10);
    const secret = typeof localStorage !== 'undefined'
      ? localStorage.getItem(`sbc.actingAs.${sid}`)
      : null;
    console.log('[§3.11.14 DEBUG] sid=', sid, 'secret=', secret ? secret.substring(0, 8) + '...' : null);
    if (!secret) {
      console.log('[§3.11.14 DEBUG] early return: secret null');
      return;
    }
    try {
      const r = await bindActingMember(sid, { nickname_secret: secret });
      console.log('[§3.11.14 DEBUG] bind OK', r);
    } catch (e) {
      console.log('[§3.11.14 DEBUG] bind FAILED', e?.status, e?.message);
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
      await tryBindActingMember();  // §3.11.14 新加
      // Navigate to safe returnTo (or default /sessions).
      await goto(returnTo ?? '/sessions');
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
  <h2>{pageTitle}</h2>
  <p class="muted">用邮箱收验证码即可登录,无需密码。</p>

  {#if expired}
    <p class="hint-expired" data-testid="login-expired-hint">
      登录已过期,请重新登录。
    </p>
  {/if}

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
  .hint-expired {
    color: var(--color-text-muted, #6b7280);
    font-size: 0.875rem;
    margin: 0 0 var(--space-3);
  }
</style>