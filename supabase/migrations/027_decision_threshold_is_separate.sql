-- ═══════════════════════════════════════════════════════════════════════════
-- GMV Max Intelligence — 027: the reporting threshold is not the decision
-- threshold, and this function must say so.
--
-- Migration 026 raised `recon_business_tolerance()` from 0.5% to 10% because a
-- persistent ~1% disagreement between two providers was painting an exception
-- on every screen about something nobody can fix. That was the right call and
-- it is unchanged here.
--
-- What 026 did not say is that this ONE function had TWO consumers. Besides the
-- user-facing status, `CHECKS.reconciled` in src/lib/decide.js read the same
-- verdict, and the recommendation engine refuses to reason about channel shares
-- while the components and the source total disagree. So quietening the screens
-- also, silently, made the engine willing to size a budget on top of a 9%
-- disagreement — a change to how money gets advised, arrived at as a
-- side-effect of a request about where a banner appears.
--
-- The engine now keeps its own, tighter number: DECISION_RECON_TOLERANCE = 3%
-- in src/lib/decide.js. Nothing in the database changes — the split is entirely
-- on the consuming side, which is why this migration alters no behaviour and
-- only writes down what a reader of this function needs to know before moving
-- it again.
--
-- WHY 3%. It has to clear the real noise with margin (Biostime sits near 1%),
-- and it has to stay far enough below the reporting threshold that "quiet on
-- screen" never means "safe to spend against". Between 3% and 10% the screens
-- stay clean and the engine declines — a band that has not occurred in live
-- data. This is a guard, not a behaviour anyone sees today.
--
-- IF YOU CHANGE THIS FUNCTION, decide whether the engine's number should move
-- with it. They are separate on purpose; they are not independent of each other.
-- ═══════════════════════════════════════════════════════════════════════════

comment on function public.recon_business_tolerance() is
  'REPORTING threshold only. Fractional gap beyond which two sources genuinely disagree and a user-facing exception is raised. 0.5% -> 10% on 2026-09-10: a persistent ~1% source disagreement was interrupting the buyer daily about something they cannot act on. Measurements are unchanged; Data status still lists every disagreeing day at any size. NOT the threshold the recommendation engine uses — that is DECISION_RECON_TOLERANCE (3%) in src/lib/decide.js, deliberately tighter, because "not worth a banner" and "safe to allocate budget against" are different questions. Changing this does not change that.';

comment on function public.recon_rounding_tolerance() is
  'ABSOLUTE currency tolerance below which a gap is exact agreement rather than a tolerated one. Applied before either fractional threshold, so a sub-dollar gap is never a data problem at any percentage — including on a near-zero-GMV window where the percentage is meaningless.';


-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY — this migration must change no behaviour whatsoever
-- ═══════════════════════════════════════════════════════════════════════════
do $v$
declare
  shop_id uuid;
  st text;
  pctv numeric;
begin
  if public.recon_business_tolerance() <> 0.10 then
    raise exception '027 must not move the reporting threshold, found %',
      public.recon_business_tolerance();
  end if;
  if public.recon_rounding_tolerance() <> 0.50 then
    raise exception '027 must not move the rounding tolerance, found %',
      public.recon_rounding_tolerance();
  end if;

  select id into shop_id from public.shops where shop_name ilike 'Biostime%' limit 1;
  if shop_id is null then
    raise notice '027: no Biostime shop — live status check skipped';
    return;
  end if;

  select a.reconciliation_status, a.reconciliation_pct
    into st, pctv
    from public.shop_attribution(shop_id, current_date - 30, current_date - 3) a;

  raise notice '027: Biostime window status=% pct=%',
    st, round(coalesce(pctv, 0) * 100, 2);

  -- The case this whole split exists for: on the live shop the screens are
  -- quiet AND the engine tolerates it, because the gap is around 1%.
  if pctv is not null and abs(pctv) > 0.03 then
    raise notice '027: NOTE — live gap %%% exceeds the engine tolerance of 3%%; the data action will fire while the screens stay quiet. That is intended, but worth knowing.',
      round(abs(pctv) * 100, 2);
  end if;
end;
$v$;
