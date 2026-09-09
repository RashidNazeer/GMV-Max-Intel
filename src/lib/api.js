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

/** Day-level reconciliation. A window that nets to zero can still be wrong every day. */
export const shopReconciliation = (id, s, e) =>
  rpc('shop_reconciliation', { p_shop_id: id, p_start: s, p_end: e }).then(one);

export const shopCreativeHealth = (id, s, e) => rpc('shop_creative_health', { p_shop_id: id, p_start: s, p_end: e }).then(one);

/**
 * Videos, with search / filter / sort / paging done in SQL.
 *
 * The old client fetched a hardcoded top 50 while the page headline said 573
 * videos earned and 61 were fading, and the server capped at 200 — so most of
 * the population was unreachable at any setting. `total` comes back on every
 * row so the table can say "1-50 of 573" truthfully rather than implying the
 * 50 it holds are everything.
 */
export async function shopTopVideos(id, s, e, opts = {}) {
  const rows = await rpc('shop_top_videos', {
    p_shop_id: id, p_start: s, p_end: e,
    p_limit: opts.limit ?? 50,
    p_offset: opts.offset ?? 0,
    p_search: opts.search || null,
    p_status: opts.status || null,
    p_sort: opts.sort || 'gmv',
    p_dir: opts.dir || 'desc',
    p_ids: opts.ids?.length ? opts.ids : null,
  });
  return { rows: rows || [], total: Number(rows?.[0]?.total_count ?? 0) };
}

export async function shopProducts(id, s, e, opts = {}) {
  const rows = await rpc('shop_products', {
    p_shop_id: id, p_start: s, p_end: e,
    p_limit: opts.limit ?? 50,
    p_offset: opts.offset ?? 0,
    p_search: opts.search || null,
    p_sort: opts.sort || 'gmv',
    p_dir: opts.dir || 'desc',
    p_ids: opts.ids?.length ? opts.ids : null,
  });
  return { rows: rows || [], total: Number(rows?.[0]?.total_count ?? 0) };
}

/**
 * THE canonical product counters and conversion benchmark.
 *
 * There used to be two medians under one label — the page computed one over
 * every row with a rate, the rules computed another over rows with 50,000+
 * impressions, and they printed 3.70% and 3.65% without either mentioning the
 * other. Everything now reads this.
 */
export const shopProductStats = (id, s, e) =>
  rpc('shop_product_stats', { p_shop_id: id, p_start: s, p_end: e }).then(one);

// shop_paid_roas returns NO ROW when a shop has no campaigns, rather than a row
// of zeros. `null` here therefore means "no spend data at all", which is a
// different claim from "spend was zero" and must stay distinguishable on screen.
export const shopPaidRoas    = (id, s, e) => rpc('shop_paid_roas', { p_shop_id: id, p_start: s, p_end: e }).then(one);
export const shopSpendDaily  = (id, s, e) => rpc('shop_spend_daily', { p_shop_id: id, p_start: s, p_end: e });
export const shopGmvDaily    = (id, s, e) => rpc('shop_gmv_daily', { p_shop_id: id, p_start: s, p_end: e });
export const shopDataSources = (id) => rpc('shop_data_sources', { p_shop_id: id }).then(one);

/**
 * Five separate facts per source: what the latest attempt did, when it last
 * SUCCEEDED, how far the stored records actually reach, which days of the
 * selected window are missing, and whether any records exist at all.
 *
 * Data status previously labelled GMV Max Healthy while its coverage ended
 * two days before the report, and treated a failed run as though the stored
 * history had vanished. Those are different facts and both were wrong.
 */
export const shopSourceHealth = (id, s, e) =>
  rpc('shop_source_health', { p_shop_id: id, p_start: s, p_end: e });

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

/**
 * Changes DETECTED by comparing consecutive settings snapshots.
 *
 * Deliberately distinct from a buyer reporting that they changed something.
 * Both are evidence; merging them would let an intention pass as a fact.
 */
export const detectedSettingChanges = (shopId, since = null) =>
  rpc('campaign_setting_changes', { p_shop_id: shopId, p_since: since });

/**
 * The earliest settings snapshot we hold for this shop — the date before which
 * NO effective campaign setting can be established.
 *
 * The snapshot table's own comment says it: history started 2026-09-08, Reacher
 * exposes no settings endpoint that returns past values, and "its absence before
 * that date is a real state, not a gap to fill in". A report ending before this
 * date therefore has no budget or Target ROI on record for the days it covers,
 * and any conclusion about whether the budget bound delivery is unsupported.
 *
 * Returns null when nothing has ever been recorded, which is the same answer
 * for the decision layer: no evidence.
 */
export async function settingsEvidenceFrom(shopId) {
  const { data, error } = await supabase
    .from('campaign_setting_snapshots')
    .select('taken_at')
    .eq('shop_id', shopId)
    .order('taken_at', { ascending: true })
    .limit(1);
  if (error) throw new Error(error.message);
  return data?.[0]?.taken_at ?? null;
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

// ── the decision workflow ───────────────────────────────────────────────────

export async function listRecommendations(shopId, { status = null, limit = 50 } = {}) {
  let q = supabase
    .from('recommendations')
    .select('*')
    .eq('shop_id', shopId)
    .order('generated_at', { ascending: false })
    .limit(limit);
  if (status) q = q.in('status', Array.isArray(status) ? status : [status]);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Move a recommendation through its lifecycle.
 *
 * "Mark applied" records that a HUMAN made a change in TikTok. It does not make
 * one, and nothing in this codebase can. The audit row is written first, so an
 * action is never recorded as having happened without a trace of who claimed it.
 */
export async function setRecommendationStatus(rec, status, { actualValue = null, reason = null } = {}) {
  const { data: { user } } = await supabase.auth.getUser();

  const { error: evErr } = await supabase.from('recommendation_events').insert({
    recommendation_id: rec.id,
    shop_id: rec.shop_id,
    event: `status:${status}`,
    from_status: rec.status,
    to_status: status,
    actor: user?.id ?? null,
    actor_email: user?.email ?? null,
    detail: { actual_value: actualValue, reason },
  });
  if (evErr) throw new Error(evErr.message);

  const patch = { status, status_actor: user?.id ?? null, status_reason: reason };
  if (status === 'applied') {
    patch.applied_value = actualValue;
    patch.applied_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('recommendations')
    .update(patch)
    .eq('id', rec.id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function recommendationEvents(recId) {
  const { data, error } = await supabase
    .from('recommendation_events')
    .select('event, from_status, to_status, actor_email, detail, created_at')
    .eq('recommendation_id', recId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export const recommendationOutcome = (recId) =>
  rpc('recommendation_outcome', { p_recommendation_id: recId });

/**
 * Persist the arbitration result so the lifecycle survives a refresh.
 *
 * Idempotent by (shop, fingerprint): reaching the same conclusion twice updates
 * the row instead of creating a second identical task. A recommendation the
 * buyer has already planned or applied is NOT overwritten — their decision
 * outranks a regenerated suggestion.
 */
export async function persistRecommendation(shopId, decision, ctx) {
  if (!decision) return null;
  const existing = await supabase
    .from('recommendations')
    .select('id, status')
    .eq('shop_id', shopId)
    .eq('fingerprint', decision.fingerprint)
    .in('status', ['proposed', 'planned', 'applied'])
    .maybeSingle();

  if (existing.data && existing.data.status !== 'proposed') return existing.data;

  const row = {
    shop_id: shopId,
    scope_type: ctx.scopeType || 'shop',
    scope_id: ctx.scopeId || null,
    scope_label: ctx.scopeLabel || null,
    affected_ids: decision.affected_ids || [],
    fingerprint: decision.fingerprint,
    window_start: ctx.start,
    window_end: ctx.end,
    model_start: ctx.modelStart || null,
    model_end: ctx.modelEnd || null,
    data_as_of: ctx.dataAsOf || null,
    objective: ctx.objective || 'balanced',
    source_mode: decision.source_mode,
    rule_version: decision.rule_version,
    action_code: decision.action_code,
    role: decision.role,
    severity: decision.severity,
    current_value: decision.current_value,
    suggested_value: decision.suggested_value,
    change_abs: decision.change_abs,
    change_pct: decision.change_pct,
    value_unit: decision.value_unit,
    test_days: decision.test_days,
    title: decision.title,
    reason: decision.reason,
    action_text: decision.action_text,
    evidence: decision.evidence,
    guardrails: decision.guardrails,
    suppressed: decision.suppressed,
    revenue_affected: decision.revenue_affected,
    confidence: decision.confidence,
    confidence_label: decision.confidence_label,
    confidence_parts: decision.confidence_parts,
    missing_inputs: decision.missing_inputs,
    model_confidence: decision.model_confidence,
    data_coverage: decision.data_coverage,
  };

  const { data, error } = await supabase
    .from('recommendations')
    .upsert(row, { onConflict: 'shop_id,fingerprint' })
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
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

/**
 * The same growth question across every shop the caller can see.
 *
 * GMV is summed per creator rather than listed per shop, so someone selling for
 * two shops ranks by what they are really worth. Today no creator does, but
 * that is a fact about the current data, not a property worth building on.
 */
export const allCreatorGrowth = (end, opts = {}) =>
  rpc('all_creator_growth', {
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

/** Numbers that might be absent. Number(null) is 0, and 0 is a measurement. */
export const numOrNull = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
export const fixed = (v, d = 2) => (numOrNull(v) == null ? '—' : Number(v).toFixed(d));

// The date utility lives in window.js — one implementation, used everywhere.
export { SETTLING_DAYS, reportWindow, modelWindow, chunkWindow, addDays, daysBetween, isoDaysAgo, isoSettledEnd } from './window.js';
