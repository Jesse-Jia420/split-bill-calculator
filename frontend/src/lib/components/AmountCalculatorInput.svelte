<script lang="ts">
  /**
   * v0.2.3 T13 — AmountCalculatorInput bottom sheet (PRD §3.9.1).
   *
   * The amount row is now a single read-only input (with a muted preview
   * suffix). Tapping the row slides a full-width bottom sheet up over
   * the page with the custom 4×5 keypad. The sheet can be dismissed
   * by tapping the backdrop or the "完成" button.
   *
   * Behavior contract (unchanged from v0.2.1 T01):
   *  - props: `value`, `evaluated`, `currency?`, `disabled?`
   *  - events: `change` (raw expression) + `amountChange` (evaluated | null)
   *  - debounce 100ms preview evaluation
   *  - child helpers `commit` / `pressChar` / `pressBackspace` /
   *    `pressClear` / `pressEquals` preserved verbatim — only the
   *    visual wrapping changes.
   *
   * Visual contract:
   *  - Row is `min-height: 44px` (tappable on mobile).
   *  - Sheet: fixed bottom, 4-col × 5-row keypad grid (1-2-3+/4-5-6−/7-8-9×/C-0-.-÷/= (3-col) + ⌫ (1-col)).
   *  - Animation: 200ms `transform: translateY(100%) ↔ translateY(0)` with `cubic-bezier(0.16, 1, 0.3, 1)`.
   *  - Backdrop: `rgba(0,0,0,0.25)` + `backdrop-filter: blur(2px)`, click to close.
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

  /** v0.2.3 T13: bottom-sheet visibility state. */
  let showKeypad: boolean = false;

  function openKeypad() {
    if (disabled) return;
    showKeypad = true;
  }

  function closeKeypad() {
    showKeypad = false;
  }

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

<div class="amount-calc" class:disabled class:open={showKeypad}>
  <!-- v0.2.3 T13: persistent amount row. Click anywhere on the row to open the keypad. -->
  <div
    class="amount-row"
    role="button"
    tabindex={disabled ? -1 : 0}
    aria-label="金额表达式, 点击打开键盘"
    data-testid="amount-calc-row"
    on:click={openKeypad}
    on:keydown={(e) => {
      if (disabled) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openKeypad();
      }
    }}
  >
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

  <!-- v0.2.3 T13: bottom sheet with custom keypad. Mounted only when open. -->
  {#if showKeypad}
    <div
      class="sheet-backdrop"
      data-testid="amount-calc-backdrop"
      on:click={closeKeypad}
      aria-hidden="true"
    ></div>
    <div class="sheet" role="dialog" aria-label="计算器键盘" aria-modal="true">
      <div class="sheet-header">
        <span class="sheet-title muted">输入金额表达式</span>
        <button
          type="button"
          class="sheet-done"
          on:click={closeKeypad}
          aria-label="完成, 收起键盘"
          data-testid="amount-calc-done"
        >完成</button>
      </div>
      <!-- 4×5 keypad. Row 1 = 1-2-3 / Row 2 = 4-5-6 / Row 3 = 7-8-9
           Row 4 = clear-0-dot / Row 5 = = (3-col) + backspace (1-col).
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

        <!-- Row 5: equals (3-col) + backspace (1-col) -->
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
  {/if}
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

  /* v0.2.3 T13: row is the persistent tap target (44px min-height).
     Previously the keypad lived inline below the row. */
  .amount-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--touch-target, 44px);
    cursor: pointer;
    padding: 0;
    border-radius: var(--radius-md, 8px);
    transition: background-color 120ms ease;
    -webkit-tap-highlight-color: transparent;
  }
  .amount-row:focus-visible {
    outline: 2px solid var(--accent-500, #3b82f6);
    outline-offset: 2px;
  }
  .amount-row:active {
    background: var(--gray-100, #f3f4f6);
  }

  .amount-input {
    flex: 1;
    font-size: var(--font-size-base, 16px);
    font-variant-numeric: tabular-nums;
    padding: 10px 12px;
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    background: var(--color-bg, #fff);
    color: var(--color-text, #111827);
    /* readonly — we own input via the custom keypad; OS keyboard stays hidden. */
    min-height: var(--touch-target, 44px);
    -webkit-user-select: none;
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

  /* v0.2.3 T13: bottom sheet + backdrop */
  .sheet-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.25);
    backdrop-filter: blur(2px);
    -webkit-backdrop-filter: blur(2px);
    z-index: 99;
    animation: backdropFadeIn 200ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 100;
    background: var(--color-bg, #fff);
    border-top: 1px solid var(--color-border, #e5e7eb);
    box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.06);
    padding: 12px 12px calc(12px + env(safe-area-inset-bottom, 0px));
    display: flex;
    flex-direction: column;
    gap: 12px;
    animation: sheetSlideUp 200ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .sheet-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2, 8px);
    min-height: var(--touch-target, 44px);
  }
  .sheet-title {
    font-size: var(--font-size-sm, 13px);
  }
  .sheet-done {
    min-height: var(--touch-target, 44px);
    padding: 0 16px;
    border-radius: var(--radius-md, 8px);
    border: 1px solid var(--color-border, #e5e7eb);
    background: var(--accent-500, #3b82f6);
    color: #fff;
    font-size: var(--font-size-base, 16px);
    font-weight: 500;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .sheet-done:active {
    background: var(--accent-700, #1d4ed8);
  }

  .keypad {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--space-2, 8px);
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

  @keyframes backdropFadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes sheetSlideUp {
    from { transform: translateY(100%); }
    to { transform: translateY(0); }
  }

  /* Respect users who prefer reduced motion. */
  @media (prefers-reduced-motion: reduce) {
    .sheet,
    .sheet-backdrop {
      animation-duration: 0ms;
    }
  }

  /* Compact on smaller phones (≤ 360px): tighten gap. */
  @media (max-width: 360px) {
    .keypad { gap: 6px; }
    .key { font-size: 1rem; min-height: 40px; }
  }
</style>