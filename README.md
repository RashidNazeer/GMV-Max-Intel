# GMV Max Intelligence

Standalone pilot. Separates **paid** from **organic** TikTok Shop revenue using
Reacher's affiliate data, so a media buyer can see whether a GMV Max campaign's
headline ROI is real or is being carried by organic demand.

WurxOS is not touched by this project. It is built on the same stack and the
same conventions so it can be folded back in later if it proves out.

---

## Why this exists

GMV Max reports `ROI = revenue / spend`. Some of that revenue would have
happened anyway — creators posting for standard commission, search traffic,
shop-tab browsers. This tool answers *how much*.

The evidence is exact rather than modelled: TikTok pays each affiliate order
through one of two commission programmes, and which one it paid says what drove
the sale.

| commission on the order | what it means |
|---|---|
| **Shop Ads** | the order came through paid ad delivery |
| **Standard** | the creator posted organically for their own rate |

Measured on live data (30 days to 2026-09-05):

| shop | affiliate GMV | paid | organic | coverage |
|---|---|---|---|---|
| Cutler Nutrition | $66,139 | 39.8% | **60.2%** | 100% |
| Biostime | $9,981 | 43.6% | **56.4%** | 100% |

---

## Layout

```
src/lib/reacher/
  classify.js    the paid/organic rule. Pure, no imports, 25 unit tests.
  client.js      Reacher HTTP client. SERVER ONLY — never import in the browser.
  normalize.js   Reacher field names stop here (the adapter boundary).
supabase/migrations/
  001_foundation.sql     profiles / shops / access, RLS, role helpers
  002_affiliate_facts.sql the order-line fact table + daily rollup view
scripts/
  classify-tests.mjs  unit tests, no framework      npm test
  verify-live.mjs     live end-to-end + reconciliation against Seller Center
  key-check.mjs       proves the natural key holds on real data
```

## Running it

```bash
npm test                       # 25 unit tests, no network, no credentials
npm run verify:live            # hits the live API, reconciles against Seller Center
```

`verify:live` reads `REACHER_API` from `C:/Users/RA_shid/.wurx/cli-secrets.env`
(override with `REACHER_KEYFILE`). **The key is never stored in this repo.**

---

## Reacher API facts

Established by probing the live API on 2026-09-06. None of this was in the
vendor spec, which is why it is written down.

| | |
|---|---|
| base | `https://api.reacherapp.com/public/v1` |
| auth | `x-api-key` **and** `x-shop-id` — both required |
| limits | 60/min, 3000/hour |
| **spec** | **`GET /openapi.json` on that base — 271 endpoints, authoritative** |

Prefer the published OpenAPI document over any written description, including
the vendor's own build spec, which listed most endpoints as guesses.

### Shops on our key

| reacher id | name | region | affiliate integration |
|---|---|---|---|
| 11515 | Cutler Nutrition | US / USD | **disconnected** |
| 11528 | Biostime | US / USD | connected |
| 11527 | Longevity | UK / GBP | connected, but no seller ID on file — **no data can exist** |

---

## Things that will bite

- **`commission_model` is useless for attribution.** It reads `"fixed
  commission"` on every one of 2,866 live rows. It describes the rate
  structure, not the programme. Use the commission *amounts*.
- **`actual` is empty on unsettled orders.** Most of any recent window is
  therefore `ESTIMATED` basis — 1,543 of 2,238 lines for Cutler. That is normal,
  not a fault, but recent numbers are provisional and the UI must say so.
- **Zero is not the same as null.** A `0` commission says that programme paid
  nothing; a `null` says we do not know. Collapsing them turns unknown rows into
  confident ones.
- **Structurally organic channels really are.** Showcase, Livestream and
  External Traffic Program measured **0% paid** across thousands of dollars.
  Never apply a blended paid-share estimate to them.
- **Affiliate GMV is not shop GMV.** Cutler's affiliate GMV is ~30% of total
  shop GMV. Seller Center is the reconciliation base, not GMV Max.
- **A reconciliation gap is a data-quality alarm, not noise.** Same code, same
  window: Biostime reconciled to Seller Center within **0.4%**, Cutler was
  **18.3%** short — and Cutler is the one whose affiliate integration reads
  disconnected. Do not paper over the gap; surface it.

## Not yet possible

GMV Max **spend** is unavailable: `GET /gmv-max/campaigns` returns zero for all
three shops. The module itself is healthy (templates and settings endpoints
respond), so this is Reacher's campaign cache never having been synced for our
shops — an open question with their team.

Until it is resolved this tool can report what **share** of revenue is paid, but
not **return on spend**. Paid ROAS, marginal ROAS and the recommendation engine
all wait on that one input.
