// Shared primitives. Every screen composes from these, so a change to density,
// spacing or state handling lands everywhere at once.
//
// Two rules carried over from the data work, because they are presentation
// rules as much as analytical ones:
//   * A missing number renders as "—" with a reason, never as 0.
//   * A badge that is wrong in a harmless direction teaches people to ignore
//     it, so provenance is shown once per region and only where it is true.
import { Component, useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { money, moneyExact, pct, numOrNull, fixed } from '../lib/api.js';

/**
 * A render error in ONE panel must not take the whole app with it.
 *
 * React's default on an uncaught render error is to unmount the entire tree.
 * This app had no boundary anywhere, so a single undefined binding inside the
 * scenario table blanked the shell — no navigation, no shop selector, no way
 * back except a reload. The bug was mine; the blast radius was the
 * architecture's, and that is the part worth fixing.
 *
 * Three things it deliberately does NOT do:
 *   * It does not swallow. The error is re-logged to console.error, so the
 *     browser QA gate still fails on it instead of seeing a tidy screen.
 *   * It does not substitute zeros or empty data for a broken model. A panel
 *     that cannot render says so; it does not invent a result.
 *   * It does not hide what happened. The message is available on the page,
 *     because "something went wrong" tells an operator nothing they can act on.
 *
 * `resetKey` clears the error when the surrounding context changes — a new tab,
 * shop or window is a fresh attempt, not the same failure.
 */
export class Boundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Re-raised on purpose: silence here would mean an automated check that
    // watches the console could pass while a panel is dead on screen.
    console.error(`[${this.props.name || 'panel'}] render failed:`, error, info?.componentStack);
  }

  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Notice tone="error">
        <p>
          <strong>{this.props.name || 'This panel'} could not be displayed.</strong>{' '}
          The rest of the page is unaffected — navigation, the shop selector and every other
          panel still work. Nothing here has been replaced with zeros or placeholder figures.
        </p>
        <p className="meta" style={{ margin: '6px 0 0' }}>
          <code>{String(this.state.error?.message || this.state.error)}</code>
        </p>
        <p style={{ margin: '8px 0 0' }}>
          <button className="btn btn-sm" onClick={() => this.setState({ error: null })}>Try again</button>
        </p>
      </Notice>
    );
  }
}

/* ── panels ──────────────────────────────────────────────────────────────── */

export function Panel({ title, sub, right, children, bodyPad = true, className = '' }) {
  return (
    <section className={`panel ${className}`}>
      {(title || right) && (
        <header className={`panel-head ${children ? '' : 'plain'}`}>
          <div style={{ minWidth: 0, flex: '1 1 auto' }}>
            {title && <h2 className="section-title">{title}</h2>}
            {sub && <p className="meta" style={{ margin: '2px 0 0', maxWidth: '72ch' }}>{sub}</p>}
          </div>
          {right && <div className="row">{right}</div>}
        </header>
      )}
      {children && (bodyPad ? <div className="panel-body">{children}</div> : children)}
    </section>
  );
}

export function PageHeader({ title, sub, crumbs, right }) {
  return (
    <div className="pagehead">
      <div style={{ minWidth: 0, flex: '1 1 auto' }}>
        {crumbs && <nav className="crumbs">{crumbs}</nav>}
        <h1 className="page-title">{title}</h1>
        {sub && <p className="meta sub">{sub}</p>}
      </div>
      {right && <div className="toolbar" style={{ flex: '0 0 auto' }}>{right}</div>}
    </div>
  );
}

/* ── metrics ─────────────────────────────────────────────────────────────── */

/**
 * Up to five metrics in ONE region with quiet dividers.
 *
 * Not five floating cards: five cards read as five objects competing for
 * attention, and at 1366x768 they pushed the action queue out of the fold
 * entirely. Provenance belongs to the region (see `source`), not to each value.
 */
export function MetricSummary({ items, source, loading }) {
  if (loading) {
    return (
      <div className="metrics">
        {[0, 1, 2, 3, 4].map((i) => (
          <div className="metric" key={i}>
            <div className="skel" style={{ height: 14, width: 70 }} />
            <div className="skel" style={{ height: 26, width: 96, marginTop: 6 }} />
            <div className="skel" style={{ height: 12, width: 110, marginTop: 6 }} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="metrics">
      {items.map((m, i) => (
        <div className="metric" key={m.label}>
          <div className="label">
            <span className="truncate">{m.label}</span>
            {m.hint && <Hint text={m.hint} />}
            {/* Only where this metric's basis differs from the region's. */}
            {m.source && m.source !== source && <SourceTag kind={m.source} />}
          </div>
          <div className={`value ${m.tone || ''}`}>{m.value ?? '—'}</div>
          {m.delta}
          {m.context && <div className="ctx truncate" title={m.context}>{m.context}</div>}
        </div>
      ))}
    </div>
  );
}

/**
 * A period-over-period change, with an explicit reason whenever there isn't one.
 *
 * The rule that makes this trustworthy: an ABSENT baseline is not a 0% change,
 * and a baseline of zero is not a 100% rise. Both print a reason instead of a
 * number, because a reader cannot tell an invented delta from a real one.
 *
 * `dir` says which way is good. Ad spend is 'neutral' — spending more is not
 * itself better or worse, and colouring it green would be a recommendation this
 * component is not entitled to make.
 */
export function Delta({ current, prior, dir = 'up-good', label = 'vs prior period', loading }) {
  if (loading) return <span className="delta delta-none">comparing…</span>;
  const c = Number(current);
  const p = Number(prior);
  if (!Number.isFinite(c) || !Number.isFinite(p)) {
    return <span className="delta delta-none">no prior period to compare</span>;
  }
  if (p === 0) {
    return <span className="delta delta-none">prior period was zero — no percentage</span>;
  }
  const d = (c - p) / p;
  const flat = Math.abs(d) < 0.005;
  const tone = flat || dir === 'neutral' ? '' : ((d > 0) === (dir === 'up-good') ? 'pos' : 'neg');
  return (
    <span className={`delta ${tone}`}>
      {flat ? '±' : d > 0 ? '▲' : '▼'} {d > 0 && !flat ? '+' : ''}{(d * 100).toFixed(0)}%{' '}
      <span className="muted">{label}</span>
    </span>
  );
}

export const SourceTag = ({ kind }) => (
  <span className={`sourcetag sourcetag-${kind}`}>{kind}</span>
);

/** A definition reachable by keyboard, not only by hover. */
export const Hint = ({ text }) => (
  <span className="hint" tabIndex={0} role="note" aria-label={text} title={text}>?</span>
);

/* ── status ──────────────────────────────────────────────────────────────── */

const STATUS_META = {
  winner:       { label: 'Winner',        tone: 'ok',   why: 'Three or more orders in this window and not declining.' },
  candidate:    { label: 'Candidate',     tone: 'info', why: 'Has sold, but below the order threshold that makes a winner.' },
  rising:       { label: 'Rising',        tone: 'ok',   why: 'Up more than 30% against the previous 7 days.' },
  declining:    { label: 'Declining GMV', tone: 'warn', why: 'Down more than 30% against the previous 7 days. A revenue drop only — nothing here claims an audience was worn out.' },
  fatigue_risk: { label: 'Fatigue risk',  tone: 'bad',  why: 'Was earning meaningfully before it fell more than 30%. Per-video spend is not available, so continuing exposure cannot be confirmed.' },
  new:          { label: 'New',           tone: 'info', why: 'Its first sale ever is inside the last 7 days — established from full history, not from the first row of a filtered report.' },
  no_baseline:  { label: 'No baseline',   tone: 'info', why: 'No revenue in the prior diagnostic week, and not new either. A comparison cannot be computed — this is unavailable, not a 100% decline.' },
};

export const StatusLabel = ({ status }) => {
  const m = STATUS_META[status];
  if (!m) return <span className="muted">—</span>;
  return <span className={`status status-${m.tone}`} title={m.why}>{m.label}</span>;
};

export const STATUSES = Object.entries(STATUS_META).map(([value, v]) => ({ value, label: v.label }));

/* ── notice ──────────────────────────────────────────────────────────────── */

/**
 * A notice is a SENTENCE.
 *
 * The previous one was `display:flex; gap:10px`, which made every inline
 * <strong> and every text node a flex item — so a sentence rendered as
 * fragments ten pixels apart. The icon gets its own grid column; the text is
 * one ordinary block, so inline runs stay inline and wrap normally.
 */
export function Notice({ tone = 'default', icon, children, actions }) {
  const glyph = icon ?? { warn: '⚠', error: '⚠', info: 'ℹ' }[tone];
  return (
    <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      {glyph ? <span className="notice-icon" aria-hidden="true">{glyph}</span> : <span />}
      <div className="notice-text">
        {children}
        {actions && <div className="row" style={{ marginTop: 8 }}>{actions}</div>}
      </div>
    </div>
  );
}

/* ── drawer ──────────────────────────────────────────────────────────────── */

/**
 * A right-side drawer, rendered in a PORTAL at the document root.
 *
 * The old creative detail was a <tr> inside the table's `overflow-x: auto`
 * container, so it lived in the table's horizontal scroll coordinate system:
 * opening the rightmost Details control scrolled the table sideways and the
 * expanded content began off-screen to the left. A portal cannot inherit that
 * clipping, because it is not inside it.
 *
 * Focus returns to the element that opened it, so the table keeps its place.
 */
export function Drawer({ open, onClose, title, sub, children, footer, labelledBy = 'drawer-title' }) {
  const panel = useRef(null);
  const opener = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    opener.current = document.activeElement;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'Tab' && panel.current) {
        const f = panel.current.querySelectorAll(
          'a[href], button:not(:disabled), input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0]; const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Move focus in without yanking the page: the panel itself, not a control.
    requestAnimationFrame(() => panel.current?.focus());
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      // Restoring focus is what preserves the table's scroll position and the
      // user's sense of where they were.
      if (opener.current instanceof HTMLElement) opener.current.focus({ preventScroll: true });
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby={labelledBy}
        ref={panel} tabIndex={-1}>
        <header className="drawer-head">
          <div style={{ minWidth: 0, flex: '1 1 auto' }}>
            <h2 className="section-title" id={labelledBy}>{title}</h2>
            {sub && <p className="meta" style={{ margin: '2px 0 0' }}>{sub}</p>}
          </div>
          <button className="btn btn-quiet btn-sm" onClick={onClose} aria-label="Close">Close</button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-head" style={{ borderBottom: 0, borderTop: '1px solid var(--divider)' }}>{footer}</div>}
      </aside>
    </>,
    document.body,
  );
}

/** Small hook so a table row can own its drawer without prop-drilling. */
export function useDrawer() {
  const [openId, setOpenId] = useState(null);
  return {
    openId,
    isOpen: (id) => openId === id,
    open: useCallback((id) => setOpenId(id), []),
    close: useCallback(() => setOpenId(null), []),
  };
}

/* ── table helpers ───────────────────────────────────────────────────────── */

export function SortHeader({ label, field, sort, dir, onSort, num = false, hint, sticky }) {
  const active = sort === field;
  return (
    <th className={[num ? 'num' : '', sticky ? 'sticky-l' : ''].filter(Boolean).join(' ')}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button className="sortbtn" onClick={() => onSort(field)}>
        {label}<span className="sortmark">{active ? (dir === 'asc' ? '▲' : '▼') : ''}</span>
      </button>
      {hint && <Hint text={hint} />}
    </th>
  );
}

export function Pager({ page, pageSize, total, onPage, loading }) {
  // "No results" is a MEASUREMENT. Rendering it before the query has answered
  // tells the reader something the app has not established — the same defect as
  // a confident zero, in a different place. Caught by the browser gate reading
  // a creatives table that held 550 rows.
  if (loading && total == null) {
    return <div className="pager"><span className="skel" style={{ height: 14, width: 150 }} /></div>;
  }
  const t = Number(total) || 0;
  const pages = Math.max(1, Math.ceil(t / pageSize));
  const from = t === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(t, (page + 1) * pageSize);
  return (
    <div className="pager">
      <span>{t === 0 ? 'No results' : `${from.toLocaleString()}–${to.toLocaleString()} of ${t.toLocaleString()}`}</span>
      {pages > 1 && (
        <>
          <span className="spacer" />
          <button className="btn btn-sm" onClick={() => onPage(page - 1)} disabled={page === 0}>Previous</button>
          <span>Page {page + 1} of {pages}</span>
          <button className="btn btn-sm" onClick={() => onPage(page + 1)} disabled={page + 1 >= pages}>Next</button>
        </>
      )}
    </div>
  );
}

/** Column chooser — the first way to reduce crowding, before shrinking text. */
export function ColumnPicker({ columns, visible, onChange }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>Columns</button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 30 }} onClick={() => setOpen(false)} />
          <div className="panel" style={{
            position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 31,
            minWidth: 200, padding: 8, boxShadow: 'var(--shadow-pop)',
          }}>
            {columns.map((c) => (
              <label key={c.key} className="row" style={{ padding: '6px 8px', cursor: 'pointer', flexWrap: 'nowrap' }}>
                <input type="checkbox" checked={visible.includes(c.key)} disabled={c.required}
                  onChange={(e) => onChange(e.target.checked
                    ? [...visible, c.key]
                    : visible.filter((k) => k !== c.key))} />
                <span>{c.label}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ── media identity ──────────────────────────────────────────────────────── */

/** One neutral placeholder for everything without an image. */
export const Thumb = ({ src, alt = '', kind = 'video' }) => (
  src
    ? <img className="thumb" src={src} alt={alt} loading="lazy" />
    : (
      <span className="thumb thumb-none" aria-hidden="true">
        {kind === 'video'
          ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m10 9 5 3-5 3z" /></svg>
          : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="m3 15 5-5 4 4 3-3 6 6" /></svg>}
      </span>
    )
);

/**
 * A thumbnail plus a name, optionally linked.
 *
 * `external` opens the link in a new tab. It exists because the destination for
 * a creative is TikTok itself: the operator wants to WATCH the video, and
 * navigating away from a half-read analysis to do that loses their place and
 * their filters. A new tab keeps the report where it was.
 *
 * The thumbnail is inside the link too. A picture of a video that is not
 * clickable is the most obviously clickable thing on the row, and reaching for
 * it and getting nothing is the small failure that teaches people the table is
 * inert.
 */
export function Identity({ src, name, sub, to, onClick, kind = 'video', title, external = false }) {
  const label = (
    <span className="ident-name clamp2" title={title || name}>
      {name}
      {external && to && <span className="ident-ext" aria-hidden="true"> ↗</span>}
    </span>
  );
  const linked = to || onClick;
  const linkProps = external && to
    // noreferrer as well as noopener: the new tab must not be handed a
    // window.opener it could navigate, and the shop's URL is not TikTok's
    // business.
    ? { target: '_blank', rel: 'noopener noreferrer' }
    : {};
  const thumb = <Thumb src={src} kind={kind} />;

  return (
    <div className="ident">
      {linked
        ? (
          <a className="ident-thumblink" href={to} onClick={onClick} {...linkProps}
            tabIndex={-1} aria-hidden="true">
            {thumb}
          </a>
        )
        : thumb}
      <div className="ident-text">
        {linked
          ? (
            <a className="identity" href={to} onClick={onClick} {...linkProps}
              title={external && to ? `${title || name} — opens on TikTok in a new tab` : undefined}>
              {label}
            </a>
          )
          : label}
        {sub && <div className="ident-sub truncate">{sub}</div>}
      </div>
    </div>
  );
}

/* ── states ──────────────────────────────────────────────────────────────── */

export const Skeleton = ({ h = 100, w = '100%' }) => (
  <div className="skel" style={{ height: h, width: w }} />
);

export function EmptyState({ title, children, action }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{children}</p>
      {action && <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>{action}</div>}
    </div>
  );
}

/** "Unavailable" is a state with a reason, distinct from zero and from error. */
export const Unavailable = ({ reason, children }) => (
  <span className="muted" title={reason} style={{ borderBottom: '1px dotted var(--divider-strong)', cursor: 'help' }}>
    {children || '—'}
  </span>
);

export const Bar = ({ value, color = 'var(--series-paid)' }) => (
  <div className="bar" title={pct(value)}>
    <i style={{ width: `${Math.max(0, Math.min(1, Number(value) || 0)) * 100}%`, background: color }} />
  </div>
);

/**
 * Three distinct states, never collapsed into one:
 *   a number     — measured movement
 *   No baseline  — the prior period had no revenue; NOT a 100% decline
 *   —            — the window is too short to compare at all
 */
export const Trend = ({ value, hasBaseline, measurable = true }) => {
  if (!measurable) return <span className="muted" title="Needs a 14-day window to compare against">—</span>;
  if (hasBaseline === false || value == null) {
    return <span className="muted" title="No revenue in the prior 7 days, so there is nothing to compare against. This is not a decline.">No baseline</span>;
  }
  const v = Number(value);
  const cls = v > 0.02 ? 'trend-up' : v < -0.02 ? 'trend-down' : 'muted';
  const mark = v > 0.02 ? '▲' : v < -0.02 ? '▼' : '';
  // THE THRESHOLD, EXPLAINED WHERE THE APPARENT CONTRADICTION IS.
  //
  // A video down 23% is not labelled Declining, because that status needs 30%.
  // On screen that reads as the app disagreeing with its own arrow, so the
  // number itself carries the reason rather than leaving the reader to infer a
  // bug. Only where it is genuinely ambiguous: a fall short of the bar, or a
  // rise short of it.
  const shortOfBar = v <= -0.02 && v > -0.30
    ? `Down ${Math.abs(v * 100).toFixed(0)}%, which is a real fall but short of the 30% needed for Declining GMV. The status band and the arrow measure the same thing at different thresholds.`
    : v >= 0.02 && v < 0.30
      ? `Up ${(v * 100).toFixed(0)}%, short of the 30% needed for Rising.`
      : undefined;
  return (
    <span className={cls} title={shortOfBar}>
      {mark} {v > 0 ? '+' : ''}{(v * 100).toFixed(0)}%
      {shortOfBar && <span className="muted" aria-hidden="true"> ·</span>}
    </span>
  );
};

export { money, moneyExact, pct, numOrNull, fixed };
