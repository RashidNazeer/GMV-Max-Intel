// Unit tests for the paid/organic classifier (spec §39.1). No framework — same
// plain-node style as the WurxOS scripts/ tests, so it ports without a harness.
//   node scripts/classify-tests.mjs
import {
  classifyTransaction, summarize, countsTowardGmv, CLASS, BASIS,
} from '../src/lib/reacher/classify.js';

let pass = 0; const failures = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`); }
}

// Shape mirrors a real Reacher row (see scratchpad/reacher-probe/sample_transaction_11515.json).
const row = (over = {}) => ({
  order_id: 'o1', payment_amount: 100, fully_refunded: false, order_status: 'Pending',
  standard_commission_rate: null, shop_ads_commission_rate: null,
  estimated: { commission_base: null, standard_commission: null, shop_ads_commission: null, cofunded_creator_bonus: null },
  actual: { commission_base: null, standard_commission: null, shop_ads_commission: null, cofunded_creator_bonus: null },
  ...over,
});
const cls = (t) => { const r = classifyTransaction(t); return [r.classification, r.basis]; };

console.log('\n── settled orders: actual commission decides ──');
check('actual shop-ads only -> PAID/ACTUAL',
  cls(row({ actual: { shop_ads_commission: 5.6, standard_commission: null } })),
  [CLASS.PAID, BASIS.ACTUAL]);
check('actual standard only -> ORGANIC/ACTUAL',
  cls(row({ actual: { shop_ads_commission: null, standard_commission: 12 } })),
  [CLASS.ORGANIC, BASIS.ACTUAL]);

console.log('\n── pending orders fall back to estimated (§12.2) ──');
check('no actual, estimated shop-ads -> PAID/ESTIMATED',
  cls(row({ estimated: { shop_ads_commission: 5.6, standard_commission: null } })),
  [CLASS.PAID, BASIS.ESTIMATED]);
check('no actual, estimated standard -> ORGANIC/ESTIMATED',
  cls(row({ estimated: { shop_ads_commission: null, standard_commission: 9 } })),
  [CLASS.ORGANIC, BASIS.ESTIMATED]);
check('actual WINS over a contradicting estimate',
  cls(row({
    actual:    { shop_ads_commission: null, standard_commission: 9 },
    estimated: { shop_ads_commission: 5.6,  standard_commission: null },
  })),
  [CLASS.ORGANIC, BASIS.ACTUAL]);

console.log('\n── zero is a statement; null is not (the subtle one) ──');
check('actual paid>0 with standard EXPLICITLY 0 -> PAID',
  cls(row({ actual: { shop_ads_commission: 5.6, standard_commission: 0 } })),
  [CLASS.PAID, BASIS.ACTUAL]);
check('both actual explicitly 0 -> falls through, not PAID',
  cls(row({ actual: { shop_ads_commission: 0, standard_commission: 0 } })),
  [CLASS.UNCLASSIFIED, BASIS.NONE]);
check('empty string is missing, not zero',
  cls(row({ actual: { shop_ads_commission: '', standard_commission: '' },
            estimated: { shop_ads_commission: 3, standard_commission: null } })),
  [CLASS.PAID, BASIS.ESTIMATED]);

console.log('\n── ambiguity is never forced to a side (§12.1) ──');
check('both actual commissions non-zero -> MIXED',
  cls(row({ actual: { shop_ads_commission: 4, standard_commission: 7 } })),
  [CLASS.MIXED, BASIS.ACTUAL]);
check('MIXED is not treated as confident',
  classifyTransaction(row({ actual: { shop_ads_commission: 4, standard_commission: 7 } })).confident,
  false);
check('no commission evidence at all -> UNCLASSIFIED',
  cls(row()), [CLASS.UNCLASSIFIED, BASIS.NONE]);

console.log('\n── rate-only fallback is weaker evidence, and says so ──');
check('rates only -> classified but NOT confident',
  cls(row({ shop_ads_commission_rate: 0.2 })), [CLASS.PAID, BASIS.RATE]);
check('rate-only is flagged unconfident',
  classifyTransaction(row({ shop_ads_commission_rate: 0.2 })).confident, false);
check('a commission amount outranks the rate fields',
  cls(row({ shop_ads_commission_rate: 0.2, estimated: { standard_commission: 9, shop_ads_commission: null } })),
  [CLASS.ORGANIC, BASIS.ESTIMATED]);

console.log('\n── refunds and cancellations (§12.3) ──');
check('fully refunded is excluded from GMV', countsTowardGmv(row({ fully_refunded: true })), false);
check('cancelled is excluded from GMV', countsTowardGmv(row({ order_status: 'Cancelled' })), false);
check('a normal pending order counts', countsTowardGmv(row()), true);

console.log('\n── rollup arithmetic ──');
{
  const s = summarize([
    row({ payment_amount: 100, actual: { shop_ads_commission: 5, standard_commission: null } }),
    row({ payment_amount: 300, actual: { shop_ads_commission: null, standard_commission: 9 } }),
    row({ payment_amount: 50,  fully_refunded: true, actual: { shop_ads_commission: 5, standard_commission: null } }),
    row({ payment_amount: 100 }),                                     // unclassified
  ]);
  check('lines counted (refund excluded)', s.lines, 3);
  check('gmv sums only counted lines', s.gmv, 500);
  check('paid gmv', s.paidGmv, 100);
  check('organic gmv', s.organicGmv, 300);
  check('excluded lines tracked', s.excludedLines, 1);
  check('paid share is of CLASSIFIED gmv, not total', Number(s.paidShare.toFixed(4)), 0.25);
  check('coverage exposes the unclassified hole', Number(s.coverage.toFixed(4)), 0.8);
}
{
  const s = summarize([]);
  check('empty input yields nulls, not fake zeros', [s.paidShare, s.coverage], [null, null]);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED: ' + failures.join(', ')); process.exit(1); }
