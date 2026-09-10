-- ═══════════════════════════════════════════════════════════════════════════
-- GMV Max Intelligence — 035: a descriptive organic baseline that says what it is.
--
-- ── WHAT WAS THERE ─────────────────────────────────────────────────────────
-- One comparison: this window against the window immediately before it. That is
-- a legitimate method, and it was never named as one. An adjacent period is
-- vulnerable to exactly the things that make a week odd — a promotion, a
-- stockout, a bank holiday — and a reader cannot allow for that without being
-- told which method produced the number.
--
-- ── THREE METHODS, EACH STATED ─────────────────────────────────────────────
--   adjacent  the window immediately before. Closest in time, most exposed to
--             one odd week.
--   rolling   the MEDIAN of several recent comparable windows. Robust to a
--             single strange period; slower to notice a real turn.
--   seasonal  the same window a year ago. Needs history this shop does not have
--             and returns no_history until it does.
--
-- ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
-- It is DESCRIPTIVE. It says what organic revenue did in comparable past
-- periods. It does NOT say what organic revenue would have been without the
-- advertising — that is a counterfactual, it requires an identification
-- strategy this data cannot support, and organic_counterfactual() returns
-- not_estimable rather than dressing the observed total up as one.
--
-- ── A MISSING PRIOR IS NOT A 100% DECLINE ──────────────────────────────────
-- Every status below exists so that an absent, zero or under-covered baseline
-- comes back as a named state instead of a percentage. "Down 100%" against a
-- baseline that never existed is the single most misleading number this page
-- could print.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.organic_baseline_version() returns text
language sql immutable as $$ select '2026-09-10.1'::text $$;

-- A period must be this complete to be comparable. A window missing a third of
-- its days is a smaller number for a reason that has nothing to do with demand.
create or replace function public.organic_min_coverage() returns numeric
language sql immutable as $$ select 0.80::numeric $$;

create or replace function public.organic_baseline(
  p_shop_id uuid,
  p_start   date,
  p_end     date,
  p_method  text default 'rolling',
  p_lookback integer default 4
) returns table (
  method            text,
  status            text,
  current_value     numeric,
  baseline_value    numeric,
  change_pct        numeric,
  periods_considered integer,
  periods_eligible  integer,
  period_days       integer,
  earliest_used     date,
  latest_used       date,
  coverage_note     text,
  method_note       text,
  version           text
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  uid       uuid := auth.uid();
  span      integer := (p_end - p_start) + 1;
  min_cov   numeric := public.organic_min_coverage();
  n_periods integer;
begin
  if uid is null or not public.can_view_shop(p_shop_id, uid) then
    raise exception 'not authorised for this shop';
  end if;

  n_periods := case when p_method = 'adjacent' then 1
                    when p_method = 'seasonal' then 1
                    else greatest(1, least(coalesce(p_lookback, 4), 12)) end;

  return query
  with cur as (
    select
      coalesce(sum(d.measured_organic_gmv), 0) as value,
      count(*)::integer                        as days
    from public.shop_channel_daily(p_shop_id, p_start, p_end) d
  ),
  -- The candidate comparison windows, each the same LENGTH as the reporting
  -- window so a 7-day report is never compared with a 30-day total.
  periods as (
    select
      g.i,
      case when p_method = 'seasonal'
           then p_start - 365
           else p_start - (span * g.i)
      end as ps,
      case when p_method = 'seasonal'
           then p_end - 365
           else p_end - (span * g.i)
      end as pe
    from generate_series(1, n_periods) as g(i)
  ),
  measured as (
    select
      p.i, p.ps, p.pe,
      coalesce(sum(d.measured_organic_gmv), 0) as value,
      count(*)::integer                        as days
    from periods p
    left join lateral public.shop_channel_daily(p_shop_id, p.ps, p.pe) d on true
    group by p.i, p.ps, p.pe
  ),
  eligible as (
    -- A period counts only when enough of its days actually arrived. Days we
    -- never collected are not zero-revenue days.
    select * from measured m
     where m.days::numeric / nullif(span, 0) >= min_cov
  ),
  base as (
    select
      -- MEDIAN, not mean, for the rolling method: one viral week should not
      -- drag the reference it is being judged against.
      -- CAST: percentile_cont returns double precision, and round(double,
      -- int) does not exist in Postgres. Money arithmetic stays numeric here
      -- for the same reason it does everywhere else in this schema.
      case when p_method = 'rolling'
           then (percentile_cont(0.5) within group (order by e.value))::numeric
           else max(e.value)::numeric
      end as value,
      count(*)::integer as n_eligible,
      min(e.ps) as earliest,
      max(e.pe) as latest
    from eligible e
  )
  select
    p_method,
    case
      when (select n_eligible from base) = 0 then 'no_history'
      when (select value from base) is null then 'no_history'
      -- A genuine zero is a real state and is NOT a 100% decline. It means
      -- there was no organic revenue to compare against, which is a fact about
      -- the past, not a collapse in the present.
      when (select value from base) = 0 then 'zero_baseline'
      else 'ok'
    end,
    (select value from cur),
    (select value from base),
    case
      when (select value from base) is null or (select value from base) = 0 then null
      else round(((select value from cur) - (select value from base))
                 / (select value from base), 4)
    end,
    n_periods,
    coalesce((select n_eligible from base), 0),
    span,
    (select earliest from base),
    (select latest from base),
    case
      when (select n_eligible from base) = 0 then
        format('No comparable %s-day period has at least %s%% of its days collected.',
               span, round(min_cov * 100))
      when (select n_eligible from base) < n_periods then
        format('%s of %s candidate periods had enough coverage to use; the rest are short of days and were excluded rather than counted as low revenue.',
               (select n_eligible from base), n_periods)
      else format('All %s candidate periods had enough coverage.', n_periods)
    end,
    case p_method
      when 'adjacent' then 'The window immediately before this one. Closest in time, and the most exposed to a single odd week.'
      when 'seasonal' then 'The same dates last year. Controls for calendar effects, and needs a year of history to exist.'
      else format('The median of the last %s comparable %s-day windows. Robust to one strange period, slower to notice a real turn.',
                  n_periods, span)
    end,
    public.organic_baseline_version()
  from cur;
end;
$fn$;


-- ═══════════════════════════════════════════════════════════════════════════
-- The counterfactual, kept as a SEPARATE capability that answers honestly.
--
-- "What would organic demand have been without the advertising?" is a different
-- question from "what has organic demand been". Answering it needs an
-- identification strategy — an experiment, a holdout, a natural break in spend
-- with nothing else moving. We have none, and the tempting substitutes are all
-- wrong in the same way:
--
--   * calling the observed organic total the counterfactual assumes ads caused
--     none of it, which is the thing under test;
--   * extrapolating the spend-response curve to zero spend runs a model far
--     outside the range it was fitted on and calls the result evidence.
--
-- So this returns not_estimable, and says what would change that.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.organic_counterfactual(
  p_shop_id uuid, p_start date, p_end date
) returns table (
  status          text,
  value           numeric,
  reason          text,
  what_would_help text
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  uid        uuid := auth.uid();
  zero_days  integer;
  spend_days integer;
begin
  if uid is null or not public.can_view_shop(p_shop_id, uid) then
    raise exception 'not authorised for this shop';
  end if;

  -- A genuine break in spend is the one thing that could support this without
  -- an experiment, so it is worth counting rather than assuming absent.
  select count(*) filter (where coalesce(m.spend, 0) = 0),
         count(*)
    into zero_days, spend_days
    from public.gmv_max_daily_metrics m
   where m.shop_id = p_shop_id
     and m.day between p_start - 90 and p_end;

  return query
  select
    'not_estimable'::text,
    null::numeric,
    'No advertising holdout, experiment or clean break in spend exists for this shop, so what organic demand would have been without the ads cannot be separated from what it was with them.'::text,
    case
      when zero_days >= 7 then
        format('There are %s zero-spend days in the last 90. If nothing else changed across them they could support a comparison — record what else was happening in those periods and it becomes assessable.', zero_days)
      else
        'A deliberate holdout, or a period with advertising off and nothing else changing, would make this estimable. Recording promotions, stockouts and price changes as they happen is what makes such a period usable later.'
    end::text;
end;
$fn$;

do $g$
declare s text;
begin
  foreach s in array array[
    'public.organic_baseline(uuid, date, date, text, integer)',
    'public.organic_counterfactual(uuid, date, date)',
    'public.organic_baseline_version()',
    'public.organic_min_coverage()'
  ] loop
    execute format('revoke all on function %s from public', s);
    execute format('revoke all on function %s from anon', s);
    execute format('grant execute on function %s to authenticated', s);
  end loop;
end;
$g$;

comment on function public.organic_baseline(uuid, date, date, text, integer) is
  'A DESCRIPTIVE organic baseline that names its own method (adjacent | rolling | seasonal), the periods it used and the coverage it required. Never returns a percentage against an absent or zero baseline — those come back as no_history and zero_baseline, because "down 100%" against a baseline that never existed is the most misleading number this page could print.';

comment on function public.organic_counterfactual(uuid, date, date) is
  'What organic demand WOULD have been without advertising. Returns not_estimable: no holdout or experiment exists, and both tempting substitutes are wrong — calling the observed organic total the counterfactual assumes ads caused none of it, and extrapolating the spend curve to zero runs the model far outside its fitted range.';


-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY
-- ═══════════════════════════════════════════════════════════════════════════
do $v$
declare
  shop uuid; uid uuid; r record; cf record;
begin
  select id into shop from public.shops where shop_name ilike 'Biostime%' limit 1;
  select p.id into uid from public.profiles p where public.can_view_shop(shop, p.id) limit 1;
  if shop is null or uid is null then
    raise notice '035: no shop or user, checks skipped';
    return;
  end if;

  perform set_config('request.jwt.claim.sub', uid::text, true);
  perform set_config('role', 'authenticated', true);

  for r in
    select * from public.organic_baseline(shop, current_date - 9, current_date - 3, 'rolling', 4)
  loop
    raise notice '035: rolling  status=%  current=%  baseline=%  eligible=%/%',
      r.status, round(coalesce(r.current_value, 0), 2), round(coalesce(r.baseline_value, 0), 2),
      r.periods_eligible, r.periods_considered;
    raise notice '035:   %', r.coverage_note;
  end loop;

  for r in
    select * from public.organic_baseline(shop, current_date - 9, current_date - 3, 'adjacent', 1)
  loop
    raise notice '035: adjacent status=%  baseline=%', r.status, round(coalesce(r.baseline_value, 0), 2);
  end loop;

  -- Seasonal needs a year of history this shop does not have. It must say so
  -- rather than compare against nothing.
  for r in
    select * from public.organic_baseline(shop, current_date - 9, current_date - 3, 'seasonal', 1)
  loop
    if r.status <> 'no_history' then
      raise exception '035: seasonal claimed % with no year of history', r.status;
    end if;
    raise notice '035: seasonal correctly reports no_history';
  end loop;

  -- THE LOAD-BEARING ASSERTION. A missing baseline must never produce a
  -- percentage.
  for r in
    select * from public.organic_baseline(shop, current_date - 9, current_date - 3, 'seasonal', 1)
  loop
    if r.change_pct is not null then
      raise exception '035: a change percentage was computed against a missing baseline';
    end if;
  end loop;

  select * into cf from public.organic_counterfactual(shop, current_date - 9, current_date - 3);
  if cf.status <> 'not_estimable' or cf.value is not null then
    raise exception '035: the counterfactual returned a value it cannot support';
  end if;
  raise notice '035: counterfactual correctly not_estimable';

  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
end;
$v$;
