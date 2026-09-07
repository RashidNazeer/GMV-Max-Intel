// Prove no secret reached the browser bundle.
//
// The spec is explicit (§46): Reacher credentials are server-only and must
// never appear in client requests or logs. A comment saying so is not evidence;
// this greps the built output for the actual secret values and fails loudly.
// Run after every build, and in CI once there is one.
import fs from 'node:fs';
import path from 'node:path';
import { env } from './_env.mjs';

const DIST = 'dist';
if (!fs.existsSync(DIST)) { console.error('no dist/ — run `npm run build` first'); process.exit(1); }

// Every value in this project's own env that is NOT meant for the browser must
// be absent from the build. Deriving the list from the env file rather than
// hard-coding names means a secret added later is covered automatically — the
// default is "this is secret", which is the safe direction to be wrong in.
//
// PUBLIC_IDS are the deliberate exceptions: identifiers, not credentials.
// The Supabase project ref is a substring of VITE_SUPABASE_URL, so it is in the
// bundle by definition and flagging it would train us to ignore the audit.
// Anything added here needs a reason written next to it.
const PUBLIC_IDS = new Set([
  'GMV_INTEL_PROJECT_REF',  // appears inside https://<ref>.supabase.co — public by construction
  'GMV_INTEL_ORG_ID',       // Supabase org identifier, grants nothing on its own
]);

const forbidden = Object.entries(env)
  .filter(([k, v]) => !k.startsWith('VITE_') && !PUBLIC_IDS.has(k) && v && String(v).length >= 12);

// The anon key SHOULD be present — it is public by design and the app needs it.
const expected = [['VITE_SUPABASE_ANON_KEY', env.VITE_SUPABASE_ANON_KEY]].filter(([, v]) => v);

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
})(DIST);

let leaked = 0;
console.log(`scanning ${files.length} built file(s)\n`);

for (const [name, value] of forbidden) {
  const hits = files.filter((f) => fs.readFileSync(f, 'utf8').includes(value));
  if (hits.length) {
    leaked++;
    console.log(`  LEAK   ${name} found in: ${hits.join(', ')}`);
  } else {
    console.log(`  clean  ${name} absent from the bundle`);
  }
}

for (const [name, value] of expected) {
  const present = files.some((f) => fs.readFileSync(f, 'utf8').includes(value));
  console.log(`  ${present ? 'ok    ' : 'MISSING'} ${name} ${present ? 'present (public by design)' : '— the app cannot reach Supabase'}`);
  if (!present) leaked++;
}

// Also catch a secret that was never in an env file: anything shaped like a
// Reacher key or a JWT carrying the service_role claim.
for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8');
  if (/\brk_[A-Za-z0-9_-]{20,}/.test(txt)) { console.log(`  LEAK   a Reacher-shaped key (rk_...) appears in ${f}`); leaked++; }
  if (/"role"\s*:\s*"service_role"/.test(txt)) { console.log(`  LEAK   a service_role JWT payload appears in ${f}`); leaked++; }
}

console.log(leaked ? `\nFAILED — ${leaked} problem(s)` : '\nPASS — no secret reached the browser bundle');
process.exit(leaked ? 1 : 0);
