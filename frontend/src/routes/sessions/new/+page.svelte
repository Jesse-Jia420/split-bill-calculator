<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { user } from "$stores/user";
  import { loadUser } from "$stores/user";
  import { toast } from "$stores/toast";
  import IosSwitch from "$lib/components/IosSwitch.svelte";

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

  // v0.3.17 #32-D-4 (PO msg 01:18 #6116): IosSwitch 组件 bind:value={currencyMode},
  // 内部处理 disabled + select 逻辑. anon 切双币种由 .locked class + :disabled 处理 (视觉够明显).
  // 切到 single 时清空 secondaryCurrency + exchangeRate (避免 stale 数据):
  $: if (currencyMode === "single") {
    secondaryCurrency = "";
    exchangeRate = "";
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
      <span class="dot" class:active={step >= 3} class:done={step > 3} />
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
          <input id="session-name" class="glass-input" type="text" bind:value={sessionName}
            placeholder="比如：曼谷之旅 2026" maxlength="200"
            onkeydown={(e) => e.key === "Enter" && nameValid && goNext()}
            autofocus />
        </div>
        <!-- v0.3.17 #32-D-2 (PO msg 23:59 #6087): 按钮直接浮, 撤 .step-nav-area wrapper + border-top + bg gradient + 跨 step 上下文 hint -->
        <div class="step-nav">
          <button class="fab-wiz glass" type="button" aria-label="返回首页" onclick={() => goto(isAnon ? "/" : "/sessions")}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l9-8 9 8v10a2 2 0 0 1-2 2h-3v-7h-8v7H5a2 2 0 0 1-2-2V11z"/></svg>
          </button>
          <button class="fab-wiz primary" type="button" aria-label="下一步" onclick={goNext} disabled={!nameValid}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>
        </div>
      </div>
    {/if}

    {#if step === 2}
      <div class="step-panel">
        <h2 class="step-title">一共有多少人？</h2>
        <p class="step-hint">别担心，稍后也可添加更多成员</p>
        <div class="count-row">
          <button class="glass-pill count-btn" onclick={() => adjustCount(-1)} disabled={memberCount <= 1} aria-label="减少一人">-</button>
          <span class="count-display">{memberCount}</span>
          <button class="glass-pill count-btn" onclick={() => adjustCount(1)} disabled={memberCount >= 20} aria-label="增加一人">+</button>
        </div>
        <p class="count-hint">{memberCount} 人</p>
        <div class="nickname-list" style="margin-top: 1.5rem;">
          {#each nicknames as nick, i (i)}
            <div class="nickname-row">
              <span class="nick-label">{i === 0 ? "你" : "同伴 " + i}</span>
              <input class="glass-input" type="text" bind:value={nicknames[i]}
                placeholder={i === 0 ? "你的名字" : "同伴 " + i + " 的名字"}
                maxlength="50"
                onkeydown={(e) => e.key === "Enter" && i === nicknames.length - 1 && nicknamesValid && goNext()} />
            </div>
          {/each}
        </div>
        <div class="step-nav">
          <button class="fab-wiz glass" type="button" aria-label="上一步" onclick={() => (step = 1)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          </button>
          <button class="fab-wiz primary" type="button" aria-label="下一步" onclick={goNext} disabled={!nicknamesValid}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>
        </div>
      </div>
    {/if}

    {#if step === 3 && showCurrencyStep}
      <!-- PO 14:01: 撤 reserved blank "准备选择币种" step. step 3 直接是币种选择. -->
      <div class="step-panel">
        <h2 class="step-title">使用什么币种？</h2>
        <p class="step-hint">选择单币种或双币种结算</p>

        <!-- v0.3.17 #32-D-4 (PO msg 01:18 #6116): IosSwitch 组件 — thumb 动态宽度跟随 option 文字
             - bind:value 双向绑定 currencyMode
             - anon 双币种 disabled + .locked class (IosSwitch 内部处理, 不会切到 dual state)
             - thumb width 跟随 active option 实际宽度 (动态, 主币种汇总 (CNY) 这种长 label 也对得齐) -->
        <IosSwitch
          ariaLabel="币种模式"
          options={[
            { value: 'single', label: '单一币种' },
            { value: 'dual', label: '双币种', disabled: isAnon }
          ]}
          bind:value={currencyMode}
        />

        <!-- 主币种（必选） -->
        <div class="currency-section">
          <label class="currency-label">主币种（必选）</label>
          <div class="currency-pills">
            {#each ["CNY", "USD", "EUR", "JPY", "THB"] as ccy}
              <button type="button" class="glass-pill currency-pill" class:active={primaryCurrency === ccy}
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
                  <button type="button" class="glass-pill currency-pill" class:active={secondaryCurrency === ccy}
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
              class="glass-input"
              type="number"
              step="any"
              min="0"
              bind:value={exchangeRate}
              placeholder="例如 0.14"
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
          <p class="anon-currency-hint glass-card-soft">需要多币种？账本创建后登录即可</p>
        {/if}

        <div class="step-nav">
          <button class="fab-wiz glass" type="button" aria-label="上一步" onclick={() => (step = 2)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          </button>
          <button class="fab-wiz primary" type="button" aria-label="确认创建" onclick={handleCreate} disabled={!currencyValid || busy}>
            {#if busy}
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-width="2.5" opacity="0.3"/><path d="M21 12a9 9 0 0 1-9 9" stroke-width="2.5" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/></path></svg>
            {:else}
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>
            {/if}
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
  /* .dot 系列已迁到 app.css 全局 (.progress .dot) — v0.3.17 #27 */
  .step-label { text-align: center; font-size: 0.8125rem; color: #737373; margin-bottom: 1.5rem; text-transform: uppercase; letter-spacing: 0.08em; }
  .step-panel { animation: slideIn 0.3s ease-out both; }
  @keyframes slideIn { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: translateX(0); } }
  .step-title { font-size: 1.5rem; font-weight: 700; color: #171717; margin: 0 0 0.375rem; line-height: 1.2; }
  .step-hint { font-size: 0.9rem; color: #737373; margin: 0 0 1.75rem; }
  .field { margin-bottom: 1.5rem; }
  /* v0.3.17 #32-D (PO msg 23:44 #6063 拍板 D): 圆 ← → glass button 64×64 + 居中 (gap 56px)
     v0.3.17 #32-D-2 (PO msg 23:59 #6087): 撤 .step-nav-area wrapper + border-top + bg gradient
     + 撤 .step-nav-hint 跨 step 上下文 — 按钮直接浮, 顶部留 panel 自然间距 */
  .step-nav {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 56px;
    margin-top: 1.25rem;
  }
  .fab-wiz {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    cursor: pointer;
    border: 0.5px solid rgba(99, 102, 241, 0.25);
    padding: 0;
    transition: transform 150ms ease, box-shadow 150ms ease;
  }
  .fab-wiz:active { transform: scale(0.94); }
  .fab-wiz.glass {
    background: rgba(255, 255, 255, 0.55);
    color: var(--accent-700, #4338ca);
  }
  .fab-wiz.primary {
    background: linear-gradient(135deg, #6366f1, #818cf8);
    color: white;
    border-color: rgba(255, 255, 255, 0.5);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.6),
      0 6px 14px -3px rgba(99, 102, 241, 0.4),
      0 2px 4px -1px rgba(99, 102, 241, 0.15);
  }
  .fab-wiz svg {
    width: 28px;
    height: 28px;
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    fill: none;
    stroke: currentColor;
  }
  .count-row { display: flex; align-items: center; justify-content: center; gap: 2rem; margin-bottom: 0.75rem; }
  /* .count-btn 已用 .glass-pill 替代, 圆形覆盖保持 — v0.3.17 #27 */
  .count-btn {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    font-size: 1.5rem;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  /* v0.3.17 #28: 显式 hover/active 回退 — 修 mobile tap 后 :hover 黏住导致背景卡 0.18 alpha
     · 根因: app.css 全局 .glass-pill:hover { background 0.18 } 没有 @media 包裹,
             mobile (iOS Safari) tap 后 :hover 黏住直到下次 tap, 0.18 alpha 持续生效 (用户感觉「卡住」).
     · 修法:
       1. hover 反馈 (0.18 / translateY -1px) 只在 hover-capable 设备 (@media hover: hover) 生效.
       2. touch 设备 (@media hover: none) 用更高特异性 + !important 强制 idle 背景回到默认玻璃色 (0.10),
          覆盖 app.css 全局 .glass-pill:hover 在 touch 设备上的黏住效果.
       3. :active 短暂给深色反馈 (0.28 + scale 0.94), CSS transition 200ms 平滑过渡. */
  .count-btn:not(:disabled) {
    transition:
      background 200ms ease,
      transform 150ms ease,
      border-color 200ms ease;
  }
  @media (hover: hover) {
    .count-btn:not(:disabled):hover {
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.18) 0%, rgba(59, 130, 246, 0.15) 100%) !important;
      border-color: rgba(99, 102, 241, 0.22) !important;
      transform: translateY(-1px);
    }
  }
  /* touch 设备: idle 时强制背景回默认, 不被 .glass-pill:hover 全局规则覆盖 */
  @media (hover: none) {
    .count-btn:not(:disabled):not(:active) {
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.10) 0%, rgba(59, 130, 246, 0.08) 100%) !important;
      border-color: rgba(99, 102, 241, 0.15) !important;
      transform: none !important;
    }
  }
  .count-btn:not(:disabled):active {
    transform: scale(0.94);
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.28) 0%, rgba(59, 130, 246, 0.25) 100%) !important;
    border-color: rgba(99, 102, 241, 0.4) !important;
  }
  .count-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    transform: none !important;
    background: rgba(255, 255, 255, 0.55) !important;
    border-color: rgba(99, 102, 241, 0.18) !important;
  }
  .count-display { font-size: 3rem; font-weight: 700; color: #171717; min-width: 3rem; text-align: center; line-height: 1; }
  .count-hint { text-align: center; font-size: 0.9rem; color: #737373; margin: 0; }
  .nickname-list { display: flex; flex-direction: column; gap: 0.75rem; margin-bottom: 0.5rem; }
  .nickname-row { display: flex; align-items: center; gap: 0.75rem; }
  .nick-label { min-width: 52px; font-size: 0.875rem; font-weight: 600; color: #525252; }
  /* .nickname-row input 已用 .glass-input 替代 — v0.3.17 #27 */
  .muted { color: #737373; }

  /* v0.3.17 #32-D-4 (PO msg 01:18 #6116): .ios-switch 全套移到 IosSwitch.svelte
     scoped style (frontend/src/lib/components/IosSwitch.svelte).
     跨页面 (wizard step 3 + settle 个人视图) 共用同一组件, thumb 宽度跟随
     active option 实际宽度 (动态, 不再固定 50%). */

  /* §3.11.10: currency step styles */
  .currency-section { margin-bottom: 1.25rem; }
  .currency-label { display: block; font-size: 0.8125rem; font-weight: 600; color: #525252; margin-bottom: 0.625rem; text-transform: uppercase; letter-spacing: 0.06em; }
  .currency-pills { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  /* .currency-pill 已用 .glass-pill 替代 (默认) / .btn-primary 替代 (active) — v0.3.17 #27 */
  .currency-pill { padding: 0.5rem 1rem; font-size: 0.875rem; font-weight: 500; cursor: pointer; min-height: 40px; }

  /* §3.11 收尾: dual mode 汇率 input 样式 */
  /* .exchange-rate-input 已用 .glass-input 替代 — v0.3.17 #27 */
  .exchange-rate-hint { font-size: 0.8125rem; color: #737373; margin: 0.5rem 0 0; min-height: 1.2em; }

  /* anon 提示玻璃卡 — v0.3.17 #27 (半透白底 + 1.5px 描边蓝紫 + 玻璃 blur) */
  .anon-currency-hint {
    text-align: center;
    font-size: 0.875rem;
    color: #4338ca;
    margin-top: 1rem;
    padding: 0.875rem 1rem;
    background: rgba(255, 255, 255, 0.55);
    border: 1.5px solid rgba(99, 102, 241, 0.18);
    border-radius: 14px;
    backdrop-filter: saturate(180%) blur(12px);
    -webkit-backdrop-filter: saturate(180%) blur(12px);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.6),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04),
      0 1px 4px rgba(99, 102, 241, 0.08);
  }
</style>
