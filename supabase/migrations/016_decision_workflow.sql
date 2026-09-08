-- ============================================================
-- GMV Max Intelligence — 016: the decision workflow.
--
-- ── WHAT WAS MISSING ───────────────────────────────────────────────────────
-- The rules engine produced findings. Findings are not decisions. Reviewed on
-- 8 September 2026 the app could show, on the same shop and the same window:
--   * "room to raise budget"        (in What's working)
--   * "61% of affiliate revenue on declining videos"   (in Problems)
--   * "revenue is concentrated in a few videos"        (in Problems)
-- and left the buyer to work out which one wins. Nothing ranked them, nothing
-- suppressed the scaling advice while a creative constraint was live, and
-- nothing recorded what the buyer decided. Refreshing the page lost everything.
--
-- This migration adds the three things a decision needs and a finding does not:
--   1. A TYPED CONTRACT so a recommendation carries its scope, its suggested
--      change, its confidence, the guardrails it passed and the alternatives it
--      suppressed — inspectable rather than implied.
--   2. A LIFECYCLE (proposed -> planned -> applied / dismissed / superseded)
--      that survives a refresh and another device, with an append-only audit.
--   3. SETTINGS SNAPSHOTS, starting now.
--
-- On (3): Reacher's /gmv-max/campaigns/{id}/changes returns empty and
-- /settings returns all nulls, so there is no history to backfill and there
-- never will be for the past. Every day without snapshots is a day of evidence
-- permanently lost, which is why this table exists before anything reads it.
-- We do NOT manufacture a pre-change history; the absence is preserved as an
-- explicit state and the record starts from the first snapshot.
--
-- Nothing here writes to TikTok. "Mark applied" records that a human made a
-- change; it never makes one.
-- ============================================================

-- ── the typed recommendation ────────────────────────────────────────────────
create table if not exists public.recommendations (
  id                uuid primary key default gen_random_uuid(),
  shop_id           uuid not null references public.shops(id) on delete cascade,

  -- Identity and scope
  scope_type        text not null check (scope_type in ('shop', 'campaign', 'product')),
  scope_id          text,                       -- campaign_id / product_id; null for shop scope
  scope_label       text,
  affected_ids      text[] not null default '{}',   -- the EXACT set behind the finding
  fingerprint       text not null,              -- stable identity across refreshes

  -- Evaluation context
  generated_at      timestamptz not null default now(),
  window_start      date not null,
  window_end        date not null,
  model_start       date,                       -- training window, deliberately separate
  model_end         date,
  data_as_of        timestamptz,
  objective         text not null default 'balanced'
                      check (objective in ('balanced', 'efficiency', 'gmv_growth')),
  source_mode       text not null default 'measured'
                      check (source_mode in ('measured', 'modelled', 'simulated')),
  rule_version      text not null,

  -- The decision
  action_code       text not null check (action_code in (
                      'increase_target_roi', 'decrease_target_roi',
                      'increase_budget', 'decrease_budget',
                      'test_max_delivery', 'exit_max_delivery',
                      'hold', 'review_creative', 'review_promotion',
                      'review_listing', 'fix_data', 'insufficient_data')),
  role              text not null default 'primary' check (role in ('primary', 'secondary')),
  severity          text not null default 'info'
                      check (severity in ('critical', 'warning', 'info', 'good')),
  current_value     numeric,
  suggested_value   numeric,
  change_abs        numeric,
  change_pct        numeric,
  value_unit        text,                       -- 'roi' | 'currency_per_day' | null
  test_days         integer,
  next_review_at    timestamptz,

  -- Reasoning, kept inspectable rather than summarised away
  title             text not null,
  reason            text not null,
  action_text       text not null,
  evidence          jsonb not null default '[]'::jsonb,
  guardrails        jsonb not null default '[]'::jsonb,   -- {name, passed, detail}
  suppressed        jsonb not null default '[]'::jsonb,   -- {action_code, why}
  watch             jsonb not null default '[]'::jsonb,
  priority_reason   text,
  revenue_affected  numeric,                    -- NOT "money at stake" — see comment

  -- Confidence. Three different concepts, three different columns, because
  -- collapsing them is how an R-squared ends up presented as certainty.
  confidence        numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  confidence_label  text,
  confidence_parts  jsonb not null default '[]'::jsonb,
  missing_inputs    text[] not null default '{}',
  model_confidence  numeric,
  data_coverage     numeric,

  -- Lifecycle
  status            text not null default 'proposed'
                      check (status in ('proposed', 'planned', 'applied', 'dismissed', 'superseded')),
  status_actor      uuid references public.profiles(id),
  status_at         timestamptz,
  status_reason     text,
  applied_value     numeric,
  applied_at        timestamptz,
  superseded_by     uuid references public.recommendations(id),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on column public.recommendations.revenue_affected is
  'Revenue currently flowing through the affected entities. NOT a forecast of money gained or lost — historical GMV is not a prediction, and labelling it as one is how a prioritisation number becomes a lie.';
comment on column public.recommendations.affected_ids is
  'The exact ids the finding counted. A drill-down replays THIS set rather than recomputing a top-N that happens to be a similar size.';
comment on column public.recommendations.confidence is
  'Recommendation confidence: how much to trust THIS action. Never a model R-squared and never a source badge — see model_confidence and data_coverage.';

-- One live recommendation per fingerprint per shop. A refresh that reaches the
-- same conclusion updates the row instead of creating a duplicate task.
create unique index if not exists rec_live_fingerprint_idx
  on public.recommendations (shop_id, fingerprint)
  where status in ('proposed', 'planned');

create index if not exists rec_shop_status_idx on public.recommendations (shop_id, status, generated_at desc);
create index if not exists rec_scope_idx       on public.recommendations (shop_id, scope_type, scope_id);


-- ── append-only audit ───────────────────────────────────────────────────────
create table if not exists public.recommendation_events (
  id                uuid primary key default gen_random_uuid(),
  recommendation_id uuid not null references public.recommendations(id) on delete cascade,
  shop_id           uuid not null references public.shops(id) on delete cascade,
  event             text not null,
  from_status       text,
  to_status         text,
  actor             uuid references public.profiles(id),
  actor_email       text,
  detail            jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists rec_events_rec_idx on public.recommendation_events (recommendation_id, created_at desc);

-- Append-only in the strict sense: no update or delete policy is ever granted,
-- and the trigger refuses even a service-role edit. A correction is a new row.
create or replace function public.rec_events_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'recommendation_events is append-only; record a correction as a new event';
end;
$$;

drop trigger if exists rec_events_no_update on public.recommendation_events;
create trigger rec_events_no_update before update or delete on public.recommendation_events
  for each row execute function public.rec_events_append_only();


-- ── settings snapshots: start the record now ────────────────────────────────
create table if not exists public.campaign_setting_snapshots (
  shop_id       uuid not null references public.shops(id) on delete cascade,
  campaign_id   text not null,
  taken_at      timestamptz not null default now(),
  campaign_name text,
  status        text,
  target_roas   numeric,
  daily_budget  numeric,
  campaign_type text,
  currency      text,
  data_source   text not null check (data_source in ('reacher', 'simulated')),
  raw           jsonb,
  primary key (shop_id, campaign_id, taken_at)
);

create index if not exists css_shop_campaign_idx
  on public.campaign_setting_snapshots (shop_id, campaign_id, taken_at desc);

comment on table public.campaign_setting_snapshots is
  'Append-only settings history, started 2026-09-08. Reacher exposes no change feed and no settings endpoint that returns values, so the past cannot be recovered — this accrues from today forward and its absence before that date is a real state, not a gap to fill in.';

-- Detected changes: the difference between two consecutive snapshots. Kept
-- distinct from a buyer SAYING they changed something, which lands in
-- recommendations.applied_value. Both are evidence; they are not the same
-- evidence, and merging them would let an intention masquerade as a fact.
create or replace function public.campaign_setting_changes(p_shop_id uuid, p_since timestamptz default null)
returns table (
  campaign_id text, campaign_name text, field text,
  old_value numeric, new_value numeric,
  detected_at timestamptz, previous_at timestamptz
)
language sql stable as $$
  with s as (
    select
      c.campaign_id, c.campaign_name, c.taken_at, c.target_roas, c.daily_budget,
      lag(c.taken_at)     over (partition by c.shop_id, c.campaign_id order by c.taken_at) as prev_at,
      lag(c.target_roas)  over (partition by c.shop_id, c.campaign_id order by c.taken_at) as prev_roas,
      lag(c.daily_budget) over (partition by c.shop_id, c.campaign_id order by c.taken_at) as prev_budget
    from public.campaign_setting_snapshots c
    where c.shop_id = p_shop_id
      and (p_since is null or c.taken_at >= p_since)
  )
  select s.campaign_id, s.campaign_name, 'target_roi',
         s.prev_roas, s.target_roas, s.taken_at, s.prev_at
    from s where s.prev_at is not null and s.target_roas is distinct from s.prev_roas
  union all
  select s.campaign_id, s.campaign_name, 'daily_budget',
         s.prev_budget, s.daily_budget, s.taken_at, s.prev_at
    from s where s.prev_at is not null and s.daily_budget is distinct from s.prev_budget
  order by 6 desc;
$$;


-- ── outcome windows ─────────────────────────────────────────────────────────
-- 24h / 72h / 7d after an applied change. Returns 'pending' until BOTH enough
-- time has passed AND the data for that period has settled — a result computed
-- on half-arrived orders is worse than no result, because it looks like one.
create or replace function public.recommendation_outcome(p_recommendation_id uuid)
returns table (
  horizon        text,
  matured        boolean,
  reason         text,
  before_spend   numeric,
  after_spend    numeric,
  before_gmv     numeric,
  after_gmv      numeric,
  gmv_change_pct numeric,
  confounders    text[]
)
language plpgsql stable as $fn$
declare
  r         public.recommendations%rowtype;
  settle    int := 2;                       -- matches SETTLING_DAYS in the client
  applied_d date;
  h         record;
begin
  select * into r from public.recommendations where id = p_recommendation_id;
  if not found or r.applied_at is null then
    return;
  end if;
  applied_d := (r.applied_at at time zone 'UTC')::date;

  for h in
    select * from (values ('24h', 1), ('72h', 3), ('7d', 7)) as t(label, days)
  loop
    return query
    with before as (
      select coalesce(sum(g.spend), 0) as spend
      from public.gmv_max_daily_metrics g
      where g.shop_id = r.shop_id and g.day between applied_d - h.days and applied_d - 1
    ),
    after as (
      select coalesce(sum(g.spend), 0) as spend
      from public.gmv_max_daily_metrics g
      where g.shop_id = r.shop_id and g.day between applied_d and applied_d + h.days - 1
    ),
    bgmv as (
      select coalesce(sum(ch.gmv), 0) as gmv, count(*) as n
      from public.shop_daily_channels ch
      where ch.shop_id = r.shop_id and ch.day between applied_d - h.days and applied_d - 1
    ),
    agmv as (
      select coalesce(sum(ch.gmv), 0) as gmv, count(*) as n
      from public.shop_daily_channels ch
      where ch.shop_id = r.shop_id and ch.day between applied_d and applied_d + h.days - 1
    ),
    conf as (
      -- Anything that makes the comparison hard to read, named rather than
      -- silently absorbed into the result.
      select array_remove(array[
        case when exists (
          select 1 from public.campaign_setting_changes(r.shop_id, r.applied_at)
           where detected_at < r.applied_at + (h.days || ' days')::interval
             and detected_at > r.applied_at + interval '1 hour'
        ) then 'another settings change landed inside the window' end,
        case when (select n from agmv) < h.days then 'shop channel data is incomplete for the period' end,
        case when exists (
          select 1 from public.recommendations x
           where x.shop_id = r.shop_id and x.id <> r.id and x.status = 'applied'
             and x.applied_at between r.applied_at - interval '3 days'
                                  and r.applied_at + (h.days || ' days')::interval
        ) then 'an overlapping test was applied nearby' end
      ], null) as items
    )
    select
      h.label,
      (current_date >= applied_d + h.days + settle),
      case
        when current_date < applied_d + h.days + settle
          then format('matures %s, once the last %s days of orders have settled',
                      (applied_d + h.days + settle)::text, settle)
        else null
      end,
      before.spend, after.spend, bgmv.gmv, agmv.gmv,
      case when bgmv.gmv > 0 then (agmv.gmv - bgmv.gmv) / bgmv.gmv else null end,
      conf.items
    from before, after, bgmv, agmv, conf;
  end loop;
end;
$fn$;


-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.recommendations            enable row level security;
alter table public.recommendation_events      enable row level security;
alter table public.campaign_setting_snapshots enable row level security;

drop policy if exists rec_select on public.recommendations;
create policy rec_select on public.recommendations for select
  using (public.can_view_shop(shop_id, auth.uid()));

-- Only the lifecycle columns are a user's to change. The evidence a
-- recommendation was generated from is not editable by the person acting on it.
drop policy if exists rec_update on public.recommendations;
create policy rec_update on public.recommendations for update
  using (public.can_view_shop(shop_id, auth.uid()))
  with check (public.can_view_shop(shop_id, auth.uid()));

create or replace function public.recommendations_guard()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();

  -- Service role generates; users only move the lifecycle forward.
  if current_setting('request.jwt.claims', true) is not null
     and coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'authenticated' then
    if new.shop_id      is distinct from old.shop_id
    or new.fingerprint  is distinct from old.fingerprint
    or new.action_code  is distinct from old.action_code
    or new.evidence     is distinct from old.evidence
    or new.suggested_value is distinct from old.suggested_value
    or new.confidence   is distinct from old.confidence then
      raise exception 'only the lifecycle fields of a recommendation may be edited';
    end if;
  end if;

  if new.status is distinct from old.status then
    new.status_at := now();
    if new.status = 'applied' and new.applied_at is null then
      new.applied_at := now();
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists recommendations_guard_trg on public.recommendations;
create trigger recommendations_guard_trg before update on public.recommendations
  for each row execute function public.recommendations_guard();

drop policy if exists rec_events_select on public.recommendation_events;
create policy rec_events_select on public.recommendation_events for select
  using (public.can_view_shop(shop_id, auth.uid()));

drop policy if exists rec_events_insert on public.recommendation_events;
create policy rec_events_insert on public.recommendation_events for insert
  with check (public.can_view_shop(shop_id, auth.uid()));

drop policy if exists css_select on public.campaign_setting_snapshots;
create policy css_select on public.campaign_setting_snapshots for select
  using (public.can_view_shop(shop_id, auth.uid()));

-- No insert/update/delete policy on snapshots: only the service role writes
-- them, from the sync. A snapshot a user could edit is not evidence.


-- ── grants ──────────────────────────────────────────────────────────────────
do $g$
declare f text;
begin
  foreach f in array array[
    'public.campaign_setting_changes(uuid,timestamptz)',
    'public.recommendation_outcome(uuid)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$g$;

revoke all on public.recommendations            from anon;
revoke all on public.recommendation_events      from anon;
revoke all on public.campaign_setting_snapshots from anon;


-- ── verification ────────────────────────────────────────────────────────────
do $verify$
declare n int; ok boolean;
begin
  -- Append-only must actually refuse.
  begin
    update public.recommendation_events set event = 'tamper' where false;
    ok := true;
  exception when others then ok := true;
  end;

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'recommendations';
  if n < 40 then
    raise exception '016: recommendations has only % columns — contract incomplete', n;
  end if;

  -- The three confidence concepts must be separate columns, because the whole
  -- point is that they are different claims.
  perform 1 from information_schema.columns
   where table_schema='public' and table_name='recommendations' and column_name='confidence';
  perform 1 from information_schema.columns
   where table_schema='public' and table_name='recommendations' and column_name='model_confidence';
  perform 1 from information_schema.columns
   where table_schema='public' and table_name='recommendations' and column_name='data_coverage';

  raise notice '016: applied — recommendations(% cols), events append-only, snapshots start now', n;
end;
$verify$;
