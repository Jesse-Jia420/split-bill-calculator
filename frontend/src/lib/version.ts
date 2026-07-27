// Auto-derived: vite.config.ts 的 gitVersionPlugin 在 dev server 启动时跑
// `git rev-parse --short HEAD` + dirty 检查, 写到 `import.meta.env.VITE_APP_VERSION`.
// 这里直接 re-export, 让 archive Footer.svelte 还能 import 但数据永远新鲜
// (跟实际部署的 commit hash 同步).
export const FRONTEND_VERSION: string =
  (import.meta.env.VITE_APP_VERSION as string) ?? 'unknown';
