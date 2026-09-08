// Organic momentum, tested — weighted toward the cases where a missing signal
// must NOT be scored as zero.
//
// That is the failure that matters here. A shop with half its components
// unavailable would otherwise be reported as "stable", which reads as a
// measurement of steady demand rather than an absence of evidence.
import { momentum, change, WEIGHTS, LABEL, MOMENTUM_VERSION } from '../src/lib/momentum.js';

let pass = 0; let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const attr = (organic, affiliate, orders) => ({
  measured_organic_gmv: organic, affiliate_video_sc_gmv: affiliate, orders,
});
const cre = (creators, newVideos, winners) => ({
  creators, new_videos: newVideos, winners,
});

const now = { attribution: attr(10000, 20000, 500), creative: cre(40, 12, 8) };
const flat = { attribution: attr(10000, 20000, 500), creative: cre(40, 12, 8) };
const down = { attribution: attr(20000, 30000, 800), creative: cre(60, 20, 14) };
const up = { attribution: attr(5000, 12000, 260), creative: cre(22, 5, 3) };

console.log('\n── change() refuses what it cannot compute ──');
check('a normal change', change(110, 100), 0.1);
check('growth from zero has NO percentage', change(50, 0), null);
check('a missing current value', change(null, 100), null);
check('a missing prior value', change(100, null), null);
check('zero to zero is still not a change', change(0, 0), null);

console.log('\n── direction ──');
{
  const m = momentum(now, up);       // everything grew against a smaller prior
  check('growth produces a positive score', m.score > 0, true);
  check('and a growing-or-strong label', [LABEL.GROWING, LABEL.STRONG].includes(m.label), true);

  const d = momentum(now, down);     // everything shrank against a larger prior
  check('decline produces a negative score', d.score < 0, true);
  check('and a weakening-or-declining label', [LABEL.WEAKENING, LABEL.DECLINING].includes(d.label), true);

  const f = momentum(now, flat);
  check('no movement is stable', f.label, LABEL.STABLE);
  check('and lands on zero', Math.abs(f.score) < 1e-9, true);
}

console.log('\n── A MISSING COMPONENT IS NOT A ZERO ──');
{
  // Only organic revenue is measurable. Everything else has no prior.
  const sparseNow = { attribution: { measured_organic_gmv: 12000 }, creative: {} };
  const sparsePrior = { attribution: { measured_organic_gmv: 10000 }, creative: {} };
  const m = momentum(sparseNow, sparsePrior);

  check('the one available component still scores', m.parts.find((p) => p.key === 'organic_gmv').available, true);
  check('the unavailable ones are marked, not scored',
    m.parts.filter((p) => !p.available).every((p) => p.score === null), true);
  check('coverage reports how little was measured', Math.round(m.coverage * 100), 30);
  check('below half coverage there is NO label', m.label, null);
  check('and it says why rather than showing a number as if it were solid',
    /too little to put a label on/.test(m.reason), true);

  // The score itself is renormalised over what exists — organic grew 20%, so
  // the score must be clearly positive rather than dragged toward zero by five
  // components that were counted as no-change.
  check('the score is not diluted by the missing components', m.score > 0.3, true);
}

console.log('\n── views are permanently excluded, and said so ──');
{
  const m = momentum(now, up);
  const views = m.parts.find((p) => p.key === 'views');
  check('views is present as a declared component', !!views, true);
  check('but never available', views.available, false);
  check('and explains that lifetime views cannot express a trend',
    /lifetime views/.test(views.detail), true);
  check('coverage can therefore never reach 100%', m.coverage <= 0.95, true);
}

console.log('\n── one viral day cannot pin the score ──');
{
  const spike = { attribution: attr(500000, 20000, 500), creative: cre(40, 12, 8) };
  const m = momentum(spike, up);
  check('a 100x day does not max the score', m.score < 1, true);
  check('but it does read as strong', m.label, LABEL.STRONG);

  // And a merely good month must not be indistinguishable from the 100x one.
  const good = { attribution: attr(7000, 14000, 300), creative: cre(26, 6, 4) };
  check('a real improvement still separates from the spike',
    momentum(good, up).score < m.score, true);
}

console.log('\n── nothing to compare ──');
{
  const m = momentum({ attribution: {}, creative: {} }, { attribution: {}, creative: {} });
  check('no components at all -> no score', m.score, null);
  check('no label either', m.label, null);
  check('coverage is zero', m.coverage, 0);
  check('and it names the absence rather than reporting flat',
    /missing data, not flat performance/.test(m.reason), true);
  check('no crash on empty input', typeof momentum(), 'object');
}

console.log('\n── the score is inspectable ──');
{
  const m = momentum(now, up);
  check('every component carries its weight', m.parts.every((p) => typeof p.weight === 'number'), true);
  check('weights sum to one', Math.abs(Object.values(WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-9, true);
  check('drivers name the biggest movers', m.drivers.length, 3);
  check('it is versioned, so it stays comparable to itself', m.version, MOMENTUM_VERSION);
  check('both raw values travel with each component',
    m.parts.filter((p) => p.available).every((p) => p.current != null && p.prior != null), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
