// Prove the access rules actually hold, using the same anon key the browser
// ships with. RLS policies are easy to write and easy to get wrong; the only
// convincing evidence is trying to read the data both ways.
//
//   node scripts/rls-check.mjs
import { createClient } from '@supabase/supabase-js';
import { env, need } from './_env.mjs';

need('VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY');
const EMAIL = process.argv[2] || 'mrrashid3255@gmail.com';
const tag = EMAIL === 'mrrashid3255@gmail.com'
  ? 'BOSS_LOGIN_PASSWORD'
  : `LOGIN_${EMAIL.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
const pw = env[tag];

const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const newAnon = () => createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

// ── signed out: the public key on its own must reach nothing ────────────────
{
  const c = newAnon();
  const r = await c.rpc('shop_affiliate_summary', { p_start: '2026-08-07', p_end: '2026-09-05' });
  check('signed out cannot call the summary function', !!r.error, (r.error?.message || `RETURNED ${r.data?.length} ROWS`).slice(0, 70));

  const rows = await c.from('affiliate_order_lines').select('id').limit(5);
  check('signed out cannot read order lines',
    !!rows.error || (rows.data || []).length === 0,
    rows.error ? rows.error.message.slice(0, 50) : `returned ${rows.data.length} rows`);

  const shops = await c.from('shops').select('id').limit(5);
  check('signed out cannot read shops',
    !!shops.error || (shops.data || []).length === 0,
    shops.error ? shops.error.message.slice(0, 50) : `returned ${shops.data.length} rows`);
}

// ── signed in as the Boss: everything, through the anon key + a session ─────
if (!pw) {
  console.log(`\nno stored password for ${EMAIL} (looked for ${tag} in .env.local) — run scripts/create-user.mjs first`);
  process.exit(1);
}
{
  const c = newAnon();
  const { error } = await c.auth.signInWithPassword({ email: EMAIL, password: pw });
  check('boss can sign in', !error, error?.message);

  const r = await c.rpc('shop_affiliate_summary', { p_start: '2026-08-07', p_end: '2026-09-05' });
  check('boss sees the summary', !r.error && r.data?.length > 0, r.error?.message || `${r.data?.length} shops`);
  for (const s of r.data || []) {
    const share = s.paid_share == null ? '—' : `${(Number(s.paid_share) * 100).toFixed(1)}%`;
    console.log(`        ${String(s.shop_name).padEnd(18)} ${String(s.lines).padStart(5)} lines   paid ${share}`);
  }

  const count = await c.from('affiliate_order_lines').select('id', { count: 'exact', head: true });
  check('boss sees order lines', (count.count || 0) > 0, `${count.count} rows`);

  // A client must never be able to write a revenue row, whoever they are.
  const w = await c.from('affiliate_order_lines').insert({
    shop_id: (await c.from('shops').select('id').limit(1)).data?.[0]?.id,
    order_id: 'rls-probe', sku_id: 'rls-probe', payment_amount: 999999,
  });
  const stillClean = (await c.from('affiliate_order_lines').select('id').eq('order_id', 'rls-probe')).data?.length === 0;
  check('even the boss cannot insert a revenue row from the client',
    !!w.error && stillClean, (w.error?.message || 'INSERT ACCEPTED').slice(0, 60));

  const up = await c.from('affiliate_order_lines').update({ payment_amount: 1 }).eq('order_id', 'rls-probe');
  check('client cannot update revenue rows', !!up.error || stillClean, (up.error?.message || 'no rows matched').slice(0, 50));

  // Self-promotion guard (migration 001).
  const prof = await c.from('profiles').update({ role: 'boss' }).eq('id', (await c.auth.getUser()).data.user.id);
  check('profile role guard exists', prof.error == null || /only the Boss/.test(prof.error.message),
    prof.error ? prof.error.message.slice(0, 50) : 'boss updating own role is allowed (expected)');
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
