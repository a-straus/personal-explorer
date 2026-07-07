# Migration plan: scheduled runs Airtable → Cloudflare D1

**Status: PLANNED — not started.** Shelved by owner decision on 2026-07-07; nothing in
this document has been built. When picked up, work top-to-bottom. Implements Phase 1
of FEATURES.md (F-A1 … F-A6), updated for the local-first features that shipped
July 2026 (facets, tags, hybrid semantic search, notes — all against `server.mjs` +
`app.db`).

---

## 1. Current state (as of 2026-07-07)

### Write path
Scheduled Claude runs scan for teaching/tutoring opportunities and write records to
Airtable base **`app6mRGGi2xLKqR2i`**, three tables:

| Dataset | Table id | ~Items | Key fields |
|---|---|---|---|
| opportunities | `tblj9n2DaM1h4uihe` | 312 | Role, Organization, Category, Commitment, Location, Link, Deadline, Pay, Fit Notes, Priority, Status, Date Added, Source, Last Checked |
| programs | `tblRRDve12JKAo18A` | 135 | Program, Institution, Type, Subject Focus, Format, Cost / Funding, Application Deadline, Link, Notes, Priority, Status, Date Added, Last Checked |
| events | `tbl22InnKlOX7I9Ek` | 99 | Event / Program, Organizer, Type, Date, Location, Link, Cost, Why Go, Priority, Status, Date Added, Last Checked |

The full field-name → normalized-key mapping lives in `refresh-data.mjs` (`TABLES`
const, with field IDs in comments). **Reuse it verbatim in the Worker.**

### Read path
- `refresh-data.mjs` snapshots Airtable → `data.js` / `data.json` on demand.
- Static app (`index.html`) deploys to Cloudflare; reads baked `data.js`.
- Personal tracking lives in local SQLite `app.db` behind `server.mjs`
  (localhost:4317): status, starred, rating, applied/follow-up dates, checklist,
  note, hidden, **tags** (JSON array), **facet_commute / facet_effort** (manual
  overrides), activity log.

### Local pipelines that must survive the migration
- `embed.mjs` — bge-small-en-v1.5 (q8) vectors → `vectors.bin` (`Float32Array`,
  row-major, L2-normalized) + `vectors-meta.json` (`{model, dim:384, count, ids,
  hashes, queryPrefix}`). Idempotent by content hash.
- `classify.mjs` — Claude (opus) auto-classifies commute + effort per item →
  `facets.js` / `facets.json`; idempotent via `.classify-cache.json`.
- `server.mjs /api/semantic?q=` — embeds the query locally, brute-force cosine over
  `vectors.bin`.
- Frontend behaviors that depend on hosting: hybrid keyword+semantic search
  (needs a query-embedding endpoint), "More like this" (client-side, only needs the
  static `vectors.bin`), tags/facet overrides/notes (need a progress API for
  cross-device sync; fall back to localStorage per-browser otherwise).

### Pain this migration solves
1. Tracking is Mac-only — no phone triage.
2. Airtable is a rented system of record with a fragile snapshot step.
3. Semantic search only works when the local server is running.

---

## 2. Target architecture

```
scheduled Claude runs ──POST /api/ingest (bearer token)──▶ ┌─────────────────────┐
                                                           │ Cloudflare Worker    │
phone / laptop ──Cloudflare Access (Google login)────────▶ │  - static app assets │
                                                           │  - JSON API          │
                                                           │  - Workers AI (query │
                                                           │    embeddings)       │
                                                           └──────┬───────────────┘
                                                                  │
                                            ┌─────────┐   ┌──────▼──────┐   ┌────────┐
                                            │   R2    │◀──│     D1      │   │ assets │
                                            │ backups │   │ (system of  │   │vectors.bin
                                            │ nightly │   │  record)    │   │facets…│
                                            └─────────┘   └─────────────┘   └────────┘
```

Decisions already made (FEATURES.md + owner):
- Platform: Cloudflare Workers + D1 + R2 (free tiers cover this scale: ~550 items,
  one user). Vectorize is **not** needed at this scale — brute-force cosine over a
  static `vectors.bin` in the Worker is simpler and fast (<10ms for 550×384).
- Auth: Cloudflare Access (Zero Trust free tier), allow only straus.claw@gmail.com.
- Ingest auth: separate bearer token stored as a Worker secret.
- Airtable stays alive read-only through a dual-write transition, then archived.

---

## 3. Step-by-step plan

### Step 1 — D1 schema (F-A1)

```sh
wrangler d1 create opportunity-explorer     # note database_id into wrangler.toml
mkdir migrations
wrangler d1 migrations apply opportunity-explorer --local   # dev
wrangler d1 migrations apply opportunity-explorer --remote  # prod
```

`migrations/0001_init.sql`:

```sql
CREATE TABLE items (
  id            TEXT PRIMARY KEY,          -- keep Airtable rec… ids on import;
                                           -- new rows get nanoid-style ids
  dataset       TEXT NOT NULL,             -- opportunities | programs | events
  natural_key   TEXT NOT NULL,             -- see §3 Step 2 — upsert identity
  title TEXT, org TEXT, category TEXT, commitment TEXT, location TEXT,
  link TEXT, deadline TEXT, pay TEXT, notes TEXT, priority TEXT,
  source TEXT, source_status TEXT,         -- status as reported by the runs
  subject_focus TEXT, format TEXT,         -- programs-only
  date_added TEXT, last_checked TEXT,
  raw           TEXT,                      -- JSON: anything unmapped
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_items_nk ON items(natural_key);
CREATE INDEX idx_items_dataset ON items(dataset);

CREATE TABLE progress (                    -- straight port of app.db progress
  item_id TEXT PRIMARY KEY,
  status TEXT, starred INTEGER DEFAULT 0, rating INTEGER DEFAULT 0,
  applied_on TEXT, follow_up_on TEXT, checklist TEXT, note TEXT,
  hidden INTEGER DEFAULT 0, tags TEXT,
  facet_commute TEXT, facet_effort TEXT, updated_at TEXT
);

CREATE TABLE facets_auto (                 -- classify.mjs output
  item_id TEXT PRIMARY KEY, commute TEXT, effort TEXT,
  content_hash TEXT, model TEXT, updated_at TEXT
);

CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT, ts TEXT, text TEXT
);
CREATE INDEX idx_activity_item ON activity(item_id);

CREATE TABLE sync_log (                    -- audit: one row per ingest run
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT,                             -- e.g. "scheduled-run", "import"
  run_at TEXT DEFAULT (datetime('now')),
  received INTEGER, added INTEGER, updated INTEGER, unchanged INTEGER,
  notes TEXT
);
```

Schema notes:
- `progress` columns intentionally match `app.db` exactly (see `server.mjs`) so the
  import is a row copy and `rowToProgress()` ports unchanged.
- Facet **overrides** stay in `progress` (empty string = "defer to auto"), auto
  values live in `facets_auto` — same precedence rule the frontend already
  implements in `facetOf()`.
- Acceptance (F-A1): `wrangler d1 migrations apply` works from a clean database.

### Step 2 — Worker: app hosting + API + ingest (F-A2, F-A3)

Project layout: new `worker/` directory (or repo root `wrangler.toml` +
`worker.mjs`), static assets bound via `[assets]` so `index.html`, `vectors.bin`,
`vectors-meta.json`, `facets.js`, `enrichment.js`, `assets/` deploy with it.

`wrangler.toml` sketch:

```toml
name = "opportunity-explorer"
main = "worker.mjs"
compatibility_date = "2026-07-01"

[assets]
directory = "./public"          # index.html, vectors.bin, facets.js, …
binding = "ASSETS"

[[d1_databases]]
binding = "DB"
database_name = "opportunity-explorer"
database_id = "<from wrangler d1 create>"

[ai]
binding = "AI"                  # Workers AI for query embeddings

[[r2_buckets]]
binding = "BACKUPS"
bucket_name = "opportunity-explorer-backups"

[triggers]
crons = ["0 7 * * *"]           # nightly backup (07:00 UTC ≈ 3am ET)
```

Secrets: `wrangler secret put INGEST_TOKEN` (long random string; also given to the
scheduled runs).

**Endpoints** (mirror today's local API so `index.html` needs minimal change):

| Route | Notes |
|---|---|
| `GET /api/health` | `{ok, semantic:true, backend:"d1"}` |
| `GET /api/items` | All items joined with `facets_auto`; replaces baked `data.js` |
| `GET /api/items?status=active` | For the runs to read back what's hidden/archived (F-D4) |
| `GET /api/progress` / `PUT /api/progress/:id` / `POST /api/progress/:id/log` | Port of `server.mjs` handlers, SQL unchanged |
| `GET /api/export.json` / `.csv` | Port |
| `GET /api/semantic?q=` | Embed query via `env.AI.run('@cf/baai/bge-small-en-v1.5', {text:[queryPrefix+q]})`, cosine over `vectors.bin` loaded from ASSETS (cache the Float32Array in module scope) |
| `POST /api/ingest` | **The new write path** — details below |

**`POST /api/ingest` contract:**

- Auth: `Authorization: Bearer <INGEST_TOKEN>`; 401 otherwise. This route is
  excluded from Cloudflare Access (or uses an Access service token).
- Request body — the shape the runs already produce; Airtable field names are fine:

```json
{
  "source": "scheduled-run-opportunities",
  "dataset": "opportunities",
  "records": [
    { "Role": "Robotics Coach", "Organization": "…", "Link": "https://…", "…": "…" }
  ]
}
```

- Behavior:
  1. Normalize each record with the `TABLES` field map copied from
     `refresh-data.mjs`.
  2. Compute `natural_key = dataset + '|' + norm(org) + '|' + norm(title) + '|' + normLink(link)`
     where `norm` = lowercase, trim, collapse whitespace; `normLink` strips
     `utm_*`/`fbclid` params, hash, and trailing slash. Link may be empty —
     org+title still identifies.
  3. Upsert by `natural_key`: new key → INSERT (fresh id); existing → UPDATE the
     source-owned columns only (never touches `progress`). Bump `updated_at` /
     `last_checked`; count added / updated / unchanged (unchanged = identical
     normalized payload).
  4. Write one `sync_log` row; respond `{added, updated, unchanged, received}`.
- Idempotency acceptance: re-POSTing the same batch returns
  `unchanged == received` and changes no row.

**Frontend switch:** `Store.init()` already probes `/api/health`; on the Worker it
will find it. Change the boot path to fetch `/api/items` instead of reading
`window.TEACHING_DATA`, keeping `data.js` as an optional cached snapshot for fast
first paint. Facet auto-values arrive inline on items (from `facets_auto`), so
`facets.js` becomes redundant once hosted — keep loading it as a fallback during
transition.

### Step 3 — Update the scheduled runs (dual-write)

Edit the run prompts/scripts (`LOOP-PROMPT.md` and any per-dataset variants):

1. Keep the existing Airtable write exactly as-is.
2. After the Airtable write, POST the same batch to
   `https://<worker-domain>/api/ingest` with the bearer token.
3. Require the run to report both outcomes; **a failed ingest POST must be loud**
   (Airtable still has the data, so nothing is lost — but we want to see failures
   in the run logs, and `sync_log` gives the server-side view).

Dual-write persists until the Step 6 checklist passes (target ≥ 14 days).

### Step 4 — One-time import (F-A4)

Script `import-to-d1.mjs`, safe to re-run:

1. **Items:** pull all Airtable records (reuse `fetchTable()` from
   `refresh-data.mjs`), normalize, INSERT into `items` **preserving the `rec…` ids**
   — all existing progress rows, tags, and facet overrides key off those ids.
   Compute `natural_key` for every row.
2. **Progress + activity:** export local `app.db`
   (`sqlite3 app.db ".mode insert progress" "select * from progress"` and same for
   `activity`) and apply to D1 via `wrangler d1 execute --file`.
3. **Auto facets:** load `.classify-cache.json` → `facets_auto` rows.
4. **Vectors/facets assets:** copy current `vectors.bin`, `vectors-meta.json`,
   `facets.js` into the Worker's assets dir.
5. **Verification (must pass before Step 6 starts counting):**
   - D1 `items` count per dataset == Airtable record count per table.
   - D1 `progress` row count == `app.db` row count; ditto `activity`.
   - Spot-check 5 tracked items in the hosted app: status, stars, note text,
     tags, facet overrides, log entries all present.
   - Semantic search returns the same top-5 for "paid weekend robotics tutoring"
     as the local server does.

### Step 5 — Auth + backups (F-A5, F-A6)

**Cloudflare Access** (Zero Trust, free):
- Application over the Worker's domain; policy: allow email
  `straus.claw@gmail.com` (Google IdP or email OTP).
- Bypass (or service-token policy) for the exact path `/api/ingest`.
- Acceptance: incognito visitor hits the Access wall; owner logs in once per
  device; a curl with only the bearer token can ingest headlessly.

**Backups (nightly cron in the Worker):**
- Dump `items`, `progress`, `activity`, `facets_auto`, `sync_log` as one JSON
  object → `BACKUPS` R2 bucket, key `backup-YYYY-MM-DD.json`; delete objects older
  than 30 days.
- Before cutover, upload two one-off artifacts to R2: a final `app.db` file copy
  and a full Airtable CSV export per table.
- Document restore: `node restore-from-backup.mjs backup-….json` (generates SQL,
  applies via `wrangler d1 execute`). Do one restore drill against a scratch D1
  database.

### Step 6 — Cutover checklist, then retire Airtable

All boxes must hold before removing Airtable writes:

- [ ] 14 consecutive days of clean ingest runs (`sync_log` shows every scheduled
      run, zero failures in run logs).
- [ ] Daily count parity: D1 items == Airtable records, per dataset.
- [ ] Idempotency: re-POST of a captured batch → `unchanged == received`.
- [ ] Update-in-place: an item whose source data changed (e.g. status → Closed)
      updates without touching its progress/tags/overrides.
- [ ] App fully functional from the Workers URL on desktop **and phone**: browse,
      all filter groups (commute/effort/tags included), hybrid semantic search,
      "more like this", notes/tags/facet overrides syncing across devices, board
      drag-and-drop, exports.
- [ ] Nightly backups landing in R2; restore drill completed.
- [ ] `data.js` no longer required at runtime.

Then:
1. Remove the Airtable write from the run prompts (single-write to `/api/ingest`).
2. Mark the Airtable base read-only. Wait two quiet weeks.
3. Archive the base. Keep `refresh-data.mjs` in the repo as a historical importer.

---

## 4. Component fate table

| Piece | Fate |
|---|---|
| Scheduled Claude runs | Same scan logic; write target becomes `/api/ingest` (dual-write during transition) |
| Airtable base | Read-only after cutover → archived |
| `refresh-data.mjs` | Fallback importer during transition; archived after |
| `server.mjs` + `app.db` | Replaced by Worker + D1 (schema/handlers are a straight port); keep for local dev if desired |
| `embed.mjs` | Keep, unchanged — run after ingests to refresh `vectors.bin`, then `wrangler deploy` the asset. Later option: move embedding into the Worker (Workers AI) triggered by ingest |
| `classify.mjs` | Keep — after new items land, run it and PUT results to a small `POST /api/facets` admin endpoint (bearer-token) instead of writing `facets.js` |
| `index.html` | Same app; boot from `GET /api/items`; `facets.js` becomes fallback-only |
| `vectors.bin` / `vectors-meta.json` | Deploy as Worker static assets (already how the frontend consumes them) |

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Natural-key collisions (same org+title, different postings) | Link participates in the key; audit `sync_log` `updated` counts during dual-write; add posting-date to the key only if real collisions appear |
| Duplicate items because runs re-report with reworded titles | Known limitation; F-C4 (vector near-duplicate queue) is the planned fix, post-migration |
| Workers AI bge-small embeddings differ slightly from local q8 vectors | Acceptable for query-vs-corpus matching; if quality drifts, re-embed the corpus once with Workers AI and regenerate `vectors.bin` (format unchanged) |
| Ingest token leaks | Token only in run configs + Worker secret; rotate with `wrangler secret put`; Access still guards every other route |
| D1 outage during a scheduled run | Dual-write covers transition; post-cutover, runs retry the POST once, else fail loudly — next run re-reports (idempotent upsert makes this safe) |
| Losing local tracking data during import | `app.db` copied to R2 before anything; import is additive and re-runnable |

## 6. Effort & sequencing

| Step | Effort |
|---|---|
| 1. D1 schema + migrations | ~2h |
| 2. Worker (assets + API port + ingest + semantic) | ~1 day |
| 3. Run prompt updates + first observed dual-write | ~1h + 1 run cycle |
| 4. Import script + verification | ~half day |
| 5. Access + R2 backups + restore drill | ~2h |
| 6. Cutover | calendar time (~2–4 weeks), near-zero effort |

Costs: Cloudflare free tiers cover everything at this scale; Workers AI embedding
calls are fractions of a cent; `classify.mjs` continues to cost pennies per batch of
new items.
