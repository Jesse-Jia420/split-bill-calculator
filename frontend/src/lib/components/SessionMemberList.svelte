<script lang="ts">
  /**
   * SessionMemberList — 成员列表 (含 owner 过期提示).
   *
   * 历史: v0.1.4 sprint 起, 此组件原本只是简单 ul/li 列表. 路由 /sessions/[id]/+page.svelte
   * 后期已经把 members 列表内联渲染 (见 +page.svelte:478 块), SessionMemberList 沦为
   * 未引用组件. 但它的设计语言 (avatar + name + owner badge) 仍然保留作为
   * 复用样式 / 设计参考.
   *
   * v0.3.18 #64 (PO #6859 拍板 候选 A — 过期提示 inline header):
   *   - 整块包成 .section-card 玻璃 (rgba(255,255,255,0.55) + saturate(180%) blur(20px)).
   *   - 头部 .header 横向 flex: 标题左 + 过期提示右.
   *   - .expiry-inline 11px / gray-500 + 时钟 SVG icon (11px / opacity 0.6) —
   *     只在 anon owner 场景下渲染 (owner_email 缺 + invite_expires_at 存在).
   *   - 成员从 list item 重做成 .chip (avatar 28×28 + 名字) —
   *     头像渐变 indigo/pink/emerald/amber/blue (按 index 循环, 跟全站风格统一).
   *   - .chip.selected: bg rgba(59,130,246,0.10) + border rgba(59,130,246,0.5).
   *   - .fade.edge: 右侧 20px 渐变遮罩 (跟 v0.3.18 #55 #1 成员 fade 对齐).
   *
   * 数据流 (PO 拍板保留):
   *   - members: SessionMember[] (主数据).
   *   - owner_email: string | null (anon hint 触发条件之一).
   *   - invite_expires_at: string | null (anon hint 触发条件之一).
   *   - selected_user_id: string | null (当前选中 member, 用于 .chip.selected 状态).
   *   - on_select: (user_id: string) => void (chip 点击回调, 保留可选).
   *   - 选中 / 过期 / 行为 全部 optional (组件仍然支持纯展示模式).
   */
  import type { SessionMember } from '$api/sessions';

  export let members: SessionMember[] = [];
  /** v0.3.18 #64: owner 邮箱 (anon owner 时为 null/empty), 用于 anon hint 触发. */
  export let owner_email: string | null = null;
  /** v0.3.18 #64: anon owner 邀请过期时间 ISO string. */
  export let invite_expires_at: string | null = null;
  /** v0.3.18 #64: 当前选中 member id (用于 .chip.selected 状态). */
  export let selected_user_id: number | null = null;
  /** v0.3.18 #64: chip 点击回调 (optional, 不传则 chip 不可点). */
  export let on_select: ((user_id: number | null) => void) | undefined = undefined;

  function initial(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return '?';
    // 中文: 取首字; 英文: 取首字母
    const code = trimmed.codePointAt(0) ?? 0;
    if (code > 127) return trimmed.slice(0, 1);
    return trimmed.slice(0, 2).toUpperCase();
  }

  /** v0.3.18 #64: avatar 渐变 (5 色循环 — 跟全站风格统一). */
  // v0.3.23 #132 (UAT old #4, PO msg 17:16 option B): rgba alpha 0.88 + backdrop-filter + glass shadow
  //   让 .avatar / .ppt-avatar / .avatar-a / .avatar-mini 在 glass parent 上有"glass on glass"视觉
  const AVATAR_GRADIENTS = [
    'linear-gradient(135deg, rgba(99, 102, 241, 0.88) 0%, rgba(168, 85, 247, 0.88) 100%)', // indigo → purple
    'linear-gradient(135deg, rgba(236, 72, 153, 0.88) 0%, rgba(244, 63, 94, 0.88) 100%)', // pink → rose
    'linear-gradient(135deg, rgba(16, 185, 129, 0.88) 0%, rgba(20, 184, 166, 0.88) 100%)', // emerald → teal
    'linear-gradient(135deg, rgba(245, 158, 11, 0.88) 0%, rgba(234, 179, 8, 0.88) 100%)', // amber → yellow
    'linear-gradient(135deg, rgba(59, 130, 246, 0.88) 0%, rgba(6, 182, 212, 0.88) 100%)', // blue → cyan
  ];
  function avatarGradient(index: number): string {
    return AVATAR_GRADIENTS[index % AVATAR_GRADIENTS.length];
  }

  /** v0.3.18 #64: anon owner 判定 (owner_email 缺失/空 + invite_expires_at 存在). */
  $: is_anon_owner = !owner_email && !!invite_expires_at;

  /** v0.3.18 #64: 格式化剩余天数 / 时间. */
  function formatExpiry(iso: string): string {
    const target = new Date(iso).getTime();
    const now = Date.now();
    const diffMs = target - now;
    if (diffMs <= 0) return '已过期';
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 60) return `${diffMin} 分钟后过期`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH} 小时后过期`;
    const diffD = Math.floor(diffH / 24);
    return `${diffD} 天后过期`;
  }

  function handleChipClick(user_id: number | null) {
    if (on_select) on_select(user_id);
  }
</script>

<section class="section-card" data-sbc="member-list-section">
  <header class="header">
    <span class="header-title">成员</span>
    {#if is_anon_owner && invite_expires_at}
      <span class="expiry-inline" data-sbc="anon-expiry">
        <svg
          viewBox="0 0 24 24"
          width="11"
          height="11"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        <span>{formatExpiry(invite_expires_at)}</span>
      </span>
    {/if}
  </header>

  <div class="chip-row-wrapper">
    <ul class="chip-row list">
      {#each members as m, i (m.user_id)}
        <li class="chip-li">
          {#if on_select}
            <button
              type="button"
              class="chip clickable"
              class:selected={selected_user_id === m.user_id}
              on:click={() => handleChipClick(m.user_id)}
            >
              <span class="avatar" aria-hidden="true" style={avatarGradient(i)}>
                {initial(m.display_name)}
              </span>
              <span class="name">{m.display_name}</span>
              {#if m.role === 'owner'}
                <span class="role-pill owner">owner</span>
              {/if}
            </button>
          {:else}
            <div
              class="chip"
              class:selected={selected_user_id === m.user_id}
            >
              <span class="avatar" aria-hidden="true" style={avatarGradient(i)}>
                {initial(m.display_name)}
              </span>
              <span class="name">{m.display_name}</span>
              {#if m.role === 'owner'}
                <span class="role-pill owner">owner</span>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    <!-- v0.3.18 #64 (PO 候选 A): 右侧 fade edge — 跟 v0.3.18 #55 #1 成员 fade 对齐 -->
    <span class="fade-edge" aria-hidden="true"></span>
  </div>
</section>

<style>
  /* v0.3.18 #64 (PO 候选 A — 过期提示 inline header):
   *   玻璃 section card 包整块, 跟全站玻璃语言统一. */
  .section-card {
    background: rgba(255, 255, 255, 0.55);
    backdrop-filter: saturate(180%) blur(20px);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    border-radius: 16px;
    padding: 16px;
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.05);
  }

  /* 头部布局: 标题左 + 过期提示右, 中间 gap 12px, 下方 hairline 分隔. */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding-bottom: 12px;
    border-bottom: 1px solid rgba(0, 0, 0, 0.05);
  }
  .header-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--gray-700);
    letter-spacing: 0.01em;
  }

  /* 过期提示 inline (anon owner 时渲染): 11px / gray-500 + 时钟 SVG icon 11px / opacity 0.6. */
  .expiry-inline {
    font-size: 11px;
    color: var(--gray-500);
    display: flex;
    align-items: center;
    gap: 4px;
    line-height: 1;
  }
  .expiry-inline svg {
    flex-shrink: 0;
    opacity: 0.6;
  }

  /* chip 行 wrapper: 相对定位给 .fade-edge 绝对定位用. */
  .chip-row-wrapper {
    position: relative;
    margin-top: 12px;
  }

  /* chip 行: 横向 flex 排列, gap 10px, 允许横向溢出 (mobile 上可以多 chip 滑动). */
  .chip-row {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    gap: 10px;
    overflow-x: auto;
    scrollbar-width: none; /* Firefox hide scrollbar */
    -ms-overflow-style: none; /* IE/Edge legacy hide scrollbar */
  }
  .chip-row::-webkit-scrollbar {
    display: none; /* Chrome/Safari hide scrollbar */
  }

  /* chip 本身: avatar (28x28) + name + 角色 pill (可选). */
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px 6px 6px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.6);
    border: 1px solid rgba(0, 0, 0, 0.06);
    flex-shrink: 0;
    transition:
      background 150ms ease-out,
      border-color 150ms ease-out;
  }
  .chip.clickable {
    cursor: pointer;
  }
  .chip.clickable:hover {
    background: rgba(255, 255, 255, 0.85);
    border-color: rgba(59, 130, 246, 0.3);
  }
  .chip.clickable:focus-visible {
    outline: 2px solid var(--accent-500);
    outline-offset: 2px;
  }
  .chip.selected {
    background: rgba(59, 130, 246, 0.10);
    border-color: rgba(59, 130, 246, 0.5);
  }

  /* v0.3.23 #132 (UAT old #4): avatar 28×28 圆形, 5 色循环 (按 index) + Option B 玻璃. */
  .avatar {
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 12px;
    line-height: 1;
    flex-shrink: 0;
    /* Option B: backdrop-filter + 半透明 → glass on glass */
    backdrop-filter: blur(4px) saturate(180%);
    -webkit-backdrop-filter: blur(4px) saturate(180%);
    /* glass shadow: top highlight + bottom lowlight + outer lift */
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.5),
      inset 0 -1px 0 rgba(0, 0, 0, 0.08),
      0 1px 2px rgba(0, 0, 0, 0.08);
  }

  .name {
    font-size: 13px;
    font-weight: 500;
    color: var(--gray-800);
    white-space: nowrap;
    line-height: 1.2;
  }

  .role-pill {
    font-size: 10px;
    font-weight: 600;
    color: white;
    padding: 2px 8px;
    border-radius: 999px;
    background: linear-gradient(
      135deg,
      rgba(99, 102, 241, 0.85) 0%,
      rgba(59, 130, 246, 0.85) 100%
    );
    line-height: 1.3;
    flex-shrink: 0;
  }
  /* v0.3.18 #64 (PO 候选 A — 保留现状 v0.3.18 #55 #1 成员 fade):
   *   右侧 20px 渐变透明遮罩, 提示用户可以横向滑动看更多 chip. */
  .fade-edge {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 20px;
    pointer-events: none;
    background: linear-gradient(
      to right,
      rgba(255, 255, 255, 0) 0%,
      rgba(255, 255, 255, 0.55) 100%
    );
    border-top-right-radius: 999px;
    border-bottom-right-radius: 999px;
  }
</style>