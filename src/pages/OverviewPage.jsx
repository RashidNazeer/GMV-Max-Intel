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
  shopAttribution, shopPaidRoas,
  money, pct, fixed, numOrNull,
} from '../lib/api.js';
import { useFacts } from '../lib/facts.js';
import { scopedTo } from '../lib/scope.js';
import ReportToolbar from '../components/ReportToolbar.jsx';
import PerformanceChart from '../components/PerformanceChart.jsx';
import { PriorityStrip, RecommendationDrawer } from '../components/Decisions.jsx';
import {
  Panel, PageHeader, MetricSummary, Notice, Skeleton, EmptyState, SourceTag, Hint, Delta,
} from '../components/ui.jsx';

export default function OverviewPage() {
  const { shop, scope } = useOutletContext();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const cur = shop.currency || 'USD';
  const [drawer, setDrawer] = useState(false);
  // Whether the decision could be SAVED. Shown, never swallowed — see the catch below.
  const [persistError, setPersistError] = useState(null);

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

  // THE PRIOR PERIOD. Adjacent, equal length, no overlap — the same pair the
  // Organic momentum score already compares against, so the two pages cannot
  // disagree about what "previous period" means. These keys deliberately match
  // the shapes useFacts registers, so switching the report length reuses the
  // cache rather than refetching what the app already holds.
  const priorAttrQ = useQuery({
    queryKey: ['attr', shop.id, scope.priorStart, scope.priorEnd],
    queryFn: () => shopAttribution(shop.id, scope.priorStart, scope.priorEnd),
  });
  const priorRoasQ = useQuery({
    queryKey: ['roas', shop.id, scope.priorStart, scope.priorEnd],
    queryFn: () => shopPaidRoas(shop.id, scope.priorStart, scope.priorEnd),
  });

  useEffect(() => {
    if (!decision?.primary) return;
    persistRecommendation(shop.id, decision.primary, {
      scopeType: 'shop', scopeLabel: shop.shop_name,
      start: scope.start, end: scope.end,
      modelStart: scope.model.start, modelEnd: scope.model.end, objective: 'balanced',
    })
      .then(() => { setPersistError(null); qc.invalidateQueries({ queryKey: ['recs', shop.id] }); })
      // A SILENT CATCH IS HOW A MISSING RLS POLICY REACHED PRODUCTION.
      //
      // This swallowed every failure so a failed write could not blank the
      // page — a reasonable instinct that hid a total feature outage. There
      // was no INSERT policy on `recommendations`, every call was refused
      // 42501, and the table held zero rows while the drawer offered Mark
      // planned and Mark applied as though they would stick.
      //
      // The page still must not blank, so the error goes to a notice rather
      // than to nowhere: the decision is unsaveable and the operator is told
      // instead of discovering it when their record is missing tomorrow.
      .catch((e) => setPersistError(e?.message || String(e)));
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

  // ── COMPARISON DELTAS ─────────────────────────────────────────────────────
  // Every headline number now says which way it moved against the adjacent
  // equal-length period. The guard matters more than the arithmetic: a prior
  // window that was collected for FEWER DAYS than this one produces a total
  // that is smaller for a reason that has nothing to do with the shop, and a
  // delta computed from it would read as a decline. Where coverage is short,
  // the shortfall is named and no percentage is printed.
  const pa = priorAttrQ.data;
  const pr = priorRoasQ.data;
  const comparing = priorAttrQ.isLoading || priorRoasQ.isLoading;

  // ── ONE GUARD PER SOURCE. The first version had one, and it was the wrong
  // one for three of the four metrics.
  //
  // `days_covered` comes from shop_attribution (Seller Center GMV days, via
  // shop_channel_daily). `days_with_spend` comes from shop_paid_roas
  // (gmv_max_daily_metrics). Different tables, filled by different sync jobs,
  // and they drift: on 2026-09-07 the shop channels had all seven days while
  // GMV Max stopped at 09-05. Both windows read days_covered = 7, so the single
  // guard never fired — and the strip printed "Ad spend ▼ -23%" comparing FIVE
  // days of spend against SEVEN. Per active day, spend was $253/day against
  // $235/day: it had gone UP about 8%. A confident arrow pointing the wrong way
  // is worse than no arrow, and it was rendering perfectly.
  const cover = (nowN, priorN) => {
    const n = Number(nowN);
    const p = Number(priorN);
    if (comparing || !Number.isFinite(n) || !Number.isFinite(p)) return { ok: true };
    if (p === 0) return { ok: false, note: `nothing stored for ${scope.priorStart} → ${scope.priorEnd}` };
    // SYMMETRIC. The original tripped only when the PRIOR window was short, but
    // the common case is the CURRENT window short — recent days settle last —
    // and that produces exactly the same false decline.
    if (n !== p) return { ok: false, note: `${n} vs ${p} days of data — not comparable` };
    return { ok: true };
  };

  const attrCover = cover(a?.days_covered, pa?.days_covered);          // Shop GMV
  const spendCover = cover(r?.days_with_spend, pr?.days_with_spend);   // everything from shop_paid_roas

  // MM-DD, not the full ISO pair. A metric card is about 250px wide at 1440 and
  // "vs 2026-08-05 → 2026-08-11" wraps to a second line inside every one of
  // them, pushing the priority strip out of the first screenful. The year is
  // already on the page header and the full dates are in each metric's hint.
  const priorLabel = `vs ${scope.priorStart.slice(5)} → ${scope.priorEnd.slice(5)}`;
  const delta = (cov, current, prior, dir) => (cov.ok ? (
    <Delta current={current} prior={prior} dir={dir} loading={comparing} label={priorLabel} />
  ) : <span className="delta delta-none">{cov.note}</span>);

  const metrics = [
    {
      label: 'Shop GMV', value: money(a?.total_gmv, cur), source: 'measured',
      delta: delta(attrCover, a?.total_gmv, pa?.total_gmv, 'up-good'),
      context: `${Number(a?.orders || 0).toLocaleString()} orders · ${a?.days_covered || 0} days`,
      hint: `Total TikTok Shop GMV from Seller Center for ${scope.start} to ${scope.end}, in the shop's reporting timezone. `
        + `The change is measured against ${scope.priorStart} → ${scope.priorEnd} — adjacent, equal length, no overlap.`,
    },
    {
      label: 'Ad spend', value: r ? money(numOrNull(r.spend), cur) : '—',
      source: r ? (simulated ? 'simulated' : 'measured') : undefined,
      // 'neutral': spending more is neither good nor bad on its own, and
      // colouring it would be a recommendation this strip does not make.
      delta: r ? delta(spendCover, r.spend, pr?.spend, 'neutral') : null,
      context: r ? `${r.days_with_spend} days with spend` : 'ad account not connected',
      hint: 'GMV Max spend. A dash means no spend data exists, which is different from spend being zero. The change is not coloured — more spend is not itself better or worse.',
    },
    {
      label: 'GMV Max ROI', value: r ? fixed(r.reported_roi) : '—',
      source: r ? (simulated ? 'simulated' : 'measured') : undefined,
      delta: r ? delta(spendCover, r.reported_roi, pr?.reported_roi, 'up-good') : null,
      context: r ? `on ${money(r.reported_revenue, cur)} claimed` : 'no campaigns',
      hint: "GMV Max's own reported return: the revenue it attributes to itself, divided by spend. The ceiling of the band.",
    },
    {
      // PROTECTED WORDING — unchanged in meaning and certainty.
      label: 'Proven return', value: r ? fixed(r.verified_roas) : '—',
      source: r ? (simulated ? 'simulated' : 'measured') : undefined,
      delta: r ? delta(spendCover, r.verified_roas, pr?.verified_roas, 'up-good') : null,
      context: r ? `${money(r.verified_paid_gmv, cur)} carries Shop Ads commission` : '—',
      hint: 'Revenue whose commission proves the ads drove it, divided by ALL spend. Every dollar in it is certainly ad-driven, so this is the floor of the band — the real return is between it and GMV Max’s own figure.',
    },
    // THIS RATIO MIXES TWO PERIODS, AND NOW SAYS SO.
    //
    // The numerator is the spend model's mean daily spend — an average over the
    // days it actually observed inside its training window, which is longer than
    // the report and ends at the same cutoff. The denominator is the daily
    // budget set on enabled campaigns RIGHT NOW. Neither figure is the selected
    // report, so labelling this "delivered spend against budget" implied a
    // recency the numerator does not have. It is a training-period proxy, and a
    // reader deciding whether to raise a budget needs to know that before they
    // act on it. Same baseline the campaign scenario table calls Model baseline.
    {
      label: 'Budget utilisation', value: util == null ? '—' : pct(util, 0),
      // Deliberately NO period delta. Every other metric on this strip is a
      // report-window measurement with a prior-window twin; this one is not,
      // and inventing a comparison for it would hide exactly the mismatch the
      // context line is there to disclose.
      delta: <span className="delta delta-none">model baseline — not a report-window figure</span>,
      context: !facts.dailyBudget
        ? 'no budget on file'
        : `${money(mg?.mean_daily_spend, cur)}/day over ${mg?.days ?? '—'} observed days`
          + ` vs ${money(facts.dailyBudget, cur)}/day set now`,
      hint: 'A share, not a measurement of this report. The numerator is the model baseline — mean daily spend across the '
        + `${mg?.days ?? 'observed'} days the spend model actually saw between ${scope.model.start} and ${scope.model.end}`
        + ` — and the denominator is the daily budget currently set on enabled campaigns. It is the same baseline the campaign`
        + ' scenario table labels Model baseline, deliberately, so the two agree. A campaign well under its budget is not'
        + ' budget-constrained, so raising the budget will not raise delivery.',
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

      {persistError && (
        <Notice tone="warn">
          <p>
            <strong>This recommendation could not be saved.</strong> You can still read it, but it cannot
            be planned, recorded or reviewed later, and it will not appear in History. The analysis on
            this page is unaffected — only the record of it failed.
          </p>
          <p className="meta" style={{ margin: '6px 0 0' }}><code>{persistError}</code></p>
        </Notice>
      )}

      {/* THE COVERAGE BANNER LIVES ON DATA STATUS NOW.
          A notice that appears every day about a condition the buyer cannot act
          on is a notice people learn to scroll past — and then they scroll past
          the one that matters. Owner decision, 2026-09-10: main screens stay
          clean; Data status carries every gap at any size, and the sidebar link
          still marks itself when something is wrong.

          What did NOT move: the guardrails. A recommendation whose evidence is
          incomplete is still blocked, still says so in its drawer, and still
          refuses to claim a check passed that never ran. Hiding the banner is a
          presentation choice; it must never become a silent decision. */}

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
      bodyPad={false}
      right={<><Hint text="Settings are campaign-specific. Revenue is not available per campaign, so it is not shown here." /><Link className="btn btn-sm" to={scopedTo('/campaigns', params)}>All campaigns</Link></>}
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
