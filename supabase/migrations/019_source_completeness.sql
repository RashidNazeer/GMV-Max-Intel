-- ============================================================
-- GMV Max Intelligence — 019: a healthy job is not a complete report.
--
-- ── THE DEFECT ─────────────────────────────────────────────────────────────
-- Data status labelled GMV Max campaigns "Healthy" while its coverage ended
-- 5 September and the selected report ended 7 September. Affiliate and funnel
-- coverage ended the 6th. Meanwhile shop channel mix showed a FAILED run with
-- zero rows — and the Overview still displayed a populated Shop GMV from the
-- records an earlier successful run had already stored.
--
-- Both readings were wrong in opposite directions:
--   * a successful LATEST JOB was presented as a complete selected window;
--   * a failed LATEST JOB read as though the stored history had evaporated.
--
-- These are five different facts and the product was carrying two:
--     1. what the latest attempt did
--     2. when the latest SUCCESS was
--     3. how far the stored data actually reaches
--     4. which days of the SELECTED window are missing
--     5. whether a particular recommendation can still be made
--
-- This function returns all five per source, so a screen can say
-- "Spend available through Sep 5; report ends Sep 7" instead of "Healthy".
-- ============================================================

create or replace function public.shop_source_health(p_shop_id uuid, p_start date, p_end date)
returns table (
  source            text,
  label             text,
  purpose           text,
  latest_attempt_at timestamptz,
  latest_attempt_status text,
  latest_success_at timestamptz,
  coverage_start    date,
  coverage_end      date,
  window_days       integer,
  covered_days      integer,
  missing_days      integer,
  missing_from      date,
  complete          boolean,
  stale_days        integer,
  has_stored_data   boolean,
  state             text     -- complete | incomplete | stale | failing | absent
)
language sql stable as $$
  with want as (
    select generate_series(p_start, p_end, interval '1 day')::date as day
  ),
  -- One row per source describing what it feeds and where its records live.
  cov as (
    select 'affiliate_transactions'::text as source,
           'Affiliate order lines'::text  as label,
           'The commission evidence behind every paid/organic split.'::text as purpose,
           min(public.shop_day(l.order_created_at, coalesce(nullif(s.reporting_timezone,''), 'America/Los_Angeles'))) as cov_start,
           max(public.shop_day(l.order_created_at, coalesce(nullif(s.reporting_timezone,''), 'America/Los_Angeles'))) as cov_end,
           count(distinct public.shop_day(l.order_created_at, coalesce(nullif(s.reporting_timezone,''), 'America/Los_Angeles')))
             filter (where public.shop_day(l.order_created_at, coalesce(nullif(s.reporting_timezone,''), 'America/Los_Angeles')) between p_start and p_end) as covered
    from public.shops s
    left join public.affiliate_order_lines l on l.shop_id = s.id and l.counts_toward_gmv
    where s.id = p_shop_id
    group by s.id

    union all
    select 'shop_channels', 'Shop channel mix',
           'Seller Center''s own daily split of the whole shop.',
           min(c.day), max(c.day),
           count(*) filter (where c.day between p_start and p_end)
    from public.shop_daily_channels c where c.shop_id = p_shop_id

    union all
    select 'product_metrics', 'Seller Center funnel',
           'Impressions, clicks and conversion, one row per product per day.',
           min(d.day), max(d.day),
           count(distinct d.day) filter (where d.day between p_start and p_end)
    from public.product_daily_metrics d where d.shop_id = p_shop_id

    union all
    select 'gmv_max', 'GMV Max campaigns',
           'Spend, budgets and Target ROI.',
           min(g.day), max(g.day),
           count(distinct g.day) filter (where g.day between p_start and p_end)
    from public.gmv_max_daily_metrics g where g.shop_id = p_shop_id
  ),
  runs as (
    -- The latest ATTEMPT and the latest SUCCESS are different events, and the
    -- product needs both. Reading only the first is what turned one failed run
    -- into "all data is gone".
    select r.job,
           max(r.started_at)                                    as latest_attempt,
           (array_agg(r.status order by r.started_at desc))[1]  as latest_status,
           max(r.started_at) filter (where r.status = 'ok')     as latest_success
    from public.sync_runs r
    where r.shop_id = p_shop_id
    group by r.job
  ),
  j as (
    select
      cov.source, cov.label, cov.purpose,
      runs.latest_attempt, runs.latest_status, runs.latest_success,
      cov.cov_start, cov.cov_end,
      (select count(*) from want)::int as window_days,
      coalesce(cov.covered, 0)::int    as covered,
      cov.cov_end is not null          as has_data
    from cov
    left join runs on runs.job = cov.source
  )
  select
    j.source, j.label, j.purpose,
    j.latest_attempt, j.latest_status, j.latest_success,
    j.cov_start, j.cov_end,
    j.window_days, j.covered,
    greatest(j.window_days - j.covered, 0),
    -- The first day of the selected window this source does not reach.
    case when j.cov_end is null then p_start
         when j.cov_end < p_end then (j.cov_end + 1)
         else null end,
    (j.covered >= j.window_days),
    case when j.cov_end is null then null else (p_end - j.cov_end) end,
    j.has_data,
    case
      when not j.has_data                                   then 'absent'
      when j.latest_status is distinct from 'ok'
       and j.latest_status is not null                      then 'failing'
      when j.covered >= j.window_days                       then 'complete'
      when j.cov_end < p_end                                then 'stale'
      else 'incomplete'
    end
  from j
  order by j.source;
$$;

comment on function public.shop_source_health(uuid, date, date) is
  'Five separate facts per source: latest attempt, latest success, actual stored coverage, missing days in the SELECTED window, and whether records exist at all. A healthy job never implies a complete report, and a failed job never implies the stored history vanished.';

do $g$
begin
  execute 'revoke all on function public.shop_source_health(uuid,date,date) from public';
  execute 'revoke all on function public.shop_source_health(uuid,date,date) from anon';
  execute 'grant execute on function public.shop_source_health(uuid,date,date) to authenticated';
  execute 'grant execute on function public.shop_source_health(uuid,date,date) to service_role';
end;
$g$;

do $verify$
declare s record; r record; n int;
begin
  for s in select id, shop_name from public.shops loop
    n := 0;
    for r in select * from public.shop_source_health(s.id, current_date - 8, current_date - 2) loop
      n := n + 1;
      -- A source can never be both complete and missing days.
      if r.complete and r.missing_days > 0 then
        raise exception '019: % / % claims complete with % missing days',
          s.shop_name, r.source, r.missing_days;
      end if;
      -- Nor absent while holding stored records.
      if r.state = 'absent' and r.has_stored_data then
        raise exception '019: % / % says absent but has stored data', s.shop_name, r.source;
      end if;
      raise notice '019: % / % — % · coverage to % · % of % days · %',
        s.shop_name, r.source, coalesce(r.latest_attempt_status, 'never run'),
        coalesce(r.coverage_end::text, 'none'), r.covered_days, r.window_days, r.state;
    end loop;
    if n <> 4 then
      raise exception '019: % returned % sources, expected 4', s.shop_name, n;
    end if;
  end loop;
  raise notice '019: applied';
end;
$verify$;
