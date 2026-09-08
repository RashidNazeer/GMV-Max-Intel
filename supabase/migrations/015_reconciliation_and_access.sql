-- ============================================================
-- GMV Max Intelligence — 015: stop hiding the reconciliation error, and make
-- the creative/product populations reachable.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
-- Three defects, all found by measuring the running app rather than reading it.
--
-- 1. THE CLAMP. shop_attribution() computed the unmeasured affiliate bucket as
--    greatest(seller_centre_affiliate - ours, 0). The comment said the clamp
--    existed so the stacked bar would not break. It does more than that: when
--    our order lines exceed Seller Center's own affiliate figure, the overflow
--    is silently deleted and the six components then sum to MORE than total
--    shop GMV while the chart still renders as a tidy 100%.
--
--    Measured on Biostime, 2026-08-30 -> 2026-09-06:
--        components 1,074.38 + 877.99 + 693.50 + 483.81 = 3,129.68
--        total shop GMV                                  = 3,056.75
--        difference                                      =    72.93  (102.4%)
--        affiliate capture                               =   103.9%
--    and the only capture alarm in the UI fired below 0.95, so 103.9% read as
--    perfect health.
--
--    Worse, the daily trace shows the overflow on SEVEN OF EIGHT DAYS, roughly
--    proportional (3.4%-7.0%), which is a basis mismatch rather than a
--    day-boundary bug. Over 30 days the positive and negative daily errors
--    cancel to a 0.00 gap — so the window-level check reported perfect
--    reconciliation over data that is wrong on almost every individual day.
--    A check that only ever tests the aggregate cannot see this.
--
--    So: keep the raw amounts, report a SIGNED gap, and give the overflow its
--    own bucket instead of deleting it.
--
-- 2. UNREACHABLE POPULATIONS. The creative table fetched a hardcoded top 50
--    while the headline said 573 videos earned and 61 were fading. The server
--    capped at 200, so the other 373 were unreachable even at maximum. Same
--    shape on products. Search, filter, sort and paging all have to happen
--    server-side or the rows on screen describe a different population from
--    the one the finding counted.
--
-- 3. TWO MEDIANS. The Products page took the median over every row with a rate
--    (n=26 -> 3.70%); the recommendation rules took it over rows with 50,000+
--    impressions (n=8 -> 3.65%). Same label, different bar, nothing on screen
--    explaining the difference. On Biostime the rules' "shop median" came from
--    a single product. There is now exactly ONE definition, in SQL, with its
--    eligibility rule and its n returned alongside it.
--
-- Nothing here changes the paid/organic classification or the attribution
-- interpretation. The buckets, their meanings and their wording are untouched;
-- what changes is that an error between them is shown instead of absorbed.
-- ============================================================

-- ── tolerances ──────────────────────────────────────────────────────────────
-- Two DIFFERENT thresholds, because they answer different questions. Rounding
-- is arithmetic noise from summing numerics; a business discrepancy is a real
-- disagreement between two sources. Collapsing them into one number is how a
-- 2.4% error gets excused as "close enough".
create or replace function public.recon_rounding_tolerance() returns numeric
language sql immutable as $$ select 0.50::numeric $$;      -- absolute, currency units

create or replace function public.recon_business_tolerance() returns numeric
language sql immutable as $$ select 0.005::numeric $$;     -- 0.5% of total shop GMV

comment on function public.recon_rounding_tolerance() is
  'Absolute currency drift attributable to rounding when summing components.';
comment on function public.recon_business_tolerance() is
  'Fractional gap beyond which two sources genuinely disagree and a user-facing exception is raised.';


-- ── shop_attribution: signed reconciliation, nothing clamped away ───────────
drop function if exists public.shop_attribution(uuid, date, date);

create or replace function public.shop_attribution(p_shop_id uuid, p_start date, p_end date)
returns table (
  days_covered              integer,
  total_gmv                 numeric,
  measured_paid_gmv         numeric,
  measured_organic_gmv      numeric,
  affiliate_unmeasured_gmv  numeric,   -- Seller Center reports more than we hold
  affiliate_overflow_gmv    numeric,   -- WE hold more than Seller Center reports (was silently deleted)
  seller_video_gmv          numeric,
  live_gmv                  numeric,
  product_card_gmv          numeric,
  affiliate_video_sc_gmv    numeric,
  affiliate_video_ours_gmv  numeric,
  affiliate_delta           numeric,   -- signed: ours - Seller Center
  affiliate_capture         numeric,   -- unclamped: MAY exceed 1, and that is the alarm
  component_total           numeric,
  reconciliation_gap        numeric,   -- signed: components - total shop GMV
  reconciliation_pct        numeric,
  reconciliation_status     text,      -- reconciled | rounding | exception
  attribution_coverage      numeric,
  paid_share_of_measured    numeric,
  other_affiliate_gmv       numeric,
  other_affiliate_paid_gmv  numeric,
  orders                    bigint,
  customers                 bigint
)
language plpgsql stable as $fn$
declare w record;
begin
  select * into w from public.shop_window(p_shop_id, p_start, p_end);

  return query
  with ch as (
    select * from public.shop_daily_channels
     where shop_id = p_shop_id and day between p_start and p_end
  ),
  lines as (
    select l.*
      from public.affiliate_order_lines l
     where l.shop_id = p_shop_id
       and l.counts_toward_gmv
       and l.order_created_at >= w.lo and l.order_created_at < w.hi
       and public.shop_day(l.order_created_at, w.tz) in (select day from ch)
  ),
  vid as (
    select
      coalesce(sum(payment_amount) filter (where classification = 'PAID_SHOP_ADS'), 0)    as paid,
      coalesce(sum(payment_amount) filter (where classification = 'ORGANIC_STANDARD'), 0) as organic,
      coalesce(sum(payment_amount), 0)                                                    as total
    from lines where content_type = 'Video'
  ),
  oth as (
    select
      coalesce(sum(payment_amount), 0)                                                 as total,
      coalesce(sum(payment_amount) filter (where classification = 'PAID_SHOP_ADS'), 0) as paid
    from lines where content_type is distinct from 'Video'
  ),
  agg as (
    select
      count(*)::int                            as days_covered,
      coalesce(sum(ch.gmv), 0)                 as total_gmv,
      coalesce(sum(ch.video_affiliate_gmv), 0) as aff_sc,
      coalesce(sum(ch.video_seller_gmv), 0)    as seller_video,
      coalesce(sum(ch.live_gmv), 0)            as live,
      coalesce(sum(ch.product_card_gmv), 0)    as pcard,
      coalesce(sum(ch.orders), 0)::bigint      as orders,
      coalesce(sum(ch.customers), 0)::bigint   as customers
    from ch
  ),
  calc as (
    select
      agg.days_covered, agg.total_gmv, agg.aff_sc, agg.seller_video, agg.live,
      agg.pcard, agg.orders, agg.customers,
      vid.paid, vid.organic, vid.total as ours,
      oth.total as oth_total, oth.paid as oth_paid,
      greatest(agg.aff_sc - vid.total, 0) as unmeasured,
      greatest(vid.total - agg.aff_sc, 0) as overflow
    from agg, vid, oth
  ),
  fin as (
    select calc.*,
      (calc.paid + calc.organic + calc.unmeasured + calc.overflow
        + calc.seller_video + calc.live + calc.pcard) as comp_total
    from calc
  )
  select
    fin.days_covered,
    fin.total_gmv,
    fin.paid,
    fin.organic,
    fin.unmeasured,
    fin.overflow,
    fin.seller_video,
    fin.live,
    fin.pcard,
    fin.aff_sc,
    fin.ours,
    fin.ours - fin.aff_sc,
    fin.ours / nullif(fin.aff_sc, 0),
    fin.comp_total,
    fin.comp_total - fin.total_gmv,
    (fin.comp_total - fin.total_gmv) / nullif(fin.total_gmv, 0),
    case
      when fin.total_gmv = 0 then 'reconciled'
      when abs(fin.comp_total - fin.total_gmv) <= public.recon_rounding_tolerance() then 'reconciled'
      when abs(fin.comp_total - fin.total_gmv) / fin.total_gmv <= public.recon_business_tolerance() then 'rounding'
      else 'exception'
    end,
    (fin.paid + fin.organic) / nullif(fin.total_gmv, 0),
    fin.paid / nullif(fin.paid + fin.organic, 0),
    fin.oth_total,
    fin.oth_paid,
    fin.orders,
    fin.customers
  from fin;
end;
$fn$;

comment on function public.shop_attribution(uuid, date, date) is
  'Whole-shop decomposition. affiliate_capture is UNCLAMPED and may exceed 1; reconciliation_gap is signed. Neither is hidden — see migration 015.';


-- ── the daily version, with the same honesty ────────────────────────────────
drop function if exists public.shop_channel_daily(uuid, date, date);

create or replace function public.shop_channel_daily(p_shop_id uuid, p_start date, p_end date)
returns table (
  day                      date,
  total_gmv                numeric,
  measured_paid_gmv        numeric,
  measured_organic_gmv     numeric,
  affiliate_unmeasured_gmv numeric,
  affiliate_overflow_gmv   numeric,
  seller_video_gmv         numeric,
  live_gmv                 numeric,
  product_card_gmv         numeric,
  affiliate_sc_gmv         numeric,
  affiliate_ours_gmv       numeric,
  affiliate_delta          numeric,
  reconciliation_gap       numeric,
  reconciliation_status    text
)
language plpgsql stable as $fn$
declare w record;
begin
  select * into w from public.shop_window(p_shop_id, p_start, p_end);

  return query
  with lines as (
    select
      public.shop_day(l.order_created_at, w.tz) as d,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0)    as paid,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD'), 0) as organic,
      coalesce(sum(l.payment_amount), 0)                                                      as total
    from public.affiliate_order_lines l
    where l.shop_id = p_shop_id
      and l.counts_toward_gmv
      and l.content_type = 'Video'
      and l.order_created_at >= w.lo and l.order_created_at < w.hi
    group by 1
  ),
  j as (
    select
      ch.day,
      coalesce(ch.gmv, 0)                 as total_gmv,
      coalesce(v.paid, 0)                 as paid,
      coalesce(v.organic, 0)              as organic,
      coalesce(ch.video_affiliate_gmv, 0) as aff_sc,
      coalesce(v.total, 0)                as ours,
      greatest(coalesce(ch.video_affiliate_gmv, 0) - coalesce(v.total, 0), 0) as unmeasured,
      greatest(coalesce(v.total, 0) - coalesce(ch.video_affiliate_gmv, 0), 0) as overflow,
      coalesce(ch.video_seller_gmv, 0)    as seller_video,
      coalesce(ch.live_gmv, 0)            as live,
      coalesce(ch.product_card_gmv, 0)    as pcard
    from public.shop_daily_channels ch
    left join lines v on v.d = ch.day
    where ch.shop_id = p_shop_id and ch.day between p_start and p_end
  ),
  g as (
    select j.*,
      (j.paid + j.organic + j.unmeasured + j.overflow + j.seller_video + j.live + j.pcard)
        - j.total_gmv as gap
    from j
  )
  select
    g.day, g.total_gmv, g.paid, g.organic, g.unmeasured, g.overflow,
    g.seller_video, g.live, g.pcard,
    g.aff_sc, g.ours, g.ours - g.aff_sc,
    g.gap,
    case
      when g.total_gmv = 0 then 'reconciled'
      when abs(g.gap) <= public.recon_rounding_tolerance() then 'reconciled'
      when abs(g.gap) / g.total_gmv <= public.recon_business_tolerance() then 'rounding'
      else 'exception'
    end
  from g
  order by g.day;
end;
$fn$;


-- ── per-day reconciliation, so a check can fail on the days that are wrong ──
-- The 30-day window reconciles to 0.00 while seven of eight days are wrong in
-- opposite directions. This is the function a regression test points at.
create or replace function public.shop_reconciliation(p_shop_id uuid, p_start date, p_end date)
returns table (
  days              integer,
  days_reconciled   integer,
  days_exception    integer,
  worst_day         date,
  worst_gap         numeric,
  worst_pct         numeric,
  abs_gap_total     numeric,
  net_gap_total     numeric,
  status            text
)
language sql stable as $$
  with d as (select * from public.shop_channel_daily(p_shop_id, p_start, p_end)),
  s as (
    select
      count(*)::int                                                       as days,
      count(*) filter (where d.reconciliation_status = 'reconciled')::int as ok,
      count(*) filter (where d.reconciliation_status = 'exception')::int   as bad,
      coalesce(sum(abs(d.reconciliation_gap)), 0)                          as abs_gap,
      coalesce(sum(d.reconciliation_gap), 0)                               as net_gap
    from d
  ),
  w as (
    select d.day, d.reconciliation_gap as gap,
           d.reconciliation_gap / nullif(d.total_gmv, 0) as pct
    from d order by abs(d.reconciliation_gap) desc nulls last limit 1
  )
  select s.days, s.ok, s.bad, w.day, w.gap, w.pct, s.abs_gap, s.net_gap,
         case when s.bad = 0 then 'ok' else 'exception' end
  from s left join w on true;
$$;

comment on function public.shop_reconciliation(uuid, date, date) is
  'Day-level reconciliation. Exists because a window-level check passes on data that is wrong on most individual days when the errors cancel.';


-- ── shop_top_videos: search, filter, sort and page, all server-side ─────────
drop function if exists public.shop_top_videos(uuid, date, date, int);

create or replace function public.shop_top_videos(
  p_shop_id uuid,
  p_start   date,
  p_end     date,
  p_limit   int    default 50,
  p_offset  int    default 0,
  p_search  text   default null,
  p_status  text   default null,   -- winner | candidate | declining | fatigue_risk | new | rising
  p_sort    text   default 'gmv',  -- gmv | paid_gmv | orders | trend | views | age
  p_dir     text   default 'desc',
  p_ids     text[] default null    -- the exact set behind a finding
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
      -- A missing or zero baseline is NOT a -100% decline. It is no baseline.
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
        -- No baseline and first sold inside the trend window: genuinely new.
        when e.first_day > p_end - 7 and not e.has_baseline then 'new'
        -- Was earning meaningfully and is now falling hard: the only case that
        -- earns the word fatigue. We have NO per-video spend and no in-window
        -- impressions, so "continuing exposure" cannot be tested — the label is
        -- deliberately conservative rather than inferred.
        when e.has_baseline and e.trend_pct <= -0.30 and e.prior_gmv >= 100 then 'fatigue_risk'
        -- A revenue drop on its own is Declining GMV, nothing stronger.
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
  limit  greatest(1, least(coalesce(p_limit, 50), 500));
end;
$fn$;


-- ── creative health, rebuilt on the classified statuses ─────────────────────
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
  new_videos bigint, creators bigint
)
language plpgsql stable as $fn$
declare w record;
begin
  select * into w from public.shop_window(p_shop_id, p_start, p_end);
  return query
  with v as (select * from public.shop_top_videos(p_shop_id, p_start, p_end, 500)),
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
    (select count(*)                from v where v.status in ('declining', 'fatigue_risk')),
    (select coalesce(sum(v.gmv), 0) from v where v.status in ('declining', 'fatigue_risk')),
    (select count(*)                from v where v.status = 'fatigue_risk'),
    (select coalesce(sum(v.gmv), 0) from v where v.status = 'fatigue_risk'),
    (select count(*)                from v where v.status = 'rising'),
    (select coalesce(sum(v.gmv), 0) from v where v.status = 'rising'),
    (select count(*)                from v where v.status = 'winner'),
    (select count(*)                from v where v.status = 'candidate'),
    (p_end - p_start) >= 13,
    -- How much of the population a trend could even be computed for. Without
    -- this, "61 declining" reads as 61 of everything rather than 61 of the
    -- subset that had a prior week to compare against.
    (select count(*) filter (where v.has_baseline)::numeric / nullif(count(*), 0) from v),
    (select coalesce(sum(v.gmv), 0) from v
      where v.posted_date is not null and (p_end - (v.posted_date at time zone 'UTC')::date) <= 30),
    (select coalesce(sum(v.gmv), 0) from v where v.posted_date is not null) / nullif(tot.gmv, 0),
    (select count(*) from v where v.status = 'new'),
    tot.creators
  from tot;
end;
$fn$;


-- ── ONE canonical product benchmark ─────────────────────────────────────────
-- Numerator: funnel orders. Denominator: clicks. Eligibility: at least
-- MIN_CLICKS clicks, so a rate computed on a handful of visits cannot set the
-- bar the whole shop is judged against. n is returned so the UI can disclose
-- the population instead of implying it is the catalogue.
create or replace function public.product_benchmark_min_clicks() returns bigint
language sql immutable as $$ select 500::bigint $$;

create or replace function public.shop_product_stats(p_shop_id uuid, p_start date, p_end date)
returns table (
  catalog_products        bigint,
  products_with_traffic   bigint,
  products_with_sales     bigint,
  products_with_funnel    bigint,
  products_affiliate_only bigint,
  gmv                     numeric,
  orders                  bigint,
  refunds                 numeric,
  refund_rate             numeric,
  impressions             bigint,
  clicks                  bigint,
  ctr                     numeric,
  median_conversion       numeric,
  median_n                bigint,
  median_min_clicks       bigint,
  discount_available      boolean
)
language plpgsql stable as $fn$
declare w record;
begin
  select * into w from public.shop_window(p_shop_id, p_start, p_end);
  return query
  with d as (
    select
      dm.product_id,
      sum(dm.gmv)           as gmv,
      sum(dm.orders)        as orders,
      sum(dm.refunds)       as refunds,
      sum(dm.impressions)   as impressions,
      sum(dm.clicks)        as clicks,
      sum(dm.funnel_orders) as funnel_orders
    from public.product_daily_metrics dm
    where dm.shop_id = p_shop_id and dm.day between p_start and p_end
    group by dm.product_id
  ),
  elig as (
    select d.funnel_orders::numeric / nullif(d.clicks, 0) as rate
    from d
    where d.clicks >= public.product_benchmark_min_clicks()
      and d.funnel_orders is not null
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
    -- "Products with sales" means SALES: positive orders AND positive GMV.
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
    -- percentile_cont casts a numeric input to double precision and returns
    -- double precision, which does NOT match a numeric OUT column: Postgres
    -- rejects the whole function with "structure of query does not match
    -- function result type". Cast it back explicitly.
    (select percentile_cont(0.5) within group (order by elig.rate)::numeric from elig),
    (select count(*) from elig),
    public.product_benchmark_min_clicks(),
    (select coalesce(bool_or(c.discount_pct is not null), false)
       from public.product_catalog c where c.shop_id = p_shop_id);
end;
$fn$;

comment on function public.shop_product_stats(uuid, date, date) is
  'THE canonical product counters and conversion benchmark. Every card, table and recommendation reads this — two different medians under one label is what it exists to prevent.';


-- ── shop_products: search, sort, page, and a total ──────────────────────────
drop function if exists public.shop_products(uuid, date, date, int);

create or replace function public.shop_products(
  p_shop_id uuid,
  p_start   date,
  p_end     date,
  p_limit   int    default 50,
  p_offset  int    default 0,
  p_search  text   default null,
  p_sort    text   default 'gmv',
  p_dir     text   default 'desc',
  p_ids     text[] default null
)
returns table (
  product_id text, title text, image_url text, gmv numeric, orders integer, items_sold integer,
  aov numeric, refunds numeric, refund_rate numeric, impressions bigint, clicks bigint,
  ctr numeric, add_to_cart_rate numeric, click_to_order_rate numeric,
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
      a.clicks::numeric        / nullif(a.impressions, 0) as ctr,
      a.add_to_cart::numeric   / nullif(a.clicks, 0)      as add_to_cart_rate,
      a.funnel_orders::numeric / nullif(a.clicks, 0)      as click_to_order_rate,
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
      and (
        p_search is null or p_search = '' or
        j.product_id ilike '%' || p_search || '%' or
        coalesce(j.title, '') ilike '%' || p_search || '%'
      )
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
    s.click_to_order_rate, s.affiliate_gmv, s.product_card_gmv, s.shop_tab_gmv,
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


-- ── total shop GMV per day: the marginal model's real target ────────────────
-- The model used to fit against GMV Max's own reported revenue, which is close
-- to circular — asking the ad platform's attribution what the ad platform is
-- worth. The decision actually turns on incremental TOTAL shop GMV.
create or replace function public.shop_gmv_daily(p_shop_id uuid, p_start date, p_end date)
returns table (day date, total_gmv numeric, orders integer)
language sql stable as $$
  select ch.day, ch.gmv, ch.orders
  from public.shop_daily_channels ch
  where ch.shop_id = p_shop_id and ch.day between p_start and p_end
  order by ch.day;
$$;


-- ── spend daily, now carrying every candidate target on the same row ────────
drop function if exists public.shop_spend_daily(uuid, date, date);

create or replace function public.shop_spend_daily(p_shop_id uuid, p_start date, p_end date)
returns table (
  day date, data_source text, spend numeric, reported_revenue numeric,
  measured_paid_gmv numeric, total_shop_gmv numeric,
  paid_roas_floor numeric, daily_budget numeric
)
language plpgsql stable as $fn$
declare w record;
begin
  select * into w from public.shop_window(p_shop_id, p_start, p_end);
  return query
  with s as (
    select g.day as d, max(g.data_source) as src,
           coalesce(sum(g.spend), 0) as spend, coalesce(sum(g.revenue), 0) as revenue
    from public.gmv_max_daily_metrics g
    where g.shop_id = p_shop_id and g.day between p_start and p_end
    group by g.day
  ),
  p as (
    select public.shop_day(l.order_created_at, w.tz) as d,
           coalesce(sum(l.payment_amount), 0) as paid
    from public.affiliate_order_lines l
    where l.shop_id = p_shop_id and l.counts_toward_gmv
      and l.classification = 'PAID_SHOP_ADS'
      and l.order_created_at >= w.lo and l.order_created_at < w.hi
    group by 1
  ),
  b as (
    select coalesce(sum(c.daily_budget), 0) as budget
    from public.gmv_max_campaigns c
    where c.shop_id = p_shop_id and c.status = 'ENABLE'
  )
  select s.d, s.src, s.spend, s.revenue,
         coalesce(p.paid, 0),
         ch.gmv,
         coalesce(p.paid, 0) / nullif(s.spend, 0),
         nullif(b.budget, 0)
  from s
  left join p on p.d = s.d
  left join public.shop_daily_channels ch on ch.shop_id = p_shop_id and ch.day = s.d
  cross join b
  order by s.d;
end;
$fn$;


-- ── grants: Supabase hands anon EXECUTE on every new function ───────────────
do $g$
declare f text;
begin
  foreach f in array array[
    'public.shop_attribution(uuid,date,date)',
    'public.shop_channel_daily(uuid,date,date)',
    'public.shop_reconciliation(uuid,date,date)',
    'public.shop_top_videos(uuid,date,date,int,int,text,text,text,text,text[])',
    'public.shop_creative_health(uuid,date,date)',
    'public.shop_products(uuid,date,date,int,int,text,text,text,text[])',
    'public.shop_product_stats(uuid,date,date)',
    'public.shop_gmv_daily(uuid,date,date)',
    'public.shop_spend_daily(uuid,date,date)',
    'public.recon_rounding_tolerance()',
    'public.recon_business_tolerance()',
    'public.product_benchmark_min_clicks()'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$g$;


-- ── verification ────────────────────────────────────────────────────────────
-- Timed, because migration 009 was correct and unusably slow and every check
-- passed while the app was down.
do $verify$
declare
  s record; a record; r record; t0 timestamptz; ms numeric; n int;
begin
  for s in select id, shop_name from public.shops loop
    t0 := clock_timestamp();
    select * into a from public.shop_attribution(s.id, current_date - 32, current_date - 2);
    ms := extract(milliseconds from clock_timestamp() - t0);
    if ms > 3000 then
      raise exception '015: shop_attribution took %ms for % — non-sargable again?', round(ms), s.shop_name;
    end if;

    if a.days_covered is null or a.days_covered = 0 then
      raise notice '015: % has no channel data in the probe window', s.shop_name;
      continue;
    end if;

    -- The reported gap must equal the arithmetic it claims to describe.
    if abs((a.component_total - a.total_gmv) - a.reconciliation_gap) > 0.01 then
      raise exception '015: % gap is not self-consistent (% vs %)',
        s.shop_name, a.component_total - a.total_gmv, a.reconciliation_gap;
    end if;

    select * into r from public.shop_reconciliation(s.id, current_date - 32, current_date - 2);
    raise notice '015: % — capture % pct, gap %, status %, % of % days reconciled',
      s.shop_name,
      round(coalesce(a.affiliate_capture, 0) * 100, 1),
      round(a.reconciliation_gap, 2),
      a.reconciliation_status,
      r.days_reconciled, r.days;

    -- Paging must reach past the old ceiling.
    select count(*) into n from public.shop_top_videos(s.id, current_date - 32, current_date - 2, 500, 0);
    raise notice '015: % — % videos reachable in one page', s.shop_name, n;
  end loop;

  raise notice '015: applied';
end;
$verify$;
