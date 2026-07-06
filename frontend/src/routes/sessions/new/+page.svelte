<script lang="ts">
  import { goto } from '$app/navigation';
  import { createSession, type CreateSessionInput } from '$api/sessions';
  import { loadSessions } from '$stores/sessions';
  import { loadUser } from '$stores/user';
  import { onMount } from 'svelte';

  // v0.2.2 (T08): mirror of backend SUPPORTED_CURRENCIES (sessions.py).
  // Kept in sync manually — BE is the source of truth and will 422 if
  // a non-whitelisted code is sent.
  const SUPPORTED_CURRENCIES: string[] = [
    'CNY', 'USD', 'THB', 'EUR', 'JPY', 'GBP', 'HKD', 'SGD', 'KRW', 'AUD'
  ];
  const DEFAULT_SECONDARY = 'USD';

  let name = '';
  // v0.2.2 multi-currency form state.
  let currencies: string[] = ['CNY'];
  let primary_currency = 'CNY';
  // One rate row per (from -> to) ordered pair; when currencies == 2
  // we render exactly one input. The reciprocal is auto-computed by
  // the BE so the FE doesn't need to send it.
  let rate = '';

  let busy = false;
  let error: string | null = null;
  let loading = true;

  // v0.3 (PRD §3.10): anonymous session creation is allowed.
  // The creator must join via the join-claim flow after creation.
  onMount(async () => {
    loading = false;
  });

  function addCurrency(code: string = DEFAULT_SECONDARY) {
    if (currencies.length >= 2) return;
    if (SUPPORTED_CURRENCIES.indexOf(code) < 0) return;
    if (currencies.indexOf(code) >= 0) return;
    currencies = [...currencies, code];
    primary_currency = code; // newly added -> default primary
  }

  function removeCurrency(code: string) {
    if (currencies.length <= 1) return;
    const next = currencies.filter(c => c !== code);
    currencies = next;
    // If we just removed the primary, fall back to the remaining one.
    if (primary_currency === code) {
      primary_currency = next[0];
    }
    rate = '';
  }

  async function handleCreate() {
    if (busy) return;
    error = null;
    const trimmed = name.trim();
    if (!trimmed) {
      error = '请输入 session 名字';
      return;
    }
    const input: CreateSessionInput = { name: trimmed };
    if (currencies.length === 2) {
      const from = currencies[0];
      const to = currencies[1];
      const rateNum = Number(rate);
      if (!rate || isNaN(rateNum) || rateNum <= 0) {
        error = '请填写大于 0 的汇率';
        return;
      }
      input.currencies = currencies;
      input.primary_currency = primary_currency;
      input.exchange_rates = [
        { from_currency: from, to_currency: to, rate: rate }
      ];
    }
    busy = true;
    try {
      const created = await createSession(input);
      await loadSessions();
      // v0.3 (PRD §3.10): creator must join via join-claim flow.
      // For logged-in users, they're already a member; redirect to session.
      // For anonymous creators, redirect to join page so they can claim a nickname.
      if (created.member_count && created.member_count > 0) {
        await goto('/sessions/' + created.id);
      } else {
        await goto('/sessions/' + created.id + '/join');
      }
    } catch (e: any) {
      const c = e?.code ?? '';
      if (c === 'not authenticated') {
        // This shouldn't happen in v0.3 (anonymous creation allowed),
        // but keep it for safety.
        await goto('/auth/login?next=/sessions/new', { replaceState: true });
        return;
      }
      error = e?.message ?? '创建失败';
    } finally {
      busy = false;
    }
  }
</script>

<section>
  <h2>新建 session</h2>
  <p class="muted">session = 一个记账本, 可以是旅行 / 合租 / 聚餐...</p>

  {#if loading}
    <p>正在检查登录状态...</p>
  {:else}
    <div class="stack" style="max-width: 480px;">
      <div>
        <label class="label" for="name">名字</label>
        <input id="name" type="text" bind:value={name} placeholder="例: 2026 曼谷之旅" maxlength="200" />
      </div>

      <div class="currency-section">
        <span class="label" id="currency-label">币种</span>
        <div class="currency-chips" role="group" aria-labelledby="currency-label">
          {#each currencies as code (code)}
            <span class="currency-chip">
              {code}
              {#if currencies.length > 1}
                <button
                  type="button"
                  class="remove-currency"
                  aria-label={'移除 ' + code}
                  on:click={() => removeCurrency(code)}
                >×</button>
              {/if}
            </span>
          {/each}
          {#if currencies.length < 2}
            <select
              class="add-currency-select"
              on:change={(e) => {
                const target = e.target as HTMLSelectElement;
                const code = target.value;
                if (code) {
                  addCurrency(code);
                  target.value = '';
                }
              }}
            >
              <option value="">+ 添加第二种币种</option>
              {#each SUPPORTED_CURRENCIES.filter(c => currencies.indexOf(c) < 0) as code}
                <option value={code}>{code}</option>
              {/each}
            </select>
          {/if}
        </div>
      </div>

      {#if currencies.length === 2}
        <div class="rate-section">
          <label class="label" for="primary">主币种 (结算汇总)</label>
          <div class="currency-chips" role="radiogroup" aria-label="主币种">
            {#each currencies as code (code)}
              <button
                type="button"
                class="currency-chip"
                class:active={primary_currency === code}
                role="radio"
                aria-checked={primary_currency === code}
                on:click={() => (primary_currency = code)}
              >
                {code}
              </button>
            {/each}
          </div>

          <label class="label" for="rate">
            1 {currencies[0]} = ? {currencies[1]}
          </label>
          <input
            id="rate"
            type="number"
            step="0.00000001"
            min="0"
            bind:value={rate}
            placeholder="0.2150"
            required
          />
          <p class="muted hint">
            双向汇率由系统自动换算 (1 / 上方数值).
          </p>
        </div>
      {/if}

      <button class="primary" on:click={handleCreate} disabled={busy}>
        {busy ? '创建中...' : '创建'}
      </button>
      {#if error}
        <div class="error">{error}</div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .currency-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }
  .currency-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    background: rgba(99, 102, 241, 0.08);
    border: 1px solid rgba(99, 102, 241, 0.3);
    border-radius: 999px;
    padding: 0.25rem 0.75rem;
    font-weight: 500;
    font-size: 0.875rem;
    color: #4f46e5;
    cursor: default;
  }
  button.currency-chip {
    cursor: pointer;
    background: rgba(99, 102, 241, 0.04);
    border-color: rgba(99, 102, 241, 0.2);
  }
  button.currency-chip.active {
    background: #6366f1;
    color: white;
    border-color: #6366f1;
  }
  .remove-currency {
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 1rem;
    padding: 0 0.25rem;
    line-height: 1;
  }
  .add-currency-select {
    background: transparent;
    border: 1px dashed rgba(99, 102, 241, 0.4);
    border-radius: 999px;
    padding: 0.25rem 0.75rem;
    color: #6366f1;
    cursor: pointer;
    font-size: 0.875rem;
  }
  .rate-section,
  .currency-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .hint {
    font-size: 0.75rem;
  }
</style>
