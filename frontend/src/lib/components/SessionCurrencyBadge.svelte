<!--
  SessionCurrencyBadge.svelte — v0.3.16 #6 currency meta redesign (PO msg 18:16 CST 拍板)
  形态: Designer 方案 A — Compact pill row
        - 单行胶囊 `CNY ⇄ THB · 1 CNY = 4.6512` (主币种 chip 蓝色 accent, 副币种 chip 灰底)
        - 汇率数字 + owner 蓝色铅笔 (Lucide edit SVG 12x12)
        - 单币种 session 退化为单 chip `[CNY]`
        - 不喧宾夺主: 13px 字号, color var(--gray-700), padding 4px 0
  视觉 token 全部引用 v0.1.3 app.css, 不新增 token。
  inline edit 逻辑 (editing / startEdit / commitEdit / handleEditKeydown) 保持不变。

  v0.3.17 #36 (2026-07-18, PO msg 10:54): 汇率 bar 改成 2 行布局. 货币对 (Row 1)
  `.currency-pill-row` + 汇率 + 编辑 (Row 2) 新 `.rate-row`. 多币种 case 拆 2 行
  (取消 inline `·` + `currency-rate-label`), 单币种 case 保持单 chip 不变.
  复用现有 iOS27 Liquid Glass material (v0.3.17 #21/#34), 视觉风格延续.

  v0.3.17 #36fix (2026-07-18, PO msg 12:45 #6287 拍板): 纠正 #36 视觉实现.
  原 #36 把 Row 1 + Row 2 做成 2 个独立 pill capsule (上下堆叠 2 个胶囊), PO 拍板
  「应该是一个 bar 内部有两行」. 修法:
    - 双币种 case 引入外层 `.currency-bar` (唯一 pill 视觉: border-radius 999px,
      fit-content 居中, 玻璃 material) — flex-direction column 包裹 Row 1 + Row 2.
    - 内部 `.currency-pill-row` (Row 1 货币对) + `.rate-row` (Row 2 汇率 + 编辑)
      退化为「分隔行」, 不再有 bg / border-radius / border — 只用 padding/margin
      拉开视觉, 跟外层 pill 共享同一玻璃基底.
    - 视觉层次保留: Row 1 主币种 chip 仍然 accent-700 蓝色提示 (PO 蓝色意图),
      Row 2 灰色汇率 (副标题感) — 但层次通过字号 / 颜色, 不是通过 bg 区分.
    - 单币种 case 不变: `.currency-pill-row.currency-pill-row--single` 仍是单 chip
      (1 个 row = 1 个 pill, 不需外层 wrapper).
  行为 / 状态 / PATCH 逻辑 / 编辑态 / data-* 属性全部保留.

  v0.3.18 #53 (PO msg 10:49 #6542) — 单币种胶囊缩小 + 点击添加副币种.
  PO 反馈「单币种时, 币种胶囊 bar 比例有问题, 缩成一个小的即可」.
  修法:
    * 单币种 pill 整体缩小 (padding / font-size / blur / inset highlight / box-shadow
      全部降一档, 跟双币种 Row 1 (.currency-pill-row) 高度对齐 ~24-28px).
    * 单币种 + owner (editable={true}) → pill 包成 `<button>`, 加 click 触发 +
      右侧 "+" 提示 (Lucide plus icon). 点击 → 调用 onAddCurrency 回调, 由 parent
      弹 CurrencyAddModal.
    * 单币种 + non-owner → 保持 `<div>`, 不可点 (现有行为).
    * 双币种 case 不变 (已经有自己的 .rate-button edit flow, 不要冲突).
    * 新增 prop `onAddCurrency: () => void` 可选 — parent 用来接收 click 事件.
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { apiFetch, ApiError } from '$api/client';
  import type { SessionExchangeRate } from '$api/sessions';

  export let currencies: string[];
  export let primary_currency: string;
  /** v0.3.14: per-session exchange rates (forward + reciprocal pairs). */
  export let exchange_rates: SessionExchangeRate[] = [];
  /** §3.14.2 inline edit 是否启用 (双币种 + owner) */
  export let editable: boolean = false;
  /** 'detail' = session detail 页 (16px bottom margin) | 'settle' = 顶部 compact (12px) */
  export let variant: 'detail' | 'settle' = 'detail';
  /** §3.14.2 PATCH 成功回调 (page 接到事件后 reload / 重新拉 settle) */
  export let onRateChange: ((newRate: string) => void) | undefined = undefined;
  /** v0.3.18 #53: 单币种 + owner 点击 pill 时回调, parent 用来打开
   *  CurrencyAddModal (modal 不在本组件内 — 避免 single-purpose modal
   *  inflate SessionCurrencyBadge 这个核心 currency meta 组件的体量). */
  export let onAddCurrency: (() => void) | undefined = undefined;

  const dispatch = createEventDispatcher<{ addCurrency: void }>();

  $: is_single = currencies.length === 1;
  $: secondary_currency = currencies.find((c) => c !== primary_currency) ?? '';

  /** 主币种 → 副币种 的汇率 (展示用, 与 inline edit 改的是同一行, BE 自动同步 reciprocal) */
  $: rate_row =
    !is_single
      ? exchange_rates.find(
          (r) => r.from_currency === primary_currency && r.to_currency === secondary_currency
        ) ?? null
      : null;

  /** 是否展示 rate row (双币种 + 实际有 exchange_rates 数据) */
  $: show_rate = !is_single && rate_row !== null;

  /** v0.3.18 #53: 单币种 + owner 时 pill 是 clickable. 双币种 case 已经有
   *  .rate-button edit flow, 不要冲突, 显式 guard. */
  $: single_clickable = is_single && editable;

  // §3.14.2 inline edit 状态
  let editing = false;
  let edit_value = '';
  let edit_busy = false;
  let edit_error: string | null = null;

  function startEdit() {
    if (!editable || !rate_row) return;
    edit_value = rate_row.rate;
    edit_error = null;
    editing = true;
    // 下一个 microtask 让 input 出现后 focus
    queueMicrotask(() => {
      const el = document.getElementById('sbc-rate-input') as HTMLInputElement | null;
      el?.focus();
      el?.select();
    });
  }

  function cancelEdit() {
    editing = false;
    edit_value = '';
    edit_error = null;
  }

  async function commitEdit() {
    if (!rate_row) return;
    const trimmed = edit_value.trim();
    // 简单校验: 必须 > 0 的数字
    const n = Number(trimmed);
    if (!trimmed || !Number.isFinite(n) || n <= 0) {
      edit_error = '请输入大于 0 的数字';
      return;
    }
    edit_busy = true;
    edit_error = null;
    try {
      // PATCH /api/sessions/{sid}/exchange-rates/{rate_id}
      // body: { rate: "0.045" }
      // BE 自动同步 reciprocal; 旧 bill snapshot 保留 (历史不被覆盖)。
      await apiFetch<SessionExchangeRate[]>(
        `/sessions/${rate_row.session_id}/exchange-rates/${rate_row.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ rate: trimmed }),
        }
      );
      editing = false;
      onRateChange?.(trimmed);
    } catch (e: any) {
      if (e instanceof ApiError) {
        edit_error = e?.detail?.detail?.error ?? e?.message ?? '更新失败';
      } else {
        edit_error = e?.message ?? '更新失败';
      }
    } finally {
      edit_busy = false;
    }
  }

  function handleEditKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  }

  /** v0.3.18 #53: 单币种 + owner click handler. 优先调用 onAddCurrency
   *  prop (parent 提供 modal 切换状态), 也 dispatch 事件 (兼容未传
   *  prop 的场景). */
  function handleAddCurrencyClick() {
    if (!single_clickable) return;
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
    <!-- v0.3.18 #53 (PO msg 10:49 #6542): 单币种 pill 缩小 + owner clickable.
         单币种 + owner (single_clickable=true) → 包成 <button>, 加 + icon +
         hover 反馈. 单币种 + non-owner → 保持 <div>, 不可点.
         双币种 case 不变 (见下面 .currency-bar 块). -->
    {#if single_clickable}
      <button
        type="button"
        class="currency-pill-row currency-pill-row--single currency-pill-row--clickable"
        on:click={handleAddCurrencyClick}
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
    <!-- v0.3.17 #36fix (PO msg 12:45 #6287 拍板): 双币种 case 改成 1 个外层 bar 内部 2 行.
         原 #36 拆 2 个独立 pill (视觉像 2 个胶囊堆叠), 现在合并成 1 个 capsule. -->
    <div class="currency-bar" data-sbc="currency-bar">
      <!-- Row 1: 货币对 (CNY ⇄ THB) — 内部分隔行, 不再有独立 pill bg -->
      <div class="currency-pill-row">
        <span class="currency-chip primary">{primary_currency}</span>
        <span class="currency-arrow" aria-hidden="true">⇄</span>
        <span class="currency-chip secondary">{secondary_currency}</span>
      </div>
      <!-- Row 2: 汇率 + 编辑 (1 CNY = ... THB + ✏️) — 内部分隔行, 灰色副标题感 -->
      {#if show_rate && rate_row}
        <div class="rate-row">
          <span class="currency-rate-label">1 {primary_currency} =</span>
          {#if editing}
            <span class="edit-host">
              <input
                id="sbc-rate-input"
                type="text"
                inputmode="decimal"
                class="rate-input"
                bind:value={edit_value}
                on:keydown={handleEditKeydown}
                on:blur={() => !edit_busy && commitEdit()}
                disabled={edit_busy}
                aria-label="编辑汇率"
              />
              <span class="rate-suffix">{secondary_currency}/{primary_currency}</span>
              {#if edit_error}
                <span class="rate-error" role="alert">{edit_error}</span>
              {/if}
            </span>
          {:else if editable}
            <button
              type="button"
              class="rate-button"
              on:click={startEdit}
              aria-label={`编辑汇率 ${rate_row.rate}`}
              data-rate={rate_row.rate}
              data-rate-id={rate_row.id}
            >
              <span class="rate-num">{rate_row.rate}</span>
              <span class="rate-unit">{secondary_currency}</span>
              <svg
                class="edit-icon"
                viewBox="0 0 24 24"
                width="12"
                height="12"
                fill="none"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                <path d="m15 5 4 4" />
              </svg>
            </button>
          {:else}
            <span
              class="rate-value"
              data-rate={rate_row.rate}
              data-rate-id={rate_row.id}
            >
              <span class="rate-num">{rate_row.rate}</span>
              <span class="rate-unit">{secondary_currency}</span>
            </span>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* 容器: 仅负责外边距 (variant 决定) */
  .currency-meta {
    margin: var(--space-2) 0 var(--space-4);
  }
  .currency-meta--compact {
    margin: 0 0 var(--space-3);
  }

  /* v0.3.18 #53 (PO msg 10:49 #6542): 单币种 pill 缩小 (PO 反馈「比例有问题,
   * 缩成一个小的即可」).
   *  - padding 6px → 2px (上下), 12-18px → 8-12px (左右)
   *  - font-size 11-13px → 10-12px
   *  - backdrop-filter blur 20px → 12px
   *  - inset highlight 0.6 → 0.4
   *  - box-shadow indigo 外阴影 0.08 → 0.04
   *  - 整体高度 ~24-28px, 跟双币种 Row 1 (.currency-pill-row) 高度对齐
   *  - 背景色不变 (保留跟双币种一致的 indigo gradient glass language)
   *  - 保留 border-radius 999px (pill 形状)
   *
   *  v0.3.18 #53 (PO msg 10:49 #6542): 单币种 + owner 时 pill 是 <button>,
   *  跟双币种 .currency-bar (玻璃) 同款语言; hover/active 加 bg 加深 + 微缩放
   *  让用户感知「可点」. focus-visible 也加 outline (a11y).
   *
   *  v0.3.18 #64 (PO #6859 拍板 CurrentResize — 单币种 pill 仅调整大小, 形态不动):
   *    - padding 6px 12px → 10px 18px (变大让 chip 视觉权重跟双币种 .currency-bar 平衡).
   *    - font-size 13px → 15px (跟双币种 .currency-bar 12px 形成层级但更显眼).
   *    - min-height 24px → 36px (iOS touch target 友好, 接近 44pt).
   *    - border 1px → 1.5px solid (跟外阴影 0.06 配合, 边缘更清晰).
   *    - outer shadow 0 1px 4px rgba(99,102,241,0.04) → 0 2px 8px rgba(99,102,241,0.06).
   *    - **不**改: gradient 角度 + alpha + saturate + blur + border-radius + 点击行为. */
  .currency-pill-row--single {
    /* 居中 + 上下 margin (跟原 .currency-pill-row 同款) */
    display: inline-flex;
    justify-content: center;
    align-items: center;
    flex-wrap: nowrap;
    gap: clamp(3px, 1.2vw, 6px);
    margin: 6px auto;
    padding: 10px 18px;
    width: fit-content;
    max-width: calc(100% - 32px);
    font-size: 15px;
    line-height: 1.4;
    color: var(--gray-700);
    overflow: hidden;
    min-height: 36px;

    background: linear-gradient(
      135deg,
      rgba(99, 102, 241, 0.10) 0%,
      rgba(59, 130, 246, 0.08) 100%
    );
    backdrop-filter: saturate(200%) blur(12px);
    -webkit-backdrop-filter: saturate(200%) blur(12px);

    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.4),
      inset 0 -1px 0 rgba(0, 0, 0, 0.03),
      0 2px 8px rgba(99, 102, 241, 0.06);

    border-radius: 999px;
    border: 1.5px solid rgba(99, 102, 241, 0.15);
  }

  @supports not (backdrop-filter: blur(1px)) {
    .currency-pill-row--single {
      background: rgba(99, 102, 241, 0.18);
    }
  }

  /* v0.3.18 #53: clickable variant — single pill rendered as a button
   * (replaces the previous <div> for owner case). Adds cursor + hover/active
   * feedback without changing the glass surface (so the read-only and
   * clickable variants look almost identical at rest, only differ on hover). */
  button.currency-pill-row--single {
    appearance: none;
    cursor: pointer;
    font: inherit;
    color: inherit;
    transition:
      background 150ms ease,
      box-shadow 150ms ease,
      transform 100ms ease;
  }
  button.currency-pill-row--single:hover {
    background: linear-gradient(
      135deg,
      rgba(99, 102, 241, 0.16) 0%,
      rgba(59, 130, 246, 0.13) 100%
    );
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.55),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04),
      0 2px 6px rgba(99, 102, 241, 0.08);
  }
  button.currency-pill-row--single:active {
    transform: scale(0.97);
  }
  button.currency-pill-row--single:focus-visible {
    outline: 2px solid var(--accent-500, #3b82f6);
    outline-offset: 2px;
  }

  /* v0.3.18 #53: "+" icon next to the primary chip — glass-tinted
   * indigo so it visually says "click to add another". Sized to fit
   * inside the shrunk pill (~12x12 SVG, same line-height as chip). */
  .add-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    color: var(--accent-700, #4338ca);
    flex-shrink: 0;
    margin-left: 1px;
  }

  /* v0.3.17 #36fix: 外层 .currency-bar (双币种 case 唯一 pill 视觉).
   *   - flex-direction column 内部装 Row 1 + Row 2, 形成「1 个胶囊里有 2 行」视觉.
   *   - fit-content 居中, 蓝色 accent 渐变 + 玻璃 material (跟原 Row 1 同款).
   *   - 内边距偏紧, 让 Row 1 / Row 2 视觉上「贴合」成 1 个 unit.
   *
   *   v0.3.17 #40 (PO msg 16:24): 整 bar 高度太宽 + 编辑/普通态高度不一致真修.
   *   - padding 6px → 4px (上下各 4px = 8px, 比原 12px 省 4px).
   *   - gap Row 1 → Row 2 2px (原 4px), 更紧凑的视觉 unit.
   *   - 加 gap: 2px 取代 .rate-row margin-top: 4px — 统一管理 Row 间 spacing.
   *   - min-height 保证最小 unit 高度 (44px) iOS tap target 还合理.
   *   - 单币种 .currency-pill-row--single 不动 (已经 fit-content 一行不需改).
   *
   *   v0.3.18 #43 (PO msg 17:43 #6401 拍板, 反 #40 不彻底): 整 bar 高度压到 ~40px 真修.
   *   - padding 4px → 2px (上下各 2px = 4px, 比 v1 #40 再省 4px).
   *   - font-size clamp → 12px 固定 (Row 1 主币种 副币种 12px 已够读).
   *   - Row 1 + Row 2 都 min-height: 16px (之前 Row 1 无 min-height 跟 Row 2 20px 不齐).
   *   - Row 1 line-height 1.4 → 1.2 (跟 Row 2 同高 16, 视觉 unit 一致).
   *   - rate-input height 20 → 16, line-height 18 → 14 (跟 Row 2 同高).
   *   - rate-button min-height 20 → 16, 加 line-height 14 (跟 rate-input 内容视觉同高).
   *   实测 (414x896): BAR ~40px (was 48.8px), normal/edit 两态 16px 同高. */
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

    /* iOS27 Liquid Glass (跟原 Row 1 同款蓝色 accent 渐变) */
    background: linear-gradient(
      135deg,
      rgba(99, 102, 241, 0.10) 0%,
      rgba(59, 130, 246, 0.08) 100%
    );
    backdrop-filter: saturate(200%) blur(20px);
    -webkit-backdrop-filter: saturate(200%) blur(20px);

    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.6),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04),
      0 1px 4px rgba(99, 102, 241, 0.08);

    border-radius: 999px;
    border: 1px solid rgba(99, 102, 241, 0.15);
  }

  @supports not (backdrop-filter: blur(1px)) {
    .currency-bar {
      background: rgba(99, 102, 241, 0.18);
    }
  }

  /* v0.3.17 #36fix: 内部 .currency-pill-row (Row 1 — 货币对) 退化为分隔行.
   *   不再有 bg / border-radius / border — 跟外层 .currency-bar 共享同一玻璃基底.
   *   仅通过 width: 100% 撑满 bar, 内部 3 chip 居中. */
  /* v0.3.18 #43: min-height 16px 跟 .rate-row 对齐, 保证两行视觉同高 unit */
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
  /* Row 1 蓝色 accent 提示 (PO 蓝色意图保留): 主币种 chip 强调更深 accent-700 */
  .currency-chip.primary {
    background: transparent;
    color: var(--accent-700, #4338ca);
  }
  .currency-chip.secondary {
    background: transparent;
    color: var(--gray-700);
  }

  .currency-arrow {
    color: var(--accent-500, #6366f1);
    font-size: clamp(0.75rem, 2.8vw, 0.875rem);
    font-weight: 600;
    flex-shrink: 0;
  }

  /* v0.3.17 #36fix: 内部 .rate-row (Row 2 — 汇率 + 编辑) 同样退化为分隔行.
   *   视觉副标题感: 字号略小 (sub-clamp), 颜色 gray-600 (比 Row 1 略淡).
   *   跟 Row 1 之间用 margin-top 4px 拉开 (无 hairline / 无 divider, 纯呼吸感).
   *
   *   v0.3.17 #40 (PO msg 16:24): 编辑态 (rate-input height 20px) vs 普通态
   *   (rate-button text-only ~14px) 高度不一致真修.
   *   - min-height: 20px 让普通态撑到跟编辑态一样高 (rate-input height 20px).
   *   - align-items: baseline → center, vertical 居中 (text-only 跟 input 不同 baseline).
   *   - margin-top: 0 (原 4px), 改用 .currency-bar gap: 2px 统一 Row 间距.
   *
   *   v0.3.18 #43 (PO msg 17:43 拍板, 反 #40 不彻底): min-height 20 → 16 (跟 Row 1 同高).
   *   - font-size clamp → 11px 固定 (跟 Row 1 12px 形成视觉层级, 副标题感保留).
   *   - line-height 1.2 (继承 .currency-bar), 跟 Row 1 line-height 一致, 两行同高 unit. */
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

  /* Row 2 「1 CNY =」灰色标签 */
  .currency-rate-label {
    color: var(--gray-500);
    font-size: clamp(0.625rem, 2.4vw, 0.6875rem);
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* Row 2 数字 / 单位 (rate-num 数字黑, rate-unit accent 蓝) */
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
    color: var(--accent-700, #4338ca);
    letter-spacing: 0.02em;
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* v0.3.18 #43: align-items baseline → center (跟 .rate-button 单独块的 center 对齐,
     保证 .rate-value (普通不可编辑态) 内容跟 .rate-input 视觉同高, 切 normal/edit 时不跳). */
  .rate-button,
  .rate-value {
    display: inline-flex;
    align-items: center;
    gap: 0;
    font-variant-numeric: tabular-nums;
    color: var(--gray-900);
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* v0.3.18 #43: 加 min-height 16px + line-height 14 (覆盖全局 button min-height 44px).
     v0.3.17 #40 commit message 声称加了但实际漏了 — 当时没改, 导致 rate-button 仍继承全局
     base button 的 min-height: var(--touch-target) = 44px, 普通态 bar 撑高到 ~71px (vs 编辑态 49px).
     这次真修: min-height 16 跟 .rate-row + .rate-input 对齐, line-height 14 跟 .rate-input 一致,
     保证 rate-button 内容跟 rate-input 内容视觉同高 — 编辑态/普通态切换 pill 高度不变. */
  .rate-button {
    appearance: none;
    background: transparent;
    border: 0;
    padding: 0;
    margin: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 16px;
    line-height: 14px;
  }
  .rate-button:hover .rate-num {
    color: var(--accent-700, #4338ca);
  }
  .rate-button:hover .edit-icon {
    color: var(--accent-500);
  }
  .rate-button:focus-visible {
    outline: 2px solid var(--accent-500);
    outline-offset: 2px;
    border-radius: 4px;
  }

  .edit-icon {
    color: var(--accent-500);
    flex-shrink: 0;
  }

  /* v0.3.17 #21 (PO msg 13:51 item 5): 汇率 bar 编辑态重构。
     原版 .rate-input border 1px + padding 1px 5px + border-radius 4px (硬 rect)
     跟胶囊 pill 风格脱节, 编辑时整个 pill-row 高度突变 (从 ~32px 跳 ~40px),
     "很丑" (PO msg)。
     修法 (跟 pill 同高 + 玻璃感):
       - height 固定 20px (line-height 18 + padding 0), 跟 rate-button 18px text 同高,
         pill-row 高度不变
       - border-radius: 999px (跟 pill 一致), border 改成跟 pill 同款 accent 0.30
       - bg 改成 rgba(255,255,255,0.65) (跟 pill 玻璃同款半透明白)
       - inset highlight box-shadow (跟 pill 同款内高光)
       - focus 时 outline 不用双层 (border 自身加焦点感 + box-shadow ring) */
  .edit-host {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    line-height: 1;
  }
  /* v0.3.18 #43: height 20 → 16, line-height 18 → 14 (跟 Row 2 min-height 16 对齐)
     v0.3.18 #48 (PO msg 19:10 #6489): bg 0.65 → 0.35 (× 0.54 透明化)
     让 peach→rose→lavender 背景图透过来, 玻璃感真出. */
  .rate-input {
    appearance: none;
    height: 16px;
    line-height: 14px;
    padding: 0 8px;
    background: rgba(255, 255, 255, 0.35);
    border: 1px solid rgba(99, 102, 241, 0.30);
    border-radius: 999px;
    font-size: clamp(0.625rem, 2.4vw, 0.6875rem);
    font-family: inherit;
    font-variant-numeric: tabular-nums;
    color: var(--gray-900);
    min-width: 4em;
    max-width: 10em;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.7),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04);
    transition: border-color 150ms ease, box-shadow 150ms ease;
  }
  .rate-input:focus {
    outline: none;
    border-color: rgba(99, 102, 241, 0.55);
    /* v0.3.18 #48: focus bg 0.85 → 0.55 (跟新 base 0.35 同比例降级, focus 时仍 opaque 让用户清楚焦点) */
    background: rgba(255, 255, 255, 0.55);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.8),
      inset 0 -1px 0 rgba(0, 0, 0, 0.05),
      0 0 0 3px rgba(99, 102, 241, 0.15);
  }
  .rate-input:disabled {
    /* v0.3.18 #48: disabled 0.4 → 0.25 (跟新 base 0.35 比例降级, disabled 仍比 base 略暗) */
    background: rgba(255, 255, 255, 0.25);
    color: var(--gray-500);
    cursor: wait;
  }
  .rate-suffix {
    color: var(--gray-500);
    font-size: clamp(0.625rem, 2.4vw, 0.6875rem);
  }
  .rate-error {
    color: var(--error-500, #dc2626);
    font-size: clamp(0.625rem, 2.4vw, 0.6875rem);
    /* 320px edit-error 换行 case: 允许 error 单独占 1 行 */
    flex-basis: 100%;
    text-align: center;
    margin-top: 2px;
  }
</style>