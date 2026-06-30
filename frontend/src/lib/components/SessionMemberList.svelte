<script lang="ts">
  import type { SessionMember } from '$api/sessions';

  export let members: SessionMember[] = [];

  function initial(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return '?';
    // 中文: 取首字; 英文: 取首字母
    const code = trimmed.codePointAt(0) ?? 0;
    if (code > 127) return trimmed.slice(0, 1);
    return trimmed.slice(0, 2).toUpperCase();
  }
</script>

<ul class="member-list list">
  {#each members as m (m.user_id)}
    <li class="row">
      <div class="avatar" aria-hidden="true">{initial(m.display_name)}</div>
      <div class="info">
        <div class="name">{m.display_name}</div>
        <div class="muted email">{m.email}</div>
      </div>
      {#if m.role === 'owner'}
        <span class="role owner">owner</span>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .member-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .member-list li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) 0;
  }
  .avatar {
    flex: 0 0 auto;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--color-accent);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: var(--font-size-base);
  }
  .info {
    flex: 1;
    min-width: 0;
  }
  .name {
    font-weight: 500;
  }
  .email {
    font-size: var(--font-size-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
</style>