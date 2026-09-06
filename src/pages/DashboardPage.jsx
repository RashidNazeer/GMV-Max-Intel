import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { supabase } from '../lib/supabase.js';
import {
  shopSummary, shopDaily, topCreators, lastSync,
  money, moneyExact, pct, isoDaysAgo, isoToday,
} from '../lib/api.js';

const RANGES = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 60 days', days: 60 },
  { label: 'Last 90 days', days: 90 },
];

export default function DashboardPage({ session, profile }) {
  const [days, setDays] = useState(30);
  const [shopId, setShopId] = useState(null);

  const start = useMemo(() => isoDaysAgo(days), [days]);
  const end = useMemo(() => isoToday(), [days]);

  const summaryQ = useQuery({
    queryKey: ['summary', start, end],
    queryFn: () => shopSummary(start, end),
  });

  const shops = summaryQ.data || [];
  // Default to the shop with the most revenue rather than alphabetical — the
  // one worth looking at first.
  const active = shops.find((s) => s.shop_id === shopId)
    || shops.find((s) => Number(s.lines) > 0)
    || shops[0];

  return (
    <>
      <div className="topbar">
        <div className="brand">GMV Intelligence <span>paid vs organic</span></div>
        <div className="spacer" />
        <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {RANGES.map((r) => <option key={r.days} value={r.days}>{r.label}</option>)}
        </select>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {profile?.display_name || session.user.email}
          {profile?.role ? ` · ${profile.role}` : ''}
        </span>
        <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>

      <div className="wrap">
        {summaryQ.isLoading && <LoadingBlock />}
        {summaryQ.error && (
          <div className="note note-warn">Could not load: {summaryQ.error.message}</div>
        )}

        {!summaryQ.isLoading && !shops.length && (
          <div className="note note-info">
            No shops are visible to your account yet. Ask the Boss to grant you access.
          </div>
        )}

        {shops.length > 0 && (
          <>
            <ShopTabs shops={shops} activeId={active?.shop_id} onPick={setShopId} />
            {active && <ShopView shop={active} start={start} end={end} days={days} />}
          </>
        )}
      </div>
    </>
  );
}

function ShopTabs({ shops, activeId, onPick }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
      {shops.map((s) => {
        const on = s.shop_id === activeId;
        return (
          <button key={s.shop_id} className="btn" onClick={() => onPick(s.shop_id)}
            style={on ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)', color: 'var(--accent)' } : undefined}>
            {s.shop_name}
            <span className="muted" style={{ marginLeft: 8, fontWeight: 500 }}>
              {Number(s.lines) ? money(s.gmv, s.currency) : 'no data'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ShopView({ shop, start, end, days }) {
  const cur = shop.currency || 'USD';
  const hasData = Number(shop.lines) > 0;

  const dailyQ = useQuery({
    queryKey: ['daily', shop.shop_id, start, end],
    queryFn: () => shopDaily(shop.shop_id, start, end),
    enabled: hasData,
  });
  const creatorsQ = useQuery({
    queryKey: ['creators', shop.shop_id, start, end],
    queryFn: () => topCreators(shop.shop_id, start, end, 20),
    enabled: hasData,
  });
  const syncQ = useQuery({
    queryKey: ['sync', shop.shop_id],
    queryFn: () => lastSync(shop.shop_id),
  });

  if (!hasData) {
    return (
      <div className="card pad">
        <div className="k">No affiliate orders</div>
        <p className="muted" style={{ marginTop: 8 }}>
          {shop.shop_name} returned no order lines for this period.
          {syncQ.data?.status === 'error' && (
            <> The last sync failed: <strong>{syncQ.data.error}</strong></>
          )}
        </p>
      </div>
    );
  }

  const organicShare = shop.paid_share == null ? null : 1 - Number(shop.paid_share);
  const paidPctNum = shop.paid_share == null ? 0 : Number(shop.paid_share) * 100;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <DataQuality shop={shop} sync={syncQ.data} />

      {/* The headline. One sentence, the number that justifies the product. */}
      <div className="card pad">
        <div className="k">Where {shop.shop_name}&rsquo;s affiliate revenue came from</div>
        <div style={{ fontSize: 27, fontWeight: 750, letterSpacing: '-0.02em', margin: '10px 0 16px' }}>
          <span style={{ color: 'var(--organic)' }}>{pct(organicShare)}</span> of it would have happened
          without your ads
        </div>

        <div className="split">
          <div className="p" style={{ width: `${paidPctNum}%` }}>
            {paidPctNum >= 12 ? pct(shop.paid_share, 0) : ''}
          </div>
          <div className="o" style={{ width: `${100 - paidPctNum}%` }}>
            {100 - paidPctNum >= 12 ? pct(organicShare, 0) : ''}
          </div>
        </div>
        <div className="legend">
          <span><i className="dot" style={{ background: 'var(--paid)' }} />
            <strong>{moneyExact(shop.paid_gmv, cur)}</strong> ad-driven <span className="muted">(Shop Ads commission)</span></span>
          <span><i className="dot" style={{ background: 'var(--organic)' }} />
            <strong>{moneyExact(shop.organic_gmv, cur)}</strong> organic <span className="muted">(standard commission)</span></span>
        </div>
      </div>

      <div className="grid g4">
        <Stat k="Affiliate GMV" v={money(shop.gmv, cur)} sub={`${Number(shop.lines).toLocaleString()} order lines · last ${days} days`} />
        <Stat k="Ad-driven" v={money(shop.paid_gmv, cur)} sub={`${pct(shop.paid_share)} of classified revenue`} tone="paid" />
        <Stat k="Organic" v={money(shop.organic_gmv, cur)} sub={`${pct(organicShare)} of classified revenue`} tone="organic" />
        <Stat k="Classified" v={pct(shop.coverage, 0)}
          sub={`${Number(shop.settled_lines).toLocaleString()} lines settled, rest still estimated`} />
      </div>

      <TrendCard data={dailyQ.data} loading={dailyQ.isLoading} currency={cur} />
      <CreatorsCard rows={creatorsQ.data} loading={creatorsQ.isLoading} currency={cur} />
      <SpendPending />
    </div>
  );
}

function Stat({ k, v, sub, tone }) {
  const color = tone === 'paid' ? 'var(--paid)' : tone === 'organic' ? 'var(--organic)' : undefined;
  return (
    <div className="card pad">
      <div className="k">{k}</div>
      <div className="v" style={color ? { color } : undefined}>{v}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}

// Never let a number sit on screen without saying how trustworthy it is.
function DataQuality({ shop, sync }) {
  const notes = [];
  if (shop.affiliate_connected === false) {
    notes.push({
      tone: 'warn',
      text: `Reacher shows this shop's affiliate integration as disconnected. Historical orders still load, but new ones may not be arriving — figures here can be understated until it is reconnected.`,
    });
  }
  if (shop.coverage != null && Number(shop.coverage) < 0.95) {
    notes.push({
      tone: 'warn',
      text: `Only ${pct(shop.coverage)} of revenue could be classified. The split below describes that portion, not the whole.`,
    });
  }
  if (sync?.status === 'error') {
    notes.push({ tone: 'warn', text: `Last sync failed: ${sync.error}` });
  }
  if (!notes.length) return null;
  return (
    <div className="grid" style={{ gap: 10 }}>
      {notes.map((n, i) => <div key={i} className="note note-warn">{n.text}</div>)}
    </div>
  );
}

function TrendCard({ data, loading, currency }) {
  const rows = (data || []).map((d) => ({
    day: String(d.day).slice(5),
    Paid: Number(d.paid_gmv) || 0,
    Organic: Number(d.organic_gmv) || 0,
  }));
  return (
    <div className="card pad">
      <div className="k">Daily split</div>
      <div className="sub" style={{ marginBottom: 10 }}>Revenue by what drove it</div>
      {loading ? <div className="skel" style={{ height: 240 }} /> : (
        <div style={{ height: 260 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={rows} margin={{ top: 6, right: 8, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} minTickGap={18} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false}
                tickFormatter={(v) => money(v, currency)} width={62} />
              <Tooltip
                formatter={(v, n) => [moneyExact(v, currency), n]}
                contentStyle={{ background: 'var(--surface-1)', border: '1px solid var(--border-default)', borderRadius: 10, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="Organic" stackId="1" stroke="var(--organic)" fill="var(--organic)" fillOpacity={0.28} />
              <Area type="monotone" dataKey="Paid" stackId="1" stroke="var(--paid)" fill="var(--paid)" fillOpacity={0.28} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function CreatorsCard({ rows, loading, currency }) {
  return (
    <div className="card">
      <div className="pad" style={{ paddingBottom: 4 }}>
        <div className="k">Top creators</div>
        <div className="sub">Who drove revenue — and whether your ads paid for it</div>
      </div>
      {loading ? <div className="pad"><div className="skel" style={{ height: 160 }} /></div> : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Creator</th>
                <th className="num">Lines</th>
                <th className="num">GMV</th>
                <th className="num">Ad-driven</th>
                <th className="num">Organic</th>
                <th className="num">Ad share</th>
              </tr>
            </thead>
            <tbody>
              {(rows || []).map((r) => (
                <tr key={r.creator_handle}>
                  <td>@{r.creator_handle}</td>
                  <td className="num muted">{r.lines}</td>
                  <td className="num"><strong>{moneyExact(r.gmv, currency)}</strong></td>
                  <td className="num" style={{ color: 'var(--paid)' }}>{moneyExact(r.paid_gmv, currency)}</td>
                  <td className="num" style={{ color: 'var(--organic)' }}>{moneyExact(r.organic_gmv, currency)}</td>
                  <td className="num">
                    <span className={`pill ${Number(r.paid_share) > 0.66 ? 'pill-warn' : 'pill-ok'}`}>
                      {pct(r.paid_share, 0)}
                    </span>
                  </td>
                </tr>
              ))}
              {!rows?.length && <tr><td colSpan={6} className="muted" style={{ padding: 18 }}>No creators in this period.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Honest about the ceiling. The doc's headline features need ad spend, and
// showing a blank "ROAS" card would imply we had tried and got zero.
function SpendPending() {
  return (
    <div className="note note-info">
      <div>
        <strong>Return on ad spend is not shown yet.</strong>
        <div style={{ marginTop: 4 }}>
          This page can say what <em>share</em> of revenue your ads drove, but not what it
          returned per dollar — that needs GMV Max spend, and Reacher has no campaigns cached
          for these shops. Connect the ad account in Reacher and spend, Paid ROAS and the
          recommendation engine all become possible.
        </div>
      </div>
    </div>
  );
}

function LoadingBlock() {
  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card pad"><div className="skel" style={{ height: 90 }} /></div>
      <div className="grid g4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="card pad"><div className="skel" style={{ height: 54 }} /></div>)}
      </div>
    </div>
  );
}
