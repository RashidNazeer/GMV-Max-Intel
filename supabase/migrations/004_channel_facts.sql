-- ============================================================
-- GMV Max Intelligence — 004: whole-shop channel decomposition (spec layer 2).
--
-- ── WHY THIS EXISTS ────────────────────────────────────────────────────────
-- Migration 002/003 answer "of the affiliate revenue we can see, how much did
-- ads drive". That is a share of a slice. Measured on Cutler for 30 days, the
-- slice is about 30% of the shop:
--
--     total shop GMV        217,956.30
--       video               140,649.49   ->  affiliate 81,808.91 | seller 58,840.58
--       LIVE                  2,801.60
--       product card         74,505.21
--
-- and our own affiliate order lines summed to 66,139 — less than Seller
-- Center's affiliate figure for the same window. Quoting a paid share without
-- that context invites the reader to apply it to the whole shop, which would be
-- wrong by a factor of three.
--
-- So this table stores Seller Center's own daily channel split, and
-- shop_attribution() below decomposes the WHOLE shop into buckets that sum
-- exactly to total GMV, with the measured part clearly separated from the part
-- we cannot yet see.
--
-- ── FIELDS THAT ARRIVE NULL ────────────────────────────────────────────────
-- Measured 2026-09-07 over 31 days: video.affiliate and video.seller are
-- populated on every day; live.affiliate, live.seller, product_card.shop_tab
-- and product_card.search are NULL on every day (the window total reports them
-- as 0, the daily series does not break them out at all). They are stored
-- anyway, as NULL, because null means "not broken out" and 0 would mean "no
-- revenue" — a different claim.
-- ============================================================

create table if not exists public.shop_daily_channels (
  shop_id                   uuid not null references public.shops(id) on delete cascade,
  day                       date not null,

  gmv                       numeric(14,2),
  orders                    integer,
  items_sold                integer,
  customers                 integer,
  aov                       numeric(12,2),

  -- channels. video_gmv = video_affiliate_gmv + video_seller_gmv (verified on
  -- live data: 3909.36 = 1987.31 + 1922.05), and
  -- video_gmv + live_gmv + product_card_gmv = gmv exactly.
  video_gmv                 numeric(14,2),
  video_affiliate_gmv       numeric(14,2),
  video_seller_gmv          numeric(14,2),
  live_gmv                  numeric(14,2),
  live_affiliate_gmv        numeric(14,2),   -- null in practice
  live_seller_gmv           numeric(14,2),   -- null in practice
  product_card_gmv          numeric(14,2),
  product_card_shop_tab_gmv numeric(14,2),   -- null in practice
  product_card_search_gmv   numeric(14,2),   -- null in practice

  product_impressions       bigint,
  product_clicks            bigint,

  currency                  text,
  raw                       jsonb,
  synced_at                 timestamptz not null default now(),

  primary key (shop_id, day)
);

create index if not exists sdc_shop_day_idx on public.shop_daily_channels (shop_id, day desc);

-- ============================================================
-- The decomposition. Six buckets that sum to total GMV.
--
-- Buckets 1-3 are the affiliate VIDEO channel, the only place a commission
-- programme tells us what drove the sale:
--   1 measured ad-driven      Shop Ads commission on our order lines
--   2 measured organic        standard commission on our order lines
--   3 affiliate, unmeasured   Seller Center's affiliate video GMV minus ours
-- Buckets 4-6 have no commission signal at all and are NOT split by a proxy —
-- spec §13.4, and the data agrees: Showcase, Livestream and External Traffic
-- lines measured 0% paid across thousands of dollars, so a blended share
-- borrowed from affiliate video would be actively wrong there.
--
-- Only days present in shop_daily_channels are counted, on BOTH sides. If the
-- channel sync covers 20 of 30 days, an affiliate-line total over the full 30
-- would exceed its own channel bucket and the bar would not add up.
-- ============================================================
create or replace function public.shop_attribution(p_shop_id uuid, p_start date, p_end date)
returns table (
  days_covered              integer,
  total_gmv                 numeric,
  measured_paid_gmv         numeric,
  measured_organic_gmv      numeric,
  affiliate_unmeasured_gmv  numeric,
  seller_video_gmv          numeric,
  live_gmv                  numeric,
  product_card_gmv          numeric,
  affiliate_video_sc_gmv    numeric,   -- Seller Center's own affiliate video figure
  affiliate_video_ours_gmv  numeric,   -- what our order lines account for
  affiliate_capture         numeric,   -- ours / Seller Center's — the reconciliation alarm
  attribution_coverage      numeric,   -- measured / total shop GMV
  paid_share_of_measured    numeric,   -- the headline, honestly scoped
  other_affiliate_gmv       numeric,   -- Showcase / Livestream / External lines
  other_affiliate_paid_gmv  numeric,   -- evidence that those channels are organic
  orders                    bigint,
  customers                 bigint
)
language sql
stable
as $$
  with ch as (
    select * from public.shop_daily_channels
     where shop_id = p_shop_id and day between p_start and p_end
  ),
  -- Affiliate lines, restricted to the same days the channel data covers.
  lines as (
    select l.*, (l.order_created_at at time zone 'UTC')::date as day
      from public.affiliate_order_lines l
     where l.shop_id = p_shop_id
       and l.counts_toward_gmv
       and (l.order_created_at at time zone 'UTC')::date
             in (select day from ch)
  ),
  vid as (   -- Video-type lines are the ones Seller Center counts as affiliate video
    select
      coalesce(sum(payment_amount) filter (where classification = 'PAID_SHOP_ADS'), 0)    as paid,
      coalesce(sum(payment_amount) filter (where classification = 'ORGANIC_STANDARD'), 0) as organic,
      coalesce(sum(payment_amount), 0)                                                    as total
    from lines where content_type = 'Video'
  ),
  oth as (   -- Showcase / Livestream / External Traffic: inside buckets 4-6 already
    select
      coalesce(sum(payment_amount), 0)                                                 as total,
      coalesce(sum(payment_amount) filter (where classification = 'PAID_SHOP_ADS'), 0) as paid
    from lines where content_type is distinct from 'Video'
  ),
  agg as (
    select
      count(*)::int                                  as days_covered,
      coalesce(sum(ch.gmv), 0)                       as total_gmv,
      coalesce(sum(ch.video_affiliate_gmv), 0)       as aff_sc,
      coalesce(sum(ch.video_seller_gmv), 0)          as seller_video,
      coalesce(sum(ch.live_gmv), 0)                  as live,
      coalesce(sum(ch.product_card_gmv), 0)          as pcard,
      coalesce(sum(ch.orders), 0)::bigint            as orders,
      coalesce(sum(ch.customers), 0)::bigint         as customers
    from ch
  )
  select
    agg.days_covered,
    agg.total_gmv,
    vid.paid,
    vid.organic,
    -- Never negative: if our lines exceed Seller Center's figure the gap is
    -- zero, not a phantom negative bucket that would break the stacked bar.
    greatest(agg.aff_sc - vid.total, 0),
    agg.seller_video,
    agg.live,
    agg.pcard,
    agg.aff_sc,
    vid.total,
    vid.total / nullif(agg.aff_sc, 0),
    (vid.paid + vid.organic) / nullif(agg.total_gmv, 0),
    vid.paid / nullif(vid.paid + vid.organic, 0),
    oth.total,
    oth.paid,
    agg.orders,
    agg.customers
  from agg, vid, oth;
$$;

-- Daily channel series — the same decomposition, one row per day, for the chart.
create or replace function public.shop_channel_daily(p_shop_id uuid, p_start date, p_end date)
returns table (
  day                      date,
  total_gmv                numeric,
  measured_paid_gmv        numeric,
  measured_organic_gmv     numeric,
  affiliate_unmeasured_gmv numeric,
  seller_video_gmv         numeric,
  live_gmv                 numeric,
  product_card_gmv         numeric
)
language sql
stable
as $$
  with lines as (
    select
      (l.order_created_at at time zone 'UTC')::date as day,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0)    as paid,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD'), 0) as organic,
      coalesce(sum(l.payment_amount), 0)                                                      as total
    from public.affiliate_order_lines l
    where l.shop_id = p_shop_id
      and l.counts_toward_gmv
      and l.content_type = 'Video'
      and (l.order_created_at at time zone 'UTC')::date between p_start and p_end
    group by 1
  )
  select
    ch.day,
    ch.gmv,
    coalesce(v.paid, 0),
    coalesce(v.organic, 0),
    greatest(coalesce(ch.video_affiliate_gmv, 0) - coalesce(v.total, 0), 0),
    coalesce(ch.video_seller_gmv, 0),
    coalesce(ch.live_gmv, 0),
    coalesce(ch.product_card_gmv, 0)
  from public.shop_daily_channels ch
  left join lines v on v.day = ch.day
  where ch.shop_id = p_shop_id and ch.day between p_start and p_end
  order by ch.day;
$$;

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.shop_daily_channels enable row level security;

drop policy if exists sdc_select on public.shop_daily_channels;
create policy sdc_select on public.shop_daily_channels for select
  using (public.can_view_shop(shop_id, auth.uid()));
-- No write policies: ingestion is service-role only, as with every fact table.

do $grants$
declare fn text;
begin
  foreach fn in array array[
    'public.shop_attribution(uuid, date, date)',
    'public.shop_channel_daily(uuid, date, date)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$grants$;

do $verify$
declare v int; fn text;
begin
  foreach fn in array array[
    'public.shop_attribution(uuid, date, date)',
    'public.shop_channel_daily(uuid, date, date)'
  ] loop
    if has_function_privilege('anon', fn, 'execute') then
      raise exception '004: anon can call % — it reads client revenue', fn;
    end if;
  end loop;

  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'shop_daily_channels' and cmd <> 'SELECT';
  if v <> 0 then
    raise exception '004: shop_daily_channels has % write policies — ingestion must stay service-role only', v;
  end if;

  raise notice '004: channel decomposition ready — whole-shop buckets that sum to total GMV';
end;
$verify$;
