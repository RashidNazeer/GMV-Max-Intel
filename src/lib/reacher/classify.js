// ============================================================
// Paid vs organic classification for a TikTok Shop affiliate order line.
//
// This is the foundation of the whole product. Every downstream number — paid
// GMV, organic share, WURX Estimated Paid ROAS — is this function summed up.
// It is deliberately pure: no imports, no I/O, no framework. That makes it
// unit-testable against real payloads and lets it move into WurxOS unchanged.
//
// ── THE RULE (spec §12.1) ──────────────────────────────────────────────────
// TikTok pays a creator through one of two commission programmes, and which
// one it paid tells you what drove the sale:
//
//   Shop Ads commission  -> the order came through paid ad delivery
//   Standard commission  -> the creator posted organically for their own rate
//
// So the commission the order actually paid IS the attribution evidence. No
// modelling, no proxy. This is the only genuinely MEASURED layer in the system.
//
// ── WHY `commission_model` IS NOT USED ─────────────────────────────────────
// Reacher exposes a `commission_model` field, and the spec suggests preferring
// an explicit attribution field where one exists. Measured live on 2,866 order
// lines across two shops it was the constant string "fixed commission" on every
// single row — it describes the RATE STRUCTURE, not the programme, and carries
// no paid/organic signal. Using it would look authoritative and mean nothing.
//
// ── ACTUAL BEFORE ESTIMATED (spec §12.2) ───────────────────────────────────
// A settled order carries `actual` commission amounts. A pending one carries
// only `estimated`. Both are trustworthy for classification, but they are not
// equally final, so the basis is recorded and travels with the row: the UI can
// then show that recent revenue is provisional rather than pretending it is
// settled. Measured on Cutler's last 30 days: 695 of 2,238 lines were ACTUAL,
// the rest ESTIMATED — i.e. most of any recent window is necessarily estimated.
// ============================================================

export const CLASS = {
  PAID: 'PAID_SHOP_ADS',
  ORGANIC: 'ORGANIC_STANDARD',
  MIXED: 'MIXED',
  UNCLASSIFIED: 'UNCLASSIFIED',
};

export const BASIS = {
  ACTUAL: 'ACTUAL_COMMISSION',
  ESTIMATED: 'ESTIMATED_COMMISSION',
  RATE: 'RATE_ONLY',
  NONE: 'NO_EVIDENCE',
};

// null / '' / non-numeric all mean "no value", which is NOT the same as zero.
// A missing commission is unknown; a zero commission is a positive statement
// that this programme paid nothing. Collapsing the two would silently convert
// unknown rows into confident ones.
function amount(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function decide(shopAds, standard) {
  const paid = shopAds !== null && shopAds > 0;
  const organic = standard !== null && standard > 0;
  if (paid && !organic) return CLASS.PAID;
  if (organic && !paid) return CLASS.ORGANIC;
  if (paid && organic) return CLASS.MIXED;
  return null;                       // no evidence at this tier — try the next
}

/**
 * Classify one affiliate order line.
 *
 * @param {object} t A Reacher `/affiliate/transactions` row.
 * @returns {{classification: string, basis: string, confident: boolean}}
 */
export function classifyTransaction(t) {
  if (!t || typeof t !== 'object') {
    return { classification: CLASS.UNCLASSIFIED, basis: BASIS.NONE, confident: false };
  }

  // 1. Settled money first.
  const byActual = decide(
    amount(t.actual?.shop_ads_commission),
    amount(t.actual?.standard_commission),
  );
  if (byActual) {
    return { classification: byActual, basis: BASIS.ACTUAL, confident: byActual !== CLASS.MIXED };
  }

  // 2. Then the pending estimate.
  const byEstimated = decide(
    amount(t.estimated?.shop_ads_commission),
    amount(t.estimated?.standard_commission),
  );
  if (byEstimated) {
    return { classification: byEstimated, basis: BASIS.ESTIMATED, confident: byEstimated !== CLASS.MIXED };
  }

  // 3. Last resort: the rate fields. A rate proves which programme the line sits
  //    under even when no amount has been computed yet — weaker evidence, so it
  //    is labelled as such rather than being passed off as a commission figure.
  const byRate = decide(
    amount(t.shop_ads_commission_rate),
    amount(t.standard_commission_rate),
  );
  if (byRate) {
    return { classification: byRate, basis: BASIS.RATE, confident: false };
  }

  // 4. Nothing. Say so — never guess a side (spec §12.1: "Do not arbitrarily
  //    force the row into paid or organic").
  return { classification: CLASS.UNCLASSIFIED, basis: BASIS.NONE, confident: false };
}

// ── GMV basis (spec §12.3) ─────────────────────────────────────────────────
// One definition of GMV, applied consistently, or the reconciliation against
// Seller Center is meaningless. We use gross payment amount at order time and
// drop lines that never became revenue.
export function countsTowardGmv(t) {
  if (!t) return false;
  if (t.fully_refunded === true) return false;
  if (/cancel/i.test(String(t.order_status || ''))) return false;
  return true;
}

export function gmvOf(t) {
  return countsTowardGmv(t) ? (Number(t.payment_amount) || 0) : 0;
}

/**
 * Roll a set of order lines into the paid/organic picture for a product-day,
 * a shop-day, or any other grouping the caller has already filtered to.
 *
 * `coverage` is the share of GMV that landed on a definite side. The spec ties
 * attribution confidence to it directly (§12.4): when coverage falls, every
 * number built on top of this must become less certain, so it is returned
 * rather than left for the caller to rediscover.
 */
export function summarize(transactions) {
  const out = {
    lines: 0, gmv: 0,
    paidLines: 0, paidGmv: 0,
    organicLines: 0, organicGmv: 0,
    mixedLines: 0, mixedGmv: 0,
    unclassifiedLines: 0, unclassifiedGmv: 0,
    excludedLines: 0,
    basisCounts: {},
    paidShare: null, organicShare: null, coverage: null,
  };

  for (const t of transactions || []) {
    if (!countsTowardGmv(t)) { out.excludedLines++; continue; }
    const { classification, basis } = classifyTransaction(t);
    const g = gmvOf(t);
    out.lines++; out.gmv += g;
    out.basisCounts[basis] = (out.basisCounts[basis] || 0) + 1;

    if (classification === CLASS.PAID) { out.paidLines++; out.paidGmv += g; }
    else if (classification === CLASS.ORGANIC) { out.organicLines++; out.organicGmv += g; }
    else if (classification === CLASS.MIXED) { out.mixedLines++; out.mixedGmv += g; }
    else { out.unclassifiedLines++; out.unclassifiedGmv += g; }
  }

  const classified = out.paidGmv + out.organicGmv;
  if (classified > 0) {
    out.paidShare = out.paidGmv / classified;
    out.organicShare = out.organicGmv / classified;
  }
  if (out.gmv > 0) out.coverage = classified / out.gmv;
  return out;
}
