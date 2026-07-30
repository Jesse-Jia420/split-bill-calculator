<script lang="ts">
  /**
   * v0.3.29 — UAT 0725-1 #13 v4 Feature B + C: 新登录页 + 路由集成.
   *
   * URL: /sessions/{id}/login?as={memberId}&nickname={nickname}&emailMasked={masked_email}
   *
   * 来源: 从 /sessions/{id}/join 点击有邮箱槽位 → 跳到这里 (Feature A 点击分流).
   *
   * 跟 /auth/login 区别:
   * - /auth/login: 通用登录页 (returnTo 推导 H2 文案), 用于全站 401 redirect.
   * - /sessions/{id}/login: 账本专属登录页 (per-session, 从 join 跳转).
   *   H2 文案固定 "登录 {nickname}({emailMasked})以回到账本", 不依赖 returnTo.
   *
   * 设计语言 (PO v4 字面 + 配套 mockup v4-3-login.html):
   * - Header row (高 ~56-64px):
   *   左: 圆形 back FAB (settle 同款 56×56, rgba(99,102,241,0.16) 玻璃)
   *   右: pill "登录 →" 按钮 (半透明白 18px 圆角玻璃)
   * - 副标题区: "登录 {nickname}({emailMasked})以回到账本" (15px muted)
   *   nickname 用 indigo #4f46e5 高亮 + font-weight 600
   *   email 用更浅 muted gray
   * - "清迈" 副副标题 (13px 更浅)
   * - 表单: 邮箱 + 验证码 (空 value, placeholder, 不 pre-fill 真邮箱)
   * - 主 CTA: 全宽 "登录并回到账本" (indigo 渐变 #6366f1→#4f46e5)
   *
   * 反模式 (PO v4 强调):
   * - ❌ pre-fill 真邮箱到 input (让用户手填验证身份)
   * - ❌ 视觉提示 email 槽位"已被绑定" (PO v4 视觉平等)
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ArrowLeft } from 'lucide-svelte';
  import { ChevronRight } from 'lucide-svelte';
  import { sendCode, verifyCode } from '$api/auth';
  import { getSessionPreview, joinClaim } from '$api/sessions';
  import { loadUser } from '$stores/user';
  import { toast } from '$stores/toast';

  // 表单状态
  let email = $state('');
  let code = $state('');
  let step: 'send' | 'verify' = $state('send');
  let busy = $state(false);
  let codeCooldown = $state(0);  // 60s 倒计时 (disable button + show countdown)

  // 从 query params 拿: nickname, emailMasked, session name (从 preview 拿)
  let memberId = $derived(page.url.searchParams.get('as') || '');
  let nickname = $derived(page.url.searchParams.get('nickname') || '');
  let emailMasked = $derived(page.url.searchParams.get('emailMasked') || '');
  // v0.3.35 #7 — UAT 0725-3 #12: join page 选带邮箱 nickname 后跳过来时 query param `email` 传 raw email,
  // FE pre-check (handleSend function) 防 PO 字面 "邮箱与要登录的用户邮箱不一致则无法发送验证码".
  let expectedEmail = $derived(page.url.searchParams.get('email') || '');
  let sessionId = $derived(Number(page.params.id) || 0);
  let sessionName = $state('');  // 副副标题 "清迈" — 从 preview 拿

  onMount(async () => {
    // 拿 session 名称 (副副标题用)
    if (sessionId) {
      try {
        const preview = await getSessionPreview(sessionId);
        sessionName = preview.name;
      } catch {
        sessionName = '';  // 拿不到就空
      }
    }

    // 已登录用户: 直接跳走
    const u = await loadUser();
    if (u) {
      await goto(`/s/${page.url.searchParams.get('sessionCode') || sessionId}`, { replaceState: true });
    }
  });

  async function handleSend() {
    if (busy) return;
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes('@')) {
      toast.error('请输入有效邮箱', 4000);
      return;
    }
    // v0.3.35 #7 — UAT 0725-3 #12: FE pre-check expectedEmail match (大小写不敏感).
    // join page 选 nickname 后跳过来时 query param `email` = 该 nickname 绑定的 raw email,
    // 用户必须输入一致才发验证码请求 (BE 端也会 validate, defense in depth).
    if (expectedEmail && trimmed.toLowerCase() !== expectedEmail.toLowerCase()) {
      toast.error('邮箱与该昵称绑定的邮箱不一致, 请重新选择昵称', 4000);
      return;
    }
    busy = true;
    try {
      const res = await sendCode(trimmed);
      toast.success('验证码已发送 (' + res.ttl_minutes + ' 分钟内有效)');
      step = 'verify';
      // 60s 倒计时 (避免 spam / rate limit)
      codeCooldown = 60;
      const tick = setInterval(() => {
        codeCooldown -= 1;
        if (codeCooldown <= 0) clearInterval(tick);
      }, 1000);
    } catch (e: any) {
      const c = e?.code ?? '';
      if (c === 'rate limit exceeded') {
        toast.error('请求过于频繁,请稍后再试', 4000);
      } else if (c === 'invalid email format') {
        toast.error('邮箱格式不正确', 4000);
      } else {
        toast.error(e?.message ?? '发送失败', 4000);
      }
    } finally {
      busy = false;
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
      // Product C: after logging in as this nickname's email, bind/re-enter that seat.
      if (memberId) {
        try {
          await joinClaim(sessionId, {
            action: 'claim',
            session_member_id: Number(memberId),
          });
        } catch (claimErr: any) {
          const code = claimErr?.code ?? '';
          if (code === 'slot_owned_by_another_user') {
            toast.error('该昵称已绑定其他邮箱，请用对应邮箱登录', 4000);
            busy = false;
            return;
          }
          // already bound to self / other soft failures → continue to ledger
        }
      }
      // 验证成功后跳回账本详情
      await goto(`/s/${page.url.searchParams.get('sessionCode') || sessionId}`, { invalidateAll: true });
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

  function goBack() {
    // 跳回 join 页 (用户决定不登录了, 用回现有 anon 加入流程)
    goto(`/sessions/${sessionId}/join`);
  }
</script>

<!-- v0.3.33 — UAT 0725-3 #1 (PO 14:59 batch):
     页面 redesign.
       - 删顶部「登录 →」pill (原来 header 右侧 decorative pill, 跟主 CTA 文案重复, 视觉冲突)
       - 返回按钮从 header 移到 主 CTA「登录并回到账本」左侧 (形成 cta-row: back FAB + submit pill)
       - 主 CTA 改 pill 形 (border-radius 14px → 999px, 全宽 = 减去 back FAB 宽 = 容器宽 - 56px - 12px gap)
       - 视觉一致性: back FAB 在 submit pill 左侧 row 布局, 主操作只有 1 个, 避免双 CTA 误读
-->
<section class="login-page">
  <!-- header 保留空白 (PO 字面「取消」header 顶部 pill + 返回 FAB, 不再放任何控件) -->
  <header class="login-header" data-testid="login-header"></header>

  <!-- v0.3.29 #13 v4 Feature B: 副标题区 -->
  <p class="page-title" data-testid="login-subtitle">
    登录 <span class="nickname">{nickname || '用户'}</span><span class="email-wrap"><span class="paren">(</span>{emailMasked || 'x***@outlook.com'}<span class="paren">)</span></span>以回到账本
  </p>

  {#if sessionName}
    <p class="page-subtitle" data-testid="login-session-name">
      <span class="session-name">{sessionName}</span>
    </p>
  {/if}

  <!-- v0.3.29 #13 v4 Feature B: 表单 -->
  <div class="form-section">
    <!-- 邮箱 -->
    <div class="form-field">
      <label class="form-label" for="email">邮箱<span class="required">*</span></label>
      <input
        id="email"
        class="glass-input"
        type="email"
        bind:value={email}
        placeholder="请输入邮箱"
        autocomplete="off"
        disabled={busy && step === 'verify'}
        data-testid="login-email-input"
      />
    </div>

    <!-- 验证码 -->
    <div class="form-field">
      <label class="form-label" for="code">验证码<span class="required">*</span></label>
      <div class="code-row">
        <input
          id="code"
          class="glass-input"
          type="text"
          inputmode="numeric"
          maxlength="6"
          bind:value={code}
          placeholder="请输入 6 位验证码"
          autocomplete="off"
          disabled={step === 'send'}
          data-testid="login-code-input"
        />
        <button
          class="btn-code"
          type="button"
          onclick={handleSend}
          disabled={busy || codeCooldown > 0}
          data-testid="login-send-code-btn"
        >
          {#if codeCooldown > 0}{codeCooldown}s{:else}获取验证码{/if}
        </button>
      </div>
      <!-- helper: 验证码将发送至 {masked email} -->
      <p class="helper-text" data-testid="login-code-helper">
        验证码将发送至 {emailMasked || 'x***@outlook.com'}
      </p>
    </div>

    <!-- v0.3.33 #1: cta-row (back FAB + submit pill) — back FAB 在 submit pill 左侧 -->
    <div class="cta-row">
      <button
        class="login-back-fab"
        type="button"
        aria-label="返回加入账本"
        onclick={goBack}
        data-testid="login-back-fab"
      >
        <ArrowLeft size={22} strokeWidth={2.5} />
      </button>

      <button
        class="btn-primary submit-pill"
        type="button"
        onclick={handleVerify}
        disabled={busy}
        data-testid="login-submit-btn"
      >
        {busy ? '验证中…' : '登录并回到账本'}
      </button>
    </div>
  </div>
</section>

<style>
  /* v0.3.29 — UAT 0725-1 #13 v4 Feature B: 登录页 (跟 /auth/login 区分).
   * 设计 mockup: /tmp/mockup-0725-1-13-v4-3-login.html
   * iOS app-shell 已由 +layout.svelte + app.css 全局处理 (html/body locked + main 内滚),
   * 这里只做 header + 表单 + 副标题视觉. */

  .login-page {
    max-width: 480px;
    margin: 0 auto;
    padding: 0 20px 24px;
  }

  /* ===== Header row (高 ~64px, v0.3.33 #1: header 现在空白, 保留 64px 占位) ===== */
  .login-header {
    height: 64px;
    padding: 4px 0;
    flex-shrink: 0;
  }

  /* 圆形 back FAB — 跟 settle v0.3.18 #63 同款 (56×56 玻璃 indigo).
     v0.3.33 #1: 从 header 移到 cta-row (submit pill 左侧). */
  .login-back-fab {
    flex: 0 0 auto;
    width: 56px;
    height: 52px;
    border-radius: 50%;
    background: rgba(99, 102, 241, 0.12);
    backdrop-filter: saturate(180%) blur(20px);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    border: 1.5px solid rgba(255, 255, 255, 0.5);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.6),
      0 4px 10px rgba(99, 102, 241, 0.14);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: transform 0.18s ease-out, background 0.18s ease-out;
    color: #4f46e5;
  }
  .login-back-fab:active {
    transform: scale(0.96);
    background: rgba(99, 102, 241, 0.20);
  }

  /* v0.3.33 — UAT 0725-3 #1: header pill 删了 (PO 字面「取消」), .login-pill-btn CSS 同步清理. */

  /* ===== 副标题区 ===== */
  .page-title {
    font-size: 15px;
    font-weight: 500;
    color: rgba(0, 0, 0, 0.62);
    margin: 4px 0 4px;
    line-height: 1.45;
    letter-spacing: -0.005em;
    word-break: break-word;
  }
  .page-title .nickname {
    color: #4f46e5;
    font-weight: 600;
  }
  .page-title .email-wrap {
    color: rgba(0, 0, 0, 0.42);
    font-weight: 500;
    font-feature-settings: "tnum";
  }
  .page-title .email-wrap .paren {
    color: rgba(0, 0, 0, 0.32);
    font-weight: 400;
  }
  .page-subtitle {
    font-size: 13px;
    font-weight: 400;
    color: rgba(0, 0, 0, 0.42);
    margin-bottom: 28px;
    line-height: 1.5;
  }
  .page-subtitle .session-name {
    color: rgba(0, 0, 0, 0.7);
    font-weight: 600;
  }

  /* ===== 表单 ===== */
  .form-section {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .form-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .form-label {
    font-size: 13px;
    font-weight: 600;
    color: #374151;
    letter-spacing: 0.01em;
  }
  .form-label .required {
    color: #ec4899;
    margin-left: 2px;
  }
  .glass-input {
    width: 100%;
    height: 52px;
    padding: 0 16px;
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.62);
    backdrop-filter: saturate(180%) blur(20px);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    border: 1px solid rgba(99, 102, 241, 0.10);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.5),
      0 1px 3px rgba(15, 23, 42, 0.05);
    font-size: 16px;
    color: #171717;
    outline: none;
    -webkit-appearance: none;
  }
  .glass-input::placeholder { color: #9ca3af; }

  .code-row {
    display: flex;
    gap: 8px;
    align-items: stretch;
  }
  .code-row .glass-input {
    flex: 1;
    min-width: 0;
  }
  .btn-code {
    height: 52px;
    padding: 0 16px;
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.62);
    backdrop-filter: saturate(180%) blur(20px);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    border: 1px solid rgba(99, 102, 241, 0.20);
    color: #6366f1;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
    white-space: nowrap;
    letter-spacing: 0.01em;
  }
  .btn-code:active {
    background: rgba(255, 255, 255, 0.85);
  }
  .btn-code:disabled {
    color: #9ca3af;
    cursor: not-allowed;
  }

  /* cta-row: back FAB 56×56 + submit pill 全宽, 12px gap. PO 字面「返回按钮移到提交 btn 左侧」. */
  .cta-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 8px;
    width: 100%;
  }

  /* 主 CTA — pill 形 (border-radius 999px), 占 cta-row 剩余宽度 (calc(100% - 56px - 12px)). */
  .btn-primary.submit-pill {
    flex: 1 1 auto;
    min-width: 0;
    height: 52px;
    padding: 0 20px;
    border-radius: 999px;
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.95) 0%, rgba(168, 85, 247, 0.95) 100%);
    color: white;
    font-size: 16px;
    font-weight: 600;
    border: none;
    cursor: pointer;
    box-shadow:
      0 4px 12px rgba(99, 102, 241, 0.30),
      inset 0 1px 0 rgba(255, 255, 255, 0.25);
    letter-spacing: 0.01em;
  }
  .btn-primary:active {
    background: linear-gradient(135deg, rgba(99, 102, 241, 1) 0%, rgba(168, 85, 247, 1) 100%);
  }
  .btn-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .helper-text {
    font-size: 12px;
    color: #6b7280;
    margin-top: 6px;
    line-height: 1.4;
  }
</style>
