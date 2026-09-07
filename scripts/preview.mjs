// Print what each screen will actually say, from the real database.
//
//   node scripts/preview.mjs [days]
//
// This exists because a build passing only proves the code parses. The likely
// failure is subtler: a SQL column named one thing and read as another, so a
// rule silently never fires and the panel is confidently empty. Running the
// real rules over real rows is the only way to catch that without a browser.
//
// It signs in as the Boss through the anon key — the same path the app takes —
// so RLS is exercised too, not bypassed with the service role.
import { createClient } from '@supabase/supabase-js';
import { env, need } from './_env.mjs';
import { recommend, whatsWorking } from '../src/lib/recommend.js';

const [URL, ANON] = need('VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY');
const days = Number(process.argv[2] || 30);
const iso = (d) => d.toISOString().slice(0, 10);
const END = iso(new Date());
const START = iso(new Date(Date.now() - days * 864e5));

const db = createClient(URL, ANON, { auth: { persistSession: false } });
const { error: authErr } = await db.auth.signInWithPassword({
  email: 'mrrashid3255@gmail.com', password: env.BOSS_LOGIN_PASSWORD,
});
if (authErr) { console.error('sign-in failed:', authErr.message); process.exit(1); }

const one = (r) => (Array.isArray(r) ? r[0] ?? null : r ?? null);

// Retry transient network failures. Without this the script reports "FAILED"
// for a dropped connection, which reads exactly like a broken function — and
// this run is supposed to be the thing that tells those two apart. A check that
// cannot distinguish its own flakiness from a real fault is not a check.
const call = async (fn, args, attempts = 3) => {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const { data, error } = await db.rpc(fn, args);
      if (!error) return data;
      last = error;
      // A SQL error will not fix itself; only retry transport-level trouble.
      if (!/fetch failed|network|ECONN|timeout/i.test(error.message)) break;
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 400 * 2 ** i));
  }
  throw new Error(`${fn}: ${last?.message ?? 'unknown error'}`);
};

const m = (v, c = 'USD') => (v == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(v));
const p = (v, d = 1) => (v == null ? '—' : `${(Number(v) * 100).toFixed(d)}%`);

const { data: shops } = await db.rpc('shop_affiliate_summary', { p_start: START, p_end: END });

let problems = 0;

for (const s of shops || []) {
  const id = s.shop_id, cur = s.currency || 'USD';
  console.log(`\n${'='.repeat(74)}\n${s.shop_name}   ${START} → ${END}\n${'='.repeat(74)}`);

  let a, creative, videos, products, roas;
  try {
    [a, creative, videos, products, roas] = await Promise.all([
      call('shop_attribution',     { p_shop_id: id, p_start: START, p_end: END }).then(one),
      call('shop_creative_health', { p_shop_id: id, p_start: START, p_end: END }).then(one),
      call('shop_top_videos',      { p_shop_id: id, p_start: START, p_end: END, p_limit: 100 }),
      call('shop_products',        { p_shop_id: id, p_start: START, p_end: END, p_limit: 50 }),
      call('shop_paid_roas',       { p_shop_id: id, p_start: START, p_end: END }).then(one),
    ]);
  } catch (e) { console.log(`  FAILED — ${e.message}`); problems++; continue; }

  if (!a || !Number(a.days_covered)) { console.log('  no channel data for this window'); continue; }

  // ── OVERVIEW ──────────────────────────────────────────────────────────────
  console.log(`\nOVERVIEW`);
  console.log(`  headline: Of the ${p(a.attribution_coverage, 0)} we can attribute, ` +
    `${p(a.paid_share_of_measured == null ? null : 1 - Number(a.paid_share_of_measured))} would have happened without your ads.`);
  const total = Number(a.total_gmv);
  for (const [label, v] of [
    ['ad-driven (measured)', a.measured_paid_gmv], ['organic (measured)', a.measured_organic_gmv],
    ['affiliate, no line data', a.affiliate_unmeasured_gmv], ['seller video', a.seller_video_gmv],
    ['LIVE', a.live_gmv], ['product card', a.product_card_gmv],
  ]) console.log(`    ${label.padEnd(26)} ${m(v, cur).padStart(10)}  ${((Number(v) / total) * 100).toFixed(1).padStart(5)}%`);

  if (roas) {
    console.log(`  ROAS card: real return is between ${Number(roas.verified_roas).toFixed(2)} (proven) ` +
      `and ${Number(roas.reported_roi).toFixed(2)} (claimed) — ` +
      `${p(roas.unverified_share, 0)} of the claim unevidenced  [${roas.data_source}]`);
  } else {
    console.log(`  ROAS card: absent — no campaigns, so nothing to divide by`);
  }

  // ── CREATIVE ──────────────────────────────────────────────────────────────
  console.log(`\nCREATIVE`);
  console.log(`  ${creative.video_count} videos, ${creative.creators} creators, ${m(creative.gmv, cur)}`);
  console.log(`  top1 ${p(creative.top1_share)} · top5 ${p(creative.top5_share)} · top10 ${p(creative.top10_share)}`);
  console.log(`  fading ${creative.fatigued_videos} (${m(creative.fatigued_gmv, cur)}) · ` +
    `rising ${creative.rising_videos} (${m(creative.rising_gmv, cur)}) · new this week ${creative.new_videos}`);
  console.log(`  posting dates known for ${p(creative.freshness_coverage)} of revenue`);

  const topV = videos[0];
  if (topV) console.log(`  top video: ${(topV.title || topV.video_id).slice(0, 46)} — ${m(topV.gmv, cur)}, ${p(topV.paid_share)} ad-driven`);

  // ── PRODUCTS ──────────────────────────────────────────────────────────────
  console.log(`\nPRODUCTS`);
  console.log(`  ${products.length} products with data`);
  for (const pr of products.slice(0, 3)) {
    console.log(`    ${(pr.title || pr.product_id).slice(0, 38).padEnd(38)} ${m(pr.gmv, cur).padStart(9)}  ` +
      `click→order ${p(pr.click_to_order_rate, 2).padStart(6)}  refunds ${p(pr.refund_rate, 1).padStart(6)}  ad ${p(pr.paid_share, 0).padStart(5)}`);
  }
  const noDiscount = products.every((x) => x.discount_pct == null);
  console.log(`  discount depth: ${noDiscount ? 'UNAVAILABLE (source returns null) — page says so' : 'available'}`);

  // ── DECISIONS — the real rules, over the real rows ─────────────────────────
  const recs = recommend({
    shop: { shop_name: s.shop_name, currency: cur, affiliate_connected: s.affiliate_connected },
    days, attribution: a, creative, videos, products, roas,
  });
  console.log(`\nWHAT TO DO NEXT  (${recs.length} finding${recs.length === 1 ? '' : 's'})`);
  for (const r of recs) {
    console.log(`\n  [${r.severity.toUpperCase()}] ${r.title}   <${r.basis}>`);
    console.log(`     ${r.finding}`);
    console.log(`     DO: ${r.action}`);
    for (const e of r.evidence || []) console.log(`       · ${e}`);
  }

  const wins = whatsWorking({
    shop: { shop_name: s.shop_name, currency: cur, affiliate_connected: s.affiliate_connected },
    days, attribution: a, creative, videos, products, roas,
  });
  console.log(`
WHAT IS WORKING  (${wins.length})`);
  for (const r of wins) {
    console.log(`
  [OK] ${r.title}   <${r.basis}>`);
    console.log(`     ${r.finding}`);
    for (const e of r.evidence || []) console.log(`       · ${e}`);
  }

  // The failure this script exists to catch: rules that cannot fire because a
  // column they read does not exist under that name.
  const undef = [];
  for (const [k, v] of Object.entries(a)) if (v === undefined) undef.push(`attribution.${k}`);
  for (const [k, v] of Object.entries(creative)) if (v === undefined) undef.push(`creative.${k}`);
  if (undef.length) { console.log(`\n  WARNING undefined columns: ${undef.join(', ')}`); problems++; }
}

console.log(problems ? `\n${problems} problem(s) found` : '\npreview complete — no shape mismatches');
process.exit(problems ? 1 : 0);
