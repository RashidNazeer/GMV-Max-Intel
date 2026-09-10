-- ═══════════════════════════════════════════════════════════════════════════
-- GMV Max Intelligence — 037: keep the source, and keep what it used to say.
--
-- ── TWO GAPS THIS CLOSES ───────────────────────────────────────────────────
--
-- 1. RAW IS NOT SEPARATED FROM DERIVED. Several tables carry a `raw` jsonb
--    column beside the normalised columns computed from it. That is better than
--    discarding the payload, but the two live and die together: re-running a
--    sync overwrites both, so the evidence for yesterday's classification is
--    replaced by the evidence for today's. A raw record has to outlive the fact
--    derived from it or it cannot settle an argument about that fact.
--
-- 2. LATE DATA OVERWRITES SILENTLY. TikTok keeps settling orders for days after
--    they are placed, and refunds and cancellations restate figures that have
--    already been reported. Every sync upserts, so a restatement replaces the
--    number with no trace that it moved. That makes two things impossible:
--    telling a genuine change in performance from a correction to the record,
--    and answering "what did we know when we recommended this?"
--
-- ── AS-OF REPRODUCIBILITY ──────────────────────────────────────────────────
-- A recommendation already freezes its evidence in recommendations.evidence,
-- and nothing may edit it. Revisions complete the picture from the other side:
-- with both, the tool can show what it believed at the time AND what the
-- corrected record says now, and never has to pretend those are the same thing.
--
-- ── WHAT IS DELIBERATELY NOT DONE ──────────────────────────────────────────
-- No new storage platform. This is two ordinary tables in the database that is
-- already here. Raw payloads are stored with a CONTENT HASH and deduplicated on
-- it, so re-fetching an unchanged page adds no row — the alternative is a table
-- that grows with our polling schedule rather than with the client's business,
-- which is the same mistake migration 028 fixed for snapshots.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.source_payloads (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references public.shops(id) on delete cascade,

  -- WHERE IT CAME FROM. provider and endpoint together identify the shape;
  -- schema_version lets a later reader know which shape they are looking at
  -- without inferring it from the keys present.
  provider       text not null,
  endpoint       text not null,
  schema_version text,

  -- WHAT IT IS ABOUT. entity_type/entity_id are nullable because a shop-level
  -- payload is about no single entity.
  entity_type    text,
  -- NOT NULL with an empty default so the uniqueness constraint below needs no
  -- coalesce(). An expression is not allowed in a table-level UNIQUE, and an
  -- expression index would then be a fragile ON CONFLICT target — this project
  -- has already lost a feature to a unique index that could not be inferred.
  entity_id      text not null default '',

  -- THREE DIFFERENT TIMES, none of which is a substitute for another:
  --   fetched_at     when WE asked
  --   source_time    when the SOURCE says the event happened, if it says
  --   reporting_date the day the payload is ABOUT
  fetched_at     timestamptz not null default now(),
  source_time    timestamptz,
  reporting_date date,

  -- The payload, and its identity. content_hash is over the payload only, so
  -- the same page fetched twice is one row however often we poll.
  payload        jsonb not null,
  content_hash   text not null,
  row_count      integer,

  created_at     timestamptz not null default now(),

  -- One row per distinct payload per endpoint per day. Re-fetching identical
  -- data does not accumulate.
  constraint source_payload_identity
    unique (shop_id, provider, endpoint, entity_id, content_hash)
);

create index if not exists source_payloads_lookup_idx
  on public.source_payloads (shop_id, provider, endpoint, reporting_date desc);
create index if not exists source_payloads_fetched_idx
  on public.source_payloads (shop_id, fetched_at desc);

comment on table public.source_payloads is
  'Raw provider payloads, kept SEPARATE from the facts derived from them so a re-sync cannot replace the evidence for an earlier classification. Deduplicated on a content hash: re-fetching unchanged data adds no row, so the table grows with the client business rather than with our polling schedule.';


-- ── revisions: what a number USED to say ───────────────────────────────────
create table if not exists public.fact_revisions (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references public.shops(id) on delete cascade,
  table_name     text not null,
  entity_id      text,
  reporting_date date,
  field          text not null,
  old_value      numeric,
  new_value      numeric,
  -- delta is stored rather than computed on read so a query for "material
  -- restatements" does not have to re-derive it across every row.
  delta          numeric,
  revised_at     timestamptz not null default now(),
  reason         text
);

create index if not exists fact_revisions_lookup_idx
  on public.fact_revisions (shop_id, table_name, reporting_date desc);
create index if not exists fact_revisions_time_idx
  on public.fact_revisions (shop_id, revised_at desc);

comment on table public.fact_revisions is
  'What a reported number used to say, captured when a late settlement or correction restates it. Without this a restatement is indistinguishable from a change in performance, and "what did we know when we recommended this?" has no answer.';


-- ── the trigger that captures a restatement ────────────────────────────────
-- Fires only on a MATERIAL change to a money or volume field. An update that
-- rewrites synced_at, or nudges a figure by a rounding cent, is not a
-- restatement and recording it would bury the real ones.
create or replace function public.capture_gmv_max_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  -- A cent is not a restatement. Below this the row is unchanged for every
  -- purpose a human has.
  eps constant numeric := 0.01;
begin
  if new.spend is distinct from old.spend
     and abs(coalesce(new.spend, 0) - coalesce(old.spend, 0)) > eps then
    insert into public.fact_revisions
      (shop_id, table_name, entity_id, reporting_date, field, old_value, new_value, delta, reason)
    values (old.shop_id, 'gmv_max_daily_metrics', old.campaign_id, old.day, 'spend',
            old.spend, new.spend, coalesce(new.spend, 0) - coalesce(old.spend, 0),
            'restated by a later sync');
  end if;

  if new.revenue is distinct from old.revenue
     and abs(coalesce(new.revenue, 0) - coalesce(old.revenue, 0)) > eps then
    insert into public.fact_revisions
      (shop_id, table_name, entity_id, reporting_date, field, old_value, new_value, delta, reason)
    values (old.shop_id, 'gmv_max_daily_metrics', old.campaign_id, old.day, 'revenue',
            old.revenue, new.revenue, coalesce(new.revenue, 0) - coalesce(old.revenue, 0),
            'restated by a later sync');
  end if;

  return new;
end;
$fn$;

drop trigger if exists gmv_max_capture_revision on public.gmv_max_daily_metrics;
create trigger gmv_max_capture_revision
  before update on public.gmv_max_daily_metrics
  for each row
  execute function public.capture_gmv_max_revision();


create or replace function public.capture_channel_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare eps constant numeric := 0.01;
begin
  if new.gmv is distinct from old.gmv
     and abs(coalesce(new.gmv, 0) - coalesce(old.gmv, 0)) > eps then
    insert into public.fact_revisions
      (shop_id, table_name, entity_id, reporting_date, field, old_value, new_value, delta, reason)
    values (old.shop_id, 'shop_daily_channels', null, old.day, 'gmv',
            old.gmv, new.gmv, coalesce(new.gmv, 0) - coalesce(old.gmv, 0),
            'restated by a later sync');
  end if;
  return new;
end;
$fn$;

drop trigger if exists channels_capture_revision on public.shop_daily_channels;
create trigger channels_capture_revision
  before update on public.shop_daily_channels
  for each row
  execute function public.capture_channel_revision();


-- ── recording a payload ────────────────────────────────────────────────────
create or replace function public.record_source_payload(
  p_shop_id        uuid,
  p_provider       text,
  p_endpoint       text,
  p_payload        jsonb,
  p_entity_type    text default null,
  p_entity_id      text default null,
  p_reporting_date date default null,
  p_source_time    timestamptz default null,
  p_schema_version text default null,
  p_row_count      integer default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_hash text;
  v_id   uuid;
begin
  -- md5 over the canonical text form. Not cryptographic and does not need to
  -- be: this identifies a payload we have already stored, it does not defend
  -- against anyone.
  v_hash := md5(p_payload::text);

  insert into public.source_payloads (
    shop_id, provider, endpoint, schema_version, entity_type, entity_id,
    source_time, reporting_date, payload, content_hash, row_count
  ) values (
    p_shop_id, p_provider, p_endpoint, p_schema_version, p_entity_type, coalesce(p_entity_id, ''),
    p_source_time, p_reporting_date, p_payload, v_hash, p_row_count
  )
  on conflict on constraint source_payload_identity do nothing
  returning id into v_id;

  -- Already held. Returning the existing id keeps the caller's code simple and
  -- makes the dedup visible rather than looking like a failed insert.
  if v_id is null then
    select id into v_id from public.source_payloads
     where shop_id = p_shop_id and provider = p_provider and endpoint = p_endpoint
       and entity_id = coalesce(p_entity_id, '')
       and content_hash = v_hash
     limit 1;
  end if;

  return v_id;
end;
$fn$;


-- ── as-of: what we knew then, beside what the record says now ──────────────
create or replace function public.recommendation_as_of(p_recommendation_id uuid)
returns table (
  recommendation_id  uuid,
  issued_at          timestamptz,
  window_start       date,
  window_end         date,
  evidence_frozen    jsonb,
  revisions_since    integer,
  revised_net        numeric,
  restated_fields    text[],
  note               text
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  r   public.recommendations%rowtype;
  uid uuid := auth.uid();
begin
  select * into r from public.recommendations where id = p_recommendation_id;
  if not found then raise exception 'no such recommendation'; end if;
  if uid is null or not public.can_view_shop(r.shop_id, uid) then
    raise exception 'not authorised for this shop';
  end if;

  return query
  with rev as (
    select * from public.fact_revisions v
     where v.shop_id = r.shop_id
       and v.revised_at > r.generated_at
       and (v.reporting_date is null
            or v.reporting_date between r.window_start and r.window_end)
  )
  select
    r.id, r.generated_at, r.window_start, r.window_end,
    -- IMMUTABLE. This is what the tool actually reasoned from, and it is
    -- returned unchanged however much the underlying data has since moved.
    r.evidence,
    (select count(*)::integer from rev),
    (select coalesce(sum(v.delta), 0) from rev v),
    (select coalesce(array_agg(distinct v.field), '{}') from rev v),
    case
      when (select count(*) from rev) = 0 then
        'No figure inside this recommendation''s window has been restated since it was issued, so what it reasoned from still matches the record.'
      else
        format('%s figure(s) inside this window have been restated since this was issued, a net %s. The evidence above is what the tool actually saw; it has NOT been updated, because a recommendation judged against corrected data it never had is judged unfairly.',
               (select count(*) from rev),
               round((select coalesce(sum(v.delta), 0) from rev v), 2))
    end;
end;
$fn$;


alter table public.source_payloads enable row level security;
alter table public.fact_revisions  enable row level security;

drop policy if exists source_payloads_select on public.source_payloads;
create policy source_payloads_select on public.source_payloads for select
  using (public.can_view_shop(shop_id, auth.uid()));

drop policy if exists fact_revisions_select on public.fact_revisions;
create policy fact_revisions_select on public.fact_revisions for select
  using (public.can_view_shop(shop_id, auth.uid()));

-- No client INSERT/UPDATE/DELETE policy on either. Payloads are written by the
-- sync through the service role, revisions only by the triggers. A raw archive
-- a client can edit is not an archive.

do $g$
declare s text;
begin
  foreach s in array array[
    'public.record_source_payload(uuid, text, text, jsonb, text, text, date, timestamptz, text, integer)',
    'public.recommendation_as_of(uuid)'
  ] loop
    execute format('revoke all on function %s from public', s);
    execute format('revoke all on function %s from anon', s);
  end loop;
  execute 'grant execute on function public.record_source_payload(uuid, text, text, jsonb, text, text, date, timestamptz, text, integer) to service_role';
  execute 'grant execute on function public.recommendation_as_of(uuid) to authenticated';
end;
$g$;


-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY
-- ═══════════════════════════════════════════════════════════════════════════
do $v$
declare
  shop uuid; uid uuid; camp text; d date;
  p1 uuid; p2 uuid; n integer; before_n integer;
  spend_was numeric; rec uuid; asof record;
begin
  select id into shop from public.shops where shop_name ilike 'Biostime%' limit 1;
  select p.id into uid from public.profiles p where public.can_view_shop(shop, p.id) limit 1;
  if shop is null or uid is null then
    raise notice '037: no shop or user, checks skipped';
    return;
  end if;

  -- 1. The same payload twice is ONE row.
  p1 := public.record_source_payload(shop, 'reacher', '/verify-037',
          jsonb_build_object('a', 1, 'b', 2), null, 'TEST-037', current_date);
  p2 := public.record_source_payload(shop, 'reacher', '/verify-037',
          jsonb_build_object('a', 1, 'b', 2), null, 'TEST-037', current_date);
  if p1 is null or p1 <> p2 then
    raise exception '037: an identical payload was stored twice (% vs %)', p1, p2;
  end if;
  select count(*)::integer into n from public.source_payloads where entity_id = 'TEST-037';
  if n <> 1 then raise exception '037: expected 1 payload row, found %', n; end if;

  -- A DIFFERENT payload is a new row.
  p2 := public.record_source_payload(shop, 'reacher', '/verify-037',
          jsonb_build_object('a', 1, 'b', 3), null, 'TEST-037', current_date);
  if p2 = p1 then raise exception '037: a changed payload reused the old row'; end if;
  raise notice '037: payload dedup works — identical stored once, changed stored again';

  -- 2. A restatement is captured; a rounding nudge is not.
  select campaign_id, day, spend into camp, d, spend_was
    from public.gmv_max_daily_metrics
   where shop_id = shop and spend is not null
   order by day desc limit 1;

  if camp is null then
    raise notice '037: no campaign metrics to test revision capture';
  else
    select count(*)::integer into before_n from public.fact_revisions where shop_id = shop;

    -- Sub-cent: must NOT be recorded.
    update public.gmv_max_daily_metrics set spend = spend_was + 0.005
     where shop_id = shop and campaign_id = camp and day = d;
    select count(*)::integer into n from public.fact_revisions where shop_id = shop;
    if n <> before_n then
      raise exception '037: a sub-cent change was recorded as a restatement';
    end if;

    -- Material: MUST be recorded.
    update public.gmv_max_daily_metrics set spend = spend_was + 25
     where shop_id = shop and campaign_id = camp and day = d;
    select count(*)::integer into n from public.fact_revisions where shop_id = shop;
    if n <> before_n + 1 then
      raise exception '037: a material restatement was not captured (% vs %)', n, before_n;
    end if;
    raise notice '037: restatement captured, sub-cent noise ignored';

    -- Put it back exactly as it was. This is a verification, not a data change.
    update public.gmv_max_daily_metrics set spend = spend_was
     where shop_id = shop and campaign_id = camp and day = d;
    delete from public.fact_revisions
     where shop_id = shop and table_name = 'gmv_max_daily_metrics'
       and entity_id = camp and reporting_date = d
       and revised_at > now() - interval '1 minute';
  end if;

  -- 3. As-of returns the FROZEN evidence.
  select id into rec from public.recommendations where shop_id = shop order by generated_at desc limit 1;
  if rec is not null then
    perform set_config('request.jwt.claim.sub', uid::text, true);
    perform set_config('role', 'authenticated', true);
    select * into asof from public.recommendation_as_of(rec);
    if asof.evidence_frozen is null then
      raise notice '037: that recommendation carries no evidence snapshot';
    else
      raise notice '037: as-of works — % revision(s) since it was issued', asof.revisions_since;
    end if;
    execute 'reset role';
    perform set_config('request.jwt.claim.sub', '', true);
  end if;

  delete from public.source_payloads where entity_id = 'TEST-037';
  raise notice '037: verified';
end;
$v$;
