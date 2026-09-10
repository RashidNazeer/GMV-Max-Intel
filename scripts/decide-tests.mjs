// The arbitration pipeline, tested on the case that motivated it.
//
// Reviewed 8 September 2026, Biostime showed "room to raise budget" beside
// "61% of affiliate revenue on declining videos" and "revenue is concentrated",
// with nothing deciding between them. These tests are weighted toward the cases
// where an action must be SUPPRESSED — a pipeline that always finds something
// to recommend is not arbitrating, it is just talking.
import {
  decide, features, deliveryWindowState,
  ACTION, OBJECTIVE, COOLDOWN_DAYS, BANDS, MECHANISM, CAPABILITY,
  DECISION_RECON_TOLERANCE,
} from '../src/lib/decide.js';

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
  // A settings record exists covering the analysed days. This fixture never had
  // to say so before, because the budget guardrail never asked — it divided a
  // training-period average by today's budget and called the result a statement
  // about the campaign. It now demands provenance for that denominator, so the
  // healthy baseline has to declare that its budget is actually known for the
  // window. The shop WITHOUT that record is tested separately below.
  settingsCoverWindow: true,
  settingsFrom: '2026-07-01',
  sourceHealth: [
    { source: 'affiliate', missing_days: 0, coverage_end: '2026-09-06', state: 'complete' },
    { source: 'gmv_max', missing_days: 0, coverage_end: '2026-09-06', state: 'complete' },
  ],
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
  // THE REASON MUST BE THE BUDGET ACTION'S OWN EVIDENCE.
  //
  // This used to assert /creative constraint/, which was the creative finding
  // VETOING the budget action wholesale. With no per-video delivery evidence
  // that veto was an unproven diagnosis deciding the entire page. The budget
  // action now fails on its own creativeSupply guardrail and says which
  // measurement stopped it, which is inspectable in a way "a creative
  // constraint is live" never was.
  check('the reason cites the measurement, not a generic constraint claim',
    /% of video revenue is on declining creative/.test(s.why), true);
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
      // COHERENT ON PURPOSE. gap / total_gmv must equal reconciliation_pct, and
      // the status must be what the database would return for that percentage.
      // It did not before — 72.93 against 100,000 is 0.07%, declared as 2.4% —
      // because only the status was ever read. The percentage is load-bearing
      // now (see DECISION_RECON_TOLERANCE), so it has to be true.
      ...base.attribution, reconciliation_status: 'exception',
      reconciliation_gap: 14000, reconciliation_pct: 0.14, affiliate_capture: 1.039,
      affiliate_overflow_gmv: 14000,
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
      reconciliation_pct: 0.14, reconciliation_gap: 14000, affiliate_capture: 1.039,
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


console.log('\n── a report filter must not manufacture a passed check ──');
{
  // THE 9 SEPTEMBER DEFECT, in one test.
  //
  // A 7-day report discarded the creative comparison window. decliningShare
  // came back as 0, the creative guardrail PASSED, and the recommendation
  // flipped from "Review creative" (23 videos carrying 46% of video revenue)
  // to "Lower Target ROI" — same shop, same cutoff, same underlying data.
  //
  // Missing evidence is not evidence of absence. The guardrail is now
  // UNAVAILABLE when there is no baseline, and unavailable never passes.
  const noHistory = {
    ...base,
    creative: {
      ...base.creative,
      baseline_coverage: 0,        // the report threw the prior week away
      declining_videos: 0, declining_gmv: 0,
    },
    dailyBudget: 1000,
    marginal: { ...healthyMarginal, mean_daily_spend: 300 },
    targetRoi: 1.5,
  };
  const d = decide(noHistory);
  const guard = d.all.flatMap((r) => r.guardrails || [])
    .find((g) => /creative can absorb/.test(g.name));

  check('a missing baseline makes the creative check unavailable', guard?.available, false);
  check('and unavailable is not passed', guard?.passed, false);
  check('it says why rather than reporting a clean bill',
    /cannot be confirmed either way/.test(guard?.detail || ''), true);

  // With the history present and genuinely healthy, the same check passes.
  const withHistory = {
    ...noHistory,
    creative: { ...base.creative, baseline_coverage: 0.65, declining_videos: 2, declining_gmv: 1000 },
  };
  const ok = decide(withHistory).all.flatMap((r) => r.guardrails || [])
    .find((g) => /creative can absorb/.test(g.name));
  check('a real baseline showing healthy creative does pass', ok?.passed, true);

  // And a real constraint still blocks, as before.
  const constrained = {
    ...noHistory,
    creative: { ...base.creative, baseline_coverage: 0.65, declining_videos: 23, declining_gmv: 40000 },
    decliningIds: Array.from({ length: 23 }, (_, i) => `v${i}`),
  };
  check('a real creative constraint still wins',
    decide(constrained).primary.action_code, ACTION.REVIEW_CREATIVE);
}

// ── a budget conclusion needs a budget on record for the days analysed ──────
// Issue 4: the app divided the model's mean daily spend (29 days, ending at the
// cutoff) by the budget as it reads TODAY, and reported "the campaign is not
// spending what it already has" — a present-tense claim about a campaign whose
// settings history began AFTER the report ended. The ratio is the same number
// either way; what changes is whether it is allowed to assert a cause.
console.log('\n── no setting on record: the constraint is unknown, not absent ──');
{
  const unknown = {
    ...base,
    settingsCoverWindow: false,
    settingsFrom: '2026-09-08',          // snapshots begin AFTER end 2026-09-06
    dailyBudget: 1000,
    marginal: { ...healthyMarginal, mean_daily_spend: 300 },
  };
  // Raising budget is SUPPRESSED here, so its reason travels on the suppressed
  // entry — the same accessor the under-utilised test above uses.
  const why = suppressedFor(unknown, ACTION.INCREASE_BUDGET)?.why || '';

  check('raising budget is not the primary action on unknown evidence',
    decide(unknown).primary.action_code === ACTION.INCREASE_BUDGET, false);
  check('and it does not claim the campaign underspent',
    /not spending what it already has/.test(why), false);
  check('it names the missing evidence instead',
    /no campaign setting is recorded/.test(why), true);
  check('and states when settings history actually begins', /2026-09-08/.test(why), true);
  check('while still showing the ratio, labelled as a different period',
    /different periods/.test(why), true);

  // The SAME utilisation with a setting on record is a real, usable finding —
  // the fix must not have simply silenced the guardrail.
  const known = { ...unknown, settingsCoverWindow: true, settingsFrom: '2026-08-01' };
  const kWhy = suppressedFor(known, ACTION.INCREASE_BUDGET)?.why || '';
  check('with a setting on record the same ratio DOES conclude',
    /not spending what it already has/.test(kWhy), true);
  check('and stops talking about missing settings',
    /no campaign setting is recorded/.test(kWhy), false);
}

// ── agreement is not completeness ──────────────────────────────────────────
console.log('\n── a missing day is caught even when the totals agree ──');
{
  // affiliate_capture 0.99 — the two sources agree almost exactly — while the
  // affiliate feed is a day short of the report. The old guardrail was called
  // "affiliate evidence complete" and passed on exactly this.
  // A reconciliation gap the ENGINE will not tolerate, so the data candidate
  // fires and its `capture` check actually runs — capture is only evaluated
  // where a data action exists. 5% is deliberately a case the screens call
  // 'rounding': the two thresholds are separate, and this fixture proves the
  // engine still acts inside the band the screens have gone quiet in.
  const shortDay = {
    ...base,
    attribution: { ...base.attribution, reconciliation_status: 'rounding', reconciliation_pct: 0.05, reconciliation_gap: 5000 },
    sourceHealth: [
      { source: 'affiliate', missing_days: 1, coverage_end: '2026-09-05', state: 'incomplete' },
      { source: 'gmv_max', missing_days: 0, coverage_end: '2026-09-06', state: 'complete' },
    ],
  };
  const d = decide(shortDay);
  const all = d.all.flatMap((r) => r.guardrails || []).concat(d.primary?.guardrails || []);
  // The coverage check is named for its CRITERION now, not for "agreement".
  // At 90.3% the old name said the totals agreed with Seller Center while 9.7%
  // of affiliate revenue had no order line behind it — a passed check reading
  // as a clean bill the source diagnostics contradicted.
  const cover = all.find((x) => /affiliate order lines cover/.test(x.name));
  const dates = all.find((x) => x.name === 'every day of the report arrived');

  check('the coverage check still passes — capture is inside the band', cover?.passed, true);
  check('but the date check fails', dates?.passed, false);
  check('and names the source and the shortfall',
    /affiliate is missing 1 day/.test(dates?.detail || ''), true);
  check('no guardrail is still called "affiliate evidence complete"',
    all.some((x) => x.name === 'affiliate evidence complete'), false);
  check('and none claims the totals AGREE',
    all.some((x) => /totals agree/.test(x.name)), false);

  // With no health data at all, completeness is UNAVAILABLE — never passed.
  const noHealth = { ...base, sourceHealth: null };
  const nd = decide(noHealth).all.flatMap((r) => r.guardrails || [])
    .find((x) => x.name === 'every day of the report arrived');
  check('unchecked completeness is unavailable, not a pass', nd?.available, false);
}

// ── a budget cap and an auction bid are different things ───────────────────
// They were the same object with a different value_unit, which is how a
// modelled "+10% spend" reads as "+10% budget", and how a bid setting comes to
// look like a promise about realised return.
console.log('\n── interventions carry their mechanism, and what it cannot promise ──');
{
  const d = decide(base);
  const all = [...d.all, ...(d.primary ? [d.primary] : [])];
  const withMech = all.filter((r) => r.mechanism);
  check('actions carry a mechanism', withMech.length > 0, true);
  for (const r of withMech) {
    check(`${r.action_code} says what it acts on`, !!r.mechanism.acts_on, true);
    check(`${r.action_code} states what it cannot claim`, !!r.mechanism.cannot_claim, true);
    check(`${r.action_code} says where the change is made`, !!r.mechanism.where, true);
  }

  // The distinction that matters: a cap is not a bid.
  const budget = MECHANISM[ACTION.INCREASE_BUDGET];
  const roi = MECHANISM[ACTION.DECREASE_TARGET_ROI];
  check('a budget acts on a cap', /cap/i.test(budget.acts_on), true);
  check('a Target ROI acts on a bid', /bid/i.test(roi.acts_on), true);
  check('they do not act on the same thing', budget.acts_on === roi.acts_on, false);
  check('the budget refuses to promise spend when the cap is not binding',
    /binding|never reached/i.test(budget.cannot_claim), true);
  check('the Target ROI refuses to promise a realised return',
    /realised ROI/i.test(roi.cannot_claim), true);
  check('and refuses to promise a proportional move',
    /same percentage/i.test(roi.cannot_claim), true);
  check('creative review refuses to quote a spend figure',
    /per-video spend is not available/i.test(MECHANISM[ACTION.REVIEW_CREATIVE].cannot_claim), true);
}

// ── capability: "supported" is not reachable from reads alone ──────────────
// The only definitive Creative Boost check Reacher offers is a create-shaped
// call, and this product does not write to TikTok. So the app can determine
// "unavailable" and "unknown"; "supported" needs a human to confirm it.
console.log('\n── capability has three states, and one of them needs a human ──');
{
  check('unknown is a state', CAPABILITY.UNKNOWN, 'unknown');
  check('unavailable is a state', CAPABILITY.UNAVAILABLE, 'unavailable');
  check('supported is a state', CAPABILITY.SUPPORTED, 'supported');
  check('they are three distinct values', new Set(Object.values(CAPABILITY)).size, 3);
}


// ── the screens and the engine judge the same gap by different rules ────────
//
// The reporting threshold moved to 10% so a ~1% provider disagreement would
// stop painting every page red. It was ONE database function with two
// consumers, so that also made the engine willing to size a budget on top of a
// 9% disagreement — a change to spending behaviour nobody asked for and that no
// screen would have shown. These tests pin the two apart.
console.log('\n── reconciliation: reporting threshold vs decision threshold ──');
{
  const at = (statusFromDb, p) => features({
    ...base,
    attribution: {
      ...base.attribution,
      reconciliation_status: statusFromDb,
      reconciliation_pct: p,
      reconciliation_gap: p == null ? null : p * 100000,
    },
  });

  check('the decision threshold is 3%', DECISION_RECON_TOLERANCE, 0.03);

  // The real case. Biostime sits near 1%; the database now calls that
  // 'rounding' and so does the engine. This is the outcome the owner asked for.
  check('a 1% gap is tolerated by the engine', at('rounding', 0.01).reconExceedsDecision, false);

  // The band the split exists for. The screens stay quiet, the engine does not.
  check('a 5% gap is quiet on screen but NOT to the engine', at('rounding', 0.05).reconExceedsDecision, true);
  check('a 9% gap is still quiet on screen but NOT to the engine', at('rounding', 0.09).reconExceedsDecision, true);

  // Above the reporting threshold both agree, as they always did.
  check('a 14% gap exceeds both', at('exception', 0.14).reconExceedsDecision, true);

  // Direction must not matter: components UNDER the source total is the same
  // failure as components over it.
  check('a -5% gap counts too', at('rounding', -0.05).reconExceedsDecision, true);

  // The absolute rounding tolerance still wins. A sub-dollar gap on a tiny
  // window can be a large percentage and is still not a data problem.
  check('an exactly-reconciled window is never a decision problem',
    at('reconciled', 0.4).reconExceedsDecision, false);
  check('a null percentage is not a failure', at('rounding', null).reconExceedsDecision, false);

  // And the guardrail that consumes it must follow.
  const gapped = decide({
    ...base,
    attribution: { ...base.attribution, reconciliation_status: 'rounding', reconciliation_pct: 0.05, reconciliation_gap: 5000 },
  });
  const reconChk = gapped.primary?.guardrails?.find((c) => c.name === 'revenue reconciles');
  check('"revenue reconciles" fails at 5% even though the screens call it rounding',
    reconChk ? reconChk.passed : 'the check did not run', false);

  const clean = decide({
    ...base,
    attribution: { ...base.attribution, reconciliation_status: 'rounding', reconciliation_pct: 0.01, reconciliation_gap: 1000 },
  });
  // At 1% no data action fires at all, so the guardrail is never RUN — which is
  // the whole point of the change. Asserting "it passed" would have been the
  // wrong assertion; what matters is that nothing anywhere reports the revenue
  // as failing to reconcile.
  const cleanFails = clean.all
    .flatMap((r) => r.guardrails || [])
    .some((g) => g.name === 'revenue reconciles' && !g.passed);
  check('nothing reports a reconciliation failure at 1%', cleanFails, false);
  check('and no data action is raised at all at 1%',
    clean.all.some((r) => r.action_code === ACTION.FIX_DATA), false);
  check('so a 1% gap no longer makes fixing data the primary action',
    clean.primary?.action === ACTION.FIX_DATA, false);
}


// ── a declining-video list is an OBSERVATION, not a diagnosis ──────────────
//
// The reviewed finding was titled "Creative is the constraint, not the budget",
// asserted that spending harder "raises cost per order rather than volume", and
// instructed the operator to brief replacements. The evidence behind all three
// claims was a list of videos whose revenue fell.
//
// Revenue falls when a creative stops working AND when it stops being shown,
// and those call for opposite actions. Acceptance cases T11 and T20.
console.log('\n── creative findings are graded by the evidence actually present ──');
{
  const falling = {
    ...base,
    creative: { ...base.creative, declining_videos: 61, declining_gmv: 48800, top5_share: 0.55 },
    decliningIds: Array.from({ length: 61 }, (_, i) => `v${i}`),
  };

  // 1. NO DELIVERY EVIDENCE — the live situation. Investigation, not diagnosis.
  const unverified = decide(falling).all.find((r) => r.action_code === ACTION.REVIEW_CREATIVE);
  check('it does not claim creative is the constraint',
    /Creative is the constraint/.test(unverified.title), false);
  check('it says delivery cannot be verified',
    /delivery cannot be verified/i.test(unverified.title), true);
  check('it does not promise that spending more raises cost per order',
    /raises cost per order/.test(unverified.reason), false);
  check('it does not instruct replacements',
    /[Bb]rief replacements/.test(unverified.action_text), false);
  check('it names what is missing', /still being delivered/.test(unverified.reason), true);
  check('and it still hands over the exact videos', unverified.affected_ids.length, 61);

  // THE CHANGE THAT MATTERS MOST. An unproven constraint vetoed every budget
  // and Target ROI alternative, so a generic creative flag decided the page.
  const dUnv = decide(falling);
  const budgetSuppression = dUnv.suppressed.find((s) => s.action_code === ACTION.INCREASE_BUDGET);
  check('the creative finding no longer vetoes the budget action itself',
    /creative constraint is live/.test(budgetSuppression?.why || ''), false);

  // 2. CAMPAIGNS PAUSED THROUGH THE WINDOW — a different explanation entirely.
  const paused = decide({
    ...falling,
    campaignWindowStates: [
      { campaign_id: 'c1', window_state: 'paused' },
      { campaign_id: 'c2', window_state: 'paused' },
    ],
  }).all.find((r) => r.action_code === ACTION.REVIEW_CREATIVE);
  check('a paused window is diagnosed as a delivery stop',
    /campaigns were paused/i.test(paused.title), true);
  check('and explicitly refuses the creative explanation',
    /not evidence the creative stopped working/.test(paused.reason), true);
  check('it is informational, not an emergency', paused.severity, 'info');

  // 3. DELIVERY CONFIRMED — only here may the strong claim be made.
  const dSup = decide({
    ...falling,
    deliveryEvidence: CAPABILITY.SUPPORTED,
    campaignWindowStates: [{ campaign_id: 'c1', window_state: 'active' }],
  });
  const supported = dSup.all.find((r) => r.action_code === ACTION.REVIEW_CREATIVE);
  check('with delivery held, creative IS named as the constraint',
    /Creative is the constraint/.test(supported.title), true);
  check('and the reason says why that follows',
    /delivery continued/.test(supported.reason), true);
  // suppressWhy is carried on the SUPPRESSED entry, not on the winning record.
  check('only now does the creative finding veto scaling',
    /binding constraint/.test(
      dSup.suppressed.find((s) => s.action_code === ACTION.INCREASE_BUDGET)?.why || '',
    ), true);

  // 4. The three grades must actually differ.
  check('the three grades produce three different titles',
    new Set([unverified.title, paused.title, supported.title]).size, 3);
}

console.log('\n── the delivery-window reduction ──');
{
  check('no states at all is unknown', deliveryWindowState(null).state, 'unknown');
  check('empty is unknown', deliveryWindowState([]).state, 'unknown');
  check('all-unknown states stay unknown',
    deliveryWindowState([{ window_state: 'unknown' }, { window_state: 'unknown' }]).state, 'unknown');
  check('one active among unknowns is delivering',
    deliveryWindowState([{ window_state: 'unknown' }, { window_state: 'active' }]).state, 'delivering');
  check('all paused is paused',
    deliveryWindowState([{ window_state: 'paused' }, { window_state: 'paused' }]).state, 'paused');
  // A campaign that changed state mid-window WAS delivering for part of it, so
  // it cannot be treated as a clean pause.
  check('mixed counts as delivering',
    deliveryWindowState([{ window_state: 'mixed' }]).state, 'delivering');
  check('and mixed is counted as a partial window',
    deliveryWindowState([{ window_state: 'mixed' }, { window_state: 'active' }]).partial, 1);
}


// ── capture is COVERAGE, not agreement ────────────────────────────────────
//
// The reviewed screen showed a passed check saying the affiliate totals agreed
// with Seller Center while capture was 90.3% — nearly a tenth of reported
// affiliate revenue had no order line behind it. A tolerance had been upgraded
// into an agreement. Requirement in section 7: "If a threshold treats it as
// usable for a particular investigation, name that criterion precisely."
console.log('\n── affiliate capture is named for its criterion, not as agreement ──');
{
  const at = (capture) => {
    const g = decide({
      ...base,
      attribution: { ...base.attribution, affiliate_capture: capture },
      creative: { ...base.creative, declining_videos: 61, declining_gmv: 48800, top5_share: 0.55 },
    }).all.flatMap((r) => r.guardrails || []);
    return g.find((x) => /affiliate order lines cover/.test(x.name));
  };

  // The reviewed value.
  const c903 = at(0.903);
  check('90.3% passes, because it is inside the band', c903.passed, true);
  check('the check is not called an agreement', /agree/.test(c903.name), false);
  check('it names the band it is judged against',
    /85%–105%/.test(c903.name) || /85–105/.test(c903.name), true);
  // THE POINT. A pass must not read as "nothing is missing".
  check('and the pass still names the missing evidence',
    /9\.7% of affiliate revenue still has no order-line evidence/.test(c903.detail), true);

  // Below the band.
  const low = at(0.6);
  check('60% fails', low.passed, false);
  check('and says how far below the requirement it is',
    /below the 85% this action needs/.test(low.detail), true);

  // Above the band is a DIFFERENT failure: our lines exceed the source.
  const over = at(1.2);
  check('120% fails', over.passed, false);
  check('and is described as different bases, not as missing evidence',
    /measuring on different bases/.test(over.detail), true);

  // Unmeasured is not a pass.
  const none = at(null);
  check('unmeasured capture is not a passed check', none.passed, false);
  check('and says it was not measured', /has not been measured/.test(none.detail), true);

  // A full match needs no shortfall sentence.
  const full = at(1.0);
  check('100% passes without claiming anything is missing',
    /still has no order-line evidence/.test(full.detail || ''), false);
}


// ── a Target ROI step must be sized by evidence, or not at all ────────────
//
// The candidate used to come from sizeBand(BANDS.target_roi) — a 5/10/15%
// ladder applied to every campaign on every shop, with nothing in it drawn from
// the campaign it was shown against. Section 12: "Do not output a hidden
// default recommendation such as a universal 10% ROI change."
console.log('\n── Target ROI: no hidden default ──');
{
  // Spend at 30% of a 1000 budget with marginal 1.6 — the bid is the limit.
  const throttled = {
    ...base,
    dailyBudget: 1000,
    marginal: { ...healthyMarginal, mean_daily_spend: 300 },
  };

  const bare = decide(throttled).all.find((r) => r.action_code === ACTION.DECREASE_TARGET_ROI);
  check('the finding still fires — the observation is sound', !!bare, true);
  check('but it proposes NO value without evidence', bare.suggested_value, null);
  check('and no percentage change', bare.change_pct, null);
  check('it says the size is the operator’s to choose',
    /Choose the step yourself/.test(bare.action_text), true);
  check('and says why it cannot size one',
    /nothing to size a step from|no usable Target ROI change/i.test(
      bare.action_text + bare.evidence.join(' ')), true);
  // The old default must not reappear by any route.
  check('it does not name a 10% step', /\b10%\b/.test(bare.action_text), false);
  check('the basis is recorded as needing the operator',
    bare.candidate_basis, 'operator_must_choose');

  // WITH episodes, a candidate is allowed — and comes from what the campaign
  // has actually run at, not from a ladder.
  const evidenced = decide({
    ...throttled,
    roiHeadroom: {
      looser: {
        status: 'eligible_for_review', candidate: 1.25,
        episodes_eligible: 3, observed_min: 1.2, observed_max: 1.4,
      },
    },
  }).all.find((r) => r.action_code === ACTION.DECREASE_TARGET_ROI);

  check('with episodes it proposes a value', evidenced.suggested_value, 1.25);
  check('the value is a setting the campaign has run at',
    evidenced.suggested_value >= 1.2 && evidenced.suggested_value <= 1.4, true);
  check('and it says how many changes support it',
    /3 recorded changes/.test(evidenced.action_text), true);
  check('the basis names the evidence', evidenced.candidate_basis, 'observed_episodes');
  check('confidence includes setting-response evidence',
    evidenced.confidence_parts.some((p) => /setting-response/.test(p.name)), true);

  // A status short of eligible must NOT unlock a candidate.
  for (const status of ['insufficient_history', 'confounded_evidence', 'single_episode']) {
    const weak = decide({
      ...throttled,
      roiHeadroom: { looser: { status, candidate: 1.25, episodes_eligible: 1 } },
    }).all.find((r) => r.action_code === ACTION.DECREASE_TARGET_ROI);
    check(`${status} proposes no value even when a candidate is present`,
      weak.suggested_value, null);
  }
}


// ── what happened last time reaches the next recommendation ───────────────
//
// Every layer before this one recorded and nothing read back: a buyer could
// accept a change, apply it, watch it breach a guardrail, review it honestly —
// and the next identical situation produced the same confident advice.
//
// Section 17. The rules are deliberately ASYMMETRIC and deliberately small.
console.log('\n── reviewed history changes later advice ──');
{
  const throttled = {
    ...base,
    dailyBudget: 1000,
    marginal: { ...healthyMarginal, mean_daily_spend: 300 },
  };
  const roiOf = (f) => decide(f).all.find((r) => r.action_code === ACTION.DECREASE_TARGET_ROI);

  // 1. Nothing reviewed — the normal state, and it must change nothing.
  const bare = roiOf(throttled);
  check('with no history the action carries no prior cases', bare.prior_cases, null);

  const none = roiOf({
    ...throttled,
    reviewedHistory: {
      [ACTION.DECREASE_TARGET_ROI]: {
        status: 'no_reviewed_history', cases_eligible: 0, favourable: 0, unfavourable: 0,
        caution: 'No comparable change has been reviewed yet.',
      },
    },
  });
  check('an explicit empty history is carried, and says so',
    none.prior_cases.status, 'no_reviewed_history');

  // 2. A comparable change that went BADLY must demote the action.
  const withBad = {
    ...throttled,
    reviewedHistory: {
      [ACTION.DECREASE_TARGET_ROI]: {
        status: 'caution_from_history', cases_eligible: 2, favourable: 1, unfavourable: 1,
        reverted: 0, caution: '1 of 2 comparable cases ended unfavourably.',
      },
    },
  };
  const bad = roiOf(withBad);
  check('an unfavourable case is recorded on the action', bad.prior_cases.unfavourable, 1);
  check('and the caution travels with it',
    /ended unfavourably/.test(bad.prior_cases.caution), true);

  // 3. A comparable change that went WELL may lift it, but far less.
  const withGood = {
    ...throttled,
    reviewedHistory: {
      [ACTION.DECREASE_TARGET_ROI]: {
        status: 'supported_by_history', cases_eligible: 3, favourable: 3, unfavourable: 0,
        caution: '3 comparable cases, 3 favourable.',
      },
    },
  };

  // THE ASYMMETRY, measured rather than asserted: rank the same action under
  // both histories and confirm bad moves it further than good.
  const rankOf = (f, code) => decide(f).all.findIndex((r) => r.action_code === code);
  const scoreProxy = (f) => {
    const d = decide(f);
    return d.all.map((r) => r.action_code).indexOf(ACTION.DECREASE_TARGET_ROI);
  };
  check('a bad case never promotes the action above a clean run',
    scoreProxy(withBad) >= scoreProxy(throttled), true);

  // 4. History must NEVER overturn a failed guardrail. A good run of cases
  //    cannot make a simulated-spend action safe.
  const simulated = {
    ...base,
    roas: { ...base.roas, is_simulated: true },
    reviewedHistory: {
      [ACTION.INCREASE_BUDGET]: {
        status: 'supported_by_history', cases_eligible: 9, favourable: 9, unfavourable: 0,
        caution: 'nine favourable cases',
      },
    },
  };
  const inc = decide(simulated).all.find((r) => r.action_code === ACTION.INCREASE_BUDGET);
  const failedWith = (inc?.guardrails || []).filter((g) => !g.passed).map((g) => g.name);
  check('a strong history does not clear a failed guardrail', failedWith.length > 0, true);

  // THE PROPERTY THAT MATTERS FOR SECTION 17: history may nudge a ranking and
  // must never change what the EVIDENCE says. The same guardrails fail, with
  // the same names, whether or not nine favourable cases exist.
  //
  // (This shop's primary IS a blocked action, because on a simulated shop every
  // candidate is blocked and the least-blocked still wins. That is pre-existing
  // behaviour, disclosed by the failed guardrail and the simulated source tag,
  // and it is not something history should be able to change either way.)
  const withoutHistory = { ...simulated, reviewedHistory: null };
  const incNo = decide(withoutHistory).all.find((r) => r.action_code === ACTION.INCREASE_BUDGET);
  const failedWithout = (incNo?.guardrails || []).filter((g) => !g.passed).map((g) => g.name);
  check('the same guardrails fail with and without a favourable history',
    failedWith.join('|'), failedWithout.join('|'));
  check('and the primary action is unchanged by history alone',
    decide(simulated).primary?.action_code,
    decide(withoutHistory).primary?.action_code);

  // 5. Direction is not collapsed. Raising going badly says little about
  //    lowering, so the lookup is per action code.
  const otherDirection = roiOf({
    ...throttled,
    reviewedHistory: {
      [ACTION.INCREASE_TARGET_ROI]: {
        status: 'caution_from_history', cases_eligible: 2, favourable: 0, unfavourable: 2,
        caution: 'both raises went badly',
      },
    },
  });
  check('history for the opposite direction does not attach',
    otherDirection.prior_cases, null);
}


console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
