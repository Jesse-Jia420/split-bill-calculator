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

  export let session: SessionSummary;

  /** v0.3.24 #9: 跟 mockup refined 一致 — 最多显示 6 个头像, 超出显示 +N. */
  const MAX_AVATARS = 6;

  /** v0.3.24 #9: 占位 avatars — N 个 palette 渐变实心圆点 (后端 avatars 字段后续 sprint 补). */
  $: memberCount = session.member_count ?? 1;
  $: displayAvatars = Math.min(memberCount, MAX_AVATARS);
  $: overflowCount = Math.max(0, memberCount - MAX_AVATARS);
</script>

<a href="/sessions/{session.id}" class="card-link">
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
           #9.3 加 margin-left: auto 把整组 (avatars + users-count) 推到右 -->
      <div class="avatars" aria-label="{memberCount} 个成员头像">
        {#each Array(displayAvatars) as _, i (i)}
          <span class="avatar-mini palette-{i % 5}" aria-hidden="true"></span>
        {/each}
        {#if overflowCount > 0}
          <span class="avatar-mini avatar-mini-overflow" aria-label="还有 {overflowCount} 个成员">+{overflowCount}</span>
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

<style>
  .card-link {
    text-decoration: none;
    color: inherit;
    display: block;
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
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.62) 0%,
      rgba(255, 255, 255, 0.38) 100%
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
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.45) 0%, rgba(255, 255, 255, 0) 100%);
    opacity: 0.55;
  }

  /* v0.3.18 #67: hover 浮起 -2px (克制) + 玻璃加深, 无紫 ring.
   * v0.3.23 #139: hover bg alpha 0.88/0.68 (跟 #139 同步加深).
   * v0.3.24 #9: hover bg alpha 0.78/0.55 (mockup refined 字面值, 跟 base 0.62/0.38 同步加深). */
  .card-link:hover .session-card {
    transform: translateY(-2px);
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.78) 0%,
      rgba(255, 255, 255, 0.55) 100%
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
</style>