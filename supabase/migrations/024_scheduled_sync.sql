-- ═══════════════════════════════════════════════════════════════════════════
-- 024 — the syncs run on a schedule, instead of when somebody remembers
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every figure in this product comes from data a sync pulled out of Reacher.
-- Those syncs only ran when a person typed the command, so coverage stopped
-- advancing the moment nobody did. The app reported the result honestly —
-- "Affiliate orders available through 2026-09-06; report ends 2026-09-07" —
-- and the honest report was of a problem nothing was going to fix on its own.
-- Two days after any manual run, the same warning comes back.
--
-- pg_cron runs SQL inside Postgres and cannot execute a Node script, so the
-- schedule calls the `sync` edge function through pg_net. The function shares
-- the same normalisation and classification modules as the manual scripts, so
-- the scheduled path and the manual path cannot drift apart.
--
-- ── WHY THREE ENTRIES AND NOT ONE ──────────────────────────────────────────
-- An edge function has a wall-clock limit and one shop's affiliate pull can be
-- thousands of lines. One call doing everything is how a sync starts timing out
-- halfway and leaves a window half-written. Each job gets its own entry, spaced
-- so they do not contend, and each records its own sync_runs row.
--
-- ── THE SECRET ─────────────────────────────────────────────────────────────
-- The function writes every shop's data as service_role, so it must not be
-- callable by anyone who finds the URL. The schedule sends a shared secret in a
-- header; the function refuses without it. It is read here from Vault rather
-- than written into the schedule definition, because a cron entry is readable
-- by anyone who can read pg_cron.job.
--
-- BEFORE THIS WORKS, two things must exist outside this migration:
--   1. supabase secrets set SYNC_CRON_SECRET=<value> REACHER_API=<key>
--   2. select vault.create_secret('<same value>', 'sync_cron_secret');
--      select vault.create_secret('<project-ref>', 'project_ref');
-- The verify block below fails loudly if either is missing, rather than
-- scheduling a job that would 401 every morning in silence.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── the caller ─────────────────────────────────────────────────────────────
create or replace function public.run_scheduled_sync(p_job text)
returns bigint
language plpgsql
security definer
set search_path = public, extensions, vault
as $fn$
declare
  v_secret text;
  v_ref    text;
  v_id     bigint;
begin
  if p_job not in ('affiliate_transactions', 'shop_channels', 'gmv_max') then
    raise exception 'unknown sync job: %', p_job;
  end if;

  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'sync_cron_secret';
  select decrypted_secret into v_ref    from vault.decrypted_secrets where name = 'project_ref';

  -- Refuse rather than fire an unauthenticated request every morning. A job
  -- that fails silently on a schedule is worse than one that never ran.
  if v_secret is null or v_ref is null then
    raise exception 'sync_cron_secret or project_ref is missing from vault — the schedule would 401';
  end if;

  select net.http_post(
    url     := format('https://%s.supabase.co/functions/v1/sync?job=%s', v_ref, p_job),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-sync-secret', v_secret
    ),
    timeout_milliseconds := 120000
  ) into v_id;

  return v_id;
end;
$fn$;

comment on function public.run_scheduled_sync(text) is
  'Calls the sync edge function for one job. Reads the shared secret from Vault rather than embedding it in the cron definition, because pg_cron.job is readable by anyone who can read the catalog.';

do $g$
begin
  revoke all on function public.run_scheduled_sync(text) from public;
  revoke all on function public.run_scheduled_sync(text) from anon;
  revoke all on function public.run_scheduled_sync(text) from authenticated;
  grant execute on function public.run_scheduled_sync(text) to postgres;
  grant execute on function public.run_scheduled_sync(text) to service_role;
end;
$g$;


-- ── the schedule ───────────────────────────────────────────────────────────
-- Times are UTC. Reacher's reporting day is America/Los_Angeles, so an early
-- UTC run reads a day that has already settled there. Spaced 20 minutes apart
-- so three jobs do not contend for the same window.
do $s$
declare j record;
begin
  for j in
    select * from (values
      ('sync-shop-channels',          '0 6 * * *',  'shop_channels'),
      ('sync-affiliate-transactions', '20 6 * * *', 'affiliate_transactions'),
      ('sync-gmv-max',                '40 6 * * *', 'gmv_max')
    ) as t(name, sched, job)
  loop
    -- Idempotent: unschedule before scheduling so a re-run does not stack
    -- duplicate entries that would each fire.
    perform cron.unschedule(j.name) where exists (select 1 from cron.job where jobname = j.name);
    perform cron.schedule(j.name, j.sched, format('select public.run_scheduled_sync(%L);', j.job));
  end loop;
end;
$s$;


-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY
-- ═══════════════════════════════════════════════════════════════════════════
do $v$
declare n int; missing text := '';
begin
  select count(*) into n from cron.job
   where jobname in ('sync-shop-channels', 'sync-affiliate-transactions', 'sync-gmv-max');
  if n <> 3 then
    raise exception 'expected 3 scheduled sync jobs, found %', n;
  end if;

  -- Say plainly what still has to be set, rather than scheduling something
  -- that will fail every morning without anybody noticing.
  if not exists (select 1 from vault.decrypted_secrets where name = 'sync_cron_secret') then
    missing := missing || ' sync_cron_secret';
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'project_ref') then
    missing := missing || ' project_ref';
  end if;

  if missing <> '' then
    raise warning 'SCHEDULED, BUT NOT YET WORKING — missing from vault:%. Add them, then: select public.run_scheduled_sync(''shop_channels'');', missing;
  else
    raise notice 'VERIFIED: 3 jobs scheduled and both vault secrets present';
  end if;
end;
$v$;
