<!--
  SessionCurrencyBadge.svelte — v0.3.14 (PRD §3.14.1 + §3.14.2)
  位置: session 标题下方 (设计推荐 4 条理由见 design_output.md 任务 A 第 1 节)
  形态: dl-like grid, 单/双币种切换, 汇率可 inline edit (双币种 + owner)
  视觉 token 全部引用 v0.1.3 app.css, 不新增 token。
  TODO (§3.14.2): 点汇率 → 切 input → Enter/blur 调 PATCH → onRateChange (reload page)
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
    <div class="row">
      <span class="label">币种</span>
      <span class="value">{currencies[0]}</span>
    </div>
  {:else}
    <div class="row">
      <span class="label">主币种</span>
      <span class="value">{primary_currency}</span>
    </div>
    <div class="row">
      <span class="label">副币种</span>
      <span class="value">{secondary_currency}</span>
    </div>
    {#if show_rate && rate_row}
      <div class="row">
        <span class="label">汇率</span>
        {#if editing}
          <span class="value edit-host">
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
            <span class="rate-suffix">({secondary_currency}/{primary_currency})</span>
            {#if edit_error}
              <span class="rate-error" role="alert">{edit_error}</span>
            {/if}
          </span>
        {:else}
          {#if editable}
            <button
              type="button"
              class="value value-button editable"
              on:click={startEdit}
              aria-label={`编辑汇率 ${rate_row.rate}`}
              data-rate={rate_row.rate}
              data-rate-id={rate_row.id}
            >
              {rate_row.rate}
            </button>
          {:else}
            <span
              class="value"
              data-rate={rate_row.rate}
              data-rate-id={rate_row.id}
            >
              {rate_row.rate}
            </span>
          {/if}
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .currency-meta {
    margin: var(--space-2) 0 var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .currency-meta--compact {
    margin: 0 0 var(--space-3);
  }
  .row {
    display: grid;
    grid-template-columns: 60px 1fr;
    align-items: baseline;
    gap: var(--space-3);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
  }
  .label {
    color: var(--gray-500);
    font-weight: var(--font-weight-normal);
  }
  .value {
    color: var(--gray-700);
    font-weight: var(--font-weight-medium);
    font-variant-numeric: tabular-nums;
  }
  .value.editable {
    cursor: pointer;
    text-decoration: underline;
    text-decoration-style: dotted;
    text-decoration-color: var(--gray-400);
    text-underline-offset: 3px;
  }
  .value.editable:hover {
    color: var(--accent-700);
    text-decoration-color: var(--accent-500);
  }
  .value.editable:focus-visible {
    outline: 2px solid var(--accent-500);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }
  /* value-button: 可点击的 button, 视觉跟普通 value 一致 (默认 button 样式清除) */
  .value-button {
    appearance: none;
    background: transparent;
    border: 0;
    padding: 0;
    margin: 0;
    text-align: left;
    font: inherit;
    color: inherit;
    font-variant-numeric: tabular-nums;
  }
  .edit-host {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .rate-input {
    appearance: none;
    background: var(--color-bg, #fff);
    border: 1px solid var(--gray-300);
    border-radius: var(--radius-sm);
    padding: 2px 6px;
    font-size: var(--font-size-sm);
    font-family: inherit;
    font-variant-numeric: tabular-nums;
    color: var(--gray-900);
    min-width: 5em;
    max-width: 12em;
  }
  .rate-input:focus {
    outline: 2px solid var(--accent-500);
    outline-offset: 1px;
    border-color: var(--accent-500);
  }
  .rate-input:disabled {
    background: var(--gray-100);
    color: var(--gray-500);
    cursor: wait;
  }
  .rate-suffix {
    color: var(--gray-500);
    font-weight: var(--font-weight-normal);
    font-size: var(--font-size-xs, 12px);
  }
  .rate-error {
    color: var(--error-500, #dc2626);
    font-size: var(--font-size-xs, 12px);
    font-weight: var(--font-weight-normal);
  }
</style>
