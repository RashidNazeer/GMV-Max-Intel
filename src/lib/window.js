// ============================================================
// THE date utility. One implementation, used by every screen and every model.
//
// ── THE BUG THIS REPLACES ──────────────────────────────────────────────────
// The shell computed
//     end   = isoDaysAgo(SETTLING_DAYS)
//     start = isoDaysAgo(days + SETTLING_DAYS)
// which spans days+1 inclusive dates. "Last 7 days" rendered 8 shop days and
// "Last 30 days" rendered 31 — verified live on 2026-09-08:
//     Last 7  -> 2026-08-30 .. 2026-09-06  = 8 days
//     Last 30 -> 2026-08-07 .. 2026-09-06  = 31 days
// Every figure on every screen was computed over one day more than its label
// claimed, the model was trained on one extra day, and "Last 90 days" asked
// the provider for 91 — past a documented 90-day cap.
//
// N inclusive calendar days ending on `end` start at `end - (N - 1)`. That is
// the whole rule, and it is written once.
//
// ── WHY DATE STRINGS, NOT Date OBJECTS ─────────────────────────────────────
// All arithmetic happens on YYYY-MM-DD strings through UTC, so a daylight-
// saving transition cannot move a boundary. The shop's reporting timezone is
// applied in SQL (shop_window), where the rows actually live — doing it twice,
// in two languages, is how the two disagree.
// ============================================================

// Affiliate orders keep arriving for about two days. Measured 2026-09-07 by
// reconciling the same window at increasing ages against Seller Center:
//
//   window ending          Cutler   Biostime
//   today                   75.9%     95.9%
//   2 days back             78.5%     98.6%
//   5 days back             78.5%     96.9%
//
// Capture stops improving after two days. This is SETTLEMENT, and it is a
// separate concept from window length: it decides where a window ENDS, never
// how long it is. Conflating them is what produced the off-by-one above.
export const SETTLING_DAYS = 2;

const DAY = 86400000;

/** Parse YYYY-MM-DD as a UTC timestamp. Rejects anything else loudly. */
export function parseISO(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error(`not an ISO date: ${iso}`);
  }
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`not a real date: ${iso}`);
  return t;
}

export const toISO = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Shift an ISO date by whole days. Month and year boundaries fall out of UTC. */
export const addDays = (iso, n) => toISO(parseISO(iso) + n * DAY);

/** Inclusive day count between two ISO dates. */
export const daysBetween = (start, end) => Math.round((parseISO(end) - parseISO(start)) / DAY) + 1;

export const todayISO = (now = new Date()) => new Date(now).toISOString().slice(0, 10);

/**
 * The report window: exactly `days` inclusive calendar days, ending where the
 * data has settled — plus the adjacent, equal-length, non-overlapping period
 * before it, which is what any "vs previous" comparison must use.
 */
export function reportWindow(days, { settlingDays = SETTLING_DAYS, now = new Date() } = {}) {
  const n = Math.max(1, Math.round(Number(days) || 1));
  const end = addDays(todayISO(now), -settlingDays);
  const start = addDays(end, -(n - 1));
  const priorEnd = addDays(start, -1);
  const priorStart = addDays(priorEnd, -(n - 1));
  return {
    days: n,
    start,
    end,
    priorStart,
    priorEnd,
    settlingDays,
    // What the label promises, proven rather than asserted.
    spanDays: daysBetween(start, end),
    priorSpanDays: daysBetween(priorStart, priorEnd),
  };
}

/**
 * The MODEL window, deliberately separate from the report window.
 *
 * Selecting "Last 7 days" used to hand the spend-response model seven rows and
 * it then reported "keep collecting history" while twenty-two usable days sat
 * in the database. The report selector controls what is DISPLAYED; training
 * uses the eligible history ending at the same analysis cutoff.
 *
 * The cutoff is shared so a historical analysis cannot train on days after the
 * date it claims to be looking from.
 */
export function modelWindow(reportEnd, { trainingDays = 90 } = {}) {
  const end = reportEnd;
  const start = addDays(end, -(Math.max(1, trainingDays) - 1));
  return { start, end, trainingDays, spanDays: daysBetween(start, end) };
}

/**
 * Split a window into provider-sized chunks.
 *
 * Seller Center retains and serves at most 90 days, and the context sync asked
 * for 92 — so `shop_channels` failed for every shop, every run, with
 * "Date range exceeds maximum of 90 days". Chunking fixes a request that is
 * merely too long. It does NOT recover dates the provider no longer retains,
 * and nothing here pretends otherwise.
 */
export function chunkWindow(start, end, maxDays = 90) {
  const out = [];
  let s = start;
  while (parseISO(s) <= parseISO(end)) {
    const e = (() => {
      const candidate = addDays(s, maxDays - 1);
      return parseISO(candidate) > parseISO(end) ? end : candidate;
    })();
    out.push({ start: s, end: e, days: daysBetween(s, e) });
    s = addDays(e, 1);
  }
  return out;
}

/** Back-compat for callers that only ever wanted "N days before today". */
export const isoDaysAgo = (days, now = new Date()) => addDays(todayISO(now), -days);
export const isoSettledEnd = (now = new Date()) => addDays(todayISO(now), -SETTLING_DAYS);
