# SBC Visual Design Principles (Master 起草 v0.1)

> **目的**: 解决 v0.3.18 #66/#67/#68/#73 反复出现的"token 字面执行但视觉烂"问题
> **作者**: Master (Jesbun / 贾馍)
> **起草时间**: 2026-07-20 (PO #7126 拍板 A+D 后)
> **状态**: v0.1 草案 — 后续由 Designer 按此原则出图, 由 Coder 字面执行

---

## 🎯 核心问题诊断 (反 #73 复盘)

**症状**: token 表里每个 token 单看都对, Coder 字面执行后整页视觉烂.

**根因**:
1. **没有视觉层级判断** — 5 个元素同 gap 摆一行, 平均用力
2. **没有信息密度判断** — 一个 header 塞太多 affordance (title / count / avatar / pill / button / chevron)
3. **没有负空间 (negative space) 意识** — 所有元素都"塞满"容器, 没呼吸感
4. **没有参照系** — Designer 不看 iOS 真原生控件做基准, 凭 token 想象

**修法**: 写一份硬性原则, Designer 出图**前**必读, Coder 字面执行**前**必查.

---

## 📐 原则 1: 信息层级 (Information Hierarchy)

### 1.1 L1 / L2 / L3 / L4 四级视觉权重

| 层级 | 含义 | 字号 | 字重 | 颜色 | 用途 |
|------|------|------|------|------|------|
| **L1** | 主信息 (用户必须看) | 16-18px | 600-700 | gray-900 / 主色 | 标题, 金额, 成员名 |
| **L2** | 次要信息 (状态 / 操作) | 14px | 500-600 | gray-700 / accent | 切换按钮, 当前状态, 可点操作 |
| **L3** | 辅助信息 (元数据) | 12-13px | 400-500 | gray-500 | 计数, 标签, 时间 |
| **L4** | 隐形 (默认 affordance) | 12-13px | 400 | gray-400 | "独占", "添加", 隐式提示 |

### 1.2 **铁律**: L1 > L2 > L3 > L4 权重递减, **不可逆转**

- ❌ L4 不允许比 L1 更显眼
- ❌ L3 不允许跟 L1 等大
- ❌ 同一行内, L1 跟 L2 距离 ≥ 8px

### 1.3 v0.3.18 #73 反例

```
成员 · 5  ← L3 (12px / gray-500)
  + 5 mini 头像  ← L2 视觉权重 (24px / 渐变色 / -6px overlap)
  + 过期 pill    ← L2 (accent bg)
  + 邀请按钮    ← L2 (accent)
  + chevron     ← L2 (touch container)
  
→ 5 个 L2/L3 元素挤一行, L1 "成员" 不见了
→ 用户扫视找不到锚点
```

**修法**: mini 头像改成 **L4** (隐形, 12px / gray-400 / 无背景), 让"成员 · 5"做 L1 主信息.

---

## 📐 原则 2: 信息密度 (Density)

### 2.1 Header 元素上限

**铁律**: 任何 section header **最多 3 个视觉元素**:

| 配置 | 元素 |
|------|------|
| **A** | title + count + chevron (默认) |
| **B** | title + count + 1 个 action button (无 chevron) |
| **C** | title + 1 个 affordance (avatar / pill / icon) + chevron |

❌ **不**允许: title + count + 头像组 + pill + button + chevron (6 元素)

### 2.2 Header 高度上限

| Viewport | Header 最大高度 |
|----------|----------------|
| Mobile 375px | **44-48px** (单行) / 64px (双行, 仅 2 元素) |
| Mobile 320px | 40-44px (单行) |
| Tablet 768px | 56-64px (可双行) |

❌ **不**允许 header 高度 > 70px (mobile) / 80px (tablet)

### 2.3 v0.3.18 #73 反例

```
5 个元素 + padding 12px + margin 12px + 头像 24px + chevron 20px + gap 12px
= header 高度 60-70px, 元素视觉权重全是 L2/L3
→ "成员" 这个 L1 信息被淹没
```

---

## 📐 原则 3: 负空间 (Negative Space)

### 3.1 元素呼吸感

**铁律**: 每个元素**周围**必须有 8px+ 透明区域 (margin 或 padding).

- ✅ L1 元素: 上下 12px padding
- ✅ L2 元素: 上下 8px padding
- ✅ L3 / L4 元素: 上下 4-6px padding
- ❌ 元素贴边 (margin/padding < 4px)

### 3.2 容器留白

- Card padding: **16px** (mobile) / 24px (tablet)
- Section gap: **16px** (相邻 section 间距)
- Element gap: **8px** (同 row 内元素)

❌ **不**允许: card 内 padding < 12px (看着挤)

---

## 📐 原则 4: 颜色权重

### 4.1 主色使用

**铁律**: 一个 section 内**最多 1 个主色填充元素** (pill, button, badge).

- ✅ 1 个 pill (L2): accent bg + white text
- ✅ 其他元素: gray 层级或 transparent
- ❌ 2+ 主色填充元素 (看着像圣诞树)

### 4.2 玻璃化克制

**铁律**: 玻璃效果 (`backdrop-filter blur`) **不**叠加半透明色彩.

- ❌ `hover bg indigo 0.04` on glass card → 变成脏灰紫
- ✅ `hover bg white 0.10` on glass card → 保持玻璃质感
- ✅ accent bg 只用在**不透明**元素上 (pill, button text)

---

## 📐 原则 5: 头像堆叠 (Avatar Stack)

### 5.1 堆叠顺序

**铁律**: DOM 顺序**正向**, CSS `margin-left: -Xpx` overlap, **不**依赖 `direction: rtl`.

```svelte
{#each members.slice(0, 5) as m, i (m.id)}
  <div class="avatar palette-{i % 5}" style="margin-left: {i === 0 ? '0' : '-6px'}">
    {avatarLetter(m.display_name)}
  </div>
{/each}
```

视觉顺序: 第 1 个头像 (i=0) margin-left: 0 → **最右独立**; 第 2-5 个 -6px → 紧密堆叠.

### 5.2 头像大小

| 场景 | 大小 | font | 说明 |
|------|------|------|------|
| 主头像 (成员列表行) | 36px | 14px / 600 | L1 |
| 紧凑头像 (单行预览) | 16-20px | 8px / 700 | L3 (辅助) |
| Mini avatar (header) | **不**超过 20px | 7-8px / 700 | L4 (隐形) |

❌ **不**允许 mini avatar > 24px (跟主头像视觉差距太小, 抢戏)

---

## 📐 原则 6: Affordance 显隐

### 6.1 默认态必须隐形

**铁律**: 默认 affordance (按钮, 切换, 标签) **默认隐形**, hover / active / 激活态才显形.

- ✅ "独占" chip 默认 14px / gray-400 / **无 bg** / **无 border** / 仅文字 (ghost link)
- ✅ hover 时: gray-700 + 浅 underline
- ✅ active (输入中): 白底 + accent 描边 + 14px / 600
- ✅ 数字态 (>0): accent bg + white text pill

❌ **不**允许默认 affordance 一开始就有 pill / button / chip 视觉重量

### 6.2 chevron 动画克制

- ✅ chevron-down, gray-400, 12×12 icon (无旋转动画, 静态)
- ❌ 旋转 180deg + 220ms transition (无意义, 用户不知道它在动什么)

---

## 📐 原则 7: iOS 原生参照

### 7.1 必读参考 (Designer 出图前必看)

| 控件 | iOS 原生位置 | 关键特征 |
|------|-------------|----------|
| 邮件列表头 | iOS Mail inbox | title + count + chevron, 单行, 紧凑 |
| Apple Pay 多人转账 | Wallet → 转账 | title + 头像堆叠 + 总金额, 头像 18px, 跟金额同 baseline |
| 微信群收款 | 微信支付 → 群收款 | 成员头像堆叠 18px, +N 计数 |
| Health 数据卡片 | iOS Health | section header 简洁, 1 个 action, 无 chevron 装饰 |

**设计师出图前必 fetch 这些 iOS 真截图作参考**, 不允许凭 token 想象.

---

## 📐 原则 8: 反 token 主义

**铁律**: token 是骨架, 不是皮肤.

- ❌ "我按 token 写的, 怎么会烂" — token 组合失衡 = 烂
- ✅ "我按真用户视觉走, token 跟着调" — token 服务视觉, 不反过来

### 8.1 Token 修改流程

当 Designer 发现 token 组合后视觉烂:

1. **不**直接改 token 表 (会破坏其他组件)
2. **写**一段"局部 override CSS"注释, 解释为什么 override
3. **Designer 评审**通过后, 才写代码
4. **Coder 字面执行** override CSS

---

## 🎯 v0.3.18 #73 反模式 checklist (落地的反面教材)

| 反模式 | 状态 |
|--------|------|
| ❌ 5 个元素塞 header (title + count + avatar + pill + button + chevron) | ❌ 已落地 |
| ❌ mini avatar 24px (跟主头像 36px 差距太小) | ❌ 已落地 |
| ❌ `direction: rtl` 依赖 (Svelte 模板不兼容) | ❌ 已落地 |
| ❌ `hover bg indigo 0.04` (脏灰紫) | ❌ 已落地 |
| ❌ chevron 旋转 220ms (无意义动画) | ❌ 已落地 |
| ❌ header 高度 60-70px | ❌ 已落地 |

**结论**: #73 (`7b1faee`) 必须 revert.

---

## 📚 实施路径 (之后做)

1. ⏳ **Master 找 iOS 真截图** (Apple Pay / Mail / 微信群收款 / Health)
2. ⏳ **Designer 按原则出图** (v0.3.19 整体视觉重审)
3. ⏳ **Coder 字面执行** (Designer 评审通过后才动代码)
4. ⏳ **Master 真用户 walk** (页面真截图对照参考)

---

## 📝 v0.1 原则汇总 (8 条)

1. **信息层级 L1 > L2 > L3 > L4 权重递减**
2. **Header 元素上限 3 个, 高度上限 48px mobile**
3. **每个元素周围必有 8px+ 透明区域**
4. **每个 section 最多 1 个主色填充元素**
5. **头像堆叠用正向 DOM + margin-left -Xpx, 不依赖 direction: rtl**
6. **默认 affordance 必须隐形 (ghost link)**
7. **Designer 出图前必看 iOS 原生控件作参考**
8. **Token 是骨架, 不是皮肤; 视觉失衡时允许局部 override**

---

_起草: Master Jesbun, 2026-07-20_
_关联: PO #7126 拍板 A+D, 反 #73 教训沉淀_
_待评审: Designer / Coder / Tester_