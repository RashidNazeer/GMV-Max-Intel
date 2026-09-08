// Campaign detail — the decision, made explicit.
//
// The first screenful carries ONE primary recommendation, the current setting,
// the suggested test, its confidence, the reason and what to watch. Analysis
// lives behind a tab bar rather than expanding six sections into one very long
// page.
import { useState } from 'react';
import { useParams, useOutletContext, useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  LineChart, Line, Bar, ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts';
import {
  listCampaigns, listRecommendations, detectedSettingChanges, recommendationOutcome,
  money, moneyExact, pct, fixed,
} from '../lib/api.js';
import { useFacts } from '../lib/facts.js';
import { scopedTo } from '../lib/scope.js';
import { DecisionHeader } from '../components/Decisions.jsx';
import {
  Card, Stat, Note, Skeleton, Empty, Basis, Hint, TabBar, SimulatedBanner,
} from '../components/ui.jsx';
import { isAnswerable, recoveryFor, TARGET_LABEL } from '../lib/marginal.js';

const TABS = [
  { id: 'performance', label: 'Performance' },
  { id: 'scenario', label: 'Scenario' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'history', label: 'History' },
];

export default function CampaignDetailPage() {
  const { campaignId } = useParams();
  const { shop, scope } = useOutletContext();
  const [params] = useSearchParams();
  const [tab, setTab] = useState('performance');
  const cur = shop.currency || 'USD';

  const campaignsQ = useQuery({ queryKey: ['camps', shop.id], queryFn: () => listCampaigns(shop.id) });
  const { facts, decision, loading } = useFacts(shop, scope);
  const recsQ = useQuery({
    queryKey: ['recs', shop.id],
    queryFn: () => listRecommendations(shop.id, { status: ['proposed', 'planned', 'applied'] }),
  });

  const campaign = (campaignsQ.data || []).find((c) => c.campaign_id === campaignId);

  if (campaignsQ.isLoading || loading) return <div className="card pad"><Skeleton h={220} /></div>;
  if (!campaign) {
    return (
      <Empty title="That campaign is not in this shop">
        The link may point at a campaign belonging to another shop, or one that no longer exists.{' '}
        <Link className="lnk" to={scopedTo('/campaigns', params)}>Back to campaigns</Link>
      </Empty>
    );
  }

  const stored = (recsQ.data || []).find((r) => r.fingerprint === decision?.primary?.fingerprint);
  const simulated = campaign.data_source === 'simulated';

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="crumbs">
        <Link className="lnk" to={scopedTo('/campaigns', params)}>← Campaigns</Link>
        <span className="muted"> / {campaign.campaign_name || campaign.campaign_id}</span>
      </div>

      {simulated && <SimulatedBanner />}

      {/* The decision is currently reasoned at SHOP scope, because Reacher gives
          no per-campaign revenue and no per-campaign spend split. Saying so is
          the point — presenting a shop-wide estimate as campaign-specific would
          be exactly the substitution this product exists to avoid. */}
      <Note tone="info">
        This recommendation is reasoned at <strong>shop scope</strong>. Reacher exposes spend per campaign
        but not revenue per campaign, so a campaign-specific marginal return is not computable today.
        The setting values below are this campaign&rsquo;s own.
      </Note>

      <DecisionHeader decision={decision} shop={shop} scope={scope} stored={stored} />

      <div className="grid g5">
        <Stat k="Status" v={campaign.status === 'ENABLE' ? 'Active' : 'Inactive'} basis={simulated ? 'simulated' : 'measured'} />
        <Stat k="Target ROI" v={campaign.target_roas == null ? '—' : Number(campaign.target_roas).toFixed(2)}
          basis={simulated ? 'simulated' : 'measured'}
          hint="A delivery setting: how hard GMV Max bids. It is not the brand's break-even target." />
        <Stat k="Daily budget" v={campaign.daily_budget == null ? '—' : money(campaign.daily_budget, cur)}
          basis={simulated ? 'simulated' : 'measured'} />
        <Stat k="GMV Max ROI" v={fixed(facts.roas?.reported_roi)} basis={simulated ? 'simulated' : 'measured'}
          sub="shop, all campaigns" />
        <Stat k="Proven return" tone="paid" v={fixed(facts.roas?.verified_roas)}
          basis={simulated ? 'simulated' : 'measured'} sub="shop, all campaigns"
          hint="Revenue whose commission proves the ads drove it, over ALL spend. The floor of the band." />
      </div>

      <TabBar tabs={TABS} value={tab} onChange={setTab} />

      {tab === 'performance' && <Performance facts={facts} cur={cur} scope={scope} />}
      {tab === 'scenario' && <Scenario facts={facts} cur={cur} scope={scope} />}
      {tab === 'evidence' && <EvidenceTab decision={decision} facts={facts} />}
      {tab === 'history' && <History shop={shop} recs={recsQ.data} />}
    </div>
  );
}

function Performance({ facts, cur, scope }) {
  const rows = (facts.spendRows || []).filter((d) => d.day >= scope.start && d.day <= scope.end);
  const data = rows.map((d) => ({
    day: String(d.day).slice(5),
    Spend: Number(d.spend) || 0,
    'Total shop GMV': d.total_shop_gmv == null ? null : Number(d.total_shop_gmv),
    'GMV Max claims': Number(d.reported_revenue) || 0,
    'Verified ad-driven': Number(d.measured_paid_gmv) || 0,
  }));

  if (!data.length) {
    return <Empty title="No spend recorded in this window">
      Spend exists for this shop but not between {scope.start} and {scope.end}.
    </Empty>;
  }

  return (
    <Card title="Spend against what moved"
      sub="Total shop GMV is what a spend decision is really about. GMV Max's own figure is shown beside it, not instead of it.">
      <div style={{ height: 300 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 6, right: 8, left: 4, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
            <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} minTickGap={18} />
            <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false}
              tickFormatter={(v) => money(v, cur)} width={62} />
            <Tooltip formatter={(v, n) => [v == null ? 'unavailable' : moneyExact(v, cur), n]}
              contentStyle={{ background: 'var(--surface-1)', border: '1px solid var(--border-default)', borderRadius: 10, fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 11.5 }} />
            <Bar dataKey="Spend" fill="var(--surface-3)" radius={[3, 3, 0, 0]} />
            <Line type="monotone" dataKey="Total shop GMV" stroke="var(--organic)" strokeWidth={2} dot={false} connectNulls={false} />
            <Line type="monotone" dataKey="GMV Max claims" stroke="var(--text-muted)" strokeWidth={1.5} dot={false} strokeDasharray="4 3" />
            <Line type="monotone" dataKey="Verified ad-driven" stroke="var(--paid)" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="muted" style={{ fontSize: 11.5, marginTop: 12, marginBottom: 0, lineHeight: 1.55 }}>
        A break in the green line is a day with no shop channel data — unavailable, not zero.
      </p>
    </Card>
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
function Scenario({ facts, cur, scope }) {
  const fits = [
    { key: 'shop', fit: facts.marginal, primary: true },
    { key: 'reported', fit: facts.marginalReported },
    { key: 'verified', fit: facts.marginalVerified },
  ].filter((f) => f.fit);

  if (!fits.length) {
    return <Empty title="No spend-response model">
      There is no spend data for this shop, so no relationship between spend and revenue can be
      estimated.
    </Empty>;
  }

  const head = facts.marginal;
  const answerable = isAnswerable(head);

  return (
    <div className="grid" style={{ gap: 16 }}>
      <Card title="What the next dollar returns"
        sub={`Fitted against ${head.target_label}, on ${head.days} days ending ${scope.model.end}.`}
        right={<span className="muted" style={{ fontSize: 12 }}>
          training {scope.model.start} → {scope.model.end}
        </span>}>

        {/* The report window and the training window are DIFFERENT, and both are
            shown. Selecting 7 days used to throw the model's history away. */}
        <Note tone="info">
          Reporting shows <strong>{scope.start} → {scope.end}</strong> ({scope.spanDays} days).
          The model trains on <strong>{scope.model.start} → {scope.model.end}</strong> — changing the
          report range does not discard training history, and the model never trains on days after the
          reporting cutoff.
        </Note>

        {!answerable ? (
          <div style={{ marginTop: 14 }}>
            <div className="headline" style={{ fontSize: 19 }}>
              <em style={{ color: 'var(--text-muted)' }}>Not answerable yet.</em>
            </div>
            <Note tone="warn">
              <div><strong>Why:</strong> {head.reason}</div>
              <div style={{ marginTop: 6 }}><strong>What would change it:</strong> {recoveryFor(head)}</div>
            </Note>
          </div>
        ) : (
          <>
            <div className="grid g4" style={{ marginTop: 12 }}>
              <Stat k="Marginal return" tone="paid" basis="modelled" v={fixed(head.marginal_roas)}
                sub={`95% interval ${fixed(head.marginal_roas_ci[0])}–${fixed(head.marginal_roas_ci[1])}`}
                hint={`Expected incremental ${head.target_label} per incremental ad dollar.`} />
              <Stat k="Average return" basis="measured" v={fixed(head.avg_roas)}
                sub={`${money(head.total_spend, cur)} over ${head.days} days`} />
              <Stat k="Elasticity" basis="modelled" v={head.elasticity.toFixed(2)}
                sub={head.diminishing_returns === true ? 'diminishing returns'
                  : head.diminishing_returns === false ? 'increasing returns'
                  : 'indistinguishable from linear'} />
              <Stat k="Out-of-sample skill" basis="modelled"
                v={head.validation?.skill == null ? '—' : pct(head.validation.skill, 0)}
                sub={head.validation
                  ? `${head.validation.folds} forward folds · ${pct(head.validation.mape, 0)} error vs ${pct(head.validation.baseline_mape, 0)} baseline`
                  : 'not enough history to validate'}
                hint="Error removed against a naive 'tomorrow looks like the recent average' baseline, tested only on days the model had not seen. This is model confidence, not recommendation confidence." />
            </div>

            <ScenarioTable fit={head} cur={cur} />
          </>
        )}
      </Card>

      {/* Both other targets, reported whether or not they answer. Hiding the one
          that refused would mislead. */}
      <Card title="The same question, against the other two targets"
        sub="A scaling decision reads differently depending on what you count as the return.">
        <div className="grid" style={{ gap: 10 }}>
          {fits.filter((f) => !f.primary).map(({ key, fit }) => (
            <div key={key} className="altfit">
              <div className="k">{TARGET_LABEL[fit.target]}</div>
              {isAnswerable(fit) ? (
                <p style={{ fontSize: 13, margin: '6px 0 0' }}>
                  The next dollar returns <strong>{fixed(fit.marginal_roas)}</strong>{' '}
                  <span className="muted">({fixed(fit.marginal_roas_ci[0])}–{fixed(fit.marginal_roas_ci[1])})</span>,
                  on an average of {fixed(fit.avg_roas)}.
                </p>
              ) : (
                <p className="muted" style={{ fontSize: 13, margin: '6px 0 0' }}>
                  <strong>No answer.</strong> {fit.reason}
                </p>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function ScenarioTable({ fit, cur }) {
  const rows = fit.scenarios || [];
  if (!rows.length) return null;
  const anyBudget = rows.some((s) => s.implied_daily_budget != null);

  return (
    <>
      <div className="scroll" style={{ marginTop: 16 }}>
        <table>
          <thead>
            <tr>
              <th>Scenario</th>
              <th className="num">Daily spend</th>
              {anyBudget && <th className="num">
                Daily budget needed
                <Hint text="Translated from spend using the utilisation actually observed. A 20% budget rise does not mean 20% more spend, so this is an assumption and is shown as one." />
              </th>}
              <th className="num">Spend over {fit.horizon_days}d</th>
              <th className="num">Expected {fit.target_label}</th>
              <th className="num">Incremental spend</th>
              <th className="num">Incremental GMV</th>
              <th className="num">Marginal ROAS</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.delta} className={s.is_baseline ? 'row-baseline' : undefined}>
                <td className="tight">
                  {s.is_baseline
                    ? <strong>Current</strong>
                    : <strong>{s.delta > 0 ? '+' : ''}{(s.delta * 100).toFixed(0)}% spend</strong>}
                  {s.outside_observed && !s.is_baseline && (
                    <span className="chip chip-warn" style={{ marginLeft: 6 }}
                      title="This daily spend is outside the range actually observed, so the curve is extrapolating.">
                      unobserved
                    </span>
                  )}
                </td>
                <td className="num tight">{money(s.daily_spend, cur)}</td>
                {anyBudget && (
                  <td className="num tight muted">
                    {s.implied_daily_budget == null ? '—' : money(s.implied_daily_budget, cur)}
                  </td>
                )}
                <td className="num tight">{money(s.spend, cur)}</td>
                <td className="num tight">{money(s.revenue, cur)}</td>
                <td className="num tight muted">
                  {s.is_baseline ? '—' : `${s.incremental_spend > 0 ? '+' : ''}${money(s.incremental_spend, cur)}`}
                </td>
                <td className="num tight muted">
                  {s.is_baseline ? '—' : `${s.incremental_revenue > 0 ? '+' : ''}${money(s.incremental_revenue, cur)}`}
                </td>
                <td className="num tight">
                  {s.is_baseline ? '—' : <strong>{fixed(s.incremental_roas)}</strong>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="muted" style={{ fontSize: 11.5, marginTop: 12, marginBottom: 0, lineHeight: 1.6 }}>
        Every row projects over the same <strong>{fit.horizon_days}-day horizon</strong> under the same
        stated context. Marginal ROAS is a finite difference — the predicted GMV difference divided by the
        spend difference — not average ROAS reapplied. These are <strong>spend</strong> scenarios: the
        budget column exists only because utilisation was observable, and it is an assumption rather than
        a measurement.
        {fit.time_confounded && (
          <> <strong>Caution:</strong> spend and the calendar move together here (correlation{' '}
          {fit.spend_time_correlation.toFixed(2)}), so part of what looks like a spend effect may be a
          trend. The estimate already controls for a linear time trend; without that control the
          elasticity would read {fit.naive_elasticity.toFixed(2)} instead of {fit.elasticity.toFixed(2)}.</>
        )}
        {fit.provisional && <> The model is running on {fit.days} days, below the {30} preferred, so treat
        the size as provisional.</>}
      </p>
    </>
  );
}

function EvidenceTab({ decision, facts }) {
  const p = decision?.primary;
  if (!p) return <Empty title="No recommendation to explain">Nothing was raised for this window.</Empty>;
  return (
    <div className="grid" style={{ gap: 16 }}>
      <Card title="Guardrails checked">
        <table className="plain">
          <tbody>
            {(p.guardrails || []).map((g, i) => (
              <tr key={i}>
                <td style={{ width: 26 }}>{g.passed ? '✓' : '✕'}</td>
                <td>{g.name}</td>
                <td className="muted">{g.detail || ''}</td>
              </tr>
            ))}
            {!p.guardrails?.length && <tr><td className="muted">This action has no data prerequisites.</td></tr>}
          </tbody>
        </table>
      </Card>

      <Card title="Suppressed alternatives"
        sub="Actions the pipeline considered and did not choose. Kept so that 'why not raise budget' has an answer.">
        {p.suppressed?.length ? (
          <ul className="evlist">
            {p.suppressed.map((s, i) => <li key={i}><strong>{s.action_code}</strong> — {s.why}</li>)}
          </ul>
        ) : <p className="muted" style={{ margin: 0, fontSize: 13 }}>Nothing was suppressed for this window.</p>}
      </Card>

      <Card title="Model diagnostics" sub="Kept here rather than in the buyer's default view.">
        <table className="plain">
          <tbody>
            <tr><td>Rule version</td><td>{p.rule_version}</td></tr>
            <tr><td>Target</td><td>{facts.marginal?.target_label || '—'}</td></tr>
            <tr><td>Model status</td><td>{facts.marginal?.status || '—'}</td></tr>
            <tr><td>R²</td><td>{facts.marginal?.r2 != null ? facts.marginal.r2.toFixed(3) : '—'}</td></tr>
            <tr><td>Elasticity (time-controlled)</td><td>{facts.marginal?.elasticity?.toFixed(3) ?? '—'}</td></tr>
            <tr><td>Elasticity (uncontrolled)</td><td>{facts.marginal?.naive_elasticity?.toFixed(3) ?? '—'}</td></tr>
            <tr><td>corr(spend, day)</td><td>{facts.marginal?.spend_time_correlation?.toFixed(3) ?? '—'}</td></tr>
            <tr><td>Forward folds</td><td>{facts.marginal?.validation?.folds ?? '—'}</td></tr>
            <tr><td>Model confidence</td><td>{p.model_confidence == null ? '—' : pct(p.model_confidence, 0)}</td></tr>
            <tr><td>Data coverage</td><td>{p.data_coverage == null ? '—' : pct(p.data_coverage, 0)}</td></tr>
            <tr><td>Recommendation confidence</td><td>{p.confidence == null ? '—' : pct(p.confidence, 0)} ({p.confidence_label})</td></tr>
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function History({ shop, recs }) {
  const changesQ = useQuery({ queryKey: ['changes', shop.id], queryFn: () => detectedSettingChanges(shop.id) });
  const applied = (recs || []).filter((r) => r.status === 'applied');

  return (
    <div className="grid" style={{ gap: 16 }}>
      <Card title="Recorded tests" sub="What a buyer said they changed, and when." pad={false}>
        {applied.length ? (
          <div className="scroll">
            <table>
              <thead><tr><th>Action</th><th className="num">Suggested</th><th className="num">Actually set</th><th>When</th><th>Outcome</th></tr></thead>
              <tbody>
                {applied.map((r) => (
                  <tr key={r.id}>
                    <td className="tight">{r.title}</td>
                    <td className="num tight muted">{r.suggested_value == null ? '—' : Number(r.suggested_value).toFixed(2)}</td>
                    <td className="num tight"><strong>{r.applied_value == null ? '—' : Number(r.applied_value).toFixed(2)}</strong></td>
                    <td className="tight muted">{r.applied_at ? new Date(r.applied_at).toLocaleDateString() : '—'}</td>
                    <td className="tight"><Outcome rec={r} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="pad">
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              No tests recorded yet. Marking a recommendation applied records that you made the change in
              TikTok — it never makes one.
            </p>
          </div>
        )}
      </Card>

      <Card title="Detected setting changes"
        sub="From consecutive snapshots — distinct from a buyer reporting a change." pad={false}>
        {(changesQ.data || []).length ? (
          <div className="scroll">
            <table>
              <thead><tr><th>When</th><th>Campaign</th><th>Field</th><th className="num">From</th><th className="num">To</th></tr></thead>
              <tbody>
                {changesQ.data.map((c, i) => (
                  <tr key={i}>
                    <td className="tight muted">{new Date(c.detected_at).toLocaleString()}</td>
                    <td className="tight">{c.campaign_name || c.campaign_id}</td>
                    <td className="tight">{c.field === 'target_roi' ? 'Target ROI' : 'Daily budget'}</td>
                    <td className="num tight muted">{c.old_value == null ? '—' : Number(c.old_value).toFixed(2)}</td>
                    <td className="num tight"><strong>{c.new_value == null ? '—' : Number(c.new_value).toFixed(2)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="pad">
            <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
              Snapshots began on 8 September 2026 and no change has been detected since. Nothing before that
              date can be recovered — Reacher exposes no change feed — and the absence is left as an
              explicit state rather than filled in.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}

function Outcome({ rec }) {
  const q = useQuery({
    queryKey: ['outcome', rec.id],
    queryFn: () => recommendationOutcome(rec.id),
  });
  const rows = q.data || [];
  if (!rows.length) return <span className="muted">—</span>;
  const seven = rows.find((r) => r.horizon === '7d') || rows[0];
  if (!seven.matured) return <span className="chip chip-info" title={seven.reason}>pending</span>;
  const conf = (seven.confounders || []).filter(Boolean);
  return (
    <span title={conf.length ? `Confounded: ${conf.join('; ')}` : 'No confounders detected'}>
      {seven.gmv_change_pct == null ? '—' : `${seven.gmv_change_pct > 0 ? '+' : ''}${pct(seven.gmv_change_pct, 0)} GMV`}
      {conf.length > 0 && <span className="chip chip-warn" style={{ marginLeft: 6 }}>confounded</span>}
    </span>
  );
}
