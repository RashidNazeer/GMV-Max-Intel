// ============================================================
// The copy registry.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
// Two reasons, and the second one is the important one.
//
// 1. The attribution explanation used to appear twice on the Overview and again
//    on other tabs, drifting slightly each time it was edited. One definition
//    means one wording.
//
// 2. THE OWNER EXCEPTION. A review argued that this product's attribution
//    language claims more certainty than the evidence supports, and proposed
//    replacing "Proven return" and the floor/ceiling framing with
//    "partial commission-attributed ROAS" and similar hedges. The owner
//    considered that specific critique and REJECTED it, while accepting the
//    rest of the review.
//
//    So the substantive meaning and certainty of these strings are a recorded
//    decision, not an accident of drafting. They may be MOVED between screens,
//    put behind a tooltip, or collapsed into an expander. Their claim strength
//    must not change.
//
//    scripts/copy-guard.mjs checks the load-bearing phrases below still exist,
//    and `npm test` runs it. If you are here because that check failed, the
//    question to answer is not "how do I make the test pass" — it is "did the
//    owner change their mind", and if they did, update PROTECTED in the guard
//    in the same commit so the record moves with the decision.
// ============================================================

export const COPY = {
  // The claim about revenue that does not depend on ads. PROTECTED.
  organicClaim: 'would have happened without your ads.',

  // The decomposition explainer. PROTECTED.
  decompositionExplainer:
    'The first two segments are the only revenue with hard evidence of what caused it: TikTok pays each '
    + 'affiliate order either a Shop Ads commission or a standard one, and which programme paid says what '
    + 'drove the sale. The grey segments have no such signal, so they are left unsplit — applying the '
    + 'affiliate rate to them would be a guess dressed as a measurement.',

  // The floor-to-ceiling framing. PROTECTED.
  bandExplainer:
    'GMV Max buys delivery across affiliate video, product card and brand. Only the affiliate surface '
    + 'leaves commission evidence, so only its revenue can be positively verified — that is the floor, and '
    + 'every dollar in it is certainly ad-driven. The gap above it is either revenue the ads really drove '
    + 'on the other surfaces or organic sales being counted toward the campaign, and nothing available '
    + 'today separates the two. Reacher exposes spend by surface but not revenue by surface; that one '
    + 'addition would close the band.',

  seg: {
    paid: 'Shop Ads commission — TikTok billed the sale to paid delivery',
    organic: 'Standard commission — the creator posted for their own rate',
    gap: 'Seller Center reports this affiliate revenue but no order lines reached us',
    overflow: 'Our order lines hold this revenue but Seller Center’s affiliate figure does not — the two sources are measuring on different bases',
    seller: 'The shop’s own videos — no commission programme, so nothing says what drove them',
    live: 'Livestream sales — measured 0% ad-driven wherever we do have evidence',
    card: 'Shop tab, search and product-page sales — no attribution signal available yet',
  },

  // Neutral names for everything that is NOT protected. Renaming these was part
  // of the accepted review: a feature name should be a short noun, and an
  // interpretation does not belong in a title.
  names: {
    declining: 'Declining GMV',
    fatigue: 'Fatigue risk',
    marginal: 'Estimated marginal ROAS',
    marginalChange: 'Marginal ROAS',
    changeHistory: 'Change history',
    spendScenario: 'Spend scenario',
    ctr: 'CTR',
    conversion: 'Median conversion rate',
    dataStatus: 'Data status',
    targetRoi: 'Target ROI',
    dailyBudget: 'Daily budget',
    active: 'Active',
    inactive: 'Inactive',
    productGmvMax: 'Product GMV Max',
  },
};

export default COPY;
