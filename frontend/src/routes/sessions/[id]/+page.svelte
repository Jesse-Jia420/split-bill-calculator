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

  onMount(load);

  async function handleDeleteBill(billId: number) {
    if (!confirm('确认删除这笔账单?')) return;
    try {
      await deleteBill(sessionId, billId);
      bills = bills.filter((b) => b.id !== billId);
    } catch (e: any) {
      error = e?.message ?? '删除失败';
    }
  }

  function fmtAmount(n: number): string {
    return n.toFixed(2);
  }
  function fmtDate(iso: string): string {
    try {
      return new Date(iso).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return iso;
    }
  }
  function payerName(b: Bill): string {
    return memberIdToName[b.payer_id] ?? ('#' + b.payer_id);
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

    <div class="card">
      <div class="row between" style="margin-bottom: var(--space-3);">
        <h3 style="margin: 0;">成员</h3>
        <InviteLinkButton sessionId={session.id} {isOwner} />
      </div>
      <SessionMemberList members={session.members} />
      <!-- v0.1.1: owner sees the live token inline for copy convenience.
           Non-owners get nothing extra here (use the InviteLinkButton to view). -->
      {#if isOwner && session.invite_token_preview}
        <div class="muted owner-token-hint">
          owner 视图：当前链接 <code>{session.invite_token_preview.slice(0, 8)}…</code>
        </div>
      {/if}
    </div>

    <div class="card">
      <h3>账单</h3>
      {#if bills.length === 0}
        <p class="muted">还没有账单</p>
      {:else}
        <ul class="bill-list list" style="list-style: none; padding: 0; margin: 0;">
          {#each bills as b (b.id)}
            <li class="bill-row">
              <div class="row between" style="flex-wrap: wrap; gap: var(--space-2);">
                <div>
                  <div class="bill-desc">{b.description || '(无说明)'}</div>
                  <div class="muted bill-meta">
                    {payerName(b)} 付 · {fmtDate(b.occurred_at)} · {b.participants.length} 人
                  </div>
                </div>
                <div class="row" style="gap: var(--space-2);">
                  <span class="amount">{fmtAmount(b.amount)} {b.currency}</span>
                  <button class="ghost btn-sm" on:click={() => handleDeleteBill(b.id)}>删除</button>
                </div>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</section>

<style>
  .bill-row {
    padding: var(--space-3) 0;
  }
  .bill-desc {
    font-weight: 500;
  }
  .bill-meta {
    font-size: var(--font-size-sm);
    margin-top: 2px;
  }
  .amount {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .btn-sm {
    min-height: 36px;
    padding: 4px 10px;
    font-size: var(--font-size-sm);
  }
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
</style>
