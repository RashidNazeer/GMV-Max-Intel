// Creatives — a media review table.
import { useOutletContext, useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { shopCreativeHealth, shopTopVideos, money, pct } from '../lib/api.js';
import { useLocalParams, scopedTo } from '../lib/scope.js';
import CreativeTable, { PAGE_SIZE } from '../components/CreativeTable.jsx';
import ReportToolbar from '../components/ReportToolbar.jsx';
import {
  Panel, PageHeader, MetricSummary, Notice, Skeleton, EmptyState,
} from '../components/ui.jsx';

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
    placeholderData: (prev) => prev,
  });

  if (healthQ.error) return <Notice tone="error">{healthQ.error.message}</Notice>;

  const h = healthQ.data;
  const gmv = Number(h?.gmv) || 0;

  const onSort = (field) => {
    if (sort === field) lp.set({ dir: dir === 'asc' ? 'desc' : 'asc' });
    else lp.set({ sort: field, dir: 'desc' });
  };

  // Never assert while loading: a zero is a measurement, and a template string
  // over an absent value renders the word "undefined" as content.
  const metrics = healthQ.isLoading || !h ? [] : [
    {
      label: 'Videos earning', value: Number(h.video_count || 0).toLocaleString(),
      context: `${Number(h.creators || 0).toLocaleString()} creators · ${money(gmv, cur)}`,
      hint: 'Distinct videos with at least one affiliate order line in this window. This is the population the table pages through.',
    },
    {
      label: 'Top 5 share', value: pct(h.top5_share),
      tone: Number(h.top5_share) >= 0.5 ? 'neg' : '',
      context: `top 1 is ${pct(h.top1_share)}`,
      hint: 'Share of affiliate video revenue held by the five highest-earning videos.',
    },
    {
      label: 'Declining GMV',
      value: h.trend_measurable === false ? '—' : money(h.declining_gmv, cur),
      tone: gmv && Number(h.declining_gmv) / gmv >= 0.3 ? 'neg' : '',
      context: h.trend_measurable === false
        ? 'needs a 14-day window'
        : `${h.declining_videos} videos down more than 30%`,
      hint: 'A revenue drop against the previous 7 days, and nothing more. It does not claim an audience was worn out — that is Fatigue risk, which also requires the video to have been earning well beforehand.',
    },
    {
      label: 'Rising', value: h.trend_measurable === false ? '—' : money(h.rising_gmv, cur),
      tone: 'pos',
      context: h.trend_measurable === false
        ? 'needs a 14-day window'
        : `${h.rising_videos} up more than 30% · ${h.new_videos} first sold in the last 7 days`,
    },
  ];

  const contextBar = ids.length > 0 ? (
    <div className="contextbar" style={{ marginTop: 12 }}>
      <strong>Finding: {ids.length} videos</strong>
      <span className="muted">for {scope.start} → {scope.end}</span>
      <span className="spacer" />
      <Link className="btn btn-sm" to={scopedTo('/creatives', params)}>Show all videos</Link>
    </div>
  ) : null;

  return (
    <>
      <PageHeader
        title="Creatives"
        sub={ids.length
          ? `Showing one finding's own set of ${ids.length} videos — not a recomputed list.`
          : `${shop.shop_name} · videos with affiliate revenue in this window`}
        right={<ReportToolbar scope={scope} shop={shop} />}
      />

      {healthQ.isLoading
        ? <MetricSummary items={[]} loading />
        : h && Number(h.video_count)
          ? <MetricSummary items={metrics} source="measured" />
          : null}

      {h?.population_complete === false && (
        <Notice tone="warn">
          These counts describe only part of this shop&rsquo;s videos — the population has grown past
          what the aggregate reads in one pass. Treat them as a lower bound.
        </Notice>
      )}

      {h?.baseline_coverage != null && Number(h.baseline_coverage) < 0.9 && (
        <Notice tone="info">
          A prior week to compare against exists for <strong>{pct(h.baseline_coverage)}</strong> of videos.
          The rest are marked <em>No baseline</em> rather than counted as a 100% decline — a video that did
          not exist last week has not fallen.
        </Notice>
      )}

      <Panel bodyPad={false}>
        <CreativeTable
          rows={listQ.data?.rows} total={listQ.data?.total ?? null} loading={listQ.isLoading}
          cur={cur} page={page} sort={sort} dir={dir} search={search} status={status}
          trendMeasurable={h?.trend_measurable !== false}
          onSort={onSort}
          onPage={(p) => lp.set({ page: p })}
          onSearch={(q) => lp.set({ q })}
          onStatus={(s) => lp.set({ status: s })}
          onClear={lp.clear}
          contextBar={contextBar}
        />
      </Panel>
    </>
  );
}
