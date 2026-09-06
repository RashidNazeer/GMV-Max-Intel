-- ============================================================
-- GMV Max Intelligence — 003: window-scoped summaries, aggregated in the DB.
--
-- ── WHY THIS EXISTS ────────────────────────────────────────────────────────
-- The first sync read its own results back with a plain select and reported
-- Cutler as 395 lines when 2,261 had just been written. Nothing was wrong with
-- the data: PostgREST caps a select at 1,000 rows, and the summary was quietly
-- adding up the first page only. Two shops' worth of rows happened to total
-- exactly 1,000, which is the kind of coincidence that makes a bug look like a
-- data problem.
--
-- Any total computed by pulling rows into the client is one silent page limit
-- away from being wrong, so totals are computed in SQL and returned as one row
-- per shop. The UI uses the same function, so the screen and the sync report
-- cannot disagree.
--
-- SECURITY INVOKER (the default) is deliberate: RLS still applies, so an
-- ads_manager calling this sees only the shops they have access to.
-- ============================================================

create or replace function public.shop_affiliate_summary(p_start date, p_end date)
returns table (
  shop_id           uuid,
  shop_name         text,
  currency          text,
  affiliate_connected boolean,
  lines             bigint,
  gmv               numeric,
  paid_gmv          numeric,
  organic_gmv       numeric,
  mixed_gmv         numeric,
  unclassified_gmv  numeric,
  settled_lines     bigint,
  paid_share        numeric,
  coverage          numeric
)
language sql
stable
as $$
  select
    s.id,
    coalesce(s.display_name, s.shop_name),
    s.currency,
    s.affiliate_connected,
    count(l.id),
    coalesce(sum(l.payment_amount), 0),
    coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0),
    coalesce(sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD'), 0),
    coalesce(sum(l.payment_amount) filter (where l.classification = 'MIXED'), 0),
    coalesce(sum(l.payment_amount) filter (where l.classification = 'UNCLASSIFIED'), 0),
    count(l.id) filter (where l.classification_basis = 'ACTUAL_COMMISSION'),
    -- Share is of CLASSIFIED revenue, and NULL when there is none to divide by.
    -- Returning 0 for "no data" would read on screen as "nothing was paid",
    -- which is a different and much more damaging claim.
    sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS')
      / nullif(sum(l.payment_amount) filter (where l.classification in ('PAID_SHOP_ADS','ORGANIC_STANDARD')), 0),
    sum(l.payment_amount) filter (where l.classification in ('PAID_SHOP_ADS','ORGANIC_STANDARD'))
      / nullif(sum(l.payment_amount), 0)
  from public.shops s
  left join public.affiliate_order_lines l
    on l.shop_id = s.id
   and l.counts_toward_gmv
   and (l.order_created_at at time zone 'UTC')::date between p_start and p_end
  group by s.id, s.display_name, s.shop_name, s.currency, s.affiliate_connected
  order by 6 desc;
$$;

-- Daily series for one shop — the chart behind the headline.
create or replace function public.shop_affiliate_daily(p_shop_id uuid, p_start date, p_end date)
returns table (
  day          date,
  lines        bigint,
  gmv          numeric,
  paid_gmv     numeric,
  organic_gmv  numeric,
  paid_share   numeric
)
language sql
stable
as $$
  select
    (l.order_created_at at time zone 'UTC')::date,
    count(*),
    sum(l.payment_amount),
    coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0),
    coalesce(sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD'), 0),
    sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS')
      / nullif(sum(l.payment_amount) filter (where l.classification in ('PAID_SHOP_ADS','ORGANIC_STANDARD')), 0)
  from public.affiliate_order_lines l
  where l.shop_id = p_shop_id
    and l.counts_toward_gmv
    and (l.order_created_at at time zone 'UTC')::date between p_start and p_end
  group by 1
  order by 1;
$$;

-- Top creators by the revenue they actually drove, split by how it was driven.
create or replace function public.shop_top_creators(p_shop_id uuid, p_start date, p_end date, p_limit int default 25)
returns table (
  creator_handle text,
  lines          bigint,
  gmv            numeric,
  paid_gmv       numeric,
  organic_gmv    numeric,
  paid_share     numeric
)
language sql
stable
as $$
  select
    l.creator_handle,
    count(*),
    sum(l.payment_amount),
    coalesce(sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS'), 0),
    coalesce(sum(l.payment_amount) filter (where l.classification = 'ORGANIC_STANDARD'), 0),
    sum(l.payment_amount) filter (where l.classification = 'PAID_SHOP_ADS')
      / nullif(sum(l.payment_amount) filter (where l.classification in ('PAID_SHOP_ADS','ORGANIC_STANDARD')), 0)
  from public.affiliate_order_lines l
  where l.shop_id = p_shop_id
    and l.counts_toward_gmv
    and (l.order_created_at at time zone 'UTC')::date between p_start and p_end
  group by 1
  order by 3 desc
  limit greatest(1, least(coalesce(p_limit, 25), 200));
$$;

-- Supabase grants EXECUTE to anon by default on every new function, and
-- revoking from PUBLIC does not remove that explicit grant — anon has to be
-- named. These read client revenue, so anon must not reach them at all.
do $grants$
declare fn text;
begin
  foreach fn in array array[
    'public.shop_affiliate_summary(date, date)',
    'public.shop_affiliate_daily(uuid, date, date)',
    'public.shop_top_creators(uuid, date, date, int)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$grants$;

do $verify$
declare fn text;
begin
  foreach fn in array array[
    'public.shop_affiliate_summary(date, date)',
    'public.shop_affiliate_daily(uuid, date, date)',
    'public.shop_top_creators(uuid, date, date, int)'
  ] loop
    if has_function_privilege('anon', fn, 'execute') then
      raise exception '003: anon can call % — it reads client revenue', fn;
    end if;
    if not has_function_privilege('authenticated', fn, 'execute') then
      raise exception '003: authenticated cannot call %', fn;
    end if;
  end loop;
  raise notice '003: summary functions ready — totals computed in SQL, not paged in the client';
end;
$verify$;
