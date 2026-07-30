<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { sendCode, verifyCode } from '$api/auth';
  import { bindActingMember, getSessionPreview, getSessionPreviewByCode } from '$api/sessions';
  import { loadUser } from '$stores/user';
  import { toast } from '$stores/toast';

  let email = '';
  let code = '';
  let step: 'send' | 'verify' = 'send';
  let busy = false;
  // §3.11.13 决策 α/β/γ/δ/ε/ζ — 根据 returnTo + actingAs 上下文动态切换.
  // 默认 = "登录"; 场景 A (从 join 页点 logged-in slot 来) → "嗨 X，请登录";
  // 场景 C (在 session 内 + 有 secret, 非 join) → "登录以保存 {账本名} 账单".
  let pageTitle = '登录';
  /** True when coming from ledger "登录以保存" — hide landing anon CTA. */
  let isSaveLedgerFlow = false;

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

    // PO 2026-07-10 #1: ?use=<display_name> 表明 anon 点了 logged-in bound slot
    // (BE 返 403 requires_login), 登录页显 "请登录以使用 <昵称>".
    // 这个 use 检查在 deriveLoginContext 之前, 优先于其他 H2 推导.
    const useNameRaw = page.url.searchParams.get('use');
    if (useNameRaw) {
      const useName = useNameRaw.trim();
      // 安全过滤: 1-50 字符, 允许中文/英文/数字/下划线/空格
      if (useName.length >= 1 && useName.length <= 50 && /^[\w\s\u4e00-\u9fa5]+$/.test(useName)) {
        pageTitle = `请登录以使用 ${useName}`;
        isSaveLedgerFlow = true; // also hide "直接开始使用"
      }
    }

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
   * Derive login H2 from returnTo.
   * - /s/{code} or /sessions/{id} (ledger save): 「登录以保存 {name} 账单」+ hide anon CTA
   * - join flow: 「嗨 X，请登录」
   * - landing / no returnTo: keep 「登录」+ show 「直接开始使用」
   */
  async function deriveLoginContext() {
    if (!returnTo) return;

    const codeMatch = returnTo.match(/^\/s\/([^/?#]+)(\/|$)/);
    const idMatch = returnTo.match(/^\/sessions\/(\d+)(\/|$)/);
    const isJoinFlow =
      /\/join(\/|$|\?)/.test(returnTo) ||
      (codeMatch != null && returnTo.includes('/join')) ||
      (idMatch != null && returnTo.includes('/join'));

    // Any ledger returnTo (detail / settle / join) hides landing "直接开始使用".
    if (codeMatch || idMatch) {
      isSaveLedgerFlow = true;
    }

    try {
      if (codeMatch) {
        const code = decodeURIComponent(codeMatch[1]);
        const preview = await getSessionPreviewByCode(code);
        if (isJoinFlow) {
          const sid = preview.id;
          const secret =
            typeof localStorage !== 'undefined'
              ? localStorage.getItem(`sbc.actingAs.${sid}`) ??
                localStorage.getItem(`sbc.actingAs.${code}`)
              : null;
          const me = secret
            ? preview.members.find((x) => x.nickname_secret === secret)
            : null;
          if (me?.display_name) {
            pageTitle = `嗨 ${me.display_name}，请登录`;
          }
        } else if (preview.name) {
          pageTitle = `登录以保存 ${preview.name} 账单`;
        }
        return;
      }

      if (idMatch) {
        const sid = parseInt(idMatch[1], 10);
        const preview = await getSessionPreview(sid);
        if (isJoinFlow) {
          const secret =
            typeof localStorage !== 'undefined'
              ? localStorage.getItem(`sbc.actingAs.${sid}`)
              : null;
          const me = secret
            ? preview.members.find((x) => x.nickname_secret === secret)
            : null;
          if (me?.display_name) {
            pageTitle = `嗨 ${me.display_name}，请登录`;
          }
        } else if (preview.name) {
          pageTitle = `登录以保存 ${preview.name} 账单`;
        }
      }
    } catch {
      // Keep default / previously set title
    }
  }

  async function handleSend() {
    if (busy) return;
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes('@')) {
      toast.error('请输入有效邮箱', 4000);
      return;
    }
    busy = true;
    try {
      const res = await sendCode(trimmed);
      toast.success('验证码已发送 (' + res.ttl_minutes + ' 分钟内有效)');
      step = 'verify';
    } catch (e: any) {
      const code = e?.code ?? '';
      if (code === 'rate limit exceeded') {
        toast.error('请求过于频繁,请稍后再试', 4000);
      } else if (code === 'invalid email format') {
        toast.error('邮箱格式不正确', 4000);
      } else {
        toast.error(e?.message ?? '发送失败', 4000);
      }
    } finally {
      busy = false;
    }
  }
  async function handleAnonStart() {
    await goto('/sessions/new', { replaceState: true });
  }

  /**
   * §3.11.14: After verify_code 200, try to bind the anon-acting localStorage
   * secret to the now-logged-in user. Silent on failure (slot already bound /
   * rotated by β / session expired) — the user still falls back to anon-acting
   * inside the session via the localStorage secret.
   */
  async function tryBindActingMember() {
    if (!returnTo) return;
    // Product G: support both /sessions/{id} and /s/{code} returnTo.
    let sid: number | null = null;
    let secret: string | null = null;
    const idMatch = returnTo.match(/^\/sessions\/(\d+)(\/|$)/);
    const codeMatch = returnTo.match(/^\/s\/([^/?#]+)(\/|$)/);
    if (idMatch) {
      sid = parseInt(idMatch[1], 10);
      secret = typeof localStorage !== 'undefined'
        ? localStorage.getItem(`sbc.actingAs.${sid}`)
        : null;
    } else if (codeMatch) {
      const code = decodeURIComponent(codeMatch[1]);
      secret = typeof localStorage !== 'undefined'
        ? (localStorage.getItem(`sbc.actingAs.${code}`) ?? null)
        : null;
      try {
        const preview = await getSessionPreviewByCode(code);
        sid = preview.id;
        if (!secret && typeof localStorage !== 'undefined') {
          secret = localStorage.getItem(`sbc.actingAs.${sid}`);
        }
        // Keep both keys in sync after bind path.
        if (secret && typeof localStorage !== 'undefined') {
          localStorage.setItem(`sbc.actingAs.${sid}`, secret);
          localStorage.setItem(`sbc.actingAs.${code}`, secret);
        }
      } catch {
        return;
      }
    }
    if (!sid || !secret) return;
    try {
      await bindActingMember(sid, { nickname_secret: secret });
    } catch {
      // 静默吞掉: slot 已被 β 轮换 / 已绑 user_id / session 过期
    }
  }

  async function handleVerify() {
    if (busy) return;
    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      toast.error('验证码是 6 位数字', 4000);
      return;
    }
    busy = true;
    try {
      await verifyCode(email.trim(), trimmed);
      await loadUser();
      await tryBindActingMember();  // §3.11.14 新加
      // Navigate to safe returnTo (or default /sessions).
      await goto(returnTo ?? '/sessions', { invalidateAll: true });
    } catch (e: any) {
      const c = e?.code ?? '';
      if (c === 'invalid or expired code') {
        toast.error('验证码无效或已过期', 4000);
      } else {
        toast.error(e?.message ?? '验证失败', 4000);
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
        class="glass-input"
        type="email"
        bind:value={email}
        placeholder="you@example.com"
        autocomplete="email"
        disabled={step === 'verify' && busy}
      />
    </div>

    {#if step === 'send'}
      <button class="btn btn-primary" onclick={handleSend} disabled={busy}>
        {busy ? '发送中…' : '发送验证码'}
      </button>
      {#if !isSaveLedgerFlow}
        <div class="or-divider">
          <span>或</span>
        </div>
        <p class="anon-hint">不想登录？</p>
        <button class="glass-pill anon-start" onclick={handleAnonStart}>
          直接开始使用
        </button>
      {/if}
    {:else}
      <div>
        <label class="label" for="code">验证码</label>
        <input
          id="code"
          class="glass-input"
          type="text"
          inputmode="numeric"
          maxlength="6"
          bind:value={code}
          placeholder="6 位数字"
          autocomplete="one-time-code"
        />
      </div>
      <div class="row" style="gap: var(--space-2);">
        <button class="btn btn-primary" onclick={handleVerify} disabled={busy}>
          {busy ? '验证中…' : '验证并登录'}
        </button>
        <button class="btn glass-pill" onclick={() => { step = 'send'; code = ''; }} disabled={busy}>
          重新发送
        </button>
      </div>
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

  .or-divider {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 1.75rem 0 1.25rem;
    color: var(--color-text-muted, #9ca3af);
    font-size: 0.8125rem;
  }
  .or-divider::before,
  .or-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--color-border, #e5e5e5);
  }
  .anon-hint {
    text-align: center;
    font-size: 0.9rem;
    color: var(--color-text-muted, #6b7280);
    margin: 0 0 0.75rem;
  }
  .anon-start {
    width: 100%;
    min-height: 52px;
    font-size: 1rem;
    font-weight: 600;
  }
</style>