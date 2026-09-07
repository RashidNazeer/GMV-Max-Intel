// Over a whole window, timezone shifts cancel. So does the affiliate
// transaction feed actually add up to what Seller Center reports?
//
//   node scripts/probe-window.mjs [shopId]
//
// Three totals, all for the same window, from the same vendor:
//   1. what /affiliate/transactions hands over
//   2. what /seller-center/shop-overview says affiliate video was
//   3. what we stored
//
// If 1 < 2, the shortfall is inside Reacher and no fix on our side closes it.
// If 3 < 1, it is ours.
import { createClient } from '@supabase/supabase-js';
import { need } from './_env.mjs';
import { createReacherClient } from '../src/lib/reacher/client.js';

const [URL, SERVICE, KEY] = need('VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'REACHER_API');
const db = createClient(URL, SERVICE, { auth: { persistSession: false } });
const reacher = createReacherClient({ apiKey: KEY });

const shopId = Number(process.argv[2] || 11515);
const iso = (d) => d.toISOString().slice(0, 10);
const END = process.argv[4] || iso(new Date(Date.now() - 1 * 864e5));
const START = process.argv[3] || iso(new Date(Date.now() - 31 * 864e5));

const { data: shop } = await db.from('shops').select('id, shop_name').eq('reacher_shop_id', shopId).single();
console.log(`${shop.shop_name} · ${START} → ${END}\n`);

// 1. everything the transactions endpoint will give us
const res = await reacher.fetchAffiliateTransactions({
  shopId, startDate: START, endDate: END, pageSize: 500,
});
const tx = res.transactions;
console.log(`/affiliate/transactions: ${tx.length} rows, server total ${res.total}` +
  `${res.truncated ? '  ** TRUNCATED **' : ''}`);

const sum = (xs) => xs.reduce((a, t) => a + (Number(t.payment_amount) || 0), 0);
const video = tx.filter((t) => t.content_type === 'Video' && !t.fully_refunded);
const videoAll = tx.filter((t) => t.content_type === 'Video');
console.log(`  all rows                     $${sum(tx).toFixed(2)}`);
console.log(`  Video, unrefunded            $${sum(video).toFixed(2)}`);
console.log(`  Video, incl. refunded        $${sum(videoAll).toFixed(2)}`);

// 2. Seller Center's own affiliate figure for the same window
const sc = await reacher.sellerCenterOverview(shopId, START, END);
const scAff = Number(sc.channels?.video?.affiliate || 0);
console.log(`\n/seller-center/shop-overview:`);
console.log(`  affiliate video              $${scAff.toFixed(2)}`);
console.log(`  seller video                 $${Number(sc.channels?.video?.seller || 0).toFixed(2)}`);
console.log(`  total shop                   $${Number(sc.gmv || 0).toFixed(2)}`);

// 3. what we stored, straight from SQL so no page limit can shave it
const { data: stored, error: aErr } = await db.rpc("shop_attribution", {
  p_shop_id: shop.id, p_start: START, p_end: END,
});
const a = stored?.[0];
if (aErr) console.log("  shop_attribution error:", aErr.message);
console.log("  debug: rows=", stored?.length, "days_covered=", a?.days_covered);
console.log(`\nstored by us (shop_attribution over the same dates):`);
console.log(`  affiliate video, ours        $${Number(a?.affiliate_video_ours_gmv || 0).toFixed(2)}`);

// verdict
const apiV = sum(video);
console.log(`\n${'-'.repeat(64)}`);
console.log(`  Seller Center says affiliate video was   $${scAff.toFixed(2)}`);
console.log(`  the transactions endpoint gives us       $${apiV.toFixed(2)}   (${((apiV / scAff) * 100).toFixed(1)}%)`);
console.log(`  we stored                                $${Number(a?.affiliate_video_ours_gmv || 0).toFixed(2)}`);
console.log('');
if (apiV < scAff * 0.97) {
  console.log(`=> REACHER'S OWN TWO ENDPOINTS DISAGREE by $${(scAff - apiV).toFixed(2)}.`);
  console.log(`   The transactions feed does not contain the orders Seller Center is counting.`);
  console.log(`   Nothing we can build closes this — it is a question for Reacher.`);
} else {
  console.log(`=> The transactions feed reconciles with Seller Center. Any remaining gap is ours.`);
}
