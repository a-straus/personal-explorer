#!/usr/bin/env node
/**
 * enrich.mjs — adds logos (+ optional Claude "about/known for") to the dataset.
 *
 * Reads data.json, writes:
 *   - assets/logos/<domain>.png   (real logos we kept)
 *   - enrichment.js               (window.TEACHING_ENRICHMENT = { byId, generatedAt })
 *   - .enrich-cache.json          (idempotent cache: logos by domain, text by org)
 *
 * Zero dependencies — uses Node's built-in fetch. Network only at build time.
 *   node enrich.mjs            # logos always; Claude text only if a key is set
 *   node enrich.mjs --logos    # logos only (skip Claude even if key present)
 * Add ANTHROPIC_API_KEY=sk-... (or CLAUDE_API_KEY) to .env to enable the text step.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGO_DIR = join(__dirname, 'assets', 'logos');
const CACHE_PATH = join(__dirname, '.enrich-cache.json');

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
const ONLY_LOGOS = process.argv.includes('--logos');

/* ---- aggregators: faviconing these stamps the wrong brand → monogram instead ---- */
const AGGREGATOR_RE = [
  'eventbrite.', 'greenhouse.io', 'lever.co', 'myworkdayjobs.com', 'idealist.org',
  'corsizio.com', 'careers.nais.org', 'nysais.org', 'linkedin.com', 'indeed.com',
  'meetup.com', 'glassdoor.com', 'ziprecruiter.com', 'handshake', 'schoolspring',
  'edjoin.org', 'forms.gle', 'docs.google.com', 'google.com/forms', 'bit.ly',
  'tinyurl.com', 'paperform.co', 'jotform.com', 'wufoo.com', 'airtable.com',
  'notion.so', 'wd1.myworkdayjobs', 'wd5.myworkdayjobs', 'icims.com', 'taleo.net',
  'applytojob.com', 'jobvite.com', 'smartrecruiters.com', 'workable.com',
];
const isAggregator = (host) => AGGREGATOR_RE.some((a) => host.includes(a));

function hostOf(link) {
  try { return new URL(link).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
}

/* ---- image dimension sniffing (PNG / GIF / JPEG / ICO) ---- */
function imageDims(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  // JPEG — scan SOF markers
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
      }
      const len = buf.readUInt16BE(off + 2);
      off += 2 + len;
    }
    return null;
  }
  // ICO — directory entries; byte 0/1 of each entry is w/h (0 => 256)
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) {
    const n = buf.readUInt16LE(4);
    let best = { w: 0, h: 0 };
    for (let i = 0; i < n; i++) {
      const e = 6 + i * 16;
      if (e + 1 >= buf.length) break;
      const w = buf[e] === 0 ? 256 : buf[e];
      const h = buf[e + 1] === 0 ? 256 : buf[e + 1];
      if (Math.min(w, h) > Math.min(best.w, best.h)) best = { w, h };
    }
    return best.w ? best : null;
  }
  // WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 && buf[9] === 0x45) {
    // VP8X
    if (buf[12] === 0x56 && buf[15] === 0x58) {
      return { w: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)), h: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)) };
    }
  }
  return null;
}

async function fetchBuf(url, ms = 9000, headers = {}) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(ms),
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) OpportunityExplorer/2 logo-fetch', ...headers },
    });
    if (!r.ok) return null;
    const ab = await r.arrayBuffer();
    return Buffer.from(ab);
  } catch { return null; }
}

async function fetchText(url, ms = 9000) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(ms),
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) OpportunityExplorer/2' },
    });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

/* ---- parse <head> for icon/og:image candidates, resolve relative URLs ---- */
function parseIconLinks(html, baseUrl) {
  const cands = [];
  const resolve = (u) => { try { return new URL(u, baseUrl).href; } catch { return null; } };
  const linkRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const tag = m[0];
    const rel = (tag.match(/\brel\s*=\s*["']?([^"'>]+)/i) || [])[1] || '';
    const href = (tag.match(/\bhref\s*=\s*["']([^"']+)/i) || [])[1];
    if (!href) continue;
    const r = rel.toLowerCase();
    if (r.includes('apple-touch-icon')) cands.push({ url: resolve(href), score: 100 });
    else if (r.includes('icon')) {
      const sizes = (tag.match(/\bsizes\s*=\s*["']?(\d+)/i) || [])[1];
      cands.push({ url: resolve(href), score: 40 + (sizes ? Math.min(+sizes, 512) / 10 : 0) });
    }
  }
  const metaRe = /<meta\b[^>]*>/gi;
  while ((m = metaRe.exec(html))) {
    const tag = m[0];
    const prop = (tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)/i) || [])[1] || '';
    if (/og:image(:secure_url)?$/i.test(prop) || /twitter:image$/i.test(prop)) {
      const c = (tag.match(/\bcontent\s*=\s*["']([^"']+)/i) || [])[1];
      if (c) cands.push({ url: resolve(c), score: 70 });
    }
  }
  return cands.filter((c) => c.url).sort((a, b) => b.score - a.score);
}

/* ---- resolve one logo for a domain → saves png, returns relative path or null ---- */
async function resolveLogo(host, link) {
  const safe = host.replace(/[^a-z0-9.-]/g, '_');
  const rel = `assets/logos/${safe}.png`;
  const abs = join(LOGO_DIR, `${safe}.png`);

  const candidateUrls = [];
  // 1) parse the page head
  const origin = (() => { try { return new URL(link).origin; } catch { return `https://${host}`; } })();
  const html = await fetchText(origin, 8000);
  if (html) for (const c of parseIconLinks(html, origin)) candidateUrls.push(c.url);
  // 2) common guesses
  candidateUrls.push(`${origin}/apple-touch-icon.png`, `${origin}/apple-touch-icon-precomposed.png`);
  // 3) favicon service (returns PNG)
  candidateUrls.push(`https://www.google.com/s2/favicons?domain=${host}&sz=128`);

  const seen = new Set();
  let fallback = null; // best <64px image, used only if nothing better
  for (const url of candidateUrls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const buf = await fetchBuf(url, 8000);
    if (!buf || buf.length < 80) continue;
    const dims = imageDims(buf);
    const minDim = dims ? Math.min(dims.w, dims.h) : 0;
    if (dims && minDim >= 64) {
      writeFileSync(abs, buf);
      return { logo: rel, w: dims.w, h: dims.h };
    }
    if (dims && minDim > (fallback?.min || 0) && minDim >= 48) {
      fallback = { buf, min: minDim, dims };
    }
  }
  // Keep a decent-but-smallish favicon (≥48px) rather than nothing
  if (fallback) { writeFileSync(abs, fallback.buf); return { logo: rel, w: fallback.dims.w, h: fallback.dims.h }; }
  return { logo: null };
}

/* ---- simple concurrency pool ---- */
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

/* ---- Claude Haiku: per-org factual "about / known for" ---- */
async function claudeBatch(orgs) {
  const list = orgs.map((o, i) =>
    `${i + 1}. org="${o.org}" | category="${o.category}" | location="${o.location}" | example="${o.title}"`
  ).join('\n');
  const prompt =
`You are given organizations behind education-related opportunities (jobs, programs, events) in/around NYC.
For each, write two SHORT, factual lines about the organization itself in the world — NOT about the specific role.
- "about": <=160 chars, what the org is (e.g. "Spence is a top-tier K-12 independent girls' school on Manhattan's Upper East Side").
- "knownFor": <=100 chars, what it's best known for.
If you are NOT reasonably confident what the organization is, return empty strings for both — never guess or fabricate.
Return ONLY a JSON array, one object per item in order, like:
[{"about":"...","knownFor":"..."}, ...]

Items:
${list}`;

  const body = {
    model: 'claude-haiku-4-5',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  };
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(60000),
      headers: {
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) { console.warn(`  Claude HTTP ${r.status} — skipping this batch`); return null; }
    const j = await r.json();
    const text = (j.content || []).map((c) => c.text || '').join('');
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end < 0) return null;
    const arr = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr) ? arr : null;
  } catch (e) {
    console.warn('  Claude error:', e.message);
    return null;
  }
}

/* ============================ main ============================ */
async function main() {
  if (!existsSync(LOGO_DIR)) mkdirSync(LOGO_DIR, { recursive: true });
  const data = JSON.parse(readFileSync(join(__dirname, 'data.json'), 'utf8'));
  const items = data.items;
  const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {};
  cache.logosByDomain = cache.logosByDomain || {};
  cache.textByOrg = cache.textByOrg || {};

  // ---------- LOGOS (per domain) ----------
  const domainMap = new Map(); // host -> sample link
  for (const it of items) {
    const host = hostOf(it.link);
    if (!host || isAggregator(host)) continue;
    if (!domainMap.has(host)) domainMap.set(host, it.link);
  }
  const domains = [...domainMap.entries()];
  const todo = domains.filter(([h]) => cache.logosByDomain[h] === undefined);
  console.log(`Logos: ${domains.length} unique non-aggregator domains; ${todo.length} to fetch, ${domains.length - todo.length} cached.`);

  let kept = 0;
  await pool(todo, 8, async ([host, link]) => {
    const res = await resolveLogo(host, link);
    cache.logosByDomain[host] = res.logo || null;
    if (res.logo) { kept++; process.stdout.write('.'); }
    else process.stdout.write('x');
  });
  if (todo.length) process.stdout.write('\n');
  // verify previously-cached logo files still exist (so re-runs self-heal)
  for (const [h, v] of Object.entries(cache.logosByDomain)) {
    if (v && !existsSync(join(__dirname, v))) cache.logosByDomain[h] = undefined;
  }
  const realLogoDomains = Object.values(cache.logosByDomain).filter(Boolean).length;
  console.log(`Logos: ${realLogoDomains}/${domains.length} domains have a real logo (rest → monogram). New this run: ${kept}.`);

  // ---------- CLAUDE TEXT (per unique org) ----------
  let textRan = false;
  if (ONLY_LOGOS) {
    console.log('Text: skipped (--logos).');
  } else if (!CLAUDE_KEY) {
    console.log('Text: no ANTHROPIC_API_KEY/CLAUDE_API_KEY set — skipping the "about/known for" step (logos still done).');
  } else {
    textRan = true;
    // representative item per org
    const orgRep = new Map();
    for (const it of items) {
      if (!it.org) continue;
      if (!orgRep.has(it.org)) orgRep.set(it.org, { org: it.org, category: it.category || '', location: it.location || '', title: it.title || '' });
    }
    const orgsAll = [...orgRep.values()];
    const orgsTodo = orgsAll.filter((o) => cache.textByOrg[o.org] === undefined);
    console.log(`Text: ${orgsAll.length} unique orgs; ${orgsTodo.length} to enrich via Claude (claude-haiku-4-5), ${orgsAll.length - orgsTodo.length} cached.`);
    const BATCH = 10;
    for (let i = 0; i < orgsTodo.length; i += BATCH) {
      const batch = orgsTodo.slice(i, i + BATCH);
      const res = await claudeBatch(batch);
      batch.forEach((o, k) => {
        const r = res && res[k] ? res[k] : {};
        cache.textByOrg[o.org] = {
          about: (r.about || '').toString().slice(0, 200).trim(),
          knownFor: (r.knownFor || '').toString().slice(0, 140).trim(),
        };
      });
      process.stdout.write(`  ${Math.min(i + BATCH, orgsTodo.length)}/${orgsTodo.length}\r`);
      writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2)); // checkpoint
    }
    if (orgsTodo.length) console.log('');
    const withText = Object.values(cache.textByOrg).filter((t) => t && (t.about || t.knownFor)).length;
    console.log(`Text: ${withText}/${orgsAll.length} orgs have an about/known-for line.`);
  }

  // ---------- assemble enrichment.js (byId) ----------
  const byId = {};
  for (const it of items) {
    const host = hostOf(it.link);
    const logo = host && !isAggregator(host) ? (cache.logosByDomain[host] || null) : null;
    const t = cache.textByOrg[it.org] || {};
    const e = {};
    if (logo) e.logo = logo;
    if (t.about) e.about = t.about;
    if (t.knownFor) e.knownFor = t.knownFor;
    if (Object.keys(e).length) byId[it.id] = e;
  }
  const payload = { byId, generatedAt: new Date().toISOString(), textEnabled: textRan };
  writeFileSync(join(__dirname, 'enrichment.js'),
    `// Generated by enrich.mjs — do not edit by hand.\nwindow.TEACHING_ENRICHMENT = ${JSON.stringify(payload)};\n`);
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  console.log(`Wrote enrichment.js — ${Object.keys(byId).length}/${items.length} items have enrichment (logo and/or text).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
