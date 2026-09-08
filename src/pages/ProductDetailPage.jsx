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
import { useState } from 'react';
import { useParams, useOutletContext, useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ComposedChart, Bar,
} from 'recharts';
import {
  shopProducts, shopProductStats, shopTopVideos, listCampaigns,
  money, moneyExact, pct, numOrNull,
} from '../lib/api.js';
import { supabase } from '../lib/supabase.js';
import { scopedTo } from '../lib/scope.js';
import CreativeTable from '../components/CreativeTable.jsx';
import { Card, Stat, Note, Skeleton, Empty, Basis, Hint, TabBar, MiniBar, Pager } from '../components/ui.jsx';

const rate = (v, d = 2) => (v == null ? '—' : `${(Number(v) * 100).toFixed(d)}%`);

const TABS = [
  { id: 'funnel', label: 'Funnel' },
  { id: 'commerce', label: 'Commerce' },
  { id: 'creatives', label: 'Creatives' },
];

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

  if (listQ.isLoading) return <div className="card pad"><Skeleton h={220} /></div>;

  const p = listQ.data?.rows?.[0];
  if (!p) {
    return (
      <Empty title="That product is not in this shop or window">
        The link may point at a product belonging to another shop, or one with no data between{' '}
        {scope.start} and {scope.end}.{' '}
        <Link className="lnk" to={scopedTo('/products', params)}>Back to products</Link>
      </Empty>
    );
  }

  const s = statsQ.data;
  const medianN = Number(s?.median_n) || 0;
  const median = medianN >= 3 && s?.median_conversion != null ? Number(s.median_conversion) : null;
  const weak = median != null && p.click_to_order_rate != null
    && Number(p.clicks) >= (Number(s?.median_min_clicks) || 500)
    && Number(p.click_to_order_rate) < median * 0.6;

  // Campaigns that name this product. GMV Max product campaigns carry a
  // product_id; when they do not, we say so rather than guessing a link.
  const related = (campaignsQ.data || []).filter((c) => c.product_id === productId);

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="crumbs">
        <Link className="lnk" to={scopedTo('/products', params)}>← Products</Link>
        <span className="muted"> / {p.title || p.product_id}</span>
      </div>

      <div className="card pad">
        <div className="phead">
          {p.image_url
            ? <img className="pimg" src={p.image_url} alt="" loading="lazy" />
            : <span className="pimg pimg-none" aria-hidden="true">◻</span>}
          <div style={{ minWidth: 0 }}>
            <h2 className="ptitle">{p.title || p.product_id}</h2>
            <div className="muted" style={{ fontSize: 12.5 }}>
              <span className="mono">{p.product_id}</span>
              {p.has_sales === false && <span className="chip chip-info" style={{ marginLeft: 8 }}>traffic, no sales</span>}
              {weak && <span className="chip chip-bad" style={{ marginLeft: 8 }}>converts below the shop</span>}
            </div>
          </div>
        </div>

        <div className="grid g5" style={{ marginTop: 16 }}>
          <Stat k="GMV" basis="measured" v={money(p.gmv, cur)}
            sub={`${p.orders == null ? '—' : Number(p.orders).toLocaleString()} orders`} />
          <Stat k="Conversion" basis="measured" v={rate(p.click_to_order_rate)}
            tone={weak ? 'danger' : undefined}
            sub={median == null ? 'no shop benchmark' : `shop median ${rate(median)}`}
            hint={median == null
              ? `Fewer than 3 products clear ${Number(s?.median_min_clicks || 500).toLocaleString()} clicks, so there is no benchmark to compare against.`
              : `Funnel orders divided by clicks. The benchmark is the median across ${medianN} products with ${Number(s?.median_min_clicks || 500).toLocaleString()}+ clicks.`} />
          <Stat k="CTR" basis="measured" v={rate(p.ctr)}
            sub={`${Number(p.impressions || 0).toLocaleString()} impressions`} />
          <Stat k="Refunds" basis="measured" v={money(p.refunds, cur)}
            tone={p.refund_rate != null && Number(p.refund_rate) >= 0.08 ? 'danger' : undefined}
            sub={rate(p.refund_rate, 1)} />
          <Stat k="Ad share" basis="measured"
            v={p.paid_share == null ? '—' : pct(p.paid_share, 0)}
            sub={p.paid_share == null ? 'no affiliate orders' : `${money(p.measured_paid_gmv, cur)} ad-driven`}
            hint="The portion of this product's AFFILIATE revenue that carried a Shop Ads commission — measured per product, never apportioned from a shop-wide rate." />
        </div>
      </div>

      <TabBar tabs={TABS} value={tab} onChange={setTab} />

      {tab === 'funnel' && <Funnel rows={dailyQ.data} loading={dailyQ.isLoading} cur={cur} p={p} median={median} />}
      {tab === 'commerce' && <Commerce p={p} cur={cur} related={related} campaigns={campaignsQ.data} params={params} />}
      {tab === 'creatives' && <ProductCreatives shop={shop} scope={scope} cur={cur} productId={productId} />}
    </div>
  );
}

function Funnel({ rows, loading, cur, p, median }) {
  if (loading) return <div className="card pad"><Skeleton h={260} /></div>;
  if (!rows?.length) {
    return <Empty title="No daily funnel data for this window">
      This product had affiliate orders but no Seller Center funnel rows for these dates, so
      impressions, clicks and conversion are <strong>unknown rather than zero</strong>.
    </Empty>;
  }

  const data = rows.map((d) => ({
    day: String(d.day).slice(5),
    GMV: Number(d.gmv) || 0,
    Clicks: Number(d.clicks) || 0,
    Conversion: d.clicks ? (Number(d.funnel_orders) || 0) / Number(d.clicks) : null,
  }));

  return (
    <div className="grid" style={{ gap: 16 }}>
      <Card title="Revenue and traffic" sub="Daily, over the reporting window.">
        <div style={{ height: 260 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 6, right: 8, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} minTickGap={18} />
              <YAxis yAxisId="l" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false}
                tickFormatter={(v) => money(v, cur)} width={62} />
              <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                tickLine={false} axisLine={false} width={50} />
              <Tooltip formatter={(v, n) => [n === 'GMV' ? moneyExact(v, cur) : Number(v).toLocaleString(), n]}
                contentStyle={{ background: 'var(--surface-1)', border: '1px solid var(--border-default)', borderRadius: 10, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11.5 }} />
              <Bar yAxisId="l" dataKey="GMV" fill="var(--surface-3)" radius={[3, 3, 0, 0]} />
              <Line yAxisId="r" type="monotone" dataKey="Clicks" stroke="var(--accent)" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card title="Where the traffic goes"
        sub="Each step as a share of the one before it — the point at which people leave.">
        <FunnelSteps p={p} median={median} cur={cur} />
      </Card>
    </div>
  );
}

function FunnelSteps({ p, median, cur }) {
  const impressions = numOrNull(p.impressions);
  const clicks = numOrNull(p.clicks);
  const orders = numOrNull(p.orders);

  const steps = [
    { label: 'Impressions', value: impressions, of: null },
    { label: 'Clicks', value: clicks, of: impressions, rateLabel: 'CTR' },
    { label: 'Orders', value: orders, of: clicks, rateLabel: 'Conversion' },
  ];

  return (
    <div className="funnel">
      {steps.map((s) => {
        const r = s.of && s.value != null ? s.value / s.of : null;
        const below = s.rateLabel === 'Conversion' && median != null && r != null && r < median * 0.6;
        return (
          <div key={s.label} className="fstep">
            <div className="fstep-head">
              <span>{s.label}</span>
              <strong>{s.value == null ? '—' : Number(s.value).toLocaleString()}</strong>
            </div>
            {s.of != null && (
              <div className="fstep-rate">
                <MiniBar value={r == null ? 0 : Math.min(1, r * 12)} color={below ? 'var(--danger)' : 'var(--accent)'} />
                <span style={{ color: below ? 'var(--danger)' : undefined, fontWeight: below ? 700 : 400 }}>
                  {s.rateLabel} {r == null ? '—' : `${(r * 100).toFixed(2)}%`}
                  {below && median != null && ` · shop median ${(median * 100).toFixed(2)}%`}
                </span>
              </div>
            )}
          </div>
        );
      })}
      <p className="muted" style={{ fontSize: 12, margin: '10px 0 0', lineHeight: 1.55 }}>
        Rates are rebuilt from summed numerators and denominators across the window, never averaged
        from daily rates — averaging would weight a $50 day the same as a $5,000 one.
      </p>
    </div>
  );
}

function Commerce({ p, cur, related, campaigns, params }) {
  const hasDiscount = p.discount_pct != null;
  return (
    <div className="grid" style={{ gap: 16 }}>
      <Card title="Price and stock" sub="What we can read from the catalogue.">
        <table className="plain">
          <tbody>
            <tr>
              <td style={{ width: 220 }}>Current price</td>
              <td>
                {p.min_price == null ? <span className="muted">—</span>
                  : Number(p.min_price) === Number(p.max_price) ? moneyExact(p.min_price, cur)
                  : <>{moneyExact(p.min_price, cur)} – {moneyExact(p.max_price, cur)}
                    <span className="muted" style={{ marginLeft: 8 }}>range across variants</span></>}
              </td>
            </tr>
            <tr>
              <td>Reference price</td>
              <td><span className="muted">Unavailable — <code>original_price</code> is null on every SKU</span></td>
            </tr>
            <tr>
              <td>Discount depth</td>
              <td><span className="muted">Unavailable — <code>discount_pct</code> is null on every product</span></td>
            </tr>
            <tr>
              <td>Who funded a discount</td>
              <td><span className="muted">Unavailable — the seller/TikTok split is not exposed</span></td>
            </tr>
            <tr>
              <td>Commission rate</td>
              <td>{p.commission_rate == null ? <span className="muted">—</span> : pct(p.commission_rate, 1)}</td>
            </tr>
            <tr>
              <td>Stock</td>
              <td>{p.inventory == null ? <span className="muted">—</span> : Number(p.inventory).toLocaleString()}</td>
            </tr>
            <tr>
              <td>Average order value</td>
              <td>{p.aov == null ? <span className="muted">—</span> : moneyExact(p.aov, cur)}</td>
            </tr>
            <tr>
              <td>Refunds</td>
              <td>
                {moneyExact(p.refunds, cur)}
                <span className="muted" style={{ marginLeft: 8 }}>
                  {p.refund_rate == null ? '' : `${(Number(p.refund_rate) * 100).toFixed(1)}% of GMV`}
                </span>
              </td>
            </tr>
          </tbody>
        </table>

        {!hasDiscount && (
          <Note tone="info">
            <div>
              <strong>Price history and promotions cannot be shown for this shop.</strong>
              <div style={{ marginTop: 4 }}>
                Without a reference price there is no depth to measure and no way to tell a performance
                change from a price change. This is a missing provider field, not an empty result — asking
                Reacher to populate <code>original_price</code> and <code>discount_pct</code> unlocks the
                whole commercial view. Nothing here is estimated in the meantime.
              </div>
            </div>
          </Note>
        )}
      </Card>

      <Card title="Related campaigns" pad={false}
        sub="GMV Max campaigns naming this product.">
        {related.length ? (
          <div className="scroll">
            <table>
              <thead><tr><th>Campaign</th><th>Status</th><th className="num">Target ROI</th><th className="num">Daily budget</th></tr></thead>
              <tbody>
                {related.map((c) => (
                  <tr key={c.campaign_id}>
                    <td className="tight">
                      <Link className="lnk" to={scopedTo(`/campaigns/${encodeURIComponent(c.campaign_id)}`, params)}>
                        {c.campaign_name || c.campaign_id}
                      </Link>
                    </td>
                    <td className="tight">
                      <span className={`chip chip-${c.status === 'ENABLE' ? 'ok' : 'info'}`}>
                        {c.status === 'ENABLE' ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="num tight">{c.target_roas == null ? '—' : Number(c.target_roas).toFixed(2)}</td>
                    <td className="num tight">{c.daily_budget == null ? '—' : money(c.daily_budget, cur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="pad">
            <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
              {campaigns?.length
                ? 'No campaign on this shop names this product. GMV Max campaigns carry a product id only for product-scoped campaigns, so a blank here means the association is not stated by the source — it does not mean no spend reached this product.'
                : 'This shop has no GMV Max campaigns — the ad account is not connected in Reacher.'}
            </p>
          </div>
        )}
      </Card>
    </div>
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

  if (idsQ.isLoading) return <div className="card pad"><Skeleton h={200} /></div>;
  if (!ids.length) {
    return <Empty title="No videos sold this product in this window">
      Revenue for this product came through channels that carry no video id — product card,
      shop tab or seller video.
    </Empty>;
  }

  const total = listQ.data?.total ?? 0;

  return (
    <Card title="Videos selling this product" pad={false}
      sub={`${ids.length} video${ids.length === 1 ? '' : 's'} carried an order line for it.`}>
      <CreativeTable
        rows={listQ.data?.rows} total={total} loading={listQ.isLoading}
        cur={cur} page={page} sort={sort} dir={dir} compact
        onSort={(f) => { if (sort === f) setDir(dir === 'asc' ? 'desc' : 'asc'); else { setSort(f); setDir('desc'); } setPage(0); }}
        onPage={setPage} onSearch={() => {}} onStatus={() => {}} onClear={() => {}}
      />
      {/* The compact table has no toolbar, so it carries its own pager. A
          subtitle claiming 262 videos above a table showing 50 is the same
          truncation defect this rebuild exists to remove — it just moved. */}
      <div className="pad" style={{ paddingTop: 12 }}>
        <Pager page={page} pageSize={PAGE} total={total} onPage={setPage} />
      </div>
    </Card>
  );
}
