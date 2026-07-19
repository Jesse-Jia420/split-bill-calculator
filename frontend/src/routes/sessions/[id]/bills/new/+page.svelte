<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { getSessionWithSecret } from '$api/sessions';
  import { createBill, listBills } from '$api/bills';
  import type { SessionDetail } from '$api/sessions';
  import { loadUser } from '$stores/user';
  // v0.3.15 (PRD §3.15.2 #7): Lucide ArrowLeft 替代 ← Unicode.
  // 父页面在 #6 删了顶部返回 div, 但 spec 拍板阶段设计稿里保留
  // 这个 import 作为可视化校对锚 (PO 拍板的 "返回" 文案 -> ArrowLeft 图标
  // 替换契约)。本页面实际上**不**渲染返回按钮 — 返回动作由
  // BillForm.svelte 内部 sticky action bar 提供。
  import { ArrowLeft } from 'lucide-svelte';
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
    <!-- v0.3.16 #8 (PO msg 19:26): 字段简化 — 去 'session:' 前缀, 只留 session.name。 -->
    <p class="muted">{session.name}</p>

    <div class="card">
      <BillForm
        {session}
        {defaultPayerMemberId}
        {existingBillsCount}
        onSubmit={handleSubmit}
      />
    </div>
  {/if}
</section>
