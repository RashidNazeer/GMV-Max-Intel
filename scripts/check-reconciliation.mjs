// Reconciliation, checked PER DAY.
//
// ── WHY A SECOND CHECK ─────────────────────────────────────────────────────
// check-attribution.mjs compares the six components against total shop GMV over
// the whole window, and reported 0.00% drift on both shops. It was telling the
// truth about the window and nothing about the days inside it.
//
// Traced day by day on Biostime, 2026-08-30 → 2026-09-06:
//
//     day          Seller Center   our lines     diff
//     2026-08-30        289.53       286.35      -3.18
//     2026-08-31        170.04       175.81      +5.77
//     2026-09-01        253.50       262.55      +9.05
//     2026-09-02        355.03       370.52     +15.49
//     2026-09-06        234.66       250.99     +16.33
//
// Seven of eight days wrong, in a roughly constant proportion — a basis
// mismatch, not a boundary bug. Over 30 days the positive and negative errors
// CANCEL, so the window-level check saw perfect agreement over data that
// disagrees on most individual days.
//
// A check that can only pass is worthless. This one fails on the days.
import { createClient } from '@supabase/supabase-js';
import { env, need } from './_env.mjs';
import { reportWindow } from '../src/lib/window.js';

need('VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
const db = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// How many days may disagree before this is a failure rather than a note.
// Not zero: the two sources genuinely settle differently and we do not control
// either. The point is that the number is VISIBLE and tracked, not that it is
// perfect. Raise it deliberately, never to make a red build green.
const MAX_EXCEPTION_SHARE = 0.60;

const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);

const { data: shops, error } = await db
  .from('shops').select('id, shop_name').order('shop_name');
if (error) { console.error(error.message); process.exit(1); }

const win = reportWindow(30);
console.log(`reconciliation check — ${win.start} → ${win.end} (${win.spanDays} days)\n`);

let failures = 0;
let checked = 0;

for (const shop of shops) {
  const { data: rows, error: e1 } = await db.rpc('shop_channel_daily', {
    p_shop_id: shop.id, p_start: win.start, p_end: win.end,
  });
  if (e1) { console.log(`${shop.shop_name.padEnd(18)} ERROR ${e1.message}`); failures++; continue; }
  if (!rows?.length) { console.log(`${shop.shop_name.padEnd(18)} no channel data in this window`); continue; }

  checked++;

  const { data: sum } = await db.rpc('shop_reconciliation', {
    p_shop_id: shop.id, p_start: win.start, p_end: win.end,
  });
  const s = sum?.[0];

  const { data: attr } = await db.rpc('shop_attribution', {
    p_shop_id: shop.id, p_start: win.start, p_end: win.end,
  });
  const a = attr?.[0];

  const bad = rows.filter((r) => r.reconciliation_status === 'exception');
  const share = bad.length / rows.length;

  console.log(`${shop.shop_name}`);
  console.log(`  window gap        ${money(a?.reconciliation_gap)}  (${a?.reconciliation_status})`);
  console.log(`  affiliate capture ${(Number(a?.affiliate_capture ?? 0) * 100).toFixed(1)}%`);
  console.log(`  days reconciled   ${s?.days_reconciled}/${s?.days}   exceptions ${s?.days_exception}`);
  console.log(`  absolute error    ${money(s?.abs_gap_total)}   net ${money(s?.net_gap_total)}`);

  // THE POINT OF THIS FILE, stated precisely in its own output.
  //
  // The "affiliate, no line data" bucket is a RESIDUAL: whatever Seller Center
  // reports that our order lines do not. So it silently absorbs any shortfall,
  // and only the opposite direction — days where WE hold more than the source —
  // can ever surface as a gap.
  //
  // Aggregated over a window, a shop-wide shortfall soaks up the per-day
  // excesses and the residual stays positive, so the window reconciles to the
  // cent while individual days do not. That is not two errors cancelling; it is
  // one bucket large enough to hide the other.
  if (Math.abs(Number(a?.reconciliation_gap ?? 0)) < 0.5 && bad.length > 0) {
    console.log(`  >> the window reconciles to zero while ${bad.length} days do not.`);
    console.log('     The residual "no line data" bucket absorbs the shop-wide shortfall,');
    console.log('     which is large enough to conceal these per-day excesses.');
  }

  if (bad.length) {
    console.log('  worst days:');
    for (const r of [...bad].sort((x, y) => Math.abs(y.reconciliation_gap) - Math.abs(x.reconciliation_gap)).slice(0, 5)) {
      const dir = Number(r.affiliate_delta) > 0 ? 'ours higher' : 'source higher';
      console.log(`    ${r.day}  gap ${money(r.reconciliation_gap).padStart(10)}  (${dir})`);
    }
  }

  if (share > MAX_EXCEPTION_SHARE) {
    console.log(`  FAIL  ${(share * 100).toFixed(0)}% of days do not reconcile (limit ${(MAX_EXCEPTION_SHARE * 100).toFixed(0)}%)`);
    failures++;
  } else {
    console.log(`  ok    ${(share * 100).toFixed(0)}% of days are exceptions, within the ${(MAX_EXCEPTION_SHARE * 100).toFixed(0)}% limit`);
  }

  // The self-consistency assertion: the reported gap must equal the arithmetic
  // it claims to describe. If the components were being clamped again, this is
  // what would catch it.
  const compTotal = Number(a?.component_total);
  const total = Number(a?.total_gmv);
  if (Math.abs((compTotal - total) - Number(a?.reconciliation_gap)) > 0.01) {
    console.log('  FAIL  reported gap does not equal components minus total — something is being clamped');
    failures++;
  }
  console.log('');
}

// A check that reads nothing passes vacuously. Assert the input.
if (!checked) {
  console.error('FAIL: no shop had channel data — this check proved nothing');
  process.exit(1);
}

console.log(failures ? `FAILED (${failures})` : `ok — ${checked} shop(s) checked, per day`);
process.exit(failures ? 1 : 0);
