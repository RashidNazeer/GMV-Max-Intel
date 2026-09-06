import { createClient } from '@supabase/supabase-js';

// The browser only ever gets the ANON key. It is public by design; every row it
// can reach is decided by RLS on the server, not by anything in this bundle.
// The Reacher key and the service-role key are never imported here — they have
// no VITE_ prefix, so Vite cannot expose them even by mistake.
const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anon) {
  throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — copy .env.example to .env.local');
}

export const supabase = createClient(url, anon, {
  auth: { persistSession: true, autoRefreshToken: true },
});
