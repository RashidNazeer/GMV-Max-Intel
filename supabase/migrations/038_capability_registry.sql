-- ═══════════════════════════════════════════════════════════════════════════
-- GMV Max Intelligence — 038: what this integration can and cannot do, written
-- down where the app can read it.
--
-- ── WHY A REGISTRY AND NOT A CONSTANT ──────────────────────────────────────
-- "Per-video spend is not available" currently lives in a code comment and in a
-- hardcoded CAPABILITY.UNAVAILABLE. That is true today, for this provider, on
-- these shops. It is not a property of the universe: Reacher may ship the
-- endpoint next month, a different shop may have a different ad account
-- permission, and LIVE GMV Max is a different product from Product GMV Max with
-- different fields. A constant cannot express any of that, and a constant is
-- also invisible — an operator cannot see WHY an action is unavailable, or when
-- anyone last checked.
--
-- ── THREE STATES, AND ONE OF THEM NEEDS A HUMAN ────────────────────────────
--   supported     something we can read says yes
--   unavailable   something we can read says no
--   unknown       we cannot tell from read-only access
--
-- `unknown` is not a failure state, it is the honest one for a capability whose
-- only definitive test is a create-shaped call — and this product does not write
-- to TikTok. Creative Boost sits there permanently until a human confirms it in
-- the platform and records when.
--
-- ── SCOPE MATTERS ──────────────────────────────────────────────────────────
-- Keyed by provider, shop and campaign_type. Product GMV Max and LIVE GMV Max
-- are assessed SEPARATELY, because they are different products and answering
-- for one while a screen shows the other is exactly the confusion this exists to
-- prevent. shop_id nullable means "true for every shop on this provider".
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.provider_capabilities (
  id             uuid primary key default gen_random_uuid(),
  provider       text not null,
  -- NULL = applies to every shop on this provider. A row naming a shop wins
  -- over one that does not, so a shop whose ad account differs can be recorded
  -- without contradicting the general case.
  shop_id        uuid references public.shops(id) on delete cascade,
  -- NULL = applies to every campaign type. 'PRODUCT' and 'LIVE' are the two
  -- GMV Max products and they are NOT interchangeable.
  -- '*' rather than NULL for 'any type'. A NULL cannot take part in a unique
  -- constraint usefully, and the coalesce() that would fix that is not allowed
  -- inside one — the mistake migration 037 already documented and this file
  -- promptly repeated.
  campaign_type  text not null default '*',
  capability     text not null,

  state          text not null check (state in ('supported', 'unavailable', 'unknown')),
  -- What we actually observed. Not a justification written afterwards: the
  -- field a probe returned, the status code, the emptiness of a feed.
  evidence       text,
  -- The external thing that would have to change for this to become supported.
  -- Null when it already is.
  dependency     text,
  -- When this was last established, and by what. A capability nobody has
  -- checked for six months is a different claim from one probed this morning.
  verified_at    timestamptz not null default now(),
  verified_by    text not null default 'probe'
                   check (verified_by in ('probe', 'operator', 'documentation')),

  updated_at     timestamptz not null default now(),

  -- A GENERATED column carries the coalesce so the constraint does not have to.
  -- shop_id stays nullable because the foreign key is worth keeping, and this
  -- mirrors it into something a unique constraint can use.
  shop_key uuid generated always as
    (coalesce(shop_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored,

  constraint capability_identity
    unique (provider, capability, shop_key, campaign_type)
);

create index if not exists provider_capabilities_lookup_idx
  on public.provider_capabilities (provider, capability, shop_id);

comment on table public.provider_capabilities is
  'What each integration can and cannot do, scoped by provider, shop and campaign type. supported | unavailable | unknown, each with the evidence that established it and the dependency that would change it. Product GMV Max and LIVE GMV Max are assessed separately because they are different products.';


-- ── resolution: the most specific row wins ─────────────────────────────────
create or replace function public.capability_state(
  p_provider      text,
  p_capability    text,
  p_shop_id       uuid default null,
  p_campaign_type text default null
) returns table (
  state       text,
  evidence    text,
  dependency  text,
  verified_at timestamptz,
  verified_by text,
  scope       text
)
language sql
stable
as $fn$
  select
    c.state, c.evidence, c.dependency, c.verified_at, c.verified_by,
    case
      when c.shop_id is not null and c.campaign_type <> '*' then 'this shop, this campaign type'
      when c.shop_id is not null then 'this shop'
      when c.campaign_type <> '*' then 'this campaign type'
      else 'every shop'
    end
  from public.provider_capabilities c
  where c.provider = p_provider
    and c.capability = p_capability
    and (c.shop_id is null or c.shop_id = p_shop_id)
    and (c.campaign_type = '*' or c.campaign_type = p_campaign_type)
  -- Most specific first: a shop-and-type row beats a shop row beats a general
  -- one. Without this ordering a general "unavailable" could mask a shop that
  -- genuinely has the permission.
  order by
    (c.shop_id is not null)::int + (c.campaign_type <> '*')::int desc,
    c.verified_at desc
  limit 1;
$fn$;


create or replace function public.capabilities_for_shop(p_shop_id uuid)
returns table (
  provider text, capability text, campaign_type text, state text,
  evidence text, dependency text, verified_at timestamptz, verified_by text
)
language sql
stable
security definer
set search_path = public
as $fn$
  select c.provider, c.capability, c.campaign_type, c.state,
         c.evidence, c.dependency, c.verified_at, c.verified_by
    from public.provider_capabilities c
   where (c.shop_id is null or c.shop_id = p_shop_id)
     and (auth.uid() is not null and public.can_view_shop(p_shop_id, auth.uid()))
   order by c.provider, c.capability, c.campaign_type;
$fn$;


create or replace function public.record_capability(
  p_provider      text,
  p_capability    text,
  p_state         text,
  p_evidence      text default null,
  p_dependency    text default null,
  p_shop_id       uuid default null,
  p_campaign_type text default null,
  p_verified_by   text default 'probe'
) returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare v_id uuid;
begin
  insert into public.provider_capabilities
    (provider, capability, state, evidence, dependency, shop_id, campaign_type, verified_by,
     verified_at, updated_at)
  values
    (p_provider, p_capability, p_state, p_evidence, p_dependency, p_shop_id, coalesce(p_campaign_type, '*'),
     coalesce(p_verified_by, 'probe'), now(), now())
  on conflict on constraint capability_identity do update
    set state = excluded.state,
        evidence = excluded.evidence,
        dependency = excluded.dependency,
        verified_by = excluded.verified_by,
        verified_at = now(),
        updated_at = now()
  returning id into v_id;
  return v_id;
end;
$fn$;


-- ═══════════════════════════════════════════════════════════════════════════
-- Seed: what we have actually established, with the evidence that established
-- it. Every line below was observed, not assumed — most of them the hard way,
-- during the first live sync.
-- ═══════════════════════════════════════════════════════════════════════════
do $seed$
begin
  perform public.record_capability('reacher', 'affiliate_transactions', 'supported',
    'Returns order lines with actual and estimated commission split by Shop Ads and standard. This is the only source the paid/organic classification needs, and it works.',
    null, null, null, 'probe');

  perform public.record_capability('reacher', 'shop_gmv_timeseries', 'supported',
    'Daily shop GMV by channel, which is the denominator every share on the Attribution page divides by.',
    null, null, null, 'probe');

  perform public.record_capability('reacher', 'campaign_settings_read', 'supported',
    'The campaign LIST carries roas_bid and budget directly. Note the per-campaign /settings endpoint returns all nulls even on an active campaign, so those two fields must come from the list.',
    null, null, 'PRODUCT', 'probe');

  perform public.record_capability('reacher', 'campaign_change_feed', 'unavailable',
    '/campaigns/{id}/changes returns empty on every campaign probed. Settings history therefore starts the day we began snapshotting (2026-09-08) and nothing earlier can be recovered.',
    'Reacher exposing a change feed, or any endpoint that returns historical setting values',
    null, null, 'probe');

  perform public.record_capability('reacher', 'per_video_spend', 'unavailable',
    'No per-video cost or impression field exists on any probed endpoint. video_performance carries `views`, which is a LIFETIME figure and does not move with the reporting date filter, so it cannot show whether a video was delivered during a given window.',
    'A per-video delivery metric scoped to a date range — spend or impressions',
    null, null, 'probe');

  perform public.record_capability('reacher', 'per_product_spend', 'unavailable',
    'Spend is reported at campaign level only. TikTok''s own API buckets all cost under spu_id = -1, and nothing in this integration resolves it further.',
    'Per-product cost attribution from the provider',
    null, null, 'probe');

  perform public.record_capability('reacher', 'spend_by_surface', 'unavailable',
    '/spend-by-surface returns empty, so the like-for-like affiliate ROAS stays null by design rather than being estimated.',
    'The surface split being populated upstream',
    null, null, 'probe');

  perform public.record_capability('reacher', 'campaign_impressions_clicks', 'unavailable',
    '/campaigns/{id}/metrics returns date, spend, gross_revenue, roas and ad_roi, but impressions, clicks, orders, cpc, cpm and ctr are all null. Stored as null rather than zero: "TikTok did not report this" is not "there were no clicks".',
    'The provider populating the delivery columns it already returns',
    null, 'PRODUCT', 'probe');

  -- THE ONE THAT MUST STAY UNKNOWN. Read-only access cannot establish it, and
  -- guessing `supported` would put a control on screen that does nothing.
  perform public.record_capability('reacher', 'creative_boost', 'unknown',
    'The only definitive check Reacher offers is a create-shaped call, and this product does not write to TikTok. Read-only access cannot distinguish "not supported" from "supported but unused".',
    'An operator confirming it in TikTok Ads Manager and recording the result, or a read-only support check from the provider',
    null, null, 'probe');

  -- LIVE GMV Max is a DIFFERENT PRODUCT and is assessed separately. Answering
  -- for Product GMV Max while a screen shows LIVE is exactly the confusion the
  -- campaign_type column exists to prevent.
  perform public.record_capability('reacher', 'campaign_settings_read', 'unknown',
    'No LIVE GMV Max campaign has been observed on any connected shop, so whether its settings read back the same way as a PRODUCT campaign has never been tested.',
    'A LIVE GMV Max campaign existing on a connected shop',
    null, 'LIVE', 'probe');

  raise notice '038: seeded % capability rows', (select count(*) from public.provider_capabilities);
end;
$seed$;


alter table public.provider_capabilities enable row level security;

drop policy if exists capabilities_select on public.provider_capabilities;
create policy capabilities_select on public.provider_capabilities for select
  using (shop_id is null or public.can_view_shop(shop_id, auth.uid()));

-- No client write policy. A capability an operator can assert without evidence
-- is worse than one nobody recorded — record_capability() is the only path, and
-- it takes the evidence as a required part of the claim.

do $g$
declare s text;
begin
  foreach s in array array[
    'public.capability_state(text, text, uuid, text)',
    'public.capabilities_for_shop(uuid)'
  ] loop
    execute format('revoke all on function %s from public', s);
    execute format('revoke all on function %s from anon', s);
    execute format('grant execute on function %s to authenticated', s);
  end loop;
  execute 'revoke all on function public.record_capability(text, text, text, text, text, uuid, text, text) from public';
  execute 'revoke all on function public.record_capability(text, text, text, text, text, uuid, text, text) from anon';
  execute 'grant execute on function public.record_capability(text, text, text, text, text, uuid, text, text) to service_role';
end;
$g$;


-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY
-- ═══════════════════════════════════════════════════════════════════════════
do $v$
declare
  shop uuid; uid uuid; r record; n integer;
begin
  select id into shop from public.shops where shop_name ilike 'Biostime%' limit 1;
  select p.id into uid from public.profiles p where public.can_view_shop(shop, p.id) limit 1;

  -- 1. The two GMV Max products must answer SEPARATELY.
  select * into r from public.capability_state('reacher', 'campaign_settings_read', shop, 'PRODUCT');
  if r.state <> 'supported' then
    raise exception '038: PRODUCT settings should be supported, got %', r.state;
  end if;
  select * into r from public.capability_state('reacher', 'campaign_settings_read', shop, 'LIVE');
  if r.state <> 'unknown' then
    raise exception '038: LIVE settings should be unknown, got %', r.state;
  end if;
  raise notice '038: PRODUCT and LIVE answer separately (supported vs unknown)';

  -- 2. Creative Boost must stay unknown. Read-only access cannot establish it,
  --    and a `supported` here would put a dead control on screen.
  select * into r from public.capability_state('reacher', 'creative_boost', shop, null);
  if r.state <> 'unknown' then
    raise exception '038: creative_boost must be unknown from read-only access, got %', r.state;
  end if;
  if r.dependency is null then
    raise exception '038: an unknown capability must name what would resolve it';
  end if;

  -- 3. Every unavailable row must name a dependency. "It does not work" without
  --    "and here is what would make it work" is not actionable.
  select count(*)::integer into n
    from public.provider_capabilities
   where state = 'unavailable' and (dependency is null or btrim(dependency) = '');
  if n > 0 then
    raise exception '038: % unavailable capabilities name no dependency', n;
  end if;

  -- 4. And every row must carry the evidence that established it.
  select count(*)::integer into n
    from public.provider_capabilities where evidence is null or btrim(evidence) = '';
  if n > 0 then
    raise exception '038: % capabilities carry no evidence', n;
  end if;

  -- 5. A more specific row must win.
  perform public.record_capability('reacher', 'per_video_spend', 'supported',
    'verification row: this shop was granted the delivery endpoint', null, shop, null, 'operator');
  select * into r from public.capability_state('reacher', 'per_video_spend', shop, null);
  if r.state <> 'supported' or r.scope <> 'this shop' then
    raise exception '038: a shop-specific row did not win, got % (%)', r.state, r.scope;
  end if;
  delete from public.provider_capabilities
   where shop_id = shop and capability = 'per_video_spend';
  select * into r from public.capability_state('reacher', 'per_video_spend', shop, null);
  if r.state <> 'unavailable' then
    raise exception '038: removing the shop row did not fall back to the general one';
  end if;
  raise notice '038: specificity resolves correctly, and falls back when removed';

  raise notice '038: verified — % capabilities recorded',
    (select count(*) from public.provider_capabilities);
end;
$v$;
