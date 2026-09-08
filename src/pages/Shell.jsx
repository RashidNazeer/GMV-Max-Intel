// App shell: shop, reporting window, navigation, data status.
//
// ── WHAT CHANGED ───────────────────────────────────────────────────────────
// The old shell rendered every shop as a large card in a row that grew with the
// brand list, and repeated connection warnings across every screen. It also
// computed the window as `days + SETTLING_DAYS` back to `SETTLING_DAYS` back,
// which is days+1 inclusive dates — so "Last 7 days" was eight.
//
// Now: one compact shop selector, one date control, one data-status pill, and
// the window comes from reportWindow() which is the only place that arithmetic
// exists.
import { useMemo, useState } from 'react';
import { Outlet, NavLink, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase.js';
import { shopSummary, syncRuns, shopReconciliation, shopPaidRoas, money } from '../lib/api.js';
import { useScope, RANGES, scopedTo } from '../lib/scope.js';
import { Skeleton, Note, Empty } from '../components/ui.jsx';

const TABS = [
  { to: '/overview',    label: 'Overview' },
  { to: '/campaigns',   label: 'Campaigns' },
  { to: '/creatives',   label: 'Creatives' },
  { to: '/products',    label: 'Products' },
  { to: '/organic',     label: 'Organic' },
  { to: '/attribution', label: 'Attribution' },
];

export default function Shell({ session, profile }) {
  const scope = useScope();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();

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

  const tabs = useMemo(
    () => (profile?.role === 'boss'
      ? [...TABS, { to: '/outreach', label: 'Outreach' }]
      : TABS),
    [profile?.role],
  );

  return (
    <>
      <div className="topbar">
        <div className="brand">GMV Intelligence <span>what your ads actually drove</span></div>

        <nav className="nav" style={{ marginLeft: 18 }}>
          {tabs.map((t) => (
            <NavLink key={t.to} to={scopedTo(t.to, params)}
              className={({ isActive }) => (isActive ? 'active' : undefined)}>
              {t.label}
            </NavLink>
          ))}
        </nav>

        <div className="spacer" />

        <ShopSelect shops={shops} active={active} onPick={scope.setShop} loading={summaryQ.isLoading} />

        <DateControl scope={scope} shop={shop} />

        <DataStatusPill shop={shop} scope={scope} onOpen={() => navigate(scopedTo('/data', params))} />

        <span className="muted" style={{ fontSize: 12.5 }}>
          {profile?.display_name || session.user.email}
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
            Your account has no shop access yet. Ask the Boss to grant it — this is a permission,
            not a data problem, so nothing here will change until it is granted.
          </Empty>
        )}

        {/* Remounting on shop change is what stops the previous shop's chart
            sitting under the new shop's header while the queries settle. */}
        {shop && (
          <div key={`${shop.id}-${location.pathname}`}>
            <Outlet context={{ shop, scope, profile, shops }} />
          </div>
        )}
      </div>
    </>
  );
}

/**
 * ONE date control: presets, a custom range, the exact dates, the comparison
 * period, and the timezone the days are cut in.
 *
 * All five matter and all five were missing. The exact dates because "Last 30
 * days" ending two days ago is not what anyone pictures; the comparison period
 * because every trend on the app is measured against it and it was never
 * stated; the timezone because Reacher cuts its days in Los Angeles, not UTC,
 * so a "day" here is not the day a reader assumes.
 */
function DateControl({ scope, shop }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(scope.start);
  const [to, setTo] = useState(scope.end);

  const apply = () => {
    if (from && to && from <= to) { scope.setCustom(from, to); setOpen(false); }
  };

  return (
    <div className="datectl">
      <select className="input" value={scope.custom ? 'custom' : scope.days}
        aria-label="Reporting window"
        onChange={(e) => {
          if (e.target.value === 'custom') { setOpen(true); return; }
          scope.setDays(Number(e.target.value));
        }}>
        {RANGES.map((d) => <option key={d} value={d}>Last {d} days</option>)}
        <option value="custom">{scope.custom ? 'Custom range' : 'Custom range…'}</option>
      </select>

      <button className="windowbtn" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        title="Exact dates, comparison period and reporting timezone">
        {scope.start} → {scope.end}
        <span style={{ opacity: .7 }}> · {scope.spanDays}d</span>
      </button>

      {open && (
        <div className="datepop">
          <div className="k">Custom range</div>
          <div className="daterow">
            <label>
              <span>From</span>
              <input className="input" type="date" value={from} max={to}
                onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label>
              <span>To</span>
              <input className="input" type="date" value={to} min={from}
                onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn btn-primary" onClick={apply} disabled={!(from && to && from <= to)}>Apply</button>
            {scope.custom && (
              <button className="btn" onClick={() => { scope.setCustom(null, null); setOpen(false); }}>
                Back to presets
              </button>
            )}
          </div>

          <div className="datefacts">
            <div><span>Reporting</span><b>{scope.start} → {scope.end}</b><i>{scope.spanDays} days</i></div>
            <div><span>Compared against</span><b>{scope.priorStart} → {scope.priorEnd}</b><i>{scope.priorSpanDays} days, adjacent</i></div>
            <div><span>Model trains on</span><b>{scope.model.start} → {scope.model.end}</b><i>{scope.model.spanDays} days</i></div>
            <div>
              <span>Days cut in</span>
              <b>{shop?.reporting_timezone || 'America/Los_Angeles'}</b>
              <i>the source&rsquo;s own reporting day, not UTC</i>
            </div>
            {!scope.custom && (
              <div>
                <span>Ends</span>
                <b>{scope.settlingDays} days back</b>
                <i>affiliate orders keep arriving for about that long</i>
              </div>
            )}
            {scope.custom && (
              <div>
                <span>Settlement</span>
                <b>not applied</b>
                <i>a custom range is used exactly as entered — recent days may still be filling in</i>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One selector that scales past three brands. Connection state lives in here
 * rather than as a banner repeated on every screen.
 */
function ShopSelect({ shops, active, onPick, loading }) {
  if (loading) return <div className="skel" style={{ width: 150, height: 32 }} />;
  if (!shops.length) return null;
  return (
    <select className="input" value={active?.shop_id || ''} aria-label="Shop"
      onChange={(e) => onPick(e.target.value)} style={{ maxWidth: 210 }}>
      {shops.map((s) => (
        <option key={s.shop_id} value={s.shop_id}>
          {s.shop_name}
          {Number(s.lines) ? ` — ${money(s.gmv, s.currency)}` : ' — no data'}
        </option>
      ))}
    </select>
  );
}

/**
 * Health, in one control, opening the detail rather than reproducing it.
 *
 * Source type and health are DIFFERENT things and are shown as different
 * things: a measured source can still be incomplete, and a simulated one can
 * still be internally consistent.
 */
function DataStatusPill({ shop, scope, onOpen }) {
  const runsQ = useQuery({
    queryKey: ['runs', shop?.id],
    queryFn: () => syncRuns(shop.id, 8),
    enabled: !!shop?.id,
  });
  const reconQ = useQuery({
    queryKey: ['recon', shop?.id, scope.start, scope.end],
    queryFn: () => shopReconciliation(shop.id, scope.start, scope.end),
    enabled: !!shop?.id,
  });
  const roasQ = useQuery({
    queryKey: ['roaspill', shop?.id, scope.start, scope.end],
    queryFn: () => shopPaidRoas(shop.id, scope.start, scope.end),
    enabled: !!shop?.id,
  });

  if (!shop) return null;

  const failed = (runsQ.data || []).filter((r) => r.status === 'error');
  const recon = reconQ.data;
  const simulated = roasQ.data?.is_simulated === true;

  let tone = 'ok';
  let label = 'Healthy';
  if (recon?.status === 'exception') { tone = 'bad'; label = 'Action required'; }
  else if (failed.length) { tone = 'warn'; label = 'Limited data'; }

  return (
    <button className={`statuspill statuspill-${tone}`} onClick={onOpen}
      title="Open data status — coverage, last sync, reconciliation">
      <span className="dot" />
      {label}
      {simulated && <span className="basis basis-simulated" style={{ marginLeft: 6 }}>demo</span>}
    </button>
  );
}
