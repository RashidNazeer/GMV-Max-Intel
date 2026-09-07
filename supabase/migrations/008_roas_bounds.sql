-- ============================================================
-- GMV Max Intelligence — 008: state the return as a BAND, not a single number.
--
-- ── THE MISTAKE THIS FIXES ─────────────────────────────────────────────────
-- 007 offered a "like-for-like" ratio: measured affiliate revenue divided by
-- affiliate-surface spend. Run against real revenue it produced a figure ABOVE
-- GMV Max's own reported ROI, which is incoherent as a rebuttal — it is not a
-- smaller, truer version of the same number, it is a different number. It
-- divides a partial numerator by a partial denominator and the two partials do
-- not correspond.
--
-- ── WHAT CAN HONESTLY BE SAID ──────────────────────────────────────────────
-- GMV Max reports revenue attributed across every surface it buys — affiliate
-- video, product card, brand. Our commission evidence covers ONE of those. So:
--
--   * Every dollar of measured Shop Ads revenue is certainly ad-driven.
--     Dividing it by TOTAL spend gives a FLOOR: the return we can prove.
--   * GMV Max's own figure is the CEILING: everything it is willing to claim.
--   * The truth is between them, and the width of that band is the amount of
--     claimed revenue with no evidence behind it.
--
-- The unverified band is NOT the same as over-attribution. Some of it is
-- genuinely ad-driven revenue on surfaces where no commission programme names
-- a cause; some of it is organic being counted as paid. Nothing available today
-- separates those two, so the product must not pretend it can. It reports the
-- band and says what would close it — surface-level REVENUE, which Reacher
-- exposes only as surface-level SPEND today.
--
-- affiliate_surface_roas is kept, but as what it actually is: the efficiency of
-- the one surface we can measure. It is not a rebuttal to the reported figure.
-- ============================================================

drop function if exists public.shop_paid_roas(uuid, date, date);

create or replace function public.shop_paid_roas(p_shop_id uuid, p_start date, p_end date)
returns table (
  data_source             text,
  is_simulated            boolean,
  campaigns               bigint,
  days_with_spend         integer,
  spend                   numeric,
  spend_affiliate_surface numeric,

  reported_revenue        numeric,   -- what GMV Max claims
  reported_roi            numeric,   -- the CEILING
  verified_paid_gmv       numeric,   -- Shop Ads commission — certainly ad-driven
  verified_roas           numeric,   -- the FLOOR

  unverified_revenue      numeric,   -- claimed but unevidenced
  unverified_share        numeric,   -- as a share of what is claimed
  affiliate_surface_roas  numeric    -- efficiency of the surface we can measure
)
language sql
stable
as $$
  with m as (
    select
      max(data_source)                                          as data_source,
      count(distinct campaign_id)                               as campaigns,
      count(distinct day) filter (where coalesce(spend, 0) > 0) as days_with_spend,
      coalesce(sum(spend), 0)                                   as spend,
      sum(spend_affiliate)                                      as spend_affiliate,
      coalesce(sum(revenue), 0)                                 as revenue
    from public.gmv_max_daily_metrics
    where shop_id = p_shop_id and day between p_start and p_end
  ),
  -- Measured revenue over exactly the days that carry spend. Comparing a
  -- 30-day revenue total against 12 days of spend would invent a ratio.
  ours as (
    select coalesce(sum(l.payment_amount), 0) as paid
    from public.affiliate_order_lines l
    where l.shop_id = p_shop_id
      and l.counts_toward_gmv
      and l.classification = 'PAID_SHOP_ADS'
      and (l.order_created_at at time zone 'UTC')::date in (
        select day from public.gmv_max_daily_metrics
         where shop_id = p_shop_id and day between p_start and p_end
           and coalesce(spend, 0) > 0
      )
  )
  select
    m.data_source,
    m.data_source = 'simulated',
    m.campaigns,
    m.days_with_spend::int,
    m.spend,
    m.spend_affiliate,

    m.revenue,
    m.revenue / nullif(m.spend, 0),
    ours.paid,
    ours.paid / nullif(m.spend, 0),

    -- Never negative: if our measured revenue exceeds what GMV Max claims,
    -- there is nothing unverified — there is more evidence than claim.
    greatest(m.revenue - ours.paid, 0),
    greatest(m.revenue - ours.paid, 0) / nullif(m.revenue, 0),
    ours.paid / nullif(m.spend_affiliate, 0)
  from m, ours
  where m.campaigns > 0;   -- no campaigns: no row, rather than a row of zeros
$$;

do $grants$
begin
  revoke all on function public.shop_paid_roas(uuid, date, date) from public;
  revoke all on function public.shop_paid_roas(uuid, date, date) from anon;
  grant execute on function public.shop_paid_roas(uuid, date, date) to authenticated;
end;
$grants$;

do $verify$
begin
  if has_function_privilege('anon', 'public.shop_paid_roas(uuid, date, date)', 'execute') then
    raise exception '008: anon can call shop_paid_roas';
  end if;
  raise notice '008: return on spend is reported as a band — proven floor to claimed ceiling';
end;
$verify$;
