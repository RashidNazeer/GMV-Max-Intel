// ============================================================
// Layer 5 — marginal ROAS. "If I spend more, what does the NEXT dollar return?"
//
// Average ROAS describes money already spent. Every decision is about the next
// dollar, and the two can differ enough to invert a call: a campaign averaging
// 2.5 whose next dollar returns 1.5 is still profitable overall and losing
// money at the margin.
//
// ── THE MODEL ──────────────────────────────────────────────────────────────
// The simplest form that can express diminishing returns:
//
//     revenue = a * spend^b     =>     log(revenue) = log(a) + b*log(spend)
//
// b is the ELASTICITY, and it makes the answer fall out of one number:
//
//     marginal ROAS = b x average ROAS
//
// b = 1 is linear — the next dollar returns what the last one did. b < 1 is
// diminishing returns. b > 1 would be increasing returns, which is real at very
// low spend but usually means the model has found something other than spend.
//
// Deliberately not a machine-learning model. The spec requires every
// recommendation be traceable to the numbers that produced it, and a
// two-parameter curve can be argued with. A gradient-boosted one cannot.
//
// ── WHY MOST OF THIS FILE IS REFUSALS ──────────────────────────────────────
// Fitting a curve to 29 noisy days is easy; knowing when the answer is worth
// acting on is the whole job. A confident marginal ROAS from flat spend would
// be the single most dangerous number in this product, because someone would
// move real budget on it. So the fit reports a STATUS first and a number
// second, and several statuses mean "not answerable".
//
// The confound that matters most here is TIME. Measured on Biostime: spend fell
// steadily across the window while ROI rose, and the correlation between spend
// and the calendar is -0.67. That pattern is the signature of diminishing
// returns and equally the signature of anything else improving over the same
// weeks. So the headline estimate always controls for a linear time trend, and
// the uncontrolled fit is reported beside it as a sensitivity check.
// ============================================================

export const STATUS = {
  OK: 'ok',
  NO_DATA: 'no_data',
  TOO_FEW_DAYS: 'too_few_days',
  FLAT_SPEND: 'flat_spend',
  POOR_FIT: 'poor_fit',
  TOO_UNCERTAIN: 'too_uncertain',
};

// Thresholds. Each is a judgement, so each is written down with its reason
// rather than buried as a magic number.
export const MIN_DAYS = 20;        // below this the interval is meaningless
export const MIN_CV = 0.15;        // spend must actually move: 15% coeff. of variation
export const MIN_R2 = 0.25;        // under this, spend explains almost nothing
export const MAX_CI_RATIO = 0.6;   // CI wider than 60% of the estimate is not actionable
export const TIME_CONFOUND = 0.5;  // |corr(spend, day)| above this is worth flagging

const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

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
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  const cov = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0);
  const sa = Math.sqrt(a.reduce((s, v) => s + (v - ma) ** 2, 0));
  const sb = Math.sqrt(b.reduce((s, v) => s + (v - mb) ** 2, 0));
  return sa && sb ? cov / (sa * sb) : null;
}

/**
 * Fit the spend-response curve.
 *
 * @param {Array<{spend:number, revenue:number}>} rows one row per day, in date order
 * @returns {object} always has `status` and `reason`; the numbers only when status is OK
 */
export function fitSpendResponse(rows = []) {
  const pts = (rows || [])
    .map((r, i) => ({ i, spend: num(r.spend), revenue: num(r.revenue) }))
    .filter((p) => p.spend > 0 && p.revenue > 0);

  const base = { days: pts.length };

  if (!pts.length) {
    return { ...base, status: STATUS.NO_DATA, reason: 'No days with both spend and revenue.' };
  }

  const spends = pts.map((p) => p.spend);
  const totalSpend = spends.reduce((a, b) => a + b, 0);
  const totalRevenue = pts.reduce((a, p) => a + p.revenue, 0);
  const avgRoas = totalSpend > 0 ? totalRevenue / totalSpend : null;
  const mean = totalSpend / pts.length;
  const sd = Math.sqrt(spends.reduce((s, v) => s + (v - mean) ** 2, 0) / pts.length);
  const cv = mean > 0 ? sd / mean : 0;

  const stats = {
    ...base,
    total_spend: totalSpend,
    total_revenue: totalRevenue,
    avg_roas: avgRoas,
    mean_daily_spend: mean,
    spend_cv: cv,
    spend_min: Math.min(...spends),
    spend_max: Math.max(...spends),
  };

  if (pts.length < MIN_DAYS) {
    return {
      ...stats, status: STATUS.TOO_FEW_DAYS,
      reason: `Only ${pts.length} days with spend. At least ${MIN_DAYS} are needed before a spend-response curve means anything.`,
    };
  }

  // The refusal the spec specifically asks for.
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

  // The time-controlled fit is the headline: spend and the calendar move
  // together often enough that the uncontrolled one cannot be trusted alone.
  const b = timed.beta[1];
  const se = timed.se[1];
  const ci = [b - 1.96 * se, b + 1.96 * se];
  const spendTimeCorr = correlation(spends, t);

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
  };

  if (timed.r2 < MIN_R2) {
    return {
      ...out, status: STATUS.POOR_FIT,
      reason: `Spend explains only ${(timed.r2 * 100).toFixed(0)}% of the variation in revenue. Something other than budget is driving the results, so a marginal figure would be attributing them to the wrong cause.`,
    };
  }

  const width = out.marginal_roas_ci[1] - out.marginal_roas_ci[0];
  if (!Number.isFinite(width) || Math.abs(out.marginal_roas) < 1e-9 || width / Math.abs(out.marginal_roas) > MAX_CI_RATIO) {
    return {
      ...out, status: STATUS.TOO_UNCERTAIN,
      reason: `The estimate lands between ${out.marginal_roas_ci[0].toFixed(2)} and ${out.marginal_roas_ci[1].toFixed(2)} — too wide to act on. Quoting the midpoint would be false precision. More days, or a wider spread of daily budgets, narrows it.`,
    };
  }

  return { ...out, status: STATUS.OK, reason: null, scenarios: scenarios(out) };
}

/**
 * What happens at other budgets. revenue(S') = revenue(S) * (S'/S)^b, so the
 * incremental return on the change is what a decision actually turns on.
 */
export function scenarios(fit, deltas = [-0.3, -0.2, -0.1, 0.1, 0.2, 0.3]) {
  const { total_spend: S, total_revenue: R, elasticity: b } = fit;
  if (!S || !R || b == null) return [];
  return deltas.map((d) => {
    const s2 = S * (1 + d);
    const r2 = R * Math.pow(1 + d, b);
    const dS = s2 - S, dR = r2 - R;
    return {
      delta: d,
      spend: s2,
      revenue: r2,
      incremental_spend: dS,
      incremental_revenue: dR,
      // The number that decides it: what the CHANGE returns, not the average.
      incremental_roas: Math.abs(dS) > 1e-9 ? dR / dS : null,
    };
  });
}

/** True when the fit produced a number worth showing. */
export const isAnswerable = (fit) => fit?.status === STATUS.OK;
