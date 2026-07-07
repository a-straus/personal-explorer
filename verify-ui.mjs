// Drives the app at localhost:4317 and exercises the new features end-to-end.
import { chromium } from 'playwright';

const BASE = 'http://localhost:4317';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

// 1. App booted, sqlite backend, cards rendered
check('app boots with cards', await page.locator('.card').count() > 50, `${await page.locator('.card').count()} cards`);
check('sqlite backend detected', (await page.locator('#storeTxt').textContent()).includes('SQLite'));

// 2. Facet pills present on cards
const facetPills = await page.locator('.pill.facet').count();
check('facet pills on cards', facetPills > 20, `${facetPills} pills`);

// 3. Filter panel has Commute / Time commitment groups
await page.click('#filtBtn');
const panelText = await page.locator('#filtPanel').textContent();
check('commute filter group', panelText.includes('Commute') && panelText.includes('Walkable'));
check('effort filter group', panelText.includes('Time commitment') && panelText.includes('Full-time'));

// 4. Click "Remote" commute chip → count drops and all visible cards are Remote
const before = await page.locator('.card').count();
await page.locator('#filtPanel .chip', { hasText: 'Remote' }).first().click();
await page.waitForTimeout(200);
const after = await page.locator('.card').count();
check('commute filter narrows results', after < before && after > 0, `${before} -> ${after}`);
await page.locator('#clearFilt').click();

// 5. Semantic search: type a natural query, wait for debounce+fetch
await page.fill('#search', 'paid weekend robotics tutoring');
await page.waitForTimeout(2500);
const resultLine = await page.locator('#resultCount').textContent();
check('semantic indicator appears', resultLine.includes('semantic'), resultLine.trim());
const firstTitle = await page.locator('.card h3').first().textContent();
check('semantic top hit is relevant', /robot|tutor|coding|STEM|maker/i.test(firstTitle), firstTitle.trim());

// 6. Clear search, open drawer on first card
await page.click('#clrSearch');
await page.waitForTimeout(200);
await page.locator('.card [data-track]').first().click();
await page.waitForTimeout(300);
check('drawer opens', await page.locator('#drawer.is-open').count() === 1);
check('drawer facet chips', await page.locator('#d-commute .chip').count() === 5 && await page.locator('#d-effort .chip').count() === 5);

// 7. Facet override: click a commute chip, check pressed state
await page.locator('#d-commute .chip', { hasText: 'Walkable' }).click();
await page.waitForTimeout(400);
const pressed = await page.locator('#d-commute .chip[aria-pressed="true"]').textContent();
check('facet override sets Walkable', pressed.trim() === 'Walkable');
// revert override (tap again)
await page.locator('#d-commute .chip', { hasText: 'Walkable' }).click();
await page.waitForTimeout(400);

// 8. Tags: add + shows chip + filter group appears
await page.fill('#d-tagin', 'verify-test');
await page.click('#d-tagadd');
await page.waitForTimeout(400);
check('tag chip added', (await page.locator('#d-tags').textContent()).includes('#verify-test'));

// 9. More like this
const simBtn = page.locator('#d-simbtn');
if (await simBtn.count()) await simBtn.click();
await page.waitForTimeout(1500);
const simCount = await page.locator('.simitem').count();
check('more-like-this renders', simCount >= 5, `${simCount} similar items`);

// 10. Remove test tag, close drawer
await page.locator('#d-tags [data-rmtag]').click();
await page.waitForTimeout(400);
check('tag removed', !(await page.locator('#d-tags').textContent()).includes('verify-test'));
await page.keyboard.press('Escape');

// Screenshots
await page.screenshot({ path: new URL('./ui-browse.png', import.meta.url).pathname, fullPage: false });
await page.fill('#search', 'learn to teach math to middle schoolers');
await page.waitForTimeout(2200);
await page.screenshot({ path: new URL('./ui-semantic.png', import.meta.url).pathname, fullPage: false });
await page.click('#clrSearch');
await page.locator('.card [data-track]').first().click();
await page.waitForTimeout(1200);
await page.screenshot({ path: new URL('./ui-drawer.png', import.meta.url).pathname, fullPage: false });

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
const fails = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
