// The shared evidence contract.
//
// Section 4. The rule these encode is "missing data is not zero", and the six
// absence states exist because rendering all of them as a dash — or worse, as
// 0 — is the most available way this product could mislead someone.
import {
  stamp, dimension, fromCheck, stateOf, stateLabel,
  STATE, RESULT, BASIS, BASIS_NOTE, STATE_LABEL,
} from '../src/lib/evidence.js';

let pass = 0; let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

console.log('\n── absence has six meanings, and none of them is zero ──');
{
  check('an absent value is unknown, not zero', stateOf(null), STATE.UNKNOWN);
  check('undefined is unknown', stateOf(undefined), STATE.UNKNOWN);
  check('a non-number is unknown', stateOf('n/a'), STATE.UNKNOWN);

  // THE DISTINCTION THAT MATTERS MOST. A zero from a counted set is a fact
  // worth acting on; a zero from summing nothing is the absence of one, and
  // they must not render alike.
  check('a zero we actually measured is a real value',
    stateOf(0, { zeroIsReal: true }), STATE.OBSERVED_ZERO);
  check('a zero we did not measure is NOT a value',
    stateOf(0, { zeroIsReal: false }), STATE.UNKNOWN);

  check('a real number with full coverage is ok', stateOf(42, { coverage: 1 }), STATE.OK);
  check('partial coverage makes it incomplete',
    stateOf(42, { coverage: 0.6 }), STATE.INCOMPLETE);
  check('data older than the window is stale',
    stateOf(42, { staleAfter: '2026-09-05', asOf: '2026-09-01' }), STATE.STALE);
}

console.log('\n── every state renders as words, never as an empty cell ──');
{
  for (const s of Object.values(STATE)) {
    if (s === STATE.OK) continue;
    const label = stateLabel(s);
    check(`${s} has a label`, typeof label === 'string' && label.length > 0, true);
  }
  // An unrecognised state must show as ITSELF rather than vanish.
  check('an unknown state shows as itself', stateLabel('something_new'), 'something_new');
  check('the six states are distinct', new Set(Object.values(STATE)).size, 7);
}

console.log('\n── a check that never ran is not a check that passed ──');
{
  check('a passing check maps to pass',
    fromCheck({ name: 'x', passed: true }).result, RESULT.PASS);
  check('a failing check maps to fail',
    fromCheck({ name: 'x', passed: false }).result, RESULT.FAIL);
  // THE GAP THE OLD BOOLEAN SHAPE COULD NOT EXPRESS. A guardrail that was
  // never evaluated arrives with `passed` undefined, and reading that as false
  // would report a failure nobody measured — while reading it as true would
  // show a clean bill of health beside contradicting diagnostics.
  check('a check that never ran is UNKNOWN, not fail',
    fromCheck({ name: 'x' }).result, RESULT.UNKNOWN);
  check('no check at all is unknown too', fromCheck(null).result, RESULT.UNKNOWN);
  check('the detail survives as the reason',
    fromCheck({ name: 'x', passed: false, detail: 'because' }).reason, 'because');
}

console.log('\n── a dimension carries what produced its verdict ──');
{
  const d = dimension({
    name: 'revenue reconciles',
    result: RESULT.FAIL,
    value: 0.05,
    unit: 'fraction',
    threshold: 0.03,
    policyVersion: '2026-09-10.1',
    reason: 'components differ from total shop GMV by 5%',
  });
  check('the evaluated value is kept', d.value, 0.05);
  check('so is the threshold it was judged against', d.threshold, 0.03);
  check('and the policy version that set it', d.policy_version, '2026-09-10.1');
  check('and the units, so 0.05 is not read as 5', d.unit, 'fraction');
}

console.log('\n── the envelope keeps absent fields visible ──');
{
  const s = stamp({
    shopId: 's1', shopName: 'Biostime',
    entityType: 'campaign', entityId: '1855416962446337',
    timezone: 'America/Los_Angeles', currency: 'USD', unit: 'currency',
    windowStart: '2026-09-02', windowEnd: '2026-09-08',
    asOf: '2026-09-10T12:00:00Z', ruleVersion: '2026-09-08.1',
    basis: BASIS.MEASURED,
  });

  check('scope names the entity, not just the shop',
    [s.scope.entity_type, s.scope.entity_id], ['campaign', '1855416962446337']);
  check('units are carried', [s.units.currency, s.units.timezone], ['USD', 'America/Los_Angeles']);
  check('the window is carried', [s.window.start, s.window.end], ['2026-09-02', '2026-09-08']);
  check('the rule version is carried', s.versions.rule, '2026-09-08.1');
  check('and the basis', s.basis, BASIS.MEASURED);

  // ABSENT IS NOT OMITTED. A consumer must be able to see that a field was not
  // filled, rather than read `undefined` and treat it as fine.
  check('an unfilled comparison window is null, not missing', s.comparison, null);
  check('unfilled coverage is present and null',
    [Object.prototype.hasOwnProperty.call(s.coverage, 'available_through'),
      s.coverage.available_through], [true, null]);
  check('an unfilled model version is present and null',
    [Object.prototype.hasOwnProperty.call(s.versions, 'model'), s.versions.model], [true, null]);

  const empty = stamp();
  check('an empty stamp still has every section',
    Object.keys(empty).sort(),
    ['as_of', 'basis', 'comparison', 'coverage', 'scope', 'units', 'versions', 'window']);
}

console.log('\n── a campaign setting is not a shop outcome ──');
{
  // The most tempting misattribution in this product: reading shop-level
  // revenue as a campaign's earnings. The scope block is what prevents it.
  const shopLevel = stamp({ shopId: 's1', entityType: 'shop' });
  const campaignLevel = stamp({ shopId: 's1', entityType: 'campaign', entityId: 'c1' });
  check('the two are distinguishable',
    shopLevel.scope.entity_type !== campaignLevel.scope.entity_type, true);
  check('a shop-level figure names no entity id', shopLevel.scope.entity_id, null);
}

console.log('\n── how a figure was produced is not how much to trust it ──');
{
  check('there are five bases', new Set(Object.values(BASIS)).size, 5);
  check('modelled is distinct from measured', BASIS.MODELLED === BASIS.MEASURED, false);
  check('estimated is distinct from modelled', BASIS.ESTIMATED === BASIS.MODELLED, false);
  // Every basis must explain itself; an unexplained label is a label people
  // invent their own meaning for.
  for (const b of Object.values(BASIS)) {
    check(`${b} has a note`, typeof BASIS_NOTE[b] === 'string' && BASIS_NOTE[b].length > 0, true);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
