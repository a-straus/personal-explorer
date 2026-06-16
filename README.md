# Opportunity Explorer — overnight build kit

A small kit to have **Claude Code build a visual local web app overnight** that lets you browse
everything your recurring Airtable scans have found — jobs, tutoring, maker/robotics, volunteering,
classes, master's/fellowship programs, and networking events — **and log your progress as you apply**,
all in one clean view, no clicking through Airtable.

Each opportunity shows a **logo**, a **description / what it's known for**, any **deadlines**, and an
**application tracker** that saves your status, notes, and checklist to a small local database.

## What's in this folder

| File | What it is |
|------|------------|
| `LOOP-PROMPT.md` | The prompt you feed to `/loop` (v2). It tells Claude Code exactly what to build, how to verify it, and how to keep going unattended. |
| `LOOP-PROMPT.original.md` | The original v1 prompt, kept for reference. Safe to delete. |
| `refresh-data.mjs` | Ready-to-run script that pulls your three Airtable tables into `data.js` (the app reads this). No npm install needed. |
| `data.js` / `data.json` | Your current snapshot (already pulled — 185 items: 100 opportunities, 45 programs, 40 events). |
| `README.md` | This file. |
| `.gitignore` | Keeps your token, the progress database, and local files out of git. |

Claude Code will create the rest overnight: `index.html` (the app), `enrich.mjs` + `enrichment.js`
(logos + optional descriptions), `server.mjs` (a small local server + SQLite progress store),
`start.command` (double-click launcher), `assets/logos/`, `verify.mjs`, `verification/` (screenshots
+ report), `PROGRESS.md`, `DECISIONS.md`.

---

## How it works (architecture)

Expensive/networked work happens **at build time**; the running app stays fast, offline, and vanilla;
your progress lives in a **real local database**:

- **Build-time scripts** — `refresh-data.mjs` (reads Airtable) and `enrich.mjs` (fetches org logos
  and, optionally, a short "about / known for" blurb via Claude). These write `data.js` and
  `enrichment.js`.
- **The app** — a single `index.html` (vanilla HTML/CSS/JS, no framework/CDN) that reads those files.
- **Progress store** — `server.mjs` runs a tiny local server backed by **SQLite** (`app.db`) so your
  application status, activity log, dates, and checklist persist on your Mac. If you just
  double-click `index.html` with no server, it still works and falls back to your browser's
  localStorage.

---

## One-time setup (about 3 minutes)

**1. Create a read-only Airtable token.**
Go to <https://airtable.com/create/tokens>, create a Personal Access Token with:
- scope **`data.records:read`** (read-only — an unattended run can't change your data), and
- access to the **Teaching Transition** base.

**2. Put the token in a local `.env` file** in this folder (gitignored — never commit it):

```
AIRTABLE_TOKEN=pat_your_token_here
```

**3. (Optional) Add a Claude API key for richer descriptions.**
If you want each card to show a factual "about / known for" line (e.g. "Spence is a top-tier NYC
independent school"), add a key to the same `.env`:

```
ANTHROPIC_API_KEY=sk-ant-your_key_here
```

The enrichment uses **Claude Haiku** (`claude-haiku-4-5`, the cheapest model) to write a short factual
line per organization (resolved once per unique org and cached, so re-runs don't re-spend). **This is
entirely optional** — with no key, the app still shows logos and the rich "why it fits" notes that are
already in your data. (Logos never need a key.)

**4. Refresh the data:**

```
node refresh-data.mjs
```

You should see `✓ opportunities: …`, `✓ programs: …`, `✓ events: …` and an updated `data.js`.
(If you skip the token, it writes a small sample dataset so the build can still proceed.) The data is
already pulled, so you can skip this until you want fresher data.

---

## Run it overnight

1. Open a terminal **in this folder** and start Claude Code here.
2. Turn on unattended mode so it doesn't pause on each step. The simple option is to launch with
   permissions bypassed:

   ```
   claude --dangerously-skip-permissions
   ```

   ⚠️ **Safety:** that flag lets the agent run commands without asking. Only use it **in this
   dedicated folder**. The prompt is written to stay inside this folder, never `git push`, and never
   touch your token. If you'd rather, run without the flag and just approve actions before bed.
3. Start the loop pointed at the prompt:

   ```
   /loop
   ```

   then paste the contents of `LOOP-PROMPT.md` as the task (or point the loop at the file). It will
   build → verify → commit → repeat, advancing the checklist each pass.

4. **In the morning:** double-click **`start.command`** to launch the app (it starts the local server
   and opens your browser). Check `PROGRESS.md` — it should say `STATUS: ALL DONE` — and skim
   `verification/REPORT.md` and the screenshots.

---

## Using the app

- **Launch:** double-click `start.command` (or run `node server.mjs` and open the printed
  `http://localhost:…` URL). You can also double-click `index.html` to browse read-only without the
  server (progress then saves to your browser instead of SQLite — a badge shows which).
- **Browse** every opportunity with logo, description, deadline, and badges; search, filter, and sort.
- **Track your applications** on the Board: change status, add timestamped notes, set "applied"/
  "follow-up" dates, tick a checklist, and star favorites. It all saves locally and can be exported
  to CSV/JSON.

---

## Keeping it fresh

Pull the latest from Airtable any time:

```
node refresh-data.mjs        # refresh opportunity data
node enrich.mjs              # refresh logos + (optional) descriptions
```

Then reload the app. Your saved progress is matched to items by **ID**, so it survives refreshes.

---

## Notes

- The app **reads** from Airtable only (via `refresh-data.mjs`). It never writes back. Your progress
  stays **local** (SQLite on your Mac, or browser localStorage) and can be exported.
- Keep your tokens in `.env` only. If `AIRTABLE_TOKEN` or `ANTHROPIC_API_KEY` is ever exposed, rotate
  it (Airtable tokens page / Anthropic console).
- `app.db` (your progress) is gitignored so it's never committed.
