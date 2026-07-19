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
   */
  import type { SessionSummary } from '$api/sessions';
  import { formatDate } from '$lib/utils/format';

  export let session: SessionSummary;
</script>

<a href="/sessions/{session.id}" class="card-link">
  <div class="session-card">
    <div class="row between">
      <div class="title">{session.name}</div>
      <span class="role" class:owner={session.role === 'owner'}>
        {session.role === 'owner' ? 'owner' : 'member'}
      </span>
    </div>
    <div class="meta">
      <span class="muted">{session.member_count ?? 1} 人</span>
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
  /* v0.3.18 #64 (PO #6859 候选 C): 渐变玻璃 + 浮起感 Liquid Glass.
   *   - 三段渐变 bg (0.22 → 0.30 alpha) 形成紫色光晕.
   *   - saturate(220%) blur(28px) 强玻璃 (把背景 peach→rose→lavender 透过来).
   *   - inset highlight + outer indigo shadow 双层光源, 卡片有「被照亮」感.
   *   - 紫色 ring 在 hover 时浮现, 提示可点 + 焦点区.
   *   - translateY(-3px) 浮起感 (PO 拍板「Liquid Glass 浮起」). */
  .session-card {
    background: linear-gradient(
      135deg,
      rgba(99, 102, 241, 0.22) 0%,
      rgba(168, 85, 247, 0.25) 50%,
      rgba(59, 130, 246, 0.30) 100%
    );
    backdrop-filter: saturate(220%) blur(28px);
    -webkit-backdrop-filter: saturate(220%) blur(28px);

    border: 1px solid rgba(255, 255, 255, 0.5);
    border-radius: 18px;
    padding: 18px;

    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.6),
      0 1px 4px rgba(99, 102, 241, 0.08),
      0 4px 16px rgba(99, 102, 241, 0.06);

    transition:
      box-shadow 240ms ease-out,
      transform 240ms ease-out,
      border-color 240ms ease-out;
  }

  /* v0.3.18 #64: hover 浮起 + 紫色 ring. */
  .card-link:hover .session-card {
    transform: translateY(-3px);
    border-color: rgba(255, 255, 255, 0.7);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.7),
      0 4px 12px rgba(99, 102, 241, 0.16),
      0 8px 32px rgba(99, 102, 241, 0.10),
      0 0 0 3px rgba(99, 102, 241, 0.10);
  }

  /* v0.3.18 #64: title 17px / 700 / accent-700 (PO 蓝色意图保留, 比之前 gray-900 更突出品牌). */
  .title {
    font-size: 17px;
    font-weight: 700;
    color: var(--accent-700);
    letter-spacing: -0.01em;
  }

  /* v0.3.18 #64: role-pill — owner 用渐变玻璃胶囊 (强调), member 用白底克制胶囊.
   *   - owner: 蓝紫渐变 + white text + 紫色 outer shadow, 视觉权重跟 title 平衡.
   *   - member: 白色半透明 + gray-500, 不抢眼. */
  .role {
    font-size: 12px;
    font-weight: 600;
    padding: 2px 10px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.5);
    color: var(--gray-500);
    border: 1px solid rgba(255, 255, 255, 0.6);
    flex-shrink: 0;
    line-height: 1.3;
  }
  .role.owner {
    padding: 4px 10px;
    background: linear-gradient(
      135deg,
      rgba(99, 102, 241, 0.85) 0%,
      rgba(59, 130, 246, 0.85) 100%
    );
    color: white;
    border-color: rgba(255, 255, 255, 0.5);
    box-shadow: 0 1px 3px rgba(99, 102, 241, 0.3);
  }

  /* v0.3.18 #64: meta 行 13px / gray-500. */
  .meta {
    margin-top: 10px;
    display: flex;
    gap: var(--space-2);
    font-size: 13px;
    line-height: 1.4;
  }
  .dot {
    color: var(--gray-500);
  }
  .muted {
    color: var(--gray-500);
  }
</style>