// Is the affiliate shortfall INGESTION LAG or a permanent gap?
//
//   node scripts/probe-lag.mjs [shopId]
//
// The test: run the same reconciliation over several windows of increasing age.
// Both figures come from Reacher, for identical dates, so nothing else varies.
//
//   * If it is lag, capture climbs as the window gets older and is ~100% on a
//     month that closed weeks ago. Recent days look bad because they are still
//     filling in — normal, and it means we should simply stop trusting the last
//     N days rather than chase a bug.
//   * If capture is flat and short even on a long-settled month, the orders are
//     never going to arrive and the gap is structural.
//
// Both endpoints are asked for exactly the same dates, so this cannot be
// confounded by the timezone problem fixed in migration 009.
import { need } from './_env.mjs';
import { createReacherClient } from '../src/lib/reacher/client.js';

const [KEY] = need('REACHER_API');
const reacher = createReacherClient({ apiKey: KEY });
const shopId = Number(process.argv[2] || 11515);

const iso = (d) => d.toISOString().slice(0, 10);
const ago = (n) => iso(new Date(Date.now() - n * 864e5));

const WINDOWS = [
  ['last 30d, through today',        ago(30), ago(0)],
  ['last 30d, ending 2 days back',   ago(32), ago(2)],
  ['last 30d, ending 5 days back',   ago(35), ago(5)],
  ['last 30d, ending 10 days back',  ago(40), ago(10)],
  ['August 2026 (closed month)',     '2026-08-01', '2026-08-31'],
  ['July 2026 (long settled)',       '2026-07-01', '2026-07-31'],
  ['June 2026 (long settled)',       '2026-06-01', '2026-06-30'],
];

const sum = (xs) => xs.reduce((a, t) => a + (Number(t.payment_amount) || 0), 0);
const m = (v) => '$' + Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

console.log(`shop ${shopId} — does capture improve with age?\n`);
console.log('window                          dates                    Seller Center      feed    capture');
console.log('-'.repeat(96));

const results = [];
for (const [label, start, end] of WINDOWS) {
  try {
    const sc = await reacher.sellerCenterOverview(shopId, start, end);
    const scAff = Number(sc.channels?.video?.affiliate || 0);

    const { transactions, truncated } = await reacher.fetchAffiliateTransactions({
      shopId, startDate: start, endDate: end, pageSize: 500,
    });
    const feed = sum(transactions.filter((t) => t.content_type === 'Video' && !t.fully_refunded));
    const cap = scAff ? feed / scAff : null;
    results.push({ label, cap, scAff, feed });

    console.log(
      `${label.padEnd(30)}  ${start} → ${end}  ${m(scAff).padStart(11)}  ${m(feed).padStart(9)}   ` +
      `${cap == null ? '   —' : (cap * 100).toFixed(1).padStart(5) + '%'}` +
      `${truncated ? '  ** TRUNCATED **' : ''}` +
      `${transactions.length ? '' : '  (no rows)'}`,
    );
  } catch (e) {
    console.log(`${label.padEnd(30)}  FAILED — ${e.message.slice(0, 50)}`);
  }
}

// Verdict: compare the freshest window against the oldest one that has data.
const withData = results.filter((r) => r.cap != null && r.scAff > 0);
const newest = withData[0];
const settled = withData.filter((r) => /closed month|settled/.test(r.label));
const bestSettled = settled.sort((a, b) => b.cap - a.cap)[0];

console.log('\n' + '-'.repeat(96));
if (!newest || !bestSettled) {
  console.log('Not enough windows returned data to judge.');
} else if (bestSettled.cap >= 0.97) {
  console.log(`LAG. A settled month reconciles at ${(bestSettled.cap * 100).toFixed(1)}% while the`);
  console.log(`current window sits at ${(newest.cap * 100).toFixed(1)}%. The orders DO arrive — they are`);
  console.log(`just late. Nothing is broken; recent days must be labelled provisional, and the`);
  console.log(`reconciliation alarm should ignore the tail rather than cry wolf every day.`);
} else if (bestSettled.cap - newest.cap > 0.08) {
  console.log(`PARTLY LAG. Capture improves with age (${(newest.cap * 100).toFixed(1)}% -> ${(bestSettled.cap * 100).toFixed(1)}%),`);
  console.log(`so some of the shortfall does fill in — but a settled month still misses`);
  console.log(`${((1 - bestSettled.cap) * 100).toFixed(1)}%, which never arrives. Two causes stacked on top of each other.`);
} else {
  console.log(`NOT LAG. A settled month captures ${(bestSettled.cap * 100).toFixed(1)}%, essentially the same as the`);
  console.log(`current window (${(newest.cap * 100).toFixed(1)}%). Waiting does not fill the gap — these orders`);
  console.log(`are never served by the transactions endpoint. That is a question for Reacher.`);
}
