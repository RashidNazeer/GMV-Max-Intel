import { useState } from 'react';
import { supabase } from '../lib/supabase.js';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    // Deliberately not distinguishing "no such user" from "wrong password":
    // that difference tells an attacker which emails have accounts here.
    if (error) { setErr('That email and password did not match.'); setBusy(false); }
  }

  return (
    <div className="center">
      <form className="card pad login" onSubmit={submit}>
        <div className="brand" style={{ fontSize: 19 }}>GMV Intelligence</div>
        <p className="muted" style={{ marginTop: 6, fontSize: 13 }}>
          How much of your TikTok Shop revenue your ads actually drove.
        </p>

        <label className="k" style={{ display: 'block', marginTop: 20 }}>Email</label>
        <input className="input" style={{ width: '100%', marginTop: 6 }} type="email" autoComplete="email"
          value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />

        <label className="k" style={{ display: 'block', marginTop: 14 }}>Password</label>
        <input className="input" style={{ width: '100%', marginTop: 6 }} type="password" autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)} required />

        <button className="btn btn-primary" style={{ width: '100%', marginTop: 20 }} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {err && <div className="err">{err}</div>}
      </form>
    </div>
  );
}
