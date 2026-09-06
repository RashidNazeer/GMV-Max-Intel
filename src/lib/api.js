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
