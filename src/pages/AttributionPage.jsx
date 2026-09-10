// Attribution — the paid/organic decomposition, in one place.
//
// ── PROTECTED COPY ─────────────────────────────────────────────────────────
// The owner reviewed the critique that this page's language promises more
// certainty than the evidence supports, and REJECTED it. The classification
// rules, the attribution interpretation, the floor/ceiling framing, the phrase
// "Proven return" and the statement about revenue that would have happened
// without ads are all preserved here with their substantive meaning intact.
// They have been MOVED — some of them now sit inside a disclosure next to the
// numbers they explain — and their wording is centralised in copy.js so it
// stays consistent. Nothing more.
//
// Do not replace these with "partial commission-attributed ROAS" or other
// uncertainty-oriented rewrites. That is a deliberate, recorded decision, and
// scripts/copy-guard.mjs fails the build if the wording drifts.
//
// ── WHAT THE REDESIGN CHANGED ──────────────────────────────────────────────
// Three sections, named for what they hold: Revenue mix, Return on ad spend,
// Reconciliation. Reconciliation used to be four metric cards inside another
// rounded card, above everything else, so a data-quality footnote was the first
// and loudest thing on the page. It is now one flat region at the bottom: the
// four figures as a definition list, one sentence about the daily exceptions,
// and the individual dates behind a disclosure.
import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  shopAttribution, shopReconciliation, shopChannelDaily, shopPaidRoas,
  money, moneyExact, pct, fixed, numOrNull,
} from '../lib/api.js';
import ReportToolbar from '../components/ReportToolbar.jsx';
import ChannelChart from '../components/ChannelChart.jsx';
import {
  Panel, PageHeader, MetricSummary, Notice, Skeleton, EmptyState, SourceTag, Hint,
} from '../components/ui.jsx';
import { COPY } from '../lib/copy.js';
import { DECISION_RECON_TOLERANCE } from '../lib/decide.js';
import EvidenceBasis from '../components/EvidenceBasis.jsx';

/**
 * ONE definition of a channel: where its amount comes from, what colour stands
 * for it, what it means, and which denominators it may legitimately be divided
 * by. The bar, the table and the chart legend all read this, so a channel
 * cannot be one colour in one place and another colour ten pixels away.
 *
 * `classified` — carries a commission signal, so it belongs in the classified
 * affiliate denominator. `ofAffiliate` — is affiliate revenue at all, so a
 * share of Seller Center's affiliate figure is a meaningful number for it.
 */
const CHANNELS = [
  { key: 'paid',    field: 'measured_paid_gmv',        label: 'Ad-driven (Shop Ads commission)', short: 'Ad-driven',
    colour: 'var(--series-paid)',    hint: COPY.seg.paid,     classified: true,  ofAffiliate: true },
  { key: 'organic', field: 'measured_organic_gmv',     label: 'Organic (standard commission)',   short: 'Organic',
    colour: 'var(--series-organic)', hint: COPY.seg.organic,  classified: true,  ofAffiliate: true },
  { key: 'gap',     field: 'affiliate_unmeasured_gmv', label: 'Affiliate, no line data',         short: 'Affiliate, no line data',
    colour: 'var(--series-gap)',     hint: COPY.seg.gap,      classified: false, ofAffiliate: true },
  // DIAGNOSTIC, NOT A CHANNEL. This is the amount by which our own affiliate
  // lines exceed Seller Center's affiliate figure — money that is ALREADY
  // inside Ad-driven and Organic above. Listing it as a seventh revenue
  // component added it to the total a second time and made every reported gap
  // exactly twice the real disagreement ($140.68 for a $70.34 excess). It is
  // rendered below the components, outside the sum. See migration 022.
  { key: 'over',    field: 'affiliate_overflow_gmv',   label: 'Affiliate, excess over source',   short: 'Affiliate, excess',
    colour: 'var(--series-excess)',  hint: COPY.seg.overflow, classified: false, ofAffiliate: true,
    diagnostic: true },
  { key: 'seller',  field: 'seller_video_gmv',         label: 'Seller video',                    short: 'Seller video',
    colour: 'var(--series-seller)',  hint: COPY.seg.seller,   classified: false, ofAffiliate: false },
  { key: 'live',    field: 'live_gmv',                 label: 'LIVE',                            short: 'LIVE',
    colour: 'var(--series-live)',    hint: COPY.seg.live,     classified: false, ofAffiliate: false },
  { key: 'card',    field: 'product_card_gmv',         label: 'Product card',                    short: 'Product card',
    colour: 'var(--series-card)',    hint: COPY.seg.card,     classified: false, ofAffiliate: false },
];

/**
 * ONE share basis at a time, explicitly chosen.
 *
 * The table carried all three denominators side by side, so reading a single
 * row meant deciding which of three percentages answered your question — and
 * two of them are undefined for some channels, printing a dash that looks like
 * missing data rather than "this share is meaningless here". A denominator is a
 * question; you ask one at a time.
 */
const BASES = {
  total: {
    label: 'Of total shop GMV',
    value: (d) => d.total,
    why: 'every channel is part of it, so every row has a meaningful share',
  },
  affiliate: {
    label: 'Of affiliate GMV',
    value: (d) => d.affiliate,
    why: "Seller Center's affiliate video figure — only affiliate rows have a share of it",
  },
  classified: {
    label: 'Of classified affiliate',
    value: (d) => d.classified,
    why: 'only the lines carrying a commission signal',
  },
};

/** A dash here means "this share would not mean anything", not "unknown". */
function shareIn(seg, basis, d) {
  if (basis === 'affiliate') return d.affiliate && seg.ofAffiliate ? pct(seg.value / d.affiliate, 1) : '—';
  if (basis === 'classified') return d.classified && seg.classified ? pct(seg.value / d.classified, 1) : '—';
  return d.total ? pct(seg.value / d.total, 1) : '—';
}

const Swatch = ({ colour }) => (
  <i aria-hidden="true" style={{
    width: 10, height: 10, borderRadius: 2, flex: '0 0 auto',
    background: colour || 'transparent',
  }} />
);

/**
 * The track a proportional bar is drawn in. Layout only — every colour inside
 * it is a --series-* token supplied by the caller, so the revenue mix bar and
 * the return band cannot drift into two slightly different bars.
 */
const SplitBar = ({ children }) => (
  <div style={{
    display: 'flex', height: 14, overflow: 'hidden',
    borderRadius: 'var(--r-pill)', background: 'var(--surface-sunken)',
  }}>
    {children}
  </div>
);

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

  const header = (
    <PageHeader
      title="Attribution"
      sub={`${shop.shop_name} · ${scope.start} → ${scope.end}`}
      right={<ReportToolbar scope={scope} shop={shop} />}
    />
  );

  if (attrQ.error) {
    return (
      <>
        {header}
        <Notice tone="error">Could not load attribution for this window: {attrQ.error.message}</Notice>
      </>
    );
  }

  // Nothing asserts a number before it exists: the summary shows its own
  // skeletons rather than five zeroes that would each read as a measurement.
  if (attrQ.isPending) {
    return (
      <>
        {header}
        <MetricSummary items={[]} loading />
        <Panel title="Revenue mix"><Skeleton h={200} /></Panel>
      </>
    );
  }

  const a = attrQ.data;
  if (!a || !Number(a.days_covered)) {
    return (
      <>
        {header}
        <Panel>
          <EmptyState title="No channel data for this window">
            Seller Center figures have not been collected for {scope.start} → {scope.end}.
          </EmptyState>
        </Panel>
      </>
    );
  }

  const roas = roasQ.data;
  const simulated = roas?.is_simulated === true;
  const coverage = numOrNull(a.attribution_coverage);
  const organicShare = a.paid_share_of_measured == null ? null : 1 - Number(a.paid_share_of_measured);
  const classified = (Number(a.measured_paid_gmv) || 0) + (Number(a.measured_organic_gmv) || 0);

  // One source mode for the region; the return metric carries its own tag when
  // this shop's spend side is simulated and the revenue side is not.
  const metrics = [
    {
      label: 'Shop GMV', value: money(numOrNull(a.total_gmv), cur),
      context: `${Number(a.days_covered) || 0} days covered`,
      hint: `Total TikTok Shop GMV from Seller Center for ${scope.start} to ${scope.end}, in the shop's reporting timezone.`,
    },
    {
      label: 'Attributed', value: pct(coverage, 0),
      context: 'of shop GMV carries a commission signal',
      hint: 'The share of revenue whose order lines say which programme paid the commission. Everything else is left unsplit.',
    },
    {
      label: 'Ad-driven', value: money(numOrNull(a.measured_paid_gmv), cur),
      context: classified
        ? `${pct(Number(a.measured_paid_gmv) / classified)} of attributed revenue`
        : 'nothing classified in this window',
      hint: COPY.seg.paid,
    },
    {
      label: 'Organic', value: money(numOrNull(a.measured_organic_gmv), cur),
      context: organicShare == null
        ? 'nothing classified in this window'
        : `${pct(organicShare)} of attributed revenue`,
      hint: COPY.seg.organic,
    },
    {
      // PROTECTED WORDING — unchanged in meaning and certainty.
      label: 'Proven return',
      value: roas ? fixed(roas.verified_roas) : '—',
      source: roas ? (simulated ? 'simulated' : 'measured') : undefined,
      context: roas
        ? `${money(numOrNull(roas.verified_paid_gmv), cur)} carries Shop Ads commission`
        : roasQ.error ? 'spend data could not be loaded' : 'ad account not connected',
      hint: 'Revenue whose commission proves the ads drove it, divided by ALL spend. Every dollar in it is certainly ad-driven, so this is the floor of the band.',
    },
  ];

  return (
    <>
      {header}

      {/* `isPending`, not `isLoading`: a query that is pending but NOT fetching
          — offline, or paused — reports isLoading false with no data, and the
          spend-side fallback above ("ad account not connected") is a claim
          about the shop, not a way to render a query that has not answered. */}
      <MetricSummary items={metrics} source="measured" loading={roasQ.isPending} />

      <RevenueMix a={a} cur={cur} />

      {/* The SAME pounds as the mix above, re-labelled by how well each is
          evidenced. Placed immediately after it so the relationship is
          obvious: this is not more revenue, it is the same revenue seen a
          second way. The partition sums to the component total exactly, and
          the residual is shown outside it. */}
      <EvidenceBasis shop={shop} scope={scope} />

      {dailyQ.error ? (
        <Panel title="Daily revenue by channel">
          <Notice tone="error">
            The day-level channel rows could not be loaded: {dailyQ.error.message}
          </Notice>
        </Panel>
      ) : (
        <ChannelChart rows={dailyQ.data} loading={dailyQ.isPending} cur={cur} />
      )}

      <ReturnOnAdSpend roas={roas} loading={roasQ.isPending} error={roasQ.error} cur={cur} />

      <Reconciliation
        a={a} recon={reconQ.data} reconLoading={reconQ.isPending}
        daily={dailyQ.data} dailyLoading={dailyQ.isPending} cur={cur}
      />
    </>
  );
}

/* ── revenue mix ──────────────────────────────────────────────────────────── */

/**
 * The whole-shop decomposition. PROTECTED interpretation — moved, not
 * rewritten: the headline sentence is unchanged, and the explanation of why the
 * grey segments are left unsplit now sits in a disclosure under the numbers it
 * is about, rather than as a full-width paragraph nobody read.
 */
function RevenueMix({ a, cur }) {
  // Default to the one denominator every row has a meaningful share of.
  const [basis, setBasis] = useState("total");
  const total = Number(a.total_gmv) || 0;
  const affiliate = Number(a.affiliate_video_sc_gmv) || 0;
  const classified = (Number(a.measured_paid_gmv) || 0) + (Number(a.measured_organic_gmv) || 0);

  const coverage = a.attribution_coverage == null ? null : Number(a.attribution_coverage);
  const organicShare = a.paid_share_of_measured == null ? null : 1 - Number(a.paid_share_of_measured);

  const suppressed = a.reconciliation_status === 'exception';
  const denom = suppressed ? Number(a.component_total) : total;
  const all = CHANNELS.map((c) => ({ ...c, value: Number(a[c.field]) || 0 }));
  // `segs` are the mutually exclusive revenue channels — the things that sum to
  // the components total. Diagnostics sit below that sum, never inside it.
  const segs = all.filter((c) => !c.diagnostic);
  const diagnostics = all.filter((c) => c.diagnostic && c.value > 0.005);

  return (
    <Panel
      title="Revenue mix"
      sub={`Amounts, and each channel's share ${BASES[basis].label.toLowerCase()}.`}
      bodyPad={false}
      right={(
        <div className="row" style={{ gap: 4 }}>
          <span className="meta">Share of</span>
          {Object.entries(BASES).map(([k, b]) => (
            <button key={k} className={`btn btn-sm${basis === k ? " btn-primary" : ""}`}
              aria-pressed={basis === k} onClick={() => setBasis(k)}
              title={`Denominator: ${moneyExact(b.value({ total, affiliate, classified }), cur)} — ${b.why}`}>
              {b.label.replace(/^Of /, "")}
            </button>
          ))}
        </div>
      )}
    >
      <div className="panel-body stack">
        {/* PROTECTED SENTENCE — meaning and certainty preserved. */}
        <p style={{ margin: 0 }}>
          Of the <strong>{pct(coverage, 0)}</strong> we can attribute,{' '}
          <strong>{pct(organicShare)}</strong> {COPY.organicClaim}
        </p>

        {suppressed ? (
          <Notice tone="warn">
            The proportional chart is suppressed for this window: the components sum to{' '}
            {pct(total ? Number(a.component_total) / total : null, 1)} of total shop GMV, so a bar drawn to
            100% would show an agreement that does not exist. The amounts are in the table below.
          </Notice>
        ) : (
          <SplitBar>
            {segs.filter((s) => s.value > 0 && denom > 0).map((s) => (
              <div key={s.key}
                style={{ width: `${(s.value / denom) * 100}%`, background: s.colour }}
                title={`${s.short} — ${moneyExact(s.value, cur)} (${((s.value / denom) * 100).toFixed(1)}%)\n${s.hint}`} />
            ))}
          </SplitBar>
        )}
      </div>

      <div className="tablewrap">
        <table className="data">
          <thead>
            <tr>
              <th className="sticky-l">Channel</th>
              <th className="num">Amount</th>
              <th className="num">
                {BASES[basis].label}
                <Hint text={`Denominator: ${moneyExact(BASES[basis].value({ total, affiliate, classified }), cur)} — ${BASES[basis].why}`} />
              </th>
            </tr>
          </thead>
          <tbody>
            {segs.map((s) => (
              <tr key={s.key}>
                <td className="sticky-l">
                  <span className="row" style={{ gap: 'var(--s2)', flexWrap: 'nowrap' }}>
                    <Swatch colour={s.colour} />
                    <span className="truncate">{s.label}</span>
                    <Hint text={s.hint} />
                  </span>
                </td>
                <td className="num"><strong>{moneyExact(s.value, cur)}</strong></td>
                <td className="num muted">{shareIn(s, basis, { total, affiliate, classified })}</td>
              </tr>
            ))}
            <tr>
              <td className="sticky-l">
                <span className="row" style={{ gap: 'var(--s2)', flexWrap: 'nowrap' }}>
                  <Swatch />
                  <strong>Components total</strong>
                </span>
              </td>
              <td className="num"><strong>{moneyExact(a.component_total, cur)}</strong></td>
              <td className="num"><strong>{basis === 'total' && total ? pct(Number(a.component_total) / total, 1) : '—'}</strong></td>
            </tr>
            <tr>
              <td className="sticky-l">
                <span className="row" style={{ gap: 'var(--s2)', flexWrap: 'nowrap' }}>
                  <Swatch />
                  <span className="muted">Total shop GMV (source)</span>
                </span>
              </td>
              <td className="num">{moneyExact(total, cur)}</td>
              <td className="num muted">{basis === 'total' ? '100.0%' : '—'}</td>
            </tr>

            {/* BELOW THE LINE. Everything above sums; nothing here does. The
                separator is the point — a reader must be able to see at a
                glance which numbers are revenue and which are checks on it. */}
            {diagnostics.length > 0 && (
              <>
                <tr>
                  <td colSpan={3} style={{
                    height: 34, verticalAlign: 'bottom', paddingBottom: 4,
                    borderTop: '2px solid var(--divider)',
                  }}>
                    <span className="meta"><strong>Diagnostics — not revenue, not part of the total above</strong></span>
                  </td>
                </tr>
                {diagnostics.map((s) => (
                  <tr key={s.key}>
                    <td className="sticky-l">
                      <span className="row" style={{ gap: 'var(--s2)', flexWrap: 'nowrap' }}>
                        <Swatch colour={s.colour} />
                        <span className="truncate">{s.label}</span>
                        <Hint text={s.hint} />
                      </span>
                    </td>
                    <td className="num">{moneyExact(s.value, cur)}</td>
                    <td className="num muted">{shareIn(s, basis, { total, affiliate, classified })}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={3} className="meta" style={{ paddingBottom: 10, whiteSpace: 'normal' }}>
                    This amount is already counted inside Ad-driven and Organic above — it is the extent to
                    which our own affiliate line data exceeds Seller Center's affiliate figure, not extra
                    revenue. Adding it to the components would report the same money twice.
                  </td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* PROTECTED PARAGRAPH — the substantive attribution explanation, moved
          into a disclosure. Its wording is untouched. */}
      <details className="panel-body" style={{ borderTop: '1px solid var(--divider)' }}>
        <summary style={{ cursor: 'pointer' }}>Why the grey channels are left unsplit</summary>
        <p className="meta" style={{ margin: '8px 0 0', maxWidth: '78ch' }}>
          {COPY.decompositionExplainer}
          {Number(a.other_affiliate_gmv) > 0 && (
            <> Where we do have evidence inside those channels — {money(a.other_affiliate_gmv, cur)} of
            Showcase, Livestream and External Traffic orders — it measured{' '}
            <strong>{moneyExact(a.other_affiliate_paid_gmv, cur)} ad-driven</strong>, which is why they are
            treated as structurally organic rather than proportionally split.</>
          )}
        </p>
      </details>
    </Panel>
  );
}

/* ── return on ad spend ───────────────────────────────────────────────────── */

/** The band. PROTECTED framing — floor to ceiling, "Proven return". */
function ReturnOnAdSpend({ roas, loading, error, cur }) {
  if (loading) {
    return <Panel title="Return on ad spend"><Skeleton h={120} /></Panel>;
  }

  if (error) {
    return (
      <Panel title="Return on ad spend">
        <Notice tone="error">Spend for this window could not be loaded: {error.message}</Notice>
      </Panel>
    );
  }

  if (!roas) {
    return (
      <Panel title="Return on ad spend">
        <Notice tone="info">
          <strong>Return on ad spend is not shown — there is no spend to divide by.</strong> Reacher has no
          GMV Max campaigns cached for this shop because the ad account has never been connected there.
          This page can say what <em>share</em> of revenue the ads drove, but not what it returned per
          dollar.
        </Notice>
      </Panel>
    );
  }

  const sim = roas.is_simulated === true;
  const ceiling = numOrNull(roas.reported_roi);
  const floor = numOrNull(roas.verified_roas);
  const surface = numOrNull(roas.affiliate_surface_roas);
  const share = numOrNull(roas.unverified_share);
  const provenPct = floor != null && ceiling != null && ceiling > 0
    ? Math.max(0, Math.min(100, (floor / ceiling) * 100))
    : null;

  return (
    <Panel
      title="Return on ad spend"
      sub={sim ? 'Spend for this shop is simulated, so every figure in this section moves with it.' : undefined}
      right={sim ? <SourceTag kind="simulated" /> : undefined}
    >
      <div className="stack">
        {/* PROTECTED SENTENCE. */}
        <p style={{ margin: 0 }}>
          The real return is between <strong>{fixed(floor)}</strong> and <strong>{fixed(ceiling)}</strong>
          {share == null
            ? '.'
            : <> — <strong>{pct(share, 0)}</strong> of what GMV Max claims has no evidence behind it.</>}
        </p>

        {provenPct != null && (
          <div>
            <SplitBar>
              <div style={{ width: `${provenPct}%`, background: 'var(--series-paid)' }}
                title={`Proven: ${fixed(floor)} — every dollar carries a Shop Ads commission`} />
              <div style={{ width: `${100 - provenPct}%`, background: 'var(--series-gap)' }}
                title={`Claimed but unevidenced: up to ${fixed(ceiling)}`} />
            </SplitBar>
            <p className="meta" style={{ margin: '8px 0 0' }}>
              The filled part is <strong>{fixed(floor)}</strong>, the return commission evidence proves;
              the bar ends at <strong>{fixed(ceiling)}</strong>, GMV Max&rsquo;s own figure.
            </p>
          </div>
        )}

        <dl className="dl">
          <dt>Spend</dt>
          <dd>
            {money(numOrNull(roas.spend), cur)}{' '}
            {/* Absent day counts say nothing rather than " days with spend". */}
            {roas.days_with_spend != null && (
              <span className="muted">· {roas.days_with_spend} days with spend</span>
            )}
          </dd>

          <dt>GMV Max claims</dt>
          <dd>
            {money(numOrNull(roas.reported_revenue), cur)}{' '}
            <span className="muted">· a return of {fixed(ceiling)}</span>
          </dd>

          <dt>Proven return</dt>
          <dd>
            {money(numOrNull(roas.verified_paid_gmv), cur)}{' '}
            <span className="muted">· a return of {fixed(floor)}</span>
          </dd>

          <dt>Unevidenced</dt>
          <dd>
            {money(numOrNull(roas.unverified_revenue), cur)}{' '}
            <span className="muted">
              · {share == null ? 'no share available' : `${pct(share)} of the claim`}
            </span>
          </dd>
        </dl>

        {/* PROTECTED PARAGRAPH, moved into a disclosure. */}
        <details>
          <summary style={{ cursor: 'pointer' }}>What sets the floor and the ceiling</summary>
          <p className="meta" style={{ margin: '8px 0 0', maxWidth: '78ch' }}>
            {COPY.bandExplainer}
            {surface != null && <> For reference, the affiliate surface on its own returns <strong>{fixed(surface)}</strong>.</>}
            {' '}Refunds are not netted out of either side.
          </p>
        </details>
      </div>
    </Panel>
  );
}

/* ── reconciliation ───────────────────────────────────────────────────────── */

/**
 * The reconciliation result, built from the canonical data.
 *
 * Source totals, component totals, a SIGNED gap, the tolerance it was judged
 * against and a status. Nothing clamped, nothing normalised to 100%, nothing
 * renamed away — and now one flat region rather than cards inside a card.
 */
function Reconciliation({ a, recon, reconLoading, daily, dailyLoading, cur }) {
  const gap = numOrNull(a.reconciliation_gap);
  const status = a.reconciliation_status;
  const capture = numOrNull(a.affiliate_capture);
  const overflow = numOrNull(a.affiliate_overflow_gmv);

  const badDays = recon?.days_exception ?? 0;
  const totalDays = recon?.days ?? 0;
  // The direction of each day's error, counted server-side, so the copy below
  // can only say what the numbers support.
  const posDays = Number(a?.recon_days_positive) || 0;
  const negDays = Number(a?.recon_days_negative) || 0;
  const bothSigns = posDays > 0 && negDays > 0;

  // The window can reconcile while most days do not, because daily errors in
  // opposite directions cancel. That is precisely what a window-only check
  // cannot see, so it is reported separately.
  const windowOk = status !== 'exception';
  const daysOk = badDays === 0;
  const captureOk = capture == null || (capture > 0.95 && capture <= 1.02);
  const clean = windowOk && daysOk && captureOk;

  // A clean verdict rests on the day-level check, which arrives in its own
  // query. Until it does, `badDays` is 0 because nothing has been counted —
  // not because nothing failed — so the verdict is withheld rather than shown
  // green and flipped to red a moment later. A failure the window already
  // proves needs no such wait.
  const verdictPending = reconLoading && windowOk && captureOk;

  const exceptionDays = (daily || []).filter((d) => d.reconciliation_status === 'exception');
  const explainHigh = capture != null && capture > 1.02;
  const explainLow = capture != null && capture < 0.85;

  return (
    <Panel
      title="Reconciliation"
      sub={clean
        ? undefined
        : 'Two sources describing the same revenue do not agree. The amounts are shown raw — neither has been adjusted to make the other fit.'}
      right={verdictPending
        ? <span className="status status-info">Checking days</span>
        : <span className={`status status-${clean ? 'ok' : 'bad'}`}>{clean ? 'Reconciles' : 'Exception'}</span>}
      bodyPad={false}
    >
      <div className="panel-body stack">
        {/* The day count is only stated once the day-level check has come back.
            "on all 0 days" is a false claim, not a quiet default. */}
        {clean && !verdictPending && (
          <p style={{ margin: 0 }}>
            <strong>Revenue reconciles.</strong> The components sum to total shop GMV within rounding
            {totalDays > 0 && <> on all {totalDays} days</>}
            {capture != null && (
              <>, and order lines account for {pct(capture, 1)} of Seller Center&rsquo;s own affiliate
              figure</>
            )}.
          </p>
        )}

        <dl className="dl">
          <dt>Total shop GMV</dt>
          <dd>{moneyExact(a.total_gmv, cur)} <span className="muted">· Seller Center</span></dd>

          <dt>Components sum to</dt>
          <dd>{moneyExact(a.component_total, cur)} <span className="muted">· our decomposition</span></dd>

          <dt>Difference</dt>
          <dd>
            <strong>{gap == null ? '—' : `${gap > 0 ? '+' : ''}${moneyExact(gap, cur)}`}</strong>{' '}
            {/* The number here was hardcoded to "a 0.5% tolerance" and went stale
                the moment the reporting threshold moved to 10%, so the page was
                naming a rule it was no longer being judged by. Both thresholds
                are stated, because they are genuinely different questions. */}
            <span className="muted">· {pct(a.reconciliation_pct, 2)} of total — flagged on screen above 10%,
              and held back from budget advice above {pct(DECISION_RECON_TOLERANCE, 0)}</span>
          </dd>

          <dt>
            Affiliate capture
            <Hint text="Our order lines over Seller Center's own affiliate video figure. Above 100% is a reconciliation failure, not completeness — it used to be shown as healthy." />
          </dt>
          <dd>
            <strong>{pct(capture, 1)}</strong>{' '}
            <span className="muted">
              · {capture != null && capture > 1
                ? 'we hold MORE than the source reports'
                : 'of Seller Center affiliate GMV'}
            </span>
          </dd>
        </dl>

        {/* THE COPY IS GENERATED FROM THE ACTUAL SIGNS, not from an assumption.
            This previously said "daily errors in opposite directions cancel"
            whenever the window passed and any day failed. On the reviewed
            window all six daily errors were POSITIVE (+18.10, +30.98, +31.54,
            +25.60, +1.80, +32.66) and nothing cancelled at all — the window and
            the days were simply computed differently. Migration 018 makes the
            window the sum of the days, so cancellation is now the only way they
            can diverge, and it is claimed only when the signs prove it. */}
        {totalDays > 0 && (
          <p style={{ margin: 0 }}>
            <strong>{badDays} of {totalDays} days</strong> do not reconcile individually
            {badDays > 0 && bothSigns
              ? <> — and because {posDays} day{posDays === 1 ? '' : 's'} run positive while{' '}
                {negDays} run negative, they partly offset when summed. That is why this is measured
                per day and not only per window.</>
              : badDays > 0 && !bothSigns
                ? <> — all in the same direction ({posDays > 0 ? 'positive' : 'negative'}), so nothing
                  offsets: the window difference is their sum.</>
                : '.'}
            {recon?.worst_day && (
              <> Worst day: {recon.worst_day}, {moneyExact(recon.worst_gap, cur)} ({pct(recon.worst_pct, 1)}).</>
            )}
          </p>
        )}
      </div>

      {badDays > 0 && (
        <details className="panel-body" style={{ borderTop: '1px solid var(--divider)' }}>
          <summary style={{ cursor: 'pointer' }}>The days that do not reconcile, one by one</summary>
          {dailyLoading ? (
            <div style={{ marginTop: 8 }}><Skeleton h={80} /></div>
          ) : exceptionDays.length === 0 ? (
            <p className="meta" style={{ margin: '8px 0 0' }}>
              The day-level rows for this window are not loaded, so the individual dates cannot be listed
              here. The counts above come from the reconciliation summary.
            </p>
          ) : (
            <div className="tablewrap" style={{ marginTop: 8 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th className="sticky-l">Day</th>
                    <th className="num">Total shop GMV</th>
                    <th className="num">Difference</th>
                    <th className="num">Share of that day</th>
                  </tr>
                </thead>
                <tbody>
                  {exceptionDays.map((d) => {
                    const g = numOrNull(d.reconciliation_gap);
                    const dayTotal = Number(d.total_gmv) || 0;
                    return (
                      <tr key={d.day}>
                        <td className="sticky-l">{d.day}</td>
                        <td className="num">{moneyExact(d.total_gmv, cur)}</td>
                        <td className="num">
                          {g == null ? '—' : `${g > 0 ? '+' : ''}${moneyExact(g, cur)}`}
                        </td>
                        <td className="num muted">
                          {g != null && dayTotal ? pct(g / dayTotal, 1) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </details>
      )}

      {(explainHigh || explainLow) && (
        <details className="panel-body" style={{ borderTop: '1px solid var(--divider)' }}>
          <summary style={{ cursor: 'pointer' }}>Why the two sources disagree</summary>
          {explainHigh && (
            <p className="meta" style={{ margin: '8px 0 0', maxWidth: '78ch' }}>
              Our order lines hold <strong>{moneyExact(a.affiliate_video_ours_gmv, cur)}</strong> of
              affiliate video revenue; Seller Center reports{' '}
              <strong>{moneyExact(a.affiliate_video_sc_gmv, cur)}</strong>. The excess{' '}
              {moneyExact(overflow, cur)} cannot be missing data — it is the same sales counted on two
              different bases. Traced day by day it appears on nearly every day at a similar proportion,
              which rules out a day-boundary error and points at what each source includes (shipping, tax,
              and when a cancellation is booked are the usual candidates).
            </p>
          )}
          {explainLow && (
            <p className="meta" style={{ margin: '8px 0 0', maxWidth: '78ch' }}>
              Seller Center reports <strong>{moneyExact(a.affiliate_video_sc_gmv, cur)}</strong> of
              affiliate video GMV; the order-line feed accounts for{' '}
              {moneyExact(a.affiliate_video_ours_gmv, cur)}. Reacher confirmed on 8 September 2026 that
              their transactions feed covers the Creator tab of Affiliate Center and matches
              TikTok&rsquo;s export exactly — the remainder is agency-run <strong>Partner-tab</strong>{' '}
              campaigns, which they do not ingest yet and are adding with a field distinguishing the two.
            </p>
          )}
        </details>
      )}
    </Panel>
  );
}
