// The organic baseline, and the counterfactual it is careful not to be.
//
// ── WHY THE METHOD IS A CONTROL, NOT A CONSTANT ────────────────────────────
// The page used to compare this window against the one immediately before it,
// and never said so. That is a legitimate method with a known weakness: a
// promotion, a stockout or a bank holiday in the comparison week moves the
// reference for reasons that have nothing to do with demand. On this shop the
// two methods currently disagree by a wide margin, which is the whole argument
// for naming which one produced the number.
//
// ── AND WHY THE COUNTERFACTUAL IS SEPARATE ─────────────────────────────────
// "What organic did in comparable past periods" and "what organic would have
// been without the ads" are different questions, and only the first is
// answerable here. Keeping them in one panel — with the second openly refusing
// — is what stops the first quietly being read as the second.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Panel, Notice, Skeleton, Hint } from './ui.jsx';
import { money, pct } from '../lib/api.js';
import {
  organicBaseline, organicCounterfactual,
  BASELINE_METHODS, BASELINE_STATUS_LABEL,
} from '../lib/loopApi.js';

export default function OrganicBaseline({ shop, scope }) {
  const [method, setMethod] = useState('rolling');
  const cur = shop.currency || 'USD';

  const bQ = useQuery({
    queryKey: ['orgbase', shop.id, scope.start, scope.end, method],
    queryFn: () => organicBaseline(shop.id, scope.start, scope.end, method, 4),
  });
  const cfQ = useQuery({
    queryKey: ['orgcf', shop.id, scope.start, scope.end],
    queryFn: () => organicCounterfactual(shop.id, scope.start, scope.end),
  });

  const b = bQ.data;
  const meta = BASELINE_METHODS.find((m) => m[0] === method);
  const comparable = b?.status === 'ok';

  return (
    <Panel
      title="Organic baseline"
      sub="What organic revenue did in comparable past periods."
      right={(
        <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}
          aria-label="Baseline method" style={{ maxWidth: 220 }}>
          {BASELINE_METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      )}
    >
      {bQ.isLoading && <Skeleton h={140} />}
      {bQ.error && <Notice tone="error">Could not load the baseline: {bQ.error.message}</Notice>}

      {b && (
        <>
          <dl className="dl">
            <dt>This period</dt>
            <dd><strong>{money(b.current_value, cur)}</strong></dd>

            <dt>
              Baseline
              <Hint text={b.method_note} />
            </dt>
            <dd>
              {comparable
                ? money(b.baseline_value, cur)
                : <span className="muted">{BASELINE_STATUS_LABEL[b.status] || b.status}</span>}
            </dd>

            <dt>Change</dt>
            <dd>
              {/* A MISSING BASELINE IS NEVER A PERCENTAGE. "Down 100%" against
                  something that never existed is the most misleading number
                  this panel could print, so the state is shown instead. */}
              {b.change_pct != null
                ? (
                  <strong className={Number(b.change_pct) < 0 ? 'status-bad' : 'status-ok'}>
                    {Number(b.change_pct) > 0 ? '+' : ''}{pct(b.change_pct, 1)}
                  </strong>
                )
                : (
                  <span className="muted">
                    {b.status === 'zero_baseline'
                      ? 'the comparison period had no organic revenue, so there is no percentage to give'
                      : 'no comparable period to measure against'}
                  </span>
                )}
            </dd>

            <dt>Periods used</dt>
            <dd>
              {b.periods_eligible} of {b.periods_considered}
              {b.earliest_used && (
                <span className="muted"> · {b.earliest_used} to {b.latest_used}</span>
              )}
            </dd>
          </dl>

          {/* The DATABASE's description of the method, not the static one from
              the dropdown: it carries the real numbers this run used — "the
              median of the last 4 comparable 7-day windows" rather than a
              generic sentence about medians. The static text is still the
              dropdown's own explanation of what each option means. */}
          <p className="meta">{b.method_note || meta?.[2]}</p>
          <p className="meta">{b.coverage_note}</p>
          <p className="meta">Method version {b.version}</p>
        </>
      )}

      {/* ── THE QUESTION THIS PANEL DOES NOT ANSWER ──────────────────────── */}
      {cfQ.data && (
        <Notice tone="info">
          <strong>Without the advertising, organic would have been…</strong>{' '}
          <em>not estimable from the available evidence.</em>
          <p style={{ margin: '6px 0 0' }}>{cfQ.data.reason}</p>
          <p className="meta" style={{ marginTop: 6 }}>{cfQ.data.what_would_help}</p>
        </Notice>
      )}
    </Panel>
  );
}
