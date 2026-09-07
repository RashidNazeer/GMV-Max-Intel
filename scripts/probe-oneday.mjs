// Is the shortfall OUR fetch, or Reacher's data?
//
//   node scripts/probe-oneday.mjs [shopId] [day]
//
// Cutler captured 100% on some days and 44% on others. A flat definitional
// difference (different GMV basis, refunds counted differently) would shave a
// similar percentage off EVERY day. Wild day-to-day variance instead suggests
// whole orders missing.
//
// So: ask Reacher for one bad day on its own, and compare three numbers —
// what the API says exists, what it actually hands over, and what we stored.
import { createClient } from '@supabase/supabase-js';
import { need } from './_env.mjs';
import { createReacherClient } from '../src/lib/reacher/client.js';

const [URL, SERVICE, KEY] = need('VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'REACHER_API');
const db = createClient(URL, SERVICE, { auth: { persistSession: false } });
const reacher = createReacherClient({ apiKey: KEY });

const reacherShopId = Number(process.argv[2] || 11515);
const DAY = process.argv[3] || '2026-08-30';

const { data: shop } = await db.from('shops')
  .select('id, shop_name').eq('reacher_shop_id', reacherShopId).single();

console.log(`${shop.shop_name} · ${DAY}\n`);

// 1. Straight from Reacher, this single day.
const first = await reacher.post('/affiliate/transactions', {
  shopId: reacherShopId,
  body: { start_date: DAY, end_date: DAY, limit: 500, offset: 0 },
});
console.log(`Reacher says total = ${first.total}`);
if (first.data_status) console.log(`data_status: ${JSON.stringify(first.data_status)}`);

const all = await reacher.fetchAffiliateTransactions({
  shopId: reacherShopId, startDate: DAY, endDate: DAY, pageSize: 500,
});
console.log(`Reacher handed over ${all.transactions.length} rows across ${all.pages} page(s)` +
  `${all.truncated ? '  ** TRUNCATED **' : ''}`);

const sum = (xs) => xs.reduce((a, t) => a + (Number(t.payment_amount) || 0), 0);
const videoRows = all.transactions.filter((t) => t.content_type === 'Video');
const refunded = all.transactions.filter((t) => t.fully_refunded === true);

console.log(`\nof those ${all.transactions.length}:`);
console.log(`  Video content_type     ${String(videoRows.length).padStart(4)}  $${sum(videoRows).toFixed(2)}`);
console.log(`  fully refunded         ${String(refunded.length).padStart(4)}  $${sum(refunded).toFixed(2)}   (we exclude these)`);
const byType = {};
for (const t of all.transactions) byType[t.content_type || 'null'] = (byType[t.content_type || 'null'] || 0) + (Number(t.payment_amount) || 0);
console.log(`  by content_type:`, Object.entries(byType).map(([k, v]) => `${k} $${v.toFixed(0)}`).join(' · '));

// 2. What we stored for that day.
const { data: stored } = await db.from('affiliate_order_lines')
  .select('order_id, sku_id, payment_amount, content_type, counts_toward_gmv')
  .eq('shop_id', shop.id)
  .gte('order_created_at', `${DAY}T00:00:00Z`)
  .lt('order_created_at', `${DAY}T23:59:59.999Z`)
  .limit(1000);

const storedVideo = (stored || []).filter((r) => r.content_type === 'Video' && r.counts_toward_gmv);
console.log(`\nstored in our DB for ${DAY}: ${stored?.length} lines, ` +
  `of which Video+counted ${storedVideo.length}  $${sum(storedVideo).toFixed(2)}`);

// 3. What Seller Center claims for that day.
const ts = await reacher.shopGmvTimeseries(reacherShopId, DAY, DAY);
const d0 = (ts.series || [])[0];
console.log(`\nSeller Center for ${DAY}: affiliate video $${d0?.channels?.video?.affiliate}` +
  `  (total shop $${d0?.gmv})`);

// 4. The verdict.
const scAff = Number(d0?.channels?.video?.affiliate || 0);
const oursNow = sum(storedVideo);
const apiVideo = sum(videoRows.filter((t) => !t.fully_refunded));
console.log(`\n  Seller Center affiliate video   $${scAff.toFixed(2)}`);
console.log(`  API gives us (Video, unrefunded) $${apiVideo.toFixed(2)}`);
console.log(`  we stored                        $${oursNow.toFixed(2)}`);
console.log('');
if (Math.abs(apiVideo - oursNow) > 1) {
  console.log('=> WE are losing rows between the API and the database. Our bug.');
} else if (apiVideo < scAff * 0.97) {
  console.log('=> The API itself returns less than Seller Center reports.');
  console.log('   Nothing in our pipeline can close this — the orders are not being served to us.');
} else {
  console.log('=> No gap on this day.');
}
