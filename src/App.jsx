import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { supabase } from './lib/supabase.js';
import LoginPage from './pages/LoginPage.jsx';
import Shell from './pages/Shell.jsx';
import OverviewPage from './pages/OverviewPage.jsx';
import CampaignsPage from './pages/CampaignsPage.jsx';
import CampaignDetailPage from './pages/CampaignDetailPage.jsx';
import CreativePage from './pages/CreativePage.jsx';
import ProductsPage from './pages/ProductsPage.jsx';
import ProductDetailPage from './pages/ProductDetailPage.jsx';
import OrganicPage from './pages/OrganicPage.jsx';
import AttributionPage from './pages/AttributionPage.jsx';
import DataStatusPage from './pages/DataStatusPage.jsx';
import OutreachPage from './pages/OutreachPage.jsx';

export default function App() {
  const [session, setSession] = useState(undefined);   // undefined = still checking
  const [profile, setProfile] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.user) { setProfile(null); return; }
    supabase.from('profiles').select('id, display_name, email, role, is_active')
      .eq('id', session.user.id).maybeSingle()
      .then(({ data }) => setProfile(data));
  }, [session?.user?.id]);

  if (session === undefined) {
    return <div className="center"><div className="muted">Loading…</div></div>;
  }
  if (!session) return <LoginPage />;

  // A profile row is created by a trigger on signup. If it is missing, the
  // account exists but has no role — say so rather than rendering an empty
  // dashboard that looks like "you have no data".
  if (profile && profile.is_active === false) {
    return (
      <div className="center">
        <div className="card pad login">
          <h2 style={{ marginTop: 0 }}>Account disabled</h2>
          <p className="muted">Ask the Boss to re-enable your access.</p>
          <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </div>
    );
  }

  // Real routes, not tab state. A campaign someone links to has to open on that
  // campaign, Back has to go back, and a filtered list has to survive a return
  // from detail — none of which useState can do.
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Shell session={session} profile={profile} />}>
          <Route index element={<Navigate to="/overview" replace />} />
          <Route path="overview" element={<OverviewPage />} />
          <Route path="campaigns" element={<CampaignsPage />} />
          <Route path="campaigns/:campaignId" element={<CampaignDetailPage />} />
          <Route path="creatives" element={<CreativePage />} />
          <Route path="products" element={<ProductsPage />} />
          <Route path="products/:productId" element={<ProductDetailPage />} />
          <Route path="organic" element={<OrganicPage />} />
          <Route path="attribution" element={<AttributionPage />} />
          <Route path="data" element={<DataStatusPage />} />
          {profile?.role === 'boss' && <Route path="outreach" element={<OutreachPage />} />}
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
