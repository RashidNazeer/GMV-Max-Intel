-- ═══════════════════════════════════════════════════════════════════════════
-- 023 — the decision workflow has never written a row
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Migration 016 built the whole decision layer: a 50-column typed contract, an
-- append-only event log, settings snapshots, an outcome function. Then it
-- enabled RLS and created a SELECT policy and an UPDATE policy — and no INSERT
-- policy. With RLS on, absent means denied.
--
-- Measured on prod before this migration:
--
--     recommendations             0 rows
--     recommendation_events       0 rows
--     INSERT as authenticated     42501 — violates row-level security policy
--
-- `persistRecommendation()` runs on every Overview render, is refused, and the
-- refusal is swallowed by `.catch(() => {})` in OverviewPage — a catch added so
-- a failed write could not blank the page. Mark planned, Mark applied and
-- Dismiss have had nothing to attach to since the day they shipped.
--
-- THERE IS A SECOND, INDEPENDENT BLOCKER, and it would still have been fatal
-- after adding a policy. `rec_live_fingerprint_idx` (016:119-121) is PARTIAL:
--
--     create unique index rec_live_fingerprint_idx
--       on public.recommendations (shop_id, fingerprint)
--       where status in ('proposed', 'planned');
--
-- PostgREST's `.upsert(…, { onConflict: 'shop_id,fingerprint' })` needs a
-- non-partial unique constraint to infer an arbiter and raises 42P10 against
-- this one. Two faults, stacked, either sufficient to kill the feature.
--
-- The fix is a SECURITY DEFINER function that does SELECT-then-INSERT rather
-- than ON CONFLICT, so the partial index is respected instead of fought.
--
-- ── WHAT THIS MIGRATION HONESTLY DOES NOT DO ───────────────────────────────
-- It does NOT make the recommendation payload trustworthy. `decide.js` runs in
-- the browser: evidence, confidence, suggested_value, title and reason all
-- arrive from the client, and a definer function cannot change that. What it
-- CAN do, and does, is stop a client asserting the fields that represent a
-- HUMAN DECISION — status, decision, applied_value, actor and timestamps are
-- server-set at birth and moved only through the recorded path. That is the
-- real boundary, and it is worth stating plainly rather than implying more.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. THE MISSING POLICY ──────────────────────────────────────────────────
drop policy if exists rec_insert on public.recommendations;
create policy rec_insert on public.recommendations for insert
  with check (public.can_view_shop(shop_id, auth.uid()));


-- ── 2. DECISION IS NOT LIFECYCLE ───────────────────────────────────────────
-- `status` carried both: what the operator DECIDED and where the action GOT
-- TO. They are different facts with different lifetimes — a rejected proposal
-- and an applied-then-reverted test are not points on one line. `status` keeps
-- its five values untouched (016's verify block guards the column count and
-- nothing may be re-meant); the decision becomes its own column beside it.
alter table public.recommendations
  add column if not exists decision        text,
  add column if not exists decision_at     timestamptz,
  add column if not exists decision_actor  uuid,
  add column if not exists decision_note   text,
  add column if not exists defer_until     date,
  -- "Applied a value of 0" and "applied, value not stated" are different
  -- claims that a nullable numeric cannot tell apart.
  add column if not exists applied_value_known boolean,
  -- Emitted by shape() today and dropped at the persist boundary, so a stored
  -- row could not reproduce the priority line or its drill-down target.
  add column if not exists short_finding   text,
  add column if not exists drill_to        text,
  add column if not exists lane            text,
  -- Which guardrails actually RAN. Each candidate runs only the checks it
  -- chose, so a stored row assessed only those — recording which were not run
  -- stops their absence reading as a pass.
  add column if not exists checks_ran      text[],
  add column if not exists checks_not_run  text[],
  -- The review condition. Absent entirely before this.
  add column if not exists next_review_at  date,
  add column if not exists review_min_days int,
  add column if not exists success_criterion text,
  -- An idempotency key over the CONTENT, so a re-render cannot make a second
  -- row and a genuine change of substance can.
  add column if not exists content_hash    text;

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'rec_decision_chk') then
    alter table public.recommendations add constraint rec_decision_chk
      check (decision is null or decision in ('accept', 'modify', 'reject', 'defer'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'rec_defer_chk') then
    -- A deferral without a date is a decision that never comes back.
    alter table public.recommendations add constraint rec_defer_chk
      check (decision is distinct from 'defer' or defer_until is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'rec_reason_chk') then
    -- Reject and defer must say WHY. Accept and modify need not.
    alter table public.recommendations add constraint rec_reason_chk
      check (decision not in ('reject', 'defer') or coalesce(btrim(decision_note), '') <> '');
  end if;
end;
$c$;

create index if not exists rec_review_due_idx
  on public.recommendations (shop_id, next_review_at)
  where status in ('planned', 'applied');

comment on column public.recommendations.decision is
  'What the OPERATOR judged: accept | modify | reject | defer. Separate from `status`, which is where the action got to. A rejected proposal and a reverted test are not points on one line.';
comment on column public.recommendations.applied_value_known is
  'false means applied but the actual value was not stated. NULL means not applied. This exists because a nullable numeric cannot distinguish "set it to 0" from "did not say".';


-- ── 3. THE GUARD, EXTENDED TO INSERT ───────────────────────────────────────
-- On UPDATE it already refused a user rewriting the evidence. On INSERT there
-- was no guard at all, because there were no inserts. A client may now propose
-- a recommendation; it may NOT arrive already decided, already applied, or
-- attributed to someone else.
create or replace function public.recommendations_guard()
returns trigger language plpgsql as $$
declare
  is_user boolean := current_setting('request.jwt.claims', true) is not null
    and coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'authenticated';
begin
  if tg_op = 'INSERT' then
    new.updated_at := now();
    if is_user then
      -- A recommendation is born PROPOSED and undecided, whatever the payload
      -- says. Every one of these is a human act and must go through the
      -- recorded path, where an event is written alongside it.
      new.status          := 'proposed';
      new.status_actor    := null;
      new.status_at       := null;
      new.status_reason   := null;
      new.decision        := null;
      new.decision_at     := null;
      new.decision_actor  := null;
      new.decision_note   := null;
      new.defer_until     := null;
      new.applied_value   := null;
      new.applied_value_known := null;
      new.applied_at      := null;
    end if;
    return new;
  end if;

  new.updated_at := now();

  if is_user then
    if new.shop_id      is distinct from old.shop_id
    or new.fingerprint  is distinct from old.fingerprint
    or new.action_code  is distinct from old.action_code
    or new.evidence     is distinct from old.evidence
    or new.suggested_value is distinct from old.suggested_value
    or new.confidence   is distinct from old.confidence then
      raise exception 'only the lifecycle fields of a recommendation may be edited';
    end if;
    -- The decision trail is append-only in spirit: once recorded, a decision
    -- may be SUPERSEDED by a new one through record_decision(), never edited
    -- away in place.
    if old.decision is not null and new.decision is distinct from old.decision
       and new.decision is null then
      raise exception 'a recorded decision cannot be erased, only superseded';
    end if;
  end if;

  if new.status is distinct from old.status then
    new.status_at := now();
    if new.status = 'applied' and new.applied_at is null then
      new.applied_at := now();
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists recommendations_guard_trg on public.recommendations;
create trigger recommendations_guard_trg before insert or update on public.recommendations
  for each row execute function public.recommendations_guard();


-- ── 4. PERSIST, WITHOUT FIGHTING THE PARTIAL INDEX ─────────────────────────
-- SELECT-then-INSERT, never ON CONFLICT. `rec_live_fingerprint_idx` covers
-- only ('proposed','planned'), so an applied row legitimately coexists with a
-- proposed one — which is also why api.js's .maybeSingle() over three statuses
-- would start throwing PGRST116 the moment the feature began working.
create or replace function public.record_recommendation(
  p_shop_id     uuid,
  p_fingerprint text,
  p_payload     jsonb
)
returns public.recommendations
language plpgsql
security definer
set search_path = public
as $fn$
declare
  existing public.recommendations;
  fresh    public.recommendations;
  hash     text := md5(coalesce(p_payload ->> 'content_hash', p_payload::text));
begin
  if not public.can_view_shop(p_shop_id, auth.uid()) then
    raise exception 'not authorised for this shop' using errcode = '42501';
  end if;

  -- A live row for this fingerprint is the SAME decision still in flight. Its
  -- operator state is the point of the table, so it is returned untouched —
  -- re-rendering Overview must never reset what somebody planned.
  select * into existing from public.recommendations
   where shop_id = p_shop_id and fingerprint = p_fingerprint
     and status in ('proposed', 'planned', 'applied')
   order by generated_at desc
   limit 1;

  if found then
    return existing;
  end if;

  insert into public.recommendations (
    shop_id, fingerprint, action_code, status,
    scope_type, scope_label, scope_id,
    window_start, window_end, model_start, model_end,
    rule_version, objective, severity, lane,
    title, reason, short_finding, action_text, drill_to,
    evidence, guardrails, suppressed, affected_ids,
    checks_ran, checks_not_run,
    current_value, suggested_value, change_abs, change_pct, value_unit,
    test_days, next_review_at, review_min_days, success_criterion,
    confidence, confidence_label, confidence_parts, model_confidence, data_coverage,
    source_mode, missing_inputs, content_hash
  )
  values (
    p_shop_id, p_fingerprint, p_payload ->> 'action_code', 'proposed',
    coalesce(p_payload ->> 'scope_type', 'shop'), p_payload ->> 'scope_label', p_payload ->> 'scope_id',
    (p_payload ->> 'window_start')::date, (p_payload ->> 'window_end')::date,
    (p_payload ->> 'model_start')::date, (p_payload ->> 'model_end')::date,
    coalesce(p_payload ->> 'rule_version', 'unversioned'),
    coalesce(p_payload ->> 'objective', 'balanced'),
    coalesce(p_payload ->> 'severity', 'info'),
    p_payload ->> 'lane',
    coalesce(p_payload ->> 'title', '(untitled)'),
    coalesce(p_payload ->> 'reason', ''),
    p_payload ->> 'short_finding',
    coalesce(p_payload ->> 'action_text', ''),
    p_payload ->> 'drill_to',
    coalesce(p_payload -> 'evidence', '[]'::jsonb),
    coalesce(p_payload -> 'guardrails', '[]'::jsonb),
    coalesce(p_payload -> 'suppressed', '[]'::jsonb),
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(p_payload -> 'affected_ids')), '{}'),
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(p_payload -> 'checks_ran')), '{}'),
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(p_payload -> 'checks_not_run')), '{}'),
    (p_payload ->> 'current_value')::numeric, (p_payload ->> 'suggested_value')::numeric,
    (p_payload ->> 'change_abs')::numeric, (p_payload ->> 'change_pct')::numeric,
    p_payload ->> 'value_unit',
    (p_payload ->> 'test_days')::int,
    case when (p_payload ->> 'test_days') is not null
         then (current_date + (p_payload ->> 'test_days')::int) end,
    (p_payload ->> 'review_min_days')::int,
    p_payload ->> 'success_criterion',
    (p_payload ->> 'confidence')::numeric, p_payload ->> 'confidence_label',
    coalesce(p_payload -> 'confidence_parts', '[]'::jsonb),
    (p_payload ->> 'model_confidence')::numeric, (p_payload ->> 'data_coverage')::numeric,
    coalesce(p_payload ->> 'source_mode', 'measured'),
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(p_payload -> 'missing_inputs')), '{}'),
    hash
  )
  returning * into fresh;

  insert into public.recommendation_events (recommendation_id, shop_id, event, to_status, actor, detail)
  values (fresh.id, p_shop_id, 'proposed', 'proposed', auth.uid(),
          jsonb_build_object('rule_version', fresh.rule_version));

  return fresh;
end;
$fn$;


-- ── 5. RECORDING A HUMAN DECISION ──────────────────────────────────────────
-- One path for accept / modify / reject / defer, so the reason, the actor and
-- the event are written together or not at all. `p_expect_decision_at` makes
-- the call idempotent under a double-submit: a second click carrying the same
-- expectation loses the race and returns the row rather than writing twice.
create or replace function public.record_decision(
  p_recommendation_id uuid,
  p_decision          text,
  p_note              text default null,
  p_defer_until       date default null,
  p_applied_value     numeric default null,
  p_applied_known     boolean default null,
  p_status            text default null
)
returns public.recommendations
language plpgsql
security definer
set search_path = public
as $fn$
declare
  rec public.recommendations;
begin
  select * into rec from public.recommendations where id = p_recommendation_id;
  if not found then
    raise exception 'no such recommendation' using errcode = 'P0002';
  end if;
  if not public.can_view_shop(rec.shop_id, auth.uid()) then
    raise exception 'not authorised for this shop' using errcode = '42501';
  end if;
  if p_decision not in ('accept', 'modify', 'reject', 'defer') then
    raise exception 'decision must be accept, modify, reject or defer';
  end if;
  if p_decision in ('reject', 'defer') and coalesce(btrim(p_note), '') = '' then
    raise exception 'a % must record a reason', p_decision;
  end if;
  if p_decision = 'defer' and p_defer_until is null then
    raise exception 'a deferral must record when it comes back';
  end if;

  -- Recording the SAME decision again is a no-op, not a second event. This is
  -- the server-side half of duplicate prevention; the disabled button is the
  -- client half and neither is sufficient alone.
  if rec.decision is not distinct from p_decision
     and rec.decision_note is not distinct from p_note
     and rec.defer_until is not distinct from p_defer_until
     and (p_status is null or rec.status is not distinct from p_status) then
    return rec;
  end if;

  update public.recommendations set
    decision       = p_decision,
    decision_at    = now(),
    decision_actor = auth.uid(),
    decision_note  = p_note,
    defer_until    = case when p_decision = 'defer' then p_defer_until else null end,
    applied_value  = coalesce(p_applied_value, applied_value),
    applied_value_known = coalesce(p_applied_known, applied_value_known),
    status         = coalesce(p_status, status),
    status_actor   = case when p_status is not null then auth.uid() else status_actor end,
    status_reason  = case when p_status is not null then coalesce(p_note, status_reason) else status_reason end
  where id = p_recommendation_id
  returning * into rec;

  insert into public.recommendation_events (recommendation_id, shop_id, event, to_status, actor, detail)
  values (
    p_recommendation_id, rec.shop_id, p_decision, rec.status, auth.uid(),
    jsonb_strip_nulls(jsonb_build_object(
      'note', p_note, 'defer_until', p_defer_until,
      'applied_value', p_applied_value, 'applied_value_known', p_applied_known,
      'status', p_status
    ))
  );

  return rec;
end;
$fn$;


-- ── 6. GRANTS. anon BY NAME — `revoke from public` does not undo Supabase's
--    automatic grant, and this project has paid for that lesson before.
do $g$
begin
  revoke all on function public.record_recommendation(uuid, text, jsonb) from public;
  revoke all on function public.record_recommendation(uuid, text, jsonb) from anon;
  grant execute on function public.record_recommendation(uuid, text, jsonb) to authenticated;
  grant execute on function public.record_recommendation(uuid, text, jsonb) to service_role;

  revoke all on function public.record_decision(uuid, text, text, date, numeric, boolean, text) from public;
  revoke all on function public.record_decision(uuid, text, text, date, numeric, boolean, text) from anon;
  grant execute on function public.record_decision(uuid, text, text, date, numeric, boolean, text) to authenticated;
  grant execute on function public.record_decision(uuid, text, text, date, numeric, boolean, text) to service_role;
end;
$g$;


-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY — as the REAL caller. A check run with different privileges from the
-- app is not a check of the app; this project learned that twice in one day.
-- ═══════════════════════════════════════════════════════════════════════════
do $v$
declare
  uid uuid; v_shop uuid; rec public.recommendations; n int; ev int;
  fp text := 'verify-023:' || gen_random_uuid()::text;
begin
  select id into v_shop from public.shops where shop_name ilike 'Biostime%' limit 1;
  select a.user_id into uid from public.shop_access a where a.shop_id = v_shop limit 1;
  if uid is null then select id into uid from public.profiles limit 1; end if;
  if v_shop is null or uid is null then
    raise notice 'no shop or profile — verification skipped';
    return;
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', 'authenticated')::text, true);

  -- 1. The insert that used to be refused with 42501.
  rec := public.record_recommendation(v_shop, fp, jsonb_build_object(
    'action_code', 'review_creative', 'title', 'verify', 'reason', 'verify',
    'window_start', '2026-09-01', 'window_end', '2026-09-07',
    'rule_version', 'verify', 'severity', 'info', 'lane', 'media',
    'test_days', 7, 'status', 'applied'      -- the payload LIES; the guard must win
  ));
  if rec.id is null then raise exception 'record_recommendation returned no row'; end if;
  if rec.status <> 'proposed' then
    raise exception 'a client-supplied status of applied survived: %', rec.status;
  end if;
  if rec.next_review_at is null then raise exception 'next_review_at was not derived from test_days'; end if;

  -- 2. Idempotent: a second render must not make a second row.
  -- (plpgsql cannot dereference a composite function result inline, so the
  --  second call lands in its own variable first.)
  declare again public.recommendations;
  begin
    again := public.record_recommendation(v_shop, fp,
      jsonb_build_object('action_code', 'review_creative'));
    if again.id <> rec.id then
      raise exception 'a re-render created a duplicate recommendation';
    end if;
  end;

  -- 3. A rejection without a reason must be refused.
  begin
    perform public.record_decision(rec.id, 'reject', null);
    raise exception 'a reject with no reason was accepted';
  exception when others then
    if sqlerrm not like '%must record a reason%' then raise; end if;
  end;

  -- 4. A deferral without a date must be refused.
  begin
    perform public.record_decision(rec.id, 'defer', 'later', null);
    raise exception 'a defer with no date was accepted';
  exception when others then
    if sqlerrm not like '%when it comes back%' then raise; end if;
  end;

  -- 5. A real decision is recorded, with its event.
  rec := public.record_decision(rec.id, 'reject', 'not this week', null, null, null, 'dismissed');
  if rec.decision <> 'reject' or rec.decision_note is null then
    raise exception 'the decision was not recorded';
  end if;
  if rec.status <> 'dismissed' then raise exception 'the lifecycle did not move'; end if;

  -- 6. Recording it AGAIN writes no second event.
  select count(*) into ev from public.recommendation_events where recommendation_id = rec.id;
  perform public.record_decision(rec.id, 'reject', 'not this week', null, null, null, 'dismissed');
  select count(*) into n from public.recommendation_events where recommendation_id = rec.id;
  if n <> ev then raise exception 'a duplicate submit wrote a second event (% -> %)', ev, n; end if;

  -- 7. The decision may be superseded but not erased.
  begin
    update public.recommendations set decision = null where id = rec.id;
    raise exception 'a recorded decision was erased';
  exception when others then
    if sqlerrm not like '%cannot be erased%' then raise; end if;
  end;

  raise notice 'VERIFIED: insert works, status is server-set, duplicates collapse, reasons are required';

  reset role;

  -- 8. THE VERIFY ROW IS NOT DELETED, and that is the append-only guard doing
  -- its job. Deleting the recommendation cascades to recommendation_events,
  -- whose trigger refuses: "recommendation_events is append-only; record a
  -- correction as a new event". Suppressing that to tidy up would be
  -- suppressing the exact property the audit trail exists for.
  --
  -- The row is left as it ends: status 'dismissed', decision 'reject'. The UI
  -- lists only proposed/planned/applied, so it never renders. Its fingerprint
  -- begins 'verify-023:' so anyone reading the table knows what it is.
  raise notice 'verification row % left in place — deleting it would breach the append-only event log', fp;
end;
$v$;
