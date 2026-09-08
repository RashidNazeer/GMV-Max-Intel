// The application shell: 56px header, 208px sidebar, full-width workspace.
//
// ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
// A horizontal tab bar that could not fit its own contents at 1366 (brand,
// seven tabs, shop, dates, status, user and sign-out come to roughly 1450px),
// so it wrapped to two rows — and to three when forced not to. Navigation that
// changes height depending on viewport width is navigation you cannot lay a
// page out against.
//
// A sidebar also gives primary and secondary navigation different weight
// without hiding either, and it collapses to a rail rather than disappearing.
import { useState } from 'react';
import { Outlet, NavLink, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase.js';
import { shopSummary, syncRuns, shopReconciliation, shopPaidRoas, money } from '../lib/api.js';
import { useScope, RANGES, scopedTo } from '../lib/scope.js';
import { Skeleton, Notice, EmptyState } from '../components/ui.jsx';

const I = {
  overview: 'M3 12h4l2 6 4-14 2 8h6',
  campaigns: 'M4 19V9m5 10V5m5 14v-7m5 7V8',
  creatives: 'M2 5h20v14H2zM10 9l5 3-5 3z',
  products: 'M3 6h18v14H3zM3 6l2-3h14l2 3M9 11h6',
  organic: 'M12 21c5-3 8-7 8-12a8 8 0 0 0-16 0c0 5 3 9 8 12zM12 3v18',
  attribution: 'M21 21H3V3M7 15l4-5 3 3 5-7',
  outreach: 'M4 5h16v12H8l-4 4z',
  data: 'M12 3c4 0 8 1 8 3v12c0 2-4 3-8 3s-8-1-8-3V6c0-2 4-3 8-3zM4 10c0 2 4 3 8 3s8-1 8-3',
};

const Icon = ({ d }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const PRIMARY = [
  { to: '/overview',  label: 'Overview',  icon: I.overview },
  { to: '/campaigns', label: 'Campaigns', icon: I.campaigns },
  { to: '/creatives', label: 'Creatives', icon: I.creatives },
  { to: '/products',  label: 'Products',  icon: I.products },
];

const SECONDARY = [
  { to: '/organic',     label: 'Organic',     icon: I.organic },
  { to: '/attribution', label: 'Attribution', icon: I.attribution },
];

export default function Shell({ session, profile }) {
  const scope = useScope();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);

  const summaryQ = useQuery({
    queryKey: ['summary', scope.start, scope.end],
    queryFn: () => shopSummary(scope.start, scope.end),
  });

  const shops = summaryQ.data || [];
  const active = shops.find((s) => s.shop_id === scope.shopId)
    || shops.find((s) => Number(s.lines) > 0)
    || shops[0];

  const shop = active && {
    id: active.shop_id,
    shop_name: active.shop_name,
    currency: active.currency,
    affiliate_connected: active.affiliate_connected,
    reporting_timezone: active.reporting_timezone,
  };

  const secondary = profile?.role === 'boss'
    ? [...SECONDARY, { to: '/outreach', label: 'Outreach', icon: I.outreach }]
    : SECONDARY;

  const link = (t) => (
    <NavLink key={t.to} to={scopedTo(t.to, params)} onClick={() => setNavOpen(false)}
      className={({ isActive }) => `navlink${isActive ? ' active' : ''}`}>
      <Icon d={t.icon} />
      <span className="navlabel">{t.label}</span>
    </NavLink>
  );

  return (
    <div className="shell">
      <header className="appheader">
        <button className="btn btn-quiet btn-sm menubtn" onClick={() => setNavOpen((v) => !v)}
          aria-label="Menu" aria-expanded={navOpen}
          style={{ display: 'none' }}>☰</button>
        <div className="wordmark">WURX <span>GMV Intelligence</span></div>
        <div className="spacer" />
        <ShopSelect shops={shops} active={active} onPick={scope.setShop} loading={summaryQ.isLoading} />
        <AccountMenu profile={profile} session={session} />
      </header>

      <nav className={`sidebar${navOpen ? ' open' : ''}`} aria-label="Sections">
        {PRIMARY.map(link)}
        <div className="navgroup">More</div>
        {secondary.map(link)}
        <div className="sidebar-foot">
          <DataStatusLink shop={shop} scope={scope}
            onOpen={() => { setNavOpen(false); navigate(scopedTo('/data', params)); }} />
        </div>
      </nav>

      <main className="main">
        {summaryQ.isLoading && (
          <>
            <Skeleton h={32} w={220} />
            <Skeleton h={88} />
            <Skeleton h={280} />
          </>
        )}

        {summaryQ.error && (
          <Notice tone="error">Could not load shops: {summaryQ.error.message}</Notice>
        )}

        {!summaryQ.isLoading && !shops.length && (
          <section className="panel">
            <EmptyState title="No shops are visible to your account">
              Your account has no shop access yet. Ask the Boss to grant it — this is a permission,
              not a data problem, so nothing here will change until it is granted.
            </EmptyState>
          </section>
        )}

        {/* Remounting on shop change is what stops the previous shop's chart
            sitting under the new shop's header while the queries settle. */}
        {shop && (
          <div key={`${shop.id}-${location.pathname}`} className="stack">
            <Outlet context={{ shop, scope, profile, shops }} />
          </div>
        )}
      </main>
    </div>
  );
}

function ShopSelect({ shops, active, onPick, loading }) {
  if (loading) return <div className="skel" style={{ width: 200, height: 36 }} />;
  if (!shops.length) return null;
  return (
    <select className="input" value={active?.shop_id || ''} aria-label="Shop"
      onChange={(e) => onPick(e.target.value)} style={{ maxWidth: 230, fontWeight: 500 }}>
      {shops.map((s) => (
        <option key={s.shop_id} value={s.shop_id}>
          {s.shop_name}{Number(s.lines) ? ` — ${money(s.gmv, s.currency)}` : ' — no data'}
        </option>
      ))}
    </select>
  );
}

/** Account controls belong in a quiet menu, not a large button in the toolbar. */
function AccountMenu({ profile, session }) {
  const [open, setOpen] = useState(false);
  const name = profile?.display_name || session.user.email;
  const initial = String(name).trim().charAt(0).toUpperCase() || '?';
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn btn-quiet" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        aria-label={`Account: ${name}`}
        style={{ width: 32, height: 32, padding: 0, borderRadius: '50%', background: 'var(--accent-quiet)', color: 'var(--accent-text)', fontWeight: 700 }}>
        {initial}
      </button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 45 }} onClick={() => setOpen(false)} />
          <div className="panel" style={{
            position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 46,
            minWidth: 220, padding: 8, boxShadow: 'var(--shadow-pop)',
          }}>
            <div style={{ padding: '6px 10px 10px', borderBottom: '1px solid var(--divider)' }}>
              <div className="truncate" style={{ fontWeight: 600 }}>{name}</div>
              {profile?.role && <div className="meta">{profile.role}</div>}
            </div>
            <button className="btn btn-quiet" style={{ width: '100%', justifyContent: 'flex-start', marginTop: 6 }}
              onClick={() => supabase.auth.signOut()}>Sign out</button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Data status sits in the utility area at the foot of the sidebar and carries
 * the current health. Source type and health are different claims: a measured
 * source can still be incomplete, and a demo one can be internally consistent.
 */
function DataStatusLink({ shop, scope, onOpen }) {
  const runsQ = useQuery({
    queryKey: ['runs', shop?.id], queryFn: () => syncRuns(shop.id, 8), enabled: !!shop?.id,
  });
  const reconQ = useQuery({
    queryKey: ['recon', shop?.id, scope.start, scope.end],
    queryFn: () => shopReconciliation(shop.id, scope.start, scope.end), enabled: !!shop?.id,
  });
  const roasQ = useQuery({
    queryKey: ['roaspill', shop?.id, scope.start, scope.end],
    queryFn: () => shopPaidRoas(shop.id, scope.start, scope.end), enabled: !!shop?.id,
  });
  if (!shop) return null;

  const failed = (runsQ.data || []).filter((r) => r.status === 'error');
  const recon = reconQ.data;
  const tone = recon?.status === 'exception' ? 'bad' : failed.length ? 'warn' : 'ok';
  const label = recon?.status === 'exception' ? 'Action required'
    : failed.length ? 'Limited data' : 'Healthy';

  return (
    <button className="navlink" onClick={onOpen} style={{ width: '100%', background: 'none', border: 0, textAlign: 'left' }}
      title={`Data status — ${label}`}>
      <Icon d={I.data} />
      <span className="navlabel" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span className="truncate">Data status</span>
        <span className={`status status-${tone}`} style={{ padding: '0 6px', fontSize: 11 }} />
        {roasQ.data?.is_simulated && <span className="sourcetag sourcetag-simulated">demo</span>}
      </span>
    </button>
  );
}
