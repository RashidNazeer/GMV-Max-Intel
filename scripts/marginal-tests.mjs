// Unit tests for layer 5. No framework, same plain-node style as the others.
//   node scripts/marginal-tests.mjs
//
// This model can move real budget, so the tests are weighted heavily toward the
// cases where it must REFUSE. Recovering a known elasticity from synthetic data
// proves the arithmetic; refusing flat spend, thin history and wide intervals
// proves the judgement, and the judgement is the part that protects money.
import {
  fitSpendResponse, scenarios, ols, isAnswerable,
  STATUS, MIN_DAYS, MIN_CV,
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

console.log('\n── scenarios ──');
{
  const f = fitSpendResponse(synth({ b: 0.6, noise: 0.02, n: 40 }));
  check('scenarios accompany an answerable fit', f.scenarios.length > 0, true);
  const up20 = f.scenarios.find((s) => Math.abs(s.delta - 0.2) < 1e-9);
  check('+20% spends 20% more', Math.abs(up20.spend / f.total_spend - 1.2) < 1e-9, true);
  check('with b < 1 the extra spend returns less than the average',
    up20.incremental_roas < f.avg_roas, true);
  check('incremental roas is close to marginal at small steps',
    Math.abs(f.scenarios.find((s) => Math.abs(s.delta - 0.1) < 1e-9).incremental_roas - f.marginal_roas)
      < 0.12 * f.marginal_roas, true);
  const down = f.scenarios.find((s) => Math.abs(s.delta + 0.2) < 1e-9);
  check('cutting spend frees money and gives up revenue',
    down.incremental_spend < 0 && down.incremental_revenue < 0, true);
  check('scenarios on an unanswerable fit are absent',
    scenarios({ total_spend: 0, total_revenue: 0, elasticity: null }).length, 0);
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

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED: ' + failures.join(', ')); process.exit(1); }
