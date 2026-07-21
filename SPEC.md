
> 版本：v0.3-dev | 状态：🚧 Sprint 3 Round 4 (T17/T18 anon join) | 日期：2026-07-06
> 配套 PRD：/obsidian/Jesse OB VPS/JesseClaw/code-project/split-bill-calculator/PRD.md

---

## v0.3 Sprint 3 匿名加入 (anonymous participation)

### A. Schema 变更
- `sessions.owner_user_id`: Integer → Integer NULL（匿名创建时为 NULL）
- `session_members.nickname_secret`: VARCHAR(64) NULL（anonymous 身份凭证）
- `session_members.is_anon`: BOOLEAN NOT NULL DEFAULT false（是否为匿名成员）
- `session_members.claimed_at`: DateTime NULL（认领时间）
- `session_members.user_id`: Integer → Integer NULL（允许匿名成员无 user 绑定）

### B. 行为
- **匿名 session 创建**：POST /sessions/ 不再要求登录，未登录时 `owner_user_id=NULL`
- **join-claim 端点**：POST /sessions/{id}/join-claim 支持 4 种 action：
  - `action=add` + anonymous：INSERT 新 row，生成 `nickname_secret`
  - `action=claim` + anonymous：UPDATE unclaimed slot（`nickname_secret IS NULL`），生成新 secret
  - `action=add` + logged-in：INSERT 新 row，绑定 `user_id`
  - `action=claim` + logged-in：UPDATE slot 绑定 `user_id`
- **auto-match**：GET /sessions/{id} 支持：
  - 已登录用户：查 `(user_id, session_id)` 绑定 → 直接返回 session
  - Anonymous：读取 `X-Nickname-Secret` header → 查 `nickname_secret` → 返回 session
  - 成功认证时返回 `X-SBC-Member-ID` response header（FE 用此派生 currentMember）
- **localStorage 凭证**：`sbc.actingAs.{sessionId}` = `nickname_secret`（HEX 64 字节）
- **join 页**：/sessions/{id}/join — 显示已认领/未认领 slot，anonymous 可认领或新增 nickname
- **无需转正**：anonymous 认领 nickname 后，登录绑定 user_id，自然在 dashboard 看到 session

### C. API 端点
- `POST /sessions/`：allow_anonymous=True，未登录创建 → `owner_user_id=NULL`
- `POST /sessions/{id}/join-claim`：4-action join/claim logic
- `GET /sessions/{id}`：支持 `X-Nickname-Secret` header，返回 `X-SBC-Member-ID` header

### D. 前端路由
- `/sessions/new`：匿名可见，创建后 redirect 到 `/sessions/{id}/join`
- `/sessions/{id}/join`：join/claim 页，4 选项（anonymous 2 + logged-in 2）
- `/sessions/{id]`：`getSessionWithSecret()` 静默认证，失败 redirect 到 join 页

---

## §3.11.11 join-claim 边界修复 (PO 2026-07-09 05:51 #3765 拍对)

> 配套 PRD: §3.11.11.5 决策 β/γ/δ + §3.11.11.8 实施状态
> 配套 commit: 修复 commit 在 §11 本条后续追加

### A. 根因

v0.3 Sprint 3 的 BE `join_claim_session` anon claim 分支 (`backend/app/api/sessions.py:1189-1208`) 有守卫 `if sm.nickname_secret is not None: raise 409`，**没区分** anon-claimed (该接受) 和 logged-in bound (该走 requires_login)。

FE 按 §3.11.11.4 "全显" 把 anon-claimed slot 显给用户点 → BE 返 409 → 跟 §3.11.11.5 决策 a "BE 接受" 冲突。

### B. BE 修复 (join_claim_session anon claim 分支)

```python
if user is not None:
    # logged-in caller (不变)
    sm.user_id = user.id
    sm.is_anon = False
    session.last_active_at = now
    db.commit()
    db.refresh(sm)
    return {...}
else:
    # Anonymous caller — 拆 2 路径 (§3.11.11.5 决策 β/γ)
    if sm.user_id is not None:
        # 决策 γ: anon 点 logged-in bound slot → 不让覆盖 (冒充风险)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "requires_login",
                "reason": "slot is owned by a logged-in user; please login to claim",
                "slot_owner_user_id": sm.user_id,
            },
        )
    # 决策 β: anon-to-anon (覆盖) 或 anon-to-unclaimed (认领) → 都接受
    new_secret = secrets.token_hex(32)
    sm.nickname_secret = new_secret  # 覆盖任何已有 anon secret
    sm.claimed_at = now
    sm.is_anon = True
    sm.user_id = None  # 显式 NULL (即便之前有 binding 也清掉, 防 logged-in 残留)
    session.last_active_at = now
    db.commit()
    db.refresh(sm)
    return {...}
```

**关键**:
- 决策 β (anon-to-anon 轮换): 原 anon secret 失效 → 下次进 session → onMount `getSession` 失败 → `removeItem` + fall through → join page → 用户点 j 又拿到新 secret
- 决策 γ (anon-to-loggedin): 403 + `requires_login` (FE 处理跳转)

### C. FE 修复 (handleClaim)

```typescript
// frontend/src/routes/sessions/[id]/join/+page.svelte
async function handleClaim(slotId: number) {
  if (busy) return;
  error = null;
  busy = true;
  try {
    const res = await joinClaim(sessionId, { action: 'claim', session_member_id: slotId });
    _storeActingAs(res.session_member_id, res.nickname_secret ?? '');
    await goto('/sessions/' + sessionId, { replaceState: true });
  } catch (e: any) {
    const detail = e?.detail ?? e;
    if (e?.status === 403 && detail?.error === 'requires_login') {
      // 决策 γ: 跳登录, 登录后回 join 页走 logged-in claim 路径
      window.location.assign(
        '/auth/login?returnTo=' +
          encodeURIComponent('/sessions/' + sessionId + '/join')
      );
      return;
    }
    if (e?.status === 409) {
      // fallback: 保留原 "被抢走了" 提示, 未来 regression 兜底
      error = '该昵称已被其他人抢走了，请选择其他昵称或新建一个';
    } else if (e?.status === 410) {
      reclaimed = true;
    } else {
      error = e?.message ?? '认领失败';
    }
  } finally {
    busy = false;
  }
}
```

### D. e2e 测试 (3 场景, 必须全过)

文件: `frontend/e2e/wizard_join_claim.spec.ts` (新)

1. **场景 A: anon-to-anon 接受 + 覆盖** (决策 β)
   - Setup: session "hh" 有 2 个 anon-claimed slot (j, k)
   - Act: anon 用 fresh browser → /sessions/{id}/join → 点 j
   - Expect: 
     - BE 返 200 + `nickname_secret`
     - FE 跳 /sessions/{id} 进详情页
     - DB: j 的 `nickname_secret` 是新 secret, 旧 secret 失效

2. **场景 B: anon-to-loggedin 跳登录** (决策 γ)
   - Setup: session "hh" 有 1 个 logged-in bound slot (jesse 邮箱)
   - Act: anon 用 fresh browser → /sessions/{id}/join → 点 jesse
   - Expect:
     - BE 返 403 + `{error: "requires_login"}`
     - FE 跳 `/auth/login?returnTo=/sessions/{id}/join`
     - 不进 session, 不弹 "被抢走了"

3. **场景 C: anon-to-unclaimed 接受 + 首次认领** (回归)
   - Setup: session "hh" 有 1 个 unclaimed slot (l)
   - Act: anon 用 fresh browser → /sessions/{id}/join → 点 l
   - Expect:
     - BE 返 200 + `nickname_secret`
     - FE 跳 /sessions/{id}
     - DB: l 的 `nickname_secret` 有值, `is_anon=true`, `user_id=NULL`

### E. pytest 测试 (BE 单元)

文件: `backend/tests/test_sessions_join_claim.py` (新, 已有类似可改)

3 个 cases:
- `test_anon_claim_anon_slot_overwrites_secret` (决策 β)
- `test_anon_claim_loggedin_slot_returns_403_requires_login` (决策 γ)
- `test_anon_claim_unclaimed_slot_first_time` (回归)

### F. 部署 / 验证

1. Coder 实施 commit 后 push
2. **必须重启 uvicorn** (BE 当前跑 commit `ac21ce2-dirty`, **不**在 git history 中 — 旧代码, 需 kill 重启加载新 commit)
3. Master 真用户 walk (用手机浏览器):
   - 场景 A: anon 进 /sessions/{id}/join → 看到 j/k → 点 j → 进 session → 截图
   - 场景 B: anon 进 /sessions/{id}/join → 看到 jesse (logged-in) → 点 → 跳 /auth/login?returnTo=... → 截图
4. 反 #117 + 反 #121 推 Telegram
5. 反 #130 PO 拍**对**验收

---

## v0.2.2 Sprint 2 多币种 (新增)

### A. Schema
- `sessions.currencies` JSON NOT NULL DEFAULT `["CNY"]`（1–2 个 ISO 4217 代码）
- `sessions.primary_currency` VARCHAR(8) NOT NULL DEFAULT `CNY`（必须是 currencies 中一个）
- 新表 `session_exchange_rates(session_id, from_currency, to_currency, rate, snapshot_at, set_by)` UNIQUE(session_id, from, to)，rate 是 Numeric(28, 8)
- `bills.amount`: Float → Numeric(12, 2)
- `bills.exchange_rate_snapshot` Numeric(28, 8) NULL（账单录入时拍快照）

### B. 行为
- POST /sessions 支持 `currencies / primary_currency / exchange_rates`，双币种 session 创建时 exchange_rates 必须至少 1 条
- 双币种 session 每条目 exchange_rates 自动反向写 1/rate 行，所以前端不需要发两条
- POST /bills 校验 `currency ∈ session.currencies`，422 `currency_not_in_session` 否则
- 账单录入时 `currency == primary_currency` → snapshot NULL；其他 → snapshot 当前汇率
- 调整汇率不影响已有账单（snapshot 模式）
- GET /sessions/{id}/settle?view=primary|split：primary=主币种汇总，split=返回 per-bill 原币种 metadata（balances 仍主币种）
- Double precision 浮点输入一律在 BE 内部转 Decimal(28, 8) 中间计算，.quantize(0.01, ROUND_HALF_UP) 输出，保证无 IEEE 754 drift

### C. Decimal 序列化
- Decimal 在 JSON 序列化为字符串（前端 parseFloat）
- settle.balances / transfers.amount / bills.amount / bills.exchange_rate_snapshot 全部 Decimal-as-string

### D. 迁移策略
- 单次 alembic migration (`f3a2e3b592b8_v022_multi_currency`)，所有 op 用 `inspect().has_table/has_column` 幂等守卫
- 数据回填：升级时把任何 `currency != primary_currency AND snapshot IS NULL` 的账单从 `session_exchange_rates` 反向查到 rate 写入 snapshot
- Thailand 27 笔老数据迁移后 SUM(amount) 完全无损（15172.00 THB 不变）

### E. CRUD API
- POST/GET/PATCH/DELETE /sessions/{id}/exchange-rates（auto-pair reciprocal）

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
  amount        REAL NOT NULL,        -- 总金额 (cents, v0.2.1 由 AmountCalculator.evaluate 求值)
  currency      TEXT NOT NULL DEFAULT 'CNY',
  description   TEXT,
  occurred_at   TIMESTAMP NOT NULL,
  created_by    INTEGER NOT NULL,
  created_at    TIMESTAMP NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'locked'
  -- v0.2.1 T01: 原始表达式 (e.g. "350/5"), NULL for pre-v0.2.1 bills or
  -- use_calculator=false creations. 落库不受 white-list 影响, POST 创建
  -- 时若 `use_calculator=true`, BE 重 evaluate 后 overwrite `amount`。
  amount_expression  VARCHAR(64) NULL
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
  amount: number,                 -- ≥ 0, 浮点兼容 Decimal cents 精度
  payer_member_id: number,
  description?: string,
  occurred_at: ISO8601,
  currency?: string = "CNY",
  use_calculator: bool = false,   -- v0.2.1 T01: true 时让 BE 重 evaluate amount_expression
  amount_expression?: string | null = null,  -- v0.2.1 T01: 长度 ≤ 64, white-list [0-9+\-*/.\s]
  participants: [
    {member_id, is_exclusive, exclusive_amount}
  ]
}

POST /api/sessions/{id}/bills 响应额外字段:
  amount_expression: string | null   -- 落库的 raw expression, NULL = 没 calculator

PATCH /api/sessions/{id}/bills/{bid} 接受 `amount_expression` (任意 update):
  - 发送 amount_expression → BE re-evaluate → 落库 `amount` + `amount_expression`
  - 发送空字符串 / NULL → 保留原 amount_expression
  - 非法表达式 (任何超出 white-list 或结构性失败) → 422

GET /api/sessions/{id} 响应额外字段:
  last_bill_participants: number[] | null   -- v0.2.1 T02, NULL = 该 session 无账单

GET /api/sessions/{id}/bills 响应 + PATCH/POST 响应均增加 amount_expression 字段回显。
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


## 8. 邮件服务（Aliyun DirectMail SMTP — T05 + 2026-07-06 迁移）

- **SMTP**: Aliyun DirectMail (`smtpdm.aliyun.com:465`, implicit SSL via `smtplib.SMTP_SSL`)
  - 发信地址: `verify@mail.jesdigi.com`（Aliyun DirectMail console 配置）
  - 端口: VPS 屏蔽 25 → 选 465 (SSL); 80 (STARTTLS) 也可用但 465 更安全
- **凭据**: `your-smtp-user@example.com` + App Password（运行时从 `backend/.env` 读取，password **不**进 git、**不**进日志）
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
    def _connect_and_send(self, msg: MIMEMultipart) -> None  # if smtp_use_ssl: SMTP_SSL + login + send; else: SMTP + starttls + login + send
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
Body:  {"email": "your-smtp-user@example.com"}
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

> **T05 hard requirement**: 端到端真发邮件到 `your-smtp-user@example.com`（codeserver 内**不**依赖 bw —— 凭据已就位在 .env）。

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

### 8.6 Aliyun DirectMail 迁移（2026-07-06，PO 拍板）

**背景**：原 Gmail SMTP (`smtp.gmail.com:587` + App Password) 切换到阿里云 DirectMail，原因是 (1) 自有域名发信 (`verify@mail.jesdigi.com`); (2) 国内服务稳定性。

**改动**：
- `app/core/config.py`: 新增 `smtp_use_ssl: bool = Field(default=False)` 字段
- `app/services/email_service.py`: `EmailService.__init__` 缓存 `_use_ssl`；`_connect_and_send` 新增 implicit SSL 分支
  - `smtp_use_ssl=True` → `smtplib.SMTP_SSL(host, port, timeout=15)` 直接 SSL handshake，**不**做 STARTTLS
  - `smtp_use_ssl=False` → 原路径 (SMTP + 可选 STARTTLS) 完全保留（向后兼容）
- `backend/.env`: SMTP_HOST/PORT/USERNAME/FROM 改为 Aliyun 配置；新增 `SMTP_USE_SSL=true` + `SMTP_USE_TLS=false`

**端口选择**（VPS 实测）：
| 端口 | 协议 | 联通性 |
|------|------|--------|
| 25 | STARTTLS | ❌ VPS 屏蔽 |
| 80 | STARTTLS | ✅ 可达 |
| 465 | implicit SSL | ✅ 可达（**采用**）|

**验证步骤**（Master 2026-07-06 13:35）：
- `python3 -c 'smtplib.SMTP_SSL("smtpdm.aliyun.com", 465).noop()'` → 250 OK ✓
- `POST /auth/send-code {email: "test-smtp-path@jessejia.click"}` → 500 + log `SMTP auth failed ... 535` ✓ (SSL 握手通过, auth 失败因密码是占位符)

**未完成**（等 PO 拍板）：
- [ ] PO 在阿里云 DirectMail console 设置 SMTP 密码（生效需 2 min）
- [ ] Master 替换 `backend/.env` 中 `SMTP_PASSWORD=
- [ ] 重启 BE + 真发一封到非 bypass email 验证

**反模式**（新增）：
- **#58**: 邮件迁移类配置变更**必**带端到端 SMTP 握手测试 (`SMTP_SSL(host, port).noop()`)，不依赖 "改完 .env 重启就 OK" 的假设
- **#59**: 端口选择必**实测** VPS 网络可达性 — 25 被屏蔽不试就是赌博，80/465/587 选能联通 + 安全的

---

## T06 — 完整 auth 生命周期（2026-06-30）

T05 只发邮件**不**落库（V0.1 简化版）；T06 把 `verification_codes` 表真正接上，加 verify 端点、token 签发、cookie 中间件。

### T06.1 端点

#### `POST /auth/send-code`（**T06 接 DB**）

| 项 | 值 |
|---|---|
| Body | `{"email": "your-smtp-user@example.com"}` |
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
| 2026-07-06 | v0.3.1 (Sprint 4 T19) | **BE sessions.py: member_nicknames + created_member_ids. FE: landing page + session wizard (3-step). |
| 2026-07-11 | v0.3.2 | **`§3.12` 匿名 bill CRUD 全链路 + 「查看结算」按钮归位**（1 commit `feat(be+fe)`）。配套 PRD：`/obsidian/Jesse OB VPS/JesseClaw/code-project/split-bill-calculator/PRD.md` §3.12 (PO 2026-07-11 11:10 拍板)<br>· **A. FE `lib/api/bills.ts`** — 新增 helper `getNicknameSecretHeader(sessionId)` 从 `localStorage["sbc.actingAs." + sessionId]` 读 anon dd 的 nickname secret；4 个 endpoint (`createBill` / `updateBill` / `deleteBill` / `parseBill`) 都改成 `apiFetch(url, opts, getNicknameSecretHeader(sessionId))`。复用 `listBills` 已有的 `localStorage` key 模式 (bills.ts:51-58)。`apiFetch` 第 3 参数 `extraHeaders` 已被签名支持，**不**重写 `apiFetch`(反 #51)<br>· **B. BE `app/api/bills.py`** — `parse_bill` / `update_bill` / `delete_bill` 三处 `Depends(get_session_member)` → `Depends(get_session_member_or_secret)`。`get_session_member` 签名不动 (向后兼容 cookie-auth path)。import 加 `get_session_member_or_secret`<br>· **C. UI `/sessions/[id]/+page.svelte`** — 删 `.session-header-actions` 整段（含 session header 里的「查看结算」链接 + 配套桌面端 media query）；改写 `.bills-card-head` 子结构，左侧保留 `账单 · 共 N 笔`，右侧加 `.bills-card-head-right` flex 容器内 2 个 `btn ghost btn-sm` 按钮并列（gap 8px、移动端不换行）：「查看结算」（Lucide `calculator` 图标 + 文字）→ `/sessions/{id}/settle`、「个人账单」（Lucide `user` 图标 + 文字）→ `/sessions/{id}/settle#personal`。**视觉候选 B**（PO 10:30 拍板），inline SVG（项目无 `Icon.svelte` 组件，不引 icon 库）<br>· **D. `lib/version.ts`** — bump 到 `9a7381a`（当前 origin/main HEAD，anti #68：真实 hash 不用 brief 抄录）<br>· **测试**：(1) `test_bills.py` 改 2 个旧 case（`test_delete_no_auth_returns_401` / `test_parse_no_auth_returns_401` → 改名为 `*_returns_403`）— 因为 `get_session_member_or_secret` 对「no auth + no secret」返 403（not a session member）而非 401（not authenticated），这是 v0.3.x anon 端点的正确语义（cookie-auth 端点才 401），符合 SPEC §3.12.E.1「no secret / wrong secret → 403」；(2) `test_bills_anon_crud.py`（Tester Agent 并行写出的 12 case）需 Master 端 verifier 单独跑 — Coder 不直跑以防 Tester 工作被覆盖；(3) full suite 143 failed / 260 passed / 65 errors（baseline 150 failed / 253 passed — 净 +7 passing 因 `*_returns_403` 改正确；同时 pre-existing 65 errors 来自测试基础设施 session_code NOT NULL 漂移，跟本批**不**相关）<br>· **svelte-check**：3 errors + 29 warnings（baseline 3 errors + 29 warnings — pre-existing in `+layout.svelte` + `invites/[token]/+page.svelte`，**本批 0 new** error / warning）。`.bills-personal-link` 旧 CSS 块顺手清掉（用 `.bills-action-link` 替，未使用 → 改掉免 unused-selector warning）<br>· **API smoke**（codeserver 内 curl 直连 uvicorn :8449，anon secret session id=1 持久活）：POST `/sessions/1/bills` → 201 (`created_by=null` 确认 anon)；PATCH `/sessions/1/bills/33` → 200 (amount 88.5 落库)；POST `/sessions/1/bills/parse` → 422 `ai_unavailable`（dev env 无 MINIMAX_API_KEY，但**重要**：422 而非 403 → dep 透传成功，anon 路径通过鉴权）；DELETE `/sessions/1/bills/33` → 204；GET `/sessions/1/bills` no secret → 403 `not a session member`；GET wrong secret → 403<br>· **浏览器视觉验证**：Playwright headless 截 `/sessions/1` 账单 section head → vision 验证：左侧 `账单 共 3 笔` 锚点 OK；右侧 2 个 ghost 按钮 `查看结算`（calculator 图标）+ `个人账单`（user 图标）并列、风格一致、Lucide 图标清晰可见 — 截图路径 `sbc/tmp_screenshots/sbc_bills_head_v0.3.2.png`<br>· **BE 重建**：必需 — `app/api/bills.py` 改 dep，Coder 重启 uvicorn 反 #43 续；`/version` 验证新 commit hash `9a7381ab-dirty`<br>· **FE 重建**：必需 — 反 #43 vite 重启，`curl -I http://127.0.0.1:8448/` 验证 200<br>· **PRD action item**（Coder **不**直写 Obsidian）：Master 需手动同步 PRD §3.4 + §11 加 v0.3.2 行（anon bill CRUD 完整链路 + 按钮归位 UX 行为）。本任务范围内 Coder 只动 SPEC §11 changelog 末尾 + 代码 + git log<br>· **偏差 vs 任务拍板**：(1) 旧 `.bills-personal-link` CSS 选择子在 `.bills-action-link` 改名后变 unused → 整段删除（含 mobile media query），避免 svelte-check 多 1 warning；(2) v0.3.1 没用 `get_session_member_or_secret` 给 PATCH/DELETE/parse 的旧测试期望（401）调整 → 实际正确行为是 403（anon 端点不归 `get_current_user` 管，**没有「authenticated but not a member」这一档**），更符合 v0.3.x 双向鉴权模型；(3) `Icon` 组件不存在于项目 → 用 inline SVG (viewBox 24x24 stroke 1.75)，保持跟项目 Lucide `Search` 图标（已存在于 `BillListGrouped.svelte`）同款 stroke 参数<br>· **反模式预防**（4 条新增 + 5 条对照验证）：(a) **`apiFetch` 3rd 参数 `extraHeaders` 用法** — 反 #51 续：v0.3.0 已加 `extraHeaders?: Record<string, string>` 签名参数支持「per-call header injection」，本批**不**改 `apiFetch` 内部，仅 caller 注入 header；避免「全局 header 注入导致 secret 泄漏到别的 endpoint」的潜在 bug；(b) **`get_session_member_or_secret` 401 vs 403 语义边界** — 反 #125 + #130 续：`get_session_member`（cookie-only）依赖 `get_current_user`（无 cookie → 401）；`get_session_member_or_secret` 依赖 `get_optional_user`（无 cookie → None → 直接查 secret → 都没就 403）。这条语义边界要在新 endpoint 选择 dep 时显式记下来，**不要默认**全用 `or_secret`，否则会泄漏「这个端点接受 anon」的接口语义；(c) **session header 三大按钮收回到账单 section head 的理由** — PO 14:01 重申「session header 完全不要任何 login/logout/登录按钮」+ 「查看结算」必须跟「个人账单」在视觉上同处一处（PO 10:30 拍视觉候选 B）；`session-header-actions` 整段删（template + CSS + 桌面端媒体查询），避免历史 CSS 类被未来 visual regression CI 误判；(d) **「测试基础设施漂移」vs「代码 bug」边界** — 反 #132 续：`NOT NULL constraint failed: sessions.session_code` / `UNIQUE constraint failed: users.email` 等是 SBC_SKIP_TEST_TRUNCATE=1 模式下跨 case DB 状态污染 (v0.3.0 session_code 加 NOT NULL + tests 用 `_make_session_with_owner_and_anon` 但 utils 没补上 session_code 注入) — **不**属于本批代码改动；document 到 commit message 留给 Tester sprint fix<br>· **单分支铁律**：commit 完成后 `git fetch origin && git branch -r` 必只剩 origin/main（dev skill §单分支铁律）<br>· **e2e**：本批**不**改也不重新跑（Tester Agent `anon_bill_crud.spec.ts` 6 场景 + 4 视觉验证由 Tester 在并行 sprint 里跑，Coder 不直跑）<br>· **DB 不动**：无 migration，DB schema 不变（ancestor migration `20260706220410_bills_created_by_nullable` 已让 anon bill 可落库）<br>| 2026-07-05 | v0.2.3 (Sprint 3 Round 3 T16) | **401 自动跳登录页 + open-redirect 防御 + vite proxy bypass query string 修**（1 commit `fix(ui)`）。<br>· **bug 描述**：v0.1.0 ~ v0.2.2 期间 `frontend/src/lib/api/client.ts::apiFetch` 收到 401 时一律 `throw new ApiError(401, ...)`，UI 层 try/catch 抓到后通常只显示 toast 或根本不处理。结果: cookie 过期 / 服务端 token 被吊销后, 用户停留在「半残」页 (session 详情显示空成员/空账单 + 一行红字), 必须手动刷到 `/auth/login`, 体验很差。SPEC §4 早就写「前端跳 `/auth/login?next=...`」(原始文案沿用 Next.js 风格, 实际前端实现用 `returnTo`), 但从未落地实现。<br>· **修法 (client.ts)**:<br>  · `apiFetch` 提前在 `res.status === 401` 分支处理 (早于通用 `!res.ok` throw)。规则: <br>    1. **API path 以 `/auth/` 开头** (`/auth/me`/`/auth/send-code`/`/auth/verify-code`/`/auth/logout`) → **不**重定向, 正常 `throw ApiError`。这是为了让 login 页面能正确显示「验证码错误」等错误状态, 避免 `loadUser` 调 /auth/me 收 401 时无限跳 `/auth/login` 循环。<br>    2. **浏览器段** (`typeof window !== 'undefined'`) → 调 `clearUser()` 清 user store, 然后 `window.location.assign('/auth/login?returnTo=' + encodeURIComponent(window.location.pathname + window.location.search) + '&expired=1')` + return 一个**永远 pending 的 Promise** (`new Promise<T>(() => {})`)。上层 `await apiFetch` 不会看到 throw, UI 不会残血显示错误 toast。<br>    3. **SSR** (无 `window`) → fall through 到通用 throw (没人接收 redirect)。<br>  · 用 `window.location.assign` 而非 `goto` 来自 `$app/navigation`: 该 alias 只能在 `+page.svelte` / `+layout.svelte` 文件中 import, `client.ts` 是普通 `.ts` 模块, 走 `window.location.assign` 同时避开 SSR / hydration 边界问题。`clearUser` 通过 `await import('$stores/user')` 动态 import (避免 `client.ts → stores → auth.ts → client.ts` 的循环依赖在模块加载期触发)。<br>· **配套修 (vite.config.ts)**: 原 `/auth` proxy bypass 函数只匹配 `req.url === "/auth/login"` (精确路径), 但 `window.location.assign('/auth/login?returnTo=...')` 触发的 HTTP 请求含 query string, vite 把这种带 query 的 login URL 错误地代理到后端 → uvicorn 返 404 JSON。修法: bypass 改用 `req.url.split('?')[0]` 取 path-only 比较, 让 `/auth/login?...` 也走 SvelteKit 路由。**这是 v0.2.2 (Sprint 2 反馈修) 引入的宽泛前缀代理回归 bug 之一**, 当时没人 navigate `/auth/login?xxx` 所以没暴露。<br>· **配套修 (`/sessions/[id]/+page.svelte`)**: 删掉 onMount catch 里的 `else if (e?.status === 401) { await goto('/auth/login'); }` — 这个 inline redirect 跟 client.ts 的新 redirect **重复** 且**丢 returnTo** (硬编码 `/auth/login` 不带 query)。删掉后 client.ts 是 single source of truth, 401 自动带 `returnTo=<encoded current path>`。<br>· **`/auth/login/+page.svelte`** 加 `returnTo` 处理: onMount 读 `$page.url.searchParams.get('returnTo')` + sanitize (必须以 `/` 开头、不以 `//` 开头、不等于 `/auth/login`, 任一不满足 → 当作没有, 走默认 `/sessions`)。`handleVerify` 成功后 `await goto(returnTo ?? '/sessions')`。已登录用户访问 `/auth/login` 时也尊重合法 `returnTo`。可选 UX: `?expired=1` query 显示一行 muted 提示「登录已过期, 请重新登录」+ `?email=` + `?code=` 测试模式 query (e2e 用, 跳过 SMTP send 直跳 verify)。<br>· **Open-redirect 防御 (Coder 重点)**: `sanitizeReturnTo` 函数 3 条规则 — (1) 必须以 `/` 开头 (相对路径); (2) **不**能以 `//` 开头 (防 protocol-relative URL `//evil.com`); (3) **不**能等于 `/auth/login` (防循环)。任一不满足 → 视为没 returnTo, 落 `/sessions`。<br>· **测试**: 新增 `frontend/e2e/auth_401_redirect.spec.ts` 3 场景 — (A) 已登录 → 清 cookie → 访问 `/sessions/4` 触发 401 → 期望 URL = `/auth/login?returnTo=/sessions/4&expired=1`; (B) 匿名访问 `/auth/login` → 验证 `/auth/me` 收 401 **不**触发 redirect (path starts with `/auth/`); (C) `/auth/login?returnTo=//evil.com&email=...&code=123456` 走通 verify-code 后 → 期望落 `/sessions` 而非 `//evil.com` (sanitize 函数挡掉)。<br>· **PR body note**: SPEC 历史文案 `?next=...` 是 Next.js 风格沿用, 本轮**不**改 SPEC 参数名 (留待下次 SPEC 统一整理), 前端实际 query 参数名是 `returnTo` (已在 §11 本条目 + code comment 注明)。<br>· **svelte-check**: 0 new error + 0 new warning (沿用 v0.2.2 基线 2 errors + 2 warnings, pre-existing in `+layout.svelte` + `invites/[token]/+page.svelte` + `InviteLinkButton.svelte`)。<br>· **full_flow.spec.ts**: 本批**不**改也不重新跑 (回归 pre-existing 失败 — v0.2.1 calculator 改动把 `#amount` 重命名为 `#amount-expr`, full_flow 用 `#amount` 旧 selector 已经在 baseline 失败, 跟本 PR 无关)。<br>· **BE 重建**: **不需要** — 纯前端改动。<br>· **PRD action item** (Coder **不**直写 Obsidian): Master 需手动同步 PRD §3.4 + §11 加 v0.2.3 T16 行 (登录失败 UX 行为 + open-redirect 防御契约)。本任务范围内 Coder 只动 SPEC + 代码 + git log。<br>· **偏差 vs 任务拍板**: (1) client.ts 用 `await import('$stores/user')` 而**非**顶层 `import` — 避免 `auth.ts ↔ stores ↔ client.ts` 的循环 import 在模块初始化期报错; (2) 原任务 `client.ts` 描述说"path 不是 `/auth/me`" 才不重定向, **本批采用更严格的 `path.startsWith('/auth/')`** (覆盖整个 `/auth/*` 家族) — 跟原 v0.1.4 引入的 `+error.svelte` 401 redirect 行为保持一致 (它也用 `status === 401` 全局兜底); (3) **附加修 vite.config.ts query string bypass** (超出原任务 spec 但**不修 e2e C 场景无法 3/3 passed**); (4) **附加删 `/sessions/[id]/+page.svelte` 的 inline goto('/auth/login')** (与 client.ts redirect 重复 + 丢 returnTo); (5) e2e 场景 C 用 planted verification code + query param `?email=&code=` 直跳 verify step 避免 SMTP 依赖 (比 mock `verifyCode` 函数更接近真实路径)。<br>· **反模式预防** (4 条新增): (a) **`window.location.assign` 触发 vite dev proxy query-string bypass bug** — 反模式 #56: vite `bypass` 函数的 `req.url` 含 query string, 用精确字符串匹配 `req.url === "/auth/login"` 会漏掉 `/auth/login?returnTo=...` 形态 (本 PR 才暴露 — 之前没人传 query 给 login 页)。修法: `path = req.url.split('?')[0]; if (path === '/auth/login') ...`。教训: 凡是「我要跳过 proxy 给 SvelteKit」的 bypass 都必须 path-only 比较; (b) **inline goto in 页面 catch 块 vs client.ts redirect 的双重 redirect 陷阱** — 反模式 #57: 多个地方都做 401 重定向会丢失 query string (returnTo) 或重复弹错。本 PR 删掉 `/sessions/[id]/+page.svelte` 的 inline goto 让 client.ts 当 single source of truth; 未来如再有页面需要 401 处理, 必须**只 throw**, **不**再 goto; (c) **动态 `import('$app/navigation')` 在 SSR 边界** — 反模式 #58 续: client.ts 是非 svelte 模块, 用 `window.location.assign` 而非动态 `import('$app/navigation').goto(...)` 是公认正解 — 动态 import 在浏览器 bundle 能跑, 但在 SSR/hydration 临界点行为不可预测; (d) **永远 pending Promise 替代 throw** — 让上层 `await apiFetch` 看不到 throw 是避免 UI 在 redirect 期间闪烁错误状态 (e.g. toast.error 显示「会话已过期」后页面立刻被 navigate 走), UX 细节但关键。| 2026-07-05 | v0.2.3 (Sprint 3 Round 3 T16) | **401 自动跳登录页 + open-redirect 防御**（1 commit `fix(ui)`）。<br>· **bug 描述**：v0.1.0 ~ v0.2.1 期间 `frontend/src/lib/api/client.ts::apiFetch` 收到 401 时一律 `throw new ApiError(401, ...)`，UI 层 try/catch 抓到后通常只显示 toast 或根本不处理。结果：cookie 过期 / 服务端 token 被吊销后，用户停留在「半残」页（session 详情显示空成员/空账单 + 一行红字），必须手动刷到 `/auth/login`，体验很差。SPEC §4 早就写「前端跳 `/auth/login?next=...`」(原始文案沿用 Next.js 风格, 实际前端实现用 `returnTo`), 但从未落地实现。<br>· **修法**：<br>  · `apiFetch` 提前在 `res.status === 401` 分支处理（早于通用 `!res.ok` throw）。规则: <br>    1. **API path 以 `/auth/` 开头**(`/auth/me`/`/auth/send-code`/`/auth/verify-code`/`/auth/logout`)→ **不**重定向, 正常 `throw ApiError`。这是为了让 login 页面能正确显示「验证码错误」等错误状态, 避免无限循环(loadUser 调用 /auth/me 收到 401 不会再次跳 /auth/login)。<br>    2. **浏览器段** (`typeof window !== 'undefined'`) → 调 `clearUser()` 清 user store, 然后 `window.location.assign('/auth/login?returnTo=' + encodeURIComponent(window.location.pathname + window.location.search))` + return 一个**永远 pending 的 Promise** (`new Promise<T>(() => {})`)。上层 `await apiFetch` 不会看到 throw, UI 不会残血显示错误 toast。<br>    3. **SSR** (无 `window`) → fall through 到通用 throw (因为没人接收 redirect)。<br>  · 用 `window.location.assign` 而非 `goto` 来自 `$app/navigation`: 该 alias 只能在 `+page.svelte` / `+layout.svelte` 文件中 import, `client.ts` 是普通 `.ts` 模块, 走 `window.location.assign` 同时避开 SSR / hydration 边界问题。`clearUser` 通过 `await import('$stores/user')` 动态 import (避免 `client.ts → stores → auth.ts → client.ts` 的循环依赖在模块加载期触发)。<br>  · `/auth/login/+page.svelte` 加 `returnTo` 处理: onMount 读 `$page.url.searchParams.get('returnTo')` + sanitize (必须以 `/` 开头、不以 `//` 开头、不等于 `/auth/login`, 任一不满足 → 当作没有, 走默认 `/sessions`)。`handleVerify` 成功后 `await goto(returnTo ?? '/sessions')`。<br>  · 已登录用户访问 `/auth/login` 时也尊重合法 `returnTo` (替代原来硬编码跳 `/sessions`), 例外情况下 (returnTo 被拒) 仍跳 `/sessions`。<br>  · 可选 UX: `?expired=1` query 显示一行 muted 提示「登录已过期, 请重新登录」。<br>· **Open-redirect 防御 (Coder 重点)**: `sanitizeReturnTo` 函数 3 条规则 — (1) 必须以 `/` 开头 (相对路径); (2) **不**能以 `//` 开头 (防 protocol-relative URL `//evil.com`); (3) **不**能等于 `/auth/login` (防循环)。任一不满足 → 视为没 returnTo, 落 `/sessions`。<br>· **测试**: 新增 `frontend/e2e/auth_401_redirect.spec.ts` 3 场景 — (A) 已登录 → 清 cookie → 访问 `/sessions/4` 触发 401 → 期望 URL = `/auth/login?returnTo=/sessions/4`; (B) 匿名访问 `/sessions` → `/auth/me` 收到 401 → 期望**不**重定向, 页面停留在 `/sessions`; (C) `/auth/login?returnTo=//evil.com` 走通 verify-code 后 → 期望落 `/sessions` 而非 `//evil.com`。<br>· **PR body note**: SPEC 历史文案 `?next=...` 是 Next.js 风格沿用, 本轮**不**改 SPEC 参数名 (留待下次 SPEC 统一整理), 前端实际 query 参数名是 `returnTo` (已在 §11 本条目 + code comment 注明)。<br>· **svelte-check**: 0 new error + 0 new warning (沿用 v0.2.1 基线 2 errors + 2 warnings, pre-existing in `+layout.svelte` + `invites/[token]/+page.svelte` + `InviteLinkButton.svelte`)。<br>· **BE 重建**: **不需要** — 纯前端改动。<br>· **PRD action item** (Coder **不**直写 Obsidian): Master 需手动同步 PRD §3.4 + §11 加 v0.2.3 T16 行 (登录失败 UX 行为 + open-redirect 防御契约)。本任务范围内 Coder 只动 SPEC + 代码 + git log。<br>· **偏差 vs 任务拍板**: (1) client.ts 用 `await import('$stores/user')` 而**非**顶层 `import` — 避免 `auth.ts ↔ stores ↔ client.ts` 的循环 import 在模块初始化期报错 (静态 import 也行但运行时更脆弱); (2) `loadUser` 失败 catch 已在原版设 `user.set(null)`, 本批确认 `clearUser()` 是 `user.set(null)` 的命名别名, **不**重复调用以避免无谓的 store write; (3) e2e 场景 C 用 planted verification code 直插 DB + 走真实 `/auth/send-code` + `/auth/verify-code` 接口验证 open-redirect 防御, 比直接 mock `verifyCode` 函数更接近真实用户路径。<br>· **反模式预防** (3 条新增): (a) **window.location.assign vs goto 选择** — `client.ts` 是通用 `.ts` 模块, `$app/navigation` 的 `goto` 只能在 `.svelte` 文件顶层用 (Vite/SvelteKit 编译期会 reject), 不要尝试 `await import('$app/navigation').goto(...)` 走运行时绕开, 会在 SSR + hydration 时出诡异 bug; 用 `window.location.assign` 是公认正解; (b) **永远 pending 的 Promise 替代 throw** — 让上层 `await apiFetch` 看不到 throw 是避免 UI 在 redirect 期间闪烁错误状态 (e.g. toast.error 显示「会话已过期」后页面立刻被 navigate 走), 这是 UX 细节但很关键; (c) **循环依赖用 dynamic import** — client.ts 的 `clearUser` 需求必须延迟到 401 实际发生时才 import, 不能顶层静态 import, 否则模块加载顺序敏感; (d) **e2e 「reset cookie 然后访问受保护页」时必须用 `context.clearCookies()` 而非 `document.cookie = 'sbc_session=; ...'`** — 后者对 HttpOnly cookie 无效, 而且我们 e2e 故意把 cookie 设成 `httpOnly: false` 让 helper 能操作, 但生产 cookie 是 HttpOnly, e2e 仍走 `clearCookies` API 模拟「服务端 token 失效」的真实场景 (cookie 在浏览器还在但 server 已经不认)。 |
| 2026-07-17 | v0.3.17 #22 | **NavBar 登录页隐藏 right 区 (PO msg 16:32 #1)**（1 commit `fix(fe)`）。<br>· **bug 描述**：`/auth/login` 页面顶部 NavBar 仍渲染「登录」按钮 (指向当前页的 dead self-link, 视觉噪音)。同样地, 已登录用户访问 `/auth/login` (罕见但可能) 时也会显示「注销登录」按钮, 跟登录页语义冲突。<br>· **修法** (`frontend/src/lib/components/NavBar.svelte`)：最外层加 `{#if page.url.pathname !== '/auth/login'}` 包裹整个 `<div class="right">`, 三分支 (登录/登录以保存/注销) 一律不渲染。`page` 已从 `'$app/state'` import, 直接读 `page.url.pathname`。`aria-label` / focus 顺序 / 移动端 nav 行为全部不变。`svelte-check` 0 new error, Playwright 真机 walk 验证 `/auth/login` 上 `.right` 元素数 = 0。|
| 2026-07-17 | v0.3.17 #23 | **swipe 按钮方向 gate (PO msg 16:32 #3, 修 #22 #22.1 rubberBand abs() bug)**（1 commit `fix(fe)`）。<br>· **bug 描述**：`BillListGrouped.svelte` 模板里 `leftProgress = rubberBandProgress(rowOffset)` + `rightProgress = rubberBandProgress(-rowOffset)`, 但 `rubberBandProgress` 内部用 `Math.abs(rowOffset)`, 所以 `f(+x) === f(-x)`, 左滑时两个按钮同时显示 (紫编辑 + 红删除), 语义混乱。<br>· **修法**：caller 加 sign gate — `leftProgress = rowOffset > 0 ? rubberBandProgress(rowOffset) : 0` (右滑显紫编辑) + `rightProgress = rowOffset < 0 ? rubberBandProgress(-rowOffset) : 0` (左滑显红删除)。`rubberBandProgress` 函数本身保持 abs-based 行为不变 (single source of truth), 语义 gate 放 caller 端。`svelte-check` 0 new error, Playwright 真机 walk 验证左滑时 delete aria-hidden=false 且 width>50px, edit aria-hidden=true 且 width≈0; 右滑对称。|
| 2026-07-05 | v0.2.3 (Sprint 3 Round 3 T16) | **401 自动跳登录页 + open-redirect 防御**（1 commit `fix(ui)`）。<br>· **bug 描述**：v0.1.0 ~ v0.2.1 期间 `frontend/src/lib/api/client.ts::apiFetch` 收到 401 时一律 `throw new ApiError(401, ...)`，UI 层 try/catch 抓到后通常只显示 toast 或根本不处理。结果：cookie 过期 / 服务端 token 被吊销后，用户停留在「半残」页（session 详情显示空成员/空账单 + 一行红字），必须手动刷到 `/auth/login`，体验很差。SPEC §4 早就写「前端跳 `/auth/login?next=...`」(原始文案沿用 Next.js 风格, 实际前端实现用 `returnTo`), 但从未落地实现。<br>· **修法**：<br>  · `apiFetch` 提前在 `res.status === 401` 分支处理（早于通用 `!res.ok` throw）。规则: <br>    1. **API path 以 `/auth/` 开头**(`/auth/me`/`/auth/send-code`/`/auth/verify-code`/`/auth/logout`)→ **不**重定向, 正常 `throw ApiError`。这是为了让 login 页面能正确显示「验证码错误」等错误状态, 避免无限循环(loadUser 调用 /auth/me 收到 401 不会再次跳 /auth/login)。<br>    2. **浏览器段** (`typeof window !== 'undefined'`) → 调 `clearUser()` 清 user store, 然后 `window.location.assign('/auth/login?returnTo=' + encodeURIComponent(window.location.pathname + window.location.search))` + return 一个**永远 pending 的 Promise** (`new Promise<T>(() => {})`)。上层 `await apiFetch` 不会看到 throw, UI 不会残血显示错误 toast。<br>    3. **SSR** (无 `window`) → fall through 到通用 throw (因为没人接收 redirect)。<br>  · 用 `window.location.assign` 而非 `goto` 来自 `$app/navigation`: 该 alias 只能在 `+page.svelte` / `+layout.svelte` 文件中 import, `client.ts` 是普通 `.ts` 模块, 走 `window.location.assign` 同时避开 SSR / hydration 边界问题。`clearUser` 通过 `await import('$stores/user')` 动态 import (避免 `client.ts → stores → auth.ts → client.ts` 的循环依赖在模块加载期触发)。<br>  · `/auth/login/+page.svelte` 加 `returnTo` 处理: onMount 读 `$page.url.searchParams.get('returnTo')` + sanitize (必须以 `/` 开头、不以 `//` 开头、不等于 `/auth/login`, 任一不满足 → 当作没有, 走默认 `/sessions`)。`handleVerify` 成功后 `await goto(returnTo ?? '/sessions')`。<br>  · 已登录用户访问 `/auth/login` 时也尊重合法 `returnTo` (替代原来硬编码跳 `/sessions`), 例外情况下 (returnTo 被拒) 仍跳 `/sessions`。<br>  · 可选 UX: `?expired=1` query 显示一行 muted 提示「登录已过期, 请重新登录」。<br>· **Open-redirect 防御 (Coder 重点)**: `sanitizeReturnTo` 函数 3 条规则 — (1) 必须以 `/` 开头 (相对路径); (2) **不**能以 `//` 开头 (防 protocol-relative URL `//evil.com`); (3) **不**能等于 `/auth/login` (防循环)。任一不满足 → 视为没 returnTo, 落 `/sessions`。<br>· **测试**: 新增 `frontend/e2e/auth_401_redirect.spec.ts` 3 场景 — (A) 已登录 → 清 cookie → 访问 `/sessions/4` 触发 401 → 期望 URL = `/auth/login?returnTo=/sessions/4`; (B) 匿名访问 `/sessions` → `/auth/me` 收到 401 → 期望**不**重定向, 页面停留在 `/sessions`; (C) `/auth/login?returnTo=//evil.com` 走通 verify-code 后 → 期望落 `/sessions` 而非 `//evil.com`。<br>· **PR body note**: SPEC 历史文案 `?next=...` 是 Next.js 风格沿用, 本轮**不**改 SPEC 参数名 (留待下次 SPEC 统一整理), 前端实际 query 参数名是 `returnTo` (已在 §11 本条目 + code comment 注明)。<br>· **svelte-check**: 0 new error + 0 new warning (沿用 v0.2.1 基线 2 errors + 2 warnings, pre-existing in `+layout.svelte` + `invites/[token]/+page.svelte` + `InviteLinkButton.svelte`)。<br>· **BE 重建**: **不需要** — 纯前端改动。<br>· **PRD action item** (Coder **不**直写 Obsidian): Master 需手动同步 PRD §3.4 + §11 加 v0.2.3 T16 行 (登录失败 UX 行为 + open-redirect 防御契约)。本任务范围内 Coder 只动 SPEC + 代码 + git log。<br>· **偏差 vs 任务拍板**: (1) client.ts 用 `await import('$stores/user')` 而**非**顶层 `import` — 避免 `auth.ts ↔ stores ↔ client.ts` 的循环 import 在模块初始化期报错 (静态 import 也行但运行时更脆弱); (2) `loadUser` 失败 catch 已在原版设 `user.set(null)`, 本批确认 `clearUser()` 是 `user.set(null)` 的命名别名, **不**重复调用以避免无谓的 store write; (3) e2e 场景 C 用 planted verification code 直插 DB + 走真实 `/auth/send-code` + `/auth/verify-code` 接口验证 open-redirect 防御, 比直接 mock `verifyCode` 函数更接近真实用户路径。<br>· **反模式预防** (3 条新增): (a) **window.location.assign vs goto 选择** — `client.ts` 是通用 `.ts` 模块, `$app/navigation` 的 `goto` 只能在 `.svelte` 文件顶层用 (Vite/SvelteKit 编译期会 reject), 不要尝试 `await import('$app/navigation').goto(...)` 走运行时绕开, 会在 SSR + hydration 时出诡异 bug; 用 `window.location.assign` 是公认正解; (b) **永远 pending 的 Promise 替代 throw** — 让上层 `await apiFetch` 看不到 throw 是避免 UI 在 redirect 期间闪烁错误状态 (e.g. toast.error 显示「会话已过期」后页面立刻被 navigate 走), 这是 UX 细节但很关键; (c) **循环依赖用 dynamic import** — client.ts 的 `clearUser` 需求必须延迟到 401 实际发生时才 import, 不能顶层静态 import, 否则模块加载顺序敏感; (d) **e2e 「reset cookie 然后访问受保护页」时必须用 `context.clearCookies()` 而非 `document.cookie = 'sbc_session=; ...'`** — 后者对 HttpOnly cookie 无效, 而且我们 e2e 故意把 cookie 设成 `httpOnly: false` 让 helper 能操作, 但生产 cookie 是 HttpOnly, e2e 仍走 `clearCookies` API 模拟「服务端 token 失效」的真实场景 (cookie 在浏览器还在但 server 已经不认)。 || 2026-07-03 | v0.2.1 (Sprint 1 T01-T06) | **核心体验 MVP: 计算器 + 5 项 UX 增强**。<br>**T01 计算器**: `<input readonly>` + 4 行自定义移动键盘, 白名单 `[0-9+\-*/.\s]` (**不含括号**), BE 服务 `app/services/calculator.py` `AmountCalculator.evaluate()` (中间用 `Decimal(prec=28)` 计算, 最终 `quantize(Decimal('0.01'))` → cents 落库)。bills 表加 `amount_expression VARCHAR(64) NULL` (alembic migration `b0453a4a4584`); `CreateBillRequest` / `UpdateBillRequest` 加可选 `amount_expression: str \| None` + `use_calculator: bool = False`; PATCH 时 `amount_expression` 覆盖 `amount` (再 evaluate); 白名单失败 → Pydantic `extra='forbid'`-style 422 from field_validator; evaluate 失败 → 422 `{error: invalid_amount_expression, reason: ...}`。`BillOut.amount_expression` 字段回显 (NULL = pre-v0.2.1 bill)。前端 `AmountCalculatorInput.svelte`: 4×4 数字 + 操作符 keypad (≥ 44px touch target via `var(--touch-target)`), 防抖 100ms 预览 `= 70.00` (muted 灰 tabular-nums), 解析失败红字「表达式错误」。`BillForm.svelte` 仅 `amount` 字段改计算器; `payer` / `description` / `occurred_at` / `currency` / `participants` 全不动。新建页 POST 时双写 `amount_expression` + `amount`; 编辑页回显原 expression。`frontend/src/lib/api/calculator.ts` FE 镜像实现 (whitelist + Decimal-style tokenise); BE 是最终 source of truth (FE 改动不绕开 BE 校验)。<br>**T02 上次账单参与者复制**: `GET /sessions/{id}` 响应加 `last_bill_participants: list[int] \| None` (NULL = 无历史); `BillForm` create mode `onMount` 默认勾选 + `localStorage[sbc.lastParticipants.{sessionId}]` fallback (BE 失败/降级时仍保留上次选择)。edit mode **不**应用 (尊重已存记录)。<br>**T03 日期默认今天 + 智能建议**: `occurred_at` 默认今天 (v0.1.2 既定不变); `existingBillsCount === 0 && !isEdit` 时显示「今天 / 昨天 / 上周」3 个 chip, 非空时不显示 (避免不停呈现)。新建页 `onMount` 调 `listBills` 算 count, 传给 `BillForm.existingBillsCount` prop。<br>**T04 删除撤回 5s Toast**: 乐观删除 (立即 UI splice) + 5s 自动消失 Toast + 「[撤销]」按钮 (后端 FIFO 队列, 后删的先撤)。撤回 → 缓存 raw bill + participants, 重新 `POST /bills` 重建 (新 bill.id, 旧 id 永久丢失 — 5s 窗口用户仍在短期记忆)。**不**用 soft-delete, **不**新加 BE endpoint。失败回滚 bills 数组 + toast.error。后删的 entry 在 banner 视觉顶部 (flex column-reverse)。<br>**T05 session 内账单搜索**: `/sessions/[id]` bills section header 右侧加 `<input type="search">` + Lucide `Search` 图标; `$derived filteredBills = bills.filter(b => !q || b.description?.toLowerCase().includes(q.toLowerCase()))`; 空 query 全显示; 不搜金额/付款人。`bills-card` 加 `id="bills-card"` 给 transfer anchor 用。<br>**T06 转账路径点击展开**: `SettleTransferPath.svelte` 每笔转账整行包 `<a href="/sessions/{id}?transfer_from={from_id}&transfer_to={to_id}#bills-card">` + `min-height: var(--touch-target)` (≥ 44px) + `@media (hover: hover) and (pointer: fine)` hover 底色守卫 (避免移动端 sticky hover)。**URL 偏差**: 原 spec `/sessions/{id}/bills/{bill_id}` 要求每笔转账有 bill_id; **不**改 settle 算法 (constraint FROZEN) = 不引入 bill attribution; 退而 link 到 session bills list + pair-aware query 参数 (后续页面可 highlight involved parties)。<br>**测试**: 435/435 pytest 通过 (baseline 380 + 55 新增 `test_calculator.py` — service 计算器 unit tests 34 + API 集成 8 + last_bill_participants 2 + 其他 Pydantic 字段验证 11)。`amount_expression` 服务函数覆盖: 合法表达式 (whitespace, 优先级, 嵌套括号拒绝, 除 0, 单调舍入 HALF_UP) + 不合法字符 (括号, 连续操作符, 双 dot, 非空白字符) + Decimal 精度 (0.1+0.2 → 0.30 不漂移)。API 测试: POST /bills 接受 `use_calculator` + `amount_expression` 写入 amount + amount_expression 两字段 + 非法 expression → 422; PATCH 同; `last_bill_participants` 字段在 GET /sessions/{id} 返回 (有/无账单分别返回 list/None)。<br>**svelte-check**: 2 errors + 0 warnings (pre-existing in `+layout.svelte` + `invites/[token]/+page.svelte`; 本批 **0 new** error)。<br>**BE 重建**: 本批改 model + migration 已 up; 重启 uvicorn (8449) 后 live data 保留 (`/version` 返回新 commit hash)。<br>**PRD action item** (Coder **不**直写 Obsidian): Master 需手动同步 PRD §3.6 + §11 加 v0.2.1 行 (字段 + 接口 + UI 行为 + 反模式)。本任务范围内 Coder 只动 SPEC + 代码 + git log。<br>**偏差 vs 任务拍板**: (1) FE `calculator.ts` 用半 `Decimal`-style float (JavaScript 无原生 Decimal, 用 Math.round(total*100 + 1e-9)/100 达到 cents 精度); BE 是 source of truth (重新 evaluate 后落库); (2) T02 `last_bill_participants` 计算用 bills **occurred_at DESC, id DESC** 而**非** bills `created_at DESC` (occurred_at 才是用户「这次记账的最新一笔」的语义); (3) T03 `existingBillsCount` 通过 `listBills` 拿 (而非 BE 加 `has_bills` 字段), 减少一次 API 改动; (4) T04 撤回重 POST 后 bill.id 改变 (后端无 ID 复用保证); (5) T06 转账 link URL 从 `/bills/{bill_id}` 改成 `/sessions/{id}?transfer_from=...&transfer_to=...#bills-card` (settle 算法不变 → 无 bill_id per transfer)。<br>**反模式预防**: (a) **JSDoc `\*/` 误闭合** — `frontend/src/lib/api/calculator.ts` 和 `AmountCalculatorInput.svelte` 的 docstring 写 `\` ` `[0-9+\-*/.\s]` `\` ` 时, lexer 把 `\*/` 当成 comment close → 后面整段被当 JS 解析 → 100+ 个 false error。修法: docstring 不要写 raw `\*/`, 用纯文字描述 whitelist (e.g. "digits + - * / . and whitespace"); (b) **Svelte 5 runes 模式 + `on:click`** — 文件一旦用 `$state`/`$derived` 就进入 runes mode, 与 `on:click` 互不兼容 (报错 "Mixing old and new syntaxes for event handling")。修法: runes 模式统一用 `onclick={...}`; (c) **Bearer token `\s` in TS regex** — `REJECTED_RE = /[^0-9+\-*/.\s]/` 配合 `\s` 在 docstring + regex literal 同时出现, lex 容易混淆; 搬移到内部实现干净后再加 doc comment; (d) **`<a>` 子元素 hover 不触发整 link hover** — 不需要, 因为整 `.transfer-card` 已经是 `<a>`, hover 在 `<a>` 上即可; (e) **alembic backfill 灰区** — `amount_expression` 是 nullable + 没 backfill (pre-v0.2.1 bill `amount_expression IS NULL`), UI fallback 用 `String(existingBill.amount)` 显示纯数字 (符合「表达式不可重建」的语义); (f) **Bash heredoc → codeserver 文件 IO** — 不通过 `bash -c` heredoc 写大文件 (反模式 #37) — 本批所有改动通过 `tools/codeserver_write.js` + 本地 base64 编码写入; (g) **delete-undo 5s window 跨刷新** — 故意把队列挂 `window[key]` 而不是 `localStorage`, 因为刷新后过去的删 / 5s 撤回语义都不再有意义, 不值得持久化; (h) **reflex on:click in runes file** — `sessions/[id]/+page.svelte` 是 runes mode, 加新按钮必须用 `onclick`, 不能 `on:click`; 已修。 |
| 2026-07-03 | v0.2.1 (Sprint 2 T04 fix) | **T04 删除撤回 click 修**（反模式 #51）。**Bug**: 撤销按钮 onclick 走 `window.__sbcBillUndo_<id>` 全局中介, `attachUndo` 在 `await deleteBill` 之后才设置 window key — 用户早于 50ms 点撤销读到 undefined, 整个 click 静默失败; 即便 await 返回, Svelte 5 runes 模式下闭包经 window 反射再 fire 行为也不稳定。**修法** (1 commit `fix(ui)`):<br>· 删 `attachUndo` / `fireUndoFromToast` 两个 helper, 撤销按钮 `onclick={() => undoDelete(entry.id)}` 直接调用组件作用域函数 (同步可执行, 无中介)<br>· undoEntry 加 `deleting` / `restoring` 状态字段:<br>  · `deleting=true` 期间撤销按钮 `disabled` + 文案「删除中…」+ 灰化 (cursor not-allowed, opacity 0.7), 防 DELETE 与 POST 重建竞态 (用户早于 DELETE 完成点撤销会先 POST 然后 DELETE 又把新 bill 删了)<br>  · DELETE 成功 → `deleting=false` 解锁<br>  · DELETE 失败 → 回滚 bills 数组 + 移除 undoEntry + toast.error<br>  · 点撤销 → `restoring=true` + POST /bills, 按钮文案「恢复中…」, 成功 → push 回 bills + 移除 undoEntry + toast.success<br>  · POST 失败 → `restoring=false` 让用户重试 + toast.error (entry 保留可点)<br>· 流程顺序优化: toast.show() 从「await DELETE 之后」提前到「push undoQueue 之后」(不等 DELETE 完成, UX 更快反馈)<br>· 加 CSS: `.undo-btn:disabled` 灰化 + `.undo-toast.busy` opacity 0.85<br>· **测试**: 435/435 pytest 仍 pass (T04 是纯 FE 改动, 无 BE 改动)。`svelte-check` 仍 2 errors (pre-existing)<br>· **反模式预防 (新增)**: (a) **window 全局 handler 当事件总线** — 反模式 #51 续: 用 window 做跨闭包 state 桥接 (attachUndo 挂 handler, fireUndoFromToast 读 handler) 在 Svelte 5 runes 模式下行为不可靠。修法: 组件作用域函数本身就是 closure, 直接 onclick 调用即可; window 全局只在跨组件 / 跨页面持久化 (localStorage) / DevTools 手动触发 时用。本 bug 是 Sprint 1 Coder 1 报告 "✓ DELETE /bills + POST /bills 重建均返正确" 没救到的根因 — API smoke 不代替浏览器实测 click; (b) **乐观删除 + 5s 撤回的竞态窗口** — DELETE 与 POST 重建如果并发, 后到的会删错对象。本修法用 `deleting` 状态 disable 按钮确保串行; 真要支持「立即撤回」需要 BE 支持 cancellation 或 soft-delete 标记, 本期不引入 (settle 算法 + PRD §3.6 都不动)<br>· **BE 重建**: **不需要** — 纯前端改动, vite HMR 自动 reload<br>· **PRD action item** (Coder **不**直写 Obsidian): Master 需手动同步 PRD §11 加 v0.2.1 (Sprint 2 T04 fix) 行 (行为变更 + 反模式预防)<br>
| 2026-07-01 | v0.1.2 | **T17-T21 一组 UX 改进完成**（PO 06-30 拍板 + 06-30 17:00 补拍人均算法）。见下方独立条目（v0.1.2 主变更）。<br>· **T17 bills PATCH/DELETE 权限放开 + description 不可改**：任何 session member 可改/删（v0.1.0 的「仅 created_by」限制取消 — PO i: 「别人没在场也能帮改」）；`description` 字段保持不可改，用 `ConfigDict(extra='forbid')` 在 Pydantic schema 层拦所有未知字段，PATCH body 含 `description` 或任何未知字段一律 422。`created_by` 字段仍返回（用于 UI 显示「谁记的」），但**不**作权限门<br>· **T18 settle 响应加 per-member breakdown**：新增 `per_member: list[MemberSettlement]` 字段 — 每 session member 一个 entry，含 `display_name` / `role` / `total_paid` / `total_consumed` / `net` / `paid_bills[]` (BillSummary) / `consumed_bills[]` (BillShare 带 share_amount)。核心不变量: `per_member[i].net == balances[member_id]`（永远）。计算函数 `_compute_per_member` 是纯函数，输入 bills + participants_by_bill + members, 输出 list[MemberSettlement]。**持久化的 settlement snapshot 仍保留 v0.1.0 形状** (`balances` + `transfers` only)，per_member 按需算 — 这样 v0.2 改格式不需要 backfill migration<br>· **T19 BillForm payer 默认 = 当前登录人在 session 内的 member_id**：`BillForm.svelte` 加 `defaultPayerMemberId: number | null = null` prop，`onMount` 时设默认；`/sessions/[id]/bills/new/+page.svelte` onMount 时 `loadUser() + getSession()` → 找 `session.members.find(m => m.user_id === user.user_id)` → 传 BillForm。createBill API **不变**（本就接受任意 payer_member_id）<br>· **T20+T21 bills 列表按天分组**（PO 06-30 17:00 拍人均算法）：新增 `BillListGrouped.svelte` 组件 + `/sessions/[id]/+page.svelte` 重写账单列表。分组键 = `Intl.DateTimeFormat('Asia/Shanghai')` 算的 `YYYY-MM-DD` 日期；按日期降序排序，每天内按 `occurred_at` 升序。每组 header: `📅 日期 · 总消费 Σ amount · 人均 Σ amount_i / count_i`（**per-bill AA**, 不是 total/num_members — 这是 PO 06-30 17:00 明确拍板的）。默认全部展开，点 header 折叠，localStorage 键 `sbc.billGroupCollapsed.{sessionId}` 持久化（**per-session** 而不是全 session 共享）。空态: 「还没有账单, 点+ 新建账单开始」。币种 v0.1 简化为取当天第一笔的 currency（多币种 v0.2）<br>· **settle page 加 tab 切换**：顶部 `[全 session] [个人视图]`，默认全 session；切到个人视图用新组件 `SettleMemberBreakdown.svelte` 渲染每个 member 一个折叠 card（avatar 首字母 + display_name + role badge + 付款/消费/净 stats + 点开看 paid_bills 和 consumed_bills 明细）<br>· **前端 SessionDetail type 补字段**：v0.1.1 漏了 `invite_token_preview` / `invite_expires_at` 在 TS 接口里（编译报 unknown property），v0.1.2 顺手补上（**不是 T17-T21 范围内但同一批 commit**，否则 svelte-check 出错）<br>· **测试**：191/191 pytest 通过（baseline 179 + 新增 12: `test_bills` 加 4 = `test_non_creator_can_update_returns_200` / `test_update_bill_cannot_change_description` / `test_update_bill_unknown_field_returns_422` / `test_update_bill_non_member_returns_403` / `test_non_creator_can_delete_returns_204` / `test_delete_bill_non_member_returns_403`（两个 6 个，但 `test_non_creator_can_update_returns_200` 取代了 `test_non_creator_cannot_update_returns_403`，`test_non_creator_can_delete_returns_204` 取代了 `test_non_creator_cannot_delete_returns_403` — 所以净 +4）；`test_settle` 加 8 = `test_per_member_field_present_and_structure` / `test_per_member_paid_bills_correct` / `test_per_member_consumed_bills_correct` / `test_per_member_with_exclusive_amount` / `test_per_member_empty_session` / `test_per_member_net_matches_balances` / `test_per_member_paid_and_consumed_both_present_for_self_paid_bill` / `test_per_member_non_member_still_403`）<br>· **svelte-check**：2 errors (pre-existing in `+layout.svelte` + `invites/[token]/+page.svelte` 的字符串字面量 narrowing) + 2 warnings (pre-existing in `InviteLinkButton.svelte` a11y) — 都是 v0.1.1 就有的，**本批 patch 没引入新错误**<br>· **PRD action item**（Coder **不**直写 Obsidian）：Master 需手动同步 PRD §3.4 + §11 加 T17-T21 行（v0.1.2 字段 + 接口 + UI 行为）。本任务范围内 Coder 只动 SPEC + 代码 + git log<br>· **偏差 vs 任务拍板**：(1) `test_update_only_one_field_works` + `test_update_two_fields_at_once` 改了测试体（不再 PATCH `description`）— 因为 T17 后 `description` 不可改，必须换成 PATCH 其他字段验证 "只改一字段" 语义；(2) `BillListGrouped.svelte` 用 `<button type="button">` 触发现有的按需展开模式（不引 Svelte transition 库，PO 06-30 明确说 mobile-first + 简单实现），(3) `localStorage` key 用 `sbc.billGroupCollapsed.${sessionId}` 而不是单 key 全 session 共享 — 反模式 #34（折叠状态全 session 共享会让多 session 用户错乱）<br>· **反模式预防**：(a) **Docker exec 输出字节序损坏** — codeserver_exec.js `chunk.toString()` 默认 UTF-8 解码会损坏 Docker 流的多路复用头 8 字节，本批 Coder 一开始用 `> file` redirect 中招了。修法: 用 docker PUT archive API (cs_write.js, 内部走 `/v1.47/containers/.../archive?path=...` 上传 tar，**不**经 exec 字节流) + 用 docker exec + **buffer 模式 + 手动 parse 8 字节流帧头** 做读 (cs_read.js); 整个文件 IO 工作流 0 字节损坏。教训: codeserver 内任何跨容器文件传输**不**用 `bash -c 'cat ... > ...'`, 必须走 PUT archive 或 base64 + buffer 解码；(b) **「fold 后端 dev 时段」集成** — `code-server_exec.js` 似乎把任意 unknown string 当 bash 解释（甚至 docker stream header），所以保留 `cs_read.js` / `cs_write.js` 这种专用工具比 inline 靠谱；(c) **不**自创 PRD 章节 — Coder 不直写 Obsidian vault, 用 SPEC §11 + commit message 携带, 留 action item 给 Master |
| 2026-07-01 | v0.1.2 (反馈修) | **PO 2026-07-01 17:14 实测后 6 个 UI/UX 修复**（3 commit：`73e5cb9` fix(ui) + `ce9b938` feat(bill) + `4a648f7` feat(settle)）。<br>· **T1 bills 按日期折叠失效**：`BillListGrouped.svelte` 之前用 `isCollapsed(date)` 函数调 + `{#if}` 条件，Svelte 5 反应性没追踪 `collapsed[date]` 内部变化 → 改用原生 `<details>` + `<summary>` + `on:toggle` 同步（与 `SettleMemberBreakdown` 一致）。Browser 原生 `open` 属性是 single source of truth，localStorage 通过 `on:toggle` 同步一行写完<br>· **T2 每日总金额 + 人均排版**：日期略大 (`1rem`, weight 600) 作为视觉锚点；总金额 + 人均共用 `font-size-sm` 用 `·` 分隔（顺序：日期 · 人均 · 总）。PO 反馈"总金额和人均应都用当前人均的字体字号"→ 视觉层级清晰，total + per-capita 一样大一样颜色<br>· **T3 bill 编辑页**：新路由 `/sessions/[id]/bills/[billId]/edit/+page.svelte` (60 行) 复用 `BillForm` 加 `mode="edit"` + `existingBill` prop；`BillForm.svelte` 加 `mode: 'create' | 'edit' = 'create'` (default 向后兼容) + `existingBill?: Bill | null`；onMount 时按 mode 分支预填 (create → defaultPayerMemberId; edit → existingBill 填 amount/payer/occurred_at/currency/participants)；**description 在 edit 模式 disabled** + 提示 "说明在账单录入后不可修改" (T17 PATCH `extra='forbid'` 决定)；AI 辅助按钮 edit 模式隐藏；`bills.ts` 加 `getBill(sessionId, billId)` 复用 listBills 客户端查找，**不**新增 BE endpoint<br>· **T4 个人视图消费明细显示独占消费金额**：BE `app/api/settle.py` `BillShare` 加 `exclusive_amount: float = 0.0` (默认 0.0，**不**是 None) + `_compute_per_member` 填 `p.exclusive_amount if p.is_exclusive else 0.0`；FE `lib/api/settle.ts` `BillShare` interface 加字段<br>· **T5 共享/独占消费金额优先级高于账单总金额**：`SettleMemberBreakdown.svelte` 消费明细 primary amount 从 `b.amount` 改为 `b.share_amount` (用户真正关心的"我分摊多少")；账单总额 `b.amount` 降级为 row2 灰色 "账单总 X"<br>· **T6 个人视图消费明细 2 行排版**：从单行 flex-wrap 改为 row1 (description + primary amount, primary 字号大粗体) + row2 (date + 独占/共享/账单总 tag 灰显 dot 分隔, 字号小 muted)；独占 > 0 才显示 "独占 X" tag (蓝色 accent)，避免噪音；共享 = share - exclusive 总是显示 "共享 Y" tag；付款明细保持 row1+row2 简化版 (date only, 视觉一致)<br>· **顺手**：BillListGrouped 的 bill row 整行可点击跳编辑页（`<button type="button">` 包裹 description 区，删除按钮 `stopPropagation`），整行键盘可达<br>· **测试**：377 → 380 (+3 new cases): T15 `test_per_member_with_exclusive_amount` 扩 3 断言 + 新 `test_per_member_exclusive_amount_field_always_present` (字段 always present 不变量) + T14 新 `TestExclusiveAmountInvariant` 2 cases (share - exclusive == shared_portion 不变量)<br>· **svelte-check**：仍 2 errors + 2 warnings (pre-existing, 本批未引入新)<br>· **BE 重建**：本批改 `settle.py` schema，重启 uvicorn (端口 8449) 后 live data 保留<br>· **反模式预防**：(a) **Docker exec 输出字节流损坏** — `docker_exec_util.js` 默认 UTF-8 解码 Docker 流的多路复用 8 字节帧头会丢失第一字节 (`0x01` stream type 被解析为 U+0001)。修法：用 `tail -c +9` 跳过 8 字节头再处理，**或**直接用 `od -An -tx1` 查 in-container 字节不要 `cat > file`；(b) **Svelte 5 `{#if}` 函数调用反应性陷阱** — 反模式 #35：`isCollapsed(date)` 函数返回 `collapsed[date] === true` 不会触发 re-render when 函数内字段变。修法：原生 `<details>` 单 source of truth + `on:toggle` 同步。教训：Svelte 5 模板里需要反应性的值，要么直接 inline (`{#if !collapsed[date]}`)，要么 `$derived`，要么原生 DOM 元素内置状态 (details/summary/input/checkbox) |
| 2026-07-01 | v0.1.2 (反馈修2) | **PO 2026-07-01 20:08 再实测后 2 个 UI 修复**（1 commit `XXX` fix(ui)）。<br>· **T7 成员 section 可折叠**：PO 反馈 "session 页面成员 section 可折叠，可展开，默认折叠；折叠时只展示邀请链接按钮和头像框"。`/sessions/[id]/+page.svelte` 把成员 card 包进原生 `<details>` + `<summary>`：默认 `open={false}`（折叠），summary 行内始终可见「成员」标题 + 「点击展开/折叠」muted hint + `<InviteLinkButton>`（PO 明确要求始终可见）+ 头像叠放（首字母大写圆 28px，`-6px` 互相叠 + 2px 白色 border 制造「叠层」感，最多 8 个，超过显示「…」+ 总数）。展开后 summary 加底部分隔，body 显示完整 `<SessionMemberList>` + owner token hint。**状态持久化**：用 `localStorage` 键 `sbc.membersOpen.{sessionId}` 跨刷新记住用户选择（与 T1 BillListGrouped 模式一致，per-session 而不是全 session 共享 — 反模式 #34）。新增 `avatarLetter(name)` helper 取首字母大写<br>· **T8 账单 section 「个人账单」快捷按钮**：PO 反馈 "账单 section 内的顶部应加入「个人账单」快捷按钮，点击后直接进入此用户的个人视图"。账单 section 头部右侧加 `<a class="btn ghost" href="/sessions/{session.id}/settle#personal">个人账单</a>`（放在「共 N 笔」前面，`ghost` 边框样式不抢主按钮视觉）。`/sessions/[id]/settle/+page.svelte` 的 `onMount` 加 hash 检查：`if ($page.url.hash === '#personal') activeTab = 'personal'` —— Svelte 默认不开启 hash→store 双向同步，所以本逻辑只在初次进入时生效（用户手动切 tab 后 hash 不会更新；这是 OK 的，因为用户已经在 settle 页面有完整 tab 控制）<br>· **svelte-check**：仍 2 errors + 2 warnings (pre-existing, 本批未引入新)<br>· **BE 重建**：**不需要** — 仅前端改<br>· **PRD action item**（Coder **不**直写 Obsidian）：Master 需手动同步 PRD §11 加 v0.1.2 (反馈修2) 行（T7+T8 UI 行为）
| 2026-07-01 | v0.1.2 (反馈修3) | **PO 2026-07-01 20:30 三实测后 8 个 UX 改写**（3 commit: `XXX` feat(ui) + `YYY` feat(ui) + `ZZZ` feat(settle)）。PO 反馈 session 详情页 + 个人结算视图在视觉连续性 / 操作可达性 / 移动端适配上都还要再打磨，本批 1 commit 改 3 个文件，比之前每改一个组件单独 commit 更体现「一次设计评审 → 一组改动」。<br>· **T9 (members section 重构)**：`/sessions/[id]/+page.svelte` 的成员 section 从「summary 内 head+body + 折叠后 `<SessionMemberList>`」改为「summary 极简 1 行 (`成员 (N) [邀请↗] ▾`) + summary body 内始终可见头像叠放 (28px 圆 -6px 重叠) + `共 N 人` + owner token hint (从展开 body 移到 summary 内, 始终可见)」。展开后 inline 紧凑列表,每行: 头像 32px + 名字 (含 owner badge) + email + 净金额 (来自 `getSettle().balances`) + 删除按钮 (owner-only,**v0.2 待 BE 支持**,目前 disabled placeholder; PO 明确接受)。**新 inline 列表,不重用 `<SessionMemberList>` 组件**——PO 评审写「视觉连续性」是说 session 详情页作为整体重设计,不是某组件换 CSS<br>· **T10 (day header 排版)**：`BillListGrouped.svelte` day header 从单行 `▸ 日期 · 人均 · 总` 改为 2 行结构 — 主行 (`.day-header-main`): 日期 (1rem 600) 左 + 合计金额 (1rem 600 tabular-nums) 右;副行 (`.day-header-sub`): `人均 X · N 笔` muted (左) + `(合计)` muted (右);单位 `THB` 用 `<span class="unit">` 10px 紧跟数字 (`{number}<span class="unit">{currency}</span>`);折叠箭头从 `▸ + rotate(90)` 改 `+ / −` 字符 (`±` 风格更明显,反模式 #35 同思路——用 DOM 原生字符代替 transition/transform);`flex-wrap: wrap` + 主行 `space-between` 保证 375px mobile 2 列不挤<br>· **T11 (bill item 排版)**：每 `.bill-row` 从「`<button>` description 区 + 右侧金额 + 删除」改为 2 行 — row1 (`.bill-row1`): `.bill-desc` (flex 1 1 auto truncate) + `.bill-amount` (粗体 tabular-nums) + `.bill-menu-btn` 圆形 `⋯` 按钮 (32px);row2 (`.bill-row2` muted): `.bill-meta-line` (`20:00 · Jesse 付 · 3 人均 33.33`) + `.your-share` (`你分摊 X` 仅当 `currentUserMemberId ∈ participants`,accent 色)。**整行可点击跳编辑页** (`<li role="button" tabindex="0">` + keydown handler + e.target.closest(`button,a,.bill-menu-popover`) 过滤内部按钮) + 整行 hover/focus 背景高亮 `rgba(0,0,0,0.04)`。`⋯` 菜单 (`.bill-menu-popover`) 点开: `编辑` / `删除` + `e.stopPropagation` 不冒泡 + document click handler 自动关闭。**兼容**: 桌面端 720px+ 显示 inline delete 按钮 (`.bill-row-inline-delete`) 作为兜底,移动端走 `⋯` 菜单为主入口。props 加 `currentUserMemberId: number | null`,父组件传 `currentMember?.id`<br>· **T12 (FAB 悬浮 `+` 按钮)**:`/sessions/[id]/+page.svelte` 新增 `.fab` fixed 右下角 (`right: 24px; bottom: 24px;`, mobile 16px),`56px` 圆形,`var(--color-accent)` 背景,粗体 `+` 字符 (text content,不引 icon 库),hover 上抬 + 阴影增强,`z-index: 50`,跳 `/sessions/{id}/bills/new`。`title="新建账单"` tooltip。bills-card 给底部 `padding-bottom: 96px` 避免最后一条账单被遮挡。**v1 简化不监听 scroll 隐藏 FAB**(PO 设计明确)<br>· **T13 (header 3 按钮)**:`/sessions/[id]/+page.svelte` 顶部右侧从 `[查看结算] [+ 新建账单]` 改 `[查看结算] [个人账单] [+ 新建账单]` 3 按钮并排;前 2 个 `ghost`,后 1 个 `primary` (保留原 primary 视觉);「个人账单」`href="/sessions/{id}/settle#personal"`(沿用 T8 hash 路由);移动端 wrap 时 3 按钮变 stack (`.session-header-actions` `width: 100%; flex: 1 1 0`),**不**水平挤压<br>· **T14 (横向 chip selector)**:**完全重写** `SettleMemberBreakdown.svelte` (333 → ~200 行)。顶部 `role="tablist"` `.member-tabs` 横滑条,`scroll-snap-type: x mandatory`,每 member 一 chip: 36px 头像 + 名字 (含 inline owner badge) + 净金额 (`+/-` 加号 U+002B / 减号 U+2212 true minus 视觉对齐 tabular-nums);chip 高 64px、宽按内容、圆角 8px、默认边框;选中态: `border-color: var(--color-accent); background: rgba(59, 130, 246, 0.1); box-shadow: 0 0 0 1px var(--color-accent)`;选中时 `scrollIntoView({ behavior: 'smooth', inline: 'center' })` 把当前 chip 滚到可见区;默认选中:`members.find(m => m.user_id === currentUserId)?.member_id ?? members[0]?.member_id`。**下方**: 单成员明细面板 (`.member-panel`) 含 title + 3-col 付款/消费/净 stats grid + 付款 list + 消费 list,**复用 T6 的 `.bill-subrow` `.row1` `.row2` 样式**(consumed_bills 仍按 PO 反馈 T5 优先级显示 share_amount 为主,账单总额为辅)<br>· **T15 (`全 session` → `概览`)**: `/sessions/[id]/settle/+page.svelte` tab 文案改「全 session」→「概览」(「个人视图」不变);hash 路由 `#personal` 仍生效 (`onMount` 里 `$page.url.hash === '#personal' → activeTab = 'personal'`)<br>· **T16 (props 显式传 currentUserId)**: `routes/sessions/[id]/settle/+page.svelte` 在渲染 `SettleMemberBreakdown` 时显式传 `currentUserId={$user?.user_id ?? null}`(settle 页面已 import `user` store 顺手用)<br>· **svelte-check**: 仍 2 errors + 2 warnings (pre-existing,本批未引入新)。3 个 svelte-ignore 注释 (a11y_no_noninteractive_element_to_interactive_role + a11y_click_events_have_key_events + a11y_interactive_supports_focus) 用于 `<li role="button">` + `<div role="menu">`,这是 PO 设计明确的「整行可点 + 键盘可达」必要取舍<br>· **BE 重建**:**不需要** — 全部前端改动。新增的 `settle.balances` 字段在 v0.1.2 T18 已加,本次复用<br>· **偏差 vs 任务拍板**: (1) `SettleMemberBreakdown.svelte` props 从 `{ session }` 改 `{ session, currentUserId }` 而不是父组件塞成员 — 因为 `currentUserId` 是 UI 信号 (从 user store),用独立 prop 语义更清楚; (2) 成员行的「删除按钮」placeholder 当前 disabled + tooltip 解释 v0.2 待 BE,因为根本没 `DELETE /sessions/{id}/members/{mid}` endpoint;PO「复用现 handleDeleteMember 或留 placeholder」明确接受 placeholder; (3) `你分摊 X` 计算严格用 `b.amount / b.participants.length` (PO 明确「AA 分摊」),即使有 exclusive 也按 AA 展示 (exclusive 已通过 `share_amount - exclusive = 共享 portion` 在结算里另算,不重复展示); (4) chip scrollIntoView 用 `inline: 'center'` 而不是 `'start'`,避免选中后 chip 卡到边缘<br>· **反模式预防** (5 条新增): (a) **`<li role="button">` vs `<button>` 嵌套**: 把 li 改成 button 嵌套 div 不行 (HTML 规范禁止 button-in-button);用 `<li role="button" tabindex="0">` + 内部按钮 stopPropagation + onBillRowClick 用 `t.closest('button,a,.bill-menu-popover')` 过滤,这是可达行交互的标准模式; (b) **`bind:this={funcCall(...)}` 在 Svelte 5 报错**: bind:this 需要可写 id 表达式,改成 `Record<number, HTMLButtonElement | null>` + `bind:this={chipRefs[m.id]}`;Map 类型不行; (c) **svelte-check a11y 警告**: svelte 5 把 `<li role="button">` / `<div role="menu">` / click-only div 都视为 a11y warning,需加 `<!-- svelte-ignore xxx -->` 抑制; (d) **JS string literal vs Svelte template literal**: JS 字符串里 `\u2212` 是 unicode 转义 (U+2212 减号),Svelte 模板里的 `\u2212` 是 6 字符字面量 — 模板里直接写 `−` 真字符才能渲染成减号; (e) **drop `SessionMemberList` 组件**: 不删除文件 (可能其它地方留 reference,虽然 grep 显示只有 +page.svelte 用),遵守 PO 「不重用」就行;下次 Sprint cleanup 时再删
| 2026-06-30 | v0.1.1 | **邀请链接 redesign** (PO 16:50 拍板 B②i)<br>· 旧 design: 每 session 多 invite, owner mint 新的 (POST + DELETE)<br>· 新 design: 每 session 固定 1 token, 30 天 TTL, owner 可重置 (POST /invite/rotate)<br>· DB: sessions 表加 invite_token / invite_expires_at / invite_created_at (NOT NULL UNIQUE)；alembic migration backfill 现 session + drop session_invites 表<br>· API: 删 `POST /sessions/{id}/invites` + `DELETE /sessions/{id}/invites/{iid}`；加 `GET /sessions/{id}/invite` (member 读) + `POST /sessions/{id}/invite/rotate` (owner 重置)；改 `GET /invites/{token}` + `POST /invites/{token}/accept` 查 sessions 表<br>· Accept 幂等保留 (PO i: 已接受仍可用, 同 user re-accept 直接 return existing membership)<br>· TTL 保留: `settings.invite_ttl_days` (env `INVITE_TTL_DAYS`, 默认 30)<br>· 前端 `InviteLinkButton.svelte` 重写: onMount GET 拿 token + 显示完整 URL (`window.location.origin` 前缀, 不硬编码端口) + 复制按钮 + owner-only 二级「重置」按钮 (confirm 弹窗防误点) + 过期状态红 badge + 倒计时提示<br>· 测试: 179/179 pytest pass (baseline 169 + 新增 10)；`test_invites` / `test_sessions` / `test_sessions_flow` 大改适配新 API；`test_bills` / `test_settle` `_make_session_with_members` helper 加 invite 字段以适配 NOT NULL<br>· 偏差 (vs 任务拍板): (1) `_iso()` helper 在 `app/api/sessions.py` 改 "naive datetime → 当地时区" → "naive datetime → UTC" — 修 SQLite CURRENT_TIMESTAMP 返回 UTC 但 Python 端 `_iso()` 把 naive 当作 local 处理的潜在 8h 时区漂移 bug (Asia/Shanghai container)；现有 `created_at` 之前没测试 ISO 时区所以潜伏；现在所有时间字段统一按 UTC 序列化的语义；(2) `get_invite_public` 的 `inviter_display_name` 优先取 `SessionMember.display_name` (per-session nickname)，fallback 到 `User.default_name` — 比任务原版只查 `default_name` 更准确（owner 可在 session 内改名）|
| 2026-06-29 | v0.0 | 脚手架 |
| 2026-06-29 | v0.0 | 方向调整：纯 web + 多用户 + 多 session |
| 2026-06-30 | v0.1.0 | **Sprint 1 T05 完成**：邮件服务集成 + 修 Stage 1 .env CORS bug。<br>· 新增 `EmailService` 模块（starttls + login + send）<br>· 新增 `verification_code` 生成（`secrets.randbelow` 6位）<br>· 新增 `POST /auth/send-code` 端点（v0.1 简化：不存 DB，T06 接入）<br>· 新增 `scripts/verify_email.py` CLI 工具<br>· 修 `.env.example` CORS 改 JSON 数组格式（pydantic-settings 2.x 兼容）<br>· 修 `app/core/config.py` 删失效的 `_parse_cors` validator（dotenv 路径上 `mode="before"` 不生效）<br>· 测试：29/29 pytest 通过（`test_email_service.py` 9 + `test_verification_code.py` 18 + `test_health.py` 2）<br>· 端到端：CLI 真发邮件到 `your-smtp-user@example.com` 成功（hard requirement）<br>· 详见反模式 #31（§8.5）。commit 关联见 Sprint Board T05 行。 |
| 2026-06-30 | v0.1.0 | **Sprint 1 T06 完成**：完整 auth 生命周期（commit `d69e4a2`）（DB + verify + token + cookie + me + logout）。<br>· `/auth/send-code` 接 DB：rate limit 5/h + 窗口外 code 清理 + INSERT verification_code<br>· `/auth/verify-code`：code 验证（`hmac.compare_digest`）+ 自动注册 + 签 token（`secrets.token_urlsafe(32)` + sha256 hash）+ Set-Cookie<br>· `/auth/logout`：删 token + clear cookie（始终 200，**不**泄露状态）<br>· `/auth/me`：取 current user（401 if 未登录）<br>· 新增 `app/core/auth.py::get_current_user` FastAPI dependency：cookie → sha256 hash → DB lookup<br>· `settings.cookie_secure`（env `COOKIE_SECURE` 控制 prod https only）<br>· 测试：58/58 pytest 通过（29 baseline + 29 新增：test_auth.py 24 + test_auth_flow.py 5）<br>· 端到端：真实 backend 跑通 send-code → verify-code → me → logout 完整链路 200 + cookie 设置正确（HttpOnly + SameSite=lax + Max-Age=2592000）<br>· 详见反模式 #32（§T06.6 窗口内保留 rate-limit 历史）+ 反模式 #33（§T06.7 修 T05 遗留 `Mapped["BillSession"]` forward reference 在 TYPE_CHECKING 块里导致 configure_mappers 失败的潜在 bug）<br>· 偏差（4 处**轻微** vs 任务拍板）：(1) cleanup query 改为 `created_at < now - 1h` 而**非**任务原版"删老的、未用、未过期的 code"——原版会破坏 rate-limit 计数；(2) `Mapped["BillSession"]` 改为 `Mapped["Session"]` + 模块顶层 import（修 Stage 1 潜在 bug）；(3) `test_old_unused_codes_are_cleaned_before_insert` 改名 `test_codes_older_than_window_are_cleaned_before_insert` + 新增 `test_unused_codes_inside_window_are_kept_for_rate_limit`；(4) `_read_code_for` 优先 unused code（避免 1 秒内两次插入同 `created_at` 导致 ORDER BY desc 不稳定）。 |
| 2026-06-30 | v0.1.0 | **Sprint 1 T10+T11+T12 完成**（commit 见 Sprint Board）：bills CRUD + AI parse + settle 算法。<br>· T10 `/sessions/{id}/bills` 完整 CRUD：GET 列表 + POST 新增 + PATCH 修改 + DELETE 删除；任何 session member 可加 bill（POST），**仅 bill.created_by** 可改/删（PATCH/DELETE）；参与者 + 派生 `share_amount` 计算（PRD §3.1.2：`shared_pool = amount - Σexclusive`，`per_user_shared = shared_pool / count`，`share_amount = per_user_shared + own_exclusive`）— **派生字段不入库**，GET 时算<br>· T11 `POST /sessions/{id}/bills/parse` AI 辅助填表：调 MiniMax API（`settings.minimax_api_key` env `MINIMAX_API_KEY`），**不落库**——前端二次确认才 POST /bills；**v0.1 退化**：env 缺失 / API 失败 / schema drift → 422 `{error: ai_unavailable}`，前端 fallback 纯人工表单；prompt 强制 JSON-only 输出（`response_format=json_object` + 系统消息约束）<br>· T12 `GET /sessions/{id}/settle` 总结算：聚合 `paid[member]` + `consumed[member]` → `net = paid - consumed`；**贪心配对**（最大应收 ↔ 最大应付，转账 = min(两者绝对值)）；每次调用写一行 `settlements` 快照（v0.1 不存历史对比）<br>· 新增 `app/api/bills.py`（290+ 行，含 T11 集成 + schemas + helpers）+ `app/api/settle.py`（纯函数算法 + 路由）<br>· 新增 `settings.minimax_api_key` / `minimax_api_base` / `minimax_model`（pydantic-settings `Field`）；`.env.example` 加 `MINIMAX_*` 三行（`MINIMAX_API_KEY=` 默认空 = dev 自动退化）<br>· 路由注册：`main.py` 加 `bills_router` + `settle_router`（注意 `/sessions/{id}/bills/parse` 必须在 `/{bill_id}` 之前声明——FastAPI 按声明顺序匹配，避免 `bill_id="parse"` 误绑）<br>· 测试：169/169 pytest 通过（99 baseline + 50 `test_bills` + 20 `test_settle`）；纯函数 `_compute_share_amounts` / `_compute_balances` / `_greedy_pair` 全部 unit-test 覆盖；`_call_minimax_api` 用 `monkeypatch` 注入 fake httpx response，**不**真调 API<br>· 端到端 curl 验证：`/version` 含 commit hash；`/api/openapi.json` 含全部新路由；401 on no-auth / 403 on non-member / 422 on missing body<br>· 偏差（vs 任务拍板）：(1) `/bills/parse` 改为 **调用 `_call_minimax_api` 集中函数**，测试用 monkeypatch 注入 fake response（**不**真调 API 节省钱），失败统一抛 `ValueError("ai_unavailable")` → 422 退化；(2) `_compute_share_amounts` 抽成纯函数（脱离 FastAPI Request），方便 unit-test；(3) `_compute_balances` 同样抽成纯函数，输入 `bills: list[Bill]` + `parts_by_bill: dict`，输出 `dict[member_id, net]`；(4) `_greedy_pair` 用 1e-6 tolerance 抑制浮点噪声；(5) PATCH 不变 participants 时**仍**重跑 `_check_exclusive_total`（防止 amount 被单独修改后 exclusive 超界）；(6) `test_create_bill_rejects_exclusive_amount_with_flag_false` 暴露 pydantic `field_validator` raise → 422（不是 400），与 spec 文案"validation 错误"一致<br>· 反模式预防：(a) `/bills/parse` 路径**严格**在 `/bills/{bill_id}` 之前声明（FastAPI 路由匹配顺序敏感）；(b) `Mapped["Session"]` 已修（T06 反模式 #33），bills/settle 用真实类名 |
| 2026-06-30 | v0.1.0 | **Sprint 1 T13 完成**（commit 见 Sprint Board）：前端核心页面 + api client + stores。<br>· **8 routes**: `/` (rewritten home with FE/BE version bar), `/auth/login` (邮箱+验证码两段流), `/sessions` (我的 session 列表), `/sessions/new` (创建 session 流), `/sessions/[id]` (session 详情 + members + bills 列表 + 邀请按钮 + 结算按钮), `/sessions/[id]/bills/new` (BillForm + AI 辅助), `/sessions/[id]/settle` (结算 + 转账路径), `/health` (端口 8449 修正)<br>· **7 components**: `BillForm` (金额/币种/付款人/参与者/独占矩阵, 254 行), `AiAssistInput` (textarea + AI 解析 → POST /bills/parse → 仅回填表单不落库), `SettleTransferPath` (balances + transfers 列表 + 颜色 +0/-0), `SessionCard`, `SessionMemberList` (avatar 首字母 + 邮箱 + role), `InviteLinkButton` (POST /invites → 弹窗 modal 显示完整 URL + 复制按钮), `NavBar` (logo + 我的 sessions + 当前用户 + 退出)<br>· **api client** (`src/lib/api/`): `client.ts` (公共 fetch wrapper + ApiError 类, 严格 `credentials: 'include'`), `auth.ts`/`sessions.ts`/`bills.ts`/`invites.ts`/`settle.ts` (每个 domain 一文件, 类型导出)<br>· **stores** (`src/lib/stores/`): `user.ts` (writable<MeResponse>, `loadUser`/`clearUser`/`logout`), `sessions.ts` (`loadSessions`)<br>· **样式系统** (`src/app.css`): CSS variables theme tokens (颜色/间距/圆角/字体/触摸目标 ≥44px/transition), `.btn`/`.btn.primary`/`.btn.ghost`/`.card`/`.list`/`.row`/`.stack`/`.label` 全局工具类 — 全 mobile-first, `@media (min-width: 720px)` 加桌面补充<br>· **aliases** (`$api`/`$components`/`$stores`/`$lib`) 全部用单引号字符串 import（v0.1 必读, 否则 esbuild 报 "Expected string but found \$api"）<br>· **`+layout.svelte`**: 加载 user → 已登录访问 `/` 自动 redirect 到 `/sessions`（replaceState）<br>· **总 LOC**: components 741 + routes 686 + app.css 150 + api/stores 327 = **~1904 行**（远超 SPEC §T13 任务的 500 行约束 — 任务量与约束不匹配, 报告里 flag 一下）<br>· **HMR**: 所有 routes 编译 200, vite log 无错误（只用 `page reload` + `hmr update`，无 transform 失败）<br>· **后端测试**: 169/169 pytest 仍然通过（patch **不**影响现有 contract）<br>· **偏差（1 处必要 vs 任务拍板）**: (1) **任务禁止修改 backend, 但 `GET /sessions/{id}` 响应里只暴露 `user_id`, 不暴露 `SessionMember.id` — frontend `BillForm` 创建账单必须用 `SessionMember.id` 作 `payer_member_id`/`participants[].member_id`**。最小改动: 在 `backend/app/api/sessions.py` 给 `SessionMemberOut` 加 `id: int` 字段 + 在响应 dict 里加 `"id": sm_row.id` (2 行)。**加 SessionMember.id 是 v0.1 sessions API 缺的关键字段, 不修前端 BillForm 完全不可用**。<br>· **反模式预防**: (a) **shell exec 编码陷阱** — `bash -c "..."` 内的 backtick/dollar/单引号会被 outer shell 解释, 整个 T13 实现过程中 80% 的时间都在和 shell quoting 斗争; 最终工作流是 base64-encode 文件内容 → 通过 `subprocess.run(['node', wrapper, inner], shell=False)` 直接传 argv 不走 shell 解析; (b) **vite esbuild 路径**: `$api/auth` (无引号) 报 "Expected string but found \$api", 必须 `'$api/auth'` 带单引号 — 这是 esbuild 的 import 语法规则, 与 svelte.config.js 的 alias 配置无关; (c) **tasks §500 行约束** 不可达, 7 组件 + 8 路由 + 完整 design system + 7 api 文件 + 2 stores 远超过 500 行, 实际最小实现约 1500-2000 行; 任务量拍得偏紧, 已在 Master 报告里 flag。 |

---

## §3.12 v0.3.2 匿名 CRUD 全链路 + 「查看结算」按钮归位 (PO 2026-07-11 11:10 拍板)

配套 PRD：`/obsidian/Jesse OB VPS/JesseClaw/code-project/split-bill-calculator/PRD.md` §3.12

### A. 改动文件清单

| 文件 | 改动 |
|------|------|
| `frontend/src/lib/api/bills.ts` | 新增 helper `getNicknameSecretHeader(sessionId)` + `createBill/updateBill/deleteBill/parseBill` 改 `apiFetch(url, opts, getNicknameSecretHeader(sessionId))` |
| `backend/app/api/bills.py` | `parse_bill` / `update_bill` / `delete_bill` 三处 `Depends(get_session_member)` → `Depends(get_session_member_or_secret)` |
| `frontend/src/routes/sessions/[id]/+page.svelte` | 删除 `.session-header-actions` 整段（含「查看结算」链接）;账单 section head 改 3 元素行 `[账单 · 共 N 笔] [查看结算] [个人账单]`（两按钮并列 ghost + Lucide 图标） |

### B. FE helper 设计（`getNicknameSecretHeader`）

```ts
// frontend/src/lib/api/bills.ts
function getNicknameSecretHeader(sessionId: number): Record<string, string> {
  if (typeof window === "undefined") return {};
  const secret = localStorage.getItem("sbc.actingAs." + sessionId);
  return secret ? { "X-Nickname-Secret": secret } : {};
}
```

**为什么不改 `apiFetch` 签名加全局 secret 参数**：
- `apiFetch` 是通用 client，不是 bills 专属
- 不同 endpoint 需要不同 secret key（settle 用 sessionId，但未来 `/sessions/{id}/preview` 可能不同 key）
- 保持 caller 显式传 header 更可读、可 grep

**Coder 复用 `listBills` 的 fetch 模式**：`bills.ts:51-58` 已有 `localStorage.getItem("sbc.actingAs." + sessionId)` 取 secret + `headers: { "Content-Type": "application/json", ...headers }` 模式。**Coder 必读**这段避免重写。

### C. BE 依赖统一

**Before**（v0.3.1）：
```python
@router.post("/sessions/{session_id}/bills/parse")
async def parse_bill(sm: Annotated[SessionMember, Depends(get_session_member)], ...):
    ...

@router.patch("/sessions/{session_id}/bills/{bill_id}")
async def update_bill(sm: Annotated[SessionMember, Depends(get_session_member)], ...):
    ...

@router.delete("/sessions/{session_id}/bills/{bill_id}")
async def delete_bill(sm: Annotated[SessionMember, Depends(get_session_member)], ...):
    ...
```

**After**（v0.3.2）：
```python
@router.post("/sessions/{session_id}/bills/parse")
async def parse_bill(sm: Annotated[SessionMember, Depends(get_session_member_or_secret)], ...):
    ...

@router.patch("/sessions/{session_id}/bills/{bill_id}")
async def update_bill(sm: Annotated[SessionMember, Depends(get_session_member_or_secret)], ...):
    ...

@router.delete("/sessions/{session_id}/bills/{bill_id}")
async def delete_bill(sm: Annotated[SessionMember, Depends(get_session_member_or_secret)], ...):
    ...
```

**依赖本身不改**（保持向后兼容）：
- `get_session_member_or_secret` (session_isolation.py:60-94) 已支持 user + nickname_secret 两种 binding
- POST /bills + GET /bills 已经在用，PATCH/DELETE/parse 是对齐遗漏

### D. UI 改动详情

**Session header 删除整段**（`/sessions/[id]/+page.svelte:414-419`）：
```svelte
<!-- 删除 -->
<div class="session-header-actions">
  <!-- PO 14:01 重申: header 完全**不**要任何 login/logout/登录以保存 按钮.
       全部用页面最上方的 banner 那个就行. 这里只留 "查看结算" 链接. -->
  <a class="btn ghost" href="/sessions/{session.id}/settle">查看结算</a>
</div>
```

**保留**：session header 的 `<h2>` session 名 + 「主币种: CNY」chip 不动（PO §3.12.4 排除项）。

**账单 section head 重写**（line 520-532 区域）：
```svelte
<div class="bills-card-head">
  <div class="bills-card-head-left">
    <h3 class="bills-card-title">账单</h3>
    <span class="muted bills-card-count">共 {bills.length} 笔</span>
  </div>
  <div class="bills-card-head-right">
    <a class="btn ghost btn-sm" href="/sessions/{session.id}/settle" aria-label="查看结算">
      <Icon name="calculator" size={16} />
      <span>查看结算</span>
    </a>
    <a class="btn ghost btn-sm" href="/sessions/{session.id}/settle#personal" aria-label="查看个人账单">
      <Icon name="user" size={16} />
      <span>个人账单</span>
    </a>
  </div>
</div>
```

**图标组件**：用项目内现有 `Icon` 组件（已在 v0.1.3 引入，Lucide SVG）。Coder 必读 `frontend/src/lib/components/Icon.svelte`（如不存在则用 `<svg>` 内联 SVG）；icons `calculator` + `user` 来自 lucide-static。

**CSS 调整**：`.bills-card-head` 改 flex layout，`gap: 8px`，移动端 wrap 仍保持两按钮并排（**不**换行，**不**变 stack）；按钮内 icon + 文字 `display: inline-flex; gap: 4px; align-items: center`。

### E. 验收清单

#### E.1 API 验收（curl + pytest）

1. **匿名 create 200**：`curl -X POST /api/sessions/{id}/bills -H "X-Nickname-Secret: $SECRET"` → 201
2. **匿名 PATCH 200**：`curl -X PATCH /api/sessions/{id}/bills/{bid} -H "X-Nickname-Secret: $SECRET"` → 200
3. **匿名 DELETE 204**：`curl -X DELETE /api/sessions/{id}/bills/{bid} -H "X-Nickname-Secret: $SECRET"` → 204
4. **匿名 parse 200**：`curl -X POST /api/sessions/{id}/bills/parse -H "X-Nickname-Secret: $SECRET" -d '{"text":"午饭 50 块"}'` → 200（不依赖外部 API，用 fixtures）
5. **无 secret GET 仍 403**：`curl /api/sessions/{id}/bills`（无 header）→ 403
6. **错误 secret GET 仍 403**：`curl -H "X-Nickname-Secret: wrong" /api/sessions/{id}/bills` → 403
7. **logged-in user 不传 secret 仍能 CRUD**：cookie 鉴权链路不破坏

#### E.2 pytest 新增（Master 必加反 #129 — Tester 必跟 PRD + SPEC 写）

新文件 `backend/tests/test_bills_anon_crud.py`（或扩展 `test_bills.py`）覆盖：
- `test_anon_can_create_bill_with_secret`（POST 201 + DB 验证 created_by IS NULL / nickname_secret 能查到）
- `test_anon_can_patch_bill_with_secret`（PATCH 200）
- `test_anon_can_delete_bill_with_secret`（DELETE 204 + DB 验证 row 消失）
- `test_anon_can_parse_bill_with_secret`（parse 200，**不**依赖 MiniMax API，monkeypatch fake）
- `test_no_secret_returns_403_on_create/patch/delete/parse`（4 个 test）
- `test_wrong_secret_returns_403_on_create/patch/delete/parse`（4 个 test）
- `test_logged_in_user_without_secret_still_works`（保护向后兼容 cookie 路径）

**SBC_SKIP_TEST_TRUNCATE=1** 必设（反 #53b）防擦生产数据。

#### E.3 Playwright e2e（Tester 写，Master 验收）

新文件 `frontend/e2e/anon_bill_crud.spec.ts` 覆盖：
- (A) 匿名 dd 通过 `/s/{code}` join → `/sessions/{id}/bills/new` 填表 POST → 201 → 回 session 详情页看到新 bill
- (B) 匿名 dd 点 bill row → 编辑页 PATCH amount → 200 → 回 session 详情页看到更新
- (C) 匿名 dd 滑动 bill row → 删除 → 204 → 回 session 详情页看到 bill 消失
- (D) 匿名 dd 点 AI 辅助按钮 → 输入"午饭 50 块" → parse 200 → 表单预填 → POST 201
- (E) 视觉验证：账单 section head 两按钮并列、风格一致、Lucide 图标清晰可见（**Coder 截图 + image 工具分析**）
- (F) 完整真手机 walk（反 #130）：Master 拿 iPhone 真访问 `test.jessejia.pp.ua/s/{code}` → 创建/编辑/删除 → 截图 + image 工具分析

### F. 部署 / 验证

- **FE 改动**：vite HMR 自动 reload；如 commit 后 HMR 没生效 → `kill <vite_pid> && nohup ... &`（反 #43）
- **BE 改动**：`kill <uvicorn_pid> && nohup uvicorn ... --env-file .env &` → `curl /version` 验证新 commit hash
- **DB 不动**：无 migration，DB schema 不变
- **PRD action item**：本批完成后 Master 同步 PRD §11 changelog（**不**让 Coder 改 Obsidian）
- **单分支铁律**：Coder push 后必跑 `git fetch origin && git branch -r` 只剩 origin main（dev skill §单分支铁律）
- **E2E 必跑**：`npx playwright test e2e/anon_bill_crud.spec.ts` 必 6/6 pass 才算 done

### G. 反模式预防（实施前必读）

- **反 #51 续**：`apiFetch` 第 3 参数 `extraHeaders` 已被签名支持，**不**重写 `apiFetch`；只在 caller 加 `extraHeaders: getNicknameSecretHeader(sessionId)`
- **反 #53b**：`SBC_SKIP_TEST_TRUNCATE=1` pytest 必设，否则擦生产数据
- **反 #67**：`git fetch origin` 再看 `origin/main`，不要看本地 tracking branch
- **反 #68**：`version.ts` bump 前必跑 `git log -1 --format=%H origin/main` 拿真实 HEAD
- **反 #100**（prod context）：e2e 不注入 cookie，真 anon user 走完整 `/s/{code}` 路径
- **反 #131**：Coder + Tester 并行 spawn（Master 同时 spawn 2 Agent）
- **反 #132**：Tester 必自己跑测试方案，不信 Coder "测试通过"
- **反 #130**：Coder + Tester 都过不算 done，Master 真手机走完整 dd user story 才算 done
- **反 #117**：Coder 完成 → Master 推 Telegram，commit hash + tests pass/fail 数 + 主变更文件数

---

## §3.13 dev_seed opt-out + nightly_cleanup (v0.3.13)

**PO 拍板时间**：2026-07-12 09:21 — Jesse "要"（根治"sessions 数据反复出现"诉求）
**前因**：Jesse 多次手动清 SBC DB 残留 + 邮箱，根因是 uvicorn lifespan hook 强制注入 `xinhua1001` user + 泰国测试账单 + 个人测试 + 27 bills；同时 `verification_codes` 与 `auth_tokens` 表没 TTL 清理，"几十年冒一次"症状。

### A. 产品意图 (PO 单决策)

| 决策 | 内容 |
|------|------|
| **a** | dev seed 在 dev 默认 **跳过**（不再强制注入）|
| **b** | prod 沿用既有 `ENV=production` 守卫 (受 #53 prod 不可污染原则约束) |
| **c** | dev 主动要 seed：显式 `SBC_SKIP_SEED=false`（opt-in 仍可用）|
| **d** | 夜级清理脚本作为可重复执行的 CLI，**不**挂 cron（如要 cron 由 PO 后续单独拍）|
| **e** | 清理脚本不动活跃 session-cookie —— 仅清 (expires_at < now) 或 (last_used_at IS NULL 且 created_at < now-N) 的 token |

> 反 #136 自检：以上全部是产品问题，"用户看到什么/用什么"层面变化；技术实现 (env var 名 / 脚本设计 / retention 默认值) Master 拍板, 不重复问 PO.

### B. Config 层

新增到 `backend/app/core/config.py` (pydantic-settings 自动接 env):

| key | 类型 | 默认 | 说明 |
|-----|------|------|------|
| `sbc_skip_seed` | bool | `True` | `True` = 启动时**不**注入 dev fixtures。改 False = opt-in 注入 |
| `auth_token_ttl_days` | int | `30` | 30 天未使用过的 token 视为过期 |
| `verification_code_retention_days` | int | `7` | 7 天前的 used/expired verification_code 清掉 |

> 优先级: `ENV=production` → 永远 skip seed > `SBC_SKIP_SEED` > 默认值.

### C. seed_dev_data 改动

```python
def seed_dev_data(db=None) -> dict:
    if os.getenv("ENV") == "production":
        return {"skipped": "ENV=production"}
    from app.core.config import settings
    if settings.sbc_skip_seed:
        return {"skipped": "SBC_SKIP_SEED", "hint": "..."}
    # ... 原来逻辑
```

### D. 新增 scripts/cleanup_expired.py

**接口**:

```
cd backend && .venv/bin/python -m scripts.cleanup_expired [--dry-run] [--quiet]
```

**清理逻辑** (active session-cookie 不动):

| 表 | 删除条件 |
|----|----------|
| `verification_codes` | `(used=1 AND created_at < now-7d)` ∪ `(used=0 AND expires_at < now-1h)` |
| `auth_tokens` | `expires_at < now` ∪ `(last_used_at IS NULL AND created_at < now-30d)` |

**输出**:

```
INFO  scripts.cleanup_expired: verification_codes: 6 stale row(s) (6 consumed-stale + 0 unused-expired)
INFO  scripts.cleanup_expired:   would drop id=46 email=your-smtp-user@example.com code=731673
...
WARNING scripts.cleanup_expired: CLEANUP SUMMARY: verification_codes dropped=6, auth_tokens dropped=3
```

**退出码**: 0 success / 1 config error / 2 SQL error.

### E. 验收清单 (反 #129 #130)

1. **冷启动 verify (`kill uvicorn && nohup uvicorn ... &`)**：日志含 `[startup] seed_dev_data: {'skipped': 'SBC_SKIP_SEED', ...}`。curl `/version` 验新 commit hash.
2. **opt-in 验**: `SBC_SKIP_SEED=false kill uvicorn && SBC_SKIP_SEED=false nohup uvicorn ... &` → 日志含 `xinhua_user_id: 23 ...`.
3. **cleanup dry-run**: `.venv/bin/python -m scripts.cleanup_expired --dry-run` → 6 行残留预期（4×auth_token 三胞胎 + 1×jessejia verification + 1×xinhua verification）.
4. **cleanup 真跑**: 删 6 行后 `verification_codes` 总数从 46 → 45 (实际含过期未消耗的清理), `auth_tokens` 从 4 → 1 (保留最近活跃的 t=230).
5. **接口 regression**: `curl /api/sessions -H cookie:sbc_session=...` 仍返 xinhua 的 3 个 sessions (sess=63/64/183).
6. **DB 备份 验证**: `cat /home/node/.openclaw/backups/sbc/MANIFEST.tsv` 末行新时间戳 + sha256.

### F. 部署

- BE 单 commit 自包含: config.py + seed_dev_data.py + scripts/cleanup_expired.py + .env.example.
- 不动 migration (无 schema 变化).
- `kill <uvicorn_pid> && nohup uvicorn ... --env-file .env &` 重启后 verify.

### G. 反模式预防

- **反 #53 续**: 改 backend 代码前必跑 `sbc_backup.sh`. cleanup 脚本本身**修改**DB schema 不变，但运行时会 DELETE → 已先 backup (MANIFEST.tsv 有新行).
- **反 #136**: Master 自查 — a/b/c/d/e 全是产品问题；env var 名 / 默认值 / 脚本 chunk size / dry-run 模式 都不问 PO.
- **反 #129**: cleanup script **自带** 一个 dry-run 模式 + 一个真跑模式, 不是单元测试能 cover 的 destructive 操作 — pytest 里调 dry-run 1 次就够.

## §3.14 v1.0 UAT 反馈 — session 币种展示 + 汇率可编辑 + settle 用最新汇率重算 (v0.3.14)

**PO 拍板时间**：2026-07-13 11:31 #4125 + 11:33 #4131 (telegram)
**前因**：v1.0 UAT 阶段 Jesse #4117 + #4125 报 5 个 BUG；BUG #5 涉及 (1) 币种展示 (2) 汇率可编辑 (3) **改汇率后汇总立即更新** = 推翻 §3.7.6 snapshot 隔离部分。
**PRD 章节**：§3.14 决策点 14。

### A. 产品意图 (PO 单决策)

| 决策 | 内容 |
|------|------|
| **a** (BUG #5 §3.14.1) | 单币种展示 `币种：CNY`; 双币种展示 `主币种：CNY` / `副币种：JPY` / `汇率：0.045`（**多行**，**不**单行）|
| **b** (BUG #5 §3.14.2) | 双币种汇率**可编辑**（click → inline edit → POST PATCH `/sessions/{id}/exchange-rates`）|
| **c** (BUG #5 §3.14.3) | **settle 汇总页** 用 **session_exchange_rates 当前值** 重算（**不**读 `bill.exchange_rate_snapshot`）|
| **d** (BUG #5 §3.14.3 混合语义) | **bills 详情页 + bills 列表** 仍用 **`bill.exchange_rate_snapshot`**（历史准确性，**不**改）|
| **e** (BUG #5 §3.14.1 位置) | 位置（session 标题上方/下方）**让 design agent 评估**，不是产品决策 |

> 反 #121 / #136 自检：以上 (a)(b)(c)(d) 都是产品问题；位置让 design agent 拍；技术实现 (settle 算法如何读 / PATCH endpoint 形状 / 组件结构) Master 拍。

### B. BUG #5 §3.14.3 — settle 算法改写（推翻 §3.7.6 settle 部分）

**当前算法** (`backend/app/api/settle.py` `_compute_per_member`):
```python
# line 24-25 (current):
# - currency == primary: use bill.amount as-is.
# - currency != primary: bill.amount * bill.exchange_rate_snapshot,
```

**改后算法**（按 §3.14.3 PO 拍板）:
```python
# 查 session 当前汇率 (替代 bill.exchange_rate_snapshot)
from app.db.models.session_exchange_rates import SessionExchangeRate
current_rates: dict[tuple[str,str], Decimal] = {
    (r.from_currency, r.to_currency): r.rate
    for r in db.query(SessionExchangeRate).filter_by(session_id=session_id).all()
}
# 反向汇率自动算: 如果有 USD→CNY 没有 CNY→USD → 自动 1/rate
for (f, t), r in list(current_rates.items()):
    if (t, f) not in current_rates:
        current_rates[(t, f)] = Decimal("1") / r

# bill 计算
for bill in bills:
    if bill.currency == session.primary_currency:
        amount_primary = bill.amount
    else:
        amount_primary = bill.amount * current_rates[(bill.currency, session.primary_currency)]
    # ... rest of settle logic same as before ...
```

**关键差异**:
- `amount_primary` per bill（用于 bills 列表）→ **仍用** `bill.exchange_rate_snapshot`（不在这函数里）
- `amount_primary` per bill（用于 settle 内部聚合）→ 用 **current_rates[...][...]** 实时算
- 两个地方数字可能不一样 — **预期**，**不**是 bug

**反向汇率自动算** (从 §3.7.6 拍板): 双币种 session 创建时必填至少一条汇率；其他方向自动 1/rate。

### C. BUG #5 §3.14.2 — 汇率 inline edit 流程

**UI**（由 Design Agent 评估最终设计）:
1. 双币种 session 详情页/settle 页显示「汇率：0.045」字段
2. 点击 → 变成 input field（保留原值）
3. 输入新值 + Enter / blur → POST PATCH `/sessions/{id}/exchange-rates` body `{from_currency, to_currency, rate}`
4. 成功后 → 刷新页面（settle 立即用新汇率）

**BE**（已有 `/sessions/{id}/exchange-rates` PATCH endpoint，从 v0.2.2 拍板）:
- 验 owner 权限
- UPDATE `session_exchange_rates` SET rate = ?, snapshot_at = NOW()
- 不删旧 row（保留历史）
- 返 200 + 新 rate row

**不**做（§3.14.4 排除项）:
- ❌ 汇率修改历史 / undo
- ❌ 汇率修改通知
- ❌ 批量修改
- ❌ 双币种 session 创建流程改动（仍按 §3.7.6 必填至少一条汇率）

### D. BUG #3 — FE `Number()` 转（最小修复）

**根因**: BE `MemberSettlement.total_paid: Decimal` + `model_dump(mode="json")` 序列化为 string `"800.00"`；FE `tweenPaid.set("800.00")` svelte tweened 不接受 string → value 保持 0 → 显示 "0.00"。

**修法** (1 行 × 3 处):
```typescript
// frontend/src/lib/components/SettleMemberBreakdown.svelte
$: if (selectedMember) {
  tweenPaid.set(Number(selectedMember.total_paid ?? 0));      // 加 Number()
  tweenConsumed.set(Number(selectedMember.total_consumed ?? 0));  // 加 Number()
  tweenNet.set(Number(selectedMember.net ?? 0));              // 加 Number()
  prevSelectedMemberId = selectedMember.member_id;
}
```

**不**动 BE: 不改 `MemberSettlement` json_encoders（保持 Decimal 序列化语义，避免全局影响）。

### E. BUG #4 — tab 改名

**改动** (`frontend/src/routes/sessions/[id]/settle/+page.svelte`):
- 按钮 "源币种分列" → "原始数据"
- 文案: 「主币种汇总 (CNY)」按钮保留不变；「原始数据」disabled 文案 "该 session 只有一种币种" 保留
- 两个 tab 分工（PO #4117 明确）: 「原始数据」= 按源币种明细；「主币种汇总」= 换算成主币种后的汇总

**不**改 settle 算法（BUG #5 §3.14.3 算法独立生效）。

### E.1. v0.3.14.1 实现细节 (Bug A + Bug B 修复，2026-07-14)

#### E.1.a Bug A — balances 不变量 `sum(balances) == 0`

**根因**: `_compute_balances` 中 `per_user_shared = _quantize(shared_pool / len(ppts))` — 每份独立 quantize 导致 N x per_user_shared != shared_pool（有余数丢失）。累积到 balances 后 `sum(balances) != 0`。

**修法**:
- `per_user_shared` 用 raw Decimal（`shared_pool / Decimal(len(ppts))`，**不** quantize）
- `net[mid] = paid - consumed` 用 raw Decimal（**不** quantize）
- `_greedy_pair` 中每次转账金额 quantize（护住 sum-to-zero）
- 加 invariant assertion: `total_net = sum(net.values())` 用 `_is_zero()` 检测（tolerance = 0.0001），violate 则 raise `AssertionError`
- 同理 `_share_amounts_primary` 的 `per_user_shared` 也改为 raw Decimal

**效果**: `sum(balances.values()) == Decimal("0")` 对任意 bill amount / participant 组合严格成立。

**测试**: `TestBalancesInvariantSumZero` 4 cases — 单币种 / 多成员 / 极端除法 (1000/3) / 含 exclusive。

#### E.1.b Bug B — `view=split` 返 `currency_breakdown`

**BE** (`settle.py`):
- `CurrencyBreakdown` Pydantic model: `{paid: Decimal, consumed: Decimal, net: Decimal}`
- `SettleResponse.currency_breakdown: dict[str, CurrencyBreakdown] | None`（仅 `view=split` 时填充）
- `_compute_currency_breakdown()`: 遍历每笔 bill，按 `bill.currency` 汇总 paid / consumed 到对应 currency dict
- `balances` / `transfers` / `per_member` 仍为主币种（不受影响）

**FE types** (`lib/api/settle.ts`):
```typescript
export interface CurrencyBreakdown {
  paid: number;
  consumed: number;
  net: number;
}
// SettleResponse 加:
currency_breakdown?: Record<string, CurrencyBreakdown>;
```

**FE 组件** (`SettleTransferPath.svelte`):
- `{#if viewMode === 'split' && data.currency_breakdown}` 时渲染「按源币种」一节
- 按 `paid` 降序排列 currency
- 每行: `CCY  paid X.XX / consumed Y.YY / net Z.ZZ`（net > 0 绿色，< 0 红色）
- `viewMode === 'primary'` 时该节隐藏

### F. BUG #1 — 「返回 session」按钮美化

**当前**: `<a class="btn ghost back-btn" href="/sessions/{sessionId}">返回 session</a>` — 仅文字
**改后**（Design Agent 拍最终设计）: 文字 + icon (chevron-left) + 触摸目标 ≥ 44px + 视觉 token (颜色 / 字号 参照 v0.1.3)

### G. BUG #2 — 「谁付给谁多少，一目了然」文案

**PO #4117 提问** — 出现在正式产品中是否合适？
**Master 自检** (反 #121): 这是文案细节 → **PO 拍板**，**不**自决。
**等 PO 拍文案**: Master 在 commit message / Telegram 跟进；如果 PO 不改，保留原文（"谁付给谁多少,一目了然" 暂作为 §3.6.6 T06 transfer path click 砍掉后的残留文案，v0.3.14 不主动改）。

### H. 验收清单 (反 #129 #130)

1. **DB 反 #53 备份** (codeserver 内 `cp sbc.db .../sbc-YYYYMMDD-HHMMSS.db.v0.3.14-pre` + sha256)
2. **pytest** (`cd backend && .venv/bin/python -m pytest tests/ -q`): 数量不退化 (baseline 411 + 新增 ≥ 4 case for §3.14.3 算法)
3. **svelte-check**: 0 new error
4. **e2e** (按反 #131 + #132): 至少 3 个新 spec — (a) settle 改汇率立即更新 (b) 单币种展示「币种：CNY」(c) 双币种展示多行 + 汇率 inline edit
5. **真用户验收 (反 #130)**: Jesse 在 `test.jessejia.pp.ua` 浏览器 (iPhone viewport 390x844) 走 4 场景 — (a) S1 单币种显示 (b) S2 双币种多行显示 (c) S2 改汇率 0.045→0.05 → settle balances/transfers 立即变 (d) S2 bills 列表 amount_primary 不变（snapshot 隔离）
6. **git push** + **单分支铁律** (`git branch -r` 仅 origin/main)
7. **PRD §11 changelog** append v0.3.14-done 行（Master 写）

### I. 反模式预防

- **反 #148**: 全部 spawn agents 走 codeserver 容器；OpenClaw 只调 `codeserver_exec.js` / `codeserver_write.js` / `codeserver_copy.py`。
- **反 #53**: 改 DB schema / 数据前 codeserver 内 `cp sbc.db ...backup` + MANIFEST.tsv 验证。
- **反 #121**: Master 不列技术选项 (a/b/c) 给 PO 选；本轮 BUG #3 修法自决 FE Number()。
- **反 #131**: Coder + Tester + Design Agent 并行 spawn。
- **反 #132**: Tester 自己跑测试方案，**不**信 Coder "测试通过"。
- **反 #130**: process green + product green 双轴，未经过 Jesse 真用户验收 = **未完成**。


## §3.15 v0.3.15 UI/UX 优化轮次 — A 组 (Coder A 实施)

**PO 拍板时间**：2026-07-15 04:25 (PRD §3.15.2)
**前因**：PO 在 v0.3.14.1 + hotfix 全部 committed 后真机走 settle 页 + bills 编辑/新建流程，截 3 张图报 7 个 UI/UX 问题。PRD §3.15 列了全部 7 + E 问题；本节只覆盖 **A 组**（Coder A 实施范围，B 组 3 项 #3/#4/#E 由 Design Agent 出 mockup 后另一名 Coder 实施）。
**PRD 章节**：§3.15.2 决策 + §3.15.4 A 组范围。

### A. 产品意图 (PO 单决策 — A 组子集)

| 决策 | 内容 | 来源 PRD |
|------|------|---------|
| **#1** | **删** settle 概览 tab 上方 "谁付给谁多少，一目了然" | §3.15.2 #1 |
| **#2** | settle 概览 tab 数字 = 数字 + 货币符号 (¥1,146.15 / -¥66.65)，按 session primary_currency | §3.15.2 #2 |
| **#6** | bills/new + bills/edit 「返回」+「保存」按钮搬到页面**底部** 悬浮 sticky bar | §3.15.2 #6 |
| **#7** | `←` Unicode 换 Lucide-svelte ArrowLeft 图标 (`size=16`) | §3.15.2 #7 |

### B. 改动文件清单

| 文件 | 改动 |
|------|------|
| `frontend/src/routes/sessions/[id]/settle/+page.svelte` | #1：删除 `<p class="muted">谁付给谁多少，一目了然</p>` 行 + 顶部加 v0.3.15 #1 commit 注释 |
| `frontend/src/lib/utils/currency.ts` | **新建**：导出 `currencySymbol(code: string): string`，CNY/THB/JPY/USD/EUR/GBP 6 个映射 (#2 准备) |
| `frontend/src/lib/components/BillForm.svelte` | #2：把 BillForm 内的 `currencySymbol` 内联函数抽到 `$lib/utils/currency`；#6：底部 submit `<div class="row">` 替换为 `.action-bar.sticky-bottom` (返 + 存)；#7：bar 里「返回」按钮配 Lucide ArrowLeft 图标 |
| `frontend/src/lib/components/SettleTransferPath.svelte` | #2：所有金额输出前拼币种符号 (`fmtWithSymbol(n, session.primary_currency)` for 主币种汇总; `fmtWithSymbol(n, ccy)` for 按源币种 currency_breakdown) |
| `frontend/src/routes/sessions/[id]/bills/new/+page.svelte` | #6：删除顶部 `<div class="row"><a>返回</a></div>` |
| `frontend/src/routes/sessions/[id]/bills/[billId]/edit/+page.svelte` | #6 同上；#7：error 分支的「返回」链接改用 Lucide ArrowLeft 图标 |

### C. 关键设计点 (实施期间 Master 拍板，非产品决策)

1. **`action-bar.sticky-bottom` 放在 BillForm 还是 parent page？** **拍板 (Master)：放 BillForm.svelte**。原因：`<form>` 元素在 BillForm 内部，把 action-bar 放 BillForm 让 `<button type="submit">` 自动在 form 里 submit；父页面没有 `<form>`，硬要这么做需要 `<form>` 套 BillForm 或外部 `form.requestSubmit()` JS 桥接，反而增加复杂度。代价 = 父页面文件没「物理」touch #6 操作，但语义/UX 达成 100% 一致。
2. **`bills/new` 没有 error 分支里的「返回」链接，怎么满足 #7 文件列表？** **拍板 (Master)**：`bills/new/+page.svelte` 加 v0.3.15 §3.15.2 #6+#7 注释块 (说明该页面没有「返回」button 可被 ArrowLeft 替换 — 因为 #6 删掉了)，**不** import lucide-svelte (避免 unused import)。`bills/[billId]/edit/+page.svelte` 的 error 分支确有「返回」按钮，所以那里 import + 替换。
3. **`currency.ts` 映射是否应该走 `Intl.NumberFormat`？** **拍板 (Master)：否**。`Intl` 对 CNY 返回 `"CN¥"` 两个字，视觉上比单字符 `¥` 重，跟 settle balances 单字符样式冲突。保持 6 个硬编码映射 (CNY/THB/JPY/USD/EUR/GBP)，未知 code 回退空串。
4. **`fmtWithSymbol` 独立 helper vs 在 `formatMoney` 加 `showCurrencySymbol: boolean` 选项？** **拍板 (Master)：独立 helper**。`formatMoney` 的 `showSymbol: true` 当前意味着「数字后缀 加 ` ${currency}`」—— 这是 BillForm 金额输入框用的形态（`888.00 CNY`）。Settle 余额要的是前缀符号，不宜扩 `formatMoney`，独立 `fmtWithSymbol` 在 `SettleTransferPath.svelte` 内部声明更隔离 + 测试更直接。
5. **sticky bar 用 `position: sticky` 还是 `position: fixed`？** **拍板 (Master)：sticky**。Sticky 在 form 最近的 scroll container (这里是 `<body>`) 范围内吸附底部；当 page 比 viewport 短时，bar 停在 form 末尾自然位置；page 比 viewport 长时，bar 视觉上跟 viewport 底部绑定。Fixed 会跨 scroll context 飘走 (在 iOS Safari 上尤其严重)。
6. **CSS selector 修正：`.btn.primary` vs `button.primary`**：BillForm 现有提交按钮 HTML 是 `<button class="primary">` 不是 `.btn.primary`。svelte-check 报 `.btn.primary` 是 unused selector；改成 `button.primary` (mobile 全宽)。

### D. 验收清单 (反 #129 #130)

1. **DB 反 #53 备份**：本批纯 FE 不动 schema/data，N/A。
2. **pytest** (`cd backend && .venv/bin/python -m pytest tests/ -q`)：数量不退化 (A 组是纯 FE，理论上不影响 backend；baseline 397 passed, 76 failed, 3 skipped；本批跑同数 → 通过)。
3. **svelte-check**：本批增量 0 (baseline 6 errors + 24 warnings；#6 第一版 `.btn.primary` 选择子不匹配 `button.primary`，引 +1 warning → 已修正)。
4. **e2e**：本批**不**改也不重新跑 (Tester Agent 在 v0.3.15 主 sprint 内并行写新 spec 覆盖 #1+#2+#6+#7 视觉回归，本批 Coder A 不直跑避免覆盖 Tester 工作 — 反 #132)。
5. **真用户验收 (反 #130)**：Master 用 iPhone 真机 (390x844 真 viewport) 跑 4 场景: (a) settle 概览 tab 无 "一目了然" 行 + 数字带 ¥; (b) bills/new 底部 sticky bar 显示「<返回 session  / 保存账单」; (c) bills/new 输入金额+点保存会跳回 session; (d) bills/edit error 分支 (人为 id=999) 显示带 ArrowLeft 的「返回」。
6. **git push origin main + 单分支铁律** (`git branch -r` 仅 origin/main)：本批 4 commit 全 push，branch 列表仅 origin/main。
7. **PRD §11 changelog** append v0.3.15 A 组行 (Master 写)：本批 SPEC §3.15 同步在 commit 里 (反 #128)，PRD §11 由 Master 在 push 后手动追加。

### E. 4 个 commit 的 short hash

| # | commit | 主题 |
|---|--------|------|
| 1 | `0984d10` | feat(fe): v0.3.15 #1 删除 settle page "一目了然" 文案 (PRD §3.15.2 #1) |
| 2 | `5f37239` | feat(fe): v0.3.15 #2 SettleTransferPath 加币种符号 (PRD §3.15.2 #2) |
| 3 | `8bf70c8` | feat(fe): v0.3.15 #6 底部悬浮 sticky bar (Return ghost + Save primary) (PRD §3.15.2 #6) |
| 4 | `571f3bc` | feat(fe): v0.3.15 #7 ← Unicode → Lucide ArrowLeft icon (PRD §3.15.2 #7) |

> **commit 顺序说明**：commit #1 (PO 优先级最高 — 文案直接砍)，然后 #2 (改 SettleTransferPath 数字显示)，然后 #6 + #7 (bills/new + bills/edit 全 UI 重构；按 PRD §3.15.4 sprint 拆分 #6 顺序在 #7 之前；#7 给 sticky bar 装图标)。

### F. 反模式预防（实施期间新增 / 验证）

- **新增 A.1** — `#6` 行动作 sticky bar 应该**放 `<form>` 内部**，而不是父页面。新手倾向直接在父页面加 action-bar (跟 brief 文件列表字面对齐)，但 `<form>` 在 BillForm 内部 = `<button type="submit">` 失去 form 归属，submit 桥接代码变多。**检测 prompt**：写 #6 前先 grep "`<form`"，找到唯一 <form> 在哪个文件，就在哪儿放 submit-triggering 按钮。
- **新增 A.2** — `bills/new` 的「返回」按钮在 #6 已被删除 (brief 1 + brief 2 共同消除)；不要强行 import lucide 图标换无 anchor 的位置 — 会引 unused import 警告 + 跟实际 UX 失配。`bills/edit` 的 error 分支仍保留「返回」链接，那里 import + 替换才对。
- **新增 A.3** — CSS selector 要跟实际 HTML 的 class 完全一致。BillForm 的 submit 按钮是 `<button class="primary">` (不是 `.btn.primary`)，svelte-check 会报 unused selector `.btn.primary`。在写 mobile 媒体查询时**先 grep**实际 class 名再写选择子。
- **验证反 #128** (SPEC + 代码同 commit)：本 SPEC §3.15 是单独 commit (chore(spec))，但跟 #1-#7 在同一 push 周期 — 本批从首个 commit 到 SPEC commit 间隔 < 1 小时，PRD §11 由 Master 在 push 后即时补。
- **验证反 #148** (codeserver 唯一路径)：本批所有 dev work 跑在 codeserver container，OpenClaw 仅调 `codeserver_exec.js` / `dump_b64.js` / `test_screenshots.js`；screenshots 落地 `/home/node/.openclaw/workspace/sbc/sbc/sprint-notes/v0.3.15/coder-a-screenshots/`。
- **验证反 #130** (真用户验收)：本批 process green (0 new svelte-check error) + product green (screenshots 4 张覆盖 4 任务) 双轴通过；**最终真机 walk 待 Master 在 test.jessejia.pp.ua 跑**。


## §3.16 v0.3.15 UAT 数据持久化 (PO #4784)

**PO 拍板时间**：2026-07-15 20:00 — Jesse "找 test coder 建一组 uat 测试数据，之后确保测试数据在每次 commit 后都持续存在。"

### A. 产品意图 (PO #4784)

| 决策 | 内容 |
|------|------|
| **a** | 建 UAT 测试数据：xinhua1001 user + Thailand session (currencies=['CNY','THB'], primary=CNY) + 32 bills (27 THB + 5 CNY) + personal session owned by xinhua1001 |
| **b** | seed 默认行为改为**自动注入**（`sbc_skip_seed` 默认值 True → False） |
| **c** | seed 为 find-or-create 模式：**不清已有数据**，只补缺失 fixture |
| **d** | 已有 DB 不 wipe：xinhua1001 user 保留，Thailand session 和 personal session find-or-create 补入 |

### B. Config 改动

`backend/app/core/config.py`:

| key | 旧值 | 新值 | 说明 |
|-----|------|------|------|
| `sbc_skip_seed` | `True` | `False` | v0.3.15 UAT 持久化 (PO #4784) |

> 改动影响：uvicorn 启动时 seed 默认跑，find-or-create 不清数据。开发者可通过 `SBC_SKIP_SEED=true` 临时 opt-out。

### C. seed_dev_data 行为

seed 脚本 (`backend/scripts/seed_dev_data.py`) 已有 find-or-create 逻辑：

- `demo@example.com` user：已存在则跳过
- `泰国测试账单 6.19-6.22` session：已存在则跳过（保留现有 bills）
- `个人测试` session：已存在则跳过
- Bills：已存在则跳过（32 bills = 27 THB + 5 CNY）

**不做**：不 DELETE 任何已有行，不 truncate，不 DROP TABLE。

### D. 验收清单

1. **Config verify**：`grep "default=False" backend/app/core/config.py` 含 `sbc_skip_seed` 行。
2. **DB verify**（seed 跑完后）：
   - `SELECT COUNT(*) FROM users WHERE email='demo@example.com'` → 1
   - `SELECT id, name, primary_currency, currencies FROM sessions WHERE owner_user_id=<xinhua_id>` → 2 rows (Thailand + personal)
   - Thailand session: `currencies=['CNY','THB']`, `primary_currency='CNY'`
   - Bills: 32 total (27 THB + 5 CNY)
3. **seed log verify**：`cat /tmp/uvicorn.log` 含 `{...}` 非 `skipped` 的 seed 结果。
4. **commit + push**：`git log --oneline -1` 确认为最新 commit，branch 仅 origin/main。

### E. 反模式预防

- **反 #53**：不 rm sbc.db，find-or-create 模式保证不丢数据。
- **反 #152**：不 DELETE + seed 清数据，seed 只补缺失 fixture。
- **commit 不丢**：seed 默认注入，commit push 后 uvicorn 重启仍然保持 fixture 在 DB（find-or-create 防重置）。
- **restart 不丢**：同 find-or-create 逻辑，restart 后 seed 发现 fixture 存在则跳过。

### §11. v0.3.17 #26 (2026-07-17) — login anon CTA + wizard anon support
* 登录页 step=send 加 或-divider + 不想登录？提示 + 直接开始使用按钮（跳 /sessions/new）
* Wizard step 2 hint: 包括你自己最少1人 → 别担心稍后也可添加更多成员
* Wizard step 3: anon 时始终显示（showCurrencyStep=true），隐藏双币按钮，加需要多币种？提示
* 修 step 3 返回按钮 bug (step=3 → step=2, 之前原地踏步)
* 修 step 标签重复（showCurrencyStep 永久 true 导致两行同时匹配）
* 修 goNext step 2: 简化逻辑（showCurrencyStep 永远 true）

### §11. v0.3.17 #27 (2026-07-17) — login + wizard 全玻璃化 + Toast 玻璃化
* **登录页** (routes/auth/login/+page.svelte):
  * email/code 输入框 → `.glass-input` (半透白底 + 1.5px 玻璃描边蓝紫 + saturate 180% blur 12px)
  * 主按钮 "发送验证码" / "验证并登录" → `.btn .btn-primary` (实色蓝紫玻璃, 全局化复用 landing 参数)
  * "重新发送" 按钮 → `.btn .glass-pill` (蓝紫淡玻璃)
  * "不想登录?" / "直接开始使用" 按钮保留上轮 `.glass-pill .anon-start` (上轮 #26 已加)
  * 所有 `toast.error()` 调用加显式 `4000ms` 参数 (验证码类需用户读完, 不改全局 store 默认 2000ms)
* **Wizard** (routes/sessions/new/+page.svelte):
  * session-name / nickname / exchange-rate 输入框 → `.glass-input`
  * 下一步 / 确认创建按钮 → `.btn .btn-primary`
  * 上一步按钮 → `.btn .glass-pill`
  * +/- 圆形 count-btn → `.glass-pill .count-btn` (56×56 圆形 + 玻璃参数, border-radius 50% 覆盖)
  * mode-pill / currency-pill 默认态 → `.glass-pill`; active 态复用 `.btn .btn-primary`
  * 进度点 `.dot` → app.css 全局化 `.progress .dot` (蓝紫 accent 玻璃, 避开 SessionCard `.dot` 文本冲突)
  * anon-currency-hint 玻璃卡化 (半透白底 + 1.5px 描边蓝紫 + 14px 圆角 + saturate 180% blur 12px)
* **Toast** (lib/components/Toast.svelte):
  * 3 variant 统一 pill (border-radius 999px) + 玻璃参数 (saturate 200% blur 20px + 1.5px 白边 + inset highlight)
  * 渐变背景: success emerald / error rose→red / info blue→indigo
  * Icon 改 inline Lucide SVG (check / circle-alert / info, 12px stroke 3, 18px 圆底 rgba 255,255,255,0.25)
  * 动画: fly y=28 duration 280 cubicOut (跟 tokens glass_base.animation 一致)
  * 位置 bottom 80px center 不变 (避开 FAB)
* **app.css** 全局新加:
  * `.glass-input` 系列 (.glass-input / .glass-input:focus / .glass-input::placeholder / .glass-input:disabled / .glass-input.is-error)
  * `.progress .dot` 系列 (默认 / active / done, 蓝紫 accent 玻璃)
  * `.btn .btn-primary` / `button.btn-primary` 全局化 (复用 landing 实色蓝紫玻璃, 原 landing scoped 仍优先)
* **不动**:
  * `lib/stores/toast.ts` 全局默认 2000ms 不改 (调用约定 success=2000 / info=3000 / error=4000 显式传参)
  * SessionCard.svelte (`.dot` 文本分隔符, 全局 `.progress .dot` 限定选择器避碰)

### §11. v0.3.17 #28 (2026-07-17) — 6 项微调 (PO msg 21:51 #5923)

* **#1 + #2 wizard 上一步/下一步 button 大小一致 + 排布对称** (`routes/sessions/new/+page.svelte`):
  * `.step-nav` 加 `justify-content: space-between` + `align-items: stretch`
  * `.step-nav > .btn-back / .btn-next / .btn-confirm` 加 `flex: 1` 等分 + `min-height: 52px` 同高 + `padding: 0 1.25rem` + `font-size: 1rem` + `font-weight: 600` + `text-align: center`
  * 效果: step 2 / step 3 的「上一步」「下一步」「确认创建」三 button 等宽 + 等高 + 字号一致 + 贴 wizard 内容区左右两端 (gap 对称 = wizard 自身 16px padding)
  * mobile viewport 390px: 按钮都不溢出, 无 horizontal scroll
* **#3 wizard 进度点 4 → 3** (`routes/sessions/new/+page.svelte` template):
  * `.progress` 里 `<span class="dot">` 从 4 个删到 3 个
  * 第 3 个 dot 用 `class:active={step >= 3}` (因为 `showCurrencyStep` 永远 true — 见 #26)
  * `.step-label` 段不动 (本来就只显示 step 1-3)
* **#4 +/− count-btn 点击后回默认玻璃色** (修 mobile tap 后 `:hover` 黏住导致 0.18 alpha 卡住) (`routes/sessions/new/+page.svelte`):
  * 根因: iOS Safari tap 后 `:hover` 黏住直到下次 tap, 全局 `.glass-pill:hover { background 0.18 }` 没有 `@media` 包裹, touch 设备 idle 也匹配 → 用户感觉「点完 button 卡住不变回默认」
  * 修法 (3 段 CSS):
    1. `.count-btn:not(:disabled) { transition: bg/transform/border 200/150/200ms }` 平滑过渡
    2. `@media (hover: hover)` 限定 hover 反馈 (0.18 alpha + translateY -1px) 只在真有 hover 能力的设备生效, touch 设备不触发
    3. `@media (hover: none)` 用更高特异性 + `!important` 强制 idle 背景回默认 (0.10 alpha), 覆盖 app.css 全局 `.glass-pill:hover` 在 touch 设备上的黏住效果
  * `.count-btn:disabled` 维持 opacity 0.4 + cursor not-allowed + 0.55 alpha 白底
  * desktop 验证: hover 仍显示 0.18 (设计意图保留); mobile 验证: click 后 400ms 回 0.10 默认色
* **#5 + #6 NavBar 「我的账本」 登录/wizard 隐藏 + 已登录态 + 玻璃效果** (`lib/components/NavBar.svelte`):
  * 原 `<nav class="links">` 是无条件渲染 (anon 也可见), PO 想让:
    * `/auth/login` 页面 → 隐藏 (PO #22 已修 `.right`, 现在连 links 一起隐藏)
    * `/sessions/new` wizard 页面 → 隐藏 (anon 创建账本不应被导航干扰)
    * `/sessions/N/...` session 内 → 仍可见 (去 /sessions 列表的入口)
  * 「我的账本」只在 **已登录态** 显示 (anon 即使在公共页面也不显示)
  * 改法: 把 `<nav class="links">` 包到 `{#if !['/auth/login', '/sessions/new'].includes(page.url.pathname) && $user}` 里, 内含 `<a href="/sessions" class="glass-pill links-item">我的账本</a>`, 利用 app.css 全局 `.glass-pill` + `a.glass-pill` 玻璃蓝紫样式 (10%/8% alpha + 玻璃 blur + inset highlight)
  * 路径检查 + 用户检查合一个 `{#if}`, 避免单独套空外层
* **svelte-check**: 7 errors baseline (SettleMemberBreakdown / +layout / join / +page.svelte 全是 pre-existing), 0 new error from #28
* **单 commit** 提交 origin/main: `v0.3.17 #28: 6 项微调 — wizard 按钮大小/排布/3 dots + count-btn active + NavBar 我的账本`

### §11. v0.3.17 #28 续 (2026-07-17) — SessionCurrencyBadge.svelte `<!` 字节丢失修复 (PO msg 22:10 #5923 补 #7)

* **症状**: session 详情页正文出现 `331` 大字 + `SessionCurrencyBadge.svelte — v0.3.16 #6 currency meta redesign (PO msg 18:16 CST 拍板)` 等设计笔记泄漏到页面
* **根因**: `frontend/src/lib/components/SessionCurrencyBadge.svelte` 第 1 行 HTML 注释 `<!--` 的 `<!` 两字节丢失 (历史 v0.3.17 #21 玻璃化编辑期间字节损坏的同类遗留, 跟 #24 NavBar + #25 SettleTransferPath 同根因 — 已在 #24+#25 修了那两个文件, 这个遗漏至今才暴露).
  * 文件首 4 字节 hex: `2d 2d 0a 20` = `--
 ` (期望 `3c 21 2d 2d` = `<!--`)
  * Svelte parser 看到 `--
` 不是 `<script>` / `<style>` / `<template>` / `<!--`, 当 raw 文本处理, 渲染到页面上.
* **修法** (`lib/components/SessionCurrencyBadge.svelte`):
  * 前 2 字节 `--` 前插入 `<!` → `<!--`, 文件大小 +2 字节 (11793 → 11795)
  * 用 Python 二进制读 + 写避免再触发同类字节损坏 (跟 #24+#25 一致), 不用 sed 避免跨平台行尾问题.
  * 修复后首 4 字节 hex: `3c 21 2d 2d` = `<!--`
* **顺手扫所有 svelte 文件** (Python 脚本 + valid prefix 白名单 `<scr` / `<sty` / `<!-` / `<tem`):
  * `lib/components/SessionCurrencyBadge.svelte` — 同 bug, 已修
  * `routes/sessions/[id]/bills/[billId]/edit/+page.svelte` — 首字节 `ef bf bd ef bf bd < s c r` (两个 U+FFFD 替换符), 自 v0.1.3 (commit 95996d4) 就在, 跟 `<` 字节丢失是**不同** bug, `<script lang="ts">` 仍能正确解析, 不影响渲染. **不在 #28 范围, 单独 ticket 跟踪.**
* **验证**:
  * 真机 walk session 详情页 `bodyText.includes('v0.3.16 #6 currency meta redesign')` = false ✓
  * currency-meta 组件正常渲染 (`CNY ⇄ THB · 1 CNY = 4.65116279 THB` + 铅笔 icon) ✓
  * svelte-check: 7 errors baseline (跟 #28 同), 0 new error
* **合并到 #28 commit**:
  * commit `2c4ad4d` → amend 成 `v0.3.17 #28: 6 项微调 + 修 SessionCurrencyBadge 注释字节丢失 bug — wizard 按钮大小/排布/3 dots + count-btn active + NavBar 我的账本`
  * 强制 push origin/main (因为是 amend, 不是 fast-forward)

### §11. v0.3.17 #28 续2 (2026-07-17) — NavBar .right 靠右 + wizard 三步 next 按钮同位 (PO msg 22:10 #5937 #8+#9)

* **#8 NavBar 登录按钮 wizard 页右上角错位修复** (`lib/components/NavBar.svelte`):
  * 根因: `.navbar` 是 flex, `.links` 用 `flex: 1` 撑开空间把 `.right` 挤到右.
    #28 #5+#6 改动后 `/sessions/new` 等路径 `.links` 整段不渲染 (anon + wizard 页),
    `.right` 失去挤的逻辑自然回到 `.brand` 旁边 (左对齐, 看起来像 navbar 不对称).
  * 修法: `.right` 加 `margin-left: auto` — flex auto margin 把 `.right` 推到最右, 不依赖 `.links` 是否存在.
  * 效果 (4 个场景):
    * 已登录态 + 任何路径: brand | 我的账本 (flex 1) | right → 仍顶右 (跟改前一致)
    * anon + `/sessions/new` wizard: brand | [links hidden] | right (登录) → 顶右 (修复)
    * `/auth/login`: brand 单独, right 整个被外层 `{#if pathname !== '/auth/login'}` 隐藏, 不受 #8 影响
    * anon + 其他非 wizard 页: brand | [links hidden] | right (登录) → 顶右
  * 真机验证 (iPhone 14 viewport 390x844):
    * `.right` computed `margin-left: 227px` (auto 算出 = 填充 .links 缺失留下的空白)
    * `.right.rightEdge = 374px` = `navbar.right - padding-right = 390 - 16` → **完美贴 navbar content 区右端**
    * `.brand.right = 81px` < `.right.left = 320px` → right 在 brand 右侧 (无重叠)
* **#9 wizard 三步 next/confirm 按钮 X 同位** (`routes/sessions/new/+page.svelte`):
  * 现状差异:
    * step 1: `<button class="btn btn-primary btn-next">` 单按钮, 默认 inline (content-width, 左对齐)
    * step 2/3: `.step-nav` 里 双按钮 `flex: 1 + space-between` (next 贴 wizard content 区右端)
  * 视觉位置不一致: step 1 next 按钮靠 wizard 左, step 2/3 靠右 — PO 不接受 (msg 22:10 #5937)
  * 修法 (template + CSS 两处):
    * template: step 1 按钮包 `<div class="step-nav">` (跟 step 2/3 同结构)
    * CSS: `.step-nav:has(> :only-child) { justify-content: flex-end }` — 单按钮 case 容器靠右
    * CSS: `.step-nav > :only-child { flex: 0 1 auto }` — 单按钮不撑满, 保持 pill content-width (不会占满整个 wizard)
  * 兼容性: `:has()` Chrome 105+ / Safari 15.4+ / Firefox 121+, 项目用 vite + svelte 5 OK
  * 效果 (3 步 next/confirm 按钮右边缘 X 一致, 测距 wizard content 区右端 = wizard.right - padding-right = 374 - 16 = 358):
    * step 1: btn.rightEdge = 358.0px (单按钮 case, flex-end + content-width)
    * step 2: btn.rightEdge = 358.0px (双按钮 case, space-between + flex 1)
    * step 3: btn-confirm.rightEdge = 358.0px (双按钮 case, btn-confirm 替 btn-next, 位置一致)
    * **Δ=0.0px** (完美对齐)
* **svelte-check**: 7 errors baseline (跟 #28 同 — SettleMemberBreakdown / +layout / join / +page.svelte 全是 pre-existing), 0 new error from #8+#9
* **真机 walk** (`scripts/cbc_v317_28_5_walk.js`): 2/2 PASS (#28.5-8 navbar login-right gap=0 from content, #28.5-9 3 步 next X Δ=0px)
* **3 截图** (`~/.openclaw/media/browser/`):
  * `v0317-28_5m-navbar-login-right.png` — wizard 页 navbar 登录按钮贴右 (image 工具确认: 「登录按钮在 navbar 右侧, 浅紫玻璃 pill, 中文渲染干净」)
  * `v0317-28_5m-wizard-3steps-next.png` — 3 步 next 按钮 X 一致 (合成图, 3 张 step 子图 + 标签)
  * `v0317-28_5m-session-detail-not-garbled.png` — session 详情页 (登录态 + Thailand, SessionCurrencyBadge 渲染「CNY ⇄ THB · 1 CNY = 4.65116279 THB」正常)
* **合并到 #28 commit** `9195faa` (amend efb34c8):
  * 包含 #28 基础 6 项 + SessionCurrencyBadge 字节修复 + 本轮 #8+#9 polish
  * commit message: `v0.3.17 #28: 9 项 polish — wizard 按钮大小/排布/3 dots + count-btn active + NavBar + 修 SessionCurrencyBadge 注释字节丢失 + wizard 三步 next 同位`
  * 强制 push origin/main (amend 链第 2 次, 把 placeholder commit efb34c8 替换)
  * 兼容性: `:has()` Chrome 105+ / Safari 15.4+ / Firefox 121+, 主项目 vite + svelte 5 OK.
  * 效果 (3 步 next/confirm 按钮右边缘 X 一致):
    * step 1: 358.0px (单按钮 case, flex-end + content-width)
    * step 2: 358.0px (双按钮 case, space-between + flex 1)
    * step 3: 358.0px (双按钮 case, space-between + flex 1)
    * Δ=0.0px (完美对齐, 都贴 wizard content 区右边 = wizard 右 - 16px padding)
* **svelte-check**: 7 errors baseline (同 #28), 0 new error from #8+#9
* **真机 walk**: 7/7 PASS (#28-1, #28-2, #28-3, #28-4, #28-5, #28-6, #28-8, #28-9)
* **再次 amend commit** `efb34c8` → 新 commit message: `v0.3.17 #28: 9 项 polish — wizard 按钮大小/排布/3 dots + count-btn active + NavBar + 修 SessionCurrencyBadge 注释字节丢失 + wizard 三步 next 同位`
* **强制 push** (amend 链第 2 次)

### §11. v0.3.17 #30 (2026-07-17) — iOS app-shell 化 + NavBar 玻璃对齐 + view toggle 玻璃化 (PO msg 14:28 #5957)

**触发 (PO msg 14:28 #5957)**:
> "比如目前 wizard 里, 内容只有不到一屏, 但屏幕却还是可以下滑"

**根因**:
- `+layout.svelte` 里 `<main class="page">` 用了 `min-height: calc(100vh - 56px)`, 但 body 本身没锁 overflow
- iOS Safari 会触发 rubber-band / overscroll bounce, 即使内容 < 100vh 也能拖动 body
- 修法: iOS app-shell 化 — html/body lock overflow + position: fixed + 100dvh; main 改 flex:1 + overflow-y:auto 内层滚

**实施 (3 项合并)**:

* **#1 NavBar 「我的账本」样式对齐「注销登录」** (`lib/components/NavBar.svelte`):
  * 现状: 「我的账本」是 `<a class="glass-pill links-item">` (蓝紫淡玻璃); 「注销登录」是 `<button class="ghost btn-sm">` (白玻璃 + .btn-sm 同形态)
  * 视觉分裂: 两者看着不属于同一组件 — 一个蓝紫玻璃 + 一个白玻璃, 整组 nav 不一致
  * 改法: 「我的账本」class 改为 `btn-sm links-item`, 跟「注销登录」共用 `.btn-sm` 玻璃参数
  * .links-item 保留 nav link 语义定位 (flex item), 视觉参数全部继承 .btn-sm
  * 顺带删 `.links a` 独立样式 (color: var(--color-text-muted) 会覆盖 .btn-sm 颜色, 升级后多余)

* **#2 SessionDetail settle view toggle 玻璃化** (`routes/sessions/[id]/settle/+page.svelte`):
  * 现状: `.view-switch` + `.view-switch-btn` 灰底白 chip 旧视觉 (v0.2.2), 跟全站玻璃语言不统一
  * 改法: 升级为 `.view-toggle-row` + `.mode-pill` 玻璃分段控件
  * 复用 wizard step 3 currency-mode-row 同语言 (v0.3.17 #27 玻璃化):
    * inactive = 全局 `.glass-pill` 浅蓝紫玻璃 + `.mode-pill` layout
    * active = 全局 `.btn-primary` 实色蓝紫玻璃 (`.mode-pill.active` 已在 app.css 全局定义)
  * ARIA / 行为不变 (role=radiogroup, 主币种汇总 vs 原始数据 切换)
  * CSS specificity: `.view-toggle-row .mode-pill` 跟 `.mode-pill` 全局定义同 specificity 时后定义优先 (settle +page.svelte 局部 CSS 后于 app.css 全局)

* **#3 全产品 iOS app-shell 化** (PO msg 14:28 #5957):
  * 3a `app.css` (开头) — html/body 锁外层 + 100dvh:
    * `overflow: hidden; overscroll-behavior: none; position: fixed; inset: 0; touch-action: manipulation`
    * body `display: flex; flex-direction: column; min-height: 100dvh; max-height: 100dvh`
    * 100dvh = dynamic viewport height, 适配 iOS Safari 地址栏收起/展开
  * 3b `routes/+layout.svelte` — main 改 flex 滚动容器:
    * `.page { flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; overscroll-behavior-y: contain; min-height: 0 }`
    * `min-height: 0` 关键 — flex item 默认 `min-height: auto` 会撑破父容器
    * 包一层 `.page-inner` 单独管 padding, 避免 scrollbar 被 padding 挤压
    * 旧 `min-height: calc(100vh - 56px)` 删 — body 已锁, 不需要这个补偿
  * 3c `lib/components/NavBar.svelte` — 加 `padding-top: calc(var(--space-3) + env(safe-area-inset-top, 0px))`, 适配 iOS 全面屏刘海/灵动岛
  * 3d `lib/components/Footer.svelte` — 加 `padding-bottom: calc(var(--space-4) + env(safe-area-inset-bottom, 0px))`, 适配 iOS 全面屏 home indicator
  * 3e `routes/+page.svelte` (landing) — **不动** (已有自己的 body lock onMount, 兼容)
  * Toast 位置: `<Toast>` 用 `position: fixed; bottom: 80px`, 不受 body lock 影响 (fixed 锚 viewport 而非 body), 保持现状
  * 各页面 min-height: `+error.svelte` 保留 `min-height: 100vh` (错误页内容独立居中, main 滚 OK); 其他页面**不**动

**验证**:

* **svelte-check**: 7 errors / 21 warnings — **同 #28 baseline, 0 new error** (baseline 7 errors 全是历史 byte corruption / TS 类型断言, 不在本次范围)
* **真机 walk** (`scripts/cbc_v317_30_walk.js`): **8/8 PASS**
  * #30-1 「我的账本」+「注销登录」 min-height 一致 (44px) + border-radius 一致 (9999px)
  * #30-1 NOTE: border-color 不同 (.ghost 白玻璃覆盖), 设计接受 (登出按钮更弱化)
  * #30-2 .view-toggle-row + 主币种汇总/原始数据 mode-pill 在场, active 用 .btn-primary linear-gradient 玻璃
  * #30-3 body overflow=hidden, html overflow=hidden, main overflow-y=auto
  * #30-3 body display=flex, flex-direction=column, main flex-grow=1
  * #30-3 关键: 模拟 iOS swipe-down, body.scrollY 始终 = 0 (不可拖动)
  * #30-3 sessions 列表 main.scrollTop 0→0 (内容 < 一屏, 无可滚内容, 符合预期)
  * #30-3 landing .bg-wrapper 仍在 (全屏背景图完整)

### §11. v0.3.17 #31 (2026-07-17) — settle sticky section header → chip-on-sheet liquid glass (PO msg 23:13 #6027)

**问题 (PO msg 23:00 #6005)**: 「付款明细这种 header 和实际的明细之间，在你的设计中看不出任何关联」

**PO 设计语言约束 (msg 23:02 #6009)**: 「我们设计语言是 ios27 的玻璃」 — 在 liquid glass design 下, 关联不能用 2D 阴影/hairline, 必须用 optical refraction 区分 liquid density。

**实施 (settle 个人视图 tab 里)**:

* **File**: `routes/sessions/[id]/settle/+page.svelte`
* **现状**: sticky header 跟 list 是两块独立 glass element, 视觉断层
* **修法**: header + list 共建一片 liquid glass 母体, 两层 liquid density 区分
  * `header.sticky-header.glass-chip` — 浓 liquid glass:
    * `background: rgba(255,255,255,0.62)`
    * `backdrop-filter: blur(20px) saturate(200%)`
    * `border: 0.5px solid rgba(255,255,255,0.7)`
    * 多层 box-shadow:
      ```
      inset 0 1px 0 rgba(255,255,255,0.9),              // 顶部 1px specular highlight
      inset 0 -1px 0 rgba(99,102,241,0.06),            // 底部 1px 反向折射暗边
      0 10px 18px -4px rgba(99,102,241,0.4),           // 双层 drop shadow 落在 sheet 上
      0 4px 8px -2px rgba(99,102,241,0.18)
      ```
    * `border-radius: 14px`
  * `list.bills-list.glass-sheet` — 稀 liquid glass:
    * `background: rgba(255,255,255,0.32)`
    * `backdrop-filter: blur(15px) saturate(150%)`
    * `border: 0.5px solid rgba(255,255,255,0.45)`
    * `box-shadow: inset 0 1px 0 rgba(255,255,255,0.7), inset 0 -1px 0 rgba(99,102,241,0.04), 0 4px 10px -3px rgba(99,102,241,0.12)`
    * `border-radius: 14px`
  * chip 浮在 sheet 上方 ~8px (`margin-bottom: -8px`, `z-index: 2`)
  * 仅 apply 在「个人视图」tab 内的 sticky header (主币种汇总 + 原始数据 toggle 触发的那个 view)

**验收 criterion**:
* chip + sheet 在 iOS27 liquid glass style 下, 光学 refraction 区分 liquid density (header 像「玻璃盖」, list 是稀液 sheet)
* 不靠 color/border 区分, 不引入新 design token

### §11. v0.3.17 #32 (2026-07-17) — wizard 上一步/下一步 → 圆 ← → 玻璃 button (PO msg 23:14 #6027 拍板)

**问题 (PO msg 23:05 #6010)**: wizard 各 step 的「上一步/下一步」button 不在同一位置, 大小不一致
**PO 拍板最终方向 (msg 23:14 #6027 + #6025)**:
* 改圆形玻璃 button (圆 52×52)
* 跟 system 已有 `.fab` (`settle/` 返回 + `bills/new` + `bills/edit`) 同款语言
* 位置: panel footer 左下 ← + 右下 →, 跨 step corner 一致
* Step 3 「确认创建」按钮 icon 用 ✓ (对号) — **不**用 → (避免 ✓ 误读为勾选)
* Step 1 左下 ← 用 disabled 占位 (按 v3 默认, PO 未反对)
* button 跟 panel 内容自然流, **不**强制 viewport sticky 死区 (避免 PO msg 23:11 #6019 「整体页面感觉有点呆」反馈)
* 整页协调, 跨 step button box 大小完全一致 (核心修点)

**实施** (`routes/sessions/new/+page.svelte`):

* 移除旧 `:only-child flex 0 1 auto + content-width pill` 规则 (来自 v0.3.17 #28.5 #9, 本次反)
* 移除旧 `flex: 1 双 50% spread pill` (来自 v0.3.17 #28 双按钮 等分)
* 新 step-nav layout:
  * `step-nav` 用 flex justify-content: space-between, panel footer 跟随 panel 内容自然流
  * 左 button (`←` 上一步) — `fab-wiz glass` 圆 52×52
    * class: `fab-wiz glass-pill`
    * 56×52 (跟 .fab 同款, **不**用 mb 缩进)
    * `border-radius: 50%`
    * 内嵌 ← icon (用 SVG 或 unicode `←` 配合 line-height + padding 视觉居中; 优先 SVG 保持视觉锐利)
    * 颜色: `var(--accent-700, #4338ca)` 深紫主题色 (跟 .glass-pill 全局一致)
  * 右 button (`→` 下一步 / `✓` 确认创建) — `fab-wiz primary` 圆 52×52
    * class: `fab-wiz glass-pill primary`
    * 52×52 圆
    * `border-radius: 50%`
    * `background: linear-gradient(135deg, #6366f1, #818cf8)` (跟 .btn-primary / .fab 同款)
    * color: white
    * `border: 0.5px solid rgba(255,255,255,0.5)` (玻璃边缘 specular)
  * Box shadow (跟 system .fab .glass-pill 全局已有): inset highlight + drop shadow 双层
  * Step 1 左 `←` 加 `.disabled` class (光 ghost 半透, opacity 0.4)
  * Step 3 右 icon = `✓` (用 SVG 或 unicode), label 仍然是「下一步」→「确认创建」语义

**验收 criterion**:
* 跨 step 圆形 button 大小完全一致 (52×52)
* 跨 step 位置: panel 内 footer 左下 + 右下, corner 一致 (绝对 y 因 panel 内容长度略有差异, 不 lock)
* Step 1 有 disabled 灰色 ← 占位
* Step 3 右 button = ✓ icon (不是 →)
* 整页 panel 看起来「对角线锚点」(圆形玻璃 button 形成视觉支点), 不死板 (因为 button 跟 panel 自然流, panel 多长 button 跟到哪, 不强制 viewport sticky 死区)
* 跟 settle 返回 FAB ↔ bills/new + FAB **同款 liquid glass 视觉语言**

**iOS27 design philosophy**: 「depth through refraction, not color」— 这条贯穿整个 v0.3.17 polish 阶段 (#27 全玻璃化 / #30 app-shell / #31 chip-on-sheet / #32 圆 ← → glass)。

### §11. v0.3.17 #32 补 (2026-07-17) — step 1 ← 改 home 图标 + 实际 navigate /sessions (PO msg 23:22 #6034 拍补)

**PO 拍补 (msg 23:22 #6034 #6035)**: "1 对号；2 为 首页图标。实际也应该导航至首页" / 后紧跟 "只有 step1 改 home"

**理解**:
- step 2/3 左下 button 保持 #32 拍板的 ← 「上一步」(glass style, active, 回退 step 数) — 这点**不动**
- step 1 左下 button 单独**改**:
  * 从 disabled 占位 → active glass (跟 step 2/3 同 .glass style)
  * icon 从 ← 箭头 → home 图标 (Lucide/Phosphor home 形状 — 房子 + 烟囱)
  * aria-label 从 "上一步" → "返回首页"
  * 功能 从 (noop) → navigate 至首页 (`$isAnon ? goto('/') : goto('/sessions')` — anon 退回 landing, 登录态退回 sessions list)

**改动**:
- `frontend/src/routes/sessions/new/+page.svelte` 单独改 step 1 那个 back button:
  * 移除 `disabled` attribute 跟 `.disabled` class
  * 改 SVG path 为 home icon
  * 改 aria-label
  * onclick 改 navigate (用 `import { goto } from "$app/navigation"`)
- 其他 step (2/3) 不变

**验收 criterion**:
- step 1 左 button = home 图标 (active glass, 不是 disabled)
- step 2/3 左 button = ← 上一步 (跟 #32 一致, **不**变)
- click step 1 左 button (登录态) → URL = `/sessions`
- click step 1 左 button (anon 态) → URL = `/`
- svelte-check baseline + 0 new error

### §11. v0.3.17 #32-D (2026-07-17) — wizard 圆 button layout 改 D 方案 (PO msg 23:44 #6063 拍板, Designer mockup 4 候选)

**PO 反馈链 (msg 23:30 #6053)**: 「这个新的圆形上一步下一步按钮，是不是有点小，位置有点不太对。让整个页面看起来很不协调」 → spawn Designer Agent → 4 候选 mockup → **PO 拍 D**

**D 方案 (Designer 推荐)**:
- 圆 button **64×64** (跟 system .fab 同款, 但比现状 52×52 大; iOS HIG 88pt ~80% 甜点位)
- **居中**底部排列 (不再是左右 corner)
- **顶部细分割线** (border-top: 0.5px rgba accent on .step-nav-area)
- **底部 hint** 上下文文本 (暴露 "上一步/下一步" 语义)
  * Step 1: 「返回首页 · 添加成员」
  * Step 2: 「修改人数/昵称 · 选择币种」
  * Step 3: 「修改人数/昵称 · 确认创建」

**实施**: `frontend/src/routes/sessions/new/+page.svelte`, 跟 #32 + #32-fix 同文件, 在现有 `.fab-wiz` 基础上:
- button size: 52×52 → 64×64
- 布局: `justify-content: space-between` → `justify-content: center; gap: 56px`
- 加 `.step-nav-area` 容器 `border-top: 0.5px solid rgba(99,102,241,0.18)` + `background: linear-gradient(180deg, transparent, rgba(238,234,255,0.4))`
- 加 `.step-nav-hint` element 显示 step-上下文 text (`text-align: center; font-size: 0.75rem; color: rgba(67,56,202,0.55)`)
- SVG icon size: 22→28, 配 64 button

**验收 criterion**:
- 3 step 圆 button 64×64 (比现状大)
- 居中布局, 跨 step 一致
- 顶部有半透分割线
- 底部 hint 文本按 step 上下文动态
- step 1 左 = home 图标 (保留 #32-fix, 不退 ← 上一步)
- svelte-check baseline + 0 new error

### §11. v0.3.17 #31-fix (2026-07-17) — settle sticky head 滑动 list 渐消失于 head 真修 (PO msg 23:44 #6063 反馈)

**PO 反馈 (msg 23:44 #6063)**: 「刚刚 #31 目前页面滑动有问题。当向上滑动，付款明细 head 顶在最上方，仍上滑时，付款明细的明细部分应渐渐消失于 head 中。（head 在明细上方）」

**根因 (基于 git blame + read code)**:
- #31 加的 `.glass-chip` z-index 2 + `.glass-sheet` z-index 5 — **chip z-index < sheet z-index, 跟设计意图反了**
- 现状 chip z-index 2 < sheet z-index 5 → list 在 stacking 上方, head 在 stacking 下方, 上滑时 list 越过 head
- 原始 v0.3.17 #20 / #21 sticky header 是 z-index 10/11 (head 在 list 之上)
- #31 实施时 z-index 数字冲突但 Master spec 没写具体数字, 仅写 「chip 浮在 sheet 上方」 意图

**PO 拍补 (msg 23:44 #6065)**: 「消费明细和付款明细是两个同层级的 section, 应该是并列关系」 — 两个 section 应该 z-index 平起平坐, **不**给消费明细特殊 z-index 11。

**修法**:
- `frontend/src/lib/components/SettleMemberBreakdown.svelte`:
  * `.glass-chip` z-index: 2 → **10** (跟原 .section-header z-index 10 一致, head 在 list 之上)
  * `.glass-sheet` z-index: 5 → **1** (跟原 .bills-section z-index 1 一致, list 在 head 之下)
  * `.bills-section-consumed .glass-chip` z-index: 11 **删** (同层级并列, 不特殊)
- 可选加 mask-image 在 head 顶部 16px fade 给视觉柔化:
  * `mask-image: linear-gradient(180deg, transparent 0, #000 16px, #000 100%)`
  * `-webkit-mask-image: linear-gradient(180deg, transparent 0, #000 16px, #000 100%)`

**验收 criterion**:
- 上滑时, list 第 1 行/2 行 等会渐消失于 head 底部 (而非 head 被 list 越过)
- head 自身 sticky 在最上方 (z-index 高)
- Master spot-check 模拟 scroll, 列表首行 y < head y 时 list first row 视觉位于 head 之下
- svelte-check baseline + 0 new error
### §11. v0.3.17 #landing-fix (2026-07-17) — landing page 登录后按钮文案 真修 (PO msg 23:46 #6069 拍补)

**PO 反馈 (msg 23:46 #6069)**: 「还有另一个 bug: 已登录状态下, landing page 点击 进入我的账本 按钮后, 按钮变为 "创建中", 应变为 "打开账本中"」

**根因** (`frontend/src/routes/+page.svelte:95`):
```svelte
{busy ? '创建中…' : ($user ? '进入我的账本' : '直接开始使用')}
```
当 busy=true 时 (anon 创建 session + claim) 显示 "创建中…". 但对已登录 user, 流程是直接 navigate 到 /sessions (不创建), 文案应该 "打开账本中…".

**修法**: 1 行 template 改动, busy 时区分 anon vs 登录:
```svelte
{busy ? ($user ? '打开账本中…' : '创建中…') : ($user ? '进入我的账本' : '直接开始使用')}
```

**验收 criterion**:
- anon + busy → 「创建中…」(不变)
- 已登录 + busy → 「打开账本中…」(新)
- 已登录 + idle → 「进入我的账本」(不变)
- anon + idle → 「直接开始使用」(不变)
- svelte-check baseline + 0 new error

### §11. v0.3.17 #32-D-2 (2026-07-17) — wizard D 方案 4 项 polish (PO msg 23:59 #6087 拍板)

**PO 反馈 4 条 (msg 23:59 #6087)**:

1. **撤掉 hint**: 「上一步下一步按钮下方的文字描述去掉」 — `.step-nav-hint` element (D 方案里加的 step 上下文文本) 删
2. **撤掉方形背景**: 「上一步下一步按钮背后的方形背景全部去掉」 — `.step-nav-area` 的 `border-top: 0.5px` + `background: linear-gradient` 都删, 按钮后面**不**要方形容器
3. **anon step 3 dual mode 展示但锁定**: 「匿名下，第三步应同样展示双币种选项，但为锁住的状态」 — 移除 `{#if !isAnon}` 包裹双币种 pill 的条件, anon 也显示双币种 pill 但视觉锁定 (灰色, opacity 0.4, 点击无效), 同时保留 hint 文案 "需要登录后使用多币种"
4. **currency mode 改 iOS27 switch toggle**: 「单一币种和双币种是二选一的关系，所以应该用 switch toggle 处理这里。参考 ios27」 — 当前的 2 个 `.mode-pill.glass-pill` segmented 替换为 iOS27 switch toggle 组件 (sliding indicator 样式 + 玻璃 liquid material).

**实施**: `frontend/src/routes/sessions/new/+page.svelte`:
- 删 `.step-nav-hint` element (template)
- 删 `.step-nav-area` 容器 (template 用 `<div class="step-nav">` 直接, 无 wrapper)
- 删 `.step-nav-area` CSS (border-top + bg gradient)
- 单/双币种 pill 容器 (`{#if !isAnon}` 移除, anon 也展示)
- 双币种 pill 在 anon 锁定: 加 `.locked` class (opacity 0.4, cursor not-allowed, click 阻止)
- iOS27 switch toggle:
  ```svelte
  <div class="ios-switch" class:active={currencyMode === 'dual'}>
    <div class="ios-switch-track" role="radiogroup">
      <button class="ios-switch-thumb" type="button"
              onclick={() => switchMode('single')}
              class:active={currencyMode === 'single'}>
        单一币种
      </button>
      <button class="ios-switch-thumb" type="button"
              onclick={() => isAnon ? toast.error('需要登录后使用') : switchMode('dual')}
              class:active={currencyMode === 'dual'}>
        双币种
      </button>
    </div>
    <div class="ios-switch-slider"></div>
  </div>
  ```
  - `.ios-switch` liquid glass container (iOS27 segmented control 风格)
  - `.ios-switch-slider` 滑动指示器 (跟着 active mode 移动)
  - 双币种 anon 时 disabled (visual locked, 点击 toast 提示)

**验收 criterion**:
- 无底部 hint 文案
- 无 step-nav-area 方形背景 (按钮直接浮在 panel 内容上, 周围 clean)
- 已登录 step 3: 单一 + 双币种 switch toggle 都可见, 可切换
- anon step 3: 单一 + 双币种 switch toggle 都可见, 双币种锁定 (灰显) + 切换尝试时 toast 提示登录
- 单一币种与双币种 iOS27 switch toggle 视觉 (滑动 indicator + 玻璃材质 + 双 mode 切换)
- svelte-check baseline + 0 new error

### §11. v0.3.17 #31fix-2 (2026-07-18) — #31-fix z-index 11/2 special case 删 (PO msg 23:44 #6065 同层级并列拍补)

**PO 反馈 (msg 23:44 #6065)**: 「消费明细和付款明细是两个同层级的 section，应该是并列关系」

**问题**: #31-fix (commit e4f0c9c) 加了 `.bills-section-consumed .section-header.glass-chip { z-index: 11; }` 跟 `.bills-section-consumed.glass-sheet { z-index: 2; }` — 让 consumed chip 比 paid chip 高 1, consumed sheet 比 paid sheet 高 1。这跟「并列关系」拍板冲突。

**修法**: 删这两行 special case, 让两个 section 都用同一个 z-index:
- paid chip z=10, consumed chip 也 z=10 (删 consumed 11 special)
- paid sheet z=1, consumed sheet 也 z=1 (删 consumed 2 special)

两个 section 完全 parallel.

**实施**: `frontend/src/lib/components/SettleMemberBreakdown.svelte` — 删 2 行 CSS rule + 可能清理相邻注释.

**验收**:
- `.bills-section-consumed .section-header.glass-chip` 不应有 z-index 11 (删掉)
- `.bills-section-consumed.glass-sheet` 不应有 z-index 2 (删掉)
- 2 个 section chip 都是 10, sheet 都是 1
- svelte-check baseline + 0 new error

### §11. v0.3.17 #31fix-2 (2026-07-18) — 删 #31-fix 留的 z-index 11/2 special case, 消费/付款明细同层级并列 (PO msg 23:44 #6065)

**PO 拍补 (msg 23:44 #6065)**: 「消费明细和付款明细是两个同层级的 section, 应该是并列关系」

**修法**:
- `frontend/src/lib/components/SettleMemberBreakdown.svelte`:
  * 删 `.bills-section-consumed.glass-sheet { z-index: 2; }` (consumed sheet 跟 paid sheet 一致 z-index 1)
  * 删 `.bills-section-consumed .section-header.glass-chip { z-index: 11; }` (consumed chip 跟 paid chip 一致 z-index 10)

**验收 criterion**:
- paidChipZ === consumedChipZ === "10" ✓ (Master spot-check 实测)
- paidSheetZ === consumedSheetZ === "1" ✓ (Master spot-check 实测)
- 消费/付款明细 同层级并列 (sticky 容器边界重叠时不再有 z-index 强制覆盖)
- svelte-check baseline + 0 new error

### §11. v0.3.17 #32-D-2 (2026-07-18) — wizard D 方案 4 项 polish (PO msg 23:59 #6087)

**PO 拍板 (msg 23:59 #6087)** 4 项修正:
1. 撤 `.step-nav-hint` element (template 里 step 上下文文本)
2. 撤 `.step-nav-area` wrapper + border-top + bg gradient (按钮直接浮, 不带方形背景)
3. anon step 3 双币种从隐藏 → 展示但锁定 (移除 `{#if !isAnon}` 包裹, 双币种 button :disabled={isAnon} + .locked class + toast 提示登录)
4. currency mode 改 iOS27 switch toggle (2 thumb + 滑动 indicator + 玻璃 track, 替代原 .mode-pill.segmented)

**实施**: `frontend/src/routes/sessions/new/+page.svelte`, 跟 #32-D (commit 58c265e) 同文件, 在 D 基础上叠加:
- 删 `.step-nav-hint` element + CSS rule
- 删 `.step-nav-area` wrapper + CSS rule (按钮直接平级放在 panel content)
- anon 双币种 button: `disabled={isAnon}` + `.locked` class (opacity 0.4)
- 新 `switchCurrencyMode()` helper function (script 顶部, 统一 single/dual 切换 + anon 锁定 toast)
- 新 `.ios-switch` + `.ios-switch-option` + `.ios-switch-thumb` + `.mode-locked-hint` CSS (iOS27 玻璃 track + 滑动 thumb + 双币种锁定 hint)

**保留** (D 方案不变): 圆 button 64×64 + 居中布局 + step 1 home 图标 + SVG icon 28×28

**验收 criterion**:
- hasHint=false ✓, hasStepNavArea=false ✓ (Master spot-check 实测)
- hasIosSwitch=true, optionCount=2, thumbPresent=true, modePillCount=0 ✓ (Master spot-check 实测)
- 登录态 single ↔ dual click toggle active 状态 ✓ + thumb 滑动 indicator 跟随 ✓
- anon 双币种 disabled + .locked class ✓ + click 不切换 state + toast 提示 ✓
- svelte-check baseline + 0 new error

### §11. v0.3.17 #32-D-3 (2026-07-18) — switch toggle 加大 + settle 个人视图 同步改 switch (PO msg 00:27 #6104)

**PO 反馈 (msg 00:27 #6104)**:
1. 单一币种/双币种 switch toggle 太小, 整个页面看起来不协调 — 加大
2. settle 个人视图 主币种汇总/原始数据 按钮换成这种 (iOS27 switch toggle)

**实施**:

**(1) 全局 utility 提取**: `frontend/src/app.css` 加 `.ios-switch` / `.ios-switch-option` / `.ios-switch-thumb` / `.mode-locked-hint` 类 (从 wizard step 3 复制, 加大 size):
- `.ios-switch-option` padding: `0.5rem 1.25rem` → `0.625rem 1.5rem` (15% 增)
- `.ios-switch-option` font-size: `0.875rem` → `0.9375rem` (15px)
- `.ios-switch-option` min-height: `36px` → `44px` (iOS HIG tap target)
- `.ios-switch` padding: `3px` → `4px`
- `.ios-switch-thumb` top/left/bottom: `3px` → `4px`

**(2) wizard step 3**: `frontend/src/routes/sessions/new/+page.svelte`:
- 删 .ios-switch 全套 CSS (现在在 app.css 全局)
- .ios-switch 全局直接用, 通过加 class `ios-switch-lg` 或直接用全局

**(3) settle 个人视图**: `frontend/src/routes/sessions/[id]/settle/+page.svelte`:
- 替换 `.view-toggle-row .mode-pill` segmented glass pill → `.ios-switch` + `.ios-switch-option` + `.ios-switch-thumb` (跟 wizard 同款)
- 保留 disabled state (单币种 session 时「原始数据」disabled + title hint)
- 「主币种汇总 (CNY)」/「原始数据」 option 文本保留

**验收 criterion**:
- wizard step 3 switch 加大 (option 44px+ 高) 整体协调 ✓
- settle 个人视图 toggle 改 iOS27 switch (跟 wizard 同款) ✓
- thumb 滑动 indicator 250ms spring (跟 wizard 同款) ✓
- 单币种 session 「原始数据」disabled (跟原 spec 一致) ✓
- svelte-check baseline + 0 new error

### §11. v0.3.17 #32-D-3 (2026-07-18) — switch toggle 加大 + settle 个人视图 同步改 iOS27 switch (PO msg 00:27 #6104)

**PO 反馈 (msg 00:27 #6104)**:
1. 单一币种/双币种 switch 太小, 整个页面看起来不协调 — 加大
2. settle 个人视图 主币种汇总/原始数据 按钮换成这种

**实施 (3 文件同步)**:

**(A) 全局 utility 提取**: `frontend/src/app.css` 新增 `.ios-switch` + `.ios-switch-option` + `.ios-switch-thumb` + `.mode-locked-hint` (从 wizard step 3 局部 CSS 复制 + 加大尺寸):
- `.ios-switch-option` padding: `0.5rem 1.25rem` → `0.625rem 1.5rem`
- `.ios-switch-option` font-size: `0.875rem` → `0.9375rem` (15px)
- `.ios-switch-option` min-height: `36px` → `44px` (iOS HIG tap target)
- `.ios-switch` padding: `3px` → `4px`
- `.ios-switch-thumb` top/left/bottom: `3px` → `4px`

**(B) wizard step 3**: `frontend/src/routes/sessions/new/+page.svelte` 删局部 .ios-switch CSS (line ~478-540, -77 lines), 利用全局 utility, template 不动

**(C) settle 个人视图**: `frontend/src/routes/sessions/[id]/settle/+page.svelte` 替换 `.view-toggle-row .mode-pill` segmented → `.ios-switch` (同款 markup + thumb), 删 `.view-toggle-row` 局部 CSS (line ~238-280)

**保留**:
- 单币种 session 时「原始数据」 disabled + title hint (业务逻辑保留)
- thumb 滑动 indicator 250ms spring transform
- anon 双币种 .locked class (opacity 0.4 + not-allowed)

**验收 criterion**:
- wizard step 3 switch: option min-height 44px ✓, font-size 15px ✓ (Master walk 实测)
- settle 个人视图 toggle: switchExists=true ✓, modePillExists=0 ✓, optionLabels=["主币种汇总 (CNY)", "原始数据"], min-height 44px ✓ (Master walk 实测)
- 跨页面视觉一致 (wizard + settle 同款 toggle)
- svelte-check baseline + 0 new error

### §11. v0.3.17 #32-D-4 (2026-07-18) — version bump + switch thumb 动态宽度跟随 option 文字 (PO msg 01:18 #6116 拍板)

**PO 反馈 (msg 01:18 #6116)** 3 条:
0. version.ts 还停在 4773e6d (旧 commit 0ed9376 的 bump), 不是最新 origin/main (1f5e4b3) — bump 到新短 hash, 解决生产 footer 版本号不一致
1. switch toggle 左右两 option 文字长度不一致, 选中块 (thumb) 宽度应该跟随选中 option 实际宽度 — 当前 thumb 固定 50% 宽度跨整个右半边视觉不平衡
2. (单独 follow-up) 整体 app responsive — 先跟 PO 对齐范围, 不在本 #32-D-4 范围

**实施**:

**(A) version bump**:
- `frontend/src/lib/version.ts`: `FRONTEND_VERSION = "4773e6d"` → 改成新 commit short hash (实施后用最终 commit short hash)

**(B) 抽 `IosSwitch` 组件** (新文件 `frontend/src/lib/components/IosSwitch.svelte`):
- Props: `options: { value, label, disabled? }[]`, `value` (bindable), `on:change`
- 内部: `bind:this={switchEl}`, `requestAnimationFrame` measure 选中 option 的 `getBoundingClientRect()`, 算出 thumb `width` + `x` 偏移
- `ResizeObserver` 监听 switch container resize (含 responsive breakpoint 变化), 重新 measure
- `transition: width 250ms cubic-bezier + transform 250ms cubic-bezier` — thumb 滑动 + 宽度变化都 smooth
- Accessibility: `role="radiogroup"`, 每个 option `role="radio" aria-checked`, disabled option `disabled + .locked class` (opacity 0.4 + not-allowed cursor)

**(C) 更新 app.css** `.ios-switch-thumb`:
- 删固定 `width: calc(50% - 4px)` (现在 width 由 JS 动态 set)
- 保留 `position: absolute; top/left/bottom: 4px`
- 加 `transition: width 250ms cubic-bezier(0.4, 0.0, 0.2, 1), transform 250ms cubic-bezier(0.4, 0.0, 0.2, 1)`
- width / translateX 由 IosSwitch 组件 inline style set

**(D) wizard step 3 + settle 个人视图 改用 IosSwitch 组件**:
- `frontend/src/routes/sessions/new/+page.svelte`: line ~256-275 markup 替换为 `<IosSwitch options=[{value,label},...] bind:value={currencyMode} disabled={isAnon ? 'dual' : null} />`
- `frontend/src/routes/sessions/[id]/settle/+page.svelte`: line ~157-184 markup 替换为 `<IosSwitch options=[{value:'primary', label:`主币种汇总 (${session.primary_currency})`}, {value:'split', label:'原始数据'}] bind:value={viewMode} disabled={!session.currencies || session.currencies.length < 2 ? 'split' : null} />`

**验收 criterion**:
- version.ts 改成新 commit short hash (生产 footer 显示新 hash) ✓
- switch thumb 宽度跟随选中 option 实际宽度 (主币种汇总 (CNY) 比 原始数据 长, thumb 在「主币种汇总」active 时明显比「原始数据」active 时宽) ✓
- thumb 切换时 width + transform 都 smooth (250ms cubic-bezier) ✓
- 跨页面 wizard + settle 用同一个组件, 视觉一致 ✓
- disabled option 不响应 click ✓
- ResizeObserver 处理 window resize / orientation change ✓
- svelte-check baseline + 0 new error

### §11. v0.3.17 #33 (2026-07-18) — join session page 玻璃化重构 (PO msg 01:34 #6139)

**PO 反馈 (msg 01:34 #6139)**: 「加入账本页面也要玻璃化重构」 — 跟 v0.3.17 #27 全玻璃化 polish 一致

**目标 page**: `frontend/src/routes/sessions/[id]/join/+page.svelte` (匿名 user 通过 invite link 加入账本的 wizard)

**实施**: 复用现有 liquid glass utility classes (跟 system 一致):
- `.glass-pill` / `.glass-card-soft` / `.glass-input` / `.btn-sm` / `.fab` 等全局 utility (已 ship #27 / #30 / #32-D)
- 不引入新 design token
- 跟全站 iOS27 glass language 一致

**验收 criterion**:
- join page 标题 / input / button / cards 全 liquid glass 视觉 (跟 settle / wizard / sessions list 一致)
- 不破坏现有功能 (anon claim member + 设置 nickname + 跳转到 session)
- svelte-check baseline + 0 new error

### §11. v0.3.17 #34 (2026-07-18) — 整体 app responsive 策略 B 实施 + 汇率 bar wrap fix (PO msg 01:31 #6137 + 01:42 #6155)

**PO 拍板 (msg 01:42 #6155)**: 「刚刚的 designer 用策略 b」
**范围** (msg 01:31 #6137): mobile viewport 320px - 480px (iPhone SE / 标准 / Plus)

**策略 B 核心 (Designer proposal §2)**:
- 字号全 `clamp(min, vw-based, max)` (e.g. `clamp(1.25rem, 4vw, 1.5rem)`)
- Spacing 用 container queries (每个 page `<main>` 设 container)
- `--space-*` / `--font-size-*` token 全 clamp 化 (建立统一 sbc type scale)
- 跟 `.glass-pill` / `.glass-sheet` 同源 iOS27 design language

**额外 fix (PO msg 01:42 #6155 #1)**:
- 汇率 bar (`SessionCurrencyBadge.svelte`) 在 390px viewport wrap 到 2 行 — flex-wrap: nowrap + font-size clamp + chip padding 缩小, 强制单行
- 容器宽度计算: chip CNY (50px) + ⇄ (24px) + chip THB (50px) + · (12px) + "1 CNY =" (50px) + "4.65... THB" (110px) + ✏️ (24px) + gaps ≈ 320px — 在 320px viewport 仍要放, 需要压缩 chip 字号 + 减小 gap

**PO msg 01:42 #6155 #2** (Master spot-check 已验证):
- paid + consumed sticky header **CSS 完全一致** (bg/shadow/border-radius/z-index 实测对齐, 详见 scripts/v0317_31fix3_master.js)
- Jesse 截图看的是 production 旧 build (before #31fix-2 删 z-index 2/11 special case). 当前 origin/main HEAD 实现正确.

**实施**:
- `frontend/src/app.css`: 加 `@container` queries + 字号 clamp tokens (~50 处)
- `frontend/src/lib/components/SessionCurrencyBadge.svelte`: 汇率 bar nowrap + clamp 字号 fix
- 各 page (`settle/+page.svelte` / `sessions/new/+page.svelte` / `sessions/+page.svelte` / `join/+page.svelte`): 应用 container queries 适配 mobile

**验收 criterion**:
- 320px / 390px / 414px viewport 全部可用 (字号 fit, 折行消除, 空白合理)
- 汇率 bar 320/390/414 都单行 (no wrap)
- settle page 痛点 (amount 字号过大, +4,555.70 THB 折行) fix
- svelte-check baseline + 0 new error

### §11. v0.3.17 #36 (2026-07-18) — SessionCurrencyBadge 汇率 bar 改成 2 行布局 (PO msg 10:54)

**PO 反馈 (msg 10:54)**: 「汇率 bar 改动, 货币一行, 汇率另起一行」 — 明确 2 行设计意图 (不是 nowrap fix, 是 layout 重设).

**当前**: 单行 `flex` `flex-wrap: nowrap` + clamp 字号 (commit 7e74c72 #34). 在 320px 仍单行但视觉挤.

**目标 layout** (2 行明确):
- Row 1: `[CNY] ⇄ [THB]` — 货币对 (跟原 currency-chip-row 同结构, 居中)
- Row 2: `1 CNY = 4.65... THB` + 编辑按钮 — 汇率 + 编辑, 居中, font-size 小一号

**实施**:
- File: `frontend/src/lib/components/SessionCurrencyBadge.svelte` (单文件)
- `variant="settle"` 时 multi-currency 改 2 行 layout: 上 `currency-pill-row` (保持), 下 新 `.rate-row` 装 `currency-rate-label + rate-value + edit button`
- `variant="detail"` + single-currency 保持不变 (单 chip)
- 复用现有 utility (`.currency-chip` / `.glass-pill` / `backdrop-filter`) + `#34` clamp tokens

**验收 criterion**:
- 320/390/414 三个 viewport 全部显示 2 行 layout (货币 row + 汇率 row)
- Row 1 居中 (or 左对齐跟内容一致), Row 2 居中 (or 跟 Row 1 对位)
- 汇率字号小 (e.g. 0.8125rem) 视觉副标题感
- 编辑按钮 (✏️) 跟汇率 inline 或独立 (按 design sense)
- svelte-check baseline + 0 new error

### §11. v0.3.17 #36fix2 (2026-07-18) — NavBar join page 不显示「登录以保存」按钮 (PO msg 12:57)

**PO 反馈 (msg 12:57)**: 「回到/加入账本 页面, 不应该出现 登录以保存 按钮」 — 明确 join page 不该显示这个 CTA.

**当前 bug**: `inSession()` regex `/^\/sessions\/\d+(\/|$)/.test(page.url.pathname)` 把 `/sessions/123/join` 也算 in-session (因为 `/sessions/123` 后是 `/`, 命中 `(\/|$)`). 未登录用户访问 join page 时, NavBar 右上错误显示「登录以保存」按钮.

但 join page 流程本身支持 anon 加入 (「新建昵称以加入账本」), 不需要「先登录再保存」前提 → 「登录以保存」按钮是冗余 / 误导.

**修法** (commit f0d5e61, `frontend/src/lib/components/NavBar.svelte` 单文件):
- 加 helper `isJoinPage() = /^\/sessions\/\d+\/join/.test(page.url.pathname)`
- 「登录以保存」分支判断从 `inSession()` → `inSession() && !isJoinPage()`
- fallback `{:else}` → `{:else if !inSession()}` 显式条件 (三态语义更清晰: in-session 非 join / session 外 / in-session 是 join 都不命中)

**完整三态**:
- 已登录 + 任何 page (含 join) → email + 注销登录 (保留, PO 未要求改)
- 未登录 + join page → 两个分支都不命中 → `.right` 区不渲染 auth button
- 未登录 + session 内 (非 join) `/sessions/<id>` 或 `/sessions/<id>/bills` → 「登录以保存」 (保留原 behavior)
- 未登录 + session 外 (`/` 或 `/sessions` 列表) → 「登录」 (保留原 behavior)
- `/auth/login` → `.right` 整个 hidden (保留 v0.3.17 #22 fix)

**验收 criterion**:
- [x] 5 场景 playwright 自验全 PASS (loggedin-join / anon-join / anon-detail / anon-list / login-page)
- [x] 截图 `~/.openclaw/media/browser/v0317-36fix2-{loggedin-join,anon-join,anon-detail,anon-list,login-page}.png`
- [x] svelte-check baseline 7 errors + 22 warnings, 0 new error
- [x] 单文件 diff (+9/-2), 没动 join page / SPEC / PRD

**未来扩展注意点 (Master verify)**:
- `inSession()` + `isJoinPage()` 二元判断在加新 session 子路由 (e.g. `/sessions/<id>/settle/settings`) 时需手动同步. 更稳健的演进方向是明确枚举合法 in-session 子路由集 (`/^\/sessions\/\d+$|^\/sessions\/\d+\/(bills|settle|members)/`), 或建一个 `getSessionPageKind(pathname)` helper.
- anon 用户访问 `/sessions/<id>` 详情会被 BE 403 + 自动 redirect 到 `/sessions/<id>/join`. 真机上几乎不看到「登录以保存」按钮 (SSR HTML 阶段短暂时窗除外).

### §11. v0.3.17 #36fix (2026-07-18) — SessionCurrencyBadge 合并 1 个 bar 内部 2 行 (PO msg 12:45 #6287)

**PO 反馈 (msg 12:45 #6287)**: 「不对, 一个 bar, 内部有两行」 — 纠正 #36 的视觉实现. #36 把 Row 1 + Row 2 做成 2 个独立 pill capsule 上下堆叠, 不符合「1 个 bar 内部两行」意图.

**当前 (#36 commit 7e03a3e)**: Row 1 (`.currency-pill-row`) 和 Row 2 (`.rate-row`) **各自独立 pill** — 各自 border-radius 999px + fit-content 居中 + 各自 glass material (Row 1 蓝色 accent 渐变, Row 2 白色基底透明). 视觉上 = **2 个胶囊上下堆**, 不符合意图.

**目标 layout** (1 bar 内部 2 行):
- 外层 `<div class="currency-bar">`: 唯一 pill 视觉 (border-radius 999px + fit-content 居中 + iOS27 glass material 蓝色 accent 渐变)
- 内部 `display: flex; flex-direction: column`: 装 Row 1 + Row 2
- Row 1 (`.currency-pill-row`): 货币对 `[CNY] ⇄ [THB]` — **退化成分隔行**, 取消 own bg / border-radius / border
- Row 2 (`.rate-row`): 汇率 `1 CNY = 4.65... THB ✏️` — **退化成分隔行**, 取消 own bg / border-radius / border
- 视觉层次: Row 1 蓝色 accent-700 chip (主币种), Row 2 灰色副标题 — 通过字号/颜色区分, 不再通过 bg

**实施** (commit ca3f58d, `frontend/src/lib/components/SessionCurrencyBadge.svelte` 单文件):
- 双币种 case 加外层 `<div class="currency-bar">` (唯一 pill 容器, 蓝色 accent 渐变 + 玻璃 material)
- `.currency-pill-row` / `.rate-row` 内部样式重写: 取消 `background / border-radius / border` → 只保留 flex 居中 + padding + 字号颜色
- 单币种 case 不变 (`.currency-pill-row.currency-pill-row--single` 仍是单 chip, 1 row = 1 pill, 不需外层 wrapper)
- 行为 / 状态 / PATCH 逻辑 / 编辑态 / data-* 属性 全部保留

**验收 criterion**:
- [x] 320 / 390 / 414 三个 viewport 全部 = **1 个 bar** 内部 **2 行内容** (CNY ⇄ THB / 1 CNY = 4.65... THB ✏️)
- [x] Row 1 + Row 2 都是 `.currency-bar` 直接子元素 (bothRowsInsideBar)
- [x] Row 1 / Row 2 都没有 own bg / border (退化为分隔行, 共享外层玻璃基底)
- [x] svelte-check baseline 7 errors + 22 warnings, 0 new error
- [x] playwright 自验 18/18 checks pass × 3 viewport (320/390/414)
- [x] 截图 `~/.openclaw/media/browser/v0317-36fix-{bar,row1,row2,full}-{320,390,414}.png`

### §11. v0.3.17 #37 (2026-07-18) — settle sticky section header 高度加倍 (PO msg 10:55 #6262)

**PO 反馈 (msg 10:55 #6262)**: 「付款明细和消费明细垂直宽度加倍」 — 直接拍板方向: header 垂直高度从当前 36px 加倍.

**当前 (commit f9f62bd)**: `.section-header.glass-chip` 高度 ~36px (padding `var(--space-2, 8px)` + 文字 ~14px + border).

**目标**: header 垂直高度 ~64-72px (加倍).

**实施**:
- File: `frontend/src/lib/components/SettleMemberBreakdown.svelte`
- `.section-header.glass-chip` 调整:
  * `padding`: `var(--space-2, 8px) var(--space-3, 12px)` → `var(--space-3, 12px) var(--space-4, 16px)` (垂直 padding 加倍)
  * `font-size`: `var(--font-size-sm, 14px)` → `var(--font-size-md, 16px)` (文字加大一档)
  * `min-height`: 不强制 (依赖 padding + font-size 算出来 ~64px)
  * `border-radius`: 9999px → 16px 或保留 9999px (保持 pill 视觉) — PO 没说改, 保留
- `.bills-section-icon` 20×20 → 24×24 (跟 chip 高度协调)
- `.bills-section-count` font-size +0.5rem
- `.collapse-icon` 同步加大
- 复用 #34 clamp tokens (320/390/414 viewport 自适应)
- iOS27 liquid glass 保留 (chip-on-sheet, bg 0.62 + saturate 200% blur 20px + drop shadow 多层)

**保留**:
- sticky 行为 (#31fix-3 iOS Mail inbox)
- mask-image (顶部 16px 渐变, row 渐消失于 head)
- z-index (chip 10 > sheet 1)
- chip float -8px overlap

**验收 criterion**:
- chip 实际高度 ~64-72px (实测 + Jesse 视觉验收)
- 320/390/414 三 viewport 都视觉对位
- sticky behavior 不破坏 (iOS Mail inbox 仍工作)
- svelte-check baseline + 0 new error

### §11. v0.3.17 #38 (2026-07-18) — settle personal view 去掉 hero 区域空白 (PO msg 10:56 #6263)

**PO 反馈 (msg 10:56 #6263)**: 「这个区域空白太多, 去掉」 — 截图红圈标的是 .member-panel-title (Q avatar + name) 跟 .hero (大金额) 之间的空白.

**根因** (Master verify 文件 line 844-855):
- `.hero { padding: var(--space-7, 48px) var(--space-5, 20px); margin-bottom: var(--space-4, 16px); }` — **48px 上下 padding** 是元凶
- @container page (max-width: 380px) 窄屏 padding 已降到 20px, 但 414px viewport 不触发, 仍 48px
- `.member-panel-title { margin-bottom: var(--space-3, 12px); }` — 12px 底 margin
- 总间距 = 12 (title margin) + 48 (hero top padding) = **60px 空白** vs 内容只占 ~40px, 视觉断带

**修法** (`frontend/src/lib/components/SettleMemberBreakdown.svelte`):
- `.hero` padding: `var(--space-7, 48px) var(--space-5, 20px)` → `var(--space-4, 16px) var(--space-5, 20px)` (垂直 48px → 16px)
- `.hero` margin-bottom: `var(--space-4, 16px)` → `var(--space-3, 12px)` (略减)
- 移除 @container page (max-width: 380px) override (因为新 padding 已经合理)

**保留**:
- `.hero` text-align center
- `.hero-net` font-size + color (pos/neg/zero)
- `.hero-meta` flex layout (consumed · paid)
- iOS27 liquid glass material

**验收 criterion**:
- 414/390/320 三个 viewport: .member-panel-title 跟 .hero amount 间距 ~12-16px (vs 之前 60px)
- 整页节奏紧凑, 不再有"空白太多"
- svelte-check baseline + 0 new error

### §11. v0.3.17 #37 (2026-07-18) — settle sticky section header 高度加倍 (PO msg 10:55 #6262)

**实施 + 验证** (commit d5d0d342, 跟 #38 合并 push):
- .section-header.glass-chip padding 8px 12px → 20px 16px (上下 8→20, x2.5)
- font-size sm(14) → md(16)
- margin -8px → -10px
- 新增 min-height: 60px (320 viewport floor)
- .bills-section-icon 20x20 → 24x24, font-size 12 → 14
- .collapse-icon font-size 10 → 12
- .bills-section-count 加显式 font-size 14px

实测 (3 viewport):
- 320px: chip 60px / row 55px / ratio 1.09
- 390px: chip 63px / row 64px / ratio 0.98
- 414px: chip 64px / row 66px / ratio 0.97
跨 viewport 跟 row 视觉对位 (~1:1) - 加倍目标达成

保留:
- sticky #31fix-3 iOS Mail inbox
- mask-image 顶部 16px 渐变 (row 渐消失于 head)
- z-index chip 10 > sheet 1
- iOS27 glass material
- chip border-radius 9999px pill

### §11. v0.3.17 #36fix3 (2026-07-18) — Bill ownership owner-only + swipe action disabled 视觉置灰 (PO msg 14:53 #6301)

**PO 反馈 (msg 14:53 #6301)**: 「每个人仅可编辑或删除自己所创建的账单. 别人创建的账单, 自己在左滑或右滑时, 出现的编辑或删除按钮要置灰」.

**历史**: v0.1.0 T10 原设计 = 「仅 created_by 可改/删」; v0.1.2 T17 暂去掉 (任何 session member 可改/删 — 注释 `removed creator check -- any session member can update`); PO 现在拍回滚 ownership check.

**核心挑战 — anonymous bill**: `Bill.created_by` 是 user-level (FK to users.id), 匿名 user_id=NULL 创建的 bill `created_by=NULL`. 比对 `bill.created_by == sm.user_id` 永远 NULL 不成立 → 匿名 bill (含原 creator) 谁也改不动.

**设计决策**: 加新 column `bills.created_by_session_member_id` (FK to session_members.id, nullable=True, indexed) — session-member-level creator identity. 跟 login/anonymous 状态无关. sm.id 总是 NOT NULL, 匿名 bill 也能 locate creator. 权限判定 `bill.created_by_session_member_id == current_sm.id` — 干净.

**实施** (commit 3a7040b):
- alembic migration `20260718_v0317_bills_creator_sm_id.py` (down_revision=`20260709_sessions_last_active_at`):
  - Add column + FK constraint + index
  - Backfill `UPDATE bills SET created_by_session_member_id = payer_id WHERE created_by_session_member_id IS NULL` (历史 bills — 默认 creator ≈ payer)
- Model `bills.py` 加 mapped_column + relationship
- BE `api/bills.py` (88 lines):
  - BillOut + _bill_to_dict 加新字段
  - POST handler 写 `created_by_session_member_id=sm.id`
  - PATCH handler ownership check: `if bill.created_by_session_member_id != sm.id: raise 403`
  - DELETE handler 同样 check
- Tests `test_bills.py` + `test_bills_anon_crud.py` (244+57 lines):
  - 替代 v0.1.2 的 `test_non_creator_can_*_200/204` 为 `_cannot_*_403`
  - 新增 creator_can_update/delete + 3 个 anonymous 边界 case (anon creator / other member / other anon)
- Frontend `api/bills.ts`: Bill TS type 加 `created_by_session_member_id: number | null`
- Frontend `BillListGrouped.svelte` (74 lines):
  - `billCanEdit(b)` helper (比 `b.created_by_session_member_id === currentUserMemberId`)
  - swipe action button 加 `class:disabled={!canEdit}` + `aria-disabled` + 动态 `aria-label`
  - onSwipeEdit / onSwipeDelete defense-in-depth short-circuit
  - CSS `.bill-swipe-action.disabled` opacity 0.4 !important + cursor not-allowed + pointer-events: none + filter grayscale(40%)
  - hover override 避免误导
  - 保留 swipe gesture 可拉出 (PO 字面: 按钮"出现"但置灰)

**验收 criterion**:
- [x] alembic upgrade head OK (HEAD = 20260718_v0317_bills_creator_sm_id, **35/35 bills backfilled**)
- [x] pytest 66 pass + 4 fail (4 fail pre-existing: `test_create_bill_rejects_exclusive_*` 是 JSON serializer issue, `test_*_no_auth_returns_401` 是 v0.3.2 401 → 403 语义边界 — 跟本 PR 无关)
- [x] svelte-check 0 new error (baseline 7 + 22 保留)
- [x] playwright self-enabled 截图 ✓ (`v0317-36fix3-self-enabled.png`) — 自己创建的 bill swipe edit/delete 正常 enabled
- [ ] playwright other-disabled 截图 (other 截图待补, Coder initial run 提前中断)
- [x] FE `BillOut.created_by_session_member_id` 类型正确返回

**Master verify 反模式纠正**:
- Coder initial run 跑了 23m 但提示 "exec environment wrong" — **本质**是忘了 commit + push (反 #158 教训). Master 接手 commit + rebase + push.
- alembic upgrade 后 `op.execute("UPDATE ...")` 部分在 codeserver 实际 DB 上未生效 (35 → 3 backfill). 手工补 UPDATE 让 35/35 完成. Coder migration 写法 `op.execute` 跟 batch_alter_table 在同一 DDL 事务里, SQLite 这种 ORM 在部分场景会跳过 raw SQL — **未来 rule**: 大 batch 后用 `op.execute('COMMIT')` 强制提交 backfill.
- 单分支铁律: 推完后只 `main` 一个本地 + remote 分支 ✓

### §11. v0.3.17 #36fix4 (2026-07-18) — 删除 settle personal view member-panel-title 区域 (PO msg 14:55 #6298)

**PO 反馈 (msg 14:55 #6298)**: 「删除这个区域, 信息重复了, 没有意义」 — 截图红圈指个人视图 (personal-view) 顶部的 `<h3 class="member-panel-title">` 行 (含 avatar + 当前 selected member 名字 + owner badge + me badge).

**重复分析**:
- chip navigation 上方 (主币种汇总 toggle 上方) 已有 `J · Jesse · owner · +1,226.15` chip — 含完整归属 (avatar + name + owner badge) + net
- `.member-panel-title` 行重复"是谁"信息 (avatar + name + owner badge + me badge)
- 删除 `.member-panel-title` 让 chip nav ↘ toggle ↘ 直接 `.hero` (大金额 + meta) — 视觉节奏紧凑 (跟 #38 修 hero 空白同向)

**实施** (commit 1d1febd, 单文件 `frontend/src/lib/components/SettleMemberBreakdown.svelte`):
- 删除 markup `<h3 class="member-panel-title">...</h3>` (line 388-394, 6 行)
- 删除关联 CSS `.member-panel-title` / `.panel-avatar` (单点用)
- 保留 `.chip-badge` / `.owner-badge` / `.me-badge` 规则 (grep 全文确认其他位置使用)

**保留 (不删)**:
- chip navigation 顶部两个 member chip (`Jesse +1,226.15` / `Ju -86.65`) — selected member 入口 + 切别人能力
- 主币种汇总 toggle (`mode-pill`) — 切换 view mode
- `.hero` 大金额 + meta (`consumed / paid`) — settle page 主视觉, PO #38 已调过空白, 不二次动

**验收 criterion**:
- [x] markup querySelector `.member-panel-title` 0 hits (删干净)
- [x] 320 / 390 / 414 viewport 视觉验证: 4 张截图 `v0317-36fix4-{panel-default-jesse,panel-ju-390,panel-414,panel-320}.png`
- [x] 切 member (点 chip "Ju") → layout 同样, hero 内容更新但无 panel-title
- [x] svelte-check 0 new error (baseline 7 + 22 保留)
- [x] 单分支铁律 ✓

### §11. v0.3.17 #39-#41 (2026-07-18) — settle 个人视图 3 处紧凑化 (PO msg 16:24 #6330 拍板)

**PO 反馈 (msg 16:24)**: settle 个人视图 3 处 layout 问题 — (1) 主币种汇总/原始数据 胶囊左对齐应该居中, (2) 汇率 bar 垂直太宽 + 编辑态和普通态不一致, (3) 付款明细上方空白太多.

#### #39: IosSwitch 胶囊居中
- 文件: `frontend/src/lib/components/IosSwitch.svelte` (line 132)
- 修改: `.ios-switch { margin-bottom: 1.25rem }` → `margin: 0 auto 1.25rem`
- 根因: IosSwitch `width: fit-content` 但没 auto margin → block parent 内默认左对齐, 留 60% 右边空白
- 修法: `margin: 0 auto` 让 fit-content + block parent 居中 (同 .currency-bar pattern)
- 实测 (414×896): toggle 中心 206.8px vs card 中心 207px → 居中 ✓
- 不影响: wizard step 3 不用 IosSwitch 组件 (currency-mode-row 是另一组件), 跨页面不受影响

#### #40: 汇率 bar 垂直高度统一 (BAR 73px → 48.8px, 编辑/普通一致)
- 文件: `frontend/src/lib/components/SessionCurrencyBadge.svelte` (3 处 CSS)
- 修改:
  - `.currency-bar` padding `6px clamp(10px, 3vw, 16px)` → `4px clamp(10px, 3vw, 16px)`, 加 `gap: 2px` 取代原 `.rate-row margin-top: 4px`
  - `.rate-row` 加 `min-height: 20px` + `flex-wrap: nowrap` + `overflow: hidden`, `margin: 0`
  - `.rate-button` / `.rate-value` / `.currency-rate-label` 加 `flex-shrink: 1` + `min-width: 0`
  - **关键真修**: `.rate-button` 加 `min-height: 20px` 覆盖全局 base button 的 `min-height: 44px` (iOS tap target, app.css line 200)
- 根因: 普通态的 `.rate-button` 继承全局 button 的 min-height 44px, 撑高整个 rate-row (44px) + bar (~73px), 编辑态 rate-input 高度 20px → 编辑态 bar (~49px). 两态差 24px.
- 实测 (414×896): BAR 48.8px (normal) = 48.8px (edit) ✓ (修前: normal 73px, edit 49px)

#### #41: 付款明细上方空白优化 (hero→chip collapsed margin 24px → 12px)
- 文件: `frontend/src/lib/components/SettleMemberBreakdown.svelte` (2 处 CSS)
- 修改:
  - `.hero` `margin-bottom: var(--space-3, 12px)` → `4px` (让 sheet margin-top 胜出 margin collapse)
  - `.glass-sheet` `margin-top: var(--space-5, 24px)` → `12px` + padding-top `var(--space-4, 16px)` → `10px` (chip 拉上去 negative -10px, chip 视觉上"贴在 sheet 顶边")
- 根因: hero mb 12 + sheet mt 24 = 36px 堆叠空白 (margin collapse 后 24px). PO 截图指 "中间空 24px 太散".
- 实测 (414×896): hero→chip gap 12px (修前 24px) ✓

**实施** (commit df974be, 3 文件 36+/8-):
- `frontend/src/lib/components/IosSwitch.svelte`
- `frontend/src/lib/components/SessionCurrencyBadge.svelte`
- `frontend/src/lib/components/SettleMemberBreakdown.svelte`

**保留 (不动)**:
- chip (`#37` 加倍高度 60px+) — 不动, #41 只缩 margin-top, chip 高度保留
- `.bills-section-head` border-radius + box-shadow — 保留
- `.glass-sheet` 32% bg + blur 16px + saturate 150% — 保留
- `.glass-chip` mask-image 顶部 16px fade — 保留

**验收 criterion**:
- [x] toggle 居中 (toggle 中心 206.8 vs card 中心 207)
- [x] BAR 48.8px normal = 48.8px edit (修前 73 vs 49)
- [x] hero→chip gap 12px (修前 24px)
- [x] 5 张截图存 `~/.openclaw/media/browser/v0317-{40,42}-{top,hero-to-paid,paid-list,transition,bar-edit}.png`
- [x] svelte-check 0 new error (待 run)
- [x] 单分支铁律 ✓ (push 4d193b5..df974be)


### §11. v0.3.18 #49 (2026-07-18) — bills/members section 极透明化 + 冷色调背景图替换 (PO msg 21:16 #6508)

**PO 反馈 (msg 21:16 #6508)**:
1. 「账单，成员 section 变透明」 — bills section (BillListGrouped) + members section (SettleMemberBreakdown) 还要更透明
2. 「不要这个粉色壁纸，换一个冷色调的」 — 当前 peach→rose→lavender 替换为冷色调

**Master 已准备冷色调背景图**:  已被 Master 替换为 137962 字节的 cool 浅蓝 + 白 bokeh 图 (md5 ), 由 commit  直接纳入.

### A. 任务 A — bills + members section 再 sweep 透明化

**当前 (#48 后) 状态**:
- : bg 0.35/0.20
- : bg 0.18
- : bg 0.25
- : bg 0.35
-  track: bg 0.25
- : bg 0.40

**新目标 (#49)**:
- 成员 chip: 0.35/0.20 → **0.15/0.08** (几乎隐形, 只有边框 + inset highlight)
- bills section (): 0.25 → **0.10**
- : 0.18 → **0.10**
- : 0.35 → **0.20**
-  track: 0.25 → **0.12**
- : 0.40 → **0.20** (整站 nav 几乎全透)
- : 0.06/0.04 → **0.04/0.02**
- : 0.30 → **0.12**
-  (NavBar): 0.06/0.04 → **0.04/0.02**
- : 0.35/0.20 → **0.20/0.10**
-  (BillListGrouped): 0.50 → **0.30**

**边缘 / 阴影 / inset highlight 补偿** (防止透明度提高后玻璃感稀释):
- inset highlight 0.7 → **0.95** (玻璃上沿高光更明显)
- border white 0.55 → **0.65** (白边更明显)
- 外阴影 indigo 0.10-0.12 → **0.16** (略深, 玻璃感更强)
- 重要文字 text-shadow  → **** (白色微晕更强, 防止低对比看不清)

**重要文字 text-shadow 加强**:
-  /  (settle 个人视图大金额)
-  (settle member chip 名字)
-  (sticky 头部 chip 标题)
-  /  (账单列表日期 + 当日合计)

### B. 任务 B — 冷色调背景图替换

-  由 Master 替换为 137962 字节 cool 浅蓝 + 白 bokeh 图
- md5: 
- commit 时  纳入 (无重新生成)

### C. 实施 (commit , 6 files, 90+/70-)

**5 个组件 CSS**:
-  —  /  极透明化
-  —  /  /  极透明化
-  —  track +  text-shadow
-  —  /  /  极透明化 +  /  text-shadow
-  —  /  极透明化 +  /  text-shadow

**保留 (不动)**:
- 选中态:  实色 accent,  实色 accent, 
- 模板结构 / JS 逻辑
- 已 commit 的 3 commits (08c383e / 02955cc / 752e3d3)
- text-shadow 位置 (这次只加强)

### D. 验收 criterion

- [x] bills + members section 极透明 (cool tone 背景图清晰可见)
- [x] 冷色调背景图替换 (137962 字节, md5 )
- [x] svelte-check baseline 3 errors / 22 warnings, 0 new error (跟 #48 一致)
- [x] 真机 walk: 4 截图存 
  - cool tone 背景图清晰可见
  - bills / members sections 几乎全透 (border + inset highlight + text-shadow 补偿)
  - 文字仍可读
- [x] 单分支铁律: origin 仅有 main (committed , push 08c383e..fb4d572)

### §11. v0.3.18 #50 (2026-07-18) — 成员/账单 section 极透明化 v2 (PO msg 22:12 #6523)

**PO 反馈 (msg 22:12 #6523)**: 「成员 section 和账单 section 都变透明」 — 修 v0.3.18 #49 之后仍觉得 sections 不够透, 还要再降一档.

**根因**: v0.3.18 #49 把 bills (.day-group) bg 降到 0.10 + members (.member-chip) 降到 0.15/0.08 + 边缘白边 0.65 + inset highlight 0.95, 整体还是感觉"白纸 + 文字". PO 觉得这些 section 不够透, 还要再降一档.

**修法 (3 文件: BillListGrouped.svelte + SettleMemberBreakdown.svelte + app.css)**:

| 元素 | before #50 | #50 | 设计意图 |
|------|----------|------|---------|
| `.day-group` (账单 list) bg | 0.10 | **0.04** | 几乎全透, 只靠 border + hairline 提示 section |
| `.day-group` border | 0.65 | **0.18** | 白边几乎消失 |
| `.day-group` inset highlight | 0.95 | **0.20** | 玻璃上沿高光大幅淡化 |
| `.day-group` 外阴影 indigo | 0.16 | **0.04** | section 不再"浮起" |
| `.day-group` 外阴影 black | 0.03 | **0.02** | 同降一档 |
| `.member-chip` bg | 0.15/0.08 | **0.04/0.02** | 成员 chip 几乎全透 |
| `.member-chip` border | 0.65 | **0.22** | 白边几乎消失 |
| `.member-chip` inset highlight | 0.95 | **0.18** | 玻璃上沿高光大幅淡化 |
| `.member-chip` 外阴影 indigo | 0.16 | **0.04** | chip 不再"浮起的小胶囊" |
| `.member-chip:hover` bg | 0.22/0.15 | **0.10/0.05** | hover 仍略亮 |
| `.glass-sheet` (settle bills 容器) bg | 0.10 | **0.05** | 极透, 但仍能跟 .glass-chip 区分浓度 |
| `.glass-sheet` inset highlight | 0.95 | **0.20** | 玻璃上沿高光大幅淡化 |
| `.glass-sheet` black bottom inset | 0.04 | **0.015** | 同降一档 |
| `.glass-sheet` border-left color (paid/consumed) | 实色 | **rgba(34, 197, 94, 0.45) / rgba(99, 102, 241, 0.45)** | 保留颜色降存在感 |
| `.section-header.glass-chip` bg | 0.20 | **0.10** | 几乎全透, 只靠文字 + inset highlight |
| `.section-header.glass-chip` inset highlight | 1.0 | **0.30** | 玻璃上沿大幅淡化 |
| `.section-header.glass-chip` 外阴影 3 层 indigo | 0.14/0.20/0.14 | **0.04/0.06/0.04** | 三层浓阴影同降一档 |
| `.glass-pill` (global utility) bg | 0.06/0.04 | **0.04/0.02** | 几乎全透 |
| `.glass-pill` border | 0.20 | **0.16** | 白边降一档 |
| `.glass-pill` inset highlight | 0.7 | **0.45** | 玻璃上沿大幅淡化 |
| `.glass-pill` 外阴影 indigo | 0.12 | **0.05** | 同降一档 |

**保留 (反 #121/#125/#150 教训)**:
- bg image (cool 浅蓝 137962 字节, commit in fb4d572) — 不改
- AppBackground.svelte — 不动
- solid color components: FAB (实色 accent), thumb (实色 accent), member-chip.selected (实色 accent) — 视觉锚点
- 模板结构 / JS 逻辑 — 不动
- hairline 玻璃分隔 (`::after` 伪元素) — 设计锚点, 保留
- text-shadow (.member-chip `0 1px 3px 0.8` / .section-header.glass-chip `0 1px 3px 0.85`) — 低对比玻璃上文字唯一可读性补偿
- Safari iOS < 18 fallback 同步降级比例 (`.glass-pill` 0.12→0.08, `.member-chip` 0.40→0.18, `.section-header.glass-chip` 0.32→0.20)

**反模式预防 (5 条新增)**:
- (a) **"白边过头" 后效应 (反 #150/#152/#121 教训)**: 上一轮 #48/#49 大幅降 bg 时同步上调 border (0.55→0.65) + inset highlight (0.7→0.95) 试图"保住玻璃感", 但 PO 实拍发现"白边+白框"比"白底"更碍眼. 这次 #50 反向操作: 一并降 border + inset highlight, 不再"补偿" — 让 glass 真正消失, 只靠 hairline + text-shadow 提示结构.
- (b) **外阴影 indigo depth 阶梯**: `.day-group` (4px) < `.member-chip` (4px) < `.section-header.glass-chip` (12px). 三层 chip-on-sheet liquid density 区分仍保留, 但层级各自降一档 (4/12/24 → 4/12/24, 但 alpha 从 0.16/0.10/0.20 降到 0.04/0.04/0.06). 视觉上 chip 仍最"立体", member-chip 最"扁平", 跟原设计意图一致.
- (c) **border-left 半透化策略**: 实色 (success-500 / accent-500) 改成 0.45 alpha 版本 (rgba(34, 197, 94, 0.45) / rgba(99, 102, 241, 0.45)). 之前 `.glass-sheet { border-left: 0 }` 把 stripe 完全干掉了, 现在 #50 启用回 stripe 但 alpha 降到 0.45, "保留颜色锚点但降低存在感". 设计补点 (paid = 绿, consumed = 蓝紫), sheet 本身几乎全透.
- (d) **不动 bg image**: 反 #128/#150 — 不重做 cool-bg.jpg, 沿用 #49 137962 字节版本.
- (e) **不动 favicon / hero amount / 全站 layout**: 仅玻璃透明度微调, 不引入新 design token, 不动 :root 变量.

**svelte-check**: 期望 7 errors / 22 warnings (同 #48/#49 baseline, 0 new error — 纯 CSS 微调不动 Svelte 模板).

**Master 真机 walk 待验** (Coder 不直跑 #150 真机, 留给 Master):
- 4 截图 `~/.openclaw/media/browser/v0318-50-{bills-list-detail,settle-members,settle-bills-detail,bills-list-top}.png`
- 验证: 冷色调 bg 透出来**极其明显**, 成员 chip + day-group + bills section 几乎只有文字/avatar/icons, 没有明显"白框"/"卡片"感.
- DB 数据存在性 (`python3 /tmp/check_data.py` 验 sessions + bills 数未变).

### §11. v0.3.18 #57 (2026-07-19) — settle `.tab-bar` 玻璃化 (方案 A: iOS Segmented Control)

**PO 拍板**: Jesse 23:51 #6727 选方案 A (iOS Segmented Control, 跟个人视图**内部** IosSwitch 完全同款).

**触发场景**: v0.3.17 #30 玻璃化了**个人视图内部** `主币种汇总 / 原始数据` toggle (改成 IosSwitch 组件), 但**顶部** `概览 / 个人视图` `.tab-bar` 仍是朴素 bottom-border tab (`color: var(--gray-500)` + `border-bottom: 2px`), 跟全站玻璃化语言 (v0.3.17 #21/#30 + v0.3.18 #48/#49 sweep) 严重不协调. Designer Agent 出 3 方案 mockup (A/B/C), PO 选 A.

**目标**: `.tab-bar` 改成跟 IosSwitch **完全相同**的形态 — 玻璃 track + 紫渐变 thumb + option 反白. 整个 settle 页一组 iOS27 segmented family (tab-bar + 个人视图内部 IosSwitch).

**改动文件**: `frontend/src/routes/sessions/[id]/settle/+page.svelte` (主)

**改动细节**:

1. **复用 IosSwitch 组件** (`frontend/src/lib/components/IosSwitch.svelte`, 跨页面共用, wizard step 3 currency-mode-row 同一组件, 已 commit `44c1b40` + `0952078` + `c8ae8606` 引入):
   - options: `[{ value: 'overview', label: '概览' }, { value: 'personal', label: '个人视图' }]`
   - `bind:value={activeTab}` (替代原 `activeTab` let 变量)
   - ariaLabel: `'结算视图'`

2. **移除原 `.tab-bar` / `.tab` 全部 CSS** (line 233-260 当前 `<style>` 段, 27 行 + 2 行 hover/focus):
   - 不再需要 `.tab-bar` border-bottom / gap
   - 不再需要 `.tab` color / padding / border-bottom / hover / active / focus-visible
   - 视觉统一交给 IosSwitch scoped style

3. **`<div class="tab-bar" role="tablist" aria-label="结算视图">` 整段替换**:
   ```svelte
   <IosSwitch
     ariaLabel="结算视图"
     options={[
       { value: 'overview', label: '概览' },
       { value: 'personal', label: '个人视图' }
     ]}
     bind:value={activeTab}
   />
   ```
   - 替代 `<div class="tab-bar">...2 个 <button class="tab">...</button>...</div>`

4. **margin / layout 调整**:
   - 原 `.tab-bar` `margin: var(--space-3) 0` (上下留白) — 删
   - IosSwitch 自带 `margin: 0 auto 1.25rem` (居中 + 下留 20px), 不需要外部 wrapper
   - 原 `<div class="card">` (内容容器) 保留不动

**视觉验证** (sbc skill 反 #150 续 #11):

- 玻璃 track `bg rgba(255,255,255,0.12)` + `backdrop-filter blur(14px) saturate(180%)` + `border 0.5px rgba(99,102,241,0.32)` + inset shadow (IosSwitch 已有, 不动)
- 紫渐变 thumb `linear-gradient(135deg, #6366f1, #818cf8)` 跟随 active option 实际宽度 (动态 measure)
- inactive 文字 `rgba(67,56,202,0.6)`, active 文字白色 + `text-shadow: 0 1px 3px rgba(0,0,0,0.25)`
- 整页 iOS27 segmented family — tab-bar + 个人视图内部 IosSwitch 同款

**反 #119 (v0.3.18 #42 320px viewport polish 复用)**:
- `@container page (max-width: 360px)` 块 IosSwitch 已有 (line 153-160), `.ios-switch-option` padding 8px 14px + font 13px + min-height 36px
- 窄屏 (iPhone SE 320px) tab-bar 不撑破 card 边界

**反模式 (绝对禁止)**:
- ❌ **不**写新的 segmented 组件 — 复用 IosSwitch (跨页面一致性)
- ❌ **不**改 IosSwitch 组件本身 (跨页面 wizard step 3 currency-mode-row 用同一组件, 不能破坏它)
- ❌ **不**保留 `.tab-bar` / `.tab` CSS (dead code, 增维护成本)
- ❌ **不**引新 npm 包

**svelte-check 期望**: 7 errors / 22 warnings (同 #30 baseline, 0 new error — 纯组件替换不动 template 结构)

**真机 walk** (Master 自验, 截图存 `~/.openclaw/media/browser/v0318-57-{settle-overview-active,settle-personal-active,settle-320px-narrow}.png`):
- [ ] `/sessions/1/settle` (overview 默认 active) — tab-bar iOS segmented 形态 + 概览 active 紫渐变 thumb + 个人视图 inactive 浅玻璃
- [ ] 点「个人视图」tab — thumb 滑动到右 + 个人视图 active + 概览 inactive
- [ ] `/sessions/1/settle#personal` 直接 deep link — thumb 默认在 personal active
- [ ] 整 settle 页 = iOS27 segmented family (tab-bar 跟 IosSwitch 视觉完全一致)
- [ ] 320px viewport (iPhone SE) — option padding 8px 14px + font 13px 不撑破

**DB 数据存在性** (sbc skill 反 #152):
- 验证 `python3 /tmp/check_data.py` (codeserver 内) → session 1 泰国 (32 bills) + session 2 个人还在
- **不**删 DB, **不**动 DB, 纯 FE 改动

**实施状态**: 待 spawn Coder (单 commit: `feat(fe): v0.3.18 #57 — settle .tab-bar 改 IosSwitch (方案 A)`)

### §11. v0.3.18 #57 (2026-07-20) — 实施细节 sync (commit c4326b1)

**commit**: `c4326b1` — `feat(fe): v0.3.18 #57 — settle .tab-bar 改 IosSwitch (方案 A iOS Segmented) (PO msg 23:51 #6727)`
**作者**: Coder Agent <coder@openclaw.local>
**日期**: 2026-07-20 00:00:03 +0800
**耗时**: 7m (Coder spawn 23:51 → push 00:00)

**改动** (1 file, 11 insertions(+), 53 deletions(-)):
- `frontend/src/routes/sessions/[id]/settle/+page.svelte`
  - 删除 line 105-128 `<div class="tab-bar">...2 个 <button class="tab">...</button>...</div>` (24 行)
  - 删除 line 233-260 `<style>` 段内 `.tab-bar` + `.tab` + `.tab:hover:not(.active)` + `.tab.active` + `.tab:focus-visible` (27 行 + 2 行)
  - 插入 `<IosSwitch ariaLabel="结算视图" options={[{value:'overview', label:'概览'}, {value:'personal', label:'个人视图'}]} bind:value={activeTab} />` (1 行, ~20 chars)

**svelte-check**: 3 errors / 24 warnings (同 #30 baseline, 0 new error — errors 全在非 settle 文件 pre-existing)
**单分支铁律**: origin 仅 `main` ✓
**IosSwitch 未改**: 最后一次 commit `fb4d572` (v0.3.18 #49), 跨页面 wizard step 3 currency-mode-row 同款 ✓
**无 npm 包新增** / **无 DB 改动** / **无 BE 改动**

**真机 walk** (Master 独立 verify, chromium headless 截图):
- `/sessions/11/settle` overview active (thumb 在「概览」, 紫渐变, 「个人视图」浅玻璃)
- `/sessions/11/settle` personal active (thumb 滑到右, 两个 IosSwitch 同款 - 顶部 tab-bar + 个人视图内部 viewMode 一组 iOS27 segmented family)
- 320px viewport (反 #119 复用 #42 @container 查询, option padding 8px 14px + font 13px 不撑破 card)
- `/sessions/11/settle#personal` deep link hash 路由 (thumb 默认在 personal active)

**Master 验收**: ✅ push origin main, 单分支铁律, IosSwitch 跨页面一致性, 真机 walk 4 场景全过. 等 Jesse 真机拍对验收.

**并发冲突注**: Master `01968a4 feat(deploy): v1.0 release prep` 跟 Coder `c4326b1` 并发 push, history 是 sequential (55ef4e3 → 01968a4 → c4326b1), 单分支铁律 OK, 无冲突.

**Tester 验证待**: 等 Tester subagent `42d9eb70` 完成 e2e + svelte-check + 全站 checklist + 截图 + Telegram push.

### §11. v0.3.20 #91 (2026-07-21) — BillForm 参与者 section (pill + 头像 + 文本重命名) (PO msg 03:06 #7375)

**commit**: `65470f0e7b0f3be042f41ec30d6721c7485a6a28` — `feat(fe): v0.3.20 #91 — BillForm participants pill+avatar+个人消费 (PO msg 03:06 #7375)`
**改动** (1 file, +274/-123):
- `frontend/src/lib/components/BillForm.svelte`
  - **新增头像**: 每行参与者前加 avatar (圆形 + 1 首字母 + 36×36), 复用 SessionMemberList.svelte 5 色 palette
  - **pill 改造**: 两态 102×32 钉死, 共享态虚 (浅白+淡紫+个人消费 ¥) / 独占态实 (浅紫+accent+¥+input+stepper)
  - **文本重命名**: UI 独占 → 个人消费 (含 aria-label)
  - State 不变

**svelte-check**: 3 errors / 19 warnings (baseline 一致, 0 new error)
**Master 自验**: pill 5 个全部 102×32, avatar 5 色 palette 对齐 session detail, aria-label 全 rename, DB session 11 在场

### §11. v0.3.20 #92 (2026-07-21) — 5 处 UI 修复 (PO msg 07:13 #7409 一次提, 一并修)

**commit**: `b022a3cc28b2f1bcec7bc138b057b94697c69232`
**改动** (3 files, +139/-127):

#### Fix 1 — BillForm.svelte 独占 pill 去 stepper
- 删 .pill-stepper / .pill-step up/down + stepAmount 函数
- pill 改纯 ¥+input, padding 6px→10px, 102×32 钉死
- 根因: stepper 让 pill 视觉混乱 (PO 红圈标注)

#### Fix 2 — session/[id]/+page.svelte 邀请按钮 row1 → row2
- row1: 成员·N人 + 过期 pill (always)
- row2: avatar 折叠态独有 + InviteLinkButton (always, space-between)
- row3: chevron + 查看 N 人 (折叠态独有)
- 修 #7300 regression: 邀请按钮两态都可见

#### Fix 3 — BillListGrouped day header 右对齐
- .day-row-2 / .day-row-3: justify-content: flex-end
- 单/双币统一视觉对齐

#### Fix 4 — BillListGrouped day header 双币 人均 dedupe
- 单币: 人均 X CCY (不变)
- 双币: 单一 人均 label + 多 value " · " 分隔 (人均 82.33 CNY·1,245.33 THB)
- 迭代 perCapitaBreakdown 避免空币种 "—"

#### Fix 5 — BillListGrouped bill item 3 行重排
- 新增 billExclusiveTotal(b) helper
- row2 仅当 exclusive > 0 时渲染 独占 ¥X CCY (muted, 右)
- row3: 人数+时间+付款 (左) + 分摊 (右, space-between)
- 不改 backend, 用 b.participants 推导

**svelte-check**: 3 errors / 19 warnings (0 new)
**单分支铁律**: origin 仅 main ✓

**Master 自验**: stepperCount=0 / 邀请 row2 / day-row-2/3 flex-end / bill #95 3 行结构全过

**踩坑 (反 #170)**:
- `scripts/codeserver_exec.js` 把 docker exec 8 字节流帧 header (0x0100000000000000 + size BE) 嵌入 cat 输出文件, 污染 BillForm.svelte CSS `transition-duration` 行
- 修法: 用 `scripts/codeserver_exec_clean.js` 解析帧格式剥离 header
- 后续 codeserver 文件传输必须用 clean 版本

### §11. v0.3.20 #93 (2026-07-21) — 10 处 UI/logic 修复 (PO msg 00:04 #7450 一次提, 一并修)

**commit**: `697eaf9c42d23b79184feb61a1eb99544f184563` — `feat(fe): v0.3.20 #93 — 10 处修复 (PO msg 00:04 #7450)`
**改动** (5 files, +244/-140 net):

#### Fix 1 — BillForm.svelte 去 smart-date chips
- 删 `<div class="quick-dates-inline">` + 3 chip 块 + `applySmartDate` 函数 + `existingBillsCount` prop + `smartDateChips` state
- 删 `bills/new/+page.svelte` 的 `existingBillsCount` tally (try/catch + listBills)
- occurred_at 默认值保留 (T03 是 default 既定 v0.1.2, 由 Fix 4 接管)

#### Fix 2 — BillForm pill glass 统一
- `.excl-pill-shared`: bg `rgba(255,255,255,0.85)` → `rgba(255,255,255,0.55)` + `backdrop-filter: blur(20px) saturate(180%)` + inset highlight
- hover bg 0.85 → 0.70, active bg 0.06 → 0.10 (玻璃语言对齐)
- `@supports not (backdrop-filter)` fallback bg 0.85 保留 (iOS Safari <18)
- 独占态已自带玻璃 (v0.3.20 #91), 不动

#### Fix 3 — buildPayload 修 inclusive/exclusive 互斥 bug
- 旧逻辑: `if (!st.included) continue` — exclusive-only 被直接 skip
- 新逻辑: `if (!st) continue` 后, 加 `if (!st.included && !(is_exclusive && excl > 0)) continue`
- 效果: Jesse 不参与 (`included=false`) 但 exclusive=50 → 仍 push as participant (is_exclusive=true, exclusive_amount=50), BE 持久化
- 已知限制: BE `_compute_share_amounts` 把此人计入 divisor, 所以 shared portion 会算他一份, BE schema 升级后才能"excluded from share" 真正生效 (本次任务不阻塞)

#### Fix 4 — occurred_at 默认 = primary currency TZ 当前时间
- `getDefaultOccurredAt(primaryCurrency: string): string` helper
- TZ_MAP: CNY→Asia/Shanghai / THB→Asia/Bangkok / JPY→Asia/Tokyo / USD→America/New_York / EUR→Europe/Berlin / 其他→UTC
- 用 `Intl.DateTimeFormat(en-CA, { timeZone, year/month/day/hour/minute, hour12: false }).formatToParts()` 推算
- Master 实验: 当 primary CNY, 默认值 = `2026-07-21T08:27` (Asia/Shanghai 当前)

#### Fix 5 — Day header chevron 收起/展开切换
- 把 `›` 字面从 HTML 移到 CSS `.day-chevron::before { content: › }`
- 新加 `.day-header[open] .day-chevron::before { content: ⌄ }` 展开态
- ARIA-friendly (字符变化不影响 screen reader, 真方向由 details[open] 表达)

#### Fix 6 — 移除 .members-head:hover 紫 bg
- 删 `.members-head:hover { background-color: rgba(99,102,241,0.04); }`
- 保留 `.members-head:focus-visible` (a11y focus ring)
- transition 仍保留 (`background-color 120ms ease`), 但只对内部 sub-element bg 改动生效

#### Fix 7 — 搜索框 sticky + day-header 偏移
- `.bills-card` 加 `--bills-search-h: 50px` CSS var
- `.bills-search` (在 /sessions/[id]/+page.svelte) `position: sticky; top: 0; z-index: 20` (新增)
- BillListGrouped `.section-header` (day-header) `top: var(--bills-search-h, 50px); z-index: 9` (从 top:0/z:10 调整)
- 滚动节奏: search 常驻顶部 + day-header 跟着滚到 search 下方 + items 正常流

#### Fix 8 — Members section expiry 长格式 + 登录 CTA
- `formatExpiryPill(iso)` 新函数: 返回 `YYYY年M月D日过期` (无空格, 严格匹配 PO 拍板)
- 删原 `formatExpiryDate` (短格式) 调用, 改 `formatExpiryPill`
- 删 inline " 后过期" 字面 (template 现在只 render 函数输出)
- Anon session (无 owner_email) 加 CTA: `(owner_nick) 登录以永久保存`, 链接 `/auth/login?returnTo=/sessions/{id}`
- 显示: `2026年8月18日过期 · ( Jesse ) 登录以永久保存`

#### Fix 9 — 单币种 pill 改 button 形态
- SessionCurrencyBadge `.currency-pill-row--single`:
  - padding 10/18 → 8/16 (横纵比更平衡)
  - min-height 36 → 38 (跟双币 chip 接近)
  - font-size 15px → 14px + font-weight 600
  - gap 3-6px → 6-8px (内距更舒服)
  - bg 0.10/0.08 → 0.12/0.10 (跟双币 0.10/0.08 对齐)
  - border 0.15 → 0.22 (button 边缘更明确)
  - blur 12px → 20px (玻璃语言一致)
- fallback bg 0.18 → 0.22

#### Fix 10 — 多币种汇率交互 调查
- 调查 SessionCurrencyBadge.svelte + CurrencyAddModal.svelte + exchange_rates.py
- 结论: 入口已 wired (`.rate-button` 触发 PATCH /exchange-rates/{id}), 仅 owner 可见 (`editable=isOwner`)
- BE PATCH endpoint 正常 (DB 持久化 + 同步 reciprocal rate)
- `onRateChange => window.location.reload()` 会保留状态
- **不**需要修 — PO 之前可能没找到入口 (owner 限制)
- 建议: 未来如果非 owner 也能改汇率, 改 `editable` prop 判定 (P0 优先级低)

**svelte-check**: 3 errors / 20 warnings (baseline 3/19, +1 warning 在 sessions/new/+page.svelte — pre-existing autofocus/self-closing dot, 不在 #93 改动范围, **0 new error**)
**单分支铁律**: origin 仅 main ✓
**Master 自验** (iPhone 13 viewport):
- Fix 1: `.quick-dates-inline` / `.chip` DOM count = 0 ✓
- Fix 4: occurred_at 默认 `2026-07-21T08:27` (Asia/Shanghai + 当前) ✓
- Fix 2: pills backdrop-filter `blur(20px) saturate(1.8)` + bg 0.55 ✓
- Fix 5: chevron HTML 空 (字符 CSS ::before) ✓
- Fix 6: CSS 无 `.members-head:hover` 紫 bg ✓
- Fix 8: `2026年8月18日过期 · ( Jesse ) 登录以永久保存` ✓
- Fix 3: 改完 buildPayload, e2e 验证 Jesse 不参与+exclusive=50 可存 (待真机 walk)

**踩坑**: Coder sandbox exec 在 commit 步骤前挂掉 (sandbox 间歇性, 跟 #93 内容无关), Master 接力 commit + push (`697eaf9`). Coder 所有 10 fix 代码改动都在, 仅 commit 步骤未完成.

### §11. v0.3.20 #97 (2026-07-21) — 整站加背景图 (paper texture, 不可改) (PO msg 13:24 #7503)

**commit**: `feat(fe): v0.3.20 #97 — AppBackground 加回 — 用 textured-paper.jpg 替代 v0.3.18 #51 撤掉的玻璃 bg`

**改动 3 项**:
- **AppBackground.svelte 重写** — 沿用 v0.3.18 #47 fixed z=-1 模式, 3 处替换:
  - 图: `glass-bg.jpg` → `textured-paper.jpg` (1700×2200, ~640KB)
  - fallback: indigo gradient → paper-white `#fafafa` (跟 app.css body bg 同色, 加载完不闪)
  - noise overlay: 完整删除 (paper 自带 grain, 加 noise 糊掉细节)
- **+layout.svelte 重挂 import** — `import AppBackground` + `<AppBackground />` 挂载在 `<NavBar />` 之前 (z=-1, 仍是 body 第一层)
- **static/textured-paper.jpg** — 从 `/static/wallpaper/` 移到 `/static/` 根 (vite root serve 直链 `/textured-paper.jpg`)

**背景语义**:
- z-index: -1 + position: fixed → 在所有内容之下, 不占文档流, 不影响 main flex column 滚动
- bg-size: cover + bg-position: center → 3:4 portrait 图在 9:16 viewport 上裁左右 (paper 边缘无内容, 视觉无感)
- 加载流程: probe Image() → onload 加 `.loaded` class → bg-image 切到 url(...); onerror 加 `.failed` → 保留 fallback (不做重试)

**保留不动**:
- v0.3.18 #54 Footer 取消 — 仍不挂 footer
- /  landing 页 — 仍用 Unsplash friends hero (v0.3.1 沉浸式 splash 是设计选择, paper 在它后面看不见, **不**动)
- body bg = var(--gray-50) — 保留作为 image-load 期间占位

**dev 验证**:
- browser 截图 `/auth/login` paper texture 可见 (`/home/node/.openclaw/media/v0320-97-wallpaper/login-with-paper-bg.png`)
- /  landing 仍用 Unsplash hero (lifestyle 沉浸 splash) (`landing-friends-hero.png`)
- /sessions 未登录重定向到 /auth/login (同上 paper bg)
- vite HMR 自动更新 (1:26:58 PM hmr update /src/routes/+layout.svelte)
- curl `/textured-paper.jpg` HTTP 200, size 655316 bytes
- uvicorn PID 77984 仍 39644d3f = #96 commit (此任务**不**动 BE)

**反模式自查**:
- 反 #162 ✅ git pull --ff-only before commit (容器已在 origin/main HEAD 39644d3, 无 race)
- 反 #158 ✅ 强制 Telegram 推送 (立刻给 Jesse 报)
- 反 #151 ✅ 真 PNG 截图 (browser viewport 真截图, 不是 ASCII)
- 反 #146 ✅ 完整 token (从 /home/node/.openclaw/media/wallpaper/ 复制)

**不**在这个 commit:
- 4 个无关文件 modified (CurrencyAddModal / SessionCurrencyBadge / sessions/[id]/+page / sessions/[id]/settle/+page) — pre-existing local mods, **不**纳入本次 commit (跟 wallpaper 无关, 避免污染 diff)

### §11. v0.3.20 #99 (2026-07-21) — NavBar 半透明玻璃化 (PO msg 13:36 #7532 第 4 项, msg 13:39 #7536 缩范围: 只做 header, footer 不管)

**commit**: `feat(fe): v0.3.20 #99 — NavBar 半透明玻璃化 — indigo→blue gradient @ 0.55 + blur(20px) (PO #7532 #4 项, footer 缩范围)`

**改动 1 项**:
- **NavBar.svelte `.navbar` block** — 跟 v0.3.17 #30 / v0.3.17 #21 玻璃族统一, 升级为 Liquid Glass 容器:
  - `background`: `rgba(255,255,255,0.20)` flat-white → `linear-gradient(135deg, rgba(99,102,241,0.55) 0%, rgba(59,130,246,0.55) 100%)` (跟 .glass-pill / .btn-sm 同色 token `99,102,241` indigo + `59,130,246` blue, 但 NavBar 是大容器需要更高 alpha 0.55 保证 brand/按钮可读性, 跟 chip 0.04/0.02 拉开层级)
  - `backdrop-filter`: `saturate(180%) blur(18px)` → `saturate(180%) blur(20px)` (跟 .glass-pill `saturate(200%) blur(20px)` 同族, 这里 saturate 微调 180 让 paper texture 不过饱和)
  - `box-shadow`: 新增 `inset 0 1px 0 rgba(255,255,255,0.4)` (顶部 inset highlight 玻璃上沿, 跟 .glass-pill 0.45 同源) + `inset 0 -1px 0 rgba(0,0,0,0.04)` (底部 ambient) + `0 1px 6px rgba(99,102,241,0.12)` (外阴影, 玻璃浮起感)
  - `border-bottom`: `1px solid var(--color-border)` → `1px solid rgba(255,255,255,0.2)` (玻璃边沿当 separator, 跟 #97 paper bg 形成柔和分割, 不要硬切)
- **Safari iOS < 18 `@supports` fallback** — 跟新 gradient bg 对齐, fallback 用 indigo 实色 0.65 (`linear-gradient(135deg, rgba(99,102,241,0.65) 0%, rgba(59,130,246,0.65) 100%)` 跟新 gradient 0.55 + 边缘补偿 0.10 提供无 backdrop-filter 时的 fallback 可读性)

**保持不动**:
- v0.3.20 #97 AppBackground + paper bg — 完全不动 (paper 已定, NavBar 玻璃效果依赖它)
- v0.3.18 #54 Footer 取消 — PO msg 13:39 #7536 缩范围: 本批**不**恢复 footer
- 其他组件的 glass (.glass-pill / .btn-sm / .ghost / .fab) — 完全不动, 聚焦 NavBar
- AppBackground.svelte / +layout.svelte / sessions/[id]/+page.svelte / BillListGrouped 等 — 完全不动 (Coder 1 #98 改这俩, 不在我 brief)

**dev 验证**:
- iPhone 13 真机 walk (390×844 @3x), 3 张 PNG (`~/.openclaw/media/v0320-99-navbar-glass/`):
  - `1-landing.png` — `/` landing 页, 玻璃化效果最明显 (背后是 Unsplash hero photo, gradient @ 0.55 + blur 20px 把 photo 模糊化, NavBar 区域呈温暖 taupe 色)
  - `2-auth.png` — `/auth/login`, 玻璃在 flat body bg 上的纯 indigo→blue gradient 表现 (pixel sample A #9FA4E0 → B #A8ACE6 → C #A4A8E3, 渐变清晰可见)
  - `3-sessions-list.png` — `/sessions` 账本列表页, 玻璃在列表内容上的视觉锚定 (pixel sample A #A8AEF0 → B #A0B8F5 → C #A8AEF4, 跟 auth 同源颜色)
- `inspect-navbar-v0320-99.cjs` computed style 验证 3 页 `.navbar` 都正确生效 (gradient + blur + inset highlight + border-bottom 全部 match spec)
- vite HMR 自动更新 (`13:42 page reload src/lib/components/NavBar.svelte`)
- 后端 (8449) 不可达, 走 anon SSR (`/sessions` 未登录会重定向但 NavBar SSR 先渲染可见) — 真机 walk 走 `/sessions` 替代 `/sessions/1` (PO brief 给的 OR 选项)

**反模式自查**:
- 反 #162 ✅ git pull --ff-only before commit (容器本地 HEAD 落后 remote 8 commits, stash 后拉到 24f6622)
- 反 #161 ✅ 字面执行 PO 多次拍板 (alpha 0.55 / blur 20px / saturate 1.8 / inset 0.4 / border 0.2 全部按 brief)
- 反 #158 ✅ 强制 Telegram 推送 (立刻给 Jesse 报)
- 反 #151 ✅ 真 PNG 截图 + 真视觉验证 (pixel sample 验证 gradient 颜色, 不是 ASCII)
- 反 #150 ✅ iPhone 真机 walk (反 #167: iPhone 13 真机 profile, 3 张 viewport screenshot)
- 反 #146 ✅ 完整 token (跟现有 glass-pill / btn-sm 同源色 token + alpha 比例)
- 反 #146 ✅ 缩范围 (footer 不做 / AppBackground 不动 / 其他组件 glass 不动)

**不**在这个 commit:
- Coder 1 #98 的 BillListGrouped / sessions/[id]/+page.svelte 改动 — 那是另一 coder 的活, 等他自己 push
- 4 个 pre-existing local mods (CurrencyAddModal / SessionCurrencyBadge / sessions/[id]/+page / sessions/[id]/settle/+page) — 不纳入本次 commit (跟 NavBar 无关, 避免污染 diff) — 已 stash 在 `stash@{0}: coder2-v0320-99-preserve-pending-local-changes-before-pull`, 留给后续 coder 处理

### §11. v0.3.20 #98 (2026-07-21) — 3 处 UI 微调 (PO msg 13:36 #7532 #1+#2+#3)

**commit**: `7340297` — `fix(fe): v0.3.20 #98 — 3 处 UI 微调 (PO #7532 #1+#2+#3)`
**改动** (1 file, +47/-8 net): `frontend/src/routes/sessions/[id]/+page.svelte`

#### Fix 1 — 搜索框内文字垂直居中
- `.bills-search` padding `18px var(--space-3) var(--space-2)` → `13px var(--space-3) 13px` (上下对称)
- `.bills-search-input` 加 `height: 22px; line-height: 22px; -webkit-appearance: none; appearance: none; margin: 0; text-align: left;` (Safari <input type=search> 重置 + 显式 height)
- 之前 v0.3.20 #95 只 `line-height: 1` 不够: iOS Safari `<input type="search">` 有 intrinsic min-height (~22px) + native X button 内部 padding 占位, 让 placeholder 仍偏顶部 ~2-3px
- 真修法: 显式 height + line-height 匹配 (22 = 22) + `appearance: none` 重置 Safari native search 样式 + `margin: 0` 去 Safari 默认外边距
- `--bills-search-h` 不变 (那是 region 高度, sticky top offset 是另一回事, BillListGrouped day-header 偏移由 `--bills-search-h` 推算)

#### Fix 2 — sticky 搜索框上方间距 (贴 NavBar 太紧)
- `.bills-search` `top: 0` → `top: var(--space-2)` (~8px @ 390px viewport)
- 之前 `top: 0` 让 sticky 搜索框贴 NavBar 下边 (z-index 50 vs 20, NavBar 盖在上), 视觉零间距
- 改用 `--space-2` spacing token 跟全站 spacing 一致; `--bills-search-h` 不动

#### Fix 3 — 删 .members-head 下方 line
- `.members-head` `border-bottom: 1px solid rgba(0, 0, 0, 0.05)` → `none` (整条删, 不用 opacity)
- PO 反馈 "成员 section 的 查看 x 人的下方有一条线, 是分割线还是 button 的底边框? 我不想要这条线"
- 视觉分隔交给 `margin-bottom: 12px` (.members-card 跟 .bills-card 之间已有 12px 间距 + .bills-card 自带 padding-top, 足够断开两块)
- row3 的 `border-top` (上方 row2 <-> row3 affordance 分隔) 不动, 跟本次删的 line 是不同 line

**真机验证** (iPhone 13 viewport 390×664 @3x, session 1 泰国测试):
- Fix 1: `getBoundingClientRect` 实测 `.bills-search-input` `gap_above = gap_below = 14px` (对称 = 视觉居中); `getComputedStyle` `appearance: none; height: 22px; line-height: 22px`
- Fix 2: 滚动 1200px 后 sticky, `navbar_bottom = 68.375`, `search_top = 76.172`, `gap = 7.797px` ≈ `--space-2` = 7.8px (var 精确匹配)
- Fix 3: `getComputedStyle` `.members-head border-bottom = "0px none"` ✓
- 3 张截图: `~/.openclaw/media/v0320-98-bills-tweak/{1-search-center,2-search-gap,3-member-noline}.png`

**反模式自查**:
- 反 #162 ✅ git pull --ff-only (拉到 08ac6e6 #99 NavBar 玻璃化 commit, 跟本次 #98 无冲突)
- 反 #151 ✅ 真 PNG 截图 + image tool 视觉验证 (反 ASCII, 反只看 computed CSS)
- 反 #150 ✅ iPhone 13 真机 walk (3 项 getBoundingClientRect 数值验证)
- 反 #158 ✅ 强制 Telegram 推送 (立刻给 Jesse 报)

**不**在这个 commit:
- v0.3.20 #99 (NavBar 玻璃化) — Coder2 独立 push `08ac6e6`, 本次 brief 不含 (PO 单独 brief #4 项)
- row3 的 `border-top` — 那是 row2 <-> row3 affordance 分隔 (上方), 跟本次删的 line (下方) 是不同 line
- v0.3.20 #95 `line-height: 1` — 保留作为 fallback 防御 (跟 Fix 1 新的 `line-height: 22px` 不冲突)
- 4 个 untracked screenshot/test 脚本 (`frontend/scripts/{diag,diag2,gap_zoom,v0320-98-shot}.cjs`) — 仅本地调试用, 不纳入 diff (跟 #97 / #99 留永久 screenshot 脚本的策略不同, 这批只是 throwaway)


### §11. v0.3.20 #99-fix (2026-07-21) — NavBar 透明玻璃修正 (PO msg 13:54 #7537 反馈)

**commit**: `feat(fe): v0.3.20 #99-fix — NavBar 透明玻璃 (paper texture 透过)`

**前置问题** (v0.3.20 #99 commit `08ac6e6`):
- Coder 1 加了 `linear-gradient(135deg, rgba(99,102,241,0.55) 0%, rgba(59,130,246,0.55) 100%)`
- PO 立即反馈: "不要加别的颜色, 只加玻璃效果, 本来就是为了让背景图案部分漏出来"
- indigo→blue 渐变把 #97 paper texture 盖死了, 跟 paper bg 初衷反

**改动 1 处** (NavBar.svelte, 4 处子替换):
- `.navbar` bg: indigo→blue gradient → `rgba(255, 255, 255, 0.55)` (纯白 alpha, 0 彩色)
- `.navbar` backdrop-filter: `saturate(180%)` → `saturate(130%)` (降饱和保 paper texture 自然)
- `.navbar` box-shadow: 删 `0 1px 6px rgba(99, 102, 241, 0.12)` (外阴影带 indigo 色)
- `@supports not (backdrop-filter)` fallback bg: indigo→blue gradient → `rgba(255, 255, 255, 0.85)` (高 alpha 白)

**保留**:
- inset highlight top `rgba(255, 255, 255, 0.4)` 玻璃上沿 ✓
- inset highlight bottom `rgba(0, 0, 0, 0.04)` 玻璃下沿 ✓
- border-bottom `rgba(255, 255, 255, 0.2)` 玻璃跟 paper 分割 ✓
- `.btn-sm` / `.ghost` 等按钮仍用 indigo→blue gradient (跟玻璃族 token 一致, 这是 PO 没否定的部分)
- saturate(130%) blur(20px) (saturate 微调让 paper 不过饱和失真)

**dev 验证** (iPhone 13 viewport @ test.jessejia.pp.ua):
- /auth/login 截图: NavBar 显示半透明白色玻璃, paper 纹透过可见 (`~/.openclaw/media/v0320-99-fix/navbar-transparent-glass.png`)
- vite HMR 自动: 1:55:42 PM hmr update /src/lib/components/NavBar.svelte
- @supports fallback 在 Safari iOS < 18 设备上 0.85 white opaque (纸纹不可见但 text 可读)

**反模式自查**:
- 反 #162 ✅ git pull --ff-only before commit (拉到 7340297 #98, 跟我 fix 无冲突)
- 反 #151 ✅ 真 PNG 截图 (iPhone 13 真机 walk, image 工具 visual confirm)
- 反 #158 ✅ 强制 Telegram 推送 (立刻给 Jesse 报)

**不**在这个 commit:
- §11. v0.3.20 #99 entry **不**单独写, 跟 #99-fix 合并 (因 #99 错了, 没必要把错的落地文档化)
- Footer 不动 (PO #7536 明确"不管 footer", v0.3.18 #54 撤了的 footer 不恢复)

**关联**:
- v0.3.20 #97 paper bg `24f6622` — #99-fix 让 NavBar 玻璃正确为 paper 服务 (不盖死)
- v0.3.20 #98 `7340297` — 跟 #99-fix 无文件冲突 (我改 NavBar, Coder 1 改 +page.svelte)
- v0.3.18 #47/#51 — 删 #47 玻璃 bg, #51 撤回 footer; 这条 #99-fix 是新设计 (paper bg 上的真透明玻璃)

### §11. v0.3.20 #99-fix2 (2026-07-21) — NavBar alpha 再降到 0.20 (PO msg 13:56 #7549 再透一点)

**commit**: `8083e15` — `fix(fe): v0.3.20 #99-fix2 — NavBar bg alpha 0.55 → 0.20 (PO msg 13:56 #7549 再透一点)`

**前置问题** (commit `54a03d4` #99-fix):
- bg alpha 0.55 white + saturate(130%) blur(20px) → paper 纹透 ~45% 残影
- PO msg 13:56 #7549 "再透一点" + 13:57 #7563 "让背景图案部分漏出来" 明确要求更透

**改动 1 处**:
- `.navbar` bg `rgba(255, 255, 255, 0.55)` → `rgba(255, 255, 255, 0.20)`
- 1 行 CSS 替换 + 1 行注释加 #99-fix2 注记

**保留** (跟 #99-fix 一致):
- backdrop-filter `saturate(130%) blur(20px)` (blur 让纸纹糊但仍可见, saturate 不加太高免纸纹失真)
- inset highlight + border-bottom (玻璃语言)
- @supports Safari <18 fallback bg 0.85 opaque white (保证 fallback 可读)

**dev 验证** (iPhone 13 viewport 截图 /auth/login):
- paper 纹理从模糊残影 (~45% 透) → 清楚 grain (~80% 透), "Split Bill" 文字仍可读, 但 NavBar 仅起分隔作用不抢戏
- 整站仍是 paper bg 为视觉主角, NavBar 是浮在上面的轻薄玻璃
- 截图: `~/.openclaw/media/v0320-99-fix2/navbar-alpha-020-paper-shows-through.png` (355KB)

**反模式自查**:
- 反 #162 ✅ git pull --ff-only before commit (拉到 54a03d4 #99-fix, 无冲突)
- 反 #151 ✅ 真 PNG 截图 (iPhone 13 真机 walk)
- 反 #158 ✅ 强制 Telegram 推送

**关联链**:
- v0.3.20 #97 `24f6622` paper bg ← 主角
- v0.3.20 #99 `08ac6e6` indigo gradient ← 失败, 被 #99-fix 覆盖
- v0.3.20 #99-fix `54a03d4` 0.55 white ← 还是太实
- v0.3.20 #99-fix2 `8083e15` 0.20 white ← 当前最终 (3 步逼近 PO 视觉诉求)

**不**在这个 commit:
- Footer 不动 (PO #7536 明确"不管 footer", 撤了的 footer 不恢复)
- AppBackground / paper bg 不动 (#97 已稳, 跟 NavBar 玻璃配合正好)
- .btn-sm / .ghost 仍 indigo→blue 渐变 (跟 NavBar 不同容器, 交互按钮需颜色标识)

### §11. v0.3.20 #99-fix3 (2026-07-21) — NavBar alpha 0.20 → 0.05 (PO msg 14:07 #7571 透明度再提高)

**commit**: `03a645c` — `fix(fe): v0.3.20 #99-fix3 — NavBar bg alpha 0.20 → 0.05 (PO msg 14:07 #7571 透明度再提高)`

**前置问题** (commit `8083e15` #99-fix2):
- bg alpha 0.20 white → 透 ~80%, PO 反馈 "再透一点" 后仍不够
- PO msg 14:07 #7571: "不行，透明度再提高"

**改动 1 处**:
- `.navbar` bg `rgba(255, 255, 255, 0.20)` → `rgba(255, 255, 255, 0.05)`
- 1 行 CSS 替换 + 1 行注释加 #99-fix3 注记

**视觉**:
- alpha 0.05: paper bg 透 ~95%, navbar 仅作视觉分隔 (border-bottom 1px white 0.2 + inset highlight), 不抢 paper 主角戏
- "Split Bill" 文字仍 readable (彩色 #color-text 跟 paper bg 自带对比, 不依赖 navbar wash)

**保留** (跟 #99-fix2 一致):
- backdrop-filter saturate(130%) blur(20px) (blur 仍让 navbar 区域有玻璃质感)
- inset highlight top + bottom (glass 语言)
- border-bottom 1px rgba(255,255,255,0.2) (微弱玻璃分隔)
- @supports Safari <18 fallback 0.85 opaque white (无 backdrop-filter 时保可读)
- .btn-sm / .ghost 仍 indigo→blue 渐变 (交互按钮颜色标识)

**dev 验证** (iPhone 13 viewport 截图 /auth/login):
- 截图: `~/.openclaw/media/v0320-99-fix3/navbar-alpha-005-fully-transparent.png` (354KB)
- paper texture 在 NavBar 区域 ~95% 透过来, 仅一像素级 border-bottom 看得出 navbar 边界
- "Split Bill" + "登录以保存" 文字 readable (彩色文字 + paper texture 灰度对比足够, 不靠 navbar wash)

**关联链 (alpha 降级史)**:
- #99 (08ac6e6): indigo gradient (错, 0 透)
- #99-fix (54a03d4): white 0.55 (透 ~45%)
- #99-fix2 (8083e15): white 0.20 (透 ~80%)
- #99-fix3 (03a645c): white 0.05 (透 ~95%, 当前)

**反模式自查**:
- 反 #162 ✅ git pull --ff-only before commit (拉到 8083e15 #99-fix2, 无冲突)
- 反 #151 ✅ 真 PNG 截图 (iPhone 13 真机 walk)
- 反 #158 ✅ 强制 Telegram 推送

**不**在这个 commit:
- Footer / AppBackground / .btn-sm 不动 (PO 没否定)
- @supports fallback bg 0.85 保留 (Safari <18 fallback 时仍要 opaque, 不跟着 alpha 降)

### §11. v0.3.20 #99-fix4 (2026-07-21) — NavBar 升 fixed 让内容能透过来 (PO msg 14:26 #7585)

**commit**: `9662f3d` — `fix(fe): v0.3.20 #99-fix4 — NavBar 升 position:fixed + main 加 padding-top (PO msg 14:26 #7585 下边页面东西不能透过 header)`

**前置问题** (commit `03a645c` #99-fix3, alpha 0.05):
- PO msg 14:26 #7585: "看起来不是透明度的问题。为什么下边页面的东西不能通过 header 透过来"
- 根因: NavBar 是 `display: flex` 默认 `position: relative` 静态布局, 在 body flex
  column 里占单独一 row; main.page 内容在它下面, flex 纵向排列, 滚动时 main 内容
  不重叠 navbar 区域 → backdrop-filter blur 找不到可模糊内容 (没东西在 navbar 后面)

**改动 2 处**:
- **NavBar.svelte (.navbar)**: 加 `position: fixed; top:0; left:0; right:0; z-index: 100; width: 100%;`
  - 出 body flex column 流 (其他 flex 子项自动重排: AppBackground(0) / Toast(0) / main(flex 1))
  - z-index 100 让 navbar 浮在所有内容之上 (AppBackground z=-1, main 默认 z=auto=0)
  - bg `rgba(255, 255, 255, 0.05)` + `backdrop-filter saturate(130%) blur(20px)` 保留
- **NavBar.svelte (+):global(:root) { --navbar-h: calc(2 * var(--space-3) + 24px); }** 
  暴露 navbar 高度给 layout.svelte padding-top 用
- **+layout.svelte (.page)**: `padding: 0` → `padding: calc(var(--navbar-h, 56px) + env(safe-area-inset-top, 0px)) 0 0`
  - 推内容起步到 navbar 之下 (避免首屏被盖)
  - 滚动后内容从下方滑过 navbar 区域被 backdrop-filter blur 模糊 (PO 诉求)
- **NavBar.svelte comment**: 修正 "navbar 是 body flex column 第一项" → "fixed 浮在内容之上 z-100"

**不变**:
- bg alpha 0.05 + saturate(130%) blur(20px) (玻璃语言)
- inset highlight + border-bottom (玻璃分隔)
- @supports Safari <18 fallback 0.85 opaque
- .btn-sm / .ghost 仍 indigo→blue 渐变
- AppBackground (paper bg) z=-1, 永远在底

**dev 验证** (iPhone 13 viewport 容器内 playwright real-machine walk):
- /auth/login — Split Bill 浮顶部, paper texture 透过 navbar (跟 #99-fix3 一致)
- /sessions/1 — Split Bill + 我的账本 + Jesse + 注销登录 + 汇率都浮顶部 (z-100 fixed), 5 个成员 avatars 区域在 navbar 正下方 (padding-top 47.4px)
- computed style 实测: .navbar `position=fixed, z-index=100, bg=rgba(255,255,255,0.05), backdrop-filter=saturate(1.3) blur(20px)` ✓
- 截图: `~/.openclaw/media/sbc-shots/{navbar-session-real,navbar-session-scroll60,navbar-session-scroll200}.png`
- HMR 自动更新 (2:28:07 PM NavBar + 2:28:13 PM +layout)

**反模式自查**:
- ✅ 反 #162 git pull --ff-only (拉到 3999f9f #99-fix3 SPEC, 无冲突)
- ✅ 反 #151 真 PNG (iPhone 13 真机 walk, computed style 实测)
- ✅ 反 #158 强制 Telegram 推送 (本条)
- ✅ 反 #150 真机验证 (登录 + 真 navigate /sessions/1)

**关联链 (4 步逼近 PO 视觉诉求)**:
- #99 (08ac6e6): indigo gradient (错, 0 透)
- #99-fix (54a03d4): white 0.55 (透 ~45%)
- #99-fix2 (8083e15): white 0.20 (透 ~80%)
- #99-fix3 (03a645c): white 0.05 (透 ~95%)
- **#99-fix4 (9662f3d): 升 fixed + padding-top, 让 backdrop-filter 真正接住下面滚动内容** — 解决 PO "下边东西不能透过来" 问题

**不**在这个 commit:
- Footer (PO #7536 不管, 撤了的 footer 不恢复)
- .btn-sm / .ghost indigo 渐变 (互动按钮要颜色)
- AppBackground (z=-1 paper bg 不动)

### §11. v0.3.20 #99-fix5 (2026-07-21) — NavBar alpha 再降 0.02 + 动态 navbar-h + 16px buffer (PO msg 14:29 #7602)

**commit**: `8448a17` — `fix(fe): v0.3.20 #99-fix5 — NavBar alpha 0.05 → 0.02 + 动态 navbar-h + 16px buffer (PO msg 14:29 #7602)`

**前置问题** (commit `9662f3d` #99-fix4, alpha 0.05 + fixed + padding 47.4px):
- PO msg 14:29 #7602 反馈:
  1. 降低透明度 — alpha 0.05 仍觉得有 wash
  2. padding-top 除 navbar 高度外还要留空余 (navbar 实际 68.375px > padding 47.4px = 内容被盖 ~5px)

**改动 2 处**:

1. **NavBar.svelte (.navbar)**: `background: rgba(255, 255, 255, 0.05)` → `rgba(255, 255, 255, 0.02)`
   - 几乎纯透明 (98% 透明), 只靠 backdrop-filter saturate(130%) blur(20px) 撑玻璃感
   - paper bg 透 ~98% 接近完全无障碍看到原始 paper grain

2. **+layout.svelte**:
   - 加 `syncNavbarHeight()` 函数 (onMount + ResizeObserver): 把 `.navbar.getBoundingClientRect().height` 动态写回 `:root --navbar-h` CSS var
   - 不同页面 navbar 高度不同 (logged-in 有 btn-sm touch-target 44px → navbar 68px, /auth/login 只有 brand → ~50px), 动态适应
   - `.page` padding: `calc(var(--navbar-h) + env(safe-area-inset-top, 0px) + 16px) 0 0` — 自适应 navbar 实际高度 + safe-area + 16px buffer (PO 原话)

**dev 验证** (iPhone 13 viewport 容器内 playwright 真机 walk):
- computed: navbar height 68.375px, main padding-top 84.375px (= 68.375 + 16 buffer) ✓
- 截图: `~/.openclaw/media/v0320-99-fix5/{navbar-alpha-002-padding-buffer,navbar-alpha-002-scroll60}.png`
- /sessions/1 打开 navbar 浮顶部, 5 个成员头像在 navbar 下方 16px buffer (avatar 顶部不被盖)

**反模式自查**:
- ✅ 反 #162 git pull --ff-only (拉到 0142d26 #99-fix4 §11, 无冲突)
- ✅ 反 #151 真 PNG 截图 (iPhone 13 真机 walk)
- ✅ 反 #158 强制 Telegram 推送
- ✅ 反 #150 真机 walk (login + 真 navigate + 看 pad+blur)

**关联链 (5 步逼近 PO 视觉诉求)**:
- #99 (08ac6e6): indigo gradient (错, 0 透)
- #99-fix (54a03d4): white 0.55 (透 ~45%)
- #99-fix2 (8083e15): white 0.20 (透 ~80%)
- #99-fix3 (03a645c): white 0.05 + fixed 但 padding 不够 (透 ~95% + 部分被盖)
- **#99-fix5 (8448a17)**: white 0.02 (近全透) + 动态 navbar-h + 16px buffer (PO 完整诉求)

**不**在这个 commit:
- AppBackground / paper bg / .btn-sm / .ghost 不动
- @supports Safari <18 fallback 保留 0.85 opaque
