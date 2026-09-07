// Unit tests for the decision layer. No framework, same plain-node style as
// the classifier tests, so this ports into WurxOS without a harness.
//   node scripts/recommend-tests.mjs
//
// The rules decide what a person is told to do with real money, so the tests
// lean hardest on the cases where a rule should stay SILENT. A rule that fires
// on thin evidence is worse than one that never fires: it spends someone's
// afternoon, or their budget, on a number that was never there.
import { recommend, buildRecommendations, SEVERITY, BASIS } from '../src/lib/recommend.js';

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
  check('names the disconnected integration', /DISCONNECTED/.test(r.finding), true);
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

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED: ' + failures.join(', ')); process.exit(1); }
