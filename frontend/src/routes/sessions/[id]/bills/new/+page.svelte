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
  // v0.3.29 UAT 0725-1 #7: bills/new + bills/edit 补 LoadingOverlay 跟其他 7 路由一致.
  import LoadingOverlay from '$components/LoadingOverlay.svelte';
  import { toast } from '$stores/toast';

  let session: SessionDetail | null = null;
  let loading = true;

  // v0.1.2 (T19): pass this into BillForm so the payer dropdown
  // defaults to the caller's own SessionMember.id in this session.
  let defaultPayerMemberId: number | null = null;

  // v0.3.20 #93 (PO msg 00:04 #7450, Fix 1): removed existingBillsCount tracking (smart-date chips deleted).

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
      // v0.3.20 #93 (Fix 1): removed existingBillsCount tally.
    } catch (e: any) {
      // v0.3.15 (PO #4807): 错误统一走 Toast
      toast.error(e?.message ?? '加载失败');
    } finally {
      loading = false;
    }
  });

  async function handleSubmit(payload: any) {
    await createBill(sessionId, payload);
    // v0.3.x (UAT #0723-3 #3): 跳 /s/{session_code} unguessable 格式 (代替 /sessions/{id})
    await goto('/s/' + (session?.session_code || String(sessionId)));
  }
</script>

<section>
  {#if loading}
    <!-- v0.3.29 UAT 0725-1 #7: LoadingOverlay (Option C 玻璃圆环) 跟 v0.3.28 #5 一致. -->
    <LoadingOverlay text="加载账单..." />
  {:else if session}
    <h2>新建账单</h2>
    <!-- v0.3.16 #8 (PO msg 19:26): 字段简化 — 去 'session:' 前缀, 只留 session.name。 -->
    <p class="muted">{session.name}</p>

    <div class="card">
      <BillForm
        {session}
        {defaultPayerMemberId}
        onSubmit={handleSubmit}
      />
    </div>

    <!-- v0.3.15 §3.15.2 #6 v2 (PO msg #4752+#4763): 圆形 FAB
         v0.3.16 #8 (PO msg 19:26): 加 .glass-pill 玻璃化 (保留 50% 圆形 + 白色 icon) -->
    <!-- v0.3.x (UAT #0723-3 #3): /s/{session_code} unguessable 格式 (代替 /sessions/{id}) -->
    <a
      class="fab glass-pill fab-left"
      href="/s/{session?.session_code || String(sessionId)}"
      aria-label="返回"
      in:fly={{ y: 60, duration: 400, delay: 200 }}
    >
      <ArrowLeft size={30} strokeWidth={2.4} />
    </a>
    <button
      type="submit"
      class="fab glass-pill fab-right"
      form="bill-form"
      aria-label="保存"
      in:fly={{ y: 60, duration: 400, delay: 250 }}
    >
      <Check size={30} strokeWidth={2.8} />
    </button>
  {/if}
</section>

<style>
  /* v0.3.15 §3.15.2 #6 v2: 圆形 FAB (跟 session 主页「新建账单」FAB 同形态)
   * v0.3.16 #8 (PO msg 19:26): 加 .glass-pill 玻璃化 — bg/box-shadow/border 由
   *   .glass-pill 提供。
   * v0.3.16 #9 (PO msg 20:01): FAB icon color 改主题色 — 删 color: #fff (icon 白色在浅紫
   *   玻璃上看不清),改由 .glass-pill 提供 var(--accent-700, #4338ca) 深紫主题色。
   *   .fab 写在 .glass-pill 之后 → 同 specificity 时 .fab 后定义覆盖 .glass-pill。 */
  .fab {
    position: fixed;
    bottom: 28px;
    width: 80px;
    height: 80px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    /* glass-pill 提供 bg / box-shadow / border / backdrop-filter / color (var(--accent-700, #4338ca)),
       这里只补 padding + z-index + 圆形保持。icon 颜色 = 主题色,跟玻璃协调。 */
    z-index: 100;
    text-decoration: none;
    border: none;
    cursor: pointer;
    padding: 0;
    transition: transform 150ms ease, box-shadow 150ms ease, background 150ms ease, color 150ms ease;
  }
  .fab-left { left: 28px; }
  .fab-right { right: 28px; }
  /* .fab:hover 不再写 color — 由 .glass-pill:hover 全局处理 (icon 颜色保持主题色) */
  .fab:hover { transform: translateY(-2px); }
  .fab:active { transform: scale(0.96); }
  .fab:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }
  @media (max-width: 600px) {
    .fab { bottom: 20px; }
    .fab-left { left: 20px; }
    .fab-right { right: 20px; }
  }
</style>