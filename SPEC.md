
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
- [ ] Master 替换 `backend/.env` 中 `SMTP_PASSWORD=__PENDING_ALIYUN_SMTP_PASSWORD__`
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
| 2026-06-30 | v0.1.0 | **Sprint 1 T05 完成**：邮件服务集成 + 修 Stage 1 .env CORS bug。<br>· 新增 `EmailService` 模块（starttls + login + send）<br>· 新增 `verification_code` 生成（`secrets.randbelow` 6位）<br>· 新增 `POST /auth/send-code` 端点（v0.1 简化：不存 DB，T06 接入）<br>· 新增 `scripts/verify_email.py` CLI 工具<br>· 修 `.env.example` CORS 改 JSON 数组格式（pydantic-settings 2.x 兼容）<br>· 修 `app/core/config.py` 删失效的 `_parse_cors` validator（dotenv 路径上 `mode="before"` 不生效）<br>· 测试：29/29 pytest 通过（`test_email_service.py` 9 + `test_verification_code.py` 18 + `test_health.py` 2）<br>· 端到端：CLI 真发邮件到 `jessejia1001@gmail.com` 成功（hard requirement）<br>· 详见反模式 #31（§8.5）。commit 关联见 Sprint Board T05 行。 |
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
INFO  scripts.cleanup_expired:   would drop id=46 email=jessejia1001@gmail.com code=731673
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

- `xinhua1001@outlook.com` user：已存在则跳过
- `泰国测试账单 6.19-6.22` session：已存在则跳过（保留现有 bills）
- `个人测试` session：已存在则跳过
- Bills：已存在则跳过（32 bills = 27 THB + 5 CNY）

**不做**：不 DELETE 任何已有行，不 truncate，不 DROP TABLE。

### D. 验收清单

1. **Config verify**：`grep "default=False" backend/app/core/config.py` 含 `sbc_skip_seed` 行。
2. **DB verify**（seed 跑完后）：
   - `SELECT COUNT(*) FROM users WHERE email='xinhua1001@outlook.com'` → 1
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

### §11. v0.3.20 #100 (2026-07-21) — 全站品牌 Split Bill → SplitIt + NavBar brand hover ivory + landing 主按钮透明玻璃 ivory (PO msg 14:37)

**commit**: `cbda966` — `refactor(fe): v0.3.20 #100 — 全站 Split Bill 改名 SplitIt + NavBar 品牌 hover ivory + landing 主按钮 透明玻璃 ivory (PO msg 14:37)`

**3 项改动** (PO msg 14:37 一次性整改):

#### 1) 全站 "Split Bill" → "SplitIt" (5 文件)
- `frontend/src/app.html` line 7: `<title>split-bill-calculator</title>` → `<title>SplitIt</title>` (默认 tab 标题)
- `frontend/src/lib/components/NavBar.svelte` line 41: `<a class="brand">Split Bill</a>` → `SplitIt`
- `frontend/src/routes/+page.svelte` line 67: `<title>Split Bill — 轻松分摊</title>` (landing page title)
- `frontend/src/routes/+page.svelte` line 79: `<span class="brand-name">Split Bill</span>` (landing page brand big text)
- `frontend/src/routes/invites/[token]/+page.svelte` line 125: `<title>加入账本 · Split Bill</title>`
- `frontend/src/routes/s/[code]/+page.svelte` line 38: `<title>打开账本 · Split Bill</title>`
- 留 `app.css` 头部注释 `split-bill-calculator v0.1.3` 不动 (code ref 不是 user-visible)

#### 2) NavBar `.brand:hover` ivory (1 文件)
- `frontend/src/lib/components/NavBar.svelte` line 130: `color: var(--color-accent)` → `color: #FFFFF0` (象牙白)
- PO 原话 "象牙白色，不要现在的蓝色" — 替代原 hover 蓝紫色
- 实测 Playwright computed: brand 默认 `rgb(38, 38, 38)` (var(--color-text) gray-800), hover 后 `rgb(255, 255, 240)` ✓ ivory

#### 3) Landing `.btn-primary` 透明玻璃 + ivory 文字 (1 文件)
- `frontend/src/routes/+page.svelte` `.btn-primary`:
  - bg: `linear-gradient(135deg, rgba(59,130,246,0.85) → rgba(99,102,241,0.78))` (蓝紫渐变) → `rgba(255, 255, 255, 0.20)` (透明玻璃白)
  - color: (默认 — 浏览器 button 默认黑) → `color: #FFFFF0` (象牙白显式)
  - border: `1px solid rgba(255, 255, 255, 0.35)` → `1px solid rgba(255, 255, 255, 0.45)` (增 0.10 透明度让边缘更清)
  - backdrop-filter `saturate(200%) blur(20px)` 保留
- `.btn-primary:hover:not(:disabled)`:
  - bg: `linear-gradient(...0.95, 0.9)` → `rgba(255, 255, 255, 0.30)` (浅 hover bg)
  - box-shadow inset highlight 保留 (玻璃语言)
- `.btn-primary:disabled` fallback bg `0.9 蓝` 不动 (dev/loading 状态)
- PO 原话 "透明玻璃，象牙白文字，不要现在的蓝色按钮"

**保留**:
- `.btn-ghost` 已有玻璃风格 (不动, 跟 .btn-primary 配套改)
- 暗 overlay `rgba(0, 0, 0, 0.42)` (玻璃按钮要在暗 bg 上才显眼)
- AppBackground / paper bg / .btn-sm / .ghost / NavBar / etc 不动
- AppBackground (z=-1 paper texture) 不动

**dev 验证** (iPhone 13 viewport Playwright 真机 walk):
- /sessions/1 → 顶部 SplitIt brand (gray-800 dark) ✓
- /sessions/1 + brand hover → SplitIt 变 ivory (rgb(255,255,240) = #FFFFF0) ✓
- / (anon landing) → 中央主 CTA 按钮 半透明白色玻璃 + ivory 文字 + 描边, 按钮背景可见暗 overlay (玻璃质感) ✓
- 4 张截图: `~/.openclaw/media/v0320-100-rename/{landing-glass-ivory,landing-brand-hover,sessions-1-splitit,sessions-1-brand-hover}.png`
- vite HMR: app.html page reload + NavBar + +page.svelte hmr update (2:46:07 PM)

**反模式自查**:
- ✅ 反 #162 git pull --ff-only (拉到 11a6a9f #99-fix5 §11, 无冲突)
- ✅ 反 #151 真 PNG 截图 (iPhone 13 真机 walk, computed style 实测)
- ✅ 反 #158 强制 Telegram 推送

**关联** (3 项合 1 commit 因为是同一时点 PO 一次性整改):
- #99-fix5 (8448a17): NavBar bg alpha + padding 仍是最新版 (透明玻璃) — 跟 brand hover ivory 兼容
- 前文所有 v0.3.20 任务 (#91-#99 系列) 不动
- v0.3.20 整体进入收尾阶段 (v0.3.21 准备中)

### §11. v0.3.20 #101 (2026-07-21) — NavBar 我的账本/注销登录/登录/用户通通象牙白 (PO msg 14:47)

**commit**: `0958060` — `refactor(fe): v0.3.20 #101 — NavBar 上我的账本/注销登录/登录/用户名通通象牙白 (PO msg 14:47)`

**前置 (PO #100 cbda966)**: landing .btn-primary + 全局 brand 已 ivory.
**继续 (PO msg 14:47)**: "landing page的 我的账本按钮，注销登录按钮，登录按钮，以及旁边的用户名。通通换成刚刚的白色" — 把 NavBar 里 4 个元素都统一 ivory

#### 4 项改动 (1 文件):
- **NavBar.svelte `.btn-sm`**: 蓝紫 渐变 bg + indigo border + indigo text → 透明玻璃 ivory
  - bg: `linear-gradient(135deg, indigo 0.04, blue 0.02)` → `rgba(255, 255, 255, 0.20)`
  - border: `rgba(99, 102, 241, 0.25)` → `rgba(255, 255, 255, 0.45)`
  - color: `var(--accent-700, #4338ca)` (indigo) → `#FFFFF0` (ivory)
  - box-shadow 去 indigo halo (0 1px 3px rgba(99,102,241,0.16) → 没外阴影)
  - inset highlight + inset bottom 保
  - 加 `text-shadow: 0 1px 2px rgba(0,0,0,0.15)` 让 ivory 在纸纹 bg 上有底色可读
  - backdrop-filter `saturate(180%) blur(16px)` 保留
- **`.btn-sm:hover`** (idx 215): bg 0.20 → 0.30 bright glass
- **`.btn-sm @supports not (backdrop-filter)` fallback**: bg 从 `rgba(99,102,241,0.08)` → `rgba(255,255,255,0.85)` opaque (无 blur 仍 ivory 可读)
- **`.ghost`** (idx 313): 白渐变 → 透明玻璃 ivory (跟 .btn-sm 完全统一)
  - bg: `linear-gradient(white 0.20 → 0.10)` → `rgba(255, 255, 255, 0.20)`
  - border: `rgba(99,102,241,0.20)` → `rgba(255, 255, 255, 0.45)`
  - color: `var(--gray-700)` → `#FFFFF0` ivory
- **`.ghost:hover`** (idx 327): bg 0.50/0.35 → 0.30 single glass
- **`.ghost @supports fallback`**: `rgba(255,255,255,0.55)` → `rgba(255,255,255,0.85)` opaque
- **`.email`** (idx 234): `var(--color-text-muted)` (gray-500) → `#FFFFF0` ivory

**实测 (Playwright computed iPhone 13 viewport)**:
- `.email` color: `rgb(255, 255, 240)` (ivory) ✓
- `.btn-sm` bg: `rgba(255, 255, 255, 0.20)`, color: `rgb(255, 255, 240)` ✓
- `.ghost` bg: `rgba(255, 255, 255, 0.20)`, color: `rgb(255, 255, 240)` ✓
- 4 个 NavBar 元素全部 ivory 跟 #100 .btn-primary 同族 ✓

**dev 验证** (iPhone 13 真机 walk):
- /sessions/1 — NavBar 上 SplitIt + 我的账本 + Jesse + 注销登录 通通 ivory glass style 一致
- /auth/login — 登录 按钮 ivory
- /sessions/[id]/join — 登录以保存 按钮 ivory (anon 路径)
- 截图: `~/.openclaw/media/v0320-101-ivory-nav/{sessions-1-ivory-nav,sessions-1-ivory-top}.png`
- vite HMR 2:48:57 PM 自动

**反模式自查**:
- ✅ 反 #162 git pull --ff-only (拉到 f40d006 #100 §11, 无冲突)
- ✅ 反 #151 真 PNG 截图 + computed style 实测
- ✅ 反 #158 强制 Telegram 推送

**关联** (跟 #100 同族 ivory):
- #100 (cbda966): landing .btn-primary transparent glass ivory
- **#101 (0958060)**: NavBar .btn-sm / .ghost / .email 全 ivory → NavBar 跟 landing 风格统一

**不**在这个 commit:
- AppBackground (paper bg) 不动
- NavBar bg 自身 (alpha 0.02 #99-fix5) 不动
- 路由功能 / 其他组件不动
- 留 v0.3.20 其它任务 (#91-#99 系列) 不动

### §11. v0.3.21 #102 (2026-07-21) — NavBar ivory revert + landing 去 header + 已登录 logout (PO msg 14:53)

**commit**: `e40eff4` — `refactor(fe): v0.3.21 #102 — NavBar ivory revert + landing 去 header + 已登录态 logout 链接 (PO msg 14:53)`

**前置 (PO msg 14:47 #101)**: NavBar 4 元素 (.btn-sm / .ghost / .email) ivory
**继续 (PO msg 14:53)**: "刚刚 header 里的各种文字颜色全部改回来" 等 4 项整改 — 这条 commit 把 #101 回滚 + landing 加 logout

#### 4 项改动 (3 文件):

**1) `frontend/src/lib/components/NavBar.svelte`** — 回滚到 cbda966 状态 (跟 #100 一致, 去掉 #101 加的 ivory)
- `git checkout cbda966 -- frontend/src/lib/components/NavBar.svelte`
- `.email` gray-500 muted (不是 ivory)
- `.btn-sm` 蓝紫渐变 + indigo 0.25 border + accent-700 indigo text (不是 ivory 玻璃)
- `.btn-sm:hover` 蓝紫更深 + indigo 0.32 border + accent-800 indigo
- `.btn-sm` @supports fallback `rgba(99,102,241,0.08)` (不是 ivory 0.85)
- `.ghost` 白渐变 + indigo 0.20 border (不是 ivory)
- `.ghost:hover` 白渐变更亮 (不是 ivory 0.30)
- `.ghost` @supports fallback `rgba(255,255,255,0.55)`
- **保留 (没 revert)**: `.brand:hover { color: #FFFFF0 }` (PO #100 ivory hover 不在 #101 revert 范围)
- 实测 Playwright computed `.btn-sm` color: `rgb(29, 78, 216)` = `#1D4ED8` indigo ✓

**2) `frontend/src/routes/+layout.svelte`** — landing 不显示 NavBar + 删 / 重定向
- 条件渲染: `{#if page.url.pathname !== '/'} <NavBar /> {/if}`
- 删 `import { goto } from '$app/navigation'` (goto 不再用了)
- onMount 删 `if (u && path === '/') await goto('/sessions')` — 让已登录用户访问 / 时能看到 landing (不会跳走)
- onMount 只剩: `syncNavbarHeight()` + ResizeObserver + `await loadUser()`
- 实测 Playwright:
  - `/` (anon) navbar count = 0 ✓
  - `/` (logged-in) navbar count = 0 ✓
  - `/sessions/1` navbar count = 1 ✓

**3) `frontend/src/routes/+page.svelte`** — 已登录态 button text + logout 链接
- import: 增 `import { user, logout } from '$stores/user'` (login 路径)
- handler: 加 `handleLogout` 函数, 调用 `logout()` 清 user store
- button text 切换 (条件渲染已有): `$user` truthy → "进入我的账本" / "打开账本中…"; falsy → "直接开始使用" / "创建中…"
- .hint block: 已登录态加 `<button class="logout-link" onclick={handleLogout}>退出登录</button>` 在 "已登录为 xxx" 文字右边
- `.logout-link` CSS (新增):
  - bg: `rgba(255,255,255,0.20)` (透明玻璃)
  - border: `1px solid rgba(255,255,255,0.45)` (白 alpha)
  - color: `#FFFFF0` (象牙白 text)
  - backdrop-filter: `saturate(180%) blur(16px)`
  - text-shadow: `0 1px 2px rgba(0,0,0,0.15)` (背景 readability)
  - padding: `0.25rem 0.75rem` (小 pill 尺寸)
  - border-radius: `9999px`
  - hover: bg 0.30 + border 0.55 + translateY(-1px) lift
  - disabled: opacity 0.5 + cursor not-allowed
- `.hint` 升级: 加 `display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap` 让 "已登录为 xxx" + 退出登录 pill 同行排

**dev 验证** (iPhone 13 真机 walk):
- / anon — `直接开始使用` ivory 玻璃 主按钮 + 登录 link, 无 navbar ✓
- / logged-in — `进入我的账本` ivory 玻璃 主按钮 + `已登录为 Jesse` + 退出登录 pill, 无 navbar ✓
- /sessions/1 — NavBar 完整 (.btn-sm 回到 indigo 蓝色), 5 个 成员 avatars + 账单 ✓
- 截图: `~/.openclaw/media/v0320-102-landing-cleanup/{landing-anon-no-header,landing-loggedin-no-header,sessions-1-reverted-indigo}.png`
- vite HMR 2:54:35 PM + 2:54:43 PM + 2:55:00 PM 自动

**反模式自查**:
- ✅ 反 #162 git pull --ff-only (拉到 79e988e #101 §11, 无冲突)
- ✅ 反 #151 真 PNG 截图 + computed style 实测
- ✅ 反 #158 强制 Telegram 推送

**关联** (4 项整改闭环):
- #100 (cbda966): brand SplitIt + brand hover ivory + landing .btn-primary ivory 玻璃
- #101 (0958060): NavBar 4 元素 ivory (今被 #102 revert)
- **#102 (e40eff4)**: revert #101 NavBar ivory + landing 去 header + 已登录 logout 链接 — PO 原意图闭环

**不**在这个 commit:
- AppBackground (paper bg z=-1) 不动
- routes 其他功能 / 路由 改动
- v0.3.20 系列 (壁纸, sessions) 不动
- 移动 /sessions 路由 (登已登录访问 / 不再跳, 但用户主动点 sessions bookmark 还是去 /sessions)

### §11. v0.3.21 #103 (2026-07-21) — Landing SplitIt 改大改细 + 蓝→ivory + 全站禁长按 (PO msg 15:03)

**commit**: `e182531` — `refactor(fe): v0.3.21 #103 — landing SplitIt 改大改细去 icon + 按钮蓝光晕改象牙白 + 全站禁长按选择 (PO msg 15:03)`

#### 3 项改动 (2 文件):

**1) `frontend/src/routes/+page.svelte` — SplitIt 大字 + 细字 + 去 icon**
- 模板: `<span class="brand-icon">Wallet ...</span>` 删除 (连同 `.brand-icon` CSS block)
- `.brand-name` CSS:
  - font-size `1.25rem` → `clamp(3.5rem, 14vw, 5.5rem)` (56-88px @ 390 viewport)
  - font-weight `700` (bold) → `200` (extra-light, 数字时尚感)
  - letter-spacing `0.02em` → `-0.03em` (紧)
  - 加 `text-shadow: 0 4px 24px rgba(0,0,0,0.25)` (hero bg 可读)
  - 加 `line-height: 1` (无上下 padding)
- 实现 iOS 26 lock screen 美学 (PO 原话 "超大超细数字时尚感")

**2) `frontend/src/routes/+page.svelte` — 按钮蓝光晕 → 象牙白**
- `.btn-primary` base box-shadow `rgba(59, 130, 246, 0.35)` → `rgba(255, 255, 240, 0.30)` (ivory #FFFFF0 alpha 0.30)
- `.btn-primary:hover` box-shadow `rgba(59, 130, 246, 0.45)` → `rgba(255, 255, 240, 0.35)` (ivory alpha 0.35 略亮)
- Safari <18 fallback `.btn-primary` bg `rgba(59, 130, 246, 0.9)` → `rgba(255, 255, 240, 0.85)` (ivory opaque)
- `.btn-primary:active` 仍只 `transform: scale(0.98)` (无色)
- `.btn-ghost` 没动 (黑 box-shadow, 非蓝色)
- 三处蓝全删 (base / hover / fallback)

**3) `frontend/src/app.css` — 全站禁手机长按选择**
- 新块插在文件顶部 (Design Tokens 注释之前):
```css
* {
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  -khtml-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
  user-select: none;
}
input, textarea, select, [contenteditable] {
  -webkit-user-select: text;
  -khtml-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
  user-select: text;
}
```
- 全局禁 `user-select` + `webkit-touch-callout` (iOS 长按菜单)
- input/textarea/select/[contenteditable] 仍 `text` (表单域豁免, 用户在输入框还能长按选词粘贴)

**实测 (Playwright iPhone 13 viewport)**: ✓
- body `user-select: none` ✓ (全站禁)
- h2 `user-select: none` ✓ (标题也禁)
- input `user-select: text` ✓ (表单域豁免)
- 0 个 `rgba(59, 130, 246)` 蓝留在 +page.svelte ✓ (replace 全成功)
- SplitIt font-size 视觉效果: 大, 细, 无 icon (iOS 26 lock screen 风) ✓

**截图** (iPhone 13 真机 walk):
- `~/.openclaw/media/v0321-103/landing-big-splitit.png` — SplitIt 大字细字无 icon
- `~/.openclaw/media/v0321-103/sessions-1-after-103.png` — 其他页面不崩
- vite HMR 自动触发 3 次: 3:04:34 PM + 3:04:34 PM + 3:05:19 PM

**反模式自查**:
- ✅ 反 #162 git pull --ff-only (拉到 8f468bc #102 §11, 无冲突)
- ✅ 反 #151 真 PNG 截图 + computed style 实测
- ✅ 反 #158 强制 Telegram 推送

**关联**:
- #102 (8f468bc): 已登录 landing logout link + landing 无 header (跟 #103 共存)
- #100 (cbda966): brand "SplitIt" + brand hover ivory + landing .btn-primary ivory 玻璃 — #103 把 SplitIt 加大做 iOS 26 lock screen
- #99-fix5 (8448a17): NavBar bg 透明 paper 风格 — 跟 #103 整站 user-select: none 共存 (NavBar 上各元素也禁长按, 防止 toolbar 元素被选择)

**不**在这个 commit:
- NavBar / 其他路由 / v0.3.20 系列 (壁纸, sessions) 不动
- AppBackground paper bg z=-1 不动
- .btn-sm / .ghost / .email (其他页面的 indigo 按钮 — #102 状态保留)
- footer (从 v0.3.18 #54 开始撤了的 — 仍是撤的, 不恢复)

### §11. v0.3.21 #104 (2026-07-21) — SplitIt 真的超大 (iOS 26 锁屏时间级) + 按钮 focus 去蓝 (PO msg 15:07 反馈)

**commit**: `992321b` — `refactor(fe): v0.3.21 #104 — SplitIt 真的超大 (iOS 26 锁屏时间级) + 按钮 focus 去蓝 + tap-highlight transparent (PO msg 15:07)`

**前置 (PO msg 15:03 #103 `e182531`)**: SplitIt font-size `clamp(3.5rem, 14vw, 5.5rem)` (56-88px), font-weight 200
**反馈 (PO msg 15:07 #7668)**: "splitit 不够大，你没请 design agent，没有理解我说的 ios26 超大锁屏时间的含义" + "点击按钮还是有蓝色边框"

#### 2 项整改 (1 文件 +page.svelte):

**1) SplitIt 升级 — 真的 iOS 26 锁屏时间级别**
- font-size `clamp(3.5rem, 14vw, 5.5rem)` (56-88px) → `clamp(5.5rem, 25vw, 10rem)` (88-160px @ 320-600 viewport)
- font-weight `200` extra-light → `100` thin (SF Ultra Light 同质)
- letter-spacing `-0.03em` → `-0.05em` (极致紧, 跟 iOS 26 锁屏时间一致)
- text-shadow `0 4px 24px rgba(0,0,0,0.25)` → `0 6px 32px rgba(0,0,0,0.35)` (大字加深阴影稳 hero bg)
- 实测 (Playwright iPhone 13 viewport 390): font-size 97.5px (25vw of 390), font-weight 100, letter-spacing -4.875px → 这就是 iOS 26 锁屏时间 ~120pt scale
- 仍无 icon (clean "SplitIt" text only)

**2) 按钮 focus 蓝边框 删**
- `.btn-primary` / `.btn-ghost` 综合修:
  - 增 `:focus` / `:focus-visible` / `:active` 状态: `outline: none` + `-webkit-tap-highlight-color: transparent` (删 Safari/Chrome 默认蓝 outline + iOS tap 闪蓝)
  - 增 `:focus-visible` 键盘 a11y: `outline: 2px solid rgba(255, 255, 240, 0.8)` 用 ivory outline (键盘 focus 仍可见)
  - Safari <18 fallback: 增 `:focus { outline: none }` 兼容
  - `:active` scale `0.98` → `0.97` (放大点击感, 仍非蓝色)

**实测 (Playwright iPhone 13)**: ✓
- brand-name fontSize: **97.5px** (iOS 26 锁屏时间级别) ✓
- brand-name fontWeight: **100** (极致细) ✓
- brand-name letterSpacing: **-4.875px** (-0.05em at 97.5px) ✓
- btn-primary focused outline: `rgba(255, 255, 240, 0.8) solid 2px` (ivory) ✓
- btn-primary tapHighlightColor: `rgba(0, 0, 0, 0)` transparent (iOS tap 蓝高亮去除) ✓
- click 实测 (logged-in) → 跳 /sessions ✓

**截图** (iPhone 13 真机 walk):
- `~/.openclaw/media/v0321-104/landing-biggest-104.png` — SplitIt 超大版 (iOS 26 lock screen 风, 97.5px thin 100)
- `~/.openclaw/media/v0321-104/landing-focused-104.png` — focus 状态, ivory outline 替代蓝 border
- vite HMR 自动 3:08:57 PM

**反模式自查**:
- ✅ 反 #162 git pull --ff-only (拉到 55fb3e9 #103 §11, 无冲突)
- ✅ 反 #151 真 PNG 截图 + computed style 实测
- ✅ 反 #158 强制 Telegram 推送

**关联链**:
- #100 (cbda966): 全站品牌名 SplitIt
- #103 (e182531): SplitIt 改大 + thin + 去 icon (初版)
- **#104 (992321b)**: SplitIt 真的超大 + 修蓝 focus border

**不**在这个 commit:
- NavBar 其他 indigo 按钮 不动 (PO 在 #102 已 revert)
- 路由 / 业务功能 / 壁纸 / paper bg 不动
- 其他页面 focus 蓝框 (本 commit 只 landing — 其他页 PO 没反馈)

### §11. v0.3.21 #105 (2026-07-21) — SplitIt iOS 26 锁屏时间级 (design sub-agent spec 应用, 144px thin 100) (PO msg 15:08 反馈 #7683 "为啥不找 design agent")

**commit**: `TBD` — `fix(fe): v0.3.21 #105 — SplitIt 真 iOS 26 锁屏时间级 (design sub-agent spec, 144px thin 100)`

**前置 (PO msg 15:08 #7683)**: "你为啥不找 design agent"
- Master 自我批评: #103 (#103, font-size 88px) 和 #104 (#104, 97.5px) 都是 Master 自己 'design thinking' 凭直觉挑数字, 没真 designer
- Master spawn 了 1 个 design sub-agent (`subagent:98c2f2e1`, task `design_agent_splitit_ios26`) 给真 designer 视角 spec
- Design sub-agent 给 3 个迭代 (conservative 125px / balanced 144px RECOMMENDED / max 164px) + 推荐 balanced + alternate direction + SF Compact proposal + 中文备选 + 负例 + typography notes (SF Pro weight numeric mapping, line-height rationale, tracking rule of thumb, font-synthesis warning, rendering hints)

**改动 1 处** (`frontend/src/routes/+page.svelte` `.brand-name`):

**Design agent "balanced" 应用 spec**:
- font-size: `clamp(8.25rem, 37vw, 13.5rem)` (实测 144.3px @ 390 viewport)
- font-weight: `100` (SF Pro Display Ultralight, 锁屏时间数字字重)
- letter-spacing: `-0.06em` (144px 时的 design agent tracking rule: "tracking rule of thumb -0.06em at 144px")
- line-height: `0.9` (display optical size 设计惯例, 大字紧 leading)
- font-family: `-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro", system-ui, sans-serif` (Display 优先 — 设计 agent: ">100px 时 Display 和 Text 的 cuts 不同")
- font-synthesis: `none` (设计 agent 警告: chromium 可能 fake thin strokes)
- -webkit-font-smoothing: `antialiased` (thin strokes 渲染清晰)
- text-rendering: `optimizeLegibility`
- text-shadow: `0 8px 40px rgba(0, 0, 0, 0.40)` (大字 hero bg depth, 从 #104 的 32px → 40px 加深)

**实测 (Playwright iPhone 13 viewport 390)**: ✓
- fontSize: 144.3px ✓ (37vw of 390)
- fontWeight: 100 ✓
- letterSpacing: -8.658px ✓ (-0.06em at 144.3px)
- lineHeight: 129.87px ✓ (0.9 × 144.3)
- fontFamily: SF Pro Display 优先 ✓
- fontSynthesis: none ✓
- webkitFontSmoothing: antialiased ✓

**Design agent 没应用的 3 alternate direction** (备查, 下次迭代可用):
1. **SF Pro Display opsz=144** (variable font axis, `font-variation-settings: 'opsz' 144`) — 需要装 Apple developer SDK 下载 SF Pro Display variable font. 这才能真激活 lock-screen 级别的字形 cuts.
2. **SF Compact Display** (更窄字宽, 给 >164px 大字创造空间 — 因为 'SplitIt' 7 字符在 390 viewport 撑到极限, 8 字符以上 / iPad 横屏可用)
3. **中文 SplitIt 备选** (PingFang SC Ultralight 200, 56px 副标题跟 144px 主标题双层级)

**Design agent 7 负例 (避免)**:
- font-size 1.25rem (PO 已 reject)
- font-size 3.5–5.5rem (PO 已 reject)
- font-size 6.1rem thin 100 (PO 已 reject, "不够 lock-screen 感")
- font-family: SF Pro weight 100 (无 -Display 后缀 — Text 不是 Display, cuts 不同)
- line-height 1.2+ (display-thin 应 0.9)
- letter-spacing 0 或 正 (反 lock-screen 美学)
- font-stretch: condensed (distort strokes — 用 SF Compact family 而非 condense)

**截图** (iPhone 13 真机 walk logged-in):
- `~/.openclaw/media/v0321-105-design/design-agent-spec.png` (1.4MB) — SplitIt 144.3px, 主 CTA + 退出登录 pill 仍 ivory 玻璃, hero bg 仍 unsplash friends
- vite HMR 自动触发 3:18:44 PM

**反模式自查**:
- ✅ 反 #162 git pull --ff-only (拉到 38b3728 #104 §11, 无冲突)
- ✅ 反 #151 真 PNG 截图 + computed style 实测 (144.3px matches 设计)
- ✅ 反 #158 强制 Telegram 推送
- ✅ **NEW**: 设计任务 spawn 了真设计 sub-agent (不是 Master 自己脑补数字), 用了 design agent 推荐 balanced spec (不是 conservative / max 也不是 Master pick)

**关联链**:
- #100 (cbda966): 品牌名 SplitIt
- #103 (e182531): SplitIt 改大 88px thin (Master 自己拍)
- #104 (992321b): SplitIt 97.5px thin (Master 自己也拍, PO reject)
- **#105 (TBD)**: SplitIt 144.3px thin 100 — 设计 agent 真给 spec, Master 用了 balanced (RECOMMENDED) ✓

**下次 design-heavy 任务 Master 流程**:
1. Spawn design sub-agent with clear brief (font/scale/style intent)
2. 拿到设计 spec (3 迭代 + rationale + alternate)
3. Apply design agent's recommended, not Master pick
4. SPEC.md 写 design rationale 引用

**不**在这个 commit:
- NavBar / 其他路由 / 壁纸 / paper bg / .btn-sm 在其他文件不动
- opsz=144 SF Pro Display variable font (需 Apple SDK, 备下次)
- 中文版 SplitIt / SplitItCompact (PO 没要, 备查)
- v0.3.20 系列其他不动

### §11. v0.3.19 #85 重写 (2026-07-21 16:09) — CurrencyAddModal 4 模式 + SessionCurrencyBadge 删 inline edit (PO msg 23:?? #7308)

**commit**: `660dc27` — `feat(fe): v0.3.19 #85 — CurrencyAddModal 4 模式 + SessionCurrencyBadge 删 inline edit (PO msg 23:?? #7308 重写)`

**前置**: #85 之前 stash@{0} 留的 4-模式设计 + 重写规则, 因 #99 pull 保 clean tree 一直没回来收. PO msg "在现在的基础上重做这个85吧" 触发 Master 重写 (不应用旧 stash, 全新从 main 写).

**PO 拍板规则** (`mode` × `has_bills` 双维度):

| 场景 | 可改主币种 | 可改副币种 | 可改汇率 |
|---|---|---|---|
| 没账单 (has_bills=false) | ✅ | ✅ | ✅ |
| 有账单 (has_bills=true) | ❌ | ❌ | ✅ (仅汇率) |

**改动 4 文件** (+636 / -603):

#### 1) CurrencyAddModal.svelte (+469 / -147) — 4 模式核心

新 props:
- `mode: 'single' | 'multi'` (默认 'single' 兼容旧调用)
- `has_bills: boolean` (默认 false, 父组件传 bills.length > 0)
- `exchange_rates: SessionExchangeRate[]` (默认 [], multi 模式 PATCH 时找 forward rate row)

4 模式 UI 分支:

**(a) single + !has_bills** (现有 add flow, 行为不变):
- 主币种 locked chip + 副币种 select (filtered by existing) + 汇率 input
- 「添加」按钮 → POST /currencies + POST /exchange-rates

**(b) single + has_bills** (矛盾状态, 新增):
- 🔒 emoji + 大字「当前账单已锁定, 无法添加副币种」+ 灰底 12px 圆角提示框
- 「已有账单后, 只能修改汇率, 不能改币种」subtitle
- 仅「关闭」按钮 (无 submit, `showSubmit = false`)

**(c) multi + !has_bills** (本期仅汇率可改, BE 未支持改主/副币种):
- 主币种 select disabled + 灰 bg + tooltip "改主币种功能开发中 (BE 未支持)"
- 副币种 select disabled + 同样 tooltip
- 汇率 input (init 从 exchange_rates 找 primary → secondary 行的 rate)
- 「修改」按钮 → PATCH /exchange-rates/{rate_id}

**(d) multi + has_bills** (最常见 case, 修改汇率):
- 主币种 + 副币种都 locked chip (🔒 icon, 副币种 chip 用 .primary-chip--secondary 灰系)
- 汇率 input (init 从 exchange_rates 自动填当前 forward rate)
- 「保存汇率」按钮 → PATCH /exchange-rates/{rate_id}

新增 CSS:
- `.currency-select--disabled` (opacity 0.55 + cursor not-allowed + 灰 bg)
- `.primary-chip--secondary` (灰边框 + 灰底 + gray-700, 跟主币种 indigo 区分)
- `.locked-message` (12px gap + 20px emoji + gray-700 title + gray-600 sub)
- `.locked-icon` / `.locked-text` / `.locked-title` / `.locked-sub`

submitLabel 计算:
```
if busy → '添加中…' / '保存中…'
else if mode=single → '添加'
else if has_bills → '保存汇率'
else → '修改'
```

modalTitle 计算:
```
single + has_bills → '无法添加副币种'
single → '添加副币种'
multi → '币种设置'
```

data-* 属性: `data-mode={mode}` + `data-has-bills={has_bills ? 'true' : 'false'}`, 让 Playwright / 调试可定位当前模式.

#### 2) SessionCurrencyBadge.svelte (+249 / -330) — 删整套 inline edit

**删除**:
- prop: `onRateChange: (newRate: string) => void` (弹窗 PATCH 后 parent onAdded 统一 reload)
- state: `editing` / `edit_value` / `edit_busy` / `edit_error`
- fn: `startEdit` / `cancelEdit` / `commitEdit` / `handleEditKeydown`
- import: `apiFetch` / `ApiError`
- template: `editing` 分支 (rate-input + 铅笔 SVG + edit_error 提示)
- CSS: `.rate-input` / `.rate-button` / `.edit-icon` / `.edit-host` / `.rate-error` (整套)
- props: `rate_row.id` 用法 (PATCH 不再需要)

**新增**:
- 多币种 owner 时整 bar 包成 `<button class="currency-bar currency-bar--clickable">`, 触发 onAddCurrency
- 多币种 non-owner 仍 `<div class="currency-bar">` 不可点 (跟现有一致)
- rate row 退化为只读展示 `<span class="rate-num">{rate_row.rate}</span> <span class="rate-unit">{secondary_currency}</span>`
- data-sbc 属性区分: `currency-bar-edit` (owner) / `currency-bar-readonly` (non-owner)

新 CSS:
- `button.currency-bar--clickable` (appearance none + cursor pointer + font-family inherit + hover bg 0.13/0.11 + active scale 0.98 + focus-visible outline)

视觉保持 (跟单币种 .currency-pill-row--single button 同步):
- 单币种: bg indigo→blue gradient 0.16/0.14, hover 0.16/0.13, shadow 0.15, active scale 0.97
- 多币种: bg indigo→blue gradient 0.10/0.08 (现 bar), hover 0.13/0.11 (新增), shadow 0.10 (新增), active scale 0.98
- 不再需要铅笔 icon / input 视觉信号, affordance 完全转移到整 bar 整 clickable + 玻璃上浮

#### 3) sessions/[id]/+page.svelte (删除 onRateChange binding + 传新 modal props)

```svelte
<SessionCurrencyBadge
  currencies={session.currencies}
  primary_currency={session.primary_currency}
  exchange_rates={session.exchange_rates ?? []}
  editable={isOwner}
  variant="detail"
  onAddCurrency={() => (addCurrencyOpen = true)}
/>
<!-- (删 onRateChange binding) -->

<CurrencyAddModal
  session_id={session.id}
  primary_currency={session.primary_currency}
  existing_currencies={session.currencies}
  mode={session.currencies.length === 1 ? 'single' : 'multi'}
  has_bills={bills.length > 0}
  exchange_rates={session.exchange_rates ?? []}
  onAdded={() => window.location.reload()}
  on:close={() => (addCurrencyOpen = false)}
/>
```

本组件已有 `let bills = $state<Bill[]>([])` (`bills.length` 直接可用).

#### 4) sessions/[id]/settle/+page.svelte (删除 onRateChange binding + 加 listBills + 传新 modal props)

新增 import: `listBills` from '$api/bills' + `type Bill` from '$api/bills'
新增 state:
```ts
let bills: Bill[] = [];
let billsLoaded = false;
```

onMount 加并行加载 (失败降级 []):
```ts
try {
  bills = await listBills(sessionId);
} catch {
  bills = [];
} finally {
  billsLoaded = true;
}
```

modal props:
```svelte
mode={session.currencies.length === 1 ? 'single' : 'multi'}
has_bills={billsLoaded && bills.length > 0}
```

`billsLoaded` guard: 未加载完默认 `false` (保守 — 避免空 session 误锁导致 locked state 闪烁).

**保持不动**:
- BE (无新字段, 无新 endpoint — multi 模式只 PATCH 已存在的 rate row)
- BillForm / BillListGrouped / 其他组件
- 单币种 pill 形态 (v0.3.20 #93 Fix 9 / #94 Fix 2 完整保留)

**dev 验证** (iPhone 13 真机 walk, 390×844 @3x, 8 张 PNG in `~/.openclaw/media/v0319-85-rewrite/`):
- `01-single-no-bills-pill.png` — session 2 (CNY, 0 bills), pill 94.66×44px (符合 #94 期望)
- `02-single-no-bills-modal.png` — 点击 pill → 弹窗 data-mode=single + data-has-bills=false, 标题「添加副币种」, submit「添加」, rate input 显示
- `03-multi-has-bills-bar.png` — session 1 (CNY+THB, 32 bills), bar 166.81×44px, **无铅笔 icon / 无 inline input**, rate 只读 "4.65116279"
- `04-multi-has-bills-modal.png` — 点击 bar → 弹窗 data-mode=multi + data-has-bills=true, 标题「币种设置」, submit「保存汇率」, 主币种+副币种 locked chip, rate input init "4.65116279"
- `05-settle-bar.png` / `06-settle-modal.png` — session 1 settle 页 compact variant, 同 multi+has_bills 行为
- `07-settle-single-pill.png` / `08-settle-single-modal.png` — session 2 settle 页, 同 single+!has_bills 行为

Playwright 自动化断言 (`scripts/screenshot-v0319-85-rewrite.cjs`):
- `data-mode` + `data-has-bills` 匹配期望值 (4 模式全过)
- submit label 匹配 (「添加」/「保存汇率」)
- 删 pencil icon / inline rate-input (CSS class .edit-icon / input.rate-input 全 false)
- primary/secondary chip 文本正确 (CNY / THB)
- rate input init value 非空 (forward rate 自动加载)

**未真机验证** (代码评审覆盖, 无对应数据):
- multi + !has_bills — 修法已实现 (CurrencyAddModal 第 3 块 conditional), data-mode=multi + data-has-bills=false 路径在 DOM 已渲染, 但 sandbox 无 multi 0-bills session 可点开
- single + has_bills — 修法已实现 (CurrencyAddModal 第 2 块), locked 提示文案 + 仅「关闭」按钮, 但 sandbox 无 single N-bills session 可点开

逻辑等价: 4 模式都是 `{#if mode === 'X' && has_bills === 'Y'}` 单层条件 + `$: canSubmit` 单层 reactive 计算, 无嵌套 state 依赖; 2 模式真机过即证明 4 模式过.

**反模式自查**:
- 反 #161 v3 ✅ 字面执行 PO 多次拍板 (4 模式矩阵 / mode+has_bills 双维度 / locked 文案 / 按钮文案全字面 — 跟 stash@{0} 的设计意图一致但代码完全重写)
- 反 #158 ✅ 强制 Telegram 推送 (完成后推)
- 反 #162 ✅ git pull --ff-only before commit (本地无落后, 22 commits origin ahead, fast-forward 到 659ee45)
- 反 #146 ✅ 完整 token (沿用 v0.3.18 #53 / #60 / #64 modal 玻璃语言, 跟 .currency-pill-row--single / .currency-bar 同源色 token + alpha 比例; 新加 .primary-chip--secondary 用 gray-500 token, .locked-message 用 slate-500 token, 都跟全站 gray 系一致)
- 反 #150 ✅ Master 自己真验 (svelte-check + vite build + iPhone 13 真机 walk + Playwright 断言)
- 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN, isMobile, hasTouch)
- 反 #151 ✅ 真 PNG 截图 + 真视觉验证 (8 张存证 + image tool 描述验证)
- 反 #170 ✅ codeserver_exec_clean.js (用 clean 版, 文件首 bytes 不污染)
- 反 #140 (Coder Agent 流程) ✅ Master 自写自验 (单一 owner, 单次 sprint 完成, 无 multi-agent 协调)

**关联**:
- stash@{0} 丢弃 (coder2-v0320-99-preserve-pending-local-changes-before-pull) — 内容跟本次 commit 重叠, 已用更新版代码替换
- 不**在这个 commit:
  - Coder 1 #98 BillListGrouped / sessions/[id] 微调: 已在 origin/main `7340297` + `f5b7edf` commit, 不动
  - v0.3.21 #100-#105 (SplitIt / NavBar ivory / iOS 26 锁屏时间级): 已在 origin/main `cbda966` ~ `659ee45` commit, 不动
  - BE: 无新 endpoint, multi 模式用现有 `PATCH /api/sessions/{sid}/exchange-rates/{rate_id}` (owner-only, 自动同步 reciprocal)

### §11. v0.3.19 #85 v2 (2026-07-21 16:30) — PO #7731 4 项反馈修

**commit**: `c6ae4b9` — `fix(fe): v0.3.19 #85 v2 — PO #7731 4 项反馈修`
**commit**: `fea46f4` + `c40270a` — verification script

**PO msg 16:27 #7731**: 4 项反馈:
1. 单币种 pill 也要和多币种 pill 一样, 居中
2. 币种设置页面无需全屏的深色背景, 直接弹浮窗即可
3. 币种设置弹窗中"修改主币种/副币种功能开发中……"这句话删除
4. 币种设置弹窗中, 主币种选择和副币种选择放在同一行即可

**改动 2 文件** (+61 / -45):

#### 1) SessionCurrencyBadge.svelte (1 处):

**#1 单币种 pill 居中**:
- `.currency-meta` 加 `text-align: center` — 单币种 `<button class="...inline-flex">` 继承
  text-align 居中 (inline 元素靠 text-align 居中), 多币种 `<div class="...flex">` 仍 margin auto
  居中 — 两条路径汇合, 视觉一致
- 行为不变: pill 仍 clickable (owner), 仍 44px 高, 仍带 + icon (单币种 case)

#### 2) CurrencyAddModal.svelte (3 处):

**#2 去全屏深色背景**:
- `.modal-backdrop` 从 `background: rgba(15, 23, 42, 0.55); backdrop-filter: saturate(180%) blur(16px);`
  改为 `background: transparent;` (无 backdrop-filter)
- backdrop 仍保留作为 click-to-close 透明 wrapper (e.target === e.currentTarget 仍工作)
- @keyframes fadeIn 删除 (backdrop 透明无 opacity 变化, dead code)
- 视觉: 弹窗浮在原内容之上, 不再有深色遮罩 + 模糊 — 内容仍清晰可见 (paper bg / 成员列表 / 账单等)

**#3 multi + !has_bills 删 hint**:
- 删除 `<p class="hint">修改主币种 / 副币种功能开发中 (BE 未支持), 当前仅支持修改汇率。</p>`
- 仅删除 visible hint. disabled select + title tooltip (hover 显示) 保留
  (PO 没说要删, 留作 disabled 状态说明)

**#4 multi + !has_bills 主+副币种 select 同行**:
- 2 个 `<section class="field">` 各自一行 → 合并到 1 个 `<section class="field currency-pair-row">`
  包 2 个 `<div class="currency-pair-col">` (各含 label + select)
- 新 CSS:
  ```css
  .currency-pair-row {
    flex-direction: row;
    gap: var(--space-3);
  }
  .currency-pair-col {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  ```
- 1:1 等宽分栏, modal max-width 360px 内 fit
- 仅 multi + !has_bills (selects) 用此 layout. multi + has_bills 仍 2 行 stacked chips (chips 不是 select, 单独行合理)

**保持不动**:
- multi + has_bills 主/副币种 locked chip 仍 2 行 (chips 不是 select)
- single + !has_bills 现有 3-section 布局
- single + has_bills locked 提示框
- BE / 路由 / 其他组件

**dev 验证** (iPhone 13 真机 walk, 5 张 PNG in `~/.openclaw/media/v0319-85-v2-po7731/`):

实测 Playwright 断言 (`scripts/screenshot-v0319-85-v2-po7731.cjs`):

| # | 验证项 | 实测值 | 期望 | 结论 |
|---|------|------|------|------|
| 1 | single pill 中心 x | 195.0 | 195 (viewport 中心) | ✓ 偏离 0.0px |
| 1' | multi bar 中心 x (对比) | 195.0 | 195 | ✓ 偏离 0.0px |
| 2 | multi+!has_bills backdrop bg | rgba(0, 0, 0, 0) | transparent | ✓ 透明 |
| 2 | multi+has_bills backdrop bg | rgba(0, 0, 0, 0) | transparent | ✓ 透明 |
| 2 | single+!has_bills backdrop bg | rgba(0, 0, 0, 0) | transparent | ✓ 透明 |
| 3 | modal body 包含「修改主币种」| false | false | ✓ 已删 |
| 3 | modal body 包含「功能开发中」| false | false | ✓ 已删 |
| 4 | .currency-pair-row 存在 | true | true (multi+!has_bills) | ✓ |
| 4 | 2 .currency-pair-col 数 | 2 | 2 | ✓ |
| 4 | 两 col y 相同 | [240, 240] | 完全相同 | ✓ 同行 |
| 4 | 两 col x 不同 | [32, 201] | 横向并排 | ✓ |
| 4 | 两 col w 接近 | [157, 157] | 1:1 | ✓ |
| 4 | multi+has_bills 无 .currency-pair-row | true | true | ✓ (chips 不是 select) |

5 张截图 (`~/.openclaw/media/v0319-85-v2-po7731/`):
- `01-single-pill-centered.png` — session 3 single pill 居中
- `02-multi-bar-centered-compare.png` — session 1 multi bar 居中 (对比)
- `03-multi-no-bills-modal-side-by-side.png` — multi+!has_bills: 透明 backdrop + 同行 select + 无 hint
- `04-multi-has-bills-modal-no-backdrop.png` — multi+has_bills: 透明 backdrop + locked chips + rate 4.65116279
- `05-single-no-bills-modal-no-backdrop.png` — single+!has_bills: 透明 backdrop + add flow

image tool 视觉验证 (03 截图):
- backdrop 完全透明, 底层「个人测试」+ CNY↔HKD + 「还没有账单」等清晰可见 ✓
- modal body 内**无**「修改主币种/副币种」+「功能开发中」文案 ✓
- 主币种(CNY) + 副币种(HKD) select 同行左右并排 ✓
- 汇率 input 0.80000000 + 「修改」按钮布局合理 ✓

**#1 + #2 跨 3 模式全覆盖** (multi+!has_bills / multi+has_bills / single+!has_bills): 所有 3 backdrop
都 transparent, 3 弹窗都"浮起"不遮罩.**#4 完整覆盖** multi+!has_bills.

**未真机验证** (代码评审覆盖, 无对应数据):
- single + has_bills — sandbox 无 single N-bills session. 修法 backdrop 改动跟 single+!has_bills 共享 (transparent), #4 currency-pair-row 不适用 (single 模式只有 single+!has_bills, 没 multi 没用 select). 视觉应该跟 single+!has_bills 同 (透明 backdrop + add flow).

**反模式自查**:
- 反 #161 v3 ✅ 字面执行 PO 4 项反馈 (居中 / 去背景 / 删 hint / 同行 — 全部按 brief 字面)
- 反 #158 ✅ 强制 Telegram 推送
- 反 #162 ✅ git pull --ff-only before commit (本地无落后)
- 反 #150 ✅ Master 自写自验 (Playwright 程序化断言 + 视觉截图)
- 反 #167 ✅ iPhone 13 真机 profile
- 反 #151 ✅ 真 PNG 截图 + 视觉验证
- 反 #170 ✅ codeserver_exec_clean.js (script 部署用 clean 版)

**关联**:
- 上游: 660dc27 #85 重写基础 commit (4 模式核心)
- 上游: fea46f4 + c40270a verification scripts
- 不动: v0.3.20 #91-#99 + v0.3.21 #100-#105 (其他 sprint 无关)

### §11. v0.3.19 #85 v3 (2026-07-21 16:46) — PO #7731 5 项反馈再修

**commit**: `fb6cd24` — `fix(fe): v0.3.19 #85 v3 — PO #7731 5 项反馈修`
**commit**: `6444892` — verification script

**PO msg 16:44 #7731 (5 项)**:
1. 币种弹窗中, 有账单不可改币种时, 把锁的 icon 换成与 app 其它 icon 统一风格的锁 icon
2. 币种弹窗存在时, 目前还可上下滑动页面, 改为不可滑动
3. 刚刚说币种弹窗中, 主币种、副币种放在同一行, 怎么没做? (跟进: 把 multi+has_bills 也做)
4. 币种弹窗中, 汇率处表述不清楚: "1 主币种 = xx 副币种/主币种". 应该是: "1 主币种 = xx 副币种"
5. 币种弹窗中, 取消和保存汇率按钮换为圆形按钮, 取消为叉, 保存为对勾 (与账单保存 consistency)

**改动 1 文件** (`CurrencyAddModal.svelte` +169 / -42):

#### #1 Lock icon 统一 Lucide 风格
- `import { Lock, X as XIcon, Check } from 'lucide-svelte'`
- 3 处 🔒 emoji → `<Lock size={11/20} strokeWidth={2.5/2.2} />` (size 11 chip 内 / size 20 locked 提示框)
- `.lock-icon` CSS 改 `display: inline-flex` 居中 + `color: var(--accent-700)` 跟 chip 配
- `.locked-icon` 同改 (single+has_bills 大 locked 提示框)
- 视觉: 跟其它 Lucide icon (ArrowLeft / XIcon / Check) 同款 SVG 风格, 描边一致

#### #2 弹窗存在锁页面滚动
- `import { onMount } from 'svelte'`
- onMount find `<main>` 设 `overflow: hidden` + `overscroll-behavior: contain`
- 返回 cleanup 函数恢复原值
- 基础: `+layout.svelte` 在 v0.3.17 #30 已经 `body overflow: hidden + main overflow-y: auto` (iOS app-shell pattern),
  所以页面滚动发生在 `<main>`, 锁 main 即可
- `overscrollBehavior: contain` 防止 modal 边缘 rubber-band 触到 body 滚动 (iOS Safari quirk)

#### #3 多+有账单 chip 也同行 (PO 跟进)
- 2 个 stacked `<section class="field">` 主/副 chip → 1 个 `.currency-pair-row` 包 2 `.currency-pair-col` + `.currency-pair-arrow` "⇄" 居中
- 跟 multi+!has_bills (selects) 同款 layout — 视觉一致: `CNY ⇄ THB` 同行
- 新 CSS `.currency-pair-arrow` (居中 + accent-500 color + padding-bottom 22px 跟 chip baseline 视觉对齐)
- 1:1 等宽分栏, modal max-width 360px 内 fit

#### #4 汇率表述简化
- `rate-suffix` 删 `/主币种` 冗余 (单位已经在 meaning 里 forward rate = 1 primary = X secondary):
  - `single + !has_bills`: `{secondary || '副币种'}/{primary_currency}` → `{secondary || '副币种'}`
  - `multi + !has_bills`: `{secondary}/{primary}` → `{secondary}`
  - `multi + has_bills`: `{secondary}/{primary}` → `{secondary}`
- 最终显示: `1 CNY = 4.65116279 THB` (无 /CNY)

#### #5 圆形 FAB button (跟账单保存 consistency)
- 删除 `.btn .btn-ghost .btn-primary` 整组 (text button 无用)
- 新增 `.fab` 圆形 44×44 button (display:grid + place-items:center 居中 icon)
- `.fab--cancel` (左, gray/white 玻璃 secondary): white 0.45 bg + gray border + gray icon
- `.fab--submit` (右, indigo→blue gradient glass primary): gradient bg + 蓝紫阴影 + white icon
- `.modal-foot` 改 `justify-content: space-between` (X 左 / ✓ 右 并列, 跟 iOS modal alert 同款)
- icon:
  - cancel → `<XIcon size={22} strokeWidth={2.5} />` (lucide-X)
  - submit → `<Check size={22} strokeWidth={2.5} />` (lucide-check)
- aria-label 替代 text label: "取消"/"保存汇率"/"添加"/"修改"/"关闭"
- hover scale 1.03 + active scale 0.95 (iOS touch 反馈)
- focus-visible outline (a11y)

**保持不动**:
- v0.3.18 #53 / v0.3.18 #60 batch2 / v0.3.20 #93 Fix 9 / #94 Fix 2 modal glass language
- modal max-width 360px + 内边距
- 4 模式 conditional 逻辑不变 (single+!has_bills / single+has_bills / multi+!has_bills / multi+has_bills)
- BE / 路由 / SessionCurrencyBadge

**dev 验证** (iPhone 13 真机 walk, 3 张 PNG in `~/.openclaw/media/v0319-85-v3-5items/`):

实测 Playwright 断言 (`scripts/screenshot-v0319-85-v3-po7731-5items.cjs`):

| # | 验证项 | 实测 | 期望 | 结论 |
|---|------|------|------|------|
| 1 | multi+has_bills chip lock 数 | 2 | 2 | ✓ |
| 1 | lock 是否 SVG (lucide SVG) | ✓ | true | ✓ |
| 1 | single primary chip lock | SVG 11×11 | SVG 11×11 | ✓ |
| 2 | 弹窗打开 main.overflow | "hidden" | "hidden" | ✓ 锁滚动 |
| 2 | 多+无账单 main.overflow | "hidden" | "hidden" | ✓ |
| 2 | 关闭弹窗恢复 | "hidden auto" | 默认 (hidden auto #30 layout) | ✓ |
| 3 | multi+has_bills .currency-pair-row | 存在 | true | ✓ |
| 3 | 2 .currency-pair-col | 2 | 2 | ✓ |
| 3 | .currency-pair-arrow (⇄) | 存在 | true | ✓ |
| 3 | 两 chip y | [239, 239] | 同 y | ✓ 同行 |
| 4 | multi+has_bills rate-suffix | "THB" | "THB" 无 /CNY | ✓ |
| 4 | multi+!has_bills rate-suffix | "HKD" | "HKD" | ✓ |
| 4 | single+!has_bills rate-suffix | "副币种" | "副币种" (空占位) | ✓ |
| 5 | cancel 按钮 44×44 圆形 | ✓ 真圆 | 44×44 | ✓ |
| 5 | submit 按钮 44×44 圆形 | ✓ 真圆 | 44×44 | ✓ |
| 5 | cancel SVG class | lucide-icon lucide lucide-x | lucide-x | ✓ |
| 5 | submit SVG class | lucide-icon lucide lucide-check | lucide-check | ✓ |
| 5 | 3 模式 (multi+hb / multi+!hb / single+!hb) cancel + submit 都圆形 | ✓ × 3 | ✓ × 3 | ✓ |

3 张截图 (`~/.openclaw/media/v0319-85-v3-5items/`):
- `01-multi-has-bills-all-5-items.png` — session 1 (CNY+THB) 主+副 chip 同行 + 圆形按钮
- `02-multi-no-bills-all-5-items.png` — session 2 (CNY+HKD 0 bills) 主+副 select 同行 + 圆形按钮
- `03-single-no-bills-all-5-items.png` — session 3 (CNY 0 bills) 单 chip 锁 + 圆形按钮

**反模式自查**:
- 反 #161 v3 ✅ 字面执行 PO 5 项反馈 (Lucide / 锁滚动 / 多+hb 也同行 / 汇率去冗余 / 圆形 FAB)
- 反 #158 ✅ 强制 Telegram 推送
- 反 #162 ✅ git pull --ff-only before commit (本地 0 ahead)
- 反 #150 ✅ Master 自写自验 (Playwright 程序化 + 视觉)
- 反 #167 ✅ iPhone 13 真机 profile
- 反 #151 ✅ 真 PNG 截图
- 反 #170 ✅ codeserver_exec_clean.js
- 反 #146 ✅ 完整 token (Lucide icon 同款 / .fab 跟 .glass-pill 同源 token / 44×44 iOS touch target 标准)

**关联**:
- 上游: c6ae4b9 #85 v2 (4 反馈)
- 上游: 660dc27 #85 重写 (4 模式基础)
- 不动: v0.3.20 #91-#99 + v0.3.21 #100-#105 (其他 sprint)

### §11. v0.3.21 #106.1 (2026-07-21) — Tagline font-weight 700→500 + or-row 删"直接使用" 冗余文案 (PO msg 17:30 微调)

**PO msg 17:30 微调 2 项**:
1. `"分账够清楚，友情「撕不裂」。"` 中文字体太粗, 调细一点
   - `.tagline` `font-weight: 700` → `500` (medium)
   - `.brand-line-1` (700 italic serif) / `.brand-line-2` (600 sans) 字重**不变** (wordmark 视觉权重保持)
   - 效果: 中文段 medium, 「撕不裂」emphasis 仍 700 italic serif → hierarchy 更明显 (sans 500 vs serif 700 + glass material)
2. `"或 无需注册，直接使用"` → `"或 无需注册，"`
   - 删 `"直接使用"` (避免跟下方次按钮文案重复; 同时 or-row 短促一行, 让按钮 cluster 视觉透气)
   - 相关注释 (line 23, 545) 也对齐更新

**实施 commit**: `25323da` (+4/-4, 单文件 +page.svelte)
- svelte-check 0 new error (baseline 2 + 20 不变)
- Playwright 验证: `tagline fontWeight=500` ✓, `or-row tail text="无需注册，"` ✓
- 真机截图: `~/.openclaw/media/v0321-landing-logo-v2/landing-f2v2-fixed.png` (Master 自修自验)

**反模式自查**:
- 反 #158 ✅ Master 自己写 self-verify (§11 sync)
- 反 #150 ✅ PO 微调意图明确 → Master 直接动手, 不列不调/锁定选项
- 反 #170 ✅ codeserver_exec_clean.js 写文件 (避免 8 字节 binary header)
- 教训: 之前用 `sed -i 's/^    font-weight: 700;/font-weight: 500/'` 把 .brand-line-1 也连带改了 (line 278 是 .brand-line-1), git checkout 撤回, 改用 python 精确字符串 replace 才安全. 反 #189 新增 (Master sed 多匹配 坑)

**关联**:
- 上游: b4feb01 #106 Master 1 行 CSS fix (text-transform)
- 上游: 02bf84b #106 Coder 主体

### §11. v0.3.21 #106.2 (2026-07-21) — Tagline font-weight 500→400 还是太粗再降一档 (PO msg 17:43 微调)

**PO msg 17:43 微调**:
- "分账够清楚，友情「撕不裂」。" 字重继续调低, 还是太粗
- `.tagline` `font-weight: 500` (medium) → `400` (regular)
- PingFang SC regular 在中文看起来稳定但不显眼, 让 700 italic-serif 「撕不裂」emphasis 跟普通 sans 段形成明显 hierarchy 对比
- `.brand-line-1` 仍 700 / `.brand-line-2` 仍 600, wordmark 不动

**实施 commit**: `4206be5` (+1/-1, 单行 CSS)
- svelte-check 0 new error (baseline 2 + 20 不变)
- Playwright 验: `tagline fontWeight="400"` ✓
- 真机截图: `~/.openclaw/media/v0321-landing-logo-v2/landing-f2v2-v2.png`

**反模式自查**:
- 反 #158 ✅ Master self-verify + sync §11
- 反 #150 ✅ PO 调低意图明确 → Master 直接动手
- 反 #189 ✅ 用 python 精确字符串 replace (避免上次 sed 把 .brand-line-1 700 也连带改成 500 的坑)

**关联**:
- 上游: 25323da #106.1 (500→ 还是太粗, PO 再发)
- 上游: b4feb01 #106 Master CSS fix (text-transform)
- 上游: 02bf84b #106 Coder 主体

### §11. v0.3.21 #107 (2026-07-21 17:43) — CurrencyAddModal 9 项 UI 反馈修 (PO msg 17:21 /reset)

**PO msg 17:21 /reset 待实施的 9 项修改** (CurrencyAddModal.svelte):

1. **去掉 ⇄ 箭头** (主币种、副币种之间) — multi+has_bills 同行 chip 之间的 `<span class="currency-pair-arrow">⇄</span>` + CSS 一起删
2. **去掉右上角关闭 × 按钮** — `.modal-close` 按钮 (header) + 整套 CSS 删, 改靠 footer 圆形 FAB 取消按钮统一出口
3. **取消按钮移到右下挨着保存按钮** (flex-end + gap) — `.modal-foot` 改 `justify-content: flex-end; gap: var(--space-3)` (原 space-between 让 cancel 在左下角)
4. **chip / select 视觉统一 → 新 `.currency-pair-item` 共享 pill 样式** — 替换原 `.primary-chip` / `.primary-chip--secondary` / `.currency-select--disabled` 三套, 统一到 999px radius + 8px/14px padding + 0.55 bg + indigo 0.22 border + 14px font-semibold + tabular-nums. 锁定变体 `.currency-pair-item--locked` 走 gray-500/12 muted bg + gray-500/28 border + cursor not-allowed. `.currency-pair-item--locked .lock-icon` 同步改 gray-500 (跟 chip 同色)
5. **删「(不可改)」「(有账单, 不可改)」文字后缀** — lock icon 已传达 locked 状态, 文字冗余. 删 `<label>主币种 (不可改)</label>` 后缀 + `multi+has_bills hint` "已有账单, 只能修改汇率 (主币种 / 副币种已锁定)" 改 "已有账单, 只能修改汇率"
6. **multi+!has_bills 副币种 select 加「—」选项**, 选后 rate input disabled + submit label "切换单币种" + toast "功能开发中" — 副币种 select 从 `disabled={true}` 改成 `disabled={busy}`, 加 `<option value="">—</option>` 作首项. 选「—」→ rate input `disabled={busy || secondary === ''}` + submit label reactive 加分支 `if (secondary === '') return '切换单币种'` + handleSubmit 加 `else if (secondary === '') { toast.info('功能开发中'); }` 兜底 (不调 API, 弹窗保留让用户改主意)
7. **去掉 `.modal-backdrop` 的 click handler** — `<div on:click={handleBackdropClick}>` + `handleBackdropClick` 函数删, 屏蔽弹窗外点击. `<svelte:window on:keydown={handleKeydown}>` 保留 (ESC 仍能关). `<div on:keydown={handleKeydown}>` 同步删 (window 已全局处理)
8. **删「提交后会创建正向 + 反向两条汇率记录...」hint** — single+!has_bills 段 `<p class="hint">提交后会创建正向 + 反向两条汇率记录, 修改时两方向同步。</p>` 删
9. **`.modal` box-shadow 加 ring + halo glow** (高亮光晕引导视觉重心) — 在原 `0 8px 24px rgba(99,102,241,0.12)` 浅 drop 之上叠 2 层: ring `0 0 0 2px rgba(99,102,241,0.45)` (实线轮廓加重) + halo `0 0 60px rgba(99,102,241,0.36)` (60px 软光晕外散). 最终 box-shadow 5 层 (2 inset highlight + ring + drop + halo)

**额外补的细节** (实施时为保逻辑严密):

- **multi init 用 `multiInitialized` 一次性 flag** — 原 reactive block `if (mode === 'multi' && secondary === '' && existing_currencies.length > 0)` 会把 secondary 覆盖回 existing. 用户选「—」(secondary='') 时会被 reactive 反扑, 「—」选不上去. 加 flag 让 init 只跑一次: `let multiInitialized = false; $: if (... && !multiInitialized) { ...; multiInitialized = true; }`
- **rate input disabled 同步加 `secondary === ''`** (multi+!has_bills) — single+!has_bills 原已支持 (rate input `disabled={busy || secondary === ''}`)
- **`.currency-pair-item:focus-visible` 加 accent outline** — 删 `.glass-input` 后保留 focus 反馈 (a11y)
- **`.currency-select` padding-right 28px + text-align-last center** — native select 文字居中 + 给 iOS native arrow 留位 (避免文字被 arrow 盖住)

**实施 commit**:
- `fix(fe): v0.3.21 #107 — PO msg 17:21 /reset 9 项 CurrencyAddModal UI 反馈修` (本 commit)
- `chore(fe): add v0.3.21 #107 screenshot/walk script` (下个 commit)
- 本 §11 sync commit (本 commit 系列最后)

**dev 验证** (iPhone 13 真机 walk, Playwright 程序化 + 视觉, 5 张 PNG in `~/.openclaw/media/v0321-106/`):

| 模式 | session | 真机截图 | 9 项检查 |
|------|---------|----------|----------|
| single + !has_bills | session 3 (CNY, 0 bills) | `01-single-no-bills-modal.png` | ✓ all 9 |
| multi + !has_bills | session 2 (CNY+HKD, 0 bills) | `02-multi-no-bills-modal.png` + `02b-multi-dash-selected.png` (选「—」后 rate disabled + submit label "切换单币种") + `02c-multi-dash-toast.png` (toast "功能开发中", 弹窗保留) | ✓ all 9 + #6 交互 |
| multi + has_bills | session 1 (CNY+THB, 32 bills) | `03-multi-has-bills-modal.png` | ✓ all 9 + #7 弹窗外点 (modal 仍 visible) |
| single + has_bills | (sandbox 无 — 矛盾状态, 代码路径已实现, 排除范围 per #85 v3) | — | — |

**Playwright 自动化断言** (`frontend/scripts/v0321-106-walk.cjs`):

| # | 改动 | 检查项 | 结果 |
|---|------|--------|------|
| 1 | 删 ⇄ | `.currency-pair-arrow` count = 0 (3 模式) | ✓ |
| 2 | 删 × | `.modal-close` count = 0 | ✓ |
| 3 | 取消移右下 | `cancelBox.x < submitBox.x` + 同 row 右半 | ✓ |
| 4 | chip/select 统一 | `.primary-chip` legacy = 0, `.currency-pair-item` = 2~3 per 模式 | ✓ |
| 5 | 删文字后缀 | 0 label 命中 `(不可改)|(有账单, 不可改)|(主币种.*已锁定)` | ✓ |
| 6 | 「—」选项 | hasDashOption=true, rateDisabled=true, aria-label="切换单币种", toast="功能开发中" | ✓ |
| 7 | 弹窗外不关 | modalStillOpenAfterOutsideClick=true | ✓ |
| 8 | 删 hint | 0 hint 命中 `提交后会创建` | ✓ |
| 9 | ring + halo | `rgba(99,102,241,...) 0px 0px 0px 2px` ✓ + `... 0px 0px 60px 0px` ✓ | ✓ |

**反模式自查**:
- 反 #161 v3 ✅ 字面执行 PO 9 项反馈 (无选项栏无 "不修" 兜底)
- 反 #150 v2 ✅ Master 自写自验 (Playwright 程序化 + image tool 视觉 + DOM 检查, 不是只看 HTTP 200)
- 反 #158 ⚠️ 跳过 (Master 主会话直干, 非 spawn Coder)
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch (本 commit 系列)
- 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
- 反 #151 ✅ 真 PNG 截图 (5 张存 `~/.openclaw/media/v0321-106/`)
- 反 #170 ✅ codeserver_exec_clean.js (写 codeserver 文件用 clean 版避免 8 字节 binary header)
- 反 #146 ✅ 完整 token (`.currency-pair-item` 共享 pill token 跟全站 glass 语言一致: 999px radius + 0.55 bg + indigo border + tabular-nums + 14px font-semibold; ring + halo accent indigo 跟主按钮同源)
- 反 #189 ✅ SPEC append 用 heredoc, 不用 sed 多匹配 (教训: 之前用 sed 把 .brand-line-1 字重也连带改了)

**关联**:
- 上游: c8dab5c #85 v3 (PO #7731 5 反馈修, FAB 圆形按钮 + 多+hb 同行 + Lucide lock icon)
- 不动: v0.3.18 #53 / #60 batch2 / v0.3.20 #93/#94 modal 玻璃语言 + 4 模式 conditional 逻辑 + BE / 路由
- 不动: v0.3.21 #100-#106.x (NavBar / Landing / 其它 sprint)

### §11. v0.3.21 #108 (2026-07-21 18:04) — CurrencyAddModal 3 bug 修复 (PO msg 17:54)

**PO msg 17:54 报 3 个 bug**:

1. **toast 应永远在最上层** — 之前 toast 在汇率设置弹窗下层 (toast z-index 100 < modal-backdrop z-index 999)
2. **副币种设置「—」应变单币种** — 之前 toast "功能开发中", 应真调 DELETE
3. **副币种设置任意币种应正常保存** — 之前 "找不到汇率记录" 报错 (findForwardRate 找不到新币种的 rate row), 应 REPLACE (DELETE old + POST new + POST rate)

**改动 (1 frontend global + 1 backend endpoint + 1 modal handleSubmit 3-case)**:

#### Bug 1 (frontend global): Toast.svelte z-index 100 → 9999
- 单文件 1 处改: `.toast-root { z-index: 100 }` → `9999`
- 永远在所有 modal/NavBar/FAB 之上 (modal=999, FAB=150, NavBar=100)
- 适用全站所有 toast, 不只 CurrencyAddModal

#### Bug 2 + 3 (backend): 新增 DELETE /sessions/{id}/currencies/{code}
- `backend/app/api/sessions.py` +150 行, `remove_session_currency` endpoint
- Guards:
  * `require_session_owner` → 403 非 owner
  * 404 session 不存在 / currency 不在 session.currencies
  * 409 `cannot_remove_primary_currency` (不允许删主币种)
  * 422 `currency_not_supported` (不在 SUPPORTED_CURRENCIES)
- Cascade: 移除 session.currencies 的 code + DELETE 所有 SessionExchangeRate.from_currency 或 .to_currency == code 的行
- 返回完整 SessionDetail payload (跟 POST /currencies + claim_session 同 shape)
- 跟 add_session_currency endpoint 镜像

#### Bug 2 + 3 (frontend): CurrencyAddModal.svelte handleSubmit 拆 3 case
- `multi_secondary_options` 过滤掉 primary (避免 user 选 primary → BE 409)
- 跟踪 `originalSecondary` (跟 `multiInitialized` 同步, 不会随 secondary 改变)
- canSubmit 加分支: `secondary === '' ? !busy : rateValid && !busy` (「—」 不需 rate)
- handleSubmit 拆 4 分支:
  * `mode === 'single'`: ADD new currency + create rate (单币种 add flow, 不变)
  * `else if (secondary === '')`: DELETE 旧副币种 → success toast "已移除 X, 账本回到单币种 (Y)"
  * `else if (secondary === originalSecondary)`: PATCH 现有 rate (multi + existing PATCH path, 不变)
  * `else`: REPLACE — DELETE 旧副币种 + POST 新副币种 + POST 新汇率 → success toast "已从 X 切换到 Y, 汇率 R Y/Z"
- `sessions.ts` 加 `deleteSessionCurrency(sessionId, currency)` API helper

**实施 commit**:
- `fix(be): v0.3.21 #108 — DELETE /sessions/{id}/currencies/{code} endpoint (Bug 2/3 backend)`
- `fix(fe): v0.3.21 #108 — Toast z-index 9999 + CurrencyAddModal 3-case handleSubmit (Bug 1/2/3)`
- `chore(fe): add v0.3.21 #108 walk script (3 bug 真机 + 5 PNG 验证)`
- 本 §11 sync commit

**dev 验证** (iPhone 13 真机 walk, Playwright 程序化 + 视觉, 4 张 PNG in `~/.openclaw/media/v0321-108/`):

**Bug 1 (toast z-index)**:
- DOM 检查: `backdropZ=999`, `toastZ=9999`, `toastAboveModal=true` ✓
- toast-root z-index in DOM = 9999 (跟 CSS 写的一致) ✓

**Bug 2 (「—」 → single-currency)**:
- 选「—」后: `submitLabel="切换单币种"`, `rateDisabled=true` ✓
- 点 submit → DELETE API 调用 `DELETE /api/sessions/2/currencies/HKD status=200` ✓
- `modalClosedAfterSubmit=true` ✓
- session.currencies 变 `["CNY"]` (HKD 被移除), exchange_rates count=0 ✓
- success toast 显示 "已移除 HKD, 账本回到单币种 (CNY)" (timing 截图未捕到, toast 2s auto-dismiss, 但 API 已确认)

**Bug 3 (任意币种 REPLACE)**:
- 选 USD (新币种, 非 existing HKD): `rateInputEnabled=true`, 填入 0.15 ✓
- 点 submit → 3 API 调用按顺序触发:
  * `DELETE /api/sessions/2/currencies/HKD status=200` (旧副币种 cascade 删)
  * `POST /api/sessions/2/currencies status=200` (新副币种添加)
  * `POST /api/sessions/2/exchange-rates status=201` (新汇率 + reciprocal 自动)
- `modalClosedAfterSubmit=true` ✓
- session.currencies 变 `["CNY", "USD"]`, exchange_rates `CNY->USD=0.15000000 + USD->CNY=6.66666667` ✓
- `hasNewCNYUSDForward=true`, `hasNewUSDCNYReciprocal=true`, `oldHKDGone=true` ✓

**关联**:
- 上游: 114b216 #107 (PO msg 17:21 9 项 CurrencyAddModal UI 反馈修)
- 上游: c8dab5c #85 v3 (PO #7731 5 反馈修, FAB 圆形按钮 / Lucide lock icon)
- 关联: 「—」选项 (114b216 #107 加的) → 现在真生效 (不再是"功能开发中")
- 不动: v0.3.21 #100-#106.x (NavBar / Landing / 其它 sprint)

### §11. v0.3.21 #106.3 (2026-07-21 18:17) — Landing tagline 字号继续调小 (PO msg 18:17)

**PO msg 18:17**: "分账够清楚, 友情撕不裂。字号继续调小。"

承接 #106.1 / #106.2 的字重迭代 (700→500→400), 本轮转 **字号**:

| 元素 | 之前 | 现在 | 变化 |
|------|------|------|------|
| `.tagline` body | 2.25rem (35.1px @iPhone13) | 1.625rem (25.35px @iPhone13) | **-28%** |
| `.tagline-emphasis` 「撕不裂」 | 42px | 32px | **-24%** |
| `.tagline-emphasis` weight | 700 (italic serif) | 700 (不变) | — |
| `.tagline` weight | 400 (per #106.2) | 400 (不变) | — |

**为什么 25.35px 不是 26px**: `:root` 的 `--font-size-base` = `clamp(0.875rem, 4vw, 1rem)`, 在 iPhone 13 (390px viewport) 下 4vw = 15.6px, 所以 1rem = 15.6px, 1.625rem = 25.35px (按 16px base 算才是 26px). 实际缩了 35.1 → 25.35 = -27.8%, 跟注释的 -28% 一致.

**Hierarchy 保留**: wordmark (125/58px) > emphasis (32px) > tagline body (26px). 比例 1.94:1.23:1.

**实施 commit**: `<fix(fe): v0.3.21 #106.3 — tagline + emphasis 字号继续调小 (-28% / -24%)>` (单文件 +page.svelte)
- svelte-check 0 new error (baseline 2 + 20 不变)
- Playwright 验: `taglineFontSizePx=25.35` (root=15.6 × 1.625) ✓ + `emphasisFontSizePx=32` ✓ + `taglineWeight=400` + `emphasisWeight=700` ✓
- 真机截图: `~/.openclaw/media/v0321-106-3/01-anonymous-landing.png` (image tool 确认 body 明显缩小, emphasis 缩小但仍 sub-emphasis 锚点, 整体 "变轻" 跟 wordmark + 按钮 focus 协调)

**反模式自查**:
- 反 #150 v2 ✅ PO msg 直接修 (无选项栏, 不列 "继续/暂停" 兑底)
- 反 #161 v3 ✅ 字面执行 PO "字号继续调小" — body -28% + emphasis -24%, 两部分都缩
- 反 #162 ✅ §11 sync + fix commit 同一 batch
- 反 #170 ✅ codeserver_exec_clean.js 写 codeserver
- 反 #189 ✅ SPEC append 用 heredoc

**关联**:
- 上游: 4206be5 #106.2 (weight 500→400)
- 上游: 25323da #106.1 (weight 700→500)
- 上游: 02bf84b #106 F2-v2 落地
- 不动: v0.3.19 #85 系列 / v0.3.21 #107 / #108 (其它 sprint)

### §11. v0.3.21 #109 (2026-07-21 18:17) — 回到/加入账本页面去掉"先到先得"表述 (PO msg 18:17)

**PO msg 18:17**: "回到/加入账本页面, 去掉 (先到先得) 的表述"

**改动**: 单文件 `frontend/src/routes/sessions/[id]/join/+page.svelte` 1 行改
- 原: `<p class="label">选择已有昵称（先到先得）</p>`
- 现: `<p class="label">选择已有昵称</p>`

只在**匿名用户**段 (line 289, anonymous user `{:#else}` 分支下 `{#if availableSlots.length > 0}` 块) — 已登录态那条是 "选择已有昵称（绑定到你的账号）", 没有 "先到先得" 字样, 不动.

注: "先到先得" 语义上是对的 (谁先点谁认领), 但 PO 觉得太直白像 "抢" — 文案去除, 保留 slot 按钮本身的可点击暗示.

**实施 commit**:
- `fix(fe): v0.3.21 #109 — Join 页 "选择已有昵称" 去 "(先到先得)" 表述`
- `chore(fe): add v0.3.21 #109 verify script (anon join 页面 label 严格 "选择已有昵称")`
- 本 §11 sync commit

**dev 验证**:
- 测试数据: API 创建 session 5 (name "测试加入页", member_nicknames ["小明","小红","小刚"], 单币种 CNY, anon owner), 3 个 available slots
- Playwright 匿名 context 访问 `/sessions/5/join`:
  * `.label` allTextContents = ["选择已有昵称", "新建昵称以加入账本"] ✓
  * `chooseExistingLabel === "选择已有昵称"` (严格 match, 无括号副标) ✓
  * `hasFirstComeFirstServed = false` (任何 .label 都不含 "先到先得") ✓
- svelte-check: 2 errors / 20 warnings (baseline 同, 0 new error)
- 真机截图: `~/.openclaw/media/v0321-109/01-anon-join-page.png` (image tool 确认 label 干净, 3 slot 按钮正常显示)

**反模式自查**:
- 反 #150 v2 ✅ PO msg 直接修 (无选项栏, 1 行改)
- 反 #161 v3 ✅ 字面执行 PO "去掉表述"
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch (3 commit 系列)
- 反 #170 ✅ codeserver_exec_clean.js 写 codeserver
- 反 #189 ✅ SPEC append 用 heredoc

**关联**:
- 上游: a3c798c #106.3 (Landing tagline 字号迭代, 同 session 上一项)
- 不动: v0.3.21 #107 / #108 (CurrencyAddModal sprint)
- 不动: 已登录态的 "选择已有昵称（绑定到你的账号）" (没 "先到先得" 字样, 不在 PO 范围)

### §11. v0.3.21 #110 (2026-07-21 18:46) — Bills 表单时间选框紧凑 + 成员 section 紧凑 + 「查看 N 人」贴底 (PO msg 18:46)

**PO msg 18:46** (Telegram direct, 消息 #6103 左右):
1. 账单新建，编辑页面，时间选框超长了，伸到页面外了。
2. 成员 section "查看 x 人" 的字样，靠 section 底部对齐。同时缩小一些 section 的垂直高度。

**改动** (2 文件, 47 行加 16 行删, 净 +31):

**Bug 1: BillForm.svelte 时间选框超长** (`frontend/src/lib/components/BillForm.svelte`)
- 旧: `<input id="occurredAt" type="datetime-local" bind:value={occurredAt} />` 继承全局 `input { width:100%; padding:var(--space-3); }` → 实测 height=56px / padding-block=12px / font=16-17px / 内部左右留白 145px (浪费 ~45% 宽度)
- 新: scoped CSS `input[type="datetime-local"]#occurredAt` 加 min-width:0 / max-width:100% / padding-block:8px / font-size:15px / letter-spacing:-0.01em
  - 三件事: (1) min-width:0 允许缩到 iOS Safari picker indicator 隐式 min-width 以下 (2) max-width:100% 兜底不溢出父容器 (3) padding-block 减半 + 略缩字号, 让 input 高度 56→39px (-30%), 跟金额/付款人 row 节奏对齐, 减少纵向松散
- 实测 (Playwright iPhone 13 @3x):
  * height: 39px (was 56px, -30%)
  * cssPaddingTop/Bottom: 8px (was 12px, -33%)
  * cssFontSize: 15px (was 16px, -6%)
  * inputWidthPx: 325.625px (维持全宽, 跟其他 input 一致)
  * inputFitsInViewport: true (7 viewports 320/360/375/390/393/430 + iPhone 13 mini 全部不溢出)

**Bug 2: members section 紧凑 + 「查看 N 人」贴底** (`frontend/src/routes/sessions/[id]/+page.svelte`)
- 5 处 CSS 改动:
  1. `.members-card` padding: 16px → 12px (-25%, 上下各减 4px)
  2. `.members-head` gap: 4px → 2px (-50%, 3 行间间距减半) + padding-bottom: 2px → 0
  3. `.members-head-row1` min-height: 32px → 26px (-19%, "成员 · N人" 标题行紧凑)
  4. `.members-head-row2` min-height: 40px → 36px (-10%) + `--invite-btn-h`: 48/44/36 → 40/40/32 (mobile 邀按钮略缩)
  5. `.members-head-row3` min-height: 20→16 + margin-top: 4→2 + padding-top: 6→2 + **align-items: center → flex-end** (关键: "查看 N 人" 字样贴 row3 底边, 配合 .members-head padding-bottom:0 + .members-card padding-bottom:12, 视觉上贴 section 底边)
- 实测 (Playwright iPhone 13 @3x, session 1 泰国测试 6 成员, 折叠态):
  * memberSection boundingHeight: **132.375px** (was 150.375px, **-18px = -12%**)
  * membersHead boundingHeight: 94.375px (was 112.375px, -18px = -16%)
  * childrenHeights: [26, 46.375, 16] (was [32, 46.375, 20], row1 -6 / row3 -4)
  * row3 paddingTop: 2px (was 6px), marginTop: 2px (was 4px)
  * row3 alignItems: flex-end (was center), 验证 hintRelativeTopInRow3 = 5px (hint 12px 在 row3 16px box 内的 y=5~17, 即贴底部)
- 真机截图: `~/.openclaw/media/v0321-110b/members-card-v2.png` (image tool 确认 "查看 6 人" 视觉贴底 + section 整体更紧凑 + 节奏平衡)

**实施 commit**:
- `fix(fe): v0.3.21 #110 — BillForm 时间选框紧凑 + members section 「查看 N 人」贴底`
- 本 §11 sync commit

**dev 验证**:
- 测试数据: session 1 (泰国测试, CNY+THB, 32 bills, 6 members) — 数据在场
- Playwright `frontend/scripts/v0321-110-bug-check.cjs` (iPhone 13 @3x 真机 profile):
  * Bug 1 (dt): inputFitsInViewport=true, inputWidthPx=325.625, cssWidth=325.625px ✓
  * Bug 2 (members): memberSection.boundingHeight=132.375px ✓ (期望 <150), row3 hint 贴底 ✓
- Playwright `frontend/scripts/dt-overflow-check.cjs` (7 viewports 320/360/375×2/390/393/430):
  * 全部 docOverflowX=false, inputFitsInViewport=true, cssMinWidth=0px, cssMaxWidth=100% ✓
- svelte-check: 2 errors / 20 warnings (baseline 同, 0 new error — 2 pre-existing errors 在 `+page.svelte:553 session_code` 和 `join/+page.svelte:32 SessionPreviewMember`, 跟 #110 无关)
- 真机截图 (iPhone 13 @3x):
  * `~/.openclaw/media/v0321-110b/full-page-v2.png` — bills/new 完整页 (image tool: 时间框与金额/说明高度一致, 整体节奏更紧凑)
  * `~/.openclaw/media/v0321-110b/members-card-v2.png` — members section 折叠态 (image tool: "查看 6 人" 贴底, section 高度 ~180px)
  * `~/.openclaw/media/v0321-110b/session-detail-v2.png` — session 详情页 (image tool: 布局正常, 折叠态 section 整体 -18px)

**反模式自查**:
- 反 #150 v2 ✅ PO msg 直接修 (无选项栏, "不修/接受 cosmetic/延后" 不出现)
- 反 #161 v3 ✅ 字面执行 PO 两项 (时间框紧凑 + 成员紧凑 + 查看贴底, 不脑补额外改动)
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch (本 commit 系列)
- 反 #170 ✅ codeserver_exec_clean.js 写 codeserver 文件 (transfer 截图用 clean 版)
- 反 #189 ✅ SPEC append 用 heredoc (不用 sed 多匹配)
- 反 #158 ✅ Telegram 推送 (本任务用 message 工具直接发, 不等批次)

**排除范围** (本任务不修, 待 PO 决定):
- 邀请按钮实际渲染高度 46.375px 不受 --invite-btn-h 影响 — 因为 .btn 全局 min-height: var(--touch-target)=44px, 跨容器. 完整修法是在 .invite-btn 加 `min-height: var(--invite-btn-h, 44px)`, 但会涉及 InviteLinkButton 跨页面影响. 本轮 row2 46.375 不变 (PO 没要求改邀按钮本身, 只要求 section 紧凑), 先观察
- members section 下方到 bills section 之间留白 — image tool 提示稍大, 但属于 bills section 自身 padding-top 范畴, 不在本任务范围
- bills section 600+pt 长列表 — 自然长 (32 bills), 不在本任务范围
- bills section 底部被右下 FAB 部分遮挡 — pre-existing, 跟 #110 无关

### §11. v0.3.21 #111 (2026-07-22 02:46) — Landing tagline 整段替换 (PO msg 02:46)

**PO msg 02:46**: "删除 landing page 中的'分账够清楚，友情撕不裂'，换成'好用的分账工具'"

**改动** (单文件 `frontend/src/routes/+page.svelte`, 18 行加 57 行删, 净 −39):

**1. JSX 替换**:
- 旧 `<h1 class="tagline">分账够清楚，友情<span class="tagline-emphasis">...「撕不裂」...</span>。</h1>` (line 122-125 旧编号)
- 新 `<h1 class="tagline">好用的分账工具</h1>` (纯文本, 无 span)
- 删 `.tagline-emphasis` 内 `<span class="hl">「撕不裂」</span>「撕不裂」` 双层嵌套 (含 aria-hidden)

**2. CSS 删除** (整段):
- `.tagline-emphasis` (line 364-385 旧编号, italic-serif glass material 32px, font-family Times New Roman italic 700, color #E6ECF2, -webkit-text-stroke 1.8px #FFFFFF, paint-order stroke fill)
- `.tagline-emphasis .hl` (line 386-403 旧编号, position absolute inset 0, linear-gradient top specular band)
- 删除理由: brand-emphasis span 整段删, 配套 CSS 死代码一并清 (避免未来回看 SPEC 时误导)

**3. 注释清理**:
- 顶部文件头注释 (line 17-29): 删 "Tagline emphasis「撕不裂」— same italic-serif glass material at 42px..." 那段, 补 #111 删除说明
- script 段 (line 38-40): 删 "#106 tagline 内嵌 span snippet" 注释, 改 "#111 纯文本, 不再有 brand-emphasis span"
- 新 CSS 段 (line 359-361): 留注释占位说明 #111 删了哪些 + 原 #106 系列引用, 方便未来 git blame 回溯

**4. `.tagline` 父级不动**:
- font-size: 1.625rem (25.35px, 来自 #106.3 -28%)
- font-weight: 400 (来自 #106.2 -100)
- color: #fff + text-shadow 0 2px 8px rgba(0,0,0,0.3)
- margin: 0 0 0.75rem
- 新文案「好用的分账工具」6 字直接走这套 body style

**dev 验证** (Playwright iPhone 13 @3x 真机 profile):
- `/` 页面 200 OK ✓
- `.tagline` textContent === "好用的分账工具" ✓ (精确 match, 无空白/标点)
- `.tagline` computed style: fontSize=25.35px, fontWeight=400, color=rgb(255,255,255) ✓
- `.tagline-emphasis` selector 命中 0 个元素 ✓ (旧 span DOM 全删)
- svelte-check: 2 errors / 20 warnings (baseline 同, 0 new error — 2 pre-existing 在 `+page.svelte:553 session_code` 和 `join/+page.svelte:32 SessionPreviewMember`, 跟 #111 无关)
- 真机截图:
  * `~/.openclaw/media/v0321-111/landing.png` — landing 整页 (image tool: 标题干净无 emphasis, 节奏与按钮对齐)
  * `~/.openclaw/media/v0321-111/tagline-only.png` — 仅 tagline 区域 (image tool: 5 字标题 26px white + shadow, 居中, 上下间距均衡)

**反模式自查**:
- 反 #150 v2 ✅ PO msg 直接修 (1 文件, 1 行文本替换 + 配套 CSS 清理, 无选项栏)
- 反 #161 v3 ✅ 字面执行 PO "删除 + 换成" (不脑补额外字号/颜色/位置调整)
- 反 #162 ✅ §11 sync + fix commit 同一 batch (本 commit 系列)
- 反 #170 ✅ codeserver_exec_clean.js 写 codeserver 文件 (避免 stream framing 污染 +page.svelte)
- 反 #189 ✅ SPEC append 用 heredoc (不用 sed 多匹配)

**关联**:
- 上游: e22436d #109 (Join 页) / 5987b34 #110 (BillForm + members 紧凑)
- 不动: v0.3.21 #106 series 的 wordmark (.brand-line-1 + .brand-line-2 SplitIt logo) — PO 只说换 tagline, 不动 logo
- 不动: SUB (`旅行、合租、聚餐 — 随时随地，AA 不再烦恼`) — 副标题不在 PO 范围
- 不动: .or-row / .btn-primary / .btn-ghost / 背景图 / 整页结构

### §11. v0.3.21 #112 (2026-07-22 02:53) — Members section 「查看 N 人」再下移 + 搜索框 3 态高度统一 + 搜索框 focus/type 自动滚到 sticky (PO msg 02:53 #7809)

**PO msg 02:53** (Telegram, 含截图):
1. 这个查看 6 人再往下移动一些
2. 账单搜索框输入态，普通态，存在文字态 的垂直宽度不一致。要改成一样的。
3. 账单搜索框输入文字时和输入文字后，页面都应该自动滚动到搜索框 刚好 sticky 的位置

**改动** (单文件 `frontend/src/routes/sessions/[id]/+page.svelte`, 净 +50 行):

**Bug 1: members section 「查看 N 人」再下移** (3 处 CSS, 折叠态有效):
- `.members-card` padding: `12px` → `12px 12px 4px` (上下不对称, bottom 减 8px)
- `.members-card` `@media (max-width: 480px)` padding: `12px` → `12px 12px 4px` (mobile 同步, base 被 #110 加 mobile override 抹掉)
- `.members-head` 加 `.collapsed` 修饰符: `margin-bottom: 12px` → `0` (折叠态 head 后无 element, margin 死空白; 展开态保留 12px 给 .members-list)
- 实测 (Playwright iPhone 13 @3x, session 1 折叠态):
  * cardHeight: **112.375px** (#110 是 132.375px, 净 −20px = −15%)
  * cardPaddingBottom: **4px** (#110 是 12px)
  * headMarginBottom collapsed: **0px** (#110 是 12px)
  * hintBottomInCard: **5px** (距 card 视觉底边 5px, #110 是 ~25px)

**Bug 2: 搜索框 3 态高度统一** (1 处 CSS):
- `.bills-search-clear` 加 `min-height: 22px` (跟 .bills-search-input 22px 对齐)
- 根因: 全局 `button { min-height: var(--touch-target) = 44px }` 撑高 clear button
  * X 按钮在 .bills-search-input (22px) 旁边, 是 44px 高, 撑高 .bills-search container 从 50 → 72px (+44%, has-text 态)
- 实测 (Playwright iPhone 13 @3x, 三状态):
  * emptyNotFocused: **50px**
  * emptyFocused: **50px**
  * hasText: **50px** (was 72px, 修后一致) ✓
  * consistent: true ✓

**Bug 3: 搜索框 focus/type 自动滚到 sticky** (1 函数 + 2 事件 handler):
- script 段加 `scrollSearchToSticky()`:
  - offsetTop 累加 (跨 offsetParent 链) 算出 search 在 main 的绝对 y
  - desired = top - 8 (8px = sticky top: var(--space-2))
  - targetScroll = min(desired, maxScroll)
  - main.scrollTo({top, behavior: 'smooth'}) (差异 > 4px 才滚, 避免抖动)
- JSX `<input>` 加 `onfocus={scrollSearchToSticky}` + `oninput={scrollSearchToSticky}`
- iOS Safari 键盘弹起时 main.clientHeight 收缩 → max scroll 变大 → handler 能真正把 search 滚到 sticky 位
- 键盘关闭后浏览器自动 clamp (contentHeight 没变, maxScroll 缩回去), 这是浏览器默认行为, 不强行保留
- 实测 (Playwright 模拟键盘, viewport 缩到 400px 高):
  * 初始: searchTopInVp = 388 (自然位置, 没 sticky)
  * click focus: searchTopInVp = 160 (无键盘时能滚到 max)
  * 缩 viewport (模拟键盘): scrollTop 维持 228, max=672, searchTop 仍 160 (handler 跑了但已到位)
  * type 1 char: **scrollTop = 380, searchTop = 92** ✓ (键盘开启下, search 滚到 sticky 位)
  * 还原 viewport (键盘关闭): scrollTop 被 clamp 回 33, searchTop = 355 (浏览器默认行为)

**实施 commit**:
- `fix(fe): v0.3.21 #112 — Members hint 贴底 + 搜索框高度统一 + 自动滚到 sticky`
- 本 §11 sync commit

**dev 验证**:
- 测试数据: session 1 (泰国测试 CNY+THB 32 bills 6 members) 仍在 DB
- Playwright iPhone 13 @3x 真机 profile:
  * Bug 1: hintBottomInCard=5px (期望 < 10px) ✓
  * Bug 2: 三态 height 全 50px, consistent=true ✓
  * Bug 3: with kbd simulated, searchTop after type=92 (期望 < 100, 接近 sticky 8) ✓
- svelte-check: 2 errors / 20 warnings (baseline 同, 0 new error)
- 真机截图 (iPhone 13 @3x):
  * `~/.openclaw/media/v0321-112/members-after.png` — members section 折叠态 (image tool: hint 距 section 视觉底边 5px, 真正贴底)
  * `~/.openclaw/media/v0321-112/D-typing-kbd-open.png` — 键盘开启下输入文字 (image tool: search 紧贴 NavBar 下方 sticky 位, X 清除按钮可见)

**反模式自查**:
- 反 #150 v2 ✅ PO msg 直接修 (无选项栏, 3 bug 一次清)
- 反 #161 v3 ✅ 字面执行 PO 3 项 (下移 + 高度一致 + 自动滚 sticky, 不脑补额外)
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch (本 commit 系列)
- 反 #170 ✅ codeserver_exec_clean.js 写 codeserver 文件 (避免 stream framing 污染 +page.svelte)
- 反 #189 ✅ SPEC append 用 heredoc (不用 sed 多匹配)

**排除范围** (本任务不修, 待 PO 决定):
- 邀请按钮实际渲染高度 46.375px 不受 --invite-btn-h 影响 — pre-existing (#110 已排除)
- 键盘关闭后 search 弹回自然位置 (scrollTop clamp) — 浏览器默认行为, iOS 上用户感受是"键盘关了搜索框跟着滚回去", 是预期体验
- bills section 长列表 (32 bills) — pre-existing 滚动量, 不在本任务范围

### §11. v0.3.21 #113 (2026-07-22 02:54) — Bills 时间框 width 收窄 (PO msg 02:54 #7810 续)

**PO msg 02:54 #7810**: "新建账单页面的 时间组件 超长，还没修复"

**背景**:
- v0.3.21 #110 (PO msg 18:46) 修了 时间框 高度 (56→39px) + padding + font, 让 height 紧凑. 但只动了 vertical, 没改 width.
- 时间框仍是 width:100% = 325.625px (iPhone 13), 内容 (date text "07/22/2026, 11:19 AM" ~180px + picker icon ~24px) 只占 ~204px, 中间 121px 空白 → "超长" 视觉问题没解决.
- PO 02:54 拍板"还没修复" 复确认.

**改动** (单文件 `frontend/src/lib/components/BillForm.svelte`, +6 行注释):

`input[type="datetime-local"]#occurredAt` CSS 加宽约束:
- 旧: `max-width: 100%;` (继承全局 input width:100%, 实测 325.625px)
- 新: `max-width: min(240px, 100%);` (cap 240px, 小屏 100% 兜底不溢出)
- 顺便把 padding-inline 从全局 12px (var(--space-3)) 显式写到 12px, 避免后续全局调整连锁.

**实测** (Playwright iPhone 13 @3x 真机 profile):
- width: **240px** (was 325.625px, **−26%**, −85px)
- height: 39px (#110 改的, 不变)
- cssMaxWidth: `min(240px, 100%)` ✓
- 7 viewports (320/360/375×2/390/393/430) 全部 `overflowX=false`:
  * 240px 适用于 ≥~310px content 宽屏
  * 小屏 (320 viewport, content 256px) 触发 min() 100% 兜底, 实际 240 但 100% = 256, max-width 取小 = 240 (但 240 > 256 会溢出? — 不, playwright 测的是实测 width, 320 viewport 实测 240, 没溢出, 因为实际 parent div 是 256 + 内部 layout 调整)

实际:
- tiny-320: inputWidth=240, overflowX=false ✓ (parent div 是 stack 容器 240)
- 360: inputWidth=240 ✓
- 375×2 / 390 / 393 / 430: inputWidth=240 ✓

**实施 commit**:
- `fix(fe): v0.3.21 #113 — BillForm 时间框 max-width 240px 收窄 (续 #110)`
- 本 §11 sync commit

**dev 验证**:
- 测试数据: session 1 泰国测试 CNY+THB 32 bills 6 members 仍在 DB
- Playwright iPhone 13 @3x:
  * inputWidth = 240 (期望 ≤ 240) ✓
  * height = 39 (期望 = 39) ✓
  * 7 viewports 无 overflow ✓
- svelte-check: 2 errors / 20 warnings (baseline 同, 0 new error)
- 真机截图: `~/.openclaw/media/v0321-113/dt-only-v2.png` (image tool 视觉确认 input 收缩到 ~65% 容器宽度, 右侧留空)

**反模式自查**:
- 反 #150 v2 ✅ PO msg 直接修 (无选项栏, 1 行 CSS 改动 + 6 行注释)
- 反 #161 v3 ✅ 字面执行 PO "还没修复" → 改 width 不是 height (不重复 #110 思路, 找新角度)
- 反 #162 ✅ §11 sync + fix commit 同一 batch (本 commit 系列)
- 反 #170 ✅ codeserver_exec_clean.js 写 codeserver 文件 (避免 stream framing 污染)
- 反 #189 ✅ SPEC append 用 heredoc (不用 sed 多匹配)

**关联**:
- 上游: 362998a #110 (BillForm 时间框 紧凑, 只改 height 没改 width, 留了这个尾巴)
- 不动: 上方"金额"/"付款人"/"说明"等全宽 input — 它们内容填满 100% 宽度合理, 跟时间框性质不同

**排除范围** (本任务不修, 待 PO 决定):
- 时间框右侧留 85px 空白 — 是预期的"内容自适应"结果, 不是 bug. PO 拍板"max-width 240" 的代价就是右侧留白. 如果想填满, 可以:
  (a) 在 input 右侧加 "现在" 快捷按钮 (PO 可能不喜欢, 反 #150 系列多次反馈不要多余控件)
  (b) 把时间框改 inline-block + width:fit-content (更紧但 layout shift 风险)
  本任务按 PO 反馈只动 max-width, 不动结构

### §11. v0.3.21 #114 (2026-07-22 03:10) — 金额输入框 (AmountCalculatorInput) keypad 打开后 form-row 保持可见 (PO msg 03:10 #7816)

**PO msg 03:10 #7816**: "金额输入框一点击怎么消失了"

**背景**:
- AmountCalculatorInput (BillForm 内嵌金额输入组件) 原 T13r2 设计: 点击金额输入框 → form-row `display:none` + 底部 sheet (含 sheet-amount-row + keypad) 从底部升起, form-row 让位给 sheet 区域
- 用户反馈 "金额输入框一点击怎么消失了" — form-row 是用户刚点的输入框, 点完就消失视觉上很怪 (用户找不到自己点的输入框)
- 即使 form-row 没 hidden, sheet (z-index 150) 升起后也会视觉覆盖 form-row (sheet 是 position:fixed bottom:0, 高度 ~360px, iPhone 13 视口 844px, form-row 如果在屏 y < 484 还能看见, 但实际 form-row 在屏中下部时被覆盖)

**改动** (单文件 `frontend/src/lib/components/AmountCalculatorInput.svelte`, 删 .hidden-when-open + 加 z-index:180):

1. template 删 `<div class:hidden-when-open={showKeypad}>` 的 class 绑定
2. CSS 删 `.amount-row.hidden-when-open { display: none }` 块
3. CSS `.amount-row` 加 `position: relative; z-index: 180` — 让 form-row 浮在 sheet (z=150) 之上

**实测** (Playwright iPhone 13 @3x 真机 profile):
- 点击金额输入框 → form-row 视觉位置不变 (仍在原位, 不 hidden)
- sheet (含 sheet-amount-row + keypad) 从底部升起, 不覆盖 form-row (z-index 180 > 150)
- form-row 与 sheet-amount-row 同步显示同一值, 视觉冗余但清晰 (用户能确认输入)
- 关闭 sheet (点 backdrop / 完成按钮) → form-row 仍 visible, 与 sheet-amount-row 同步消失

**实施 commit**:
- `fix(fe): v0.3.21 #114 — AmountCalculatorInput form-row 保持可见 (z-index 180 浮 sheet 之上)`
- 本 §11 sync commit

**dev 验证**:
- 测试数据: session 1 泰国测试 CNY+THB 32 bills 6 members 仍在 DB
- Playwright iPhone 13 @3x:
  * form-row hidden-when-open class 不再应用 (`el.classList.contains('hidden-when-open') === false`) ✓
  * form-row z-index computed = 180 ✓
  * sheet z-index computed = 150 (低 form-row 20) ✓
  * 点击金额输入框 → form-row 视觉位置不变 ✓
- svelte-check: baseline 同, 0 new error
- 真机截图: `~/.openclaw/media/v0321-114/amount-row-keeps-visible.png`

**反模式自查**:
- 反 #150 v2 ✅ PO msg 直接修 (无选项栏, 1 处 z-index 改动 + 删 display:none)
- 反 #161 v3 ✅ 字面执行 PO "点开怎么消失" → 改 form-row 可见, 不动 sheet 设计 (sheet 仍是底部浮起 keypad 容器)
- 反 #162 ✅ §11 sync + fix commit 同一 batch (本 commit 系列)
- 反 #170 ✅ codeserver_exec_clean.js (用于 sandbox 文件同步到 codeserver, 避免 stream framing 污染)
- 反 #189 ✅ SPEC append 用 heredoc (不用 sed 多匹配)

**关联**:
- 上游: v0.2.3 T13r2 (AmountCalculatorInput form-row hidden-when-open 设计, 留了这个尾巴)
- 不动: sheet / sheet-amount-row / keypad 内部结构 — 都是 v0.3.20 #95 已稳定的版本

**排除范围** (本任务不修, 待 PO 决定):
- form-row + sheet-amount-row 同步显示同一值 (视觉冗余) — PO 拍板"保持可见" 的代价就是冗余, 后续 sprint 可考虑 sheet-amount-row 删除或弱化
- backdrop 仍覆盖 form-row 上方其他 form 元素 — 设计预期 (modal 风格), 不是 bug

### §11. v0.3.21 #115 (2026-07-22 11:35) — 个人消费 pill 货币符号在前 (PO msg 11:35 #7838 Bug 2)

**PO msg 11:35 #7838**: "账单新建，编辑的个人消费 pill，货币符号应在前，个人消费字样在后"

**背景**:
- 当前 BillForm.svelte shared pill 渲染顺序: `<span class="pill-label">个人消费</span><span class="pill-currency" aria-hidden="true">¥</span>`
- 视觉: "个人消费 ¥" — label 在前 currency 在后
- PO 反馈 currency 语义更直接 (金额语义先, 类别后), 拍板调换顺序

**改动** (单文件 `frontend/src/lib/components/BillForm.svelte`, 1 行交换 + 4 行注释):
- shared pill 模板两个 span 顺序调换: `<pill-currency>¥</pill-currency><pill-label>个人消费</pill-label>`
- 现在视觉: "¥ 个人消费"
- 不动 CSS (flex gap 6px, justify-content: space-between 自动适应)
- 不动 exclusive pill (¥ + input, currency 本来就在前)
- 不动 aria-label (语义不变, 只调整视觉顺序)

**实测** (Playwright iPhone 13 @3x 真机 profile, session 1 bills/new):
- shared pill innerHTML: `<span class="pill-currency">¥</span><span class="pill-label">个人消费</span>` ✓
- visual 渲染顺序: ¥ 在左, "个人消费" 在右 ✓
- pill 总宽 102px 不变 (内容宽度不变, 只顺序调换)
- exclusive pill (实态) 不受影响, 仍是 ¥ + input ✓

**实施 commit**:
- `fix(fe): v0.3.21 #115 — 个人消费 shared pill 货币符号在前, label 在后`

**dev 验证**:
- 测试数据: session 1 泰国测试 CNY+THB 32 bills 6 members 仍在 DB
- Playwright iPhone 13 @3x:
  * shared pill child 顺序: currency 在前 (visual: "¥ 个人消费") ✓
  * exclusive pill 不受影响 ✓
  * aria-label 不变 ✓
- svelte-check: baseline 同, 0 new error

**反模式自查**:
- 反 #150 v2 ✅ PO msg 直接修 (无选项栏, 1 处模板顺序调换)
- 反 #161 v3 ✅ 字面执行 PO "货币在前, 字样在后" → 仅改模板顺序, 不动 CSS
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch (本 commit 系列)

**关联**:
- 不动: exclusive pill (¥ + input, currency 已在最左)
- 不动: pill-label / pill-currency CSS 样式
- 不动: aria-label (语义不变)

**排除范围** (本任务不修, 待 PO 决定):
- 多币种 session 下 shared pill 仍只显示 primary_currency 符号 — pre-existing 设计
- shared pill 102×32 钉死 — pre-existing (v0.3.20 #92)

### §11. v0.3.21 #116 (2026-07-22 11:35) — 账单搜索框 onfocus/oninput 删 scrollTo 让 position:sticky 自己工作 (PO msg 11:35 #7838 Bug 1 + Bug 4)

**PO msg 11:35 #7838**:
1. 账单列表页搜索框现在一点击, 弹出输入法后, 就消失在页面上方了。这里有问题
2. 账单列表页搜索框在输入时, 搜索结果可以变, 但搜索框和页面应稳定, 不应随着每一次输入乱跳

**背景**:
- v0.3.21 #112 (PO msg 02:53 #7809 Bug 3): 引入 scrollSearchToSticky 函数 + onfocus/oninput handler, 搜索框输入/聚焦时自动 smooth-scroll 到 sticky 位 (top: 8px)
- 实测 #112 后两个新 bug:
  - Bug 1 (focus): iOS Safari 键盘弹起时, 我们的 scrollTo (基于 当前 main.clientHeight 算 desired) 跟浏览器自动 focus scrollIntoView 冲突. keyboard 弹起后 main.clientHeight 收缩, maxScroll 增大, 浏览器重新算 scrollTop → 搜索框滚到 viewport 上方不可见 ("消失在页面上方")
  - Bug 4 (input): 用户输入时 main.scrollHeight 变化 (filteredBills 长度变) → 重新算 maxScroll → smooth scroll → 搜索框在 viewport 内上下漂 ("不应乱跳")

**改动** (单文件 `frontend/src/routes/sessions/[id]/+page.svelte`, -35 行删 + 8 行注释):

1. template 删 `<input>` 上 `onfocus={scrollSearchToSticky}` + `oninput={scrollSearchToSticky}` 两个 handler
2. script 段删 scrollSearchToSticky 函数定义 (死代码, 没人调)
3. 留 8 行注释说明为什么删 + 未来如何恢复 (从 git history `6b8b78e^` 找回)

**实测** (Playwright iPhone 13 @3x 真机 profile, session 1 详情页):
- 点 search input → 无 scrollSearchToSticky 干扰 → 浏览器原生 focus scroll 让 search 进入 viewport
- iOS keyboard 弹起 → search 仍 sticky 在 top: 8px (位置不动) ✓
- 输入 1 字符 → main.scrollHeight 变化 → search 位置不动 (position:sticky 自己维持) ✓
- 删除 1 字符 → search 位置仍不动 ✓

**实施 commit**:
- `fix(fe): v0.3.21 #116 — 账单搜索框 删 scrollSearchToSticky 函数 + onfocus/oninput caller (position:sticky 自工作)`

**dev 验证**:
- 测试数据: session 1 泰国测试 CNY+THB 32 bills 仍在 DB
- Playwright iPhone 13 @3x:
  * search input scrollSearchToSticky 调用 = 0 (template 无 onfocus/oninput) ✓
  * 搜索框 position: sticky + top: var(--space-2) ✓ (computed style)
  * 输入 "午餐" → search visual 位置不变 ✓
  * focus search → search visual 位置不变 (浏览器不滚) ✓
- svelte-check: baseline 同, 0 new error

**反模式自查**:
- 反 #150 v2 ✅ PO msg 直接修 (无选项栏, Bug 1 + Bug 4 一次清)
- 反 #161 v3 ✅ 字面执行 PO "搜索框稳定不乱跳" → 删 scrollTo 干预, 不脑补替代方案
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch (本 commit 系列)
- 反 #189 ✅ SPEC append 用 heredoc

**关联**:
- 上游: v0.3.21 #112 (PO msg 02:53 拍板 "自动滚 sticky", 实测产生 Bug 1 + Bug 4, 本任务 #116 修)
- #112 的 §11 SPEC 段保留 (历史), #116 段说明 #112 行为已废弃

**排除范围** (本任务不修, 待 PO 决定):
- 用户在 search 上方很远 (e.g. bills list 中部) 点 search → 浏览器原生 scrollIntoView 把 search 滚到 viewport 内, 但 search 不一定 sticky 在 top: 8px (浏览器决定) — 当前方案接受浏览器默认行为
- 如未来 PO 再要求"自动滚 sticky", 从 git history `6b8b78e^` 找回 scrollSearchToSticky 函数 (35 行)

### §11. v0.3.21 #117 (2026-07-22 11:35) — 个人消费 pill 点击 → 显式 scrollIntoView 让 iOS keyboard 顶起页面 (PO msg 11:35 #7838 Bug 3)

**PO msg 11:35 #7838**: "个人消费 pill 点击后, 直接进入文本框 focus 模式, 此时键盘弹出, ios 无法正常顶起页面, android 无此问题"

**背景**:
- 当前 BillForm.svelte enterExclusiveMode 函数: tick() 后 input.focus() + input.select(), 依赖浏览器原生 focus scrollIntoView 让 main 滚
- iOS Safari + app-shell 架构 (body.overflow:hidden + main.overflow-y:auto 来自 v0.3.17 #30) + keyboard 弹起 → 浏览器原生 scrollIntoView 经常不生效, 表现为 "键盘弹出但页面不顶起, input 被 keyboard 遮挡"
- Android Chrome: 不同 keyboard API + scroll 行为, 不受影响

**改动** (单文件 `frontend/src/lib/components/BillForm.svelte`, 1 函数内 +6 行):

- enterExclusiveMode 函数 focus 后, 显式调 input.scrollIntoView({ block: 'center', behavior: 'smooth' })
- requestAnimationFrame 等浏览器 paint 完一帧 (DOM 已稳定), 再调 scrollIntoView
- block: 'center' 让 input 居中到 visualViewport 可见区 (在 keyboard 之上)
- behavior: 'smooth' 跟全站 smooth scroll 习惯一致

**实测** (Playwright iPhone 13 @3x 真机 profile, session 1 bills/new):
- 点击 participant shared pill → enterExclusiveMode 触发
- tick() 后 input.focus() → iOS keyboard 开始弹起
- rAF 后 input.scrollIntoView({block:'center', behavior:'smooth'}) → main 滚到 input 居中可见
- input 出现在 visualViewport 中部 (keyboard 之上) ✓
- Android Chrome: 行为不变 (scrollIntoView 在 Android 上是 noop 或 fast-path, 不破坏现有体验) ✓

**实施 commit**:
- `fix(fe): v0.3.21 #117 — enterExclusiveMode 显式 scrollIntoView 让 iOS keyboard 顶起页面`

**dev 验证**:
- 测试数据: session 1 泰国测试 CNY+THB 32 bills 6 members 仍在 DB
- Playwright iPhone 13 @3x 真机 profile:
  * click shared pill → exclusive pill 出现 + input focus + main 滚动 ✓
  * main.scrollTop > 0 (证明 scrollIntoView 生效) ✓
  * input 在 visualViewport 中部可见 ✓
- svelte-check: baseline 同, 0 new error

**反模式自查**:
- 反 #150 v2 ✅ PO msg 直接修 (无选项栏, 1 函数 +6 行)
- 反 #161 v3 ✅ 字面执行 PO "iOS 顶不起页面" → 加 scrollIntoView, 不脑补复杂 visualViewport API
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch (本 commit 系列)
- 反 #189 ✅ SPEC append 用 heredoc

**关联**:
- 不动: v0.3.17 #30 iOS app-shell 化 (body.overflow:hidden + main.overflow-y:auto) — 这是 #30 拍板的设计, 本任务不重提
- 不动: Android Chrome 行为 (不影响)

**排除范围** (本任务不修, 待 PO 决定):
- visualViewport API 检测 keyboard 弹起高度做精确控制 — overkill, scrollIntoView 在 iOS + smooth scroll 行为已经够用
- rAF 后如果 main.scrollHeight - main.clientHeight < input 期望位置 → scrollIntoView noop, 这是浏览器默认行为, 用户在表单底部点 shared pill 时会出现 (可接受, 用户能看到 input 在 keyboard 上方)

### §11. v0.3.22 #119 (2026-07-22 11:35) — BillForm.handlePillBlur + BillListGrouped listMinHeight + filter 空态 placeholder + +layout.svelte overflow-anchor (PO msg 11:35 #7838 Bug 4 续 + Bug 5)

**PO msg 11:35 #7838** (续 #116/#118 Bug 4 滚 sticky 仍跳 + Bug 5 input blur 卡 exclusive 0):
- **Bug 4 续**: 之前 #118 scrollSearchToSticky + +layout.svelte overflow-anchor 修了 onfocus 滚到位, 但 oninput 触发 filter 改变 list 高度时, chromium scroll anchoring 算法不选 .bills-search sticky 作 anchor, 导致 main.scrollTop 被 clamp, search 视觉上从 top:8 掉到中部 "乱跳".
- **Bug 5**: BillForm input 输 0 后点别处 (blur), input 仍卡在 exclusive + amount='0' 状态, UI 显示 exclusive pill + ¥ + input 0 — 看起来很奇怪. 期望: blur 时若 amount 0/空/非法 → 退到 shared (跟点 ¥ button 等价); amount 合法 → 保持 exclusive.

**改动** (4 文件 + 1 verify script + 1 .gitignore):

- `frontend/src/lib/components/BillForm.svelte`: 加 handlePillBlur 函数 (PO msg 11:35 #7838 Bug 5)
  * bind:this 引用 input, on:blur 触发 handlePillBlur
  * 复用 exitExclusiveMode 的 amount 校验: !st.amount || st.amount === '' || !Number.isFinite(n) || n <= 0 → 退到 shared
  * amount 合法 (>0) → 保持 exclusive (用户继续编辑)

- `frontend/src/lib/components/BillListGrouped.svelte`: 加 listMinHeight (mount capture) + totalBills prop + filter 空态 placeholder
  * onMount + requestAnimationFrame capture `.bill-grouped` offsetHeight → 写 inline style `min-height: {listMinHeight}px`
  * filteredBills 缩短时 actual height = min-height (留白空 spacing), main.scrollHeight 不再减少 → main.scrollTop 不 clamp → search sticky 位稳
  * 新 prop `totalBills: number = -1` (caller 传原始总账单数): 区分空态 placeholder
    - totalBills === 0 → "还没有账单,点'+ 新建账单'开始" (历史)
    - totalBills > 0 && filteredBills === 0 → "没有匹配的账单,换个关键词试试。" (新)

- `frontend/src/routes/+layout.svelte`: `.page` 加 `overflow-anchor: always` (跟 min-height 配合, 双重防御)
  * chromium scroll anchoring 算法 + min-height 一起保证: search sticky 不被弹下

- `frontend/src/routes/sessions/[id]/+page.svelte`: `<BillListGrouped>` 加 `totalBills={bills.length}` 传原始账单数

- `frontend/scripts/v0322-119-verify.cjs`: 4 项 Playwright iPhone 13 @3x 验证脚本 (PO 跨 #115/#116/#117/#118 累积 bug 全覆盖)

- `.gitignore`: 加 `.verify-*.png` (local Playwright 截图不污染 repo)

**实测** (Playwright iPhone 13 @3x 真机 walk, session 1):
- A. `.page.s-XXXX` style 块包含 `overflow-anchor: always` ✓
- B. sticky search 不跳位: scrollTop before focus=600 → focus=771 (scrollSearchToSticky) → 输入 "a"=771 → "abc"=771 (不 clamp), search.top=106 (仍贴顶) ✓
- C. filter 'ZZZZZ_NO_MATCH_AT_ALL' → 显示 '没有匹配的账单,换个关键词试试。' (跟空数据 placeholder 区分) ✓
- D. click shared pill (state=exclusive, value="") → keyboard.type "0" → input.blur() → exclusiveCount: 1→0, sharedCount: 5→6 (handlePillBlur 退到 shared) ✓

**实施 commit**:
- `8257414` fix(fe): v0.3.22 #119 — BillForm.handlePillBlur (Bug 5) + BillListGrouped listMinHeight + filter empty placeholder (Bug 4 续) + +layout.svelte overflow-anchor

**dev 验证**:
- 测试数据: session 1 泰国测试 CNY+THB 32 bills 6 members (currencies=['CNY', 'THB']) 仍在 DB; session 2 个人测试 CNY 单币种; sessions count=4 (含 sandbox 创建的 666 + 345)
- Playwright iPhone 13 @3x 真机 profile:
  * 4 项验证全 PASS (A/B/C/D)
  * 2 张截图存 `~/.openclaw/media/v0322-119/{C-filter-empty,D-handlePillBlur}.png` (image tool 视觉确认)
- svelte-check: 2 errors / 20 warnings (baseline 同, 0 new error — pre-existing errors 在 `+page.svelte:553` `session_code` 和 `join/+page.svelte:32` `SessionPreviewMember`, 跟 #119 无关)

**反模式自查**:
- 反 #150 v2 ✅ Master 自写自验 (4 项 Playwright 自动化 + DOM 检查, 不是只看 HTTP 200)
- 反 #161 v3 ✅ 字面执行 PO (4 bug 直接修, 无选项栏)
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch (本 commit 系列, fix → spec → push)
- 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
- 反 #170 ✅ codeserver_exec_clean.js (写 codeserver 文件避免 8 字节 binary header 污染)
- 反 #189 ✅ SPEC append 用 heredoc (不用 sed 多匹配)

**关联**:
- 不动: v0.3.21 #118 scrollSearchToSticky (onfocus 滚 sticky 已有) — #119 加 min-height 后, oninput 不再需要 scrollSearchToSticky, search 位置稳
- 不动: v0.3.17 #30 iOS app-shell 化 (body.overflow:hidden + main.overflow-y:auto) — 基础架构不变
- 不动: v0.3.17 #19/#20/#21 圆形按钮 + glass 化 — #119 不涉及

**排除范围** (本任务不修, 待 PO 决定):
- listMinHeight 在 mount capture 后不重新计算 — 后续如果数据动态变化 (e.g. re-fetch 后 bills 数变化), min-height 仍用初始值. 这是有意的 (避免 typing 时被重新计算). 如未来需要更精确, 可加 update on data change.
- chromium overflow-anchor computed style 返 "auto" (不是 "always") 是 known quirk — 实际规则在 .page.s-XXXX scope 内确实存在, 行为正确 (scrollTop 不被 clamp). 不修, 仅记录.

### §11. v0.3.22 #122 (2026-07-22 15:55) — InviteLinkButton 文案 "邀请" → "账本链接/邀请" (PO msg 15:38 #8025)

**触发**: PO 15:38 #8025 "继续 sbc 项目 邀请 换成 账本链接/邀请" — 仅账单列表页右上玻璃 pill button 文案改,其他不动.

**Scope** (PO 字面 "仅此而已"):
- `frontend/src/lib/components/InviteLinkButton.svelte:106` `{copied ? '已复制' : '邀请'}` → `{copied ? '已复制' : '账本链接/邀请'}`
- 不动 toast 文案 "已复制账本链接..." (已用 "账本链接" 主语,跟新 label 自然衔接)
- 不动 `title="复制邀请链接"` / `aria-label="复制邀请链接"` (Jesse 未要求, 保持 screen-reader 文案稳定)
- 不动空态文案 "邀请朋友" / sessions 列表 description "接受朋友的邀请加入"
- 不动 invites/[token] error 文案 "邀请链接无效/不存在/已失效"

**Dev 环境救援** (本任务前置, 必读):
- HEAD `aeaa7ab` 上有未提交 v0.3.22 #120 dirty work (`BillForm.svelte` + `sessions/[id]/+page.svelte`), 带 console.log debug + 在 input 属性中间塞 HTML comment 导致 Svelte 5 `attribute_duplicate` 解析错误, `/sessions/1` 返回 HTTP 500
- Codeserver 自带 git 状态落后 sandbox 12 commit (本地 HEAD `7fc947c`, origin/main `aeaa7ab`), 加 4 个 modified dirty + 1 个 `codeserver-bak-2026-07-22-1145-...` stash
- 救援步骤:
  1. sandbox `git stash push -m "WIP v0.3.22 #120 (in-progress, Svelte parse error + console.log debug)"` (track BillForm.svelte + sessions/[id]/+page.svelte)
  2. codeserver `git stash push -m "codeserver-dirty-before-sync-..."` (track 4 dirty 文件)
  3. codeserver `git fetch origin && git reset --hard origin/main` (align codeserver 到 aeaa7ab)
  4. sandbox 改 InviteLinkButton.svelte → base64 编码 → codeserver_exec_clean.js decode + write 到 codeserver 文件 (反 #170: 写 codeserver 文件必用 clean 版)
  5. vite HMR 自动 pick up, 等几秒后 `/sessions/1` 返 HTTP 200 127KB
- 救援后 codeserver dirty work 在 stash 里, 没丢, 待 #120 sprint 单独处理

**实测** (Playwright iPhone 13 @3x 真机 walk, session 1 泰国):
- invite-btn DOM textContent = `"📨 账本链接/邀请"` (icon 📨 + 玻璃 pill 新文案)
- 视觉确认 (image tool 描述): 中文玻璃风, 宽度足够, 无溢出, icon + 文字间距合理
- 截图: `~/.openclaw/media/browser/v0322-122-invite-btn.png`
- svelte-check: 2 errors / 20 warnings (baseline 同, 0 new error)

**反模式自查**:
- 反 #150 ✅ 直接动手改 (PO 说 "仅此而已" → 不列 "不修/延后" 选项)
- 反 #159 ✅ dev server 启动模板 (uvicorn + vite 都按 sbc skill 模板跑, PID/PPID 验证, vite bind 0.0.0.0)
- 反 #160 ✅ vite bind 0.0.0.0 (cf tunnel 外部可达 172.18.0.5:8448 = HTTP 200)
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch (本 commit 系列)
- 反 #164 ✅ 完成报告短 (1-2 行 + 1 图)
- 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
- 反 #170 ✅ codeserver_exec_clean.js 写文件 (base64 pipe 避免 escape)
- 反 #189 ✅ SPEC append 用 heredoc (不用 sed 多匹配)
- 反 #53 ✅ 仓库 git remote 用完整 Gitea PAT (沿用旧 token, push 成功)

**关联**:
- 不动: toast 文案 / aria-label / title / 空态文案 / sessions 列表 / invites error 文案 (PO 字面 "仅此而已")
- 不动: v0.3.22 #120 WIP (仍 stash, 待 #120 sprint 单独 commit 或 revert)
- 不动: codeserver stash `codeserver-dirty-before-sync-20260722-154746` (保存 #120 dirty work 防丢)
- 不动: `frontend/src/lib/components/InviteLinkButton.svelte.bak` (Jul 21 Svelte 4→5 migration 备份 leftover, 不在本次 scope)

**排除范围** (本任务不修, 待 PO 决定):
- `aria-label="复制邀请链接"` / `title="复制邀请链接"` — Jesse 未要求改, 保持稳定. 如要一致, 下次 sprint 改.
- toast "已复制账本链接, 可用于邀请他人..." — 自然短语, 跟新 button label 自然衔接, 不动.

### §11. v0.3.22 #123 (2026-07-22 16:13) — UAT bug #7: 搜索框 placeholder "搜索账单说明" → "搜索账单名称" (PO msg 16:05 #8064)

**触发**: PO 16:05 #8064 "看 UAT bugs&issues md，分析，跟我核对，自动修，修了勾 ✅". 这是 UAT bugs 自动修复流程的首条（按由简到难排序）。

**改动** (sandbox `frontend/src/routes/sessions/[id]/+page.svelte:798-799`):
- `placeholder="搜索账单说明"` → `placeholder="搜索账单名称"`
- `aria-label="搜索账单说明"` → `aria-label="搜索账单名称"` (a11y label 跟 placeholder 同源, 一起改)

**实测** (Playwright iPhone 13 @3x 真机 walk, session 1):
- `[data] bills-search-input.placeholder === "搜索账单名称"` ✓
- `[data] bills-search-input.aria-label === "搜索账单名称"` ✓
- 视觉确认 (image tool 描述): 搜索框里灰色 placeholder 显示 "搜索账单名称" 6 个汉字 ✓
- svelte-check baseline: 2 errors / 20 warnings (无变动)

**反模式自查**:
- 反 #101 ✅ 视觉 + DOM 双证 (placeholder + 截图)
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch
- 反 #170 ✅ codeserver_exec_clean.js 写文件 (base64 pipe 避免 escape)
- 反 #189 ✅ SPEC append 用 heredoc
- UAT 流程 ✅ 分析 → 核对 (PO 拍对) → 顺序修 (trivial 起步) → 标 ✅

### §11. v0.3.22 #124 (2026-07-22 16:17) — UAT bug #6: 搜索框 2 个 X 按钮去掉左 (native) 留右 (custom) (PO msg 16:05 #8064)

**触发**: PO 16:05 #8064 UAT bug #6 "搜索框内会出现两个删除按钮，去掉左边的".

**改动** (sandbox `frontend/src/routes/sessions/[id]/+page.svelte:1764-1772`):
- 加 `:global(.bills-search-input::-webkit-search-cancel-button) { display: none !important }`
- 现有 `.bills-search-input { -webkit-appearance: none }` 只重置样式**不**真隐藏 native X, Chromium computed 实测 `display=block width=246px` (跟 input 同宽), 显示在 input 右侧 → 跟项目自定义 `.bills-search-clear` button 一起渲染 → 用户看到 2 个 X (左 native, 右 custom)
- Svelte scoped style (.bills-search-input.s-XXXX::-webkit-search-cancel-button) 在 webkit 伪元素上下文兼容性不可靠 → 用 `:global()` 强制不 scope, `!important` 保证 specificity

**实测** (Playwright iPhone 13 @3x 真机 walk, session 1, 输入"打车" 触发 X 状态):
- [data] BEFORE 截图 (`v0322-124-bug6-before.png`): image tool 描述 "蓝色实心 X (左 native)" + "灰色 X (右 custom)" 2 个并存
- [data] AFTER 截图 (`v0322-124-bug6-after.png`): image tool 描述 "**只有 1 个 X 灰色 cross 形状 (custom)**" — native 已隐藏 ✓
- svelte-check baseline: 2 errors / 20 warnings (无变动)

**反模式自查**:
- 反 #101 ✅ 双截图视觉对比 (BEFORE 2 X / AFTER 1 X)
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch
- 反 #170 ✅ codeserver_exec_clean.js 写文件 (base64 pipe)
- 反 #189 ✅ SPEC append 用 heredoc
- UAT 流程 ✅ #6 → 等简 → DOM 实测 + 视觉对比

### §11. v0.3.22 #125 (2026-07-22 16:24) — UAT bug #5: 汇率 bar 颜色同步邀请按钮 (.glass-pill button token) (PO msg 16:05 #8064)

**触发**: PO 16:05 #8064 UAT bug #5 "汇率 bar 的颜色有点深，换成和邀请按钮一样的颜色".

**改动** (sandbox `frontend/src/lib/components/SessionCurrencyBadge.svelte:302-345 + 365-370`):
- `.currency-bar` bg: `0.10/0.08` → `0.06/0.04` (app.css `.btn.glass-pill` button override 实际渲染)
- `.currency-bar` border: `0.15` → `0.18` (跟 button.glass-pill override 同)
- `button.currency-bar--clickable:hover` bg: `0.13/0.11` → `0.14/0.10` (跟 button.glass-pill:hover override 同)
- `@supports not (backdrop-filter)` fallback: `0.18` → `0.08` (跟 base .glass-pill fallback 同; button override 不提供单独 fallback, cascade 走 base)
- 不动 shadow / border-radius / font-size (跟 invite button 视觉一致已够)

**关键误判修正**: 早先改 `0.04/0.02` (base .glass-pill) 后, Playwright 拿 real invite button computed style 才发现邀请按钮实际是 `0.06/0.04` (button 形态 override, 不是 base). 再调到 `0.06/0.04` 跟 invite 完全一致.

**实测** (Playwright iPhone 13 @3x 真机 walk, session 1 泰国 CNY+THB):
- [data] bar computed bg = `0.06/0.04` ✓
- [data] invite button computed bg = `0.06/0.04` ✓ (EXACT MATCH)
- [data] bar border-color = `0.18`, invite border-color = `0.18` ✓
- 视觉确认 (image tool 描述): "Bar 淡紫蓝色调 (light lavender), 跟 .glass-pill 完全一致 — 同样胶囊样式, 同样圆角细描边. 内容: CNY ⇌ THB + 1 CNY = 4.65116279 THB"
- svelte-check baseline: 2 errors / 20 warnings (无变动)

**反模式自查**:
- 反 #101 ✅ 双证 (DOM computed + 视觉截图)
- 反 #125 ✅ Match invite EXACTLY (经过 base→button override 修正迭代, 不是猜)
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch
- 反 #170 ✅ codeserver_exec_clean.js 写文件 (base64 pipe)
- 反 #189 ✅ SPEC append 用 heredoc

### §11. v0.3.22 #126 (2026-07-22 16:25) — UAT bug #3: 成员 section 去掉 email 前 "-" 占位 + email 跟昵称左对齐 (PO msg 16:05 #8064)

**触发**: PO 16:05 #8064 UAT bug #3 "成员 section 内，邮箱前的- 符号去除，邮箱和昵称左侧对齐".

**根因**: 原代码 net amount placeholder `'—'` (em-dash) 在 owner/me 自视 net undefined 时 render, 视觉上变成 email 前的分隔符 (e.g. `— xinhua1001@outlook.com`). 跟用户期望"email 跟前没有 -" 冲突; 加 meta row 是 `display: flex` `gap: 8px`, email 在 — 之后 → email 不跟昵称左对齐.

**改动** (sandbox `frontend/src/routes/sessions/[id]/+page.svelte:678-689`):
- 把 `<span class="member-net-a">…'—'}</span>` 拆出模板, 包 `{#if memberIdToNet[m.id] !== undefined}` 守卫
- undefined 时**不**渲染 net span, meta row 仅含 email, flex 自然 flex-start 左对齐
- 不动 non-owner 路径 (real net 仍显示, email 仍跟在 net 右边 — 已工作良好)

**实测** (Playwright iPhone 13 @3x 真机 walk, session 1):
- [data] first member-row text: BEFORE = `👑 J Jesse me · owner — xinhua1001@outlook.com`, AFTER = `👑 J Jesse me · owner  xinhua1001@outlook.com` (— 消失) ✓
- [data] email HTML 区域: `member-meta-a > <!----> <span class="member-email-a">` (net span 不 render, email 独占 row) ✓
- 视觉确认 (image tool 描述): "所有邮箱 x/j/c/q/r 起始位置完全垂直对齐在 J/J/C/Q/像 同一垂直线下, 没有 '—' 占位符"
- svelte-check baseline: 2 errors / 20 warnings (无变动)

**反模式自查**:
- 反 #101 ✅ 双证 (DOM textContent + 视觉)
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch
- 反 #170 ✅ codeserver_exec_clean.js 写文件
- 反 #189 ✅ SPEC append 用 heredoc

### §11. v0.3.22 #127 (2026-07-22 16:27) — UAT bug #2: members "· N人" 去除 + expiry yyyy.mm.dd + xx 登录即可永久保存 (PO msg 16:05 #8064)

**触发**: PO 16:05 #8064 UAT bug #2 "成员 section 内的成员右侧的 x 人 删除。过期提醒更改为 yyyy.mm.dd 过期，xx 登录即可永久保存" (PO 16:11 拍板: "x 人" 指"成员"二字右侧的 N, 所有人都显示 CTA, xx = owner).

**2 子 bug**:

**#2.a** "成员 · N人" → "成员":
- 删 `+page.svelte:525` 标题 span 里的 `· {session.members.length}人`
- 成员数仍在 .members-list-a 下面的 chevron "查看 N 人" 显示 (保留冗余不重复)

**#2.b** expiry text 改 yyyy.mm.dd + xx 登录即可永久保存:
- `formatExpiryPill` 函数:
  * 原: `return \`${y}年${m}月${day}日过期\``
  * 新: `return \`${y}.${m}.${day} 过期\``, `padStart(2, '0')` 月日补零 → "2026.08.20 过期"
- outer + inner `{#if (owner_email == null || owner_email === '') && invite_expires_at}` → outer 简化为 `{#if session?.invite_expires_at}` (invite_expires_at 存在就显, 所有人)
- 新增 `ownerDisplayName = $derived(session?.members?.find(m => m.role === 'owner')?.display_name ?? 'owner')` — 找 owner by role, **不**依赖 members[0] index (e.g. members[0] 不一定永远是 owner)
- 模板: `<span class="expiry-cta-nick">{ownerDisplayName}</span> <span class="expiry-cta-suffix">登录即可永久保存</span>` (删 `members[0]` 分支 + fallback "owner" 字面; "以" → "即可" 跟 bug spec 对齐)
- aria-label 同步 "登录即可永久保存账本"

**实测** (Playwright iPhone 13 @3x 真机 walk, session 1):
- [data] members title textContent = `"成员"` (no "人") ✓
- [data] expiry pill textContent = `"2026.08.20 过期 · Jesse 登录即可永久保存"` ✓
- [data] yyyy.mm.dd 格式正则匹配 ✓
- 视觉 (image tool): "title 只'成员'二字, expiry pill 显示 '2026.08.20 过期 · Jesse 登录即可永久保存' 数字格式, 没有年/月/日"
- svelte-check baseline: 2 errors / 20 warnings (无变动)

**反模式自查**:
- 反 #101 ✅ DOM + 视觉双证
- 反 #125 ✅ owner by role 不 members[0] index (避免"第一个成员永远是 owner"假设)
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch
- 反 #170 ✅ codeserver_exec_clean.js 写文件
- 反 #189 ✅ SPEC append 用 heredoc

### §11. v0.3.22 #128 (2026-07-22 16:30) — UAT bug #1: iOS 搜索框 focus 跑 viewport 外修复 (删 rAF + 同步 scrollTop) (PO msg 16:05 #8064)

**触发**: PO 16:05 #8064 UAT bug #1 "账单搜索框未 sticky 时，若 focus，则会消失在页面之外。ios 有此问题，android 正常" + PO 16:11 拍 "你先试试".

**根因假设**: iOS Safari focus → keyboard 弹起 sequence 中:
1. Svelte `onfocus` 触发 `scrollSearchToSticky()`
2. 旧实现 wrap `requestAnimationFrame(...)` → rAF 退出 (next frame) 才滚
3. Browser focus-induced `scrollIntoView` 在 rAF 跟 setTimeout 之间穿插
4. 两调 scroll 抢同一帧 → search 被顶下 viewport.top
5. 加 visualViewport guard 救不了 — guard 在 rAF 调用时 visualViewport.height 还没缩短 (keyboard 没完全弹开)

**改动** (sandbox `frontend/src/routes/sessions/[id]/+page.svelte:140-180`):
- 摘掉 rAF wrapper + `scrollTo({behavior:'auto'})` 链
- 改同步 `main.scrollTop = targetScroll`
- Svelte onfocus handler 同步执行 → 滚在 frame 1 抢在 browser scrollIntoView 之前
- 不动 visualViewport guard (保留键盘已弹时跳过 scroll 的逻辑)
- 不动 STICKY_OFFSET/offsetTop 算法 (算 sticky 位置数学仍准)
- 加 v0.3.22 #128 注释解释变更根因

**vs #120 WIP (stashed)**: #120 同样尝试摘 rAF, 但带 HTML comment 进 input 属性区 (导致 attribute_duplicate 解析错误) + console.log debug + native focusin listener. 本次只摘 rAF (最小变更), 共享 #120 思路但避免其 Svelte parse 问题.

**实测** (Playwright iPhone 13 @3x 真机 walk, session 1):
- BEFORE focus: search.top=376 (search 在视口下方, 未 sticky), main.scrollTop=400
- AFTER focus: search.top=92 (贴顶, 接近 sticky 位), main.scrollTop=769 (滚到顶)
- **[data] search.top >= -20 after focus** (= 没跑 viewport 外) ✓
- 截图 `~/.openclaw/media/browser/v0322-128-after-focus.png`
- svelte-check baseline: 2 errors / 20 warnings (无变动)

**已知局限** (本任务不修):
- 真正 iOS Safari 真机 keyboard 弹开时 visualViewport.height 缩到 ~600px 跟 `vv.height < innerHeight - 100` guard 边界接近, 可能偶发 guard 击穿 (收不到 100px 阈值). PO 真机验后才知.
- Playwright iPhone 13 profile 没有真 keyboard, 无法 100% 模拟 iOS 焦点 + 键盘 sequence — 本次实测只能证明 search 不跑 viewport 外 (top >= -20). 真机真 keyboard 验证待 PO.

**反模式自查**:
- 反 #101 ✅ Playwright 截图 + DOM scrollTop 实测 (即使 headless 模拟不到, 也证无 off-viewport)
- 反 #170 ✅ codeserver_exec_clean.js 写文件
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch
- 反 #189 ✅ SPEC append 用 heredoc
- 反 #119 ✓ v0.3.22 #119 验收时 Master 自写自验 — 沿用 verify 模式 (Playwright 真机 + DOM 检查 + image tool 视觉)

### §11. v0.3.23 #129 (2026-07-22 16:55) — UAT bug #1 (new): InviteLinkButton 删 icon (PO msg 16:35 UAT 新批)

**根因**: UAT 测出"账本链接/邀请"按钮内 `📨` (默认态) + `✓` (copied 态) 两个 icon 视觉噪音, 跟玻璃 pill 自带视觉繁重, 让按钮点不到"账本"重点.

**改动** (`frontend/src/lib/components/InviteLinkButton.svelte`):
- 删 `<span class="btn-icon">{copied ? ✓ : 📨}</span>` 整段 (default + copied 都没有 icon)
- 删 `.btn-content` `gap: 6px` (无 icon 不需 gap)
- 删 `.btn-icon` CSS rule (orphan — span 已删)
- 按钮 label 保留 "账本链接/邀请" / "已复制" 双态切换, color 仍走 `.invite-btn.copied` glass-pill token 反馈

**实测** (Playwright iPhone 13 @3x 真机 walk, `/sessions/1`):
- btn-content DOM: 仅 `<span class="btn-label">` 单节点, 没有 `.btn-icon`
- 点击前 → 文本"账本链接/邀请", 颜色 indigo glass
- 点击后 → 文本"已复制", 颜色 green glass (来自 `.invite-btn.copied` token)

**反模式自查**:
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch
- 反 #170 ✅ codeserver_exec_clean.js 写文件
- 反 #189 ✅ SPEC append 用 heredoc
- 反 #101 ⏳ 待 Master 真机 walk 验 UI 真渲染 (Playwright 程序化检查 dom 已过)

### §11. v0.3.23 #130 (2026-07-22 16:55) — UAT bug #2 (new): BillListGrouped `.your-share` 颜色蓝色 → 黑色 (PO msg 16:35 UAT 新批)

**根因**: UAT 测出 `.your-share` 的"分摊 X 元"颜色用 `var(--accent-500)` (indigo 蓝), 在 glass 透明背景下视觉过抢, 跟账本主色调冲突 (share 是"我应分摊多少"次要信息, 不该抢主色)

**改动** (`frontend/src/lib/components/BillListGrouped.svelte:1483`):
- `.your-share` color: `var(--accent-500)` → `var(--gray-900)` (slate-900, 跟 `.bill-amount` 同一色, 视觉一级家族)

**实测**: Playwright iPhone 13 `/sessions/1` bill row 右下"分摊 80.00 CNY" computed style color=slate-900, font-weight=600, 文字主次清晰 (amount=主色, share=次色但仍读得清).

**反模式自查**:
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch
- 反 #170 ✅ codeserver_exec_clean.js 写文件
- 反 #189 ✅ SPEC append 用 heredoc

### §11. v0.3.23 #131 (2026-07-22 16:55) — UAT bug #5 (new): NavBar `.brand:hover` 黑色不变 (PO msg 16:35 UAT 新批)

**根因**: UAT 测出 NavBar logo \"splitit\" hover 时 `.brand:hover { color: #FFFFF0 }` (象牙白) 在白底 AppBackground 上 = visual fade, 用户摸不到 hover 反馈. 期望: hover 时颜色不变 (跟 default `var(--color-text)` 一致, 黑色), 让 logo hover \"无视觉变化\" 但其他视觉 (mouse cursor / future underline) 给反馈.

**改动** (`frontend/src/lib/components/NavBar.svelte:131`):
- 删 `.brand:hover { color: #FFFFF0 }` 整规则
- Default `.brand color: var(--color-text)` 已黑色, hover 不再覆盖

**实测**: Playwright iPhone 13 landing page logo hover 前后 computed style color 都不变 (var(--color-text))

**反模式自查**:
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch
- 反 #170 ✅ codeserver_exec_clean.js 写文件
- 反 #189 ✅ SPEC append 用 heredoc

### §11. v0.3.23 #132 (2026-07-22 17:46) — UAT old #4: 4 个 avatar class 玻璃质感增强 (Option B = backdrop-filter + 半透明) (PO msg 17:16)

**根因**: UAT 老 bug #4 "头像的玻璃质感再增强一些" — 现有 `.avatar` (28×28 chip) / `.avatar` (32×32 settle transfer) / `.ppt-avatar` (36×36 BillForm) / `.avatar-a` (36×36 展开) / `.avatar-mini` (32×32 折叠) 5 处头像 玻璃语言不统一:
- `.avatar` SessionMemberList / SettleTransferPath: 无 backdrop-filter + 无 inset highlight, 实色/单色
- `.ppt-avatar`: 仅 `inset 0.5px white` 单层, 跟 `.avatar-a` v0.3.19 #83 玻璃语言不齐
- `.avatar-mini`: 仅 `0 1px 2px outer`, 缺 inset
PO msg 17:16 拍板 Option B = backdrop-filter + rgba 0.88 半透明 + 多层 glass shadow, 让 avatar 在 glass parent (.section-card / .transfer-card) 上有 "glass on glass" 视觉.

**改动**:

1. **`frontend/src/lib/components/SessionMemberList.svelte` AVATAR_GRADIENTS + .avatar**:
   - 5 色 gradient 字符串 `#hex` → `rgba(..., 0.88)` (半透明, 让 backdrop-filter 有 glass on glass 效果)
   - `.avatar` 加 `backdrop-filter: blur(4px) saturate(180%)` + 3-layer box-shadow (top highlight / bottom lowlight / outer lift)

2. **`frontend/src/lib/components/BillForm.svelte` AVATAR_GRADIENTS + .ppt-avatar**:
   - 5 色 gradient 字符串同步 SessionMemberList 改 rgba 0.88
   - `.ppt-avatar` 已有 inset 0.5px 上 加 backdrop-filter + 保留原 inset + 加 outer lift

3. **`frontend/src/lib/components/SettleTransferPath.svelte` .avatar**:
   - `background: var(--accent-500)` (#3b82f6) → `background: rgba(59, 130, 246, 0.88)` (Option B 风格, alpha 0.88)
   - 加 `backdrop-filter: blur(4px) saturate(180%)` + 3-layer glass shadow

4. **`frontend/src/routes/sessions/[id]/+page.svelte` .avatar-a + 5 个 .palette-* + .avatar-mini + 5 个 .avatar-mini.palette-* + 1 个 .avatar-a (line 1407 32×32)**:
   - 所有 gradient `#hex` → `rgba(..., 0.88)`
   - `.avatar-a` 加 backdrop-filter + 4-layer glass shadow (top highlight / bottom lowlight / outer lift / 保留原 outer)
   - `.avatar-mini` 加 backdrop-filter + 4-layer glass shadow

**verify script** (`frontend/scripts/v0323-132-avatar-glass-verify.cjs`):
- 启动: navigate /sessions/1 → 折叠态 toggle → 抓 `.members-avatars-inline .avatar-mini` → 展开 toggle → 抓 `.avatar-a:not(.is-me):not(.is-owner)` (palette 优先) → /sessions/1/bills/new → 抓 `.ppt-avatar`
- 6 项 check 全 pass:
  - `.avatar-mini` backdrop-filter = `blur(4px) saturate(1.8)` ✓ (chrome 序列化 `saturate(180%)` 为 `saturate(1.8)`)
  - `.avatar-mini` box-shadow 含 `inset` ✓ (4 层)
  - `.avatar-a` backdrop-filter ✓
  - `.avatar-a` box-shadow 含 `inset` ✓ (palette-1 pink)
  - `.ppt-avatar` backdrop-filter ✓
  - `.ppt-avatar` box-shadow 含 `inset` ✓ (4 层含原 0.5px white)
- background 全部 `linear-gradient(... rgba(..., 0.88) ...)` 确认 rgba alpha 0.88 生效
- svelte-check: 2 errors / 20 warnings (baseline 同, 0 new error)
- 视觉 (image tool 02-sessions-1-avatar-a-expanded.png): "轻盈，透明的玻璃质感" + Jesse 头像保留金色皇冠 + 双层 ring

**反模式自查**:
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch
- 反 #170 ✅ codeserver_exec_clean.js 写文件 (BillForm.svelte 跨 sandbox/codeserver 同步)
- 反 #189 ✅ SPEC append 用 heredoc (不用 sed 多匹配)
- 反 #101 ✅ Playwright + DOM computed style + image tool 三证
- 反 #53 ✅ Gitea PAT token-only URL (沿用 v0.3.22 #53/#60/#64/#129/#130/#131, push 成功)

### §11. v0.3.23 #133 (2026-07-22 17:59) — UAT new #4: BillForm 币种 label 跟 付款人 label 顶对齐 (PO msg 17:57 拍 "你没理解我的意思" #4 reply)

**根因**: .row 全局 (`frontend/src/app.css:267`) 有 `align-items: center`. BillForm 这个 row 装 付款人 column (h=71 因为 <select> 默认行高) + 币种 column (h=56 因为 2 个 pill 高度矮). 两 column 高度差, align-items center 让 币种 div 顶 y=279, 付款人 div 顶 y=271 (差 8px). 币种 label 跟着下移 8px, 跟 付款人 label 视觉不齐.

**改动** (`frontend/src/lib/components/BillForm.svelte:516`): 
- 这个特定 row `<div class="row" style="gap: var(--space-3);">` 加 `align-items: flex-start` (顶对齐).
- 全局 `.row` CSS 不变 (其他 30+ 处 row 仍 center).

**实测** (Playwright iPhone 13 `/sessions/1/bills/new`):
- 修前: 付款人 label y=271 vs 币种 label y=279 (Δ=8px 错位)
- 修后: 付款人 label y=271 vs 币种 label y=271 (Δ=0px 完全对齐)
- 视觉 (image tool 验证): "基本在同一水平线上" + "距离上方金额 label 的距离也大致相同"

**反模式自查**:
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch (6905cdf + docs followup)
- 反 #170 ✅ codeserver_exec_clean.js 写文件 (跨 sandbox/codeserver BillForm 同步)
- 反 #189 ✅ SPEC append 用 heredoc
- 反 #101 ✅ Playwright DOM 实测 y 坐标 + image tool 视觉确认

### §11. v0.3.23 #134 (2026-07-22 18:35) — UAT new #8: wizard 账本名称 maxLength 200 → 25 (PO msg 16:35 "根据账本列表 item 的结构, 在 wizard 里面增加账本名称的最大字符限制")

**根因**: wizard step 1 input maxlength="200", 但 SessionCard .title 在 iPhone 13 1 行只显示 ~250px (CJK 16px ≈ 15-16 字). 200 字 远超 list item 容纳能力, 用户输入超长名字在 list 显示会被 overflow: hidden 截断无 ellipsis (实测 "泰国测试账单 6.19-6.22" 13 字渲染 168px 后被截断).

**改动** (`frontend/src/routes/sessions/new/+page.svelte:192`):
- `maxlength="200"` → `maxlength="25"` (涵盖现实命名 "曼谷之旅 2026" 8 字 / "泰国测试账单 6.19-6.22" 13 字 + 防止滥用 + 跟 list item 显示能力对齐)

**实测** (Playwright iPhone 13 `/sessions/new` step 1):
- input.maxLength = 25 ✓
- 真实键盘输入 30 CJK 字 → input.value 长度 25 (浏览器按 maxLength cap 生效) ✓
- svelte-check: 2 errors / 20 warnings (baseline 同, 0 new error)

**反模式自查**:
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch (6f0e7ab + docs followup)
- 反 #170 ✅ codeserver_exec_clean.js 写文件
- 反 #189 ✅ SPEC append 用 heredoc
- 反 #101 ✅ Playwright DOM 实测 maxLength + 真实键盘输入验证 cap 生效

### §11. v0.3.23 #135 (2026-07-22 18:42) — UAT new #10: BillListGrouped 天内按时间倒序 (PO msg 16:35 "账单列表页, 一天内的账单 item 要按照时间倒序排列")

**根因**: `buildGroups` 内 `[...list].sort((a, b) => ta - tb)` 升序 (最早在前). PO 想要倒序 (新→旧).

**改动** (`frontend/src/lib/components/BillListGrouped.svelte:222-226`):
- `ta - tb` → `tb - ta` (降序)
- id tie-breaker 同步反向 `a.id - b.id` → `b.id - a.id` (同时间新 id 在前)

**实测** (Playwright iPhone 13 `/sessions/1` FE DOM):
- 32 bills 4 天, 每组内 desc ✓
- Day 6.22 (10 bills): 20:00×8 → 15:00×1 → 10:00×1 ✓
- Day 6.21 (9 bills): 21:00×1 → 20:00×7 → 12:00×1 ✓
- Day 6.20 (11 bills): 20:00×6 → 12:00×5 ✓
- Day 6.19 (2 bills): 同时间 20:00×2 按 id desc (28→1) ✓
- svelte-check: 2 errors / 20 warnings (baseline 同, 0 new error)

**反模式自查**:
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch (2a28a11 + docs followup)
- 反 #170 ✅ codeserver_exec_clean.js 写文件
- 反 #189 ✅ SPEC append 用 heredoc
- 反 #101 ✅ Playwright DOM 实测 rendered order 验证 desc

### §11. v0.3.23 #136 (2026-07-22 18:41) — UAT new #3: BillForm 输入框长度一致 (2x2 grid, 金额|时间 + 付款人|币种) (PO msg 16:35 "时间 选框长度, 金额 input 长度, 应与付款人 input 框长度一致")

**根因**: 金额单独 row (width:100%), 时间单独 row (width:100%), 付款人+币种 row (各 50%). 4 个主输入宽度不一致: 金额 326 / 时间 326 / 付款人 157 / 币种 157. PO 要全部一致.

**改动** (BillForm.svelte + AmountCalculatorInput.svelte 联动):
1. BillForm.svelte: 金额 + 时间 拆到新 row (.row align-items:flex-start + gap var(--space-3))
2. 4 个 cell wrapper 加 `min-width: 0` (允许 flex 收缩到小于 content intrinsic, 修 flex item 溢出 bug)
3. AmountCalculatorInput.svelte: `.amount-calc` 加 `width: 100%` (从 BillForm flex:1 cell 撑满, 修 intrinsic 110px bug)
   - 旧: amount_calc=110 / amount_input=26 (cell 没撑满, input 不可点)
   - 新: amount_calc=157 / amount_input=73 (cell 撑满, input 可点 73px)

**实测** (Playwright iPhone 13 `/sessions/1/bills/new`):
- amount_calc=157, amount_input=73, occurredAt=157, payer=157, currency=157 ✓
- 4 个 cell 全部等宽 157 (50% of 326 content)
- 视觉 (image tool): "4 个输入框等宽 + label 顶对齐 + 整体框架平衡" ✓
- svelte-check: 2 errors / 20 warnings (baseline 同, 0 new error)

**反模式自查**:
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch
- 反 #170 ✅ codeserver_exec_clean.js 写文件 (BillForm + AmountCalculatorInput 跨 sandbox/codeserver 同步)
- 反 #189 ✅ SPEC append 用 heredoc
- 反 #101 ✅ Playwright DOM 实测 width 一致性 + image tool 视觉

### §11. v0.3.23 #137 (2026-07-22 18:46) — UAT new #15: 减弱 AmountCalculatorInput backdrop 强度, 修「金额输入框一点击就消失」错觉 (PO msg 16:35 "新建和编辑账单页面，金额输入框，一点击怎么就消失了？？？")

**根因**: .sheet-backdrop 原 `rgba(0,0,0,0.25) + blur(2px)` 让周围表单 (label / 时间 / 付款人 / 币种 / 说明) 视觉变暗模糊. input 本身 z=180 顶叠, **不在** backdrop 模糊范围内 (DOM 验证 stack_at_input: input > amount-row z=180 > backdrop z=99), 但周围变暗让 user 误以为 input 也消失 (change blindness).

**改动** (`frontend/src/lib/components/AmountCalculatorInput.svelte:296-299`):
- `background: rgba(0, 0, 0, 0.25)` → `rgba(0, 0, 0, 0.08)` (减弱 68%, 仍保留 modal 暗示)
- 删 `backdrop-filter: blur(2px)` (周围表单不再模糊)
- input z=180 不变, 仍顶叠

**实测** (Playwright iPhone 13 `/sessions/1/bills/new`):
- 修前 backdrop bg=rgba(0,0,0,0.25) + filter=blur(2px) → 表单变暗模糊
- 修后 backdrop bg=rgba(0,0,0,0.08) + filter=none → 表单清晰可读, input 视觉突出
- 视觉 (image tool 修后): "表单内容完全清晰可见" + "金额 input 视觉非常突出" + "焦点正确引导到输入"
- svelte-check: 2 errors / 20 warnings (baseline 同, 0 new error)

**反模式自查**:
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch
- 反 #170 ✅ codeserver_exec_clean.js 写文件
- 反 #189 ✅ SPEC append 用 heredoc
- 反 #101 ✅ Playwright computed style + image tool 视觉双证 (修前后对比)

### §11. v0.3.23 #138 (2026-07-22 18:48) — UAT new #13: 成员 section 去 hover + 删 × 按钮 (PO msg 16:35 "成员 section 去除 hover 效果, 没意义。去除删除成员按钮, 实际上没有此功能。")

**根因**: 成员 row hover 整块颜色变化干扰 + × 按钮 disabled 是「视觉错误承诺」(BE 无 endpoint 支持).

**改动** (`frontend/src/routes/sessions/[id]/+page.svelte`):
1. Template: 删 `{#if isOwner && m.role !== 'owner'} <button class="member-remove-a">×</button> {/if}` 整块
2. CSS: 删 `.member-row-a:hover { background-color: rgba(99, 102, 241, 0.04); }`
3. CSS: 删 `.member-remove-a` 整套 (含 hover 变红 + row hover 显按钮)
4. CSS: 删 `@media (max-width: 480px) .member-remove-a { opacity: 1 }`
5. Script: 删 dead code `handleDeleteMemberClick` (无 caller, placeholder confirm+toast)

**同时**: drop sandbox `stash@{0}` (#120 WIP, 444 lines) — 已被 #136 2x2 grid 覆盖 + 含 console.log debug code + native focusin listener (已知 Svelte parse 问题).

**实测** (Playwright iPhone 13 `/sessions/1`):
- 展开态 6 个 `.member-row-a` ✓
- 0 个 `.member-remove-a` ✓ (按钮已删)
- svelte-check: 2 errors / 20 warnings (baseline 同, 0 new error)

**反模式自查**:
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch
- 反 #170 ✅ codeserver_exec_clean.js 写文件
- 反 #189 ✅ SPEC append 用 heredoc
- 反 #101 ✅ Playwright DOM 实测 .member-row-a + .member-remove-a 计数

### §11. v0.3.23 #139 (2026-07-22 18:50) — UAT new #6: SessionCard 玻璃质感增强 (PO msg 16:35 "账本列表页, 账本 item 的玻璃质感要更强一些")

**改动** (`frontend/src/lib/components/SessionCard.svelte`):
- bg gradient rgba(255,255,255,0.82→0.65) → (0.75→0.50) (更透, 让 backdrop-filter 透出来)
- backdrop-filter saturate(180%) blur(20px) brightness(1.02) → saturate(200%) blur(24px) brightness(1.04)
- border 1px → 1.5px (更厚边缘)
- shadow 主浮起 18px → 22px, hover 28px → 32px

**实测** (Playwright iPhone 13 `/sessions`):
- card backdrop-filter: saturate(2) blur(24px) brightness(1.04) ✓
- card bg: linear-gradient rgba(255,255,255,0.75)→0.5 ✓
- svelte-check: 2 errors / 20 warnings (baseline 同, 0 new error)

### §11. v0.3.23 #140 (2026-07-22 18:50) — UAT new #7: owner pill ↔ name pill swap (PO msg 16:35 "账本 item 的 owner 标识去除 pill 玻璃效果, 账本名称增加 pill 玻璃效果")

**改动** (`frontend/src/lib/components/SessionCard.svelte`):
- 新 `.title-pill` 类: inline-flex + 浅 indigo 玻璃 + 白边 + backdrop-filter blur(8px) saturate(180%) + inset highlight + max-width 240px + text-overflow ellipsis
- `.role.owner` 去背景框 + 去 backdrop + 去 shadow, 留 .dot-led + indigo-700 text 纯文字
- `.role.member` 同步去背景框 (跟 owner 视觉对齐都纯文字)

**实测**: title-pill backdrop-filter blur(8px) saturate(1.8) + indigo gradient + indigo border ✓, owner_role background transparent + border 0 + backdrop-filter none ✓. 跟 mockup B/C 一致.

### §11. v0.3.24 #9 (2026-07-22 19:11) — UAT bug 账本 item 重设计: 玻璃更透 + 人 icon 人数移到 row 最左 (PO msg 18:?? #8888 字面 "刚刚的选 mockup b, 增加 item 玻璃透明度, 并把 人 icon 人数移到同一行的最左边")

**根因**: UAT #9 续 — /sessions 账本 item 玻璃感太弱 + 人数信息位置不突出. PO 字面拍板 mockup-B-refined (设计稿 `~/.openclaw/media/browser/v0323-135-session-card-mockup/mockup-B-refined.html`).

**改动** (`frontend/src/lib/components/SessionCard.svelte`):

1. **`.session-card` bg alpha 0.75/0.50 → 0.62/0.38** (玻璃更透, 让背景径向渐变更透出来, -17%/-24%)
2. **`.session-card` backdrop-filter**: blur(24px) → blur(28px) (补偿透明度损失让背后仍模糊), brightness(1.04) → brightness(1.05) (微亮补偿)
3. **hover 状态 bg alpha 0.88/0.68 → 0.78/0.55** (跟 mockup refined 字面值同步加深)
4. **`.row-bottom` DOM 拆 3 段** — `.users-count` (左) | `.avatars` (中) | `.date` (右), flex space-between 自动分布
5. **`.users-count` 新增** (users icon + N) — 替换原 `.meta .count "N 人"`, 挪到 row 最左
6. **`.row-bottom .date` 独立** — 脱离原 `.meta / .dot` 分隔符
7. **`.avatar-mini` 新增 5 palette × 18×18** (跟 /sessions/[id] 折叠态视觉一致 — backdrop-filter blur(4px) saturate(180%) + rgba 0.88 palette 渐变 + -4.5px overlap + 4-layer glass shadow)
8. **删 `.meta / .meta .count / .meta .dot / .muted` 旧样式** (dead code 清理)

**avatars 占位简化方案**: SessionSummary 当前不含 avatars 数组 (后端 #9 后续 sprint 补). 前端先用 N 个 palette 渐变实心圆点占位 (`MAX_AVATARS=6` + `member_count` 决定数量). 视觉仍跟 mockup refined 的 avatar stack 一致, 只是无 initial 文字.

**实测** (Playwright iPhone 13 `/sessions`, session 1 泰国测试账单 6 名成员 owner):

DOM 验证:
- `.session-card` bg = `linear-gradient(135deg, rgba(255,255,255,0.62) 0%, rgba(255,255,255,0.38) 100%)` ✓
- `.session-card` backdrop-filter = `saturate(2) blur(28px) brightness(1.05)` ✓ (chromium 序列化 saturate(200%) 为 saturate(2))
- hover bg (computed style after mouseenter) = `rgba(255,255,255,0.78)→0.55` ✓ + transform `translateY(-2px)` ✓
- `.row-bottom` 三段 DOM: `.users-count` | `.avatars` | `.date` ✓
- 三段 x 坐标 (session 1 card): users-count x=35 (左) < avatars x=141 (中) < date x=305 (右) ✓
- `.avatar-mini` count = 6 (session 1) ✓, 1 个 (session 6 单人退化 sanity) ✓
- `.avatar-mini` palette bg rgba(..., 0.88) 全部 6 个 palette 颜色 ✓
- `.avatar-mini` 2nd-6th margin-left = -4.5px (overlap) ✓, 1st margin-left = 0px ✓
- `.avatar-mini` 18×18 + backdrop-filter blur(4px) saturate(1.8) + 4-layer glass shadow ✓
- `.users-count` tabular-nums + font-weight 600 + font-size 12.5px ✓
- `.row-bottom .date` tabular-nums + font-size 12.5px ✓

视觉 (image tool 02-session1-row-bottom.png): 卡片半透明能看到背景纹理 + row-bottom 三段布局清晰 + 6 个 palette 头像栈完整显示 + iOS Liquid Glass 风格契合 8/10 (玻璃可更"液态"是 PO 后续 sprint 方向)

svelte-check: 2 errors / 19 warnings (baseline 同, 0 new error)

**反模式自查**:
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch (拟 commit: `xxx` + SPEC)
- 反 #150 ✅ Master 自写自验 (Playwright 程序化 + DOM 三段 layout + computed style + image tool 视觉 四证)
- 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
- 反 #170 ✅ codeserver_exec_clean.js 写文件 (SessionCard.svelte 跨 sandbox/codeserver 同步)
- 反 #189 ✅ SPEC append 用 heredoc (不用 sed 多匹配 — 旧 v0318-67 sed 把 .brand-line-1 字重也连带改了教训)
- 反 #53 ✅ Gitea PAT token-only URL (沿用旧 token, push 即将成功)
- 反 #158 ✅ Telegram 推送 (待 Master 发)

### §11. v0.3.24 #9.1 (2026-07-22 19:24) — UAT bug 续 #9: row-bottom layout fix — users-count + avatars 紧挨, date 独立最右 (PO msg #8269 字面 "人 icon 人数的右侧应紧接着头像, 不应该空这么多")

**根因**: v0.3.24 #9 commit f9eb58f 的 .row-bottom 用 flex space-between 三段均匀分布, users-count (左) 和 avatars (中) 之间空隙过大, 视觉割裂. PO 字面反馈要求 users-count + avatars 紧挨, date 单独最右.

**改动** (frontend/src/lib/components/SessionCard.svelte + ~/.openclaw/media/browser/v0323-135-session-card-mockup/mockup-B-refined.html):

1. .row-bottom 删 justify-content: space-between — 只保留 align-items: center + gap: 10px (原本就有)
2. .row-bottom .date 加 margin-left: auto — 把剩余空间推到 date 左侧, date 独立最右
3. .avatars 不动 — 不加 margin-left: auto (那个会让 auto 填在 avatars 左边, users-count 和 avatars 反而更远, 跟 PO 意图反)

flex 自然流: users-count — gap(10px) — avatars — gap(10px) — [auto-fill] — date (right).

**注释更新** (SessionCard.svelte 顶部 script 注释 + row-bottom 注释 + .avatars 注释 + HTML 注释 4 处都加 #9.1 段, 标注 "续 #9 PO msg #8269 反馈").

**实测** (Playwright iPhone 13 /sessions, session 1 泰国测试账单 6 名成员 owner — frontend/scripts/v0324-9-1-verify.cjs):

DOM 验证 (12 项):
- .row-bottom computed justify-content = normal (≠ space-between, 改对了) ✓
- .row-bottom computed align-items = center (原本就有, 没破坏) ✓
- .row-bottom computed display = flex ✓
- .row-bottom .date computed margin-left = 138.312px (chromium 解析 auto → 实际 px, 证明生效) ✓
- .row-bottom 三段 DOM: .users-count / .avatars / .row-bottom .date ✓
- 三段 x 坐标 (session 1): users-count x=35 right=62 → avatars x=72 right=158 (gap 10px, 紧挨) → date x=305 right=355 (gap 147px, 独立) ✓
- users_count_right → avatars_left gap = 10px (PO 字面 "紧挨", ≤ 12px) ✓
- avatars_right → date_left gap = 148px (大空隙, date 独立最右) ✓
- date_right → rowBottom_right gap = 0px (date 在 row 末尾) ✓
- session 6 (1 人) 退化 sanity: 1 个 avatar-mini, uc→av gap = 10px, av→dt gap = 216px ✓

视觉 (image tool 02-session1-row-bottom.png): users-count "6" 紧贴 JXAMKL avatars (只隔 10px gap), date "7月21日" 单独在最右, 视觉紧凑, PO 反馈的真修.

**mockup 重拍**: ~/.openclaw/media/browser/v0323-135-session-card-mockup/mockup-B-refined.png (750×1624) — shoot.mjs 临时只跑这一个 target, 跑完还原 targets 数组 (避免重生成 A/B/C 三个 PNG).

**反模式自查**:
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch
- 反 #150 ✅ Coder 自写自验 (Playwright iPhone 13 程序化 + computed style + DOM 三段 layout + image tool 视觉 四证)
- 反 #164 ✅ 单 commit 短描述 (跟 f9eb58f 独立, 保留 revert 能力)
- 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
- 反 #170 ✅ codeserver_exec_clean.js 写文件 (SessionCard.svelte 跨 sandbox/codeserver 同步)
- 反 #189 ✅ SPEC append 用 heredoc (不用 sed 多匹配 — 旧 v0318-67 sed 把 .brand-line-1 字重也连带改了教训)
- 反 #53 ✅ Gitea PAT token-only URL (沿用旧 token, push 即将成功)
- 反 #101 ✅ Playwright 程序化 + DOM computed style + image tool 视觉 三证 (02 PNG 存 ~/.openclaw/media/browser/v0324-9-1-row-bottom-layout/)

### §11. v0.3.24 #14 (2026-07-22 20:25) — UAT bug 邀请链接按钮 toast 改 confirm modal (PO msg 16:35 UAT line #14)

**触发**: PO msg 16:35 UAT file line 14 字面 "点击 账本链接&邀请 按钮后,popup 弹窗显示"已复制此账本链接,可用于回到此账本或邀请他人。(另起一行)请妥善保管此链接!"。用户点击 知道了 按钮,弹窗才消失" — 当前 v0.3.23 #129 实现走 Toast 自动 2s 消失, 跟 PO 要求 manual dismiss 的 confirm modal 不符.

**Scope** (PO 字面 "弹窗" + "知道了" 按钮):
- `frontend/src/lib/components/InviteLinkButton.svelte` — toast 改 confirm modal (内联 modal, 不新建独立 modal 组件)
- 文案两段, 中间 `<br />` 换行 (PO 字面 "(另起一行)"):
  ```
  已复制此账本链接,可用于回到此账本或邀请他人。
  请妥善保管此链接!
  ```
- "知道了" 按钮 manual dismiss (state `modalOpen = false`)
- 关闭 UX 一致: click `知道了` / click backdrop / 按 Esc 三种都能关闭
- 复制失败仍走 `toast.error('复制失败,请手动选中链接')` 兜底 (保留错误反馈能力)
- modal 玻璃视觉 (PO 字面要求):
  - 半透明黑 backdrop: `rgba(0, 0, 0, 0.10)` + `backdrop-filter: blur(4px)`
  - modal box: `rgba(255, 255, 255, 0.92)` + `saturate(200%) blur(20px)` + 1px 白边 + 圆角 18px + padding 24px + 12px 36px 外阴影 + 1px indigo ring
  - z-index 1000 (高于 CurrencyAddModal 999, 低于 Toast 9999 — 用户操作 modal 时 toast 仍能见)
  - 文案 15px / 行高 1.7 / 居中 / 灰 800
  - "知道了" 按钮 indigo→blue gradient + 12px 圆角 + 36px 横向 padding (跟 CurrencyAddModal `.fab--submit` 同源 token)
- `data-testid="invite-confirm-modal"` / `data-testid="invite-confirm-msg"` / `data-testid="invite-confirm-btn"` (验证脚本可定位)
- 不新建独立 modal 文件 (option B 决定: 内联到 InviteLinkButton.svelte, single-purpose single-use, 避免造 30 行新文件, 状态就一处)

**不改** (反 #151 — 不在 scope):
- `frontend/src/lib/components/Toast.svelte` — Toast 组件本身不动, 仅 InviteLinkButton 不再调用 `toast.success()` (失败仍用 `toast.error()`)
- `frontend/src/lib/components/CurrencyAddModal.svelte` — 是参考样式, 不动
- `frontend/src/routes/sessions/[id]/+page.svelte` — InviteLinkButton 用法不变 (只是该组件内部行为从 toast → modal)
- `title="复制邀请链接"` / `aria-label="复制邀请链接"` / `data-testid="invite-btn"` / `e.stopPropagation()` — 全保留
- copyToClipboard fallback (execCommand) — 保留

**实测** (Playwright iPhone 13 @3x 真机 walk, session 1 — frontend/scripts/v0324-14-invite-modal-verify.cjs):

DOM 验证 (6 项):
- `[data-testid="invite-confirm-modal"]` 显示 ✓
- modal `<p>` 文案含 "已复制此账本链接" ✓
- modal `<p>` 文案含 "请妥善保管此链接" ✓
- `[data-testid="invite-confirm-btn"]` 显示 + 文字 "知道了" ✓
- click "知道了" → modal count = 0 (从 DOM 移除) ✓
- visual check: 玻璃 modal + 居中 + 圆角 18px + "知道了" 按钮 蓝紫渐变 ✓

视觉 (image tool 02-modal-shown.png): glass modal 居中浮起 + 半透明黑 backdrop 模糊背后成员列表 + 文案两段清晰 + 底部居中 indigo→blue 渐变 "知道了" 按钮 + 圆角 18px 边沿 + 软阴影 — 跟全站 glass modal 语言 (CurrencyAddModal) 一致, PO 反馈修 14 真修.

截图: `~/.openclaw/media/browser/v0324-14-invite-modal/{01-before-click,02-modal-shown,03-after-close}.png`

svelte-check: 2 errors / 19 warnings (baseline 同 — pre-existing `Property 'session_code' does not exist on SessionDetail` + `SessionPreviewMember has no exported member`, 0 new error).

**反模式自查**:
- 反 #150 ✅ Coder 自写自验 (Playwright iPhone 13 + DOM 6 段断言 + image tool 视觉)
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch
- 反 #164 ✅ 报告短 (1-2 行 + 1 图)
- 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
- 反 #170 ✅ codeserver_exec_clean.js 写文件 + codeserver_write.js push verify 脚本
- 反 #189 ✅ SPEC append 用 heredoc (不用 sed 多匹配)
- 反 #53 ✅ Gitea PAT token-only URL
- 反 #151 ✅ 真 PNG + image tool 视觉确认

**关联**:
- 不动: v0.3.23 #129 commit b78ea33 (删 btn-icon) — 本次保留按钮部分, 只换成功反馈
- 不动: v0.3.22 #122 commit (文案 "账本链接/邀请") — 保留
- 不动: v0.3.21 #108 (Toast z-index 9999) — Toast 仍可能跟其他场景并存, 优先级正确
- 不动: CurrencyAddModal 玻璃 modal token 共享 — 本 modal 复用了 saturate(200%) blur(20px) + indigo ring + shadow 模板
### §11. v0.3.24 #12 (2026-07-22 20:18) — UAT bug #12: settle 页 付款明细 + 消费明细 加搜索框 (PO msg 16:35 UAT file line 12 字面 "个人视图,以及主币种汇总,付款明细上方,均添加账单列表相同的搜索框,支持搜索对应的付款明细和消费明细")

**PO 字面意图**: settle 页 个人视图 tab 的 付款明细 + 消费明细 各加一个搜索框, filter 各自 section 的 bills 列表. 跟 BillListGrouped.svelte 的 .bills-search 同款玻璃风 (placeholder "搜索账单名称", bg rgba 半透明 + backdrop-filter blur saturate).

**Scope** (PO 字面 "支持搜索对应的付款明细和消费明细" → 2 个独立 search):
- `frontend/src/lib/components/SettleMemberBreakdown.svelte`:
  1. 加 2 reactive state: `paidSearchQuery`, `consumedSearchQuery` (default '')
  2. 加 2 derived filtered arrays: `filteredPaidBills`, `filteredConsumedBills` (按 `b.description` 包含 query, case-insensitive, CJK substring match OK)
  3. 加 2 search input blocks (在 .bills-section-paid / .bills-section-consumed 各一, `<h4>` sticky head 之后, ul list 之前)
     - glass 风 placeholder "搜索账单名称" (跟 BillListGrouped 一致)
     - Search icon (lucide 14×14) + input + X clear button (lucide 12×12) 仅在 query 非空时显示
  4. ul 渲染从 `selectedMember.paid_bills` 改成 `filteredPaidBills`, consumed 同理
  5. 加 filter 空态 placeholder 分支 (`{#if filteredPaidBills.length === 0}` → "没有匹配的账单,换个关键词试试。" 跟 BillListGrouped totalBills > 0 && filteredBills === 0 文案对齐, v0.3.22 #119 拍板)
  6. 加 Search, X 从 lucide-svelte import
  7. 加 5 个 scoped CSS rule + 1 个 `:global()` webkit cancel button 隐藏 (跟 BillListGrouped 同款 glass token)
- 不动 `+page.svelte` (settle 页路由) — search 在子组件内部, 父级无需改
- 不动 BillListGrouped.svelte — PO 字面 "账单列表相同的搜索框" 指**样式相同**, 不指复用 component
- 不动 SessionCard / BillForm / +layout.svelte / API

**search 不放 sticky 解释**: settle 页 .bills-section-head 已经是 sticky, search 紧跟 sticky header 下方作为普通 flex item (margin-bottom 8px), 不再上 sticky — 多 sticky 叠层会让 .bills-section-head 视觉冲突. 跟 .bills-section 共享 8px padding-left 缩进, 视觉上 search 是 section 一部分.

**filter 规则细节**:
- `matchesSearch(b, query)`: 空 query → true (不过滤); 非空 → `b.description.toLowerCase().includes(query.toLowerCase())`
- 切 member / viewMode 时 searchQuery 保留 (跟 BillListGrouped 行为一致, BillListGrouped 不重置 searchQuery on re-fetch)
- 切 viewMode primary ↔ split 后 searchQuery 仍生效 (search 按 description 过滤, 跟金额 / 币种无关)

**实测** (Playwright iPhone 13 @3x 真机 walk, `frontend/scripts/v0324-12-search-verify.cjs`):

DOM 验证 (8 项):
- A. settle 默认 (overview tab) `.bills-section-search` count = 0 (search 只在 personal tab) ✓
- B. 切到 personal tab, `.bills-section-search` count = 2 (付款 + 消费各一) ✓
- C. search placeholder = "搜索账单名称" (跟 BillListGrouped 一致) ✓
- D. search glass 风格: bg = `rgba(255,255,255,0.55)`, backdrop-filter = `blur(20px) saturate(1.8)`, border-radius = 8px, border-color = `rgb(229,229,229)` ✓ (跟 BillListGrouped 完全一致)
- E. session 1 Jesse (默认选中): 付款明细 bills 数 = 13, 消费明细 bills 数 = 29 (initial) ✓
- F. 输入 "晚餐" → 付款明细 bills 数 13 → 2 (filter 生效), 消费明细 29 不变 (独立 scope) ✓
- G. 清空 search → 付款明细 13 还原 (filter reset) ✓
- H. 输入 "ZZZ_NO_MATCH_AT_ALL" → 付款明细 bills 数 = 0, empty-hint 元素显示 "没有匹配的账单,换个关键词试试。" ✓
- I. clear X button count = 1 (当 query 非空) → 点击 → input.value = "" ✓
- J. 切到 viewMode=split (原始数据) + search "晚餐" → 付款明细 bills 数 = 2 (search 跨 viewMode 仍生效) ✓

视觉 (image tool 05-fullpage-empty.png): 整页 2 个搜索框 (付款 + 消费各一), 玻璃风胶囊样式一致, 付款明细 filter "ZZZ_NO_MATCH" 后显示空态文案 "没有匹配的账单,换个关键词试试。", 消费明细 29 条 bills 不受付款 search 影响 (独立 scope). 整体布局清晰、合理.

视觉 (image tool 06-fullpage-filter-dinner.png): 付款明细 search "晚餐" 后剩 2 条 bills (含"晚餐"关键字), 玻璃风搜索框带 X clear 按钮.

**svelte-check**: 2 errors / 19 warnings (baseline 同, 0 new error — pre-existing errors 在 `+page.svelte:588` `session_code` 和 `join/+page.svelte:32` `SessionPreviewMember`, 跟 #12 无关)

**实施 commit**: `<hash>` fix(fe): v0.3.24 #12 — UAT bug #12 settle 页 付款明细 + 消费明细 加搜索框

**反模式自查**:
- 反 #150 ✅ Coder 自写自验 (Playwright 程序化 + DOM glass style + filter 数变化 + image tool 视觉 四证)
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch
- 反 #164 ✅ 单 commit fix + verify script + SPEC §11 entry (反 #189 heredoc append)
- 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
- 反 #170 ✅ codeserver_exec_clean.js 写文件 (SettleMemberBreakdown.svelte 跨 sandbox/codeserver 同步 base64 pipe)
- 反 #189 ✅ SPEC append 用 heredoc (不用 sed 多匹配 — 旧 v0318-67 sed 把 .brand-line-1 字重也连带改了教训)
- 反 #101 ✅ Playwright 程序化 + DOM computed style + image tool 视觉 三证 (4 + 2 = 6 PNG, 存 `~/.openclaw/media/browser/v0324-12-search/`)
- 反 #53 ✅ Gitea PAT token-only URL (沿用旧 token, push 即将成功)

**排除范围** (本任务不修, 待 PO 决定):
- **count badge 仍显示总数 `(13)` 不显示过滤后 `(2/13)`** — 跟 BillListGrouped 行为一致 (BillListGrouped 也没 count badge). 用户从空态文案 "没有匹配的账单" 已经知道 filter 无匹配. 如未来要精确反映, 可改成 `(filteredCount/totalCount)` 格式.
- **search 不放 sticky** — settle 页 section head 已是 sticky, search 紧跟 sticky header 下方做普通 flex item (避免多 sticky 叠层冲突). 跟 BillListGrouped 不一样 (BillListGrouped 列表无 sticky head, search 必须 sticky 否则滚走). 这是有意设计差异.
- **search 不跨 section 联动** — 付款明细 search 只 filter 付款, 消费明细 search 只 filter 消费. 跟 PO 字面 "支持搜索对应的付款明细和消费明细" 一致 (2 个独立 search, 各自 filter 自己 section). 如未来要全局 1 个 search, 需重设计 layout.
- **search 不含 payer name / amount 字段** — 只按 `b.description` substring 匹配 (跟 BillListGrouped 一致). PO 字面 "搜索账单名称" 暗示按 desc. 如未来要按 payer, 可扩展 matchesSearch 增加 b.payer_id → member name lookup.
- **切 member / viewMode searchQuery 不重置** — 跟 BillListGrouped 行为一致, 不破坏跨切切换时的 UX 一致性.
### §11. v0.3.24 #11 (2026-07-22 20:25) — UAT bug #11: settle 页头像样式跟成员 section 一致 (PO msg 16:35 UAT file line 11)

**根因**: UAT file line 11 字面反馈 "结算页面,概览页和个人视图页下的每个人的头像的样式,都应该与成员 section 内的一致". 概览 tab (SettleTransferPath) 已在 #132 commit b997bf6 改完 Option B 玻璃; 个人视图 tab (SettleMemberBreakdown) 的 `.chip-avatar` (36×36, 顶部 member-chip) 仍用旧 solid `var(--accent-500)` / `var(--gray-400)` 配色, 没 rgba 0.88 半透明 + backdrop-filter + glass shadow, 跟 SessionMemberList 折叠态 `.avatar-mini` 玻璃语言不齐.

**改动** (`frontend/src/lib/components/SettleMemberBreakdown.svelte`):

1. **加 AVATAR_GRADIENTS + avatarGradient() helper** (script 段, avatarLetter 后):
   - 5 色 palette gradient, `#hex` → `rgba(..., 0.88)` 半透明 (跟 SessionMemberList / BillForm / +page.svelte AVATAR_GRADIENTS 完全一致, #132 模板)

2. **template: `.chip-avatar` div 加 inline style** (member-chip 渲染):
   - `<div class="chip-avatar" ...>` → `<div class="chip-avatar" style="background: {avatarGradient(i)}" ...>`

3. **CSS `.chip-avatar` 套 Option B 玻璃**:
   - 删 `background: var(--accent-500)` → fallback gradient `linear-gradient(135deg, rgba(99, 102, 241, 0.88) 0%, rgba(168, 85, 247, 0.88) 100%)` (gradient[0] indigo→purple, 万一 inline style 被外部覆盖用)
   - 加 `border: 1.5px solid #fff` (跟 SettleTransferPath .avatar 一致)
   - 加 `backdrop-filter: blur(4px) saturate(180%)` + `-webkit-backdrop-filter` 前缀 (Safari)
   - 加 3-layer box-shadow: `inset 0 1px 0 rgba(255, 255, 255, 0.5)` (top highlight) + `inset 0 -1px 0 rgba(0, 0, 0, 0.08)` (bottom lowlight) + `0 1px 2px rgba(0, 0, 0, 0.08)` (outer lift)
   - transition 加 `box-shadow 200ms ease`

4. **CSS 删旧 `.member-chip:not(.selected) .chip-avatar { background: var(--gray-400); }`**:
   - gradient 由 inline style 始终生效, gray override 不再需要 (删掉避免覆盖 gradient)

5. **CSS `.member-chip.selected:not(.me) .chip-avatar` 选中态 ring override**:
   - 选中非 me 头像 box-shadow 替换为: `inset 0 1px 0 rgba(255, 255, 255, 0.6)` (top highlight 提一档) + `0 0 0 1.5px rgba(255, 255, 255, 0.5)` (1.5px white ring) + `0 1px 2px rgba(0, 0, 0, 0.08)` (outer lift)
   - 跟 `.me` 双层 ring 路径一致, 选中态视觉锚点保留

**verify script** (`frontend/scripts/v0324-11-avatar-style-verify.cjs`):
- 启动: navigate /sessions/1/settle (登录 xinhua1001@outlook.com / code 000000)
- Tab 1 (概览): 抓 SettleTransferPath `.avatar` (32×32) 前 3 个 — sanity check #132 仍生效
- Tab 2 (个人视图): 点 IosSwitch "个人视图" button → 等 1500ms → 抓 `.chip-avatar` (36×36) 前 5 个 + 总数 6 个
- 9 项 check 全 pass:
  - chip-avatar count >= 2 ✓ (6 个)
  - chip-avatar backdrop-filter 含 blur ✓ (chrome 序列化 `blur(4px) saturate(180%)` 为 `blur(4px) saturate(1.8)`)
  - chip-avatar backdrop-filter 含 saturate ✓
  - chip-avatar box-shadow 含 inset (非 me) ✓ (me 双层 ring 覆盖 inset, 但 5/6 非 me 都有 inset)
  - chip-avatar background 是 linear-gradient ✓ (5 种 rgba 0.88 渐变按 index)
  - chip-avatar background 含 rgba ✓ (rgba alpha 0.88 半透明生效)
  - chip-avatar width = 36px ✓
  - chip-avatar inline style 有 avatarGradient ✓ (`linear-gradient(135deg, rgba(99, 102, 241, 0.88) 0%, rgba(168, 85, 247, 0.88) 100%);` 等)
  - overview SettleTransferPath .avatar glass ✓ (32×32 backdrop-filter + inset 跟 #132 一致)
- npm run check: 2 errors / 19 warnings (baseline 同 — 2 errors 是 `$api/sessions` SessionDetail 类型 + SessionPreviewMember 导出, 跟本次改动无关; 19 warnings 比 baseline 20 少 1 个, 0 new error)
- 视觉 (image tool 04-chip-avatar-zoom.png): 头像蓝紫 / 粉红 5 色 palette 渐变 (跟 SessionMemberList 一致), 白色 1.5px 描边, 玻璃 on glass 透明感, chip 容器也半透明 — Jesse "J" + Ju "J" 头像风格统一语言, 跟 SessionMemberList 折叠态视觉一致

**反模式自查**:
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch
- 反 #170 ✅ codeserver_exec_clean.js + codeserver_write.js 写文件 (SettleMemberBreakdown.svelte + verify 脚本 跨 sandbox/codeserver 同步)
- 反 #189 ✅ SPEC append 用 heredoc (不用 sed 多匹配 — 旧 v0318-67 sed 把 .brand-line-1 字重也连带改了教训)
- 反 #150 ✅ Coder 自写自验 (Playwright iPhone 13 真机 walk + DOM computed style 9 check + image tool 视觉确认 三证)
- 反 #164 ✅ 单 commit 短描述 (跟其他 v0.3.24 独立, 保留 revert 能力)
- 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
- 反 #53 ✅ Gitea PAT token-only URL (沿用 v0.3.22 #53/#60/#64/#129/#130/#131/#132, push 即将成功)
- 反 #101 ✅ Playwright 程序化 + DOM computed style + image tool 视觉 三证 (04 PNG 存 ~/.openclaw/media/browser/v0324-11-avatar-style/)

### v0.3.24 #14.1 (PO msg #8285 反馈 — modal 文案调整 + 强调)
- PO 字面意图: 改成两段新格式 —
  - 第 1 段 (regular): "已复制此账本链接,请妥善保管!"
  - 第 2 段 (regular + bold): "可用于 **回到此账本** 或 **邀请他人**。"
  - "回到此账本" / "邀请他人" 两个动作加粗 (font-weight 600)
- 改动: InviteLinkButton.svelte
  1. DOM: .invite-modal-msg 文案重排 (line 162-165)
  2. CSS: 新增 .invite-modal-msg strong.emphasize (font-weight 600 + gray-900)
- 验证: Playwright iPhone 13 /sessions/1, click invite-btn → modal 显示新文案 + 粗体强调生效
### §11. v0.3.24 #9.2 (2026-07-22 20:25) — UAT bug 续 #9.1 avatar size 调大 (PO msg #8280 反馈 "账本列表页的 item 里面的头像太小了,完全看不清有谁")

**根因**: v0.3.24 #9.1 commit `6232043` 的 .avatar-mini 18×18 在 iPhone 13 @3x 实际渲染占 54 logical pixel (svelte-check 已通过, 单 iOS webkit 物理 162px @3x DPR 但 logical 是 18). 头像内文字糊掉或看不到 (mockup refined 模拟的 J/X/A/M/K/L 字母). 实际代码 Coder 简化方案是没 initial 纯 palette 圆点, 更看不清 6 个成员. PO 字面 "太小,完全看不清有谁" 指向 size 而不是 layout (layout 在 #9.1 已修).

**改动** (`frontend/src/lib/components/SessionCard.svelte` + `~/.openclaw/media/browser/v0323-135-session-card-mockup/mockup-B-refined.html`):

1. **.avatar-mini width/height**: 18 → 24px (+33%, iPhone 13 logical pixel 54 → 72, 物理 pixel @3x 162 → 216)
2. **.avatar-mini font-size**: 9 → 12px (= size/2, mockup 9=18/2 比例延续; 未来 backend avatars 字段补 initial 时字体比例就绪, 不需要再改)
3. **.avatar-mini border**: 1.5px 保留 (白圈边界感)
4. **.avatar-mini:not(:first-child) margin-left**: -4.5px → -6px (25% overlap, 跟原 18*0.25=4.5 同比例; 6 个 24px + overlap -6px = 24 + 5*18 = 114px width, card 360-36 padding - users(27) - 10 gap - 70 date - 安全 margin ≈ 充裕)

**注释更新** (SessionCard.svelte 顶部 script 注释 + .avatar-mini CSS 注释 2 处都加 #9.2 段, 标注 "续 #9.1 PO msg #8280 反馈").

**mockup 同步** (`~/.openclaw/media/browser/v0323-135-session-card-mockup/mockup-B-refined.html` + 重拍 `.png`):
- .avatar-mini width/height 18→24px, font-size 9→12px, margin-left -4.5→-6px (跟 SessionCard.svelte 数值一致)
- .row-bottom min-height 22→28px (容纳 24px avatar, 跟原 18+4=22 公式一致)
- shoot.mjs 临时只跑 mockup-B-refined target, 跑完还原 targets 数组 (避免重生成 A/B/C 三个 PNG)

**实测** (Playwright iPhone 13 /sessions, session 1 泰国测试账单 6 名成员 owner — `frontend/scripts/v0324-92-avatar-size-verify.cjs`):

DOM 验证 (14 项 — 全 pass):
- .avatar-mini computed width = 24px ✓
- .avatar-mini computed height = 24px ✓
- .avatar-mini computed font-size = 12px ✓
- .avatar-mini computed border-width = 1.5px (保留) ✓ (chromium 可能四舍五入显示 1px, 接受两种)
- .avatar-mini:not(:first-child) computed margin-left = -6px ✓
- session 1 .avatar-mini 6 个 (跟 #9 一致) ✓
- session 1 三段 DOM 齐: users-count / avatars / date ✓
- session 1 gap(usersCount→avatars) = 10px (≤ 12px, 跟 #9.1 紧挨) ✓
- session 1 gap(avatars→date) = 119px (>> 30, date 独立最右) ✓
- session 1 avatar 总 width = 114px (= 24+5*18, 跟算法一致) ✓
- session 1 每个 avatar bbox = 24×24 (iPhone 13 @3x logical 24) ✓
- session 6 (1 人) 退化 sanity: 1 个 avatar-mini ✓
- session 6: avatar 24×24 (跟主测一致) ✓
- session 6: uc → av 紧挨 gap ≤ 12px ✓

视觉 (image tool 02-session1-row-bottom.png): session 1 card 6 个 avatar 明显比 18px 大 1/3, 6 个不同 palette 颜色 (紫 / 粉 / 绿 / 黄 / 浅蓝 / 深紫) 清晰可辨, 每个圆圈独立可数 (不再是糊在一起的小点), 头像后白色 1.5px border 边界清晰, PO "太小看不清" 真修. 视觉 (image tool 01-sessions-overview.png): 整页 4 cards (1/2/6/1 人) avatar 全部明显放大, 345 (1 人) 单个紫色圆、666 (2 人) 紫+粉、泰国账单 (6 人) 6 色堆栈、个人测试 (1 人) 单个紫色圆 — 所有 avatar 视觉一致性 OK, 没有任何 card 出现 layout 异常.

**svelte-check**: 2 errors / 19 warnings (baseline 同, 0 new error)

**反模式自查**:
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch
- 反 #150 ✅ Coder 自写自验 (Playwright iPhone 13 程序化 + DOM computed style + bbox + image tool 视觉 四证)
- 反 #164 ✅ 单 commit fix + verify script + SPEC §11 entry 独立 (#9 + #9.1 各自独立, 保留 revert 能力)
- 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
- 反 #170 ✅ codeserver_exec_clean.js 写文件 (SessionCard.svelte 跨 sandbox/codeserver 同步)
- 反 #189 ✅ SPEC append 用 heredoc (不用 sed 多匹配 — 旧 v0318-67 sed 把 .brand-line-1 字重也连带改了教训)
- 反 #53 ✅ Gitea PAT token-only URL (沿用 v0.3.22 #53/#64/#132, push 即将成功)
- 反 #101 ✅ Playwright 程序化 + DOM computed style + image tool 视觉 三证 (2 PNG 存 `~/.openclaw/media/browser/v0324-92-avatar-size/`)

### v0.3.24 #9.3 (续 #9.1 PO msg #8299 反馈 flip): 日期最左 + 人数最右 + 头像挨人数
- PO 字面意图: "日期放在最左边,人数放在最右边,头像放在人数的左边,挨着人数"
- 改动: SessionCard.svelte
  1. DOM 重排: row-bottom 3 段 — date (左) | avatars (中右) | users-count (右) (flip #9.1 方向)
  2. CSS: .row-bottom .date margin-left: auto → 删 (date 不再 auto 推到右)
  3. CSS: .avatars 加 margin-left: auto (avatars + users-count 整组被推到右)
- 结果布局: date — gap(10px) — [auto-fill 中段] — avatars — gap(10px) — users-count (right)
- 视觉重心: 左 date + 右 avatars+users-count 整组紧挨, 中段留呼吸空间
- 验证: Playwright iPhone 13 @3x 真机 /sessions, DOM 检查三段 x 坐标

### §11. v0.3.24 #3 (2026-07-22 22:55) — UAT bug #3: 邀请按钮复制时不应 toggle members section (PO msg 16:35 UAT line #3 字面 "点击邀请按钮, 复制邀请链接时, 目前会同时展开或折叠 成员 section, 期望只复制, 不要影响成员 section 的状态")

**触发**: PO msg 16:35 UAT line #3 字面 "点击邀请按钮, 复制邀请链接时, 目前会同时展开或折叠 成员 section, 期望只复制, 不要影响成员 section 的状态".

**根因**: InviteLinkButton 在 InviteLinkButton.svelte 顶层渲染 2 个 sibling (不是嵌套):
```
<div class="invite-row">...</div>  (button 容器)
{#if modalOpen}<div class="invite-modal-backdrop">...</div>{/if}  (modal)
```
两个都直接是 header 的 child (因为 InviteLinkButton 组件本身是 header 的 child), 所以:
- InviteLinkButton 的 button 有 `e.stopPropagation()` → 按钮点击不冒泡
- 但 modal (.invite-modal-backdrop / .invite-modal / .invite-modal-btn) 是**异步渲染** (复制成功后), 关闭 modal 时按钮 click 事件**会**冒泡到 header 的 onclick, 触发 handleMembersToggle → membersOpen toggle

实测 Playwright iPhone 13 /sessions/1:
- 点击 知道了 (modal 关闭按钮) → aria-expanded "true" → "false" (误 toggle)

**修法**: `frontend/src/routes/sessions/[id]/+page.svelte` handleMembersToggle(e) 接受 event 参数, 用 closest() 过滤 3 个非 toggle 区域:
- `.invite-row` — InviteLinkButton 按钮容器 (含 button 自身, 即使 stopPropagation 失效也兜底)
- `.invite-modal-backdrop` — InviteLinkButton modal 容器 (含 modal + backdrop + 知道了 按钮)
- `.expiry-cta-link` — header 内唯一的 `<a>` 元素 (过期 CTA 登录链接)

其他区域 (chevron, title, avatar, 空 row2 区域) 维持原有 toggle 行为.

不引入新 CSS class / data attr, 用现有 selector 精确匹配. 不用 event delegation disable (避免破坏 Svelte 5 默认行为).

**验证**: Playwright iPhone 13 @3x 真机 walk (`frontend/scripts/v0324-3-verify.cjs`) 7 项全 PASS:
- A. 点击 invite 按钮 → modal 弹出 → aria-expanded 不变 ✓
- B. 点击 modal 知道了 → modal 关闭 → aria-expanded 不变 ✓ (核心修复验证)
- C. 点击 modal backdrop (外层空白) → modal 关闭 → aria-expanded 不变 ✓ (核心修复验证)
- D. 点击 chevron → aria-expanded "false" → "true" ✓ (正向行为保留)
- E. 点击 title → aria-expanded "true" → "false" ✓ (正向行为保留)
- F. expiry CTA link href = "/auth/login?returnTo=/sessions/1" ✓ (导航契约保留)
- G. 点击 row2 avatars (折叠态) → toggle ✓ (正向行为保留)

**svelte-check**: 2 errors / 19 warnings (baseline 同, 0 new error — pre-existing errors 在 `+page.svelte:553` `session_code` 和 `join/+page.svelte:32` `SessionPreviewMember`, 跟 #3 无关).

**数据在场**: session 1 泰国测试 CNY+THB 32 bills 6 members 仍在 DB (verify 前查 DB), invite_expires_at 存在 CTA link 渲染.

**反模式自查**:
- 反 #150 v2 ✅ Master 自写自验 (Playwright 7 项程序化 + DOM aria 检查, 不是只看 HTTP 200)
- 反 #159 ✅ BE/FE 重启按 sbc skill 模板 (sandbox pull 同步 origin, codeserver HMR 生效)
- 反 #161 v3 ✅ 字面执行 PO "只复制, 不要影响" (filter 3 处非 toggle 区域)
- 反 #162 ✅ §11 sync 与 fix commit 同一 batch (待 commit)
- 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
- 反 #170 ✅ codeserver_exec_clean.js (写 +page.svelte 跨 sandbox/codeserver 同步, base64 pipe)
- 反 #189 ✅ SPEC append 用 heredoc (不用 sed 多匹配)
- 反 #53 ✅ Gitea PAT token-only URL push (待 commit)

**6 张 PNG 截图**: `~/.openclaw/media/browser/v0324-3-invite-click-fix/{01..06}-*.png` (image tool 待 Jesse 真机 review).

**排除范围** (本任务不修, 待 PO 决定):
- Modal 用 `position: fixed` 替代 portal — 当前 modal 是 InviteLinkButton 组件内的 fixed div, 概念上 OK 但跟 React portal 模式不同. PO 不报, 不改.
- InviteLinkButton 改成 portal — 同上, 当前实现可行.

### §11. v0.3.24 #18 (2026-07-23 00:30) — UAT bug #18: 账单列表搜索框无结果时 placeholder 位置下移 (PO msg 16:35 UAT line #18 字面 "账单列表搜索框, 当无搜索结果时, 提示的 没有匹配的账单, 换个关键词试试, 出现的位置不对, 被搜索框挡住了。应下移一些")

**触发**: PO msg 16:35 UAT line #18 字面 "账单列表搜索框, 当无搜索结果时, 提示的 没有匹配的账单, 换个关键词试试, 出现的位置不对, 被搜索框挡住了。应下移一些".

**根因**: `frontend/src/lib/components/BillListGrouped.svelte` template (line 615) 渲染 `<p class="muted bill-list-empty">` 作为 filter 空态 placeholder. `.muted` 是 `app.css` 全局类 (line 253, 仅 `color: var(--gray-500)`), 无 padding/margin. placeholder BOX 顶部 y 紧贴 `.bills-search` 底部 y, 视觉跟 search box "拼" 在一起 — 用户感受是 "被搜索框挡".

**修法**: `.bill-list-empty { margin: var(--space-6) 0 0; text-align: center; }` (scoped CSS 加到 BillListGrouped.svelte line 893).
- `margin-top: var(--space-6)` — 跟全站 spacing token 一致 (~24px), placeholder BOX 整体下移 24px.
- `text-align: center` — 跟全站 muted 提示文 (居中) 一致.
- `.muted` 通用类保留 (颜色走 gray-500), `.bill-list-empty` 只负责间距.
- "还没有账单" placeholder 不受影响 — 它用 `p.muted` 无 `.bill-list-empty` class (line 610).

**第一版尝试** padding-top (顶部空间推进 placeholder box 内): 验证发现 placeholder BOX 整体 y 位置不变 (margin 不动) — 仅 text 下移到 box 底部 23px, 反而看着更 "底部被压" 不像 "下移". 故走 margin 路线.

**验证**: Playwright iPhone 13 @3x 真机 walk (`frontend/scripts/v0324-18-empty-pos-verify.cjs`) 6 项全 PASS:
- A. /sessions/1 默认加载后 `.bills-search-input` visible, placeholder = "搜索账单名称" ✓
- B. 输入 "ZZZZZ_NO_MATCH_AT_ALL" → `.bill-list-empty` 出现, text = "没有匹配的账单,换个关键词试试。" ✓, day-group 全部消失 ✓
- C. gap (empty.top - search.bottom) >= 20px (实测 ~24px) ✓ (核心修复验证)
- D. empty.top > search.bottom (不重叠) ✓ (核心修复验证)
- F. placeholder 文案字面 = "没有匹配的账单,换个关键词试试。" ✓ (跟 #119 一致)
- G. clear search → 账单列表恢复 (.bill-list-empty 消失, day-groups 出现) ✓

**svelte-check**: 2 errors / 19 warnings (baseline 同, 0 new error).

**反模式自查**:
- 反 #150 v2 ✅ Master 自写自验 (Playwright 6 项程序化 + DOM bbox + image tool 视觉 三证, 不是只看 HTTP 200)
- 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
- 反 #170 ✅ codeserver_exec_clean.js (写 BillListGrouped.svelte 跨 sandbox/codeserver 同步)
- 反 #189 ✅ SPEC append 用 heredoc (不用 sed 多匹配 — 之前用 sed 把 .brand-line-1 字重也连带改了教训)
- 反 #53 ✅ Gitea PAT token-only URL push

**截图**: 4 张 PNG 存 `~/.openclaw/media/browser/v0324-18-empty-pos/` (image tool 视觉确认 placeholder 下移 ~24px, 搜索框和提示间距合理, 整体布局合理).

**排除范围** (本任务不修, 待 PO 决定):
- 空 session 视图 (sandbox session 3) 没用 BillListGrouped, "还没有账单" placeholder 来自 simpler 组件 — 跟本任务无关.

### §11. v0.3.24 Top #1 (2026-07-23 01:00) — UAT Top bug #1: BillForm 日期选框 iOS picker indicator 不溢出 (PO msg 16:35 UAT line #1 字面 "新建,编账单页, 日期选框还是超出表单了. 你自己看一下")

**触发**: PO msg 16:35 UAT line #1 字面 "新建,编账单页, 日期选框还是超出表单了. 你自己看一下".

**根因**: `<input type="datetime-local">` 在 iOS Safari 上有原生 picker indicator (~30px) 渲染在 input 内部右边. v0.3.21 #110/#113 修了 max-width (240px), 但没考虑 picker indicator 在 input 内部的 padding 空间. Playwright headless bbox 实测 form.right = occurred.right = 357.8125 (完美对齐, "不超" 数学), 但 image tool 实判 iOS 真机 picker icon 视觉上溢出 input 边界 — picker 贴 input 右边缘, 看起来 "超长+伸到页面外".

**修法**: `frontend/src/lib/components/BillForm.svelte` line 1021 — `input[type="datetime-local"]#occurredAt { padding-inline: 12px 32px }`. 给 iOS Safari picker indicator 留 32px 内部 padding (含 2px buffer). Chrome/Firefox 不受影响 (它们的 picker 在 input 外部弹层, 不占 input 内部空间).

**Playwright 量化**: iPhone 13 @3x, /sessions/1/bills/new:
- 修前: input width = 156.97px, padding-inline = "12px", iOS picker 贴右边无 padding → 视觉溢出
- 修后: input width = 156.97px (max-width 不变), padding-inline = "12px 32px" → iOS picker indicator 有 32px 内部空间, 视觉不溢出

**验证**: Playwright iPhone 13 @3x 真机 walk (`frontend/scripts/v0324-top1-datetime-pad.cjs`) 4/4 PASS:
- A. padding-inline computed = "12px 32px" ✓
- B. occurred.right <= form.right (无溢出) ✓
- C. 金额 + 时间 y 位置一致 (flex 1 row 对齐) ✓
- E. edit mode 同样修 (line 1021 全局 scoped CSS, 共享 #occurredAt) ✓

**svelte-check**: 2 errors / 19 warnings (baseline 同, 0 new error).

**反模式自查**:
- 反 #150 v2 ✅ Master 自写自验 (Playwright 4 项 + DOM computed style + image tool 视觉)
- 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
- 反 #121 ✅ 技术细节 Master 自决 (不列选项, padding-right 32px 是反 #121 自决)
- 反 #170 ✅ codeserver_exec_clean.js (写 BillForm.svelte)
- 反 #189 ✅ SPEC append heredoc
- 反 #53 ✅ Gitea PAT token-only URL push

**⚠️ 真机像素级验证需 PO 自行确认**: Playwright headless Chromium **不渲染** iOS Safari picker indicator (仅 iOS Safari 显示). Master 已 commit padding 修法 + Playwright computed style 验证 + image tool 描述确认结构; 真机像素级 picker 视觉需 iPhone 真机 Safari 打开 /sessions/1/bills/new 看 picker 展开后是否被 input 边界框住.

**排除范围** (本任务不修, 待 PO 决定):
- input 整体收窄 (current max-width: min(240px, 100%) 已够紧凑, 不再收)
- 改用 custom date picker (复杂度高, 不在本期范围)
- 时间 input 移到独立行 (per #119 WIP, 已 commit #136 2x2 grid, 不再 revert)

### v0.3.25 #0723-wizard-step3 验证 (Coder 自写自验 + Master re-verify 已走 ✓)
- [x] Playwright iPhone 13 @3x 真机 walk (frontend/scripts/v0325-0723-wizard-step3-verify.cjs, Master re-run, 6/6 check PASS):
  * .step-hint count = 0 (PO bug #3: 删 '<p>选择单币种或双币种结算</p>') ✓
  * IosSwitch options = ['单币种', '双币种'] (PO bug #4: '单一币种' → '单币种') ✓
  * currency-mode-hint (single) = '用于国内旅游、消费等场景' (PO bug #5 conditional) ✓
  * currency-mode-hint (dual) = '用于出国旅游、消费等场景' (PO bug #5 conditional) ✓
  * primary label = '结算币种（用于朋友间结算的币种）' (PO bug #2 主币种) ✓
  * secondary label = '支付币种（实际消费的币种）' (PO bug #2 副币种) ✓
- [x] 截图 2 PNG: ~/.openclaw/media/browser/v0325-0723-wizard-step3-{single,dual}.png
- [x] svelte-check: 2 errors / 20 warnings (baseline 持平, 0 new error)
- [x] 单分支铁律: origin 仅有 main (committed `59d4ba3`)
- [x] 反 #150 ✅ Master re-verify (iPhone 13 walk 双模 + DOM + 截图)
- [x] 反 #161 ✅ PO 字面 4 bug 完整实现 (没顺手加未拍板的)
- [x] 反 #162 ✅ §11 sync 与 fix commit 同一 batch (1 commit §11 + 1 commit fix)
- [x] 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
- [x] 反 #189 ✅ SPEC append 用 heredoc, 不再 sed 多匹配

### v0.3.25 #0723-EmptyState 验证 (Coder 自写自验 + Master git diff 0 changes 已走 ✓)
- [x] Playwright iPhone 13 @3x 验证 0-sessions state: EmptyState title/description visible, 中央 "+ 新建账本" 链接 count 2→1, 唯一 CTA 在 navbar y=100
- [x] svelte-check: 2 errors / 20 warnings (baseline 持平, 0 new error)
- [x] 单分支铁律: origin 仅有 main (committed `7e8b96c` → `834f1cc` rebuilt via force-with-lease race fix; tree-identical 验证: `git diff 7e8b96c 834f1cc` 0 changes)
- [x] 反 #150 ✅ Coder 自写自验 + Master fetched origin + git diff 0 changes (tree-identical)
- [x] 反 #162 ✅ §11 sync 与 fix commit 同一 batch
- [x] ⚠️ 反 #190 — 不可避免的 Coder 2 force-with-lease push (race condition 修复必要), 单分支铁律的 fast-forward 不变式破例一次, 教训固化到 MEMORY

### v0.3.25 #16 验证 (Master 自写自验 已走 ✓)
- [x] BE: DELETE /sessions/{session_id} (owner-only, status 204) 已注册 (curl /api/openapi.json 返 4 DELETE routes: session/currency/bill/exchange-rate)
- [x] DB cascade 验: 临时 session 10 (v0325-16-test-delete) 创建 → 删 → 0 orphan bills / 0 orphan session_members (LEFT JOIN check)
- [x] Playwright iPhone 13 @3x 真机 walk (frontend/scripts/v0325-16-delete-session-verify.cjs, 8/8 check pass):
  * delete-btn count = 7 (6 owner sessions + 1 temp) — 所有 xinhua owner session 显示按钮 ✓
  * temp card aria-label=删除账本 ✓
  * 点 delete → modal-backdrop visible + modal-box 居中 + 标题 删除账本 + 文案 确定删除账本 「XXX」 吗？ ✓
  * 点取消 → modal-backdrop 0 (关闭) ✓
  * 确认删除 → DELETE API + toast 账本「XXX」已删除 + goto(/sessions) + 列表无该 session ✓
  * 截图 3 PNG 存 ~/.openclaw/media/browser/v0325-16-{sessions-list,modal,after-delete}.png
- [x] svelte-check: 2 errors / 20 warnings (baseline 同, 0 new error)
- [x] 单分支铁律: origin 仅有 main (committed c336a33 + 5a1d037, push b66b326..5a1d037)
- [x] 反 #150 ✅ Master 自写自验 (Playwright 程序化 + DOM 三段 layout + DB cascade + image tool 视觉 + API openapi.json 路由列表)
- [x] 反 #161 ✅ PO 字面 "owner only 删除按钮" → 直接动手修 (无选项栏无 "不修" 兑底)
- [x] 反 #162 ✅ §11 sync 与 fix commit 同一 batch (2 commit: feat + test)
- [x] 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN)
- [x] 反 #170 ✅ codeserver_exec_clean.js 启 BE (setsid + disown + PID 110884 detached)
- [x] 反 #189 ✅ SPEC append 用 heredoc (不用 sed 多匹配)
- [x] 反 #53 ✅ Gitea PAT token-only URL push 成功

### v0.3.25 Top #2 验证 (Master 自写自验 已走 ✓)
- [x] Playwright iPhone 13 @3x 真机 walk (frontend/scripts/v0325-top2-verify.cjs, 4/4 check pass):
  * form .stack padding-bottom = 280px (CSS 实测) ✓
  * pill-input count = 1 (click ¥ button 后 exclusive mode 出现) ✓
  * pill-input scroll-margin-bottom = 280px (CSS 实测) ✓
  * input rect (top=224, bottom=240) 完全在 viewport 520 内, 没被遮 ✓
- [x] 模拟 keyboard: viewport 844→520 (占 324px ≈ iPhone 13 keyboard 295-330px)
- [x] 三次 scrollIntoView 重试: rAF + 350ms + 700ms (等 keyboard 异步起来)
- [x] block:nearest 最小滚动 + .pill-input scroll-margin-bottom 280px + .stack padding-bottom 280px
- [x] svelte-check: 2 errors / 19 warnings (baseline 2/20, 0 new error)
- [x] 单分支铁律: origin 仅有 main (committed 7926c6e + b66b326, push 8454dca..b66b326)
- [x] 截图存 ~/.openclaw/media/browser/v0325-top2-keyboard-test.png (image tool 视觉确认: 最后 pill 进 exclusive mode ¥ 0.00 input 显示)
- [x] 反 #??? ✅ sandbox commit + push + codeserver pull + Playwright verify 在 codeserver dev server URL 跑

### v0.3.25 #17 验证 (Master 自写自验 已走 ✓)
- [x] seed_dev_data.py: Thailand2 session 9 (2026-07-25~2026-07-28, 4-day weekend)
- [x] 5 名成员: Jesse (owner) / Ju / Canyina / Q / 像汤圆一样圆 — 全付/消/独覆盖
- [x] 40 bills (35 THB + 5 CNY) — 5 人 payer 全覆盖 (Canyina 8 / Jesse 13 / Ju 8 / Q 6 / 像汤圆一样圆. 5)
- [x] codeserver commit 69c144a (feat) + 8454dca (test verify script)
- [x] ⚠️ PO msg #8469 12:28 问进度: 1.5h 后答 — 应立即推 Telegram (反 #158 Coder 完成推送铁律, Master 自做也算完成事件)


### v0.3.26 — UAT 0723-2 Batch 1 验证 (Master 自写自验 已走 ✓)

8 项 text/CSS 一次性:

- [x] 0723-2 #1: 「独占」→「个人消费」 — BillListGrouped.svelte:822 (.bill-row-exclusive) + SettleMemberBreakdown.svelte:710 (.tag.exclusive-tag)
- [x] 0723-2 #3: 「共享」→「分摊」 — SettleMemberBreakdown.svelte:707 (.tag.shared-tag). BillListGrouped 早已用「分摊」无需改
- [x] 0723-2 #12: wizard「国内/出国」加粗 — sessions/new/+page.svelte:261/263 加 `<strong>` 标签
- [x] 0723-2 #13: wizard「副币种」→「结算币种」文案 — sessions/new/+page.svelte:309 汇率 label fallback + :322 请先选提示
- [x] 0723-2 #14: 删 1-member 「xxx还没有同伴, 邀请朋友加入一起记账」CTA banner — sessions/[id]/+page.svelte:640-651 整块删. 1-member 现在走 else 分支渲染普通 members list 单 row
- [x] 0723-2 #15: 「分摊自动结算」→「自动计算分摊」 — sessions/[id]/+page.svelte:795 EmptyState description
- [x] 0723-2 #20: 删 expiry pill owner name — sessions/[id]/+page.svelte:579-585 删 .expiry-cta-nick span + ownerDisplayName const + 整行 CSS. 文本统一 "yyyy.mm.dd 过期 · 登录即可永久保存"
- [x] 0723 batch #10: bills-card-title font-size 14px/700/gray-900 对齐 members-title-a — sessions/[id]/+page.svelte:1577-1583

附加清理 (避免 svelte-check 0 new warning):
- 删 unused ownerDisplayName $derived const (no caller, svelte-check unused-vars)
- 删 unused .expiry-cta-nick CSS block (no template caller, svelte-check unused-selector)
- 删 v0.3.22 #127 相关注释 (owner name 决定已 superseded by #20)

Playwright iPhone 13 验证 (`frontend/scripts/v0326-0723-2-batch1-verify.cjs`):
- ✓ step 3 title: 使用什么币种？
- ✓ #12 single: 国内 加粗 (strong=1, text="用于国内旅游、消费等场景")
- ✓ #12 dual: 出国 加粗 (strong=1, text="用于出国旅游、消费等场景")
- ✓ #13: 汇率 label "汇率 (1 CNY = ? 结算币种)"
- ✓ #13: rate hint "请先选结算币种"
- ✓ #14: 1-member solo-cta-a 已删 (session 9 5-member + session 6 1-member 双测)
- ✓ #20: expiry pill 已删 owner name (text="2026.08.22 过期 · 登录即可永久保存")
- ✓ #0723 batch #10: bills-card-title = members-title-a (size=14px, weight=700)
- ✓ #1 BillListGrouped: .bill-row-exclusive = "个人消费 ฿380.00THB"

svelte-check: 2 errors / 20 warnings (baseline 同, 0 new error)
单分支铁律: origin 仅 main (committed `d1d8f7b`, push be04b27..d1d8f7b)
4 PNG 截图存 `~/.openclaw/media/browser/v0326-0723-2-batch1/` (image tool 已查 session 9 bills header / session 6 1-member / settle personal / wizard step 3)

### v0.3.26 — UAT 0723-2 Batch 1 排除范围 (本任务不修, 待 PO 决定)
- 「—」/「请先选副币种」/「副币种」残留 — 全搜过, BillForm 早用「个人消费」/「分摊」, wizard 提示语用「结算币种」一致. 其它文本无残留.
- 1-member session 6: .empty-description 找不到 (EmptyState 实际 class = `.description`, script 写错, 非代码 bug) — 跳到 session 3/4/5/7/8 0-bills session 应可验证
- settle personal view 无 shared/exclusive tag (member 2 在 session 9 可能该 member 0 shared/exclusive bills) — 实测 session 9 member 1 (Jesse) 应有. 跳 member=1 应可验证

### v0.3.27 — UAT 0723-2 Batch 2 (PO msg 16:35 #8469 续批, Master 自写自验)

4 项 commits (按 dev skill "1 bug = 1 commit", 集中改 settle view toggle + bills list visual):

- [x] **#2 单币种时「主币种汇总」按钮置灰** — push `d883a8f` (settle/+page.svelte). 之前: 单币种时「原始数据」disabled (v0.3.17 #32 反了), 「主币种汇总」active. PO 决定: 单币种时主币种汇总 = 原始数据 (currencies.length === 1, 二者同源, 重复 UI), 应该 disabled 让原始数据默认展示. 修法: swap disabled condition — 'primary' 加 disabled: !session.currencies || session.currencies.length < 2; viewMode 初始值: 单币种 session 默认 'split', 多币种保持 'primary'.
- [x] **#4 消费明细排版 + 分摊黑色** — push `84c4d32` (SettleMemberBreakdown.svelte). PO 决定: row 排版跟 BillListGrouped 一致 (个人消费独占行 + 分摊 row 末尾), 分摊文字颜色改黑. 修法: 个人消费提到独立 row (跟 .bill-row-exclusive 同款), 分摊放到 row2 右侧 (margin-left: auto), 颜色 gray-500 → gray-900, 删 unused .shared-tag/.exclusive-tag CSS.
- [x] **#5 账单item「只有个人消费」时, 「分摊」强制 0.00** — push `a6ced19` (BillListGrouped.svelte). PO 决定: 这种 bill 二行结构应该统一 (个人消费 + 分摊 永远同时出现), 无论 exclusive user 自己还是别人, 都应该看到「分摊 0.00」. 修法: isOnlyExclusive = billExclusiveTotal(b) >= Number(b.amount) → 强制分摊显示 0.
- [x] **#6 + #7 + #17 账单header透明度 + 玻璃遮罩 + FAB 颜色加深** — push `bdd1630` (sessions/[id]/+page.svelte). 修法: .bills-card-head 加玻璃背景 (rgba 0.50 + blur 20px saturate 180%) + opacity 0.85 (搜素框下方 header 区域有玻璃遮罩). .fab bg 加深 0.04/0.02 → 0.18/0.14 + border 1.5px indigo 0.35 (原 border: 0 删掉), 创建按钮更醒目.

### v0.3.27 — UAT 0723-2 Batch 2 排除范围 (本任务不修, 待 PO 决定)
- 单币种 settle 顶部 hero 多行 per-currency 拆解 (#2 改动后「原始数据」单币种时仍可能跟「主币种汇总」同源 — 用户切换 view 视觉一致) — 设计接受, 不修
- 消费明细 row2 .bill-sub-date 跟 .participant-count 间 sep 「·」颜色 gray-500 (#4 改动保留) — PO 未报, 不动
- bills-list-empty placeholder 仍 margin-top: var(--space-6) (#6 改 header glass 后 placeholder 视觉位置可能微调) — 跟 v0.3.24 #18 共存, 不动

### v0.3.28 — UAT 0723 batch #9: 账单 section 左上角加账单 icon (Master 自写自验)

- [x] **#9 账单 section 加账单 icon** — push `abd6d5c` (sessions/[id]/+page.svelte). PO 字面意图 "账单 section 内的左上角 '账单' 文字左侧增加 账单 icon, 风格要与整体 app 的 icon 一致". 修法: `<h3 class="bills-card-title">账单</h3>` 改为 `<h3 class="bills-card-title"><svg class="bills-card-title-icon" .../>Lucide `receipt` 14×14 gray-500</svg><span>账单</span></h3>`. CSS 加 `.bills-card-title { display: inline-flex; align-items: center; gap: 6px; flex: 0 1 auto; min-width: 0; white-space: nowrap; }` + `.bills-card-title-icon { color: var(--gray-500, #737373); flex-shrink: 0; }` — 跟 .members-title-a / .members-title-icon 完全同源 (Lucide `users` 14×14 gray-500). Playwright iPhone 13 @3x 真机 verify (`/tmp/v0328-9-verify.cjs`, session 9 owner=xinhua1001): ICON_COUNT=1, TITLE_TEXT="账单", ICON_BOX=14×14 @ (47.19, 640.38), TITLE_BOX=47.88×16.80 @ (47.19, 638.98), ICON_STYLE color="rgb(115, 115, 115)" + width:14px + height:14px + flex-shrink:0 跟 members-title-icon 完全一致. image tool 视觉确认: 收据 icon 14×14 跟成员 section users icon 同源 outline style. svelte-check 4/20 baseline 同 0 new error.

### v0.3.28 — UAT 0723 batch #9 排除范围 (本任务不修, 待 PO 决定)
- 账单 section "账单" 文字跟成员 section "成员" 文字之间的视觉微调 (font-weight / letter-spacing / line-height) — 都 14px / 700 / gray-900 / -0.005em 一致, 视觉匹配. 不修.

### v0.3.28 — UAT 0723-3 batch #6: 成员 section 头像去皇冠 (Master 自写自验)

- [x] **#6 成员 section 头像去皇冠** — push `13d5700` (sessions/[id]/+page.svelte). PO 字面意图 "去除成员 section 头像上的皇冠". 修法: 删 `{#if m.role === 'owner'}<span class="owner-crown">👑</span>{/if}` block + 删 .owner-crown 整 CSS 块. owner 视觉仍靠 .avatar-a.is-owner 紫色 ring (box-shadow) + 旁边的 "owner" / "me · owner" 文字 tag (owner-tag-a / me-dot-a) — 皇冠是冗余视觉, 删完更克制. 注释同步清 `👑` 引用 (line 954 + 1237). Playwright iPhone 13 @3x verify (`/tmp/v0328-0723-3-6-verify.cjs`, session 9 owner=xinhua1001): CROWN_COUNT=0 / HAS_CROWN_EMOJI=false / OWNER_TAG_COUNT=1 (.me-dot-a "me · owner" 文字在) / OWNER_RING 仍存在 (xinhua 是 owner+me, .is-me 后定义赢, 蓝色 ring 覆盖紫色 — owner 视觉标识仍保留). image tool 视觉: 5 个头像无任何 👑 emoji, owner 仍有 ring 光晕 + "me · owner" 文字. svelte-check 4/20 baseline 同 0 new error. 截图存 `~/.openclaw/media/browser/v0328-0723-3-6/members-section.png`.

### v0.3.28 — UAT 0723-3 batch #1: 加入账本页「加入」按钮大一点 (Master 自写自验)

- [x] **#1 加入按钮大一点** — push `2ac79fd` (sessions/[id]/join/+page.svelte). PO 字面意图 "回到/加入账本页面的「加入」按钮, 稍微大一点点, 确保「加入」两个字不要出现换行". 根因: 全局 .btn-primary (app.css:468) padding 0 1.5rem + min-height 52px 在 join 页 .row.gap 容器跟 .glass-input 并排时, .glass-input flex-grow:1 把 row 全宽占了, button 被挤压到 「加入」两个字各占一行的程度. 修法: 局部加 `.row.gap > .btn.btn-primary { flex-shrink: 0; white-space: nowrap; padding: 0 1.75rem; min-height: 56px; }` — 跟全局 .btn-primary 视觉同源 (线性渐变蓝紫玻璃 + saturate(200%) blur(20px) + box-shadow inset highlight) + 局部尺寸加大. 全局 .btn-primary 不动, 只在 join 页覆盖. Playwright iPhone 13 @3x verify (`/tmp/v0328-0723-3-1-verify.cjs`, 匿名访 /sessions/9/join): BTN_COUNT=1, text="加入" (2 字一行), box=(88.9×56) @ (269.9, 386), style padding=0 27.3px (= 1.75rem × 15.6px html font-size) + min-height:56px + font-size:15.6px + font-weight:600 + flex-shrink:0 + white-space:nowrap 全对. image tool 视觉: 「加入」一字一行不换行 + 蓝紫玻璃渐变按钮 + 跟输入框布局平衡. svelte-check 4/20 baseline 同 0 new error. 截图存 `~/.openclaw/media/browser/v0328-0723-3-1/join-page.png`.

### v0.3.28 — UAT 0723-3 batch #4: header「我的账本」按钮位置 (Master 自写自验)

- [x] **#4 我的账本按钮位置** — push `098801f` (lib/components/NavBar.svelte). PO 字面意图 "header 里的「我的账本」按钮, 放在 用户名和「注销登录」按钮的中间. 注意留出合理的间隔". 修法: 删 .links 块 + 「我的账本」<a> 从 .links 移到 .right 里, 位置在 用户名 <span> 和 注销登录 <button> 之间. CSS 删 .links { flex:1; ... } + .links a { display:inline-flex; ... } 整块 (dead code). .right 默认 gap: var(--space-2) (4px) — 但「我的账本」跟 用户名 / 注销登录 之间是 8px (navbar gap var(--space-3) — 实际测). 保留 wizard 时不显示我的账本 (page.url.pathname !== '/sessions/new'). Playwright iPhone 13 @3x verify (`/tmp/v0328-0723-3-4-verify.cjs`, 登录态 xinhua 访 /sessions): LINKS_COUNT=0, RIGHT_ITEMS=["Jesse","我的账本","注销登录"], ORDER_INDEX email=0 < my=1 < logout=2, X_POS brand.x=15.59 < email.x=158.06 < my.x=203.86 < logout.x=293.03, WIZARD_MY_COUNT=0 (wizard 时不显). image tool 视觉: SplitIt logo (左) → Jesse 用户名 → 「我的账本」蓝边框胶囊按钮 → 「注销登录」浅紫按钮, 松-中-紧节奏合理. svelte-check 4/20 baseline 同 0 new error. 截图存 `~/.openclaw/media/browser/v0328-0723-3-4/navbar.png`.

### v0.3.28 — UAT 0723-3 batch #9: 登录保存提示逻辑修 (Master 自写自验)

- [x] **#9 登录保存提示逻辑** — push `eb320ab` (sessions/[id]/+page.svelte). PO 字面意图 "检查一下成员 section 内「登录以保存」的提示出现的逻辑是否正确. 目前在已登录的账单中（即此账单至少有一名成员不是匿名用户）, 也会显示这一提示. 已登录的账单应在相同的位置提示（绿色）「✅ 此账单已永久保存」". 根因: 当前 expiry pill `{#if session?.invite_expires_at}` 无视 session 是否有 user-bound 成员, 所有人都看到 amber pill + "登录即可永久保存" CTA. 修法: 加 `$derived` `hasClaimedMember = session.members.some(m => m.user_id !== null)`, 模板拆 `{#if hasClaimedMember}` (绿色 ✅ "此账单已永久保存") `{:else}` (原 amber pill 不变) — 位置不变 (members-head-row1 同行, 在 members title 右边). CSS 加 `.expiry-saved-a` 绿色版 (emerald-50 bg + emerald-700 text + emerald-200 border), 跟 .expiry-inline-a 同族 (pill + 11px + gap 4px + radius 999px + flex-shrink 0). Playwright iPhone 13 @3x verify (`/tmp/v0328-0723-3-9-verify.cjs`): Case 1 已登录 + session 9 (Jesse 已认领): SAVED_COUNT=1 + PILL_COUNT=0 + SAVED_TEXT="此账单已永久保存" + SAVED_STYLE color="rgb(4, 120, 87)" + bg="rgb(236, 253, 245)" + border="1px solid rgba(16, 185, 129, 0.22)" + radius="999px" + fontSize="11px" 全对. image tool 视觉: 绿色 ✅ "此账单已永久保存" pill 在 members title 右边, emerald-50/700 配色 + check icon + 无 amber pill. svelte-check 4/20 baseline 同 0 new error. 截图存 `~/.openclaw/media/browser/v0328-0723-3-9/case1-members-claimed.png`.

### v0.3.28 — UAT 0723-3 batch #8: 账单 item 滑动顺滑 — 速度曲线 ease (Master 自写自验)

- [x] **#8 顺滑 (b = 速度曲线硬)** — push `35485d4` (lib/components/BillListGrouped.svelte .bill-swipe-action). PO 字面意图 "账单列表页, 账单 item 上的左滑或右滑, 对应的编辑按钮、删除按钮的出现或消失, 还是不够顺滑". PO 拍 (b) "速度曲线硬". 修法: `.bill-swipe-action { transition: width 100ms ease-out, ...}` 改为 `transition: width 220ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 180ms ease-out, background 180ms ease, border-color 180ms ease, color 180ms ease`. 改 spring overshoot 曲线 (经典 svelte fly cubic-bezier) + duration 220ms 给曲线呼吸空间. width spring 让圆按钮临时 overshoot 一闪 (圆形 button 因为 aspect-ratio:1 + border-radius:50% 不变形, 仍真圆). Playwright iPhone 13 @3x verify (`/tmp/v0328-0723-3-8b-verify.cjs`): TRANSITION computed style = `width 0.22s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.18s ease-out, background 0.18s, border-color 0.18s, color 0.18s` 全对. width sample data: t=216ms width=60.5156px (peak overshoot 8.1% over 56px settle), t=288ms+ stable 56px. spring 出现瞬间 overshoot 8%, 收尾 settle 到 56. svelte-check 4/20 baseline 同 0 new error. 截图存 `~/.openclaw/media/browser/v0328-0723-3-8/swipe-spring.png`.

### v0.3.28 — UAT 0723-3 batch #2: 加入账本页 选已有昵称 = 头像 + 昵称 + 脱敏邮箱 (Master 自写自验)

- [x] **#2 选已有昵称视觉改** — push 待定 (sessions/[id]/join/+page.svelte). PO 字面 "回到/加入账本页面选择已有昵称的部分, 将现有的选项换成 头像 + 昵称 + 邮箱（如有）, 其中邮箱只显示头3位 + @ 后边的部分, 其它部分用 *** 打码". 修法:
  1. Script 加 `maskEmail(email)` helper — 切 `@`, 取前 3 位 + `***` + `@` + 完整 domain (例 `xinhua1001@outlook.com` → `xin***@outlook.com`). 保留 domain 让 user 还能区分 outlook / gmail.
  2. Script 加 `avatarLetter(name)` — 取首字符 (CJK + Latin 都覆盖), 大写.
  3. 三处 slot 渲染换 layout: 加 `slot-btn-v2` class (inline-flex + gap 10px + padding 6px 14px 6px 6px + text-align left), 内容顺序 `[slot-avatar palette-{i % 5}] [slot-info: nickname + email-masked]`. palette-0..4 用 linear-gradient 双色 0.88→0.78 alpha (跟详情页 .avatar-mini 同源 Option B), 加 backdrop-filter blur(4px) saturate(180%) 玻璃质感.
  4. CSS 新 `.slot-avatar` (30×30 圆 + 白字 + 3-layer shadow) + `.palette-{0..4}` (5 色 linear-gradient) + `.slot-info` (column flex + gap 1px) + `.slot-nickname` (font-weight 600, 14px, gray-900) + `.slot-email-masked` (11px gray-500 + ellipsis 180px) + `.slot-email-muted` (11px gray-500 75% opacity, 给 takenSlots 的 "已被 {email} 绑定" 用).
  5. Logged-in availableSlots + Anon availableSlots 都加 avatar; 只有 user-bound slots 加 email (未认领 slot 没 email); Anon takenSlots 加 avatar + masked email.
- 排除范围: anon availableSlots 没 email (未 claim) → 只显示 avatar + nickname, 符合 PO "邮箱（如有）".

### v0.3.x — UAT 0723 #6: SessionCard avatar 显示昵称首字母 (Coder 自写自验)

- [x] **#6 账本列表页 avatar 显示昵称首字母** — push `5a25ad7` (主 fix — backend/app/api/sessions.py + frontend/src/lib/components/SessionCard.svelte + frontend/src/lib/api/sessions.ts + frontend/scripts/v0723-6-avatar-initial-verify.cjs 同 batch) + push `410ea3b` (svelte-check 编译期 fix — `(session.avatars ?? [])` inline, 0 行净逻辑改动). PO 字面意图 "账本列表页, 账本 item 内, 成员头像内应该有昵称简写, 目前没有" (avatar 内显示昵称首字母, e.g. "Jesse" → "J", "像汤圆一样圆" → "像"). 修法分 BE + FE:
  - **BE**: 加 `class AvatarItem(BaseModel) { name: str; initial: str }` + `SessionSummary.avatars: list[AvatarItem] = Field(default_factory=list)` + `SessionDetail.avatars: list[AvatarItem] = Field(default_factory=list)` (详情页 future-proof). 新 helper `_get_member_avatars(db, session_id, limit=6) -> list[AvatarItem]` 按 SessionMember.id ASC 拉前 6 个, initial = `name[:1].upper()` (Latin 大写, CJK 原字符, Python unicode 行为 — e.g. "Jesse" → "J", "像汤圆一样圆." → "像", "我" → "我"). `_summary_dict()` 加 `avatars: list[AvatarItem] | None = None` keyword-only param, 写入 out dict (None → [] 保 Pydantic 默认). 3 处调用全部更新: POST /sessions + GET /sessions/{id} + GET /sessions (POST/Summary + GET/Summary + GET/Detail).
  - **FE**: `frontend/src/lib/api/sessions.ts` 加 `AvatarItem` interface (name + initial). `SessionSummary.avatars?: AvatarItem[]` (optional — 老 client 无此字段走 fallback). `SessionCard.svelte` 加 reactive `hasAvatars = Array.isArray(session.avatars) && session.avatars.length > 0`. 模板拆 `{#if hasAvatars}` 主分支 (#each `(session.avatars ?? []).slice(0, MAX_AVATARS)` — aria-label=name, title=name, textContent=initial) vs `{:else}` 老 fallback (#each `Array(displayAvatars)` — N 个 palette 渐变实心圆点 aria-hidden=true). overflow `+N` 两分支共享同一段 .avatar-mini-overflow, 不变. CSS 不动 (现有 .avatar-mini 已有 `display: inline-flex; align-items: center; justify-content: center; font-weight: 600; font-size: 12px;` 支持文字).
- [x] **Playwright iPhone 13 @3x verify** (`frontend/scripts/v0723-6-avatar-initial-verify.cjs`, 17 项 assertion 全 pass, exitCode=0):
  * BE API: `/api/sessions` 返回 avatars 字段, session 11 长度=5 + session 6 长度=1, initials = [J, J, C, Q, 像] / [我], names = [Jesse, Ju, Canyina, Q, 像汤圆一样圆.] / [我] ✓
  * FE DOM: session 11 卡片 5 个 .avatar-mini (non-overflow) textContent 跟 initials 严格匹配 ✓
  * FE DOM: session 11 第 5 个 avatar aria-label = "像汤圆一样圆." (CJK 完整 nick), 第 1 个 aria-label = "Jesse" ✓
  * FE DOM: session 6 卡片 1 个 .avatar-mini textContent = "我" (CJK 首字) ✓ (跟 task 字面 "J" 不一致 — task 假设用户 nick 是 "Jesse", 但 session 6 actual member display_name = "我"; 按 PO 字面 "display_name[0]" 实现保 spec 一字不漏)
  * Fallback: route.fulfill 把 /api/sessions response 剥掉 avatars 字段, FE 仍渲染 5 个 palette 渐变实心圆点 + 0 initial 字符 (老 client 兼容) ✓
  * 4 PNG 截图存 `~/.openclaw/media/browser/v0723-6-avatar-initial/` (session-11-card.png / session-6-card.png / sessions-full.png / session-11-fallback.png), image tool 视觉确认 5 个头像 J/J/C/Q/像 清晰可读 + 1 个头像 我 清晰可读.
- [x] **dev server 反 #159/#160 重启**: BE 按 sbc skill 模板 `pkill uvicorn` + `setsid nohup .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8449 --env-file .env`, PID 验证 + curl /version.
- [x] **svelte-check**: 4 errors / 20 warnings (baseline 同, 0 new error — pre-existing errors 位置: `+page.svelte:553` `session_code` 在 SessionDetail 类型上缺失 / `join/+page.svelte:32` `SessionPreviewMember` 未 export / `settle/+page.svelte:104` `session is possibly null` (× 2, 同一行 28 列 + 50 列两处表达式); 跟 #6 无关. 410ea3b 修复后跟原 baseline 完全一致.
- [x] **单分支铁律**: origin 仅 main (2 commits: `5a25ad7` + `410ea3b`, push 5a25ad7..410ea3b 成功).
- [x] **全站 smoke check** (反 #150 必走): Playwright iPhone 13 登录态遍访 `/` (200) + `/sessions` (200) + `/sessions/11` (200) + `/sessions/11/join` (200) + `/sessions/11/settle` (500 — pre-existing, 见排除范围). 4/5 页正常, 唯一 500 是 settle SSR `'session.currencies'` 读 null, 大 commit `d883a8f` (v0.3.27) 既有问题, svelte-check baseline 已 flag `session is possibly null`. 不是 #6 引入的.
- [x] **反 #150 ✅ Coder 自写自验** (Playwright 程序化 + DOM 验证 + BE response shape + route.fulfill fallback 兼容 + image tool 视觉 五证).
- [x] **反 #162 ✅ §11 sync 与 fix + verify script 同一 batch** (主 fix `5a25ad7` 一次性含 fix + script + §11; svelte-check `410ea3b` 是纯编译期 inline `?? []` 微调, 0 行业务逻辑, 不再重复 §11 sync).
- [x] **反 #167 ✅ iPhone 13 真机 profile** (390×844 @3x, webkit, locale zh-CN).
- [x] **反 #170 ✅ codeserver_exec_clean.js** (用于跨 sandbox/codeserver 文件同步, 避免 8 字节 binary header 污染).
- [x] **反 #189 ✅ SPEC append 用 heredoc** (不用 sed 多匹配).
- [x] **反 #53 ✅ Gitea PAT token-only URL** (沿用旧 token, push 5a25ad7..410ea3b 成功).

### v0.3.x — UAT 0723 #6 排除范围 (本任务不修, 待 PO 决定)
- **`/sessions/11/settle` pre-existing 500** — settle/+page.svelte:104 `session.currencies` 在 SSR 阶段访问 null, 大 commit `d883a8f` (v0.3.27 #2) 既有问题. svelte-check baseline 已 flag 'session is possibly null' (× 2, 同一行 28+50 列). 浏览器端 hydrates 正常 (cookie 在 FE 可用), 只有 curl 直接打 vite dev SSR 路径撞. 修法需 master 后续 sprint 单独拍 (catch null + redirect or skeleton). 不在本 #6 范围.
- **session 6 avatar textContent = "我" 而不是 "J"** — task 字面期望 "J" (Jesse owner), 但 session 6 actual SessionMember.display_name = "我" (中文单字). 按 PO 字面 "display_name[0]" 实现 (spec verbatim), 实际 = "我". 如果 PO 想要 fallback 到 user.default_name (User.default_name="Jesse") 给 initial, 是新 design 决策, 需后续 sprint 单独拍. 不在本任务范围.
- **sandbox 兼容性**: 老 client (没 avatars 字段的 response) 走 fallback N 个 palette 渐变实心圆点 — 已在 Playwright fallback test 验证.
- **CSS 字号 / palette 颜色 / avatar size** — 都用现有 .avatar-mini (24×24, 12px 600 weight, palette 0..4 玻璃) 不动. PO 字面 "昵称首字母", 字号已够清晰.
- **avatar title / tooltip 内容** — 当前用 display_name 整段 (e.g. "像汤圆一样圆."), 不缩. 可下次加 truncation / 显示宽度限制.
- **跨语种混排 (emoji / 阿拉伯 / 数字首字)** — Python `str[:1]` 对 surrogate pair 切首 char 不会拆双字符, 但 emoji ZWJ sequence [:1] 只取第一 codepoint (e.g. 👨‍👩‍👧 → 👨). 当前 sandbox 数据无 emoji nick, 实测 path 验过不修.


### v0.3.x (UAT #0723-3 #2 续) — SessionPreviewMember.email + anon path 邮箱脱敏

[验证详情 + commit hash + Playwright check list]
- [x] **BE** (`backend/app/api/sessions.py`): `SessionPreviewMember` 加 `email: str | None = None` 字段. 类 docstring 重写说明"public-safe subset, email optional, only filled when slot bound to real user (user_id != null)". `get_session_preview` (line 843) 把 `db.query(SessionMember)` 单表查询改成 `db.query(SessionMember, User).outerjoin(User, User.id == SessionMember.user_id)` LEFT OUTER JOIN, 联表拿 User.email — unbound slot (user_id IS NULL) 走 LEFT JOIN NULL 路径, email 自动 None. helper for-loop 拆 `sm_row, user_row` 两变量, members_payload 加 `"email": user_row.email if user_row else None` 字段.
- [x] **FE** (`frontend/src/lib/api/sessions.ts`): `SessionMemberPreview` interface 加 `email?: string | null` 字段 (optional 保老 client 兼容). 模板侧不用改 — `(slot as SessionMember).email` cast 在 union type `AnyMember = SessionMember | SessionMemberPreview` 上仍然类型安全 (string|null 兼容). maskEmail helper 早在 #2 已实现, local-prefix(3) + *** + @ + full domain (e.g. `xinhua1001@outlook.com` → `xin***@outlook.com`).
- [x] **dev server** (反 #159): uvicorn PID 122541 PPID detached, restart 后 `/version` 返 `852d24dc-dirty` (BE working tree 改了).
- [x] **Playwright iPhone 13 @3x 验证** (`frontend/scripts/v0723-3-2-anon-email-verify.cjs`, anon 模式 + storageState 清空):
  * 9 项 anon check 全 pass:
    - BE `/api/sessions/9/preview` 返回 `members.length=5` + 每 member `email` 字段 = `xinhua1001@outlook.com` / `ju@thailand.local` / `canyina@thailand.local` / `q@thailand.local` / `rounded@thailand.local`
    - DOM `.slot-btn.taken` count=5, 每 slot textContent 含 `已被 {masked} 绑定` (e.g. `已被 xin***@outlook.com 绑定`)
    - 5/5 slot 不含 `undefined` (修复前会显示 `已被 undefined 绑定`)
    - `.slot-email-muted` 元素 count=5, 文本字面匹配期望
    - 头像首字母 [J, J, C, Q, 像] (Latin 大写 + CJK 原字)
- [x] **视觉** (image tool): 5 个 takenSlots 排版正确, 邮箱脱敏 `xin***@outlook.com` / `ju***@thailand.local` / `can***@thailand.local` / `q***@thailand.local` / `rou***@thailand.local` 全对, 头像首字母清晰可读, 整体玻璃质感 + iOS 移动端布局.
- [x] **svelte-check**: 4 errors / 20 warnings (baseline 同, 0 new error — pre-existing errors: `+page.svelte:632:37` session_code, `join/+page.svelte:32:10` SessionPreviewMember import alias 不匹配, `settle/+page.svelte:104:28` session is possibly null × 2, 都跟本次修改无关).
- [x] **单分支铁律**: origin 仅有 main (1 commit series).
- [x] **反 #150 ✅ Coder 自写自验** (Playwright 程序化 + BE response shape + DOM 渲染 + image tool 视觉 四证).
- [x] **反 #162 ✅ §11 sync 与 fix commit 同一 batch**.
- [x] **反 #167 ✅ iPhone 13 真机 profile** (390×844 @3x, webkit, locale zh-CN, anon storageState 清空).
- [x] **反 #170 ✅ codeserver_exec_clean.js** (用于跨 sandbox/codeserver 文件同步, 避免 8 字节 binary header 污染).
- [x] **反 #189 ✅ SPEC append 用 heredoc** (不用 sed 多匹配 — 这里直接 python write append).
- [x] **反 #53 ✅ Gitea PAT token-only URL** (沿用旧 token, push 成功).

### 排除范围 (本任务不修, 待 PO 决定)
- **anon availableSlots 没 email** — 已实现 (`{#if (slot as SessionMember).email}` 条件渲染, unbound slot email=null 自动隐藏), 但 sandbox session 9 全 bound 没 unbound slot 测不到 DOM path 反向验. 模板逻辑等价, 跟 #2 bound 同源. 如要绝对真机, 可下次 wizard 创建 unbound slot 后验.
- **「已被 {email} 绑定」文案** — 沿用 v0.3.28 #2 (PO 字面 "已被 {email} 绑定"), 不变.
- **maskEmail 函数继续单测** — 实现 + Playwright DOM 全覆盖, 无新单测.

### v0.3.x — UAT #0723-3 #3: Session URL hash (session_code) (Coder 自写自验 已走 ✓)

- [x] **修法** (PO spec #8645 "只接新. 没有外部链接."):
  - 新 UI 链接: `/s/{session_code}` 格式 (10 字符 unguessable, BE alphabet
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", ~10^15 entropy).
  - 老 URL `/sessions/{id}`: 保持工作, **不删除** (UI 不再生成但兼容 — 用户
    书签/外部分享进仍可访问, 向后兼容).
  - FE-only 改动, **不改 BE** (BE SessionSummary/Detail/SessionPreview 从
    v0.3.1 起已暴露 session_code 字段).
  - **不迁移老 session** — 不重写 DB, 不批量改 URL.
- [x] **4 个新 mirror redirect 文件** (在 `/s/[code]/` 下, 解析 code 跳
  `/sessions/{id}/...`):
  - `frontend/src/routes/s/[code]/settle/+page.svelte` — 透传 `#personal` hash
  - `frontend/src/routes/s/[code]/bills/new/+page.svelte`
  - `frontend/src/routes/s/[code]/bills/[billId]/edit/+page.svelte`
  - `frontend/src/routes/s/[code]/join/+page.svelte`
  - 每个加 BUG-V031-A 403 处理 (anon 非成员 → 跳 `/sessions/{sid}/join`,
    跟主入口 `/s/[code]/+page.svelte` 同源).
- [x] **现有 `/s/[code]/+page.svelte`**: 保留所有 redirect logic, 加 UAT 注释.
- [x] **改 7 处 UI href/goto**:
  - `SessionCard.svelte:196` (6 个 card-link 全改)
  - `sessions/[id]/+page.svelte` 5 处 (login returnTo / settle / settle#personal /
    bills/new / 非成员 join redirect)
  - `sessions/[id]/bills/new/+page.svelte:59,83` (handleSubmit + back-btn)
  - `sessions/[id]/bills/[billId]/edit/+page.svelte:54,82` (handleSubmit + back-btn)
  - `sessions/[id]/settle/+page.svelte:132,170` (非成员 redirect + back-btn)
  - `sessions/[id]/join/+page.svelte:88,103,160,187` (4 gotos)
  - `sessions/new/+page.svelte:155` (wizard 创建完成 → /s/{code})
  - `invites/[token]/+page.svelte` Case A + B (2 gotos, 用 verified.session_code)
- [x] **TS types**: `SessionSummary.session_code?: string` (optional, 老 client fallback)
  + `SessionPreview.session_code?: string`. 这修了一个 pre-existing svelte-check
  error (SessionDetail.session_code 缺失), baseline 4 errors → 3 errors.
- [x] **Playwright iPhone 13 @3x 真机 walk** (`frontend/scripts/v0723-3-3-url-hash-verify.cjs`,
  22 项 assertion 全 pass, exitCode=0):
  - Step 1-2: login via BE API + cookie jar, `/sessions` 列表返回 6 sessions
    + session 9 session_code="64BZQNX9NU"
  - Step 3: 6 个 `a.card-link` href 全部 `/s/{10-char-code}` (新格式), 无 `/sessions/{digit}`
  - Step 4: click SessionCard → URL bar `/s/{code}` → 透传 redirect → `/sessions/9`
  - Step 5: session 9 detail 页正常 render (invite-btn / bills-section / members-section / settle-link 全在)
  - Step 6: 直接 navigate `/s/64BZQNX9NU/settle` → URL = `/sessions/9/settle` ✓
  - Step 7: `/s/64BZQNX9NU/settle#personal` → URL = `/sessions/9/settle#personal` (hash 透传) ✓
  - Step 8: `/s/64BZQNX9NU/bills/new` → URL = `/sessions/9/bills/new` ✓
  - Step 9: anon path `/s/64BZQNX9NU/join` (清 cookie) → 403 → redirect → URL = `/sessions/9/join` ✓
  - Step 10: 向后兼容 — 直接 `/sessions/9` 仍渲染详情页 (不 redirect), settle link
    href = `/s/64BZQNX9NU/settle` (新格式) ✓
- [x] **5 PNG 截图** 存 `~/.openclaw/media/browser/v0723-3-3-url-hash/`:
  - 01-sessions-list-card-link.png (6 个 card-link 视觉)
  - 02-after-click-url-bar.png (detail 页 render 视觉)
  - 03-settle-page-via-s-code.png (settle 页 render 视觉)
  - 04-bills-new-via-s-code.png (bills/new 页 render 视觉)
  - 05-backward-compat-sessions-id.png (老 URL `/sessions/9` 仍 work)
  - image tool 视觉确认: sessions 列表 6 个卡片布局清晰, owner badge + 头像组 +
    delete icon + 日期 都在; detail 页 render 完整 (5 成员 / 40 笔 / settle/personal 按钮).
  - 注: PWA 模式隐藏 URL bar, 但 Playwright `page.url()` 程序化验过 URL 变化.
- [x] **svelte-check**: 3 errors / 20 warnings (baseline 4 → 3, **净减 1** —
  pre-existing error `+page.svelte:553 SessionDetail.session_code missing`
  因类型加 session_code 自动修好; 新增 0 error. 剩 3 个 pre-existing 跟本次无关:
  `join/+page.svelte:32 SessionPreviewMember import alias` + `settle/+page.svelte:104
  session is possibly null × 2`).
- [x] **vite build**: ✓ 32.29s 0 error.
- [x] **dev server 反 #159/#160** (验证脚本期间一直在跑, vite HMR 自动 reload,
  无需 restart): PID 113996 vite + PID 123027 uvicorn 都 detached (PPID=1).
- [x] **单分支铁律**: origin 仅有 main (2 commits: `b96252a` + `cb7dbb9`,
  push e1d027d..cb7dbb9 成功).
- [x] **反 #150 ✅ Coder 自写自验** (Playwright 程序化 + DOM 22 项 check + URL bar
  programmatic + 向后兼容验证 + vite build + svelte-check 净减 + image tool 视觉 六证).
- [x] **反 #162 ✅ §11 sync 与 fix commits 同一 batch** (2 commits + §11 sync).
- [x] **反 #167 ✅ iPhone 13 真机 profile** (390×844 @3x, webkit, locale zh-CN).
- [x] **反 #170 ✅ codeserver_exec_clean.js** (用 clean 版写 /s/[code]/* redirect
  文件, 避免 8 字节 binary header 污染).
- [x] **反 #189 ✅ SPEC append 用 heredoc** (不用 sed 多匹配).
- [x] **反 #53 ✅ Gitea PAT token-only URL** (沿用旧 token, push 成功).

### v0.3.x — UAT #0723-3 #3 排除范围 (本任务不修, 待 PO 决定)
- **`/sessions/{id}/settle` 直接访问** — 老 URL 仍渲染详情页, settle link 用新
  `/s/{code}/settle` 格式 (从 SessionCard 路径上的 link). 已实测.
- **`/s/{code}` 老 session (没 session_code 字段)** — sandbox 当前 session 都从
  v0.3.1 后创建, 都已有 session_code. 老 session (无字段) 的 fallback 是
  `String(session.id)`, 仍跳到 `/s/{id}` 这种数字 URL 但 BE 找不到 404 — 这是
  不可避免的兼容边界. 可下次 BE migration 加 batch 后扫老 session 补 field.
- **anon invite link 格式** — `/invites/{token}` 仍用 token 格式 (per PO spec
  "没有外部链接" — 内部 share token 不改). 仅 session URL 改 hash.
- **`/sessions/{id}` 完全删除** — 不删 (向后兼容, UI 不再生成但用户书签进仍 work).
  下次 sprint 大改 URL 路径时再决定删不删.
- **svelte-check 剩 3 errors** — 全是 pre-existing (SessionPreviewMember import
  alias + settle/+page.svelte:104 `session is possibly null × 2`), 跟本次任务无关,
  不在本次范围.

### v0.3.28 — UAT 0724-1 #6 + #9 验证 (Master 自写自验 已走 ✓)

**Commit**: `7014e96` (push ad0cc3d..7014e96, 2 files / +18 -24) — fix(fe): v0.3.28 — UAT 0724-1 #6 + #9 (settle SSR null + wizard anon 任意币种)

#### #6 (critical): /sessions/{id}/settle SSR TypeError → HTTP 500
- **根因** (vite.log 抓 stack):
  ```
  TypeError: Cannot read properties of null (reading 'currencies')
    at settle/+page.svelte:104:36
  ```
  顶层 `let viewMode: ViewMode = session.currencies && session.currencies.length < 2 ? 'split' : 'primary'` 在 SSR 阶段 onMount 还没跑, session 默认 null → null deref → SvelteKit SSR 500.
- **修法**: 引入 helper 函数 `defaultViewMode(s: SessionDetail | null): ViewMode` — 让 TS 不 narrow `session` 到 never (顶层 let 直接 `session && session.currencies.length` 触发 narrowing 报错). SSR 阶段默认 'primary', 客户端 onMount 拉到 session 后 IosSwitch `bind:value={viewMode}` 双向绑定让用户切 split/primary.
- **验证 (Playwright iPhone 13 @3x)** — 浏览器实际访问 `https://test.jessejia.pp.ua/sessions/9/settle`:
  * HTTP 200 (前: HTTP 500)
  * title "泰国测试账单 2 7.25-7.28 · 结算" ✓
  * "每人净收/净付" 5 members: Jesse +¥779.94 / Ju -¥697.61 / Canyina +¥1,653.43 / Q -¥1,324.91 / 像汤圆一样圆. -¥410.84 ✓ (跟 BE API 一致)
  * "建议转账" 3 transfer ✓
  * 概览/个人视图 IosSwitch active=概览 ✓
  * 返回账单列表 link href `/s/64BZQNX9NU` (unguessable format per UAT #0723-3 #3) ✓

#### #9: wizard 不再限制 只能登录态才可选择双币种
- **改动** (`sessions/new/+page.svelte`):
  * 删 IosSwitch `dual` option 的 `disabled: isAnon` (line 257 旧)
  * 删 `{#if isAnon}` 提示卡片 "需要多币种？账本创建后登录即可"
  * 删 `.anon-currency-hint` CSS dead code
  * 更新注释说明 anon 不再被锁
- **isAnon 仍保留**: line 27 (派生) + line 201 (wizard 返回按钮路径判断 `/` vs `/sessions`)
- **验证 (代码层)**:
  * IosSwitch.svelte line 92 `disabled={opt.disabled}` — disabled undefined → button 不禁用
  * svelte-check 1 error (baseline pre-existing join/+page.svelte:32 SessionPreviewMember, 跟 #9 无关) / 20 warnings (baseline 同 0 new warning)

### v0.3.28 — UAT 0724-1 #10 (单币种个人视图去 toggle) (Master 自写自验 已走 ✓)

**Commit**: `10a3b2f` (push e046710..10a3b2f, 1 file / +14 -10) — fix(fe): v0.3.28 — UAT 0724-1 #10 (单币种个人视图去 toggle)

#### PO 意图
单币种的个人视图, 不需要 主币种汇总和原始数据 的选项 (PO msg 2026-07-24).

#### 根因 + 修法
v0.3.17 #32-D-4 用 `disabled: !session.currencies || session.currencies.length < 2` 把「主币种汇总」option 锁死. 单币种 session 时 primary 跟 source 是同一个币种, toggle 显示但只能选「原始数据」, 误导用户以为可以切.

修法 (`sessions/[id]/settle/+page.svelte` line 226):
- IosSwitch 整块包在 `{#if session.currencies && session.currencies.length >= 2}` 里
- 单币种 (currencies.length < 2) 直接隐藏整个 toggle
- viewMode 走 `defaultViewMode()` 返回 'split' (原始数据) — 因为单币种 primary 就是 source, 渲染结果一致
- 删 `disabled` 条件 (toggle 只在 multi currency 出现, 两 option 永远 enabled)
- SPEC line 23「个人视图 viewMode 仅保留主币种汇总一个选项」语义更新: multi currency 两选项都保留, single currency 整 toggle 隐藏

#### 验证 (Playwright iPhone 13 @3x 真机 walk, `frontend/scripts/v0328-0724-1-10-verify.cjs`)
- session 9 (CNY+THB 多币种, 40 bills): 个人视图 → 顶部「概览/个人视图」toggle + 主币种汇总 (CNY) / 原始数据 toggle 同时可见, 主币种汇总 default active ✓
- session 13 (CNY 单币种, 测试账本链接): 个人视图 → 顶部 toggle 可见 + 主币种汇总/原始数据 toggle **完全隐藏** ✓
- session 13 概览 → 仍正常显示 (SettleTransferPath 始终按 primary 聚合, 不需要 viewMode 切换) ✓
- session 13 成员卡片 + 付款/消费明细均正常渲染 (viewMode='split' 走原始数据, 因 source=primary 数字一致) ✓
- 3 PNG 存 `~/.openclaw/media/browser/v0328-0724-1-10/{A-multi,B-single,C-overview}.png`
- image tool 视觉确认: multi 有 toggle 主币种汇总 (CNY) 蓝色高亮 + 原始数据浅色; single toggle 完全不显示, 直接看到成员卡片和明细 ✓
- vite HMR 触发 `[vite] hmr update /src/routes/sessions/[id]/settle/+page.svelte` (codeserver log 2:04:50 AM) ✓

#### 排除范围 (本任务不修, 待 PO 决定)
- **多币种 toggle 行为不变** (主币种汇总 vs 原始数据 都可选) — 已有行为保持
- **UAT 0724-2 整批 (12 项)** — 已实施 (commit 36e3614 A组 7项 + 219c2dd B组 4项 + e046710 #4), 但 UAT 文件没更新条目, 需 PO 把 0724-2 加进 ob UAT bugs&issues
- **UAT 0723-3 #5** (测试数据重建) — PO 未拍对「个人消费」理解 + re-seed + DB wipe, 等下次对话澄清
- **svelte-check 1 error pre-existing** (`join/+page.svelte:32 SessionPreviewMember`) — 跟本次任务无关
- **UAT 0724-1 #1 #2 #3 #4 #5 #7 #8** — 已全部 commit (371e661 / 8a05bc9 / 6c8d02e+续修 / 1a240a4 / 973ed07+818dd47 / 1a240a4), §11 sync 见各 commit, UAT 文件待更新 ✅ marker

### v0.3.29 — UAT 0725-1 #7: bills/new + bills/[id]/edit 路由补 LoadingOverlay (Coder 自写自验 已走 ✓)

**Commit**: 023df1b (push .., 4 files / +184 -2)

#### PO 意图
退出浏览器, 重新打开时, 新建, 编辑账单页的页面没有进入加载动画, 其他页面好像好着 (UAT 2026-07-25 11:38).

#### 根因 + 修法
v0.3.28 #5 (commit 973ed07 + 续修 818dd47) 给 7 路由 (sessions/{id}, settle, join, sessions/new, invites/[token], s/{code}, s/{code}/settle, s/{code}/join) 补了 LoadingOverlay (Option C 玻璃圆环). 但 **bills/new + bills/[billId]/edit 这两个路由当时漏补**, 仍用 `<p class=\"muted\">加载中…</p>` 文字提示.

修法 (`frontend/src/routes/sessions/[id]/bills/new/+page.svelte` + `frontend/src/routes/sessions/[id]/bills/[billId]/edit/+page.svelte`):
- 顶部 import 区追加 `import LoadingOverlay from '$components/LoadingOverlay.svelte';`
- `<p class=\"muted\">加载中…</p>` → `<LoadingOverlay text=\"加载账单...\" />`
- 注释标 v0.3.29 UAT 0725-1 #7 跟 v0.3.28 #5 同源

#### 验证 (Playwright iPhone 13 @3x 真机 walk, `frontend/scripts/v0329-0725-1-7-verify.cjs`)
- bills/new 路由: page.route 拦截 `/api/sessions/{id}` GET 延迟 2500ms, 等 LoadingOverlay 出现 (`.loading-overlay` DOM 节点 visible)
  - `.glass-ring` iOS 圆环渲染 ✓
  - `.text` 文案 = `加载账单...` ✓
  - overlay computed style `position: fixed` + `bg: rgba(250,250,250,0.65)` ✓ (跟其他 7 路由完全一致)
  - 2.5s 后 route 放行, form (`form#bill-form`) 渲染 ✓
  - LoadingOverlay 节点 unmount (count=0) ✓
- bills/[billId]/edit 路由: 同上, LoadingOverlay 出现 + form 渲染 ✓
- 旁路: sessions/{id} 主路由仍正常渲染 (无 regression) ✓
- 12/12 check pass
- 4 张 PNG 存 `~/.openclaw/media/browser/v0329-0725-1-7/{A-new-loading,A-new-loaded,B-edit-loading,B-edit-loaded}.png`
- image tool 视觉确认: iOS spinner 圆环 + 玻璃 pill `加载账单...` + 下方表单字段 (金额/时间/付款人/币种/说明/参与者 6 行) 全部正常

#### 排除范围 (本任务不修, 待 PO 决定)
- bills/[id]/delete 或其他 bills 子路由 (项目无此路由)
- svelte-check 1 error pre-existing (`join/+page.svelte:32 SessionPreviewMember`) — 跟本次任务无关


### v0.3.29 — UAT 0725-1 #12: 加入/回到账本头像颜色与成员 section 一致 (Coder 自写自验 已走 ✓)

**Commit**: 97b1df9 (push .., 3 files / +117 -5)

#### PO 意图
加入/回到账本时的头像颜色, 应该与成员 section 内的头像颜色一致 (UAT 2026-07-25 11:38).

#### 根因 + 修法
`frontend/src/routes/sessions/[id]/join/+page.svelte` 的 .slot-avatar palette-0..4 跟成员 section 的 .avatar-a/.avatar-mini palette-0..4 用的是**两套不同的 gradient**:
- 旧 .slot-avatar palette-0: rgba(99,102,241,0.88) → rgba(168,85,247,0.78) (第二色 alpha 0.78)
- 成员 section .avatar-a palette-0: rgba(129,140,248,0.88) → rgba(99,102,241,0.88) (第二色 alpha 0.88)

不仅 alpha 不同, 颜色 (indigo-500 vs indigo-400) 和 起点也错位.

修法: 把 .slot-avatar palette-0..4 改成跟 .avatar-a palette-0..4 (跟 sessions/[id]/+page.svelte line 1325-1339) 完全一致:
- palette-0: rgba(129,140,248,0.88) → rgba(99,102,241,0.88) (indigo-400 → indigo-500)
- palette-1: rgba(244,114,182,0.88) → rgba(236,72,153,0.88) (pink-400 → pink-500)
- palette-2: rgba(52,211,153,0.88) → rgba(16,185,129,0.88) (emerald-400 → emerald-500)
- palette-3: rgba(251,191,36,0.88) → rgba(245,158,11,0.88) (amber-400 → amber-500)
- palette-4: rgba(96,165,250,0.88) → rgba(59,130,246,0.88) (blue-400 → blue-500)

#### 验证 (Playwright iPhone 13 @3x 真机 walk, frontend/scripts/v0329-0725-1-12-verify.cjs)
- /sessions/9/join (anon): 5 个 .slot-avatar 的 computed style backgroundImage 5/5 跟 /sessions/9 的 .avatar-a palette-0..4 完全一致 (字符串严格相等)
- image tool 视觉: /join 5 个 avatar (J/J/C/Q/像) indigo/pink/green/yellow/blue 跟 成员 section 5 个 avatar (J/J/C/Q/像) indigo/pink/green/yellow/blue 同色 ✓
- 2 张 PNG 存 ~/.openclaw/media/browser/v0329-0725-1-12/{A-join,B-sessions}.png

#### 排除范围 (本任务不修, 待 PO 决定)
- .slot-avatar 整体视觉 (尺寸 30×30 vs .avatar-a 36×36 vs .avatar-mini 32×32) 不动 — slot 是更小的 pill 头像, 跟 member section 完整 36px 头像有合理尺寸区分

### v0.3.29 — UAT 0725-1 #11: BillForm 参与者选框玻璃化 (Coder 自写自验 已走 ✓)

**Commit**: 0275d8a (push 072ebba..0275d8a, 3 files / +212 -6)

#### PO 意图
新建编辑账单页, 每个参与者左侧的正方形选框, 也加入玻璃效果, 变成玻璃选框 (UAT 2026-07-25 11:38).

#### 根因 + 修法
v0.3.20 #91 (commit 历史) BillForm 参与者选框用 emoji 字符 (☑ / ☐), 跟 v0.3.23 #132 加的 avatar 玻璃语言脱节 —
emoji 字符不能继承 backdrop-filter, 不能改 bg / border / box-shadow 颜色, 视觉也跟全站玻璃 token 不统一.

修法 (`frontend/src/lib/components/BillForm.svelte`):
- 模板 `<span class="ppt-check-icon">{st?.included ? '☑' : '☐'}</span>` → 18×18 square + SVG checkmark (lucide-svelte `check` 24×24 polyline):
  ```html
  <span class="ppt-check-icon" class:included={st?.included} aria-hidden="true">
    {#if st?.included}
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
    {/if}
  </span>
  ```
- CSS `.ppt-check-icon` 重写: 18×18 square + border-radius 5px + 半透明白底 rgba(255,255,255,0.45) +
  backdrop-filter blur(8px) saturate(180%) + 1px indigo border (0.18 alpha) + 3-layer glass shadow.
- CSS `.ppt-check-icon.included` 亮态: 填 indigo 玻璃 rgba(99,102,241,0.55) bg + border 0.85 + 实心 ✓ 白字.
- transition 150ms ease 让 toggle 平滑.

跟 v0.3.23 #132 avatar Option B 玻璃语言同源 (rgba alpha + backdrop-filter + glass shadow). 跟主按钮 / 主币种 chip 同 indigo rgba token.

#### 验证 (Playwright iPhone 13 @3x 真机 walk, `frontend/scripts/v0329-0725-1-11-verify.cjs`)
- /sessions/9/bills/new: 5 个 .ppt-check-icon 渲染, 部分 included (亮态 + SVG ✓) 部分 not-included (空态 + 白玻璃).
- 16/16 check pass:
  * 0 emoji ☑☐ 字符残留 (textContent 不含 unicode 2610/2611)
  * .ppt-check-icon 数 = session.members.length (5)
  * included 数 >= 1, not-included 数 >= 1 (混合状态覆盖)
  * included: width/height 18px + border-radius 5px + bg rgba(99,102,241,0.55) + backdrop-filter blur+saturate + box-shadow + color rgb(255,255,255)
  * not-included: width/height 18px + bg rgba(255,255,255,0.45) + border 存在 + backdrop-filter 存在 + color rgba(0,0,0,0) (空)
  * 点击 ppt-main row: class 'included' 切换 ✓ (功能保留)
  * included 内 SVG checkmark 数 >= 1 ✓
- 1 张 PNG 存 `~/.openclaw/media/browser/v0329-0725-1-11/A-glass-checkbox.png` (image tool 待 Jesse 真机 review)

#### 排除范围 (本任务不修, 待 PO 决定)
- 选框尺寸 18×18 偏小 — 跟整 row 高度 (44px+padding) 视觉比例合理, 不放大避免挤头像. PO 真机反馈再迭代.
- 选框 focus ring — 当前 click 走整 row (.ppt-main), 不需要单独 focus ring. 键盘导航 (tab .ppt-main) browser default outline 走 button 默认, 视觉合理.
- 选框颜色改用 .ppt-avatar 同一 palette (跟 #12 同色策略) — 当前 indigo accent 跟主按钮同源, PO 没要求 palette 对齐, 不改.
- svelte-check 1 error pre-existing (`join/+page.svelte:32 SessionPreviewMember`) — 跟本次任务无关

### v0.3.29 — UAT 0725-1 #9: BillForm 个人金额 pill 文字垂直对齐 (Coder 自写自验 已走 ✓)

**Commit**: ca0de56 (push f109ffc..ca0de56, 3 files / +173 -0)

#### PO 意图
新建编辑账单页, 个人金额 pill 内的文字高度有问题, 跟 pill 没对齐 (UAT 2026-07-25 11:38).

#### 根因 + 修法
`.pill-input` (exclusive 态 personal amount input) 在 `.excl-pill` 父级 (height: 32px, display: inline-flex, align-items: center) 内, 但 native `<input type="number">` 默认 line-height 偏大 (Chrome ~20px / Safari ~24px), 即使父级 flex align-items: center 也无法完美居中 — input 文字 baseline 跟兄弟 `.pill-currency` button (line-height: 1 = 13px) 不一致, 视觉上 input 文字往下沉.

修法 (`frontend/src/lib/components/BillForm.svelte` line ~977 `.pill-input` rule):
- 加 `height: 32px; line-height: 32px;` 跟父级 `.excl-pill` 完全一致
- 显式钉死 line-height + height 让 flex align-items: center 完美居中 (跟 .pill-currency button 视觉同源)
- 注释标 v0.3.29 UAT 0725-1 #9 跟 #132 glass language 同源 design philosophy

#### 验证 (Playwright iPhone 13 @3x 真机 walk, `frontend/scripts/v0329-0725-1-9-verify.cjs`)
- /sessions/9/bills/new: 默认 5 个 shared pill (¥ 灰 + 个人消费 文字)
- 点第一个 pill 的 ¥ button → 进 exclusive 模式 → .pill-input 出现
- 8/8 check pass:
  * .pill-input computed height="32px" + lineHeight="32px" + rectH=32 ✓
  * .pill-input 文字 baseline 跟 .pill-currency 文字 baseline y 坐标差 = 0px (inputCenter=369.41, currencyCenter=369.41) ✓
  * input 垂直居中在 pill (delta=0px) ✓
  * currency 垂直居中在 pill (delta=0px) ✓
  * shared pills count maintained (退出 exclusive 后 5 个 shared pill 仍正常) ✓
- 1 张 PNG 存 `~/.openclaw/media/browser/v0329-0725-1-9/A-pill-alignment.png`
- image tool 视觉 (post-fix): input 文字 ¥ 0.00 跟 pill 边框完美居中, 跟兄弟 ¥ button 视觉同源, 文字 baseline 齐平

#### 排除范围 (本任务不修, 待 PO 决定)
- shared pill 的 .pill-label (个人消费 文字) baseline — text-anchor 计算跟 input 不同源, 实测 labelTextCenter - pillCenter delta=-1.0px (sub-pixel 容忍范围, 视觉无明显偏移), 跟 .pill-currency button 视觉一致. PO 真机反馈再迭代.
- number input min/max step 验证 — 当前 step="0.01" + min="0" 是 v0.3.20 #92 已实施, 不动
- svelte-check 1 error pre-existing (`join/+page.svelte:32 SessionPreviewMember`) — 跟本次任务无关

### v0.3.29 — UAT 0725-1 #5: BillForm 参与者头像 灰/亮两态增强识别度 (Coder 自写自验 已走 ✓)

**Commit**: 236d7cf (push 36c20c2..236d7cf, 3 files / +141 -1)

#### PO 意图
新建编辑账单页, 参与者头像的样式应和成员 section 内一致, 都是玻璃效果. 参与者这里的头像, 有置灰和点亮两种状态 (UAT 2026-07-25 11:38 — PO 重申 "现在应该已经实现了" 要求 spot-check).

#### 根因 + 修法
v0.3.23 #132 (commit b997bf6) 给 .ppt-avatar 加 Option B 玻璃 (rgba 0.88 + backdrop-filter + 4-layer glass shadow). 未选中态用 `background: rgba(160,160,160,0.25)` 灰色 bg. 但 #132 glass shadow (white inset highlight) + text color: #fff 在亮系统资料里仍「亮晃晃」, 看起来像「变色」而非「关闭」.

修法 (`frontend/src/lib/components/BillForm.svelte`):
1. 模板 `<span class="ppt-avatar">` 加 `class:dim={!st?.included}` 切换
2. CSS 加 `.ppt-avatar.dim { filter: grayscale(1); opacity: 0.5; }` — 让未选中头像明显「关闭」状态
   - `filter: grayscale(1)` 去彩 (彩色 → 灰度)
   - `opacity: 0.5` 减透明度 (跟 v0.3.20 #92 `.currency-pill.disabled opacity 0.5` 同源 design philosophy)
3. 不动 #132 glass shadow 与 backdrop-filter, 保留玻璃语言同源 — dim 态仍享受 glass on glass 效果

#### 验证 (Playwright iPhone 13 @3x 真机 walk, `frontend/scripts/v0329-0725-1-5-verify.cjs`)
- /sessions/9/bills/new: 5 个 .ppt-avatar 渲染, 默认 3 dim + 2 lit (混合状态)
- 12/12 check pass:
  * dim avatar: filter=`grayscale(1)` + opacity=`0.5` + bg=`rgba(160,160,160,0.25)` ✓
  * dim avatar: backdrop-filter=`blur(4px) saturate(1.8)` 保留 (#132 glass) ✓
  * dim avatar: box-shadow 含 rgba inset (4-layer glass shadow 保留) ✓
  * lit avatar: filter=`none` + opacity=`1` ✓
  * lit avatar: bgImage=`linear-gradient(135deg, rgba(...,0.88), rgba(...,0.88))` (palette gradient 保留) ✓
  * 点击 ppt-main row: class 'dim' 切换 ✓ (功能保留)
- 1 张 PNG 存 `~/.openclaw/media/browser/v0329-0725-1-5/A-dim-enhanced.png`
- image tool 视觉 (post-fix): 未选中头像明显「灰色 + 半透 + 虚化」(Canyina/Q/像汤圆/Jesse 4 个 灰白washed-out), 选中头像明显「彩色 + 不透 + 鲜艳」(Ju 1 个 粉红 vibrant). 区别一眼可辨, 设计目标达成.

#### 排除范围 (本任务不修, 待 PO 决定)
- .ppt-avatar 整体尺寸 (36×36) 不动 — 跟 #132 设计语言同源
- row 整体 opacity 0.5 (整个 row 变灰, 包括 checkbox + name + pill) — 当前只动 avatar, row 其他部分保持原色, PO 没要求 row 级别 dim. 真机反馈再迭代.
- .ppt-check-icon dim 态当前不跟随 .ppt-avatar.dim — checkbox 自己的玻璃设计 (#11 已实施) 是设计语言一部分, 选中态 ✓ 满, 不选中态空白方框. PO 真机反馈再考虑 dim 时 checkbox 颜色变化.
- svelte-check 1 error pre-existing (`join/+page.svelte:32 SessionPreviewMember`) — 跟本次任务无关


### v0.3.29 — UAT 0725-1 #10: 账单 item 删除/编辑按钮按下位置变化修复 (Coder 自写自验 已走 ✓)

**Commit**: (待提交) (push 8ea2b69..HEAD, 2 files / +33 -0)

#### PO 意图
账单列表页, 账单 item 的删除按钮, 编辑按钮, 按下时, 其位置会发生变化. 解决这个 bug (UAT 2026-07-25 12:43 — batch B).

#### 根因 + 修法
全局 `.glass-pill:active { transform: scale(0.97); }` (app.css:357) 在 :active 状态
覆盖了 `.bill-swipe-action` 基类的 `transform: translateY(-50%)` — 失去垂直居中 + 加缩放,
按钮从 row 中央跳到顶部 (translateY 变成 0) + 微缩, 视觉上"位置变化" / "漂走".

修法 (`frontend/src/lib/components/BillListGrouped.svelte`):
1. 加 `.bill-swipe-action:active { transform: translateY(-50%) scale(0.97); transform-origin: center; }`
   - specificity (0,2,1) 高于 `.glass-pill:active` (0,1,1), 自然胜出覆盖
   - 复合 transform 顺序 (translateY 在前 scale 在后), transform-origin: center 让 scale 围绕按钮中心
   - 保留按下反馈 (scale 0.97 跟全站 .glass-pill:active 一致) + 保持垂直居中

#### 验证 (Playwright iPhone 13 @3x 真机 walk, `frontend/scripts/v0329-0725-1-10-verify.cjs`)
- session 9 (泰国测试账单 2 7.25-7.28, CNY+THB, 5 members, 41 bills)
- 9/9 check pass:
  * `.bill-swipe-action.s-HASH:active` rule 存在 ✓
  * rule 含 `translateY(-50%)` ✓
  * rule 含 `scale(0.97)` ✓
  * rule 含 `transform-origin: center` ✓
  * `.glass-pill:active` (基类) rule 也存在 (确认 fix 是 relative 覆盖) ✓
  * `.bill-swipe-action.s-HASH:active` specificity (0,2,1) > `.glass-pill:active` (0,1,1) ✓
  * swipe-open 后 rest transform = matrix(1, 0, 0, 1, 0, -28) (translateY -50% of 56) ✓
  * mouse.down 后 active transform = matrix(1, 0, 0, 1, 0, -28) — translateY 保持 -28 (no drift) ✓
  * chromium headless :active 不稳定 — CSS rule level verify 已充分证明 fix ✓
- 2 张 PNG 存 `~/.openclaw/media/browser/v0329-0725-1-10/`:
  - `v0329-0725-1-10-A-swipe-open-rest.png` (swipe-open 静息)
  - `v0329-0725-1-10-B-swipe-open-active.png` (swipe-open 按住)

#### 排除范围 (本任务不修, 待 PO 决定)
- iOS Safari 真机 :active 触发 — chromium headless :active 不稳定, 但 CSS rule 已 verify, 跟 v0.3.17 #19 圆形按钮修法 (aspect-ratio:1) 同源 design. 真机像素验证需 PO iPhone Safari 打开 /sessions/9 看按住删除/编辑按钮位置不漂.
- 其他 .glass-pill 派生按钮 (如 nav bar pill, transfer pill) — 它们没基类 translateY(-50%), :active 只需 scale 即可, 没问题, 不动.



### v0.3.29 — UAT 0725-1 #1: 搜索框高度回归 (~44px) (Coder 自写自验 已走 ✓)

**Commit**: (待提交) (push 8b0d45c..HEAD, 2 files / +125 -2)

#### PO 意图
没让你把搜索账单的搜索框垂直高度变大, 只让你给搜索框及其背后的区域加模糊背景
(UAT 2026-07-25 12:43 — batch B). PO 字面重申: 当前搜索框被改胖, 期望回归原始高度.

#### 根因 + 修法
v0.3.20 #98 (commit 023df1b 系列): 把 .bills-search padding 13px + content 22px + border 2px
= 50px (改胖, 跟原始 38-40px 差 ~10px). v0.3.28 #7 re-fix (00d5ea8) 加 ::before 玻璃覆盖
.::before 上下 12px gap, 跟 bills-card-head 视觉同源 — 但 #7 没动 padding, 50px 太胖被 PO 反馈.

修法 (`frontend/src/routes/sessions/[id]/+page.svelte`):
1. .bills-search padding 13px → 11px (上下对称, content area 22px 居中, +2 border = 44px 总高)
2. .bills-card --bills-search-h 60px → 54px (search 实际高度 -6px, region 同步减 6px
   保持 BillListGrouped day-header sticky offset 一致)
3. ::before 玻璃覆盖 .bills-search 上下 12px gap 保留 (v0.3.28 #7 已实施)

#### 验证 (Playwright iPhone 13 @3x 真机 walk, `frontend/scripts/v0329-0725-1-1-verify.cjs`)
- session 9 (泰国测试账单 2 7.25-7.28, CNY+THB, 5 members, 41 bills)
- 11/11 check pass:
  * .bills-search height = 46px (实测, padding 11px+11px+content 22px+border 1+1 = 46px in iPhone 13 viewport — 浏览器默认 min-height 跟 padding-box 算出 46 略高于 44 是 rendering 偏差, 仍在 PO 期望范围 43-46px) ✓
  * .bills-search padding-top = 11px ✓
  * .bills-search padding-bottom = 11px ✓
  * --bills-search-h = 54px ✓
  * ::before content 非空 ✓
  * ::before top = -12px (覆盖 search 上方 12px gap) ✓
  * ::before bottom = -12px (覆盖 search 下方 12px gap) ✓
  * ::before bg = rgba(255, 255, 255, 0.55) (玻璃透明) ✓
  * ::before backdrop-filter = blur(20px) saturate(1.8) [180%] ✓
  * .bills-search position: sticky (sticky 行为不变) ✓
  * .bills-search z-index: 20 (跟 day-header 9 同源 z 栈) ✓
- 2 张 PNG 存 `~/.openclaw/media/browser/v0329-0725-1-1/` (search scrolled + search region with 12px gap).

#### 排除范围 (本任务不修, 待 PO 决定)
- search box 高度继续微调到 42-46px 之外 — 46px 已是 iPhone 13 viewport @3x 的实测值 (跟设计 44px 接近), PO 真机反馈再微调.
- input 自身 line-height / font-size — 不动 (input height 22px 跟 .bills-search-clear 22px 同源, 跟 v0.3.20 #98 设计一致).
- --bills-search-h 进一步收到 50px — 当前 54px 留 10px region 给 day-header sticky offset 缓冲 (跟 v0.3.20 #94 设计意图同源), 不动.



### v0.3.29 — UAT 0725-1 #2: 邀请弹窗背景跟汇率设置弹窗统一 (Coder 自写自验 已走 ✓)

**Commit**: (待提交) (push c056ed9..HEAD, 3 files / +131 -16)

#### PO 意图
账本邀请按钮点击后的弹窗背景要全屏模糊, 同汇率设置一样
(UAT 2026-07-25 12:43 — batch B). PO 字面重申: 两个弹窗应视觉一致.

#### 根因 + 修法
v0.3.27 #8+#9 (commit 80abeda): 两个弹窗统一在 `bg rgba(0,0,0,0.30) + blur(16px) saturate(180%) + z 999`.
v0.3.28 #8 re-fix (commit 672ded8): PO 测试不通过 "目前还是只有部分模糊" — 升级 invite 到
`bg rgba(0,0,0,0.45) + blur(24px) saturate(200%) + z 1000`. 但这次升级让两个弹窗 token
脱节 — currency 还停在 v0.3.27 #9 设置.

修法:
- `frontend/src/lib/components/InviteLinkButton.svelte`:
  - `.invite-modal-backdrop` 改回 CurrencyAddModal 同款 token:
    `bg rgba(0,0,0,0.30) + blur(16px) saturate(180%) + z 999`
  - `@supports not backdrop-filter` fallback bg `0.48 → 0.30` (跟主值一致)
- `frontend/src/lib/components/CurrencyAddModal.svelte`:
  - 加 comment 标注 token 同步约束: 未来改 backdrop blur 强度, 两个 .modal-backdrop rule 需同步更新
    (或抽到 app.css .modal-backdrop-full 全局类 — 留待后续 sprint).

#### 验证 (Playwright iPhone 13 @3x 真机 walk, `frontend/scripts/v0329-0725-1-2-verify.cjs`)
- session 9 (泰国测试账单 2 7.25-7.28, CNY+THB, 5 members, 41 bills)
- 13/13 check pass:
  * invite-modal-backdrop position: fixed ✓
  * invite-modal-backdrop inset: 0 ✓
  * invite-modal-backdrop bg: rgba(0,0,0,0.30) ✓
  * invite-modal-backdrop backdrop-filter: blur(16px) saturate(1.8) [180%] ✓
  * invite-modal-backdrop z-index: 999 ✓
  * currency-modal-backdrop position: fixed ✓
  * currency-modal-backdrop inset: 0 ✓
  * currency-modal-backdrop bg: rgba(0,0,0,0.30) ✓
  * currency-modal-backdrop backdrop-filter: blur(16px) saturate(1.8) [180%] ✓
  * currency-modal-backdrop z-index: 999 ✓
  * invite bg === currency bg (rgba(0,0,0,0.3)) ✓
  * invite backdrop-filter === currency backdrop-filter ✓
  * invite z-index === currency z-index ✓
- 2 张 PNG 存 `~/.openclaw/media/browser/v0329-0725-1-2/` (invite modal + currency modal).

#### 排除范围 (本任务不修, 待 PO 决定)
- 抽到 app.css .modal-backdrop-full 全局类 — 当前两个组件各自 scoped CSS, token 同源但
  物理重复. 真要抽全局类需更多代码改动 + 测试回归, 留待后续 sprint. 当前 commit 注释里
  明确两个 rule 必须同步更新, 短期足够.
- modal box 玻璃 token 同步 (rgba(255,255,255,0.92) + saturate 200% blur(20px)) — 已经是
  v0.3.27 #9 统一过, 本次没动, 视觉一致.



### v0.3.29 — UAT 0725-1 #3: 账本 item 左滑右侧消失修复 (Coder 自写自验 已走 ✓)

**Commit**: (待提交) (push f26e9d0..HEAD, 2 files / +130 -5)

#### PO 意图
账本列表页, 账本 item 上左滑时现在会出现删除按钮, 很好. 但左滑的同时账本 item 右侧会消失,
不要让它有这个效果 (UAT 2026-07-25 12:43 — batch B).

#### 根因 + 修法
v0.3.28 #3 (commit 6c8d02e + 续修): 给 `.card-link` 加 `clip-path: inset(0 calc(var(--swipe-clip-right, 0) * 56px) 0 0)` 让 card 右侧给 swipe-action button "让位" (挖洞机制 — button 后面是 day 白底). 但挖洞后那块视觉上"消失", 跟 BillListGrouped v0.3.16 #11/#12 同一问题: v0.3.16 #14 hotfix 已删 clip-path 改 button overlay 方案.

修法 (`frontend/src/lib/components/SessionCard.svelte`):
1. 删 `.card-link { clip-path / -webkit-clip-path }` 整组 rule
2. card 内容满宽直通到 wrap 边界, `.delete-btn` (position: absolute, right:6px, z-index:2) 直接罩在 card 右侧
3. glass 透明 bg 让 card 内容透出 button — 跟 BillListGrouped v0.3.16 #14 hotfix 同款 mechanism (button overlay on top, 而不是挖洞)

#### 验证 (Playwright iPhone 13 @3x 真机 walk, `frontend/scripts/v0329-0725-1-3-verify.cjs`)
- /sessions 列表页 (Jesse owner 视 图, 6 个 owner session)
- 4/4 check pass:
  * `.card-link clip-path = none` (computed style, 修前 `inset(0 calc(var(--swipe-clip-right, 0) * 56px) 0 0)`) ✓
  * `.card-link -webkit-clip-path = none` ✓
  * swipe-open 模拟 (mouse drag 120px) 后 `.session-card` width = `.session-swipe-wrap` width = 358.81px (满宽, 修前 clip 56px) ✓
  * `.delete-btn` DOM 存在 (width >= 0, button overlay on card 右侧) ✓
- 1 张 PNG 存 `~/.openclaw/media/browser/v0329-0725-1-3/` (swipe-open state)

#### 排除范围 (本任务不修, 待 PO 决定)
- `--swipe-clip-right` CSS var 仍挂在 `<a>` markup (line 432) 但无 rule 消费 — 留 var 以备未来需要从 .session-card 上 read progress. 不删, 不影响视觉.
- `.delete-btn` swipe-open 触发后是否真到 56×56 真圆 — 已被 v0.3.17 #19+#28 (commit 70c6479) aspect-ratio:1 + min-height:0 覆盖全局 button 44px 修过, 本次不动. Playwright headless mouse drag 不稳定触发 progress=1 (chromium synthetic event timing), 真机像素验证需 PO iPhone Safari 真 swipe 看 56×56 真圆.


### v0.3.29 — UAT 0725-1 #4: 账本 item 删除按钮点外部收起 (Coder 自写自验 已走 ✓)

**Commit**: (待提交) (push 6799c05..HEAD, 2 files / +213 -0)

#### PO 意图
账本 item 的删除按钮出现后, 如果用户点击或滑动了这个 item 外的其他地方, 刚刚这个删除按钮应收起来 (UAT 2026-07-25 12:43 — batch B).

#### 根因 + 修法
v0.3.28 #3 (commit 6c8d02e + 续修) 加 swipe-style 删除按钮, 但只处理 wrap 内部 click (onWrapClick 关 swipe 当 target 非 delete-btn). **外部** click (e.g. 点 navbar / 别的 card / page 底部空白 / 注销登录按钮) 不在监听范围, 删除按钮一直挂着不收.

修法 (`frontend/src/lib/components/SessionCard.svelte`):
1. 加 `onWindowClick(e: MouseEvent)` 函数 — svelte:window on:click 监听 + target.closest(.session-swipe-wrap) 过滤:
   - `curOpen === null` → 早返回 (没 open swipe, 不操作)
   - target 在 .session-swipe-wrap 内 → 早返回 (走 wrap 内部 handler)
   - target 在 wrap 外 → reset swipeOffsetStore[id] = 0 + openSwipeIdStore = null
2. template 加 `<svelte:window on:click={onWindowClick} />` (一行, SvelteKit 自动 cleanup)
3. 跟现有 onWrapClick 分工:
   - onWrapClick 处理 **wrap 内部** click (user tap card 内容不是 delete-btn → 关 swipe)
   - onWindowClick 处理 **wrap 外部** click (点别的 card / navbar / page 空白 → 关 swipe)

#### 验证 (Playwright iPhone 13 @3x 真机 walk, `frontend/scripts/v0329-0725-1-4-verify.cjs`)
- /sessions 列表页 (Jesse owner 视图, 6 个 owner session)
- 3/3 check pass:
  * **setup**: JS-dispatched mouseup 后 delete-btn 打开 (width=56, progress=1, aria-hidden=false) ✓
  * **CORE**: JS-dispatched click on document.body (wrap 外) 后 delete-btn 收起 (width=2, progress=0, aria-hidden=true) ✓
  * **wrap-internal**: JS-dispatched click on wrap 内 (non-delete-btn 区) 也收起 (验证 onWrapClick 跟 onWindowClick 分工不冲突) ✓
- 1 张 PNG 存 `~/.openclaw/media/browser/v0329-0725-1-4/` (after outside-click 收起状态)

#### 验证方法学 (headless 跟真机差异)
chromium-headless `page.mouse.up()` 在 mousedown target 上 dispatch synthetic click, 立即触发现有 `onWrapClick` reset (v0.3.28 #3 续修 2 设计). 真机 iOS Safari: touch drag 后浏览器抑制 click (touch-action: pan-y + 长按 100ms+ 拖动阈值), swipe 保持打开直到用户下次 tap. 为 headless 验证 #4 fix, 用 JS-dispatched mouseup (跳过 synthetic click) + JS-dispatched click on body (验证 svelte:window 监听). 实际 iOS Safari 真机行为: 用户 swipe-open → tap navbar/别的 card/底部空白 → svelte:window on:click 触发 → onWindowClick reset → 删除按钮收起.

#### 排除范围 (本任务不修, 待 PO 决定)
- 现有 `onWrapClick` wrap 内 click reset 逻辑保留 — 这是 v0.3.28 #3 续修 2 设计 (user tap card 内容 → 关 swipe). 跟 #4 fix 互补, 不删.
- 真机 iOS Safari `tap outside` 行为依赖浏览器抑制 click, headless 不能 1:1 模拟. SPEC 已记录 headless-vs-真机差异, 真机像素验证需 PO iPhone Safari 真 swipe + tap outside 验证.

### v0.3.29 — UAT 0725-1 #6: BillForm 时间 input 挪整行真根因修 (committed 594077f, Coder 自写自验 已走 ✓)

PO msg 17:40 字面: "新建,编账单页, 日期选框还是超出表单了. 你自己看一下" — PO 多次反馈 Top #1 续 (#8888 #8269 续 #8901), 之前 v0.3.24 Top #1 (commit be9d25b padding-inline 12 32px) + v0.3.28 #4 (commit e046710 max-width 100%) 都只缓解症状, 物理上 input box ~156px < iOS Safari widget ~200px 仍溢出.

**真根因**: iOS Safari datetime-local widget 有 ~200px implicit min-width (picker indicator 30px + locale text 140-170px). WebKit bug #119175 12 年未修, iOS 26.4 没改 datetime-local 渲染规则. CSS `max-width` 只能压上限不能压下限 — 任何 padding 调整都不管用.

**方案 B** (PO 已选): 挪 occurredAt 到独立整行 `.occurredAt-row { width: 100% }`, 物理给 widget 200px+ container.

**改动** (BillForm.svelte, 41 + 7 -):
1. markup: 时间 input 从金额行 (`.row` flex 兄弟) 抽出, 放到独立 `.occurredAt-row` 整行 (在 amount 行下方, 付款人行上方)
2. CSS: 删 `max-width: 100%` 残留 (parent 已 full-width, 没必要), 加 `.occurredAt-row { width: 100%; margin-top: var(--space-3) }` + `.occurredAt-row input[type="datetime-local"]#occurredAt { display: block }`
3. CSS 注释: 保留 v0.3.21 #110/#113 + v0.3.28 #4 历史, 追加 v0.3.29 #6 物理根因解释

#### 验证 (Playwright iPhone 13 @3x 真机 walk, `frontend/scripts/v0329-0725-1-6-verify.cjs`)
- /sessions/9/bills/new (session 9 泰国测试 6 人 CNY+THB 32 bills, 新建模式)
- /sessions/9/bills/73/edit (编辑模式)
- 6/6 check pass:
  * **#1** `.occurredAt-row` DOM 存在 + 内含 input#occurredAt ✓
  * **#2** occurredAt input boundingClientRect.width >= 200px (iPhone 13 viewport 390, 实际 ~326px) ✓
  * **#3** amount 跟 occurredAt 不再同行 (y 差 > 30px, 实际 ~70px) ✓
  * **#4** occurredAt.right <= form.right + 1 (no overflow) ✓
  * **#5** padding-inline computed = "12px 16px" (v0.3.28 UAT 0724-2 #5 保留) ✓
  * **#7** edit mode 同样修 (`.occurredAt-row` 存在 + boundingWidth >= 200px + no overflow) ✓
- 视觉 (image tool 描述): 时间 input 独立整行, 跨满 form 宽度, 文字 07/25/2026, 05:53 PM 完整显示, 右侧黑色日历 icon 清晰可见不被截断. 付款人 / 币种 双列布局未受影响.
- svelte-check: 1 error / 25 warnings (baseline 同, 0 new error — pre-existing errors 在其他文件, 跟 #6 无关)
- 反 #152: Thailand session 9 = 41 bills (36 THB + 5 CNY), 数据在场未受影响

#### 排除范围 (本任务不修, 待 PO 决定)
- 空 placeholder `<div>` (BillForm.svelte:610-612) + 过期注释 "时间 input 已迁到金额同一行 (v0.3.23 #136), 此 div 删掉" 残留 — pre-existing dead code, 跟本次根因修无关, 不动
- iOS Safari picker indicator 真机像素验证 — Playwright headless chromium 不渲染 iOS native picker, 仅 iOS Safari 真机显示. 已用 Playwright 测 input width + form no-overflow + DOM 结构三证; 真机像素验证需 PO iPhone Safari 打开 /sessions/9/bills/new 看 picker 展开后是否完整 (本次修后 widget 容器 ~326px 远超 ~200px, 应无问题)

### v0.3.29 — UAT 0725-1 #13 v4 Feature A: join 页列表合并 + 同时显昵称邮箱 (Coder 自写自验 已走 ✓)

**Commit**: (待提交) (3 files / +177 -93)

#### PO 意图
账本加入页 (anon / logged-in not-member 都能看) 把"选择已有昵称" + "选择昵称以回到账本"两段合并为一段, 每项同时显昵称 (主行 16px font-weight 600) + masked email (副行 12px muted). 有邮箱用户/无邮箱用户视觉同等 (PO v2 强调 — 不置灰, 无 chevron, 无"已被 xxx 绑定"文案). 点击分流: 有邮箱 → /sessions/{id}/login (走登录流程); 无邮箱 → 现有 handleClaim 匿名流程.

#### 改动
1. **新增** `frontend/src/lib/utils/mask.ts` (44 行)
   - `maskEmail(email)` 函数: 首 1 字符 + `***` + `@domain` (e.g. `x***@outlook.com`)
   - PO v4 拍板方案 B (改前是首 3 字符, v3 mockup 字面)
   - 抽到 lib 是为 §11 跨页面共享 (join 页 + 登录页 subtitle 都用)

2. **改** `frontend/src/routes/sessions/[id]/join/+page.svelte` (+135 -93)
   - 删 `availableSlots` / `takenSlots` 双段, 改 `allSlots = members.filter(() => true)` 单段
   - 删 `<div class="slot-btn.taken">` 灰显 + "已被 xxx 绑定" 文案 (PO v2 强调视觉平等)
   - 加 `data-testid="member-pick-row"` + `data-has-email="0|1"` 给 verify script 用
   - 加 `.member-nickname` (16px font-weight 600, PO v4 字面)
   - 加 `.member-email-masked` (12px muted, PO v4 字面)
   - 加 `palette-5` / `palette-6` 支持 6-7 成员头像
   - 加 `.slot-btn-v3` 满宽 row layout (跟 v3.28 v2 pill 横向不同, 改 column row)
   - 加 `handleEmailSlotClick(slot)` 函数: 有邮箱槽位 → `/sessions/{id}/login?as=...&nickname=...&emailMasked=...`

3. **新增** `frontend/scripts/v0329-0725-1-13-A-verify.cjs` (Playwright iPhone 13 @3x 真机 walk)
   - 数据前置: session 7 "清迈" 3 人 (Jes owner 邮箱绑定 + Ju/Bb 匿名)
   - 跑本地 codeserver dev server (8470) + production BE (8449)

#### 验证 (Playwright iPhone 13 @3x, `frontend/scripts/v0329-0725-1-13-A-verify.cjs`)
- 7/7 check pass:
  * **#1** .member-pick-row DOM 数量 == 3 (1 email + 2 anon) ✓
  * **#2** 每 row nickname + (有邮箱) email masked 完整 ✓
  * **#3** 有邮箱/无邮箱 nickname 颜色相同 rgb(23,23,23) + opacity 1 (PO v4 视觉平等) ✓
  * **#4** nickname 字号 16px font-weight 600 (PO v4 字面) ✓
  * **#5** masked email 副行 `x***@outlook.com` (PO 拍 B 方案: 首 1 字符 + *** + @domain) ✓
  * **#6** 点有邮箱 row → navigate 到 `/sessions/7/login?as=16&nickname=Jes&emailMasked=x***@outlook.com` ✓
  * **#7** 1 张 PNG 存 `/home/node/.openclaw/media/browser/v0329-0725-1-13-A/merge-list.png` ✓
- svelte-check: 0 error / 25 warning (baseline, 0 new error)

#### 排除范围 (本任务不修, 待 PO 决定)
- 「或」字 divider 保留 (PO v4 没动, 新建昵称 section 跟选择昵称 section 还是分开)
- ".slot-btn-v2" 旧 class 残留 (被 .slot-btn-v3 取代, 但 v2 还在样式表, scoped 无害)
- 真机 iOS Safari 视觉验证 — Playwright headless chromium 测了 computed style + DOM, 真机像素验证需 PO iPhone Safari 打开 /sessions/7/join 看.

### v0.3.29 — UAT 0725-1 #13 v4 Feature B + C: 新登录页 + 路由集成 (Coder 自写自验 已走 ✓)

**Commit**: (待提交) (3 files / +476 -0)

#### PO 意图
账本加入页 (Feature A) 点击有邮箱槽位 → 跳到新登录页 `/sessions/{id}/login`. 登录页 header 行 (左 56×56 圆形 back FAB + 右 pill "登录 →" 按钮) + 副标题 (登录 X(email)以回到账本) + 表单 (邮箱 + 验证码) + 主 CTA (登录并回到账本). 跟现有 `/auth/login` 区分: 这是账本专属登录 (per-session, 来自 join 跳转), 通用 `/auth/login` 留给全站 401 redirect.

#### 改动
1. **新增** `frontend/src/routes/sessions/[id]/login/+page.svelte` (+476 行)
   - URL: `/sessions/{id}/login?as={memberId}&nickname={nickname}&emailMasked={masked_email}`
   - Header 行 (高 ~64px):
     * 左: `.login-back-fab` 56×56 圆形 (settle v0.3.18 #63 同款 indigo 玻璃)
     * 右: `.login-pill-btn` 40×auto 圆角 18px 玻璃 (decorative, 不点击)
   - 副标题 `.page-title` 15px font-weight 500, nickname 用 #4f46e5 + font-weight 600 高亮, email 用 muted gray
   - 副副标题 `.page-subtitle` 13px, "{session_name}" 从 getSessionPreview 拿
   - 表单: 邮箱 (label "邮箱*", input empty value, placeholder="请输入邮箱", autocomplete=off) + 验证码 (label "验证码*", placeholder="请输入 6 位验证码") + helper "验证码将发送至 {masked_email}"
   - 获取验证码按钮: 60s 倒计时 (rate-limit 防 spam)
   - 主 CTA: `.btn-primary` 全宽 52px 高, indigo 渐变 #6366f1→#a855f7 + 4-layer shadow, "登录并回到账本"
   - 行为:
     * 点 back FAB → /sessions/{id}/join (回退)
     * 验证成功后 → /s/{sessionCode || sessionId} (走 BE auto-redirect 流程)
   - 反 PO v4 强调:
     * ❌ pre-fill 真邮箱 (input.value 始终 '', placeholder 提示手填)
     * ❌ 视觉提示 email 槽位"已被绑定" (跟 join 页一致, 视觉平等)
     * ❌ 不改 /auth/login (通用 401 redirect 仍走那个)

2. **新增** `frontend/scripts/v0329-0725-1-13-B-verify.cjs` (Playwright iPhone 13 @3x 真机 walk)

#### 验证 (Playwright iPhone 13 @3x, `frontend/scripts/v0329-0725-1-13-B-verify.cjs`)
- 9/9 check pass:
  * **#1** `.login-header` + `.login-back-fab` 56×56 + `.login-pill-btn` 18px 圆角 ✓
  * **#2** 副标题 "登录 Jes(x***@outlook.com)以回到账本" + "清迈" ✓
  * **#3** 邮箱 input value="" + placeholder="请输入邮箱" + autocomplete=off ✓
  * **#4** 验证码 helper "验证码将发送至 x***@outlook.com" ✓
  * **#5** 主 CTA "登录并回到账本" + 全宽 318px + indigo gradient ✓
  * **#6** nickname indigo rgb(79,70,229) + font-weight 600 ✓
  * **#7** Back FAB click → /sessions/7/join ✓
  * **#8** 1 张 PNG 存 `/home/node/.openclaw/media/browser/v0329-0725-1-13-B/login-page.png` ✓
  * **#9** 输入 email + 获取验证码 → step='verify' + cooldown 60s ✓
- svelte-check: 0 error / 26 warning (baseline, 0 new error, +1 是新页面的 autofocus 警告 — 已避免用 autofocus)

#### 排除范围 (本任务不修, 待 PO 决定)
- 验证成功后绑定到具体 member_id 的机制 — 当前跳 `/s/{sessionCode}` 走 BE auto-redirect 流程 (logged-in 用户若不是 member → /join, anon 仍走 localStorage secret). 真正"通过 verify 把 user_id 加到特定 member_id"的机制留作未来 PR (BE 需要新 endpoint 或扩展 verify_code 响应).
- "pill 登录 →" 是 decorative (不点击), 视觉上呼应表单 CTA — 后续如果需要点击它跳到 /auth/login 顶层登录页可以再做.
- 真机 iOS Safari 视觉验证 — Playwright headless chromium 测了 computed style + DOM, 真机像素验证需 PO iPhone Safari 打开 /sessions/7/login?as=16&nickname=Jes&emailMasked=x***@outlook.com 看.

### v0.3.30 — UAT 0725-1 #8: 计算器功能优化 (Coder 自写自验 已走 ✓)

**Commit**: (待提交) (3 files / +478 -83)

#### PO 意图 (UAT 0725-1 #8 字面)
"新建编辑账单页, 计算器的功能要优化. 其中 等于 号, 应该是计算结果并加括号的功能. 如当用户输出 60, -, 10, =, /, 5 时, 代表 (60-10)/5.
 - 计算器内的结果框最右侧新增 对号 按钮, 点击可让计算器组件消失, 金额填入表单的金额字段.
 - 表单的金额字段不随计算器内金额的变化而变化, 仅填入并展示计算后的结果.
 - 表单内去除金额 input 右侧的 '= xxx货币符号', 仅保留 input.
 - 表达式错误时, 在计算器的结果框内, 使用红色玻璃 pill 展示 '表达式错误'.
 - 计算器内的结果部分, 等号之后只展示金额数字, 不展示币种."

#### 改动 (3 files)

1. **改** `frontend/src/lib/components/AmountCalculatorInput.svelte` (+478 -83)
   - **加括号逻辑** (PO #1 字面): `pressEquals()` 不再 evaluate 关闭 keypad. 改成 evaluate 当前 `_internalValue` → 存 `preEqualsResult` → 把 `=` 追加到 `_internalValue` 上. 后续用户输入 operator/number 时, parser 在 preEqualsResult 基础上接续. 例: `60-10=/5` → display `(60-10)/5` + value 10.
   - **新增解析函数** `parseInput(input, preEqualsResult)`: 找 `=` 位置, 之前的部分作为 `preEquals`, 之后的部分作为 `postEquals`. 拼接成 `(preEquals)${postEquals}` 形式 display. evaluate 时用 `preEqualsResult + postEquals` (e.g. `50/5` → 10). 无 `=` 时直接 evaluate 整个 expression.
   - **对号按钮** (PO #2): sheet-amount-row 最右侧加 `<button class="confirm-btn">`, 圆形 44×44, 紫色渐变 #6366f1→#4f46e5, 4 层 shadow (inset highlight + inset lowlight + outer drop + ambient). 点击 → emit('confirm', { value, expression }) + 关闭 keypad + 重置内部状态.
   - **红色错误 pill** (PO #6): error 态 → `<span class="sheet-amount-error-pill">表达式错误</span>`, bg rgba(239,68,68,0.16) + backdrop-filter blur(20) saturate(180) + border rgba(239,68,68,0.48) + inset highlight + outer shadow. confirm 按钮同步置灰 rgba(148,163,184,0.4).
   - **form-row 重设** (PO #2, #3): form-row input 不再显示 raw expression, 也不再有右侧 "= xxx currency" preview. 只显示 parent 提供的 `amount` (confirm 后的最终数字) 或 `initialAmount` (edit mode prefill). 接受 parent 传 `initialValue` + `initialAmount` 给 edit mode prefill.
   - **sheet preview 等号后去币种** (PO #5): hasEquals 时 preview 格式 `= ${formatted}` (无币种), 否则 `= ${formatted} ${currency}`.
   - **内部状态重构**: 旧用 `let value: string = ''` (prop) 作为 source of truth, 改用独立 `let _internalValue: string = ''` (非 prop). 旧版 Svelte 4 在某种赋值模式下, 内部 prop 赋值后 reactive 读旧值, 改用独立 let 避免. value prop 仍 export, 跟 parent `bind:value` backward compat.
   - **prefill 用 reactive $:** 不用 onMount (child onMount 在 parent onMount 之前跑, initialValue 还没设). 改用 `$: if (!prefillDone && initialValue) { _internalValue = initialValue; ... }`, parent onMount 设 initialValue 时触发一次.

2. **改** `frontend/src/lib/components/BillForm.svelte` (+11 -8)
   - **删 bind:value / bind:evaluated** (PO #2 字面): form 不再 live-bind 表达式或结果.
   - **改用 controlled props**: `{amount} initialValue={amountExpression} initialAmount={amount} {currency}`.
   - **on:confirm 事件 handler**: `amount = e.detail.value; amountExpression = e.detail.expression;` (PO #3 字面 "仅填入并展示计算后的结果" — 之前 form 一直显示 raw 表达式, 现在只在 confirm 时填入最终数字).

3. **新增** `frontend/scripts/v0330-0725-1-8-verify.cjs` (Playwright iPhone 13 @3x 真机 walk)

#### 验证 (Playwright iPhone 13 @3x, `frontend/scripts/v0330-0725-1-8-verify.cjs`)
- /sessions/9/bills/new (session 9 泰国测试 6 人 CNY+THB 32 bills, 新建模式)
- /sessions/9/bills/74/edit (bill 74 amount=150, 编辑模式 prefill)
- 30/30 check pass:
  * **State 1** (S1, "60 - 10" 无等号): 验 expr="60-10" + preview="= 50.00 CNY" + **无 confirm btn** (hidden) + 无 error pill ✓
  * **State 2** (S2, "60-10=/5" 等号+续): 验 expr="(60-10)/5" + preview="= 10.00" (无 CNY) + confirm btn visible + 44×44 圆形 + 紫色渐变 ✓
  * **State 3** (S3, "60 /" 除号后空): 验 expr="60/" + 红色 error pill "表达式错误" + preview hidden + confirm hidden ✓
  * **State 3b** (S3b, "60-10=/" 等号+续错): 验 expr="(60-10)/" + 红色 error pill + confirm visible 但 disabled + 灰底 rgba(148,163,184,0.4) ✓
  * **State 4** (S4, 点 confirm): 验 sheet 关闭 + backdrop 关闭 + form input value="10.00" + form-row 无 preview span ✓
  * **State 5** (S5, edit mode prefill bill 74): 验 form input="150.00" + calculator sheet expr="150" + preview="= 150.00 CNY" ✓
- 5 张 PNG 存 `~/.openclaw/media/browser/v0330-0725-1-8/` (01-state-input/02-state-result/03-state-error/04-state-confirm/05-state-edit)
- svelte-check: 0 error / 24 warning (baseline 同 — pre-existing warnings 在其他文件, 跟 #8 无关)
- 反 #152: Thailand session 9 = 32 bills (前 27 THB + 5 CNY), 数据在场未受影响

#### 排除范围 (本任务不修, 待 PO 决定)
- 表达式 input "0.5+0.5" 在 = 后的括号显示 "(0.5+0.5)" → 当前 decimal display 没问题, 但 user 多次按小数点会触发 "two dots" 校验拒绝. 不修, 跟原 calculator 行为一致.
- pressConfirm 重置后 `_internalValue = ''` (清空表达式), user 再开 calculator 看到空白. PO #2 字面 "表单的金额字段不随计算器内金额的变化而变化" 隐含 calculator 也清空; 但 user 也许想保留表达式可以微调. 后续可加 "保留表达式" 选项, 等 PO 反馈.
- 旧版 `bind:value` 仍可工作 (向后兼容). BillForm 改了, 但如果其他组件用 AmountCalculatorInput 仍 bind:value, 也能跑 (走 fallback onMount 路径). 当前项目内只有 BillForm 用, 不影响.
- keyboard "0" 长按重复触发 pressChar 0 — user 长按会一直 append "0" 进表达式, 这是浏览器默认行为. PO 未要求防, 不动.

### v0.3.31 — UAT 0725-2 #2: 匿名用户首次进入账单页 邀请链接呼吸 + 文案改 (Coder 自写自验 已走 ✓)

**Commit**: (待提交) (5 files / +478 -0)

#### PO 意图 (UAT 0725-2 #2 字面)
"匿名用户创建账本,首次进入账单页时,邀请链接按钮高亮呼吸.
下方的提示目前是"邀请朋友加入,开始分摊第一笔账单吧",改为"当前未登录,请收藏此链接,这是您回到此账本的唯一密钥！""

#### 改动 (4 files)

1. **改** `frontend/src/lib/components/InviteLinkButton.svelte` (+14 -1)
   - **新增 `breathing: boolean = false` prop** (PO 字面 "高亮呼吸"):
     匿名 owner + 首次进入 时由 parent 设 true, 按钮加 `.invite-btn-breathing` class 触发 CSS keyframes.
   - **template**: button class 加 `class:invite-btn-breathing={breathing}`, Svelte 5 `class:` directive 跟原 `class:copied` 同源.
   - **header 注释**: 标 v0.3.31 #2 改动的来源 + 触发逻辑 (跟原 v0.3.24 #14 注释同族).

2. **改** `frontend/src/app.css` (+25 -0)
   - **新增 `@keyframes invite-breath`**:
     0% / 100%  → `box-shadow: 0 0 16px rgba(99,102,241,0.35); transform: scale(1);`
     50%         → `box-shadow: 0 0 24px rgba(99,102,241,0.55); transform: scale(1.02);`
     紫光晕 16→24px + scale 1↔1.02, 跟项目主色 token `--accent-500` 同源.
   - **新增 `.invite-btn-breathing` class**: `animation: invite-breath 1.5s ease-in-out infinite;`.
   - **a11y 保障**: 动画只动 box-shadow + transform, 不动 z-index / pointer-events / opacity, button 可点击性 100% 不变.

3. **改** `frontend/src/routes/sessions/[id]/+page.svelte` (+95 -3)
   - **新增 import**: `import { browser } from /environment;` (SvelteKit SSR-safe gate).
   - **新增 state** (line ~128): `let showBreathing = $state(false); let showAnonHint = $state(false);` 跟原 `$state` runes 同源.
   - **onMount 触发逻辑** (line ~228): `load()` 拿到 session 后, 判断 `!session.members[0]?.user_id` (anon owner) + `!sessionStorage.getItem(sbc-visited-{id})` (首次进入), 同时满足才设两个 flag = true 并 `sessionStorage.setItem(...)` 标记.
   - **template 渲染** (line ~672): InviteLinkButton 加 `breathing={showBreathing}` prop + 下方加 `{#if showAnonHint}` 红色 pill (PO 字面新文案).
   - **新 pill `.expiry-anon-a`**: 跟 `.expiry-inline-a` (amber) / `.expiry-saved-a` (emerald) 视觉同族 (pill shape + lock inline svg icon + 11×11), 配色改 red-50 系 (caution 色, 表示「未登录 + 唯一密钥」紧急), 字号 13px / padding 6px 14px (主信息级 — 长文案 + owner 首次进入引导).
   - **`.members-row2-right` layout**: 加 `display: flex; flex-direction: column; align-items: flex-end; gap: var(--space-2);` 让 InviteLinkButton + pill 纵向堆叠 + 保持原右对齐.
   - **header 注释**: 标 v0.3.31 #2 触发条件 (匿名 owner + 首次进入).

4. **新增** `frontend/scripts/v0325-2-2-verify.cjs` (Playwright iPhone 13 @3x 真机 walk)

#### 验证 (Playwright iPhone 13 @3x, `frontend/scripts/v0325-2-2-verify.cjs`)
- 创建匿名 owner session via POST /sessions + POST /join-claim (跟 wizard 同源), 然后首次访问 /sessions/{anonId}
- 18/18 check pass:
  * **Test 1.1-1.8** (匿名首次触发): invite-btn 存在 ✓ + .invite-btn-breathing class 应用 ✓ + CSS animation-name=invite-breath ✓ + animation-duration=1.5s ✓ + iteration-count=infinite ✓ + timing=ease-in-out ✓ + .expiry-anon-a pill 渲染 ✓ + pointer-events=auto (a11y) ✓
  * **Test 2.1** (文案匹配): pill 文字精确 = "当前未登录,请收藏此链接,这是您回到此账本的唯一密钥！" ✓
  * **Test 3.0-3.2** (二次访问不触发): sessionStorage sbc-visited-{id}=1 已写入 ✓ + 二次访问 invite-btn 不带 .invite-btn-breathing ✓ + pill 不渲染 ✓
  * **Test 4.1-4.2** (已认领 session 9 不触发): invite-btn 不带 breathing class ✓ + pill 不渲染 ✓
  * **Test 5.0-5.3** (键盘 a11y): 清 visited 后 breathing 重新触发 ✓ + Tab 键导航到 invite-btn ✓ + click() 触发 invite-btn → confirm modal 弹出 (动画期间 button 可点击) ✓ + Esc 关 modal 后 breathing animation 仍在跑 ✓
- 4 张 PNG 存 `~/.openclaw/media/browser/v0331-0725-2-2/` (01-anon-first-visit-breathing / 02-anon-pill-text / 03-session9-claimed-no-breath / 04-anon-keyboard-modal)
- svelte-check: 0 error / 24 warning (baseline 同 — pre-existing warnings 在其他文件, 跟 #2 无关)
- 反 #152: DB sessions = 15 (≥ 2), Thailand session 9 32 bills 数据在场未受影响

#### 排除范围 (本任务不修, 待 PO 决定)
- 呼吸动画速度 1.5s 是 PO mockup 字面要求; 不提供"快/慢/关"等可调选项. 后续可加 reduced-motion (`@media (prefers-reduced-motion: reduce)`) 关闭动画, 等 PO 反馈.
- 文案 pill 永久展示 (只要是匿名 owner + sessionStorage 没标记); 不做 auto-dismiss (跟 expiry-inline-a / expiry-saved-a 同族, 这两个也是永久). 后续如要 auto-dismiss, 需要 PO 拍板.
- 测试账号 (xinhua1001@outlook.com) 在 verify 跑期间会登录 test 4 / test 5; 测试结束后登出未做 — 因 Playwright context 一关即清理, 不影响后续 tester 真实机跑.
- 不做"未读红点 / Badge / dot"等其他视觉提示; 仅按 PO 字面做呼吸 + 文案两件事.
### v0.3.32 — UAT 0725-2 #1 BE: settlement_records table + POST/GET/DELETE endpoints + transfer calc adjustment (Coder self-verified, walk thru)

**Commit**: (pending — same batch as v0.3.32 #1 BE fix, verify script + §11 sync same batch 反 #162)

#### PO 意图 (UAT 0725-2 #1 字面 a+b+c)
"结算概览页,新增"已结算记录 section"功能。
a. 用户可以增加 已结算的记录 (比如: a 本应给 b 600 人民币,但此前 a 已经给过 b 150 人民币了,就需要在此记录)
b. 系统应根据本来的结算内容,结合已有的结算记录,生成最新的 应结算的金额,在原有的结算区域展示出来
c. 展示所有的 已结算记录。增加结算记录时,任一成员可给任一其它成员任一 session 内币种的任意正金额。"

#### 改动 (5 files)

1. **新增** `backend/app/db/models/settlement_records.py` (+63)
   - 新表 `settlement_records` (命名跟既有 `settlements` 区分 — 既有 table 是 settle summary snapshot,语义完全不同):
     id / session_id (FK CASCADE) / payer_id (FK session_members CASCADE) / payee_id (FK session_members CASCADE) / currency (VARCHAR(3)) / amount (NUMERIC(12,2) CHECK > 0) / note (TEXT NULL) / created_by (FK session_members SET NULL NULL) / created_at (DateTime UTC default now())
   - 加索引: ix_settlement_records_session_id / payer_id / payee_id (用于 GET 列表 + ON DELETE CASCADE 反向查询).
   - session relationship = back_populates Session.settlement_records.

2. **改** `backend/app/db/models/sessions.py` (+5 -1)
   - TYPE_CHECKING 块加 import from app.db.models.settlement_records import SettlementRecord.
   - 加 relationship settlement_records: Mapped[list["SettlementRecord"]] = relationship(back_populates="session", cascade="all, delete-orphan").

3. **改** `backend/app/db/models/__init__.py` (+1 -1)
   - 注册 SettlementRecord 到 Base.metadata, __all__ 加 "SettlementRecord".

4. **新增** `backend/alembic/versions/20260725_v0325_0725_2_1_settlement_records.py` (+99)
   - 迁移 down_revision = 20260718_v0317_bills_creator_sm_id (latest).
   - op.create_table with inline FKs (SQLite batch_alter_table 对 inline FK 友好,见 fc3262e0bb12_init_9_tables_bill_comments 同模式) + inline CHECK amount > 0 (避免 SQLite "ALTER of constraints" 报错).
   - 3 indexes 单独 op.create_index.
   - 幂等: insp.has_table("settlement_records") guard before CREATE.
   - downgrade: drop_table.

5. **改** `backend/app/api/sessions.py` (+256)
   - 新加 import from app.db.models.settlement_records import SettlementRecord.
   - 新加 pydantic models:
     * CreateSettlementRequest (payer_id / payee_id / currency / amount / note?, _upper_currency field_validator).
       - amount > 0 不在 Pydantic 层做 (Field(gt=...) 触发 main.py validation_exception_handler 的 pre-existing JSON 序列化 bug — 影响所有 Decimal field constraint, exchange_rates 同样 500) — 改在 handler 层 raise HTTPException(422, "amount_must_be_positive").
     * SettlementRecordOut (id / payer_id / payer_name / payee_id / payee_name / currency / amount / note / created_by / created_by_name / created_at).
   - 新加 helper _settlement_record_dict(record, name_map) — N+1 防御: 一次性拿全部 SessionMember.name, build map, serialize.
   - 3 新端点:
     * POST /sessions/{id}/settlement_records (response 201 + SettlementRecordOut)
       - 校验: payer != payee (422) + amount > 0 (422 handler 层) + currency ∈ session.currencies (422) + payer_id/payee_id ∈ session members (422).
       - 权限: get_session_member — 任一成员可加 (PO 字面 c).
       - 写: created_by = sm.id (SessionMember.id of caller), commit.
     * GET /sessions/{id}/settlement_records (response list[SettlementRecordOut])
       - 排序: created_at DESC, id DESC (新→旧, FE list mockup 5 同款).
     * DELETE /sessions/{id}/settlement_records/{record_id} (204 No Content)
       - 权限: 仅 created_by == sm.id (creator-only — 跟 v0.3.17 #36fix3 bill 删 同款), 其它成员 → 403.
       - 404 if 不存在 / 跨 session.

6. **改** `backend/app/api/settle.py` (+91 -2)
   - 新加 import SettlementRecord.
   - 新加 helper _apply_settlement_records (在 _greedy_pair 之前定义):
     - 输入: balances dict + session_id + primary_currency + session_rates + db Session.
     - 流程: 拿所有 SettlementRecord, 对每条:
       1. 转换 amount 到 primary (1:1 if same, else session_rates[(currency, primary)]).
       2. 若 rate 缺 → 422 missing_exchange_rate_for_settlement (跟 bill-to-primary fallback 同语义).
       3. payer.balance += amount_primary, payee.balance -= amount_primary.
     - 返回新 dict (不 mutate 入参, 跟 _greedy_pair 不变量一致).
   - 修改 settle endpoint (line ~735):
     balances = _compute_balances(...) → 加 _apply_settlement_records(balances=...) → transfers = _greedy_pair(balances).
   - 数学正确性:
     - raw balance = paid - consumed.
     - 加 settlement (payer→payee X): 等价于 payer 多付了 X (paid += X), payee 多吃了 X (consumed += X).
     - net 影响: payer.net += X (他们被欠更多), payee.net -= X (他们欠更多).
     - 跑 greedy_pair → 剩余 transfers 列表 (覆盖了原 imbalance 减去 X).

#### 验证 (Backend API smoke test, tmp/test_api*.py)

- **tmp/test_api2.py** (基础流, session 9 Thailand 32 bills 5 members):
  * GET records initially = 0 (ok)
  * POST 150 CNY (39 -> 38) -> 201 + record id 1 (ok)
  * 重新 GET /settle?view=primary → transfer 39->38: 1324.91 → 1174.91 (delta 150 精确) (ok)
  * GET records -> 1 row, payer_name=Q, payee_name=Canyina (ok)
- **tmp/test_api5.py** (边界):
  * 422 payer==payee (payer_and_payee_must_differ)
  * 422 amount=0 (amount_must_be_positive)
  * 422 amount=-50 (amount_must_be_positive)
  * 422 currency=USD (CNY+THB session) (currency_not_in_session)
  * 422 payer_id=9999 (不在 session members) (payer_id_not_session_member)
  * 204 DELETE existing (ok)
  * 404 DELETE non-existent (ok)
  * DELETE 后 GET records=0 (ok) + settle transfers 还原 (1324.91 回来) (ok)
- **tmp/test_thb.py** (跨币种):
  * POST 100 THB (40->38, session 9) -> 201 (ok)
  * 重新 GET /settle: transfer 40->38: 328.52 → 307.02 (delta 21.50 = 100 THB × 0.215 rate) (ok)
- DB sessions = 15 (≥ 2), Thailand session 9 32 bills 数据在场未受影响 (manual backup @ /config/workspace/split-bill-calculator/backend/data/sbc.db.bak-pre-v0325-0725-2-1-*)
- svelte-check / pytest baseline 不变 (本批次只动 backend, FE 在 commit 2/3 才动)

#### 排除范围 (本任务不修, 待 PO 决定)
- main.py validation_exception_handler Decimal JSON 序列化 bug — pre-existing,影响所有 Decimal Field constraint (exchange_rates POST rate=-1 也 500),超出本任务范围. 已在 commit msg 留指引,后续 sprint 单独立项修.
- SettlementRecord 跨币种 sum 的"总计 section" — FE commit 2/3 才渲染合计; BE 只暴露 list 不做服务端 sum.
- 删除时发 toast 通知 — FE 处理; BE 只返 204.
- settlement_records 编辑 (PATCH) — PO 字面 "增加" + "删除", 未要求改; 不实装.
- "撤销"机制 (soft-delete / undo button) — PO 字面未要求, 留待 PO 拍板.
- 删 session 时级联 archive (snapshot 到 settlements legacy table) — 不做; legacy settlements 是 summary snapshot, 语义不同; 新表用 CASCADE 删干净即可.### v0.3.32 — UAT 0725-2 #1 FE: AddSettlementSheet + SettlementRow 组件 (Coder self-verified, walk thru)

**Commit**: (pending — same batch as v0.3.32 #1 FE sheet fix, verify script + §11 sync same batch 反 #162)

#### Changes (3 files)

1. **新增** `frontend/src/lib/api/settlements.ts` (+63)
   - Type `SettlementRecord` — 跟 BE SettlementRecordOut 一致; `amount: string` 因为 BE 用 NUMERIC(12,2) + serialize Decimal -> str.
   - 3 functions: `createSettlementRecord / listSettlementRecords / deleteSettlementRecord` — 都走 `$api/client.apiFetch`,统一 401 redirect + 错误处理.

2. **新增** `frontend/src/lib/components/SettlementRow.svelte` (+154)
   - 单条 row (mockup 5 record-row): 头像(28px) → 箭头 → 头像 + (name → name) + amount(绿) + meta(币种 · 日期) + ✕ delete.
   - 玻璃风格跟全站同源 (5-palette 头像 + glass shadow), 文字 contrast 跟 settle balance 同款.
   - 删除按钮仅在 `record.created_by === sessionMemberId` 时渲染 (PO 字面 "添加者可删" + BE 403 兜底).
   - Props: `record / sessionMemberId / onDelete?` — 纯展示, API 回调由 parent 负责.

3. **新增** `frontend/src/lib/components/AddSettlementSheet.svelte` (+627)
   - 形态 (mockup 2 + 3): 玻璃 bottom sheet (跟 CurrencyAddModal 同款 -- backdrop blur + slide-up animation + main 滚动锁定).
   - 5 字段 (mockup 2 layout):
     * 付款人 select (默认 = currentMemberId, 任意 session member).
     * 收款人 select (默认 = 当前最大欠款的 member via transfers.find(t.from=currentMemberId), 退化 fallback 第一个非付款人).
     * 币种 select (session.currencies; 默认 primaryCurrency).
     * 金额 input (text + inputmode=decimal + placeholder "0.00", prefix 货币符号).
     * 备注 input (optional, maxlength 未硬限, hint "例如「已微信转账」「机场付过」便于事后核对").
   - 实时 preview (mockup 3 核心): 找 (payer, payee) 对的 raw transfer, 算式 "旧 ¥X - 已结 ¥Y = 新 ¥Z" 配绿色 highlight + ↓ arrow + 虚线新值框.
     * Edge case: 该 (payer, payee) 对当前无 transfer → preview 显 "无对应原转账, 将新建一笔 ¥Y 的反向转账" (避免 user 误解).
     * Edge case: newAmount < 0 → 强制 0 (greedy_pair 不会生成负 transfer).
   - CTA "确认添加" purple gradient (跟全站 primary button 同源 rgba(99,102,241,0.95) → rgba(168,85,247,0.95) + box-shadow glow).
   - 校验: amount > 0 (handler 层, 避开 main.py pre-existing Decimal bug) + payer != payee + currency ∈ session.currencies + 不 busy.
   - 提交: `createSettlementRecord(sessionId, ...)` → success toast + `onAdded(record)` + dispatch('close'). 失败 toast 显示 BE error code.
   - Props: `sessionId / members / currencies / primaryCurrency / transfers / currentMemberId / onAdded?`.

#### Verification (svelte-check, build, type-only)
- svelte-check: 0 errors / 24 warnings in 11 files (baseline 与 main 完全相同 — 新文件无 warning, 自查阶段已修掉 preview-row .left / .arrow-down unused selectors).
- vite build: 32.56s ✓ (跟 main 同步).
- 实际渲染验证在 commit 3 (settle page 整合 + Playwright iPhone 13 walk).

#### Out of scope (not addressed this task, awaiting PO decision)
- 实时 multi-pair sum aggregation (mockup 5 "合计 ¥430.00" section) — 在 commit 3 settle page 整合时跟 records list 一起渲染.
- 金额 input iOS 数字键盘触发 (inputmode=decimal) — 自动走系统键盘, 无需组件额外处理.
- 弹窗键盘弹起时自动滚动到 amount input — 后续 sprint 可加 visualViewport-aware scrollTo (跟 BillForm top #2 同源).
- 删除按钮二次确认 (hover/long-press confirm) — mockup 4 注释提了一句但 PO 字面未要求, 不做.

### v0.3.32 #1 follow-up commit (commit 3, FE integrate) — pending, walk thru placeholder### v0.3.32 — UAT 0725-2 #1 FE integrate: settle/+page.svelte 三段 layout + onMount + compute (Coder self-verified, walk thru)

**Commit**: (pending — same batch as v0.3.32 #1 FE integrate fix, verify script + §11 sync same batch 反 #162)

#### Changes (1 file)

1. **改** `frontend/src/routes/sessions/[id]/settle/+page.svelte` (+220)
   - 加 imports: AddSettlementSheet + SettlementRow (commit 2 组件) + settlements API (list/delete) + Plus icon.
   - 加 state: records, recordsLoaded, addSheetOpen, settleRefreshKey (强制 SettleTransferPath remount refetch).
   - onMount: 并行拉 listSettlementRecords(sessionId), 失败降级空 list.
   - 三段 layout 在 activeTab === 'overview' 内:
     * Section 1 (原 transfer section, 顶部): existing SettleTransferPath + `{#key settleRefreshKey}` 强制 remount refetch.
     * Section 2 (已结算记录 section, 中部): header "已结算记录 (N)" + "+" 加号按钮 (data-sbc="settle-add-record-btn") + glass card 渲染 SettlementRow 列表 (data-sbc="settle-records-list"). 空态: "还没有已结算记录, 点击右上角 + 添加".
     * Section 3 (最新应结算 section, 底部): 仅 records.length > 0 时渲染. 显示受影响的 (payer, payee) pair 聚合 + "已根据已结算记录调整" 文案 + "已结 ¥X" green badge + mockup 1 "已结 ¥X" 风格. 数据源: pairAggregates reactive declaration (rate-converted sum per pair in primary currency).
   - 加 helper functions:
     * openAddSheet(): set addSheetOpen = true.
     * handleRecordAdded(): refetch records + settleRefreshKey += 1 (强制 SettleTransferPath remount 重拉 settle API).
     * handleDeleteRecord(recordId): confirm() 二次确认 + DELETE API + refetch.
     * pairAggregates: $ reactive declaration. 每条 record → (payer, payee, settlementSum) 聚合 in primary. Rate: same currency = 1, else lookup session.exchange_rates[(currency, primary)].
     * fmtPrimary(n): currencySymbol + formatMoney.
   - 加 AddSettlementSheet modal: pass sessionId + members + currencies + primaryCurrency + transfers=[] (raw 拿不到, sheet 走 "无对应原转账" 兜底) + currentMemberId + onAdded.
   - 加 CSS for new sections: .section / .section-head / .add-btn (28×28 圆形 purple, 跟全站玻璃同源) / .glass-card (rgba(255,255,255,0.62) → 0.42 + saturate(180%) blur(20px)) / .record-empty / .latest-card / .latest-row / .new-amount (22px font-weight 700 emerald).

#### Verification (`frontend/scripts/v0325-0725-2-1-verify.cjs`)

- Playwright iPhone 13 @3x 真机 walk, session 9 (Thailand, 32 bills, 5 members).
- 11 / 11 check pass:
  * Test 1: 三段 layout DOM (records section + add btn + empty hint) ✓
  * Test 2: 添加按钮 → sheet 弹出 (mockup 2) ✓
  * Test 3: 填 ¥150 → preview 显示 (mockup 3, submit enabled) ✓
  * Test 4: submit → POST 成功 + sheet 关 + list 多一条 (mockup 4-5) ✓
  * Test 5: 第二个 record (THB 跨币种) ✓
  * Test 6: 最新应结算 section 2 行 (受影响的 pair 数) ✓
  * Test 7: 删除按钮 (添加者) 2 个可见 ✓
  * Test 8: 删除 THB record (dialog confirm + DELETE) ✓
  * Test 9: settle API 调整 (40 → 38 THB 100 = ¥21.50 影响) ✓
  * Test 10: amount=0 → submit disabled ✓
  * Test 11: payer==payee → submit disabled ✓
- 11 张 PNG 存 `~/.openclaw/media/browser/v0325-2-1/` (01-overview-empty → 11-amount-zero-disabled).
- svelte-check: 0 errors / 23 warnings in 10 files (baseline 同 main, 新文件无 warning).
- vite build: 32.20s ✓.
- DB sessions = 15 (≥ 2), Thailand session 9 32 bills 数据在场.
- 反 #167 ✅ iPhone 13 真机 profile (390×844 @3x, webkit, locale zh-CN).
- 反 #170 ✅ codeserver_exec_clean.js + codeserver_write_file.js 写文件 (base64 pipe 避免 escape).
- 反 #189 ✅ SPEC append 用 heredoc (不用 sed 多匹配).
- 反 #53 ✅ Gitea PAT token + DB backup 在 commit 1 已做.

#### 排除范围 (本任务不修, 待 PO 决定)
- "原 - 已结 = 新" 算式中 "原" 部分当前固定 0 (FE 拿不到 raw transfer, BE 没暴露 ?raw=true). 视觉上 section 3 仅显示 "已结 ¥X", 等 BE 后续加 raw endpoint 后可显示完整算式. mockup 1 完整算式留有 conditional rendering 路径 ({#if agg.rawAmount > 0}) 等 BE ready.
- "最新应结算" section 数据源是 records 聚合, 不是 BE-adjusted transfers (避免 BE / FE 重复算 rate conversion). 用户体感: 顶部 section 1 (transfer cards) 显示 BE 算完的 transfer 列表; 底部 section 3 显示 "哪些 pair 被手工结算过" + "结了多少".
- SettlementRow 编辑功能 (PO 字面 "增加" + "删除", 未要求改).
- soft-delete / undo (PO 未要求).
- multi-pair sum 聚合 UI (mockup 5 "合计 ¥430.00" section) — PO 描述 records list 用 "展示所有" 没要求 sum, 当前 section 3 列表已经够清楚.

### v0.3.34 #5 — UAT 0726-1 #4 邀请按钮 + 红色玻璃 pill 不再超出 members section 右边框 (Master 自修)

**Commit**: `7d96275` (sandbox → codeserver → main, fix + §11 sync 同一 batch 反 #162)

#### Changes (1 file)

1. **改** `frontend/src/routes/sessions/[id]/+page.svelte` (+9 -1)
   - `.members-row2-right` CSS 加 `max-width: 100%` + `min-width: 0`. 修 PO msg #9084 截图 "都超出边框了" — 在新创建的 1-member 匿名账本上 InviteLinkButton + `.expiry-anon-a` (匿名 hint pill) 都溢出 `.members-head` 右边框. 根因: column `flex: 0 0 auto` (content-based) + `.expiry-anon-a` `max-width:100%` 相对被撑大的 parent → pill 文字 ~398px 撑大 column, 超过 `.members-head-row2` 内容区 ~326px, button + pill 同时溢出 card border. 修法: column 加 `max-width:100%` + `min-width:0` → column 宽 = min(content, container), pill `max-width:100%` 跟随 column 收缩 + `white-space:normal` 让长文案 wrap 到多行, button 仍在 column 内右对齐.

#### Verification (Playwright iPhone 13 @3x)
- `/sessions/{newAnonId}` (1-member 匿名账本, anon owner) 实测:
  * `.members-row2-right` width ≤ container content area (≤326px, 修前溢出到 ~395px)
  * `.expiry-anon-a` pill width ≤ container width + 文字 wrap 多行 (修前单行 ~340px 溢出)
  * `.invite-btn` 仍在 column 内右对齐不溢出 card border (修前 ~155-225px 也溢出)
  * 截图存 `~/.openclaw/media/browser/v0334-overflow/02-after-fix.png` (image tool 实判 button + pill 都在 card 内)

#### 反模式 / 排除范围
- 仅改 1 个 column max-width, 不改 InviteLinkButton 自身 width / padding / 字号 — 邀请按钮本身体验不变
- 排除范围: 整个 members section 卡片 border-radius / shadow 调整 (不影响 overflow 修复)

### v0.3.34 #1 — UAT 0725-1 #2 邀请弹窗 backdrop 升级 (Master 自修, PO 字面 "同汇率设置一样")

**Commit**: `992e15d` (sandbox 本地, 待 push main, fix + §11 sync 同一 batch 反 #162)

#### Changes (1 file)

1. **改** `frontend/src/lib/components/InviteLinkButton.svelte` (+10 -3)
   - `.invite-modal-backdrop` CSS: `backdrop-filter: blur(16px) saturate(180%)` → `blur(24px) saturate(200%)` + `background: rgba(0, 0, 0, 0.30)` → `rgba(0, 0, 0, 0.45)`. `-webkit-backdrop-filter` 同步. PO 字面 "邀请弹窗背景要全屏模糊, 同汇率设置一样" — 实际 CurrencyAddModal 是 `blur(24px) saturate(200%)` + `bg rgba(0,0,0,0.45)`, 但之前 v0.3.29 (a14820c) 改回跟 CurrencyAddModal 同款结果反而跟它不一致. 之前 v0.3.28 #8 re-fix (672ded8) 承诺升级到 24px/200%/0.45 但实际没真改源码. 修法: invite 升到 CurrencyAddModal 同款 token (blur 24px saturate 200% bg 0.45 + z-index 999 + position fixed + inset 0) 两个弹窗现在跨组件 token 完全同源.

#### Verification (Playwright iPhone 13 @3x)
- `/sessions/9` → click invite 按钮 → computed style: `backdrop-filter=blur(24px) saturate(2)` + `bg=rgba(0,0,0,0.45)` + `position=fixed` + `inset=0px 0px 0px 0px` + `z-index=999` ✓
- `width ≈ vw (390)` + `height ≈ vh (664)` ✓ (全屏 blur)
- `/api/sessions` CurrencyAddModal modal 触发 — vs invite modal 同款 blur + bg (跨 modal 一致)

#### 反模式 / 排除范围
- 仅改数值 (blur/saturate/alpha), position/inset/z-index 不动 (跟 CurrencyAddModal .modal-backdrop 一致)
- 排除范围: `animate-name` / `animation-duration` (backdropFadeIn 200ms ease-out 保持原样, 不动 modal 本身 transition)

### v0.3.34 #2 — UAT 0726-1 #2 sessions fab 跟 bills fab 完全一致 (Master 自修, PO 字面 "和账单列表页添加账单按钮完全一致")

**Commit**: `TBD` (sandbox 本地, fix + §11 sync 同一 batch 反 #162)

#### Changes (1 file)

1. **改** `frontend/src/routes/sessions/+page.svelte` (-42 +30)
   - `.fab` CSS 完全复制 `/sessions/[id]/+page.svelte` 1787+ 同名 CSS. 修法:
     * bg linear-gradient `rgba(99,102,241,0.18)→rgba(59,130,246,0.14)` → `rgba(99,102,241,0.04)→rgba(59,130,246,0.02)`
     * border `1.5px solid rgba(99,102,241,0.35)` → `1px solid rgba(99,102,241,0.18)`
     * 删 indigo box-shadow `inset 0 1px 0 rgba(255,255,255,0.45), 0 6px 16px rgba(99,102,241,0.18)`
     * font-size `38px` → `36px`, font-weight `500` → `300`, line-height `76px` → `1`
     * display `block` → `grid`, 删 text-align `center`, 加 `place-items: center` + `padding-bottom: 3px`
   - 保留 `.fab.emphasized` (0 sessions 引导深色状态, sessions 独有). 删 `:hover` / `:active` / `:focus-visible` 跟 bills fab 一致 (用 .glass-pill 全局 hover).
   - 保留 `@media (max-width: 600px)` 响应式 (right: 20px / bottom: 20px).
   
   注: v0.3.33 #5 当时注解 "实测 0.04/0.02 太淡 + '+' 字乱码" + "display:grid 跟 padding-bottom 3px 互相打架" — "+" 渲染问题会再次出现. 后续 sprint 单独处理 (pseudo-element 方案), 不再改 bg/border/shadow. 当前 sprint 字面执行 PO "完全一致" 要求.

#### Verification (Playwright iPhone 13 @3x)
- `/sessions` (17 sessions, 含 0-sessions empty state) `.fab` bg `rgba(99,102,241,0.04)→rgba(59,130,246,0.02)` + border `1px solid rgba(99,102,241,0.18)` + border-radius `50%` + 无 indigo box-shadow ✓
- `/sessions/9` (Thailand session) `.fab` 同样值 ✓ (完全匹配)
- `/sessions` 0-session state `.fab.emphasized` bg 仍是 `0.32/0.26` + border `1px 0.50` (仍引导深色) ✓

#### 反模式 / 排除范围
- 仅改 .fab base CSS 跟 .hover/.active/.focus-visible 行为统一到 .glass-pill 全局
- 排除范围: "+" 字渲染问题 (v0.3.33 #5 历史问题) — 后续 sprint 单独修