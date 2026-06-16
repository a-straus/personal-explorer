STATUS: ALL DONE

# Opportunity Explorer — build progress

All acceptance-checklist items pass. `node verify.mjs` → **27 PASS · 0 FAIL · 0 BLOCKED**.
Screenshots in `verification/` reviewed and look polished (Browse, Board, Deadlines, drawer, 390px).

## Acceptance checklist

Data & build:
- [x] `node refresh-data.mjs` clean; `data.js` + `data.json` real (185 items).
- [x] `node enrich.mjs` clean; writes `enrichment.js`; 97 real logos; Haiku used when key present, skips gracefully without; idempotent (re-run = 0 fetch / 0 spend).

App renders:
- [x] `node server.mjs` serves Browse grid; zero console errors; no third-party requests.
- [x] All 185 render (184 default, 1 Passed hidden by default toggle); counts 100/45/40.
- [x] Every card: logo/monogram, notes (expandable), about/known-for line, target=_blank rel=noopener link.
- [x] Three datasets filter; opportunities labeled "Opportunities".

Search / filter / sort:
- [x] Search filters live; clearing restores.
- [x] Each filter narrows; combined AND; count updates.
- [x] Hide Passed/Rejected ON by default; Needs triage works.
- [x] Board full pipeline columns even when empty (all 8).
- [x] Sort Priority(default)/Deadline/Date Added/Org; starred float to top.

Deadlines:
- [x] Grouped Overdue/This week/Next 30/Later; overdue red, <14d amber; events "happens"/apps "due"; calm No-date tail.

Progress logging:
- [x] SQLite path persists status/star/log/dates/checklist across reload; app.db independent of data.js so a refresh never clobbers it (matched by id).
- [x] file:// fallback renders + uses localStorage; storage badge reflects backend.
- [x] Export CSV + JSON works (server endpoints + local Blob fallback).

Launch / responsive / docs:
- [x] start.command executable; launches `node --no-warnings server.mjs` + opens browser.
- [x] No overflow at 390px / 1280px; smooth with 185.
- [x] verify.mjs prints PASS per item; screenshots + REPORT.md in verification/.
- [x] README explains launch/refresh/enrich; .gitignore present; no secret/app.db committed.

## Log
- iter1: git init; analyzed data; built enrich.mjs → 97 real logos + Haiku about/known-for for all 146 orgs. Verified logo files are real PNGs, text factual.
- iter1: built server.mjs (node:http + node:sqlite), tested all endpoints (health/progress/log/export). No warnings leak.
- iter1: built index.html (storage adapter, Browse/Deadlines/Board, filters/sort/search, drawer with log/dates/checklist/rating, monogram SVG, priority ramp). start.command + verify.mjs (Playwright).
- iter1: verify run → fixed 5 verify-assertion bugs (1 Passed item hidden by default = correct; board columns CSS-uppercased). Re-run → 27/27 PASS. Reviewed all screenshots.

## Current blockers
- none

## Next step
- none — build complete. Launch with `start.command`.
