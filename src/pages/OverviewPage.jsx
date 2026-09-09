// Overview — performance and action in one concise workspace.
//
// ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
// The same creative recommendation appeared THREE times on one screen: as a
// large editorial panel, again in that panel's evidence column, and again as a
// row in the action queue below. A queue that repeats the headline is not a
// queue; it is the headline with extra steps.
//
// Reading order now: title and report toolbar, metric summary, ONE priority
// strip, the performance chart, then the operational table. The full
// recommendation — evidence, guardrails, suppressed alternatives — moves into a
// drawer, with its meaning and its wording unchanged.
import { useEffect, useState } from 'react';
import { useOutletContext, Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listRecommendations, persistRecommendation, shopSpendDaily, listCampaigns,
  money, pct, fixed, numOrNull,
} from '../lib/api.js';
import { useFacts } from '../lib/facts.js';
import { scopedTo } from '../lib/scope.js';
import ReportToolbar from '../components/ReportToolbar.jsx';
import PerformanceChart from '../components/PerformanceChart.jsx';
import { PriorityStrip, RecommendationDrawer } from '../components/Decisions.jsx';
import {
  Panel, PageHeader, MetricSummary, Notice, Skeleton, EmptyState, SourceTag,
} from '../components/ui.jsx';

export default function OverviewPage() {
  const { shop, scope } = useOutletContext();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const cur = shop.currency || 'USD';
  const [drawer, setDrawer] = useState(false);

  const { facts, decision, coreLoading, error } = useFacts(shop, scope);

  const recsQ = useQuery({
    queryKey: ['recs', shop.id],
    queryFn: () => listRecommendations(shop.id, { status: ['proposed', 'planned', 'applied'] }),
  });
  const campaignsQ = useQuery({ queryKey: ['camps', shop.id], queryFn: () => listCampaigns(shop.id) });
  const spendQ = useQuery({
    queryKey: ['spendd', shop.id, scope.start, scope.end],
    queryFn: () => shopSpendDaily(shop.id, scope.start, scope.end),
  });

  useEffect(() => {
    if (!decision?.primary) return;
    persistRecommendation(shop.id, decision.primary, {
      scopeType: 'shop', scopeLabel: shop.shop_name,
      start: scope.start, end: scope.end,
      modelStart: scope.model.start, modelEnd: scope.model.end, objective: 'balanced',
    })
      .then(() => qc.invalidateQueries({ queryKey: ['recs', shop.id] }))
      .catch(() => { /* a failed write must not blank the page */ });
  }, [decision?.primary?.fingerprint, shop.id, scope.start, scope.end]);

  if (error) return <Notice tone="error">Could not load: {error.message}</Notice>;

  const a = facts.attribution;
  const r = facts.roas;
  const mg = facts.marginal;

  if (!coreLoading && (!a || !Number(a.days_covered))) {
    return (
      <>
        <PageHeader title="Overview" right={<ReportToolbar scope={scope} shop={shop} />} />
        <Panel>
          <EmptyState title={`No data stored for ${scope.start} → ${scope.end}`}>
            {shop.shop_name === 'Longevity'
              ? 'This shop has no TikTok seller ID mapped in Reacher, so no data can exist for it at any date. That is a setup task for an administrator — a different date range will not resolve it.'
              : 'Seller Center figures have not been collected for these dates. Pick a range that has been synced, or ask an administrator to run the context sync for this window.'}
          </EmptyState>
        </Panel>
      </>
    );
  }

  const stored = (recsQ.data || []).find((x) => x.fingerprint === decision?.primary?.fingerprint);
  const simulated = r?.is_simulated === true;

  // The metric region shares one source mode; a metric that differs carries its
  // own tag. Every value on this shop's spend side is simulated, and Shop GMV
  // is not, so that distinction is what the tags exist to make.
  const util = facts.dailyBudget && mg?.mean_daily_spend != null
    ? mg.mean_daily_spend / facts.dailyBudget : null;

  const metrics = [
    {
      label: 'Shop GMV', value: money(a?.total_gmv, cur), source: 'measured',
      context: `${Number(a?.orders || 0).toLocaleString()} orders · ${a?.days_covered || 0} days`,
      hint: `Total TikTok Shop GMV from Seller Center for ${scope.start} to ${scope.end}, in the shop's reporting timezone.`,
    },
    {
      label: 'Ad spend', value: r ? money(numOrNull(r.spend), cur) : '—',
      source: r ? (simulated ? 'simulated' : 'measured') : undefined,
      context: r ? `${r.days_with_spend} days with spend` : 'ad account not connected',
      hint: 'GMV Max spend. A dash means no spend data exists, which is different from spend being zero.',
    },
    {
      label: 'GMV Max ROI', value: r ? fixed(r.reported_roi) : '—',
      source: r ? (simulated ? 'simulated' : 'measured') : undefined,
      context: r ? `on ${money(r.reported_revenue, cur)} claimed` : 'no campaigns',
      hint: "GMV Max's own reported return: the revenue it attributes to itself, divided by spend. The ceiling of the band.",
    },
    {
      // PROTECTED WORDING — unchanged in meaning and certainty.
      label: 'Proven return', value: r ? fixed(r.verified_roas) : '—',
      source: r ? (simulated ? 'simulated' : 'measured') : undefined,
      context: r ? `${money(r.verified_paid_gmv, cur)} carries Shop Ads commission` : '—',
      hint: 'Revenue whose commission proves the ads drove it, divided by ALL spend. Every dollar in it is certainly ad-driven, so this is the floor of the band — the real return is between it and GMV Max’s own figure.',
    },
    {
      label: 'Budget utilisation', value: util == null ? '—' : pct(util, 0),
      context: facts.dailyBudget
        ? `${money(mg?.mean_daily_spend, cur)} of ${money(facts.dailyBudget, cur)}/day`
        : 'no budget on file',
      hint: 'Delivered daily spend as a share of the daily budget on enabled campaigns. A campaign well under its budget is not budget-constrained, so raising the budget will not raise delivery.',
    },
  ];

  // Only actions OTHER than the primary. The queue must not restate the strip.
  const others = (decision?.all || []).filter((x) => x.fingerprint !== decision?.primary?.fingerprint);

  return (
    <>
      <PageHeader
        title="Overview"
        sub={`${shop.shop_name} · ${scope.start} → ${scope.end}`}
        right={<ReportToolbar scope={scope} shop={shop} />}
      />

      <MetricSummary items={metrics} source="measured" loading={coreLoading} />

      {coreLoading
        ? <div className="panel" style={{ padding: 16 }}><Skeleton h={40} /></div>
        : (
          <PriorityStrip
            decision={decision} shop={shop} stored={stored}
            othersCount={others.length}
            onEvidence={() => setDrawer(true)}
          />
        )}

      <PerformanceChart shop={shop} scope={scope} rows={spendQ.data} loading={spendQ.isLoading} cur={cur} />

      <CampaignTable campaigns={campaignsQ.data} loading={campaignsQ.isLoading} cur={cur} params={params} />

      <RecommendationDrawer
        open={drawer} onClose={() => setDrawer(false)}
        decision={decision} shop={shop} stored={stored} others={others} params={params}
        persist={() => persistRecommendation(shop.id, decision.primary, {
          scopeType: 'shop', scopeLabel: shop.shop_name,
          start: scope.start, end: scope.end,
          modelStart: scope.model.start, modelEnd: scope.model.end, objective: 'balanced',
        })}
      />
    </>
  );
}

/**
 * The operational table. Reuses the campaign columns rather than inventing a
 * second table shape for this page — and shows SETTINGS, because Reacher gives
 * no campaign-level revenue and repeating shop revenue on every row would
 * attribute the whole shop to each campaign.
 */
function CampaignTable({ campaigns, loading, cur, params }) {
  if (loading) return <div className="panel" style={{ padding: 16 }}><Skeleton h={160} /></div>;

  if (!campaigns?.length) {
    return (
      <Panel title="Campaigns">
        <EmptyState title="No GMV Max campaigns for this shop">
          Reacher reports this shop&rsquo;s ad account as disconnected, so no campaign, spend or
          settings data can arrive. Connecting it is done in TikTok Business Center.
        </EmptyState>
      </Panel>
    );
  }

  return (
    <Panel
      title="Campaigns"
      sub="Settings are campaign-specific. Revenue is not available per campaign, so it is not shown here."
      bodyPad={false}
      right={<Link className="btn btn-sm" to={scopedTo('/campaigns', params)}>All campaigns</Link>}
    >
      <div className="tablewrap">
        <table className="data">
          <thead>
            <tr>
              <th className="sticky-l">Campaign</th>
              <th>Status</th>
              <th>Type</th>
              <th className="num">Target ROI</th>
              <th className="num">Daily budget</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {campaigns.slice(0, 6).map((c) => (
              <tr key={c.campaign_id}>
                <td className="sticky-l">
                  <Link className="identity" to={scopedTo(`/campaigns/${encodeURIComponent(c.campaign_id)}`, params)}>
                    {c.campaign_name || c.campaign_id}
                  </Link>
                </td>
                <td>
                  <span className={`status status-${c.status === 'ENABLE' ? 'ok' : 'info'}`}>
                    {c.status === 'ENABLE' ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="muted">
                  {/^PRODUCT/.test(c.campaign_type || '') ? 'Product GMV Max' : (c.campaign_type || '—')}
                </td>
                <td className="num">{c.target_roas == null ? '—' : Number(c.target_roas).toFixed(2)}</td>
                <td className="num">{c.daily_budget == null ? '—' : money(c.daily_budget, c.currency || cur)}</td>
                <td className="num">
                  <Link className="btn btn-sm" to={scopedTo(`/campaigns/${encodeURIComponent(c.campaign_id)}`, params)}>
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
