<script lang="ts">
  /**
   * AmountCalculatorInput bottom sheet (PRD §3.9.1b).
   *
   * `=` evaluates and wraps the current display in parentheses so the user
   * can continue chaining. Second / third / … presses nest another layer:
   *   60-10=        → (60-10)
   *   /5=           → ((60-10)/5)
   *   +2=           → (((60-10)/5)+2)
   *
   * Long expressions wrap inside a fixed-height amount row (font shrinks);
   * expression top-left → wraps downward; result bottom-right; confirm unchanged.
   */
  import { onMount, createEventDispatcher, tick } from 'svelte';
  import { evaluateExpression } from '$api/calculator';
  import { portal } from '$lib/actions/portal';

  export let value: string = '';
  export let evaluated: number | null = null;
  export let amount: number | null = null;
  export let initialValue: string = '';
  export let initialAmount: number | null = null;
  export let currency: string = '';
  export let disabled: boolean = false;
  export let error: boolean = false;

  const dispatch = createEventDispatcher<{
    change: string;
    amountChange: number | null;
    confirm: { value: number; expression: string };
  }>();

  let _internalValue: string = '';
  /** Nested parenthesized left side after one or more successful `=` presses. */
  let foldedDisplay: string | null = null;
  let showKeypad: boolean = false;
  let preEqualsResult: number | null = null;
  let prefillDone: boolean = false;
  let equalsError: boolean = false;

  const BINARY_OPS = new Set(['+', '-', '*', '/']);

  $: if (!prefillDone && initialValue) {
    hydrateFromExpression(initialValue);
    prefillDone = true;
    value = _internalValue;
  }

  onMount(() => {
    if (!prefillDone && value && !initialValue) {
      hydrateFromExpression(value);
      prefillDone = true;
    }
  });

  function hydrateFromExpression(raw: string) {
    _internalValue = raw;
    foldedDisplay = null;
    preEqualsResult = null;
    const eqIndex = raw.indexOf('=');
    if (eqIndex > 0) {
      const pre = raw.slice(0, eqIndex);
      const post = raw.slice(eqIndex + 1);
      const r = evaluateExpression(pre);
      if (r !== null) {
        foldedDisplay = `(${pre})`;
        preEqualsResult = r;
        _internalValue = post;
      }
    }
    const parsed = parseInput(_internalValue, preEqualsResult, foldedDisplay);
    if (parsed.currentValue !== null) {
      evaluated = parsed.currentValue;
    }
  }

  function isIncompleteExpr(cleaned: string): boolean {
    if (!cleaned) return false;
    const last = cleaned[cleaned.length - 1];
    if (BINARY_OPS.has(last)) return true;
    if (last === '.') return true;
    return false;
  }

  function parseInput(
    tail: string,
    preEq: number | null,
    folded: string | null
  ): { displayExpr: string; currentValue: number | null } {
    const cleanedTail = (tail || '').replace(/\s+/g, '');

    if (folded === null) {
      if (!cleanedTail) return { displayExpr: '', currentValue: null };
      if (isIncompleteExpr(cleanedTail)) {
        return { displayExpr: cleanedTail, currentValue: null };
      }
      const result = evaluateExpression(cleanedTail);
      return { displayExpr: cleanedTail, currentValue: result };
    }

    if (preEq === null) {
      return { displayExpr: folded + cleanedTail, currentValue: null };
    }

    if (!cleanedTail) {
      return { displayExpr: folded, currentValue: preEq };
    }

    if (isIncompleteExpr(cleanedTail)) {
      return { displayExpr: folded + cleanedTail, currentValue: null };
    }

    const displayExpr = folded + cleanedTail;
    const result = evaluateExpression(`${preEq}${cleanedTail}`);
    return { displayExpr, currentValue: result };
  }

  $: parsed = parseInput(_internalValue, preEqualsResult, foldedDisplay);
  $: displayExpr = parsed.displayExpr;
  $: currentValue = parsed.currentValue;
  $: isError = equalsError;
  $: showConfirm = !equalsError && currentValue !== null;
  $: exprLen = (displayExpr || '').length;
  // Fit more glyphs inside the fixed 56px row: shrink font, allow up to 3 lines.
  $: exprFontPx = exprLen > 48 ? 11 : exprLen > 32 ? 13 : exprLen > 18 ? 16 : 22;
  $: exprLineClamp = exprLen > 36 ? 3 : exprLen > 18 ? 2 : 1;
  $: sheetPreviewText = (() => {
    if (equalsError) return '表达式错误';
    if (currentValue === null) return '';
    const formatted = currentValue.toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    if (foldedDisplay !== null) {
      return `= ${formatted}`;
    }
    return `= ${formatted}${currency ? ' ' + currency : ''}`;
  })();
  $: formRowDisplay = (() => {
    if (amount !== null && Number.isFinite(amount)) {
      return amount.toLocaleString('zh-CN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }
    if (initialAmount !== null && Number.isFinite(initialAmount)) {
      return initialAmount.toLocaleString('zh-CN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }
    return '';
  })();

  function syncDerived() {
    const result = parseInput(_internalValue, preEqualsResult, foldedDisplay).currentValue;
    if (result !== null) {
      evaluated = result;
      dispatch('amountChange', result);
    } else {
      evaluated = null;
      dispatch('amountChange', null);
    }
  }

  function openKeypad() {
    if (disabled) return;
    showKeypad = true;
  }

  function closeKeypad() {
    showKeypad = false;
  }

  function pressChar(ch: string) {
    if (disabled) return;
    equalsError = false;
    _internalValue = _internalValue + ch;
    value = serializeExpression();
    dispatch('change', value);
    syncDerived();
  }

  function pressBackspace() {
    if (disabled) return;
    equalsError = false;
    if (_internalValue.length > 0) {
      _internalValue = _internalValue.slice(0, -1);
    } else if (foldedDisplay !== null) {
      // Undo one fold layer by peeling outer parentheses when possible.
      const inner = unwrapOnce(foldedDisplay);
      if (inner !== null && inner !== foldedDisplay) {
        const rebuilt = rebuildAfterUnwrap(inner);
        foldedDisplay = rebuilt.folded;
        preEqualsResult = rebuilt.preEq;
        _internalValue = rebuilt.tail;
      } else {
        foldedDisplay = null;
        preEqualsResult = null;
        _internalValue = '';
      }
    }
    value = serializeExpression();
    dispatch('change', value);
    syncDerived();
  }

  function unwrapOnce(folded: string): string | null {
    if (folded.length >= 2 && folded.startsWith('(') && folded.endsWith(')')) {
      return folded.slice(1, -1);
    }
    return null;
  }

  function rebuildAfterUnwrap(inner: string): {
    folded: string | null;
    preEq: number | null;
    tail: string;
  } {
    // inner may still be nested like "(60-10)/5" or "60-10"
    if (inner.startsWith('(')) {
      // Find matching close for the leading group, remainder is tail.
      let depth = 0;
      for (let i = 0; i < inner.length; i++) {
        if (inner[i] === '(') depth++;
        else if (inner[i] === ')') {
          depth--;
          if (depth === 0) {
            const left = inner.slice(0, i + 1);
            const tail = inner.slice(i + 1);
            const preEq = evaluateFoldedLeft(left);
            return { folded: left, preEq, tail };
          }
        }
      }
    }
    const preEq = evaluateExpression(inner.replace(/[()]/g, ''));
    // Flat expression — treat as draft (no fold) so user can edit freely.
    return { folded: null, preEq: null, tail: inner.replace(/[()]/g, '') };
  }

  function evaluateFoldedLeft(left: string): number | null {
    // left is like "(60-10)" or "((60-10)/5)" — strip one outer wrap and eval via nesting.
    const unwrapped = unwrapOnce(left);
    if (unwrapped == null) return evaluateExpression(left);
    // Recursively: if unwrapped contains ops after a group, use preEq chaining.
    if (unwrapped.startsWith('(')) {
      let depth = 0;
      for (let i = 0; i < unwrapped.length; i++) {
        if (unwrapped[i] === '(') depth++;
        else if (unwrapped[i] === ')') {
          depth--;
          if (depth === 0) {
            const group = unwrapped.slice(0, i + 1);
            const tail = unwrapped.slice(i + 1);
            const base = evaluateFoldedLeft(group);
            if (base === null) return null;
            if (!tail) return base;
            return evaluateExpression(`${base}${tail}`);
          }
        }
      }
    }
    return evaluateExpression(unwrapped);
  }

  function pressClear() {
    if (disabled) return;
    equalsError = false;
    _internalValue = '';
    foldedDisplay = null;
    preEqualsResult = null;
    evaluated = null;
    value = '';
    dispatch('change', '');
    dispatch('amountChange', null);
  }

  function serializeExpression(): string {
    // BE calculator rejects parentheses; keep a flat chain with `=` markers
    // for single-fold continuity, or the bare number after multi-fold confirm.
    if (foldedDisplay === null) return _internalValue;
    if (!_internalValue) {
      // Prefer a reconstructible form from the innermost raw if simple.
      return `${preEqualsResult ?? ''}=`;
    }
    return `${preEqualsResult ?? ''}=${_internalValue}`;
  }

  function pressEquals() {
    if (disabled) return;
    const cleaned = _internalValue.replace(/\s+/g, '');
    const { displayExpr: disp, currentValue: val } = parseInput(
      _internalValue,
      preEqualsResult,
      foldedDisplay
    );
    if (val === null) {
      if (!disp) return; // nothing to evaluate
      if (isIncompleteExpr(cleaned)) return; // still typing
      equalsError = true;
      return;
    }
    equalsError = false;
    foldedDisplay = `(${disp})`;
    preEqualsResult = val;
    _internalValue = '';
    value = serializeExpression();
    dispatch('change', value);
    evaluated = val;
    dispatch('amountChange', val);
  }

  async function pressConfirm() {
    if (disabled) return;
    if (currentValue === null || equalsError) return;
    const confirmedValue = currentValue;
    // Parens are display-only; persist a BE-safe expression (final number when folded).
    const confirmedExpression =
      foldedDisplay !== null
        ? String(confirmedValue)
        : _internalValue
          ? _internalValue
          : String(confirmedValue);
    amount = confirmedValue;
    evaluated = confirmedValue;
    dispatch('amountChange', confirmedValue);
    dispatch('confirm', { value: confirmedValue, expression: confirmedExpression });
    showKeypad = false;
    await tick();
    _internalValue = '';
    foldedDisplay = null;
    preEqualsResult = null;
    equalsError = false;
    value = '';
  }
</script>

<div class="amount-calc" class:disabled class:open={showKeypad}>
  <div
    class="amount-row"
    role="button"
    tabindex={disabled ? -1 : 0}
    aria-label="金额, 点击打开计算器"
    aria-hidden={showKeypad ? 'true' : undefined}
    data-testid="amount-calc-row"
    onclick={openKeypad}
    onkeydown={(e) => {
      if (disabled) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openKeypad();
      }
    }}
  >
    <input
      class="amount-input"
      class:input-error={error}
      type="text"
      inputmode="none"
      readonly
      value={formRowDisplay}
      aria-label="金额"
      placeholder="0"
      data-testid="amount-calc-input"
    />
  </div>

  {#if showKeypad}
    <!-- Portal out of BillSheet (will-change/transform trap) so keypad sits above 取消/保存. -->
    <div use:portal data-testid="amount-calc-portal">
      <div
        class="sheet-backdrop"
        data-testid="amount-calc-backdrop"
        onclick={closeKeypad}
        aria-hidden="true"
      ></div>
      <div class="sheet" role="dialog" aria-label="计算器键盘" aria-modal="true">
        <div class="sheet-amount-row" data-testid="amount-calc-sheet-row">
          <div class="sheet-amount-main">
            <span
              class="sheet-amount-expr"
              style={`font-size: ${exprFontPx}px; -webkit-line-clamp: ${exprLineClamp};`}
              aria-label="当前金额表达式"
              data-testid="amount-calc-sheet-expr"
            >
              {displayExpr || '0'}
            </span>
            {#if isError}
              <span
                class="sheet-amount-error-pill"
                data-testid="amount-calc-error-pill"
                aria-label="表达式错误"
              >
                表达式错误
              </span>
            {:else if sheetPreviewText}
              <span
                class="sheet-amount-preview"
                data-testid="amount-calc-sheet-preview"
                aria-label="当前金额预览"
              >
                {sheetPreviewText}
              </span>
            {/if}
          </div>
          <button
            type="button"
            class="confirm-btn"
            class:disabled={!showConfirm}
            class:hidden={!showConfirm}
            onclick={pressConfirm}
            disabled={disabled || !showConfirm}
            aria-label="确认金额, 填入表单"
            data-testid="amount-calc-confirm"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M5 12.5L10 17.5L19 7" stroke="white" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
        <div class="keypad" aria-label="计算器键盘">
          <button type="button" class="key num" onclick={() => pressChar('1')} disabled={disabled} aria-label="1">1</button>
          <button type="button" class="key num" onclick={() => pressChar('2')} disabled={disabled} aria-label="2">2</button>
          <button type="button" class="key num" onclick={() => pressChar('3')} disabled={disabled} aria-label="3">3</button>
          <button type="button" class="key op" onclick={() => pressChar('+')} disabled={disabled} aria-label="加">+</button>
          <button type="button" class="key num" onclick={() => pressChar('4')} disabled={disabled} aria-label="4">4</button>
          <button type="button" class="key num" onclick={() => pressChar('5')} disabled={disabled} aria-label="5">5</button>
          <button type="button" class="key num" onclick={() => pressChar('6')} disabled={disabled} aria-label="6">6</button>
          <button type="button" class="key op" onclick={() => pressChar('-')} disabled={disabled} aria-label="减">&minus;</button>

          <button type="button" class="key num" onclick={() => pressChar('7')} disabled={disabled} aria-label="7">7</button>
          <button type="button" class="key num" onclick={() => pressChar('8')} disabled={disabled} aria-label="8">8</button>
          <button type="button" class="key num" onclick={() => pressChar('9')} disabled={disabled} aria-label="9">9</button>
          <button type="button" class="key op" onclick={() => pressChar('*')} disabled={disabled} aria-label="乘">×</button>

          <button type="button" class="key ctrl" onclick={pressClear} disabled={disabled} aria-label="清空">C</button>
          <button type="button" class="key num" onclick={() => pressChar('0')} disabled={disabled} aria-label="0">0</button>
          <button type="button" class="key num" onclick={() => pressChar('.')} disabled={disabled} aria-label="小数点">.</button>
          <button type="button" class="key op" onclick={() => pressChar('/')} disabled={disabled} aria-label="除">÷</button>

          <button
            type="button"
            class="key eq"
            onclick={pressEquals}
            disabled={disabled}
            aria-label="等于, 计算结果并加括号"
            data-testid="amount-calc-eq"
          >=</button>
          <button type="button" class="key ctrl bs" onclick={pressBackspace} disabled={disabled} aria-label="退格">⌫</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .amount-calc {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    width: 100%;
  }
  .amount-calc.disabled {
    opacity: 0.55;
    pointer-events: none;
  }

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
    position: relative;
  }
  .amount-row:focus-visible {
    outline: 2px solid var(--accent-500, #2c2c2c);
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
    min-height: var(--touch-target, 44px);
    -webkit-user-select: none;
    user-select: none;
  }
  .amount-input.input-error {
    border-color: rgba(244, 63, 94, 0.55);
    background: linear-gradient(rgba(255, 228, 230, 0.55), rgba(254, 205, 211, 0.55));
    box-shadow: 0 0 0 3px rgba(244, 63, 94, 0.5), 0 0 24px rgba(244, 63, 94, 0.4);
  }

  .sheet-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.08);
    /* Above BillSheet (1100/1101) so keypad stays clickable inside 新建账单. */
    z-index: 1200;
    animation: backdropFadeIn 200ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 1201;
    width: 100%;
    max-width: var(--sbc-sheet-max-w, 480px);
    margin: 0 auto;
    background: var(--sbc-sheet-bg, #fff);
    border-radius: var(--sbc-sheet-radius, 20px) var(--sbc-sheet-radius, 20px) 0 0;
    border-top: 1px solid var(--color-border, #e5e7eb);
    box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.06);
    padding: 12px 12px var(--sbc-sheet-pad-bottom, calc(12px + env(safe-area-inset-bottom, 0px)));
    display: flex;
    flex-direction: column;
    gap: 12px;
    animation: sheetSlideUp 200ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .sheet-amount-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 64px;
    padding: 10px 8px 10px 12px;
    background: rgba(255, 255, 255, 0.92);
    backdrop-filter: blur(12px) saturate(180%);
    -webkit-backdrop-filter: blur(12px) saturate(180%);
    border-radius: 16px;
    border: 1px solid rgba(40, 40, 40, 0.18);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.75),
      inset 0 -1px 0 rgba(15, 23, 42, 0.03);
    overflow: visible;
  }
  .sheet-amount-main {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 4px;
    overflow: visible;
  }
  .sheet-amount-expr {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    font-weight: 600;
    color: var(--color-text, #111827);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
    overflow: hidden;
    text-align: left;
    line-height: 1.15;
    white-space: normal;
    overflow-wrap: anywhere;
    word-break: break-all;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    align-self: stretch;
  }
  .sheet-amount-preview {
    flex: 0 0 auto;
    align-self: flex-end;
    font-size: 13px;
    color: var(--gray-500, #6b7280);
    font-variant-numeric: tabular-nums;
    font-weight: 500;
    white-space: nowrap;
    padding: 2px 8px;
    background: rgba(241, 245, 249, 0.7);
    border-radius: 999px;
    border: 1px solid rgba(148, 163, 184, 0.18);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sheet-amount-error-pill {
    flex: 0 0 auto;
    align-self: flex-end;
    font-size: 12px;
    color: #b91c1c;
    font-weight: 600;
    white-space: nowrap;
    padding: 3px 10px;
    background: rgba(239, 68, 68, 0.16);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border-radius: 999px;
    border: 1px solid rgba(239, 68, 68, 0.48);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.55),
      0 2px 8px rgba(239, 68, 68, 0.16);
  }
  .confirm-btn {
    flex: 0 0 44px;
    width: 44px;
    height: 44px;
    min-width: 44px;
    border-radius: 50%;
    background: linear-gradient(135deg, #2c2c2c 0%, #262626 100%);
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    border: 1px solid rgba(255, 255, 255, 0.22);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.42),
      inset 0 -1px 0 rgba(26, 26, 26, 0.18),
      0 4px 14px rgba(40, 40, 40, 0.38),
      0 1px 3px rgba(40, 40, 40, 0.22);
    transition: transform 80ms ease, box-shadow 120ms ease;
    -webkit-tap-highlight-color: transparent;
  }
  .confirm-btn:active:not(:disabled) {
    transform: scale(0.95);
  }
  .confirm-btn:focus-visible {
    outline: 2px solid var(--accent-500, #2c2c2c);
    outline-offset: 2px;
  }
  .confirm-btn.hidden {
    display: none;
  }
  .confirm-btn.disabled,
  .confirm-btn:disabled {
    background: rgba(148, 163, 184, 0.4);
    border-color: rgba(148, 163, 184, 0.3);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.4),
      0 2px 8px rgba(15, 23, 42, 0.08);
    cursor: not-allowed;
  }
  .confirm-btn.disabled:active {
    transform: none;
  }

  .keypad {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--space-2, 8px);
  }
  .key {
    min-height: var(--touch-target, 44px);
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    background: var(--color-bg, #fff);
    color: var(--color-text, #111827);
    font-size: 1.125rem;
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
    background: var(--accent-500, #2c2c2c);
    color: #fff;
    border-color: var(--accent-500, #2c2c2c);
  }
  .key.op:active {
    background: var(--accent-700, #1a1a1a);
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

  @media (prefers-reduced-motion: reduce) {
    .sheet,
    .sheet-backdrop {
      animation-duration: 0ms;
    }
  }

  @media (max-width: 360px) {
    .keypad { gap: 6px; }
    .key { font-size: 1rem; min-height: 40px; }
  }
</style>
