-- ============================================================
-- GMV Max Intelligence — 005: creative health (spec layer 3).
--
-- ── THE QUESTION ───────────────────────────────────────────────────────────
-- "Are you one video away from collapse?" A shop whose revenue is carried by
-- two ageing videos is fragile in a way no revenue chart shows, and the answer
-- changes what a media buyer should do next far more than the revenue total.
--
-- ── WHY THE MEASURES COME FROM OUR OWN ORDER LINES ─────────────────────────
-- Reacher's /videos/performance gives GMV per video, but it cannot say which
-- part of it the ads drove — it has no commission split. Our affiliate order
-- lines carry content_id, so grouping them by video gives GMV *already split
-- into paid and organic*, which is strictly more information.
--
-- Verified 2026-09-07: content_id on our order lines IS video_id on the video
-- feed — 53 of the feed's top 100 videos matched order lines from a partial
-- sample, and the rest are seller videos, which have no affiliate lines by
-- definition. So the feed is used only to ENRICH: views, engagement, title,
-- posted_date. Money always comes from the order lines.
--
-- ── PAGE SIZE ──────────────────────────────────────────────────────────────
-- /videos/performance caps page_size at 100 (a 200 returns HTTP 422), and a
-- 30-day window lists 33,257 videos for one shop — nearly all with no sales.
-- The sync pulls the top pages by GMV, so this table is a head, not a census.
-- gmv_rank records where a row sat, so the UI never implies completeness.
-- ============================================================

create table if not exists public.video_performance (
  shop_id        uuid not null references public.shops(id) on delete cascade,
  video_id       text not null,
  window_start   date not null,
  window_end     date not null,

  title          text,
  creator_handle text,
  tiktok_url     text,
  video_gmv      numeric(14,2),
  views          bigint,
  like_count     integer,
  comment_count  integer,
  order_count    integer,
  posted_date    timestamptz,
  gmv_rank       integer,

  raw            jsonb,
  synced_at      timestamptz not null default now(),

  primary key (shop_id, video_id, window_start, window_end)
);

create index if not exists vp_shop_window_idx on public.video_performance (shop_id, window_end desc, gmv_rank);

-- The most recent snapshot for each video. Enrichment fields (title, views,
-- posted_date) are properties of the video, not of the window, so the latest
-- observation is the right one to join against.
create or replace view public.video_latest as
select distinct on (shop_id, video_id)
  shop_id, video_id, title, creator_handle, tiktok_url, views,
  like_count, comment_count, posted_date, window_end
from public.video_performance
order by shop_id, video_id, window_end desc;

-- ============================================================
-- Per-video revenue, split by what drove it, with a momentum read.
--
-- The trend compares the last 7 days of the window with the 7 before it. Below
-- a 14-day window there is no "before", so trend_pct is NULL rather than a
-- number computed from a partial period — a fabricated -100% on a video that
-- simply had no prior window to be measured against would read as collapse.
-- ============================================================
create or replace function public.shop_top_videos(
  p_shop_id uuid, p_start date, p_end date, p_limit int default 25
)
returns table (
  video_id       text,
  creator_handle text,
  title          text,
  tiktok_url     text,
  posted_date    timestamptz,
  age_days       integer,
  lines          bigint,
  orders         bigint,
  gmv            numeric,
  paid_gmv       numeric,
  organic_gmv    numeric,
  paid_share     numeric,
  gmv_share      numeric,
  recent_gmv     numeric,
  prior_gmv      numeric,
  trend_pct      numeric,
  views          bigint
)
language sql
stable
as $$
  with lines as (
    select
      l.content_id as video_id,
      max(l.creator_handle)                                                             as creator_handle,
      count(*)                                                                          as lines,
      count(distinct l.order_id)                                                        as orders,
      coalesce(sum(l.payment_amount), 0)                                                as gmv,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0)    as paid_gmv,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD'), 0) as organic_gmv,
      coalesce(sum(l.payment_amount) filter (
        where (l.order_created_at at time zone 'UTC')::date > p_end - 7), 0)             as recent_gmv,
      coalesce(sum(l.payment_amount) filter (
        where (l.order_created_at at time zone 'UTC')::date <= p_end - 7
          and (l.order_created_at at time zone 'UTC')::date > p_end - 14), 0)           as prior_gmv
    from public.affiliate_order_lines l
    where l.shop_id = p_shop_id
      and l.counts_toward_gmv
      and l.content_id is not null
      and l.content_type = 'Video'
      and (l.order_created_at at time zone 'UTC')::date between p_start and p_end
    group by l.content_id
  ),
  tot as (select nullif(sum(gmv), 0) as gmv from lines)
  select
    x.video_id,
    coalesce(v.creator_handle, x.creator_handle),
    v.title,
    v.tiktok_url,
    v.posted_date,
    case when v.posted_date is null then null
         else (p_end - (v.posted_date at time zone 'UTC')::date)::int end,
    x.lines,
    x.orders,
    x.gmv,
    x.paid_gmv,
    x.organic_gmv,
    x.paid_gmv / nullif(x.paid_gmv + x.organic_gmv, 0),
    x.gmv / tot.gmv,
    x.recent_gmv,
    x.prior_gmv,
    case
      when (p_end - p_start) < 14 then null          -- no comparable prior week
      when x.prior_gmv = 0 then null                 -- no baseline; not "infinite growth"
      else (x.recent_gmv - x.prior_gmv) / x.prior_gmv
    end,
    v.views
  from lines x
  cross join tot
  left join public.video_latest v
    on v.shop_id = p_shop_id and v.video_id = x.video_id
  order by x.gmv desc
  limit greatest(1, least(coalesce(p_limit, 25), 200));
$$;

-- ============================================================
-- The shop-level creative read: concentration, momentum, freshness.
--
-- Concentration is the load-bearing one. "Your top 5 videos are 41% of
-- affiliate revenue" is a fragility statement a revenue chart cannot make.
--
-- freshness_coverage is returned alongside fresh_gmv because posted_date comes
-- from the video feed, which is a head not a census: if only 60% of revenue has
-- a known posting date, the freshness figure describes that 60%, and the UI has
-- to be able to say so.
-- ============================================================
create or replace function public.shop_creative_health(p_shop_id uuid, p_start date, p_end date)
returns table (
  video_count        bigint,
  gmv                numeric,
  top1_share         numeric,
  top5_share         numeric,
  top10_share        numeric,
  fatigued_videos    bigint,
  fatigued_gmv       numeric,
  rising_videos      bigint,
  rising_gmv         numeric,
  trend_measurable   boolean,
  fresh_gmv          numeric,
  freshness_coverage numeric,
  new_videos         bigint,
  creators           bigint
)
language sql
stable
as $$
  with v as (
    select * from public.shop_top_videos(p_shop_id, p_start, p_end, 200)
  ),
  tot as (
    -- The denominator is EVERY video, not the 200 returned above, so the shares
    -- below cannot be inflated by a truncated list.
    select
      count(distinct l.content_id)                       as video_count,
      count(distinct l.creator_handle)                   as creators,
      coalesce(sum(l.payment_amount), 0)                 as gmv
    from public.affiliate_order_lines l
    where l.shop_id = p_shop_id
      and l.counts_toward_gmv
      and l.content_id is not null
      and l.content_type = 'Video'
      and (l.order_created_at at time zone 'UTC')::date between p_start and p_end
  ),
  ranked as (select v.*, row_number() over (order by v.gmv desc) as rn from v),
  first_sale as (
    select l.content_id, min((l.order_created_at at time zone 'UTC')::date) as first_day
    from public.affiliate_order_lines l
    where l.shop_id = p_shop_id and l.counts_toward_gmv
      and l.content_id is not null and l.content_type = 'Video'
      and (l.order_created_at at time zone 'UTC')::date between p_start and p_end
    group by 1
  )
  select
    tot.video_count,
    tot.gmv,
    coalesce((select sum(gmv) from ranked where rn <= 1), 0)  / nullif(tot.gmv, 0),
    coalesce((select sum(gmv) from ranked where rn <= 5), 0)  / nullif(tot.gmv, 0),
    coalesce((select sum(gmv) from ranked where rn <= 10), 0) / nullif(tot.gmv, 0),
    (select count(*)          from v where trend_pct is not null and trend_pct <= -0.30),
    (select coalesce(sum(gmv), 0) from v where trend_pct is not null and trend_pct <= -0.30),
    (select count(*)          from v where trend_pct is not null and trend_pct >=  0.30),
    (select coalesce(sum(gmv), 0) from v where trend_pct is not null and trend_pct >=  0.30),
    (p_end - p_start) >= 14,
    (select coalesce(sum(gmv), 0) from v
      where posted_date is not null and (p_end - (posted_date at time zone 'UTC')::date) <= 30),
    (select coalesce(sum(gmv), 0) from v where posted_date is not null) / nullif(tot.gmv, 0),
    (select count(*) from first_sale where first_day > p_end - 7),
    tot.creators
  from tot;
$$;

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.video_performance enable row level security;

drop policy if exists vp_select on public.video_performance;
create policy vp_select on public.video_performance for select
  using (public.can_view_shop(shop_id, auth.uid()));

-- The view runs as its definer, so it needs its own guard: without RLS on the
-- view, joining through it would leak videos from shops the caller cannot see.
alter view public.video_latest set (security_invoker = on);

do $grants$
declare fn text;
begin
  foreach fn in array array[
    'public.shop_top_videos(uuid, date, date, int)',
    'public.shop_creative_health(uuid, date, date)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
  revoke all on public.video_latest from anon;
  grant select on public.video_latest to authenticated;
end;
$grants$;

do $verify$
declare v int; fn text;
begin
  foreach fn in array array[
    'public.shop_top_videos(uuid, date, date, int)',
    'public.shop_creative_health(uuid, date, date)'
  ] loop
    if has_function_privilege('anon', fn, 'execute') then
      raise exception '005: anon can call %', fn;
    end if;
  end loop;

  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'video_performance' and cmd <> 'SELECT';
  if v <> 0 then
    raise exception '005: video_performance has % write policies', v;
  end if;

  -- security_invoker on the view is what keeps RLS applying through the join.
  select count(*) into v from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'video_latest'
     and array_to_string(c.reloptions, ',') like '%security_invoker=%on%';
  if v <> 1 then
    raise exception '005: video_latest is not security_invoker — it would bypass RLS';
  end if;

  raise notice '005: creative health ready — concentration, momentum and freshness from classified lines';
end;
$verify$;
