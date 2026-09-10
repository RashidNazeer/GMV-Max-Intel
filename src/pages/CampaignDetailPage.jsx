// Campaign detail — this campaign's settings, then shop-level results, then the
// analysis behind them.
//
// ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
// One five-across stat row mixed this CAMPAIGN's settings (status, Target ROI,
// daily budget) with SHOP-level returns, so a shop-wide figure read as though it
// belonged to this campaign — the very substitution the full-width paragraph
// above it existed to deny. Settings and results are separate regions now, and
// every shop-scoped number says "shop-level" on its own label rather than
// relying on a reader having read the paragraph.
//
// The large recommendation panel is gone from this page. It is the Overview's
// job; repeating it here made a second copy of the same finding on a second
// screen. The header carries ONE action, which opens the same evidence drawer.
import { isActiveStatus } from '../lib/campaignStatus.js';
import RoiHeadroom from '../components/RoiHeadroom.jsx';
import { useState } from 'react';
import { useParams, useOutletContext, useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Line, Bar, ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import {
  listCampaigns, listRecommendations, detectedSettingChanges, recommendationOutcome,
  persistRecommendation,
  money, moneyExact, pct, fixed, numOrNull,
} from '../lib/api.js';
import { useFacts } from '../lib/facts.js';
import { scopedTo } from '../lib/scope.js';
import { addDays } from '../lib/window.js';
import { RecommendationDrawer } from '../components/Decisions.jsx';
import ReportToolbar from '../components/ReportToolbar.jsx';
import {
  Panel, PageHeader, MetricSummary, Notice, Skeleton, EmptyState,
  SourceTag, Hint, Unavailable, Boundary,
} from '../components/ui.jsx';
import { isAnswerable, recoveryFor, TARGET_LABEL } from '../lib/marginal.js';
import { actionLabel } from '../lib/decide.js';

const TABS = [
  { id: 'performance', label: 'Performance' },
  { id: 'scenario', label: 'Scenario' },
  { id: 'headroom', label: 'Target ROI' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'history', label: 'History' },
];

export default function CampaignDetailPage() {
  const { campaignId } = useParams();
  const { shop, scope } = useOutletContext();
  const [params] = useSearchParams();
  const [tab, setTab] = useState('performance');
  const [drawer, setDrawer] = useState(false);
  const cur = shop.currency || 'USD';

  const campaignsQ = useQuery({ queryKey: ['camps', shop.id], queryFn: () => listCampaigns(shop.id) });
  const { facts, decision, loading } = useFacts(shop, scope);
  const recsQ = useQuery({
    queryKey: ['recs', shop.id],
    queryFn: () => listRecommendations(shop.id, { status: ['proposed', 'planned', 'applied'] }),
  });

  const campaign = (campaignsQ.data || []).find((c) => c.campaign_id === campaignId);

  const crumbs = (
    <>
      <Link to={scopedTo('/campaigns', params)}>Campaigns</Link>
      <span aria-hidden="true"> / </span>
      <span>{campaign?.campaign_name || campaignId}</span>
    </>
  );

  // Never a number, and never the word "undefined", while the facts are still
  // arriving: the frame stays, the values wait.
  if (campaignsQ.isLoading || loading) {
    return (
      <>
        <PageHeader title="Campaign" crumbs={crumbs} right={<ReportToolbar scope={scope} shop={shop} />} />
        <div className="panel" style={{ padding: 16 }}><Skeleton h={220} /></div>
      </>
    );
  }

  if (!campaign) {
    return (
      <>
        <PageHeader title="Campaign" crumbs={crumbs} right={<ReportToolbar scope={scope} shop={shop} />} />
        <Panel>
          <EmptyState
            title="That campaign is not in this shop"
            action={<Link className="btn" to={scopedTo('/campaigns', params)}>Back to campaigns</Link>}
          >
            The link may point at a campaign belonging to another shop, or one that no longer exists.
          </EmptyState>
        </Panel>
      </>
    );
  }

  const stored = (recsQ.data || []).find((r) => r.fingerprint === decision?.primary?.fingerprint);
  const simulated = campaign.data_source === 'simulated';
  const active = isActiveStatus(campaign.status);
  const r = facts.roas;
  // Two different flags, because they describe two different rows: this
  // campaign's settings record, and the shop's spend series. Stamping the
  // shop's returns with the campaign row's provenance would be a guess.
  const basis = r?.is_simulated === true ? 'simulated' : 'measured';

  // Shop scope, said on every label. Reacher gives spend per campaign but not
  // revenue per campaign, so these are the whole shop's returns and carrying
  // them under this campaign's name without saying so would be a claim.
  //
  // All three come from the SAME read, so the basis belongs to the region and
  // no value carries its own badge — tagging every metric with the same word is
  // the badge nobody reads. The region's basis is passed to MetricSummary; when
  // it is "simulated" the warn notice above states it once, in a sentence.
  const shopMetrics = [
    {
      label: 'Ad spend (shop-level)',
      value: r ? money(numOrNull(r.spend), cur) : '—',
      context: r ? `all campaigns · ${r.days_with_spend} days with spend` : 'ad account not connected',
      hint: 'GMV Max spend across every campaign in this shop. A dash means no spend data exists, which is different from spend being zero.',
    },
    {
      label: 'GMV Max ROI (shop-level)',
      value: fixed(r?.reported_roi),
      context: r ? `all campaigns · on ${money(r.reported_revenue, cur)} claimed` : 'no campaigns',
      hint: "GMV Max's own reported return for the whole shop: the revenue it attributes to itself, divided by spend. The ceiling of the band.",
    },
    {
      // PROTECTED WORDING — unchanged in meaning and certainty.
      label: 'Proven return (shop-level)',
      value: fixed(r?.verified_roas),
      context: r ? `all campaigns · ${money(r.verified_paid_gmv, cur)} carries Shop Ads commission` : '—',
      hint: 'Revenue whose commission proves the ads drove it, divided by ALL spend. Every dollar in it is certainly ad-driven, so this is the floor of the band — the real return is between it and GMV Max’s own figure.',
    },
  ];

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title={
          <>
            {campaign.campaign_name || campaign.campaign_id}
            <span className={`status status-${active ? 'ok' : 'info'}`}
              style={{ marginLeft: 'var(--s3)', verticalAlign: 'middle' }}>
              {active ? 'Active' : 'Inactive'}
            </span>
          </>
        }
        sub={`${shop.shop_name} · ${scope.start} → ${scope.end}`}
        right={(
          <ReportToolbar scope={scope} shop={shop}>
            {decision?.primary && (
              <button className="btn" onClick={() => setDrawer(true)}>View recommendation</button>
            )}
          </ReportToolbar>
        )}
      />

      {(simulated || basis === 'simulated') && (
        <Notice tone="warn">
          Ad spend for this shop is simulated, so the campaign settings and every spend-derived figure on
          this page are a demonstration rather than a measurement. Revenue is measured from real orders.
        </Notice>
      )}

      <Panel
        title="Campaign settings"
        sub="Read from this campaign's own record. The performance figures below it are not — they are shop-level."
        right={simulated ? <SourceTag kind="simulated" /> : null}
      >
        {/* One row, wrapping. Four short facts do not need four rows — stacking
            them pushed the performance a buyer came for below the fold. */}
        <dl className="dl-inline">
          <div>
            <dt>Status</dt>
            <dd>
              <span className={`status status-${active ? 'ok' : 'info'}`}>{active ? 'Active' : 'Inactive'}</span>
            </dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd>
              {/^PRODUCT/.test(campaign.campaign_type || '')
                ? 'Product GMV Max'
                : campaign.campaign_type || <Unavailable reason="Reacher reports no campaign type for this campaign." />}
            </dd>
          </div>
          <div>
            <dt>
              Target ROI{' '}
              <Hint text="A delivery setting: how hard GMV Max bids. It is not the brand's break-even target." />
            </dt>
            <dd>
              {campaign.target_roas == null
                ? <Unavailable reason="No Target ROI is set on this campaign." />
                : Number(campaign.target_roas).toFixed(2)}
            </dd>
          </div>
          <div>
            <dt>Daily budget</dt>
            <dd>
              {campaign.daily_budget == null
                ? <Unavailable reason="No daily budget is set on this campaign." />
                : money(campaign.daily_budget, cur)}
            </dd>
          </div>
        </dl>
      </Panel>

      {/* A SCOPE LINE, with the explanation one click away.
          This was a full-width notice above the numbers on every visit. The
          limitation is real and permanent, but a paragraph re-read daily stops
          being read at all — the scope belongs beside the figures it qualifies,
          and the reasoning belongs behind a disclosure. */}
      <details className="meta" style={{ margin: '-4px 0 0' }}>
        <summary style={{ cursor: 'pointer' }}>
          Returns below are <strong>shop-level</strong>, across all campaigns — not this campaign alone.
        </summary>
        <p style={{ margin: '6px 0 0', maxWidth: '78ch' }}>
          Reacher exposes spend per campaign but not revenue per campaign, so a campaign-specific return
          cannot be computed today. Splitting shop revenue across campaigns by their share of spend would
          produce a number for every campaign and evidence for none, so it is not done. The campaign
          settings above ARE this campaign's own.
        </p>
      </details>

      <MetricSummary items={shopMetrics} source={basis} />

      <TabRow tabs={TABS} value={tab} onChange={setTab} />

      {/* One boundary per tab panel, keyed on the tab and window. A failure in
          Scenario leaves the tab row, the metric strip and the shell intact, so
          the operator can move to Performance instead of reloading — and
          switching tabs clears the error rather than sticking to it. */}
      <div className="stack" id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={0}>
        <Boundary name={TABS.find((t) => t.id === tab)?.label} resetKey={`${tab}:${scope.start}:${scope.end}`}>
          {tab === 'performance' && <Performance facts={facts} cur={cur} scope={scope} />}
          {tab === 'scenario' && <Scenario facts={facts} cur={cur} scope={scope} decision={decision} onOpenDecision={() => setDrawer(true)} />}
          {/* Both directions of Target ROI headroom, in the existing tab
              structure rather than as a new page — the requirement asks for
              it 'within campaign analysis', and a fifth top-level route for
              one capability is the dashboard sprawl this is meant to avoid. */}
          {tab === 'headroom' && (
            <RoiHeadroom shop={shop} campaignId={campaignId}
              currentRoi={campaign.target_roas} campaignName={campaign.campaign_name} />
          )}
          {tab === 'evidence' && <EvidenceTab decision={decision} facts={facts} />}
          {tab === 'history' && <History shop={shop} recs={recsQ.data} recsLoading={recsQ.isLoading} />}
        </Boundary>
      </div>

      <RecommendationDrawer
        persist={() => persistRecommendation(shop.id, decision.primary, {
          scopeType: 'shop', scopeLabel: shop.shop_name,
          start: scope.start, end: scope.end,
          modelStart: scope.model.start, modelEnd: scope.model.end, objective: 'balanced',
        })}
        open={drawer} onClose={() => setDrawer(false)}
        decision={decision} shop={shop} stored={stored}
        others={(decision?.all || []).filter((x) => x.fingerprint !== decision?.primary?.fingerprint)}
        params={params}
      />
    </>
  );
}

/**
 * A plain tab row: real buttons, real roles, arrow keys.
 *
 * Selection is carried by the same primary-button treatment the report toolbar
 * uses for its range presets, so "the thing that is on" looks the same in both
 * places instead of inventing a fourth kind of chip.
 */
function TabRow({ tabs, value, onChange }) {
  const onKeyDown = (e) => {
    const i = tabs.findIndex((t) => t.id === value);
    let next = null;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = tabs.length - 1;
    if (next == null) return;
    e.preventDefault();
    onChange(tabs[next].id);
    e.currentTarget.querySelectorAll('[role="tab"]')[next]?.focus();
  };

  return (
    <div className="row" role="tablist" aria-label="Campaign analysis" onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button
          key={t.id}
          id={`tab-${t.id}`}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          aria-controls={`panel-${t.id}`}
          tabIndex={value === t.id ? 0 : -1}
          className={`btn btn-sm${value === t.id ? ' btn-primary' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function Performance({ facts, cur, scope }) {
  const rows = (facts.spendRows || []).filter((d) => d.day >= scope.start && d.day <= scope.end);

  // THE CHART IS DRAWN OVER THE REPORT WINDOW, NOT OVER WHAT ARRIVED.
  //
  // `shop_spend_daily` returns a row per day it HAS. Plotting those rows alone
  // made the axis stop at the last day collected — a report ending 09-07 drew a
  // chart ending 09-05, and nothing on screen said the last two days were
  // missing rather than flat. So the day list comes from the window, every day
  // is present, and a day with no row keeps nulls: a gap in the line and no bar,
  // which is the honest rendering of "not collected".
  const byDay = new Map(rows.map((d) => [String(d.day), d]));
  const days = [];
  for (let iso = scope.start; iso <= scope.end; iso = addDays(iso, 1)) days.push(iso);
  const absent = days.filter((iso) => !byDay.has(iso));

  const data = days.map((iso) => {
    const d = byDay.get(iso);
    return {
      day: iso.slice(5),
      Spend: d ? Number(d.spend) || 0 : null,
      'Total shop GMV': !d || d.total_shop_gmv == null ? null : Number(d.total_shop_gmv),
      'GMV Max claims': d ? Number(d.reported_revenue) || 0 : null,
      'Verified ad-driven': d ? Number(d.measured_paid_gmv) || 0 : null,
    };
  });

  if (!rows.length) {
    return (
      <Panel>
        <EmptyState title="No spend recorded in this window">
          Spend exists for this shop but not between {scope.start} and {scope.end}.
        </EmptyState>
      </Panel>
    );
  }

  return (
    <Panel
      title="Performance"
      sub="Daily spend against total shop GMV, shop-level. GMV Max's own figure is shown beside it, not instead of it — a spend decision is about whether the shop grows."
    >
      <div style={{ height: 300 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 6, right: 8, left: 4, bottom: 0 }}>
            <CartesianGrid stroke="var(--divider)" vertical={false} />
            <XAxis dataKey="day" tick={{ fontSize: 12, fill: 'var(--text-2)' }}
              tickLine={false} axisLine={{ stroke: 'var(--divider)' }} minTickGap={18} />
            <YAxis tick={{ fontSize: 12, fill: 'var(--text-2)' }} tickLine={false} axisLine={false}
              tickFormatter={(v) => money(v, cur)} width={64} />
            <Tooltip
              formatter={(v, n) => [v == null ? 'unavailable' : moneyExact(v, cur), n]}
              contentStyle={{
                background: 'var(--surface)', border: '1px solid var(--divider)',
                borderRadius: 'var(--r-panel)', fontSize: 13, boxShadow: 'var(--shadow-pop)',
              }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="Spend" fill="var(--series-gap)" radius={[2, 2, 0, 0]} />
            <Line type="monotone" dataKey="Total shop GMV" stroke="var(--series-organic)" strokeWidth={2}
              dot={false} connectNulls={false} />
            <Line type="monotone" dataKey="GMV Max claims" stroke="var(--series-seller)" strokeWidth={1.5}
              dot={false} strokeDasharray="4 3" />
            <Line type="monotone" dataKey="Verified ad-driven" stroke="var(--series-paid)" strokeWidth={2}
              dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="meta" style={{ margin: '8px 0 0' }}>
        A break in the green line is a day with no shop channel data — unavailable, not zero.
        {absent.length > 0 && (
          <> {' '}
            <strong>
              {absent.length} of these {days.length} day{days.length === 1 ? '' : 's'} have no ad
              record at all
            </strong>{' '}
            ({absent.length <= 4 ? absent.join(', ') : `${absent[0]} … ${absent[absent.length - 1]}`}).
            The axis still runs to {scope.end} so the gap is visible; those days are blank rather than zero.
          </>
        )}
      </p>
    </Panel>
  );
}

/**
 * Scenarios — spend scenarios, over a stated horizon, with a baseline row.
 *
 * The old table was headed "If daily budget" and printed CUMULATIVE PERIOD
 * spend under it, so a row reading "+20% ... $11,405" implied an eleven-thousand
 * dollar daily budget on a campaign spending three hundred. It also treated a
 * budget change as a spend change one-for-one, and had no baseline to compare
 * against.
 */
function Scenario({ facts, cur, scope, decision, onOpenDecision }) {
  const fits = [
    { key: 'shop', fit: facts.marginal, primary: true },
    { key: 'reported', fit: facts.marginalReported },
    { key: 'verified', fit: facts.marginalVerified },
  ].filter((f) => f.fit);

  if (!fits.length) {
    return (
      <Panel>
        <EmptyState title="No spend-response model">
          There is no spend data for this shop, so no relationship between spend and revenue can be
          estimated.
        </EmptyState>
      </Panel>
    );
  }

  const head = facts.marginal;
  const answerable = isAnswerable(head);

  const modelMetrics = answerable ? [
    {
      label: 'Marginal return', value: fixed(head.marginal_roas), source: 'modelled',
      context: `95% interval ${fixed(head.marginal_roas_ci[0])}–${fixed(head.marginal_roas_ci[1])}`,
      // THE INTERVAL IS DELIBERATELY WIDER THAN THE TEXTBOOK ONE.
      // Daily advertising data is autocorrelated — a good week is good on
      // Tuesday and still good on Wednesday — and the classical formula
      // understates uncertainty when that is true. A too-tight interval reads
      // on screen as confidence, and confidence is what a buyer spends money
      // on, so the correction and its size are both stated.
      hint: `Expected incremental ${head.target_label} per incremental ad dollar.`
        + (head.hac_inflation > 1.01
          ? ` The interval is ${((head.hac_inflation - 1) * 100).toFixed(0)}% wider than a textbook calculation would give, because days are not independent of each other — a serial-correlation correction over ${head.hac_lags} lags. The estimate is unchanged; only the uncertainty around it is honest.`
          : ' The interval already allows for days not being independent of each other; on this history that correction made no material difference.'),
    },
    {
      label: 'Average return', value: fixed(head.avg_roas), source: 'measured',
      context: `${money(head.total_spend, cur)} over ${head.days} days`,
    },
    {
      label: 'Elasticity', value: head.elasticity.toFixed(2), source: 'modelled',
      context: head.diminishing_returns === true ? 'diminishing returns'
        : head.diminishing_returns === false ? 'increasing returns'
          : 'indistinguishable from linear',
    },
    {
      label: 'Out-of-sample skill', source: 'modelled',
      value: head.validation?.skill == null ? '—' : pct(head.validation.skill, 0),
      context: head.validation
        ? `${head.validation.folds} forward folds · ${pct(head.validation.mape, 0)} error vs ${pct(head.validation.baseline_mape, 0)} baseline`
        : 'not enough history to validate',
      hint: "Error removed against a naive 'tomorrow looks like the recent average' baseline, tested only on days the model had not seen. This is model confidence, not recommendation confidence.",
    },
    // ── WHAT THE TRAINING WINDOW ACTUALLY CONTAINED ────────────────────────
    // "32 days" beside a two-month date range invites the range to be read as
    // the evidence base. A day the campaign was not running is a real state,
    // not a gap, and it is also why the no-advertising counterfactual is not
    // estimable — the model has never seen this shop at zero spend.
    {
      label: 'Days fitted', source: 'measured',
      value: head.days == null ? '—' : String(head.days),
      context: head.days_in_window
        ? `of ${head.days_in_window} in the training window`
          + (head.days_zero_spend ? ` · ${head.days_zero_spend} with no spend` : '')
        : 'training window size not reported',
      hint: 'The number of days the curve was actually fitted on, against the number the window spans. A date range is not an evidence base: days with no spend, or with no revenue figure, cannot enter a log fit and are counted separately rather than quietly dropped.',
    },
  ] : [];

  return (
    <>
      {/* The report window and the training window are DIFFERENT, and both are
          shown. Selecting 7 days used to throw the model's history away. */}
      <Notice tone="info">
        Reporting shows <strong>{scope.start} → {scope.end}</strong> ({scope.spanDays} days).
        The model trains on <strong>{scope.model.start} → {scope.model.end}</strong> — changing the
        report range does not discard training history, and the model never trains on days after the
        reporting cutoff.
      </Notice>

      {!answerable ? (
        <Panel
          title="What the next dollar returns"
          sub={`Fitted against ${head.target_label}, on ${head.days} days ending ${scope.model.end}.`}
        >
          <Notice tone="warn">
            <p style={{ margin: 0 }}><strong>Not answerable yet.</strong> {head.reason}</p>
            <p style={{ margin: '6px 0 0' }}><strong>What would change it:</strong> {recoveryFor(head)}</p>
          </Notice>
        </Panel>
      ) : (
        <>
          <MetricSummary items={modelMetrics} source="modelled" />

          {/* ── NO SPEND CEILING IS IDENTIFIED, AND THAT IS STRUCTURAL ───────
              This model is a power curve: it bends but never turns, so
              predicted revenue keeps rising with spend whatever the elasticity.
              It therefore cannot produce a saturation point — and must never be
              read as having ruled one out either. Saying so is the difference
              between an honest limitation and a silence a reader fills in
              themselves. A curve chosen because it guarantees a turning point
              would manufacture the answer instead. */}
          {head.ceiling && (
            <Notice tone="info">
              <strong>No spend ceiling is identified.</strong> {head.ceiling.reason}
              <p className="meta" style={{ margin: '6px 0 0' }}>
                This model bends but never turns, so it cannot find a point where more
                spend stops paying — and it should not be read as having ruled one out.
                The question it can answer is the economic one: where the marginal return
                falls below what your objective needs
                {head.ceiling.economic_limit_computable
                  ? ', which is computable here because returns diminish.'
                  : ', which is not computable on this history because returns do not diminish across the range observed.'}
              </p>
            </Notice>
          )}

          <Panel
            title="What the next dollar returns"
            sub={`Fitted against ${head.target_label}, on ${head.days} days ending ${scope.model.end}.`}
            right={<span className="meta">training {scope.model.start} → {scope.model.end}</span>}
            bodyPad={false}
          >
            <ScenarioTable fit={head} cur={cur} scope={scope} decision={decision} onOpenDecision={onOpenDecision} />
          </Panel>
        </>
      )}

      {/* Both other targets, reported whether or not they answer. Hiding the one
          that refused would mislead. */}
      <Panel
        title="The same question, against the other two targets"
        sub="A scaling decision reads differently depending on what you count as the return."
      >
        <div className="stack">
          {fits.filter((f) => !f.primary).map(({ key, fit }) => (
            <div key={key}>
              <div className="meta">{TARGET_LABEL[fit.target]}</div>
              {isAnswerable(fit) ? (
                <p style={{ margin: '2px 0 0' }}>
                  The next dollar returns <strong>{fixed(fit.marginal_roas)}</strong>{' '}
                  <span className="muted">({fixed(fit.marginal_roas_ci[0])}–{fixed(fit.marginal_roas_ci[1])})</span>,
                  on an average of {fixed(fit.avg_roas)}.
                </p>
              ) : (
                <p className="muted" style={{ margin: '2px 0 0' }}>
                  <strong>No answer.</strong> {fit.reason}
                </p>
              )}
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}

// `scope` is REQUIRED, not optional. The disclosure below names the report
// window to contrast it against the model's training window, and that contrast
// is the whole point of the panel — a baseline is only honest if you can see
// which dates it is NOT. Rendering without it threw `scope is not defined` and
// took the entire app shell down with it.
function ScenarioTable({ fit, cur, scope, decision, onOpenDecision }) {
  const rows = fit.scenarios || [];
  if (!rows.length) return null;
  const anyBudget = rows.some((s) => s.implied_daily_budget != null);

  return (
    <>
      <div className="tablewrap">
        <table className="data">
          <thead>
            <tr>
              <th className="sticky-l">Scenario</th>
              <th className="num">Daily spend</th>
              {anyBudget && (
                <th className="num">
                  Daily budget needed
                  <Hint text="Translated from spend using the utilisation actually observed. A 20% budget rise does not mean 20% more spend, so this is an assumption and is shown as one." />
                </th>
              )}
              <th className="num">Spend over {fit.horizon_days}d</th>
              <th className="num">Expected {fit.target_label}</th>
              <th className="num">Incremental spend</th>
              <th className="num">Incremental GMV</th>
              <th className="num">Marginal ROAS</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.delta}>
                <td className="sticky-l">
                  {/* NOT "Current". The baseline is the model's mean daily
                      spend over its TRAINING window — $328/day across 29
                      observed days — while the selected report showed $1,267
                      across 5 days. Calling the historical average "Current"
                      presented it as recent delivery, which it is not. */}
                  {s.is_baseline
                    ? <strong>Model baseline</strong>
                    : <strong>{s.delta > 0 ? '+' : ''}{(s.delta * 100).toFixed(0)}% spend</strong>}
                  {s.outside_observed && !s.is_baseline && (
                    <span className="status status-warn" style={{ marginLeft: 'var(--s2)' }}
                      title="This daily spend is outside the range actually observed, so the curve is extrapolating.">
                      Unobserved
                    </span>
                  )}
                </td>
                <td className="num">{money(s.daily_spend, cur)}</td>
                {anyBudget && (
                  <td className="num muted">
                    {s.implied_daily_budget == null ? '—' : money(s.implied_daily_budget, cur)}
                  </td>
                )}
                <td className="num">{money(s.spend, cur)}</td>
                <td className="num">{money(s.revenue, cur)}</td>
                <td className="num muted">
                  {s.is_baseline ? '—' : `${s.incremental_spend > 0 ? '+' : ''}${money(s.incremental_spend, cur)}`}
                </td>
                <td className="num muted">
                  {s.is_baseline ? '—' : `${s.incremental_revenue > 0 ? '+' : ''}${money(s.incremental_revenue, cur)}`}
                </td>
                <td className="num">
                  {s.is_baseline ? '—' : <strong>{fixed(s.incremental_roas)}</strong>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── A SCENARIO IS NOT A PLAN ──────────────────────────────────────
          The table models a change in DELIVERED SPEND. Nothing here says how
          that spend would come about, and the two available levers are not
          interchangeable: a budget is a cap that only binds if delivery is
          reaching it, and a Target ROI is an auction bid that does not set
          realised return. Turning a row into a plan requires naming the lever
          and passing that lever's own gates — otherwise "+10% spend" silently
          becomes "+10% budget", which is the substitution this panel exists to
          prevent. The link goes to the recommendation, where the mechanism and
          its gate results are stated and a decision can actually be recorded. */}
      <div style={{ padding: 'var(--s4)', borderTop: '1px solid var(--divider)' }}>
        <Notice tone="info">
          <p style={{ margin: 0 }}>
            These are <strong>spend</strong> scenarios, not a plan. To act on one you have to choose the
            control that would produce that spend — a budget cap or a Target ROI bid — and that control
            has its own evidence to satisfy. Neither is implied by a row in this table.
            {decision?.primary && (
              <>{' '}The current recommendation, with its mechanism and checks, is{' '}
                <button className="btn btn-sm" onClick={onOpenDecision}>
                  {actionLabel(decision.primary.action_code)}
                </button>.
              </>
            )}
          </p>
        </Notice>
      </div>

      {/* The caveats are long and they are load-bearing, so they are one click
          away rather than a wall of text above the numbers. */}
      <div style={{ padding: 'var(--s4)', borderTop: '1px solid var(--divider)' }}>
        <details>
          <summary style={{ cursor: 'pointer' }}>How to read these scenarios</summary>
          <p className="meta" style={{ margin: '8px 0 0' }}>
            <strong>Model baseline</strong> is the mean daily spend across the{' '}
            <strong>{fit.days} days the model actually observed</strong>, inside a requested training window
            of {scope.model.spanDays} days. That is deliberately NOT the selected report: this report covers{' '}
            {scope.start} → {scope.end}. A historical average and recent delivery are different quantities,
            and the row is labelled for the one it is.
            {' '}Every row projects over the same <strong>{fit.horizon_days}-day horizon</strong> under the
            same stated context. Marginal ROAS is a finite difference — the predicted GMV difference divided
            by the spend difference — not average ROAS reapplied.
            {' '}These are <strong>spend</strong> scenarios. A modelled +10% spend is not evidence that
            raising the budget 10% will produce that spend: the budget column exists only because
            utilisation was observable, and it is an assumption rather than a measurement.
            {fit.time_confounded && (
              <> <strong>Caution:</strong> spend and the calendar move together here (correlation{' '}
                {fit.spend_time_correlation.toFixed(2)}), so part of what looks like a spend effect may be a
                trend. The estimate already controls for a linear time trend; without that control the
                elasticity would read {fit.naive_elasticity.toFixed(2)} instead of {fit.elasticity.toFixed(2)}.</>
            )}
            {fit.provisional && <> The model is running on {fit.days} days, below the {30} preferred, so treat
              the size as provisional.</>}
          </p>
        </details>
      </div>
    </>
  );
}

function EvidenceTab({ decision, facts }) {
  const p = decision?.primary;
  if (!p) {
    return (
      <Panel>
        <EmptyState title="No recommendation to explain">Nothing was raised for this window.</EmptyState>
      </Panel>
    );
  }

  const diagnostics = [
    ['Rule version', p.rule_version || '—'],
    ['Target', facts.marginal?.target_label || '—'],
    ['Model status', facts.marginal?.status || '—'],
    ['R²', facts.marginal?.r2 != null ? facts.marginal.r2.toFixed(3) : '—'],
    ['Elasticity (time-controlled)', facts.marginal?.elasticity?.toFixed(3) ?? '—'],
    ['Elasticity (uncontrolled)', facts.marginal?.naive_elasticity?.toFixed(3) ?? '—'],
    ['Correlation of spend with the calendar', facts.marginal?.spend_time_correlation?.toFixed(3) ?? '—'],
    ['Forward folds', facts.marginal?.validation?.folds ?? '—'],
    ['Model confidence', p.model_confidence == null ? '—' : pct(p.model_confidence, 0)],
    ['Data coverage', p.data_coverage == null ? '—' : pct(p.data_coverage, 0)],
    ['Recommendation confidence', p.confidence == null ? '—' : `${pct(p.confidence, 0)} (${p.confidence_label})`],
  ];

  return (
    <>
      <Panel title="Guardrails checked">
        {p.guardrails?.length ? (
          <dl className="dl">
            {p.guardrails.map((g, i) => (
              <div key={i} style={{ display: 'contents' }}>
                <dt>{g.passed ? '✓' : '✕'} {g.name}</dt>
                <dd className="muted">{g.detail || (g.passed ? 'passed' : '')}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="muted" style={{ margin: 0 }}>This action has no data prerequisites.</p>
        )}
      </Panel>

      <Panel
        title="Suppressed alternatives"
        sub="Actions the pipeline considered and did not choose. Kept so that 'why not raise budget' has an answer."
      >
        {p.suppressed?.length ? (
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: '22px' }}>
            {p.suppressed.map((s, i) => <li key={i}><strong>{actionLabel(s.action_code)}</strong> — {s.why}</li>)}
          </ul>
        ) : (
          <p className="muted" style={{ margin: 0 }}>Nothing was suppressed for this window.</p>
        )}
      </Panel>

      {/* COLLAPSED BY DEFAULT, and it says what these numbers are NOT.
          R-squared, model confidence, recommendation confidence and data
          coverage sat open beside each other, four numbers between 0 and 1 that
          look interchangeable and are not: one is fit, one is how much to trust
          an estimate, one is how much to trust an action, one is how much of
          the window arrived. Reading any of them as the others' answer is the
          mistake this section is arranged to prevent. */}
      <Panel title="Model diagnostics" bodyPad={false}>
        <details>
          <summary className="panel-body meta" style={{ cursor: 'pointer', paddingBottom: 12 }}>
            Technical detail for checking the model — not a summary of how well the recommendation will work.
          </summary>
          <div className="panel-body" style={{ paddingTop: 0 }}>
            <p className="meta" style={{ margin: '0 0 10px', maxWidth: '78ch' }}>
              These are <strong>four different questions</strong> and their numbers are not comparable:
              model fit is how closely the curve tracks observed spend; model confidence is how much to
              trust its estimate; recommendation confidence is how much to trust <em>this action</em>;
              data coverage is how much of the window actually arrived. A high one does not compensate
              for a low one.
            </p>
            <dl className="dl">
              {diagnostics.map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </details>
      </Panel>
    </>
  );
}

function History({ shop, recs, recsLoading }) {
  const changesQ = useQuery({ queryKey: ['changes', shop.id], queryFn: () => detectedSettingChanges(shop.id) });
  const applied = (recs || []).filter((r) => r.status === 'applied');
  const changes = changesQ.data || [];

  return (
    <>
      <Panel title="Recorded tests" sub="What a buyer said they changed, and when." bodyPad={false}>
        {/* "No tests recorded" is a claim about the record, so it waits for the
            record to arrive rather than being asserted mid-fetch. */}
        {recsLoading ? (
          <div style={{ padding: 'var(--s4)' }}><Skeleton h={80} /></div>
        ) : applied.length ? (
          <div className="tablewrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="sticky-l">Action</th>
                  <th className="num">Suggested</th>
                  <th className="num">Actually set</th>
                  <th>When</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {applied.map((r) => (
                  <tr key={r.id}>
                    <td className="sticky-l">{r.title}</td>
                    <td className="num muted">{r.suggested_value == null ? '—' : Number(r.suggested_value).toFixed(2)}</td>
                    <td className="num"><strong>{r.applied_value == null ? '—' : Number(r.applied_value).toFixed(2)}</strong></td>
                    <td className="muted">{r.applied_at ? new Date(r.applied_at).toLocaleDateString() : '—'}</td>
                    <td><Outcome rec={r} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No tests recorded yet">
            Marking a recommendation applied records that you made the change in TikTok — it never makes
            one.
          </EmptyState>
        )}
      </Panel>

      <Panel
        title="Detected setting changes"
        sub="From consecutive snapshots — distinct from a buyer reporting a change."
        bodyPad={false}
      >
        {changesQ.isLoading ? (
          <div style={{ padding: 'var(--s4)' }}><Skeleton h={80} /></div>
        ) : changes.length ? (
          <div className="tablewrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="sticky-l">When</th>
                  <th>Campaign</th>
                  <th>Field</th>
                  <th className="num">From</th>
                  <th className="num">To</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((c, i) => (
                  <tr key={i}>
                    <td className="sticky-l muted">{new Date(c.detected_at).toLocaleString()}</td>
                    <td>{c.campaign_name || c.campaign_id}</td>
                    <td>{c.field === 'target_roi' ? 'Target ROI' : 'Daily budget'}</td>
                    <td className="num muted">{c.old_value == null ? '—' : Number(c.old_value).toFixed(2)}</td>
                    <td className="num"><strong>{c.new_value == null ? '—' : Number(c.new_value).toFixed(2)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No change detected">
            Snapshots began on 8 September 2026 and no change has been detected since. Nothing before that
            date can be recovered — Reacher exposes no change feed — and the absence is left as an explicit
            state rather than filled in.
          </EmptyState>
        )}
      </Panel>
    </>
  );
}

function Outcome({ rec }) {
  const q = useQuery({
    queryKey: ['outcome', rec.id],
    queryFn: () => recommendationOutcome(rec.id),
  });
  const rows = q.data || [];
  if (q.isLoading) return <span className="skel" style={{ display: 'inline-block', height: 14, width: 64 }} />;
  if (!rows.length) return <Unavailable reason="No outcome has been measured for this test yet." />;
  const seven = rows.find((r) => r.horizon === '7d') || rows[0];
  if (!seven.matured) return <span className="status status-info" title={seven.reason}>Pending</span>;
  const conf = (seven.confounders || []).filter(Boolean);
  return (
    <span title={conf.length ? `Confounded: ${conf.join('; ')}` : 'No confounders detected'}>
      {seven.gmv_change_pct == null ? '—' : `${seven.gmv_change_pct > 0 ? '+' : ''}${pct(seven.gmv_change_pct, 0)} GMV`}
      {conf.length > 0 && <span className="status status-warn" style={{ marginLeft: 'var(--s2)' }}>Confounded</span>}
    </span>
  );
}
