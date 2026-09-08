// ONE creative table, used on the Creatives page and inside campaign and
// product detail. The spec asks for a single reusable table for exactly the
// reason this project keeps rediscovering: two implementations of one view
// drift, and then two screens quote different counts for the same question.
//
// Reacher supplies NO thumbnail for a video — no cover field on the feed and
// nothing image-shaped in the raw payload either. So every row gets a neutral
// placeholder built from the creator's initial, and the record stays usable.
// A missing image is not a broken row.
import { useState } from 'react';
import {
  Note, Skeleton, MiniBar, Trend, Toolbar, Pager, SortTh, StatusChip, STATUSES,
  money, moneyExact, pct,
} from './ui.jsx';

const PAGE_SIZE = 50;

/**
 * A caption is not an identity. Stripping hashtags first means the column shows
 * what distinguishes one video from another instead of forty identical prefixes.
 */
export function shortTitle(v) {
  const t = (v.title || '').trim();
  if (!t) return v.video_id;
  const clean = t.replace(/#\S+/g, '').replace(/\s+/g, ' ').trim();
  return clean.length > 4 ? clean : t;
}

/** Neutral placeholder — the provider gives no cover image for any video. */
function VideoMark({ v }) {
  const seed = (v.creator_handle || v.video_id || '?');
  const initial = seed.replace(/[^a-z0-9]/gi, '').charAt(0).toUpperCase() || '?';
  // Deterministic hue so the same creator keeps the same mark between renders.
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return (
    <span className="vmark" style={{ '--vh': h }} aria-hidden="true">{initial}</span>
  );
}

export default function CreativeTable({
  rows, total, loading, cur, page, sort, dir, search, status,
  onSort, onPage, onSearch, onStatus, onClear,
  trendMeasurable = true, compact = false, banner = null, emptyHint = null,
}) {
  const [open, setOpen] = useState(null);
  const filtered = !!(search || status);

  return (
    <>
      {!compact && (
        <div className="pad" style={{ paddingTop: 0, paddingBottom: 10 }}>
          <Toolbar count={total} onClear={onClear} active={filtered}>
            <input className="input" placeholder="Search creator, caption or id"
              aria-label="Search creatives"
              value={search || ''} onChange={(e) => onSearch(e.target.value)} style={{ minWidth: 230 }} />
            <select className="input" aria-label="Filter by status"
              value={status || ''} onChange={(e) => onStatus(e.target.value)}>
              <option value="">All statuses</option>
              {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </Toolbar>
          {banner}
        </div>
      )}

      {loading && !rows?.length ? <div className="pad"><Skeleton h={240} /></div> : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Video</th>
                <th>Creator</th>
                <th>Status</th>
                <SortTh label="GMV" field="gmv" sort={sort} dir={dir} onSort={onSort} num />
                {!compact && <SortTh label="Ad-driven" field="paid_gmv" sort={sort} dir={dir} onSort={onSort} num />}
                {!compact && <th style={{ width: 104 }}>Ad share</th>}
                <SortTh label="Orders" field="orders" sort={sort} dir={dir} onSort={onSort} num />
                <SortTh label="7d trend" field="trend" sort={sort} dir={dir} onSort={onSort} num
                  hint="Last 7 complete days against the 7 immediately before. Both windows are retrieved even when the report range is shorter." />
                {!compact && <SortTh label="Age" field="age" sort={sort} dir={dir} onSort={onSort} num />}
                {!compact && <SortTh label="Views" field="views" sort={sort} dir={dir} onSort={onSort} num
                  hint="Lifetime views from the video feed. The reporting date filter does NOT change them." />}
                <th style={{ width: 1 }}></th>
              </tr>
            </thead>
            <tbody>
              {(rows || []).map((v) => {
                const isOpen = open === v.video_id;
                return [
                  <tr key={v.video_id} className={isOpen ? 'row-open' : undefined}>
                    <td className="tight">
                      <div className="vcell">
                        <VideoMark v={v} />
                        {v.tiktok_url
                          ? <a href={v.tiktok_url} target="_blank" rel="noreferrer" className="truncate"
                              title={v.title || v.video_id}>{shortTitle(v)}</a>
                          : <span className="truncate" title={v.title || v.video_id}>{shortTitle(v)}</span>}
                      </div>
                    </td>
                    <td className="tight muted">@{v.creator_handle}</td>
                    <td className="tight"><StatusChip status={v.status} /></td>
                    <td className="num tight"><strong>{moneyExact(v.gmv, cur)}</strong></td>
                    {!compact && <td className="num tight" style={{ color: 'var(--paid)' }}>{moneyExact(v.paid_gmv, cur)}</td>}
                    {!compact && (
                      <td className="tight">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <MiniBar value={v.paid_share} />
                          <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>{pct(v.paid_share, 0)}</span>
                        </div>
                      </td>
                    )}
                    <td className="num tight muted">{Number(v.orders || 0).toLocaleString()}</td>
                    <td className="num tight">
                      <Trend value={v.trend_pct} hasBaseline={v.has_baseline} measurable={trendMeasurable} />
                    </td>
                    {!compact && <td className="num tight muted">{v.age_days == null ? '—' : `${v.age_days}d`}</td>}
                    {!compact && <td className="num tight muted">{v.views == null ? '—' : Number(v.views).toLocaleString()}</td>}
                    <td className="tight">
                      <button className="lnk" aria-expanded={isOpen}
                        onClick={() => setOpen(isOpen ? null : v.video_id)}>
                        {isOpen ? 'Close' : 'Detail'}
                      </button>
                    </td>
                  </tr>,
                  isOpen && (
                    <tr key={`${v.video_id}-d`} className="row-detail">
                      <td colSpan={compact ? 7 : 11}>
                        <VideoDetail v={v} cur={cur} />
                      </td>
                    </tr>
                  ),
                ];
              })}
              {!rows?.length && !loading && (
                <tr><td colSpan={compact ? 7 : 11} className="muted" style={{ padding: 22, textAlign: 'center' }}>
                  {filtered
                    ? <>No videos match these filters. <button className="lnk" onClick={onClear}>Clear them</button>.</>
                    : (emptyHint || 'No videos with revenue in this window.')}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {!compact && (
        <div className="pad" style={{ paddingTop: 12 }}>
          <Pager page={page} pageSize={PAGE_SIZE} total={total} onPage={onPage} />
        </div>
      )}
    </>
  );
}

/**
 * The row detail: the full caption, the evidence behind the status, and the
 * recent history — without pushing the buyer out of the app.
 */
function VideoDetail({ v, cur }) {
  const why = {
    winner: `${v.orders} orders in this window and not declining.`,
    candidate: `${v.orders} order${Number(v.orders) === 1 ? '' : 's'} — below the three that make a winner.`,
    rising: 'Up more than 30% against the previous 7 days.',
    declining: 'Down more than 30% against the previous 7 days. A revenue drop only.',
    fatigue_risk: `Was earning ${moneyExact(v.prior_gmv, cur)} the week before and fell more than 30%. Per-video spend is not available, so we cannot confirm it was still being shown.`,
    new: 'First sold inside the last 7 days, so there is no prior week to compare against.',
  }[v.status];

  return (
    <div className="vdetail">
      <div>
        <div className="k">Full caption</div>
        <p className="vcaption">{v.title || <em className="muted">No caption on the video feed.</em>}</p>
        <div className="k" style={{ marginTop: 12 }}>Why this status</div>
        <p className="vwhy">{why}</p>
      </div>
      <div className="vfacts">
        <div className="vfact"><span>Last 7 days</span><b>{moneyExact(v.recent_gmv, cur)}</b></div>
        <div className="vfact"><span>Previous 7 days</span><b>{v.has_baseline ? moneyExact(v.prior_gmv, cur) : <em className="muted">no baseline</em>}</b></div>
        <div className="vfact"><span>Share of video revenue</span><b>{pct(v.gmv_share, 1)}</b></div>
        <div className="vfact"><span>Order lines</span><b>{Number(v.lines || 0).toLocaleString()}</b></div>
        <div className="vfact"><span>Posted</span><b>{v.posted_date ? new Date(v.posted_date).toLocaleDateString() : <em className="muted">unknown</em>}</b></div>
        {v.tiktok_url && (
          <a className="btn" href={v.tiktok_url} target="_blank" rel="noreferrer" style={{ marginTop: 8 }}>
            Open on TikTok ↗
          </a>
        )}
      </div>
    </div>
  );
}
