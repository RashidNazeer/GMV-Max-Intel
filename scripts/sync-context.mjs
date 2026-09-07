// Ingest the context layers: whole-shop channel mix (2), the video feed (3),
// and the product catalogue + Seller Center funnel (4).
//
//   node scripts/sync-context.mjs [startDate] [endDate]
//
// Service role, server-side only. Every shop and every layer is isolated: a
// failure is recorded against that shop in sync_runs and the run carries on
// (spec §35). Longevity 404s on every call — it has no TikTok seller ID on
// file — and that must not stop Cutler and Biostime from loading.
import { createClient } from '@supabase/supabase-js';
import { need } from './_env.mjs';
import { createReacherClient } from '../src/lib/reacher/client.js';
import {
  normalizeDailyChannels, normalizeVideo,
  normalizeProductCatalog, normalizeProductWindow,
} from '../src/lib/reacher/normalize.js';

const [SUPABASE_URL, SERVICE_KEY, REACHER_API] =
  need('VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'REACHER_API');

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const reacher = createReacherClient({ apiKey: REACHER_API });

const iso = (d) => d.toISOString().slice(0, 10);
const END = process.argv[3] || iso(new Date());
const START = process.argv[2] || iso(new Date(Date.now() - 30 * 864e5));

console.log(`context sync ${START} → ${END}\n`);

const { data: shops, error } = await db
  .from('shops').select('id, reacher_shop_id, shop_name, currency, is_active')
  .order('shop_name');
if (error) { console.error('cannot list shops:', error.message); process.exit(1); }

let failures = 0;

/** Run one layer for one shop, recording the outcome either way. */
async function layer(shop, job, fn) {
  const { data: run } = await db.from('sync_runs').insert({
    shop_id: shop.id, job, window_start: START, window_end: END, status: 'running',
  }).select('id').single();

  try {
    const { received, written, note } = await fn();
    await db.from('sync_runs').update({
      status: 'ok', finished_at: new Date().toISOString(),
      rows_received: received, rows_written: written,
    }).eq('id', run.id);
    console.log(`  ${job.padEnd(18)} ${String(written).padStart(5)} rows${note ? '   ' + note : ''}`);
  } catch (e) {
    failures++;
    await db.from('sync_runs').update({
      status: 'error', finished_at: new Date().toISOString(),
      error: e.message, detail: { requestId: e.requestId ?? null, status: e.status ?? null },
    }).eq('id', run.id);
    console.log(`  ${job.padEnd(18)} SKIPPED — ${e.message.slice(0, 90)}`);
  }
}

// Upsert in chunks: one oversized request is the easy way to turn a good sync
// into a timeout on a shop with a long catalogue.
async function upsert(table, rows, onConflict) {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error: e } = await db.from(table).upsert(rows.slice(i, i + CHUNK), { onConflict });
    if (e) throw new Error(`${table}: ${e.message}`);
  }
  return rows.length;
}

for (const shop of shops) {
  console.log(`${shop.shop_name} (reacher ${shop.reacher_shop_id})`);

  // ── Layer 2: daily channel mix ────────────────────────────────────────────
  await layer(shop, 'shop_channels', async () => {
    const res = await reacher.shopGmvTimeseries(shop.reacher_shop_id, START, END);
    const series = res.series || [];
    const rows = series.map((d) => normalizeDailyChannels(d, shop.id, res.currency_code));
    const written = await upsert('shop_daily_channels', rows, 'shop_id,day');
    const total = series.reduce((a, d) => a + (Number(d.gmv) || 0), 0);
    return { received: series.length, written, note: `shop GMV $${total.toFixed(0)}` };
  });

  // ── Layer 3: the video feed (enrichment only) ─────────────────────────────
  await layer(shop, 'videos', async () => {
    const vids = await reacher.fetchTopVideos({
      shopId: shop.reacher_shop_id, startDate: START, endDate: END, want: 500,
    });
    const rows = vids.map((v, i) => normalizeVideo(v, shop.id, START, END, i + 1));
    const seen = new Set();
    const unique = rows.filter((r) => r.video_id && !seen.has(r.video_id) && seen.add(r.video_id));
    const written = await upsert('video_performance', unique, 'shop_id,video_id,window_start,window_end');
    return { received: vids.length, written, note: 'top by GMV — a head, not a census' };
  });

  // ── Layer 4a: catalogue ───────────────────────────────────────────────────
  await layer(shop, 'product_catalog', async () => {
    const res = await reacher.pnlProducts(shop.reacher_shop_id);
    const products = res.products || [];
    const rows = products.map((p) => normalizeProductCatalog(p, shop.id));
    const written = await upsert('product_catalog', rows, 'shop_id,product_id');
    // Say out loud what the source did not give us, rather than discovering it
    // later as a column of dashes on screen.
    const withDiscount = rows.filter((r) => r.discount_pct != null).length;
    return {
      received: products.length, written,
      note: `discount_pct on ${withDiscount}/${rows.length}`,
    };
  });

  // ── Layer 4b: the Seller Center funnel ────────────────────────────────────
  await layer(shop, 'product_metrics', async () => {
    const products = await reacher.fetchSellerCenterProducts({
      shopId: shop.reacher_shop_id, startDate: START, endDate: END, want: 200,
    });
    const rows = products.map((p) => normalizeProductWindow(p, shop.id, START, END));
    const written = await upsert('product_window_metrics', rows, 'shop_id,product_id,window_start,window_end');
    return { received: products.length, written };
  });

  await db.from('shops').update({ last_synced_at: new Date().toISOString() }).eq('id', shop.id);
  console.log('');
}

// ── What landed. Totals from SQL, never by paging rows into this script. ─────
console.log('attribution now available:');
for (const shop of shops) {
  const { data, error: e } = await db.rpc('shop_attribution', {
    p_shop_id: shop.id, p_start: START, p_end: END,
  });
  if (e) { console.log(`  ${shop.shop_name}: ${e.message}`); continue; }
  const a = data?.[0];
  if (!a || !Number(a.days_covered)) { console.log(`  ${shop.shop_name.padEnd(18)} no channel data`); continue; }
  const m = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const p = (n) => (n == null ? '—' : (Number(n) * 100).toFixed(1) + '%');
  console.log(
    `  ${String(shop.shop_name).padEnd(18)} total ${m(a.total_gmv).padStart(9)}   ` +
    `measured ${p(a.attribution_coverage).padStart(6)} of it   ` +
    `ad-driven ${p(a.paid_share_of_measured).padStart(6)} of that   ` +
    `affiliate capture ${p(a.affiliate_capture)}`,
  );
}

process.exit(failures ? 1 : 0);
