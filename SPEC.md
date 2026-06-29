# SPEC — split-bill-calculator

> 版本：v0.0 | 状态：🚧 方向调整中，等 Jesse 拍 5 个决策点 | 日期：2026-06-29
> 配套 PRD：/obsidian/Jesse OB VPS/JesseClaw/code-project/split-bill-calculator/PRD.md

---

## 1. 项目元信息

| 项 | 值 |
|---|---|
| 项目名 | split-bill-calculator（暂定） |
| 类型 | **多用户 + 多 session 纯 web 应用**（2026-06-29 方向调整） |
| 部署目标 | NAS Docker + Cloudflare Tunnel（推荐） |
| 许可证 | 待定 |

---

## 2. 目录结构（候选，等 §3.5 拍板）

```
split-bill-calculator/
├── SPEC.md          ← 本文件
├── README.md
├── src/             ← 源码
│   ├── routes/      ← 路由
│   ├── models/      ← 数据模型
│   ├── services/    ← 业务逻辑（含 AI 集成）
│   ├── ui/          ← 前端
│   └── auth/        ← 认证
├── tests/           ← 测试
├── migrations/      ← DB schema 迁移
├── scripts/
├── docker-compose.yml
└── docs/
```

---

## 3. 核心模型（v0.1 草图，等 §3.4 / §3.5 拍板）

```sql
-- 用户
users (id, email/phone?, display_name, password_hash, created_at)

-- session（一个记账本）
sessions (id, name, owner_id, created_at, archived)

-- session 成员（多对多）
session_members (session_id, user_id, role, joined_at)

-- 一笔消费
bills (id, session_id, payer_id, amount, currency, description,
       bill_type, occurred_at, created_by, created_at, status)
  -- bill_type: shared | exclusive | mixed
  -- status: draft | locked

-- 消费参与者（多对多）
bill_participants (bill_id, user_id, share_type)
  -- share_type: equal | weighted | exclusive

-- 评论 / 质疑
bill_comments (id, bill_id, user_id, content, created_at, resolved_at)

-- 结算快照
settlements (id, session_id, generated_at, summary_json)
```

---

## 4. API / 接口（候选，等 §3.4 拍板）

```
POST   /auth/register         注册（取决于 §3.4）
POST   /auth/login
POST   /auth/logout

GET    /sessions              我的 session 列表
POST   /sessions              新建
GET    /sessions/:id          session 详情
POST   /sessions/:id/invite   邀请成员（生成 share link）

GET    /sessions/:id/bills    账单列表
POST   /sessions/:id/bills    新增账单（含 AI 解析）
PATCH  /sessions/:id/bills/:bid
DELETE /sessions/:id/bills/:bid

POST   /sessions/:id/bills/parse  AI 自然语言解析
GET    /sessions/:id/bills/:bid/comments
POST   /sessions/:id/bills/:bid/comments

GET    /sessions/:id/settle   生成结算
GET    /sessions/:id/settle/export  导出（PDF/HTML/JSON）
```

---

## 5. session 隔离设计

**所有查询必须强制带 session_id 过滤** + **用户必须是 session 成员**（双重检查）。

中间件层 / 路由层 / ORM 层任何一处都不能漏。

---

## 6. AI 集成点（候选，等 §3.1 拍板）

- `POST /bills/parse` 接收自然语言 → 返回结构化 `{payer, amount, participants, bill_type, description}` → 用户在 UI 二次确认后落库
- `POST /settle/generate` 结算时调 AI 优化转账路径（减少转账笔数）或生成可读结算文案
- 补充端（v0.2）：review 时 AI 主动询问缺失项

AI 调用：MiniMax API（已有凭据）。

---

## 7. 测试策略

- 单元测试：models / 结算算法 / AI parse 解析（mock AI 响应）
- 集成测试：API 端到端 / session 隔离 / 权限
- E2E：浏览器跑核心流程（注册 → 建 session → 记一笔 → review → 结算）

---

## 8. 部署 & 运行（候选，等 §3.5 拍板）

- Docker 单容器：FastAPI + SvelteKit（或 Node）打成一个 image
- 数据卷：SQLite 文件 + 上传文件
- 端口：8000 / 3000
- 反向代理：Cloudflare Tunnel

---

## 9. 版本变更记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-06-29 | v0.0 | 脚手架 |
| 2026-06-29 | v0.0 | 方向调整：纯 web + 多用户 + 多 session；草图核心模型 + API 路由 + AI 集成点；等 §3.5 个决策点拍板 |
