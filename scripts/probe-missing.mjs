// What exactly is Cutler's affiliate feed missing?
//
//   node scripts/probe-missing.mjs [shopId] [start] [end]
//
// Biostime reconciles at 96% on every window; Cutler plateaus around 84% even
// on a three-month-old month. Same code, same endpoint, so the difference is in
// the data. Before telling anyone "ask Reacher", narrow down WHAT is absent —
// a vendor question is far more likely to get answered if it names the shape of
// the hole rather than just its size.
//
// Candidates, in order of how boring they would be:
//   1. We filter content_type='Video'; Seller Center may count Showcase or
//      Livestream inside its "video" channel too.
//   2. We drop fully-refunded lines; Seller Center may not.
//   3. The endpoint is paginating short of its own reported total.
//   4. The orders genuinely are not there.
import { need } from './_env.mjs';
import { createReacherClient } from '../src/lib/reacher/client.js';

const [KEY] = need('REACHER_API');
const reacher = createReacherClient({ apiKey: KEY });
const shopId = Number(process.argv[2] || 11515);
const START = process.argv[3] || '2026-07-01';
const END = process.argv[4] || '2026-07-31';

const m = (v) => '$' + Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const sum = (xs) => xs.reduce((a, t) => a + (Number(t.payment_amount) || 0), 0);

console.log(`shop ${shopId} · ${START} → ${END}\n`);

// What Seller Center says, broken out.
const sc = await reacher.sellerCenterOverview(shopId, START, END);
const scVidAff = Number(sc.channels?.video?.affiliate || 0);
const scLiveAff = Number(sc.channels?.live?.affiliate || 0);
console.log('Seller Center:');
console.log(`  video.affiliate   ${m(scVidAff).padStart(10)}`);
console.log(`  video.seller      ${m(sc.channels?.video?.seller).padStart(10)}`);
console.log(`  live.gmv          ${m(sc.channels?.live?.gmv).padStart(10)}   (live.affiliate ${sc.channels?.live?.affiliate ?? 'null'})`);
console.log(`  product_card      ${m(sc.channels?.product_card?.gmv).padStart(10)}`);
console.log(`  TOTAL SHOP        ${m(sc.gmv).padStart(10)}   orders ${sc.orders}`);

// 3. Does pagination reach the server's own total?
const first = await reacher.post('/affiliate/transactions', {
  shopId, body: { start_date: START, end_date: END, limit: 500, offset: 0 },
});
const { transactions, total, pages, truncated } = await reacher.fetchAffiliateTransactions({
  shopId, startDate: START, endDate: END, pageSize: 500,
});
console.log(`\nfeed: server total ${first.total} · we received ${transactions.length} over ${pages} pages` +
  `${truncated ? '  ** TRUNCATED **' : '  (complete)'}`);

// 1 + 2. Where does the feed's money sit?
const byType = new Map();
for (const t of transactions) {
  const k = t.content_type || 'null';
  const e = byType.get(k) || { n: 0, gmv: 0, refunded: 0, refundedGmv: 0 };
  e.n++; e.gmv += Number(t.payment_amount) || 0;
  if (t.fully_refunded) { e.refunded++; e.refundedGmv += Number(t.payment_amount) || 0; }
  byType.set(k, e);
}
console.log('\nfeed by content_type:');
for (const [k, e] of [...byType.entries()].sort((a, b) => b[1].gmv - a[1].gmv)) {
  console.log(`  ${k.padEnd(26)} ${String(e.n).padStart(5)} rows  ${m(e.gmv).padStart(10)}` +
    `${e.refunded ? `   (${e.refunded} refunded, ${m(e.refundedGmv)})` : ''}`);
}

const video = transactions.filter((t) => t.content_type === 'Video' && !t.fully_refunded);
const allUnrefunded = transactions.filter((t) => !t.fully_refunded);
console.log('\nreconciliation against Seller Center video.affiliate:');
const row = (label, v) => console.log(`  ${label.padEnd(34)} ${m(v).padStart(10)}   ` +
  `${scVidAff ? ((v / scVidAff) * 100).toFixed(1).padStart(5) + '%' : '—'}`);
row('Video only, unrefunded (what we use)', sum(video));
row('Video only, incl. refunded', sum(transactions.filter((t) => t.content_type === 'Video')));
row('ALL content types, unrefunded', sum(allUnrefunded));
row('ALL content types, incl. refunded', sum(transactions));
console.log(`  ${'Seller Center video.affiliate'.padEnd(34)} ${m(scVidAff).padStart(10)}   100.0%`);

const best = sum(transactions);
console.log(`\n  still missing at best: ${m(scVidAff - best)}  (${(((scVidAff - best) / scVidAff) * 100).toFixed(1)}%)`);

// 4. If a hole remains, describe the orders we DO have, so the vendor question
// can be specific about what a missing order might look like.
if (scVidAff - best > scVidAff * 0.03) {
  const settled = transactions.filter((t) => t.is_settled).length;
  const statuses = new Map();
  for (const t of transactions) statuses.set(t.order_status, (statuses.get(t.order_status) || 0) + 1);
  console.log(`\n  of the ${transactions.length} orders we DO get:`);
  console.log(`    settled ${settled}, unsettled ${transactions.length - settled}`);
  console.log(`    statuses: ${[...statuses.entries()].map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  const creators = new Set(transactions.map((t) => t.creator_handle).filter(Boolean));
  console.log(`    ${creators.size} distinct creators`);
  console.log(`\n  QUESTION FOR REACHER: for ${START}..${END} your Seller Center endpoint reports`);
  console.log(`  ${m(scVidAff)} of affiliate video GMV, but /affiliate/transactions returns ${m(best)}`);
  console.log(`  across ${transactions.length} rows (server total ${first.total}). Which affiliate orders are`);
  console.log(`  excluded from the transactions feed, and can they be retrieved?`);
}
