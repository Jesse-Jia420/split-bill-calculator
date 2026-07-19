<!--
  CurrencyAddModal.svelte — v0.3.18 #53 (PO msg 10:49 #6542)

  Owner-only "add secondary currency" flow. Triggered when an owner clicks
  the SessionCurrencyBadge single-pill (which renders as a + button on the
  primary chip). Opens a glass-style modal with:

    * Section 1 — Primary currency (locked, shown for context only).
    * Section 2 — Secondary currency <select>, options = SUPPORTED_CURRENCIES
      minus the primary + any currencies already on the session.
    * Section 3 — Forward rate input (1 primary = X secondary), decimal.
    * Footer — Cancel + Add buttons (Add disabled until secondary + rate > 0).

  Submit flow:
    1. POST /sessions/{id}/currencies {currency: secondary} → 200 + updated
       SessionDetail (extend currencies set; primary unchanged).
    2. POST /sessions/{id}/exchange-rates {from, to, rate} → 201 + forward
       + reciprocal rate rows (handled by exchange_rates.py auto-pair).
    3. onAdded() callback → parent reloads session → SessionCurrencyBadge
       re-renders as the dual-currency bar (the modal disappears first).

  Failure handling:
    * 409 currency_already_in_session → toast + close (state is already
      consistent, no point retrying).
    * 422 max_2_currencies_per_session → toast (should not happen since
      the single-pill gate prevents opening this modal in dual-currency
      sessions, but defensive).
    * 422 rate out of range → toast + keep modal open.
    * Generic network error → toast + keep modal open so user can retry.

  Style: glass-card-soft + .glass-input (existing global utilities from
  app.css). z-index above the page content (999) but below no other UI
  layer (no overlapping modals in v0.3.18 scope).
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { toast } from '$stores/toast';
  import { ApiError } from '$api/client';
  import { addSessionCurrency, type SessionDetail } from '$api/sessions';
  import type { SessionExchangeRate } from '$api/sessions';

  /** SUPPORTED_CURRENCIES — keep in sync with backend/app/api/sessions.py.
   *  Inline here rather than import to avoid creating a new shared module
   *  just for one constant (PRD §3.7.5 hard codes the same 10 ISO codes
   *  on both sides; FE uses it to render the <select> options). */
  const SUPPORTED_CURRENCIES: readonly string[] = [
    'CNY',
    'USD',
    'THB',
    'EUR',
    'JPY',
    'GBP',
    'HKD',
    'SGD',
    'KRW',
    'AUD',
  ] as const;

  export let primary_currency: string;
  export let session_id: number;
  /** Already-tracked currencies (excluding the primary). Used to filter
   *  the <select> options — the user shouldn't pick a currency that's
   *  already on the session. */
  export let existing_currencies: string[] = [];

  /** v0.3.18 #53: callback when the user successfully adds a currency +
   *  rate pair. Parent typically does `window.location.reload()` or
   *  refetches the session to re-render the badge as a dual-bar. */
  export let onAdded: ((detail: {
    session: SessionDetail;
    rates: SessionExchangeRate[];
  }) => void) | undefined = undefined;

  const dispatch = createEventDispatcher<{ close: void }>();

  /** Secondary currency selection (locked until user picks one). */
  let secondary = '';
  /** Forward rate input: "1 primary = X secondary". Decimal-as-string so
   *  we don't lose precision via JS Number round-trip (BE serialises
   *  Decimal as string per v0.2.2 wire format). */
  let rate = '';
  let busy = false;

  /** §1 — selectable currencies = SUPPORTED minus primary minus existing. */
  $: options = SUPPORTED_CURRENCIES.filter(
    (c) => c !== primary_currency && !existing_currencies.includes(c)
  );

  $: rateNumber = rate.trim() === '' ? NaN : Number(rate.trim());
  $: rateValid = Number.isFinite(rateNumber) && rateNumber > 0;
  $: canSubmit = secondary !== '' && rateValid && !busy;

  function close() {
    if (busy) return;
    dispatch('close');
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && !busy) close();
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    busy = true;
    try {
      // Step 1 — extend the session's currencies set with the new
      // secondary currency (primary is preserved).
      const updated = await addSessionCurrency(session_id, {
        currency: secondary,
      });
      // Step 2 — create the exchange rate row (forward + reciprocal auto-paired
      // by exchange_rates.py).
      const rateResp = await fetch('/api/sessions/' + session_id + '/exchange-rates', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_currency: primary_currency,
          to_currency: secondary,
          rate: rate.trim(),
        }),
      });
      if (!rateResp.ok) {
        let detail: any = {};
        try { detail = await rateResp.json(); } catch { /* ignore */ }
        const msg = detail?.detail?.error ?? `汇率创建失败 (HTTP ${rateResp.status})`;
        throw new ApiError(rateResp.status, msg, detail);
      }
      const rates: SessionExchangeRate[] = await rateResp.json();
      toast.success(`已添加 ${secondary}, 汇率 ${rate} ${secondary}/${primary_currency}`);
      onAdded?.({ session: updated, rates });
      dispatch('close');
    } catch (e: any) {
      let msg = e?.message ?? '添加副币种失败';
      if (e instanceof ApiError && e?.detail?.detail?.error) {
        msg = e.detail.detail.error;
      } else if (e?.detail?.error) {
        msg = e.detail.error;
      }
      // 409 currency_already_in_session → close modal, state is already
      // consistent (the parent will reload and the badge will reflect
      // the dual state). Other errors keep the modal open for retry.
      if (e?.status === 409 || e?.detail?.detail?.error === 'currency_already_in_session') {
        toast.info('该币种已在账本中');
        dispatch('close');
      } else {
        toast.error(msg);
      }
    } finally {
      busy = false;
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<div
  class="modal-backdrop"
  on:click={handleBackdropClick}
  on:keydown={handleKeydown}
  role="presentation"
>
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-label="添加副币种"
    data-sbc="currency-add-modal"
  >
    <header class="modal-head">
      <h3 class="modal-title">添加副币种</h3>
      <button
        type="button"
        class="modal-close"
        on:click={close}
        disabled={busy}
        aria-label="关闭"
      >
        ×
      </button>
    </header>

    <div class="modal-body">
      <!-- Section 1 — primary (locked chip) -->
      <section class="field">
        <label class="field-label">主币种 (不可改)</label>
        <div class="primary-chip" aria-label="主币种: {primary_currency}">
          <span class="lock-icon" aria-hidden="true">🔒</span>
          <span class="primary-code">{primary_currency}</span>
        </div>
      </section>

      <!-- Section 2 — secondary selector -->
      <section class="field">
        <label class="field-label" for="sbc-secondary-currency">副币种</label>
        <select
          id="sbc-secondary-currency"
          class="glass-input currency-select"
          bind:value={secondary}
          disabled={busy}
          data-testid="currency-add-secondary"
        >
          <option value="" disabled>选择币种…</option>
          {#each options as opt}
            <option value={opt}>{opt}</option>
          {/each}
        </select>
        {#if options.length === 0}
          <p class="hint">没有可选的副币种了 (10 个币种全在账本中)。</p>
        {/if}
      </section>

      <!-- Section 3 — forward rate -->
      <section class="field">
        <label class="field-label" for="sbc-secondary-rate">汇率</label>
        <div class="rate-row">
          <span class="rate-prefix">1 {primary_currency} =</span>
          <input
            id="sbc-secondary-rate"
            type="text"
            inputmode="decimal"
            class="glass-input rate-input"
            bind:value={rate}
            disabled={busy || secondary === ''}
            placeholder="0.00"
            aria-label="汇率 (1 {primary_currency} = X {secondary})"
            data-testid="currency-add-rate"
          />
          <span class="rate-suffix">{secondary || '副币种'}/{primary_currency}</span>
        </div>
        <p class="hint">
          提交后会创建正向 + 反向两条汇率记录, 修改时两方向同步。
        </p>
      </section>
    </div>

    <footer class="modal-foot">
      <button
        type="button"
        class="btn btn-ghost"
        on:click={close}
        disabled={busy}
      >
        取消
      </button>
      <button
        type="button"
        class="btn btn-primary"
        on:click={handleSubmit}
        disabled={!canSubmit}
        data-testid="currency-add-submit"
      >
        {busy ? '添加中…' : '添加'}
      </button>
    </footer>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    /* v0.3.18 #60 batch2 (PO #6837): 遮罩层更暗 + 模糊度加重, 让 modal 内容更突出. */
    background: rgba(15, 23, 42, 0.55);
    backdrop-filter: saturate(180%) blur(16px);
    -webkit-backdrop-filter: saturate(180%) blur(16px);
    z-index: 999;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-4);
    animation: fadeIn 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  /* Self-contained glass surface: the modal does not rely on the
   * .glass-card-soft global utility (not yet defined — only mentioned
   * aspirationally in app.css). Inline here so the modal can drop into
   * any page without touching app.css. Style matches the .glass-pill /
   * .glass-input language: semi-transparent white + saturate(180%) blur(12px)
   * + indigo border + soft inset highlight. */
  .modal {
    width: 100%;
    max-width: 360px;
    max-height: calc(100dvh - 32px);
    overflow-y: auto;
    border-radius: 16px;
    padding: 0;
    display: flex;
    flex-direction: column;
    background: rgba(255, 255, 255, 0.55);
    /* v0.3.18 #60 batch2 (PO #6837): modal 内部玻璃模糊度加重, 跟遮罩层呼应. */
    backdrop-filter: saturate(200%) blur(20px);
    -webkit-backdrop-filter: saturate(200%) blur(20px);
    border: 1px solid rgba(99, 102, 241, 0.22);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.5),
      inset 0 -1px 0 rgba(0, 0, 0, 0.03),
      0 8px 24px rgba(99, 102, 241, 0.12);
    animation: slideUp 200ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  @supports not (backdrop-filter: blur(1px)) {
    .modal {
      background: rgba(255, 255, 255, 0.92);
    }
  }

  .modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-4) 0;
  }
  .modal-title {
    margin: 0;
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-semibold);
    color: var(--gray-900);
  }
  .modal-close {
    appearance: none;
    background: transparent;
    border: 0;
    font-size: 24px;
    line-height: 1;
    color: var(--gray-500);
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;
    transition: color 150ms ease, background 150ms ease;
  }
  .modal-close:hover:not(:disabled) {
    color: var(--gray-800);
    background: rgba(0, 0, 0, 0.04);
  }

  .modal-body {
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .field-label {
    font-size: var(--font-size-sm);
    color: var(--gray-700);
    font-weight: var(--font-weight-medium);
  }

  .primary-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    align-self: flex-start;
    padding: 6px 12px;
    background: rgba(255, 255, 255, 0.45);
    border: 1px solid rgba(99, 102, 241, 0.18);
    border-radius: 999px;
    font-size: var(--font-size-sm);
    color: var(--gray-600);
    cursor: not-allowed;
  }
  .lock-icon {
    font-size: 12px;
    line-height: 1;
  }
  .primary-code {
    font-weight: var(--font-weight-semibold);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
  }

  /* Use .glass-input global utility (semitransparent + blur). The
   * modal uses its own glass surface (defined inline below), so the input
   * background contrast stays subtle. */
  .currency-select {
    /* Keep native select arrow visible on iOS Safari (where dropdown
     * overlay is OS-rendered). */
    appearance: auto;
    -webkit-appearance: menulist;
  }
  .rate-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .rate-prefix {
    font-size: var(--font-size-sm);
    color: var(--gray-700);
    font-weight: var(--font-weight-medium);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .rate-input {
    flex: 1 1 auto;
    min-width: 5em;
    max-width: 8em;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .rate-suffix {
    font-size: var(--font-size-sm);
    color: var(--gray-600);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .modal-foot {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: 0 var(--space-4) var(--space-4);
  }

  .btn-ghost {
    background: transparent;
    border-color: transparent;
    color: var(--gray-700);
  }
  .btn-ghost:hover:not(:disabled) {
    border-color: var(--gray-200);
    color: var(--gray-900);
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes slideUp {
    from { opacity: 0; transform: translateY(8px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
</style>