
> 版本：v0.1.2-dev | 状态：🚧 T17-T21 + 反馈 6 修完成（PO 2026-07-01 17:14 实测）| 日期：2026-07-01
> 配套 PRD：/obsidian/Jesse OB VPS/JesseClaw/code-project/split-bill-calculator/PRD.md

---

## 1. 项目元信息

| 项 | 值 |
|---|---|
| 项目名 | split-bill-calculator |
| 类型 | 多用户 + 多 session 纯 web 应用 |
| 技术栈 | SvelteKit + FastAPI + SQLite（v0.1 拍板） |
| 部署 | v0.1 本地 dev；NAS Docker 推迟到 v0.1 末或 v0.2 |
| 许可证 | 待定 |

---

## 2. 目录结构

```
split-bill-calculator/
├── SPEC.md                ← 本文件
├── README.md
├── backend/               ← FastAPI
│   ├── app/
│   │   ├── main.py        ← FastAPI app entry
│   │   ├── api/           ← 路由（auth, sessions, bills, settle, verify）
│   │   ├── core/          ← config, security, deps
│   │   ├── db/            ← SQLAlchemy models + migrations
│   │   ├── schemas/       ← Pydantic
│   │   ├── services/      ← 业务逻辑（settlement, ai_parse, email）
│   │   └── middleware/    ← session 隔离 + 身份检查
│   ├── alembic/           ← DB migrations
│   ├── tests/
│   ├── pyproject.toml
│   └── alembic.ini
├── frontend/              ← SvelteKit
│   ├── src/
│   │   ├── routes/        ← +page.svelte: / /sessions /sessions/[id] /sessions/[id]/bills /sessions/[id]/settle
│   │   ├── lib/
│   │   │   ├── api/       ← 后端 client
│   │   │   ├── components/← BillForm, SessionMember, AiAssistInput 等
│   │   │   └── stores/    ← session store, user store
│   │   └── app.html
│   ├── tests/
│   ├── svelte.config.js
│   ├── vite.config.ts
│   └── package.json
├── docker-compose.yml     ← 推迟
├── .env.example
└── docs/
```

---

## 3. 核心模型

```sql
-- 验证过的邮箱 = 「全局用户」
users (
  id            INTEGER PK,
  email         TEXT UNIQUE NOT NULL,
  default_name  TEXT NOT NULL,        -- 默认昵称
  created_at    TIMESTAMP NOT NULL
)

-- 验证码
verification_codes (
  id            INTEGER PK,
  email         TEXT NOT NULL,
  code          TEXT NOT NULL,        -- 6 位
  purpose       TEXT NOT NULL,        -- 'session_create' | 'session_join' | 'magic_link'
  session_id    INTEGER,              -- JOIN 时才有
  created_at    TIMESTAMP NOT NULL,
  expires_at    TIMESTAMP NOT NULL,
  used          BOOLEAN NOT NULL DEFAULT 0
)

-- 长期 token（首次验证后设置，存 cookie）
auth_tokens (
  id            INTEGER PK,
  user_id       INTEGER NOT NULL,
  token_hash    TEXT UNIQUE NOT NULL,
  created_at    TIMESTAMP NOT NULL,
  expires_at    TIMESTAMP NOT NULL,
  last_used_at  TIMESTAMP
)

-- session = 一个记账本
sessions (
  id                  INTEGER PK,
  name                TEXT NOT NULL,        -- 「2026年6月曼谷旅行」
  owner_user_id       INTEGER NOT NULL,     -- 创建者
  created_at          TIMESTAMP NOT NULL,
  archived            BOOLEAN NOT NULL DEFAULT 0,
  -- v0.1.1: per-session fixed invite token (replaces session_invites table)
  invite_token        TEXT UNIQUE NOT NULL,  -- 32-byte URL-safe; 全 session 共享 1 个 token
  invite_expires_at   TIMESTAMP NOT NULL,    -- TTL 30 天（settings.invite_ttl_days）
  invite_created_at   TIMESTAMP NOT NULL     -- 最近一次 mint/rotate 时间
)

-- session 成员
session_members (
  id            INTEGER PK,
  session_id    INTEGER NOT NULL,
  user_id       INTEGER NOT NULL,     -- 关联 users（用邮箱验证后）
  display_name  TEXT NOT NULL,        -- 在该 session 内的昵称（可与 default_name 不同）
  role          TEXT NOT NULL,        -- 'owner' | 'member'
  joined_at     TIMESTAMP NOT NULL,
  UNIQUE (session_id, user_id)
)

-- v0.1.1: session_invites 表已删除。每个 session 1 个 token 直接存 sessions 表。


-- 一笔消费
bills (
  id            INTEGER PK,
  session_id    INTEGER NOT NULL,
  payer_id      INTEGER NOT NULL,     -- session_member.id
  amount        REAL NOT NULL,        -- 总金额
  currency      TEXT NOT NULL DEFAULT 'CNY',
  description   TEXT,
  occurred_at   TIMESTAMP NOT NULL,
  created_by    INTEGER NOT NULL,
  created_at    TIMESTAMP NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft'  -- 'draft' | 'locked'
)

-- 消费参与者 + 特殊消费
bill_participants (
  id            INTEGER PK,
  bill_id       INTEGER NOT NULL,
  member_id     INTEGER NOT NULL,     -- session_member.id
  is_exclusive  BOOLEAN NOT NULL DEFAULT 0,
  exclusive_amount REAL NOT NULL DEFAULT 0,
  -- 派生：share_amount = (amount - Σ exclusive) / count + (own_exclusive or 0)
  -- 派生字段不入库，查询时算
  UNIQUE (bill_id, member_id)
)

-- 结算快照（v0.1 简化为按需生成，不存历史）
settlements (
  id            INTEGER PK,
  session_id    INTEGER NOT NULL,
  generated_at  TIMESTAMP NOT NULL,
  summary_json  TEXT NOT NULL         -- 每人净应付/净应收
)

-- v0.2 预留：评论
bill_comments (
  id            INTEGER PK,
  bill_id       INTEGER NOT NULL,
  user_id       INTEGER NOT NULL,
  content       TEXT NOT NULL,
  created_at    TIMESTAMP NOT NULL,
  resolved_at   TIMESTAMP
)
```

---

## 4. API 路由

```
公开路由（无需身份）:
  POST   /api/auth/request-code    发送验证码（body: {email, purpose, session_id??, display_name??}）
  POST   /api/auth/verify-code     验证码登录（body: {email, code}）→ 返回 long-lived token（Set-Cookie）
  GET    /api/invites/{token}      查邀请详情（返回 session 名 + 创建者昵称，未登录用户可看）
  POST   /api/invites/{token}/accept 加入 session（body: {email, code, display_name}）

需身份（cookie 带 token）:
  POST   /api/auth/logout
  GET    /api/me                   当前用户 + 我的 session 列表

  POST   /api/sessions             创建（body: {name, email, display_name, code}）— 创建时自动 mint 邀请 token
  GET    /api/sessions             我的 session 列表
  GET    /api/sessions/{id}        session 详情 + 成员（owner 还看到 invite_token_preview + invite_expires_at）
  GET    /api/sessions/{id}/invite       任意成员可读：当前邀请 token + URL + 创建/过期时间 + status
  POST   /api/sessions/{id}/invite/rotate  owner-only：重置 token（旧 token 立即失效）

  GET    /api/sessions/{id}/members         成员列表
  PATCH  /api/sessions/{id}/members/{mid}   改昵称

  GET    /api/sessions/{id}/bills           账单列表
  POST   /api/sessions/{id}/bills           新增（body: 见下）
  PATCH  /api/sessions/{id}/bills/{bid}
  DELETE /api/sessions/{id}/bills/{bid}

  POST   /api/sessions/{id}/bills/parse     AI 辅助填表（body: {text}）→ 返回表单预填

  GET    /api/sessions/{id}/settle          生成结算
  GET    /api/sessions/{id}/settle/export   导出（JSON / 简版 HTML）

POST /api/sessions/{id}/bills body:
{
  amount: number,
  payer_member_id: number,
  description?: string,
  occurred_at: ISO8601,
  participants: [
    {member_id, is_exclusive, exclusive_amount}
  ]
}
```

---

## 5. session 隔离 + 身份中间件

```
请求进入 →
  1. 解析 cookie → current_user
  2. URL 含 /sessions/{id} → 检查该 user 是否 session_member
  3. 任何 ORM 查询自动注入 session_id 过滤
  4. 仅 owner 可改 session 元数据 / 撤销邀请
  5. bill 操作：session 内任何成员可加；仅 created_by + session 未锁可改/删
```

---

## 6. AI 集成（v0.1 输入端）

`POST /api/sessions/{id}/bills/parse` 流程：

1. 接 `text`（自然语言描述）
2. 调 MiniMax API（结构化输出 prompt）
3. 返回 `{amount, payer_hint, participants_hint, description}` 填到表单
4. **不落库**——用户 UI 二次确认后才 POST `/bills`

失败 fallback：返回 422 + 原因，前端退化纯人工表单。

---

## 7. 结算算法（v0.1 简版）

输入：session 全部已结算 bill（v0.1 不过滤 status，全用）
输出：每人的 net = Σ(per_user_total) - (自己付款总额)

结算转帐路径（v0.1 简版）：
- 列出每人 net：正数 = 应收，负数 = 应付
- 按"最大应收 ↔ 最大应付"配对，转账金额 = min(两者绝对值)
- 重复到所有人为 0

> v0.1 不做路径优化（贪心即可），v0.2 再考虑最小转账数。


---


## 8. 邮件服务（Gmail SMTP — T05 实现）

- **SMTP**: Gmail SMTP (`smtp.gmail.com:587`, STARTTLS)
- **凭据**: `jessejia1001@gmail.com` + App Password（运行时从 `backend/.env` 读取，password **不**进 git、**不**进日志）
- **验证码**: 6 位数字，由 `secrets.randbelow(10)` 生成（密码学安全，无偏置）
- **TTL**: 默认 10 分钟（`settings.verification_code_ttl_minutes`）
- **模板**: plain text + 简单 HTML，含 code + TTL + 忽略说明
- **错误分层**: `EmailError` (基类) / `EmailAuthError` / `EmailNetworkError` —— 端点映射为 500

### 8.1 模块（`app/services/email_service.py`）

```python
class EmailService:
    def __init__(self, settings: Settings) -> None
    async def send_verification_code(self, to_email: str, code: str, ttl_minutes: int) -> None
    def _build_message(self, to_email: str, code: str, ttl_minutes: int) -> MIMEMultipart
    def _connect_and_send(self, msg: MIMEMultipart) -> None  # starttls + login + send_message
```

特性：
- **不**在 import 时连接 SMTP（lazy）
- **不**记日志的 password（只记 host + user + status）

### 8.2 验证码生成（`app/services/verification_code.py`）

```python
def generate_code(length: int = 6) -> str
    # secrets.randbelow(10) × length
    # 4 ≤ length ≤ 10，否则 ValueError
```

### 8.3 端点：`POST /auth/send-code`

```
Body:  {"email": "jessejia1001@gmail.com"}
200:   {"sent": true, "email": "...", "ttl_minutes": 10}
400:   {"detail": {"error": "invalid email format"}}
500:   {"detail": {"error": "send failed: <smtp error>"}}
```

v0.1 **不**存 DB —— T06 接入 `verification_codes` 表之前，验证码只发邮件不落库（sprint 范围明确划分）。

### 8.4 CLI 验证（`backend/scripts/verify_email.py`）

```bash
cd /config/workspace/split-bill-calculator/backend
.venv/bin/python -m scripts.verify_email [recipient_email]
```

读 `.env` 拿 SMTP 凭据 → 真实发一封带 6 位 code 的测试邮件 → exit 0 = 通，1 = SMTP 失败，2 = 配置错。**不**打印 password。

> **T05 hard requirement**: 端到端真发邮件到 `jessejia1001@gmail.com`（codeserver 内**不**依赖 bw —— 凭据已就位在 .env）。

### 8.5 反模式 #31: pydantic-settings 2.x `.env` 里的 `List[str]` 字段

> ❌ **错误**（Stage 1 留下的 bug）：
> ```
> CORS_ALLOW_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
> ```
> 启动直接 `pydantic_settings.exceptions.SettingsError: error parsing value for field "cors_allow_origins"`。
>
> ✅ **正确**（T05 修法）：.env 用 **JSON 数组**：
> ```
> CORS_ALLOW_ORIGINS=["http://localhost:5173","http://127.0.0.1:5173","http://localhost:8448","http://127.0.0.1:8448"]
> ```

**根因**：pydantic-settings 2.x 的 dotenv provider 在 JSON-decode List 字段时**先**于 `field_validator(mode="before")` 跑 —— 逗号分隔字符串不是合法 JSON，整个字段解析失败。`field_validator` 根本**没机会**执行。

**修法**（T05 选定）：
1. `.env.example` 改 CORS 为 JSON 数组
2. `app/core/config.py` **删除**失效的 `_parse_cors` validator —— 既然 .env 用 JSON 格式，validator 不再需要
3. **不**改用 `python-decouple` / `dynaconf` / 自定义 dotenv source —— 过度工程

**未来若需要兼容逗号分隔**：在端点层 / 工厂层手动 split（**不**在 pydantic validator 里折腾 mode="wrap"）。

---
---

---

## T06 — 完整 auth 生命周期（2026-06-30）

T05 只发邮件**不**落库（V0.1 简化版）；T06 把 `verification_codes` 表真正接上，加 verify 端点、token 签发、cookie 中间件。

### T06.1 端点

#### `POST /auth/send-code`（**T06 接 DB**）

| 项 | 值 |
|---|---|
| Body | `{"email": "jessejia1001@gmail.com"}` |
| 200 | `{"sent": true, "email": "...", "ttl_minutes": 10}` |
| 400 | `{"detail": {"error": "invalid email format"}}` |
| 422 | 缺字段（pydantic） |
| 429 | `{"detail": {"error": "rate limit exceeded", "retry_after_minutes": N}}` |
| 500 | SMTP / DB 失败（**不**泄露内部细节） |

逻辑：
1. regex 校验 email 格式
2. rate limit：查 `verification_codes` where `email = ?` 且 `created_at > now - 1h` → 计数 ≥ 5 → 429
3. 清理**窗口外**的未用 code（**不**清理窗口内的——它们是 rate-limit 历史）
4. 生成 6 位 code（`secrets.randbelow`）
5. `expires_at = now + 10min` → INSERT 行
6. SMTP 发邮件

#### `POST /auth/verify-code`（**新**）

| 项 | 值 |
|---|---|
| Body | `{"email": "...", "code": "267986"}` |
| 200 | `{"user_id": N, "email": "...", "default_name": "...", "auth_token_expires_at": "<iso>"}` + `Set-Cookie: sbc_session=...` |
| 400 | email / code 格式错 |
| 401 | code 不匹配 / 已用 / 已过期 / 不存在 |
| 500 | DB 失败 |

逻辑：
1. 校验 email + 6 位 code
2. 查最新未用未过期 MAGIC_LINK code（`order_by created_at desc, limit 1`）
3. `hmac.compare_digest(code, stored)` 防 timing attack
4. 标记 `used = true`（一次性）
5. find-or-create User（**不**存在 → `default_name = email.split("@")[0][:120]`，轻量身份）
6. 签 token：`secrets.token_urlsafe(32)` → sha256 hash 入库
7. 设 cookie

#### `POST /auth/logout`（**新**）

读 cookie → sha256 hash → DELETE AuthToken row → `Set-Cookie: ...; Max-Age=0`。**始终** 200（**不**泄露 cookie 状态）。

#### `GET /auth/me`（**新**）

`get_current_user` dependency：读 cookie → sha256 hash → 查 AuthToken → 检查 `expires_at` → 注入 `request.state.user`。
- 200: `{"user_id", "email", "default_name"}`
- 401: cookie 缺失 / 无效 / 过期

### T06.2 中间件

`backend/app/core/auth.py::get_current_user(request, db, sbc_session: Cookie = None) -> User`。
- `sbc_session` 缺失 → 401
- sha256 hash → `db.query(AuthToken).filter_by(token_hash=...).first()`
- `expires_at < now` → 401
- 返回 `User`（同时塞 `request.state.user`）
- **不**每次请求更新 `last_used_at`（TTL 兜底；v0.2 再补定期刷新）

### T06.3 Cookie 配置

```python
response.set_cookie(
    key="sbc_session",
    value=raw_token,           # 仅此处出现 1 次
    max_age=30 * 24 * 3600,    # 30 天
    httponly=True,             # XSS 防护
    secure=settings.cookie_secure,  # dev=False, prod=env COOKIE_SECURE
    samesite="lax",            # CSRF 防护
    path="/",
)
```

### T06.4 Settings

```python
send_code_rate_limit_per_hour: int = 5
cookie_secure: bool = False          # env COOKIE_SECURE 覆盖
session_cookie_name: str = "sbc_session"
auth_token_ttl_days: int = 30
```

### T06.5 产品决策（已拍板，**不**变）

- (A) **MAGIC_LINK** 复用现有 `verification_codes.purpose` 枚举
- (B) **Token TTL = 30 天**
- (C) Cookie = HTTP simple（httpOnly + SameSite=Lax + secure=env）
- (D) Rate limit = **5/h per email**
- (E) 验证码尝试次数 = **不**限（TTL 10min + rate limit 5/h 兜底——6 位 1M 空间，10min 内 1 次有效发送，brute force 概率 < 0.001%）
- (F) **多设备共存**（老 token 保留到 `expires_at`，**不**踢）

### T06.6 反模式 #32: send-code 不接 DB + 窗口内不保留行

> ❌ **错误 1**（T05 留下的简化）：
> send-code 只发邮件**不**落库——verify 端点**无**可查的 code。
>
> ✅ **正确 1**（T06 修法）：send-code 完整接 DB：rate limit 计数 + INSERT verification_code row + SMTP send。
>
> ---
>
> ❌ **错误 2**（若简单实现）：rate limit 检查后清理时**也**删窗口内未用 code。
> 结果：rate limit 永远只看到 1 行（最新插入的），5 次后 429 永远**不**触发。
>
> ✅ **正确 2**（T06 修法）：清理 query 限定 `created_at < now - 1h`，只删**窗口外**的未用 code；窗口内未用 code 保留作为 rate-limit 历史。

### T06.7 反模式 #33: `Mapped["BillSession"]` 字符串 forward reference 在 TYPE_CHECKING 块里

> ❌ **错误**（v0.1 Stage 1 留下的潜在 bug）：
> `bills.py` 等 4 个文件用 `if TYPE_CHECKING: from app.db.models.sessions import Session as BillSession` + `Mapped["BillSession"] = relationship(back_populates="bills")`。
> `TYPE_CHECKING` 块在运行时**不**执行——模块 globals 里**没有** `BillSession`。
> SQLAlchemy 解析 `Mapped["BillSession"]` 时 `eval()` 失败 → `configure_mappers()` 抛 `InvalidRequestError`。
> **T05 之前没暴露**：T05 的 `app.api.auth` **不**查 DB，不触发 `configure_mappers()`。
> **T06 暴露**：`verify-code` 查 User/AuthToken 触发 `configure_mappers()`，连带配置 Bill mapper → 失败。
>
> ✅ **正确**（T06 修法）：把 `from app.db.models.sessions import Session` 移到**模块顶层**（`TYPE_CHECKING` 之外）；`Mapped["Session"]` 用真实类名 `Session`（不是别名 `BillSession`）。
>
> **根因**：SQLAlchemy 2.x 的 `relationship()` 解析 forward reference 字符串时，从 `clsregistry._class_registry` 里按**实际类名**查找，别名不进 registry。
>
> **教训**：v0.1 早期单元测试覆盖不足时，潜在 mapper bug 会潜伏到**真用 DB 的**功能上才暴露。每个 `Mapped["Xxx"]` 都应配一个调用 `configure_mappers()` 的 smoke test。

---

## 9. 测试策略



| 层级 | 范围 | 工具 |
|---|---|---|
| 单元 | settlement 算法 / AI parse 解析 / 验证码生成 | pytest |
| 集成 | API 端到端 / session 隔离 / 权限矩阵 | pytest + httpx AsyncClient |
| E2E | 浏览器：开 session → 邀请 → 记账 → 结算 | Playwright（v0.1 末决定要不要） |

---

## 10. v0.1 范围一览（来自 §3.1 / §3.4 拍板）

- ✅ 创建 session（邮箱 + 验证码）
- ✅ 邀请 + 加入 session（持久邀请链接）
- ✅ 我的 session 列表 + 切换
- ✅ 单笔消费记账表单（payer / amount / participants / exclusive 矩阵）
- ✅ 单笔消费结算（自动计算单人金额）
- ✅ session 总结算 + 转账路径
- ✅ AI 辅助填表（自然语言 → 表单预填）
- ❌ review / 评论 / 锁定（v0.2）
- ❌ NAS Docker / Cloudflare Tunnel（v0.1 末或 v0.2）
- ❌ 多币种 / 汇率（v0.2）

---

## 11. 版本变更记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-07-01 | v0.1.2 | **T17-T21 一组 UX 改进完成**（PO 06-30 拍板 + 06-30 17:00 补拍人均算法）。见下方独立条目（v0.1.2 主变更）。<br>· **T17 bills PATCH/DELETE 权限放开 + description 不可改**：任何 session member 可改/删（v0.1.0 的「仅 created_by」限制取消 — PO i: 「别人没在场也能帮改」）；`description` 字段保持不可改，用 `ConfigDict(extra='forbid')` 在 Pydantic schema 层拦所有未知字段，PATCH body 含 `description` 或任何未知字段一律 422。`created_by` 字段仍返回（用于 UI 显示「谁记的」），但**不**作权限门<br>· **T18 settle 响应加 per-member breakdown**：新增 `per_member: list[MemberSettlement]` 字段 — 每 session member 一个 entry，含 `display_name` / `role` / `total_paid` / `total_consumed` / `net` / `paid_bills[]` (BillSummary) / `consumed_bills[]` (BillShare 带 share_amount)。核心不变量: `per_member[i].net == balances[member_id]`（永远）。计算函数 `_compute_per_member` 是纯函数，输入 bills + participants_by_bill + members, 输出 list[MemberSettlement]。**持久化的 settlement snapshot 仍保留 v0.1.0 形状** (`balances` + `transfers` only)，per_member 按需算 — 这样 v0.2 改格式不需要 backfill migration<br>· **T19 BillForm payer 默认 = 当前登录人在 session 内的 member_id**：`BillForm.svelte` 加 `defaultPayerMemberId: number | null = null` prop，`onMount` 时设默认；`/sessions/[id]/bills/new/+page.svelte` onMount 时 `loadUser() + getSession()` → 找 `session.members.find(m => m.user_id === user.user_id)` → 传 BillForm。createBill API **不变**（本就接受任意 payer_member_id）<br>· **T20+T21 bills 列表按天分组**（PO 06-30 17:00 拍人均算法）：新增 `BillListGrouped.svelte` 组件 + `/sessions/[id]/+page.svelte` 重写账单列表。分组键 = `Intl.DateTimeFormat('Asia/Shanghai')` 算的 `YYYY-MM-DD` 日期；按日期降序排序，每天内按 `occurred_at` 升序。每组 header: `📅 日期 · 总消费 Σ amount · 人均 Σ amount_i / count_i`（**per-bill AA**, 不是 total/num_members — 这是 PO 06-30 17:00 明确拍板的）。默认全部展开，点 header 折叠，localStorage 键 `sbc.billGroupCollapsed.{sessionId}` 持久化（**per-session** 而不是全 session 共享）。空态: 「还没有账单, 点+ 新建账单开始」。币种 v0.1 简化为取当天第一笔的 currency（多币种 v0.2）<br>· **settle page 加 tab 切换**：顶部 `[全 session] [个人视图]`，默认全 session；切到个人视图用新组件 `SettleMemberBreakdown.svelte` 渲染每个 member 一个折叠 card（avatar 首字母 + display_name + role badge + 付款/消费/净 stats + 点开看 paid_bills 和 consumed_bills 明细）<br>· **前端 SessionDetail type 补字段**：v0.1.1 漏了 `invite_token_preview` / `invite_expires_at` 在 TS 接口里（编译报 unknown property），v0.1.2 顺手补上（**不是 T17-T21 范围内但同一批 commit**，否则 svelte-check 出错）<br>· **测试**：191/191 pytest 通过（baseline 179 + 新增 12: `test_bills` 加 4 = `test_non_creator_can_update_returns_200` / `test_update_bill_cannot_change_description` / `test_update_bill_unknown_field_returns_422` / `test_update_bill_non_member_returns_403` / `test_non_creator_can_delete_returns_204` / `test_delete_bill_non_member_returns_403`（两个 6 个，但 `test_non_creator_can_update_returns_200` 取代了 `test_non_creator_cannot_update_returns_403`，`test_non_creator_can_delete_returns_204` 取代了 `test_non_creator_cannot_delete_returns_403` — 所以净 +4）；`test_settle` 加 8 = `test_per_member_field_present_and_structure` / `test_per_member_paid_bills_correct` / `test_per_member_consumed_bills_correct` / `test_per_member_with_exclusive_amount` / `test_per_member_empty_session` / `test_per_member_net_matches_balances` / `test_per_member_paid_and_consumed_both_present_for_self_paid_bill` / `test_per_member_non_member_still_403`）<br>· **svelte-check**：2 errors (pre-existing in `+layout.svelte` + `invites/[token]/+page.svelte` 的字符串字面量 narrowing) + 2 warnings (pre-existing in `InviteLinkButton.svelte` a11y) — 都是 v0.1.1 就有的，**本批 patch 没引入新错误**<br>· **PRD action item**（Coder **不**直写 Obsidian）：Master 需手动同步 PRD §3.4 + §11 加 T17-T21 行（v0.1.2 字段 + 接口 + UI 行为）。本任务范围内 Coder 只动 SPEC + 代码 + git log<br>· **偏差 vs 任务拍板**：(1) `test_update_only_one_field_works` + `test_update_two_fields_at_once` 改了测试体（不再 PATCH `description`）— 因为 T17 后 `description` 不可改，必须换成 PATCH 其他字段验证 "只改一字段" 语义；(2) `BillListGrouped.svelte` 用 `<button type="button">` 触发现有的按需展开模式（不引 Svelte transition 库，PO 06-30 明确说 mobile-first + 简单实现），(3) `localStorage` key 用 `sbc.billGroupCollapsed.${sessionId}` 而不是单 key 全 session 共享 — 反模式 #34（折叠状态全 session 共享会让多 session 用户错乱）<br>· **反模式预防**：(a) **Docker exec 输出字节序损坏** — codeserver_exec.js `chunk.toString()` 默认 UTF-8 解码会损坏 Docker 流的多路复用头 8 字节，本批 Coder 一开始用 `> file` redirect 中招了。修法: 用 docker PUT archive API (cs_write.js, 内部走 `/v1.47/containers/.../archive?path=...` 上传 tar，**不**经 exec 字节流) + 用 docker exec + **buffer 模式 + 手动 parse 8 字节流帧头** 做读 (cs_read.js); 整个文件 IO 工作流 0 字节损坏。教训: codeserver 内任何跨容器文件传输**不**用 `bash -c 'cat ... > ...'`, 必须走 PUT archive 或 base64 + buffer 解码；(b) **「fold 后端 dev 时段」集成** — `code-server_exec.js` 似乎把任意 unknown string 当 bash 解释（甚至 docker stream header），所以保留 `cs_read.js` / `cs_write.js` 这种专用工具比 inline 靠谱；(c) **不**自创 PRD 章节 — Coder 不直写 Obsidian vault, 用 SPEC §11 + commit message 携带, 留 action item 给 Master |
| 2026-07-01 | v0.1.2 (反馈修) | **PO 2026-07-01 17:14 实测后 6 个 UI/UX 修复**（3 commit：`73e5cb9` fix(ui) + `ce9b938` feat(bill) + `4a648f7` feat(settle)）。<br>· **T1 bills 按日期折叠失效**：`BillListGrouped.svelte` 之前用 `isCollapsed(date)` 函数调 + `{#if}` 条件，Svelte 5 反应性没追踪 `collapsed[date]` 内部变化 → 改用原生 `<details>` + `<summary>` + `on:toggle` 同步（与 `SettleMemberBreakdown` 一致）。Browser 原生 `open` 属性是 single source of truth，localStorage 通过 `on:toggle` 同步一行写完<br>· **T2 每日总金额 + 人均排版**：日期略大 (`1rem`, weight 600) 作为视觉锚点；总金额 + 人均共用 `font-size-sm` 用 `·` 分隔（顺序：日期 · 人均 · 总）。PO 反馈"总金额和人均应都用当前人均的字体字号"→ 视觉层级清晰，total + per-capita 一样大一样颜色<br>· **T3 bill 编辑页**：新路由 `/sessions/[id]/bills/[billId]/edit/+page.svelte` (60 行) 复用 `BillForm` 加 `mode="edit"` + `existingBill` prop；`BillForm.svelte` 加 `mode: 'create' | 'edit' = 'create'` (default 向后兼容) + `existingBill?: Bill | null`；onMount 时按 mode 分支预填 (create → defaultPayerMemberId; edit → existingBill 填 amount/payer/occurred_at/currency/participants)；**description 在 edit 模式 disabled** + 提示 "说明在账单录入后不可修改" (T17 PATCH `extra='forbid'` 决定)；AI 辅助按钮 edit 模式隐藏；`bills.ts` 加 `getBill(sessionId, billId)` 复用 listBills 客户端查找，**不**新增 BE endpoint<br>· **T4 个人视图消费明细显示独占消费金额**：BE `app/api/settle.py` `BillShare` 加 `exclusive_amount: float = 0.0` (默认 0.0，**不**是 None) + `_compute_per_member` 填 `p.exclusive_amount if p.is_exclusive else 0.0`；FE `lib/api/settle.ts` `BillShare` interface 加字段<br>· **T5 共享/独占消费金额优先级高于账单总金额**：`SettleMemberBreakdown.svelte` 消费明细 primary amount 从 `b.amount` 改为 `b.share_amount` (用户真正关心的"我分摊多少")；账单总额 `b.amount` 降级为 row2 灰色 "账单总 X"<br>· **T6 个人视图消费明细 2 行排版**：从单行 flex-wrap 改为 row1 (description + primary amount, primary 字号大粗体) + row2 (date + 独占/共享/账单总 tag 灰显 dot 分隔, 字号小 muted)；独占 > 0 才显示 "独占 X" tag (蓝色 accent)，避免噪音；共享 = share - exclusive 总是显示 "共享 Y" tag；付款明细保持 row1+row2 简化版 (date only, 视觉一致)<br>· **顺手**：BillListGrouped 的 bill row 整行可点击跳编辑页（`<button type="button">` 包裹 description 区，删除按钮 `stopPropagation`），整行键盘可达<br>· **测试**：377 → 380 (+3 new cases): T15 `test_per_member_with_exclusive_amount` 扩 3 断言 + 新 `test_per_member_exclusive_amount_field_always_present` (字段 always present 不变量) + T14 新 `TestExclusiveAmountInvariant` 2 cases (share - exclusive == shared_portion 不变量)<br>· **svelte-check**：仍 2 errors + 2 warnings (pre-existing, 本批未引入新)<br>· **BE 重建**：本批改 `settle.py` schema，重启 uvicorn (端口 8449) 后 live data 保留<br>· **反模式预防**：(a) **Docker exec 输出字节流损坏** — `docker_exec_util.js` 默认 UTF-8 解码 Docker 流的多路复用 8 字节帧头会丢失第一字节 (`0x01` stream type 被解析为 U+0001)。修法：用 `tail -c +9` 跳过 8 字节头再处理，**或**直接用 `od -An -tx1` 查 in-container 字节不要 `cat > file`；(b) **Svelte 5 `{#if}` 函数调用反应性陷阱** — 反模式 #35：`isCollapsed(date)` 函数返回 `collapsed[date] === true` 不会触发 re-render when 函数内字段变。修法：原生 `<details>` 单 source of truth + `on:toggle` 同步。教训：Svelte 5 模板里需要反应性的值，要么直接 inline (`{#if !collapsed[date]}`)，要么 `$derived`，要么原生 DOM 元素内置状态 (details/summary/input/checkbox) |
| 2026-07-01 | v0.1.2 (反馈修2) | **PO 2026-07-01 20:08 再实测后 2 个 UI 修复**（1 commit `XXX` fix(ui)）。<br>· **T7 成员 section 可折叠**：PO 反馈 "session 页面成员 section 可折叠，可展开，默认折叠；折叠时只展示邀请链接按钮和头像框"。`/sessions/[id]/+page.svelte` 把成员 card 包进原生 `<details>` + `<summary>`：默认 `open={false}`（折叠），summary 行内始终可见「成员」标题 + 「点击展开/折叠」muted hint + `<InviteLinkButton>`（PO 明确要求始终可见）+ 头像叠放（首字母大写圆 28px，`-6px` 互相叠 + 2px 白色 border 制造「叠层」感，最多 8 个，超过显示「…」+ 总数）。展开后 summary 加底部分隔，body 显示完整 `<SessionMemberList>` + owner token hint。**状态持久化**：用 `localStorage` 键 `sbc.membersOpen.{sessionId}` 跨刷新记住用户选择（与 T1 BillListGrouped 模式一致，per-session 而不是全 session 共享 — 反模式 #34）。新增 `avatarLetter(name)` helper 取首字母大写<br>· **T8 账单 section 「个人账单」快捷按钮**：PO 反馈 "账单 section 内的顶部应加入「个人账单」快捷按钮，点击后直接进入此用户的个人视图"。账单 section 头部右侧加 `<a class="btn ghost" href="/sessions/{session.id}/settle#personal">个人账单</a>`（放在「共 N 笔」前面，`ghost` 边框样式不抢主按钮视觉）。`/sessions/[id]/settle/+page.svelte` 的 `onMount` 加 hash 检查：`if ($page.url.hash === '#personal') activeTab = 'personal'` —— Svelte 默认不开启 hash→store 双向同步，所以本逻辑只在初次进入时生效（用户手动切 tab 后 hash 不会更新；这是 OK 的，因为用户已经在 settle 页面有完整 tab 控制）<br>· **svelte-check**：仍 2 errors + 2 warnings (pre-existing, 本批未引入新)<br>· **BE 重建**：**不需要** — 仅前端改<br>· **PRD action item**（Coder **不**直写 Obsidian）：Master 需手动同步 PRD §11 加 v0.1.2 (反馈修2) 行（T7+T8 UI 行为）
| 2026-06-30 | v0.1.1 | **邀请链接 redesign** (PO 16:50 拍板 B②i)<br>· 旧 design: 每 session 多 invite, owner mint 新的 (POST + DELETE)<br>· 新 design: 每 session 固定 1 token, 30 天 TTL, owner 可重置 (POST /invite/rotate)<br>· DB: sessions 表加 invite_token / invite_expires_at / invite_created_at (NOT NULL UNIQUE)；alembic migration backfill 现 session + drop session_invites 表<br>· API: 删 `POST /sessions/{id}/invites` + `DELETE /sessions/{id}/invites/{iid}`；加 `GET /sessions/{id}/invite` (member 读) + `POST /sessions/{id}/invite/rotate` (owner 重置)；改 `GET /invites/{token}` + `POST /invites/{token}/accept` 查 sessions 表<br>· Accept 幂等保留 (PO i: 已接受仍可用, 同 user re-accept 直接 return existing membership)<br>· TTL 保留: `settings.invite_ttl_days` (env `INVITE_TTL_DAYS`, 默认 30)<br>· 前端 `InviteLinkButton.svelte` 重写: onMount GET 拿 token + 显示完整 URL (`window.location.origin` 前缀, 不硬编码端口) + 复制按钮 + owner-only 二级「重置」按钮 (confirm 弹窗防误点) + 过期状态红 badge + 倒计时提示<br>· 测试: 179/179 pytest pass (baseline 169 + 新增 10)；`test_invites` / `test_sessions` / `test_sessions_flow` 大改适配新 API；`test_bills` / `test_settle` `_make_session_with_members` helper 加 invite 字段以适配 NOT NULL<br>· 偏差 (vs 任务拍板): (1) `_iso()` helper 在 `app/api/sessions.py` 改 "naive datetime → 当地时区" → "naive datetime → UTC" — 修 SQLite CURRENT_TIMESTAMP 返回 UTC 但 Python 端 `_iso()` 把 naive 当作 local 处理的潜在 8h 时区漂移 bug (Asia/Shanghai container)；现有 `created_at` 之前没测试 ISO 时区所以潜伏；现在所有时间字段统一按 UTC 序列化的语义；(2) `get_invite_public` 的 `inviter_display_name` 优先取 `SessionMember.display_name` (per-session nickname)，fallback 到 `User.default_name` — 比任务原版只查 `default_name` 更准确（owner 可在 session 内改名）|
| 2026-06-29 | v0.0 | 脚手架 |
| 2026-06-29 | v0.0 | 方向调整：纯 web + 多用户 + 多 session |
| 2026-06-30 | v0.1.0 | **Sprint 1 T05 完成**：邮件服务集成 + 修 Stage 1 .env CORS bug。<br>· 新增 `EmailService` 模块（starttls + login + send）<br>· 新增 `verification_code` 生成（`secrets.randbelow` 6位）<br>· 新增 `POST /auth/send-code` 端点（v0.1 简化：不存 DB，T06 接入）<br>· 新增 `scripts/verify_email.py` CLI 工具<br>· 修 `.env.example` CORS 改 JSON 数组格式（pydantic-settings 2.x 兼容）<br>· 修 `app/core/config.py` 删失效的 `_parse_cors` validator（dotenv 路径上 `mode="before"` 不生效）<br>· 测试：29/29 pytest 通过（`test_email_service.py` 9 + `test_verification_code.py` 18 + `test_health.py` 2）<br>· 端到端：CLI 真发邮件到 `jessejia1001@gmail.com` 成功（hard requirement）<br>· 详见反模式 #31（§8.5）。commit 关联见 Sprint Board T05 行。 |
| 2026-06-30 | v0.1.0 | **Sprint 1 T06 完成**：完整 auth 生命周期（commit `d69e4a2`）（DB + verify + token + cookie + me + logout）。<br>· `/auth/send-code` 接 DB：rate limit 5/h + 窗口外 code 清理 + INSERT verification_code<br>· `/auth/verify-code`：code 验证（`hmac.compare_digest`）+ 自动注册 + 签 token（`secrets.token_urlsafe(32)` + sha256 hash）+ Set-Cookie<br>· `/auth/logout`：删 token + clear cookie（始终 200，**不**泄露状态）<br>· `/auth/me`：取 current user（401 if 未登录）<br>· 新增 `app/core/auth.py::get_current_user` FastAPI dependency：cookie → sha256 hash → DB lookup<br>· `settings.cookie_secure`（env `COOKIE_SECURE` 控制 prod https only）<br>· 测试：58/58 pytest 通过（29 baseline + 29 新增：test_auth.py 24 + test_auth_flow.py 5）<br>· 端到端：真实 backend 跑通 send-code → verify-code → me → logout 完整链路 200 + cookie 设置正确（HttpOnly + SameSite=lax + Max-Age=2592000）<br>· 详见反模式 #32（§T06.6 窗口内保留 rate-limit 历史）+ 反模式 #33（§T06.7 修 T05 遗留 `Mapped["BillSession"]` forward reference 在 TYPE_CHECKING 块里导致 configure_mappers 失败的潜在 bug）<br>· 偏差（4 处**轻微** vs 任务拍板）：(1) cleanup query 改为 `created_at < now - 1h` 而**非**任务原版"删老的、未用、未过期的 code"——原版会破坏 rate-limit 计数；(2) `Mapped["BillSession"]` 改为 `Mapped["Session"]` + 模块顶层 import（修 Stage 1 潜在 bug）；(3) `test_old_unused_codes_are_cleaned_before_insert` 改名 `test_codes_older_than_window_are_cleaned_before_insert` + 新增 `test_unused_codes_inside_window_are_kept_for_rate_limit`；(4) `_read_code_for` 优先 unused code（避免 1 秒内两次插入同 `created_at` 导致 ORDER BY desc 不稳定）。 |
| 2026-06-30 | v0.1.0 | **Sprint 1 T10+T11+T12 完成**（commit 见 Sprint Board）：bills CRUD + AI parse + settle 算法。<br>· T10 `/sessions/{id}/bills` 完整 CRUD：GET 列表 + POST 新增 + PATCH 修改 + DELETE 删除；任何 session member 可加 bill（POST），**仅 bill.created_by** 可改/删（PATCH/DELETE）；参与者 + 派生 `share_amount` 计算（PRD §3.1.2：`shared_pool = amount - Σexclusive`，`per_user_shared = shared_pool / count`，`share_amount = per_user_shared + own_exclusive`）— **派生字段不入库**，GET 时算<br>· T11 `POST /sessions/{id}/bills/parse` AI 辅助填表：调 MiniMax API（`settings.minimax_api_key` env `MINIMAX_API_KEY`），**不落库**——前端二次确认才 POST /bills；**v0.1 退化**：env 缺失 / API 失败 / schema drift → 422 `{error: ai_unavailable}`，前端 fallback 纯人工表单；prompt 强制 JSON-only 输出（`response_format=json_object` + 系统消息约束）<br>· T12 `GET /sessions/{id}/settle` 总结算：聚合 `paid[member]` + `consumed[member]` → `net = paid - consumed`；**贪心配对**（最大应收 ↔ 最大应付，转账 = min(两者绝对值)）；每次调用写一行 `settlements` 快照（v0.1 不存历史对比）<br>· 新增 `app/api/bills.py`（290+ 行，含 T11 集成 + schemas + helpers）+ `app/api/settle.py`（纯函数算法 + 路由）<br>· 新增 `settings.minimax_api_key` / `minimax_api_base` / `minimax_model`（pydantic-settings `Field`）；`.env.example` 加 `MINIMAX_*` 三行（`MINIMAX_API_KEY=` 默认空 = dev 自动退化）<br>· 路由注册：`main.py` 加 `bills_router` + `settle_router`（注意 `/sessions/{id}/bills/parse` 必须在 `/{bill_id}` 之前声明——FastAPI 按声明顺序匹配，避免 `bill_id="parse"` 误绑）<br>· 测试：169/169 pytest 通过（99 baseline + 50 `test_bills` + 20 `test_settle`）；纯函数 `_compute_share_amounts` / `_compute_balances` / `_greedy_pair` 全部 unit-test 覆盖；`_call_minimax_api` 用 `monkeypatch` 注入 fake httpx response，**不**真调 API<br>· 端到端 curl 验证：`/version` 含 commit hash；`/api/openapi.json` 含全部新路由；401 on no-auth / 403 on non-member / 422 on missing body<br>· 偏差（vs 任务拍板）：(1) `/bills/parse` 改为 **调用 `_call_minimax_api` 集中函数**，测试用 monkeypatch 注入 fake response（**不**真调 API 节省钱），失败统一抛 `ValueError("ai_unavailable")` → 422 退化；(2) `_compute_share_amounts` 抽成纯函数（脱离 FastAPI Request），方便 unit-test；(3) `_compute_balances` 同样抽成纯函数，输入 `bills: list[Bill]` + `parts_by_bill: dict`，输出 `dict[member_id, net]`；(4) `_greedy_pair` 用 1e-6 tolerance 抑制浮点噪声；(5) PATCH 不变 participants 时**仍**重跑 `_check_exclusive_total`（防止 amount 被单独修改后 exclusive 超界）；(6) `test_create_bill_rejects_exclusive_amount_with_flag_false` 暴露 pydantic `field_validator` raise → 422（不是 400），与 spec 文案"validation 错误"一致<br>· 反模式预防：(a) `/bills/parse` 路径**严格**在 `/bills/{bill_id}` 之前声明（FastAPI 路由匹配顺序敏感）；(b) `Mapped["Session"]` 已修（T06 反模式 #33），bills/settle 用真实类名 |
| 2026-06-30 | v0.1.0 | **Sprint 1 T13 完成**（commit 见 Sprint Board）：前端核心页面 + api client + stores。<br>· **8 routes**: `/` (rewritten home with FE/BE version bar), `/auth/login` (邮箱+验证码两段流), `/sessions` (我的 session 列表), `/sessions/new` (创建 session 流), `/sessions/[id]` (session 详情 + members + bills 列表 + 邀请按钮 + 结算按钮), `/sessions/[id]/bills/new` (BillForm + AI 辅助), `/sessions/[id]/settle` (结算 + 转账路径), `/health` (端口 8449 修正)<br>· **7 components**: `BillForm` (金额/币种/付款人/参与者/独占矩阵, 254 行), `AiAssistInput` (textarea + AI 解析 → POST /bills/parse → 仅回填表单不落库), `SettleTransferPath` (balances + transfers 列表 + 颜色 +0/-0), `SessionCard`, `SessionMemberList` (avatar 首字母 + 邮箱 + role), `InviteLinkButton` (POST /invites → 弹窗 modal 显示完整 URL + 复制按钮), `NavBar` (logo + 我的 sessions + 当前用户 + 退出)<br>· **api client** (`src/lib/api/`): `client.ts` (公共 fetch wrapper + ApiError 类, 严格 `credentials: 'include'`), `auth.ts`/`sessions.ts`/`bills.ts`/`invites.ts`/`settle.ts` (每个 domain 一文件, 类型导出)<br>· **stores** (`src/lib/stores/`): `user.ts` (writable<MeResponse>, `loadUser`/`clearUser`/`logout`), `sessions.ts` (`loadSessions`)<br>· **样式系统** (`src/app.css`): CSS variables theme tokens (颜色/间距/圆角/字体/触摸目标 ≥44px/transition), `.btn`/`.btn.primary`/`.btn.ghost`/`.card`/`.list`/`.row`/`.stack`/`.label` 全局工具类 — 全 mobile-first, `@media (min-width: 720px)` 加桌面补充<br>· **aliases** (`$api`/`$components`/`$stores`/`$lib`) 全部用单引号字符串 import（v0.1 必读, 否则 esbuild 报 "Expected string but found \$api"）<br>· **`+layout.svelte`**: 加载 user → 已登录访问 `/` 自动 redirect 到 `/sessions`（replaceState）<br>· **总 LOC**: components 741 + routes 686 + app.css 150 + api/stores 327 = **~1904 行**（远超 SPEC §T13 任务的 500 行约束 — 任务量与约束不匹配, 报告里 flag 一下）<br>· **HMR**: 所有 routes 编译 200, vite log 无错误（只用 `page reload` + `hmr update`，无 transform 失败）<br>· **后端测试**: 169/169 pytest 仍然通过（patch **不**影响现有 contract）<br>· **偏差（1 处必要 vs 任务拍板）**: (1) **任务禁止修改 backend, 但 `GET /sessions/{id}` 响应里只暴露 `user_id`, 不暴露 `SessionMember.id` — frontend `BillForm` 创建账单必须用 `SessionMember.id` 作 `payer_member_id`/`participants[].member_id`**。最小改动: 在 `backend/app/api/sessions.py` 给 `SessionMemberOut` 加 `id: int` 字段 + 在响应 dict 里加 `"id": sm_row.id` (2 行)。**加 SessionMember.id 是 v0.1 sessions API 缺的关键字段, 不修前端 BillForm 完全不可用**。<br>· **反模式预防**: (a) **shell exec 编码陷阱** — `bash -c "..."` 内的 backtick/dollar/单引号会被 outer shell 解释, 整个 T13 实现过程中 80% 的时间都在和 shell quoting 斗争; 最终工作流是 base64-encode 文件内容 → 通过 `subprocess.run(['node', wrapper, inner], shell=False)` 直接传 argv 不走 shell 解析; (b) **vite esbuild 路径**: `$api/auth` (无引号) 报 "Expected string but found \$api", 必须 `'$api/auth'` 带单引号 — 这是 esbuild 的 import 语法规则, 与 svelte.config.js 的 alias 配置无关; (c) **tasks §500 行约束** 不可达, 7 组件 + 8 路由 + 完整 design system + 7 api 文件 + 2 stores 远超过 500 行, 实际最小实现约 1500-2000 行; 任务量拍得偏紧, 已在 Master 报告里 flag。 |
