import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { execSync } from "node:child_process";

/**
 * v0.3.36 (PO msg 2026-07-27 12:19 你在页面 header 上添加前后端版本号。
 * 我们以此对齐): 在 vite config 加载时读 git rev-parse --short HEAD,
 * 设到 `import.meta.env.VITE_APP_VERSION`. v0.3.36 #1 VersionBadge 显示 FE hash
 * 用这个 env var (Vite 自动把 VITE_* 暴露给客户端 import.meta.env.VITE_*).
 *
 * 工作 tree 有未提交改动时附加 '-dirty', git 不可读时 fallback 'unknown'.
 */
function gitVersionPlugin() {
  return {
    name: "git-version",
    config() {
      try {
        const hash = execSync("git rev-parse --short=8 HEAD", {
          stdio: ["pipe", "pipe", "pipe"],
        })
          .toString()
          .trim();
        let dirty = "";
        try {
          execSync("git diff --quiet HEAD", { stdio: "pipe" });
        } catch {
          dirty = "-dirty";
        }
        process.env.VITE_APP_VERSION = `${hash}${dirty}`;
      } catch {
        if (!process.env.VITE_APP_VERSION) process.env.VITE_APP_VERSION = "unknown";
      }
    },
  };
}

const tunnelHost = process.env.SBC_TUNNEL_HOST?.trim() || "";

export default defineConfig({
  plugins: [gitVersionPlugin(), sveltekit()],
  server: {
    port: 8448,
    strictPort: true,
    host: "0.0.0.0",
    // Mobile / tunnel QA: allow loca.lt + trycloudflare quick tunnels (suffix match).
    allowedHosts: [
      "test.jessejia.pp.ua",
      "localhost",
      "127.0.0.1",
      ".loca.lt",
      ".trycloudflare.com",
      ...(tunnelHost ? [tunnelHost] : []),
    ],
    // Prod/staging uses wss HMR; tunnel/mobile QA disables HMR (phone doesn't need HMR).
    hmr: tunnelHost
      ? false
      : {
          protocol: "wss",
          host: "test.jessejia.pp.ua",
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
          // /auth/login 是 SvelteKit 页面, 不能代理到后端。
          // 注意 req.url 含 query string (e.g. /auth/login?returnTo=/sessions/4
          // 由 401 自动重定向触发), 所以用 path-only 比较避免误把 query
          // 形态的 login 页代理到后端 (uvicorn 找不到该路由返 404)。
          const path = req.url.split("?")[0];
          if (path === "/auth/login" || path === "/auth/login/") return req.url;
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
