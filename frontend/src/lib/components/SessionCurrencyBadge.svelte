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
-->
<script lang="ts">
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
</script>

<div
  class="currency-meta"
  class:currency-meta--compact={variant === 'settle'}
  data-sbc="currency-meta"
>
  {#if is_single}
    <!-- 单币种: 单 chip = 单 pill, 不需外层 bar wrapper (1 row = 1 pill 直接展示) -->
    <div class="currency-pill-row currency-pill-row--single">
      <span class="currency-chip primary">{primary_currency}</span>
    </div>
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

  /* v0.3.17 #36fix (PO msg 12:45 #6287 拍板): 单币种 case 保留单 chip pill 视觉
   *   — 1 个 row = 1 个 pill, 不需外层 bar wrapper. */
  .currency-pill-row--single {
    /* 居中 + 上下 margin (跟原 .currency-pill-row 同款) */
    display: flex;
    justify-content: center;
    align-items: center;
    flex-wrap: nowrap;
    gap: clamp(4px, 1.5vw, 8px);
    margin: 8px auto;
    padding: 6px clamp(12px, 3vw, 18px);
    width: fit-content;
    max-width: calc(100% - 32px);
    font-size: clamp(0.6875rem, 2.6vw, 0.8125rem);
    line-height: 1.4;
    color: var(--gray-700);
    overflow: hidden;

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
    .currency-pill-row--single {
      background: rgba(99, 102, 241, 0.18);
    }
  }

  /* v0.3.17 #36fix: 外层 .currency-bar (双币种 case 唯一 pill 视觉).
   *   - flex-direction column 内部装 Row 1 + Row 2, 形成「1 个胶囊里有 2 行」视觉.
   *   - fit-content 居中, 蓝色 accent 渐变 + 玻璃 material (跟原 Row 1 同款).
   *   - 内边距偏紧, 让 Row 1 / Row 2 视觉上「贴合」成 1 个 unit.
   *
   *   v0.3.17 #40 (PO msg 16:24): 整 bar 高度太宽 + 编辑/普通态高度不一致真修.
   *   - padding 6px → 4px (上下各 4px = 8px, 比原 12px 省 4px).
   *   - gap Row 1 → Row 2 2px (原 4px), 更紧凑的视觉 unit.
   *   - 加 `gap: 2px` 取代 .rate-row margin-top: 4px — 统一管理 Row 间 spacing.
   *   - min-height 保证最小 unit 高度 (44px) iOS tap target 还合理.
   *   - 单币种 .currency-pill-row--single 不动 (已经 fit-content 一行不需改). */
  .currency-bar {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    width: fit-content;
    max-width: calc(100% - 32px);
    margin: 8px auto;
    padding: 4px clamp(10px, 3vw, 16px);
    font-size: clamp(0.6875rem, 2.6vw, 0.8125rem);
    line-height: 1.4;
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
  .currency-pill-row {
    display: flex;
    justify-content: center;
    align-items: center;
    flex-wrap: nowrap;
    gap: clamp(4px, 1.5vw, 8px);
    width: 100%;
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
   *   - margin-top: 0 (原 4px), 改用 .currency-bar `gap: 2px` 统一 Row 间距. */
  .rate-row {
    display: flex;
    justify-content: center;
    align-items: center;
    flex-wrap: wrap;
    gap: clamp(4px, 1.5vw, 8px);
    width: 100%;
    min-height: 20px;
    padding: 0;
    margin: 0;
    font-size: clamp(0.625rem, 2.4vw, 0.75rem);
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

  .rate-button,
  .rate-value {
    display: inline-flex;
    align-items: baseline;
    gap: 0;
    font-variant-numeric: tabular-nums;
    color: var(--gray-900);
    white-space: nowrap;
    flex-shrink: 0;
  }

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
  .rate-input {
    appearance: none;
    height: 20px;
    line-height: 18px;
    padding: 0 8px;
    background: rgba(255, 255, 255, 0.65);
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
    background: rgba(255, 255, 255, 0.85);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.8),
      inset 0 -1px 0 rgba(0, 0, 0, 0.05),
      0 0 0 3px rgba(99, 102, 241, 0.15);
  }
  .rate-input:disabled {
    background: rgba(255, 255, 255, 0.4);
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