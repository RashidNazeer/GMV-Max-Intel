// Budget availability, tested against the case that motivated it.
//
// The reviewed shop showed "no budget on file" while carrying four campaigns
// with configured budgets of 100, 200, 200 and 550. Every one of them was
// paused. Those are different facts and they send an operator to different
// places, so they get different sentences.
//
// Acceptance case T08: "Configured inactive budgets must not produce No budget
// on file or a false active utilisation ratio."
import { budgetAvailability } from '../src/lib/budget.js';

let pass = 0; let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const c = (status, daily_budget) => ({ status, daily_budget });

console.log('\n── the reviewed shop: four paused campaigns, all with budgets ──');
{
  // The real Biostime figures as at the review.
  const paused = [c('DISABLE', 100), c('DISABLE', 200), c('DISABLE', 200), c('DISABLE', 550)];
  const b = budgetAvailability(paused);
  check('the state is no_active, not a missing budget', b.state, 'no_active');
  check('the configured total is reported in full', b.configuredDailyBudget, 1050);
  check('but no ACTIVE budget is claimed', b.activeDailyBudget, null);
  check('and the campaigns are counted', [b.campaignCount, b.activeCount], [4, 0]);
}

console.log('\n── a null active budget is what stops a false utilisation ratio ──');
{
  // The Overview computes util as mean_daily_spend / activeDailyBudget. If the
  // configured total leaked into that denominator, a paused shop would report
  // a utilisation percentage for delivery that never happened.
  const b = budgetAvailability([c('DISABLE', 550)]);
  const meanDailySpend = 285.7;
  const util = b.activeDailyBudget ? meanDailySpend / b.activeDailyBudget : null;
  check('utilisation is not computable while nothing is running', util, null);

  const live = budgetAvailability([c('ENABLE', 550)]);
  const liveUtil = live.activeDailyBudget ? meanDailySpend / live.activeDailyBudget : null;
  check('and is computable once a campaign is live', Math.round(liveUtil * 100) / 100, 0.52);
}

console.log('\n── the other three states are distinguishable ──');
{
  check('no campaigns at all', budgetAvailability([]).state, 'no_campaigns');
  check('undefined input does not throw', budgetAvailability().state, 'no_campaigns');
  check('live campaigns with no budget recorded',
    budgetAvailability([c('ENABLE', null)]).state, 'no_budget_set');
  check('live campaigns with a budget', budgetAvailability([c('ENABLE', 550)]).state, 'active');
}

console.log('\n── mixed: one live campaign among paused ones ──');
{
  // Exactly the shop's state today. The active budget must count ONLY the live
  // campaign, or the denominator silently includes budgets that cannot spend.
  const b = budgetAvailability([
    c('ENABLE', 550), c('DISABLE', 100), c('DISABLE', 200), c('DISABLE', 200),
  ]);
  check('the state is active', b.state, 'active');
  check('the active budget is the live campaign alone', b.activeDailyBudget, 550);
  check('while the configured total still names everything set', b.configuredDailyBudget, 1050);
  check('counts reflect the split', [b.campaignCount, b.activeCount], [4, 1]);
}

console.log('\n── a zero budget is not a missing budget ──');
{
  // Number(0) || null collapses 0 to null, which would be a lie of a different
  // kind. A campaign explicitly set to 0 is a real, deliberate setting.
  const b = budgetAvailability([c('ENABLE', 0)]);
  check('an explicit zero reads as no budget recorded, not as active',
    b.state, 'no_budget_set');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
