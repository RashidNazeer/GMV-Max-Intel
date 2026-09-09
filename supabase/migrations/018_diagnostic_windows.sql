-- ============================================================
-- GMV Max Intelligence — 018: the report window is not the diagnostic window.
--
-- Four defects, every one reproduced against the live database before this file
-- was written. The numbers below are measurements, not illustrations.
--
-- ── 1. A SEVEN-DAY REPORT DELETED THE CREATIVE HISTORY ──────────────────────
-- Biostime, cutoff 2026-09-07:
--     7-day report  : 35 videos, 0.0% with a baseline, ALL 35 "New",
--                     0 declining, 0 rising, trend_measurable = false
--     14-day report : 52 videos, 65.4% with a baseline, 23 declining
--     video 7602654125913804045 — "New", prior_gmv 0.00 at 7 days
--                                 "Winner", prior_gmv 209.36, trend -23% at 14
--
-- The prior week EXISTS. shop_top_videos simply never looked at it: the scan
-- was bounded by the REPORT window, so with a 7-day report the preceding week
-- fell outside the query, and `measurable := (p_end - p_start) >= 13` then
-- switched the trend off wholesale.
--
-- THE CONSEQUENCE WAS NOT COSMETIC. decide.js's creativeSupply guardrail reads
-- decliningShare. With the history discarded that share is 0, the guardrail
-- PASSES, and the recommendation flips from "Review creative" (23 videos
-- carrying 46% of video revenue) to "Lower Target ROI" — on identical data at
-- an identical cutoff, because a report filter silently destroyed the evidence
-- that would have blocked it.
--
-- Missing data must never produce a passed check. The fix: the 7/14-day
-- diagnostic window is derived from the CUTOFF and is independent of the report
-- length. Report figures stay scoped to the report; trend and creative health
-- come from the diagnostic window; both are labelled.
--
-- ── 2. TWO NUMERATORS UNDER ONE WORD ────────────────────────────────────────
-- Product 1732159797234536709 showed 5.05% in the table and 4.98% in its own
-- funnel. Measured: funnel_orders = 136, orders = 134, clicks = 2,691.
--     136 / 2691 = 5.05%   <- what the rate used
--     134 / 2691 = 4.98%   <- what the funnel displayed
-- One definition now, and the number that feeds the rate is the number shown.
--
-- ── 3. RECONCILIATION DISAGREED WITH ITSELF ─────────────────────────────────
-- Window gap +$4.76; the six daily gaps are +18.10, +30.98, +31.54, +25.60,
-- +1.80, +32.66 = +$140.68. Cause: greatest(x, 0) is NONLINEAR, and it was
-- applied to window aggregates in one place and to each day in the other, so
-- the two could never agree. The window is now an AGGREGATION OF THE DAILY
-- RECORDS — signed window difference is by construction the sum of the daily
-- signed differences.
--
-- Also: every one of those six is positive, so the copy claiming "errors in
-- opposite directions cancel" was simply false. The functions now return
-- enough for the UI to say only what is true (see recon_days_* columns).
--
-- ── 4. sum() FILTER RETURNS NULL, NOT ZERO ──────────────────────────────────
-- A creator with real organic revenue and no ad-driven revenue showed a dash
-- for Organic share instead of 100%. `sum(x) filter (where paid)` is NULL when
-- no row matches, and NULL / anything is NULL. Confirmed on seven creators.
-- ============================================================

-- How far back a fixed diagnostic always reaches, regardless of the report.
create or replace function public.diagnostic_days() returns int
language sql immutable as $$ select 14 $$;

comment on function public.diagnostic_days() is
  'The creative trend compares the last 7 complete days against the 7 before. It is anchored to the reporting CUTOFF and never shortened by the report length.';


-- ── shop_top_videos ─────────────────────────────────────────────────────────
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
  has_baseline boolean, status text, views bigint,
  in_report boolean, first_sale_day date, total_count bigint
)
language plpgsql stable as $fn$
declare
  w record;
  diag_lo timestamptz;   -- start of the 14-day diagnostic window
  r7      timestamptz;   -- start of the latest 7 complete days
  scan_lo timestamptz;   -- the union: report window OR diagnostic window
begin
  select * into w from public.shop_window(p_shop_id, p_start, p_end);

  -- The diagnostic window hangs off the CUTOFF, not off p_start. This is the
  -- whole fix: a shorter report may no longer shorten the comparison.
  diag_lo := ((p_end - (public.diagnostic_days() - 1))::timestamp at time zone w.tz);
  r7      := ((p_end - 6)::timestamp at time zone w.tz);
  scan_lo := least(w.lo, diag_lo);

  return query
  with lines as (
    select
      l.content_id as vid,
      max(l.creator_handle) as creator_handle,

      -- REPORT-SCOPED: what the selected window actually contains.
      count(*) filter (where l.order_created_at >= w.lo)                            as lines,
      count(distinct l.order_id) filter (where l.order_created_at >= w.lo)          as orders,
      coalesce(sum(l.payment_amount) filter (where l.order_created_at >= w.lo), 0)  as gmv,
      coalesce(sum(l.payment_amount) filter (
        where l.order_created_at >= w.lo and l.classification = 'PAID_SHOP_ADS'), 0)    as paid_gmv,
      coalesce(sum(l.payment_amount) filter (
        where l.order_created_at >= w.lo and l.classification = 'ORGANIC_STANDARD'), 0) as organic_gmv,
      count(*) filter (where l.order_created_at >= w.lo) > 0                        as in_report,

      -- DIAGNOSTIC-SCOPED: always the same two weeks, whatever the report says.
      coalesce(sum(l.payment_amount) filter (where l.order_created_at >= r7), 0)    as recent_gmv,
      coalesce(sum(l.payment_amount) filter (
        where l.order_created_at >= diag_lo and l.order_created_at < r7), 0)        as prior_gmv,

      min(public.shop_day(l.order_created_at, w.tz)) as first_seen_day
    from public.affiliate_order_lines l
    where l.shop_id = p_shop_id
      and l.counts_toward_gmv
      and l.content_id is not null
      and l.content_type = 'Video'
      and l.order_created_at >= scan_lo
      and l.order_created_at <  w.hi
    group by l.content_id
  ),
  -- gmv_share is a share of the REPORT population, so its denominator is too.
  tot as (select nullif(sum(x.gmv), 0) as gmv from lines x where x.in_report),
  first_ever as (
    -- The genuinely-first sale, over ALL history — never inferred from the
    -- first row inside a filtered report, which is how everything became "New".
    select l.content_id as vid, min(public.shop_day(l.order_created_at, w.tz)) as first_day
    from public.affiliate_order_lines l
    where l.shop_id = p_shop_id and l.counts_toward_gmv
      and l.content_id is not null and l.content_type = 'Video'
      and l.order_created_at < w.hi
    group by l.content_id
  ),
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
      -- A BASELINE IS PRIOR-WEEK REVENUE, nothing else.
      --
      -- Defining it from the first-sale date instead made every video that sold
      -- once weeks ago and nothing since a "100% decline": prior_gmv = 0 AND
      -- recent_gmv = 0 is no activity in EITHER diagnostic week, not a
      -- collapse. It also made the count depend on the report length again —
      -- 26 declining at 7 and 14 days but 58 at 30 — because a longer report
      -- pulls more dormant videos into the scan. Measured, then fixed.
      --
      -- A prior week that earned and a current week that did not IS a real
      -- decline, and stays one: prior > 0, recent = 0, trend = -100%.
      case when x.prior_gmv > 0 then (x.recent_gmv - x.prior_gmv) / x.prior_gmv
           else null end as trend_pct,
      (x.prior_gmv > 0) as has_baseline,
      x.in_report, fe.first_day as first_sale_day, v.views
    from lines x cross join tot
    left join public.video_latest v on v.shop_id = p_shop_id and v.video_id = x.vid
    left join first_ever fe on fe.vid = x.vid
  ),
  classified as (
    select e.*,
      case
        -- New means genuinely new: its first sale EVER is inside the last week,
        -- established from full history rather than from the first row of a
        -- filtered report — which is what made all 35 videos "New" at 7 days.
        when e.first_sale_day is not null and e.first_sale_day > p_end - 7 then 'new'
        -- No prior-week revenue to compare against, and not new either. This is
        -- unavailable, and is deliberately NOT the same as a 100% decline.
        when not e.has_baseline then 'no_baseline'
        when e.trend_pct <= -0.30 and e.prior_gmv >= 100 then 'fatigue_risk'
        when e.trend_pct <= -0.30 then 'declining'
        when e.trend_pct >=  0.30 then 'rising'
        when e.orders >= 3 then 'winner'
        else 'candidate'
      end as status
    from enriched e
  ),
  filtered as (
    select c.* from classified c
    where (p_ids is null or c.vid = any(p_ids))
      and (p_status is null or p_status = '' or c.status = p_status)
      -- Without an explicit id set or status filter, the table shows the
      -- REPORT population. A prior-week earner that sold nothing in the report
      -- is still reachable through a finding, and carries in_report = false.
      and (p_ids is not null or (p_status is not null and p_status <> '') or c.in_report)
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
    s.status, s.views, s.in_report, s.first_sale_day, s.total_count
  from sorted s
  order by
    case when lower(coalesce(p_dir, 'desc')) = 'asc'  then s.sort_key end asc  nulls last,
    case when lower(coalesce(p_dir, 'desc')) <> 'asc' then s.sort_key end desc nulls last,
    s.vid
  offset greatest(0, coalesce(p_offset, 0))
  limit  greatest(1, least(coalesce(p_limit, 50), 20000));
end;
$fn$;


-- ── shop_creative_health ────────────────────────────────────────────────────
drop function if exists public.shop_creative_health(uuid, date, date);

create or replace function public.shop_creative_health(p_shop_id uuid, p_start date, p_end date)
returns table (
  video_count bigint, gmv numeric, top1_share numeric, top5_share numeric, top10_share numeric,
  declining_videos bigint, declining_gmv numeric,
  fatigue_videos bigint, fatigue_gmv numeric,
  rising_videos bigint, rising_gmv numeric,
  winners bigint, candidates bigint,
  no_baseline_videos bigint, new_videos bigint,
  trend_measurable boolean, baseline_coverage numeric,
  diagnostic_start date, diagnostic_end date, prior_start date, prior_end date,
  declining_outside_report bigint,
  fresh_gmv numeric, freshness_coverage numeric,
  creators bigint, population_complete boolean
)
language plpgsql stable as $fn$
declare w record;
begin
  select * into w from public.shop_window(p_shop_id, p_start, p_end);
  return query
  -- p_status = '' keeps the report population; the declining counts below need
  -- prior-week earners too, so they are fetched by status separately.
  with v as (select * from public.shop_top_videos(p_shop_id, p_start, p_end, 20000)),
  decl as (
    select * from public.shop_top_videos(p_shop_id, p_start, p_end, 20000, 0, null, 'declining')
    union all
    select * from public.shop_top_videos(p_shop_id, p_start, p_end, 20000, 0, null, 'fatigue_risk')
  ),
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
    (select count(*)                from decl),
    (select coalesce(sum(decl.gmv), 0) from decl),
    (select count(*)                from decl where decl.status = 'fatigue_risk'),
    (select coalesce(sum(decl.gmv), 0) from decl where decl.status = 'fatigue_risk'),
    (select count(*)                from v where v.status = 'rising'),
    (select coalesce(sum(v.gmv), 0) from v where v.status = 'rising'),
    (select count(*)                from v where v.status = 'winner'),
    (select count(*)                from v where v.status = 'candidate'),
    (select count(*)                from v where v.status = 'no_baseline'),
    (select count(*)                from v where v.status = 'new'),
    -- ALWAYS measurable now: the diagnostic window is anchored to the cutoff.
    true,
    (select count(*) filter (where v.has_baseline)::numeric / nullif(count(*), 0) from v),
    (p_end - (public.diagnostic_days() - 1)), p_end, (p_end - (public.diagnostic_days() - 1)), (p_end - 7),
    -- Declining videos that sold nothing inside the report: real, and invisible
    -- in the default table, so the finding says how many it is reaching past.
    (select count(*) from decl where not decl.in_report),
    (select coalesce(sum(v.gmv), 0) from v
      where v.posted_date is not null and (p_end - (v.posted_date at time zone 'UTC')::date) <= 30),
    (select coalesce(sum(v.gmv), 0) from v where v.posted_date is not null) / nullif(tot.gmv, 0),
    tot.creators,
    (select count(*) from v) >= tot.video_count
  from tot;
end;
$fn$;


-- ── shop_top_creators: a share of zero is zero, not unknown ─────────────────
drop function if exists public.shop_top_creators(uuid, date, date, int);

create or replace function public.shop_top_creators(p_shop_id uuid, p_start date, p_end date, p_limit int default 25)
returns table (creator_handle text, lines bigint, gmv numeric, paid_gmv numeric,
               organic_gmv numeric, paid_share numeric, organic_share numeric)
language plpgsql stable as $fn$
declare w record;
begin
  select * into w from public.shop_window(p_shop_id, p_start, p_end);
  return query
  with c as (
    select
      l.creator_handle as handle,
      count(*) as lines,
      coalesce(sum(l.payment_amount), 0) as gmv,
      -- coalesce() is the fix. `sum() filter` yields NULL when nothing matches,
      -- and NULL/x is NULL — which is why a creator with real organic revenue
      -- and no ad-driven revenue rendered a dash instead of 100%.
      coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0)    as paid,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD'), 0) as organic
    from public.affiliate_order_lines l
    where l.shop_id = p_shop_id
      and l.counts_toward_gmv
      and l.order_created_at >= w.lo and l.order_created_at < w.hi
    group by 1
  )
  select c.handle, c.lines, c.gmv, c.paid, c.organic,
         c.paid    / nullif(c.paid + c.organic, 0),
         c.organic / nullif(c.paid + c.organic, 0)
  from c
  order by c.gmv desc
  limit greatest(1, least(coalesce(p_limit, 25), 200));
end;
$fn$;


-- ── ONE conversion definition ───────────────────────────────────────────────
-- The acceptance test is explicit: 134 orders over 2,691 clicks must read
-- 4.98% wherever conversion appears. So `orders` is the numerator, and the
-- provider's own funnel count is exposed separately rather than quietly
-- swapped in behind the same word.
drop function if exists public.shop_products(uuid, date, date, int, int, text, text, text, text[]);

create or replace function public.shop_products(
  p_shop_id uuid, p_start date, p_end date,
  p_limit int default 50, p_offset int default 0,
  p_search text default null, p_sort text default 'gmv',
  p_dir text default 'desc', p_ids text[] default null
)
returns table (
  product_id text, title text, image_url text, gmv numeric, orders integer, items_sold integer,
  aov numeric, refunds numeric, refund_rate numeric, impressions bigint, clicks bigint,
  ctr numeric, add_to_cart_rate numeric, click_to_order_rate numeric,
  provider_funnel_orders bigint, provider_conversion numeric,
  affiliate_gmv numeric, product_card_gmv numeric, shop_tab_gmv numeric, seller_video_gmv numeric,
  measured_paid_gmv numeric, measured_organic_gmv numeric, paid_share numeric,
  min_price numeric, max_price numeric, inventory bigint, commission_rate numeric,
  discount_pct numeric, days_with_data integer, has_sales boolean, total_count bigint
)
language plpgsql stable as $fn$
declare w record;
begin
  select * into w from public.shop_window(p_shop_id, p_start, p_end);
  return query
  with agg as (
    select
      d.product_id                 as pid,
      max(d.product_name)          as product_name,
      max(d.cover_image_url)       as cover_image_url,
      count(distinct d.day)::int   as days_with_data,
      sum(d.gmv)                   as gmv,
      sum(d.orders)::int           as orders,
      sum(d.items_sold)::int       as items_sold,
      sum(d.refunds)               as refunds,
      sum(d.impressions)::bigint   as impressions,
      sum(d.clicks)::bigint        as clicks,
      sum(d.add_to_cart)::bigint   as add_to_cart,
      sum(d.funnel_orders)::bigint as funnel_orders,
      sum(d.affiliate_gmv)         as affiliate_gmv,
      sum(d.product_card_gmv)      as product_card_gmv,
      sum(d.shop_tab_gmv)          as shop_tab_gmv,
      sum(d.seller_video_gmv)      as seller_video_gmv
    from public.product_daily_metrics d
    where d.shop_id = p_shop_id and d.day between p_start and p_end
    group by d.product_id
  ),
  mine as (
    select
      l.product_id as pid,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0)    as paid,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD'), 0) as organic
    from public.affiliate_order_lines l
    where l.shop_id = p_shop_id and l.counts_toward_gmv and l.product_id is not null
      and l.order_created_at >= w.lo and l.order_created_at < w.hi
    group by 1
  ),
  joined as (
    select
      coalesce(a.pid, m.pid)                   as product_id,
      coalesce(c.title, a.product_name)        as title,
      coalesce(c.image_url, a.cover_image_url) as image_url,
      a.gmv, a.orders, a.items_sold,
      a.gmv / nullif(a.orders, 0)              as aov,
      a.refunds,
      a.refunds / nullif(a.gmv, 0)             as refund_rate,
      a.impressions, a.clicks,
      a.clicks::numeric      / nullif(a.impressions, 0) as ctr,
      a.add_to_cart::numeric / nullif(a.clicks, 0)      as add_to_cart_rate,
      -- THE canonical conversion: the same orders the funnel view displays.
      a.orders::numeric      / nullif(a.clicks, 0)      as click_to_order_rate,
      a.funnel_orders,
      a.funnel_orders::numeric / nullif(a.clicks, 0)    as provider_conversion,
      a.affiliate_gmv, a.product_card_gmv, a.shop_tab_gmv, a.seller_video_gmv,
      coalesce(m.paid, 0) as paid, coalesce(m.organic, 0) as organic,
      m.paid / nullif(m.paid + m.organic, 0) as paid_share,
      c.min_price, c.max_price, c.inventory, c.commission_rate, c.discount_pct,
      a.days_with_data,
      (coalesce(a.orders, 0) > 0 and coalesce(a.gmv, 0) > 0) as has_sales
    from agg a
    full join mine m on m.pid = a.pid
    left join public.product_catalog c
      on c.shop_id = p_shop_id and c.product_id = coalesce(a.pid, m.pid)
  ),
  filtered as (
    select j.* from joined j
    where (p_ids is null or j.product_id = any(p_ids))
      and (p_search is null or p_search = '' or
           j.product_id ilike '%' || p_search || '%' or
           coalesce(j.title, '') ilike '%' || p_search || '%')
  ),
  sorted as (
    select f.*, count(*) over () as total_count,
      case lower(coalesce(p_sort, 'gmv'))
        when 'orders'      then f.orders::numeric
        when 'conversion'  then f.click_to_order_rate
        when 'ctr'         then f.ctr
        when 'refund_rate' then f.refund_rate
        when 'clicks'      then f.clicks::numeric
        else coalesce(f.gmv, 0)
      end as sort_key
    from filtered f
  )
  select
    s.product_id, s.title, s.image_url, s.gmv, s.orders, s.items_sold, s.aov,
    s.refunds, s.refund_rate, s.impressions, s.clicks, s.ctr, s.add_to_cart_rate,
    s.click_to_order_rate, s.funnel_orders, s.provider_conversion,
    s.affiliate_gmv, s.product_card_gmv, s.shop_tab_gmv,
    s.seller_video_gmv, s.paid, s.organic, s.paid_share, s.min_price, s.max_price,
    s.inventory, s.commission_rate, s.discount_pct, s.days_with_data, s.has_sales,
    s.total_count
  from sorted s
  order by
    case when lower(coalesce(p_dir, 'desc')) = 'asc'  then s.sort_key end asc  nulls last,
    case when lower(coalesce(p_dir, 'desc')) <> 'asc' then s.sort_key end desc nulls last,
    s.product_id
  offset greatest(0, coalesce(p_offset, 0))
  limit  greatest(1, least(coalesce(p_limit, 50), 500));
end;
$fn$;


drop function if exists public.shop_product_stats(uuid, date, date);

create or replace function public.shop_product_stats(p_shop_id uuid, p_start date, p_end date)
returns table (
  catalog_products bigint, products_with_traffic bigint, products_with_sales bigint,
  products_with_funnel bigint, products_affiliate_only bigint,
  gmv numeric, orders bigint, refunds numeric, refund_rate numeric,
  impressions bigint, clicks bigint, ctr numeric,
  median_conversion numeric, median_n bigint, median_min_clicks bigint,
  discount_available boolean
)
language plpgsql stable as $fn$
declare w record;
begin
  select * into w from public.shop_window(p_shop_id, p_start, p_end);
  return query
  with d as (
    select dm.product_id, sum(dm.gmv) as gmv, sum(dm.orders) as orders,
           sum(dm.refunds) as refunds, sum(dm.impressions) as impressions,
           sum(dm.clicks) as clicks
    from public.product_daily_metrics dm
    where dm.shop_id = p_shop_id and dm.day between p_start and p_end
    group by dm.product_id
  ),
  elig as (
    -- Same numerator as the table. One definition, one benchmark.
    select d.orders::numeric / nullif(d.clicks, 0) as rate
    from d where d.clicks >= public.product_benchmark_min_clicks() and d.orders is not null
  ),
  aff as (
    select count(distinct l.product_id) as n
    from public.affiliate_order_lines l
    where l.shop_id = p_shop_id and l.counts_toward_gmv and l.product_id is not null
      and l.order_created_at >= w.lo and l.order_created_at < w.hi
      and not exists (select 1 from d where d.product_id = l.product_id)
  )
  select
    (select count(*) from public.product_catalog c where c.shop_id = p_shop_id),
    (select count(*) from d where d.impressions > 0),
    (select count(*) from d where d.orders > 0 and d.gmv > 0),
    (select count(*) from d),
    (select aff.n from aff),
    (select coalesce(sum(d.gmv), 0) from d),
    (select coalesce(sum(d.orders), 0)::bigint from d),
    (select coalesce(sum(d.refunds), 0) from d),
    (select sum(d.refunds) / nullif(sum(d.gmv), 0) from d),
    (select coalesce(sum(d.impressions), 0)::bigint from d),
    (select coalesce(sum(d.clicks), 0)::bigint from d),
    (select sum(d.clicks)::numeric / nullif(sum(d.impressions), 0) from d),
    (select percentile_cont(0.5) within group (order by elig.rate)::numeric from elig),
    (select count(*) from elig),
    public.product_benchmark_min_clicks(),
    (select coalesce(bool_or(c.discount_pct is not null), false)
       from public.product_catalog c where c.shop_id = p_shop_id);
end;
$fn$;


-- ── the window is an AGGREGATION of the daily records ───────────────────────
drop function if exists public.shop_attribution(uuid, date, date);

create or replace function public.shop_attribution(p_shop_id uuid, p_start date, p_end date)
returns table (
  days_covered integer, total_gmv numeric,
  measured_paid_gmv numeric, measured_organic_gmv numeric,
  affiliate_unmeasured_gmv numeric, affiliate_overflow_gmv numeric,
  seller_video_gmv numeric, live_gmv numeric, product_card_gmv numeric,
  affiliate_video_sc_gmv numeric, affiliate_video_ours_gmv numeric,
  affiliate_delta numeric, affiliate_capture numeric,
  component_total numeric, reconciliation_gap numeric, reconciliation_pct numeric,
  reconciliation_status text,
  recon_days integer, recon_days_exception integer,
  recon_days_positive integer, recon_days_negative integer,
  recon_abs_gap numeric,
  attribution_coverage numeric, paid_share_of_measured numeric,
  other_affiliate_gmv numeric, other_affiliate_paid_gmv numeric,
  orders bigint, customers bigint
)
language plpgsql stable as $fn$
declare w record;
begin
  select * into w from public.shop_window(p_shop_id, p_start, p_end);

  return query
  -- EVERY bucket is summed from the canonical daily records. greatest(x,0) is
  -- nonlinear, so applying it to window totals in one place and to each day in
  -- another guaranteed the two could never agree — window +$4.76 against daily
  -- sum +$140.68. The daily record is the source of truth; the window is its
  -- sum, and the signed gap is therefore equal by construction.
  with d as (select * from public.shop_channel_daily(p_shop_id, p_start, p_end)),
  oth as (
    select
      coalesce(sum(l.payment_amount), 0)                                                 as total,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0) as paid
    from public.affiliate_order_lines l
    where l.shop_id = p_shop_id and l.counts_toward_gmv
      and l.content_type is distinct from 'Video'
      and l.order_created_at >= w.lo and l.order_created_at < w.hi
      and public.shop_day(l.order_created_at, w.tz) in (select d.day from d)
  ),
  s as (
    select
      count(*)::int                                       as days_covered,
      coalesce(sum(d.total_gmv), 0)                       as total_gmv,
      coalesce(sum(d.measured_paid_gmv), 0)               as paid,
      coalesce(sum(d.measured_organic_gmv), 0)            as organic,
      coalesce(sum(d.affiliate_unmeasured_gmv), 0)        as unmeasured,
      coalesce(sum(d.affiliate_overflow_gmv), 0)          as overflow,
      coalesce(sum(d.seller_video_gmv), 0)                as seller_video,
      coalesce(sum(d.live_gmv), 0)                        as live,
      coalesce(sum(d.product_card_gmv), 0)                as pcard,
      coalesce(sum(d.affiliate_sc_gmv), 0)                as aff_sc,
      coalesce(sum(d.affiliate_ours_gmv), 0)              as ours,
      coalesce(sum(d.reconciliation_gap), 0)              as gap,
      coalesce(sum(abs(d.reconciliation_gap)), 0)         as abs_gap,
      count(*) filter (where d.reconciliation_status = 'exception')::int as bad,
      count(*) filter (where d.reconciliation_gap >  0.005)::int         as pos,
      count(*) filter (where d.reconciliation_gap < -0.005)::int         as neg
    from d
  ),
  ch as (
    select coalesce(sum(c.orders), 0)::bigint as orders,
           coalesce(sum(c.customers), 0)::bigint as customers
    from public.shop_daily_channels c
    where c.shop_id = p_shop_id and c.day between p_start and p_end
  )
  select
    s.days_covered, s.total_gmv, s.paid, s.organic, s.unmeasured, s.overflow,
    s.seller_video, s.live, s.pcard, s.aff_sc, s.ours,
    s.ours - s.aff_sc,
    s.ours / nullif(s.aff_sc, 0),
    s.total_gmv + s.gap,                       -- components, by definition
    s.gap,
    s.gap / nullif(s.total_gmv, 0),
    case
      when s.total_gmv = 0 then 'reconciled'
      when abs(s.gap) <= public.recon_rounding_tolerance() then 'reconciled'
      when abs(s.gap) / s.total_gmv <= public.recon_business_tolerance() then 'rounding'
      else 'exception'
    end,
    s.days_covered, s.bad, s.pos, s.neg, s.abs_gap,
    (s.paid + s.organic) / nullif(s.total_gmv, 0),
    s.paid / nullif(s.paid + s.organic, 0),
    oth.total, oth.paid,
    ch.orders, ch.customers
  from s, oth, ch;
end;
$fn$;


do $g$
declare f text;
begin
  foreach f in array array[
    'public.diagnostic_days()',
    'public.shop_top_videos(uuid,date,date,int,int,text,text,text,text,text[])',
    'public.shop_creative_health(uuid,date,date)',
    'public.shop_top_creators(uuid,date,date,int)',
    'public.shop_products(uuid,date,date,int,int,text,text,text,text[])',
    'public.shop_product_stats(uuid,date,date)',
    'public.shop_attribution(uuid,date,date)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$g$;


-- ── verification: the defects must be gone, measured not asserted ───────────
do $verify$
declare
  s record; h7 record; h14 record; h30 record; a record;
  sum_daily numeric; v7 record; v14 record; t0 timestamptz; ms numeric;
begin
  for s in select id, shop_name from public.shops loop
    t0 := clock_timestamp();
    select * into h7  from public.shop_creative_health(s.id, current_date - 8,  current_date - 2);
    select * into h14 from public.shop_creative_health(s.id, current_date - 15, current_date - 2);
    ms := extract(milliseconds from clock_timestamp() - t0);

    if h7.video_count is null or h7.video_count = 0 then
      raise notice '018: % has no video revenue in the probe window', s.shop_name;
      continue;
    end if;

    if ms > 8000 then
      raise exception '018: creative health took %ms for % — too slow', round(ms), s.shop_name;
    end if;

    -- THE DEFECT: a 7-day report must no longer erase the comparison.
    if coalesce(h7.baseline_coverage, 0) = 0 and coalesce(h14.baseline_coverage, 0) > 0 then
      raise exception '018: % still loses its baseline at 7 days (7d=%, 14d=%)',
        s.shop_name, h7.baseline_coverage, h14.baseline_coverage;
    end if;

    -- The diagnostic is anchored to the cutoff, so EVERY report length must see
    -- the same declining set. Checking only 7 against 14 was not enough: a
    -- first-sale-based baseline definition passed that pair and still returned
    -- 58 at 30 days, because a longer report drags dormant videos into the scan
    -- and a zero prior week was being read as a total collapse.
    select * into h30 from public.shop_creative_health(s.id, current_date - 31, current_date - 2);
    if h7.declining_videos <> h14.declining_videos or h14.declining_videos <> h30.declining_videos then
      raise exception '018: % declining differs by report length (7d=%, 14d=%, 30d=%) — the diagnostic is still report-scoped',
        s.shop_name, h7.declining_videos, h14.declining_videos, h30.declining_videos;
    end if;

    raise notice '018: % — 7d baseline %%%, declining %; 14d baseline %%%, declining %; %ms',
      s.shop_name, round(coalesce(h7.baseline_coverage, 0) * 100, 1), h7.declining_videos,
      round(coalesce(h14.baseline_coverage, 0) * 100, 1), h14.declining_videos, round(ms);

    -- The window gap must EQUAL the sum of the daily gaps.
    select * into a from public.shop_attribution(s.id, current_date - 8, current_date - 2);
    select coalesce(sum(x.reconciliation_gap), 0) into sum_daily
      from public.shop_channel_daily(s.id, current_date - 8, current_date - 2) x;
    if abs(a.reconciliation_gap - sum_daily) > 0.01 then
      raise exception '018: % window gap % <> sum of daily gaps %',
        s.shop_name, a.reconciliation_gap, sum_daily;
    end if;
    raise notice '018: % — window gap % equals the daily sum; % positive / % negative days',
      s.shop_name, round(a.reconciliation_gap, 2), a.recon_days_positive, a.recon_days_negative;
  end loop;

  raise notice '018: applied';
end;
$verify$;
