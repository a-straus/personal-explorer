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
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4317;

/* ---------- semantic search (vectors built by embed.mjs) ---------- */
// Query embedding runs locally via @huggingface/transformers; the pipeline is
// lazy-loaded on the first /api/semantic call (~2s warmup, instant after).
let vecCache = null; // { mtime, meta, vecs }
function loadVectors() {
  const binPath = join(__dirname, 'vectors.bin');
  const metaPath = join(__dirname, 'vectors-meta.json');
  if (!existsSync(binPath) || !existsSync(metaPath)) return null;
  const mtime = statSync(binPath).mtimeMs;
  if (vecCache && vecCache.mtime === mtime) return vecCache;
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const buf = readFileSync(binPath);
  if (buf.length !== meta.count * meta.dim * 4) return null;
  const vecs = new Float32Array(buf.buffer, buf.byteOffset, meta.count * meta.dim);
  vecCache = { mtime, meta, vecs };
  return vecCache;
}
let extractorPromise = null;
function getExtractor(model) {
  if (!extractorPromise) {
    extractorPromise = import('@huggingface/transformers')
      .then(({ pipeline }) => pipeline('feature-extraction', model, { dtype: 'q8' }));
  }
  return extractorPromise;
}
async function semanticSearch(q, limit = 40) {
  const v = loadVectors();
  if (!v) return { error: 'no vectors — run embed.mjs' };
  const { meta, vecs } = v;
  const extractor = await getExtractor(meta.model);
  const t = await extractor([meta.queryPrefix + q], { pooling: 'mean', normalize: true });
  const qv = t.data; // Float32Array [dim], L2-normalized
  const dim = meta.dim;
  const scores = new Array(meta.count);
  for (let i = 0; i < meta.count; i++) {
    let s = 0;
    const off = i * dim;
    for (let d = 0; d < dim; d++) s += vecs[off + d] * qv[d];
    scores[i] = [s, i];
  }
  scores.sort((a, b) => b[0] - a[0]);
  return {
    results: scores.slice(0, limit).map(([score, i]) => ({ id: meta.ids[i], score: Number(score.toFixed(4)) })),
  };
}

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
// migrations: add columns to pre-existing progress tables (ALTER is a no-op-if-exists via try/catch)
for (const col of ['note TEXT', 'hidden INTEGER DEFAULT 0', 'tags TEXT', 'facet_commute TEXT', 'facet_effort TEXT']) {
  try { db.exec(`ALTER TABLE progress ADD COLUMN ${col}`); } catch { /* column already exists */ }
}

const upsert = db.prepare(`
  INSERT INTO progress (item_id, status, starred, rating, applied_on, follow_up_on, checklist, note, hidden, tags, facet_commute, facet_effort, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(item_id) DO UPDATE SET
    status=excluded.status, starred=excluded.starred, rating=excluded.rating,
    applied_on=excluded.applied_on, follow_up_on=excluded.follow_up_on,
    checklist=excluded.checklist, note=excluded.note, hidden=excluded.hidden,
    tags=excluded.tags, facet_commute=excluded.facet_commute, facet_effort=excluded.facet_effort,
    updated_at=excluded.updated_at
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
    note: r.note || '',
    hidden: !!r.hidden,
    tags: r.tags ? JSON.parse(r.tags) : [],
    facetCommute: r.facet_commute || '',
    facetEffort: r.facet_effort || '',
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
  const head = ['item_id', 'status', 'starred', 'rating', 'applied_on', 'follow_up_on', 'checklist', 'note', 'hidden', 'tags', 'facet_commute', 'facet_effort', 'updated_at', 'activity_log'];
  const lines = [head.join(',')];
  for (const r of rows) {
    const logs = (logsByItem[r.item_id] || []).map((l) => `${l.ts}: ${l.text}`).join(' | ');
    lines.push([r.item_id, r.status, r.starred, r.rating, r.applied_on, r.follow_up_on, r.checklist, r.note, r.hidden, r.tags, r.facet_commute, r.facet_effort, r.updated_at, logs].map(esc).join(','));
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
    if (p === '/api/health') return json(res, 200, { ok: true, port: PORT, semantic: !!loadVectors() });

    if (p === '/api/semantic' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return json(res, 400, { error: 'empty query' });
      const limit = Math.min(Number(url.searchParams.get('limit')) || 40, 200);
      const out = await semanticSearch(q, limit);
      return json(res, out.error ? 503 : 200, out);
    }

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
        note: b.note ?? cur?.note ?? '',
        hidden: (b.hidden ?? !!cur?.hidden) ? 1 : 0,
        tags: b.tags ?? (cur?.tags ? JSON.parse(cur.tags) : []),
        facetCommute: b.facetCommute ?? cur?.facet_commute ?? '',
        facetEffort: b.facetEffort ?? cur?.facet_effort ?? '',
      };
      upsert.run(id, merged.status, merged.starred, merged.rating, merged.appliedOn,
        merged.followUpOn, JSON.stringify(merged.checklist), merged.note, merged.hidden,
        JSON.stringify(merged.tags), merged.facetCommute, merged.facetEffort, new Date().toISOString());
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
      if (!selOne.get(id)) upsert.run(id, 'New', 0, 0, '', '', '{}', '', 0, '[]', '', '', new Date().toISOString());
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
