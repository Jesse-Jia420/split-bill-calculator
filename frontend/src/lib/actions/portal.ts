// portal.ts — Svelte action 把 host element 物理搬到 document.body, 跳出
// backdrop-filter ancestor 的 CSS containing block trap.
//
// CSS Containing Block Spec: `position: fixed` 元素的 containing block 默认是 viewport,
// 但祖先元素如有以下任一属性 (不为 none), 那个祖先就成为 containing block:
//   - transform / perspective (不为 none)
//   - filter (不为 none)
//   - backdrop-filter (不为 none)
//   - contain: paint / layout / strict / content
//   - will-change: transform / perspective / filter / backdrop-filter
//   - container-type: size
//
// /sessions/[id]/+page.svelte 的 .members-head (以及 .members-head-row2 .currency-section)
// 有 `backdrop-filter: blur(20px) saturate(180%)` 玻璃效果, 所以邀请链接弹窗 / 币种弹窗 /
// 已结算记录弹窗的 `position: fixed; bottom: 0` 都退化成 relative-to-ancestor,
// 视觉上看起来在 viewport 中间 (而不是底部).
//
// 修法: 把 modal 的 host div 通过 Svelte action `use:portal={target}` 物理搬
// 到 document.body (或指定 target), 让 position:fixed descendants 的 containing
// block 回到 viewport. action 接受可选 target (selector 字符串或 'body' 默认).
//
// 比 `<svelte:body>` tag 优势 (后者 Svelte 5 严格模式 compile fail):
//   - 不需要 top-level ghost tag, 直接给 host div 加 `use:portal` action 即可
//   - 跨 Svelte 4 / 5 / 任何版本 都兼容 (action API 稳定)
//   - Svelte reactivity 仍可用: action 搬移 DOM 节点后节点 identity 不变,
//     Svelte 5 runes 根据 node identity 继续 track, 不会 broken
//   - 多 modal 共用同一个 action, 零 boilerplate
//
// 用法:
//   <div use:portal>
//     {#if modalOpen}
//       <div class="sheet-backdrop" ...></div>
//       <div class="sheet" ...>...</div>
//     {/if}
//   </div>
//
// 实现: Svelte 5 Action 签名 `<Node, Parameter>` 返回 { destroy? } 或 void.

import type { Action } from 'svelte/action';

const DEFAULT_TARGET = 'body';

function resolveTarget(target: string | undefined): Element | null {
  const t = target ?? DEFAULT_TARGET;
  if (t === 'body') return document.body;
  if (t.startsWith('#')) return document.getElementById(t.slice(1));
  return document.querySelector(t);
}

/** portal(node, target?) — 把 node 移到 target (默认 document.body).
 *  destroy 时直接从当前 parent 移除 (通常是 body), 不搬回原位.
 *  v0.3.0729-2: 旧实现 insertBack 到 origParent — 但父用 {#if} + runes `$state`
 *  关弹窗时, Svelte 已把原挂载点拆掉, 再搬回去会把 modal 孤儿挂在 <section>
 *  上, 表现为 "dismiss 回调跑了 / state=false 但弹窗关不掉". */
export const portal: Action<HTMLElement, string | undefined> = (node, target) => {
  const dest = resolveTarget(target);
  if (!dest) {
    // 不抛错 (会在 SSR 或初次 render 时失败), 留 log 让 dev 看到.
    if (typeof window !== 'undefined') {
      console.warn(`[portal] target ${target ?? DEFAULT_TARGET} not resolved, host stays in original parent`);
    }
    return;
  }
  dest.appendChild(node);
  return {
    destroy() {
      if (node.parentNode) {
        node.parentNode.removeChild(node);
      }
    },
  };
};
