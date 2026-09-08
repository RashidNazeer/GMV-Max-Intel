// Campaigns — a list whose rows open.
//
// Campaign names were plain text. Clicking one did nothing, and the page showed
// aggregate settings and shop-wide scenarios with no campaign-specific action
// at all. Each row is now a link to a real route.
//
// ── WHAT THE REDESIGN CHANGES ──────────────────────────────────────────────
// Four floating stat cards became ONE metric region, so provenance is stated
// once for the region instead of four times on four values that share a single
// source. The per-row "Source" column went the same way: a stamp on every line
// is a badge nobody reads, so the basis is stated once and only a campaign that
// differs from it is tagged. The two tables use the shared `table.data` shape
// with a sticky identity column, and a client-side name filter sits in the
// panel head, where a filter belongs — not above the page as a second heading.
//
// Nothing about the data changed: same queries, same keys, same arithmetic.
import { useMemo, useState } from 'react';
import { useOutletContext, useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listCampaigns, detectedSettingChanges, shopPaidRoas, money, fixed, pct } from '../lib/api.js';
import { scopedTo } from '../lib/scope.js';
import ReportToolbar from '../components/ReportToolbar.jsx';
import {
  Panel, PageHeader, MetricSummary, Notice, Skeleton, EmptyState, SourceTag, Hint,
} from '../components/ui.jsx';

export default function CampaignsPage() {
  const { shop, scope } = useOutletContext();
  const [params] = useSearchParams();
  const cur = shop.currency || 'USD';
  const [q, setQ] = useState('');

  const campaignsQ = useQuery({ queryKey: ['camps', shop.id], queryFn: () => listCampaigns(shop.id) });
  const roasQ = useQuery({
    queryKey: ['roas', shop.id, scope.start, scope.end],
    queryFn: () => shopPaidRoas(shop.id, scope.start, scope.end),
  });
  const changesQ = useQuery({ queryKey: ['changes', shop.id], queryFn: () => detectedSettingChanges(shop.id) });

  const campaigns = campaignsQ.data || [];
  const r = roasQ.data;

  const header = (
    <PageHeader
      title="Campaigns"
      sub={`${shop.shop_name} · current settings. Spend figures cover ${scope.start} → ${scope.end}.`}
      right={<ReportToolbar scope={scope} shop={shop} />}
    />
  );

  // A name filter over the list already in hand — no refetch, no query key.
  const term = q.trim().toLowerCase();
  const shown = useMemo(
    () => (term
      ? campaigns.filter((c) => String(c.campaign_name || c.campaign_id).toLowerCase().includes(term))
      : campaigns),
    [campaigns, term],
  );

  if (campaignsQ.isLoading) {
    return (
      <>
        {header}
        <Panel><Skeleton h={220} /></Panel>
      </>
    );
  }

  // A failed read is not an absence of campaigns. Falling through to the empty
  // state below would tell the reader the ad account is disconnected — a claim
  // the page has no evidence for when the request itself never returned.
  if (campaignsQ.error) {
    return (
      <>
        {header}
        <Notice tone="error">Campaigns could not be loaded: {campaignsQ.error.message}</Notice>
      </>
    );
  }

  if (!campaigns.length) {
    return (
      <>
        {header}
        <Panel>
          <EmptyState title="No GMV Max campaigns for this shop">
            Reacher reports this shop&rsquo;s <code>tiktok_for_business</code> integration as
            <strong> disconnected</strong>, so no campaign, spend or settings data can arrive. Connecting the
            ad account is done in TikTok by whoever administers the Business Center — it is not something a
            different date range or another sync will change.
          </EmptyState>
        </Panel>
        <Notice tone="info">
          Revenue on every other page is still measured from real orders. What is missing here is the
          spend side: return on spend, budget utilisation and the spend-response model all need it.
        </Notice>
      </>
    );
  }

  const simulated = r?.is_simulated === true;

  // Provenance belongs to the region, not to every line. A "Measured" stamp on
  // every row is a badge nobody reads, so the basis is stated once and only a
  // campaign that genuinely differs from it carries its own tag. If every
  // campaign differs, that is a property of the region again, so it is said
  // once in the panel head instead of on each row.
  const regionBasis = simulated ? 'simulated' : 'measured';
  const rowBasis = (c) => (c.data_source === 'simulated' ? 'simulated' : 'measured');
  const offBasis = campaigns.filter((c) => rowBasis(c) !== regionBasis);
  const uniformlyOff = offBasis.length > 0 && offBasis.length === campaigns.length;
  const panelBasis = uniformlyOff ? rowBasis(campaigns[0]) : null;
  const tagRow = (c) => !uniformlyOff && rowBasis(c) !== regionBasis;

  // One source for the whole region, so no value carries its own badge: spend,
  // the reported figure and the verified figure all come from the same read.
  const metrics = !r ? [] : [
    {
      label: 'Spend', value: money(r.spend, cur),
      context: `${r.days_with_spend} days · ${r.campaigns} campaign${Number(r.campaigns) === 1 ? '' : 's'}`,
    },
    {
      label: 'GMV Max ROI', value: fixed(r.reported_roi),
      context: `on ${money(r.reported_revenue, cur)} claimed`,
      hint: "GMV Max's own reported return — the ceiling of the band.",
    },
    {
      // PROTECTED WORDING — moved, not reworded.
      label: 'Proven return', value: fixed(r.verified_roas),
      context: `${money(r.verified_paid_gmv, cur)} verified`,
      hint: 'Revenue whose commission proves the ads drove it, over ALL spend. The floor of the band.',
    },
    {
      label: 'Unevidenced', value: money(r.unverified_revenue, cur),
      context: r.unverified_share == null ? '—' : `${pct(r.unverified_share)} of the claim`,
      hint: 'Revenue GMV Max claims that carries no Shop Ads commission line. It is not proof of waste — only revenue the commission record cannot vouch for.',
    },
  ];

  return (
    <>
      {header}

      {roasQ.isLoading
        ? <MetricSummary items={[]} loading />
        : r
          ? <MetricSummary items={metrics} source={regionBasis} />
          : null}

      {simulated && (
        <Notice tone="warn">
          Ad spend for this shop is simulated, so every figure above it derives from generated
          numbers. Revenue everywhere else is still measured from real orders.
        </Notice>
      )}

      <Panel
        title="All campaigns"
        sub="Open a campaign for its own recommendation, evidence and scenario."
        right={panelBasis ? <SourceTag kind={panelBasis} /> : undefined}
        bodyPad={false}
      >
        <div className="panel-body" style={{ paddingTop: 12, paddingBottom: 12, borderBottom: '1px solid var(--divider)' }}>
          <div className="toolbar">
            <input
              className="input" type="search" value={q} aria-label="Filter campaigns by name"
              placeholder="Filter by campaign name"
              onChange={(e) => setQ(e.target.value)}
              style={{ minWidth: 240, flex: '1 1 240px' }}
            />
            <span className="spacer" />
            <span className="meta">
              {term
                ? `${shown.length.toLocaleString()} of ${campaigns.length.toLocaleString()} campaigns`
                : `${campaigns.length.toLocaleString()} campaign${campaigns.length === 1 ? '' : 's'}`}
            </span>
            {term && <button className="btn btn-sm" onClick={() => setQ('')}>Clear filter</button>}
          </div>
        </div>

        {!shown.length ? (
          <EmptyState
            title="No campaigns match this name"
            action={<button className="btn" onClick={() => setQ('')}>Clear filter</button>}
          >
            The filter reads the campaign names already loaded for this shop. Nothing was refetched, so
            a broader term will find them again.
          </EmptyState>
        ) : (
          <div className="tablewrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="sticky-l">Campaign</th>
                  <th>Status</th>
                  <th>Type</th>
                  <th className="num">
                    Target ROI
                    <Hint text="A delivery setting: how hard GMV Max bids. It is not a break-even target and lowering it is not a general scaling instruction." />
                  </th>
                  <th className="num">Daily budget</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.campaign_id}>
                    <td className="sticky-l">
                      <Link className="identity" to={scopedTo(`/campaigns/${encodeURIComponent(c.campaign_id)}`, params)}>
                        {c.campaign_name || c.campaign_id}
                      </Link>
                      {tagRow(c) && <> <SourceTag kind={rowBasis(c)} /></>}
                    </td>
                    <td>
                      <span className={`status status-${c.status === 'ENABLE' ? 'ok' : 'info'}`}>
                        {c.status === 'ENABLE' ? 'Active' : c.status === 'DISABLE' ? 'Inactive' : c.status}
                      </span>
                    </td>
                    <td className="muted">
                      {/^PRODUCT/.test(c.campaign_type || '') ? 'Product GMV Max' : (c.campaign_type || '—')}
                    </td>
                    <td className="num">{c.target_roas == null ? '—' : Number(c.target_roas).toFixed(2)}</td>
                    <td className="num">{c.daily_budget == null ? '—' : money(c.daily_budget, c.currency || cur)}</td>
                    <td className="num">
                      <Link className="btn btn-sm" to={scopedTo(`/campaigns/${encodeURIComponent(c.campaign_id)}`, params)}>
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Change history"
        sub="Detected by comparing consecutive settings snapshots. A change is the only thing that makes an outcome interpretable."
        bodyPad={false}
      >
        {changesQ.isLoading ? (
          <div className="panel-body"><Skeleton h={90} /></div>
        ) : changesQ.error ? (
          <div className="panel-body">
            <Notice tone="error">
              Change history could not be read, so this panel cannot say whether any settings changed:
              {' '}{changesQ.error.message}
            </Notice>
          </div>
        ) : (changesQ.data || []).length ? (
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
                {changesQ.data.map((c, i) => (
                  <tr key={i}>
                    <td className="sticky-l muted">{new Date(c.detected_at).toLocaleString()}</td>
                    <td>{c.campaign_name || c.campaign_id}</td>
                    <td className="muted">{c.field === 'target_roi' ? 'Target ROI' : 'Daily budget'}</td>
                    <td className="num muted">{c.old_value == null ? '—' : Number(c.old_value).toFixed(2)}</td>
                    <td className="num"><strong>{c.new_value == null ? '—' : Number(c.new_value).toFixed(2)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No change history yet — and none can exist before 8 September 2026">
            Reacher exposes no change feed for GMV Max, and its settings endpoint returns nulls, so the
            past is not recoverable. Append-only snapshots start from the first sync after that date and
            the record builds forward from there. Nothing here is reconstructed.
          </EmptyState>
        )}
      </Panel>
    </>
  );
}
