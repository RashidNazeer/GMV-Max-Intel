// Create a login for the pilot. Service-role only, run locally.
//   node scripts/create-user.mjs <email> [role]
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { need, setEnv, ENV_FILE } from './_env.mjs';

const [SUPABASE_URL, SERVICE_KEY] = need('VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');

const email = process.argv[2];
const role = process.argv[3] || 'boss';
if (!email) { console.error('usage: node scripts/create-user.mjs <email> [boss|ol|ads_manager]'); process.exit(1); }

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// Readable but strong. Written to this project's own .env.local, never printed.
const password = crypto.randomBytes(12).toString('base64url');

const { data, error } = await db.auth.admin.createUser({
  email, password, email_confirm: true,
  user_metadata: { display_name: email.split('@')[0] },
});

let userId = data?.user?.id;
if (error) {
  if (!/already/i.test(error.message)) { console.error('create failed:', error.message); process.exit(1); }
  const { data: list } = await db.auth.admin.listUsers();
  userId = list.users.find((u) => u.email === email)?.id;
  if (!userId) { console.error('user exists but could not be found'); process.exit(1); }
  await db.auth.admin.updateUserById(userId, { password });
  console.log('user already existed — password reset');
} else {
  console.log('user created');
}

// The signup trigger makes the profile; set the role with the service role,
// which bypasses the guard that stops users promoting themselves.
const { error: pErr } = await db.from('profiles')
  .upsert({ id: userId, email, display_name: email.split('@')[0], role, is_active: true }, { onConflict: 'id' });
if (pErr) { console.error('profile update failed:', pErr.message); process.exit(1); }

const tag = email === 'mrrashid3255@gmail.com'
  ? 'BOSS_LOGIN_PASSWORD'
  : `LOGIN_${email.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
setEnv(tag, password);

console.log(`role: ${role}`);
console.log(`password stored in ${ENV_FILE} as ${tag}`);
