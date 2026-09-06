// End-to-end check: run the REAL modules (client + classifier) against the live
// Reacher API and reconcile the result against Seller Center's own channel
// figures. This is the spec §43 validation, automated.
//
//   node scripts/verify-live.mjs [startDate] [endDate]
//
// Read-only. The key is read from outside the repo and never printed.
import fs from 'node:fs';
import { createReacherClient } from '../src/lib/reacher/client.js';
import { summarize } from '../src/lib/reacher/classify.js';

const KEYFILE = process.env.REACHER_KEYFILE || 'C:/Users/RA_shid/.wurx/cli-secrets.env';
const m = fs.readFileSync(KEYFILE, 'utf8').match(/^\s*REACHER_API\s*=\s*(.*?)\s*$/m);
if (!m) { console.error(`REACHER_API not found in ${KEYFILE}`); process.exit(1); }

const START = process.argv[2] || '2026-08-07';
const END = process.argv[3] || '2026-09-05';
const client = createReacherClient({ apiKey: m[1] });

const money = (n, c = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(n || 0);
const pct = (x) => (x == null ? 'n/a' : (x * 100).toFixed(1) + '%');

const who = await client.whoami();
console.log(`connected: customer ${who.customer_id}, ${who.shop_count} shop(s)\nwindow: ${START} → ${END}`);

for (const s of who.shops) {
  console.log(`\n${'='.repeat(66)}\n${s.shop_name}  (shop_id ${s.shop_id})\n${'='.repeat(66)}`);
  try {

  const integ = await client.integrationsStatus(s.shop_id).catch(() => null);
  const conn = (integ?.integrations || []).filter((i) => i.status === 'connected').map((i) => i.key);
  console.log(`  integrations connected : ${conn.length ? conn.join(', ') : '(none)'}`);

  const { transactions, total, truncated } = await client.fetchAffiliateTransactions({
    shopId: s.shop_id, startDate: START, endDate: END,
  });
  if (truncated) console.log('  !! pagination truncated — raise maxPages');

  if (!transactions.length) { console.log(`  no affiliate order lines (total=${total})`); continue; }

  const sum = summarize(transactions);
  const cur = transactions[0]?.currency || 'USD';

  console.log(`  order lines            : ${sum.lines} counted, ${sum.excludedLines} excluded (refunded/cancelled) of ${total}`);
  console.log(`  affiliate GMV          : ${money(sum.gmv, cur)}`);
  console.log(`    PAID    (shop ads)   : ${money(sum.paidGmv, cur).padStart(13)}  ${String(sum.paidLines).padStart(5)} lines`);
  console.log(`    ORGANIC (standard)   : ${money(sum.organicGmv, cur).padStart(13)}  ${String(sum.organicLines).padStart(5)} lines`);
  if (sum.mixedLines) console.log(`    MIXED                : ${money(sum.mixedGmv, cur)}  ${sum.mixedLines} lines`);
  if (sum.unclassifiedLines) console.log(`    UNCLASSIFIED         : ${money(sum.unclassifiedGmv, cur)}  ${sum.unclassifiedLines} lines`);
  console.log(`  >> paid share          : ${pct(sum.paidShare)}   organic ${pct(sum.organicShare)}`);
  console.log(`  classification coverage: ${pct(sum.coverage)}`);
  console.log(`  evidence basis         : ${JSON.stringify(sum.basisCounts)}`);

  // Reconcile against Seller Center: affiliate is only one slice of the shop.
  // Getting this ratio wrong is how a tool ends up calling affiliate GMV "shop
  // GMV" and reporting a wildly optimistic organic share.
  const ov = await client.sellerCenterOverview(s.shop_id, START, END).catch(() => null);
  if (ov?.gmv != null) {
    const affiliateFromSeller = (ov.channels?.video?.affiliate || 0) + (ov.channels?.live?.affiliate || 0);
    console.log(`\n  Seller Center total GMV: ${money(ov.gmv, ov.currency_code || cur)}  (${ov.orders} orders)`);
    console.log(`    video ${money(ov.channels?.video?.gmv, cur)} — affiliate ${money(ov.channels?.video?.affiliate, cur)} / seller ${money(ov.channels?.video?.seller, cur)}`);
    console.log(`    live ${money(ov.channels?.live?.gmv, cur)} · product card ${money(ov.channels?.product_card?.gmv, cur)}`);
    console.log(`    affiliate share of shop: ${pct(ov.gmv ? affiliateFromSeller / ov.gmv : null)}`);
    const gap = affiliateFromSeller - sum.gmv;
    const gapPct = affiliateFromSeller ? gap / affiliateFromSeller : null;
    console.log(`    RECONCILIATION: our affiliate GMV ${money(sum.gmv, cur)} vs Seller Center ${money(affiliateFromSeller, cur)} → gap ${money(gap, cur)} (${pct(gapPct)})`);
    if (gapPct != null && Math.abs(gapPct) > 0.10) {
      console.log('    ^^ gap exceeds the 10% tolerance (spec §15) — definitions differ; do not treat these as the same metric');
    }
  }

  const camps = await client.listGmvMaxCampaigns(s.shop_id).catch(() => null);
  console.log(`\n  GMV Max campaigns cached: ${camps?.data?.length ?? 'error'}` +
    (camps && !camps.data?.length ? '  → paid ROAS not computable until Reacher syncs campaigns' : ''));

  } catch (e) {
    // Spec §35: fail per shop, never let one tenant break the whole run.
    // Longevity returns 404 "no TikTok seller ID on file" — a real, permanent
    // state for a shop that never finished onboarding, not a transient error.
    console.log(`  SKIPPED — ${e.message}`);
    if (e.requestId) console.log(`    reacher request_id: ${e.requestId}`);
  }
}
