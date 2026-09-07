// Overview: what to do next, then where the money actually came from.
//
// The headline used to say "60% of your revenue would have happened without
// your ads". That was true of the affiliate slice and read as though it were
// true of the shop — and the affiliate slice is under a third of Cutler. This
// page states the scope in the same sentence as the number.
import { useQuery } from '@tanstack/react-query';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import {
  shopAttribution, shopChannelDaily, shopCreativeHealth, shopTopVideos,
  shopProducts, shopPaidRoas, topCreators,
} from '../lib/api.js';
import Decisions from '../components/Decisions.jsx';
import { Card, Stat, Note, Skeleton, Empty, Basis, MiniBar, money, moneyExact, pct } from '../components/ui.jsx';

export default function OverviewPage({ shop, start, end, days }) {
  const cur = shop.currency || 'USD';
  const q = (key, fn) => useQuery({ queryKey: [key, shop.id, start, end], queryFn: fn });

  const attrQ     = q('attr',     () => shopAttribution(shop.id, start, end));
  const dailyQ    = q('chdaily',  () => shopChannelDaily(shop.id, start, end));
  const creativeQ = q('creative', () => shopCreativeHealth(shop.id, start, end));
  const videosQ   = q('vids',     () => shopTopVideos(shop.id, start, end, 100));
  const productsQ = q('prods',    () => shopProducts(shop.id, start, end, 50));
  const roasQ     = q('roas',     () => shopPaidRoas(shop.id, start, end));
  const creatorsQ = q('creators', () => topCreators(shop.id, start, end, 12));

  const a = attrQ.data;
  const loading = attrQ.isLoading || creativeQ.isLoading;

  const facts = {
    shop, days,
    attribution: a,
    creative: creativeQ.data,
    videos: videosQ.data || [],
    products: productsQ.data || [],
    roas: roasQ.data,
  };

  if (attrQ.error) return <Note tone="warn">Could not load: {attrQ.error.message}</Note>;

  if (!loading && (!a || !Number(a.days_covered))) {
    return (
      <Empty title="No channel data for this window">
        This shop has no Seller Center figures stored for {start} → {end}. Run{' '}
        <code>npm run sync:context</code> to pull them, or pick a different range.
        {shop.shop_name === 'Longevity' && ' Longevity has no TikTok seller ID on file, so no data can exist for it.'}
      </Empty>
    );
  }

  return (
    <div className="grid" style={{ gap: 16 }}>
      <DataQuality shop={shop} attribution={a} roas={roasQ.data} />

      <Decisions facts={facts} loading={loading} />

      {loading ? <Card><Skeleton h={200} /></Card> : <AttributionCard a={a} shop={shop} cur={cur} />}

      <div className="grid g4">
        <Stat k="Total shop GMV" basis="measured"
          v={money(a?.total_gmv, cur)}
          sub={`${Number(a?.orders || 0).toLocaleString()} orders · ${a?.days_covered || 0} days`} />
        <Stat k="We can attribute" basis="measured"
          v={pct(a?.attribution_coverage, 0)}
          sub={`${money((Number(a?.total_gmv) || 0) * (Number(a?.attribution_coverage) || 0), cur)} carries a commission signal`} />
        <Stat k="Ad-driven" tone="paid" basis="measured"
          v={money(a?.measured_paid_gmv, cur)}
          sub={`${pct(a?.paid_share_of_measured)} of what we can attribute`} />
        <Stat k="Organic" tone="organic" basis="measured"
          v={money(a?.measured_organic_gmv, cur)}
          sub={`${pct(a?.paid_share_of_measured == null ? null : 1 - Number(a.paid_share_of_measured))} of what we can attribute`} />
      </div>

      <RoasCard roas={roasQ.data} loading={roasQ.isLoading} a={a} cur={cur} />

      <ChannelChart rows={dailyQ.data} loading={dailyQ.isLoading} cur={cur} />

      <CreatorsCard rows={creatorsQ.data} loading={creatorsQ.isLoading} cur={cur} />
    </div>
  );
}

// ── the whole-shop bar ──────────────────────────────────────────────────────
// Six segments that sum to total GMV exactly — verified by
// scripts/check-attribution.mjs against Seller Center, to the cent.
function AttributionCard({ a, shop, cur }) {
  const total = Number(a.total_gmv) || 0;
  const segs = [
    { key: 'paid',    cls: 'seg-paid',    label: 'Ad-driven',              value: Number(a.measured_paid_gmv),
      hint: 'Shop Ads commission — TikTok billed the sale to paid delivery' },
    { key: 'organic', cls: 'seg-organic', label: 'Organic',                value: Number(a.measured_organic_gmv),
      hint: 'Standard commission — the creator posted for their own rate' },
    { key: 'gap',     cls: 'seg-gap',     label: 'Affiliate, no line data', value: Number(a.affiliate_unmeasured_gmv),
      hint: 'Seller Center reports this affiliate revenue but no order lines reached us' },
    { key: 'seller',  cls: 'seg-seller',  label: 'Seller video',           value: Number(a.seller_video_gmv),
      hint: "The shop's own videos — no commission programme, so nothing says what drove them" },
    { key: 'live',    cls: 'seg-live',    label: 'LIVE',                   value: Number(a.live_gmv),
      hint: 'Livestream sales — measured 0% ad-driven wherever we do have evidence' },
    { key: 'card',    cls: 'seg-card',    label: 'Product card',           value: Number(a.product_card_gmv),
      hint: 'Shop tab, search and product-page sales — no attribution signal available yet' },
  ];

  const coverage = a.attribution_coverage == null ? null : Number(a.attribution_coverage);
  const organicShare = a.paid_share_of_measured == null ? null : 1 - Number(a.paid_share_of_measured);

  return (
    <div className="card pad">
      <div className="k">Where {shop.shop_name}&rsquo;s revenue came from <Basis kind="measured" /></div>

      <div className="headline">
        Of the <em style={{ color: 'var(--accent)' }}>{pct(coverage, 0)}</em> we can attribute,{' '}
        <em style={{ color: 'var(--organic)' }}>{pct(organicShare)}</em> would have happened without your ads.
      </div>

      <div className="stack">
        {segs.map((s) => s.value > 0 && (
          <div key={s.key} className={s.cls}
            style={{ width: `${(s.value / total) * 100}%` }}
            title={`${s.label} — ${moneyExact(s.value, cur)} (${((s.value / total) * 100).toFixed(1)}%)\n${s.hint}`} />
        ))}
      </div>

      <div className="keys">
        {segs.map((s) => (
          <div key={s.key} className="keyrow">
            <span className={`sw ${s.cls}`} />
            <span style={{ minWidth: 0 }}>
              <span className="lb">{s.label}</span><br />
              <span className="vl">{money(s.value, cur)}</span>{' '}
              <span className="muted">{total ? `${((s.value / total) * 100).toFixed(1)}%` : ''}</span>
            </span>
          </div>
        ))}
      </div>

      <p className="muted" style={{ fontSize: 12, marginTop: 16, marginBottom: 0, lineHeight: 1.55 }}>
        The first two segments are the only revenue with hard evidence of what caused it: TikTok pays each
        affiliate order either a Shop Ads commission or a standard one, and which programme paid says what
        drove the sale. The grey segments have no such signal, so they are left unsplit — applying the
        affiliate rate to them would be a guess dressed as a measurement.
        {Number(a.other_affiliate_gmv) > 0 && (
          <> Where we do have evidence inside those channels — {money(a.other_affiliate_gmv, cur)} of
          Showcase, Livestream and External Traffic orders — it measured{' '}
          <strong>{moneyExact(a.other_affiliate_paid_gmv, cur)} ad-driven</strong>, which is why they are
          treated as structurally organic rather than proportionally split.</>
        )}
      </p>
    </div>
  );
}

// ── the comparison that justifies the product ───────────────────────────────
function RoasCard({ roas, loading, a, cur }) {
  if (loading) return <Card title="Return on ad spend"><Skeleton h={90} /></Card>;

  if (!roas) {
    return (
      <Note tone="info">
        <div>
          <strong>Return on ad spend is not shown — there is no spend to divide by.</strong>
          <div style={{ marginTop: 4 }}>
            Reacher has no GMV Max campaigns cached for this shop because the ad account has never been
            connected there. This page can say what <em>share</em> of revenue the ads drove, but not what
            it returned per dollar. Connect the account in Reacher and this card fills in on the next sync.
          </div>
        </div>
      </Note>
    );
  }

  // Number(null) is 0, so every one of these has to be guarded explicitly.
  // Printing a confident "0.00" where the truth is "we do not have this" is
  // exactly the failure this whole product exists to avoid.
  const numOrNull = (v) => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const fixed = (v) => (v == null ? '—' : v.toFixed(2));

  const sim = roas.is_simulated === true;
  const ceiling = numOrNull(roas.reported_roi);
  const floor = numOrNull(roas.verified_roas);
  const surface = numOrNull(roas.affiliate_surface_roas);
  const share = numOrNull(roas.unverified_share);

  return (
    <div className="card pad">
      <div className="k">
        Return on ad spend <Basis kind={sim ? 'simulated' : 'measured'} />
      </div>
      <div className="headline" style={{ fontSize: 23 }}>
        The real return is between <em style={{ color: 'var(--paid)' }}>{fixed(floor)}</em> and{' '}
        <em style={{ color: 'var(--text-muted)' }}>{fixed(ceiling)}</em>
        {share != null && <> — <em style={{ color: 'var(--warning)' }}>{pct(share, 0)}</em> of what GMV Max
          claims has no evidence behind it.</>}
      </div>

      {/* The band, drawn. The proven part is solid; the claimed part is hatched,
          because it is a claim rather than a measurement. */}
      {floor != null && ceiling != null && ceiling > 0 && (
        <>
          <div className="stack" style={{ height: 30 }}>
            <div className="seg-paid" style={{ width: `${Math.min(100, (floor / ceiling) * 100)}%` }}
              title={`Proven: ${fixed(floor)} — every dollar carries a Shop Ads commission`} />
            <div className="seg-gap" style={{ width: `${Math.max(0, 100 - (floor / ceiling) * 100)}%` }}
              title={`Claimed but unevidenced: up to ${fixed(ceiling)}`} />
          </div>
          <div className="legend">
            <span><i className="dot" style={{ background: 'var(--paid)' }} />
              <strong>{fixed(floor)}</strong> proven <span className="muted">— commission evidence</span></span>
            <span><i className="dot" style={{ background: 'var(--border-default)' }} />
              up to <strong>{fixed(ceiling)}</strong> claimed <span className="muted">— GMV Max&rsquo;s own figure</span></span>
          </div>
        </>
      )}

      <div className="grid g4" style={{ marginTop: 16 }}>
        <Stat k="Spend" v={money(roas.spend, cur)} sub={`${roas.days_with_spend} days with spend`} />
        <Stat k="GMV Max claims" v={money(roas.reported_revenue, cur)} sub={`a return of ${fixed(ceiling)}`} />
        <Stat k="We can verify" tone="paid" v={money(roas.verified_paid_gmv, cur)}
          sub={`a return of ${fixed(floor)}`} />
        <Stat k="Unevidenced" tone="warning" v={money(roas.unverified_revenue, cur)}
          sub={share == null ? '—' : `${pct(share)} of the claim`} />
      </div>

      <p className="muted" style={{ fontSize: 12, marginTop: 14, marginBottom: 0, lineHeight: 1.55 }}>
        GMV Max buys delivery across affiliate video, product card and brand. Only the affiliate surface
        leaves commission evidence, so only its revenue can be positively verified — that is the floor, and
        every dollar in it is certainly ad-driven. The gap above it is <em>either</em> revenue the ads really
        drove on the other surfaces <em>or</em> organic sales being counted toward the campaign, and nothing
        available today separates the two. Reacher exposes spend by surface but not revenue by surface;
        that one addition would close the band.
        {surface != null && <> For reference, the affiliate surface on its own returns <strong>{fixed(surface)}</strong>.</>}
        {' '}Refunds are not netted out of either side.
      </p>
    </div>
  );
}

function ChannelChart({ rows, loading, cur }) {
  const data = (rows || []).map((d) => ({
    day: String(d.day).slice(5),
    'Ad-driven': Number(d.measured_paid_gmv) || 0,
    Organic: Number(d.measured_organic_gmv) || 0,
    'Affiliate (no line data)': Number(d.affiliate_unmeasured_gmv) || 0,
    'Seller video': Number(d.seller_video_gmv) || 0,
    LIVE: Number(d.live_gmv) || 0,
    'Product card': Number(d.product_card_gmv) || 0,
  }));

  const series = [
    ['Ad-driven', 'var(--paid)'],
    ['Organic', 'var(--organic)'],
    ['Affiliate (no line data)', 'var(--border-default)'],
    ['Seller video', 'var(--text-muted)'],
    ['LIVE', 'var(--text-muted)'],
    ['Product card', 'var(--surface-3)'],
  ];

  return (
    <Card title="Daily revenue by channel" sub="Stacked to the shop total — the coloured band is the part we can attribute">
      {loading ? <Skeleton h={260} /> : (
        <div style={{ height: 290 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 6, right: 8, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} minTickGap={18} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false}
                tickFormatter={(v) => money(v, cur)} width={62} />
              <Tooltip formatter={(v, n) => [moneyExact(v, cur), n]}
                contentStyle={{ background: 'var(--surface-1)', border: '1px solid var(--border-default)', borderRadius: 10, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11.5 }} />
              {series.map(([k, c]) => (
                <Area key={k} type="monotone" dataKey={k} stackId="1" stroke={c} fill={c}
                  fillOpacity={k === 'Ad-driven' || k === 'Organic' ? 0.32 : 0.16} />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

function CreatorsCard({ rows, loading, cur }) {
  return (
    <Card title="Top creators" sub="Who drove revenue — and whether your ads paid for it" pad={false}>
      {loading ? <div className="pad"><Skeleton h={160} /></div> : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Creator</th><th className="num">Lines</th><th className="num">GMV</th>
                <th className="num">Ad-driven</th><th className="num">Organic</th>
                <th style={{ width: 130 }}>Ad share</th>
              </tr>
            </thead>
            <tbody>
              {(rows || []).map((r) => (
                <tr key={r.creator_handle}>
                  <td>@{r.creator_handle}</td>
                  <td className="num muted">{r.lines}</td>
                  <td className="num"><strong>{moneyExact(r.gmv, cur)}</strong></td>
                  <td className="num" style={{ color: 'var(--paid)' }}>{moneyExact(r.paid_gmv, cur)}</td>
                  <td className="num" style={{ color: 'var(--organic)' }}>{moneyExact(r.organic_gmv, cur)}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <MiniBar value={r.paid_share} />
                      <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>{pct(r.paid_share, 0)}</span>
                    </div>
                  </td>
                </tr>
              ))}
              {!rows?.length && <tr><td colSpan={6} className="muted" style={{ padding: 18 }}>No creators in this period.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// Never let a number sit on screen without saying how much to trust it.
function DataQuality({ shop, attribution, roas }) {
  const notes = [];
  const a = attribution;

  if (roas?.is_simulated) {
    notes.push(<div key="sim" className="simbar">
      <span style={{ fontSize: 17 }}>⚠</span>
      <span>
        <b>Ad spend on this page is simulated.</b> The ad account is not connected in Reacher yet, so there
        is no real spend to read. Revenue is measured from real orders; spend and GMV Max&rsquo;s reported
        figures are generated to demonstrate the comparison. Remove them with <code>npm run demo:purge</code>.
      </span>
    </div>);
  }

  if (shop.affiliate_connected === false) {
    notes.push(<Note key="disc" tone="warn">
      Reacher shows this shop&rsquo;s affiliate integration as <strong>disconnected</strong>. Historical orders
      still load, but new ones may not be arriving, so the measured slice can be understated.
    </Note>);
  }

  if (a?.affiliate_capture != null && Number(a.affiliate_capture) < 0.95) {
    notes.push(<Note key="cap" tone="warn">
      Our order lines account for <strong>{pct(a.affiliate_capture)}</strong> of the affiliate revenue Seller
      Center reports for this window. The paid/organic split describes that portion.
    </Note>);
  }

  if (!notes.length) return null;
  return <div className="grid" style={{ gap: 10 }}>{notes}</div>;
}
