<script lang="ts">
  import { onMount } from 'svelte';
  import type { SessionDetail } from '$api/sessions';
  import type { Bill, ParseBillResult } from '$api/bills';
  import { evaluateExpression } from '$api/calculator';
  import AiAssistInput from './AiAssistInput.svelte';
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
  // participant state, keyed by SessionMember.id
  let participantState: Record<number, { included: boolean; exclusive: boolean; amount: string }> = {};
  for (const m of session.members) {
    participantState[m.id] = { included: true, exclusive: false, amount: '0' };
  }
  let showAi = false;
  let submitting = false;
  let formError: string | null = null;
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

  function applyAiResult(res: ParseBillResult) {
    if (res.amount && Number(res.amount) > 0) {
      // AI 辅助 — 用纯数字填入 expression, 计算器立刻得到金额
      amount = Number(res.amount);
      amountExpression = String(res.amount);
    }
    if (res.description) {
      description = res.description;
      descriptionPristine = false;
    }
    // resolve payer_hint
    if (res.payer_hint && res.payer_hint !== 'self') {
      const m = session.members.find((x) => x.display_name === res.payer_hint);
      if (m) payerMemberId = m.id;
    }
    // resolve participants_hint
    if (Array.isArray(res.participants_hint) && res.participants_hint.length) {
      const allFlag = res.participants_hint.includes('all');
      for (const m of session.members) {
        const st = participantState[m.id];
        if (!st) continue;
        if (allFlag) {
          st.included = true;
        } else {
          st.included = res.participants_hint.includes(m.display_name);
        }
      }
      participantState = { ...participantState };
    }
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
    return {
      amount: amount ?? 0,
      payer_member_id: payerMemberId ?? 0,
      description: description.trim() ? description.trim() : null,
      occurred_at: new Date(occurredAt).toISOString(),
      currency: currency || 'CNY',
      participants,
      amount_expression: expr,
      use_calculator: useCalc,
    };
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    formError = null;
    const p = buildPayload();
    if (amount == null || !Number.isFinite(amount) || amount <= 0) {
      formError = '请填写金额(大于 0)';
      return;
    }
    if (!p.payer_member_id) {
      formError = '请选择付款人';
      return;
    }
    if (!p.participants.length) {
      formError = '至少勾选一个参与者';
      return;
    }
    submitting = true;
    try {
      if (onSubmit) await onSubmit(p);
    } catch (err: any) {
      formError = err?.message ?? '提交失败';
    } finally {
      submitting = false;
    }
  }
</script>

<form class="stack" on:submit={handleSubmit}>
  <div class="row" style="gap: var(--space-3); flex-wrap: wrap;">
    <div style="flex: 2; min-width: 140px;">
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
    <div style="flex: 1; min-width: 100px;">
      <label class="label" for="currency">币种</label>
      <input id="currency" type="text" bind:value={currency} maxlength="8" />
    </div>
  </div>

  {#if smartDateChips.length > 0 && !isEdit}
    <div class="smart-dates" aria-label="快速日期">
      <span class="muted hint">首笔 session — 快速选择日期:</span>
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

  <div>
    <label class="label" for="payer">付款人</label>
    <select id="payer" bind:value={payerMemberId}>
      <option value={null}>— 选择 —</option>
      {#each session.members as m (m.id)}
        <option value={m.id}>{m.display_name}</option>
      {/each}
    </select>
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
    {#if !canEditDescription}
      <div class="muted hint" data-testid="description-readonly-hint">
        说明在账单录入后不可修改(PO 06-30 T17 拍板)
      </div>
    {/if}
  </div>

  <div>
    <label class="label" for="occurredAt">发生时间</label>
    <input id="occurredAt" type="datetime-local" bind:value={occurredAt} />
  </div>

  <div>
    <div class="row between">
      <span class="label">参与者</span>
      {#if !isEdit}
        <button type="button" class="ghost btn-sm" on:click={() => (showAi = !showAi)}>
          {showAi ? '收起 AI 辅助' : 'AI 辅助'}
        </button>
      {/if}
    </div>
    {#if showAi && !isEdit}
      <div style="margin-bottom: var(--space-3);">
        <AiAssistInput sessionId={session.id} onResult={applyAiResult} />
      </div>
    {/if}

    <ul class="ppts list" style="list-style: none; margin: 0; padding: 0;">
      {#each session.members as m (m.id)}
        {@const st = participantState[m.id]}
        <li class="ppt-row">
          <label class="ppt-check">
            <input
              type="checkbox"
              checked={st?.included ?? false}
              on:change={() => toggleParticipant(m.id)}
            />
            <span>{m.display_name}</span>
          </label>
          <label class="ppt-excl">
            <input
              type="checkbox"
              checked={st?.exclusive ?? false}
              disabled={!st?.included}
              on:change={() => toggleExclusive(m.id)}
            />
            <span class="muted">独占</span>
          </label>
          {#if st?.exclusive}
            <input
              type="number"
              min="0"
              step="0.01"
              bind:value={st.amount}
              placeholder="独占金额"
              style="max-width: 120px;"
            />
          {/if}
        </li>
      {/each}
    </ul>
  </div>

  {#if formError}
    <div class="error">{formError}</div>
  {/if}

  <div class="row">
    <button class="primary" type="submit" disabled={submitting}>
      {submitting
        ? (isEdit ? '保存中…' : '保存中…')
        : (isEdit ? '保存修改' : '保存账单')}
    </button>
  </div>
</form>

<style>
  .smart-dates {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin-top: calc(-1 * var(--space-2, 8px));
  }
  .smart-dates .chips {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .smart-dates .chip {
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
  .smart-dates .chip:active {
    background: var(--accent-500, #3b82f6);
    color: #fff;
    border-color: var(--accent-500, #3b82f6);
    transform: scale(0.97);
  }

  .ppts li {
    padding: var(--space-2) 0;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .ppt-check {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--touch-target);
    flex: 1;
  }
  .ppt-excl {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    min-height: var(--touch-target);
  }
  .ppt-row {
    border-bottom: 1px solid var(--color-border);
  }
  .ppt-row:last-child {
    border-bottom: none;
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
</style>
