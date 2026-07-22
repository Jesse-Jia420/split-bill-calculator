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
      <!-- v0.3.23 #140 (UAT bug #7): 账本名称加 pill 玻璃效果.
           原 .title 是裸 16px/600/gray-900 文字, 现加 inline-flex + 浅 indigo 玻璃 + backdrop-filter,
           跟 v0318-62 owner pill 同源视觉 (alpha + 白边 + blur). -->
      <div class="title title-pill">
        <span class="title-text">{session.name}</span>
      </div>
      <!-- v0.3.23 #140 (UAT bug #7): owner 标识去 pill 玻璃.
           原 .role.owner 是完整 indigo 玻璃 pill (渐变 + 白边 + blur), 现去背景框 + 去 backdrop,
           留 .dot-led + indigo-700 text 纯文字. 跟 mockup B/C 一致. -->
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
   *   - 跟全站 #30 iOS app-shell 克制感对齐.
   *
   * v0.3.23 #139 (UAT bug #6): 玻璃质感增强 — 减白透明度 (0.82→0.75, 0.65→0.50)
   *   让 backdrop-filter blur/saturate 更明显, 模糊背景透出来. saturate 180→200%,
   *   blur 20→24px. border 1px → 1.5px (更厚边缘), shadow 主浮起加深 18→22px.
   *   hover 同步加深 (12→16px 外阴影) 让悬停更显眼. */
  .session-card {
    position: relative;
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.75) 0%,
      rgba(255, 255, 255, 0.50) 100%
    );
    backdrop-filter: saturate(200%) blur(24px) brightness(1.04);
    -webkit-backdrop-filter: saturate(200%) blur(24px) brightness(1.04);

    border: 1.5px solid rgba(255, 255, 255, 0.78);
    border-radius: 18px;
    padding: 18px;

    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.88),
      inset 0 -1px 0 rgba(15, 23, 42, 0.04),
      0 1px 2px rgba(15, 23, 42, 0.05),
      0 8px 22px rgba(15, 23, 42, 0.07);

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
      rgba(255, 255, 255, 0.88) 0%,
      rgba(255, 255, 255, 0.68) 100%
    );
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.95),
      inset 0 -1px 0 rgba(15, 23, 42, 0.05),
      0 2px 4px rgba(15, 23, 42, 0.05),
      0 14px 32px rgba(15, 23, 42, 0.09);
  }

  /* v0.3.18 #67: title 16px / 600 / gray-900 (回 v0318-62 拍板, 跟全站克制感对齐).
   * v0.3.23 #140 (UAT bug #7): title 加 pill 玻璃 — 浅 indigo 玻璃 + 白边 + backdrop-filter.
   *   跟 v0318-62 owner pill 同源视觉 (linear-gradient indigo + 白边 + inset highlight).
   *   max-width 240px + text-overflow ellipsis 跟 list 卡片宽度对齐. */
  .title {
    font-size: 16px;
    font-weight: 600;
    color: var(--gray-900);
    letter-spacing: -0.2px;
  }
  .title-pill {
    display: inline-flex;
    align-items: center;
    padding: 6px 12px;
    border-radius: 999px;
    background: linear-gradient(
      135deg,
      rgba(165, 180, 252, 0.28) 0%,
      rgba(99, 102, 241, 0.18) 100%
    );
    border: 1px solid rgba(99, 102, 241, 0.30);
    backdrop-filter: blur(8px) saturate(180%);
    -webkit-backdrop-filter: blur(8px) saturate(180%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.55),
      0 1px 3px rgba(99, 102, 241, 0.08);
    flex-shrink: 1;
    min-width: 0;
    max-width: 240px;
  }
  .title-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  /* v0.3.23 #140 (UAT bug #7): owner 标识去 pill 玻璃 — 纯文字标签.
   *   原 owner 有完整 indigo 玻璃 pill (渐变 + 白边 + blur), 现去背景框 + 去 backdrop,
   *   留 .dot-led + indigo-700 text 纯文字. 跟 mockup B/C 一致.
   *   member 维持纯文字 (无玻璃, gray-500), 跟 owner 视觉对齐 (都纯文字).
   *   padding 仍保留让文字区域有呼吸空间. */
  .role {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 3px 9px;
    line-height: 1;
    flex-shrink: 0;
  }
  .role.member {
    color: var(--gray-500);
  }
  .role.owner {
    color: #4338ca;
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
