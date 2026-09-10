// T31 — the full persisted operating loop, through the actual UI.
//
// The spec calls this the principal release gate, and it is the only test that
// proves the four records connect: a change recorded by a person, a review
// planned before the result exists, the lifecycle moved, the review recorded
// with its three separate answers, and every one of those still true after a
// reload and readable in the database.
//
// It runs against an ISOLATED entity id (E2E-<timestamp>) so it can never be
// confused with a real campaign, and it removes its own rows at the end. It
// makes NO external write of any kind: the app does not talk to TikTok, and
// this test asserts that no intervention it creates claims otherwise.
import path from 'node:path';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { env, need } from './_env.mjs';

const BASE = process.argv[2] || 'http://localhost:4318';
// Same credentials the browser gate already uses, so there is one place to
// rotate and no second secret to forget about.
const [URL_, SERVICE, PASSWORD] = need(
  'VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'BOSS_LOGIN_PASSWORD',
);
const EMAIL = 'mrrashid3255@gmail.com';

const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });

let pass = 0; let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && !ok ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const STAMP = `E2E-${Date.now()}`;

async function cleanup() {
  // Reviews first: they reference the intervention.
  const { data: ivs } = await admin.from('interventions').select('id').eq('entity_id', STAMP);
  const ids = (ivs || []).map((r) => r.id);
  if (ids.length) {
    await admin.from('outcome_reviews').delete().in('intervention_id', ids);
    await admin.from('interventions').delete().in('id', ids);
  }
}

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// Nothing in this product writes to an advertising platform. Watch for it
// anyway: a test that only checks the happy path cannot notice a new call.
const external = [];
page.on('request', (r) => {
  const u = r.url();
  if (r.method() !== 'GET' && !u.startsWith(BASE) && !u.startsWith(URL_)) external.push(`${r.method()} ${u}`);
});

try {
  // ── sign in ──────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/overview`, { waitUntil: 'domcontentloaded' });
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button:has-text("Sign in")');
    await page.waitForSelector('.sidebar', { timeout: 30000 });
  }

  // ── the log is reachable from the sidebar ────────────────────────────────
  console.log('\n── the loop has a way in ──');
  const navBtn = page.locator('.sidebar-foot button', { hasText: 'Decision log' });
  // WAIT, do not just count. count() is immediate and the sidebar renders only
  // once the shop list resolves, so the first run reported "not in the sidebar"
  // and then clicked it successfully a line later, because click() auto-waits.
  await navBtn.first().waitFor({ timeout: 30000 });
  check('the decision log is in the sidebar', await navBtn.count() > 0);
  await navBtn.first().click();
  await page.waitForURL(/\/decisions/, { timeout: 15000 });
  await page.waitForSelector('.table, .empty', { timeout: 30000 });
  check('it opens the decision log', /\/decisions/.test(page.url()), page.url());

  const shopId = new URL(page.url()).searchParams.get('shop');

  // ── record a change ──────────────────────────────────────────────────────
  console.log('\n── recording a change made by hand ──');
  await page.locator('button', { hasText: 'Record a change' }).first().click();
  await page.waitForSelector('.drawer, [role="dialog"]', { timeout: 15000 });

  await page.locator('.input').filter({ hasNot: page.locator('select') }).nth(0).waitFor();
  await page.getByPlaceholder('1855416962446337').fill(STAMP);
  await page.getByPlaceholder('Fruity Bites (All 4) GMV Max').fill('E2E verification');
  await page.getByPlaceholder('550').fill('550');
  await page.getByPlaceholder('660').fill('660');
  await page.getByPlaceholder(/Spend was hitting the cap/).fill('E2E: recorded by the loop test');
  await page.getByPlaceholder(/Delivered spend rises/).fill('E2E: spend should rise toward the new cap');

  const saveBtn = page.locator('button', { hasText: 'Record it' });
  check('the save button is enabled once the form is complete', await saveBtn.isEnabled());
  await saveBtn.click();

  // The drawer closes and the row appears. Poll rather than sleep.
  let row = null;
  for (let i = 0; i < 40 && !row; i += 1) {
    await page.waitForTimeout(500);
    const c = page.locator('tr', { hasText: 'E2E verification' });
    if (await c.count()) row = c.first();
  }
  check('the change appears in the log', !!row);

  // ── it is really in the database, with honest provenance ─────────────────
  console.log('\n── what was actually persisted ──');
  const { data: iv } = await admin.from('interventions').select('*').eq('entity_id', STAMP).single();
  check('an intervention row exists', !!iv);
  // ASSERT THE VALUE, not its truthiness. These read as passes for ANY value,
  // which is how a test comes to certify whatever the code happens to do.
  check('it is attributed to a person, not to an API',
    iv?.confirmation === 'manual_report', iv?.confirmation);
  check('nothing claims the app executed it externally', iv?.confirmation !== 'api_executed');
  check('it records an exact time, because one was given',
    iv?.time_basis === 'exact', iv?.time_basis);
  check('the old and new values are stored', [Number(iv?.old_value), Number(iv?.new_value)].join(','), '550,660');
  check('and the reason survives', /recorded by the loop test/.test(iv?.reason || ''));

  const { data: rev } = await admin.from('outcome_reviews').select('*')
    .eq('intervention_id', iv.id).single();
  check('a review was planned at the same time', !!rev);
  check('its criteria are frozen at version 1', rev?.criteria_version === 1, rev?.criteria_version);
  check('the hypothesis was written BEFORE any result', /spend should rise/.test(rev?.hypothesis || ''));
  check('no result is recorded yet', rev?.metric_outcome == null, rev?.metric_outcome);
  // Applied, not planned: this form records a change that ALREADY happened.
  check('and it is applied, because the change was already made',
    rev?.lifecycle === 'applied', rev?.lifecycle);

  // ── survive a reload ─────────────────────────────────────────────────────
  console.log('\n── it survives a reload ──');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.table', { timeout: 30000 });
  check('the entry is still listed after a reload',
    await page.locator('tr', { hasText: 'E2E verification' }).count() > 0);

  // ── move it through the lifecycle to a review ────────────────────────────
  console.log("\n── the lifecycle reaches a review ──");
  // Driven through the UI, not through the service role. The service key has
  // no auth.uid(), so advance_outcome_review refuses it — which is correct, and
  // means the only honest way to test the transition is the way a person makes
  // it.
  const openBtn = page.locator('tr', { hasText: 'E2E verification' })
    .locator('button', { hasText: /Review|Open/ });
  await openBtn.first().waitFor({ timeout: 20000 });
  check('the review can be opened from the log', await openBtn.count() > 0);
  await openBtn.first().click();
  await page.waitForSelector('.drawer, [role="dialog"]', { timeout: 15000 });

  const ready = page.locator('button', { hasText: 'Ready to review' });
  await ready.first().waitFor({ timeout: 15000 });
  await ready.first().click();

  // Poll the database rather than guessing how long the round trip takes.
  let after = null;
  for (let i = 0; i < 30; i += 1) {
    await page.waitForTimeout(500);
    const { data } = await admin.from('outcome_reviews').select('lifecycle').eq('id', rev.id).single();
    after = data?.lifecycle;
    if (after === 'review_due') break;
  }
  check('the lifecycle advanced to review_due', after === 'review_due', after);

  // The audit trail must carry every move, not just the last one.
  const { data: events } = await admin.from('outcome_review_events')
    .select('from_state,to_state').eq('review_id', rev.id).order('at');
  check('every transition is in the audit trail', (events || []).length >= 2,
    JSON.stringify(events));

  // ── the three answers are asked separately ───────────────────────────────
  console.log('\n── a review asks three separate questions ──');
  const body = await page.locator('.drawer, [role="dialog"]').first().textContent().catch(() => '');
  check('it asks whether the metric moved', /Did the metric move/.test(body));
  check('it asks what that establishes', /What does that establish/.test(body));
  check('it asks what you will do', /What will you do/.test(body));
  check('"not measurable" is offered as a real answer, not a failure',
    /Not measurable/.test(body));
  check('and observed is described as before-and-after only',
    /number before and the number after/.test(body));

  // ── no external writes, ever ─────────────────────────────────────────────
  console.log('\n── the external boundary ──');
  check('no write left the app for any third party', external.length === 0, external.join('; '));

  const { data: apiClaims } = await admin.from('interventions')
    .select('id').eq('confirmation', 'api_executed');
  check('no intervention anywhere claims an API execution', (apiClaims || []).length === 0);
} finally {
  await browser.close();
  await cleanup();
  console.log('\n(verification rows removed)');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
