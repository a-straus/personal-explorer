// Zero-dependency static file server for the deployed Opportunity Explorer bundle.
//
// The deploy is a pure client-side app (index.html + data.js + facets.js +
// enrichment.js + vectors.bin + assets/). It needs NO npm dependencies at
// runtime — the heavy build tooling (transformers/playwright) is dev-only.
// This server exists so the platform (Railway) has an explicit, lightweight
// way to serve the files instead of trying to build the repo as a Node service.
//
// Semantic *text* search is intentionally not available here (no query-embedding
// endpoint on the static deploy — see PLAN.md §5); "more like this" works
// client-side via vectors.bin. The full local API lives in server.mjs.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

const server = http.createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, `http://localhost`).pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';

    // Resolve inside ROOT only — reject path traversal.
    const filePath = normalize(join(ROOT, pathname));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }

    const type = TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
    // vectors.bin and data are content-versioned by refresh; cache modestly.
    const cache = pathname === '/index.html' ? 'no-cache' : 'public, max-age=3600';
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache }).end(body);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Server error');
    console.error(err);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Opportunity Explorer (static) → listening on 0.0.0.0:${PORT}`);
});
