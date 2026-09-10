// Data status — coverage, freshness, reconciliation, and what to do about each.
//
// ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
// Nine `npm run …` commands printed in the buyer's workflow, across the
// Overview, Products, Campaigns and the sign-in shell. A terminal command is
// not a recovery action for a media buyer; it is a note the developer left in
// the product. Endpoint names and job internals move into a diagnostics section
// that has to be opened deliberately.
//
// The other thing it replaces: three stacked banners on the Overview. Health
// lives in one control, and this is what that control opens.
//
// ── WHAT THE REDESIGN CHANGED ──────────────────────────────────────────────
// The four health figures are ONE metric region rather than four cards, with a
// single provenance indicator; only the ad spend source carries its own tag,
// because it is the one basis that genuinely differs. The per-source recovery
// steps moved out of a five-column table cell into a drawer, so the table stays
// scannable and the instruction gets room to be a paragraph. And the provider
// gap list is now this page's own section with id="fields", so Products and
// Creatives can link to /data#fields instead of restating it and drifting.
//
// The reconciliation figure keeps its "checking…" state: "all days add up" is a
// CLAIM, and it was previously printed while the check was still running.
import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  syncRuns, shopReconciliation, shopAttribution, shopProductStats, shopPaidRoas, shopSourceHealth,
  moneyExact, pct, numOrNull,
} from '../lib/api.js';
import ReportToolbar from '../components/ReportToolbar.jsx';
import CapabilityPanel from '../components/CapabilityPanel.jsx';
import {
  Panel, PageHeader, MetricSummary, Notice, Drawer, useDrawer,
  Skeleton, EmptyState, SourceTag,
} from '../components/ui.jsx';

/**
 * A sync job, in the buyer's language, with the action that actually resolves
 * it and who can take it.
 */
const JOB_MEANING = {
  affiliate_transactions: {
    label: 'Affiliate order lines',
    why: 'The commission evidence behind every paid/organic split.',
  },
  shop_channels: {
    label: 'Shop channel mix',
    why: 'Seller Center’s own daily split of the whole shop. Without it, nothing can be put in the context of total GMV.',
  },
  videos: {
    label: 'Video metadata',
    why: 'Titles, posting dates and views. Revenue never comes from here.',
  },
  product_catalog: {
    label: 'Product catalogue',
    why: 'Names, prices and stock.',
  },
  product_metrics: {
    label: 'Seller Center funnel',
    why: 'Impressions, clicks and conversion, one row per product per day.',
  },
  gmv_max: {
    label: 'GMV Max campaigns',
    why: 'Spend, budgets and Target ROI.',
  },
};

/** Turn a raw provider error into something a person can act on. */
function explain(run) {
  const e = String(run.error || '');
  if (/no TikTok seller ID/i.test(e)) {
    return {
      plain: 'This shop is not mapped to a TikTok seller account in Reacher, so no data can exist for it at any date.',
      action: 'An administrator needs to complete the shop mapping in Reacher. Changing the date range or re-running a sync will not resolve it.',
      who: 'administrator',
    };
  }
  if (/exceeds maximum of 90 days/i.test(e)) {
    return {
      plain: 'The request asked for more history than Seller Center will serve in one call.',
      action: 'Fixed — the sync now splits any window into 90-day chunks. Re-run it to backfill. Note that Seller Center retains only 90 days, so dates older than that are gone for good and chunking cannot recover them.',
      who: 'administrator',
    };
  }
  if (/timeout|ETIMEDOUT|ECONNRESET|socket/i.test(e)) {
    return {
      plain: 'The connection to Reacher dropped part-way through.',
      action: 'Transient. Re-run the sync; only genuinely failed windows are retried.',
      who: 'administrator',
    };
  }
  return {
    plain: 'This source did not finish collecting.',
    action: 'An administrator should re-run the sync for this shop and window.',
    who: 'administrator',
  };
}

const when = (t) => (t ? new Date(t).toLocaleString() : '—');

/**
 * Describe THIS window's residuals, from its own numbers.
 *
 * `net_gap_total` is the signed sum of the daily gaps; `abs_gap_total` is the
 * sum of their absolute values. The relationship between the two is the whole
 * story and it is arithmetic, not interpretation:
 *
 *   |net| == abs   every day errs in the same direction — nothing cancels
 *   |net| <  abs   days err in both directions and partly offset
 *   abs  == 0      every day genuinely reconciles
 *
 * Saying "errors in opposite directions may cancel" on an all-positive window
 * describes a situation that is not occurring, and sends someone looking for a
 * problem that is not there instead of the one that is.
 */
function reconResidualNote(recon) {
  const base = 'Measured per day, because a window total can hide the days inside it.';
  if (!recon) return `${base} No daily rows have been checked for this window yet.`;

  const abs = Math.abs(Number(recon.abs_gap_total) || 0);
  const net = Number(recon.net_gap_total) || 0;
  if (abs <= 0.005) return `${base} Every day in this window reconciles.`;

  const cancelled = abs - Math.abs(net);
  if (cancelled <= 0.005) {
    return `${base} In this window every daily difference runs the SAME way`
      + `${net > 0 ? ' (our components exceed the source)' : ' (the source exceeds our components)'}`
      + `, so nothing cancels: the net and absolute errors are both the same figure.`;
  }
  return `${base} In this window the daily differences run in both directions and partly offset:`
    + ` they sum to a net ${net.toFixed(2)} while the individual days total ${abs.toFixed(2)}.`
    + ` The net understates the disagreement by ${cancelled.toFixed(2)}.`;
}

export default function DataStatusPage() {
  const { shop, scope, profile } = useOutletContext();
  const [diag, setDiag] = useState(false);
  const jobDrawer = useDrawer();
  const cur = shop.currency || 'USD';
  const canSeeDiagnostics = profile?.role === 'boss' || profile?.role === 'ol';

  const runsQ = useQuery({ queryKey: ['runs', shop.id], queryFn: () => syncRuns(shop.id, 12) });
  // Latest attempt, latest success, stored coverage, and the gap in THIS
  // window — four different facts that "Healthy" was collapsing into one.
  const healthQ = useQuery({
    queryKey: ['srchealth', shop.id, scope.start, scope.end],
    queryFn: () => shopSourceHealth(shop.id, scope.start, scope.end),
  });
  const reconQ = useQuery({
    queryKey: ['recon', shop.id, scope.start, scope.end],
    queryFn: () => shopReconciliation(shop.id, scope.start, scope.end),
  });
  const attrQ = useQuery({
    queryKey: ['attr', shop.id, scope.start, scope.end],
    queryFn: () => shopAttribution(shop.id, scope.start, scope.end),
  });
  const statsQ = useQuery({
    queryKey: ['pstats', shop.id, scope.start, scope.end],
    queryFn: () => shopProductStats(shop.id, scope.start, scope.end),
  });
  const roasQ = useQuery({
    queryKey: ['roas', shop.id, scope.start, scope.end],
    queryFn: () => shopPaidRoas(shop.id, scope.start, scope.end),
  });

  const runs = runsQ.data || [];
  const latest = new Map();
  for (const r of runs) if (!latest.has(r.job)) latest.set(r.job, r);

  const a = attrQ.data;
  const recon = reconQ.data;
  const s = statsQ.data;
  const roas = roasQ.data;
  const capture = numOrNull(a?.affiliate_capture);

  // Which checks could not be read at all. A failed query is not a clean bill
  // of health, and a dash with no reason beside it reads like one.
  const unreadable = [
    attrQ.error && 'coverage',
    reconQ.error && 'reconciliation',
    roasQ.error && 'ad spend',
    statsQ.error && 'the product catalogue',
  ].filter(Boolean);

  const metrics = [
    {
      label: 'Attribution coverage',
      value: pct(a?.attribution_coverage, 0),
      // A dash needs a reason beside it. Without this branch a failed query
      // printed "—" under a caption that reads like a successful reading.
      context: attrQ.isLoading ? 'checking…'
        : a == null ? 'attribution could not be read for this window'
          : 'of shop GMV carries a commission signal',
      hint: 'The share of total shop GMV where a commission programme says what drove the sale. The rest is not unattributed by choice — no signal exists for it.',
    },
    {
      label: 'Affiliate capture',
      value: pct(a?.affiliate_capture, 1),
      tone: capture != null && (capture > 1.02 || capture < 0.85) ? 'neg' : '',
      context: attrQ.isLoading ? 'checking…'
        : capture == null ? 'no affiliate figure to compare against'
          : capture > 1 ? 'we hold more than the source reports'
            : 'of Seller Center’s affiliate figure',
      hint: 'Our stored affiliate order lines as a share of Seller Center’s own affiliate figure for the same days. It is deliberately not clamped: above 100% means the two sources are measuring on different bases, which is the alarm.',
    },
    {
      // "all days add up" is a CLAIM. While recon was still loading it was
      // printed anyway, so the page asserted a clean reconciliation it had not
      // checked yet — caught by a mid-load screenshot.
      label: 'Days reconciled',
      value: recon ? `${recon.days_reconciled} / ${recon.days}` : '—',
      tone: recon?.days_exception ? 'neg' : '',
      context: reconQ.isLoading ? 'checking…'
        : !recon ? 'no daily rows for this window'
          : recon.days_exception ? `${recon.days_exception} days do not add up`
            : 'all days add up',
      // GENERATED FROM THE ACTUAL RESIDUALS, not a standing sentence about what
      // reconciliation can do in general. This page told operators that daily
      // errors in opposite directions may cancel, on a window where the net and
      // absolute errors were BOTH $140.68 — every day wrong in the same
      // direction, nothing cancelling. A true statement about the general case
      // is still a false description of the window in front of you.
      hint: reconResidualNote(recon),
    },
    {
      label: 'Ad spend source',
      value: roasQ.isLoading ? '—' : roas ? (roas.is_simulated ? 'Demo' : 'Measured') : 'None',
      source: roas ? (roas.is_simulated ? 'simulated' : 'measured') : undefined,
      context: roasQ.isLoading ? 'checking…'
        : roas ? `${roas.days_with_spend} days with spend`
          : 'ad account not connected',
      hint: 'Source type is not health. A measured source can still be incomplete, and a simulated one can still be internally consistent.',
    },
  ];

  const openRun = jobDrawer.openId ? latest.get(jobDrawer.openId) : null;
  const openMeta = jobDrawer.openId
    ? (JOB_MEANING[jobDrawer.openId] || { label: jobDrawer.openId, why: '' })
    : null;
  const openWhy = openRun ? explain(openRun) : null;

  return (
    <>
      <PageHeader
        title="Data status"
        sub={`${shop.shop_name} · ${scope.start} → ${scope.end}`}
        right={<ReportToolbar scope={scope} shop={shop} />}
      />

      {unreadable.length > 0 && (
        <Notice tone="error">
          The checks for {unreadable.join(', ')} could not be read, so the figures below are missing
          rather than clean. Reload the page, and if it persists an administrator should look at the
          database connection.
        </Notice>
      )}

      <MetricSummary items={metrics} source="measured" loading={attrQ.isLoading} />

      {recon?.days_exception > 0 && (
        <Notice tone="warn">
          <strong>{recon.days_exception} of {recon.days} days do not reconcile.</strong> The absolute
          error across the window is {moneyExact(recon.abs_gap_total, cur)}, netting to{' '}
          {moneyExact(recon.net_gap_total, cur)} — which is how a window-level check can report perfect
          agreement over days that disagree. Worst day {recon.worst_day},{' '}
          {moneyExact(recon.worst_gap, cur)}.
        </Notice>
      )}

      {roas?.is_simulated && (
        <Notice tone="warn">
          <strong>Ad spend for this shop is simulated.</strong> Revenue is measured from real orders;
          spend and GMV Max&rsquo;s reported figures are generated so the comparison can be demonstrated
          while the ad account is unconnected. Every figure derived from spend carries a{' '}
          <SourceTag kind="simulated" /> tag, and simulated rows never enter the model history for a
          measured shop — a database trigger refuses to let one shop hold both.
        </Notice>
      )}

      {/* WHAT THE INTEGRATION CANNOT DO, AND WHY.
          These states used to live in code comments and a hardcoded constant,
          so an operator could see that an action was unavailable but never
          why, nor when anyone last checked. Reading it from the registry also
          means it stops being a property of the universe: a shop with a
          different ad account permission, or a provider that ships the
          endpoint next month, is one row rather than a code change. */}
      <CapabilityPanel shop={shop} />

      <Panel
        title="Sources"
        sub="What each source feeds, when it last ran, and what to do when it has not finished."
        bodyPad={false}
      >
        {runsQ.isLoading || healthQ.isLoading ? (
          <div className="panel-body"><Skeleton h={180} /></div>
        ) : runsQ.error || healthQ.error ? (
          <div className="panel-body">
            <Notice tone="error">The sync history could not be read: {(runsQ.error || healthQ.error).message}</Notice>
          </div>
        ) : !(healthQ.data || []).length ? (
          <EmptyState title="No sync has been recorded for this shop yet">
            Nothing has been collected for {shop.shop_name}, so every figure on the other tabs is
            absent rather than zero. Starting the first sync is an administrator task.
          </EmptyState>
        ) : (
          <div className="tablewrap">
            <table className="data">
              <thead>
                {/* FIVE FACTS, NOT ONE.
                    "Healthy" was being printed for a source whose coverage
                    ended two days before the selected report, and a failed run
                    read as though the stored history had vanished. The latest
                    attempt, the latest success, the stored coverage and the
                    gap in THIS window are separate columns because they are
                    separate facts. */}
                <tr>
                  <th className="sticky-l">Source</th>
                  <th>State</th>
                  <th>Latest run</th>
                  <th>Data reaches</th>
                  <th>In this report</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(healthQ.data || []).map((h) => {
                  const r = latest.get(h.source);
                  const tone = { complete: 'ok', stale: 'warn', incomplete: 'warn',
                    failing: 'bad', absent: 'info' }[h.state] || 'info';
                  const stateLabel = { complete: 'Complete', stale: 'Behind',
                    incomplete: 'Partial', failing: 'Last run failed', absent: 'No data' }[h.state];
                  return (
                    <tr key={h.source}>
                      <td className="sticky-l">
                        <div><strong>{h.label}</strong></div>
                        <div className="meta">{h.purpose}</div>
                      </td>
                      <td><span className={`status status-${tone}`}>{stateLabel}</span></td>
                      <td className="muted">
                        <div>{h.latest_attempt_status === 'ok' ? 'Succeeded' : h.latest_attempt_status || 'Never run'}</div>
                        <div className="meta">{when(h.latest_attempt_at)}</div>
                      </td>
                      <td className="muted">
                        {h.coverage_end || <span className="muted">—</span>}
                        {h.stale_days > 0 && (
                          <div className="meta">{h.stale_days} day{h.stale_days === 1 ? '' : 's'} behind the report</div>
                        )}
                      </td>
                      <td>
                        {h.complete
                          ? <span className="muted">All {h.window_days} days</span>
                          : (
                            <>
                              <div>{h.covered_days} of {h.window_days} days</div>
                              {h.missing_from && (
                                <div className="meta">missing from {h.missing_from}</div>
                              )}
                            </>
                          )}
                      </td>
                      <td className="num">
                        {(h.state !== 'complete' && r) && (
                          <button className="btn btn-sm" onClick={() => jobDrawer.open(h.source)}>
                            What to do
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* The home for provider gaps. The anchor exists so Products and Creatives
          can link to /data#fields rather than restating any of this and drifting
          from it — those links are not in place on every page yet. */}
      <section id="fields" style={{ scrollMarginTop: 'calc(var(--header-h) + var(--s4))' }}>
        <Panel
          title="Fields the provider does not supply"
          sub="Named exactly, so the missing capability is a request rather than a mystery. Each one is a value that is unavailable, never a zero."
          bodyPad={false}
        >
          <div className="tablewrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="sticky-l">Field or capability</th>
                  <th>What its absence means for the numbers</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="sticky-l" style={{ width: 240 }}>
                    <code>discount_pct</code>, <code>original_price</code>
                  </td>
                  <td>
                    Null on every product and SKU. Without a reference price there is no discount depth, no
                    effective price and no seller-funded versus TikTok-funded split — so the whole commercial
                    comparison is unavailable rather than zero.
                    {s && (
                      <div className="meta" style={{ marginTop: 4 }}>
                        {s.discount_available
                          ? `Checked for ${shop.shop_name}: at least one catalogue product does carry a discount percentage, so the comparison is possible here.`
                          : numOrNull(s.catalog_products)
                            ? `Checked for ${shop.shop_name}: none of the ${Number(s.catalog_products).toLocaleString()} catalogue products carries a discount percentage.`
                            : `No catalogue has been collected for ${shop.shop_name} yet, so there is nothing to check this against.`}
                      </div>
                    )}
                  </td>
                </tr>
                <tr>
                  <td className="sticky-l">GMV Max revenue by surface</td>
                  <td>
                    Reacher exposes spend by surface but not revenue by surface. That single addition would
                    close the floor-to-ceiling band instead of leaving its width unexplained.
                  </td>
                </tr>
                <tr>
                  <td className="sticky-l">Per-video spend and impressions</td>
                  <td>
                    Not available at creative level, so cost per order per video cannot be computed and
                    &ldquo;continuing exposure&rdquo; cannot be tested — which is why a revenue drop is
                    labelled Declining GMV rather than fatigue.
                  </td>
                </tr>
                <tr>
                  <td className="sticky-l">Campaign settings and change feed</td>
                  <td>
                    <code>/settings</code> returns nulls and <code>/changes</code> returns empty, so no history
                    exists before our own snapshots began on 8 September 2026. That absence is preserved as a
                    state; it is not reconstructed.
                  </td>
                </tr>
                <tr>
                  <td className="sticky-l">Partner-tab affiliate orders</td>
                  <td>
                    Reacher&rsquo;s transactions feed covers the Creator tab only. Agency-run Partner campaigns
                    are being added with a field distinguishing the two — confirmed 8 September 2026.
                  </td>
                </tr>
                <tr>
                  <td className="sticky-l">Seller Center funnel for affiliate-only products</td>
                  <td>
                    Impressions, clicks and conversion arrive only for products the funnel feed covers. A
                    product with affiliate orders but no funnel row has unknown traffic, not zero, so it is
                    left out of the product counters rather than counted as a product that sold nothing.
                    {s?.products_affiliate_only > 0 && (
                      <div className="meta" style={{ marginTop: 4 }}>
                        {Number(s.products_affiliate_only).toLocaleString()} product(s) are in that state for
                        this window.
                      </div>
                    )}
                  </td>
                </tr>
                <tr>
                  <td className="sticky-l">Video cover images</td>
                  <td>
                    The video feed carries no cover or thumbnail URL, so every creative shows the same neutral
                    placeholder. Cosmetic only — no figure depends on it — and it is named here so a blank
                    tile is not read as a broken image.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Panel>
      </section>

      {canSeeDiagnostics && (
        <Panel
          title="Diagnostics"
          sub="Endpoint names, job internals and raw errors. Not part of the buyer workflow."
          right={
            <button className="btn btn-sm" onClick={() => setDiag((v) => !v)} aria-expanded={diag}>
              {diag ? 'Hide' : 'Show'}
            </button>
          }
          bodyPad={false}
        >
          {diag ? (
            runs.length ? (
              <div className="tablewrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th className="sticky-l">Job</th>
                      <th>Status</th>
                      <th>Window</th>
                      <th className="num">Rows</th>
                      <th>Raw error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r, i) => (
                      <tr key={`${r.job}-${r.started_at}-${i}`}>
                        <td className="sticky-l"><code>{r.job}</code></td>
                        <td className="muted">{r.status}</td>
                        <td className="muted">{r.window_start || '—'} → {r.window_end || '—'}</td>
                        <td className="num muted">
                          {r.rows_written == null ? '—' : Number(r.rows_written).toLocaleString()}
                        </td>
                        <td className="muted" style={{ maxWidth: 400 }}>
                          <span className="truncate" style={{ display: 'block' }} title={r.error || ''}>
                            {r.error || '—'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="panel-body">
                <p className="muted" style={{ margin: 0 }}>No sync runs are stored for this shop.</p>
              </div>
            )
          ) : null}
        </Panel>
      )}

      <Drawer
        open={!!openRun}
        onClose={jobDrawer.close}
        title={openMeta?.label || 'Source'}
        sub="This source has not finished collecting."
      >
        {openRun && (
          <div className="stack">
            {openMeta?.why && <p style={{ margin: 0 }}>{openMeta.why}</p>}

            <Notice tone="warn">{openWhy.plain}</Notice>

            <div>
              <h3 className="section-title">What to do next</h3>
              <p style={{ margin: '4px 0 0' }}>{openWhy.action}</p>
            </div>

            <dl className="dl">
              <dt>Who can do it</dt>
              <dd>An {openWhy.who}. Nothing on this page changes it for you.</dd>
              <dt>Window attempted</dt>
              <dd>{openRun.window_start || '—'} → {openRun.window_end || '—'}</dd>
              <dt>Last attempt</dt>
              <dd>{when(openRun.started_at)}</dd>
              <dt>Rows written</dt>
              <dd>{openRun.rows_written == null ? '—' : Number(openRun.rows_written).toLocaleString()}</dd>
            </dl>

            {canSeeDiagnostics && openRun.error && (
              <details>
                <summary>Raw error from the provider</summary>
                <p className="mono" style={{ margin: '8px 0 0', overflowWrap: 'anywhere' }}>
                  {openRun.error}
                </p>
              </details>
            )}
          </div>
        )}
      </Drawer>
    </>
  );
}
