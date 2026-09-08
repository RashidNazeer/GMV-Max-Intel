-- ============================================================
-- GMV Max Intelligence — 013: an audit trail for outreach.
--
-- This is the first thing in the project that can reach OUT of it — creating an
-- automation that messages real creators under the brand's name. Everything
-- else here reads. That asymmetry deserves a record.
--
-- Rows are written by the `outreach` edge function BEFORE it calls Reacher, and
-- updated with the outcome afterwards. Written first on purpose: if the
-- function dies mid-call, the intent survives. A log that only records
-- successes cannot answer the question you actually ask after an incident,
-- which is "what was attempted".
--
-- Insert and update are service-role only, like every other fact table. The
-- Boss can READ the log but cannot edit it — an audit trail its subject can
-- rewrite is decoration.
-- ============================================================

create table if not exists public.outreach_actions (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops(id) on delete cascade,

  actor_id     uuid,           -- deliberately not FK'd: the record must outlive the account
  actor_email  text,

  action       text not null check (action in ('dry_run','create','start','stop')),
  detail       jsonb not null default '{}'::jsonb,   -- recipients, caps, message length, products

  succeeded    boolean,
  result       jsonb,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);

create index if not exists outreach_actions_shop_idx on public.outreach_actions (shop_id, started_at desc);

alter table public.outreach_actions enable row level security;

drop policy if exists outreach_actions_select on public.outreach_actions;
create policy outreach_actions_select on public.outreach_actions for select
  using (public.is_boss(auth.uid()));
-- No insert/update/delete policies. The edge function writes with the service
-- role; nobody can alter the history from a browser.

do $verify$
declare v int;
begin
  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'outreach_actions' and cmd <> 'SELECT';
  if v <> 0 then
    raise exception '013: outreach_actions has % write policies — the audit trail must be append-only from the server', v;
  end if;

  select count(*) into v from pg_tables
   where schemaname = 'public' and tablename = 'outreach_actions' and rowsecurity;
  if v <> 1 then raise exception '013: RLS is not enabled on outreach_actions'; end if;

  raise notice '013: outreach audit trail ready — intent logged before the call, Boss-readable, server-written';
end;
$verify$;
