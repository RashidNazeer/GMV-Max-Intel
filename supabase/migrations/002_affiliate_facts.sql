-- ============================================================
-- GMV Max Intelligence — 002: the affiliate order-line fact table.
--
-- This is the highest-value table in the system (spec §11.7). Every downstream
-- number — paid GMV, organic share, WURX Estimated Paid ROAS — is a sum over
-- these rows, so it has to be line-item safe and re-syncable without ever
-- double-counting revenue.
--
-- ── THE NATURAL KEY ────────────────────────────────────────────────────────
-- Measured on 2,866 live order lines across two shops:
--     order_id alone            -> 50 collisions   (multi-SKU orders)
--     order_id + sku_id         -> 0 collisions
-- and order_id, sku_id, product_id, creator_handle, content_id, content_type,
-- order_created_at and currency were non-null on every single row.
--
-- So (shop_id, order_id, sku_id) is the unique key and the upsert target. This
-- is what makes a re-sync idempotent, which matters because affiliate rows are
-- MUTABLE: a pending order's estimated commission becomes an actual one when it
-- settles, and refunds arrive late (spec §38).
--
-- ── WHY CLASSIFICATION IS STORED, NOT COMPUTED IN SQL ──────────────────────
-- `classification` and `classification_basis` are written by the ingest job
-- using src/lib/reacher/classify.js. There is deliberately ONE implementation
-- of that rule, in tested JavaScript, rather than a second copy in SQL that can
-- drift from it. The columns are stored so the UI can aggregate cheaply, and
-- the raw commission fields are kept alongside so any row can be re-derived and
-- audited if the rule ever changes.
-- ============================================================

create table if not exists public.affiliate_order_lines (
  id                       uuid primary key default gen_random_uuid(),
  shop_id                  uuid not null references public.shops(id) on delete cascade,

  -- identity
  order_id                 text not null,
  sku_id                   text not null,
  product_id               text,
  product_name             text,
  creator_handle           text,
  content_id               text,
  content_type             text,          -- Video / Showcase / Livestream / External Traffic Program

  -- state
  order_status             text,
  is_settled               boolean,
  fully_refunded           boolean not null default false,

  -- money. payment_amount is the GMV basis (spec §12.3): gross at payment,
  -- one definition used consistently everywhere.
  quantity                 integer,
  price                    numeric(14,2),
  payment_amount           numeric(14,2),
  currency                 text,

  -- commission evidence — the raw material of the paid/organic decision
  commission_model         text,
  standard_commission_rate numeric(10,4),
  shop_ads_commission_rate numeric(10,4),
  est_commission_base      numeric(14,2),
  est_standard_commission  numeric(14,2),
  est_shop_ads_commission  numeric(14,2),
  est_cofunded_bonus       numeric(14,2),
  act_commission_base      numeric(14,2),
  act_standard_commission  numeric(14,2),
  act_shop_ads_commission  numeric(14,2),
  act_cofunded_bonus       numeric(14,2),

  -- the verdict
  classification           text not null default 'UNCLASSIFIED'
                             check (classification in ('PAID_SHOP_ADS','ORGANIC_STANDARD','MIXED','UNCLASSIFIED')),
  classification_basis     text not null default 'NO_EVIDENCE'
                             check (classification_basis in ('ACTUAL_COMMISSION','ESTIMATED_COMMISSION','RATE_ONLY','NO_EVIDENCE')),
  counts_toward_gmv        boolean not null default true,

  -- timestamps from the source
  order_created_at         timestamptz,
  paid_at                  timestamptz,
  delivered_at             timestamptz,
  commission_paid_at       timestamptz,
  platform                 text,

  raw                      jsonb,          -- spec §9: keep the payload for audit
  first_seen_at            timestamptz not null default now(),
  synced_at                timestamptz not null default now(),

  unique (shop_id, order_id, sku_id)
);

-- Every read is "one shop, one date window", so the composite index leads with
-- the two columns that always appear in the predicate.
create index if not exists aol_shop_date_idx
  on public.affiliate_order_lines (shop_id, order_created_at desc);
create index if not exists aol_shop_class_date_idx
  on public.affiliate_order_lines (shop_id, classification, order_created_at desc);
create index if not exists aol_product_idx
  on public.affiliate_order_lines (shop_id, product_id);
create index if not exists aol_creator_idx
  on public.affiliate_order_lines (shop_id, creator_handle);

-- ── Sync observability (spec §11.18) ────────────────────────────────────────
create table if not exists public.sync_runs (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid references public.shops(id) on delete cascade,
  source         text not null default 'reacher',
  job            text not null,
  window_start   date,
  window_end     date,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  status         text not null default 'running'
                   check (status in ('running','ok','partial','error')),
  rows_received  integer not null default 0,
  rows_written   integer not null default 0,
  error          text,
  detail         jsonb not null default '{}'::jsonb
);

create index if not exists sync_runs_shop_idx on public.sync_runs (shop_id, started_at desc);

-- ── Daily rollup ────────────────────────────────────────────────────────────
-- A VIEW, not a materialized table: affiliate rows mutate as orders settle and
-- refunds land, so anything cached would need invalidation logic that is easy
-- to get subtly wrong. Volumes here (thousands of rows per shop-month) are far
-- too small to justify that risk.
--
-- `coverage` is deliberately exposed: when it drops, everything computed from
-- this view becomes less certain, and the UI is required to say so (spec §12.4).
create or replace view public.affiliate_daily as
select
  l.shop_id,
  (l.order_created_at at time zone 'UTC')::date          as day,
  l.product_id,
  count(*)                                                as lines,
  sum(l.payment_amount)                                   as gmv,
  sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS')     as paid_gmv,
  sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD')  as organic_gmv,
  sum(l.payment_amount) filter (where l.classification = 'MIXED')             as mixed_gmv,
  sum(l.payment_amount) filter (where l.classification = 'UNCLASSIFIED')      as unclassified_gmv,
  count(*) filter (where l.classification_basis = 'ACTUAL_COMMISSION')        as settled_lines,
  -- NULLIF keeps a zero-GMV day out of the divisor rather than returning a
  -- fabricated 0% share for a day that simply had no revenue.
  sum(l.payment_amount) filter (where l.classification in ('PAID_SHOP_ADS','ORGANIC_STANDARD'))
    / nullif(sum(l.payment_amount), 0)                    as coverage
from public.affiliate_order_lines l
where l.counts_toward_gmv
group by 1, 2, 3;

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.affiliate_order_lines enable row level security;
alter table public.sync_runs             enable row level security;

drop policy if exists aol_select on public.affiliate_order_lines;
create policy aol_select on public.affiliate_order_lines for select
  using (public.can_view_shop(shop_id, auth.uid()));

drop policy if exists sync_runs_select on public.sync_runs;
create policy sync_runs_select on public.sync_runs for select
  using (shop_id is null or public.can_view_shop(shop_id, auth.uid()));

-- No insert/update/delete policies: ingestion is service-role only, from the
-- edge function. A client must never be able to write a revenue row.

-- ── Verification ────────────────────────────────────────────────────────────
do $verify$
declare v int;
begin
  select count(*) into v from pg_indexes
   where schemaname = 'public' and tablename = 'affiliate_order_lines'
     and indexdef ilike '%UNIQUE%' and indexdef ilike '%order_id%' and indexdef ilike '%sku_id%';
  if v < 1 then
    raise exception '002: the (shop_id, order_id, sku_id) unique key is missing — re-syncing would duplicate revenue';
  end if;

  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'affiliate_order_lines' and cmd <> 'SELECT';
  if v <> 0 then
    raise exception '002: affiliate_order_lines has % write policies — ingestion must stay service-role only', v;
  end if;

  perform 1 from public.affiliate_daily limit 1;   -- the view must at least parse

  raise notice '002: affiliate facts ready — natural key (shop_id, order_id, sku_id), read-only to clients';
end;
$verify$;
