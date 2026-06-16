#!/usr/bin/env node
/**
 * server.mjs — tiny local server + SQLite progress store for Opportunity Explorer.
 *
 *   node server.mjs            # serves http://localhost:4317
 *
 * Uses only Node built-ins (node:http + node:sqlite). No npm install.
 * - Serves index.html, data.js, enrichment.js, assets/ statically.
 * - Exposes a small JSON API for YOUR application progress, backed by app.db.
 * - app.db holds ONLY mutable progress (status/star/rating/dates/checklist/log),
 *   keyed by item id, so a data refresh never clobbers it.
 * Binds to localhost only.
 */
process.removeAllListeners('warning'); // silence node:sqlite ExperimentalWarning
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4317;

/* ---------- database ---------- */
const db = new DatabaseSync(join(__dirname, 'app.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS progress (
    item_id     TEXT PRIMARY KEY,
    status      TEXT,
    starred     INTEGER DEFAULT 0,
    rating      INTEGER DEFAULT 0,
    applied_on  TEXT,
    follow_up_on TEXT,
    checklist   TEXT,            -- JSON
    updated_at  TEXT
  );
  CREATE TABLE IF NOT EXISTS activity (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT,
    ts      TEXT,
    text    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_activity_item ON activity(item_id);
`);

const upsert = db.prepare(`
  INSERT INTO progress (item_id, status, starred, rating, applied_on, follow_up_on, checklist, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(item_id) DO UPDATE SET
    status=excluded.status, starred=excluded.starred, rating=excluded.rating,
    applied_on=excluded.applied_on, follow_up_on=excluded.follow_up_on,
    checklist=excluded.checklist, updated_at=excluded.updated_at
`);
const selAll = db.prepare(`SELECT * FROM progress`);
const selOne = db.prepare(`SELECT * FROM progress WHERE item_id = ?`);
const insLog = db.prepare(`INSERT INTO activity (item_id, ts, text) VALUES (?, ?, ?)`);
const selLog = db.prepare(`SELECT id, ts, text FROM activity WHERE item_id = ? ORDER BY id DESC`);
const selAllLog = db.prepare(`SELECT id, item_id, ts, text FROM activity ORDER BY id DESC`);

function rowToProgress(r) {
  if (!r) return null;
  return {
    id: r.item_id,
    status: r.status || 'New',
    starred: !!r.starred,
    rating: r.rating || 0,
    appliedOn: r.applied_on || '',
    followUpOn: r.follow_up_on || '',
    checklist: r.checklist ? JSON.parse(r.checklist) : {},
    updatedAt: r.updated_at || '',
    log: selLog.all(r.item_id).map((l) => ({ id: l.id, ts: l.ts, text: l.text })),
  };
}

/* ---------- static files ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.gif': 'image/gif',
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'cache-control': 'no-cache', ...headers });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8' });

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

function progressToCsv(rows, logsByItem) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['item_id', 'status', 'starred', 'rating', 'applied_on', 'follow_up_on', 'checklist', 'updated_at', 'activity_log'];
  const lines = [head.join(',')];
  for (const r of rows) {
    const logs = (logsByItem[r.item_id] || []).map((l) => `${l.ts}: ${l.text}`).join(' | ');
    lines.push([r.item_id, r.status, r.starred, r.rating, r.applied_on, r.follow_up_on, r.checklist, r.updated_at, logs].map(esc).join(','));
  }
  return lines.join('\n');
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = join(__dirname, safe);
  if (!file.startsWith(__dirname)) return send(res, 403, 'Forbidden');
  try {
    const s = await stat(file);
    if (s.isDirectory()) return send(res, 403, 'Forbidden');
    const buf = await readFile(file);
    send(res, 200, buf, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
  } catch {
    send(res, 404, 'Not found');
  }
}

/* ---------- request router ---------- */
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    if (p === '/api/health') return json(res, 200, { ok: true, port: PORT });

    if (p === '/api/progress' && req.method === 'GET') {
      return json(res, 200, selAll.all().map(rowToProgress));
    }

    const mPut = p.match(/^\/api\/progress\/([^/]+)$/);
    if (mPut && req.method === 'PUT') {
      const id = decodeURIComponent(mPut[1]);
      const b = await readBody(req);
      const cur = selOne.get(id);
      const merged = {
        status: b.status ?? cur?.status ?? 'New',
        starred: (b.starred ?? !!cur?.starred) ? 1 : 0,
        rating: b.rating ?? cur?.rating ?? 0,
        appliedOn: b.appliedOn ?? cur?.applied_on ?? '',
        followUpOn: b.followUpOn ?? cur?.follow_up_on ?? '',
        checklist: b.checklist ?? (cur?.checklist ? JSON.parse(cur.checklist) : {}),
      };
      upsert.run(id, merged.status, merged.starred, merged.rating, merged.appliedOn,
        merged.followUpOn, JSON.stringify(merged.checklist), new Date().toISOString());
      return json(res, 200, rowToProgress(selOne.get(id)));
    }

    const mLog = p.match(/^\/api\/progress\/([^/]+)\/log$/);
    if (mLog && req.method === 'POST') {
      const id = decodeURIComponent(mLog[1]);
      const b = await readBody(req);
      const text = (b.text || '').toString().trim();
      if (!text) return json(res, 400, { error: 'empty' });
      const ts = b.ts || new Date().toISOString();
      // ensure a progress row exists so the item shows on the board
      if (!selOne.get(id)) upsert.run(id, 'New', 0, 0, '', '', '{}', new Date().toISOString());
      insLog.run(id, ts, text);
      return json(res, 200, rowToProgress(selOne.get(id)));
    }

    if (p === '/api/export.json') {
      const rows = selAll.all().map(rowToProgress);
      return send(res, 200, JSON.stringify({ exportedAt: new Date().toISOString(), progress: rows }, null, 2),
        { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="opportunity-progress.json"' });
    }
    if (p === '/api/export.csv') {
      const rows = selAll.all();
      const logsByItem = {};
      for (const l of selAllLog.all()) (logsByItem[l.item_id] = logsByItem[l.item_id] || []).push(l);
      return send(res, 200, progressToCsv(rows, logsByItem),
        { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="opportunity-progress.csv"' });
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'unknown endpoint' });

    return serveStatic(req, res, p);
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Opportunity Explorer → http://localhost:${PORT}  (Ctrl-C to stop)`);
});
