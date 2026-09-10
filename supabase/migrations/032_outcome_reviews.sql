-- ═══════════════════════════════════════════════════════════════════════════
-- GMV Max Intelligence — 032: what happened afterwards, and what that proves.
--
-- The fourth record. A recommendation says what we suggested, a decision says
-- what the operator chose, an intervention says what actually changed, and this
-- says what followed — kept apart because collapsing them is how "we suggested
-- it" turns into "it worked".
--
-- ── THE CRITERIA ARE WRITTEN DOWN BEFORE THE RESULT ────────────────────────
-- Everything in the "before" block is required at planning time: hypothesis,
-- target metric, baseline, observation window, settling period, minimum
-- coverage, success and failure thresholds, guardrails, owner and planned date.
-- A later change is an AMENDMENT with a reason, appended to a versioned array,
-- never an edit. Moving the goalposts after seeing the result is the single
-- easiest way to make a tool that always says it was right.
--
-- ── THREE SEPARATE QUESTIONS, THREE COLUMNS ────────────────────────────────
--   metric_outcome        did the number move?      favourable | unfavourable |
--                                                   mixed | unmeasurable
--   causal_basis          what does that establish? observed | adjusted |
--                                                   modelled | experimental
--   review_decision       what will we do?          continue | revert | extend |
--                                                   stop | inconclusive
--
-- A metric can improve while attribution stays confounded. `causal_basis` is
-- what stops a pre/post difference being called lift: `observed` means exactly
-- "the number before and the number after", and nothing more.
--
-- ── LATE DATA IS NOT FAILURE ───────────────────────────────────────────────
-- awaiting_data exists so a review that comes due before its evidence has
-- settled waits, rather than scoring the intervention as unsuccessful. Likewise
-- an intervention that was never actually implemented, or whose campaign sat
-- inactive, resolves as unmeasurable — not as a failed test.
--
-- ── A REVERT IS A RECOMMENDATION UNTIL IT IS DONE ──────────────────────────
-- Deciding to revert does not change anything in TikTok. It stays a decision
-- until an actual reversal is recorded as an intervention with reverses_id set.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.outcome_reviews (
  id                 uuid primary key default gen_random_uuid(),
  shop_id            uuid not null references public.shops(id) on delete cascade,
  intervention_id    uuid references public.interventions(id) on delete cascade,
  recommendation_id  uuid references public.recommendations(id) on delete set null,

  -- ── written BEFORE the change, and frozen ───────────────────────────────
  hypothesis         text not null,
  target_metric      text not null,
  baseline_value     numeric,
  baseline_basis     text,
  observation_days   integer not null check (observation_days > 0),
  settling_days      integer not null default 2 check (settling_days >= 0),
  min_coverage       numeric not null default 1.0 check (min_coverage between 0 and 1),
  success_threshold  numeric,
  failure_threshold  numeric,
  threshold_unit     text,
  guardrails         jsonb not null default '[]'::jsonb,
  review_owner       uuid references auth.users(id) on delete set null,
  planned_review_at  timestamptz,
  criteria_version   integer not null default 1,
  -- Append-only. Each entry: {at, by, reason, changed: {...}, from_version}.
  amendments         jsonb not null default '[]'::jsonb,

  -- ── lifecycle ───────────────────────────────────────────────────────────
  lifecycle          text not null default 'planned' check (lifecycle in (
                       'planned', 'applied', 'awaiting_data', 'review_due',
                       'reviewed', 'cancelled')),
  lifecycle_at       timestamptz not null default now(),

  -- ── written AFTER, and only after ───────────────────────────────────────
  result_value       numeric,
  result_coverage    numeric,
  metric_outcome     text check (metric_outcome in (
                       'favourable', 'unfavourable', 'mixed', 'unmeasurable')),
  -- What the result actually establishes. NOT a synonym for the outcome.
  causal_basis       text check (causal_basis in (
                       'observed', 'adjusted', 'modelled', 'experimental')),
  causal_note        text,
  confounders        jsonb not null default '[]'::jsonb,
  review_decision    text check (review_decision in (
                       'continue', 'revert', 'extend', 'stop', 'inconclusive')),
  review_note        text,
  reviewed_at        timestamptz,
  reviewed_by        uuid references auth.users(id) on delete set null,
  -- Set when a revert DECISION has been carried out, so a decision to revert is
  -- never mistaken for a reversal that happened.
  reverted_by_intervention uuid references public.interventions(id) on delete set null,

  created_at         timestamptz not null default now(),

  -- A reviewed row must carry its findings; an unreviewed one must not.
  constraint review_complete_when_reviewed check (
    lifecycle <> 'reviewed'
    or (metric_outcome is not null and causal_basis is not null
        and review_decision is not null and reviewed_at is not null)
  ),
  constraint review_findings_need_review check (
    lifecycle = 'reviewed' or metric_outcome is null
  )
);

create index if not exists outcome_reviews_shop_idx
  on public.outcome_reviews (shop_id, lifecycle, planned_review_at);
create index if not exists outcome_reviews_intervention_idx
  on public.outcome_reviews (intervention_id);

comment on table public.outcome_reviews is
  'What followed an intervention. Criteria are frozen at planning time and changed only by appended, reasoned amendments. metric_outcome (did it move), causal_basis (what that establishes) and review_decision (what we will do) are three separate answers. awaiting_data exists so late evidence waits rather than scoring a failure.';


-- ── append-only audit of every lifecycle move ──────────────────────────────
create table if not exists public.outcome_review_events (
  id         uuid primary key default gen_random_uuid(),
  review_id  uuid not null references public.outcome_reviews(id) on delete cascade,
  from_state text,
  to_state   text not null,
  actor      uuid references auth.users(id) on delete set null,
  reason     text,
  detail     jsonb not null default '{}'::jsonb,
  at         timestamptz not null default now()
);

create index if not exists outcome_review_events_idx
  on public.outcome_review_events (review_id, at);

comment on table public.outcome_review_events is
  'Append-only audit trail of lifecycle transitions. A correction is a new row, never an edit — the trail must still show what was believed at the time.';


-- ═══════════════════════════════════════════════════════════════════════════
-- The transition table. Enforced on the server so a client cannot skip a state.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.outcome_transition_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
as $fn$
  select case p_from
    -- A plan can be carried out, or abandoned. It cannot jump to reviewed:
    -- there is nothing to review until something changed.
    when 'planned'       then p_to in ('applied', 'cancelled')
    -- Once applied, the wait begins. Straight to review_due is allowed for a
    -- zero-settling metric; cancelled remains possible if it is undone.
    when 'applied'       then p_to in ('awaiting_data', 'review_due', 'cancelled')
    -- Late data keeps it waiting. It may also go back to applied if the
    -- intervention turns out to have been recorded prematurely.
    when 'awaiting_data' then p_to in ('review_due', 'cancelled', 'applied')
    -- Due can slip BACK to awaiting_data: evidence that looked settled can be
    -- restated by a late correction, and reviewing on it anyway would be worse.
    when 'review_due'    then p_to in ('reviewed', 'awaiting_data', 'cancelled')
    -- Terminal. A changed conclusion is a NEW review, not an edit of this one.
    when 'reviewed'      then false
    when 'cancelled'     then false
    else false
  end;
$fn$;

comment on function public.outcome_transition_allowed(text, text) is
  'The valid lifecycle moves. reviewed and cancelled are terminal: a changed conclusion is a new review, so the original stays auditable.';


create or replace function public.advance_outcome_review(
  p_review_id uuid,
  p_to        text,
  p_reason    text default null,
  p_detail    jsonb default '{}'::jsonb
) returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r    public.outcome_reviews%rowtype;
  uid  uuid := auth.uid();
begin
  if uid is null then
    raise exception 'advance_outcome_review requires an authenticated user';
  end if;

  select * into r from public.outcome_reviews where id = p_review_id for update;
  if not found then
    raise exception 'no such outcome review';
  end if;
  if not public.can_view_shop(r.shop_id, uid) then
    raise exception 'not authorised for this shop';
  end if;

  if r.lifecycle = p_to then
    return r.lifecycle;      -- idempotent: re-sending the current state is a no-op
  end if;

  if not public.outcome_transition_allowed(r.lifecycle, p_to) then
    raise exception 'cannot move an outcome review from % to %', r.lifecycle, p_to;
  end if;

  update public.outcome_reviews
     set lifecycle = p_to, lifecycle_at = now()
   where id = p_review_id;

  insert into public.outcome_review_events (review_id, from_state, to_state, actor, reason, detail)
  values (p_review_id, r.lifecycle, p_to, uid, p_reason, coalesce(p_detail, '{}'::jsonb));

  return p_to;
end;
$fn$;


-- ═══════════════════════════════════════════════════════════════════════════
-- Recording the review itself. Separate from the transition so the three
-- answers arrive together and the row can never be half-reviewed.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.record_outcome_review(
  p_review_id      uuid,
  p_metric_outcome text,
  p_causal_basis   text,
  p_review_decision text,
  p_result_value   numeric default null,
  p_result_coverage numeric default null,
  p_causal_note    text default null,
  p_review_note    text default null
) returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r        public.outcome_reviews%rowtype;
  uid      uuid := auth.uid();
  confs    jsonb;
begin
  if uid is null then
    raise exception 'record_outcome_review requires an authenticated user';
  end if;

  select * into r from public.outcome_reviews where id = p_review_id for update;
  if not found then raise exception 'no such outcome review'; end if;
  if not public.can_view_shop(r.shop_id, uid) then
    raise exception 'not authorised for this shop';
  end if;
  if r.lifecycle <> 'review_due' then
    raise exception 'an outcome review can only be recorded from review_due, not from %', r.lifecycle;
  end if;

  -- A pre/post difference is NOT causal evidence, so `experimental` is refused
  -- unless the row carries experiment metadata. Without a valid design there is
  -- no experiment, whatever the number did.
  if p_causal_basis = 'experimental'
     and not coalesce((r.guardrails ? 'experiment'), false) then
    raise exception 'experimental causal basis requires experiment metadata on the plan';
  end if;

  -- Attach whatever else was going on. This is why context_events exists: an
  -- outcome measured across a promotion is not a clean read, and the review
  -- must carry that with it rather than leaving a future reader to notice.
  select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) into confs
    from public.context_overlapping(
      r.shop_id,
      coalesce((select occurred_from from public.interventions i where i.id = r.intervention_id), r.created_at),
      now()
    ) c;

  update public.outcome_reviews
     set metric_outcome  = p_metric_outcome,
         causal_basis    = p_causal_basis,
         review_decision = p_review_decision,
         result_value    = p_result_value,
         result_coverage = p_result_coverage,
         causal_note     = p_causal_note,
         review_note     = p_review_note,
         confounders     = confs,
         reviewed_at     = now(),
         reviewed_by     = uid,
         lifecycle       = 'reviewed',
         lifecycle_at    = now()
   where id = p_review_id;

  insert into public.outcome_review_events (review_id, from_state, to_state, actor, reason, detail)
  values (p_review_id, r.lifecycle, 'reviewed', uid, p_review_note,
          jsonb_build_object('metric_outcome', p_metric_outcome,
                             'causal_basis', p_causal_basis,
                             'review_decision', p_review_decision,
                             'confounders', jsonb_array_length(confs)));

  return 'reviewed';
end;
$fn$;


-- ── amendments are appended, never applied over the original ───────────────
create or replace function public.amend_outcome_criteria(
  p_review_id uuid,
  p_changes   jsonb,
  p_reason    text
) returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r   public.outcome_reviews%rowtype;
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'amend_outcome_criteria requires an authenticated user'; end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'an amendment requires a reason';
  end if;

  select * into r from public.outcome_reviews where id = p_review_id for update;
  if not found then raise exception 'no such outcome review'; end if;
  if not public.can_view_shop(r.shop_id, uid) then
    raise exception 'not authorised for this shop';
  end if;
  -- THE POINT OF THE WHOLE MECHANISM. Once the result is in, the criteria it
  -- was judged against are history.
  if r.lifecycle = 'reviewed' then
    raise exception 'criteria cannot be amended after the review is recorded';
  end if;

  update public.outcome_reviews
     set criteria_version = r.criteria_version + 1,
         amendments = r.amendments || jsonb_build_object(
           'at', now(), 'by', uid, 'reason', p_reason,
           'from_version', r.criteria_version, 'changed', p_changes),
         success_threshold = coalesce((p_changes ->> 'success_threshold')::numeric, r.success_threshold),
         failure_threshold = coalesce((p_changes ->> 'failure_threshold')::numeric, r.failure_threshold),
         observation_days  = coalesce((p_changes ->> 'observation_days')::integer, r.observation_days),
         planned_review_at = coalesce((p_changes ->> 'planned_review_at')::timestamptz, r.planned_review_at)
   where id = p_review_id;

  return r.criteria_version + 1;
end;
$fn$;


alter table public.outcome_reviews       enable row level security;
alter table public.outcome_review_events enable row level security;

drop policy if exists outcome_select on public.outcome_reviews;
create policy outcome_select on public.outcome_reviews for select
  using (public.can_view_shop(shop_id, auth.uid()));

drop policy if exists outcome_insert on public.outcome_reviews;
create policy outcome_insert on public.outcome_reviews for insert
  with check (public.can_view_shop(shop_id, auth.uid()));

-- No client UPDATE policy: every mutation goes through the functions above, so
-- the transition table and the amendment rule cannot be bypassed.

drop policy if exists outcome_events_select on public.outcome_review_events;
create policy outcome_events_select on public.outcome_review_events for select
  using (exists (
    select 1 from public.outcome_reviews o
     where o.id = review_id and public.can_view_shop(o.shop_id, auth.uid())
  ));

do $g$
declare s text;
begin
  foreach s in array array[
    'public.advance_outcome_review(uuid, text, text, jsonb)',
    'public.record_outcome_review(uuid, text, text, text, numeric, numeric, text, text)',
    'public.amend_outcome_criteria(uuid, jsonb, text)',
    'public.outcome_transition_allowed(text, text)'
  ] loop
    execute format('revoke all on function %s from public', s);
    execute format('revoke all on function %s from anon', s);
    execute format('grant execute on function %s to authenticated', s);
  end loop;
end;
$g$;


-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY — the transition table, the amendment rule and the terminal states.
-- ═══════════════════════════════════════════════════════════════════════════
do $v$
declare
  shop uuid; uid uuid; iv uuid; rv uuid;
  got text; n integer; msg text;
begin
  select id into shop from public.shops where shop_name ilike 'Biostime%' limit 1;
  select p.id into uid from public.profiles p where public.can_view_shop(shop, p.id) limit 1;
  if shop is null or uid is null then
    raise notice '032: no shop or no user, checks skipped';
    return;
  end if;

  -- 1. The transition table itself, before touching any data.
  if public.outcome_transition_allowed('planned', 'reviewed') then
    raise exception '032: a plan must not jump straight to reviewed';
  end if;
  if public.outcome_transition_allowed('reviewed', 'review_due') then
    raise exception '032: reviewed must be terminal';
  end if;
  if not public.outcome_transition_allowed('review_due', 'awaiting_data') then
    raise exception '032: a due review must be able to wait for restated data';
  end if;

  perform set_config('request.jwt.claim.sub', uid::text, true);
  perform set_config('role', 'authenticated', true);

  iv := public.record_intervention(
    shop, 'campaign', 'TEST-032', 'daily_budget', 660, 550,
    now() - interval '10 days', now() - interval '10 days', 'manual_report', 'verification');

  insert into public.outcome_reviews (
    shop_id, intervention_id, hypothesis, target_metric, baseline_value,
    observation_days, settling_days, success_threshold, failure_threshold,
    review_owner, planned_review_at
  ) values (
    shop, iv, 'raising the cap increases delivered spend', 'total_shop_gmv', 13710,
    7, 2, 0.05, -0.05, uid, now() - interval '1 day'
  ) returning id into rv;

  -- 2. Skipping states is refused.
  begin
    got := public.advance_outcome_review(rv, 'reviewed', 'should be refused');
    raise exception '032: planned jumped straight to reviewed';
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg like '%032:%' then raise; end if;
  end;
  perform set_config('request.jwt.claim.sub', uid::text, true);
  perform set_config('role', 'authenticated', true);

  -- 3. Recording a review before it is due is refused.
  got := public.advance_outcome_review(rv, 'applied', 'the change was made');
  begin
    got := public.record_outcome_review(rv, 'favourable', 'observed', 'continue');
    raise exception '032: a review was recorded from applied';
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg like '%032:%' then raise; end if;
  end;
  perform set_config('request.jwt.claim.sub', uid::text, true);
  perform set_config('role', 'authenticated', true);

  -- 4. Late data waits rather than failing.
  got := public.advance_outcome_review(rv, 'awaiting_data', 'affiliate feed is a day short');
  if got <> 'awaiting_data' then raise exception '032: could not wait for data'; end if;

  -- 5. Amendments are appended with a reason and bump the version.
  n := public.amend_outcome_criteria(rv,
        jsonb_build_object('observation_days', 10),
        'the affiliate feed settles slower than assumed');
  if n <> 2 then raise exception '032: criteria version did not advance, got %', n; end if;
  select jsonb_array_length(amendments) into n from public.outcome_reviews where id = rv;
  if n <> 1 then raise exception '032: the amendment was not appended'; end if;

  -- 6. An amendment with no reason is refused.
  begin
    n := public.amend_outcome_criteria(rv, jsonb_build_object('observation_days', 14), '  ');
    raise exception '032: an amendment without a reason was accepted';
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg like '%032:%' then raise; end if;
  end;
  perform set_config('request.jwt.claim.sub', uid::text, true);
  perform set_config('role', 'authenticated', true);

  -- 7. experimental causal basis is refused without experiment metadata.
  got := public.advance_outcome_review(rv, 'review_due', 'the data settled');
  begin
    got := public.record_outcome_review(rv, 'favourable', 'experimental', 'continue');
    raise exception '032: experimental basis was accepted without a design';
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg like '%032:%' then raise; end if;
  end;
  perform set_config('request.jwt.claim.sub', uid::text, true);
  perform set_config('role', 'authenticated', true);

  -- 8. An observed result IS allowed, and carries the three answers apart.
  got := public.record_outcome_review(rv, 'favourable', 'observed', 'continue',
           14100, 1.0, 'before and after only; no counterfactual', 'keep the new cap');
  if got <> 'reviewed' then raise exception '032: the review did not record'; end if;

  -- 9. Reviewed is terminal, and criteria are frozen.
  begin
    n := public.amend_outcome_criteria(rv, jsonb_build_object('success_threshold', 0.01), 'after the fact');
    raise exception '032: criteria were amended after review';
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg like '%032:%' then raise; end if;
  end;

  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);

  select count(*) into n from public.outcome_review_events where review_id = rv;
  if n < 4 then raise exception '032: the audit trail is incomplete, % events', n; end if;
  raise notice '032: lifecycle verified, % audit events recorded', n;

  delete from public.outcome_reviews where id = rv;
  delete from public.interventions where entity_id = 'TEST-032';
  raise notice '032: verification rows removed';
end;
$v$;
