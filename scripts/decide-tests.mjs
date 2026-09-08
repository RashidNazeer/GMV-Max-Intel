// The arbitration pipeline, tested on the case that motivated it.
//
// Reviewed 8 September 2026, Biostime showed "room to raise budget" beside
// "61% of affiliate revenue on declining videos" and "revenue is concentrated",
// with nothing deciding between them. These tests are weighted toward the cases
// where an action must be SUPPRESSED — a pipeline that always finds something
// to recommend is not arbitrating, it is just talking.
import { decide, ACTION, OBJECTIVE, COOLDOWN_DAYS, BANDS } from '../src/lib/decide.js';

let pass = 0; let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const shop = { id: 's1', shop_name: 'Test', currency: 'USD' };

const healthyMarginal = {
  status: 'ok', marginal_roas: 1.6, marginal_roas_ci: [1.3, 1.9], avg_roas: 1.5,
  mean_daily_spend: 300, days: 30, target: 'total_shop_gmv', target_label: 'total shop GMV',
  validation: { folds: 12, mape: 0.2, baseline_mape: 0.35, skill: 0.43, beats_baseline: true },
  time_confounded: false, provisional: false,
};

const base = {
  shop, days: 30, start: '2026-08-08', end: '2026-09-06',
  attribution: {
    total_gmv: 100000, attribution_coverage: 0.8, affiliate_capture: 0.99,
    reconciliation_status: 'reconciled', reconciliation_gap: 0, reconciliation_pct: 0,
    measured_paid_gmv: 30000, measured_organic_gmv: 50000,
  },
  creative: {
    video_count: 100, gmv: 80000, top1_share: 0.05, top5_share: 0.2,
    declining_videos: 3, declining_gmv: 4000, rising_videos: 5,
    trend_measurable: true, baseline_coverage: 0.9,
  },
  productStats: { median_conversion: 0.03, median_n: 8, median_min_clicks: 500 },
  products: [], roas: { spend: 9000, reported_roi: 1.5, verified_roas: 0.5, unverified_share: 0.6, days_with_spend: 30 },
  marginal: healthyMarginal,
  dailyBudget: 320, targetRoi: 1.5,
  daysSinceLastChange: null,
  decliningIds: [], weakProductIds: [],
};

const actions = (f) => decide(f).all.map((r) => r.action_code);
const primary = (f) => decide(f).primary?.action_code;
const suppressedFor = (f, code) => decide(f).suppressed.find((s) => s.action_code === code);

console.log('\n── the case this exists for: creative constraint beats scaling ──');
{
  const f = {
    ...base,
    creative: { ...base.creative, declining_videos: 61, declining_gmv: 48800, top5_share: 0.55 },
    decliningIds: Array.from({ length: 61 }, (_, i) => `v${i}`),
  };
  const d = decide(f);
  check('the primary action is the creative review', d.primary.action_code, ACTION.REVIEW_CREATIVE);
  check('raising budget is NOT offered as primary', d.primary.action_code === ACTION.INCREASE_BUDGET, false);

  const s = suppressedFor(f, ACTION.INCREASE_BUDGET);
  check('and it is suppressed with a reason, not dropped', !!s, true);
  check('the reason names the constraint', /creative constraint/.test(s.why), true);
  check('the finding carries its exact 61 ids', d.primary.affected_ids.length, 61);
  check('and routes to the creatives view', d.primary.drill_to, 'creatives');
}

console.log('\n── with healthy creative the same evidence DOES scale ──');
{
  const d = decide(base);
  check('raise budget becomes available', actions(base).includes(ACTION.INCREASE_BUDGET), true);
  const inc = d.all.find((r) => r.action_code === ACTION.INCREASE_BUDGET);
  check('it carries a current and a suggested value', [inc.current_value, inc.suggested_value != null], [320, true]);
  check('the change is a relative band, not a fixed increment',
    BANDS.budget.includes(Math.abs(inc.change_pct)), true);
  check('and a test duration', inc.test_days > 0, true);
}

console.log('\n── under-utilised budget must not trigger a budget increase ──');
{
  // Spend is 30% of budget. The budget is not the limit, so raising it changes
  // nothing — this was called out explicitly in the review.
  const f = { ...base, dailyBudget: 1000, marginal: { ...healthyMarginal, mean_daily_spend: 300 } };
  const d = decide(f);
  check('increase budget is not the primary action', d.primary.action_code === ACTION.INCREASE_BUDGET, false);
  const s = suppressedFor(f, ACTION.INCREASE_BUDGET);
  check('it is blocked on the utilisation guardrail', /not spending what it already has/.test(s?.why || ''), true);
  check('lowering Target ROI is offered instead — the bid is the limit',
    actions(f).includes(ACTION.DECREASE_TARGET_ROI), true);
}

console.log('\n── a marginal return below one means cut, not scale ──');
{
  const f = { ...base, marginal: { ...healthyMarginal, marginal_roas: 0.6, marginal_roas_ci: [0.4, 0.8], avg_roas: 1.5 } };
  check('cut budget is raised', actions(f).includes(ACTION.DECREASE_BUDGET), true);
  check('raise budget is not', actions(f).includes(ACTION.INCREASE_BUDGET), false);
}

console.log('\n── a reconciliation exception outranks every media action ──');
{
  const f = {
    ...base,
    attribution: {
      ...base.attribution, reconciliation_status: 'exception',
      reconciliation_gap: 72.93, reconciliation_pct: 0.024, affiliate_capture: 1.039,
      affiliate_overflow_gmv: 72.93,
    },
  };
  const d = decide(f);
  check('fixing the data is the primary action', d.primary.action_code, ACTION.FIX_DATA);
  check('it is critical', d.primary.severity, 'critical');
  check('and sits in the data lane, not the media queue', d.primary.lane, 'data');
  check('capture above 100% is named as a failure',
    /exceed/.test(d.primary.reason), true);
  // The review's point: a data repair and a media opportunity are different
  // kinds of work and must not be shuffled into one list.
  const lanes = new Set(d.all.map((r) => r.lane));
  check('both lanes are still represented', lanes.has('data') && lanes.has('media'), true);
}

console.log('\n── cooldown stops recommendations flipping after every change ──');
{
  const f = { ...base, daysSinceLastChange: 2 };
  const d = decide(f);
  check('hold becomes available', actions(f).includes(ACTION.HOLD), true);
  check('scaling is suppressed inside the cooldown',
    /cooldown/.test(suppressedFor(f, ACTION.INCREASE_BUDGET)?.why || ''), true);
  check('and the hold says when the next evaluation is eligible',
    new RegExp(String(COOLDOWN_DAYS - 2)).test(d.all.find((r) => r.action_code === ACTION.HOLD).action_text), true);

  const old = { ...base, daysSinceLastChange: COOLDOWN_DAYS + 1 };
  check('past the cooldown, scaling returns', actions(old).includes(ACTION.INCREASE_BUDGET), true);
}

console.log('\n── refusals are surfaced, not hidden ──');
{
  const f = { ...base, marginal: { status: 'flat_spend', reason: 'Spend barely varied.', total_spend: 9000, days: 30, spend_cv: 0.04 } };
  const d = decide(f);
  check('insufficient data is raised as an action', actions(f).includes(ACTION.INSUFFICIENT_DATA), true);
  check('no budget change is proposed without a model',
    actions(f).some((a) => a === ACTION.INCREASE_BUDGET || a === ACTION.DECREASE_BUDGET), false);
  const ins = d.all.find((r) => r.action_code === ACTION.INSUFFICIENT_DATA);
  check('the model reason is passed through verbatim', ins.reason, 'Spend barely varied.');
}

console.log('\n── confidence is not the source badge and not an R-squared ──');
{
  const d = decide(base);
  const inc = d.all.find((r) => r.action_code === ACTION.INCREASE_BUDGET);
  check('recommendation confidence exists', typeof inc.confidence, 'number');
  check('model confidence is a separate field', typeof inc.model_confidence, 'number');
  check('data coverage is a third separate field', inc.data_coverage, 0.8);
  check('they are not the same number',
    inc.confidence !== inc.model_confidence || inc.model_confidence !== inc.data_coverage, true);
  check('and it carries its components', inc.confidence_parts.length > 0, true);
}

console.log('\n── the basis belongs to the ACTION, not to the shop ──');
{
  const f = { ...base, roas: { ...base.roas, is_simulated: true } };
  const d = decide(f);

  const inc = d.all.find((r) => r.action_code === ACTION.INCREASE_BUDGET);
  check('a spend-dependent action on a simulated shop is simulated', inc?.source_mode, 'simulated');
  check('and its simulated guardrail is recorded as failed',
    (inc?.guardrails || []).some((g) => !g.passed && /measured/.test(g.name)), true);

  // THE BUG THIS LOCKS DOWN: every recommendation used to inherit the shop's
  // simulated flag, so a listing review computed entirely from measured Seller
  // Center funnel data rendered as "REVIEW LISTINGS · SIMULATED". A badge that
  // is wrong in the harmless direction trains the reader to ignore it.
  const withWeak = {
    ...f,
    weakProductIds: ['p1'],
    productStats: { median_conversion: 0.03, median_n: 8, median_min_clicks: 500 },
  };
  const listing = decide(withWeak).all.find((r) => r.action_code === ACTION.REVIEW_LISTING);
  check('a listing review from measured funnel data is NOT marked simulated',
    listing?.source_mode, 'measured');

  const creative = decide({
    ...f,
    creative: { ...base.creative, declining_videos: 40, declining_gmv: 40000, top5_share: 0.6 },
  }).all.find((r) => r.action_code === ACTION.REVIEW_CREATIVE);
  check('a creative review from order lines is NOT marked simulated',
    creative?.source_mode, 'measured');

  // On a shop with real spend the model is still MODELLED, never "measured".
  const real = decide(base).all.find((r) => r.action_code === ACTION.INCREASE_BUDGET);
  check('a model-derived action on a real shop is modelled', real?.source_mode, 'modelled');
}

console.log('\n── a data finding names what actually fired ──');
{
  // Cutler's components reconcile to the cent; what is low is coverage. The
  // title used to claim a reconciliation failure regardless.
  const lowCapture = {
    ...base,
    attribution: { ...base.attribution, affiliate_capture: 0.78, reconciliation_status: 'reconciled' },
  };
  const f1 = decide(lowCapture).all.find((r) => r.action_code === ACTION.FIX_DATA);
  check('low coverage is not called a reconciliation failure',
    /does not reconcile/.test(f1.title), false);
  check('it names the missing evidence instead', /no order-line evidence/.test(f1.title), true);
  check('and is not raised as a repair task', f1.severity, 'info');

  const mismatch = {
    ...base,
    attribution: {
      ...base.attribution, reconciliation_status: 'exception',
      reconciliation_pct: 0.024, reconciliation_gap: 72.93, affiliate_capture: 1.039,
    },
  };
  const f2 = decide(mismatch).all.find((r) => r.action_code === ACTION.FIX_DATA);
  check('a genuine mismatch still says so', /does not reconcile/.test(f2.title), true);
  check('and is critical', f2.severity, 'critical');
}

console.log('\n── determinism and robustness ──');
{
  const a = JSON.stringify(decide(base).all.map((r) => r.action_code));
  const b = JSON.stringify(decide(base).all.map((r) => r.action_code));
  check('the same facts produce the same ranking every time', a, b);
  check('no facts at all -> no crash', decide({}).primary === null || typeof decide({}).primary === 'object', true);
  check('null collections -> no crash', typeof decide({ shop, products: null, videos: null }), 'object');
}

console.log('\n── revenue affected is labelled honestly ──');
{
  const d = decide(base);
  const withRev = d.all.filter((r) => r.revenue_affected != null);
  check('at least one action reports revenue affected', withRev.length > 0, true);
  // The field is deliberately NOT called "money at stake": historical GMV is
  // not a forecast of what will be gained or lost.
  check('no action claims a forecast field', d.all.every((r) => !('money_at_stake' in r)), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
