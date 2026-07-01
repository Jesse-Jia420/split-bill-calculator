<script lang="ts">
  /**
   * v0.1.2 反馈修3 (PO 2026-07-01 20:30 UX 改写) — session 详情页 (Commit 1)。
   *
   * 本 commit 仅包含 T9 (members section 重构):
   * - summary 极简 1 行 (成员N + [邀请] + ▾) + 始终可见头像叠放 + 「共 N 人」
   * - 展开后 inline 紧凑成员列表 (头像 32 + 名字 + email + 净金额 + 删除按钮 [owner-only placeholder, v0.2 待 BE 支持])
   * - owner token hint 移到 summary 区域, 始终可见
   *
   * 历史:
   * - v0.1.2 T7+T8 (Coder 4 `e77163a`): members 折叠 (原 details summary 内 head+body 2 行)
   *
   * T12 (FAB) + T13 (header 3 按钮) 在 Commit 2 (feat(ui): action series) 中加,
   * 本 commit 仅动 members section,保持 diff 最小。
   */
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { getSession } from '$api/sessions';
  import { listBills, deleteBill } from '$api/bills';
  import { getSettle } from '$api/settle';
  import type { SessionDetail } from '$api/sessions';
  import type { Bill } from '$api/bills';
  import InviteLinkButton from '$components/InviteLinkButton.svelte';
  import BillListGrouped from '$components/BillListGrouped.svelte';
  import { user } from '$stores/user';

  let session: SessionDetail | null = null;
  let bills: Bill[] = [];
  let loading = true;
  let error: string | null = null;

  // map SessionMember.id -> display_name
  let memberIdToName: Record<number, string> = {};
  // T9: 净金额列来自 settle.balances (member_id -> net)
  let memberIdToNet: Record<number, number> = {};
  // T11 (Commit 1 顺手): 当前登录人 → SessionMember.id,BillListGrouped 用它判断「你分摊 X」
  let currentMemberId: number | null = null;

  $: sessionId = Number($page.params.id);

  $: currentMember = session
    ? session.members.find((m) => m.user_id === $user?.user_id) ?? null
    : null;
  $: isOwner = currentMember?.role === 'owner';

  // T9: members section 默认折叠 (沿用 T7)。localStorage 跨刷新记住选择。
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

  function handleMembersToggle(e: Event) {
    const el = e.currentTarget as HTMLDetailsElement;
    membersOpen = el.open;
    saveMembersOpen();
  }

  function avatarLetter(name: string): string {
    const trimmed = (name ?? '').trim();
    return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
  }

  /** T9: 净金额显示 — net > 0 加 "+", < 0 加 "−" (U+2212 true minus)。 */
  function fmtNet(n: number | undefined): string {
    if (n === undefined || n === null || Number.isNaN(n)) return '';
    if (n > 0) return '+' + n.toFixed(2);
    if (n < 0) return '\u2212' + Math.abs(n).toFixed(2);
    return '0.00';
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
      // T9: 加载 settle.balances 用于 members 行显示净金额。
      // 失败不致命 — 净金额列会留空 (graceful degradation)。
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
        // ignore — members 列表仍可用
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
    } catch (e: any) {
      error = e?.message ?? '删除失败';
    }
  }

  // T9: 删除成员 (owner-only). v0.2 待 BE 支持 removeMember 接口,
  // 当前没 DELETE /sessions/{id}/members/{mid},按钮 disabled + tooltip 解释。
  // 这是 PO「复用现 handleDeleteMember 或留 placeholder」明确接受的 placeholder。
  function handleDeleteMemberClick(m: { id: number; display_name: string }) {
    const proceed = confirm(`确认把 ${m.display_name} 从这个 session 移除?\n\n(v0.2 待 BE 支持,当前会被后端拒绝)`);
    if (!proceed) return;
    error = '移除成员 (v0.2 待 BE 支持): 当前不可用';
  }
</script>

<section>
  {#if loading}
    <p class="muted">加载中…</p>
  {:else if error}
    <div class="error">{error}</div>
  {:else if session}
    <!-- T13 (Commit 2) 暂保留原 [查看结算] [+ 新建账单] 2 按钮 -->
    <div class="row between" style="margin-bottom: var(--space-3); flex-wrap: wrap; gap: var(--space-2);">
      <h2 style="margin: 0;">{session.name}</h2>
      <div class="row" style="gap: var(--space-2); flex-wrap: wrap;">
        <a class="btn" href="/sessions/{session.id}/settle">查看结算</a>
        <a class="btn primary" href="/sessions/{session.id}/bills/new">+ 新建账单</a>
      </div>
    </div>

    <!-- T9: members section 重构。summary 极简 1 行 + 始终可见头像叠放 + 共 N 人 + owner token hint;
         展开后 details body 显示紧凑成员列表 (新 inline 列表,不重用 <SessionMemberList>) -->
    <div class="card members-card">
      <details class="members-section" open={membersOpen} on:toggle={handleMembersToggle}>
        <summary class="members-summary">
          <div class="members-summary-top">
            <span class="members-title">成员 ({session.members.length})</span>
            <div class="members-summary-actions">
              <InviteLinkButton sessionId={session.id} {isOwner} />
              <span class="members-toggle-icon" aria-hidden="true">{membersOpen ? '−' : '+'}</span>
            </div>
          </div>
          <div class="members-summary-stack">
            <div class="avatar-stack" aria-label="成员头像">
              {#each session.members.slice(0, 8) as m (m.id)}
                <div class="avatar-sm" title={m.display_name} aria-hidden="true">
                  {avatarLetter(m.display_name)}
                </div>
              {/each}
              {#if session.members.length > 8}
                <div class="avatar-sm more" title={`还有 ${session.members.length - 8} 人`} aria-hidden="true">…</div>
              {/if}
            </div>
            <span class="muted members-count">共 {session.members.length} 人</span>
          </div>
          <!-- T9: owner token hint 在 summary 内,始终可见 -->
          {#if isOwner && session.invite_token_preview}
            <div class="owner-token-hint muted">
              owner token: <code>{session.invite_token_preview.slice(0, 8)}…</code>
              {#if session.invite_expires_at}
                <span class="hint-inline">· {new Date(session.invite_expires_at).toLocaleString('zh-CN')}</span>
              {/if}
            </div>
          {/if}
        </summary>

        <!-- T9: 展开后 inline 紧凑成员列表 (替换 SessionMemberList 组件) -->
        <ul class="member-list-compact">
          {#each session.members as m (m.id)}
            <li class="member-row">
              <div class="avatar-md" aria-hidden="true">{avatarLetter(m.display_name)}</div>
              <div class="member-row-info">
                <span class="member-row-name">
                  {m.display_name}{#if m.role === 'owner'}<span class="role-badge-inline">owner</span>{/if}
                </span>
                <span class="muted member-row-email">{m.email}</span>
              </div>
              <span
                class="member-row-net"
                class:pos={(memberIdToNet[m.id] ?? 0) > 0}
                class:neg={(memberIdToNet[m.id] ?? 0) < 0}
              >
                {memberIdToNet[m.id] !== undefined ? fmtNet(memberIdToNet[m.id]) : ''}
              </span>
              {#if isOwner && m.role !== 'owner'}
                <button
                  type="button"
                  class="ghost btn-sm"
                  title="owner-only: v0.2 待 BE 支持 removeMember"
                  aria-label="删除成员 (v0.2 待 BE 支持,当前禁用)"
                  disabled
                >删除</button>
              {/if}
            </li>
          {/each}
        </ul>
      </details>
    </div>

    <div class="card">
      <div class="row between" style="margin-bottom: var(--space-3); flex-wrap: wrap; gap: var(--space-2);">
        <h3 style="margin: 0;">账单</h3>
        <span class="muted" style="font-size: var(--font-size-sm);">共 {bills.length} 笔</span>
      </div>
      <BillListGrouped
        {bills}
        sessionId={session.id}
        memberIdToName={memberIdToName}
        currentUserMemberId={currentMemberId}
        onDelete={handleDeleteBill}
      />
    </div>
  {/if}
</section>

<style>
  /* === T9: members summary === */
  .members-card {
    padding: 0;
    overflow: hidden;
  }
  .members-summary {
    list-style: none;
    cursor: pointer;
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    user-select: none;
  }
  .members-summary::-webkit-details-marker {
    display: none;
  }
  .members-summary::marker {
    display: none;
    content: '';
  }
  .members-summary-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .members-title {
    font-weight: 600;
    font-size: 1rem;
  }
  .members-summary-actions {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .members-toggle-icon {
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-muted, #666);
    font-size: 18px;
    font-weight: 400;
    line-height: 1;
    user-select: none;
  }
  .members-summary-stack {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .avatar-stack {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
  }
  .avatar-sm {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--color-accent, #3b82f6);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 12px;
    border: 2px solid var(--color-surface, #fff);
    margin-left: -6px;
    flex: 0 0 auto;
  }
  .avatar-sm:first-child {
    margin-left: 0;
  }
  .avatar-sm.more {
    background: var(--color-text-muted, #6b7280);
  }
  .members-count {
    font-size: var(--font-size-sm);
  }
  .owner-token-hint {
    font-size: var(--font-size-sm);
  }
  .owner-token-hint code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: rgba(0, 0, 0, 0.05);
    padding: 1px 6px;
    border-radius: 4px;
  }
  .hint-inline {
    margin-left: var(--space-1);
  }
  details.members-section[open] .members-summary {
    border-bottom: 1px solid var(--color-border);
    margin-bottom: var(--space-2);
  }
  details.members-section[open] {
    padding-bottom: var(--space-2);
  }

  /* === T9: 紧凑成员列表 (替换原 SessionMemberList) === */
  .member-list-compact {
    list-style: none;
    padding: 0 var(--space-3) var(--space-3);
    margin: 0;
  }
  .member-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--color-border);
  }
  .member-row:last-child {
    border-bottom: none;
  }
  .avatar-md {
    flex: 0 0 auto;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--color-accent, #3b82f6);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 14px;
  }
  .member-row-info {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .member-row-name {
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
  }
  .role-badge-inline {
    display: inline-block;
    background: var(--color-accent, #3b82f6);
    color: #fff;
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 999px;
    font-weight: 500;
  }
  .member-row-email {
    font-size: var(--font-size-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .member-row-net {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
    font-size: var(--font-size-sm);
    color: var(--color-text-muted, #666);
    min-width: 56px;
    text-align: right;
  }
  .member-row-net.pos {
    color: var(--color-success, #16a34a);
  }
  .member-row-net.neg {
    color: var(--color-error, #dc2626);
  }

  .btn-sm {
    min-height: 36px;
    padding: 4px 10px;
    font-size: var(--font-size-sm);
  }
</style>
