// One canonical answer to "is this campaign running?".
//
// ── THE BUG THIS EXISTS TO KILL ────────────────────────────────────────────
// Reacher returns campaign status in TWO different vocabularies depending on
// which endpoint you ask:
//
//   GET /gmv-max/campaigns            ->  "ENABLE"  / "DISABLE"
//   the per-campaign settings call    ->  "enabled" / "disabled"
//
// normalizeCampaign prefers the settings value when it has one, so the manual
// sync stored lowercase while the scheduled sync stored uppercase, and the
// snapshot writer stored uppercase because it read the list object directly.
// Three writers, two vocabularies, one column.
//
// Everything downstream compared against the literal 'ENABLE'. So every REAL
// campaign was classified inactive, and the only row that ever matched was the
// SIMULATED one. That is what produced both of the review's observations at
// once: "all four campaign records appeared inactive", and "budget utilisation
// said no budget on file despite configured budgets on inactive campaigns".
// The budgets were on file and one campaign was running the whole time.
//
// It also had a second edge: migration 028 opens a new snapshot row whenever
// the state differs from the last one. Feeding it 'ENABLE' one day and
// 'enabled' the next would have recorded a campaign change that never happened.
//
// ── THE RULE ───────────────────────────────────────────────────────────────
// Canonicalise at every boundary, and never compare a raw provider string.
// Unrecognised values are preserved verbatim and treated as NOT active, because
// guessing that an unknown status means "running" is how a paused campaign gets
// a budget recommendation.

export const CAMPAIGN_STATUS = {
  ENABLE: 'ENABLE',
  DISABLE: 'DISABLE',
  DELETE: 'DELETE',
};

const ACTIVE = new Set(['enable', 'enabled', 'active', 'delivery_ok', 'status_delivery_ok']);
const PAUSED = new Set(['disable', 'disabled', 'paused', 'inactive', 'status_disable']);
const GONE = new Set(['delete', 'deleted', 'removed', 'status_delete']);

/**
 * Map any provider spelling to the canonical vocabulary.
 * Returns the input unchanged when it is not recognised — an unknown status is
 * a fact worth surfacing, not something to coerce into a guess.
 */
export function canonicalStatus(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  // Whitespace-only is absence, not an unrecognised status. The SQL twin
  // (canonical_campaign_status) does this with nullif(trim(...), ''); the two
  // must agree, or a row canonicalised in the database and the same value
  // canonicalised in the browser would disagree about whether a status exists.
  if (trimmed === '') return null;
  const k = trimmed.toLowerCase();
  if (ACTIVE.has(k)) return CAMPAIGN_STATUS.ENABLE;
  if (PAUSED.has(k)) return CAMPAIGN_STATUS.DISABLE;
  if (GONE.has(k)) return CAMPAIGN_STATUS.DELETE;
  return trimmed;
}

/** The only supported way to ask whether a campaign can deliver. */
export function isActiveStatus(raw) {
  return canonicalStatus(raw) === CAMPAIGN_STATUS.ENABLE;
}

/** Words for a reader. An unrecognised status is shown as itself, not hidden. */
export function statusLabel(raw) {
  const c = canonicalStatus(raw);
  if (c === CAMPAIGN_STATUS.ENABLE) return 'Active';
  if (c === CAMPAIGN_STATUS.DISABLE) return 'Inactive';
  if (c === CAMPAIGN_STATUS.DELETE) return 'Deleted';
  return c ?? 'Unknown';
}
