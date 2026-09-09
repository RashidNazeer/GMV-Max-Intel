// The Overview chart: daily Shop GMV by default, up to two compatible metrics.
//
// The multichannel attribution stack that used to sit here belongs on
// Attribution — it answers "where did revenue come from", which is not the
// question the Overview is for. This answers "what happened, day by day".
//
// Two rules it holds:
//   * A missing day is a BREAK in the line, never an interpolated zero. Those
//     are different claims and only one of them is true.
//   * A second axis names its own metric and unit, or it is not drawn.
import { useState } from 'react';
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { useQuery } from '@tanstack/react-query';
import { shopGmvDaily, money, moneyExact } from '../lib/api.js';
import { Panel, Skeleton, EmptyState } from './ui.jsx';

// Only metrics that exist for these shops, with their real units.
const METRICS = {
  shop_gmv:  { label: 'Shop GMV',        unit: 'currency', colour: 'var(--series-organic)', kind: 'line' },
  spend:     { label: 'Ad spend',        unit: 'currency', colour: 'var(--series-gap)',     kind: 'bar' },
  reported:  { label: 'GMV Max revenue', unit: 'currency', colour: 'var(--series-seller)',  kind: 'line' },
  verified:  { label: 'Verified ad-driven', unit: 'currency', colour: 'var(--series-paid)', kind: 'line' },
  orders:    { label: 'Orders',          unit: 'count',    colour: 'var(--series-card)',    kind: 'line' },
};

export default function PerformanceChart({ shop, scope, rows, loading, cur }) {
  const [picked, setPicked] = useState(['shop_gmv', 'spend']);

  const gmvQ = useQuery({
    queryKey: ['gmvdaily', shop.id, scope.start, scope.end],
    queryFn: () => shopGmvDaily(shop.id, scope.start, scope.end),
  });

  const busy = loading || gmvQ.isLoading;

  // Join spend and shop GMV on the day. A day present in one and not the other
  // keeps a null on the missing side rather than a zero.
  const byDay = new Map();
  for (const d of gmvQ.data || []) {
    byDay.set(d.day, { day: d.day, shop_gmv: num(d.total_gmv), orders: num(d.orders) });
  }
  for (const d of rows || []) {
    const e = byDay.get(d.day) || { day: d.day };
    e.spend = num(d.spend);
    e.reported = num(d.reported_revenue);
    e.verified = num(d.measured_paid_gmv);
    byDay.set(d.day, e);
  }
  const data = [...byDay.values()]
    .sort((a, b) => String(a.day).localeCompare(String(b.day)))
    .map((d) => ({ ...d, label: String(d.day).slice(5) }));

  const toggle = (key) => setPicked((p) => {
    if (p.includes(key)) return p.length === 1 ? p : p.filter((k) => k !== key);
    return p.length < 2 ? [...p, key] : [p[1], key];   // keep at most two
  });

  // TWO AXES WHEN THE SCALES DIFFER, not only when the units do.
  //
  // Shop GMV runs six to twelve thousand a day against roughly seven hundred of
  // ad spend. Both are currency, so a units-only rule put them on one axis and
  // the spend bars flattened into an unreadable smear along the baseline. Seen
  // in a screenshot — no assertion asks whether a series is legible.
  const units = new Set(picked.map((k) => METRICS[k].unit));
  const peak = (k) => Math.max(0, ...data.map((d) => Number(d[k]) || 0));
  const scaleGap = picked.length === 2 && (() => {
    const a = peak(picked[0]);
    const b = peak(picked[1]);
    if (!a || !b) return false;
    return Math.max(a, b) / Math.min(a, b) >= 4;
  })();
  const twoAxes = units.size > 1 || scaleGap;
  const missing = data.filter((d) => d.shop_gmv == null).length;

  return (
    <Panel
      title="Performance"
      sub={`Daily, ${scope.start} → ${scope.end}. Select up to two metrics.`}
      right={
        <div className="row" style={{ gap: 4 }}>
          {Object.entries(METRICS).map(([k, m]) => (
            <button key={k}
              className={`btn btn-sm${picked.includes(k) ? ' btn-primary' : ''}`}
              aria-pressed={picked.includes(k)}
              onClick={() => toggle(k)}>{m.label}</button>
          ))}
        </div>
      }
    >
      {busy ? <Skeleton h={220} /> : !data.length ? (
        <EmptyState title="No daily data in this window">
          Nothing has been collected for these dates, so there is no series to draw.
        </EmptyState>
      ) : (
        <>
          <div style={{ height: 200 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--divider)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 12, fill: 'var(--text-2)' }}
                  tickLine={false} axisLine={{ stroke: 'var(--divider)' }} minTickGap={20} />
                <YAxis yAxisId="left" tick={{ fontSize: 12, fill: 'var(--text-2)' }}
                  tickLine={false} axisLine={false} width={64}
                  tickFormatter={(v) => (leftUnit(picked) === 'currency' ? money(v, cur) : v.toLocaleString())} />
                {twoAxes && (
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12, fill: 'var(--text-2)' }}
                    tickLine={false} axisLine={false} width={64}
                    tickFormatter={(v) => (rightUnit(picked) === 'currency' ? money(v, cur) : v.toLocaleString())} />
                )}
                <Tooltip
                  contentStyle={{
                    background: 'var(--surface)', border: '1px solid var(--divider)',
                    borderRadius: 'var(--r-panel)', fontSize: 13, boxShadow: 'var(--shadow-pop)',
                  }}
                  formatter={(v, name) => {
                    const key = Object.keys(METRICS).find((k) => METRICS[k].label === name);
                    if (v == null) return ['unavailable', name];
                    return [METRICS[key]?.unit === 'currency' ? moneyExact(v, cur) : Number(v).toLocaleString(), name];
                  }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {picked.map((k, i) => {
                  const m = METRICS[k];
                  const axis = twoAxes && i === 1 ? 'right' : 'left';
                  return m.kind === 'bar'
                    ? <Bar key={k} yAxisId={axis} dataKey={k} name={m.label} fill={m.colour} radius={[2, 2, 0, 0]} />
                    : <Line key={k} yAxisId={axis} dataKey={k} name={m.label} stroke={m.colour}
                        strokeWidth={2} dot={false} connectNulls={false} />;
                })}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {(twoAxes || missing > 0) && <p className="meta" style={{ margin: '8px 0 0' }}>
            {twoAxes
              ? `Left axis: ${METRICS[picked[0]].label} (${unitWord(METRICS[picked[0]].unit, cur)}). `
                + `Right axis: ${METRICS[picked[1]].label} (${unitWord(METRICS[picked[1]].unit, cur)})`
                + `${units.size === 1 ? ', on its own scale so both series stay readable' : ''}.`
              : `Axis: ${unitWord(METRICS[picked[0]].unit, cur)}.`}
            {missing > 0 && ` ${missing} day${missing === 1 ? '' : 's'} have no shop data — the line breaks rather than dropping to zero.`}
          </p>}
        </>
      )}
    </Panel>
  );
}

const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const leftUnit = (p) => METRICS[p[0]].unit;
const rightUnit = (p) => METRICS[p[1] ?? p[0]].unit;
const unitWord = (u, cur) => (u === 'currency' ? cur : 'count');
