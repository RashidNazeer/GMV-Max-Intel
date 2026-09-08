// ============================================================
// Organic momentum — is demand that does not depend on spend growing?
//
// This is the number a media buyer needs before reading any ROAS. A campaign
// can look like it is working while the organic base underneath it carries the
// result, and it can look like it is failing while organic collapses around it.
//
// ── THE RULES THAT MATTER ──────────────────────────────────────────────────
//   * COMPONENTS, not a single blended number. Each one is stored with its own
//     value so the score can be argued with rather than believed.
//   * A MISSING component is not a zero. Scoring an unavailable signal as 0
//     would report "weakening" for a shop whose data simply is not there. The
//     weights of whatever IS available are renormalised, and the coverage is
//     returned so the screen can say how much of the score is real.
//   * Views are LIFETIME in Reacher's feed, so a views trend cannot be computed
//     from them. That component is therefore permanently unavailable and is
//     declared so rather than quietly dropped.
//   * The comparison window is adjacent, equal-length and non-overlapping —
//     window.js guarantees that, and this module never computes dates.
//
// Weights are the original V1 defaults. They are versioned, because a score
// whose weights change silently is not comparable to itself from last month.
// ============================================================

export const MOMENTUM_VERSION = '2026-09-08.1';

export const WEIGHTS = {
  organic_gmv:   0.30,
  affiliate_gmv: 0.20,
  orders:        0.15,
  creators:      0.10,
  new_videos:    0.10,
  new_winners:   0.10,
  views:         0.05,   // permanently unavailable — see below
};

export const LABEL = {
  STRONG: 'Strong',
  GROWING: 'Growing',
  STABLE: 'Stable',
  WEAKENING: 'Weakening',
  DECLINING: 'Declining',
};

const n = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Relative change, guarded.
 *
 * A prior of zero has no percentage change — "up from nothing" is infinite, and
 * rendering that as a huge positive would let one first sale read as explosive
 * growth. Returns null, which the caller treats as unavailable rather than flat.
 */
export function change(current, prior) {
  const c = n(current); const p = n(prior);
  if (c == null || p == null) return null;
  if (p === 0) return null;
  return (c - p) / p;
}

/**
 * One viral day can carry a whole window. Squashing the change through tanh
 * keeps a genuine doubling meaningful while stopping a 12x day from pinning the
 * score at the ceiling and hiding everything else.
 */
const squash = (x) => Math.tanh(x * 1.6);

/**
 * @param {object} now   attribution + creative for the reporting window
 * @param {object} prior the same, for the adjacent previous window
 */
export function momentum(now = {}, prior = {}) {
  const a = now.attribution; const pa = prior.attribution;
  const c = now.creative; const pc = prior.creative;

  const parts = [];

  const push = (key, label, current, previous, detail) => {
    const delta = change(current, previous);
    parts.push({
      key,
      label,
      weight: WEIGHTS[key],
      current: n(current),
      prior: n(previous),
      change: delta,
      available: delta != null,
      score: delta == null ? null : squash(delta),
      detail: detail || null,
    });
  };

  push('organic_gmv', 'Organic revenue', a?.measured_organic_gmv, pa?.measured_organic_gmv,
    'Standard-commission revenue — creators posting because the product sells.');
  push('affiliate_gmv', 'Affiliate revenue', a?.affiliate_video_sc_gmv, pa?.affiliate_video_sc_gmv,
    "Seller Center's own affiliate video figure, both periods.");
  push('orders', 'Orders', a?.orders, pa?.orders,
    'Whole-shop order count. Volume, independent of basket size.');
  push('creators', 'Creators earning', c?.creators, pc?.creators,
    'Distinct creators producing revenue. Breadth, not depth.');
  push('new_videos', 'New videos selling', c?.new_videos, pc?.new_videos,
    'Videos that made their first sale inside the window.');
  push('new_winners', 'New winners', c?.winners, pc?.winners,
    'Videos clearing the winner threshold.');

  // Declared, never scored. Reacher's feed returns LIFETIME views, so the same
  // video reports the same number in both windows and a "trend" computed from
  // it would be an artefact of the data, not a fact about the shop.
  parts.push({
    key: 'views',
    label: 'Views trend',
    weight: WEIGHTS.views,
    current: null, prior: null, change: null,
    available: false,
    score: null,
    detail: 'Unavailable: the video feed reports lifetime views, so it cannot express a change over a window.',
  });

  const usable = parts.filter((p) => p.available);
  const availableWeight = usable.reduce((s, p) => s + p.weight, 0);
  const totalWeight = Object.values(WEIGHTS).reduce((s, w) => s + w, 0);
  const coverage = availableWeight / totalWeight;

  if (!usable.length || availableWeight === 0) {
    return {
      version: MOMENTUM_VERSION,
      score: null,
      label: null,
      coverage: 0,
      parts,
      reason: 'No component could be measured against the previous period, so there is no momentum to report. This is missing data, not flat performance.',
    };
  }

  // Renormalised across what is actually available. Scoring the missing ones as
  // zero would drag every score toward "stable" and call it a measurement.
  const score = usable.reduce((s, p) => s + p.score * p.weight, 0) / availableWeight;

  const label = score >= 0.35 ? LABEL.STRONG
    : score >= 0.12 ? LABEL.GROWING
    : score > -0.12 ? LABEL.STABLE
    : score > -0.35 ? LABEL.WEAKENING
    : LABEL.DECLINING;

  // Below half coverage the label is not worth putting a name to.
  const trustworthy = coverage >= 0.5;

  return {
    version: MOMENTUM_VERSION,
    score,
    label: trustworthy ? label : null,
    coverage,
    parts,
    // Biggest movers first — what is actually driving the number.
    drivers: [...usable]
      .sort((x, y) => Math.abs(y.score * y.weight) - Math.abs(x.score * x.weight))
      .slice(0, 3),
    reason: trustworthy
      ? null
      : `Only ${Math.round(coverage * 100)}% of the score's components could be measured, which is too little to put a label on. The components that are available are listed below.`,
  };
}
