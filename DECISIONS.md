# Decisions log (autonomous build)

Assumptions made without asking (per operating rules):

- **Port 4317** fixed for the local server.
- **Anthropic key is present** in `.env`, so `enrich.mjs` runs the Haiku "about/known for" step using model `claude-haiku-4-5`. Cheapest model, per-org caching, opted-in by the key being provided.
- **Priority hot→cool ramp** derived from values present:
  - hottest: `Apply Now`, `Go`, `High`
  - hot: `Strong`
  - warm: `Worth a Look`, `Maybe`, `Medium`
  - cool: `Long Shot`, `FYI`
  - unknown values sort/colour as warm.
- **Aggregator blocklist** (favicon would stamp the wrong brand): eventbrite.com, *.greenhouse.io, job-boards.greenhouse.io, *.lever.co, *.myworkdayjobs.com, idealist.org, *.corsizio.com, careers.nais.org, nysais.org (job board), linkedin.com, indeed.com, meetup.com, glassdoor.com, ziprecruiter.com, handshake.com, schoolspring.com, edjoin.org, google.com, forms.gle, docs.google.com, bit.ly. Blocked → monogram.
- **Logo keep threshold**: min image dimension ≳64px, else discard → monogram.
- **Board pipeline** is fixed: New → Reviewing → Applied → Interview → Offer → Accepted / Rejected / Passed (rendered even when empty).
- **Event vs application wording**: `dataset === 'events'` → "happens"; else "due".
- **generatedAt is in the future** (timezone artifact): all relative-date math clamps "now" to `min(Date.now(), generatedAt-derived)` — actually we use real `Date.now()` and treat the snapshot date as informational; countdown never throws on a future generatedAt.
- **Status default** for triage filter = `New` (184/185 are New).
- **Dataset labels**: opportunities→"Opportunities", programs→"Programs", events→"Events".
