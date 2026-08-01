// frontend/proxy-server.js — reverse proxy for sveltekit adapter-node + BE uvicorn
// 监听 :8448, /api/* 转到 localhost:8449 (BE uvicorn), 其他走 sveltekit handler
// 反 #159 修: FE 不能独立 serve SPA — adapter-node 没 proxy, 必须 wrapper
import { createServer } from 'node:http';
import { handler } from './build/handler.js';

const PORT = Number(process.env.PORT) || 8448;
const HOST = process.env.HOST || '0.0.0.0';
const BE = process.env.BE_URL || 'http://sbc-backend-cursor:8449';

const server = createServer(async (req, res) => {
  // /api/* → BE
  if (req.url && req.url.startsWith('/api/')) {
    const targetPath = req.url.replace(/^\/api/, '');
    const targetUrl = BE + targetPath;
    console.log(`[proxy] ${req.method} ${req.url} → ${req.method} ${targetUrl}`);

    // 收集 request body (for POST/PUT/PATCH/DELETE)
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
        const fheaders = { ...req.headers };
        // strip hop-by-hop / length-mismatch
        delete fheaders['host'];
        delete fheaders['content-length'];
        delete fheaders['connection'];
        // strip accept-encoding so we can stream response without decompression
        delete fheaders['accept-encoding'];
        if (body) {
          fheaders['content-length'] = String(body.length);
        }
        console.log(`[proxy] body bytes=${body ? body.length : 0}, ct=${fheaders['content-type']}`);

        const r = await fetch(targetUrl, {
          method: req.method,
          headers: fheaders,
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
          redirect: 'manual',
        });

        // 写 status + headers
        const rh = Object.fromEntries(r.headers);
        delete rh['content-encoding'];
        delete rh['content-length'];
        delete rh['transfer-encoding'];
        delete rh['connection'];
        // Pass set-cookie through as array (fetch merges multiple Set-Cookie into one string)
        const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : (r.headers.get('set-cookie') ? [r.headers.get('set-cookie')] : []);
        if (setCookie && setCookie.length > 0) {
          rh['set-cookie'] = setCookie;
        }
        res.writeHead(r.status, rh);
        console.log(`[proxy] ${req.method} ${targetUrl} ← ${r.status}`);

        // 流 body
        if (r.body) {
          const reader = r.body.getReader();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
        }
        res.end();
      } catch (e) {
        console.error('[proxy] /api/* → BE error:', e);
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'proxy_error', message: String(e) }));
      }
    });
    return;
  }

  // 其他 → sveltekit handler
  handler(req, res, () => {
    if (!res.writableEnded) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[proxy] listening on http://${HOST}:${PORT}, /api/* → ${BE}`);
});