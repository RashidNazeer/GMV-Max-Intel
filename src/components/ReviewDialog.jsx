// Reviewing an outcome.
//
// ── THREE ANSWERS, NOT ONE ─────────────────────────────────────────────────
// The form asks three separate questions and refuses to collapse them:
//
//   Did the number move?     favourable / unfavourable / mixed / not measurable
//   What does that show?     observed / adjusted / modelled / experimental
//   What will you do?        continue / revert / extend / stop / inconclusive
//
// The middle one is the one that matters and the one a simpler form would drop.
// A metric can improve while attribution stays confounded, and "favourable"
// with no basis beside it reads as proof the change caused it. `observed` means
// exactly the number before and the number after.
//
// ── THINGS THIS FORM WILL NOT LET YOU DO ───────────────────────────────────
//   * call a pre/post difference experimental. That is refused server-side
//     unless the plan carries an experiment design, and the option says so.
//   * change the success criteria now. They were frozen when the change was
//     recorded; the amendment path exists but closes once a review is in.
//   * score an intervention that was never carried out as a failure. That is
//     what "not measurable" is for, and it is offered as a first-class answer.
//   * revert anything. Deciding to revert is a decision; the reversal is a
//     separate act that gets recorded as its own intervention.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Drawer, Notice, Hint, Skeleton } from './ui.jsx';
import {
  reviewById, reviewEvents, recordReview, advanceReview, amendReviewCriteria,
  METRIC_OUTCOME, CAUSAL_BASIS, REVIEW_DECISION, LIFECYCLE_LABEL,
} from '../lib/loopApi.js';

export default function ReviewDialog({ shop, entry, onClose, onSaved }) {
  const reviewId = entry.review_id;

  const revQ = useQuery({ queryKey: ['review', reviewId], queryFn: () => reviewById(reviewId) });
  const evQ = useQuery({ queryKey: ['reviewev', reviewId], queryFn: () => reviewEvents(reviewId) });

  const [metricOutcome, setMetricOutcome] = useState('');
  const [causalBasis, setCausalBasis] = useState('observed');
  const [decision, setDecision] = useState('');
  const [resultValue, setResultValue] = useState('');
  const [note, setNote] = useState('');
  const [amendReason, setAmendReason] = useState('');
  const [amendDays, setAmendDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const r = revQ.data;
  const due = r?.lifecycle === 'review_due';
  const canRecord = due && metricOutcome && causalBasis && decision;

  async function submit() {
    setBusy(true); setError(null);
    try {
      await recordReview(reviewId, {
        metricOutcome,
        causalBasis,
        reviewDecision: decision,
        resultValue: resultValue === '' ? null : Number(resultValue),
        reviewNote: note.trim() || null,
      });
      onSaved?.();
    } catch (e) {
      setError(e?.message || String(e));
    } finally { setBusy(false); }
  }

  async function move(to, reason) {
    setBusy(true); setError(null);
    try { await advanceReview(reviewId, to, reason); await revQ.refetch(); await evQ.refetch(); }
    catch (e) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }

  async function amend() {
    setBusy(true); setError(null);
    try {
      await amendReviewCriteria(reviewId,
        { observation_days: Number(amendDays) }, amendReason.trim());
      setAmendReason(''); setAmendDays('');
      await revQ.refetch();
    } catch (e) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }

  return (
    <Drawer
      open onClose={onClose}
      title={due ? 'Review the outcome' : 'Outcome review'}
      sub={entry.title}
      footer={due ? (
        <div className="row" style={{ justifyContent: 'space-between', width: '100%' }}>
          <button className="btn btn-quiet" onClick={onClose} disabled={busy}>Close</button>
          <button className="btn btn-primary" onClick={submit} disabled={!canRecord || busy}>
            {busy ? 'Saving…' : 'Record the review'}
          </button>
        </div>
      ) : (
        <button className="btn btn-quiet" onClick={onClose}>Close</button>
      )}
    >
      {error && <Notice tone="error">{error}</Notice>}
      {revQ.isLoading && <Skeleton h={200} />}

      {r && (
        <>
          {/* WHAT WAS PROMISED, BEFORE THE RESULT EXISTED. Shown first, and
              shown whether or not it flatters the outcome. */}
          <div className="panel" style={{ padding: 'var(--s4)', marginBottom: 'var(--s4)' }}>
            <div className="metric-label">Set before the change, version {r.criteria_version}</div>
            <p style={{ margin: '6px 0 10px' }}>{r.hypothesis}</p>
            <dl className="dl">
              <dt>Metric</dt><dd>{r.target_metric}</dd>
              <dt>Baseline</dt><dd>{r.baseline_value ?? <span className="muted">not recorded</span>}</dd>
              <dt>Observation window</dt><dd>{r.observation_days} days</dd>
              <dt>Settling allowance</dt>
              <dd>{r.settling_days} days
                <Hint text="Orders keep arriving after the day they were placed. Judging inside this window would score the change on half-arrived data." />
              </dd>
              <dt>State</dt><dd>{LIFECYCLE_LABEL[r.lifecycle] || r.lifecycle}</dd>
            </dl>

            {Array.isArray(r.amendments) && r.amendments.length > 0 && (
              <details style={{ marginTop: 'var(--s3)' }}>
                <summary>{r.amendments.length} amendment{r.amendments.length === 1 ? '' : 's'}</summary>
                <ul className="meta" style={{ marginTop: 6 }}>
                  {r.amendments.map((a, i) => (
                    <li key={i}>
                      v{a.from_version} → v{a.from_version + 1}: {a.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>

          {r.lifecycle === 'awaiting_data' && (
            <Notice tone="info">
              Waiting for the evidence to settle. This is not overdue — a result computed on
              half-arrived orders looks like a result, which is worse than not having one.
              <div className="row" style={{ marginTop: 8, gap: 8 }}>
                <button className="btn btn-sm" disabled={busy}
                  onClick={() => move('review_due', 'the operator judged the data settled')}>
                  The data has settled
                </button>
              </div>
            </Notice>
          )}

          {/* A PLANNED REVIEW MUST HAVE A WAY FORWARD.
              This state had no controls at all, so a review created before the
              change was made could never move and could never be reviewed. The
              end-to-end test walked into it; reading the file did not. */}
          {r.lifecycle === 'planned' && (
            <Notice tone="info">
              The criteria are set and nothing has been changed yet. Once you have made
              the change in TikTok Ads Manager, mark it applied so the observation window
              starts from the right moment.
              <div className="row" style={{ marginTop: 8, gap: 8 }}>
                <button className="btn btn-sm btn-primary" disabled={busy}
                  onClick={() => move('applied', 'the change has been made')}>
                  I have made the change
                </button>
                <button className="btn btn-sm btn-quiet" disabled={busy}
                  onClick={() => move('cancelled', 'not going ahead')}>
                  Not going ahead
                </button>
              </div>
            </Notice>
          )}

          {r.lifecycle === 'applied' && (
            <Notice tone="info">
              Applied and waiting. Review planned for{' '}
              {r.planned_review_at ? new Date(r.planned_review_at).toLocaleDateString() : 'no date set'}.
              <div className="row" style={{ marginTop: 8, gap: 8 }}>
                <button className="btn btn-sm" disabled={busy}
                  onClick={() => move('awaiting_data', 'waiting on source coverage')}>
                  Waiting for data
                </button>
                <button className="btn btn-sm" disabled={busy}
                  onClick={() => move('review_due', 'ready to judge')}>
                  Ready to review
                </button>
              </div>
            </Notice>
          )}

          {due && (
            <div className="stack">
              <fieldset className="field">
                <legend>Did the metric move?</legend>
                {METRIC_OUTCOME.map(([v, l]) => (
                  <label key={v} className="row" style={{ gap: 8 }}>
                    <input type="radio" name="outcome" value={v}
                      checked={metricOutcome === v} onChange={() => setMetricOutcome(v)} />
                    <span>{l}
                      {v === 'unmeasurable' && (
                        <Hint text="Use this when the change was never actually made, the campaign sat inactive, or coverage was too thin to judge. It is NOT a failure — scoring an unimplemented change as unsuccessful would poison every later comparison." />
                      )}
                    </span>
                  </label>
                ))}
              </fieldset>

              <fieldset className="field">
                <legend>
                  What does that establish?
                  <Hint text="Kept separate from the outcome on purpose. A metric can improve while attribution stays confounded, and a favourable result with no basis beside it reads as proof the change caused it." />
                </legend>
                {CAUSAL_BASIS.map(([v, l, why]) => (
                  <label key={v} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                    <input type="radio" name="basis" value={v} style={{ marginTop: 4 }}
                      checked={causalBasis === v} onChange={() => setCausalBasis(v)} />
                    <span>
                      <span>{l}</span>
                      <span className="meta" style={{ display: 'block' }}>{why}</span>
                    </span>
                  </label>
                ))}
              </fieldset>

              <fieldset className="field">
                <legend>What will you do?</legend>
                {REVIEW_DECISION.map(([v, l]) => (
                  <label key={v} className="row" style={{ gap: 8 }}>
                    <input type="radio" name="decision" value={v}
                      checked={decision === v} onChange={() => setDecision(v)} />
                    <span>{l}
                      {v === 'revert' && (
                        <Hint text="This records the decision only. Nothing is reverted in TikTok — when you undo it, record that as its own change so the reversal has its own history." />
                      )}
                    </span>
                  </label>
                ))}
              </fieldset>

              <label className="field">
                <span>Result value <span className="muted">(optional)</span></span>
                <input className="input" type="number" step="any" value={resultValue}
                  onChange={(e) => setResultValue(e.target.value)} />
              </label>

              <label className="field">
                <span>Notes</span>
                <textarea className="input" rows={2} value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="What you saw, and anything else that was going on at the time." />
              </label>

              <details>
                <summary>Change the criteria first</summary>
                <p className="meta">
                  Only possible until the review is recorded, and only with a reason. The
                  original stays in the history alongside the new version.
                </p>
                <div className="formgrid">
                  <label className="field">
                    <span>New observation window (days)</span>
                    <input className="input" type="number" value={amendDays}
                      onChange={(e) => setAmendDays(e.target.value)} />
                  </label>
                  <label className="field field-wide">
                    <span>Why</span>
                    <input className="input" value={amendReason}
                      onChange={(e) => setAmendReason(e.target.value)} />
                  </label>
                </div>
                <button className="btn btn-sm" disabled={busy || !amendDays || !amendReason.trim()}
                  onClick={amend}>Amend</button>
              </details>
            </div>
          )}

          {r.lifecycle === 'reviewed' && (
            <div className="stack">
              <dl className="dl">
                <dt>Metric</dt><dd>{r.metric_outcome}</dd>
                <dt>Basis</dt>
                <dd>{r.causal_basis}
                  {r.causal_basis === 'observed' && (
                    <Hint text="Before and after only. This does not separate the change from anything else happening at the same time." />
                  )}
                </dd>
                <dt>Decision</dt><dd>{r.review_decision}</dd>
                <dt>Reviewed</dt><dd>{new Date(r.reviewed_at).toLocaleString()}</dd>
              </dl>
              {r.review_note && <p>{r.review_note}</p>}

              {/* CONFOUNDERS TRAVEL WITH THE RESULT. Captured at review time so
                  a later reader cannot mistake a promotional period for a clean
                  read. */}
              {Array.isArray(r.confounders) && r.confounders.length > 0 && (
                <Notice tone="warn">
                  {r.confounders.length} other thing{r.confounders.length === 1 ? '' : 's'} overlapped
                  this period: {r.confounders.map((c) => c.kind).join(', ')}. The result is not a
                  clean read of this change alone.
                </Notice>
              )}
              <Notice tone="info">
                Reviewed outcomes are final. If the conclusion changes, record a new review —
                this one stays so the history shows what was believed at the time.
              </Notice>
            </div>
          )}

          {!!evQ.data?.length && (
            <details style={{ marginTop: 'var(--s4)' }}>
              <summary>History ({evQ.data.length})</summary>
              <ul className="meta" style={{ marginTop: 6 }}>
                {evQ.data.map((e) => (
                  <li key={e.id}>
                    {new Date(e.at).toLocaleString()} · {e.from_state || 'created'} → {e.to_state}
                    {e.reason ? ` · ${e.reason}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </Drawer>
  );
}
