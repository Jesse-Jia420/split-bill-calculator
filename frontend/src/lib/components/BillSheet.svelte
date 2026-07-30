<!--
  Bill create/edit bottom sheet — same family as CurrencyAddModal / InviteLinkButton.
-->
<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { portal } from '$lib/actions/portal';
  import BillForm from '$components/BillForm.svelte';
  import type { SessionDetail } from '$api/sessions';
  import type { Bill } from '$api/bills';
  import { createBill, updateBill } from '$api/bills';
  import { toast } from '$stores/toast';

  export let session: SessionDetail;
  export let mode: 'create' | 'edit' = 'create';
  export let existingBill: Bill | null = null;
  export let defaultPayerMemberId: number | null = null;
  export let onSaved: ((bill: Bill) => void) | undefined = undefined;
  export let dismiss: (() => void) | undefined = undefined;

  const dispatch = createEventDispatcher<{ close: void }>();

  let closing = false;
  let busy = false;
  let sheetEl: HTMLDivElement | null = null;
  let dragStartY = 0;
  let dragging = false;
  let dragDeltaY = 0;
  let sheetHeight = 0;

  $: title = mode === 'edit' ? '编辑账单' : '新建账单';
  $: formKey = `${mode}-${existingBill?.id ?? 'new'}`;

  function close() {
    if (busy || closing) return;
    closing = true;
    setTimeout(() => {
      closing = false;
      dismiss?.();
      dispatch('close');
    }, 240);
  }

  function handleTouchStart(e: TouchEvent) {
    if (!sheetEl) return;
    const t = e.touches[0];
    if (!t) return;
    dragStartY = t.clientY;
    dragging = true;
    sheetHeight = sheetEl.getBoundingClientRect().height;
  }

  function handleTouchMove(e: TouchEvent) {
    if (!dragging || !sheetEl) return;
    const t = e.touches[0];
    if (!t) return;
    const deltaY = t.clientY - dragStartY;
    dragDeltaY = deltaY;
    if (deltaY >= 0) {
      e.preventDefault();
      sheetEl.style.transform = `translateY(${deltaY}px)`;
      sheetEl.style.transition = 'none';
    } else {
      const rubberY = deltaY / 3;
      sheetEl.style.transform = `translateY(${rubberY}px)`;
      sheetEl.style.transition = 'none';
    }
  }

  function handleTouchEnd() {
    if (!dragging || !sheetEl) return;
    const threshold = Math.min(sheetHeight * 0.15, 80);
    if (dragDeltaY > threshold) {
      close();
    } else {
      sheetEl.style.transform = '';
      sheetEl.style.transition = 'transform 280ms cubic-bezier(0.32, 0.72, 0, 1)';
      setTimeout(() => {
        if (sheetEl) sheetEl.style.transition = '';
      }, 300);
    }
    dragging = false;
    dragDeltaY = 0;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && !busy) close();
  }

  onMount(() => {
    const mainEl = document.querySelector('main');
    const origMainOverflow = mainEl?.style.overflow ?? '';
    const origMainOverscroll = mainEl?.style.overscrollBehavior ?? '';
    const origBodyOverflow = document.body.style.overflow;
    const origBodyOverscroll = document.body.style.overscrollBehavior ?? '';
    const origHtmlOverflow = document.documentElement.style.overflow;
    const origHtmlOverscroll = document.documentElement.style.overscrollBehavior ?? '';
    document.body.style.overflow = 'hidden';
    document.body.style.overscrollBehavior = 'contain';
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.style.overscrollBehavior = 'contain';
    if (mainEl) {
      mainEl.style.overflow = 'hidden';
      mainEl.style.overscrollBehavior = 'contain';
    }
    return () => {
      document.body.style.overflow = origBodyOverflow;
      document.body.style.overscrollBehavior = origBodyOverscroll;
      document.documentElement.style.overflow = origHtmlOverflow;
      document.documentElement.style.overscrollBehavior = origHtmlOverscroll;
      if (mainEl) {
        mainEl.style.overflow = origMainOverflow;
        mainEl.style.overscrollBehavior = origMainOverscroll;
      }
    };
  });

  async function handleSubmit(payload: {
    amount: number;
    payer_member_id: number;
    description: string | null;
    occurred_at: string;
    currency: string;
    participants: Array<{ member_id: number; is_exclusive: boolean; exclusive_amount: number }>;
    amount_expression: string;
    use_calculator: boolean;
  }) {
    if (busy) return;
    busy = true;
    try {
      let bill: Bill;
      if (mode === 'edit' && existingBill) {
        bill = await updateBill(session.id, existingBill.id, payload);
        toast.success('账单已更新');
      } else {
        bill = await createBill(session.id, payload);
        toast.success('账单已创建');
      }
      onSaved?.(bill);
      close();
    } catch (e) {
      // BillForm catches and humanizes API errors into toast.
      throw e;
    } finally {
      busy = false;
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div use:portal data-testid="bill-sheet-host">
  <div class="sheet-backdrop" class:closing role="presentation" onclick={close}></div>
  <div
    class="sheet"
    class:dragging
    class:closing
    role="dialog"
    aria-modal="true"
    aria-label={title}
    data-testid="bill-sheet"
    bind:this={sheetEl}
    ontouchstart={handleTouchStart}
    ontouchmove={handleTouchMove}
    ontouchend={handleTouchEnd}
    ontouchcancel={handleTouchEnd}
  >
    <div class="sheet-handle" aria-hidden="true"></div>
    <header class="sheet-head">
      <h3 class="sheet-title">{title}</h3>
      <p class="sheet-sub muted">{session.name}</p>
    </header>

    <div class="sheet-body">
      {#key formKey}
        <BillForm
          {session}
          {mode}
          {existingBill}
          {defaultPayerMemberId}
          onSubmit={handleSubmit}
        />
      {/key}
    </div>

    <footer class="sheet-foot">
      <button type="button" class="btn-cancel" onclick={close} disabled={busy}>取消</button>
      <button type="submit" class="btn-save" form="bill-form" disabled={busy}>
        {busy ? '保存中…' : mode === 'edit' ? '保存修改' : '保存账单'}
      </button>
    </footer>
  </div>
</div>

<style>
  .sheet-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1100;
    background: rgba(15, 23, 42, 0.28);
    animation: fade-in 280ms ease both;
  }
  .sheet-backdrop.closing {
    animation: fade-out 240ms ease both;
  }

  .sheet {
    position: fixed;
    left: 50%;
    bottom: 0;
    transform: translateX(-50%);
    width: min(100vw, 480px);
    max-height: min(92vh, 900px);
    z-index: 1101;
    display: flex;
    flex-direction: column;
    background: rgba(255, 255, 255, 0.92);
    backdrop-filter: saturate(180%) blur(24px);
    -webkit-backdrop-filter: saturate(180%) blur(24px);
    border-radius: 20px 20px 0 0;
    box-shadow: 0 -8px 40px rgba(15, 23, 42, 0.18);
    animation: sheet-up 280ms cubic-bezier(0.32, 0.72, 0, 1) both;
    touch-action: none;
  }
  .sheet.closing {
    animation: sheet-down 240ms cubic-bezier(0.32, 0.72, 0, 1) both;
  }
  .sheet.dragging {
    animation: none;
  }

  .sheet-handle {
    width: 36px;
    height: 4px;
    border-radius: 999px;
    background: rgba(15, 23, 42, 0.18);
    margin: 10px auto 0;
    flex-shrink: 0;
  }
  .sheet-head {
    padding: 12px 20px 8px;
    flex-shrink: 0;
  }
  .sheet-title {
    margin: 0;
    font-size: 17px;
    font-weight: 650;
    color: #0f172a;
    text-align: center;
  }
  .sheet-sub {
    margin: 4px 0 0;
    font-size: 12.5px;
    text-align: center;
  }
  .muted {
    color: #64748b;
  }
  .sheet-body {
    flex: 1;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 4px 16px 12px;
    touch-action: pan-y;
  }
  .sheet-foot {
    display: flex;
    gap: 10px;
    padding: 12px 16px calc(12px + env(safe-area-inset-bottom, 0px));
    border-top: 1px solid rgba(15, 23, 42, 0.06);
    flex-shrink: 0;
    background: rgba(255, 255, 255, 0.72);
  }
  .btn-cancel,
  .btn-save {
    flex: 1;
    min-height: 44px;
    border-radius: 12px;
    font-size: 15px;
    font-weight: 600;
    border: none;
    cursor: pointer;
  }
  .btn-cancel {
    background: rgba(15, 23, 42, 0.06);
    color: #334155;
  }
  .btn-save {
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    color: #fff;
  }
  .btn-save:disabled,
  .btn-cancel:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  @keyframes fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @keyframes fade-out {
    from {
      opacity: 1;
    }
    to {
      opacity: 0;
    }
  }
  @keyframes sheet-up {
    from {
      transform: translateX(-50%) translateY(110%);
    }
    to {
      transform: translateX(-50%) translateY(0);
    }
  }
  @keyframes sheet-down {
    from {
      transform: translateX(-50%) translateY(0);
    }
    to {
      transform: translateX(-50%) translateY(110%);
    }
  }
</style>
