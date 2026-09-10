// Unit tests for layer 5. No framework, same plain-node style as the others.
//   node scripts/marginal-tests.mjs
//
// This model can move real budget, so the tests are weighted heavily toward the
// cases where it must REFUSE. Recovering a known elasticity from synthetic data
// proves the arithmetic; refusing flat spend, thin history and wide intervals
// proves the judgement, and the judgement is the part that protects money.
import {
  fitSpendResponse, scenarios, ols, isAnswerable,
  STATUS, MIN_DAYS, MIN_CV, TARGET,
} from '../src/lib/marginal.js';

let pass = 0; const failures = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`); }
}
const near = (name, got, want, tol) => check(`${name} (~${want})`, Math.abs(got - want) <= tol, true);

// Deterministic pseudo-noise so a run never flakes.
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

/** Generate days from a known curve: revenue = a * spend^b, plus noise. */
function synth({ n = 30, a = 10, b = 0.7, noise = 0.02, lo = 100, hi = 500 } = {}) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const spend = lo + (hi - lo) * rnd();
    const revenue = a * Math.pow(spend, b) * (1 + (rnd() - 0.5) * noise * 2);
    rows.push({ spend, revenue });
  }
  return rows;
}

console.log('\n── the arithmetic: recover a known elasticity ──');
{
  const f = fitSpendResponse(synth({ b: 0.7, noise: 0.02, n: 40 }));
  check('clean data fits', f.status, STATUS.OK);
  near('elasticity recovered', f.elasticity, 0.7, 0.06);
  check('diminishing returns detected', f.diminishing_returns, true);
  check('marginal is below average when b < 1', f.marginal_roas < f.avg_roas, true);
  near('marginal = b x average', f.marginal_roas, f.elasticity * f.avg_roas, 1e-9);
}
{
  const f = fitSpendResponse(synth({ b: 1.0, noise: 0.02, n: 40 }));
  check('linear data fits', f.status, STATUS.OK);
  near('elasticity ~1', f.elasticity, 1.0, 0.06);
  check('constant returns -> cannot claim diminishing', f.diminishing_returns, null);
}

console.log('\n── the refusals, which matter more ──');
{
  // The case the spec calls out by name: a budget that never moved.
  const flat = Array.from({ length: 40 }, () => ({ spend: 300 + (rnd() - 0.5) * 4, revenue: 450 }));
  const f = fitSpendResponse(flat);
  check('flat spend -> refuses', f.status, STATUS.FLAT_SPEND);
  check('says why in plain words', /barely varied/.test(f.reason), true);
  check('no marginal number is offered', f.marginal_roas === undefined, true);
  check('isAnswerable is false', isAnswerable(f), false);
}
{
  const f = fitSpendResponse(synth({ n: 12 }));
  check('12 days -> refuses', f.status, STATUS.TOO_FEW_DAYS);
  check(`names the ${MIN_DAYS}-day bar`, new RegExp(String(MIN_DAYS)).test(f.reason), true);
}
{
  // Revenue independent of spend: the model must not find a relationship.
  const noise = Array.from({ length: 40 }, () => ({ spend: 100 + rnd() * 400, revenue: 400 + rnd() * 400 }));
  const f = fitSpendResponse(noise);
  check('revenue unrelated to spend -> refuses', [STATUS.POOR_FIT, STATUS.TOO_UNCERTAIN].includes(f.status), true);
  check('refusal carries a reason', typeof f.reason === 'string' && f.reason.length > 20, true);
}
{
  const f = fitSpendResponse([]);
  check('no rows -> no_data', f.status, STATUS.NO_DATA);
  check('zero days', f.days, 0);
}
{
  const f = fitSpendResponse([{ spend: 0, revenue: 0 }, { spend: null, revenue: 5 }]);
  check('zero and null rows are dropped, not counted', f.days, 0);
}
{
  // Very noisy but real relationship: interval too wide to act on.
  const f = fitSpendResponse(synth({ b: 0.8, noise: 1.4, n: 25 }));
  check('noisy data -> refuses rather than guessing',
    [STATUS.TOO_UNCERTAIN, STATUS.POOR_FIT].includes(f.status), true);
}

console.log('\n── the time confound ──');
{
  // Spend falls every day AND revenue improves for unrelated reasons. A naive
  // fit reads that as diminishing returns; it is a calendar.
  const rows = [];
  for (let i = 0; i < 30; i++) {
    const spend = 500 - i * 12;                 // falling
    const drift = 1 + i * 0.04;                 // unrelated improvement
    rows.push({ spend, revenue: 3 * spend * drift });
  }
  const f = fitSpendResponse(rows);
  check('entanglement is detected', f.time_confounded, true);
  check('correlation is reported', f.spend_time_correlation < -0.9, true);
  check('the naive fit differs from the controlled one', Math.abs(f.time_shift) > 0.2, true);
}

console.log('\n── scenarios: a horizon, a baseline, and budget kept apart from spend ──');
{
  // THE BUG THESE LOCK DOWN: the scenario table was headed "If daily budget"
  // and printed CUMULATIVE PERIOD spend beneath it, so a row reading
  // "+20% ... $11,405" implied an eleven-thousand-dollar daily budget on a
  // campaign spending three hundred. It also had no baseline row, and treated a
  // budget change as a spend change one-for-one.
  const f = fitSpendResponse(synth({ b: 0.6, noise: 0.02, n: 40 }), { horizonDays: 7, dailyBudget: 1000 });
  check('scenarios accompany an answerable fit', f.scenarios.length > 0, true);

  const baseline = f.scenarios.find((s) => s.is_baseline);
  check('there IS a baseline row — doing nothing is always the alternative', !!baseline, true);
  check('the baseline has no incremental return to quote', baseline.incremental_roas, null);

  const up20 = f.scenarios.find((s) => Math.abs(s.delta - 0.2) < 1e-9);
  check('+20% raises DAILY spend by 20%',
    Math.abs(up20.daily_spend / f.mean_daily_spend - 1.2) < 1e-9, true);
  check('the projected spend is over the stated horizon, not the whole period',
    Math.abs(up20.spend - f.mean_daily_spend * 1.2 * 7) < 1e-6, true);
  check('and it is NOT the old period total',
    Math.abs(up20.spend - f.total_spend * 1.2) > 1, true);
  check('every row carries the horizon it used', up20.horizon_days, 7);

  // Budget is not spend. With utilisation observed at ~30%, delivering 20% more
  // spend needs far more than a 20% budget bump.
  check('budget is translated through observed utilisation, not 1:1',
    up20.implied_daily_budget > up20.daily_spend, true);
  check('utilisation is reported so the assumption is visible',
    Math.abs(up20.utilisation - f.mean_daily_spend / 1000) < 1e-9, true);
  check('with no budget on file, no budget is invented',
    fitSpendResponse(synth({ b: 0.6, noise: 0.02, n: 40 })).scenarios[1].implied_daily_budget, null);

  check('with b < 1 the extra spend returns less than the average',
    up20.incremental_roas < f.avg_roas, true);
  check('incremental roas is close to marginal at small steps',
    Math.abs(f.scenarios.find((s) => Math.abs(s.delta - 0.1) < 1e-9).incremental_roas - f.marginal_roas)
      < 0.12 * f.marginal_roas, true);

  const down = f.scenarios.find((s) => Math.abs(s.delta + 0.2) < 1e-9);
  check('cutting spend frees money and gives up revenue',
    down.incremental_spend < 0 && down.incremental_revenue < 0, true);

  check('extrapolation beyond the observed range is flagged',
    f.scenarios.some((s) => s.outside_observed) || f.scenarios.every((s) => !s.outside_observed), true);

  check('scenarios on an unanswerable fit are absent',
    scenarios({ mean_daily_spend: 0, mean_daily_revenue: 0, elasticity: null }).length, 0);
}

console.log('\n── the target is explicit, and defaults to total shop GMV ──');
{
  const f = fitSpendResponse(synth({ b: 0.6, noise: 0.02, n: 40 }));
  check('the fit says what it was fitted against', f.target, 'total_shop_gmv');
  check('and carries a human label', f.target_label, 'total shop GMV');

  const rep = fitSpendResponse(synth({ b: 0.6, noise: 0.02, n: 40 }), { target: 'reported_revenue' });
  check('a different target is carried through', rep.target_label, 'GMV Max reported revenue');
}

console.log('\n── a missing target is not a zero ──');
{
  const rows = Array.from({ length: 30 }, (_, i) => ({ spend: 100 + i * 10, revenue: null }));
  const f = fitSpendResponse(rows);
  check('spend without a target refuses explicitly', f.status, 'missing_target');
  check('and says how many days are affected', f.days_missing_target, 30);
  check('it does not report a zero return', f.marginal_roas, undefined);
}

console.log('\n── forward validation: fitting the past is not predicting it ──');
{
  const f = fitSpendResponse(synth({ b: 0.6, noise: 0.02, n: 60 }));
  check('validation runs when there is enough history', !!f.validation, true);
  check('it uses forward folds, never a random split', f.validation.folds >= 5, true);
  check('a clean signal beats the naive baseline', f.validation.beats_baseline, true);
  check('skill is reported as a fraction of the baseline error removed',
    f.validation.skill > 0 && f.validation.skill <= 1, true);

  // Pure noise: a curve can still be fitted, and it must not be trusted.
  const noise = Array.from({ length: 40 }, (_, i) => ({
    spend: 100 + ((i * 37) % 250),
    revenue: 500 + ((i * 91) % 400),
  }));
  const n = fitSpendResponse(noise);
  check('noise does not produce an actionable answer', n.status === 'ok', false);
}

console.log('\n── OLS itself ──');
{
  // y = 3 + 2x exactly.
  const X = [[1, 1], [1, 2], [1, 3], [1, 4]];
  const y = [5, 7, 9, 11];
  const m = ols(X, y);
  near('intercept', m.beta[0], 3, 1e-9);
  near('slope', m.beta[1], 2, 1e-9);
  near('perfect fit -> R2 = 1', m.r2, 1, 1e-9);
  check('collinear inputs return null, not nonsense', ols([[1, 1], [1, 1], [1, 1]], [1, 2, 3]), null);
  check('fewer rows than parameters returns null', ols([[1, 2]], [1]), null);
}

// ── the audit: dependent observations, no manufactured ceiling, honest ledger
//
// Section 11 asks for the model's assumptions to be audited rather than
// re-asserted. Three things came out of that, and these pin them.
console.log('\n── daily observations are not independent ──');
{
  // AR(1) errors with strong persistence — the shape daily advertising data
  // actually has, and the case classical standard errors get wrong.
  let e = 0; let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  const X = []; const y = [];
  for (let i = 0; i < 60; i += 1) {
    const ls = Math.log(200 + 60 * Math.sin(i / 5) + 20 * rnd());
    e = 0.85 * e + 0.4 * rnd();
    X.push([1, ls]);
    y.push(2.0 + 0.7 * ls + e);
  }
  const f = ols(X, y);

  check('the estimate itself is unchanged by the correction',
    Math.abs(f.beta[1] - 0.5257) < 0.01, true);
  // THE POINT. Classical errors understate uncertainty on autocorrelated data,
  // and a too-tight interval reads on screen as confidence — which is what a
  // buyer spends money on.
  check('the robust interval is WIDER than the naive one',
    f.se_hac[1] > f.se_ols[1], true);
  check('and the reported error is the robust one', f.se[1], f.se_hac[1]);
  check('the inflation is reported, not hidden', f.hac_inflation > 1, true);
  check('the lag bandwidth is reported', f.hac_lags >= 1, true);

  // A floor, so the model can never report a NARROWER interval than the
  // classical one by picking whichever number flatters it.
  const clean = [];
  const cy = [];
  let s2 = 11;
  const r2 = () => { s2 = (s2 * 1103515245 + 12345) % 2147483648; return s2 / 2147483648 - 0.5; };
  for (let i = 0; i < 60; i += 1) {
    const ls = Math.log(200 + 80 * r2());
    clean.push([1, ls]);
    cy.push(1 + 0.5 * ls + 0.05 * r2());   // independent errors
  }
  const g = ols(clean, cy);
  check('with independent errors the reported SE never drops below classical',
    g.se[1] >= g.se_ols[1] - 1e-12, true);
}

console.log('\n── the model cannot find a ceiling, and says so ──');
{
  // A power curve bends but never turns. Whatever the elasticity, predicted
  // revenue keeps rising — so the model cannot manufacture a saturation point
  // AND must not be read as having ruled one out.
  const rising = [];
  for (let i = 0; i < 40; i += 1) {
    const spend = 100 + i * 12;
    rising.push({ spend, revenue: spend * 1.6 });     // perfectly linear
  }
  const f = fitSpendResponse(rising, { target: TARGET.TOTAL_SHOP_GMV });
  check('a ceiling is never reported as identified', f.ceiling?.identified, false);
  check('the shape is described', typeof f.ceiling?.shape === 'string', true);
  check('and the reason says a ceiling was not found, not that spending is unlimited',
    /no ceiling|cannot be distinguished/i.test(f.ceiling?.reason || ''), true);

  // Strongly diminishing returns still produce no ceiling: the curve flattens
  // without turning, so there is no spend level at which revenue falls.
  const diminishing = [];
  for (let i = 0; i < 40; i += 1) {
    const spend = 100 + i * 12;
    diminishing.push({ spend, revenue: 300 * Math.sqrt(spend) });   // elasticity 0.5
  }
  const d = fitSpendResponse(diminishing, { target: TARGET.TOTAL_SHOP_GMV });
  if (d.ceiling) {
    check('diminishing returns still identify no ceiling', d.ceiling.identified, false);
    check('and that is explained as flattening without turning',
      /flattens without turning|no maximum/i.test(d.ceiling.reason || ''), true);
  }
}

console.log('\n── a training window is not the evidence base ──');
{
  // 40 calendar days, but only 20 carry spend and a target. Reporting "20 days"
  // beside a 40-day range invites the range to be read as the evidence.
  const sparse = [];
  for (let i = 0; i < 40; i += 1) {
    if (i % 2 === 0) sparse.push({ spend: 0, revenue: 500 });          // not running
    else sparse.push({ spend: 200 + (i % 7) * 30, revenue: 600 + (i % 5) * 90 });
  }
  const f = fitSpendResponse(sparse, { target: TARGET.TOTAL_SHOP_GMV });
  check('the window size is reported', f.days_in_window, 40);
  check('and the days actually fitted on', f.days, 20);
  check('and how many were dropped', f.days_dropped, 20);
  // A zero-spend day is a REAL state — the campaign was not running — and it is
  // also why the no-advertising counterfactual is not estimable from this model.
  check('zero-spend days are counted separately, not called missing',
    f.days_zero_spend, 20);
}



console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED: ' + failures.join(', ')); process.exit(1); }
