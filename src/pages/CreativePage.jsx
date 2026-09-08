// Creatives — a working review tool.
//
// ── WHAT WAS BROKEN ────────────────────────────────────────────────────────
// The page reported "573 videos earning" and "61 fading" and then rendered a
// hardcoded top 50 with no search, no filter, no paging and no working sort.
// The server capped at 200, so 373 of Cutler's videos were unreachable at any
// setting. A finding could tell you 61 videos were declining and then offer no
// way to see them.
//
// The table itself now lives in components/CreativeTable.jsx, because campaign
// and product detail need the same one — two implementations of a view is how
// two screens end up quoting different counts for the same question.
import { useOutletContext, useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { shopCreativeHealth, shopTopVideos, money, pct } from '../lib/api.js';
import { useLocalParams, scopedTo } from '../lib/scope.js';
import CreativeTable from '../components/CreativeTable.jsx';
import { Card, Stat, Note, Skeleton, Empty } from '../components/ui.jsx';

const PAGE_SIZE = 50;
const DEFAULTS = { q: '', status: '', sort: 'gmv', dir: 'desc', page: '0' };

export default function CreativePage() {
  const { shop, scope } = useOutletContext();
  const [params] = useSearchParams();
  const lp = useLocalParams(DEFAULTS);
  const cur = shop.currency || 'USD';

  const search = lp.get('q') || '';
  const status = lp.get('status') || '';
  const sort = lp.get('sort') || 'gmv';
  const dir = lp.get('dir') || 'desc';
  const page = Math.max(0, Number(lp.get('page')) || 0);
  // A finding's exact set, passed through the URL so the count the buyer was
  // shown is the count they land on.
  const ids = (params.get('ids') || '').split(',').filter(Boolean);

  const healthQ = useQuery({
    queryKey: ['creative', shop.id, scope.start, scope.end],
    queryFn: () => shopCreativeHealth(shop.id, scope.start, scope.end),
  });

  const listQ = useQuery({
    queryKey: ['vids', shop.id, scope.start, scope.end, search, status, sort, dir, page, ids.join(',')],
    queryFn: () => shopTopVideos(shop.id, scope.start, scope.end, {
      limit: PAGE_SIZE, offset: page * PAGE_SIZE, search, status, sort, dir, ids,
    }),
    placeholderData: (prev) => prev,   // no flash of an empty table while paging
  });

  const h = healthQ.data;
  if (healthQ.error) return <Note tone="warn">{healthQ.error.message}</Note>;

  if (!healthQ.isLoading && (!h || !Number(h.video_count))) {
    return (
      <Empty title="No video revenue in this window">
        Creative health is computed from affiliate order lines carrying a video id. This shop has
        none between {scope.start} and {scope.end}.
      </Empty>
    );
  }

  const gmv = Number(h?.gmv) || 0;

  const onSort = (field) => {
    if (sort === field) lp.set({ dir: dir === 'asc' ? 'desc' : 'asc' });
    else lp.set({ sort: field, dir: 'desc' });
  };

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="grid g4">
        <Stat k="Videos earning" basis="measured" v={Number(h?.video_count || 0).toLocaleString()}
          sub={`${Number(h?.creators || 0).toLocaleString()} creators · ${money(gmv, cur)}`}
          hint="Distinct videos with at least one affiliate order line in this window. This is the population the table pages through." />

        <Stat k="Top 5 share" basis="measured"
          tone={Number(h?.top5_share) >= 0.5 ? 'danger' : undefined}
          v={pct(h?.top5_share)} sub={`top 1 is ${pct(h?.top1_share)}`}
          hint="Share of affiliate video revenue held by the five highest-earning videos. High concentration means a lot of revenue has nothing behind it when those decay." />

        <Stat k="Declining GMV" basis="measured"
          tone={gmv && Number(h?.declining_gmv) / gmv >= 0.3 ? 'danger' : undefined}
          v={h?.trend_measurable === false ? '—' : money(h?.declining_gmv, cur)}
          sub={h?.trend_measurable === false
            ? 'needs a 14-day window to compare against'
            : `${h?.declining_videos} videos down >30% week-on-week`}
          hint="A revenue drop against the previous 7 days — and nothing more. It does not claim an audience was worn out; that is 'Fatigue risk', which additionally requires the video to have been earning well beforehand." />

        <Stat k="Rising" basis="measured" tone="organic"
          v={h?.trend_measurable === false ? '—' : money(h?.rising_gmv, cur)}
          sub={h?.trend_measurable === false
            ? 'needs a 14-day window to compare against'
            : `${h?.rising_videos} up >30% · ${h?.new_videos} new`} />
      </div>

      {h?.population_complete === false && (
        <Note tone="warn">
          These headline counts describe only part of this shop&rsquo;s videos — the population has grown
          past what the aggregate reads in one pass. Treat the figures above as a lower bound.
        </Note>
      )}

      {h?.baseline_coverage != null && Number(h.baseline_coverage) < 0.9 && (
        <Note tone="info">
          A prior week to compare against exists for <strong>{pct(h.baseline_coverage)}</strong> of videos.
          The rest are marked <em>no baseline</em> rather than counted as a 100% decline — a video that did
          not exist last week has not fallen.
        </Note>
      )}

      <Card title="Videos" pad={false}
        sub="Revenue always comes from classified order lines. Age and views come from Reacher's video feed.">
        <CreativeTable
          rows={listQ.data?.rows} total={listQ.data?.total ?? 0} loading={listQ.isLoading}
          cur={cur} page={page} sort={sort} dir={dir} search={search} status={status}
          trendMeasurable={h?.trend_measurable !== false}
          onSort={onSort}
          onPage={(p) => lp.set({ page: p })}
          onSearch={(q) => lp.set({ q })}
          onStatus={(s) => lp.set({ status: s })}
          onClear={lp.clear}
          banner={ids.length > 0 && (
            <Note tone="info">
              Showing the <strong>{ids.length}</strong> videos behind a finding, for {scope.start} → {scope.end}.
              This is that finding&rsquo;s own set, not a recomputed list.{' '}
              <Link className="lnk" to={scopedTo('/creatives', params)}>Show all videos</Link>
            </Note>
          )}
        />
      </Card>
    </div>
  );
}
