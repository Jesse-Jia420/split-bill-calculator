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
  import { onMount } from 'svelte';
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

  function toggleExclusive(memberId: number) {
    if (!participantState[memberId]) return;
    const cur = participantState[memberId];
    if (cur.exclusive) {
      cur.exclusive = false;
      cur.amount = '0';
    } else {
      cur.exclusive = true;
      if (!cur.amount || cur.amount === '0') cur.amount = '';
    }
    participantState = { ...participantState };
  }

  // v0.3.19 #84 (PO #7306 + #7082 + #7085): 单 chip 三态切换 (PO 拍板 v3 ghost link).
  // 删 sub-row 展开方案 (反 #7085 否定), 改成 chip 原地切换:
  //   - 默认 (amount==0, !editing): ghost 文字 "独占" (14px gray-400, 无 bg/border)
  //   - 编辑 (editing==true): white pill + accent 描边 + ¥ + input
  //   - 数字 (amount>0, !editing): accent pill "独占 ¥500 ✎"
  //
  // `editingMemberId` is purely UI state — it tracks which row is in
  // edit mode. It does NOT participate in `buildPayload`; the
  // `exclusive` flag in `participantState` is what gets serialized.
  let editingMemberId: number | null = null;

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
   * v0.3.19 #84 (PO #7082): 进入编辑态 — chip 原地切换成 input pill.
   * 同时把 `exclusive=true` 标记上, 让 payload 知道这行是独占金额模式.
   */
  function enterEditMode(memberId: number) {
    const st = participantState[memberId];
    if (!st) return;
    editingMemberId = memberId;
    st.exclusive = true;
    if (!st.amount || st.amount === '0') st.amount = '';
    participantState = { ...participantState };
  }

  /**
   * v0.3.19 #84 (PO #7082 + #7085): 退出编辑态 — blur 时立即切回 pill,
   * 不等合法值才切 (PO #7085 拍板). 若值非法 (< 0, NaN, 空) 则清值
   * 并关掉 exclusive, 避免持久化空字符串.
   */
  function exitEditMode(memberId: number) {
    const st = participantState[memberId];
    if (!st) return;
    editingMemberId = null;
    const n = Number(st.amount);
    if (!st.amount || st.amount === '' || !Number.isFinite(n) || n <= 0) {
      st.exclusive = false;
      st.amount = '0';
    }
    participantState = { ...participantState };
  }



  function buildPayload() {
    const participants: Array<{ member_id: number; is_exclusive: boolean; exclusive_amount: number }> = [];
    for (const m of session.members) {
      const st = participantState[m.id];
      if (!st || !st.included) continue;
      let excl = 0;
      if (st.exclusive) {
        const n = Number(st.amount);
        excl = Number.isFinite(n) && n > 0 ? n : 0;
      }
      participants.push({
        member_id: m.id,
        is_exclusive: st.exclusive,
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
        {#each session.members as m (m.id)}
          {@const st = participantState[m.id]}
          {@const isEditing = editingMemberId === m.id}
          {@const hasNumber = st?.exclusive && Number(st.amount) > 0}
          <li class="ppt-row" data-testid={`ppts-li-${m.id}`}>
            <!-- v0.3.19 #84 (PO #7082+#7085+#7306): 单 chip 三态切换.
                 不再展开 sub-row (反 #7085); 整个切换在 chip 原地完成.
                 - ghost (默认): 仅 "独占" 文字, 14px gray-400, 无 bg/border
                 - input (编辑): ¥ + input, 14px white bg + accent 描边 + 30px 焦点光晕
                 - pill (数字): ¥500 ✎, 13px accent bg + 1px accent border -->
            <button
              type="button"
              class="ppt-main"
              on:click={() => toggleParticipant(m.id)}
              data-testid={`ppts-row-${m.id}`}
              aria-pressed={st?.included ?? false}
            >
              <span class="ppt-check-icon" aria-hidden="true">{st?.included ? '☑' : '☐'}</span>
              <span class="ppt-name">{m.display_name}</span>
            </button>
            {#if isEditing}
              <div class="excl-chip excl-chip-input" data-testid={`ppts-chip-${m.id}`}>
                <span class="excl-sym">{currencySymbol(currency)}</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  class="excl-input"
                  bind:value={st.amount}
                  on:blur={() => exitEditMode(m.id)}
                  placeholder="0.00"
                  aria-label={`${m.display_name} 的独占金额`}
                  data-testid={`ppts-amount-${m.id}`}
                />
              </div>
            {:else if hasNumber}
              <button
                type="button"
                class="excl-chip excl-chip-number"
                on:click={() => enterEditMode(m.id)}
                aria-label={`修改 ${m.display_name} 的独占金额`}
                data-testid={`ppts-chip-${m.id}`}
              >
                {currencySymbol(currency)}{st.amount}
                <span class="excl-edit-icon" aria-hidden="true">✎</span>
              </button>
            {:else}
              <button
                type="button"
                class="excl-chip excl-chip-ghost"
                on:click={() => enterEditMode(m.id)}
                aria-label={`为 ${m.display_name} 设置独占金额`}
                data-testid={`ppts-chip-${m.id}`}
              >独占</button>
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
  .ppt-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* v0.3.19 #84 (PO #7082 + #7085 + #7306): 单 chip 三态切换 — v3 ghost link.
     删旧 ppt-toggle / ppt-sub-row / ppt-excl-badge 整套 (反 #7085 否定展开).
     整个切换在 chip 原地完成 (opacity 150ms, 无 slide/rotate):
       - ghost (默认): 仅 "独占" 文字, 14px gray-400, 无 bg/border, 12×8 padding
       - input (编辑): white bg + accent 描边 + 焦点光晕, ¥ + input, 14px/600
       - pill (数字): accent 浅 bg + 1px accent border, ¥500 ✎, 13px/700
     chip 宽度允许独立变化; member name 用 flex:1 吸收剩余空间. */
  .excl-chip {
    display: inline-flex;
    align-items: center;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 150ms ease-out;
    flex: 0 0 auto;
  }
  /* 默认 ghost — 14px / 400 / gray-400 / 仅文字 / 无 bg/border / 12×8 padding */
  .excl-chip-ghost {
    font-size: 14px;
    font-weight: 400;
    color: var(--gray-400, #a3a3a3);
    background: transparent;
    border: none;
    padding: 12px 8px;
    min-height: 38px;
  }
  .excl-chip-ghost:active {
    opacity: 0.5;
  }
  /* 编辑 input — white bg + accent 描边 + 焦点光晕 + ¥ + input */
  .excl-chip-input {
    background: var(--color-bg, #fff);
    border: 1px solid var(--accent-500, #3b82f6);
    border-radius: 999px;
    padding: 4px 10px;
    font-size: 14px;
    box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.12);
    gap: 4px;
  }
  .excl-sym {
    color: var(--gray-500, #6b7280);
    font-weight: 500;
  }
  .excl-input {
    background: transparent;
    border: none;
    outline: none;
    font-size: 14px;
    font-weight: 600;
    color: var(--gray-900, #171717);
    width: 60px;
    padding: 2px 0;
    font-variant-numeric: tabular-nums;
  }
  .excl-input::placeholder {
    color: var(--gray-400, #9ca3af);
  }
  @media (prefers-reduced-motion: reduce) {
    .excl-chip {
      transition-duration: 0ms;
    }
  }
  /* 数字 pill — accent 浅 bg + 1px accent border + ¥500 ✎ */
  .excl-chip-number {
    font-size: 13px;
    font-weight: 700;
    color: var(--accent-700, #1d4ed8);
    background: rgba(99, 102, 241, 0.08);
    border: 1px solid rgba(99, 102, 241, 0.15);
    border-radius: 999px;
    padding: 2px 8px;
    gap: 4px;
  }
  .excl-chip-number:active {
    background: rgba(99, 102, 241, 0.15);
  }
  .excl-edit-icon {
    font-size: 11px;
    opacity: 0.6;
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
