<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { user, loadUser } from "$stores/user";

  // v0.3.1 (Sprint 5 T7 — 2026-07-07): Wizard UX overhaul.
  // - 2 steps total (was 3). Step 2 combines count + nickname inputs.
  // - Min member count = 1 (just yourself allowed; was 2).
  // - Sticky bottom button so thumb can always reach it on mobile.
  // - 文案: 名字 → 昵称; "X 人 · 后续可增加".

  let step = 1;
  let sessionName = "";
  let memberCount = 2;
  let nicknames: string[] = ["", ""];
  let busy = false;
  let error: string | null = null;
  let loading = true;
  const LS_PREFIX = "sbc.actingAs.";

  onMount(async () => {
    await loadUser();
    loading = false;
  });

  $: nameValid = sessionName.trim().length > 0;

  // Resize nicknames to track memberCount.
  // Why not a pure `$:` assignment? If the reactive block reads `nicknames`
  // (to preserve existing entries) AND writes to it, Svelte 4 will fire the
  // block again next tick — risking a render loop. Keep resizeNicknames as
  // a plain function called from `$: resizeNicknames(memberCount)` so the
  // only dependency tracked is `memberCount`. Inside, we read nicknames[i]
  // by reference and reassign to a fresh array (in-place .push/.pop don't
  // trigger Svelte's reactivity by themselves).
  $: resizeNicknames(memberCount);

  function resizeNicknames(target: number) {
    if (nicknames.length === target) return;
    const next: string[] = [];
    for (let i = 0; i < target; i++) {
      next.push(nicknames[i] ?? "");
    }
    nicknames = next;
  }

  $: nicknamesValid = nicknames.every((n) => n.trim().length > 0);

  function adjustCount(delta: number) {
    const next = memberCount + delta;
    // Min 1 (just yourself); max 20.
    if (next >= 1 && next <= 20) memberCount = next;
  }

  function goNext() {
    if (step === 1 && nameValid) step = 2;
  }

  async function handleCreate() {
    if (busy || !nicknamesValid) return;
    error = null;
    busy = true;
    try {
      const createRes = await fetch("/api/sessions", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: sessionName.trim(),
          member_nicknames: nicknames.map((n) => n.trim()),
        }),
      });
      if (!createRes.ok) {
        const body = await createRes.json().catch(() => ({}));
        throw new Error(body?.detail?.error ?? "HTTP " + createRes.status);
      }
      const data = (await createRes.json()) as { id: number; created_member_ids: number[] };
      const sid = data.id;
      const memberIds = data.created_member_ids ?? [];
      if ($user === null && memberIds.length > 0) {
        const claimRes = await fetch("/api/sessions/" + sid + "/join-claim", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "claim", session_member_id: memberIds[0] }),
        });
        if (!claimRes.ok) {
          const body = await claimRes.json().catch(() => ({}));
          throw new Error(body?.detail?.error ?? "认领失败，请重试");
        }
        const claimData = (await claimRes.json()) as { session_member_id: number; nickname_secret: string | null };
        if (claimData.nickname_secret && typeof window !== "undefined") {
          localStorage.setItem(LS_PREFIX + sid, claimData.nickname_secret);
        }
      }
      await goto("/sessions/" + sid, { replaceState: true });
    } catch (e: any) {
      error = e?.message ?? "创建失败，请重试";
      busy = false;
    }
  }

  function onNickEnter(i: number, e: KeyboardEvent) {
    if (e.key === "Enter" && i === nicknames.length - 1 && nicknamesValid && !busy) {
      handleCreate();
    }
  }
</script>

<svelte:head>
  <title>新建 session</title>
</svelte:head>

{#if loading}
  <div class="loading-screen">
    <p class="muted">加载中…</p>
  </div>
{:else}
  <div class="wizard">
    <div class="progress">
      <span class="dot" class:active={step >= 1} class:done={step > 1} />
      <span class="dot" class:active={step >= 2} class:done={step > 2} />
    </div>
    <p class="step-label">
      {#if step === 1}第一步{/if}{#if step === 2}第二步{/if}
    </p>
    {#if error}
      <div class="error-banner">{error}</div>
    {/if}

    <!-- Scrollable main content above the sticky footer -->
    <div class="content">
      {#if step === 1}
        <div class="step-panel">
          <h2 class="step-title">给你的账本起个名字</h2>
          <p class="step-hint">比如：曼谷之旅 2026 / 毕业聚餐 / 合租记账</p>
          <div class="field">
            <input id="session-name" type="text" bind:value={sessionName}
              placeholder="比如：曼谷之旅 2026" maxlength="200"
              onkeydown={(e) => e.key === "Enter" && nameValid && goNext()}
              autofocus />
          </div>
        </div>
      {/if}

      {#if step === 2}
        <div class="step-panel">
          <h2 class="step-title">一共有多少个昵称?</h2>
          <p class="step-hint">包括你自己，至少 1 人，后续可增加</p>
          <div class="count-row">
            <button class="count-btn" onclick={() => adjustCount(-1)} disabled={memberCount <= 1} aria-label="减少一人">-</button>
            <span class="count-display">{memberCount}</span>
            <button class="count-btn" onclick={() => adjustCount(1)} disabled={memberCount >= 20} aria-label="增加一人">+</button>
          </div>
          <p class="count-hint">{memberCount} 人 · 后续可增加</p>

          <div class="nickname-list">
            {#each nicknames as nick, i (i)}
              <div class="nickname-row">
                <span class="nick-label">{i === 0 ? "你" : "同伴 " + i}</span>
                <input type="text" bind:value={nicknames[i]}
                  placeholder={i === 0 ? "你的昵称" : "同伴 " + i + " 的昵称"}
                  maxlength="50"
                  onkeydown={(e) => onNickEnter(i, e)} />
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>

    <!-- Sticky bottom action bar — always visible regardless of scroll -->
    <div class="step-nav-bottom">
      {#if step === 1}
        <button class="btn-next" onclick={goNext} disabled={!nameValid}>下一步</button>
      {/if}
      {#if step === 2}
        <button class="btn-back" onclick={() => (step = 1)}>上一步</button>
        <button class="btn-confirm" onclick={handleCreate} disabled={!nicknamesValid || busy}>
          {busy ? "创建中…" : "确认创建"}
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .loading-screen { display: flex; align-items: center; justify-content: center; min-height: 50vh; }

  /* Wizard: fixed-height viewport column, content scrolls, footer sticks */
  .wizard {
    max-width: 480px;
    margin: 0 auto;
    padding: 1.5rem 1rem 0;
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    box-sizing: border-box;
  }

  .content {
    flex: 1;
  }

  .progress { display: flex; justify-content: center; gap: 0.5rem; margin-bottom: 1.25rem; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #e5e5e5; transition: background 0.3s, transform 0.3s; }
  .dot.active { background: #3b82f6; }
  .dot.done { background: #93c5fd; transform: scale(0.85); }

  .step-label { text-align: center; font-size: 0.8125rem; color: #737373; margin: 0 0 1.5rem; text-transform: uppercase; letter-spacing: 0.08em; }
  .step-panel { animation: slideIn 0.3s ease-out both; }
  @keyframes slideIn { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: translateX(0); } }

  .step-title { font-size: 1.5rem; font-weight: 700; color: #171717; margin: 0 0 0.375rem; line-height: 1.2; }
  .step-hint { font-size: 0.9rem; color: #737373; margin: 0 0 1.75rem; }
  .field { margin-bottom: 0; }

  input[type="text"] { width: 100%; padding: 0.875rem 1rem; border: 2px solid #e5e5e5; border-radius: 0.75rem; font-size: 1rem; background: #fff; transition: border-color 0.15s; box-sizing: border-box; }
  input[type="text"]:focus { outline: none; border-color: #3b82f6; }
  input[type="text"]::placeholder { color: #a3a3a3; }

  .btn-next, .btn-confirm { display: inline-flex; align-items: center; justify-content: center; width: 100%; min-height: 52px; padding: 0 1.5rem; background: #3b82f6; border: none; border-radius: 9999px; color: #fff; font-size: 1rem; font-weight: 600; cursor: pointer; transition: background 0.15s, transform 0.1s; letter-spacing: 0.01em; }
  .btn-next:hover:not(:disabled), .btn-confirm:hover:not(:disabled) { background: #2563eb; }
  .btn-next:active:not(:disabled), .btn-confirm:active:not(:disabled) { transform: scale(0.98); }
  .btn-next:disabled, .btn-confirm:disabled { opacity: 0.5; cursor: not-allowed; }

  /* Sticky bottom action bar — JS spec for B.3 */
  .step-nav-bottom {
    position: sticky;
    bottom: 0;
    background: #fff;
    padding: 1rem 0 calc(env(safe-area-inset-bottom, 0px) + 1rem);
    border-top: 1px solid #e5e5e5;
    display: flex;
    gap: 0.75rem;
    margin: 0 -1rem;
    padding-left: 1rem;
    padding-right: 1rem;
  }

  /* In the sticky footer: confirm takes remaining width, back stays compact */
  .step-nav-bottom .btn-confirm { flex: 1; }
  .step-nav-bottom .btn-back { flex: 0 0 auto; }

  .btn-back { display: inline-flex; align-items: center; justify-content: center; min-height: 52px; padding: 0 1.25rem; background: #fff; border: 2px solid #e5e5e5; border-radius: 9999px; color: #525252; font-size: 1rem; font-weight: 500; cursor: pointer; transition: border-color 0.15s, color 0.15s; }
  .btn-back:hover { border-color: #a3a3a3; color: #262626; }

  .count-row { display: flex; align-items: center; justify-content: center; gap: 2rem; margin-bottom: 0.75rem; }
  .count-btn { width: 56px; height: 56px; border-radius: 50%; border: 2px solid #e5e5e5; background: #fff; color: #262626; font-size: 1.5rem; font-weight: 600; cursor: pointer; transition: border-color 0.15s, background 0.15s; display: flex; align-items: center; justify-content: center; }
  .count-btn:hover:not(:disabled) { border-color: #3b82f6; background: #eff6ff; color: #3b82f6; }
  .count-btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .count-display { font-size: 3rem; font-weight: 700; color: #171717; min-width: 3rem; text-align: center; line-height: 1; }
  .count-hint { text-align: center; font-size: 0.9rem; color: #737373; margin: 0 0 1.5rem; }

  .nickname-list { display: flex; flex-direction: column; gap: 0.75rem; }
  .nickname-row { display: flex; align-items: center; gap: 0.75rem; }
  .nick-label { min-width: 52px; font-size: 0.875rem; font-weight: 600; color: #525252; }
  .nickname-row input { flex: 1; padding: 0.75rem 1rem; border: 2px solid #e5e5e5; border-radius: 0.75rem; font-size: 1rem; background: #fff; transition: border-color 0.15s; box-sizing: border-box; }
  .nickname-row input:focus { outline: none; border-color: #3b82f6; }
  .nickname-row input::placeholder { color: #a3a3a3; }

  .error-banner { background: #fff1f2; border: 1px solid #fecdd3; color: #be123c; border-radius: 0.5rem; padding: 0.625rem 1rem; font-size: 0.875rem; margin-bottom: 1rem; }
  .muted { color: #737373; }
</style>
