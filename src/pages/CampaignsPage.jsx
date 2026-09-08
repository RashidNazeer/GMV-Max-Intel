// Campaigns — a list whose rows open.
//
// Campaign names were plain text. Clicking one did nothing, and the page showed
// aggregate settings and shop-wide scenarios with no campaign-specific action
// at all. Each row is now a link to a real route.
import { useOutletContext, useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listCampaigns, detectedSettingChanges, shopPaidRoas, money, fixed, pct } from '../lib/api.js';
import { scopedTo } from '../lib/scope.js';
import { Card, Stat, Note, Skeleton, Empty, Basis, Hint, SimulatedBanner } from '../components/ui.jsx';

export default function CampaignsPage() {
  const { shop, scope } = useOutletContext();
  const [params] = useSearchParams();
  const cur = shop.currency || 'USD';

  const campaignsQ = useQuery({ queryKey: ['camps', shop.id], queryFn: () => listCampaigns(shop.id) });
  const roasQ = useQuery({
    queryKey: ['roas', shop.id, scope.start, scope.end],
    queryFn: () => shopPaidRoas(shop.id, scope.start, scope.end),
  });
  const changesQ = useQuery({ queryKey: ['changes', shop.id], queryFn: () => detectedSettingChanges(shop.id) });

  const campaigns = campaignsQ.data || [];
  const r = roasQ.data;

  if (campaignsQ.isLoading) return <div className="card pad"><Skeleton h={200} /></div>;

  if (!campaigns.length) {
    return (
      <Empty title="No GMV Max campaigns for this shop">
        Reacher reports this shop&rsquo;s <code>tiktok_for_business</code> integration as
        <strong> disconnected</strong>, so no campaign, spend or settings data can arrive. Connecting the
        ad account is done in TikTok by whoever administers the Business Center — it is not something a
        different date range or another sync will change.
        <div style={{ marginTop: 10 }}>
          Revenue on every other page is still measured from real orders. What is missing here is the
          spend side: return on spend, budget utilisation and the spend-response model all need it.
        </div>
      </Empty>
    );
  }

  const simulated = r?.is_simulated === true;

  return (
    <div className="grid" style={{ gap: 16 }}>
      {simulated && <SimulatedBanner />}

      {r && (
        <div className="grid g4">
          <Stat k="Spend" basis={simulated ? 'simulated' : 'measured'} v={money(r.spend, cur)}
            sub={`${r.days_with_spend} days · ${r.campaigns} campaign${Number(r.campaigns) === 1 ? '' : 's'}`} />
          <Stat k="GMV Max ROI" basis={simulated ? 'simulated' : 'measured'} v={fixed(r.reported_roi)}
            sub={`on ${money(r.reported_revenue, cur)} claimed`}
            hint="GMV Max's own reported return — the ceiling of the band." />
          <Stat k="Proven return" tone="paid" basis={simulated ? 'simulated' : 'measured'} v={fixed(r.verified_roas)}
            sub={`${money(r.verified_paid_gmv, cur)} verified`}
            hint="Revenue whose commission proves the ads drove it, over ALL spend. The floor of the band." />
          <Stat k="Unevidenced" tone="warning" basis={simulated ? 'simulated' : 'measured'}
            v={money(r.unverified_revenue, cur)}
            sub={r.unverified_share == null ? '—' : `${pct(r.unverified_share)} of the claim`} />
        </div>
      )}

      <Card title="Campaigns" pad={false} sub="Open a campaign for its own recommendation, evidence and scenario.">
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Status</th>
                <th>Type</th>
                <th className="num">Target ROI<Hint text="A delivery setting: how hard GMV Max bids. It is not a break-even target and lowering it is not a general scaling instruction." /></th>
                <th className="num">Daily budget</th>
                <th>Source</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.campaign_id}>
                  <td className="tight">
                    <Link className="lnk" to={scopedTo(`/campaigns/${encodeURIComponent(c.campaign_id)}`, params)}>
                      {c.campaign_name || c.campaign_id}
                    </Link>
                  </td>
                  <td className="tight">
                    <span className={`chip chip-${c.status === 'ENABLE' ? 'ok' : 'info'}`}>
                      {c.status === 'ENABLE' ? 'Active' : c.status === 'DISABLE' ? 'Inactive' : c.status}
                    </span>
                  </td>
                  <td className="tight muted">
                    {c.campaign_type === 'PRODUCT_GMV_MAX' || c.campaign_type === 'PRODUCT'
                      ? 'Product GMV Max' : (c.campaign_type || '—')}
                  </td>
                  <td className="num tight">{c.target_roas == null ? '—' : Number(c.target_roas).toFixed(2)}</td>
                  <td className="num tight">{c.daily_budget == null ? '—' : money(c.daily_budget, c.currency || cur)}</td>
                  <td className="tight"><Basis kind={c.data_source === 'simulated' ? 'simulated' : 'measured'} /></td>
                  <td className="tight">
                    <Link className="lnk" to={scopedTo(`/campaigns/${encodeURIComponent(c.campaign_id)}`, params)}>Open →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Change history"
        sub="Detected by comparing consecutive settings snapshots. A change is the only thing that makes an outcome interpretable."
        pad={false}>
        {changesQ.isLoading ? <div className="pad"><Skeleton h={90} /></div> : (
          (changesQ.data || []).length ? (
            <div className="scroll">
              <table>
                <thead>
                  <tr><th>When</th><th>Campaign</th><th>Field</th><th className="num">From</th><th className="num">To</th></tr>
                </thead>
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
                <strong>No change history yet — and none can exist before 8 September 2026.</strong> Reacher
                exposes no change feed for GMV Max, and its settings endpoint returns nulls, so the past is
                not recoverable. Append-only snapshots start from the first sync after that date and the
                record builds forward from there. Nothing here is reconstructed.
              </p>
            </div>
          )
        )}
      </Card>
    </div>
  );
}
