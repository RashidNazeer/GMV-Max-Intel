-- ═══════════════════════════════════════════════════════════════════════════
-- GMV Max Intelligence — 029: what a campaign was doing DURING the report is a
-- different question from what it is doing now.
--
-- The review saw campaigns that are inactive today and a finding that diagnosed
-- creative deterioration over a window those campaigns may not have been
-- running in. Both cannot be assessed from gmv_max_campaigns, which holds
-- CURRENT state only. "All campaigns inactive now" does not prove they were
-- inactive throughout a historical window, and revenue falling after a known
-- pause is not evidence that the creative decayed.
--
-- HONEST ABOUT WHAT WE CANNOT KNOW. Snapshots began 2026-09-08 and Reacher
-- exposes no way to recover earlier settings, so for most windows the truthful
-- answer is `unknown`. That is a state this function RETURNS, not a gap it
-- fills. Four states:
--
--   active    every observation inside the window said ENABLE
--   paused    every observation inside the window said DISABLE
--   mixed     observations disagree, so it changed during the window
--   unknown   no observation covers the window at all
--
-- A state row covers a window when its observed span overlaps it. The span is
-- [taken_at, last_observed_at] from migration 028 — the interval over which we
-- actually confirmed the state, never extrapolated past its last confirmation.
-- A campaign observed only on 9 September tells us nothing about 2 September,
-- and this returns `unknown` for that rather than assuming the state held
-- backwards in time.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.campaign_state_in_window(
  p_shop_id uuid, p_start date, p_end date
) returns table (
  campaign_id        text,
  campaign_name      text,
  current_status     text,
  window_state       text,
  observations       integer,
  covered_from       timestamptz,
  covered_to         timestamptz,
  window_days_covered integer,
  window_days         integer
)
language sql
stable
as $fn$
  with w as (
    select
      p_start::timestamptz as lo,
      -- The window is inclusive of its last day, so it ends at the start of
      -- the day after.
      (p_end + 1)::timestamptz as hi,
      (p_end - p_start + 1)::integer as days
  ),
  -- Every observed state whose span overlaps the reporting window.
  covering as (
    select
      s.campaign_id,
      s.status,
      greatest(s.taken_at, w.lo)         as ov_from,
      least(s.last_observed_at, w.hi)    as ov_to,
      s.observations
    from public.campaign_setting_snapshots s
    cross join w
    where s.shop_id = p_shop_id
      and s.taken_at < w.hi
      and s.last_observed_at >= w.lo
  ),
  agg as (
    select
      c.campaign_id,
      count(distinct c.status)::integer as statuses,
      max(c.status) filter (where c.status is not null) as any_status,
      bool_or(c.status = 'ENABLE')  as saw_enable,
      bool_or(c.status = 'DISABLE') as saw_disable,
      sum(c.observations)::integer  as observations,
      min(c.ov_from)                as covered_from,
      max(c.ov_to)                  as covered_to
    from covering c
    group by c.campaign_id
  )
  select
    k.campaign_id,
    k.campaign_name,
    k.status as current_status,
    case
      when a.campaign_id is null then 'unknown'
      when a.saw_enable and a.saw_disable then 'mixed'
      when a.saw_enable then 'active'
      when a.saw_disable then 'paused'
      else 'unknown'
    end as window_state,
    coalesce(a.observations, 0),
    a.covered_from,
    a.covered_to,
    -- How much of the window our observations actually span. A single
    -- observation on the last day covers one day, not the whole period, and a
    -- reader deciding how much weight to give this needs to see that.
    case
      when a.covered_from is null then 0
      else greatest(0, (a.covered_to::date - a.covered_from::date) + 1)::integer
    end,
    (select days from w)
  from public.gmv_max_campaigns k
  left join agg a on a.campaign_id = k.campaign_id
  where k.shop_id = p_shop_id
  order by k.campaign_name;
$fn$;

do $g$
begin
  revoke all on function public.campaign_state_in_window(uuid, date, date) from public;
  revoke all on function public.campaign_state_in_window(uuid, date, date) from anon;
  grant execute on function public.campaign_state_in_window(uuid, date, date) to authenticated;
end;
$g$;

comment on function public.campaign_state_in_window(uuid, date, date) is
  'What each campaign was doing DURING a reporting window, as distinct from its current status. Returns active | paused | mixed | unknown; unknown is the truthful answer for any window our snapshots do not cover, and window_days_covered says how much of the window the observations actually span. Never extrapolates a state backwards past its first observation.';


-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY
-- ═══════════════════════════════════════════════════════════════════════════
do $v$
declare
  shop uuid;
  r    record;
  n_unknown integer := 0;
  n_total   integer := 0;
begin
  select id into shop from public.shops where shop_name ilike 'Biostime%' limit 1;
  if shop is null then
    raise notice '029: no Biostime shop, check skipped';
    return;
  end if;

  -- 1. The reviewed window (2-8 September) predates the first snapshot, so
  --    every campaign must come back `unknown`. If this ever returns active or
  --    paused for that period, something is extrapolating state backwards.
  for r in
    select * from public.campaign_state_in_window(shop, date '2026-09-02', date '2026-09-08')
  loop
    n_total := n_total + 1;
    if r.window_state = 'unknown' then n_unknown := n_unknown + 1; end if;
  end loop;

  raise notice '029: reviewed window 09-02..09-08 — % of % campaigns are unknown',
    n_unknown, n_total;

  -- 2. A window we DO cover must not be unknown.
  for r in
    select * from public.campaign_state_in_window(shop, current_date - 2, current_date)
  loop
    raise notice '029: %  now=%  during=%  covered % of % days (% obs)',
      coalesce(r.campaign_name, r.campaign_id), r.current_status, r.window_state,
      r.window_days_covered, r.window_days, r.observations;
    if r.window_state = 'unknown' and r.observations > 0 then
      raise exception '029: % has observations but reports unknown', r.campaign_id;
    end if;
  end loop;
end;
$v$;
