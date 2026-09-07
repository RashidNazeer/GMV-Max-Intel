// Why do our order lines fall short of Seller Center's affiliate figure?
//
//   node scripts/diagnose-gap.mjs
//
// "The integration is disconnected" is a plausible story, not a finding. If
// collection stopped, the gap should be concentrated in recent days. If it is
// spread evenly across the whole window, the cause is something else entirely
// and reconnecting would fix nothing.
//
// Worth knowing before telling anyone to go and reconnect something.
import { createClient } from '@supabase/supabase-js';
import { need } from './_env.mjs';
import { createReacherClient } from '../src/lib/reacher/client.js';

const [URL, SERVICE, KEY] = need('VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'REACHER_API');
const db = createClient(URL, SERVICE, { auth: { persistSession: false } });
const reacher = createReacherClient({ apiKey: KEY });

const iso = (d) => d.toISOString().slice(0, 10);
const END = iso(new Date());
const START = iso(new Date(Date.now() - 30 * 864e5));

const m = (v) => '$' + Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

const { data: shops } = await db.from('shops')
  .select('id, shop_name, reacher_shop_id').order('shop_name');

for (const shop of shops) {
  console.log(`\n${'='.repeat(78)}\n${shop.shop_name}  (reacher ${shop.reacher_shop_id})\n${'='.repeat(78)}`);

  // 1. What does Reacher say about the integrations RIGHT NOW?
  try {
    const st = await reacher.integrationsStatus(shop.reacher_shop_id);
    console.log('\nintegrations, live from Reacher:');
    for (const i of st.integrations || []) {
      console.log(`  ${String(i.key).padEnd(26)} ${String(i.status).padEnd(14)}` +
        `${i.last_synced_at ? `last synced ${i.last_synced_at}` : ''}` +
        `${i.connected_at ? `  connected ${i.connected_at}` : ''}`);
    }
  } catch (e) { console.log(`  integrations unavailable: ${e.message.slice(0, 70)}`); }

  // 2. Day by day: Seller Center's affiliate video GMV vs ours.
  const { data: rows, error } = await db.rpc('shop_channel_daily', {
    p_shop_id: shop.id, p_start: START, p_end: END,
  });
  if (error || !rows?.length) { console.log(`\nno channel data for this window`); continue; }

  // shop_channel_daily gives the gap directly, but rebuild the two sides so the
  // arithmetic is visible rather than trusted.
  const days = rows.map((r) => {
    const ours = Number(r.measured_paid_gmv) + Number(r.measured_organic_gmv);
    const gap = Number(r.affiliate_unmeasured_gmv);
    const sc = ours + gap;
    return { day: String(r.day).slice(0, 10), sc, ours, gap, pct: sc ? ours / sc : null };
  });

  const totSc = days.reduce((a, d) => a + d.sc, 0);
  const totOurs = days.reduce((a, d) => a + d.ours, 0);
  console.log(`\nSeller Center affiliate video ${m(totSc)}   ·   our order lines ${m(totOurs)}   ·   ` +
    `capture ${((totOurs / totSc) * 100).toFixed(1)}%   ·   missing ${m(totSc - totOurs)}`);

  // 3. THE QUESTION: is the shortfall recent, or everywhere?
  const withData = days.filter((d) => d.sc > 0);
  const full = withData.filter((d) => d.pct >= 0.97).length;
  const partial = withData.filter((d) => d.pct < 0.97 && d.pct > 0.03).length;
  const empty = withData.filter((d) => d.pct <= 0.03).length;
  console.log(`\ndays with affiliate revenue: ${withData.length}` +
    `   ·   fully captured ${full}   ·   partial ${partial}   ·   nothing captured ${empty}`);

  console.log('\nday          Seller Center      ours     captured');
  for (const d of days) {
    if (d.sc <= 0) continue;
    const bar = '#'.repeat(Math.round((d.pct || 0) * 24)).padEnd(24, '.');
    console.log(`  ${d.day}  ${m(d.sc).padStart(9)}  ${m(d.ours).padStart(9)}  ${bar} ${((d.pct || 0) * 100).toFixed(0).padStart(3)}%`);
  }

  // 4. Verdict. A shortfall that starts on a date and never recovers is a
  // collection failure. One spread evenly is a definitional difference.
  const firstHalf = withData.slice(0, Math.floor(withData.length / 2));
  const secondHalf = withData.slice(Math.floor(withData.length / 2));
  const capOf = (xs) => {
    const s = xs.reduce((a, d) => a + d.sc, 0), o = xs.reduce((a, d) => a + d.ours, 0);
    return s ? o / s : null;
  };
  const c1 = capOf(firstHalf), c2 = capOf(secondHalf);
  console.log(`\nolder half captured ${((c1 || 0) * 100).toFixed(1)}%   ·   recent half captured ${((c2 || 0) * 100).toFixed(1)}%`);

  // An earlier version of this verdict read "even across the window, so
  // reconnecting would not help". That was wrong twice over. It was computed on
  // day buckets that mixed two timezones (fixed in migration 009), and an even
  // shortfall does not rule out a broken feed — a connection that drops a
  // steady fraction of orders looks exactly like this. What the shape actually
  // distinguishes is a sudden OUTAGE from a steady LEAK.
  const avg = c1 != null && c2 != null ? (c1 + c2) / 2 : null;
  if (empty > 2) {
    console.log(`VERDICT: ${empty} days returned nothing at all — collection is dropping whole days.`);
  } else if (c1 != null && c2 != null && c1 - c2 > 0.15) {
    console.log('VERDICT: capture is FALLING over time — collection degraded partway through the window.');
  } else if (avg != null && avg < 0.93) {
    console.log(`VERDICT: a STEADY leak — roughly ${((1 - avg) * 100).toFixed(0)}% missing on every single day,`);
    console.log('         not an outage on particular days. Confirmed by probe-window.mjs to originate');
    console.log("         inside Reacher: their own transactions feed and Seller Center figure disagree,");
    console.log('         so no change on our side can close it. Compare capture against the shop\'s');
    console.log('         tiktok_shop_affiliate status above — that is the variable worth testing.');
  } else {
    console.log('VERDICT: capture is high and stable — nothing to explain here.');
  }
}
