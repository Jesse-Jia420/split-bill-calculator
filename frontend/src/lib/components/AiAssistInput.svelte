<script lang="ts">
  import { parseBill } from '$api/bills';
  import type { ParseBillResult } from '$api/bills';

  export let sessionId: number;
  /** Called with parsed result so the parent can fill the form. */
  export let onResult: ((result: ParseBillResult) => void) | null = null;

  let text = '';
  let busy = false;
  let error: string | null = null;

  async function handleParse() {
    if (busy) return;
    const trimmed = text.trim();
    if (!trimmed) {
      error = '请先描述一下这笔消费';
      return;
    }
    busy = true;
    error = null;
    try {
      const res = await parseBill(sessionId, trimmed);
      if (onResult) onResult(res);
    } catch (e: any) {
      const code = e?.code ?? '';
      if (code === 'ai_unavailable') {
        error = 'AI 暂时不可用,请手动填写';
      } else {
        error = e?.message ?? '解析失败';
      }
    } finally {
      busy = false;
    }
  }
</script>

<div class="ai-assist">
  <label class="label" for="ai-text">AI 辅助填表</label>
  <textarea
    id="ai-text"
    bind:value={text}
    placeholder="例: 今天晚餐 380 块, Alice 垫的, 我和 Bob 一起吃, Carol 没来"
  ></textarea>
  <div class="row" style="margin-top: var(--space-2);">
    <button on:click={handleParse} disabled={busy}>
      {busy ? '解析中…' : 'AI 解析'}
    </button>
    <span class="hint">结果只填表单,不直接保存</span>
  </div>
  {#if error}
    <div class="error">{error}</div>
  {/if}
</div>

<style>
  .ai-assist {
    background: var(--color-bg);
    border: 1px dashed var(--color-border);
    border-radius: var(--radius);
    padding: var(--space-3);
  }
</style>