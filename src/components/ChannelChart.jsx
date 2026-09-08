// Daily revenue by channel, with reconciliation exceptions marked.
//
// The chart used to stack six segments to a tidy 100% every day, because the
// overflow bucket was clamped to zero before it got here. Days where the
// components do not add up now carry a mark, and the caption says how many.
//
// Colours come from the --series-* tokens, so a channel is the same colour
// here, in the mix bar and in the channel table. Colour carries information —
// which channel — so it stays chromatic; nothing else here introduces a value
// of its own.
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceDot,
} from 'recharts';
import { Panel, Skeleton, EmptyState, money, moneyExact } from './ui.jsx';

const SERIES = [
  ['Ad-driven', 'var(--series-paid)'],
  ['Organic', 'var(--series-organic)'],
  ['Affiliate (no line data)', 'var(--series-gap)'],
  ['Affiliate (excess)', 'var(--series-excess)'],
  ['Seller video', 'var(--series-seller)'],
  ['LIVE', 'var(--series-live)'],
  ['Product card', 'var(--series-card)'],
];

export default function ChannelChart({ rows, loading, cur, title = 'Daily revenue by channel' }) {
  const data = (rows || []).map((d) => ({
    day: String(d.day).slice(5),
    fullDay: d.day,
    'Ad-driven': Number(d.measured_paid_gmv) || 0,
    Organic: Number(d.measured_organic_gmv) || 0,
    'Affiliate (no line data)': Number(d.affiliate_unmeasured_gmv) || 0,
    'Affiliate (excess)': Number(d.affiliate_overflow_gmv) || 0,
    'Seller video': Number(d.seller_video_gmv) || 0,
    LIVE: Number(d.live_gmv) || 0,
    'Product card': Number(d.product_card_gmv) || 0,
    _gap: Number(d.reconciliation_gap) || 0,
    _status: d.reconciliation_status,
  }));

  const bad = data.filter((d) => d._status === 'exception');

  // While the days are still arriving, say nothing about them: "0 of 0 days do
  // not reconcile" is a claim, and not one this component can make yet.
  const sub = loading
    ? 'Stacked to the shop total, one day at a time.'
    : bad.length
      ? `${bad.length} of ${data.length} days do not reconcile against total shop GMV — marked below the axis.`
      : 'Stacked to the shop total. The coloured band is the part that carries a commission signal.';

  return (
    <Panel title={title} sub={sub} bodyPad={false}>
      <div className="panel-body">
        {loading ? <Skeleton h={290} /> : !data.length ? (
          <EmptyState title="No daily channel data in this window">
            Nothing has been collected for these dates, so there is no series to draw.
          </EmptyState>
        ) : (
          <div style={{ height: 290 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 6, right: 8, left: 4, bottom: 0 }}>
                <CartesianGrid stroke="var(--divider)" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 12, fill: 'var(--text-2)' }}
                  tickLine={false} axisLine={{ stroke: 'var(--divider)' }} minTickGap={18} />
                <YAxis tick={{ fontSize: 12, fill: 'var(--text-2)' }} tickLine={false} axisLine={false}
                  tickFormatter={(v) => money(v, cur)} width={68} />
                <Tooltip
                  formatter={(v, n) => [moneyExact(v, cur), n]}
                  labelFormatter={(l) => {
                    const row = data.find((d) => d.day === l);
                    return row?._status === 'exception'
                      ? `${l} — does not reconcile (${moneyExact(row._gap, cur)})`
                      : l;
                  }}
                  contentStyle={{
                    background: 'var(--surface)', border: '1px solid var(--divider)',
                    borderRadius: 'var(--r-panel)', fontSize: 13, boxShadow: 'var(--shadow-pop)',
                  }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {SERIES.map(([k, c]) => (
                  <Area key={k} type="monotone" dataKey={k} stackId="1" stroke={c} fill={c}
                    fillOpacity={k === 'Ad-driven' || k === 'Organic' ? 0.32 : k === 'Affiliate (excess)' ? 0.5 : 0.16} />
                ))}
                {/* The reconciliation marks. A day whose components do not add
                    up is not quietly redrawn as if they did. */}
                {bad.map((d) => (
                  <ReferenceDot key={d.day} x={d.day} y={0} r={4}
                    fill="var(--series-excess)" stroke="none" ifOverflow="extendDomain" />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {!loading && bad.length > 0 && (
        <details className="panel-body" style={{ borderTop: '1px solid var(--divider)' }}>
          <summary style={{ cursor: 'pointer' }}>What the marks and the excess band mean</summary>
          <p className="meta" style={{ margin: '8px 0 0', maxWidth: '78ch' }}>
            <strong>Affiliate (excess)</strong> is revenue our order lines hold that Seller Center&rsquo;s
            own affiliate figure does not. It used to be deleted so the stack would total exactly 100% —
            which made a real disagreement between two sources look like perfect agreement. It is shown
            because it is real. A mark under a day says that day&rsquo;s components do not sum to its shop
            total; the amount is in the tooltip.
          </p>
        </details>
      )}
    </Panel>
  );
}
