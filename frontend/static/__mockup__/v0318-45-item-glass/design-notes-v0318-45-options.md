# v0.3.18 #45 — settle 个人视图 bill item 玻璃化设计

> **PO msg 17:43 #6401**: 付款明细和消费明细的 item 应该如何优化一下？align with 整体的玻璃 design
> **任务**: 给 settle 页付款明细 / 消费明细的 bill item 设计 3 套玻璃化方案

## 现状 (current state)

**截图**: `~/.openclaw/media/browser/designer-v0318-45-{current-paid,current-consumed}.png`

**视觉描述**: 当前 bill item 视觉简洁但缺乏层次: row 1 是 16px dark text (desc 500 + amount 600), row 2 是 14px muted gray-500 meta (date · 👤 N人 · 共享 X · 独占 X), row 间用 1px dashed gray-200 分隔。所有 row 共享 sheet 0.32 半透明白底 — 完全没有装饰、玻璃感、视觉锚点；只是"分隔线 + 文字"风格。整张列表平铺下来虽然读得清楚，但跟周围已经玻璃化的 chip / pill / button / FAB / input 形成明显落差 — 视觉重心全在 toggle/chip/hero 上，bill 列表成了一块「白纸 + 文字」区域，没有材质感。

## 玻璃 design language (已读 7 个组件源码)

| Token | 值 | 来源 |
|-------|-----|------|
| Glass pill bg | `linear-gradient(135deg, rgba(99,102,241,0.10) → rgba(59,130,246,0.08))` | app.css `.glass-pill` |
| Glass sheet (稀液) | `rgba(255,255,255,0.32)` + `saturate(150%) blur(16px)` + `border-radius: 16px` | SettleMemberBreakdown `.glass-sheet` |
| Glass chip (浓液) | `rgba(255,255,255,0.62)` + `saturate(200%) blur(20px)` + `border-radius: 9999px` + mask-image top 16px fade + 多层阴影 | SettleMemberBreakdown `.section-header.glass-chip` |
| Glass input | `rgba(255,255,255,0.55)` + `saturate(180%) blur(12px)` + 1.5px indigo border | app.css `.glass-input` |
| Sticky section header | `rgba(255,255,255,0.92)` + `saturate(180%) blur(16px)` (近 opaque) | SettleMemberBreakdown `.section-header` |
| Currency bar | indigo 玻璃 + `border-radius: 999px` + Row1/Row2 内部堆叠 | SessionCurrencyBadge `.currency-bar` |
| Member chip (active) | 玻璃 pill + 实色 accent-500 选中态 | SettleMemberBreakdown `.member-chip` |
| iOS Switch thumb | 紫渐变 `#6366f1 → #818cf8` + inset highlight | IosSwitch `.ios-switch-thumb` |
| Inset highlight (通用) | `inset 0 1px 0 rgba(255,255,255,0.6~0.85)` | 全站 |
| 外阴影 (通用) | `0 1~4px rgba(99,102,241,0.06~0.16)` | 全站 |
| Border | `1px solid rgba(99,102,241,0.10~0.22)` | 全站 |

**设计约束**: bill item 玻璃化必须**复用**这套 token，不引入新视觉语系。

---

## 方案 A — Glass Card (每条 item 独立玻璃小卡片)

**截图**: `~/.openclaw/media/browser/designer-v0318-45-A-glass-card.png`
**HTML**: `mockup-A-glass-card.html`

**视觉要点**:
- 每条 `.bill-item` 包成独立玻璃小卡片
- bg: `rgba(255,255,255,0.42)` + `saturate(170%) blur(16px)` + `border-radius: 12px`
- 1px 半透明白边 + inset highlight (`inset 0 1px 0 rgba(255,255,255,0.6)`) + 软外阴影 (蓝紫调 0.04~0.05)
- items 间 `gap: 6px` (取代虚线)
- 整张 sheet 保持 0.32 稀液玻璃基底不变

**优点**:
- 跟 transfer-card (`.transfer-card` v0.3.17 #21 已玻璃化) 视觉完全一致
- 每条 item 边界清晰，玻璃语言统一
- 视觉层次感强 (row 之间的"间隙"明显)

**缺点**:
- 列表密度变低: 5+ items 时整张列表占垂直空间变大
- sheet 的整体感被切碎 — 5+ 小卡片视觉上不像"一组数据"

**推荐适用场景**: 想要"每条账单是独立单元"的感觉，玻璃感最强。

---

## 方案 B — Glass Row (透明 row + 玻璃 hairline 分隔)

**截图**: `~/.openclaw/media/browser/designer-v0318-45-B-glass-row.png`
**HTML**: `mockup-B-glass-row.html`

**视觉要点**:
- `.bill-item` 完全透明，继承 sheet glass (没有自己的玻璃 bg)
- sheet 略加深: `0.32 → 0.42` + `saturate(150% → 170%)` + `blur(16 → 20px)` (给透明 row 足够玻璃基底)
- 行间 1px 玻璃 hairline (`.bill-item::after` 伪元素):
  - 水平方向 indigo 渐变 `rgba(99,102,241,0.10 → 0.14 → 0.10)` (中段略深, 两端淡出)
  - 加 `backdrop-filter: blur(2px)` (iOS separator 风格)
- 取消虚线 border-bottom

**优点**:
- 保留列表密度: 跟当前 dashed 几乎一样紧凑
- 整张 sheet 跟 rows 形成 1 个玻璃 unit
- hairline 渐变 (中深两端淡) 比虚线更"有呼吸感"

**缺点**:
- 视觉变化小 — 用户可能感受不到 row 级别的玻璃感
- row 自身没有任何装饰，只靠 hairline 提示边界

**推荐适用场景**: 想要"列表整体是一张玻璃"，密度跟当前保持一致。

---

## 方案 C — Glass Chip (关键数据变 inline 玻璃 chip)

**截图**: `~/.openclaw/media/browser/designer-v0318-45-C-glass-chip.png`
**HTML**: `mockup-C-glass-chip.html`

**视觉要点**:
- 描述 + 日期保留为透明 row1/row2 文字 (不装饰)
- 关键数据升级为 inline 玻璃 chip:
  - **金额 chip** (`bill-amount-chip`): 蓝紫玻璃 + pill radius + 14px 字 + tabular-nums
    - bg: `linear-gradient(135deg, rgba(99,102,241,0.18) → rgba(59,130,246,0.14))`
    - 1px `rgba(99,102,241,0.30)` border + 跟 chip 同源阴影
  - **人数 chip** (`bill-people-chip`): 灰色玻璃 pill + icon
    - bg: `rgba(255,255,255,0.5)` + `saturate(180%) blur(12px)`
  - **共享 / 独占 chip** (`bill-tag-chip`): 灰色玻璃 (共享) / 蓝紫玻璃 (独占)
    - 共享: `rgba(255,255,255,0.55)` + gray-700 字
    - 独占: `linear-gradient(135deg, rgba(99,102,241,0.16) → rgba(59,130,246,0.12))` + accent-700 字
- items 间 `gap: 6px` (给 chip 视觉锚点足够呼吸感)
- 视觉上: 文字 (背景) + 数据 chip (前景) 形成 "信息-锚点" 双层视觉

**优点**:
- 重点数据视觉锚点强: 一眼能找到金额 / 人数 / 共享 / 独占
- 跟全站 member-chip / currency-pill / rate-input 视觉同源 (玻璃 chip 族)
- 改动带来的"信息层级感"最强

**缺点**:
- 改动较大: 5+ items 时垂直空间增加 (~30% per item)
- chip 多时节奏跟现有略不同 (需要 320px 窄屏测试)
- 不熟悉 chip 视觉的用户可能觉得"突然太花"

**推荐适用场景**: 想要"重点数据视觉锚点强"，接受节奏变化。

---

## 我的建议

**如果只能选一个**: 方案 A — 玻璃卡片。

理由:
1. 跟 transfer-card (已玻璃化) 视觉完全一致，"全站玻璃化"承诺真正一致
2. 玻璃感最明显，跟周围 chip / button / FAB 形成统一
3. 改动量适中 (CSS-only, 不动 component 结构)
4. Jesse 在 #43 item-glass 反馈中已经倾向"每条独立卡片"方向

**如果优先密度**: 方案 B — 玻璃 hairline。

**如果优先数据锚点**: 方案 C — 玻璃 chip (但建议先在 320px 窄屏验证节奏)。
