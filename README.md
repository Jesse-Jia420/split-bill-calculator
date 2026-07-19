# split-bill-calculator

> **多人分摊账本 web 应用** — SvelteKit + FastAPI + SQLite，iOS27 玻璃化设计语言
> 状态: v0.3.18 玻璃化 UI polish 收尾（v0.3.18 #57 tab-bar 玻璃化实施中）
> 最近更新: 2026-07-19

---

## 项目坐标

| 项 | 值 |
|----|----|
| **Git remote** | `https://gitea.jessejia.pp.ua/jessejia/split-bill-calculator.git` |
| **PRD** | `/obsidian/Jesse OB VPS/JesseClaw/code-project/split-bill-calculator/PRD.md`（v1.0 UAT 16 章节） |
| **SPEC** | 本仓库 `SPEC.md`（5000+ 行 v0.1.3 → v0.3.18 #57 完整 §11 changelog） |
| **Sprint Board** | `/obsidian/Jesse OB VPS/JesseClaw/code-project/split-bill-calculator/SPRINT.md` |
| **测试环境** | `https://test.jessejia.pp.ua`（cloudflared → codeserver:8448） |
| **codeserver 容器** | `1Panel-code-server-lepH` / `hostname=63335c438b1f` / `IP=172.18.0.5` |

---

## 技术栈

### Frontend (frontend/)
- **SvelteKit 2** + Svelte 5 runes
- **TypeScript** strict
- **Vite 5** dev server port 8448（已配 `server.host="0.0.0.0"` + `allowedHosts`）
- **22 个 Svelte 组件** + 全局 `app.css` 设计 tokens
- **状态管理**: Svelte writable stores + 局部 `$state` runes
- **Lucide-svelte** 图标库

### Backend (backend/)
- **FastAPI** + uvicorn port 8449
- **SQLite** (sbc.db) + **alembic** migrations
- **Pydantic v2** schema validation
- **Decimal(28, 8)** 精度（multi-currency 汇率计算防浮点漂移）
- **SQLAlchemy 2.x** ORM
- **pytest** + httpx TestClient
- **认证**: email + 6 位验证码（dev 环境任意 code 通过）

---

## 核心功能

### 1. Session 账本 (v0.1 → v0.2)
- **创建 / 加入 / 退出 / 列表**
- **多币种 session**: 默认 `['CNY']`，owner 可加第二币种（USD / THB / JPY / EUR 等 10 种 ISO）
- **汇率管理**: owner 可编辑主币种 → 副币种汇率，BE 自动维护 reciprocal pair
- **邀请链接**: token + 过期时间，匿名加入 → 已登录用户 claim
- **Anonymous nickname secret**: `X-Nickname-Secret` header 允许匿名 CRUD（v0.3.12 实施）
- **Owner 持久化**: `owner_user_id` + `owner_email`，anon wizard 创建后可通过「🔐 登录以保存」CTA claim
- **Dev seed**: xinhua1001 + 泰国 session + 个人 session（v0.3.13 默认 skip，env `SBC_SKIP_SEED=false` 启用）

### 2. Bill 账单 (v0.2 → v0.3)
- **CRUD**: 创建 / 编辑 / 删除 / 列表
- **计算器输入**: 白名单 `[0-9+-*/.]` 表达式，BE 重算覆写 client `amount`
- **按天分组列表** (`BillListGrouped`): 天级 sub-section + 人均 + 总笔数
- **滑动操作** (v0.3.16 #13 + v0.3.17 #15-#18): 左滑删除 / 右滑编辑，iOS27 圆形按钮 (56×56 真圆)
- **Bill ownership** (v0.3.17 #36fix3): owner-only edit/delete，non-owner swipe action disabled 视觉置灰
- **参与者均摊 / 独占金额**: per-participant `is_exclusive` + `exclusive_amount`
- **多币种**: 每笔 bill 自带 `currency` + `exchange_rate_snapshot`（历史准确性）

### 3. Settlement 结算 (v0.2.2 → v0.3.14.1)
- **概览 tab**: pairwise transfer list，最多 4 transfers（`greedy_pair` 算法 FROZEN）
- **个人视图 tab**: per-member per-bill breakdown + 净额（v0.3.14.1 hotfix #4）
- **主币种汇总 vs 原始数据** toggle (IosSwitch 组件): v0.3.14.1 hotfix #1
- **balances 不变量 Σ=0** (v0.3.14.1 hotfix): 整 sum=0 强制（之前 5+ 人 rounding drift）
- **currency_breakdown 按源币种**: 每币种独立 `paid` / `consumed` / `net`（v0.3.14.1 hotfix #1）
- **session_exchange_rates 当前汇率** (v0.3.14 #4125 拍板): 推翻 §3.7.6 snapshot 隔离，settle 用当前汇率重算，bill 详情仍用 snapshot
- **数字带单位**: 概览 ¥1,146.15 (主币种) / 个人视图 CNY·THB 双标
- **付款明细 / 消费明细可点击展开折叠** (v0.3.16 #1)
- **底部 3 FAB**: 「回到账本」/「个人账单」/「新建账单」 (v0.3.18 #55)

### 4. UI / Design Language (v0.3.16 → v0.3.18)
- **全站 iOS27 玻璃化**: 
  - `v0.3.17 #21` 玻璃组件库 (`.glass-pill` / `.btn-sm` / `.btn-primary` / `.ghost`)
  - `v0.3.17 #27` login + wizard 全玻璃化
  - `v0.3.17 #30` iOS app-shell 化 + NavBar 玻璃对齐
  - `v0.3.18 #48` 全站玻璃组件透明化 sweep
  - `v0.3.18 #49` bills/members section 极透明化 + 冷色调背景图
  - `v0.3.18 #50` 成员/账单 section 极透明化 v2
- **iOS27 Segmented Control** (`IosSwitch` 组件): 玻璃 track + 紫渐变 thumb + 动态宽度
- **Sticky section header**: settle 付款/消费明细 sticky 浮起 + mask-image 渐变（v0.3.17 #31 + v0.3.17 #20）
- **App-shell layout**: `body { overflow: hidden }` + `main { overflow-y: auto }` (iOS Mail inbox 模式)
- **safe-area-inset-top/bottom**: iOS notch + home indicator
- **Container queries** (v0.3.17 #34): responsive 策略 B，`@container page (max-width: 360px)` 窄屏 polish

### 5. Other Features
- **Wizard 3 步创建 session**: 起名 → 人数 → 币种 (v0.3.17 #28 9 项 polish)
- **Email verification**: `POST /auth/send-code` + `verify-code` (任意 6 位数字)
- **401 auto-redirect**: `client.ts` wrap → `/auth/login?returnTo=...&expired=1`
- **Dev seed**: 启动时（`SBC_SKIP_SEED=false`）注入 xinhua + 泰国 session + 个人 session
- **nightly_cleanup**: verification_codes + auth_tokens TTL 清理（v0.3.13）
- **CurrencyAddModal**: owner 点击单币种胶囊 → 添加副币种 flow（v0.3.18 #53）
- **AppBackground**: 冷色调 peach→rose→lavender gradient（v0.3.18 #49）

---

## 项目结构

```
split-bill-calculator/
├── backend/
│   ├── app/
│   │   ├── api/             # FastAPI routes
│   │   │   ├── auth.py            # send-code / verify-code / me / logout
│   │   │   ├── sessions.py        # CRUD + currencies + exchange-rates
│   │   │   ├── bills.py           # CRUD + parse (AI)
│   │   │   ├── members.py
│   │   │   ├── invites.py         # create + accept + preview
│   │   │   ├── settle.py          # overview + personal + currency_breakdown
│   │   │   └── ai.py              # bill parse
│   │   ├── models.py              # SQLAlchemy ORM
│   │   ├── schemas.py             # Pydantic v2
│   │   ├── main.py                # FastAPI app
│   │   └── ...
│   ├── alembic/                   # migrations
│   ├── data/sbc.db                # SQLite (315K+)
│   ├── scripts/                   # seed_dev_data / nightly_cleanup
│   ├── tests/                     # pytest (~398 passed / 75 fail baseline)
│   ├── pyproject.toml
│   └── .venv/
├── frontend/
│   ├── src/
│   │   ├── app.css                # 全局 iOS27 glass tokens
│   │   ├── app.d.ts
│   │   ├── app.html
│   │   ├── routes/                # SvelteKit pages
│   │   │   ├── +layout.svelte     # 全局 layout + NavBar + Footer + Toast
│   │   │   ├── +page.svelte       # / (landing)
│   │   │   ├── auth/login/
│   │   │   ├── sessions/
│   │   │   │   ├── +page.svelte   # /sessions list
│   │   │   │   ├── new/+page.svelte   # wizard 3 步
│   │   │   │   └── [id]/
│   │   │   │       ├── +page.svelte   # 详情
│   │   │   │       ├── bills/
│   │   │   │       ├── settle/+page.svelte
│   │   │   │       └── join/+page.svelte
│   │   │   ├── invites/[token]/+page.svelte
│   │   │   ├── health/+server.ts
│   │   │   └── __mockup__/        # debug only (待清理)
│   │   └── lib/
│   │       ├── components/        # 22 个 Svelte 组件
│   │       │   ├── AppBackground.svelte
│   │       │   ├── NavBar.svelte
│   │       │   ├── BillForm.svelte
│   │       │   ├── BillListGrouped.svelte
│   │       │   ├── IosSwitch.svelte
│   │       │   ├── SettleMemberBreakdown.svelte
│   │       │   ├── SettleTransferPath.svelte
│   │       │   ├── SessionCurrencyBadge.svelte
│   │       │   ├── CurrencyAddModal.svelte
│   │       │   ├── AmountCalculatorInput.svelte
│   │       │   └── ...
│   │       ├── api/                # apiFetch + sessions/bills/settle helpers
│   │       └── stores/             # toast, etc
│   ├── static/
│   ├── tests/
│   └── package.json
├── SPEC.md                          # 5000+ 行，含 §11 完整 changelog
├── README.md
└── .git/                            # 单分支 main
```

---

## 测试账号 & 数据

**测试账号**:
- 邮箱: `xinhua1001@outlook.com`
- 验证码: 任意 6 位数字（dev 不发真邮件）
- 默认名: `xinhua1001`

**Seed 数据**（`SBC_SKIP_SEED=false` 重启时注入）:
- **session 1**: 泰国测试账单 6.19-6.22
  - 5 members (Jesse + Ju + Canyina + Q + 像汤圆一样圆)
  - currencies = `['CNY', 'THB']`, primary = `CNY`
  - 32 bills (27 THB + 5 CNY)
  - exchange rates: 1 CNY = 4.6512 THB
- **session 2**: 个人测试
  - owner = xinhua1001
  - currencies = 单币种 (上次 v0.3.18 #53 加过副币种)

---

## 开发

### 启动 dev server (反 #160 必加 `--host 0.0.0.0`)

⚠️ **最基础铁律**：dev server 必须 `--host 0.0.0.0`（不是 `127.0.0.1`），否则 cloudflared 进不来 codeserver 容器 → `test.jessejia.pp.ua` 502。

```bash
# Backend (uvicorn 8449)
cd /config/workspace/split-bill-calculator/backend
nohup .venv/bin/python -m uvicorn app.main:app \
  --host 0.0.0.0 --port 8449 --env-file .env \
  &>/tmp/uvicorn.log &

# Frontend (vite 8448) — vite.config.js 已配 server.host="0.0.0.0"
cd /config/workspace/split-bill-calculator/frontend
nohup npm run dev -- --host 0.0.0.0 --port 8448 \
  &>/tmp/vite.log &

# 验证 (反 #160):
netstat -tlnp 2>/dev/null | grep -E ':844[89]'   # 应 0.0.0.0:8448 + 0.0.0.0:8449
curl -s http://localhost:8449/version              # {"backend":"..."}
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8448/   # 200

# 反向代理 (cloudflared) 由 Jesse 配置: test.jessejia.pp.ua → codeserver:8448
```

详见 `skills/dev-workflow/references/dev-tasks.md` 启动 dev server 段（反 #160 醒目警告）。

### 测试

```bash
# Backend pytest (反 #53 必设 SBC_SKIP_TEST_TRUNCATE=1, 防止擦生产数据)
cd backend
SBC_SKIP_TEST_TRUNCATE=1 .venv/bin/python -m pytest tests/ -q --tb=short
# baseline: 398 passed / 75 fail (test fixture 已知问题)

# Frontend svelte-check
cd frontend
npx svelte-check
# baseline: 7 errors / 22 warnings (pre-existing)

# E2E (playwright)
cd frontend
npx playwright test e2e/
```

### Codeserver 工具 (sandbox 视角)

```bash
# 在 codeserver 容器内执行命令
node /home/node/.openclaw/workspace/scripts/codeserver_exec.js '<bash>'

# 容器 ID: 1Panel-code-server-lepH (hostname=63335c438b1f)
# 路径: /config/workspace/split-bill-calculator/

# 写文件到 codeserver (用 docker archive API)
node /home/node/.openclaw/workspace/scripts/put_file.js <localFile> <containerDest>
```

---

## 反向代理 / cloudflared

`test.jessejia.pp.ua` (Cloudflare edge) → cloudflared tunnel → codeserver 容器 `0.0.0.0:8448` (vite dev server) → `/api/*` `/auth/*` `/sessions/*` `/invites/*` proxy → uvicorn `127.0.0.1:8449`。

**cloudflared 配置由 Jesse 维护**，Master 只管让 codeserver 容器内 8448 + 8449 bind `0.0.0.0`。

---

## 反模式固化（项目特定）

详见 `skills/sbc/SKILL.md` + `skills/dev-workflow/SKILL.md` 反模式表:
- **#146**: codeserver DB + uvicorn **可能** 跑在 codeserver 容器内，跟 sandbox 是两份独立 DB
- **#150 + #150 续**: 报告完成前必自己验证（HTTP 200 不够，必走真实场景 + 截图）
- **#152**: 报告完成前必确认测试数据存在（DB wipe 后任何 hotfix 验证都是空跑）
- **#159**: 启动 dev server 必查 sbc/dev skill + 分次报告 + 验证 PID
- **#160**: dev server **必须** `--host 0.0.0.0`（不是 127.0.0.1），否则 cf tunnel 进不来 → 502
- **#53b**: pytest autouse truncate fixture 默认指向 prod DB = 定时炸弹（`SBC_SKIP_TEST_TRUNCATE=1` 守卫）

---

## 路线图

- **v0.3.18 (current)**: 玻璃化 UI polish 收尾（#42 → #57 tab-bar 玻璃化实施中）
- **v1.0**: 全部基础数据流程 + UAT 通过（基础已 OK，待最终验收）
- **v1.x**: AI bill parse 完善 / 多人实时同步 / 多 session 模板 / PWA

---

## License

Private — Jesse Jia only.
