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

/**
 * The one place an action code becomes words a buyer reads.
 *
 * This map used to live inside Decisions.jsx, the component that first needed
 * it. The Evidence tab was written later, rendered the same `suppressed` array,
 * and never picked it up — so one screen said "Lower Target ROI" and the other
 * said `decrease_target_roi`. A label map that lives in one of its two consumers
 * is a label map the next consumer will miss, so it sits beside the enum it
 * labels and both screens import it from here.
 */
export const ACTION_LABEL = {
  [ACTION.INCREASE_BUDGET]: 'Raise budget',
  [ACTION.DECREASE_BUDGET]: 'Cut budget',
  [ACTION.INCREASE_TARGET_ROI]: 'Raise Target ROI',
  [ACTION.DECREASE_TARGET_ROI]: 'Lower Target ROI',
  [ACTION.TEST_MAX_DELIVERY]: 'Test Max Delivery',
  [ACTION.EXIT_MAX_DELIVERY]: 'Exit Max Delivery',
  [ACTION.HOLD]: 'Hold',
  [ACTION.REVIEW_CREATIVE]: 'Review creative',
  [ACTION.REVIEW_PROMOTION]: 'Review promotion',
  [ACTION.REVIEW_LISTING]: 'Review listings',
  [ACTION.FIX_DATA]: 'Data issue',
  [ACTION.INSUFFICIENT_DATA]: 'Collect more data',
};

/** Never render a bare action code. Falls back to the code so a new, unmapped
 *  action is visibly unlabelled rather than silently blank. */
export const actionLabel = (code) => ACTION_LABEL[code] || code;

/**
 * WHAT AN INTERVENTION ACTS ON, AND WHAT IT CANNOT PROMISE.
 *
 * A budget change and a Target ROI change were the same object with a different
 * `value_unit`, which is how a modelled "+10% spend" quietly reads as "+10%
 * budget", and how a bid setting comes to look like a promise about realised
 * return. They are different mechanisms:
 *
 *   * A BUDGET is a CAP. Raising it permits more spend; it does not create
 *     demand. If delivery never reaches the cap, moving the cap changes
 *     nothing — which is why the budget candidate is gated on evidence that
 *     the budget is actually binding.
 *   * A TARGET ROI is an AUCTION BID. Lowering it makes GMV Max bid harder and
 *     may buy more delivery. It does NOT set the realised ROI, and a 5% change
 *     in the setting does not imply a 5% change in the result. The spend
 *     elasticity must never be applied to it.
 *   * CREATIVE SUPPLY is neither: it changes what there is to deliver.
 *
 * `cannot_claim` is the load-bearing field. It is rendered, not decorative.
 */
export const MECHANISM = {
  [ACTION.INCREASE_BUDGET]: {
    acts_on: 'daily budget cap',
    expected_effect: 'more delivered spend — but only if the cap was binding',
    cannot_claim: 'that raising the cap raises spend when delivery never reached it',
    where: 'TikTok Ads Manager · campaign daily budget',
  },
  [ACTION.DECREASE_BUDGET]: {
    acts_on: 'daily budget cap',
    expected_effect: 'less delivered spend',
    cannot_claim: 'a proportional change in return',
    where: 'TikTok Ads Manager · campaign daily budget',
  },
  [ACTION.DECREASE_TARGET_ROI]: {
    acts_on: 'auction bid (the optimisation target)',
    expected_effect: 'more delivery, at a lower efficiency target',
    cannot_claim: 'that realised ROI will land on the new number, or move by the same percentage',
    where: 'TikTok Ads Manager · GMV Max Target ROI',
  },
  [ACTION.INCREASE_TARGET_ROI]: {
    acts_on: 'auction bid (the optimisation target)',
    expected_effect: 'less delivery, at a higher efficiency target',
    cannot_claim: 'that realised ROI will land on the new number',
    where: 'TikTok Ads Manager · GMV Max Target ROI',
  },
  [ACTION.REVIEW_CREATIVE]: {
    acts_on: 'creative supply',
    expected_effect: 'depends on what the review finds',
    cannot_claim: 'a spend or return figure — per-video spend is not available from the integration',
    where: 'TikTok Shop · the videos themselves',
  },
  [ACTION.FIX_DATA]: {
    acts_on: 'the evidence, not the account',
    expected_effect: 'no change to delivery',
    cannot_claim: 'any effect on performance',
    where: 'Reacher · ingestion',
  },
};

export const mechanismFor = (code) => MECHANISM[code] || null;

/**
 * Capability in three states — and only two are honestly reachable from here.
 *
 * Creative Boost cannot be confirmed SUPPORTED from read-only access: the only
 * definitive check Reacher offers is a create-shaped call, and this product
 * does not write to TikTok. So `unavailable` (something readable says no) and
 * `unknown` (we cannot tell) are what the app can determine; `supported`
 * requires an operator to confirm it in the platform and record when.
 * A capability nobody verified must never render as a ready action.
 */
export const CAPABILITY = { SUPPORTED: 'supported', UNAVAILABLE: 'unavailable', UNKNOWN: 'unknown' };

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

/**
 * Reduce per-campaign window states to the one fact a diagnosis needs: could
 * anything have been delivering during the reported days?
 *
 *   delivering    at least one campaign was active for part of the window
 *   paused        every campaign we can see was paused throughout
 *   unknown       no observation covers the window, so we cannot say
 *
 * `unknown` is the common answer and it is the important one. Snapshots began
 * 2026-09-08 and nothing earlier can be recovered, so for most historical
 * windows this returns unknown — and a diagnosis that depends on delivery must
 * decline rather than assume.
 */
export function deliveryWindowState(states) {
  if (!Array.isArray(states) || !states.length) return { state: 'unknown', known: 0, total: 0 };
  const known = states.filter((s) => s.window_state && s.window_state !== 'unknown');
  if (!known.length) return { state: 'unknown', known: 0, total: states.length };
  const anyLive = known.some((s) => s.window_state === 'active' || s.window_state === 'mixed');
  return {
    state: anyLive ? 'delivering' : 'paused',
    known: known.length,
    total: states.length,
    // Campaigns that were live for part of the window but not all of it. A
    // pause partway through is itself an explanation for revenue falling.
    partial: known.filter((s) => s.window_state === 'mixed').length,
  };
}

// ── RECONCILIATION HAS TWO THRESHOLDS, ON PURPOSE ───────────────────────────
//
// `recon_business_tolerance()` in the database is the REPORTING threshold. At
// 10% it decides whether a source disagreement is worth colouring on a screen.
// The owner asked for that and it was the right call: a ~1% gap between two
// providers, which nobody can close, was being painted as an exception on every
// page.
//
// It is NOT the right number for deciding how to spend money. This engine
// refuses to reason about channel SHARES while the components and the source
// total disagree materially — and "material enough to act on" is a much tighter
// bar than "worth mentioning". Sharing one number meant that quietening the
// screens silently also made the engine willing to size a budget on top of a 9%
// disagreement, which nobody asked for.
//
// So they are separated: screens at 10% (the database), decisions at 3% (here).
//
// Below 3% the engine treats the components as usable — that is what fixes the
// real complaint, because at Biostime's ~1% gap `fix_data` no longer outranks
// every media action. Between 3% and 10% the screens stay quiet and the engine
// stays cautious. That band has not occurred in live data; it is a guard, not a
// behaviour anyone sees today.
export const DECISION_RECON_TOLERANCE = 0.03;

// The band affiliate order-line coverage must sit inside for an action that
// reasons about affiliate SHARES. It is a tolerance, not a definition of
// agreement: at the low end 15% of reported affiliate revenue can be missing
// and the check still passes, which is why the check names the shortfall even
// when it passes. Above the top end our lines EXCEED the source, which is a
// different failure — the two are counting different things.
export const CAPTURE_BAND = [0.85, 1.05];

/**
 * Does the component/total disagreement exceed what a DECISION can tolerate?
 * Deliberately independent of `reconciliation_status`, which now answers the
 * reporting question and would say "rounding" at 9%.
 */
function reconExceedsDecisionTolerance(a) {
  if (!a) return false;
  // 'reconciled' is exact agreement, or agreement inside the ABSOLUTE rounding
  // tolerance. A sub-dollar gap is not a data problem at any percentage, and on
  // a near-zero-GMV window the percentage is meaningless.
  if (a.reconciliation_status === 'reconciled') return false;
  const p = n(a.reconciliation_pct);
  if (p == null) return false;
  return Math.abs(p) > DECISION_RECON_TOLERANCE;
}

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
    // FOUR DIFFERENT QUESTIONS, four different names. They were being conflated:
    //   capture         — do our order lines and Seller Center AGREE on a total?
    //   sourceCoverage  — did every DAY of the window actually arrive?
    //   coverage        — what SHARE of shop GMV carries a commission signal?
    //   reconciliation* — do the components sum to the source total?
    // `sourceCoverage` is the one that was missing entirely: nothing in the
    // decision pipeline consulted date completeness, so a guardrail named
    // "affiliate evidence complete" passed on a window with a missing day.
    sourceCoverage: Array.isArray(f.sourceHealth) ? f.sourceHealth : null,
    coverage: n(a?.attribution_coverage),
    // REPORTING ONLY. This is the database's 10% verdict, kept so a panel can
    // show what the screens show. NOTHING in the decision pipeline may read
    // it — that was the bug this separation fixes. Use reconExceedsDecision.
    reconciliationStatus: a?.reconciliation_status || null,
    reconciliationGap: n(a?.reconciliation_gap),
    reconciliationPct: n(a?.reconciliation_pct),
    // The DECISION view of the same gap — see DECISION_RECON_TOLERANCE.
    // Every candidate and guardrail below reads this, never the status.
    reconExceedsDecision: reconExceedsDecisionTolerance(a),
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
    // PROVENANCE FOR THE DENOMINATOR. `utilisation` divides a mean over the
    // model's training days by ONE reading of the budget as it stands now.
    // Those belong to different periods, and the ratio cannot say so on its own.
    settingsCoverWindow: f.settingsCoverWindow === true,
    settingsFrom: f.settingsFrom ? String(f.settingsFrom).slice(0, 10) : null,
    modelDays: n(mg?.days),
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

    // ── DELIVERY EVIDENCE: WAS THE VIDEO STILL BEING SHOWN? ─────────────────
    //
    // Falling revenue on a video has at least two ordinary explanations, and
    // they call for opposite actions: the creative stopped working, or it
    // stopped being DELIVERED. Telling them apart needs per-video exposure
    // inside the reporting window — impressions or spend, at the video grain.
    //
    // We do not have it. video_performance carries `views`, which is LIFETIME
    // and does not move with the report's date filter, so it cannot say whether
    // a video was shown during these particular days. Reacher exposes no
    // per-video spend at all. Passed in rather than hardcoded so a future
    // integration can supply it and the strong branch below becomes reachable
    // without touching the reasoning.
    deliveryEvidence: f.deliveryEvidence || CAPABILITY.UNAVAILABLE,

    // What each campaign was doing DURING the report, from campaign_state_in_
    // window(). Current status cannot answer it: campaigns that are paused now
    // may have run all week, and revenue falling after a known pause is not
    // evidence that the creative decayed. `unknown` is the honest answer for
    // any window our snapshots do not cover, and it stays `unknown` — never
    // extrapolated backwards from today.
    campaignWindowStates: Array.isArray(f.campaignWindowStates) ? f.campaignWindowStates : null,
    // Target ROI headroom, keyed by direction, from roi_headroom (migration
    // 034). Absent until an episode exists, which is the normal state — and
    // the reason no action here may size a step from a default band.
    roiHeadroom: f.roiHeadroom || null,

    // ── WHAT HAPPENED LAST TIME WE DID THIS ─────────────────────────────────
    // Keyed by action code, from reviewed_history_summary (migration 036).
    // Every layer before this one RECORDED; this is the first that reads back,
    // so a change that breached a guardrail last month can raise caution on the
    // next identical recommendation instead of being written down and forgotten.
    reviewedHistory: f.reviewedHistory || null,
    // The diagnostic window is anchored to the CUTOFF and no longer follows the
    // report length. Both are carried so a recommendation can state which
    // window its evidence came from.
    diagnosticStart: c?.diagnostic_start || null,
    diagnosticEnd: c?.diagnostic_end || null,
    decliningOutsideReport: n(c?.declining_outside_report),
    noBaselineVideos: n(c?.no_baseline_videos),
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

  // JUDGED AT THE DECISION THRESHOLD, NOT THE REPORTING ONE. This gate is
  // what stops the engine sizing a budget from channel shares that do not
  // add up, so it keeps its own 3% bar even though the screens now go quiet
  // until 10%. See DECISION_RECON_TOLERANCE.
  reconciled: (x) => (x.reconExceedsDecision
    ? { passed: false, name: 'revenue reconciles', detail: `components differ from total shop GMV by ${pct(x.reconciliationPct, 1)}` }
    : { passed: true, name: 'revenue reconciles' }),

  // ── WAS THE CREATIVE STILL BEING SHOWN? ─────────────────────────────────
  // The check that decides whether a creative DIAGNOSIS is permitted at all.
  // Revenue falling on a video means the creative stopped working OR it stopped
  // being delivered, and those call for opposite actions. Separating them needs
  // per-video exposure inside the window, which the integration does not
  // provide (`views` is lifetime and does not move with the date filter). So
  // this fails, deliberately and permanently, until a source supplies it.
  deliveryEvidence: (x) => (x.deliveryEvidence === CAPABILITY.SUPPORTED
    ? { passed: true, name: 'delivery evidence available for the affected videos' }
    : {
        passed: false,
        name: 'delivery evidence available for the affected videos',
        detail: x.deliveryEvidence === CAPABILITY.UNKNOWN
          ? 'whether per-video delivery can be read from this account has not been established'
          : 'no per-video impressions or spend inside the report window — lifetime views cannot show whether a video was still being shown during these days',
      }),

  // ── WAS ANYTHING RUNNING? ───────────────────────────────────────────────
  // Three states, because "we know it was paused" and "we cannot tell" lead
  // somewhere different. A pause is an explanation; not knowing is a reason to
  // go and look.
  campaignStateKnown: (x) => {
    const d = deliveryWindowState(x.campaignWindowStates);
    if (d.state === 'unknown') {
      return {
        passed: false,
        name: 'campaign state during the report is known',
        detail: x.campaignWindowStates
          ? 'no settings observation covers these dates — campaign history began 2026-09-08 and earlier state cannot be recovered'
          : 'campaign state for the reported days was not retrieved',
      };
    }
    if (d.state === 'paused') {
      return {
        passed: false,
        name: 'campaign state during the report is known',
        detail: `every campaign observed in this window was paused, so falling revenue follows a delivery stop rather than a creative decline`,
      };
    }
    return {
      passed: true,
      name: 'campaign state during the report is known',
      detail: d.partial
        ? `${d.partial} campaign${d.partial === 1 ? '' : 's'} changed state during the window`
        : undefined,
    };
  },

  // NAMED FOR WHAT IT MEASURES. This tests whether two sources AGREE on the
  // affiliate total — it says nothing whatever about whether every day of the
  // window arrived. It was called "affiliate evidence complete", and it read
  // green beside an affiliate feed whose coverage ended a day before the report.
  // Agreement and completeness are different questions with different fixes,
  // and one of them was wearing the other's name. Date completeness is checked
  // separately by `datesComplete` below, from shop_source_health.
  // ── COVERAGE, AND THE BAND THIS ACTION NEEDS IT TO BE IN ────────────────
  //
  // It was called "affiliate totals agree with Seller Center", and at 90.3% it
  // PASSED and said the totals agree. They do not: 9.7% of the affiliate
  // revenue Seller Center reports has no order line behind it. What is true is
  // narrower — coverage is inside the band this particular action needs — and
  // the check now says exactly that instead of upgrading a tolerance into an
  // agreement. A passed check must never read as a clean bill the source
  // diagnostics contradict.
  capture: (x) => {
    const lo = CAPTURE_BAND[0];
    const hi = CAPTURE_BAND[1];
    const name = `affiliate order lines cover ${pct(lo, 0)}–${pct(hi, 0)} of the reported total`;
    if (x.capture == null) {
      return { passed: false, name, detail: 'affiliate capture has not been measured for this window' };
    }
    if (x.capture < lo || x.capture > hi) {
      return {
        passed: false,
        name,
        detail: x.capture > hi
          ? `our order lines exceed Seller Center's affiliate figure by ${pct(x.capture - 1, 1)}, so the two sources are measuring on different bases`
          : `our order lines account for ${pct(x.capture, 1)} of Seller Center's affiliate revenue, below the ${pct(lo, 0)} this action needs — ${pct(1 - x.capture, 1)} has no order-line evidence`,
      };
    }
    return {
      passed: true,
      name,
      // Names the shortfall even on the pass. The band is a tolerance for THIS
      // action, not a statement that nothing is missing.
      detail: x.capture < 1
        ? `our order lines account for ${pct(x.capture, 1)}, inside the band this action tolerates — ${pct(1 - x.capture, 1)} of affiliate revenue still has no order-line evidence and is not counted as measured`
        : `our order lines account for ${pct(x.capture, 1)} of Seller Center's affiliate figure`,
    };
  },

  // THE CHECK THAT WAS MISSING. Whether the days actually arrived — from
  // shop_source_health, which measures coverage against the requested window
  // rather than inferring it from a ratio that can look healthy on partial data.
  datesComplete: (x) => {
    if (!x.sourceCoverage || !x.sourceCoverage.length) {
      return {
        passed: false, available: false, name: 'every day of the report arrived',
        detail: 'source coverage has not been checked for this window',
      };
    }
    const short = x.sourceCoverage.filter((s) => Number(s.missing_days) > 0);
    if (!short.length) return { passed: true, name: 'every day of the report arrived' };
    return {
      passed: false,
      name: 'every day of the report arrived',
      detail: short
        .map((s) => `${s.source} is missing ${s.missing_days} day${Number(s.missing_days) === 1 ? '' : 's'}`
          + `${s.coverage_end ? ` (through ${s.coverage_end})` : ''}`)
        .join('; '),
    };
  },

  // A CHECK WITH NO EVIDENCE IS UNAVAILABLE, NEVER PASSED.
  //
  // This is the defect that mattered most in the 9 September review. A 7-day
  // report discarded the creative comparison window, so decliningShare came
  // back as 0, this guardrail PASSED, and the recommendation flipped from
  // "Review creative" (23 videos carrying 46% of video revenue) to "Lower
  // Target ROI" — on identical data at an identical cutoff. Missing evidence
  // must never read as evidence of absence.
  creativeSupply: (x) => {
    if (!x.trendMeasurable || x.baselineCoverage == null || x.baselineCoverage === 0) {
      return {
        passed: false, available: false, name: 'creative can absorb more spend',
        detail: 'no prior-week comparison is available, so creative capacity cannot be confirmed either way',
      };
    }
    if (x.decliningShare != null && x.decliningShare >= 0.35) {
      return {
        passed: false, name: 'creative can absorb more spend',
        detail: `${pct(x.decliningShare)} of video revenue is on declining creative`,
      };
    }
    return { passed: true, name: 'creative can absorb more spend' };
  },

  // THREE STATES, for the same reason creativeSupply has three.
  //
  // The ratio divides the model's mean daily spend — an average over its
  // TRAINING days — by the daily budget as it reads RIGHT NOW. When no setting
  // is on record for the days analysed, those are different periods and the
  // ratio cannot establish what constrained delivery then. Settings snapshots
  // began 2026-09-08 and Reacher exposes no endpoint returning past values, so
  // for the 09-01→09-07 report there is no budget on file for a single day it
  // covers. Saying "the campaign is not spending what it already has" states a
  // present-tense fact about the campaign; the evidence supports no such claim,
  // and this string is what reaches the operator as the reason a budget change
  // was rejected.
  budgetConstrained: (x) => {
    if (x.utilisation == null) {
      return {
        passed: false, available: false, name: 'delivery is budget-constrained',
        detail: 'daily budget or delivered spend is unknown, so there is no evidence the budget is the limit',
      };
    }
    if (!x.settingsCoverWindow) {
      return {
        passed: false, available: false, name: 'delivery is budget-constrained',
        detail: `no campaign setting is recorded for these dates${x.settingsFrom ? ` — settings history begins ${x.settingsFrom}` : ''}`
          + `, so whether the budget bound delivery cannot be established. The ${pct(x.utilisation)} figure divides the model's`
          + ` mean daily spend across ${x.modelDays ?? 'its'} observed days by the budget set today, which are different periods.`,
      };
    }
    return x.utilisation >= 0.85
      ? { passed: true, name: 'delivery is budget-constrained' }
      : {
          passed: false,
          name: 'delivery is budget-constrained',
          detail: `spend is ${pct(x.utilisation)} of budget — the campaign is not spending what it already has`,
        };
  },

  cooldown: (x) => (x.daysSinceLastChange != null && x.daysSinceLastChange < COOLDOWN_DAYS
    ? { passed: false, name: 'no change still being read', detail: `a setting changed ${x.daysSinceLastChange} days ago; ${COOLDOWN_DAYS} are needed to read the result` }
    : { passed: true, name: 'no change still being read' }),
};

const run = (x, names) => names.map((k) => ({ key: k, ...CHECKS[k](x) }));

/**
 * Every check that EXISTS, so a stored recommendation can say which ones it
 * did not consult.
 *
 * Each candidate runs only the checks relevant to its own action — a creative
 * review does not need spend data, and gating it on spend would be the
 * action-specific-checks rule broken in the other direction. But a row that
 * records only what it ran cannot be told apart from a row where everything
 * passed. Absence of a check is not a pass, and the record now says which is
 * which.
 */
const CHECK_KEYS = Object.keys(CHECKS);

/**
 * WHAT WOULD COUNT AS THE TEST WORKING, and when to stop.
 *
 * Migration 023 added success_criterion and review_min_days and nothing filled
 * them, so recommendation_outcome() computed a change with nothing to judge it
 * against — a number with no threshold is not a result. These come from the
 * MECHANISM: the criterion has to be about the thing the lever actually moves,
 * which is why a Target ROI test is judged on delivery and efficiency rather
 * than on the setting landing where it was set.
 */
const REVIEW = {
  [ACTION.INCREASE_BUDGET]: {
    success: 'delivered spend rises toward the new cap AND total shop GMV rises with it',
    stop: 'delivered spend does not move within the hold period — the cap was not the limit',
    minDays: 7,
  },
  [ACTION.DECREASE_BUDGET]: {
    success: 'spend falls as intended without a disproportionate fall in shop GMV',
    stop: 'shop GMV falls faster than spend',
    minDays: 7,
  },
  [ACTION.DECREASE_TARGET_ROI]: {
    // TikTok's own Product GMV Max guidance: hold an ROI change at least three
    // full days before adjusting again. Checked 2026-09-09. Used as a documented
    // minimum, not as proof of what this account supports.
    success: 'delivery increases and total shop GMV rises; realised return stays above the floor',
    stop: 'spend rises while proven return falls below the floor — reverse it',
    minDays: 7,
    holdDays: 3,
    holdWhy: "TikTok's Product GMV Max guidance asks for at least three full days on an ROI setting before changing it again",
  },
  [ACTION.INCREASE_TARGET_ROI]: {
    success: 'efficiency improves without losing more GMV than the spend saved',
    stop: 'delivery collapses — the bid is now too conservative to compete',
    minDays: 7,
    holdDays: 3,
    holdWhy: "TikTok's Product GMV Max guidance asks for at least three full days on an ROI setting before changing it again",
  },
  [ACTION.REVIEW_CREATIVE]: {
    success: 'the declining set stops growing and new videos start earning',
    stop: 'nothing here is a stopping rule — a review is an inspection, not a test',
    minDays: 7,
  },
  [ACTION.FIX_DATA]: {
    success: 'the days that disagreed reconcile, or the disagreement is explained by the source',
    stop: 'not applicable — this changes evidence, not delivery',
    minDays: 0,
  },
};

// ── 3. CANDIDATES ───────────────────────────────────────────────────────────
// Each returns null when it has nothing to say. Every one that DOES fire is
// kept, even if it will later lose — the losers become the suppressed list.

const cFixData = (x) => {
  const problems = [];
  if (x.reconExceedsDecision) {
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
  const mismatched = x.reconExceedsDecision || (x.capture != null && x.capture > 1.02);
  const title = mismatched
    ? 'Revenue does not reconcile against its own source'
    : `${pct(1 - x.capture)} of affiliate revenue has no order-line evidence`;

  return {
    action: ACTION.FIX_DATA,
    // A gap Reacher has already explained and is fixing is context, not a
    // repair task sitting at the top of someone's queue.
    severity: x.reconExceedsDecision ? 'critical' : mismatched ? 'warning' : 'info',
    title,
    // SCOPED TO WHAT IT ACTUALLY AFFECTS.
    //
    // This used to say the finding "outranks any conclusion drawn from them",
    // which claimed a precedence the arbitration does not enforce: cFixData is
    // the one candidate with no `suppresses` list, so a reconciliation exception
    // removes nothing from the ranking. The drawer then showed "Lower Target
    // ROI" beside a sentence saying every conclusion was outranked — two
    // assertions that cannot both be true.
    //
    // The narrower sentence is also the more accurate one. It is the affiliate
    // and channel SHARES that share this denominator; a Target ROI or creative
    // decision measured from order lines does not, and the file's own principle
    // at the top is that data checks are action-specific.
    reason: mismatched
      ? `${problems.join('; ')}. The affiliate and channel shares on Attribution have one of these as a denominator, so read those with this in mind.`
      : `${problems.join('; ')}. The components still add up, so the figures are internally consistent — they simply describe the part of affiliate revenue we can see.`,
    actionText: mismatched
      ? 'Open Data status for the day-by-day breakdown, then raise the discrepancy with Reacher before moving budget on the affiliate figures.'
      : 'Nothing to repair here. Read every affiliate share on this page as a share of the Creator tab until Reacher ships Partner-tab ingestion.',
    evidence: problems,
    checks: run(x, ['reconciled', 'capture', 'datesComplete']),
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

  // ── WHAT THIS OBSERVATION DOES AND DOES NOT ESTABLISH ────────────────────
  //
  // It used to be titled "Creative is the constraint, not the budget", assert
  // that spending harder "raises cost per order rather than volume", and
  // instruct the operator to brief replacements. All three are causal claims,
  // and the evidence behind them is a list of videos whose revenue fell.
  //
  // A list of declining videos is an OBSERVATION. Revenue can fall because the
  // creative stopped working, or because it stopped being delivered, or because
  // the product went out of stock, or because the campaign was paused. Choosing
  // the first of those and calling it the constraint is a diagnosis the data
  // cannot carry — and it then suppressed every budget and Target ROI
  // alternative on the strength of it.
  //
  // So the finding is now graded by the evidence actually present:
  //
  //   paused      campaigns observed paused through the window. Revenue fell
  //               after delivery stopped. Creative decline is not the leading
  //               explanation and must not be presented as one.
  //   unverified  no per-video delivery evidence, or campaign state unknown.
  //               An INVESTIGATION. It names the videos and the dates, and it
  //               suppresses NOTHING, because an unproven constraint has no
  //               business vetoing a budget decision.
  //   supported   delivery evidence exists and shows continued exposure. Only
  //               here may the finding claim creative is the binding
  //               constraint. Unreachable today; the branch stays so that
  //               acquiring the evidence changes the output, not the reasoning.
  const delivery = deliveryWindowState(x.campaignWindowStates);
  const hasDeliveryEvidence = x.deliveryEvidence === CAPABILITY.SUPPORTED;
  const grade = delivery.state === 'paused' ? 'paused'
    : (hasDeliveryEvidence && delivery.state === 'delivering') ? 'supported'
      : 'unverified';

  const checks = run(x, ['capture', 'deliveryEvidence', 'campaignStateKnown', 'datesComplete']);
  const common = {
    action: ACTION.REVIEW_CREATIVE,
    shortFinding: (y) => `${y.decliningVideos} videos carrying ${pct(y.decliningShare)} of video revenue declined more than 30%`,
    evidence: bits,
    checks,
    revenueAffected: x.decliningGmv,
    affectedIds: x.decliningIds,
    drillTo: 'creatives',
    lane: 'media',
  };

  if (grade === 'paused') {
    return {
      ...common,
      severity: 'info',
      title: 'Video revenue fell while campaigns were paused',
      reason: `${bits.join(', and ')}. Every campaign observed in this window was paused, so the fall follows delivery stopping. That is not evidence the creative stopped working, and refreshing assets would not address it.`,
      actionText: 'Check why delivery is stopped before judging the creative. The videos are listed so their performance can be read against the period they were actually being shown.',
      confidenceParts: [
        { name: 'measured from classified order lines', value: 1 },
        { name: 'campaign state observed in window', value: delivery.known / (delivery.total || 1) },
      ],
      // Says nothing about budget or Target ROI, so it vetoes neither.
      suppresses: [],
    };
  }

  if (grade === 'supported') {
    return {
      ...common,
      severity: share >= 0.5 || conc >= 0.6 ? 'critical' : 'warning',
      title: 'Creative is the constraint, not the budget',
      reason: `${bits.join(', and ')}, while delivery continued through the window. With exposure held and revenue falling, the assets are the limiting factor rather than the spend behind them.`,
      actionText: 'Brief replacements before changing spend. Open the affected videos to see which are worth refreshing and which are simply finished.',
      confidenceParts: [
        { name: 'measured from classified order lines', value: 1 },
        { name: 'trend baseline coverage', value: x.baselineCoverage ?? 0.5 },
        { name: 'delivery confirmed in window', value: 1 },
      ],
      // Only a DEMONSTRATED constraint outranks a scaling action.
      suppresses: [ACTION.INCREASE_BUDGET, ACTION.DECREASE_TARGET_ROI, ACTION.TEST_MAX_DELIVERY],
      suppressWhy: 'creative is shown to be the binding constraint: delivery held while revenue fell',
    };
  }

  const missing = [];
  if (!hasDeliveryEvidence) missing.push('whether these videos were still being delivered');
  if (delivery.state === 'unknown') missing.push('whether the campaigns were running during these dates');

  return {
    ...common,
    // An investigation is worth doing, and it is not an emergency. Severity is
    // what SEVERITY_WEIGHT scores on, so overstating it here is how an
    // unproven finding wins a ranking it has not earned.
    severity: 'warning',
    title: 'Video revenue is falling, and delivery cannot be verified',
    reason: `${bits.join(', and ')}. What this does not establish is ${missing.join(', or ')}. Falling revenue on a video is consistent with a creative that stopped working and with one that stopped being shown, and the two call for opposite actions.`,
    actionText: 'Open the affected videos and check delivery before deciding anything about the assets. If they are still being shown, the creative is the next thing to look at; if they are not, that is the finding.',
    confidenceParts: [
      { name: 'measured from classified order lines', value: 1 },
      { name: 'trend baseline coverage', value: x.baselineCoverage ?? 0.5 },
      { name: 'delivery evidence', value: 0 },
    ],
    // SUPPRESSES NOTHING. This is the change that matters most: an unproven
    // creative constraint used to veto every budget and Target ROI alternative,
    // so a generic creative flag decided the whole page. Those actions now
    // stand or fall on their own guardrails.
    suppresses: [],
  };
};

const cIncreaseBudget = (x) => {
  if (x.marginalStatus !== 'ok' || x.marginal == null) return null;
  const floor = x.objective === OBJECTIVE.EFFICIENCY ? (x.avgRoas ?? 1) : 1;
  if (x.marginal < floor) return null;

  const checks = run(x, ['spend', 'notSimulated', 'marginal', 'creativeSupply', 'budgetConstrained', 'datesComplete', 'cooldown']);
  const band = sizeBand(BANDS.budget, x);
  const current = x.dailyBudget;
  const suggested = current != null ? current * (1 + band) : null;

  return {
    action: ACTION.INCREASE_BUDGET,
    usesSpend: true,
    severity: 'info',
    title: 'Room to raise budget',
    shortFinding: (x) => `The next dollar is modelled to return ${x.marginal?.toFixed(2)} against an average of ${x.avgRoas?.toFixed(2)}`,
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
    shortFinding: (x) => `Marginal return ${x.marginal?.toFixed(2)} — below one, while the average is ${x.avgRoas?.toFixed(2)}`,
    reason: `The marginal return is ${x.marginal.toFixed(2)} in ${x.marginalTargetLabel || 'shop GMV'} — below one. The campaign can still average ${x.avgRoas?.toFixed(2)} while the money being added to it does not pay for itself.`,
    actionText: `Reduce the daily budget by ${pct(band)} for ${testDays(x)} days and check whether total shop GMV holds.`,
    evidence: [
      `marginal ${x.marginal.toFixed(2)} against average ${x.avgRoas?.toFixed(2)}`,
      x.marginalCi ? `interval ${x.marginalCi[0].toFixed(2)}–${x.marginalCi[1].toFixed(2)}` : 'no interval',
    ],
    checks: run(x, ['spend', 'notSimulated', 'marginal', 'datesComplete', 'cooldown']),
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

  // ── THE SIZE COMES FROM EVIDENCE, OR IT DOES NOT COME AT ALL ─────────────
  //
  // This used to say "Lower Target ROI by 10%" and set suggestedValue to
  // targetRoi × 0.9, from sizeBand(BANDS.target_roi) — a default ladder applied
  // to every campaign on every shop. Nothing in that number came from this
  // campaign, because no history of this campaign was ever consulted. On screen
  // it reads as a considered figure, and it is not one.
  //
  // The OBSERVATION is sound and stays: spend well under the cap while the
  // marginal return is still above one means the bid is the limit, not the
  // budget. What does not follow is how far to move it. That depends on how
  // this campaign has responded to Target ROI changes before, and until an
  // episode exists (see roi_headroom, migration 034) the honest answer is that
  // the operator chooses the size and the tool says what to watch.
  const hr = x.roiHeadroom?.looser || null;
  const evidenced = hr?.status === 'eligible_for_review' && hr?.candidate != null;

  return {
    action: ACTION.DECREASE_TARGET_ROI,
    usesSpend: true,
    severity: 'info',
    title: 'Target ROI is throttling delivery',
    shortFinding: (y) => `Spend is ${pct(y.utilisation)} of budget while the marginal return is still ${y.marginal?.toFixed(2)}`,
    reason: `Spend is only ${pct(x.utilisation)} of the daily budget while the marginal return is still ${x.marginal.toFixed(2)}. The budget is not the limit — the bid is.`,
    actionText: evidenced
      ? `Lower Target ROI toward ${hr.candidate.toFixed(2)} for ${testDays(x)} days — a level this campaign has actually run at, from ${hr.episodes_eligible} recorded changes. Watch delivered spend and marginal return together; if spend rises and marginal falls below one, reverse it.`
      : `Lower Target ROI for ${testDays(x)} days and watch delivered spend and marginal return together; if spend rises and marginal falls below one, reverse it. ${hr?.supported_note || 'No Target ROI change has been observed on this campaign yet, so there is nothing to size a step from.'} Choose the step yourself and record it, and the next one can be sized from what this campaign actually did.`,
    evidence: [
      `utilisation ${pct(x.utilisation)}`,
      `Target ROI ${x.targetRoi.toFixed(2)}`,
      `marginal ${x.marginal.toFixed(2)}`,
      evidenced
        ? `${hr.episodes_eligible} usable Target ROI changes on record, between ${hr.observed_min} and ${hr.observed_max}`
        : 'no usable Target ROI change on record for this campaign',
    ],
    checks: run(x, ['spend', 'notSimulated', 'marginal', 'creativeSupply', 'datesComplete', 'cooldown']),
    currentValue: x.targetRoi,
    // NULL, deliberately, when nothing supports a figure. A suggested value is
    // rendered as a proposal and stored on the recommendation record; inventing
    // one here would put a fabricated number into the decision history.
    suggestedValue: evidenced ? hr.candidate : null,
    changePct: evidenced && x.targetRoi ? (hr.candidate / x.targetRoi) - 1 : null,
    // Says out loud where the number came from, or that there is none.
    candidateBasis: evidenced ? 'observed_episodes' : 'operator_must_choose',
    valueUnit: 'roi',
    testDays: testDays(x),
    revenueAffected: x.spend,
    lane: 'media',
    confidenceParts: [
      { name: 'model confidence', value: x.modelConfidence ?? 0.3 },
      { name: 'utilisation evidence', value: 1 },
      { name: 'setting-response evidence', value: evidenced ? 0.7 : 0 },
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
    shortFinding: (x) => `A setting changed ${x.daysSinceLastChange} day(s) ago; ${COOLDOWN_DAYS} are needed to read the result`,
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

  // ── WHAT HAPPENED LAST TIME ──────────────────────────────────────────────
  //
  // ASYMMETRIC, ON PURPOSE. A comparable change that went badly pushes this
  // action down hard; a comparable change that went well lifts it barely at
  // all. That is not timidity — the two errors are not the same size. Repeating
  // a change that breached a guardrail costs real money on a live shop;
  // declining to repeat one that worked costs an opportunity that will come
  // round again next week.
  //
  // Small numbers, deliberately. This is CASE SUPPORT, not a fitted effect: a
  // handful of reviewed outcomes may nudge a ranking, and must never be able to
  // overturn a failed guardrail, which costs 30 apiece above.
  const hist = historyFor(x, cand.action);
  if (hist) {
    if (hist.status === 'caution_from_history') s -= 12;
    else if (hist.status === 'supported_by_history') s += 4;
    // single_case, all_cases_confounded and no_reviewed_history move nothing.
    // One good result is a case, not evidence of a response.
  }

  return s;
}

/**
 * The reviewed history relevant to one action.
 *
 * Budget and Target ROI changes are looked up by their own action code; a
 * direction is deliberately NOT collapsed, because "we raised it and it went
 * badly" says little about lowering it.
 */
export function historyFor(x, action) {
  const h = x?.reviewedHistory;
  if (!h || !action) return null;
  return h[action] || null;
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

const safeShort = (fn, x) => { try { return fn(x) || null; } catch { return null; } };

/** The typed contract the database stores and the UI renders. */
function shape(c, x, role, suppressedList) {
  const conf = c.confidence ?? confidence(c);
  return {
    fingerprint: `${c.action}:${x.shop?.id || 'shop'}:${(c.affectedIds || []).length}`,
    action_code: c.action,
    role,
    severity: c.severity,
    title: c.title,
    // A single line with real values, for the priority strip. The full title
    // and reason stay untouched for the drawer.
    short_finding: typeof c.shortFinding === 'function' ? safeShort(c.shortFinding, x) : (c.shortFinding || c.title),
    reason: c.reason,
    action_text: c.actionText,
    evidence: c.evidence || [],
    guardrails: (c.checks || []).map((k) => ({
      name: k.name, passed: k.passed,
      // Three states, not two: passed, failed, or unavailable. A check that
      // could not be evaluated is not a check that succeeded.
      available: k.available !== false,
      detail: k.detail || null,
    })),
    suppressed: suppressedList,
    affected_ids: c.affectedIds || [],
    drill_to: c.drillTo || null,
    lane: c.lane,
    current_value: c.currentValue ?? null,
    suggested_value: c.suggestedValue ?? null,
    change_abs: c.changeAbs ?? null,
    change_pct: c.changePct ?? null,
    value_unit: c.valueUnit ?? null,
    // WHERE THE SUGGESTED VALUE CAME FROM, or that there isn't one and why.
    // Carried on the record rather than only in the prose, so a stored
    // recommendation can still be told apart from one whose number was
    // fabricated by a default band. null on actions that do not propose a value.
    candidate_basis: c.candidateBasis ?? null,
    // WHAT PRIOR EXPERIENCE SAYS ABOUT THIS ACTION, carried on the record so
    // the influence is visible rather than only felt in the ranking. A tool
    // that quietly demotes an action because of last month's result, without
    // saying so, is one an operator cannot argue with.
    prior_cases: (() => {
      const h = historyFor(x, c.action);
      if (!h) return null;
      return {
        status: h.status,
        cases_eligible: h.cases_eligible ?? 0,
        favourable: h.favourable ?? 0,
        unfavourable: h.unfavourable ?? 0,
        reverted: h.reverted ?? 0,
        caution: h.caution ?? null,
        policy_version: h.policy_version ?? null,
      };
    })(),
    // What this action ACTS ON, what it can be expected to move, and what it
    // must not be read as promising. Carried on every recommendation so the
    // drawer, the scenario table and a stored record all say the same thing.
    mechanism: mechanismFor(c.action),

    // WHICH CHECKS RAN, AND WHICH WERE NEVER CONSULTED.
    // A row recording only what it ran cannot be told apart from a row where
    // everything passed. Absence of a check is not a pass.
    checks_ran: (c.checks || []).map((k) => k.key).filter(Boolean),
    checks_not_run: CHECK_KEYS.filter((k) => !(c.checks || []).some((r) => r.key === k)),

    // THE REVIEW CONDITION. Stored so a decision can be judged later against
    // what it was supposed to achieve, rather than against whatever moved.
    success_criterion: REVIEW[c.action]?.success ?? null,
    stopping_rule: REVIEW[c.action]?.stop ?? null,
    review_min_days: REVIEW[c.action]?.minDays ?? null,
    hold_days: REVIEW[c.action]?.holdDays ?? null,
    hold_why: REVIEW[c.action]?.holdWhy ?? null,

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
