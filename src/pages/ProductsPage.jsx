// Products — the commerce context behind a campaign's numbers.
//
// The spec wanted price and promotion here, so that a "performance improvement"
// could not silently be a discount. That is not buildable: Reacher's catalogue
// returns discount_pct null on every product and original_price null on every
// SKU, so there is no "before" price to measure depth against. Rather than show
// a confident 0%, this page says the measure is unavailable and gives the thing
// that answers the same underlying question — the conversion funnel. If clicks
// stopped turning into orders, the problem is the listing, not the bidding.
import { useQuery } from '@tanstack/react-query';
import { shopProducts } from '../lib/api.js';
import { Card, Stat, Note, Skeleton, Empty, Basis, MiniBar, money, moneyExact, pct } from '../components/ui.jsx';

const rate = (v, d = 2) => (v == null ? '—' : `${(Number(v) * 100).toFixed(d)}%`);

export default function ProductsPage({ shop, start, end }) {
  const cur = shop.currency || 'USD';
  const q = useQuery({
    queryKey: ['products', shop.id, start, end],
    queryFn: () => shopProducts(shop.id, start, end, 60),
  });

  if (q.error) return <Note tone="warn">{q.error.message}</Note>;
  const rows = q.data || [];
  if (!q.isLoading && !rows.length) {
    return <Empty title="No product data for this window">
      Run <code>npm run sync:context</code> to pull the Seller Center funnel and catalogue for {start} → {end}.
    </Empty>;
  }

  const withRate = rows.filter((r) => r.click_to_order_rate != null).map((r) => Number(r.click_to_order_rate)).sort((a, b) => a - b);
  const median = withRate.length ? withRate[Math.floor(withRate.length / 2)] : null;
  const totalGmv = rows.reduce((a, r) => a + (Number(r.gmv) || 0), 0);
  const totalRefunds = rows.reduce((a, r) => a + (Number(r.refunds) || 0), 0);
  const totalClicks = rows.reduce((a, r) => a + (Number(r.clicks) || 0), 0);
  const totalImpr = rows.reduce((a, r) => a + (Number(r.impressions) || 0), 0);
  const anyDiscount = rows.some((r) => r.discount_pct != null);

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="grid g4">
        <Stat k="Products with sales" basis="measured" v={rows.length} sub={money(totalGmv, cur)} />
        <Stat k="Impressions → clicks" basis="measured" v={rate(totalImpr ? totalClicks / totalImpr : null)}
          sub={`${Number(totalImpr).toLocaleString()} impressions`} />
        <Stat k="Median click → order" basis="measured" v={rate(median)}
          sub="the bar each product below is judged against" />
        <Stat k="Refunded" basis="measured" tone={totalGmv && totalRefunds / totalGmv >= 0.06 ? 'danger' : undefined}
          v={money(totalRefunds, cur)} sub={`${rate(totalGmv ? totalRefunds / totalGmv : null, 1)} of product GMV`} />
      </div>

      {!anyDiscount && (
        <Note tone="info">
          <div>
            <strong>Discount depth is not available.</strong>
            <div style={{ marginTop: 4 }}>
              Reacher&rsquo;s catalogue returns <code>discount_pct</code> and <code>original_price</code> as null for
              every product on this shop, so there is no reference price to measure a discount against. The
              funnel below answers the same underlying question — whether a change in results came from the ads
              or from the listing. Asking Reacher to populate the price fields would unlock the rest.
            </div>
          </div>
        </Note>
      )}

      <Card title="Products" sub="Seller Center funnel, with the ad-driven share measured from our own order lines" pad={false}>
        {q.isLoading ? <div className="pad"><Skeleton h={260} /></div> : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num">GMV</th>
                  <th className="num">Orders</th>
                  <th className="num">CTR</th>
                  <th className="num">Click → order</th>
                  <th className="num">Refunds</th>
                  <th style={{ width: 120 }}>Ad share</th>
                  <th className="num">Price</th>
                  <th className="num">Stock</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const weak = median && p.click_to_order_rate != null && Number(p.click_to_order_rate) < median * 0.6;
                  const refundy = p.refund_rate != null && Number(p.refund_rate) >= 0.08;
                  return (
                    <tr key={p.product_id}>
                      <td className="tight">
                        <span className="truncate" style={{ display: 'block' }} title={p.title || p.product_id}>
                          {p.title || p.product_id}
                        </span>
                      </td>
                      <td className="num tight"><strong>{money(p.gmv, cur)}</strong></td>
                      <td className="num tight muted">{p.orders == null ? '—' : Number(p.orders).toLocaleString()}</td>
                      <td className="num tight muted">{rate(p.ctr)}</td>
                      <td className="num tight" style={weak ? { color: 'var(--danger)', fontWeight: 700 } : undefined}
                        title={weak ? `Below 60% of the shop median (${rate(median)})` : undefined}>
                        {rate(p.click_to_order_rate)}
                      </td>
                      <td className="num tight" style={refundy ? { color: 'var(--danger)' } : undefined}>
                        {p.refund_rate == null ? '—' : rate(p.refund_rate, 1)}
                      </td>
                      <td className="tight">
                        {p.paid_share == null ? <span className="muted">—</span> : (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
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
              </tbody>
            </table>
          </div>
        )}
        <div className="pad" style={{ paddingTop: 0 }}>
          <p className="muted" style={{ fontSize: 11.5, margin: 0 }}>
            <strong>Ad share</strong> is the portion of each product&rsquo;s <em>affiliate</em> revenue that carried a
            Shop Ads commission — measured per product, not apportioned from a shop-wide rate. A dash means the
            product had no affiliate orders in this window, which is not the same as zero ad-driven revenue.
            Click → order is highlighted when it falls below 60% of the shop median.
          </p>
        </div>
      </Card>
    </div>
  );
}
