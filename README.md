# 🧮 split-bill-calculator

> **多人分摊账本 web 应用** — 你和朋友出去玩了, 谁付了钱、谁该给谁多少、跨币种怎么处理? 一个链接加进去就清楚.

---

## 它是什么

跟朋友吃饭、住宿、打车, **谁垫了多少钱、谁该 AA 多少、跨币种怎么算**——这是每个人都会反复遇到的小账本. `split-bill-calculator` 是一个私人的、可自托管的、支持多币种的分摊工具:

- 👥 创建账本 (5 人泰国游 / 3 人合租公寓 / 1 人日常记账都行)
- 💸 录入每一笔花费 (金额 + 谁付的 + 谁一起分)
- 🌍 支持 **多币种** (CNY 主 + USD/THB/JPY/EUR 等), 按当前汇率自动换算
- 📊 算清楚"谁该给谁多少钱", **按源币种 + 主币种汇总**两套视图
- 🔗 邀请链接 / 匿名加入 / 已登录 claim —— 不强制注册, 先记账再绑定账号

**当前状态**: v0.3.18 玻璃化 UI 收尾中, 即将发布 v1.0 (见 `/obsidian/Jesse OB VPS/JesseClaw/code-project/split-bill-calculator/PRD.md` §3.X).

---

## 📸 截图

### 结算 (个人视图 + 多币种 breakdown + iOS27 玻璃化 toggle)
![overview](screenshots/v0318-57-settle-overview-active.png)
![personal](screenshots/v0318-57-settle-personal-active.png)
![320px narrow](screenshots/v0318-57-settle-320px-narrow.png)
![deep link](screenshots/v0318-57-settle-deep-link-personal.png)

> 截图来自 v0.3.18 #57 tab-bar 玻璃化真机 walk (chromium headless @ iPhone viewport).

---

## ✨ 核心特性

| 特性 | 描述 |
|------|------|
| 💱 **多币种账本** | CNY 主 + 10 种 ISO 副币种 (USD/THB/JPY/EUR...), owner 编辑汇率, 自动换算 |
| 📐 **计算器输入** | 金额框直接打表达式 `350/5`, 服务器白名单重算, 防前端篡改 |
| 🗓 **按天分组** | 账单按发生日期自动分组, 每组显示人均 + 总笔数 |
| 👆 **滑动操作** | 左滑删除 / 右滑编辑, iOS27 圆形按钮, owner-only (其他人置灰) |
| 🧮 **结算不变量** | `Σbalances = 0` 强制保证, 按源币种 breakdown, balances drift = 0 |
| 🔗 **邀请链接** | 一次性 token + 过期, 匿名加入 → 已登录用户随时 claim |
| 🔒 **匿名 CRUD** | 未登录用户也能记自己的账, `X-Nickname-Secret` header 鉴权 |
| 🎨 **iOS27 玻璃化** | 全站 Liquid Glass 设计语言 (v0.3.17 + v0.3.18 收尾) |

---

## 🚀 快速开始

```bash
# 1. Clone
git clone https://gitea.jessejia.pp.ua/jessejia/split-bill-calculator.git
cd split-bill-calculator

# 2. Backend (FastAPI + SQLite)
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e .
python -m uvicorn app.main:app --host 0.0.0.0 --port 8449

# 3. Frontend (SvelteKit + Vite, another terminal)
cd ../frontend
npm install
npm run dev -- --host 0.0.0.0 --port 8448
```

打开 `http://localhost:8448`, 邮箱填任意 + 验证码 6 位任意数字 (dev 环境不发真邮件).

**dev / 启动模板 / 反向代理** 详见 `skills/dev-workflow/SKILL.md` 和 `skills/sbc/SKILL.md`.

---

## 🛠 技术栈

| 层 | 技术 |
|----|----|
| Frontend | SvelteKit 2 + Svelte 5 + TypeScript + Vite |
| Backend  | FastAPI + SQLAlchemy 2 + Pydantic v2 + SQLite |
| 设计     | iOS27 Liquid Glass (自研 design tokens, 不引第三方 UI 库) |
| 部署     | Docker + docker-compose (`split.jesdigi.com` 上线草案 commit `01968a4`) |

---

## 📦 项目结构

```
split-bill-calculator/
├── backend/          # FastAPI + SQLite + alembic migrations
├── frontend/         # SvelteKit + Vite
│   ├── src/routes/   # /, /auth/login, /sessions, /sessions/[id]/settle, /invites
│   └── static/       # static assets (screenshots, mockups)
├── SPEC.md           # 5000+ 行规格 + §11 changelog
└── README.md
```

---

## 📋 项目状态

| Sprint | 状态 |
|--------|------|
| v0.1 - v0.2.x | ✅ Session CRUD + Bill CRUD + 多币种 + 邀请 + 计算器 |
| v0.3.13 | ✅ Dev seed opt-out + nightly_cleanup |
| v0.3.14 | ✅ Settlement 用当前汇率重算 + balances 不变量 + currency_breakdown |
| v0.3.16 - v0.3.17 | ✅ iOS27 Liquid Glass 语言 + 全站玻璃化 + Swipe 操作 |
| v0.3.18 #42-#56 | ✅ 玻璃化 polish 收尾 (紧凑化 + 透明化 sweep + 冷色调背景) |
| v0.3.18 #57 | ✅ `.tab-bar` iOS Segmented (IosSwitch 复用) |
| v1.0.0 | 🚧 删 AI 入口 (#58) + Docker 部署 (`split.jesdigi.com`) |

---

## 🤝 License

Private — Jesse Jia only. 不接受外部 PR / Issue.
