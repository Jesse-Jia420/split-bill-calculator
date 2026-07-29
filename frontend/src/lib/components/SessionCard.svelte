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
   *
   * v0.3.23 #139 (UAT bug #6): 玻璃质感增强 — 减白透明度 (0.82→0.75, 0.65→0.50)
   *   让 backdrop-filter blur/saturate 更明显, 模糊背景透出来. saturate 180→200%,
   *   blur 20→24px. border 1px → 1.5px (更厚边缘), shadow 主浮起加深 18→22px.
   *   hover 同步加深 (12→16px 外阴影) 让悬停更显眼.
   *
   * v0.3.23 #140 (UAT bug #7): owner pill ↔ name pill swap —
   *   name 加 pill 玻璃 + owner 去 pill 玻璃, 纯文字.
   *
   * v0.3.24 #9 (UAT bug 账本 item 重设计): 玻璃更透 + 人 icon 人数移到 row 最左.
   *   PO 字面意图: "刚刚的选 mockup b, 增加 item 玻璃透明度, 并把 人 icon 人数移到同一行的最左边"
   *   设计稿: mockup-B-refined.html
   *   改动:
   *   1. .session-card bg alpha 0.75/0.50 → 0.62/0.38 (玻璃更透, -17%/-24%)
   *   2. backdrop-filter blur(24px)→blur(28px) brightness(1.04)→brightness(1.05)
   *      (补偿玻璃厚度)
   *   3. hover 状态 bg alpha 0.78/0.55 (同步加深)
   *   4. .row-bottom DOM 拆 3 段 — .date (左) | .avatars (中右) | .users-count (右)
   *      (v0.3.24 #9.3 flip — PO msg #8299 反馈: "日期放在最左边,人数放在最右边,
   *      头像放在人数的左边,挨着人数".)
   *   5. .users-count 新增 (users icon + N, 替换原 .meta .count "N 人")
   *   6. .row-bottom .date 独立 (无 .dot 分隔符, 在 row 最左)
   *   7. .avatar-mini 新增 5 palette × 18×18 (跟 /sessions/[id] 折叠态一致)
   *   8. 删 .meta / .meta .count / .meta .dot / .muted 旧样式
   *   avatars 占位: SessionSummary 当前不含 avatars 数组 (后端 #9 后续 sprint 补),
   *   前端先用 N 个 palette 渐变实心圆点占位 (member_count 决定数量, MAX_AVATARS=6).
   *   视觉仍跟 mockup refined 的 avatar stack 一致, 只是无 initial 文字.
   *
   * v0.3.24 #9.1 (续 #9 PO msg #8269 反馈, 已被 #9.3 flip 取代): row-bottom layout fix —
   *   users-count + avatars 紧挨, date 独立最右. (后续被 #9.3 反向.)
   *
   * v0.3.24 #9.3 (续 #9.1 PO msg #8299 反馈 flip): 日期最左 + 人数最右 + 头像挨人数.
   *   PO 字面反馈: "日期放在最左边,人数放在最右边,头像放在人数的左边,挨着人数"
   *   修法 (flip #9.1 方向):
   *     1. DOM 重排: date | avatars | users-count (之前 users-count | avatars | date)
   *     2. CSS: .row-bottom .date margin-left: auto → 删 (date 不再 auto 推到右)
   *     3. CSS: .avatars 加 margin-left: auto (avatars + users-count 整组被推到右)
   *   结果: date — gap(10px) — [auto-fill] — avatars — gap(10px) — users-count (right).
   *
   * v0.3.24 #9.2 (续 avatar size 调整, PO msg #8280 反馈 "太小看不清有谁"):
   *   原 .avatar-mini 18×18 在 iPhone 13 @3x 仅占 54 logical pixel, 头像内文字糊掉.
   *   实测代码 Coder 简化方案是纯 palette 圆点无 initial, 更看不清.
   *   调整:
   *     1. width/height 18→24px (+33%)
   *     2. font-size 9→12px (= size/2, mockup 9=18/2 比例延续, 未来 backend
   *        avatars 字段补 initial 时字体比例就绪)
   *     3. border 1.5px 保留 (微缩进圈边界感)
   *     4. margin-left: -4.5→-6px (25% overlap, 跟原 18*0.25=4.5 同比例)
   *        6 个 24px + overlap -6px = 24 + 5*18 = 114px width,
   *        card 内 row-bottom 横向 ≈ users(24) + 10 + 114 + auto + date(70) ≈ 充裕
   *   其它 (row-top / glass params / avatar palette / overflow 样式) 不动.
   */
  import type { SessionSummary } from "$api/sessions";
  import { formatDate } from "$lib/utils/format";
  import { apiFetch } from "$api/client";
  import { goto } from "$app/navigation";
  import { toast } from "$stores/toast";
  import { removeSession } from "$stores/sessions";
  import { writable, get, type Writable } from "svelte/store";

  // v0.3.28 UAT 0724-1 #3 (PO 拍板 "swipe 才出现"): 删除按钮从 always-visible 改为
  // 左滑才出现 (跟 BillListGrouped 账单 item swipe gesture 同款). 复用其 store + 6 函数
  // 模板 (dragOffsetStore / swipeOffsetStore / isDraggingStore / openSwipeIdStore +
  // startDrag/moveDrag/endDrag/cancelDrag/onTouchStart/onTouchMove/onTouchEnd/onTouchCancel/
  // onMouseDown/onWindowMouseMove/onWindowMouseUp + rubberBandProgress).
  // SessionCard 跟 BillListGrouped 唯一不同:
  //   - key 用 session.id (SessionCard 一张卡一个 session, 账单 item 一个 bill)
  //   - 只有 right swipe action (左滑 = 右边缘显红删除按钮, 跟账单 item 删账动作一致)
  //   - 没左滑 edit action (账本 item 没有 edit 概念)
  // 单分支铁律 + 删 owner-only 守卫跟 #2 一致 (session.role === 'owner').
  const dragOffsetStore: Writable<Record<number, number>> = writable({});
  const swipeOffsetStore: Writable<Record<number, number>> = writable({});
  const isDraggingStore: Writable<Record<number, boolean>> = writable({});
  const openSwipeIdStore: Writable<number | null> = writable(null);

  let dragId: number | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragLastX = 0;
  let dragAxis: 'h' | 'v' | null = null;
  let lastDragEndTime = 0;

  // v0.3.0728-2 #16 — UAT 0728-2 #16 账本列表删除按钮 swipe 跟手延迟修复 (PO msg 16:50).
  // 原 moveDrag 每帧 dragOffsetStore.update() 触发 Svelte 重渲, 写入 --swipe-progress CSS var,
  // 走 reactive cycle → template 重渲染 → browser paint. 这个过程在低端 iPhone Safari 上会有 ~50-100ms 跟手延迟.
  // 修法: 拿到 delete-btn DOM ref, moveDrag 直接写 element.style.--swipe-progress (CSS var inline),
  // 绕过 Svelte reactivity (不 update store, 仅 mutate style attr). endDrag 才走 store,
  // 那一帧只有一次 reactive update, 不影响拖动体验.
  let wrapEl: HTMLDivElement | null = null;
  let deleteBtnEl: HTMLButtonElement | null = null;

  // v0.3.28 UAT 0724-1 #3: 跟 BillListGrouped 同步, ACTION_WIDTH = 56 (Apple HIG
  // ≥ 44pt, 56 跟 row 高度协调). 但 SessionCard 删账按钮 #2 修复时是 28×28 真圆
  // (always-visible 设计意图), 现在 supersede 为 swipe-style 56×56. min-height: 0
  // 覆盖全局 button min-height: 44px 跟 #2 同样的修法.
  const ACTION_WIDTH = 56;
  const SWIPE_THRESHOLD = 60;
  const TAP_THRESHOLD = 10;

  function rubberBandProgress(rowOffset: number): number {
    const abs = Math.abs(rowOffset);
    if (abs <= ACTION_WIDTH) return abs / ACTION_WIDTH;
    const overshoot = abs - ACTION_WIDTH;
    return 1 + (1 - Math.exp(-overshoot / 30)) * 0.5;
  }

  function getRowOffset(id: number): number {
    const dragging = get(isDraggingStore)[id];
    const dragVal = get(dragOffsetStore)[id] ?? 0;
    const swipeVal = get(swipeOffsetStore)[id] ?? 0;
    return dragging ? dragVal : swipeVal;
  }

  function startDrag(id: number, clientX: number, clientY: number) {
    dragId = id;
    dragStartX = clientX;
    dragStartY = clientY;
    dragLastX = clientX;
    dragAxis = null;
    const curOpen = get(openSwipeIdStore);
    if (curOpen !== null && curOpen !== id) {
      swipeOffsetStore.update((o) => ({ ...o, [curOpen]: 0 }));
      openSwipeIdStore.set(null);
    }
    const baseOffset = get(swipeOffsetStore)[id] ?? 0;
    dragOffsetStore.update((o) => ({ ...o, [id]: baseOffset }));
    isDraggingStore.update((o) => ({ ...o, [id]: true }));
  }

  function moveDrag(id: number, clientX: number, clientY: number, e?: MouseEvent | TouchEvent) {
    if (dragId !== id) return;
    const dx = clientX - dragStartX;
    const dy = clientY - dragStartY;

    if (dragAxis === null) {
      if (Math.abs(dx) < TAP_THRESHOLD && Math.abs(dy) < TAP_THRESHOLD) return;
      dragAxis = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      if (dragAxis === 'h' && e && 'cancelable' in e && e.cancelable) {
        e.preventDefault();
      }
    }

    if (dragAxis === 'v') return;
    if (Math.abs(dx) < TAP_THRESHOLD && (get(swipeOffsetStore)[id] ?? 0) === 0) return;

    dragLastX = clientX;
    let next = (get(swipeOffsetStore)[id] ?? 0) + (clientX - dragStartX);
    if (next > 300) next = 300;
    if (next < -300) next = -300;
    // v0.3.0728-2 #16: 拖动期间直接写 deleteBtnEl.style.--swipe-progress, 不走 store 重渲.
    // 仅左滑 (-0) 才有 visible delete-btn (右滑 0, 不显). rightProgress = rubberBandProgress(-next) when next < 0.
    if (deleteBtnEl) {
      const rightProgress = next < 0 ? rubberBandProgress(-next) : 0;
      // 直接写入 inline style. CSS var --swipe-progress 已被 .delete-btn width/opacity 使用.
      deleteBtnEl.style.setProperty('--swipe-progress', String(rightProgress));
    }
    dragOffsetStore.update((o) => ({ ...o, [id]: next }));
  }

  function endDrag(id: number) {
    if (dragId !== id) return;
    const finalOffset = get(dragOffsetStore)[id] ?? 0;
    if (Math.abs(finalOffset) >= SWIPE_THRESHOLD) {
      const snap = finalOffset > 0 ? ACTION_WIDTH : -ACTION_WIDTH;
      swipeOffsetStore.update((o) => ({ ...o, [id]: snap }));
      openSwipeIdStore.set(id);
      // v0.3.36 #1: swipe 打开 → 通知 parent 更新 swipedId state (跨 item 互斥).
      dispatch('swipechange', id);
    } else {
      swipeOffsetStore.update((o) => ({ ...o, [id]: 0 }));
      if (get(openSwipeIdStore) === id) openSwipeIdStore.set(null);
      // v0.3.36 #1: swipe 未达阈值关 → 通知 parent 清 swipedId (如果本来是自己的).
      if (swipedId === id) dispatch('swipechange', null);
    }
    isDraggingStore.update((o) => ({ ...o, [id]: false }));
    dragOffsetStore.update((o) => ({ ...o, [id]: 0 }));
    dragId = null;
    dragAxis = null;
    dragStartX = 0;
    dragStartY = 0;
    dragLastX = 0;
    lastDragEndTime = Date.now();
  }

  function cancelDrag(id: number) {
    if (dragId === id) {
      swipeOffsetStore.update((o) => ({ ...o, [id]: 0 }));
      isDraggingStore.update((o) => ({ ...o, [id]: false }));
      dragOffsetStore.update((o) => ({ ...o, [id]: 0 }));
      dragId = null;
      dragAxis = null;
    }
  }

  function onTouchStart(e: TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
    startDrag(session.id, t.clientX, t.clientY);
  }
  function onTouchMove(e: TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
    moveDrag(session.id, t.clientX, t.clientY, e);
  }
  function onTouchEnd(_e: TouchEvent) {
    endDrag(session.id);
  }
  function onTouchCancel(_e: TouchEvent) {
    cancelDrag(session.id);
  }
  function onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    startDrag(session.id, e.clientX, e.clientY);
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);
    e.preventDefault();
  }
  function onWindowMouseMove(e: MouseEvent) {
    if (dragId === null) return;
    moveDrag(dragId, e.clientX, e.clientY, e);
  }
  function onWindowMouseUp(e: MouseEvent) {
    if (dragId === null) return;
    const id = dragId;
    endDrag(id);
    // v0.3.28 UAT 0724-1 #3 续修 6: mouseup preventDefault() 在 chromium synthetic
    // events 上可靠 — 阻止浏览器 dispatch synthetic click event on mousedown
    // target. 之前 mousedown preventDefault 不可靠 (Playwright 报告); mouseup
    // preventDefault 一致地阻止 click.
    e.preventDefault();
    e.stopPropagation();
    window.removeEventListener('mousemove', onWindowMouseMove);
    window.removeEventListener('mouseup', onWindowMouseUp);
  }

  function onWrapClick(e: MouseEvent) {
    // v0.3.28 UAT 0724-1 #3 续修 3: mouseup 触发的 synthetic click event 在 wrap
    // (target === currentTarget), SvelteKit router 看 wrap descendant <a> → 误判
    // navigation → /s/{code} → SessionCard unmount → button DOM 消失.
    // 修法: wrap 自身 click 直接 preventDefault + stopPropagation, 让 SvelteKit
    // router 看不到 (router 拦截的是 child <a> 的 click, wrap self-click 不该
    // 触发 nav). user 主动点 child (e.g. 标题) → click event 在 child fire,
    // target != wrap → guard 不触发 → 正常 bubble 到 <a> → navigate.
    if (e.target === e.currentTarget) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // v0.3.28 UAT 0724-1 #3 续修 2 (上一 commit): user tap child 不是 delete-btn →
    // 关 swipe (cancelDrag). wrap self-click 已在上方 guard 拦下.
    const curOpen = get(openSwipeIdStore);
    if (curOpen !== null) {
      const target = e.target as HTMLElement;
      if (!target.closest('.delete-btn')) {
        swipeOffsetStore.update((o) => ({ ...o, [curOpen]: 0 }));
        openSwipeIdStore.set(null);
        e.preventDefault();
        e.stopPropagation();
      }
    }
  }

  /**
   * v0.3.29 (UAT 0725-1 #4, PO msg 12:43): 点 wrap 外区域收起 delete-btn.
   * PO 字面: "如果用户点击或滑动了这个 item 外的其他地方, 刚刚这个删除按钮应收起".
   * 实现: svelte:window on:click 监听 + closest 过滤 — 如果 click target 不在任何
   * .session-swipe-wrap 内, reset 当前 open swipe (swipeOffsetStore + openSwipeIdStore).
   *
   * 跟现有 onWrapClick 的分工:
   * - onWrapClick 处理 **wrap 内部** click (user tap card content 不是 delete-btn → 关 swipe)
   * - onWindowClick 处理 **wrap 外部** click (点别的 card / header / navbar / backdrop → 关 swipe)
   *
   * 用 svelte:window (而非 onMount + window.addEventListener) 让 SvelteKit lifecycle
   * 自动 cleanup, 避免 listener 泄漏. bubble-phase 即可 (window 不在 capture path 起点).
   */
  function onWindowClick(e: MouseEvent) {
    const curOpen = get(openSwipeIdStore);
    if (curOpen === null) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest(".session-swipe-wrap")) return;
    // 点 wrap 外 → reset 当前 open swipe (跟 onWrapClick 同款机制)
    swipeOffsetStore.update((o) => ({ ...o, [curOpen]: 0 }));
    openSwipeIdStore.set(null);
  }

  // v0.3.36 #1 — UAT 0728-1 #1 (PO 字面 "账本 item 滑动删除按钮跨 item 互斥"):
  // 接受 parent swipedId prop + dispatch 'swipechange' 事件让 parent sessions/+page.svelte
  // 集中管理 state. 类似 v0.3.28 #3 settle page swipe 互斥模式 — 父管 state, child 通过
  // prop 读/写. swipeOffsetStore / openSwipeIdStore 仍保留 (子组件自己渲染用), 但 mutual
  // exclusion 走 parent swipedId prop 单一 source of truth.
  // v0.3.36 follow-up #2 (跟 v0.3.36 #16 等组件事件 listener 原则): Svelte 4 syntax
  // createEventDispatcher + on:eventname 保留 (component 事件, 不用 runes $effect 仿).
  import { createEventDispatcher } from 'svelte';
  const dispatch = createEventDispatcher<{ swipechange: number | null }>();
  export let session: SessionSummary;
  /** v0.3.36 #1: 父传递的 swipedId — null 表示无任何 swipe 打开, number 表示当前打开 swipe 的 session.id. */
  export let swipedId: number | null = null;
  // prop change → sync local store. 当 parent swipedId 变化 (其他 item swipe 打开), 自身 reset.
  $: if (swipedId !== session.id && (get(swipeOffsetStore)[session.id] !== 0 || get(openSwipeIdStore) === session.id)) {
    // 自身不是当前 swipe → reset local store.
    swipeOffsetStore.update((o) => ({ ...o, [session.id]: 0 }));
    if (get(openSwipeIdStore) === session.id) {
      openSwipeIdStore.set(null);
    }
  }

  /** v0.3.24 #9: 跟 mockup refined 一致 — 最多显示 6 个头像, 超出显示 +N. */
  const MAX_AVATARS = 6;

  /** v0.3.24 #9: 占位 avatars — N 个 palette 渐变实心圆点 (后端 avatars 字段后续 sprint 补).

   * v0.3.x (UAT 0723 #6): 后端现在返回 avatars: [{name, initial}], avatar
   * 圆点内显示 initial (e.g. "J" for "Jesse", "像" for "像汤圆一样圆").
   * 用 #each session.avatars ?? [] as avatar 渲染 — 老 client 没 avatars
   * 字段也不挂, 走 N 个 palette 渐变实心圆点 fallback (跟原 #9 占位一致). */
  $: memberCount = session.member_count ?? 1;
  $: displayAvatars = Math.min(memberCount, MAX_AVATARS);
  $: overflowCount = Math.max(0, memberCount - MAX_AVATARS);
  /** v0.3.x (UAT 0723 #6): true 表示 BE 已返 avatars 数组, FE 渲染 initial;
   * false 走老 fallback N 个 palette 渐变实心圆点 (跟原 #9 占位一致).
   * 严格 length > 0 查 (undefined 和 [] 都 fallback, 让老 client / 残缺
   * payload 不挂). */
  $: hasAvatars =
    Array.isArray(session.avatars) && session.avatars.length > 0;

  /** v0.3.25 #16 (UAT: /sessions item 加红色删除按钮, owner only):
   * 删除按钮 + confirm modal 状态. 删除按钮仅在 session.role === 'owner' 时显示.
   * non-owner 完全看不到按钮 (CSS 数据属性 [data-owner="false"] 隐藏).
   *
   * v0.3.28 UAT 0724-1 #3 (PO 拍板 "swipe 才出现"): 改 onSwipeDelete — 删按钮从
   * always-visible 改为 swipe-action, onSwipeDelete 是 swipe 打开后 (progress >= 1)
   * 点击触发, 跟 handleDeleteClick 同样的 modal 开启逻辑. */
  let showDeleteModal = false;
  let deleting = false;

  /** v0.3.28 UAT 0724-1 #3: 从 swipe-action button 调用. stopPropagation 避免冒泡
   * 到 .card-link 触发导航 (跟原 #16 handleDeleteClick 同款), 同时关掉 swipe 状态
   * 让卡片回到原位.
   * v0.3.36 #1: 关 swipe 后 dispatch 'swipechange' null 让 parent swipedId 清零. */
  function onSwipeDelete(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    swipeOffsetStore.update((o) => ({ ...o, [session.id]: 0 }));
    if (get(openSwipeIdStore) === session.id) openSwipeIdStore.set(null);
    dispatch('swipechange', null);
    showDeleteModal = true;
  }

  /** Esc 关闭 modal — 全站 modal UX 一致 (跟 InviteLinkButton / CurrencyAddModal 同款). */
  function handleKeydown(e: KeyboardEvent) {
    if (showDeleteModal && e.key === "Escape" && !deleting) {
      cancelDelete();
    }
  }

  function cancelDelete() {
    if (deleting) return;
    showDeleteModal = false;
  }

  /** 点 backdrop 关闭 modal (modal 内点击不冒泡). */
  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget && !deleting) {
      cancelDelete();
    }
  }

  /** 调 BE DELETE /sessions/{id} + 从 store 移除 + 跳 /sessions + toast 成功. */
  async function confirmDelete() {
    if (deleting) return;
    deleting = true;
    try {
      await apiFetch(`/sessions/${session.id}`, { method: "DELETE" });
      // 从 sessions store 移除 (立即更新 UI)
      removeSession(session.id);
      showDeleteModal = false;
      toast.success(`账本「${session.name}」已删除`);
      // 跳 /sessions 列表 (虽然 store 已更新, 但确保导航状态一致)
      await goto("/sessions");
    } catch (err: any) {
      console.error("[SessionCard] delete failed:", err);
      const msg =
        err?.body?.detail?.error === "owner role required"
          ? "仅 owner 可删除账本"
          : err?.status === 404
          ? "账本不存在"
          : "删除失败,请重试";
      toast.error(msg);
      deleting = false;
    }
  }
</script>

<svelte:window onclick={onWindowClick} />

<!-- v0.3.x (UAT #0723-3 #3): unguessable 10-char session_code (代替 /sessions/{id}).
     老 URL /sessions/{id} 仍工作 (UI 不再生成, 但用户书签/外部分享进仍
     能访问, 向后兼容). session_code 不是 nullable (BE SessionSummary 字段),
     但保险起见 fallback 到 String(session.id) (老 client 走 fallback). -->
<!-- v0.3.28 UAT 0724-1 #3 (PO 拍板 "swipe 才出现"): 整个 session-card 改成 swipe wrap 结构
     - 顶层 .session-swipe-wrap 包 swipe-action button + card-link
     - card-link 内 .session-card 跟 .row.between + .row-bottom 保持原 #9 / #139 / #140 layout
     - swipe gesture 复用 BillListGrouped 模板 (touch + mouse handlers 在 wrap 上)
     - onRowTap 关 swipe (点 card 内容, 不是点删除按钮) -->
<div
  class="session-swipe-wrap"
  data-testid="swipe-trigger"
  bind:this={wrapEl}
  ontouchstart={onTouchStart}
  ontouchmove={onTouchMove}
  ontouchend={onTouchEnd}
  ontouchcancel={onTouchCancel}
  onmousedown={onMouseDown}
  onclick={onWrapClick}
  role="group"
  aria-label="账本: {session.name}"
>
  <!-- v0.3.28 UAT 0724-1 #3: swipe 才出现的删除按钮. owner only (跟 #16 同).
       绝对定位右边缘 (跟 .bill-swipe-action-right 同款), width/opacity 跟随 --swipe-progress
       (rubberBandProgress(rowOffset<0 ? -rowOffset : 0) — 仅左滑显). -->
  {#if session.role === "owner"}
    {@const rowOffset = $isDraggingStore[session.id] ? ($dragOffsetStore[session.id] ?? 0) : ($swipeOffsetStore[session.id] ?? 0)}
    {@const rightProgress = rowOffset < 0 ? rubberBandProgress(-rowOffset) : 0}
    <button
      type="button"
      class="delete-btn"
      data-testid="swipe-action-delete"
      bind:this={deleteBtnEl}
      style="--swipe-progress: {rightProgress}"
      tabindex={rightProgress >= 1 ? 0 : -1}
      aria-hidden={rightProgress <= 0}
      aria-label="删除账本: {session.name}"
      onclick={(e) => { e.stopPropagation(); onSwipeDelete(e); }}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
        <path d="M10 11v6"/>
        <path d="M14 11v6"/>
        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
      </svg>
    </button>
  {/if}
  <a
    href="/s/{session.session_code || String(session.id)}"
    class="card-link"
    style="--swipe-clip-right: {($isDraggingStore[session.id] || ($swipeOffsetStore[session.id] ?? 0) < 0) ? rubberBandProgress(-($dragOffsetStore[session.id] ?? $swipeOffsetStore[session.id] ?? 0)) : 0}"
  >
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
    <!-- v0.3.0728-3 #3 — reverse v0.3.0728-2 #14: 删 per-item .swipe-hint.
         移到 /sessions/+page.svelte list 顶部 (single list-top hint, 不是 per-item).
         PO msg 2026-07-28 batch #3: "在我的账本页, 整个列表的右上方添加提示文字'左划以删除账本'.
         目前你在每个账本item内加的提示, 不对".
         这里 per-item 删掉, list 顶部加单 hint. -->
    <!-- v0.3.24 #9 (UAT bug 账本 item 重设计): row-bottom 拆 3 段
         v0.3.24 #9.3 flip (PO msg #8299 反馈):
         - 左: .date 独立 — 跟原 .meta .muted 一致, 但脱离 .dot 分隔符
         - 中: .avatars stack (palette 渐变实心圆点占位, 后续 sprint 后端补 avatars 字段)
         - 右: .users-count (icon + N) — 跟原 .meta .count "N 人" 视觉一致, 紧挨 avatars 在右
         flex space-between 自动三段分布.

         v0.3.24 #9.1 (续 #9 PO msg #8269 反馈): row-bottom layout fix —
         users-count + avatars 紧挨, date 独立最右. 改 .row-bottom (去掉 space-between) +
         .row-bottom .date (加 margin-left: auto), flex 自然流:
         users-count — gap(10px) — avatars — gap(10px) — [auto-fill] — date.
         详见顶部 script 注释 #9.1 段. -->
    <div class="row-bottom">
      <!-- LEFTMOST (v0.3.24 #9.3): 日期独立 (脱离 .meta / .dot).
           #9.3 flip 把 date 从最右挪到最左, 整组 avatars + users-count 推右 -->
      <div class="date">{formatDate(session.created_at)}</div>
      <!-- MIDDLE→RIGHT (v0.3.24 #9.3): avatars stack (palette 渐变实心圆点占位 — 后端 avatars 字段后续 sprint 补).
           #9.3 加 margin-left: auto 把整组 (avatars + users-count) 推到右.

           v0.3.x (UAT 0723 #6): BE 返回 avatars 后, .avatar-mini 圆点内
           显示 initial 字符 (e.g. "J" for "Jesse", "像" for "像汤圆一样圆").
           老 client 没 avatars 字段走 fallback (跟原 #9 占位一致 — N 个
           palette 渐变实心圆点). overflow +N 走 avatar-mini-overflow 不变. -->
      <div class="avatars" aria-label="{memberCount} 个成员头像">
        {#if hasAvatars}
          {#each (session.avatars ?? []).slice(0, MAX_AVATARS) as avatar, i (i)}
            <span
              class="avatar-mini palette-{i % 10}"
              aria-label={avatar.name}
              title={avatar.name}>{avatar.initial}</span>
          {/each}
          {#if overflowCount > 0}
            <span class="avatar-mini avatar-mini-overflow" aria-label="还有 {overflowCount} 个成员">+{overflowCount}</span>
          {/if}
        {:else}
          {#each Array(displayAvatars) as _, i (i)}
            <span class="avatar-mini palette-{i % 10}" aria-hidden="true"></span>
          {/each}
          {#if overflowCount > 0}
            <span class="avatar-mini avatar-mini-overflow" aria-label="还有 {overflowCount} 个成员">+{overflowCount}</span>
          {/if}
        {/if}
      </div>
      <!-- RIGHTMOST (v0.3.24 #9.3): users icon + 人数 (紧挨 avatars 在右) -->
      <div class="users-count" aria-label="{memberCount} 个成员">
        <svg class="users-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
        <span class="count">{memberCount}</span>
      </div>
    </div>
  </div>
  </a>
</div>

<!-- v0.3.25 #16 (UAT: /sessions item 加红色删除按钮, owner only):
     确认删除 modal. 跟 InviteLinkButton v0.3.24 #14 modal 风格一致
     (rgba backdrop + 玻璃 modal box + 圆角 18px + 手动关闭).
     modal 是 <a> 的 sibling, 不在 link 内, 避免 click 冒泡触发出导航. -->
{#if showDeleteModal}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div
    class="modal-backdrop"
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
    role="presentation"
  >
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div
      class="modal-box"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-modal-title"
      onclick={(e) => e.stopPropagation()}
    >
      <div class="modal-icon" aria-hidden="true">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
        </svg>
      </div>
      <h2 id="delete-modal-title" class="modal-title">删除账本</h2>
      <p class="modal-desc">
        确定删除账本 <strong>「{session.name}」</strong> 吗？
      </p>
      <p class="modal-desc modal-desc-secondary">
        此操作不可逆,所有账单、成员、汇率记录都会清除。
      </p>
      <div class="modal-actions">
        <button
          type="button"
          class="btn-cancel"
          onclick={cancelDelete}
          disabled={deleting}
        >取消</button>
        <button
          type="button"
          class="btn-danger"
          onclick={confirmDelete}
          disabled={deleting}
        >{deleting ? "删除中…" : "确认删除"}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* v0.3.28 UAT 0724-1 #3 (PO 拍板 "swipe 才出现"): 加 .session-swipe-wrap 包 swipe-action
   * button + card-link. position relative + overflow hidden 让绝对定位 button 在 wrap 内,
   * 但按钮宽度跟随 progress (--swipe-progress × 56px) 仍能在 wrap 边界内.
   * border-radius 跟 .session-card 一致 (18px), 让 button 视觉露在 card 边缘.
   * 触摸手势 (touchstart/touchmove/touchend + mousedown/mousemove/mouseup) 在 wrap 上.
   * 不可选 user-select 避免拖动时误选中卡片文字.
   * 关键: card-link 跟 .session-card clip-path 让 card 内的 row 内容左移时, 不让 button
   * 区域看到 (跟 BillListGrouped .bill-row clip-path 同款机制). */
  .session-swipe-wrap {
    position: relative;
    overflow: hidden;
    border-radius: 18px;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
    touch-action: pan-y;
  }

  .card-link {
    text-decoration: none;
    color: inherit;
    display: block;
    /* v0.3.29 (UAT 0725-1 #3, PO msg 12:43): 删 clip-path. 原 clip-path: inset(0 right 0 0)
     * 让 .session-card 右侧 "消失" (看似被切掉), PO 字面 "左滑的同时账本 item 右侧会消失,
     * 不要让它有这个效果". 改: card 内容满宽直通到 wrap 边界, .delete-btn (position: absolute,
     * right:6px, z-index:2) 直接罩在 card 右侧上, glass 玻璃透明仍能透出底层 card 内容
     * (跟 BillListGrouped v0.3.16 #14 hotfix 删 clip-path 同款 mechanism — button overlay on
     * top, 而不是挖洞让 button "露出来"). --swipe-clip-right CSS var 仍挂在 markup (line 432),
     * 但无 CSS rule 消费, 不影响视觉. 留 var 以备未来需要从 .session-card 上 read progress. */
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
   *   hover 同步加深 (12→16px 外阴影) 让悬停更显眼.
   *
   * v0.3.24 #9 (UAT bug 账本 item 重设计): 玻璃更透 — bg alpha 0.75/0.50 → 0.62/0.38
   *   (再 -17%/-24%, 让背景径向渐变更透出来). backdrop-filter blur 24→28px (补偿透明度损失
   *   让背后仍模糊), brightness 1.04→1.05 (微亮补偿). hover 同步加深到 0.78/0.55. */

  .session-card {
    position: relative;
    /* v0.3.0729-2 UAT #1: 再降透明度, 让背景纹理隐约透出 (0.30/0.15 → 0.22/0.10).
       路径: 0.75/0.50 → … → 0.30/0.15 → 0.22/0.10. */
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.22) 0%,
      rgba(255, 255, 255, 0.10) 100%
    );
    backdrop-filter: saturate(200%) blur(28px) brightness(1.05);
    -webkit-backdrop-filter: saturate(200%) blur(28px) brightness(1.05);

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
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.38) 0%, rgba(255, 255, 255, 0) 100%);
    opacity: 0.42;
  }

  /* v0.3.18 #67: hover 浮起 -2px (克制) + 玻璃加深, 无紫 ring.
   * v0.3.23 #139: hover bg alpha 0.88/0.68 (跟 #139 同步加深).
   * v0.3.24 #9: hover bg alpha 0.78/0.55 (mockup refined 字面值, 跟 base 0.62/0.38 同步加深). */
  .card-link:hover .session-card {
    transform: translateY(-2px);
    /* v0.3.0729-2 UAT #1: hover 跟 base 同步加深 (0.62/0.38 → 0.48/0.28). */
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.48) 0%,
      rgba(255, 255, 255, 0.28) 100%
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

  /* v0.3.24 #9 (UAT bug 账本 item 重设计): row-bottom 三段布局
     v0.3.24 #9.3 flip (PO msg #8299 反馈): 日期最左 + 人数最右 + 头像挨人数.
     - 左: .date 独立 (脱离原 .meta / .dot 分隔符, flex start 自然流)
     - 中: .avatars stack (palette 渐变实心圆点 + +N overflow, margin-left: auto 推右)
     - 右: .users-count (users icon + N) — 紧挨 avatars
     替代原 .meta / .meta .count / .dot / .muted 旧结构.

     v0.3.24 #9.1 (续 #9 PO msg #8269 反馈, 已被 #9.3 flip 取代): row-bottom layout fix —
     users-count + avatars 紧挨, date 独立最右. 修法: .row-bottom 删 space-between,
     .row-bottom .date 加 margin-left: auto. 结果: users-count — gap(10px) — avatars —
     gap(10px) — [auto-fill] — date (right).

     v0.3.24 #9.3 (续 #9.1 PO msg #8299 反馈 flip): 修法 (flip #9.1 方向):
       1. DOM 重排: date | avatars | users-count (之前 users-count | avatars | date)
       2. CSS: .row-bottom .date margin-left: auto → 删 (date 不再 auto 推到右)
       3. CSS: .avatars 加 margin-left: auto (avatars + users-count 整组被推到右)
     结果: date — gap(10px) — [auto-fill] — avatars — gap(10px) — users-count (right). */
  .row-bottom {
    margin-top: 14px;
    display: flex;
    align-items: center;
    gap: 10px;
    position: relative;
    z-index: 1;
    min-height: 22px;
  }
  /* LEFTMOST: users icon + N (从原 .meta 拆出). */
  .users-count {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
  .users-count .users-icon {
    display: inline-flex;
    color: var(--gray-500);
  }
  .users-count .count {
    font-weight: 600;
    color: var(--gray-700);
    font-variant-numeric: tabular-nums;
    font-size: 12.5px;
    line-height: 1;
  }
  /* MIDDLE→RIGHT (v0.3.24 #9.3): avatars stack (palette 渐变实心圆点 — 跟 /sessions/[id] 折叠态 .avatar-mini 一致).
     #9.3 flip: 加 margin-left: auto 把整组 (avatars + users-count) 推到右.
     跟 date (margin-left: 0) 之间留 auto-fill 中段, 视觉重心左 date + 右 avatars+users-count.
     保留 flex-shrink: 1 + min-width: 0 (跟 #9 一致, long overflow 可压缩). */
  .avatars {
    display: flex;
    align-items: center;
    flex-shrink: 1;
    min-width: 0;
    margin-left: auto;
  }
  /* LEFTMOST (v0.3.24 #9.3): date 独立 (脱离 .meta / .dot).
     #9.3 flip 把 date 从最右挪到最左, 删 margin-left: auto (不再 auto 推到右).
     flex 自然流 (gap 10px + .avatars margin-left: auto):
       date — gap(10px) — [auto-fill] — avatars — gap(10px) — users-count (right). */
  .row-bottom .date {
    font-size: 12.5px;
    color: var(--gray-500);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
    line-height: 1;
  }

  /* v0.3.24 #9: row-bottom avatars (跟 /sessions/[id] 折叠态 .avatar-mini 视觉一致).
     v0.3.24 #9.2 (PO msg #8280 反馈 "太小看不清"): size 18→24px (+33%),
     font-size 9→12px (= size/2, 跟 mockup 9=18/2 比例延续),
     border 1.5px 保留, margin-left -4.5→-6px (25% overlap, 跟原 18*0.25=4.5 同比例).
     base size 24×24 + 5 palette × 玻璃质感 (跟 #132 avatar 玻璃语言同源). */
  .avatar-mini {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 12px;
    border: 1.5px solid #fff;
    backdrop-filter: blur(4px) saturate(180%);
    -webkit-backdrop-filter: blur(4px) saturate(180%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.5),
      inset 0 -1px 0 rgba(0, 0, 0, 0.08),
      0 1px 2px rgba(0, 0, 0, 0.10);
    user-select: none;
    position: relative;
  }
  .avatar-mini:not(:first-child) {
    margin-left: -6px;
  }
  .avatar-mini.palette-0 {
    background: linear-gradient(135deg, rgba(129, 140, 248, 0.88), rgba(99, 102, 241, 0.88));
  }
  .avatar-mini.palette-1 {
    background: linear-gradient(135deg, rgba(244, 114, 182, 0.88), rgba(236, 72, 153, 0.88));
  }
  .avatar-mini.palette-2 {
    background: linear-gradient(135deg, rgba(52, 211, 153, 0.88), rgba(16, 185, 129, 0.88));
  }
  .avatar-mini.palette-3 {
    background: linear-gradient(135deg, rgba(251, 191, 36, 0.88), rgba(245, 158, 11, 0.88));
  }
  .avatar-mini.palette-4 {
    background: linear-gradient(135deg, rgba(96, 165, 250, 0.88), rgba(59, 130, 246, 0.88));
  }
  /* v0.3.0728-2 #20 解冻: 5 → 10 扩色 (palette-5..9) — 跟 v0.3.0728-2 #20 字段级同 */
  .avatar-mini.palette-5 {
    background: linear-gradient(135deg, rgba(244, 63, 94, 0.88), rgba(217, 70, 239, 0.88));
  }
  .avatar-mini.palette-6 {
    background: linear-gradient(135deg, rgba(132, 204, 22, 0.88), rgba(34, 197, 94, 0.88));
  }
  .avatar-mini.palette-7 {
    background: linear-gradient(135deg, rgba(14, 165, 233, 0.88), rgba(59, 130, 246, 0.88));
  }
  .avatar-mini.palette-8 {
    background: linear-gradient(135deg, rgba(139, 92, 246, 0.88), rgba(236, 72, 153, 0.88));
  }
  .avatar-mini.palette-9 {
    background: linear-gradient(135deg, rgba(249, 115, 22, 0.88), rgba(239, 68, 68, 0.88));
  }
  .avatar-mini-overflow {
    background: #d1d5db !important;
    color: #374151 !important;
    font-weight: 600;
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
    .row-bottom {
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
    .row-bottom {
      font-size: 12px;
    }
  }

  /* v0.3.25 #16 (UAT: /sessions item 加红色删除按钮, owner only):
   * 删账按钮 — 圆形 28×28, 半透明红玻璃 (rgba 0.18-0.25 alpha + 边 + 模糊).
   * hover 背景加深 + 红环. 跟全站玻璃语言一致 (跟 invite confirm modal 同源).
   *
   * v0.3.28 UAT 0724-1 #2: 全局 button 规则 (app.css:230) 强制 `min-height: var(--touch-target)`
   * = 44px (iOS 触摸目标推荐). 这个规则覆盖了 .delete-btn 的 height: 28px, 导致 button
   * 渲染成 28w × 44h 椭圆 (Playwright iPhone 13 实测 w=28 h=44). 加 `min-height: 28px`
   * 覆盖全局 + `aspect-ratio: 1` 防御性防止 line-height / padding 再次撑高 (跟 v0.3.17 #19
   * 圆形按钮修法同源). 触摸区 28×28 比 44 推荐小, 但设计明确 28×28 (PO msg 字面
   * "账本列表页账本 item 内, 删除按钮应该是圆形"), PO 接受. */
  /* v0.3.28 UAT 0724-1 #3 (PO 拍板 "swipe 才出现"): 从 always-visible 28×28 改为
   * swipe 才出现的 56×56 真圆 (跟 BillListGrouped .bill-swipe-action.glass-pill--delete 同款).
   *
   * 跟 v0.3.25 #16 always-visible 28×28 设计的 supersede 关系: #16 当时是「永远显 + 触摸小
   * 但圆形」折中, 现在 PO 拍 swipe-style, 按钮默认 opacity 0 + width 0 (按 progress),
   * progress >= 1 才 pointer-events: auto. 触摸区 56×56 (Apple HIG ≥ 44pt) 比 #16 28×28
   * 更友好 (用户能更准地点). 真正 1:1 圆形靠 aspect-ratio: 1, 跟 v0.3.17 #19 同源.
   * min-height: 0 覆盖全局 button min-height: 44px (跟 #2 同样的修法 — progress=0 时
   * width=0 不被全局规则撑成 44px). */
  .delete-btn {
    position: absolute;
    top: 50%;
    right: 6px;
    transform: translateY(-50%);
    width: calc(var(--swipe-progress, 0) * 56px);
    aspect-ratio: 1 / 1;
    min-height: 0;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(
      135deg,
      rgba(220, 38, 38, 0.18) 0%,
      rgba(239, 68, 68, 0.12) 100%
    );
    border: 1px solid rgba(220, 38, 38, 0.28);
    color: var(--error-700, #be123c);
    cursor: pointer;
    padding: 0;
    backdrop-filter: blur(8px) saturate(1.8);
    -webkit-backdrop-filter: blur(8px) saturate(1.8);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.5),
      0 1px 2px rgba(220, 38, 38, 0.12);
    /* v0.3.28 (跟 BillListGrouped .bill-swipe-action 同步): width 220ms spring overshoot,
     * opacity 180ms ease-out. 出来瞬间轻微 bounce + 收尾稳定到 56px. */
    transition:
      width 220ms cubic-bezier(0.34, 1.56, 0.64, 1),
      opacity 180ms ease-out,
      background 180ms ease,
      border-color 180ms ease,
      color 180ms ease;
    z-index: 2;
    appearance: none;
    font-family: inherit;
    pointer-events: none;
    overflow: hidden;
    white-space: nowrap;
    box-sizing: border-box;
    opacity: var(--swipe-progress, 0);
  }
  /* v0.3.28: 阈值 (>= 1) 才允许点击, 避免 0~80px 之间误触 (跟 BillListGrouped 同款) */
  .delete-btn[aria-hidden="false"] {
    pointer-events: auto;
  }
  .delete-btn:hover {
    background: linear-gradient(
      135deg,
      rgba(220, 38, 38, 0.28) 0%,
      rgba(239, 68, 68, 0.22) 100%
    );
    border-color: rgba(220, 38, 38, 0.40);
    color: #9f1239;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.6),
      0 0 0 2px rgba(220, 38, 38, 0.16),
      0 2px 6px rgba(220, 38, 38, 0.18);
  }
  .delete-btn:focus-visible {
    outline: 2px solid rgba(220, 38, 38, 0.55);
    outline-offset: 2px;
  }

  /* v0.3.25 #16: confirm modal (跟 InviteLinkButton v0.3.24 #14 同款玻璃风格).
   * z-index 1000 (Toast 9999 之下, 普通 modal 999 之上). 半透明黑 backdrop + 玻璃 modal box. */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.10);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    animation: fade-in 160ms ease;
  }
  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .modal-box {
    background: rgba(255, 255, 255, 0.92);
    backdrop-filter: saturate(2) blur(20px);
    -webkit-backdrop-filter: saturate(2) blur(20px);
    border: 1.5px solid rgba(255, 255, 255, 0.78);
    border-radius: 18px;
    padding: 24px;
    max-width: 340px;
    width: 100%;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.88),
      0 8px 32px rgba(15, 23, 42, 0.16);
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    animation: pop-in 200ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  @keyframes pop-in {
    from {
      opacity: 0;
      transform: scale(0.94) translateY(8px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }
  .modal-icon {
    width: 56px;
    height: 56px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(
      135deg,
      rgba(239, 68, 68, 0.18) 0%,
      rgba(220, 38, 38, 0.10) 100%
    );
    border: 1.5px solid rgba(239, 68, 68, 0.32);
    border-radius: 50%;
    color: rgba(220, 38, 38, 0.95);
    margin-bottom: 14px;
  }
  .modal-title {
    font-size: 17px;
    font-weight: 700;
    color: var(--gray-900, #0f172a);
    margin: 0 0 10px 0;
    line-height: 1.3;
  }
  .modal-desc {
    font-size: 14px;
    color: var(--gray-700, #334155);
    margin: 0 0 6px 0;
    line-height: 1.5;
  }
  .modal-desc strong {
    color: var(--gray-900, #0f172a);
    font-weight: 600;
  }
  .modal-desc-secondary {
    font-size: 13px;
    color: var(--gray-500, #64748b);
    margin-bottom: 18px;
  }
  .modal-actions {
    display: flex;
    gap: 10px;
    width: 100%;
  }
  .btn-cancel,
  .btn-danger {
    flex: 1 1 0;
    min-height: 40px;
    padding: 0 14px;
    border-radius: 12px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    border: 1.5px solid transparent;
    transition:
      transform 160ms ease,
      box-shadow 160ms ease,
      background 160ms ease,
      border-color 160ms ease;
    font-family: inherit;
  }
  .btn-cancel {
    background: rgba(255, 255, 255, 0.6);
    border-color: rgba(15, 23, 42, 0.10);
    color: var(--gray-700, #334155);
  }
  .btn-cancel:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.85);
    border-color: rgba(15, 23, 42, 0.16);
    transform: translateY(-1px);
  }
  .btn-danger {
    background: linear-gradient(
      135deg,
      rgba(239, 68, 68, 0.95) 0%,
      rgba(220, 38, 38, 0.92) 100%
    );
    border-color: rgba(220, 38, 38, 0.7);
    color: white;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.25),
      0 2px 6px rgba(220, 38, 38, 0.30);
  }
  .btn-danger:hover:not(:disabled) {
    background: linear-gradient(
      135deg,
      rgba(239, 68, 68, 1) 0%,
      rgba(220, 38, 38, 0.98) 100%
    );
    transform: translateY(-1px);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.3),
      0 4px 10px rgba(220, 38, 38, 0.36);
  }
  .btn-cancel:disabled,
  .btn-danger:disabled {
    opacity: 0.55;
    cursor: not-allowed;
    transform: none;
  }
</style>