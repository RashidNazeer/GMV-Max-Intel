// ONE date control, in the page toolbar, on every route.
//
// It used to be two adjacent controls — a preset dropdown and a separate date
// label — which read as two different filters. Preset, custom range, exact
// dates, comparison period, model training window, timezone and settlement all
// live in one popover now, because they all describe the same window and a
// reader who cannot see them together cannot check any of them.
import { useEffect, useRef, useState } from 'react';
import { RANGES } from '../lib/scope.js';

export default function ReportToolbar({ scope, shop, children }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(scope.start);
  const [to, setTo] = useState(scope.end);
  const box = useRef(null);

  useEffect(() => { setFrom(scope.start); setTo(scope.end); }, [scope.start, scope.end]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const valid = from && to && from <= to;

  return (
    <div className="toolbar">
      {children}
      <div style={{ position: 'relative' }} ref={box}>
        <button className="btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}
          title="Reporting window, comparison period, timezone and settlement">
          <span>{scope.custom ? 'Custom' : `Last ${scope.days} days`}</span>
          <span className="meta" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {scope.start} → {scope.end}
          </span>
          <span aria-hidden="true" style={{ color: 'var(--text-3)' }}>▾</span>
        </button>

        {open && (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 34 }} onClick={() => setOpen(false)} />
            <div className="panel" role="dialog" aria-label="Reporting window" style={{
              position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 35,
              width: 340, padding: 12, boxShadow: 'var(--shadow-pop)',
            }}>
              <div className="row" style={{ gap: 4 }}>
                {RANGES.map((d) => (
                  <button key={d}
                    className={`btn btn-sm${!scope.custom && scope.days === d ? ' btn-primary' : ''}`}
                    onClick={() => { scope.setDays(d); setOpen(false); }}>
                    {d}d
                  </button>
                ))}
              </div>

              <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'nowrap' }}>
                <label className="field" style={{ flex: 1 }}>
                  <span>From</span>
                  <input className="input" type="date" value={from} max={to}
                    onChange={(e) => setFrom(e.target.value)} />
                </label>
                <label className="field" style={{ flex: 1 }}>
                  <span>To</span>
                  <input className="input" type="date" value={to} min={from}
                    onChange={(e) => setTo(e.target.value)} />
                </label>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn btn-primary btn-sm" disabled={!valid}
                  onClick={() => { scope.setCustom(from, to); setOpen(false); }}>Apply range</button>
                {scope.custom && (
                  <button className="btn btn-sm" onClick={() => { scope.setCustom(null, null); setOpen(false); }}>
                    Use a preset
                  </button>
                )}
              </div>

              <dl className="dl" style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--divider)' }}>
                <dt>Reporting</dt>
                <dd>{scope.start} → {scope.end} <span className="muted">({scope.spanDays} days)</span></dd>
                <dt>Compared with</dt>
                <dd>{scope.priorStart} → {scope.priorEnd} <span className="muted">(adjacent, equal length)</span></dd>
                <dt>Model trains on</dt>
                <dd>{scope.model.start} → {scope.model.end} <span className="muted">({scope.model.spanDays} days)</span></dd>
                <dt>Days cut in</dt>
                <dd>{shop?.reporting_timezone || 'America/Los_Angeles'} <span className="muted">— the source&rsquo;s reporting day, not UTC</span></dd>
                <dt>Settlement</dt>
                <dd>
                  {scope.custom
                    ? <>Not applied — a custom range is used exactly as entered, so recent days may still be filling in.</>
                    : <>Ends {scope.settlingDays} days back; affiliate orders keep arriving for about that long.</>}
                </dd>
              </dl>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
