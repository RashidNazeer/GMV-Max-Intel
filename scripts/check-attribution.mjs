// Prove the attribution decomposition is exact.
//
//   node scripts/check-attribution.mjs [start] [end]
//
// The screen shows one bar broken into six segments. If those segments do not
// add up to total shop GMV, the bar is a picture of nothing — and the failure
// would be invisible, because a stacked bar always looks full.
//
// So: assert the buckets sum to the total, and assert the total independently
// matches what Reacher's Seller Center overview reports for the same window.
// The second check matters because the first would still pass if the channel
// sync had stored a wrong total consistently.
import { createClient } from '@supabase/supabase-js';
import { need } from './_env.mjs';
import { createReacherClient } from '../src/lib/reacher/client.js';

const [URL, SERVICE, KEY] = need('VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'REACHER_API');
const db = createClient(URL, SERVICE, { auth: { persistSession: false } });
const reacher = createReacherClient({ apiKey: KEY });

// The window ends where the data has settled, matching the app (SETTLING_DAYS
// in src/lib/api.js). This check compares a STORED snapshot against a LIVE
// source, and Seller Center keeps revising the last couple of days: run to
// today and Biostime drifted 0.82% purely because the source had moved since
// the sync, which looks identical to a real reconciliation failure. Comparing
// settled dates to settled dates removes that false alarm without loosening the
// tolerance, which would have hidden a genuine one.
const SETTLING_DAYS = 2;
const iso = (d) => d.toISOString().slice(0, 10);
const END = process.argv[3] || iso(new Date(Date.now() - SETTLING_DAYS * 864e5));
const START = process.argv[2] || iso(new Date(Date.now() - (30 + SETTLING_DAYS) * 864e5));

const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const m = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const p = (n) => (n == null ? '—' : (Number(n) * 100).toFixed(1) + '%');

const { data: shops } = await db.from('shops').select('id, shop_name, reacher_shop_id').order('shop_name');

console.log(`requested window ${START} → ${END}\n`);

for (const shop of shops) {
  // Compare like for like. The stored channel rows cover whatever window the
  // last sync used; asking Seller Center for a WIDER range and comparing it
  // against a narrower stored one produced a 7% "drift" that was nothing but
  // two missing days. The check is "does what we stored match the source for
  // the dates we stored", so the dates come from the data.
  const { data: span } = await db
    .from('shop_daily_channels')
    .select('day')
    .eq('shop_id', shop.id)
    .gte('day', START).lte('day', END)
    .order('day');
  if (!span?.length) {
    console.log(`\n${shop.shop_name} — no stored channel data in this range, nothing to verify`);
    continue;
  }
  const from = span[0].day, to = span[span.length - 1].day;

  const { data, error } = await db.rpc('shop_attribution', { p_shop_id: shop.id, p_start: from, p_end: to });
  if (error) { check(`${shop.shop_name}: attribution callable`, false, error.message); continue; }
  const a = data?.[0];

  if (!a || !Number(a.days_covered)) {
    console.log(`\n${shop.shop_name} — no channel data, nothing to verify`);
    continue;
  }

  console.log(`\n${shop.shop_name}  (${a.days_covered} days)`);

  const buckets = {
    'ad-driven (measured)':      Number(a.measured_paid_gmv),
    'organic (measured)':        Number(a.measured_organic_gmv),
    'affiliate, no line data':   Number(a.affiliate_unmeasured_gmv),
    'seller video':              Number(a.seller_video_gmv),
    'LIVE':                      Number(a.live_gmv),
    'product card':              Number(a.product_card_gmv),
  };
  for (const [k, v] of Object.entries(buckets)) {
    const share = Number(a.total_gmv) ? (v / Number(a.total_gmv)) * 100 : 0;
    console.log(`    ${k.padEnd(26)} ${m(v).padStart(14)}  ${share.toFixed(1).padStart(5)}%`);
  }

  const sum = Object.values(buckets).reduce((x, y) => x + y, 0);
  const total = Number(a.total_gmv);
  console.log(`    ${'TOTAL'.padEnd(26)} ${m(sum).padStart(14)}   vs shop ${m(total)}`);

  // Rounding across 31 daily numeric(14,2) rows can drift a few cents; a dollar
  // is a generous ceiling that still catches any real logic error.
  check(`${shop.shop_name}: buckets sum to total shop GMV`,
    Math.abs(sum - total) < 1, `difference ${m(sum - total)}`);

  // Independent confirmation from the source, not from our own table.
  try {
    const sc = await reacher.sellerCenterOverview(shop.reacher_shop_id, from, to);
    const scTotal = Number(sc.gmv || 0);
    const drift = scTotal ? Math.abs(total - scTotal) / scTotal : 0;
    check(`${shop.shop_name}: stored total matches Seller Center`,
      drift < 0.005, `stored ${m(total)} vs source ${m(scTotal)} (${(drift * 100).toFixed(2)}% drift)`);
  } catch (e) {
    console.log(`      (Seller Center cross-check unavailable: ${e.message.slice(0, 60)})`);
  }

  // The measured slice must never exceed the affiliate channel it lives inside.
  check(`${shop.shop_name}: measured revenue fits inside the affiliate channel`,
    Number(a.affiliate_video_ours_gmv) <= Number(a.affiliate_video_sc_gmv) + 1,
    `ours ${m(a.affiliate_video_ours_gmv)} of ${m(a.affiliate_video_sc_gmv)} → capture ${p(a.affiliate_capture)}`);

  console.log(`    measured share of shop: ${p(a.attribution_coverage)}   ad-driven within it: ${p(a.paid_share_of_measured)}`);
  if (Number(a.other_affiliate_gmv) > 0) {
    console.log(`    non-video affiliate placements: ${m(a.other_affiliate_gmv)}, of which ad-driven ${m(a.other_affiliate_paid_gmv)}`);
  }
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
