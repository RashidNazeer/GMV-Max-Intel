// The decision loop, exercised as the REAL app role, end to end.
//
// This exists because the feature was dead in production for a week and every
// existing check passed anyway: the browser gate looked for "Mark planned" on a
// page where that button never renders and printed "skipped", and the client
// swallowed the RLS refusal. A test that cannot fail is not a test.
//
// Runs as `authenticated` via a real sign-in — NOT service_role, which bypasses
// RLS and would prove nothing about what the app can do. It writes to a
// throwaway fingerprint and leaves the row dismissed (recommendation_events is
// append-only by design and refuses deletion, which is correct).
//
// Nothing is written to TikTok or Reacher.
import { createClient } from '@supabase/supabase-js';
import { env, need } from './_env.mjs';

need('VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'BOSS_LOGIN_PASSWORD');

let pass = 0; let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (ok) pass++; else fail++;
};

const db = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { data: auth, error: authErr } = await db.auth.signInWithPassword({
  email: 'mrrashid3255@gmail.com', password: env.BOSS_LOGIN_PASSWORD,
});
if (authErr) { console.error('sign-in failed:', authErr.message); process.exit(1); }
console.log(`\n── as ${auth.user.email}, the role the app actually runs as ──\n`);

const { data: shops } = await db.from('shops').select('id, shop_name').order('shop_name');
const shop = shops?.find((s) => /biostime/i.test(s.shop_name)) || shops?.[0];
if (!shop) { console.error('no visible shop'); process.exit(1); }

const fp = `check:${crypto.randomUUID()}`;
const payload = {
  action_code: 'review_creative',
  title: 'check-decision-log', reason: 'automated check', action_text: 'none',
  window_start: '2026-09-01', window_end: '2026-09-07',
  rule_version: 'check', severity: 'info', lane: 'media',
  test_days: 7, drill_to: 'creatives', short_finding: 'check',
  affected_ids: ['v1', 'v2'], checks_ran: ['reconciled'], checks_not_run: ['cooldown'],
};

// ── 1. the write that was refused for a week ───────────────────────────────
const { data: made, error: mkErr } = await db.rpc('record_recommendation', {
  p_shop_id: shop.id, p_fingerprint: fp, p_payload: payload,
});
const rec = Array.isArray(made) ? made[0] : made;
check('a recommendation can be stored at all', !mkErr && !!rec?.id, mkErr?.message);
if (!rec?.id) { console.log('\ncannot continue without a stored row'); process.exit(1); }

check('it is born proposed', rec.status === 'proposed', `status=${rec.status}`);
check('its review date is derived from the test duration', !!rec.next_review_at, 'next_review_at is null');
check('the replay fields survive the persist boundary',
  rec.drill_to === 'creatives' && rec.short_finding === 'check',
  `drill_to=${rec.drill_to} short_finding=${rec.short_finding}`);
check('it records which checks did NOT run',
  Array.isArray(rec.checks_not_run) && rec.checks_not_run.includes('cooldown'),
  JSON.stringify(rec.checks_not_run));

// ── 2. a re-render must not make a second row ──────────────────────────────
const { data: again } = await db.rpc('record_recommendation', {
  p_shop_id: shop.id, p_fingerprint: fp, p_payload: payload,
});
check('re-rendering returns the same row, not a duplicate',
  (Array.isArray(again) ? again[0] : again)?.id === rec.id);

// ── 3. the payload cannot claim a decision ─────────────────────────────────
const fp2 = `check:${crypto.randomUUID()}`;
const { data: forged } = await db.rpc('record_recommendation', {
  p_shop_id: shop.id, p_fingerprint: fp2,
  p_payload: { ...payload, status: 'applied', decision: 'accept' },
});
const f = Array.isArray(forged) ? forged[0] : forged;
check('a client-supplied status of "applied" is overridden', f?.status === 'proposed', `status=${f?.status}`);
check('a client-supplied decision is overridden', f?.decision == null, `decision=${f?.decision}`);

// ── 4. reject and defer must carry a reason ────────────────────────────────
const { error: noReason } = await db.rpc('record_decision', {
  p_recommendation_id: rec.id, p_decision: 'reject', p_note: null,
});
check('a rejection with no reason is refused', /reason/i.test(noReason?.message || ''), noReason?.message);

const { error: noDate } = await db.rpc('record_decision', {
  p_recommendation_id: rec.id, p_decision: 'defer', p_note: 'next week', p_defer_until: null,
});
check('a deferral with no return date is refused', /comes back/i.test(noDate?.message || ''), noDate?.message);

// ── 5. a real decision, and it must survive a fresh read ───────────────────
const { data: planned, error: plErr } = await db.rpc('record_decision', {
  p_recommendation_id: rec.id, p_decision: 'accept', p_note: 'testing the loop', p_status: 'planned',
});
const p1 = Array.isArray(planned) ? planned[0] : planned;
check('a decision can be recorded', !plErr && p1?.decision === 'accept', plErr?.message);
check('and it moves the lifecycle separately', p1?.status === 'planned', `status=${p1?.status}`);

const { data: reread } = await db.from('recommendations')
  .select('decision, decision_note, status, decision_at').eq('id', rec.id).maybeSingle();
check('the decision survives a fresh read — the point of the whole feature',
  reread?.decision === 'accept' && reread?.status === 'planned' && !!reread?.decision_at,
  JSON.stringify(reread));
check('the reason is stored, not discarded', reread?.decision_note === 'testing the loop', reread?.decision_note);

// ── 6. duplicate submits collapse ──────────────────────────────────────────
const before = await db.from('recommendation_events').select('id', { count: 'exact', head: true })
  .eq('recommendation_id', rec.id);
await db.rpc('record_decision', {
  p_recommendation_id: rec.id, p_decision: 'accept', p_note: 'testing the loop', p_status: 'planned',
});
const after = await db.from('recommendation_events').select('id', { count: 'exact', head: true })
  .eq('recommendation_id', rec.id);
check('an identical repeat writes no second event',
  before.count === after.count, `${before.count} -> ${after.count}`);

// ── 7. the evidence is still not editable by the person acting on it ───────
const { error: tamper } = await db.from('recommendations')
  .update({ suggested_value: 999 }).eq('id', rec.id);
check('the evidence remains uneditable after a decision',
  /only the lifecycle fields/.test(tamper?.message || ''), tamper?.message || 'the update succeeded');

// ── 8. leave both rows dismissed so nothing renders in the UI ──────────────
for (const id of [rec.id, f?.id].filter(Boolean)) {
  await db.rpc('record_decision', {
    p_recommendation_id: id, p_decision: 'reject',
    p_note: 'automated check — not a real decision', p_status: 'dismissed',
  });
}
console.log('\n  (both rows left dismissed; the UI lists only proposed/planned/applied)');
console.log('  (not deleted: recommendation_events is append-only and refusing that is correct)');

await db.auth.signOut();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
