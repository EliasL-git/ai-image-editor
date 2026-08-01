// Production server for the built SPA. Serves apps/web/dist and proxies /api/*
// and asset routes to the API service (API_INTERNAL_URL) so a single public
// origin works.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(__dirname, 'dist');
const port = Number(process.env.PORT ?? 10000);
const apiTarget = process.env.API_INTERNAL_URL ?? '';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const server = http.createServer(async (req, res) => {
  const host = req.headers.host ?? '';
  const url = new URL(req.url ?? '/', `http://${host}`);

  // Health check for Render
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'ai-image-editor-web' }));
    return;
  }

  // Proxy API + asset routes to the API service
  if (url.pathname.startsWith('/api') && apiTarget) {
    const target = new URL(url.pathname.replace(/^\/api/, '') + url.search, apiTarget);
    const proxyReq = http.request(
      target,
      { method: req.method, headers: { ...req.headers, host: new URL(apiTarget).host } },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on('error', () => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'API service unreachable' }));
    });
    req.pipe(proxyReq);
    return;
  }

  if (['/uploads', '/masks', '/results', '/exports'].some((p) => url.pathname.startsWith(p)) && apiTarget) {
    const target = new URL(url.pathname + url.search, apiTarget);
    const proxyReq = http.request(target, { method: req.method, headers: req.headers }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'API service unreachable' }));
    });
    req.pipe(proxyReq);
    return;
  }

  // Static files (SPA fallback)
  const pathname = decodeURIComponent(url.pathname);
  let filePath = path.join(dist, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(dist)) filePath = path.join(dist, 'index.html');
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(dist, 'index.html');
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(port, () => {
  console.log(`[web] serving ${dist} on port ${port}`);
});
