<script lang="ts">
  /**
   * v0.2.3 T13r2 — AmountCalculatorInput bottom sheet (PRD §3.9.1b).
   *
   * v0.3.30 #8 (PO msg 18:30 UAT 0725-1 #8): 计算器功能优化
   * - `=` 改成"计算 + 加括号"功能. 旧: pressEquals() 直接 evaluate 关闭. 新: =
   *   把当前表达式 evaluate → 记住 preEqualsResult, 后续用户输入的 operator/number
   *   在 (preExpr)postExpr 形式下接续. 例子: 60-10=/5 显示成 (60-10)/5, 结果 10.
   * - 结果框 (sheet-amount-row) 加 confirm 圆形按钮 (紫色渐变 + 4 层 shadow), 点击
   *   → 关闭 keypad + emit('confirm', { value, expression }) 给 parent 填入.
   * - 错误态: evaluateExpression() 返 null → sheet-amount-row 内显示红色玻璃
   *   pill "表达式错误", confirm 按钮同步置灰.
   * - form-row (form 内的金额 input) 行为重设:
   *   * 显示 parent 提供的 amount (confirm 后的最终数字), 不显示 value (raw
   *     expression), 也不显示 preview (PO 字面 #3)
   *   * 接受 parent 的 initialValue + initialAmount (edit mode prefill)
   * - sheet 内的 preview 部分: 等号后只显示金额数字, 不显示币种 (PO 字面 #5)
   *
   * 实现注意 (Svelte 4): reactive 系统对内部 let 变量的赋值在某些情况下 (e.g.
   * 在 if/showKeypad 块中) 不会触发 display 更新. 解决: 把所有 derived state
   * (displayExpr, currentValue, isError) 用 function call 直接计算, 不用 $.
   * 这样 template 中调用函数, 每次 render 都重新计算, 不会缓存.
   */
  import { onMount, createEventDispatcher, tick } from 'svelte';
  import { evaluateExpression } from '$api/calculator';

  // Props
  export let value: string = '';
  export let evaluated: number | null = null;
  export let amount: number | null = null;
  export let initialValue: string = '';
  export let initialAmount: number | null = null;
  export let currency: string = '';
  export let disabled: boolean = false;

  const dispatch = createEventDispatcher<{
    change: string;
    amountChange: number | null;
    confirm: { value: number; expression: string };
  }>();

  // True internal state (not a prop, so Svelte reactivity is reliable)
  let _internalValue: string = '';
  let showKeypad: boolean = false;
  let preEqualsResult: number | null = null;
  let prefillDone: boolean = false;

  // Reactive prefill from initialValue
  $: if (!prefillDone && initialValue) {
    _internalValue = initialValue;
    const eqIndex = initialValue.indexOf('=');
    if (eqIndex > 0) {
      const pre = initialValue.slice(0, eqIndex);
      const r = evaluateExpression(pre);
      if (r !== null) preEqualsResult = r;
    }
    const result = evaluateExpression(_internalValue);
    if (result !== null) {
      evaluated = result;
    }
    prefillDone = true;
    value = _internalValue;
  }

  // On mount: backward-compat with bind:value
  onMount(() => {
    if (!prefillDone && value && !initialValue) {
      _internalValue = value;
      const result = evaluateExpression(value);
      if (result !== null) {
        evaluated = result;
      }
      prefillDone = true;
    }
  });

  // Parser - pure function
  function parseInput(input: string, preEq: number | null): {
    displayExpr: string;
    currentValue: number | null;
    isError: boolean;
  } {
    if (!input) return { displayExpr: '', currentValue: null, isError: false };
    const cleaned = input.replace(/\s+/g, '');
    if (!cleaned) return { displayExpr: '', currentValue: null, isError: false };

    const eqIndex = cleaned.indexOf('=');
    if (eqIndex === -1) {
      const result = evaluateExpression(cleaned);
      if (result === null) {
        return { displayExpr: cleaned, currentValue: null, isError: true };
      }
      return { displayExpr: cleaned, currentValue: result, isError: false };
    }

    const preEquals = cleaned.slice(0, eqIndex);
    const postEquals = cleaned.slice(eqIndex + 1);

    if (!preEquals || preEq === null) {
      return { displayExpr: '', currentValue: null, isError: true };
    }

    if (!postEquals) {
      return {
        displayExpr: `(${preEquals})`,
        currentValue: preEq,
        isError: false,
      };
    }

    const displayExpr = `(${preEquals})${postEquals}`;
    const exprToEval = `${preEq}${postEquals}`;
    const result = evaluateExpression(exprToEval);
    if (result === null) {
      return { displayExpr, currentValue: null, isError: true };
    }
    return { displayExpr, currentValue: result, isError: false };
  }

  // Reactive: derived from _internalValue + preEqualsResult
  $: parsed = parseInput(_internalValue, preEqualsResult);
  $: displayExpr = parsed.displayExpr;
  $: currentValue = parsed.currentValue;
  $: isError = parsed.isError;
  $: showConfirm = _internalValue.includes('=') && !isError && currentValue !== null;
  $: sheetPreviewText = (() => {
    if (isError) return '表达式错误';
    if (currentValue === null) return '';
    const formatted = currentValue.toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const hasEquals = _internalValue.includes('=');
    if (hasEquals) {
      return `= ${formatted}`;
    } else {
      return `= ${formatted}${currency ? ' ' + currency : ''}`;
    }
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

  function openKeypad() {
    if (disabled) return;
    showKeypad = true;
  }

  function closeKeypad() {
    showKeypad = false;
  }

  function pressChar(ch: string) {
    if (disabled) return;
    _internalValue = _internalValue + ch;
    value = _internalValue;
    dispatch('change', _internalValue);
    const result = parseInput(_internalValue, preEqualsResult).currentValue;
    if (result !== null) {
      evaluated = result;
      dispatch('amountChange', result);
    } else {
      evaluated = null;
      dispatch('amountChange', null);
    }
  }

  function pressBackspace() {
    if (disabled) return;
    if (_internalValue.endsWith('=')) {
      preEqualsResult = null;
    }
    _internalValue = _internalValue.slice(0, -1);
    value = _internalValue;
    dispatch('change', _internalValue);
    const result = parseInput(_internalValue, preEqualsResult).currentValue;
    if (result !== null) {
      evaluated = result;
      dispatch('amountChange', result);
    } else {
      evaluated = null;
      dispatch('amountChange', null);
    }
  }

  function pressClear() {
    if (disabled) return;
    _internalValue = '';
    preEqualsResult = null;
    evaluated = null;
    value = '';
    dispatch('change', '');
    dispatch('amountChange', null);
  }

  function pressEquals() {
    if (disabled) return;
    if (_internalValue === '' || _internalValue.includes('=')) return;
    const result = evaluateExpression(_internalValue);
    if (result === null) return;
    preEqualsResult = result;
    _internalValue = _internalValue + '=';
    value = _internalValue;
    dispatch('change', _internalValue);
    evaluated = result;
    dispatch('amountChange', result);
  }

  async function pressConfirm() {
    if (disabled) return;
    if (currentValue === null || isError) return;
    if (!_internalValue.includes('=')) return;
    const confirmedValue = currentValue;
    const confirmedExpression = _internalValue;
    amount = confirmedValue;
    evaluated = confirmedValue;
    dispatch('amountChange', confirmedValue);
    dispatch('confirm', { value: confirmedValue, expression: confirmedExpression });
    // Close keypad first
    showKeypad = false;
    // Wait for next tick to ensure DOM updates with hidden sheet,
    // then reset state so reopen starts fresh.
    await tick();
    _internalValue = '';
    preEqualsResult = null;
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
      value={formRowDisplay}
      aria-label="金额"
      placeholder="0"
      data-testid="amount-calc-input"
    />
  </div>

  {#if showKeypad}
    <div
      class="sheet-backdrop"
      data-testid="amount-calc-backdrop"
      on:click={closeKeypad}
      aria-hidden="true"
    ></div>
    <div class="sheet" role="dialog" aria-label="计算器键盘" aria-modal="true">
      <div class="sheet-amount-row" data-testid="amount-calc-sheet-row">
        <span class="sheet-amount-expr" aria-label="当前金额表达式" data-testid="amount-calc-sheet-expr">
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
        {:else}
          <span
            class="sheet-amount-preview"
            data-testid="amount-calc-sheet-preview"
            aria-label="当前金额预览"
          >
            {sheetPreviewText}
          </span>
        {/if}
        <button
          type="button"
          class="confirm-btn"
          class:disabled={!showConfirm}
          class:hidden={!_internalValue.includes('=')}
          on:click={pressConfirm}
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
        <button type="button" class="key num" on:click={() => pressChar('1')} disabled={disabled} aria-label="1">1</button>
        <button type="button" class="key num" on:click={() => pressChar('2')} disabled={disabled} aria-label="2">2</button>
        <button type="button" class="key num" on:click={() => pressChar('3')} disabled={disabled} aria-label="3">3</button>
        <button type="button" class="key op" on:click={() => pressChar('+')} disabled={disabled} aria-label="加">+</button>

        <button type="button" class="key num" on:click={() => pressChar('4')} disabled={disabled} aria-label="4">4</button>
        <button type="button" class="key num" on:click={() => pressChar('5')} disabled={disabled} aria-label="5">5</button>
        <button type="button" class="key num" on:click={() => pressChar('6')} disabled={disabled} aria-label="6">6</button>
        <button type="button" class="key op" on:click={() => pressChar('-')} disabled={disabled} aria-label="减">&minus;</button>

        <button type="button" class="key num" on:click={() => pressChar('7')} disabled={disabled} aria-label="7">7</button>
        <button type="button" class="key num" on:click={() => pressChar('8')} disabled={disabled} aria-label="8">8</button>
        <button type="button" class="key num" on:click={() => pressChar('9')} disabled={disabled} aria-label="9">9</button>
        <button type="button" class="key op" on:click={() => pressChar('*')} disabled={disabled} aria-label="乘">×</button>

        <button type="button" class="key ctrl" on:click={pressClear} disabled={disabled} aria-label="清空">C</button>
        <button type="button" class="key num" on:click={() => pressChar('0')} disabled={disabled} aria-label="0">0</button>
        <button type="button" class="key num" on:click={() => pressChar('.')} disabled={disabled} aria-label="小数点">.</button>
        <button type="button" class="key op" on:click={() => pressChar('/')} disabled={disabled} aria-label="除">÷</button>

        <button
          type="button"
          class="key eq"
          on:click={pressEquals}
          disabled={disabled}
          aria-label="等于, 计算结果并加括号"
          data-testid="amount-calc-eq"
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
    z-index: 180;
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
    min-height: var(--touch-target, 44px);
    -webkit-user-select: none;
    user-select: none;
  }

  .sheet-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.08);
    z-index: 99;
    animation: backdropFadeIn 200ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 150;
    background: var(--color-bg, #fff);
    border-top: 1px solid var(--color-border, #e5e7eb);
    box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.06);
    padding: 12px 12px calc(12px + env(safe-area-inset-bottom, 0px));
    display: flex;
    flex-direction: column;
    gap: 12px;
    animation: sheetSlideUp 200ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .sheet-amount-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 56px;
    padding: 8px 8px 8px 14px;
    background: rgba(255, 255, 255, 0.72);
    backdrop-filter: blur(12px) saturate(180%);
    -webkit-backdrop-filter: blur(12px) saturate(180%);
    border-radius: 16px;
    border: 1px solid rgba(99, 102, 241, 0.18);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.75),
      inset 0 -1px 0 rgba(15, 23, 42, 0.03);
  }
  .sheet-amount-expr {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 22px;
    font-weight: 600;
    color: var(--color-text, #111827);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    line-height: 1.2;
  }
  .sheet-amount-preview {
    flex: 0 0 auto;
    font-size: 14px;
    color: var(--gray-500, #6b7280);
    font-variant-numeric: tabular-nums;
    font-weight: 500;
    white-space: nowrap;
    padding: 4px 10px;
    background: rgba(241, 245, 249, 0.7);
    border-radius: 999px;
    border: 1px solid rgba(148, 163, 184, 0.18);
  }
  .sheet-amount-error-pill {
    flex: 0 0 auto;
    font-size: 13px;
    color: #b91c1c;
    font-weight: 600;
    white-space: nowrap;
    padding: 5px 12px;
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
    background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    border: 1px solid rgba(255, 255, 255, 0.22);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.42),
      inset 0 -1px 0 rgba(67, 56, 202, 0.18),
      0 4px 14px rgba(99, 102, 241, 0.38),
      0 1px 3px rgba(99, 102, 241, 0.22);
    transition: transform 80ms ease, box-shadow 120ms ease;
    -webkit-tap-highlight-color: transparent;
  }
  .confirm-btn:active:not(:disabled) {
    transform: scale(0.95);
  }
  .confirm-btn:focus-visible {
    outline: 2px solid var(--accent-500, #3b82f6);
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
