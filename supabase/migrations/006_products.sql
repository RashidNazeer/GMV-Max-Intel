-- ============================================================
-- GMV Max Intelligence — 006: product and commerce context (spec layer 4).
--
-- ── WHAT THE SPEC ASKED FOR, AND WHAT THE SOURCE ACTUALLY HAS ──────────────
-- The spec wants price and promotion context so that a "performance
-- improvement" is not silently a 25% discount. Probed live on 2026-09-07,
-- Cutler's catalogue of 61 products / 105 SKUs returns:
--
--     discount_pct              null on 61 of 61 products
--     original_price            null on 105 of 105 SKUs
--     shop_ads_commission_rate  null on 61 of 61
--     commission_rate           populated on 5 of 61
--     sale_price                populated on all 61
--     inventory                 populated on 57
--
-- There is no "before" price anywhere in the source, so discount DEPTH cannot
-- be computed. The columns exist here because the field exists and may start
-- arriving, but nothing derives a number from them, and the UI says the measure
-- is unavailable rather than showing a confident 0%.
--
-- What IS available, and is genuinely useful, is the Seller Center funnel:
-- impressions -> clicks -> add-to-cart -> orders, plus refunds. That answers
-- "did the ad get worse, or did the product page stop converting" — which is
-- the question price context was wanted for in the first place.
-- ============================================================

create table if not exists public.product_catalog (
  shop_id                  uuid not null references public.shops(id) on delete cascade,
  product_id               text not null,
  title                    text,
  image_url                text,
  brand_name               text,
  currency                 text,
  sku_count                integer,
  min_price                numeric(12,2),
  max_price                numeric(12,2),
  inventory                bigint,
  commission_rate          numeric(10,4),
  shop_ads_commission_rate numeric(10,4),
  discount_pct             numeric(10,4),   -- null in the source today; see header
  raw                      jsonb,
  synced_at                timestamptz not null default now(),
  primary key (shop_id, product_id)
);

create table if not exists public.product_window_metrics (
  shop_id                uuid not null references public.shops(id) on delete cascade,
  product_id             text not null,
  window_start           date not null,
  window_end             date not null,

  product_name           text,
  cover_image_url        text,
  days_with_data         integer,

  gmv                    numeric(14,2),
  orders                 integer,
  sku_orders             integer,
  items_sold             integer,
  customers              integer,
  aov                    numeric(12,2),
  refunds                numeric(14,2),
  items_returned         integer,

  impressions            bigint,
  unique_viewers         bigint,
  clicks                 bigint,
  unique_clickers        bigint,
  ctr                    numeric(10,6),
  add_to_cart            bigint,
  add_to_cart_rate       numeric(10,6),
  click_to_order_rate    numeric(10,6),

  seller_video_gmv       numeric(14,2),
  seller_live_gmv        numeric(14,2),
  affiliate_gmv          numeric(14,2),
  affiliate_video_gmv    numeric(14,2),
  affiliate_live_gmv     numeric(14,2),
  product_card_gmv       numeric(14,2),
  shop_tab_gmv           numeric(14,2),

  raw                    jsonb,
  synced_at              timestamptz not null default now(),

  primary key (shop_id, product_id, window_start, window_end)
);

create index if not exists pwm_shop_window_idx
  on public.product_window_metrics (shop_id, window_end desc, gmv desc);

-- ============================================================
-- One row per product: Seller Center's funnel, our measured paid/organic split,
-- and the catalogue facts.
--
-- The affiliate split is joined from our own order lines by product_id, so a
-- product's ad dependence is measured, not apportioned from a shop-wide rate.
-- refund_rate is returned as a rate because the absolute figure means nothing
-- without the GMV beside it.
-- ============================================================
create or replace function public.shop_products(
  p_shop_id uuid, p_start date, p_end date, p_limit int default 50
)
returns table (
  product_id          text,
  title               text,
  image_url           text,
  gmv                 numeric,
  orders              integer,
  items_sold          integer,
  aov                 numeric,
  refunds             numeric,
  refund_rate         numeric,
  impressions         bigint,
  clicks              bigint,
  ctr                 numeric,
  add_to_cart_rate    numeric,
  click_to_order_rate numeric,
  affiliate_gmv       numeric,
  product_card_gmv    numeric,
  shop_tab_gmv        numeric,
  seller_video_gmv    numeric,
  measured_paid_gmv   numeric,
  measured_organic_gmv numeric,
  paid_share          numeric,
  min_price           numeric,
  max_price           numeric,
  inventory           bigint,
  commission_rate     numeric,
  discount_pct        numeric,
  days_with_data      integer
)
language sql
stable
as $$
  with mine as (
    select
      l.product_id,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0)    as paid,
      coalesce(sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD'), 0) as organic
    from public.affiliate_order_lines l
    where l.shop_id = p_shop_id
      and l.counts_toward_gmv
      and l.product_id is not null
      and (l.order_created_at at time zone 'UTC')::date between p_start and p_end
    group by 1
  ),
  -- The freshest snapshot whose window ends inside the range asked for.
  w as (
    select distinct on (product_id) *
    from public.product_window_metrics
    where shop_id = p_shop_id and window_end between p_start and p_end
    order by product_id, window_end desc
  )
  select
    coalesce(w.product_id, m.product_id),
    coalesce(c.title, w.product_name),
    coalesce(c.image_url, w.cover_image_url),
    w.gmv,
    w.orders,
    w.items_sold,
    w.aov,
    w.refunds,
    w.refunds / nullif(w.gmv, 0),
    w.impressions,
    w.clicks,
    w.ctr,
    w.add_to_cart_rate,
    w.click_to_order_rate,
    w.affiliate_gmv,
    w.product_card_gmv,
    w.shop_tab_gmv,
    w.seller_video_gmv,
    coalesce(m.paid, 0),
    coalesce(m.organic, 0),
    m.paid / nullif(m.paid + m.organic, 0),
    c.min_price,
    c.max_price,
    c.inventory,
    c.commission_rate,
    c.discount_pct,
    w.days_with_data
  from w
  full join mine m on m.product_id = w.product_id
  left join public.product_catalog c
    on c.shop_id = p_shop_id and c.product_id = coalesce(w.product_id, m.product_id)
  order by coalesce(w.gmv, 0) desc, coalesce(m.paid, 0) + coalesce(m.organic, 0) desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.product_catalog        enable row level security;
alter table public.product_window_metrics enable row level security;

drop policy if exists pc_select on public.product_catalog;
create policy pc_select on public.product_catalog for select
  using (public.can_view_shop(shop_id, auth.uid()));

drop policy if exists pwm_select on public.product_window_metrics;
create policy pwm_select on public.product_window_metrics for select
  using (public.can_view_shop(shop_id, auth.uid()));

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
    raise exception '006: anon can call shop_products';
  end if;

  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename in ('product_catalog','product_window_metrics')
     and cmd <> 'SELECT';
  if v <> 0 then
    raise exception '006: product tables have % write policies', v;
  end if;

  raise notice '006: product context ready — funnel and refunds measured; discount depth unavailable at source';
end;
$verify$;
