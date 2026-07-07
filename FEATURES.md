# Opportunity Explorer — Feature Roadmap (v2)

_Product spec for evolving Opportunity Explorer from an Airtable-fed static app into a
self-hosted Cloudflare application with real triage tooling. Written 2026-07-01._

## Context & goals

**Today:** Scheduled Claude runs (on a server the owner controls) scan for teaching/tutoring
opportunities and write to Airtable. `refresh-data.mjs` snapshots Airtable into `data.js`;
a static app (`index.html`) is deployed to Cloudflare; personal tracking (status, stars,
notes, checklist, activity log) lives in a **local** SQLite `app.db` behind `server.mjs`,
so tracking only works on the Mac.

**Goals:**
1. Own the data — replace Airtable as system of record with a database we host (Cloudflare D1).
2. Track from anywhere — one shared state across Mac and phone, behind simple auth.
3. Better triage — snooze/"revisit when", custom tags and structured facets, saved views.
4. Better discovery — semantic search and "more like this" via embeddings.

**Constraints & decisions already made:**
- The scheduled Claude runs **can be modified** to write to a new destination.
- Target platform: **Cloudflare** (Workers + D1 + Vectorize + R2), since the app already deploys there.
- API budget: **unconstrained** for this scale (~500 items) — Claude + embeddings usage is fine.
- Auto-classification of facets was considered and deferred (see F-B6, stretch).

**Datasets:** opportunities (jobs/tutoring), programs (certification/master's), events — currently
283 / 112 / 78 items. All features apply across all three unless noted.

---

## Phase 1 — Platform: own the data (foundation, everything else builds on this)

### F-A1: D1 schema — items become first-class, not a snapshot
Create a Cloudflare D1 database that is the system of record. Tables:
- `items` — one row per opportunity/program/event. Columns for the current normalized fields
  (`id`, `dataset`, `title`, `org`, `category`, `commitment`, `location`, `link`, `deadline`,
  `pay`, `notes`, `priority`, `source_status`, `created_at`, `updated_at`, `last_checked`,
  `raw` JSON for anything unmapped) plus new columns introduced by Phase 2
  (`snooze_until`, `snooze_condition`, facets).
- `progress` — port of the existing local table (status, starred, rating, applied_on,
  follow_up_on, checklist JSON, note, hidden, updated_at), keyed by `item_id`.
- `activity` — port of the existing activity log.
- `tags`, `item_tags` — Phase 2.
- `sync_log` — one row per ingest run (source, counts added/updated/closed, timestamp) for auditability.

**Acceptance:** schema created via migration files checked into the repo (`migrations/`);
`wrangler d1 migrations apply` works from a clean database.

### F-A2: Worker API + hosted app
Replace `server.mjs` with a Cloudflare Worker that (a) serves the static app and
(b) exposes the JSON API. Endpoints mirror today's (`GET /api/items`, `GET/PUT /api/progress/:id`,
`POST /api/progress/:id/log`, `GET /api/export.{json,csv}`) plus new ones added by later phases.
The frontend switches from reading baked `data.js` to fetching `/api/items` (with a cached
snapshot for fast first paint if needed).

**Acceptance:** app loads and is fully functional (browse, filter, sort, track) from the
Workers URL on both desktop and phone; no local server needed; `data.js` no longer required
at runtime.

### F-A3: Ingest API for the scheduled Claude runs
An authenticated endpoint the scheduled runs write to instead of Airtable:
- `POST /api/ingest` — accepts a batch of items in the shape the runs already produce
  (the Airtable field names are fine; the Worker normalizes). Upserts by a stable natural key
  (normalized `org` + `title` + `link`) so re-scans update rather than duplicate; preserves
  `id` for existing rows so progress/tags/snoozes survive.
- Auth via a bearer token stored as a Worker secret (separate from user-facing auth).
- Update the scheduled runs' prompts/scripts to POST here. During transition they can
  dual-write (Airtable + ingest API) until cutover is verified.

**Acceptance:** a scheduled run posts a batch; new items appear in the app; re-posting the
same batch changes nothing (idempotent); items updated at source (e.g. status → Closed)
update in place without touching user progress.

### F-A4: One-time migration + Airtable retirement plan
A script that (a) imports all current Airtable records into D1 preserving the existing
`rec…` ids (so existing progress keys still match), and (b) imports the local `app.db`
progress + activity into D1. Keep `refresh-data.mjs` working as a fallback importer until
two weeks of clean ingest runs, then archive the Airtable base.

**Acceptance:** post-migration item counts match Airtable; every progress row from `app.db`
is visible in the hosted app; a written checklist for the cutover exists in this file's PR.

### F-A5: Auth — Cloudflare Access in front of the app
Put Cloudflare Access (Zero Trust, free tier) in front of the Worker: allow only the owner's
email (Google login or email OTP). The `/api/ingest` route bypasses Access and uses its own
bearer token (via Access service token or route exclusion). No custom auth code.

**Acceptance:** unauthenticated visitors get the Access login wall; owner logs in once per
device; ingest endpoint works headlessly from the scheduled runs.

### F-A6: Backups & export
Nightly scheduled Worker (cron trigger) dumps D1 (items + progress + activity + tags) as JSON
to an R2 bucket, keeping 30 days. Keep the in-app CSV/JSON export buttons.

**Acceptance:** backup objects appear in R2 on schedule; a documented one-command restore
path exists.

---

## Phase 2 — Triage: snooze, tags, facets (highest daily-use value)

### F-B1: Snooze / "revisit when"
Per item, a **Snooze** action with quick options: _Tomorrow_, _This weekend_, _Next week_,
_Pick a date_, and **condition-based**: _When my resume is ready_, _After current commitment
ends_, plus custom free-text conditions. Behavior:
- Snoozed items disappear from Browse/Board default views; a **Snoozed** tab lists them with
  their wake reason, sorted by wake date/condition.
- Date-based snoozes automatically resurface in a "⏰ Back today" section at the top of Browse
  when due.
- Condition-based snoozes are tied to **milestones** (see F-B2); flipping a milestone to done
  wakes every item snoozed on it, into the same "Back today" section.
- Snoozing logs an activity entry; waking does too.

**Acceptance:** snooze an item to tomorrow → gone from default views, listed under Snoozed;
change system date / wake date passes → item appears in "Back today"; marking the
"resume ready" milestone done wakes all items snoozed on it.

### F-B2: Personal milestones
A tiny settings panel of user-defined milestones with done/not-done state
(seed with: _Resume updated_, _Cover letter template ready_, _Certification exam passed_).
Used as snooze conditions (F-B1) and as filter chips ("show things waiting on my resume").

**Acceptance:** milestones CRUD works; each shows a count of items snoozed on it.

### F-B3: Custom tags
Freeform tags on any item: create inline with autocomplete against existing tags, optional
color. Tag management (rename/merge/delete) in settings. Tags appear as chips on cards,
as a filter facet in the sidebar, and are bulk-applicable from a multi-select mode.

**Acceptance:** tag an item; filter by tag; rename a tag and see it update everywhere;
bulk-apply a tag to 5 selected items at once.

### F-B4: Structured facets — effort, distance, pay tier
Three new per-item fields with quick-set chips on the card (single tap, no dialog):
- **Time commitment estimate:** `<2 hrs/wk` / `2–5` / `5–15` / `15+` / `Full-time`
- **Distance/commute:** `Walkable` / `Short transit` / `Long haul` / `Too far` / `Remote`
- **Pay tier:** `Unpaid` / `Stipend` / `Hourly $` / `Hourly $$` / `Salary`
Each becomes a filter facet and a sort option. `Too far` items get de-emphasized styling
(like hidden-lite) and a one-click "hide all Too far" filter preset.

**Acceptance:** set facets from the card in one tap each; filter by each facet; facets
persist in D1 and survive data refreshes.

### F-B5: Saved views
Save the current combination of filters + sort + search as a named view (e.g. "Paid,
near me, open deadlines"). Views appear as pills next to the existing tabs. Includes
2–3 built-in starter views: _Closing this week_, _Quick wins (<5 hrs/wk, near me)_,
_Waiting on me (snoozed-on-milestone)_.

**Acceptance:** create, apply, rename, delete a view; views sync across devices (stored in D1).

### F-B6 (stretch, deferred): LLM facet auto-suggest
One-time + on-ingest Claude pass that pre-fills F-B4 facets and suggests tags from the item's
notes/description (e.g. infers commute from location, effort from role text), marked as
"suggested" until confirmed with a tap. Deferred by owner decision — build only after F-B4
proves the facet model right; the ingest pipeline (F-A3) should leave a hook for it.

---

## Phase 3 — Discovery: semantic search & similarity

### F-C1: Embeddings pipeline
On ingest (and one backfill run), embed each item's `title + org + category + location +
notes` and store vectors in **Cloudflare Vectorize** (embedding model: Workers AI
`@cf/baai/bge-m3` by default — zero external deps; swappable to Voyage via env var if
quality disappoints). Re-embed when an item's text materially changes (hash the input).

**Acceptance:** backfill embeds all ~500 items; ingest of a new item embeds it within the
same request; embeddings survive re-ingest without duplication.

### F-C2: "More like this"
A button on every card/detail view returning the top ~10 nearest items (excluding closed
and hidden by default, with a toggle to include them). Show a similarity-derived one-line
reason (shared org type / category / location) — plain heuristic text, no LLM call needed.

**Acceptance:** clicking "More like this" on a robotics-tutoring item surfaces the other
robotics/maker items above unrelated ones; responds in <1s.

### F-C3: Semantic search box
Upgrade the existing search input to hybrid search: keyword match (current behavior)
merged with vector search over the query embedding, deduplicated and ranked. A natural
query like "paid weekend robotics tutoring in Brooklyn" returns sensible results even when
those exact words don't appear. Keyword-only remains the instant-as-you-type layer;
semantic results fill in on a short debounce.

**Acceptance:** the query above ranks a relevant paid Brooklyn maker-space role in the top 5;
plain keyword queries behave no worse than today.

### F-C4: Near-duplicate detection on ingest
When an ingested item's vector is very close (cosine > threshold) to an existing item with a
different natural key, flag it as a possible duplicate instead of silently inserting: it
lands in a small "Possible duplicates" review queue with side-by-side compare and
**merge** / **keep both** actions. Merging unions tags/progress onto the survivor.

**Acceptance:** posting the same opportunity with a slightly reworded title creates a
review-queue entry, not a second card; merge preserves the older item's progress and logs.

---

## Phase 4 — Lifecycle polish

### F-D1: Deadline hygiene
- "Closing soon" surface: items with deadlines in the next 7 days pinned in a top strip.
- Auto-suggest archive: items past deadline (or `source_status = Closed`) with no progress
  activity get a one-click "sweep to Archived" batch action, never automatic deletion.

### F-D2: "Since your last visit" panel
On load, a dismissible panel summarizing what changed since the user's previous session:
N new items (with links), M items closed, K snoozes woken. Powered by `sync_log` +
a `last_seen_at` per user. This replaces any need for email digests initially.

### F-D3: Mobile triage pass
A responsive audit of `index.html` for phone use plus a **triage mode**: new/unreviewed
items presented one at a time, full-screen card, with large tap targets for the five common
verdicts — _Star_, _Snooze…_, _Tag…_, _Too far_, _Hide_ — and swipe left/right for
hide/star. Keyboard equivalents (h/s/t/f/x + arrows) on desktop.

**Acceptance:** on a phone-width viewport, triage 10 new items in under a minute without
mis-taps; every action syncs to D1.

### F-D4: Status webhook back to the scheduled runs (optional)
Expose `GET /api/items?status=active` so the scheduled runs can read the current list and
avoid re-reporting things the user hid or archived, closing the loop between triage and
scanning. (Today the runs are write-only.)

---

## Sequencing & rationale

| Order | Phase | Why first |
|---|---|---|
| 1 | Phase 1 (A1–A6) | Everything else needs the hosted DB; also delivers phone tracking immediately, which is the biggest practical unlock. |
| 2 | Phase 2 (B1–B5) | The pain named explicitly: "look tomorrow", "when resume is better", "too far", custom buckets. Pure D1 + UI work, no ML risk. |
| 3 | Phase 3 (C1–C4) | Embeddings ride on the ingest pipeline from A3; do it once that pipeline is stable. |
| 4 | Phase 4 (D1–D4) | Quality-of-life; D3 (mobile triage) can be pulled earlier if phone use is heavy. |

**Migration safety:** Airtable stays read-only-alive with dual-writes through Phase 1;
retire it only after F-A4's checklist passes. Local `app.db` is exported and kept as a
final pre-migration backup in R2.

**Estimated external costs:** Cloudflare Workers/D1/Vectorize/R2 free tiers comfortably
cover this scale (≈500 items, one user). Embedding backfill and per-item Claude calls are
fractions of a cent per item.
