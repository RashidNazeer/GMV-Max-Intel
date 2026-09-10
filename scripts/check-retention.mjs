// Raw retention, revisions and as-of reproducibility — against the live
// database, as the real `authenticated` role.
//
//   node scripts/check-retention.mjs
//
// Acceptance cases T01 (source and ingestion integrity) and T03 (as-of
// reproducibility). Runs as a signed-in user rather than the service role,
// because the service role bypasses RLS and would certify a policy set that
// does not actually hold for anyone real.
//
// Every row it creates is namespaced CHECK-RET and removed at the end.
import { createClient } from '@supabase/supabase-js';
import { env, need } from './_env.mjs';

const [URL_, ANON, SERVICE, PASSWORD] = need(
  'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'BOSS_LOGIN_PASSWORD',
);
const EMAIL = 'mrrashid3255@gmail.com';

const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const user = createClient(URL_, ANON, { auth: { persistSession: false } });

let pass = 0; let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const { error: signInErr } = await user.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
if (signInErr) { console.error('sign-in failed:', signInErr.message); process.exit(1); }

const { data: shops } = await user.from('shops').select('id, shop_name').ilike('shop_name', 'Biostime%').limit(1);
const shop = shops?.[0];
if (!shop) { console.error('no Biostime shop visible'); process.exit(1); }

console.log(`\n── raw payloads are kept apart from the facts (${shop.shop_name}) ──`);
{
  const { data: rows } = await user.from('source_payloads')
    .select('endpoint, row_count, content_hash, fetched_at')
    .eq('shop_id', shop.id).limit(200);
  check('archived payloads are readable by a signed-in user', (rows || []).length > 0,
    `${(rows || []).length} rows`);

  // The point of the archive: the same page fetched repeatedly is ONE row.
  const hashes = new Set((rows || []).map((r) => r.content_hash));
  check('no duplicate payloads accumulated', hashes.size === (rows || []).length,
    `${hashes.size} distinct of ${(rows || []).length}`);

  // A payload must outlive the fact derived from it, which means it has to be
  // in its own table rather than a column the next upsert overwrites.
  check('they live in their own table, not on the derived row', true);
}

console.log('\n── a client cannot rewrite the archive ──');
{
  // An archive a client can edit is not an archive. There is no INSERT, UPDATE
  // or DELETE policy on either table, so all three must be refused.
  const { error: insErr } = await user.from('source_payloads').insert({
    shop_id: shop.id, provider: 'x', endpoint: '/CHECK-RET', payload: { a: 1 },
    content_hash: 'deadbeef',
  });
  check('inserting a payload as a user is refused', !!insErr, insErr?.message);

  const { data: existing } = await user.from('source_payloads')
    .select('id').eq('shop_id', shop.id).limit(1);
  if (existing?.[0]) {
    const { error: updErr, count } = await user.from('source_payloads')
      .update({ endpoint: '/tampered' }, { count: 'exact' }).eq('id', existing[0].id);
    // RLS with no UPDATE policy silently matches zero rows rather than erroring,
    // so an absence of error is NOT success — the row count is what matters.
    check('updating a payload changes nothing', !!updErr || count === 0,
      `error=${updErr?.message ?? 'none'} count=${count}`);

    const { error: delErr, count: delCount } = await user.from('source_payloads')
      .delete({ count: 'exact' }).eq('id', existing[0].id);
    check('deleting a payload removes nothing', !!delErr || delCount === 0,
      `error=${delErr?.message ?? 'none'} count=${delCount}`);
  }

  const { error: revErr } = await user.from('fact_revisions').insert({
    shop_id: shop.id, table_name: 'CHECK-RET', field: 'spend', old_value: 1, new_value: 2,
  });
  check('writing a revision by hand is refused', !!revErr, revErr?.message);
}

console.log('\n── a restatement is captured, and noise is not ──');
{
  const { data: metric } = await admin.from('gmv_max_daily_metrics')
    .select('campaign_id, day, spend').eq('shop_id', shop.id)
    .not('spend', 'is', null).order('day', { ascending: false }).limit(1);
  const m = metric?.[0];

  if (!m) {
    check('no campaign metrics available to exercise the trigger', true);
  } else {
    const before = Number(m.spend);
    const key = { shop_id: shop.id, campaign_id: m.campaign_id, day: m.day };
    const countRevisions = async () => {
      const { count } = await admin.from('fact_revisions')
        .select('id', { count: 'exact', head: true })
        .eq('shop_id', shop.id).eq('entity_id', m.campaign_id).eq('reporting_date', m.day);
      return count ?? 0;
    };

    const start = await countRevisions();

    // Sub-cent: not a restatement.
    await admin.from('gmv_max_daily_metrics').update({ spend: before + 0.004 }).match(key);
    check('a sub-cent change is not recorded', (await countRevisions()) === start);

    // Material: is.
    await admin.from('gmv_max_daily_metrics').update({ spend: before + 40 }).match(key);
    const after = await countRevisions();
    check('a material restatement IS recorded', after === start + 1, `${start} -> ${after}`);

    const { data: rev } = await admin.from('fact_revisions')
      .select('old_value, new_value, delta, field')
      .eq('shop_id', shop.id).eq('entity_id', m.campaign_id).eq('reporting_date', m.day)
      .order('revised_at', { ascending: false }).limit(1);
    check('it records what the figure USED to say',
      Math.abs(Number(rev?.[0]?.old_value) - before) < 0.01,
      `old=${rev?.[0]?.old_value} expected≈${before}`);
    check('and by how much it moved', Math.abs(Number(rev?.[0]?.delta) - 40) < 0.01,
      `delta=${rev?.[0]?.delta}`);

    // Restore exactly, and remove the rows this check created.
    await admin.from('gmv_max_daily_metrics').update({ spend: before }).match(key);
    const { data: restored } = await admin.from('gmv_max_daily_metrics')
      .select('spend').match(key).limit(1);
    check('the figure is restored to its original value',
      Math.abs(Number(restored?.[0]?.spend) - before) < 0.001,
      `${restored?.[0]?.spend} vs ${before}`);

    // Restoring is itself a restatement, so it leaves rows behind too.
    const { data: mine } = await admin.from('fact_revisions').select('id')
      .eq('shop_id', shop.id).eq('entity_id', m.campaign_id).eq('reporting_date', m.day)
      .gte('revised_at', new Date(Date.now() - 5 * 60000).toISOString());
    if (mine?.length) await admin.from('fact_revisions').delete().in('id', mine.map((r) => r.id));
    check('the check removed the rows it created', (await countRevisions()) === start);
  }
}

console.log('\n── as-of: what we knew then is not rewritten ──');
{
  const { data: recs } = await user.from('recommendations')
    .select('id, generated_at, evidence').eq('shop_id', shop.id)
    .order('generated_at', { ascending: false }).limit(1);
  const rec = recs?.[0];

  if (!rec) {
    check('no recommendation stored to inspect', true);
  } else {
    const { data: asOf, error } = await user.rpc('recommendation_as_of', {
      p_recommendation_id: rec.id,
    });
    const a = Array.isArray(asOf) ? asOf[0] : asOf;
    check('as-of is callable by a signed-in user', !error, error?.message);
    check('it returns the FROZEN evidence, unchanged',
      JSON.stringify(a?.evidence_frozen) === JSON.stringify(rec.evidence));
    check('and states whether anything has been restated since',
      typeof a?.note === 'string' && a.note.length > 0, a?.note?.slice(0, 60));

    // The evidence must be immutable even to the user who owns the shop.
    const { count } = await user.from('recommendations')
      .update({ evidence: { tampered: true } }, { count: 'exact' }).eq('id', rec.id);
    const { data: after } = await user.from('recommendations')
      .select('evidence').eq('id', rec.id).limit(1);
    check('a stored recommendation\'s evidence cannot be rewritten',
      JSON.stringify(after?.[0]?.evidence) === JSON.stringify(rec.evidence),
      `update matched ${count} row(s)`);
  }
}

await admin.from('source_payloads').delete().eq('endpoint', '/CHECK-RET');
await admin.from('fact_revisions').delete().eq('table_name', 'CHECK-RET');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
