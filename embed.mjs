#!/usr/bin/env node
/**
 * embed.mjs — builds semantic-search vectors for every item, fully local (no API).
 *
 * Reads data.json, writes:
 *   - vectors.bin        raw Float32Array, L2-normalized, row-major [count × dim] — deploys with the site
 *   - vectors-meta.json  { model, dim, count, ids, hashes, queryPrefix, generatedAt }
 *
 * Model: Xenova/bge-small-en-v1.5 (q8) via @huggingface/transformers (devDependency, build-time only).
 * Idempotent: unchanged items reuse their existing rows from vectors.bin.
 *   node embed.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = join(__dirname, 'vectors.bin');
const META_PATH = join(__dirname, 'vectors-meta.json');

const MODEL = 'Xenova/bge-small-en-v1.5';
const DIM = 384;
// BGE models want this prefix on QUERIES only (not on the passages we embed here).
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

function passageText(it) {
  return [it.title, it.org, it.category, it.commitment, it.location, it.pay, (it.notes || '').slice(0, 1200)]
    .filter(Boolean).join('. ');
}

async function main() {
  const data = JSON.parse(readFileSync(join(__dirname, 'data.json'), 'utf8'));
  const items = data.items;

  // load previous run for reuse
  let prev = null;
  if (existsSync(META_PATH) && existsSync(BIN_PATH)) {
    try {
      const meta = JSON.parse(readFileSync(META_PATH, 'utf8'));
      const buf = readFileSync(BIN_PATH);
      if (meta.model === MODEL && meta.dim === DIM && buf.length === meta.count * DIM * 4) {
        const vecs = new Float32Array(buf.buffer, buf.byteOffset, meta.count * DIM);
        const rowByHash = new Map();
        meta.ids.forEach((id, i) => { if (meta.hashes[id]) rowByHash.set(meta.hashes[id], i); });
        prev = { vecs, rowByHash };
      }
    } catch { /* rebuild from scratch */ }
  }

  const texts = items.map(passageText);
  const hashes = texts.map(sha1);
  const out = new Float32Array(items.length * DIM);
  const todoIdx = [];
  let reused = 0;
  for (let i = 0; i < items.length; i++) {
    const row = prev?.rowByHash.get(hashes[i]);
    if (row !== undefined) {
      out.set(prev.vecs.subarray(row * DIM, (row + 1) * DIM), i * DIM);
      reused++;
    } else {
      todoIdx.push(i);
    }
  }
  console.log(`Embed: ${items.length} items; ${todoIdx.length} to embed (${MODEL} q8), ${reused} reused.`);

  if (todoIdx.length) {
    const { pipeline } = await import('@huggingface/transformers');
    const extractor = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
    const CHUNK = 16;
    for (let i = 0; i < todoIdx.length; i += CHUNK) {
      const idxs = todoIdx.slice(i, i + CHUNK);
      const t = await extractor(idxs.map((k) => texts[k]), { pooling: 'mean', normalize: true });
      const flat = t.data; // Float32Array [idxs.length × DIM]
      idxs.forEach((k, j) => out.set(flat.subarray(j * DIM, (j + 1) * DIM), k * DIM));
      process.stdout.write(`  ${Math.min(i + CHUNK, todoIdx.length)}/${todoIdx.length}\r`);
    }
    console.log('');
  }

  const hashesById = {};
  items.forEach((it, i) => { hashesById[it.id] = hashes[i]; });
  writeFileSync(BIN_PATH, Buffer.from(out.buffer, out.byteOffset, out.byteLength));
  writeFileSync(META_PATH, JSON.stringify({
    model: MODEL, dim: DIM, count: items.length,
    ids: items.map((it) => it.id), hashes: hashesById,
    queryPrefix: QUERY_PREFIX, generatedAt: new Date().toISOString(),
  }));
  console.log(`Wrote vectors.bin (${(out.byteLength / 1024).toFixed(0)} KB) + vectors-meta.json for ${items.length} items.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
