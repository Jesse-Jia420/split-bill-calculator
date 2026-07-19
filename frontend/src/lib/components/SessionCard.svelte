<script lang="ts">
  /**
   * v0.1.3 Sprint 2 Commit 1 — Session card (sessions 列表页)。
   *
   * 本次 Commit 1 改动:
   * - T6 千分位: 日期改用 formatDate()。
   * - Token alias 迁移: var(--color-*) → var(--*) 主 token。
   */
  import type { SessionSummary } from '$api/sessions';
  import { formatDate } from '$lib/utils/format';

  export let session: SessionSummary;
</script>

<a href="/sessions/{session.id}" class="card-link">
  <div class="session-card glass-pill">
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
  /* v0.3.18 #60 batch2 (PO #6836): .session-card 现在挂 .glass-pill,
   * 全局 .glass-pill 已提供 bg / border / box-shadow / backdrop-filter / hover.
   * 因此删掉原 border/background/padding/transition 基础样式,
   * hover 反馈走 .glass-pill:hover 默认 (translateY(-1px) + 渐变 bg 加深). */
  .title {
    font-weight: 600;
    font-size: var(--font-size-lg);
    color: var(--gray-900);
  }
  .role {
    font-size: var(--font-size-sm);
    color: var(--gray-500);
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--gray-50);
    border: 1px solid var(--gray-200);
  }
  .role.owner {
    color: var(--accent-500);
    border-color: var(--accent-500);
  }
  .meta {
    margin-top: var(--space-2);
    display: flex;
    gap: var(--space-2);
    font-size: var(--font-size-sm);
  }
  .dot {
    color: var(--gray-500);
  }
  .muted {
    color: var(--gray-500);
  }
</style>
