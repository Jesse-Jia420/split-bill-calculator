import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    port: 8448,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: ["test.jessejia.pp.ua", "localhost", "127.0.0.1"],
    hmr: {
      // 反向代理 HTTPS — HMR WebSocket 用 wss + 代理 host
      protocol: "wss",
      host: "test.jessejia.pp.ua"
    },
    proxy: {
      // Standard API prefix (canonical path used by client.ts).
      "/api": {
        target: "http://127.0.0.1:8449",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, "")
      },
      // Fallback proxies for legacy / cached client bundles that do not
      // prepend /api. Forwarded as-is (no rewrite).
      "/auth": { target: "http://127.0.0.1:8449", changeOrigin: true },
      "/sessions": { target: "http://127.0.0.1:8449", changeOrigin: true },
      "/invites": { target: "http://127.0.0.1:8449", changeOrigin: true },
      "/health": { target: "http://127.0.0.1:8449", changeOrigin: true }
    }
  }
});
