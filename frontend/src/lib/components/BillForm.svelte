<script lang="ts">
  import { onMount } from 'svelte';
  import type { SessionDetail } from '$api/sessions';
  import type { Bill, ParseBillResult } from '$api/bills';
  import AiAssistInput from './AiAssistInput.svelte';

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

  $: isEdit = mode === 'edit';
  $: canEditDescription = !isEdit;

  let amount = '';
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

  // v0.1.2 (T19 + fix #3): apply the caller-supplied default payer once
  // the form mounts. In create mode we use defaultPayerMemberId; in edit
  // mode the existing bill's payer wins (if it's still a session member).
  onMount(() => {
    if (isEdit && existingBill) {
      // Prefill from existing bill.
      amount = String(existingBill.amount);
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
  });

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
      amount = String(res.amount);
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
    return {
      amount: Number(amount),
      payer_member_id: payerMemberId ?? 0,
      // In edit mode we deliberately send the existing description back
      // so the field is preserved if the backend decides to accept it,
      // but UpdateBillRequest rejects unknown fields (Pydantic
      // extra='forbid') -- which means the description never actually
      // reaches the wire. We still send it for symmetry / future
      // backends that relax the rule.
      description: description.trim() ? description.trim() : null,
      occurred_at: new Date(occurredAt).toISOString(),
      currency: currency || 'CNY',
      participants
    };
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    formError = null;
    const p = buildPayload();
    if (!Number.isFinite(p.amount) || p.amount <= 0) {
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
      <input id="amount" type="number" min="0" step="0.01" bind:value={amount} placeholder="0.00" />
    </div>
    <div style="flex: 1; min-width: 100px;">
      <label class="label" for="currency">币种</label>
      <input id="currency" type="text" bind:value={currency} maxlength="8" />
    </div>
  </div>

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
