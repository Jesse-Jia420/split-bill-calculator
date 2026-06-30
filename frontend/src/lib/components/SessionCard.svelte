<script lang="ts">
  import type { SessionSummary } from '$api/sessions';

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
      <span class="muted">{new Date(session.created_at).toLocaleDateString('zh-CN')}</span>
    </div>
  </div>
</a>

<style>
  .card-link {
    text-decoration: none;
    color: inherit;
    display: block;
  }
  .card-link:hover .session-card {
    border-color: var(--color-accent);
  }
  .session-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    padding: var(--space-4);
    transition: border-color var(--transition);
  }
  .title {
    font-weight: 600;
    font-size: var(--font-size-lg);
    color: var(--color-text);
  }
  .role {
    font-size: var(--font-size-sm);
    color: var(--color-text-muted);
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
  }
  .role.owner {
    color: var(--color-accent);
    border-color: var(--color-accent);
  }
  .meta {
    margin-top: var(--space-2);
    display: flex;
    gap: var(--space-2);
    font-size: var(--font-size-sm);
  }
  .dot {
    color: var(--color-text-muted);
  }
</style>