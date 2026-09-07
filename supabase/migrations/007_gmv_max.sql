-- ============================================================
-- GMV Max Intelligence — 007: ad spend, campaign memory, and the rule that
-- keeps simulated data from ever being mistaken for real money.
--
-- ── WHY SIMULATED DATA EXISTS AT ALL ───────────────────────────────────────
-- The ad account is not yet connected in Reacher: GET /gmv-max/campaigns
-- returns zero campaigns for all three shops, so there is no spend, and without
-- spend there is no return on it. The product still has to be demonstrable
-- before that connection lands, so this schema accepts SIMULATED campaigns.
--
-- That is a genuinely dangerous thing to put in a revenue database, so it is
-- fenced three ways:
--
--   1. Every row carries data_source ('reacher' | 'simulated'), not null.
--   2. A shop may not hold both at once. A trigger rejects the second kind.
--      Half-real ROAS — measured revenue over invented spend — is the one
--      outcome that would produce a confident, plausible, wrong number.
--   3. Every reporting function RETURNS data_source, so a caller cannot render
--      a figure without also being handed the fact that it was invented.
--
-- When the real integration lands, `npm run demo:purge` deletes the simulated
-- rows and the same screens fill with measured data. Nothing else changes.
--
-- ── ONE MORE HONESTY PROBLEM, BUILT IN ─────────────────────────────────────
-- GMV Max spend buys delivery across several surfaces — affiliate video,
-- product card, brand — but our measured paid revenue only covers the
-- affiliate one, because that is the only place a commission programme names
-- the cause. Dividing ALL spend into AFFILIATE-ONLY revenue therefore
-- understates the return. That ratio is a floor and is named as one. When
-- /gmv-max/campaigns/{id}/spend-by-surface gives a per-surface split, the
-- like-for-like ratio becomes available and is returned separately.
-- ============================================================

create table if not exists public.gmv_max_campaigns (
  id                uuid primary key default gen_random_uuid(),
  shop_id           uuid not null references public.shops(id) on delete cascade,
  campaign_id       text not null,
  campaign_name     text,
  status            text,
  campaign_type     text,
  product_id        text,

  target_roas       numeric(10,4),
  daily_budget      numeric(14,2),
  optimization_mode text,
  currency          text,

  data_source       text not null check (data_source in ('reacher','simulated')),
  raw               jsonb,
  first_seen_at     timestamptz not null default now(),
  synced_at         timestamptz not null default now(),

  unique (shop_id, campaign_id)
);

create table if not exists public.gmv_max_daily_metrics (
  shop_id             uuid not null references public.shops(id) on delete cascade,
  campaign_id         text not null,
  day                 date not null,

  spend               numeric(14,2),
  impressions         bigint,
  clicks              bigint,
  orders              integer,
  revenue             numeric(14,2),   -- GMV Max's OWN attributed revenue
  roi                 numeric(12,4),   -- and its own ROI, kept as reported
  cpc                 numeric(12,4),
  cpm                 numeric(12,4),
  ctr                 numeric(10,6),

  -- per-surface spend, when the surface endpoint provides it
  spend_affiliate     numeric(14,2),
  spend_product_card  numeric(14,2),
  spend_brand         numeric(14,2),

  data_source         text not null check (data_source in ('reacher','simulated')),
  raw                 jsonb,
  synced_at           timestamptz not null default now(),

  primary key (shop_id, campaign_id, day)
);

create index if not exists gmd_shop_day_idx on public.gmv_max_daily_metrics (shop_id, day desc);

-- Campaign memory (spec layer: "what changed, and what happened next").
-- Append-only: Reacher exposes /changes as a log, and an outcome evaluation is
-- only meaningful if the history is not rewritten under it.
create table if not exists public.gmv_max_settings_changes (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops(id) on delete cascade,
  campaign_id  text not null,
  changed_at   timestamptz not null,
  field        text not null,
  old_value    text,
  new_value    text,
  data_source  text not null check (data_source in ('reacher','simulated')),
  raw          jsonb,
  synced_at    timestamptz not null default now(),
  unique (shop_id, campaign_id, changed_at, field)
);

create index if not exists gmsc_shop_time_idx on public.gmv_max_settings_changes (shop_id, changed_at desc);

-- ============================================================
-- Fence 2: a shop may not hold real and simulated rows at the same time.
-- ============================================================
create or replace function public._gmv_max_source_guard()
returns trigger
language plpgsql
as $$
declare other text;
begin
  execute format(
    'select data_source from public.%I where shop_id = $1 and data_source <> $2 limit 1',
    tg_table_name
  ) into other using new.shop_id, new.data_source;

  if other is not null then
    raise exception
      'shop % already holds % GMV Max rows in %; refusing to add % rows. Mixing measured spend with simulated spend produces a confident wrong ROAS — purge one source first (npm run demo:purge).',
      new.shop_id, other, tg_table_name, new.data_source;
  end if;
  return new;
end;
$$;

do $t$
declare t text;
begin
  foreach t in array array['gmv_max_campaigns','gmv_max_daily_metrics','gmv_max_settings_changes'] loop
    execute format('drop trigger if exists %I_source_guard on public.%I', t, t);
    execute format(
      'create trigger %I_source_guard before insert or update on public.%I
         for each row execute function public._gmv_max_source_guard()', t, t);
  end loop;
end;
$t$;

-- ============================================================
-- The comparison that is the whole business case:
--   GMV Max says          revenue / spend
--   we say                measured ad-driven revenue / spend
-- ============================================================
create or replace function public.shop_paid_roas(p_shop_id uuid, p_start date, p_end date)
returns table (
  data_source              text,
  is_simulated             boolean,
  campaigns                bigint,
  days_with_spend          integer,
  spend                    numeric,
  spend_affiliate_surface  numeric,
  reported_revenue         numeric,
  reported_roi             numeric,
  measured_paid_gmv        numeric,
  paid_roas_floor          numeric,   -- affiliate-only revenue / ALL spend
  paid_roas_affiliate      numeric,   -- like-for-like, needs the surface split
  overstatement            numeric    -- how much the reported figure flatters
)
language sql
stable
as $$
  with m as (
    select
      max(data_source)                                   as data_source,
      count(distinct campaign_id)                        as campaigns,
      count(distinct day) filter (where coalesce(spend, 0) > 0) as days_with_spend,
      coalesce(sum(spend), 0)                            as spend,
      sum(spend_affiliate)                               as spend_affiliate,
      coalesce(sum(revenue), 0)                          as revenue
    from public.gmv_max_daily_metrics
    where shop_id = p_shop_id and day between p_start and p_end
  ),
  -- Measured paid revenue over the SAME days that carry spend. Comparing a
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
    ours.paid / nullif(m.spend_affiliate, 0),
    (m.revenue / nullif(m.spend, 0)) / nullif(ours.paid / nullif(m.spend, 0), 0)
  from m, ours
  where m.campaigns > 0;   -- no campaigns: return no row, rather than a row of zeros
$$;

-- Daily spend against measured paid revenue — the series behind the comparison.
create or replace function public.shop_spend_daily(p_shop_id uuid, p_start date, p_end date)
returns table (
  day               date,
  data_source       text,
  spend             numeric,
  reported_revenue  numeric,
  measured_paid_gmv numeric,
  paid_roas_floor   numeric
)
language sql
stable
as $$
  with s as (
    select day, max(data_source) as data_source,
           coalesce(sum(spend), 0) as spend, coalesce(sum(revenue), 0) as revenue
    from public.gmv_max_daily_metrics
    where shop_id = p_shop_id and day between p_start and p_end
    group by day
  ),
  p as (
    select (l.order_created_at at time zone 'UTC')::date as day,
           coalesce(sum(l.payment_amount), 0) as paid
    from public.affiliate_order_lines l
    where l.shop_id = p_shop_id and l.counts_toward_gmv
      and l.classification = 'PAID_SHOP_ADS'
      and (l.order_created_at at time zone 'UTC')::date between p_start and p_end
    group by 1
  )
  select s.day, s.data_source, s.spend, s.revenue,
         coalesce(p.paid, 0), coalesce(p.paid, 0) / nullif(s.spend, 0)
  from s left join p on p.day = s.day
  order by s.day;
$$;

-- Fence 3 support: one call that tells a screen whether anything it is about to
-- render was invented.
create or replace function public.shop_data_sources(p_shop_id uuid)
returns table (has_simulated boolean, has_measured boolean, campaigns bigint)
language sql
stable
as $$
  select
    coalesce(bool_or(data_source = 'simulated'), false),
    coalesce(bool_or(data_source = 'reacher'), false),
    count(*)
  from public.gmv_max_campaigns
  where shop_id = p_shop_id;
$$;

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.gmv_max_campaigns        enable row level security;
alter table public.gmv_max_daily_metrics    enable row level security;
alter table public.gmv_max_settings_changes enable row level security;

drop policy if exists gmc_select  on public.gmv_max_campaigns;
create policy gmc_select  on public.gmv_max_campaigns for select
  using (public.can_view_shop(shop_id, auth.uid()));

drop policy if exists gmd_select  on public.gmv_max_daily_metrics;
create policy gmd_select  on public.gmv_max_daily_metrics for select
  using (public.can_view_shop(shop_id, auth.uid()));

drop policy if exists gmsc_select on public.gmv_max_settings_changes;
create policy gmsc_select on public.gmv_max_settings_changes for select
  using (public.can_view_shop(shop_id, auth.uid()));

do $grants$
declare fn text;
begin
  foreach fn in array array[
    'public.shop_paid_roas(uuid, date, date)',
    'public.shop_spend_daily(uuid, date, date)',
    'public.shop_data_sources(uuid)'
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
    'public.shop_paid_roas(uuid, date, date)',
    'public.shop_spend_daily(uuid, date, date)',
    'public.shop_data_sources(uuid)'
  ] loop
    if has_function_privilege('anon', fn, 'execute') then
      raise exception '007: anon can call %', fn;
    end if;
  end loop;

  select count(*) into v from pg_policies
   where schemaname = 'public'
     and tablename in ('gmv_max_campaigns','gmv_max_daily_metrics','gmv_max_settings_changes')
     and cmd <> 'SELECT';
  if v <> 0 then
    raise exception '007: GMV Max tables have % write policies — ingestion stays service-role only', v;
  end if;

  select count(*) into v from pg_trigger
   where not tgisinternal and tgname like '%_source_guard';
  if v <> 3 then
    raise exception '007: expected 3 source guards, found % — simulated and measured spend could mix', v;
  end if;

  raise notice '007: spend substrate ready — simulated and measured rows cannot coexist on one shop';
end;
$verify$;
