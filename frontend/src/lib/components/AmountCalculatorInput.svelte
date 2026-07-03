<script lang="ts">
  /**
   * v0.2.1 T01 — AmountCalculatorInput (PRD §3.6.1 / SPEC §3.6.1).
   *
   * A read-only <input> paired with a custom 4-row mobile keypad that
   * lets the user type a linear arithmetic expression (e.g. ``350/5``).
   * The component evaluates the expression via the shared
   * ``$lib/api/calculator.ts`` helper on each onInput (debounced 100ms)
   * and emits both:
   *  - the raw expression via ``onChange``
   *  - the evaluated amount via ``onAmountChange``
   *
   * Whitelist: digits and basic arithmetic operators (PRD §3.6.1).
   * Parentheses are intentionally rejected
   * (MVP simplicity — PRD §3.6.1 "不含括号 MVP"). Invalid expressions
   * surface in red beneath the input; the parent form blocks submission.
   *
   * The input is read-only — the system keyboard is suppressed — and
   * the custom keypad below mirrors the iOS numeric pad layout but
   * with the missing ``*`` / ``/`` / ``=`` keys filled in. Touch target
   * ≥ 44px enforced by setting ``min-height: var(--touch-target)`` on
   * each button.
   */
  import { onMount, createEventDispatcher } from 'svelte';
  import { evaluateExpression } from '$api/calculator';

  /** Raw expression (e.g. "350/5"). Drives the read-only input. */
  export let value: string = '';

  /** Latest successfully-evaluated amount, or null if invalid. */
  export let evaluated: number | null = null;

  /** Optional currency suffix (e.g. "CNY", "THB"). */
  export let currency: string = '';

  /** Disable the keypad (still shows preview if value valid). */
  export let disabled: boolean = false;

  const dispatch = createEventDispatcher<{
    change: string;       // raw expression
    amountChange: number | null;  // evaluated or null
  }>();

  /** Debounce timer for evaluating on each input change. */
  let debounceId: ReturnType<typeof setTimeout> | null = null;

  /**
   * Push the current value back to the parent. Called by the parent
   * component when a button is pressed (more reliable than relying on
   * a synthetic input event).
   */
  function commit(rawExpr: string) {
    value = rawExpr;
    dispatch('change', rawExpr);
    if (debounceId) clearTimeout(debounceId);
    debounceId = setTimeout(() => {
      const trimmed = rawExpr.trim();
      if (trimmed === '') {
        evaluated = null;
        dispatch('amountChange', null);
        return;
      }
      const result = evaluateExpression(trimmed);
      evaluated = result;
      dispatch('amountChange', result);
    }, 100);
  }

  /** Append a character; called by every keypad button. */
  function pressChar(ch: string) {
    if (disabled) return;
    commit(value + ch);
  }

  /** Backspace the trailing character (or no-op if empty). */
  function pressBackspace() {
    if (disabled) return;
    commit(value.slice(0, -1));
  }

  /** Clear the entire expression. */
  function pressClear() {
    if (disabled) return;
    commit('');
  }

  /**
   * Pressing ``=`` immediately re-runs the evaluator and surfaces the
   * total; the user can keep editing afterwards (the field is not
   * frozen). It's a UX convenience rather than a hard commit.
   */
  function pressEquals() {
    if (disabled) return;
    if (debounceId) clearTimeout(debounceId);
    const trimmed = value.trim();
    if (trimmed === '') return;
    const result = evaluateExpression(trimmed);
    evaluated = result;
    dispatch('amountChange', result);
  }

  /** Insert the parsed number back into the field (used after ``=`` to chain). */
  function pressValue() {
    if (evaluated === null) return;
    const asExpr = Number(evaluated).toString();
    commit(asExpr);
  }

  /** On-mount: initial evaluation if a value was passed in (edit mode). */
  onMount(() => {
    if (value.trim()) {
      const result = evaluateExpression(value.trim());
      evaluated = result;
      dispatch('amountChange', result);
    }
  });

  /** Display string for the preview. Empty when invalid / empty. */
  $: previewText = evaluated !== null
    ? `= ${evaluated.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : (value.trim() === '' ? '' : '= 表达式错误');

  $: previewIsError = value.trim() !== '' && evaluated === null;
</script>

<div class="amount-calc" class:disabled>
  <div class="amount-row">
    <input
      class="amount-input"
      type="text"
      inputmode="none"
      readonly
      value={value}
      aria-label="金额表达式"
      placeholder="0"
      data-testid="amount-calc-input"
    />
    <span class="preview" class:error={previewIsError} data-testid="amount-calc-preview">
      {previewText}{previewText && currency ? ` ${currency}` : ''}
    </span>
  </div>

  <!-- 4-row keypad. Row 1 = 1-2-3 / Row 2 = 4-5-6 / Row 3 = 7-8-9
       Row 4 = clear-0-dot / Row 5 = + - / * / Row 6 = = backspace
       Designed for thumb reach: operator cluster on the right column. -->
  <div class="keypad" aria-label="计算器键盘">
    <!-- Row 1 -->
    <button type="button" class="key num" on:click={() => pressChar('1')} disabled={disabled} aria-label="1">1</button>
    <button type="button" class="key num" on:click={() => pressChar('2')} disabled={disabled} aria-label="2">2</button>
    <button type="button" class="key num" on:click={() => pressChar('3')} disabled={disabled} aria-label="3">3</button>
    <button type="button" class="key op" on:click={() => pressChar('+')} disabled={disabled} aria-label="加">+</button>

    <!-- Row 2 -->
    <button type="button" class="key num" on:click={() => pressChar('4')} disabled={disabled} aria-label="4">4</button>
    <button type="button" class="key num" on:click={() => pressChar('5')} disabled={disabled} aria-label="5">5</button>
    <button type="button" class="key num" on:click={() => pressChar('6')} disabled={disabled} aria-label="6">6</button>
    <button type="button" class="key op" on:click={() => pressChar('-')} disabled={disabled} aria-label="减">&minus;</button>

    <!-- Row 3 -->
    <button type="button" class="key num" on:click={() => pressChar('7')} disabled={disabled} aria-label="7">7</button>
    <button type="button" class="key num" on:click={() => pressChar('8')} disabled={disabled} aria-label="8">8</button>
    <button type="button" class="key num" on:click={() => pressChar('9')} disabled={disabled} aria-label="9">9</button>
    <button type="button" class="key op" on:click={() => pressChar('*')} disabled={disabled} aria-label="乘">×</button>

    <!-- Row 4 -->
    <button type="button" class="key ctrl" on:click={pressClear} disabled={disabled} aria-label="清空">C</button>
    <button type="button" class="key num" on:click={() => pressChar('0')} disabled={disabled} aria-label="0">0</button>
    <button type="button" class="key num" on:click={() => pressChar('.')} disabled={disabled} aria-label="小数点">.</button>
    <button type="button" class="key op" on:click={() => pressChar('/')} disabled={disabled} aria-label="除">÷</button>

    <!-- Row 5: equals + backspace -->
    <button
      type="button"
      class="key eq"
      on:click={pressEquals}
      disabled={disabled}
      aria-label="计算结果"
    >=</button>
    <button type="button" class="key ctrl bs" on:click={pressBackspace} disabled={disabled} aria-label="退格">⌫</button>
  </div>
</div>

<style>
  .amount-calc {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .amount-calc.disabled {
    opacity: 0.55;
    pointer-events: none;
  }
  .amount-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .amount-input {
    flex: 1;
    /* Keep ≥ 44px touch target readability via font-size, not by enlarging
       the input itself (single line field). */
    font-size: var(--font-size-base, 16px);
    font-variant-numeric: tabular-nums;
    padding: 10px 12px;
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    background: var(--color-bg, #fff);
    color: var(--color-text, #111827);
    /* readonly so the OS keyboard never pops up; we own the keypad. */
    pointer-events: none;
    user-select: none;
  }
  .preview {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
    color: var(--gray-500, #6b7280);
    font-size: var(--font-size-sm, 13px);
    white-space: nowrap;
    min-width: 8ch;
    text-align: right;
  }
  .preview.error {
    color: var(--error-500, #ef4444);
  }

  .keypad {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--space-2);
  }
  .key {
    /* ≥ 44px touch target per iOS HIG / MD3. */
    min-height: var(--touch-target, 44px);
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    background: var(--color-bg, #fff);
    color: var(--color-text, #111827);
    font-size: 1.125rem; /* 18px — large enough for thumb readability */
    font-weight: 500;
    cursor: pointer;
    transition: background-color 120ms ease, transform 80ms ease;
    /* No tap highlight since the button has its own feedback. */
    -webkit-tap-highlight-color: transparent;
  }
  .key:active {
    background: var(--gray-100, #f3f4f6);
    transform: scale(0.97);
  }
  .key.op {
    background: var(--accent-500, #3b82f6);
    color: #fff;
    border-color: var(--accent-500, #3b82f6);
  }
  .key.op:active {
    background: var(--accent-700, #1d4ed8);
  }
  .key.ctrl {
    background: var(--gray-100, #f3f4f6);
    color: var(--gray-700, #374151);
    font-size: var(--font-size-base, 16px);
  }
  .key.eq {
    background: var(--gray-700, #374151);
    color: #fff;
    border-color: var(--gray-700, #374151);
    grid-column: span 3;
  }
  .key.eq:active {
    background: var(--gray-900, #111827);
  }
  .key.bs {
    background: var(--gray-100, #f3f4f6);
  }

  /* Compact on smaller phones (≤ 360px): tighten gap. */
  @media (max-width: 360px) {
    .keypad { gap: 6px; }
    .key { font-size: 1rem; min-height: 40px; }
  }
</style>
