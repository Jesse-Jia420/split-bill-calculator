<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { getSessionWithSecret } from '$api/sessions';
  import { createBill, listBills } from '$api/bills';
  import type { SessionDetail } from '$api/sessions';
  import { loadUser } from '$stores/user';
  // v0.3.15 (PRD §3.15.2 #6 v2, PO msg #4752+#4763): 圆形 FAB 替代 sticky bar。
  // - 左下 FAB: ArrowLeft (返回 session)
  // - 右下 FAB: Check (保存账单, 走 form="bill-form" 外部 submit)
  // 跟 session 主页「新建账单」FAB 同形态 (56×56 圆形 + indigo 渐变)。
  import { ArrowLeft, Check } from 'lucide-svelte';
  import { fly } from 'svelte/transition';
  import BillForm from '$components/BillForm.svelte';
  import { toast } from '$stores/toast';

  let session: SessionDetail | null = null;
  let loading = true;

  // v0.1.2 (T19): pass this into BillForm so the payer dropdown
  // defaults to the caller's own SessionMember.id in this session.
  let defaultPayerMemberId: number | null = null;

  // v0.2.1 T03 (smart-date chips): only show "今天 / 昨天 / 上周"
  // when this session has zero bills yet. Hooked through the
  // ``existingBillsCount`` prop below.
  let existingBillsCount = 0;

  $: sessionId = Number(page.params.id);

  onMount(async () => {
    try {
      // v0.3.2: use getSessionWithSecret so anon callers (X-Nickname-Secret
      // in localStorage) can read session detail. Plain getSession only
      // sends cookie auth and 403s for anon slots.
      const result = await getSessionWithSecret(sessionId);
      session = result.session;
      // Find the SessionMember that maps to the current user. If the
      // caller isn't yet a member (shouldn't happen in normal flow but
      // be defensive), `defaultPayerMemberId` stays null and the user
      // picks manually. For anon callers, actingAsMemberId IS the member
      // row id and user_id is null, so use that as defaultPayer.
      const u = await loadUser();
      if (u && session) {
        const me = session.members.find((m) => m.user_id === u.user_id);
        if (me) defaultPayerMemberId = me.id;
      } else if (result.actingAsMemberId && session) {
        defaultPayerMemberId = result.actingAsMemberId;
      }
      // v0.2.1 T03: tally the bills to decide whether the smart-date
      // chips appear. We tolerate the listBills call failing (e.g. the
      // caller is brand-new without GET /sessions/{id}/bills access)
      // by defaulting to "0 bills".
      try {
        const all = await listBills(sessionId);
        existingBillsCount = all.length;
      } catch {
        existingBillsCount = 0;
      }
    } catch (e: any) {
      // v0.3.15 (PO #4807): 错误统一走 Toast
      toast.error(e?.message ?? '加载失败');
    } finally {
      loading = false;
    }
  });

  async function handleSubmit(payload: any) {
    await createBill(sessionId, payload);
    await goto('/sessions/' + sessionId);
  }
</script>

<section>
  {#if loading}
    <p class="muted">加载中…</p>
  {:else if session}
    <h2>新建账单</h2>
    <p class="muted">session: {session.name}</p>

    <div class="card">
      <BillForm
        {session}
        {defaultPayerMemberId}
        {existingBillsCount}
        onSubmit={handleSubmit}
      />
    </div>

    <!-- v0.3.15 §3.15.2 #6 v2 (PO msg #4752+#4763): 圆形 FAB -->
    <a
      class="fab fab-left"
      href="/sessions/{sessionId}"
      aria-label="返回"
      in:fly={{ y: 60, duration: 400, delay: 200 }}
    >
      <ArrowLeft size={24} strokeWidth={2.4} />
    </a>
    <button
      type="submit"
      class="fab fab-right"
      form="bill-form"
      aria-label="保存"
      in:fly={{ y: 60, duration: 400, delay: 250 }}
    >
      <Check size={24} strokeWidth={2.8} />
    </button>
  {/if}
</section>

<style>
  /* v0.3.15 §3.15.2 #6 v2: 圆形 FAB (跟 session 主页「新建账单」FAB 同形态) */
  .fab {
    position: fixed;
    bottom: 24px;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--accent-500);
    color: #fff;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
    z-index: 100;
    text-decoration: none;
    border: none;
    cursor: pointer;
    padding: 0;
    transition: transform 150ms ease, box-shadow 150ms ease, background-color 150ms ease;
  }
  .fab-left { left: 24px; }
  .fab-right { right: 24px; }
  .fab:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.22);
    background: var(--accent-700);
  }
  .fab:active { transform: scale(0.96); }
  .fab:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
    box-shadow: 0 0 0 4px var(--accent-500);
  }
  @media (max-width: 600px) {
    .fab { bottom: 16px; }
    .fab-left { left: 16px; }
    .fab-right { right: 16px; }
  }
</style>