import { useEffect, useState } from 'react';
import { supabase } from './lib/supabase.js';
import LoginPage from './pages/LoginPage.jsx';
import Shell from './pages/Shell.jsx';

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

  return <Shell session={session} profile={profile} />;
}
