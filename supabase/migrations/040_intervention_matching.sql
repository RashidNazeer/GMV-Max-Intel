-- ═══════════════════════════════════════════════════════════════════════════
-- GMV Max Intelligence — 040: linking a detected change to the person who
-- reported it, without merging them and without counting it twice.
--
-- ── THE GAP THIS CLOSES ────────────────────────────────────────────────────
-- interventions carries `matched_id` and `match_confidence`, and nothing could
-- write them. The table is deliberately append-only — no UPDATE policy — so a
-- client attempting the link silently matched zero rows and reported success.
-- Found by the T22 acceptance check, which is the only reason it was found at
-- all: the columns existed, so the schema looked complete.
--
-- ── WHY LINK AND NOT MERGE ─────────────────────────────────────────────────
-- A buyer says "I raised the budget yesterday afternoon". Two days later the
-- sync notices the value changed between two observations. These are two
-- ACCOUNTS of one event and they are not interchangeable:
--
--   the report      knows who and why, and roughly when
--   the detection   knows the value moved, and brackets when, but cannot name
--                   an actor and cannot give an instant
--
-- Merging them would discard whichever fields the survivor lacked. Treating
-- them as two interventions would double-count the event in every episode that
-- reads this table. So they stay two rows with a link between them, and
-- anything counting interventions counts unmatched rows plus one per matched
-- pair.
--
-- ── AMBIGUITY IS PRESERVED, NOT RESOLVED ───────────────────────────────────
-- If two manual reports could both explain one detected change, picking the
-- nearer one would be inventing a fact. The link is recorded as `ambiguous`
-- and every candidate is kept, so a later reader can see the choice was never
-- made rather than inheriting a guess.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.interventions
  add column if not exists match_candidates jsonb not null default '[]'::jsonb;

comment on column public.interventions.match_candidates is
  'Every manual report that could explain this detected change. Populated when more than one is compatible: picking the nearest would invent a fact, so the ambiguity is kept where a reader can see it.';


create or replace function public.match_intervention(
  p_intervention_id uuid,
  p_window_hours    integer default 72
) returns table (
  outcome        text,
  matched_id     uuid,
  confidence     text,
  candidates     integer,
  note           text
)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  det   public.interventions%rowtype;
  uid   uuid := auth.uid();
  cands uuid[];
  n     integer;
  pick  uuid;
  conf  text;
  exact boolean;
begin
  if uid is null then
    raise exception 'match_intervention requires an authenticated user';
  end if;

  select * into det from public.interventions where id = p_intervention_id;
  if not found then raise exception 'no such intervention'; end if;
  if not public.can_view_shop(det.shop_id, uid) then
    raise exception 'not authorised for this shop';
  end if;

  -- Only a DETECTED change needs matching. A manual report is already the
  -- account with the most in it.
  if det.confirmation <> 'snapshot_detected' then
    return query select 'not_applicable'::text, null::uuid, null::text, 0,
      'Only a snapshot-detected change needs matching to a report.'::text;
    return;
  end if;

  if det.matched_id is not null then
    return query select 'already_matched'::text, det.matched_id, det.match_confidence, 1,
      'This change is already linked to a report.'::text;
    return;
  end if;

  -- CANDIDATES: same entity, same field, a compatible value transition, and a
  -- time that could plausibly be the same event. All three must agree — a
  -- budget change on the right campaign at the wrong time is a different event.
  select array_agg(m.id order by abs(extract(epoch from (m.occurred_from - det.occurred_from))))
    into cands
    from public.interventions m
   where m.shop_id = det.shop_id
     and m.confirmation = 'manual_report'
     and m.entity_type = det.entity_type
     and m.entity_id = det.entity_id
     and m.field = det.field
     and m.id <> det.id
     -- Not already spoken for by another detection.
     and not exists (select 1 from public.interventions x where x.matched_id = m.id)
     -- The reported window and the detected interval must overlap, allowing for
     -- a person's memory of "yesterday afternoon" being loose.
     and m.occurred_from <= det.occurred_to + make_interval(hours => p_window_hours)
     and m.occurred_to   >= det.occurred_from - make_interval(hours => p_window_hours)
     -- And the value must actually have moved the same way.
     and (m.new_value is not distinct from det.new_value
          or (m.new_value is not null and det.new_value is not null
              and abs(m.new_value - det.new_value) < 0.005));

  n := coalesce(array_length(cands, 1), 0);

  if n = 0 then
    return query select 'no_match'::text, null::uuid, null::text, 0,
      'No manual report explains this change. It is kept as an unattributed detection, which is a real state — somebody changed something and did not say so.'::text;
    return;
  end if;

  if n > 1 then
    -- AMBIGUOUS. Record every candidate and link none: choosing the closest in
    -- time would manufacture an attribution nobody made.
    update public.interventions
       set match_confidence = 'ambiguous',
           match_candidates = to_jsonb(cands)
     where id = det.id;
    return query select 'ambiguous'::text, null::uuid, 'ambiguous'::text, n,
      format('%s manual reports could explain this change. None is linked, because picking one would invent an attribution.', n)::text;
    return;
  end if;

  pick := cands[1];
  -- EXACT when the reported moment sits inside the detected interval; PROBABLE
  -- when it is merely nearby. The difference is worth keeping: an episode built
  -- on a probable match carries more uncertainty about its own timing.
  select (m.occurred_from >= det.occurred_from and m.occurred_to <= det.occurred_to)
    into exact
    from public.interventions m where m.id = pick;
  conf := case when exact then 'exact' else 'probable' end;

  update public.interventions
     set matched_id = pick,
         match_confidence = conf,
         match_candidates = to_jsonb(cands)
   where id = det.id;

  return query select 'matched'::text, pick, conf, 1,
    format('Linked to one manual report (%s). The two rows both stand: the report knows who and why, the detection knows the value moved and brackets when.', conf)::text;
end;
$fn$;

do $g$
declare sig text := 'public.match_intervention(uuid, integer)';
begin
  execute format('revoke all on function %s from public', sig);
  execute format('revoke all on function %s from anon', sig);
  execute format('grant execute on function %s to authenticated', sig);
end;
$g$;


-- ── counting without double counting ───────────────────────────────────────
-- Anything reading this table for "how many changes happened" must count a
-- matched PAIR once. This is the one supported way to ask.
create or replace function public.distinct_interventions(
  p_shop_id uuid, p_from timestamptz default null, p_to timestamptz default null
) returns integer
language sql
stable
security definer
set search_path = public
as $fn$
  select count(*)::integer
    from public.interventions i
   where i.shop_id = p_shop_id
     and (p_from is null or i.occurred_to >= p_from)
     and (p_to is null or i.occurred_from <= p_to)
     -- A detection linked to a report is the SAME event as that report, so only
     -- the report is counted. An unmatched detection counts in its own right:
     -- somebody changed something and did not say so, and that happened.
     and i.matched_id is null
     and (auth.uid() is not null and public.can_view_shop(p_shop_id, auth.uid()));
$fn$;

do $g$
begin
  revoke all on function public.distinct_interventions(uuid, timestamptz, timestamptz) from public;
  revoke all on function public.distinct_interventions(uuid, timestamptz, timestamptz) from anon;
  grant execute on function public.distinct_interventions(uuid, timestamptz, timestamptz) to authenticated;
end;
$g$;

comment on function public.distinct_interventions(uuid, timestamptz, timestamptz) is
  'How many changes actually happened. A detection linked to a manual report is the same event as that report and is counted once; an unmatched detection counts on its own, because somebody changed something and did not say so.';


-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY
-- ═══════════════════════════════════════════════════════════════════════════
do $v$
declare
  shop uuid; uid uuid;
  rep1 uuid; rep2 uuid; det uuid; r record; n integer;
begin
  select id into shop from public.shops where shop_name ilike 'Biostime%' limit 1;
  select p.id into uid from public.profiles p where public.can_view_shop(shop, p.id) limit 1;
  if shop is null or uid is null then
    raise notice '040: no shop or user, checks skipped';
    return;
  end if;

  perform set_config('request.jwt.claim.sub', uid::text, true);
  perform set_config('role', 'authenticated', true);

  -- One report, one detection of the same change.
  rep1 := public.record_intervention(shop, 'campaign', 'MATCH-040', 'daily_budget',
            700, 550, now() - interval '30 hours', now() - interval '30 hours',
            'manual_report', 'I raised it yesterday');
  det := public.record_intervention(shop, 'campaign', 'MATCH-040', 'daily_budget',
            700, 550, now() - interval '36 hours', now() - interval '12 hours',
            'snapshot_detected', 'seen by the sync');

  select * into r from public.match_intervention(det);
  if r.outcome <> 'matched' then
    raise exception '040: one report should have matched, got %', r.outcome;
  end if;
  -- The reported moment sits inside the detected interval, so this is exact.
  if r.confidence <> 'exact' then
    raise exception '040: expected an exact match, got %', r.confidence;
  end if;
  raise notice '040: a single compatible report links, confidence %', r.confidence;

  -- BOTH ROWS SURVIVE. Merging would lose one account of the event.
  select count(*)::integer into n from public.interventions where entity_id = 'MATCH-040';
  if n <> 2 then raise exception '040: expected both rows to stand, found %', n; end if;

  -- And the pair counts ONCE.
  if public.distinct_interventions(shop, now() - interval '3 days', now()) <> 1 then
    raise exception '040: a matched pair was not counted once';
  end if;
  raise notice '040: both rows stand, and the pair counts once';

  -- AMBIGUITY. Two reports that could each explain one detection.
  delete from public.interventions where entity_id = 'MATCH-040';
  rep1 := public.record_intervention(shop, 'campaign', 'MATCH-040b', 'daily_budget',
            800, 600, now() - interval '20 hours', now() - interval '20 hours',
            'manual_report', 'first report');
  rep2 := public.record_intervention(shop, 'campaign', 'MATCH-040b', 'daily_budget',
            800, 600, now() - interval '28 hours', now() - interval '28 hours',
            'manual_report', 'second report');
  det := public.record_intervention(shop, 'campaign', 'MATCH-040b', 'daily_budget',
            800, 600, now() - interval '30 hours', now() - interval '10 hours',
            'snapshot_detected', 'seen by the sync');

  select * into r from public.match_intervention(det);
  if r.outcome <> 'ambiguous' or r.matched_id is not null then
    raise exception '040: two candidates should stay ambiguous, got % (matched %)', r.outcome, r.matched_id;
  end if;
  if r.candidates <> 2 then
    raise exception '040: expected 2 candidates, got %', r.candidates;
  end if;
  raise notice '040: two candidates stay ambiguous and neither is chosen';

  -- A detection nobody reported stays unattributed. That is a real state.
  delete from public.interventions where entity_id = 'MATCH-040b';
  det := public.record_intervention(shop, 'campaign', 'MATCH-040c', 'target_roi',
            1.4, 1.5, now() - interval '5 hours', now() - interval '1 hour',
            'snapshot_detected', 'nobody reported this');
  select * into r from public.match_intervention(det);
  if r.outcome <> 'no_match' then
    raise exception '040: an unreported change should be no_match, got %', r.outcome;
  end if;
  raise notice '040: an unreported change stays unattributed';

  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  delete from public.interventions where entity_id like 'MATCH-040%';
  raise notice '040: verified';
end;
$v$;
