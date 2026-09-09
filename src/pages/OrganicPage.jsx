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
//
// ── WHAT THIS REDESIGN CHANGES ─────────────────────────────────────────────
// Presentation only. Every query, key and calculation is untouched.
//   * The 24px headline block became ONE status line: the label as a pill, the
//     sentence, and the comparison window beside it.
//   * The two long explanatory paragraphs — renormalised weights, compressed
//     changes — moved into a "How this score is built" disclosure instead of
//     sitting full width above and below the data.
//   * Driver rows are one table, not a coloured cell per driver, and an
//     unmeasurable component is a dash with a reason rather than a sentence
//     wedged into a cell. The reason is the one that is TRUE for that
//     component — views have no change because they are lifetime totals, not
//     because the previous period was empty.
//   * A failed read says so. An error on the creator or daily query used to
//     fall through to "no creators earned in this period", which reports an
//     absence that was never measured.
import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import {
  shopAttribution, shopCreativeHealth, topCreators, shopChannelDaily,
  money, moneyExact, pct, numOrNull,
} from '../lib/api.js';
import { momentum, MOMENTUM_VERSION } from '../lib/momentum.js';
import ReportToolbar from '../components/ReportToolbar.jsx';
import {
  Panel, PageHeader, MetricSummary, Notice, Skeleton, EmptyState, Unavailable,
  Hint, Bar,
} from '../components/ui.jsx';

/** Strong and Growing read positive; Weakening warns; Declining is bad news. */
const TONE = {
  Strong: 'ok', Growing: 'ok', Stable: 'info', Weakening: 'warn', Declining: 'bad',
};

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
  const error = nowAttr.error || priorAttr.error || nowCre.error || priorCre.error;

  const header = (
    <PageHeader
      title="Organic"
      sub={`${shop.shop_name} · the demand that does not depend on spend`}
      right={<ReportToolbar scope={scope} shop={shop} />}
    />
  );

  if (error) {
    return <>{header}<Notice tone="error">Could not load organic momentum: {error.message}</Notice></>;
  }

  // Nothing asserts a number before it exists: the summary shows its own
  // skeletons rather than a row of zeroes.
  if (loading) {
    return (
      <>
        {header}
        <MetricSummary items={[]} loading />
        <Panel><Skeleton h={240} /></Panel>
      </>
    );
  }

  const a = nowAttr.data;
  if (!a || !Number(a.days_covered)) {
    return (
      <>
        {header}
        <Panel>
          <EmptyState title="No shop data for this window">
            Nothing to compare — this shop has no stored channel data between {scope.start} and {scope.end}.
          </EmptyState>
        </Panel>
      </>
    );
  }

  const m = momentum(
    { attribution: nowAttr.data, creative: nowCre.data },
    { attribution: priorAttr.data, creative: priorCre.data },
  );

  const organic = Number(a.measured_organic_gmv) || 0;
  const paid = Number(a.measured_paid_gmv) || 0;
  const measured = organic + paid;
  const organicShare = measured ? organic / measured : null;

  const creators = numOrNull(nowCre.data?.creators);
  const newVideos = numOrNull(nowCre.data?.new_videos);

  const metrics = [
    {
      label: 'Organic revenue', value: money(organic, cur),
      context: `${pct(organicShare)} of what we can attribute`,
      hint: 'Standard-commission revenue: creators posting because the product sells, not because delivery was bought.',
    },
    {
      label: 'Ad-driven revenue', value: money(paid, cur),
      context: `${pct(organicShare == null ? null : 1 - organicShare)} of what we can attribute`,
      hint: 'Revenue carrying a Shop Ads commission — TikTok billed the sale to paid delivery.',
    },
    {
      label: 'Creators earning',
      value: creators == null ? '—' : creators.toLocaleString(),
      // A dash needs a reason, and "no prior period" is the wrong one when it
      // is the CURRENT window that was never reported.
      context: creators == null
        ? 'not reported for this window'
        : deltaLabel(nowCre.data?.creators, priorCre.data?.creators),
      hint: 'Distinct creators producing revenue in this window. Breadth, not depth.',
    },
    {
      label: 'New videos selling',
      value: newVideos == null ? '—' : newVideos.toLocaleString(),
      context: newVideos == null
        ? 'not reported for this window'
        : deltaLabel(nowCre.data?.new_videos, priorCre.data?.new_videos),
      hint: 'Videos that made their first sale inside the window — the pipeline behind future organic revenue.',
    },
  ];

  return (
    <>
      {header}

      {/* The momentum status, as one line. The label is a pill, not a headline. */}
      <Panel>
        <div className="row" style={{ rowGap: 'var(--s2)' }}>
          {m.label
            ? <span className={`status status-${TONE[m.label] || 'info'}`}>{m.label}</span>
            : <span className="status status-info">No label</span>}
          <span>
            {m.label
              ? <>Organic demand is <strong>{m.label.toLowerCase()}</strong> against the previous {scope.spanDays} days.</>
              : <>Not enough measurable signal to put a label on this.</>}
          </span>
          <Hint text={`Version ${MOMENTUM_VERSION}. A weighted score across six measurable components, comparing ${scope.start}–${scope.end} against the adjacent ${scope.priorStart}–${scope.priorEnd}.`} />
          <span className="spacer" />
          <span className="meta">
            {scope.start} → {scope.end} vs {scope.priorStart} → {scope.priorEnd} — adjacent, equal
            length, no overlap. Score built from {Math.round(m.coverage * 100)}% of its intended components.
          </span>
        </div>
      </Panel>

      {m.reason && <Notice tone="info">{m.reason}</Notice>}

      <MetricSummary items={metrics} source="measured" />

      <Panel title="Organic revenue by day" sub="The measured organic band, day by day.">
        <OrganicChart rows={dailyQ.data} loading={dailyQ.isLoading} error={dailyQ.error} cur={cur} />
      </Panel>

      <Panel
        title="What is driving the score"
        sub="Every component, its weight, and whether it could be measured at all."
        bodyPad={false}
      >
        <div className="tablewrap">
          <table className="data">
            <thead>
              <tr>
                <th className="sticky-l">Component</th>
                <th className="num">Weight</th>
                <th className="num">Previous</th>
                <th className="num">Current</th>
                <th className="num">Change</th>
                <th>Contribution</th>
              </tr>
            </thead>
            <tbody>
              {m.parts.map((p) => (
                <tr key={p.key}>
                  <td className="sticky-l">
                    {p.label}
                    {p.detail && <Hint text={p.detail} />}
                  </td>
                  <td className="num muted">{(p.weight * 100).toFixed(0)}%</td>
                  <td className="num muted">{fmt(p.key, p.prior, cur)}</td>
                  <td className="num">{fmt(p.key, p.current, cur)}</td>
                  <td className="num">
                    {p.change == null
                      ? <Unavailable reason={changeReason(p)} />
                      : (
                        <span className={p.change > 0.02 ? 'trend-up' : p.change < -0.02 ? 'trend-down' : 'muted'}>
                          {p.change > 0.02 ? '▲' : p.change < -0.02 ? '▼' : ''} {p.change > 0 ? '+' : ''}{(p.change * 100).toFixed(0)}%
                        </span>
                      )}
                  </td>
                  <td>
                    {p.available
                      ? (
                        <div className="row" style={{ flexWrap: 'nowrap' }}>
                          <Bar value={Math.abs(p.score)} color={p.score >= 0 ? 'var(--positive)' : 'var(--error)'} />
                          <span className="num">
                            {p.score >= 0 ? '+' : ''}{(p.score * p.weight * 100).toFixed(1)}
                          </span>
                        </div>
                      )
                      : <Unavailable reason="Not measurable in this window. It is excluded and the remaining weights renormalised — it is not scored as zero.">Not scored</Unavailable>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* The two paragraphs that used to bracket this table, on request. */}
        <details className="panel-body" style={{ borderTop: '1px solid var(--divider)' }}>
          <summary style={{ cursor: 'pointer' }}>How this score is built</summary>
          <p className="meta" style={{ margin: '8px 0 0', maxWidth: '78ch' }}>
            A component with no prior value has <strong>no percentage change</strong> — &ldquo;up from
            nothing&rdquo; is not a number, and rendering it as one would let a single first sale read as
            explosive growth. Those rows are excluded and the remaining weights renormalised, which is why
            the coverage figure beside the label matters. Changes are compressed so one viral day cannot pin
            the whole score at its ceiling.
          </p>
          <p className="meta" style={{ margin: '8px 0 0', maxWidth: '78ch' }}>
            Views are permanently unavailable rather than quietly dropped: the video feed reports lifetime
            views, so the same video reports the same number in both windows and a trend computed from them
            would be an artefact of the data, not a fact about the shop.
          </p>
        </details>
      </Panel>

      <Panel
        title="Creators carrying organic revenue"
        sub="Sorted by how much they sell without ad support — the partnerships worth renewing first."
        bodyPad={false}
      >
        <CreatorTable rows={creatorsQ.data} loading={creatorsQ.isLoading} error={creatorsQ.error} cur={cur} />
      </Panel>
    </>
  );
}

/* ── creators ─────────────────────────────────────────────────────────────── */

function CreatorTable({ rows, loading, error, cur }) {
  if (loading) return <div className="panel-body"><Skeleton h={180} /></div>;
  // A failed read is not an empty period: saying "no creators earned" here
  // would report an absence that has not been measured.
  if (error) {
    return (
      <div className="panel-body">
        <Notice tone="error">
          Creator revenue could not be loaded, so this list is missing rather than empty: {error.message}
        </Notice>
      </div>
    );
  }
  if (!rows?.length) {
    return (
      <EmptyState title="No creators earned in this period">
        No affiliate order lines reached us for these dates, so there is no creator revenue to rank.
      </EmptyState>
    );
  }

  const ranked = [...rows]
    .sort((x, y) => Number(y.organic_gmv) - Number(x.organic_gmv))
    .slice(0, 12);

  return (
    <div className="tablewrap">
      <table className="data">
        <thead>
          <tr>
            <th className="sticky-l">Creator</th>
            <th className="num">GMV</th>
            <th className="num">Organic</th>
            <th className="num">Ad-driven</th>
            <th>Organic share</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((r) => (
            <tr key={r.creator_handle}>
              <td className="sticky-l">@{r.creator_handle}</td>
              <td className="num">{moneyExact(r.gmv, cur)}</td>
              <td className="num">{moneyExact(r.organic_gmv, cur)}</td>
              <td className="num">{moneyExact(r.paid_gmv, cur)}</td>
              <td>
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <Bar value={r.organic_share == null ? null : Number(r.organic_share)}
                    color="var(--series-organic)" />
                  {/* organic_share comes from SQL with its numerator coalesced,
                      so a creator with real organic revenue and NO ad-driven
                      revenue reads 100% rather than a dash. `sum() FILTER`
                      returns NULL when nothing matches, and NULL/x is NULL —
                      which is what put a dash on seven Biostime creators whose
                      organic revenue equalled their total. */}
                  <span className="num">
                    {r.organic_share == null
                      ? <Unavailable reason="No classified affiliate revenue for this creator in this window, so there is no total to divide by." />
                      : pct(Number(r.organic_share), 0)}
                  </span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── helpers (unchanged arithmetic) ───────────────────────────────────────── */

function deltaLabel(current, prior) {
  const c = Number(current); const p = Number(prior);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return 'no prior period to compare';
  const d = (c - p) / p;
  return `${d > 0 ? '+' : ''}${(d * 100).toFixed(0)}% vs previous period`;
}

/**
 * Why a component has no percentage change — the reason that is actually true
 * for THAT component. One blanket "no value in the previous period" was wrong
 * for the views row, which has no change because views are lifetime totals.
 */
function changeReason(p) {
  if (p.key === 'views') {
    return 'Views are reported as a lifetime total, so the same video reports the same number in both windows and no change can be computed from them.';
  }
  if (p.current == null || p.prior == null) {
    return 'This component was not reported in one of the two windows, so there is nothing to compare it against.';
  }
  return 'The previous period was zero, so there is no percentage change — up from nothing is not a number.';
}

function fmt(key, v, cur) {
  if (v == null) return <span className="muted">—</span>;
  if (key === 'organic_gmv' || key === 'affiliate_gmv') return money(v, cur);
  return Number(v).toLocaleString();
}

function OrganicChart({ rows, loading, error, cur }) {
  if (loading) return <Skeleton h={220} />;
  if (error) {
    return (
      <Notice tone="error">
        The daily channel series could not be loaded, so no line is drawn — this is a failed read, not a
        flat period: {error.message}
      </Notice>
    );
  }
  const data = (rows || []).map((d) => ({
    day: String(d.day).slice(5),
    Organic: Number(d.measured_organic_gmv) || 0,
    'Ad-driven': Number(d.measured_paid_gmv) || 0,
  }));
  if (!data.length) {
    return (
      <EmptyState title="No daily data in this window">
        Nothing has been collected for these dates, so there is no series to draw.
      </EmptyState>
    );
  }

  return (
    <div style={{ height: 250 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 8, left: 4, bottom: 0 }}>
          <CartesianGrid stroke="var(--divider)" vertical={false} />
          <XAxis dataKey="day" tick={{ fontSize: 12, fill: 'var(--text-2)' }}
            tickLine={false} axisLine={{ stroke: 'var(--divider)' }} minTickGap={18} />
          <YAxis tick={{ fontSize: 12, fill: 'var(--text-2)' }} tickLine={false} axisLine={false}
            tickFormatter={(v) => money(v, cur)} width={64} />
          <Tooltip formatter={(v, n) => [moneyExact(v, cur), n]}
            contentStyle={{
              background: 'var(--surface)', border: '1px solid var(--divider)',
              borderRadius: 'var(--r-panel)', fontSize: 13, boxShadow: 'var(--shadow-pop)',
            }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Area type="monotone" dataKey="Organic" stackId="1" stroke="var(--series-organic)"
            fill="var(--series-organic)" fillOpacity={0.32} />
          <Area type="monotone" dataKey="Ad-driven" stackId="1" stroke="var(--series-paid)"
            fill="var(--series-paid)" fillOpacity={0.28} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
