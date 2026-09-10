// Budget availability, kept free of the data layer so it can be tested.
//
// This lives apart from facts.js on purpose: facts.js is a React hook that
// imports api.js and therefore Supabase, so anything defined inside it can only
// be exercised through a browser. A rule this load-bearing needs unit tests.

/**
 * BUDGET AVAILABILITY IS NOT CAMPAIGN ELIGIBILITY.
 *
 * The Overview said "no budget on file" whenever no campaign was enabled, and
 * on the reviewed shop that was wrong in the way that matters: all four
 * campaigns carried configured budgets (100, 200, 200, 550) while paused. An
 * operator reading "no budget on file" goes to check whether their settings
 * were lost. The actual fact was that nothing was running.
 *
 * Four states, because they call for four different actions:
 *   no_campaigns    nothing exists to fund
 *   no_active       budgets exist but nothing is delivering   <- the defect
 *   no_budget_set   campaigns are live with no budget recorded
 *   active          a live budget, so a utilisation ratio means something
 *
 * `configuredDailyBudget` counts EVERY campaign regardless of status: it
 * answers "what is set", never "what constrains delivery". Only
 * `activeDailyBudget` may be the denominator of a utilisation figure, which is
 * why it stays null in the three non-active states rather than falling back to
 * the configured total. That null is what stops a paused shop reporting a
 * utilisation percentage for delivery that never happened.
 */
import { isActiveStatus } from './campaignStatus.js';

export function budgetAvailability(campaigns = []) {
  const all = Array.isArray(campaigns) ? campaigns : [];
  const enabled = all.filter((c) => isActiveStatus(c.status));
  // `|| null` also collapses an explicit 0, which is correct here: a campaign
  // set to zero cannot fund delivery, so it must not become an active budget.
  const sum = (rows) => rows.reduce((a, c) => a + (Number(c.daily_budget) || 0), 0) || null;
  const activeDailyBudget = sum(enabled);
  return {
    state: !all.length ? 'no_campaigns'
      : !enabled.length ? 'no_active'
        : activeDailyBudget == null ? 'no_budget_set'
          : 'active',
    activeDailyBudget,
    configuredDailyBudget: sum(all),
    activeCount: enabled.length,
    campaignCount: all.length,
  };
}
