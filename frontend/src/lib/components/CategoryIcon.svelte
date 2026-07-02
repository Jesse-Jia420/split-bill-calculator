<script lang="ts">
  /**
   * v0.1.3 Sprint 3 (2026-07-02) — 类别图标。
   *
   * 把 bill description 映射到 Lucide 图标:
   * - 关键词命中:返回对应 icon
   * - 默认:Sparkles (其他)
   *
   * 关键词规则覆盖现有 27 bills (餐饮 / 打车 / 住宿 / 购物 / 娱乐 / 其他)。
   * Lucide 风格 + 18px size 是 bill row 内的舒适尺寸。
   */
  import {
    Utensils,        // 餐饮
    Car,             // 打车 / 交通
    Bed,             // 住宿
    ShoppingBag,     // 购物
    PartyPopper,     // 娱乐
    Sparkles,        // 其他
  } from 'lucide-svelte';

  export let description: string;
  export let size: number = 18;

  // 关键词 → 图标组件映射 (顺序敏感:越靠前越优先)
  function pickIcon(desc: string) {
    if (/(吃|饭|餐|锅|食|酒楼|午餐|晚餐|早餐|粉)/.test(desc)) return Utensils;
    if (/(打车|车|出租|摩托|Taxi|taxi|Bolt|Grab)/i.test(desc)) return Car;
    if (/(民宿|酒店|住宿|酒店费|room|hotel|民宿费)/i.test(desc)) return Bed;
    if (/(购物|买|商店|商场|shopping|超市|mall)/i.test(desc)) return ShoppingBag;
    if (/(娱乐|按摩|massage|spa|酒吧|bar|club|卡拉OK|k歌|泰拳|榴莲)/i.test(desc)) return PartyPopper;
    return Sparkles;
  }

  $: Icon = pickIcon(description ?? '');
</script>

<span class="category-icon" style:font-size="{size}px" aria-hidden="true">
  <svelte:component this={Icon} size={size} />
</span>

<style>
  .category-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--gray-500);
    flex: 0 0 auto;
  }
  /* hover 时变 accent (在 bill row 内生效) */
  :global(.bill-row:hover) .category-icon {
    color: var(--accent-700);
  }
</style>
