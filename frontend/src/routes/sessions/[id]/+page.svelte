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
  import CurrencyAddModal from '$components/CurrencyAddModal.svelte';
  import { getSessionWithSecret } from '$api/sessions';
  import { user, loadUser } from '$stores/user';
  import { toast } from '$stores/toast';

  // v0.1.4 round 2: 一旦用了 $state runes, 整个组件就进入 runes mode,
  // 原 Svelte 4 风格的 `$:` 不再允许, 全部改用 $derived;
  // 同时所有可变的 `let` 也要加 $state, 否则不触发响应式更新。
  let session = $state<SessionDetail | null>(null);
  let bills = $state<Bill[]>([]);
  let loading = $state(true);
  // v0.3.18 #53: open/close state for the CurrencyAddModal (triggered by
  // SessionCurrencyBadge single-pill + icon when owner).
  let addCurrencyOpen = $state(false);

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
   * v0.3.18 #66 (PO #6899 Mockup A): ISO → "YYYY 年 M 月 D 日" 中文长格式.
   * 用于 page-level .expiry-inline-a amber pill (从 InviteLinkButton 移到 section header).
   * v0.3.19 #83 (PO #7300): header pill 改紧凑 — "M月D日" (省 "年" 和 "后过期" — template 自加) — iPhone SE (375px) 不超.
   */
  function formatExpiryDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const m = d.getMonth() + 1;
    const day = d.getDate();
    return m + '月' + day + '日';
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

  /**
   * v0.3.18 #66 (PO #6899 Mockup A): anon 账本过期时间 ISO -> 中文长格式
   * 「YYYY 年 M 月 D 日后过期」(amber pill 文案).
   */
  function formatExpiryPill(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    return `${y}年${m}月${day}日过期`;
  }

  async function load() {
    if (!sessionId) return;
    loading = true;
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
        // v0.3.15 (PO #4807): 错误统一走 Toast
        toast.error(e?.message ?? '加载失败');
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
    const proceed = confirm(`确认把 ${m.display_name} 从这个账本移除?\n\n(v0.2 待 BE 支持,当前不可用)`);
    if (!proceed) return;
    toast.error('移除成员 (v0.2 待 BE 支持): 当前不可用');
  }
</script>

<section>
  {#if loading}
    <p class="muted">加载中…</p>
  {:else if session}
    <div class="row between session-header" style="margin-bottom: var(--space-3); flex-wrap: wrap; gap: var(--space-2);">
      <h2 style="margin: 0;">
        {session.name}
      </h2>
    </div>
    {#if session.currencies && session.currencies.length > 0}
      <!-- v0.3.19 #85 (PO #7308): 删 onRateChange (弹窗 PATCH 后 parent onAdded 统一 reload).
           多币种整 bar clickable 在 owner 时也触发 onAddCurrency. -->
      <SessionCurrencyBadge
        currencies={session.currencies}
        primary_currency={session.primary_currency}
        exchange_rates={session.exchange_rates ?? []}
        editable={isOwner}
        variant="detail"
        onAddCurrency={() => (addCurrencyOpen = true)}
      />
    {/if}

    <!-- v0.3.20 #92 (PO msg 07:13 #7409): 重排 members head rows —
         row1: title + count 左, expiry pill 右 (owner_email 为空时)
         row2: avatar 组 (左, 折叠态独有) + InviteLinkButton (右, 永远渲染)
         row3: chevron-down + 「查看 N 人」居中, 折叠态独有
         整段 onclick + aria-expanded 保留, header 整体可点折叠/展开.
         反 #7300 regression 修复: row1 挪 invite 到 row2 后, 展开态 InviteLinkButton 必须保留.
         设计理由: invite 是核心操作, 不应被 collapsed 状态决定可见性.
         row2 用 space-between: 折叠时 [avatars 左 | invite 右]; 展开时 [空 | invite 右] 自然 right-align. -->
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
        <!-- 第一行: 成员 · N人 左 (users icon 14×14 gray-500), expiry pill 右 (owner_email 为空时) -->
        <div class="members-head-row1">
          <h3 class="members-title-a">
            <!-- Lucide `users` 14×14 gray-500 -->
            <svg
              class="members-title-icon"
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <span>成员 · {session.members.length}人</span>
          </h3>
          {#if (session?.owner_email == null || session?.owner_email === '') && session?.invite_expires_at}
            <span class="expiry-inline-a" data-testid="invite-expiry-pill">
              <!-- Lucide `clock` 11×11 -->
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <!-- v0.3.20 #93 (PO msg 00:04 #7450, Fix 8): expiry format 改长格式
                   YYYY年M月D日后过期 (跟 v0.3.18 #66 Mockup A 同款), 跟 sticky expiry 字段统一. -->
              <span>{formatExpiryPill(session.invite_expires_at)}</span>
              <!-- v0.3.20 #93 (Fix 8): anon session (无 owner_email) 加 CTA 提示 owner 登录以永久保存.
                   Link to /auth/login?returnTo=/sessions/{id}. 只有 owner 视角 (isOwner=true) 才显示
                   这个 CTA 才有意义 — 因 anonymous session 一定没有 owner_email 已绑,
                   isOwner 检查这里 redundant, 但保留 escape hatch 给其他边界 case (例如 multi-owner). -->
              {#if (session?.owner_email == null || session?.owner_email === '') && session?.invite_expires_at}
                <span class="expiry-cta-sep" aria-hidden="true">·</span>
                <a
                  class="expiry-cta-link"
                  href="/auth/login?returnTo=/sessions/{session.id}"
                  aria-label="登录以永久保存账本"
                  data-testid="invite-expiry-cta"
                >
                  <!-- v0.3.20 #94 Fix 4 (PO msg 02:13 #7455): 去括号.
                       之前是 "(Jesse) 登录以永久保存" (用 .expiry-cta-prefix 包 "()",
                       nick 后跟 ") 登录以永久保存" 不分类), PO 拍板 "Jesse 登录以永久保存"
                       直接连写不要括号. 模板 + CSS 同步清理:
                       - 删 .expiry-cta-prefix (包开括号那个)
                       - nick 仍是 .expiry-cta-nick (紫色粗体 accent-700)
                       - "登录以永久保存" 独立 .expiry-cta-suffix (默认颜色, 跟 nick 区分) -->
                  <span class="expiry-cta-nick">
                    {#if session.members && session.members.length > 0}
                      {session.members[0].display_name}
                    {:else}
                      owner
                    {/if}
                  </span>
                  <span class="expiry-cta-suffix">登录以永久保存</span>
                </a>
              {/if}
            </span>
          {/if}
        </div>

        <!-- 第二行: 头像组 (左, 折叠态独有) + InviteLinkButton (右, 永远渲染)
             用 space-between + right margin-left: auto, 折叠时 [avatars | invite],
             展开时 [空 | invite] 自然 right-align, 任何状态都能调 invite -->
        <div class="members-head-row2">
          <div class="members-row2-left">
            {#if !membersOpen && session.members.length > 0}
              <div class="members-avatars-inline" aria-hidden="true">
                {#each session.members.slice(0, 8) as m, i (m.id)}
                  <div class="avatar-mini palette-{i % 5}" title={m.display_name}>
                    {avatarLetter(m.display_name)}
                  </div>
                {/each}
                {#if session.members.length > 8}
                  <span class="avatar-mini avatar-mini-overflow">+{session.members.length - 8}</span>
                {/if}
              </div>
            {/if}
          </div>
          <div class="members-row2-right">
            <InviteLinkButton
              sessionId={session.id}
              sessionCode={session?.session_code ?? ""}
              {isOwner}
            />
          </div>
        </div>

        <!-- 第三行: chevron-down + 「查看 N 人」居中 (affordance 提示), 折叠态独有 -->
        {#if !membersOpen}
          <div class="members-head-row3" aria-hidden="true">
            <!-- Lucide `chevron-down` 12×12 gray-400 -->
            <svg
              class="members-expand-chevron"
              viewBox="0 0 24 24"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <span class="members-expand-hint">查看 {session.members.length} 人</span>
          </div>
        {/if}
      </header>

      {#if membersOpen}
        <!-- v0.3.18 #66 (PO #6899 Mockup A) 7: 1-member 紧凑 CTA banner -->
        {#if session.members.length === 1 && session.members[0].role === 'owner'}
          <div class="solo-cta-a" data-testid="solo-member-cta">
            <span class="solo-cta-icon-a" aria-hidden="true">
              {avatarLetter(session.members[0].display_name)}
            </span>
            <span class="solo-cta-text-a">
              <strong>{session.members[0].display_name}</strong> 还没有同伴,
              <strong>邀请朋友</strong> 加入一起记账
            </span>
            <span class="solo-cta-arrow-a" aria-hidden="true">→</span>
          </div>
        {:else if session.members.length === 0}
          <EmptyState
            icon="users"
            title="还没有成员"
            description="分享邀请链接,邀请朋友加入这个账本。"
            ctaLabel={copyingInvite ? '已复制' : '复制邀请链接'}
            onCtaClick={copyInviteLink}
          />
        {:else if session.members.length === 1 && isOwner}
          <div class="solo-cta-a">
            <div class="solo-cta-icon-a" aria-hidden="true">+</div>
            <div class="solo-cta-text-a">
              <strong>你是 owner</strong> · 邀请朋友加入,开始分摊第一笔账单吧
            </div>
            <span class="solo-cta-arrow-a" aria-hidden="true">›</span>
          </div>
        {:else}
          <ul class="members-list-a">
            {#each session.members as m, i (m.id)}
              {@const isMe = currentMember?.id === m.id}
              <li
                class="member-row-a"
                class:is-owner={m.role === 'owner'}
                class:is-me={isMe}
                in:fly={{ y: 8, duration: 220, delay: Math.min(i * 30, 300) }}
              >
                <div
                  class="avatar-a palette-{i % 5}"
                  class:is-owner={m.role === 'owner'}
                  class:is-me={isMe}
                  aria-hidden="true"
                >
                  {#if m.role === 'owner'}
                    <span class="owner-crown">👑</span>
                  {/if}
                  {avatarLetter(m.display_name)}
                </div>
                <div class="member-info-a">
                  <div class="member-name-row-a">
                    <span class="member-name-a">{m.display_name}</span>
                    {#if m.role === 'owner' && isMe}
                      <span class="me-dot-a">me · owner</span>
                    {:else if m.role === 'owner'}
                      <span class="owner-tag-a">owner</span>
                    {:else if isMe}
                      <span class="me-dot-a">me</span>
                    {/if}
                  </div>
                  <div class="member-meta-a">
                    <span
                      class="member-net-a"
                      class:pos={(memberIdToNet[m.id] ?? 0) > 0}
                      class:neg={(memberIdToNet[m.id] ?? 0) < 0}
                    >
                      {memberIdToNet[m.id] !== undefined ? fmtNet(memberIdToNet[m.id]) : '—'}
                    </span>
                    {#if m.email}
                      <span class="member-email-a">{m.email}</span>
                    {:else if $user && m.user_id === $user.user_id}
                      <!-- Bug fix (PO 12:51 报): 普通 member 详情页看不到自己 email.
                           BE 端同伴 slot claim 没 push user.email 到 SessionMember.email,
                           但 $user store 已有 email. 如果 member 是当前 user, fallback 显示 $user.email. -->
                      <span class="member-email-a">{$user.email}</span>
                    {/if}
                  </div>
                </div>
                {#if isOwner && m.role !== 'owner'}
                  <button
                    type="button"
                    class="member-remove-a"
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
            class="btn glass-pill btn-sm bills-action-link"
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
            class="btn glass-pill btn-sm bills-action-link"
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
          primaryCurrency={session.primary_currency}
          currencies={session.currencies}
          members={session.members}
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

    <!-- FAB: 200ms 后从下方 60px 飞入
         v0.3.16 #8 (PO msg 19:26): 加 .glass-pill 玻璃化 (保留 50% 圆形 + 白色 + icon) -->
    <a
      class="fab glass-pill"
      href="/sessions/{session.id}/bills/new"
      title="新建账单"
      aria-label="新建账单"
      in:fly={{ y: 60, duration: 400, delay: 200 }}
    >+</a>
  {/if}

  <!-- v0.3.18 #53 + v0.3.19 #85: owner-driven modal.
       Mounted only when addCurrencyOpen=true (controlled by SessionCurrencyBadge
       onAddCurrency click from 单币种 pill 或 多币种整 bar).
       mode 跟 session.currencies.length 联动: 1=单币种 (add flow) / 2=多币种 (edit settings).
       has_bills 跟本地 bills.length 联动 (本组件已加载 bills).
       onAdded reloads the page so the badge re-renders with new currencies/rates. -->
  {#if addCurrencyOpen && session}
    <CurrencyAddModal
      session_id={session.id}
      primary_currency={session.primary_currency}
      existing_currencies={session.currencies}
      mode={session.currencies.length === 1 ? 'single' : 'multi'}
      has_bills={bills.length > 0}
      exchange_rates={session.exchange_rates ?? []}
      onAdded={() => window.location.reload()}
      on:close={() => (addCurrencyOpen = false)}
    />
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
    font-size: var(--font-size-sm);
  }
  .owner-nickname {
    font-weight: 600;
    color: var(--color-text, #171717);
  }
  .owner-email {
    font-size: var(--font-size-xs);
  }
  .owner-logout-btn {
    min-height: 32px;
    padding: 0 var(--space-3);
    border-radius: 9999px;
    border: 1px solid var(--color-border, #e5e5e5);
    background: var(--color-surface, #fff);
    color: var(--color-text, #525252);
    font-size: var(--font-size-xs);
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

  /* === v0.3.18 #66 (PO #6899 Mockup A 精修列表): 列表布局彻底重写 ===
     Mockup A 的 8 项 review 修复全部落到 CSS, 字面移植 v0318-66-shared.css token。
     (1) 过期提示挪到 header 右上 inline pill (amber 50/700)
     (2) 删除冗余 chevron (header 本身 clickable)
     (3) owner 紫色 ring + 👑 小皇冠 emoji
     (4) owner+me 同 row 只显皇冠 + "me · owner" 微章
     (5) email 不截断 (word-break: break-all, 不设 max-width)
     (6) net 字号 13px / font-weight 700 / 首位
     (7) 1-member 紧凑 CTA banner
     (8) 768px 2-column grid */
  .members-card {
    background: rgba(255, 255, 255, 0.55);
    backdrop-filter: saturate(180%) blur(20px);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    border-radius: 16px;
    /* v0.3.21 #110 (PO msg 18:46): padding 16 → 12.
       PO 反馈 section 垂直高度太高 + "查看 N 人" 离 section 底部太远.
       减少上下 padding 给 row1+row2+row3 留更多紧凑空间. */
    padding: 12px;
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.05);
  }

  /* v0.3.19 #83 (PO #7300): 折叠态 header 重构成 3 行布局 —
     row1 (40px) / row2 (36px) / row3 (24px). 整段仍 onclick + aria-expanded.
     v0.3.21 #110 (PO msg 18:46): gap 4 → 2 (整体更紧凑),
     padding-bottom 2 → 0 (去掉 row3 下方多余空白, 让 hint 更贴 section 底边). */
  .members-head {
    display: flex;
    flex-direction: column;
    gap: 2px;
    /* v0.3.20 #96 (PO msg 02:41 #7467): padding-bottom 10 -> 2.
       PO "查看 5 人下边空白太多". 保留 border-bottom (members section
       跟下面账单 section 的视觉分隔, 不是 row3 的底边)
       + margin-bottom 12px (section 间分隔, 跟 row3 无关).
       v0.3.20 #98 (PO msg 13:36 #7532 #3): 删 border-bottom.
       PO 反馈 "成员 section 的 查看 x 人的下方有一条线, 是分割线还是 button 的底边框?
       我不想要这条线". 整条线 (1px solid rgba(0,0,0,0.05)) 直接 none 掉, 不用 opacity.
       视觉分隔交给 margin-bottom: 12px (.members-card 跟下方 .bills-card 之间已有 12px 间距,
       加上 .bills-card 自带 padding-top, 足够断开两块). row3 的 border-top (在上方) 不动,
       那是 row2 <-> row3 之间的 affordance 分割 (跟这条线是不同 line).
       v0.3.21 #110: padding-bottom 2 → 0. 配合 .members-card padding 减半 + row3
       align-items: flex-end, "查看 N 人" 字样现在视觉上贴 section 底边. */
    padding: 0;
    margin: 0 0 12px 0;
    border-bottom: none;
    cursor: pointer;
    user-select: none;
  }
  /* v0.3.20 #93 (PO msg 00:04 #7450, Fix 6): removed .members-head:hover purple bg
     (PO 反馈"整个 section 点击 / hover 时 bg 变紫"奇怪 — 折叠态整 section 是 affordance,
     但 hover 时不应该把整块变紫; 视觉反馈靠 cursor:pointer + aria-expanded 就够了).
     保留 .members-head:focus-visible (a11y focus ring 不能去掉). */
  .members-head:focus-visible {
    outline: 2px solid var(--accent-500, #3b82f6);
    outline-offset: 2px;
  }
  .members-head-row1 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    /* v0.3.21 #110 (PO msg 18:46): min-height 32 → 26.
       row1 内容只装 "成员 · N人" 标题 + 可选 expiry pill, 26px 足够. */
    min-height: 26px;
  }
  /* v0.3.20 #92 (PO msg 07:13 #7409): row2 改成左右两栏 —
     左 (members-row2-left) = avatars (折叠态独有), 右 (members-row2-right) = InviteLinkButton (always).
     用 space-between 让两端对齐, margin-left: auto 在 right 上作为 fallback
     确保即使 left 是空 placeholder, invite 仍在最右.
     v0.3.20 #94 Fix 3 (PO msg 02:13 #7455): --invite-btn-h CSS var 跟 InviteLinkButton 高度联动,
     默认 48px (desktop), 767px 以下 44px (mobile 标准), 380px 以下 36px (按钮自带 mobile override).
     row min-height 28px → 40px (允许 var 48px 内容装下, 不被截).
     v0.3.21 #110 (PO msg 18:46): --invite-btn-h mobile 40/36/32 (默认 44 → 40, 380- 36 → 32),
     + min-height 40 → 36, 整 row 紧凑 ~6-8px. */
  .members-head-row2 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 36px;
    --invite-btn-h: 40px;
  }
  @media (max-width: 767px) {
    .members-head-row2 {
      --invite-btn-h: 40px;
    }
  }
  @media (max-width: 380px) {
    .members-head-row2 {
      --invite-btn-h: 32px;
    }
  }
  .members-row2-left {
    display: flex;
    align-items: center;
    flex: 1 1 auto;
    min-width: 0;
  }
  .members-row2-right {
    flex: 0 0 auto;
    margin-left: auto;
  }
  /* v0.3.20 #94 Fix 6 (PO msg 02:13 #7455): "查看 N 人" 放分割线之下.
     之前 chevron + "查看 N 人" 直接挨在 row2 (avatar + invite) 下面, 没视觉分隔,
     PO 拍板 "跟 row1+row2 分开, 暗示这是 affordance 不是另一行信息".
     加 border-top: 1px solid rgba(0,0,0,0.05) 跟 .members-head 已有的
     border-bottom 同款 (折叠态独有 — row3 模板只在 {#if !membersOpen} 渲染,
     expanded 状态 row3 DOM 不存在, border 自然也不显, 不会影响 expanded 视觉).
     min-height 20 → 24 (border 1px + padding-top 视觉更平衡, 不被 border 挤). */
  .members-head-row3 {
    display: flex;
    /* v0.3.21 #110 (PO msg 18:46): align-items: center → flex-end.
       PO 反馈 "查看 N 人" 字样靠 section 底部对齐. 改 flex-end 后, chevron + hint
       在 row3 box 内贴底, 配合 .members-head padding-bottom:0 + .members-card
       padding-bottom:12, "查看 N 人" 视觉上贴 section 底边. */
    align-items: flex-end;
    justify-content: center;
    gap: 4px;
    /* v0.3.20 #96 (PO msg 02:41 #7467): min-height 24 -> 20.
       配合 .members-head padding-bottom 10 -> 2, 整体 row3 下方空白
       从 ~24px 降到 ~5px ("查看 N 人" 文字下到 .members-head
       border-bottom 之间).
       PO 明确 "上边有分割线就行, 下边不需要分割线" -- row3 本就没
       border-bottom (上方 border-top 保留作 row2 <-> row3 分隔),
       这里只调内部 min-height.
       v0.3.21 #110: min-height 20 → 16, padding-top 6 → 2. 整体 row3 更紧凑,
       + align-items flex-end 让 hint 贴 row3 底边. */
    min-height: 16px;
    margin-top: 2px;
    padding-top: 2px;
    border-top: 1px solid rgba(0, 0, 0, 0.05);
    color: var(--gray-400, #9ca3af);
  }
  .members-expand-chevron {
    flex-shrink: 0;
  }
  .members-expand-hint {
    font-size: 11px;
    font-weight: 400;
    color: var(--gray-400, #9ca3af);
    line-height: 1;
  }
  .members-head-left {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1 1 auto;
  }
  .members-title {
    margin: 0;
    font-size: 15px;
    font-weight: 700;
    color: var(--gray-900, #171717);
    letter-spacing: -0.005em;
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
  }
  /* v0.3.19 #83 (PO #7300): 成员 · N人 + users icon 14×14 gray-500 内联 */
  .members-title-a {
    margin: 0;
    font-size: 14px;
    font-weight: 700;
    color: var(--gray-900);
    letter-spacing: -0.005em;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 0 1 auto;
    min-width: 0;
    white-space: nowrap;
  }
  .members-title-icon {
    color: var(--gray-500, #737373);
    flex-shrink: 0;
  }
  .members-count-a {
    font-weight: 400;
    font-size: 12px;
    color: var(--gray-500, #737373);
    margin-left: 4px;
  }
  /* v0.3.20 #92 (PO msg 07:13 #7409): 删 .members-actions-a — expiry 已挪回 row1 单独渲染,
     InviteLinkButton 已挪到 row2 的 .members-row2-right. 容器不再需要. */

  /* Expiry inline pill (mockup A token: amber-50 bg + amber-700 text + border) */
  /* v0.3.19 #83 (PO #7300): amber 配色克制 — bg 保留 amber-50, 文字改 gray-700, 不抢 row1 L1 主信息. */
  .expiry-inline-a {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--gray-700, #404040);
    background: var(--amber-50, #fffbeb);
    border: 1px solid rgba(245, 158, 11, 0.18);
    border-radius: 999px;
    padding: 3px 9px 3px 7px;
    font-weight: 500;
    line-height: 1.2;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .expiry-inline-a svg {
    flex-shrink: 0;
    opacity: 0.85;
  }
  /* v0.3.20 #93 (PO msg 00:04 #7450, Fix 8): anon session 登录 CTA 样式.
     跟 expiry pill 同款 glass amber-50 bg, 但 link 用紫色 accent 链接色, 不抢主信息. */
  .expiry-cta-sep {
    color: var(--gray-400, #9ca3af);
    margin: 0 4px;
    opacity: 0.7;
  }
  .expiry-cta-link {
    color: var(--accent-700, #4338ca);
    text-decoration: none;
    font-weight: 500;
    transition: color 150ms ease;
  }
  .expiry-cta-link:hover {
    color: var(--accent-800, #3730a3);
    text-decoration: underline;
  }
  .expiry-cta-link:focus-visible {
    outline: 2px solid var(--accent-500, #3b82f6);
    outline-offset: 2px;
    border-radius: 4px;
  }
  .expiry-cta-nick {
    font-weight: 600;
    color: var(--accent-700, #4338ca);
  }
  .expiry-cta-suffix {
    color: var(--gray-600, #525252);
  }

  /* === Member list — 列表布局 (替代旧 chip 圆角 999px) === */
  .members-list-a {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  /* Mockup A row: grid 36px 1fr auto, 头像 + 信息 + (可选) remove */
  .member-row-a {
    display: grid;
    grid-template-columns: 36px 1fr auto;
    align-items: center;
    gap: 12px;
    padding: 8px 0;
    border-bottom: 1px solid rgba(0, 0, 0, 0.04);
    border-radius: 8px;
    transition: background-color 150ms ease-out;
  }
  .member-row-a:last-child {
    border-bottom: none;
  }
  .member-row-a:hover {
    background-color: rgba(99, 102, 241, 0.04);
  }
  .member-row-a.is-owner {
    background: linear-gradient(90deg, rgba(168, 85, 247, 0.04) 0%, transparent 60%);
    border-radius: 10px;
  }

  .member-row-a.is-me {
    background: rgba(59, 130, 246, 0.04);
    border-radius: 10px;
  }

  /* Avatar — 36px, 5 色循环 (indigo/pink/emerald/amber/blue) + owner 紫色 ring + 👑 */
  /* v0.3.19 #83 (PO #7300): 加玻璃质感 — 2px 白边 + shadow + inset highlight, 36px 更立体. */
  .avatar-a {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: linear-gradient(135deg, #818cf8 0%, #6366f1 100%);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 13px;
    flex-shrink: 0;
    position: relative;
    border: 2px solid rgba(255, 255, 255, 0.5);
    box-shadow:
      0 4px 12px rgba(0, 0, 0, 0.08),
      inset 0 0.5px 0 rgba(255, 255, 255, 0.6);
  }
  .avatar-a.b {
    background: linear-gradient(135deg, #f472b6 0%, #ec4899 100%);
  }
  .avatar-a.c {
    background: linear-gradient(135deg, #34d399 0%, #10b981 100%);
  }
  .avatar-a.d {
    background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
  }
  .avatar-a.e {
    background: linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%);
  }
  /* v0.3.19 #83 (PO #7300): template 用 palette-{i%5}, 补补 CSS */
  .avatar-a.palette-0 {
    background: linear-gradient(135deg, #818cf8 0%, #6366f1 100%);
  }
  .avatar-a.palette-1 {
    background: linear-gradient(135deg, #f472b6 0%, #ec4899 100%);
  }
  .avatar-a.palette-2 {
    background: linear-gradient(135deg, #34d399 0%, #10b981 100%);
  }
  .avatar-a.palette-3 {
    background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
  }
  .avatar-a.palette-4 {
    background: linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%);
  }
  .avatar-a.is-owner {
    box-shadow: 0 0 0 2px #fff, 0 0 0 4px rgba(168, 85, 247, 0.55);
  }
  .avatar-a.is-me {
    box-shadow: 0 0 0 2px #fff, 0 0 0 4px rgba(59, 130, 246, 0.55);
  }
  .owner-crown {
    position: absolute;
    top: -6px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 11px;
    line-height: 1;
    filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.15));
    z-index: 1;
  }

  /* Member info — name + meta row */
  .member-info-a {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .member-name-row-a {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    min-width: 0;
  }
  .member-name-a {
    font-size: 14px;
    font-weight: 600;
    color: var(--gray-900, #171717);
    /* Mockup A fix #5: email 不截断 → name 也不 ellipsis */
    overflow: visible;
    text-overflow: clip;
    white-space: normal;
    word-break: break-word;
    line-height: 1.3;
  }
  /* owner tag (只有 owner 是别人时显示) — 紫色玻璃 pill */
  .owner-tag-a {
    display: inline-block;
    font-size: 10px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 999px;
    background: linear-gradient(135deg, rgba(168, 85, 247, 0.14), rgba(99, 102, 241, 0.14));
    color: #6d28d9;
    line-height: 1.3;
  }
  /* me 微章 — 蓝色圆点 + 文字, owner+me 同行时显示 "me · owner" */
  .me-dot-a {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 10px;
    color: var(--accent-700, #1d4ed8);
    font-weight: 600;
    line-height: 1;
  }
  .me-dot-a::before {
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent-500, #3b82f6);
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.18);
  }

  /* Meta row — net 13px 首位 + email 不截断 */
  .member-meta-a {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 11px;
    color: var(--gray-500, #737373);
    line-height: 1.4;
  }
  .member-net-a {
    font-size: 13px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
  }
  .member-net-a.pos {
    color: var(--color-success, #059669);
  }
  .member-net-a.neg {
    color: var(--color-danger, #dc2626);
  }
  /* Mockup A fix #5: email 不截断 (旧版 max-width: 200px + ellipsis 改成 break-all 完整显示) */
  .member-email-a {
    font-size: 11px;
    color: var(--gray-500, #737373);
    word-break: break-all;
  }

  /* Remove × 按钮 — 28×28 圆形, 透明默认, hover 时变红 */
  .member-remove-a {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: transparent;
    border: 0;
    color: var(--gray-400, #a3a3a3);
    cursor: not-allowed;
    font-size: 14px;
    line-height: 1;
    opacity: 0.4;
    transition: all 150ms ease-out;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .member-row-a:hover .member-remove-a:not(:disabled) {
    opacity: 1;
  }
  .member-remove-a:hover:not(:disabled) {
    background: rgba(239, 68, 68, 0.1);
    color: var(--error-500, #ef4444);
  }

  /* Mockup A fix #7: 1-member 紧凑 CTA banner (只有 owner 一人) */
  .solo-cta-a {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.06) 0%, rgba(59, 130, 246, 0.04) 100%);
    border-radius: 12px;
    border: 1px dashed rgba(99, 102, 241, 0.20);
  }
  .solo-cta-icon-a {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: linear-gradient(135deg, #818cf8 0%, #6366f1 100%);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    font-weight: 600;
  }
  .solo-cta-text-a {
    flex: 1;
    font-size: 12px;
    color: var(--gray-700, #404040);
    line-height: 1.4;
  }
  .solo-cta-text-a strong {
    color: var(--gray-900, #171717);
  }
  .solo-cta-arrow-a {
    color: var(--accent-700, #1d4ed8);
    font-size: 16px;
  }

  /* v0.2.1 UI rev: 折叠态 header 内嵌 avatar 预览 (max 8 + overflow) */
  /* v0.3.19 #83 (PO #7300): 18px, -6px overlap (不再用 -8px, 18px 间距 -6 视觉刚好). */
  .members-avatars-inline {
    display: inline-flex;
    align-items: center;
    gap: 0;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
  }
  /* v0.3.20 #94 Fix 3 (PO msg 02:13 #7455): 折叠态 row2 头像高度 = InviteLinkButton 高度.
     之前 .members-avatars-inline .avatar-mini 18×18, 跟 InviteLinkButton 48px (desktop) / 44px
     (iOS touch) / 36px (mobile override @ <380px) 完全不匹配, 视觉上 button 比 avatar 高 30+px,
     折叠态 row2 左右两端不齐.

     修法 (CSS var 联动, 不硬编码):
     - 在 .members-head-row2 定义 --invite-btn-h, 默认 48px (desktop InviteLinkButton 实际高).
     - @media (max-width: 767px) → 44px (iOS touch target, 跟 button 在 mobile 大多 viewport 一致).
     - @media (max-width: 380px) → 36px (匹配 InviteLinkButton 自带 mobile override).
     - .members-avatars-inline .avatar-mini 改用 var(--invite-btn-h) 控制 width/height.
     - font-size 按比例: var * 0.32 (~15px at 48, ~14px at 44, ~12px at 36).
     - margin-left 按比例: var * -0.25 (~-12px at 48, ~-11px at 44, ~-9px at 36), 25% overlap.
     保留 base .avatar-mini 32×32 + font-size 12px (其他页面 BillForm / settle 等复用).
     保留 palette-{i%5} 渐变 + overflow "+N" tag.
     SessionMemberList 组件**不**改 (其他页面独立使用 28×28, 跨页面一致性不破坏). */
  .members-avatars-inline .avatar-mini {
    width: var(--invite-btn-h, 48px);
    height: var(--invite-btn-h, 48px);
    font-size: calc(var(--invite-btn-h, 48px) * 0.32);
    margin-left: calc(var(--invite-btn-h, 48px) * -0.25);
  }
  .members-avatars-inline .avatar-mini:first-child {
    margin-left: 0;
  }
  /* v0.3.19 #83 (PO #7300): 折叠态 mini avatar 用 palette-{i%5} 渐变 (复用 v0.3.18 #66 token).
     删掉之前 .avatar-mini { background: var(--accent-500) } 单色. */
  .avatar-mini {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 12px;
    border: 1.5px solid #fff;
    box-shadow: 0 1px 2px rgba(0,0,0,0.10);
    user-select: none;
    position: relative;
  }
  .avatar-mini.palette-0 {
    background: linear-gradient(135deg, #818cf8, #6366f1);
  }
  .avatar-mini.palette-1 {
    background: linear-gradient(135deg, #f472b6, #ec4899);
  }
  .avatar-mini.palette-2 {
    background: linear-gradient(135deg, #34d399, #10b981);
  }
  .avatar-mini.palette-3 {
    background: linear-gradient(135deg, #fbbf24, #f59e0b);
  }
  .avatar-mini.palette-4 {
    background: linear-gradient(135deg, #60a5fa, #3b82f6);
  }
  .avatar-mini-overflow {
    background: var(--gray-300, #d1d5db) !important;
    color: var(--gray-700, #374151) !important;
    font-weight: 600;
  }

  /* v0.3.18 #66 (PO #6899 Mockup A) 8: 768px tablet 2-column grid */
  @media (min-width: 768px) {
    .members-list-a {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px 16px;
    }
    .member-row-a {
      padding: 12px;
      background: rgba(255, 255, 255, 0.4);
      border: 1px solid rgba(0, 0, 0, 0.04);
      border-radius: 12px;
    }
    .member-row-a:last-child {
      border-bottom: 1px solid rgba(0, 0, 0, 0.04);
    }
    .solo-cta-a {
      grid-column: 1 / -1;
    }
  }

  /* Mockup A SE 320px compact mode */
  @media (max-width: 360px) {
    .members-head {
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
    }
    .members-actions {
      width: 100%;
      justify-content: space-between;
    }
    .expiry-inline-a {
      font-size: 10px;
      padding: 2px 7px 2px 5px;
    }
    .member-row-a {
      grid-template-columns: 32px 1fr 28px;
      gap: 8px;
    }
    .avatar-a {
      width: 32px;
      height: 32px;
      font-size: 12px;
    }
    .avatar-a { width: 32px; height: 32px; font-size: 12px; }
  }

  /* 移动端 ≤480px: row 紧凑 + remove 按钮默认可见 */
  @media (max-width: 480px) {
    .members-card {
      padding: 12px;
    }
    .member-remove-a {
      opacity: 1;
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
     让 `+` 在圆形按钮里看起来完全居中。
     v0.3.16 #8 (PO msg 19:26): 加 .glass-pill 玻璃化 — bg/box-shadow/border 由
       .glass-pill 提供。
     v0.3.16 #10 (PO msg 20:38): FAB icon 改主题色 — 删 color: #fff (`+` 白色在浅紫
       玻璃上看不清),改由 .glass-pill 提供 var(--accent-700, #4338ca) 深紫主题色
       (跟 bills/new/edit/settle 的 .fab 一致)。 */
  .fab {
    position: fixed;
    right: 28px;
    bottom: 28px;
    width: 80px;
    height: 80px;
    border-radius: 50%;        /* 圆形覆盖 .glass-pill 的 999px */
    /* 删 color: #fff — 由 .glass-pill 提供 var(--accent-700, #4338ca) 深紫主题色 */
    font-size: 36px;
    font-weight: 300;
    line-height: 1;
    z-index: 50;
    cursor: pointer;
    border: 0;
    display: grid;            /* 改 grid */
    place-items: center;      /* 完美居中 */
    padding: 0;
    padding-bottom: 3px;      /* 视觉补偿: + 在 Inter 里偏上, 下移 2px 视觉居中 */
    text-decoration: none;
    transition: transform 150ms ease, box-shadow 150ms ease, background 150ms ease, color 150ms ease;
  }
  /* .fab:hover 不再写 color — 由 .glass-pill:hover 全局处理 (icon 颜色保持主题色) */
  .fab:hover {
    transform: translateY(-2px);
    text-decoration: none;
  }
  .fab:active {
    transform: scale(0.96);
  }
  .fab:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }
  @media (max-width: 600px) {
    .fab {
      right: 20px;
      bottom: 20px;
    }
  }

  /* v0.3.20 #93 (Fix 7): --bills-search-h — BillListGrouped 的 day-header 通过此变量
     计算 sticky top 偏移. 50px = 搜索框实际高度 (padding 8x2 + input line-height ~16
     + border 1x2) + 12px breathing room (原 margin-bottom).
     v0.3.20 #94 Fix 5 (PO msg 02:13 #7455): --bills-search-h 50px → 60px.
     搜索框 padding-top 加 10px (8→18, 给 sticky top 上方留呼吸空间, 不贴 nav bar),
     搜索框实际高度从 ~38px 变 ~48px, sticky region 同步加 10px → 60px (50+10). */
  .bills-card {
    --bills-search-h: 60px;
    padding-bottom: 96px;
  }

  .btn-sm {
    min-height: 36px;
    padding: 4px 10px;
    font-size: var(--font-size-sm);
  }

  /* v0.2.1 T05: 账单搜索框.
     v0.3.20 #93 (PO msg 00:04 #7450, Fix 7): sticky 跟随 page scroll,
     滚到任何位置搜索框常驻顶部 (跟全站 NavBar 一起保持可达).
     用 z-index: 20 高于 day-header (10) 让搜索框视觉上浮在 day-header 上;
     backdrop blur + saturate 跟全站玻璃语言一致.
     v0.3.20 #94 Fix 5 (PO msg 02:13 #7455): padding-top 8px → 18px (加 10px),
     给搜索框上方留呼吸空间 (sticky top:0 紧贴 nav bar, 视觉太挤).
     其他 padding-bottom 8px + 左右 12px 不变.
     同步 --bills-search-h 50px → 60px (search region 加 10px, day-header sticky top 偏移跟着加).
     v0.3.20 #98 (PO msg 13:36 #7532 #2): sticky top 0 → var(--space-2) (~8px).
     之前 top:0 让 sticky 搜索框贴 NavBar 下边 (z-index 50 vs 20, NavBar 盖在上),
     视觉零间距. PO 反馈"搜索框上方贴页面 header 贴的太多紧了, 要留点空隙".
     改用 --space-2 spacing token 跟全站 spacing 一致; 不动 --bills-search-h
     (那是搜索框自身高度, sticky top offset 是另一回事, BillListGrouped day-header
     偏移由 --bills-search-h 推算, 不受 top 影响). */
  .bills-search {
    position: sticky;
    top: var(--space-2);
    z-index: 20;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    /* v0.3.20 #98 (PO msg 13:36 #7532 #1): padding 上下对称.
       原 18px var(--space-3) var(--space-2) (18 top + 8 bottom) 让 content area
       偏 search box 顶部 ~5px (input 22px 填满 content area, flex 居中在
       content area 内, 但 content area 不在 search box 中央). PO 反馈
       "搜索框内文字还是没居中" — 文字在搜索框视觉上还是偏高.
       padding 改 13px var(--space-3) 13px 让 content area 22px 精确居中在
       search box 50px 高度里 (search top +13 + content 22 + 13 + 2 border = 50).
       input 跟 .Search icon 都垂直居中于搜索框, placeholder 跟实际文字
       在视觉中央. --bills-search-h 60px 不变 (那是 region 计算用, search 高度
       仍是 50px, 实际 region 高度由 BillListGrouped 偏移自行处理). */
    padding: 13px var(--space-3) 13px;
    background: rgba(255, 255, 255, 0.55);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    color: var(--gray-500);
  }
  @supports not (backdrop-filter: blur(1px)) {
    .bills-search {
      background: var(--color-bg, #f9fafb);
    }
  }
  .bills-search-input {
    flex: 1;
    border: 0;
    background: transparent;
    font-size: var(--font-size-sm, 14px);
    color: var(--gray-900);
    padding: 0;
    min-width: 0;
    /* v0.3.20 #95 Fix 4 (PO msg 02:41 #7459): <input type="search"> 在 iOS Safari
       上默认 line-height ≈ 1.2 (normal), 跟 padding 4px 叠加后 input 物理高度
       ~25px, 但 flex 父 .bills-search 有 padding 18 + 8 = 26px, 加上 .Search icon,
       实际视觉高度 ~62px. 默认 line-height 在 iOS 让 input text "top-aligned".
       修法: line-height: 1 (跟 font-size 同高 14px), text 精确居中在 font 高度.
       不改 input 高度 (padding 4 + content 14 + 4 = 22px) — 仍由 flex
       align-items: center 把它放在父容器中央.
       v0.3.20 #98 (PO msg 13:36 #7532 #1): placeholder 文字仍未 vertical-center.
       v0.3.20 #95 只设了 line-height: 1, 但 <input type="search"> 在 iOS Safari
       有自己的 intrinsic min-height (~22px) + native search 控件 padding (X button
       内部留位), 让 placeholder 文字 baseline 偏 input 顶部 ~2-3px. PO 在 iPhone 13
       (iOS Safari) 真机实测仍 "文字贴上边".
       修法: 显式 height + line-height 匹配 (height 22px = font-size 14 + 内边距 8),
       -webkit-appearance: none 重置 Safari native search 样式 (去 X button 内部
       padding 占位, 去默认 min-height), margin: 0 去 Safari 默认外边距.
       font: inherit (隐含) 保证 placeholder 跟 input 用同一 font metrics.
       text-align: left 显式声明 (Safari <input type="search"> 默认 center 在某些
       iOS 版本, 跟 text input 不一致). 整个 input 高度 22px 后, flex 父 align-items: center
       把它放在搜索框中央, placeholder 跟实际输入文字位置完全一致. */
    height: 22px;
    line-height: 22px;
    margin: 0;
    -webkit-appearance: none;
    appearance: none;
    text-align: left;
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

  .small {
    font-size: var(--font-size-sm);
  }
</style>
