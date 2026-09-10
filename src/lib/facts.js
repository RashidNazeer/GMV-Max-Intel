// ============================================================
// One place that gathers the evidence and runs the decision pipeline.
//
// Overview, campaign detail and the recommendation record all need the same
// facts. Assembling them three times is how three screens end up quoting three
// slightly different versions of the same number — which is exactly what
// happened with the conversion median.
//
// THE MODEL WINDOW IS NOT THE REPORT WINDOW. Selecting "Last 7 days" used to
// hand the spend-response model seven rows, and it then reported "keep
// collecting history" while months of usable days sat in the database. The
// report selector controls what is DISPLAYED; the model trains on the eligible
// history ending at the same cutoff, and both periods are shown.
// ============================================================
import { isActiveStatus } from './campaignStatus.js';
import { useQuery } from '@tanstack/react-query';
import {
  shopAttribution, shopCreativeHealth, shopTopVideos, shopProducts, shopProductStats,
  shopPaidRoas, shopSpendDaily, listCampaigns, detectedSettingChanges, settingsEvidenceFrom,
  shopSourceHealth,
} from './api.js';
import { fitSpendResponse, recoveryFor, TARGET } from './marginal.js';
import { decide } from './decide.js';
import { budgetAvailability } from './budget.js';

export function useFacts(shop, scope) {
  const id = shop?.id;
  const on = !!id;
  const key = [id, scope.start, scope.end];

  const attrQ = useQuery({ queryKey: ['attr', ...key], queryFn: () => shopAttribution(id, scope.start, scope.end), enabled: on });
  const creativeQ = useQuery({ queryKey: ['creative', ...key], queryFn: () => shopCreativeHealth(id, scope.start, scope.end), enabled: on });
  const statsQ = useQuery({ queryKey: ['pstats', ...key], queryFn: () => shopProductStats(id, scope.start, scope.end), enabled: on });
  const roasQ = useQuery({ queryKey: ['roas', ...key], queryFn: () => shopPaidRoas(id, scope.start, scope.end), enabled: on });
  const campaignsQ = useQuery({ queryKey: ['camps', id], queryFn: () => listCampaigns(id), enabled: on });
  const changesQ = useQuery({ queryKey: ['changes', id], queryFn: () => detectedSettingChanges(id), enabled: on });
  // The date before which no campaign setting can be established for this shop.
  // Needed to tell "the budget did not bind" apart from "no budget is on record
  // for the days analysed" — two answers that look identical in a ratio.
  const settingsFromQ = useQuery({ queryKey: ['setfrom', id], queryFn: () => settingsEvidenceFrom(id), enabled: on });
  // Per-source DATE completeness. The decision pipeline had no completeness
  // input at all, so a guardrail could pass on a window missing a day.
  const healthQ = useQuery({
    queryKey: ['srchealth', id, scope.start, scope.end],
    queryFn: () => shopSourceHealth(id, scope.start, scope.end),
    enabled: on,
  });

  const productsQ = useQuery({
    queryKey: ['prods', ...key],
    queryFn: () => shopProducts(id, scope.start, scope.end, { limit: 200 }),
    enabled: on,
  });

  // The exact declining set, so a finding can hand its ids to the drill-down
  // instead of the destination recomputing a similar-looking top-N.
  const decliningQ = useQuery({
    queryKey: ['declining', ...key],
    queryFn: () => shopTopVideos(id, scope.start, scope.end, { limit: 500, status: 'declining' }),
    enabled: on,
  });
  const fatigueQ = useQuery({
    queryKey: ['fatigue', ...key],
    queryFn: () => shopTopVideos(id, scope.start, scope.end, { limit: 500, status: 'fatigue_risk' }),
    enabled: on,
  });
  const videosQ = useQuery({
    queryKey: ['topvids', ...key],
    queryFn: () => shopTopVideos(id, scope.start, scope.end, { limit: 100 }),
    enabled: on,
  });

  // Trained on its own window, ending at the report cutoff so a historical
  // analysis cannot see days after the date it claims to look from.
  const modelQ = useQuery({
    queryKey: ['spendmodel', id, scope.model.start, scope.model.end],
    queryFn: () => shopSpendDaily(id, scope.model.start, scope.model.end),
    enabled: on,
  });

  // ── WHY THERE ARE TWO LOADING FLAGS ───────────────────────────────────────
  // Browser QA caught the decision card still rendering a skeleton five seconds
  // in, while the chart underneath it had already drawn. The most important
  // thing on the page was the slowest, because the decision waited on every
  // query in this hook — including a 200-row product fetch, a 100-row video
  // fetch and two 500-row id sweeps that the primary action does not need.
  //
  // coreLoading covers only what decide() actually reasons from. The id sets
  // and supporting rows arrive after and re-render in place, so a drill-down
  // count appears a moment later rather than holding the whole decision back.
  const coreLoading = attrQ.isLoading || creativeQ.isLoading || statsQ.isLoading
    || roasQ.isLoading || modelQ.isLoading;
  const loading = coreLoading || productsQ.isLoading || decliningQ.isLoading;
  const error = attrQ.error || creativeQ.error || statsQ.error;

  const campaigns = campaignsQ.data || [];
  const enabled = campaigns.filter((c) => isActiveStatus(c.status));
  const dailyBudget = enabled.reduce((a, c) => a + (Number(c.daily_budget) || 0), 0) || null;
  // Averaging Target ROI across campaigns would invent a setting no campaign
  // has. Only meaningful when they agree.
  const roiSet = new Set(enabled.map((c) => Number(c.target_roas)).filter(Number.isFinite));
  const targetRoi = roiSet.size === 1 ? [...roiSet][0] : null;

  // Why `dailyBudget` being null is not the same as no budget existing, and
  // which of the four states this shop is in — see src/lib/budget.js.
  const budget = budgetAvailability(campaigns);

  const spendRows = modelQ.data || [];

  // Fitted against THREE targets, all shown. The headline is total shop GMV —
  // the decision is about whether the shop grows, not about what the ad
  // platform attributes to itself.
  const fitFor = (pick, target) => fitSpendResponse(
    spendRows.map((d) => ({ spend: d.spend, revenue: pick(d) })),
    { target, dailyBudget, horizonDays: 7 },
  );

  const marginalShop = spendRows.length ? fitFor((d) => d.total_shop_gmv, TARGET.TOTAL_SHOP_GMV) : null;
  const marginalReported = spendRows.length ? fitFor((d) => d.reported_revenue, TARGET.REPORTED_REVENUE) : null;
  const marginalVerified = spendRows.length ? fitFor((d) => d.measured_paid_gmv, TARGET.VERIFIED_PAID_GMV) : null;

  const changes = changesQ.data || [];
  const daysSinceLastChange = changes.length
    ? Math.floor((Date.now() - Date.parse(changes[0].detected_at)) / 86400000)
    : null;

  const products = productsQ.data?.rows || [];
  const stats = statsQ.data;
  const minClicks = Number(stats?.median_min_clicks) || 500;
  const median = stats?.median_conversion == null ? null : Number(stats.median_conversion);
  const weakProductIds = median == null ? [] : products
    .filter((p) => p.click_to_order_rate != null
      && Number(p.clicks) >= minClicks
      && Number(p.click_to_order_rate) < median * 0.6)
    .map((p) => p.product_id);

  const facts = {
    shop,
    days: scope.days,
    start: scope.start,
    end: scope.end,
    modelWindow: scope.model,
    attribution: attrQ.data,
    creative: creativeQ.data,
    productStats: stats,
    products,
    videos: videosQ.data?.rows || [],
    roas: roasQ.data,
    campaigns,
    dailyBudget,
    // Structured budget availability. `dailyBudget` above is kept as-is (it is
    // the ACTIVE budget and several callers depend on that meaning); this says
    // why it is null when it is null. See the derivation above.
    budget,
    targetRoi,
    daysSinceLastChange,
    // Whether ANY setting record covers the days being analysed. Snapshots began
    // 2026-09-08 and Reacher exposes no endpoint that returns past settings, so
    // for a report ending before that there is no budget on file for the window
    // — and "spend was 60% of budget" is then a statement about today's budget,
    // not about what constrained delivery on those days.
    sourceHealth: healthQ.data ?? null,
    settingsFrom: settingsFromQ.data ?? null,
    settingsCoverWindow: settingsFromQ.data
      ? String(settingsFromQ.data).slice(0, 10) <= scope.start
      : false,
    marginal: marginalShop,
    marginalReported,
    marginalVerified,
    marginalRecovery: marginalShop ? recoveryFor(marginalShop) : null,
    // THE COUNT AND THE ID SET MUST BE THE SAME POPULATION.
    //
    // shop_creative_health counts declining_videos as status IN ('declining',
    // 'fatigue_risk') — fatigue risk IS a decline, with the extra evidence that
    // the video was earning well beforehand. Fetching only status='declining'
    // gave a finding that said "25 videos" and handed 19 ids to the drill-down,
    // so the buyer would land on a list that did not match the number they
    // clicked. Caught by running the pipeline against live data.
    decliningIds: [
      ...(decliningQ.data?.rows || []).map((v) => v.video_id),
      ...(fatigueQ.data?.rows || []).map((v) => v.video_id),
    ],
    fatigueIds: (fatigueQ.data?.rows || []).map((v) => v.video_id),
    weakProductIds,
    spendRows,
  };

  const decision = coreLoading ? null : decide(facts);

  return { facts, decision, loading, coreLoading, error, queries: { attrQ, creativeQ, statsQ, roasQ, productsQ, modelQ } };
}
