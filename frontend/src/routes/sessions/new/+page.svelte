<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { user } from "$stores/user";
  import { loadUser } from "$stores/user";
  import { toast } from "$stores/toast";

  let step = 1;
  let sessionName = "";
  let memberCount = 1;
  let nicknames: string[] = [""];
  let busy = false;
  let loading = true;
  const LS_PREFIX = "sbc.actingAs.";

  // §3.11.10: currency state (step 4, logged-in only)
  let currencyMode: "single" | "dual" = "single";
  let primaryCurrency = "CNY";
  let secondaryCurrency = "";
  // §3.11 收尾 (PO 11:38 拍板): dual mode 必填汇率.
  // BE v0.2.1 (currencies=2 时 exchange_rates 必填, 否则 422).
  // 用 string 输入框, 提交时 parseFloat. 允许中间空白态.
  let exchangeRate: string = "";

  // anon 也展示 step 3 币种选择, 但限制单币种 (PO msg 19:56)
  $: isAnon = $user === null;
  $: showCurrencyStep = true;

  onMount(async () => {
    await loadUser();
    loading = false;
    // v0.3.15 (PO #4861) 修 n+1 bug: nicknames[0] 默认用 placeholder 字符串
    // - 登录态: "你" → FE slice(1) 排除 (跟 §3.11 75cbdec 一致)
    // - anon 态:  "我" → FE 改用同一 slice(1) 逻辑 (见 改动 2), BE dedupe 处理 "我" placeholder
    // 这样两条路径都用 nicknames.slice(1), nicknames[0] 是 placeholder 字符串 (永远**不**发给 BE)
    if (nicknames[0] === "") {
      nicknames = [$user !== null ? "你" : "我"];
    }
  });

  $: nameValid = sessionName.trim().length > 0;

  $: {
    const target = memberCount;
    if (nicknames.length < target) {
      // Bug fix (反 #1 教训: pre-existing Svelte 5 legacy `$:` + push 不触发响应性):
      // 用赋值 (而非 mutation) 让 Svelte 重新分配数组引用, 模板 each 块重渲.
      nicknames = [...nicknames, ...Array(target - nicknames.length).fill("")];
    } else if (nicknames.length > target) {
      nicknames = nicknames.slice(0, target);
    }
  }

  $: nicknamesValid = nicknames.every((n) => n.trim().length > 0);

  $: exchangeRateValid =
    currencyMode === "single" || parseFloat(exchangeRate) > 0;

  $: currencyValid =
    primaryCurrency.length > 0 &&
    (currencyMode === "single" ||
      (secondaryCurrency.length > 0 && parseFloat(exchangeRate) > 0));

  function adjustCount(delta: number) {
    const next = memberCount + delta;
    if (next >= 1 && next <= 20) memberCount = next;
  }

  function goNext() {
    if (step === 1 && nameValid) {
      step = 2;
    } else if (step === 2) {
      step = 3;
    } else if (step === 3 && showCurrencyStep) {
      step = 4;
    }
  }

  async function handleCreate() {
    if (busy || !nicknamesValid) return;
    if (showCurrencyStep && !currencyValid) return;
    busy = true;
    try {
      const currencies = currencyMode === "single"
        ? [primaryCurrency]
        : [primaryCurrency, secondaryCurrency];

      // §3.11 dual mode 必传 exchange_rates (BE v0.2.1 model_validator).
      // primary → secondary 单向即可, BE 会自动补 reciprocal.
      const exchangeRates = showCurrencyStep && currencyMode === "dual"
        ? [
            {
              from_currency: primaryCurrency,
              to_currency: secondaryCurrency,
              rate: parseFloat(exchangeRate),
            },
          ]
        : [];

      const createRes = await fetch("/api/sessions", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: sessionName.trim(),
          // v0.3.15 (PO #4879) 修 nicknames[0] 改名不生效:
          // anon path: 全发 (含 nicknames[0] — BE 用 nicknames[0] 作 owner placeholder name,
          //                        dedupe 自己跳过, 总数 = wizard count).
          // login path: nicknames[0] 是 informational "你", 不是实际 nickname,
          //             BE 用 user.default_name 作 owner. 不 slice 会让 nicknames[0]="你"
          //             被 dedupe (BE 看见 "你" 比 user.default_name 短就跳过),
          //             但 nickname[0]="你" 也不会**重**复加为 member (BE dedupe "你").
          //             实际数字会 = 1 (owner user.default_name) + (n - 1) 同伴 (dedupe 跳过 "你").
          //             等等 — 等等 — 登录态 nicknames[0]="你" 是 placeholder, 但其他 nicknames 是同伴.
          //             BE dedupe 只跳过 "你", 同伴们正常加 — 总数 = 1 + (n - 1) = n ✓
          //             所以登录态也**不**需要 slice!
          member_nicknames: nicknames.map((n) => n.trim()).filter((n) => n.length > 0),
          currencies,
          primary_currency: primaryCurrency,
          exchange_rates: exchangeRates,
        }),
      });
      if (!createRes.ok) {
        const body = await createRes.json().catch(() => ({}));
        throw new Error(body?.detail?.error ?? "HTTP " + createRes.status);
      }
      const data = (await createRes.json()) as { id: number; created_member_ids: number[] };
      const sid = data.id;
      const memberIds = data.created_member_ids ?? [];
      if ($user === null && memberIds.length > 0) {
        const claimRes = await fetch("/api/sessions/" + sid + "/join-claim", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "claim", session_member_id: memberIds[0] }),
        });
        if (!claimRes.ok) {
          const body = await claimRes.json().catch(() => ({}));
          throw new Error(body?.detail?.error ?? "认领失败，请重试");
        }
        const claimData = (await claimRes.json()) as { session_member_id: number; nickname_secret: string | null };
        if (claimData.nickname_secret && typeof window !== "undefined") {
          localStorage.setItem(LS_PREFIX + sid, claimData.nickname_secret);
        }
      }
      await goto("/sessions/" + sid, { replaceState: true });
    } catch (e: any) {
      // v0.3.15 (PO #4807): 错误统一走 Toast. wizard step 3 提交失败时
      // user 保留当前 step 状态, 可改完再点确认.
      toast.error(e?.message ?? "创建失败，请重试");
      busy = false;
    }
  }
</script>

<svelte:head>
  <title>新建账本</title>
</svelte:head>

{#if loading}
  <div class="loading-screen">
    <p class="muted">加载中…</p>
  </div>
{:else}
  <div class="wizard">
    <div class="progress">
      <span class="dot" class:active={step >= 1} class:done={step > 1} />
      <span class="dot" class:active={step >= 2} class:done={step > 2} />
      <span class="dot" class:active={step >= 3 && showCurrencyStep} class:done={step > 3 && showCurrencyStep} />
      <span class="dot" class:active={step >= 4} class:done={step > 4} />
    </div>
    <p class="step-label">
      {#if step === 1}第一步{/if}
      {#if step === 2}第二步{/if}
      {#if step === 3}第三步{/if}
    </p>

    {#if step === 1}
      <div class="step-panel">
        <h2 class="step-title">给你的账本起个名字</h2>
        <p class="step-hint">比如：曼谷之旅 2026 / 毕业聚餐 / 合租记账</p>
        <div class="field">
          <input id="session-name" type="text" bind:value={sessionName}
            placeholder="比如：曼谷之旅 2026" maxlength="200"
            onkeydown={(e) => e.key === "Enter" && nameValid && goNext()}
            autofocus />
        </div>
        <button class="btn-next" onclick={goNext} disabled={!nameValid}>下一步</button>
      </div>
    {/if}

    {#if step === 2}
      <div class="step-panel">
        <h2 class="step-title">一共有多少人？</h2>
        <p class="step-hint">别担心，稍后也可添加更多成员</p>
        <div class="count-row">
          <button class="count-btn" onclick={() => adjustCount(-1)} disabled={memberCount <= 1} aria-label="减少一人">-</button>
          <span class="count-display">{memberCount}</span>
          <button class="count-btn" onclick={() => adjustCount(1)} disabled={memberCount >= 20} aria-label="增加一人">+</button>
        </div>
        <p class="count-hint">{memberCount} 人</p>
        <div class="nickname-list" style="margin-top: 1.5rem;">
          {#each nicknames as nick, i (i)}
            <div class="nickname-row">
              <span class="nick-label">{i === 0 ? "你" : "同伴 " + i}</span>
              <input type="text" bind:value={nicknames[i]}
                placeholder={i === 0 ? "你的名字" : "同伴 " + i + " 的名字"}
                maxlength="50"
                onkeydown={(e) => e.key === "Enter" && i === nicknames.length - 1 && nicknamesValid && goNext()} />
            </div>
          {/each}
        </div>
        <div class="step-nav">
          <button class="btn-back" onclick={() => (step = 1)}>上一步</button>
          <button class="btn-next" onclick={goNext} disabled={!nicknamesValid}>
            {showCurrencyStep ? '下一步' : '确认创建'}
          </button>
        </div>
      </div>
    {/if}

    {#if step === 3 && showCurrencyStep}
      <!-- PO 14:01: 撤 reserved blank "准备选择币种" step. step 3 直接是币种选择. -->
      <div class="step-panel">
        <h2 class="step-title">使用什么币种？</h2>
        <p class="step-hint">选择单币种或双币种结算</p>

        <!-- 模式切换：单币 vs 双币 -->
        <div class="currency-mode-row" role="radiogroup" aria-label="币种模式">
          <button type="button" class="mode-pill" class:active={currencyMode === 'single'}
            onclick={() => { currencyMode = 'single'; secondaryCurrency = ''; exchangeRate = ''; }}>
            单一币种
          </button>
          {#if !isAnon}
            <button type="button" class="mode-pill" class:active={currencyMode === 'dual'}
              onclick={() => currencyMode = 'dual'}>
              双币种
            </button>
          {/if}
        </div>

        <!-- 主币种（必选） -->
        <div class="currency-section">
          <label class="currency-label">主币种（必选）</label>
          <div class="currency-pills">
            {#each ["CNY", "USD", "EUR", "JPY", "THB"] as ccy}
              <button type="button" class="currency-pill" class:active={primaryCurrency === ccy}
                onclick={() => {
                  // 主币种切换 → 清空副币种 + 汇率 (币种对换了 rate 没意义).
                  primaryCurrency = ccy;
                  secondaryCurrency = '';
                  exchangeRate = '';
                }}>
                {ccy}
              </button>
            {/each}
          </div>
        </div>

        <!-- 副币种（双币时必选） -->
        {#if currencyMode === 'dual'}
          <div class="currency-section">
            <label class="currency-label">副币种（必选）</label>
            <div class="currency-pills">
              {#each ["CNY", "USD", "EUR", "JPY", "THB"] as ccy}
                {#if ccy !== primaryCurrency}
                  <button type="button" class="currency-pill" class:active={secondaryCurrency === ccy}
                    onclick={() => secondaryCurrency = ccy}>
                    {ccy}
                  </button>
                {/if}
              {/each}
            </div>
          </div>

          <!-- §3.11 收尾 (PO 11:38 拍板): dual mode 必填汇率.
               BE v0.2.1: currencies=2 时 exchange_rates 必填, 否则 422.
               主币种切换时已清空, 副币种切换时**不**清 (用户可能想换币种再改 rate, 简化 UX). -->
          <div class="currency-section">
            <label class="currency-label" for="exchange-rate-input">
              汇率 (1 {primaryCurrency} = ? {secondaryCurrency || '副币种'})
            </label>
            <input
              id="exchange-rate-input"
              type="number"
              step="any"
              min="0"
              bind:value={exchangeRate}
              placeholder="例如 0.14"
              class="exchange-rate-input"
            />
            <p class="exchange-rate-hint">
              {#if !secondaryCurrency}
                请先选副币种
              {:else if !exchangeRate || parseFloat(exchangeRate) <= 0}
                请输入大于 0 的汇率
              {:else}
                1 {primaryCurrency} = {parseFloat(exchangeRate).toFixed(4)} {secondaryCurrency}
              {/if}
            </p>
          </div>
        {/if}

        {#if isAnon}
          <p class="anon-currency-hint">需要多币种？账本创建后登录即可</p>
        {/if}

        <div class="step-nav" style="margin-top: 1.75rem;">
          <button class="btn-back" onclick={() => (step = 2)}>上一步</button>
          <button class="btn-confirm" onclick={handleCreate} disabled={!currencyValid || busy}>
            {busy ? '创建中…' : '确认创建'}
          </button>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .loading-screen { display: flex; align-items: center; justify-content: center; min-height: 50vh; }
  .wizard { max-width: 480px; margin: 0 auto; padding: 1.5rem 1rem; }
  .progress { display: flex; justify-content: center; gap: 0.5rem; margin-bottom: 1.25rem; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #e5e5e5; transition: background 0.3s, transform 0.3s; }
  .dot.active { background: #3b82f6; }
  .dot.done { background: #93c5fd; transform: scale(0.85); }
  .step-label { text-align: center; font-size: 0.8125rem; color: #737373; margin-bottom: 1.5rem; text-transform: uppercase; letter-spacing: 0.08em; }
  .step-panel { animation: slideIn 0.3s ease-out both; }
  @keyframes slideIn { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: translateX(0); } }
  .step-title { font-size: 1.5rem; font-weight: 700; color: #171717; margin: 0 0 0.375rem; line-height: 1.2; }
  .step-hint { font-size: 0.9rem; color: #737373; margin: 0 0 1.75rem; }
  .field { margin-bottom: 1.5rem; }
  input[type="text"] { width: 100%; padding: 0.875rem 1rem; border: 2px solid #e5e5e5; border-radius: 0.75rem; font-size: 1rem; background: #fff; transition: border-color 0.15s; box-sizing: border-box; }
  input[type="text"]:focus { outline: none; border-color: #3b82f6; }
  input[type="text"]::placeholder { color: #a3a3a3; }
  .btn-next, .btn-confirm { display: inline-flex; align-items: center; justify-content: center; width: 100%; min-height: 52px; padding: 0 1.5rem; background: #3b82f6; border: none; border-radius: 9999px; color: #fff; font-size: 1rem; font-weight: 600; cursor: pointer; transition: background 0.15s, transform 0.1s; letter-spacing: 0.01em; }
  .btn-next:hover:not(:disabled), .btn-confirm:hover:not(:disabled) { background: #2563eb; }
  .btn-next:active:not(:disabled), .btn-confirm:active:not(:disabled) { transform: scale(0.98); }
  .btn-next:disabled, .btn-confirm:disabled { opacity: 0.5; cursor: not-allowed; }
  .step-nav { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
  .step-nav .btn-next, .step-nav .btn-confirm { flex: 1; }
  .btn-back { display: inline-flex; align-items: center; justify-content: center; min-height: 52px; padding: 0 1.25rem; background: #fff; border: 2px solid #e5e5e5; border-radius: 9999px; color: #525252; font-size: 1rem; font-weight: 500; cursor: pointer; transition: border-color 0.15s, color 0.15s; }
  .btn-back:hover { border-color: #a3a3a3; color: #262626; }
  .count-row { display: flex; align-items: center; justify-content: center; gap: 2rem; margin-bottom: 0.75rem; }
  .count-btn { width: 56px; height: 56px; border-radius: 50%; border: 2px solid #e5e5e5; background: #fff; color: #262626; font-size: 1.5rem; font-weight: 600; cursor: pointer; transition: border-color 0.15s, background 0.15s; display: flex; align-items: center; justify-content: center; }
  .count-btn:hover:not(:disabled) { border-color: #3b82f6; background: #eff6ff; color: #3b82f6; }
  .count-btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .count-display { font-size: 3rem; font-weight: 700; color: #171717; min-width: 3rem; text-align: center; line-height: 1; }
  .count-hint { text-align: center; font-size: 0.9rem; color: #737373; margin: 0; }
  .nickname-list { display: flex; flex-direction: column; gap: 0.75rem; margin-bottom: 0.5rem; }
  .nickname-row { display: flex; align-items: center; gap: 0.75rem; }
  .nick-label { min-width: 52px; font-size: 0.875rem; font-weight: 600; color: #525252; }
  .nickname-row input { flex: 1; padding: 0.75rem 1rem; border: 2px solid #e5e5e5; border-radius: 0.75rem; font-size: 1rem; background: #fff; transition: border-color 0.15s; box-sizing: border-box; }
  .nickname-row input:focus { outline: none; border-color: #3b82f6; }
  .nickname-row input::placeholder { color: #a3a3a3; }
  .muted { color: #737373; }

  /* §3.11.10: currency step styles */
  .currency-mode-row { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
  .mode-pill { flex: 1; padding: 0.625rem 1rem; border: 2px solid #e5e5e5; border-radius: 9999px; background: #fff; color: #525252; font-size: 0.9rem; font-weight: 500; cursor: pointer; transition: border-color 0.15s, background 0.15s, color 0.15s; }
  .mode-pill:hover { border-color: #3b82f6; color: #3b82f6; }
  .mode-pill.active { border-color: #3b82f6; background: #eff6ff; color: #3b82f6; font-weight: 600; }
  .currency-section { margin-bottom: 1.25rem; }
  .currency-label { display: block; font-size: 0.8125rem; font-weight: 600; color: #525252; margin-bottom: 0.625rem; text-transform: uppercase; letter-spacing: 0.06em; }
  .currency-pills { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .currency-pill { padding: 0.5rem 1rem; border: 2px solid #e5e5e5; border-radius: 9999px; background: #fff; color: #525252; font-size: 0.875rem; font-weight: 500; cursor: pointer; transition: border-color 0.15s, background 0.15s, color 0.15s; }
  .currency-pill:hover { border-color: #3b82f6; color: #3b82f6; }
  .currency-pill.active { border-color: #3b82f6; background: #3b82f6; color: #fff; font-weight: 600; }

  /* §3.11 收尾: dual mode 汇率 input 样式 */
  .exchange-rate-input { width: 100%; padding: 0.75rem 1rem; border: 2px solid #e5e5e5; border-radius: 0.75rem; font-size: 1rem; background: #fff; transition: border-color 0.15s; box-sizing: border-box; }
  .exchange-rate-input:focus { outline: none; border-color: #3b82f6; }
  .exchange-rate-input::placeholder { color: #a3a3a3; }
  .exchange-rate-hint { font-size: 0.8125rem; color: #737373; margin: 0.5rem 0 0; min-height: 1.2em; }

  .anon-currency-hint {
    text-align: center;
    font-size: 0.875rem;
    color: var(--color-text-muted, #6b7280);
    margin-top: 1rem;
    padding: 0.75rem 1rem;
    background: #f5f5f5;
    border-radius: 0.75rem;
  }
</style>
