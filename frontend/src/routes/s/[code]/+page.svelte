<script lang="ts">
  /**
   * v0.1.4 (2026-07-03) — session 详情页 polish round 2。
   *
   * 本次 polish (v0.1.4 round 2):
   * - 改动 1 (PO 10:15 拍板加回): 重新加回 members 折叠 toggle 按钮
   *   (PO 13:42 删过,现在又加回 — 迭代合理,直接做不质疑)。
   *   展开态 = 完整 members 列表,折叠态 = 仅头像堆叠 (32px 圆 -8px 重叠)。
   *   状态按 sessionId 持久化到 localStorage,默认展开。
   * - 改动 2: FAB `+` 居中对齐 — display: grid + place-items: center +
   *   padding-bottom: 2px (Inter font 里 `+` baseline 偏上, 视觉补偿 2px)。
   * - 改动 3: 新建 src/routes/+error.svelte — 401 自动清 user state +
   *   redirect /auth/login?returnTo=...; 其他 status 显示友好错误页。
   * - 改动 4: Empty state 条件修复 — session.members.length <= 1 改为 === 0
   *   (根因: owner 创建时自动加入, length 永远 >= 1, <= 1 让 owner 单独
   *   session 误触发 Empty state)。
   *
   * 沿用 v0.1.4 (round 1):
   * - bill 折叠动画 + share 独立行 + 成员列表简化
   *
   * 沿用 v0.1.3 Sprint 2 Commit 1:
   * - T6 千分位: 删除手写数字格式化,统一切到 $lib/utils/format.formatMoney。
   *   - 净金额 fmtNet 保留 '+' / U+2212 前缀 (Sprint 1 文档约束)。
   * - Token alias 迁移: var(--color-*) → var(--*) 主 token。
   *
   * 沿用:
   * - v0.1.2 反馈修 6 项目 2 (members section grid 布局)
   * - v0.1.2 反馈修 5 (跨页面动画)
   * - BillListGrouped 在 T7 中已支持「默认最新一天展开」智能逻辑
   */
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { fly } from 'svelte/transition';
  import { listBills, deleteBill, createBill } from '$api/bills';
  import { getSettle } from '$api/settle';
  import { formatMoney } from '$lib/utils/format';
  import type { SessionDetail } from '$api/sessions';
  import type { Bill } from '$api/bills';
  import { Search, X } from 'lucide-svelte';
  import InviteLinkButton from '$components/InviteLinkButton.svelte';
  import BillListGrouped from '$components/BillListGrouped.svelte';
  import EmptyState from '$components/EmptyState.svelte';
  import SessionCurrencyBadge from '$components/SessionCurrencyBadge.svelte';
  import CurrencyAddModal from '$components/CurrencyAddModal.svelte';
  // v0.3.28 UAT 0724-1 #5 (Option C 玻璃圆环): 加载账单数据 fetch 时显示 LoadingOverlay.
  import LoadingOverlay from '$components/LoadingOverlay.svelte';
  import { getSessionByCode, claimSession } from '$api/sessions';
  import { user, loadUser } from '$stores/user';
  import { toast } from '$stores/toast';

  // v0.1.4 round 2: 一旦用了 $state runes, 整个组件就进入 runes mode,
  // 原 Svelte 4 风格的 `$:` 不再允许, 全部改用 $derived;
  // 同时所有可变的 `let` 也要加 $state, 否则不触发响应式更新。
  let session = $state<SessionDetail | null>(null);
  let bills = $state<Bill[]>([]);
  let loading = $state(true);
  // v0.3.18 #53: open/close state for the CurrencyAddModal (triggered by
  // SessionCurrencyBadge single-pill + icon when owner).
  let addCurrencyOpen = $state(false);

  let memberIdToName = $state<Record<number, string>>({});
  let memberIdToNet = $state<Record<number, number>>({});
  let currentMemberId = $state<number | null>(null);
  // v0.3 (PRD §3.10): anonymous acting-as member ID (from X-SBC-Member-ID header).
  let actingAsMemberId = $state<number | null>(null);

  // v0.2.1 T05 (PRD §3.6.4): session 内账单 description 模糊搜索。
  // 不搜金额/付款人 (避免搜索结果飘忽)。空 query 全显示。
  let billsSearchQuery = $state('');
  /** true when .bills-search has scrolled into sticky position (sentinel left viewport). */
  let billsSearchStuck = $state(false);
  let billsSearchSentinel: HTMLDivElement | undefined = $state();

  /**
   * v0.2.1 T04: 删除撤回。
   * 队列按 FIFO (后删的先撤 — User 期望「撤销最后一次删除」)。
   * 每条 raw bill 缓存所有 BE 字段, 撤销时重新 POST /bills。
   * BE 会分配新 bill.id (旧 id 永久丢失, 但 bills 列表顺序回到删除前)。
   *
   * 字段集: 必须包含 POST /bills 接受的全部字段 (CreateBillRequest + use_calculator)。
   * 这里只缓存 deletable 的 bill 字段; description 是 immutable in edit but
   * 前端可以 POST 同一 description 作为 create (新 id)。
   *
   * v0.2.1 Sprint 2 fix (反模式 #51): 撤销按钮的 onclick 直接调用 undoDelete。
   * 之前用 `window.__sbcBillUndo_<id>` 全局 handler 做中介, 导致 race:
   *   - attachUndo 在 `await deleteBill` 之后才设置 window key,
   *     但 undo-stack 模板在 undoQueue 更新后**立即**渲染, 用户早于 50ms
   *     点撤销, 读到 undefined, 整个 click 静默失败。
   *   - 即便 await 返回, 闭包经过 window 反射, Svelte 5 runes 模式下行为
   *     不稳定 (闭包捕获的 $state 引用经 Proxy 后再 fire 可能丢失入口)。
   * 修法: 撤销按钮 onclick 直接调用组件作用域里的 undoDelete, 同步可执行,
   * 不依赖外部中介。新增 busy 状态防止 DELETE 与 POST 重建并发竞争。
   */
  interface DeletedBillSnapshot {
    rawBill: Bill;
    participants: Array<{ member_id: number; is_exclusive: boolean; exclusive_amount: number }>;
    payer_member_id: number;
    /** Description 是 v0.1.2 immutable, 但 POST /bills 仍接受, 所以这里缓存。 */
    description: string | null;
  }
  let undoQueue = $state<Array<{
    id: number;
    snapshot: DeletedBillSnapshot;
    /** 乐观删除进行中: 撤销按钮 disable, 防止与 DELETE 竞态。 */
    deleting?: boolean;
    /** 重建进行中: 防止用户连点多次触发多个 POST。 */
    restoring?: boolean;
  }>>([]);
  let nextUndoId = 1;

  // v0.1.4 round 2: 一旦用了 $state runes, 整个组件就进入 runes mode,
  // 原 Svelte 4 风格的 `$:` 不再允许, 全部改用 $derived。
  // v0.3.36 — UAT 0727-1 #8: /s/{session_code} URL 格式 (hash), 拆自 /sessions/[id]/+page.svelte.
  // sessionId 一开始 = 0; 首次 load() 通过 getSessionByCode(code) 拿到 session 后回填.
  // 后续 BE 调用 (listBills / deleteBill / claimSession) 都走 session.id (numeric).
  // 注意: 第一次 load 必须先 resolve code 才能拿到 numeric id.
  let code = $derived(page.params.code ?? '');
  let sessionId = $state(0);

  let currentMember = $derived(
    session
      ? session.members.find((m) => {
          if ($user?.user_id !== undefined) {
            return m.user_id === $user?.user_id;
          }
          // Anonymous: match by acting-as member ID
          return actingAsMemberId !== null && m.id === actingAsMemberId;
        }) ?? null
      : null
  );
  let isOwner = $derived(currentMember?.role === 'owner');

  // v0.3.31 #2 (UAT 0725-2 #2): 匿名 owner 首次进入账单页触发呼吸 + 文案 pill.
  // showBreathing → 传给 InviteLinkButton 的 breathing prop, 触发 CSS keyframes.
  // showAnonHint → 控制红色玻璃 pill .expiry-anon-a 渲染 (邀请按钮正下方).
  // 两者由 onMount() 一次性设置 (sessionStorage 二次访问不重触).
  let showBreathing = $state(false);
  let showAnonHint = $state(false);

  // v0.3.28 (UAT 0723-3 #9): session 至少有一名已认领成员 (user_id !== null) → "已永久保存" 提示
  //   取代原 "yyyy.mm.dd 过期 · 登录即可永久保存" 过期提示.
  //   判定: session.members.some(m => m.user_id != null) — m.user_id nullable = anon.
  let hasClaimedMember = $derived(
    session?.members?.some((m) => m.user_id !== null && m.user_id !== undefined) ?? false
  );

  // §3.11 收尾 (PO 11:38 拍板): 详情页 header 显示 owner info.
  // 位置: 详情页顶部 (在 banner 之外, 在 session 标题之后).
  // 登录态 + owner: nickname + email + 退出登录 button.
  // PO 14:01 重申: 详情页 header 完全**不**要 login/logout/登录以保存 按钮.
  // 全部用 banner 那个. 这里**只**留 "查看结算" 链接. 撤 handleOwnerHeaderLogout
  // + ownerHeaderLoggingOut (之前 commit b98f6a1 加的 logout button 用).

  /** v0.2.1 T05: bills 列表按 description 模糊 filter (大小写不敏感)。 */
  let filteredBills = $derived(
    billsSearchQuery.trim() === ''
      ? bills
      : bills.filter((b) =>
          (b.description ?? '')
            .toLowerCase()
            .includes(billsSearchQuery.trim().toLowerCase())
        )
  );

  // v0.3.21 #118 (PO msg 11:35 #7838 Bug 1 + Bug 4, #116 续): 加回 scrollSearchToSticky
  // 函数, 只在 onfocus 调用 (不调 oninput). 加 visualViewport 守卫 — iOS keyboard 弹起时
  // (vv.height 比 window.innerHeight 小 100px+) 不滚, 避免跟浏览器自动 scrollIntoView 冲突.
  // - focus 时 scrollSearchToSticky 把 search 预置到 sticky top: 8px (即时滚)
  // - keyboard 弹起后 browser scrollIntoView 不会再拖 (search 已在 viewport 内 sticky 位)
  // - oninput 不调: filteredBills 变化 search 位置保持
  // v0.3.22 #128 (UAT bug #1, PO msg 16:05 #8064): 摘 rAF + scrollTo() 框架, 改
  // 同步 main.scrollTop = … — iOS 点击 focus 中, rAF 退出后 browser scrollIntoView
  // 紧跟而来, 两调 scroll 抢同一帧 → search 被顶下 viewport. 同步滚让我方赢 frame 1
  // (Svelte onfocus handler 同步执行), browser scrollIntoView 起来 时 search 已
  // 到位, 不再被拖。
  function scrollSearchToSticky() {
    if (typeof document === 'undefined') return;
    // v0.3.21 #118: iOS keyboard 弹起时 visualViewport.height < window.innerHeight - 100,
    // 此时 browser 已经在调 scrollIntoView, 我们不调避免双 scroll.
    if (typeof window !== 'undefined' && window.visualViewport) {
      const vv = window.visualViewport;
      if (vv.height < window.innerHeight - 100) return;
    }
    const main = document.querySelector('main');
    const el = document.querySelector('.bills-search');
    if (!(main instanceof HTMLElement) || !(el instanceof HTMLElement)) return;
    const STICKY_OFFSET = 8; // var(--space-2), 跟 .bills-search { top } 对齐（非 stuck 态）
    // offsetTop 累加到 main
    let target: HTMLElement | null = el;
    let top = 0;
    while (target && target !== main) {
      top += target.offsetTop;
      target = target.offsetParent as HTMLElement | null;
    }
    const desired = Math.max(0, top - STICKY_OFFSET);
    const maxScroll = main.scrollHeight - main.clientHeight;
    const targetScroll = Math.min(desired, maxScroll);
    // 同步赋值 (no animation, no rAF delay) — 抢在 browser scrollIntoView 之前
    if (Math.abs(main.scrollTop - targetScroll) > 4) {
      main.scrollTop = targetScroll;
    }
  }

  function updateBillsSearchStuckBleed() {
    if (!billsSearchStuck || typeof document === 'undefined') return;
    const search = document.querySelector('.bills-search');
    const nav = document.querySelector('.navbar');
    if (!(search instanceof HTMLElement)) return;
    if (nav instanceof HTMLElement) {
      // v0.3.0729-5 #6: clamp bleed. 持续下拉/rubber-band 时 search.top 会异常变大,
      // 旧逻辑无上限 → ::before 白玻璃铺满整屏. 正常 stuck 时 gap 仅是 sticky top
      // 与 navbar 之间的空隙 (~8–24px); 硬顶 32px 防穿帮.
      const gap = Math.max(
        0,
        Math.min(
          32,
          search.getBoundingClientRect().top - nav.getBoundingClientRect().bottom
        )
      );
      search.style.setProperty('--bills-search-stuck-bleed', `${gap}px`);
    }
  }

  $effect(() => {
    if (!browser || bills.length === 0 || !billsSearchSentinel) {
      billsSearchStuck = false;
      return;
    }
    const main = document.querySelector('main');
    if (!(main instanceof HTMLElement)) return;

    const io = new IntersectionObserver(
      ([entry]) => {
        billsSearchStuck = entry ? !entry.isIntersecting : false;
        requestAnimationFrame(updateBillsSearchStuckBleed);
      },
      { root: main, rootMargin: '-8px 0px 0px 0px', threshold: 0 }
    );
    io.observe(billsSearchSentinel);

    const onScroll = () => requestAnimationFrame(updateBillsSearchStuckBleed);
    main.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);

    return () => {
      io.disconnect();
      main.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  });

  // v0.1.4 round 2 改动 1: 重新加回 members 折叠 toggle。
  // 默认展开; 用户折叠后按 sessionId 持久化到 localStorage。
  let membersOpen = $state(true);
  const membersStorageKey = (sid: number) => `sbc.membersOpen.${sid}`;

  onMount(async () => {
    // Bug fix (PO 14:01 报 "登录态 email 这里还是没有正常显示"):
    // detail page 之前**不**调 loadUser, $user store 永远 null, member list fallback
    // (m.user_id === $user.user_id 显 $user.email) 永远 false → owner "me" 行没 email.
    // loadUser() 调 /api/auth/me 拿 user_id + email + default_name.
    await loadUser();

    // 还原 localStorage 折叠偏好
    try {
      const raw = localStorage.getItem(membersStorageKey(session?.id ?? 0));
      if (raw !== null) membersOpen = raw === 'true';
    } catch {
      // ignore — SSR or storage disabled
    }

    await load();

    // v0.3.31 #2 (UAT 0725-2 #2, PO msg ~20:03 字面):
    //   "匿名用户创建账本,首次进入账单页时,邀请链接按钮高亮呼吸。
    //    下方的提示目前是"邀请朋友加入,开始分摊第一笔账单吧",
    //    改为"当前未登录,请收藏此链接,这是您回到此账本的唯一密钥！""
    // 触发条件:
    //   1) session.members[0]?.user_id === null → owner 匿名创建 (即 anon owner)
    //   2) sessionStorage 没有 sbc-visited-{session.id} 标记 → 首次进入账单页
    // 满足两条件则:
    //   - showBreathing = true → InviteLinkButton 加 .invite-btn-breathing (1.5s 紫光晕 + scale 1↔1.02)
    //   - showAnonHint = true → 邀请按钮下方渲染红色玻璃 pill .expiry-anon-a (PO 新文案)
    //   - 立即写 sessionStorage, 刷新/重进不重触 (PO 明确 "首次进入")
    // 不满足 (已认领 member / 二次访问) → 两个 flag 保持 false, 既不呼吸也不显 pill.
    // 注: members 在 load() 后已就绪, 此时 session.members[0].user_id 反映 owner 是否匿名.
    if (browser) {
      const isAnonOwner = !session?.members?.[0]?.user_id;
      // v0.3.36 #16 (UAT 0727-1): sbc-visited -> sbc-invite-actioned, onMount read only
      //   Jesse msg 2026-07-27 23:35 'f.邀请链接被使用过才行'.
      //   默认 showBreathing/showAnonHint 都 true (PO 字面 '一直显示此提醒'),
      //   不立即写 sessionStorage — 只有 InviteLinkButton 真的派 copy/open 事件才写.
      const actionedKey = `sbc-invite-actioned-${session?.id ?? ''}`;
      const sessionActioned = sessionStorage.getItem(actionedKey);
      if (isAnonOwner && !sessionActioned) {
        showBreathing = true;
        showAnonHint = true;
        // v0.3.0729-3 #2: 显示未登录提示时，成员 section 强制展开
        membersOpen = true;
      }
    }
  });

  /**
   * v0.2.1 UI rev: header 整体 clickable.
   * - handleMembersToggle: click 任意 header 区域切换 (InviteLinkButton 自己 stopPropagation)
   * - handleMembersKeydown: keyboard accessibility (Enter/Space)
   * 持久化逻辑不变 (localStorage sbc.membersOpen.{sessionId})
   *
   * v0.3.24 #3 (PO msg 16:35 UAT line #3 字面 "点击邀请按钮, 复制邀请链接时, 目前会同时展开或折叠 成员 section, 期望只复制, 不要影响成员 section 的状态"):
   *   - 根因: InviteLinkButton 的 modal (.invite-modal / .invite-modal-backdrop / 知道了 按钮) 渲染在 InviteLinkButton 组件内,
   *     InviteLinkButton 又是 header 的后代, 所以 modal 的点击事件 (含 知道了 关闭按钮) 会冒泡到 header 的 onclick, 触发 toggle.
   *     InviteLinkButton 自己的按钮 click 有 stopPropagation, 但 modal 是异步渲染的 (复制成功后才弹),
   *     关闭 modal 时按钮 click 冒泡到 header.
   *   - 修法: handleMembersToggle 接受 event 参数, 用 closest() 过滤掉 InviteLinkButton 区域 (.invite-row 含整个组件树)
   *     + expiry CTA link (.expiry-cta-link 含过期链接区域) — 这两类内部点击不应触发 section toggle.
   *     其他区域 (chevron, title, avatar, 空 row2 区域) 维持原有 toggle 行为.
   *     不引入新 CSS class / data attr, 用现有 selector 精确匹配.
   */
  function handleMembersToggle(e?: MouseEvent) {
    if (e) {
      const target = e.target as HTMLElement | null;
      // InviteLinkButton 在 InviteLinkButton.svelte 顶层渲染 2 个 sibling:
      //   <div class="invite-row">...</div>  (button 容器)
      //   {#if modalOpen}<div class="invite-modal-backdrop">...</div>{/if}  (modal)
      // 两个都直接是 header 的 child (因为 InviteLinkButton 是 header 的 child),
      // 所以 modal 点击事件会冒泡到 header 的 onclick → 触发 toggle (user 反馈 #3).
      // 用 closest() 排除: 邀请按钮 + modal 区域 + 过期 CTA link.
      // 其他区域 (chevron, title, avatar, 空 row2 区域) 维持原有 toggle 行为.
      if (target?.closest('.invite-row, .invite-modal-backdrop, .expiry-cta-link, .expiry-anon-a')) return;
    }
    // v0.3.0729-4 #1: 展示「当前未登录…」提示时，成员 section 禁止折叠
    if (showAnonHint && membersOpen) return;
    membersOpen = !membersOpen;
    try {
      localStorage.setItem(membersStorageKey(sessionId), String(membersOpen));
    } catch {
      // ignore
    }
  }
  function handleMembersKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleMembersToggle();
    }
  }

  // 头像首字母大写 (跨语言 helper)
  function avatarLetter(name: string): string {
    const trimmed = (name ?? '').trim();
    return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
  }

  /**
   * v0.3.18 #66 (PO #6899 Mockup A): ISO → "YYYY 年 M 月 D 日" 中文长格式.
   * 用于 page-level .expiry-inline-a amber pill (从 InviteLinkButton 移到 section header).
   * v0.3.19 #83 (PO #7300): header pill 改紧凑 — "M月D日" (省 "年" 和 "后过期" — template 自加) — iPhone SE (375px) 不超.
   */
  function formatExpiryDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const m = d.getMonth() + 1;
    const day = d.getDate();
    return m + '月' + day + '日';
  }

  /**
   * T6: 净金额显示,>0 加 "+", <0 加 U+2212 (Sprint 1 文档约束), =0 "0.00"。
   * 数字部分走 formatMoney (千分位)。
   */
  function fmtNet(n: number | undefined): string {
    if (n === undefined || n === null || Number.isNaN(n)) return '';
    if (n > 0) return '+' + formatMoney(n, { showSymbol: false });
    if (n < 0) return '\u2212' + formatMoney(Math.abs(n), { showSymbol: false });
    return formatMoney(0, { showSymbol: false });
  }

  /**
   * v0.3.18 #66 (PO #6899 Mockup A): anon 账本过期时间 ISO -> 中文长格式
   * 「YYYY 年 M 月 D 日后过期」(amber pill 文案).
   * v0.3.22 #127 (UAT bug #2.b, PO msg 16:05 #8064): PO 拍板改 yyyy.mm.dd 过期
   * (日期分隔离口令, 单位词"过期"留, 凑 "2026.07.29 过期" 简洁).
   */
  function formatExpiryPill(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}.${m}.${day} 过期`;
  }

  async function load() {
    if (!code) return;
    loading = true;
    try {
      const result = await getSessionByCode(code);
      session = result;  // getSessionByCode returns SessionDetail directly (not wrapped)
      sessionId = result.id;  // 回填 numeric id, 后续 BE 调用用
      // 注: getSessionByCode 不返 actingAsMemberId (member 由 X-Nickname-Secret BE 端识别).
      // actingAsMemberId 在 v0.3.36 改为 sessions.page_url 的 session_member 检查,
      // 当前路由不再需要 (member 列表 + isMe 计算够用).
      for (const m of session.members) {
        memberIdToName[m.id] = m.display_name;
      }
      try {
        const settle = await getSettle(sessionId);
        const nets: Record<number, number> = {};
        for (const m of session.members) {
          const key = String(m.id);
          const v = settle.balances?.[key];
          if (typeof v === 'number') nets[m.id] = v;
        }
        memberIdToNet = nets;
      } catch {
        // ignore
      }
      bills = await listBills(sessionId, code);
      currentMemberId = currentMember?.id ?? null;

      // v0.3.27 (UAT 0723-2 #19): owner登录即可永久保存账本的逻辑，改为「任一成员登录即可永久保存账本」.
      // 之前: 只有 creator (role=owner) 登录后才能触发 /claim, FE 从来不自动调 claimSession() (要 URL 带 ?claim=1),
      //       导致 expiry CTA 完全失效, session 永远 7 天过期. 现在: 任何已登录成员访问本页面 + session.owner_email==NULL,
      //       自动调 claimSession() 让 session 永久. 该成员成为 owner_user_id (BE /claim 设计为 first-claimant-wins).
      try {
        if ($user && !session.owner_email) {
          // 静默 try — 任何 error (403 / 409 / 已 non-member) 不打断 UI
          const updated = await claimSession(sessionId);
          session = updated;
          console.info('[v0.3.27 #19] session auto-claimed by logged-in member, owner_email set');
        }
      } catch (claimErr) {
        // 非 member → 忽略. 其他错误也不护栏, session 照常加载.
      }
    } catch (e: any) {
      const c = e?.code ?? '';
      if (c === 'not a session member' || e?.status === 403) {
        // v0.3.36 (UAT 0727-1 #8): 非成员 → /s/{code}/join (use original `code` param).
        // 之前用 session?.session_code || String(sessionId), 但 v0.3.36 #8 后 sessionId
        // 是 $state(0) 初始值, 403 时 session 还没拿到, fallback 出 '/s/0/join' (错).
        // 现在直接用 URL 参数 `code` (用户访问的 hash), join 页面会重新解析.
        // BUG-V031-A: anon 非成员 BE 返回 403 with detail.session_id, join page 处理.
        await goto('/s/' + code + '/join', { replaceState: true });
        return;
      } else {
        // 401 handled globally by client.ts (auto-redirect to /auth/login
        // with returnTo=<current path>). The previous inline goto('/auth/login')
        // here duplicated that redirect AND dropped the returnTo param;
        // removing it lets client.ts own the single source of truth.
        // v0.3.15 (PO #4807): 错误统一走 Toast
        toast.error(e?.message ?? '加载失败');
      }
    } finally {
      loading = false;
    }
  }

  /**
   * v0.2.1 T04 (PRD §3.6.4): 乐观删除 + 5s Toast 撤回。
   *
   * 流程 (Sprint 2 修订):
   * 1) 立即从 bills 数组里 splice (UI 立刻响应)
   * 2) 缓存 raw bill + participants, push 到 undoQueue (deleting=true)
   * 3) 弹 Toast `已删除 <description> [撤销]`, 5s 自动消失 (不阻塞 DELETE)。
   * 4) 调 DELETE /bills。成功 → 标记 deleting=false (撤销按钮 enable)。
   *    失败 → 把 bill 放回 bills 数组, 移除 undoEntry, 报 toast.error。
   * 5) 用户点撤销 → 标记 restoring=true, POST /bills 重建 (新 id)。
   *    成功 → push 回 bills, 移除 undoEntry, toast.success。
   *    失败 → 撤销 restoring 标记, 让用户重试, toast.error。
   *
   * 队列 FIFO (后删的先撤 — User 期望「撤销最后一次删除」)。
   * 不使用 soft-delete, 不新加 BE endpoint。
   * 注意: BillForm 在描述录入后, 后端 POST 返回新 id; 旧 id 永久丢失。
   * 这是可接受的 trade-off — 5s 撤销窗口足够短, 用户的「确认」还在短期记忆里。
   */
  /**
   * v0.3.35 #3 — UAT 0725-3 #9 (PO msg #9088 batch): 删除账单二次确认 modal.
   * PO 字面 "删除账单时要二次确认". 之前 handleDeleteBill 立即乐观删除 + 弹 undo toast
   * (5s 可撤销); 现在加二次确认 modal — 用户 swipe 出来删除按钮 → 点 → 弹 confirm modal
   * → 「取消」关闭无任何变化 / 「确认删除」才进 handleDeleteBill 乐观删除流.
   * 模式跟 SessionCard v0.3.25 #16 confirm-modal (template line 540-620 + CSS line 985-1075) 同款 token.
   */
  let pendingDeleteBillId: number | null = $state(null);
  let pendingDeleteBillLabel: string = $state('');
  function requestDeleteBill(billId: number) {
    const bill = bills.find((b) => b.id === billId);
    if (!bill) return;
    pendingDeleteBillId = billId;
    pendingDeleteBillLabel = bill.description ?? '(无说明)';
  }
  function cancelDeleteBill() {
    pendingDeleteBillId = null;
    pendingDeleteBillLabel = '';
  }
  function confirmDeleteBill() {
    if (pendingDeleteBillId === null) return;
    const id = pendingDeleteBillId;
    pendingDeleteBillId = null;
    pendingDeleteBillLabel = '';
    void handleDeleteBill(id);
  }

  async function handleDeleteBill(billId: number) {
    const idx = bills.findIndex((b) => b.id === billId);
    if (idx < 0) return;
    const rawBill = bills[idx];
    // Capture the full snapshot we need to recreate the bill.
    const snapshot: DeletedBillSnapshot = {
      rawBill,
      payer_member_id: rawBill.payer_id,
      description: rawBill.description,
      participants: rawBill.participants.map((p) => ({
        member_id: p.member_id,
        is_exclusive: !!p.is_exclusive,
        exclusive_amount: Number(p.exclusive_amount) || 0,
      })),
    };
    const undoEntry = { id: nextUndoId++, snapshot, deleting: true };

    // 1) 乐观删除 — 立即从 UI 移除。
    bills = bills.filter((b) => b.id !== billId);

    // 2) Push to undo queue (FIFO — 后删的先撤)。deleting=true 期间撤销按钮
    //    disabled, 防止与 DELETE 竞态 (用户早于 DELETE 完成点撤销会先 POST 重建,
    //    然后 DELETE 又把新 bill 删了)。
    undoQueue = [...undoQueue, undoEntry];

    // 3) Toast 立即弹出 (UX 优先 — 不等 DELETE 完成)。
    const deleteLabel = snapshot.description
      ? `已删除「${snapshot.description}」`
      : '已删除账单';
    toast.show(deleteLabel, 'info', 5000);

    try {
      await deleteBill(sessionId, billId, code);
      // DELETE 成功 — 解锁撤销按钮。
      undoQueue = undoQueue.map((u) =>
        u.id === undoEntry.id ? { ...u, deleting: false } : u
      );
    } catch (e: any) {
      // 失败回滚 bills。
      bills = [...bills, rawBill].sort((a, b) => {
        if (a.occurred_at !== b.occurred_at) {
          return a.occurred_at < b.occurred_at ? -1 : 1;
        }
        return a.id - b.id;
      });
      undoQueue = undoQueue.filter((u) => u.id !== undoEntry.id);
      toast.error(e?.message ?? '删除失败');
    }
  }

  async function undoDelete(undoId: number) {
    const entry = undoQueue.find((u) => u.id === undoId);
    // 防双触发: deleting 中 (DELETE 没回来) 或 restoring 中 (POST 没回来)。
    if (!entry || entry.deleting || entry.restoring) {
      toast.error('该账单已无法撤销');
      return;
    }
    // 立即标记 restoring, 不移除 undoEntry (POST 失败时回退让用户重试)。
    undoQueue = undoQueue.map((u) =>
      u.id === undoId ? { ...u, restoring: true } : u
    );
    const { snapshot } = entry;
    try {
      const recreated = await createBill(sessionId, {
        amount: snapshot.rawBill.amount,
        payer_member_id: snapshot.payer_member_id,
        description: snapshot.description,
        occurred_at: snapshot.rawBill.occurred_at,
        currency: snapshot.rawBill.currency,
        participants: snapshot.participants,
      }, code);
      // Push the recreated bill back into the list. Insert by occurred_at
      // to preserve chronological position.
      const next = [...bills, recreated];
      next.sort((a, b) => {
        if (a.occurred_at !== b.occurred_at) {
          return a.occurred_at < b.occurred_at ? 1 : -1;
        }
        return a.id - b.id;
      });
      bills = next;
      undoQueue = undoQueue.filter((u) => u.id !== undoId);
      const restoredLabel = snapshot.description
        ? `已恢复「${snapshot.description}」`
        : '账单已恢复';
      toast.success(restoredLabel);
    } catch (e: any) {
      // POST 失败 — 撤销 restoring 标记, 让用户重试。
      undoQueue = undoQueue.map((u) =>
        u.id === undoId ? { ...u, restoring: false } : u
      );
      toast.error(e?.message ?? '恢复失败');
    }
  }

  // T14: copy invite link to clipboard (EmptyState CTA 用)
  let copyingInvite = $state(false);
  async function copyInviteLink() {
    if (!session) return;
    copyingInvite = true;
    try {
      const preview = session.invite_token_preview ?? '';
      const url = `${window.location.origin}/invites/${preview}`;
      try {
        await navigator.clipboard.writeText(url);
        toast.success('邀请链接已复制');
      } catch {
        // 兜底:用 textarea + execCommand
        const ta = document.createElement('textarea');
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand('copy');
          toast.success('邀请链接已复制');
        } catch {
          toast.error('复制失败,请手动复制');
        } finally {
          document.body.removeChild(ta);
        }
      }
    } finally {
      copyingInvite = false;
    }
  }

  // v0.3.23 #138 (UAT bug #13): 删 handleDeleteMemberClick — 成员 × 按钮已删, 函数无 caller.
  //   原来跟 × 按钮一起绑 on:click, 按钮删后函数 dead code.
</script>

<section>
  {#if loading}
    <!-- v0.3.28 UAT 0724-1 #5 (Option C 玻璃圆环): 跟 loading-screen (settle) + wizard 一致. -->
    <LoadingOverlay text="加载账单..." />
  {:else if session}
    <div class="row between session-header" style="margin-bottom: var(--space-3); flex-wrap: wrap; gap: var(--space-2);">
      <h2 style="margin: 0;">
        {session.name}
      </h2>
    </div>
    {#if session.currencies && session.currencies.length > 0}
      <!-- v0.3.19 #85 (PO #7308): 删 onRateChange (弹窗 PATCH 后 parent onAdded 统一 reload).
           多币种整 bar clickable 在 owner 时也触发 onAddCurrency. -->
      <SessionCurrencyBadge
        currencies={session.currencies}
        primary_currency={session.primary_currency}
        exchange_rates={session.exchange_rates ?? []}
        editable={isOwner}
        variant="detail"
        onAddCurrency={() => (addCurrencyOpen = true)}
      />
    {/if}

    <!-- v0.3.20 #92 (PO msg 07:13 #7409): 重排 members head rows —
         row1: title + count 左, expiry pill 右 (owner_email 为空时)
         row2: avatar 组 (左, 折叠态独有) + InviteLinkButton (右, 永远渲染)
         row3: chevron-down + 「查看 N 人」居中, 折叠态独有
         整段 onclick + aria-expanded 保留, header 整体可点折叠/展开.
         反 #7300 regression 修复: row1 挪 invite 到 row2 后, 展开态 InviteLinkButton 必须保留.
         设计理由: invite 是核心操作, 不应被 collapsed 状态决定可见性.
         row2 用 space-between: 折叠时 [avatars 左 | invite 右]; 展开时 [空 | invite 右] 自然 right-align. -->
    <div class="card members-card">
      <header
        class="members-head"
        class:collapsed={!membersOpen}
        onclick={handleMembersToggle}
        onkeydown={handleMembersKeydown}
        role="button"
        tabindex="0"
        aria-expanded={membersOpen}
        aria-label={membersOpen ? '收起成员列表' : '展开成员列表'}
      >
        <!-- 第一行: 成员 · N人 左 (users icon 14×14 gray-500), expiry pill 右 (owner_email 为空时) -->
        <div class="members-head-row1">
          <h3 class="members-title-a">
            <!-- Lucide `users` 14×14 gray-500 -->
            <svg
              class="members-title-icon"
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <span>成员</span>
          </h3>
          <!-- v0.3.22 #127 (UAT bug #2.a, PO msg 16:05 #8064): 删 "· N人" count.
               PO 反馈"成员 N人"右侧 N人 多余, 成员数从 .members-list-a 下面的 chevron "查看 N 人"
               翻出来. 保留 title 简洁只 "成员"。 -->
          <!-- v0.3.22 #127 (UAT bug #2.b, PO msg 16:05 #8064): expiry pill 由 (anon only)
               收窄为 everyone — invite_expires_at 存在就显示 (owner_email 绑不绑都显),
               文本 `yyyy.mm.dd 过期, xx 登录即可永久保存` 统一。xx = ownerDisplayName
               (从 m.role==='owner' 查, 不 session.members[0] 依赖首成员永远是 owner)。 -->
          {#if session?.invite_expires_at}
            {#if hasClaimedMember}
              <!-- v0.3.28 (UAT 0723-3 #9): session 已有 user-bound 成员 → 绿色 ✅ 永久保存提示,
                   取代原过期 CTA. 位置不变 (members-head-row1 同行, 在 members title 右边).
                   颜色: emerald-50 bg + emerald-700 text + 1px emerald-200 border 跟 .expiry-inline-a 视觉同族. -->
              <span class="expiry-saved-a" data-testid="invite-expiry-saved">
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>此账单已永久保存</span>
              </span>
            {:else}
              <span class="expiry-inline-a" data-testid="invite-expiry-pill">
                <!-- Lucide `clock` 11×11 -->
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <span>{formatExpiryPill(session.invite_expires_at)}</span>
                <span class="expiry-cta-sep" aria-hidden="true">·</span>
                <!-- v0.3.25 (UAT 0723-2 #20): 删 owner name, 留 "登录即可永久保存". 
                     文本 "yyyy.mm.dd 过期 · 登录即可永久保存" 统一, 所有人都一样 (无 owner name). -->
                <!-- v0.3.x (UAT #0723-3 #3): /s/{session_code} unguessable 格式 (代替 /sessions/{id}) -->
                <a
                  class="expiry-cta-link"
                  href="/auth/login?returnTo=/s/{session.session_code || String(session.id)}"
                  aria-label="登录即可永久保存账本"
                  data-testid="invite-expiry-cta"
                >
                  <span class="expiry-cta-suffix">登录即可永久保存</span>
                </a>
              </span>
            {/if}
          {/if}
        </div>

        <!-- 第二行: 头像组 (左, 折叠态独有) + InviteLinkButton (右, 永远渲染)
             用 space-between + right margin-left: auto, 折叠时 [avatars | invite],
             展开时 [空 | invite] 自然 right-align, 任何状态都能调 invite -->
        <div class="members-head-row2">
          <!-- v0.3.0729-4 #2: 未登录提示左边与成员 section 左边对齐（正常 padding）;
               与邀请按钮仍同行：提示在左、邀请在右。 -->
          <div class="members-row2-left">
            {#if showAnonHint}
              <span class="expiry-anon-a" data-testid="invite-anon-hint">
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span class="anon-hint-text">
                  <span class="line-1">当前未登录 请收藏此链接</span>
                  <span class="line-2">这是您回到此账本的唯一密钥。</span>
                </span>
              </span>
            {:else if !membersOpen && session.members.length > 0}
              <div class="members-avatars-inline" aria-hidden="true">
                {#each session.members.slice(0, 8) as m, i (m.id)}
                  <div class="avatar-mini palette-{i % 10}" title={m.display_name}>
                    {avatarLetter(m.display_name)}
                  </div>
                {/each}
                {#if session.members.length > 8}
                  <span class="avatar-mini avatar-mini-overflow">+{session.members.length - 8}</span>
                {/if}
              </div>
            {/if}
          </div>
          <div class="members-row2-right">
            <InviteLinkButton
              sessionId={session.id}
              sessionCode={session?.session_code ?? ""}
              sessionName={session?.name ?? ""}
              {isOwner}
              breathing={showBreathing}
              on:copy={() => {
                if (browser) {
                  sessionStorage.setItem(`sbc-invite-actioned-${session?.id ?? ''}`, '1');
                }
                showBreathing = false;
                showAnonHint = false;
              }}
              on:open={() => {
                if (browser) {
                  sessionStorage.setItem(`sbc-invite-actioned-${session?.id ?? ''}`, '1');
                }
                showBreathing = false;
                showAnonHint = false;
              }}
            />
          </div>
        </div>

        <!-- 第三行: chevron-down + 「查看 N 人」居中 (affordance 提示), 折叠态独有 -->
        {#if !membersOpen}
          <div class="members-head-row3" aria-hidden="true">
            <!-- Lucide `chevron-down` 12×12 gray-400 -->
            <svg
              class="members-expand-chevron"
              viewBox="0 0 24 24"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <span class="members-expand-hint">查看 {session.members.length} 人</span>
          </div>
        {/if}
      </header>

      {#if membersOpen}
        <!-- v0.3.25 (UAT 0723-2 #14): 删 1-member 紧凑 CTA banner ('xxx还没有同伴, 邀请朋友加入一起记账'). 
             现在 1-member case 直接走 else 分支的 members list (单 row). -->
        {#if session.members.length === 0}
          <EmptyState
            icon="users"
            title="还没有成员"
            description="分享邀请链接,邀请朋友加入这个账本。"
            ctaLabel={copyingInvite ? '已复制' : '复制邀请链接'}
            onCtaClick={copyInviteLink}
          />
        {:else}
          <ul class="members-list-a">
            {#each session.members as m, i (m.id)}
              {@const isMe = currentMember?.id === m.id}
              <li
                class="member-row-a"
                class:is-owner={m.role === 'owner'}
                class:is-me={isMe}
                in:fly={{ y: 8, duration: 220, delay: Math.min(i * 30, 300) }}
              >
                <div
                  class="avatar-a palette-{i % 10}"
                  class:is-owner={m.role === 'owner'}
                  class:is-me={isMe}
                  aria-hidden="true"
                >
                  {avatarLetter(m.display_name)}
                </div>
                <div class="member-info-a">
                  <div class="member-name-row-a">
                    <span class="member-name-a">{m.display_name}</span>
                    {#if m.role === 'owner' && isMe}
                      <span class="me-dot-a">me · owner</span>
                    {:else if m.role === 'owner'}
                      <span class="owner-tag-a">owner</span>
                    {:else if isMe}
                      <span class="me-dot-a">me</span>
                    {/if}
                  </div>
                  <div class="member-meta-a">
                    {#if memberIdToNet[m.id] !== undefined}
                      <span
                        class="member-net-a"
                        class:pos={(memberIdToNet[m.id] ?? 0) > 0}
                        class:neg={(memberIdToNet[m.id] ?? 0) < 0}
                      >
                        {fmtNet(memberIdToNet[m.id])}
                      </span>
                    {/if}
                    {#if m.email}
                      <span class="member-email-a">{m.email}</span>
                    {:else if $user && m.user_id === $user.user_id}
                      <!-- Bug fix (PO 12:51 报): 普通 member 详情页看不到自己 email.
                           BE 端同伴 slot claim 没 push user.email 到 SessionMember.email,
                           但 $user store 已有 email. 如果 member 是当前 user, fallback 显示 $user.email. -->
                      <span class="member-email-a">{$user.email}</span>
                    {/if}
                  </div>
                </div>
                <!-- v0.3.23 #138 (UAT bug #13): 删 删成员 × 按钮 — BE 端无 endpoint 支持,
                     按钮一直 disabled 是「视觉错误承诺」. UI 跟实际能力对齐, 不画不存在的能力.
                     代码保留 isOwner check (未来 BE 支持后可以重启用 button). -->
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </div>

    <!-- 反馈修 5 项目 8 + v0.3.2 §3.12.3: 「个人账单」按钮迁到 head，「查看结算」也并排。
         视觉候选 B（PO 10:30 拍板）：两按钮 ghost + Lucide inline SVG 图标。-->
    <div id="bills-card" class="card bills-card">
      <div class="bills-card-head">
        <div class="bills-card-head-left">
          <h3 class="bills-card-title">
            <!-- Lucide `receipt` 14×14 gray-500 — 跟 members-title-icon 同源风格 -->
            <svg
              class="bills-card-title-icon"
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
              <path d="M8 7h6" />
              <path d="M8 11h6" />
              <path d="M12 17h4" />
            </svg>
            <span>账单</span>
          </h3>
          <span class="muted bills-card-count">共 {bills.length} 笔</span>
        </div>
        <div class="bills-card-head-right">
          <!-- v0.3.x (UAT #0723-3 #3): /s/{session_code}/settle unguessable 格式 -->
          <a
            class="btn glass-pill btn-sm bills-action-link"
            href="/s/{session.session_code || String(session.id)}/settle"
            aria-label="查看结算"
          >
            <!-- Lucide `calculator` 16x16 -->
            <svg
              class="bills-action-icon"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="4" y="3" width="16" height="18" rx="2" />
              <line x1="8" y1="7" x2="16" y2="7" />
              <line x1="8" y1="11" x2="10" y2="11" />
              <line x1="14" y1="11" x2="16" y2="11" />
              <line x1="8" y1="15" x2="10" y2="15" />
              <line x1="14" y1="15" x2="16" y2="15" />
              <line x1="8" y1="19" x2="10" y2="19" />
              <line x1="14" y1="19" x2="16" y2="19" />
            </svg>
            <span>查看结算</span>
          </a>
          <!-- v0.3.x (UAT #0723-3 #3): /s/{session_code}/settle#personal unguessable 格式 -->
          <a
            class="btn glass-pill btn-sm bills-action-link"
            href="/s/{session.session_code || String(session.id)}/settle#personal"
            aria-label="查看个人账单"
          >
            <!-- Lucide `user` 16x16 -->
            <svg
              class="bills-action-icon"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            <span>个人账单</span>
          </a>
        </div>
      </div>
      {#if bills.length === 0 && !loading}
        <!-- v0.3.27 (UAT 0723-2 #16): 去除 EmptyState 中央「+ 新建账单」CTA —
             页面右下角 FAB 已能创建, EmptyState 不重复入口 (跟 v0.3.25 #0723-EmptyState 同思路). -->
        <EmptyState
          icon="receipt"
          title="还没有账单"
          description="添加你的第一笔消费,自动计算分摊。"
        />
      {:else}
        <!-- v0.2.1 T05: 搜索 input (session 内账单 description 模糊匹配)。 -->
        <div class="bills-search-sentinel" bind:this={billsSearchSentinel} aria-hidden="true"></div>
        <div class="bills-search" class:is-stuck={billsSearchStuck}>
          <Search size={16} aria-hidden="true" />
          <!-- v0.3.21 #118 (PO msg 11:35 #7838 Bug 1 + Bug 4, #116 续): onfocus 调
               scrollSearchToSticky 把 search 预置到 sticky top: 8px, oninput 不调.
               - onfocus: 让 search 提前 sticky, 后续 iOS keyboard 弹起时浏览器自动
                 scrollIntoView 不会把 search 从 sticky 位拖到中部 (Bug 1 "消失在页面上方")
               - oninput 不调: filteredBills 变化时 search 位置保持 (Bug 4 "不应乱跳")
               v0.3.21 #112 全 onfocus+oninput 都调 → 都被 #116 删. #118 只保留 onfocus
               且加 visualViewport 守卫 (keyboard 弹起时 noop, 避免双 scroll). -->
          <input
            type="search"
            bind:value={billsSearchQuery}
            placeholder="搜索账单名称"
            aria-label="搜索账单名称"
            class="bills-search-input"
            onfocus={scrollSearchToSticky}
          />
          {#if billsSearchQuery}
            <button
              type="button"
              class="bills-search-clear"
              aria-label="清除搜索"
              onclick={() => (billsSearchQuery = '')}
            ><X size={14} /></button>
          {/if}
        </div>

        <BillListGrouped
          bills={filteredBills}
          totalBills={bills.length}
          sessionId={session.id}
          memberIdToName={memberIdToName}
          currentUserMemberId={currentMemberId}
          onDelete={requestDeleteBill}
          loading={loading}
          primaryCurrency={session.primary_currency}
          currencies={session.currencies}
          members={session.members}
        />
      {/if}
    </div>

    {#if undoQueue.length > 0}
      <!-- v0.2.1 T04: Undo banner (5s 自动消失)。每条 undoEntry 独立倒计时。
           多个删除栈叠, 后删的在最上面 (LIFO 视觉)。点击 [撤销] 立即恢复该 bill,
           其他条目继续倒计时。-->
      <div class="undo-stack" aria-live="polite">
        {#each [...undoQueue].reverse() as entry (entry.id)}
          {@const label = entry.snapshot.description ?? '(无说明)'}
          <div class="undo-toast" class:busy={entry.deleting || entry.restoring}>
            <span class="undo-msg">已删除「{label}」</span>
            <button
              type="button"
              class="undo-btn"
              disabled={entry.deleting || entry.restoring}
              onclick={() => undoDelete(entry.id)}
            >{entry.restoring ? '恢复中…' : entry.deleting ? '删除中…' : '撤销'}</button>
          </div>
        {/each}
      </div>
    {/if}

    <!-- v0.3.35 #3 — UAT 0725-3 #9 (PO msg #9088 batch): 二次确认 modal.
         PO 字面 "删除账单时要二次确认". Pattern 跟 SessionCard v0.3.25 #16 confirm-modal 复用.
         复用 .modal-backdrop / .modal-box / .btn-cancel / .btn-danger (CSS 在 v0.3.35 #3 block end of <style>).
         z-index 1000 (Toast.svelte .toast-root 9999 下, 普通 modal 999 上). -->
    {#if pendingDeleteBillId !== null}
      <div
        class="modal-backdrop"
        onclick={cancelDeleteBill}
        role="presentation"
      >
        <div
          class="modal-box"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-bill-modal-title"
          onclick={(e) => e.stopPropagation()}
        >
          <div class="modal-icon" aria-hidden="true">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
          </div>
          <h2 id="delete-bill-modal-title" class="modal-title">删除账单</h2>
          <p class="modal-desc">
            确定删除账单 <strong>「{pendingDeleteBillLabel}」</strong> 吗？
          </p>
          <p class="modal-desc modal-desc-secondary">
            此操作可在 5 秒内通过撤销按钮恢复
          </p>
          <div class="modal-actions">
            <button
              type="button"
              class="btn-cancel"
              onclick={cancelDeleteBill}
            >取消</button>
            <button
              type="button"
              class="btn-danger"
              onclick={confirmDeleteBill}
            >确认删除</button>
          </div>
        </div>
      </div>
    {/if}

    <!-- FAB: 200ms 后从下方 60px 飞入
         v0.3.16 #8 (PO msg 19:26): 加 .glass-pill 玻璃化 (保留 50% 圆形 + 白色 + icon) -->
    <!-- v0.3.x (UAT #0723-3 #3): /s/{session_code}/bills/new unguessable 格式 -->
    <a
      class="fab glass-pill"
      href="/s/{session.session_code || String(session.id)}/bills/new"
      title="新建账单"
      aria-label="新建账单"
      in:fly={{ y: 60, duration: 400, delay: 200 }}
    >+</a>
  {/if}

  <!-- v0.3.18 #53 + v0.3.19 #85: owner-driven modal.
       Mounted only when addCurrencyOpen=true (controlled by SessionCurrencyBadge
       onAddCurrency click from 单币种 pill 或 多币种整 bar).
       mode 跟 session.currencies.length 联动: 1=单币种 (add flow) / 2=多币种 (edit settings).
       has_bills 跟本地 bills.length 联动 (本组件已加载 bills).
       onAdded reloads the page so the badge re-renders with new currencies/rates. -->
  {#if addCurrencyOpen && session}
    <CurrencyAddModal
      session_id={session.id}
      primary_currency={session.primary_currency}
      existing_currencies={session.currencies}
      mode={session.currencies.length === 1 ? 'single' : 'multi'}
      has_bills={bills.length > 0}
      exchange_rates={session.exchange_rates ?? []}
      onAdded={() => window.location.reload()}
      dismiss={() => (addCurrencyOpen = false)}
      on:close={() => (addCurrencyOpen = false)}
    />
  {/if}
</section>

<style>
  /* === header ===
     v0.3.14 §3.14.1: 移除 `.primary-currency-tag` (单行 h2 内嵌 tag), 
     替换为 SessionCurrencyBadge 组件 (标题下方独立 dl-like grid)。
     设计推荐 4 条理由见 design_output.md 任务 A 第 1 节。*/
  /* v0.3.2 §3.12.3: `.session-header-actions` 整段删除 — 相关 CSS 也清理。
     保留是为了让后续 retro 引用，注释占位。*/

  /* §3.11 收尾: 详情页 header owner info 样式 */
  .owner-info {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    font-size: var(--font-size-sm);
  }
  .owner-nickname {
    font-weight: 600;
    color: var(--color-text, #171717);
  }
  .owner-email {
    font-size: var(--font-size-xs);
  }
  .owner-logout-btn {
    min-height: 32px;
    padding: 0 var(--space-3);
    border-radius: 9999px;
    border: 1px solid var(--color-border, #e5e5e5);
    background: var(--color-surface, #fff);
    color: var(--color-text, #525252);
    font-size: var(--font-size-xs);
    font-weight: 500;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s, background 0.15s;
  }
  .owner-logout-btn:hover:not(:disabled) {
    border-color: var(--color-accent, #3b82f6);
    color: var(--color-accent, #3b82f6);
  }
  .owner-logout-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  /* v0.3.2 §3.12.3: `.session-header-actions` 移动端 CSS 块一并清理（类已删）。

  /* === v0.3.18 #66 (PO #6899 Mockup A 精修列表): 列表布局彻底重写 ===
     Mockup A 的 8 项 review 修复全部落到 CSS, 字面移植 v0318-66-shared.css token。
     (1) 过期提示挪到 header 右上 inline pill (amber 50/700)
     (2) 删除冗余 chevron (header 本身 clickable)
     (3) owner 紫色 ring (皇冠 emoji v0.3.28 #6 已删)
     (4) owner+me 同 row 只显皇冠 + "me · owner" 微章
     (5) email 不截断 (word-break: break-all, 不设 max-width)
     (6) net 字号 13px / font-weight 700 / 首位
     (7) 1-member 紧凑 CTA banner
     (8) 768px 2-column grid */
  /* v0.3.0729-4 #13: 成员 section 背景与账单 section (.card = white) 一致 */
  .members-card {
    background: white;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    border-radius: 16px;
    /* v0.3.21 #110 (PO msg 18:46): padding 16 → 12.
       PO 反馈 section 垂直高度太高 + "查看 N 人" 离 section 底部太远.
       减少上下 padding 给 row1+row2+row3 留更多紧凑空间.
       v0.3.21 #112 (PO msg 02:53): padding-bottom 12 → 4.
       PO 反馈 "查看 6 人再往下移动一些". #110 让 hint 距 row3 底 0px,
       但距 section 视觉底边仍有 12 (card padding-bottom) + 12 (head margin-bottom)
       = 24px 空白. 把 card padding-bottom 减到 4px 让 hint 往下挪 8px;
       + head margin-bottom 12 → 0 再挪 12px (折叠态 6+ 成员 section
       head 下面没其他 element, margin 没用). 合计 hint 下移 20px,
       距 section 底边 4px (视觉贴底). */
    padding: 12px 12px 4px;
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.05);
  }

  /* v0.3.19 #83 (PO #7300): 折叠态 header 重构成 3 行布局 —
     row1 (40px) / row2 (36px) / row3 (24px). 整段仍 onclick + aria-expanded.
     v0.3.21 #110 (PO msg 18:46): gap 4 → 2 (整体更紧凑),
     padding-bottom 2 → 0 (去掉 row3 下方多余空白, 让 hint 更贴 section 底边). */
  .members-head {
    display: flex;
    flex-direction: column;
    gap: 2px;
    /* v0.3.20 #96 (PO msg 02:41 #7467): padding-bottom 10 -> 2.
       PO "查看 5 人下边空白太多". 保留 border-bottom (members section
       跟下面账单 section 的视觉分隔, 不是 row3 的底边)
       + margin-bottom 12px (section 间分隔, 跟 row3 无关).
       v0.3.20 #98 (PO msg 13:36 #7532 #3): 删 border-bottom.
       PO 反馈 "成员 section 的 查看 x 人的下方有一条线, 是分割线还是 button 的底边框?
       我不想要这条线". 整条线 (1px solid rgba(0,0,0,0.05)) 直接 none 掉, 不用 opacity.
       视觉分隔交给 margin-bottom: 12px (.members-card 跟下方 .bills-card 之间已有 12px 间距,
       加上 .bills-card 自带 padding-top, 足够断开两块). row3 的 border-top (在上方) 不动,
       那是 row2 <-> row3 之间的 affordance 分割 (跟这条线是不同 line).
       v0.3.21 #110: padding-bottom 2 → 0. 配合 .members-card padding 减半 + row3
       align-items: flex-end, "查看 N 人" 字样现在视觉上贴 section 底边.
       v0.3.21 #112 (PO msg 02:53): margin-bottom 12 → 0 (折叠态 only).
       PO 反馈 "查看 6 人再往下移动一些". 折叠态 6+ 成员 section 的 head
       下方没其他 element (solo-cta 只在 1-member 时出现), margin-bottom:12
       是死空白让 hint 离 card 底边更远. 只在 .collapsed 状态下清 0;
       展开态 head 后跟 .members-list 仍要 12px 间距. */
    padding: 0;
    margin: 0 0 12px 0;
    border-bottom: none;
    cursor: pointer;
    user-select: none;
  }
  /* v0.3.21 #112 (PO msg 02:53): 折叠态 head margin-bottom 0.
     让 "查看 N 人" 紧贴 .members-card padding-bottom (4px), 距 card 视觉
     底边 4px (从原 24px 减 20px). 展开态保持 12px (margin 跟 .members-list gap). */
  .members-head.collapsed {
    margin-bottom: 0;
  }
  /* v0.3.20 #93 (PO msg 00:04 #7450, Fix 6): removed .members-head:hover purple bg
     (PO 反馈"整个 section 点击 / hover 时 bg 变紫"奇怪 — 折叠态整 section 是 affordance,
     但 hover 时不应该把整块变紫; 视觉反馈靠 cursor:pointer + aria-expanded 就够了).
     保留 .members-head:focus-visible (a11y focus ring 不能去掉). */
  .members-head:focus-visible {
    outline: 2px solid var(--accent-500, #3b82f6);
    outline-offset: 2px;
  }
  .members-head-row1 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    /* v0.3.21 #110 (PO msg 18:46): min-height 32 → 26.
       row1 内容只装 "成员 · N人" 标题 + 可选 expiry pill, 26px 足够. */
    min-height: 26px;
  }
  /* v0.3.20 #92 (PO msg 07:13 #7409): row2 改成左右两栏 —
     左 (members-row2-left) = avatars (折叠态独有), 右 (members-row2-right) = InviteLinkButton (always).
     用 space-between 让两端对齐, margin-left: auto 在 right 上作为 fallback
     确保即使 left 是空 placeholder, invite 仍在最右.
     v0.3.20 #94 Fix 3 (PO msg 02:13 #7455): --invite-btn-h CSS var 跟 InviteLinkButton 高度联动,
     默认 48px (desktop), 767px 以下 44px (mobile 标准), 380px 以下 36px (按钮自带 mobile override).
     row min-height 28px → 40px (允许 var 48px 内容装下, 不被截).
     v0.3.21 #110 (PO msg 18:46): --invite-btn-h mobile 40/36/32 (默认 44 → 40, 380- 36 → 32),
     + min-height 40 → 36, 整 row 紧凑 ~6-8px. */
  .members-head-row2 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 36px;
    --invite-btn-h: 40px;
  }
  @media (max-width: 767px) {
    .members-head-row2 {
      --invite-btn-h: 40px;
    }
  }
  @media (max-width: 380px) {
    .members-head-row2 {
      --invite-btn-h: 32px;
    }
  }
  .members-row2-left {
    display: flex;
    align-items: center;
    flex: 1 1 auto;
    min-width: 0;
  }
  .members-row2-right {
    /* v0.3.0729-4 #2: 提示已挪到 .members-row2-left 左对齐；右侧只放邀请按钮。 */
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
    flex: 0 0 auto;
    margin-left: auto;
    min-width: 0;
    justify-content: flex-end;
  }
  /* v0.3.20 #94 Fix 6 (PO msg 02:13 #7455): "查看 N 人" 放分割线之下.
     之前 chevron + "查看 N 人" 直接挨在 row2 (avatar + invite) 下面, 没视觉分隔,
     PO 拍板 "跟 row1+row2 分开, 暗示这是 affordance 不是另一行信息".
     加 border-top: 1px solid rgba(0,0,0,0.05) 跟 .members-head 已有的
     border-bottom 同款 (折叠态独有 — row3 模板只在 {#if !membersOpen} 渲染,
     expanded 状态 row3 DOM 不存在, border 自然也不显, 不会影响 expanded 视觉).
     min-height 20 → 24 (border 1px + padding-top 视觉更平衡, 不被 border 挤). */
  .members-head-row3 {
    display: flex;
    /* v0.3.21 #110 (PO msg 18:46): align-items: center → flex-end.
       PO 反馈 "查看 N 人" 字样靠 section 底部对齐. 改 flex-end 后, chevron + hint
       在 row3 box 内贴底, 配合 .members-head padding-bottom:0 + .members-card
       padding-bottom:12, "查看 N 人" 视觉上贴 section 底边. */
    align-items: flex-end;
    justify-content: center;
    gap: 4px;
    /* v0.3.20 #96 (PO msg 02:41 #7467): min-height 24 -> 20.
       配合 .members-head padding-bottom 10 -> 2, 整体 row3 下方空白
       从 ~24px 降到 ~5px ("查看 N 人" 文字下到 .members-head
       border-bottom 之间).
       PO 明确 "上边有分割线就行, 下边不需要分割线" -- row3 本就没
       border-bottom (上方 border-top 保留作 row2 <-> row3 分隔),
       这里只调内部 min-height.
       v0.3.21 #110: min-height 20 → 16, padding-top 6 → 2. 整体 row3 更紧凑,
       + align-items flex-end 让 hint 贴 row3 底边. */
    min-height: 16px;
    margin-top: 2px;
    padding-top: 2px;
    border-top: 1px solid rgba(0, 0, 0, 0.05);
    color: var(--gray-400, #9ca3af);
  }
  .members-expand-chevron {
    flex-shrink: 0;
  }
  .members-expand-hint {
    font-size: 11px;
    font-weight: 400;
    color: var(--gray-400, #9ca3af);
    line-height: 1;
  }
  .members-head-left {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1 1 auto;
  }
  .members-title {
    margin: 0;
    font-size: 15px;
    font-weight: 700;
    color: var(--gray-900, #171717);
    letter-spacing: -0.005em;
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
  }
  /* v0.3.19 #83 (PO #7300): 成员 · N人 + users icon 14×14 gray-500 内联 */
  .members-title-a {
    margin: 0;
    /* v0.3.0729-5 #4: 与结算页 section-header glass-chip 同档 (16px / 600) */
    font-size: var(--font-size-md, 16px);
    font-weight: 600;
    color: var(--gray-900);
    letter-spacing: -0.005em;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 0 1 auto;
    min-width: 0;
    white-space: nowrap;
  }
  .members-title-icon {
    color: var(--gray-500, #737373);
    flex-shrink: 0;
  }
  .members-count-a {
    font-weight: 400;
    font-size: 12px;
    color: var(--gray-500, #737373);
    margin-left: 4px;
  }
  /* v0.3.20 #92 (PO msg 07:13 #7409): 删 .members-actions-a — expiry 已挪回 row1 单独渲染,
     InviteLinkButton 已挪到 row2 的 .members-row2-right. 容器不再需要. */

  /* Expiry inline pill (mockup A token: amber-50 bg + amber-700 text + border) */
  /* v0.3.19 #83 (PO #7300): amber 配色克制 — bg 保留 amber-50, 文字改 gray-700, 不抢 row1 L1 主信息. */
  .expiry-inline-a {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--gray-700, #404040);
    background: var(--amber-50, #fffbeb);
    border: 1px solid rgba(245, 158, 11, 0.18);
    border-radius: 999px;
    padding: 3px 9px 3px 7px;
    font-weight: 500;
    line-height: 1.2;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .expiry-inline-a svg {
    flex-shrink: 0;
    opacity: 0.85;
  }
  /* v0.3.31 #2 (UAT 0725-2 #2, PO msg ~20:03 字面): 匿名 owner 首次进入账单页文案 pill.
     视觉跟 .expiry-inline-a 同族 (pill shape + font-size 11px + gap 4px + border-radius 999px),
     配色改 red-50 系 (caution 色, 跟 amber / emerald 视觉同族但语义区分, 表示「未登录,链接唯一密钥」紧急).
     比 expiry-inline-a / expiry-saved-a 大一档 (font-size 13px / padding 6px 14px) — 主信息
     级而非备注级, 因为文案更长且承载 owner 首次进入的引导 + 提醒.  */
  .expiry-anon-a {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--red-700, #b91c1c);
    background: rgba(239, 68, 68, 0.10);
    border: 1px solid rgba(239, 68, 68, 0.25);
    border-radius: 999px;
    padding: 6px 14px;
    font-weight: 500;
    line-height: 1.4;
    white-space: normal;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    text-align: left;
    /* v0.3.0729-3 #2: 横向排列时 shrink 允许，避免撑出 row 宽度 */
    flex-shrink: 1;
    min-width: 0;
    /* v0.3.0729-4 #2: 与成员 section 左缘对齐，不再限宽 200px */
    max-width: 100%;
  }
  .expiry-anon-a svg {
    flex-shrink: 0;
    opacity: 0.95;
  }
  /* v0.3.36 #15 — UAT 0728-1 #15: 匿名 hint 文案两行 (PO 字面 "第一行 当前未登录 请收藏此链接, 第二行 这是您回到此账本的唯一密钥。")
     — 拆成 .line-1 + .line-2, 各自 display:block 垂直堆叠. pill 保留原 13px font-size + color + padding, 只调整内部 layout.
     .anon-hint-text 容器 inline-flex item 跟 svg 同行水平 baseline, 内部两行垂直堆叠.
     因为 .expiry-anon-a 是 inline-flex align-items: center, .anon-hint-text 仍按一行对待 (高度是 line-1 + line-2),
     svg 在 align-items center 中垂直居中 (跟两行整体中点对齐). */
  .expiry-anon-a .anon-hint-text {
    display: inline-flex;
    flex-direction: column;
    line-height: 1.4;
  }
  .expiry-anon-a .anon-hint-text .line-1 {
    display: block;
  }
  .expiry-anon-a .anon-hint-text .line-2 {
    display: block;
  }
  /* v0.3.28 (UAT 0723-3 #9): "已永久保存" 绿色版 — 跟 .expiry-inline-a 视觉同族 (pill shape + font-size 11px + gap 4px + border-radius 999px + flex-shrink 0), 配色改 emerald 系 (跟 .is-me ring / 已登录状态色系区分, 表示「已成功认领」). */
  .expiry-saved-a {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--emerald-700, #047857);
    background: var(--emerald-50, #ecfdf5);
    border: 1px solid rgba(16, 185, 129, 0.22);
    border-radius: 999px;
    padding: 3px 9px 3px 7px;
    font-weight: 500;
    line-height: 1.2;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .expiry-saved-a svg {
    flex-shrink: 0;
    opacity: 0.95;
  }
  /* v0.3.20 #93 (PO msg 00:04 #7450, Fix 8): anon session 登录 CTA 样式.
     跟 expiry pill 同款 glass amber-50 bg, 但 link 用紫色 accent 链接色, 不抢主信息. */
  .expiry-cta-sep {
    color: var(--gray-400, #9ca3af);
    margin: 0 4px;
    opacity: 0.7;
  }
  .expiry-cta-link {
    color: var(--accent-700, #4338ca);
    text-decoration: none;
    font-weight: 500;
    transition: color 150ms ease;
  }
  .expiry-cta-link:hover {
    color: var(--accent-800, #3730a3);
    text-decoration: underline;
  }
  .expiry-cta-link:focus-visible {
    outline: 2px solid var(--accent-500, #3b82f6);
    outline-offset: 2px;
    border-radius: 4px;
  }
  .expiry-cta-suffix {
    color: var(--gray-600, #525252);
  }

  /* === Member list — 列表布局 (替代旧 chip 圆角 999px) === */
  .members-list-a {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  /* Mockup A row: grid 36px 1fr auto, 头像 + 信息 + (可选) remove */
  .member-row-a {
    display: grid;
    grid-template-columns: 36px 1fr auto;
    align-items: center;
    gap: 12px;
    padding: 8px 0;
    border-bottom: 1px solid rgba(0, 0, 0, 0.04);
    border-radius: 8px;
    transition: background-color 150ms ease-out;
  }
  .member-row-a:last-child {
    border-bottom: none;
  }
  /* v0.3.23 #138 (UAT bug #13): 删 .member-row-a:hover 背景变 — 反馈
     "成员 row hover 没意义, 整块颜色变化只是干扰". 删除该规则,
     member-row-a 在 hover 时保持默认背景. */
  .member-row-a.is-owner {
    background: linear-gradient(90deg, rgba(168, 85, 247, 0.04) 0%, transparent 60%);
    border-radius: 10px;
  }

  .member-row-a.is-me {
    background: rgba(59, 130, 246, 0.04);
    border-radius: 10px;
  }

  /* Avatar — 36px, 5 色循环 (indigo/pink/emerald/amber/blue) + owner 紫色 ring */
  /* v0.3.19 #83 (PO #7300): 加玻璃质感 — 2px 白边 + shadow + inset highlight, 36px 更立体. */
  /* v0.3.23 #132 (UAT old #4, PO msg 17:16 option B): 加 backdrop-filter + 强化 glass shadow */
  .avatar-a {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: linear-gradient(135deg, rgba(129, 140, 248, 0.88) 0%, rgba(99, 102, 241, 0.88) 100%);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 13px;
    flex-shrink: 0;
    position: relative;
    border: 2px solid rgba(255, 255, 255, 0.5);
    /* Option B: backdrop-filter (与 palette 0.88 alpha 渐变配合) */
    backdrop-filter: blur(4px) saturate(180%);
    -webkit-backdrop-filter: blur(4px) saturate(180%);
    /* glass shadow: top highlight + bottom lowlight + outer lift */
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.5),
      inset 0 -1px 0 rgba(0, 0, 0, 0.08),
      0 1px 2px rgba(0, 0, 0, 0.08),
      0 4px 12px rgba(0, 0, 0, 0.08);
  }
  .avatar-a.b {
    background: linear-gradient(135deg, rgba(244, 114, 182, 0.88) 0%, rgba(236, 72, 153, 0.88) 100%);
  }
  .avatar-a.c {
    background: linear-gradient(135deg, rgba(52, 211, 153, 0.88) 0%, rgba(16, 185, 129, 0.88) 100%);
  }
  .avatar-a.d {
    background: linear-gradient(135deg, rgba(251, 191, 36, 0.88) 0%, rgba(245, 158, 11, 0.88) 100%);
  }
  .avatar-a.e {
    background: linear-gradient(135deg, rgba(96, 165, 250, 0.88) 0%, rgba(59, 130, 246, 0.88) 100%);
  }
  /* v0.3.19 #83 (PO #7300): template 用 palette-{i%5}, 补补 CSS */
  .avatar-a.palette-0 {
    background: linear-gradient(135deg, rgba(129, 140, 248, 0.88) 0%, rgba(99, 102, 241, 0.88) 100%);
  }
  .avatar-a.palette-1 {
    background: linear-gradient(135deg, rgba(244, 114, 182, 0.88) 0%, rgba(236, 72, 153, 0.88) 100%);
  }
  .avatar-a.palette-2 {
    background: linear-gradient(135deg, rgba(52, 211, 153, 0.88) 0%, rgba(16, 185, 129, 0.88) 100%);
  }
  .avatar-a.palette-3 {
    background: linear-gradient(135deg, rgba(251, 191, 36, 0.88) 0%, rgba(245, 158, 11, 0.88) 100%);
  }
  .avatar-a.palette-4 {
    background: linear-gradient(135deg, rgba(96, 165, 250, 0.88) 0%, rgba(59, 130, 246, 0.88) 100%);
  }
  /* v0.3.0728-2 #20 解冻: 5 → 10 扩色 (palette-5..9) — 跟 palette.ts AVATAR_GRADIENTS 字段级同 */
  .avatar-a.palette-5 {
    background: linear-gradient(135deg, rgba(244, 63, 94, 0.88) 0%, rgba(217, 70, 239, 0.88) 100%);
  }
  .avatar-a.palette-6 {
    background: linear-gradient(135deg, rgba(132, 204, 22, 0.88) 0%, rgba(34, 197, 94, 0.88) 100%);
  }
  .avatar-a.palette-7 {
    background: linear-gradient(135deg, rgba(14, 165, 233, 0.88) 0%, rgba(59, 130, 246, 0.88) 100%);
  }
  .avatar-a.palette-8 {
    background: linear-gradient(135deg, rgba(139, 92, 246, 0.88) 0%, rgba(236, 72, 153, 0.88) 100%);
  }
  .avatar-a.palette-9 {
    background: linear-gradient(135deg, rgba(249, 115, 22, 0.88) 0%, rgba(239, 68, 68, 0.88) 100%);
  }
  .avatar-a.is-owner {
    box-shadow: 0 0 0 2px #fff, 0 0 0 4px rgba(168, 85, 247, 0.55);
  }
  .avatar-a.is-me {
    box-shadow: 0 0 0 2px #fff, 0 0 0 4px rgba(59, 130, 246, 0.55);
  }

  /* Member info — name + meta row */
  .member-info-a {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .member-name-row-a {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    min-width: 0;
  }
  .member-name-a {
    font-size: 14px;
    font-weight: 600;
    color: var(--gray-900, #171717);
    /* Mockup A fix #5: email 不截断 → name 也不 ellipsis */
    overflow: visible;
    text-overflow: clip;
    white-space: normal;
    word-break: break-word;
    line-height: 1.3;
  }
  /* owner tag (只有 owner 是别人时显示) — 紫色玻璃 pill */
  .owner-tag-a {
    display: inline-block;
    font-size: 10px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 999px;
    background: linear-gradient(135deg, rgba(168, 85, 247, 0.14), rgba(99, 102, 241, 0.14));
    color: #6d28d9;
    line-height: 1.3;
  }
  /* me 微章 — 蓝色圆点 + 文字, owner+me 同行时显示 "me · owner" */
  .me-dot-a {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 10px;
    color: var(--accent-700, #1d4ed8);
    font-weight: 600;
    line-height: 1;
  }
  .me-dot-a::before {
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent-500, #3b82f6);
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.18);
  }

  /* Meta row — net 13px 首位 + email 不截断 */
  .member-meta-a {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 11px;
    color: var(--gray-500, #737373);
    line-height: 1.4;
  }
  .member-net-a {
    font-size: 13px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
  }
  .member-net-a.pos {
    color: var(--color-success, #059669);
  }
  .member-net-a.neg {
    color: var(--color-danger, #dc2626);
  }
  /* Mockup A fix #5: email 不截断 (旧版 max-width: 200px + ellipsis 改成 break-all 完整显示) */
  .member-email-a {
    font-size: 11px;
    color: var(--gray-500, #737373);
    word-break: break-all;
  }

  /* v0.3.23 #138 (UAT bug #13): 删 .member-remove-a 整套 CSS — 按钮已删 (template 注释),
     orphan rules. 未来 BE 支持 removeMember 后重新启用按钮时, 可从 git history 还原. */

  /* v0.2.1 UI rev: 折叠态 header 内嵌 avatar 预览 (max 8 + overflow) */
  /* v0.3.19 #83 (PO #7300): 18px, -6px overlap (不再用 -8px, 18px 间距 -6 视觉刚好). */
  /* v0.3.0728-3 #8 (PO msg 16:35 #3 fix #8 字面): 多成员时 avatar 不应被压缩变椭圆,
     保留原形状 + 允许左右滑动 + iOS 弹性 (rubber band).
     根因: 旧 `overflow:hidden` + 默认 `flex-shrink:1` 子元素 → 容器太窄时 avatar 收缩变形.
     修法: overflow-x:auto + flex-shrink:0 + overscroll-behavior-x:contain (iOS 弹性). */
  .members-avatars-inline {
    display: inline-flex;
    align-items: center;
    gap: 0;
    flex: 1 1 auto;
    min-width: 0;
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-x: contain;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  .members-avatars-inline::-webkit-scrollbar {
    display: none;
  }
  /* v0.3.20 #94 Fix 3 (PO msg 02:13 #7455): 折叠态 row2 头像高度 = InviteLinkButton 高度.
     之前 .members-avatars-inline .avatar-mini 18×18, 跟 InviteLinkButton 48px (desktop) / 44px
     (iOS touch) / 36px (mobile override @ <380px) 完全不匹配, 视觉上 button 比 avatar 高 30+px,
     折叠态 row2 左右两端不齐.

     修法 (CSS var 联动, 不硬编码):
     - 在 .members-head-row2 定义 --invite-btn-h, 默认 48px (desktop InviteLinkButton 实际高).
     - @media (max-width: 767px) → 44px (iOS touch target, 跟 button 在 mobile 大多 viewport 一致).
     - @media (max-width: 380px) → 36px (匹配 InviteLinkButton 自带 mobile override).
     - .members-avatars-inline .avatar-mini 改用 var(--invite-btn-h) 控制 width/height.
     - font-size 按比例: var * 0.32 (~15px at 48, ~14px at 44, ~12px at 36).
     - margin-left 按比例: var * -0.25 (~-12px at 48, ~-11px at 44, ~-9px at 36), 25% overlap.
     保留 base .avatar-mini 32×32 + font-size 12px (其他页面 BillForm / settle 等复用).
     保留 palette-{i%5} 渐变 + overflow "+N" tag.
     SessionMemberList 组件**不**改 (其他页面独立使用 28×28, 跨页面一致性不破坏). */
  .members-avatars-inline .avatar-mini {
    width: var(--invite-btn-h, 48px);
    height: var(--invite-btn-h, 48px);
    font-size: calc(var(--invite-btn-h, 48px) * 0.32);
    margin-left: calc(var(--invite-btn-h, 48px) * -0.25);
    flex-shrink: 0;
  }
  .members-avatars-inline .avatar-mini:first-child {
    margin-left: 0;
  }
  /* v0.3.19 #83 (PO #7300): 折叠态 mini avatar 用 palette-{i%5} 渐变 (复用 v0.3.18 #66 token).
     删掉之前 .avatar-mini { background: var(--accent-500) } 单色. */
  /* v0.3.23 #132 (UAT old #4, PO msg 17:16 option B): 加 backdrop-filter + 强化 glass shadow */
  .avatar-mini {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 12px;
    border: 1.5px solid #fff;
    /* Option B: backdrop-filter 让 rgba 0.88 渐变在 glass parent 上有 glass on glass 效果 */
    backdrop-filter: blur(4px) saturate(180%);
    -webkit-backdrop-filter: blur(4px) saturate(180%);
    /* glass shadow: top highlight + bottom lowlight + outer lift */
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.5),
      inset 0 -1px 0 rgba(0, 0, 0, 0.08),
      0 1px 2px rgba(0, 0, 0, 0.08),
      0 1px 2px rgba(0,0,0,0.10);
    user-select: none;
    position: relative;
  }
  .avatar-mini.palette-0 {
    background: linear-gradient(135deg, rgba(129, 140, 248, 0.88), rgba(99, 102, 241, 0.88));
  }
  .avatar-mini.palette-1 {
    background: linear-gradient(135deg, rgba(244, 114, 182, 0.88), rgba(236, 72, 153, 0.88));
  }
  .avatar-mini.palette-2 {
    background: linear-gradient(135deg, rgba(52, 211, 153, 0.88), rgba(16, 185, 129, 0.88));
  }
  .avatar-mini.palette-3 {
    background: linear-gradient(135deg, rgba(251, 191, 36, 0.88), rgba(245, 158, 11, 0.88));
  }
  .avatar-mini.palette-4 {
    background: linear-gradient(135deg, rgba(96, 165, 250, 0.88), rgba(59, 130, 246, 0.88));
  }
  /* v0.3.0728-2 #20 解冻: 5 → 10 扩色 (palette-5..9) — 跟 SessionCard 同源 */
  .avatar-mini.palette-5 {
    background: linear-gradient(135deg, rgba(244, 63, 94, 0.88), rgba(217, 70, 239, 0.88));
  }
  .avatar-mini.palette-6 {
    background: linear-gradient(135deg, rgba(132, 204, 22, 0.88), rgba(34, 197, 94, 0.88));
  }
  .avatar-mini.palette-7 {
    background: linear-gradient(135deg, rgba(14, 165, 233, 0.88), rgba(59, 130, 246, 0.88));
  }
  .avatar-mini.palette-8 {
    background: linear-gradient(135deg, rgba(139, 92, 246, 0.88), rgba(236, 72, 153, 0.88));
  }
  .avatar-mini.palette-9 {
    background: linear-gradient(135deg, rgba(249, 115, 22, 0.88), rgba(239, 68, 68, 0.88));
  }
  .avatar-mini-overflow {
    background: var(--gray-300, #d1d5db) !important;
    color: var(--gray-700, #374151) !important;
    font-weight: 600;
  }

  /* v0.3.18 #66 (PO #6899 Mockup A) 8: 768px tablet 2-column grid */
  @media (min-width: 768px) {
    .members-list-a {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px 16px;
    }
    .member-row-a {
      padding: 12px;
      background: rgba(255, 255, 255, 0.4);
      border: 1px solid rgba(0, 0, 0, 0.04);
      border-radius: 12px;
    }
    .member-row-a:last-child {
      border-bottom: 1px solid rgba(0, 0, 0, 0.04);
    }
    .solo-cta-a {
      grid-column: 1 / -1;
    }
  }

  /* Mockup A SE 320px compact mode */
  @media (max-width: 360px) {
    .members-head {
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
    }
    .members-actions {
      width: 100%;
      justify-content: space-between;
    }
    .expiry-inline-a {
      font-size: 10px;
      padding: 2px 7px 2px 5px;
    }
    .member-row-a {
      grid-template-columns: 32px 1fr 28px;
      gap: 8px;
    }
    .avatar-a {
      width: 32px;
      height: 32px;
      font-size: 12px;
    }
    .avatar-a { width: 32px; height: 32px; font-size: 12px; }
  }

  /* 移动端 ≤480px: row 紧凑 */
  @media (max-width: 480px) {
    .members-card {
      /* v0.3.21 #112 (PO msg 02:53): padding 12 → 12px 12px 4px (mobile 同步).
         跟 base 一致, 让折叠态 "查看 N 人" 下移到 card 视觉底边 4px. */
      padding: 12px 12px 4px;
    }
  }
  /* === bills section header ===
   * v0.3.28 UAT 0724-1 #1: 标题 (icon + 账单) + 查看结算/个人账单按钮 不再用框框起来.
   * 跟 .members-head 完全同源: 0 bg / 0 border / 0 opacity / 0 padding, 视觉纯文字 header.
   * flex-wrap 让按钮在一行右挤不下时自然换行 (PO 字面: 同一行右侧, 一行放不下就下一行右侧).
   * 边框盒感交付给 .bills-card 容器本身 (跟 .members-card 同源). */
  .bills-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
    /* v0.3.0729-2 #4: 用 padding-bottom 代替 margin-bottom, 避免跟 .bills-search
       margin-top 发生 margin-collapse (旧 collapse 后视觉 gap ≈16px, PO 要 ~32px).
       padding 不 collapse → 16px padding + 16px search margin = 32px 视觉间距. */
    margin-bottom: 0;
    padding: 0 0 var(--space-4);
    background: none;
    border: none;
    opacity: 1;
  }
  .bills-card-head-left {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-3);
    min-width: 0;
    flex: 1 1 auto;
  }
  .bills-card-title {
    margin: 0;
    /* v0.3.0729-5 #4: 与结算页 section-header / members-title-a 同档 (16px / 600). */
    font-size: var(--font-size-md, 16px);
    font-weight: 600;
    color: var(--gray-900, #171717);
    letter-spacing: -0.005em;
    /* v0.3.28 (UAT 0723 batch #9): 加 inline icon 后改 flex 排版 — 跟 members-title-a 一致. */
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 0 1 auto;
    min-width: 0;
    white-space: nowrap;
  }
  .bills-card-title-icon {
    /* v0.3.28 (UAT 0723 batch #9): 跟 members-title-icon 同源 — gray-500 + flex-shrink 0. */
    color: var(--gray-500, #737373);
    flex-shrink: 0;
  }
  .bills-card-count {
    font-size: var(--font-size-sm);
  }
  /* v0.3.2 §3.12.3: head-right 容器，gap 8px 并排两个 ghost btn。
     视觉候选 B（PO 10:30 拍板）+ spec §3.12.D: ghost + Lucide inline SVG 图标。
     移动端不换行（flex-wrap 不设到 right 子容器）。*/
  .bills-card-head-right {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex-wrap: nowrap;
  }
  .bills-action-link {
    min-height: 36px;
    padding: 4px 12px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }
  .bills-action-icon {
    flex: 0 0 auto;
  }
  /* 旧 `.bills-personal-link` 在 v0.3.2 改名 `.bills-action-link` 并彻底弃用。
     CSS 块删除 — svelte-check 现不再报 unused-selector 警告。*/
  @media (max-width: 480px) {
    .bills-card-head-left {
      flex: 1 1 auto;
      min-width: 0;
    }
    .bills-card-head-right {
      flex: 0 0 auto;
    }
    .bills-action-link {
      flex: 0 0 auto;
    }
  }

  /* === FAB ===
     v0.1.4 round 2 改动 2: `+` 居中对齐修复。
     原因: Inter font 里 `+` baseline 偏上 (mathematical center ≠ optical center),
     用 grid + place-items: center 完美居中, 再 padding-bottom: 2px 视觉补偿,
     让 `+` 在圆形按钮里看起来完全居中。
     v0.3.16 #8 (PO msg 19:26): 加 .glass-pill 玻璃化 — bg/box-shadow/border 由
       .glass-pill 提供。
     v0.3.16 #10 (PO msg 20:38): FAB icon 改主题色 — 删 color: #fff (`+` 白色在浅紫
       玻璃上看不清),改由 .glass-pill 提供 var(--accent-700, #4338ca) 深紫主题色
       (跟 bills/new/edit/settle 的 .fab 一致)。 */
  .fab {
    position: fixed;
    right: 28px;
    bottom: 28px;
    width: 80px;
    height: 80px;
    border-radius: 50%;        /* 圆形覆盖 .glass-pill 的 999px */
    /* v0.3.27-#17 (PO 0723-3 续): FAB bg 条件化 — 有 bills 浅色 (v0.3.17 原值),
       0 bills 深色 (.emphasized 状态). 取消箭头改走颜色引导路径. */
    background: linear-gradient(135deg, rgba(99,102,241,0.04) 0%, rgba(59,130,246,0.02) 100%);
    border: 1px solid rgba(99,102,241,0.18);
    /* 删 color: #fff — 由 .glass-pill 提供 var(--accent-700, #4338ca) 深紫主题色 */
    font-size: 36px;
    font-weight: 300;
    line-height: 1;
    z-index: 50;
    cursor: pointer;
    display: grid;            /* 改 grid */
    place-items: center;      /* 完美居中 */
    padding: 0;
    padding-bottom: 3px;      /* 视觉补偿: + 在 Inter 里偏上, 下移 2px 视觉居中 */
    text-decoration: none;
    transition: transform 150ms ease, box-shadow 150ms ease, background 150ms ease, color 150ms ease;
  }
  /* .fab:hover 不再写 color — 由 .glass-pill:hover 全局处理 (icon 颜色保持主题色) */
  .fab:hover {
    transform: translateY(-2px);
    text-decoration: none;
  }
  /* v0.3.27-#17 (PO 0723-3 续): 0 bills 状态 — FAB 颜色更深以引导创建.
     跟 .fab 默认浅色对比: bg alpha 0.04/0.02 → 0.18/0.14 (+0.14), border 1px 0.18 → 1.5px 0.35. */
  .fab.emphasized {
    background: linear-gradient(135deg, rgba(99,102,241,0.18) 0%, rgba(59,130,246,0.14) 100%);
    border: 1.5px solid rgba(99,102,241,0.35);
  }
  .fab:active {
    transform: scale(0.96);
  }
  .fab:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }
  @media (max-width: 600px) {
    .fab {
      right: 20px;
      bottom: 20px;
    }
  }

  /* v0.3.20 #93 (Fix 7): --bills-search-h — BillListGrouped 的 day-header 通过此变量
     计算 sticky top 偏移. 50px = 搜索框实际高度 (padding 8x2 + input line-height ~16
     + border 1x2) + 12px breathing room (原 margin-bottom).
     v0.3.20 #94 Fix 5 (PO msg 02:13 #7455): --bills-search-h 50px → 60px.
     搜索框 padding-top 加 10px (8→18, 给 sticky top 上方留呼吸空间, 不贴 nav bar),
     搜索框实际高度从 ~38px 变 ~48px, sticky region 同步加 10px → 60px (50+10).
     v0.3.29 (UAT 0725-1 #1, PO msg 12:43): 搜索框 50px 太胖, 改回 ~44px (padding 11px).
     同步 --bills-search-h 60px → 54px (search 实际高度 -6px, region 同步减 6px 保持
     day-header sticky offset 一致). */
  .bills-card {
    /* v0.3.0729-4 #11: 日期 header 透明度进一步降低 (0.68 → 0.42) */
    --bills-sticky-glass-bg: rgba(255, 255, 255, 0.42);
    --bills-sticky-glass-filter: saturate(200%) blur(24px);
    --bills-search-h: 48px;
    padding-bottom: 96px;
  }

  .bills-search-sentinel {
    height: 1px;
    margin: 0;
    padding: 0;
    pointer-events: none;
    visibility: hidden;
  }

  .btn-sm {
    min-height: 36px;
    padding: 4px 10px;
    font-size: var(--font-size-sm);
  }

  /* v0.2.1 T05: 账单搜索框.
     v0.3.20 #93 (PO msg 00:04 #7450, Fix 7): sticky 跟随 page scroll,
     滚到任何位置搜索框常驻顶部 (跟全站 NavBar 一起保持可达).
     用 z-index: 20 高于 day-header (10) 让搜索框视觉上浮在 day-header 上;
     backdrop blur + saturate 跟全站玻璃语言一致.
     v0.3.20 #94 Fix 5 (PO msg 02:13 #7455): padding-top 8px → 18px (加 10px),
     给搜索框上方留呼吸空间 (sticky top:0 紧贴 nav bar, 视觉太挤).
     其他 padding-bottom 8px + 左右 12px 不变.
     同步 --bills-search-h 50px → 60px (search region 加 10px, day-header sticky top 偏移跟着加).
     v0.3.20 #98 (PO msg 13:36 #7532 #2): sticky top 0 → var(--space-2) (~8px).
     之前 top:0 让 sticky 搜索框贴 NavBar 下边 (z-index 50 vs 20, NavBar 盖在上),
     视觉零间距. PO 反馈"搜索框上方贴页面 header 贴的太多紧了, 要留点空隙".
     改用 --space-2 spacing token 跟全站 spacing 一致; 不动 --bills-search-h
     (那是搜索框自身高度, sticky top offset 是另一回事, BillListGrouped day-header
     偏移由 --bills-search-h 推算, 不受 top 影响). */
  .bills-search {
    position: sticky;
    top: var(--space-2);
    z-index: 20;
    isolation: isolate;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-4);
    padding: 12px 14px;
    min-height: 40px;
    line-height: 1.4;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-md, 8px);
    color: var(--gray-500);
  }
  /* 默认（未 sticky）：仅搜索框本体的玻璃，不盖住上方标题/按钮 */
  .bills-search::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    background: rgba(255, 255, 255, 0.55);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    z-index: -2;
    pointer-events: none;
  }
  /* sticky 时边框固定在搜索框本体 (不随 blur 层上移) */
  .bills-search::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-md, 8px);
    z-index: -1;
    pointer-events: none;
    background: transparent;
  }
  /* v0.3.0729-2 UAT #4 v2: sticky 仅向上铺 blur, 边框留在搜索框原位 (::after). */
  .bills-search.is-stuck::before {
    top: calc(-1 * var(--bills-search-stuck-bleed, 0px));
    border: none;
    box-shadow: none;
    border-radius: 0;
    background: var(--bills-sticky-glass-bg);
    backdrop-filter: var(--bills-sticky-glass-filter);
    -webkit-backdrop-filter: var(--bills-sticky-glass-filter);
  }
  .bills-search.is-stuck::after {
    border-color: var(--color-border, #e5e7eb);
  }
  @supports not (backdrop-filter: blur(1px)) {
    .bills-search {
      background: var(--color-bg, #f9fafb);
    }
    .bills-search::before {
      background: rgba(249, 250, 251, 0.95);
    }
    .bills-search.is-stuck::before {
      background: rgba(249, 250, 251, 0.95);
    }
  }
  .bills-search-input {
    flex: 1;
    border: 0;
    background: transparent;
    font-size: var(--font-size-sm, 14px);
    color: var(--gray-900);
    padding: 0;
    min-width: 0;
    /* v0.3.20 #95 Fix 4 (PO msg 02:41 #7459): <input type="search"> 在 iOS Safari
       上默认 line-height ≈ 1.2 (normal), 跟 padding 4px 叠加后 input 物理高度
       ~25px, 但 flex 父 .bills-search 有 padding 18 + 8 = 26px, 加上 .Search icon,
       实际视觉高度 ~62px. 默认 line-height 在 iOS 让 input text "top-aligned".
       修法: line-height: 1 (跟 font-size 同高 14px), text 精确居中在 font 高度.
       不改 input 高度 (padding 4 + content 14 + 4 = 22px) — 仍由 flex
       align-items: center 把它放在父容器中央.
       v0.3.20 #98 (PO msg 13:36 #7532 #1): placeholder 文字仍未 vertical-center.
       v0.3.20 #95 只设了 line-height: 1, 但 <input type="search"> 在 iOS Safari
       有自己的 intrinsic min-height (~22px) + native search 控件 padding (X button
       内部留位), 让 placeholder 文字 baseline 偏 input 顶部 ~2-3px. PO 在 iPhone 13
       (iOS Safari) 真机实测仍 "文字贴上边".
       修法: 显式 height + line-height 匹配 (height 22px = font-size 14 + 内边距 8),
       -webkit-appearance: none 重置 Safari native search 样式 (去 X button 内部
       padding 占位, 去默认 min-height), margin: 0 去 Safari 默认外边距.
       font: inherit (隐含) 保证 placeholder 跟 input 用同一 font metrics.
       text-align: left 显式声明 (Safari <input type="search"> 默认 center 在某些
       iOS 版本, 跟 text input 不一致). 整个 input 高度 22px 后, flex 父 align-items: center
       把它放在搜索框中央, placeholder 跟实际输入文字位置完全一致.
       v0.3.22 #124 (UAT bug #6, PO msg 16:05 #8064): 加 ::-webkit-search-cancel-button
       { display: none }, 因为 -webkit-appearance: none 只重置样式不真隐藏 native X,
       Chromium computed style 实测 display=block width=246px (跟 input 同宽), 让 native
       跟自定义 .bills-search-clear X 两个一起渲染. 验证 BEFORE 截图看到 2 个 X (左 native,
       右 custom). 真正隐藏需 display: none. */
    height: 22px;
    line-height: 22px;
    margin: 0;
    -webkit-appearance: none;
    appearance: none;
    text-align: left;
  }
  /* v0.3.22 #124 (UAT bug #6, PO msg 16:05 #8064): Svelte scoped style
     加 hash 后的 selector (.bills-search-input.s-XXXX::-webkit-search-cancel-button)
     Chromium 实测 display: none 不生效 (webkit 伪元素在 scoped context 兼容性
     不可靠). 用 :global() 强制不 scope 让原生 selector 直接生效. */
  :global(.bills-search-input::-webkit-search-cancel-button) {
    -webkit-appearance: none;
    appearance: none;
    display: none !important;
  }
  .bills-search-input:focus {
    outline: none;
  }
  .bills-search-clear {
    appearance: none;
    background: transparent;
    border: 0;
    cursor: pointer;
    color: var(--gray-500);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    /* v0.3.21 #112 (PO msg 02:53): 三种状态高度不一致 (emptyNotFocused=50, emptyFocused=50, hasText=72).
       全局 button 默认 min-height: var(--touch-target)=44px (iOS 44px tap target),
       X button 在 .bills-search-input (22px) 旁边是个 44px 高按钮, 撑高整个
       .bills-search container 从 50 → 72px (+44%). 改 min-height: 22px 跟 input 对齐,
       三状态统一 50px. */
    min-height: 22px;
    border-radius: 50%;
  }
  .bills-search-clear:hover {
    background: var(--color-border, #e5e7eb);
    color: var(--gray-900);
  }

  /* v0.2.1 T04: 删除撤销 banner (底部, 多条栈叠)
   * v0.3.35 #2 (UAT 0725-3 #10): bottom 96px → calc(80px + 56px + var(--space-2))
   *   .toast-root 在 Toast.svelte bottom:80px (z-index 9999). 撤销 stack 原 96px 跟 toast 几乎重叠
   *   (差 16px), PO 真机报"撤销按钮位置要高一点, 目前和 toast 互相挡住了". 修法: 抬高撤销 stack
   *   到 144px, 让 undo toast 完全在普通 toast 之上 + 8px gap (假设单 toast 高 ~40-48px). */
  .undo-stack {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    bottom: calc(80px + 56px + var(--space-2));
    z-index: 60;
    display: flex;
    flex-direction: column-reverse; /* 最新删的在最上面 */
    gap: var(--space-2);
    pointer-events: none;
    max-width: calc(100vw - 32px);
  }
  .undo-toast {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    background: var(--gray-900, #111827);
    color: #fff;
    border-radius: 999px;
    padding: 10px 8px 10px 18px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
    font-size: var(--font-size-sm, 14px);
    white-space: nowrap;
    max-width: 100%;
  }
  .undo-msg {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .undo-btn {
    appearance: none;
    background: var(--accent-500, #3b82f6);
    color: #fff;
    border: 0;
    border-radius: 999px;
    padding: 4px 14px;
    font-weight: 600;
    font-size: var(--font-size-sm, 13px);
    cursor: pointer;
    min-height: 32px;
    transition: background-color 150ms ease;
  }
  .undo-btn:hover {
    background: var(--accent-700, #1d4ed8);
  }
  .undo-btn:active {
    transform: scale(0.97);
  }
  /* v0.2.1 Sprint 2 T04: 删除/恢复进行中 — 按钮 disable + 视觉灰化 */
  .undo-btn:disabled {
    cursor: not-allowed;
    opacity: 0.7;
    background: var(--gray-500, #6b7280);
  }
  .undo-btn:disabled:hover {
    background: var(--gray-500, #6b7280);
  }
  .undo-toast.busy {
    opacity: 0.85;
  }

  /* === utility classes (token-migrated) === */
  .muted {
    color: var(--gray-500);
  }

  .small {
    font-size: var(--font-size-sm);
  }

  /* v0.3.35 #3 — UAT 0725-3 #9 (PO msg #9088 batch): 二次确认 modal CSS.
   * 复用 SessionCard v0.3.25 #16 confirm-modal token (template line 540-620 + CSS line 985-1075).
   * z-index 1000 (Toast.svelte .toast-root 9999 下, 普通 modal 999 上). */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.10);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    animation: fade-in 160ms ease;
  }
  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .modal-box {
    background: rgba(255, 255, 255, 0.92);
    backdrop-filter: saturate(2) blur(20px);
    -webkit-backdrop-filter: saturate(2) blur(20px);
    border: 1.5px solid rgba(255, 255, 255, 0.78);
    border-radius: 18px;
    padding: 24px;
    max-width: 340px;
    width: 100%;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.88),
      0 8px 32px rgba(15, 23, 42, 0.16);
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    animation: pop-in 200ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  @keyframes pop-in {
    from {
      opacity: 0;
      transform: scale(0.94) translateY(8px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }
  .modal-icon {
    width: 56px;
    height: 56px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(
      135deg,
      rgba(239, 68, 68, 0.18) 0%,
      rgba(220, 38, 38, 0.10) 100%
    );
    border: 1.5px solid rgba(239, 68, 68, 0.32);
    border-radius: 50%;
    color: rgba(220, 38, 38, 0.95);
    margin-bottom: 14px;
  }
  .modal-title {
    font-size: 17px;
    font-weight: 700;
    color: var(--gray-900, #0f172a);
    margin: 0 0 10px 0;
    line-height: 1.3;
  }
  .modal-desc {
    font-size: 14px;
    color: var(--gray-700, #334155);
    margin: 0 0 6px 0;
    line-height: 1.5;
  }
  .modal-desc strong {
    color: var(--gray-900, #0f172a);
    font-weight: 600;
  }
  .modal-desc-secondary {
    font-size: 13px;
    color: var(--gray-500, #64748b);
    margin-bottom: 18px;
  }
  .modal-actions {
    display: flex;
    gap: 10px;
    width: 100%;
  }
  .btn-cancel {
    flex: 1;
    appearance: none;
    background: rgba(255, 255, 255, 0.6);
    border: 1px solid rgba(15, 23, 42, 0.10);
    border-radius: 999px;
    padding: 10px 16px;
    font-size: 14px;
    font-weight: 600;
    color: var(--gray-700, #334155);
    cursor: pointer;
    transition: background 150ms ease;
    min-height: 40px;
  }
  .btn-cancel:hover {
    background: rgba(255, 255, 255, 0.85);
  }
  .btn-danger {
    flex: 1;
    appearance: none;
    background: linear-gradient(135deg, rgba(244, 63, 94, 0.92) 0%, rgba(220, 38, 38, 0.85) 100%);
    border: 1.5px solid rgba(255, 255, 255, 0.4);
    border-radius: 999px;
    padding: 10px 16px;
    font-size: 14px;
    font-weight: 600;
    color: #fff;
    cursor: pointer;
    transition: transform 100ms ease, filter 150ms ease;
    min-height: 40px;
  }
  .btn-danger:hover {
    filter: brightness(1.05);
  }
  .btn-danger:active {
    transform: scale(0.97);
  }
</style>
