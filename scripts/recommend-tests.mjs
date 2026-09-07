// Unit tests for the decision layer. No framework, same plain-node style as
// the classifier tests, so this ports into WurxOS without a harness.
//   node scripts/recommend-tests.mjs
//
// The rules decide what a person is told to do with real money, so the tests
// lean hardest on the cases where a rule should stay SILENT. A rule that fires
// on thin evidence is worse than one that never fires: it spends someone's
// afternoon, or their budget, on a number that was never there.
import { recommend, buildRecommendations, whatsWorking, SEVERITY, BASIS } from '../src/lib/recommend.js';

let pass = 0; const failures = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`); }
}
const ids = (f) => recommend(f).map((r) => r.id);
const has = (f, id) => ids(f).includes(id);
const get = (f, id) => recommend(f).find((r) => r.id === id);

const shop = { shop_name: 'Test', currency: 'USD', affiliate_connected: true };
const base = {
  shop, days: 30,
  attribution: {
    total_gmv: 100000, attribution_coverage: 0.8, affiliate_capture: 1,
    affiliate_video_sc_gmv: 80000, affiliate_video_ours_gmv: 80000,
    affiliate_unmeasured_gmv: 0, measured_paid_gmv: 30000, measured_organic_gmv: 50000,
    seller_video_gmv: 10000, live_gmv: 2000, product_card_gmv: 8000,
  },
  creative: {
    video_count: 100, gmv: 80000, top1_share: 0.05, top5_share: 0.18, top10_share: 0.3,
    fatigued_videos: 2, fatigued_gmv: 1000, rising_videos: 5, rising_gmv: 4000,
    trend_measurable: true,
  },
  videos: [], products: [], roas: null,
};

console.log('\n── a healthy shop produces no alarms ──');
check('healthy shop -> all-clear only', ids(base), ['all-clear']);
check('all-clear is severity good', get(base, 'all-clear').severity, SEVERITY.GOOD);

console.log('\n── concentration ──');
{
  const f = { ...base, creative: { ...base.creative, top1_share: 0.22, top5_share: 0.55, top10_share: 0.7 } };
  check('top-5 over half -> critical', get(f, 'creative-concentration').severity, SEVERITY.CRITICAL);
  check('at_stake is the top video, not the whole shop', get(f, 'creative-concentration').at_stake, 80000 * 0.22);

  const mild = { ...base, creative: { ...base.creative, top5_share: 0.4, top1_share: 0.12 } };
  check('moderate concentration -> warning', get(mild, 'creative-concentration').severity, SEVERITY.WARNING);

  // The refusal that matters: 6 videos at 90% is arithmetic, not fragility.
  const tiny = { ...base, creative: { ...base.creative, video_count: 6, top5_share: 0.9, top1_share: 0.4 } };
  check('under 10 videos -> SILENT (sample, not risk)', has(tiny, 'creative-concentration'), false);

  const noGmv = { ...base, creative: { ...base.creative, gmv: 0, top5_share: 0.9 } };
  check('no revenue -> SILENT', has(noGmv, 'creative-concentration'), false);
}

console.log('\n── fatigue ──');
{
  const f = { ...base, creative: { ...base.creative, fatigued_videos: 9, fatigued_gmv: 32000 } };
  check('40% of revenue fading -> warning', get(f, 'creative-fatigue').severity, SEVERITY.WARNING);

  // A 7-day window has no comparable prior week; the SQL returns
  // trend_measurable=false and the rule must not invent a trend.
  const short = { ...base, days: 7, creative: { ...base.creative, trend_measurable: false, fatigued_videos: 9, fatigued_gmv: 32000 } };
  check('window too short to measure a trend -> SILENT', has(short, 'creative-fatigue'), false);

  const low = { ...base, creative: { ...base.creative, fatigued_videos: 1, fatigued_gmv: 500 } };
  check('below threshold -> SILENT', has(low, 'creative-fatigue'), false);
}

console.log('\n── affiliate capture (data integrity) ──');
{
  const f = {
    ...base,
    shop: { ...shop, affiliate_connected: false },
    attribution: { ...base.attribution, affiliate_capture: 0.766, affiliate_video_ours_gmv: 62697, affiliate_unmeasured_gmv: 19111 },
  };
  const r = get(f, 'affiliate-capture');
  check('capture under 85% -> critical', r.severity, SEVERITY.CRITICAL);
  check('does NOT blame the integration flag — it proved unreliable',
    /DISCONNECTED/.test(r.finding), false);
  check('says the gap is inside Reacher', /inside Reacher/.test(r.action), true);
  check('rules out settling lag in the evidence',
    r.evidence.some((e) => /settling lag/.test(e)), true);
  check('capture outranks everything else', ids(f)[0], 'affiliate-capture');

  const ok = { ...base, attribution: { ...base.attribution, affiliate_capture: 0.97 } };
  check('capture at 97% -> SILENT', has(ok, 'affiliate-capture'), false);

  const unknown = { ...base, attribution: { ...base.attribution, affiliate_capture: null } };
  check('capture unknown -> SILENT, not assumed bad', has(unknown, 'affiliate-capture'), false);
}

console.log('\n── the unverified revenue band ──');
{
  // Floor and ceiling, not "true vs false". 20,600 of 55,000 claimed is
  // verified; the other 62% could be either unmeasurable paid revenue or
  // over-attribution, and the rule must not claim to know which.
  const roas = {
    data_source: 'reacher', is_simulated: false, spend: 20000, days_with_spend: 30,
    reported_revenue: 55000, reported_roi: 2.75,
    verified_paid_gmv: 20600, verified_roas: 1.03,
    unverified_revenue: 34400, unverified_share: 0.6255,
    affiliate_surface_roas: 2.2,
  };
  const f = { ...base, roas };
  const r = get(f, 'unverified-revenue-band');
  check('a wide band -> critical', r.severity, SEVERITY.CRITICAL);
  check('measured spend -> measured basis', r.basis, BASIS.MEASURED);
  check('quotes both ends of the band', /1\.03/.test(r.action) && /2\.75/.test(r.action), true);
  check('does NOT claim the gap is all over-attribution', /either|or organic/.test(r.finding), true);
  check('at_stake is the unverified revenue, not the spend', r.at_stake, 34400);

  const mid = { ...base, roas: { ...roas, unverified_share: 0.3 } };
  check('a moderate band -> warning', get(mid, 'unverified-revenue-band').severity, SEVERITY.WARNING);

  // The rule that keeps the demo honest.
  const sim = { ...base, roas: { ...roas, data_source: 'simulated', is_simulated: true } };
  const s = get(sim, 'unverified-revenue-band');
  check('simulated spend -> simulated basis', s.basis, BASIS.SIMULATED);
  check('simulated never escalates to critical', s.severity, SEVERITY.INFO);

  const narrow = { ...base, roas: { ...roas, unverified_share: 0.08 } };
  check('a narrow band is not a finding -> SILENT', has(narrow, 'unverified-revenue-band'), false);

  const noSpend = { ...base, roas: { ...roas, spend: 0 } };
  check('zero spend -> SILENT (no ratio exists)', has(noSpend, 'unverified-revenue-band'), false);

  const noFloor = { ...base, roas: { ...roas, verified_roas: null } };
  check('no verified floor -> SILENT', has(noFloor, 'unverified-revenue-band'), false);

  check('no roas row at all -> SILENT', has(base, 'unverified-revenue-band'), false);
}

console.log('\n── attribution blind spot ──');
{
  const f = { ...base, attribution: { ...base.attribution, attribution_coverage: 0.288, product_card_gmv: 74505, seller_video_gmv: 58840 } };
  const r = get(f, 'attribution-blind-spot');
  check('29% coverage -> fires', !!r, true);
  check('names the largest dark channel', /product card/.test(r.finding), true);
  check('80% coverage -> SILENT', has(base, 'attribution-blind-spot'), false);
}

console.log('\n── ad-dependent creators ──');
{
  const v = (h, paid, organic) => ({ creator_handle: h, paid_gmv: paid, organic_gmv: organic });
  const f = {
    ...base,
    videos: [v('a', 9500, 200), v('b', 400, 3000), v('c', 300, 2500), v('d', 200, 1800), v('e', 100, 1500)],
  };
  const r = get(f, 'ad-dependent-creators');
  check('a 98%-paid creator above the size floor -> fires', !!r, true);
  check('only the dependent creator is named', /@a/.test(r.evidence.join(' ')) && !/@b/.test(r.evidence.join(' ')), true);

  // Small but 100% paid: real, and not worth anyone's attention.
  const small = { ...base, videos: [v('a', 50, 0), v('b', 5000, 5000), v('c', 5000, 5000), v('d', 1000, 900), v('e', 900, 800)] };
  check('tiny ad-dependent creator -> SILENT (below 3% of revenue)', has(small, 'ad-dependent-creators'), false);

  check('too few videos -> SILENT', has({ ...base, videos: [v('a', 100, 0)] }, 'ad-dependent-creators'), false);
}

console.log('\n── conversion drag ──');
{
  const p = (id, ctor, clicks, imp = 200000) => ({
    product_id: id, title: id, click_to_order_rate: ctor, clicks, impressions: imp, aov: 30, gmv: 5000, refund_rate: 0.01,
  });
  const f = { ...base, products: [p('good1', 0.03, 20000), p('good2', 0.028, 18000), p('good3', 0.032, 15000), p('bad', 0.008, 12000)] };
  const r = get(f, 'conversion-drag');
  check('a product well under the median -> warning', r.severity, SEVERITY.WARNING);
  check('names the worst offender', /bad/.test(r.finding), true);

  const lowTraffic = { ...base, products: [p('good1', 0.03, 20000), p('good2', 0.028, 18000), p('good3', 0.032, 15000), p('bad', 0.008, 900)] };
  check('poor rate on thin clicks -> SILENT', has(lowTraffic, 'conversion-drag'), false);

  check('too few products to have a median -> SILENT',
    has({ ...base, products: [p('a', 0.001, 90000)] }, 'conversion-drag'), false);
}

console.log('\n── refunds ──');
{
  const p = (id, rate, gmv) => ({ product_id: id, title: id, refund_rate: rate, refunds: gmv * rate, gmv });
  const f = { ...base, products: [p('a', 0.12, 20000), p('b', 0.02, 30000), p('c', 0.01, 10000)] };
  check('a 12% refunder -> warning', get(f, 'refund-drag').severity, SEVERITY.WARNING);

  const smallOne = { ...base, products: [p('a', 0.2, 400), p('b', 0.02, 30000), p('c', 0.01, 10000)] };
  check('high rate on a tiny product -> SILENT', has(smallOne, 'refund-drag'), false);
}

console.log('\n── ordering and robustness ──');
{
  const f = {
    ...base,
    attribution: { ...base.attribution, affiliate_capture: 0.7, affiliate_unmeasured_gmv: 24000 },
    creative: { ...base.creative, top1_share: 0.2, top5_share: 0.6, fatigued_videos: 9, fatigued_gmv: 30000 },
  };
  const order = ids(f);
  check('critical findings come before warnings',
    order.indexOf('affiliate-capture') < order.indexOf('creative-fatigue'), true);
  check('the all-clear disappears once anything real fires', order.includes('all-clear'), false);
}
{
  check('no facts at all -> no recommendations, no crash', recommend({}).length, 0);
  check('null attribution -> no crash', recommend({ shop, creative: null, attribution: null }).length, 0);
  // A rule that throws must not take the page down with it.
  const poison = { ...base, products: null, videos: null };
  check('null collections -> still returns the all-clear', ids(poison), ['all-clear']);
}
{
  const all = buildRecommendations(base);
  check('buildRecommendations exposes the fallback; recommend() filters it',
    [all.some((r) => r._fallback), recommend(base).length], [true, 1]);
}

console.log('\n── what is working (strengths) ──');
{
  const wIds = (f) => whatsWorking(f).map((r) => r.id);
  const wHas = (f, id) => wIds(f).includes(id);
  const wGet = (f, id) => whatsWorking(f).find((r) => r.id === id);

  // base has organic 50000 of 80000 measured = 62.5%, capture 1.0
  check('strong organic share -> fires', wHas(base, 'organic-strength'), true);
  check('strengths are severity good', wGet(base, 'organic-strength').severity, SEVERITY.GOOD);
  check('complete evidence is itself reported', wHas(base, 'evidence-quality'), true);

  const adHeavy = {
    ...base,
    attribution: { ...base.attribution, measured_paid_gmv: 60000, measured_organic_gmv: 20000 },
  };
  check('mostly-paid shop -> no organic strength', wHas(adHeavy, 'organic-strength'), false);

  const shortCapture = { ...base, attribution: { ...base.attribution, affiliate_capture: 0.76 } };
  check('incomplete evidence -> no evidence-quality claim', wHas(shortCapture, 'evidence-quality'), false);

  // Momentum needs a measurable trend AND enough rising videos.
  check('5 rising videos -> momentum fires', wHas(base, 'creative-momentum'), true);
  const twoRising = { ...base, creative: { ...base.creative, rising_videos: 2 } };
  check('only 2 rising -> SILENT', wHas(twoRising, 'creative-momentum'), false);
  const noTrend = { ...base, creative: { ...base.creative, trend_measurable: false } };
  check('window too short for a trend -> SILENT', wHas(noTrend, 'creative-momentum'), false);

  // Organic creators: the mirror image of the ad-dependence warning.
  const v = (h, paid, organic) => ({ creator_handle: h, paid_gmv: paid, organic_gmv: organic });
  const withOrganic = {
    ...base,
    videos: [v('a', 100, 9000), v('b', 3000, 3000), v('c', 2500, 2500), v('d', 1000, 900), v('e', 800, 700)],
  };
  const oc = wGet(withOrganic, 'organic-creators');
  check('a creator selling organically at scale -> fires', !!oc, true);
  check('names that creator', /@a/.test(oc.evidence.join(' ')), true);

  const tinyOrganic = { ...base, videos: [v('a', 0, 20), v('b', 5000, 5000), v('c', 5000, 5000), v('d', 900, 800), v('e', 900, 800)] };
  check('tiny organic creator -> SILENT (under 3% of revenue)', wHas(tinyOrganic, 'organic-creators'), false);

  // Strong converters mirror the conversion-drag warning.
  const p = (id, ctor, gmv = 5000) => ({
    product_id: id, title: id, click_to_order_rate: ctor, clicks: 20000, impressions: 200000, gmv, refunds: 50, refund_rate: 0.01,
  });
  const conv = { ...base, products: [p('lo', 0.01), p('mid', 0.02), p('hi', 0.05, 9000)] };
  const sc = wGet(conv, 'strong-converters');
  check('a product well above median -> fires', !!sc, true);
  check('names the best converter', /hi/.test(sc.finding), true);

  const flat = { ...base, products: [p('a', 0.02), p('b', 0.021), p('c', 0.019)] };
  check('no standout converter -> SILENT', wHas(flat, 'strong-converters'), false);
  check('too few products -> SILENT', wHas({ ...base, products: [p('a', 0.05)] }, 'strong-converters'), false);

  // Robustness, same contract as the problem rules.
  check('no facts -> no strengths, no crash', whatsWorking({}).length, 0);
  check('null collections -> no crash', whatsWorking({ ...base, videos: null, products: null }).length >= 1, true);

  // Strengths are ranked by value, not by rule order.
  const ranked = whatsWorking(base);
  check('strengths sorted by money at stake',
    ranked.every((r, i) => i === 0 || (ranked[i - 1].at_stake ?? 0) >= (r.at_stake ?? 0)), true);

  // A strength must never be reported as a problem, or the counts double up.
  check('strengths never appear in recommend()',
    recommend(base).some((r) => wIds(base).includes(r.id)), false);
}


console.log('\n── marginal return (layer 5) ──');
{
  const okFit = {
    status: 'ok', days: 29, total_spend: 9504, avg_roas: 1.46,
    elasticity: 1.05, marginal_roas: 1.54, marginal_roas_ci: [1.20, 1.88],
    r2: 0.80, spend_cv: 0.325, time_confounded: true, spend_time_correlation: -0.67,
    naive_elasticity: 0.89,
  };
  const f = { ...base, roas: { ...base.roas, is_simulated: false }, marginal: okFit };
  const r = get(f, 'marginal-return');
  check('an answerable fit produces a finding', !!r, true);
  check('a fitted curve is MODELLED, never measured', r.basis, BASIS.MODELLED);
  check('marginal >= 90% of average -> room to scale', /return about what current spend does/.test(r.title), true);
  check('the action names the marginal figure, not the average', /1\.54/.test(r.action), true);
  check('the confound is disclosed in the evidence',
    r.evidence.some((e) => /entangled/.test(e)), true);

  // Diminishing returns: the case that should stop someone scaling.
  const dim = { ...okFit, elasticity: 0.55, marginal_roas: 0.80, marginal_roas_ci: [0.6, 1.0], time_confounded: false };
  const d = get({ ...base, marginal: dim }, 'marginal-return');
  check('marginal well below average -> different headline', /less than the average/.test(d.title), true);
  check('warns that the average can look fine while the increment loses',
    /break-even/.test(d.action), true);
  check('no confound -> says so', d.evidence.some((e) => /not confounded/.test(e)), true);

  // Simulated spend must never dress a model up as measured.
  const sim = { ...base, roas: { is_simulated: true }, marginal: okFit };
  check('simulated spend -> simulated basis', get(sim, 'marginal-return').basis, BASIS.SIMULATED);
}

console.log('\n── marginal return: the refusals reach the user ──');
{
  const flat = {
    status: 'flat_spend', days: 30, total_spend: 9000, spend_cv: 0.04,
    reason: 'Spend barely varied — 4% variation against the 15% needed.',
  };
  const r = get({ ...base, marginal: flat }, 'marginal-return');
  check('a refusal still produces a finding', !!r, true);
  check('the refusal reason is shown verbatim', r.finding, flat.reason);
  check('and tells them how to make it answerable', /Vary the daily budget/.test(r.action), true);
  check('a refusal is never presented as a number', r.title.includes('Cannot yet say'), true);

  const thin = { status: 'too_few_days', days: 9, total_spend: 2000, spend_cv: 0.3, reason: 'Only 9 days with spend.' };
  check('too few days -> keep collecting', /Keep collecting/.test(get({ ...base, marginal: thin }, 'marginal-return').action), true);

  // No spend at all is not a refusal worth reporting — it is just absence.
  const none = { status: 'no_data', days: 0, total_spend: 0, reason: 'No days with both spend and revenue.' };
  check('no spend at all -> SILENT', has({ ...base, marginal: none }, 'marginal-return'), false);
  check('no marginal fact at all -> SILENT', has(base, 'marginal-return'), false);
}

console.log(`
${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log("FAILED: " + failures.join(", ")); process.exit(1); }
