<!--
  SessionCurrencyBadge.svelte — v0.3.16 #6 currency meta redesign (PO msg 18:16 CST 拍板)
  形态: Designer 方案 A — Compact pill row
        - 单行胶囊 `CNY ⇄ THB · 1 CNY = 4.6512` (主币种 chip 蓝色 accent, 副币种 chip 灰底)
        - 汇率数字 + owner 蓝色铅笔 (Lucide edit SVG 12x12)
        - 单币种 session 退化为单 chip `[CNY]`
        - 不喧宾夺主: 13px 字号, color var(--gray-700), padding 4px 0
  视觉 token 全部引用 v0.1.3 app.css, 不新增 token。
  inline edit 逻辑 (editing / startEdit / commitEdit / handleEditKeydown) 保持不变。
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
    <div class="currency-pill-row currency-pill-row--single">
      <span class="currency-chip primary">{primary_currency}</span>
    </div>
  {:else}
    <div class="currency-pill-row">
      <span class="currency-chip primary">{primary_currency}</span>
      <span class="currency-arrow" aria-hidden="true">⇄</span>
      <span class="currency-chip secondary">{secondary_currency}</span>
      {#if show_rate && rate_row}
        <span class="currency-sep" aria-hidden="true">·</span>
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

  /* Compact pill row: 单行胶囊 CNY ⇄ THB · 1 CNY = 4.6512 (v0.3.16 #7: iOS27 Liquid Glass + 居中) */
  .currency-pill-row {
    /* 居中 + 上下 margin */
    display: flex;
    justify-content: center;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin: 8px auto 16px;
    padding: 6px 14px;
    width: fit-content;
    max-width: calc(100% - 32px);
    font-size: 13px;
    line-height: 1.4;
    color: var(--gray-700);

    /* iOS 27 Liquid Glass — 温和版 (蓝色 accent 渐变, saturate 200% + blur 20px) */
    background: linear-gradient(
      135deg,
      rgba(99, 102, 241, 0.10) 0%,
      rgba(59, 130, 246, 0.08) 100%
    );
    backdrop-filter: saturate(200%) blur(20px);
    -webkit-backdrop-filter: saturate(200%) blur(20px);

    /* 玻璃分层 — 顶部高光 + 底部 hairline + 软外阴影 */
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.6),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04),
      0 1px 4px rgba(99, 102, 241, 0.08);

    border-radius: 999px; /* 完整胶囊 (pill shape) */
    border: 1px solid rgba(99, 102, 241, 0.15);
  }

  /* Safari iOS < 18 fallback (无 backdrop-filter): 用更深不透明 bg 兜底 */
  @supports not (backdrop-filter: blur(1px)) {
    .currency-pill-row {
      background: rgba(99, 102, 241, 0.18);
    }
  }

  /* 内部 chip 透明融入胶囊 (胶囊已有 bg) */
  .currency-chip {
    display: inline-flex;
    align-items: center;
    padding: 0;
    background: transparent;
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--gray-800);
    letter-spacing: 0.02em;
  }
  .currency-chip.primary {
    background: transparent;
    color: var(--accent-700, #4338ca); /* 主币种更深 */
  }
  .currency-chip.secondary {
    background: transparent;
    color: var(--gray-700);
  }

  .currency-arrow {
    color: var(--accent-500, #6366f1);
    font-size: 14px;
    font-weight: 600;
  }

  .currency-sep {
    color: var(--gray-400);
    margin: 0 -2px;
    opacity: 0.5;
  }

  .currency-rate-label {
    color: var(--gray-500);
    font-size: 12px;
  }

  /* 数字 + 单位分行 (rate-num 数字黑, rate-unit accent 蓝) */
  .rate-num {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: var(--gray-900);
  }
  .rate-unit {
    margin-left: 3px;
    font-size: 11px;
    font-weight: 500;
    color: var(--accent-700, #4338ca);
    letter-spacing: 0.02em;
  }

  .rate-button,
  .rate-value {
    display: inline-flex;
    align-items: baseline;
    gap: 0;
    font-variant-numeric: tabular-nums;
    color: var(--gray-900);
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
    font-size: 12px;
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
    font-size: 11px;
  }
  .rate-error {
    color: var(--error-500, #dc2626);
    font-size: 11px;
  }
</style>
