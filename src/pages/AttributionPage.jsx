// Attribution — the paid/organic decomposition, in one place.
//
// ── PROTECTED COPY ─────────────────────────────────────────────────────────
// The owner reviewed the critique that this page's language promises more
// certainty than the evidence supports, and REJECTED it. The classification
// rules, the attribution interpretation, the floor/ceiling framing, the phrase
// "Proven return" and the statement about revenue that would have happened
// without ads are all preserved here with their substantive meaning intact.
// They have been MOVED (the Overview used to repeat them twice) and their
// wording is centralised in copy.js so it stays consistent — nothing more.
//
// Do not replace these with "partial commission-attributed ROAS" or other
// uncertainty-oriented rewrites. That is a deliberate, recorded decision, and
// scripts/copy-guard.mjs fails the build if the wording drifts.
//
// What IS new on this page is the reconciliation result, which is a data
// correctness matter rather than an interpretation one: components that sum to
// more than the total used to render as a tidy 100%.
import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  shopAttribution, shopReconciliation, shopChannelDaily, shopPaidRoas,
  money, moneyExact, pct, fixed, numOrNull,
} from '../lib/api.js';
import { Card, Stat, Note, Skeleton, Empty, Basis, Hint } from '../components/ui.jsx';
import { COPY } from '../lib/copy.js';

export default function AttributionPage() {
  const { shop, scope } = useOutletContext();
  const cur = shop.currency || 'USD';

  const attrQ = useQuery({
    queryKey: ['attr', shop.id, scope.start, scope.end],
    queryFn: () => shopAttribution(shop.id, scope.start, scope.end),
  });
  const reconQ = useQuery({
    queryKey: ['recon', shop.id, scope.start, scope.end],
    queryFn: () => shopReconciliation(shop.id, scope.start, scope.end),
  });
  const dailyQ = useQuery({
    queryKey: ['chdaily', shop.id, scope.start, scope.end],
    queryFn: () => shopChannelDaily(shop.id, scope.start, scope.end),
  });
  const roasQ = useQuery({
    queryKey: ['roas', shop.id, scope.start, scope.end],
    queryFn: () => shopPaidRoas(shop.id, scope.start, scope.end),
  });

  if (attrQ.isLoading) return <div className="card pad"><Skeleton h={240} /></div>;
  const a = attrQ.data;
  if (!a || !Number(a.days_covered)) {
    return <Empty title="No channel data for this window">
      Seller Center figures have not been collected for {scope.start} → {scope.end}.
    </Empty>;
  }

  return (
    <div className="grid" style={{ gap: 16 }}>
      <Reconciliation a={a} recon={reconQ.data} daily={dailyQ.data} cur={cur} />
      <Decomposition a={a} shop={shop} cur={cur} />
      <RoasBand roas={roasQ.data} cur={cur} />
      <ChannelTable a={a} cur={cur} />
    </div>
  );
}

/**
 * The reconciliation result, built from the canonical data.
 *
 * Source totals, component totals, a SIGNED gap, the tolerance it was judged
 * against and a status. Nothing clamped, nothing normalised to 100%, nothing
 * renamed away.
 */
function Reconciliation({ a, recon, daily, cur }) {
  const gap = numOrNull(a.reconciliation_gap);
  const status = a.reconciliation_status;
  const capture = numOrNull(a.affiliate_capture);
  const overflow = numOrNull(a.affiliate_overflow_gmv);

  const badDays = recon?.days_exception ?? 0;
  const totalDays = recon?.days ?? 0;

  // The window can reconcile while most days do not, because daily errors in
  // opposite directions cancel. That is precisely what a window-only check
  // cannot see, so it is reported separately.
  const windowOk = status !== 'exception';
  const daysOk = badDays === 0;

  if (windowOk && daysOk && (capture == null || (capture > 0.95 && capture <= 1.02))) {
    return (
      <Note tone="info">
        <strong>Revenue reconciles.</strong> The components sum to total shop GMV within rounding, on
        all {totalDays} days, and order lines account for {pct(capture, 1)} of Seller Center&rsquo;s own
        affiliate figure.
      </Note>
    );
  }

  return (
    <div className="card pad recon-exception">
      <div className="k">
        Reconciliation exception <Basis kind="measured" />
        <Hint text="Two sources describing the same revenue do not agree. The amounts are shown raw — neither has been adjusted to make the other fit." />
      </div>

      <div className="grid g4" style={{ marginTop: 12 }}>
        <Stat k="Total shop GMV" v={moneyExact(a.total_gmv, cur)} sub="Seller Center" />
        <Stat k="Components sum to" v={moneyExact(a.component_total, cur)}
          tone={windowOk ? undefined : 'danger'} sub="our decomposition" />
        <Stat k="Difference" tone={gap ? 'danger' : undefined}
          v={`${gap > 0 ? '+' : ''}${moneyExact(gap, cur)}`}
          sub={`${pct(a.reconciliation_pct, 2)} of total · tolerance 0.5%`} />
        <Stat k="Affiliate capture" tone={capture > 1.02 || capture < 0.85 ? 'danger' : undefined}
          v={pct(capture, 1)}
          sub={capture > 1 ? 'we hold MORE than the source reports' : 'of Seller Center affiliate GMV'}
          hint="Our order lines over Seller Center's own affiliate video figure. Above 100% is a reconciliation failure, not completeness — it used to be shown as healthy." />
      </div>

      <div style={{ marginTop: 14, fontSize: 13, lineHeight: 1.65 }}>
        {capture > 1.02 && (
          <p style={{ margin: '0 0 10px' }}>
            Our order lines hold <strong>{moneyExact(a.affiliate_video_ours_gmv, cur)}</strong> of affiliate
            video revenue; Seller Center reports <strong>{moneyExact(a.affiliate_video_sc_gmv, cur)}</strong>.
            The excess {moneyExact(overflow, cur)} cannot be missing data — it is the same sales counted on
            two different bases. Traced day by day it appears on nearly every day at a similar proportion,
            which rules out a day-boundary error and points at what each source includes (shipping, tax, and
            when a cancellation is booked are the usual candidates).
          </p>
        )}
        {capture != null && capture < 0.85 && (
          <p style={{ margin: '0 0 10px' }}>
            Seller Center reports <strong>{moneyExact(a.affiliate_video_sc_gmv, cur)}</strong> of affiliate
            video GMV; the order-line feed accounts for {moneyExact(a.affiliate_video_ours_gmv, cur)}.
            Reacher confirmed on 8 September 2026 that their transactions feed covers the Creator tab of
            Affiliate Center and matches TikTok&rsquo;s export exactly — the remainder is agency-run
            <strong> Partner-tab</strong> campaigns, which they do not ingest yet and are adding with a field
            distinguishing the two.
          </p>
        )}
        {totalDays > 0 && (
          <p style={{ margin: 0 }}>
            <strong>{badDays} of {totalDays} days</strong> do not reconcile individually
            {windowOk && badDays > 0 && (
              <> — even though the window total does. Daily errors in opposite directions cancel when
              summed, which is why this is measured per day and not only per window.</>
            )}
            {recon?.worst_day && (
              <> Worst day: {recon.worst_day}, {moneyExact(recon.worst_gap, cur)} ({pct(recon.worst_pct, 1)}).</>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

/** The whole-shop bar. PROTECTED interpretation — moved, not rewritten. */
function Decomposition({ a, shop, cur }) {
  const total = Number(a.total_gmv) || 0;
  const segs = [
    { key: 'paid', cls: 'seg-paid', label: 'Ad-driven', value: Number(a.measured_paid_gmv), hint: COPY.seg.paid },
    { key: 'organic', cls: 'seg-organic', label: 'Organic', value: Number(a.measured_organic_gmv), hint: COPY.seg.organic },
    { key: 'gap', cls: 'seg-gap', label: 'Affiliate, no line data', value: Number(a.affiliate_unmeasured_gmv), hint: COPY.seg.gap },
    { key: 'over', cls: 'seg-over', label: 'Affiliate, excess', value: Number(a.affiliate_overflow_gmv), hint: COPY.seg.overflow },
    { key: 'seller', cls: 'seg-seller', label: 'Seller video', value: Number(a.seller_video_gmv), hint: COPY.seg.seller },
    { key: 'live', cls: 'seg-live', label: 'LIVE', value: Number(a.live_gmv), hint: COPY.seg.live },
    { key: 'card', cls: 'seg-card', label: 'Product card', value: Number(a.product_card_gmv), hint: COPY.seg.card },
  ];

  const coverage = a.attribution_coverage == null ? null : Number(a.attribution_coverage);
  const organicShare = a.paid_share_of_measured == null ? null : 1 - Number(a.paid_share_of_measured);
  const denom = a.reconciliation_status === 'exception' ? Number(a.component_total) : total;

  return (
    <div className="card pad">
      <div className="k">Where {shop.shop_name}&rsquo;s revenue came from <Basis kind="measured" /></div>

      {/* PROTECTED SENTENCE — meaning and certainty preserved verbatim. */}
      <div className="headline">
        Of the <em style={{ color: 'var(--accent)' }}>{pct(coverage, 0)}</em> we can attribute,{' '}
        <em style={{ color: 'var(--organic)' }}>{pct(organicShare)}</em> {COPY.organicClaim}
      </div>

      {a.reconciliation_status === 'exception' ? (
        <Note tone="warn">
          The proportional chart is suppressed for this window: the components sum to{' '}
          {pct(a.component_total / total, 1)} of total shop GMV, so a bar drawn to 100% would show an
          agreement that does not exist. The amounts are in the table below.
        </Note>
      ) : (
        <>
          <div className="stack">
            {segs.map((s) => s.value > 0 && (
              <div key={s.key} className={s.cls}
                style={{ width: `${(s.value / denom) * 100}%` }}
                title={`${s.label} — ${moneyExact(s.value, cur)} (${((s.value / denom) * 100).toFixed(1)}%)\n${s.hint}`} />
            ))}
          </div>
          <div className="keys">
            {segs.map((s) => (
              <div key={s.key} className="keyrow">
                <span className={`sw ${s.cls}`} />
                <span style={{ minWidth: 0 }}>
                  <span className="lb">{s.label}</span><br />
                  <span className="vl">{money(s.value, cur)}</span>{' '}
                  <span className="muted">{denom ? `${((s.value / denom) * 100).toFixed(1)}%` : ''}</span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* PROTECTED PARAGRAPH — the substantive attribution explanation. */}
      <p className="muted" style={{ fontSize: 12, marginTop: 16, marginBottom: 0, lineHeight: 1.55 }}>
        {COPY.decompositionExplainer}
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

/** The band. PROTECTED framing — floor to ceiling, "Proven return". */
function RoasBand({ roas, cur }) {
  if (!roas) {
    return (
      <Note tone="info">
        <div>
          <strong>Return on ad spend is not shown — there is no spend to divide by.</strong>
          <div style={{ marginTop: 4 }}>
            Reacher has no GMV Max campaigns cached for this shop because the ad account has never been
            connected there. This page can say what <em>share</em> of revenue the ads drove, but not what
            it returned per dollar.
          </div>
        </div>
      </Note>
    );
  }

  const sim = roas.is_simulated === true;
  const ceiling = numOrNull(roas.reported_roi);
  const floor = numOrNull(roas.verified_roas);
  const surface = numOrNull(roas.affiliate_surface_roas);
  const share = numOrNull(roas.unverified_share);

  return (
    <div className="card pad">
      <div className="k">Return on ad spend <Basis kind={sim ? 'simulated' : 'measured'} /></div>

      {/* PROTECTED SENTENCE. */}
      <div className="headline" style={{ fontSize: 22 }}>
        The real return is between <em style={{ color: 'var(--paid)' }}>{fixed(floor)}</em> and{' '}
        <em style={{ color: 'var(--text-muted)' }}>{fixed(ceiling)}</em>
        {share != null && <> — <em style={{ color: 'var(--warning)' }}>{pct(share, 0)}</em> of what GMV Max
          claims has no evidence behind it.</>}
      </div>

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
        <Stat k="Proven return" tone="paid" v={money(roas.verified_paid_gmv, cur)} sub={`a return of ${fixed(floor)}`} />
        <Stat k="Unevidenced" tone="warning" v={money(roas.unverified_revenue, cur)}
          sub={share == null ? '—' : `${pct(share)} of the claim`} />
      </div>

      {/* PROTECTED PARAGRAPH. */}
      <p className="muted" style={{ fontSize: 12, marginTop: 14, marginBottom: 0, lineHeight: 1.55 }}>
        {COPY.bandExplainer}
        {surface != null && <> For reference, the affiliate surface on its own returns <strong>{fixed(surface)}</strong>.</>}
        {' '}Refunds are not netted out of either side.
      </p>
    </div>
  );
}

/**
 * Amounts and their denominators, spelled out.
 *
 * "Make each percentage's denominator unambiguous" — share of total shop GMV,
 * share of affiliate GMV and share of classified affiliate GMV are three
 * different numbers and were previously all just "%".
 */
function ChannelTable({ a, cur }) {
  const total = Number(a.total_gmv) || 0;
  const affiliate = Number(a.affiliate_video_sc_gmv) || 0;
  const classified = (Number(a.measured_paid_gmv) || 0) + (Number(a.measured_organic_gmv) || 0);

  const rows = [
    ['Ad-driven (Shop Ads commission)', Number(a.measured_paid_gmv), true],
    ['Organic (standard commission)', Number(a.measured_organic_gmv), true],
    ['Affiliate, no line data', Number(a.affiliate_unmeasured_gmv), false],
    ['Affiliate, excess over source', Number(a.affiliate_overflow_gmv), false],
    ['Seller video', Number(a.seller_video_gmv), false],
    ['LIVE', Number(a.live_gmv), false],
    ['Product card', Number(a.product_card_gmv), false],
  ];

  return (
    <Card title="Channels, with every denominator named" pad={false}>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Channel</th>
              <th className="num">Amount</th>
              <th className="num">of total shop GMV<Hint text={`Denominator: ${moneyExact(total, cur)}`} /></th>
              <th className="num">of affiliate GMV<Hint text={`Denominator: ${moneyExact(affiliate, cur)} — Seller Center's affiliate video figure`} /></th>
              <th className="num">of classified affiliate<Hint text={`Denominator: ${moneyExact(classified, cur)} — only the lines carrying a commission signal`} /></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, v, isClassified]) => (
              <tr key={label}>
                <td className="tight">{label}</td>
                <td className="num tight"><strong>{moneyExact(v, cur)}</strong></td>
                <td className="num tight muted">{total ? pct(v / total, 1) : '—'}</td>
                <td className="num tight muted">{affiliate && (isClassified || label.startsWith('Affiliate')) ? pct(v / affiliate, 1) : '—'}</td>
                <td className="num tight muted">{classified && isClassified ? pct(v / classified, 1) : '—'}</td>
              </tr>
            ))}
            <tr className="row-baseline">
              <td className="tight"><strong>Components total</strong></td>
              <td className="num tight"><strong>{moneyExact(a.component_total, cur)}</strong></td>
              <td className="num tight"><strong>{total ? pct(Number(a.component_total) / total, 1) : '—'}</strong></td>
              <td className="num tight muted">—</td>
              <td className="num tight muted">—</td>
            </tr>
            <tr>
              <td className="tight muted">Total shop GMV (source)</td>
              <td className="num tight">{moneyExact(total, cur)}</td>
              <td className="num tight muted">100.0%</td>
              <td className="num tight muted">—</td>
              <td className="num tight muted">—</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}
