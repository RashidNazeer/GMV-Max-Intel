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
import { reportWindow, modelWindow } from './window.js';

export const RANGES = [7, 14, 30, 60, 90];

/** How much history the spend-response model may train on, ending at the report cutoff. */
export const TRAINING_DAYS = 120;

export function useScope() {
  const [params, setParams] = useSearchParams();

  const days = Number(params.get('days')) || 30;
  const shopId = params.get('shop') || null;

  // reportWindow is THE date utility. N inclusive days ending where the data
  // has settled — not N+1, which is what the shell used to produce.
  const win = useMemo(() => reportWindow(days), [days]);
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
      next.delete('page');
      return next;
    });
  }, [setParams]);

  return { shopId, days, setShop, setDays, ...win, model };
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

/** Keep the global scope when moving between routes. */
export function scopedTo(path, params) {
  const keep = new URLSearchParams();
  for (const k of ['shop', 'days']) {
    const v = params.get(k);
    if (v) keep.set(k, v);
  }
  const qs = keep.toString();
  return qs ? `${path}?${qs}` : path;
}
