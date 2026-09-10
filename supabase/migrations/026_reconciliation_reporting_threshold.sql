-- ═══════════════════════════════════════════════════════════════════════════
-- 026 — a reconciliation gap is worth an operator's attention at 10%, not 0.5%
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The business tolerance was 0.5% of shop GMV. On Biostime that flagged twelve
-- of thirty days over a ~1% disagreement — about $138 on ~$13,900 — and put a
-- warning in front of a buyer every single day about something they cannot act
-- on and that is not going to change: the two sources genuinely differ on the
-- same days, which was tested and is NOT a date-boundary bug (a one-day shift
-- aligns the series better on 1 day out of 29, and worse on 28).
--
-- A warning that appears every day about a condition nobody can fix is a
-- warning people learn to scroll past — and then they scroll past the one that
-- matters. The owner set the bar at 10%.
--
-- ── WHAT THIS CHANGES, AND WHAT IT DELIBERATELY DOES NOT ───────────────────
-- It changes the STATUS a window is given, and therefore what the UI shows.
-- It does NOT change any measurement. The signed gap, the absolute gap, the
-- per-day differences and the affiliate capture ratio are all computed exactly
-- as before and are all still returned. Data status shows every day that
-- disagrees regardless of size, because that page exists to be thorough.
-- Nothing is hidden; the threshold decides what is worth interrupting someone
-- about.
--
-- ── THE CONSEQUENCE, STATED PLAINLY ────────────────────────────────────────
-- `CHECKS.reconciled` in the decision layer gates on
-- `reconciliation_status = 'exception'`. Raising the threshold therefore means
-- a discrepancy between 0.5% and 10% no longer blocks a spend recommendation.
-- That is the owner's stated risk appetite and it is a deliberate trade, not an
-- oversight: below 10% the tool will now recommend on data it previously
-- refused to reason from. The rounding tolerance is untouched, so an exact
-- agreement is still distinguishable from a tolerated one.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.recon_business_tolerance() returns numeric
language sql immutable as $$ select 0.10::numeric $$;      -- 10% of total shop GMV

comment on function public.recon_business_tolerance() is
  'Fractional gap beyond which two sources genuinely disagree and a user-facing exception is raised. Raised from 0.5% to 10% on 2026-09-10: a persistent ~1% source disagreement was interrupting the buyer daily about something they cannot act on. Measurements are unchanged — only the threshold for calling it an exception. Data status still lists every disagreeing day at any size.';


-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY — the threshold moved, the arithmetic did not
-- ═══════════════════════════════════════════════════════════════════════════
do $v$
declare
  shop_id uuid;
  win record;
  daily_sum numeric := 0;
  d record;
begin
  if public.recon_business_tolerance() <> 0.10 then
    raise exception 'business tolerance did not take: %', public.recon_business_tolerance();
  end if;
  -- Rounding tolerance must NOT have moved. Exact agreement and tolerated
  -- disagreement stay distinguishable.
  if public.recon_rounding_tolerance() <> 0.50 then
    raise exception 'rounding tolerance was changed and should not have been: %',
      public.recon_rounding_tolerance();
  end if;

  select id into shop_id from public.shops where shop_name ilike 'Biostime%' limit 1;
  if shop_id is null then
    raise notice 'no Biostime shop — measurement check skipped';
    return;
  end if;

  -- THE MEASUREMENTS ARE UNCHANGED. The window gap must still equal the sum of
  -- the daily gaps: this is the identity migration 022 established and it must
  -- survive a threshold change untouched.
  for d in select * from public.shop_channel_daily(shop_id, '2026-08-09', '2026-09-07') loop
    daily_sum := daily_sum + d.reconciliation_gap;
  end loop;

  select * into win from public.shop_attribution(shop_id, '2026-08-09', '2026-09-07');
  if abs(win.reconciliation_gap - daily_sum) > 0.01 then
    raise exception 'the daily/window identity broke: window % vs daily sum %',
      win.reconciliation_gap, daily_sum;
  end if;

  raise notice 'VERIFIED: gap % (%.2f%% of %) is now "%" — arithmetic unchanged, threshold 10%%',
    round(win.reconciliation_gap, 2),
    round(100 * abs(win.reconciliation_gap) / nullif(win.total_gmv, 0), 2),
    round(win.total_gmv, 2),
    win.reconciliation_status;
end;
$v$;
