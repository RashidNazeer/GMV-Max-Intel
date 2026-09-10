-- ═══════════════════════════════════════════════════════════════════════════
-- GMV Max Intelligence — 031: what actually changed, and what else was going on.
--
-- Four records with distinct meanings, which a single status field was
-- collapsing into one:
--
--   RECOMMENDATION   what the system suggested        (recommendations)
--   HUMAN DECISION   accept / modify / reject / defer (recommendations.decision)
--   INTERVENTION     what actually changed            (this migration)
--   OUTCOME REVIEW   what happened afterwards         (migration 032)
--
-- A planned or accepted recommendation is NOT an intervention. Until now the
-- only trace of a real change was recommendations.applied_value, which cannot
-- express a change made outside a recommendation, cannot record who made it or
-- when, and cannot hold a reversal.
--
-- ── THE SYSTEM MUST LEARN FROM WHAT HAPPENED, NOT ONLY FROM ITS OWN ADVICE ──
-- recommendation_id is NULLABLE on purpose. Buyers change budgets for reasons
-- that never passed through this tool, and those changes are exactly the
-- evidence a response model needs. Refusing to record them would leave the
-- history describing only the subset we happened to suggest.
--
-- ── TRUTHFUL LOGGING BEATS POLICY ENFORCEMENT ──────────────────────────────
-- policy_exception exists so an operator can record an action WurxOS would
-- have BLOCKED recommending. Preventing history capture because someone acted
-- outside a guardrail does not un-make the action; it just means the outcome
-- arrives unexplained. The exception is flagged, and evidence drawn from those
-- episodes carries the flag with it.
--
-- ── TIME IS OFTEN AN INTERVAL, NOT AN INSTANT ──────────────────────────────
-- A snapshot-detected change is bounded by two observations and its exact
-- moment is unknowable. occurred_from / occurred_to carry that interval
-- honestly. A manual report can give an instant, and then both columns hold it.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.interventions (
  id                uuid primary key default gen_random_uuid(),
  shop_id           uuid not null references public.shops(id) on delete cascade,

  -- WHAT CHANGED. entity_type is open text rather than an enum because the next
  -- thing an operator changes is not necessarily one we anticipated, and a
  -- failed insert loses the record entirely.
  entity_type       text not null check (entity_type in ('campaign', 'creative', 'product', 'shop')),
  entity_id         text not null,
  entity_label      text,
  field             text not null,
  old_value         numeric,
  new_value         numeric,
  old_value_text    text,
  new_value_text    text,
  value_unit        text,

  -- WHEN. An interval, because a detected change only ever has one.
  occurred_from     timestamptz not null,
  occurred_to       timestamptz not null,
  time_basis        text not null default 'interval'
                      check (time_basis in ('exact', 'interval')),

  -- WHO AND WHY.
  actor             uuid references auth.users(id) on delete set null,
  actor_label       text,
  reason            text,

  -- HOW WE KNOW. These are NOT interchangeable and must never be merged.
  --   manual_report      a person told us
  --   snapshot_detected  we saw the value change between two observations;
  --                      the actor and the exact time are NOT knowable
  --   api_executed       we executed it and hold a success record. This app
  --                      does not write to TikTok, so nothing may claim it
  --                      without an external_execution_ref.
  confirmation      text not null
                      check (confirmation in ('manual_report', 'snapshot_detected', 'api_executed')),
  external_execution_ref text,

  -- LINKS. All nullable: an intervention can exist with no recommendation
  -- behind it, and most of the useful history will.
  recommendation_id uuid references public.recommendations(id) on delete set null,
  reverses_id       uuid references public.interventions(id) on delete set null,
  -- A detected change matched to a manual report. Kept as a link rather than a
  -- merge so the pair stays inspectable and neither is double counted.
  matched_id        uuid references public.interventions(id) on delete set null,
  match_confidence  text check (match_confidence in ('exact', 'probable', 'ambiguous')),

  policy_exception  boolean not null default false,
  policy_note       text,

  evidence          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),

  -- api_executed is a claim about the outside world and needs a receipt.
  constraint intervention_api_needs_receipt check (
    confirmation <> 'api_executed' or external_execution_ref is not null
  ),
  constraint intervention_interval_ordered check (occurred_to >= occurred_from),
  -- A snapshot cannot identify the actor or the exact moment unless the source
  -- supplies them, and Reacher's does not.
  constraint intervention_detected_has_no_actor check (
    confirmation <> 'snapshot_detected' or actor is null
  )
);

create index if not exists interventions_shop_time_idx
  on public.interventions (shop_id, occurred_from desc);
create index if not exists interventions_entity_idx
  on public.interventions (shop_id, entity_type, entity_id, occurred_from desc);
create index if not exists interventions_rec_idx
  on public.interventions (recommendation_id) where recommendation_id is not null;

comment on table public.interventions is
  'What ACTUALLY changed, as distinct from what was recommended or decided. recommendation_id is nullable because the system must learn from changes made outside its own advice. occurred_from/occurred_to are an interval: a snapshot-detected change has no knowable exact moment. A reversal is a new row linked by reverses_id, never a deletion.';


-- ── confounders, recorded rather than assumed away ─────────────────────────
-- "Unknown context is not proof of no confounders." An outcome evaluated
-- across a promotion is not a clean read, and the only way to know that later
-- is to have written the promotion down at the time.
create table if not exists public.context_events (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops(id) on delete cascade,
  kind         text not null check (kind in (
                 'promotion', 'stockout', 'replenishment', 'price_change',
                 'commission_change', 'creative_added', 'creative_authorised',
                 'campaign_pause', 'other_media', 'platform_event',
                 'ingestion_issue', 'other')),
  entity_type  text check (entity_type in ('campaign', 'creative', 'product', 'shop')),
  entity_id    text,
  label        text,
  starts_at    timestamptz not null,
  -- Open-ended on purpose: a stockout that has not been resolved has no end.
  ends_at      timestamptz,
  -- source_confirmed means a feed told us. operator_reported means a person
  -- did. They carry different weight and are never merged.
  source       text not null check (source in ('source_confirmed', 'operator_reported')),
  note         text,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),

  constraint context_interval_ordered check (ends_at is null or ends_at >= starts_at)
);

create index if not exists context_events_shop_time_idx
  on public.context_events (shop_id, starts_at desc);

comment on table public.context_events is
  'Structured confounders: promotions, stockouts, price and commission changes, creative additions, pauses, other media, platform events and ingestion problems. source distinguishes a feed telling us from a person telling us. An absence of rows is NOT evidence that nothing happened.';


-- ═══════════════════════════════════════════════════════════════════════════
-- RLS. Absent policy = deny, so every operation is named explicitly.
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.interventions  enable row level security;
alter table public.context_events enable row level security;

drop policy if exists interventions_select on public.interventions;
create policy interventions_select on public.interventions for select
  using (public.can_view_shop(shop_id, auth.uid()));

drop policy if exists interventions_insert on public.interventions;
create policy interventions_insert on public.interventions for insert
  with check (public.can_view_shop(shop_id, auth.uid()));

-- No UPDATE and no DELETE policy, deliberately. History is append-only: a
-- reversal is a new linked row, and a correction is a new row that supersedes.
-- Editing what happened is how an earlier recommendation comes to look better
-- informed than it was.

drop policy if exists context_select on public.context_events;
create policy context_select on public.context_events for select
  using (public.can_view_shop(shop_id, auth.uid()));

drop policy if exists context_insert on public.context_events;
create policy context_insert on public.context_events for insert
  with check (public.can_view_shop(shop_id, auth.uid()));


-- ═══════════════════════════════════════════════════════════════════════════
-- Recording an intervention.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.record_intervention(
  p_shop_id           uuid,
  p_entity_type       text,
  p_entity_id         text,
  p_field             text,
  p_new_value         numeric default null,
  p_old_value         numeric default null,
  p_occurred_from     timestamptz default null,
  p_occurred_to       timestamptz default null,
  p_confirmation      text default 'manual_report',
  p_reason            text default null,
  p_recommendation_id uuid default null,
  p_entity_label      text default null,
  p_value_unit        text default null,
  p_reverses_id       uuid default null,
  p_policy_exception  boolean default false,
  p_policy_note       text default null,
  p_external_ref      text default null,
  p_evidence          jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_id   uuid;
  v_from timestamptz := coalesce(p_occurred_from, now());
  v_to   timestamptz := coalesce(p_occurred_to, p_occurred_from, now());
  v_uid  uuid := auth.uid();
begin
  -- Check auth.uid(), never pg_has_role(current_user, ...): inside a SECURITY
  -- DEFINER function current_user is the function OWNER, so a role test here
  -- passes for everyone and guards nothing.
  if v_uid is null then
    raise exception 'record_intervention requires an authenticated user';
  end if;
  if not public.can_view_shop(p_shop_id, v_uid) then
    raise exception 'not authorised for this shop';
  end if;

  -- Nothing may claim the app executed something externally. It does not write
  -- to TikTok, and a false api_executed is the one provenance error that would
  -- make an outcome look verified when a person did the work by hand.
  if p_confirmation = 'api_executed' and p_external_ref is null then
    raise exception 'api_executed requires an external execution reference';
  end if;

  insert into public.interventions (
    shop_id, entity_type, entity_id, entity_label, field,
    old_value, new_value, value_unit,
    occurred_from, occurred_to,
    time_basis,
    actor, actor_label, reason, confirmation, external_execution_ref,
    recommendation_id, reverses_id, policy_exception, policy_note, evidence
  ) values (
    p_shop_id, p_entity_type, p_entity_id, p_entity_label, p_field,
    p_old_value, p_new_value, p_value_unit,
    v_from, v_to,
    case when v_from = v_to then 'exact' else 'interval' end,
    -- A detected change cannot name an actor; the constraint enforces it and
    -- this makes the intent explicit rather than relying on the caller.
    case when p_confirmation = 'snapshot_detected' then null else v_uid end,
    null, p_reason, p_confirmation, p_external_ref,
    p_recommendation_id, p_reverses_id, coalesce(p_policy_exception, false),
    p_policy_note, coalesce(p_evidence, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$fn$;

do $g$
declare sig text := 'public.record_intervention(uuid, text, text, text, numeric, numeric, timestamptz, timestamptz, text, text, uuid, text, text, uuid, boolean, text, text, jsonb)';
begin
  execute format('revoke all on function %s from public', sig);
  execute format('revoke all on function %s from anon', sig);
  execute format('grant execute on function %s to authenticated', sig);
end;
$g$;


create or replace function public.record_context_event(
  p_shop_id     uuid,
  p_kind        text,
  p_starts_at   timestamptz,
  p_ends_at     timestamptz default null,
  p_entity_type text default null,
  p_entity_id   text default null,
  p_label       text default null,
  p_source      text default 'operator_reported',
  p_note        text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_id  uuid;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'record_context_event requires an authenticated user';
  end if;
  if not public.can_view_shop(p_shop_id, v_uid) then
    raise exception 'not authorised for this shop';
  end if;

  insert into public.context_events (
    shop_id, kind, entity_type, entity_id, label,
    starts_at, ends_at, source, note, created_by
  ) values (
    p_shop_id, p_kind, p_entity_type, p_entity_id, p_label,
    p_starts_at, p_ends_at, p_source, p_note, v_uid
  )
  returning id into v_id;

  return v_id;
end;
$fn$;

do $g$
declare sig text := 'public.record_context_event(uuid, text, timestamptz, timestamptz, text, text, text, text, text)';
begin
  execute format('revoke all on function %s from public', sig);
  execute format('revoke all on function %s from anon', sig);
  execute format('grant execute on function %s to authenticated', sig);
end;
$g$;


-- ═══════════════════════════════════════════════════════════════════════════
-- Which confounders overlap a period. Used when an outcome is evaluated, so
-- "the metric improved" can be separated from "and nothing else was going on".
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.context_overlapping(
  p_shop_id uuid, p_from timestamptz, p_to timestamptz
) returns table (
  id uuid, kind text, label text, entity_type text, entity_id text,
  starts_at timestamptz, ends_at timestamptz, source text, note text
)
language sql stable as $fn$
  select e.id, e.kind, e.label, e.entity_type, e.entity_id,
         e.starts_at, e.ends_at, e.source, e.note
    from public.context_events e
   where e.shop_id = p_shop_id
     and e.starts_at <= p_to
     -- An open-ended event (a stockout with no recorded end) is still running,
     -- so it overlaps anything after it starts.
     and (e.ends_at is null or e.ends_at >= p_from)
   order by e.starts_at;
$fn$;

do $g$
begin
  revoke all on function public.context_overlapping(uuid, timestamptz, timestamptz) from public;
  revoke all on function public.context_overlapping(uuid, timestamptz, timestamptz) from anon;
  grant execute on function public.context_overlapping(uuid, timestamptz, timestamptz) to authenticated;
end;
$g$;


-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY — as the real `authenticated` role, not as the owner.
-- ═══════════════════════════════════════════════════════════════════════════
do $v$
declare
  shop uuid;
  uid  uuid;
  iv   uuid;
  ce   uuid;
  n    integer;
  msg  text;
begin
  select id into shop from public.shops where shop_name ilike 'Biostime%' limit 1;
  if shop is null then
    raise notice '031: no Biostime shop, checks skipped';
    return;
  end if;
  -- Access is granted by ROLE here, not by shop_access rows — that table is
  -- empty and can_view_shop() short-circuits on can_manage_shops(). Looking for
  -- a shop_access row therefore found nobody and skipped the whole check, which
  -- is exactly the kind of silently-skipped verification that lets a broken
  -- guard ship. Find a user who can actually reach the shop instead.
  select p.id into uid
    from public.profiles p
   where public.can_view_shop(shop, p.id)
   limit 1;
  if uid is null then
    raise notice '031: no user can view this shop, checks skipped';
    return;
  end if;

  -- 1. api_executed without a receipt must be refused. This app never writes to
  --    TikTok, so the only way that value appears is by mistake.
  begin
    perform set_config('request.jwt.claim.sub', uid::text, true);
    perform set_config('role', 'authenticated', true);
    iv := public.record_intervention(
      shop, 'campaign', 'TEST-031', 'daily_budget', 600, 550,
      now(), now(), 'api_executed', 'should be refused');
    raise exception '031: api_executed was accepted without an execution reference';
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg like '%031:%' then raise; end if;
    raise notice '031: api_executed correctly refused (%)', left(msg, 60);
  end;

  -- The EXCEPTION block above rolls back to an implicit savepoint, and a
  -- set_config(..., is_local => true) made inside it is rolled back with
  -- everything else. So auth.uid() is null again here unless it is re-applied.
  perform set_config('request.jwt.claim.sub', uid::text, true);
  perform set_config('role', 'authenticated', true);

  -- 2. A manual report records an exact moment and an actor.
  iv := public.record_intervention(
    shop, 'campaign', 'TEST-031', 'daily_budget', 600, 550,
    now(), now(), 'manual_report', 'verification row');
  select count(*) into n from public.interventions
   where id = iv and time_basis = 'exact' and actor = uid;
  if n <> 1 then raise exception '031: manual report did not record an exact time and actor'; end if;

  -- 3. A detected change spans an interval and names NO actor.
  iv := public.record_intervention(
    shop, 'campaign', 'TEST-031', 'target_roi', 1.6, 1.5,
    now() - interval '6 hours', now(), 'snapshot_detected', 'verification row');
  select count(*) into n from public.interventions
   where id = iv and time_basis = 'interval' and actor is null;
  if n <> 1 then raise exception '031: detected change must be an interval with no actor'; end if;

  -- 4. A policy exception is recordable. An action taken outside the guardrails
  --    still happened, and refusing to log it only loses the evidence.
  iv := public.record_intervention(
    shop, 'campaign', 'TEST-031', 'daily_budget', 900, 600,
    now(), now(), 'manual_report', 'raised despite a failed gate',
    null, null, 'currency_per_day', null, true, 'budget was not shown to bind');
  select count(*) into n from public.interventions where id = iv and policy_exception;
  if n <> 1 then raise exception '031: policy exception was not preserved'; end if;

  -- 5. Context events and overlap.
  ce := public.record_context_event(
    shop, 'promotion', now() - interval '2 days', now() + interval '2 days',
    'shop', null, 'verification promotion', 'operator_reported');
  select count(*) into n
    from public.context_overlapping(shop, now() - interval '1 hour', now());
  if n < 1 then raise exception '031: an overlapping promotion was not returned'; end if;

  -- An open-ended event still overlaps anything after it starts.
  ce := public.record_context_event(
    shop, 'stockout', now() - interval '1 day', null, 'product', 'P1', 'open stockout');
  select count(*) into n
    from public.context_overlapping(shop, now() + interval '30 days', now() + interval '31 days');
  if n < 1 then raise exception '031: an open-ended event stopped overlapping'; end if;

  raise notice '031: interventions and context events verified as the authenticated role';

  -- BACK TO THE OWNER BEFORE CLEANING UP, for two reasons.
  --
  -- There is no DELETE policy on either table — history is append-only, which
  -- is the point — so these deletes as `authenticated` would have removed
  -- nothing and reported success, leaving verification rows in real history.
  -- And leaving the role set leaks out of this block: the migration runner's
  -- own bookkeeping insert then fails with "permission denied for schema
  -- migrations", which is how this was caught.
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);

  delete from public.interventions  where entity_id = 'TEST-031';
  get diagnostics n = row_count;
  -- THREE, not four. The api_executed attempt raised, so its insert was rolled
  -- back with the exception and never became a row — which is itself the proof
  -- that the refusal happened before anything was written.
  if n <> 3 then
    raise exception '031: expected to clean up 3 verification interventions, removed %', n;
  end if;
  delete from public.context_events where label in ('verification promotion', 'open stockout');

  raise notice '031: % verification rows removed; real history is untouched', n;
end;
$v$;
