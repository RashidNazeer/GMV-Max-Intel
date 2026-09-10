-- ═══════════════════════════════════════════════════════════════════════════
-- GMV Max Intelligence — 036: what we learned last time reaches the next
-- recommendation.
--
-- Every layer so far records. Nothing yet READS BACK. A buyer could accept a
-- recommendation, apply it, watch it breach a guardrail, review it honestly —
-- and the next identical situation would produce the same confident advice, as
-- though none of it had happened.
--
-- ── TRANSPARENT CASE SUPPORT, NOT A FITTED EFFECT ──────────────────────────
-- With a handful of reviewed episodes the only defensible use of history is to
-- SHOW THE CASES and let them raise caution. Fitting a response function to
-- three outcomes and quoting a coefficient would be inventing precision from
-- noise. So this returns EPISODES, with why each was included or excluded, and
-- the engine applies stated rules to them:
--
--   a comparable episode ended unfavourably     -> raise the risk, and require
--                                                  a smaller operator-chosen test
--   a comparable episode was confounded         -> it is context, never proof
--   only favourable episodes exist              -> say how few, and that a
--                                                  small favourable run is not
--                                                  a response function
--
-- ── NEGATIVE AND REJECTED CASES ARE KEPT ───────────────────────────────────
-- Selecting only favourable history is how a tool talks itself into a habit.
-- Unfavourable, mixed, inconclusive and unmeasurable outcomes are all returned,
-- and the engine weights the unfavourable ones HARDER than the favourable —
-- asymmetric on purpose, because the cost of repeating a bad change exceeds the
-- benefit of repeating a good one.
--
-- ── WHAT APPLIED OUTCOMES CANNOT TELL US ───────────────────────────────────
-- Applied actions are a SELECTED subset: they are the ones somebody agreed to.
-- Their outcomes say nothing about what the rejected alternatives would have
-- done, and nothing here treats them as if they did. Rejections are counted and
-- surfaced separately, as evidence about what this operator declines rather
-- than about what would have worked.
--
-- ── WHAT THIS RETURNS TODAY ────────────────────────────────────────────────
-- no_reviewed_history. Not one outcome review has been completed yet. The
-- capability exists so the first review changes the next recommendation, rather
-- than being written down and never read.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.learning_policy_version() returns text
language sql immutable as $$ select '2026-09-10.1'::text $$;

comment on function public.learning_policy_version() is
  'The version of the rules that turn reviewed episodes into caution. A recommendation records this, so advice given under one policy is never silently compared with advice given under another.';


create or replace function public.comparable_reviewed_cases(
  p_shop_id   uuid,
  p_action    text,
  p_entity_id text default null,
  p_limit     integer default 20
) returns table (
  review_id        uuid,
  intervention_id  uuid,
  action_code      text,
  entity_id        text,
  entity_label     text,
  direction        text,
  field            text,
  old_value        numeric,
  new_value        numeric,
  occurred_at      timestamptz,
  metric_outcome   text,
  causal_basis     text,
  review_decision  text,
  confounders      integer,
  policy_exception boolean,
  same_entity      boolean,
  eligible         boolean,
  why              text
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
  with reviewed as (
    select
      o.id as review_id,
      o.intervention_id,
      coalesce(r.action_code, i.field) as action_code,
      i.entity_id,
      coalesce(i.entity_label, i.entity_id) as entity_label,
      i.field,
      i.old_value,
      i.new_value,
      i.occurred_from as occurred_at,
      o.metric_outcome,
      o.causal_basis,
      o.review_decision,
      jsonb_array_length(coalesce(o.confounders, '[]'::jsonb)) as confounders,
      coalesce(i.policy_exception, false) as policy_exception,
      case
        when i.new_value is null or i.old_value is null then null
        when i.new_value > i.old_value then 'increase'
        else 'decrease'
      end as direction
    from public.outcome_reviews o
    left join public.interventions i on i.id = o.intervention_id
    left join public.recommendations r on r.id = o.recommendation_id
    where o.shop_id = p_shop_id
      and o.lifecycle = 'reviewed'
  ),
  judged as (
    select
      w.*,
      (p_entity_id is not null and w.entity_id = p_entity_id) as same_entity,
      -- ELIGIBILITY. A case can be shown and still not be usable as evidence.
      -- Both are returned, because "we have three cases and none of them tells
      -- you anything" is a more useful answer than an empty list.
      case
        when w.confounders > 0 then false
        when w.metric_outcome = 'unmeasurable' then false
        when w.causal_basis is null then false
        else true
      end as eligible,
      case
        when w.confounders > 0 then
          format('%s recorded event(s) overlapped this episode, so its result cannot be read as a response to the change alone', w.confounders)
        when w.metric_outcome = 'unmeasurable' then
          'the result was not measurable, so it says nothing either way'
        when w.policy_exception then
          'usable, but the change was made outside the guardrails and its context may not repeat'
        when w.causal_basis = 'observed' then
          'usable as a case: before-and-after only, which shows what happened but not what caused it'
        else 'usable as a case'
      end as why
    from reviewed w
  )
  select
    j.review_id, j.intervention_id, j.action_code, j.entity_id, j.entity_label,
    j.direction, j.field, j.old_value, j.new_value, j.occurred_at,
    j.metric_outcome, j.causal_basis, j.review_decision, j.confounders,
    j.policy_exception, j.same_entity, j.eligible, j.why
  from judged j
  where p_action is null
     or j.action_code = p_action
     -- A recommendation code and the field an intervention actually changed are
     -- different vocabularies; match either so a Target ROI recommendation finds
     -- a hand-recorded target_roi change.
     or (p_action in ('increase_target_roi', 'decrease_target_roi') and j.field = 'target_roi')
     or (p_action in ('increase_budget', 'decrease_budget') and j.field = 'daily_budget')
  -- The SAME campaign first, then most recent. Recency matters more than volume
  -- when there are few cases: a result from March describes a different
  -- creative supply and a different market.
  order by j.same_entity desc nulls last, j.occurred_at desc nulls last
  limit greatest(1, least(coalesce(p_limit, 20), 100));
end;
$fn$;


-- ═══════════════════════════════════════════════════════════════════════════
-- A compact summary the decision engine can reason from without re-deriving it.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.reviewed_history_summary(
  p_shop_id uuid, p_action text, p_entity_id text default null
) returns table (
  status            text,
  cases_total       integer,
  cases_eligible    integer,
  favourable        integer,
  unfavourable      integer,
  mixed             integer,
  confounded        integer,
  reverted          integer,
  most_recent_at    timestamptz,
  caution           text,
  policy_version    text
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
  with c as (
    select * from public.comparable_reviewed_cases(p_shop_id, p_action, p_entity_id, 100)
  ),
  agg as (
    select
      count(*)::integer                                                as total,
      count(*) filter (where c.eligible)::integer                      as elig,
      count(*) filter (where c.eligible and c.metric_outcome = 'favourable')::integer   as fav,
      count(*) filter (where c.eligible and c.metric_outcome = 'unfavourable')::integer as unfav,
      count(*) filter (where c.eligible and c.metric_outcome = 'mixed')::integer        as mix,
      count(*) filter (where c.confounders > 0)::integer               as conf,
      count(*) filter (where c.review_decision = 'revert')::integer    as rev,
      max(c.occurred_at)                                               as recent
    from c
  )
  select
    case
      when a.total = 0 then 'no_reviewed_history'
      when a.elig = 0 then 'all_cases_confounded'
      -- ASYMMETRIC ON PURPOSE. One unfavourable case is enough to raise
      -- caution; one favourable case is not enough to lower it.
      when a.unfav > 0 or a.rev > 0 then 'caution_from_history'
      when a.elig = 1 then 'single_case'
      else 'supported_by_history'
    end,
    a.total, a.elig, a.fav, a.unfav, a.mix, a.conf, a.rev, a.recent,
    case
      when a.total = 0 then
        'No comparable change has been reviewed yet, so there is nothing to learn from. The first completed review will change this.'
      when a.elig = 0 then
        format('%s comparable case(s), none usable: each had something else moving at the same time, so none can be read as a response to the change.', a.total)
      when a.rev > 0 then
        format('A comparable change was REVERTED after review. Treat a repeat as a smaller test and say what would make you stop.')
      when a.unfav > 0 then
        format('%s of %s comparable case(s) ended unfavourably. That is a reason to size any repeat smaller, not a reason to refuse it.', a.unfav, a.elig)
      when a.elig = 1 then
        'One comparable case, and it went well. A single result is a case, not a response function — it cannot say how much of the effect was the change.'
      else
        format('%s comparable case(s), %s favourable. Still cases rather than a measured response: the outcomes are observed, not experimental.', a.elig, a.fav)
    end,
    public.learning_policy_version()
  from agg a;
end;
$fn$;


-- ═══════════════════════════════════════════════════════════════════════════
-- The replay report. Requirement: "a minimal historical replay and evaluation
-- report to demonstrate the learning path without claiming an unavailable
-- causal comparison."
--
-- It answers one question honestly: of the recommendations this tool issued,
-- which were acted on, and what happened? It deliberately does NOT compare
-- accepted against rejected as though that were a controlled trial — the
-- accepted ones are the ones somebody agreed to, which is exactly the
-- selection this report must not launder into a result.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.learning_replay(p_shop_id uuid)
returns table (
  action_code        text,
  issued             integer,
  accepted           integer,
  modified           integer,
  rejected           integer,
  deferred           integer,
  undecided          integer,
  interventions      integer,
  reviewed           integer,
  favourable         integer,
  unfavourable       integer,
  caveat             text
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
  select
    r.action_code,
    count(*)::integer,
    count(*) filter (where r.decision = 'accept')::integer,
    count(*) filter (where r.decision = 'modify')::integer,
    count(*) filter (where r.decision = 'reject')::integer,
    count(*) filter (where r.decision = 'defer')::integer,
    count(*) filter (where r.decision is null)::integer,
    (select count(*)::integer from public.interventions i where i.recommendation_id = r.id),
    (select count(*)::integer from public.outcome_reviews o
      where o.recommendation_id = r.id and o.lifecycle = 'reviewed'),
    (select count(*)::integer from public.outcome_reviews o
      where o.recommendation_id = r.id and o.metric_outcome = 'favourable'),
    (select count(*)::integer from public.outcome_reviews o
      where o.recommendation_id = r.id and o.metric_outcome = 'unfavourable'),
    'Accepted recommendations are the ones somebody agreed to. Their outcomes cannot say what the rejected ones would have done.'::text
  from public.recommendations r
  where r.shop_id = p_shop_id
  group by r.action_code, r.id
  order by r.action_code;
end;
$fn$;

do $g$
declare s text;
begin
  foreach s in array array[
    'public.comparable_reviewed_cases(uuid, text, text, integer)',
    'public.reviewed_history_summary(uuid, text, text)',
    'public.learning_replay(uuid)',
    'public.learning_policy_version()'
  ] loop
    execute format('revoke all on function %s from public', s);
    execute format('revoke all on function %s from anon', s);
    execute format('grant execute on function %s to authenticated', s);
  end loop;
end;
$g$;

comment on function public.comparable_reviewed_cases(uuid, text, text, integer) is
  'Reviewed episodes comparable to a proposed action, each with why it is or is not usable as evidence. Returns unfavourable, mixed and inconclusive cases as well as favourable ones — selecting only favourable history is how a tool talks itself into a habit.';


-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY
-- ═══════════════════════════════════════════════════════════════════════════
do $v$
declare
  shop uuid; uid uuid; s record; n integer;
begin
  select id into shop from public.shops where shop_name ilike 'Biostime%' limit 1;
  select p.id into uid from public.profiles p where public.can_view_shop(shop, p.id) limit 1;
  if shop is null or uid is null then
    raise notice '036: no shop or user, checks skipped';
    return;
  end if;

  perform set_config('request.jwt.claim.sub', uid::text, true);
  perform set_config('role', 'authenticated', true);

  select count(*)::integer into n
    from public.comparable_reviewed_cases(shop, 'decrease_target_roi', null, 20);
  raise notice '036: % comparable reviewed cases for decrease_target_roi', n;

  select * into s from public.reviewed_history_summary(shop, 'decrease_target_roi', null);
  raise notice '036: status=%  total=%  eligible=%', s.status, s.cases_total, s.cases_eligible;
  raise notice '036:   %', s.caution;

  -- THE HONEST ANSWER TODAY. Nothing has been reviewed, so nothing may be
  -- claimed. If this ever reports support from history with zero cases, the rules
  -- have drifted from the evidence.
  if s.cases_total = 0 and s.status <> 'no_reviewed_history' then
    raise exception '036: claimed % with no reviewed cases', s.status;
  end if;

  select count(*)::integer into n from public.learning_replay(shop);
  raise notice '036: replay report covers % recommendation(s)', n;

  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  raise notice '036: verified';
end;
$v$;
