#!/usr/bin/env node
/**
 * classify.mjs — auto-classifies every item with commute + time-commitment facets via Claude.
 *
 * Reads data.json, writes:
 *   - facets.js              (window.TEACHING_FACETS = { byId, homeBase, generatedAt }) — deploys with the site
 *   - facets.json            (same payload, for tooling)
 *   - .classify-cache.json   (idempotent cache keyed by item id + content hash)
 *
 * Zero dependencies — raw fetch to the Claude API, same pattern as enrich.mjs.
 *   node classify.mjs
 * Requires ANTHROPIC_API_KEY (or CLAUDE_API_KEY) in .env.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(__dirname, '.classify-cache.json');

/* ---- minimal .env loader (no dependency) ---- */
(() => {
  const p = join(__dirname, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
})();

const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '';
if (!CLAUDE_KEY) { console.error('No ANTHROPIC_API_KEY / CLAUDE_API_KEY in .env — cannot classify.'); process.exit(1); }

const MODEL = 'claude-sonnet-5';
const COMMUTE = ['Walkable', 'Short transit', 'Long haul', 'Too far', 'Remote', 'Unknown'];
const EFFORT = ['<2 hrs/wk', '2–5 hrs/wk', '5–15 hrs/wk', '15+ hrs/wk', 'Full-time', 'Unknown'];

const HOME_BASE = 'Greenpoint, Brooklyn 11222 — at the Greenpoint Ave G station';

const SYSTEM = `You classify teaching/tutoring opportunities for someone who lives in ${HOME_BASE}.

For each item assign exactly two facets.

## commute — door-to-door from the Greenpoint Ave G stop
- "Walkable": ≤~25 min on foot. Greenpoint itself, north Williamsburg / McCarren Park area.
- "Short transit": ≤~40 min door-to-door. The G corridor (Long Island City, Williamsburg, Fort Greene, Clinton Hill, Bed-Stuy near the G, downtown Brooklyn); L into 14th St Manhattan (Union Square, Chelsea); 7/E/M from Court Sq into Midtown; anything in Manhattan below ~59th St near those transfers.
- "Long haul": ~40–75 min. Upper Manhattan, Harlem, most of the Bronx near subway, deep Brooklyn (Bay Ridge, Coney Island), central Queens (Flushing, Jamaica), Staten Island ferry-adjacent.
- "Too far": >75 min or effectively unreachable by subway — New Jersey, Westchester, Long Island beyond western Queens, Connecticut, upstate, other cities/states.
- "Remote": the work itself is online/virtual/hybrid-mostly-remote. Remote wins over geography.
- "Unknown": genuinely no way to tell.

Use your knowledge of the organization when the listing is vague — e.g. a well-known school or museum has a known campus. If a listing just says "NYC" or "New York", infer the org's actual location if you know it; otherwise "Short transit" for Manhattan-based orgs is a reasonable default, "Unknown" if you truly can't tell.

## effort — realistic weekly time commitment
- "<2 hrs/wk": one-off events, info sessions, workshops, conferences, open houses. Events are usually this.
- "2–5 hrs/wk": light tutoring (1–2 sessions/wk), weekly volunteer shifts, short courses.
- "5–15 hrs/wk": part-time teaching, multiple tutoring clients, substantial programs alongside other work.
- "15+ hrs/wk": heavy part-time, intensive fellowships/residencies that aren't quite full-time.
- "Full-time": full-time jobs; M–F full-day summer programs/intensives count as Full-time for their duration.
- "Unknown": genuinely no signal.

Judge from role type, commitment text, pay structure (salary → Full-time; hourly per-session → lighter), and program descriptions. Prefer a judgment over "Unknown" when the role type makes it obvious.`;

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          commute: { type: 'string', enum: COMMUTE },
          effort: { type: 'string', enum: EFFORT },
        },
        required: ['id', 'commute', 'effort'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const itemHash = (it) => sha1(JSON.stringify([it.title, it.org, it.category, it.commitment, it.location, it.pay, (it.notes || '').slice(0, 800), it.dataset]));

function itemLine(it) {
  const f = [];
  f.push(`id=${it.id}`);
  f.push(`dataset=${it.dataset}`);
  if (it.title) f.push(`title=${it.title}`);
  if (it.org) f.push(`org=${it.org}`);
  if (it.category) f.push(`category=${it.category}`);
  if (it.commitment) f.push(`commitment=${it.commitment}`);
  if (it.location) f.push(`location=${it.location}`);
  if (it.pay) f.push(`pay=${it.pay}`);
  if (it.notes) f.push(`notes=${it.notes.slice(0, 500).replace(/\s+/g, ' ')}`);
  return f.join(' | ');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function classifyBatch(batch, attempt = 0) {
  const body = {
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: `Classify each item. Return one entry per item, same ids.\n\n${batch.map(itemLine).join('\n')}`,
    }],
  };
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(180000),
      headers: {
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      if ((r.status === 429 || r.status >= 500 || r.status === 529) && attempt < 3) {
        const wait = 2000 * 2 ** attempt;
        console.warn(`  HTTP ${r.status}, retry in ${wait}ms`);
        await sleep(wait);
        return classifyBatch(batch, attempt + 1);
      }
      console.warn(`  Claude HTTP ${r.status}: ${txt.slice(0, 200)} — skipping batch`);
      return null;
    }
    const j = await r.json();
    const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.items) ? parsed.items : null;
  } catch (e) {
    if (attempt < 3) { await sleep(2000 * 2 ** attempt); return classifyBatch(batch, attempt + 1); }
    console.warn('  Claude error:', e.message);
    return null;
  }
}

/* ---- simple concurrency pool (same as enrich.mjs) ---- */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

async function main() {
  const data = JSON.parse(readFileSync(join(__dirname, 'data.json'), 'utf8'));
  const items = data.items;
  const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {};
  cache.byId = cache.byId || {};

  const todo = items.filter((it) => cache.byId[it.id]?.hash !== itemHash(it));
  console.log(`Classify: ${items.length} items; ${todo.length} to classify (${MODEL}), ${items.length - todo.length} cached.`);

  const BATCH = 12;
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));

  let done = 0;
  await pool(batches, 3, async (batch) => {
    const res = await classifyBatch(batch);
    if (res) {
      const byId = new Map(res.map((r) => [r.id, r]));
      for (const it of batch) {
        const r = byId.get(it.id);
        if (r) cache.byId[it.id] = { hash: itemHash(it), commute: r.commute, effort: r.effort };
      }
    }
    done += batch.length;
    console.log(`  ${done}/${todo.length}`);
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2)); // checkpoint
  });

  // ---------- assemble facets.js ----------
  const byId = {};
  let cCount = 0, eCount = 0;
  for (const it of items) {
    const c = cache.byId[it.id];
    if (!c) continue;
    const e = {};
    if (c.commute && c.commute !== 'Unknown') { e.commute = c.commute; cCount++; }
    if (c.effort && c.effort !== 'Unknown') { e.effort = c.effort; eCount++; }
    if (Object.keys(e).length) byId[it.id] = e;
  }
  const payload = { byId, homeBase: HOME_BASE, model: MODEL, generatedAt: new Date().toISOString() };
  writeFileSync(join(__dirname, 'facets.js'),
    `// Generated by classify.mjs — do not edit by hand.\nwindow.TEACHING_FACETS = ${JSON.stringify(payload)};\n`);
  writeFileSync(join(__dirname, 'facets.json'), JSON.stringify(payload, null, 2));
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  console.log(`Wrote facets.js — commute for ${cCount}/${items.length}, effort for ${eCount}/${items.length}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
