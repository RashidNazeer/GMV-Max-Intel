-- ═══════════════════════════════════════════════════════════════════════════
-- 022 — the affiliate excess was counted TWICE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Measured on Biostime, 2026-09-01 → 09-07, before this migration:
--
--   ad-driven affiliate      808.43
--   organic affiliate        681.78     paid + organic = 1,490.21
--   affiliate, no line data   67.96
--   affiliate, EXCESS         70.34     <-- added as its own revenue band
--   seller video             592.42
--   LIVE                       0.00
--   product card             389.59
--   component total        2,610.52
--   source shop GMV        2,469.84
--   signed gap               140.68  =  EXACTLY 2 x 70.34
--
-- WHY. `overflow` is defined as greatest(ours - aff_sc, 0) — the amount by
-- which OUR affiliate video lines exceed what Seller Center reports for
-- affiliate video. But the reconstruction already carries our lines in full,
-- because paid + organic IS `ours` (verified: every video line in the window
-- classifies to exactly one of PAID_SHOP_ADS or ORGANIC_STANDARD, nothing
-- lands in a third bucket). So:
--
--   components = ours + overflow + seller + live + pcard
--              = (aff_sc + overflow) + overflow + seller + live + pcard
--              = total_gmv + 2 x overflow
--
-- The excess is inside `ours`, and was then added a second time on top of it.
-- Every day in the window showed gap = 2 x overflow, not approximately — the
-- ratio was 2.0000.
--
-- THE CORRECTED IDENTITY. `overflow` becomes a NON-ADDITIVE DIAGNOSTIC. It is
-- still computed, still returned, still shown — it is a real and important
-- disagreement between two sources — but it is not revenue on top of revenue
-- that already contains it.
--
--   reconstructed = paid + organic + unmeasured + seller + live + pcard
--   gap           = reconstructed - total_gmv
--
-- Sanity-checking the two directions of disagreement:
--   * Seller Center reports MORE affiliate than we hold (unmeasured > 0):
--     ours + (aff_sc - ours) = aff_sc, so the band fills the hole and the day
--     reconciles. 2026-09-07 has unmeasured 67.96 and now reconciles to 0.00.
--   * We hold MORE than Seller Center reports (overflow > 0):
--     gap = +overflow. That is a genuine disagreement and it is surfaced ONCE,
--     which is the whole point.
--
-- WHAT THIS DELIBERATELY DOES NOT DO. It does not clamp the excess away, force
-- affiliate capture to 100%, overwrite the provider's totals, or make a warning
-- disappear. The window gap falls from 140.68 to 70.34 because 70.34 was never
-- there twice — not because the disagreement was resolved. It is still an
-- exception and still says so.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the canonical daily record ─────────────────────────────────────────────
drop function if exists public.shop_channel_daily(uuid, date, date);

create or replace function public.shop_channel_daily(p_shop_id uuid, p_start date, p_end date)
returns table (
  day                      date,
  total_gmv                numeric,
  measured_paid_gmv        numeric,
  measured_organic_gmv     numeric,
  affiliate_unmeasured_gmv numeric,
  affiliate_overflow_gmv   numeric,   -- DIAGNOSTIC. Not part of the reconstruction.
  seller_video_gmv         numeric,
  live_gmv                 numeric,
  product_card_gmv         numeric,
  affiliate_sc_gmv         numeric,
  affiliate_ours_gmv       numeric,
  affiliate_delta          numeric,
  reconciliation_gap       numeric,
  reconciliation_status    text
)
language plpgsql stable as $fn$
declare w record;
begin
  select * into w from public.shop_window(p_shop_id, p_start, p_end);

  return query
  with lines as (
    select
      public.shop_day(l.order_created_at, w.tz) as d,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0)    as paid,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD'), 0) as organic,
      coalesce(sum(l.payment_amount), 0)                                                      as total
    from public.affiliate_order_lines l
    where l.shop_id = p_shop_id
      and l.counts_toward_gmv
      and l.content_type = 'Video'
      and l.order_created_at >= w.lo and l.order_created_at < w.hi
    group by 1
  ),
  j as (
    select
      ch.day,
      coalesce(ch.gmv, 0)                 as total_gmv,
      coalesce(v.paid, 0)                 as paid,
      coalesce(v.organic, 0)              as organic,
      coalesce(ch.video_affiliate_gmv, 0) as aff_sc,
      coalesce(v.total, 0)                as ours,
      greatest(coalesce(ch.video_affiliate_gmv, 0) - coalesce(v.total, 0), 0) as unmeasured,
      greatest(coalesce(v.total, 0) - coalesce(ch.video_affiliate_gmv, 0), 0) as overflow,
      coalesce(ch.video_seller_gmv, 0)    as seller_video,
      coalesce(ch.live_gmv, 0)            as live,
      coalesce(ch.product_card_gmv, 0)    as pcard,
      -- Lines we hold that carry NEITHER classification. Today this is zero for
      -- both shops, but the reconstruction must not silently lose them if a
      -- third classification ever appears — that would move the gap for a
      -- reason unrelated to the sources disagreeing.
      greatest(coalesce(v.total, 0) - coalesce(v.paid, 0) - coalesce(v.organic, 0), 0) as unclassified
    from public.shop_daily_channels ch
    left join lines v on v.d = ch.day
    where ch.shop_id = p_shop_id and ch.day between p_start and p_end
  ),
  g as (
    select j.*,
      -- THE CORRECTED IDENTITY. `overflow` is absent on purpose: it is already
      -- inside paid + organic. Adding it here is the defect this migration fixes.
      (j.paid + j.organic + j.unclassified + j.unmeasured + j.seller_video + j.live + j.pcard)
        - j.total_gmv as gap
    from j
  )
  select
    g.day, g.total_gmv, g.paid, g.organic, g.unmeasured, g.overflow,
    g.seller_video, g.live, g.pcard,
    g.aff_sc, g.ours, g.ours - g.aff_sc,
    g.gap,
    case
      when g.total_gmv = 0 then 'reconciled'
      when abs(g.gap) <= public.recon_rounding_tolerance() then 'reconciled'
      when abs(g.gap) / g.total_gmv <= public.recon_business_tolerance() then 'rounding'
      else 'exception'
    end
  from g
  order by g.day;
end;
$fn$;

comment on function public.shop_channel_daily(uuid, date, date) is
  'THE canonical daily reconciliation record. affiliate_overflow_gmv is a DIAGNOSTIC and is deliberately NOT part of reconciliation_gap: it is already contained in measured_paid_gmv + measured_organic_gmv, and adding it again made every gap exactly twice the excess.';


-- ── grants, restated because the function was dropped ──────────────────────
do $g$
begin
  revoke all on function public.shop_channel_daily(uuid, date, date) from public;
  revoke all on function public.shop_channel_daily(uuid, date, date) from anon;
  grant execute on function public.shop_channel_daily(uuid, date, date) to authenticated;
  grant execute on function public.shop_channel_daily(uuid, date, date) to service_role;
end;
$g$;


-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY — against the exact window the audit reported
-- ═══════════════════════════════════════════════════════════════════════════
do $v$
declare
  shop_id uuid;
  d record;
  win record;
  daily_sum numeric := 0;
  daily_abs numeric := 0;
  over_total numeric := 0;
  bad int := 0;
begin
  select id into shop_id from public.shops where shop_name ilike 'Biostime%' limit 1;
  if shop_id is null then
    raise notice 'no Biostime shop — verification skipped';
    return;
  end if;

  -- 1. No day's gap may still be a multiple of its own excess.
  for d in select * from public.shop_channel_daily(shop_id, '2026-09-01', '2026-09-07') loop
    daily_sum := daily_sum + d.reconciliation_gap;
    daily_abs := daily_abs + abs(d.reconciliation_gap);
    over_total := over_total + d.affiliate_overflow_gmv;

    if d.affiliate_overflow_gmv > 0.005
       and abs(d.reconciliation_gap - 2 * d.affiliate_overflow_gmv) < 0.005 then
      raise exception 'day % still double-counts the excess: gap % = 2 x overflow %',
        d.day, d.reconciliation_gap, d.affiliate_overflow_gmv;
    end if;

    -- 2. On an overflow day the gap IS the excess, counted once.
    if d.affiliate_overflow_gmv > 0.005
       and abs(d.reconciliation_gap - d.affiliate_overflow_gmv) > 0.01 then
      raise exception 'day %: expected gap to equal the excess % once, got %',
        d.day, d.affiliate_overflow_gmv, d.reconciliation_gap;
    end if;

    -- 3. A day whose only disagreement is unmeasured affiliate must reconcile:
    --    the band exists precisely to fill that hole.
    if d.affiliate_unmeasured_gmv > 0.005 and d.affiliate_overflow_gmv <= 0.005
       and abs(d.reconciliation_gap) > 0.01 then
      raise exception 'day %: unmeasured % should reconcile, gap is %',
        d.day, d.affiliate_unmeasured_gmv, d.reconciliation_gap;
    end if;
  end loop;

  raise notice 'daily: signed % / absolute % / excess %', daily_sum, daily_abs, over_total;

  -- 4. The window MUST be the sum of the days. greatest() is nonlinear, so this
  --    is the assertion that stops it being reapplied at a second level.
  select * into win from public.shop_attribution(shop_id, '2026-09-01', '2026-09-07');
  if abs(win.reconciliation_gap - daily_sum) > 0.01 then
    raise exception 'window gap % <> sum of daily gaps %', win.reconciliation_gap, daily_sum;
  end if;
  if abs(win.recon_abs_gap - daily_abs) > 0.01 then
    raise exception 'window absolute % <> sum of daily absolutes %', win.recon_abs_gap, daily_abs;
  end if;

  -- 5. component_total must NOT contain the excess a second time.
  if abs((win.component_total - win.total_gmv) - daily_sum) > 0.01 then
    raise exception 'component_total % implies a gap that is not the daily sum %',
      win.component_total, daily_sum;
  end if;
  if over_total > 0.005
     and abs((win.component_total - win.total_gmv) - 2 * over_total) < 0.01 then
    raise exception 'component_total still carries the excess twice';
  end if;

  raise notice 'window: components % vs source % -> gap % (was 2x this)',
    win.component_total, win.total_gmv, win.reconciliation_gap;
  raise notice 'VERIFIED: the affiliate excess is counted exactly once.';
end;
$v$;
