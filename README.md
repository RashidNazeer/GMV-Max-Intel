# GMV Max Intelligence

Standalone pilot. Works out how much of a TikTok Shop's revenue the ads actually
drove — and, just as importantly, how much of it nobody can currently tell.

WurxOS is not touched by this project. It is built on the same stack and the
same conventions so it can be folded back in later if it proves out.

---

## Why this exists

GMV Max reports `ROI = revenue / spend`. Some of that revenue would have
happened anyway — creators posting for standard commission, search traffic,
shop-tab browsers. This tool answers *how much*, and refuses to guess where it
cannot answer.

The evidence is exact rather than modelled: TikTok pays each affiliate order
through one of two commission programmes, and which one it paid says what drove
the sale.

| commission on the order | what it means |
|---|---|
| **Shop Ads** | the order came through paid ad delivery |
| **Standard** | the creator posted organically for their own rate |

Measured on live data (31 days to 2026-09-07):

| shop | total shop GMV | we can attribute | of that, ad-driven | affiliate capture |
|---|---|---|---|---|
| Cutler Nutrition | $217,956 | **28.8%** | 42.2% | **76.6%** ⚠ |
| Biostime | $13,984 | **68.7%** | 44.1% | 96.5% |

That middle column is the number an earlier version of this README did not
have, and it changes the story. Cutler's paid/organic split is real, but it
describes under a third of the business — and a quarter of even that slice is
missing order lines, because the shop's affiliate integration reads
disconnected.

---

## What it does

Six layers, in the spec's own order. Four are built.

| # | Layer | State |
|---|---|---|
| 1 | **Paid vs organic** from commission evidence | **built** — 100% classification coverage, zero ambiguous rows |
| 2 | **Whole-shop channel decomposition** | **built** — six buckets summing to total GMV, to the cent |
| 3 | **Creative health** — concentration, fatigue, freshness | **built** |
| 4 | **Commerce context** — funnel, refunds, price, stock | **built** (discount depth unavailable at source) |
| 5 | Marginal ROAS — "if I spend 20% more, what do I get?" | deferred: needs ~30 days of real, *varying* spend |
| 6 | **Recommendation engine** | **built** — 8 rules + an all-clear, 46 unit tests |

### The decomposition

Every dollar of shop GMV lands in exactly one of six buckets:

```
ad-driven (measured)        Shop Ads commission — certainly caused by ads
organic (measured)          standard commission — certainly not
affiliate, no line data     Seller Center reports it; no order line reached us
seller video ┐
LIVE         ├─ no commission signal exists, so they are NOT split by a proxy
product card ┘
```

The grey three are left whole on purpose. Applying the affiliate paid rate to
them would be a guess wearing the clothes of a measurement — and the data says
it would be wrong: Showcase, Livestream and External Traffic orders measured
**0% paid** across $3,491.

### Return on spend is a band, not a number

GMV Max buys affiliate video, product card and brand. Only the affiliate surface
leaves commission evidence. So the honest output is two numbers and the distance
between them:

- **floor** — verified ad-driven revenue ÷ total spend. Every dollar proven.
- **ceiling** — GMV Max's own reported ROI. Everything it is willing to claim.

The gap is *either* real ad-driven revenue on unmeasurable surfaces *or* organic
being counted as paid. Nothing available today separates the two, and the app
says so rather than picking one. Reacher exposes spend by surface but not
**revenue** by surface — that single addition would close the band.

---

## Layout

```
src/lib/reacher/
  classify.js    the paid/organic rule. Pure, no imports, 25 unit tests.
  client.js      Reacher HTTP client. SERVER ONLY — never import in the browser.
  normalize.js   Reacher field names stop here (the adapter boundary).
src/lib/
  recommend.js   the decision layer. Pure rules, 21 unit tests. No LLM decides anything.
src/pages/       Overview · Creative · Products · Campaigns
supabase/migrations/
  001 foundation      profiles / shops / access, RLS, role helpers
  002 affiliate facts the order-line fact table + daily rollup
  003 summaries       window totals, aggregated in SQL not the client
  004 channel facts   whole-shop decomposition (layer 2)
  005 creative        video performance + concentration/fatigue (layer 3)
  006 products        catalogue + Seller Center funnel (layer 4)
  007 gmv max         spend, campaign memory, the simulated-data fence
  008 roas bounds     return on spend as a proven floor to a claimed ceiling
```

## Running it

```bash
npm test                 # 46 unit tests — no network, no credentials
npm run sync             # affiliate order lines
npm run sync:context     # channels, videos, products (layers 2-4)
npm run preview          # print what every screen will say, from real data
npm run demo:spend       # SIMULATED GMV Max spend, until the ad account exists
npm run demo:purge       # remove every simulated row
npm run check:attribution  # proves the six buckets sum to total shop GMV
npm run check:rls          # proves the access rules hold, signed in and out
npm run audit:bundle       # proves no secret reached the browser build
```

**Configuration comes from this project's own `.env.local` and nothing else.**
No script reaches outside this folder for a credential — `scripts/_env.mjs` is
the single loader. Copy `.env.example` to `.env.local` to set it up.

### About the simulated spend

The ad account has never been connected in Reacher, so there is no real spend to
read. `npm run demo:spend` writes invented spend so the decision layers can be
demonstrated. It is fenced three ways:

1. Every row carries `data_source = 'simulated'`.
2. **A database trigger refuses to let a shop hold simulated and measured rows
   at once** — a half-real ROAS is the one failure that would produce a
   confident, plausible, wrong number.
3. Every reporting function returns `data_source`, so the UI cannot render a
   figure without also being handed the fact that it was invented. The banner is
   not dismissible.

The revenue is real throughout. Only the spend, and GMV Max's reported figure,
are generated — and they are generated to reproduce the exact phenomenon the
product exists to bound. It shows the mechanism; it does not predict the number.

---

## Reacher API facts

Established by probing the live API on 2026-09-06 and 2026-09-07. None of this
was in the vendor spec, which is why it is written down.

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
  commission"` on every one of 2,866 live rows. Use the commission *amounts*.
- **`actual` is empty on unsettled orders**, so most of any recent window is
  `ESTIMATED` basis. Normal, not a fault — but recent numbers are provisional.
- **Zero is not the same as null.** A `0` commission says that programme paid
  nothing; a `null` says we do not know. In JavaScript this bites twice, because
  `Number(null)` is `0` — every figure that can be absent needs an explicit
  guard or the screen prints a confident `0.00`.
- **Structurally organic channels really are.** Showcase, Livestream and
  External Traffic measured **0% paid**. Never apply a blended paid share there.
- **Affiliate GMV is not shop GMV.** Cutler's affiliate GMV is ~30% of the shop.
  Seller Center is the reconciliation base, not GMV Max.
- **A reconciliation gap is an alarm, not noise.** Biostime reconciled to within
  0.4%; Cutler was 18% short — and Cutler is the one reading disconnected.
- **`/videos/performance` caps `page_size` at 100** (a 200 returns HTTP 422) and
  lists 33,257 videos for one shop in 30 days, nearly all with no sales. The
  sync walks the head of a GMV-sorted list. It is a head, not a census.
- **PostgREST caps a select at 1,000 rows.** Every total is computed in SQL.

## Not yet possible

| what | why | what would unblock it |
|---|---|---|
| **Marginal ROAS**, Target ROI recommendations | needs ~30 days where spend genuinely varied | real spend, then time |
| **Discount depth** | `discount_pct` null on 61/61 products, `original_price` null on 105/105 SKUs | Reacher populating the price fields |
| **Closing the ROAS band** | Reacher exposes spend by surface, not revenue by surface | one endpoint |
| **Splitting product card into shop-tab vs search** | the daily series returns both as null | — |

The first of those is the only one that is a matter of time rather than a
missing field. It will say *"insufficient historical variation"* until the
history supports it, which is the correct answer and not a bug.
