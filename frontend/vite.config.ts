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
      //
      // v0.1.4 round 2: 修复 SvelteKit 页面 404 问题。
      // 之前 commit 2e17d7c 引入的 /auth /sessions /invites /health 宽泛前缀
      // 代理, 把 SvelteKit 页面也一起代理到后端, 导致 /auth/login /sessions/1
      // /invites/[token] 等页面返回 JSON / 404。
      // 修法: 用 bypass 函数, 把 SvelteKit 页面显式 bypass, 让 SvelteKit 处理;
      // 真正的 API endpoint (例如 /auth/me, /auth/send-code, /invites/{token}/accept)
      // 继续被代理到后端。
      "/auth": {
        target: "http://127.0.0.1:8449",
        changeOrigin: true,
        bypass: (req) => {
          // /auth/login 是 SvelteKit 页面, 不能代理到后端
          if (req.url === "/auth/login" || req.url === "/auth/login/") return req.url;
          // 其他 /auth/* (me / send-code / verify-code / logout) 继续代理
        }
      },
      "/sessions": {
        target: "http://127.0.0.1:8449",
        changeOrigin: true,
        // 所有 /sessions/* 都是 SvelteKit 页面, 后端 API 用 /api/sessions
        bypass: (req) => req.url
      },
      "/invites": {
        target: "http://127.0.0.1:8449",
        changeOrigin: true,
        bypass: (req) => {
          // /invites/{token}/accept 是后端 API, 继续代理
          if (/^\/invites\/[^/]+\/accept\/?$/.test(req.url)) return undefined;
          // 其他 /invites/* 是 SvelteKit 页面, 跳过代理
          return req.url;
        }
      },
      "/health": { target: "http://127.0.0.1:8449", changeOrigin: true }
    }
  }
});
