// Organic momentum — is the demand that does not depend on spend growing?
//
// This is the number to read before any ROAS. A campaign can look like it is
// working while the organic base underneath carries the result, and look like
// it is failing while organic collapses around it.
//
// The score is componentised and versioned (lib/momentum.js). Two rules make it
// honest rather than decorative:
//   * a component that cannot be measured is NOT scored as zero — the weights
//     of what remains are renormalised and the coverage is stated;
//   * views are excluded permanently, because Reacher reports LIFETIME views and
//     a "trend" computed from them would be an artefact of the data.
import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import {
  shopAttribution, shopCreativeHealth, topCreators, shopChannelDaily,
  money, moneyExact, pct,
} from '../lib/api.js';
import { momentum, MOMENTUM_VERSION } from '../lib/momentum.js';
import { Card, Stat, Note, Skeleton, Empty, Basis, Hint, MiniBar } from '../components/ui.jsx';

export default function OrganicPage() {
  const { shop, scope } = useOutletContext();
  const cur = shop.currency || 'USD';

  const q = (key, fn, enabled = true) => useQuery({ queryKey: key, queryFn: fn, enabled });

  const nowAttr = q(['attr', shop.id, scope.start, scope.end],
    () => shopAttribution(shop.id, scope.start, scope.end));
  const priorAttr = q(['attr', shop.id, scope.priorStart, scope.priorEnd],
    () => shopAttribution(shop.id, scope.priorStart, scope.priorEnd));
  const nowCre = q(['creative', shop.id, scope.start, scope.end],
    () => shopCreativeHealth(shop.id, scope.start, scope.end));
  const priorCre = q(['creative', shop.id, scope.priorStart, scope.priorEnd],
    () => shopCreativeHealth(shop.id, scope.priorStart, scope.priorEnd));
  const creatorsQ = q(['creators', shop.id, scope.start, scope.end],
    () => topCreators(shop.id, scope.start, scope.end, 25));
  const dailyQ = q(['chdaily', shop.id, scope.start, scope.end],
    () => shopChannelDaily(shop.id, scope.start, scope.end));

  const loading = nowAttr.isLoading || priorAttr.isLoading || nowCre.isLoading || priorCre.isLoading;
  if (loading) return <div className="card pad"><Skeleton h={260} /></div>;

  const a = nowAttr.data;
  if (!a || !Number(a.days_covered)) {
    return <Empty title="No shop data for this window">
      Nothing to compare — this shop has no stored channel data between {scope.start} and {scope.end}.
    </Empty>;
  }

  const m = momentum(
    { attribution: nowAttr.data, creative: nowCre.data },
    { attribution: priorAttr.data, creative: priorCre.data },
  );

  const organic = Number(a.measured_organic_gmv) || 0;
  const paid = Number(a.measured_paid_gmv) || 0;
  const measured = organic + paid;
  const organicShare = measured ? organic / measured : null;

  const tone = m.label === 'Strong' || m.label === 'Growing' ? 'organic'
    : m.label === 'Declining' ? 'danger'
    : m.label === 'Weakening' ? 'warning' : undefined;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card pad">
        <div className="k">
          Organic momentum <Basis kind="measured" />
          <Hint text={`Version ${MOMENTUM_VERSION}. A weighted score across six measurable components, comparing ${scope.start}–${scope.end} against the adjacent ${scope.priorStart}–${scope.priorEnd}.`} />
        </div>
        <div className="headline" style={{ fontSize: 24 }}>
          {m.label
            ? <>Organic demand is <em style={{ color: tone === 'danger' ? 'var(--danger)' : tone === 'warning' ? 'var(--warning)' : 'var(--organic)' }}>{m.label.toLowerCase()}</em> against the previous {scope.spanDays} days.</>
            : <em style={{ color: 'var(--text-muted)' }}>Not enough measurable signal to put a label on this.</em>}
        </div>
        {m.reason && <Note tone="info">{m.reason}</Note>}
        <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 0' }}>
          Comparing <strong>{scope.start} → {scope.end}</strong> against{' '}
          <strong>{scope.priorStart} → {scope.priorEnd}</strong> — adjacent, equal length, no overlap.
          Score built from {Math.round(m.coverage * 100)}% of its intended components.
        </p>
      </div>

      <div className="grid g4">
        <Stat k="Organic revenue" tone="organic" basis="measured" v={money(organic, cur)}
          sub={`${pct(organicShare)} of what we can attribute`}
          hint="Standard-commission revenue: creators posting because the product sells, not because delivery was bought." />
        <Stat k="Ad-driven revenue" tone="paid" basis="measured" v={money(paid, cur)}
          sub={`${pct(organicShare == null ? null : 1 - organicShare)} of what we can attribute`} />
        <Stat k="Creators earning" basis="measured"
          v={Number(nowCre.data?.creators || 0).toLocaleString()}
          sub={deltaLabel(nowCre.data?.creators, priorCre.data?.creators)} />
        <Stat k="New videos selling" basis="measured"
          v={Number(nowCre.data?.new_videos || 0).toLocaleString()}
          sub={deltaLabel(nowCre.data?.new_videos, priorCre.data?.new_videos)}
          hint="Videos that made their first sale inside the window — the pipeline behind future organic revenue." />
      </div>

      <Card title="What is driving the score"
        sub="Every component, its weight, and whether it could be measured at all.">
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Component</th>
                <th className="num">Weight</th>
                <th className="num">Previous</th>
                <th className="num">Current</th>
                <th className="num">Change</th>
                <th>Contribution</th>
              </tr>
            </thead>
            <tbody>
              {m.parts.map((p) => (
                <tr key={p.key} className={p.available ? undefined : 'row-data'}>
                  <td className="tight">
                    {p.label}
                    {p.detail && <Hint text={p.detail} />}
                  </td>
                  <td className="num tight muted">{(p.weight * 100).toFixed(0)}%</td>
                  <td className="num tight muted">{fmt(p.key, p.prior, cur)}</td>
                  <td className="num tight">{fmt(p.key, p.current, cur)}</td>
                  <td className="num tight">
                    {p.change == null
                      ? <span className="muted">—</span>
                      : <span className={p.change > 0.02 ? 'trend-up' : p.change < -0.02 ? 'trend-down' : 'muted'}>
                          {p.change > 0.02 ? '▲' : p.change < -0.02 ? '▼' : ''} {p.change > 0 ? '+' : ''}{(p.change * 100).toFixed(0)}%
                        </span>}
                  </td>
                  <td className="tight">
                    {p.available
                      ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                          <MiniBar value={Math.abs(p.score)} color={p.score >= 0 ? 'var(--organic)' : 'var(--danger)'} />
                          <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                            {p.score >= 0 ? '+' : ''}{(p.score * p.weight * 100).toFixed(1)}
                          </span>
                        </div>
                      )
                      : <span className="muted" style={{ fontSize: 12 }}>not measurable — excluded, not scored zero</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ fontSize: 11.5, margin: '12px 0 0', lineHeight: 1.6 }}>
          A component with no prior value has <strong>no percentage change</strong> — "up from nothing" is
          not a number, and rendering it as one would let a single first sale read as explosive growth.
          Those rows are excluded and the remaining weights renormalised, which is why the coverage figure
          above matters. Changes are compressed so one viral day cannot pin the whole score at its ceiling.
        </p>
      </Card>

      <Card title="Organic revenue by day" sub="The measured organic band, day by day.">
        <OrganicChart rows={dailyQ.data} loading={dailyQ.isLoading} cur={cur} />
      </Card>

      <Card title="Creators carrying organic revenue" pad={false}
        sub="Sorted by how much they sell without ad support — the partnerships worth renewing first.">
        {creatorsQ.isLoading ? <div className="pad"><Skeleton h={180} /></div> : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Creator</th><th className="num">GMV</th>
                  <th className="num">Organic</th><th className="num">Ad-driven</th>
                  <th style={{ width: 130 }}>Organic share</th>
                </tr>
              </thead>
              <tbody>
                {[...(creatorsQ.data || [])]
                  .sort((x, y) => Number(y.organic_gmv) - Number(x.organic_gmv))
                  .slice(0, 12)
                  .map((r) => (
                    <tr key={r.creator_handle}>
                      <td className="tight">@{r.creator_handle}</td>
                      <td className="num tight"><strong>{moneyExact(r.gmv, cur)}</strong></td>
                      <td className="num tight" style={{ color: 'var(--organic)' }}>{moneyExact(r.organic_gmv, cur)}</td>
                      <td className="num tight" style={{ color: 'var(--paid)' }}>{moneyExact(r.paid_gmv, cur)}</td>
                      <td className="tight">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                          <MiniBar value={r.paid_share == null ? null : 1 - Number(r.paid_share)} color="var(--organic)" />
                          <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
                            {r.paid_share == null ? '—' : pct(1 - Number(r.paid_share), 0)}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                {!creatorsQ.data?.length && (
                  <tr><td colSpan={5} className="muted" style={{ padding: 18 }}>No creators earned in this period.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function deltaLabel(current, prior) {
  const c = Number(current); const p = Number(prior);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return 'no prior period to compare';
  const d = (c - p) / p;
  return `${d > 0 ? '+' : ''}${(d * 100).toFixed(0)}% vs previous period`;
}

function fmt(key, v, cur) {
  if (v == null) return <span className="muted">—</span>;
  if (key === 'organic_gmv' || key === 'affiliate_gmv') return money(v, cur);
  return Number(v).toLocaleString();
}

function OrganicChart({ rows, loading, cur }) {
  if (loading) return <Skeleton h={220} />;
  const data = (rows || []).map((d) => ({
    day: String(d.day).slice(5),
    Organic: Number(d.measured_organic_gmv) || 0,
    'Ad-driven': Number(d.measured_paid_gmv) || 0,
  }));
  if (!data.length) return <p className="muted" style={{ margin: 0, fontSize: 13 }}>No daily data in this window.</p>;

  return (
    <div style={{ height: 250 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 8, left: 4, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
          <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
            tickLine={false} axisLine={false} minTickGap={18} />
          <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false}
            tickFormatter={(v) => money(v, cur)} width={62} />
          <Tooltip formatter={(v, n) => [moneyExact(v, cur), n]}
            contentStyle={{ background: 'var(--surface-1)', border: '1px solid var(--border-default)', borderRadius: 10, fontSize: 12 }} />
          <Legend wrapperStyle={{ fontSize: 11.5 }} />
          <Area type="monotone" dataKey="Organic" stackId="1" stroke="var(--organic)"
            fill="var(--organic)" fillOpacity={0.32} />
          <Area type="monotone" dataKey="Ad-driven" stackId="1" stroke="var(--paid)"
            fill="var(--paid)" fillOpacity={0.28} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
