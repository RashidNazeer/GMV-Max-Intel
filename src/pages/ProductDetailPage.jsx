// Product detail — the commercial context behind a product's numbers.
//
// This route did not exist. The Products table was a dead end: it could tell
// you a product converts at a third of the shop rate and then offer nothing to
// look at. Every row now opens here, with the funnel, the commercial state, and
// the creatives actually selling it.
//
// COMMERCE IS MOSTLY UNAVAILABLE and says so. Reacher returns discount_pct null
// on every product and original_price null on every SKU, so there is no
// reference price, no discount depth, and no seller-funded versus TikTok-funded
// split. The tab names the missing fields rather than rendering a confident 0%.
//
// ── WHAT THE REDESIGN CHANGED HERE ─────────────────────────────────────────
// Five floating stat cards became ONE metric region. The bespoke `.funnel`
// markup became an ordinary data table, so the three steps line up with every
// other number on the page. The four-line "price history cannot be shown"
// paragraph became a one-sentence notice with the reasoning behind a
// disclosure — every field name it named is still on the page. No query, no
// query key and no calculation moved.
import { useState } from 'react';
import { useParams, useOutletContext, useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  ComposedChart, Bar as ChartBar,
} from 'recharts';
import {
  shopProducts, shopProductStats, shopTopVideos, listCampaigns,
  money, moneyExact, pct, numOrNull,
} from '../lib/api.js';
import { supabase } from '../lib/supabase.js';
import { scopedTo } from '../lib/scope.js';
import { addDays } from '../lib/window.js';
import CreativeTable from '../components/CreativeTable.jsx';
import ReportToolbar from '../components/ReportToolbar.jsx';
import {
  Panel, PageHeader, MetricSummary, Notice, Skeleton, EmptyState, Thumb, Bar, Unavailable,
} from '../components/ui.jsx';

const rate = (v, d = 2) => (v == null ? '—' : `${(Number(v) * 100).toFixed(d)}%`);

const TABS = [
  { id: 'funnel', label: 'Funnel' },
  { id: 'commerce', label: 'Commerce' },
  { id: 'creatives', label: 'Creatives' },
];

/** An explanation that is worth keeping but not worth a full-width paragraph. */
function Disclosure({ summary, children }) {
  return (
    <details>
      <summary className="meta" style={{ cursor: 'pointer' }}>{summary}</summary>
      <div className="meta" style={{ marginTop: 8, maxWidth: '72ch' }}>{children}</div>
    </details>
  );
}

export default function ProductDetailPage() {
  const { productId } = useParams();
  const { shop, scope } = useOutletContext();
  const [params] = useSearchParams();
  const [tab, setTab] = useState('funnel');
  const cur = shop.currency || 'USD';

  const listQ = useQuery({
    queryKey: ['product', shop.id, scope.start, scope.end, productId],
    queryFn: () => shopProducts(shop.id, scope.start, scope.end, { limit: 1, ids: [productId] }),
  });
  const statsQ = useQuery({
    queryKey: ['pstats', shop.id, scope.start, scope.end],
    queryFn: () => shopProductStats(shop.id, scope.start, scope.end),
  });
  const dailyQ = useQuery({
    queryKey: ['pdaily', shop.id, scope.start, scope.end, productId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('product_daily_metrics')
        .select('day, gmv, orders, impressions, clicks, funnel_orders, refunds')
        .eq('shop_id', shop.id).eq('product_id', productId)
        .gte('day', scope.start).lte('day', scope.end)
        .order('day');
      if (error) throw new Error(error.message);
      return data || [];
    },
  });
  const campaignsQ = useQuery({ queryKey: ['camps', shop.id], queryFn: () => listCampaigns(shop.id) });

  const crumbs = <Link to={scopedTo('/products', params)}>Products</Link>;

  // Never render a headline over an absent product: no title, no zeros.
  if (listQ.isLoading) {
    return (
      <>
        <PageHeader title="Product" crumbs={crumbs} right={<ReportToolbar scope={scope} shop={shop} />} />
        <MetricSummary items={[]} loading />
        <Panel><Skeleton h={220} /></Panel>
      </>
    );
  }

  const p = listQ.data?.rows?.[0];
  if (!p) {
    return (
      <>
        <PageHeader title="Product not found" crumbs={crumbs} right={<ReportToolbar scope={scope} shop={shop} />} />
        <Panel>
          <EmptyState
            title="That product is not in this shop or window"
            action={<Link className="btn" to={scopedTo('/products', params)}>Back to products</Link>}
          >
            The link may point at a product belonging to another shop, or one with no data between{' '}
            {scope.start} and {scope.end}.
          </EmptyState>
        </Panel>
      </>
    );
  }

  const s = statsQ.data;
  const statsLoading = statsQ.isLoading;
  const medianN = Number(s?.median_n) || 0;
  const median = medianN >= 3 && s?.median_conversion != null ? Number(s.median_conversion) : null;
  const weak = median != null && p.click_to_order_rate != null
    && Number(p.clicks) >= (Number(s?.median_min_clicks) || 500)
    && Number(p.click_to_order_rate) < median * 0.6;

  // Campaigns that name this product. GMV Max product campaigns carry a
  // product_id; when they do not, we say so rather than guessing a link.
  const related = (campaignsQ.data || []).filter((c) => c.product_id === productId);

  const name = p.title || p.product_id;

  // One region, one basis. Everything here is measured, so no metric carries
  // its own tag — the region says it once.
  const metrics = [
    {
      label: 'GMV', value: money(p.gmv, cur),
      context: `${p.orders == null ? '—' : Number(p.orders).toLocaleString()} orders`,
    },
    {
      label: 'Conversion', value: rate(p.click_to_order_rate),
      tone: weak ? 'neg' : '',
      // While the shop stats are still in flight there is no benchmark YET,
      // which is not the same claim as there being none.
      context: median != null ? `shop median ${rate(median)}`
        : statsLoading ? 'checking the shop benchmark' : 'no shop benchmark',
      hint: median != null
        ? `Funnel orders divided by clicks. The benchmark is the median across ${medianN} products with ${Number(s?.median_min_clicks || 500).toLocaleString()}+ clicks.`
        : statsLoading
          ? 'Funnel orders divided by clicks. The shop-wide benchmark is still loading.'
          : `Fewer than 3 products clear ${Number(s?.median_min_clicks || 500).toLocaleString()} clicks, so there is no benchmark to compare against.`,
    },
    {
      label: 'CTR', value: rate(p.ctr),
      // Unreported impressions are not zero impressions.
      context: numOrNull(p.impressions) == null
        ? 'impressions not reported'
        : `${Number(p.impressions).toLocaleString()} impressions`,
    },
    {
      label: 'Refunds', value: money(p.refunds, cur),
      tone: p.refund_rate != null && Number(p.refund_rate) >= 0.08 ? 'neg' : '',
      context: rate(p.refund_rate, 1),
    },
    {
      label: 'Affiliate ad share',
      value: p.paid_share == null ? '—' : pct(p.paid_share, 0),
      context: p.paid_share == null ? 'no affiliate orders' : `${money(p.measured_paid_gmv, cur)} ad-driven`,
      hint: "The portion of this product's AFFILIATE revenue that carried a Shop Ads commission — measured per product, never apportioned from a shop-wide rate.",
    },
  ];

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title={
          <span className="row" style={{ gap: 12, flexWrap: 'nowrap', minWidth: 0 }}>
            <Thumb src={p.image_url} kind="product" alt="" />
            <span className="truncate" title={name} style={{ minWidth: 0 }}>{name}</span>
          </span>
        }
        sub={
          <>
            <span className="mono">{p.product_id}</span>
            {p.has_sales === false && (
              <span className="status status-info" style={{ marginLeft: 8 }}>Traffic, no sales</span>
            )}
            {weak && (
              <span className="status status-bad" style={{ marginLeft: 8 }}>Converts below the shop</span>
            )}
          </>
        }
        right={<ReportToolbar scope={scope} shop={shop} />}
      />

      <MetricSummary items={metrics} source="measured" />

      <div className="toolbar" role="tablist" aria-label="Product detail sections">
        {TABS.map((t) => (
          <button
            key={t.id} role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id}
            aria-controls="product-tabpanel"
            className={`btn btn-sm${tab === t.id ? ' btn-primary' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="stack" role="tabpanel" id="product-tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'funnel' && <Funnel rows={dailyQ.data} loading={dailyQ.isLoading} cur={cur} p={p} median={median} scope={scope} />}
        {tab === 'commerce' && (
          <Commerce
            p={p} cur={cur} related={related} campaigns={campaignsQ.data}
            campaignsLoading={campaignsQ.isLoading} params={params}
          />
        )}
        {tab === 'creatives' && <ProductCreatives shop={shop} scope={scope} cur={cur} productId={productId} />}
      </div>
    </>
  );
}

function Funnel({ rows, loading, cur, p, median, scope }) {
  if (loading) return <Panel><Skeleton h={260} /></Panel>;
  if (!rows?.length) {
    return (
      <Panel>
        <EmptyState title="No daily funnel data for this window">
          This product had affiliate orders but no Seller Center funnel rows for these dates, so
          impressions, clicks and conversion are <strong>unknown rather than zero</strong>.
        </EmptyState>
      </Panel>
    );
  }

  // THE AXIS RUNS TO THE REPORT END, exactly as the campaign chart now does.
  // Plotting only the returned rows made the axis stop at the last day the
  // funnel feed had — a 09-07 report drew a chart ending 09-06, with nothing
  // saying the last day was missing rather than flat. Absent days keep nulls:
  // a break in the line, no bar, which is the honest rendering of "not
  // collected". A day with a real zero still has a row and still plots zero.
  const byDay = new Map((rows || []).map((d) => [String(d.day), d]));
  const days = [];
  for (let iso = scope.start; iso <= scope.end; iso = addDays(iso, 1)) days.push(iso);
  const absent = days.filter((iso) => !byDay.has(iso));

  const data = days.map((iso) => {
    const d = byDay.get(iso);
    return {
      day: iso.slice(5),
      GMV: d ? Number(d.gmv) || 0 : null,
      Clicks: d ? Number(d.clicks) || 0 : null,
      Conversion: d && d.clicks ? (Number(d.funnel_orders) || 0) / Number(d.clicks) : null,
    };
  });

  return (
    <>
      <Panel title="Revenue and traffic" sub="Daily, over the reporting window.">
        <div style={{ height: 260 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--divider)" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 12, fill: 'var(--text-2)' }}
                tickLine={false} axisLine={{ stroke: 'var(--divider)' }} minTickGap={20} />
              <YAxis yAxisId="l" tick={{ fontSize: 12, fill: 'var(--text-2)' }} tickLine={false} axisLine={false}
                tickFormatter={(v) => money(v, cur)} width={64} />
              <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 12, fill: 'var(--text-2)' }}
                tickLine={false} axisLine={false} width={56} />
              <Tooltip
                formatter={(v, n) => [n === 'GMV' ? moneyExact(v, cur) : Number(v).toLocaleString(), n]}
                contentStyle={{
                  background: 'var(--surface)', border: '1px solid var(--divider)',
                  borderRadius: 'var(--r-panel)', fontSize: 13, boxShadow: 'var(--shadow-pop)',
                }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <ChartBar yAxisId="l" dataKey="GMV" fill="var(--series-organic)" radius={[2, 2, 0, 0]} />
              <Line yAxisId="r" type="monotone" dataKey="Clicks" stroke="var(--series-paid)" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="meta" style={{ margin: '8px 0 0' }}>
          Left axis: GMV ({cur}). Right axis: clicks (count).
          {absent.length > 0 && (
            <> {' '}
              <strong>
                {absent.length} of these {days.length} day{days.length === 1 ? '' : 's'} have no funnel row
              </strong>{' '}
              ({absent.length <= 4 ? absent.join(', ') : `${absent[0]} … ${absent[absent.length - 1]}`}).
              The axis still runs to {scope.end}; those days are blank rather than zero.
            </>
          )}
        </p>
      </Panel>

      <Panel
        title="Where the traffic goes"
        sub="Each step as a share of the one before it — the point at which people leave."
        bodyPad={false}
      >
        <FunnelSteps p={p} median={median} />
      </Panel>
    </>
  );
}

function FunnelSteps({ p, median }) {
  const impressions = numOrNull(p.impressions);
  const clicks = numOrNull(p.clicks);
  const orders = numOrNull(p.orders);

  const steps = [
    { label: 'Impressions', value: impressions, of: null },
    { label: 'Clicks', value: clicks, of: impressions, rateLabel: 'CTR' },
    { label: 'Orders', value: orders, of: clicks, rateLabel: 'Conversion' },
  ];

  return (
    <>
      <div className="tablewrap">
        <table className="data">
          <thead>
            <tr>
              <th className="sticky-l">Step</th>
              <th className="num">Count</th>
              <th>Rate against the step before</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s) => {
              const r = s.of && s.value != null ? s.value / s.of : null;
              const below = s.rateLabel === 'Conversion' && median != null && r != null && r < median * 0.6;
              return (
                <tr key={s.label}>
                  <td className="sticky-l">{s.label}</td>
                  <td className="num">
                    <strong>{s.value == null ? '—' : Number(s.value).toLocaleString()}</strong>
                  </td>
                  <td>
                    {s.of == null ? (
                      <span className="muted">First step — nothing precedes it.</span>
                    ) : (
                      <div className="row" style={{ flexWrap: 'nowrap', gap: 8 }}>
                        {/* No bar for an unmeasurable rate: a zero-width bar
                            reads as a measured zero. */}
                        {r != null && (
                          <Bar value={Math.min(1, r * 12)}
                            color={below ? 'var(--error)' : 'var(--accent)'} />
                        )}
                        <span>
                          {s.rateLabel}{' '}
                          {r == null
                            ? <Unavailable reason={`${s.label} or the step before it was not reported for this window, so the rate cannot be measured.`} />
                            : `${(r * 100).toFixed(2)}%`}
                        </span>
                        {below && median != null && (
                          <span className="status status-bad">Shop median {(median * 100).toFixed(2)}%</span>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="panel-body" style={{ paddingTop: 12 }}>
        <Disclosure summary="How these rates are calculated">
          Rates are rebuilt from summed numerators and denominators across the window, never averaged
          from daily rates — averaging would weight a $50 day the same as a $5,000 one.
        </Disclosure>
      </div>
    </>
  );
}

function Commerce({ p, cur, related, campaigns, campaignsLoading, params }) {
  const hasDiscount = p.discount_pct != null;
  return (
    <>
      <Panel title="Price and stock" sub="What we can read from the catalogue." bodyPad={false}>
        <div className="tablewrap">
          <table className="data">
            <thead>
              <tr>
                <th className="sticky-l">Field</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="sticky-l">Current price</td>
                <td>
                  {p.min_price == null ? <span className="muted">—</span>
                    : Number(p.min_price) === Number(p.max_price) ? moneyExact(p.min_price, cur)
                    : <>{moneyExact(p.min_price, cur)} – {moneyExact(p.max_price, cur)}
                      <span className="muted" style={{ marginLeft: 8 }}>range across variants</span></>}
                </td>
              </tr>
              <tr>
              {/* The provider field names used to sit here, on a buyer's screen,
                  repeated on every product. They live in Data status now — the
                  spec is explicit that this is a RELOCATION, not a deletion, and
                  the browser gate asserts all five moved items are still there.
                  What stays here is the fact and its reason, on hover or focus. */}
                <td className="sticky-l">Reference price</td>
                <td>
                  <Unavailable reason="No reference price is published for this shop, so there is nothing to measure a discount against. The exact missing field is listed in Data status.">
                    Unavailable
                  </Unavailable>
                </td>
              </tr>
              <tr>
                <td className="sticky-l">Discount depth</td>
                <td>
                  <Unavailable reason="Discount history is unavailable for this shop, so depth cannot be measured. The exact missing field is listed in Data status.">
                    Unavailable
                  </Unavailable>
                </td>
              </tr>
              <tr>
                <td className="sticky-l">Who funded a discount</td>
                <td>
                  <Unavailable reason="The seller-funded versus TikTok-funded split is not exposed by the source." />
                  <span className="muted" style={{ marginLeft: 8 }}>
                    the seller/TikTok split is not exposed
                  </span>
                </td>
              </tr>
              <tr>
                <td className="sticky-l">Commission rate</td>
                <td>{p.commission_rate == null ? <span className="muted">—</span> : pct(p.commission_rate, 1)}</td>
              </tr>
              <tr>
                <td className="sticky-l">Stock</td>
                <td>{p.inventory == null ? <span className="muted">—</span> : Number(p.inventory).toLocaleString()}</td>
              </tr>
              <tr>
                <td className="sticky-l">Average order value</td>
                <td>{p.aov == null ? <span className="muted">—</span> : moneyExact(p.aov, cur)}</td>
              </tr>
              <tr>
                <td className="sticky-l">Refunds</td>
                <td>
                  {moneyExact(p.refunds, cur)}
                  <span className="muted" style={{ marginLeft: 8 }}>
                    {p.refund_rate == null ? '' : `${(Number(p.refund_rate) * 100).toFixed(1)}% of GMV`}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {!hasDiscount && (
          <div className="panel-body">
            <Notice tone="info">
              Price history and promotions cannot be shown for this shop: without a reference price
              there is no depth to measure and no way to tell a performance change from a price change.
            </Notice>
            <div style={{ marginTop: 12 }}>
              <Disclosure summary="Why the commercial view is missing">
                This is a missing provider field, not an empty result — the source publishes no
                reference price, so there is nothing to measure a discount against and nothing here
                is estimated in the meantime.{' '}
                <Link to={scopedTo('/data', params)}>View data details</Link> for the exact fields and
                what populating them would unlock.
              </Disclosure>
            </div>
          </div>
        )}
      </Panel>

      <Panel title="Related campaigns" sub="GMV Max campaigns naming this product." bodyPad={false}>
        {/* An empty campaign list and an unfinished campaign query look the
            same from here, so the empty state must wait for the answer. */}
        {campaignsLoading ? (
          <div className="panel-body"><Skeleton h={120} /></div>
        ) : related.length ? (
          <div className="tablewrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="sticky-l">Campaign</th>
                  <th>Status</th>
                  <th className="num">Target ROI</th>
                  <th className="num">Daily budget</th>
                </tr>
              </thead>
              <tbody>
                {related.map((c) => (
                  <tr key={c.campaign_id}>
                    <td className="sticky-l">
                      <Link className="identity" to={scopedTo(`/campaigns/${encodeURIComponent(c.campaign_id)}`, params)}>
                        {c.campaign_name || c.campaign_id}
                      </Link>
                    </td>
                    <td>
                      <span className={`status status-${c.status === 'ENABLE' ? 'ok' : 'info'}`}>
                        {c.status === 'ENABLE' ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="num">{c.target_roas == null ? '—' : Number(c.target_roas).toFixed(2)}</td>
                    <td className="num">{c.daily_budget == null ? '—' : money(c.daily_budget, cur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title={campaigns?.length ? 'No campaign names this product' : 'No GMV Max campaigns on this shop'}>
            {campaigns?.length
              ? 'GMV Max campaigns carry a product id only for product-scoped campaigns, so a blank here means the association is not stated by the source — it does not mean no spend reached this product.'
              : 'This shop has no GMV Max campaigns — the ad account is not connected in Reacher.'}
          </EmptyState>
        )}
      </Panel>
    </>
  );
}

/** The same table as the Creatives page, scoped to videos that sold this product. */
function ProductCreatives({ shop, scope, cur, productId }) {
  const [sort, setSort] = useState('gmv');
  const [dir, setDir] = useState('desc');

  const idsQ = useQuery({
    queryKey: ['pvids', shop.id, scope.start, scope.end, productId],
    queryFn: async () => {
      // Which videos carried an order line for this product. PostgREST caps a
      // select at 1,000 rows, so this asks for the ids only and de-duplicates
      // client-side rather than aggregating money here.
      const { data, error } = await supabase
        .from('affiliate_order_lines')
        .select('content_id')
        .eq('shop_id', shop.id).eq('product_id', productId)
        .eq('content_type', 'Video').eq('counts_toward_gmv', true)
        .limit(1000);
      if (error) throw new Error(error.message);
      return [...new Set((data || []).map((r) => r.content_id).filter(Boolean))];
    },
  });

  const ids = idsQ.data || [];
  const [page, setPage] = useState(0);
  const PAGE = 50;

  const listQ = useQuery({
    queryKey: ['pvidrows', shop.id, scope.start, scope.end, ids.join(','), sort, dir, page],
    queryFn: () => shopTopVideos(shop.id, scope.start, scope.end, {
      limit: PAGE, offset: page * PAGE, sort, dir, ids,
    }),
    enabled: ids.length > 0,
    placeholderData: (prev) => prev,
  });

  if (idsQ.isLoading) return <Panel><Skeleton h={200} /></Panel>;
  if (!ids.length) {
    return (
      <Panel>
        <EmptyState title="No videos sold this product in this window">
          Revenue for this product came through channels that carry no video id — product card,
          shop tab or seller video.
        </EmptyState>
      </Panel>
    );
  }

  const total = listQ.data?.total ?? 0;

  return (
    <Panel
      title="Videos selling this product"
      sub={`${ids.length} video${ids.length === 1 ? '' : 's'} carried an order line for it.`}
      bodyPad={false}
    >
      {/* The table carries its own pager, so a subtitle claiming 262 videos can
          never sit above a table showing 50 — that truncation defect is the one
          this rebuild exists to remove, and it must not simply move. */}
      <CreativeTable
        rows={listQ.data?.rows} total={total} loading={listQ.isLoading}
        cur={cur} page={page} sort={sort} dir={dir} toolbar={false}
        onSort={(f) => { if (sort === f) setDir(dir === 'asc' ? 'desc' : 'asc'); else { setSort(f); setDir('desc'); } setPage(0); }}
        onPage={setPage}
      />
    </Panel>
  );
}
