-- ============================================================
-- GMV Max Intelligence — 011: product metrics stored per DAY, not per window.
--
-- ── THE BUG ────────────────────────────────────────────────────────────────
-- product_window_metrics stored one row per product per SYNC WINDOW, and
-- shop_products matched it with
--     where window_end between p_start and p_end
--
-- The sync had stored a single window, 2026-08-08 → 2026-09-07. Ask the app for
-- any other range — "Last 90 days", which ends 2026-09-05 — and window_end
-- falls outside it, so nothing matched.
--
-- What made this bad rather than merely wrong: the page did not go blank. The
-- affiliate side of the join still produced rows, so it rendered
-- "2 products with sales · $0 · 0 impressions · $0 refunded". Every one of
-- those zeros reads as a measurement. A shop with real revenue looked like a
-- shop with none, on a product whose entire purpose is not doing that.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- Verified against the live API: /seller-center/products accepts a single day
-- and the results are additive (2026-08-20 alone returns $3,538.60; 08-20→08-22
-- returns $9,092.98). So store one row per product per day and aggregate for
-- whatever range is asked for, exactly as shop_daily_channels already does.
--
-- Counts and money sum. RATES DO NOT — ctr, add-to-cart rate and click-to-order
-- rate are recomputed from the summed numerator and denominator. Averaging a
-- rate across days weights a $50 day the same as a $5,000 one.
--
-- unique_viewers and unique_clickers are summed because there is no other
-- option, but the same person on two days counts twice. They are kept for
-- context and deliberately not used in any rate.
-- ============================================================

create table if not exists public.product_daily_metrics (
  shop_id             uuid not null references public.shops(id) on delete cascade,
  day                 date not null,
  product_id          text not null,

  product_name        text,
  cover_image_url     text,

  gmv                 numeric(14,2),
  orders              integer,
  sku_orders          integer,
  items_sold          integer,
  customers           integer,
  refunds             numeric(14,2),
  items_returned      integer,

  impressions         bigint,
  unique_viewers      bigint,
  clicks              bigint,
  unique_clickers     bigint,
  add_to_cart         bigint,
  funnel_orders       integer,   -- the funnel's own order count; differs from sales.orders

  seller_video_gmv    numeric(14,2),
  seller_live_gmv     numeric(14,2),
  affiliate_gmv       numeric(14,2),
  affiliate_video_gmv numeric(14,2),
  affiliate_live_gmv  numeric(14,2),
  product_card_gmv    numeric(14,2),
  shop_tab_gmv        numeric(14,2),

  raw                 jsonb,
  synced_at           timestamptz not null default now(),

  primary key (shop_id, day, product_id)
);

create index if not exists pdm_shop_day_idx on public.product_daily_metrics (shop_id, day desc);

alter table public.product_daily_metrics enable row level security;

drop policy if exists pdm_select on public.product_daily_metrics;
create policy pdm_select on public.product_daily_metrics for select
  using (public.can_view_shop(shop_id, auth.uid()));
-- No write policies: ingestion is service-role only, like every fact table.

-- ============================================================
-- shop_products, rebuilt on the daily table.
--
-- Returns NO ROW for a product with no data in the range, rather than a row of
-- zeros — which is what let the old version render an empty window as a shop
-- with no sales.
-- ============================================================
create or replace function public.shop_products(p_shop_id uuid, p_start date, p_end date, p_limit int default 50)
returns table (
  product_id text, title text, image_url text, gmv numeric, orders integer, items_sold integer,
  aov numeric, refunds numeric, refund_rate numeric, impressions bigint, clicks bigint,
  ctr numeric, add_to_cart_rate numeric, click_to_order_rate numeric,
  affiliate_gmv numeric, product_card_gmv numeric, shop_tab_gmv numeric, seller_video_gmv numeric,
  measured_paid_gmv numeric, measured_organic_gmv numeric, paid_share numeric,
  min_price numeric, max_price numeric, inventory bigint, commission_rate numeric,
  discount_pct numeric, days_with_data integer
)
language plpgsql stable as $fn$
declare w record;
begin
  select * into w from public.shop_window(p_shop_id, p_start, p_end);
  return query
    with agg as (
      select
        d.product_id                                as pid,
        max(d.product_name)                         as product_name,
        max(d.cover_image_url)                      as cover_image_url,
        count(distinct d.day)::int                  as days_with_data,
        sum(d.gmv)                                  as gmv,
        sum(d.orders)::int                          as orders,
        sum(d.items_sold)::int                      as items_sold,
        sum(d.refunds)                              as refunds,
        sum(d.impressions)::bigint                  as impressions,
        sum(d.clicks)::bigint                       as clicks,
        sum(d.add_to_cart)::bigint                  as add_to_cart,
        sum(d.funnel_orders)::bigint                as funnel_orders,
        sum(d.affiliate_gmv)                        as affiliate_gmv,
        sum(d.product_card_gmv)                     as product_card_gmv,
        sum(d.shop_tab_gmv)                         as shop_tab_gmv,
        sum(d.seller_video_gmv)                     as seller_video_gmv
      from public.product_daily_metrics d
      where d.shop_id = p_shop_id and d.day between p_start and p_end
      group by d.product_id
    ),
    mine as (
      select
        l.product_id as pid,
        coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0)    as paid,
        coalesce(sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD'), 0) as organic
      from public.affiliate_order_lines l
      where l.shop_id = p_shop_id and l.counts_toward_gmv and l.product_id is not null
        and l.order_created_at >= w.lo and l.order_created_at < w.hi
      group by 1
    )
    select
      coalesce(a.pid, m.pid),
      coalesce(c.title, a.product_name),
      coalesce(c.image_url, a.cover_image_url),
      a.gmv, a.orders, a.items_sold,
      a.gmv / nullif(a.orders, 0),                       -- AOV from the sums
      a.refunds,
      a.refunds / nullif(a.gmv, 0),
      a.impressions, a.clicks,
      a.clicks::numeric        / nullif(a.impressions, 0),   -- rates rebuilt, never averaged
      a.add_to_cart::numeric   / nullif(a.clicks, 0),
      a.funnel_orders::numeric / nullif(a.clicks, 0),
      a.affiliate_gmv, a.product_card_gmv, a.shop_tab_gmv, a.seller_video_gmv,
      coalesce(m.paid, 0), coalesce(m.organic, 0),
      m.paid / nullif(m.paid + m.organic, 0),
      c.min_price, c.max_price, c.inventory, c.commission_rate, c.discount_pct,
      a.days_with_data
    from agg a
    full join mine m on m.pid = a.pid
    left join public.product_catalog c
      on c.shop_id = p_shop_id and c.product_id = coalesce(a.pid, m.pid)
    order by coalesce(a.gmv, 0) desc, coalesce(m.paid, 0) + coalesce(m.organic, 0) desc
    limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$fn$;

-- The window table is now dead: everything it held is derivable from the daily
-- rows, and a table nothing reads is a table that silently rots.
drop table if exists public.product_window_metrics;

do $grants$
begin
  revoke all on function public.shop_products(uuid, date, date, int) from public;
  revoke all on function public.shop_products(uuid, date, date, int) from anon;
  grant execute on function public.shop_products(uuid, date, date, int) to authenticated;
end;
$grants$;

do $verify$
declare v int;
begin
  if has_function_privilege('anon', 'public.shop_products(uuid, date, date, int)', 'execute') then
    raise exception '011: anon can call shop_products';
  end if;

  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'product_daily_metrics' and cmd <> 'SELECT';
  if v <> 0 then
    raise exception '011: product_daily_metrics has % write policies', v;
  end if;

  select count(*) into v from information_schema.tables
   where table_schema = 'public' and table_name = 'product_window_metrics';
  if v <> 0 then
    raise exception '011: product_window_metrics still exists';
  end if;

  raise notice '011: product metrics are daily — any window aggregates, rates rebuilt from sums';
end;
$verify$;
