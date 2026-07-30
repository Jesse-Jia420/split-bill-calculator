<script lang="ts">
  /**
   * v0.3.15 (PRD §3.15.2 #6 v2, PO msg #4752+#4763) — FAB 圆形按钮:
   * - 父页面 `bills/new` + `bills/edit` 在 `<form>` 外加左右两个圆形 FAB:
   *     左 = 圆形 + ArrowLeft (返回 session)
   *     右 = 圆形 + Check (保存, 走 `form="bill-form"` 外部 submit 桥接)
   * - 本组件只负责:
   *     (1) `<form id="bill-form">` — 让外部 FAB save button 能 submit;
   *     (2) 不再画 sticky bar (反 PO 拍板: 圆形 FAB 比 sticky bar 更轻量,
   *         跟 session 主页「新建账单」FAB 同形态)。
   *
   * v0.3.15 (PO #4807 + Designer 报告) — 错误统一走 Toast.
   * - 删 `let formError` 状态 + form 顶部 `<div class="error">` 模板 + data-testid
   * - 4 个 formError 赋值源 (3 客户端校验 + 1 BE 错误) → toast.error()
   * - humanizeApiError() helper 保留 (返回 string, 仍被 toast 消费)
   */
  import { onMount, tick } from 'svelte';
  import type { SessionDetail } from '$api/sessions';
  import type { Bill } from '$api/bills';
  import { evaluateExpression } from '$api/calculator';
  // v0.3.0728-3 #7 (PO msg 2026-07-28 batch 新批 #7) — reverse v0.3.0728-2 #13: 重新 import currencySymbol,
  // pill 内从显 currency code (CNY/THB) 改回 currency symbol (¥). 简洁货币符号 跟人物选框 (member picker) 一致.
  import { ApiError } from '$api/client';
  import { currencySymbol } from '$lib/utils/currency';
  import { toast } from '$stores/toast';
  // v0.3.36 #12 — UAT 0728-1 #12 (PO 字面 "已结算记录头像样式应跟成员 section 一致"):
  // 改用共享 lib/utils/palette.ts (跟 SessionMemberList + SettlementRow + SettleTransferPath 4 处统一 source).
  // 之前 BillForm 内联 AVATAR_GRADIENTS + avatarGradient + avatarInitial 跟 SessionMemberList inline copy.
  import { paletteGradient, avatarInitialOf } from '$lib/utils/palette';
  import AmountCalculatorInput from './AmountCalculatorInput.svelte';
  import IosSwitch from './IosSwitch.svelte';

  /**
   * v0.1.2 (PO 2026-07-01 fix #3): edit-page support.
   *
   * - `mode: 'create' | 'edit'` controls the submit button label, AI
   *   helper visibility (hidden in edit), and whether `description` is
   *   editable. Defaults to 'create' so existing call sites that
   *   construct `<BillForm />` keep working unchanged.
   * - `existingBill?: Bill` is the source of truth for the prefilled
   *   form state in edit mode. In create mode it is ignored.
   *
   * v0.1.2 (T17, earlier): `description` is intentionally read-only in
   * edit mode because the backend's UpdateBillRequest has it stripped
   * (Pydantic `extra='forbid'`). The UI surfaces this with a disabled
   * input + helper text instead of silently dropping user input.
   */
  export let session: SessionDetail;
  /** Called with a ready-to-POST / PATCH payload. */
  export let onSubmit: ((payload: {
    amount: number;
    payer_member_id: number;
    description: string | null;
    occurred_at: string;
    currency: string;
    participants: Array<{ member_id: number; is_exclusive: boolean; exclusive_amount: number }>;
    // v0.2.1 T01: raw calculator expression echoed back to the BE.
    // Empty string when the user typed no expression (in which case the
    // BE keeps the supplied `amount` and stores NULL for amount_expression).
    amount_expression: string;
    // Whether the BE should re-evaluate `amount_expression` and overwrite
    // `amount` (always true when the user typed into the calculator).
    use_calculator: boolean;
  }) => Promise<void> | void) | null = null;

  /**
   * v0.1.2 (T19): if provided, the payer dropdown will default to this
   * SessionMember.id when the form first mounts. Pass the caller's own
   * SessionMember.id from the new-bill page (which already has the user
   * + session in scope). If null/undefined the dropdown starts blank and
   * the user has to pick.
   */
  export let defaultPayerMemberId: number | null = null;

  /** v0.1.2 (fix #3): create or edit. Defaults to 'create'. */
  export let mode: 'create' | 'edit' = 'create';
  /** v0.1.2 (fix #3): when mode === 'edit', prefill the form. */
  export let existingBill: Bill | null = null;
  /** 'sheet' = bottom-sheet compact layout (BillSheet); 'page' = full page. */
  export let layout: 'page' | 'sheet' = 'page';

  // v0.3.20 #93 (PO msg 00:04 #7450): removed smart-date-chips prop + UI (T03).
  // occurred_at default is now driven by getDefaultOccurredAt(primaryCurrency)
  // (see Fix 4 — currency TZ default), so the chips were redundant.

  $: isEdit = mode === 'edit';
  $: canEditDescription = !isEdit;
  $: isSheet = layout === 'sheet';

  // v0.2.1 T01: the AmountCalculatorInput owns the amount field. ``amount`` is
  // the currently-evaluated number (null when the expression is empty or
  // invalid); ``amountExpression`` is the raw string the user typed (also
  // written back to the API as ``amount_expression``).
  let amount: number | null = null;
  let amountExpression: string = '';
  let payerMemberId: number | null = null;
  let description = '';
  // v0.3.0728-2 #9 — UAT 0728-2 #9 BillForm 8 个预设选项 (PO msg 16:50).
  // PO 拍: 快捷预设选项 — 合作记账软件性质 (三餐 / 交通 / 购物 / 住宿 / 门票).
  // 点击 chip → 替换 description input 内容. 玻璃风 + 全站 .glass-pill 同族.
  const DESCRIPTION_PRESETS = ['早餐', '午餐', '晚餐', '交通', '门票', '购物', '房租', '水电'] as const;
  function applyPreset(preset: string) {
    description = preset;
    descriptionPristine = false;
    descriptionError = false;
  }
  // v0.3.20 #93 (PO msg 00:04 #7450, Fix 4): occurred_at default = current time in session primary currency TZ.
  // User can still manually edit the time (datetime-local input not locked).
  let occurredAt: string = getDefaultOccurredAt(session.primary_currency);
  let currency = 'CNY';

  // v0.3.15 (PRD §3.15.2 #2): currencySymbol moved to
  // lib/utils/currency.ts so other components (SettleTransferPath,
  // SessionCurrencyBadge) share the same mapping. Function
  // declaration removed; calls below still go through the import.

  // participant state, keyed by SessionMember.id
  let participantState: Record<number, { included: boolean; exclusive: boolean; amount: string }> = {};
  for (const m of session.members) {
    participantState[m.id] = { included: true, exclusive: false, amount: '0' };
  }

  // v0.3.36 #12: 共享 lib/utils/palette.ts — 上面 import 完毕, 这里只留 wrapper.
  function avatarGradient(index: number): string {
    return paletteGradient(index);
  }
  /**
   * v0.3.20 #91: avatar 首字符 — 英文 1 字母大写, 中文 1 字.
   * (mockup 用 2 字母 "Ju/Ca", 按 PO 拍板改为 1 字母 "J/C".)
   */
  function avatarInitial(name: string): string {
    return avatarInitialOf(name);
  }

  /**
   * v0.3.20 #91: pill 进入 exclusive 态后, 需要自动 focus 进 input.
   * 用 inputRefs 收集 input 元素, tick() 后 .focus() + .select().
   */
  let inputRefs: Record<number, HTMLInputElement | null> = {};

  let submitting = false;
  let descriptionPristine = true;
  // v0.3.35 #1 — UAT 0725-3 #6 (PO msg #9088 batch): description 空提交红框视觉标记.
  //   跟 toast.error 同色 (rose→red rgba(244,63,94,...)), 让用户一眼知道哪个字段要填.
  let descriptionError = false;
  // v0.3.36 #12 — UAT 0727-1 #12 (Jesse msg 2026-07-27 23:35 "b.c 完全同款"):
  //   amount 字段空 / <=0 触发红框, 跟 descriptionError 同款 rose→red glass.
  let amountError = false;

  // v0.2.1 T02: last-bill participants prefetched on mount.
  // v0.3.20 #93 (PO msg 00:04 #7450): smartDateChips state removed (UI deleted).
  let lastParticipantsApplied = false;

  // v0.1.2 (T19 + fix #3): apply the caller-supplied default payer once
  // the form mounts. In create mode we use defaultPayerMemberId; in edit
  // mode the existing bill's payer wins (if it's still a session member).
  onMount(() => {
    if (isEdit && existingBill) {
      // Prefill from existing bill.
      amount = existingBill.amount;
      amountExpression = existingBill.amount_expression
        ? existingBill.amount_expression
        : String(existingBill.amount);
      payerMemberId = existingBill.payer_id;
      // description: visible but not editable. Keep its current value
      // so the user can see what they're editing.
      description = existingBill.description ?? '';
      descriptionPristine = true;
      // Convert ISO datetime to the datetime-local input format
      // (YYYY-MM-DDTHH:mm) in local time.
      const d = new Date(existingBill.occurred_at);
      if (!isNaN(d.getTime())) {
        const pad = (n: number) => String(n).padStart(2, '0');
        occurredAt =
          `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
          `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
      currency = existingBill.currency || 'CNY';
      // Rebuild participant state from existing participants; missing
      // members default to "not included" (the form's create-mode
      // default is "all included" — for edit we honour the persisted
      // truth).
      for (const m of session.members) {
        const ep = existingBill.participants.find((p) => p.member_id === m.id);
        participantState[m.id] = ep
          ? {
              included: true,
              exclusive: !!ep.is_exclusive,
              amount: ep.exclusive_amount ? String(ep.exclusive_amount) : '0',
            }
          : { included: false, exclusive: false, amount: '0' };
      }
      participantState = { ...participantState };
      return;
    }
    if (
      defaultPayerMemberId != null &&
      payerMemberId === null &&
      session.members.some((m) => m.id === defaultPayerMemberId)
    ) {
      payerMemberId = defaultPayerMemberId;
    }

    // v0.2.1 T02: default-勾选「最近一笔账单的参与者」(create mode only).
    // PRD §3.6.2 — first visit (no prior bills) 走 v0.1.1 默认: 全员 included.
    if (!isEdit && !lastParticipantsApplied) {
      const lastSet = session.last_bill_participants;
      // 前端 localStorage fallback: 网络错误 / 接口降级时仍能保留上次选择
      try {
        const lsKey = `sbc.lastParticipants.${session.id}`;
        const lsRaw = localStorage.getItem(lsKey);
        const lsSet = lsRaw ? JSON.parse(lsRaw) : null;
        if (Array.isArray(lsSet) && lsSet.length > 0 && (!Array.isArray(lastSet) || lastSet.length === 0)) {
          // Fallback 仅在 BE 没返回时用
          applyParticipantsDefault(lsSet);
        } else if (Array.isArray(lastSet) && lastSet.length > 0) {
          applyParticipantsDefault(lastSet);
          localStorage.setItem(lsKey, JSON.stringify(lastSet));
        }
      } catch {
        // localStorage 可能被禁用 — 静默忽略
      }
      lastParticipantsApplied = true;
    }

    // v0.3.20 #93 (PO msg 00:04 #7450): removed smart-date chips block (T03).
    // Default-value behavior of occurredAt (today) is now driven by
    // getDefaultOccurredAt(primaryCurrency) — see Fix 4.
  });

  function applyParticipantsDefault(memberIds: number[]) {
    const valid = new Set(memberIds);
    for (const m of session.members) {
      const st = participantState[m.id];
      if (!st) continue;
      st.included = valid.has(m.id);
    }
    participantState = { ...participantState };
    // Persist for next time.
    try {
      localStorage.setItem(`sbc.lastParticipants.${session.id}`, JSON.stringify(memberIds));
    } catch {
      // ignore
    }
  }

  function toggleParticipant(memberId: number) {
    if (!participantState[memberId]) return;
    participantState[memberId].included = !participantState[memberId].included;
    participantState = { ...participantState };
  }

  // v0.3.20 #91 (PO msg 03:06 #7375): pill 改为两态切换 (shared 虚 ↔ exclusive 实).
  //   - shared (默认): "个人消费 ¥" ghost 玻璃, 102×32 钉死
  //   - exclusive (实): ¥ + input, accent 玻璃, 102×32 钉死
  // v0.3.20 #92 (PO msg 07:13 #7409): 删 stepper (▲▼ 按钮) — pill 背景跨 ¥+input+stepper 不连续,
  // 视觉混乱. 改纯 ¥+input 双元素, 数字直接键盘输入或 input 自带 stepper (mobile keyboard 自带).
  // 不再有第三个"数字 pill"态 — input 永远显示, 数字直接读 input.
  // 点 shared → enterExclusive (focus input)
  // 点 ¥ / pill 内非 input 区 → exitExclusive (清 invalid amount)
  //
  // `st.exclusive` 是 source of truth, buildPayload 直接读它.
  // 无需 editingMemberId 之类的中间 UI 状态.

  /** Count of currently-included members (header summary). */
  $: includedCount = session.members.reduce(
    (n, m) => n + (participantState[m.id]?.included ? 1 : 0),
    0
  );
  /** True when every member is included (drives the 全选/清空 toggle label). */
  $: allIncluded =
    session.members.length > 0 &&
    session.members.every((m) => participantState[m.id]?.included);

  /** Toggle all members included/excluded at once. */
  function toggleAllParticipants() {
    const target = !allIncluded;
    for (const m of session.members) {
      const st = participantState[m.id];
      if (st) st.included = target;
    }
    participantState = { ...participantState };
  }

  /**
   * v0.3.20 #91: 进入独占态 — shared pill → exclusive pill.
   * focus input 让用户立即可键入金额.
   * v0.3.21 #117 (PO msg 11:35 #7838 Bug 3): focus 后显式 scrollIntoView 让 main
   * 滚到 input 进入可视区. iOS Safari 键盘弹起时, 浏览器自动 scrollIntoView 在
   * app-shell 架构 (main 是 overflow-y: auto 容器, 不是 window) 下经常不生效,
   * 表现为 "键盘弹出但页面不顶起, input 被键盘遮住". Android Chrome 不受影响.
   * v0.3.25 Top #2 (PO msg 16:35 UAT line): 进一步修. iOS Safari keyboard 起来是
   * 异步的 (300-400ms), 浏览器原生 focus scrollIntoView 在 main overflow-y:auto
   * 容器 + iOS keyboard 场景下, 即便显式调一次, 算的仍是 window.innerHeight - 待
   * keyboard 占位, 但 keyboard 真正起来是后续异步事件. 表现为 "键盘弹起了, 但页面
   * 还是只滚了半截, input 还在 keyboard 下面被遮". 三重 scrollIntoView: rAF 后立
   * 即 + 350ms + 700ms 各一次, 等 keyboard 起来后第三次会算上 keyboard 减掉的
   * visualViewport.height. block:'nearest' 最小滚动 + .pill-input
   * scroll-margin-bottom:280px 让 input 底部留 280px 缓冲, iPhone keyboard 295px
   * - 280 = 15px 余量, 安全不遮. form .stack padding-bottom:280px 给 main 容器
   * 足够滚动距离.
   */
  async function enterExclusiveMode(memberId: number) {
    const st = participantState[memberId];
    if (!st) return;
    st.exclusive = true;
    if (!st.amount || st.amount === '0') st.amount = '';
    participantState = { ...participantState };
    await tick();
    const input = inputRefs[memberId];
    if (input) {
      input.focus();
      input.select();
      // iOS Safari: 三次重试 scrollIntoView (rAF 立即 + 350ms + 700ms), 等 keyboard
      // 异步起来后再调一次. block:'nearest' 最小滚动避免 input 被推到 main 中部反而
      // 越过 viewport. 配合 .pill-input { scroll-margin-bottom: 56px } + form
      // .stack { padding-bottom: 56px } (v0.3.0729-2 #8: 200→56, 靠 visualViewport 监听
      // 动态算) 给 input 底部留足够空间.
      //
      // v0.3.28 UAT 0724-1 #8: 进一步加 visualViewport.resize 监听. iOS Safari
      // 真 keyboard 起来时触发 visualViewport resize 事件 (keyboard 高度 = window.
      // innerHeight - visualViewport.height), 此时再 scrollIntoView 让 input 滚到
      // visualViewport 可见区. visualViewport 是 iOS keyboard 起来的权威信号源
      // (比 setTimeout(700) 准确). 1.5s 后自动移除监听器 (避免长期占用).
      // Android 不受影响 (Android keyboard resize 触发同一 listener, 但 Android
      // chrome 自动 scrollIntoView 已正确, 重复 scrollIntoView 无副作用).
      const scrollIntoView = () => {
        input.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      };
      requestAnimationFrame(scrollIntoView);
      setTimeout(scrollIntoView, 350);
      setTimeout(scrollIntoView, 700);
      if (typeof window !== 'undefined' && window.visualViewport) {
        const vvHandler = () => scrollIntoView();
        window.visualViewport.addEventListener('resize', vvHandler);
        setTimeout(() => {
          if (window.visualViewport) {
            window.visualViewport.removeEventListener('resize', vvHandler);
          }
        }, 1500);
      }
    }
  }

  /**
   * v0.3.20 #91: 退出独占态 — 点击 ¥ 或 pill 内非 input 区.
   * amount 若非法 (空 / NaN / ≤ 0) 则清零; 合法则保留以便下次进入时还在.
   */
  function exitExclusiveMode(memberId: number) {
    const st = participantState[memberId];
    if (!st) return;
    const n = Number(st.amount);
    st.exclusive = false;
    if (!st.amount || st.amount === '' || !Number.isFinite(n) || n <= 0) {
      st.amount = '0';
    }
    participantState = { ...participantState };
  }

  /**
   * v0.3.22 #119 (PO msg 11:35 #7838 Bug 5): input blur 后, 若 amount 是 0/空/非法
   *   → 自动退到 shared 虚态 (跟点 ¥ 按钮等价). 合法 amount 保持 exclusive 不变.
   * 之前 blur 无 handler, input 上类型 0 后点别处 → 仍卡在 exclusive + amount='0'
   *   (UI 看起来很奇怪: exclusive pill 显示 ¥ + input 0).
   * 修法: blur 时复用 exitExclusiveMode 的 amount 校验. 但若 amount 合法 (>0),
   *   保持 exclusive 让用户继续编辑 (跟 sticky 输入数字后准备离开再决定提交一致).
   * 注意: click ¥ button 走的是 exitExclusiveMode (不管 amount 多少都回 shared,
   *   跟 PO 在 v0.3.20 #91 拍的一致). blur 只在 0/空 时回 shared, 与 click ¥ 不同.
   */
  function handlePillBlur(memberId: number) {
    const st = participantState[memberId];
    if (!st || !st.exclusive) return;
    const n = Number(st.amount);
    if (!st.amount || st.amount === '' || !Number.isFinite(n) || n <= 0) {
      // amount 无效 → 退到 shared (虚态)
      st.exclusive = false;
      st.amount = '0';
      participantState = { ...participantState };
    }
    // amount 合法 → 保持 exclusive, 啥也不做 (用户继续编辑)
  }

  /**
   * v0.3.20 #92 (PO msg 07:13 #7409): stepper 函数已删 (UI 删 stepper 按钮后无 caller).
   * exclusive 金额调整走原生 number input (mobile keyboard 自带 + / - 控件).
   */

  /**
   * v0.3.20 #93 (PO msg 00:04 #7450, Fix 4): occurred_at default = current time in session primary currency TZ.
   *
   * Uses Intl.DateTimeFormat to fetch Y/M/D/H/m in the target TZ, then joins to
   * datetime-local string. Avoids toLocaleString (which emits localised month names).
   *
   * Mapping:
   *   CNY -> Asia/Shanghai   (UTC+8)
   *   THB -> Asia/Bangkok   (UTC+7)
   *   JPY -> Asia/Tokyo     (UTC+9)
   *   USD -> America/New_York (UTC-5/-4 DST)
   *   EUR -> Europe/Berlin  (UTC+1/+2 DST)
   *   others -> UTC
   */
  function getDefaultOccurredAt(primaryCurrency: string): string {
    const TZ_MAP: Record<string, string> = {
      CNY: 'Asia/Shanghai',
      THB: 'Asia/Bangkok',
      JPY: 'Asia/Tokyo',
      USD: 'America/New_York',
      EUR: 'Europe/Berlin',
    };
    const tz = TZ_MAP[primaryCurrency] || 'UTC';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value || '00';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
  }

  function buildPayload() {
    const participants: Array<{ member_id: number; is_exclusive: boolean; exclusive_amount: number }> = [];
    for (const m of session.members) {
      const st = participantState[m.id];
      if (!st) continue;
      // v0.3.20 #91: amount 非法 (空 / NaN / ≤ 0) 时把 is_exclusive 也归零,
      // 避免发 "is_exclusive=true, exclusive_amount=0" 这种自相矛盾的状态.
      let is_exclusive = st.exclusive;
      let excl = 0;
      if (st.exclusive) {
        const n = Number(st.amount);
        if (Number.isFinite(n) && n > 0) {
          excl = n;
        } else {
          is_exclusive = false;
        }
      }
      // v0.3.20 #93 (PO msg 00:04 #7450, Fix 3): allow save when not-included but has exclusive amount.
      // - included=true: in shared pool, exclusive adds own_exclusive on top (existing).
      // - included=false AND is_exclusive=true AND excl>0: still push as participant
      //   (is_exclusive=true, exclusive_amount=excl), so BE persists exclusive amount.
      //   Trade-off: BE _compute_share_amounts counts presence in divisor, so other
      //   participants share shrinks by excl/num_share. Full semantic (excluded_from_share)
      //   needs future BE schema upgrade -- not blocking POs 'can save' goal.
      // - Skip entirely: !included AND !(is_exclusive && excl > 0).
      if (!st.included && !(is_exclusive && excl > 0)) continue;
      participants.push({
        member_id: m.id,
        is_exclusive,
        exclusive_amount: excl
      });
    }
    // v0.2.1 T01: send BOTH the expression and the evaluated amount.
    // use_calculator flips on whenever the expression is non-empty
    // (e.g. "350/5") so the BE re-evaluates and stores both.
    // Edit-mode expressions are echoed back verbatim; the BE's regex
    // reject any malformed expressions with 422 before storage.
    const expr = amountExpression.trim();
    const useCalc = expr.length > 0;
    // v0.3.1 (TEST-006 fix): in edit mode, strip `description` from the
    // payload. The BE's UpdateBillRequest has `extra='forbid'` AND no
    // `description` field — sending `description=null` (even null) was
    // rejected with 422 by Pydantic. The description is immutable (PO
    // T17) so we never need to send it again on PATCH.
    const payload: any = {
      amount: amount ?? 0,
      payer_member_id: payerMemberId ?? 0,
      occurred_at: new Date(occurredAt).toISOString(),
      currency: currency || 'CNY',
      participants,
      amount_expression: expr,
      use_calculator: useCalc,
    };
    if (!isEdit) {
      payload.description = description.trim() ? description.trim() : null;
    }
    return payload;
  }

  // v0.3.15 (PO #4790, P0-2 — Designer report):
  //   Translates a BE 4xx response into a one-line, human-actionable
  //   hint for the inline form error. Two shapes we have to handle:
  //
  //   (a) Pydantic 422 validation error — `detail` is an ARRAY of
  //       `{loc: ['body', 'amount'], msg: '...', type: '...'}`. We
  //       surface the first one as "amount: Field required" so the
  //       user can fix the right input.
  //   (b) Business 4xx — `detail` is an OBJECT `{error: 'code',
  //       hint?: 'free-form'}`. We render "code (hint)" so users
  //       learn both the protocol-level code and a friendlier string.
  //
  //   Anything else falls through to `err.message` (which for
  //   ApiError is "422 http_422" — visible, but not great) or
  //   '提交失败'. Returning `string` keeps the call-site tidy.
  /**
   * v0.3.35 #4 — UAT 0725-3 #8 (PO msg #9088 batch): humanizeApiError 改本地化错误反馈.
   * PO 字面 "a. 解决这个问题. b. 报错提交失败不解决任何问题, 要准确告诉用户具体哪里有问题."
   * 修法:
   *   1. Pydantic 字段名 (err.detail[*].loc 末段) → 中文字段名 (description → "说明" 等).
   *      PO 看 toast 时能直接看到 "说明: Value error, ..." 不用脑补 Pydantic 字段路径.
   *   2. 业务错误码 (err.detail.error) → 中文 (currency_mismatch → "账单币种不在账本币种中" 等).
   *      PO 看 toast 时知道具体业务问题, 不用猜英文码含义.
   *   3. 默认 fallback '提交失败' → '保存失败' (前端 createBill/updateBill 是 save 操作, 不是 submit).
   *      治 PO 字面 "一直会提示 提交失败" — 这是 a. 部分.
   *   4. err.message 字面 '提交失败' → '保存失败'.
   */
  /** v0.3.35 #4: BE Pydantic 字段名 (loc 末段) → 中文字段名映射. 未命中 fallback 原始字段名 (用户能看到 Pydantic 路径). */
  const BILL_FIELD_NAME_ZH: Record<string, string> = {
    description: '说明',
    amount: '金额',
    occurred_at: '时间',
    currency: '币种',
    payer_id: '付款人',
    payer_member_id: '付款人',
    participants: '参与者',
    exclusive_amount: '个人消费金额',
    member_id: '成员',
    is_exclusive: '是否个人消费',
  };
  /** v0.3.35 #4: BE 业务错误码 (err.detail.error) → 中文映射. 未知名 fallback '保存失败'. */
  const BILL_ERROR_CODE_ZH: Record<string, string> = {
    currency_mismatch: '账单币种不在账本币种中',
    rate_missing: '币种之间缺少汇率记录',
    session_locked: '账本已锁定无法修改',
    permission_denied: '当前用户无权操作',
    bill_not_found: '账单不存在',
  };
  function humanizeApiError(err: any): string {
    if (!err) return '保存失败';
    if (Array.isArray(err.detail) && err.detail.length > 0) {
      const first = err.detail[0];
      const loc = Array.isArray(first?.loc) ? first.loc.slice(1) : [];
      // loc 末段字段名 (Pydantic 格式: e.g. ["body","amount"] → "amount")
      const rawField = loc.length ? loc[loc.length - 1] : '';
      const fieldZh = rawField ? (BILL_FIELD_NAME_ZH[rawField] ?? rawField) : '';
      const field = fieldZh ? fieldZh + ': ' : '';
      // Pydantic 英文 msg 保留 (用户能看懂 Pydantic 描述), 关键是字段名中文化.
      return field + (first?.msg || '字段错误');
    }
    if (err.detail && typeof err.detail === 'object' && !Array.isArray(err.detail)) {
      const rawCode = err.detail.error || '提交失败';
      // 已知错误码 → 中文; 未知名 fallback '保存失败' (不显示 '提交失败' 字面, 跟前 save() 流程对得上)
      const codeZh = BILL_ERROR_CODE_ZH[rawCode]
        ?? (rawCode === '提交失败' ? '保存失败' : rawCode);
      const hint = err.detail.hint;
      return hint ? `${codeZh} (${hint})` : codeZh;
    }
    // err.message 字面 '提交失败' → '保存失败', 其他保持
    const msg = err?.message ?? '保存失败';
    return msg === '提交失败' ? '保存失败' : msg;
  }

  /** Sheet / form 可用币种列表 (至少含当前 currency). */
  $: currencyOptions =
    session.currencies && session.currencies.length > 0
      ? session.currencies
      : [currency];
  $: isMultiCurrency = currencyOptions.length > 1;

  /**
   * 非 sheet 布局仍用 pill 行: 多币种可点切换; 单币种锁定不可选.
   */
  function handleCurrencyPillClick(code: string) {
    if (!isMultiCurrency) return;
    currency = code;
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    // v0.3.35 #1 — UAT 0725-3 #6 (PO msg #9088 batch): description 客户端必填校验.
    //   之前仅靠 BE (Pydantic min_length=1) 422 报错 → humanizeApiError 翻译成
    //   "description: field required" 等. PO 字面 "b. 报错提交失败不解决任何问题,
    //   要准确告诉用户具体哪里有问题" → FE 先拦, 给精确字段 + 红框视觉.
    if (description.trim() === '') {
      descriptionError = true;
      toast.error('请填写账单说明');
      return;
    }
    descriptionError = false;
    const p = buildPayload();
    // v0.3.36 #12 — UAT 0727-1 #12 (c 完全同款): amount validation 触发红框玻璃.
    if (amount == null || !Number.isFinite(amount) || amount <= 0) {
      amountError = true;
      toast.error('请填写账单金额');
      return;
    }
    amountError = false;
    if (!p.payer_member_id) {
      toast.error('请选择付款人');
      return;
    }
    if (!p.participants.length) {
      toast.error('至少勾选一个参与者');
      return;
    }
    submitting = true;
    try {
      if (onSubmit) await onSubmit(p);
    } catch (err: any) {
      // v0.3.15 (PO #4807): 错误统一走 Toast. humanizeApiError 把
      // Pydantic 422 字段路径 + 业务码翻译成可操作字符串, 不是 "422 http_422".
      toast.error(humanizeApiError(err));
    } finally {
      submitting = false;
    }
  }
  /**
   * v0.3.36 #11 (UAT 0727-1): Enter 键在 .pill-input 不应触发表单提交, 仅 blur input.
   * Jesse msg 2026-07-27 23:35 "a. b" — 所有 .pill-input 都应用 (每 member 的个人消费 input).
   * 用 form-level event delegation, 不用逐 input 加 handler (per-loop 多次重复).
   */
  function handleFormKeyDown(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    if (e.key === "Enter" && target?.classList?.contains("pill-input")) {
      e.preventDefault();
      (target as HTMLInputElement).blur();
    }
  }

</script>

<form
  class="stack"
  class:sheet-layout={isSheet}
  id="bill-form"
  onsubmit={handleSubmit}
  onkeydown={handleFormKeyDown}
>
  <!-- Sheet layout:
       金额 input 右侧挂币种: 单币种锁定 chip; 双币种 = IosSwitch 左右滑二选一
       (跟 settle「主币种汇总 / 原始数据」同款).
       时间+付款人: 等宽两列 -->
  {#if isSheet}
    <div class="field field-amount-block">
      <label class="label" for="amount">金额</label>
      <div class="amount-input-row">
        <div class="amount-input-main">
          <AmountCalculatorInput
            {amount}
            initialValue={amountExpression}
            initialAmount={amount}
            {currency}
            disabled={submitting}
            error={amountError}
            on:confirm={(e) => {
              amount = e.detail.value;
              amountExpression = e.detail.expression;
              amountError = false;
            }}
          />
        </div>
        {#if isMultiCurrency}
          <div class="currency-switch-wrap" data-testid="bill-currency-switch">
            <IosSwitch
              ariaLabel="币种"
              options={currencyOptions.map((code) => ({ value: code, label: code }))}
              bind:value={currency}
            />
          </div>
        {:else}
          <span
            class="currency-locked"
            aria-label="币种 {currencyOptions[0] ?? currency}（单币种不可选）"
            data-testid="bill-currency-locked"
          >{currencyOptions[0] ?? currency}</span>
        {/if}
      </div>
    </div>

    <div class="field-grid field-grid-time-payer" data-testid="bill-time-payer-row">
      <div class="field field-time">
        <label class="label" for="occurredAt">时间</label>
        <input id="occurredAt" type="datetime-local" bind:value={occurredAt} />
      </div>
      <div class="field field-payer">
        <label class="label" for="payer">付款人</label>
        <select id="payer" bind:value={payerMemberId}>
          <option value={null}>— 选择 —</option>
          {#each session.members as m (m.id)}
            <option value={m.id}>{m.display_name}</option>
          {/each}
        </select>
      </div>
    </div>
  {:else}
  <div class="row" style="gap: var(--space-3); align-items: flex-start;">
    <div style="flex: 1; min-width: 0;">
      <label class="label" for="amount">金额</label>
      <AmountCalculatorInput
        {amount}
        initialValue={amountExpression}
        initialAmount={amount}
        {currency}
        disabled={submitting}
        error={amountError}
        on:confirm={(e) => {
          amount = e.detail.value;
          amountExpression = e.detail.expression;
          amountError = false;
        }}
      />
    </div>
  </div>
  <div class="occurredAt-row">
    <label class="label" for="occurredAt">时间</label>
    <input id="occurredAt" type="datetime-local" bind:value={occurredAt} />
  </div>

  <div class="row" style="gap: var(--space-3); align-items: center;">
    <div style="flex: 1; min-width: 0;">
      <label class="label" for="payer">付款人</label>
      <select id="payer" bind:value={payerMemberId}>
        <option value={null}>— 选择 —</option>
        {#each session.members as m (m.id)}
          <option value={m.id}>{m.display_name}</option>
        {/each}
      </select>
    </div>
    <div style="flex: 1; min-width: 0;">
      <span class="label" id="currency-pills-label">币种</span>
      <div class="currency-pills" role="radiogroup" aria-labelledby="currency-pills-label">
        {#each currencyOptions as code (code)}
          <button
            type="button"
            class="currency-pill"
            class:active={currency === code}
            class:disabled={submitting || !isMultiCurrency}
            class:locked={!isMultiCurrency}
            role="radio"
            aria-checked={currency === code}
            disabled={submitting || !isMultiCurrency}
            onclick={() => handleCurrencyPillClick(code)}
          >{code}</button>
        {/each}
      </div>
    </div>
  </div>
  {/if}

  <div class="field field-desc">
    <label class="label" for="desc">说明</label>
    <!-- v0.3.0728-2 #9 (UAT 0728-2 #9 BillForm 8 个预设选项, PO msg 16:50)
         + v0.3.0728-3 #4 (PO msg 2026-07-28 batch 新批 #4 "预设选项应放在 说明和说明 input 之间")
         PO 拍 (0728-2 #9): 新建账单的说明部分增加快捷预设选项, 点击可快速将选项中的内容替换至说明 input 中.
         PO 拍 (0728-3 #4): 预设选项 chip 排版位置 — 从 "说明 上方" 挪到 "说明 和 说明 input 之间".
         选项 (8 个, 合作记账软件性质): 早餐 / 午餐 / 晚餐 / 交通 / 门票 / 购物 / 房租 / 水电.
         玻璃风 + 全站 .glass-pill 同族. chip horizontal scroll if overflow (iOS Safari overflow-x: auto).
         click chip → description = preset + descriptionPristine = false + descriptionError = false.
         位置 (0728-3 #4): DOM order 改 [label → preset-row → input], 视觉 chip 在 label 下方紧贴 input 上方,
         chip 是 "input 的预设辅助", 跟 input 视觉关联更强 (跟 PO 期望语义一致). -->
    <div class="preset-row" data-testid="desc-preset-row">
      {#each DESCRIPTION_PRESETS as preset (preset)}
        <button
          type="button"
          class="preset-chip"
          onclick={() => applyPreset(preset)}
          disabled={!canEditDescription}
          data-testid="desc-preset-{preset}"
        >{preset}</button>
      {/each}
    </div>
    <input
      id="desc"
      type="text"
      bind:value={description}
      placeholder="例: 晚餐"
      maxlength="500"
      disabled={!canEditDescription}
      class:input-error={descriptionError}
      oninput={() => {
        descriptionPristine = false;
        if (description.trim() !== '') descriptionError = false;
      }}
    />

  </div>

  <div>
    <div class="row between">
      <span class="label">
        参与者 ({includedCount}/{session.members.length} 已选)
      </span>
    </div>

    <!-- v0.2.3 T14 (PRD §3.9.2): single tap area per row + chevron-expandable sub-row.
         Hide the whole section when the session has no members. -->
    {#if session.members.length > 0}
      <div class="row between ppts-toggle-row">
        <span class="muted ppts-meta">{session.members.length} 名成员</span>
        <button
          type="button"
          class="link-btn"
          onclick={toggleAllParticipants}
          data-testid="ppts-toggle-all"
          aria-label={allIncluded ? '清空全部参与者' : '全选全部参与者'}
        >{allIncluded ? '清空' : '全选'}</button>
      </div>
      <ul class="ppts list" style="list-style: none; margin: 0; padding: 0;" data-testid="ppts-list">
        {#each session.members as m, i (m.id)}
          {@const st = participantState[m.id]}
          <li class="ppt-row" data-testid={`ppts-li-${m.id}`}>
            <!-- v0.3.20 #91 (PO msg 03:06 #7375): 头像 + 两态 pill (shared/exclusive).
                 - 行 main 区: checkbox icon + 头像 (36×36 gradient + 1 字符首字母) + name.
                   点整行 = toggle 参与 / 不参与.
                 - pill 区 (102×32 钉死):
                   · shared (虚): "个人消费 ¥" ghost 玻璃, 点 → 进 exclusive
                   · exclusive (实): ¥ + input + stepper, accent 玻璃, 点 ¥ → 回 shared -->
            <button
              type="button"
              class="ppt-main"
              onclick={() => toggleParticipant(m.id)}
              data-testid={`ppts-row-${m.id}`}
              aria-pressed={st?.included ?? false}
            >
              <!-- v0.3.29 UAT 0725-1 #11: 玻璃选框 (替代 emoji ☑☐, 跟全站玻璃语言同源)
                   18x18 square, 半透明白底 + backdrop-filter blur(8px) saturate(180%) + 1px 白边 + inset highlight
                   .included: 填充 indigo 玻璃 (跟主按钮同源 rgba(99,102,241,0.55) bg + border 0.85)
                   .not-included: 0.45 alpha 白玻璃 + 0.18 蓝边 (空态淡) -->
              <span class="ppt-check-icon" class:included={st?.included} aria-hidden="true">
                {#if st?.included}
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                {/if}
              </span>
              <span class="ppt-avatar" class:dim={!st?.included} aria-hidden="true"
                style={st?.included ? avatarGradient(i) : 'background: rgba(160,160,160,0.25)'}>
                {avatarInitial(m.display_name)}
              </span>
              <span class="ppt-name">{m.display_name}</span>
            </button>
            {#if st?.exclusive}
              <!-- v0.3.20 #92 (PO msg 07:13 #7409): exclusive 实态: ¥ + input, accent 玻璃, 102×32 钉死.
                   v0.3.0729-3 #1: focus/unfocus 一律 currencySymbol (¥/$), 不再显 CNY/THB code. -->
              <div
                class="excl-pill excl-pill-exclusive"
                role="group"
                aria-label={`${m.display_name} 的个人消费金额`}
                data-testid={`ppts-chip-${m.id}`}
                data-state="exclusive"
              >
                <button
                  type="button"
                  class="pill-currency"
                  onclick={() => exitExclusiveMode(m.id)}
                  aria-label={`退出 ${m.display_name} 的个人消费`}
                >{currencySymbol(currency)}</button>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  class="pill-input"
                  bind:value={st.amount}
                  bind:this={inputRefs[m.id]}
                  onblur={() => handlePillBlur(m.id)}
                  placeholder="0.00"
                  aria-label={`${m.display_name} 的个人消费金额`}
                  data-testid={`ppts-amount-${m.id}`}
                />
              </div>
            {:else}
              <!-- shared 虚态: "¥ 个人消费" ghost 玻璃 (currency 在前, label 在后), 点 → 进 exclusive.
                   v0.3.21 #115 (PO msg 11:35): 货币符号应在前, 个人消费字样在后.
                   v0.3.0729-3 #1: 与 exclusive 态一致, 一律 currencySymbol (¥/$). -->
              <button
                type="button"
                class="excl-pill excl-pill-shared"
                onclick={() => enterExclusiveMode(m.id)}
                aria-label={`为 ${m.display_name} 设置个人消费`}
                data-testid={`ppts-chip-${m.id}`}
                data-state="shared"
              >
                <span class="pill-currency" aria-hidden="true">{currencySymbol(currency)}</span>
                <span class="pill-label">个人消费</span>
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <!-- v0.3.15 (PO #4790, P0-1): the inline error was previously rendered HERE
       (after the participants list) which physically overlapped the bottom-left
       back-FAB. It now lives at the TOP of the form (see above) so it never
       collides with the page-level FABs. -->

  <!-- v0.3.15 §3.15.2 #6 v2 (PO msg #4752+#4763): 父页面在 <form> 外加左右两个圆形 FAB。
       这里**不**画 sticky bar — 圆形 FAB 由 `bills/new/+page.svelte` 和
       `bills/[billId]/edit/+page.svelte` 在 page 层用 <a class="fab fab-left"> +
       <button form="bill-form" class="fab fab-right"> 实现。 -->
</form>

<style>
  /* v0.2.3 T14 (PRD §3.9.2): participants row layout.
     Each row = single main button (checkbox icon + name + optional
     exclusive-amount badge) + a chevron button. The chevron expands
     an indented sub-row with the number input for the exclusive amount.
     No two checkboxes share a row anymore. */
  .ppts-toggle-row {
    padding: 4px 2px 6px 2px;
  }
  .ppts-meta {
    font-size: var(--font-size-sm, 13px);
  }
  .link-btn {
    background: none;
    border: none;
    color: var(--accent-500, #3b82f6);
    font-size: var(--font-size-sm, 13px);
    font-weight: 500;
    cursor: pointer;
    padding: 6px 10px;
    min-height: 32px;
    border-radius: var(--radius-md, 8px);
    -webkit-tap-highlight-color: transparent;
    transition: background-color 120ms ease;
  }
  .link-btn:active {
    background: var(--gray-100, #f3f4f6);
  }
  .ppts li.ppt-row {
    padding: 0;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .ppt-row {
    border-bottom: 1px solid var(--color-border, #e5e7eb);
  }
  .ppt-row:last-child {
    border-bottom: none;
  }
  .ppt-main {
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    gap: var(--space-2, 8px);
    min-height: var(--touch-target, 44px);
    padding: 8px 10px;
    margin: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-md, 8px);
    color: var(--color-text, #111827);
    text-align: left;
    cursor: pointer;
    font-size: 15px;
    -webkit-tap-highlight-color: transparent;
    transition: background-color 120ms ease;
  }
  .ppt-main:active {
    background: var(--gray-100, #f3f4f6);
  }
  /* v0.3.29 UAT 0725-1 #11: 玻璃选框 (跟 v0.3.23 #132 avatar Option B 玻璃语言同源)
     18x18 square + 半透明白底 + backdrop-filter blur(8px) saturate(180%) + 1px 蓝白边 + glass shadow.
     .not-included (空态): 白玻璃 0.45 alpha, 蓝边 0.18
     .included (亮态): indigo 玻璃 rgba(99,102,241,0.55) bg, 蓝边 0.85, 实心 ✓ */
  .ppt-check-icon {
    flex: 0 0 18px;
    width: 18px;
    height: 18px;
    border-radius: 5px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.45);
    backdrop-filter: blur(8px) saturate(180%);
    -webkit-backdrop-filter: blur(8px) saturate(180%);
    border: 1px solid rgba(99, 102, 241, 0.18);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.50),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04),
      0 1px 2px rgba(15, 23, 42, 0.04);
    color: transparent;
    transition: background-color 150ms ease, border-color 150ms ease, box-shadow 150ms ease;
  }
  .ppt-check-icon.included {
    background: rgba(99, 102, 241, 0.55);
    border-color: rgba(99, 102, 241, 0.85);
    color: #ffffff;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.40),
      inset 0 -1px 0 rgba(67, 56, 202, 0.18),
      0 1px 3px rgba(99, 102, 241, 0.18);
  }
  /* v0.3.20 #91 (PO msg 03:06 #7375): 头像 — 36×36 圆形 + 5 色 palette + 1 字符首字母.
     复用 SessionMemberList 的 5 色 AVATAR_GRADIENTS, 尺寸放大到 36×36 (比 chip 28px 大)
     以适配 row 高度 ~60px. */
  /* v0.3.23 #132 (UAT old #4, PO msg 17:16 option B): 加 backdrop-filter + 强化玻璃 shadow */
  /* v0.3.29 UAT 0725-1 #5 (PO msg 2026-07-25 11:38): 参与者头像置灰状态增强识别度.
     现状: 未选中态用 rgba(160,160,160,0.25) 灰色 bg. 修法: 加 filter: grayscale(1) + opacity: 0.5.
     跟 v0.3.20 #92 (.currency-pill.disabled opacity 0.5) 同源 design philosophy.
     不动 #132 glass shadow 与 backdrop-filter, 保留玻璃语言同源. */
  .ppt-avatar.dim {
    filter: grayscale(1);
    opacity: 0.5;
  }
  .ppt-avatar {
    flex: 0 0 auto;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 14px;
    line-height: 1;
    letter-spacing: -0.01em;
    /* Option B: backdrop-filter 让 rgba 0.88 渐变在 glass parent 上有 glass on glass 效果 */
    backdrop-filter: blur(4px) saturate(180%);
    -webkit-backdrop-filter: blur(4px) saturate(180%);
    /* glass shadow: top highlight + bottom lowlight + outer lift */
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.5),
      inset 0 -1px 0 rgba(0, 0, 0, 0.08),
      0 1px 2px rgba(0, 0, 0, 0.08),
      inset 0 0 0 0.5px rgba(255, 255, 255, 0.4);
    -webkit-tap-highlight-color: transparent;
    user-select: none;
  }
  .ppt-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* v0.3.20 #91 (PO msg 03:06 #7375): pill 两态切换 (shared 虚 ↔ exclusive 实).
     删 v0.3.19 #84 三态 (反 #7085 拍板): 不再有 "数字 pill" 独立态, input 永远在 exclusive 态显示.

     pill 尺寸钉死: 102×32, border-radius 16px (full), flex-shrink:0.
     两态宽高完全一致, 只视觉虚实区分 (PO 强调不许跟内容 / 状态变).
       - shared 虚: "个人消费 ¥" ghost 玻璃, 13px gray-700 + ¥ gray-400 小一号
       - exclusive 实: ¥ + input + stepper, accent 玻璃, focus border 加深 accent-600 */
  .excl-pill {
    flex: 0 0 auto;
    width: 102px;
    height: 32px;
    min-width: 102px;
    min-height: 32px;
    border-radius: 16px;
    display: inline-flex;
    align-items: center;
    box-sizing: border-box;
    white-space: nowrap;
    font-family: inherit;
    cursor: pointer;
    transition: background-color 150ms ease-out, border-color 150ms ease-out, box-shadow 150ms ease-out;
    -webkit-tap-highlight-color: transparent;
    overflow: hidden;
  }
  @media (prefers-reduced-motion: reduce) {
    .excl-pill {
      transition-duration: 0ms;
    }
  }

  /* v0.3.20 #93 (PO msg 00:04 #7450, Fix 2): unified glass on shared pill,
     matches site-wide #21/#30/#49 glass language (backdrop-filter blur + saturate).
     Shared still softer visually (white 0.55 vs exclusive indigo 0.18), but real glass.
     hover: bg 0.55 -> 0.70 + border 0.18 -> 0.30. */
  .excl-pill-shared {
    background: rgba(255, 255, 255, 0.55);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid rgba(99, 102, 241, 0.18);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.50),
      inset 0 -1px 0 rgba(0, 0, 0, 0.03),
      0 2px 8px rgba(99, 102, 241, 0.06);
    /* v0.3.0729-2 #7: shared 跟 exclusive 同左对齐节奏 (flex-start + gap 4 + pad 10).
       旧 space-between 拉两端; center 在钉死 102px 里光学仍偏 (窄 $ vs 宽「个人消费」).
       左起 "$ 个人消费" 与 exclusive 态 "¥ 金额" 同一起点. */
    padding: 0 10px;
    gap: 4px;
    justify-content: flex-start;
    color: var(--gray-700, #334155);
  }
  .excl-pill-shared:hover {
    background: rgba(255, 255, 255, 0.70);
    border-color: rgba(99, 102, 241, 0.30);
  }
  .excl-pill-shared:active {
    background: rgba(99, 102, 241, 0.10);
  }
  @supports not (backdrop-filter: blur(1px)) {
    .excl-pill-shared {
      background: rgba(255, 255, 255, 0.85);
    }
  }
  .pill-label {
    font-size: 13px;
    font-weight: 500;
    line-height: 1;
    color: var(--gray-700, #334155);
    letter-spacing: -0.01em;
  }
  .excl-pill-shared .pill-currency {
    font-size: 13px;
    font-weight: 500;
    line-height: 1;
    color: var(--gray-400, #94a3b8);
    letter-spacing: -0.01em;
  }

  /* v0.3.20 #92 (PO msg 07:13 #7409): exclusive (实) - indigo bg + accent border + ¥ + input 双元素.
     focus: border 加深 accent-700.
     v0.3.20 #93 (Fix 2): add backdrop-filter glass, same blur(20px) saturate(180%) as shared pill.
     Exclusive visually stronger (bg 0.18 + border 0.55 + 12% outer shadow) to emphasise "实" feel. */
  .excl-pill-exclusive {
    background: rgba(99, 102, 241, 0.18);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid rgba(99, 102, 241, 0.55);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.50),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04),
      0 2px 8px rgba(99, 102, 241, 0.12);
    padding: 0 10px;
    gap: 4px;
    cursor: default;
  }
  .excl-pill-exclusive:focus-within {
    border-color: var(--accent-700, #4338ca);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.55),
      0 0 0 2px rgba(99, 102, 241, 0.20);
  }
  .pill-currency:focus-visible {
    outline: 0;
  }
  .pill-input:focus-visible {
    outline: 0;
  }
  @supports not (backdrop-filter: blur(1px)) {
    .excl-pill-exclusive {
      background: rgba(99, 102, 241, 0.32);
    }
  }
  /* v0.3.0729-3 #1: pill-currency 显 ¥/$ (currencySymbol), 单字符; width auto + 13px. */
  .pill-currency {
    flex: 0 0 auto;
    width: auto;
    min-width: 0;
    background: transparent;
    border: 0;
    padding: 0 2px;
    font-size: 13px;
    font-weight: 500;
    color: var(--gray-500, #64748b);
    cursor: pointer;
    line-height: 1;
    font-family: inherit;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0;
  }
  /* v0.3.20 #93 (Fix 2): exclusive pill-currency accent-600 -> accent-700 (deeper indigo) 配新玻璃 bg 0.18 */
  .excl-pill-exclusive .pill-currency {
    color: var(--accent-700, #4338ca);
    font-weight: 600;
  }
  /* v0.3.20 #93 (Fix 2): pill-input accent-600 -> accent-700 跟新 pill-currency 一致 */
  /* v0.3.29 UAT 0725-1 #9 (PO msg 2026-07-25 11:38): 个人金额 pill 内的文字高度有问题, 跟 pill 没对齐.
     修法: .pill-input 加 line-height: 32px + height: 32px, 跟 .excl-pill 父级 height: 32px 完全一致.
     native number input 默认 line-height 偏大 (Chrome ~20px / Safari ~24px), 即使父级 flex
     align-items: center 也无法完美居中 — input 文字 baseline 跟兄弟 .pill-currency button
     (line-height: 1 = 13px) 不一致, 视觉上 input 文字往下沉. 显式钉死 line-height + height
     让 flex 完美居中 (跟 button 视觉同源). */
  .pill-input {
    flex: 0 0 auto;
    width: 40px;
    height: 32px;
    line-height: 32px;
    min-width: 0;
    background: transparent;
    border: 0;
    outline: 0;
    padding: 0;
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--accent-700, #4338ca);
    text-align: center;
    font-variant-numeric: tabular-nums;
    font-family: inherit;
    -moz-appearance: textfield;
    appearance: textfield;
    /* v0.3.25 Top #2 (PO msg 16:35 UAT line): iOS Safari keyboard 起来时,
       scrollIntoView 计算 input 位置会预留底部缓冲. iPhone 13 keyboard
       ~295px; 配合 visualViewport resize 监听, 静态缓冲缩到 56px 即可
       (v0.3.0729-2 #8, 跟 .stack padding-bottom 同步). */
    scroll-margin-bottom: 56px;
  }
  .pill-input::-webkit-outer-spin-button,
  .pill-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .pill-input::placeholder {
    color: rgba(99, 102, 241, 0.35);
    font-weight: 500;
  }
  /* v0.3.20 #92 (PO msg 07:13 #7409): 删 .pill-stepper / .pill-step / .pill-step:hover / .pill-step:active
     — stepper 按钮已删, native number input 自带 +/- 控件 (mobile keyboard 上可见).
     独占 pill 改纯 ¥ + input 双元素, 背景连续不跨子元素. */
  .btn-sm {
    min-height: 36px;
    padding: 4px 10px;
    font-size: var(--font-size-sm);
  }
  .hint {
    font-size: var(--font-size-sm);
    margin-top: 4px;
  }

  /* v0.2.2 (T10): currency pill selector */
  .currency-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 4px;
  }
  .currency-pill {
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    padding: 0.25rem 0.75rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--color-text);
    cursor: pointer;
    min-height: 32px;
    transition: background 0.12s ease, border-color 0.12s ease;
  }
  .currency-pill:hover:not(.disabled):not(:disabled) {
    border-color: rgba(99, 102, 241, 0.5);
  }
  .currency-pill.active {
    background: #6366f1;
    color: white;
    border-color: #6366f1;
  }
  .currency-pill:disabled,
  .currency-pill.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* v0.3.2 (Bug 3 — 2026-07-07, archived 2026-07-21 v0.3.20 #95 Fix 2): 
     以下 .datetime-row / .datetime-icon 整套 CSS 已删除 —
     iOS Safari 已不渲染原生 picker indicator (留固定空白) 问题;
     PO msg 02:41 #7459 也反馈日历 📅 emoji span 是视觉噪音, 一并去掉。
     原 style 保留在 git history 里以备需要时恢复。 */

  /* v0.3.15 §3.15.2 #6 v2 (PO msg #4752+#4763): 删掉 sticky action bar 整段 CSS。
     FAB 圆形按钮样式 (`.fab / .fab-left / .fab-right`) 移到父页面
     `bills/new/+page.svelte` 和 `bills/[billId]/edit/+page.svelte` 的
     `<style>` 块里 — 跟 session 主页「新建账单」FAB
     (sessions/[id]/+page.svelte) 保持视觉一致
     (56×56 圆形 + indigo 渐变 + 阴影)。 */

  /* v0.3.15 (PO #4790, P0-1 — Designer report): reserve 96px at the
     bottom of the form so the last member row stays scroll-clear of
     the page-level bottom-left / bottom-right FABs (56×56 + 16px
     inset + ~24px breathing room). Scoped: only affects the form in
     this component, leaves the global .stack utility rule alone.
     v0.3.25 Top #2 (PO msg 16:35 UAT line): padding-bottom 从 96px 提到 280px,
     给 main 容器足够滚动距离, 配合 .pill-input { scroll-margin-bottom: 280px }
     让最下边成员 input focus + keyboard 起来时, scrollIntoView 能把 input 顶到
     keyboard 上方. iPhone 13 keyboard ~295px, 余量 15px 安全. */
  .stack {
    /* v0.3.0729-2 #8: padding-bottom 200 → 56.
     * 旧 200/96 仍在最后参与者下方留太多空白 (PO 反复挂).
     * FAB 避让改靠页面层 fab 自身; keyboard 靠 .pill-input scroll-margin-bottom
     * + visualViewport resize, 不再靠大 padding 撑空白. */
    padding-bottom: 56px;
  }

  /* Bottom-sheet form layout (BillSheet) — single vertical rhythm:
     section gap 22 · label→control 8 · equal meta columns · matched control height 44. */
  .stack.sheet-layout {
    padding-bottom: 4px;
    gap: 22px;
  }
  .sheet-layout .field {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .sheet-layout .label {
    margin-bottom: 0;
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.01em;
    color: #64748b;
    line-height: 1.2;
  }

  /* 金额: label 独占一行; input + 币种控件同行 */
  .sheet-layout .amount-input-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    width: 100%;
  }
  .sheet-layout .amount-input-main {
    flex: 1 1 auto;
    min-width: 0;
  }
  .sheet-layout .field-amount-block :global(.amount-calc) {
    gap: 0;
  }
  /* 双币种: 压缩版 IosSwitch (跟 settle 主币种汇总/原始数据同族, 高度贴齐金额框) */
  .sheet-layout .currency-switch-wrap {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
  }
  .sheet-layout .currency-switch-wrap :global(.ios-switch) {
    margin: 0;
    width: fit-content;
    max-width: 100%;
  }
  .sheet-layout .currency-switch-wrap :global(.ios-switch-option) {
    padding: 0.35rem 0.7rem;
    font-size: 0.75rem;
    min-height: 36px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  /* 单币种: 不可选锁定 chip */
  .sheet-layout .currency-locked {
    flex: 0 0 auto;
    box-sizing: border-box;
    height: 36px;
    min-height: 36px;
    padding: 0 12px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: rgba(67, 56, 202, 0.55);
    background: rgba(255, 255, 255, 0.12);
    border: 0.5px solid rgba(99, 102, 241, 0.28);
    box-shadow:
      inset 0 1px 2px rgba(0, 0, 0, 0.04),
      inset 0 -1px 0 rgba(255, 255, 255, 0.95);
    opacity: 0.72;
    user-select: none;
    pointer-events: none;
    white-space: nowrap;
  }
  .currency-pill.locked {
    opacity: 0.55;
    cursor: not-allowed;
  }

  /* 时间 + 付款人: 等宽两列; stack gap 已与金额区拉开 */
  .sheet-layout .field-grid {
    display: grid;
    gap: 12px;
    width: 100%;
    max-width: 100%;
  }
  .sheet-layout .field-grid-time-payer {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    align-items: start;
    overflow: hidden;
  }
  .sheet-layout .field-time,
  .sheet-layout .field-payer {
    min-width: 0;
    width: 100%;
    max-width: 100%;
    overflow: hidden;
  }
  /* 覆盖全局 #occurredAt { max-width: 260px } — 半宽列里会横向溢出 */
  .sheet-layout .field-time input[type="datetime-local"]#occurredAt {
    box-sizing: border-box;
    width: 100%;
    max-width: 100% !important;
    min-width: 0 !important;
    height: 44px;
    min-height: 44px;
    overflow: hidden;
    padding-inline: 8px;
    font-size: 13px;
  }
  .sheet-layout .field-time input[type="datetime-local"]#occurredAt::-webkit-datetime-edit,
  .sheet-layout .field-time input[type="datetime-local"]#occurredAt::-webkit-datetime-edit-fields-wrapper {
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
  }
  .sheet-layout .field-time input[type="datetime-local"]#occurredAt::-webkit-calendar-picker-indicator {
    margin-left: 2px;
    flex-shrink: 0;
  }
  .sheet-layout .field-payer select#payer {
    box-sizing: border-box;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    height: 44px;
    min-height: 44px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sheet-layout .preset-row {
    margin: 0;
    padding-bottom: 0;
  }
  .sheet-layout .preset-chip {
    padding: 4px 10px;
    font-size: 12px;
    min-height: 28px;
  }
  .sheet-layout input#desc {
    min-height: 44px;
  }
  .sheet-layout .ppts-toggle-row {
    margin-top: 0;
  }

  /* v0.3.21 #110 (PO msg 18:46): <input type="datetime-local"> 在 iOS Safari
     有天然的 picker indicator + 隐式 min-width (~280px), 单纯 width: 100% 不会
     让它在小屏 (<=360px) 缩到合适宽度, 视觉上"超长+伸到页面外". 三件事:
     (1) min-width: 0 允许缩到小于 picker indicator 暗示的最小值
     (2) max-width: 100% 安全兜底, 永不超出父容器 (避免横向 overflow)
     (3) padding-block 减半 + 略缩字号, 让 56px 默认高度降到 ~40px, 跟
         上方"金额/付款人"等 row 节奏对齐, 减少纵向松散

     v0.3.21 #113 (PO msg 02:54 #7810): #110 只缩了 height, 没改 width.
     实际输入框还是 width:100% = 325.625px (iPhone 13), 内容 (date text
     "07/22/2026, 11:19 AM" + picker icon) 只占 ~240px, 中间 118px 空白,
     "超长" 视觉问题没解决. 改 max-width 100% → 240px, 让 input 收缩
     到刚好装下内容 + picker indicator, 视觉平衡. iPhone 13 (content 宽
     326px) 240 留 86px 空; iPhone SE 375 (content 311px) 240 留 71px 空;
     小屏 320 (content 256px) 240 超出 → 用 max-width: min(240px, 100%)
     兜底.

     v0.3.28 UAT 0724-1 #4 (commit be9d25b): 删 min(240px, 100%) → 单纯 100%.
     iPhone 13 实测 parent 156px (flex:1 + min-width:0), min(240, 100%) → 156.
     但 iOS Safari datetime-local native widget minimum content ~200px
     (picker icon 30px + locale-formatted content ~140px), 156px 容器下
     widget 渲染会溢出 input 框.

     v0.3.29 — UAT 0725-1 #6: 物理根因修. 之前 v0.3.24 Top #1 (padding-inline)
     + v0.3.28 #4 (max-width 100%) 都只缓解症状, 物理上 input box ~156px <
     widget ~200px 仍溢出. WebKit bug #119175 12 年未修, iOS 26.4 没改
     datetime-local 渲染规则. CSS max-width 只能压上限不能压下限, 任何
     padding 调整都不管用. 方案 B: 挪 occurredAt 到独立整行 .occurredAt-row
     (width: 100%, ~326px iPhone 13 content area), 物理给 widget 200px+
     container, 容纳 picker indicator 30px + locale text 140-170px + 8px margin.
     input width: 100% 现在真生效 (parent 已 full-width, 不再被 flex:1 兄弟
     amount 挤). padding-inline 12 16px 保留 (容纳 picker indicator 16px 右侧). */
  input[type="datetime-local"]#occurredAt {
    min-width: 0;
    width: 100%;
    max-width: 260px; /* v0.3.37 #2: constrength to ~widget+padding, 不再全宽撑长 */
    padding-block: 8px;
    padding-inline: 10px; /* v0.3.37 #2: symmetric 10px, 原 12px 16px → 10px 省 8px */
    font-size: 14px; /* v0.3.37 #2: 降 1px 跟其余 input 一致 */
    letter-spacing: -0.01em;
    /* v0.3.0729-4 #3: 时间文字垂直居中 */
    height: 40px;
    line-height: 1.2;
    display: flex;
    align-items: center;
  }
  input[type="datetime-local"]#occurredAt::-webkit-datetime-edit,
  input[type="datetime-local"]#occurredAt::-webkit-datetime-edit-fields-wrapper {
    display: flex;
    align-items: center;
    height: 100%;
    padding: 0;
  }
  input[type="datetime-local"]#occurredAt::-webkit-calendar-picker-indicator {
    align-self: center;
  }

  /* v0.3.29 — UAT 0725-1 #6: 时间 input 独立整行, full-width container 让 iOS Safari
     datetime-local widget (~200px implicit min-width) 不被挤. 跟上面 v0.3.23 #136
     "金额 + 时间 同行 flex:1 each" 是反方向改动 — 上次是把 amount 时间挤一排
     视觉对齐, 这次承认 datetime-local 物理需要独立 row 才能装下 native widget. */
  .occurredAt-row {
    width: 100%;
    margin-top: var(--space-3);
  }
  .occurredAt-row input[type="datetime-local"]#occurredAt {
    display: block;
  }

  /* v0.3.35 #1 — UAT 0725-3 #6 (PO msg #9088 batch): description 空提交红框玻璃.
   * 跟 toast.error 视觉同源 (rose→red rgba(244,63,94,...)).
   * inset highlight 保留白边, box-shadow 红色 3px ring + 24px halo 让红框玻璃在 form 内不刺眼. */
  input.input-error {
    border-color: rgba(244, 63, 94, 0.55) !important;
    background: linear-gradient(135deg, rgba(254, 226, 226, 0.32) 0%, rgba(254, 202, 202, 0.22) 100%) !important;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.5),
      inset 0 -1px 0 rgba(244, 63, 94, 0.12),
      0 0 0 3px rgba(244, 63, 94, 0.18),
      0 0 24px rgba(244, 63, 94, 0.20) !important;
  }

  /* v0.3.0728-2 #9 — UAT 0728-2 #9 BillForm 预设 chip row.
     8 个玻璃 pill chip (跟全站 .glass-pill 同族): rgba(15,23,42,0.04) bg + 1px rgba(15,23,42,0.06) border
     + saturate(180%) blur(4px) + 12px 12px padding + 12.5px font + 999px radius (pill).
     horizontal overflow-x: auto (iOS Safari 默认支持, 隐藏 scrollbar).
     click chip → description = preset. */
  .preset-row {
    display: flex;
    flex-wrap: nowrap;
    gap: 6px;
    margin: 0 0 8px;
    padding: 0 0 4px;
    overflow-x: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
    -webkit-overflow-scrolling: touch;
  }
  .preset-row::-webkit-scrollbar { display: none; }
  .preset-chip {
    flex: 0 0 auto;
    padding: 5px 11px;
    border-radius: 999px;
    background: rgba(15, 23, 42, 0.04);
    border: 1px solid rgba(15, 23, 42, 0.06);
    color: var(--gray-700, #334155);
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1.4;
    font-family: inherit;
    cursor: pointer;
    transition: background 150ms ease, border-color 150ms ease, transform 100ms ease;
    backdrop-filter: blur(4px) saturate(180%);
    -webkit-backdrop-filter: blur(4px) saturate(180%);
  }
  .preset-chip:hover {
    background: rgba(15, 23, 42, 0.08);
    border-color: rgba(15, 23, 42, 0.10);
  }
  .preset-chip:active {
    transform: scale(0.97);
  }
  .preset-chip:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

</style>
