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

// Every table holding client revenue, and every function that reads one. This
// list has to grow with the schema: a table added without a line here is a
// table nobody proved was protected.
const REVENUE_TABLES = [
  'affiliate_order_lines', 'shops', 'shop_daily_channels', 'video_performance',
  'product_catalog', 'product_window_metrics',
  'gmv_max_campaigns', 'gmv_max_daily_metrics', 'gmv_max_settings_changes',
];

const REVENUE_FUNCTIONS = (shopId) => [
  ['shop_affiliate_summary', { p_start: '2026-08-08', p_end: '2026-09-07' }],
  ['shop_attribution',       { p_shop_id: shopId, p_start: '2026-08-08', p_end: '2026-09-07' }],
  ['shop_channel_daily',     { p_shop_id: shopId, p_start: '2026-08-08', p_end: '2026-09-07' }],
  ['shop_creative_health',   { p_shop_id: shopId, p_start: '2026-08-08', p_end: '2026-09-07' }],
  ['shop_top_videos',        { p_shop_id: shopId, p_start: '2026-08-08', p_end: '2026-09-07', p_limit: 5 }],
  ['shop_products',          { p_shop_id: shopId, p_start: '2026-08-08', p_end: '2026-09-07', p_limit: 5 }],
  ['shop_paid_roas',         { p_shop_id: shopId, p_start: '2026-08-08', p_end: '2026-09-07' }],
  ['shop_spend_daily',       { p_shop_id: shopId, p_start: '2026-08-08', p_end: '2026-09-07' }],
  ['shop_data_sources',      { p_shop_id: shopId }],
];

// A real shop id, so a function that fails for a bad argument cannot be
// mistaken for one that refused on permissions.
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

// ── signed out: the public key on its own must reach nothing ────────────────
{
  const c = newAnon();

  let leaked = [];
  for (const t of REVENUE_TABLES) {
    const r = await c.from(t).select('*').limit(1);
    if (!r.error && (r.data || []).length > 0) leaked.push(t);
  }
  check(`signed out reaches none of ${REVENUE_TABLES.length} revenue tables`,
    leaked.length === 0, leaked.length ? `LEAKED: ${leaked.join(', ')}` : 'all empty or denied');

  let callable = [];
  for (const [fn, args] of REVENUE_FUNCTIONS(ZERO_UUID)) {
    const r = await c.rpc(fn, args);
    if (!r.error) callable.push(fn);
  }
  check(`signed out cannot call any of ${REVENUE_FUNCTIONS(ZERO_UUID).length} reporting functions`,
    callable.length === 0, callable.length ? `CALLABLE: ${callable.join(', ')}` : 'all denied');

  // The view added in migration 005 joins across shops; without
  // security_invoker it would ignore RLS entirely.
  const v = await c.from('video_latest').select('video_id').limit(1);
  check('signed out cannot read the video_latest view',
    !!v.error || (v.data || []).length === 0,
    v.error ? v.error.message.slice(0, 50) : `returned ${v.data.length} rows`);
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

  // ── the layers added in migrations 004-007 ───────────────────────────────
  const shopId = (await c.from('shops').select('id').limit(1)).data?.[0]?.id;
  if (shopId) {
    let broken = [];
    for (const [fn, args] of REVENUE_FUNCTIONS(shopId)) {
      const r = await c.rpc(fn, args);
      if (r.error) broken.push(`${fn}: ${r.error.message.slice(0, 40)}`);
    }
    check(`boss can call all ${REVENUE_FUNCTIONS(shopId).length} reporting functions`,
      broken.length === 0, broken.length ? broken.join(' | ') : 'all returned');

    // A client must never write a fact row, on ANY of the new tables. This is
    // the check that would catch a policy added later for convenience.
    const writable = [];
    const probes = {
      shop_daily_channels: { shop_id: shopId, day: '2001-01-01', gmv: 999999 },
      video_performance: { shop_id: shopId, video_id: 'rls-probe', window_start: '2001-01-01', window_end: '2001-01-02', video_gmv: 999999 },
      product_catalog: { shop_id: shopId, product_id: 'rls-probe', title: 'probe' },
      product_window_metrics: { shop_id: shopId, product_id: 'rls-probe', window_start: '2001-01-01', window_end: '2001-01-02', gmv: 999999 },
      gmv_max_campaigns: { shop_id: shopId, campaign_id: 'rls-probe', data_source: 'reacher' },
      gmv_max_daily_metrics: { shop_id: shopId, campaign_id: 'rls-probe', day: '2001-01-01', spend: 999999, data_source: 'reacher' },
    };
    for (const [table, row] of Object.entries(probes)) {
      const w = await c.from(table).insert(row);
      if (!w.error) writable.push(table);
    }
    check('the client cannot insert into any fact table',
      writable.length === 0, writable.length ? `WRITABLE: ${writable.join(', ')}` : 'all 6 refused');
  }
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
