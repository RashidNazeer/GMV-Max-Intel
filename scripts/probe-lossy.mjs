// Reacher handed over 80 rows for 2026-08-30; we stored 47. Where did 33 go?
//
//   node scripts/probe-lossy.mjs [shopId] [day]
//
// Two candidates, and they need very different fixes:
//
//  A. THE KEY COLLAPSES ROWS. Our unique key is (shop_id, order_id, sku_id).
//     If one order can carry the same SKU on more than one line — the same
//     product sold through two different creators' videos, say — the upsert
//     silently overwrites and we lose revenue. That is a data-loss bug.
//
//  B. TIMEZONE. Reacher filters by ITS notion of the day; we bucket by
//     order_created_at in UTC. Orders would then land on adjacent days —
//     which moves revenue between days but does NOT lose it over a long window.
//
// Only A explains a shortfall across the whole window.
import { createClient } from '@supabase/supabase-js';
import { need } from './_env.mjs';
import { createReacherClient } from '../src/lib/reacher/client.js';

const [URL, SERVICE, KEY] = need('VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'REACHER_API');
const db = createClient(URL, SERVICE, { auth: { persistSession: false } });
const reacher = createReacherClient({ apiKey: KEY });

const shopId = Number(process.argv[2] || 11515);
const DAY = process.argv[3] || '2026-08-30';

const { transactions } = await reacher.fetchAffiliateTransactions({
  shopId, startDate: DAY, endDate: DAY, pageSize: 500,
});
console.log(`Reacher returned ${transactions.length} rows for ${DAY}\n`);

// ── A. does (order_id, sku_id) collapse them? ────────────────────────────────
const byKey = new Map();
for (const t of transactions) {
  const k = `${t.order_id}|${t.sku_id}`;
  byKey.set(k, (byKey.get(k) || []).concat(t));
}
const dupes = [...byKey.entries()].filter(([, rows]) => rows.length > 1);
const money = (xs) => xs.reduce((a, t) => a + (Number(t.payment_amount) || 0), 0);

console.log(`A. NATURAL KEY`);
console.log(`   rows ${transactions.length} -> distinct (order_id, sku_id) ${byKey.size}`);
console.log(`   collapsing keys: ${dupes.length}`);
if (dupes.length) {
  const lost = dupes.reduce((a, [, rows]) => a + money(rows.slice(1)), 0);
  console.log(`   revenue silently overwritten by the upsert: $${lost.toFixed(2)} of $${money(transactions).toFixed(2)}`);
  const [k, rows] = dupes[0];
  console.log(`\n   example key ${k} — ${rows.length} lines:`);
  for (const r of rows) {
    console.log(`     $${String(r.payment_amount).padStart(8)}  qty ${r.quantity}  ` +
      `creator @${r.creator_handle}  content ${r.content_id}  type ${r.content_type}`);
  }
  // What WOULD be unique?
  for (const extra of ['content_id', 'creator_handle', 'commission_paid_at', 'order_created_at']) {
    const s = new Set(transactions.map((t) => `${t.order_id}|${t.sku_id}|${t[extra]}`));
    console.log(`   adding ${String(extra).padEnd(20)} -> ${s.size} distinct ${s.size === transactions.length ? ' <= UNIQUE' : ''}`);
  }
}

// ── B. do the timestamps land on the day Reacher says? ──────────────────────
console.log(`\nB. TIMEZONE`);
const byUtcDay = {};
for (const t of transactions) {
  const d = t.order_created_at ? new Date(t.order_created_at).toISOString().slice(0, 10) : 'null';
  byUtcDay[d] = (byUtcDay[d] || 0) + 1;
}
console.log(`   order_created_at in UTC falls on:`,
  Object.entries(byUtcDay).sort().map(([d, n]) => `${d}=${n}`).join(' · '));
console.log(`   (Reacher was asked for ${DAY} only)`);
