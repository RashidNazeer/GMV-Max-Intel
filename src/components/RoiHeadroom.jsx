// Target ROI headroom, in both directions.
//
// ── WHY BOTH DIRECTIONS ARE ALWAYS SHOWN ───────────────────────────────────
// Tightening and relaxing are different questions with different evidence, not
// two ends of one slider:
//
//   Tighter  can the efficiency requirement rise while delivery stays
//            acceptable? Buys efficiency, risks delivery.
//   Looser   would relaxing it unlock useful delivery inside existing economic
//            limits? Buys delivery, risks efficiency.
//
// Showing only the one we happen to have evidence for would let an operator
// assume the other had been considered and rejected.
//
// ── THE STATUS IS THE OUTPUT WHEN A NUMBER IS NOT ──────────────────────────
// Today that is "no history to reason from" everywhere, because settings
// history began on 2026-09-08, no Target ROI change has happened since, and
// Reacher exposes nothing that could recover an earlier one. Saying so is the
// product. The alternative — a default 10% step dressed as a recommendation —
// is what this panel replaced.
//
// Where no evidence-based candidate exists the operator plans the test
// themselves: they choose the setting, and the tool records it, watches it and
// holds them to the criteria they wrote down first.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Panel, Notice, Skeleton, Hint, EmptyState } from './ui.jsx';
import { roiHeadroom, roiEpisodes, ROI_STATUS_LABEL } from '../lib/loopApi.js';
import RecordInterventionDialog from './RecordIntervention.jsx';

const DIRECTION = {
  tighter: {
    label: 'Raise Target ROI',
    asks: 'Can the efficiency requirement rise while delivery stays acceptable?',
    buys: 'efficiency',
    risks: 'delivery',
  },
  looser: {
    label: 'Lower Target ROI',
    asks: 'Would relaxing it unlock useful delivery inside existing economic limits?',
    buys: 'delivery',
    risks: 'efficiency',
  },
};

function DirectionCard({ row, dir, current, onPlan }) {
  const meta = DIRECTION[dir];
  const status = row?.status || 'insufficient_history';
  const evidenced = status === 'eligible_for_review' && row?.candidate != null;

  return (
    <div className="panel" style={{ padding: 'var(--s4)', flex: '1 1 260px', minWidth: 0 }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        <strong>{meta.label}</strong>
        <span className={`status status-${evidenced ? 'ok' : 'info'}`}>
          {ROI_STATUS_LABEL[status] || status}
        </span>
      </div>

      <p className="meta" style={{ margin: '6px 0 10px' }}>{meta.asks}</p>

      <dl className="dl">
        <dt>Now</dt>
        <dd>{current != null ? Number(current).toFixed(2) : <span className="muted">not set</span>}</dd>

        <dt>
          Candidate
          <Hint text="Only ever a setting this campaign has actually run at, and only when at least two clean changes support it. Nothing here extrapolates past the range it has been operated in." />
        </dt>
        <dd>
          {evidenced
            ? <strong>{Number(row.candidate).toFixed(2)}</strong>
            : <span className="muted">none — evidence does not support one</span>}
        </dd>

        <dt>Changes on record</dt>
        <dd>
          {row?.episodes_total || 0}
          {row?.episodes_confounded > 0 && (
            <span className="muted"> · {row.episodes_confounded} unusable</span>
          )}
        </dd>

        {row?.observed_min != null && (
          <>
            <dt>Observed range</dt>
            <dd>{Number(row.observed_min).toFixed(2)} – {Number(row.observed_max).toFixed(2)}</dd>
          </>
        )}
      </dl>

      {row?.supported_note && <p className="meta">{row.supported_note}</p>}

      {/* WHAT THE OPERATOR CAN DO WHEN THE TOOL CANNOT SIZE A STEP. Not a
          dead end: they choose the setting, and the loop takes it from there. */}
      <button className="btn btn-sm" style={{ marginTop: 'var(--s3)' }}
        onClick={() => onPlan(dir)}>
        {evidenced ? 'Plan this test' : 'Plan a test yourself'}
      </button>

      <p className="meta" style={{ marginTop: 6 }}>
        Buys {meta.buys}, risks {meta.risks}. A Target ROI is a bid, not a promise —
        changing it changes what the auction is told to do, not what the campaign returns.
      </p>
    </div>
  );
}

export default function RoiHeadroom({ shop, campaignId, currentRoi, campaignName }) {
  const [planning, setPlanning] = useState(null);

  const hrQ = useQuery({
    queryKey: ['roihead', shop.id],
    queryFn: () => roiHeadroom(shop.id),
  });
  const epQ = useQuery({
    queryKey: ['roiep', shop.id],
    queryFn: () => roiEpisodes(shop.id),
  });

  const forCampaign = hrQ.data?.[campaignId];
  const episodes = (epQ.data || []).filter((e) => e.campaign_id === campaignId);

  return (
    <>
      <Panel
        title="Target ROI headroom"
        sub="Both directions, judged only on changes this campaign has actually made."
      >
        {hrQ.isLoading && <Skeleton h={180} />}
        {hrQ.error && <Notice tone="error">Could not load headroom: {hrQ.error.message}</Notice>}

        {!hrQ.isLoading && !hrQ.error && (
          <>
            <div className="row" style={{ gap: 'var(--s3)', alignItems: 'stretch', flexWrap: 'wrap' }}>
              <DirectionCard row={forCampaign?.tighter} dir="tighter"
                current={currentRoi} onPlan={setPlanning} />
              <DirectionCard row={forCampaign?.looser} dir="looser"
                current={currentRoi} onPlan={setPlanning} />
            </div>

            {/* Episodes are shown as CASES, not as a fitted response. With few
                of them that is all they can honestly be. */}
            {episodes.length > 0 ? (
              <details style={{ marginTop: 'var(--s4)' }}>
                <summary>{episodes.length} recorded change{episodes.length === 1 ? '' : 's'}</summary>
                <div className="tablewrap" style={{ marginTop: 'var(--s3)' }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>When</th><th>Change</th><th className="num">Spend before</th>
                        <th className="num">Spend after</th><th>Usable</th>
                      </tr>
                    </thead>
                    <tbody>
                      {episodes.map((e, i) => (
                        <tr key={i}>
                          <td className="muted">
                            {new Date(e.changed_by).toLocaleDateString()}
                            {Number(e.interval_hours) > 1 && (
                              <Hint text={`We know only that it happened within a ${Number(e.interval_hours).toFixed(0)}-hour window between two observations.`} />
                            )}
                          </td>
                          <td>{Number(e.old_roi).toFixed(2)} → {Number(e.new_roi).toFixed(2)}</td>
                          <td className="num">{e.spend_before == null ? '—' : Number(e.spend_before).toFixed(0)}</td>
                          <td className="num">{e.spend_after == null ? '—' : Number(e.spend_after).toFixed(0)}</td>
                          <td>
                            {e.eligible
                              ? <span className="status status-ok">yes</span>
                              : <span className="status status-info" title={e.excluded_because}>no</span>}
                            {!e.eligible && <div className="meta">{e.excluded_because}</div>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ) : (
              <EmptyState title="No Target ROI change has been observed on this campaign">
                Settings history began on 8 September 2026 and nothing before that can be
                recovered, so this is not a thin evidence base — it is an empty one. Each
                change you make and record from here builds it, and the next recommendation
                can be sized from what this campaign actually did rather than from a default.
              </EmptyState>
            )}
          </>
        )}
      </Panel>

      {planning && (
        <RecordInterventionDialog
          shop={shop}
          prefill={{
            entity_type: 'campaign',
            entity_id: campaignId,
            entity_label: campaignName,
          }}
          onClose={() => setPlanning(null)}
          onSaved={() => { setPlanning(null); hrQ.refetch(); epQ.refetch(); }}
        />
      )}
    </>
  );
}
