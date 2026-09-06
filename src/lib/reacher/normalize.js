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
