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

      <Note tone="info">
        <div>
          <strong>Marginal ROAS is not on this page yet.</strong>
          <div style={{ marginTop: 4 }}>
            &ldquo;If I spend 20% more, what do I get?&rdquo; needs roughly 30 days in which spend genuinely
            moved. Fitting a spend-response curve to a flat budget produces a number with no information in
            it, so that model stays off until the history can support it — and will say
            &ldquo;insufficient variation&rdquo; rather than guess when it cannot.
          </div>
        </div>
      </Note>
    </div>
  );
}
