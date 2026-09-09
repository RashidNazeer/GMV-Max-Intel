// Products — commerce context, with counters that mean what they say.
//
// ── WHAT THE NUMBERS MEAN ──────────────────────────────────────────────────
// "Products with sales: 30" once counted products with Seller Center FUNNEL
// data, six of which had zero orders and zero GMV. And the median conversion
// shown here (3.70%, every row with a rate) was not the median the
// recommendation text quoted (3.65%, rows with 50,000+ impressions) — same
// words, different bar, no explanation. Both now come from shop_product_stats(),
// which defines the numerator, denominator and eligibility once and returns n.
//
// ── WHAT THIS REDESIGN CHANGES ─────────────────────────────────────────────
// Four floating stat cards became one metric region with a single provenance
// indicator, and the six-line discount essay became one sentence pointing at
// Data status — which is where the missing provider fields are already listed.
// The table gained a sticky identity column and a column picker, so the
// secondary funnel columns are a choice rather than a crowd.
import { useState } from 'react';
import { useOutletContext, useSearchParams, useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { shopProducts, shopProductStats, shopAttribution, money, moneyExact, pct } from '../lib/api.js';
import { useLocalParams, scopedTo } from '../lib/scope.js';
import ReportToolbar from '../components/ReportToolbar.jsx';
import {
  Panel, PageHeader, MetricSummary, Notice, Skeleton, EmptyState, Identity,
  SortHeader, Pager, ColumnPicker, Bar, Hint, Unavailable,
} from '../components/ui.jsx';

const PAGE_SIZE = 50;
const DEFAULTS = { q: '', sort: 'gmv', dir: 'desc', page: '0' };
const rate = (v, d = 2) => (v == null ? '—' : `${(Number(v) * 100).toFixed(d)}%`);

// The identity, the money and the one benchmark are always on. Everything else
// is funnel detail that only some questions need, so it starts folded away
// instead of being shrunk to fit.
const ALL_COLUMNS = [
  { key: 'product',    label: 'Product',    required: true },
  { key: 'gmv',        label: 'GMV',        required: true },
  { key: 'orders',     label: 'Orders',     required: true },
  { key: 'ctr',        label: 'CTR' },
  { key: 'conversion', label: 'Conversion', required: true },
  { key: 'refunds',    label: 'Refunds' },
  { key: 'share',      label: 'Affiliate ad share' },
  { key: 'price',      label: 'Price' },
  { key: 'stock',      label: 'Stock' },
];
const DEFAULT_COLUMNS = ['product', 'gmv', 'orders', 'conversion', 'refunds', 'share'];

// Sorting by a column you cannot see is a table lying about its own order.
const SORT_COLUMN = { ctr: 'ctr', refund_rate: 'refunds' };

export default function ProductsPage() {
  const { shop, scope } = useOutletContext();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const lp = useLocalParams(DEFAULTS);
  const cur = shop.currency || 'USD';
  const [cols, setCols] = useState(DEFAULT_COLUMNS);

  const search = lp.get('q') || '';
  const sort = lp.get('sort') || 'gmv';
  const dir = lp.get('dir') || 'desc';
  const page = Math.max(0, Number(lp.get('page')) || 0);
  const ids = (params.get('ids') || '').split(',').filter(Boolean);

  const statsQ = useQuery({
    queryKey: ['pstats', shop.id, scope.start, scope.end],
    queryFn: () => shopProductStats(shop.id, scope.start, scope.end),
  });

  // The whole-shop total, purely so this page can say what share of it the
  // product rows below actually account for. Same key shape as everywhere else,
  // so it is one cached read rather than a second request.
  const shopQ = useQuery({
    queryKey: ['attr', shop.id, scope.start, scope.end],
    queryFn: () => shopAttribution(shop.id, scope.start, scope.end),
  });

  const listQ = useQuery({
    queryKey: ['prodlist', shop.id, scope.start, scope.end, search, sort, dir, page, ids.join(',')],
    queryFn: () => shopProducts(shop.id, scope.start, scope.end, {
      limit: PAGE_SIZE, offset: page * PAGE_SIZE, search, sort, dir, ids,
    }),
    placeholderData: (prev) => prev,
  });

  if (listQ.error) return <Notice tone="error">{listQ.error.message}</Notice>;

  const s = statsQ.data;
  const rows = listQ.data?.rows || [];
  const total = listQ.data?.total ?? 0;
  // Before the first response there is no count. "0 results" and "No results"
  // are measurements, and showing either while the page is still loading tells
  // the reader something the query has not answered yet.
  const counted = listQ.data != null;
  const filtered = !!(search || ids.length);
  const show = (k) => cols.includes(k) || SORT_COLUMN[sort] === k;

  // A median needs a population. Biostime has exactly ONE product clearing the
  // click threshold, and "the shop median is 3.78%" computed from a single
  // product is not a benchmark — it is that product's own rate wearing the
  // word median. The rules already refuse below three; the page must not
  // display what the rules refuse to use.
  const MIN_BENCHMARK_N = 3;
  const medianN = Number(s?.median_n) || 0;
  const medianUsable = s?.median_conversion != null && medianN >= MIN_BENCHMARK_N;
  const median = medianUsable ? Number(s.median_conversion) : null;
  const minClicks = Number(s?.median_min_clicks) || 500;

  // Nothing stored for these dates at all. A search that happens to match
  // nothing is a different state and must not borrow this explanation.
  if (!statsQ.isLoading && !listQ.isLoading && !total && !filtered) {
    return (
      <>
        <PageHeader title="Products" right={<ReportToolbar scope={scope} shop={shop} />} />
        <Panel>
          <EmptyState title={`No product data for ${scope.start} → ${scope.end}`}>
            The Seller Center funnel has not been collected for these dates, so impressions,
            conversion and refunds are <strong>unknown rather than zero</strong>. Pick a range that
            has been synced, or ask an administrator to run the context sync for this window.
          </EmptyState>
        </Panel>
      </>
    );
  }

  const onSort = (field) => {
    if (sort === field) lp.set({ dir: dir === 'asc' ? 'desc' : 'asc' });
    else lp.set({ sort: field, dir: 'desc' });
  };

  // Never assert while loading: a zero is a measurement, and a template string
  // over an absent value renders the word "undefined" as content.
  const metrics = statsQ.isLoading || !s ? [] : [
    {
      label: 'Products with sales',
      value: Number(s.products_with_sales ?? 0).toLocaleString(),
      context: `${money(s.gmv, cur)} · ${Number(s.orders || 0).toLocaleString()} orders`,
      hint: "Distinct products with positive orders AND positive GMV in this window. Different from 'products with traffic' and from the catalogue size.",
    },
    {
      label: 'Products with traffic',
      value: Number(s.products_with_traffic ?? 0).toLocaleString(),
      context: `of ${Number(s.catalog_products || 0).toLocaleString()} in the catalogue`,
      hint: 'Distinct products that received at least one impression. A product can have traffic and no sales.',
    },
    {
      label: 'Median conversion',
      value: rate(median),
      context: medianUsable
        ? `${medianN} products with ${minClicks.toLocaleString()}+ clicks`
        : medianN > 0
          ? `only ${medianN} product${medianN === 1 ? '' : 's'} clear ${minClicks.toLocaleString()} clicks — too few for a median`
          : 'no products with enough traffic to compare',
      hint: `Funnel orders divided by clicks, taken as the median across products with at least ${minClicks.toLocaleString()} clicks, and only when at least ${MIN_BENCHMARK_N} products qualify. This is the ONE benchmark — the table highlight and every recommendation use this same value and population.`,
    },
    {
      label: 'Refunded',
      value: money(s.refunds, cur),
      tone: s.refund_rate != null && Number(s.refund_rate) >= 0.06 ? 'neg' : '',
      context: `${rate(s.refund_rate, 1)} of product GMV`,
      hint: 'Refunds are booked when they post, not against the cohort that generated the sale. Every ROAS on this tool is computed on revenue that partly came back.',
    },
  ];

  const contextBar = ids.length > 0 ? (
    <div className="contextbar" style={{ marginTop: 12 }}>
      <strong>Finding: {ids.length} products</strong>
      <span className="muted">for {scope.start} → {scope.end}</span>
      <span className="spacer" />
      <Link className="btn btn-sm" to={scopedTo('/products', params)}>Show all products</Link>
    </div>
  ) : null;

  return (
    <>
      <PageHeader
        title="Products"
        sub={ids.length
          ? `Showing one finding's own set of ${ids.length} products — not a recomputed list.`
          : `${shop.shop_name} · Seller Center funnel, with the ad-driven share measured from our own order lines.`}
        right={<ReportToolbar scope={scope} shop={shop} />}
      />

      {statsQ.isLoading
        ? <MetricSummary items={[]} loading />
        : s
          ? <MetricSummary items={metrics} source="measured" />
          : null}

      {/* COVERAGE, stated where the totals are read.
          The product rows sum to less than Shop GMV, and until now this page
          simply presented its own total as though it were the shop's. It is a
          different population — a sale with no product row in the funnel feed
          is in Shop GMV and not here — so the gap is named rather than left for
          someone to discover by subtracting two screens from each other. */}
      {(() => {
        const pg = Number(s?.gmv);
        const sg = Number(shopQ.data?.total_gmv);
        if (!Number.isFinite(pg) || !Number.isFinite(sg) || sg <= 0) return null;
        const share = pg / sg;
        if (share >= 0.995) return null;
        return (
          <p className="meta" style={{ margin: '8px 0 0', maxWidth: '82ch' }}>
            These products account for <strong>{money(pg, cur)}</strong> of the{' '}
            <strong>{money(sg, cur)}</strong> Shop GMV in this window — <strong>{pct(share, 0)}</strong>.
            The remaining {money(Math.max(0, sg - pg), cur)} is shop revenue with no product row in the
            funnel feed for these dates, so it is absent from every total on this page rather than
            distributed across the rows.
          </p>
        );
      })()}

      {s?.products_affiliate_only > 0 && (
        <Notice tone="info">
          <strong>{Number(s.products_affiliate_only)}</strong> product(s) had affiliate orders in this
          window but no Seller Center funnel data. Their funnel columns are <em>unknown, not zero</em>,
          and they are excluded from the counters above rather than counted as products that sold nothing.
        </Notice>
      )}

      {!statsQ.isLoading && s && !s.discount_available && (
        <Notice tone="info">
          Discount history is unavailable for this shop, so there is no reference price to measure a
          discount against and no seller-funded versus TikTok-funded split.{' '}
          <Link to={scopedTo('/data', params)}>Data status</Link> names the fields that are missing.
        </Notice>
      )}

      <Panel bodyPad={false}>
        <div className="panel-body" style={{ paddingBottom: 12, borderBottom: '1px solid var(--divider)' }}>
          <div className="toolbar">
            <input className="input" placeholder="Search product or ID" aria-label="Search products"
              value={search} onChange={(e) => lp.set({ q: e.target.value })}
              style={{ minWidth: 240, flex: '1 1 240px' }} />
            <ColumnPicker columns={ALL_COLUMNS} visible={cols} onChange={setCols} />
            <span className="spacer" />
            {counted && <span className="meta">{Number(total).toLocaleString()} results</span>}
            {filtered && <button className="btn btn-sm" onClick={lp.clear}>Clear filters</button>}
          </div>
          {contextBar}
        </div>

        {listQ.isLoading && !rows.length ? (
          <div className="panel-body"><Skeleton h={260} /></div>
        ) : !rows.length ? (
          <EmptyState
            title={filtered ? 'No products match these filters' : 'No products with data in this window'}
            action={filtered ? <button className="btn" onClick={lp.clear}>Clear filters</button> : null}>
            {filtered
              ? 'Try a broader search, or clear the finding this table was opened from.'
              : 'No product carried traffic or sales in this window.'}
          </EmptyState>
        ) : (
          <div className="tablewrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="sticky-l">Product</th>
                  <SortHeader label="GMV" field="gmv" sort={sort} dir={dir} onSort={onSort} num />
                  <SortHeader label="Orders" field="orders" sort={sort} dir={dir} onSort={onSort} num />
                  {show('ctr') && (
                    <SortHeader label="CTR" field="ctr" sort={sort} dir={dir} onSort={onSort} num
                      hint="Clicks divided by impressions, rebuilt from summed numerator and denominator — never an average of daily rates." />
                  )}
                  <SortHeader label="Conversion" field="conversion" sort={sort} dir={dir} onSort={onSort} num
                    hint="Funnel orders divided by clicks. Highlighted when below 60% of the shop median." />
                  {show('refunds') && (
                    <SortHeader label="Refunds" field="refund_rate" sort={sort} dir={dir} onSort={onSort} num />
                  )}
                  {show('share') && (
                    <th>
                      Affiliate ad share
                      <Hint text="The portion of this product's AFFILIATE revenue that carried a Shop Ads commission — measured per product, never apportioned from a shop-wide rate. A dash means no affiliate orders, which is not zero ad-driven revenue." />
                    </th>
                  )}
                  {show('price') && <th className="num">Price</th>}
                  {show('stock') && <th className="num">Stock</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const weak = median != null && p.click_to_order_rate != null
                    && Number(p.clicks) >= minClicks
                    && Number(p.click_to_order_rate) < median * 0.6;
                  const refundy = p.refund_rate != null && Number(p.refund_rate) >= 0.08;
                  const href = scopedTo(`/products/${encodeURIComponent(p.product_id)}`, params);
                  return (
                    <tr key={p.product_id} className="media">
                      <td className="sticky-l">
                        {/* Reacher DOES supply a product image on every product,
                            unlike videos where no cover field exists at all. A
                            missing one gets the neutral placeholder and the row
                            stays usable. */}
                        <Identity
                          src={p.image_url} kind="image"
                          name={p.title || p.product_id}
                          title={p.title || p.product_id}
                          sub={!p.has_sales && p.days_with_data != null
                            ? `Traffic, no sales · ${p.product_id}`
                            : p.product_id}
                          to={href}
                          onClick={(e) => {
                            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                            e.preventDefault();
                            navigate(href);
                          }}
                        />
                      </td>
                      <td className="num"><strong>{money(p.gmv, cur)}</strong></td>
                      <td className="num muted">
                        {p.orders == null ? '—' : Number(p.orders).toLocaleString()}
                      </td>
                      {show('ctr') && <td className="num muted">{rate(p.ctr)}</td>}
                      <td className={`num${weak ? ' trend-down' : ''}`}
                        title={weak
                          ? `Below 60% of the shop median (${rate(median)}), on ${Number(p.clicks).toLocaleString()} clicks`
                          : undefined}>
                        {rate(p.click_to_order_rate)}{weak && ' ▼'}
                      </td>
                      {show('refunds') && (
                        <td className={`num${refundy ? ' trend-down' : ' muted'}`}
                          title={refundy ? 'At or above 8% of this product’s GMV' : undefined}>
                          {p.refund_rate == null ? '—' : rate(p.refund_rate, 1)}
                        </td>
                      )}
                      {show('share') && (
                        <td>
                          {p.paid_share == null
                            ? <Unavailable reason="No affiliate orders for this product in this window — not zero ad-driven revenue." />
                            : (
                              <div className="row" style={{ flexWrap: 'nowrap', gap: 8 }}>
                                <Bar value={p.paid_share} />
                                <span className="num">{pct(p.paid_share, 0)}</span>
                              </div>
                            )}
                        </td>
                      )}
                      {show('price') && (
                        <td className="num muted">
                          {p.min_price == null ? '—'
                            : Number(p.min_price) === Number(p.max_price) ? moneyExact(p.min_price, cur)
                            : `${money(p.min_price, cur)}–${money(p.max_price, cur)}`}
                        </td>
                      )}
                      {show('stock') && (
                        <td className="num muted">
                          {p.inventory == null ? '—' : Number(p.inventory).toLocaleString()}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {counted && (
          <Pager page={page} pageSize={PAGE_SIZE} total={total} onPage={(p) => lp.set({ page: p })} />
        )}
      </Panel>
    </>
  );
}
