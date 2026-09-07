// App shell: shop selection, date range, navigation.
//
// Shop and range live here rather than inside each page, so switching tabs
// keeps the context you were looking at. The window matters more than usual on
// this product — most figures are window-scoped, and a page that silently reset
// the range would quietly change every number on it.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase.js';
import { shopSummary, syncRuns, money, isoDaysAgo, isoSettledEnd, SETTLING_DAYS } from '../lib/api.js';
import OverviewPage from './OverviewPage.jsx';
import CreativePage from './CreativePage.jsx';
import ProductsPage from './ProductsPage.jsx';
import CampaignsPage from './CampaignsPage.jsx';
import { Note, Skeleton, Empty } from '../components/ui.jsx';

const RANGES = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 14 days', days: 14 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 60 days', days: 60 },
  { label: 'Last 90 days', days: 90 },
];

const TABS = [
  { id: 'overview',  label: 'Overview',  Page: OverviewPage },
  { id: 'creative',  label: 'Creative',  Page: CreativePage },
  { id: 'products',  label: 'Products',  Page: ProductsPage },
  { id: 'campaigns', label: 'Campaigns', Page: CampaignsPage },
];

export default function Shell({ session, profile }) {
  const [days, setDays] = useState(30);
  const [shopId, setShopId] = useState(null);
  const [tab, setTab] = useState('overview');

  // Windows end where the data has settled, not today — see SETTLING_DAYS.
  const end = useMemo(() => isoSettledEnd(), []);
  const start = useMemo(() => isoDaysAgo(days + SETTLING_DAYS), [days]);

  const summaryQ = useQuery({
    queryKey: ['summary', start, end],
    queryFn: () => shopSummary(start, end),
  });

  const shops = summaryQ.data || [];
  // Default to the shop worth looking at first, not the alphabetical one.
  const active = shops.find((s) => s.shop_id === shopId)
    || shops.find((s) => Number(s.lines) > 0)
    || shops[0];

  const Page = TABS.find((t) => t.id === tab)?.Page ?? OverviewPage;

  const shopForPage = active && {
    id: active.shop_id,
    shop_name: active.shop_name,
    currency: active.currency,
    affiliate_connected: active.affiliate_connected,
  };

  return (
    <>
      <div className="topbar">
        <div className="brand">GMV Intelligence <span>what your ads actually drove</span></div>
        <nav className="nav" style={{ marginLeft: 18 }}>
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}
          aria-label="Date range">
          {RANGES.map((r) => <option key={r.days} value={r.days}>{r.label}</option>)}
        </select>
        {/* Spell out the actual dates. "Last 30 days" ending two days ago is not
            what most people picture, and a window that is not stated is a window
            that gets misread. */}
        <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}
          title={`Affiliate orders keep arriving for about ${SETTLING_DAYS} days, so the window stops where the data has settled. Including today would show a collapse on the last day, every day.`}>
          {start} → {end} <span style={{ opacity: .75 }}>· last {SETTLING_DAYS}d still settling</span>
        </span>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {profile?.display_name || session.user.email}{profile?.role ? ` · ${profile.role}` : ''}
        </span>
        <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>

      <div className="wrap">
        {summaryQ.isLoading && (
          <div className="grid" style={{ gap: 16 }}>
            <div className="card pad"><Skeleton h={90} /></div>
            <div className="grid g4">{[0, 1, 2, 3].map((i) => <div key={i} className="card pad"><Skeleton h={54} /></div>)}</div>
          </div>
        )}

        {summaryQ.error && <Note tone="warn">Could not load shops: {summaryQ.error.message}</Note>}

        {!summaryQ.isLoading && !shops.length && (
          <Empty title="No shops are visible to your account">
            Ask the Boss to grant you access, or run <code>npm run sync</code> if this is a fresh database.
          </Empty>
        )}

        {shops.length > 0 && (
          <>
            <div className="shoptabs">
              {shops.map((s) => (
                <button key={s.shop_id} className="shoptab"
                  aria-pressed={s.shop_id === active?.shop_id}
                  onClick={() => setShopId(s.shop_id)}>
                  <div className="nm">{s.shop_name}</div>
                  <div className="mt">
                    {Number(s.lines) ? `${money(s.gmv, s.currency)} affiliate` : 'no data'}
                    {s.affiliate_connected === false ? ' · disconnected' : ''}
                  </div>
                </button>
              ))}
            </div>

            {shopForPage && (
              <Page key={`${tab}-${shopForPage.id}`} shop={shopForPage} start={start} end={end} days={days} onOpenTab={setTab} />
            )}

            <SyncFooter shopId={shopForPage?.id} />
          </>
        )}
      </div>
    </>
  );
}

// Where the numbers came from and when — quietly, at the bottom, but present.
// A dashboard that cannot say when it last loaded data invites people to trust
// a stale screen.
function SyncFooter({ shopId }) {
  const q = useQuery({
    queryKey: ['runs', shopId],
    queryFn: () => syncRuns(shopId, 6),
    enabled: !!shopId,
  });
  if (!q.data?.length) return null;

  const failed = q.data.filter((r) => r.status === 'error');
  const newest = q.data[0];

  return (
    <div style={{ marginTop: 26, fontSize: 11.5 }} className="muted">
      Last sync {new Date(newest.started_at).toLocaleString()} ·{' '}
      {q.data.map((r) => `${r.job} ${r.status === 'ok' ? `${r.rows_written}` : r.status}`).join(' · ')}
      {failed.length > 0 && (
        <div style={{ color: 'var(--warning)', marginTop: 4 }}>
          {failed.length} sync job{failed.length > 1 ? 's' : ''} failed: {failed.map((f) => `${f.job} — ${f.error}`).join('; ')}
        </div>
      )}
    </div>
  );
}
