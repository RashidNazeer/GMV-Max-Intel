// Ingest real GMV Max campaigns, daily metrics and settings history.
//
//   node scripts/sync-gmvmax.mjs [startDate] [endDate] [--replace-simulated]
//
// ── WHAT THE FIRST LIVE RUN TAUGHT US (Biostime, 2026-09-07) ───────────────
// Every one of these endpoints had only ever returned empty before the ad
// account was connected, so the shapes below are from the first real payloads,
// not from the spec:
//
//   /campaigns              WORKS. Carries budget and roas_bid directly.
//   /campaigns/{id}/settings  returns ALL NULLS even for an active campaign.
//                           Target ROI and daily budget must come from the
//                           campaign list instead — the normalizer already
//                           falls back that way.
//   /campaigns/{id}/metrics WORKS: date, spend, gross_revenue, roas, ad_roi.
//                           BUT impressions, clicks, orders, cpc, cpm and ctr
//                           are all null. Stored as null, never as 0 — "TikTok
//                           did not report this" is not "there were no clicks".
//   /campaigns/{id}/changes empty (nothing recorded yet — history starts now).
//   /spend-by-surface       empty, so no per-surface split is available and the
//                           like-for-like ROAS stays null by design.
//
// Disabled campaigns are synced too: they hold historical spend, and excluding
// them would understate what was actually spent in the window.
import { isActiveStatus } from '../src/lib/campaignStatus.js';
import { createClient } from '@supabase/supabase-js';
import { need } from './_env.mjs';
import { createReacherClient } from '../src/lib/reacher/client.js';
import {
  normalizeCampaign, normalizeCampaignDay, normalizeSettingsChange,
} from '../src/lib/reacher/normalize.js';

const [SUPABASE_URL, SERVICE_KEY, REACHER_API] =
  need('VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'REACHER_API');

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const reacher = createReacherClient({ apiKey: REACHER_API });

const REPLACE = process.argv.includes('--replace-simulated');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const iso = (d) => d.toISOString().slice(0, 10);
const END = args[1] || iso(new Date(Date.now() - 2 * 864e5));
const START = args[0] || iso(new Date(Date.now() - 32 * 864e5));

console.log(`GMV Max sync ${START} → ${END}\n`);

const { data: shops, error } = await db
  .from('shops').select('id, reacher_shop_id, shop_name, currency').order('shop_name');
if (error) { console.error(error.message); process.exit(1); }

let failures = 0;

for (const shop of shops) {
  const { data: run } = await db.from('sync_runs').insert({
    shop_id: shop.id, job: 'gmv_max', window_start: START, window_end: END, status: 'running',
  }).select('id').single();

  try {
    const list = await reacher.listGmvMaxCampaigns(shop.reacher_shop_id);
    const campaigns = list.data || [];

    if (!campaigns.length) {
      await db.from('sync_runs').update({
        status: 'ok', finished_at: new Date().toISOString(), rows_received: 0, rows_written: 0,
        detail: { note: 'no campaigns — ad account not connected in Reacher' },
      }).eq('id', run.id);
      console.log(`${shop.shop_name.padEnd(18)} no campaigns (ad account not connected)`);
      continue;
    }

    // The database refuses to hold simulated and measured rows for one shop,
    // because a half-real ROAS is the one failure that produces a confident
    // wrong number. Real data supersedes the demo, but only when asked.
    const { data: src } = await db.rpc('shop_data_sources', { p_shop_id: shop.id });
    if (src?.[0]?.has_simulated) {
      if (!REPLACE) {
        console.log(`${shop.shop_name.padEnd(18)} HAS SIMULATED DATA — ${campaigns.length} real campaigns waiting.`);
        console.log(`${''.padEnd(18)} Re-run with --replace-simulated to delete the demo rows and ingest the real ones.`);
        await db.from('sync_runs').update({
          status: 'partial', finished_at: new Date().toISOString(),
          error: 'simulated rows present; re-run with --replace-simulated',
        }).eq('id', run.id);
        continue;
      }
      let removed = 0;
      for (const t of ['gmv_max_settings_changes', 'gmv_max_daily_metrics', 'gmv_max_campaigns']) {
        const { count } = await db.from(t).delete({ count: 'exact' })
          .eq('shop_id', shop.id).eq('data_source', 'simulated');
        removed += count ?? 0;
      }
      console.log(`${shop.shop_name.padEnd(18)} replaced ${removed} simulated rows with real data`);
    }

    let days = 0, changes = 0;
    for (const c of campaigns) {
      // settings returns all nulls even on an active campaign; passing it in is
      // harmless because the normalizer falls back to the campaign list fields.
      const settings = await reacher.campaignSettings(shop.reacher_shop_id, c.campaign_id)
        .then((r) => r.data).catch(() => null);

      const { error: cErr } = await db.from('gmv_max_campaigns')
        .upsert(normalizeCampaign(c, shop.id, settings, 'reacher'), { onConflict: 'shop_id,campaign_id' });
      if (cErr) throw new Error(`campaign ${c.campaign_id}: ${cErr.message}`);

      // ── SETTINGS SNAPSHOT: ONE ROW PER STATE, NOT PER RUN ────────────────
      // Reacher's /changes feed is empty and /settings returns nulls, so no
      // settings history exists and none can be reconstructed for the past.
      // Every day without an observation is a day of evidence permanently lost,
      // which is why this records on every run rather than waiting for a
      // feature to need it.
      //
      // It used to INSERT unconditionally, which recorded our polling schedule
      // instead of the campaign's history: two runs on 9 September left eight
      // rows for four campaigns, every one asserting the same settings. Since
      // campaign_setting_changes() detects a change by diffing consecutive
      // rows, duplicates guaranteed it would find nothing, forever.
      //
      // record_campaign_snapshot (migration 028) extends the existing row when
      // nothing has changed and opens a new one when something has, under a row
      // lock so overlapping runs cannot both claim to be first. A DETECTED
      // change stays distinct from a buyer REPORTING one.
      const { error: sErr } = await db.rpc('record_campaign_snapshot', {
        p_shop_id: shop.id,
        p_campaign_id: String(c.campaign_id),
        p_campaign_name: c.campaign_name ?? null,
        p_status: c.status ?? null,
        p_target_roas: c.roas_bid ?? null,
        p_daily_budget: c.budget ?? null,
        p_campaign_type: c.shopping_ads_type ?? null,
        p_currency: c.currency ?? null,
        p_data_source: 'reacher',
        p_raw: c,
      });
      // A snapshot is evidence, not a gate: failing to record one must not
      // abort a sync that is otherwise collecting real spend.
      if (sErr) console.log(`  snapshot ${c.campaign_id}: ${sErr.message.slice(0, 80)}`);

      const met = await reacher.campaignMetrics(shop.reacher_shop_id, c.campaign_id, START, END)
        .catch(() => ({ data: [] }));
      const rows = (met.data || []).map((m) => normalizeCampaignDay(m, shop.id, String(c.campaign_id), 'reacher'));
      if (rows.length) {
        const { error: mErr } = await db.from('gmv_max_daily_metrics')
          .upsert(rows, { onConflict: 'shop_id,campaign_id,day' });
        if (mErr) throw new Error(`metrics ${c.campaign_id}: ${mErr.message}`);
        days += rows.length;
      }

      const chg = await reacher.campaignChanges(shop.reacher_shop_id, c.campaign_id)
        .catch(() => ({ data: [] }));
      const cRows = (chg.data || [])
        .map((x) => normalizeSettingsChange(x, shop.id, String(c.campaign_id), 'reacher'))
        .filter((x) => x.changed_at && x.field);
      if (cRows.length) {
        await db.from('gmv_max_settings_changes')
          .upsert(cRows, { onConflict: 'shop_id,campaign_id,changed_at,field' });
        changes += cRows.length;
      }
    }

    await db.from('sync_runs').update({
      status: 'ok', finished_at: new Date().toISOString(),
      rows_received: campaigns.length, rows_written: days,
    }).eq('id', run.id);

    const active = campaigns.filter((c) => isActiveStatus(c.status)).length;
    console.log(`${shop.shop_name.padEnd(18)} ${campaigns.length} campaigns (${active} active) · ${days} campaign-days · ${changes} setting changes`);
  } catch (e) {
    failures++;
    await db.from('sync_runs').update({
      status: 'error', finished_at: new Date().toISOString(),
      error: e.message, detail: { requestId: e.requestId ?? null, status: e.status ?? null },
    }).eq('id', run.id);
    console.log(`${shop.shop_name.padEnd(18)} FAILED — ${e.message.slice(0, 90)}`);
  }
}

// ── what it means, from SQL ─────────────────────────────────────────────────
console.log('\nreturn on spend:');
for (const shop of shops) {
  const { data } = await db.rpc('shop_paid_roas', { p_shop_id: shop.id, p_start: START, p_end: END });
  const r = data?.[0];
  if (!r) { console.log(`  ${shop.shop_name.padEnd(18)} no spend in this window`); continue; }
  const m = (v) => '$' + Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const f = (v) => (v == null ? '—' : Number(v).toFixed(2));
  console.log(
    `  ${shop.shop_name.padEnd(18)} [${r.data_source}] spend ${m(r.spend)} · ` +
    `claims ${m(r.reported_revenue)} (${f(r.reported_roi)}) · ` +
    `verified ${m(r.verified_paid_gmv)} (${f(r.verified_roas)}) · ` +
    `${((Number(r.unverified_share) || 0) * 100).toFixed(0)}% unevidenced`,
  );
}

process.exit(failures ? 1 : 0);
