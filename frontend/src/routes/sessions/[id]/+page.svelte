<script lang="ts">
  /**
   * v0.1.4 (2026-07-03) — session 详情页 polish round 2。
   *
   * 本次 polish (v0.1.4 round 2):
   * - 改动 1 (PO 10:15 拍板加回): 重新加回 members 折叠 toggle 按钮
   *   (PO 13:42 删过,现在又加回 — 迭代合理,直接做不质疑)。
   *   展开态 = 完整 members 列表,折叠态 = 仅头像堆叠 (32px 圆 -8px 重叠)。
   *   状态按 sessionId 持久化到 localStorage,默认展开。
   * - 改动 2: FAB `+` 居中对齐 — display: grid + place-items: center +
   *   padding-bottom: 2px (Inter font 里 `+` baseline 偏上, 视觉补偿 2px)。
   * - 改动 3: 新建 src/routes/+error.svelte — 401 自动清 user state +
   *   redirect /auth/login?returnTo=...; 其他 status 显示友好错误页。
   * - 改动 4: Empty state 条件修复 — session.members.length <= 1 改为 === 0
   *   (根因: owner 创建时自动加入, length 永远 >= 1, <= 1 让 owner 单独
   *   session 误触发 Empty state)。
   *
   * 沿用 v0.1.4 (round 1):
   * - bill 折叠动画 + share 独立行 + 成员列表简化
   *
   * 沿用 v0.1.3 Sprint 2 Commit 1:
   * - T6 千分位: 删除手写数字格式化,统一切到 $lib/utils/format.formatMoney。
   *   - 净金额 fmtNet 保留 '+' / U+2212 前缀 (Sprint 1 文档约束)。
   * - Token alias 迁移: var(--color-*) → var(--*) 主 token。
   *
   * 沿用:
   * - v0.1.2 反馈修 6 项目 2 (members section grid 布局)
   * - v0.1.2 反馈修 5 (跨页面动画)
   * - BillListGrouped 在 T7 中已支持「默认最新一天展开」智能逻辑
   */
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { fly } from 'svelte/transition';
  import { listBills, deleteBill, createBill } from '$api/bills';
  import { getSettle } from '$api/settle';
  import { formatMoney } from '$lib/utils/format';
  import type { SessionDetail } from '$api/sessions';
  import type { Bill } from '$api/bills';
  import { Search, X } from 'lucide-svelte';
  import InviteLinkButton from '$components/InviteLinkButton.svelte';
  import BillListGrouped from '$components/BillListGrouped.svelte';
  import EmptyState from '$components/EmptyState.svelte';
  import SessionCurrencyBadge from '$components/SessionCurrencyBadge.svelte';
  import { getSessionWithSecret } from '$api/sessions';
  import { user, loadUser } from '$stores/user';
  import { toast } from '$stores/toast';

  // v0.1.4 round 2: 一旦用了 $state runes, 整个组件就进入 runes mode,
  // 原 Svelte 4 风格的 `$:` 不再允许, 全部改用 $derived;
  // 同时所有可变的 `let` 也要加 $state, 否则不触发响应式更新。
  let session = $state<SessionDetail | null>(null);
  let bills = $state<Bill[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  let memberIdToName = $state<Record<number, string>>({});
  let memberIdToNet = $state<Record<number, number>>({});
  let currentMemberId = $state<number | null>(null);
  // v0.3 (PRD §3.10): anonymous acting-as member ID (from X-SBC-Member-ID header).
  let actingAsMemberId = $state<number | null>(null);

  // v0.2.1 T05 (PRD §3.6.4): session 内账单 description 模糊搜索。
  // 不搜金额/付款人 (避免搜索结果飘忽)。空 query 全显示。
  let billsSearchQuery = $state('');

  /**
   * v0.2.1 T04: 删除撤回。
   * 队列按 FIFO (后删的先撤 — User 期望「撤销最后一次删除」)。
   * 每条 raw bill 缓存所有 BE 字段, 撤销时重新 POST /bills。
   * BE 会分配新 bill.id (旧 id 永久丢失, 但 bills 列表顺序回到删除前)。
   *
   * 字段集: 必须包含 POST /bills 接受的全部字段 (CreateBillRequest + use_calculator)。
   * 这里只缓存 deletable 的 bill 字段; description 是 immutable in edit but
   * 前端可以 POST 同一 description 作为 create (新 id)。
   *
   * v0.2.1 Sprint 2 fix (反模式 #51): 撤销按钮的 onclick 直接调用 undoDelete。
   * 之前用 `window.__sbcBillUndo_<id>` 全局 handler 做中介, 导致 race:
   *   - attachUndo 在 `await deleteBill` 之后才设置 window key,
   *     但 undo-stack 模板在 undoQueue 更新后**立即**渲染, 用户早于 50ms
   *     点撤销, 读到 undefined, 整个 click 静默失败。
   *   - 即便 await 返回, 闭包经过 window 反射, Svelte 5 runes 模式下行为
   *     不稳定 (闭包捕获的 $state 引用经 Proxy 后再 fire 可能丢失入口)。
   * 修法: 撤销按钮 onclick 直接调用组件作用域里的 undoDelete, 同步可执行,
   * 不依赖外部中介。新增 busy 状态防止 DELETE 与 POST 重建并发竞争。
   */
  interface DeletedBillSnapshot {
    rawBill: Bill;
    participants: Array<{ member_id: number; is_exclusive: boolean; exclusive_amount: number }>;
    payer_member_id: number;
    /** Description 是 v0.1.2 immutable, 但 POST /bills 仍接受, 所以这里缓存。 */
    description: string | null;
  }
  let undoQueue = $state<Array<{
    id: number;
    snapshot: DeletedBillSnapshot;
    /** 乐观删除进行中: 撤销按钮 disable, 防止与 DELETE 竞态。 */
    deleting?: boolean;
    /** 重建进行中: 防止用户连点多次触发多个 POST。 */
    restoring?: boolean;
  }>>([]);
  let nextUndoId = 1;

  // v0.1.4 round 2: 一旦用了 $state runes, 整个组件就进入 runes mode,
  // 原 Svelte 4 风格的 `$:` 不再允许, 全部改用 $derived。
  let sessionId = $derived(Number(page.params.id));

  let currentMember = $derived(
    session
      ? session.members.find((m) => {
          if ($user?.user_id !== undefined) {
            return m.user_id === $user?.user_id;
          }
          // Anonymous: match by acting-as member ID
          return actingAsMemberId !== null && m.id === actingAsMemberId;
        }) ?? null
      : null
  );
  let isOwner = $derived(currentMember?.role === 'owner');

  // §3.11 收尾 (PO 11:38 拍板): 详情页 header 显示 owner info.
  // 位置: 详情页顶部 (在 banner 之外, 在 session 标题之后).
  // 登录态 + owner: nickname + email + 退出登录 button.
  // PO 14:01 重申: 详情页 header 完全**不**要 login/logout/登录以保存 按钮.
  // 全部用 banner 那个. 这里**只**留 "查看结算" 链接. 撤 handleOwnerHeaderLogout
  // + ownerHeaderLoggingOut (之前 commit b98f6a1 加的 logout button 用).

  /** v0.2.1 T05: bills 列表按 description 模糊 filter (大小写不敏感)。 */
  let filteredBills = $derived(
    billsSearchQuery.trim() === ''
      ? bills
      : bills.filter((b) =>
          (b.description ?? '')
            .toLowerCase()
            .includes(billsSearchQuery.trim().toLowerCase())
        )
  );

  // v0.1.4 round 2 改动 1: 重新加回 members 折叠 toggle。
  // 默认展开; 用户折叠后按 sessionId 持久化到 localStorage。
  let membersOpen = $state(true);
  const membersStorageKey = (sid: number) => `sbc.membersOpen.${sid}`;

  onMount(async () => {
    // Bug fix (PO 14:01 报 "登录态 email 这里还是没有正常显示"):
    // detail page 之前**不**调 loadUser, $user store 永远 null, member list fallback
    // (m.user_id === $user.user_id 显 $user.email) 永远 false → owner "me" 行没 email.
    // loadUser() 调 /api/auth/me 拿 user_id + email + default_name.
    await loadUser();

    // 还原 localStorage 折叠偏好
    try {
      const raw = localStorage.getItem(membersStorageKey(sessionId));
      if (raw !== null) membersOpen = raw === 'true';
    } catch {
      // ignore — SSR or storage disabled
    }

    await load();
  });

  /**
   * v0.2.1 UI rev: header 整体 clickable.
   * - handleMembersToggle: click 任意 header 区域切换 (InviteLinkButton 自己 stopPropagation)
   * - handleMembersKeydown: keyboard accessibility (Enter/Space)
   * 持久化逻辑不变 (localStorage sbc.membersOpen.{sessionId})
   */
  function handleMembersToggle() {
    membersOpen = !membersOpen;
    try {
      localStorage.setItem(membersStorageKey(sessionId), String(membersOpen));
    } catch {
      // ignore
    }
  }
  function handleMembersKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleMembersToggle();
    }
  }

  // 头像首字母大写 (跨语言 helper)
  function avatarLetter(name: string): string {
    const trimmed = (name ?? '').trim();
    return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
  }

  /**
   * T6: 净金额显示,>0 加 "+", <0 加 U+2212 (Sprint 1 文档约束), =0 "0.00"。
   * 数字部分走 formatMoney (千分位)。
   */
  function fmtNet(n: number | undefined): string {
    if (n === undefined || n === null || Number.isNaN(n)) return '';
    if (n > 0) return '+' + formatMoney(n, { showSymbol: false });
    if (n < 0) return '\u2212' + formatMoney(Math.abs(n), { showSymbol: false });
    return formatMoney(0, { showSymbol: false });
  }

  async function load() {
    if (!sessionId) return;
    loading = true;
    error = null;
    try {
      const result = await getSessionWithSecret(sessionId);
      session = result.session;
      actingAsMemberId = result.actingAsMemberId;
      for (const m of session.members) {
        memberIdToName[m.id] = m.display_name;
      }
      try {
        const settle = await getSettle(sessionId);
        const nets: Record<number, number> = {};
        for (const m of session.members) {
          const key = String(m.id);
          const v = settle.balances?.[key];
          if (typeof v === 'number') nets[m.id] = v;
        }
        memberIdToNet = nets;
      } catch {
        // ignore
      }
      bills = await listBills(sessionId);
      currentMemberId = currentMember?.id ?? null;
    } catch (e: any) {
      const c = e?.code ?? '';
      if (c === 'not a session member' || e?.status === 403) {
        // v0.3.1: 非成员应该去 join 页 claim nickname, 不显示错误。
        // 之前显示 '你不是这个 session 的成员' 死路, 用户没法 claim。
        await goto('/sessions/' + sessionId + '/join', { replaceState: true });
        return;
      } else {
        // 401 handled globally by client.ts (auto-redirect to /auth/login
        // with returnTo=<current path>). The previous inline goto('/auth/login')
        // here duplicated that redirect AND dropped the returnTo param;
        // removing it lets client.ts own the single source of truth.
        error = e?.message ?? '加载失败';
      }
    } finally {
      loading = false;
    }
  }

  /**
   * v0.2.1 T04 (PRD §3.6.4): 乐观删除 + 5s Toast 撤回。
   *
   * 流程 (Sprint 2 修订):
   * 1) 立即从 bills 数组里 splice (UI 立刻响应)
   * 2) 缓存 raw bill + participants, push 到 undoQueue (deleting=true)
   * 3) 弹 Toast `已删除 <description> [撤销]`, 5s 自动消失 (不阻塞 DELETE)。
   * 4) 调 DELETE /bills。成功 → 标记 deleting=false (撤销按钮 enable)。
   *    失败 → 把 bill 放回 bills 数组, 移除 undoEntry, 报 toast.error。
   * 5) 用户点撤销 → 标记 restoring=true, POST /bills 重建 (新 id)。
   *    成功 → push 回 bills, 移除 undoEntry, toast.success。
   *    失败 → 撤销 restoring 标记, 让用户重试, toast.error。
   *
   * 队列 FIFO (后删的先撤 — User 期望「撤销最后一次删除」)。
   * 不使用 soft-delete, 不新加 BE endpoint。
   * 注意: BillForm 在描述录入后, 后端 POST 返回新 id; 旧 id 永久丢失。
   * 这是可接受的 trade-off — 5s 撤销窗口足够短, 用户的「确认」还在短期记忆里。
   */
  async function handleDeleteBill(billId: number) {
    const idx = bills.findIndex((b) => b.id === billId);
    if (idx < 0) return;
    const rawBill = bills[idx];
    // Capture the full snapshot we need to recreate the bill.
    const snapshot: DeletedBillSnapshot = {
      rawBill,
      payer_member_id: rawBill.payer_id,
      description: rawBill.description,
      participants: rawBill.participants.map((p) => ({
        member_id: p.member_id,
        is_exclusive: !!p.is_exclusive,
        exclusive_amount: Number(p.exclusive_amount) || 0,
      })),
    };
    const undoEntry = { id: nextUndoId++, snapshot, deleting: true };

    // 1) 乐观删除 — 立即从 UI 移除。
    bills = bills.filter((b) => b.id !== billId);

    // 2) Push to undo queue (FIFO — 后删的先撤)。deleting=true 期间撤销按钮
    //    disabled, 防止与 DELETE 竞态 (用户早于 DELETE 完成点撤销会先 POST 重建,
    //    然后 DELETE 又把新 bill 删了)。
    undoQueue = [...undoQueue, undoEntry];

    // 3) Toast 立即弹出 (UX 优先 — 不等 DELETE 完成)。
    const deleteLabel = snapshot.description
      ? `已删除「${snapshot.description}」`
      : '已删除账单';
    toast.show(deleteLabel, 'info', 5000);

    try {
      await deleteBill(sessionId, billId);
      // DELETE 成功 — 解锁撤销按钮。
      undoQueue = undoQueue.map((u) =>
        u.id === undoEntry.id ? { ...u, deleting: false } : u
      );
    } catch (e: any) {
      // 失败回滚 bills。
      bills = [...bills, rawBill].sort((a, b) => {
        if (a.occurred_at !== b.occurred_at) {
          return a.occurred_at < b.occurred_at ? -1 : 1;
        }
        return a.id - b.id;
      });
      undoQueue = undoQueue.filter((u) => u.id !== undoEntry.id);
      toast.error(e?.message ?? '删除失败');
    }
  }

  async function undoDelete(undoId: number) {
    const entry = undoQueue.find((u) => u.id === undoId);
    // 防双触发: deleting 中 (DELETE 没回来) 或 restoring 中 (POST 没回来)。
    if (!entry || entry.deleting || entry.restoring) {
      toast.error('该账单已无法撤销');
      return;
    }
    // 立即标记 restoring, 不移除 undoEntry (POST 失败时回退让用户重试)。
    undoQueue = undoQueue.map((u) =>
      u.id === undoId ? { ...u, restoring: true } : u
    );
    const { snapshot } = entry;
    try {
      const recreated = await createBill(sessionId, {
        amount: snapshot.rawBill.amount,
        payer_member_id: snapshot.payer_member_id,
        description: snapshot.description,
        occurred_at: snapshot.rawBill.occurred_at,
        currency: snapshot.rawBill.currency,
        participants: snapshot.participants,
      });
      // Push the recreated bill back into the list. Insert by occurred_at
      // to preserve chronological position.
      const next = [...bills, recreated];
      next.sort((a, b) => {
        if (a.occurred_at !== b.occurred_at) {
          return a.occurred_at < b.occurred_at ? 1 : -1;
        }
        return a.id - b.id;
      });
      bills = next;
      undoQueue = undoQueue.filter((u) => u.id !== undoId);
      const restoredLabel = snapshot.description
        ? `已恢复「${snapshot.description}」`
        : '账单已恢复';
      toast.success(restoredLabel);
    } catch (e: any) {
      // POST 失败 — 撤销 restoring 标记, 让用户重试。
      undoQueue = undoQueue.map((u) =>
        u.id === undoId ? { ...u, restoring: false } : u
      );
      toast.error(e?.message ?? '恢复失败');
    }
  }

  // T14: copy invite link to clipboard (EmptyState CTA 用)
  let copyingInvite = $state(false);
  async function copyInviteLink() {
    if (!session) return;
    copyingInvite = true;
    try {
      const preview = session.invite_token_preview ?? '';
      const url = `${window.location.origin}/invites/${preview}`;
      try {
        await navigator.clipboard.writeText(url);
        toast.success('邀请链接已复制');
      } catch {
        // 兜底:用 textarea + execCommand
        const ta = document.createElement('textarea');
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand('copy');
          toast.success('邀请链接已复制');
        } catch {
          toast.error('复制失败,请手动复制');
        } finally {
          document.body.removeChild(ta);
        }
      }
    } finally {
      copyingInvite = false;
    }
  }

  function handleDeleteMemberClick(m: { id: number; display_name: string }) {
    // placeholder — 无 BE endpoint 可调,disabled 已阻止触发
    const proceed = confirm(`确认把 ${m.display_name} 从这个 session 移除?\n\n(v0.2 待 BE 支持,当前不可用)`);
    if (!proceed) return;
    toast.error('移除成员 (v0.2 待 BE 支持): 当前不可用');
  }
</script>

<section>
  {#if loading}
    <p class="muted">加载中…</p>
  {:else if error}
    <div class="error">{error}</div>
  {:else if session}
    <div class="row between session-header" style="margin-bottom: var(--space-3); flex-wrap: wrap; gap: var(--space-2);">
      <h2 style="margin: 0;">
        {session.name}
      </h2>
    </div>
    {#if session.currencies && session.currencies.length > 0}
      <SessionCurrencyBadge
        currencies={session.currencies}
        primary_currency={session.primary_currency}
        exchange_rates={session.exchange_rates ?? []}
        editable={isOwner}
        variant="detail"
        onRateChange={() => window.location.reload()}
      />
    {/if}

    <!-- v0.2.1 UI rev (PO 2026-07-03 18:15 重设计): 整个 header clickable + 折叠态 avatar 预览 -->
    <div class="card members-card">
      <header
        class="members-head"
        class:collapsed={!membersOpen}
        onclick={handleMembersToggle}
        onkeydown={handleMembersKeydown}
        role="button"
        tabindex="0"
        aria-expanded={membersOpen}
        aria-label={membersOpen ? '收起成员列表' : '展开成员列表'}
      >
        <h3 class="members-title">
          成员 <span class="muted members-count-inline">({session.members.length})</span>
        </h3>

        <!-- 折叠态: 头部内嵌 avatar 预览 (替代独立 toggle button) -->
        {#if !membersOpen && session.members.length > 0}
          <div class="members-avatars-inline" aria-hidden="true">
            {#each session.members.slice(0, 8) as m (m.id)}
              <div class="avatar-mini" title={m.display_name}>
                {avatarLetter(m.display_name)}
              </div>
            {/each}
            {#if session.members.length > 8}
              <span class="avatar-mini avatar-mini-overflow">+{session.members.length - 8}</span>
            {/if}
          </div>
        {/if}

        <div class="members-actions">
          <InviteLinkButton sessionId={session.id} sessionCode={session?.session_code ?? ""} {isOwner} />
          <span class="members-chevron" class:open={membersOpen} aria-hidden="true">▾</span>
        </div>
      </header>

      {#if membersOpen}
        <!-- v0.1.4 round 2 改动 4: 条件从 <= 1 改为 === 0 (owner 自动加入 length >= 1) -->
        {#if session.members.length === 0}
          <EmptyState
            icon="users"
            title="还没有成员"
            description="分享邀请链接,邀请朋友加入这个 session。"
            ctaLabel={copyingInvite ? '已复制' : '复制邀请链接'}
            onCtaClick={copyInviteLink}
          />
        {:else}
          <ul class="members-list">
            {#each session.members as m, i (m.id)}
              <li
                class="member-item"
                in:fly={{ y: 8, duration: 220, delay: Math.min(i * 30, 300) }}
              >
                <div class="member-avatar" aria-hidden="true">{avatarLetter(m.display_name)}</div>
                <div class="member-info">
                  <div class="member-name-row">
                    <span class="member-name">{m.display_name}</span>
                    {#if m.role === 'owner'}
                      <span class="owner-badge">owner</span>
                    {/if}
                    {#if currentMember?.id === m.id}
                      <span class="me-badge">me</span>
                    {/if}
                  </div>
                  <div class="member-meta-row">
                    <span
                      class="member-net"
                      class:pos={(memberIdToNet[m.id] ?? 0) > 0}
                      class:neg={(memberIdToNet[m.id] ?? 0) < 0}
                    >
                      {memberIdToNet[m.id] !== undefined ? fmtNet(memberIdToNet[m.id]) : '—'}
                    </span>
                    {#if m.email}
                      <span class="member-email muted">{m.email}</span>
                    {:else if $user && m.user_id === $user.user_id}
                      <!-- Bug fix (PO 12:51 报): 普通 member 详情页看不到自己 email.
                           BE 端同伴 slot claim 没 push user.email 到 SessionMember.email,
                           但 $user store 已有 email. 如果 member 是当前 user, fallback 显示 $user.email. -->
                      <span class="member-email muted">{$user.email}</span>
                    {/if}
                  </div>
                </div>
                {#if isOwner && m.role !== 'owner'}
                  <button
                    type="button"
                    class="member-remove"
                    onclick={(e) => { e.stopPropagation(); handleDeleteMemberClick(m); }}
                    aria-label="移除成员 {m.display_name}"
                    title="owner-only: v0.2 待 BE 支持 removeMember"
                    disabled
                  >×</button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </div>

    <!-- 反馈修 5 项目 8 + v0.3.2 §3.12.3: 「个人账单」按钮迁到 head，「查看结算」也并排。
         视觉候选 B（PO 10:30 拍板）：两按钮 ghost + Lucide inline SVG 图标。-->
    <div id="bills-card" class="card bills-card">
      <div class="bills-card-head">
        <div class="bills-card-head-left">
          <h3 class="bills-card-title">账单</h3>
          <span class="muted bills-card-count">共 {bills.length} 笔</span>
        </div>
        <div class="bills-card-head-right">
          <a
            class="btn ghost btn-sm bills-action-link"
            href="/sessions/{session.id}/settle"
            aria-label="查看结算"
          >
            <!-- Lucide `calculator` 16x16 -->
            <svg
              class="bills-action-icon"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="4" y="3" width="16" height="18" rx="2" />
              <line x1="8" y1="7" x2="16" y2="7" />
              <line x1="8" y1="11" x2="10" y2="11" />
              <line x1="14" y1="11" x2="16" y2="11" />
              <line x1="8" y1="15" x2="10" y2="15" />
              <line x1="14" y1="15" x2="16" y2="15" />
              <line x1="8" y1="19" x2="10" y2="19" />
              <line x1="14" y1="19" x2="16" y2="19" />
            </svg>
            <span>查看结算</span>
          </a>
          <a
            class="btn ghost btn-sm bills-action-link"
            href="/sessions/{session.id}/settle#personal"
            aria-label="查看个人账单"
          >
            <!-- Lucide `user` 16x16 -->
            <svg
              class="bills-action-icon"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            <span>个人账单</span>
          </a>
        </div>
      </div>
      {#if bills.length === 0 && !loading}
        <EmptyState
          icon="receipt"
          title="还没有账单"
          description="添加你的第一笔消费,分摊自动结算。"
          ctaLabel="+ 新建账单"
          ctaHref="/sessions/{session.id}/bills/new"
        />
      {:else}
        <!-- v0.2.1 T05: 搜索 input (session 内账单 description 模糊匹配)。 -->
        <div class="bills-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            bind:value={billsSearchQuery}
            placeholder="搜索账单说明"
            aria-label="搜索账单说明"
            class="bills-search-input"
          />
          {#if billsSearchQuery}
            <button
              type="button"
              class="bills-search-clear"
              aria-label="清除搜索"
              onclick={() => (billsSearchQuery = '')}
            ><X size={14} /></button>
          {/if}
        </div>

        <BillListGrouped
          bills={filteredBills}
          sessionId={session.id}
          memberIdToName={memberIdToName}
          currentUserMemberId={currentMemberId}
          onDelete={handleDeleteBill}
          loading={loading}
        />
      {/if}
    </div>

    {#if undoQueue.length > 0}
      <!-- v0.2.1 T04: Undo banner (5s 自动消失)。每条 undoEntry 独立倒计时。
           多个删除栈叠, 后删的在最上面 (LIFO 视觉)。点击 [撤销] 立即恢复该 bill,
           其他条目继续倒计时。-->
      <div class="undo-stack" aria-live="polite">
        {#each [...undoQueue].reverse() as entry (entry.id)}
          {@const label = entry.snapshot.description ?? '(无说明)'}
          <div class="undo-toast" class:busy={entry.deleting || entry.restoring}>
            <span class="undo-msg">已删除「{label}」</span>
            <button
              type="button"
              class="undo-btn"
              disabled={entry.deleting || entry.restoring}
              onclick={() => undoDelete(entry.id)}
            >{entry.restoring ? '恢复中…' : entry.deleting ? '删除中…' : '撤销'}</button>
          </div>
        {/each}
      </div>
    {/if}

    <!-- FAB: 200ms 后从下方 60px 飞入 -->
    <a
      class="fab"
      href="/sessions/{session.id}/bills/new"
      title="新建账单"
      aria-label="新建账单"
      in:fly={{ y: 60, duration: 400, delay: 200 }}
    >+</a>
  {/if}
</section>

<style>
  /* === header ===
     v0.3.14 §3.14.1: 移除 `.primary-currency-tag` (单行 h2 内嵌 tag), 
     替换为 SessionCurrencyBadge 组件 (标题下方独立 dl-like grid)。
     设计推荐 4 条理由见 design_output.md 任务 A 第 1 节。*/
  /* v0.3.2 §3.12.3: `.session-header-actions` 整段删除 — 相关 CSS 也清理。
     保留是为了让后续 retro 引用，注释占位。*/

  /* §3.11 收尾: 详情页 header owner info 样式 */
  .owner-info {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    font-size: 0.875rem;
  }
  .owner-nickname {
    font-weight: 600;
    color: var(--color-text, #171717);
  }
  .owner-email {
    font-size: 0.8125rem;
  }
  .owner-logout-btn {
    min-height: 32px;
    padding: 0 var(--space-3);
    border-radius: 9999px;
    border: 1px solid var(--color-border, #e5e5e5);
    background: var(--color-surface, #fff);
    color: var(--color-text, #525252);
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s, background 0.15s;
  }
  .owner-logout-btn:hover:not(:disabled) {
    border-color: var(--color-accent, #3b82f6);
    color: var(--color-accent, #3b82f6);
  }
  .owner-logout-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  /* v0.3.2 §3.12.3: `.session-header-actions` 移动端 CSS 块一并清理（类已删）。

  /* === 反馈修 6 项目 2: members section — grid 布局 彻底重写 === */
  .members-card {
    padding: var(--space-3) var(--space-4);
  }
  /* v0.2.1 UI rev: 整个 header clickable + 折叠态 hover + chevron rotation */
  .members-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
    padding: var(--space-2) var(--space-3);
    margin: calc(var(--space-2) * -1) calc(var(--space-3) * -1);
    border-radius: var(--radius-lg);
    cursor: pointer;
    user-select: none;
    transition: background-color 120ms ease;
  }
  .members-head:hover {
    background-color: var(--gray-50, #f9fafb);
  }
  .members-head:focus-visible {
    outline: 2px solid var(--accent-500, #3b82f6);
    outline-offset: 2px;
  }
  .members-head.collapsed {
    border-bottom: none;
  }
  .members-head:not(.collapsed) {
    border-bottom: 1px solid var(--gray-200);
    margin-bottom: var(--space-2);
  }
  .members-title {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-1);
  }
  .members-count-inline {
    font-weight: 400;
    font-size: var(--font-size-sm);
  }
  .members-actions {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  /* v0.2.1 UI rev: removed .members-toggle button — header itself is now clickable (see .members-head above) */

  /* === members list — grid 布局 === */
  .members-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .member-item {
    display: grid;
    grid-template-columns: 40px 1fr auto;
    align-items: center;
    gap: var(--space-3, 12px);
    padding: var(--space-3, 12px) 0;
    border-bottom: 1px solid var(--gray-200);
  }
  .member-item:last-child {
    border-bottom: none;
  }
  .member-avatar {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--accent-500);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 16px;
    flex-shrink: 0;
  }
  .member-info {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .member-name-row {
    display: flex;
    align-items: center;
    gap: var(--space-2, 8px);
    flex-wrap: wrap;
    min-width: 0;
  }
  .member-name {
    font-size: 1rem;
    font-weight: 500;
    color: var(--gray-900);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .owner-badge {
    display: inline-block;
    background: var(--accent-500);
    color: #fff;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    font-weight: 500;
    letter-spacing: 0.02em;
    line-height: 1.2;
  }
  .me-badge {
    display: inline-block;
    background: var(--accent-500);
    color: #fff;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    font-weight: 600;
    letter-spacing: 0.02em;
    line-height: 1.2;
  }
  .member-meta-row {
    display: flex;
    align-items: baseline;
    gap: var(--space-3, 12px);
    flex-wrap: wrap;
    font-size: 13px;
  }
  .member-net {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: var(--gray-500);
  }
  .member-net.pos {
    color: var(--success-500);
  }
  .member-net.neg {
    color: var(--error-500);
  }
  .member-email {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 200px;
  }
  .member-remove {
    appearance: none;
    background: transparent;
    border: 0;
    color: var(--gray-500);
    font-size: 22px;
    line-height: 1;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    cursor: pointer;
    opacity: 0;
    transition: opacity 150ms ease, background-color 150ms ease, color 150ms ease;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .member-item:hover .member-remove:not(:disabled) {
    opacity: 1;
  }
  .member-remove:hover:not(:disabled) {
    background: rgba(239, 68, 68, 0.1);
    color: var(--error-500);
  }

  /* v0.1.4 round 2 改动 1: 折叠态 — 小头像堆叠 (32px 圆 -8px 重叠) */
  .members-avatars-collapsed {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 0;
    margin-top: var(--space-3);
    padding: var(--space-2) 0;
    min-height: 32px;
  }
  .avatar-mini {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--accent-500);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 13px;
    margin-left: -8px;
    border: 2px solid var(--color-bg, white);
    box-shadow: 0 1px 2px rgba(0,0,0,0.08);
    user-select: none;
  }
  .avatar-mini:first-child {
    margin-left: 0;
  }
  /* v0.2.1 UI rev: removed .members-avatars-collapsed .muted.small block */

  /* v0.2.1 UI rev: 折叠态 header 内嵌 avatar 预览 (max 8 + overflow) */
  .members-avatars-inline {
    display: inline-flex;
    align-items: center;
    gap: 0;
    margin: 0 var(--space-2);
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
  }
  .members-avatars-inline .avatar-mini {
    width: 26px;
    height: 26px;
    font-size: 12px;
  }
  .avatar-mini-overflow {
    background: var(--gray-300, #d1d5db) !important;
    color: var(--gray-700, #374151) !important;
  }
  /* v0.2.1 UI rev: chevron icon (replaces .members-toggle button) */
  .members-chevron {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    font-size: 16px;
    color: var(--gray-500);
    transition: transform 180ms ease;
    transform: rotate(-90deg);
    margin-left: var(--space-1);
    flex: 0 0 auto;
  }
  .members-chevron.open {
    transform: rotate(0deg);
  }

  /* === 移动端 ≤380px: avatar 32px, padding 紧凑 === */
  @media (max-width: 480px) {
    .members-card {
      padding: var(--space-3);
    }
    .member-item {
      grid-template-columns: 32px 1fr auto;
      gap: var(--space-2, 8px);
      padding: var(--space-2, 8px) 0;
    }
    .member-avatar {
      width: 32px;
      height: 32px;
      font-size: 14px;
    }
    .member-name {
      font-size: 14px;
    }
    .member-remove {
      opacity: 1; /* 触摸设备 hover 不可靠,默认显示 */
    }
    .member-email {
      /* §3.11.11+§3.11.14: 邮箱必须显示 (anon-claimed slot 登录后绑定显示邮箱).
         旧 v0.2.1 规则 display:none 是错的, 改成小字号 + 缩窄. */
      font-size: 11px;
      max-width: 140px;
    }
  }

  /* === bills section header === */
  .bills-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin-bottom: var(--space-3);
  }
  .bills-card-head-left {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-3);
  }
  .bills-card-title {
    margin: 0;
  }
  .bills-card-count {
    font-size: var(--font-size-sm);
  }
  /* v0.3.2 §3.12.3: head-right 容器，gap 8px 并排两个 ghost btn。
     视觉候选 B（PO 10:30 拍板）+ spec §3.12.D: ghost + Lucide inline SVG 图标。
     移动端不换行（flex-wrap 不设到 right 子容器）。*/
  .bills-card-head-right {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex-wrap: nowrap;
  }
  .bills-action-link {
    min-height: 36px;
    padding: 4px 12px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }
  .bills-action-icon {
    flex: 0 0 auto;
  }
  /* 旧 `.bills-personal-link` 在 v0.3.2 改名 `.bills-action-link` 并彻底弃用。
     CSS 块删除 — svelte-check 现不再报 unused-selector 警告。*/
  @media (max-width: 480px) {
    .bills-card-head-left {
      flex: 1 1 auto;
      min-width: 0;
    }
    .bills-card-head-right {
      flex: 0 0 auto;
    }
    .bills-action-link {
      flex: 0 0 auto;
    }
  }

  /* === FAB ===
     v0.1.4 round 2 改动 2: `+` 居中对齐修复。
     原因: Inter font 里 `+` baseline 偏上 (mathematical center ≠ optical center),
     用 grid + place-items: center 完美居中, 再 padding-bottom: 2px 视觉补偿,
     让 `+` 在圆形按钮里看起来完全居中。 */
  .fab {
    position: fixed;
    right: 24px;
    bottom: 24px;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: var(--accent-500);
    color: #fff;
    font-size: 28px;
    font-weight: 300;
    line-height: 1;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
    z-index: 50;
    cursor: pointer;
    border: 0;
    display: grid;            /* 改 grid */
    place-items: center;      /* 完美居中 */
    padding: 0;
    padding-bottom: 2px;      /* 视觉补偿: + 在 Inter 里偏上, 下移 2px 视觉居中 */
    text-decoration: none;
    transition: transform 150ms ease, box-shadow 150ms ease, background-color 150ms ease;
  }
  .fab:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.22);
    background: var(--accent-700);
    color: #fff;
    text-decoration: none;
  }
  .fab:active {
    transform: scale(0.96);
  }
  .fab:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
    box-shadow: 0 0 0 4px var(--accent-500);
  }
  @media (max-width: 600px) {
    .fab {
      right: 16px;
      bottom: 16px;
    }
  }

  .bills-card {
    padding-bottom: 96px;
  }

  .btn-sm {
    min-height: 36px;
    padding: 4px 10px;
    font-size: var(--font-size-sm);
  }

  /* v0.2.1 T05: 账单搜索框 */
  .bills-search {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--color-bg, #f9fafb);
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    margin-bottom: var(--space-3);
    color: var(--gray-500);
  }
  .bills-search-input {
    flex: 1;
    border: 0;
    background: transparent;
    font-size: var(--font-size-sm, 14px);
    color: var(--gray-900);
    padding: 4px 0;
    min-width: 0;
  }
  .bills-search-input:focus {
    outline: none;
  }
  .bills-search-clear {
    appearance: none;
    background: transparent;
    border: 0;
    cursor: pointer;
    color: var(--gray-500);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    border-radius: 50%;
  }
  .bills-search-clear:hover {
    background: var(--color-border, #e5e7eb);
    color: var(--gray-900);
  }

  /* v0.2.1 T04: 删除撤销 banner (底部, 多条栈叠) */
  .undo-stack {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    bottom: 96px;
    z-index: 60;
    display: flex;
    flex-direction: column-reverse; /* 最新删的在最上面 */
    gap: var(--space-2);
    pointer-events: none;
    max-width: calc(100vw - 32px);
  }
  .undo-toast {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    background: var(--gray-900, #111827);
    color: #fff;
    border-radius: 999px;
    padding: 10px 8px 10px 18px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
    font-size: var(--font-size-sm, 14px);
    white-space: nowrap;
    max-width: 100%;
  }
  .undo-msg {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .undo-btn {
    appearance: none;
    background: var(--accent-500, #3b82f6);
    color: #fff;
    border: 0;
    border-radius: 999px;
    padding: 4px 14px;
    font-weight: 600;
    font-size: var(--font-size-sm, 13px);
    cursor: pointer;
    min-height: 32px;
    transition: background-color 150ms ease;
  }
  .undo-btn:hover {
    background: var(--accent-700, #1d4ed8);
  }
  .undo-btn:active {
    transform: scale(0.97);
  }
  /* v0.2.1 Sprint 2 T04: 删除/恢复进行中 — 按钮 disable + 视觉灰化 */
  .undo-btn:disabled {
    cursor: not-allowed;
    opacity: 0.7;
    background: var(--gray-500, #6b7280);
  }
  .undo-btn:disabled:hover {
    background: var(--gray-500, #6b7280);
  }
  .undo-toast.busy {
    opacity: 0.85;
  }

  /* === utility classes (token-migrated) === */
  .muted {
    color: var(--gray-500);
  }
  .error {
    color: var(--error-500);
  }
  .small {
    font-size: var(--font-size-sm);
  }
</style>
