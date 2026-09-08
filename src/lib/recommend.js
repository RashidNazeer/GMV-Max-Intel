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

// 2. Is revenue sitting on creative that is falling?
//
// NAMING, deliberately: a week-on-week revenue drop is DECLINING GMV and
// nothing stronger. "Fatigue" claims an audience has been worn out, which needs
// prior winning performance AND continuing exposure AND sustained decline. We
// have no per-video spend and no in-window impressions, so exposure cannot be
// tested — the stricter label is reserved for videos that were genuinely
// earning before they fell (shop_top_videos classifies those separately), and
// this rule speaks about the broader, weaker, honest claim.
const declining = (f) => {
  const c = f.creative; if (!c || c.trend_measurable === false) return null;
  const gmv = n(c.gmv), fell = n(c.declining_gmv), count = n(c.declining_videos);
  if (!gmv || !fell || !count) return null;
  const share = fell / gmv;
  if (share < 0.2) return null;

  const cur = f.shop?.currency || 'USD';
  const coverage = n(c.baseline_coverage);
  return {
    severity: share >= 0.35 ? SEVERITY.WARNING : SEVERITY.INFO,
    basis: BASIS.MEASURED,
    at_stake: fell,
    action_ids: f.decliningIds || [],
    drill_to: 'creatives',
    drill_status: 'declining',
    title: `${count} videos carrying ${pct(share)} of revenue are declining`,
    finding: `${money(fell, cur)} of revenue sits on videos whose last 7 days are down 30% or more against the 7 before. Spending harder against declining creative raises cost per order rather than volume.`,
    action: `Refresh these before increasing budget. ${n(c.fatigue_videos) ? `${n(c.fatigue_videos)} of them were earning well before they fell, which is the group worth briefing against first. ` : ''}${n(c.rising_videos) ? `${n(c.rising_videos)} videos are rising — look at what those are doing differently.` : ''}`.trim(),
    evidence: [
      `${count} videos down >30% week-on-week`,
      `${money(fell, cur)} of ${money(gmv, cur)} affiliate revenue`,
      coverage != null ? `a prior week existed for ${pct(coverage)} of videos — the rest have no baseline, which is not a decline` : 'baseline coverage unknown',
      n(c.rising_videos) ? `${n(c.rising_videos)} rising, ${money(n(c.rising_gmv), cur)}` : 'no videos rising >30%',
    ],
  };
};
declining.ruleId = 'creative-declining';

// 3. Do our order lines account for the affiliate revenue Seller Center reports?
// This is a data-integrity alarm, and it outranks any conclusion drawn from the
// same data — a split computed on three-quarters of the orders is a split of
// three-quarters of the orders.
const capture = (f) => {
  const a = f.attribution; if (!a) return null;
  const cap = n(a.affiliate_capture), missing = n(a.affiliate_unmeasured_gmv);
  if (cap == null) return null;

  // THE ALARM IS TWO-SIDED. It used to fire only below 0.95, so Biostime's
  // 103.9% — our order lines exceeding Seller Center's own affiliate figure —
  // sailed through as perfect health while the six components summed to 102.4%
  // of total shop GMV. Too much evidence is as much a reconciliation failure as
  // too little; it just cannot be explained by missing data.
  if (cap > 1.02) {
    const cur = f.shop?.currency || 'USD';
    const over = n(a.affiliate_overflow_gmv);
    return {
      severity: SEVERITY.CRITICAL,
      basis: BASIS.MEASURED,
      at_stake: over ?? 0,
      title: `Our order lines exceed Seller Center's own affiliate figure by ${pct(cap - 1, 1)}`,
      finding: `We hold ${money(n(a.affiliate_video_ours_gmv), cur)} of affiliate video revenue for this window; Seller Center reports ${money(n(a.affiliate_video_sc_gmv), cur)}. The excess ${money(over, cur)} cannot be missing data — it is the same sales counted on two different bases. Traced day by day the excess appears on nearly every day at a similar proportion, which rules out a day-boundary error and points at what each source includes.`,
      action: `Do not net this out or scale it away. Ask Reacher whether /affiliate/transactions payment_amount and the Seller Center affiliate figure share a basis — shipping, tax, cancellations and the point at which a refund is booked are the usual candidates.`,
      evidence: [
        `capture ${pct(cap, 1)} — above 100%`,
        `excess ${money(over, cur)}`,
        a.reconciliation_status === 'exception'
          ? `components exceed total shop GMV by ${pct(n(a.reconciliation_pct), 1)}`
          : 'within the window the totals still reconcile',
        'not a boundary effect — present on nearly every day',
      ],
    };
  }

  if (cap >= 0.95) return null;

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
    // Reacher answered this on 2026-09-08 and the answer is specific enough to
    // name: their transactions feed covers the Creator tab of Affiliate Center
    // and matches TikTok's own export exactly. The remainder is the PARTNER tab
    // — agency-run campaigns — which they do not ingest yet and are adding,
    // with a field to tell the two apart. Biostime reconciles because it has no
    // partner campaigns. So this bucket is no longer "data we lack"; it is a
    // named channel we cannot yet see inside.
    finding: `Seller Center reports ${money(n(a.affiliate_video_sc_gmv), cur)} of affiliate video GMV; the order-line feed accounts for ${money(n(a.affiliate_video_ours_gmv), cur)} of it. The missing ${money(missing, cur)} is agency-run Partner-tab campaigns, which Reacher does not ingest yet — so the paid/organic split below describes ${pct(cap)} of affiliate revenue rather than all of it.`,
    action: `Nothing to fix on our side. Reacher confirmed the transactions feed covers the Creator tab only and matches TikTok's export exactly; Partner ingestion is being added with a field distinguishing the two. Until it lands, read every share on this page as a share of the Creator tab.`,
    evidence: [
      `capture ${pct(cap, 1)} of Seller Center's affiliate video GMV`,
      `${money(missing, cur)} in Partner-tab campaigns`,
      'confirmed by Reacher 2026-09-08 — not settling lag, not a defect our end',
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
//
// THE BENCHMARK IS NOT COMPUTED HERE. This rule used to take its own median
// over products with 50,000+ impressions while the Products page took another
// over every product with a rate. They printed 3.65% and 3.70% under the same
// words, "shop median", and on Biostime this rule's median came from a single
// product. Both now read shop_product_stats(), which defines the numerator,
// the denominator and the eligibility once, in SQL, and returns n so the
// population can be disclosed instead of implied.
const conversionDrag = (f) => {
  const stats = f.productStats;
  const median = n(stats?.median_conversion);
  const medianN = n(stats?.median_n);
  if (median == null || !medianN || medianN < 3) return null;

  const cur = f.shop?.currency || 'USD';
  const minClicks = n(stats?.median_min_clicks) ?? 500;
  const weak = (f.products || [])
    .filter((p) => n(p.click_to_order_rate) != null
      && n(p.clicks) >= minClicks
      && n(p.click_to_order_rate) < median * 0.6)
    .sort((a, b) => n(b.clicks) - n(a.clicks));
  if (!weak.length) return null;

  const w = weak[0];
  return {
    severity: SEVERITY.WARNING,
    basis: BASIS.MEASURED,
    // Revenue AFFECTED, not money that will be gained. A counterfactual
    // computed from a median is a model output, and labelling it "at stake"
    // dresses it up as a forecast.
    at_stake: weak.reduce((a, x) => a + (n(x.gmv) || 0), 0),
    action_ids: weak.map((x) => x.product_id).filter(Boolean),
    drill_to: 'products',
    title: `${weak.length} product${weak.length > 1 ? 's convert' : ' converts'} far below the rest of the shop`,
    finding: `"${(w.title || w.product_id || '').slice(0, 60)}" turns ${pct(n(w.click_to_order_rate), 2)} of clicks into orders against a shop median of ${pct(median, 2)}, on ${Number(n(w.clicks)).toLocaleString()} clicks. Traffic is arriving and leaving. More spend buys more of the same leaving.`,
    action: `Fix the listing before raising budget — price, images, reviews, stock. ${n(w.refund_rate) >= 0.05 ? `Its refund rate is ${pct(n(w.refund_rate), 1)}, which points at the product rather than the page.` : ''}`.trim(),
    evidence: [
      `benchmark: ${pct(median, 2)} median across ${medianN} products with ${Number(minClicks).toLocaleString()}+ clicks`,
      ...weak.slice(0, 3).map((x) =>
        `${(x.title || x.product_id).slice(0, 38)} — ${pct(n(x.click_to_order_rate), 2)} vs ${pct(median, 2)} median, ${money(n(x.gmv), cur)}`),
    ],
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
  capture, unverifiedBand, concentration, declining,
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

// ============================================================
// WHAT IS WORKING.
//
// The rules above only ever speak when something is wrong, which makes the
// panel a complaints box: a shop can be doing three things well and read as
// nothing but problems. That is not a neutral omission — someone deciding where
// next month's budget goes needs to know what to PROTECT as much as what to
// fix, and "no findings" is a far weaker statement than "these four things are
// working".
//
// Same discipline as the problems: every claim carries the numbers that
// produced it, and a rule that cannot clear its evidence bar stays silent. A
// strength invented to balance the page would be worse than an unbalanced page.
// ============================================================

// 1. Demand that does not depend on spend is the most valuable thing a shop has.
const organicStrength = (f) => {
  const a = f.attribution; if (!a) return null;
  const paid = n(a.measured_paid_gmv), organic = n(a.measured_organic_gmv);
  if (paid == null || organic == null) return null;
  const measured = paid + organic;
  if (measured <= 0) return null;
  const share = organic / measured;
  if (share < 0.5) return null;

  const cur = f.shop?.currency || 'USD';
  return {
    severity: SEVERITY.GOOD, basis: BASIS.MEASURED, at_stake: organic,
    title: `${pct(share)} of measured revenue needs no ad support`,
    finding: `${money(organic, cur)} came through standard commission — creators posting because the product sells, not because delivery was bought. That is demand you already own, and it is the part of the business that survives a budget cut.`,
    action: `Protect it. When you judge a campaign, this is the baseline it has to beat, not add to.`,
    evidence: [`organic ${money(organic, cur)}`, `ad-driven ${money(paid, cur)}`, `of ${money(measured, cur)} measured`],
  };
};
organicStrength.ruleId = 'organic-strength';

// 2. Creative that is gaining, and creative that is arriving.
const creativeMomentum = (f) => {
  const c = f.creative; if (!c || c.trend_measurable === false) return null;
  const rising = n(c.rising_videos), risingGmv = n(c.rising_gmv), fresh = n(c.new_videos);
  if (!rising || rising < 3) return null;

  const cur = f.shop?.currency || 'USD';
  return {
    severity: SEVERITY.GOOD, basis: BASIS.MEASURED, at_stake: risingGmv ?? 0,
    title: `${rising} videos are gaining, carrying ${money(risingGmv, cur)}`,
    finding: `These are up 30% or more week-on-week. Against a catalogue where most creative decays, the ones climbing are the closest thing to a repeatable formula this shop has.${fresh ? ` ${fresh} more made their first sale in the last 7 days, so the pipeline is not empty.` : ''}`,
    action: `Look at what these have in common — hook, format, creator tier — and brief against that, rather than against the all-time winners, which are already past their peak.`,
    evidence: [
      `${rising} videos up >30%`,
      `${money(risingGmv, cur)} on rising creative`,
      fresh ? `${fresh} first sold this week` : 'no new videos this week',
    ],
  };
};
creativeMomentum.ruleId = 'creative-momentum';

// 3. Creators who sell without being pushed — the exact opposite of the
// ad-dependence warning, and the ones worth renewing first.
const organicCreators = (f) => {
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

  const good = [...byCreator.entries()]
    .map(([handle, e]) => ({ handle, gmv: e.paid + e.organic, share: e.paid / (e.paid + e.organic || 1) }))
    .filter((x) => x.share <= 0.2 && x.gmv >= total * 0.03)
    .sort((a, b) => b.gmv - a.gmv);
  if (!good.length) return null;

  const sum = good.reduce((a, x) => a + x.gmv, 0);
  return {
    severity: SEVERITY.GOOD, basis: BASIS.MEASURED, at_stake: sum,
    title: `${good.length} creator${good.length > 1 ? 's are' : ' is'} selling ${money(sum, cur)} without ad support`,
    finding: `Their revenue is 80%+ standard commission — the content is finding its own audience. These partnerships return more than the commission costs, because you are not also paying for the reach.`,
    action: `Renew and widen these first. Give them early access to new products before spending to push the same products through creators who need it.`,
    evidence: good.slice(0, 4).map((x) => `@${x.handle} — ${money(x.gmv, cur)}, ${pct(1 - x.share)} organic`),
  };
};
organicCreators.ruleId = 'organic-creators';

// 4. Products converting well above the shop — where extra traffic is worth buying.
const strongConverters = (f) => {
  const stats = f.productStats;
  const median = n(stats?.median_conversion);
  const medianN = n(stats?.median_n);
  if (median == null || !medianN || medianN < 3) return null;

  const cur = f.shop?.currency || 'USD';
  const minClicks = n(stats?.median_min_clicks) ?? 500;
  const strong = (f.products || [])
    .filter((p) => n(p.click_to_order_rate) != null
      && n(p.clicks) >= minClicks
      && n(p.click_to_order_rate) >= median * 1.4
      && n(p.gmv) > 0)
    .sort((a, b) => n(b.gmv) - n(a.gmv));
  if (!strong.length) return null;

  const s = strong[0];
  return {
    severity: SEVERITY.GOOD, basis: BASIS.MEASURED, at_stake: n(s.gmv) ?? 0,
    action_ids: strong.map((x) => x.product_id).filter(Boolean),
    drill_to: 'products',
    title: `${strong.length} product${strong.length > 1 ? 's convert' : ' converts'} well above the shop`,
    finding: `"${(s.title || s.product_id || '').slice(0, 56)}" turns ${pct(n(s.click_to_order_rate), 2)} of clicks into orders against a shop median of ${pct(median, 2)}. Traffic sent here converts — the listing is not the constraint.`,
    action: `These are where extra spend meets the least friction. If budget is going up, put it behind these before the ones that leak at the page.`,
    evidence: [
      `benchmark: ${pct(median, 2)} median across ${medianN} products with ${Number(minClicks).toLocaleString()}+ clicks`,
      ...strong.slice(0, 3).map((x) =>
        `${(x.title || x.product_id).slice(0, 34)} — ${pct(n(x.click_to_order_rate), 2)} vs ${pct(median, 2)}, ${money(n(x.gmv), cur)}`),
    ],
  };
};
strongConverters.ruleId = 'strong-converters';

// 5. Evidence quality is itself a result: it decides how much of the rest can
// be believed, and it is the one thing Cutler cannot currently claim.
const evidenceQuality = (f) => {
  const a = f.attribution; if (!a) return null;
  const cap = n(a.affiliate_capture);
  if (cap == null || cap < 0.95) return null;
  const cur = f.shop?.currency || 'USD';
  return {
    severity: SEVERITY.GOOD, basis: BASIS.MEASURED, at_stake: 0,
    title: `The affiliate evidence is essentially complete`,
    finding: `Order lines account for ${pct(cap, 1)} of the affiliate revenue Seller Center reports for this window, so the paid/organic split describes nearly all of it rather than a sample.`,
    action: `Nothing to do — but worth knowing when comparing against a shop whose capture is lower. The numbers here carry more weight.`,
    evidence: [`capture ${pct(cap, 1)}`, `${money(n(a.affiliate_video_ours_gmv), cur)} accounted for`],
  };
};
evidenceQuality.ruleId = 'evidence-quality';

const WORKING_RULES = [
  organicStrength, organicCreators, creativeMomentum, strongConverters, evidenceQuality,
];

/** Strengths, most valuable first. Same contract as recommend(): silence is a valid answer. */
export function whatsWorking(f = {}) {
  const out = [];
  for (const rule of WORKING_RULES) {
    let r = null;
    try { r = rule(f); } catch { r = null; }
    if (r) out.push({ ...r, id: rule.ruleId });
  }
  return out.sort((a, b) => (b.at_stake ?? 0) - (a.at_stake ?? 0));
}

// ============================================================
// Layer 5 in the decision panel.
//
// The card on the Campaigns tab shows the curve. This turns it into an
// instruction, which is the only reason the curve was fitted.
//
// The fit is computed elsewhere and passed in as f.marginal, because this
// module stays pure and free of imports. When the model refused, `marginal`
// carries a status other than 'ok' and this rule reports the REFUSAL rather
// than staying silent — "we cannot answer this yet, and here is what would make
// it answerable" is useful, where silence just looks like the feature is
// missing.
// ============================================================
const marginalReturn = (f) => {
  const mg = f.marginal; if (!mg) return null;
  const cur = f.shop?.currency || 'USD';
  const simulated = f.roas?.is_simulated === true;

  // Not answerable yet: say so, and say what would change it.
  if (mg.status && mg.status !== 'ok') {
    // Only worth raising once there is spend to talk about.
    if (!n(mg.total_spend)) return null;
    return {
      severity: SEVERITY.INFO,
      basis: simulated ? BASIS.SIMULATED : BASIS.MEASURED,
      at_stake: 0,
      title: `Cannot yet say what more spend would return`,
      finding: mg.reason,
      action: mg.status === 'flat_spend'
        ? `Vary the daily budget deliberately for two to three weeks — some days higher, some lower. That is what creates the evidence; a steady budget can never produce it, however long you wait.`
        : `Keep collecting. This answers itself as the history builds, and until it does the honest answer is that we do not know.`,
      evidence: [
        `${mg.days} days with spend`,
        mg.spend_cv != null ? `budget varied ${pct(mg.spend_cv, 0)} day to day` : 'spend variation unknown',
        mg.total_spend ? `${money(mg.total_spend, cur)} spent` : 'no spend',
      ],
    };
  }

  const m = n(mg.marginal_roas), avg = n(mg.avg_roas);
  if (m == null || avg == null) return null;
  const ci = Array.isArray(mg.marginal_roas_ci) ? mg.marginal_roas_ci : [];
  const lo = n(ci[0]), hi = n(ci[1]);
  const gap = avg > 0 ? (avg - m) / avg : null;

  // The interesting cases are: the next dollar is much worse than the average
  // (stop scaling), or it is essentially as good (room to scale).
  const scaling = m >= avg * 0.9;
  return {
    severity: SEVERITY.INFO,
    basis: simulated ? BASIS.SIMULATED : BASIS.MODELLED,
    at_stake: n(mg.total_spend) ?? 0,
    title: scaling
      ? `More spend should return about what current spend does`
      : `The next dollar returns ${pct(gap)} less than the average`,
    finding: scaling
      ? `Across ${mg.days} days, revenue rose roughly in step with spend (elasticity ${Number(mg.elasticity).toFixed(2)}). The next dollar looks worth about ${m.toFixed(2)} against an average of ${avg.toFixed(2)}, so this budget is not yet in diminishing returns — there is room before extra spend starts costing more than it brings.`
      : `Average ROAS is ${avg.toFixed(2)}, but the next dollar is worth about ${m.toFixed(2)}. Ad delivery reaches the easiest buyers first; past that point each extra dollar buys a harder sale. The campaign can look healthy on average while the money you are adding to it does not.`,
    action: scaling
      ? `If the return itself is acceptable, this budget can be raised. Judge that against ${m.toFixed(2)}, not the average — and re-check once spend has moved, because the curve shifts.`
      : `Judge any budget increase against ${m.toFixed(2)}. If break-even sits above that, the increase loses money even while the campaign still averages ${avg.toFixed(2)}.`,
    evidence: [
      `elasticity ${Number(mg.elasticity).toFixed(2)}${lo != null && hi != null ? ` · marginal ${lo.toFixed(2)}–${hi.toFixed(2)}` : ''}`,
      `${mg.days} days, ${money(mg.total_spend, cur)} spend, R² ${Number(mg.r2).toFixed(2)}`,
      mg.time_confounded ? 'spend and time are entangled — treat as indicative' : 'not confounded with a time trend',
    ],
  };
};
marginalReturn.ruleId = 'marginal-return';
RULES.push(marginalReturn);
