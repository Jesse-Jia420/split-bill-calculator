<!--
  CurrencyAddModal.svelte — v0.3.19 #85 重写 (PO msg 23:?? #7308)

  单一弹窗统一管理「添加副币种」+「修改币种设置」+「修改汇率」三种场景。
  由 SessionCurrencyBadge 在单币种 pill / 多币种整 bar click 时触发。

  4 模式规则 (PO #7308 拍板):
    | mode \ has_bills | !has_bills                  | has_bills                |
    |------------------|-----------------------------|--------------------------|
    | single           | 添加副币种 (add flow)       | 矛盾状态: locked 提示    |
    | multi            | 修改币种设置 (本期仅汇率)   | 仅修改汇率               |

  单币种 + 没账单 (single + !has_bills):
    * 主币种 locked chip
    * 副币种 <select> (从 SUPPORTED 减去 primary + existing)
    * 汇率 <input>
    * 按钮「添加」→ POST /currencies + POST /exchange-rates

  单币种 + 有账单 (single + has_bills):
    * 矛盾状态 (按 PO 规则有账单 = 不可改币种)
    * 显示 🔒 + 灰色文案「当前账单已锁定, 无法添加副币种」
    * 仅显示「关闭」按钮 (no submit)

  多币种 + 没账单 (multi + !has_bills):
    * 主币种 + 副币种 <select> (本期 BE 未支持改, disabled + tooltip)
    * 汇率 <input>
    * 按钮「修改」→ 仅 PATCH 汇率 (主/副币种 disabled 兜底)

  多币种 + 有账单 (multi + has_bills):
    * 主币种 + 副币种 locked chip (灰 bg + 🔒 icon)
    * 汇率 <input> (唯一可改字段)
    * 按钮「保存汇率」→ PATCH /exchange-rates/{rate_id}

  Props:
    - session_id: number
    - primary_currency: string
    - existing_currencies: string[]  (含 primary; 用于过滤 select options)
    - mode: 'single' | 'multi'  (默认 'single' 兼容旧调用)
    - has_bills: boolean  (默认 false, 父组件传 bills.length > 0)
    - exchange_rates: SessionExchangeRate[]  (默认 [], multi 模式必传用于 PATCH)
    - onAdded: (detail: {session, rates}) => void  (提交成功回调, parent 通常 reload)

  视觉沿用 v0.3.18 #53 + v0.3.18 #60 batch2 + v0.3.18 #64 modal 玻璃语言:
    - 弹窗直接浮起 (无 backdrop 遮罩, v0.3.19 #85 PO #7731 删)
    - modal rgba(255,255,255,0.55) + saturate(200%) blur(20px) + 1px indigo 0.22 border
    - inset highlight + 外阴影 (跟全站 glass 语言一致)
    - 锁字段: .glass-input:disabled → 灰 bg + 半透明 + cursor not-allowed
    - locked 提示: 12px gap + 20px emoji + gray-600 文字 (跟 form 风格区分)
-->
<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { Lock, X as XIcon, Check } from 'lucide-svelte';
  import { toast } from '$stores/toast';
  import { ApiError } from '$api/client';
  import { addSessionCurrency, deleteSessionCurrency, type SessionDetail } from '$api/sessions';
  import type { SessionExchangeRate } from '$api/sessions';

  /** SUPPORTED_CURRENCIES — 跟 backend/app/api/sessions.py 保持一致.
   *  内联而非 import 避免为单个常量建共享模块 (PRD §3.7.5 双端硬编 10 个 ISO). */
  const SUPPORTED_CURRENCIES: readonly string[] = [
    'CNY',
    'USD',
    'THB',
    'EUR',
    'JPY',
    'GBP',
    'HKD',
    'SGD',
    'KRW',
    'AUD',
  ] as const;

  export let session_id: number;
  export let primary_currency: string;
  /** 已跟踪的币种 (含 primary). 用于过滤 <select> options. */
  export let existing_currencies: string[] = [];
  /** v0.3.19 #85: 'single' = 单币种 (add new) | 'multi' = 多币种 (edit settings). */
  export let mode: 'single' | 'multi' = 'single';
  /** v0.3.19 #85: 父组件传 bills.length > 0, 决定锁哪些字段. 本期不要求 BE 加字段. */
  export let has_bills: boolean = false;
  /** v0.3.19 #85: multi 模式 PATCH 汇率时需要 rate_id, 从 exchange_rates 找. */
  export let exchange_rates: SessionExchangeRate[] = [];

  /** 提交成功回调 (parent 通常 reload). detail 含 session payload + rates 数组. */
  export let onAdded: ((detail: {
    session: SessionDetail;
    rates: SessionExchangeRate[];
  }) => void) | undefined = undefined;

  const dispatch = createEventDispatcher<{ close: void }>();

  // ---- 表单状态 (single 模式用 secondary + rate, multi 模式用 primary + secondary + rate) ----
  let secondary = '';
  let primary = primary_currency;
  /** Forward rate (1 primary = X secondary). Decimal-as-string 保留精度 (BE wire format). */
  let rate = '';
  let busy = false;

  /** §1 — 副币种可选 = SUPPORTED minus primary minus existing.
   *  multi 模式本期保留过滤逻辑 (BE 未支持改主/副币种, select 仍 disabled 兜底). */
  $: secondary_options = SUPPORTED_CURRENCIES.filter(
    (c) => c !== primary && !existing_currencies.includes(c)
  );
  /** 主币种可选 = SUPPORTED (multi 模式 disabled 显示用). */
  $: primary_options = SUPPORTED_CURRENCIES.slice();
  /** v0.3.21 #108 (PO msg 17:54): multi 模式副币种可选 = SUPPORTED minus primary.
   *  原 primary_options 不过滤 (含 primary), 但 PO 要替换时选 primary 会 409.
   *  这里过滤 primary (其他所有币种可选, 包括 existing secondary → PATCH 路径
   *  + 其他币种 → REPLACE 路径). */
  $: multi_secondary_options = SUPPORTED_CURRENCIES.filter(
    (c) => c !== primary_currency
  );

  /** v0.3.21 #106 (PO msg 17:21): multi 模式从 existing_currencies 初始化 secondary/rate.
   *  用 multiInitialized 一次性 flag 防止 user 选「—」(secondary='') 时被 reactive 覆盖回 existing.
   *  v0.3.21 #108 (PO msg 17:54): 同步跟踪 originalSecondary 用于 submit handler 3 case 分支
   *  (「—」/existing/new), 用 let 持久化 (跟 multiInitialized 同步, 不会随 secondary 改变). */
  let multiInitialized = false;
  let originalSecondary = '';
  $: if (
    mode === 'multi' &&
    !multiInitialized &&
    secondary === '' &&
    existing_currencies.length > 0
  ) {
    const ex = existing_currencies.find((c) => c !== primary_currency);
    if (ex) {
      originalSecondary = ex;
      secondary = ex;
      primary = primary_currency;
      // 找 primary → secondary 的 forward rate row
      if (rate === '') {
        const row = exchange_rates.find(
          (r) => r.from_currency === primary && r.to_currency === ex
        );
        if (row) rate = row.rate;
      }
    }
    multiInitialized = true;
  }

  $: rateNumber = rate.trim() === '' ? NaN : Number(rate.trim());
  $: rateValid = Number.isFinite(rateNumber) && rateNumber > 0;

  /** Submit gating:
   *  - single + !has_bills: secondary + rate
   *  - single + has_bills: 矛盾状态, 不渲染 submit 按钮 (canSubmit = false 兜底)
   *  - multi + 「—」(secondary=''): 只要不 busy (删副币种, 不需要 rate)
   *  - multi + existing/new: rate 即可 (PATCH 现有 or REPLACE 新, 都需新 rate)
   */
  $: canSubmit =
    mode === 'single' && !has_bills
      ? secondary !== '' && rateValid && !busy
      : mode === 'multi'
        ? secondary === ''
          ? !busy
          : rateValid && !busy
        : false;

  function close() {
    if (busy) return;
    dispatch('close');
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && !busy) close();
  }

  /** v0.3.19 #85 v3 PO #7731 (#2): 弹窗存在时锁住页面滚动.
   *  +layout.svelte 在 v0.3.17 #30 已经把 body overflow:hidden + main overflow-y:auto
   *  (iOS app-shell pattern), 所以页面滚动发生在 <main> 元素. 弹窗 mount 时把 main
   *  overflow 也设 hidden, disable 滚轮 + 触屏 swipe. unmount 时恢复.
   *  overscroll-behavior: contain 防止 modal 边缘 rubber-band 触到 body 滚动. */
  onMount(() => {
    const mainEl = document.querySelector('main');
    if (!mainEl) return;
    const origOverflow = mainEl.style.overflow;
    const origOverscroll = mainEl.style.overscrollBehavior;
    mainEl.style.overflow = 'hidden';
    mainEl.style.overscrollBehavior = 'contain';
    return () => {
      mainEl.style.overflow = origOverflow;
      mainEl.style.overscrollBehavior = origOverscroll;
    };
  });

  /** v0.3.19 #85: 找 primary → secondary 的 forward rate row (multi 模式 PATCH 用). */
  function findForwardRate(): SessionExchangeRate | null {
    return (
      exchange_rates.find(
        (r) => r.from_currency === primary && r.to_currency === secondary
      ) ?? null
    );
  }

  async function patchForwardRate(): Promise<SessionExchangeRate[]> {
    const rate_row = findForwardRate();
    if (!rate_row) {
      throw new Error(
        `找不到 ${primary}→${secondary} 的汇率记录, 请刷新页面重试`
      );
    }
    const resp = await fetch(
      `/api/sessions/${session_id}/exchange-rates/${rate_row.id}`,
      {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rate: rate.trim() }),
      }
    );
    if (!resp.ok) {
      let detail: any = {};
      try {
        detail = await resp.json();
      } catch {
        /* ignore */
      }
      const msg =
        detail?.detail?.error ?? `汇率更新失败 (HTTP ${resp.status})`;
      throw new ApiError(resp.status, msg, detail);
    }
    return (await resp.json()) as SessionExchangeRate[];
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    busy = true;
    try {
      if (mode === 'single') {
        // single + !has_bills: add flow (现有 v0.3.18 #53 行为)
        const updated = await addSessionCurrency(session_id, {
          currency: secondary,
        });
        const rateResp = await fetch(
          `/api/sessions/${session_id}/exchange-rates`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from_currency: primary_currency,
              to_currency: secondary,
              rate: rate.trim(),
            }),
          }
        );
        if (!rateResp.ok) {
          let detail: any = {};
          try {
            detail = await rateResp.json();
          } catch {
            /* ignore */
          }
          const msg =
            detail?.detail?.error ?? `汇率创建失败 (HTTP ${rateResp.status})`;
          throw new ApiError(rateResp.status, msg, detail);
        }
        const rates: SessionExchangeRate[] = await rateResp.json();
        toast.success(
          `已添加 ${secondary}, 汇率 ${rate} ${secondary}/${primary_currency}`
        );
        onAdded?.({ session: updated, rates });
        dispatch('close');
      } else if (secondary === '') {
        // v0.3.21 #108 (PO msg 17:54): multi + 「—」→ 切换单币种, 真调 DELETE
        //   /sessions/{id}/currencies/{code}, 后端 cascade 删 forward + reciprocal
        //   两条 exchange_rates + 移除 session.currencies. 返回 SessionDetail 给
        //   parent 触发 reload, 弹窗关闭 + success toast.
        const removed = await deleteSessionCurrency(session_id, originalSecondary);
        toast.success(`已移除 ${originalSecondary}, 账本回到单币种 (${primary_currency})`);
        onAdded?.({ session: removed, rates: removed.exchange_rates ?? [] });
        dispatch('close');
      } else if (secondary === originalSecondary) {
        // multi + existing secondary: PATCH 现有汇率 (唯一一条 forward + reciprocal 自动同步)
        const rates = await patchForwardRate();
        const stubSession = {
          id: session_id,
          session_code: '',
          name: '',
          owner_user_id: 0,
          owner_email: null,
          members: [],
          created_at: '',
          invite_token_preview: null,
          invite_expires_at: null,
          last_bill_participants: null,
          currencies: existing_currencies,
          primary_currency: primary,
          exchange_rates: rates,
        } as unknown as SessionDetail;
        toast.success(
          has_bills
            ? `汇率已更新 ${rate} ${secondary}/${primary}`
            : `币种设置已更新, 汇率 ${rate} ${secondary}/${primary}`
        );
        onAdded?.({ session: stubSession, rates });
        dispatch('close');
      } else {
        // v0.3.21 #108 (PO msg 17:54): multi + 任意其他币种 → REPLACE 流程
        //   (PO bug 3: 之前 findForwardRate 找不到新币种的汇率记录, 报
        //   “找不到 ${primary}→${secondary} 的汇率记录” 错误). 现在:
        //   1) DELETE 旧副币种 (cascade 删其汇率)
        //   2) POST 新副币种
        //   3) POST 新汇率 (forward + reciprocal)
        //   跟 single+!has_bills ADD 流程的 add + create-rate 同源.
        const afterDelete = await deleteSessionCurrency(session_id, originalSecondary);
        const afterAdd = await addSessionCurrency(session_id, { currency: secondary });
        const rateResp = await fetch(
          `/api/sessions/${session_id}/exchange-rates`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from_currency: primary_currency,
              to_currency: secondary,
              rate: rate.trim(),
            }),
          }
        );
        if (!rateResp.ok) {
          let detail: any = {};
          try {
            detail = await rateResp.json();
          } catch {
            /* ignore */
          }
          const msg =
            detail?.detail?.error ?? `汇率创建失败 (HTTP ${rateResp.status})`;
          throw new ApiError(rateResp.status, msg, detail);
        }
        const newRates: SessionExchangeRate[] = await rateResp.json();
        toast.success(
          `已从 ${originalSecondary} 切换到 ${secondary}, 汇率 ${rate} ${secondary}/${primary_currency}`
        );
        // 用 addSessionCurrency 返回的 SessionDetail (含最新 currencies + exchange_rates)
        void afterDelete; // 告诉 TS / 读者 afterDelete 仅用于中间状态跳转语义, 最终 payload 用 afterAdd + newRates
        onAdded?.({ session: afterAdd, rates: newRates });
        dispatch('close');
      }
    } catch (e: any) {
      let msg = e?.message ?? '操作失败';
      if (e instanceof ApiError && e?.detail?.detail?.error) {
        msg = e.detail.detail.error;
      } else if (e?.detail?.error) {
        msg = e.detail.error;
      }
      if (
        e?.status === 409 ||
        e?.detail?.detail?.error === 'currency_already_in_session'
      ) {
        toast.info('该币种已在账本中');
        dispatch('close');
      } else {
        toast.error(msg);
      }
    } finally {
      busy = false;
    }
  }

  /** v0.3.19 #85: 标题 / 按钮文案按 mode + has_bills 切换. */
  $: modalTitle =
    mode === 'single' && has_bills
      ? '无法添加副币种'
      : mode === 'single'
        ? '添加副币种'
        : '币种设置';
  $: submitLabel = (() => {
    if (busy) return mode === 'single' ? '添加中…' : '保存中…';
    if (mode === 'single') return '添加';
    // mode === 'multi': 副币种选「—」(secondary='') 时显示「切换单币种」→ toast 提示开发中
    if (secondary === '') return '切换单币种';
    return has_bills ? '保存汇率' : '修改';
  })();
  /** single + has_bills 矛盾状态: 只有「关闭」按钮, 无 submit. */
  $: showSubmit = !(mode === 'single' && has_bills);
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class="sheet-backdrop"
  role="presentation"
>
  <div
    class="sheet"
    role="dialog"
    aria-modal="true"
    aria-label={modalTitle}
    data-sbc="currency-add-modal"
    data-mode={mode}
    data-has-bills={has_bills ? 'true' : 'false'}
  >
    <header class="sheet-head">
      <h3 class="sheet-title">{modalTitle}</h3>
    </header>

    <div class="sheet-body">
      {#if mode === 'single' && !has_bills}
        <!-- ===== single + !has_bills: 添加副币种 (add flow) ===== -->
        <section class="field">
          <label class="field-label">主币种</label>
          <div class="currency-pair-item currency-pair-item--locked" aria-label="主币种: {primary_currency}">
            <span class="lock-icon" aria-hidden="true">
              <Lock size={11} strokeWidth={2.5} />
            </span>
            <span class="primary-code">{primary_currency}</span>
          </div>
        </section>

        <section class="field">
          <label class="field-label" for="sbc-secondary-currency">副币种</label>
          <select
            id="sbc-secondary-currency"
            class="currency-pair-item currency-select"
            bind:value={secondary}
            disabled={busy}
            data-testid="currency-add-secondary"
          >
            <option value="" disabled>选择币种…</option>
            {#each secondary_options as opt}
              <option value={opt}>{opt}</option>
            {/each}
          </select>
          {#if secondary_options.length === 0}
            <p class="hint">没有可选的副币种了 (10 个币种全在账本中)。</p>
          {/if}
        </section>

        <section class="field">
          <label class="field-label" for="sbc-secondary-rate">汇率</label>
          <div class="rate-row">
            <span class="rate-prefix">1 {primary_currency} =</span>
            <input
              id="sbc-secondary-rate"
              type="text"
              inputmode="decimal"
              class="glass-input rate-input"
              bind:value={rate}
              disabled={busy || secondary === ''}
              placeholder="0.00"
              aria-label="汇率 (1 {primary_currency} = X {secondary})"
              data-testid="currency-add-rate"
            />
            <span class="rate-suffix">{secondary || '副币种'}</span>
          </div>
        </section>
      {:else if mode === 'single' && has_bills}
        <!-- ===== single + has_bills: 矛盾状态 (locked 提示) ===== -->
        <section class="field">
          <div class="locked-message" role="status" data-testid="currency-add-locked">
            <span class="locked-icon" aria-hidden="true">
              <Lock size={20} strokeWidth={2.2} />
            </span>
            <div class="locked-text">
              <p class="locked-title">当前账单已锁定, 无法添加副币种</p>
              <p class="locked-sub">
                已有账单后, 只能修改汇率, 不能改币种。
              </p>
            </div>
          </div>
          <p class="hint">
            如需添加副币种, 请先删除所有账单 (本应用暂不支持)。
          </p>
        </section>
      {:else if mode === 'multi' && !has_bills}
        <!-- ===== multi + !has_bills: 修改币种设置 (本期仅汇率可改) =====
             v0.3.19 #85 PO #7731 (#4): 主+副币种 select 同行并排 — flex 横排 1:1 分栏.
             v0.3.19 #85 PO #7731 (#3): 删「修改主/副币种功能开发中...」hint (disables + tooltip 已说明). -->
        <section class="field currency-pair-row">
          <div class="currency-pair-col">
            <label class="field-label" for="sbc-primary-currency">主币种</label>
            <select
              id="sbc-primary-currency"
              class="currency-pair-item currency-pair-item--locked currency-select"
              bind:value={primary}
              disabled={true}
              title="改主币种功能开发中 (BE 未支持)"
              data-testid="currency-edit-primary"
            >
              {#each primary_options as opt}
                <option value={opt}>{opt}</option>
              {/each}
            </select>
          </div>
          <div class="currency-pair-col">
            <label class="field-label" for="sbc-secondary-currency">副币种</label>
            <select
              id="sbc-secondary-currency"
              class="currency-pair-item currency-select"
              bind:value={secondary}
              disabled={busy}
              title="选择「—」切回单币种; 选其他币种替换当前副币种"
              data-testid="currency-edit-secondary"
            >
              <option value="">—</option>
              {#each multi_secondary_options as opt}
                <option value={opt}>{opt}</option>
              {/each}
            </select>
          </div>
        </section>

        <section class="field">
          <label class="field-label" for="sbc-secondary-rate">汇率</label>
          <div class="rate-row">
            <span class="rate-prefix">1 {primary} =</span>
            <input
              id="sbc-secondary-rate"
              type="text"
              inputmode="decimal"
              class="glass-input rate-input"
              bind:value={rate}
              disabled={busy || secondary === ''}
              placeholder="0.00"
              aria-label="汇率 (1 {primary} = X {secondary})"
              data-testid="currency-edit-rate"
            />
            <span class="rate-suffix">{secondary}</span>
          </div>
        </section>
      {:else if mode === 'multi' && has_bills}
        <!-- ===== multi + has_bills: 仅修改汇率 (主/副币种 locked chip 同行) ===== -->
        <!-- v0.3.19 #85 v3 PO #7731 (#3 跟进): 主+副币种 chip 也同行 — 跟 multi bar 一致的
             CNY ⇄ THB 视觉. reuse .currency-pair-row / .currency-pair-col (multi+!has_bills 同款). -->
        <section class="field currency-pair-row">
          <div class="currency-pair-col">
            <div class="field-label">主币种</div>
            <div class="currency-pair-item currency-pair-item--locked" aria-label="主币种: {primary_currency}">
              <span class="lock-icon" aria-hidden="true">
                <Lock size={11} strokeWidth={2.5} />
              </span>
              <span class="primary-code">{primary_currency}</span>
            </div>
          </div>
          <div class="currency-pair-col">
            <div class="field-label">副币种</div>
            <div class="currency-pair-item currency-pair-item--locked" aria-label="副币种: {secondary}">
              <span class="lock-icon" aria-hidden="true">
                <Lock size={11} strokeWidth={2.5} />
              </span>
              <span class="primary-code">{secondary}</span>
            </div>
          </div>
        </section>

        <section class="field">
          <label class="field-label" for="sbc-secondary-rate">汇率</label>
          <div class="rate-row">
            <span class="rate-prefix">1 {primary} =</span>
            <input
              id="sbc-secondary-rate"
              type="text"
              inputmode="decimal"
              class="glass-input rate-input"
              bind:value={rate}
              disabled={busy}
              placeholder="0.00"
              title="已有账单, 只能修改汇率"
              aria-label="汇率 (1 {primary} = X {secondary})"
              data-testid="currency-edit-rate-bills"
            />
            <span class="rate-suffix">{secondary}</span>
          </div>
          <p class="hint">
            已有账单, 只能修改汇率。
          </p>
        </section>
      {/if}
    </div>

    <!-- v0.3.19 #85 v3 PO #7731 (#5): 取消 + 保存 改圆形按钮 (跟账单保存 consistency).
         左圆形 X 按钮 = 取消 / 右圆形 ✓ 按钮 = 保存(submit). 视觉一致: 圆形 44×44 +
         glass material + Lucide X / Check icon + aria-label 替代 text label.
         单币种矛盾 (showSubmit=false) 状态: 仅左圆形 X (关闭按钮), 跟弹窗右上 X 同义.
         v0.3.35 #5 (UAT 0725-3 #11 — PO 字面 "样式要与 添加已结算记录的弹窗一致"): 取消 + 保存改 inline pill button
         跟 AddSettlementSheet .cta-row + .btn-primary 同款 (原 .fab 圆形按钮已成 legacy visual 单族). -->
    <footer class="sheet-foot">
      <button
        type="button"
        class="btn-cancel-sheet"
        onclick={close}
        disabled={busy}
        data-testid="currency-add-cancel"
      >取消</button>
      {#if showSubmit}
        <button
          type="button"
          class="btn-primary"
          onclick={handleSubmit}
          disabled={!canSubmit}
          aria-label={submitLabel}
          data-testid="currency-add-submit"
        >
          {submitLabel}
        </button>
      {/if}
    </footer>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    /* v0.3.27 (UAT 0723-2 #9): 跟 InviteLinkButton .invite-modal-backdrop 完全一致
     *   — 之前 v0.3.19 #85 刪掉的全屏模糊遮罩加回来, 跟邀请 modal 同风格.
     * v0.3.29 (UAT 0725-1 #2, PO msg 12:43): PO 重申 "同汇率设置一样". v0.3.28 #8 re-fix
     *   把 invite backdrop 改到 blur(24px) saturate(200%) + bg 0.45, 跟这里脱节.
     *   修法: invite 改回跟这里完全一致 (bg 0.30 / blur 16px saturate 180% / z 999).
     *   两个组件 backdrop token 同源, 未来若改 backdrop blur 强度, 两个 .modal-backdrop
     *   rule 需同步更新 (或抽到 app.css .modal-backdrop-full 全局类).
     * v0.3.35 #5 (UAT 0725-3 #11, PO 字面 "样式要与 添加已结算记录的弹窗一致"): 形态从 centered modal
     *   改 bottom sheet 跟 AddSettlementSheet 同款, 整 backdrop + sheet 视觉跟 AddSettlementSheet
     *   .backdrop + .sheet 一致. — 但 backdrop blur 强度维持 v0.3.29 (16/0.30) (PO 视为全屏 darkener,
     *   比 AddSettlementSheet (4/0.40) 更暗一档, 视觉上还是 modal 形态). */
    background: rgba(0, 0, 0, 0.30);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    z-index: 999;
    animation: backdropFadeIn 160ms ease;
  }

  .sheet {
    /* v0.3.35 #5 (UAT 0725-3 #11): bottom sheet 形态 (跟 AddSettlementSheet .sheet 同款) -
       圆角只在顶部 24px, 底部贴屏, max-width 480px, slide-up animation.
       AddSettlementSheet 用 slideUp 280ms cubic-bezier(0.32, 0.72, 0, 1) (decisive ease). */
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    margin: 0 auto;
    max-width: 480px;
    max-height: 92vh;
    overflow-y: auto;
    overscroll-behavior: contain;
    background: rgba(255, 255, 255, 0.92);
    backdrop-filter: saturate(220%) blur(28px);
    -webkit-backdrop-filter: saturate(220%) blur(28px);
    border-top-left-radius: 24px;
    border-top-right-radius: 24px;
    border: 1px solid rgba(255, 255, 255, 0.7);
    border-bottom: 0;
    padding: 8px 16px 0;
    box-shadow:
      0 -8px 32px rgba(15, 23, 42, 0.12),
      inset 0 1px 0 rgba(255, 255, 255, 0.85);
    z-index: 1000;
    animation: slideUp 280ms cubic-bezier(0.32, 0.72, 0, 1);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  /* v0.3.35 #5: 兼容 Safari iOS < 18 (无 backdrop-filter), fallback bg 加深一档, 跟 modal centered
     fallback 同样的逻辑. */
  @supports not (backdrop-filter: blur(1px)) {
    .sheet {
      background: rgba(255, 255, 255, 0.96);
    }
    .sheet-backdrop {
      background: rgba(0, 0, 0, 0.48);
    }
  }

  /* v0.3.27 (UAT 0723-2 #9): .modal padding 24px 统一管理, .modal-head/.modal-body/.modal-foot
   *   内部子元素的 padding 全清, 跟 .invite-modal 同一布局哲学 (单层 padding, 不嵌套). */
  .modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .modal-title {
    margin: 0;
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-semibold);
    color: var(--gray-900);
  }

  .modal-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .field-label {
    font-size: var(--font-size-sm);
    color: var(--gray-700);
    font-weight: var(--font-weight-medium);
  }

  /* v0.3.21 #106 (PO msg 17:21): chip + select 视觉统一 → .currency-pair-item 共享 pill.
   *   替换原 .primary-chip / .primary-chip--secondary + .currency-select--disabled,
   *   三者统一到同一组 pill token: 999px radius + 8px/14px padding + 0.55 bg + indigo
   *   border. 锁定变体 (.currency-pair-item--locked) 走灰 muted bg (gray-500/12).
   *   width: 100% 让 chip / select 在 .field (flex column) / .currency-pair-col 内
   *   撑满宽度, 跟原 chip auto-width 视觉不同 (但跨模式 chip / select 统一). */
  .currency-pair-item {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    width: 100%;
    padding: 8px 14px;
    background: rgba(255, 255, 255, 0.55);
    border: 1px solid rgba(99, 102, 241, 0.22);
    border-radius: 999px;
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    color: var(--gray-700);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
    line-height: 1.2;
    box-sizing: border-box;
    text-align: center;
    transition: background 150ms ease, border-color 150ms ease;
  }
  .currency-pair-item:focus-visible {
    outline: 2px solid var(--accent-500, #6366f1);
    outline-offset: 2px;
  }
  .currency-pair-item--locked {
    background: rgba(148, 163, 184, 0.12);
    border-color: rgba(148, 163, 184, 0.28);
    color: var(--gray-500);
    cursor: not-allowed;
  }
  /* v0.3.19 #85 v3 PO #7731 (#1): lock icon 改 Lucide Lock (跟其它 Lucide icon 同款).
   *  原 🔒 emoji 视觉不一致 (emoji 字体不同, 描边颜色不一) — 改 Lucide SVG icon, 用
   *  display:inline-flex 居中 + color var(--accent-700) 跟 chip 配.
   *  v0.3.21 #106: 锁定变体下 lock icon 改 gray-500 (跟 .currency-pair-item--locked 同色). */
  .lock-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--accent-700, #4338ca);
    flex-shrink: 0;
  }
  .currency-pair-item--locked .lock-icon {
    color: var(--gray-500);
  }
  .primary-code {
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
  }

  /* native select 在 .currency-pair-item pill 上叠加:
   *   - appearance: auto 保留 iOS Safari native dropdown arrow (OS 渲染, 跨平台一致)
   *   - text-align-last: center 让 selected option 文字居中 (text-align: center
   *     对 native select 内文字不生效, 用 text-align-last 兜底)
   *   - padding-right 给 native arrow 留位, 避免文字被 arrow 盖住 */
  .currency-select {
    appearance: auto;
    -webkit-appearance: menulist;
    padding-right: 28px;
    text-align-last: center;
    cursor: pointer;
  }
  .currency-select:disabled {
    cursor: not-allowed;
  }

  .rate-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .rate-prefix {
    font-size: var(--font-size-sm);
    color: var(--gray-700);
    font-weight: var(--font-weight-medium);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .rate-input {
    flex: 1 1 auto;
    min-width: 5em;
    max-width: 8em;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .rate-suffix {
    font-size: var(--font-size-sm);
    color: var(--gray-600);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .hint {
    margin: 0;
    font-size: var(--font-size-xs);
    color: var(--gray-500);
    line-height: 1.4;
  }

  /* v0.3.19 #85 PO #7731 (#4) + v3 (#3 跟进): 主+副币种 select / chip 同行并排.
   *   1:1 等宽分栏, gap 12px — 跟全站 field gap 16px 减半, 让两栏更紧凑.
   *   v0.3.21 #106 (PO msg 17:21): 删 .currency-pair-arrow (改 #1 删 ⇄ 箭头). */
  .currency-pair-row {
    flex-direction: row;
    gap: var(--space-3);
  }
  .currency-pair-col {
    flex: 1 1 0;
    min-width: 0; /* 防止 flex item 内容撑出 */
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  /* v0.3.19 #85 (PO #7308 改动 5): single + has_bills 矛盾状态显示灰色提示文案.
   * 跟 form 字段区分: 12px gap + 20px Lucide Lock icon (跟其它 app icon 统一)
   * + 大段文字 (gray-600) + tooltip 用 title 属性 (简单跨平台). */
  .locked-message {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-4);
    background: rgba(148, 163, 184, 0.08);
    border: 1px solid rgba(148, 163, 184, 0.20);
    border-radius: 12px;
  }
  .locked-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--gray-500);
    flex-shrink: 0;
  }
  .locked-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .locked-title {
    margin: 0;
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    color: var(--gray-700);
    line-height: 1.4;
  }
  .locked-sub {
    margin: 0;
    font-size: var(--font-size-xs);
    color: var(--gray-600);
    line-height: 1.4;
  }

  /* v0.3.19 #85 v3 PO #7731 (#5): 圆形 FAB button (跟账单保存 consistency).
   *   圆形 44×44 + glass material (跟全站 .fab .glass-pill 同源 token) +
   *   accent indigo 边框 + 紫蓝阴影. cancel 用 gray 主色 (secondary),
   *   submit 用 indigo→blue gradient (primary).
   *   v0.3.21 #106 (PO msg 17:21): 改 #3 — 取消按钮移到右下挨着保存 (flex-end + gap),
   *   原 space-between 让 cancel 在左下角改成右下角并列, 视觉重心更聚拢. */
  /* v0.3.27 (UAT 0723-2 #9): modal-foot padding 清, 跟 .modal padding 24px 统一管理 */
  .modal-foot {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: var(--space-3);
  }
  .fab {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    appearance: none;
    cursor: pointer;
    font-family: inherit;
    transition:
      background 150ms ease,
      transform 100ms ease,
      box-shadow 150ms ease,
      opacity 150ms ease;
  }
  .fab:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    pointer-events: none;
  }
  /* cancel FAB (左) — gray/white 玻璃 (secondary action). */
  .fab--cancel {
    background: rgba(255, 255, 255, 0.45);
    border: 1px solid rgba(148, 163, 184, 0.30);
    color: var(--gray-600, #475569);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.6),
      inset 0 -1px 0 rgba(0, 0, 0, 0.03),
      0 2px 8px rgba(148, 163, 184, 0.18);
  }
  .fab--cancel:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.65);
    border-color: rgba(148, 163, 184, 0.45);
    transform: scale(1.03);
  }
  .fab--cancel:active:not(:disabled) {
    transform: scale(0.95);
  }
  .fab--cancel:focus-visible {
    outline: 2px solid var(--gray-400);
    outline-offset: 2px;
  }
  /* submit FAB (右) — indigo→blue gradient 玻璃 (primary action). */
  .fab--submit {
    background: linear-gradient(
      135deg,
      rgba(99, 102, 241, 0.95) 0%,
      rgba(59, 130, 246, 0.95) 100%
    );
    border: 1px solid rgba(99, 102, 241, 0.40);
    color: #fff;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.4),
      inset 0 -1px 0 rgba(0, 0, 0, 0.05),
      0 4px 12px rgba(99, 102, 241, 0.32);
  }
  .fab--submit:hover:not(:disabled) {
    background: linear-gradient(
      135deg,
      rgba(99, 102, 241, 1) 0%,
      rgba(59, 130, 246, 1) 100%
    );
    transform: scale(1.03);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.5),
      inset 0 -1px 0 rgba(0, 0, 0, 0.05),
      0 6px 16px rgba(99, 102, 241, 0.40);
  }
  .fab--submit:active:not(:disabled) {
    transform: scale(0.95);
  }
  .fab--submit:focus-visible {
    outline: 2px solid var(--accent-500);
    outline-offset: 2px;
  }

  /* v0.3.19 #85 PO #7731 (#2): 去掉 fadeIn (backdrop 透明无 opacity 变化). */
  @keyframes slideUp {
    from { opacity: 0; transform: translateY(8px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
</style>