// The Decision log — the whole operating loop in one place.
//
// ── WHAT THIS EXISTS FOR ───────────────────────────────────────────────────
// Four records now describe a decision's life: what the tool suggested, what
// the operator chose, what actually changed, and what happened afterwards.
// Until this page they were only writable and readable by machines. An operator
// could not see what they had decided last week, could not record a change they
// made by hand, and could not close the loop on anything.
//
// ── A CHANGE MADE OUTSIDE THE TOOL IS A FIRST-CLASS ROW ────────────────────
// This is deliberately NOT "a list of recommendations". Budgets get changed for
// reasons that never pass through here, and those changes are exactly the
// history a response model needs. They appear in their own right, marked by
// how we know about them.
//
// Filtering is done in SQL. PostgREST truncates a select at 1000 rows, so a
// client-side filter would quietly search whatever subset arrived and then
// report a confident count of it.
import { useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { decisionLog, operatorQueue, LIFECYCLE_LABEL } from '../lib/loopApi.js';
import { actionLabel } from '../lib/decide.js';
import {
  Panel, PageHeader, Notice, Skeleton, EmptyState, Boundary, Hint,
} from '../components/ui.jsx';
import RecordInterventionDialog from '../components/RecordIntervention.jsx';
import ReviewDialog from '../components/ReviewDialog.jsx';

const PAGE = 25;

const KIND_FILTERS = [
  ['', 'Everything'],
  ['recommendation', 'From a recommendation'],
  ['intervention', 'Recorded by hand'],
];

const LIFECYCLE_FILTERS = [
  ['', 'Any state'],
  ['proposed', 'Undecided'],
  ['review_due', 'Review due'],
  ['awaiting_data', 'Waiting for data'],
  ['reviewed', 'Reviewed'],
];

/** How we know a change happened. Never merged — see migration 031. */
function Provenance({ confirmation, policyException }) {
  if (!confirmation) return null;
  const label = confirmation === 'manual_report' ? 'Reported'
    : confirmation === 'snapshot_detected' ? 'Detected'
      : 'Executed';
  const hint = confirmation === 'manual_report'
    ? 'A person told us this happened. The time is as they gave it.'
    : confirmation === 'snapshot_detected'
      ? 'We saw the value change between two observations. Neither who made the change nor its exact moment is knowable from that.'
      : 'Executed through an API with a recorded receipt. This app does not write to TikTok, so this should not appear.';
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
      <span className={`sourcetag sourcetag-${confirmation === 'snapshot_detected' ? 'modelled' : 'measured'}`}>
        {label}
      </span>
      <Hint text={hint} />
      {policyException && (
        <span className="status status-warn" title="Recorded even though the guardrails would have blocked recommending it. Logged truthfully rather than lost.">
          outside guardrails
        </span>
      )}
    </span>
  );
}

function StateCell({ row }) {
  // The review lifecycle wins when there is one: it is the later, more specific
  // state. A recommendation that has been decided and applied is best described
  // by where its review has got to.
  const state = row.review_lifecycle || row.status;
  const tone = state === 'review_due' ? 'warn'
    : state === 'reviewed' ? 'ok'
      : state === 'cancelled' ? 'info' : 'info';
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
      <span className={`status status-${tone}`}>{LIFECYCLE_LABEL[state] || state}</span>
      {row.decision && <span className="muted" style={{ fontSize: 12 }}>{row.decision}</span>}
    </span>
  );
}

/** The result, with what it actually establishes kept beside it. */
function OutcomeCell({ row }) {
  if (!row.metric_outcome) return <span className="muted">—</span>;
  const tone = row.metric_outcome === 'favourable' ? 'ok'
    : row.metric_outcome === 'unfavourable' ? 'bad'
      : 'info';
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
      <span className={`status status-${tone}`}>{row.metric_outcome}</span>
      {/* THE POINT OF SHOWING THE BASIS HERE. "Favourable, observed" means the
          number moved and nothing more was established. Without this beside it,
          a favourable result reads as proof the change caused it. */}
      {row.causal_basis && (
        <span className="muted" style={{ fontSize: 12 }}>
          {row.causal_basis}
          {row.causal_basis === 'observed' && (
            <Hint text="Observed means the number before and the number after. It does not separate this change from anything else happening at the same time." />
          )}
        </span>
      )}
    </span>
  );
}

export default function DecisionLogPage() {
  const { shop } = useOutletContext();
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(0);
  const [recording, setRecording] = useState(false);
  const [reviewing, setReviewing] = useState(null);

  const search = params.get('q') || '';
  const kind = params.get('kind') || '';
  const lifecycle = params.get('state') || '';

  const setFilter = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
    setPage(0);
  };

  const logQ = useQuery({
    queryKey: ['declog', shop.id, search, kind, lifecycle, page],
    queryFn: () => decisionLog(shop.id, {
      search, kind, lifecycle, limit: PAGE, offset: page * PAGE,
    }),
    keepPreviousData: true,
  });

  const queueQ = useQuery({
    queryKey: ['opqueue', shop.id],
    queryFn: () => operatorQueue(shop.id),
  });

  const rows = logQ.data || [];
  const total = Number(rows[0]?.total_count ?? 0);
  const q = queueQ.data;

  return (
    <>
      <PageHeader
        title="Decision log"
        sub="What was suggested, what was decided, what actually changed, and what followed."
        right={(
          <button className="btn btn-primary btn-sm" onClick={() => setRecording(true)}>
            Record a change
          </button>
        )}
      />

      {/* WHAT IS WAITING, SPLIT BY WHY. One number would say how much is
          outstanding without saying what to do about any of it. */}
      {q && (q.reviews_due || q.reviews_waiting || q.undecided || q.deferred_ready) ? (
        <div className="metrics" style={{ marginBottom: 'var(--s4)' }}>
          <QueueCard n={q.reviews_due} label="Review due"
            hint="The observation window has passed and the data has settled. These are ready to judge."
            tone="warn" onClick={() => setFilter('state', 'review_due')} />
          <QueueCard n={q.reviews_waiting} label="Waiting for data"
            hint="Past the review date but the evidence has not settled. Waiting is correct here — scoring these now would score them on half-arrived orders."
            onClick={() => setFilter('state', 'awaiting_data')} />
          <QueueCard n={q.undecided} label="Undecided"
            hint="Recommendations nobody has accepted, modified, rejected or deferred."
            onClick={() => setFilter('state', 'proposed')} />
          <QueueCard n={q.deferred_ready} label="Deferrals now due"
            hint="Deferred with a review date that has arrived. These are work again." />
        </div>
      ) : null}

      <Panel
        title="History"
        sub={total ? `${total.toLocaleString()} ${total === 1 ? 'entry' : 'entries'}` : undefined}
        right={(
          <div className="row" style={{ gap: 8 }}>
            <input
              className="input" placeholder="Search title, entity or action"
              value={search} onChange={(e) => setFilter('q', e.target.value)}
              aria-label="Search the decision log" style={{ minWidth: 220 }}
            />
            <select className="input" value={kind} onChange={(e) => setFilter('kind', e.target.value)}
              aria-label="Filter by origin">
              {KIND_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <select className="input" value={lifecycle} onChange={(e) => setFilter('state', e.target.value)}
              aria-label="Filter by state">
              {LIFECYCLE_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        )}
      >
        <Boundary name="The decision log">
          {logQ.isLoading && <Skeleton h={240} />}
          {logQ.error && <Notice tone="error">Could not load the log: {logQ.error.message}</Notice>}

          {!logQ.isLoading && !rows.length && (
            <EmptyState title={search || kind || lifecycle ? 'Nothing matches those filters' : 'Nothing recorded yet'}>
              {search || kind || lifecycle
                ? 'Clear the filters to see the whole history. An empty result here means no entry matched, not that the shop has no history.'
                : 'Recommendations appear here as they are generated. Use “Record a change” to log something you changed yourself — the tool learns from what happened, not only from what it suggested.'}
            </EmptyState>
          )}

          {!!rows.length && (
            <div className="tablewrap">
              <table className="table">
                <colgroup>
                  <col style={{ width: '26%' }} /><col style={{ width: '14%' }} />
                  <col style={{ width: '13%' }} /><col style={{ width: '14%' }} />
                  <col style={{ width: '15%' }} /><col style={{ width: '10%' }} />
                  <col style={{ width: '8%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th className="sticky-l">What</th>
                    <th>Where</th>
                    <th>When</th>
                    <th>State</th>
                    <th>Result</th>
                    <th>How we know</th>
                    <th className="num" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.kind}-${r.id}`}>
                      <td className="sticky-l">
                        <div className="clamp2" title={r.title}>{r.title}</div>
                        <div className="ident-sub truncate">
                          {r.kind === 'recommendation' ? actionLabel(r.action_code) : r.action_code}
                        </div>
                      </td>
                      <td className="truncate" title={r.entity_label || r.entity_id}>
                        {r.entity_label || r.entity_id || <span className="muted">shop</span>}
                      </td>
                      <td className="muted" style={{ fontSize: 13 }}>
                        {r.occurred_at ? new Date(r.occurred_at).toLocaleDateString() : '—'}
                      </td>
                      <td><StateCell row={r} /></td>
                      <td><OutcomeCell row={r} /></td>
                      <td><Provenance confirmation={r.confirmation} policyException={r.policy_exception} /></td>
                      <td className="num">
                        {r.review_id && r.review_lifecycle !== 'reviewed' && r.review_lifecycle !== 'cancelled' && (
                          <button className="btn btn-sm" onClick={() => setReviewing(r)}>
                            {r.review_lifecycle === 'review_due' ? 'Review' : 'Open'}
                          </button>
                        )}
                        {!r.review_id && (
                          <button className="btn btn-sm btn-quiet"
                            onClick={() => setRecording({ prefill: r })}>
                            Log change
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {total > PAGE && (
            <div className="pager">
              <button className="btn btn-sm" disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}>Previous</button>
              <span className="muted">
                {page * PAGE + 1}–{Math.min(total, (page + 1) * PAGE)} of {total.toLocaleString()}
              </span>
              <button className="btn btn-sm" disabled={(page + 1) * PAGE >= total}
                onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          )}
        </Boundary>
      </Panel>

      {recording && (
        <RecordInterventionDialog
          shop={shop}
          prefill={recording?.prefill}
          onClose={() => setRecording(false)}
          onSaved={() => { setRecording(false); logQ.refetch(); queueQ.refetch(); }}
        />
      )}

      {reviewing && (
        <ReviewDialog
          shop={shop}
          entry={reviewing}
          onClose={() => setReviewing(null)}
          onSaved={() => { setReviewing(null); logQ.refetch(); queueQ.refetch(); }}
        />
      )}
    </>
  );
}

function QueueCard({ n, label, hint, tone, onClick }) {
  const empty = !Number(n);
  return (
    <button
      className="metric" onClick={empty ? undefined : onClick}
      disabled={empty || !onClick}
      style={{
        textAlign: 'left', border: '1px solid var(--divider)',
        background: 'var(--surface)', cursor: empty || !onClick ? 'default' : 'pointer',
        opacity: empty ? 0.55 : 1,
      }}
    >
      <div className="metric-label">
        {label}
        {hint && <Hint text={hint} />}
      </div>
      <div className={`metric-value${tone && !empty ? ` status-${tone}` : ''}`}>{Number(n) || 0}</div>
    </button>
  );
}
