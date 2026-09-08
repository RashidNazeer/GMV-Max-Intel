// ============================================================
// Layer 5 — marginal return. "If I spend more, what does the NEXT dollar buy?"
//
// Average ROAS describes money already spent. Every decision is about the next
// dollar, and the two can differ enough to invert a call: a campaign averaging
// 2.5 whose next dollar returns 1.5 is still profitable overall and losing
// money at the margin.
//
// ── WHAT CHANGED, AND WHY IT MATTERS ───────────────────────────────────────
// This model used to fit against GMV Max's OWN reported revenue. That is close
// to circular: it asks the ad platform's attribution how much the ad platform
// is worth, and inherits every over-attribution in it. The decision actually
// turns on incremental TOTAL shop GMV — if another dollar of spend does not
// grow the shop, it does not matter what the platform attributes to it.
//
// So the target is now explicit and labelled (TARGET below), the honest default
// is total shop GMV, and the fit is reported for more than one target so the
// difference between them is visible rather than hidden by whichever one was
// hardcoded.
//
// Be warned, and say it on screen: total shop GMV carries all the organic
// volatility that GMV Max's own figure does not. Against it this model will
// REFUSE more often, not less. That is the correct trade — a wide interval
// honestly reported beats a narrow one measured against the wrong thing.
//
// ── THE MODEL ──────────────────────────────────────────────────────────────
//     revenue = a * spend^b     =>     log(revenue) = log(a) + b*log(spend)
//     marginal = b x average
//
// b = 1 is linear. b < 1 is diminishing returns. Two parameters, no machine
// learning, because a recommendation has to be arguable and a gradient-boosted
// one is not.
//
// ── WHY MOST OF THIS FILE IS REFUSALS ──────────────────────────────────────
// Fitting a curve to 29 noisy days is easy; knowing when the answer is worth
// moving budget on is the whole job. The confound that matters most is TIME:
// measured on Biostime, spend fell steadily while ROI rose, corr(spend, day) =
// -0.67. That pattern is the signature of diminishing returns and equally the
// signature of anything else improving over the same weeks. The headline always
// controls for a linear time trend.
//
// New here: FORWARD validation. R-squared measures how well a curve fits days
// it has already seen, which is not the question — the question is whether it
// predicts a day it has not. Rolling-origin folds compare the model against the
// naive "tomorrow looks like the recent average" baseline, and a model that
// cannot beat that baseline is refused however good its R-squared looks.
// ============================================================

export const STATUS = {
  OK: 'ok',
  NO_DATA: 'no_data',
  TOO_FEW_DAYS: 'too_few_days',
  FLAT_SPEND: 'flat_spend',
  POOR_FIT: 'poor_fit',
  NO_SKILL: 'no_skill',
  TOO_UNCERTAIN: 'too_uncertain',
  MISSING_TARGET: 'missing_target',
};

/** What the curve is fitted against. Never assume — a scenario table must say. */
export const TARGET = {
  TOTAL_SHOP_GMV: 'total_shop_gmv',
  REPORTED_REVENUE: 'reported_revenue',
  VERIFIED_PAID_GMV: 'verified_paid_gmv',
};

export const TARGET_LABEL = {
  [TARGET.TOTAL_SHOP_GMV]: 'total shop GMV',
  [TARGET.REPORTED_REVENUE]: 'GMV Max reported revenue',
  [TARGET.VERIFIED_PAID_GMV]: 'commission-verified ad-driven revenue',
};

// Thresholds. Each is a judgement, so each is written down with its reason.
// The eligibility policy is configurable per the spec; these are the defaults.
export const MIN_DAYS = 21;        // provisional; 30+ preferred, reported either way
export const PREFERRED_DAYS = 30;
export const MIN_CV = 0.15;        // spend must actually move: 15% coeff. of variation
export const MIN_R2 = 0.25;        // under this, spend explains almost nothing
export const MAX_CI_RATIO = 0.6;   // CI wider than 60% of the estimate is not actionable
export const TIME_CONFOUND = 0.5;  // |corr(spend, day)| above this is worth flagging
export const MIN_FOLDS = 5;        // forward-validation folds needed to judge skill
export const DEFAULT_HORIZON = 7;  // days a scenario projects over

const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// ── ordinary least squares with standard errors ─────────────────────────────
export function ols(X, y) {
  const n = X.length;
  if (!n) return null;
  const k = X[0].length;
  if (n <= k) return null;

  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }

  // Gauss-Jordan on [XtX | I]: gives the coefficients and the inverse, which is
  // what the standard errors need.
  const M = XtX.map((row, i) => [...row, ...Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;   // singular: collinear inputs
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    for (let j = 0; j < 2 * k; j++) M[c][j] /= d;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = M[r][c];
      for (let j = 0; j < 2 * k; j++) M[r][j] -= f * M[c][j];
    }
  }
  const inv = M.map((row) => row.slice(k));
  const beta = inv.map((row) => row.reduce((s, v, j) => s + v * Xty[j], 0));

  const yhat = X.map((row) => row.reduce((s, v, j) => s + v * beta[j], 0));
  const ybar = y.reduce((a, b) => a + b, 0) / n;
  const ssr = y.reduce((s, v, i) => s + (v - yhat[i]) ** 2, 0);
  const sst = y.reduce((s, v) => s + (v - ybar) ** 2, 0);
  const df = n - k;
  if (df <= 0 || sst <= 0) return null;
  const sigma2 = ssr / df;
  const se = inv.map((row, i) => Math.sqrt(Math.max(sigma2 * row[i], 0)));
  return { beta, se, r2: 1 - ssr / sst, n, df };
}

function correlation(a, b) {
  const n = a.length;
  if (n < 2) return null;
  const ma = mean(a); const mb = mean(b);
  const cov = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0);
  const sa = Math.sqrt(a.reduce((s, v) => s + (v - ma) ** 2, 0));
  const sb = Math.sqrt(b.reduce((s, v) => s + (v - mb) ** 2, 0));
  return sa && sb ? cov / (sa * sb) : null;
}

/**
 * Rolling-origin forward validation.
 *
 * Random train/test splits leak the future into the past on a time series —
 * the model gets to see Wednesday while predicting Tuesday. Each fold here
 * trains only on days strictly before the day it predicts.
 *
 * The baseline is deliberately naive: "this day looks like the mean of the days
 * before it". A spend-response model that cannot beat that has not learned
 * anything about spend, whatever its R-squared says.
 */
export function forwardValidate(pts, minTrain = 14) {
  if (pts.length < minTrain + MIN_FOLDS) return null;
  const errs = [];
  const baseErrs = [];

  for (let i = minTrain; i < pts.length; i++) {
    const train = pts.slice(0, i);
    const test = pts[i];
    const ls = train.map((p) => Math.log(p.spend));
    const ly = train.map((p) => Math.log(p.revenue));
    const fit = ols(ls.map((v) => [1, v]), ly);
    if (!fit) continue;

    const pred = Math.exp(fit.beta[0] + fit.beta[1] * Math.log(test.spend));
    const base = mean(train.map((p) => p.revenue));
    if (!Number.isFinite(pred) || !base) continue;

    errs.push(Math.abs(pred - test.revenue) / test.revenue);
    baseErrs.push(Math.abs(base - test.revenue) / test.revenue);
  }

  if (errs.length < MIN_FOLDS) return null;
  const mape = mean(errs);
  const baseline = mean(baseErrs);
  return {
    folds: errs.length,
    mape,
    baseline_mape: baseline,
    // "Skill" in the forecasting sense: fraction of the baseline's error removed.
    skill: baseline > 0 ? (baseline - mape) / baseline : null,
    beats_baseline: mape < baseline,
  };
}

/**
 * Fit the spend-response curve.
 *
 * @param {Array<{spend:number, revenue:number}>} rows one per day, in date order
 * @param {object} opts
 * @param {string} opts.target        which quantity `revenue` holds (see TARGET)
 * @param {number} opts.horizonDays   days a scenario projects over
 * @param {number} opts.dailyBudget   current daily budget, if known
 * @param {boolean} opts.requireSkill refuse a model that cannot beat the naive baseline
 * @returns {object} always has `status` and `reason`; numbers only when OK
 */
export function fitSpendResponse(rows = [], opts = {}) {
  const {
    target = TARGET.TOTAL_SHOP_GMV,
    horizonDays = DEFAULT_HORIZON,
    dailyBudget = null,
    requireSkill = true,
  } = opts;

  const raw = rows || [];
  const withSpend = raw.filter((r) => num(r.spend) > 0);
  const pts = withSpend
    .map((r, i) => ({ i, spend: num(r.spend), revenue: num(r.revenue) }))
    .filter((p) => p.spend > 0 && p.revenue > 0);

  const base = { days: pts.length, target, target_label: TARGET_LABEL[target] || target, horizon_days: horizonDays };

  // A day where the target is MISSING is not a day where it was zero. Dropping
  // it silently would shrink the sample without saying so.
  const missingTarget = withSpend.length - pts.length;
  if (withSpend.length && missingTarget === withSpend.length) {
    return {
      ...base, status: STATUS.MISSING_TARGET, days_missing_target: missingTarget,
      reason: `Spend is recorded for ${withSpend.length} days but ${TARGET_LABEL[target]} is not available for any of them, so there is nothing to fit against. This is missing data, not zero revenue.`,
    };
  }

  if (!pts.length) {
    return { ...base, status: STATUS.NO_DATA, reason: 'No days carry both spend and a value for the target.' };
  }

  const spends = pts.map((p) => p.spend);
  const totalSpend = spends.reduce((a, b) => a + b, 0);
  const totalRevenue = pts.reduce((a, p) => a + p.revenue, 0);
  const avgRoas = totalSpend > 0 ? totalRevenue / totalSpend : null;
  const m = totalSpend / pts.length;
  const sd = Math.sqrt(spends.reduce((s, v) => s + (v - m) ** 2, 0) / pts.length);
  const cv = m > 0 ? sd / m : 0;

  const stats = {
    ...base,
    total_spend: totalSpend,
    total_revenue: totalRevenue,
    avg_roas: avgRoas,
    mean_daily_spend: m,
    mean_daily_revenue: totalRevenue / pts.length,
    spend_cv: cv,
    spend_min: Math.min(...spends),
    spend_max: Math.max(...spends),
    days_missing_target: missingTarget || 0,
    provisional: pts.length < PREFERRED_DAYS,
    daily_budget: num(dailyBudget),
  };

  if (pts.length < MIN_DAYS) {
    return {
      ...stats, status: STATUS.TOO_FEW_DAYS,
      reason: `Only ${pts.length} days carry spend and a target value. At least ${MIN_DAYS} are needed for a provisional answer, and ${PREFERRED_DAYS} before it is worth acting on.`,
    };
  }

  if (cv < MIN_CV) {
    return {
      ...stats, status: STATUS.FLAT_SPEND,
      reason: `Spend barely varied — ${(cv * 100).toFixed(0)}% variation against the ${(MIN_CV * 100).toFixed(0)}% needed. With one budget level there is nothing to compare, so no honest answer exists about a different one. Vary the daily budget for a few weeks and this becomes answerable.`,
    };
  }

  const ls = pts.map((p) => Math.log(p.spend));
  const ly = pts.map((p) => Math.log(p.revenue));
  const t = pts.map((p) => p.i);

  const naive = ols(ls.map((v) => [1, v]), ly);
  const timed = ols(ls.map((v, i) => [1, v, t[i]]), ly);
  if (!naive || !timed) {
    return { ...stats, status: STATUS.POOR_FIT, reason: 'The regression could not be solved on this data.' };
  }

  const b = timed.beta[1];
  const se = timed.se[1];
  const ci = [b - 1.96 * se, b + 1.96 * se];
  const spendTimeCorr = correlation(spends, t);
  const validation = forwardValidate(pts);

  const out = {
    ...stats,
    elasticity: b,
    elasticity_se: se,
    elasticity_ci: ci,
    r2: timed.r2,
    naive_elasticity: naive.beta[1],
    naive_r2: naive.r2,
    time_shift: naive.beta[1] - b,
    spend_time_correlation: spendTimeCorr,
    time_confounded: spendTimeCorr != null && Math.abs(spendTimeCorr) > TIME_CONFOUND,
    marginal_roas: b * avgRoas,
    marginal_roas_ci: [ci[0] * avgRoas, ci[1] * avgRoas],
    // Straddling 1 means we cannot distinguish diminishing from constant
    // returns, which is a finding rather than a failure.
    diminishing_returns: ci[1] < 1 ? true : ci[0] > 1 ? false : null,
    validation,
  };

  if (timed.r2 < MIN_R2) {
    return {
      ...out, status: STATUS.POOR_FIT,
      reason: `Spend explains only ${(timed.r2 * 100).toFixed(0)}% of the variation in ${TARGET_LABEL[target]}. Something other than budget is driving the results, so a marginal figure would attribute them to the wrong cause.`,
    };
  }

  // Fits the past, cannot predict the future. R-squared alone would have
  // shipped this one.
  if (requireSkill && validation && !validation.beats_baseline) {
    return {
      ...out, status: STATUS.NO_SKILL,
      reason: `Tested against days it had not seen, the curve predicts ${TARGET_LABEL[target]} worse than simply assuming the recent average (${(validation.mape * 100).toFixed(0)}% error against ${(validation.baseline_mape * 100).toFixed(0)}%). It describes the history without predicting it, so it cannot size a change.`,
    };
  }

  const width = out.marginal_roas_ci[1] - out.marginal_roas_ci[0];
  if (!Number.isFinite(width) || Math.abs(out.marginal_roas) < 1e-9 || width / Math.abs(out.marginal_roas) > MAX_CI_RATIO) {
    return {
      ...out, status: STATUS.TOO_UNCERTAIN,
      reason: `The estimate lands between ${out.marginal_roas_ci[0].toFixed(2)} and ${out.marginal_roas_ci[1].toFixed(2)} — too wide to act on. Quoting the midpoint would be false precision. More days, or a wider spread of daily budgets, narrows it.`,
    };
  }

  return { ...out, status: STATUS.OK, reason: null, scenarios: scenarios(out, { horizonDays, dailyBudget }) };
}

/**
 * Spend scenarios over a stated horizon.
 *
 * ── THREE THINGS THE OLD TABLE GOT WRONG ───────────────────────────────────
 * 1. It was headed "If daily budget" and showed CUMULATIVE PERIOD spend. A row
 *    reading "+20% ... $11,405" implied a daily budget of eleven thousand
 *    dollars on a campaign spending three hundred.
 * 2. It treated budget and spend as the same quantity. Raising a daily budget
 *    20% does not raise delivered spend 20% — a campaign that never spends its
 *    budget will not spend more of it just because the cap moved.
 * 3. There was no baseline row, so no scenario could be compared against doing
 *    nothing, which is always the alternative.
 *
 * These are SPEND scenarios. The budget translation is offered only when
 * utilisation evidence supports it, and it is labelled as an assumption.
 */
export function scenarios(fit, opts = {}) {
  const { horizonDays = DEFAULT_HORIZON, dailyBudget = null } = opts;
  const {
    mean_daily_spend: dailySpend,
    mean_daily_revenue: dailyRevenue,
    elasticity: b,
    spend_min: lo,
    spend_max: hi,
  } = fit;
  if (!dailySpend || !dailyRevenue || b == null) return [];

  const budget = num(dailyBudget);
  // Utilisation is what makes a budget change readable as a spend change. It is
  // never assumed to be 1.
  const utilisation = budget && budget > 0 ? dailySpend / budget : null;

  const deltas = [0, 0.1, 0.2, 0.3, -0.1, -0.2, -0.3];
  const baseSpend = dailySpend * horizonDays;
  const baseRevenue = dailyRevenue * horizonDays;

  return deltas.map((d) => {
    const dailyAtScenario = dailySpend * (1 + d);
    const spend = baseSpend * (1 + d);
    const revenue = baseRevenue * Math.pow(1 + d, b);
    const dS = spend - baseSpend;
    const dR = revenue - baseRevenue;
    return {
      delta: d,
      is_baseline: d === 0,
      horizon_days: horizonDays,
      daily_spend: dailyAtScenario,
      // What daily budget this scenario would need, at the utilisation actually
      // observed. Null when we have no budget to reason from — never 1:1.
      implied_daily_budget: utilisation ? dailyAtScenario / utilisation : null,
      utilisation,
      spend,
      revenue,
      incremental_spend: dS,
      incremental_revenue: dR,
      // The number the decision turns on: a finite difference between two
      // predictions under the same stated context, not average ROAS reapplied.
      incremental_roas: Math.abs(dS) > 1e-9 ? dR / dS : null,
      // Outside the daily spend actually observed, the curve is extrapolating.
      outside_observed: dailyAtScenario < lo || dailyAtScenario > hi,
    };
  });
}

/** True when the fit produced a number worth showing. */
export const isAnswerable = (fit) => fit?.status === STATUS.OK;

/** Plain-language recovery for every refusal. */
export function recoveryFor(fit) {
  switch (fit?.status) {
    case STATUS.NO_DATA:
    case STATUS.MISSING_TARGET:
      return 'Connect the ad account in Reacher, or sync the shop channel data for these dates, so spend and shop GMV exist on the same days.';
    case STATUS.TOO_FEW_DAYS:
      return 'Keep collecting. This answers itself as the history builds.';
    case STATUS.FLAT_SPEND:
      return 'Vary the daily budget deliberately for two to three weeks — some days higher, some lower. That is what creates the evidence; a steady budget can never produce it, however long you wait.';
    case STATUS.POOR_FIT:
      return 'Look for what else moved: creative changes, promotions, stock. Until spend explains more of the movement, a marginal figure would credit the wrong cause.';
    case STATUS.NO_SKILL:
      return 'More history, or a wider spread of daily budgets. The relationship may be real but is not yet strong enough to predict a day the model has not seen.';
    case STATUS.TOO_UNCERTAIN:
      return 'More days, or a wider spread of daily budgets. The direction may be right; the size is not yet knowable.';
    default:
      return null;
  }
}
