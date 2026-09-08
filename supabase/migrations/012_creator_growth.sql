-- ============================================================
-- GMV Max Intelligence — 012: creators who are accelerating.
--
-- "Which creators doubled in the last 30 days but are still under $25k?" —
-- i.e. find the ones climbing fast enough to matter but small enough that
-- there is room left to grow them. That is a partner-selection question, and
-- it is asked often enough to deserve a function rather than a one-off query.
--
-- ── TWO THINGS THIS IS CAREFUL ABOUT ───────────────────────────────────────
-- A creator with no revenue in the prior window has not "doubled" — there is
-- nothing to double. Dividing by zero would either error or hand back
-- infinity, and infinity sorts to the top of every list. They are flagged
-- is_new instead, with a null multiple, so the caller decides whether a
-- first-time seller belongs in the same answer as a genuine accelerator.
--
-- And $12 growing to $30 is a 2.5x that means nothing. p_min_gmv exists so the
-- noise floor is an explicit argument rather than something the reader has to
-- notice for themselves.
--
-- Both windows use the shop's reporting timezone and are half-open on the
-- right, so they are exactly equal in length and share no day.
-- ============================================================

create or replace function public.shop_creator_growth(
  p_shop_id     uuid,
  p_end         date,
  p_window_days int     default 30,
  p_min_growth  numeric default 2.0,
  p_max_gmv     numeric default null,
  p_min_gmv     numeric default 0,
  p_include_new boolean default false,
  p_limit       int     default 100
)
returns table (
  creator_handle      text,
  recent_gmv          numeric,
  prior_gmv           numeric,
  growth_multiple     numeric,
  growth_pct          numeric,
  recent_lines        bigint,
  prior_lines         bigint,
  recent_paid_gmv     numeric,
  recent_organic_gmv  numeric,
  recent_paid_share   numeric,
  recent_videos       bigint,
  is_new              boolean
)
language plpgsql
stable
as $fn$
declare
  tz text;
  recent_lo timestamptz; recent_hi timestamptz;
  prior_lo  timestamptz; prior_hi  timestamptz;
begin
  select coalesce(nullif(reporting_timezone, ''), 'America/Los_Angeles')
    into tz from public.shops where id = p_shop_id;
  if tz is null then return; end if;

  -- recent = the p_window_days ending on p_end (inclusive)
  -- prior  = the p_window_days immediately before it, no overlap
  recent_hi := ((p_end + 1)::timestamp                     at time zone tz);
  recent_lo := ((p_end + 1 - p_window_days)::timestamp     at time zone tz);
  prior_hi  := recent_lo;
  prior_lo  := ((p_end + 1 - 2 * p_window_days)::timestamp at time zone tz);

  return query
  with recent as (
    select
      l.creator_handle as h,
      coalesce(sum(l.payment_amount), 0) as gmv,
      count(*) as lines,
      count(distinct l.content_id) as videos,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0)    as paid,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD'), 0) as organic
    from public.affiliate_order_lines l
    where l.shop_id = p_shop_id
      and l.counts_toward_gmv
      and l.creator_handle is not null
      and l.order_created_at >= recent_lo and l.order_created_at < recent_hi
    group by l.creator_handle
  ),
  prior as (
    select
      l.creator_handle as h,
      coalesce(sum(l.payment_amount), 0) as gmv,
      count(*) as lines
    from public.affiliate_order_lines l
    where l.shop_id = p_shop_id
      and l.counts_toward_gmv
      and l.creator_handle is not null
      and l.order_created_at >= prior_lo and l.order_created_at < prior_hi
    group by l.creator_handle
  )
  select
    r.h,
    r.gmv,
    coalesce(p.gmv, 0),
    -- NULL rather than infinity when there is no baseline to grow from.
    case when coalesce(p.gmv, 0) > 0 then r.gmv / p.gmv else null end,
    case when coalesce(p.gmv, 0) > 0 then (r.gmv - p.gmv) / p.gmv else null end,
    r.lines,
    coalesce(p.lines, 0),
    r.paid,
    r.organic,
    r.paid / nullif(r.paid + r.organic, 0),
    r.videos,
    coalesce(p.gmv, 0) = 0
  from recent r
  left join prior p on p.h = r.h
  where r.gmv >= coalesce(p_min_gmv, 0)
    and (p_max_gmv is null or r.gmv <= p_max_gmv)
    and (
      (coalesce(p.gmv, 0) > 0 and r.gmv / p.gmv >= coalesce(p_min_growth, 2.0))
      or (coalesce(p.gmv, 0) = 0 and coalesce(p_include_new, false))
    )
  order by r.gmv desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$fn$;

do $grants$
begin
  revoke all on function public.shop_creator_growth(uuid, date, int, numeric, numeric, numeric, boolean, int) from public;
  revoke all on function public.shop_creator_growth(uuid, date, int, numeric, numeric, numeric, boolean, int) from anon;
  grant execute on function public.shop_creator_growth(uuid, date, int, numeric, numeric, numeric, boolean, int) to authenticated;
end;
$grants$;

do $verify$
declare sid uuid; v int;
begin
  if has_function_privilege('anon',
      'public.shop_creator_growth(uuid, date, int, numeric, numeric, numeric, boolean, int)', 'execute') then
    raise exception '012: anon can call shop_creator_growth';
  end if;

  select id into sid from public.shops order by reacher_shop_id limit 1;
  if sid is not null then
    -- A growth multiple below the floor must never appear in the result.
    select count(*) into v from public.shop_creator_growth(sid, current_date - 2, 30, 2.0, null, 0, false, 500)
     where growth_multiple is not null and growth_multiple < 2.0;
    if v > 0 then raise exception '012: % rows below the growth floor leaked through', v; end if;

    -- And a creator with no prior revenue must never carry a multiple.
    select count(*) into v from public.shop_creator_growth(sid, current_date - 2, 30, 2.0, null, 0, true, 500)
     where is_new and growth_multiple is not null;
    if v > 0 then raise exception '012: % new creators were given a growth multiple', v; end if;
  end if;

  raise notice '012: creator growth ready — equal, non-overlapping windows; no baseline means no multiple';
end;
$verify$;
