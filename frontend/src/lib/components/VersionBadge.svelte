<script lang="ts">
  /**
   * v0.3.36 (PO msg 2026-07-27 12:19 "你在页面 header 上添加前后端版本号.
   * 我们以此对齐") — 始终可见在 page header 右上角的版本号 badge,
   * 用来对齐 Master / PO 的部署/真机验证版本依据.
   *
   * - FE 版本从 `import.meta.env.VITE_APP_VERSION` 读 (vite.config.ts
   *   gitVersionPlugin 在 config 加载时从 `git rev-parse --short HEAD` + dirty 标志注入).
   * - BE 版本 fetch 自 `/api/version` (vite proxy 转发到 backend `/version`),
   *   一次 memoized, 失败降级显示 'unreachable' (BE 没起来也能看出 FE 还活着).
   */
  import { onMount } from 'svelte';

  const FE_VERSION: string = (import.meta.env.VITE_APP_VERSION as string) ?? 'unknown';
  let beVersion: string = '…';

  onMount(async () => {
    try {
      const r = await fetch('/api/version');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data: { backend?: string } = await r.json();
      beVersion = (data.backend ?? 'unknown').trim();
    } catch {
      beVersion = 'unreachable';
    }
  });
</script>

<div
  class="version-badge"
  data-testid="version-badge"
  data-sbc="version-badge"
  title={`frontend ${FE_VERSION} · backend ${beVersion}`}
>
  <span class="v fe" data-sbc="fe-version">FE {FE_VERSION}</span>
  <span class="dot" aria-hidden="true">·</span>
  <span class="v be" data-sbc="be-version">BE {beVersion}</span>
</div>

<style>
  .version-badge {
    /* 固定到屏幕右上, 跟 NavBar 同区域但不挤压 NavBar 内容
     * (badge 只占 ~12px 高, NavBar ~48px, badge 在 NavBar 上沿 6px 紧贴)
     * z-index 200 在 NavBar 100 之上, 但因 backdrop-filter 半透, 视觉上
     * 是 NavBar 上面的一个小玻璃胶囊 */
    position: fixed;
    top: 6px;
    right: 8px;
    z-index: 200;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 9px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.6);
    backdrop-filter: saturate(180%) blur(12px);
    -webkit-backdrop-filter: saturate(180%) blur(12px);
    border: 0.5px solid rgba(99, 102, 241, 0.2);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 10.5px;
    line-height: 1;
    letter-spacing: 0.2px;
    color: rgba(30, 30, 60, 0.62);
    user-select: text;
    -webkit-user-select: text;
    pointer-events: auto;
  }
  .version-badge:hover {
    background: rgba(255, 255, 255, 0.85);
    color: rgba(30, 30, 60, 0.85);
  }
  .dot {
    opacity: 0.45;
    margin: 0 2px;
  }
  .v {
    white-space: nowrap;
  }
  /* iOS Safari < 18 / 老 Android 不支持 backdrop-filter fallback */
  @supports not (backdrop-filter: blur(1px)) {
    .version-badge {
      background: rgba(255, 255, 255, 0.95);
    }
  }
</style>
