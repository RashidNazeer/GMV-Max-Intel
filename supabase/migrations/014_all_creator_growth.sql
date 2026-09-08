-- ============================================================
-- GMV Max Intelligence — 014: creator growth across every shop at once.
--
-- shop_creator_growth answers "who is accelerating for Cutler". This answers
-- "who is accelerating for us", which is the question when you are choosing
-- who to invest attention in rather than who to invite to one product.
--
-- ── WHY IT SUMS RATHER THAN CONCATENATES ───────────────────────────────────
-- A creator can sell for more than one shop. Measured 2026-09-08: zero creators
-- appear in both Cutler's and Biostime's top 200 over 90 days, so today this
-- behaves like a simple union. But that is a fact about the current data, not a
-- property of the model — the moment one creator sells for two shops, listing
-- them twice at half their real size would rank them wrongly and quietly.
-- So GMV is summed per creator and the shops they sell for are named.
--
-- Each shop keeps its OWN reporting timezone: the window boundaries are
-- computed per shop, not once globally. A US shop and a UK shop do not share a
-- midnight, and pretending they do would shift revenue between periods.
--
-- SECURITY INVOKER (the default) means RLS still applies — an ads_manager
-- calling this sees only creators from shops they have access to.
-- ============================================================

create or replace function public.all_creator_growth(
  p_end         date,
  p_window_days int     default 30,
  p_min_growth  numeric default 2.0,
  p_max_gmv     numeric default null,
  p_min_gmv     numeric default 0,
  p_include_new boolean default false,
  p_limit       int     default 200
)
returns table (
  creator_handle     text,
  shops              text,
  shop_count         integer,
  recent_gmv         numeric,
  prior_gmv          numeric,
  growth_multiple    numeric,
  growth_pct         numeric,
  recent_lines       bigint,
  recent_videos      bigint,
  recent_paid_gmv    numeric,
  recent_organic_gmv numeric,
  recent_paid_share  numeric,
  is_new             boolean
)
language sql
stable
as $$
  with bounds as (
    -- Per-shop window edges, in that shop's own reporting timezone.
    select
      s.id,
      s.shop_name,
      ((p_end + 1)::timestamp                     at time zone coalesce(nullif(s.reporting_timezone, ''), 'America/Los_Angeles')) as recent_hi,
      ((p_end + 1 - p_window_days)::timestamp     at time zone coalesce(nullif(s.reporting_timezone, ''), 'America/Los_Angeles')) as recent_lo,
      ((p_end + 1 - 2 * p_window_days)::timestamp at time zone coalesce(nullif(s.reporting_timezone, ''), 'America/Los_Angeles')) as prior_lo
    from public.shops s
  ),
  recent as (
    select
      l.creator_handle                                                                    as h,
      b.shop_name,
      coalesce(sum(l.payment_amount), 0)                                                  as gmv,
      count(*)                                                                            as lines,
      count(distinct l.content_id)                                                        as videos,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0)    as paid,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD'), 0) as organic
    from public.affiliate_order_lines l
    join bounds b on b.id = l.shop_id
    where l.counts_toward_gmv
      and l.creator_handle is not null
      and l.order_created_at >= b.recent_lo
      and l.order_created_at <  b.recent_hi
    group by l.creator_handle, b.shop_name
  ),
  recent_all as (
    select
      h,
      string_agg(distinct shop_name, ', ' order by shop_name) as shops,
      count(distinct shop_name)::int                          as shop_count,
      sum(gmv)     as gmv,
      sum(lines)   as lines,
      sum(videos)  as videos,
      sum(paid)    as paid,
      sum(organic) as organic
    from recent group by h
  ),
  prior_all as (
    select l.creator_handle as h, coalesce(sum(l.payment_amount), 0) as gmv
    from public.affiliate_order_lines l
    join bounds b on b.id = l.shop_id
    where l.counts_toward_gmv
      and l.creator_handle is not null
      and l.order_created_at >= b.prior_lo
      and l.order_created_at <  b.recent_lo
    group by l.creator_handle
  )
  select
    r.h,
    r.shops,
    r.shop_count,
    r.gmv,
    coalesce(p.gmv, 0),
    case when coalesce(p.gmv, 0) > 0 then r.gmv / p.gmv else null end,
    case when coalesce(p.gmv, 0) > 0 then (r.gmv - p.gmv) / p.gmv else null end,
    r.lines,
    r.videos,
    r.paid,
    r.organic,
    r.paid / nullif(r.paid + r.organic, 0),
    coalesce(p.gmv, 0) = 0
  from recent_all r
  left join prior_all p on p.h = r.h
  where r.gmv >= coalesce(p_min_gmv, 0)
    and (p_max_gmv is null or r.gmv <= p_max_gmv)
    and (
      (coalesce(p.gmv, 0) > 0 and r.gmv / p.gmv >= coalesce(p_min_growth, 2.0))
      or (coalesce(p.gmv, 0) = 0 and coalesce(p_include_new, false))
    )
  order by r.gmv desc
  limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;

do $grants$
begin
  revoke all on function public.all_creator_growth(date, int, numeric, numeric, numeric, boolean, int) from public;
  revoke all on function public.all_creator_growth(date, int, numeric, numeric, numeric, boolean, int) from anon;
  grant execute on function public.all_creator_growth(date, int, numeric, numeric, numeric, boolean, int) to authenticated;
end;
$grants$;

do $verify$
declare v int;
begin
  if has_function_privilege('anon',
      'public.all_creator_growth(date, int, numeric, numeric, numeric, boolean, int)', 'execute') then
    raise exception '014: anon can call all_creator_growth';
  end if;

  -- Nothing below the growth floor may appear.
  select count(*) into v from public.all_creator_growth(current_date - 2, 30, 2.0, null, 0, false, 1000)
   where growth_multiple is not null and growth_multiple < 2.0;
  if v > 0 then raise exception '014: % rows below the growth floor leaked through', v; end if;

  -- A creator must appear at most once, however many shops they sell for.
  select count(*) into v from (
    select creator_handle from public.all_creator_growth(current_date - 2, 30, 1.0, null, 0, true, 1000)
    group by creator_handle having count(*) > 1
  ) d;
  if v > 0 then raise exception '014: % creators returned more than once', v; end if;

  raise notice '014: cross-shop creator growth ready — summed per creator, per-shop timezones';
end;
$verify$;
