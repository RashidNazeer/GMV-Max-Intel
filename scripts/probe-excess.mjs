// Is the affiliate excess counted twice? Issue 4's priority-two claim, tested.
//
// The audit's arithmetic on Biostime 2026-09-01 → 09-07:
//   ad-driven 808.43 + organic 681.78 + no-line-data 67.96 + excess 70.34
//     + seller video 592.42 + LIVE 0 + product card 389.59 = 2,610.52
//   source shop GMV 2,469.84 → displayed gap 140.68 = EXACTLY 2 x 70.34
//
// The hypothesis is that `overflow` (what we hold beyond what Seller Center
// reports for affiliate video) is already inside paid+organic, and is then
// added AGAIN as its own revenue band. This script does not take the screen's
// word for it — it recomputes from the daily records and prints both identities
// per day, so the answer comes from the data.
import { createClient } from '@supabase/supabase-js';
import { env, need } from './_env.mjs';

need('VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
const db = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const SHOP = process.argv[2] || 'b6931e3a-b55a-4bd6-bdf9-af1d8fc07589';  // Biostime
const START = process.argv[3] || '2026-09-01';
const END = process.argv[4] || '2026-09-07';
const n = (v) => Number(v) || 0;
const f = (v, w = 10) => n(v).toFixed(2).padStart(w);

const { data: days, error } = await db.rpc('shop_channel_daily', {
  p_shop_id: SHOP, p_start: START, p_end: END,
});
if (error) { console.error(error.message); process.exit(1); }

console.log(`\n── daily records, ${START} → ${END} ──\n`);
console.log('day           source     ours    aff_sc   unmeas  overflow   CURRENT-gap  WITHOUT-excess');
console.log('─'.repeat(94));

let t = {
  src: 0, paid: 0, org: 0, unmeas: 0, over: 0, seller: 0, live: 0, pcard: 0,
  cur: 0, fixed: 0, absCur: 0, absFixed: 0,
};

for (const d of days || []) {
  const paid = n(d.measured_paid_gmv), org = n(d.measured_organic_gmv);
  const unmeas = n(d.affiliate_unmeasured_gmv), over = n(d.affiliate_overflow_gmv);
  const seller = n(d.seller_video_gmv), live = n(d.live_gmv), pcard = n(d.product_card_gmv);
  const src = n(d.total_gmv);

  // What the function does today: excess added as its own positive band.
  const current = (paid + org + unmeas + over + seller + live + pcard) - src;
  // The proposed identity: excess is a DIAGNOSTIC, already inside paid+organic.
  const without = (paid + org + unmeas + seller + live + pcard) - src;

  t.src += src; t.paid += paid; t.org += org; t.unmeas += unmeas; t.over += over;
  t.seller += seller; t.live += live; t.pcard += pcard;
  t.cur += current; t.fixed += without;
  t.absCur += Math.abs(current); t.absFixed += Math.abs(without);

  console.log(
    `${d.day}  ${f(src)} ${f(d.affiliate_ours_gmv, 9)} ${f(d.affiliate_sc_gmv, 9)} `
    + `${f(unmeas, 8)} ${f(over, 9)}   ${f(current, 11)}   ${f(without, 13)}`,
  );
}

console.log('─'.repeat(94));
console.log(`\n── window totals ──`);
console.log(`  source shop GMV                 ${f(t.src)}`);
console.log(`  ad-driven affiliate  (paid)     ${f(t.paid)}`);
console.log(`  organic affiliate               ${f(t.org)}`);
console.log(`  affiliate, no line data         ${f(t.unmeas)}`);
console.log(`  affiliate, EXCESS over source   ${f(t.over)}   <-- the disputed row`);
console.log(`  seller video                    ${f(t.seller)}`);
console.log(`  LIVE                            ${f(t.live)}`);
console.log(`  product card                    ${f(t.pcard)}`);

const compCurrent = t.paid + t.org + t.unmeas + t.over + t.seller + t.live + t.pcard;
const compFixed = t.paid + t.org + t.unmeas + t.seller + t.live + t.pcard;
console.log(`\n  component total, AS BUILT       ${f(compCurrent)}   gap ${f(t.cur)}  abs ${f(t.absCur)}`);
console.log(`  component total, excess removed ${f(compFixed)}   gap ${f(t.fixed)}  abs ${f(t.absFixed)}`);

console.log(`\n── the test ──`);
const ratio = t.over === 0 ? null : t.cur / t.over;
console.log(`  signed gap / excess = ${ratio === null ? 'n/a' : ratio.toFixed(4)}`);
console.log(ratio !== null && Math.abs(ratio - 2) < 0.02
  ? '  >>> CONFIRMED: the gap is EXACTLY twice the excess — it is counted twice.'
  : '  >>> NOT the simple 2x pattern — inspect the daily columns above.');

// Are there video lines we hold but never classified? If so, paid+organic is
// NOT the same quantity as `ours`, and the identity needs that term too.
const { data: cls } = await db
  .from('affiliate_order_lines')
  .select('classification, payment_amount')
  .eq('shop_id', SHOP)
  .eq('counts_toward_gmv', true)
  .eq('content_type', 'Video')
  .gte('order_created_at', `${START}T00:00:00Z`)
  .lte('order_created_at', `${END}T23:59:59Z`);

const byClass = {};
for (const r of cls || []) byClass[r.classification] = (byClass[r.classification] || 0) + n(r.payment_amount);
console.log(`\n── video line classifications in the window (does paid+organic = ours?) ──`);
for (const [k, v] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(k).padEnd(22)} ${f(v)}`);
}
const other = Object.entries(byClass)
  .filter(([k]) => k !== 'PAID_SHOP_ADS' && k !== 'ORGANIC_STANDARD')
  .reduce((a, [, v]) => a + v, 0);
console.log(other > 0.005
  ? `\n  NOTE: ${other.toFixed(2)} sits outside paid/organic, so paid+organic UNDERSTATES our lines.`
  : '\n  Every video line is classified paid or organic, so paid+organic = our total.');
