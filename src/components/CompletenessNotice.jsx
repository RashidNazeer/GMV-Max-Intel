// "Spend available through Sep 5; report ends Sep 7."
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// Data status called GMV Max campaigns "Healthy" while its coverage ended two
// days before the selected report, and a red dot in the sidebar was carrying
// the entire explanation for a consequential recommendation. A healthy job and
// a complete report are different facts.
//
// It appears ONLY when incomplete inputs actually affect what is on screen —
// an unrelated source failing must not put a banner on every page — and it
// links to the source detail rather than reproducing it.
import { Link } from 'react-router-dom';
import { Notice } from './ui.jsx';
import { scopedTo } from '../lib/scope.js';

/** Sources whose gaps change the numbers a given page is showing. */
const AFFECTS = {
  overview: ['gmv_max', 'shop_channels', 'affiliate_transactions'],
  attribution: ['shop_channels', 'affiliate_transactions'],
  creatives: ['affiliate_transactions'],
  products: ['product_metrics'],
  organic: ['affiliate_transactions', 'shop_channels'],
  campaign: ['gmv_max'],
};

const SHORT = {
  gmv_max: 'Spend',
  shop_channels: 'Shop revenue',
  affiliate_transactions: 'Affiliate orders',
  product_metrics: 'Product funnel',
};

export default function CompletenessNotice({ sources, page = 'overview', scope, params }) {
  if (!sources?.length) return null;
  const relevant = AFFECTS[page] || [];

  // Only what is both RELEVANT to this page and genuinely short of the window.
  const gaps = sources.filter((s) => relevant.includes(s.source)
    && (s.state === 'stale' || s.state === 'incomplete') && s.coverage_end);
  const failing = sources.filter((s) => relevant.includes(s.source) && s.state === 'failing');

  if (!gaps.length && !failing.length) return null;

  return (
    <Notice tone="warn">
      {gaps.length > 0 && (
        <>
          {gaps.map((s, i) => (
            <span key={s.source}>
              {i > 0 && '; '}
              {SHORT[s.source] || s.label} available through <strong>{s.coverage_end}</strong>
            </span>
          ))}
          {'; report ends '}<strong>{scope.end}</strong>{'. '}
        </>
      )}
      {failing.length > 0 && (
        <>
          The latest {failing.map((s) => (SHORT[s.source] || s.label).toLowerCase()).join(' and ')} sync
          failed. Records already stored are unaffected and still shown
          {failing.every((s) => s.has_stored_data) ? '' : ', where any exist'}.{' '}
        </>
      )}
      <Link to={scopedTo('/data', params)}>View data status</Link>
    </Notice>
  );
}
