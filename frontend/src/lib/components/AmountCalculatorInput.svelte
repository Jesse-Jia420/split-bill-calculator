<script lang="ts">
  /**
   * v0.2.3 T13r2 — AmountCalculatorInput bottom sheet (PRD §3.9.1b).
   *
   * Round 2 fix: the amount row now lives **inside** the bottom sheet
   * while open. When closed the row lives at its original form
   * position. The sheet always carries a persistent amount row at the
   * top + the 4×5 keypad below — i.e. it behaves like a system
   * keyboard: 「the field you're editing + the keys you type on」.
   *
   * Round 1 root cause: when the keypad was open the row stayed in the
   * form, behind the `rgba(0,0,0,0.25)` backdrop. The backdrop covered
   * the viewport, so the row was invisible.
   *
   * Round 2 behavior:
   *  - value/evaluated are bound by the parent; two row copies share
   *    the same state, no extra state needed.
   *  - The form-position row is hidden via `class:hidden` when the
   *    keypad is open. It becomes visible again on close.
   *  - The sheet-top row is rendered only inside `{#if showKeypad}`.
   *    It is read-only (like before) so the OS keyboard stays away.
   *
   * v0.3.21 #114 (PO msg 03:10 #7816): form-position row 保持可见.
   * 原 T13r2 设计 keypad 打开时 form-row hidden, 用户反馈"一点击怎么消失了".
   * 改: form-row 永远可见 (键盘点击展开后, input 还在原位置, 被 backdrop
   * 半透遮罩, sheet 从底部升起覆盖下半屏). 用户既能看到自己点的输入框,
   * 也能看到底部 keypad. sheet-amount-row 保留 (贴近 keypad 的持久显示).
   * 实际影响: form-row + sheet-amount-row 同步显示同一值, 略冗余但清晰.
   *
   * Props / events / debounce / helpers — unchanged from T13.
   */
  import { onMount, createEventDispatcher } from 'svelte';
  import { evaluateExpression } from '$api/calculator';

  export let value: string = '';
  export let evaluated: number | null = null;
  export let currency: string = '';
  export let disabled: boolean = false;

  const dispatch = createEventDispatcher<{
    change: string;
    amountChange: number | null;
  }>();

  let debounceId: ReturnType<typeof setTimeout> | null = null;
  let showKeypad: boolean = false;

  function openKeypad() {
    if (disabled) return;
    showKeypad = true;
  }

  function closeKeypad() {
    showKeypad = false;
  }

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

  function pressChar(ch: string) {
    if (disabled) return;
    commit(value + ch);
  }

  function pressBackspace() {
    if (disabled) return;
    commit(value.slice(0, -1));
  }

  function pressClear() {
    if (disabled) return;
    commit('');
  }

  function pressEquals() {
    if (disabled) return;
    if (debounceId) clearTimeout(debounceId);
    const trimmed = value.trim();
    if (trimmed === '') return;
    const result = evaluateExpression(trimmed);
    evaluated = result;
    dispatch('amountChange', result);
  }

  function pressValue() {
    if (evaluated === null) return;
    const asExpr = Number(evaluated).toString();
    commit(asExpr);
  }

  onMount(() => {
    if (value.trim()) {
      const result = evaluateExpression(value.trim());
      evaluated = result;
      dispatch('amountChange', result);
    }
  });

  $: previewText = evaluated !== null
    ? `= ${evaluated.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : (value.trim() === '' ? '' : '= 表达式错误');

  $: previewIsError = value.trim() !== '' && evaluated === null;
</script>

<div class="amount-calc" class:disabled class:open={showKeypad}>
  <!--
    Form-position row. 一直保持可见 (不再 keypad 打开时 hidden).
    v0.3.21 #114 (PO msg 03:10 #7816): 用户反馈 "金额输入框一点击怎么就消失了" —
    原 v0.2.3 T13r2 设计是 click → form-row hidden + 底部 sheet 升起 + 背景虚化,
    输入框从 viewport 消失造成 "点击→消失" 错觉. 改: form-row 保留,
    sheet 升起覆盖下半屏, form-row 在背景虚化下仍可见 (半透),
    用户既能看到自己点的输入框也能看到底部 sheet 的 keypad.
    sheet-amount-row 留在 sheet 顶部提供贴近 keypad 的 persistent display.
    -->
  <div
    class="amount-row"
    role="button"
    tabindex={disabled ? -1 : 0}
    aria-label="金额表达式, 点击打开键盘"
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
      value={value}
      aria-label="金额表达式"
      placeholder="0"
      data-testid="amount-calc-input"
    />
    <span class="preview" class:error={previewIsError} data-testid="amount-calc-preview">
      {previewText}{previewText && currency ? ` ${currency}` : ''}
    </span>
  </div>

  {#if showKeypad}
    <div
      class="sheet-backdrop"
      data-testid="amount-calc-backdrop"
      on:click={closeKeypad}
      aria-hidden="true"
    ></div>
    <div class="sheet" role="dialog" aria-label="计算器键盘" aria-modal="true">
      <!--
        Sheet-top amount row: pinned at the top of the sheet so the
        user always sees what they're typing. Same value/evaluated
        state as the form-position row.
      -->
      <div class="sheet-amount-row" data-testid="amount-calc-sheet-row">
        <span class="sheet-amount-expr" aria-label="当前金额表达式">{value || '0'}</span>
        <span class="sheet-amount-preview" class:error={previewIsError} aria-label="当前金额预览">
          {previewText}{previewText && currency ? ` ${currency}` : ''}
        </span>

      </div>
      <!-- 4×5 keypad. -->
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

        <!-- Row 5: equals (3-col) + backspace (1-col). 
             v0.3.1 (PO Bug #3): `=` now does the "完成" action (close
             keypad), per PO. The standalone 完成 button is removed. -->
        <button
          type="button"
          class="key eq"
          on:click={() => { pressEquals(); closeKeypad(); }}
          disabled={disabled}
          aria-label="完成, 收起键盘"
          data-testid="amount-calc-eq-done"
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
    /* v0.3.23 #136 (UAT bug #3): 在 BillForm flex:1 单元格里撑满 cell (否则仅 110px
       intrinsic, 不填 157px cell, 导致金额 input 仅 26px 不可点). */
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
    /* v0.3.21 #114 (PO msg 03:10 #7816): form-row 浮在 sheet 之上, 用户
       点开 keypad 后仍能看到自己点的输入框. z-index 180 > sheet 150.
       position: relative 让 z-index 生效 (form-row 在正常 flow 里). */
    position: relative;
    z-index: 180;
  }
  /* v0.3.21 #114 (PO msg 03:10 #7816): 删 .amount-row.hidden-when-open (display: none).
     原 v0.2.3 T13r2 设计 keypad 打开时隐藏 form-row, PO 拍板改 "保持可见"
     — 用户需要看到自己点的输入框. 配合 template 删除 class:hidden-when-open. */
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

  /* v0.2.3 T13r2: sheet carries the same amount row at the top + keypad below.
     v0.3.23 #137 (UAT bug #15): 减 backdrop 强度避免「金额输入框一点击就消失」错觉.
     原 rgba(0,0,0,0.25) + blur(2px) 让周围表单变暗模糊 → input 顶叠 (z=180) 但
     周围变暗让 user 误以为 input 也消失了. 修法: 减 rgba 到 0.08, 去 blur.
     input 仍 z=180 顶叠可见 (DOM + z-index 都没改), 仅周围表单仍清晰可点. */
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
    /* v0.3.20 #95 Fix 1 (PO msg 02:41 #7459): z-index 100 → 150. FAB (返回 + 保存)
       z-index=100, sheet 100 会让 FAB 浮在 sheet 上 → 视觉上"键盘遮不住 FAB"。
       提到 150 后 sheet 视觉上盖住 FAB, 跟桌面端 floating-bottom-keyboard
       一致。backdrop (z=99) 仍低于 FAB (z=100) → FAB 在 backdrop 之上可见,
       键盘弹起时 backdrop 不灭 FAB, sheet 直接接管覆盖。 */
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
  /* The persistent amount row at the top of the sheet. It carries the
     same value/evaluated state as the form-side row, and stays visible
     while the user types on the keypad below. */
  .sheet-amount-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--touch-target, 44px);
    padding: 8px 10px;
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    background: var(--color-bg, #fff);
  }
  .sheet-amount-expr {
    flex: 1 1 auto;
    min-width: 0;
    font-variant-numeric: tabular-nums;
    font-size: var(--font-size-base, 16px);
    color: var(--color-text, #111827);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sheet-amount-preview {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
    color: var(--gray-500, #6b7280);
    font-size: var(--font-size-sm, 13px);
    white-space: nowrap;
    text-align: right;
  }
  .sheet-amount-preview.error {
    color: var(--error-500, #ef4444);
  }
  .sheet-done {
    flex: 0 0 auto;
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
