// The decision surface: a compact strip, with everything else behind it.
//
// ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
// A large editorial panel carrying the action, its reason, its evidence column,
// its suppressed alternatives and its lifecycle buttons — followed by an action
// queue whose first row was the same recommendation again. The same finding
// rendered three times on one screen.
//
// The reasoning is not lost and not shortened; it moves into a drawer. What
// changes is that the default screen shows the DECISION and the page can then
// get on with the performance a buyer came to look at.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { recordDecision } from '../lib/api.js';
import { ACTION, actionLabel } from '../lib/decide.js';
import { Drawer, Notice, SourceTag, Panel, money, pct } from './ui.jsx';

const value = (v, unit, cur) => {
  if (v == null) return '—';
  if (unit === 'currency_per_day') return `${money(v, cur)}/day`;
  if (unit === 'roi') return Number(v).toFixed(2);
  return String(v);
};

/** A short verb for the drill-down, and where it goes. */
function drill(d, params) {
  if (!d?.drill_to) return null;
  const q = new URLSearchParams();
  for (const k of ['shop', 'days', 'from', 'to']) if (params?.get(k)) q.set(k, params.get(k));
  if (d.affected_ids?.length) q.set('ids', d.affected_ids.join(','));
  const n = d.affected_ids?.length;
  if (d.drill_to === 'creatives') return { to: `/creatives?${q}`, label: n ? `Review ${n} video${n === 1 ? '' : 's'}` : 'Review videos' };
  if (d.drill_to === 'products') return { to: `/products?${q}`, label: n ? `Review ${n} product${n === 1 ? '' : 's'}` : 'Review products' };
  if (d.drill_to === 'scenario') return { to: `/campaigns?${q}`, label: 'View scenario' };
  return null;
}

/**
 * The priority strip: 64px, one action, one finding, confidence, one button.
 *
 * Deliberately NOT a panel with a headline. The finding is a single line of
 * real values — "25 videos declined more than 30%" — because that is what a
 * buyer needs to decide whether to open it.
 */
export function PriorityStrip({ decision, shop, stored, othersCount = 0, onEvidence }) {
  const p = decision?.primary;

  if (!p) {
    return (
      <div className="priority">
        <div className="priority-main">
          <div className="priority-name">Next action</div>
          <div className="priority-finding muted">
            Not enough data in this window to reach a conclusion — an absence of evidence, not an all-clear.
          </div>
        </div>
      </div>
    );
  }

  const params = new URLSearchParams(window.location.search);
  const d = drill(p, params);
  const blocked = (p.guardrails || []).filter((g) => !g.passed);
  const tone = p.severity === 'critical' ? 'is-critical' : p.severity === 'warning' ? 'is-warning' : '';

  return (
    <div className={`priority ${tone}`}>
      <div className="priority-main">
        <div className="priority-name">
          {actionLabel(p.action_code)}
          <SourceTag kind={p.source_mode} />
          <ConfidenceLabel decision={p} />
          {stored && stored.status !== 'proposed' && (
            <span className={`status status-${stored.status === 'applied' ? 'ok' : 'accent'}`}>{stored.status}</span>
          )}
        </div>
        <div className="priority-finding">{p.short_finding || p.title}</div>
        {blocked.length > 0 && (
          <div className="meta" style={{ color: 'var(--warning)', marginTop: 2 }}>
            Blocked by: {blocked.map((g) => g.detail || g.name).join('; ')}
          </div>
        )}
      </div>

      <div className="priority-actions">
        {d && <Link className="btn btn-primary" to={d.to}>{d.label}</Link>}
        <button className="btn" onClick={onEvidence}>
          View evidence{othersCount ? ` · ${othersCount} more` : ''}
        </button>
      </div>
    </div>
  );
}

/** Recommendation confidence — never the source badge, never an R-squared. */
function ConfidenceLabel({ decision }) {
  const c = decision.confidence;
  if (c == null) {
    return <span className="status status-info status-plain"
      title="No confidence score: this action does not depend on a model estimate.">Confidence n/a</span>;
  }
  const tone = c >= 0.7 ? 'ok' : c >= 0.45 ? 'warn' : 'bad';
  const detail = [
    'Recommendation confidence: how much to trust THIS action.',
    ...(decision.confidence_parts || []).map((p) => `${p.name}: ${(Number(p.value) * 100).toFixed(0)}%`),
    decision.model_confidence != null ? `Model confidence (separate): ${(decision.model_confidence * 100).toFixed(0)}%` : null,
    decision.data_coverage != null ? `Data coverage (separate): ${(decision.data_coverage * 100).toFixed(0)}%` : null,
  ].filter(Boolean).join('\n');
  return <span className={`status status-${tone}`} title={detail}>{decision.confidence_label} confidence</span>;
}

/**
 * Everything the strip does not show: the full reason, the evidence, the
 * guardrails, the alternatives that lost and why, and the lifecycle.
 *
 * "Other options" rather than "Why not the other 2 actions?" — same content,
 * a name instead of a question.
 */
export function RecommendationDrawer({ open, onClose, decision, shop, stored, others = [], params, persist }) {
  const p = decision?.primary;
  const cur = shop?.currency || 'USD';
  if (!p) return null;

  const d = drill(p, params);

  return (
    <Drawer open={open} onClose={onClose}
      title={actionLabel(p.action_code)}
      sub={p.title}>
      <div className="stack">
        <p style={{ margin: 0, lineHeight: '22px' }}>{p.reason}</p>

        {p.suggested_value != null && (
          <div className="panel" style={{ padding: 12 }}>
            <div className="row" style={{ gap: 24 }}>
              <div>
                <div className="meta">Current</div>
                <div className="metric-value" style={{ fontSize: 20 }}>{value(p.current_value, p.value_unit, cur)}</div>
              </div>
              <div aria-hidden="true" className="muted">→</div>
              <div>
                <div className="meta">Suggested test</div>
                <div className="metric-value" style={{ fontSize: 20, color: 'var(--accent-text)' }}>
                  {value(p.suggested_value, p.value_unit, cur)}
                </div>
              </div>
              <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                <div style={{ fontWeight: 600 }}>
                  {p.change_pct != null ? `${p.change_pct > 0 ? '+' : ''}${pct(p.change_pct, 0)}` : ''}
                </div>
                <div className="meta">{p.test_days ? `for ${p.test_days} days` : ''}</div>
              </div>
            </div>
          </div>
        )}

        <Notice tone="default" icon={null}>
          <strong>Do:</strong> {p.action_text}
        </Notice>

        {p.evidence?.length > 0 && (
          <section>
            <h3 className="section-title">Evidence</h3>
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: '22px' }}>
              {p.evidence.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          </section>
        )}

        {p.guardrails?.length > 0 && (
          <section>
            <h3 className="section-title">Checks</h3>
            <dl className="dl" style={{ marginTop: 8 }}>
              {p.guardrails.map((g, i) => (
                <div key={i} style={{ display: 'contents' }}>
                  <dt>{g.passed ? '✓' : '✕'} {g.name}</dt>
                  <dd className="muted">{g.detail || (g.passed ? 'passed' : '')}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        {p.suppressed?.length > 0 && (
          <section>
            <h3 className="section-title">Other options</h3>
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: '22px' }}>
              {p.suppressed.map((s, i) => (
                <li key={i}>
                  <strong>{actionLabel(s.action_code)}</strong> — not chosen because {s.why}.
                </li>
              ))}
            </ul>
          </section>
        )}

        {others.length > 0 && (
          <section>
            <h3 className="section-title">Additional actions ({others.length})</h3>
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: '22px' }}>
              {/* EVERY ENTRY CARRIES ITS GATE STATE. This was the one list in
                  the drawer that printed a candidate's finding with no
                  qualifier — "Other options" prints why it was not chosen and
                  the priority strip prints "Blocked by", but this printed a
                  bare title. So a dependent action could read as ready while
                  its evidence was failing. A failed or unavailable check is
                  named here rather than left to the reader to go and find. */}
              {others.map((o) => {
                const gates = o.guardrails || [];
                const failed = gates.filter((g) => !g.passed && g.available !== false);
                const unavailable = gates.filter((g) => g.available === false);
                return (
                  <li key={o.fingerprint}>
                    <strong>{actionLabel(o.action_code)}</strong> — {o.title}
                    {o.lane === 'data' && <span className="status status-info" style={{ marginLeft: 6 }}>data</span>}
                    {(failed.length > 0 || unavailable.length > 0) && (
                      <div className="meta" style={{ marginTop: 2 }}>
                        {failed.length > 0 && <>Blocked by: {failed.map((g) => g.name).join(', ')}. </>}
                        {unavailable.length > 0 && <>Cannot be checked: {unavailable.map((g) => g.name).join(', ')}.</>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <Lifecycle rec={stored} decision={p} persist={persist} />

        {d && <Link className="btn btn-primary" to={d.to} onClick={onClose}>{d.label}</Link>}
      </div>
    </Drawer>
  );
}

/**
 * "Mark applied" records that a HUMAN made a change in TikTok. It does not make
 * one — nothing in this codebase writes a setting — and the confirmation says
 * so in those words.
 */
function Lifecycle({ rec, decision, persist }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState(null);        // 'apply' | 'modify' | 'reject' | 'defer'
  const [actual, setActual] = useState('');
  const [note, setNote] = useState('');
  const [until, setUntil] = useState('');

  const reset = () => { setMode(null); setActual(''); setNote(''); setUntil(''); };

  const mut = useMutation({
    // Create the record if it does not exist yet, then record the decision.
    // record_recommendation() is idempotent by fingerprint and record_decision()
    // collapses an identical repeat, so a double submission cannot make two of
    // either. Both are enforced server-side; the disabled button is a
    // convenience, not the guarantee.
    mutationFn: async ({ decision: d, status, appliedValue, appliedKnown, deferUntil, reason }) => {
      const target = rec || (persist ? await persist() : null);
      if (!target) throw new Error('This recommendation could not be saved, so it cannot be recorded.');
      return recordDecision(target.id, d, {
        note: reason || null,
        status: status || null,
        appliedValue: appliedValue ?? null,
        appliedKnown: appliedKnown ?? null,
        deferUntil: deferUntil || null,
      });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['recs'] }); reset(); },
  });

  if (!rec && !persist) {
    return (
      <section>
        <h3 className="section-title">Your decision</h3>
        <p className="meta" style={{ margin: '8px 0 0' }}>
          This recommendation is not yet tracked for this shop, so it cannot be recorded here.
          Open it from Overview to plan or record it.
        </p>
      </section>
    );
  }

  // WHAT YOU DECIDED AND WHERE IT GOT TO ARE DIFFERENT FACTS.
  //
  // `decision` is the judgement — accept, modify, reject, defer. `status` is the
  // lifecycle — proposed, planned, applied, dismissed. One column carried both,
  // which is why neither could be read back honestly: a rejected proposal and an
  // applied-then-reverted test are not points on one line.
  const decided = rec?.decision || null;
  const status = rec?.status || 'proposed';
  const open = status === 'proposed' || status === 'planned';

  // A numeric box only means something for an action that HAS a value.
  // review_creative, fix_data, hold and insufficient_data all carry value_unit
  // null, and the old form offered a number field for every one of them — so the
  // shop's most common recommendation could not be recorded coherently.
  const numeric = decision?.value_unit != null;

  const act = (label, args, primary) => (
    <button className={primary ? 'btn btn-primary' : 'btn'}
      disabled={mut.isPending || ((args.decision === 'reject' || args.decision === 'defer') && !note.trim())
        || (args.decision === 'defer' && !until)}
      onClick={() => mut.mutate(args)}>{label}</button>
  );

  return (
    <section>
      <h3 className="section-title">Your decision</h3>

      {decided && (
        <p className="meta" style={{ margin: '8px 0 0' }}>
          Recorded <strong>{DECISION_LABEL[decided] || decided}</strong>
          {rec.decision_at ? ` on ${new Date(rec.decision_at).toLocaleDateString()}` : ''}
          {rec.decision_note ? ` — ${rec.decision_note}` : ''}
          {rec.defer_until ? ` · back on ${rec.defer_until}` : ''}
        </p>
      )}

      <div className="row" style={{ marginTop: 8 }}>
        {status === 'planned' && <span className="status status-accent">Planned</span>}
        {status === 'applied' && (
          <span className="status status-ok">
            Applied{appliedLabel(rec)}
            {rec?.applied_at ? ` · ${new Date(rec.applied_at).toLocaleDateString()}` : ''}
          </span>
        )}
        {status === 'dismissed' && <span className="status status-info">Dismissed</span>}

        {open && !mode && (
          <>
            {status === 'proposed'
              && act('Accept and plan', { decision: 'accept', status: 'planned' }, true)}
            <button className="btn" onClick={() => setMode('apply')}>Record as applied</button>
            {numeric && (
              <button className="btn" onClick={() => setMode('modify')}>Applied a different value</button>
            )}
            <button className="btn" onClick={() => setMode('defer')}>Defer</button>
            <button className="btn btn-quiet" onClick={() => setMode('reject')}>Reject</button>
          </>
        )}
      </div>

      {(mode === 'apply' || mode === 'modify') && (
        <div className="panel" style={{ padding: 12, marginTop: 12 }}>
          <p className="meta" style={{ margin: '0 0 8px', lineHeight: '18px' }}>
            <strong>This records a change you have already made in TikTok.</strong> It does not change any
            setting — nothing in this tool can.
            {numeric
              ? ' Enter the value you actually set, or leave it blank if you would rather not state one.'
              : ' This action has no numeric setting, so there is no value to enter.'}
          </p>
          <div className="row">
            {numeric && (
              <input className="input" style={{ width: 140 }} value={actual}
                aria-label="Value actually set"
                placeholder={decision?.suggested_value != null ? Number(decision.suggested_value).toFixed(2) : 'value set'}
                onChange={(e) => setActual(e.target.value)} />
            )}
            <input className="input" style={{ flex: '1 1 220px', minWidth: 0 }} value={note}
              aria-label="Note" placeholder="Note (optional)"
              onChange={(e) => setNote(e.target.value)} />
            {act('Record it', {
              // "Applied a different value" is a MODIFY, not an accept: the
              // operator did something other than what was proposed, and the log
              // should be able to say which without the reader inferring it.
              decision: mode === 'modify' ? 'modify' : 'accept',
              status: 'applied',
              appliedValue: numeric && actual !== '' ? Number(actual) : null,
              // false = applied, value not stated. Distinct from "not applied"
              // (null) and from "applied at zero" (0).
              appliedKnown: numeric ? actual !== '' : false,
              reason: note,
            }, true)}
            <button className="btn btn-quiet" onClick={reset}>Cancel</button>
          </div>
        </div>
      )}

      {(mode === 'reject' || mode === 'defer') && (
        <div className="panel" style={{ padding: 12, marginTop: 12 }}>
          <p className="meta" style={{ margin: '0 0 8px', lineHeight: '18px' }}>
            {mode === 'defer'
              ? 'A deferral records when it comes back, so it returns rather than quietly disappearing.'
              : 'A reason is required. Six months from now the reason is the only part of this still worth reading.'}
          </p>
          <div className="row" style={{ marginBottom: 8, gap: 4 }}>
            {REASONS[mode].map((r) => (
              <button key={r} className={`btn btn-sm${note === r ? ' btn-primary' : ''}`}
                onClick={() => setNote(r)}>{r}</button>
            ))}
          </div>
          <div className="row">
            <input className="input" style={{ flex: '1 1 240px', minWidth: 0 }} value={note}
              aria-label="Reason" placeholder="Reason"
              onChange={(e) => setNote(e.target.value)} />
            {mode === 'defer' && (
              <input className="input" type="date" style={{ width: 170 }} value={until}
                aria-label="Come back on" onChange={(e) => setUntil(e.target.value)} />
            )}
            {act(mode === 'defer' ? 'Defer it' : 'Reject it', {
              decision: mode,
              status: mode === 'reject' ? 'dismissed' : null,
              deferUntil: mode === 'defer' ? until : null,
              reason: note,
            }, true)}
            <button className="btn btn-quiet" onClick={reset}>Cancel</button>
          </div>
          {/* The server refuses both of these as well. Saying so here explains
              the disabled button instead of leaving it inert and unexplained. */}
          {!note.trim() && <p className="meta" style={{ margin: '6px 0 0' }}>A reason is required.</p>}
          {mode === 'defer' && !until && (
            <p className="meta" style={{ margin: '2px 0 0' }}>A return date is required.</p>
          )}
        </div>
      )}

      {mut.error && (
        <p className="meta" style={{ color: 'var(--error)', marginTop: 8 }}>{mut.error.message}</p>
      )}
    </section>
  );
}

/** "Applied at 0" and "applied, value not stated" are different claims. */
function appliedLabel(rec) {
  if (rec?.applied_value_known === false) return ' — value not stated';
  return rec?.applied_value != null ? ` at ${rec.applied_value}` : '';
}

const DECISION_LABEL = {
  accept: 'Accepted',
  modify: 'Applied a different value',
  reject: 'Rejected',
  defer: 'Deferred',
};

// The doc's own list, kept short. The free-text box beside it means a reason
// that is not on the list is still recordable rather than forced into one.
const REASONS = {
  reject: [
    'Diagnosis does not match the account',
    'Evidence incomplete',
    'Action already taken elsewhere',
    'Creative not eligible',
  ],
  defer: [
    'Promotion scheduled',
    'Spending cap',
    'Stock constraint',
    'Waiting for data',
  ],
};
