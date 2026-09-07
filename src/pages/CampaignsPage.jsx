// Campaigns — settings, spend against measured revenue, and what was changed.
//
// This is the page that is empty until the ad account is connected in Reacher,
// and the page that carries the loudest warning when it is filled with
// simulated data instead. Both states are deliberate: an empty page that
// explains why is more useful than a page of zeros.
import { useQuery } from '@tanstack/react-query';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { listCampaigns, listSettingsChanges, shopPaidRoas, shopSpendDaily } from '../lib/api.js';
import { Card, Stat, Note, Skeleton, Empty, Basis, money, moneyExact, pct } from '../components/ui.jsx';
import { fitSpendResponse, isAnswerable } from '../lib/marginal.js';

export default function CampaignsPage({ shop, start, end }) {
  const cur = shop.currency || 'USD';
  const campaignsQ = useQuery({ queryKey: ['camps', shop.id], queryFn: () => listCampaigns(shop.id) });
  const roasQ      = useQuery({ queryKey: ['roas2', shop.id, start, end], queryFn: () => shopPaidRoas(shop.id, start, end) });
  const dailyQ     = useQuery({ queryKey: ['spendd', shop.id, start, end], queryFn: () => shopSpendDaily(shop.id, start, end) });
  const changesQ   = useQuery({ queryKey: ['chg', shop.id], queryFn: () => listSettingsChanges(shop.id, 40) });

  const camps = campaignsQ.data || [];
  const simulated = camps.some((c) => c.data_source === 'simulated');

  if (campaignsQ.isLoading) return <Card><Skeleton h={180} /></Card>;

  if (!camps.length) {
    return (
      <Empty title="No GMV Max campaigns for this shop">
        <p style={{ marginTop: 0 }}>
          Reacher returns zero campaigns here. The GMV Max module itself is healthy — its templates and
          settings endpoints respond — so this is the ad account never having been connected on the
          Reacher side, not a missing capability.
        </p>
        <p style={{ marginBottom: 0 }}>
          Once it is connected, this page fills with spend, Target ROI, daily budget and a settings change
          log, and the paid-ROAS comparison on the Overview becomes measured instead of absent. To see how
          it will look before then, run <code>npm run demo:spend</code> — everything it writes is clearly
          marked simulated.
        </p>
      </Empty>
    );
  }

  const r = roasQ.data;
  const daily = (dailyQ.data || []).map((d) => ({
    day: String(d.day).slice(5),
    Spend: Number(d.spend) || 0,
    'GMV Max reported': Number(d.reported_revenue) || 0,
    'Verified ad-driven': Number(d.measured_paid_gmv) || 0,
  }));

  return (
    <div className="grid" style={{ gap: 16 }}>
      {simulated && (
        <div className="simbar">
          <span style={{ fontSize: 17 }}>⚠</span>
          <span>
            <b>These campaigns are simulated.</b> Reacher has no real GMV Max data for this shop yet. The
            revenue figures are measured from real orders; the spend, and GMV Max&rsquo;s reported revenue, are
            generated so the comparison can be demonstrated. Remove with <code>npm run demo:purge</code>.
          </span>
        </div>
      )}

      {r && (() => {
        const f2 = (v) => (v == null ? '—' : Number(v).toFixed(2));
        const src = simulated ? 'simulated' : 'measured';
        return (
          <div className="grid g4">
            <Stat k="Spend" basis={src} v={money(r.spend, cur)}
              sub={`${r.days_with_spend} days · ${r.campaigns} campaign${Number(r.campaigns) === 1 ? '' : 's'}`} />
            <Stat k="Claimed return (ceiling)" basis={src} v={f2(r.reported_roi)}
              sub={`on ${money(r.reported_revenue, cur)} GMV Max claims`} />
            <Stat k="Proven return (floor)" basis={src} tone="paid" v={f2(r.verified_roas)}
              sub={`${money(r.verified_paid_gmv, cur)} with commission evidence`} />
            <Stat k="Unevidenced" basis={src} tone="warning" v={money(r.unverified_revenue, cur)}
              sub={r.unverified_share == null ? '—' : `${pct(r.unverified_share)} of the claim`} />
          </div>
        );
      })()}

      <Card title="Campaigns" sub="Settings as Reacher reports them" pad={false}>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Campaign</th><th>Status</th><th>Type</th>
                <th className="num">Target ROI</th><th className="num">Daily budget</th><th>Source</th>
              </tr>
            </thead>
            <tbody>
              {camps.map((c) => (
                <tr key={c.campaign_id}>
                  <td className="tight"><span className="truncate" style={{ display: 'block' }}>{c.campaign_name || c.campaign_id}</span></td>
                  <td className="tight"><span className={`pill ${c.status === 'ENABLE' ? 'pill-ok' : 'pill-warn'}`}>{c.status || '—'}</span></td>
                  <td className="tight muted">{c.campaign_type || '—'}</td>
                  <td className="num tight">{c.target_roas == null ? '—' : Number(c.target_roas).toFixed(2)}</td>
                  <td className="num tight">{money(c.daily_budget, c.currency || cur)}</td>
                  <td className="tight"><Basis kind={c.data_source === 'simulated' ? 'simulated' : 'measured'} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Spend against what it actually drove"
        sub="Bars are spend. The gap between the two lines is revenue GMV Max claims that no commission evidence supports either way.">
        {dailyQ.isLoading ? <Skeleton h={280} /> : (
          <div style={{ height: 300 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={daily} margin={{ top: 6, right: 8, left: 4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} minTickGap={18} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false}
                  tickFormatter={(v) => money(v, cur)} width={62} />
                <Tooltip formatter={(v, n) => [moneyExact(v, cur), n]}
                  contentStyle={{ background: 'var(--surface-1)', border: '1px solid var(--border-default)', borderRadius: 10, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 11.5 }} />
                <Bar dataKey="Spend" fill="var(--surface-3)" radius={[3, 3, 0, 0]} />
                <Line type="monotone" dataKey="GMV Max reported" stroke="var(--text-muted)" strokeWidth={2} dot={false} strokeDasharray="4 3" />
                <Line type="monotone" dataKey="Verified ad-driven" stroke="var(--paid)" strokeWidth={2.2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <Card title="What was changed" sub="Append-only. A settings change is the only thing that makes an outcome interpretable." pad={false}>
        {changesQ.isLoading ? <div className="pad"><Skeleton h={120} /></div> : (
          <div className="scroll">
            <table>
              <thead>
                <tr><th>When</th><th>Campaign</th><th>Field</th><th>From</th><th>To</th></tr>
              </thead>
              <tbody>
                {(changesQ.data || []).map((c, i) => (
                  <tr key={i}>
                    <td className="tight muted">{new Date(c.changed_at).toLocaleDateString()}</td>
                    <td className="tight muted"><span className="truncate" style={{ display: 'block' }}>{c.campaign_id}</span></td>
                    <td className="tight">{c.field}</td>
                    <td className="tight muted">{c.old_value ?? '—'}</td>
                    <td className="tight"><strong>{c.new_value ?? '—'}</strong></td>
                  </tr>
                ))}
                {!changesQ.data?.length && (
                  <tr><td colSpan={5} className="muted" style={{ padding: 18 }}>No setting changes recorded.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <MarginalCard daily={dailyQ.data} loading={dailyQ.isLoading} cur={cur} simulated={simulated} />
    </div>
  );
}

// ── layer 5: what the next dollar returns ───────────────────────────────────
// Fitted twice, on the same days and the same spend, against two different
// definitions of revenue — GMV Max's own attributed figure and the revenue our
// commission evidence can verify. That mirrors the band used everywhere else in
// this product: a claimed ceiling and a proven floor.
//
// Either fit may refuse independently, and on Biostime's first month exactly
// that happens — the reported model answers, the verified one is too uncertain.
// Showing one and hiding the other would be the misleading option.
function MarginalCard({ daily, loading, cur, simulated }) {
  if (loading) return <Card title="What the next dollar returns"><Skeleton h={160} /></Card>;

  const rows = daily || [];
  const reported = fitSpendResponse(rows.map((d) => ({ spend: d.spend, revenue: d.reported_revenue })));
  const verified = fitSpendResponse(rows.map((d) => ({ spend: d.spend, revenue: d.measured_paid_gmv })));

  const f2 = (v) => (v == null || !Number.isFinite(v) ? '—' : Number(v).toFixed(2));
  const answerable = isAnswerable(reported);

  return (
    <div className="card pad">
      <div className="k">
        What the next dollar returns <Basis kind={simulated ? 'simulated' : 'modelled'} />
      </div>

      {answerable ? (
        <div className="headline" style={{ fontSize: 22 }}>
          On GMV Max&rsquo;s own numbers the next dollar returns about{' '}
          <em style={{ color: 'var(--accent)' }}>{f2(reported.marginal_roas)}</em>
          <span className="muted" style={{ fontSize: 14, fontWeight: 500 }}>
            {' '}({f2(reported.marginal_roas_ci[0])}–{f2(reported.marginal_roas_ci[1])})
          </span>
          , against an average of {f2(reported.avg_roas)}.
        </div>
      ) : (
        <div className="headline" style={{ fontSize: 20 }}>
          <em style={{ color: 'var(--text-muted)' }}>Not answerable yet.</em>
        </div>
      )}

      {!answerable && <Note tone="info">{reported.reason}</Note>}

      {answerable && (
        <>
          <div className="grid g4" style={{ marginTop: 4 }}>
            <Stat k="Elasticity" v={reported.elasticity.toFixed(2)}
              sub={reported.diminishing_returns === true ? 'diminishing returns'
                : reported.diminishing_returns === false ? 'increasing returns'
                : 'indistinguishable from linear'} />
            <Stat k="Average ROAS" v={f2(reported.avg_roas)}
              sub={`${money(reported.total_spend, cur)} over ${reported.days} days`} />
            <Stat k="Marginal ROAS" tone="paid" v={f2(reported.marginal_roas)}
              sub={`95% interval ${f2(reported.marginal_roas_ci[0])}–${f2(reported.marginal_roas_ci[1])}`} />
            <Stat k="Fit quality" v={`R² ${reported.r2.toFixed(2)}`}
              sub={`spend varied ${(reported.spend_cv * 100).toFixed(0)}% day to day`} />
          </div>

          <div className="scroll" style={{ marginTop: 16 }}>
            <table>
              <thead>
                <tr>
                  <th>If daily budget</th>
                  <th className="num">Spend</th>
                  <th className="num">Modelled revenue</th>
                  <th className="num">Change in spend</th>
                  <th className="num">Change in revenue</th>
                  <th className="num">That change returns</th>
                </tr>
              </thead>
              <tbody>
                {reported.scenarios.map((s) => (
                  <tr key={s.delta}>
                    <td className="tight">
                      <strong>{s.delta > 0 ? '+' : ''}{(s.delta * 100).toFixed(0)}%</strong>
                    </td>
                    <td className="num tight">{money(s.spend, cur)}</td>
                    <td className="num tight">{money(s.revenue, cur)}</td>
                    <td className="num tight muted">{s.incremental_spend > 0 ? '+' : ''}{money(s.incremental_spend, cur)}</td>
                    <td className="num tight muted">{s.incremental_revenue > 0 ? '+' : ''}{money(s.incremental_revenue, cur)}</td>
                    <td className="num tight"><strong>{f2(s.incremental_roas)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* The verified-revenue fit, reported whether or not it answers. */}
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
        <div className="k">Against verified ad-driven revenue only</div>
        {isAnswerable(verified) ? (
          <p style={{ fontSize: 13, margin: '8px 0 0' }}>
            Measured against revenue whose commission proves the ads drove it, the next dollar returns{' '}
            <strong>{f2(verified.marginal_roas)}</strong>{' '}
            <span className="muted">({f2(verified.marginal_roas_ci[0])}–{f2(verified.marginal_roas_ci[1])})</span>,
            on an average of {f2(verified.avg_roas)}.
          </p>
        ) : (
          <p className="muted" style={{ fontSize: 13, margin: '8px 0 0' }}>
            <strong>No answer here.</strong> {verified.reason}
          </p>
        )}
      </div>

      <p className="muted" style={{ fontSize: 11.5, marginTop: 14, marginBottom: 0, lineHeight: 1.55 }}>
        Fitted as <code>revenue = a × spend^b</code> on {reported.days} days, so marginal ROAS is
        simply <code>b × average ROAS</code>. Two parameters, no machine learning — the number can be argued
        with, which is the point.
        {reported.time_confounded && (
          <> <strong>Caution:</strong> spend and the calendar move together here
          (correlation {reported.spend_time_correlation.toFixed(2)}), so some of what looks like a spend
          effect may be a trend. The figure above already controls for a linear time trend; without that
          control the elasticity would read {reported.naive_elasticity.toFixed(2)} instead
          of {reported.elasticity.toFixed(2)}.</>
        )}
        {' '}Modelled, not measured: it describes what these {reported.days} days imply, and assumes nothing
        else changes.
      </p>
    </div>
  );
}
