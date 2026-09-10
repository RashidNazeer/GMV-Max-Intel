// The operating loop: interventions, context events and outcome reviews.
//
// Kept out of api.js because api.js is the READING layer for analysis, and
// these are the WRITING layer for what a human did. Mixing them is how a
// reporting call and a record of a real action end up looking interchangeable.
//
// Every write here goes through a SECURITY DEFINER function rather than a table
// insert. The functions hold the rules — provenance, valid transitions, the
// amendment freeze — and a direct table write would route around all of them.
// There is no UPDATE or DELETE policy on any of these tables, so this is not
// merely the preferred path; it is the only one.
import { supabase } from './supabase.js';

async function rpc(fn, args) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

/* ── the log ──────────────────────────────────────────────────────────────── */

/**
 * The whole loop in one filterable list.
 *
 * Filtering happens in SQL. PostgREST truncates a select at 1000 rows, so a
 * client-side filter would search whatever subset happened to arrive and report
 * a confident count of it.
 */
export const decisionLog = (shopId, opts = {}) =>
  rpc('decision_log', {
    p_shop_id: shopId,
    p_search: opts.search || null,
    p_action: opts.action || null,
    p_lifecycle: opts.lifecycle || null,
    p_lane: opts.lane || null,
    p_kind: opts.kind || null,
    p_limit: opts.limit ?? 50,
    p_offset: opts.offset ?? 0,
  });

/** What is waiting on the operator, split by WHY it is waiting. */
export const operatorQueue = (shopId) =>
  rpc('operator_queue', { p_shop_id: shopId }).then((r) => (Array.isArray(r) ? r[0] : r) || null);

export const interventionHistory = (shopId, entityType = null, entityId = null, limit = 100) =>
  rpc('intervention_history', {
    p_shop_id: shopId, p_entity_type: entityType, p_entity_id: entityId, p_limit: limit,
  });

/* ── recording what actually happened ─────────────────────────────────────── */

export const CONFIRMATION = {
  MANUAL: 'manual_report',
  DETECTED: 'snapshot_detected',
  API: 'api_executed',
};

/**
 * Record a change that actually happened.
 *
 * `recommendationId` is optional on purpose. A budget changed for reasons that
 * never passed through this tool is exactly the evidence a response model
 * needs, and refusing to record it would leave the history describing only the
 * subset we happened to suggest.
 *
 * `occurredFrom` / `occurredTo` are an interval. Pass the same value twice for
 * a known moment; pass two for "somewhere between these observations". Nothing
 * here invents a timestamp.
 */
export const recordIntervention = (shopId, {
  entityType, entityId, entityLabel, field,
  newValue = null, oldValue = null, valueUnit = null,
  occurredFrom = null, occurredTo = null,
  confirmation = CONFIRMATION.MANUAL,
  reason = null, recommendationId = null, reversesId = null,
  policyException = false, policyNote = null, externalRef = null,
  evidence = {},
} = {}) => rpc('record_intervention', {
  p_shop_id: shopId,
  p_entity_type: entityType,
  p_entity_id: String(entityId),
  p_field: field,
  p_new_value: newValue,
  p_old_value: oldValue,
  p_occurred_from: occurredFrom,
  p_occurred_to: occurredTo,
  p_confirmation: confirmation,
  p_reason: reason,
  p_recommendation_id: recommendationId,
  p_entity_label: entityLabel ?? null,
  p_value_unit: valueUnit,
  p_reverses_id: reversesId,
  p_policy_exception: !!policyException,
  p_policy_note: policyNote,
  p_external_ref: externalRef,
  p_evidence: evidence || {},
});

export const CONTEXT_KINDS = [
  ['promotion', 'Promotion'],
  ['stockout', 'Stockout'],
  ['replenishment', 'Restocked'],
  ['price_change', 'Price change'],
  ['commission_change', 'Commission change'],
  ['creative_added', 'Creative added'],
  ['creative_authorised', 'Creative authorised'],
  ['campaign_pause', 'Campaign paused'],
  ['other_media', 'Other media activity'],
  ['platform_event', 'Platform event'],
  ['ingestion_issue', 'Data ingestion issue'],
  ['other', 'Something else'],
];

export const recordContextEvent = (shopId, {
  kind, startsAt, endsAt = null, entityType = null, entityId = null,
  label = null, source = 'operator_reported', note = null,
} = {}) => rpc('record_context_event', {
  p_shop_id: shopId,
  p_kind: kind,
  p_starts_at: startsAt,
  p_ends_at: endsAt,
  p_entity_type: entityType,
  p_entity_id: entityId,
  p_label: label,
  p_source: source,
  p_note: note,
});

/* ── outcome reviews ──────────────────────────────────────────────────────── */

export const LIFECYCLE = {
  PLANNED: 'planned',
  APPLIED: 'applied',
  AWAITING: 'awaiting_data',
  DUE: 'review_due',
  REVIEWED: 'reviewed',
  CANCELLED: 'cancelled',
};

export const LIFECYCLE_LABEL = {
  planned: 'Planned',
  applied: 'Applied',
  awaiting_data: 'Waiting for data',
  review_due: 'Review due',
  reviewed: 'Reviewed',
  cancelled: 'Cancelled',
  recorded: 'Recorded',
  proposed: 'Proposed',
};

/** How a result was established. NOT a synonym for whether it was good. */
export const CAUSAL_BASIS = [
  ['observed', 'Observed before and after',
    'The number before and the number after, and nothing more. It does not separate the change from anything else happening at the same time.'],
  ['adjusted', 'Adjusted comparison',
    'A before-and-after comparison with a stated adjustment — a control period, a seasonal correction. Defensible, still not causal proof.'],
  ['modelled', 'Modelled expectation',
    'Compared against what a model expected. Carries the model’s assumptions with it.'],
  ['experimental', 'Experimental estimate',
    'A valid experimental design with recorded metadata. Requires that design to exist on the plan; it is refused otherwise.'],
];

export const METRIC_OUTCOME = [
  ['favourable', 'Favourable'],
  ['unfavourable', 'Unfavourable'],
  ['mixed', 'Mixed'],
  // Not a failure. An intervention that was never carried out, or whose
  // campaign sat inactive, has no result to score.
  ['unmeasurable', 'Not measurable'],
];

export const REVIEW_DECISION = [
  ['continue', 'Keep the change'],
  ['revert', 'Revert it'],
  ['extend', 'Run it longer'],
  ['stop', 'Stop here'],
  ['inconclusive', 'Inconclusive'],
];

/**
 * Plan a review BEFORE the change is made.
 *
 * Everything here is frozen at planning time. Changing it later is an
 * amendment with a reason, and once the review is recorded it cannot be changed
 * at all — moving the goalposts after seeing the result is the easiest way to
 * build a tool that always says it was right.
 */
export async function planOutcomeReview(shopId, {
  interventionId = null, recommendationId = null,
  hypothesis, targetMetric, baselineValue = null, baselineBasis = null,
  observationDays = 7, settlingDays = 2, minCoverage = 1,
  successThreshold = null, failureThreshold = null, thresholdUnit = null,
  guardrails = [], reviewOwner = null, plannedReviewAt = null,
} = {}) {
  const { data, error } = await supabase.from('outcome_reviews').insert({
    shop_id: shopId,
    intervention_id: interventionId,
    recommendation_id: recommendationId,
    hypothesis,
    target_metric: targetMetric,
    baseline_value: baselineValue,
    baseline_basis: baselineBasis,
    observation_days: observationDays,
    settling_days: settlingDays,
    min_coverage: minCoverage,
    success_threshold: successThreshold,
    failure_threshold: failureThreshold,
    threshold_unit: thresholdUnit,
    guardrails,
    review_owner: reviewOwner,
    planned_review_at: plannedReviewAt,
  }).select('id').single();
  if (error) throw new Error(error.message);
  return data.id;
}

export const advanceReview = (reviewId, to, reason = null, detail = {}) =>
  rpc('advance_outcome_review', {
    p_review_id: reviewId, p_to: to, p_reason: reason, p_detail: detail || {},
  });

export const recordReview = (reviewId, {
  metricOutcome, causalBasis, reviewDecision,
  resultValue = null, resultCoverage = null, causalNote = null, reviewNote = null,
} = {}) => rpc('record_outcome_review', {
  p_review_id: reviewId,
  p_metric_outcome: metricOutcome,
  p_causal_basis: causalBasis,
  p_review_decision: reviewDecision,
  p_result_value: resultValue,
  p_result_coverage: resultCoverage,
  p_causal_note: causalNote,
  p_review_note: reviewNote,
});

export const amendReviewCriteria = (reviewId, changes, reason) =>
  rpc('amend_outcome_criteria', { p_review_id: reviewId, p_changes: changes, p_reason: reason });

export async function reviewById(reviewId) {
  const { data, error } = await supabase
    .from('outcome_reviews').select('*').eq('id', reviewId).single();
  if (error) throw new Error(error.message);
  return data;
}

export async function reviewEvents(reviewId) {
  const { data, error } = await supabase
    .from('outcome_review_events').select('*').eq('review_id', reviewId).order('at');
  if (error) throw new Error(error.message);
  return data || [];
}

/* ── Target ROI headroom ──────────────────────────────────────────────────── */

export const ROI_STATUS_LABEL = {
  insufficient_history: 'No history to reason from',
  confounded_evidence: 'Evidence is confounded',
  single_episode: 'One case only',
  eligible_for_review: 'Eligible for review',
};

/**
 * Headroom per campaign, in BOTH directions.
 *
 * Returns a STATUS first and a number only when episodes support one. The
 * shape is deliberately awkward to misuse: there is no field that means
 * "suggested change" unless the evidence for it exists.
 */
export async function roiHeadroom(shopId) {
  const rows = await rpc('roi_headroom', { p_shop_id: shopId });
  // Keyed by campaign then direction, because every consumer wants one
  // campaign at a time and re-grouping a flat list at each call site is how
  // two screens end up disagreeing about which direction they are showing.
  const by = {};
  for (const r of rows || []) {
    by[r.campaign_id] = by[r.campaign_id] || { campaign_id: r.campaign_id, campaign_name: r.campaign_name };
    by[r.campaign_id][r.direction] = r;
  }
  return by;
}

export const roiEpisodes = (shopId) => rpc('roi_episodes', { p_shop_id: shopId });

/* ── organic baselines ────────────────────────────────────────────────────── */

export const BASELINE_METHODS = [
  ['rolling', 'Rolling median',
    'The median of several recent comparable windows. Robust to one strange period, slower to notice a real turn.'],
  ['adjacent', 'Previous period',
    'The window immediately before this one. Closest in time, and the most exposed to a single odd week.'],
  ['seasonal', 'Same period last year',
    'Controls for calendar effects, and needs a year of history to exist.'],
];

export const BASELINE_STATUS_LABEL = {
  ok: 'Comparable',
  no_history: 'No comparable period',
  zero_baseline: 'Baseline was zero',
  insufficient_coverage: 'Not enough days collected',
};

/**
 * A DESCRIPTIVE organic baseline that names its own method.
 *
 * It says what organic revenue did in comparable past periods. It does not say
 * what organic revenue would have been without the advertising — that is
 * organicCounterfactual, and it answers honestly.
 */
export const organicBaseline = (shopId, start, end, method = 'rolling', lookback = 4) =>
  rpc('organic_baseline', {
    p_shop_id: shopId, p_start: start, p_end: end, p_method: method, p_lookback: lookback,
  }).then((r) => (Array.isArray(r) ? r[0] : r) || null);

export const organicCounterfactual = (shopId, start, end) =>
  rpc('organic_counterfactual', { p_shop_id: shopId, p_start: start, p_end: end })
    .then((r) => (Array.isArray(r) ? r[0] : r) || null);
