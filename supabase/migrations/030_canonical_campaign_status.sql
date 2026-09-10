-- ═══════════════════════════════════════════════════════════════════════════
-- GMV Max Intelligence — 030: one vocabulary for campaign status.
--
-- THE DEFECT, and it is the one the review actually saw. Reacher answers the
-- same question in two vocabularies depending on which endpoint is asked:
--
--   GET /gmv-max/campaigns          ->  ENABLE  / DISABLE
--   the per-campaign settings call  ->  enabled / disabled
--
-- normalizeCampaign preferred the settings value, so the manual sync stored
-- lowercase while the scheduled sync and the snapshot writer stored uppercase.
-- Everything downstream compared against the literal 'ENABLE'. The result:
-- every REAL campaign was classified inactive, and the only row that ever
-- matched was the SIMULATED one on Cutler.
--
-- That single mismatch produced BOTH of the review's observations at once:
--   "All four campaign records appeared inactive."
--   "Budget utilisation said no budget on file despite configured budgets."
-- The budgets were on file. One campaign (Fruity Bites, 550/day, target ROAS
-- 1.5) had been running the whole time.
--
-- It also threatened migration 028: a snapshot recorded as ENABLE one day and
-- enabled the next differs, so the diff would have opened a new state row and
-- reported a campaign change that never happened.
--
-- THE FIX is canonicalisation at every boundary — src/lib/campaignStatus.js on
-- the way in, this migration for rows already stored. No CHECK constraint is
-- added: the provider is free to invent a new spelling, and the correct
-- response to that is an unrecognised status surfaced as itself, not a failed
-- ingest that loses the day's data.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.canonical_campaign_status(p_raw text)
returns text
language sql
immutable
as $fn$
  select case lower(trim(p_raw))
    when 'enable'  then 'ENABLE'
    when 'enabled' then 'ENABLE'
    when 'active'  then 'ENABLE'
    when 'delivery_ok' then 'ENABLE'
    when 'status_delivery_ok' then 'ENABLE'
    when 'disable'  then 'DISABLE'
    when 'disabled' then 'DISABLE'
    when 'paused'   then 'DISABLE'
    when 'inactive' then 'DISABLE'
    when 'status_disable' then 'DISABLE'
    when 'delete'  then 'DELETE'
    when 'deleted' then 'DELETE'
    when 'removed' then 'DELETE'
    when 'status_delete' then 'DELETE'
    -- Unrecognised spellings are preserved verbatim. Guessing that an unknown
    -- status means "running" is how a paused campaign gets a budget increase.
    else nullif(trim(p_raw), '')
  end;
$fn$;

comment on function public.canonical_campaign_status(text) is
  'Map any provider spelling of campaign status to ENABLE | DISABLE | DELETE. Unrecognised values are returned unchanged and are NOT active. Mirrors src/lib/campaignStatus.js — change both together.';


-- ── backfill what is already stored ────────────────────────────────────────
do $backfill$
declare
  n_camp integer;
  n_snap integer;
  dupes  integer;
begin
  update public.gmv_max_campaigns
     set status = public.canonical_campaign_status(status)
   where status is distinct from public.canonical_campaign_status(status);
  get diagnostics n_camp = row_count;

  update public.campaign_setting_snapshots
     set status = public.canonical_campaign_status(status)
   where status is distinct from public.canonical_campaign_status(status);
  get diagnostics n_snap = row_count;

  raise notice '030: canonicalised % campaign rows and % snapshot rows', n_camp, n_snap;

  -- Canonicalising can make two consecutive snapshot states identical (one
  -- written as ENABLE, the next as enabled). That pair was never a change, so
  -- it must not survive as two rows -- migration 028's invariant.
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
    raise notice '030: % consecutive duplicate states appeared after canonicalising, collapsing', dupes;

    create temporary table _dup_islands on commit drop as
    with s as (
      select shop_id, campaign_id, taken_at,
             row_number() over (partition by shop_id, campaign_id order by taken_at) as rn,
             row_number() over (
               partition by shop_id, campaign_id, campaign_name, status,
                            target_roas, daily_budget, campaign_type, currency
               order by taken_at) as rn_state
        from public.campaign_setting_snapshots
    )
    select shop_id, campaign_id, min(taken_at) as keep_at,
           max(taken_at) as last_at, count(*)::integer as n
      from (select s.*, s.rn - s.rn_state as island from s) g
     group by shop_id, campaign_id, island;

    update public.campaign_setting_snapshots c
       set last_observed_at = greatest(c.last_observed_at, i.last_at),
           observations = i.n
      from _dup_islands i
     where c.shop_id = i.shop_id and c.campaign_id = i.campaign_id
       and c.taken_at = i.keep_at;

    delete from public.campaign_setting_snapshots c
     using _dup_islands i
     where c.shop_id = i.shop_id and c.campaign_id = i.campaign_id
       and c.taken_at > i.keep_at and c.taken_at <= i.last_at;
  end if;
end;
$backfill$;


-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY
-- ═══════════════════════════════════════════════════════════════════════════
do $v$
declare
  bad     integer;
  active  integer;
  budget  numeric;
  r       record;
begin
  -- 1. Nothing may still be stored in a non-canonical spelling we recognise.
  select count(*) into bad
    from public.gmv_max_campaigns
   where status is distinct from public.canonical_campaign_status(status);
  if bad > 0 then
    raise exception '030: % campaign rows still hold a non-canonical status', bad;
  end if;

  select count(*) into bad
    from public.campaign_setting_snapshots
   where status is distinct from public.canonical_campaign_status(status);
  if bad > 0 then
    raise exception '030: % snapshot rows still hold a non-canonical status', bad;
  end if;

  -- 2. The function itself.
  if public.canonical_campaign_status('enabled') <> 'ENABLE'
     or public.canonical_campaign_status('ENABLE') <> 'ENABLE'
     or public.canonical_campaign_status('disabled') <> 'DISABLE'
     or public.canonical_campaign_status('  Enabled ') <> 'ENABLE' then
    raise exception '030: canonicalisation is wrong';
  end if;
  if public.canonical_campaign_status('SOMETHING_NEW') <> 'SOMETHING_NEW' then
    raise exception '030: an unrecognised status must be preserved verbatim';
  end if;
  if public.canonical_campaign_status(null) is not null
     or public.canonical_campaign_status('  ') is not null then
    raise exception '030: empty status must be null';
  end if;

  -- 3. THE POINT OF ALL THIS. Biostime must now show a live campaign and a
  --    real active budget, which is what the review said it did not.
  for r in select s.shop_name, s.id from public.shops s order by s.shop_name loop
    select count(*), coalesce(sum(daily_budget), 0)
      into active, budget
      from public.gmv_max_campaigns
     where shop_id = r.id and status = 'ENABLE';
    raise notice '030: %  active campaigns=%  active daily budget=%',
      rpad(r.shop_name, 18), active, budget;
  end loop;
end;
$v$;
