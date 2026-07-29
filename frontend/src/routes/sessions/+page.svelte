<script lang="ts">
  /**
   * v0.1.3 Sprint 3 (2026-07-02) — session 列表页。
   *
   * 本次 Commit 2 改动:
   * - T14 EmptyState: 0 sessions 时用 EmptyState (inbox icon) 替代原来的
   *   朴素 "card + 文字 + 按钮" 组合,视觉与 Linear / Wise 看齐。
   *
   * 沿用:
   * - Sprint 1: format tokens (千分位已迁到 SessionCard 内部)
   * - Sprint 2: 不动 /sessions/+page.svelte 本体
   * - Sprint 3 Commit 1: SkeletonCard 3 个 loading 占位
   */
  import { onMount } from 'svelte';
  import { loadSessions, sessions } from '$stores/sessions';
  import SessionCard from '$components/SessionCard.svelte';
  import SkeletonCard from '$components/SkeletonCard.svelte';
  import EmptyState from '$components/EmptyState.svelte';
  import { toast } from '$stores/toast';

  // v0.3.36 #1.1 — 跟 #9 同源 regression: 文件含 $state() (swipedId) 进入 runes mode 后,
  // plain `let loading = true` 写入 loading = false 不触发响应式更新.
  // sessions 列表页面永远停留在 SkeletonCard 状态. 修法: loading 改 $state() 包装.
  let loading = $state(true);

  // v0.3.36 #1 — UAT 0728-1 #1 (PO 字面 "账本 item 滑动删除按钮跨 item 互斥"):
  // 父 sessions/+page.svelte 加 inline swipedId state, 传给 SessionCard props + on:swipechange 事件.
  // 类似 v0.3.28 #3 settle page swipe 互斥模式 — 父管 state, child 通过 prop 读/写.
  // 新 swipe 触发时: SessionCard dispatch 'swipechange' 事件带新 swipe id, parent set swipedId = id
  // → 其他 SessionCard 收到 swipedId !== session.id 自动收起 swipe. type number 跟 session.id 一致.
  let swipedId: number | null = $state(null);
  // v0.3.0728-3 #3 — list-top hint 仅当用户拥有至少 1 个 session (即 hint 适用) 才显示.
  //   非 owner 用户看不到 "左划以删除账本" 提示 (因为他们没 delete-btn, 提示会误导).
  //   $sessions 是来自 session store (line ~22), $derived 自动 reactivity 跟随 store 变化.
  let hasOwnedSession = $derived(($sessions ?? []).some((s) => s.role === 'owner'));

  onMount(async () => {
    try {
      await loadSessions();
    } catch (e: any) {
      // v0.3.15 (PO #4807): 错误统一走 Toast
      toast.error(e?.message ?? '加载失败');
    } finally {
      loading = false;
    }
  });
</script>

<section style="padding-bottom: 120px;">
  <!-- v0.3.0729-2 #1+#2: hint 跟「我的账本」标题同一行 (右对齐) + 灰色描边弱化样式.
       旧版单独一行 + indigo 玻璃 pill 太显眼 (PO: "应该和账本标题文字在同一行" /
       "应更换边框的灰色文字展示，不应该像现在这么显眼"). -->
  <div class="row between sessions-title-row">
    <h2>我的账本</h2>
    {#if !loading && $sessions.length > 0 && hasOwnedSession}
      <div class="list-top-hint" data-testid="list-top-hint-delete" aria-label="左划以删除账本">
        <span class="swipe-arrow" aria-hidden="true">←</span>
        <span>左划以删除账本</span>
      </div>
    {/if}
  </div>

  {#if loading}
    <div class="stack">
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
    </div>
  {:else if $sessions.length === 0}
    <EmptyState
      icon="inbox"
      title="还没有任何账本"
      description="创建一个账本开始记账,或者接受朋友的邀请加入。"
    />
  {:else}
    <div class="stack">
      {#each $sessions as s (s.id)}
        <!-- v0.3.36 #1: 传 swipedId prop + on:swipechange 事件 (Svelte 4 syntax, SessionCard 内部
             createEventDispatcher<{ swipechange: number | null }> 派发). 父管 state, child 通过
             prop 读/写; swipe 状态变更时 child dispatch 事件让 parent 集中管理. -->
        <SessionCard
          session={s}
          {swipedId}
          on:swipechange={(e) => (swipedId = e.detail)}
        />
      {/each}
    </div>
  {/if}

  <!-- v0.3.27 (UAT 0723-2 #10): 「新建账本」按钮改为 与「新建账单」按钮 同款 FAB,
       位置 bottom: 28px right: 28px (跟 /sessions/[id] .fab 一致).
       v0.3.27-#17 (PO 0723-3 续): FAB bg 条件化 - 0 sessions 时深色强调引导,
       有 sessions 时回到浅色 (原 v0.3.17 默认值). -->
  <a
    class="fab glass-pill"
    class:emphasized={!loading && $sessions.length === 0}
    href="/sessions/new"
    title="新建账本"
    aria-label="新建账本"
  >+</a>
</section>

<style>
  /* v0.3.27 (UAT 0723-2 #10): FAB 样式跟 /sessions/[id] .fab 完全一致 (复制独立一份,
     因为 Svelte scoped CSS 不能跨组件).
     v0.3.27-#17 (PO 0723-3 续): FAB bg 条件化 — 有 sessions 浅色 (默认, v0.3.17 原值),
     0 sessions 深色 (.emphasized 状态). 取消箭头改走颜色引导路径. */
  /* v0.3.34 #2 — UAT 0726-1 #2 (PO 字面 "和账单列表页添加账单按钮完全一致"):
     sessions/+page.svelte .fab CSS 完全复制 /sessions/[id]/+page.svelte 1787+ 同名 CSS.
     v0.3.33 #5 (批次 02345b3) 改 sessions fab bg 深 (0.18/0.14) + border 1.5px 0.35 + 加 indigo shadow
     + font-weight 500 + line-height 76px — 跟 bills fab 完全不一致. PO 字面要 "完全一致".

     注: v0.3.33 #5 当时注解 "实测 0.04/0.02 太淡 + '+' 字乱码". 这个 "+" 渲染问题会再次出现.
     后续 (sprint 之后) 如 PO 反馈 "+" 渲染, 用 pseudo-element ::before 渲染 indigo bg + ::after 渲染 "+"
     单独处理, 不再改 bg/border/shadow. 当前 sprint 仅字面执行 PO 完全一致要求.

     保留: .fab.emphasized (0 sessions 引导深色状态, 仅 sessions 页需要, bills 页不需要). */
  .fab {
    position: fixed;
    right: 28px;
    bottom: 28px;
    width: 80px;
    height: 80px;
    border-radius: 50%;
    background: linear-gradient(135deg, rgba(99,102,241,0.04) 0%, rgba(59,130,246,0.02) 100%);
    border: 1px solid rgba(99,102,241,0.18);
    font-size: 36px;
    font-weight: 300;
    line-height: 1;
    z-index: 50;
    cursor: pointer;
    display: grid;
    place-items: center;
    padding: 0;
    padding-bottom: 3px;
    text-decoration: none;
    transition: transform 150ms ease, box-shadow 150ms ease, background 150ms ease, color 150ms ease;
  }
  /* .fab:hover / .fab:active / .fab:focus-visible 跟 bills fab 一致 — 由 .glass-pill 全局 hover 提供. */
  /* v0.3.27-#17 (PO 0723-3 续): 0 sessions 状态 — FAB 颜色更深以引导创建.
     保持 v0.3.27 设计: bg alpha 0.32/0.26 + border 1px 0.50 (跟 v0.3.27 #17 原始值, 跟 .fab 默认浅色差一档). */
  .fab.emphasized {
    background: linear-gradient(
      135deg,
      rgba(99, 102, 241, 0.32) 0%,
      rgba(59, 130, 246, 0.26) 100%
    );
    border: 1px solid rgba(99, 102, 241, 0.50);
  }
  @media (max-width: 600px) {
    .fab {
      right: 20px;
      bottom: 20px;
    }
  }

  .sessions-title-row {
    margin-bottom: var(--space-4);
    align-items: center;
    gap: var(--space-3);
  }
  .sessions-title-row h2 {
    margin: 0;
    min-width: 0;
  }
  /* v0.3.0729-2 #1+#2: 跟标题同行的灰色描边 hint (弱化, 不抢视觉).
     旧 indigo 玻璃 pill (accent-700 + rgba(99,102,241,*) bg) 太显眼. */
  .list-top-hint {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    flex: 0 0 auto;
    margin: 0;
    padding: 2px 8px;
    background: transparent;
    border: 1px solid rgba(15, 23, 42, 0.14);
    border-radius: 9999px;
    color: var(--gray-500, #737373);
    font-size: 11px;
    font-weight: 400;
    line-height: 1.4;
    letter-spacing: -0.005em;
    pointer-events: none;
    white-space: nowrap;
  }
  .list-top-hint .swipe-arrow {
    font-weight: 500;
    font-size: 11px;
    color: var(--gray-400, #a3a3a3);
  }
</style>
