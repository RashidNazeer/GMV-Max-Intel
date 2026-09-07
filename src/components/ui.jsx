// Shared presentation primitives.
//
// The one rule they all encode: a missing number renders as "—", never as 0.
// Zero is a measurement; a dash is the absence of one, and on a page about
// where revenue came from those are very different statements.
import { money, moneyExact, pct } from '../lib/api.js';

export function Card({ title, sub, right, children, pad = true, className = '' }) {
  return (
    <div className={`card ${className}`}>
      {(title || right) && (
        <div className="pad" style={{ paddingBottom: children ? 6 : 18, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            {title && <div className="k">{title}</div>}
            {sub && <div className="sub">{sub}</div>}
          </div>
          {right && <div style={{ marginLeft: 'auto' }}>{right}</div>}
        </div>
      )}
      {children && (pad ? <div className="pad" style={{ paddingTop: title ? 6 : 18 }}>{children}</div> : children)}
    </div>
  );
}

export function Stat({ k, v, sub, tone, basis }) {
  const color = tone === 'paid' ? 'var(--paid)'
    : tone === 'organic' ? 'var(--organic)'
    : tone === 'danger' ? 'var(--danger)'
    : tone === 'warning' ? 'var(--warning)'
    : undefined;
  return (
    <div className="card pad">
      <div className="k">{k} {basis && <Basis kind={basis} />}</div>
      <div className="v" style={color ? { color } : undefined}>{v}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export const Basis = ({ kind }) => <span className={`basis basis-${kind}`}>{kind}</span>;

export const Note = ({ tone = 'info', children }) => (
  <div className={`note note-${tone}`}>{children}</div>
);

export const Skeleton = ({ h = 120 }) => <div className="skel" style={{ height: h }} />;

export function Empty({ title, children }) {
  return (
    <div className="card pad" style={{ textAlign: 'center', padding: '38px 20px' }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{title}</div>
      <div className="muted" style={{ fontSize: 13, maxWidth: 520, margin: '0 auto' }}>{children}</div>
    </div>
  );
}

/** A loud, undismissable statement that figures on this page were invented. */
export const SimulatedBanner = ({ what = 'Ad spend' }) => (
  <div className="simbar">
    <span style={{ fontSize: 17 }}>⚠</span>
    <span>
      <b>{what} on this page is simulated.</b>{' '}
      The ad account is not yet connected in Reacher, so there is no real spend to read.
      Revenue is measured; spend and GMV Max&rsquo;s reported figures are generated to show how the
      comparison works. Nothing here is a forecast.
    </span>
  </div>
);

/** A small share bar for table cells — reads faster than a second number. */
export const MiniBar = ({ value, color = 'var(--paid)' }) => (
  <div className="bar" title={pct(value)}>
    <i style={{ width: `${Math.max(0, Math.min(1, Number(value) || 0)) * 100}%`, background: color }} />
  </div>
);

export const Trend = ({ value }) => {
  if (value == null) return <span className="muted">—</span>;
  const v = Number(value);
  const cls = v > 0.02 ? 'trend-up' : v < -0.02 ? 'trend-down' : 'muted';
  return <span className={cls}>{v > 0 ? '+' : ''}{(v * 100).toFixed(0)}%</span>;
};

export { money, moneyExact, pct };
