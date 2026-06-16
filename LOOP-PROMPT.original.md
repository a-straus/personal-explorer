# /loop build prompt — "Opportunity Explorer"

You are building a polished, single-page web app called **Opportunity Explorer** that lets me
(Adam) browse, search, and triage every opportunity my recurring Airtable scans have found —
**without ever clicking into Airtable.** There is a lot of rich info here (fit notes, pay,
deadlines, links) and I want to see and act on it at a glance.

You are running **unattended, overnight, in a loop.** Work fully autonomously and keep going,
iteration after iteration, until the Acceptance Checklist (section 4) is 100% green.

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
  6. `git add -A && git commit -m "..."` (local commit only).
- **Be idempotent.** Never duplicate work or break a passing build. If everything is already
  green, run full verification once more; if still green, write `STATUS: ALL DONE` at the top of
  `PROGRESS.md` and make no further changes.
- Prefer **many small, verified steps** over large rewrites.
- If something is genuinely blocked, write the blocker at the top of `PROGRESS.md` and move on to
  another checklist item — do not halt.

**Guardrails (safe unattended autonomy):**
- Work **only inside this project folder.** Never modify or delete anything outside it.
- **Never** `git push`, install global packages, or run destructive/system commands. Local dev
  dependencies for testing (e.g. Playwright) are fine.
- The Airtable token lives only in `.env` / an env var. **Never print it, hardcode it, or commit
  it.** `.env` is gitignored. Do not try to discover a token on your own.
- **Read-only with respect to Airtable:** this app and the build NEVER write back to Airtable,
  send email, or post anything anywhere. The only network call is `refresh-data.mjs` reading data.
- Render only what's in the data — never invent opportunities.

---

## 1. Phase 0 — get the data first

Run `node refresh-data.mjs`.
- With `AIRTABLE_TOKEN` set (a read-only Airtable PAT), it pulls all three tables live from the
  "Teaching Transition" base and writes **`data.js`** (defines `window.TEACHING_DATA`) + `data.json`.
- With no token, it writes a small **SAMPLE** dataset so you can still build and verify the UI.
  Note this in `PROGRESS.md`; the real data fills in automatically once the token is present.

Build the UI against `window.TEACHING_DATA.items`. **Never hardcode opportunity content into HTML.**

---

## 2. What to build

A single file **`index.html`** — **vanilla HTML/CSS/JS. No framework, no build step, no bundler,
and no network/CDN at view time.** It must open by double-clicking the file (`file://`). The only
external file it loads is `data.js` (same folder); inline everything else. Keep it well under a
few hundred KB and fast with 150+ records.

It loads `window.TEACHING_DATA` and offers three views over the same data, with a persistent
search/filter bar across the top.

### A. Browse (default view) — the heart of the app
A clean, scannable **card grid**. Each card surfaces *everything I need so I never open Airtable*:
- **Title** (role / program / event), **Organization**, a colored **Category/type** badge and a
  colored **Priority** badge.
- **Commitment** (if present), **Location**, **Pay/Cost** (if present).
- **Deadline** with a relative countdown ("in 9 days", "today", "3 days ago") that turns **amber
  when < 14 days** away and **red when overdue**.
- The full **"why / fit notes"** text — this is the most valuable field. Show it; clamp long text
  to a few lines with a "more" toggle.
- **Source**, and a prominent **"Open posting ↗"** button linking out
  (`target="_blank" rel="noopener"`).
- A header strip with **live counts** (e.g. "62 jobs · 23 programs · 29 events — 8 Apply Now ·
  N with a deadline in 30 days"), a **"last refreshed {generatedAt}"** stamp, and a link to the
  Airtable base (`TEACHING_DATA.baseUrl`).

### B. Deadline radar
Everything that has a date, **soonest first**, grouped into **Overdue / This week / Next 30 days /
Later / No date**. Highlight what's upcoming. Use each item's unified `deadline`.

### C. Board — track applications
**Kanban columns by Status**: New → Reviewing → Applied → Interview → Accepted / Rejected / Passed
(drive columns from the status values actually present, in that order). The snapshot is read-only,
so let me **move a card / change its status locally and persist that to `localStorage`** (keyed by
item `id`) so my triage survives reloads and data refreshes. Make clear this is **local-only**
(it does **not** write back to Airtable), and add an **"Export my status changes"** button
(CSV **and** JSON) so I can act on them.

### Search / filter bar (applies to all views)
- Instant **text search** across title, org, notes, location, source.
- Multi-select **filter chips**: Dataset (Jobs / Programs / Events), Category/Type, Priority,
  Commitment, Status. Combined filters AND together.
- A **"hide Closed / Passed / Rejected"** toggle (ON by default).
- **Sort**: Date Added (newest), Deadline (soonest), Priority, Pay.
- Show a **live result count**.

### Polish
Modern, calm typography; responsive **360px → 1440px**; fast; accessible (keyboard nav, labels,
good contrast); tasteful empty states; subtle category colors; dark-mode-friendly is a plus.

---

## 3. Data contract

`window.TEACHING_DATA = { generatedAt, source, baseId, baseUrl, counts:{opportunities, programs,
events}, items: [ Item, ... ] }`

Each **Item** is already unified across the three tables by `refresh-data.mjs`:

```
{
  id, dataset: 'opportunities' | 'programs' | 'events',
  title, org, category, commitment?, location, link,
  deadline,        // YYYY-MM-DD or '' — Opp.Deadline / Program.Application Deadline / Event.Date
  pay,             // pay / cost / funding text or ''
  notes,           // the high-value 'why/fit' text (Fit Notes / Notes / Why Go)
  priority, status, source?, subjectFocus?, format?,
  dateAdded, lastChecked,
  raw              // original Airtable fields, if you need anything else
}
```

Specifics to handle gracefully:
- **Any field can be an empty string** — guard for it everywhere.
- **Priority vocabulary differs by dataset.** Opportunities & Programs use
  *Apply Now / Strong / Worth a Look / Long Shot* (Opportunities also has *High / Medium*); Events
  use *Go / Strong / Maybe / FYI*. Render whatever value is present and color it on a hot→cool ramp.
  **Do not hardcode a single fixed set** — derive chips/colors from the values in the data.
- **Status** (Opportunities): New / Reviewing / Applied / Interview / Accepted / Rejected / Passed.
  Programs/Events are mostly "New". Board columns follow the values present, in that order.
- `dataset` lets you label and filter by Jobs / Programs / Events and pick which fields to show
  (e.g. Programs have `subjectFocus`/`format`; Events use `deadline` as the event date).

---

## 4. Acceptance checklist (the done-condition — VERIFY each, don't assume)

- [ ] `node refresh-data.mjs` runs clean and produces `data.js` + `data.json`.
- [ ] `index.html` opens via `file://` and renders the Browse grid from `data.js` with **zero
      console errors** and no network requests.
- [ ] Total cards shown equals `TEACHING_DATA.items.length`; per-dataset counts match `counts`.
- [ ] All three datasets (Jobs / Programs / Events) appear and can be filtered to individually.
- [ ] Typing in search filters cards live; clearing search restores all.
- [ ] Each filter (dataset, category, priority, commitment, status) narrows results correctly;
      combined filters AND together; the result count updates.
- [ ] "Hide Closed/Passed/Rejected" works and is on by default.
- [ ] Sort by Deadline (soonest) and Date Added (newest) both reorder correctly.
- [ ] Every card shows the full notes/why text (expandable) and a working external link
      (`target="_blank" rel="noopener"`).
- [ ] Deadline radar groups by urgency and orders soonest-first; overdue flagged red, <14 days amber.
- [ ] Board view groups by Status; changing a card's status **persists across reload**
      (localStorage) and **survives a data refresh** (matched by id); export to CSV + JSON works.
- [ ] Responsive with no overflow at **390px** and **1280px**; cards reflow.
- [ ] Smooth/scrolls fine with all records loaded.
- [ ] `verify.mjs` exists and prints PASS for every item above; screenshots saved in `verification/`.
- [ ] `README.md` explains how to open it and how to refresh data; `.gitignore` present; no secret
      is ever committed.

---

## 5. How to verify yourself (no human in the loop)

Write **`verify.mjs`** that automatically checks the app:
- Load `index.html` in a **headless browser**. Prefer **Playwright** (`npm i -D playwright` then
  `npx playwright install chromium` is allowed). Fall back to puppeteer; if neither can be
  installed, use `jsdom` to exercise the JS logic plus a strict code-review against section 4.
- Assert: page renders; visible item count equals `TEACHING_DATA.items.length`; typing in search
  reduces results; toggling each filter narrows correctly; changing sort changes order; a board
  status change persists across a reload; **no console errors**.
- Capture screenshots at **390px** and **1280px** widths into `verification/`, plus one of the
  Deadline radar and Board views.
- Print **PASS/FAIL per checklist item** and write `verification/REPORT.md`.

Run `node verify.mjs` each iteration. Only tick a checklist item once it actually passes. **Look at
the screenshots** before declaring a visual item done.

---

## 6. Files & progress tracking

Keep everything in this folder:
`index.html` · `data.js` / `data.json` (generated) · `refresh-data.mjs` (provided) · `verify.mjs` ·
`verification/` · `PROGRESS.md` · `DECISIONS.md` · `README.md` · `.gitignore`

`PROGRESS.md` format:
- Line 1: `STATUS: IN PROGRESS` (or `ALL DONE`).
- The Acceptance Checklist with `[x]` / `[ ]`.
- A short log: one line per iteration (what changed, what verified).
- "Current blockers" and "Next step".
Read it first each iteration; update it last; commit.

---

## 7. Suggested iteration order

- **P0** — `node refresh-data.mjs`; confirm `data.js` loads in a quick Node check.
- **P1** — scaffold `index.html`; render the card grid + header counts from the data. Commit.
- **P2** — search + filter chips + sort + live result count. Commit.
- **P3** — card polish: badges, deadline coloring/countdown, notes "more" toggle, external links. Commit.
- **P4** — Deadline radar view. Commit.
- **P5** — Board view + localStorage status + CSV/JSON export. Commit.
- **P6** — responsive + accessibility + empty states + performance pass. Commit.
- **P7** — write `verify.mjs`, capture screenshots, fix every failing checklist item. Commit.
- **P8** — finalize `README.md` + `.gitignore`; run full verification → `STATUS: ALL DONE`.

When the whole checklist passes, you're done. Leave the app openable by simply double-clicking
`index.html`.
