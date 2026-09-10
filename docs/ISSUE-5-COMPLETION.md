# Issue 5 — completion report

Written 10 September 2026. Every figure here was produced by running the
command named beside it, not by reading the code.

---

## 1. What this is, in one paragraph

The tool can now go all the way round the loop: it recommends, a human decides,
the change that actually happened is recorded, the outcome is reviewed against
criteria written down beforehand, and the next recommendation knows about it.
Most of the work was not adding capability. It was **removing claims the
evidence could not carry** — a creative diagnosis with no delivery data behind
it, a Target ROI step sized by a default band, an organic baseline that never
named its method, a capture percentage described as agreement.

---

## 2. Status by section

| § | Subject | Status |
|---|---|---|
| 3 | Baseline established | **Implemented and tested** |
| 4 | Shared evidence contract | **Implemented and tested** |
| 5 | Source ingestion and capability reporting | **Implemented and tested** |
| 6 | Raw retention, snapshots, revisions | **Implemented and tested** |
| 7 | Attribution metadata and reconciliation | **Implemented and tested** |
| 8 | Comparison windows and campaign state | **Implemented and tested** |
| 9 | Organic baselines | **Implemented and tested** |
| 10 | Creative intelligence | Partial — diagnosis grading done, under-delivered winner detection not |
| 11 | Marginal engine | **Audited and corrected** |
| 12 | Target ROI headroom, both directions | **Implemented; returns insufficient_history on live data** |
| 13 | Recommendation diagnosis and prioritisation | **Implemented and tested** |
| 14 | Persist recommendations and decisions | Carried from Issue 4, verified by `check:decisions` |
| 15 | Interventions and context events | **Implemented and tested** |
| 16 | Outcome evaluation and review | **Implemented and tested** |
| 17 | Reviewed history informing recommendations | **Implemented; returns no_reviewed_history on live data** |
| 18 | Interface around the loop | **Implemented and tested** |
| 19 | Dependency order | Followed |
| 20 | Run the tests | **Done — see section 4** |
| 21 | Completion evidence | This document |

### The distinction the requirement asks for

**Implemented and tested** — the sections marked above. Exercised by a named
command whose output is in section 4.

**Implemented but externally unverified** — Target ROI headroom (§12) and
reviewed history (§17). Both are complete and both correctly report that they
have nothing to reason from, because no Target ROI change has been observed and
no outcome review has been completed. Their behaviour WITH evidence is covered
by unit tests using fixtures; it has never run against real episodes because
none exist yet.

**Blocked by a named dependency** — under-delivered winner detection (§10)
needs per-video delivery evidence inside the reporting window. Reacher exposes
no per-video spend, and `video_performance.views` is a lifetime figure that does
not move with the report's date filter. Creative Boost capability likewise
cannot be confirmed `supported` from read-only access.

**Deliberately future scope** — human-approved external API execution,
unattended automation, halo/MMM modelling, LTV/CAC. None are started, per the
prompt.

---

## 3. Migration map

| Migration | What it does |
|---|---|
| `028_effective_state_snapshots` | One row per effective campaign state, not per fetch. Idempotent recording, bounded change intervals |
| `029_campaign_state_in_window` | What a campaign was doing DURING a report, as distinct from now. Returns `unknown` rather than extrapolating |
| `030_canonical_campaign_status` | One vocabulary for campaign status. Backfill plus a SQL twin of the client rule |
| `031_interventions_and_context` | What actually changed, and what else was going on |
| `032_outcome_reviews` | Frozen criteria, server-enforced lifecycle, append-only audit |
| `033_decision_log` | The whole loop in one filterable query |
| `034_roi_headroom` | Two-direction Target ROI headroom from observed episodes |
| `035_organic_baseline` | Three named baseline methods, plus a counterfactual that refuses |
| `036_reviewed_history` | Comparable reviewed cases, and the replay report |
| `037_raw_retention_and_revisions` | Raw payload archive and late-data restatement capture |
| `038_capability_registry` | What the integration can and cannot do, with evidence and dependency |
| `039_evidence_basis` | How each pound was established, as a partition that reconciles |
| `040_intervention_matching` | Linking a detected change to the report of it, without merging or double counting |

**Recovery.** Every migration is re-runnable and verifies itself in a `DO`
block that raises rather than warns. 028 and 030 alter existing data; both
collapse or canonicalise rather than delete, and 030 re-collapses any snapshot
pair that canonicalising made identical. No migration drops a column or a table.

---

## 4. Commands run, and their actual results

| Command | Result |
|---|---|
| `npm test` | **502 passed, 0 failed** |
| `node scripts/visual-qa.mjs` | **145 passed, 0 failed** |
| `npm run check:loop` (T31) | **26 passed, 0 failed** |
| `npm run check:decisions` | **16 passed, 0 failed** |
| `npm run check:retention` (T01/T03) | **17 passed, 0 failed** |
| `npm run check:tenancy` (T27) | **29 passed, 0 failed** |
| `npm run check:lifecycle` (T22/T24/T28) | **23 passed, 0 failed** |
| `npm run build` | clean |
| `node scripts/migrate.mjs` | 040 applied, all verifications passed |

The browser and loop suites run against a built bundle served by
`scripts/serve-dist.mjs`. That file exists because `vite preview` kept dying
part-way through a run, and a gate whose server disappears reports "0 failed"
for every check it never reached.

---

## 5. Acceptance cases with real coverage

| Case | Covered by |
|---|---|
| T01 source and ingestion integrity | `check:retention` — dedup on re-fetch, no double counting |
| T02 snapshot integrity | migration 028 verify + a real sync adding zero rows |
| T03 as-of reproducibility | `check:retention` — frozen evidence, restatements counted separately |
| T08 campaign status timing | `budget-tests`, `status-tests`, migration 029 |
| T11 creative diagnosis | `decide-tests` — paused / unverified / supported branches |
| T16 ROI history availability | migration 034 verify — insufficient_history, no candidate |
| T17 ROI tightening | `decide-tests` — no candidate without episodes |
| T20 review audit gate | `decide-tests` — investigation, not a constraint claim |
| T21 decisions | `check:decisions` — accept/modify/reject/defer, survives reload |
| T23 state transitions | migration 032 verify — invalid transitions refused |
| T25 outcome interpretation | migration 032 — outcome, basis and decision are separate columns |
| T26 learning influence | `decide-tests` — asymmetric rules, cannot clear a guardrail |
| T31 full persisted loop | `check:loop` — 26 checks through the real UI |
| T05 live audit regression | `decide-tests` — the reviewed numbers as a fixture |
| T07 incomplete periods | `decide-tests` — missing days named, never read as zero |
| T09 budget mechanism | `decide-tests` — 300 against a 550 cap does not become a budget rise |
| T15 economic objective | `decide-tests` — no threshold means no profit claim |
| T18 ROI relaxation | `decide-tests` — delivery gain and guardrail breach both represented |
| T19 confounded episode | `decide-tests` — context, never proof |
| T22 intervention truth | `check:lifecycle` — policy exception preserved, match linked not merged |
| T24 outcome timing | `check:lifecycle` — late data waits; unmeasurable is not a failure |
| T27 tenant and concurrency | `check:tenancy` — 12 readers and 2 writers refuse a stranger |
| T28 migration compatibility | `check:lifecycle` — legacy rows read, ledger intact |
| T32 external action boundary | `check:loop` — every non-GET request watched; zero external writes |
| T04 accounting oracle | migration 039 verify — the basis partition sums to components to the cent |
| T06 evidence basis | migration 039 + browser — lineage without doubling revenue |

**26 of 32.** What remains: T10 (organic baseline edge cases), T12 (creative
opportunity — BLOCKED on per-video delivery evidence), T13 (creative navigation
ids), T14 (remaining marginal shapes, partly covered by the section 11 audit),
T29 and T30 (browser and accessibility, substantially covered by the 145-check
gate without being labelled case by case).

---

## 6. The synthetic full cycle

`npm run check:loop` performs, through the actual interface:

1. Records a change made by hand against an isolated entity id (`E2E-<time>`)
2. Confirms it is attributed to a person, not to an API
3. Confirms an exact time was recorded because one was given
4. Confirms a review was planned **before any result existed**, at criteria
   version 1 with no outcome
5. Reloads the page and confirms the entry survives
6. Advances the lifecycle to `review_due` through the UI
7. Confirms every transition reached the audit trail
8. Confirms the review asks its three questions separately
9. Confirms **zero** non-GET requests left the app for any third party

It removes its own rows afterwards. The lifecycle can only be advanced as a
signed-in user: the service key has no `auth.uid()` and
`advance_outcome_review` refuses it.

---

## 7. Remaining external dependencies

| Needed for | Missing |
|---|---|
| Under-delivered winner detection, creative constraint claims | Per-video impressions or spend **inside the reporting window**. `views` is lifetime |
| Creative Boost as an actionable control | A read-only way to confirm support. The only definitive check is a create-shaped call, and this product does not write to TikTok |
| Campaign settings history before 2026-09-08 | A provider change feed. Reacher's is empty and `/settings` returns nulls |
| Per-product spend | Not exposed by the current integration |

Euka's API was surveyed and carries `/gmv-max/reports/item` (per-creative cost,
impressions, clicks) and `/gmv-max/reports/product` (per-product cost). It has
**no order-level rows and no commission fields**, so it cannot replace the
paid/organic split — but it could supply the delivery evidence the creative
diagnosis is blocked on. Not integrated; noted as the obvious next avenue.

---

## 8. What this does NOT claim

No real campaign performance has been proven. These are synthetic workflow
tests: they demonstrate that the software behaves correctly, not that its advice
makes money. **An operator-run intervention on a live campaign is still needed**
before anyone should trust the recommendations, and the runbook beside this
document describes that first cycle.

Nothing here has been deployed to production by this work. Migrations 028–037
are applied to the database; the front end changes are committed and awaiting an
explicit deploy.
