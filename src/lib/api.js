import { supabase } from './supabase.js';

// Every figure on screen comes from a SQL function, never from summing rows in
// the browser. PostgREST caps a select at 1,000 rows, and a client-side total
// silently drops everything past that — it already produced a wrong number once
// during the build (a shop reported 395 lines when it had stored 2,261).
// Aggregating server-side means the screen and the database cannot disagree.

export async function listShops() {
  const { data, error } = await supabase
    .from('shops')
    .select('id, shop_name, display_name, currency, region, affiliate_connected, is_active, last_synced_at')
    .order('shop_name');
  if (error) throw new Error(error.message);
  return data || [];
}

export async function shopSummary(start, end) {
  const { data, error } = await supabase.rpc('shop_affiliate_summary', { p_start: start, p_end: end });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function shopDaily(shopId, start, end) {
  const { data, error } = await supabase.rpc('shop_affiliate_daily', {
    p_shop_id: shopId, p_start: start, p_end: end,
  });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function topCreators(shopId, start, end, limit = 20) {
  const { data, error } = await supabase.rpc('shop_top_creators', {
    p_shop_id: shopId, p_start: start, p_end: end, p_limit: limit,
  });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function lastSync(shopId) {
  const { data, error } = await supabase
    .from('sync_runs')
    .select('job, status, started_at, finished_at, rows_written, error')
    .eq('shop_id', shopId)
    .order('started_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  return data?.[0] || null;
}

// ── layers 2-4 and spend ────────────────────────────────────────────────────

const one = (rows) => (Array.isArray(rows) ? rows[0] ?? null : rows ?? null);

async function rpc(fn, args) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

export const shopAttribution  = (id, s, e) => rpc('shop_attribution', { p_shop_id: id, p_start: s, p_end: e }).then(one);
export const shopChannelDaily = (id, s, e) => rpc('shop_channel_daily', { p_shop_id: id, p_start: s, p_end: e });

export const shopCreativeHealth = (id, s, e) => rpc('shop_creative_health', { p_shop_id: id, p_start: s, p_end: e }).then(one);
export const shopTopVideos = (id, s, e, limit = 25) =>
  rpc('shop_top_videos', { p_shop_id: id, p_start: s, p_end: e, p_limit: limit });

export const shopProducts = (id, s, e, limit = 50) =>
  rpc('shop_products', { p_shop_id: id, p_start: s, p_end: e, p_limit: limit });

// shop_paid_roas returns NO ROW when a shop has no campaigns, rather than a row
// of zeros. `null` here therefore means "no spend data at all", which is a
// different claim from "spend was zero" and must stay distinguishable on screen.
export const shopPaidRoas    = (id, s, e) => rpc('shop_paid_roas', { p_shop_id: id, p_start: s, p_end: e }).then(one);
export const shopSpendDaily  = (id, s, e) => rpc('shop_spend_daily', { p_shop_id: id, p_start: s, p_end: e });
export const shopDataSources = (id) => rpc('shop_data_sources', { p_shop_id: id }).then(one);

export async function listCampaigns(shopId) {
  const { data, error } = await supabase
    .from('gmv_max_campaigns')
    .select('campaign_id, campaign_name, status, campaign_type, product_id, target_roas, daily_budget, currency, data_source, synced_at')
    .eq('shop_id', shopId)
    .order('campaign_name');
  if (error) throw new Error(error.message);
  return data || [];
}

export async function listSettingsChanges(shopId, limit = 50) {
  const { data, error } = await supabase
    .from('gmv_max_settings_changes')
    .select('campaign_id, changed_at, field, old_value, new_value, data_source')
    .eq('shop_id', shopId)
    .order('changed_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function syncRuns(shopId, limit = 8) {
  const { data, error } = await supabase
    .from('sync_runs')
    .select('job, status, started_at, finished_at, rows_written, error, window_start, window_end')
    .eq('shop_id', shopId)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

// ── outreach ────────────────────────────────────────────────────────────────

export const creatorGrowth = (shopId, end, opts = {}) =>
  rpc('shop_creator_growth', {
    p_shop_id: shopId,
    p_end: end,
    p_window_days: opts.windowDays ?? 30,
    p_min_growth: opts.minGrowth ?? 2,
    p_max_gmv: opts.maxGmv ?? null,
    p_min_gmv: opts.minGmv ?? 0,
    p_include_new: opts.includeNew ?? false,
    p_limit: opts.limit ?? 500,
  });

export async function productCatalog(shopId) {
  const { data, error } = await supabase
    .from('product_catalog')
    .select('product_id, title, min_price, max_price, inventory, commission_rate')
    .eq('shop_id', shopId)
    .order('title');
  if (error) throw new Error(error.message);
  return data || [];
}

export async function outreachLog(shopId, limit = 30) {
  const { data, error } = await supabase
    .from('outreach_actions')
    .select('id, action, detail, succeeded, actor_email, started_at, finished_at')
    .eq('shop_id', shopId)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Everything that can WRITE to Reacher goes through one edge function.
 *
 * The Reacher key is account-wide and can create automations that message
 * thousands of creators, so it lives as a function secret and never in this
 * bundle. The function re-checks the caller is the Boss, clamps recipient and
 * rate limits server-side, and writes an audit row before it acts — none of
 * which a browser could be trusted to do.
 */
export async function outreach(body) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('not signed in');
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/outreach`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok && json?.error) return { ok: false, status: res.status, ...json };
  return json;
}

// ── formatting ──────────────────────────────────────────────────────────────
export const money = (n, currency = 'USD') =>
  n == null ? '—' : new Intl.NumberFormat('en-US', {
    style: 'currency', currency, maximumFractionDigits: 0,
  }).format(Number(n));

export const moneyExact = (n, currency = 'USD') =>
  n == null ? '—' : new Intl.NumberFormat('en-US', {
    style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(Number(n));

// null means "we have nothing to divide", which is NOT zero percent. Showing
// 0% for an empty shop would state that nothing was ad-driven, which is a
// claim, not an absence of one.
export const pct = (x, digits = 1) =>
  x == null ? '—' : `${(Number(x) * 100).toFixed(digits)}%`;

export const isoDaysAgo = (days) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};
export const isoToday = () => new Date().toISOString().slice(0, 10);

// ── how long affiliate data takes to settle ─────────────────────────────────
// Measured 2026-09-07 by reconciling the same window at different ages against
// Seller Center. Orders keep arriving for about two days:
//
//   window ending          Cutler   Biostime
//   today                   75.9%     95.9%
//   2 days back             78.5%     98.6%
//   5 days back             78.5%     96.9%
//
// Capture stops improving after two days, so that is the settling period — not
// a guess, and not the same thing as Cutler's separate structural shortfall,
// which persists on months that closed long ago.
//
// Every window therefore ENDS two days back by default. Showing today's
// half-arrived revenue next to a fully-arrived channel total would make the
// most recent day look like a collapse, every single day.
export const SETTLING_DAYS = 2;
export const isoSettledEnd = () => isoDaysAgo(SETTLING_DAYS);
