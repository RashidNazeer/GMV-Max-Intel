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
import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  syncRuns, shopReconciliation, shopAttribution, shopProductStats, shopPaidRoas,
  moneyExact, pct,
} from '../lib/api.js';
import { Card, Stat, Note, Skeleton, Basis, Hint } from '../components/ui.jsx';

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

export default function DataStatusPage() {
  const { shop, scope, profile } = useOutletContext();
  const [diag, setDiag] = useState(false);
  const cur = shop.currency || 'USD';
  const canSeeDiagnostics = profile?.role === 'boss' || profile?.role === 'ol';

  const runsQ = useQuery({ queryKey: ['runs', shop.id], queryFn: () => syncRuns(shop.id, 12) });
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

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="grid g4">
        <Stat k="Attribution coverage" basis="measured" v={pct(a?.attribution_coverage, 0)}
          sub="of shop GMV carries a commission signal"
          hint="The share of total shop GMV where a commission programme says what drove the sale. The rest is not unattributed by choice — no signal exists for it." />
        <Stat k="Affiliate capture" basis="measured" v={pct(a?.affiliate_capture, 1)}
          tone={a && (Number(a.affiliate_capture) > 1.02 || Number(a.affiliate_capture) < 0.85) ? 'danger' : undefined}
          sub={a && Number(a.affiliate_capture) > 1 ? 'we hold MORE than the source reports' : 'of Seller Center’s affiliate figure'} />
        <Stat k="Days reconciled" basis="measured"
          tone={recon?.days_exception ? 'danger' : undefined}
          v={recon ? `${recon.days_reconciled} / ${recon.days}` : '—'}
          sub={recon?.days_exception ? `${recon.days_exception} days do not add up` : 'all days add up'}
          hint="Measured per day. A window can net to zero while most days are wrong in opposite directions, which is why this is not a window-level check." />
        <Stat k="Ad spend source"
          basis={roasQ.data ? (roasQ.data.is_simulated ? 'simulated' : 'measured') : undefined}
          v={roasQ.data ? (roasQ.data.is_simulated ? 'Demo' : 'Measured') : 'None'}
          sub={roasQ.data ? `${roasQ.data.days_with_spend} days with spend` : 'ad account not connected'}
          hint="Source type is not health. A measured source can still be incomplete, and a simulated one can still be internally consistent." />
      </div>

      {roasQ.data?.is_simulated && (
        <Note tone="warn">
          <div>
            <strong>Ad spend for this shop is simulated.</strong> Revenue is measured from real orders;
            spend and GMV Max&rsquo;s reported figures are generated so the comparison can be demonstrated
            while the ad account is unconnected. Every figure derived from spend carries a
            <span className="basis basis-simulated" style={{ margin: '0 4px' }}>simulated</span> badge, and
            simulated rows never enter the model history for a measured shop — a database trigger refuses
            to let one shop hold both.
          </div>
        </Note>
      )}

      <Card title="Sources" pad={false}
        sub="What each source feeds, when it last succeeded, and what to do when it has not.">
        {runsQ.isLoading ? <div className="pad"><Skeleton h={180} /></div> : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Source</th><th>State</th><th>Last success</th><th className="num">Rows</th><th>What it means</th>
                </tr>
              </thead>
              <tbody>
                {[...latest.entries()].map(([job, r]) => {
                  const meta = JOB_MEANING[job] || { label: job, why: '' };
                  const ok = r.status === 'ok';
                  const ex = ok ? null : explain(r);
                  return (
                    <tr key={job}>
                      <td className="tight">
                        <strong>{meta.label}</strong>
                        <div className="muted" style={{ fontSize: 11.5 }}>{meta.why}</div>
                      </td>
                      <td className="tight">
                        <span className={`chip chip-${ok ? 'ok' : 'bad'}`}>{ok ? 'Healthy' : 'Action required'}</span>
                      </td>
                      <td className="tight muted">
                        {r.started_at ? new Date(r.started_at).toLocaleString() : '—'}
                      </td>
                      <td className="num tight muted">{r.rows_written ?? '—'}</td>
                      <td className="tight">
                        {ok
                          ? <span className="muted">Covering {r.window_start} → {r.window_end}</span>
                          : (
                            <div>
                              <div>{ex.plain}</div>
                              <div style={{ marginTop: 4 }}><strong>Next:</strong> {ex.action}</div>
                            </div>
                          )}
                      </td>
                    </tr>
                  );
                })}
                {!latest.size && (
                  <tr><td colSpan={5} className="muted" style={{ padding: 20 }}>
                    No sync has been recorded for this shop yet.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Fields the provider does not supply"
        sub="Named exactly, so the missing capability is a request rather than a mystery.">
        <table className="plain">
          <tbody>
            <tr>
              <td style={{ width: 210 }}><code>discount_pct</code>, <code>original_price</code></td>
              <td>
                Null on every product and SKU. Without a reference price there is no discount depth, no
                effective price and no seller-funded versus TikTok-funded split — so the whole commercial
                comparison is unavailable rather than zero.
              </td>
            </tr>
            <tr>
              <td>GMV Max revenue by surface</td>
              <td>
                Reacher exposes spend by surface but not revenue by surface. That single addition would
                close the floor-to-ceiling band instead of leaving its width unexplained.
              </td>
            </tr>
            <tr>
              <td>Per-video spend and impressions</td>
              <td>
                Not available at creative level, so cost per order per video cannot be computed and
                "continuing exposure" cannot be tested — which is why a revenue drop is labelled
                Declining GMV rather than fatigue.
              </td>
            </tr>
            <tr>
              <td>Campaign settings and change feed</td>
              <td>
                <code>/settings</code> returns nulls and <code>/changes</code> returns empty, so no history
                exists before our own snapshots began on 8 September 2026. That absence is preserved as a
                state; it is not reconstructed.
              </td>
            </tr>
            <tr>
              <td>Partner-tab affiliate orders</td>
              <td>
                Reacher&rsquo;s transactions feed covers the Creator tab only. Agency-run Partner campaigns
                are being added with a field distinguishing the two — confirmed 8 September 2026.
              </td>
            </tr>
          </tbody>
        </table>
      </Card>

      {canSeeDiagnostics && (
        <Card title="Diagnostics"
          right={<button className="btn" onClick={() => setDiag((v) => !v)}>{diag ? 'Hide' : 'Show'}</button>}
          sub="Endpoint names, job internals and raw errors. Not part of the buyer workflow.">
          {diag && (
            <div className="scroll">
              <table>
                <thead><tr><th>Job</th><th>Status</th><th>Window</th><th className="num">Rows</th><th>Raw error</th></tr></thead>
                <tbody>
                  {runs.map((r, i) => (
                    <tr key={i}>
                      <td className="tight"><code>{r.job}</code></td>
                      <td className="tight">{r.status}</td>
                      <td className="tight muted">{r.window_start} → {r.window_end}</td>
                      <td className="num tight muted">{r.rows_written ?? '—'}</td>
                      <td className="tight muted" style={{ maxWidth: 400 }}>
                        <span className="truncate" style={{ display: 'block' }} title={r.error || ''}>{r.error || '—'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {recon?.days_exception > 0 && (
        <Note tone="warn">
          <div>
            <strong>{recon.days_exception} of {recon.days} days do not reconcile.</strong> The absolute
            error across the window is {moneyExact(recon.abs_gap_total, cur)}, netting to{' '}
            {moneyExact(recon.net_gap_total, cur)} — which is how a window-level check can report perfect
            agreement over days that disagree. Worst day {recon.worst_day},{' '}
            {moneyExact(recon.worst_gap, cur)}.
          </div>
        </Note>
      )}
    </div>
  );
}
