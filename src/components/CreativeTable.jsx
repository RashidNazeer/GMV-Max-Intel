// ONE creative table, used on Creatives and inside product/campaign detail.
//
// ── THE CLIPPING DEFECT THIS FIXES ─────────────────────────────────────────
// Detail used to expand into a <tr> INSIDE the table's `overflow-x: auto`
// container, so it lived in the table's horizontal scroll coordinate system.
// Clicking the rightmost Details control made the browser scroll the table
// sideways to reveal the trigger, and the expanded content then began off the
// left edge of the visible area. The identity column went with it.
//
// The detail is now a right-side drawer rendered in a PORTAL at the document
// root. It cannot inherit the table's clipping because it is not inside it,
// and closing it returns focus to the row that opened it — which is what
// preserves the table's scroll position, filters and result set.
//
// The identity column is sticky, so the video you are reading about stays
// visible while you scroll to its numbers.
import { useState } from 'react';
import {
  Skeleton, Pager, SortHeader, StatusLabel, STATUSES, Identity, Bar, Trend,
  Drawer, ColumnPicker, EmptyState, Notice, money, moneyExact, pct,
} from './ui.jsx';

const PAGE_SIZE = 50;

const ALL_COLUMNS = [
  { key: 'video',    label: 'Video',        required: true },
  { key: 'creator',  label: 'Creator',      required: true },
  { key: 'status',   label: 'Status',       required: true },
  { key: 'gmv',      label: 'GMV',          required: true },
  { key: 'orders',   label: 'Orders',       required: true },
  { key: 'trend',    label: '7-day trend',  required: true },
  { key: 'paid_gmv', label: 'Ad-driven' },
  { key: 'share',    label: 'Ad share' },
  { key: 'age',      label: 'Age' },
  { key: 'views',    label: 'Lifetime views' },
];
const DEFAULT_COLUMNS = ALL_COLUMNS.filter((c) => c.required).map((c) => c.key);

/** A caption is not an identity — strip hashtags so rows differ from each other. */
export function shortTitle(v) {
  const t = (v.title || '').trim();
  if (!t) return v.video_id;
  const clean = t.replace(/#\S+/g, '').replace(/\s+/g, ' ').trim();
  return clean.length > 4 ? clean : t;
}

export default function CreativeTable({
  rows, total, loading, cur, page, sort, dir, search, status,
  onSort, onPage, onSearch, onStatus, onClear,
  trendMeasurable = true, toolbar = true, contextBar = null, emptyHint = null,
}) {
  const [cols, setCols] = useState(DEFAULT_COLUMNS);
  const [openVideo, setOpenVideo] = useState(null);
  const show = (k) => cols.includes(k);
  const filtered = !!(search || status);

  return (
    <>
      {toolbar && (
        <div className="panel-body" style={{ paddingBottom: 12, borderBottom: '1px solid var(--divider)' }}>
          <div className="toolbar">
            <input className="input" placeholder="Search creator, caption or ID"
              aria-label="Search creatives" value={search || ''}
              onChange={(e) => onSearch(e.target.value)} style={{ minWidth: 240, flex: '1 1 240px' }} />
            <select className="input" aria-label="Status" value={status || ''}
              onChange={(e) => onStatus(e.target.value)}>
              <option value="">All statuses</option>
              {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <ColumnPicker columns={ALL_COLUMNS} visible={cols} onChange={setCols} />
            <span className="spacer" />
            <span className="meta">{Number(total || 0).toLocaleString()} results</span>
            {filtered && <button className="btn btn-sm" onClick={onClear}>Clear filters</button>}
          </div>
          {contextBar}
        </div>
      )}

      {loading && !rows?.length ? (
        <div className="panel-body"><Skeleton h={260} /></div>
      ) : !rows?.length ? (
        <EmptyState title={filtered ? 'No videos match these filters' : 'No videos with revenue'}
          action={filtered ? <button className="btn" onClick={onClear}>Clear filters</button> : null}>
          {filtered
            ? 'Try a broader search or a different status.'
            : (emptyHint || 'This shop has no affiliate order lines carrying a video ID in this window.')}
        </EmptyState>
      ) : (
        <div className="tablewrap">
          <table className="data">
            <thead>
              <tr>
                <th className="sticky-l">Video</th>
                <th>Creator</th>
                <th>Status</th>
                <SortHeader label="GMV" field="gmv" sort={sort} dir={dir} onSort={onSort} num />
                {show('paid_gmv') && <SortHeader label="Ad-driven" field="paid_gmv" sort={sort} dir={dir} onSort={onSort} num />}
                {show('share') && <th>Ad share</th>}
                <SortHeader label="Orders" field="orders" sort={sort} dir={dir} onSort={onSort} num />
                <SortHeader label="7-day trend" field="trend" sort={sort} dir={dir} onSort={onSort} num
                  hint="Last 7 complete days against the 7 immediately before. Both windows are retrieved even when the report range is shorter." />
                {show('age') && <SortHeader label="Age" field="age" sort={sort} dir={dir} onSort={onSort} num />}
                {show('views') && <SortHeader label="Lifetime views" field="views" sort={sort} dir={dir} onSort={onSort} num
                  hint="Lifetime views from the video feed. The reporting date filter does NOT change them." />}
                <th className="num">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.video_id} className="media">
                  <td className="sticky-l">
                    <Identity name={shortTitle(v)} title={v.title || v.video_id}
                      sub={v.video_id} kind="video" />
                  </td>
                  <td className="muted">@{v.creator_handle}</td>
                  <td><StatusLabel status={v.status} /></td>
                  <td className="num"><strong>{moneyExact(v.gmv, cur)}</strong></td>
                  {show('paid_gmv') && <td className="num">{moneyExact(v.paid_gmv, cur)}</td>}
                  {show('share') && (
                    <td>
                      <div className="row" style={{ flexWrap: 'nowrap', gap: 8 }}>
                        <Bar value={v.paid_share} />
                        <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>{pct(v.paid_share, 0)}</span>
                      </div>
                    </td>
                  )}
                  <td className="num">{Number(v.orders || 0).toLocaleString()}</td>
                  <td className="num"><Trend value={v.trend_pct} hasBaseline={v.has_baseline} measurable={trendMeasurable} /></td>
                  {show('age') && <td className="num muted">{v.age_days == null ? '—' : `${v.age_days}d`}</td>}
                  {show('views') && <td className="num muted">{v.views == null ? '—' : Number(v.views).toLocaleString()}</td>}
                  <td className="num">
                    <button className="btn btn-sm" onClick={() => setOpenVideo(v)}
                      aria-label={`Details for ${shortTitle(v)}`}>Details</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {onPage && <Pager page={page} pageSize={PAGE_SIZE} total={total} onPage={onPage} />}

      <CreativeDrawer video={openVideo} cur={cur} onClose={() => setOpenVideo(null)} />
    </>
  );
}

function CreativeDrawer({ video, cur, onClose }) {
  if (!video) return null;
  const v = video;

  const why = {
    winner: `${v.orders} orders in this window, and not declining.`,
    candidate: `${v.orders} order${Number(v.orders) === 1 ? '' : 's'} — below the three that make a winner.`,
    rising: 'Up more than 30% against the previous 7 days.',
    declining: 'Down more than 30% against the previous 7 days. A revenue drop only.',
    fatigue_risk: `Was earning ${moneyExact(v.prior_gmv, cur)} the week before and fell more than 30%. Per-video spend is not available, so we cannot confirm it was still being shown.`,
    new: 'First sold inside the last 7 days, so there is no prior week to compare against.',
  }[v.status];

  return (
    <Drawer open onClose={onClose} title={shortTitle(v)} sub={`@${v.creator_handle}`}>
      <div className="stack">
        <div className="row" style={{ gap: 12, flexWrap: 'nowrap' }}>
          <Identity name="" kind="video" />
          <div>
            <StatusLabel status={v.status} />
            <p className="meta" style={{ margin: '6px 0 0', lineHeight: '18px' }}>{why}</p>
          </div>
        </div>

        <section>
          <h3 className="section-title">Full caption</h3>
          <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', lineHeight: '20px' }}>
            {v.title || <span className="muted">No caption on the video feed.</span>}
          </p>
        </section>

        <section>
          <h3 className="section-title">Performance</h3>
          <dl className="dl" style={{ marginTop: 8 }}>
            <dt>GMV in window</dt><dd>{moneyExact(v.gmv, cur)}</dd>
            <dt>Ad-driven</dt><dd>{moneyExact(v.paid_gmv, cur)} <span className="muted">({pct(v.paid_share, 0)})</span></dd>
            <dt>Orders</dt><dd>{Number(v.orders || 0).toLocaleString()}</dd>
            <dt>Last 7 days</dt><dd>{moneyExact(v.recent_gmv, cur)}</dd>
            <dt>Previous 7 days</dt>
            <dd>{v.has_baseline ? moneyExact(v.prior_gmv, cur) : <span className="muted">No baseline</span>}</dd>
            <dt>Share of video revenue</dt><dd>{pct(v.gmv_share, 1)}</dd>
            <dt>Order lines</dt><dd>{Number(v.lines || 0).toLocaleString()}</dd>
            <dt>Posted</dt>
            <dd>{v.posted_date ? new Date(v.posted_date).toLocaleDateString() : <span className="muted">Unknown</span>}</dd>
            <dt>Lifetime views</dt>
            <dd>{v.views == null ? <span className="muted">—</span> : Number(v.views).toLocaleString()}</dd>
            <dt>Video ID</dt><dd className="mono">{v.video_id}</dd>
          </dl>
        </section>

        {v.tiktok_url && (
          <a className="btn" href={v.tiktok_url} target="_blank" rel="noreferrer">Open on TikTok ↗</a>
        )}
      </div>
    </Drawer>
  );
}

export { ALL_COLUMNS, PAGE_SIZE };
