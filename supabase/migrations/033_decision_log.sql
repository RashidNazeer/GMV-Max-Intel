-- ═══════════════════════════════════════════════════════════════════════════
-- GMV Max Intelligence — 033: one queryable log of the whole operating loop.
--
-- The four records now exist (recommendations, decisions, interventions,
-- outcome reviews) and nothing can read them together. This is the query layer
-- for the Decision log, filtered in SQL rather than in the browser for two
-- reasons: PostgREST caps a select at 1000 rows, so client-side filtering
-- silently searches a truncated set; and "how many are there" must be the real
-- population, not the size of the page we happened to fetch.
--
-- ── A STANDALONE INTERVENTION IS A FIRST-CLASS ROW ─────────────────────────
-- The log is NOT a list of recommendations with extras attached. A budget
-- change made without ever consulting this tool is exactly the history a
-- response model needs, so it appears in its own right, with no recommendation
-- behind it, rather than being invisible until someone thinks to look.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.decision_log(
  p_shop_id   uuid,
  p_search    text default null,
  p_action    text default null,
  p_lifecycle text default null,
  p_lane      text default null,
  p_kind      text default null,
  p_limit     integer default 50,
  p_offset    integer default 0
) returns table (
  kind              text,
  id                uuid,
  occurred_at       timestamptz,
  entity_type       text,
  entity_id         text,
  entity_label      text,
  action_code       text,
  title             text,
  severity          text,
  lane              text,
  decision          text,
  decision_at       timestamptz,
  decision_note     text,
  status            text,
  intervention_count integer,
  confirmation      text,
  policy_exception  boolean,
  review_id         uuid,
  review_lifecycle  text,
  review_due_at     timestamptz,
  metric_outcome    text,
  causal_basis      text,
  review_decision   text,
  total_count       bigint
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  uid uuid := auth.uid();
begin
  if uid is null or not public.can_view_shop(p_shop_id, uid) then
    raise exception 'not authorised for this shop';
  end if;

  return query
  with recs as (
    select
      'recommendation'::text as kind,
      r.id,
      r.generated_at as occurred_at,
      r.scope_type   as entity_type,
      r.scope_id     as entity_id,
      r.scope_label  as entity_label,
      r.action_code,
      r.title,
      r.severity,
      r.lane,
      r.decision,
      r.decision_at,
      r.decision_note,
      r.status,
      (select count(*)::integer from public.interventions i where i.recommendation_id = r.id) as intervention_count,
      null::text    as confirmation,
      false         as policy_exception,
      o.id          as review_id,
      o.lifecycle   as review_lifecycle,
      o.planned_review_at as review_due_at,
      o.metric_outcome,
      o.causal_basis,
      o.review_decision
    from public.recommendations r
    -- The MOST RECENT review for this recommendation. A second review means the
    -- conclusion changed, and the log should show where it stands now.
    left join lateral (
      select * from public.outcome_reviews x
       where x.recommendation_id = r.id
       order by x.created_at desc limit 1
    ) o on true
    where r.shop_id = p_shop_id
  ),
  -- Interventions with NO recommendation behind them. These are the ones the
  -- old model could not express at all.
  standalone as (
    select
      'intervention'::text as kind,
      i.id,
      i.occurred_from as occurred_at,
      i.entity_type,
      i.entity_id,
      coalesce(i.entity_label, i.entity_id) as entity_label,
      i.field         as action_code,
      case
        when i.new_value is null then i.field || ' changed'
        else i.field || ' set to ' || trim(to_char(i.new_value, 'FM999999990.99'))
      end as title,
      case when i.policy_exception then 'warning' else 'info' end as severity,
      'media'::text  as lane,
      null::text     as decision,
      null::timestamptz as decision_at,
      i.reason       as decision_note,
      'recorded'::text as status,
      1              as intervention_count,
      i.confirmation,
      i.policy_exception,
      o.id           as review_id,
      o.lifecycle    as review_lifecycle,
      o.planned_review_at as review_due_at,
      o.metric_outcome,
      o.causal_basis,
      o.review_decision
    from public.interventions i
    left join lateral (
      select * from public.outcome_reviews x
       where x.intervention_id = i.id
       order by x.created_at desc limit 1
    ) o on true
    where i.shop_id = p_shop_id
      and i.recommendation_id is null
  ),
  merged as (
    select * from recs
    union all
    select * from standalone
  ),
  filtered as (
    select * from merged m
     where (p_kind      is null or m.kind = p_kind)
       and (p_action    is null or m.action_code = p_action)
       and (p_lane      is null or m.lane = p_lane)
       -- `lifecycle` searches BOTH the recommendation status and the review
       -- lifecycle, because an operator looking for "what is waiting on me" does
       -- not care which table the state lives in.
       and (p_lifecycle is null or m.status = p_lifecycle or m.review_lifecycle = p_lifecycle)
       and (
         p_search is null or btrim(p_search) = ''
         or m.title        ilike '%' || p_search || '%'
         or m.entity_label ilike '%' || p_search || '%'
         or m.entity_id    ilike '%' || p_search || '%'
         or m.action_code  ilike '%' || p_search || '%'
       )
  ),
  counted as (
    select f.*, count(*) over () as total_count from filtered f
  )
  select
    c.kind, c.id, c.occurred_at, c.entity_type, c.entity_id, c.entity_label,
    c.action_code, c.title, c.severity, c.lane, c.decision, c.decision_at,
    c.decision_note, c.status, c.intervention_count, c.confirmation,
    c.policy_exception, c.review_id, c.review_lifecycle, c.review_due_at,
    c.metric_outcome, c.causal_basis, c.review_decision, c.total_count
  from counted c
  order by c.occurred_at desc nulls last
  limit greatest(1, least(coalesce(p_limit, 50), 200))
  offset greatest(0, coalesce(p_offset, 0));
end;
$fn$;


-- ═══════════════════════════════════════════════════════════════════════════
-- What is waiting on the operator. Drives the Overview indicator.
--
-- Deliberately counts THREE different kinds of unfinished business, because
-- lumping them into one number tells nobody what to do:
--   due        a review whose date has passed and whose data is ready
--   waiting    a review waiting on data that has not settled — NOT overdue
--   undecided  a recommendation nobody has accepted, rejected or deferred
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.operator_queue(p_shop_id uuid)
returns table (
  reviews_due      integer,
  reviews_waiting  integer,
  undecided        integer,
  deferred_ready   integer,
  oldest_due_at    timestamptz
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
    (select count(*)::integer from public.outcome_reviews o
      where o.shop_id = p_shop_id and o.lifecycle = 'review_due'),
    (select count(*)::integer from public.outcome_reviews o
      where o.shop_id = p_shop_id and o.lifecycle = 'awaiting_data'),
    (select count(*)::integer from public.recommendations r
      where r.shop_id = p_shop_id
        and r.decision is null
        and r.status in ('proposed', 'planned')),
    -- A deferral whose review date has arrived is work again.
    (select count(*)::integer from public.recommendations r
      where r.shop_id = p_shop_id
        and r.decision = 'defer'
        and r.defer_until is not null
        and r.defer_until <= now()),
    (select min(o.planned_review_at) from public.outcome_reviews o
      where o.shop_id = p_shop_id and o.lifecycle = 'review_due');
end;
$fn$;


-- ═══════════════════════════════════════════════════════════════════════════
-- Everything known about one entry, for the detail view.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.intervention_history(
  p_shop_id uuid, p_entity_type text default null, p_entity_id text default null, p_limit integer default 100
) returns table (
  id uuid, occurred_from timestamptz, occurred_to timestamptz, time_basis text,
  entity_type text, entity_id text, entity_label text,
  field text, old_value numeric, new_value numeric, value_unit text,
  confirmation text, actor uuid, actor_name text, reason text,
  recommendation_id uuid, reverses_id uuid, policy_exception boolean, policy_note text
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
  select i.id, i.occurred_from, i.occurred_to, i.time_basis,
         i.entity_type, i.entity_id, coalesce(i.entity_label, i.entity_id),
         i.field, i.old_value, i.new_value, i.value_unit,
         i.confirmation, i.actor, p.display_name, i.reason,
         i.recommendation_id, i.reverses_id, i.policy_exception, i.policy_note
    from public.interventions i
    left join public.profiles p on p.id = i.actor
   where i.shop_id = p_shop_id
     and (p_entity_type is null or i.entity_type = p_entity_type)
     and (p_entity_id   is null or i.entity_id = p_entity_id)
   order by i.occurred_from desc
   limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$fn$;


do $g$
declare s text;
begin
  foreach s in array array[
    'public.decision_log(uuid, text, text, text, text, text, integer, integer)',
    'public.operator_queue(uuid)',
    'public.intervention_history(uuid, text, text, integer)'
  ] loop
    execute format('revoke all on function %s from public', s);
    execute format('revoke all on function %s from anon', s);
    execute format('grant execute on function %s to authenticated', s);
  end loop;
end;
$g$;

comment on function public.decision_log(uuid, text, text, text, text, text, integer, integer) is
  'The whole operating loop in one filterable list: recommendations with their decisions and reviews, plus interventions recorded with no recommendation behind them. Filtered in SQL because PostgREST truncates at 1000 rows and a client-side filter would silently search a partial set. total_count is the real population, not the page size.';


-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY
-- ═══════════════════════════════════════════════════════════════════════════
do $v$
declare
  shop uuid; uid uuid; iv uuid; n integer; tot bigint; msg text;
begin
  select id into shop from public.shops where shop_name ilike 'Biostime%' limit 1;
  select p.id into uid from public.profiles p where public.can_view_shop(shop, p.id) limit 1;
  if shop is null or uid is null then
    raise notice '033: no shop or user, checks skipped';
    return;
  end if;

  perform set_config('request.jwt.claim.sub', uid::text, true);
  perform set_config('role', 'authenticated', true);

  -- The log must already return the recommendations this shop has.
  select count(*)::integer into n from public.decision_log(shop, null, null, null, null, null, 200, 0);
  raise notice '033: decision log returns % entries', n;
  if n = 0 then
    raise exception '033: the log is empty, but this shop holds recommendations';
  end if;

  -- total_count must be the POPULATION, not the page.
  select dl.total_count into tot from public.decision_log(shop, null, null, null, null, null, 1, 0) dl;
  if tot < n then
    raise exception '033: total_count % is smaller than a full page of %', tot, n;
  end if;

  -- A standalone intervention must appear in its own right.
  iv := public.record_intervention(
    shop, 'campaign', 'TEST-033', 'daily_budget', 700, 550,
    now(), now(), 'manual_report', 'changed outside the tool');
  select count(*)::integer into n
    from public.decision_log(shop, 'TEST-033', null, null, null, null, 50, 0);
  if n <> 1 then
    raise exception '033: a standalone intervention did not appear in the log, got %', n;
  end if;

  select count(*)::integer into n
    from public.decision_log(shop, null, null, null, null, 'intervention', 200, 0);
  if n < 1 then raise exception '033: filtering by kind=intervention returned nothing'; end if;

  -- The queue must count undecided recommendations.
  select q.undecided into n from public.operator_queue(shop) q;
  raise notice '033: operator queue — % undecided', n;

  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  delete from public.interventions where entity_id = 'TEST-033';
  raise notice '033: decision log verified';
end;
$v$;
