<script lang="ts">
  /**
   * v0.1.3 Sprint 2 Commit 1 — Session card (sessions 列表页)。
   *
   * 本次 Commit 1 改动:
   * - T6 千分位: 日期改用 formatDate()。
   * - Token alias 迁移: var(--color-*) → var(--*) 主 token。
   *
   * v0.3.18 #64 (PO #6859 拍板 候选 C — 渐变玻璃 + 浮起感 Liquid Glass):
   *   - .session-card 改三段 indigo→purple→blue 渐变玻璃 (0.22→0.30 alpha).
   *   - backdrop-filter saturate(220%) blur(28px) 强玻璃.
   *   - border 1px rgba(255,255,255,0.5) 半透明白 (跟白色边框层叠, 跟渐变 bg 形成
   *     紫色光晕 outline).
   *   - border-radius 18px / padding 18px.
   *   - rest shadow: inset 0 1px 0 rgba(255,255,255,0.6) + 0 1px 4px + 0 4px 16px
   *     紫色光晕.
   *   - hover shadow: 更重 + 紫色 ring + translateY(-3px) 浮起.
   *   - transition 240ms ease-out (box-shadow / transform / border-color).
   *   - title 17px / 700 / var(--accent-700) (#1d4ed8) — PO 拍板蓝色意图保留.
   *   - owner pill: 渐变 indigo→blue 玻璃 + white text + 紫色 outer shadow.
   *   - member pill: white/0.5 + gray-500 (对比 owner 更克制).
   *   - meta 13px / gray-500.
   *   - 数据流不变 (SessionSummary prop).
   *
   * v0.3.18 #67 (PO #6865 反馈 #2 颜色太过鲜艳 拍板 A — 单一玻璃, 详见
   *   design-mocks/v0318-67-sessioncard-tone-tokens.json §tone_A):
   *   - 卡片背景: 三色 indigo→purple→blue 0.22→0.30 alpha 渐变
   *       → linear-gradient(135deg, rgba(255,255,255,0.82), rgba(255,255,255,0.65))
   *         纯白玻璃 (回 v0318-62-task-1 拍板).
   *   - backdrop-filter: saturate(220%) blur(28px) →
   *       saturate(180%) blur(20px) brightness(1.02) (饱和度 + 模糊度双降, 玻璃感保留但不过强).
   *   - border: rgba(255,255,255,0.5) → rgba(255,255,255,0.75).
   *   - box-shadow: 紫光晕 → 灰阴影 (inset top highlight + inset bottom lowlight +
   *       微投影 + 主浮起, 跟全站 #30 iOS app-shell 克制感对齐).
   *   - ::before sheen overlay: top 60% rgba(255,255,255,0.45)→0, opacity 0.55
   *       (玻璃厚度, #62 一致).
   *   - hover transform: translateY(-3px) → translateY(-2px) (浮起感保留但不活泼).
   *   - hover bg: 纯白玻璃加深 (0.82→0.92, 0.65→0.78).
   *   - hover shadow: 紫阴影 + 紫 ring → 灰阴影 (无紫 ring).
   *   - transition: 240ms ease-out → 200ms cubic-bezier(0.34, 1.56, 0.64, 1) spring +
   *       background 200ms ease (#62 同款 spring).
   *   - title: 17px / 700 / var(--accent-700) (#1d4ed8) → 16px / 600 / var(--gray-900)
   *       (跟全站克制感对齐, PO 反馈蓝色太鲜艳).
   *   - owner pill: 渐变 indigo→blue 0.85 + white text + 紫outer shadow →
   *       浅 indigo 玻璃 rgba(165,180,252,0.45)→rgba(99,102,241,0.22) + indigo-700 text
   *       + rgba(99,102,241,0.28) border + blur(8px) + inset highlight + 紫光晕
   *       (回 v0318-62 拍板浅 indigo 玻璃).
   *   - owner pill padding: 4px 10px → 3px 9px / font-size: 12px → 11px.
   *   - member pill: white/0.5 + rgba(255,255,255,0.6) border → white/0.55 +
   *       rgba(15,23,42,0.08) border + blur(8px) + inset highlight.
   *   - 加 .dot-led (owner pill 内 6x6 circle 指示灯, currentColor + opacity 0.85).
   *   - meta margin-top: 10px → 12px / font-size: 13px → 12.5px (#62 拍板).
   *   - meta dot color: gray-500 → gray-300 (#d4d4d4, #62 拍板).
   *   - meta count 加粗: font-weight 600 + color gray-700.
   *   - 响应式: 768px padding 22px/radius 22px/title 18px/meta 13.5px,
   *             320px padding 14px/radius 16px/title 15px/meta 12px (#62 拍板).
   */
  import type { SessionSummary } from "$api/sessions";
  import { formatDate } from "$lib/utils/format";

  export let session: SessionSummary;
</script>

<a href="/sessions/{session.id}" class="card-link">
  <div class="session-card">
    <div class="row between">
      <div class="title">{session.name}</div>
      <span class="role" class:owner={session.role === "owner"}>
        {#if session.role === "owner"}<span class="dot-led"></span>{/if}
        {session.role === "owner" ? "owner" : "member"}
      </span>
    </div>
    <div class="meta">
      <span class="count"><b>{session.member_count ?? 1}</b> 人</span>
      <span class="dot">·</span>
      <span class="muted">{formatDate(session.created_at)}</span>
    </div>
  </div>
</a>

<style>
  .card-link {
    text-decoration: none;
    color: inherit;
    display: block;
  }
  /* v0.3.18 #67 (PO #6865 反馈 #2 拍板 A — 单一玻璃):
   *   - 纯白玻璃 (回 v0318-62-task-1 拍板).
   *   - saturate 220% → 180%, blur 28px → 20px (玻璃感保留但不过强).
   *   - 顶部 sheen ::before overlay (玻璃厚度).
   *   - 灰阴影 (inset top highlight + inset bottom lowlight + 微投影 + 主浮起).
   *   - 跟全站 #30 iOS app-shell 克制感对齐. */
  .session-card {
    position: relative;
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.82) 0%,
      rgba(255, 255, 255, 0.65) 100%
    );
    backdrop-filter: saturate(180%) blur(20px) brightness(1.02);
    -webkit-backdrop-filter: saturate(180%) blur(20px) brightness(1.02);

    border: 1px solid rgba(255, 255, 255, 0.75);
    border-radius: 18px;
    padding: 18px;

    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.85),
      inset 0 -1px 0 rgba(15, 23, 42, 0.04),
      0 1px 2px rgba(15, 23, 42, 0.04),
      0 6px 18px rgba(15, 23, 42, 0.05);

    transition:
      transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1),
      box-shadow 200ms ease,
      background 200ms ease;
    overflow: hidden;
  }

  /* v0.3.18 #67: 顶部 sheen overlay (玻璃厚度). */
  .session-card::before {
    content: "";
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 60%;
    pointer-events: none;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.45) 0%, rgba(255, 255, 255, 0) 100%);
    opacity: 0.55;
  }

  /* v0.3.18 #67: hover 浮起 -2px (克制) + 玻璃加深, 无紫 ring. */
  .card-link:hover .session-card {
    transform: translateY(-2px);
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.92) 0%,
      rgba(255, 255, 255, 0.78) 100%
    );
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.95),
      inset 0 -1px 0 rgba(15, 23, 42, 0.05),
      0 2px 4px rgba(15, 23, 42, 0.05),
      0 12px 28px rgba(15, 23, 42, 0.08);
  }

  /* v0.3.18 #67: title 16px / 600 / gray-900 (回 v0318-62 拍板, 跟全站克制感对齐). */
  .title {
    font-size: 16px;
    font-weight: 600;
    color: var(--gray-900);
    letter-spacing: -0.2px;
  }

  /* v0.3.18 #67: role-pill 共享样式 (回 v0318-62 拍板).
   *   - owner: 浅 indigo 玻璃 + indigo-700 text + 紫光晕 (身份信息保留).
   *   - member: 白色半透明 + gray-500 (克制). */
  .role {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 3px 9px;
    border-radius: 999px;
    line-height: 1;
    flex-shrink: 0;
  }
  .role.member {
    color: var(--gray-500);
    background: rgba(255, 255, 255, 0.55);
    border: 1px solid rgba(15, 23, 42, 0.08);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7);
  }
  .role.owner {
    color: #4338ca;
    background: linear-gradient(
      135deg,
      rgba(165, 180, 252, 0.45) 0%,
      rgba(99, 102, 241, 0.22) 100%
    );
    border: 1px solid rgba(99, 102, 241, 0.28);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.6),
      0 1px 3px rgba(99, 102, 241, 0.10);
  }
  .role .dot-led {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.85;
  }

  /* v0.3.18 #67: meta 12.5px / gray-500, margin-top 12px (回 v0318-62 拍板). */
  .meta {
    margin-top: 12px;
    display: flex;
    gap: var(--space-2);
    font-size: 12.5px;
    line-height: 1.4;
    color: var(--gray-500);
  }
  .meta .count b {
    font-weight: 600;
    color: var(--gray-700);
  }
  .dot {
    color: var(--gray-300);
  }
  .muted {
    color: var(--gray-500);
  }

  /* v0.3.18 #67: 响应式 (回 v0318-62 拍板). */
  @media (min-width: 720px) {
    .session-card {
      padding: 22px;
      border-radius: 22px;
    }
    .title {
      font-size: 18px;
    }
    .meta {
      font-size: 13.5px;
    }
  }

  @media (max-width: 340px) {
    .session-card {
      padding: 14px;
      border-radius: 16px;
    }
    .title {
      font-size: 15px;
    }
    .meta {
      font-size: 12px;
    }
  }
</style>
