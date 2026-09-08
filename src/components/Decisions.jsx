// The decision surface.
//
// ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
// Six findings, every one fully expanded, each with a paragraph, an instruction
// and a row of evidence chips — about 3,900 pixels of page before anything was
// clickable. Nothing ranked them and nothing resolved the contradictions
// between them.
//
// Now: ONE primary action, its suggested change, its confidence, and a route to
// the evidence. Everything else collapses to a row. The alternatives that lost
// are listed with the reason they lost, because "why is it not telling me to
// raise budget" is a question the tool should answer rather than provoke.
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { setRecommendationStatus } from '../lib/api.js';
import { ACTION } from '../lib/decide.js';
import { Basis, Hint, StatusChip, Toolbar, money, pct, fixed } from './ui.jsx';

const ICON = { critical: '⛔', warning: '⚠', info: 'ℹ', good: '✓' };

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
  [ACTION.FIX_DATA]: 'Fix data',
  [ACTION.INSUFFICIENT_DATA]: 'Collect more data',
};

/** Format a suggested value in the unit it is actually in. */
function value(v, unit, currency) {
  if (v == null) return '—';
  if (unit === 'currency_per_day') return `${money(v, currency)}/day`;
  if (unit === 'roi') return Number(v).toFixed(2);
  return String(v);
}

/**
 * The decision header. Everything a buyer needs to act, in one screenful.
 */
export function DecisionHeader({ decision, shop, scope, stored, onDrill }) {
  const [params] = useSearchParams();
  const cur = shop?.currency || 'USD';
  const p = decision?.primary;

  if (!p) {
    return (
      <div className="card pad">
        <div className="k">Next action</div>
        <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>
          Not enough data in this window to reach a conclusion. That is an absence of evidence,
          not an all-clear.
        </p>
      </div>
    );
  }

  const blocked = (p.guardrails || []).filter((g) => !g.passed);

  return (
    <div className={`decision decision-${p.severity}`}>
      <div className="decision-main">
        <div className="decision-eyebrow">
          <span className="decision-icon">{ICON[p.severity]}</span>
          <strong>{ACTION_LABEL[p.action_code] || p.action_code}</strong>
          <Basis kind={p.source_mode} />
          <ConfidenceChip decision={p} />
        </div>

        <h2 className="decision-title">{p.title}</h2>
        <p className="decision-reason">{p.reason}</p>

        {p.suggested_value != null && (
          <div className="suggestion">
            <div>
              <div className="k">Now</div>
              <div className="suggestion-v">{value(p.current_value, p.value_unit, cur)}</div>
            </div>
            <span className="suggestion-arrow">→</span>
            <div>
              <div className="k">Test</div>
              <div className="suggestion-v suggestion-new">{value(p.suggested_value, p.value_unit, cur)}</div>
            </div>
            <div className="suggestion-meta">
              <div>{p.change_pct != null ? `${p.change_pct > 0 ? '+' : ''}${pct(p.change_pct, 0)}` : ''}</div>
              <div className="muted">{p.test_days ? `for ${p.test_days} days` : ''}</div>
            </div>
          </div>
        )}

        <div className="decision-do"><b>Do:</b> {p.action_text}</div>

        {blocked.length > 0 && (
          <div className="decision-block">
            <b>Blocked by:</b> {blocked.map((g) => g.detail || g.name).join('; ')}
          </div>
        )}

        <DecisionActions rec={stored} decision={p} shop={shop} onDrill={onDrill} params={params} />
      </div>

      <div className="decision-side">
        <Evidence items={p.evidence} />
        {decision.secondary && decision.secondary.action_code !== p.action_code && (
          <div className="decision-secondary">
            <div className="k">Also worth doing</div>
            <div style={{ fontSize: 12.5, marginTop: 4 }}>{decision.secondary.title}</div>
          </div>
        )}
        <Suppressed items={decision.suppressed} />
      </div>
    </div>
  );
}

function Evidence({ items }) {
  if (!items?.length) return null;
  return (
    <div>
      <div className="k">Evidence</div>
      <ul className="evlist">
        {items.slice(0, 4).map((e, i) => <li key={i}>{e}</li>)}
      </ul>
    </div>
  );
}

/**
 * What the pipeline decided NOT to tell you, and why.
 *
 * This is the whole point of the arbitration being explicit. A buyer who has
 * been told "raise budget" by a different tool needs to see that this one
 * considered it and suppressed it, rather than that it never thought of it.
 */
function Suppressed({ items }) {
  const [open, setOpen] = useState(false);
  if (!items?.length) return null;
  return (
    <div className="suppressed">
      <button className="lnk" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide' : `Why not ${items.length === 1 ? 'the other action' : `the other ${items.length} actions`}?`}
      </button>
      {open && (
        <ul className="evlist">
          {items.map((s, i) => (
            <li key={i}>
              <strong>{ACTION_LABEL[s.action_code] || s.action_code}</strong> — {s.why}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Confidence, with the three concepts kept visibly apart.
 *
 * Source type (measured/simulated) is NOT confidence. Model R-squared is NOT
 * confidence. Both were previously shown in ways that read as one.
 */
function ConfidenceChip({ decision }) {
  const c = decision.confidence;
  if (c == null) {
    return <span className="chip chip-info" title="No confidence score: this action does not depend on a model estimate.">confidence n/a</span>;
  }
  const tone = c >= 0.7 ? 'ok' : c >= 0.45 ? 'warn' : 'bad';
  const parts = (decision.confidence_parts || [])
    .map((p) => `${p.name}: ${(Number(p.value) * 100).toFixed(0)}%`).join('\n');
  const detail = [
    `Recommendation confidence: how much to trust THIS action.`,
    parts,
    decision.model_confidence != null ? `Model confidence (separate): ${(decision.model_confidence * 100).toFixed(0)}%` : null,
    decision.data_coverage != null ? `Data coverage (separate): ${(decision.data_coverage * 100).toFixed(0)}%` : null,
  ].filter(Boolean).join('\n');
  return <span className={`chip chip-${tone}`} title={detail}>{decision.confidence_label} confidence</span>;
}

/**
 * The lifecycle.
 *
 * "Mark applied" records that a HUMAN made the change in TikTok. It does not
 * make one — nothing in this codebase writes a setting — and the confirmation
 * says so in those words, because a button labelled "apply" next to a suggested
 * budget will otherwise be read as doing it.
 */
function DecisionActions({ rec, decision, shop, onDrill, params }) {
  const qc = useQueryClient();
  const [applying, setApplying] = useState(false);
  const [actual, setActual] = useState('');

  const mut = useMutation({
    mutationFn: ({ status, actualValue, reason }) =>
      setRecommendationStatus(rec, status, { actualValue, reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['recs'] });
      setApplying(false);
    },
  });

  const drill = decision.drill_to;
  const drillLabel = drill === 'creatives' ? 'Review videos'
    : drill === 'products' ? 'Review products'
    : drill === 'scenario' ? 'View scenario'
    : null;

  const drillHref = () => {
    const q = new URLSearchParams();
    for (const k of ['shop', 'days']) if (params.get(k)) q.set(k, params.get(k));
    if (decision.affected_ids?.length) q.set('ids', decision.affected_ids.join(','));
    if (drill === 'creatives') return `/creatives?${q}`;
    if (drill === 'products') return `/products?${q}`;
    return `/campaigns?${q}`;
  };

  return (
    <div className="decision-actions">
      {drillLabel && (
        <Link className="btn btn-primary" to={drillHref()}>
          {drillLabel}
          {decision.affected_ids?.length ? ` (${decision.affected_ids.length})` : ''}
        </Link>
      )}

      {rec && rec.status === 'proposed' && (
        <>
          <button className="btn" disabled={mut.isPending}
            onClick={() => mut.mutate({ status: 'planned' })}>Mark planned</button>
          <button className="btn" onClick={() => setApplying(true)}>Mark applied</button>
          <button className="btn" disabled={mut.isPending}
            onClick={() => mut.mutate({ status: 'dismissed', reason: 'dismissed from overview' })}>Dismiss</button>
        </>
      )}

      {rec && rec.status === 'planned' && (
        <>
          <span className="chip chip-info">Planned</span>
          <button className="btn" onClick={() => setApplying(true)}>Mark applied</button>
        </>
      )}

      {rec && rec.status === 'applied' && (
        <span className="chip chip-ok">
          Applied {rec.applied_value != null ? `at ${rec.applied_value}` : ''}
          {rec.applied_at ? ` · ${new Date(rec.applied_at).toLocaleDateString()}` : ''}
        </span>
      )}

      {applying && (
        <div className="applybox">
          <div style={{ fontSize: 12.5, marginBottom: 8, lineHeight: 1.5 }}>
            <strong>This records a change you have already made in TikTok.</strong> It does not
            change any setting — nothing in this tool can. Enter the value you actually set, which
            may differ from the suggestion.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input" placeholder={decision.suggested_value != null ? String(Number(decision.suggested_value).toFixed(2)) : 'value set'}
              value={actual} onChange={(e) => setActual(e.target.value)} style={{ width: 130 }} />
            <button className="btn btn-primary" disabled={mut.isPending}
              onClick={() => mut.mutate({ status: 'applied', actualValue: actual === '' ? null : Number(actual) })}>
              Record it
            </button>
            <button className="btn" onClick={() => setApplying(false)}>Cancel</button>
          </div>
        </div>
      )}

      {mut.error && <span className="muted" style={{ color: 'var(--danger)' }}>{mut.error.message}</span>}
    </div>
  );
}

/**
 * The action queue: one line per candidate, ranked, with its own way through.
 *
 * Data repairs are kept in their own lane. A blocked dataset and a budget
 * opportunity are not the same kind of task, and a queue that mixes them is one
 * nobody can work through.
 */
export function PriorityTable({ decision, shop, records }) {
  const [params] = useSearchParams();
  const [lane, setLane] = useState('');
  const [conf, setConf] = useState('');
  const cur = shop?.currency || 'USD';
  if (!decision?.all?.length) return null;

  const byFingerprint = new Map((records || []).map((r) => [r.fingerprint, r]));

  // Filters the spec asks for, over the dimensions that actually exist here:
  // which kind of work it is, and how much the evidence supports it. Filters
  // for signals we cannot measure (promotion active, organic dependency) are
  // deliberately absent rather than present and permanently empty.
  const all = decision.all;
  const rows = all.filter((r) => {
    if (lane && r.lane !== lane) return false;
    if (conf === 'high' && !(r.confidence >= 0.7)) return false;
    if (conf === 'moderate' && !(r.confidence >= 0.45 && r.confidence < 0.7)) return false;
    if (conf === 'low' && !(r.confidence != null && r.confidence < 0.45)) return false;
    if (conf === 'blocked' && !(r.guardrails || []).some((g) => !g.passed)) return false;
    return true;
  });
  const active = !!(lane || conf);
  const clear = () => { setLane(''); setConf(''); };

  const href = (r) => {
    const q = new URLSearchParams();
    for (const k of ['shop', 'days']) if (params.get(k)) q.set(k, params.get(k));
    if (r.affected_ids?.length) q.set('ids', r.affected_ids.join(','));
    if (r.drill_to === 'creatives') return `/creatives?${q}`;
    if (r.drill_to === 'products') return `/products?${q}`;
    if (r.action_code === ACTION.FIX_DATA) return `/data?${q}`;
    return `/campaigns?${q}`;
  };

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="pad" style={{ paddingBottom: 8 }}>
        <div className="k">Action queue</div>
        <div className="sub">
          Ranked by evidence, severity and how much revenue is affected — that order is fixed, so the
          same evidence always produces the same queue.
        </div>
        <Toolbar count={rows.length} total={all.length} onClear={clear} active={active}>
          <select className="input" aria-label="Filter by type of work"
            value={lane} onChange={(e) => setLane(e.target.value)}>
            <option value="">All work</option>
            <option value="media">Media buying</option>
            <option value="data">Data repair</option>
          </select>
          <select className="input" aria-label="Filter by confidence"
            value={conf} onChange={(e) => setConf(e.target.value)}>
            <option value="">Any confidence</option>
            <option value="high">High confidence</option>
            <option value="moderate">Moderate confidence</option>
            <option value="low">Low confidence</option>
            <option value="blocked">Blocked on missing data</option>
          </select>
        </Toolbar>
      </div>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Action</th>
              <th>Main reason</th>
              <th className="num">Suggested change</th>
              <th>Confidence</th>
              <th className="num">
                Revenue affected
                <Hint text="Revenue currently flowing through the affected entities. NOT a forecast of money gained or lost — historical GMV is not a prediction." />
              </th>
              <th>Review</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const rec = byFingerprint.get(r.fingerprint);
              return (
                <tr key={r.fingerprint} className={r.lane === 'data' ? 'row-data' : undefined}>
                  <td className="tight">
                    <span className="decision-icon">{ICON[r.severity]}</span>{' '}
                    <strong>{ACTION_LABEL[r.action_code] || r.action_code}</strong>
                    {r.lane === 'data' && <span className="chip chip-info" style={{ marginLeft: 6 }}>data</span>}
                    {rec && rec.status !== 'proposed' && (
                      <span className={`chip chip-${rec.status === 'applied' ? 'ok' : 'info'}`} style={{ marginLeft: 6 }}>
                        {rec.status}
                      </span>
                    )}
                  </td>
                  <td className="tight"><span className="clamp1">{r.title}</span></td>
                  <td className="num tight">
                    {r.suggested_value != null
                      ? <>{value(r.current_value, r.value_unit, cur)} → <strong>{value(r.suggested_value, r.value_unit, cur)}</strong></>
                      : <span className="muted">—</span>}
                  </td>
                  <td className="tight">
                    {r.confidence == null
                      ? <span className="muted">n/a</span>
                      : <span className={`chip chip-${r.confidence >= 0.7 ? 'ok' : r.confidence >= 0.45 ? 'warn' : 'bad'}`}>
                          {r.confidence_label}
                        </span>}
                  </td>
                  <td className="num tight">{r.revenue_affected == null ? '—' : money(r.revenue_affected, cur)}</td>
                  <td className="tight"><Link className="lnk" to={href(r)}>Open →</Link></td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr><td colSpan={6} className="muted" style={{ padding: 20, textAlign: 'center' }}>
                No actions match these filters. <button className="lnk" onClick={clear}>Clear them</button> to see all {all.length}.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
