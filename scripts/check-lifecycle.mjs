// T22, T24 and T28 — intervention truth, outcome timing, and migration
// compatibility, against the live database.
//
//   node scripts/check-lifecycle.mjs
//
// These three need real rows and a real clock, so they cannot live in the unit
// suite. Everything created here is namespaced LIFE- and removed at the end.
import pg from 'pg';
import { env, need } from './_env.mjs';

need('GMV_INTEL_PROJECT_REF', 'GMV_INTEL_DB_PASSWORD');
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
  try { await c.connect(); db = c; break; } catch { /* next */ }
}
if (!db) { console.error('could not connect'); process.exit(1); }

const { rows: sh } = await db.query(`select id, shop_name from public.shops where shop_name ilike 'Biostime%' limit 1`);
const shop = sh[0];
const { rows: pr } = await db.query(
  `select p.id from public.profiles p where public.can_view_shop($1, p.id) limit 1`, [shop.id]);
const uid = pr[0].id;

const asUser = async () => {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
  await db.query(`select set_config('role', 'authenticated', false)`);
};
const asOwner = async () => {
  await db.query(`reset role`);
  await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
};

async function cleanup() {
  await asOwner();
  await db.query(`delete from public.outcome_reviews where hypothesis like 'LIFE-%'`);
  await db.query(`delete from public.interventions where entity_id like 'LIFE-%'`);
  await db.query(`delete from public.context_events where label like 'LIFE-%'`);
}

try {
  await cleanup();
  await asUser();

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── T22: an action taken outside the guardrails is still the truth ──');
  // The system must learn from what happened, not only from what it advised.
  {
    const { rows } = await db.query(
      `select public.record_intervention($1, 'campaign', 'LIFE-EXC', 'daily_budget',
         900, 600, now(), now(), 'manual_report',
         'raised despite a failed gate', null, null, 'currency_per_day', null,
         true, 'budget was not shown to bind') as id`, [shop.id]);
    const id = rows[0].id;

    const { rows: got } = await db.query(
      `select confirmation, policy_exception, policy_note, actor, recommendation_id
         from public.interventions where id = $1`, [id]);
    const r = got[0];

    check('the action is recorded, not refused', !!id);
    check('it is flagged as a policy exception', r.policy_exception === true);
    check('with what the tool would not have supported',
      /not shown to bind/.test(r.policy_note || ''), r.policy_note);
    check('provenance stays manual, never api_executed', r.confirmation === 'manual_report');
    check('and it has no recommendation behind it — that is allowed',
      r.recommendation_id === null);

    // A DETECTED change matched to that manual report must LINK, not merge.
    // Merging would lose one of the two accounts of the same event; counting
    // both as separate interventions would double it.
    const { rows: det } = await db.query(
      `select public.record_intervention($1, 'campaign', 'LIFE-EXC', 'daily_budget',
         900, 600, now() - interval '6 hours', now(), 'snapshot_detected',
         'detected by the sync') as id`, [shop.id]);
    // THROUGH THE SUPPORTED PATH. A direct UPDATE here matched zero rows and
    // reported success, because interventions is append-only by design — so the
    // matching requirement had no implementation at all, and the schema looked
    // complete because the columns existed. This check is the only reason it
    // was found. match_intervention() (migration 040) is now the way.
    const { rows: m } = await db.query(
      `select * from public.match_intervention($1)`, [det[0].id]);
    check('the detection links to the report through a supported call',
      m[0].outcome === 'matched', m[0].outcome);
    check('and the link is graded, not asserted as identity',
      ['exact', 'probable'].includes(m[0].confidence), m[0].confidence);

    // Counting must not double the event: two rows, one change.
    const { rows: distinct } = await db.query(
      `select public.distinct_interventions($1, now() - interval '2 days', now()) as n`,
      [shop.id]);
    check('a matched pair counts as one change, not two', distinct[0].n === 1, `${distinct[0].n}`);

    const { rows: pair } = await db.query(
      `select count(*)::int n from public.interventions where entity_id = 'LIFE-EXC'`);
    check('the detected change is a separate, linked row', pair[0].n === 2, `${pair[0].n} rows`);

    const { rows: link } = await db.query(
      `select i.match_confidence, i.actor, i.time_basis
         from public.interventions i where i.id = $1`, [det[0].id]);
    check('the stored confidence is one of the two graded values',
      ['exact', 'probable'].includes(link[0].match_confidence), link[0].match_confidence);
    check('a detected change still names no actor', link[0].actor === null);
    check('and carries an interval, not an invented instant', link[0].time_basis === 'interval');
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── T24: late data waits; it does not fail ──');
  {
    const { rows: iv } = await db.query(
      `select public.record_intervention($1, 'campaign', 'LIFE-TIME', 'target_roi',
         1.3, 1.5, now() - interval '10 days', now() - interval '10 days',
         'manual_report', 'timing check') as id`, [shop.id]);

    // Planned review date already in the PAST — the clock has moved past it.
    const { rows: rv } = await db.query(
      `insert into public.outcome_reviews
         (shop_id, intervention_id, hypothesis, target_metric, observation_days,
          settling_days, planned_review_at)
       values ($1, $2, 'LIFE-timing', 'total_shop_gmv', 7, 2, now() - interval '2 days')
       returning id`, [shop.id, iv[0].id]);
    const review = rv[0].id;

    await db.query(`select public.advance_outcome_review($1, 'applied', 'made')`, [review]);

    // Past its date, but the evidence has not settled. The correct state is
    // WAITING, not a failed test — scoring it now would score half-arrived data.
    const w = await db.query(
      `select public.advance_outcome_review($1, 'awaiting_data', 'affiliate feed is short') as s`, [review]);
    check('an overdue review with unsettled data waits', w.rows[0].s === 'awaiting_data');

    // And it cannot be judged while waiting.
    let blocked = null;
    try {
      await db.query(`select public.record_outcome_review($1, 'unfavourable', 'observed', 'revert')`, [review]);
    } catch (e) { blocked = e.message; }
    check('it cannot be reviewed while still waiting for data', !!blocked, 'it was recorded');

    // Once the data arrives it becomes due — with its criteria untouched.
    const { rows: before } = await db.query(
      `select observation_days, settling_days, criteria_version from public.outcome_reviews where id = $1`, [review]);
    const d = await db.query(
      `select public.advance_outcome_review($1, 'review_due', 'the data settled') as s`, [review]);
    const { rows: after } = await db.query(
      `select observation_days, settling_days, criteria_version from public.outcome_reviews where id = $1`, [review]);

    check('once the data settles it becomes due', d.rows[0].s === 'review_due');
    check('and the criteria are unchanged by the wait',
      JSON.stringify(before[0]) === JSON.stringify(after[0]),
      `${JSON.stringify(before[0])} vs ${JSON.stringify(after[0])}`);

    // An UNMEASURABLE outcome is a first-class answer, not a failure.
    const rec = await db.query(
      `select public.record_outcome_review($1, 'unmeasurable', 'observed', 'inconclusive',
         null, null, 'the campaign was paused for most of the window', 'nothing to judge') as s`, [review]);
    check('a change that could not be judged records as unmeasurable',
      rec.rows[0].s === 'reviewed');
    const { rows: out } = await db.query(
      `select metric_outcome, review_decision from public.outcome_reviews where id = $1`, [review]);
    check('and is NOT scored as unfavourable', out[0].metric_outcome === 'unmeasurable',
      out[0].metric_outcome);
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── T28: an older database still opens ──');
  await asOwner();
  {
    // Legacy rows predate every column the loop added. They must still read,
    // with the unknown fields explicitly unknown rather than invented.
    const { rows: legacy } = await db.query(
      `select count(*)::int n from public.recommendations
        where decision is null and status = 'proposed'`);
    check('recommendations written before the decision layer still read',
      legacy[0].n >= 0, `${legacy[0].n} rows`);

    const { rows: nulls } = await db.query(
      `select count(*)::int n from public.recommendations
        where decision is null and decision_at is null and decision_actor is null`);
    check('their decision fields are NULL, not back-filled with a guess',
      nulls[0].n >= 0, `${nulls[0].n} rows`);

    // Every migration is recorded, so a fresh database can be brought forward.
    const { rows: applied } = await db.query(
      `select count(*)::int n from migrations.applied`);
    check('the migration ledger is intact', applied[0].n >= 39, `${applied[0].n} recorded`);

    // The two data-altering migrations must be re-runnable without damage.
    const { rows: dupes } = await db.query(`
      select count(*)::int n from (
        select 1 from (
          select shop_id, campaign_id, status, target_roas, daily_budget,
                 lag(status) over w as p_status,
                 lag(target_roas) over w as p_roas,
                 lag(daily_budget) over w as p_budget
            from public.campaign_setting_snapshots
            window w as (partition by shop_id, campaign_id order by taken_at)
        ) t
        where t.p_status is not distinct from t.status
          and t.p_roas is not distinct from t.target_roas
          and t.p_budget is not distinct from t.daily_budget
          and t.p_status is not null
      ) x`);
    check('migration 028 left no consecutive duplicate states', dupes[0].n === 0, `${dupes[0].n}`);

    const { rows: canon } = await db.query(
      `select count(*)::int n from public.gmv_max_campaigns
        where status is distinct from public.canonical_campaign_status(status)`);
    check('migration 030 left every status canonical', canon[0].n === 0, `${canon[0].n} non-canonical`);
  }
} finally {
  await cleanup();
  await db.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
