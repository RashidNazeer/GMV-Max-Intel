// What makes an affiliate order line unique? The answer decides the primary key
// of the fact table, and therefore whether re-syncing is idempotent or silently
// duplicates revenue. Worth five minutes now rather than a data bug later.
import fs from 'node:fs';
import { createReacherClient } from '../src/lib/reacher/client.js';

const key = fs.readFileSync(process.env.REACHER_KEYFILE || 'C:/Users/RA_shid/.wurx/cli-secrets.env', 'utf8')
  .match(/^\s*REACHER_API\s*=\s*(.*?)\s*$/m)[1];
const client = createReacherClient({ apiKey: key });

for (const shop of [{ id: 11515, name: 'Cutler' }, { id: 11528, name: 'Biostime' }]) {
  const { transactions: rows } = await client.fetchAffiliateTransactions({
    shopId: shop.id, startDate: '2026-08-07', endDate: '2026-09-05',
  });

  const candidates = {
    'order_id': (t) => t.order_id,
    'order_id+sku_id': (t) => `${t.order_id}|${t.sku_id}`,
    'order_id+sku_id+content_id': (t) => `${t.order_id}|${t.sku_id}|${t.content_id}`,
    'order_id+sku_id+creator': (t) => `${t.order_id}|${t.sku_id}|${t.creator_handle}`,
  };

  console.log(`\n${shop.name}: ${rows.length} rows`);
  for (const [name, fn] of Object.entries(candidates)) {
    const seen = new Map();
    let dupes = 0;
    for (const t of rows) {
      const k = fn(t);
      if (seen.has(k)) dupes++; else seen.set(k, t);
    }
    console.log(`  ${name.padEnd(30)} distinct ${String(seen.size).padStart(5)}   collisions ${dupes}`);
  }

  // If order_id+sku_id collides, show one so we can see WHY — the reason decides
  // whether the extra column belongs in the key or the rows are true duplicates.
  const bySku = new Map();
  for (const t of rows) {
    const k = `${t.order_id}|${t.sku_id}`;
    if (!bySku.has(k)) bySku.set(k, []);
    bySku.get(k).push(t);
  }
  const clash = [...bySku.values()].find((g) => g.length > 1);
  if (clash) {
    console.log('  example collision on order_id+sku_id:');
    clash.slice(0, 2).forEach((t) => console.log('    ' +
      JSON.stringify({ order_id: t.order_id, sku_id: t.sku_id, qty: t.quantity, amt: t.payment_amount,
        creator: t.creator_handle, content_id: t.content_id, content_type: t.content_type, status: t.order_status })));
  }

  // Nullability of the fields we might rely on.
  const nulls = {};
  for (const f of ['order_id', 'sku_id', 'product_id', 'creator_handle', 'content_id', 'content_type', 'order_created_at', 'currency']) {
    nulls[f] = rows.filter((t) => t[f] === null || t[f] === undefined || t[f] === '').length;
  }
  console.log(`  null/empty counts: ${JSON.stringify(nulls)}`);
}
