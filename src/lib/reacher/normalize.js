// ============================================================
// Reacher payload -> our canonical row shape.
//
// The adapter boundary the spec insists on (§9, §30): Reacher's field names stop
// here. Nothing downstream — no SQL, no component — knows what Reacher calls
// anything. When their schema changes, this file changes and nothing else does.
// ============================================================

import { classifyTransaction, countsTowardGmv } from './classify.js';

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v === null || v === undefined || v === '' ? null : String(v));

// Reacher returns ISO strings with an offset. Store UTC; the source offset is
// preserved inside `raw` if it is ever needed (spec §9).
const ts = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * One Reacher affiliate transaction -> one affiliate_order_lines row.
 * `shopId` is OUR uuid for the shop, not Reacher's integer.
 */
export function normalizeAffiliateTransaction(t, shopId) {
  const { classification, basis } = classifyTransaction(t);
  return {
    shop_id: shopId,

    order_id: str(t.order_id),
    sku_id: str(t.sku_id),
    product_id: str(t.product_id),
    product_name: str(t.product_name),
    creator_handle: str(t.creator_handle),
    content_id: str(t.content_id),
    content_type: str(t.content_type),

    order_status: str(t.order_status),
    is_settled: t.is_settled === true,
    fully_refunded: t.fully_refunded === true,

    quantity: num(t.quantity),
    price: num(t.price),
    payment_amount: num(t.payment_amount),
    currency: str(t.currency),

    commission_model: str(t.commission_model),
    standard_commission_rate: num(t.standard_commission_rate),
    shop_ads_commission_rate: num(t.shop_ads_commission_rate),

    est_commission_base: num(t.estimated?.commission_base),
    est_standard_commission: num(t.estimated?.standard_commission),
    est_shop_ads_commission: num(t.estimated?.shop_ads_commission),
    est_cofunded_bonus: num(t.estimated?.cofunded_creator_bonus),

    act_commission_base: num(t.actual?.commission_base),
    act_standard_commission: num(t.actual?.standard_commission),
    act_shop_ads_commission: num(t.actual?.shop_ads_commission),
    act_cofunded_bonus: num(t.actual?.cofunded_creator_bonus),

    classification,
    classification_basis: basis,
    counts_toward_gmv: countsTowardGmv(t),

    order_created_at: ts(t.order_created_at),
    paid_at: ts(t.paid_at),
    delivered_at: ts(t.delivered_at),
    commission_paid_at: ts(t.commission_paid_at),
    platform: str(t.platform),

    raw: t,
    synced_at: new Date().toISOString(),
  };
}

/**
 * Reacher's /shops row -> our shops row. `integrations` comes from a separate
 * call, so it is passed in rather than guessed at.
 *
 * affiliate_connected is stored explicitly because it is the leading
 * explanation for a reconciliation gap: measured 2026-09-06, Biostime's
 * affiliate integration was connected and its affiliate GMV reconciled to
 * Seller Center within 0.4%, while Cutler's was disconnected and came up 18.3%
 * short. The UI needs to be able to say which of those it is looking at.
 */
export function normalizeShop(s, integrations = []) {
  const byKey = Object.fromEntries((integrations || []).map((i) => [i.key, i.status]));
  return {
    reacher_shop_id: s.shop_id,
    shop_name: s.shop_name,
    region: str(s.region),
    currency: s.currency || 'USD',
    is_active: s.status !== 'inactive',
    affiliate_connected: byKey.tiktok_shop_affiliate === 'connected',
    integrations: byKey,
  };
}

// ============================================================
// Layer 2 — whole-shop channel mix, from Seller Center.
//
// Verified on live data: channels.video.gmv = video.affiliate + video.seller,
// and video + live + product_card = the shop total, exactly. The daily series
// does NOT break out live.affiliate, live.seller, product_card.shop_tab or
// product_card.search — those arrive null every day, and are stored as null.
// Coercing them to 0 would assert "no revenue through search", which is a
// claim the source never made.
// ============================================================
export function normalizeDailyChannels(d, shopId, currency) {
  const ch = d.channels || {};
  const video = ch.video || {}, live = ch.live || {}, card = ch.product_card || {};
  const traffic = d.traffic || {};
  return {
    shop_id: shopId,
    day: String(d.date).slice(0, 10),

    gmv: num(d.gmv),
    orders: num(d.orders),
    items_sold: num(d.items_sold),
    customers: num(d.customers),
    aov: num(d.aov),

    video_gmv: num(video.gmv),
    video_affiliate_gmv: num(video.affiliate),
    video_seller_gmv: num(video.seller),
    live_gmv: num(live.gmv),
    live_affiliate_gmv: num(live.affiliate),
    live_seller_gmv: num(live.seller),
    product_card_gmv: num(card.gmv),
    product_card_shop_tab_gmv: num(card.shop_tab),
    product_card_search_gmv: num(card.search),

    product_impressions: num(traffic.product_impressions),
    product_clicks: num(traffic.product_clicks),

    currency: currency || null,
    raw: d,
    synced_at: new Date().toISOString(),
  };
}

// ── Layer 3 — the video feed. Enrichment only: money comes from order lines. ──
export function normalizeVideo(v, shopId, windowStart, windowEnd, rank) {
  return {
    shop_id: shopId,
    video_id: str(v.video_id),
    window_start: windowStart,
    window_end: windowEnd,
    title: str(v.title),
    creator_handle: str(v.creator_handle),
    tiktok_url: str(v.tiktok_url),
    video_gmv: num(v.video_gmv),
    views: num(v.views),
    like_count: num(v.like_count),
    comment_count: num(v.comment_count),
    order_count: num(v.order_count),
    posted_date: ts(v.posted_date),
    gmv_rank: rank,
    raw: v,
    synced_at: new Date().toISOString(),
  };
}

// ── Layer 4 — catalogue. Price range is derived across SKUs, because a product
// with six SKUs has no single price and quoting one of them would be arbitrary.
export function normalizeProductCatalog(p, shopId) {
  const skus = Array.isArray(p.skus) ? p.skus : [];
  const prices = skus.map((s) => num(s.sale_price)).filter((n) => n != null);
  const stock = skus.map((s) => num(s.inventory)).filter((n) => n != null);
  return {
    shop_id: shopId,
    product_id: str(p.product_id),
    title: str(p.title),
    image_url: str(p.primary_image_url),
    brand_name: str(p.brand_name),
    currency: str(p.currency),
    sku_count: skus.length,
    min_price: prices.length ? Math.min(...prices) : null,
    max_price: prices.length ? Math.max(...prices) : null,
    inventory: stock.length ? stock.reduce((a, b) => a + b, 0) : null,
    commission_rate: num(p.commission?.commission_rate),
    shop_ads_commission_rate: num(p.commission?.shop_ads_commission_rate),
    discount_pct: num(p.discount_pct),   // null across the whole catalogue today
    raw: p,
    synced_at: new Date().toISOString(),
  };
}

// ── Layer 4 — the Seller Center funnel for one product on ONE DAY. ──────────
// Stored daily because window-scoped rows only answer the exact window they
// were fetched for; daily rows aggregate to any range (migration 011).
export function normalizeProductDay(p, shopId, day) {
  const s = p.sales || {}, f = p.funnel || {}, c = p.channels || {};
  return {
    shop_id: shopId,
    day,
    product_id: str(p.product_id),

    product_name: str(p.product_name),
    cover_image_url: str(p.cover_image_url),

    gmv: num(s.gmv),
    orders: num(s.orders),
    sku_orders: num(s.sku_orders),
    items_sold: num(s.items_sold),
    customers: num(s.customers),
    refunds: num(s.refunds),
    items_returned: num(s.items_canceled_and_returned),

    impressions: num(f.impressions),
    unique_viewers: num(f.unique_viewers),
    clicks: num(f.clicks),
    unique_clickers: num(f.unique_clickers),
    add_to_cart: num(f.add_to_cart),
    // The funnel reports its own order count, and it differs from sales.orders
    // (3,417 vs 3,393 on a live product). Click-to-order is built from the
    // funnel's, so both are stored rather than one being assumed for the other.
    funnel_orders: num(f.orders),

    seller_video_gmv: num(c.seller?.video_gmv),
    seller_live_gmv: num(c.seller?.live_gmv),
    affiliate_gmv: num(c.affiliate?.gmv),
    affiliate_video_gmv: num(c.affiliate?.video_gmv),
    affiliate_live_gmv: num(c.affiliate?.live_gmv),
    product_card_gmv: num(c.product_card?.gmv),
    shop_tab_gmv: num(c.shop_tab?.gmv),

    raw: p,
    synced_at: new Date().toISOString(),
  };
}

// ============================================================
// GMV Max. Field names taken from the published OpenAPI document, not from the
// vendor's written spec — no campaign has ever been returned for our shops, so
// unlike everything above these have not been seen on a live payload. They are
// written defensively (every field optional-chained) and the first real sync
// should be treated as a discovery run.
// ============================================================
export function normalizeCampaign(c, shopId, settings = null, dataSource = 'reacher') {
  return {
    shop_id: shopId,
    campaign_id: str(c.campaign_id),
    campaign_name: str(c.campaign_name),
    status: str(settings?.status ?? c.status),
    campaign_type: str(c.shopping_ads_type),
    product_id: str(c.product_id),
    target_roas: num(settings?.target_roas ?? c.roas_bid),
    daily_budget: num(settings?.daily_budget ?? c.budget),
    optimization_mode: str(settings?.schedule_type),
    currency: str(c.currency),
    data_source: dataSource,
    raw: { campaign: c, settings },
    synced_at: new Date().toISOString(),
  };
}

export function normalizeCampaignDay(m, shopId, campaignId, dataSource = 'reacher') {
  return {
    shop_id: shopId,
    campaign_id: campaignId,
    day: String(m.date).slice(0, 10),
    spend: num(m.spend),
    impressions: num(m.impressions),
    clicks: num(m.clicks),
    orders: num(m.orders),
    revenue: num(m.gross_revenue),
    // Reacher exposes both `roas` and `ad_roi`; keep whichever is present
    // rather than computing one, so "what GMV Max reported" stays their number.
    roi: num(m.roas ?? m.ad_roi),
    cpc: num(m.cpc),
    cpm: num(m.cpm),
    ctr: num(m.ctr),
    spend_affiliate: num(m.spend_affiliate),
    spend_product_card: num(m.spend_product_card),
    spend_brand: num(m.spend_brand),
    data_source: dataSource,
    raw: m,
    synced_at: new Date().toISOString(),
  };
}

export function normalizeSettingsChange(c, shopId, campaignId, dataSource = 'reacher') {
  return {
    shop_id: shopId,
    campaign_id: campaignId,
    changed_at: ts(c.changed_at),
    field: str(c.field),
    old_value: c.old_value == null ? null : String(c.old_value),
    new_value: c.new_value == null ? null : String(c.new_value),
    data_source: dataSource,
    raw: c,
    synced_at: new Date().toISOString(),
  };
}
