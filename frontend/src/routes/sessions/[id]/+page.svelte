<script lang="ts">
  /**
   * v0.1.3 Sprint 2 Commit 1 (2026-07-02) — session 详情页。
   *
   * 本次 Commit 1 改动:
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

  let session: SessionDetail | null = null;
  let bills: Bill[] = [];
  let loading = true;
  let error: string | null = null;

  let memberIdToName: Record<number, string> = {};
  let memberIdToNet: Record<number, number> = {};
  let currentMemberId: number | null = null;

  $: sessionId = Number($page.params.id);

  $: currentMember = session
    ? session.members.find((m) => m.user_id === $user?.user_id) ?? null
    : null;
  $: isOwner = currentMember?.role === 'owner';

  // 反馈修 6 项目 2: members section 默认折叠,JS state (Svelte 5 兼容)。
  let membersOpen = false;

  function membersStorageKey(): string {
    return `sbc.membersOpen.${sessionId}`;
  }

  function loadMembersOpen() {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(membersStorageKey());
      if (raw === null) return;
      membersOpen = raw === 'true';
    } catch {
      // ignore
    }
  }

  function saveMembersOpen() {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(membersStorageKey(), String(membersOpen));
    } catch {
      // ignore
    }
  }

  function toggleMembers() {
    membersOpen = !membersOpen;
    saveMembersOpen();
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

  onMount(async () => {
    loadMembersOpen();
    await load();
  });

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
  let copyingInvite = false;
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
          <button
            type="button"
            class="members-toggle"
            on:click={toggleMembers}
            aria-expanded={membersOpen}
            aria-label={membersOpen ? '收起成员列表' : '展开成员列表'}
          >
            <span class="toggle-caret" class:open={membersOpen} aria-hidden="true">▾</span>
            <span class="toggle-label">{membersOpen ? '收起' : '展开'}</span>
          </button>
        </div>
      </header>

      {#if membersOpen}
        {#if session.members.length <= 1}
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
                  on:click={() => handleDeleteMemberClick(m)}
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
  .members-toggle {
    appearance: none;
    background: transparent;
    border: 1px solid var(--gray-200);
    border-radius: var(--radius-md, 8px);
    color: var(--gray-500);
    cursor: pointer;
    min-height: 36px;
    padding: 0 var(--space-3);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font: inherit;
    font-size: var(--font-size-sm);
    transition: border-color 150ms ease, color 150ms ease, background 150ms ease;
  }
  .members-toggle:hover {
    border-color: var(--accent-500);
    color: var(--gray-900);
  }
  .toggle-caret {
    display: inline-block;
    transition: transform 200ms cubic-bezier(0.2, 0, 0, 1);
    font-size: 12px;
    line-height: 1;
  }
  .toggle-caret.open {
    transform: rotate(180deg);
  }
  .toggle-label {
    line-height: 1;
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
    .members-toggle .toggle-label {
      display: none; /* 移动端只留 ▾ icon,节省空间 */
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

  /* === FAB === */
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
    display: inline-flex;
    align-items: center;
    justify-content: center;
    text-decoration: none;
    padding: 0;
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
</style>
