// Shared presentation primitives.
//
// The one rule they all encode: a missing number renders as "—", never as 0.
// Zero is a measurement; a dash is the absence of one, and on a page about
// where revenue came from those are very different statements.
import { money, moneyExact, pct, numOrNull, fixed } from '../lib/api.js';

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

export function Stat({ k, v, sub, tone, basis, hint }) {
  const color = tone === 'paid' ? 'var(--paid)'
    : tone === 'organic' ? 'var(--organic)'
    : tone === 'danger' ? 'var(--danger)'
    : tone === 'warning' ? 'var(--warning)'
    : undefined;
  return (
    <div className="card pad">
      <div className="k">
        {k} {basis && <Basis kind={basis} />}
        {hint && <Hint text={hint} />}
      </div>
      <div className="v" style={color ? { color } : undefined}>{v}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export const Basis = ({ kind }) => <span className={`basis basis-${kind}`}>{kind}</span>;

/**
 * A definition, reachable without a mouse.
 *
 * Every non-obvious metric needs its meaning, scope and period available — and
 * a tooltip you can only reach by hovering hides that from anyone using a
 * keyboard. tabIndex + title makes it focusable and announced.
 */
export const Hint = ({ text }) => (
  <span className="hint" tabIndex={0} role="note" aria-label={text} title={text}>?</span>
);

export const Note = ({ tone = 'info', children }) => (
  <div className={`note note-${tone}`}>{children}</div>
);

export const Skeleton = ({ h = 120 }) => <div className="skel" style={{ height: h }} />;

export function Empty({ title, children }) {
  return (
    <div className="card pad" style={{ textAlign: 'center', padding: '38px 20px' }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{title}</div>
      <div className="muted" style={{ fontSize: 13, maxWidth: 560, margin: '0 auto', lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

/**
 * "Unavailable" is a first-class state, distinct from zero and from an error.
 * The reason is required — an unexplained dash is just as unhelpful as a 0.
 */
export function Unavailable({ reason, children }) {
  return (
    <span className="unavail" title={reason}>
      {children || '—'}
      <span className="unavail-why">{reason}</span>
    </span>
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

/**
 * A trend, with the three states kept apart:
 *   a number   — measured movement
 *   No baseline — the prior period had no revenue, which is NOT -100%
 *   —          — the window is too short to compare at all
 */
export const Trend = ({ value, hasBaseline, measurable = true }) => {
  if (!measurable) return <span className="muted" title="Needs a 14-day window to compare against">—</span>;
  if (hasBaseline === false || value == null) {
    return <span className="muted" title="No revenue in the prior 7 days, so there is nothing to compare against. This is not a decline.">no baseline</span>;
  }
  const v = Number(value);
  const cls = v > 0.02 ? 'trend-up' : v < -0.02 ? 'trend-down' : 'muted';
  // Never colour alone: the arrow carries the same information as the colour.
  const mark = v > 0.02 ? '▲' : v < -0.02 ? '▼' : '';
  return <span className={cls}>{mark} {v > 0 ? '+' : ''}{(v * 100).toFixed(0)}%</span>;
};

/** Creative and product statuses, named precisely. */
const STATUS_META = {
  winner:       { label: 'Winner',        tone: 'ok',   why: 'Three or more orders in this window and not declining.' },
  candidate:    { label: 'Candidate',     tone: 'info', why: 'Has sold, but below the order threshold that makes a winner.' },
  rising:       { label: 'Rising',        tone: 'ok',   why: 'Up more than 30% against the previous 7 days.' },
  declining:    { label: 'Declining GMV', tone: 'warn', why: 'Down more than 30% against the previous 7 days. A revenue drop only — nothing here claims an audience was worn out.' },
  fatigue_risk: { label: 'Fatigue risk',  tone: 'bad',  why: 'Was earning meaningfully before it fell more than 30%. Per-video spend is not available, so continuing exposure cannot be confirmed.' },
  new:          { label: 'New',           tone: 'info', why: 'First sold inside the last 7 days, so it has no prior week to compare against.' },
};

export const StatusChip = ({ status }) => {
  const m = STATUS_META[status];
  if (!m) return <span className="muted">—</span>;
  return <span className={`chip chip-${m.tone}`} title={m.why}>{m.label}</span>;
};

export const STATUSES = Object.entries(STATUS_META).map(([k, v]) => ({ value: k, label: v.label }));

/** Filter bar: search, selects, a result count, and a way out. */
export function Toolbar({ children, count, total, onClear, active }) {
  return (
    <div className="toolbar">
      {children}
      <div className="spacer" />
      {count != null && (
        <span className="muted" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
          {total != null && total !== count
            ? `${count.toLocaleString()} of ${total.toLocaleString()}`
            : `${count.toLocaleString()} result${count === 1 ? '' : 's'}`}
        </span>
      )}
      {active && <button className="btn" onClick={onClear}>Clear filters</button>}
    </div>
  );
}

/**
 * Paging that states the whole population.
 *
 * The creative table used to show 50 rows under a headline of 573 with no
 * indication the other 523 existed. "Showing 1-50 of 573" is the minimum
 * honest version of that.
 */
export function Pager({ page, pageSize, total, onPage }) {
  const t = Number(total) || 0;
  const pages = Math.max(1, Math.ceil(t / pageSize));
  const from = t === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(t, (page + 1) * pageSize);
  if (t <= pageSize) {
    return <div className="pager"><span className="muted">{t.toLocaleString()} of {t.toLocaleString()}</span></div>;
  }
  return (
    <div className="pager">
      <span className="muted">Showing {from.toLocaleString()}–{to.toLocaleString()} of {t.toLocaleString()}</span>
      <div className="spacer" />
      <button className="btn" onClick={() => onPage(page - 1)} disabled={page === 0}>Previous</button>
      <span className="muted" style={{ fontSize: 12.5 }}>Page {page + 1} of {pages}</span>
      <button className="btn" onClick={() => onPage(page + 1)} disabled={page + 1 >= pages}>Next</button>
    </div>
  );
}

/** A sortable header cell. Sort state is visible and announced, not implied. */
export function SortTh({ label, field, sort, dir, onSort, num = false, hint }) {
  const activeCol = sort === field;
  return (
    <th className={num ? 'num' : undefined}
      aria-sort={activeCol ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button className="sortbtn" onClick={() => onSort(field)}>
        {label}
        <span className="sortmark">{activeCol ? (dir === 'asc' ? '▲' : '▼') : ''}</span>
      </button>
      {hint && <Hint text={hint} />}
    </th>
  );
}

/** Tab bar inside a detail view. */
export function TabBar({ tabs, value, onChange }) {
  return (
    <div className="tabbar" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id}
          className={value === t.id ? 'active' : undefined}
          onClick={() => onChange(t.id)}>
          {t.label}
          {t.count != null && <span className="tabcount">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export { money, moneyExact, pct, numOrNull, fixed };
