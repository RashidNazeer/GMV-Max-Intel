-- ============================================================
-- GMV Max Intelligence — 017: an aggregate must not be computed over a
-- truncated list.
--
-- ── HOW THIS WAS FOUND ─────────────────────────────────────────────────────
-- Migration 015 made a finding carry the exact id set behind its count, and
-- scripts/preview.mjs asserts the two agree. On Cutler it did not:
--
--     creative health counts 116 declining videos
--     the id set has        130
--
-- The cause is the same class of defect 015 was written to fix, one level up.
-- shop_creative_health() derives every count by selecting from
-- shop_top_videos(..., 500) — a list clamped to 500 rows. Cutler has 563 videos
-- earning revenue, so the health figures described the top 500 by GMV and
-- silently omitted the rest, while the filtered query (which applies its filter
-- BEFORE the limit) saw all of them.
--
-- Every headline on the Creatives page was therefore computed over a
-- population that was not the population, and nothing said so.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- One definition of a video's status, used by both, and no truncation when it
-- is used as an aggregate source. The paging cap that protects the UI is not
-- the right bound for an aggregate, so they stop being the same number.
--
-- shop_creative_health now also returns population_complete, so a shop that
-- ever outgrows even the aggregate bound says so on screen instead of quietly
-- describing a subset.
-- ============================================================

-- Paging still hands the UI 50 rows at a time; this is the ceiling a caller may
-- ask for. Raised because an aggregate needs the whole population and there is
-- no reason for the same constant to serve both jobs.
drop function if exists public.shop_top_videos(uuid, date, date, int, int, text, text, text, text, text[]);

create or replace function public.shop_top_videos(
  p_shop_id uuid,
  p_start   date,
  p_end     date,
  p_limit   int    default 50,
  p_offset  int    default 0,
  p_search  text   default null,
  p_status  text   default null,
  p_sort    text   default 'gmv',
  p_dir     text   default 'desc',
  p_ids     text[] default null
)
returns table (
  video_id text, creator_handle text, title text, tiktok_url text,
  posted_date timestamptz, age_days integer, lines bigint, orders bigint,
  gmv numeric, paid_gmv numeric, organic_gmv numeric, paid_share numeric,
  gmv_share numeric, recent_gmv numeric, prior_gmv numeric, trend_pct numeric,
  has_baseline boolean, status text, views bigint, total_count bigint
)
language plpgsql stable as $fn$
declare w record; r7 timestamptz; r14 timestamptz; measurable boolean;
begin
  select * into w from public.shop_window(p_shop_id, p_start, p_end);
  r7  := ((p_end - 6)::timestamp  at time zone w.tz);
  r14 := ((p_end - 13)::timestamp at time zone w.tz);
  measurable := (p_end - p_start) >= 13;

  return query
  with lines as (
    select
      l.content_id as vid,
      max(l.creator_handle) as creator_handle,
      count(*) as lines,
      count(distinct l.order_id) as orders,
      coalesce(sum(l.payment_amount), 0) as gmv,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0)    as paid_gmv,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD'), 0) as organic_gmv,
      coalesce(sum(l.payment_amount) filter (where l.order_created_at >= r7), 0) as recent_gmv,
      coalesce(sum(l.payment_amount) filter (
        where l.order_created_at >= r14 and l.order_created_at < r7), 0)         as prior_gmv,
      min(public.shop_day(l.order_created_at, w.tz)) as first_day
    from public.affiliate_order_lines l
    where l.shop_id = p_shop_id
      and l.counts_toward_gmv
      and l.content_id is not null
      and l.content_type = 'Video'
      and l.order_created_at >= w.lo and l.order_created_at < w.hi
    group by l.content_id
  ),
  tot as (select nullif(sum(x.gmv), 0) as gmv from lines x),
  enriched as (
    select
      x.vid, coalesce(v.creator_handle, x.creator_handle) as creator_handle,
      v.title, v.tiktok_url, v.posted_date,
      case when v.posted_date is null then null
           else (p_end - (v.posted_date at time zone 'UTC')::date)::int end as age_days,
      x.lines, x.orders, x.gmv, x.paid_gmv, x.organic_gmv,
      x.paid_gmv / nullif(x.paid_gmv + x.organic_gmv, 0) as paid_share,
      x.gmv / tot.gmv as gmv_share,
      x.recent_gmv, x.prior_gmv,
      case when not measurable then null
           when x.prior_gmv = 0 then null
           else (x.recent_gmv - x.prior_gmv) / x.prior_gmv end as trend_pct,
      (measurable and x.prior_gmv > 0) as has_baseline,
      x.first_day, v.views
    from lines x cross join tot
    left join public.video_latest v on v.shop_id = p_shop_id and v.video_id = x.vid
  ),
  classified as (
    select e.*,
      case
        when e.first_day > p_end - 7 and not e.has_baseline then 'new'
        when e.has_baseline and e.trend_pct <= -0.30 and e.prior_gmv >= 100 then 'fatigue_risk'
        when e.has_baseline and e.trend_pct <= -0.30 then 'declining'
        when e.has_baseline and e.trend_pct >=  0.30 then 'rising'
        when e.orders >= 3 then 'winner'
        else 'candidate'
      end as status
    from enriched e
  ),
  filtered as (
    select c.* from classified c
    where (p_ids is null or c.vid = any(p_ids))
      and (p_status is null or p_status = '' or c.status = p_status)
      and (
        p_search is null or p_search = '' or
        c.vid ilike '%' || p_search || '%' or
        coalesce(c.title, '') ilike '%' || p_search || '%' or
        coalesce(c.creator_handle, '') ilike '%' || p_search || '%'
      )
  ),
  sorted as (
    select f.*,
      count(*) over () as total_count,
      case lower(coalesce(p_sort, 'gmv'))
        when 'paid_gmv' then f.paid_gmv
        when 'orders'   then f.orders::numeric
        when 'trend'    then f.trend_pct
        when 'views'    then f.views::numeric
        when 'age'      then f.age_days::numeric
        else f.gmv
      end as sort_key
    from filtered f
  )
  select
    s.vid, s.creator_handle, s.title, s.tiktok_url, s.posted_date, s.age_days,
    s.lines, s.orders, s.gmv, s.paid_gmv, s.organic_gmv, s.paid_share,
    s.gmv_share, s.recent_gmv, s.prior_gmv, s.trend_pct, s.has_baseline,
    s.status, s.views, s.total_count
  from sorted s
  order by
    case when lower(coalesce(p_dir, 'desc')) = 'asc'  then s.sort_key end asc  nulls last,
    case when lower(coalesce(p_dir, 'desc')) <> 'asc' then s.sort_key end desc nulls last,
    s.vid
  offset greatest(0, coalesce(p_offset, 0))
  -- 20,000 is an aggregate bound, not a page size. The UI asks for 50.
  limit  greatest(1, least(coalesce(p_limit, 50), 20000));
end;
$fn$;


drop function if exists public.shop_creative_health(uuid, date, date);

create or replace function public.shop_creative_health(p_shop_id uuid, p_start date, p_end date)
returns table (
  video_count bigint, gmv numeric, top1_share numeric, top5_share numeric, top10_share numeric,
  declining_videos bigint, declining_gmv numeric,
  fatigue_videos bigint, fatigue_gmv numeric,
  rising_videos bigint, rising_gmv numeric,
  winners bigint, candidates bigint,
  trend_measurable boolean, baseline_coverage numeric,
  fresh_gmv numeric, freshness_coverage numeric,
  new_videos bigint, creators bigint,
  population_complete boolean
)
language plpgsql stable as $fn$
declare w record;
begin
  select * into w from public.shop_window(p_shop_id, p_start, p_end);
  return query
  -- 20,000 rather than 500. Cutler has 563 videos earning in a 30-day window,
  -- so the old bound made every count below describe the top 500 by GMV while
  -- presenting itself as the shop.
  with v as (select * from public.shop_top_videos(p_shop_id, p_start, p_end, 20000)),
  tot as (
    select
      count(distinct l.content_id) as video_count,
      count(distinct l.creator_handle) as creators,
      coalesce(sum(l.payment_amount), 0) as gmv
    from public.affiliate_order_lines l
    where l.shop_id = p_shop_id and l.counts_toward_gmv
      and l.content_id is not null and l.content_type = 'Video'
      and l.order_created_at >= w.lo and l.order_created_at < w.hi
  ),
  ranked as (select v.*, row_number() over (order by v.gmv desc) as rn from v)
  select
    tot.video_count, tot.gmv,
    coalesce((select sum(x.gmv) from ranked x where x.rn <= 1), 0)  / nullif(tot.gmv, 0),
    coalesce((select sum(x.gmv) from ranked x where x.rn <= 5), 0)  / nullif(tot.gmv, 0),
    coalesce((select sum(x.gmv) from ranked x where x.rn <= 10), 0) / nullif(tot.gmv, 0),
    -- Declining INCLUDES fatigue risk: fatigue risk is a decline with the extra
    -- evidence that the video was earning well beforehand. The drill-down
    -- fetches both statuses so its count matches this one exactly.
    (select count(*)                from v where v.status in ('declining', 'fatigue_risk')),
    (select coalesce(sum(v.gmv), 0) from v where v.status in ('declining', 'fatigue_risk')),
    (select count(*)                from v where v.status = 'fatigue_risk'),
    (select coalesce(sum(v.gmv), 0) from v where v.status = 'fatigue_risk'),
    (select count(*)                from v where v.status = 'rising'),
    (select coalesce(sum(v.gmv), 0) from v where v.status = 'rising'),
    (select count(*)                from v where v.status = 'winner'),
    (select count(*)                from v where v.status = 'candidate'),
    (p_end - p_start) >= 13,
    (select count(*) filter (where v.has_baseline)::numeric / nullif(count(*), 0) from v),
    (select coalesce(sum(v.gmv), 0) from v
      where v.posted_date is not null and (p_end - (v.posted_date at time zone 'UTC')::date) <= 30),
    (select coalesce(sum(v.gmv), 0) from v where v.posted_date is not null) / nullif(tot.gmv, 0),
    (select count(*) from v where v.status = 'new'),
    tot.creators,
    -- Says out loud whether these counts describe the whole population. If a
    -- shop ever outgrows even the aggregate bound, the screen must not keep
    -- presenting a subset as the total.
    (select count(*) from v) >= tot.video_count
  from tot;
end;
$fn$;


do $g$
declare f text;
begin
  foreach f in array array[
    'public.shop_top_videos(uuid,date,date,int,int,text,text,text,text,text[])',
    'public.shop_creative_health(uuid,date,date)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$g$;


-- ── verification: the count and the id set must agree ───────────────────────
do $verify$
declare
  s record; h record; n_declining int; n_ids int; t0 timestamptz; ms numeric;
begin
  for s in select id, shop_name from public.shops loop
    t0 := clock_timestamp();
    select * into h from public.shop_creative_health(s.id, current_date - 31, current_date - 2);
    ms := extract(milliseconds from clock_timestamp() - t0);

    if h.video_count is null or h.video_count = 0 then
      raise notice '017: % has no video revenue in the probe window', s.shop_name;
      continue;
    end if;

    if ms > 5000 then
      raise exception '017: shop_creative_health took %ms for % — too slow to ship', round(ms), s.shop_name;
    end if;

    -- The aggregate must cover the whole population, not the top N.
    if not h.population_complete then
      raise exception '017: % — creative health still describes a subset of % videos',
        s.shop_name, h.video_count;
    end if;

    -- THE ASSERTION THIS MIGRATION EXISTS FOR.
    n_declining := h.declining_videos;
    select count(*) into n_ids from (
      select video_id from public.shop_top_videos(s.id, current_date - 31, current_date - 2, 20000, 0, null, 'declining')
      union all
      select video_id from public.shop_top_videos(s.id, current_date - 31, current_date - 2, 20000, 0, null, 'fatigue_risk')
    ) x;

    if n_declining <> n_ids then
      raise exception '017: % — health counts % declining videos but the id set has %',
        s.shop_name, n_declining, n_ids;
    end if;

    raise notice '017: % — % videos, % declining, id set matches, %ms',
      s.shop_name, h.video_count, n_declining, round(ms);
  end loop;

  raise notice '017: applied';
end;
$verify$;
