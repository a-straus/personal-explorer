# /loop build prompt — "Opportunity Explorer"

You are building a polished, **visual** local web app called **Opportunity Explorer** that lets me
(Adam) browse every opportunity my recurring Airtable scans have found **and — most importantly —
log my progress as I apply to them**, without ever clicking into Airtable. Each item has a lot of
rich info (fit notes, pay, deadlines, links); I want to see it at a glance, with a **logo**, a
**description / what it's known for**, and any **deadlines**, and I want to **track my application
status** on a small local database.

You are running **unattended, overnight, in a loop.** Work fully autonomously and keep going,
iteration after iteration, until the Acceptance Checklist (section 5) is 100% green.

> **This is v2 of the prompt.** It supersedes the original (kept as `LOOP-PROMPT.original.md`). The
> big change vs v1: a **small local Node server + SQLite** is now expected (Adam approved it), the app
> shows **logos + descriptions**, the Board is a real **progress log**, and there's an optional
> **Claude Haiku enrichment** step (cheapest model). Build to *this* file.

---

## 0. Operating rules — read these EVERY iteration

- **Never stop to ask me questions.** I am asleep. Make the most reasonable assumption, write a
  one-line note in `DECISIONS.md`, and proceed. A finished, slightly-imperfect app beats a
  half-built one waiting on input.
- This prompt may be **run repeatedly**. On each run:
  1. Read `PROGRESS.md` (and this file) to see what's done and what's next.
  2. Pick the next unchecked item from the Acceptance Checklist.
  3. Implement it.
  4. **Verify it** (`node verify.mjs`, look at the screenshots) — don't assume.
  5. Update `PROGRESS.md`.
  6. `git add -A && git commit -m "..."` (local commit only) **if this is a git repo. If not, you may
     `git init` locally for per-iteration rollback safety (never add a remote, never push), or skip
     git steps silently — but never push.**
- **Be idempotent.** Never duplicate work or break a passing build. If everything is already green,
  run full verification once more; if still green, write `STATUS: ALL DONE` at the top of
  `PROGRESS.md` and make no further changes.
- Prefer **many small, verified steps** over large rewrites.
- If something is genuinely blocked, write the blocker at the top of `PROGRESS.md` and move on to
  another checklist item — do not halt.
- **Keep it simple and visual.** This is a personal tool, not an enterprise app. Favor a calm,
  attractive, scannable UI over feature sprawl. When in doubt, do the simpler thing well.

**Guardrails (safe unattended autonomy):**
- Work **only inside this project folder.** Never modify or delete anything outside it.
- **Never** `git push`, install global packages, or run destructive/system commands. Local dev
  dependencies for testing (e.g. Playwright) are fine.
- The Airtable token lives only in `.env` / an env var. **Never print it, hardcode it, or commit
  it.** `.env` is gitignored. Do not try to discover a token on your own.
- **Read-only with respect to Airtable:** this app and the build NEVER write back to Airtable.
- The app's progress data is **local-only** (SQLite on my machine / localStorage in my browser). It
  never posts my triage anywhere.
- **Network is allowed only at *build time*, from these scripts:** `refresh-data.mjs` (reads
  Airtable) and `enrich.mjs` (fetches public logos/pages, and — only if a Claude key is present —
  calls the Anthropic API to summarize). **The app at view time makes no third-party/CDN requests**
  — its only requests are to its own local server's `/api/*` and same-folder asset files.
- Render only what's in the data — never invent opportunities. Enrichment may add an "about/known
  for" blurb, but it must be clearly derived from the org/notes/its public page, never fabricated
  opportunities.

---

## 1. Architecture — this is SETTLED, build exactly this

The key idea: **do expensive/networked work at build time, keep the running app vanilla and offline,
and store my progress in a real local DB.** Three layers:

1. **Build-time (Node, zero-dependency where possible):**
   - `refresh-data.mjs` *(provided — keep as-is)* pulls the three Airtable tables → `data.js`
     (`window.TEACHING_DATA`) + `data.json`.
   - `enrich.mjs` *(you build)* adds **logos** and an optional **description / "known for"** and
     writes `enrichment.js` (`window.TEACHING_ENRICHMENT`). See §3.
2. **View-time (`index.html` — vanilla HTML/CSS/JS, no framework, no bundler, no CDN):**
   - Inline all CSS/JS. The only files it loads are `data.js`, `enrichment.js`, and same-folder
     logo images. Fast with 185+ records.
3. **Progress store (`server.mjs` — a *small* local Node server + SQLite):**
   - `server.mjs` uses **`node:http`** + **`node:sqlite`** (both built in on this machine — Node
     v26, `DatabaseSync` works, **zero npm install needed**). It serves the static files **and**
     exposes a tiny JSON API for my application progress, backed by a SQLite file `app.db`.
   - `app.db` holds **only my mutable progress** (status, activity log, dates, checklist, star).
     **Never** the opportunity content — that stays in `data.js` and is regenerated from Airtable.
     This separation means a data refresh never clobbers my progress.

**Launch ergonomics:** ship a double-clickable **`start.command`** (macOS) that runs
`node server.mjs` and opens `http://localhost:<PORT>` in the browser. Pick a fixed port (e.g. 4317).
One double-click = app open. Also document `node server.mjs` for terminal users.

**Graceful fallback (required):** if I just double-click `index.html` (no server, `file://`), the app
must still load `data.js`/`enrichment.js` and work — browse/search/filters/deadlines all functional,
and **progress falls back to `localStorage`**. On load, probe the server once
(`fetch('/api/health', {signal: AbortSignal.timeout(500)})`); if it answers, use SQLite; if not, use
localStorage. A single storage-adapter object (`get/set/all/export`) hides which backend is active.
Show a small badge: **"Saving to: this Mac (SQLite)"** vs **"Saving to: this browser only"** so it's
clear where data lives. Both stores key progress by item `id` so it survives a data refresh.

> Suppress the `node:sqlite` ExperimentalWarning in `server.mjs` (e.g. run node with `--no-warnings`
> in `start.command`, or guard warnings) so the console stays clean.

---

## 2. Phase 0 — get the data first

Run `node refresh-data.mjs`.
- With `AIRTABLE_TOKEN` set (a read-only Airtable PAT), it pulls all three tables live from the
  "Teaching Transition" base and writes **`data.js`** (defines `window.TEACHING_DATA`) + `data.json`.
- With no token, it writes a small **SAMPLE** dataset so you can still build and verify the UI.

The data is **already present and real** in this folder (`source: 'airtable'`, 185 items). If
`data.js` exists and is real, you don't need to re-pull. Build the UI against
`window.TEACHING_DATA.items`. **Never hardcode opportunity content into HTML.**

---

## 3. Phase 0.5 — `enrich.mjs` (logos + optional "known for")

Build `enrich.mjs` (zero-dependency, uses Node's built-in `fetch`). It reads `data.json`, produces
per-item enrichment, and writes **`enrichment.js`** (`window.TEACHING_ENRICHMENT = { byId: { <id>:
{ logo, knownFor, about } }, generatedAt }`) plus a JSON cache so it's **idempotent** (skip items
already done). The app merges enrichment over items by `id` at load; **anything missing degrades
gracefully** (monogram avatar + the item's own `notes` as the description).

### Logos (always; no API key needed)
- **Default to a clean generated monogram avatar** (org initials on a deterministic, category-tinted
  tile) rendered **client-side as inline SVG** — so every one of the 185 cards always has an
  attractive mark with zero files. This is the floor.
- **Upgrade to a real logo only when you can get a good one.** For each candidate domain: **fetch the
  page once and parse its `<head>` for `apple-touch-icon`, `rel="icon"`, and `og:image` link tags,
  resolving relative URLs** — do *not* just guess `/apple-touch-icon.png` (a quick probe showed
  several orgs, e.g. Spence/Brooklyn Friends/FIRST, hide their logo at a non-standard path and get
  missed if you only guess). Fetch the largest of those; fall back to a favicon service at 128px.
  **Keep it only if the image's min dimension is ≳64px** — otherwise discard and use the monogram
  (small favicons are ugly 16px globes). *(Probe baseline: guessing only `/apple-touch-icon.png` +
  favicon128 already yields ~56% real logos / 44% clean monograms; head-parsing lifts that further.)* Save kept
  logos to `assets/logos/<domain>.png` and reference by **relative path** (works under `file://` and
  the server). Record `logo: "assets/logos/x.png"` or `logo: null` per item.
- **Do NOT blindly favicon the `link` domain.** ~33/185 items link to **aggregators**
  (eventbrite.com, *.greenhouse.io, *.lever.co, *.myworkdayjobs.com, idealist.org, corsizio.com,
  careers.nais.org, linkedin.com, indeed.com, meetup.com, etc.). Faviconing those stamps the wrong
  brand (an Eventbrite logo on a NYC Resistor event). Maintain an **aggregator blocklist**; for
  blocked links, fall back to the monogram (or a curated org→domain guess if obvious). When unsure,
  the monogram is always the safe, clean choice.
- Dedupe network work by domain (many items share an org/domain). Use short timeouts and modest
  concurrency; never let a slow/missing logo block the build.

### Description / "known for" (optional — only if a Claude key is present)
- The item's existing **`notes`** field (present on all 185, avg ~400 chars) is already a rich "why
  it fits" description — **the app shows this regardless.** Enrichment adds a *separate*, factual
  **"About / known for"** line about the org/opportunity in the world (e.g. "Spence is a top-tier
  NYC independent K–12 school"), which `notes` doesn't give.
- Gate on `process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY`. **If absent, skip this
  entirely** (I explicitly said missing info is fine) — logos still run.
- When present: use model **`claude-haiku-4-5`** via the Anthropic Messages API with **raw `fetch`**
  (zero-dep, consistent with `refresh-data.mjs` — do not add the SDK). Headers: `x-api-key`,
  `anthropic-version: 2023-06-01`, `content-type: application/json`. Optionally fetch the item's
  `link` page (build-time, short timeout, truncate to a few KB of text) and pass org/title/notes +
  that excerpt to Haiku. Ask for a short **structured** result via
  `output_config: { format: { type: "json_schema", schema: … } }` — e.g. `{ about: string (≤160
  chars), knownFor: string (≤100 chars) }`. **Enrich per unique org (≈146), not per item** — many
  items share an org, so resolve once and apply to all of that org's items. Batch several orgs per
  request, and **cache by org** in the JSON cache so re-runs don't re-spend. Never send my Airtable
  token or any secret.
- This step **reads public pages and sends opportunity text to Anthropic** when a key is present —
  that's the intended trade for richer info, and I opted in by providing the key. No key → no calls.

Document in `README.md` how to add `ANTHROPIC_API_KEY=sk-...` to `.env` and re-run `node enrich.mjs`.

---

## 4. What to build (`index.html` + `server.mjs`)

Loads `window.TEACHING_DATA` (+ `window.TEACHING_ENRICHMENT`), with a persistent search/filter bar
across the top, and offers these views:

### A. Browse (default view) — the heart of the app
A clean, **scannable card grid**. Each card surfaces everything so I never open Airtable:
- **Logo** (real or monogram, top-left), **Title** (role / program / event), **Organization**.
- A colored **Category/type** badge and a colored **Priority** badge (priority drives visual weight).
- **Commitment** (if present), **Location**, **Pay/Cost** (if present).
- **Deadline** with a relative countdown that turns **amber when < 14 days** away and **red when
  overdue** — but **phrase events as "happens in 9 days" / "today"**, not "due", because for events
  `deadline` is the *event date*, not an application deadline (see §0/§4 data notes). Most items have
  **no date** — render that as a calm, neutral state, never an error.
- The **description**: show the item's full **`notes`** ("Why it fits") — the most valuable field —
  clamped to a few lines with a "more" toggle. If enrichment provided an **"About / known for"**
  line, show it as a short, visually distinct line above or beside the notes.
- A prominent **"Open posting ↗"** button (`target="_blank" rel="noopener"`), plus **Source**.
- **Inline progress controls** right on the card: a **status** selector and a **★ star** toggle, so
  I can triage without opening anything. Changing them writes through the storage adapter.
- A **header strip** with **live counts** computed from the data (e.g. "100 opportunities · 45
  programs · 40 events — 20 Apply Now · N due in 30 days · M starred · K applied"), a **"last
  refreshed {generatedAt}"** stamp, the **storage badge** (§1), and a link to the Airtable base
  (`TEACHING_DATA.baseUrl`).

> **Triage reality:** 184/185 items are `status: New`, so the real job is deciding + tracking. Make
> Browse **default-sort by Priority** (deadline can't order the 138 undated items), float **starred
> items to the top**, and offer a **"Needs triage"** quick filter (status New). A focused triage
> default makes 185 cards feel calm instead of overwhelming.

### B. Deadlines (compact view / widget — not a big empty page)
Only ~47/185 items have a date (1 overdue, ~7 this week, ~20 within 30 days), mostly events. So make
this a **compact panel**: dated items **soonest first**, grouped **Overdue / This week / Next 30
days / Later**, with undated items as a quiet "No date (N)" tail — don't give empty buckets headline
space. Use "due"/"happens" wording per dataset. It's fine to render this as a filter+widget rather
than a full-bleed third tab.

### C. Board — track my applications (the #1 feature)
This is **progress logging**, not just status columns. **Kanban columns by Status — always render the
full pipeline even when empty**: New → Reviewing → Applied → Interview → Offer → Accepted / Rejected /
Passed. (Do **not** derive columns only from values present: 184/185 items are `New`, so that would
collapse the board to two columns and defeat the whole feature.) Let me **move a card / change status**
and have
it **persist to SQLite** (via the API) — or localStorage when offline — keyed by item `id`, surviving
reloads **and** data refreshes.

Each item also has a **progress record** I can open/edit:
- A **timestamped activity log** (free-text notes I add, e.g. "submitted via Greenhouse 6/15") shown
  newest-first.
- **Key dates**: "Applied on" and "Follow-up by" (the app can also let me set a personal deadline for
  the 138 items that lack one).
- A small **application checklist** (e.g. Resume tailored · Cover letter · Submitted · Followed up) —
  editable, with done/undone toggles.
- **★ Star** and an optional 1–3 **rating**.

Make clear this is **local-only** (badge from §1) and add **"Export my progress"** to **CSV and
JSON** so I can act on it elsewhere.

### Search / filter / sort bar (applies to all views)
- Instant **text search** across title, org, notes, about, location, source.
- Multi-select **filter chips**: Dataset (**Opportunities / Programs / Events** — label the
  `opportunities` dataset "**Opportunities**", *not* "Jobs": it's jobs **plus** tutoring/volunteering/
  maker/classes — only ~24/100 are Teaching Jobs), Category/Type, Priority, Commitment, Status.
  Combined filters AND together.
- A **"hide Passed / Rejected"** toggle (ON by default) — *(there is no "Closed" status in the data;
  hide the terminal statuses that actually exist)* — and a **"Needs triage"** quick filter (status New).
- **Filters adapt to the data:** `commitment` and `source` exist only on Opportunities, and
  `location` is empty for ~45 items — hide or no-op a filter for datasets that lack the field rather
  than showing empty chips.
- **Sort**: **Priority (default)**, Deadline (soonest, dated first), Date Added (newest), Org (A–Z).
  *(Skip a numeric "Pay" sort unless you robustly parse it — `pay` is free text like "$84,016–
  $164,185/yr", "Free", or "".)*
- Show a **live result count**.

### Server API (`server.mjs`)
Minimal `node:http` + `node:sqlite`. Suggested endpoints (keep it small):
- `GET  /api/health` → `{ ok: true }` (used by the app to detect the server).
- `GET  /api/progress` → all progress rows.
- `PUT  /api/progress/:id` → upsert one item's progress (status, star, rating, dates, checklist).
- `POST /api/progress/:id/log` → append an activity-log entry `{ ts, text }`.
- `GET  /api/export.json` / `GET /api/export.csv` → download my progress.
- Serve `index.html`, `data.js`, `enrichment.js`, and `assets/` statically.

Suggested SQLite shape (keep it tiny): `progress(item_id TEXT PRIMARY KEY, status TEXT, starred
INTEGER, rating INTEGER, applied_on TEXT, follow_up_on TEXT, checklist TEXT /* JSON */, updated_at
TEXT)` and `activity(id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT, ts TEXT, text TEXT)`. Use
`INSERT … ON CONFLICT(item_id) DO UPDATE`. Bind to **localhost only**.

### Polish
Modern, calm typography; responsive **360px → 1440px**; fast; accessible (keyboard nav, labels, good
contrast); tasteful empty states; subtle category colors; a **dark-mode-friendly** palette is a plus.
Priority colors on a **hot→cool ramp derived from the values present** (don't hardcode one fixed set —
see §6).

---

## 5. Acceptance checklist (the done-condition — VERIFY each, don't assume)

Data & build:
- [ ] `node refresh-data.mjs` runs clean and `data.js` + `data.json` exist with real data (185 items).
- [ ] `node enrich.mjs` runs clean, writes `enrichment.js`, fetches at least some real logos, and
      **skips the Claude step gracefully when no `ANTHROPIC_API_KEY`/`CLAUDE_API_KEY` is set**
      (and uses it when present). Re-running is idempotent (cached).

App renders (served by the server):
- [ ] `node server.mjs` starts and `http://localhost:<PORT>` renders the Browse grid from `data.js`
      with **zero console errors**, **no third-party/CDN requests** (only `/api/*` + same-folder
      assets).
- [ ] Total cards shown equals `TEACHING_DATA.items.length` (185); per-dataset counts match `counts`
      (100 / 45 / 40).
- [ ] Every card shows a **logo or monogram**, the **description** (full `notes`, expandable), the
      **"About / known for"** line **when enrichment provided one**, and a working external link
      (`target="_blank" rel="noopener"`).
- [ ] All three datasets appear and filter individually; the `opportunities` chip is labeled
      **"Opportunities"** (not "Jobs").

Search / filter / sort:
- [ ] Typing in search filters cards live; clearing restores all.
- [ ] Each filter (dataset, category, priority, commitment, status) narrows correctly; combined
      filters AND together; the count updates.
- [ ] "Hide Passed/Rejected" works and is ON by default; "Needs triage" filter works.
- [ ] The Board renders the **full pipeline columns even when empty** (not just New + Passed).
- [ ] Sort by **Priority (default)**, **Deadline (soonest)**, and **Date Added (newest)** each
      reorder correctly; **starred items float to the top**.

Deadlines:
- [ ] Deadlines view groups by urgency, soonest first; overdue flagged red, <14 days amber; events
      read "happens", applications read "due"; the large "No date" set is calm, not an error.

Progress logging (the point):
- [ ] **SQLite path:** with the server running, changing a card's status/star and adding an
      activity-log entry **persists across reload** (in `app.db`) **and survives re-running
      `refresh-data.mjs`** (matched by `id`). Key dates + checklist persist too.
- [ ] **Fallback path:** opening `index.html` via `file://` (no server) still renders, and progress
      persists to **localStorage**; the storage badge reflects which backend is active.
- [ ] **Export** my progress to CSV **and** JSON works.

Launch, responsive, perf, docs:
- [ ] `start.command` is executable and launches the server + opens the browser (document
      `node server.mjs` too).
- [ ] Responsive with no overflow at **390px** and **1280px**; cards reflow; scrolls smoothly with
      all 185 records.
- [ ] `verify.mjs` exists and prints PASS for every item above; screenshots saved in `verification/`.
- [ ] `README.md` explains how to launch, refresh data, and (optionally) enrich with a Claude key;
      `.gitignore` present; **no secret and no `app.db` is ever committed**.

---

## 6. Data contract

`window.TEACHING_DATA = { generatedAt, source, baseId, baseUrl, counts:{opportunities, programs,
events}, items: [ Item, … ] }` — **real counts are 100 / 45 / 40 = 185.**

Each **Item** (already unified across the three tables by `refresh-data.mjs`):
```
{
  id, dataset: 'opportunities' | 'programs' | 'events',
  title, org, category, commitment?, location, link,
  deadline,        // YYYY-MM-DD or '' — Opp.Deadline / Program.Application Deadline / Event.Date
  pay,             // pay / cost / funding text or ''  (free text — not numeric)
  notes,           // the high-value 'why/fit' text (Fit Notes / Notes / Why Go) — present on all 185
  priority, status, source?, subjectFocus?, format?,
  dateAdded, lastChecked,
  raw              // original Airtable fields, if you need anything else
}
```
Enrichment (merged by id from `window.TEACHING_ENRICHMENT.byId`):
```
{ logo: 'assets/logos/x.png' | null, about?: string, knownFor?: string }
```

Specifics to handle gracefully:
- **Any field can be an empty string** — guard everywhere. **47/185 have a deadline** (11/100 opps,
  9/45 programs, 27/40 events); **~184/185 are `status: New`** (the Board is where they change).
- **Priority vocabulary differs by dataset.** Opportunities & Programs use *Apply Now / Strong /
  Worth a Look / Long Shot* (Opportunities also has *High / Medium*); Events use *Go / Strong /
  Maybe / FYI*. Render whatever value is present and color it on a hot→cool ramp. **Derive
  chips/colors from the values in the data — do not hardcode one fixed set.** (Real spread: ~20
  Apply Now + 8 Go ≈ 28 "top", ~67 Strong, etc.)
- **Status** (Opportunities): New / Reviewing / Applied / Interview / Accepted / Rejected / Passed;
  Programs/Events are mostly "New". The Board renders the **full fixed pipeline** (New → Reviewing →
  Applied → Interview → Offer → Accepted / Rejected / Passed) even when columns are empty.
- **`generatedAt` may be slightly in the future** (a timezone artifact — current snapshot reads ahead
  of "today"). Countdown/relative-date math must not choke on a future `generatedAt`; clamp it to
  "now" if needed.
- **Orphaned progress:** if an item leaves a future refresh, keep its progress row (match by `id`),
  hide it from the views, and include it in exports flagged "item no longer in dataset" — never lose
  my tracking.
- `dataset` labels & filters: **Opportunities / Programs / Events** (Programs have
  `subjectFocus`/`format`; Events use `deadline` as the **event date**).

---

## 7. How to verify yourself (no human in the loop)

Write **`verify.mjs`** that automatically checks the app:
- Prefer **Playwright** (`npm i -D playwright` then `npx playwright install chromium` is allowed).
  Fall back to puppeteer; if neither installs, use `jsdom` to exercise the JS logic plus a strict
  code-review against §5. **If no headless browser can be installed, mark the screenshot/visual
  checklist items BLOCKED in `PROGRESS.md` — never fake a PASS for something you couldn't actually
  render and see.**
- **Start the server** (`node server.mjs` on the chosen port), then drive `http://localhost:<PORT>`
  in a headless browser. Assert: page renders; visible item count equals
  `TEACHING_DATA.items.length`; logos/monograms present; typing in search reduces results; each
  filter narrows; changing sort changes order; **a Board status change + activity-log entry persists
  across a reload via the API**, and a status set by id **survives re-running `refresh-data.mjs`**;
  **no console errors**; no third-party network requests.
- Also smoke-test the **`file://` fallback**: open `index.html` directly and confirm it renders and
  uses localStorage (storage badge says "browser only").
- Capture screenshots at **390px** and **1280px** widths into `verification/`, plus one of the
  Deadlines and Board views (and a card showing a real logo + the "known for" line if enriched).
- Print **PASS/FAIL per checklist item** and write `verification/REPORT.md`.

Run `node verify.mjs` each iteration. Only tick a checklist item once it actually passes. **Look at
the screenshots** before declaring a visual item done.

---

## 8. Files & progress tracking

Keep everything in this folder:
`index.html` · `server.mjs` · `start.command` · `data.js` / `data.json` (generated) ·
`refresh-data.mjs` (provided) · `enrich.mjs` + `enrichment.js` (generated) · `assets/logos/` ·
`app.db` (generated, **gitignored**) · `verify.mjs` · `verification/` · `PROGRESS.md` ·
`DECISIONS.md` · `README.md` · `.gitignore`

`PROGRESS.md` format:
- Line 1: `STATUS: IN PROGRESS` (or `ALL DONE`).
- The Acceptance Checklist with `[x]` / `[ ]`.
- A short log: one line per iteration (what changed, what verified).
- "Current blockers" and "Next step".
Read it first each iteration; update it last; commit (if a git repo).

---

## 9. Suggested iteration order

- **P0** — confirm `data.js` loads (185 items) in a quick Node check. Commit.
- **P1** — `enrich.mjs`: monogram fallback + real-logo fetch (aggregator-aware) → `enrichment.js`;
  Claude step gated on key (skips cleanly with none). Verify some logos landed. Commit.
- **P2** — `server.mjs`: `node:http` + `node:sqlite`, static serving + `/api/health` + progress
  endpoints. Commit.
- **P3** — `index.html` scaffold: storage adapter (SQLite-or-localStorage), Browse grid + header
  counts + logos + description from `data.js`/`enrichment.js`. Commit.
- **P4** — search + filter chips + sort + live count (priority-default, starred-first, "Needs
  triage"). Commit.
- **P5** — card polish: badges, deadline coloring/countdown (event vs due wording), "more" toggle,
  "about/known for" line, inline status + star, external links. Commit.
- **P6** — Deadlines compact view. Commit.
- **P7** — Board: status columns + per-item activity log + key dates + checklist + rating; persist via
  API (localStorage fallback); CSV/JSON export. Commit.
- **P8** — `start.command`; responsive + accessibility + empty states + performance pass. Commit.
- **P9** — `verify.mjs`, capture screenshots, fix every failing checklist item. Commit.
- **P10** — finalize `README.md` + `.gitignore`; full verification → `STATUS: ALL DONE`.

When the whole checklist passes, you're done. Leave the app launchable by double-clicking
`start.command` (and still openable read-only by double-clicking `index.html`).
