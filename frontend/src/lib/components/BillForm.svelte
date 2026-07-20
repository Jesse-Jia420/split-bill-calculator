<script lang="ts">
  /**
   * v0.3.15 (PRD §3.15.2 #6 v2, PO msg #4752+#4763) — FAB 圆形按钮:
   * - 父页面 `bills/new` + `bills/edit` 在 `<form>` 外加左右两个圆形 FAB:
   *     左 = 圆形 + ArrowLeft (返回 session)
   *     右 = 圆形 + Check (保存, 走 `form="bill-form"` 外部 submit 桥接)
   * - 本组件只负责:
   *     (1) `<form id="bill-form">` — 让外部 FAB save button 能 submit;
   *     (2) 不再画 sticky bar (反 PO 拍板: 圆形 FAB 比 sticky bar 更轻量,
   *         跟 session 主页「新建账单」FAB 同形态)。
   *
   * v0.3.15 (PO #4807 + Designer 报告) — 错误统一走 Toast.
   * - 删 `let formError` 状态 + form 顶部 `<div class="error">` 模板 + data-testid
   * - 4 个 formError 赋值源 (3 客户端校验 + 1 BE 错误) → toast.error()
   * - humanizeApiError() helper 保留 (返回 string, 仍被 toast 消费)
   */
  import { onMount, tick } from 'svelte';
  import type { SessionDetail } from '$api/sessions';
  import type { Bill } from '$api/bills';
  import { evaluateExpression } from '$api/calculator';
  import { currencySymbol } from '$lib/utils/currency';
  import { ApiError } from '$api/client';
  import { toast } from '$stores/toast';
    import AmountCalculatorInput from './AmountCalculatorInput.svelte';

  /**
   * v0.1.2 (PO 2026-07-01 fix #3): edit-page support.
   *
   * - `mode: 'create' | 'edit'` controls the submit button label, AI
   *   helper visibility (hidden in edit), and whether `description` is
   *   editable. Defaults to 'create' so existing call sites that
   *   construct `<BillForm />` keep working unchanged.
   * - `existingBill?: Bill` is the source of truth for the prefilled
   *   form state in edit mode. In create mode it is ignored.
   *
   * v0.1.2 (T17, earlier): `description` is intentionally read-only in
   * edit mode because the backend's UpdateBillRequest has it stripped
   * (Pydantic `extra='forbid'`). The UI surfaces this with a disabled
   * input + helper text instead of silently dropping user input.
   */
  export let session: SessionDetail;
  /** Called with a ready-to-POST / PATCH payload. */
  export let onSubmit: ((payload: {
    amount: number;
    payer_member_id: number;
    description: string | null;
    occurred_at: string;
    currency: string;
    participants: Array<{ member_id: number; is_exclusive: boolean; exclusive_amount: number }>;
    // v0.2.1 T01: raw calculator expression echoed back to the BE.
    // Empty string when the user typed no expression (in which case the
    // BE keeps the supplied `amount` and stores NULL for amount_expression).
    amount_expression: string;
    // Whether the BE should re-evaluate `amount_expression` and overwrite
    // `amount` (always true when the user typed into the calculator).
    use_calculator: boolean;
  }) => Promise<void> | void) | null = null;

  /**
   * v0.1.2 (T19): if provided, the payer dropdown will default to this
   * SessionMember.id when the form first mounts. Pass the caller's own
   * SessionMember.id from the new-bill page (which already has the user
   * + session in scope). If null/undefined the dropdown starts blank and
   * the user has to pick.
   */
  export let defaultPayerMemberId: number | null = null;

  /** v0.1.2 (fix #3): create or edit. Defaults to 'create'. */
  export let mode: 'create' | 'edit' = 'create';
  /** v0.1.2 (fix #3): when mode === 'edit', prefill the form. */
  export let existingBill: Bill | null = null;

  /**
   * v0.2.1 T03 (PRD §3.6.3): when this prop > 0 the smart-date chips
   * are suppressed (the session already has bills). When 0 — i.e. the
   * first bill of the session — we render "今天 / 昨天 / 上周" quick
   * chips above the date input. Only consulted in create mode.
   */
  export let existingBillsCount: number = 0;

  $: isEdit = mode === 'edit';
  $: canEditDescription = !isEdit;

  // v0.2.1 T01: the AmountCalculatorInput owns the amount field. ``amount`` is
  // the currently-evaluated number (null when the expression is empty or
  // invalid); ``amountExpression`` is the raw string the user typed (also
  // written back to the API as ``amount_expression``).
  let amount: number | null = null;
  let amountExpression: string = '';
  let payerMemberId: number | null = null;
  let description = '';
  let occurredAt: string = new Date().toISOString().slice(0, 16); // datetime-local
  let currency = 'CNY';

  // v0.3.15 (PRD §3.15.2 #2): currencySymbol moved to
  // lib/utils/currency.ts so other components (SettleTransferPath,
  // SessionCurrencyBadge) share the same mapping. Function
  // declaration removed; calls below still go through the import.

  // participant state, keyed by SessionMember.id
  let participantState: Record<number, { included: boolean; exclusive: boolean; amount: string }> = {};
  for (const m of session.members) {
    participantState[m.id] = { included: true, exclusive: false, amount: '0' };
  }

  /** v0.3.20 #91 (PO msg 03:06 #7375): avatar palette — 5 色循环复用 SessionMemberList 渐变. */
  const AVATAR_GRADIENTS = [
    'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)', // indigo → purple
    'linear-gradient(135deg, #ec4899 0%, #f43f5e 100%)', // pink → rose
    'linear-gradient(135deg, #10b981 0%, #14b8a6 100%)', // emerald → teal
    'linear-gradient(135deg, #f59e0b 0%, #eab308 100%)', // amber → yellow
    'linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%)', // blue → cyan
  ];
  function avatarGradient(index: number): string {
    return AVATAR_GRADIENTS[index % AVATAR_GRADIENTS.length];
  }
  /**
   * v0.3.20 #91: avatar 首字符 — 英文 1 字母大写, 中文 1 字.
   * (mockup 用 2 字母 "Ju/Ca", 按 PO 拍板改为 1 字母 "J/C".)
   */
  function avatarInitial(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return '?';
    const code = trimmed.codePointAt(0) ?? 0;
    if (code > 127) return trimmed.slice(0, 1);
    return trimmed.slice(0, 1).toUpperCase();
  }

  /**
   * v0.3.20 #91: pill 进入 exclusive 态后, 需要自动 focus 进 input.
   * 用 inputRefs 收集 input 元素, tick() 后 .focus() + .select().
   */
  let inputRefs: Record<number, HTMLInputElement | null> = {};

  let submitting = false;
  let descriptionPristine = true;

  // v0.2.1 T02+T03: last-bill participants + smart date suggestions.
  // These are read once on mount so the form can prefetch defaults before
  // the user starts interacting.
  let smartDateChips: Array<{ label: string; dateLocal: string }> = [];
  let lastParticipantsApplied = false;

  // v0.1.2 (T19 + fix #3): apply the caller-supplied default payer once
  // the form mounts. In create mode we use defaultPayerMemberId; in edit
  // mode the existing bill's payer wins (if it's still a session member).
  onMount(() => {
    if (isEdit && existingBill) {
      // Prefill from existing bill.
      amount = existingBill.amount;
      amountExpression = existingBill.amount_expression
        ? existingBill.amount_expression
        : String(existingBill.amount);
      payerMemberId = existingBill.payer_id;
      // description: visible but not editable. Keep its current value
      // so the user can see what they're editing.
      description = existingBill.description ?? '';
      descriptionPristine = true;
      // Convert ISO datetime to the datetime-local input format
      // (YYYY-MM-DDTHH:mm) in local time.
      const d = new Date(existingBill.occurred_at);
      if (!isNaN(d.getTime())) {
        const pad = (n: number) => String(n).padStart(2, '0');
        occurredAt =
          `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
          `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
      currency = existingBill.currency || 'CNY';
      // Rebuild participant state from existing participants; missing
      // members default to "not included" (the form's create-mode
      // default is "all included" — for edit we honour the persisted
      // truth).
      for (const m of session.members) {
        const ep = existingBill.participants.find((p) => p.member_id === m.id);
        participantState[m.id] = ep
          ? {
              included: true,
              exclusive: !!ep.is_exclusive,
              amount: ep.exclusive_amount ? String(ep.exclusive_amount) : '0',
            }
          : { included: false, exclusive: false, amount: '0' };
      }
      participantState = { ...participantState };
      return;
    }
    if (
      defaultPayerMemberId != null &&
      payerMemberId === null &&
      session.members.some((m) => m.id === defaultPayerMemberId)
    ) {
      payerMemberId = defaultPayerMemberId;
    }

    // v0.2.1 T02: default-勾选「最近一笔账单的参与者」(create mode only).
    // PRD §3.6.2 — first visit (no prior bills) 走 v0.1.1 默认: 全员 included.
    if (!isEdit && !lastParticipantsApplied) {
      const lastSet = session.last_bill_participants;
      // 前端 localStorage fallback: 网络错误 / 接口降级时仍能保留上次选择
      try {
        const lsKey = `sbc.lastParticipants.${session.id}`;
        const lsRaw = localStorage.getItem(lsKey);
        const lsSet = lsRaw ? JSON.parse(lsRaw) : null;
        if (Array.isArray(lsSet) && lsSet.length > 0 && (!Array.isArray(lastSet) || lastSet.length === 0)) {
          // Fallback 仅在 BE 没返回时用
          applyParticipantsDefault(lsSet);
        } else if (Array.isArray(lastSet) && lastSet.length > 0) {
          applyParticipantsDefault(lastSet);
          localStorage.setItem(lsKey, JSON.stringify(lastSet));
        }
      } catch {
        // localStorage 可能被禁用 — 静默忽略
      }
      lastParticipantsApplied = true;
    }

    // v0.2.1 T03: 首笔 session (没有账单) 显示 3 个 chip 「今天 / 昨天 / 上周」。
    // 非空时不显示 (避免不停呈现「今天」)。PRD §3.6.3。
    if (existingBillsCount === 0 && !isEdit && session.members.length >= 1) {
      const today = new Date();
      const fmt = (d: Date) => {
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T08:00`;
      };
      const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
      const lastWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
      smartDateChips = [
        { label: '今天', dateLocal: fmt(today) },
        { label: '昨天', dateLocal: fmt(yesterday) },
        { label: '上周', dateLocal: fmt(lastWeek) },
      ];
    }
  });

  function applyParticipantsDefault(memberIds: number[]) {
    const valid = new Set(memberIds);
    for (const m of session.members) {
      const st = participantState[m.id];
      if (!st) continue;
      st.included = valid.has(m.id);
    }
    participantState = { ...participantState };
    // Persist for next time.
    try {
      localStorage.setItem(`sbc.lastParticipants.${session.id}`, JSON.stringify(memberIds));
    } catch {
      // ignore
    }
  }

  function toggleParticipant(memberId: number) {
    if (!participantState[memberId]) return;
    participantState[memberId].included = !participantState[memberId].included;
    participantState = { ...participantState };
  }

  // v0.3.20 #91 (PO msg 03:06 #7375): pill 改为两态切换 (shared 虚 ↔ exclusive 实).
  //   - shared (默认): "个人消费 ¥" ghost 玻璃, 102×32 钉死
  //   - exclusive (实): ¥ + input + stepper, accent 玻璃, 102×32 钉死
  // 不再有第三个"数字 pill"态 — input 永远显示, 数字直接读 input.
  // 点 shared → enterExclusive (focus input)
  // 点 ¥ / pill 内非 input 区 → exitExclusive (清 invalid amount)
  // 点 ▲▼ → stepAmount (在 exclusive 内 ±1, 不切回 shared)
  //
  // `st.exclusive` 是 source of truth, buildPayload 直接读它.
  // 无需 editingMemberId 之类的中间 UI 状态.

  /** Count of currently-included members (header summary). */
  $: includedCount = session.members.reduce(
    (n, m) => n + (participantState[m.id]?.included ? 1 : 0),
    0
  );
  /** True when every member is included (drives the 全选/清空 toggle label). */
  $: allIncluded =
    session.members.length > 0 &&
    session.members.every((m) => participantState[m.id]?.included);

  /** Toggle all members included/excluded at once. */
  function toggleAllParticipants() {
    const target = !allIncluded;
    for (const m of session.members) {
      const st = participantState[m.id];
      if (st) st.included = target;
    }
    participantState = { ...participantState };
  }

  /**
   * v0.3.20 #91: 进入独占态 — shared pill → exclusive pill.
   * focus input 让用户立即可键入金额.
   */
  async function enterExclusiveMode(memberId: number) {
    const st = participantState[memberId];
    if (!st) return;
    st.exclusive = true;
    if (!st.amount || st.amount === '0') st.amount = '';
    participantState = { ...participantState };
    await tick();
    const input = inputRefs[memberId];
    if (input) {
      input.focus();
      input.select();
    }
  }

  /**
   * v0.3.20 #91: 退出独占态 — 点击 ¥ 或 pill 内非 input 区.
   * amount 若非法 (空 / NaN / ≤ 0) 则清零; 合法则保留以便下次进入时还在.
   */
  function exitExclusiveMode(memberId: number) {
    const st = participantState[memberId];
    if (!st) return;
    const n = Number(st.amount);
    st.exclusive = false;
    if (!st.amount || st.amount === '' || !Number.isFinite(n) || n <= 0) {
      st.amount = '0';
    }
    participantState = { ...participantState };
  }

  /**
   * v0.3.20 #91: stepper 按钮 — 在 exclusive 态内 ±1 调整金额, 不切回 shared.
   */
  function stepAmount(memberId: number, delta: number) {
    const st = participantState[memberId];
    if (!st) return;
    const n = Number(st.amount);
    const cur = Number.isFinite(n) && n > 0 ? n : 0;
    const next = Math.max(0, cur + delta);
    st.amount = next > 0 ? String(next) : '';
    participantState = { ...participantState };
  }



  function buildPayload() {
    const participants: Array<{ member_id: number; is_exclusive: boolean; exclusive_amount: number }> = [];
    for (const m of session.members) {
      const st = participantState[m.id];
      if (!st || !st.included) continue;
      // v0.3.20 #91: amount 非法 (空 / NaN / ≤ 0) 时把 is_exclusive 也归零,
      // 避免发 "is_exclusive=true, exclusive_amount=0" 这种自相矛盾的状态.
      let is_exclusive = st.exclusive;
      let excl = 0;
      if (st.exclusive) {
        const n = Number(st.amount);
        if (Number.isFinite(n) && n > 0) {
          excl = n;
        } else {
          is_exclusive = false;
        }
      }
      participants.push({
        member_id: m.id,
        is_exclusive,
        exclusive_amount: excl
      });
    }
    // v0.2.1 T01: send BOTH the expression and the evaluated amount.
    // use_calculator flips on whenever the expression is non-empty
    // (e.g. "350/5") so the BE re-evaluates and stores both.
    // Edit-mode expressions are echoed back verbatim; the BE's regex
    // reject any malformed expressions with 422 before storage.
    const expr = amountExpression.trim();
    const useCalc = expr.length > 0;
    // v0.3.1 (TEST-006 fix): in edit mode, strip `description` from the
    // payload. The BE's UpdateBillRequest has `extra='forbid'` AND no
    // `description` field — sending `description=null` (even null) was
    // rejected with 422 by Pydantic. The description is immutable (PO
    // T17) so we never need to send it again on PATCH.
    const payload: any = {
      amount: amount ?? 0,
      payer_member_id: payerMemberId ?? 0,
      occurred_at: new Date(occurredAt).toISOString(),
      currency: currency || 'CNY',
      participants,
      amount_expression: expr,
      use_calculator: useCalc,
    };
    if (!isEdit) {
      payload.description = description.trim() ? description.trim() : null;
    }
    return payload;
  }

  // v0.3.15 (PO #4790, P0-2 — Designer report):
  //   Translates a BE 4xx response into a one-line, human-actionable
  //   hint for the inline form error. Two shapes we have to handle:
  //
  //   (a) Pydantic 422 validation error — `detail` is an ARRAY of
  //       `{loc: ['body', 'amount'], msg: '...', type: '...'}`. We
  //       surface the first one as "amount: Field required" so the
  //       user can fix the right input.
  //   (b) Business 4xx — `detail` is an OBJECT `{error: 'code',
  //       hint?: 'free-form'}`. We render "code (hint)" so users
  //       learn both the protocol-level code and a friendlier string.
  //
  //   Anything else falls through to `err.message` (which for
  //   ApiError is "422 http_422" — visible, but not great) or
  //   '提交失败'. Returning `string` keeps the call-site tidy.
  function humanizeApiError(err: any): string {
    if (!err) return '提交失败';
    if (Array.isArray(err.detail) && err.detail.length > 0) {
      const first = err.detail[0];
      const loc = Array.isArray(first?.loc) ? first.loc.slice(1) : [];
      const field = loc.length ? loc.join('.') + ': ' : '';
      return field + (first?.msg || '字段错误');
    }
    if (err.detail && typeof err.detail === 'object' && !Array.isArray(err.detail)) {
      const code = err.detail.error || '提交失败';
      const hint = err.detail.hint;
      return hint ? `${code} (${hint})` : code;
    }
    return err?.message ?? '提交失败';
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    const p = buildPayload();
    if (amount == null || !Number.isFinite(amount) || amount <= 0) {
      toast.error('请填写金额(大于 0)');
      return;
    }
    if (!p.payer_member_id) {
      toast.error('请选择付款人');
      return;
    }
    if (!p.participants.length) {
      toast.error('至少勾选一个参与者');
      return;
    }
    submitting = true;
    try {
      if (onSubmit) await onSubmit(p);
    } catch (err: any) {
      // v0.3.15 (PO #4807): 错误统一走 Toast. humanizeApiError 把
      // Pydantic 422 字段路径 + 业务码翻译成可操作字符串, 不是 "422 http_422".
      toast.error(humanizeApiError(err));
    } finally {
      submitting = false;
    }
  }
</script>

<form class="stack" id="bill-form" on:submit={handleSubmit}>
  <!-- v0.3.15 (PO #4807 + Designer 报告): form-level error 改走 Toast 系统,
       不再渲染 inline 错误块. form 仍保留 padding-bottom: 96px 让最后
       一行 member 不被左右下角 FAB 遮挡 (5-member session 测过). -->
  <div style="width: 100%;">
    <label class="label" for="amount">金额</label>
    <!-- v0.2.1 T01: AmountCalculatorInput replaces the bare number input.
         Calculator preview lives inside the component; this row holds the
         currency suffix only. -->
    <AmountCalculatorInput
      bind:value={amountExpression}
      bind:evaluated={amount}
      {currency}
      disabled={submitting}
      on:change={(e) => (amountExpression = e.detail)}
      on:amountChange={(e) => (amount = e.detail)}
    />
  </div>

  <div class="row" style="gap: var(--space-3);">
    <div style="flex: 1;">
      <label class="label" for="payer">付款人</label>
      <select id="payer" bind:value={payerMemberId}>
        <option value={null}>— 选择 —</option>
        {#each session.members as m (m.id)}
          <option value={m.id}>{m.display_name}</option>
        {/each}
      </select>
    </div>
    <div style="flex: 1; min-width: 100px;">
      <span class="label" id="currency-pills-label">币种</span>
      <!-- v0.2.2 (T10): currency pill selector. The session may declare
           1 or 2 allowed currencies; we render chips so the user can
           pick one. For 1-currency sessions we still render a
           non-interactive chip so the field never disappears entirely. -->
      <div class="currency-pills" role="radiogroup" aria-labelledby="currency-pills-label">
        {#each (session.currencies && session.currencies.length > 0 ? session.currencies : [currency]) as code (code)}
          <button
            type="button"
            class="currency-pill"
            class:active={currency === code}
            class:disabled={session.currencies && session.currencies.length <= 1}
            role="radio"
            aria-checked={currency === code}
            disabled={(session.currencies && session.currencies.length <= 1) || submitting}
            on:click={() => (currency = code)}
          >{code}</button>
        {/each}
      </div>
    </div>
  </div>

  <div>
    <label class="label" for="desc">说明(可选)</label>
    <input
      id="desc"
      type="text"
      bind:value={description}
      placeholder="例: 晚餐"
      maxlength="500"
      disabled={!canEditDescription}
      on:input={() => (descriptionPristine = false)}
    />

  </div>

  <div>
    <label class="label" for="occurredAt">发生时间</label>
    <!-- v0.3.2 (Bug 3 — 2026-07-07): 右上空白 box。
         iOS Safari / mobile Chrome 上 <input type="datetime-local"> 不渲染
         ::-webkit-calendar-picker-indicator 但仍给 picker icon 留出固定宽度。
         在 360-390px viewport 下, 该空白正好搭在屏幕右边 → 看起来像一个
         "empty white box overlapping the right edge"。
         修法: 包一层 .datetime-row (relative), 隐藏原生 indicator,
         用 .datetime-icon 显示一个真正的 📅 emoji (pointer-events: none)。
         Tap / focus 输入框仍能正常唤起 native picker (iOS wheel / Chrome modal). -->
    <div class="datetime-row">
      <input id="occurredAt" type="datetime-local" bind:value={occurredAt} />
      <span class="datetime-icon" aria-hidden="true">📅</span>
    </div>
    <!-- v0.3.15 #4 (PO #4828): 把"快速选择日期"挪到发生时间段内, 行内快捷入口.
         原 .smart-dates 是独立 segment; 现在跟 datetime-local input 视觉关联. -->
    {#if smartDateChips.length > 0 && !isEdit}
      <div class="quick-dates-inline" aria-label="快速日期">
        <span class="muted hint">首笔账本 — 快速选择日期:</span>
        <div class="chips">
          {#each smartDateChips as chip}
            <button
              type="button"
              class="chip"
              on:click={() => (occurredAt = chip.dateLocal)}
            >{chip.label}</button>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <div>
    <div class="row between">
      <span class="label">
        参与者 ({includedCount}/{session.members.length} 已选)
      </span>
    </div>

    <!-- v0.2.3 T14 (PRD §3.9.2): single tap area per row + chevron-expandable sub-row.
         Hide the whole section when the session has no members. -->
    {#if session.members.length > 0}
      <div class="row between ppts-toggle-row">
        <span class="muted ppts-meta">{session.members.length} 名成员</span>
        <button
          type="button"
          class="link-btn"
          on:click={toggleAllParticipants}
          data-testid="ppts-toggle-all"
          aria-label={allIncluded ? '清空全部参与者' : '全选全部参与者'}
        >{allIncluded ? '清空' : '全选'}</button>
      </div>
      <ul class="ppts list" style="list-style: none; margin: 0; padding: 0;" data-testid="ppts-list">
        {#each session.members as m, i (m.id)}
          {@const st = participantState[m.id]}
          <li class="ppt-row" data-testid={`ppts-li-${m.id}`}>
            <!-- v0.3.20 #91 (PO msg 03:06 #7375): 头像 + 两态 pill (shared/exclusive).
                 - 行 main 区: checkbox icon + 头像 (36×36 gradient + 1 字符首字母) + name.
                   点整行 = toggle 参与 / 不参与.
                 - pill 区 (102×32 钉死):
                   · shared (虚): "个人消费 ¥" ghost 玻璃, 点 → 进 exclusive
                   · exclusive (实): ¥ + input + stepper, accent 玻璃, 点 ¥ → 回 shared -->
            <button
              type="button"
              class="ppt-main"
              on:click={() => toggleParticipant(m.id)}
              data-testid={`ppts-row-${m.id}`}
              aria-pressed={st?.included ?? false}
            >
              <span class="ppt-check-icon" aria-hidden="true">{st?.included ? '☑' : '☐'}</span>
              <span class="ppt-avatar" aria-hidden="true" style="background: {avatarGradient(i)};">
                {avatarInitial(m.display_name)}
              </span>
              <span class="ppt-name">{m.display_name}</span>
            </button>
            {#if st?.exclusive}
              <!-- exclusive 实态: ¥ + input + stepper, accent 玻璃 -->
              <div
                class="excl-pill excl-pill-exclusive"
                role="group"
                aria-label={`${m.display_name} 的个人消费金额`}
                data-testid={`ppts-chip-${m.id}`}
                data-state="exclusive"
              >
                <button
                  type="button"
                  class="pill-currency"
                  on:click={() => exitExclusiveMode(m.id)}
                  aria-label={`退出 ${m.display_name} 的个人消费`}
                >{currencySymbol(currency)}</button>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  class="pill-input"
                  bind:value={st.amount}
                  bind:this={inputRefs[m.id]}
                  placeholder="0.00"
                  aria-label={`${m.display_name} 的个人消费金额`}
                  data-testid={`ppts-amount-${m.id}`}
                />
                <span class="pill-stepper">
                  <button
                    type="button"
                    class="pill-step pill-step-up"
                    on:click={() => stepAmount(m.id, 1)}
                    aria-label={`增加 ${m.display_name} 的个人消费`}
                  >▲</button>
                  <button
                    type="button"
                    class="pill-step pill-step-down"
                    on:click={() => stepAmount(m.id, -1)}
                    aria-label={`减少 ${m.display_name} 的个人消费`}
                  >▼</button>
                </span>
              </div>
            {:else}
              <!-- shared 虚态: "个人消费 ¥" ghost 玻璃, 点 → 进 exclusive -->
              <button
                type="button"
                class="excl-pill excl-pill-shared"
                on:click={() => enterExclusiveMode(m.id)}
                aria-label={`为 ${m.display_name} 设置个人消费`}
                data-testid={`ppts-chip-${m.id}`}
                data-state="shared"
              >
                <span class="pill-label">个人消费</span>
                <span class="pill-currency" aria-hidden="true">{currencySymbol(currency)}</span>
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <!-- v0.3.15 (PO #4790, P0-1): the inline error was previously rendered HERE
       (after the participants list) which physically overlapped the bottom-left
       back-FAB. It now lives at the TOP of the form (see above) so it never
       collides with the page-level FABs. -->

  <!-- v0.3.15 §3.15.2 #6 v2 (PO msg #4752+#4763): 父页面在 <form> 外加左右两个圆形 FAB。
       这里**不**画 sticky bar — 圆形 FAB 由 `bills/new/+page.svelte` 和
       `bills/[billId]/edit/+page.svelte` 在 page 层用 <a class="fab fab-left"> +
       <button form="bill-form" class="fab fab-right"> 实现。 -->
</form>

<style>
  /* v0.3.15 #4 (PO #4828): 把"快速选择日期"挪到发生时间段内, 行内快捷入口.
     - 父容器: gap 8px + margin-top 8px 跟 datetime-local input 视觉关联
     - chip 本身样式 (背景 / 边框 / 圆角 / 字号 / min-height / active 颜色)
       保持 v0.2.1 T03 原文不变, 只把 selector 从 .smart-dates → .quick-dates-inline */
  .quick-dates-inline {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 8px;
  }
  .quick-dates-inline .chips {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .quick-dates-inline .chip {
    appearance: none;
    background: var(--color-bg, #fff);
    border: 1px solid var(--color-border, #e5e7eb);
    color: var(--color-text, #111827);
    padding: 6px 14px;
    border-radius: 999px;
    font-size: var(--font-size-sm, 13px);
    font-weight: 500;
    min-height: 36px;
    cursor: pointer;
    transition: background-color 120ms ease, transform 80ms ease;
    -webkit-tap-highlight-color: transparent;
  }
  .quick-dates-inline .chip:active {
    background: var(--accent-500, #3b82f6);
    color: #fff;
    border-color: var(--accent-500, #3b82f6);
    transform: scale(0.97);
  }

  /* v0.2.3 T14 (PRD §3.9.2): participants row layout.
     Each row = single main button (checkbox icon + name + optional
     exclusive-amount badge) + a chevron button. The chevron expands
     an indented sub-row with the number input for the exclusive amount.
     No two checkboxes share a row anymore. */
  .ppts-toggle-row {
    padding: 4px 2px 6px 2px;
  }
  .ppts-meta {
    font-size: var(--font-size-sm, 13px);
  }
  .link-btn {
    background: none;
    border: none;
    color: var(--accent-500, #3b82f6);
    font-size: var(--font-size-sm, 13px);
    font-weight: 500;
    cursor: pointer;
    padding: 6px 10px;
    min-height: 32px;
    border-radius: var(--radius-md, 8px);
    -webkit-tap-highlight-color: transparent;
    transition: background-color 120ms ease;
  }
  .link-btn:active {
    background: var(--gray-100, #f3f4f6);
  }
  .ppts li.ppt-row {
    padding: 0;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .ppt-row {
    border-bottom: 1px solid var(--color-border, #e5e7eb);
  }
  .ppt-row:last-child {
    border-bottom: none;
  }
  .ppt-main {
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    gap: var(--space-2, 8px);
    min-height: var(--touch-target, 44px);
    padding: 8px 10px;
    margin: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-md, 8px);
    color: var(--color-text, #111827);
    text-align: left;
    cursor: pointer;
    font-size: 15px;
    -webkit-tap-highlight-color: transparent;
    transition: background-color 120ms ease;
  }
  .ppt-main:active {
    background: var(--gray-100, #f3f4f6);
  }
  .ppt-check-icon {
    font-size: 18px;
    line-height: 1;
    flex: 0 0 22px;
    text-align: center;
    color: var(--accent-500, #3b82f6);
  }
  /* v0.3.20 #91 (PO msg 03:06 #7375): 头像 — 36×36 圆形 + 5 色 palette + 1 字符首字母.
     复用 SessionMemberList 的 5 色 AVATAR_GRADIENTS, 尺寸放大到 36×36 (比 chip 28px 大)
     以适配 row 高度 ~60px. */
  .ppt-avatar {
    flex: 0 0 auto;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 14px;
    line-height: 1;
    letter-spacing: -0.01em;
    box-shadow: inset 0 0 0 0.5px rgba(255, 255, 255, 0.4);
    -webkit-tap-highlight-color: transparent;
    user-select: none;
  }
  .ppt-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* v0.3.20 #91 (PO msg 03:06 #7375): pill 两态切换 (shared 虚 ↔ exclusive 实).
     删 v0.3.19 #84 三态 (反 #7085 拍板): 不再有 "数字 pill" 独立态, input 永远在 exclusive 态显示.

     pill 尺寸钉死: 102×32, border-radius 16px (full), flex-shrink:0.
     两态宽高完全一致, 只视觉虚实区分 (PO 强调不许跟内容 / 状态变).
       - shared 虚: "个人消费 ¥" ghost 玻璃, 13px gray-700 + ¥ gray-400 小一号
       - exclusive 实: ¥ + input + stepper, accent 玻璃, focus border 加深 accent-600 */
  .excl-pill {
    flex: 0 0 auto;
    width: 102px;
    height: 32px;
    min-width: 102px;
    min-height: 32px;
    border-radius: 16px;
    display: inline-flex;
    align-items: center;
    box-sizing: border-box;
    white-space: nowrap;
    font-family: inherit;
    cursor: pointer;
    transition: background-color 150ms ease-out, border-color 150ms ease-out, box-shadow 150ms ease-out;
    -webkit-tap-highlight-color: transparent;
    overflow: hidden;
  }
  @media (prefers-reduced-motion: reduce) {
    .excl-pill {
      transition-duration: 0ms;
    }
  }

  /* shared (虚) — 浅白 bg + 淡紫 border + "个人消费 ¥"
     hover: bg 提升 0.85→0.95 + border 0.18→0.30 */
  .excl-pill-shared {
    background: rgba(255, 255, 255, 0.85);
    border: 1px solid rgba(99, 102, 241, 0.18);
    padding: 0 12px;
    gap: 6px;
    justify-content: space-between;
    color: var(--gray-700, #334155);
  }
  .excl-pill-shared:hover {
    background: rgba(255, 255, 255, 0.95);
    border-color: rgba(99, 102, 241, 0.30);
  }
  .excl-pill-shared:active {
    background: rgba(99, 102, 241, 0.06);
  }
  .pill-label {
    font-size: 13px;
    font-weight: 500;
    color: var(--gray-700, #334155);
    letter-spacing: -0.01em;
  }
  .excl-pill-shared .pill-currency {
    font-size: 12px;
    font-weight: 500;
    color: var(--gray-400, #94a3b8);
    letter-spacing: -0.01em;
  }

  /* exclusive (实) — 浅紫 bg + accent border + ¥ + input + stepper
     focus: border 加深 accent-600 */
  .excl-pill-exclusive {
    background: rgba(99, 102, 241, 0.10);
    border: 1px solid rgba(99, 102, 241, 0.55);
    padding: 0 6px 0 8px;
    gap: 2px;
    cursor: default;
  }
  .excl-pill-exclusive:focus-within {
    border-color: var(--accent-600, #4f46e5);
    box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
  }
  .pill-currency {
    flex: 0 0 auto;
    background: transparent;
    border: 0;
    padding: 0 2px;
    font-size: 13px;
    font-weight: 500;
    color: var(--gray-500, #64748b);
    cursor: pointer;
    line-height: 1;
    font-family: inherit;
  }
  .excl-pill-exclusive .pill-currency {
    color: var(--accent-600, #4f46e5);
    font-weight: 600;
  }
  .pill-input {
    flex: 0 0 auto;
    width: 40px;
    min-width: 0;
    background: transparent;
    border: 0;
    outline: 0;
    padding: 0;
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--accent-600, #4f46e5);
    text-align: center;
    font-variant-numeric: tabular-nums;
    font-family: inherit;
    -moz-appearance: textfield;
    appearance: textfield;
  }
  .pill-input::-webkit-outer-spin-button,
  .pill-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .pill-input::placeholder {
    color: rgba(99, 102, 241, 0.35);
    font-weight: 500;
  }
  .pill-stepper {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin-left: 1px;
  }
  .pill-step {
    width: 14px;
    height: 13px;
    border: 0;
    padding: 0;
    background: rgba(99, 102, 241, 0.10);
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent-600, #4f46e5);
    font-size: 7px;
    line-height: 1;
    cursor: pointer;
    font-weight: 700;
    font-family: inherit;
    -webkit-tap-highlight-color: transparent;
    transition: background-color 100ms ease-out;
  }
  .pill-step:hover {
    background: rgba(99, 102, 241, 0.22);
  }
  .pill-step:active {
    background: rgba(99, 102, 241, 0.35);
  }
  .btn-sm {
    min-height: 36px;
    padding: 4px 10px;
    font-size: var(--font-size-sm);
  }
  .hint {
    font-size: var(--font-size-sm);
    margin-top: 4px;
  }

  /* v0.2.2 (T10): currency pill selector */
  .currency-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 4px;
  }
  .currency-pill {
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    padding: 0.25rem 0.75rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--color-text);
    cursor: pointer;
    min-height: 32px;
    transition: background 0.12s ease, border-color 0.12s ease;
  }
  .currency-pill:hover:not(.disabled):not(:disabled) {
    border-color: rgba(99, 102, 241, 0.5);
  }
  .currency-pill.active {
    background: #6366f1;
    color: white;
    border-color: #6366f1;
  }
  .currency-pill:disabled,
  .currency-pill.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* v0.3.2 (Bug 3 — 2026-07-07): datetime-local 上 ::-webkit-calendar-picker-indicator
     在 iOS Safari / mobile Chrome 上不渲染但仍占位, 在 ~360-390px viewport
     形成"右上空白 box"。修法 = 隐藏原生 indicator + 用 .datetime-icon 占位。 */
  .datetime-row {
    position: relative;
    display: block;
  }
  .datetime-row input[type="datetime-local"] {
    width: 100%;
    /* 给右侧 .datetime-icon 留位置 — 即使原生 indicator 偷偷出现也压住 */
    padding-right: 40px;
    /* iOS / mobile 上不要显示原生 picker indicator (空 box 根因) */
    -webkit-appearance: none;
    appearance: none;
  }
  /* 隐藏原生 picker indicator 但保留点击区 — display:none 会让 iOS wheel 不再唤起 */
  .datetime-row input[type="datetime-local"]::-webkit-calendar-picker-indicator {
    opacity: 0;
    position: absolute;
    right: 0;
    top: 0;
    width: 40px;
    height: 100%;
    cursor: pointer;
  }
  .datetime-row input[type="datetime-local"]::-webkit-inner-spin-button,
  .datetime-row input[type="datetime-local"]::-webkit-clear-button {
    display: none;
    -webkit-appearance: none;
  }
  .datetime-icon {
    position: absolute;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    pointer-events: none;
    font-size: 18px;
    line-height: 1;
    opacity: 0.55;
  }

  /* v0.3.15 §3.15.2 #6 v2 (PO msg #4752+#4763): 删掉 sticky action bar 整段 CSS。
     FAB 圆形按钮样式 (`.fab / .fab-left / .fab-right`) 移到父页面
     `bills/new/+page.svelte` 和 `bills/[billId]/edit/+page.svelte` 的
     `<style>` 块里 — 跟 session 主页「新建账单」FAB
     (sessions/[id]/+page.svelte) 保持视觉一致
     (56×56 圆形 + indigo 渐变 + 阴影)。 */

  /* v0.3.15 (PO #4790, P0-1 — Designer report): reserve 96px at the
     bottom of the form so the last member row stays scroll-clear of
     the page-level bottom-left / bottom-right FABs (56×56 + 16px
     inset + ~24px breathing room). Scoped: only affects the form in
     this component, leaves the global .stack utility rule alone. */
  .stack {
    padding-bottom: 96px;
  }

</style>
