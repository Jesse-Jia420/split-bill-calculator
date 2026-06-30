<script lang="ts">
  import type { SessionDetail } from '$api/sessions';
  import type { ParseBillResult } from '$api/bills';
  import AiAssistInput from './AiAssistInput.svelte';

  export let session: SessionDetail;
  /** Called with a ready-to-POST payload. */
  export let onSubmit: ((payload: {
    amount: number;
    payer_member_id: number;
    description: string | null;
    occurred_at: string;
    currency: string;
    participants: Array<{ member_id: number; is_exclusive: boolean; exclusive_amount: number }>;
  }) => Promise<void> | void) | null = null;

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
    <input id="desc" type="text" bind:value={description} placeholder="例: 晚餐" maxlength="500" />
  </div>

  <div>
    <label class="label" for="occurredAt">发生时间</label>
    <input id="occurredAt" type="datetime-local" bind:value={occurredAt} />
  </div>

  <div>
    <div class="row between">
      <span class="label">参与者</span>
      <button type="button" class="ghost btn-sm" on:click={() => (showAi = !showAi)}>
        {showAi ? '收起 AI 辅助' : 'AI 辅助'}
      </button>
    </div>
    {#if showAi}
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
      {submitting ? '保存中…' : '保存账单'}
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
</style>