# §3.11.11 真用户 walk 步骤 (Master 验收参考)

> **本文件不是测试代码** (本 Tester **不**写**真**用户 walk code, 反 #129 + #130).
> **本文件给 Master 真用户 walk 时**参考. Master 验收时按**这**些步骤**逐项走**.
>
> 来源:
> - PRD §3.11.11 (12 决策完整产品意图)
> - SPEC.md §8 (真用户 walk 场景 + Master 验收 checklist)
> - 反 #130: **不**绕过用户验收直接 done (本文件就是验收步骤的**汇**总)
> - 反 #132: Tester 必自己跑测试方案, **不**信 Coder "测试通过" → 本**真**用户 walk 是**最**终一道
>
> **前提** (Master 开始**前**确认):
> - Coder 已完成 `sbc_3_11_11_implement` 任务 (产品代码 + 5 错 commit revert + push main)
> - 本 Tester 已写完 `e2e/§3_11_11_wizard.spec.ts` 6 cases 并**通过** (Master **新** spawn 跑测试, 反 #132)
> - codeserver 容器内 FE + BE 都启动 (`localhost:8448` + `localhost:8449`)
> - Vite HMR 已 reload main commit (push 后 `git reset --hard origin/main`, 反 #110)

---

## 真用户 walk 场景 (SPEC §8.1 对齐, 6 截图 checklist)

### 截图 1 — 老用户 (PO 自己) 走 invite link → join page 单屏 wizard

1. PO 在 PO 自己的**老**浏览器**新** incognito window 跑:
   ```bash
   # 清干净 storage 模拟"刚换浏览器"
   # (在 PO browser DevTools console 跑)
   localStorage.clear(); sessionStorage.clear(); document.cookie.split(';').forEach(c => { document.cookie = c.trim().split('=')[0] + '=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/'; });
   ```
2. PO 创建 anon session:
   - 走真 UI `/sessions/new` → 输 session 名 → 输 3 个 placeholder 昵称 (PO_Nick, Slot2, Slot3) → 确认创建
   - PO 自己的 nickname (PO_Nick) 走 join-claim 自动 claim (跟 owner_email_claim.spec.ts :: case 1 同)
3. PO 在 incognito window 输 invite link:
   - invite link = `/s/{session_code}` (owner 在 detail 页右上角 "查看 invite" 拿)
   - 应 redirect 到 `/sessions/{sid}/join`
4. **验证** (截图 1):
   - join page 是**单屏** wizard (无 step indicator, 无 "下一步" button)
   - 上半屏 "选你的昵称" 区块 visible
   - 上半屏 3 个 button 全显: PO_Nick (anon-claimed) + Slot2 (unclaimed) + Slot3 (unclaimed)
   - 下半屏 "新建昵称" input + button visible
   - **不**存在 "登录找回" 区块 (老用户路径) / "已被认领" 区块 (新用户路径) — 这**两**区块**不**该在 §3.11.11 单屏里 (撤了, SPEC §2.1)

### 截图 2 — 新用户 (PO 换**另**一台设备 / 清 storage) 走 invite link → join page 单屏 wizard (同样 UI)

1. PO 拿同 session invite link, 在 PO **另**一台设备 (或 incognito window #2) 输
2. **验证** (截图 2):
   - join page 是**同**单屏 wizard UI (跟截图 1 完全一致, SPEC §5 "**不**做 user state 区分")
   - 上半屏 3 个 button 全显 (PO 认得 PO_Nick = PO 自己的, 但**其**他 2 个**不**认得 — PO 是新用户视角)
   - 下半屏 "新建昵称" input + button visible

### 截图 3 — 老用户点自己 slot → 跳 session detail

1. 回到截图 1 的 incognito window
2. 点上半屏 "PO_Nick" button
3. **验证** (截图 3):
   - 跳到 `/sessions/{sid}` (PO claim 成功)
   - localStorage `sbc.actingAs.{sid}` 已存 secret (DevTools → Application → Local Storage)
   - 详情页 PO 自己 (PO_Nick) 在 members 列表**已**认领 (有 actingAs 后 getSession 返 200)
   - **不**存在 "🔐 登录以保存" button (老用户**不**走 §3.11 claim flow, SPEC §1.2 关键决策: 老用户**不**需要 owner 概念)

### 截图 4 — 新用户输入昵称 + 创建 → 跳 session detail

1. 回到截图 2 的 incognito window #2
2. 下半屏 input 输 "AnonTest" + 点 "加入"
3. **验证** (截图 4):
   - 跳到 `/sessions/{sid}`
   - localStorage `sbc.actingAs.{sid}` 已存 secret
   - 详情页 members 列表**多**一个新 member "AnonTest" (action=add path, is_anon=true)
   - PO_Nick + AnonTest 都已 claim (各 anon-claimed)

### 截图 5 — 老用户点错昵称 (别人 slot) → 错进 session → header "退出" 按钮 (banner)

1. PO **再开**一个 incognito window #3 (清 storage)
2. 输 invite link → join page 单屏 wizard 显 4 个 button (PO_Nick + Slot2 + Slot3 + AnonTest 全显)
3. 点**别人**的 slot (例如 Slot2 — 不是 PO 自己的 PO_Nick)
4. **验证** (截图 5):
   - 跳到 `/sessions/{sid}` (BE 接受, 错进, PRD §3.11.11.5a)
   - 详情页 header 显 "退出" banner button (SPEC §6 edge case row 1)
   - members 列表 Slot2 已 claim (PO 自己)

### 截图 6 — header "退出" button → 退到 join page 重选 (正确 slot)

1. 接截图 5, 点 header "退出" banner button
2. **验证** (步骤 6):
   - 退到 `/sessions/{sid}/join`
   - localStorage `sbc.actingAs.{sid}` 已清 (PO 可重新选)
   - join page 单屏 wizard 又可见 (上半屏 + 下半屏)
   - PO 点**正确**的 slot (PO_Nick) → 进 session detail
   - header "退出" banner **消**失 (PO 已正确 claim)

### 截图 7 — 7 天外 session → "session 已回收" 提示

1. PO 走真 UI 没法直接 backdate `last_active_at`, 用 DB 直改:
   ```bash
   sqlite3 /tmp/sbc-test.db "UPDATE sessions SET last_active_at = datetime('now', '-8 days') WHERE id = {sid};"
   ```
   (或 Master 走 codeserver console `cs_read.js` / `cs_write.js` 进容器改)
2. PO **再开**一个 incognito window #4 (清 storage)
3. 输 invite link
4. **验证** (截图 7):
   - 跳到 `/sessions/{sid}/join` (BE 410 Gone, 但前端应 graceful 显提示)
   - join page **不**显 "选你的昵称" / "新建昵称" wizard
   - join page 显 "session 已回收, 请联系 owner" 提示 (SPEC §4.2 + §6 edge case row 2)
   - BE 直接 `curl http://localhost:8449/api/sessions/{sid}/preview` → 410 Gone

### 截图 8 — owner 邮箱登录 + claim flow → session 持久访问 (7 天外仍可访问)

1. PO 接截图 7: 7 天外 session, 但 PO 是 owner
2. PO 走 §3.11 claim flow:
   - PO 输 `/sessions/{sid}` 真 URL (不**走** invite link)
   - 7 天外 → 跳 join page 显回收提示
   - PO 看到 "owner 请邮箱登录激活" 引导 (PO i 自决: 弹窗 vs banner 文案)
3. PO 走 `/auth/login` 真 UI:
   - 输 PO email (`jessejia1001@gmail.com`)
   - 收真邮件 (Gmail inbox) → 拿 6 位 code → 输 verify
   - claim flow onMount `?claim=1` 检测 → POST `/api/sessions/{sid}/claim` → BE 绑 owner_user_id + owner_email
4. **验证** (截图 8):
   - 跳到 `/sessions/{sid}` (claim 成功)
   - 详情页 owner UI 自然在位 (无 "🔐 登录以保存" button)
   - BE `GET /api/sessions/{sid}` 返 `owner_user_id != null` + `owner_email = "jessejia1001@gmail.com"`
   - DB `last_active_at` 已更新到 now (claim flow 触发 owner activity bump)
   - 后续**再**走 invite link (截图 7 同步骤) **不**再 410 Gone (session 已持久化)

---

## Master 验收 checklist (SPEC §8.2)

- [ ] 截图 1: 老用户 anon 邀请链接 → join page 单屏 wizard
- [ ] 截图 2: 新用户 (清 storage) 邀请链接 → join page 单屏 wizard (同样 UI)
- [ ] 截图 3: 老用户点自己 slot → 跳 session detail
- [ ] 截图 4: 新用户输入昵称 + 创建 → 跳 session detail
- [ ] 截图 5: 老用户点错昵称 (别人 slot) → 错进 session + header "退出" banner
- [ ] 截图 6: 点 header "退出" → 退到 join page 重选 (正确 slot)
- [ ] 截图 7: 7 天外 session → "session 已回收" 提示
- [ ] 截图 8: owner 邮箱登录 → claim flow → session 持久访问 (后续 invite link 不再 410)

---

## 与 e2e 测试的关系

| E2E case | 真用户 walk 截图 |
|----------|------------------|
| case 1 (老用户 + invite link + 单屏 + 点自己 slot) | 截图 1 + 3 |
| case 2 (新用户 + invite link + 单屏 + 新建昵称) | 截图 2 + 4 |
| case 3 (老用户点错 + header 退出 + 退 join 重选) | 截图 5 + 6 |
| case 4 (7 天外 + 410 Gone + 回收提示) | 截图 7 |
| case 5 (owner 邮箱登录 + claim flow + 持久化) | 截图 8 |
| case 6 (单屏 UI 形态 + 无 wizard 步进) | 截图 1 + 2 (UI 形态**同**) |

**E2E 6 cases 都通过 ≠ Master 真用户 walk 都过** — 这是反 #132 + #130 关键.
- E2E 验证**每**个 scenario 的**机**器**层**行为 (DB + API + UI locator)
- Master 真用户 walk 验证**人**类**层** UX (动效 / 文案 / 移动端触摸 / 可达性)
- 两**层**都过 = 验收**完**毕 → 报告 PO

---

## 不**做**项 (本期不实施 / 后续 sprint)

- **不**测过期前 2 天弹窗 (SPEC §6 cron 后续 sprint, PRD §3.11.11.3 占位)
- **不**测私密 session (§3.11.12, 后续 sprint)
- **不**写**真**用户 walk code (本文件是 Master 责任, 本 Tester **只**列步骤**给** Master 参考)