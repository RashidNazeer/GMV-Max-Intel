// Overview — a daily priority workspace, not a report.
//
// The old page opened with three stacked banners and six fully expanded
// findings, ran about 3,900 pixels at a 1363x936 viewport, and repeated the
// attribution explanation twice. Nothing on it was ranked and nothing was
// clickable through to the thing it was talking about.
//
// This one opens with ONE action, five metrics, and the queue.
import { useEffect } from 'react';
import { useOutletContext, Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listRecommendations, persistRecommendation, shopChannelDaily,
  money, pct, fixed, numOrNull,
} from '../lib/api.js';
import { useFacts } from '../lib/facts.js';
import { DecisionHeader, PriorityTable } from '../components/Decisions.jsx';
import { Card, Stat, Note, Skeleton, Empty, Basis, Hint } from '../components/ui.jsx';
import { scopedTo } from '../lib/scope.js';
import ChannelChart from '../components/ChannelChart.jsx';

export default function OverviewPage() {
  const { shop, scope } = useOutletContext();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const cur = shop.currency || 'USD';

  const { facts, decision, loading, coreLoading, error } = useFacts(shop, scope);

  const recsQ = useQuery({
    queryKey: ['recs', shop.id],
    queryFn: () => listRecommendations(shop.id, { status: ['proposed', 'planned', 'applied'] }),
  });

  // Persist the primary action so its lifecycle survives a refresh and reaches
  // another device. Idempotent by fingerprint — reaching the same conclusion
  // twice updates one row rather than queueing the same task again.
  useEffect(() => {
    if (!decision?.primary) return;
    persistRecommendation(shop.id, decision.primary, {
      scopeType: 'shop',
      scopeLabel: shop.shop_name,
      start: scope.start,
      end: scope.end,
      modelStart: scope.model.start,
      modelEnd: scope.model.end,
      objective: 'balanced',
    })
      .then(() => qc.invalidateQueries({ queryKey: ['recs', shop.id] }))
      .catch(() => { /* a failed write must not blank the page */ });
  }, [decision?.primary?.fingerprint, shop.id, scope.start, scope.end]);

  const dailyQ = useQuery({
    queryKey: ['chdaily', shop.id, scope.start, scope.end],
    queryFn: () => shopChannelDaily(shop.id, scope.start, scope.end),
  });

  if (error) return <Note tone="warn">Could not load: {error.message}</Note>;

  const a = facts.attribution;

  if (!loading && (!a || !Number(a.days_covered))) {
    return (
      <Empty title={`No shop data stored for ${scope.start} → ${scope.end}`}>
        {shop.shop_name === 'Longevity' ? (
          <>
            This shop has no TikTok seller ID mapped in Reacher, so no data can exist for it at any
            date. That is a <strong>setup task for an administrator</strong>, not something a
            different date range or another sync will fix.
          </>
        ) : (
          <>
            Seller Center figures have not been collected for these dates. Pick a range that has been
            synced, or ask an administrator to run the context sync for this window.
          </>
        )}
      </Empty>
    );
  }

  const stored = (recsQ.data || []).find((r) => r.fingerprint === decision?.primary?.fingerprint);

  return (
    <div className="grid" style={{ gap: 16 }}>
      {/* The decision renders as soon as ITS inputs are ready, not when every
          supporting query has finished. It was still a skeleton at five
          seconds while the chart below it had already drawn. */}
      {coreLoading
        ? <div className="card pad"><Skeleton h={140} /></div>
        : <DecisionHeader decision={decision} shop={shop} scope={scope} stored={stored} />}

      <SummaryRow facts={facts} cur={cur} loading={coreLoading} scope={scope} params={params} />

      {!coreLoading && <PriorityTable decision={decision} shop={shop} records={recsQ.data} />}

      <ChannelChart rows={dailyQ.data} loading={dailyQ.isLoading} cur={cur} />

      <p className="muted" style={{ fontSize: 12, margin: 0, lineHeight: 1.6 }}>
        Where the money came from, how much of it carries a commission signal, and the full
        paid/organic decomposition live on <Link className="lnk" to={scopedTo('/attribution', params)}>Attribution</Link>.
        Source coverage, sync state and reconciliation live on{' '}
        <Link className="lnk" to={scopedTo('/data', params)}>Data status</Link>.
      </p>
    </div>
  );
}

/**
 * Five metrics. Not thirty.
 *
 * "Show a maximum of five summary metrics by default" is the rule, and the
 * reason is that a strip of twelve numbers is read as none of them.
 */
function SummaryRow({ facts, cur, loading, scope, params }) {
  // Compact by construction: five short columns in ONE card rather than five
  // full-height cards. At 1366x768 the taller version pushed the action queue
  // out of the first screenful entirely — measured at 0 rows visible.
  if (loading) {
    return <div className="card pad statstrip">{[0, 1, 2, 3, 4].map((i) => (
      <div key={i}><Skeleton h={44} /></div>
    ))}</div>;
  }
  const a = facts.attribution;
  const r = facts.roas;
  const mg = facts.marginal;

  const spend = numOrNull(r?.spend);
  const util = facts.dailyBudget && mg?.mean_daily_spend != null
    ? mg.mean_daily_spend / facts.dailyBudget : null;

  return (
    <div className="card pad statstrip">
      <Stat k="Shop GMV" basis="measured" v={money(a?.total_gmv, cur)}
        sub={`${Number(a?.orders || 0).toLocaleString()} orders · ${a?.days_covered || 0} days`}
        hint={`Total TikTok Shop GMV from Seller Center for ${scope.start} to ${scope.end}, in the shop's reporting timezone.`} />

      <Stat k="Ad spend" basis={r ? (r.is_simulated ? 'simulated' : 'measured') : undefined}
        v={r ? money(spend, cur) : '—'}
        sub={r ? `${r.days_with_spend} days with spend` : 'ad account not connected'}
        hint="GMV Max spend. A dash means no spend data exists, which is different from spend being zero." />

      <Stat k="GMV Max ROI" basis={r ? (r.is_simulated ? 'simulated' : 'measured') : undefined}
        v={r ? fixed(r.reported_roi) : '—'}
        sub={r ? `on ${money(r.reported_revenue, cur)} claimed` : 'no campaigns'}
        hint="GMV Max's own reported return: the revenue it attributes to itself, divided by spend. The ceiling of the band." />

      {/* PROTECTED WORDING — the floor/ceiling framing and "Proven return" are
          kept exactly as they were. Only their placement changed. */}
      <Stat k="Proven return" tone="paid" basis={r ? (r.is_simulated ? 'simulated' : 'measured') : undefined}
        v={r ? fixed(r.verified_roas) : '—'}
        sub={r ? `${money(r.verified_paid_gmv, cur)} carries Shop Ads commission` : '—'}
        hint="Revenue whose commission proves the ads drove it, divided by ALL spend. Every dollar in it is certainly ad-driven, so this is the floor of the band — the real return is between it and GMV Max's own figure." />

      <Stat k="Budget utilisation"
        v={util == null ? '—' : pct(util, 0)}
        sub={facts.dailyBudget ? `${money(mg?.mean_daily_spend, cur)} of ${money(facts.dailyBudget, cur)}/day` : 'no budget on file'}
        tone={util != null && util >= 0.95 ? 'warning' : undefined}
        hint="Delivered daily spend as a share of the daily budget on enabled campaigns. A campaign well under its budget is not budget-constrained, so raising the budget will not raise delivery." />
    </div>
  );
}
