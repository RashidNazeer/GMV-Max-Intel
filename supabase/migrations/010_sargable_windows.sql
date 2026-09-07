-- ============================================================
-- GMV Max Intelligence — 010: make the reporting-day filter use the index again.
--
-- ── THE REGRESSION ─────────────────────────────────────────────────────────
-- Migration 009 replaced
--     (order_created_at at time zone 'UTC')::date between p_start and p_end
-- with
--     public.shop_day(order_created_at, tz) between p_start and p_end
--
-- which is correct and unusably slow. Wrapping the indexed column in a function
-- makes the predicate non-sargable: aol_shop_date_idx can no longer be used, so
-- every call became a full scan of the shop's order lines. Under the service
-- role (a generous statement_timeout) it still returned, so check-attribution
-- passed and the problem stayed invisible. Through the anon key with a user
-- session — which is what the app actually uses — shop_attribution hit
-- "canceling statement due to statement timeout" and every screen broke.
--
-- Two lessons, both worth keeping: a verification run with different privileges
-- from the real caller is not a verification of the real caller, and "correct"
-- and "works" are separate claims that need separate evidence.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- Convert the DATE RANGE into a timestamptz range once, then compare the raw
-- column against it:
--     order_created_at >= (p_start   ::timestamp at time zone tz)
--     order_created_at <  ((p_end + 1)::timestamp at time zone tz)
--
-- Identical rows, same Pacific day boundaries, but the column is untouched so
-- the index applies. Half-open on the right so the last day is included exactly
-- once, with no dependence on timestamp precision.
--
-- shop_day() is still used for GROUPING (a day label has to be computed per
-- row) but never again for FILTERING.
-- ============================================================

-- Resolve a shop's window once, so the bounds become constants in the plan.
create or replace function public.shop_window(
  p_shop_id uuid, p_start date, p_end date,
  out tz text, out lo timestamptz, out hi timestamptz
)
language sql
stable
as $$
  select x.t,
         (p_start::timestamp at time zone x.t),
         ((p_end + 1)::timestamp at time zone x.t)
  from (
    select coalesce(nullif(reporting_timezone, ''), 'America/Los_Angeles') as t
    from public.shops where id = p_shop_id
  ) x;
$$;

-- ── 003 ─────────────────────────────────────────────────────────────────────
create or replace function public.shop_affiliate_summary(p_start date, p_end date)
returns table (
  shop_id uuid, shop_name text, currency text, affiliate_connected boolean,
  lines bigint, gmv numeric, paid_gmv numeric, organic_gmv numeric,
  mixed_gmv numeric, unclassified_gmv numeric, settled_lines bigint,
  paid_share numeric, coverage numeric
)
language sql stable as $$
  with b as (
    select id,
           (p_start::timestamp     at time zone coalesce(nullif(reporting_timezone, ''), 'America/Los_Angeles')) as lo,
           ((p_end + 1)::timestamp at time zone coalesce(nullif(reporting_timezone, ''), 'America/Los_Angeles')) as hi
    from public.shops
  )
  select
    s.id, coalesce(s.display_name, s.shop_name), s.currency, s.affiliate_connected,
    count(l.id),
    coalesce(sum(l.payment_amount), 0),
    coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0),
    coalesce(sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD'), 0),
    coalesce(sum(l.payment_amount) filter (where l.classification = 'MIXED'), 0),
    coalesce(sum(l.payment_amount) filter (where l.classification = 'UNCLASSIFIED'), 0),
    count(l.id) filter (where l.classification_basis = 'ACTUAL_COMMISSION'),
    sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS')
      / nullif(sum(l.payment_amount) filter (where l.classification in ('PAID_SHOP_ADS','ORGANIC_STANDARD')), 0),
    sum(l.payment_amount) filter (where l.classification in ('PAID_SHOP_ADS','ORGANIC_STANDARD'))
      / nullif(sum(l.payment_amount), 0)
  from public.shops s
  join b on b.id = s.id
  left join public.affiliate_order_lines l
    on l.shop_id = s.id
   and l.counts_toward_gmv
   and l.order_created_at >= b.lo
   and l.order_created_at <  b.hi
  group by s.id, s.display_name, s.shop_name, s.currency, s.affiliate_connected
  order by 6 desc;
$$;

create or replace function public.shop_affiliate_daily(p_shop_id uuid, p_start date, p_end date)
returns table (day date, lines bigint, gmv numeric, paid_gmv numeric, organic_gmv numeric, paid_share numeric)
language plpgsql stable as $fn$
declare w record;
begin
  select * into w from public.shop_window(p_shop_id, p_start, p_end);
  return query
    select
      public.shop_day(l.order_created_at, w.tz),
      count(*),
      sum(l.payment_amount),
      coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0),
      coalesce(sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD'), 0),
      sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS')
        / nullif(sum(l.payment_amount) filter (where l.classification in ('PAID_SHOP_ADS','ORGANIC_STANDARD')), 0)
    from public.affiliate_order_lines l
    where l.shop_id = p_shop_id
      and l.counts_toward_gmv
      and l.order_created_at >= w.lo and l.order_created_at < w.hi
    group by 1 order by 1;
end;
$fn$;

create or replace function public.shop_top_creators(p_shop_id uuid, p_start date, p_end date, p_limit int default 25)
returns table (creator_handle text, lines bigint, gmv numeric, paid_gmv numeric, organic_gmv numeric, paid_share numeric)
language plpgsql stable as $fn$
declare w record;
begin
  select * into w from public.shop_window(p_shop_id, p_start, p_end);
  return query
    select
      l.creator_handle, count(*), sum(l.payment_amount),
      coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0),
      coalesce(sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD'), 0),
      sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS')
        / nullif(sum(l.payment_amount) filter (where l.classification in ('PAID_SHOP_ADS','ORGANIC_STANDARD')), 0)
    from public.affiliate_order_lines l
    where l.shop_id = p_shop_id
      and l.counts_toward_gmv
      and l.order_created_at >= w.lo and l.order_created_at < w.hi
    group by 1 order by 3 desc
    limit greatest(1, least(coalesce(p_limit, 25), 200));
end;
$fn$;

-- ── 004 ─────────────────────────────────────────────────────────────────────
create or replace function public.shop_attribution(p_shop_id uuid, p_start date, p_end date)
returns table (
  days_covered integer, total_gmv numeric,
  measured_paid_gmv numeric, measured_organic_gmv numeric, affiliate_unmeasured_gmv numeric,
  seller_video_gmv numeric, live_gmv numeric, product_card_gmv numeric,
  affiliate_video_sc_gmv numeric, affiliate_video_ours_gmv numeric,
  affiliate_capture numeric, attribution_coverage numeric, paid_share_of_measured numeric,
  other_affiliate_gmv numeric, other_affiliate_paid_gmv numeric,
  orders bigint, customers bigint
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
    -- Filtered on the raw column (index-usable), THEN bucketed to a day so the
    -- lines counted are exactly the days the channel data covers.
    lines as (
      select l.content_type, l.classification, l.payment_amount
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
        count(*)::int as days_covered,
        coalesce(sum(ch.gmv), 0) as total_gmv,
        coalesce(sum(ch.video_affiliate_gmv), 0) as aff_sc,
        coalesce(sum(ch.video_seller_gmv), 0) as seller_video,
        coalesce(sum(ch.live_gmv), 0) as live,
        coalesce(sum(ch.product_card_gmv), 0) as pcard,
        coalesce(sum(ch.orders), 0)::bigint as orders,
        coalesce(sum(ch.customers), 0)::bigint as customers
      from ch
    )
    select
      agg.days_covered, agg.total_gmv, vid.paid, vid.organic,
      greatest(agg.aff_sc - vid.total, 0),
      agg.seller_video, agg.live, agg.pcard, agg.aff_sc, vid.total,
      vid.total / nullif(agg.aff_sc, 0),
      (vid.paid + vid.organic) / nullif(agg.total_gmv, 0),
      vid.paid / nullif(vid.paid + vid.organic, 0),
      oth.total, oth.paid, agg.orders, agg.customers
    from agg, vid, oth;
end;
$fn$;

create or replace function public.shop_channel_daily(p_shop_id uuid, p_start date, p_end date)
returns table (
  day date, total_gmv numeric, measured_paid_gmv numeric, measured_organic_gmv numeric,
  affiliate_unmeasured_gmv numeric, seller_video_gmv numeric, live_gmv numeric, product_card_gmv numeric
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
    )
    select
      ch.day, ch.gmv,
      coalesce(v.paid, 0), coalesce(v.organic, 0),
      greatest(coalesce(ch.video_affiliate_gmv, 0) - coalesce(v.total, 0), 0),
      coalesce(ch.video_seller_gmv, 0), coalesce(ch.live_gmv, 0), coalesce(ch.product_card_gmv, 0)
    from public.shop_daily_channels ch
    left join lines v on v.d = ch.day
    where ch.shop_id = p_shop_id and ch.day between p_start and p_end
    order by ch.day;
end;
$fn$;

-- ── 005 ─────────────────────────────────────────────────────────────────────
create or replace function public.shop_top_videos(p_shop_id uuid, p_start date, p_end date, p_limit int default 25)
returns table (
  video_id text, creator_handle text, title text, tiktok_url text,
  posted_date timestamptz, age_days integer, lines bigint, orders bigint,
  gmv numeric, paid_gmv numeric, organic_gmv numeric, paid_share numeric,
  gmv_share numeric, recent_gmv numeric, prior_gmv numeric, trend_pct numeric, views bigint
)
language plpgsql stable as $fn$
declare w record; r7 timestamptz; r14 timestamptz;
begin
  select * into w from public.shop_window(p_shop_id, p_start, p_end);
  -- The 7/14-day trend boundaries as timestamps, so the comparison stays on the
  -- raw column here too.
  r7  := ((p_end - 6)::timestamp  at time zone w.tz);
  r14 := ((p_end - 13)::timestamp at time zone w.tz);

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
          where l.order_created_at >= r14 and l.order_created_at < r7), 0)         as prior_gmv
      from public.affiliate_order_lines l
      where l.shop_id = p_shop_id
        and l.counts_toward_gmv
        and l.content_id is not null
        and l.content_type = 'Video'
        and l.order_created_at >= w.lo and l.order_created_at < w.hi
      group by l.content_id
    ),
    tot as (select nullif(sum(x.gmv), 0) as gmv from lines x)
    select
      x.vid, coalesce(v.creator_handle, x.creator_handle), v.title, v.tiktok_url, v.posted_date,
      case when v.posted_date is null then null
           else (p_end - (v.posted_date at time zone 'UTC')::date)::int end,
      x.lines, x.orders, x.gmv, x.paid_gmv, x.organic_gmv,
      x.paid_gmv / nullif(x.paid_gmv + x.organic_gmv, 0),
      x.gmv / tot.gmv, x.recent_gmv, x.prior_gmv,
      case
        when (p_end - p_start) < 14 then null
        when x.prior_gmv = 0 then null
        else (x.recent_gmv - x.prior_gmv) / x.prior_gmv
      end,
      v.views
    from lines x
    cross join tot
    left join public.video_latest v on v.shop_id = p_shop_id and v.video_id = x.vid
    order by x.gmv desc
    limit greatest(1, least(coalesce(p_limit, 25), 200));
end;
$fn$;

create or replace function public.shop_creative_health(p_shop_id uuid, p_start date, p_end date)
returns table (
  video_count bigint, gmv numeric, top1_share numeric, top5_share numeric, top10_share numeric,
  fatigued_videos bigint, fatigued_gmv numeric, rising_videos bigint, rising_gmv numeric,
  trend_measurable boolean, fresh_gmv numeric, freshness_coverage numeric,
  new_videos bigint, creators bigint
)
language plpgsql stable as $fn$
declare w record;
begin
  select * into w from public.shop_window(p_shop_id, p_start, p_end);
  return query
    with v as (select * from public.shop_top_videos(p_shop_id, p_start, p_end, 200)),
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
    ranked as (select v.*, row_number() over (order by v.gmv desc) as rn from v),
    first_sale as (
      select l.content_id as cid, min(public.shop_day(l.order_created_at, w.tz)) as first_day
      from public.affiliate_order_lines l
      where l.shop_id = p_shop_id and l.counts_toward_gmv
        and l.content_id is not null and l.content_type = 'Video'
        and l.order_created_at >= w.lo and l.order_created_at < w.hi
      group by 1
    )
    select
      tot.video_count, tot.gmv,
      coalesce((select sum(x.gmv) from ranked x where x.rn <= 1), 0)  / nullif(tot.gmv, 0),
      coalesce((select sum(x.gmv) from ranked x where x.rn <= 5), 0)  / nullif(tot.gmv, 0),
      coalesce((select sum(x.gmv) from ranked x where x.rn <= 10), 0) / nullif(tot.gmv, 0),
      (select count(*) from v where v.trend_pct is not null and v.trend_pct <= -0.30),
      (select coalesce(sum(v.gmv), 0) from v where v.trend_pct is not null and v.trend_pct <= -0.30),
      (select count(*) from v where v.trend_pct is not null and v.trend_pct >= 0.30),
      (select coalesce(sum(v.gmv), 0) from v where v.trend_pct is not null and v.trend_pct >= 0.30),
      (p_end - p_start) >= 14,
      (select coalesce(sum(v.gmv), 0) from v
        where v.posted_date is not null and (p_end - (v.posted_date at time zone 'UTC')::date) <= 30),
      (select coalesce(sum(v.gmv), 0) from v where v.posted_date is not null) / nullif(tot.gmv, 0),
      (select count(*) from first_sale f where f.first_day > p_end - 7),
      tot.creators
    from tot;
end;
$fn$;

-- ── 006 ─────────────────────────────────────────────────────────────────────
create or replace function public.shop_products(p_shop_id uuid, p_start date, p_end date, p_limit int default 50)
returns table (
  product_id text, title text, image_url text, gmv numeric, orders integer, items_sold integer,
  aov numeric, refunds numeric, refund_rate numeric, impressions bigint, clicks bigint,
  ctr numeric, add_to_cart_rate numeric, click_to_order_rate numeric,
  affiliate_gmv numeric, product_card_gmv numeric, shop_tab_gmv numeric, seller_video_gmv numeric,
  measured_paid_gmv numeric, measured_organic_gmv numeric, paid_share numeric,
  min_price numeric, max_price numeric, inventory bigint, commission_rate numeric,
  discount_pct numeric, days_with_data integer
)
language plpgsql stable as $fn$
declare w record;
begin
  select * into w from public.shop_window(p_shop_id, p_start, p_end);
  return query
    with mine as (
      select
        l.product_id as pid,
        coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0)    as paid,
        coalesce(sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD'), 0) as organic
      from public.affiliate_order_lines l
      where l.shop_id = p_shop_id and l.counts_toward_gmv and l.product_id is not null
        and l.order_created_at >= w.lo and l.order_created_at < w.hi
      group by 1
    ),
    win as (
      select distinct on (pwm.product_id) pwm.*
      from public.product_window_metrics pwm
      where pwm.shop_id = p_shop_id and pwm.window_end between p_start and p_end
      order by pwm.product_id, pwm.window_end desc
    )
    select
      coalesce(win.product_id, m.pid),
      coalesce(c.title, win.product_name),
      coalesce(c.image_url, win.cover_image_url),
      win.gmv, win.orders, win.items_sold, win.aov, win.refunds, win.refunds / nullif(win.gmv, 0),
      win.impressions, win.clicks, win.ctr, win.add_to_cart_rate, win.click_to_order_rate,
      win.affiliate_gmv, win.product_card_gmv, win.shop_tab_gmv, win.seller_video_gmv,
      coalesce(m.paid, 0), coalesce(m.organic, 0),
      m.paid / nullif(m.paid + m.organic, 0),
      c.min_price, c.max_price, c.inventory, c.commission_rate, c.discount_pct, win.days_with_data
    from win
    full join mine m on m.pid = win.product_id
    left join public.product_catalog c
      on c.shop_id = p_shop_id and c.product_id = coalesce(win.product_id, m.pid)
    order by coalesce(win.gmv, 0) desc, coalesce(m.paid, 0) + coalesce(m.organic, 0) desc
    limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$fn$;

-- ── 007/008 ─────────────────────────────────────────────────────────────────
create or replace function public.shop_paid_roas(p_shop_id uuid, p_start date, p_end date)
returns table (
  data_source text, is_simulated boolean, campaigns bigint, days_with_spend integer,
  spend numeric, spend_affiliate_surface numeric,
  reported_revenue numeric, reported_roi numeric,
  verified_paid_gmv numeric, verified_roas numeric,
  unverified_revenue numeric, unverified_share numeric, affiliate_surface_roas numeric
)
language plpgsql stable as $fn$
declare w record;
begin
  select * into w from public.shop_window(p_shop_id, p_start, p_end);
  return query
    with m as (
      select
        max(g.data_source) as data_source,
        count(distinct g.campaign_id) as campaigns,
        count(distinct g.day) filter (where coalesce(g.spend, 0) > 0) as days_with_spend,
        coalesce(sum(g.spend), 0) as spend,
        sum(g.spend_affiliate) as spend_affiliate,
        coalesce(sum(g.revenue), 0) as revenue
      from public.gmv_max_daily_metrics g
      where g.shop_id = p_shop_id and g.day between p_start and p_end
    ),
    spend_days as (
      select g.day from public.gmv_max_daily_metrics g
       where g.shop_id = p_shop_id and g.day between p_start and p_end and coalesce(g.spend, 0) > 0
    ),
    ours as (
      select coalesce(sum(l.payment_amount), 0) as paid
      from public.affiliate_order_lines l
      where l.shop_id = p_shop_id
        and l.counts_toward_gmv
        and l.classification = 'PAID_SHOP_ADS'
        and l.order_created_at >= w.lo and l.order_created_at < w.hi
        and public.shop_day(l.order_created_at, w.tz) in (select day from spend_days)
    )
    select
      m.data_source, m.data_source = 'simulated', m.campaigns, m.days_with_spend::int,
      m.spend, m.spend_affiliate, m.revenue, m.revenue / nullif(m.spend, 0),
      ours.paid, ours.paid / nullif(m.spend, 0),
      greatest(m.revenue - ours.paid, 0),
      greatest(m.revenue - ours.paid, 0) / nullif(m.revenue, 0),
      ours.paid / nullif(m.spend_affiliate, 0)
    from m, ours
    where m.campaigns > 0;
end;
$fn$;

create or replace function public.shop_spend_daily(p_shop_id uuid, p_start date, p_end date)
returns table (day date, data_source text, spend numeric, reported_revenue numeric,
               measured_paid_gmv numeric, paid_roas_floor numeric)
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
    )
    select s.d, s.src, s.spend, s.revenue,
           coalesce(p.paid, 0), coalesce(p.paid, 0) / nullif(s.spend, 0)
    from s left join p on p.d = s.d
    order by s.d;
end;
$fn$;

-- ── grants ──────────────────────────────────────────────────────────────────
do $grants$
declare fn text;
begin
  foreach fn in array array[
    'public.shop_window(uuid, date, date)',
    'public.shop_affiliate_summary(date, date)',
    'public.shop_affiliate_daily(uuid, date, date)',
    'public.shop_top_creators(uuid, date, date, int)',
    'public.shop_attribution(uuid, date, date)',
    'public.shop_channel_daily(uuid, date, date)',
    'public.shop_top_videos(uuid, date, date, int)',
    'public.shop_creative_health(uuid, date, date)',
    'public.shop_products(uuid, date, date, int)',
    'public.shop_paid_roas(uuid, date, date)',
    'public.shop_spend_daily(uuid, date, date)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$grants$;

-- ── verification: correctness AND speed, at the caller's own timeout ────────
do $verify$
declare
  sid uuid; t0 timestamptz; ms numeric; fn text; v int;
  worst numeric := 0; worst_fn text;
begin
  foreach fn in array array[
    'public.shop_affiliate_summary(date, date)',
    'public.shop_attribution(uuid, date, date)',
    'public.shop_channel_daily(uuid, date, date)',
    'public.shop_top_videos(uuid, date, date, int)',
    'public.shop_creative_health(uuid, date, date)',
    'public.shop_products(uuid, date, date, int)',
    'public.shop_paid_roas(uuid, date, date)',
    'public.shop_spend_daily(uuid, date, date)'
  ] loop
    if has_function_privilege('anon', fn, 'execute') then
      raise exception '010: anon can call %', fn;
    end if;
  end loop;

  select id into sid from public.shops
   where reacher_shop_id = 11515 or true order by reacher_shop_id limit 1;
  if sid is null then
    raise notice '010: no shops yet — skipping the timing check';
    return;
  end if;

  -- Time each function the way the app calls it. The regression this migration
  -- fixes was a TIMEOUT, so a correctness-only check would have missed it
  -- exactly as the last one did.
  t0 := clock_timestamp();
  perform * from public.shop_attribution(sid, current_date - 30, current_date);
  ms := extract(epoch from clock_timestamp() - t0) * 1000;
  if ms > worst then worst := ms; worst_fn := 'shop_attribution'; end if;

  t0 := clock_timestamp();
  perform * from public.shop_creative_health(sid, current_date - 30, current_date);
  ms := extract(epoch from clock_timestamp() - t0) * 1000;
  if ms > worst then worst := ms; worst_fn := 'shop_creative_health'; end if;

  t0 := clock_timestamp();
  perform * from public.shop_products(sid, current_date - 30, current_date, 50);
  ms := extract(epoch from clock_timestamp() - t0) * 1000;
  if ms > worst then worst := ms; worst_fn := 'shop_products'; end if;

  t0 := clock_timestamp();
  perform * from public.shop_affiliate_summary(current_date - 30, current_date);
  ms := extract(epoch from clock_timestamp() - t0) * 1000;
  if ms > worst then worst := ms; worst_fn := 'shop_affiliate_summary'; end if;

  -- Supabase gives the authenticated role a few seconds. Anything approaching
  -- that is a screen that fails for a user while passing every test here.
  if worst > 3000 then
    raise exception '010: % took %ms — still too slow for the app role', worst_fn, round(worst);
  end if;

  raise notice '010: window filters are index-usable again — slowest checked call % at %ms',
    worst_fn, round(worst);
end;
$verify$;
