-- ============================================================
-- GMV Max Intelligence — 001: identity, shops, and the access model.
--
-- Role names, helper-function names and policy shapes deliberately MIRROR
-- WurxOS. This is a standalone pilot, but the stated intent is to fold it back
-- into WurxOS if it proves out, and policies are the expensive thing to port.
-- Keeping `is_boss(uid)` and a `can_view_*` helper with the same signatures
-- means the policies below move across almost verbatim.
--
-- Roles: boss / ol / ads_manager — the three that touch paid media in WurxOS.
-- ============================================================

-- ── Profiles ────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  display_name text not null default '',
  role         text not null default 'ads_manager'
                 check (role in ('boss', 'ol', 'ads_manager')),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ── Role helpers ────────────────────────────────────────────────────────────
-- SECURITY DEFINER because they read profiles from inside profiles' own
-- policies; without it every policy would recurse into RLS on the same table.
--
-- NOTE, learned the hard way in WurxOS (migs 351/352): never test
-- `pg_has_role(current_user, ...)` inside a SECURITY DEFINER function. Inside
-- one, current_user is the OWNER, not the caller, so such a test is true for
-- everybody and the guard silently does nothing. Test auth.uid() instead.
create or replace function public.is_boss(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
     where p.id = uid and p.role = 'boss' and p.is_active
  );
$$;

create or replace function public.can_manage_shops(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
     where p.id = uid and p.role in ('boss', 'ol') and p.is_active
  );
$$;

-- ── Shops (Reacher's, mapped to our own brand naming) ───────────────────────
create table if not exists public.shops (
  id               uuid primary key default gen_random_uuid(),
  reacher_shop_id  integer not null unique,   -- the x-shop-id header value
  shop_name        text not null,
  display_name     text,                      -- what WE call the brand, if different
  region           text,
  currency         text not null default 'USD',
  is_active        boolean not null default true,
  -- Reacher's own connection state, refreshed on each sync. Kept because a
  -- disconnected source is the leading explanation for a reconciliation gap,
  -- and the UI must be able to say so instead of showing a silent shortfall.
  affiliate_connected boolean,
  integrations        jsonb not null default '{}'::jsonb,
  last_synced_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

drop trigger if exists shops_touch on public.shops;
create trigger shops_touch before update on public.shops
  for each row execute function public.touch_updated_at();

-- ── Per-user shop access (mirrors WurxOS ads_manager_brands) ────────────────
create table if not exists public.shop_access (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  shop_id     uuid not null references public.shops(id) on delete cascade,
  granted_by  uuid references public.profiles(id) on delete set null,
  granted_at  timestamptz not null default now(),
  primary key (user_id, shop_id)
);

create or replace function public.can_view_shop(p_shop_id uuid, uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.can_manage_shops(uid)
      or exists (
        select 1 from public.shop_access a
         where a.shop_id = p_shop_id and a.user_id = uid
      );
$$;

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.profiles    enable row level security;
alter table public.shops       enable row level security;
alter table public.shop_access enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or public.can_manage_shops(auth.uid()));

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

-- Role changes are deliberately NOT possible from the client: there is no
-- policy that lets anyone write another profile's row, and the self-update
-- policy is column-blind, so a user could otherwise promote themselves. The
-- guard below closes that.
create or replace function public.profiles_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;         -- service role / migrations
  if not public.is_boss(auth.uid()) then
    if new.role is distinct from old.role then
      raise exception 'only the Boss can change a role';
    end if;
    if new.is_active is distinct from old.is_active then
      raise exception 'only the Boss can activate or deactivate a user';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_trg on public.profiles;
create trigger profiles_guard_trg before update on public.profiles
  for each row execute function public.profiles_guard();

drop policy if exists shops_select on public.shops;
create policy shops_select on public.shops for select
  using (public.can_view_shop(id, auth.uid()));

drop policy if exists shop_access_select on public.shop_access;
create policy shop_access_select on public.shop_access for select
  using (user_id = auth.uid() or public.can_manage_shops(auth.uid()));

-- Writes to shops / shop_access are service-role or Boss-only and go through
-- the sync job and an admin screen, so no client-facing insert/update policies
-- exist here on purpose.

-- ── New signups get a profile ───────────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Verification ────────────────────────────────────────────────────────────
do $verify$
declare v int;
begin
  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename in ('profiles','shops','shop_access');
  if v = 0 then raise exception '001: no policies were created'; end if;

  -- Every table that will hold client revenue must have RLS on, without
  -- exception. A table with RLS off is readable by any authenticated user.
  select count(*) into v from pg_tables t
    join pg_class c on c.relname = t.tablename
   where t.schemaname = 'public'
     and t.tablename in ('profiles','shops','shop_access')
     and not c.relrowsecurity;
  if v <> 0 then raise exception '001: % table(s) have RLS disabled', v; end if;

  raise notice '001: foundation ready — roles boss/ol/ads_manager, RLS on';
end;
$verify$;
