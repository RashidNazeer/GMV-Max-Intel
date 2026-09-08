// ============================================================
// The decision pipeline. Findings in, ONE primary action out.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// The rules in recommend.js are good at noticing things and incapable of
// deciding anything. Reviewed on 8 September 2026, Biostime showed all three of
// these at once, in two different tabs, with equal weight:
//
//     "more spend should return about what current spend does"
//     "61% of affiliate revenue sits on declining videos"
//     "revenue is concentrated in a few videos"
//
// Every one is true. Together they are a contradiction the buyer was left to
// resolve, and the obvious resolution — spend more — is the one the other two
// findings argue against.
//
// So: candidates, then guardrails, then a score, then exactly one primary
// action. The alternatives are not deleted; they are SUPPRESSED WITH A REASON
// and stored, because "why is it not telling me to raise budget" is a question
// the tool should be able to answer.
//
// ── THE RULES OF THE PIPELINE ──────────────────────────────────────────────
//   * Deterministic. Same inputs, same output, every refresh. A recommendation
//     that flips between reloads is noise wearing a suit.
//   * Data checks are ACTION-SPECIFIC. Missing ad spend blocks a budget change;
//     it does not block a creative review, which is measured from order lines.
//   * No LLM decides anything. It may word an explanation; it never picks.
//   * Nothing here writes to TikTok. Every action is something a person does.
//
// Pure: no imports, no clock, no network. Everything arrives as arguments.
// ============================================================

export const ACTION = {
  INCREASE_TARGET_ROI: 'increase_target_roi',
  DECREASE_TARGET_ROI: 'decrease_target_roi',
  INCREASE_BUDGET: 'increase_budget',
  DECREASE_BUDGET: 'decrease_budget',
  TEST_MAX_DELIVERY: 'test_max_delivery',
  EXIT_MAX_DELIVERY: 'exit_max_delivery',
  HOLD: 'hold',
  REVIEW_CREATIVE: 'review_creative',
  REVIEW_PROMOTION: 'review_promotion',
  REVIEW_LISTING: 'review_listing',
  FIX_DATA: 'fix_data',
  INSUFFICIENT_DATA: 'insufficient_data',
};

export const OBJECTIVE = { BALANCED: 'balanced', EFFICIENCY: 'efficiency', GMV_GROWTH: 'gmv_growth' };

export const RULE_VERSION = '2026-09-08.1';

// Relative test bands, per the original V1 defaults. A fixed absolute increment
// applied to every campaign is how a 0.10 nudge becomes a 20% swing on one
// campaign and a rounding error on another.
export const BANDS = {
  target_roi: [0.05, 0.10, 0.15],
  budget: [0.10, 0.20, 0.30],
};

// Cooldown: do not propose a new test while the last one is still being read.
export const COOLDOWN_DAYS = 7;

const n = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const pct = (v, d = 0) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
const money = (v, c = 'USD') =>
  v == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(v);

// ── 1. FEATURES ─────────────────────────────────────────────────────────────
// One normalised view of the evidence, so no candidate re-derives a number
// slightly differently from its neighbour.
export function features(f = {}) {
  const a = f.attribution || null;
  const c = f.creative || null;
  const r = f.roas || null;
  const mg = f.marginal || null;
  const ps = f.productStats || null;

  const creativeGmv = n(c?.gmv) || 0;
  const decliningGmv = n(c?.declining_gmv) || 0;

  return {
    shop: f.shop || {},
    currency: f.shop?.currency || 'USD',
    window: { start: f.start, end: f.end, days: f.days },
    modelWindow: f.modelWindow || null,
    objective: f.objective || OBJECTIVE.BALANCED,

    // Evidence quality — decides how much of everything else can be believed.
    capture: n(a?.affiliate_capture),
    coverage: n(a?.attribution_coverage),
    reconciliationStatus: a?.reconciliation_status || null,
    reconciliationGap: n(a?.reconciliation_gap),
    reconciliationPct: n(a?.reconciliation_pct),
    totalGmv: n(a?.total_gmv),

    // Spend side. null means "no spend data", which is NOT zero spend.
    hasSpend: !!r,
    simulated: r?.is_simulated === true || r?.data_source === 'simulated',
    spend: n(r?.spend),
    reportedRoi: n(r?.reported_roi),
    verifiedRoas: n(r?.verified_roas),
    unverifiedShare: n(r?.unverified_share),
    daysWithSpend: n(r?.days_with_spend),

    // Delivery
    dailyBudget: n(f.dailyBudget),
    dailySpend: n(mg?.mean_daily_spend),
    utilisation: n(f.dailyBudget) > 0 && n(mg?.mean_daily_spend) != null
      ? n(mg.mean_daily_spend) / n(f.dailyBudget) : null,
    targetRoi: n(f.targetRoi),

    // Marginal model
    marginalStatus: mg?.status || null,
    marginal: n(mg?.marginal_roas),
    marginalCi: Array.isArray(mg?.marginal_roas_ci) ? mg.marginal_roas_ci.map(n) : null,
    avgRoas: n(mg?.avg_roas),
    marginalTarget: mg?.target || null,
    marginalTargetLabel: mg?.target_label || null,
    modelConfidence: modelConfidence(mg),
    timeConfounded: mg?.time_confounded === true,
    marginalProvisional: mg?.provisional === true,

    // Creative
    videoCount: n(c?.video_count),
    top5Share: n(c?.top5_share),
    top1Share: n(c?.top1_share),
    decliningVideos: n(c?.declining_videos),
    decliningGmv,
    decliningShare: creativeGmv ? decliningGmv / creativeGmv : null,
    fatigueVideos: n(c?.fatigue_videos),
    risingVideos: n(c?.rising_videos),
    newVideos: n(c?.new_videos),
    baselineCoverage: n(c?.baseline_coverage),
    trendMeasurable: c?.trend_measurable !== false,
    creativeGmv,

    // Commerce
    medianConversion: n(ps?.median_conversion),
    medianN: n(ps?.median_n),
    productsWithSales: n(ps?.products_with_sales),
    refundRate: n(ps?.refund_rate),
    discountAvailable: ps?.discount_available === true,

    // Workflow context
    daysSinceLastChange: n(f.daysSinceLastChange),
    openTests: f.openTests || [],

    // The ids a drill-down must replay
    decliningIds: f.decliningIds || [],
    weakProductIds: f.weakProductIds || [],
  };
}

/** Model confidence is NOT recommendation confidence, and never an R-squared. */
function modelConfidence(mg) {
  if (!mg || mg.status !== 'ok') return null;
  const v = mg.validation;
  const parts = [];
  // Interval tightness relative to the estimate.
  if (mg.marginal_roas && Array.isArray(mg.marginal_roas_ci)) {
    const width = mg.marginal_roas_ci[1] - mg.marginal_roas_ci[0];
    const ratio = Math.abs(width / mg.marginal_roas);
    parts.push(Math.max(0, 1 - ratio / 0.6));
  }
  // Out-of-sample skill against the naive baseline.
  if (v?.skill != null) parts.push(Math.max(0, Math.min(1, v.skill * 2)));
  // Sample size relative to the preferred, not the minimum.
  if (mg.days) parts.push(Math.min(1, mg.days / 30));
  if (mg.time_confounded) parts.push(0.4);
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
}

// ── 2. DATA CHECKS, PER ACTION ──────────────────────────────────────────────
// A failed historical job outside the selected period must not invalidate a
// complete current dataset; a missing current slice must not read as healthy
// because a different endpoint synced.
const CHECKS = {
  spend: (x) => (x.hasSpend
    ? { passed: true, name: 'ad spend available' }
    : { passed: false, name: 'ad spend available', detail: 'no GMV Max spend for this shop — the ad account is not connected in Reacher' }),

  notSimulated: (x) => (x.simulated
    ? { passed: false, name: 'spend is measured', detail: 'spend on this shop is simulated, so any sizing computed from it is a demonstration' }
    : { passed: true, name: 'spend is measured' }),

  marginal: (x) => (x.marginalStatus === 'ok'
    ? { passed: true, name: 'marginal return estimated' }
    : { passed: false, name: 'marginal return estimated', detail: `the spend-response model returned ${x.marginalStatus || 'no result'}` }),

  reconciled: (x) => (x.reconciliationStatus === 'exception'
    ? { passed: false, name: 'revenue reconciles', detail: `components differ from total shop GMV by ${pct(x.reconciliationPct, 1)}` }
    : { passed: true, name: 'revenue reconciles' }),

  capture: (x) => (x.capture != null && (x.capture < 0.85 || x.capture > 1.05)
    ? { passed: false, name: 'affiliate evidence complete', detail: `order lines account for ${pct(x.capture, 1)} of Seller Center's affiliate revenue` }
    : { passed: true, name: 'affiliate evidence complete' }),

  creativeSupply: (x) => (x.decliningShare != null && x.decliningShare >= 0.35
    ? { passed: false, name: 'creative can absorb more spend', detail: `${pct(x.decliningShare)} of video revenue is on declining creative` }
    : { passed: true, name: 'creative can absorb more spend' }),

  budgetConstrained: (x) => (x.utilisation != null && x.utilisation >= 0.85
    ? { passed: true, name: 'delivery is budget-constrained' }
    : {
        passed: false,
        name: 'delivery is budget-constrained',
        detail: x.utilisation == null
          ? 'daily budget or delivered spend is unknown, so there is no evidence the budget is the limit'
          : `spend is ${pct(x.utilisation)} of budget — the campaign is not spending what it already has`,
      }),

  cooldown: (x) => (x.daysSinceLastChange != null && x.daysSinceLastChange < COOLDOWN_DAYS
    ? { passed: false, name: 'no change still being read', detail: `a setting changed ${x.daysSinceLastChange} days ago; ${COOLDOWN_DAYS} are needed to read the result` }
    : { passed: true, name: 'no change still being read' }),
};

const run = (x, names) => names.map((k) => ({ key: k, ...CHECKS[k](x) }));

// ── 3. CANDIDATES ───────────────────────────────────────────────────────────
// Each returns null when it has nothing to say. Every one that DOES fire is
// kept, even if it will later lose — the losers become the suppressed list.

const cFixData = (x) => {
  const problems = [];
  if (x.reconciliationStatus === 'exception') {
    problems.push(`the channel components differ from total shop GMV by ${pct(x.reconciliationPct, 1)} (${money(x.reconciliationGap, x.currency)})`);
  }
  if (x.capture != null && x.capture > 1.02) {
    problems.push(`our order lines exceed Seller Center's own affiliate figure by ${pct(x.capture - 1, 1)}, which means the two sources are measuring on different bases`);
  }
  if (x.capture != null && x.capture < 0.85) {
    problems.push(`${pct(1 - x.capture)} of affiliate revenue has no order-line evidence`);
  }
  if (!problems.length) return null;

  // THE TITLE MUST NAME WHAT ACTUALLY FIRED.
  //
  // It was hardcoded to "Revenue does not reconcile against its own source" for
  // all three causes. On Cutler that is simply false — its components reconcile
  // to the cent; what is low is COVERAGE, because a quarter of affiliate
  // revenue sits in Partner-tab campaigns Reacher does not ingest yet. Seen on
  // screen in browser QA, sitting above a reconciliation status of "reconciled".
  const mismatched = x.reconciliationStatus === 'exception' || (x.capture != null && x.capture > 1.02);
  const title = mismatched
    ? 'Revenue does not reconcile against its own source'
    : `${pct(1 - x.capture)} of affiliate revenue has no order-line evidence`;

  return {
    action: ACTION.FIX_DATA,
    // A gap Reacher has already explained and is fixing is context, not a
    // repair task sitting at the top of someone's queue.
    severity: x.reconciliationStatus === 'exception' ? 'critical' : mismatched ? 'warning' : 'info',
    title,
    reason: mismatched
      ? `${problems.join('; ')}. Every share on this page has one of these as a denominator, so this outranks any conclusion drawn from them.`
      : `${problems.join('; ')}. The components still add up, so the figures are internally consistent — they simply describe the part of affiliate revenue we can see.`,
    actionText: mismatched
      ? 'Open Data status for the day-by-day breakdown, then raise the discrepancy with Reacher before moving budget on these figures.'
      : 'Nothing to repair here. Read every affiliate share on this page as a share of the Creator tab until Reacher ships Partner-tab ingestion.',
    evidence: problems,
    checks: run(x, ['reconciled', 'capture']),
    revenueAffected: x.totalGmv,
    // A data repair is not a media-buying opportunity, and mixing the two makes
    // a queue where neither can be worked through.
    lane: 'data',
    confidenceParts: [{ name: 'measured directly from both sources', value: 1 }],
  };
};

const cReviewCreative = (x) => {
  if (!x.trendMeasurable) return null;
  const share = x.decliningShare;
  const conc = x.top5Share;
  const bad = (share != null && share >= 0.35) || (conc != null && conc >= 0.5);
  if (!bad) return null;

  const bits = [];
  if (share != null && share >= 0.35) {
    bits.push(`${money(x.decliningGmv, x.currency)} — ${pct(share)} of video revenue — sits on ${x.decliningVideos} videos down more than 30% week on week`);
  }
  if (conc != null && conc >= 0.5) {
    bits.push(`the top 5 videos carry ${pct(conc)} of affiliate revenue`);
  }

  return {
    action: ACTION.REVIEW_CREATIVE,
    severity: share >= 0.5 || conc >= 0.6 ? 'critical' : 'warning',
    title: 'Creative is the constraint, not the budget',
    reason: `${bits.join(', and ')}. Spending harder against creative that is already fading raises cost per order rather than volume — the delivery finds the same audience with a weaker asset.`,
    actionText: 'Brief replacements before changing spend. Open the affected videos to see which are worth refreshing and which are simply finished.',
    evidence: bits,
    checks: run(x, ['capture']),
    revenueAffected: x.decliningGmv,
    affectedIds: x.decliningIds,
    drillTo: 'creatives',
    lane: 'media',
    confidenceParts: [
      { name: 'measured from classified order lines', value: 1 },
      { name: 'trend baseline coverage', value: x.baselineCoverage ?? 0.5 },
    ],
    // The whole point of the arbitration: this is what a scaling action loses to.
    suppresses: [ACTION.INCREASE_BUDGET, ACTION.DECREASE_TARGET_ROI, ACTION.TEST_MAX_DELIVERY],
    suppressWhy: 'a material creative constraint is live',
  };
};

const cIncreaseBudget = (x) => {
  if (x.marginalStatus !== 'ok' || x.marginal == null) return null;
  const floor = x.objective === OBJECTIVE.EFFICIENCY ? (x.avgRoas ?? 1) : 1;
  if (x.marginal < floor) return null;

  const checks = run(x, ['spend', 'notSimulated', 'marginal', 'creativeSupply', 'budgetConstrained', 'cooldown']);
  const band = sizeBand(BANDS.budget, x);
  const current = x.dailyBudget;
  const suggested = current != null ? current * (1 + band) : null;

  return {
    action: ACTION.INCREASE_BUDGET,
    usesSpend: true,
    severity: 'info',
    title: 'Room to raise budget',
    reason: `The next dollar is modelled to return ${x.marginal.toFixed(2)} in ${x.marginalTargetLabel || 'shop GMV'}${x.marginalCi ? ` (${x.marginalCi[0].toFixed(2)}–${x.marginalCi[1].toFixed(2)})` : ''}, against an average of ${x.avgRoas?.toFixed(2)}. That is above the floor this objective implies, so extra delivery is still worth buying.`,
    actionText: `Test a ${pct(band)} increase for ${testDays(x)} days and compare against the same period before it.`,
    evidence: [
      `marginal ${x.marginal.toFixed(2)} vs average ${x.avgRoas?.toFixed(2)}`,
      x.utilisation != null ? `spend is ${pct(x.utilisation)} of the current daily budget` : 'budget utilisation unknown',
      x.timeConfounded ? 'spend and the calendar move together — treat the size as indicative' : 'not confounded with a time trend',
    ],
    checks,
    currentValue: current,
    suggestedValue: suggested,
    changePct: band,
    changeAbs: suggested != null && current != null ? suggested - current : null,
    valueUnit: 'currency_per_day',
    testDays: testDays(x),
    revenueAffected: x.spend,
    drillTo: 'scenario',
    lane: 'media',
    confidenceParts: [
      { name: 'model confidence', value: x.modelConfidence ?? 0.3 },
      { name: 'evidence completeness', value: x.coverage ?? 0.5 },
      { name: 'delivery constrained', value: x.utilisation != null && x.utilisation >= 0.85 ? 1 : 0.2 },
    ],
  };
};

const cDecreaseBudget = (x) => {
  if (x.marginalStatus !== 'ok' || x.marginal == null) return null;
  if (x.marginal >= 1) return null;

  const band = sizeBand(BANDS.budget, x);
  const current = x.dailyBudget;
  return {
    action: ACTION.DECREASE_BUDGET,
    usesSpend: true,
    severity: 'warning',
    title: 'The next dollar is losing money',
    reason: `The marginal return is ${x.marginal.toFixed(2)} in ${x.marginalTargetLabel || 'shop GMV'} — below one. The campaign can still average ${x.avgRoas?.toFixed(2)} while the money being added to it does not pay for itself.`,
    actionText: `Reduce the daily budget by ${pct(band)} for ${testDays(x)} days and check whether total shop GMV holds.`,
    evidence: [
      `marginal ${x.marginal.toFixed(2)} against average ${x.avgRoas?.toFixed(2)}`,
      x.marginalCi ? `interval ${x.marginalCi[0].toFixed(2)}–${x.marginalCi[1].toFixed(2)}` : 'no interval',
    ],
    checks: run(x, ['spend', 'notSimulated', 'marginal', 'cooldown']),
    currentValue: current,
    suggestedValue: current != null ? current * (1 - band) : null,
    changePct: -band,
    valueUnit: 'currency_per_day',
    testDays: testDays(x),
    revenueAffected: x.spend,
    drillTo: 'scenario',
    lane: 'media',
    confidenceParts: [
      { name: 'model confidence', value: x.modelConfidence ?? 0.3 },
      { name: 'evidence completeness', value: x.coverage ?? 0.5 },
    ],
  };
};

// Target ROI is a DELIVERY setting — it tells the auction how hard to bid, not
// what the brand needs to break even. Lowering it is not a scaling instruction.
const cTargetRoi = (x) => {
  if (x.targetRoi == null || x.marginalStatus !== 'ok') return null;
  if (x.utilisation == null) return null;

  // Under-spending against budget with a high target: the target is throttling.
  const throttled = x.utilisation < 0.7 && x.marginal != null && x.marginal >= 1;
  if (!throttled) return null;

  const band = sizeBand(BANDS.target_roi, x);
  return {
    action: ACTION.DECREASE_TARGET_ROI,
    usesSpend: true,
    severity: 'info',
    title: 'Target ROI is throttling delivery',
    reason: `Spend is only ${pct(x.utilisation)} of the daily budget while the marginal return is still ${x.marginal.toFixed(2)}. The budget is not the limit — the bid is.`,
    actionText: `Lower Target ROI by ${pct(band)} for ${testDays(x)} days. Watch delivered spend and marginal return together; if spend rises and marginal falls below one, reverse it.`,
    evidence: [
      `utilisation ${pct(x.utilisation)}`,
      `Target ROI ${x.targetRoi.toFixed(2)}`,
      `marginal ${x.marginal.toFixed(2)}`,
    ],
    checks: run(x, ['spend', 'notSimulated', 'marginal', 'creativeSupply', 'cooldown']),
    currentValue: x.targetRoi,
    suggestedValue: x.targetRoi * (1 - band),
    changePct: -band,
    valueUnit: 'roi',
    testDays: testDays(x),
    revenueAffected: x.spend,
    lane: 'media',
    confidenceParts: [
      { name: 'model confidence', value: x.modelConfidence ?? 0.3 },
      { name: 'utilisation evidence', value: 1 },
    ],
  };
};

const cReviewListing = (x) => {
  if (x.medianConversion == null || !x.weakProductIds?.length) return null;
  return {
    action: ACTION.REVIEW_LISTING,
    severity: 'warning',
    title: `${x.weakProductIds.length} product${x.weakProductIds.length > 1 ? 's convert' : ' converts'} far below the shop`,
    reason: `Against a shop median of ${pct(x.medianConversion, 2)} — measured over ${x.medianN} products with enough traffic to be comparable — these turn clicks into orders at under 60% of that rate. Traffic is arriving and leaving. More spend buys more of the same leaving.`,
    actionText: 'Open the affected products and review price, images, reviews and stock before changing spend behind them.',
    evidence: [`shop median ${pct(x.medianConversion, 2)} from ${x.medianN} eligible products`],
    checks: run(x, []),
    affectedIds: x.weakProductIds,
    drillTo: 'products',
    lane: 'media',
    confidenceParts: [{ name: 'measured funnel', value: 1 }],
  };
};

const cHold = (x) => {
  if (x.daysSinceLastChange == null || x.daysSinceLastChange >= COOLDOWN_DAYS) return null;
  return {
    action: ACTION.HOLD,
    severity: 'info',
    title: 'Hold — a change is still being read',
    reason: `A setting changed ${x.daysSinceLastChange} day${x.daysSinceLastChange === 1 ? '' : 's'} ago. Stacking another change now makes both results uninterpretable, because nothing separates which one moved the number.`,
    actionText: `Watch delivered spend and total shop GMV. The next evaluation becomes eligible in ${COOLDOWN_DAYS - x.daysSinceLastChange} day(s).`,
    evidence: [`${x.daysSinceLastChange} days since the last change`, `cooldown ${COOLDOWN_DAYS} days`],
    checks: run(x, []),
    lane: 'media',
    confidenceParts: [{ name: 'change history', value: 1 }],
    suppresses: [ACTION.INCREASE_BUDGET, ACTION.DECREASE_BUDGET, ACTION.DECREASE_TARGET_ROI,
      ACTION.INCREASE_TARGET_ROI, ACTION.TEST_MAX_DELIVERY],
    suppressWhy: 'a recent change is still inside its cooldown',
  };
};

const cInsufficient = (x) => {
  if (x.marginalStatus === 'ok') return null;
  if (!x.hasSpend && !x.totalGmv) return null;
  return {
    action: ACTION.INSUFFICIENT_DATA,
    usesSpend: true,
    severity: 'info',
    title: 'Not enough evidence to size a spend change',
    reason: x.marginalReason || 'The spend-response model has not reached an actionable estimate for this shop.',
    actionText: x.marginalRecovery || 'Keep collecting. Until then, judge changes against the proven floor rather than the modelled marginal.',
    evidence: [
      x.hasSpend ? `${x.daysWithSpend ?? 0} days with spend` : 'no ad spend data',
      `model status: ${x.marginalStatus || 'not run'}`,
    ],
    checks: run(x, ['spend', 'marginal']),
    lane: 'media',
    missingInputs: x.hasSpend ? ['spend variation or history'] : ['ad account connection'],
    confidenceParts: [],
  };
};

const CANDIDATES = [
  cFixData, cReviewCreative, cIncreaseBudget, cDecreaseBudget,
  cTargetRoi, cReviewListing, cHold, cInsufficient,
];

// ── 4. SIZING ───────────────────────────────────────────────────────────────
// Evidence quality picks the band. Thin evidence gets the smallest test, not a
// smaller version of a confident recommendation.
function sizeBand(bands, x) {
  const conf = x.modelConfidence ?? 0.3;
  if (conf >= 0.7 && !x.timeConfounded && !x.marginalProvisional) return bands[2];
  if (conf >= 0.45 && !x.timeConfounded) return bands[1];
  return bands[0];
}

function testDays(x) {
  // A test has to run long enough for the target to move above its own noise.
  return (x.modelConfidence ?? 0) >= 0.6 ? 7 : 14;
}

// ── 5. SCORING ──────────────────────────────────────────────────────────────
const SEVERITY_WEIGHT = { critical: 100, warning: 60, info: 25, good: 5 };

function score(cand, x) {
  let s = SEVERITY_WEIGHT[cand.severity] ?? 10;

  // A blocked candidate can still be worth showing, but never worth winning.
  const failed = (cand.checks || []).filter((c) => !c.passed);
  s -= failed.length * 30;

  // Impact, on a log scale so one big shop does not dominate every ranking.
  const rev = n(cand.revenueAffected);
  if (rev && x.totalGmv) s += Math.min(20, (rev / x.totalGmv) * 20);

  // Confidence in the action itself.
  s += (confidence(cand) ?? 0.3) * 20;

  return s;
}

function confidence(cand) {
  const parts = (cand.confidenceParts || []).filter((p) => n(p.value) != null);
  if (!parts.length) return null;
  const v = parts.reduce((a, p) => a + Number(p.value), 0) / parts.length;
  // A failed hard check caps confidence — passing checks are what the number
  // is made of, so ignoring a failure would be self-contradictory.
  const failed = (cand.checks || []).filter((c) => !c.passed).length;
  return Math.max(0, Math.min(1, v * (failed ? 0.5 : 1)));
}

const label = (c) => (c == null ? 'unknown' : c >= 0.7 ? 'high' : c >= 0.45 ? 'moderate' : 'low');

// ── 6. ARBITRATION ──────────────────────────────────────────────────────────
/**
 * @returns {{primary, secondary, suppressed, all, lanes}} one decision, with
 * everything that lost and why.
 */
export function decide(facts = {}) {
  const x = features(facts);
  // Carry the model's own words through, rather than re-inventing them here.
  x.marginalReason = facts.marginal?.reason || null;
  x.marginalRecovery = facts.marginalRecovery || null;

  const raised = [];
  for (const c of CANDIDATES) {
    let r = null;
    try { r = c(x); } catch { r = null; }   // a broken candidate must not blank the page
    if (r) raised.push(r);
  }

  // Hard suppression first: a blocker removes the actions it blocks from
  // contention entirely, and records why against each of them.
  const suppressors = raised.filter((r) => r.suppresses?.length);
  const suppressed = [];
  const eligible = [];

  for (const r of raised) {
    const by = suppressors.find((s) => s !== r && s.suppresses.includes(r.action));
    if (by) {
      suppressed.push({ action_code: r.action, title: r.title, why: by.suppressWhy, suppressed_by: by.action });
    } else {
      eligible.push(r);
    }
  }

  // A candidate whose own data checks failed cannot be the primary action, but
  // it is not silently dropped either — it becomes visible with its blocker.
  const blocked = eligible.filter((r) => (r.checks || []).some((c) => !c.passed) && r.lane === 'media'
    && r.action !== ACTION.INSUFFICIENT_DATA && r.action !== ACTION.HOLD);
  for (const b of blocked) {
    const why = (b.checks || []).filter((c) => !c.passed).map((c) => c.detail || c.name).join('; ');
    suppressed.push({ action_code: b.action, title: b.title, why, suppressed_by: ACTION.FIX_DATA });
  }

  const contenders = eligible.filter((r) => !blocked.includes(r));
  const ranked = contenders
    .map((r) => ({ ...r, _score: score(r, x), confidence: confidence(r) }))
    .sort((a, b) => b._score - a._score);

  // EVERY candidate blocked is itself the answer, and the worst possible
  // response is a blank panel. A buyer whose only available action is gated on
  // a missing input needs to be told which input — the decision header renders
  // the failed guardrails as "Blocked by", so promoting the best blocked
  // candidate turns silence into the specific reason for the silence.
  if (!ranked.length && blocked.length) {
    const fallback = blocked
      .map((r) => ({ ...r, _score: score(r, x), confidence: confidence(r) }))
      .sort((a, b) => b._score - a._score);
    return {
      rule_version: RULE_VERSION,
      objective: x.objective,
      features: x,
      primary: shape(fallback[0], x, 'primary', suppressed),
      secondary: null,
      suppressed,
      all: fallback.map((r) => shape(r, x, 'primary', [])),
    };
  }

  const primary = ranked[0] || null;
  // A secondary must not be an incompatible way of doing the same thing.
  const secondary = ranked.find((r) =>
    r !== primary && r.lane !== primary?.lane) || ranked[1] || null;

  return {
    rule_version: RULE_VERSION,
    objective: x.objective,
    features: x,
    primary: primary ? shape(primary, x, 'primary', suppressed) : null,
    secondary: secondary ? shape(secondary, x, 'secondary', []) : null,
    suppressed,
    all: ranked.map((r) => shape(r, x, 'primary', [])),
  };
}

/** The typed contract the database stores and the UI renders. */
function shape(c, x, role, suppressedList) {
  const conf = c.confidence ?? confidence(c);
  return {
    fingerprint: `${c.action}:${x.shop?.id || 'shop'}:${(c.affectedIds || []).length}`,
    action_code: c.action,
    role,
    severity: c.severity,
    title: c.title,
    reason: c.reason,
    action_text: c.actionText,
    evidence: c.evidence || [],
    guardrails: (c.checks || []).map((k) => ({ name: k.name, passed: k.passed, detail: k.detail || null })),
    suppressed: suppressedList,
    affected_ids: c.affectedIds || [],
    drill_to: c.drillTo || null,
    lane: c.lane,
    current_value: c.currentValue ?? null,
    suggested_value: c.suggestedValue ?? null,
    change_abs: c.changeAbs ?? null,
    change_pct: c.changePct ?? null,
    value_unit: c.valueUnit ?? null,
    test_days: c.testDays ?? null,
    revenue_affected: c.revenueAffected ?? null,
    // Three separate claims, kept separate.
    confidence: conf,
    confidence_label: label(conf),
    confidence_parts: c.confidenceParts || [],
    model_confidence: x.modelConfidence,
    data_coverage: x.coverage,
    missing_inputs: c.missingInputs || [],
    // THE BASIS IS THE ACTION'S OWN, not the shop's.
    //
    // This read `x.simulated ? 'simulated' : …`, so on a shop with simulated ad
    // spend EVERY recommendation was stamped "simulated" — including a listing
    // review computed entirely from measured Seller Center funnel data. Seen on
    // screen in browser QA: "REVIEW LISTINGS · SIMULATED · HIGH CONFIDENCE".
    //
    // A badge that is wrong in the safe direction still teaches the reader to
    // ignore it, and then it is worthless in the direction that matters. The
    // basis is now the weakest input THIS action actually used.
    source_mode: c.usesSpend
      ? (x.simulated ? 'simulated' : 'modelled')
      : 'measured',
    rule_version: RULE_VERSION,
  };
}
