<!--
  IosSwitch.svelte — v0.3.17 #32-D-4 (PO msg 01:18 #6116)

  iOS27 风格 segmented switch toggle 组件, 自包含 (scoped style 全套):
  - 玻璃 track (blur 14px + saturate 180% + 蓝紫描边 + inset shadow)
  - 滑动 thumb (紫渐变 + 投影) — **宽度跟随选中 option 实际宽度** (动态)
  - option 文字 (active 反白, locked 半透明 + not-allowed)

  vs 旧实现:
  - 旧 thumb: `width: calc(50% - 4px)` + `transform: translateX(0|100%)`
    → 50% 固定, 跨整个右半边, 主币种汇总 (CNY) 等长 label 视觉不平衡
  - 新 thumb: 用 measure() + ResizeObserver 跟踪 active option 的实际 width 和 x offset
    → thumb 宽度 = option 实际 width, transform 跟随 option 实际 x
    → 不同长度 label 切换时 thumb 同步伸缩

  Props:
  - options: Array<{ value, label, disabled? }>
  - value: 当前选中 option 的 value (bindable)
  - ariaLabel: radiogroup 的 aria-label

  用法:
  ```svelte
  <IosSwitch
    ariaLabel="币种模式"
    options={[
      { value: single, label: 单一币种 },
      { value: dual, label: 双币种, disabled: isAnon }
    ]}
    bind:value={currencyMode}
  />
  ```
-->
<script lang="ts">
  import { onMount } from "svelte";

  interface IosSwitchOption {
    value: string;
    label: string;
    disabled?: boolean;
  }

  /** Options: [{ value: string, label: string, disabled?: boolean }] */
  export let options: IosSwitchOption[];
  /** Bound: 选中 option 的 value */
  export let value: string;
  /** 整组 aria-label */
  export let ariaLabel: string = "";

  let switchEl: HTMLElement | undefined;
  let thumbW = 0;
  let thumbX = 4; // 默认 4px (跟 padding 对齐)

  function measure() {
    if (!switchEl) return;
    const active = switchEl.querySelector(".ios-switch-option.active") as HTMLElement | null;
    if (!active) return;
    const switchRect = switchEl.getBoundingClientRect();
    const optRect = active.getBoundingClientRect();
    thumbW = optRect.width;
    thumbX = optRect.x - switchRect.x;
  }

  // reactive: 当 value 变化时 measure (animation frame 让 layout settle)
  $: if (typeof window !== "undefined" && value !== undefined) {
    requestAnimationFrame(measure);
  }

  onMount(() => {
    measure();
    if (!switchEl) return;
    // 监听 switch 容器 + 每个 option resize (responsive + 文字长度变化)
    const ro = new ResizeObserver(() => requestAnimationFrame(measure));
    ro.observe(switchEl);
    switchEl.querySelectorAll(".ios-switch-option").forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  });

  function select(v: string) {
    const opt = options.find((o) => o.value === v);
    if (opt?.disabled) return;
    value = v;
  }
</script>

<div
  class="ios-switch"
  role="radiogroup"
  aria-label={ariaLabel}
  bind:this={switchEl}
>
  {#each options as opt (opt.value)}
    <button
      type="button"
      role="radio"
      class="ios-switch-option"
      class:active={value === opt.value}
      class:locked={opt.disabled}
      aria-checked={value === opt.value}
      disabled={opt.disabled}
      on:click={() => select(opt.value)}
    >
      {opt.label}
    </button>
  {/each}
  <span
    class="ios-switch-thumb"
    style="width: {thumbW}px; transform: translateX({thumbX - 4}px);"
  />
</div>

<style>
  /* ============================================================
   * v0.3.17 #32-D-4 (PO msg 01:18 #6116): IosSwitch 组件 scoped style
   * ------------------------------------------------------------
   * 跟 wizard step 3 + settle 个人视图 toggle 共用 — 自包含组件
   * - .ios-switch = 玻璃 track
   * - .ios-switch-thumb = 滑动 indicator (width + transform 动态, 跟随 active option 实际宽度)
   * - .ios-switch-option = 文字选项 (active 反白, locked 半透明)
   * ============================================================ */
  .ios-switch {
    position: relative;
    display: flex;
    background: rgba(255, 255, 255, 0.5);
    -webkit-backdrop-filter: blur(14px) saturate(180%);
    backdrop-filter: blur(14px) saturate(180%);
    border-radius: 9999px;
    padding: 4px;
    border: 0.5px solid rgba(99, 102, 241, 0.18);
    box-shadow:
      inset 0 1px 2px rgba(0, 0, 0, 0.04),
      inset 0 -1px 0 rgba(255, 255, 255, 0.6);
    /* v0.3.17 #39 (PO msg 16:24): 整组居中 — settle 页 IosSwitch
       放在 .card 容器内, 之前 width: fit-content 但没 auto margin
       → 默认左对齐, 留 60% 右边空白. 改 margin-left/right: auto
       让 fit-content + block parent 居中. wizard step 3 不用
       IosSwitch 组件, 不受影响. */
    margin: 0 auto 1.25rem;
    width: fit-content;
    max-width: 100%;
  }
  .ios-switch-option {
    flex: 1;
    position: relative;
    z-index: 2;
    padding: 0.625rem 1.5rem;
    font-size: 0.9375rem;
    font-weight: 600;
    color: rgba(67, 56, 202, 0.6);
    background: transparent;
    border: none;
    border-radius: 9999px;
    cursor: pointer;
    transition: color 200ms ease;
    min-height: 44px;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .ios-switch-option.active {
    color: white;
    text-shadow: 0 0.5px 1px rgba(0, 0, 0, 0.15);
  }
  .ios-switch-option.locked {
    cursor: not-allowed;
    opacity: 0.4;
  }
  .ios-switch-thumb {
    /* v0.3.17 #32-D-4: width 不再固定 50%, 而是跟随 active option 实际宽度 */
    position: absolute;
    top: 4px;
    left: 4px;
    bottom: 4px;
    background: linear-gradient(135deg, #6366f1, #818cf8);
    border-radius: 9999px;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.4),
      0 2px 4px rgba(99, 102, 241, 0.3);
    /* width + transform 都 transition (动态宽度切换时平滑) */
    transition:
      width 250ms cubic-bezier(0.4, 0.0, 0.2, 1),
      transform 250ms cubic-bezier(0.4, 0.0, 0.2, 1);
    z-index: 1;
    pointer-events: none;
  }
</style>
