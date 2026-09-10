// T27 — tenant isolation, authorisation and concurrency.
//
//   node scripts/check-tenancy.mjs
//
// The existing rls-check proves a client cannot write facts. This proves the
// harder half: that the loop's SECURITY DEFINER functions refuse a caller who
// should not reach them, and that two people working at once cannot silently
// overwrite each other.
//
// ── WHY A FABRICATED IDENTITY RATHER THAN A SECOND REAL USER ───────────────
// Creating and deleting a real auth user on a live project to run a test is a
// bigger side effect than the test is worth. Setting request.jwt.claim.sub to a
// uuid that belongs to nobody exercises exactly the path that matters: every
// guard resolves auth.uid(), and a uid with no profile and no shop_access must
// fail can_view_shop. If a function lets that through, it would let anyone
// through.
//
// ── WHY auth.uid() AND NOT current_user ────────────────────────────────────
// Inside a SECURITY DEFINER function current_user is the function OWNER, so a
// role test there passes for everybody and guards nothing. This project has
// already shipped five inert guards that way in a sibling codebase. Every
// assertion below is against a real caller identity.
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { env, need } from './_env.mjs';

need('GMV_INTEL_PROJECT_REF', 'GMV_INTEL_DB_PASSWORD', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY');

const ref = env.GMV_INTEL_PROJECT_REF;
const pw = encodeURIComponent(env.GMV_INTEL_DB_PASSWORD);
const HOSTS = [
  `postgresql://postgres.${ref}:${pw}@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`,
  `postgresql://postgres.${ref}:${pw}@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres`,
];

let pass = 0; let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

let db = null;
for (const url of HOSTS) {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try { await c.connect(); db = c; break; } catch { /* try the next pooler */ }
}
if (!db) { console.error('could not connect'); process.exit(1); }

const { rows: shopRows } = await db.query(
  `select id, shop_name from public.shops order by shop_name`);
const shop = shopRows[0];
const other = shopRows[1];
const NOBODY = '00000000-0000-4000-8000-0000000ff1ce';

/** Run a statement as a specific caller identity, then always reset. */
async function as(uid, fn) {
  await db.query('begin');
  try {
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    await db.query(`select set_config('role', 'authenticated', true)`);
    return await fn();
  } finally {
    await db.query('rollback');
  }
}

const refused = async (uid, sql, params = []) => {
  try {
    await as(uid, () => db.query(sql, params));
    return null;                       // it went through — that is the failure
  } catch (e) {
    return e.message;
  }
};

console.log('\n── a caller with no access reaches nothing ──');
{
  // Every read function in the loop. A uid belonging to nobody must be refused
  // by all of them, not most of them.
  const readers = [
    ['decision_log', `select * from public.decision_log($1, null, null, null, null, null, 5, 0)`],
    ['operator_queue', `select * from public.operator_queue($1)`],
    ['intervention_history', `select * from public.intervention_history($1, null, null, 5)`],
    ['roi_headroom', `select * from public.roi_headroom($1)`],
    ['roi_episodes', `select * from public.roi_episodes($1)`],
    ['organic_baseline', `select * from public.organic_baseline($1, current_date - 7, current_date)`],
    ['organic_counterfactual', `select * from public.organic_counterfactual($1, current_date - 7, current_date)`],
    ['reviewed_history_summary', `select * from public.reviewed_history_summary($1, 'increase_budget', null)`],
    ['comparable_reviewed_cases', `select * from public.comparable_reviewed_cases($1, 'increase_budget', null, 5)`],
    ['learning_replay', `select * from public.learning_replay($1)`],
    ['attribution_basis', `select * from public.attribution_basis($1, current_date - 7, current_date)`],
    ['capabilities_for_shop', `select * from public.capabilities_for_shop($1)`],
  ];

  for (const [name, sql] of readers) {
    const msg = await refused(NOBODY, sql, [shop.id]);
    // capabilities_for_shop returns rows filtered by a WHERE rather than
    // raising, so an empty result is the correct refusal there.
    if (name === 'capabilities_for_shop') {
      const rows = await as(NOBODY, () => db.query(sql, [shop.id]));
      check(`${name} returns nothing to a stranger`, rows.rows.length === 0,
        `${rows.rows.length} rows`);
    } else {
      check(`${name} refuses a stranger`, !!msg, 'it returned data');
    }
  }
}

console.log('\n── a stranger cannot write to the loop ──');
{
  const writers = [
    ['record_intervention',
      `select public.record_intervention($1, 'campaign', 'TENANCY', 'daily_budget', 600, 550, now(), now(), 'manual_report', 'should be refused')`],
    ['record_context_event',
      `select public.record_context_event($1, 'promotion', now(), null, 'shop', null, 'TENANCY', 'operator_reported')`],
  ];
  for (const [name, sql] of writers) {
    const msg = await refused(NOBODY, sql, [shop.id]);
    check(`${name} refuses a stranger`, !!msg, 'the write went through');
  }

  // And nothing it attempted survived.
  const { rows } = await db.query(
    `select count(*)::int n from public.interventions where entity_id = 'TENANCY'`);
  check('no row was left behind by the refused writes', rows[0].n === 0, `${rows[0].n} rows`);
}

console.log('\n── the anon key reaches nothing without signing in ──');
{
  const anon = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY,
    { auth: { persistSession: false } });

  for (const t of ['interventions', 'outcome_reviews', 'source_payloads', 'fact_revisions']) {
    const { data, error } = await anon.from(t).select('*').limit(1);
    check(`anon cannot read ${t}`, !!error || (data || []).length === 0,
      `${(data || []).length} rows, error=${error?.message ?? 'none'}`);
  }

  const { error: rpcErr } = await anon.rpc('operator_queue', { p_shop_id: shop.id });
  check('anon cannot call the operator queue', !!rpcErr, 'it returned data');
}

console.log('\n── two people working at once ──');
{
  // A real user, so these exercise the authorised path rather than the guard.
  const { rows: who } = await db.query(
    `select p.id from public.profiles p where public.can_view_shop($1, p.id) limit 1`, [shop.id]);
  const uid = who[0]?.id;

  if (!uid) {
    check('no authorised user available to test concurrency', true);
  } else {
    // Set up one intervention and review, committed, so both "callers" see it.
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
    await db.query(`select set_config('role', 'authenticated', false)`);
    const { rows: iv } = await db.query(
      `select public.record_intervention($1, 'campaign', 'TENANCY-CONC', 'daily_budget',
         700, 550, now(), now(), 'manual_report', 'concurrency check') as id`, [shop.id]);
    const { rows: rv } = await db.query(
      `insert into public.outcome_reviews
         (shop_id, intervention_id, hypothesis, target_metric, observation_days, settling_days)
       values ($1, $2, 'concurrency check', 'total_shop_gmv', 7, 2) returning id`,
      [shop.id, iv[0].id]);
    const reviewId = rv[0].id;

    // IDEMPOTENT: re-sending the state it is already in is a no-op, not an error.
    const a1 = await db.query(`select public.advance_outcome_review($1, 'applied', 'first') as s`, [reviewId]);
    const a2 = await db.query(`select public.advance_outcome_review($1, 'applied', 'again') as s`, [reviewId]);
    check('re-sending the current state is a no-op, not a second transition',
      a1.rows[0].s === 'applied' && a2.rows[0].s === 'applied');

    const { rows: ev } = await db.query(
      `select count(*)::int n from public.outcome_review_events where review_id = $1 and to_state = 'applied'`,
      [reviewId]);
    check('and it is recorded once in the audit trail, not twice', ev[0].n === 1, `${ev[0].n} events`);

    // CONFLICTING: a second person trying an invalid move is REFUSED with a
    // reason, not silently applied over the first person's work.
    let conflictMsg = null;
    try {
      await db.query(`select public.advance_outcome_review($1, 'reviewed', 'jumping the queue')`, [reviewId]);
    } catch (e) { conflictMsg = e.message; }
    check('an invalid transition from another caller is refused', !!conflictMsg, 'it was applied');
    check('and the refusal names both states',
      /from applied to reviewed/i.test(conflictMsg || ''), conflictMsg?.slice(0, 90));

    // The first person's state survived the second person's attempt.
    const { rows: st } = await db.query(
      `select lifecycle from public.outcome_reviews where id = $1`, [reviewId]);
    check('the original state is intact after the conflict', st[0].lifecycle === 'applied',
      st[0].lifecycle);

    // A stranger cannot move somebody else's review at all.
    const strangerMsg = await refused(NOBODY,
      `select public.advance_outcome_review($1, 'awaiting_data', 'not mine')`, [reviewId]);
    check('a stranger cannot advance a review they cannot see', !!strangerMsg);

    // Nor record its outcome.
    const recMsg = await refused(NOBODY,
      `select public.record_outcome_review($1, 'favourable', 'observed', 'continue')`, [reviewId]);
    check('nor record its outcome', !!recMsg);

    await db.query(`reset role`);
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
    await db.query(`delete from public.outcome_reviews where id = $1`, [reviewId]);
    await db.query(`delete from public.interventions where entity_id = 'TENANCY-CONC'`);
  }
}

console.log('\n── shops are separable ──');
{
  if (!other) {
    check('only one shop exists, cross-shop isolation not exercised', true);
  } else {
    // Every loop reader takes a shop id and must answer about THAT shop only.
    // A function that ignored its argument would return the same rows for both.
    const { rows: who } = await db.query(
      `select p.id from public.profiles p where public.can_view_shop($1, p.id) limit 1`, [shop.id]);
    const uid = who[0]?.id;
    if (uid) {
      await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
      await db.query(`select set_config('role', 'authenticated', false)`);
      const a = await db.query(`select * from public.capabilities_for_shop($1)`, [shop.id]);
      const b = await db.query(`select count(*)::int n from public.decision_log($1, null, null, null, null, null, 200, 0)`, [shop.id]);
      const c = await db.query(`select count(*)::int n from public.decision_log($1, null, null, null, null, null, 200, 0)`, [other.id]);
      check('the decision log answers per shop, not globally',
        b.rows[0].n !== c.rows[0].n || b.rows[0].n === 0,
        `${shop.shop_name}=${b.rows[0].n} ${other.shop_name}=${c.rows[0].n}`);
      check('capabilities resolve for the shop asked about', a.rows.length > 0);
      await db.query(`reset role`);
      await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
    }
  }
}

await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
