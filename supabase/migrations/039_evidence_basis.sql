-- ═══════════════════════════════════════════════════════════════════════════
-- GMV Max Intelligence — 039: how each pound of revenue was established.
--
-- ── THE TRAP THIS IS BUILT AROUND ──────────────────────────────────────────
-- The requirement asks for measured / modelled / estimated / unclassified
-- metadata "without treating those labels as an additional set of revenues to
-- add to the existing channel totals". That is not a stylistic note. Migration
-- 022 exists because an affiliate excess was added to a total that already
-- contained it, and every reported gap came out exactly 2x the real one.
--
-- So this is a PARTITION, not a new decomposition. Every pound already counted
-- in the channel breakdown is assigned exactly one basis, and the basis amounts
-- sum to the SAME component total the channel view produces. The verification
-- block asserts that to the cent and raises if it drifts.
--
-- ── THE FOUR BASES, DEFINED ────────────────────────────────────────────────
--   measured      directly available evidence under the existing classifier —
--                 an order line whose commission type we read, or a channel
--                 total the source reported itself
--   modelled      a versioned statistical result. NOTHING here is modelled:
--                 the spend-response model produces forecasts, not revenue, and
--                 a forecast is not a pound anyone has earned. The bucket exists
--                 so that if one ever is, it has somewhere honest to go
--   estimated     a documented heuristic or allocation. The affiliate
--                 "unmeasured" band is the only one: Seller Center reports more
--                 affiliate revenue than we hold order lines for, and the
--                 difference is allocated to fill the gap
--   unclassified  we hold the line and cannot classify it
--
-- These describe HOW A VALUE WAS PRODUCED. They say nothing about causal
-- strength, and nothing here should be read as one basis being more "real" than
-- another — a measured pound and an estimated pound are both revenue, they are
-- differently evidenced.
--
-- ── THE RESIDUAL IS NOT A BASIS ────────────────────────────────────────────
-- Components and the source total disagree by a small amount on most shops.
-- That residual is shown as its own line, OUTSIDE the partition, because
-- folding it into a bucket would make the buckets sum to the source total by
-- construction and hide the disagreement — which is the one thing the
-- reconciliation work exists to prevent. Totals are never clamped to 100% and
-- residuals are never redistributed.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.attribution_basis_version() returns text
language sql immutable as $$ select '2026-09-10.1'::text $$;

create or replace function public.attribution_basis(
  p_shop_id uuid, p_start date, p_end date
) returns table (
  basis            text,
  component        text,
  amount           numeric,
  share_of_components numeric,
  share_of_source  numeric,
  denominator_note text,
  meaning          text,
  is_partition     boolean
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  uid uuid := auth.uid();
  a   record;
  comp numeric;
  src  numeric;
begin
  if uid is null or not public.can_view_shop(p_shop_id, uid) then
    raise exception 'not authorised for this shop';
  end if;

  select * into a from public.shop_attribution(p_shop_id, p_start, p_end);
  if not found then return; end if;

  -- TWO DENOMINATORS, AND THEY ARE NOT THE SAME NUMBER.
  --   src  = what the source says the shop earned
  --   comp = what our components add up to
  -- Every share below names which one it used. A share of components and a
  -- share of shop GMV differ by exactly the residual, and presenting either
  -- without saying which is how a 98% becomes a 100%.
  src  := coalesce(a.total_gmv, 0);
  comp := coalesce(a.component_total, 0);

  return query
  -- ── the partition ────────────────────────────────────────────────────────
  select 'measured'::text, 'affiliate paid (Shop Ads commission)'::text,
         coalesce(a.measured_paid_gmv, 0),
         case when comp = 0 then null else round(coalesce(a.measured_paid_gmv, 0) / comp, 4) end,
         case when src  = 0 then null else round(coalesce(a.measured_paid_gmv, 0) / src, 4) end,
         'share of components / share of total shop GMV'::text,
         'Order lines whose commission type we read directly. The strongest evidence in this product.'::text,
         true
  union all
  select 'measured', 'affiliate organic (standard commission)',
         coalesce(a.measured_organic_gmv, 0),
         case when comp = 0 then null else round(coalesce(a.measured_organic_gmv, 0) / comp, 4) end,
         case when src  = 0 then null else round(coalesce(a.measured_organic_gmv, 0) / src, 4) end,
         'share of components / share of total shop GMV',
         'Order lines paying a standard creator commission, so the ad did not cause them.',
         true
  union all
  select 'measured', 'seller video',
         coalesce(a.seller_video_gmv, 0),
         case when comp = 0 then null else round(coalesce(a.seller_video_gmv, 0) / comp, 4) end,
         case when src  = 0 then null else round(coalesce(a.seller_video_gmv, 0) / src, 4) end,
         'share of components / share of total shop GMV',
         'Reported by Seller Center as its own channel total. Measured, but by the source rather than by us.',
         true
  union all
  select 'measured', 'live',
         coalesce(a.live_gmv, 0),
         case when comp = 0 then null else round(coalesce(a.live_gmv, 0) / comp, 4) end,
         case when src  = 0 then null else round(coalesce(a.live_gmv, 0) / src, 4) end,
         'share of components / share of total shop GMV',
         'Reported by Seller Center as its own channel total.',
         true
  union all
  select 'measured', 'product card',
         coalesce(a.product_card_gmv, 0),
         case when comp = 0 then null else round(coalesce(a.product_card_gmv, 0) / comp, 4) end,
         case when src  = 0 then null else round(coalesce(a.product_card_gmv, 0) / src, 4) end,
         'share of components / share of total shop GMV',
         'Reported by Seller Center as its own channel total.',
         true
  union all
  -- THE ONLY ESTIMATED BUCKET. Seller Center reports more affiliate revenue
  -- than we hold order lines for; this band fills that difference. It is an
  -- allocation, not an observation, and it is labelled as one.
  select 'estimated', 'affiliate reported but not itemised',
         coalesce(a.affiliate_unmeasured_gmv, 0),
         case when comp = 0 then null else round(coalesce(a.affiliate_unmeasured_gmv, 0) / comp, 4) end,
         case when src  = 0 then null else round(coalesce(a.affiliate_unmeasured_gmv, 0) / src, 4) end,
         'share of components / share of total shop GMV',
         'Seller Center reports more affiliate revenue than we hold order lines for. This band fills the difference so the channels reconcile — it is an allocation, and it cannot be split into paid and organic because we do not hold the lines that would say.',
         true
  union all
  select 'unclassified', 'order lines with no commission signal',
         greatest(coalesce(a.affiliate_video_ours_gmv, 0)
                  - coalesce(a.measured_paid_gmv, 0)
                  - coalesce(a.measured_organic_gmv, 0), 0),
         case when comp = 0 then null else round(greatest(coalesce(a.affiliate_video_ours_gmv, 0) - coalesce(a.measured_paid_gmv, 0) - coalesce(a.measured_organic_gmv, 0), 0) / comp, 4) end,
         case when src  = 0 then null else round(greatest(coalesce(a.affiliate_video_ours_gmv, 0) - coalesce(a.measured_paid_gmv, 0) - coalesce(a.measured_organic_gmv, 0), 0) / src, 4) end,
         'share of components / share of total shop GMV',
         'Lines we hold that carry neither a Shop Ads nor a standard commission. Currently zero on both shops, and kept visible so a third commission type appearing does not silently move the split.',
         true
  union all
  -- MODELLED IS EMPTY, ON PURPOSE, AND SHOWN ANYWAY.
  -- The spend-response model produces forecasts, and a forecast is not revenue
  -- anybody earned. An empty row here is a standing statement that no modelled
  -- pound has been added to this shop's revenue.
  select 'modelled', 'none',
         0::numeric, 0::numeric, 0::numeric,
         'not applicable',
         'No revenue in this product is modelled. The spend-response model forecasts outcomes; it never contributes a pound to a total.',
         true
  union all
  -- ── OUTSIDE THE PARTITION ────────────────────────────────────────────────
  -- Deliberately last, and deliberately flagged. Folding this into a bucket
  -- would make the buckets sum to the source total by construction and hide
  -- the very disagreement the reconciliation work exists to surface.
  select 'residual', 'components minus total shop GMV',
         comp - src,
         null::numeric,
         case when src = 0 then null else round((comp - src) / src, 4) end,
         'share of total shop GMV only — a residual has no share of the components it is the excess of',
         'Not a basis and not revenue. The amount by which our components and the source total disagree. It is shown rather than absorbed, because absorbing it would make the split look exact.',
         false;
end;
$fn$;

do $g$
begin
  revoke all on function public.attribution_basis(uuid, date, date) from public;
  revoke all on function public.attribution_basis(uuid, date, date) from anon;
  grant execute on function public.attribution_basis(uuid, date, date) to authenticated;
  revoke all on function public.attribution_basis_version() from anon;
  grant execute on function public.attribution_basis_version() to authenticated;
end;
$g$;

comment on function public.attribution_basis(uuid, date, date) is
  'How each pound of revenue was established: measured, modelled, estimated or unclassified. A PARTITION of the existing components, never an additional decomposition — the basis amounts sum to component_total exactly. The residual is returned outside the partition (is_partition = false) because folding it in would make the split look exact.';


-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY — the partition must sum to the components, to the cent.
-- ═══════════════════════════════════════════════════════════════════════════
do $v$
declare
  shop uuid; uid uuid; a record; r record;
  part_sum numeric; resid numeric;
begin
  select id into shop from public.shops where shop_name ilike 'Biostime%' limit 1;
  select p.id into uid from public.profiles p where public.can_view_shop(shop, p.id) limit 1;
  if shop is null or uid is null then
    raise notice '039: no shop or user, checks skipped';
    return;
  end if;

  perform set_config('request.jwt.claim.sub', uid::text, true);
  perform set_config('role', 'authenticated', true);

  select * into a from public.shop_attribution(shop, current_date - 30, current_date - 3);

  select coalesce(sum(b.amount), 0) into part_sum
    from public.attribution_basis(shop, current_date - 30, current_date - 3) b
   where b.is_partition;

  select coalesce(sum(b.amount), 0) into resid
    from public.attribution_basis(shop, current_date - 30, current_date - 3) b
   where not b.is_partition;

  raise notice '039: components % · partition sums to % · residual %',
    round(coalesce(a.component_total, 0), 2), round(part_sum, 2), round(resid, 2);

  -- THE LOAD-BEARING ASSERTION. If the basis labels ever become an additional
  -- decomposition rather than a partition, this is where it shows — the same
  -- failure mode as the double-counted excess in migration 022.
  if abs(part_sum - coalesce(a.component_total, 0)) > 0.01 then
    raise exception '039: the basis partition does not sum to the components (% vs %)',
      round(part_sum, 2), round(coalesce(a.component_total, 0), 2);
  end if;

  -- And the residual must be exactly the disagreement, not a plug.
  if abs(resid - (coalesce(a.component_total, 0) - coalesce(a.total_gmv, 0))) > 0.01 then
    raise exception '039: the residual does not equal components minus source total';
  end if;

  -- No basis may claim revenue is modelled. Nothing here is.
  for r in select * from public.attribution_basis(shop, current_date - 30, current_date - 3)
           where basis = 'modelled' and amount <> 0
  loop
    raise exception '039: a modelled amount appeared — forecasts are not revenue';
  end loop;

  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  raise notice '039: verified — the partition reconciles and nothing is modelled';
end;
$v$;
