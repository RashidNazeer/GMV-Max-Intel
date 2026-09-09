// Two survey findings that would change what is true on screen, checked live.
//
// 1. `recommendations` reportedly has SELECT and UPDATE policies but NO INSERT
//    policy. persistRecommendation() is called on every Overview render and its
//    failure is swallowed by design ("a failed write must not blank the page").
//    If inserts are refused by RLS, the decision log has been silently empty and
//    every "Mark planned / Mark applied" has had nothing to attach to.
//
// 2. campaign_setting_snapshots reportedly holds ZERO rows, because the last
//    gmv_max sync ran before migration 016 created the table. If so, the budget
//    guardrail I gated on settings evidence this morning will report "no setting
//    on record" permanently — correct, but permanently.
//
// Read-only. Nothing is written to TikTok or Reacher.
import { createClient } from '@supabase/supabase-js';
import { env, need } from './_env.mjs';

need('VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'VITE_SUPABASE_ANON_KEY', 'BOSS_LOGIN_PASSWORD');

const svc = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const SHOP = 'b6931e3a-b55a-4bd6-bdf9-af1d8fc07589';

console.log('\n── 1. RLS policies on the decision tables ──');
let policies = null; let polErr = null;
try {
  const res = await svc.from('pg_policies').select('tablename, policyname, cmd')
    .in('tablename', ['recommendations', 'recommendation_events', 'campaign_setting_snapshots']);
  policies = res.data; polErr = res.error;
} catch (e) { polErr = { message: e.message }; }

if (policies) {
  for (const p of policies) console.log(`  ${p.tablename.padEnd(28)} ${String(p.cmd).padEnd(8)} ${p.policyname}`);
} else {
  console.log(`  (${polErr?.message || 'unavailable'}) — inferring from behaviour instead`);
}

console.log('\n── 2. what is actually STORED right now ──');
for (const t of ['recommendations', 'recommendation_events', 'campaign_setting_snapshots']) {
  const { count, error } = await svc.from(t).select('*', { count: 'exact', head: true }).eq('shop_id', SHOP);
  console.log(`  ${t.padEnd(28)} ${error ? 'ERROR ' + error.message : `${count} rows (Biostime)`}`);
}

const { data: recs } = await svc
  .from('recommendations')
  .select('action_code, status, fingerprint, window_start, window_end, generated_at, scope_type, scope_id')
  .eq('shop_id', SHOP).order('generated_at', { ascending: false }).limit(6);
if (recs?.length) {
  console.log('\n  most recent recommendations:');
  for (const r of recs) {
    console.log(`    ${String(r.action_code).padEnd(22)} ${String(r.status).padEnd(10)} `
      + `${r.window_start}..${r.window_end}  scope=${r.scope_type}/${r.scope_id ?? 'null'}`);
    console.log(`      fingerprint: ${r.fingerprint}`);
  }
} else {
  console.log('\n  NO RECOMMENDATIONS STORED AT ALL for this shop.');
}

console.log('\n── 3. can the REAL app role insert one? ──');
// The app writes as `authenticated`, not service_role. This is the question that
// matters: a swallowed failure looks identical to success from the browser.
const anon = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { data: auth, error: authErr } = await anon.auth.signInWithPassword({
  email: 'mrrashid3255@gmail.com', password: env.BOSS_LOGIN_PASSWORD,
});
if (authErr) {
  console.log(`  could not sign in: ${authErr.message}`);
} else {
  console.log(`  signed in as ${auth.user.email} (${auth.user.id.slice(0, 8)}…)`);
  // A SELECT proves the session reaches the table at all.
  const { count, error: selErr } = await anon
    .from('recommendations').select('*', { count: 'exact', head: true }).eq('shop_id', SHOP);
  console.log(`  SELECT as authenticated: ${selErr ? 'DENIED — ' + selErr.message : count + ' rows visible'}`);

  // An INSERT that is deliberately INVALID for a reason OTHER than permission,
  // so nothing is created either way. A 42501 means RLS refused; a 23xxx or 400
  // means RLS allowed the attempt and the DATA was rejected. That distinguishes
  // "no insert policy" from "insert works" without writing a row.
  const { error: insErr } = await anon.from('recommendations').insert({
    shop_id: SHOP,
    action_code: '__probe_invalid__',   // violates the 12-value CHECK on purpose
  });
  const code = insErr?.code || '(none)';
  console.log(`  INSERT as authenticated: ${insErr ? `${code} — ${insErr.message.slice(0, 110)}` : 'SUCCEEDED (unexpected)'}`);
  console.log(code === '42501'
    ? '\n  >>> CONFIRMED: RLS refuses INSERT for the app role. Every persist has been failing silently.'
    : code.startsWith('23') || code === 'PGRST204' || /check constraint|violates/i.test(insErr?.message || '')
      ? '\n  >>> RLS ALLOWS the insert; it was the invalid data that was rejected. Persistence works.'
      : '\n  >>> inconclusive — inspect the code above.');
  await anon.auth.signOut();
}

console.log('\n── 4. when did the settings sync last run? ──');
let runs = null;
try {
  const res = await svc.from('sync_runs').select('job, status, finished_at, rows_written')
    .eq('shop_id', SHOP).order('finished_at', { ascending: false }).limit(8);
  runs = res.data;
} catch (e) { console.log('  sync_runs: ' + e.message); }
for (const r of runs || []) {
  console.log(`  ${String(r.job).padEnd(22)} ${String(r.status).padEnd(10)} ${r.finished_at} rows=${r.rows_written}`);
}
