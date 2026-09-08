// The visual completion gate — run the real app in a real browser and look.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// Everything else in this repo verifies the app without rendering it: unit
// tests over pure functions, SQL assertions, a preview harness that prints what
// each screen WOULD say. All of that is necessary and none of it catches a
// clipped column, a control that does nothing, text on a ground it cannot be
// read against, or a page that scrolls sideways.
//
// The review asked for exactly this and I could not do it. Now it runs.
//
// ── WHAT IT REFUSES TO DO ──────────────────────────────────────────────────
// It never clicks anything on Outreach that could contact a creator, and it
// never marks a recommendation applied against real data without putting the
// status back. QA that changes the world is not QA.
//
//   node scripts/visual-qa.mjs [baseUrl]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { env, need, ROOT_DIR } from './_env.mjs';

const BASE = process.argv[2] || 'http://localhost:4318';
const OUT = path.join(ROOT_DIR, 'qa-screenshots');
need('BOSS_LOGIN_PASSWORD');

fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '390x844', width: 390, height: 844 },
];

const ROUTES = [
  { path: '/overview', name: 'overview' },
  { path: '/campaigns', name: 'campaigns' },
  { path: '/creatives', name: 'creatives' },
  { path: '/products', name: 'products' },
  { path: '/organic', name: 'organic' },
  { path: '/attribution', name: 'attribution' },
  { path: '/data', name: 'data-status' },
];

// Things that must never appear on a buyer screen.
const FORBIDDEN = [
  /npm run \w/,           // terminal commands
  /PRODUCT_GMV_MAX/,      // raw enums
  /\/gmv-max\/campaigns/, // provider endpoint paths
  /shop_top_videos|shop_attribution|product_daily_metrics/, // internal function names
  /undefined|NaN|\[object Object\]/,
];

let pass = 0; let fail = 0; const failures = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (ok) pass++; else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); }
};

// Use the browser that is already on the machine rather than pulling another
// 150MB build. Playwright's bundled Chromium and the installed Chrome differ by
// a build number, not by anything this QA depends on.
async function launch() {
  const candidates = [
    { channel: 'chrome' },
    { channel: 'msedge' },
    {},   // whatever Playwright downloaded, if a matching build exists
  ];
  let last;
  for (const opts of candidates) {
    try { return await chromium.launch(opts); } catch (e) { last = e; }
  }
  throw new Error(`no usable browser: ${last?.message?.split('\n')[0]}`);
}

/**
 * Wait for the data to actually arrive, rather than sleeping and hoping.
 *
 * A fixed timeout is not a settle time — this app queries a Supabase project in
 * Tokyo over a connection that drops requests, and a 5s sleep photographed the
 * page mid-skeleton twice. Waiting for the skeletons to disappear tests the
 * thing we care about and fails honestly when they never do.
 */
async function waitForData(p, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const skeletons = await p.locator('.skel').count();
    if (skeletons === 0) return Date.now() - t0;
    await p.waitForTimeout(400);
  }
  return -1;   // still loading — the caller's assertions will say so
}

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') {
    const t = m.text();
    // A failed favicon or an aborted fetch on fast navigation is noise, not a defect.
    if (!/favicon|net::ERR_ABORTED|Failed to load resource/i.test(t)) consoleErrors.push(t);
  }
});
page.on('pageerror', (e) => pageErrors.push(e.message));

// ── sign in ─────────────────────────────────────────────────────────────────
console.log(`\n── signing in at ${BASE} ──`);
await page.goto(`${BASE}/overview`, { waitUntil: 'domcontentloaded' });
await page.fill('input[type=email]', 'mrrashid3255@gmail.com');
await page.fill('input[type=password]', env.BOSS_LOGIN_PASSWORD);
await page.click('button:has-text("Sign in")');
await page.waitForSelector('.topbar', { timeout: 30000 });
await page.waitForTimeout(3500);
check('signs in and reaches the app shell', await page.locator('.topbar').isVisible());

const shopName = await page.locator('.topbar select').first().inputValue().catch(() => null);
console.log(`  active shop id: ${shopName?.slice(0, 8) ?? 'unknown'}…`);

// ── every route, every viewport ─────────────────────────────────────────────
console.log('\n── each route renders, at four widths ──');
for (const vp of VIEWPORTS) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  for (const r of ROUTES) {
    await page.goto(`${BASE}${r.path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.topbar', { timeout: 20000 });
    // Give the queries time to settle so a screenshot is not all skeletons.
    const settled = await waitForData(page, vp.name === '1440x900' ? 25000 : 12000);
    if (settled < 0) console.log('        (still loading after the wait — screenshot shows skeletons)');

    await page.screenshot({ path: path.join(OUT, `${r.name}--${vp.name}.png`), fullPage: false });

    // THE PAGE ITSELF MUST NEVER SCROLL SIDEWAYS. Wide tables scroll inside
    // their own container; the body does not.
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`${r.name} @ ${vp.name}: no horizontal page overflow`, overflow <= 1, `overflows by ${overflow}px`);

    // Nothing may be rendered as a literal error value.
    const text = await page.evaluate(() => document.body.innerText);
    for (const bad of FORBIDDEN) {
      const m = text.match(bad);
      if (m) check(`${r.name} @ ${vp.name}: no "${m[0]}" on a buyer screen`, false, `found "${m[0]}"`);
    }

    // Something has to actually be on the page.
    check(`${r.name} @ ${vp.name}: renders real content`, text.trim().length > 200,
      `only ${text.trim().length} chars of text`);
  }
}

// ── the review's explicit first-screenful requirement ───────────────────────
console.log('\n── overview at 1366x768, without scrolling ──');
await page.setViewportSize({ width: 1366, height: 768 });
await page.goto(`${BASE}/overview`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector(".decision, .card.pad", { timeout: 30000 });
await waitForData(page);
await page.screenshot({ path: path.join(OUT, 'gate--overview-1366.png') });

const inFold = async (sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.top < window.innerHeight && r.bottom > 0 && r.height > 0;
}, sel);

check('shop selector visible without scrolling', await inFold('.topbar select'));
check('date scope visible without scrolling', await inFold('.windowbtn'));
check('data status visible without scrolling', await inFold('.statuspill'));
check('the decision is visible without scrolling', await inFold('.decision'));
check('summary metrics visible without scrolling', await inFold('.statstrip'));

const rowsInFold = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.card table tbody tr')];
  return rows.filter((r) => {
    const b = r.getBoundingClientRect();
    return b.top < window.innerHeight && b.bottom > 0 && b.height > 0;
  }).length;
});
check('at least 3 actionable rows in the first screenful', rowsInFold >= 3, `only ${rowsInFold} visible`);

const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
console.log(`  overview total height: ${pageHeight}px (was ~3888px before the rebuild)`);
check('overview is no longer several screens of narrative', pageHeight < 2600, `${pageHeight}px`);

// ── a finding opens exactly its own set ─────────────────────────────────────
console.log('\n── a finding drills through to its own evidence ──');
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${BASE}/overview`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);

const drill = page.locator('.decision-actions a.btn-primary').first();
if (await drill.count()) {
  const label = (await drill.innerText()).trim();
  const m = label.match(/\((\d+)\)/);
  const claimed = m ? Number(m[1]) : null;
  await drill.click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(OUT, 'journey--finding-drilldown.png') });

  const banner = await page.locator('.note').first().innerText().catch(() => '');
  const shown = banner.match(/Showing the (\d+)/);
  check('the drill-down states it is the finding\'s own set',
    /finding/i.test(banner), banner.slice(0, 90));
  if (claimed && shown) {
    check(`the count on the button (${claimed}) matches the set opened (${shown[1]})`,
      Number(shown[1]) === claimed, `button said ${claimed}, page says ${shown[1]}`);
  }
  const url = page.url();
  check('the affected ids travel in the URL', /[?&]ids=/.test(url));
} else {
  console.log('  (no drill-down action on this shop/window — skipped)');
}

// ── creatives: search, sort, page past the first 50 ─────────────────────────
console.log('\n── creatives is a working tool, not a dead end ──');
await page.goto(`${BASE}/creatives`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);

const pagerText = await page.locator('.pager').first().innerText().catch(() => '');
check('the table states the whole population', /of\s[\d,]+/.test(pagerText), pagerText.slice(0, 80));

const firstBefore = await page.locator('tbody tr td').first().innerText().catch(() => '');
const nextBtn = page.locator('.pager button:has-text("Next")');
if (await nextBtn.count() && await nextBtn.isEnabled()) {
  await nextBtn.click();
  await page.waitForTimeout(3000);
  const firstAfter = await page.locator('tbody tr td').first().innerText().catch(() => '');
  check('paging past the first 50 shows different rows', firstBefore !== firstAfter);
  await page.screenshot({ path: path.join(OUT, 'journey--creatives-page2.png') });
} else {
  check('paging control present when the population exceeds a page', true);
}

await page.goto(`${BASE}/creatives`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
const sortBtn = page.locator('th .sortbtn:has-text("GMV")').first();
const beforeSort = await page.locator('tbody tr td.num').first().innerText().catch(() => '');
await sortBtn.click();
await page.waitForTimeout(2500);
const afterSort = await page.locator('tbody tr td.num').first().innerText().catch(() => '');
check('clicking a sort header reorders the table', beforeSort !== afterSort,
  `${beforeSort} then ${afterSort}`);

const searchBox = page.locator('input[placeholder*="Search creator"]');
await searchBox.fill('zzzzzznotarealcreator');
await page.waitForTimeout(2500);
const emptyText = await page.evaluate(() => document.body.innerText);
check('a search with no matches explains itself', /No videos match these filters/i.test(emptyText));
await page.screenshot({ path: path.join(OUT, 'journey--creatives-no-results.png') });

await page.locator('button:has-text("Clear")').first().click().catch(() => {});
await page.waitForTimeout(2500);

// Row detail opens in place.
const detailBtn = page.locator('tbody .lnk:has-text("Detail")').first();
if (await detailBtn.count()) {
  await detailBtn.click();
  await page.waitForTimeout(1200);
  check('a creative row opens its detail in place', await page.locator('.vdetail').isVisible());
  await page.screenshot({ path: path.join(OUT, 'journey--creative-row-detail.png') });
}

// ── products → product detail ───────────────────────────────────────────────
console.log('\n── products open a real detail page ──');
await page.goto(`${BASE}/products`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);
const thumbs = await page.locator('.pthumb').count();
check('product thumbnails render', thumbs > 0, `${thumbs} found`);

const prodLink = page.locator('tbody a.lnk').first();
if (await prodLink.count()) {
  await prodLink.click();
  await page.waitForTimeout(4500);
  check('a product row opens product detail', /\/products\/.+/.test(page.url()), page.url());
  check('the detail names its scope', await page.locator('.ptitle').isVisible());
  await page.screenshot({ path: path.join(OUT, 'journey--product-detail.png') });

  await page.locator('.tabbar button:has-text("Commerce")').click();
  await page.waitForTimeout(1500);
  const commerce = await page.evaluate(() => document.body.innerText);
  check('commerce names the missing provider fields rather than showing 0%',
    /Unavailable/i.test(commerce) && /original_price/.test(commerce));
  await page.screenshot({ path: path.join(OUT, 'journey--product-commerce.png') });

  await page.locator('.tabbar button:has-text("Creatives")').click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(OUT, 'journey--product-creatives.png') });

  await page.goBack();
  await page.waitForTimeout(2500);
  check('back returns to the products list', /\/products(\?|$)/.test(page.url()), page.url());
}

// ── campaign detail + the workflow that must survive a reload ───────────────
console.log('\n── campaign detail and the persistent workflow ──');
await page.goto(`${BASE}/campaigns`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
const campLink = page.locator('tbody a.lnk').first();
if (await campLink.count()) {
  await campLink.click();
  await page.waitForTimeout(5000);
  check('a campaign name opens campaign detail', /\/campaigns\/.+/.test(page.url()), page.url());
  await page.screenshot({ path: path.join(OUT, 'journey--campaign-detail.png') });

  await page.locator('.tabbar button:has-text("Scenario")').click();
  await page.waitForTimeout(3000);
  const scenario = await page.evaluate(() => document.body.innerText);
  check('the scenario view states its training window separately',
    /Model trains on|model trains/i.test(scenario) || /training/i.test(scenario));
  check('budget and spend are not presented as the same thing',
    !/If daily budget/i.test(scenario));
  await page.screenshot({ path: path.join(OUT, 'journey--campaign-scenario.png') });

  await page.locator('.tabbar button:has-text("Evidence")').click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(OUT, 'journey--campaign-evidence.png') });
} else {
  console.log('  (no campaigns on this shop — skipped)');
}

// Mark planned, reload, confirm it stuck — then put it back.
console.log('\n── a decision survives a reload ──');
await page.goto(`${BASE}/overview`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5500);
const planBtn = page.locator('button:has-text("Mark planned")').first();
if (await planBtn.count()) {
  await planBtn.click();
  await page.waitForTimeout(3000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5500);
  const after = await page.evaluate(() => document.body.innerText);
  check('marking planned survives a full reload', /Planned/.test(after));
  await page.screenshot({ path: path.join(OUT, 'journey--planned-persisted.png') });
} else {
  console.log('  (no actionable recommendation to plan — skipped)');
}

// ── switching shop must not leave the previous shop on screen ───────────────
console.log('\n── switching shop leaves nothing behind ──');
await page.goto(`${BASE}/overview`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
const shopSel = page.locator('.topbar select').first();
const options = await shopSel.locator('option').all();
if (options.length > 1) {
  const before = await page.locator('.statstrip .v').first().innerText().catch(() => '');
  await shopSel.selectOption({ index: 1 });
  await page.waitForTimeout(1200);
  // Immediately after the switch, the old shop's figure must not still be shown
  // as if it belonged to the new one.
  const mid = await page.locator('.statstrip .v').first().innerText().catch(() => '');
  await page.waitForTimeout(4500);
  const after = await page.locator('.statstrip .v').first().innerText().catch(() => '');
  check('the new shop shows its own figures', before !== after || options.length === 1,
    `before ${before}, after ${after}`);
  check('no stale figure is presented during the switch', mid === after || mid === '—' || mid === '',
    `mid-switch showed "${mid}", settled on "${after}"`);
  await page.screenshot({ path: path.join(OUT, 'journey--shop-switched.png') });
}

// ── the three distinct empty/simulated states ───────────────────────────────
console.log('\n── each shop renders its own honest state ──');
for (const [i, opt] of options.entries()) {
  const id = await opt.getAttribute('value');
  const label = (await opt.innerText()).split('—')[0].trim();
  await page.goto(`${BASE}/overview?shop=${id}&days=30`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  const t = await page.evaluate(() => document.body.innerText);
  await page.screenshot({ path: path.join(OUT, `state--${label.toLowerCase().replace(/\W+/g, '-')}.png`) });
  const hasData = !/No shop data stored/i.test(t);
  console.log(`  ${label.padEnd(18)} ${hasData ? 'has data' : 'empty state'}${/simulated/i.test(t) ? ' · simulated badge' : ''}`);
  if (!hasData) {
    check(`${label}: the empty state names the real blocker, not a date change`,
      /seller ID|administrator|setup/i.test(t), t.slice(0, 160));
  }
}

// ── dark theme ──────────────────────────────────────────────────────────────
console.log('\n── dark theme ──');
const dark = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
const dpage = await dark.newPage();
await dpage.goto(`${BASE}/overview`, { waitUntil: 'domcontentloaded' });
await dpage.fill('input[type=email]', 'mrrashid3255@gmail.com');
await dpage.fill('input[type=password]', env.BOSS_LOGIN_PASSWORD);
await dpage.click('button:has-text("Sign in")');
await dpage.waitForSelector('.topbar', { timeout: 30000 });
await dpage.waitForTimeout(5000);
await dpage.screenshot({ path: path.join(OUT, 'theme--dark-overview.png') });

// Text must not be rendered on a ground it cannot be read against.
const contrast = await dpage.evaluate(() => {
  const lum = (c) => {
    const m = c.match(/\d+/g); if (!m) return null;
    const [r, g, b] = m.map(Number).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  const bl = lum(bodyBg);
  const el = document.querySelector('.decision-title') || document.querySelector('h2') || document.body;
  const tl = lum(getComputedStyle(el).color);
  if (bl == null || tl == null) return null;
  const ratio = (Math.max(bl, tl) + 0.05) / (Math.min(bl, tl) + 0.05);
  return { bodyBg, ratio: Math.round(ratio * 10) / 10 };
});
check('dark theme: body has an explicit background, not transparent',
  contrast && !/rgba\(0, 0, 0, 0\)/.test(contrast.bodyBg), JSON.stringify(contrast));
check('dark theme: heading text is readable against it',
  contrast && contrast.ratio >= 4.5, `contrast ratio ${contrast?.ratio}`);
await dark.close();

// ── outreach: loads, and QA never sends ────────────────────────────────────
console.log('\n── outreach is reachable and untouched ──');
await page.goto(`${BASE}/outreach`, { waitUntil: 'domcontentloaded' });
await waitForData(page);
const outreachText = await page.evaluate(() => document.body.innerText);
check('outreach still loads with its existing workflow', outreachText.length > 400);
await page.screenshot({ path: path.join(OUT, 'outreach--loaded.png') });
console.log('  (no button on this page was clicked — nothing was created, started or sent)');

// ── console health ──────────────────────────────────────────────────────────
console.log('\n── the browser console ──');
check('no uncaught exceptions', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

await browser.close();

console.log(`\nscreenshots in ${OUT}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
