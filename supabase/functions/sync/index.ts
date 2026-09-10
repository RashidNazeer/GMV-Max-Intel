// ============================================================
// Scheduled sync — the reason the app's data stops being true.
//
// Every figure in this product comes from data pulled out of Reacher by a sync.
// Those syncs only ran when a person typed the command, so coverage stopped
// advancing the moment nobody did — and the app faithfully reported the
// resulting gap as a data problem ("Affiliate orders available through
// 2026-09-06; report ends 2026-09-07"). The gap was real. The cause was that
// nothing was scheduled.
//
// pg_cron runs SQL inside Postgres and cannot execute a Node script, so the
// schedule reaches this function through pg_net. See migration 024.
//
// ── IT SHARES THE SYNC LOGIC, IT DOES NOT REIMPLEMENT IT ───────────────────
// The classification and normalisation live in src/lib/reacher/. They are plain
// ES modules using only fetch, so Deno imports them unchanged. That matters
// more than convenience: a second copy of "is this order ad-driven" is the one
// thing this product cannot afford, because the scheduled path and the manual
// path would drift and neither would be obviously wrong.
//
// ── WHAT THIS IS ALLOWED TO DO ─────────────────────────────────────────────
//   * READ from Reacher. Nothing here writes to Reacher or TikTok — the only
//     function permitted to write is `outreach`, and it is Boss-gated.
//   * WRITE to our own tables, as service_role.
// The Reacher key is a Supabase function secret and is never in a bundle.
//
// ── ONE JOB PER INVOCATION ─────────────────────────────────────────────────
// An edge function has a wall-clock limit and one shop's affiliate pull can be
// thousands of lines. Running everything in one call is how a sync starts
// timing out halfway and leaves a half-written window. Each cron entry asks for
// ONE job; each shop gets its own sync_runs row, so a partial failure is
// visible per shop rather than as one opaque failure.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import {
  normalizeAffiliateTransaction,
  normalizeDailyChannels,
  normalizeCampaign,
  normalizeCampaignDay,
} from '../../../src/lib/reacher/normalize.js';
// THE CLIENT ITSELF, not a reimplementation of its requests. The first attempt
// hand-rolled the calls here and Reacher answered "Missing x-shop-id header" —
// the shop id goes in a HEADER, transactions page by limit/offset rather than
// page/page_size, and video listing caps page_size at 100. Every one of those
// is already encoded in the client, and writing them out a second time is how
// the scheduled path and the manual path drift until neither is obviously wrong.
import { createReacherClient } from '../../../src/lib/reacher/client.js';

const JOBS = ['affiliate_transactions', 'shop_channels', 'gmv_max'] as const;
type Job = typeof JOBS[number];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(Date.parse(`${s}T00:00:00Z`) + n * 864e5));

// The same settling rule the app uses. Reacher's reporting day is
// America/Los_Angeles and the most recent day or two still move, so storing
// them would keep changing figures under reports already built on them.
const SETTLING_DAYS = 2;
const PAGE = 500;

Deno.serve(async (req) => {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const REACHER_API = Deno.env.get('REACHER_API');
  const CRON_SECRET = Deno.env.get('SYNC_CRON_SECRET');

  if (!SUPABASE_URL || !SERVICE_KEY || !REACHER_API) {
    return json({ error: 'function is not configured' }, 500);
  }
  // NOT PUBLIC. This writes every shop's data as service_role, so it must not
  // be callable by anyone who finds the URL. Without a secret configured it
  // refuses rather than defaulting to open.
  if (!CRON_SECRET) return json({ error: 'SYNC_CRON_SECRET is not set' }, 500);
  if (req.headers.get('x-sync-secret') !== CRON_SECRET) return json({ error: 'unauthorised' }, 401);

  const url = new URL(req.url);
  const job = (url.searchParams.get('job') || '') as Job;
  if (!JOBS.includes(job)) return json({ error: `job must be one of ${JOBS.join(', ')}` }, 400);

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const reacher = createReacherClient({ apiKey: REACHER_API });

  const end = addDays(iso(new Date()), -SETTLING_DAYS);
  const start = addDays(end, -34);

  const upsert = async (table: string, rows: unknown[], onConflict: string) => {
    if (!rows.length) return 0;
    for (let i = 0; i < rows.length; i += PAGE) {
      const { error } = await db.from(table).upsert(rows.slice(i, i + PAGE), { onConflict });
      if (error) throw new Error(`${table}: ${error.message}`);
    }
    return rows.length;
  };

  const { data: shops, error: shopErr } = await db
    .from('shops').select('id, shop_name, reacher_shop_id').eq('is_active', true);
  if (shopErr) return json({ error: shopErr.message }, 500);

  const results: Array<Record<string, unknown>> = [];

  for (const shop of shops || []) {
    // A shop with no Reacher id cannot have data. That is a setup fact, not a
    // failure to retry every morning — recorded once, then skipped.
    if (!shop.reacher_shop_id) {
      results.push({ shop: shop.shop_name, job, status: 'skipped', reason: 'no Reacher shop id on file' });
      continue;
    }

    const { data: run } = await db.from('sync_runs').insert({
      shop_id: shop.id, job, status: 'running',
      window_start: start, window_end: end, started_at: new Date().toISOString(),
    }).select('id').single();

    try {
      let rows = 0;

      if (job === 'shop_channels') {
        const res = await reacher.shopGmvTimeseries(shop.reacher_shop_id, start, end);
        rows = await upsert(
          'shop_daily_channels',
          (res.series || []).map((d: unknown) => normalizeDailyChannels(d, shop.id, res.currency_code)),
          'shop_id,day',
        );
      }

      if (job === 'affiliate_transactions') {
        // The client walks limit/offset itself and reports whether the provider
        // truncated. Same classifier as the manual sync decides paid vs organic.
        const res = await reacher.fetchAffiliateTransactions({
          shopId: shop.reacher_shop_id, startDate: start, endDate: end,
        });
        rows = await upsert(
          'affiliate_order_lines',
          (res.transactions || []).map((t: unknown) => normalizeAffiliateTransaction(t, shop.id)),
          'shop_id,order_id,sku_id',
        );
      }

      if (job === 'gmv_max') {
        const list = await reacher.listGmvMaxCampaigns(shop.reacher_shop_id);
        const campaigns = list.data || list.campaigns || [];
        rows = await upsert(
          'gmv_max_campaigns',
          campaigns.map((c: unknown) => normalizeCampaign(c, shop.id, null, 'reacher')),
          'shop_id,campaign_id',
        );
        for (const c of campaigns) {
          const id = (c as Record<string, unknown>).campaign_id;
          if (!id) continue;
          const m = await reacher.campaignMetrics(shop.reacher_shop_id, String(id), start, end);
          rows += await upsert(
            'gmv_max_daily_metrics',
            (m.data || m.metrics || []).map((d: unknown) =>
              normalizeCampaignDay(d, shop.id, String(id), 'reacher')),
            'shop_id,campaign_id,day',
          );
        }
      }

      if (run?.id) {
        await db.from('sync_runs').update({
          status: 'ok', finished_at: new Date().toISOString(), rows_written: rows,
        }).eq('id', run.id);
      }
      results.push({ shop: shop.shop_name, job, status: 'ok', rows });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (run?.id) {
        await db.from('sync_runs').update({
          status: 'error', finished_at: new Date().toISOString(), rows_written: 0, error: message,
        }).eq('id', run.id);
      }
      // One shop failing must not stop the others.
      results.push({ shop: shop.shop_name, job, status: 'error', error: message });
    }
  }

  const failed = results.filter((r) => r.status === 'error').length;
  return json({ job, window: { start, end }, failed, results }, failed ? 207 : 200);
});
