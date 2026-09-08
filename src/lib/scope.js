// ============================================================
// Scope: the shop and the reporting window, held in the URL.
//
// These used to be useState in the shell, which meant a link to a campaign was
// a link to whatever shop the recipient happened to have selected, Back did
// nothing, and returning from a detail view lost the filters you arrived with.
//
// GLOBAL scope (shop, days) lives in the query string on every route. LOCAL
// filters (search, status, sort, page) also live there but are owned by the
// view that uses them, and are dropped when that view is left — a creative
// status filter has no meaning on the products table, and carrying it silently
// is how a filtered count gets read as a total.
// ============================================================
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { reportWindow, modelWindow, addDays, daysBetween } from './window.js';

export const RANGES = [7, 14, 30, 60, 90];

/** How much history the spend-response model may train on, ending at the report cutoff. */
export const TRAINING_DAYS = 120;

export function useScope() {
  const [params, setParams] = useSearchParams();

  const days = Number(params.get('days')) || 30;
  const shopId = params.get('shop') || null;
  // A custom range, when the presets do not answer the question. Both dates
  // must be present and ordered, or it falls back to the preset rather than
  // rendering a window nobody asked for.
  const from = params.get('from');
  const to = params.get('to');
  const custom = !!(from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to);

  // reportWindow is THE date utility. N inclusive days ending where the data
  // has settled — not N+1, which is what the shell used to produce.
  const win = useMemo(() => {
    if (!custom) return reportWindow(days);
    const n = daysBetween(from, to);
    const priorEnd = addDays(from, -1);
    return {
      days: n, start: from, end: to,
      priorStart: addDays(priorEnd, -(n - 1)), priorEnd,
      settlingDays: 0, spanDays: n, priorSpanDays: n, custom: true,
    };
  }, [custom, from, to, days]);

  const model = useMemo(() => modelWindow(win.end, { trainingDays: TRAINING_DAYS }), [win.end]);

  const setShop = useCallback((id) => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set('shop', id);
      // Local filters belong to the shop they were made against.
      for (const k of ['q', 'status', 'page']) next.delete(k);
      return next;
    });
  }, [setParams]);

  const setDays = useCallback((d) => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set('days', String(d));
      // A preset replaces a custom range rather than sitting behind it — two
      // date states at once is how a screen ends up showing neither.
      next.delete('from'); next.delete('to');
      next.delete('page');
      return next;
    });
  }, [setParams]);

  const setCustom = useCallback((f, t) => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (f && t) { next.set('from', f); next.set('to', t); }
      else { next.delete('from'); next.delete('to'); }
      next.delete('page');
      return next;
    });
  }, [setParams]);

  return { shopId, days, setShop, setDays, setCustom, custom, ...win, model };
}

/** Local, view-owned filter state. Kept in the URL so a drill-down is shareable. */
export function useLocalParams(defaults = {}) {
  const [params, setParams] = useSearchParams();

  const get = useCallback((key) => params.get(key) ?? defaults[key] ?? null, [params, defaults]);

  const set = useCallback((patch) => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === '' || v === defaults[k]) next.delete(k);
        else next.set(k, String(v));
      }
      // Any filter change invalidates the page number: staying on page 4 of a
      // result set that now has two pages shows an empty table and no reason.
      if (!('page' in patch)) next.delete('page');
      return next;
    }, { replace: true });
  }, [setParams, defaults]);

  const clear = useCallback(() => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      for (const k of Object.keys(defaults)) next.delete(k);
      next.delete('ids');
      next.delete('page');
      return next;
    });
  }, [setParams, defaults]);

  return { get, set, clear, params };
}

/**
 * Keep the global scope when moving between routes.
 *
 * A custom range is part of the global scope, so it travels too — otherwise a
 * link from a custom window would silently reopen on the default preset, and
 * every number on the destination would be for different dates.
 */
export function scopedTo(path, params) {
  const keep = new URLSearchParams();
  for (const k of ['shop', 'days', 'from', 'to']) {
    const v = params.get(k);
    if (v) keep.set(k, v);
  }
  const qs = keep.toString();
  return qs ? `${path}?${qs}` : path;
}
