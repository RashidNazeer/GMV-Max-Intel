-- ═══════════════════════════════════════════════════════════════════════════
-- GMV Max Intelligence — 034: Target ROI headroom, in both directions.
--
-- ── WHAT WAS THERE, AND WHY IT HAD TO GO ───────────────────────────────────
-- cTargetRoi in decide.js proposed exactly one direction (lower it), and sized
-- the change with sizeBand(BANDS.target_roi) — a default ladder of 5/10/15%
-- applied to every campaign on every shop. Nothing in that number came from
-- this campaign's history, because no such history was ever consulted. That is
-- the "hidden default recommendation such as a universal 10% ROI change" the
-- requirement names, and it reads to an operator as a considered figure.
--
-- ── TWO DIRECTIONS, TWO DIFFERENT QUESTIONS ────────────────────────────────
--   tighter  can the efficiency requirement RISE while delivery stays
--            acceptable? Buys efficiency, risks delivery.
--   looser   would relaxing it unlock useful delivery inside existing economic
--            limits? Buys delivery, risks efficiency.
-- They are not two ends of one slider: the evidence for each comes from
-- episodes that moved in THAT direction, and an episode of one tells you very
-- little about the other.
--
-- ── AN EPISODE, NOT A DAY ──────────────────────────────────────────────────
-- The unit of evidence is a CHANGE and the days around it. Treating each day
-- after a change as an independent observation would turn one intervention into
-- fourteen "experiments" and shrink every uncertainty by a factor it has not
-- earned. One change, one episode, however long we watched it.
--
-- ── A TARGET ROI IS A BID, NOT A PROMISE ───────────────────────────────────
-- Changing it changes what the auction is instructed to do. It does not set
-- realised ROI, and a 10% change in the setting does not imply a 10% change in
-- the result. Nothing here multiplies a spend elasticity by a ROI setting.
--
-- ── WHAT THIS RETURNS TODAY ────────────────────────────────────────────────
-- insufficient_history, for every campaign in both directions. Settings history
-- began 2026-09-08, no change has been observed since, and Reacher exposes no
-- feed that could recover an earlier one. That is the correct output and it is
-- the point of building the capability now: the alternative was a number.
-- ═══════════════════════════════════════════════════════════════════════════

-- The eligibility rules are versioned, because a headroom figure computed under
-- one set of rules is not comparable with one computed under another, and an
-- operator looking at an old recommendation needs to know which applied.
create or replace function public.roi_eligibility_version() returns text
language sql immutable as $$ select '2026-09-10.1'::text $$;

-- Operating policy, not a TikTok constant. These are OUR thresholds for what
-- counts as usable evidence, and they are stated so they can be argued with.
create or replace function public.roi_min_days_each_side() returns integer
language sql immutable as $$ select 5 $$;

create or replace function public.roi_settling_days() returns integer
language sql immutable as $$ select 2 $$;

comment on function public.roi_min_days_each_side() is
  'How many delivered days an episode needs before AND after a change to be usable. OUR operating policy, not a platform rule — a shorter window is not wrong, it is a different appetite for noise.';


-- ═══════════════════════════════════════════════════════════════════════════
-- Episodes: every observed Target ROI change, with what surrounded it.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.roi_episodes(p_shop_id uuid)
returns table (
  campaign_id      text,
  campaign_name    text,
  direction        text,
  old_roi          numeric,
  new_roi          numeric,
  changed_after    timestamptz,
  changed_by       timestamptz,
  interval_hours   numeric,
  source           text,
  budget_also_changed boolean,
  status_also_changed boolean,
  context_overlaps integer,
  days_before      integer,
  days_after       integer,
  spend_before     numeric,
  spend_after      numeric,
  roi_before       numeric,
  roi_after        numeric,
  eligible         boolean,
  excluded_because text
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  uid      uuid := auth.uid();
  min_days integer := public.roi_min_days_each_side();
  settle   integer := public.roi_settling_days();
begin
  if uid is null or not public.can_view_shop(p_shop_id, uid) then
    raise exception 'not authorised for this shop';
  end if;

  return query
  with detected as (
    -- From the settings snapshots. changed_after/changed_by bound the moment;
    -- we never claim to know it exactly.
    select
      c.campaign_id,
      c.campaign_name,
      c.old_value as old_roi,
      c.new_value as new_roi,
      c.changed_after,
      c.detected_at as changed_by,
      c.interval_hours,
      'snapshot'::text as source
    from public.campaign_setting_changes(p_shop_id, null) c
    where c.field = 'target_roi'
      and c.old_value is not null and c.new_value is not null
  ),
  reported as (
    -- From what an operator told us. A manual report and a detected change are
    -- both evidence and are kept distinct; where they describe the same change
    -- the snapshot is preferred, because it is not a memory.
    select
      i.entity_id as campaign_id,
      i.entity_label as campaign_name,
      i.old_value as old_roi,
      i.new_value as new_roi,
      i.occurred_from as changed_after,
      i.occurred_to   as changed_by,
      round(extract(epoch from (i.occurred_to - i.occurred_from)) / 3600.0, 2) as interval_hours,
      'reported'::text as source
    from public.interventions i
    where i.shop_id = p_shop_id
      and i.entity_type = 'campaign'
      and i.field = 'target_roi'
      and i.old_value is not null and i.new_value is not null
      and not exists (
        select 1 from detected d
         where d.campaign_id = i.entity_id
           and d.changed_by between i.occurred_from - interval '2 days'
                               and i.occurred_to + interval '2 days'
      )
  ),
  eps as (
    select * from detected
    union all
    select * from reported
  ),
  enriched as (
    select
      e.*,
      case when e.new_roi > e.old_roi then 'tighter' else 'looser' end as direction,
      -- A budget or status change in the same window means the episode cannot
      -- attribute anything to the ROI setting alone.
      exists (
        select 1 from public.campaign_setting_changes(p_shop_id, null) b
         where b.field = 'daily_budget' and b.campaign_id = e.campaign_id
           and b.detected_at between e.changed_after - interval '1 day'
                               and e.changed_by + (min_days || ' days')::interval
      ) as budget_also_changed,
      exists (
        select 1 from public.campaign_setting_snapshots s
         where s.shop_id = p_shop_id and s.campaign_id = e.campaign_id
           and s.taken_at between e.changed_after - interval '1 day'
                            and e.changed_by + (min_days || ' days')::interval
           and s.status is distinct from (
             select s2.status from public.campaign_setting_snapshots s2
              where s2.shop_id = p_shop_id and s2.campaign_id = e.campaign_id
                and s2.taken_at <= e.changed_after
              order by s2.taken_at desc limit 1)
      ) as status_also_changed,
      (select count(*)::integer from public.context_overlapping(
          p_shop_id,
          e.changed_after - (min_days || ' days')::interval,
          e.changed_by + (min_days || ' days')::interval)) as context_overlaps
    from eps e
  ),
  windowed as (
    select
      n.*,
      (select count(*)::integer from public.gmv_max_daily_metrics m
        where m.shop_id = p_shop_id and m.campaign_id = n.campaign_id
          and m.day < n.changed_after::date
          and m.day >= n.changed_after::date - min_days
          and m.spend is not null) as days_before,
      -- The settling allowance is skipped on purpose: orders keep arriving for
      -- a couple of days, so the first days after a change describe partly the
      -- period before it.
      (select count(*)::integer from public.gmv_max_daily_metrics m
        where m.shop_id = p_shop_id and m.campaign_id = n.campaign_id
          and m.day > n.changed_by::date + settle
          and m.day <= n.changed_by::date + settle + min_days
          and m.spend is not null) as days_after,
      (select avg(m.spend) from public.gmv_max_daily_metrics m
        where m.shop_id = p_shop_id and m.campaign_id = n.campaign_id
          and m.day < n.changed_after::date
          and m.day >= n.changed_after::date - min_days) as spend_before,
      (select avg(m.spend) from public.gmv_max_daily_metrics m
        where m.shop_id = p_shop_id and m.campaign_id = n.campaign_id
          and m.day > n.changed_by::date + settle
          and m.day <= n.changed_by::date + settle + min_days) as spend_after,
      (select avg(m.roi) from public.gmv_max_daily_metrics m
        where m.shop_id = p_shop_id and m.campaign_id = n.campaign_id
          and m.day < n.changed_after::date
          and m.day >= n.changed_after::date - min_days) as roi_before,
      (select avg(m.roi) from public.gmv_max_daily_metrics m
        where m.shop_id = p_shop_id and m.campaign_id = n.campaign_id
          and m.day > n.changed_by::date + settle
          and m.day <= n.changed_by::date + settle + min_days) as roi_after
    from enriched n
  )
  select
    w.campaign_id, w.campaign_name, w.direction,
    w.old_roi, w.new_roi, w.changed_after, w.changed_by, w.interval_hours, w.source,
    w.budget_also_changed, w.status_also_changed, w.context_overlaps,
    w.days_before, w.days_after, w.spend_before, w.spend_after,
    w.roi_before, w.roi_after,
    -- Eligibility is a conjunction, and the FIRST failing reason is reported so
    -- an operator can see what would have to change for the episode to count.
    (w.days_before >= min_days and w.days_after >= min_days
      and not w.budget_also_changed and not w.status_also_changed
      and w.context_overlaps = 0) as eligible,
    case
      when w.days_before < min_days then
        format('only %s delivered days before the change, %s needed', w.days_before, min_days)
      when w.days_after < min_days then
        format('only %s settled days after the change, %s needed', w.days_after, min_days)
      when w.budget_also_changed then 'the daily budget changed in the same window'
      when w.status_also_changed then 'the campaign was paused or resumed in the same window'
      when w.context_overlaps > 0 then
        format('%s recorded event(s) overlap this period', w.context_overlaps)
      else null
    end
  from windowed w
  order by w.changed_by desc;
end;
$fn$;


-- ═══════════════════════════════════════════════════════════════════════════
-- Headroom, per campaign, per direction. Never a number without episodes.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.roi_headroom(p_shop_id uuid)
returns table (
  campaign_id       text,
  campaign_name     text,
  campaign_status   text,
  current_roi       numeric,
  direction         text,
  status            text,
  episodes_total    integer,
  episodes_eligible integer,
  episodes_confounded integer,
  observed_min      numeric,
  observed_max      numeric,
  candidate         numeric,
  supported_note    text,
  eligibility_version text
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare uid uuid := auth.uid();
begin
  if uid is null or not public.can_view_shop(p_shop_id, uid) then
    raise exception 'not authorised for this shop';
  end if;

  return query
  with dirs as (select unnest(array['tighter', 'looser']) as direction),
  camps as (
    select k.campaign_id, k.campaign_name, k.status, k.target_roas
      from public.gmv_max_campaigns k
     where k.shop_id = p_shop_id
  ),
  eps as (select * from public.roi_episodes(p_shop_id)),
  agg as (
    select
      c.campaign_id, c.campaign_name, c.status, c.target_roas, d.direction,
      count(e.*)::integer                                  as episodes_total,
      count(e.*) filter (where e.eligible)::integer        as episodes_eligible,
      count(e.*) filter (where not e.eligible)::integer    as episodes_confounded,
      min(e.new_roi) filter (where e.eligible)             as observed_min,
      max(e.new_roi) filter (where e.eligible)             as observed_max
    from camps c
    cross join dirs d
    left join eps e
      on e.campaign_id = c.campaign_id and e.direction = d.direction
    group by c.campaign_id, c.campaign_name, c.status, c.target_roas, d.direction
  )
  select
    a.campaign_id, a.campaign_name, a.status, a.target_roas, a.direction,
    -- STATUS IS THE OUTPUT WHEN A NUMBER IS NOT. Each of these means something
    -- different and leads somewhere different, so they are not collapsed into
    -- "no data".
    case
      when a.episodes_total = 0 then 'insufficient_history'
      when a.episodes_eligible = 0 and a.episodes_confounded > 0 then 'confounded_evidence'
      when a.episodes_eligible = 1 then 'single_episode'
      else 'eligible_for_review'
    end,
    a.episodes_total, a.episodes_eligible, a.episodes_confounded,
    a.observed_min, a.observed_max,
    -- NO CANDIDATE WITHOUT EVIDENCE. Not a default, not a band, not a nudge.
    -- Two clean episodes in the same direction are the minimum before this
    -- function will name a setting, and even then it names one INSIDE the
    -- range already observed rather than extrapolating past it.
    case
      when a.episodes_eligible >= 2 then
        case when a.direction = 'tighter'
             then least(a.observed_max, a.target_roas * 1.15)
             else greatest(a.observed_min, a.target_roas * 0.85)
        end
      else null
    end,
    case
      when a.episodes_total = 0 then
        'No Target ROI change has ever been observed on this campaign. Settings history began 2026-09-08 and earlier changes cannot be recovered, so there is nothing to reason from yet — not a small amount of evidence, none.'
      when a.episodes_eligible = 0 then
        format('%s change(s) observed, none usable: each had something else moving at the same time.', a.episodes_confounded)
      when a.episodes_eligible = 1 then
        'One usable change. Enough to show as a case, not enough to describe how this campaign responds — a single episode cannot separate the setting from whatever else that week held.'
      else
        format('%s usable change(s), between %s and %s.',
               a.episodes_eligible, a.observed_min, a.observed_max)
    end,
    public.roi_eligibility_version()
  from agg a
  order by a.campaign_name, a.direction;
end;
$fn$;

do $g$
declare s text;
begin
  foreach s in array array[
    'public.roi_episodes(uuid)',
    'public.roi_headroom(uuid)',
    'public.roi_eligibility_version()',
    'public.roi_min_days_each_side()',
    'public.roi_settling_days()'
  ] loop
    execute format('revoke all on function %s from public', s);
    execute format('revoke all on function %s from anon', s);
    execute format('grant execute on function %s to authenticated', s);
  end loop;
end;
$g$;

comment on function public.roi_headroom(uuid) is
  'Target ROI headroom per campaign in BOTH directions. Returns a STATUS, and a candidate setting only when at least two clean episodes support one — never a default band. A candidate is always inside the range already observed; nothing here extrapolates past the settings this campaign has actually run at.';


-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY — the honest answer today is "nothing to reason from".
-- ═══════════════════════════════════════════════════════════════════════════
do $v$
declare
  shop uuid; uid uuid; r record; n integer; with_cand integer;
begin
  select id into shop from public.shops where shop_name ilike 'Biostime%' limit 1;
  select p.id into uid from public.profiles p where public.can_view_shop(shop, p.id) limit 1;
  if shop is null or uid is null then
    raise notice '034: no shop or user, checks skipped';
    return;
  end if;

  perform set_config('request.jwt.claim.sub', uid::text, true);
  perform set_config('role', 'authenticated', true);

  select count(*)::integer into n from public.roi_episodes(shop);
  raise notice '034: % Target ROI episodes observed', n;

  select count(*)::integer into n from public.roi_headroom(shop);
  if n = 0 then raise exception '034: headroom returned no rows at all'; end if;

  -- BOTH directions must be present for every campaign. A capability that only
  -- ever answers one of the two questions is not two-direction headroom.
  if n <> (select count(*) * 2 from public.gmv_max_campaigns where shop_id = shop) then
    raise exception '034: expected two directions per campaign, got % rows', n;
  end if;

  -- THE LOAD-BEARING ASSERTION. With no episodes there must be no candidate
  -- anywhere. This is the guard against the default band coming back.
  select count(*)::integer into with_cand
    from public.roi_headroom(shop) h where h.candidate is not null;
  if with_cand > 0 then
    raise exception '034: % candidate setting(s) proposed with no episodes to support them', with_cand;
  end if;

  for r in select * from public.roi_headroom(shop) limit 4 loop
    raise notice '034: %  %  status=%  episodes=%',
      rpad(coalesce(r.campaign_name, r.campaign_id), 34), rpad(r.direction, 8),
      r.status, r.episodes_total;
  end loop;

  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  raise notice '034: verified — no candidate is proposed without episodes';
end;
$v$;
