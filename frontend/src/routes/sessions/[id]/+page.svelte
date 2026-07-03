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
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { fly } from 'svelte/transition';
  import { getSession } from '$api/sessions';
  import { listBills, deleteBill } from '$api/bills';
  import { getSettle } from '$api/settle';
  import { formatMoney } from '$lib/utils/format';
  import type { SessionDetail } from '$api/sessions';
  import type { Bill } from '$api/bills';
  import InviteLinkButton from '$components/InviteLinkButton.svelte';
  import BillListGrouped from '$components/BillListGrouped.svelte';
  import EmptyState from '$components/EmptyState.svelte';
  import { user } from '$stores/user';
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

  // v0.1.4 round 2: 一旦用了 $state runes, 整个组件就进入 runes mode,
  // 原 Svelte 4 风格的 `$:` 不再允许, 全部改用 $derived。
  let sessionId = $derived(Number($page.params.id));

  let currentMember = $derived(
    session
      ? session.members.find((m) => m.user_id === $user?.user_id) ?? null
      : null
  );
  let isOwner = $derived(currentMember?.role === 'owner');

  // v0.1.4 round 2 改动 1: 重新加回 members 折叠 toggle。
  // 默认展开; 用户折叠后按 sessionId 持久化到 localStorage。
  let membersOpen = $state(true);
  const membersStorageKey = (sid: number) => `sbc.membersOpen.${sid}`;

  onMount(async () => {
    // 还原 localStorage 折叠偏好
    try {
      const raw = localStorage.getItem(membersStorageKey(sessionId));
      if (raw !== null) membersOpen = raw === 'true';
    } catch {
      // ignore — SSR or storage disabled
    }
    await load();
  });

  function toggleMembers() {
    membersOpen = !membersOpen;
    try {
      localStorage.setItem(membersStorageKey(sessionId), String(membersOpen));
    } catch {
      // ignore
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
      session = await getSession(sessionId);
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
        error = '你不是这个 session 的成员';
      } else if (e?.status === 401) {
        await goto('/auth/login');
      } else {
        error = e?.message ?? '加载失败';
      }
    } finally {
      loading = false;
    }
  }

  async function handleDeleteBill(billId: number) {
    if (!confirm('确认删除这笔账单?')) return;
    try {
      await deleteBill(sessionId, billId);
      bills = bills.filter((b) => b.id !== billId);
      toast.success('已删除账单');
    } catch (e: any) {
      toast.error(e?.message ?? '删除失败');
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
      <h2 style="margin: 0;">{session.name}</h2>
      <div class="session-header-actions">
        <a class="btn ghost" href="/sessions/{session.id}/settle">查看结算</a>
      </div>
    </div>

    <!-- 反馈修 6 项目 2: members section 彻底重写 — grid 布局 -->
    <div class="card members-card">
      <header class="members-head">
        <h3 class="members-title">
          成员 <span class="muted members-count-inline">({session.members.length})</span>
        </h3>
        <div class="members-actions">
          <InviteLinkButton sessionId={session.id} {isOwner} />
          <!-- v0.1.4 round 2 改动 1: 重新加回折叠 toggle 按钮 (PO 10:15 拍板) -->
          <button
            type="button"
            class="members-toggle"
            onclick={toggleMembers}
            aria-expanded={membersOpen}
            aria-label={membersOpen ? '收起成员列表' : '展开成员列表'}
          >
            <span class="toggle-caret" class:open={membersOpen} aria-hidden="true">▾</span>
            <span class="toggle-label">{membersOpen ? '收起' : '展开'}</span>
          </button>
        </div>
      </header>

      <!-- v0.1.4 round 2 改动 1: 折叠态切换 -->
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
          <!-- stagger mount: 每个 li delay i*30ms (cap 300ms) -->
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
                    {/if}
                  </div>
                </div>
                {#if isOwner && m.role !== 'owner'}
                  <button
                    type="button"
                    class="member-remove"
                    onclick={() => handleDeleteMemberClick(m)}
                    aria-label="移除成员 {m.display_name}"
                    title="owner-only: v0.2 待 BE 支持 removeMember"
                    disabled
                  >×</button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      {:else}
        <!-- v0.1.4 round 2 改动 1: 折叠态 — 仅小头像堆叠 -->
        <div class="members-avatars-collapsed">
          {#each session.members as m (m.id)}
            <div
              class="avatar-mini"
              title="{m.display_name}{m.email ? ' ' + m.email : ''}"
              aria-label={m.display_name}
            >
              {avatarLetter(m.display_name)}
            </div>
          {/each}
          {#if session.members.length === 0}
            <span class="muted small">还没有成员</span>
          {/if}
        </div>
      {/if}
    </div>

    <!-- 反馈修 5 项目 8: 「个人账单」按钮移到 bills section head -->
    <div class="card bills-card">
      <div class="bills-card-head">
        <div class="bills-card-head-left">
          <h3 class="bills-card-title">账单</h3>
          <span class="muted bills-card-count">共 {bills.length} 笔</span>
        </div>
        <a
          class="btn ghost btn-sm bills-personal-link"
          href="/sessions/{session.id}/settle#personal"
          aria-label="查看个人账单"
        >个人账单</a>
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
        <BillListGrouped
          {bills}
          sessionId={session.id}
          memberIdToName={memberIdToName}
          currentUserMemberId={currentMemberId}
          onDelete={handleDeleteBill}
          loading={loading}
        />
      {/if}
    </div>

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
  /* === header === */
  .session-header-actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  @media (max-width: 600px) {
    .session-header-actions {
      width: 100%;
    }
    .session-header-actions .btn {
      flex: 1 1 0;
      min-width: 0;
    }
  }

  /* === 反馈修 6 项目 2: members section — grid 布局 彻底重写 === */
  .members-card {
    padding: var(--space-3) var(--space-4);
  }
  .members-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
    padding-bottom: var(--space-2);
  }
  .members-head:has(+ .members-list) {
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

  /* v0.1.4 round 2 改动 1: 重新加回折叠 toggle 按钮 CSS */
  .members-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: transparent;
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: 999px;
    padding: 4px 10px;
    font-size: var(--font-size-sm, 13px);
    color: var(--color-text-muted, #6b7280);
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }
  .members-toggle:hover {
    background: var(--color-bg, #f9fafb);
    color: var(--color-text, #111827);
  }
  .toggle-caret {
    display: inline-block;
    transition: transform 200ms ease;
    font-size: 10px;
    line-height: 1;
  }
  .toggle-caret.open {
    transform: rotate(180deg);
  }
  /* 移动端 ≤480px: 隐藏 toggle 文字, 只留 caret */
  @media (max-width: 480px) {
    .members-toggle .toggle-label {
      display: none;
    }
  }

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
  .members-avatars-collapsed .muted.small {
    margin-left: var(--space-3);
    font-size: var(--font-size-sm);
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
      display: none; /* 移动端太挤,隐藏 */
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
  .bills-personal-link {
    min-height: 36px;
    padding: 4px 12px;
  }
  @media (max-width: 480px) {
    .bills-card-head-left {
      flex: 1 1 auto;
      min-width: 0;
    }
    .bills-personal-link {
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
