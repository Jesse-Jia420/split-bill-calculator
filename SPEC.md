# SPEC — split-bill-calculator

> 版本：v0.1-dev | 状态：🚧 5 决策点已拍 4，剩 §3.4.6 邮件服务 | 日期：2026-06-29
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
  id            INTEGER PK,
  name          TEXT NOT NULL,        -- 「2026年6月曼谷旅行」
  owner_user_id INTEGER NOT NULL,     -- 创建者
  created_at    TIMESTAMP NOT NULL,
  archived      BOOLEAN NOT NULL DEFAULT 0
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

-- 邀请链接（持久 token）
session_invites (
  id            INTEGER PK,
  session_id    INTEGER NOT NULL,
  token         TEXT UNIQUE NOT NULL,
  created_by    INTEGER NOT NULL,
  created_at    TIMESTAMP NOT NULL,
  revoked       BOOLEAN NOT NULL DEFAULT 0,
  max_uses      INTEGER,              -- NULL = 不限次数
  use_count     INTEGER NOT NULL DEFAULT 0
)

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

  POST   /api/sessions             创建（body: {name, email, display_name, code}）
  GET    /api/sessions             我的 session 列表
  GET    /api/sessions/{id}        session 详情 + 成员
  POST   /api/sessions/{id}/invites  生成邀请链接
  DELETE /api/sessions/{id}/invites/{iid}  撤销

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

## 8. 邮件服务（**待 §3.4.6 拍**）

- 推荐 Gmail SMTP（jessejia1001@gmail.com + App Password）
- 验证码模板：6 位数字 + 用途 + 过期时间
- 邮件发送走 FastAPI BackgroundTasks，不阻塞请求

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
| 2026-06-29 | v0.0 | 脚手架 |
| 2026-06-29 | v0.0 | 方向调整：纯 web + 多用户 + 多 session |
| 2026-06-29 | v0.1-dev | 5 决策点拍 4：技术栈 SvelteKit+FastAPI+SQLite / AI 仅输入端 / 轻量邮箱+验证码身份 / review 暂缓；细化核心模型 + API + 结算算法；剩 §3.4.6 邮件服务阻塞 |
