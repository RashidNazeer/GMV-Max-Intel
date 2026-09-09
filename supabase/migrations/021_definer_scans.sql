-- ============================================================
-- GMV Max Intelligence — 021: time it as the role that actually calls it.
--
-- ── THE MEASUREMENT THAT MATTERS ───────────────────────────────────────────
-- shop_creative_health, same shop, same window, same result (550 videos,
-- 142 declining):
--
--     service_role                   250 ms
--     authenticated + real JWT     3,577 ms      <- 14x
--
-- The browser was getting 57014 "canceling statement due to statement timeout".
-- Migration 020 timed it at 54 ms and passed, because that verify block runs as
-- the migration owner — which bypasses RLS entirely. The row-level predicate on
-- affiliate_order_lines is re-evaluated per row for `authenticated`, and that
-- is the whole difference.
--
-- I have now walked into this project's own documented trap twice in one day.
-- Migration 010's header says it plainly: "a verification run with different
-- privileges from the real caller is not a verification of the real caller."
-- The first repeat was three full scans; this is the deeper one, because even
-- a single fast scan is slow when every row must re-check who may see it.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- Both heavy readers become SECURITY DEFINER with an EXPLICIT access check as
-- their first statement. The boundary is not weakened — it moves from a
-- per-row predicate to one check per call, which is where it belongs for an
-- aggregate over one shop.
--
-- Three rules this codebase has already paid for, applied here:
--   * `set search_path = public` — a definer function without it is a
--     search-path hijack waiting to happen.
--   * The check uses auth.uid(), never pg_has_role(current_user, ...) —
--     inside a definer function current_user is the OWNER, which made five
--     guards inert once before.
--   * Supabase grants anon EXECUTE on every new function, and `revoke from
--     public` does NOT undo it. anon is revoked BY NAME below.
--
-- And the verification at the bottom now times as `authenticated` with real
-- JWT claims, because that is the only measurement that means anything.
-- ============================================================

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
  p_ids     text[] default null,
  p_scope   text   default 'report'
)
returns table (
  video_id text, creator_handle text, title text, tiktok_url text,
  posted_date timestamptz, age_days integer, lines bigint, orders bigint,
  gmv numeric, paid_gmv numeric, organic_gmv numeric, paid_share numeric,
  gmv_share numeric, recent_gmv numeric, prior_gmv numeric, trend_pct numeric,
  has_baseline boolean, status text, views bigint,
  in_report boolean, first_sale_day date, total_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  w record;
  diag_lo timestamptz;
  r7      timestamptz;
  scan_lo timestamptz;
begin
  -- ONE access check, at the boundary, instead of one per scanned row.
  if not public.can_view_shop(p_shop_id, auth.uid()) then
    raise exception 'not authorised for this shop' using errcode = '42501';
  end if;

  select * into w from public.shop_window(p_shop_id, p_start, p_end);
  diag_lo := ((p_end - (public.diagnostic_days() - 1))::timestamp at time zone w.tz);
  r7      := ((p_end - 6)::timestamp at time zone w.tz);
  scan_lo := least(w.lo, diag_lo);

  return query
  with lines as (
    select
      l.content_id as vid,
      max(l.creator_handle) as creator_handle,
      count(*) filter (where l.order_created_at >= w.lo)                            as lines,
      count(distinct l.order_id) filter (where l.order_created_at >= w.lo)          as orders,
      coalesce(sum(l.payment_amount) filter (where l.order_created_at >= w.lo), 0)  as gmv,
      coalesce(sum(l.payment_amount) filter (
        where l.order_created_at >= w.lo and l.classification = 'PAID_SHOP_ADS'), 0)    as paid_gmv,
      coalesce(sum(l.payment_amount) filter (
        where l.order_created_at >= w.lo and l.classification = 'ORGANIC_STANDARD'), 0) as organic_gmv,
      count(*) filter (where l.order_created_at >= w.lo) > 0                        as in_report,
      coalesce(sum(l.payment_amount) filter (where l.order_created_at >= r7), 0)    as recent_gmv,
      coalesce(sum(l.payment_amount) filter (
        where l.order_created_at >= diag_lo and l.order_created_at < r7), 0)        as prior_gmv
    from public.affiliate_order_lines l
    where l.shop_id = p_shop_id
      and l.counts_toward_gmv
      and l.content_id is not null
      and l.content_type = 'Video'
      and l.order_created_at >= scan_lo
      and l.order_created_at <  w.hi
    group by l.content_id
  ),
  tot as (select nullif(sum(x.gmv), 0) as gmv from lines x where x.in_report),
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
      case when x.prior_gmv > 0 then (x.recent_gmv - x.prior_gmv) / x.prior_gmv
           else null end as trend_pct,
      (x.prior_gmv > 0) as has_baseline,
      x.in_report,
      (select min(public.shop_day(e.order_created_at, w.tz))
         from public.affiliate_order_lines e
        where e.shop_id = p_shop_id and e.counts_toward_gmv
          and e.content_type = 'Video' and e.content_id = x.vid
          and e.order_created_at < w.hi) as first_sale_day,
      v.views
    from lines x cross join tot
    left join public.video_latest v on v.shop_id = p_shop_id and v.video_id = x.vid
  ),
  classified as (
    select e.*,
      case
        when e.first_sale_day is not null and e.first_sale_day > p_end - 7 then 'new'
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
      and (
        lower(coalesce(p_scope, 'report')) = 'all'
        or p_ids is not null
        or (p_status is not null and p_status <> '')
        or c.in_report
      )
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
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if not public.can_view_shop(p_shop_id, auth.uid()) then
    raise exception 'not authorised for this shop' using errcode = '42501';
  end if;

  return query
  with v as (
    select * from public.shop_top_videos(
      p_shop_id, p_start, p_end, 20000, 0, null, null, 'gmv', 'desc', null, 'all')
  ),
  rep as (select * from v where v.in_report),
  ranked as (select rep.*, row_number() over (order by rep.gmv desc) as rn from rep),
  tot as (
    select count(*)::bigint as video_count,
           count(distinct rep.creator_handle)::bigint as creators,
           coalesce(sum(rep.gmv), 0) as gmv
    from rep
  )
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
    (select count(*)                from rep where rep.status = 'winner'),
    (select count(*)                from rep where rep.status = 'candidate'),
    (select count(*)                from rep where rep.status = 'no_baseline'),
    (select count(*)                from rep where rep.status = 'new'),
    true,
    (select count(*) filter (where rep.has_baseline)::numeric / nullif(count(*), 0) from rep),
    (p_end - (public.diagnostic_days() - 1)), p_end,
    (p_end - (public.diagnostic_days() - 1)), (p_end - 7),
    (select count(*) from v where v.status in ('declining', 'fatigue_risk') and not v.in_report),
    (select coalesce(sum(rep.gmv), 0) from rep
      where rep.posted_date is not null and (p_end - (rep.posted_date at time zone 'UTC')::date) <= 30),
    (select coalesce(sum(rep.gmv), 0) from rep where rep.posted_date is not null) / nullif(tot.gmv, 0),
    tot.creators,
    true
  from tot;
end;
$fn$;


-- Supabase grants anon EXECUTE on every new function, and `revoke from public`
-- does NOT undo it. These are SECURITY DEFINER now, so anon must be revoked BY
-- NAME or an unauthenticated caller reaches shop data with the owner's rights.
do $g$
declare f text;
begin
  foreach f in array array[
    'public.shop_top_videos(uuid,date,date,int,int,text,text,text,text,text[],text)',
    'public.shop_creative_health(uuid,date,date)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$g$;


-- ── verification, AS THE ROLE THAT ACTUALLY CALLS IT ───────────────────────
do $verify$
declare
  s record; uid uuid; ms numeric; t0 timestamptz; n bigint;
  budget_ms constant numeric := 1500;
  denied boolean;
begin
  select id into uid from public.profiles where role = 'boss' and is_active limit 1;
  if uid is null then
    raise exception '021: no active boss to impersonate — cannot verify as the real caller';
  end if;

  for s in select id, shop_name from public.shops loop
    -- Impersonate authenticated WITH claims. Timing as the owner is what let a
    -- 3.6-second query ship as "54ms".
    set local role authenticated;
    perform set_config('request.jwt.claims',
      json_build_object('sub', uid, 'role', 'authenticated')::text, true);

    t0 := clock_timestamp();
    select video_count into n from public.shop_creative_health(s.id, current_date - 31, current_date - 2);
    ms := extract(milliseconds from clock_timestamp() - t0);

    reset role;
    perform set_config('request.jwt.claims', null, true);

    if ms > budget_ms then
      raise exception '021: shop_creative_health took %ms for % AS AUTHENTICATED — over the %ms budget',
        round(ms), s.shop_name, budget_ms;
    end if;
    raise notice '021: % — % videos in %ms as authenticated', s.shop_name, coalesce(n, 0), round(ms);
  end loop;

  -- The definer boundary must still refuse a shop the caller cannot see.
  denied := false;
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims',
      json_build_object('sub', '00000000-0000-0000-0000-000000000000', 'role', 'authenticated')::text, true);
    perform public.shop_creative_health(
      (select id from public.shops limit 1), current_date - 8, current_date - 2);
  exception when others then
    denied := true;
  end;
  reset role;
  perform set_config('request.jwt.claims', null, true);

  if not denied then
    raise exception '021: SECURITY DEFINER function did NOT refuse an unauthorised caller';
  end if;

  raise notice '021: applied — definer scans, access checked once, unauthorised caller refused';
end;
$verify$;
