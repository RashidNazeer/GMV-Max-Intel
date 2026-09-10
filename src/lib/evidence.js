// The shared evidence contract.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// Every engine here already carries most of what a reader needs to interpret
// its output — the window, the currency, the rule version, whether a number was
// measured or modelled. It carries them in a slightly different shape each
// time, so a page consuming two engines has to know two vocabularies, and a
// number that travels between them loses whichever fields the destination did
// not think to keep.
//
// One envelope, one set of names. Anything that produces a figure a human will
// act on stamps it with this.
//
// ── ABSENCE HAS SIX DIFFERENT MEANINGS ─────────────────────────────────────
// The most common way this product could lie is by rendering all of them as a
// dash, or worse, as zero. They are not the same and they do not lead to the
// same action:
//
//   UNKNOWN         we did not establish it. Go and look.
//   UNAVAILABLE     the source cannot provide it. Looking will not help.
//   OBSERVED_ZERO   we measured, and it was zero. A real, actionable value.
//   NOT_APPLICABLE  the question does not apply here.
//   INCOMPLETE      partially collected. The figure understates by an unknown
//                   amount, so it is not comparable with a complete one.
//   STALE           collected, but before the window it is being shown against.
//
// `Missing data is not zero` is the single rule these encode.

export const STATE = {
  OK: 'ok',
  UNKNOWN: 'unknown',
  UNAVAILABLE: 'unavailable',
  OBSERVED_ZERO: 'observed_zero',
  NOT_APPLICABLE: 'not_applicable',
  INCOMPLETE: 'incomplete',
  STALE: 'stale',
};

export const STATE_LABEL = {
  ok: null,                       // a real value renders as itself
  unknown: 'not established',
  unavailable: 'not available from this source',
  observed_zero: 'zero',
  not_applicable: 'not applicable',
  incomplete: 'partly collected',
  stale: 'from before this window',
};

/**
 * How a figure was produced. NOT how much to trust it, and NOT whether it is
 * causal — those are separate axes and collapsing them is how a well-fitted
 * model comes to look like a measurement.
 */
export const BASIS = {
  MEASURED: 'measured',        // read directly from a source
  MODELLED: 'modelled',        // a versioned statistical result
  ESTIMATED: 'estimated',      // a documented heuristic or allocation
  UNCLASSIFIED: 'unclassified', // no classification available
  SIMULATED: 'simulated',      // demonstration data, not this shop's
};

export const BASIS_NOTE = {
  measured: 'Read directly from the source.',
  modelled: 'Produced by a versioned model. Carries that model’s assumptions.',
  estimated: 'A documented heuristic or allocation, not an observation.',
  unclassified: 'No classification could be established for this amount.',
  simulated: 'Demonstration data. Not this shop’s figures.',
};

/**
 * The envelope every engine output carries.
 *
 * Nothing here is optional in principle — a field that cannot be filled is
 * passed as null so its ABSENCE is visible, rather than omitted so a consumer
 * silently reads `undefined` as "fine".
 */
export function stamp({
  shopId = null,
  shopName = null,
  entityType = null,
  entityId = null,
  timezone = null,
  currency = null,
  unit = null,
  windowStart = null,
  windowEnd = null,
  priorStart = null,
  priorEnd = null,
  availableThrough = null,
  sourceCoverage = null,
  sourceRuns = null,
  asOf = null,
  ruleVersion = null,
  modelVersion = null,
  basis = null,
} = {}) {
  return {
    scope: {
      shop_id: shopId,
      shop_name: shopName,
      // A CAMPAIGN SETTING AND A SHOP OUTCOME ARE DIFFERENT THINGS.
      // Recording which one an output is about is what stops shop-level revenue
      // being read as a campaign's earnings — the single most tempting
      // misattribution in this product.
      entity_type: entityType,
      entity_id: entityId,
    },
    units: { timezone, currency, unit },
    window: { start: windowStart, end: windowEnd },
    // Named `comparison` rather than `prior` because "prior" gets read as
    // "before", and this is specifically the period being compared against.
    comparison: (priorStart || priorEnd) ? { start: priorStart, end: priorEnd } : null,
    coverage: {
      available_through: availableThrough,
      sources: sourceCoverage,
      runs: sourceRuns,
    },
    as_of: asOf,
    versions: { rule: ruleVersion, model: modelVersion },
    basis,
  };
}

/**
 * A dimension of evidence, recorded as a result rather than a boolean.
 *
 * A plain true/false cannot express "we did not check", and a check nobody ran
 * rendering identically to one that passed is how a clean bill of health gets
 * shown beside contradicting diagnostics. Four outcomes, and the value and
 * threshold that produced them.
 */
export const RESULT = {
  PASS: 'pass',
  FAIL: 'fail',
  UNKNOWN: 'unknown',
  NOT_APPLICABLE: 'not_applicable',
};

export function dimension({
  name,
  result = RESULT.UNKNOWN,
  value = null,
  unit = null,
  threshold = null,
  policyVersion = null,
  reason = null,
} = {}) {
  return { name, result, value, unit, threshold, policy_version: policyVersion, reason };
}

/**
 * Turn a legacy boolean-style check into a dimension.
 *
 * The existing guardrails are `{ passed, name, detail }`. Rather than rewrite
 * every one at once — which would be a large change with no behavioural gain —
 * this maps them into the contract at the boundary. A guardrail that was never
 * evaluated arrives as `undefined` and becomes UNKNOWN rather than FAIL, which
 * is the distinction the old shape could not make.
 */
export function fromCheck(check) {
  if (!check) return dimension({ name: 'unknown check', result: RESULT.UNKNOWN });
  if (check.passed === undefined) {
    return dimension({ name: check.name, result: RESULT.UNKNOWN, reason: check.detail || null });
  }
  return dimension({
    name: check.name,
    result: check.passed ? RESULT.PASS : RESULT.FAIL,
    reason: check.detail || null,
  });
}

/**
 * Which of the six absence states a value is in.
 *
 * `zeroIsReal` decides between OBSERVED_ZERO and UNKNOWN for a zero, and the
 * caller must say — a zero from a counted set is a fact, while a zero produced
 * by summing nothing is the absence of one.
 */
export function stateOf(value, { zeroIsReal = false, coverage = null, staleAfter = null, asOf = null } = {}) {
  if (value === null || value === undefined) return STATE.UNKNOWN;
  if (Number.isNaN(Number(value))) return STATE.UNKNOWN;
  if (Number(value) === 0) return zeroIsReal ? STATE.OBSERVED_ZERO : STATE.UNKNOWN;
  if (coverage != null && coverage < 1) return STATE.INCOMPLETE;
  if (staleAfter && asOf && new Date(asOf) < new Date(staleAfter)) return STATE.STALE;
  return STATE.OK;
}

/** Words for a state, for a screen. Never an empty string — an empty cell is
 *  indistinguishable from a value that has not loaded. */
export function stateLabel(state) {
  return STATE_LABEL[state] ?? String(state);
}
