<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { getSession } from '$api/sessions';
  import { listBills, deleteBill } from '$api/bills';
  import type { SessionDetail } from '$api/sessions';
  import type { Bill } from '$api/bills';
  import SessionMemberList from '$components/SessionMemberList.svelte';
  import InviteLinkButton from '$components/InviteLinkButton.svelte';
  import BillListGrouped from '$components/BillListGrouped.svelte';
  import { user } from '$stores/user';

  let session: SessionDetail | null = null;
  let bills: Bill[] = [];
  let loading = true;
  let error: string | null = null;

  // map SessionMember.id -> display_name
  let memberIdToName: Record<number, string> = {};

  $: sessionId = Number($page.params.id);

  // v0.1.1: invite button needs to know if the caller is the owner
  // (only the owner sees the "rotate" affordance).
  $: currentMember = session
    ? session.members.find((m) => m.user_id === $user?.user_id) ?? null
    : null;
  $: isOwner = currentMember?.role === 'owner';

  // T7 (PO 反馈): members section 默认折叠 (collapsed)。
  // 用原生 <details> 作为 single source of truth，localStorage 跨刷新记住用户选择。
  // 反模式预防 (沿用 T1 BillListGrouped 的 on:toggle 同步模式):
  // Svelte 5 模板里直接读 details.open 会触发反应性，但若用 {#if membersOpen} + 函数返回值
  // 会有反应性陷阱（同 T1 反馈 1）；这里直接 bind:open 到 Svelte 变量，模板用变量判断。
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
      // ignore corrupt localStorage
    }
  }

  function saveMembersOpen() {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(membersStorageKey(), String(membersOpen));
    } catch {
      // localStorage might be full or disabled; non-fatal
    }
  }

  function handleMembersToggle(e: Event) {
    const el = e.currentTarget as HTMLDetailsElement;
    membersOpen = el.open;
    saveMembersOpen();
  }

  // T7: 给头像叠放显示首字母大写
  function avatarLetter(name: string): string {
    const trimmed = (name ?? '').trim();
    return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
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
      bills = await listBills(sessionId);
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
</script>

<section>
  {#if loading}
    <p class="muted">加载中…</p>
  {:else if error}
    <div class="error">{error}</div>
  {:else if session}
    <div class="row between" style="margin-bottom: var(--space-3); flex-wrap: wrap; gap: var(--space-2);">
      <h2 style="margin: 0;">{session.name}</h2>
      <div class="row" style="gap: var(--space-2); flex-wrap: wrap;">
        <a class="btn" href="/sessions/{session.id}/settle">查看结算</a>
        <a class="btn primary" href="/sessions/{session.id}/bills/new">+ 新建账单</a>
      </div>
    </div>

    <!-- T7: 成员 section 折叠（原生 <details> + localStorage 持久化） -->
    <div class="card members-card">
      <details class="members-section" open={membersOpen} on:toggle={handleMembersToggle}>
        <summary class="members-summary">
          <div class="members-summary-head">
            <h3 style="margin: 0;">成员</h3>
            <span class="muted toggle-hint">
              {membersOpen ? '点击折叠' : '点击展开'}
            </span>
          </div>
          <!-- 折叠时 + 展开时都展示（PO 明确要求 InviteLinkButton 始终可见） -->
          <div class="members-summary-body">
            <InviteLinkButton sessionId={session.id} {isOwner} />
            <div class="collapsed-avatars" aria-label="成员头像">
              {#each session.members.slice(0, 8) as m}
                <div class="avatar-sm" title={m.display_name} aria-hidden="true">
                  {avatarLetter(m.display_name)}
                </div>
              {/each}
              {#if session.members.length > 8}
                <div class="avatar-sm more" title={`还有 ${session.members.length - 8} 人`} aria-hidden="true">…</div>
              {/if}
              {#if session.members.length > 0}
                <span class="muted avatar-count">共 {session.members.length} 人</span>
              {/if}
            </div>
          </div>
        </summary>

        <!-- 展开时：完整成员列表 + owner token 提示 -->
        <SessionMemberList members={session.members} />
        <!-- v0.1.1: owner sees the live token inline for copy convenience.
             Non-owners get nothing extra here (use the InviteLinkButton to view). -->
        {#if isOwner && session.invite_token_preview}
          <div class="muted owner-token-hint">
            owner 视图：当前链接 <code>{session.invite_token_preview.slice(0, 8)}…</code>
          </div>
        {/if}
      </details>
    </div>

    <div class="card">
      <div class="row between" style="margin-bottom: var(--space-3); flex-wrap: wrap; gap: var(--space-2);">
        <h3 style="margin: 0;">账单</h3>
        <div class="row" style="gap: var(--space-2); flex-wrap: wrap; align-items: center;">
          <!-- T8: 个人账单快捷按钮 → settle 页 + #personal hash 自动切个人视图 -->
          <a class="btn ghost" href="/sessions/{session.id}/settle#personal">
            个人账单
          </a>
          <span class="muted" style="font-size: var(--font-size-sm);">
            共 {bills.length} 笔
          </span>
        </div>
      </div>
      <BillListGrouped
        {bills}
        sessionId={session.id}
        memberIdToName={memberIdToName}
        onDelete={handleDeleteBill}
      />
    </div>
  {/if}
</section>

<style>
  .owner-token-hint {
    margin-top: var(--space-3);
    font-size: var(--font-size-sm);
  }
  .owner-token-hint code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: rgba(0, 0, 0, 0.05);
    padding: 1px 6px;
    border-radius: 4px;
  }

  /* T7: members section 折叠样式 */
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
  /* 移除 webkit/moz 默认的小三角 marker */
  .members-summary::-webkit-details-marker {
    display: none;
  }
  .members-summary::marker {
    display: none;
    content: '';
  }
  .members-summary-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }
  .toggle-hint {
    font-size: var(--font-size-sm);
  }
  .members-summary-body {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .collapsed-avatars {
    display: flex;
    align-items: center;
    gap: 0;
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
  }
  .avatar-sm:first-child {
    margin-left: 0;
  }
  .avatar-sm.more {
    background: var(--color-text-muted, #6b7280);
  }
  .avatar-count {
    margin-left: var(--space-2);
    font-size: var(--font-size-sm);
  }
  /* 展开时给 summary 加底部分隔 */
  details.members-section[open] .members-summary {
    border-bottom: 1px solid var(--color-border);
    margin-bottom: var(--space-3);
  }
  details.members-section[open] {
    padding: 0 var(--space-3) var(--space-3);
  }
</style>