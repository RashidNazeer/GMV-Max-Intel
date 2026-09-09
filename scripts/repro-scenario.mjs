// Reproduce the Issue 4 priority-one defect: clicking Scenario blanks the shell.
//
// The audit's exact steps: Biostime, days=7, campaign 1855416962446337, wait for
// Performance, click Scenario. Expected by the audit: the app shell and content
// disappear, leaving a blank background.
//
// This script does not guess at a cause. It captures the uncaught exception, the
// console, and what is left in the DOM, because a React render error unmounts the
// tree silently and the stack is the only evidence of WHY.
import { chromium } from 'playwright';
import { env, need } from './_env.mjs';

const BASE = process.argv[2] || 'http://localhost:4318';
const SHOP = 'b6931e3a-b55a-4bd6-bdf9-af1d8fc07589';   // Biostime
const CAMPAIGN = '1855416962446337';                    // Fruity Bites (All 4)
need('BOSS_LOGIN_PASSWORD');

const browser = await chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1363, height: 936 } })).newPage();

const errors = [];
const consoleErrors = [];
page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack || ''}`));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

const settle = async (ms = 25000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.locator('.skel').count() === 0) return;
    await page.waitForTimeout(400);
  }
};

console.log(`\n── signing in at ${BASE} ──`);
await page.goto(`${BASE}/overview`, { waitUntil: 'domcontentloaded' });
await page.fill('input[type=email]', 'mrrashid3255@gmail.com');
await page.fill('input[type=password]', env.BOSS_LOGIN_PASSWORD);
await page.click('button:has-text("Sign in")');
await page.waitForSelector('.appheader', { timeout: 30000 });

const url = `${BASE}/campaigns/${CAMPAIGN}?shop=${SHOP}&days=7`;
console.log(`\n── opening ${url} ──`);
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.appheader', { timeout: 30000 });
await settle();

const before = await page.evaluate(() => ({
  shell: !!document.querySelector('.appheader'),
  tabs: [...document.querySelectorAll('button')].map((b) => b.innerText.trim()).filter(Boolean).slice(0, 12),
  bodyLen: document.body.innerText.length,
}));
console.log(`  shell present: ${before.shell}, body ${before.bodyLen} chars`);
console.log(`  buttons: ${before.tabs.join(' | ')}`);

// ── the click under test ────────────────────────────────────────────────────
const tab = page.locator('button:has-text("Scenario")').first();
const found = await tab.count();
console.log(`\n── clicking Scenario (found ${found}) ──`);
if (!found) { console.log('  NO SCENARIO TAB FOUND — cannot reproduce'); await browser.close(); process.exit(2); }

await tab.click();
await page.waitForTimeout(4000);

const after = await page.evaluate(() => ({
  shell: !!document.querySelector('.appheader'),
  rootChildren: document.getElementById('root')?.children.length ?? -1,
  bodyLen: document.body.innerText.length,
  bodyHead: document.body.innerText.slice(0, 300),
}));

console.log(`\n── after the click ──`);
console.log(`  shell present:  ${after.shell}`);
console.log(`  #root children: ${after.rootChildren}`);
console.log(`  body text:      ${after.bodyLen} chars`);
console.log(`  body starts:    ${JSON.stringify(after.bodyHead.slice(0, 160))}`);

const blanked = !after.shell || after.rootChildren === 0 || after.bodyLen < 50;
console.log(`\n  >>> ${blanked ? 'REPRODUCED — the shell is gone' : 'NOT reproduced — the page survived'}`);

if (errors.length) {
  console.log(`\n── UNCAUGHT EXCEPTIONS (${errors.length}) ──`);
  for (const e of errors.slice(0, 3)) console.log(`\n${e.split('\n').slice(0, 12).join('\n')}`);
} else {
  console.log('\n  no uncaught exceptions captured');
}
if (consoleErrors.length) {
  console.log(`\n── console errors (${consoleErrors.length}) ──`);
  for (const e of consoleErrors.slice(0, 5)) console.log(`  ${e.slice(0, 300)}`);
}

await page.screenshot({ path: 'qa-screenshots/repro--scenario-blank.png' });
await browser.close();
process.exit(blanked ? 1 : 0);
