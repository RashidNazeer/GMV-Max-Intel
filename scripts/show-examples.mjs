// Pull real stored rows to illustrate how a line is classified.
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const db = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const show = (r) => {
  console.log(`  order        ${r.order_id}`);
  console.log(`  product      ${String(r.product_name).slice(0, 62)}`);
  console.log(`  creator      @${r.creator_handle}   via ${r.content_type}`);
  console.log(`  customer paid $${r.payment_amount}`);
  console.log(`  shop-ads commission : rate ${r.shop_ads_commission_rate ?? '—'}  est $${r.est_shop_ads_commission ?? '—'}  actual $${r.act_shop_ads_commission ?? '—'}`);
  console.log(`  standard commission : rate ${r.standard_commission_rate ?? '—'}  est $${r.est_standard_commission ?? '—'}  actual $${r.act_standard_commission ?? '—'}`);
  console.log(`  --> ${r.classification}   (evidence: ${r.classification_basis})`);
};

for (const [label, cls, basis] of [
  ['A PAID order (the ad caused it)', 'PAID_SHOP_ADS', 'ESTIMATED_COMMISSION'],
  ['An ORGANIC order (would have happened anyway)', 'ORGANIC_STANDARD', 'ESTIMATED_COMMISSION'],
  ['A SETTLED order (real money, not an estimate)', 'PAID_SHOP_ADS', 'ACTUAL_COMMISSION'],
]) {
  const { data } = await db.from('affiliate_order_lines').select('*')
    .eq('classification', cls).eq('classification_basis', basis)
    .order('payment_amount', { ascending: false }).limit(1);
  console.log(`\n=== ${label} ===`);
  if (data?.[0]) show(data[0]); else console.log('  (none found)');
}

// An order that produced more than one line — why "lines" and not "orders".
const { data: multi } = await db.rpc('shop_affiliate_summary', { p_start: '2026-08-07', p_end: '2026-09-05' });
console.log('\n=== one order can be several lines ===');
const { data: dupes } = await db.from('affiliate_order_lines')
  .select('order_id, sku_id, product_name, payment_amount, classification')
  .eq('order_id', (await db.from('affiliate_order_lines').select('order_id').limit(500)).data
    ?.reduce((acc, r, _, arr) => acc || (arr.filter((x) => x.order_id === r.order_id).length > 1 ? r.order_id : null), null) || '__none__');
if (dupes?.length > 1) {
  console.log(`  order ${dupes[0].order_id} contains ${dupes.length} products:`);
  dupes.forEach((d) => console.log(`    $${String(d.payment_amount).padStart(7)}  ${d.classification.padEnd(17)} ${String(d.product_name).slice(0, 48)}`));
} else console.log('  (no multi-line order in the sampled page)');

console.log('\n=== totals ===');
for (const r of multi || []) {
  if (!Number(r.lines)) continue;
  console.log(`  ${String(r.shop_name).padEnd(18)} ${r.lines} lines  $${Number(r.gmv).toFixed(2)}  paid ${(Number(r.paid_share) * 100).toFixed(1)}%`);
}
