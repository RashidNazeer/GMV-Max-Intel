// Export a creator shortlist as CSV, ready to upload into an outreach automation.
//
//   node scripts/export-creators.mjs [shop] [growth] [maxGmv] [minGmv]
//   node scripts/export-creators.mjs cutler 2 25000 0
//
// Writes to the user's Downloads folder. The handle column is first and clean
// (no @), because that is the column that gets pasted into a creator list —
// everything after it is context for the human deciding who to keep.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createClient } from '@supabase/supabase-js';
import { need } from './_env.mjs';

const [URL, SERVICE] = need('VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
const db = createClient(URL, SERVICE, { auth: { persistSession: false } });

const which = (process.argv[2] || 'cutler').toLowerCase();
const minGrowth = Number(process.argv[3] ?? 2);
const maxGmv = process.argv[4] === 'null' ? null : Number(process.argv[4] ?? 25000);
const minGmv = Number(process.argv[5] ?? 0);

// End on the settled day, matching the app — the last two days are still
// arriving and would understate everyone equally.
const END = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);

const { data: shops } = await db.from('shops').select('id, shop_name, currency');

// "all" runs the cross-shop version, which sums a creator's GMV across every
// shop they sell for rather than listing them once per shop.
const ALL = which === 'all';
const shop = ALL ? { shop_name: 'All shops', currency: 'USD' }
  : shops.find((s) => s.shop_name.toLowerCase().includes(which));
if (!shop) { console.error(`no shop matching "${which}" — have: all, ${shops.map((s) => s.shop_name).join(', ')}`); process.exit(1); }

const { data, error } = ALL
  ? await db.rpc('all_creator_growth', {
      p_end: END, p_window_days: 30,
      p_min_growth: minGrowth, p_max_gmv: maxGmv, p_min_gmv: minGmv,
      p_include_new: false, p_limit: 500,
    })
  : await db.rpc('shop_creator_growth', {
      p_shop_id: shop.id, p_end: END, p_window_days: 30,
      p_min_growth: minGrowth, p_max_gmv: maxGmv, p_min_gmv: minGmv,
      p_include_new: false, p_limit: 500,
    });
if (error) { console.error(error.message); process.exit(1); }

const n = (v, d = 2) => (v == null ? '' : Number(v).toFixed(d));
const esc = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const header = [
  'creator_handle', ...(ALL ? ['shops'] : []), 'gmv_last_30d', 'gmv_prior_30d', 'growth_multiple', 'growth_pct',
  'ad_driven_gmv', 'organic_gmv', 'ad_driven_share', 'videos', 'order_lines', 'fully_organic',
];

const rows = data.map((c) => [
  c.creator_handle,
  ...(ALL ? [c.shops] : []),
  n(c.recent_gmv), n(c.prior_gmv), n(c.growth_multiple, 2),
  c.growth_pct == null ? '' : n(Number(c.growth_pct) * 100, 1),
  n(c.recent_paid_gmv), n(c.recent_organic_gmv),
  c.recent_paid_share == null ? '' : n(Number(c.recent_paid_share) * 100, 1),
  c.recent_videos, c.recent_lines,
  Number(c.recent_paid_gmv) === 0 ? 'yes' : 'no',
]);

const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';

const downloads = path.join(os.homedir(), 'Downloads');
fs.mkdirSync(downloads, { recursive: true });
const file = path.join(
  downloads,
  `${shop.shop_name.replace(/\W+/g, '-').toLowerCase()}-creators-doubled-${END}.csv`,
);
fs.writeFileSync(file, csv, 'utf8');

// A plain handle list too — one per line, nothing else. This is the one that
// pastes straight into a creator-list upload without any cleaning up.
const handles = path.join(
  downloads,
  `${shop.shop_name.replace(/\W+/g, '-').toLowerCase()}-handles-${END}.txt`,
);
fs.writeFileSync(handles, data.map((c) => c.creator_handle).join('\r\n') + '\r\n', 'utf8');

const money = (v) => '$' + Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const organic = data.filter((c) => Number(c.recent_paid_gmv) === 0);

console.log(`${shop.shop_name} · 30 days to ${END} vs the 30 before`);
console.log(`  filter: grew ${minGrowth}x or more${maxGmv ? `, GMV under ${money(maxGmv)}` : ''}${minGmv ? `, at least ${money(minGmv)}` : ''}`);
console.log(`  ${data.length} creators · ${money(data.reduce((a, c) => a + Number(c.recent_gmv), 0))} last 30d ` +
  `(from ${money(data.reduce((a, c) => a + Number(c.prior_gmv), 0))})`);
console.log(`  ${organic.length} of them are 100% organic — no ad spend behind their growth`);
console.log(`\nwritten:\n  ${file}\n  ${handles}`);
