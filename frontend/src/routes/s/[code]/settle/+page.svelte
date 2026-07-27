<script lang="ts">
  /**
   * v0.3.15 (2026-07-15) — PRD §3.15.2 #1: 删 "谁付给谁多少，一目了然" 文案 (PO 2026-07-15 04:25 拍板)。
   *
   * v0.1.3 Sprint 2 Commit 1 (2026-07-02) — settle 视图。
   *
   * 本次 Commit 1 改动:
   * - Token alias 迁移: var(--color-*) → var(--*) 主 token。
   *
   * v0.3.14.1 hotfix #4 (2026-07-14) — 个人视图反馈 1/2/3.
   * - 反馈 1 (UI 架构): 「主币种汇总 / 原始数据」radio 从 tab bar 下方
   *   整体外提, **只**在「个人视图」tab 显示; 概览 tab 隐藏。
   *   概览 tab (SettleTransferPath) 仍按 session primary 聚合显示,
   *   不需要 per-bill 原始数据, 故 radio 对概览无意义。
   * - 反馈 2/3 (单位 + 换算): SettleMemberBreakdown 现在所有金额都
   *   带具体单位, 主币种汇总模式下付款/消费明细行用 BE 已换算好的
   *   `*_primary` 字段。
   *
   * v0.3.18 #60 (PO #6820+#6826, 2026-07-20): 底部 3 FAB + 「按源币种」section 删除
   * (PO 红圈 #6826 反复要求; 反 #161 v2 字面执行 — 改尺寸不动形态,
   * 反对 sticky bar / 新 FAB / 新 layout)。
   * 返回由 sbc navbar 承担, 不在 settle 页内复原 inline BackButton。
   * 个人视图 viewMode 仅保留「主币种汇总」一个选项
   * (SettleMemberBreakdown 内部 split 分支保留 — v0.3.17 #32 维护)。
   *
   * v0.3.18 #63 (PO msg #6842 第 3 条, 2026-07-20): IosSwitch 同一行左侧加
   * 圆形 FAB 返回按钮 (ArrowLeft → /sessions/{id} session 详情)。
   * - 位置: settle 页 IosSwitch (activeTab 概览/个人视图 toggle) 同行左侧
   * - 形态: 圆形 FAB (.back-btn border-radius:50%), 直径 = IosSwitch 高度
   *   (desktop 52px = IosSwitch padding 4×2 + option min-height 44;
   *    narrow viewport ≤600px 44px 同步 option 36px min-height 降级)
   * - 玻璃化: 复用 .glass-pill 全局 token (饱和度 200% / blur 20px /
   *   蓝紫描边 / inset highlight / 紫蓝 hover 加深), 跟 IosSwitch track
   *   同款 iOS27 玻璃语系
   * - 对齐: row flex (display:flex + justify-content:space-between) —
   *   .back-btn 左对齐页面元素左边缘, IosSwitch margin-left:auto 右对齐
   *   (覆盖组件 scoped 的 `margin: 0 auto 1.25rem` 居中)
   * - 形态约束: 不改圆形 FAB + IosSwitch 形态, 不加 sticky bar,
   *   不加新 FAB, 不动 v0.3.18 #55/#56/#57 范围, 不动 v0.3.17 #19/#20/#21/#30,
   *   不动 a941bac 已删的按源币种 section + 3 FAB
   * - 行为: 点击跳 /sessions/{sessionId} (session 详情, 跟 v0.3.15 #6 v2
   *   原左下 fab 一致)
   *
   * 沿用:
   * - v0.3.15 §3.15.2 #6 v2 (PO msg #4772): 返回按钮原本是左下圆形 FAB,
   *   #60 已删除 (navbar 承担), #63 改为 inline 在 IosSwitch 行左侧.
   *   BackButton.svelte 组件保留 (最小改动原则, 反 #121).
   *
   * 注:
   * - 该页本身没有金额 / 日期 format 调用 (SettleTransferPath / SettleMemberBreakdown
   *   已分别在子组件迁移)。
   * - T8 (settle hero) / T10 (sticky) / T11 (transfer card) 在 Commit 2。
   *
   * 沿用:
   * - v0.1.2 反馈修 6 项目 4 (返回按钮纯文本,无 ← Unicode arrow)。
   * - v0.1.2 反馈修 5 (跨页面动画)。
   */
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { getSessionByCode } from '$api/sessions';
  import type { SessionDetail } from '$api/sessions';
  import { listBills } from '$api/bills';
  import type { Bill } from '$api/bills';
  import SettleTransferPath from '$components/SettleTransferPath.svelte';
  import SettleMemberBreakdown from '$components/SettleMemberBreakdown.svelte';
  import SessionCurrencyBadge from '$components/SessionCurrencyBadge.svelte';
  import CurrencyAddModal from '$components/CurrencyAddModal.svelte';
  // v0.3.28 UAT 0724-1 #5 (Option C 玻璃圆环): settle 计算 / settle 初次 fetch 时显示 LoadingOverlay.
  import LoadingOverlay from '$components/LoadingOverlay.svelte';
  // v0.3.32 -- UAT 0725-2 #1: 已结算记录 FE 组件 (commit 2 实装).
  import AddSettlementSheet from '$components/AddSettlementSheet.svelte';
  import SettlementRow from '$components/SettlementRow.svelte';
  // v0.3.32 -- UAT 0725-2 #1: settlement_records API.
  import {
    listSettlementRecords,
    deleteSettlementRecord,
    type SettlementRecord,
  } from '$api/settlements';
  import IosSwitch from '$lib/components/IosSwitch.svelte';
  import { formatMoney } from '$lib/utils/format';
  import { currencySymbol } from '$lib/utils/currency';
  import { user } from '$stores/user';
  import { ArrowLeft, Plus } from 'lucide-svelte';
  import { toast } from '$stores/toast';

  let session: SessionDetail | null = null;
  let currentMember: { id: number } | null = null;
  let loading = true;
  // v0.3.18 #53: open/close state for the CurrencyAddModal (triggered by
  // SessionCurrencyBadge single-pill + icon when owner).
  let addCurrencyOpen = false;
  // v0.3.32 -- UAT 0725-2 #1: settlement_records state + sheet open.
  // records: 全部已结算记录, 按 created_at DESC (跟 mockup 5 record-list 同源).
  // addSheetOpen: 控制 AddSettlementSheet 显示.
  let records: SettlementRecord[] = [];
  let recordsLoaded = false;
  let addSheetOpen = false;
  // v0.3.32: 强制 SettleTransferPath reload -- 提交 / 删除 record 后,
  // BE 的 settle API 会调整 transfer cards, child 的 onMount 已经跑过了,
  // 需要手动触发 refetch (SettleTransferPath 没有 on:recordsChanged 事件,
  // 简单做法: 用 key prop 强制 unmount/remount).
  let settleRefreshKey = 0;
  // v0.3.19 #85 (PO #7308): 本地加载 bills 决定 has_bills, 传给 CurrencyAddModal
  // 决定锁哪些字段. settle 页通常都 >0 bills, 但仍准确加载避免 empty session 误判.
  let bills: Bill[] = [];
  let billsLoaded = false;

  // v0.3.36 — UAT 0727-1 #8 sub-route: /s/{session_code}/settle 用 code 替代 id.
  // sessionId 一开始 = 0; 首次 onMount 通过 getSessionByCode(code) 拿到 session 后回填.
  // 后续 BE 调用 (listBills / listSettlementRecords / deleteSettlementRecord)
  // 都走 session.id (numeric). 跟主页面 /s/[code]/+page.svelte 同模式.
  let code = $derived(page.params.code ?? '');
  let sessionId = $state(0);

  let memberIdToName: Record<number, string> = {};
  let memberIdToRole: Record<number, string> = {};

  // v0.2.2 (T11): settle view mode. 'primary' = all in primary
  // currency (default); 'split' = source currency per bill, primary
  // only for the totals. Pushed down to the child components which
  // re-fetch on the fly.
  //
  // v0.3.14.1 hotfix #4: only consumed by SettleMemberBreakdown
  // (the "personal view" tab). SettleTransferPath always renders in
  // primary currency. Kept at the page level so the radio can live
  // next to the personal tab without round-tripping through props
  // from the breakdown component.
  type ViewMode = 'primary' | 'split';
  // v0.3.27 (UAT 0723-2 #2): 单币种时「主币种汇总」disabled, 默认切到「原始数据」
  // (主币种汇总 = 原始数据 when currencies.length === 1, 重复 UI).
  //
  // v0.3.28 UAT 0724-1 #6: SSR-safe — anon 访问 settle 页时, onMount 还没跑,
  // session 默认 null, 这里访问 session.currencies 会 TypeError → 500. 用 helper 函数
  // 让 TypeScript 不 narrow session 到 never (顶层 let 直接 session && session.x 触发 narrowing).
  // SSR 阶段 viewMode 默认 'primary' (单币种 fallback); 客户端 onMount 拉到 session 后
  // IosSwitch bind:value 双向绑定让用户切到 'split' 或 'primary'.
  function defaultViewMode(s: SessionDetail | null): ViewMode {
    return s && s.currencies.length < 2 ? 'split' : 'primary';
  }
  let viewMode: ViewMode = defaultViewMode(session);

  // v0.3.33 — UAT 0725-3 #4 (PO 14:59 batch):
  //   删 section 3 「最新应结算」整块 (template + reactive + helpers + type),
  //   配套 .latest-* / .new-amount CSS 已在 v0.3.33 b350ebc commit 删过 (故 source 已无 .latest- CSS).
  //   PO 字面: 「最新应结算金额直接修改 建议转账 内的金额即可」.
  //   BE 的 GET /settle 已经返回 adjusted transfers (原 transfer - sum_settlements),
  //   顶部 SettleTransferPath 直接展示; section 3 重复同一数字反而让用户怀疑 '到底哪个对'.
  //   配套清理: pairAggregates reactive + PairAggregate type + fmtPrimary helper 一并删 (orphaned after section 3 删).

  // v0.3.32 -- UAT 0725-2 #1: AddSettlementSheet open + onAdded callback.
  function openAddSheet() {
    addSheetOpen = true;
  }
  async function handleRecordAdded() {
    // refetch records + force SettleTransferPath remount (settleRefreshKey + 1)
    try {
      records = await listSettlementRecords(sessionId);
    } catch (e: any) {
      toast.error(e?.message ?? '刷新已结算记录失败');
    }
    settleRefreshKey += 1;
  }
  async function handleDeleteRecord(recordId: number) {
    if (!confirm('确定删除这条已结算记录?')) return;
    try {
      await deleteSettlementRecord(sessionId, recordId);
      records = records.filter((r) => r.id !== recordId);
      settleRefreshKey += 1;
      toast.success('已删除');
    } catch (e: any) {
      const msg = e?.detail?.error ?? e?.message ?? '删除失败';
      toast.error(`删除失败: ${msg}`);
    }
  }

  type Tab = 'overview' | 'personal';
  let activeTab: Tab = 'overview';

  onMount(async () => {
    if (page.url.hash === '#personal') {
      activeTab = 'personal';
    }
    try {
      const result = await getSessionByCode(code);
      session = result;  // getSessionByCode returns SessionDetail directly (not wrapped)
      sessionId = result.id;  // 回填 numeric id, 后续 BE 调用用
      // 注: getSessionByCode 不返 actingAsMemberId (member 由 X-Nickname-Secret BE 端识别).
      currentMember = null;  // settle 不需要 actingAsMemberId 派生; 直接从 session.members 拿 owner check.
      for (const m of session.members) {
        memberIdToName[m.id] = m.display_name;
        memberIdToRole[m.id] = m.role;
      }
      // v0.3.19 #85: 并行加载 bills 决定 has_bills. 即便失败也降级 false, 不阻塞主流程.
      try {
        bills = await listBills(sessionId);
      } catch {
        bills = [];
      } finally {
        billsLoaded = true;
      }
      // v0.3.32 -- UAT 0725-2 #1: 并行拉 settlement_records. 失败降级空 list, 不阻塞主流程.
      try {
        records = await listSettlementRecords(sessionId);
      } catch {
        records = [];
      } finally {
        recordsLoaded = true;
      }
    } catch (e: any) {
      // v0.3.36 (UAT 0727-1 #8 sub-route): 非成员 → /s/{code}/join (use URL `code` param).
      // 之前用 session?.session_code || String(sessionId), 但 v0.3.36 后 sessionId 是 $state(0)
      // 初始值, 403 时 session 还没拿到, fallback 出 '/s/0/join' (错). 直接用 URL `code`.
      if (e?.code === 'not a session member' || e?.status === 403) {
        await goto('/s/' + code + '/join', { replaceState: true });
        return;
      }
      // v0.3.15 (PO #4807): 错误统一走 Toast. 父 onMount 失败时子组件
      // (SettleTransferPath / SettleMemberBreakdown) 不会渲染, 不会重複 toast.
      toast.error(e?.message ?? '加载失败');
    } finally {
      loading = false;
    }
  });
</script>

<section>
  {#if loading}
    <!-- v0.3.28 UAT 0724-1 #5 (Option C 玻璃圆环): 跟 wizard + 账单详情一致. -->
    <LoadingOverlay text="加载结算..." />
  {:else if session}
    <h2>{session.name} · 结算</h2>
    <!-- v0.3.19 #85 (PO #7308): 删 onRateChange (弹窗 PATCH 后 parent onAdded 统一 reload).
         多币种整 bar clickable 在 owner 时也触发 onAddCurrency. -->
    <SessionCurrencyBadge
      currencies={session.currencies ?? []}
      primary_currency={session.primary_currency}
      exchange_rates={session.exchange_rates ?? []}
      editable={memberIdToRole[currentMember?.id ?? 0] === 'owner'}
      variant="settle"
      onAddCurrency={() => (addCurrencyOpen = true)}
    />

    <!-- v0.3.18 #57 (PO msg 23:51 #6727): .tab-bar 玻璃化 → IosSwitch (方案 A iOS Segmented).
         跟个人视图内部 viewMode IosSwitch 完全同款, 整 settle 页一组 iOS27 segmented family.
         IosSwitch 组件已 commit 44c1b40 + 0952078 + c8ae8606, 跨页面 wizard step 3 共用.

         v0.3.18 #63 (PO msg #6842 第 3 条): IosSwitch 同行左侧加 .back-btn 圆形 FAB 返回按钮
         (ArrowLeft → /sessions/{sessionId}). row flex 让 .back-btn 左对齐页面元素左边缘,
         IosSwitch 右对齐页面元素右边缘 (覆盖组件 scoped `margin: 0 auto 1.25rem` 居中). -->
    <div class="settle-toggle-row">
      <!-- v0.3.x (UAT #0723-3 #3): /s/{session_code} unguessable 格式 (代替 /sessions/{id}) -->
      <a
        class="back-btn glass-pill"
        href="/s/{session?.session_code || String(sessionId)}"
        aria-label="返回账单列表"
      >
        <ArrowLeft size={20} strokeWidth={2.4} />
      </a>
      <IosSwitch
        ariaLabel="结算视图"
        options={[
          { value: 'overview', label: '概览' },
          { value: 'personal', label: '个人视图' }
        ]}
        bind:value={activeTab}
      />
    </div>

    <div class="card">
      {#if activeTab === 'overview'}
        <!--
          v0.3.14.1 hotfix #4 反馈 1: 概览 tab 不显示
          「主币种汇总 / 原始数据」radio — SettleTransferPath 始终按
          session primary 聚合, 不需要 per-bill 原始货币视图。

          v0.3.32 -- UAT 0725-2 #1 三段 layout (mockup 1-overview):
          1) 原 transfer section (existing SettleTransferPath -- BE 已经把
             settlement_records 从 transfer 净额里减掉, 所以这里显示的就是
             "post-settlement" 应结金额. 顶部位置)
          2) 已结算记录 section (new -- records list + + 添加按钮, 中部)
          3) 最新应结算 section (new -- 仅显示受 settlement 影响的 transfer,
             配 "原 ¥X - 已结 ¥Y" annotation, 跟 mockup 1 同款. 底部)

          settleRefreshKey: 强制 SettleTransferPath remount refetch.
          AddSettlementSheet onAdded / SettlementRow onDelete 后 +1.
        -->
        <div in:slide={{ duration: 200 }}>
          {#key settleRefreshKey}
            <SettleTransferPath {session} {memberIdToName} {viewMode} />
          {/key}
        </div>

        <!-- ===== Section 2: 已结算记录 ===== -->
        <div class="section" data-sbc="settle-records-section">
          <div class="section-head">
            <h3>
              已结算记录
              <span class="badge-n" data-sbc="settle-records-count">({records.length})</span>
            </h3>
            <!-- v0.3.33 — UAT 0725-3 #3 (PO 14:59 batch):
                 .add-btn 之前 28×28 circle (only Plus icon) 视觉混乱 ("乱码").
                 改 pill 形 (icon + 「添加」label), 跟全站 btn-sm 玻璃同族.
                 跟 wizard step 3 currency-mode-row 跟 sessions/[id] .fab 视觉一致 (跟 .glass-pill 全局 utility). -->
            <button
              class="add-btn"
              type="button"
              aria-label="添加已结算记录"
              onclick={openAddSheet}
              data-sbc="settle-add-record-btn"
            >
              <Plus size={16} strokeWidth={2.4} />
              <span>添加</span>
            </button>
          </div>
          <div class="glass-card" data-sbc="settle-records-list">
            {#if !recordsLoaded}
              <p class="muted">加载已结算记录...</p>
            {:else if records.length === 0}
              <div class="record-empty" data-sbc="settle-records-empty">
                还没有已结算记录, 点击右上角 <strong>+</strong> 添加
              </div>
            {:else}
              {#each records as record (record.id)}
                <SettlementRow
                  {record}
                  sessionMemberId={currentMember?.id ?? -1}
                  onDelete={handleDeleteRecord}
                />
              {/each}
            {/if}
          </div>
        </div>

      {:else}
        <!--
          个人视图 tab: radio 只在此处出现 (PO 拍板 C1+D1 — 主币种
          汇总 vs 原始数据 的切换对个人视图才有意义)。

          v0.3.17 #32-D-3 (PO msg 00:27 #6104): 升级为 iOS27 switch toggle,
          跟 wizard step 3 currency-mode-row 同一组件 (复用 app.css 全局
          .ios-switch utility, option 44px tap target / 15px font /
          padding 0.625rem 1.5rem). 行为不变 (主币种汇总 vs 原始数据),
          跨页面视觉一致 (wizard step 3 跟 settle 个人视图 同款 toggle).
        -->
        <!-- v0.3.17 #32-D-4 (PO msg 01:18 #6116): IosSwitch 组件 — thumb 动态宽度跟随 option 文字
             主币种汇总 (CNY) vs 原始数据 — thumb width 跟随 active option 实际宽度
             (主币种汇总 label 长 ~120-140px, 原始数据 label 短 ~60-80px, thumb 差异明显)
             跟 wizard step 3 currency-mode 同一组件, 跨页面视觉一致.
             v0.3.18 #80 (coder 80): 恢复 a941bac 越界删除的 "原始数据" option — PO #6826 红圈
             只要求删 settle 底部 3 FAB + 按源币种 section, 没拍过 IosSwitch option, 顺手删是越界.
             SettleMemberBreakdown 内部 split 分支 (v0.3.17 #32) 全程保留, view=split 是合法态.
             v0.3.28 UAT 0724-1 #10 (PO msg 2026-07-24): 单币种个人视图不需要 toggle.
             currencies.length < 2 时 主币种汇总 vs 原始数据 是同一个东西 (primary 就是 source),
             toggle 没意义还误导用户. 整 IosSwitch 隐藏, viewMode 走 defaultViewMode 返回的 'split' (原始数据),
             SettleMemberBreakdown 渲染 viewMode='split' = 主币种 (因为单币种 source 就是 primary). -->
        {#if session.currencies && session.currencies.length >= 2}
          <IosSwitch
            ariaLabel="结算视图"
            options={[
              { value: 'primary', label: `主币种汇总 (${session.primary_currency})` },
              { value: 'split', label: '原始数据' }
            ]}
            bind:value={viewMode}
          />
        {/if}
        <div in:slide={{ duration: 200 }}>
          <SettleMemberBreakdown {session} currentUserId={$user?.user_id ?? null} {viewMode} />
        </div>
      {/if}
    </div>
  {/if}


  <!-- v0.3.18 #53 + v0.3.19 #85: owner-driven modal.
       Mounted only when addCurrencyOpen=true (controlled by SessionCurrencyBadge
       onAddCurrency click from 单币种 pill 或 多币种整 bar).
       mode 跟 session.currencies.length 联动: 1=单币种 (locked if bills>0) /
       2=多币种 (only rate editable).
       has_bills 跟本地 bills.length 联动 (并行加载完 billsLoaded 才显示).
       billsLoaded 为 false 时默认 has_bills=false (保守 — 避免空 session 误锁).
       onAdded reloads the page so the badge re-renders with new currencies/rates. -->
  {#if addCurrencyOpen && session}
    <CurrencyAddModal
      session_id={session.id}
      primary_currency={session.primary_currency}
      existing_currencies={session.currencies ?? []}
      mode={session.currencies.length === 1 ? 'single' : 'multi'}
      has_bills={billsLoaded && bills.length > 0}
      exchange_rates={session.exchange_rates ?? []}
      onAdded={() => window.location.reload()}
      on:close={() => (addCurrencyOpen = false)}
    />
  {/if}

  <!-- v0.3.32 -- UAT 0725-2 #1: AddSettlementSheet modal (mockup 2 + 3).
       控制 addSheetOpen state. 仅在 session + records 都已加载时挂载, 避免
       sheet 打开时 transfers 还是 stale 数组 (preview 算式会失真).
       transfers prop 拿 settleRawTransfers (BE 返回的 raw, 不被 settlement 减
       过的) -- 我们还没这能力, 所以传空数组让 preview 走 "无对应原转账" 兜底
       文案. 后续 sprint 可加 ?raw=true query param 让 BE 暴露未调整的 raw.
       当前 commit 的 preview 会显示 "无对应原转账" 路径, 但 sheet 本身依然
       能提交, 提交后 refetch 让 SettleTransferPath 显示调整后的 transfer cards.
  -->
  {#if addSheetOpen && session && currentMember}
    <AddSettlementSheet
      sessionId={session.id}
      members={session.members.map((m) => ({ id: m.id, display_name: m.display_name }))}
      currencies={session.currencies ?? []}
      primaryCurrency={session.primary_currency}
      transfers={[]}
      currentMemberId={currentMember.id}
      onAdded={handleRecordAdded}
      onclose={() => (addSheetOpen = false)}
    />
  {/if}
</section>

<script context="module" lang="ts">
  // v0.3.32 -- UAT 0725-2 #1: Section 3 "最新应结算" 渲染逻辑.
  // affectedTransfers: 仅包含 (from, to) pair 至少有一条 settlement_record 的 transfer.
  // 由于 BE 的 GET /settle 返回的 transfer 已经被 settlement 减过 (= adjusted),
  // 我们用 adjusted 反推 raw: raw = adjusted + settlement_sum (in primary currency).
  // 边界: settlement_sum 通过 BE 拉到的 records 聚合, 跨币种按 session_rates 转 primary.
  //
  // 注: 因为 BE 暴露的 session_rates 只在 settle API 内部使用, FE 拿不到,
  // 这里用 session.exchange_rates (session detail 返回的) 做转换. 这对
  // 1:1 currency 场景 (record.currency === primary) 100% 准确; 跨币种
  // 也准确 (跟 settle API 用同一个 rate).
</script>

<style>
  /* v0.3.17 #32-D-4 (PO msg 01:18 #6116): .ios-switch 全套移到 IosSwitch.svelte
     scoped style (frontend/src/lib/components/IosSwitch.svelte).
     跨页面 (wizard step 3 + settle 个人视图) 共用同一组件, thumb 宽度跟随
     active option 实际宽度 (动态, 不再固定 50%). */

  /* v0.3.18 #63 (PO msg #6842 第 3 条): IosSwitch 同一行水平 row flex layout.
   * - .settle-toggle-row: 水平 flex, 返回按钮左对齐页面元素左边缘,
   *   IosSwitch 右对齐页面元素右边缘 (gap 12px).
   * - .back-btn: 圆形 FAB, 直径 = IosSwitch 总高
   *   (padding 4×2 + option min-height 44 = 52px desktop,
   *    narrow viewport 8px+36px = 44px 同步降级).
   *   形态跟原 v0.3.15 #6 v2 .fab 同款 (border-radius:50% + display:grid
   *   + place-items:center + text-decoration:none + 紫蓝 hover/active/focus),
   *   玻璃化 token 由 .glass-pill 全局提供 (app.css — bg 渐变 indigo→blue
   *   saturate 200% / blur 20px / inset highlight + 蓝紫描边).
   * - .settle-toggle-row :global(.ios-switch) 覆盖 IosSwitch 组件 scoped 的
   *   `margin: 0 auto 1.25rem` 居中 — 在 row 内不再 auto-center, 由 flex
   *   布局 (margin-left:auto) 决定位置.
   * 不动 IosSwitch 组件本身 (反 #63 字面要求 — 只在 settle 页消费侧布局). */
  .settle-toggle-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    margin-bottom: 1.25rem;
  }
  .settle-toggle-row :global(.ios-switch) {
    /* 覆盖 IosSwitch 组件 scoped `margin: 0 auto 1.25rem` — 在 row flex 内
       不再 auto-center, 由 margin-left:auto 让 IosSwitch 推右对齐 */
    margin: 0;
    margin-left: auto;
  }
  .back-btn {
    flex-shrink: 0;
    /* 直径 = IosSwitch 总高 desktop: padding 4×2 + option min-height 44 = 52px */
    width: 52px;
    height: 52px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    text-decoration: none;
    cursor: pointer;
    padding: 0;
    border: none;
    /* v0.3.28 UAT 0724-2 #10: 填色 + 象牙白 icon (同 IosSwitch 选中态样式) */
    background: var(--accent-600, #6366f1);
    color: #fffff0;
    transition: transform 150ms ease, box-shadow 150ms ease, background 150ms ease, color 150ms ease;
  }
  .back-btn :global(svg) {
    color: #fffff0;
    stroke: #fffff0;
  }
  .back-btn:hover { transform: translateY(-2px); }
  .back-btn:active { transform: scale(0.96); }
  .back-btn:focus-visible {
    /* 玻璃上白色 outline + indigo 实心 ring, focus 状态显眼 (跟原 .fab 一致) */
    outline: 2px solid #fff;
    outline-offset: 2px;
    box-shadow: 0 0 0 4px #4f46e5;
  }

  /* narrow viewport (≤600px) — 跟 IosSwitch option 36px min-height 同步降级 */
  @media (max-width: 600px) {
    .back-btn {
      width: 44px;
      height: 44px;
    }
  }

  .muted {
    color: var(--gray-500);
  }

  /* v0.3.32 -- UAT 0725-2 #1: 三段 layout 共享样式 */
  .section {
    margin-bottom: var(--space-4, 16px);
  }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0 4px 8px;
  }
  .section-head h3 {
    font-size: 14px;
    font-weight: 600;
    color: #374151;
    letter-spacing: 0.01em;
    margin: 0;
  }
  .section-head .badge-n {
    font-size: 12px;
    color: #737373;
    font-weight: 400;
    margin-left: 4px;
  }
  /* v0.3.33 — UAT 0725-3 #3: pill 形 add-btn (高度 36px / border-radius 999px / gap 4px icon+text / 全站玻璃同族).
     跟 wizard step 3 全局 glass-pill + sessions/[id] pages .fab 视觉一致. */
  .add-btn {
    height: 36px;
    padding: 0 14px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border-radius: 999px;
    background: linear-gradient(
      135deg,
      rgba(99, 102, 241, 0.16) 0%,
      rgba(59, 130, 246, 0.12) 100%
    );
    backdrop-filter: saturate(180%) blur(16px);
    -webkit-backdrop-filter: saturate(180%) blur(16px);
    border: 1px solid rgba(99, 102, 241, 0.28);
    color: var(--accent-700, #4338ca);
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.01em;
    cursor: pointer;
    transition: transform 150ms ease, background 150ms ease, box-shadow 150ms ease;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.55),
      0 1px 3px rgba(99, 102, 241, 0.16);
    flex-shrink: 0;
  }
  .add-btn:hover {
    transform: translateY(-1px);
    background: linear-gradient(
      135deg,
      rgba(99, 102, 241, 0.22) 0%,
      rgba(59, 130, 246, 0.18) 100%
    );
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.65),
      0 2px 6px rgba(99, 102, 241, 0.22);
  }
  .add-btn:active {
    transform: scale(0.97);
  }

  /* Glass card (跟全站 glass 语言同源) */
  :global(.glass-card),
  .glass-card {
    background: linear-gradient(135deg, rgba(255,255,255,0.62) 0%, rgba(255,255,255,0.42) 100%);
    backdrop-filter: saturate(180%) blur(20px);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    border: 1px solid rgba(255, 255, 255, 0.55);
    border-radius: 18px;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.7),
      0 4px 12px rgba(15, 23, 42, 0.04);
    overflow: hidden;
  }
  .record-empty {
    padding: 24px 16px;
    text-align: center;
    color: #737373;
    font-size: 13px;
  }
  .record-empty strong { color: #6366f1; font-weight: 600; }

  /* v0.3.33 — UAT 0725-3 #4: section 3「最新应结算」template + reactive 都删了, 一并清理 .latest-* / .new-amount CSS. */
</style>
