// Do product thumbnails render, and how long does the page need? The gate used
// a fixed 4.5s sleep and reported "0 found" — which is either a real regression
// or a settle time that outgrew the sleep. Those need different fixes, so this
// measures rather than guesses.
import { chromium } from 'playwright';
import { env, need } from './_env.mjs';

const BASE = process.argv[2] || 'http://localhost:4318';
need('BOSS_LOGIN_PASSWORD');

const browser = await chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

await page.goto(`${BASE}/overview`, { waitUntil: 'domcontentloaded' });
await page.fill('input[type=email]', 'mrrashid3255@gmail.com');
await page.fill('input[type=password]', env.BOSS_LOGIN_PASSWORD);
await page.click('button:has-text("Sign in")');
await page.waitForSelector('.appheader', { timeout: 30000 });

console.log('\n── /products: thumbnails over time ──');
const t0 = Date.now();
await page.goto(`${BASE}/products`, { waitUntil: 'domcontentloaded' });

let firstThumb = null;
let skelGone = null;
for (let i = 0; i < 60; i++) {
  const [thumbs, skel, rows] = await Promise.all([
    page.locator('.thumb').count(),
    page.locator('.skel').count(),
    page.locator('table.data tbody tr').count(),
  ]);
  const ms = Date.now() - t0;
  if (skel === 0 && skelGone === null) skelGone = ms;
  if (thumbs > 0 && firstThumb === null) {
    firstThumb = ms;
    console.log(`  ${String(ms).padStart(6)}ms  thumbs ${thumbs}, rows ${rows}, skeletons ${skel}  <-- first thumbnail`);
  }
  if (i % 10 === 0) console.log(`  ${String(ms).padStart(6)}ms  thumbs ${thumbs}, rows ${rows}, skeletons ${skel}`);
  if (firstThumb !== null && skelGone !== null) break;
  await page.waitForTimeout(400);
}

console.log(`\n  skeletons gone at: ${skelGone ?? 'never'}ms`);
console.log(`  first thumbnail at: ${firstThumb ?? 'never'}ms`);
console.log(`  the gate slept a FIXED 4500ms before counting`);
console.log(firstThumb === null
  ? '\n  >>> REAL DEFECT: no thumbnail ever rendered.'
  : firstThumb > 4500
    ? `\n  >>> HARNESS DEFECT: thumbnails arrive at ${firstThumb}ms, after the 4500ms sleep.`
    : '\n  >>> thumbnails were present before the sleep expired — look elsewhere.');

await browser.close();
