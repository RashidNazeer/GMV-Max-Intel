-- ═══════════════════════════════════════════════════════════════════════════
-- 025 — the scheduled call needs a gateway JWT as well as the shared secret
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Migration 024 scheduled the syncs and the first live firing returned:
--
--     HTTP 401  {"code":"UNAUTHORIZED_NO_AUTH_HEADER",
--                "message":"Missing authorization header"}
--
-- That is Supabase's gateway, not the function's own check — an edge function
-- requires a valid JWT in `Authorization` before the body runs at all. So the
-- 401 was arriving before a single line of the sync executed, and the shared
-- secret never got a chance to be read.
--
-- TWO GATES, DELIBERATELY. The anon key gets past the gateway; the shared
-- secret is what actually authorises the call. Using anon rather than the
-- service key means that even if the URL and the anon key were both known —
-- the anon key is public by design — the function still refuses without the
-- secret. A service-role JWT here would make the gateway the only real gate
-- and put a far more dangerous credential in a scheduled job's headers.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.run_scheduled_sync(p_job text)
returns bigint
language plpgsql
security definer
set search_path = public, extensions, vault
as $fn$
declare
  v_secret text;
  v_ref    text;
  v_anon   text;
  v_id     bigint;
begin
  if p_job not in ('affiliate_transactions', 'shop_channels', 'gmv_max') then
    raise exception 'unknown sync job: %', p_job;
  end if;

  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'sync_cron_secret';
  select decrypted_secret into v_ref    from vault.decrypted_secrets where name = 'project_ref';
  select decrypted_secret into v_anon   from vault.decrypted_secrets where name = 'anon_key';

  -- Refuse rather than fire a request that cannot succeed. A job that 401s
  -- every morning in silence is worse than one that never ran.
  if v_secret is null or v_ref is null or v_anon is null then
    raise exception 'missing from vault: %',
      concat_ws(', ',
        case when v_secret is null then 'sync_cron_secret' end,
        case when v_ref    is null then 'project_ref' end,
        case when v_anon   is null then 'anon_key' end);
  end if;

  select net.http_post(
    url     := format('https://%s.supabase.co/functions/v1/sync?job=%s', v_ref, p_job),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      -- Gets past the gateway. Public by design; not the authorisation.
      'Authorization', 'Bearer ' || v_anon,
      -- The actual authorisation. The function refuses without it.
      'x-sync-secret', v_secret
    ),
    timeout_milliseconds := 120000
  ) into v_id;

  return v_id;
end;
$fn$;

do $g$
begin
  revoke all on function public.run_scheduled_sync(text) from public;
  revoke all on function public.run_scheduled_sync(text) from anon;
  revoke all on function public.run_scheduled_sync(text) from authenticated;
  grant execute on function public.run_scheduled_sync(text) to postgres;
  grant execute on function public.run_scheduled_sync(text) to service_role;
end;
$g$;

do $v$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'anon_key') then
    raise warning 'anon_key is not in vault yet — the schedule will still 401 until it is added';
  else
    raise notice 'VERIFIED: all three vault secrets present';
  end if;
end;
$v$;
