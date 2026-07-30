<!--
  SessionCurrencyBadge.svelte — v0.3.16 #6 currency meta redesign (PO msg 18:16 CST 拍板)
  形态: Designer 方案 A — Compact pill row
        - 单行胶囊 `CNY ⇄ THB · 1 CNY = 4.6512` (主币种 chip 蓝色 accent, 副币种 chip 灰底)
        - 汇率数字 + owner 蓝色铅笔 (Lucide edit SVG 12x12)
        - 单币种 session 退化为单 chip `[CNY]`
        - 不喧宾夺主: 13px 字号, color var(--gray-700), padding 4px 0
  视觉 token 全部引用 v0.1.3 app.css, 不新增 token。

  v0.3.17 #36 (2026-07-18, PO msg 10:54): 汇率 bar 改成 2 行布局.
  v0.3.17 #36fix (2026-07-18, PO msg 12:45 #6287): Row 1 + Row 2 合并 1 个 bar.
  v0.3.18 #43: 整 bar 高度压到 ~40px.
  v0.3.18 #53: 单币种胶囊缩小 + 点击添加副币种.
  v0.3.18 #64 CurrentResize: 单币种 pill 形态调整 (padding/font-size/min-height/border).
  v0.3.20 #93 Fix 9: 单币种 pill 改 button 形态.
  v0.3.20 #94 Fix 2: 单币种 pill 视觉更明显 (min-height 44 / font-size 15 / padding 12/24).
  v0.3.20 #98 (Coder 1): 3 处 UI 微调 (跟本组件无关, 引用其值).
  v0.3.20 #99: NavBar 玻璃化 (跟本组件无关).

  v0.3.19 #85 重写 (PO msg 23:?? #7308) — 删 inline edit + 整 bar clickable:
    1) 单币种 pill 还是太长, 改成短 pill (保留现有 44px 高 + button 形态).
    2) 多币种 inline edit 改弹窗 — 不能在 bar 上直接改, 点击 bar 触发弹窗.
       删除整套 inline edit (editing / startEdit / commitEdit / handleEditKeydown +
       <input class="rate-input"> + 铅笔 <svg> + PATCH 调用 + apiFetch/ApiError import).
       Rate row 退化为只读展示 `1 {primary} = {rate_row.rate} {secondary}`.
    3) 多币种 case 整 bar 包成 <button> (editable=true 时), on:click 触发 onAddCurrency.
       non-owner 用户 (editable=false) 仍保持 <div> 不可点.
    4) 删除 props: onRateChange (inline edit 不再需要, 弹窗处理 PATCH, parent onAdded reload).
    5) 删除 state: editing / edit_value / edit_busy / edit_error.
    6) 删除 fn: startEdit / cancelEdit / commitEdit / handleEditKeydown.
    7) 删除 import: apiFetch / ApiError (不再需要).
    8) 视觉: rate row 视觉跟 Row 1 同层级 (L3 灰色副标题感), 不再有 accent 蓝色 + 铅笔
       (affordance 转移到了整 bar 整 clickable + hover/active bg 加深).
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { SessionExchangeRate } from '$api/sessions';

  export let currencies: string[];
  export let primary_currency: string;
  /** v0.3.14: per-session exchange rates (forward + reciprocal pairs). */
  export let exchange_rates: SessionExchangeRate[] = [];
  /** §3.14.2 是否启用交互 (双币种 + owner); 也用于单币种 pill clickable. */
  export let editable: boolean = false;
  /** 'detail' = session detail 页 (16px bottom margin) | 'settle' = 顶部 compact (12px) */
  export let variant: 'detail' | 'settle' = 'detail';
  /** v0.3.18 #53 (单币种 owner) + v0.3.19 #85 (多币种 owner 整 bar) 触发.
   *  parent 用来打开 CurrencyAddModal. modal 不在本组件内 — 避免 single-purpose
   *  modal inflate SessionCurrencyBadge 这个核心 currency meta 组件的体量. */
  export let onAddCurrency: (() => void) | undefined = undefined;

  const dispatch = createEventDispatcher<{ addCurrency: void }>();

  $: is_single = currencies.length === 1;
  $: secondary_currency = currencies.find((c) => c !== primary_currency) ?? '';

  /** 主币种 → 副币种 的汇率 (展示用). */
  $: rate_row =
    !is_single
      ? exchange_rates.find(
          (r) =>
            r.from_currency === primary_currency &&
            r.to_currency === secondary_currency
        ) ?? null
      : null;

  /** 是否展示 rate row (双币种 + 实际有 exchange_rates 数据). */
  $: show_rate = !is_single && rate_row !== null;

  /** v0.3.18 #53: 单币种 + owner 时 pill 是 clickable.
   *  v0.3.19 #85: 双币种 + owner 时整 bar 也 clickable (统一 affordance).
   *  non-owner 都不可点. */
  $: single_clickable = is_single && editable;
  $: multi_clickable = !is_single && editable;

  /** v0.3.19 #85: 统一 click handler. 单/多币种 owner 触发 onAddCurrency
   *  或 dispatch 事件 (兼容未传 prop 的场景). */
  function handleAddCurrencyClick() {
    if (!editable) return;
    if (onAddCurrency) {
      onAddCurrency();
    } else {
      dispatch('addCurrency');
    }
  }
</script>

<div
  class="currency-meta"
  class:currency-meta--compact={variant === 'settle'}
  data-sbc="currency-meta"
>
  {#if is_single}
    <!-- v0.3.18 #53 + v0.3.20 #93/#94: 单币种 pill 缩小 + owner clickable.
         single_clickable=true → <button>, 加 + icon + hover 反馈.
         single_clickable=false → <div>, 不可点. -->
    {#if single_clickable}
      <button
        type="button"
        class="currency-pill-row currency-pill-row--single currency-pill-row--clickable"
        onclick={handleAddCurrencyClick}
        aria-label="添加副币种"
        data-sbc="currency-pill-add-secondary"
        data-primary={primary_currency}
      >
        <span class="currency-chip primary">{primary_currency}</span>
        <span class="add-icon" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            stroke-width="2.25"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
        </span>
      </button>
    {:else}
      <div
        class="currency-pill-row currency-pill-row--single"
        data-sbc="currency-pill-readonly"
        data-primary={primary_currency}
      >
        <span class="currency-chip primary">{primary_currency}</span>
      </div>
    {/if}
  {:else}
    <!-- v0.3.17 #36fix: 双币种 case 改成 1 个外层 bar 内部 2 行.
         v0.3.19 #85: 整 bar 在 owner 时改为 <button> (editable 触发 onAddCurrency),
         rate row 退化为只读展示 (无 inline edit, 无铅笔 icon, 无 input).
         non-owner 仍 <div> 不可点. -->
    {#if multi_clickable}
      <button
        type="button"
        class="currency-bar currency-bar--clickable"
        onclick={handleAddCurrencyClick}
        aria-label="修改币种设置"
        data-sbc="currency-bar-edit"
        data-primary={primary_currency}
        data-secondary={secondary_currency}
        data-rate={rate_row?.rate ?? ''}
      >
        <!-- Row 1: 货币对 (CNY ⇄ THB) -->
        <div class="currency-pill-row">
          <span class="currency-chip primary">{primary_currency}</span>
          <span class="currency-arrow" aria-hidden="true">⇄</span>
          <span class="currency-chip secondary">{secondary_currency}</span>
        </div>
        <!-- Row 2: 汇率 (只读) -->
        {#if show_rate && rate_row}
          <div class="rate-row">
            <span class="currency-rate-label">1 {primary_currency} =</span>
            <span class="rate-value">
              <span class="rate-num">{rate_row.rate}</span>
              <span class="rate-unit">{secondary_currency}</span>
            </span>
          </div>
        {/if}
      </button>
    {:else}
      <div
        class="currency-bar"
        data-sbc="currency-bar-readonly"
        data-primary={primary_currency}
        data-secondary={secondary_currency}
        data-rate={rate_row?.rate ?? ''}
      >
        <div class="currency-pill-row">
          <span class="currency-chip primary">{primary_currency}</span>
          <span class="currency-arrow" aria-hidden="true">⇄</span>
          <span class="currency-chip secondary">{secondary_currency}</span>
        </div>
        {#if show_rate && rate_row}
          <div class="rate-row">
            <span class="currency-rate-label">1 {primary_currency} =</span>
            <span class="rate-value">
              <span class="rate-num">{rate_row.rate}</span>
              <span class="rate-unit">{secondary_currency}</span>
            </span>
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  /* 容器: 仅负责外边距 (variant 决定).
   * v0.3.19 #85 PO #7731 (#1): 加 text-align: center 让单币种 inline-flex pill
   * 跟多币种 block-flex bar 一样视觉居中 (单币种 inline 元素靠 text-align
   * 继承居中, 多币种 block 元素靠 margin auto 居中 — 两路径汇合). */
  .currency-meta {
    margin: var(--space-2) 0 var(--space-4);
    text-align: center;
  }
  .currency-meta--compact {
    margin: 0 0 var(--space-3);
  }

  /* v0.3.18 #53: 单币种 pill 缩小 + owner clickable.
   *  v0.3.20 #94 Fix 2: button 形态更明确 (min-height 44 / padding 12/24 /
   *  font-size 15 / font-weight 700 / bg alpha 0.16/0.14 / shadow 0.15). */
  .currency-pill-row {
    display: flex;
    justify-content: center;
    align-items: center;
    flex-wrap: nowrap;
    gap: clamp(4px, 1.5vw, 8px);
    width: 100%;
    min-height: 16px;
    padding: 0;
    margin: 0;
  }

  .currency-pill-row--single {
    display: inline-flex;
    justify-content: center;
    align-items: center;
    flex-wrap: nowrap;
    gap: clamp(6px, 1.5vw, 8px);
    margin: 8px auto;
    padding: 12px 24px;
    width: fit-content;
    max-width: calc(100% - 32px);
    font-size: 15px;
    font-weight: 700;
    line-height: 1.3;
    color: var(--gray-700);
    overflow: hidden;
    min-height: 44px;

    background: linear-gradient(
      135deg,
      rgba(40, 40, 40, 0.16) 0%,
      rgba(58, 58, 58, 0.14) 100%
    );
    backdrop-filter: saturate(200%) blur(20px);
    -webkit-backdrop-filter: saturate(200%) blur(20px);

    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.6),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04),
      0 4px 14px rgba(40, 40, 40, 0.15);

    border-radius: 999px;
    border: 1.5px solid rgba(40, 40, 40, 0.28);
  }

  @supports not (backdrop-filter: blur(1px)) {
    .currency-pill-row--single {
      background: rgba(40, 40, 40, 0.28);
    }
  }

  /* v0.3.20 #94 Fix 2b: `font: inherit` 改 `font-family: inherit`.
   *  之前 `font: inherit` 是 CSS shorthand, 会重置所有 font 子属性. */
  button.currency-pill-row--single {
    appearance: none;
    cursor: pointer;
    font-family: inherit;
    color: inherit;
    transition:
      background 150ms ease,
      box-shadow 150ms ease,
      transform 100ms ease;
  }
  button.currency-pill-row--single:hover {
    background: linear-gradient(
      135deg,
      rgba(40, 40, 40, 0.16) 0%,
      rgba(58, 58, 58, 0.13) 100%
    );
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.55),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04),
      0 2px 6px rgba(40, 40, 40, 0.08);
  }
  button.currency-pill-row--single:active {
    transform: scale(0.97);
  }
  button.currency-pill-row--single:focus-visible {
    outline: 2px solid var(--accent-500, #2c2c2c);
    outline-offset: 2px;
  }

  .add-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    color: var(--btn-label, var(--logo-ink, #1a1a1a));
    flex-shrink: 0;
    margin-left: 1px;
  }

  /* v0.3.17 #36fix + v0.3.18 #43 + v0.3.19 #85: 外层 .currency-bar (双币种 case).
   *  - flex-direction column 内部装 Row 1 + Row 2, 形成「1 个胶囊里有 2 行」视觉.
   *  - v0.3.19 #85: 整 bar 在 owner 时是 <button>, 加 cursor + hover/active 反馈.
   *  - v0.3.19 #85: rate row 退化为只读展示 (no inline edit, no pencil SVG, no input).
   *  - v0.3.22 #125 (UAT bug #5, PO msg 16:05 #8064): 颜色调浅跟邀请按钮
   *    .glass-pill **button 形态 token** 完全一致 (app.css .btn.glass-pill,
   *    button.glass-pill override base 0.04/0.02), 不是 base .glass-pill
   *    (那是 div/<a> 略淡的 0.04/0.02). 邀请按钮在 app.css 实际渲染 =
   *    bg 0.06/0.04 + border 0.18 + hover 0.14/0.10. 原 0.10/0.08 (v0.3.17 #36fix)
   *    深 1.7 倍, PO 反馈"颜色有点深". 全站 glass 统一, bar = 邀请按钮. */
  .currency-bar {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    width: fit-content;
    max-width: calc(100% - 32px);
    margin: 8px auto;
    padding: 2px clamp(8px, 3vw, 14px);
    font-size: 12px;
    line-height: 1.2;
    color: var(--gray-700);
    overflow: hidden;

    background: linear-gradient(
      135deg,
      rgba(40, 40, 40, 0.06) 0%,
      rgba(58, 58, 58, 0.04) 100%
    );
    backdrop-filter: saturate(200%) blur(20px);
    -webkit-backdrop-filter: saturate(200%) blur(20px);

    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.6),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04),
      0 1px 4px rgba(40, 40, 40, 0.08);

    border-radius: 999px;
    border: 1px solid rgba(40, 40, 40, 0.18);
  }

  @supports not (backdrop-filter: blur(1px)) {
    .currency-bar {
      background: rgba(40, 40, 40, 0.08);
    }
  }

  /* v0.3.19 #85: owner 双币种整 bar 是 <button>, 加 cursor + hover/active 反馈.
   *  hover bg alpha 0.06/0.04 → 0.14/0.10 (跟 invite button.glass-pill:hover
   *  override 同参数, hover 仍略亮保持互动反馈). shadow 0.08 → 0.10 (按钮抬起感).
   *  非 owner 仍 <div>, 不可点.
   *  font-family: inherit (跟单币种 button fix 同步 — 避免 button 默认字体覆盖). */
  button.currency-bar--clickable {
    appearance: none;
    cursor: pointer;
    font-family: inherit;
    color: inherit;
    transition:
      background 150ms ease,
      box-shadow 150ms ease,
      transform 100ms ease;
  }
  button.currency-bar--clickable:hover {
    background: linear-gradient(
      135deg,
      rgba(40, 40, 40, 0.14) 0%,
      rgba(58, 58, 58, 0.10) 100%
    );
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.7),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04),
      0 2px 8px rgba(40, 40, 40, 0.10);
  }
  button.currency-bar--clickable:active {
    transform: scale(0.98);
  }
  button.currency-bar--clickable:focus-visible {
    outline: 2px solid var(--accent-500, #2c2c2c);
    outline-offset: 2px;
  }

  /* 内部 chip 透明 (无独立 bg, 融入外层 .currency-bar / .currency-pill-row--single) */
  .currency-chip {
    display: inline-flex;
    align-items: center;
    padding: 0;
    background: transparent;
    font-size: clamp(0.6875rem, 2.6vw, 0.75rem);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--gray-800);
    letter-spacing: 0.02em;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .currency-chip.primary {
    background: transparent;
    /* 与账单列表主币种 pill 字色一致 (charcoal) */
    color: var(--btn-label, var(--logo-ink, #1a1a1a));
  }
  .currency-chip.secondary {
    background: transparent;
    /* 与账单列表副币种 / 消费币种 pill 字色一致 (warm stone) */
    color: #57534e;
  }

  .currency-arrow {
    color: var(--accent-500, #2c2c2c);
    font-size: clamp(0.75rem, 2.8vw, 0.875rem);
    font-weight: 600;
    flex-shrink: 0;
  }

  /* v0.3.19 #85: rate row 退化为只读展示 (副标题感 gray-600 + 数字 gray-900).
   *  跟 Row 1 同高 unit, min-height 16 保持, font-size 11 跟原一致. */
  .rate-row {
    display: flex;
    justify-content: center;
    align-items: center;
    flex-wrap: wrap;
    gap: clamp(4px, 1.5vw, 8px);
    width: 100%;
    min-height: 16px;
    line-height: 1.2;
    padding: 0;
    margin: 0;
    font-size: 11px;
    color: var(--gray-600);
  }

  .currency-rate-label {
    color: var(--gray-500);
    font-size: clamp(0.625rem, 2.4vw, 0.6875rem);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .rate-num {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: var(--gray-900);
    white-space: nowrap;
  }
  .rate-unit {
    margin-left: 3px;
    font-size: clamp(0.625rem, 2.4vw, 0.6875rem);
    font-weight: 500;
    color: var(--btn-label, var(--logo-ink, #1a1a1a));
    letter-spacing: 0.02em;
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* v0.3.18 #43: align-items center (跟 .rate-input 视觉同高).
   *  v0.3.19 #85: rate-value 不再有 bg / border / padding (退化为纯文本),
   *  inline edit 已删, 不再需要 button 形态. */
  .rate-value {
    display: inline-flex;
    align-items: center;
    gap: 0;
    font-variant-numeric: tabular-nums;
    color: var(--gray-900);
    white-space: nowrap;
    flex-shrink: 0;
  }
</style>