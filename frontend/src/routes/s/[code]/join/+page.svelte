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
   *
   * v0.3.29 — UAT 0725-1 #13 v4: 合并两段列表为一段 (PO v4 字面).
   * - 旧版分 "选择已有昵称" + "选择昵称以回到账本" 两段, 中间夹 "或" 字 divider.
   * - PO v2 拍板: 视觉平等 — 无邮箱/有邮箱用户同等对待 (不置灰, 无 chevron, 无 "已被 xxx 绑定" 文案).
   * - 段标题统一为 "选择昵称加入账本", 内含混合槽位 (有邮箱显示 masked email 副行, 无邮箱只显昵称).
   * - 点击分流: 有邮箱 → /sessions/{id}/login?as=...&nickname=...&emailMasked=...,
   *              无邮箱 → 现有 handleClaim (匿名 claim, 落 localStorage secret).
   * - maskEmail 抽到 lib/utils/mask.ts (v0.3.29 #13 v4 #5), 跨 join 页 + 登录页共享.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    getSessionByCode,
    getSessionPreview,
    getSessionPreviewByCode,
    joinClaim,
    type SessionDetail,
    type SessionMember,
    type SessionPreview,
    type SessionMemberPreview
  } from '$api/sessions';
  import { getInvite, type InvitePublicView } from '$api/invites';
  import { loadUser } from '$stores/user';
  import { toast } from '$stores/toast';
  // v0.3.29 — UAT 0725-1 #13 v4 #5: maskEmail 抽到 lib/utils/mask.ts (跨 join 页 + 登录页共享).
  import { maskEmail } from '$lib/utils/mask';
  // v0.3.28 UAT 0724-1 #5 (Option C 玻璃圆环): /sessions/[id]/join 路由.
  import LoadingOverlay from '$components/LoadingOverlay.svelte';

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
  type AnyMember = SessionMember | SessionMemberPreview;
  function _combinedMembers(): AnyMember[] {
    const fromDetail: SessionMember[] = session?.members ?? [];
    const fromPreview: SessionMemberPreview[] = preview?.members ?? [];
    return (fromDetail.length > 0 ? fromDetail : fromPreview) as AnyMember[];
  }
  let members = $derived(_combinedMembers());

  // Join form state
  let newNickname = $state('');
  let selectedSlotId: number | null = $state(null);
  let busy = $state(false);

  // v0.3.36 — UAT 0727-1 #8 sub-route: /s/{session_code}/join 用 code 替代 id.
  // sessionId 一开始 = 0; 首次 onMount 通过 getSessionByCode(code) 拿到 session 后回填.
  // 注: join 页 anon 非成员也能访问 — getSessionByCode BE 端 anon 路径返 403
  // (BUG-V031-A: 403 detail 包含 session_id). 本页面也用 getSessionPreview (匿名公开).
  let code = $derived(page.params.code ?? '');
  let sessionId = $state(0);
  let inviteToken = $derived(page.url.searchParams.get('token'));

  onMount(async () => {
    if (!code) {
      // v0.3.15 (PO #4807): 错误统一走 Toast
      toast.error('无效的 账本');
      loading = false;
      return;
    }

    user = await loadUser();

    // Step 1: try to find an acting-as entry for this session in localStorage
    // 跨 session lookup: actingAs.{sid} 需要先 resolve code → sid. 第一次 resolve 用
    // getSessionByCode (走 BE dep get_session_member_or_secret, anon 路径用 secret).
    if (typeof window !== 'undefined') {
      // v0.3.36 — 用 code 替代 id: actingAs 仍 per-id 存 (sbc.actingAs.{sid}),
      // 需要先解析 code → sid 才能 lookup. 简单方案: 全 localStorage 扫描 sbc.actingAs.*
      // 然后 try 每个 secret via getSessionByCode 验证 (若 secret 配 code).
      // 实际上更简单: 直接 getSessionByCode(code), BE 端用 X-Nickname-Secret 自动 member match,
      // 返 X-SBC-Member-ID 头 → 不需要本地 secret 找.
      try {
        const verified = await getSessionByCode(code);
        session = verified.session;
        sessionId = verified.session.id;
        // v0.3.x (UAT #0723-3 #3): 跳 /s/{session_code} (unguessable).
        // 已在此页, 不用 redirect. 但保留旧 redirect 行为防 localStorage stale.
        await goto('/s/' + code, { replaceState: true });
        return;
      } catch {
        // 404 (no code match) or 403 (anon not member): fall through to join page
      }
    }

    // Step 2: if logged in, check if already a member
    // 跟 Step 1 同模式 — getSessionByCode 自动 apply cookie auth (logged-in user)
    if (user) {
      try {
        const verified = await getSessionByCode(code);
        session = verified.session;
        sessionId = verified.session.id;
        // Already a member — redirect to session
        await goto('/s/' + code, { replaceState: true });
        return;
      } catch {
        // Not a member — fall through to join page
      }
    }

    // Step 3: load public session preview (BUG-LANDING-1)
    // v0.3.0728-2 #3 — UAT 0728-2 #3 (PO msg 16:50) anon join 404 修复:
    //   原 getSessionPreview(sessionId) 需要 numeric id, 但 anon 路径 sessionId 一直 0
    //   (getSessionByCode anon 返 403, preview call 返 404, 然后 joinClaim(0, ...) 报错).
    //   改: 加 public /sessions/by-code/{code}/preview — anon 可访问, 返 numeric id 让后续 joinClaim 成功.
    if (sessionId === 0 && code) {
      try {
        const previewData = await getSessionPreviewByCode(code);
        preview = previewData;
        sessionId = previewData.id;
      } catch {
        // Preview by-code 不可访问 (session 不存在 / 超 7 天) — 让 join form 不显示预览, 用户仍能试输入
      }
    }
    // Fallback: 跳过 preview 直接走 join form (session name 暂不显示).
    if (sessionId > 0 && !preview) {
      try {
        preview = await getSessionPreview(sessionId);
      } catch {
        // Preview not available — ignore; invite + add-nickname form still work
      }
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
      // Logged-in claim returns nickname_secret=null (secret invalidated); clear LS.
      if (res.nickname_secret) {
        _storeActingAs(res.session_member_id, res.nickname_secret);
      } else {
        _clearActingAs();
      }
      // v0.3.36 — UAT 0727-1 #8: 用 URL `code` 直接 (always available from page.params.code).
      // 之前 const code = session?.session_code || ... shadow 外层 `code`, 现在不需要.
      await goto('/s/' + code, { replaceState: true });
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

  /**
   * v0.3.29 — UAT 0725-1 #13 v4: 邮箱绑定槽位的点击处理.
   * 跳到 /sessions/{id}/login, 让用户走"登录以使用该槽位"流程.
   * 不再直接 joinClaim (有邮箱槽位 user_id !== null, BE claim 会 409).
   */
  async function handleEmailSlotClick(slot: AnyMember) {
    if (busy) return;
    const email = (slot as SessionMember).email ?? (slot as SessionMemberPreview).email ?? null;
    if (!email) {
      // 防御性 fallback: 没邮箱但走到这里 → 当 anon 处理
      await handleClaim(slot.id);
      return;
    }
    busy = true;
    try {
      const params = new URLSearchParams({
        as: String(slot.id),
        nickname: slot.display_name,
        // v0.3.35 #7 — UAT 0725-3 #12: 传 raw email 给 login page pre-check + BE 端 validate
        email: email,
        emailMasked: maskEmail(email),
        sessionCode: code,
      });
      await goto(`/sessions/${sessionId}/login?${params.toString()}`);
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
      if (res.nickname_secret) {
        _storeActingAs(res.session_member_id, res.nickname_secret);
      } else {
        _clearActingAs();
      }
      // v0.3.36 — 用 URL `code` 直接.
      await goto('/s/' + code, { replaceState: true });
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
      localStorage.setItem(LS_PREFIX + code, secret);
    }
  }

  function _clearActingAs() {
    if (typeof window === 'undefined' || !sessionId) return;
    localStorage.removeItem(LS_PREFIX + sessionId);
    localStorage.removeItem(LS_PREFIX + code);
  }

  // v0.3.29 — UAT 0725-1 #13 v4: 合并一段列表 (无邮箱/有邮箱 混排).
  // - anon 用户: 看 user_id === null 的槽位 (未认领) + 已绑定 user_id 的 (PO v2 强调视觉平等, 匿名也能看)
  // - logged-in 用户: 看所有槽位 (任何槽位都能点)
  let allSlots = $derived(members.filter(() => true));

  // v0.3.28 (UAT 0723-3 #2): slot 头像首字母 (跟详情页成员头像同源, 用 .avatar-mini palette).
  function avatarLetter(name: string): string {
    if (!name) return '?';
    const c = name.codePointAt(0) ?? 63;
    // CJK 字符 + Latin 首字母 都拿一个 unicode point.
    return String.fromCodePoint(c).toUpperCase();
  }

  /** v0.3.29 — UAT 0725-1 #13 v4: 是否该槽位有 email (走 login 流程). */
  function hasEmail(slot: AnyMember): boolean {
    const email = (slot as SessionMember).email ?? (slot as SessionMemberPreview).email;
    return !!email;
  }
</script>

<section class="join-page">
  <h2 class="step-title">回到/加入账本</h2>

  {#if loading}
    <LoadingOverlay text="正在加载..." />
  {:else}
    {#if invite}
      <p class="muted">
        来自 <strong>{invite.inviter_display_name}</strong>
        <strong>{invite.session_name}</strong>
      </p>
    {:else if session}
      <p class="muted">
        <strong>{session.name}</strong>
      </p>
    {:else if preview}
      <p class="muted">
        <strong>{preview.name}</strong>
      </p>
    {/if}

    {#if user}
      <!-- Logged-in user -->
      <p>登录身份: <strong>{user.email}</strong></p>

      <div class="stack" style="max-width: 480px;">
        {#if allSlots.length > 0}
          <div>
            <p class="label">选择昵称加入账本</p>
            <!-- v0.3.29 — UAT 0725-1 #13 v4: 合并段 (有邮箱/无邮箱 混排, 视觉平等, 无 chevron). -->
            <div class="slot-list slot-list-merged">
              {#each allSlots as slot, i (slot.id)}
                <button
                  class="glass-pill slot-btn slot-btn-v3"
                  onclick={hasEmail(slot) ? () => handleEmailSlotClick(slot) : () => handleClaim(slot.id)}
                  disabled={busy}
                  data-testid="member-pick-row"
                  data-has-email={hasEmail(slot) ? '1' : '0'}
                >
                  <span class="slot-avatar palette-{i % 10}" aria-hidden="true">{avatarLetter(slot.display_name)}</span>
                  <span class="slot-info">
                    <span class="member-nickname slot-nickname">{slot.display_name}</span>
                    {#if hasEmail(slot)}
                      <span class="member-email-masked slot-email">
                        {maskEmail((slot as SessionMember).email ?? (slot as SessionMemberPreview).email ?? '')}
                      </span>
                    {/if}
                  </span>
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
      <!-- v0.3.0728-3 #1 (PO msg 2026-07-28 batch 新批 #1) — reverse v0.3.0728-2 #2:
           PO 拍: 未登录用户打开邀请链接时, 没办法正常看到已有的昵称, 只能新建昵称.
           修法: 在 anon 路径下 re-add allSlots.length > 0 条件渲染 + slot-list-merged (跟 logged-in 路径同款),
           让 anon 也能看到已有 member 列表 (可选认领 / 复用). 保留 "新建昵称以加入账本" form 段 (不可删, 仍可新建).
           逻辑: allSlots filter 复用 (v0.3.29 拍板: anon 看 user_id === null 的槽位 + 已绑定 user_id 的; logged-in 看所有).
           视觉: 跟 logged-in 路径同款 glass-pill + palette-{i%10} + avatarLetter + slot-btn-v3. -->
      <div class="stack" style="max-width: 480px;">
        {#if allSlots.length > 0}
          <div>
            <p class="label">选择昵称加入账本</p>
            <!-- v0.3.29 — UAT 0725-1 #13 v4: 合并段 (有邮箱/无邮箱 混排, 视觉平等, 无 chevron). -->
            <div class="slot-list slot-list-merged">
              {#each allSlots as slot, i (slot.id)}
                <button
                  class="glass-pill slot-btn slot-btn-v3"
                  onclick={hasEmail(slot) ? () => handleEmailSlotClick(slot) : () => handleClaim(slot.id)}
                  disabled={busy}
                  data-testid="member-pick-row"
                  data-has-email={hasEmail(slot) ? '1' : '0'}
                >
                  <span class="slot-avatar palette-{i % 10}" aria-hidden="true">{avatarLetter(slot.display_name)}</span>
                  <span class="slot-info">
                    <span class="member-nickname slot-nickname">{slot.display_name}</span>
                    {#if hasEmail(slot)}
                      <span class="member-email-masked slot-email">
                        {maskEmail((slot as SessionMember).email ?? (slot as SessionMemberPreview).email ?? '')}
                      </span>
                    {/if}
                  </span>
                </button>
              {/each}
            </div>
          </div>
        {/if}
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
  /* v0.3.28 (UAT 0723-3 #2): slot = 头像 + 昵称 + 脱敏邮箱, 三个元素 row 布局
     跟详情页 .avatar-mini + 名字同源. 视觉重量提升让选择更明确. */
  .slot-btn-v2 {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 6px 14px 6px 6px;
    cursor: pointer;
    font-size: 0.9rem;
    text-align: left;
  }
  /* v0.3.29 — UAT 0725-1 #13 v4: 合并列表的 row 样式 (跨整列, 头像 + 昵称/邮箱 堆叠).
     跟 v0.3.28 v2 不同 — v2 是 flex-wrap pill 横向排, v4 是 column row 满宽.
     PO 拍板 v2-1 mockup (.slot-list flex-direction:column, .slot-btn width:100%). */
  .slot-btn-v3 {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 10px 14px 10px 10px;
    border-radius: 16px;
    font-size: 14px;
    text-align: left;
    min-height: 56px;
  }
  .slot-avatar {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.95);
    flex-shrink: 0;
    text-shadow: 0 1px 1px rgba(0, 0, 0, 0.08);
    /* v0.3.23 #132 Option B 玻璃质感: rgba(..., 0.88) + backdrop-filter;
       这里 palette-0..4 覆盖 (用 linear-gradient 双色), 圆内仍是渐变. */
    backdrop-filter: blur(4px) saturate(180%);
    -webkit-backdrop-filter: blur(4px) saturate(180%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.45),
      inset 0 -1px 0 rgba(0, 0, 0, 0.06),
      0 2px 4px rgba(99, 102, 241, 0.10);
  }
  /* v0.3.29 — UAT 0725-1 #13 v4: 加 palette-5/6 支持 6-7 成员头像 (合并列表槽位更多).
     跟 v0.3.28 v2 mockup 同源 (palette 0..6). */
  .slot-btn-v3 .slot-avatar {
    width: 36px;
    height: 36px;
    font-size: 13px;
  }
  .palette-0 { background: linear-gradient(135deg, rgba(129, 140, 248, 0.88) 0%, rgba(99, 102, 241, 0.88) 100%); }
  .palette-1 { background: linear-gradient(135deg, rgba(244, 114, 182, 0.88) 0%, rgba(236, 72, 153, 0.88) 100%); }
  .palette-2 { background: linear-gradient(135deg, rgba(52, 211, 153, 0.88) 0%, rgba(16, 185, 129, 0.88) 100%); }
  .palette-3 { background: linear-gradient(135deg, rgba(251, 191, 36, 0.88) 0%, rgba(245, 158, 11, 0.88) 100%); }
  .palette-4 { background: linear-gradient(135deg, rgba(96, 165, 250, 0.88) 0%, rgba(59, 130, 246, 0.88) 100%); }
  .palette-5 { background: linear-gradient(135deg, rgba(168, 85, 247, 0.88) 0%, rgba(236, 72, 153, 0.88) 100%); }
  .palette-6 { background: linear-gradient(135deg, rgba(34, 197, 94, 0.88) 0%, rgba(16, 185, 129, 0.88) 100%); }
  /* v0.3.0728-2 #20 解冻: 5 → 10 扩色 (palette-7..9) — 跟 SessionCard avatar-mini 字段级同 */
  .palette-7 { background: linear-gradient(135deg, rgba(14, 165, 233, 0.88) 0%, rgba(59, 130, 246, 0.88) 100%); }
  .palette-8 { background: linear-gradient(135deg, rgba(139, 92, 246, 0.88) 0%, rgba(236, 72, 153, 0.88) 100%); }
  .palette-9 { background: linear-gradient(135deg, rgba(249, 115, 22, 0.88) 0%, rgba(239, 68, 68, 0.88) 100%); }
  .slot-info {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    min-width: 0;
    flex: 1;
  }
  .slot-nickname {
    font-weight: 600;
    font-size: 14px;
    color: var(--gray-900, #171717);
    line-height: 1.2;
  }
  /* v0.3.29 — UAT 0725-1 #13 v4: nickname 16px font-weight 600 (PO v4 字面). */
  .member-nickname {
    font-size: 16px;
    font-weight: 600;
    color: var(--gray-900, #171717);
    line-height: 1.2;
    white-space: nowrap;
  }
  .slot-email {
    font-size: 11px;
    color: var(--gray-500, #737373);
    font-weight: 400;
    line-height: 1.2;
    letter-spacing: 0.01em;
    /* 邮箱可能超 slot 宽度, 但需要全部可见 (脱敏后还是有用身份信息) */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 240px;
  }
  /* v0.3.29 — UAT 0725-1 #13 v4: 邮箱副行 12-13px muted (PO v4 字面). */
  .member-email-masked {
    font-size: 12px;
    color: var(--gray-500, #6b7280);
    font-weight: 400;
    line-height: 1.2;
    letter-spacing: 0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 240px;
  }
  .slot-email-muted {
    font-size: 11px;
    color: var(--gray-500, #6b7280);
    font-weight: 400;
    line-height: 1.2;
    opacity: 0.75;
  }
  /* v0.3.28 (UAT 0723-3 #1): 「加入」按钮局部大一点 + 防换行 —
     全局 .btn-primary padding 0 1.5rem + min-height 52px 在 .row.gap 容器跟 input 并排时会被 flex 挤压
     让「加入」两个字各占一行。覆盖: flex-shrink:0 + white-space:nowrap + padding 0 1.75rem + min-height 56px。 */
  .row.gap > .btn.btn-primary {
    flex-shrink: 0;
    white-space: nowrap;
    padding: 0 1.75rem;
    min-height: 56px;
  }
  .slot-btn:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
  /* 旧版 taken 状态 (v0.3.28): 已删 — v0.3.29 #13 v4 PO 拍板视觉平等, 有邮箱/无邮箱 同一视觉. */
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

  .gap {
    gap: 0.5rem;
  }
  .row {
    display: flex;
  }
</style>
