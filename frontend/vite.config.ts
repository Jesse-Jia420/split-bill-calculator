import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { execSync } from "node:child_process";

/** Expose short git hash as `import.meta.env.VITE_APP_VERSION`. */
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
const lanHost = process.env.SBC_LAN_HOST?.trim() || "";

// Vite 5 blocks unknown Host headers. Default `true` so LAN phones can open
// the dev server. Set SBC_DEV_STRICT_HOSTS=1 to require an explicit allow-list.
const strictHosts = process.env.SBC_DEV_STRICT_HOSTS === "1";

export default defineConfig({
  plugins: [gitVersionPlugin(), sveltekit()],
  server: {
    port: 8448,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: strictHosts
      ? [
          "localhost",
          "127.0.0.1",
          ".loca.lt",
          ".trycloudflare.com",
          ...(tunnelHost ? [tunnelHost] : []),
          ...(lanHost ? [lanHost] : []),
        ]
      : true,
    hmr: tunnelHost
      ? false
      : lanHost
        ? { host: lanHost, port: 8448, protocol: "ws" }
        : undefined,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8449",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      // Legacy clients that omit /api — bypass SvelteKit page routes.
      "/auth": {
        target: "http://127.0.0.1:8449",
        changeOrigin: true,
        bypass: (req) => {
          const path = req.url.split("?")[0];
          if (path === "/auth/login" || path === "/auth/login/") return req.url;
        },
      },
      "/sessions": {
        target: "http://127.0.0.1:8449",
        changeOrigin: true,
        bypass: (req) => req.url,
      },
      "/invites": {
        target: "http://127.0.0.1:8449",
        changeOrigin: true,
        bypass: (req) => {
          if (/^\/invites\/[^/]+\/accept\/?$/.test(req.url)) return undefined;
          return req.url;
        },
      },
      "/health": { target: "http://127.0.0.1:8449", changeOrigin: true },
    },
  },
});
