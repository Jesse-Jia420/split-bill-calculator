<!--
  SettlementRow.svelte -- v0.3.32 -- UAT 0725-2 #1

  PO 字面 "用户可以增加 已结算的记录" -- FE 显示一条 settlement_records 的 row.
  形态 (mockup 5 record-row): 头像 → 头像 + (name → name) + amount + meta + ✕ delete (仅 owner).

  视觉:
  - 玻璃 row style (跟 .transfer-card 同源 Liquid Glass -- inset highlight + outer shadow).
  - 28px 头像 + 16px arrow mini (跟 .transfer-card 同族).
  - 删除按钮仅在 created_by === sm.id 时显示 (PO 字面 "添加者可删" -- 跟 BE 403 一致).

  数据流:
  - record: SettlementRecord (BE SettlementRecordOut, amount 是 string).
  - sessionMemberId: number (当前 session_member.id, 用于判断删除按钮可见).
  - onDelete: () => void (点 ✕ 触发, parent 调 DELETE + refetch).

  行为约束:
  - 本组件不调 API, 只 emit-style 回调. parent 负责 refetch + toast.
  - 金额显示用 formatMoney(amount, { currency: record.currency, showSymbol: false }) + 货币符号 (currencySymbol).
  - 时间用 Intl.DateTimeFormat zh-CN (跟项目其他组件同款 locale).

  v0.3.36 #15 — UAT 0727-1 #15 (Jesse msg 2026-07-27 23:35 "e.a"):
    PO 字面 "已结算记录 section 下的 item 如果超长, 则每个独立的 item 可以左右滚动.
    不要改变目前每个 item 内部的结构."
    拍板方案 e.a = 左/右边缘渐变阴影 (iOS Mail / Telegram 风格).

    实现:
    - root div 加 .scroll-wrapper class (跟 .record-row 共存, 复用现有 flex 布局)
    - .scroll-wrapper CSS: position: relative + overflow-x: auto + 隐藏 scrollbar
    - ::before / ::after 28px 双层渐变阴影 (白 mask 0.85 + 深 slate scrim 0.10)
      opacity 0 → 1 由 .at-start / .at-end class 控制
    - $effect 监听 scroll + ResizeObserver → 切换 at-start / at-end class
    - 配套 3 处 CSS 微调 (允许 flex children 自然撑开触发 wrapper 滚动):
      * .row-info min-width: 0 → auto  (内容驱动宽度, 不提前收缩)
      * .row-meta overflow: hidden / text-overflow: ellipsis 移除  (meta 字符串溢出由 wrapper 滚动展示)
      * .row-name white-space: nowrap  (名字不换行, 保持横向溢出)
    - 内部 [avatar][name→name][meta][amount] DOM 顺序/字体/padding 100% 不变
-->
<script lang="ts">
  import type { SettlementRecord } from '$api/settlements';
  import { formatMoney } from '$lib/utils/format';
  import { currencySymbol } from '$lib/utils/currency';

  // v0.3.36 #15: convert to Svelte 5 runes mode ($props + $derived + $effect).
  // 项目其他组件大多用 Svelte 4 syntax (export let + $:), 但 $effect 仅在 runes mode 下可用,
  // 且 runes mode 下 export let 会 compile error (Svelte 5.56 strict). 本组件 runes-mode 化.
  let { record, sessionMemberId, onDelete = undefined }: {
    record: SettlementRecord;
    sessionMemberId: number;
    onDelete?: ((recordId: number) => void | Promise<void>) | undefined;
  } = $props();

  // 5-color palette (跟 SessionMemberList 一致, 保持视觉同源)
  const PALETTE: ReadonlyArray<string> = [
    'linear-gradient(135deg, rgba(99, 102, 241, 0.88) 0%, rgba(168, 85, 247, 0.88) 100%)', // indigo
    'linear-gradient(135deg, rgba(236, 72, 153, 0.88) 0%, rgba(244, 63, 94, 0.88) 100%)', // pink
    'linear-gradient(135deg, rgba(16, 185, 129, 0.88) 0%, rgba(20, 184, 166, 0.88) 100%)', // emerald
    'linear-gradient(135deg, rgba(245, 158, 11, 0.88) 0%, rgba(234, 179, 8, 0.88) 100%)', // amber
    'linear-gradient(135deg, rgba(59, 130, 246, 0.88) 0%, rgba(6, 182, 212, 0.88) 100%)', // blue
  ];

  // 简单 hash: payer_id 稳定映射到 0..4 索引.
  // 不要求 cryptographically unique -- 只用于跨 session 跨 render 给同 member 稳定颜色.
  function paletteIndex(memberId: number): number {
    const s = String(memberId);
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h) % PALETTE.length;
  }

  function initialOf(name: string): string {
    const trimmed = (name ?? '').trim();
    if (!trimmed) return '?';
    const code = trimmed.codePointAt(0) ?? 0;
    if (code > 127) return trimmed.slice(0, 1);
    return trimmed.slice(0, 2).toUpperCase();
  }

  function fmtAmount(amountStr: string, currency: string): string {
    const n = Number(amountStr);
    if (Number.isNaN(n)) return amountStr;
    return currencySymbol(currency) + formatMoney(n, { currency, showSymbol: false });
  }

  function fmtDate(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
  }

  let canDelete = $derived(record.created_by === sessionMemberId);
  let payerPal = $derived(PALETTE[paletteIndex(record.payer_id)]);
  let payeePal = $derived(PALETTE[paletteIndex(record.payee_id)]);

  // v0.3.36 #15 — UAT 0727-1 #15 scroll handler.
  // bind:this 在 mount 后 populate rowEl, $effect 跑一次 (after mount), 此时 rowEl 已就绪.
  // 不需要 $state (rowEl 只读一次, 不需 reactivity).
  let rowEl: HTMLElement | undefined;

  $effect(() => {
    const el = rowEl;
    if (!el) return;
    const update = () => {
      // 1px tolerance 处理 subpixel / 浏览器浮点精度 (跟 mockup 脚本同款)
      el.classList.toggle('at-start', el.scrollLeft <= 1);
      el.classList.toggle(
        'at-end',
        el.scrollLeft + el.clientWidth >= el.scrollWidth - 1
      );
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    // ResizeObserver 处理 record 增删 / viewport 旋转 / 字体变化导致的 scrollWidth 变化
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  });
</script>

<div
  class="record-row scroll-wrapper"
  data-sbc="settlement-row"
  data-record-id={record.id}
  bind:this={rowEl}
>
  <span class="avatar" style={payerPal} aria-hidden="true">{initialOf(record.payer_name)}</span>
  <span class="arrow-mini" aria-hidden="true">→</span>
  <span class="avatar" style={payeePal} aria-hidden="true">{initialOf(record.payee_name)}</span>
  <div class="row-info">
    <div class="row-from-to">
      <span class="row-name">{record.payer_name}</span>
      <span class="row-arrow" aria-hidden="true">→</span>
      <span class="row-name">{record.payee_name}</span>
    </div>
    <div class="row-meta">
      {record.currency} · {fmtDate(record.created_at)}
      {#if record.note}<span class="note-inline" title={record.note}>· {record.note}</span>{/if}
    </div>
  </div>
  <div class="row-amount">{fmtAmount(record.amount, record.currency)}</div>
  {#if canDelete}
    <button
      class="delete-mini"
      type="button"
      aria-label="删除记录"
      title="删除"
      onclick={() => onDelete?.(record.id)}
    >✕</button>
  {/if}
</div>

<style>
  /* v0.3.32 — UAT 0725-2 #1 (PO 字面 "用户可以增加 已结算的记录").
     v0.3.33 — UAT 0725-3 #2 (PO 14:59 batch): avatar 跟 SessionMemberList + BillForm .ppt-avatar 同款 Option B 玻璃.
     v0.3.36 #15 — UAT 0727-1 #15: 超长 item 横向滚动 affordance (左/右渐变阴影, 拍板方案 e.a).
       内部 [avatar][name→name][meta][amount] 顺序/字体/padding 全保持原样 (不动),
       仅外层 wrapper 加 .scroll-wrapper class + overflow-x: auto + ::before/::after 渐变阴影. */
  .record-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border-bottom: 1px solid rgba(15, 23, 42, 0.05);
  }
  .avatar {
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    color: #fff;
    border: 1.5px solid #fff;
    backdrop-filter: blur(4px) saturate(180%);
    -webkit-backdrop-filter: blur(4px) saturate(180%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.5),
      inset 0 -1px 0 rgba(0, 0, 0, 0.08),
      0 1px 2px rgba(0, 0, 0, 0.08);
  }
  .arrow-mini { color: #a3a3a3; font-size: 12px; padding: 0 1px; }
  .row-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .row-from-to {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .row-name {
    font-size: 14px;
    font-weight: 500;
    color: #171717;
  }
  .row-arrow { color: #737373; font-size: 12px; }
  .row-meta {
    font-size: 11px;
    color: #737373;
    font-variant-numeric: tabular-nums;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .note-inline { font-style: italic; color: #525252; }
  .row-amount {
    font-size: 14px;
    font-weight: 600;
    color: #10b981;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .delete-mini {
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: transparent;
    color: #a3a3a3;
    font-size: 11px;
    font-weight: 600;
    flex-shrink: 0;
    border: 0;
    cursor: pointer;
    transition: background 150ms ease, color 150ms ease;
  }
  .delete-mini:hover {
    background: rgba(244, 63, 94, 0.10);
    color: #be123c;
  }
  .delete-mini:focus-visible {
    outline: 2px solid var(--accent-500, #3b82f6);
    outline-offset: 2px;
  }

  /* ============================================================
   * v0.3.36 #15 — SettlementRow 横向滚动 wrapper (拍板 e.a)
   * ------------------------------------------------------------
   * PO 字面 (msg 2026-07-27 23:35 "e.a"): 已结算记录 section 下的 item 如果超长,
   * 则每个独立的 item 可以左右滚动. 不要改变目前每个 item 内部的结构.
   * 拍板方案 e.a = 左/右边缘渐变阴影 (iOS Mail / Telegram 风格).
   *
   * 实现要点:
   * - position: relative: 让 ::before/::after 锚定 wrapper 自身 (而非 viewport)
   * - overflow-x: auto + scrollbar 隐藏: 内容溢出时横向滚动, 滚动条不可见
   * - ::before / ::after 28px 双层渐变阴影 (白 mask 0.85 + 深 slate scrim 0.10),
   *   opacity 0 → 1 由 .at-start / .at-end class 控制 (联动由 $effect 监听 scroll 切换)
   * - 依赖下方 .row-info / .row-meta / .row-name 三处 CSS 微调:
   *   flex children 不收缩, 让内容真实撑开触发 wrapper 横向滚动
   * ============================================================ */
  .scroll-wrapper {
    position: relative;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  .scroll-wrapper::-webkit-scrollbar { display: none; }
  .scroll-wrapper::before, .scroll-wrapper::after {
    content: '';
    position: absolute;
    top: 0; bottom: 0;
    width: 28px;
    pointer-events: none;
    z-index: 2;
    opacity: 0;
    transition: opacity 200ms ease;
  }
  .scroll-wrapper::before {
    left: 0;
    background:
      linear-gradient(to right, rgba(15, 23, 42, 0.10) 0%, rgba(15, 23, 42, 0) 100%),
      linear-gradient(to right, rgba(255, 255, 255, 0.85) 0%, rgba(255, 255, 255, 0) 100%);
  }
  .scroll-wrapper::after {
    right: 0;
    background:
      linear-gradient(to left, rgba(15, 23, 42, 0.10) 0%, rgba(15, 23, 42, 0) 100%),
      linear-gradient(to left, rgba(255, 255, 255, 0.85) 0%, rgba(255, 255, 255, 0) 100%);
  }
  .scroll-wrapper:not(.at-start)::before { opacity: 1; }
  .scroll-wrapper:not(.at-end)::after { opacity: 1; }

  /* v0.3.36 #15 — 配套微调 (让 record 内容真实撑开 wrapper 触发滚动):
   * - .row-info min-width: 0 → auto: 内容驱动宽度, 不提前收缩 (wrapper 才有机会横向溢出)
   * - .row-meta 去掉 overflow:hidden / text-overflow:ellipsis: 让 meta 字符串溢出,
   *   由 wrapper 滚动展示完整内容 (替代原本 .row-meta 内的 ellipsis)
   * - .row-name 加 white-space: nowrap: 名字不换行, 保持横向溢出
   *
   * 注: record 内部 [avatar][name→name][meta][amount] DOM 顺序/字体/padding 100% 不变,
   * 仅 CSS 调整 3 处允许 wrapper 滚动. 不引入新 design token, 复用现有 white/gray-50/900. */
  .row-info {
    min-width: auto;
  }
  .row-meta {
    overflow: visible;
    text-overflow: clip;
  }
  .row-name {
    white-space: nowrap;
  }
</style>