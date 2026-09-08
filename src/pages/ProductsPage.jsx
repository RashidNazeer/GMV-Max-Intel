// Products — commerce context, with counters that mean what they say.
//
// ── WHAT WAS BROKEN ────────────────────────────────────────────────────────
// "Products with sales: 30" counted products with Seller Center FUNNEL data,
// six of which had zero orders and zero GMV. And the median conversion shown
// here (3.70%, every row with a rate) was not the median the recommendation
// text quoted (3.65%, rows with 50,000+ impressions) — same words, different
// bar, no explanation. Both now come from shop_product_stats(), which defines
// the numerator, denominator and eligibility once and returns n.
//
// Discount depth remains unavailable: Reacher returns discount_pct null on
// every product and original_price null on every SKU, so there is no reference
// price to measure against. The page says so and names the missing field
// rather than rendering a confident 0%.
import { useOutletContext, useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { shopProducts, shopProductStats, money, moneyExact, pct } from '../lib/api.js';
import { useLocalParams, scopedTo } from '../lib/scope.js';
import {
  Card, Stat, Note, Skeleton, Empty, MiniBar, Toolbar, Pager, SortTh, Hint, Unavailable,
} from '../components/ui.jsx';

const PAGE_SIZE = 50;
const DEFAULTS = { q: '', sort: 'gmv', dir: 'desc', page: '0' };
const rate = (v, d = 2) => (v == null ? '—' : `${(Number(v) * 100).toFixed(d)}%`);

export default function ProductsPage() {
  const { shop, scope } = useOutletContext();
  const [params] = useSearchParams();
  const lp = useLocalParams(DEFAULTS);
  const cur = shop.currency || 'USD';

  const search = lp.get('q') || '';
  const sort = lp.get('sort') || 'gmv';
  const dir = lp.get('dir') || 'desc';
  const page = Math.max(0, Number(lp.get('page')) || 0);
  const ids = (params.get('ids') || '').split(',').filter(Boolean);

  const statsQ = useQuery({
    queryKey: ['pstats', shop.id, scope.start, scope.end],
    queryFn: () => shopProductStats(shop.id, scope.start, scope.end),
  });

  const listQ = useQuery({
    queryKey: ['prodlist', shop.id, scope.start, scope.end, search, sort, dir, page, ids.join(',')],
    queryFn: () => shopProducts(shop.id, scope.start, scope.end, {
      limit: PAGE_SIZE, offset: page * PAGE_SIZE, search, sort, dir, ids,
    }),
    placeholderData: (prev) => prev,
  });

  if (listQ.error) return <Note tone="warn">{listQ.error.message}</Note>;

  const s = statsQ.data;
  const rows = listQ.data?.rows || [];
  const total = listQ.data?.total ?? 0;
  const filtered = !!(search || ids.length);
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

  if (!statsQ.isLoading && !listQ.isLoading && !total) {
    return (
      <Empty title={`No product data for ${scope.start} → ${scope.end}`}>
        The Seller Center funnel has not been collected for these dates, so impressions, conversion
        and refunds are <strong>unknown rather than zero</strong>. Pick a range that has been synced,
        or ask an administrator to run the context sync for this window.
      </Empty>
    );
  }

  const onSort = (field) => {
    if (sort === field) lp.set({ dir: dir === 'asc' ? 'desc' : 'asc' });
    else lp.set({ sort: field, dir: 'desc' });
  };

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="grid g4">
        <Stat k="Products with sales" basis="measured"
          v={statsQ.isLoading ? '—' : Number(s?.products_with_sales ?? 0).toLocaleString()}
          sub={`${money(s?.gmv, cur)} · ${Number(s?.orders || 0).toLocaleString()} orders`}
          hint="Distinct products with positive orders AND positive GMV in this window. Different from 'products with traffic' and from the catalogue size." />

        <Stat k="Products with traffic" basis="measured"
          v={statsQ.isLoading ? '—' : Number(s?.products_with_traffic ?? 0).toLocaleString()}
          sub={`of ${Number(s?.catalog_products || 0).toLocaleString()} in the catalogue`}
          hint="Distinct products that received at least one impression. A product can have traffic and no sales." />

        <Stat k="Median conversion" basis="measured" v={rate(median)}
          sub={medianUsable
            ? `${medianN} products with ${minClicks.toLocaleString()}+ clicks`
            : medianN > 0
              ? `only ${medianN} product${medianN === 1 ? '' : 's'} clear ${minClicks.toLocaleString()} clicks — too few for a median`
              : 'no products with enough traffic to compare'}
          hint={`Funnel orders divided by clicks, taken as the median across products with at least ${minClicks.toLocaleString()} clicks, and only when at least ${MIN_BENCHMARK_N} products qualify. This is the ONE benchmark — the table highlight and every recommendation use this same value and population.`} />

        <Stat k="Refunded" basis="measured"
          tone={s?.refund_rate != null && Number(s.refund_rate) >= 0.06 ? 'danger' : undefined}
          v={money(s?.refunds, cur)}
          sub={`${rate(s?.refund_rate, 1)} of product GMV`}
          hint="Refunds are booked when they post, not against the cohort that generated the sale. Every ROAS on this tool is computed on revenue that partly came back." />
      </div>

      {s?.products_affiliate_only > 0 && (
        <Note tone="info">
          <strong>{Number(s.products_affiliate_only)}</strong> product(s) had affiliate orders in this window
          but no Seller Center funnel data. Their funnel columns are <em>unknown, not zero</em>, and they are
          excluded from the counters above rather than counted as products that sold nothing.
        </Note>
      )}

      {!s?.discount_available && (
        <Note tone="info">
          <div>
            <strong>Discount depth is unavailable.</strong>
            <div style={{ marginTop: 4 }}>
              Reacher&rsquo;s catalogue returns <code>discount_pct</code> and <code>original_price</code> as null
              for every product on this shop, so there is no reference price to measure a discount against —
              and no seller-funded versus TikTok-funded split either. The funnel below answers the related
              question of whether a change came from the ads or from the listing, but it is not the same
              question and does not replace it. The exact missing fields are listed in Data status.
            </div>
          </div>
        </Note>
      )}

      <Card title="Products" pad={false}
        sub="Seller Center funnel, with the ad-driven share measured from our own order lines.">
        <div className="pad" style={{ paddingTop: 0, paddingBottom: 10 }}>
          <Toolbar count={total} onClear={lp.clear} active={filtered}>
            <input className="input" placeholder="Search product or id"
              value={search} onChange={(e) => lp.set({ q: e.target.value })} style={{ minWidth: 230 }} />
          </Toolbar>

          {ids.length > 0 && (
            <Note tone="info">
              Showing the <strong>{ids.length}</strong> products behind a finding, for {scope.start} → {scope.end}.{' '}
              <Link className="lnk" to={scopedTo('/products', params)}>Show all products</Link>
            </Note>
          )}
        </div>

        {listQ.isLoading && !rows.length ? <div className="pad"><Skeleton h={260} /></div> : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <SortTh label="GMV" field="gmv" sort={sort} dir={dir} onSort={onSort} num />
                  <SortTh label="Orders" field="orders" sort={sort} dir={dir} onSort={onSort} num />
                  <SortTh label="CTR" field="ctr" sort={sort} dir={dir} onSort={onSort} num
                    hint="Clicks divided by impressions, rebuilt from summed numerator and denominator — never an average of daily rates." />
                  <SortTh label="Conversion" field="conversion" sort={sort} dir={dir} onSort={onSort} num
                    hint="Funnel orders divided by clicks. Highlighted when below 60% of the shop median." />
                  <SortTh label="Refunds" field="refund_rate" sort={sort} dir={dir} onSort={onSort} num />
                  <th style={{ width: 110 }}>
                    Ad share
                    <Hint text="The portion of this product's AFFILIATE revenue that carried a Shop Ads commission — measured per product, never apportioned from a shop-wide rate. A dash means no affiliate orders, which is not zero ad-driven revenue." />
                  </th>
                  <th className="num">Price</th>
                  <th className="num">Stock</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const weak = median != null && p.click_to_order_rate != null
                    && Number(p.clicks) >= minClicks
                    && Number(p.click_to_order_rate) < median * 0.6;
                  const refundy = p.refund_rate != null && Number(p.refund_rate) >= 0.08;
                  return (
                    <tr key={p.product_id}>
                      <td className="tight">
                        <span className="truncate" style={{ display: 'block' }} title={p.title || p.product_id}>
                          {p.title || p.product_id}
                        </span>
                        {!p.has_sales && p.days_with_data != null && (
                          <span className="muted" style={{ fontSize: 11 }}>traffic, no sales</span>
                        )}
                      </td>
                      <td className="num tight"><strong>{money(p.gmv, cur)}</strong></td>
                      <td className="num tight muted">{p.orders == null ? '—' : Number(p.orders).toLocaleString()}</td>
                      <td className="num tight muted">{rate(p.ctr)}</td>
                      <td className="num tight" style={weak ? { color: 'var(--danger)', fontWeight: 700 } : undefined}
                        title={weak ? `Below 60% of the shop median (${rate(median)}), on ${Number(p.clicks).toLocaleString()} clicks` : undefined}>
                        {rate(p.click_to_order_rate)}
                        {weak && ' ▼'}
                      </td>
                      <td className="num tight" style={refundy ? { color: 'var(--danger)' } : undefined}>
                        {p.refund_rate == null ? '—' : rate(p.refund_rate, 1)}
                      </td>
                      <td className="tight">
                        {p.paid_share == null
                          ? <Unavailable reason="No affiliate orders for this product in this window — not zero ad-driven revenue." />
                          : (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <MiniBar value={p.paid_share} />
                              <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>{pct(p.paid_share, 0)}</span>
                            </div>
                          )}
                      </td>
                      <td className="num tight muted">
                        {p.min_price == null ? '—'
                          : Number(p.min_price) === Number(p.max_price) ? moneyExact(p.min_price, cur)
                          : `${money(p.min_price, cur)}–${money(p.max_price, cur)}`}
                      </td>
                      <td className="num tight muted">{p.inventory == null ? '—' : Number(p.inventory).toLocaleString()}</td>
                    </tr>
                  );
                })}
                {!rows.length && (
                  <tr><td colSpan={9} className="muted" style={{ padding: 22, textAlign: 'center' }}>
                    {filtered
                      ? <>No products match these filters. <button className="lnk" onClick={lp.clear}>Clear them</button>.</>
                      : 'No products with data in this window.'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <div className="pad" style={{ paddingTop: 12 }}>
          <Pager page={page} pageSize={PAGE_SIZE} total={total} onPage={(p) => lp.set({ page: p })} />
        </div>
      </Card>
    </div>
  );
}
