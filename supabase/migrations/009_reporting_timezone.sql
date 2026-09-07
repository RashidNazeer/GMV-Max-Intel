-- ============================================================
-- GMV Max Intelligence — 009: bucket revenue by the SHOP'S reporting day.
--
-- ── THE BUG ────────────────────────────────────────────────────────────────
-- Every function so far bucketed order lines with
--     (order_created_at at time zone 'UTC')::date
-- while the channel figures came from Seller Center, which reports on TikTok's
-- own day boundary. Measured 2026-09-07: asking Reacher for 2026-08-30 alone
-- returns 80 rows whose order_created_at straddles two UTC dates —
--
--     UTC                   2026-08-30 = 39 · 2026-08-31 = 41
--     America/Los_Angeles   2026-08-30 = 80   <- all of them
--     America/New_York      2026-08-30 = 74 · 2026-08-31 = 6
--     Asia/Shanghai         2026-08-30 =  6 · 2026-08-31 = 74
--
-- so the boundary is Pacific, and roughly half of every day's revenue was being
-- filed under the following day while the channel total for that day was not.
--
-- Window TOTALS were barely affected — the shifts cancel except at the two
-- edges — which is why the reconciliation checks passed and this stayed hidden.
-- But every DAILY number was wrong: the stacked daily chart, the day-level
-- capture comparison, and, more seriously, shop_paid_roas, which matches
-- measured revenue to the days that carry spend. Matching the wrong days there
-- produces a plausible, confidently wrong ROAS.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- One definition of "a day", stored per shop because it is a property of the
-- shop's market rather than of our servers. Longevity is a UK shop; when it
-- ever carries data its boundary will be Europe/London, and hardcoding Pacific
-- would silently repeat this bug in a new place.
-- ============================================================

alter table public.shops
  add column if not exists reporting_timezone text not null default 'America/Los_Angeles';

-- Reacher's shops carry a region; use it where we can rather than assuming.
update public.shops set reporting_timezone = 'Europe/London'
 where upper(coalesce(region, '')) in ('UK', 'GB') and reporting_timezone = 'America/Los_Angeles';

comment on column public.shops.reporting_timezone is
  'The day boundary Seller Center and the affiliate feed report on. Verified for '
  '11515/11528 as America/Los_Angeles by probing a single day and checking which '
  'timezone makes every returned row fall on it. Change this and every daily '
  'number for the shop moves — it is the definition of a day, not a display setting.';

-- One place that decides what day a timestamp belongs to.
create or replace function public.shop_day(p_ts timestamptz, p_tz text)
returns date
language sql
immutable
parallel safe
as $$
  select (p_ts at time zone coalesce(nullif(p_tz, ''), 'America/Los_Angeles'))::date;
$$;

-- ── 003: summary + daily ────────────────────────────────────────────────────
create or replace function public.shop_affiliate_summary(p_start date, p_end date)
returns table (
  shop_id uuid, shop_name text, currency text, affiliate_connected boolean,
  lines bigint, gmv numeric, paid_gmv numeric, organic_gmv numeric,
  mixed_gmv numeric, unclassified_gmv numeric, settled_lines bigint,
  paid_share numeric, coverage numeric
)
language sql stable as $$
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
  left join public.affiliate_order_lines l
    on l.shop_id = s.id
   and l.counts_toward_gmv
   and public.shop_day(l.order_created_at, s.reporting_timezone) between p_start and p_end
  group by s.id, s.display_name, s.shop_name, s.currency, s.affiliate_connected
  order by 6 desc;
$$;

create or replace function public.shop_affiliate_daily(p_shop_id uuid, p_start date, p_end date)
returns table (day date, lines bigint, gmv numeric, paid_gmv numeric, organic_gmv numeric, paid_share numeric)
language sql stable as $$
  select
    public.shop_day(l.order_created_at, s.reporting_timezone),
    count(*),
    sum(l.payment_amount),
    coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0),
    coalesce(sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD'), 0),
    sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS')
      / nullif(sum(l.payment_amount) filter (where l.classification in ('PAID_SHOP_ADS','ORGANIC_STANDARD')), 0)
  from public.affiliate_order_lines l
  join public.shops s on s.id = l.shop_id
  where l.shop_id = p_shop_id
    and l.counts_toward_gmv
    and public.shop_day(l.order_created_at, s.reporting_timezone) between p_start and p_end
  group by 1 order by 1;
$$;

create or replace function public.shop_top_creators(p_shop_id uuid, p_start date, p_end date, p_limit int default 25)
returns table (creator_handle text, lines bigint, gmv numeric, paid_gmv numeric, organic_gmv numeric, paid_share numeric)
language sql stable as $$
  select
    l.creator_handle, count(*), sum(l.payment_amount),
    coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0),
    coalesce(sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD'), 0),
    sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS')
      / nullif(sum(l.payment_amount) filter (where l.classification in ('PAID_SHOP_ADS','ORGANIC_STANDARD')), 0)
  from public.affiliate_order_lines l
  join public.shops s on s.id = l.shop_id
  where l.shop_id = p_shop_id
    and l.counts_toward_gmv
    and public.shop_day(l.order_created_at, s.reporting_timezone) between p_start and p_end
  group by 1 order by 3 desc
  limit greatest(1, least(coalesce(p_limit, 25), 200));
$$;

-- ── 004: attribution ────────────────────────────────────────────────────────
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
language sql stable as $$
  with tz as (
    select coalesce(nullif(reporting_timezone, ''), 'America/Los_Angeles') as t
    from public.shops where id = p_shop_id
  ),
  ch as (
    select * from public.shop_daily_channels
     where shop_id = p_shop_id and day between p_start and p_end
  ),
  lines as (
    select l.*
      from public.affiliate_order_lines l, tz
     where l.shop_id = p_shop_id
       and l.counts_toward_gmv
       and public.shop_day(l.order_created_at, tz.t) in (select day from ch)
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
$$;

create or replace function public.shop_channel_daily(p_shop_id uuid, p_start date, p_end date)
returns table (
  day date, total_gmv numeric, measured_paid_gmv numeric, measured_organic_gmv numeric,
  affiliate_unmeasured_gmv numeric, seller_video_gmv numeric, live_gmv numeric, product_card_gmv numeric
)
language sql stable as $$
  with tz as (
    select coalesce(nullif(reporting_timezone, ''), 'America/Los_Angeles') as t
    from public.shops where id = p_shop_id
  ),
  lines as (
    select
      public.shop_day(l.order_created_at, tz.t) as day,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0)    as paid,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD'), 0) as organic,
      coalesce(sum(l.payment_amount), 0)                                                      as total
    from public.affiliate_order_lines l, tz
    where l.shop_id = p_shop_id
      and l.counts_toward_gmv
      and l.content_type = 'Video'
      and public.shop_day(l.order_created_at, tz.t) between p_start and p_end
    group by 1
  )
  select
    ch.day, ch.gmv,
    coalesce(v.paid, 0), coalesce(v.organic, 0),
    greatest(coalesce(ch.video_affiliate_gmv, 0) - coalesce(v.total, 0), 0),
    coalesce(ch.video_seller_gmv, 0), coalesce(ch.live_gmv, 0), coalesce(ch.product_card_gmv, 0)
  from public.shop_daily_channels ch
  left join lines v on v.day = ch.day
  where ch.shop_id = p_shop_id and ch.day between p_start and p_end
  order by ch.day;
$$;

-- ── 005: creative ───────────────────────────────────────────────────────────
create or replace function public.shop_top_videos(p_shop_id uuid, p_start date, p_end date, p_limit int default 25)
returns table (
  video_id text, creator_handle text, title text, tiktok_url text,
  posted_date timestamptz, age_days integer, lines bigint, orders bigint,
  gmv numeric, paid_gmv numeric, organic_gmv numeric, paid_share numeric,
  gmv_share numeric, recent_gmv numeric, prior_gmv numeric, trend_pct numeric, views bigint
)
language sql stable as $$
  with tz as (
    select coalesce(nullif(reporting_timezone, ''), 'America/Los_Angeles') as t
    from public.shops where id = p_shop_id
  ),
  lines as (
    select
      l.content_id as video_id,
      max(l.creator_handle) as creator_handle,
      count(*) as lines,
      count(distinct l.order_id) as orders,
      coalesce(sum(l.payment_amount), 0) as gmv,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0)    as paid_gmv,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD'), 0) as organic_gmv,
      coalesce(sum(l.payment_amount) filter (
        where public.shop_day(l.order_created_at, tz.t) > p_end - 7), 0) as recent_gmv,
      coalesce(sum(l.payment_amount) filter (
        where public.shop_day(l.order_created_at, tz.t) <= p_end - 7
          and public.shop_day(l.order_created_at, tz.t) > p_end - 14), 0) as prior_gmv
    from public.affiliate_order_lines l, tz
    where l.shop_id = p_shop_id
      and l.counts_toward_gmv
      and l.content_id is not null
      and l.content_type = 'Video'
      and public.shop_day(l.order_created_at, tz.t) between p_start and p_end
    group by l.content_id
  ),
  tot as (select nullif(sum(gmv), 0) as gmv from lines)
  select
    x.video_id, coalesce(v.creator_handle, x.creator_handle), v.title, v.tiktok_url, v.posted_date,
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
  left join public.video_latest v on v.shop_id = p_shop_id and v.video_id = x.video_id
  order by x.gmv desc
  limit greatest(1, least(coalesce(p_limit, 25), 200));
$$;

create or replace function public.shop_creative_health(p_shop_id uuid, p_start date, p_end date)
returns table (
  video_count bigint, gmv numeric, top1_share numeric, top5_share numeric, top10_share numeric,
  fatigued_videos bigint, fatigued_gmv numeric, rising_videos bigint, rising_gmv numeric,
  trend_measurable boolean, fresh_gmv numeric, freshness_coverage numeric,
  new_videos bigint, creators bigint
)
language sql stable as $$
  with tz as (
    select coalesce(nullif(reporting_timezone, ''), 'America/Los_Angeles') as t
    from public.shops where id = p_shop_id
  ),
  v as (select * from public.shop_top_videos(p_shop_id, p_start, p_end, 200)),
  tot as (
    select
      count(distinct l.content_id) as video_count,
      count(distinct l.creator_handle) as creators,
      coalesce(sum(l.payment_amount), 0) as gmv
    from public.affiliate_order_lines l, tz
    where l.shop_id = p_shop_id and l.counts_toward_gmv
      and l.content_id is not null and l.content_type = 'Video'
      and public.shop_day(l.order_created_at, tz.t) between p_start and p_end
  ),
  ranked as (select v.*, row_number() over (order by v.gmv desc) as rn from v),
  first_sale as (
    select l.content_id, min(public.shop_day(l.order_created_at, tz.t)) as first_day
    from public.affiliate_order_lines l, tz
    where l.shop_id = p_shop_id and l.counts_toward_gmv
      and l.content_id is not null and l.content_type = 'Video'
      and public.shop_day(l.order_created_at, tz.t) between p_start and p_end
    group by 1
  )
  select
    tot.video_count, tot.gmv,
    coalesce((select sum(gmv) from ranked where rn <= 1), 0)  / nullif(tot.gmv, 0),
    coalesce((select sum(gmv) from ranked where rn <= 5), 0)  / nullif(tot.gmv, 0),
    coalesce((select sum(gmv) from ranked where rn <= 10), 0) / nullif(tot.gmv, 0),
    (select count(*) from v where trend_pct is not null and trend_pct <= -0.30),
    (select coalesce(sum(gmv), 0) from v where trend_pct is not null and trend_pct <= -0.30),
    (select count(*) from v where trend_pct is not null and trend_pct >= 0.30),
    (select coalesce(sum(gmv), 0) from v where trend_pct is not null and trend_pct >= 0.30),
    (p_end - p_start) >= 14,
    (select coalesce(sum(gmv), 0) from v
      where posted_date is not null and (p_end - (posted_date at time zone 'UTC')::date) <= 30),
    (select coalesce(sum(gmv), 0) from v where posted_date is not null) / nullif(tot.gmv, 0),
    (select count(*) from first_sale where first_day > p_end - 7),
    tot.creators
  from tot;
$$;

-- ── 006: products ───────────────────────────────────────────────────────────
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
language sql stable as $$
  with tz as (
    select coalesce(nullif(reporting_timezone, ''), 'America/Los_Angeles') as t
    from public.shops where id = p_shop_id
  ),
  mine as (
    select
      l.product_id,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0)    as paid,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD'), 0) as organic
    from public.affiliate_order_lines l, tz
    where l.shop_id = p_shop_id and l.counts_toward_gmv and l.product_id is not null
      and public.shop_day(l.order_created_at, tz.t) between p_start and p_end
    group by 1
  ),
  w as (
    select distinct on (product_id) *
    from public.product_window_metrics
    where shop_id = p_shop_id and window_end between p_start and p_end
    order by product_id, window_end desc
  )
  select
    coalesce(w.product_id, m.product_id),
    coalesce(c.title, w.product_name),
    coalesce(c.image_url, w.cover_image_url),
    w.gmv, w.orders, w.items_sold, w.aov, w.refunds, w.refunds / nullif(w.gmv, 0),
    w.impressions, w.clicks, w.ctr, w.add_to_cart_rate, w.click_to_order_rate,
    w.affiliate_gmv, w.product_card_gmv, w.shop_tab_gmv, w.seller_video_gmv,
    coalesce(m.paid, 0), coalesce(m.organic, 0),
    m.paid / nullif(m.paid + m.organic, 0),
    c.min_price, c.max_price, c.inventory, c.commission_rate, c.discount_pct, w.days_with_data
  from w
  full join mine m on m.product_id = w.product_id
  left join public.product_catalog c
    on c.shop_id = p_shop_id and c.product_id = coalesce(w.product_id, m.product_id)
  order by coalesce(w.gmv, 0) desc, coalesce(m.paid, 0) + coalesce(m.organic, 0) desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

-- ── 007/008: spend. This is where the bug had teeth — matching measured
-- revenue to "days that carry spend" across two different day definitions
-- would produce a confidently wrong ROAS.
create or replace function public.shop_paid_roas(p_shop_id uuid, p_start date, p_end date)
returns table (
  data_source text, is_simulated boolean, campaigns bigint, days_with_spend integer,
  spend numeric, spend_affiliate_surface numeric,
  reported_revenue numeric, reported_roi numeric,
  verified_paid_gmv numeric, verified_roas numeric,
  unverified_revenue numeric, unverified_share numeric, affiliate_surface_roas numeric
)
language sql stable as $$
  with tz as (
    select coalesce(nullif(reporting_timezone, ''), 'America/Los_Angeles') as t
    from public.shops where id = p_shop_id
  ),
  m as (
    select
      max(data_source) as data_source,
      count(distinct campaign_id) as campaigns,
      count(distinct day) filter (where coalesce(spend, 0) > 0) as days_with_spend,
      coalesce(sum(spend), 0) as spend,
      sum(spend_affiliate) as spend_affiliate,
      coalesce(sum(revenue), 0) as revenue
    from public.gmv_max_daily_metrics
    where shop_id = p_shop_id and day between p_start and p_end
  ),
  ours as (
    select coalesce(sum(l.payment_amount), 0) as paid
    from public.affiliate_order_lines l, tz
    where l.shop_id = p_shop_id
      and l.counts_toward_gmv
      and l.classification = 'PAID_SHOP_ADS'
      and public.shop_day(l.order_created_at, tz.t) in (
        select day from public.gmv_max_daily_metrics
         where shop_id = p_shop_id and day between p_start and p_end and coalesce(spend, 0) > 0
      )
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
$$;

create or replace function public.shop_spend_daily(p_shop_id uuid, p_start date, p_end date)
returns table (day date, data_source text, spend numeric, reported_revenue numeric,
               measured_paid_gmv numeric, paid_roas_floor numeric)
language sql stable as $$
  with tz as (
    select coalesce(nullif(reporting_timezone, ''), 'America/Los_Angeles') as t
    from public.shops where id = p_shop_id
  ),
  s as (
    select day, max(data_source) as data_source,
           coalesce(sum(spend), 0) as spend, coalesce(sum(revenue), 0) as revenue
    from public.gmv_max_daily_metrics
    where shop_id = p_shop_id and day between p_start and p_end
    group by day
  ),
  p as (
    select public.shop_day(l.order_created_at, tz.t) as day,
           coalesce(sum(l.payment_amount), 0) as paid
    from public.affiliate_order_lines l, tz
    where l.shop_id = p_shop_id and l.counts_toward_gmv
      and l.classification = 'PAID_SHOP_ADS'
      and public.shop_day(l.order_created_at, tz.t) between p_start and p_end
    group by 1
  )
  select s.day, s.data_source, s.spend, s.revenue,
         coalesce(p.paid, 0), coalesce(p.paid, 0) / nullif(s.spend, 0)
  from s left join p on p.day = s.day
  order by s.day;
$$;

-- ── 002: the rollup view ────────────────────────────────────────────────────
create or replace view public.affiliate_daily as
select
  l.shop_id,
  public.shop_day(l.order_created_at, s.reporting_timezone) as day,
  l.product_id,
  count(*) as lines,
  sum(l.payment_amount) as gmv,
  sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS')    as paid_gmv,
  sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD') as organic_gmv,
  sum(l.payment_amount) filter (where l.classification = 'MIXED')            as mixed_gmv,
  sum(l.payment_amount) filter (where l.classification = 'UNCLASSIFIED')     as unclassified_gmv,
  count(*) filter (where l.classification_basis = 'ACTUAL_COMMISSION')       as settled_lines,
  sum(l.payment_amount) filter (where l.classification in ('PAID_SHOP_ADS','ORGANIC_STANDARD'))
    / nullif(sum(l.payment_amount), 0) as coverage
from public.affiliate_order_lines l
join public.shops s on s.id = l.shop_id
where l.counts_toward_gmv
group by 1, 2, 3;

alter view public.affiliate_daily set (security_invoker = on);

-- ── grants (create or replace does not preserve a prior revoke) ─────────────
do $grants$
declare fn text;
begin
  foreach fn in array array[
    'public.shop_day(timestamptz, text)',
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
  revoke all on public.affiliate_daily from anon;
  grant select on public.affiliate_daily to authenticated;
end;
$grants$;

do $verify$
declare fn text; v int; d date;
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
      raise exception '009: anon can call % after the rewrite', fn;
    end if;
    if not has_function_privilege('authenticated', fn, 'execute') then
      raise exception '009: authenticated lost access to %', fn;
    end if;
  end loop;

  -- The helper must actually shift the boundary, or nothing above changed.
  select public.shop_day('2026-08-31T03:00:00Z'::timestamptz, 'America/Los_Angeles') into d;
  if d <> date '2026-08-30' then
    raise exception '009: shop_day is not applying the timezone (got %)', d;
  end if;

  select count(*) into v from public.shops where reporting_timezone is null or reporting_timezone = '';
  if v > 0 then raise exception '009: % shops have no reporting timezone', v; end if;

  raise notice '009: revenue now buckets on the shop reporting day, not UTC';
end;
$verify$;
