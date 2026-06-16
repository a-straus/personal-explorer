STATUS: IN PROGRESS

# Opportunity Explorer — build progress

## Acceptance checklist

Data & build:
- [x] `node refresh-data.mjs` runs clean; `data.js` + `data.json` exist with real data (185 items).
- [ ] `node enrich.mjs` runs clean, writes `enrichment.js`, fetches some real logos, skips/uses Claude per key, idempotent.

App renders:
- [ ] `node server.mjs` starts; localhost renders Browse grid, zero console errors, no third-party requests.
- [ ] Total cards == 185; per-dataset counts 100/45/40.
- [ ] Every card shows logo/monogram, notes (expandable), about/known-for when present, working external link.
- [ ] All three datasets filter; `opportunities` labeled "Opportunities".

Search / filter / sort:
- [ ] Search filters live; clearing restores.
- [ ] Each filter narrows; combined AND; count updates.
- [ ] Hide Passed/Rejected ON by default; Needs triage works.
- [ ] Board full pipeline columns even when empty.
- [ ] Sort Priority(default)/Deadline/Date Added; starred float to top.

Deadlines:
- [ ] Deadlines view grouped by urgency; overdue red, <14d amber; events "happens"/apps "due"; calm no-date.

Progress logging:
- [ ] SQLite path persists across reload + survives refresh-data re-run (by id); dates+checklist persist.
- [ ] file:// fallback renders + uses localStorage; storage badge reflects backend.
- [ ] Export CSV + JSON works.

Launch / responsive / docs:
- [ ] start.command executable, launches server + opens browser.
- [ ] Responsive no overflow at 390px and 1280px; smooth with 185.
- [ ] verify.mjs prints PASS per item; screenshots in verification/.
- [ ] README explains launch/refresh/enrich; .gitignore present; no secret/app.db committed.

## Log
- iter1: git init; analyzed data (priorities 9 values, 47 deadlines, 128 domains, aggregators identified). Both API keys real. Starting build.

## Current blockers
- none

## Next step
- Build enrich.mjs (logos + Haiku about/known-for).
