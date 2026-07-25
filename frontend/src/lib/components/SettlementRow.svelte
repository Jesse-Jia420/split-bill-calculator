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
-->
<script lang="ts">
  import type { SettlementRecord } from '$api/settlements';
  import { formatMoney } from '$lib/utils/format';
  import { currencySymbol } from '$lib/utils/currency';

  export let record: SettlementRecord;
  /** Current acting SessionMember.id -- controls delete button visibility. */
  export let sessionMemberId: number;
  /** Optional delete callback. Parent handles the API call + refetch. */
  export let onDelete: ((recordId: number) => void | Promise<void>) | undefined = undefined;

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

  $: canDelete = record.created_by === sessionMemberId;
  $: payerPal = PALETTE[paletteIndex(record.payer_id)];
  $: payeePal = PALETTE[paletteIndex(record.payee_id)];
</script>

<div
  class="record-row"
  data-sbc="settlement-row"
  data-record-id={record.id}
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
      on:click={() => onDelete?.(record.id)}
    >✕</button>
  {/if}
</div>

<style>
  /* PO 字面 "玻璃 row 头像 → 头像 + 金额 + 时间"; 跟全站 glass 语言同源 (mockup 5 record-row). */
  .record-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border-bottom: 1px solid rgba(15, 23, 42, 0.05);
  }
  /* v0.3.33 — UAT 0725-3 #2 (PO 14:59 batch):
     avatar 跟 SessionMemberList + BillForm .ppt-avatar 同款 Option B 玻璃 (v0.3.23 #132).
     之前 SettlementRow 自己一套: 28x28 但 font-size 11px + text-shadow 让 initial 模糊,
     跟成员 section 头像对不齐. 改为跟 SessionMemberList 完全同款 (font-size 12px, no text-shadow).
     背景渐变继续用 palette inline style (5 色按 payer_id / payee_id 稳定 hash). */
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
</style>