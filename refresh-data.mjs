#!/usr/bin/env node
/*
 * refresh-data.mjs — pull the "Teaching Transition" Airtable base into data.js / data.json
 * -------------------------------------------------------------------------------------
 * Usage:
 *   AIRTABLE_TOKEN=pat_xxx node refresh-data.mjs
 *   (or put AIRTABLE_TOKEN=pat_xxx in a .env file in this folder, then: node refresh-data.mjs)
 *
 * Use a READ-ONLY Airtable Personal Access Token (scope: data.records:read) with access to
 * base app6mRGGi2xLKqR2i. NEVER hardcode or commit your token. .env is gitignored.
 *
 * Output: data.js (defines window.TEACHING_DATA) and data.json. The web app reads data.js.
 * No npm dependencies — uses Node 18+ built-in fetch.
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ---- minimal .env loader (no dependency) ---- */
function loadEnv() {
  const p = join(__dirname, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}
loadEnv();

const TOKEN = process.env.AIRTABLE_TOKEN || process.env.AIRTABLE_API_KEY || '';
const BASE_ID = 'app6mRGGi2xLKqR2i';
const BASE_URL = `https://airtable.com/${BASE_ID}`;

/*
 * Each table maps Airtable field names -> a unified Item schema used by the UI.
 * (Field IDs are noted for reference in case a field is ever renamed.)
 */
const TABLES = {
  opportunities: {
    id: 'tblj9n2DaM1h4uihe',
    map: {
      'Role': 'title',            // fldFLYDAjCamVW50F
      'Organization': 'org',      // fldfQdGiccQowO9bW
      'Category': 'category',     // flddXKSdqVyn76qBF  (Teaching Job/Tutoring/Maker-Robotics/Volunteering/Class-Training)
      'Commitment': 'commitment', // fldsSZpfqF8FhnskR
      'Location': 'location',     // fldhzUIgDyWYcaSQS
      'Link': 'link',             // fldzbfGqhviR99JfE
      'Deadline': 'deadline',     // fld7yjnj07FvkMJno
      'Pay': 'pay',               // fldU8gO7ztXnNxMYa
      'Fit Notes': 'notes',       // fldUwXs4H2v5BNfo1
      'Priority': 'priority',     // fldr4QYzNM4qmgjIq  (Apply Now/Strong/Worth a Look/Long Shot/High/Medium)
      'Status': 'status',         // fldhdCzV6Z6j9iI6e  (New/Reviewing/Applied/Interview/Accepted/Rejected/Passed)
      'Date Added': 'dateAdded',  // fldNsjATwtLkkmU9r
      'Source': 'source',         // fldylxB1G9dJrb6oa
      'Last Checked': 'lastChecked' // fldkHeBFSWIUJMsW5
    }
  },
  programs: {
    id: 'tblRRDve12JKAo18A',
    map: {
      'Program': 'title',             // fld1Jmi5UrZ3qHjiV
      'Institution': 'org',           // fldtZDsrCYeRvNtmK
      'Type': 'category',             // fldxuBWKkT1CVVfWj (Online MA/Part-time MA/Funded Residency/Fellowship/Certification/Other)
      'Subject Focus': 'subjectFocus',// fldQu0JFOXT8pyo7O
      'Format': 'format',             // fldDQfTWvzZBY0aGE
      'Cost / Funding': 'pay',        // fldrtFc9ipmPyci6i
      'Application Deadline': 'deadline', // flddo8zYJfJhrlTgw
      'Link': 'link',                 // fldgZ7VxZXHYCKXWg
      'Notes': 'notes',               // fldUUUha9LMZrT9RI
      'Priority': 'priority',         // fldb2MTa1BqIP6al6
      'Status': 'status',             // fld1LVSEiXcZwRy58
      'Date Added': 'dateAdded',      // fldCj1fgOHT0S3UmN
      'Last Checked': 'lastChecked'   // fldHmlC2CXHyWtbbT
    }
  },
  events: {
    id: 'tbl22InnKlOX7I9Ek',
    map: {
      'Event / Program': 'title', // fld4BPxdEqs76mNUe
      'Organizer': 'org',         // fldQ3Nw7B4tRHYfLi
      'Type': 'category',         // fldiN0gcq4AXnKBVf (Workshop/Conference/Meetup/Association-Community/Mentorship/Other)
      'Date': 'deadline',         // fldT9pXbtrXNwQFgu  (used as the event date / deadline)
      'Location': 'location',     // fld5IIP19zRpFp8ph
      'Link': 'link',             // fldZlfX8qaDNPaj5m
      'Cost': 'pay',              // fld15dwGtUfwE57wE
      'Why Go': 'notes',          // fldKIwACPKnRKxuIt
      'Priority': 'priority',     // fld7lAYrjfEErywlt  (Go/Strong/Maybe/FYI)
      'Status': 'status',         // fld8gVAu3dUK6aLcf
      'Date Added': 'dateAdded',  // fldHk7fF686VKhlAI
      'Last Checked': 'lastChecked' // fldP8GfuBlpglS3TX
    }
  }
};

async function fetchTable(tableId) {
  const records = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${tableId}`);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) {
      throw new Error(`Airtable ${tableId} -> ${res.status} ${res.statusText}: ${await res.text()}`);
    }
    const json = await res.json();
    records.push(...json.records);
    offset = json.offset;
  } while (offset);
  return records;
}

function normalize(dataset, map, rec) {
  const out = { id: rec.id, dataset, createdTime: rec.createdTime, raw: rec.fields };
  for (const [field, key] of Object.entries(map)) {
    let v = rec.fields[field];
    if (Array.isArray(v)) v = v.map(x => (x && x.name) ? x.name : x).join(', ');
    else if (v && typeof v === 'object' && 'name' in v) v = v.name; // safety if API returns select objects
    out[key] = v ?? '';
  }
  return out;
}

function write(data, isSample) {
  writeFileSync(join(__dirname, 'data.json'), JSON.stringify(data, null, 2));
  const banner = isSample
    ? ' (SAMPLE fallback — set AIRTABLE_TOKEN in .env for real data, then re-run)'
    : '';
  writeFileSync(
    join(__dirname, 'data.js'),
    `/* Auto-generated by refresh-data.mjs${banner}. Do not edit by hand. */\n` +
    `window.TEACHING_DATA = ${JSON.stringify(data)};\n`
  );
  const n = data.items ? data.items.length : 0;
  console.log(`Wrote data.js + data.json — ${n} items${isSample ? ' [SAMPLE]' : ''}.`);
}

/* Small, schema-complete fallback so the UI can be built before the token is set. */
const SAMPLE = {
  generatedAt: new Date().toISOString(),
  source: 'sample',
  baseId: BASE_ID,
  baseUrl: BASE_URL,
  counts: { opportunities: 2, programs: 1, events: 1 },
  items: [
    { id: 'sampleOpp1', dataset: 'opportunities', title: 'Learning Design Partner, Computer Science & AI', org: 'Urban Arts Partnership', category: 'Teaching Job', commitment: 'Full-time', location: 'New York, NY', link: 'https://www.idealist.org/', deadline: '2026-06-01', pay: '', notes: 'AP CSP via game design (Unity) — strong match for an AI/LLM background. No cert required.', priority: 'Apply Now', status: 'New', source: 'Idealist.org', dateAdded: '2026-06-15', lastChecked: '2026-06-15', raw: {} },
    { id: 'sampleOpp2', dataset: 'opportunities', title: 'Academic Technology Integrator (Grades 5-12)', org: 'The Spence School', category: 'Teaching Job', commitment: 'Full-time', location: 'New York, NY', link: 'https://www.spenceschool.org/about-spence/employment', deadline: '', pay: '$84,016-$164,185/yr', notes: 'No NYS cert required; AI integration focus at a top NYC independent school.', priority: 'Strong', status: 'New', source: 'EdTech Recruiting', dateAdded: '2026-06-15', lastChecked: '2026-06-15', raw: {} },
    { id: 'samplePrg1', dataset: 'programs', title: 'Master of Liberal Arts (MLA)', org: 'Johns Hopkins University', category: 'Online MA', subjectFocus: 'Interdisciplinary humanities (English/History)', format: '100% online, 30 credits', location: '', link: 'https://advanced.jhu.edu/academics/graduate/master-of-liberal-arts/', deadline: '', pay: '~$38,150 total', notes: 'Fully online, rolling admission. Subject-mastery credential for the long-term humanities goal.', priority: 'Strong', status: 'New', source: 'Program', dateAdded: '2026-06-13', lastChecked: '2026-06-13', raw: {} },
    { id: 'sampleEvt1', dataset: 'events', title: 'NYC Education + Technology Meetup (EdTechNYC)', org: 'EdTechNYC Meetup', category: 'Meetup', location: 'New York City', link: 'https://www.meetup.com/edtechnyc/', deadline: '', pay: 'Free', notes: '2,200+ member group at the intersection of tech and education — exactly the right network.', priority: 'Strong', status: 'New', source: 'Event', dateAdded: '2026-06-13', lastChecked: '2026-06-13', raw: {} }
  ]
};

async function main() {
  if (!TOKEN) {
    console.warn('⚠ No AIRTABLE_TOKEN found in env or .env.');
    console.warn('  Writing a small SAMPLE dataset so the UI can still be built/tested.');
    console.warn('  For real data: put AIRTABLE_TOKEN=pat_xxx in a .env file here, then re-run: node refresh-data.mjs');
    write(SAMPLE, true);
    return;
  }
  console.log('Fetching live data from Airtable base', BASE_ID, '...');
  const items = [];
  const counts = {};
  for (const [dataset, { id, map }] of Object.entries(TABLES)) {
    const recs = await fetchTable(id);
    counts[dataset] = recs.length;
    for (const r of recs) items.push(normalize(dataset, map, r));
    console.log(`  ✓ ${dataset}: ${recs.length} records`);
  }
  write({
    generatedAt: new Date().toISOString(),
    source: 'airtable',
    baseId: BASE_ID,
    baseUrl: BASE_URL,
    counts,
    items
  }, false);
}

main().catch(e => { console.error('✗ Refresh failed:', e.message); process.exit(1); });
