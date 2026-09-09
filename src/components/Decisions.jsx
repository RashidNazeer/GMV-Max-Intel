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
import { setRecommendationStatus } from '../lib/api.js';
import { ACTION } from '../lib/decide.js';
import { Drawer, Notice, SourceTag, Panel, money, pct } from './ui.jsx';

const ACTION_LABEL = {
  [ACTION.INCREASE_BUDGET]: 'Raise budget',
  [ACTION.DECREASE_BUDGET]: 'Cut budget',
  [ACTION.INCREASE_TARGET_ROI]: 'Raise Target ROI',
  [ACTION.DECREASE_TARGET_ROI]: 'Lower Target ROI',
  [ACTION.TEST_MAX_DELIVERY]: 'Test Max Delivery',
  [ACTION.EXIT_MAX_DELIVERY]: 'Exit Max Delivery',
  [ACTION.HOLD]: 'Hold',
  [ACTION.REVIEW_CREATIVE]: 'Review creative',
  [ACTION.REVIEW_PROMOTION]: 'Review promotion',
  [ACTION.REVIEW_LISTING]: 'Review listings',
  [ACTION.FIX_DATA]: 'Data issue',
  [ACTION.INSUFFICIENT_DATA]: 'Collect more data',
};

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
          {ACTION_LABEL[p.action_code] || p.action_code}
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
      title={ACTION_LABEL[p.action_code] || p.action_code}
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
                  <strong>{ACTION_LABEL[s.action_code] || s.action_code}</strong> — not chosen because {s.why}.
                </li>
              ))}
            </ul>
          </section>
        )}

        {others.length > 0 && (
          <section>
            <h3 className="section-title">Additional actions ({others.length})</h3>
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: '22px' }}>
              {others.map((o) => (
                <li key={o.fingerprint}>
                  <strong>{ACTION_LABEL[o.action_code] || o.action_code}</strong> — {o.title}
                  {o.lane === 'data' && <span className="status status-info" style={{ marginLeft: 6 }}>data</span>}
                </li>
              ))}
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
  const [applying, setApplying] = useState(false);
  const [actual, setActual] = useState('');

  const mut = useMutation({
    // Create the record if it does not exist yet, then move it. Persisting is
    // idempotent by fingerprint, so a double submission cannot make two tests.
    mutationFn: async ({ status, actualValue, reason }) => {
      const target = rec || (persist ? await persist() : null);
      if (!target) throw new Error('This recommendation could not be saved, so it cannot be recorded.');
      return setRecommendationStatus(target, status, { actualValue, reason });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['recs'] }); setApplying(false); },
  });

  // THE DRAWER'S ONLY BUTTON WAS CLOSE.
  //
  // This returned null whenever the recommendation had not yet been saved —
  // which is always true on campaign detail, because that page reads stored
  // records but never writes one. So the drawer described a test the operator
  // had no way to record, while campaign History promised that marking one
  // applied would record it. The workflow could not be completed from the
  // place it was described.
  //
  // The record is now created on demand, at the moment the operator acts.
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

  return (
    <section>
      <h3 className="section-title">Your decision</h3>
      <div className="row" style={{ marginTop: 8 }}>
        {(!rec || rec.status === 'proposed') && (
          <>
            <button className="btn" disabled={mut.isPending} onClick={() => mut.mutate({ status: 'planned' })}>Mark planned</button>
            <button className="btn" onClick={() => setApplying(true)}>Mark applied</button>
            <button className="btn btn-quiet" disabled={mut.isPending}
              onClick={() => mut.mutate({ status: 'dismissed', reason: 'dismissed from evidence drawer' })}>Dismiss</button>
          </>
        )}
        {rec?.status === 'planned' && (
          <>
            <span className="status status-accent">Planned</span>
            <button className="btn" onClick={() => setApplying(true)}>Mark applied</button>
          </>
        )}
        {rec?.status === 'applied' && (
          <span className="status status-ok">
            Applied{rec?.applied_value != null ? ` at ${rec.applied_value}` : ''}
            {rec?.applied_at ? ` · ${new Date(rec.applied_at).toLocaleDateString()}` : ''}
          </span>
        )}
      </div>

      {applying && (
        <div className="panel" style={{ padding: 12, marginTop: 12 }}>
          <p className="meta" style={{ margin: '0 0 8px', lineHeight: '18px' }}>
            This records a change you have already made in TikTok. It does not change any setting —
            nothing in this tool can. Enter the value you actually set.
          </p>
          <div className="row">
            <input className="input" style={{ width: 140 }} value={actual}
              placeholder={decision.suggested_value != null ? Number(decision.suggested_value).toFixed(2) : 'value set'}
              onChange={(e) => setActual(e.target.value)} />
            <button className="btn btn-primary" disabled={mut.isPending}
              onClick={() => mut.mutate({ status: 'applied', actualValue: actual === '' ? null : Number(actual) })}>
              Record it
            </button>
            <button className="btn btn-quiet" onClick={() => setApplying(false)}>Cancel</button>
          </div>
        </div>
      )}

      {mut.error && <p className="meta" style={{ color: 'var(--error)' }}>{mut.error.message}</p>}
    </section>
  );
}

export { ACTION_LABEL };
