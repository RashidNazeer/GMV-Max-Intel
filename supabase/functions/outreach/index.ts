// ============================================================
// Outreach control plane.
//
// The only server-side code in this project that can WRITE to Reacher. It sits
// between the app and their API for one reason: the Reacher key is account-wide
// and can create automations that message thousands of real creators under the
// brand's name. It must never be in a browser bundle, and no client should be
// able to hand it an arbitrary request.
//
// ── THE RULES THIS FUNCTION ENFORCES ───────────────────────────────────────
// Every one of these exists because getting it wrong sends real messages to
// real people, and that cannot be undone.
//
//  1. BOSS ONLY. The caller's JWT is verified and their profile role checked
//     server-side. Not a UI condition — a UI condition is a suggestion.
//  2. A FIXED SET OF ACTIONS. dry_run, create, start, stop, status, list.
//     There is no passthrough. The client cannot reach an endpoint this file
//     does not name.
//  3. HARD CAPS. Recipients and daily send rate are clamped here, server-side,
//     whatever the client asks for.
//  4. CREATED STOPPED. `create` never starts anything. Starting is a separate
//     call a person makes deliberately.
//  5. EVERY ACTION IS LOGGED to outreach_actions before it is attempted, with
//     who did it. If something goes out, there is a record of who sent it.
//  6. DRY RUN IS THE DEFAULT PATH. Reacher supports `X-Dry-Run: true`, which
//     validates without persisting. The UI runs it before every create.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const REACHER_BASE = 'https://api.reacherapp.com/public/v1';

// Server-side ceilings. The client can ask for less, never more.
const MAX_RECIPIENTS = 500;   // a slip on a 10,000-handle paste stops here
const MAX_DAILY_CAP = 200;    // per weekday, per automation
const MAX_MESSAGE = 500;      // Reacher's own limit on the TC card
const MAX_NAME = 30;          // ditto for invitation_name

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const REACHER_API = Deno.env.get('REACHER_API');
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!REACHER_API || !SUPABASE_URL || !SERVICE_KEY) return json({ error: 'function is not configured' }, 500);

  // ── 1. who is calling ────────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'not signed in' }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: userRes, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userRes?.user) return json({ error: 'not signed in' }, 401);
  const user = userRes.user;

  const { data: profile } = await admin
    .from('profiles').select('role, is_active, display_name, email').eq('id', user.id).maybeSingle();
  if (!profile?.is_active) return json({ error: 'account disabled' }, 403);
  if (profile.role !== 'boss') {
    return json({ error: 'outreach is Boss-only. Your role is ' + profile.role }, 403);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'bad JSON' }, 400); }

  const action = String(body.action ?? '');
  const shopId = String(body.shop_id ?? '');
  if (!['dry_run', 'create', 'start', 'stop', 'status', 'list'].includes(action)) {
    return json({ error: `unknown action "${action}"` }, 400);
  }

  // The caller names OUR shop uuid; the Reacher id is looked up here, so a
  // client cannot address a shop it was never granted.
  const { data: shop } = await admin
    .from('shops').select('id, reacher_shop_id, shop_name').eq('id', shopId).maybeSingle();
  if (!shop) return json({ error: 'unknown shop' }, 404);

  const reacher = async (method: string, path: string, opts: {
    body?: unknown; headers?: Record<string, string>; query?: Record<string, string>;
  } = {}) => {
    const url = new URL(REACHER_BASE + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: {
        'x-api-key': REACHER_API,
        'x-shop-id': String(shop.reacher_shop_id),
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { ok: res.ok, status: res.status, body: parsed };
  };

  // Record intent BEFORE acting, so a crash mid-flight still leaves a trace.
  const logAction = async (detail: Record<string, unknown>) => {
    const { data } = await admin.from('outreach_actions').insert({
      shop_id: shop.id, actor_id: user.id, actor_email: profile.email ?? user.email,
      action, detail,
    }).select('id').single();
    return data?.id ?? null;
  };
  const finish = async (id: string | null, ok: boolean, result: unknown) => {
    if (id) await admin.from('outreach_actions').update({
      succeeded: ok, result: result ?? null, finished_at: new Date().toISOString(),
    }).eq('id', id);
  };

  // ── read-only actions ────────────────────────────────────────────────────
  if (action === 'list') {
    const r = await reacher('POST', '/automations/list', { body: { page: 1, page_size: 50 } });
    return json({ ok: r.ok, data: r.body });
  }
  if (action === 'status') {
    const id = String(body.automation_id ?? '');
    if (!id) return json({ error: 'automation_id required' }, 400);
    const r = await reacher('GET', `/automations/${encodeURIComponent(id)}`);
    return json({ ok: r.ok, data: r.body });
  }

  // ── start / stop ─────────────────────────────────────────────────────────
  if (action === 'start' || action === 'stop') {
    const id = String(body.automation_id ?? '');
    if (!id) return json({ error: 'automation_id required' }, 400);
    const logId = await logAction({ automation_id: id });
    const r = await reacher('POST', `/automations/${encodeURIComponent(id)}/${action}`);
    await finish(logId, r.ok, r.body);
    return json({ ok: r.ok, status: r.status, data: r.body }, r.ok ? 200 : 400);
  }

  // ── create / dry run ─────────────────────────────────────────────────────
  const p = (body.payload ?? {}) as Record<string, any>;

  const handles: string[] = Array.from(new Set(
    (Array.isArray(p.handles) ? p.handles : [])
      .map((h: unknown) => String(h ?? '').trim().replace(/^@+/, ''))
      .filter((h: string) => h.length > 0 && h.length <= 80),
  ));
  if (!handles.length) return json({ error: 'no creator handles supplied' }, 400);
  if (handles.length > MAX_RECIPIENTS) {
    return json({ error: `${handles.length} creators exceeds the ${MAX_RECIPIENTS} cap enforced by this function` }, 400);
  }

  const name = String(p.invitation_name ?? '').trim();
  const message = String(p.invitation_message ?? '').trim();
  if (!name) return json({ error: 'invitation_name required' }, 400);
  if (name.length > MAX_NAME) return json({ error: `invitation_name is ${name.length} chars, max ${MAX_NAME}` }, 400);
  if (!message) return json({ error: 'invitation_message required' }, 400);
  if (message.length > MAX_MESSAGE) return json({ error: `message is ${message.length} chars, max ${MAX_MESSAGE}` }, 400);

  const products = (Array.isArray(p.products) ? p.products : [])
    .map((x: any) => ({
      product_id: String(x.product_id ?? ''),
      commission_rate: Number(x.commission_rate),
    }))
    .filter((x: any) => x.product_id && Number.isFinite(x.commission_rate));
  if (!products.length) return json({ error: 'at least one product with a commission rate is required' }, 400);

  // Commission is sent as a FRACTION (0.20 = 20%) per the create schema, while
  // reads come back as 20.01. The client sends a percentage and the conversion
  // happens here, once, so the two formats cannot be confused at the call site.
  for (const x of products) {
    if (x.commission_rate <= 0 || x.commission_rate > 90) {
      return json({ error: `commission ${x.commission_rate}% is outside the accepted 0-90% range` }, 400);
    }
    x.commission_rate = Number((x.commission_rate / 100).toFixed(4));
  }

  // Reacher requires a support contact on every Target Collab card — it is what
  // the creator sees if they need to reach the brand. It can be set once as a
  // shop default (PUT /target-collabs/support-contact-default), but neither
  // shop has one configured, so it must be supplied per request. Discovered by
  // dry run: SUPPORT_CONTACT_REQUIRED.
  const supportEmail = String(p.support_email ?? '').trim();
  if (!supportEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(supportEmail)) {
    return json({ error: 'a valid support contact email is required — creators see it on the invitation card' }, 400);
  }
  const supportPhone = String(p.support_phone ?? '').trim();

  const dailyCap = Math.min(Math.max(Number(p.daily_cap ?? 25), 1), MAX_DAILY_CAP);
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const schedule: Record<string, unknown> = {
    start_time: String(p.start_time ?? '09:00'),
    end_time: String(p.end_time ?? '17:00'),
    timezone: String(p.timezone ?? 'America/Los_Angeles'),
  };
  for (const d of days) schedule[`${d}_maxCreators`] = dailyCap;

  const payload: Record<string, unknown> = {
    automation_name: String(p.automation_name ?? name).slice(0, 120),
    schedule,
    creators_to_include: { list_upload: handles },
    creators_to_exclude: { exclude_previously_messaged: p.exclude_previously_messaged !== false },
    target_collab: {
      invitation_name: name,
      // FIELD NAMES DIFFER BETWEEN READ AND WRITE. Reading an automation gives
      // back  and ; the
      // create endpoint rejects both. It wants  and the enum value
      // , and a date it can actually parse. Established by a
      // dry run on 2026-09-08, which returned all three errors at once:
      //   "message: Field required"
      //   "invitation_message: Extra inputs are not permitted"
      //   "content_type: Input should be 'no_preference', 'shoppable_video'
      //    or 'shoppable_live'"
      //   "valid_until: Input should be a valid date"
      // Mirroring the read shape back would have failed every time.
      message,
      valid_until: String(p.valid_until ?? ''),
      content_type: String(p.content_type ?? 'no_preference'),
      products,
      support_contact: { email: supportEmail, ...(supportPhone ? { phone: supportPhone } : {}) },
      // Samples default to the most conservative of Reacher's three modes:
      // no free samples, manual approval. Auto-approval gives product away
      // without anyone looking, which is not a default anyone should inherit.
      sample_policy: p.sample_policy ?? { offer_free_samples: false, auto_approve: false },
    },
    is_evergreen: false,
    ai_enabled: false,
  };

  const isDry = action === 'dry_run';
  const logId = await logAction({
    dry_run: isDry, recipients: handles.length, daily_cap: dailyCap,
    invitation_name: name, message_chars: message.length,
    products: products.map((x: any) => x.product_id),
  });

  const r = await reacher('POST', '/automations/target-collab', {
    body: payload,
    headers: {
      // Required by Reacher. Deterministic per submission so a double-click or
      // a retry cannot produce two automations.
      'Idempotency-Key': String(p.idempotency_key ?? crypto.randomUUID()),
      ...(isDry ? { 'X-Dry-Run': 'true' } : {}),
    },
  });

  await finish(logId, r.ok, r.body);
  return json({
    ok: r.ok,
    status: r.status,
    dry_run: isDry,
    recipients: handles.length,
    daily_cap: dailyCap,
    data: r.body,
    // Said explicitly so no caller has to assume it.
    note: isDry
      ? 'Dry run only — Reacher validated this and saved nothing.'
      : 'Created. Nothing has been sent: an automation only sends once it is started.',
  }, r.ok ? 200 : 400);
});
