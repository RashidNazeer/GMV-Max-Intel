-- ═══════════════════════════════════════════════════════════════════════════
-- GMV Max Intelligence — 028: snapshots record STATES, not fetches.
--
-- THE DEFECT. campaign_setting_snapshots is keyed (shop_id, campaign_id,
-- taken_at) where taken_at is the time the sync RAN. So every run appended a
-- row whether or not anything had changed. Two runs on 9 September produced
-- EIGHT rows for four campaigns, all with identical settings. The table was
-- recording our own polling schedule, and campaign_setting_changes() then
-- diffed consecutive rows that could never differ.
--
-- Two things follow, and both were visible in the review:
--   * "Inspected campaign history contained no recorded tests." Correct, and it
--     would have stayed correct forever: a change can only appear as a diff
--     between two rows, and the rows were duplicates.
--   * The job was not idempotent. Re-running a sync, or two runs overlapping,
--     silently multiplied the history.
--
-- THE MODEL. One row per EFFECTIVE STATE, not per observation:
--   taken_at         the first time we saw this exact state   (unchanged as PK)
--   last_observed_at the last time we confirmed it still held      (new)
--   observations     how many times we confirmed it                (new)
--
-- Re-observing an unchanged campaign extends last_observed_at. A changed
-- campaign opens a new row. The change therefore happened somewhere inside
--     (previous row's last_observed_at, new row's taken_at]
-- and that interval is what we report. We do NOT invent an exact change time,
-- which is what "preserve that interval rather than inventing its exact time"
-- asks for.
--
-- WHAT THIS DOES NOT DO. It does not reconstruct history. Reacher exposes no
-- change feed and no settings endpoint that returns values, so nothing before
-- the first snapshot can be recovered. Collapsing duplicates loses no evidence
-- because duplicate rows carried none: every one of them asserted the same
-- state, and that assertion survives in last_observed_at and observations.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.campaign_setting_snapshots
  add column if not exists last_observed_at timestamptz,
  add column if not exists observations     integer not null default 1;

update public.campaign_setting_snapshots
   set last_observed_at = taken_at
 where last_observed_at is null;

alter table public.campaign_setting_snapshots
  alter column last_observed_at set not null;


-- ── collapse the duplicates that already exist ─────────────────────────────
-- Gaps and islands: consecutive rows for one campaign that assert the same
-- state become one row spanning from the first observation to the last.
do $collapse$
declare
  before_n integer;
  after_n  integer;
begin
  select count(*) into before_n from public.campaign_setting_snapshots;

  create temporary table _islands on commit drop as
  with s as (
    select
      shop_id, campaign_id, taken_at,
      row_number() over (partition by shop_id, campaign_id order by taken_at) as rn,
      row_number() over (
        partition by shop_id, campaign_id, campaign_name, status,
                     target_roas, daily_budget, campaign_type, currency
        order by taken_at) as rn_state
    from public.campaign_setting_snapshots
  )
  select shop_id, campaign_id,
         min(taken_at) as keep_at,
         max(taken_at) as last_at,
         count(*)::integer as n
    from (select s.*, s.rn - s.rn_state as island from s) g
   group by shop_id, campaign_id, island;

  -- The survivor carries the whole island's span.
  update public.campaign_setting_snapshots c
     set last_observed_at = i.last_at,
         observations     = i.n
    from _islands i
   where c.shop_id = i.shop_id
     and c.campaign_id = i.campaign_id
     and c.taken_at = i.keep_at;

  -- Everything else in the island asserted exactly the same state.
  delete from public.campaign_setting_snapshots c
   using _islands i
   where c.shop_id = i.shop_id
     and c.campaign_id = i.campaign_id
     and c.taken_at > i.keep_at
     and c.taken_at <= i.last_at;

  select count(*) into after_n from public.campaign_setting_snapshots;
  raise notice '028: snapshots collapsed % -> % rows', before_n, after_n;
end;
$collapse$;


-- ── the only supported way to record one ───────────────────────────────────
-- SECURITY DEFINER so the sync can write without a table grant, and so the
-- read-compare-write happens under a row lock: two overlapping sync runs cannot
-- both decide they are the first to see a new state.
create or replace function public.record_campaign_snapshot(
  p_shop_id       uuid,
  p_campaign_id   text,
  p_campaign_name text,
  p_status        text,
  p_target_roas   numeric,
  p_daily_budget  numeric,
  p_campaign_type text,
  p_currency      text,
  p_data_source   text,
  p_raw           jsonb default null
) returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  cur     public.campaign_setting_snapshots%rowtype;
  had_row boolean := false;
  v_now   timestamptz := now();
begin
  if not exists (select 1 from public.shops s where s.id = p_shop_id) then
    raise exception 'unknown shop %', p_shop_id;
  end if;

  -- The most recent state for this campaign, locked so a concurrent run waits
  -- rather than racing us to open a second row for the same change.
  select * into cur
    from public.campaign_setting_snapshots c
   where c.shop_id = p_shop_id and c.campaign_id = p_campaign_id
   order by c.taken_at desc
   limit 1
     for update;

  had_row := found;

  if had_row
     and cur.campaign_name is not distinct from p_campaign_name
     and cur.status        is not distinct from p_status
     and cur.target_roas   is not distinct from p_target_roas
     and cur.daily_budget  is not distinct from p_daily_budget
     and cur.campaign_type is not distinct from p_campaign_type
     and cur.currency      is not distinct from p_currency
  then
    -- Same state. This is a CONFIRMATION, not a new fact.
    update public.campaign_setting_snapshots
       set last_observed_at = greatest(last_observed_at, v_now),
           observations     = observations + 1,
           raw              = coalesce(p_raw, raw)
     where shop_id = p_shop_id
       and campaign_id = p_campaign_id
       and taken_at = cur.taken_at;
    return 'confirmed';
  end if;

  insert into public.campaign_setting_snapshots
    (shop_id, campaign_id, taken_at, last_observed_at, observations,
     campaign_name, status, target_roas, daily_budget, campaign_type,
     currency, data_source, raw)
  values
    (p_shop_id, p_campaign_id, v_now, v_now, 1,
     p_campaign_name, p_status, p_target_roas, p_daily_budget, p_campaign_type,
     p_currency, coalesce(p_data_source, 'reacher'), p_raw);

  return case when had_row then 'changed' else 'opened' end;
end;
$fn$;

-- Supabase grants anon EXECUTE on every new function; `revoke from public`
-- does not undo a grant made to anon by name.
revoke all on function public.record_campaign_snapshot(uuid, text, text, text, numeric, numeric, text, text, text, jsonb) from public;
revoke all on function public.record_campaign_snapshot(uuid, text, text, text, numeric, numeric, text, text, text, jsonb) from anon;
grant execute on function public.record_campaign_snapshot(uuid, text, text, text, numeric, numeric, text, text, text, jsonb) to service_role;

comment on function public.record_campaign_snapshot(uuid, text, text, text, numeric, numeric, text, text, text, jsonb) is
  'The only supported way to record a campaign settings observation. Idempotent: an unchanged campaign extends last_observed_at instead of appending a row. Returns confirmed | changed | opened.';


-- ── changes now carry the interval they actually happened in ───────────────
-- detected_at is KEPT (two pages and one SQL consumer read it) and still means
-- "the first time we saw the new value". changed_after is new: the last time
-- the OLD value was confirmed. The change happened between the two. Reporting
-- detected_at alone implied we knew when someone made the change; we do not.
drop function if exists public.campaign_setting_changes(uuid, timestamptz);

create or replace function public.campaign_setting_changes(p_shop_id uuid, p_since timestamptz default null)
returns table (
  campaign_id text, campaign_name text, field text,
  old_value numeric, new_value numeric,
  detected_at timestamptz, previous_at timestamptz,
  changed_after timestamptz, interval_hours numeric
)
language sql stable as $chg$
  with s as (
    select
      c.campaign_id, c.campaign_name, c.taken_at, c.target_roas, c.daily_budget,
      lag(c.taken_at)         over w as prev_at,
      lag(c.last_observed_at) over w as prev_last_seen,
      lag(c.target_roas)      over w as prev_roas,
      lag(c.daily_budget)     over w as prev_budget
    from public.campaign_setting_snapshots c
    where c.shop_id = p_shop_id
      and (p_since is null or c.taken_at >= p_since)
    window w as (partition by c.shop_id, c.campaign_id order by c.taken_at)
  ),
  chg as (
    select s.campaign_id, s.campaign_name, 'target_roi' as field,
           s.prev_roas as old_value, s.target_roas as new_value,
           s.taken_at as detected_at, s.prev_at as previous_at,
           s.prev_last_seen as changed_after
      from s where s.prev_at is not null and s.target_roas is distinct from s.prev_roas
    union all
    select s.campaign_id, s.campaign_name, 'daily_budget',
           s.prev_budget, s.daily_budget,
           s.taken_at, s.prev_at, s.prev_last_seen
      from s where s.prev_at is not null and s.daily_budget is distinct from s.prev_budget
  )
  select chg.campaign_id, chg.campaign_name, chg.field,
         chg.old_value, chg.new_value,
         chg.detected_at, chg.previous_at, chg.changed_after,
         round(extract(epoch from (chg.detected_at - chg.changed_after)) / 3600.0, 2)
    from chg
   order by chg.detected_at desc;
$chg$;

do $g$
begin
  revoke all on function public.campaign_setting_changes(uuid, timestamptz) from public;
  revoke all on function public.campaign_setting_changes(uuid, timestamptz) from anon;
  grant execute on function public.campaign_setting_changes(uuid, timestamptz) to authenticated;
end;
$g$;

comment on function public.campaign_setting_changes(uuid, timestamptz) is
  'Detected settings changes. detected_at is when the NEW value was first seen; changed_after is when the OLD value was last confirmed. The change happened between them, and interval_hours is that width. Distinct from a buyer REPORTING a change, which lands in recommendations.applied_value.';

comment on table public.campaign_setting_snapshots is
  'One row per EFFECTIVE campaign state, started 2026-09-08. taken_at is the first observation of that state and last_observed_at the most recent confirmation of it; re-observing an unchanged campaign extends the row rather than appending one. Reacher exposes no change feed, so nothing before the first row can be recovered and its absence is a real state, not a gap to fill.';


-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY
-- ═══════════════════════════════════════════════════════════════════════════
do $v$
declare
  dupes    integer;
  shop     uuid;
  camp     text;
  r1 text; r2 text;
  n_before integer; n_after integer;
  last1 timestamptz; last2 timestamptz;
begin
  -- 1. No campaign may hold two consecutive rows asserting the same state.
  select count(*) into dupes from (
    select 1 from (
      select shop_id, campaign_id, status, target_roas, daily_budget,
             lag(status)       over w as p_status,
             lag(target_roas)  over w as p_roas,
             lag(daily_budget) over w as p_budget
        from public.campaign_setting_snapshots
        window w as (partition by shop_id, campaign_id order by taken_at)
    ) t
    where t.p_status is not distinct from t.status
      and t.p_roas   is not distinct from t.target_roas
      and t.p_budget is not distinct from t.daily_budget
      and t.p_status is not null
  ) x;
  if dupes > 0 then
    raise exception '028: % consecutive duplicate states survived the collapse', dupes;
  end if;

  select id into shop from public.shops where shop_name ilike 'Biostime%' limit 1;
  if shop is null then
    raise notice '028: no Biostime shop — idempotency check skipped';
    return;
  end if;

  select campaign_id into camp from public.campaign_setting_snapshots
   where shop_id = shop order by taken_at desc limit 1;
  if camp is null then
    raise notice '028: no snapshots for Biostime — idempotency check skipped';
    return;
  end if;

  select count(*) into n_before from public.campaign_setting_snapshots where shop_id = shop;
  select last_observed_at into last1 from public.campaign_setting_snapshots
   where shop_id = shop and campaign_id = camp order by taken_at desc limit 1;

  -- 2. Recording the CURRENT state twice must add no rows.
  select public.record_campaign_snapshot(shop, camp, c.campaign_name, c.status,
           c.target_roas, c.daily_budget, c.campaign_type, c.currency, 'reacher', null)
    into r1
    from public.campaign_setting_snapshots c
   where c.shop_id = shop and c.campaign_id = camp
   order by c.taken_at desc limit 1;

  select public.record_campaign_snapshot(shop, camp, c.campaign_name, c.status,
           c.target_roas, c.daily_budget, c.campaign_type, c.currency, 'reacher', null)
    into r2
    from public.campaign_setting_snapshots c
   where c.shop_id = shop and c.campaign_id = camp
   order by c.taken_at desc limit 1;

  select count(*) into n_after from public.campaign_setting_snapshots where shop_id = shop;
  select last_observed_at into last2 from public.campaign_setting_snapshots
   where shop_id = shop and campaign_id = camp order by taken_at desc limit 1;

  if r1 <> 'confirmed' or r2 <> 'confirmed' then
    raise exception '028: re-recording an unchanged state returned % / %, expected confirmed', r1, r2;
  end if;
  if n_after <> n_before then
    raise exception '028: idempotency failed, % rows became %', n_before, n_after;
  end if;
  if last2 <= last1 then
    raise exception '028: last_observed_at did not advance on confirmation';
  end if;

  raise notice '028: % rows for Biostime, unchanged across two re-records', n_after;
  raise notice '028: idempotency verified without writing a false change';
end;
$v$;
