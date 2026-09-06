// Ingest Reacher affiliate data into the pilot database.
//
//   node scripts/sync.mjs [startDate] [endDate]
//
// Idempotent: upserts on (shop_id, order_id, sku_id), so re-running the same
// window updates rows in place rather than duplicating revenue. That matters
// because affiliate rows MUTATE — a pending estimated commission becomes an
// actual one when the order settles, and refunds arrive late (spec §38).
//
// Runs with the service role, server-side only. Every shop is isolated: one
// failing shop is recorded and skipped, never allowed to abort the run (§35).
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { createReacherClient } from '../src/lib/reacher/client.js';
import { normalizeAffiliateTransaction, normalizeShop } from '../src/lib/reacher/normalize.js';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const REACHER_KEY = fs.readFileSync(process.env.REACHER_KEYFILE || 'C:/Users/RA_shid/.wurx/cli-secrets.env', 'utf8')
  .match(/^\s*REACHER_API\s*=\s*(.*?)\s*$/m)[1];

const db = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const reacher = createReacherClient({ apiKey: REACHER_KEY });

const START = process.argv[2] || '2026-08-07';
const END = process.argv[3] || '2026-09-05';
const CHUNK = 500;

console.log(`sync window ${START} → ${END}`);

// ── 1. Shops ────────────────────────────────────────────────────────────────
const remoteShops = (await reacher.listShops()).data || [];
const shopRows = [];
for (const s of remoteShops) {
  const integ = await reacher.integrationsStatus(s.shop_id).catch(() => ({ integrations: [] }));
  shopRows.push(normalizeShop(s, integ.integrations));
}
const { data: savedShops, error: shopErr } = await db
  .from('shops').upsert(shopRows, { onConflict: 'reacher_shop_id' }).select('id, reacher_shop_id, shop_name, affiliate_connected');
if (shopErr) { console.error('shop upsert failed:', shopErr.message); process.exit(1); }
console.log(`shops upserted: ${savedShops.length}`);

// ── 2. Affiliate order lines, one shop at a time ────────────────────────────
let anyFailed = false;
for (const shop of savedShops) {
  const { data: run } = await db.from('sync_runs').insert({
    shop_id: shop.id, job: 'affiliate_transactions',
    window_start: START, window_end: END, status: 'running',
  }).select('id').single();

  try {
    let received = 0, written = 0;
    await reacher.fetchAffiliateTransactions({
      shopId: shop.reacher_shop_id, startDate: START, endDate: END, pageSize: CHUNK,
      onPage: async (rows) => {
        received += rows.length;
        if (!rows.length) return;
        const mapped = rows.map((t) => normalizeAffiliateTransaction(t, shop.id));
        // Chunked so a large backfill never builds one oversized request.
        for (let i = 0; i < mapped.length; i += CHUNK) {
          const slice = mapped.slice(i, i + CHUNK);
          const { error } = await db.from('affiliate_order_lines')
            .upsert(slice, { onConflict: 'shop_id,order_id,sku_id' });
          if (error) throw new Error(`upsert: ${error.message}`);
          written += slice.length;
        }
      },
    });

    await db.from('sync_runs').update({
      status: 'ok', finished_at: new Date().toISOString(),
      rows_received: received, rows_written: written,
    }).eq('id', run.id);
    console.log(`  ${shop.shop_name.padEnd(18)} ${String(written).padStart(5)} lines${shop.affiliate_connected === false ? '   (source integration DISCONNECTED)' : ''}`);
  } catch (e) {
    anyFailed = true;
    await db.from('sync_runs').update({
      status: 'error', finished_at: new Date().toISOString(),
      error: e.message, detail: { requestId: e.requestId ?? null, status: e.status ?? null },
    }).eq('id', run.id);
    // Spec §35: record it against the shop and carry on.
    console.log(`  ${shop.shop_name.padEnd(18)} SKIPPED — ${e.message}`);
  }
}

// ── 3. What landed ──────────────────────────────────────────────────────────
// Totals come from SQL, never from paging rows into this script. The first
// version of this summary did the latter and reported 395 lines for a shop that
// had just stored 2,261 — PostgREST caps a select at 1,000 rows, and the two
// shops happened to total exactly 1,000, so it looked like a data problem
// rather than a paging one.
{
  const { data: sum, error } = await db.rpc('shop_affiliate_summary', { p_start: START, p_end: END });
  if (error) console.log(`\nsummary unavailable: ${error.message}`);
  else {
    console.log('\nstored in the database:');
    for (const r of sum) {
      const share = r.paid_share == null ? '—' : `${(Number(r.paid_share) * 100).toFixed(1)}%`;
      console.log(`  ${String(r.shop_name).padEnd(18)} ${String(r.lines).padStart(5)} lines  ` +
        `paid $${Number(r.paid_gmv).toFixed(2)}  organic $${Number(r.organic_gmv).toFixed(2)}  → paid ${share}` +
        (r.affiliate_connected === false ? '   [source disconnected]' : ''));
    }
  }
}

process.exit(anyFailed ? 1 : 0);
