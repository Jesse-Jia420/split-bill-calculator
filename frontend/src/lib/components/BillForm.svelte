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

  /** v0.3.1 (PO Bug #1): derive a display symbol from the currency code.
   * Falls back to the currency code itself when no symbol is known
   * (e.g. AUD, SGD) so we never show the wrong sign. */
  function currencySymbol(code: string): string {
    const map: Record<string, string> = {
      CNY: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥',
      THB: '฿', KRW: '₩', HKD: 'HK$', TWD: 'NT$',
    };
    return map[code?.toUpperCase()] ?? code;
  }

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

  // v0.2.3 T14 (PRD §3.9.2): the participants section was redesigned —
  // each row is now a single tappable button that toggles `included`,
  // and a chevron expands a sub-row containing the exclusive-amount
  // number input. The data structure (`participantState`) and the
  // submit-time payload (`buildPayload`) are unchanged.
  //
  // `subRowOpen` is purely UI state — it tracks which rows have their
  // exclusive-amount sub-row expanded. It does NOT participate in
  // `buildPayload`; the `exclusive` flag in `participantState` is what
  // gets serialized, and the chevron toggle keeps that flag in sync
  // with the visible sub-row.
  let subRowOpen: Record<number, boolean> = {};

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
   * Toggle the sub-row for a single member. On open: mark the row
   * `exclusive=true` so the number input is meaningful. On close via
   * chevron: clear `exclusive` if the amount is zero/empty so the
   * persisted bill doesn't carry a spurious `is_exclusive=true`.
   */
  function toggleSubRow(memberId: number) {
    const st = participantState[memberId];
    if (!st) return;
    const wasOpen = !!subRowOpen[memberId];
    subRowOpen[memberId] = !wasOpen;
    subRowOpen = { ...subRowOpen };
    if (!wasOpen) {
      st.exclusive = true;
      if (!st.amount || st.amount === '0') st.amount = '';
      participantState = { ...participantState };
    } else {
      const n = Number(st.amount);
      if (!st.amount || st.amount === '' || !Number.isFinite(n) || n <= 0) {
        st.exclusive = false;
        st.amount = '0';
        participantState = { ...participantState };
      }
    }
  }

  /** Ensure sub-row is open while the number input is focused. */
  function onSubRowFocus(memberId: number) {
    if (!subRowOpen[memberId]) {
      subRowOpen[memberId] = true;
      subRowOpen = { ...subRowOpen };
    }
  }

  /**
   * Blur handler — collapse the sub-row (per spec "失去焦点时自动收起"),
   * and clear the exclusive flag when the amount is zero/empty so the
   * persisted `is_exclusive` matches what the user actually sees.
   */
  function onSubRowBlur(memberId: number) {
    const st = participantState[memberId];
    if (!st) return;
    if (subRowOpen[memberId]) {
      subRowOpen[memberId] = false;
      subRowOpen = { ...subRowOpen };
    }
    const n = Number(st.amount);
    if (!st.amount || st.amount === '' || !Number.isFinite(n) || n <= 0) {
      st.exclusive = false;
      st.amount = '0';
      participantState = { ...participantState };
    }
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
      <span class="label">
        参与者 ({includedCount}/{session.members.length} 已选)
      </span>
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
          {@const isSubOpen = subRowOpen[m.id] ?? false}
          <li class="ppt-row" class:sub-open={isSubOpen} data-testid={`ppts-li-${m.id}`}>
            <!-- Main row: single button toggling `included`. -->
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
            <!-- v0.3.1 (PO Bug #2): inline exclusive-amount input on the
                 right of each participant row. Default '0'. When amount
                 is 0 (or empty) the label + value are muted gray; when
                 non-zero the whole row goes solid black. -->
            <label class="ppt-excl" data-testid={`ppts-excl-${m.id}`}
              class:muted={!st?.exclusive || Number(st.amount) === 0}>
              <span class="ppt-excl-label">独占金额</span>
              <span class="ppt-excl-sym">{currencySymbol(currency)}</span>
              <input
                type="number"
                min="0"
                step="0.01"
                class="ppt-excl-input"
                bind:value={st.amount}
                on:focus={() => onSubRowFocus(m.id)}
                on:blur={() => onSubRowBlur(m.id)}
                placeholder="0.00"
                aria-label={`${m.display_name} 的独占金额`}
                data-testid={`ppts-amount-${m.id}`}
              />
            </label>
          </li>
        {/each}
      </ul>
    {/if}
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
    font-size: var(--font-size-base, 16px);
    -webkit-tap-highlight-color: transparent;
    transition: background-color 120ms ease;
  }
  .ppt-main:active {
    background: var(--gray-100, #f3f4f6);
  }
  .ppt-check-icon {
    font-size: 20px;
    line-height: 1;
    flex: 0 0 24px;
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
  .ppt-excl-badge {
    font-size: 13px;
    color: var(--gray-500, #6b7280);
    margin-left: var(--space-1, 4px);
    flex: 0 0 auto;
  }
  /* v0.2.3 T14r2 (PRD §3.9.2b): explicit text button instead of a
     bare chevron. The pill reuses .link-btn styling (same accent
     color, same hover), but bumps min-height to 44px so the tap
     target stays ≥ 44px. */
  .ppt-toggle {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: var(--touch-target, 44px);
    padding: 6px 10px;
    color: var(--gray-700, #374151);
    font-size: var(--font-size-sm, 13px);
    font-weight: 500;
    border-radius: var(--radius-md, 8px);
    -webkit-tap-highlight-color: transparent;
    transition: background-color 120ms ease, color 120ms ease;
  }
  .ppt-toggle[aria-expanded='true'] {
    color: var(--accent-700, #1d4ed8);
  }
  .ppt-toggle:active {
    background: var(--gray-100, #f3f4f6);
  }
  .ppt-toggle-label {
    line-height: 1;
  }
  .ppt-toggle-caret {
    font-size: 11px;
    line-height: 1;
    /* use a unicode glyph (▾ / ▴) — wider than `›`, no rotate needed */
  }
  .ppt-sub-row {
    flex-basis: 100%;
    display: flex;
    align-items: center;
    gap: var(--space-2, 8px);
    padding: 4px 12px 12px 36px;
    color: var(--gray-500, #6b7280);
    font-size: var(--font-size-sm, 13px);
  }
  .ppt-sub-label {
    white-space: nowrap;
  }
  .ppt-sub-input {
    max-width: 120px;
    padding: 6px 8px;
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    font-size: var(--font-size-base, 16px);
    font-variant-numeric: tabular-nums;
    background: var(--color-bg, #fff);
    color: var(--color-text, #111827);
    min-height: var(--touch-target, 44px);
  }
  @media (prefers-reduced-motion: reduce) {
    .ppt-toggle {
      transition-duration: 0ms;
    }
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
</style>
