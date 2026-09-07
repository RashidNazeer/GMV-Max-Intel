// ============================================================
// The decision layer (spec layer 6).
//
// The spec is explicit about how this must work, and the constraints are the
// point of it rather than decoration:
//
//   - RULES, not a model. Every recommendation can be traced to the numbers
//     that produced it. An LLM may word an explanation; it never makes the call.
//   - EVERY figure carries its basis — measured, modelled or simulated — and
//     the basis of a recommendation is the WEAKEST of its inputs. One simulated
//     number makes the whole conclusion simulated.
//   - REFUSE rather than guess. A rule with insufficient evidence returns null.
//     Silence is a correct output; a confident number from thin data is not.
//   - READ-ONLY. Every action is something a person does. Nothing here writes
//     to TikTok, and nothing here should ever be wired to.
//
// Pure: no imports, no clock, no network. Everything comes in as arguments,
// which is what makes it testable against fixtures.
// ============================================================

export const SEVERITY = { CRITICAL: 'critical', WARNING: 'warning', INFO: 'info', GOOD: 'good' };
export const BASIS = { MEASURED: 'measured', MODELLED: 'modelled', SIMULATED: 'simulated' };

const RANK = { critical: 0, warning: 1, info: 2, good: 3 };

const n = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const money = (v, c = 'USD') =>
  v == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(v);
const pct = (v, d = 0) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);

/**
 * @param {object} f facts, each already scoped to the same shop and window
 * @param {object} f.attribution   one row from shop_attribution()
 * @param {object} f.creative      one row from shop_creative_health()
 * @param {array}  f.videos        rows from shop_top_videos()
 * @param {array}  f.products      rows from shop_products()
 * @param {object} f.roas          one row from shop_paid_roas(), or null
 * @param {object} f.shop          { shop_name, currency, affiliate_connected }
 * @param {number} f.days          length of the window
 * @returns {array} recommendations, most severe first
 */
export function buildRecommendations(f = {}) {
  const out = [];
  for (const rule of RULES) {
    let r = null;
    try { r = rule(f); } catch { r = null; }   // a broken rule must not blank the page
    if (r) out.push({ ...r, id: rule.ruleId });
  }
  return out.sort((a, b) =>
    (RANK[a.severity] - RANK[b.severity]) || ((b.at_stake ?? 0) - (a.at_stake ?? 0)));
}

// ── the rules ───────────────────────────────────────────────────────────────

// 1. Is the shop one video away from a bad month?
const concentration = (f) => {
  const c = f.creative; if (!c) return null;
  const videos = n(c.video_count), gmv = n(c.gmv), top5 = n(c.top5_share), top1 = n(c.top1_share);
  // Under ten videos a concentration ratio describes the sample, not the risk.
  if (!videos || videos < 10 || top5 == null || !gmv) return null;
  if (top5 < 0.35) return null;

  const cur = f.shop?.currency || 'USD';
  const atStake = gmv * top1;
  return {
    severity: top5 >= 0.5 ? SEVERITY.CRITICAL : SEVERITY.WARNING,
    basis: BASIS.MEASURED,
    at_stake: atStake,
    title: `Revenue is concentrated in ${top5 >= 0.5 ? 'very few' : 'a few'} videos`,
    finding: `Your top 5 videos are ${pct(top5)} of affiliate revenue, and the single best one is ${pct(top1)} — ${money(atStake, cur)} over this window. Video performance decays; when that one does, this much revenue goes with it and there is nothing behind it.`,
    action: `Brief replacements for the top performers now, while they are still earning. Aim to get the top-5 share under 35%.`,
    evidence: [
      `${videos} videos produced revenue`,
      `top 1 = ${pct(top1, 1)} of ${money(gmv, cur)}`,
      `top 5 = ${pct(top5, 1)}, top 10 = ${pct(n(c.top10_share), 1)}`,
    ],
  };
};
concentration.ruleId = 'creative-concentration';

// 2. Are the earners fading?
const fatigue = (f) => {
  const c = f.creative; if (!c || c.trend_measurable === false) return null;
  const gmv = n(c.gmv), fat = n(c.fatigued_gmv), count = n(c.fatigued_videos);
  if (!gmv || !fat || !count) return null;
  const share = fat / gmv;
  if (share < 0.2) return null;

  const cur = f.shop?.currency || 'USD';
  return {
    severity: share >= 0.35 ? SEVERITY.WARNING : SEVERITY.INFO,
    basis: BASIS.MEASURED,
    at_stake: fat,
    title: `${count} videos carrying ${pct(share)} of revenue are fading`,
    finding: `${money(fat, cur)} of revenue sits on videos whose last 7 days are down 30% or more against the 7 before. Spending harder against fading creative raises cost per order rather than volume.`,
    action: `Refresh these before increasing budget. ${n(c.rising_videos) ? `${n(c.rising_videos)} videos are rising — look at what those are doing differently.` : ''}`.trim(),
    evidence: [
      `${count} videos down >30% week-on-week`,
      `${money(fat, cur)} of ${money(gmv, cur)} affiliate revenue`,
      n(c.rising_videos) ? `${n(c.rising_videos)} rising, ${money(n(c.rising_gmv), cur)}` : 'no videos rising >30%',
    ],
  };
};
fatigue.ruleId = 'creative-fatigue';

// 3. Do our order lines account for the affiliate revenue Seller Center reports?
// This is a data-integrity alarm, and it outranks any conclusion drawn from the
// same data — a split computed on three-quarters of the orders is a split of
// three-quarters of the orders.
const capture = (f) => {
  const a = f.attribution; if (!a) return null;
  const cap = n(a.affiliate_capture), missing = n(a.affiliate_unmeasured_gmv);
  if (cap == null || cap >= 0.95) return null;

  const cur = f.shop?.currency || 'USD';
  const disconnected = f.shop?.affiliate_connected === false;
  return {
    severity: cap < 0.85 ? SEVERITY.CRITICAL : SEVERITY.WARNING,
    basis: BASIS.MEASURED,
    at_stake: missing ?? 0,
    title: `${pct(1 - cap)} of affiliate revenue has no order-line evidence`,
    // Deliberately does NOT blame the integration flag. Measured 2026-09-07:
    // Reacher's /integrations/status reported Cutler as disconnected while its
    // own dashboard showed the shop active and collecting, so that flag is not
    // reliable enough to hang an instruction on. And the shortfall survives on
    // months that closed long ago, so it is not settling lag either — both of
    // the easy explanations are ruled out by evidence.
    finding: `Seller Center reports ${money(n(a.affiliate_video_sc_gmv), cur)} of affiliate video GMV; the order-line feed accounts for ${money(n(a.affiliate_video_ours_gmv), cur)} of it. The missing ${money(missing, cur)} cannot be classified either way, so the paid/organic split below describes ${pct(cap)} of affiliate revenue rather than all of it.`,
    action: `This gap is inside Reacher — their Seller Center figure and their own transactions feed disagree for identical dates, and it persists on months that settled long ago, so waiting will not close it. Ask them which affiliate orders are excluded from /affiliate/transactions and whether they can be retrieved.`,
    evidence: [
      `capture ${pct(cap, 1)} of Seller Center's affiliate video GMV`,
      `${money(missing, cur)} unaccounted for`,
      'not settling lag — persists on closed months',
      disconnected ? 'integrations/status says disconnected (unreliable — dashboard shows active)' : 'integration status: connected',
    ],
  };
};
capture.ruleId = 'affiliate-capture';

// 4. How much of the shop can we actually see?
const blindSpot = (f) => {
  const a = f.attribution; if (!a) return null;
  const cov = n(a.attribution_coverage), total = n(a.total_gmv);
  if (cov == null || !total || cov >= 0.6) return null;

  const cur = f.shop?.currency || 'USD';
  const dark = total * (1 - cov);
  const card = n(a.product_card_gmv) || 0, seller = n(a.seller_video_gmv) || 0;
  const biggest = card >= seller ? 'product card' : 'seller video';
  return {
    severity: SEVERITY.INFO,
    basis: BASIS.MEASURED,
    at_stake: dark,
    title: `${pct(1 - cov)} of shop revenue cannot be attributed yet`,
    finding: `Only ${pct(cov)} of ${money(total, cur)} carries a commission signal that says what drove it. The largest unattributed channel is ${biggest} at ${money(Math.max(card, seller), cur)}. The paid/organic split on this page describes the ${pct(cov)}, not the shop.`,
    action: `Connect the ad account in Reacher. GMV Max spend-by-surface splits spend across affiliate, product card and brand, which is what turns these channels from dark into measured.`,
    evidence: [
      `measured ${money(total * cov, cur)} of ${money(total, cur)}`,
      `product card ${money(card, cur)}`,
      `seller video ${money(seller, cur)}`,
      `LIVE ${money(n(a.live_gmv), cur)}`,
    ],
  };
};
blindSpot.ruleId = 'attribution-blind-spot';

// 5. The comparison the product exists to make — stated as a BAND.
//
// GMV Max reports revenue attributed across every surface it buys. Our
// commission evidence covers one of them. So these are not a true number and a
// false one: they are a PROVEN FLOOR and a CLAIMED CEILING, and the honest
// output is the distance between them.
//
// Part of that distance is genuinely ad-driven revenue on surfaces where no
// commission programme names a cause; part is organic being counted as paid.
// Nothing available today separates the two, and this rule must not imply that
// it can. An earlier version divided measured affiliate revenue by
// affiliate-surface spend and called the result "like-for-like" — on real data
// it came out ABOVE the reported figure, which is incoherent as a rebuttal.
// A partial numerator over a partial denominator is a different quantity, not
// a truer version of the same one.
const unverifiedBand = (f) => {
  const r = f.roas; if (!r) return null;
  const ceiling = n(r.reported_roi), floor = n(r.verified_roas);
  const spend = n(r.spend), unverified = n(r.unverified_revenue), share = n(r.unverified_share);
  if (ceiling == null || floor == null || !spend || share == null) return null;
  if (share < 0.15) return null;   // a narrow band is not a finding

  const cur = f.shop?.currency || 'USD';
  const simulated = r.is_simulated === true || r.data_source === 'simulated';
  const surface = n(r.affiliate_surface_roas);
  return {
    severity: simulated ? SEVERITY.INFO : (share >= 0.5 ? SEVERITY.CRITICAL : SEVERITY.WARNING),
    basis: simulated ? BASIS.SIMULATED : BASIS.MEASURED,
    at_stake: unverified ?? 0,
    title: `${pct(share)} of the revenue GMV Max claims has no evidence behind it`,
    finding: `On ${money(spend, cur)} of spend, GMV Max claims ${money(n(r.reported_revenue), cur)} — a return of ${ceiling.toFixed(2)}. Commission evidence positively verifies ${money(n(r.verified_paid_gmv), cur)} of that as ad-driven, a return of ${floor.toFixed(2)}. The ${money(unverified, cur)} in between is either revenue the ads drove on surfaces that carry no commission signal, or organic sales being counted toward the campaign. Nothing available today tells us which.`,
    action: `Treat the real return as somewhere between ${floor.toFixed(2)} and ${ceiling.toFixed(2)}, and plan against the floor. To narrow the band, ask Reacher for GMV Max revenue BY SURFACE — they already expose spend by surface, so it is the revenue half that is missing.`,
    evidence: [
      `spend ${money(spend, cur)} over ${n(r.days_with_spend)} days`,
      `claimed ${money(n(r.reported_revenue), cur)} → ceiling ${ceiling.toFixed(2)}`,
      `verified ${money(n(r.verified_paid_gmv), cur)} → floor ${floor.toFixed(2)}`,
      surface != null ? `the affiliate surface alone returns ${surface.toFixed(2)}` : 'no per-surface spend split available',
    ],
  };
};
unverifiedBand.ruleId = 'unverified-revenue-band';

// 6. A creator whose sales only happen when the ads are on.
const adDependentCreators = (f) => {
  const vids = f.videos || []; if (vids.length < 5) return null;
  const cur = f.shop?.currency || 'USD';
  const byCreator = new Map();
  for (const v of vids) {
    const h = v.creator_handle; if (!h) continue;
    const e = byCreator.get(h) || { paid: 0, organic: 0 };
    e.paid += n(v.paid_gmv) || 0;
    e.organic += n(v.organic_gmv) || 0;
    byCreator.set(h, e);
  }
  const total = [...byCreator.values()].reduce((a, e) => a + e.paid + e.organic, 0);
  if (!total) return null;

  // Meaningful means both "highly ad-dependent" and "big enough to matter".
  const flagged = [...byCreator.entries()]
    .map(([handle, e]) => ({ handle, gmv: e.paid + e.organic, share: e.paid / (e.paid + e.organic || 1) }))
    .filter((x) => x.share >= 0.85 && x.gmv >= total * 0.03)
    .sort((a, b) => b.gmv - a.gmv);
  if (!flagged.length) return null;

  const sum = flagged.reduce((a, x) => a + x.gmv, 0);
  return {
    severity: SEVERITY.INFO,
    basis: BASIS.MEASURED,
    at_stake: sum,
    title: `${flagged.length} creator${flagged.length > 1 ? 's are' : ' is'} selling almost only through paid delivery`,
    finding: `${money(sum, cur)} comes from creators whose revenue is 85%+ Shop Ads commission. Their content is not finding an audience on its own — the ads are, and you are paying for reach the creator is not contributing.`,
    action: `Compare their cost per order against creators earning organically before renewing. This is a partner-selection decision, not a bidding one.`,
    evidence: flagged.slice(0, 4).map((x) => `@${x.handle} — ${money(x.gmv, cur)}, ${pct(x.share)} ad-driven`),
  };
};
adDependentCreators.ruleId = 'ad-dependent-creators';

// 7. Traffic that arrives and does not buy — a page problem, not an ads problem.
const conversionDrag = (f) => {
  const ps = (f.products || []).filter((p) => n(p.impressions) >= 50000 && n(p.click_to_order_rate) != null);
  if (ps.length < 3) return null;

  const rates = ps.map((p) => n(p.click_to_order_rate)).sort((a, b) => a - b);
  const median = rates[Math.floor(rates.length / 2)];
  if (!median) return null;

  const cur = f.shop?.currency || 'USD';
  const weak = ps
    .filter((p) => n(p.click_to_order_rate) < median * 0.6 && n(p.clicks) >= 5000)
    .sort((a, b) => n(b.clicks) - n(a.clicks));
  if (!weak.length) return null;

  const w = weak[0];
  return {
    severity: SEVERITY.WARNING,
    basis: BASIS.MEASURED,
    at_stake: n(w.clicks) * (median - n(w.click_to_order_rate)) * (n(w.aov) || 0),
    title: `${weak.length} product${weak.length > 1 ? 's convert' : ' converts'} far below the rest of the shop`,
    finding: `"${(w.title || w.product_id || '').slice(0, 60)}" turns ${pct(n(w.click_to_order_rate), 2)} of clicks into orders against a shop median of ${pct(median, 2)}, on ${Number(n(w.clicks)).toLocaleString()} clicks. Traffic is arriving and leaving. More spend buys more of the same leaving.`,
    action: `Fix the listing before raising budget — price, images, reviews, stock. ${n(w.refund_rate) >= 0.05 ? `Its refund rate is ${pct(n(w.refund_rate), 1)}, which points at the product rather than the page.` : ''}`.trim(),
    evidence: weak.slice(0, 3).map((x) =>
      `${(x.title || x.product_id).slice(0, 38)} — ${pct(n(x.click_to_order_rate), 2)} vs ${pct(median, 2)} median, ${money(n(x.gmv), cur)}`),
  };
};
conversionDrag.ruleId = 'conversion-drag';

// 8. Refunds quietly eating the return.
const refunds = (f) => {
  const cur = f.shop?.currency || 'USD';
  const ps = (f.products || []).filter((p) => n(p.refund_rate) != null && n(p.gmv) > 0);
  if (ps.length < 3) return null;

  const bad = ps.filter((p) => n(p.refund_rate) >= 0.08 && n(p.gmv) >= 1000)
    .sort((a, b) => n(b.refunds) - n(a.refunds));
  if (!bad.length) return null;

  const lost = bad.reduce((a, x) => a + (n(x.refunds) || 0), 0);
  return {
    severity: SEVERITY.WARNING,
    basis: BASIS.MEASURED,
    at_stake: lost,
    title: `${money(lost, cur)} refunded on ${bad.length} product${bad.length > 1 ? 's' : ''}`,
    finding: `Refunds are booked after the sale, so every ROAS on this page — ours and GMV Max's — is computed on revenue that partly came back. ${bad.length} product${bad.length > 1 ? 's are' : ' is'} refunding 8% or more.`,
    action: `Net these out before judging campaign efficiency, and look at whether the ad set expectations the product does not meet.`,
    evidence: bad.slice(0, 3).map((x) =>
      `${(x.title || x.product_id).slice(0, 38)} — ${pct(n(x.refund_rate), 1)} of ${money(n(x.gmv), cur)}`),
  };
};
refunds.ruleId = 'refund-drag';

// 9. Nothing is wrong. Say so, rather than leaving an empty panel that reads
// as "the tool did not run".
const allClear = (f) => {
  const a = f.attribution;
  if (!a || !n(a.total_gmv)) return null;
  return {
    severity: SEVERITY.GOOD,
    basis: BASIS.MEASURED,
    at_stake: 0,
    title: 'No action flagged from the evidence available',
    finding: `Concentration, creative momentum, conversion and refunds are all inside their thresholds for this window.`,
    action: `Nothing to change. The limiting factor is coverage, not performance: ${pct(n(a.attribution_coverage))} of revenue carries a signal we can read.`,
    evidence: [`window checked against ${RULES.length - 1} rules`],
    _fallback: true,
  };
};
allClear.ruleId = 'all-clear';

const RULES = [
  capture, unverifiedBand, concentration, fatigue,
  conversionDrag, refunds, adDependentCreators, blindSpot,
  allClear,
];

// The all-clear only speaks when nothing else did.
const _build = buildRecommendations;
export function recommend(f) {
  const all = _build(f);
  const real = all.filter((r) => !r._fallback);
  return real.length ? real : all.filter((r) => r._fallback);
}
