// ============================================================
// Reacher Data API client — SERVER SIDE ONLY.
//
// This module must never be imported by browser code: it takes a raw API key,
// and Reacher's key is account-wide (it can read every shop on the account and
// its scopes include read_write). It belongs in an edge function or a script.
//
// Facts established by probing the live API on 2026-09-06 — none of these are
// in the vendor spec, which is why they are written down here:
//   base    https://api.reacherapp.com/public/v1
//   auth    x-api-key: rk_...   AND   x-shop-id: <id>   (both required)
//   limits  60/min, 3000/hour, returned in x-ratelimit-*
//   spec    GET /openapi.json on the same base — 271 endpoints, authoritative
// ============================================================

export const REACHER_BASE = 'https://api.reacherapp.com/public/v1';

// Reacher's own published ceiling is 60/min. Staying meaningfully under it means
// a backfill never trips a 429 in the first place, which matters more than raw
// speed for a nightly job.
const DEFAULT_MIN_INTERVAL_MS = 1100;

export class ReacherError extends Error {
  constructor(message, { status, path, requestId, body } = {}) {
    super(message);
    this.name = 'ReacherError';
    this.status = status;
    this.path = path;
    this.requestId = requestId;   // Reacher returns one on every error — quote it to support
    this.body = body;
  }
}

export function createReacherClient({
  apiKey,
  base = REACHER_BASE,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  maxRetries = 4,
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) throw new Error('createReacherClient: apiKey is required');
  let nextSlot = 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function throttle() {
    const now = Date.now();
    if (now < nextSlot) await sleep(nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + minIntervalMs;
  }

  async function request(method, path, { shopId, body, query } = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await throttle();
      let res, text;
      try {
        res = await fetchImpl(url, {
          method,
          headers: {
            'x-api-key': apiKey,
            ...(shopId != null ? { 'x-shop-id': String(shopId) } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        text = await res.text();
      } catch (e) {
        // Network-level failure. Worth retrying; Pakistani ISPs drop connections.
        lastErr = new ReacherError(`network error on ${path}: ${e.message}`, { path });
        if (attempt < maxRetries) { await sleep(500 * 2 ** attempt); continue; }
        throw lastErr;
      }

      if (res.status === 429 || res.status >= 500) {
        // Honour Retry-After when offered, else exponential backoff.
        const ra = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt;
        lastErr = new ReacherError(`HTTP ${res.status} on ${path}`, { status: res.status, path, body: text.slice(0, 300) });
        if (attempt < maxRetries) { await sleep(wait); continue; }
        throw lastErr;
      }

      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON handled below */ }

      if (!res.ok) {
        throw new ReacherError(
          json?.error?.message || `HTTP ${res.status} on ${path}`,
          { status: res.status, path, requestId: json?.error?.request_id, body: json ?? text.slice(0, 300) },
        );
      }
      if (json === null) throw new ReacherError(`non-JSON response from ${path}`, { status: res.status, path });
      return json;
    }
    throw lastErr;
  }

  return {
    request,
    get: (path, opts) => request('GET', path, opts),
    post: (path, opts) => request('POST', path, opts),

    listShops: () => request('GET', '/shops'),
    whoami: () => request('GET', '/whoami'),
    integrationsStatus: (shopId) => request('GET', '/integrations/status', { shopId }),

    /**
     * Every affiliate order line in a window, paginated to exhaustion.
     *
     * `total` comes back on the first page, so the loop is bounded by the
     * server's own count rather than by guessing when to stop. onPage lets a
     * caller stream pages into a database instead of holding the lot in memory
     * — a busy shop can run to tens of thousands of lines over 90 days.
     */
    async fetchAffiliateTransactions({ shopId, startDate, endDate, pageSize = 500, onPage, maxPages = 400 }) {
      const all = [];
      let offset = 0, total = null, pages = 0;
      do {
        const res = await request('POST', '/affiliate/transactions', {
          shopId,
          body: { start_date: startDate, end_date: endDate, limit: pageSize, offset },
        });
        const rows = res.transactions || [];
        total = res.total ?? rows.length;
        pages++;
        if (onPage) await onPage(rows, { offset, total, dataStatus: res.data_status });
        else all.push(...rows);
        offset += pageSize;
        if (!rows.length) break;                    // defensive: server said more but sent none
      } while (offset < total && pages < maxPages);

      return { transactions: all, total, pages, truncated: total !== null && offset < total };
    },

    shopGmvTimeseries: (shopId, startDate, endDate) =>
      request('POST', '/shop-gmv/timeseries', { shopId, body: { start_date: startDate, end_date: endDate } }),
    sellerCenterOverview: (shopId, startDate, endDate) =>
      request('POST', '/seller-center/shop-overview', { shopId, body: { start_date: startDate, end_date: endDate } }),

    // ── Layer 3: the video feed ───────────────────────────────────────────
    // page_size caps at 100 — a 200 is rejected with HTTP 422. A 30-day window
    // lists 33,257 videos for one shop, almost all with no sales, so this walks
    // the head of a GMV-sorted list rather than trying to enumerate everything.
    // min_gmv drops the long tail at the server rather than over the wire.
    async fetchTopVideos({ shopId, startDate, endDate, want = 500, minGmv = 1 }) {
      const out = [];
      const pageSize = 100;
      for (let page = 1; out.length < want; page++) {
        const res = await request('POST', '/videos/performance', {
          shopId,
          body: {
            start_date: startDate, end_date: endDate,
            page, page_size: pageSize,
            sort_by: 'video_gmv', sort_dir: 'desc', min_gmv: minGmv,
          },
        });
        const rows = res.data || [];
        out.push(...rows);
        if (rows.length < pageSize) break;
        if (page >= Math.ceil(want / pageSize)) break;
      }
      return out.slice(0, want);
    },

    // ── Layer 4: catalogue and the Seller Center funnel ───────────────────
    pnlProducts: (shopId) => request('GET', '/pnl/products', { shopId }),

    async fetchSellerCenterProducts({ shopId, startDate, endDate, want = 200 }) {
      const out = [];
      const pageSize = 50;
      for (let page = 1; out.length < want; page++) {
        const res = await request('POST', '/seller-center/products', {
          shopId,
          body: {
            start_date: startDate, end_date: endDate,
            page, page_size: pageSize, sort_by: 'gmv', sort_dir: 'desc',
          },
        });
        const rows = res.data || [];
        out.push(...rows);
        const total = res.pagination?.total_count ?? out.length;
        if (rows.length < pageSize || out.length >= total) break;
      }
      return out.slice(0, want);
    },

    // ── GMV Max. Never yet returned a campaign for our shops. ─────────────
    listGmvMaxCampaigns: (shopId) => request('GET', '/gmv-max/campaigns', { shopId }),
    campaignSettings: (shopId, campaignId) =>
      request('GET', `/gmv-max/campaigns/${encodeURIComponent(campaignId)}/settings`, { shopId }),
    campaignMetrics: (shopId, campaignId, startDate, endDate) =>
      request('GET', `/gmv-max/campaigns/${encodeURIComponent(campaignId)}/metrics`, {
        shopId, query: { start_date: startDate, end_date: endDate },
      }),
    campaignChanges: (shopId, campaignId) =>
      request('GET', `/gmv-max/campaigns/${encodeURIComponent(campaignId)}/changes`, {
        shopId, query: { page: 1, page_size: 100 },
      }),
    campaignSpendBySurface: (shopId, campaignId, startDate, endDate) =>
      request('GET', `/gmv-max/campaigns/${encodeURIComponent(campaignId)}/spend-by-surface`, {
        shopId, query: { start_date: startDate, end_date: endDate },
      }),
  };
}
