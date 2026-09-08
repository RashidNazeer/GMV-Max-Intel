// Daily revenue by channel, with reconciliation exceptions marked.
//
// The chart used to stack six segments to a tidy 100% every day, because the
// overflow bucket was clamped to zero before it got here. Days where the
// components do not add up now carry a mark, and the caption says how many.
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceDot,
} from 'recharts';
import { Card, Skeleton, money, moneyExact } from './ui.jsx';

const SERIES = [
  ['Ad-driven', 'var(--paid)'],
  ['Organic', 'var(--organic)'],
  ['Affiliate (no line data)', 'var(--border-default)'],
  ['Affiliate (excess)', 'var(--danger)'],
  ['Seller video', 'var(--text-muted)'],
  ['LIVE', 'var(--text-muted)'],
  ['Product card', 'var(--surface-3)'],
];

export default function ChannelChart({ rows, loading, cur }) {
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

  return (
    <Card
      title="Daily revenue by channel"
      sub={bad.length
        ? `${bad.length} of ${data.length} days do not reconcile against total shop GMV — marked in red below.`
        : 'Stacked to the shop total. The coloured band is the part that carries a commission signal.'}
    >
      {loading ? <Skeleton h={260} /> : (
        <>
          <div style={{ height: 290 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 6, right: 8, left: 4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                  tickLine={false} axisLine={false} minTickGap={18} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false}
                  tickFormatter={(v) => money(v, cur)} width={62} />
                <Tooltip
                  formatter={(v, n) => [moneyExact(v, cur), n]}
                  labelFormatter={(l) => {
                    const row = data.find((d) => d.day === l);
                    return row?._status === 'exception'
                      ? `${l} — does not reconcile (${moneyExact(row._gap, cur)})`
                      : l;
                  }}
                  contentStyle={{ background: 'var(--surface-1)', border: '1px solid var(--border-default)', borderRadius: 10, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 11.5 }} />
                {SERIES.map(([k, c]) => (
                  <Area key={k} type="monotone" dataKey={k} stackId="1" stroke={c} fill={c}
                    fillOpacity={k === 'Ad-driven' || k === 'Organic' ? 0.32 : k === 'Affiliate (excess)' ? 0.5 : 0.16} />
                ))}
                {bad.map((d) => (
                  <ReferenceDot key={d.day} x={d.day} y={0} r={4}
                    fill="var(--danger)" stroke="none" ifOverflow="extendDomain" />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
          {bad.length > 0 && (
            <p className="muted" style={{ fontSize: 11.5, marginTop: 10, marginBottom: 0, lineHeight: 1.55 }}>
              <strong>Affiliate (excess)</strong> is revenue our order lines hold that Seller Center&rsquo;s own
              affiliate figure does not. It used to be deleted so the stack would total exactly 100% — which
              made a real disagreement between two sources look like perfect agreement. It is shown because
              it is real.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
