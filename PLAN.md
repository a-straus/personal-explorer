# PLAN.md — Opportunity Explorer: state, decisions, next steps

_Handoff document written 2026-07-07. Audience: an engineer picking this up cold.
Read this first, then FEATURES.md (product roadmap) and MIGRATION.md (shelved
Airtable→D1 cutover spec)._

---

## 1. What this is

A personal triage app for teaching/tutoring opportunities. Scheduled Claude runs
scan the web and write findings to an Airtable base; this repo turns that into a
fast, filterable, semantically-searchable static app with local personal tracking.

```
scheduled Claude runs ──▶ Airtable base app6mRGGi2xLKqR2i (3 tables)
                              │
                     refresh-data.mjs (on demand)
                              ▼
        data.js / data.json ──▶ embed.mjs ──▶ vectors.bin + vectors-meta.json
                              └▶ classify.mjs ──▶ facets.js / facets.json
                              ▼
   index.html (single-file app) ── deployed to Cloudflare Pages (git push → build)
                              │
             local only: server.mjs (localhost:4317)
               ├─ SQLite app.db: status/stars/notes/tags/facet-overrides/log
               └─ /api/semantic: query embedding + cosine search
```

**Datasets:** opportunities (312) / programs (135) / events (99) = 546 items as of
2026-07-07.

---

## 2. Decisions already made (owner-level — do not relitigate)

| Decision | Detail | Where recorded |
|---|---|---|
| Target platform is Cloudflare | Workers + D1 + R2 when migration happens; Pages for the static app today | FEATURES.md |
| Local-first ordering | Build triage/search features against `server.mjs` + `app.db` **before** the Cloudflare migration (reverses FEATURES.md phase order) | owner decision 2026-07-06 |
| Facets = commute + time commitment only | Pay tier and subject/audience facets were offered and declined | owner decision 2026-07-06 |
| Classification is fully automatic | Claude assigns facets with no confirm-by-tap step; manual overrides win over auto | owner decision 2026-07-06 |
| Embeddings are local, no API | @huggingface/transformers at build time, no Voyage/API keys | owner decision 2026-07-06 |
| API budget unconstrained at this scale | ~550 items; Claude + embedding costs are pennies | FEATURES.md |
| Airtable migration is **shelved** | Fully planned in MIGRATION.md; do not start without owner go-ahead | owner decision 2026-07-07 |
| Auth for the future hosted version | Cloudflare Access, allow only straus.claw@gmail.com; ingest via separate bearer token | FEATURES.md / MIGRATION.md |
| Home base for commute classification | Greenpoint, Brooklyn 11222 — Greenpoint Ave G station (hardcoded in classify.mjs) | classify.mjs |

## 3. Implementation decisions (engineer-level — revisit freely, but know why)

| Decision | Rationale |
|---|---|
| Embedding model: `Xenova/bge-small-en-v1.5`, q8, 384-dim | Small (~34MB), good quality at this scale, runs locally via transformers.js. Queries need the BGE prefix (`vectors-meta.json.queryPrefix`); passages don't. |
| Vector storage: raw `Float32Array` in `vectors.bin`, row-major, L2-normalized, + `vectors-meta.json` (ids/hashes/dim/count) | Deploys as a static asset; cosine = dot product since normalized. 546×384 floats ≈ 820KB. |
| Brute-force cosine, no vector DB | <10ms for 550 items. Vectorize/HNSW is overkill below ~50k items. |
| Hybrid search: keyword instant, semantic merged on 350ms debounce | Keyword stays zero-latency; semantic results OR-in when they arrive. Constants in index.html: `SEM_MIN=0.45` (cosine floor — below is noise for bge-small), `KW_BOOST=0.25` (relevance bonus for literal matches). Tune these two if results feel off. |
| Query embedding server-side (`/api/semantic` in server.mjs) | Avoids a 34MB model download in the browser. Consequence: semantic **text search** is localhost-only until a Worker provides the endpoint (see §6). |
| "More like this" is fully client-side | Item↔item similarity needs no query embedding — browser fetches `vectors.bin` (820KB, lazy, once) and does the math. Works on the static deploy. |
| Facet overrides live in the progress store (`facet_commute` / `facet_effort` columns), empty string = "defer to auto" | Survives data refreshes (keyed by item id) and ports 1:1 to D1. Frontend precedence in `facetOf()`: override ‖ auto ‖ ''. |
| Auto facets ship as `facets.js` (`window.TEACHING_FACETS`) | Same pattern as `data.js`/`enrichment.js`; static, no server needed. |
| Tags = JSON array in the progress row; filter uses OR semantics | Simplest thing that ports to D1. Rename/merge tooling deferred (F-B3 in FEATURES.md). |
| classify.mjs: `claude-opus-4-8`, adaptive thinking, structured output (`output_config.format` json_schema), batches of 12, pool of 3, checkpointed cache | Accuracy matters (NYC transit judgment); idempotent by content hash so re-runs only touch new/changed items. Cache = `.classify-cache.json` (gitignored). |
| classify/embed/refresh are **manual** scripts, not hooks | The refresh loop is: `node refresh-data.mjs && node embed.mjs && node classify.mjs`, then commit + push. Automate later if it becomes a chore. |
| Playwright for E2E verification (`verify-ui.mjs`) | The Chrome-extension tooling wasn't available; Playwright was already a devDependency. |

## 4. What shipped (2026-07-07, commits f1f6afc / ff7ef69 / cd02bbb)

- **Hybrid semantic search** — keyword + vector, relevance-ranked, "✨ semantic
  match" indicator. User notes and tags are included in the keyword haystack.
- **Auto facets** — commute (Walkable / Short transit / Long haul / Too far /
  Remote) + time commitment (<2 / 2–5 / 5–15 / 15+ hrs/wk / Full-time) on every
  item; pills on cards (dashed = auto), filter groups, tap-to-override chips in the
  drawer (tap your override again to revert to auto). "Too far" cards de-emphasized.
- **Tags** — freeform, autocomplete against existing tags, card pills, filter group.
- **"More like this"** — top-8 similar items in the drawer, click to navigate.
- **Data refresh** — 546 items; embeddings and facets regenerated
  (commute 538/546, effort 542/546 — the rest were genuinely "Unknown").
- **MIGRATION.md** — complete D1 cutover spec, shelved.

Key files: `index.html` (whole app), `server.mjs` (local API + semantic),
`refresh-data.mjs` / `embed.mjs` / `classify.mjs` (pipelines), `enrich.mjs`
(older logo/about enrichment), `verify.mjs` + `verify-ui.mjs` (checks).

## 5. Known bugs & open issues

### 🔴 BUG-1: Cloudflare Pages build failed after push `cd02bbb` (2026-07-07)

Owner received a failed-build email right after the push. Log text not yet
captured. What we know from the repo:

- Previous successful deploys built with a `package.json` containing **only
  playwright**. This push added **`@huggingface/transformers`** to devDependencies.
- **`package-lock.json` has never been committed** (gitignored). If the Pages build
  command runs `npm ci`, it hard-fails without a lockfile.

Hypotheses, ranked, with fixes:

1. **`npm ci` with no lockfile** → fix: commit `package-lock.json`
   (**applied 2026-07-07** — un-ignored and pushed; if the next build goes green,
   this was it).
2. **`@huggingface/transformers` install fails in the Pages build image** — its
   native deps (`sharp`, `onnxruntime-node`) download binaries at install time and
   are classic CI breakers → fix options, in order of preference:
   a. Pages dashboard → Settings → Builds: framework preset **None**, build command
      **empty** — this site is pure static files and needs no npm at all;
   b. or move dev tooling into `tools/package.json` (and move the `.mjs` scripts
      with it, since ESM resolution walks up, not down).
3. **Node engine mismatch** (Pages default Node vs transformers' requirement) →
   fix: add a `.node-version` file (e.g. `22`) at repo root.

**Next diagnostic step: read the actual error** — Cloudflare dashboard → Workers &
Pages → the project → failed deployment → build log (or paste the email text).
Don't apply fix 2b without confirming 2 is the cause.

### 🟡 NOT-A-BUG: local server exited with code 143

During the 2026-07-07 session the dev server (`node server.mjs`) was started as an
agent-managed background task and later showed "failed with exit code 143".
**143 = 128 + SIGTERM**: the process was externally terminated when the session's
background tasks were cleaned up — not a crash. The server ran the entire
verification suite without error. Unrelated to the Cloudflare failure (that's a
build, this was a local process). Restart anytime with `./start.command` or
`node server.mjs`.

### 🟡 Known limitations (by design, until the D1 migration)

- Semantic **text search** doesn't work on the Cloudflare deploy (no query-embedding
  endpoint there); search silently stays keyword-only. "More like this" *does* work.
- Tags / notes / overrides on the deployed site save to localStorage (per-browser),
  not cross-device.
- Near-duplicate items can appear if the scheduled runs re-report with reworded
  titles (planned fix: F-C4 vector dedup queue).
- 8 items have no commute facet, 4 no effort facet (model said Unknown) — chips just
  don't render for them; harmless.
- No items classified "Walkable", so that filter chip never appears (chips render
  only for values present in data). Correct behavior, looks surprising.

## 6. Next steps, in order

1. **Fix the Pages build (BUG-1).** Lockfile pushed; watch the next build, then work
   the hypothesis list above. Everything else is blocked on deploys working.
2. **Semantic search on Cloudflare — small Worker (~60 lines, owner already leaning
   yes).** `GET /api/semantic?q=` → Workers AI `@cf/baai/bge-small-en-v1.5` embeds
   the query (keep `queryPrefix`!) → cosine over `vectors.bin` (fetch from the
   deployed site or bundle as asset, cache the Float32Array in module scope) →
   `{results:[{id,score}]}`. Frontend: when not on localhost, point the fetch in
   `scheduleSemantic()` (index.html) at the Worker URL and set `Store.semantic=true`.
   Needs owner to run `wrangler login` + `wrangler deploy`. This Worker is the seed
   of the MIGRATION.md Worker — don't build it throwaway.
3. **The D1 migration — SHELVED.** Fully specced in MIGRATION.md. Wait for owner
   go-ahead. It unlocks phone tracking + cross-device sync and retires Airtable.
4. **Feature roadmap after that** — FEATURES.md Phase 2 is the highest daily-use
   value and is mostly UI + progress-store work that ports to D1: snooze/"revisit
   when" (F-B1), personal milestones (F-B2), tag management (rename/merge, F-B3),
   saved views (F-B5). Then Phase 3 leftovers: near-duplicate queue (F-C4). Then
   Phase 4: deadline hygiene, "since your last visit", mobile triage mode.

## 7. How to verify changes

```sh
node server.mjs                 # http://localhost:4317
node verify-ui.mjs              # Playwright E2E: boot, facets, filters, semantic,
                                # drawer overrides, tags, more-like-this (15 checks)
node verify.mjs                 # older data-integrity checks
```

The refresh loop (idempotent, run after the scheduled runs have added items):

```sh
node refresh-data.mjs && node embed.mjs && node classify.mjs
# review, then: git add -A && git commit && git push   (push triggers the deploy)
```

`.env` (gitignored) must contain `AIRTABLE_TOKEN` (read-only PAT) and
`ANTHROPIC_API_KEY`.

## 8. Gotchas for the next engineer

- `matches()` in index.html must never be passed to `Array.filter` directly — its
  second param `ignoreTracking` collides with filter's index argument (comment in
  code).
- `vectors-meta.json.hashes` is how `embed.mjs` reuses rows — don't reorder or
  reformat `passageText()` casually; it invalidates every embedding.
- Same for `itemHash()` in classify.mjs vs its cache.
- The git remote moved: update it with
  `git remote set-url origin git@github.com:a-straus/personal-explorer.git`.
- Git identity on this Mac is auto-derived (`strausbot@Adams-Mac-mini.localdomain`);
  set `git config --global user.name/email` properly.
- `data.js` is ~1.4MB of JS parsed at boot — acceptable now; switch to fetching
  `data.json` (or `/api/items` post-migration) if boot feels slow.
