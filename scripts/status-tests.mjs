// Campaign status canonicalisation.
//
// This is the bug that produced both of the review's campaign observations at
// once. Reacher answers "is it running?" in two vocabularies depending on the
// endpoint — the campaign LIST says ENABLE/DISABLE, the SETTINGS call says
// enabled/disabled — and every consumer compared against the literal 'ENABLE'.
// So every real campaign read as inactive, and the only row that ever matched
// was the SIMULATED one.
//
// Acceptance case T08. Also protects migration 028: a snapshot stored as ENABLE
// one day and enabled the next would otherwise record a change that never
// happened.
import { canonicalStatus, isActiveStatus, statusLabel, CAMPAIGN_STATUS } from '../src/lib/campaignStatus.js';
import { budgetAvailability } from '../src/lib/budget.js';

let pass = 0; let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

console.log('\n── both of Reacher’s vocabularies mean the same thing ──');
{
  check('the campaign list spelling', canonicalStatus('ENABLE'), CAMPAIGN_STATUS.ENABLE);
  check('the settings-call spelling', canonicalStatus('enabled'), CAMPAIGN_STATUS.ENABLE);
  check('and both are active', [isActiveStatus('ENABLE'), isActiveStatus('enabled')], [true, true]);

  check('paused, both spellings', [canonicalStatus('DISABLE'), canonicalStatus('disabled')],
    [CAMPAIGN_STATUS.DISABLE, CAMPAIGN_STATUS.DISABLE]);
  check('and neither is active', [isActiveStatus('DISABLE'), isActiveStatus('disabled')], [false, false]);
}

console.log('\n── the exact regression: a live campaign read as paused ──');
{
  // Biostime as Reacher actually returned it after the settings call.
  const asStored = [
    { status: 'enabled', daily_budget: 550 },
    { status: 'disabled', daily_budget: 100 },
    { status: 'disabled', daily_budget: 200 },
    { status: 'disabled', daily_budget: 200 },
  ];
  const b = budgetAvailability(asStored);
  check('the live campaign is recognised', b.state, 'active');
  check('and its budget is the active one', b.activeDailyBudget, 550);
  check('one active of four', [b.activeCount, b.campaignCount], [1, 4]);

  // What the old comparison produced, kept as the thing we must never return to.
  const oldWay = asStored.filter((c) => c.status === 'ENABLE');
  check('the old literal comparison found nothing, which is the bug', oldWay.length, 0);
}

console.log('\n── an unknown status is surfaced, never guessed ──');
{
  // A provider free to invent a spelling must not be able to make a paused
  // campaign look fundable.
  check('an unrecognised value is preserved verbatim',
    canonicalStatus('STATUS_SOMETHING_NEW'), 'STATUS_SOMETHING_NEW');
  check('and is NOT treated as active', isActiveStatus('STATUS_SOMETHING_NEW'), false);
  check('and is labelled as itself rather than hidden',
    statusLabel('STATUS_SOMETHING_NEW'), 'STATUS_SOMETHING_NEW');
  check('a shop of only unknown statuses has no active budget',
    budgetAvailability([{ status: 'STATUS_SOMETHING_NEW', daily_budget: 900 }]).state, 'no_active');
}

console.log('\n── absent status ──');
{
  check('null', canonicalStatus(null), null);
  check('empty string', canonicalStatus(''), null);
  check('whitespace only', canonicalStatus('   '), null);
  check('null is not active', isActiveStatus(null), false);
  check('and reads as Unknown', statusLabel(null), 'Unknown');
}

console.log('\n── tolerated spellings ──');
{
  check('surrounding whitespace and mixed case', canonicalStatus('  EnAbLeD '), CAMPAIGN_STATUS.ENABLE);
  check('TikTok delivery status', canonicalStatus('STATUS_DELIVERY_OK'), CAMPAIGN_STATUS.ENABLE);
  check('TikTok disable status', canonicalStatus('STATUS_DISABLE'), CAMPAIGN_STATUS.DISABLE);
  check('deleted is its own state, not paused', canonicalStatus('STATUS_DELETE'), CAMPAIGN_STATUS.DELETE);
  check('and deleted is not active', isActiveStatus('STATUS_DELETE'), false);
  check('deleted is labelled', statusLabel('deleted'), 'Deleted');
}

console.log('\n── labels ──');
{
  check('active', statusLabel('enabled'), 'Active');
  check('inactive', statusLabel('DISABLE'), 'Inactive');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
